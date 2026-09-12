/**
 * The slice flow assembled: draft, confirm, generate, regenerate.
 *
 * The unit tests cover what belongs in a document. These cover the promises the
 * flow makes about it — that nothing is written before the user confirms, that
 * an item they removed cannot come back, and that regenerating after reading
 * more does not quietly undo their decisions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../extension/local-store.js";
import { SliceStore, KIND } from "../extension/slices/store.js";
import { Slices } from "../extension/slices/engine.js";
import { sourceUrls, handOff, slicePageUrl } from "../extension/slices/handoff.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 12);
const ago = (days) => NOW - days * DAY;

const RFC = "https://datatracker.ietf.org/doc/html/rfc8628";
const BLOG = "https://blog.example/device-polling";
const IMPL = "https://impl.example/device-grant";
const HEALTH = "https://www.nhs.uk/conditions/anxiety/";
const GUIDE = "https://guide.test/device-flow-guide";
const ERRORS = "https://errors.test/device-flow-errors";

/**
 * A realistic pool: four pages on one subject inside a wider set of reading.
 * A theme has to be a minority of what is open, or it is not a theme — it is
 * just everything you have.
 */
const OTHER = [
  "Sourdough starter troubleshooting",
  "Espresso grinder burr alignment",
  "Flight status and baggage rules",
  "Rust lifetime elision rules",
  "Postgres vacuum tuning guide",
  "CSS subgrid browser support",
  "Figma auto layout basics"
].map((title, i) => ({
  id: 20 + i,
  url: "https://other" + i + ".test/page",
  title,
  groupTitle: null,
  firstVisit: ago(60 + i),
  lastAccessed: ago(4)
}));

const TABS = [
  { id: 1, url: RFC, title: "RFC 8628 OAuth device flow", groupTitle: null, firstVisit: ago(300), lastAccessed: ago(9) },
  { id: 2, url: BLOG, title: "Device flow polling in practice", groupTitle: null, firstVisit: ago(200), lastAccessed: ago(8) },
  { id: 3, url: IMPL, title: "Implementing the device flow grant", groupTitle: null, firstVisit: ago(100), lastAccessed: ago(7) },
  { id: 4, url: HEALTH, title: "Device flow and anxiety symptoms", groupTitle: null, firstVisit: ago(150), lastAccessed: ago(6) },
  { id: 5, url: GUIDE, title: "A practical device flow guide", groupTitle: null, firstVisit: ago(180), lastAccessed: ago(6) },
  { id: 6, url: ERRORS, title: "Device flow error responses", groupTitle: null, firstVisit: ago(90), lastAccessed: ago(6) },
  ...OTHER
];

const TEXT = {
  [RFC]: "The client must respect the slow_down interval when polling the device endpoint.",
  [BLOG]: "In practice the device flow polling loop is where most implementations go wrong."
};

function harness({ tabs = TABS, text = TEXT, model = null } = {}) {
  const reads = [];
  const store = new SliceStore({ store: new MemoryStore(), now: () => NOW });

  const cache = {
    textFor: async (url) => text[url] ?? null,
    get: async (tabId) => {
      reads.push(tabId);
      const tab = tabs.find((t) => t.id === tabId);
      const body = tab ? text[tab.url] ?? "Freshly read words about the device flow grant." : null;
      return body ? { id: tabId, text: body, textStatus: "ok" } : { id: tabId, text: null, textStatus: "blocked" };
    }
  };

  const slices = new Slices({
    api: { storage: { local: { get: async () => ({}) } } },
    store,
    cache,
    tabs: async () => tabs,
    model,
    now: () => NOW
  });

  return { slices, store, reads };
}

// ---- drafting ----------------------------------------------------------

test("a draft is a review, not a document", async () => {
  const { slices } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);

  assert.equal(draft.kind, KIND.draft);
  assert.equal(draft.markdown, null, "nothing may be generated before the user confirms");
  assert.ok(draft.entries.length >= 3);
});

test("the health page is in the review, switched off and counted", async () => {
  const { slices } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);

  const health = draft.entries.find((e) => e.key.includes("nhs.uk"));
  assert.ok(health, "it has to be shown, or the filtering is invisible");
  assert.equal(health.included, false);
  assert.equal(draft.summary.autoExcluded, 1);
});

