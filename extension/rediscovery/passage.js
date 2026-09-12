/**
 * Landing on the passage, not just the page.
 *
 * Reopening a 4000-word article at the top is barely better than a bookmark, so
 * a nudge links with a text fragment — `#:~:text=` — which Chrome scrolls to and
 * highlights without the extension touching the page at all.
 *
 * Two constraints shape this file:
 *   - the passage must be text that is really in the page, taken from what was
 *     already extracted. An invented or paraphrased quote silently fails to
 *     match, and the link lands at the top with no explanation.
 *   - the fragment directive delimiters have to be escaped, or a comma or a
 *     hyphen inside the quote is parsed as syntax and the match breaks.
 */

/** Long enough to be unambiguous, short enough that a reflow does not break it. */
export const MAX_PASSAGE_CHARS = 280;

/** Below this a "sentence" is a heading fragment or a stray label. */
const MIN_SENTENCE_CHARS = 30;

/** Past this length, link a range (start,end) rather than one long literal. */
const RANGE_ABOVE = 90;

/**
 * Pick the sentence of `text` that best matches the topic.
 *
 * @param {string|null} text  extracted page text, or null when none was cached
 * @param {string[]} terms
 * @returns {string|null} null when nothing matches — the caller then links the
 *   page plainly rather than to a passage that is not really there.
 */
export function bestPassage(text, terms = []) {
  const body = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!body || !terms.length) return null;

  const sentences = body.split(/(?<=[.!?])\s+/).filter((s) => s.length >= MIN_SENTENCE_CHARS);
  if (!sentences.length) return null;

  const wanted = [...new Set(terms.map((t) => t.toLowerCase()))];

  let best = null;
  let bestScore = 0;
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const score = wanted.filter((term) => lower.includes(term)).length;
    // First match wins a tie: earlier in the document is usually more central.
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }

  if (!best) return null;
  return trimTo(best, MAX_PASSAGE_CHARS);
}

/** Cut at a word boundary; a fragment ending mid-word will not match the page. */
function trimTo(text, max) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return text.slice(0, cut > max * 0.5 ? cut : max).trim();
}

/**
 * Percent-encode a fragment term.
 *
 * encodeURIComponent leaves `-` and `,` alone, and both are directive syntax:
 * a comma would split the term into a range, and a double hyphen ends the
 * directive. `&` separates directives.
 */
export function encodeFragment(text) {
  return encodeURIComponent(text)
    .replace(/-/g, "%2D")
    .replace(/,/g, "%2C")
    .replace(/&/g, "%26");
}

/**
 * A URL that opens the page scrolled to `passage`.
 *
 * A long passage is linked as a range — the first words, a comma, the last
 * words — which survives the page re-wrapping or an ad being injected in the
 * middle, where one long literal would not.
 *
 * @param {string} url
 * @param {string|null} passage
 * @returns {string} the URL unchanged when there is no usable passage
 */
export function fragmentUrl(url, passage) {
  const text = String(passage ?? "").replace(/\s+/g, " ").trim();
  if (!text) return url;

  let base;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return url;
    // An existing fragment is dropped: two `:~:` directives do not compose.
    parsed.hash = "";
    base = parsed.href;
  } catch {
    return url;
  }

  if (text.length <= RANGE_ABOVE) {
    return base + "#:~:text=" + encodeFragment(text);
  }

  const words = text.split(" ");
  const start = words.slice(0, 6).join(" ");
  const end = words.slice(-6).join(" ");
  // Six words at each end of a short-ish passage can overlap; one literal then
  // describes it exactly, and a range would match nothing.
  if (start.length + end.length >= text.length) {
    return base + "#:~:text=" + encodeFragment(text);
  }
  return base + "#:~:text=" + encodeFragment(start) + "," + encodeFragment(end);
}
