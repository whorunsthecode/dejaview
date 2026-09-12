/**
 * Visualizer shaping and the Obsidian target.
 *
 * The counting is the part that can be quietly wrong — an undated tab folded
 * into the current year, or a missing hour dropped instead of drawn as a gap —
 * so it is checked here rather than eyeballed in the charts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  domainOf,
  topBy,
  topDomains,
  tabsByYear,
  tabsByGroup,
  tabSummary,
  visitsByHour,
  visitsByWeekday,
  historySummary,
  formatDay
} from "../extension/viz/stats.js";
import { obsidianTarget, chunkMarkdown, noteName, vaultPath, URI_LIMIT, MAX_CHUNKS } from "../extension/panel/export.js";

const MAR_2024 = 1710460800000;
const FEB_2024 = 1706745600000;

const tab = (over = {}) => ({
  id: 1,
  url: "https://example.com/a",
  title: "Example",
  windowId: 1,
  groupTitle: null,
  firstVisit: MAR_2024,
  ...over
});

// ---- domains ----------------------------------------------------------

test("domainOf drops the www noise", () => {
  assert.equal(domainOf("https://www.github.com/x"), "github.com");
  assert.equal(domainOf("https://developer.mozilla.org/en-US/"), "developer.mozilla.org");
});

test("domainOf returns null for a URL it cannot parse", () => {
  assert.equal(domainOf("not a url"), null);
  assert.equal(domainOf(""), null);
});

test("chrome:// pages still have a host and are not silently dropped", () => {
  assert.equal(domainOf("chrome://extensions"), "extensions");
});

// ---- counting ---------------------------------------------------------

test("topBy sorts by size and folds the tail into one bucket", () => {
  const rows = topBy(
    [
      { key: "a" }, { key: "a" }, { key: "a" },
      { key: "b" }, { key: "b" },
      { key: "c" }, { key: "d" }, { key: "e" }
    ],
    2
  );
  assert.deepEqual(rows.slice(0, 2), [
    { label: "a", value: 3 },
    { label: "b", value: 2 }
  ]);
  // c, d and e each had one, summed into a single labelled bucket.
  assert.deepEqual(rows[2], { label: "other", value: 3, isOther: true });
});

test("topBy does not invent an other bucket when everything fits", () => {
  const rows = topBy([{ key: "a" }, { key: "b" }], 8);
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((r) => r.isOther));
});

test("topDomains weights history items by their visit count", () => {
  const rows = topDomains([
    { url: "https://a.example/1", visitCount: 10 },
    { url: "https://b.example/1", visitCount: 3 },
    { url: "https://b.example/2", visitCount: 3 }
  ]);
  assert.deepEqual(rows, [
    { label: "a.example", value: 10 },
    { label: "b.example", value: 6 }
  ]);
});

// ---- tabs -------------------------------------------------------------

test("tabs are bucketed by the year of first visit, oldest first", () => {
  const rows = tabsByYear([
    tab({ firstVisit: MAR_2024 }),
    tab({ firstVisit: FEB_2024 }),
    tab({ firstVisit: Date.UTC(2025, 5, 1) })
  ]);
  assert.deepEqual(rows, [
    { label: "2024", value: 2 },
    { label: "2025", value: 1 }
  ]);
});

test("undated tabs get their own bucket, never folded into a year", () => {
  const rows = tabsByYear([tab({ firstVisit: MAR_2024 }), tab({ firstVisit: null })]);
  const undated = rows.find((r) => r.isUndated);
  assert.ok(undated, "undated bucket missing");
  assert.equal(undated.value, 1);
  assert.equal(rows.at(-1), undated, "undated must sit at the end, not inside the years");
});

test("a tab with no group is counted as ungrouped rather than dropped", () => {
  const rows = tabsByGroup([tab({ groupTitle: "auth" }), tab({ groupTitle: null })]);
  assert.deepEqual(rows.map((r) => r.label).sort(), ["auth", "ungrouped"]);
});

test("the tab summary counts distinct sites and windows", () => {
  const summary = tabSummary([
    tab({ url: "https://a.example/1", windowId: 1 }),
    tab({ url: "https://a.example/2", windowId: 1 }),
    tab({ url: "https://b.example/", windowId: 2, firstVisit: null })
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.domains, 2);
  assert.equal(summary.windows, 2);
  assert.equal(summary.undated, 1);
  assert.equal(summary.dated, 2);
});

test("the oldest tab is the earliest first visit, ignoring undated ones", () => {
  const summary = tabSummary([
    tab({ firstVisit: MAR_2024 }),
    tab({ firstVisit: FEB_2024 }),
    tab({ firstVisit: null })
  ]);
  assert.equal(summary.oldest, FEB_2024);
});

test("an all-undated set has no oldest rather than a fake one", () => {
  assert.equal(tabSummary([tab({ firstVisit: null })]).oldest, null);
});

// ---- history ----------------------------------------------------------

test("every hour is present even at zero, so gaps in the day stay visible", () => {
  const rows = visitsByHour([{ lastVisitTime: new Date(2024, 0, 1, 9).getTime() }]);
  assert.equal(rows.length, 24);
  assert.equal(rows[9].value, 1);
  assert.equal(rows[3].value, 0);
  assert.ok(rows.every((r) => typeof r.value === "number"));
});

test("hour buckets carry a readable label for the tooltip", () => {
  const rows = visitsByHour([]);
  assert.equal(rows[0].full, "12am");
  assert.equal(rows[13].full, "1pm");
  assert.equal(rows[9].label, "09");
});

test("every weekday is present even at zero", () => {
  const rows = visitsByWeekday([{ lastVisitTime: new Date(2024, 0, 3).getTime() }]);
  assert.equal(rows.length, 7);
  assert.equal(rows.map((r) => r.label)[0], "Sun");
  assert.equal(rows.reduce((n, r) => n + r.value, 0), 1);
});

test("items with no visit time are skipped, not counted as midnight", () => {
  const rows = visitsByHour([{ url: "https://x.example/" }, { lastVisitTime: null }]);
  assert.equal(rows.reduce((n, r) => n + r.value, 0), 0);
});

test("the history summary totals visits rather than pages", () => {
  const summary = historySummary([
    { url: "https://a.example/", visitCount: 10, lastVisitTime: FEB_2024 },
    { url: "https://a.example/2", visitCount: 5, lastVisitTime: MAR_2024 }
  ]);
  assert.equal(summary.pages, 2);
  assert.equal(summary.visits, 15);
  assert.equal(summary.domains, 1);
  assert.equal(summary.since, FEB_2024);
});

test("formatDay admits when there is no date", () => {
  assert.equal(formatDay(MAR_2024), "2024-03-15");
  assert.equal(formatDay(null), "unknown");
  assert.equal(formatDay(NaN), "unknown");
});

// ---- obsidian ---------------------------------------------------------

/** What Obsidian does with a parameter: percent-decode it, nothing more. */
function obsidianDecode(url, key) {
  const raw = new RegExp("[?&]" + key + "=([^&]*)").exec(url);
  return raw ? decodeURIComponent(raw[1]) : null;
}