test("drafting reads nothing: passages come only from what was already extracted", async () => {
  const { slices, reads } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);

  assert.deepEqual(reads, [], "building a review must not open or read a page");
  const impl = draft.entries.find((e) => e.key === IMPL);
  assert.equal(impl.passage, null);
  assert.match(impl.passageStatus, /never read/);
});

test("the user can ask for the unread pages to be read", async () => {
  const { slices, reads } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);

  const result = await slices.readMissing(draft.id);
  assert.equal(result.ok, true);
  assert.ok(reads.length > 0, "this is the one path that is allowed to read");

  const impl = result.draft.entries.find((e) => e.key === IMPL);
  assert.match(impl.passage, /device flow grant/);
});

test("a page that is not open says so rather than being read from nowhere", async () => {
  const { slices } = harness();
  const draft = await slices.draftFromItems(
    [{ url: "https://closed.example/page", title: "Closed tab", firstVisit: ago(400) }],
    "a set",
    ["closed"]
  );

  const result = await slices.readMissing(draft.id);
  assert.equal(result.notOpen, 1);
  assert.match(result.draft.entries[0].passageStatus, /not open in a tab/);
});

// ---- generating --------------------------------------------------------

test("only what the user kept is in the document", async () => {
  const { slices } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);

  const result = await slices.generate(draft.id, {
    title: "Device flow",
    intro: "What I read about it.",
    keep: [RFC]
  });

  assert.equal(result.ok, true);
  assert.match(result.slice.markdown, /RFC 8628/);
  assert.doesNotMatch(result.slice.markdown, /polling in practice/i, "a removed page ended up in the document");
  assert.doesNotMatch(result.slice.markdown, /nhs\.uk/, "the excluded page ended up in the document");
});

test("keep is authoritative even over what the draft said", async () => {
  // The draft has the health page switched off; an explicit keep puts it back.
  const { slices } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);

  const result = await slices.generate(draft.id, { keep: [HEALTH] });
  assert.match(result.slice.markdown, /nhs\.uk/, "the user's explicit choice must win");
});

test("an empty selection is refused rather than exported blank", async () => {
  const { slices } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);

  const result = await slices.generate(draft.id, { keep: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /nothing is left/);
});

test("a generated slice is saved and shows up in the library", async () => {
  const { slices } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);
  const { slice } = await slices.generate(draft.id, { title: "Device flow", keep: [RFC, BLOG] });

  const saved = await slices.list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, slice.id);
  assert.equal(saved[0].kind, KIND.slice);
  assert.equal(saved[0].generations, 1);

  // The draft is not a second row: it became this.
  assert.equal((await slices.store.all()).length, 1);
});

test("without a model the document still generates, and admits it", async () => {
  const { slices } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);
  const { slice } = await slices.generate(draft.id, { keep: [RFC, BLOG] });

  assert.equal(slice.modelWritten, false);
  assert.match(slice.markdown, /Assembled without a model/);
});

test("with a model, its grouping and synthesis are used", async () => {
  const model = async () => ({
    content: JSON.stringify({
      groups: [
        { label: "The specification", keys: [RFC, ERRORS] },
        { label: "In practice", keys: [BLOG, IMPL, GUIDE] }
      ],
      notes: { [RFC]: "The normative text.", [BLOG]: "Where it goes wrong." },
      synthesis: "One problem, described twice."
    })
  });

  const { slices } = harness({ model });
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);
  const { slice } = await slices.generate(draft.id, { keep: [RFC, BLOG, IMPL, GUIDE, ERRORS] });

  assert.equal(slice.modelWritten, true);
  assert.match(slice.markdown, /## The specification/);
  assert.match(slice.markdown, /One problem, described twice\./);
  assert.match(slice.markdown, /written by a language model/);
});

// ---- living with it ----------------------------------------------------

test("regenerating picks up what you have read since", async () => {
  const { slices, store } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);
  const { slice } = await slices.generate(draft.id, { title: "Device flow", keep: [RFC, BLOG] });

  // A new tab on the same theme, opened after the slice was made.
  const grown = [
    ...TABS,
    { id: 9, url: "https://new.example/device-flow-errors", title: "Device flow error handling", groupTitle: null, firstVisit: ago(2), lastAccessed: NOW }
  ];
  const later = new Slices({
    api: { storage: { local: { get: async () => ({}) } } },
    store,
    cache: { textFor: async () => null, get: async () => ({ textStatus: "blocked" }) },
    tabs: async () => grown,
    now: () => NOW
  });

  const result = await later.regenerate(slice.id);
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.match(result.slice.markdown, /error handling/);
  assert.equal(result.slice.generations, 2);
  assert.equal(result.slice.id, slice.id, "regenerating must not fork a second slice");
});

