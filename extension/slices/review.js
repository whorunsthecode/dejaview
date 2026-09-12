/**
 * The review screen's model.
 *
 * Nothing is generated until the user confirms, so this file's job is to show
 * them exactly what would go in — every item, its date, and the passage that
 * would be quoted from it — with the sensitive ones already switched off and
 * counted out loud.
 *
 * Pure: it is handed the passages rather than fetching them, so the review can
 * be tested without a browser and cannot read a page as a side effect.
 */
import { historyUrl } from "../../shared/history.js";
import { domainOf } from "../viz/stats.js";
import { bestPassage } from "../rediscovery/passage.js";
import { partition } from "./sensitive.js";

/** Why an item has no quotable passage. Both are shown; neither is hidden. */
export const PASSAGE_STATUS = Object.freeze({
  quoted: "quoted",
  unread: "never read, so there is nothing to quote",
  nomatch: "read, but nothing in it matches the theme"
});

/** ms epoch to a plain day, or the honest absence of one. */
export function dayOf(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * Build the review.
 *
 * @param {object} opts
 * @param {{label: string, terms: string[], id?: string}} opts.theme
 * @param {object[]} opts.items          pages the theme covers
 * @param {Map<string, string|null>} [opts.passages]  canonical url -> extracted text
 * @param {string[]} [opts.extraDomains] the user's own exclusions
 * @returns {{title: string, intro: string, theme: object, entries: object[], summary: object}}
 */
export function buildReview({ theme, items = [], passages = new Map(), extraDomains = [] } = {}) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = historyUrl(item?.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...item, key });
  }

  const { flagged, count, byCategory } = partition(unique, extraDomains);
  const reasons = new Map(flagged.map((entry) => [historyUrl(entry.item.url), entry.reason]));

  const terms = theme?.terms ?? [];
  const entries = unique.map((item) => {
    const text = passages.get(item.key) ?? null;
    const passage = text ? bestPassage(text, terms) : null;
    const excluded = reasons.get(item.key) ?? null;

    return {
      key: item.key,
      url: item.url,
      title: item.title || item.url,
      domain: domainOf(item.url) ?? "unknown",
      firstVisit: Number.isFinite(item.firstVisit) ? item.firstVisit : null,
      date: dayOf(item.firstVisit),
      passage,
      passageStatus: passage
        ? PASSAGE_STATUS.quoted
        : text
          ? PASSAGE_STATUS.nomatch
          : PASSAGE_STATUS.unread,
      // Sensitive items arrive switched off, but present and explained.
      included: excluded === null,
      autoExcluded: excluded !== null,
      excludedReason: excluded
    };
  });

  return {
    title: theme?.label ? "Reading on " + theme.label : "A slice of my reading",
    intro: "",
    theme: { id: theme?.id ?? null, label: theme?.label ?? "", terms },
    entries,
    summary: summarize(entries, { autoExcluded: count, byCategory })
  };
}

/** Counts for the header of the review screen. */
export function summarize(entries = [], { autoExcluded = 0, byCategory = {} } = {}) {
  const included = entries.filter((e) => e.included);
  return {
    total: entries.length,
    included: included.length,
    excluded: entries.length - included.length,
    autoExcluded,
    byCategory,
    quoted: included.filter((e) => e.passage).length,
    unread: included.filter((e) => e.passageStatus === PASSAGE_STATUS.unread).length,
    undated: included.filter((e) => e.date === null).length
  };
}

/** Flip one item, returning a new review rather than mutating the old one. */
export function withToggle(review, key, included) {
  const entries = review.entries.map((entry) =>
    entry.key === key ? { ...entry, included: included ?? !entry.included } : entry
  );
  return { ...review, entries, summary: summarize(entries, review.summary) };
}

/** The items that would actually be written, in the order they are shown. */
export function chosen(review) {
  return review.entries.filter((entry) => entry.included);
}

/** Pages the user would have to read before they could be quoted. */
export function unreadKeys(review) {
  return chosen(review)
    .filter((entry) => entry.passageStatus === PASSAGE_STATUS.unread)
    .map((entry) => entry.key);
}
