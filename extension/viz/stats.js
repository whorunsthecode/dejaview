/**
 * Shaping functions for the visualizer.
 *
 * Pure on purpose: every one takes plain arrays and returns plain arrays, so the
 * counting can be tested without a browser, and the drawing code never has to
 * think about dates or URLs.
 */

/** Registrable-ish host, with the www. noise dropped. */
export function domainOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * Count values into {label, value} rows, biggest first, with a tail folded into
 * "other" rather than invented as extra colours.
 *
 * @param {Iterable<{key: string|null, weight?: number}>} entries
 * @param {number} limit
 */
export function topBy(entries, limit = 8) {
  const counts = new Map();
  for (const { key, weight = 1 } of entries) {
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + weight);
  }

  const sorted = [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  if (sorted.length <= limit) return sorted;

  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit).reduce((sum, row) => sum + row.value, 0);
  if (tail > 0) head.push({ label: "other", value: tail, isOther: true });
  return head;
}

/** Top domains across tabs or history items. */
export function topDomains(items, limit = 8) {
  return topBy(
    items.map((item) => ({ key: domainOf(item.url), weight: item.visitCount ?? 1 })),
    limit
  );
}

/**
 * Open tabs bucketed by the year you first opened the URL.
 *
 * Undated tabs get their own bucket at the end rather than being dropped or
 * quietly folded into the current year — how many tabs history cannot date is
 * itself worth seeing.
 */
export function tabsByYear(tabs) {
  const years = new Map();
  let undated = 0;

  for (const tab of tabs) {
    if (typeof tab.firstVisit !== "number") {
      undated += 1;
      continue;
    }
    const year = String(new Date(tab.firstVisit).getFullYear());
    years.set(year, (years.get(year) ?? 0) + 1);
  }

  const rows = [...years.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label));

  if (undated) rows.push({ label: "undated", value: undated, isUndated: true });
  return rows;
}

/** How many tabs sit in each named group; ungrouped counted together. */
export function tabsByGroup(tabs, limit = 8) {
  return topBy(
    tabs.map((tab) => ({ key: tab.groupTitle || "ungrouped" })),
    limit
  );
}

/** Headline counts for the stat row. */
export function tabSummary(tabs) {
  const dated = tabs.filter((t) => typeof t.firstVisit === "number");
  const oldest = dated.reduce(
    (min, t) => (min === null || t.firstVisit < min ? t.firstVisit : min),
    null
  );
  return {
    total: tabs.length,
    dated: dated.length,
    undated: tabs.length - dated.length,
    domains: new Set(tabs.map((t) => domainOf(t.url)).filter(Boolean)).size,
    windows: new Set(tabs.map((t) => t.windowId)).size,
    oldest
  };
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Visits bucketed by hour of day. Every hour is present even at zero, because a
 * gap in the day is the shape worth seeing and dropping empty bars would hide it.
 *
 * @param {{lastVisitTime?: number}[]} items
 */
export function visitsByHour(items) {
  const counts = new Array(24).fill(0);
  for (const item of items) {
    if (typeof item.lastVisitTime !== "number") continue;
    counts[new Date(item.lastVisitTime).getHours()] += 1;
  }
  return HOURS.map((h) => ({
    label: String(h).padStart(2, "0"),
    value: counts[h],
    full: hourLabel(h)
  }));
}

function hourLabel(h) {
  const suffix = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return twelve + suffix;
}

/** Visits bucketed by weekday, Sunday first, zeros kept. */
export function visitsByWeekday(items) {
  const counts = new Array(7).fill(0);
  for (const item of items) {
    if (typeof item.lastVisitTime !== "number") continue;
    counts[new Date(item.lastVisitTime).getDay()] += 1;
  }
  return WEEKDAYS.map((label, i) => ({ label, value: counts[i] }));
}

/** Headline counts for the history stat row. */
export function historySummary(items) {
  const visits = items.reduce((sum, item) => sum + (item.visitCount ?? 0), 0);
  const times = items.map((i) => i.lastVisitTime).filter((t) => typeof t === "number");
  return {
    pages: items.length,
    visits,
    domains: new Set(items.map((i) => domainOf(i.url)).filter(Boolean)).size,
    since: times.length ? Math.min(...times) : null
  };
}

/** A day, or the honest absence of one. */
export function formatDay(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "unknown";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
}
