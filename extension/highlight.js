/**
 * In-page highlighting.
 *
 * Exact string matching does not work here, for two independent reasons:
 *
 *   1. Entities and typography. A page carries &nbsp;, curly quotes, en dashes
 *      and soft hyphens where a quote carries plain ASCII.
 *   2. The DOM. "the device MUST NOT request tokens" lives in three text nodes
 *      once <em> wraps the middle of it, so it appears in none of them.
 *
 * So the page is flattened into one normalised character array that remembers
 * which (node, offset) each character came from. Matching happens on that flat
 * string; a hit maps straight back to real DOM positions, across elements.
 */

/** Injected alongside the highlighter so page CSP cannot suppress the mark. */
const HIGHLIGHT_CSS = [
  "mark.dejavu-highlight {",
  "  background: #fff3a3;",
  "  color: inherit;",
  "  padding: 0.05em 0;",
  "  border-radius: 2px;",
  "  box-shadow: 0 0 0 1px rgba(0,0,0,0.06);",
  "}"
].join("\n");

/**
 * Highlight quotes in one tab. Always resolves: a quote that cannot be found is
 * a normal outcome, and so is a tab that refuses injection.
 *
 * @param {number} tabId
 * @param {string[]} quotes verbatim passages, as returned by the agent
 * @returns {Promise<{ok: boolean, total: number, matched: number, missed: number, results?: {quote: string, matched: boolean}[], error?: string}>}
 */
export async function highlightTab(tabId, quotes) {
  const list = Array.isArray(quotes) ? quotes.filter((q) => typeof q === "string" && q.trim()) : [];
  if (!list.length) {
    return { ok: false, total: 0, matched: 0, missed: 0, error: "no usable quotes" };
  }

  try {
    // insertCSS rather than an inline style attribute: extension CSS is exempt
    // from the page's style-src, an inline attribute is not.
    await chrome.scripting.insertCSS({ target: { tabId }, css: HIGHLIGHT_CSS });

    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      func: highlightInPage,
      args: [list]
    });

    const result = frames?.[0]?.result;
    if (!result) {
      return { ok: false, total: list.length, matched: 0, missed: list.length, error: "injection returned no result" };
    }
    return result;
  } catch (err) {
    return {
      ok: false,
      total: list.length,
      matched: 0,
      missed: list.length,
      error: err?.message ?? String(err)
    };
  }
}

/**
 * Runs inside the page. chrome.scripting serializes this, so it closes over
 * nothing and declares every helper it needs inline.
 *
 * Exported so the test suite can run it against a jsdom document.
 *
 * @param {string[]} quotes
 */
