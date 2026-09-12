/**
 * Dwell time, and everything rediscovery remembers between nudges.
 *
 * Dwell is the one number here that is easy to make dishonest: a tab left open
 * over lunch, or flicked past on the way somewhere else, would both read as
 * reading. Both are handled by clamping rather than by hoping.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../extension/local-store.js";
import {
  sessionMs,
  mergeDwell,
  pruneDwell,
  surpriseWeights,
  pickWeighted,
  DwellTracker,
  MAX_SESSION_MS,
  MIN_SESSION_MS
} from "../extension/rediscovery/dwell.js";
import { RediscoveryStore, WEIGHT_LESS, WEIGHT_DISMISS, MAX_SUPPRESSION } from "../extension/rediscovery/store.js";

const NOW = Date.UTC(2026, 8, 12);
const DAY = 86_400_000;
const ago = (days) => NOW - days * DAY;

// ---- measuring a session ----------------------------------------------

test("a glance is not reading", () => {
  assert.equal(sessionMs(0, MIN_SESSION_MS - 1), 0);
  assert.equal(sessionMs(0, MIN_SESSION_MS + 1), MIN_SESSION_MS + 1);
});

test("a tab left open over lunch is not an hour of reading", () => {
  assert.equal(sessionMs(0, 4 * 3_600_000), MAX_SESSION_MS);
});

test("nonsense timestamps record nothing rather than something negative", () => {
  assert.equal(sessionMs(NaN, 10), 0);
  assert.equal(sessionMs(1000, 900), 0);
});

test("sessions accumulate, and the page keeps its latest title", () => {
  let row = mergeDwell({ key: "k", url: "https://a.example/" }, { ms: 60_000, at: 1, title: "First" });
  row = mergeDwell(row, { ms: 30_000, at: 2, title: "Renamed" });

  assert.equal(row.ms, 90_000);
  assert.equal(row.sessions, 2);
  assert.equal(row.title, "Renamed");
  assert.equal(row.lastAt, 2);
});

test("a full dwell table drops the pages least dwelt on", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ key: "dwell:" + i, ms: i * 1000 }));
  const { keep, drop } = pruneDwell(rows, 10);
  assert.equal(keep.length, 10);
  assert.deepEqual(drop.map((r) => r.ms).sort((a, b) => a - b), [0, 1000]);
});

// ---- the weighted draw ------------------------------------------------

const item = (url, extra = {}) => ({ url, title: url, firstVisit: ago(200), lastVisit: ago(200), ...extra });
const weightOf = (weighted, url) => weighted.find((w) => w.item.url === url).weight;

test("time spent raises the odds; a page never opened still has some", () => {
  const items = [item("https://read.example/"), item("https://skimmed.example/")];
  const dwell = new Map([["https://read.example/", { ms: 40 * 60_000 }]]);
  const weighted = surpriseWeights(items, { dwell, now: NOW });

  assert.ok(weightOf(weighted, "https://read.example/") > weightOf(weighted, "https://skimmed.example/"));
  assert.ok(weightOf(weighted, "https://skimmed.example/") > 0, "no dwell record is a long shot, not a disqualification");
});

test("something you were reading yesterday is not a rediscovery", () => {
  const items = [item("https://old.example/"), item("https://current.example/", { lastVisit: ago(1) })];
  const weighted = surpriseWeights(items, { now: NOW });
  assert.ok(weightOf(weighted, "https://old.example/") > weightOf(weighted, "https://current.example/") * 3);
});

test("something already surfaced goes to the back of the queue, not out of it", () => {
  const items = [item("https://a.example/"), item("https://b.example/")];
  const weighted = surpriseWeights(items, { now: NOW, shown: new Set(["https://b.example/"]) });
  assert.ok(weightOf(weighted, "https://a.example/") > weightOf(weighted, "https://b.example/"));
  assert.ok(weightOf(weighted, "https://b.example/") > 0);
});

test("the draw follows the weights", () => {
  const weighted = [
    { item: "a", key: "a", weight: 1 },
    { item: "b", key: "b", weight: 3 }
  ];
  assert.equal(pickWeighted(weighted, () => 0.1).key, "a");
  assert.equal(pickWeighted(weighted, () => 0.5).key, "b");
  assert.equal(pickWeighted(weighted, () => 0.999).key, "b");
  assert.equal(pickWeighted([], () => 0.5), null);
});

// ---- following the foreground -----------------------------------------

function tracker() {
  let clock = 1_000_000;
  const sessions = [];
  const t = new DwellTracker({ api: {}, now: () => clock, onSession: (s) => sessions.push(s) });
  return { t, sessions, tick: (ms) => { clock += ms; } };
}

test("switching away closes the session that was open", () => {
  const { t, sessions, tick } = tracker();
  t.enter({ id: 1, url: "https://a.example/x", title: "A" });
  tick(60_000);
  t.enter({ id: 2, url: "https://b.example/y", title: "B" });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].ms, 60_000);
  assert.equal(sessions[0].key, "https://a.example/x");
});

test("incognito and unscriptable pages are never measured", () => {
  const { t, sessions, tick } = tracker();
  t.enter({ id: 1, url: "https://private.example/", incognito: true });
  tick(60_000);
  t.enter({ id: 2, url: "chrome://extensions" });
  tick(60_000);
  t.leave();
  assert.deepEqual(sessions, []);
});

test("the browser losing focus stops the clock", () => {
  const { t, sessions, tick } = tracker();
  t.enter({ id: 1, url: "https://a.example/x" });
  tick(30_000);
  t.leave();
  tick(3_600_000); // away from the browser entirely
  t.leave();

  assert.equal(sessions.length, 1, "an already-closed session must not close twice");
  assert.equal(sessions[0].ms, 30_000);
});

// ---- what is remembered -----------------------------------------------

const nudge = (id, overrides = {}) => ({
  id,
  at: NOW,
  manual: false,
  terms: ["device", "refresh"],
  item: { key: "https://ietf.org/rfc" + id, url: "https://ietf.org/rfc" + id, title: "RFC" },
  ...overrides
});

test("a nudge is logged as shown, then updated with the answer", async () => {
  const store = new RediscoveryStore({ store: new MemoryStore(), now: () => NOW });
  await store.record(nudge("one"));

  assert.equal((await store.entries())[0].response, "shown");

  const updated = await store.respond("one", "opened");
  assert.equal(updated.response, "opened");
  assert.equal(updated.respondedAt, NOW);
  assert.equal((await store.entries()).length, 1, "answering must not add a second row");
});

test("answering a nudge that is not there says so rather than throwing", async () => {
  const store = new RediscoveryStore({ store: new MemoryStore(), now: () => NOW });
  assert.equal(await store.respond("missing", "opened"), null);
});

test("everything surfaced is remembered, so nothing repeats unasked", async () => {
  const store = new RediscoveryStore({ store: new MemoryStore(), now: () => NOW });
  await store.record(nudge("one"));
  await store.record(nudge("two"));

  const keys = await store.shownKeys();
  assert.equal(keys.size, 2);
  assert.ok(keys.has("https://ietf.org/rfcone"));
});

test("a shrug counts for less than saying so outright", async () => {
  const store = new RediscoveryStore({ store: new MemoryStore(), now: () => NOW });

  await store.suppress(["device"], WEIGHT_DISMISS);
  const afterOne = await store.suppressed();
  assert.equal(afterOne.device, WEIGHT_DISMISS);

  await store.suppress(["device"], WEIGHT_LESS);
  assert.equal((await store.suppressed()).device, WEIGHT_DISMISS + WEIGHT_LESS);

  // Three dismissals are worth about one "less like this".
  assert.ok(WEIGHT_DISMISS * 3 >= WEIGHT_LESS * 0.9 && WEIGHT_DISMISS * 3 <= WEIGHT_LESS * 1.1);
});

test("a theme cannot be suppressed so hard it can never come back", async () => {
  const store = new RediscoveryStore({ store: new MemoryStore(), now: () => NOW });
  for (let i = 0; i < 20; i++) await store.suppress(["device"], WEIGHT_LESS);
  assert.equal((await store.suppressed()).device, MAX_SUPPRESSION);
});

test("clearing the log keeps the dwell table", async () => {
  const store = new RediscoveryStore({ store: new MemoryStore(), now: () => NOW });
  await store.record(nudge("one"));
  await store.suppress(["device"], WEIGHT_LESS);
  await store.recordDwell({ key: "https://a.example/", url: "https://a.example/", title: "A", ms: 60_000, at: NOW });

  await store.clearLog();

  assert.deepEqual(await store.entries(), []);
  assert.deepEqual(await store.suppressed(), {});
  assert.equal((await store.dwell()).get("https://a.example/").ms, 60_000, "dwell is not part of the log");
});

test("state survives being written twice and keeps its other fields", async () => {
  const store = new RediscoveryStore({ store: new MemoryStore(), now: () => NOW });
  await store.setState({ lastEvaluatedAt: NOW });
  await store.setState({ pending: { id: "one" } });

  const state = await store.state();
  assert.equal(state.lastEvaluatedAt, NOW);
  assert.equal(state.pending.id, "one");
});
