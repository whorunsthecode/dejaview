/**
 * The parts of a slice that decide what ends up in a document somebody shares.
 *
 * Two failure modes matter more than the rest: a private page appearing in an
 * exported file, and a page the user removed reappearing anyway. Both are
 * silent — the document just has it — so both are tested from several angles.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clusterThemes, MIN_THEME_SIZE } from "../extension/slices/themes.js";
import { classify, partition, CATEGORIES } from "../extension/slices/sensitive.js";
import { buildReview, withToggle, chosen, unreadKeys, PASSAGE_STATUS } from "../extension/slices/review.js";
import { renderSlice } from "../extension/slices/render.js";
import { sanitize, fallbackCompose, composeSlice } from "../extension/slices/compose.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 12);
const ago = (days) => NOW - days * DAY;

const tab = (id, title, url, extra = {}) => ({
  id,
  title,
  url,
  groupTitle: null,
  firstVisit: ago(100 + id),
  lastAccessed: ago(10),
  ...extra
});

// ---- themes -----------------------------------------------------------

test("pages that share a distinctive subject become a theme", () => {
  const themes = clusterThemes([
    tab(1, "OAuth device flow explained", "https://a.example/oauth-device"),
    tab(2, "Device flow polling intervals", "https://b.example/device-polling"),
    tab(3, "Implementing the device grant", "https://c.example/device-grant"),
    tab(4, "Sourdough starter guide", "https://d.example/sourdough"),
    tab(5, "Espresso grinder reviews", "https://e.example/grinders")
  ]);

  assert.equal(themes.length, 1, "only one subject repeats here");
  assert.match(themes[0].label.toLowerCase(), /device/);
  assert.equal(themes[0].size, 3);
});

test("a tab group the user named beats anything inferred", () => {
  const themes = clusterThemes([
    tab(1, "OAuth device flow", "https://a.example/1", { groupTitle: "auth rewrite" }),
    tab(2, "Device polling", "https://b.example/2", { groupTitle: "auth rewrite" }),
    tab(3, "Device grant", "https://c.example/3", { groupTitle: "auth rewrite" })
  ]);

  assert.equal(themes.length, 1);
  assert.equal(themes[0].label, "auth rewrite", "they already said what this pile is");
  assert.equal(themes[0].source, "group");
});

test("pages in no theme are left out rather than swept into 'other'", () => {
  const themes = clusterThemes([
    tab(1, "OAuth device flow", "https://a.example/1"),
    tab(2, "Device polling", "https://b.example/2"),
    tab(3, "Device grant", "https://c.example/3"),
    tab(4, "Sourdough", "https://d.example/4"),
    tab(5, "Grinders", "https://e.example/5")
  ]);

  const labels = themes.map((t) => t.label.toLowerCase());
  assert.ok(!labels.includes("other"), "a theme nobody would recognise is not a theme");
  const claimed = themes.flatMap((t) => t.items.map((i) => i.key));
  assert.equal(claimed.length, 3);
});

test("two pages are a coincidence, not an interest", () => {
  const themes = clusterThemes([
    tab(1, "Rust lifetimes", "https://a.example/1"),
    tab(2, "Rust lifetimes again", "https://b.example/2")
  ]);
  assert.deepEqual(themes, []);
  assert.equal(MIN_THEME_SIZE, 3);
});

test("a theme records its span and admits what it could not date", () => {
  const themes = clusterThemes([
    tab(1, "Device flow one", "https://a.example/1", { firstVisit: ago(400) }),
    tab(2, "Device flow two", "https://b.example/2", { firstVisit: ago(10) }),
    tab(3, "Device flow three", "https://c.example/3", { firstVisit: null })
  ]);

  assert.equal(themes[0].undated, 1);
  assert.equal(themes[0].span.from, ago(400));
  assert.equal(themes[0].span.to, ago(10));
});

test("a theme is never named after a website", () => {
  // Hostname words decide membership but make terrible subjects: cluster on
  // them and you get a theme called "medium" or "substack", which says where
  // you read rather than what about.
  const themes = clusterThemes([
    tab(1, "Rust lifetime elision", "https://medium.com/@a/rust-lifetimes"),
    tab(2, "Rust borrow checker notes", "https://medium.com/@b/borrow-checker"),
    tab(3, "Rust pinning explained", "https://medium.com/@c/pinning"),
    tab(4, "Sourdough", "https://medium.com/@d/sourdough"),
    tab(5, "Grinders", "https://medium.com/@e/grinders"),
    tab(6, "Tax deadlines", "https://medium.com/@f/tax")
  ]);

  assert.ok(themes.length, "expected the rust pages to group");
  assert.match(themes[0].label.toLowerCase(), /rust/);
  assert.ok(!themes[0].terms.includes("medium"), "the site name leaked into the theme's terms");
});

// ---- the sensitive list ------------------------------------------------

test("the categories that should never land in a shared document are caught", () => {
  const caught = [
    "https://www.nhs.uk/conditions/anxiety/",
    "https://mychart.hospital.org/visits",
    "https://www.chase.com/personal/credit-cards",
    "https://irs.gov/refunds",
    "https://www.pornhub.com/",
    "https://tinder.com/app/recs",
    "https://someimmigrationlawyer.com/asylum",
    "https://www.indeed.com/jobs?q=engineer",
    "https://www.linkedin.com/jobs/view/123",
    "https://mail.google.com/mail/u/0/"
  ];
  for (const url of caught) {
    assert.equal(classify(url).sensitive, true, url + " should be excluded by default");
  }
});

test("ordinary reading is not swept up with it", () => {
  const kept = [
    "https://datatracker.ietf.org/doc/html/rfc8628",
    "https://github.com/anthropics/claude-code",
    "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
    "https://news.ycombinator.com/item?id=1",
    "https://www.linkedin.com/feed/",
    "https://blog.rust-lang.org/2024/01/01/rust.html"
  ];
  for (const url of kept) {
    assert.equal(classify(url).sensitive, false, url + " should not be excluded");
  }
});

test("an unreadable address is excluded rather than guessed at", () => {
  assert.equal(classify("not a url").sensitive, true);
  assert.equal(classify(undefined).sensitive, true);
});

test("the user's own exclusions are honoured", () => {
  assert.equal(classify("https://internal.acme.corp/wiki").sensitive, false);
  const verdict = classify("https://internal.acme.corp/wiki", ["acme.corp"]);
  assert.equal(verdict.sensitive, true);
  assert.match(verdict.reason, /your own/);
});

test("every category explains itself, because the count has to be readable", () => {
  for (const category of CATEGORIES) {
    assert.ok(category.label && category.label.length > 3, category.name + " has no readable label");
  }
});

test("flagged pages are counted and returned, never silently dropped", () => {
  const items = [
    { url: "https://datatracker.ietf.org/rfc" },
    { url: "https://www.nhs.uk/conditions/x" },
    { url: "https://www.chase.com/y" }
  ];
  const result = partition(items);

  assert.equal(result.included.length, 1);
  assert.equal(result.count, 2);
  assert.equal(result.flagged.length, 2, "the caller needs them to show what it filtered");
  assert.deepEqual(Object.keys(result.byCategory).sort(), ["health and medical", "money and finance"]);
});

// ---- the review --------------------------------------------------------

const THEME = { id: "term:device", label: "device flow", terms: ["device", "flow", "oauth", "polling"] };

const REVIEW_ITEMS = [
  tab(1, "RFC 8628 device flow", "https://datatracker.ietf.org/doc/html/rfc8628"),
  tab(2, "Device flow polling", "https://blog.example/device-polling"),
  tab(3, "Anxiety and sleep", "https://www.nhs.uk/conditions/anxiety/"),
  tab(4, "Never read this one", "https://unread.example/page")
];

const PASSAGES = new Map([
  [
    "https://datatracker.ietf.org/doc/html/rfc8628",
    "The client must respect the slow_down interval when polling the device endpoint for a token."
  ],
  ["https://blog.example/device-polling", "A short note about nothing in particular at all here."]
]);

test("the review shows every item, with what would be quoted from it", () => {
  const review = buildReview({ theme: THEME, items: REVIEW_ITEMS, passages: PASSAGES });

  assert.equal(review.entries.length, 4, "every item is shown, including the excluded one");
  for (const entry of review.entries) {
    assert.ok(entry.title, "an item with no title cannot be reviewed");
    assert.ok(entry.domain, "an item with no domain cannot be reviewed");
    assert.ok("date" in entry, "the date has to be shown even when it is null");
    assert.ok("passage" in entry);
  }

  const rfc = review.entries.find((e) => e.key.includes("rfc8628"));
  assert.match(rfc.passage, /slow_down/);
  assert.equal(rfc.passageStatus, PASSAGE_STATUS.quoted);
});

test("a page that was never read says so instead of showing an empty quote", () => {
  const review = buildReview({ theme: THEME, items: REVIEW_ITEMS, passages: PASSAGES });
  const unread = review.entries.find((e) => e.key.includes("unread.example"));

  assert.equal(unread.passage, null);
  assert.equal(unread.passageStatus, PASSAGE_STATUS.unread);
  assert.deepEqual(unreadKeys(review), ["https://unread.example/page"]);
});

test("a page that was read but does not match says that instead", () => {
  const review = buildReview({ theme: THEME, items: REVIEW_ITEMS, passages: PASSAGES });
  const blog = review.entries.find((e) => e.key.includes("blog.example"));
  assert.equal(blog.passageStatus, PASSAGE_STATUS.nomatch);
});

test("sensitive pages arrive switched off, explained, and counted", () => {
  const review = buildReview({ theme: THEME, items: REVIEW_ITEMS, passages: PASSAGES });
  const health = review.entries.find((e) => e.key.includes("nhs.uk"));

  assert.equal(health.included, false, "it must not be on by default");
  assert.equal(health.autoExcluded, true);
  assert.match(health.excludedReason, /health/);

  // Visible rather than silent: the count is part of the summary.
  assert.equal(review.summary.autoExcluded, 1);
  assert.deepEqual(review.summary.byCategory, { "health and medical": 1 });
  assert.ok(!chosen(review).some((e) => e.key.includes("nhs.uk")));
});

test("toggling an item does not mutate the review it came from", () => {
  const review = buildReview({ theme: THEME, items: REVIEW_ITEMS, passages: PASSAGES });
  const key = "https://datatracker.ietf.org/doc/html/rfc8628";

  const next = withToggle(review, key, false);
  assert.equal(review.entries.find((e) => e.key === key).included, true, "the original was mutated");
  assert.equal(next.entries.find((e) => e.key === key).included, false);
  assert.equal(next.summary.included, review.summary.included - 1);
});

test("a sensitive page can be put back deliberately", () => {
  const review = buildReview({ theme: THEME, items: REVIEW_ITEMS, passages: PASSAGES });
  const restored = withToggle(review, "https://www.nhs.uk/conditions/anxiety/", true);
  assert.ok(chosen(restored).some((e) => e.key.includes("nhs.uk")), "the toggle has to work both ways");
});

// ---- the document ------------------------------------------------------

const ENTRIES = [
  {
    key: "k1",
    url: "https://datatracker.ietf.org/doc/html/rfc8628",
    title: "RFC 8628",
    domain: "datatracker.ietf.org",
    firstVisit: ago(300),
    date: "2025-11-16",
    passage: "The client must respect the slow_down interval."
  },
  {
    key: "k2",
    url: "https://blog.example/device",
    title: "Notes on [device] flow",
    domain: "blog.example",
    firstVisit: null,
    date: null,
    passage: null
  }
];

test("the document carries the title, intro, and each item in full", () => {
  const md = renderSlice({
    title: "Reading on device flow",
    intro: "What I worked out about the device grant.",
    entries: ENTRIES,
    notes: { k1: "The specification itself.", k2: "A practitioner's account." },
    synthesis: "Together these describe one problem from both ends.",
    generatedAt: NOW
  });

  assert.match(md, /^# Reading on device flow/);
  assert.match(md, /What I worked out about the device grant\./);
  assert.match(md, /## \[RFC 8628\]\(https:\/\/datatracker\.ietf\.org\/doc\/html\/rfc8628\)/);
  assert.match(md, /First read 2025-11-16 · datatracker\.ietf\.org/);
  assert.match(md, /The specification itself\./);
  assert.match(md, /^> The client must respect the slow_down interval\./m);
  assert.match(md, /## What this adds up to/);
  assert.match(md, /Together these describe one problem from both ends\./);
});

test("an undated item says so rather than being given today's date", () => {
  const md = renderSlice({ title: "t", entries: ENTRIES, generatedAt: NOW });
  assert.match(md, /First read: unknown/);
  assert.match(md, /1 of them could not be dated\./);
});

test("markdown syntax inside a title cannot break the link", () => {
  const md = renderSlice({ title: "t", entries: ENTRIES, generatedAt: NOW });
  assert.match(md, /\[Notes on \\\[device\\\] flow\]/);
});

test("a URL with parentheses is wrapped, not silently truncated", () => {
  const md = renderSlice({
    title: "t",
    entries: [{ key: "k", url: "https://en.wikipedia.org/wiki/Cursor_(user_interface)", title: "Cursor", domain: "en.wikipedia.org", firstVisit: null, date: null, passage: null }],
    generatedAt: NOW
  });
  assert.match(md, /\(<https:\/\/en\.wikipedia\.org\/wiki\/Cursor_\(user_interface\)>\)/);
});

test("sub-themes are used when they cover the slice", () => {
  const md = renderSlice({
    title: "t",
    entries: ENTRIES,
    groups: [
      { label: "The specification", keys: ["k1"] },
      { label: "In practice", keys: ["k2"] }
    ],
    generatedAt: NOW
  });

  assert.match(md, /^## The specification/m);
  assert.match(md, /^## In practice/m);
  assert.match(md, /^### \[RFC 8628\]/m, "items drop a level under a sub-theme");
});

test("a grouping that forgets an item still exports that item", () => {
  // Losing a page the user explicitly kept is the worst thing this could do.
  const md = renderSlice({
    title: "t",
    entries: ENTRIES,
    groups: [
      { label: "One", keys: ["k1"] },
      { label: "Two", keys: ["k1"] }
    ],
    generatedAt: NOW
  });
  assert.match(md, /Notes on/, "the forgotten item vanished from the document");
});

test("one group is not a grouping", () => {
  const md = renderSlice({ title: "t", entries: ENTRIES, groups: [{ label: "Only one", keys: ["k1", "k2"] }], generatedAt: NOW });
  assert.doesNotMatch(md, /^## Only one/m);
});

test("the footer says whether a model wrote the prose", () => {
  const withModel = renderSlice({ title: "t", entries: ENTRIES, modelWritten: true, generatedAt: NOW });
  assert.match(withModel, /written by a language model/);

  const without = renderSlice({ title: "t", entries: ENTRIES, modelWritten: false, generatedAt: NOW });
  assert.match(without, /Assembled without a model/);
  assert.match(without, /earliest visit still in browser history/);
});

// ---- composing ---------------------------------------------------------

test("a model reply is trimmed to what actually exists", () => {
  const clean = sanitize(
    {
      groups: [
        { label: "Real", keys: ["k1", "ghost"] },
        { label: "Also real", keys: ["k2"] },
        { label: "", keys: ["k1"] }
      ],
      notes: { k1: "  a   note  ", ghost: "about nothing", k2: "x".repeat(500) },
      synthesis: "  A closing thought.  "
    },
    ENTRIES
  );

  assert.deepEqual(clean.groups, [
    { label: "Real", keys: ["k1"] },
    { label: "Also real", keys: ["k2"] }
  ]);
  assert.equal(clean.notes.k1, "a note");
  assert.equal(clean.notes.ghost, undefined, "a key that does not exist must not survive");
  assert.ok(clean.notes.k2.length <= 220);
  assert.equal(clean.synthesis, "A closing thought.");
});

test("a page cannot be put in two groups at once", () => {
  const clean = sanitize({ groups: [{ label: "A", keys: ["k1"] }, { label: "B", keys: ["k1", "k2"] }] }, ENTRIES);
  assert.deepEqual(clean.groups, [{ label: "A", keys: ["k1"] }, { label: "B", keys: ["k2"] }]);
});

test("without a model the document counts rather than concludes", () => {
  const composed = fallbackCompose({ theme: THEME, entries: ENTRIES });

  assert.equal(composed.modelWritten, false);
  assert.deepEqual(composed.groups, [], "grouping is the model's job, not a guess");
  assert.match(composed.synthesis, /without a language model/);
  assert.match(composed.synthesis, /2 pages from 2 sites/);
  assert.match(composed.synthesis, /listed without a quote/);
});

test("a model that returns nonsense degrades instead of corrupting", async () => {
  const composed = await composeSlice({
    theme: THEME,
    entries: ENTRIES,
    model: async () => ({ content: '{"groups":"not an array","notes":null}' })
  });

  assert.equal(composed.modelWritten, false);
  assert.match(composed.error, /nothing usable/);
  assert.ok(composed.notes.k1, "the mechanical notes should still be there");
});

test("a model that throws leaves a usable document", async () => {
  const composed = await composeSlice({
    theme: THEME,
    entries: ENTRIES,
    model: async () => {
      throw new Error("HTTP 429");
    }
  });

  assert.equal(composed.modelWritten, false);
  assert.equal(composed.error, "HTTP 429");
  assert.ok(composed.synthesis.length, "a failed call must not leave the document blank");
});

test("a page the model skipped keeps a note anyway", async () => {
  const composed = await composeSlice({
    theme: THEME,
    entries: ENTRIES,
    model: async () => ({ content: JSON.stringify({ notes: { k1: "The specification." }, synthesis: "A thought." }) })
  });

  assert.equal(composed.modelWritten, true);
  assert.equal(composed.notes.k1, "The specification.");
  assert.ok(composed.notes.k2, "the other page must not end up with no note at all");
});