test("the note name drops the extension and characters Obsidian refuses", () => {
  assert.equal(noteName("fix-device-flow-refresh.md"), "fix-device-flow-refresh");
  assert.equal(noteName("a/b:c*d?.md"), "a-b-c-d");
});

test("the note name never comes out empty", () => {
  assert.equal(noteName(".md"), "skill");
  assert.equal(noteName(""), "skill");
});

test("a folder is joined without leading or doubled slashes", () => {
  assert.equal(vaultPath("skills", "x"), "skills/x");
  assert.equal(vaultPath("/skills/", "x"), "skills/x");
  assert.equal(vaultPath("", "x"), "x");
  assert.equal(vaultPath(undefined, "x"), "x");
});

test("a short skill rides inside one obsidian:// URL", () => {
  const target = obsidianTarget({
    vault: "notes",
    folder: "skills",
    filename: "fix-device-flow-refresh.md",
    markdown: "# short"
  });
  assert.equal(target.mode, "uri");
  assert.equal(target.chunks, 1);
  assert.equal(target.path, "skills/fix-device-flow-refresh");
  assert.match(target.urls[0], /^obsidian:\/\/new\?/);
  assert.match(target.urls[0], /vault=notes/);
});

test("markdown is encoded, so a heading or newline cannot break the URL", () => {
  const markdown = "# Title\n\n- a & b\n";
  const target = obsidianTarget({ vault: "my notes", filename: "x.md", markdown });

  assert.doesNotMatch(target.urls[0], /\n/);
  assert.equal(obsidianDecode(target.urls[0], "content"), markdown);
  assert.equal(obsidianDecode(target.urls[0], "vault"), "my notes");
});