test("regenerating never puts back something the user removed", async () => {
  const { slices, store } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);
  const { slice } = await slices.generate(draft.id, { title: "Device flow", keep: [RFC] });

  const later = new Slices({
    api: { storage: { local: { get: async () => ({}) } } },
    store,
    cache: { textFor: async (url) => TEXT[url] ?? null, get: async () => ({ textStatus: "blocked" }) },
    tabs: async () => TABS,
    now: () => NOW
  });

  const result = await later.regenerate(slice.id);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.slice.markdown, /polling in practice/i, "a removed page came back");
  assert.doesNotMatch(result.slice.markdown, /nhs\.uk/, "an excluded page came back");
});

test("a slice the user deleted is gone", async () => {
  const { slices } = harness();
  const themes = await slices.themes();
  const draft = await slices.draftFromTheme(themes[0].id);
  const { slice } = await slices.generate(draft.id, { keep: [RFC] });

  await slices.remove(slice.id);
  assert.equal(await slices.get(slice.id), null);
  assert.deepEqual(await slices.list(), []);
});

// ---- handing a result set over -----------------------------------------

const SKILL = [
  "---",
  "name: fix-device-flow",
  "description: something",
  "---",
  "",
  "Visit https://example.com/inline for an example of the wrong approach.",
  "",
  "## Sources",
  "",
  "- https://datatracker.ietf.org/doc/html/rfc8628 — open tab; earliest recorded visit 2024-03-01",
  "- https://blog.example/device-polling — from browsing history; visit date unknown",
  "- (no url) — tab date unknown",
  ""
].join("\n");

test("a run's cited sources are a result set that can be sliced", () => {
  assert.deepEqual(sourceUrls(SKILL), [
    "https://datatracker.ietf.org/doc/html/rfc8628",
    "https://blog.example/device-polling"
  ]);
});

test("a URL quoted in the procedure is not a cited source", () => {
  assert.ok(!sourceUrls(SKILL).includes("https://example.com/inline"));
});

test("a skill with no sources section hands over nothing", () => {
  assert.deepEqual(sourceUrls("# just a heading"), []);
  assert.deepEqual(sourceUrls(undefined), []);
});

test("the handoff travels through the store, not the query string", async () => {
  const store = new SliceStore({ store: new MemoryStore(), now: () => NOW });
  const api = { runtime: { getURL: (path) => "chrome-extension://abc/" + path } };

  const url = await handOff({ urls: sourceUrls(SKILL), label: "a run", store, api });
  assert.match(url, /^chrome-extension:\/\/abc\/extension\/slices\/slices\.html\?handoff=/);

  const id = new URL(url).searchParams.get("handoff");
  const row = await store.get(id);
  assert.equal(row.kind, KIND.handoff);
  assert.equal(row.urls.length, 2);
  assert.equal(row.label, "a run");
});

test("handing over nothing opens nothing", async () => {
  const store = new SliceStore({ store: new MemoryStore(), now: () => NOW });
  const api = { runtime: { getURL: (p) => p } };
  assert.equal(await handOff({ urls: [], label: "x", store, api }), null);
  assert.equal(await handOff({ urls: ["not-a-url"], label: "x", store, api }), null);
});

test("the slice page URL is built from the extension's own root", () => {
  const api = { runtime: { getURL: (path) => "chrome-extension://abc/" + path } };
  assert.equal(slicePageUrl("", api), "chrome-extension://abc/extension/slices/slices.html");
});

test("abandoned drafts and handoffs are swept; saved slices are not", async () => {
  let clock = NOW;
  const store = new SliceStore({ store: new MemoryStore(), now: () => clock });

  await store.save({ kind: KIND.draft, title: "abandoned" });
  await store.save({ kind: KIND.handoff, urls: ["https://a.example/"] });
  const kept = await store.save({ kind: KIND.slice, title: "kept", markdown: "#" });

  clock += 2 * DAY;
  assert.equal(await store.sweepDrafts(), 2);
  assert.equal((await store.list()).length, 1);
  assert.ok(await store.get(kept.id), "a slice the user made is never swept");
});
