/**
 * The whole feature, wired together against a fake browser.
 *
 * The unit tests cover whether a nudge is deserved. This one covers the things
 * only the assembled engine can get wrong: that a page's content is not read
 * before the feature has decided it could act on it, that the badge and the log
 * agree with each other, and that an answer actually feeds back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../extension/local-store.js";
import { RediscoveryStore } from "../extension/rediscovery/store.js";
import { Rediscovery, agePhrase } from "../extension/rediscovery/engine.js";
import { normalizeSettings } from "../extension/rediscovery/settings.js";

const NOW = Date.UTC(2026, 8, 12, 14, 0, 0);
const DAY = 86_400_000;
const ago = (days) => NOW - days * DAY;

const RFC_URL = "https://datatracker.ietf.org/doc/html/rfc8628";
const RFC_TEXT =
  "This document describes the OAuth 2.0 device authorization grant. " +
  "The client must respect the slow_down interval and increase its polling delay by five seconds before asking again. " +
  "Unrelated closing remarks follow here.";

const REPO_TAB = {
  id: 7,
  windowId: 1,
  url: "https://github.com/acme/device-flow-client",
  title: "acme/device-flow-client: an OAuth device flow client · GitHub"
};

/** Ten unrelated tabs, so relatedness is measured against a real reading list. */
const FILLER = [
  "Best espresso grinders",
  "Sourdough troubleshooting",
  "Flight status",
  "Tax deadlines",
  "Kubernetes ingress",
  "CSS subgrid",
  "Rust lifetimes",
  "Postgres vacuum",
  "Figma auto layout",
  "Cabin availability"
].map((title, i) => ({
  id: 100 + i,
  url: "https://example.com/filler/" + i,
  title,
  groupTitle: null,
  firstVisit: ago(200 + i),
  lastAccessed: ago(100)
}));

const RFC_TAB = {
  id: 42,
  url: RFC_URL,
  title: "RFC 8628: OAuth 2.0 device flow and refresh token handling",
  groupTitle: null,
  firstVisit: ago(310),
  lastAccessed: ago(300)
};

function harness({ settings = {}, tabs = [RFC_TAB, ...FILLER], text = RFC_TEXT, history = null } = {}) {
  let clock = NOW;
  const calls = { peek: 0, history: 0 };
  const sent = [];
  const badges = [];
  const opened = { created: [], updated: [] };
  const live = new Map([[RFC_TAB.id, { ...RFC_TAB, windowId: 1 }]]);

  const api = {
    action: {
      setBadgeText: async ({ text: value }) => badges.push(value),
      setBadgeBackgroundColor: async () => {}
    },
    tabs: {
      get: async (id) => {
        const tab = live.get(id);
        if (!tab) throw new Error("no such tab");
        return tab;
      },
      create: async (info) => {
        opened.created.push(info);
        return { id: 999, ...info };
      },
      update: async (id, info) => {
        opened.updated.push({ id, ...info });
        return { id, ...info };
      },
      query: async () => []
    },
    windows: { update: async () => {} }
  };

  const store = new RediscoveryStore({ store: new MemoryStore(), now: () => clock });
  const historySource = history && {
    search: async (query) => {
      calls.history++;
      return history(query);
    }
  };

  const engine = new Rediscovery({
    api,
    store,
    index: { list: async () => tabs },
    cache: { textFor: async () => text },
    historySource,
    peek: async () => {
      calls.peek++;
      return { heading: "OAuth device flow client", description: "", paragraph: "" };
    },
    send: (type, payload) => sent.push({ type, payload }),
    now: () => clock,
    random: () => 0.5,
    settings: async () => normalizeSettings(settings)
  });

  return { engine, store, calls, sent, badges, opened, tick: (ms) => { clock += ms; } };
}

// ---- the automatic path ------------------------------------------------

test("landing on a repo surfaces the RFC you read ten months ago", async () => {
  const { engine, sent, badges } = harness();
  const result = await engine.consider(REPO_TAB);

  assert.equal(result.fired, true, result.reason);
  assert.equal(result.nudge.item.url, RFC_URL);

  // The three things the strip has to say.
  assert.ok(result.nudge.item.title.length, "no title to show");
  assert.ok(result.nudge.firstReadOn, "no first-read date to show");
  assert.match(result.nudge.why, /Shares/);

  assert.deepEqual(badges, ["1"], "the icon should carry it while the panel is shut");
  assert.equal(sent.filter((m) => m.type === "NUDGE").length, 1);
});

