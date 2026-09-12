/**
 * Visualizer shaping and the Obsidian target.
 *
 * The counting is the part that can be quietly wrong — an undated tab folded
 * into the current year, or a missing hour dropped instead of drawn as a gap —
 * so it is checked here rather than eyeballed in the charts.
 */
import test from "node:test";
import assert from "node:assert/strict";
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
import { obsidianTarget, noteName, vaultPath, URI_LIMIT } from "../extension/panel/export.js";

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

test("a short skill rides inside the obsidian:// URL", () => {
  const target = obsidianTarget({
    vault: "notes",
    folder: "skills",
    filename: "fix-device-flow-refresh.md",
    markdown: "# short"
  });
  assert.equal(target.mode, "uri");
  assert.equal(target.path, "skills/fix-device-flow-refresh");
  assert.match(target.url, /^obsidian:\/\/new\?/);
  assert.match(target.url, /vault=notes/);
  assert.match(target.url, /content=/);
});

test("a long skill goes via the clipboard instead of being truncated", () => {
  const target = obsidianTarget({
    vault: "notes",
    filename: "big.md",
    markdown: "x".repeat(URI_LIMIT + 1)
  });
  assert.equal(target.mode, "clipboard");
  assert.doesNotMatch(target.url, /content=/, "content must not ride a URL this long");
  assert.match(target.url, /append=true/);
});

test("markdown is encoded, so a heading or newline cannot break the URL", () => {
  const target = obsidianTarget({
    vault: "my notes",
    filename: "x.md",
    markdown: "# Title\n\n- a & b\n"
  });
  assert.equal(target.mode, "uri");
  assert.doesNotMatch(target.url, /\n/);
  assert.match(target.url, /vault=my\+notes|vault=my%20notes/);
  // Round-trips back to exactly what went in.
  const content = new URL(target.url).searchParams.get("content");
  assert.equal(content, "# Title\n\n- a & b\n");
});

test("no vault is a valid target — Obsidian falls back to the last used one", () => {
  const target = obsidianTarget({ filename: "x.md", markdown: "body" });
  assert.equal(target.mode, "uri");
  assert.doesNotMatch(target.url, /vault=/);
  assert.match(target.url, /file=x/);
});
