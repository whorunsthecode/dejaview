/**
 * Which old thing, if any, is worth interrupting for.
 *
 * The bar is deliberately hard to clear. A nudge that lands wrong costs more
 * than a nudge that never comes, so every gate here defaults to silence:
 *
 *   - undated items never qualify. The claim being made is "you read this
 *     months ago", and without a first-visit date that claim cannot be made.
 *     It is never approximated from last access.
 *   - one shared word is not a relationship. Two are, or one that appears
 *     nowhere else in the corpus.
 *   - a theme the user has told us to stop suggesting decays geometrically,
 *     so ignoring something twice is enough to bury it.
 *
 * Scoring is lexical and local: no model call, no network, nothing leaves the
 * machine. A background feature that spent API credit on every page load would
 * be a different and much worse idea.
 */
import { historyUrl } from "../../shared/history.js";
import { candidateTerms } from "./topic.js";

export const DEFAULT_THRESHOLD = 0.3;
export const DEFAULT_MIN_AGE_DAYS = 30;

/** Two shared terms, or one the rest of the corpus does not use. */
export const MIN_SHARED_TERMS = 2;
const DISTINCTIVE_CORPUS = 10;

/** Each "less like this" on a theme multiplies its future confidence by this. */
export const SUPPRESSION_DECAY = 0.6;

const DAY = 86_400_000;

/**
 * Inverse document frequency over the candidate pool itself. The pool is what
 * the user actually reads, so "react" is rare or common relative to them, not
 * to the web.
 */
function idfOver(pool) {
  const df = new Map();
  for (const terms of pool.values()) {
    for (const term of new Set(terms)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const size = pool.size;
  return {
    df: (term) => df.get(term) ?? 0,
    idf: (term) => Math.log(1 + size / (1 + (df.get(term) ?? 0)))
  };
}

/** Join terms into readable prose without dragging in Intl.ListFormat. */
function list(terms) {
  const quoted = terms.map((t) => "“" + t + "”");
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length === 2) return quoted[0] + " and " + quoted[1];
  return quoted.slice(0, -1).join(", ") + " and " + quoted[quoted.length - 1];
}

/**
 * One sentence on why this old page relates to the page in front of you.
 *
 * It says only what was actually measured — which words overlap, and on what
 * surface — because a generated-sounding reason the user cannot check is how a
 * feature like this loses trust.
 */
export function explain(shared, triggerLabel) {
  const terms = shared.slice(0, 3);
  if (!terms.length) return "Related to what you have open.";
  return "Shares " + list(terms) + " with " + (triggerLabel || "this page") + ".";
}

/**
 * Rank every candidate against the topic, and say why each one did or did not
 * qualify. The caller takes the first eligible entry, if there is one.
 *
 * @param {object} opts
 * @param {{terms: string[]}} opts.topic
 * @param {object[]} opts.candidates  items with url, title, firstVisit
 * @param {number} opts.now
 * @param {number} [opts.minAgeDays]
 * @param {number} [opts.threshold]
 * @param {Record<string, number>} [opts.suppressed]  term -> "less like this" count
 * @param {Iterable<string>} [opts.shown]             item keys already nudged
 * @param {string} [opts.triggerUrl]
 * @returns {{key: string, candidate: object, confidence: number, shared: string[],
 *            ageDays: number|null, eligible: boolean, reason: string}[]}
 */
export function rankCandidates({
  topic,
  candidates = [],
  now = Date.now(),
  minAgeDays = DEFAULT_MIN_AGE_DAYS,
  threshold = DEFAULT_THRESHOLD,
  suppressed = {},
  shown = [],
  triggerUrl = ""
} = {}) {
  const topicTerms = [...new Set(topic?.terms ?? [])];
  const seenKeys = new Set(shown);
  const here = historyUrl(triggerUrl);

  const pool = new Map();
  for (const candidate of candidates) {
    const key = historyUrl(candidate?.url);
    if (!key || pool.has(key)) continue;
    pool.set(key, candidateTerms(candidate));
  }

  const { idf, df } = idfOver(pool);
  const ceiling = topicTerms.reduce((sum, term) => sum + idf(term), 0);

  const results = [];
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = historyUrl(candidate?.url);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, true);

    const terms = pool.get(key) ?? [];
    const termSet = new Set(terms);
    const shared = topicTerms.filter((term) => termSet.has(term));
    const score = shared.reduce((sum, term) => sum + idf(term), 0);

    const hits = shared.reduce((sum, term) => sum + (suppressed[term] ?? 0), 0);
    const confidence = ceiling > 0
      ? Math.min(1, score / ceiling) * Math.pow(SUPPRESSION_DECAY, hits)
      : 0;

    const firstVisit = Number.isFinite(candidate?.firstVisit) ? candidate.firstVisit : null;
    const ageDays = firstVisit === null ? null : (now - firstVisit) / DAY;
    const distinctive = shared.length === 1 && pool.size >= DISTINCTIVE_CORPUS && df(shared[0]) <= 1;

    let reason = "ok";
    if (here && key === here) reason = "the page you are on";
    else if (seenKeys.has(key)) reason = "already surfaced";
    else if (firstVisit === null) reason = "undated, so its age cannot be claimed";
    else if (ageDays < minAgeDays) reason = "read too recently";
    else if (shared.length < MIN_SHARED_TERMS && !distinctive) reason = "one shared word is not a relationship";
    else if (confidence < threshold) reason = "below the confidence threshold";

    results.push({
      key,
      candidate,
      confidence,
      shared,
      ageDays,
      eligible: reason === "ok",
      reason
    });
  }

  // Ties go to the older item: when two things are equally related, the one you
  // have forgotten harder is the better thing to be reminded of.
  results.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      (a.candidate.firstVisit ?? Infinity) - (b.candidate.firstVisit ?? Infinity) ||
      a.key.localeCompare(b.key)
  );
  return results;
}

/** The one to surface, or null when nothing cleared the bar. */
export function bestNudge(ranked) {
  return ranked.find((entry) => entry.eligible) ?? null;
}
