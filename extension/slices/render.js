/**
 * The slice itself: one self-contained Markdown document.
 *
 * Self-contained means it survives being pasted anywhere — no relative links,
 * no assets, no reference to the extension that made it. Somebody who receives
 * it should be able to read it without knowing where it came from.
 *
 * It is also the only artifact here that leaves the machine, so it says plainly
 * what it is: how many pages, over what span, and whether the prose in it was
 * written by a model or assembled mechanically. A reader who cannot tell those
 * apart will trust the wrong half.
 */
import { dayOf } from "./review.js";

/** Markdown link text: the brackets are what break a title. */
function linkText(title) {
  return String(title ?? "").replace(/[[\]]/g, "\\$&").replace(/\s+/g, " ").trim();
}

/**
 * A URL safe in a Markdown link. Parentheses inside one end the link early,
 * which silently truncates the address.
 */
function linkHref(url) {
  const href = String(url ?? "").trim();
  return /[()\s]/.test(href) ? "<" + href + ">" : href;
}

/** Quote a passage, keeping its line breaks as block-quote lines. */
function blockquote(text) {
  return String(text)
    .split(/\n/)
    .map((line) => "> " + line.trim())
    .join("\n");
}

/** "12 March 2024 · example.com", with whatever is actually known. */
function meta(entry) {
  const parts = [];
  parts.push(entry.date ? "First read " + entry.date : "First read: unknown");
  if (entry.domain) parts.push(entry.domain);
  return parts.join(" · ");
}

/**
 * Render the document.
 *
 * @param {object} slice
 * @param {string} slice.title
 * @param {string} slice.intro
 * @param {object[]} slice.entries          the chosen items, in order
 * @param {{label: string, keys: string[]}[]} [slice.groups]  sub-themes, when found
 * @param {Record<string, string>} [slice.notes]  key -> one sentence on why
 * @param {string} [slice.synthesis]
 * @param {boolean} [slice.modelWritten]    whether a model wrote the prose
 * @param {number} [slice.generatedAt]
 * @returns {string}
 */
export function renderSlice({
  title,
  intro = "",
  entries = [],
  groups = null,
  notes = {},
  synthesis = "",
  modelWritten = false,
  modelLabel = "a language model",
  generatedAt = Date.now()
} = {}) {
  const lines = ["# " + (String(title ?? "").trim() || "A slice of my reading"), ""];

  const lede = String(intro ?? "").trim();
  if (lede) lines.push(lede, "");

  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const written = new Set();

  // Grouped when the model found groupings worth having; otherwise one flat run.
  const sections = usableGroups(groups, byKey)
    ? groups.map((group) => ({ label: group.label, keys: group.keys.filter((k) => byKey.has(k)) }))
    : [{ label: null, keys: entries.map((entry) => entry.key) }];

  for (const section of sections) {
    const itemLevel = section.label ? "###" : "##";
    if (section.label) lines.push("## " + section.label, "");

    for (const key of section.keys) {
      if (written.has(key)) continue;
      written.add(key);
      lines.push(...renderEntry(byKey.get(key), notes[key], itemLevel));
    }
  }

  // Anything a grouping forgot still goes in. Losing a page the user explicitly
  // kept would be the worst bug this file could have.
  const missed = entries.filter((entry) => !written.has(entry.key));
  if (missed.length) {
    if (sections.some((s) => s.label)) lines.push("## Also in this slice", "");
    for (const entry of missed) lines.push(...renderEntry(entry, notes[entry.key], sections.some((s) => s.label) ? "###" : "##"));
  }

  const closing = String(synthesis ?? "").trim();
  if (closing) lines.push("## What this adds up to", "", closing, "");

  lines.push("---", "", provenance(entries, modelWritten, modelLabel, generatedAt), "");
  return lines.join("\n");
}

function renderEntry(entry, note, level) {
  if (!entry) return [];
  const out = [level + " [" + linkText(entry.title) + "](" + linkHref(entry.url) + ")", "", "*" + meta(entry) + "*", ""];

  const why = String(note ?? "").trim();
  if (why) out.push(why, "");

  if (entry.passage) out.push(blockquote(entry.passage), "");
  return out;
}

/** A grouping is only worth using if it covers most of the slice. */
function usableGroups(groups, byKey) {
  if (!Array.isArray(groups) || groups.length < 2) return false;
  const covered = new Set();
  for (const group of groups) {
    if (!group?.label || !Array.isArray(group.keys)) return false;
    for (const key of group.keys) if (byKey.has(key)) covered.add(key);
  }
  return covered.size >= byKey.size * 0.6;
}

/**
 * The footer. Dates are earliest *retained* visits, which is not the same as
 * the first time the page was ever read, and saying so costs one line.
 */
function provenance(entries, modelWritten, modelLabel, generatedAt) {
  const dates = entries.map((entry) => entry.firstVisit).filter(Number.isFinite);
  const span = dates.length
    ? "read between " + dayOf(Math.min(...dates)) + " and " + dayOf(Math.max(...dates))
    : "with no dates available";
  const undated = entries.length - dates.length;

  const parts = [
    entries.length + " page" + (entries.length === 1 ? "" : "s") + ", " + span + ".",
    undated ? undated + " of them could not be dated." : "",
    "Dates are the earliest visit still in browser history, which may be later than the first time the page was read.",
    modelWritten
      ? "Grouping and commentary written by " + modelLabel + " from the quoted passages."
      : "Assembled without a model: the notes below each link describe the overlap that put it here, and nothing is interpreted.",
    "Generated " + dayOf(generatedAt) + "."
  ].filter(Boolean);

  return "*" + parts.join(" ") + "*";
}
