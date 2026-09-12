/**
 * How long you actually stayed.
 *
 * "Surprise me" is weighted toward things you spent real time on and have not
 * been back to, which needs a measure Chrome does not provide. Dwell is
 * accumulated here from focus changes: the foreground tab in the focused
 * window, and nothing else.
 *
 * Two deliberate distortions, both of which make the number more honest:
 *   - a single session is capped, so a tab left open over a long lunch does not
 *     out-weigh an hour of real reading.
 *   - very short sessions are dropped, so tabbing past a page on the way
 *     somewhere else does not register as having read it.
 *
 * An MV3 worker can be killed mid-session, and the open session is then lost.
 * That undercounts; it never invents time.
 */
import { historyUrl } from "../../shared/history.js";

export const MAX_SESSION_MS = 15 * 60 * 1000;
export const MIN_SESSION_MS = 5_000;

/** Beyond this many pages, the least-dwelt are dropped on write. */
export const MAX_DWELL_ROWS = 500;

const DAY = 86_400_000;

/** A focus session's contribution, clamped at both ends. 0 means "do not record". */
export function sessionMs(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const elapsed = to - from;
  if (elapsed < MIN_SESSION_MS) return 0;
  return Math.min(elapsed, MAX_SESSION_MS);
}

/** Fold a session into a stored row. */
export function mergeDwell(row, { ms, at, title }) {
  return {
    key: row?.key,
    url: row?.url,
    title: title || row?.title || "",
    ms: (row?.ms ?? 0) + Math.max(0, ms),
    sessions: (row?.sessions ?? 0) + 1,
    lastAt: Math.max(row?.lastAt ?? 0, at ?? 0)
  };
}

/** Keep the pages worth keeping when the table is full. */
export function pruneDwell(rows, max = MAX_DWELL_ROWS) {
  if (rows.length <= max) return { keep: rows, drop: [] };
  const sorted = [...rows].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
  return { keep: sorted.slice(0, max), drop: sorted.slice(max) };
}

/**
 * Weight every candidate for the random pick.
 *
 * High dwell raises a page's odds; a recent visit sinks them, because the
 * point is what you have forgotten, not what you are already reading. Nothing
 * is ever weighted to zero — a page with no dwell record at all is simply a
 * long shot rather than disqualified.
 *
 * @param {object[]} items          candidates carrying url, firstVisit, lastVisit
 * @param {object} opts
 * @param {Map<string, {ms: number}>} opts.dwell   keyed by canonical url
 * @param {Set<string>} [opts.shown]               keys already surfaced
 * @returns {{item: object, key: string, weight: number}[]}
 */
export function surpriseWeights(items = [], { dwell = new Map(), now = Date.now(), shown = new Set() } = {}) {
  const out = [];
  for (const item of items) {
    const key = historyUrl(item?.url);
    if (!key) continue;

    const minutes = (dwell.get(key)?.ms ?? 0) / 60000;
    let weight = 1 + Math.log1p(minutes);

    const lastVisit = Number.isFinite(item?.lastVisit) ? item.lastVisit : item?.lastAccessed;
    if (Number.isFinite(lastVisit) && now - lastVisit < 14 * DAY) weight *= 0.25;

    // A mild pull toward older material, saturating at a year.
    if (Number.isFinite(item?.firstVisit)) {
      weight *= 1 + Math.min(1, (now - item.firstVisit) / (365 * DAY));
    }

    // Seen before is allowed here — the user asked — but it goes to the back.
    if (shown.has(key)) weight *= 0.4;

    out.push({ item, key, weight: Math.max(weight, 0.01) });
  }
  return out;
}

/** Weighted random choice. `random` is injectable so a test can pin the draw. */
export function pickWeighted(weighted = [], random = Math.random) {
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (!weighted.length || total <= 0) return null;

  let cursor = random() * total;
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor < 0) return entry;
  }
  return weighted[weighted.length - 1];
}

/**
 * Follows the foreground tab and reports finished sessions.
 *
 * It holds no storage of its own: each completed session is handed to
 * `onSession`, and the engine decides whether to keep it.
 */
export class DwellTracker {
  constructor({ api = globalThis.chrome, now = () => Date.now(), onSession = () => {} } = {}) {
    Object.assign(this, { api, now, onSession });
    this.current = null;
    this.listeners = [];
  }

  /** Begin following focus changes. Safe to call on every worker wake. */
  start() {
    const listen = (event, handler) => {
      if (!event?.addListener) return;
      event.addListener(handler);
      this.listeners.push(() => event.removeListener(handler));
    };

    listen(this.api.tabs?.onActivated, async ({ tabId }) => {
      try {
        this.enter(await this.api.tabs.get(tabId));
      } catch {
        this.leave();
      }
    });

    listen(this.api.tabs?.onUpdated, (_id, changes, tab) => {
      if (!tab?.active || !changes?.url) return;
      this.enter(tab);
    });

    listen(this.api.windows?.onFocusChanged, async (windowId) => {
      // -1 is chrome.windows.WINDOW_ID_NONE: the browser itself lost focus, so
      // whatever was on screen stops counting.
      if (windowId === -1) return this.leave();
      try {
        const [tab] = await this.api.tabs.query({ active: true, windowId });
        this.enter(tab);
      } catch {
        this.leave();
      }
    });

    return this;
  }

  /** The foreground page changed: close the open session and open a new one. */
  enter(tab) {
    this.leave();
    if (!tab || tab.incognito) return;
    const key = historyUrl(tab.url ?? tab.pendingUrl);
    if (!key) return;
    this.current = { key, url: tab.url ?? tab.pendingUrl, title: tab.title ?? "", since: this.now() };
  }

  /** Close the open session, recording it if it was long enough to mean anything. */
  leave() {
    const open = this.current;
    this.current = null;
    if (!open) return;

    const at = this.now();
    const ms = sessionMs(open.since, at);
    if (ms > 0) this.onSession({ key: open.key, url: open.url, title: open.title, ms, at });
  }

  dispose() {
    this.leave();
    for (const remove of this.listeners) remove();
    this.listeners = [];
  }
}
