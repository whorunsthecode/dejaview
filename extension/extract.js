/**
 * Text extraction, on demand only.
 *
 * Nothing here runs during enumeration. The agent picks which tabs are worth
 * opening from titles, URLs and dates alone, and that choice is the whole point
 * of the product — extracting everything up front would both destroy the demo
 * and inject a script into every tab the user has open.
 *
 * Readability is injected as a vendored file rather than imported, because
 * chrome.scripting runs it inside the target page, not in this worker.
 */

/** Roughly a page of prose. Enough to reason over, small enough to keep costs sane. */
export const MAX_CHARS = 6000;

/** Schemes and pages chrome.scripting can never touch. */
const NEVER_INJECTABLE =
  /^(chrome|chrome-extension|chrome-untrusted|about|devtools|data|blob|edge|brave|view-source):/i;

/** Chrome refuses injection into its own web store regardless of host permissions. */
const WEBSTORE = /^https:\/\/chromewebstore\.google\.com\//i;

const READABILITY_FILE = "extension/vendor/readability.js";

/**
 * Read one tab's readable text.
 *
 * Always resolves. A tab that cannot be read is a normal outcome, not an
 * exception: the caller is usually part way through a batch and a thrown error
 * would take the rest of it down.
 *
 * @param {number} tabId
 * @param {{maxChars?: number}} [opts]
 * @returns {Promise<{id: number, text: string|null, textStatus: "ok"|"empty"|"blocked"|"error", error?: string, truncated?: boolean, title?: string|null, byline?: string|null}>}
 */
export async function readTab(tabId, opts = {}) {
  const maxChars = opts.maxChars ?? MAX_CHARS;

  // Cheap pre-check: skip the injection round trip for pages we know are closed
  // to us, so a window full of chrome:// tabs costs nothing.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.discarded || tab?.frozen || (tab?.pendingUrl && tab.pendingUrl !== tab.url)) {
      return { id: tabId, text: null, textStatus: 'blocked', error: 'Page is unloaded or navigating; open it manually before reading.' };
    }
    const url = tab?.url || tab?.pendingUrl || "";
    if (NEVER_INJECTABLE.test(url) || WEBSTORE.test(url)) {
      return { id: tabId, text: null, textStatus: "blocked", error: `cannot inject into ${url.split(":")[0]}: pages` };
    }
  } catch (err) {
    return { id: tabId, text: null, textStatus: "error", error: message(err) };
  }

  try {
    // Readability first: it defines the global the extractor below depends on.
    await chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true, files: [READABILITY_FILE] });

    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: extractInPage,
      args: [maxChars]
    });

    const result = frames?.[0]?.result;
    if (!result) {
      return { id: tabId, text: null, textStatus: "error", error: "injection returned no result" };
    }
    return { id: tabId, ...result };
  } catch (err) {
    // Chrome rejects injection into PDFs, the web store, pages the user has not
    // granted, and tabs that navigated away mid-call.
    return { id: tabId, text: null, textStatus: statusForInjectionFailure(err), error: message(err) };
  }
}

/**
 * Read several tabs without letting one failure end the batch.
 * @param {number[]} tabIds
 * @param {{maxChars?: number}} [opts]
 */
export async function readTabs(tabIds, opts = {}) {
  const settled = await Promise.allSettled(tabIds.map((id) => readTab(id, opts)));
  return settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { id: tabIds[i], text: null, textStatus: "error", error: message(outcome.reason) }
  );
}

/**
 * Runs inside the target page.
 *
 * chrome.scripting serializes this function and re-parses it in the page, so it
 * may close over nothing — only its arguments and page globals. `Readability`
 * is one of those globals, put there by the file injected just before it.
 *
 * Exported so the test suite can run it against a jsdom document.
 *
 * @param {number} maxChars
 */
export function extractInPage(maxChars) {
  const CLEAN = (s) => s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  try {
    // Chrome renders PDFs in a plugin document with no extractable text.
    if (document.contentType && document.contentType !== "text/html" && document.contentType !== "application/xhtml+xml") {
      return { text: null, textStatus: "blocked", error: `cannot read ${document.contentType}` };
    }

    if (typeof Readability !== "function") {
      return { text: null, textStatus: "error", error: "Readability failed to load" };
    }

    // parse() mutates the document it is given, so it must never see the live
    // one — that would visibly destroy the page the user is looking at.
    const article = new Readability(document.cloneNode(true)).parse();
    const text = CLEAN(article?.textContent ?? "");

    if (!text) {
      // A live app shell with no prose in it. Not a failure, just nothing to read.
      return { text: null, textStatus: "empty", title: article?.title ?? document.title ?? null };
    }

    const truncated = text.length > maxChars;
    let out = text;
    if (truncated) {
      // Prefer a paragraph break, then a sentence, then a word, so the cut does
      // not land mid-word and read as corruption.
      const window_ = text.slice(0, maxChars);
      const at = Math.max(window_.lastIndexOf("\n\n"), window_.lastIndexOf(". "), window_.lastIndexOf(" "));
      out = (at > maxChars * 0.5 ? window_.slice(0, at) : window_).trimEnd() + "…";
    }

    return {
      text: out,
      textStatus: "ok",
      truncated,
      title: article?.title ?? null,
      byline: article?.byline ?? null
    };
  } catch (err) {
    return { text: null, textStatus: "error", error: err?.message ?? String(err) };
  }
}

/** Injection failures that are really "this page is closed to us". */
function statusForInjectionFailure(err) {
  const m = message(err).toLowerCase();
  const closed =
    m.includes("cannot be scripted") ||
    m.includes("cannot access") ||
    m.includes("chrome pages") ||
    m.includes("extensions gallery") ||
    m.includes("showing error page") ||
    m.includes("pdf");
  return closed ? "blocked" : "error";
}

function message(err) {
  return err?.message ?? String(err);
}
