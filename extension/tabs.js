/**
 * Tab enumeration and dating.
 *
 * A tab has no open date of its own — Chrome does not record when you opened it.
 * The closest available proxy is the earliest retained visit to the URL, which
 * may be later than its actual first-ever visit. That is what dates a tab here.
 *
 * When history has nothing (incognito, cleared history, a URL that never goes to
 * history at all) firstVisit is null. It is never guessed, and never backfilled
 * from lastAccessed: a tab opened in 2024 and touched this morning would come out
 * looking new, which is the one thing this project cannot afford to get wrong.
 */
import { isTab } from "../shared/types.js";

/** chrome.tabGroups.TAB_GROUP_ID_NONE, inlined so this module can be tested in node. */
const NO_GROUP = -1;

/** Schemes history never records, so there is no point asking about them. */
const NEVER_IN_HISTORY = /^(chrome|chrome-extension|chrome-untrusted|about|devtools|data|blob|edge|brave):/i;

/** Schemes a content script can never be injected into, so text will never arrive. */
const NEVER_READABLE = /^(chrome|chrome-extension|chrome-untrusted|about|devtools|data|blob|edge|brave|view-source):/i;

/**
 * Every open tab in every window, shaped to the Tab contract in shared/types.js.
 *
 * History and group lookups are cached per call: duplicate tabs of one URL are
 * common, and every tab in a group would otherwise re-fetch the same group.
 *
 * @returns {Promise<import("../shared/types.js").Tab[]>}
 */
export async function listTabs() {
  const raw = await chrome.tabs.query({});
  const visits = new Map();
  const groups = new Map();

  return Promise.all(
    raw
      .filter((t) => typeof t.id === "number")
      .map((t) => toTab(t, visits, groups))
  );
}

/**
 * @param {any} t chrome.tabs.Tab
 * @returns {Promise<import("../shared/types.js").Tab>}
 */
export async function toTab(t, visits = new Map(), groups = new Map()) {
  // A tab still loading carries pendingUrl and no url yet.
  const url = t.url || t.pendingUrl || "";

  const [groupTitle, firstVisit] = await Promise.all([
    titleOfGroup(t.groupId, groups),
    firstVisitOf(url, visits)
  ]);

  return {
    id: t.id,
    url,
    title: t.title || url,
    windowId: t.windowId,
    groupTitle,
    firstVisit,
    // lastAccessed is Chrome 121+; the manifest floor guarantees it. 0 is a
    // deliberately obvious sentinel if some build omits it anyway.
    lastAccessed: typeof t.lastAccessed === "number" ? t.lastAccessed : 0,
    text: null,
    // No text has been fetched yet. The contract has no "unread" state, so a tab
    // we could never read is "blocked" and everything else is "empty" until
    // read_tab replaces it.
    textStatus: NEVER_READABLE.test(url) ? "blocked" : "empty"
  };
}

/**
 * Earliest recorded visit for a URL, or null when history has nothing.
 *
 * The cache holds the in-flight promise, not the resolved value: every tab is
 * dated concurrently, so caching only on completion would let N tabs sharing one
 * URL all miss the cache and fire N identical history lookups.
 *
 * @returns {Promise<number|null>}
 */
function firstVisitOf(url, cache) {
  if (!url || NEVER_IN_HISTORY.test(url)) return Promise.resolve(null);
  if (!cache.has(url)) cache.set(url, fetchFirstVisit(url));
  return cache.get(url);
}

/** @returns {Promise<number|null>} */
async function fetchFirstVisit(url) {
  let earliest = null;
  try {
    // getVisits matches the URL exactly, fragments and query string included.
    const found = await chrome.history.getVisits({ url });
    for (const visit of found ?? []) {
      if (typeof visit.visitTime !== "number") continue;
      if (earliest === null || visit.visitTime < earliest) earliest = visit.visitTime;
    }
  } catch {
    // Incognito, cleared history, or a URL history refuses to answer for.
    earliest = null;
  }
  return earliest;
}

/**
 * Title of a tab's group, or null when ungrouped or the group is unnamed.
 * Caches the in-flight promise for the same reason firstVisitOf does.
 * @returns {Promise<string|null>}
 */
function titleOfGroup(groupId, cache) {
  if (typeof groupId !== "number" || groupId === NO_GROUP) return Promise.resolve(null);
  if (!cache.has(groupId)) cache.set(groupId, fetchGroupTitle(groupId));
  return cache.get(groupId);
}

/** @returns {Promise<string|null>} */
async function fetchGroupTitle(groupId) {
  try {
    const group = await chrome.tabGroups.get(groupId);
    // An unnamed group reports "", which is not a title.
    return group?.title ? group.title : null;
  } catch {
    return null;
  }
}

/**
 * Split a tab list by whether history could date it.
 * @param {import("../shared/types.js").Tab[]} tabs
 */
export function countDated(tabs) {
  const dated = tabs.filter((t) => t.firstVisit !== null).length;
  return { total: tabs.length, dated, undated: tabs.length - dated };
}

/**
 * Check every tab against the shared contract. Returns the failures rather than
 * throwing, so one malformed tab cannot take down a whole enumeration.
 * @param {import("../shared/types.js").Tab[]} tabs
 * @returns {{id: unknown, error: string}[]}
 */
export function contractViolations(tabs) {
  const bad = [];
  for (const tab of tabs) {
    try {
      isTab(tab);
    } catch (err) {
      bad.push({ id: tab?.id, error: err?.message ?? String(err) });
    }
  }
  return bad;
}

/** ms-epoch to a readable day, or the word the UI should show instead. */
export function formatFirstVisit(firstVisit) {
  return firstVisit === null ? "undated" : new Date(firstVisit).toISOString().slice(0, 10);
}
