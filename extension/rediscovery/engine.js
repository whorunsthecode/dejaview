/**
 * Proactive rediscovery.
 *
 * Lands on a page that signals active work, infers what it is about, and looks
 * for something read long enough ago to have been forgotten. If nothing clears
 * the bar it says nothing at all, which is the common case by design.
 *
 * The order of the checks matters and is not an optimisation:
 *
 *   enabled? -> a trigger page? -> allowed to speak? -> cooled down?
 *   -> only then peek at the page
 *
 * The page's content is read last, so a peek only ever happens when a nudge
 * could actually result from it. Being rate-limited means the page is never
 * looked at.
 *
 * Nothing here calls a model or the network. Matching is lexical and local.
 */
import { MSG, send as sharedSend } from "../../shared/messages.js";
import { historyUrl } from "../../shared/history.js";
import { detectTrigger } from "./triggers.js";
import { topicFrom } from "./topic.js";
import { rankCandidates, bestNudge, explain } from "./rank.js";
import { rateCheck, shouldEvaluate, acceptStats } from "./budget.js";
import { bestPassage, fragmentUrl } from "./passage.js";
import { DwellTracker, surpriseWeights, pickWeighted } from "./dwell.js";
import { RediscoveryStore, WEIGHT_LESS, WEIGHT_DISMISS } from "./store.js";
import { loadSettings } from "./settings.js";

/** Blue, matching the panel's "plan" accent. */
const BADGE_COLOR = "#4a6cf7";

const DAY = 86_400_000;