test("spaces are percent-encoded, never as +", () => {
  // URLSearchParams writes a space as "+", which is form-encoding. Obsidian
  // percent-decodes, so a "+" reaches the note as a literal plus and every space
  // in the skill becomes one. This is the bug that shipped.
  const target = obsidianTarget({
    vault: "my notes",
    folder: "my skills",
    filename: "fix the device flow.md",
    markdown: "one two three"
  });

  assert.match(target.urls[0], /vault=my%20notes/);
  assert.match(target.urls[0], /content=one%20two%20three/);
  assert.doesNotMatch(target.urls[0], /\+/, "a + anywhere means spaces arrive broken");
  assert.equal(obsidianDecode(target.urls[0], "file"), "my skills/fix the device flow");
});

test("a long skill is split across appends rather than truncated", () => {
  const markdown = readFileSync(new URL("../extension/panel/demo-skill.md", import.meta.url), "utf8");
  const target = obsidianTarget({ filename: "fix-device-flow-refresh.md", markdown });

  assert.equal(target.mode, "append");
  assert.ok(target.urls.length > 1, "expected the fixture to need more than one call");
});

test("every generated URL fits under the protocol handler ceiling", () => {
  // Windows cuts a protocol URL near 2048. The cut lands inside a percent-escape,
  // decoding throws, and Obsidian drops content entirely — a correctly named,
  // completely empty note. That is the bug this budget exists to prevent.
  assert.ok(URI_LIMIT <= 2048, "URI_LIMIT is above what Windows will pass through");

  for (const size of [10, 500, 2000, 5000, 12000]) {
    const target = obsidianTarget({
      vault: "notes",
      folder: "skills",
      filename: "x.md",
      markdown: "word ".repeat(Math.ceil(size / 5)).slice(0, size)
    });
    for (const url of target.urls) {
      assert.ok(url.length <= URI_LIMIT, size + " bytes produced a " + url.length + " char URL");
    }
  }
});

test("the chunks reassemble into exactly the original skill", () => {
  const markdown = readFileSync(new URL("../extension/panel/demo-skill.md", import.meta.url), "utf8");
  const target = obsidianTarget({ vault: "notes", filename: "x.md", markdown });

  const rebuilt = target.urls.map((u) => obsidianDecode(u, "content")).join("");
  assert.equal(rebuilt, markdown, "a chunk boundary lost or duplicated content");
});

test("only the first call creates the note; the rest append in order", () => {
  const markdown = "line of text here\n".repeat(400);
  const target = obsidianTarget({ vault: "notes", filename: "x.md", markdown });

  assert.ok(target.urls.length > 2);
  assert.doesNotMatch(target.urls[0], /append=true/, "the first call must create, not append");
  for (const url of target.urls.slice(1)) assert.match(url, /append=true/);
});

test("chunking splits on line breaks rather than mid-word", () => {
  const chunks = chunkMarkdown("alpha bravo\ncharlie delta\necho foxtrot\n".repeat(40), 300);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.endsWith("\n"), "chunk did not end on a line break");
  }
});

test("chunking never loses or duplicates a character", () => {
  const text = "alpha bravo\ncharlie delta\n".repeat(100);
  for (const budget of [120, 300, 900]) {
    assert.equal(chunkMarkdown(text, budget).join(""), text, "budget " + budget);
  }
});

test("a skill needing too many calls falls back to manual delivery", () => {
  const target = obsidianTarget({ vault: "notes", filename: "x.md", markdown: "x".repeat(200000) });

  assert.equal(target.mode, "manual");
  assert.deepEqual(target.urls, []);
  assert.ok(target.chunks > MAX_CHUNKS);
});

test("no vault is a valid target — Obsidian falls back to the last used one", () => {
  const target = obsidianTarget({ filename: "x.md", markdown: "body" });

  assert.equal(target.mode, "uri");
  assert.doesNotMatch(target.urls[0], /vault=/);
  assert.match(target.urls[0], /file=x/);
});