export function highlightInPage(quotes) {
  const CLASS = "dejavu-highlight";

  // 1:1 character substitutions. Length-preserving, so the index map stays exact.
  const SUBSTITUTE = {
    "\u00a0": " ", "\u1680": " ", "\u2000": " ", "\u2001": " ", "\u2002": " ",
    "\u2003": " ", "\u2004": " ", "\u2005": " ", "\u2006": " ", "\u2007": " ",
    "\u2008": " ", "\u2009": " ", "\u200a": " ", "\u202f": " ", "\u205f": " ",
    "\u3000": " ",
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
    "\u00b4": "'", "`": "'",
    "\u201c": "\"", "\u201d": "\"", "\u201e": "\"", "\u201f": "\"", "\u2033": "\"",
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-",
    "\u2015": "-", "\u2212": "-",
    "\u2026": "."
  };

  // Dropped entirely: invisible characters that only ever break matching.
  const DROP = new Set(["\u200b", "\u200c", "\u200d", "\ufeff", "\u00ad"]);

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TITLE"]);

  // The NodeFilter constants, inlined. They are fixed by the DOM spec, and using
  // the numbers keeps this function dependent on `document` alone.
  const SHOW_TEXT = 0x4;
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;

  /** Lowercase without changing length — some locales expand on toLowerCase. */
  function lower(ch) {
    const l = ch.toLowerCase();
    return l.length === 1 ? l : ch;
  }

  function isSpace(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
  }

  function isWordChar(ch) {
    return /[\p{L}\p{N}]/u.test(ch);
  }

  function substitute(raw) {
    return Object.prototype.hasOwnProperty.call(SUBSTITUTE, raw) ? SUBSTITUTE[raw] : raw;
  }

  /**
   * Normalise one run of text, appending {node, offset, ch} per surviving char.
   * Runs of whitespace collapse to a single space, matching how HTML renders.
   */
  function absorb(text, node, chars) {
    let prevSpace = chars.length === 0 || chars[chars.length - 1].ch === " ";
    for (let i = 0; i < text.length; i++) {
      const raw = text[i];
      if (DROP.has(raw)) continue;
      let ch = substitute(raw);
      if (isSpace(ch)) {
        if (prevSpace) continue;
        prevSpace = true;
        ch = " ";
      } else {
        prevSpace = false;
        ch = lower(ch);
      }
      chars.push({ node, offset: i, ch });
    }
  }

  /** The same normalisation, for a quote, where no index map is needed. */
  function normaliseQuote(text) {
    const out = [];
    let prevSpace = true;
    for (const raw of text) {
      if (DROP.has(raw)) continue;
      let ch = substitute(raw);
      if (isSpace(ch)) {
        if (prevSpace) continue;
        prevSpace = true;
        ch = " ";
      } else {
        prevSpace = false;
        ch = lower(ch);
      }
      out.push(ch);
    }
    return out.join("").trim();
  }

  /** Every visible text character on the page, in document order. */
  function indexPage() {
    const chars = [];
    if (!document.body) return chars;
    const walker = document.createTreeWalker(document.body, SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return FILTER_REJECT;
        if (parent.hidden) return FILTER_REJECT;
        return node.data ? FILTER_ACCEPT : FILTER_REJECT;
      }
    });
    let node;
    while ((node = walker.nextNode())) absorb(node.data, node, chars);
    return chars;
  }

  /** Drop punctuation, keeping a map back into the strict index. */
  function loosen(chars) {
    let text = "";
    const map = [];
    let prevSpace = true;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i].ch;
      if (isWordChar(ch)) {
        text += ch;
        map.push(i);
        prevSpace = false;
      } else if (!prevSpace) {
        text += " ";
        map.push(i);
        prevSpace = true;
      }
    }
    return { text, map };
  }

  function loosenQuote(q) {
    let out = "";
    let prevSpace = true;
    for (const ch of q) {
      if (isWordChar(ch)) {
        out += ch;
        prevSpace = false;
      } else if (!prevSpace) {
        out += " ";
        prevSpace = true;
      }
    }
    return out.trim();
  }

  /** Longest common subsequence ratio, length-capped so cost stays bounded. */
  function similarity(a, b) {
    const CAP = 300;
    const x = a.slice(0, CAP);
    const y = b.slice(0, CAP);
    if (!x.length || !y.length) return 0;
    let prev = new Uint16Array(y.length + 1);
    let cur = new Uint16Array(y.length + 1);
    for (let i = 1; i <= x.length; i++) {
      for (let j = 1; j <= y.length; j++) {
        cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      const swap = prev;
      prev = cur;
      cur = swap;
      cur.fill(0);
    }
    return (2 * prev[y.length]) / (x.length + y.length);
  }

  /**
   * Locate a quote, in increasing order of desperation:
   * exact -> punctuation-insensitive -> anchored on a distinctive prefix.
   * @returns {[number, number]|null} inclusive range into `chars`
   */
  function locate(quote, strict, loose) {
    const q = normaliseQuote(quote);
    if (!q) return null;

    const exact = strict.indexOf(q);
    if (exact >= 0) return [exact, exact + q.length - 1];

    const ql = loosenQuote(q);
    if (ql) {
      const hit = loose.text.indexOf(ql);
      if (hit >= 0) return [loose.map[hit], loose.map[hit + ql.length - 1]];
    }

    // The quote may have drifted in the middle — anchor on its opening and
    // accept only if the span that follows is still substantially the same.
    const anchorLen = Math.min(48, Math.max(16, Math.floor(q.length / 3)));
    const anchor = q.slice(0, anchorLen);
    let from = strict.indexOf(anchor);
    while (from >= 0) {
      const end = Math.min(strict.length, from + q.length);
      if (similarity(strict.slice(from, end), q) >= 0.8) return [from, end - 1];
      from = strict.indexOf(anchor, from + 1);
    }
    return null;
  }

  /** Wrap an inclusive char range, splitting across every element it crosses. */
  function wrap(chars, from, to) {
    const spans = new Map();
    for (let i = from; i <= to; i++) {
      const { node, offset } = chars[i];
      const span = spans.get(node);
      if (!span) spans.set(node, [offset, offset]);
      else {
        if (offset < span[0]) span[0] = offset;
        if (offset > span[1]) span[1] = offset;
      }
    }

    const marks = [];
    for (const [node, [start, end]] of spans) {
      let target = node;
      if (end + 1 < target.data.length) target.splitText(end + 1);
      if (start > 0) target = target.splitText(start);
      const mark = document.createElement("mark");
      mark.className = CLASS;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      marks.push(mark);
    }
    return marks;
  }

  /** Undo a previous pass so repeated calls do not nest marks. */
  function clearExisting() {
    for (const mark of Array.from(document.querySelectorAll("mark." + CLASS))) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }

  try {
    clearExisting();

    const results = [];
    let firstMark = null;

    for (const quote of quotes) {
      // Re-index after each wrap: splitText invalidates the offsets held above.
      const chars = indexPage();
      const strict = chars.map((c) => c.ch).join("");
      const loose = loosen(chars);

      let matched = false;
      try {
        const range = locate(quote, strict, loose);
        if (range) {
          const marks = wrap(chars, range[0], range[1]);
          matched = marks.length > 0;
          if (matched && !firstMark) firstMark = marks[0];
        }
      } catch {
        // One unmatchable quote must never take down the rest.
        matched = false;
      }
      results.push({ quote, matched });
    }

    if (firstMark && typeof firstMark.scrollIntoView === "function") {
      firstMark.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    const matched = results.filter((r) => r.matched).length;
    return { ok: true, total: results.length, matched, missed: results.length - matched, results };
  } catch (err) {
    return { ok: false, total: quotes.length, matched: 0, missed: quotes.length, error: err?.message ?? String(err) };
  }
}
