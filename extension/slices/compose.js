/**
 * The prose in a slice: the sub-theme grouping, the one-line note under each
 * link, and the closing synthesis.
 *
 * A model writes these when there is one. When there is not — no key, a failed
 * call, a reply that does not validate — the slice is still produced, but the
 * prose is assembled mechanically and the document says so in its footer. The
 * one thing this file must never do is produce a sentence that sounds like a
 * conclusion when nothing concluded it.
 *
 * The model is given titles, domains, dates and the passages already extracted.
 * It is not given page text, and it cannot ask for any.
 */
import { candidateTerms } from "../rediscovery/topic.js";

/** Grouping is optional. Under this many items it is noise. */
export const MIN_ITEMS_TO_GROUP = 5;

/** A note is one sentence; anything longer is the model padding. */
const MAX_NOTE_CHARS = 220;
const MAX_SYNTHESIS_CHARS = 900;
const MAX_LABEL_CHARS = 60;

const SYSTEM = [
  "You organise someone's own saved reading into a short shareable document.",
  "",
  "You are given the pages they chose, each with a key, title, domain, first-read date",
  "and — where one exists — a passage already extracted from that page.",
  "",
  "Return JSON only, with exactly these fields:",
  '  groups:    [{ "label": string, "keys": [string] }]',
  "             Sub-themes, only if the set genuinely falls into two or more of them.",
  "             Return [] when it does not. Never invent a grouping to fill the field.",
  "             Every key must appear in exactly one group, and every key must be one",
  "             you were given.",
  '  notes:     { "<key>": string }  one sentence per page saying why it belongs in',
  "             this collection. Ground it in that page's own title or passage.",
  "             Never speculate about what a page says if you were given no passage.",
  '  synthesis: string  two to four sentences on what the collection adds up to:',
  "             what the reader was circling, where it changed, what is missing.",
  "             Say the collection is thin if it is thin.",
  "",
  "Do not praise the reader. Do not invent facts that are not in the material."
].join("\n");

/** The compact view of the slice the model is allowed to see. */
export function modelPayload({ theme, entries }) {
  return {
    theme: theme?.label ?? "",
    items: entries.map((entry) => ({
      key: entry.key,
      title: entry.title,
      domain: entry.domain,
      first_read: entry.date,
      passage: entry.passage ?? null
    }))
  };
}

/**
 * Keep only what validates. A model that hallucinates a key, drops half the
 * set, or writes a paragraph where a sentence was asked for should degrade the
 * document, not corrupt it.
 */
export function sanitize(reply, entries) {
  const valid = new Set(entries.map((entry) => entry.key));
  const text = (value, max) =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

  const groups = [];
  const placed = new Set();
  for (const group of Array.isArray(reply?.groups) ? reply.groups : []) {
    const label = text(group?.label, MAX_LABEL_CHARS);
    const keys = (Array.isArray(group?.keys) ? group.keys : [])
      .filter((key) => valid.has(key) && !placed.has(key));
    if (!label || !keys.length) continue;
    for (const key of keys) placed.add(key);
    groups.push({ label, keys });
  }

  const notes = {};
  for (const [key, value] of Object.entries(reply?.notes ?? {})) {
    if (!valid.has(key)) continue;
    const note = text(value, MAX_NOTE_CHARS);
    if (note) notes[key] = note;
  }

  return {
    // One group is not a grouping; fall back to a flat list.
    groups: groups.length >= 2 ? groups : [],
    notes,
    synthesis: text(reply?.synthesis, MAX_SYNTHESIS_CHARS)
  };
}

/**
 * What the document says when no model wrote it.
 *
 * Every sentence here is a count or an overlap — something that can be checked
 * against the list above it. It reads flatter than model prose on purpose.
 */
export function fallbackCompose({ theme, entries }) {
  const themeTerms = new Set(theme?.terms ?? []);

  const notes = {};
  for (const entry of entries) {
    const shared = candidateTerms(entry).filter((term) => themeTerms.has(term)).slice(0, 3);
    notes[entry.key] = shared.length
      ? "Here for " + shared.join(", ") + "."
      : "Kept in this slice by hand.";
  }

  const domains = new Set(entries.map((entry) => entry.domain).filter(Boolean));
  const quoted = entries.filter((entry) => entry.passage).length;
  const dated = entries.map((entry) => entry.firstVisit).filter(Number.isFinite);
  const years = new Set(dated.map((ms) => new Date(ms).getFullYear()));

  const sentences = [
    entries.length + " pages from " + domains.size + " site" + (domains.size === 1 ? "" : "s") + ", " +
      (years.size > 1 ? "read across " + years.size + " different years" : "read within one year") + "."
  ];
  if (quoted < entries.length) {
    const missing = entries.length - quoted;
    sentences.push(
      missing === 1
        ? "One of them is listed without a quote, because it was never read in full."
        : missing + " of them are listed without a quote, because they were never read in full."
    );
  }
  sentences.push("This summary was assembled without a language model, so it counts what is here rather than drawing a conclusion from it.");

  return { groups: [], notes, synthesis: sentences.join(" "), modelWritten: false };
}

/**
 * Ask the model, and fall back cleanly.
 *
 * @param {object} opts
 * @param {object} opts.theme
 * @param {object[]} opts.entries
 * @param {(req: object) => Promise<{content?: string}>} [opts.model]
 * @returns {Promise<{groups: object[], notes: object, synthesis: string,
 *                    modelWritten: boolean, error: string|null}>}
 */
export async function composeSlice({ theme, entries = [], model = null } = {}) {
  const fallback = fallbackCompose({ theme, entries });
  if (!model || !entries.length) return { ...fallback, error: model ? null : "no model available" };

  try {
    const message = await model({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(modelPayload({ theme, entries })) }
      ],
      responseFormat: { type: "json_object" },
      maxOutputTokens: 2048
    });

    const parsed = JSON.parse(message?.content ?? "{}");
    const clean = sanitize(parsed, entries);

    // A reply with nothing usable in it is a failed call, not a result.
    if (!clean.synthesis && !Object.keys(clean.notes).length) {
      return { ...fallback, error: "the model returned nothing usable" };
    }

    return {
      groups: entries.length >= MIN_ITEMS_TO_GROUP ? clean.groups : [],
      // Any page the model skipped keeps its mechanical note rather than none.
      notes: { ...fallback.notes, ...clean.notes },
      synthesis: clean.synthesis || fallback.synthesis,
      modelWritten: true,
      error: null
    };
  } catch (error) {
    return { ...fallback, error: error?.message ?? String(error) };
  }
}