/** A day, written the way a person would say it. */
function readableDate(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/** Roughly how long ago, for the one-line summary. */
export function agePhrase(firstVisit, now) {
  if (!Number.isFinite(firstVisit)) return "undated";
  const days = Math.floor((now - firstVisit) / DAY);
  if (days < 45) return days + " days ago";
  const months = Math.round(days / 30);
  if (months < 18) return months + " months ago";
  return Math.round(days / 365) + " years ago";
}

export class Rediscovery {
  constructor({
    api = globalThis.chrome,
    store = new RediscoveryStore(),
    index,
    cache,
    historySource = null,
    peek = async () => null,
    send = sharedSend,
    now = () => Date.now(),
    random = Math.random,
    settings = () => loadSettings(api)
  } = {}) {
    Object.assign(this, { api, store, index, cache, historySource, peek, send, now, random, settings });
    this.tracker = new DwellTracker({
      api,
      now,
      onSession: (session) => {
        this.remember(session).catch(() => {});
      }
    });
    this.listeners = [];
    this.working = Promise.resolve();
  }

  /**
   * Register the navigation listeners. Called at worker startup, synchronously,
   * because MV3 drops listeners added after the first turn of the event loop.
   */
  start() {
    const listen = (event, handler) => {
      if (!event?.addListener) return;
      event.addListener(handler);
      this.listeners.push(() => event.removeListener(handler));
    };

    listen(this.api.tabs?.onUpdated, (_id, changes, tab) => {
      // A full page load reports status. Notion, Linear and Jira are single-page
      // apps: moving between two tickets reports a new URL and no status at all,
      // and watching only for "complete" would miss every one of them.
      const navigated = changes?.status === "complete" || typeof changes?.url === "string";
      if (!navigated) return;
      if (tab?.status && tab.status !== "complete") return;
      this.queue(() => this.consider(tab));
    });

    this.tracker.start();
    return this;
  }

  /**
   * Store a finished dwell session — but only while the feature is on. The
   * tracker follows focus either way, because its listeners have to be
   * registered at startup and the setting can change after that; this is where
   * "off" actually means nothing is written down.
   */
  async remember(session) {
    const settings = await this.settings();
    if (!settings.REDISCOVERY_ENABLED) return null;
    return this.store.recordDwell(session);
  }

  /** One evaluation at a time; a burst of tab loads must not fan out. */
  queue(task) {
    this.working = this.working.then(task).catch(() => {});
    return this.working;
  }

  dispose() {
    this.tracker.dispose();
    for (const remove of this.listeners) remove();
    this.listeners = [];
  }

  // ---- the automatic path ---------------------------------------------

  /**
   * Decide whether this page deserves a nudge, and fire one if so.
   * Always resolves with a reason, which is what the tests assert on.
   */
  async consider(tab) {
    if (!tab || tab.incognito || !Number.isInteger(tab.id)) return { fired: false, reason: "not a page" };

    // The trigger test is pure string matching on the URL the listener already
    // handed us — no storage, no page access — so it goes first and keeps the
    // settings read off the path of every page load in the browser.
    const trigger = detectTrigger(tab.url ?? "", tab.title ?? "");
    if (!trigger) return { fired: false, reason: "not a working page" };

    const settings = await this.settings();
    if (!settings.REDISCOVERY_ENABLED) return { fired: false, reason: "rediscovery is off" };

    const budget = rateCheck(await this.store.entries(), this.now());
    if (!budget.ok) return { fired: false, reason: budget.reason };

    const state = await this.store.state();
    if (!shouldEvaluate(state.lastEvaluatedAt, this.now())) return { fired: false, reason: "still cooling down" };

    // Past this line the page's content is read. Nothing above it looked at
    // anything but the tab's own title and URL.
    await this.store.setState({ lastEvaluatedAt: this.now() });

    let peek = null;
    try {
      peek = await this.peek(tab.id);
    } catch {
      peek = null;
    }

    const topic = topicFrom({ title: tab.title, url: tab.url, trigger, peek });
    if (topic.terms.length < 2) return { fired: false, reason: "nothing specific to go on" };

    const candidates = await this.candidates(topic, settings);
    const ranked = rankCandidates({
      topic,
      candidates,
      now: this.now(),
      minAgeDays: settings.REDISCOVERY_MIN_AGE_DAYS,
      threshold: settings.REDISCOVERY_THRESHOLD,
      suppressed: await this.store.suppressed(),
      shown: await this.store.shownKeys(),
      triggerUrl: tab.url
    });

    const best = bestNudge(ranked);
    if (!best) {
      return { fired: false, reason: "nothing cleared the bar", considered: ranked.length };
    }

    const nudge = await this.compose({
      entry: best,
      trigger: { kind: trigger.kind, label: trigger.label, title: tab.title ?? "", url: tab.url ?? "" },
      why: explain(best.shared, trigger.label),
      manual: false
    });

    await this.deliver(nudge);
    return { fired: true, reason: "ok", nudge };
  }

  /**
   * The pool to rank against: open tabs always, browsing history only when the
   * user has turned that on.
   */
  async candidates(topic, settings) {
    const pool = [];

    try {
      for (const tab of await this.index.list()) {
        pool.push({
          url: tab.url,
          title: tab.title,
          groupTitle: tab.groupTitle,
          firstVisit: tab.firstVisit,
          lastVisit: tab.lastAccessed,
          tabId: tab.id,
          source: "tab"
        });
      }
    } catch {
      // An index that will not load leaves history as the only pool.
    }

    if (settings.REDISCOVERY_HISTORY && this.historySource) {
      try {
        const found = await this.historySource.search({
          query: topic.terms.join(" "),
          mode: "tight",
          limit: 100
        });
        for (const item of found) {
          pool.push({
            url: item.url,
            title: item.title,
            groupTitle: null,
            firstVisit: item.firstVisit,
            lastVisit: item.lastVisit,
            tabId: null,
            source: "history"
          });
        }
      } catch {
        // History unavailable is not a failure of the feature.
      }
    }

    return pool;
  }

  /** Turn a ranked entry into the thing the panel renders. */
  async compose({ entry, trigger, why, manual }) {
    const candidate = entry.candidate;
    const passage = await this.passageFor(candidate.url, entry.shared);

    return {
      id: globalThis.crypto?.randomUUID?.() ?? String(this.now()) + Math.random().toString(36).slice(2),
      at: this.now(),
      manual,
      trigger,
      item: {
        key: entry.key,
        url: candidate.url,
        title: candidate.title || candidate.url,
        firstVisit: Number.isFinite(candidate.firstVisit) ? candidate.firstVisit : null,
        lastVisit: Number.isFinite(candidate.lastVisit) ? candidate.lastVisit : null,
        source: candidate.source ?? "tab",
        tabId: Number.isInteger(candidate.tabId) ? candidate.tabId : null
      },
      firstReadOn: readableDate(candidate.firstVisit),
      age: agePhrase(candidate.firstVisit, this.now()),
      confidence: Number(entry.confidence.toFixed(3)),
      terms: entry.shared,
      why,
      // Only present when a passage was actually found in text already extracted.
      link: fragmentUrl(candidate.url, passage),
      passage,
      response: "shown"
    };
  }

  /**
   * A passage to land on, from text that was already extracted for this page.
   * Nothing is read here: if the page was never read, the link is just the page.
   */
  async passageFor(url, terms) {
    try {
      const text = await this.cache?.textFor?.(url);
      return bestPassage(text, terms);
    } catch {
      return null;
    }
  }

  /** Log it, badge the icon, and tell the panel — in that order. */
  async deliver(nudge) {
    await this.store.record(nudge);
    await this.store.setState({ pending: nudge });
    await this.badge(true);
    this.send(MSG.NUDGE, { nudge });
    return nudge;
  }

  async badge(on) {
    try {
      await this.api.action?.setBadgeText?.({ text: on ? "1" : "" });
      if (on) await this.api.action?.setBadgeBackgroundColor?.({ color: BADGE_COLOR });
    } catch {
      // A badge that will not draw is not worth failing a nudge over.
    }
  }

  // ---- the manual path -------------------------------------------------

  /**
   * "Surprise me": one thing at random, weighted toward pages you spent real
   * time on and have not been back to. No threshold and no rate limit — the
   * user asked for this one.
   */
  async surprise() {
    const settings = await this.settings();
    const pool = (await this.candidates({ terms: [] }, settings)).filter(
      (item) => Number.isFinite(item.firstVisit) && historyUrl(item.url)
    );
    if (!pool.length) {
      return { fired: false, reason: "nothing dated to surface yet" };
    }

    const weighted = surpriseWeights(pool, {
      dwell: await this.store.dwell(),
      now: this.now(),
      shown: await this.store.shownKeys()
    });
    const pick = pickWeighted(weighted, this.random);
    if (!pick) return { fired: false, reason: "nothing to surface" };

    const dwell = (await this.store.dwell()).get(pick.key);
    const minutes = Math.round((dwell?.ms ?? 0) / 60000);
    const why = minutes >= 1
      ? "You spent about " + minutes + " minute" + (minutes === 1 ? "" : "s") + " here and have not been back."
      : "Picked at random from what you have read and not returned to.";

    const nudge = await this.compose({
      entry: { key: pick.key, candidate: pick.item, shared: [], confidence: 0 },
      trigger: { kind: "manual", label: "your own request", title: "", url: "" },
      why,
      manual: true
    });

    await this.deliver(nudge);
    return { fired: true, reason: "ok", nudge };
  }

  // ---- answering -------------------------------------------------------

  /**
   * What the user did about a nudge.
   *
   * A dismissal is feedback too, just weaker than saying so outright: three
   * shrugs at a theme weigh about the same as one "less like this".
   */
  async respond(id, action) {
    const entries = await this.store.entries();
    const entry = entries.find((e) => e.id === id) ?? null;
    if (!entry) return { ok: false, error: "no such nudge" };

    if (action === "open") {
      await this.open(entry);
    } else if (action === "dismiss") {
      await this.store.suppress(entry.terms ?? [], WEIGHT_DISMISS);
    } else if (action === "less") {
      await this.store.suppress(entry.terms ?? [], WEIGHT_LESS);
    } else {
      return { ok: false, error: "unknown action" };
    }

    const updated = await this.store.respond(id, action === "open" ? "opened" : action === "less" ? "less" : "dismissed");
    const state = await this.store.state();
    if (state.pending?.id === id) {
      await this.store.setState({ pending: null });
      await this.badge(false);
    }
    return { ok: true, entry: updated };
  }

  /**
   * Open the item at its passage.
   *
   * An existing tab is navigated rather than duplicated. The fragment needs a
   * navigation to take effect, so the tab does reload; landing in the right
   * place is worth more than the scroll position of a tab you had forgotten.
   */
  async open(entry) {
    const url = entry.link || entry.item.url;
    try {
      if (Number.isInteger(entry.item.tabId)) {
        const tab = await this.api.tabs.get(entry.item.tabId);
        if (tab && historyUrl(tab.url) === entry.item.key) {
          await this.api.tabs.update(tab.id, { url, active: true });
          await this.api.windows?.update?.(tab.windowId, { focused: true });
          return;
        }
      }
    } catch {
      // The tab is gone; fall through and open a fresh one.
    }
    await this.api.tabs.create({ url, active: true });
  }

  // ---- what settings shows ---------------------------------------------

  async status() {
    const entries = await this.store.entries();
    const state = await this.store.state();
    return {
      ok: true,
      pending: state.pending ?? null,
      stats: acceptStats(entries),
      recent: entries.slice(0, 20),
      settings: await this.settings(),
      warning: this.store.warning ?? null
    };
  }

  /** Forget every nudge and every suppression weight. Dwell is kept. */
  async clearLog() {
    await this.store.clearLog();
    await this.badge(false);
    return { ok: true };
  }
}