test("the link lands on the passage, not the top of the page", async () => {
  const { engine } = harness();
  const { nudge } = await engine.consider(REPO_TAB);

  assert.match(nudge.link, /#:~:text=/);
  // Verbatim, or Chrome finds nothing and drops the reader at the top.
  assert.ok(RFC_TEXT.includes(nudge.passage), "the fragment must be text that is really in the page");
  // And it is the sentence carrying what earned the nudge, not just the first one.
  const lower = nudge.passage.toLowerCase();
  assert.ok(nudge.terms.some((term) => lower.includes(term)), "the passage should show why it was surfaced");
});

test("a page never read has no passage, and the link is just the page", async () => {
  const { engine } = harness({ text: null });
  const { nudge } = await engine.consider(REPO_TAB);

  assert.equal(nudge.passage, null);
  assert.equal(nudge.link, RFC_URL, "an invented passage would fail silently in the browser");
});

test("one nudge an hour, then silence", async () => {
  const { engine, tick } = harness();
  assert.equal((await engine.consider(REPO_TAB)).fired, true);

  tick(30 * 60_000);
  const second = await engine.consider(REPO_TAB);
  assert.equal(second.fired, false);
  assert.match(second.reason, /hour/);
});

test("nothing is read off a page that could not be nudged about anyway", async () => {
  const { engine, calls, tick } = harness();

  await engine.consider(REPO_TAB);
  const afterFirst = calls.peek;
  assert.equal(afterFirst, 1);

  // Rate-limited: the second landing must not look at the page at all.
  tick(60_000);
  await engine.consider(REPO_TAB);
  assert.equal(calls.peek, afterFirst, "a rate-limited page was still read");
});

test("a page that is not somebody's work is never looked at", async () => {
  const { engine, calls } = harness();
  const result = await engine.consider({ id: 3, url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox (12)" });

  assert.equal(result.fired, false);
  assert.equal(calls.peek, 0, "a mail tab must not be peeked at");
});

test("turned off, the feature does nothing whatsoever", async () => {
  const { engine, calls, sent, badges } = harness({ settings: { REDISCOVERY_ENABLED: false } });
  const result = await engine.consider(REPO_TAB);

  assert.equal(result.fired, false);
  assert.match(result.reason, /off/);
  assert.equal(calls.peek, 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(badges, []);
});

test("turned off, no dwell is written down either", async () => {
  // The tracker's listeners are registered at startup and cannot be unregistered
  // when the setting changes, so "off" has to mean nothing is stored.
  const on = harness();
  await on.engine.remember({ key: "https://a.example/", url: "https://a.example/", title: "A", ms: 60_000, at: NOW });
  assert.equal((await on.store.dwell()).size, 1);

  const off = harness({ settings: { REDISCOVERY_ENABLED: false } });
  await off.engine.remember({ key: "https://a.example/", url: "https://a.example/", title: "A", ms: 60_000, at: NOW });
  assert.equal((await off.store.dwell()).size, 0, "dwell was recorded with the feature switched off");
});

test("an incognito tab is not a trigger", async () => {
  const { engine, calls } = harness();
  const result = await engine.consider({ ...REPO_TAB, incognito: true });
  assert.equal(result.fired, false);
  assert.equal(calls.peek, 0);
});

test("when nothing is old enough, it says nothing", async () => {
  const fresh = [{ ...RFC_TAB, firstVisit: ago(3) }, ...FILLER];
  const { engine, sent, badges } = harness({ tabs: fresh });

  const result = await engine.consider(REPO_TAB);
  assert.equal(result.fired, false);
  assert.match(result.reason, /nothing cleared the bar/);
  assert.deepEqual(sent, []);
  assert.deepEqual(badges, []);
});

test("browsing history is only consulted once you have said it may be", async () => {
  const search = () => [];

  const off = harness({ history: search });
  await off.engine.consider(REPO_TAB);
  assert.equal(off.calls.history, 0, "history was read without being turned on");

  const on = harness({ history: search, settings: { REDISCOVERY_HISTORY: true } });
  await on.engine.consider(REPO_TAB);
  assert.equal(on.calls.history, 1);
});

// ---- what counts as arriving somewhere ---------------------------------

test("a single-page app changing route counts as landing on a page", async () => {
  // Notion, Linear and Jira move between pages without a status change. Watching
  // only for "complete" would miss every ticket after the first.
  const fired = [];
  const listeners = [];
  const api = { tabs: { onUpdated: { addListener: (fn) => listeners.push(fn), removeListener() {} } } };

  const engine = new Rediscovery({ api, store: new RediscoveryStore({ store: new MemoryStore() }) });
  engine.consider = async (tab) => { fired.push(tab.url); return { fired: false }; };
  engine.start();

  const emit = (changes, tab) => listeners.forEach((fn) => fn(tab.id, changes, tab));
  const linear = { id: 1, status: "complete", url: "https://linear.app/acme/issue/ENG-42/x" };

  emit({ status: "complete" }, linear);
  emit({ url: linear.url }, linear);                       // route change, no status
  emit({ favIconUrl: "https://linear.app/icon.png" }, linear); // neither
  emit({ status: "loading" }, { ...linear, status: "loading" });

  await engine.working;
  assert.equal(fired.length, 2, "expected the load and the route change, and nothing else");
});

// ---- answering ---------------------------------------------------------

test("opening a nudge navigates the tab it is already in, and clears the badge", async () => {
  const { engine, opened, badges } = harness();
  const { nudge } = await engine.consider(REPO_TAB);

  const answer = await engine.respond(nudge.id, "open");
  assert.equal(answer.ok, true);
  assert.equal(answer.entry.response, "opened");

  assert.equal(opened.created.length, 0, "the tab was already open; a duplicate is noise");
  assert.equal(opened.updated.length, 1);
  assert.equal(opened.updated[0].id, RFC_TAB.id);
  assert.match(opened.updated[0].url, /#:~:text=/);
  assert.deepEqual(badges, ["1", ""], "the badge must clear once answered");
});

test("an item whose tab has been closed opens in a new one", async () => {
  const closed = [{ ...RFC_TAB, id: 5150 }, ...FILLER];
  const { engine, opened } = harness({ tabs: closed });
  const { nudge } = await engine.consider(REPO_TAB);

  await engine.respond(nudge.id, "open");
  assert.equal(opened.updated.length, 0);
  assert.equal(opened.created.length, 1);
  assert.match(opened.created[0].url, /rfc8628/);
});

test("less like this suppresses the theme it was shown for", async () => {
  const { engine, store } = harness();
  const { nudge } = await engine.consider(REPO_TAB);

  await engine.respond(nudge.id, "less");
  const suppressed = await store.suppressed();

  assert.ok(nudge.terms.length, "the nudge should record what earned it");
  for (const term of nudge.terms) assert.ok(suppressed[term] > 0, term + " was not suppressed");
});

test("a dismissal is feedback too, just quieter", async () => {
  const { engine, store } = harness();
  const { nudge } = await engine.consider(REPO_TAB);

  await engine.respond(nudge.id, "dismiss");
  const suppressed = await store.suppressed();
  for (const term of nudge.terms) {
    assert.ok(suppressed[term] > 0 && suppressed[term] < 1, "a shrug should weigh less than saying so");
  }
});

test("the same item is never surfaced twice unasked", async () => {
  const { engine, tick } = harness();
  const first = await engine.consider(REPO_TAB);
  await engine.respond(first.nudge.id, "dismiss");

  // A day later, well past every rate limit, with the same tabs open.
  tick(25 * 3_600_000);
  const second = await engine.consider(REPO_TAB);
  assert.equal(second.fired, false, "it repeated itself");
});

test("answering something that does not exist is an error, not a crash", async () => {
  const { engine } = harness();
  assert.equal((await engine.respond("nope", "open")).ok, false);
});

test("an unknown action changes nothing", async () => {
  const { engine, store } = harness();
  const { nudge } = await engine.consider(REPO_TAB);

  assert.equal((await engine.respond(nudge.id, "sideways")).ok, false);
  assert.deepEqual(await store.suppressed(), {});
  assert.equal((await store.entries())[0].response, "shown");
});

// ---- surprise me -------------------------------------------------------

test("surprise me ignores the threshold and the hourly budget", async () => {
  const { engine } = harness();
  await engine.consider(REPO_TAB); // spends the hour

  const surprise = await engine.surprise();
  assert.equal(surprise.fired, true, surprise.reason);
  assert.equal(surprise.nudge.manual, true);
  assert.ok(surprise.nudge.item.firstVisit, "a resurfaced item is still a dated one");
});

test("a manual pick does not spend the automatic budget", async () => {
  const { engine } = harness();
  const surprise = await engine.surprise();
  assert.equal(surprise.fired, true);

  const auto = await engine.consider(REPO_TAB);
  assert.equal(auto.fired, true, "a manual pick should not have used up the hour");
});

test("with nothing dated to draw from, surprise me says so", async () => {
  const undated = FILLER.map((tab) => ({ ...tab, firstVisit: null }));
  const { engine } = harness({ tabs: undated });

  const result = await engine.surprise();
  assert.equal(result.fired, false);
  assert.match(result.reason, /nothing dated/);
});

// ---- the scoreboard ----------------------------------------------------

test("settings can see how the feature is doing", async () => {
  const { engine } = harness();
  const { nudge } = await engine.consider(REPO_TAB);

  const before = await engine.status();
  assert.equal(before.pending.id, nudge.id);
  assert.equal(before.stats.total, 1);
  assert.equal(before.stats.acceptRate, null, "unanswered is not rejected");

  await engine.respond(nudge.id, "open");
  const after = await engine.status();
  assert.equal(after.pending, null);
  assert.equal(after.stats.acceptRate, 1);
  assert.equal(after.recent[0].response, "opened");
});

test("clearing the log clears the badge with it", async () => {
  const { engine, badges } = harness();
  await engine.consider(REPO_TAB);

  await engine.clearLog();
  const status = await engine.status();

  assert.equal(status.stats.total, 0);
  assert.equal(status.pending, null);
  assert.equal(badges.at(-1), "");
});

test("ages are described, not computed at the reader", () => {
  assert.equal(agePhrase(ago(14), NOW), "14 days ago");
  assert.equal(agePhrase(ago(200), NOW), "7 months ago");
  assert.equal(agePhrase(ago(800), NOW), "2 years ago");
  assert.equal(agePhrase(null, NOW), "undated");
});
