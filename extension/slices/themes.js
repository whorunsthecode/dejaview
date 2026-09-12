/**
 * Themes: the groupings a slice can be exported from.
 *
 * There was no "interest map" in this extension, so this is it — the smallest
 * honest one. A theme is a set of pages that share distinctive words, built
 * over the same inverted-index terms the rest of the extension already uses.
 *
 * Two rules keep it from inventing structure:
 *
 *   - a tab group the user named beats anything inferred. They already said
 *     what that pile is about; guessing over the top of it would be rude and
 *     usually worse.
 *   - pages that fall into no theme are left out, not swept into an "other"
 *     bucket. A theme nobody would recognise is not a theme.
 *
 * Pure, so the clustering can be argued with in tests.
 */
import { historyUrl } from "../../shared/history.js";
import { candidateTerms } from "../rediscovery/topic.js";

/** Fewer pages than this is a coincidence, not an interest. */
export const MIN_THEME_SIZE = 3;

/** A user-named tab group is a theme at a lower bar: they already said so. */
export const MIN_GROUP_SIZE = 2;

/** More than this and the page becomes a list rather than a map. */
export const MAX_THEMES = 8;

/** A term in over half of everything describes the user, not a theme. */
const UBIQUITOUS = 0.5;

const titleCase = (text) =>
  text.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Group items into themes.
 *
 * @param {{url: string, title: string, groupTitle?: string|null, firstVisit?: number|null}[]} items
 * @returns {{id: string, label: string, source: "group"|"terms", terms: string[],
 *            items: object[], size: number}[]}
 */
export function clusterThemes(items = [], { minSize = MIN_THEME_SIZE, maxThemes = MAX_THEMES } = {}) {
  // Canonical URLs, so two tabs on the same page are one page.
  const byKey = new Map();
  for (const item of items) {
    const key = historyUrl(item?.url);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, { ...item, key, terms: candidateTerms(item) });
  }

  // A theme may only be named after a word a person wrote — a title, or a group
  // they named. Hostname words are fine for deciding membership but make
  // terrible subjects: cluster on them and you get a theme called "example",
  // "medium" or "substack", which describes where you read, not what about.
  const nameable = new Set();
  for (const item of byKey.values()) {
    for (const term of candidateTerms({ title: item.title, groupTitle: item.groupTitle, url: "" })) {
      nameable.add(term);
    }
  }

  const pool = [...byKey.values()];
  const claimed = new Set();
  const themes = [];

  // ---- what the user already filed ----
  const groups = new Map();
  for (const item of pool) {
    const name = (item.groupTitle ?? "").trim();
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }

  for (const [name, members] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (members.length < MIN_GROUP_SIZE) continue;
    themes.push(makeTheme("group:" + name, name, "group", members, nameable));
    for (const item of members) claimed.add(item.key);
  }

  // ---- what the words say ----
  const df = new Map();
  for (const item of pool) {
    for (const term of new Set(item.terms)) df.set(term, (df.get(term) ?? 0) + 1);
  }

  // The ceiling drops terms that describe the reader rather than a subject. It
  // can never fall below the floor, or in a small set of tabs every candidate
  // seed would be both too rare and too common at once, and nothing would group.
  const ceiling = Math.max(minSize, pool.length * UBIQUITOUS);

  const seeds = [...df.entries()]
    .filter(([term, count]) => nameable.has(term) && count >= minSize && count <= ceiling)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => term);

  for (const seed of seeds) {
    if (themes.length >= maxThemes) break;
    const members = pool.filter((item) => !claimed.has(item.key) && item.terms.includes(seed));
    if (members.length < minSize) continue;

    themes.push(makeTheme("term:" + seed, labelFor(seed, members, nameable), "terms", members, nameable));
    for (const item of members) claimed.add(item.key);
  }

  return themes
    .sort((a, b) => b.size - a.size || a.label.localeCompare(b.label))
    .slice(0, maxThemes);
}

/**
 * Name a theme after its seed plus whatever else most of it has in common.
 * "device flow" reads like a subject; "device" alone reads like a word.
 */
function labelFor(seed, members, nameable) {
  const counts = new Map();
  for (const item of members) {
    for (const term of new Set(item.terms)) {
      if (term === seed || !nameable.has(term)) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }

  const partner = [...counts.entries()]
    .filter(([, count]) => count >= members.length * 0.6)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  return titleCase(partner ? seed + " " + partner[0] : seed);
}

function makeTheme(id, label, source, members, nameable = null) {
  const counts = new Map();
  for (const item of members) {
    for (const term of new Set(item.terms)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => term);

  // The theme's terms go on to pick passages and to explain why each page is
  // here, so hostname words are dropped: "here for device, example" reads as
  // though the site name were the subject. If that leaves nothing, keep what
  // there is rather than shipping a theme with no terms at all.
  const written = nameable ? ranked.filter((term) => nameable.has(term)) : ranked;
  const terms = (written.length ? written : ranked).slice(0, 6);

  const dates = members.map((m) => m.firstVisit).filter(Number.isFinite);

  return {
    id,
    label,
    source,
    terms,
    items: members.map(({ terms: _terms, ...item }) => item),
    size: members.length,
    // Undated members are simply absent from the span, never assumed to be recent.
    span: dates.length ? { from: Math.min(...dates), to: Math.max(...dates) } : null,
    undated: members.length - dates.length
  };
}
