/**
 * In-page highlighting, against real jsdom documents.
 *
 * The three fixtures are deliberately unlike each other, because each breaks
 * naive matching in a different way:
 *
 *   docs    — inline <code>/<em> split the quote across text nodes
 *   rfc     — <pre> hard-wraps mid-sentence, so the quote contains newlines
 *   blog    — curly quotes, &nbsp; and an em dash where the quote has ASCII
 */
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { highlightInPage, highlightTab } from "../extension/highlight.js";

const DOCS_HTML = [
  "<!doctype html><html><body><article>",
  "<h1>Using the Fetch API</h1>",
  "<p>A <code>fetch()</code> promise <em>does not reject</em> on HTTP errors.",
  "Instead, a <code>then()</code> handler must check the <code>Response.ok</code> property.</p>",
  "</article></body></html>"
].join("\n");

const RFC_HTML = [
  "<!doctype html><html><body><pre>",
  "   The device MUST NOT request tokens more frequently than the",
  "   interval specified in the device authorization response.  If the",
  "   interval field is absent, clients MUST use five seconds.",
  "</pre></body></html>"
].join("\n");

const BLOG_HTML = [
  "<!doctype html><html><body><article><p>",
  "The team&nbsp;I worked with in 1998 had a rule I have never forgotten &mdash; when we",
  "could not decide between two designs, we shipped the one we &ldquo;knew was worse&rdquo;,",
  "on purpose, because the worse one taught us the constraint we didn&rsquo;t know we had.",
  "</p></article></body></html>"
].join("\n");

/** Point the injected function at a jsdom document, with scrollIntoView stubbed. */
function inPage(html) {
  const dom = new JSDOM(html, { url: "https://fixture.example/" });
  const scrolled = [];
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView(opts) {
    scrolled.push({ el: this, opts });
  };
  globalThis.document = dom.window.document;
  return { dom, scrolled };
}

function marks(dom) {
  return Array.from(dom.window.document.querySelectorAll("mark.dejavu-highlight"));
}

/** The visible text of all marks, whitespace-collapsed. */
function markedText(dom) {
  return marks(dom)
    .map((m) => m.textContent.replace(/\s+/g, " "))
    .join("|");
}

// ---- the acceptance case: three quotes, three different sites ---------------

test("a quote split across inline elements lands", () => {
  const { dom } = inPage(DOCS_HTML);
  const out = highlightInPage(["A fetch() promise does not reject on HTTP errors."]);

  assert.equal(out.matched, 1, JSON.stringify(out.results));
  // It spans <code> and <em>, so it cannot be one mark.
  assert.ok(marks(dom).length >= 3, "expected the match to span several elements");
  assert.match(markedText(dom).replace(/\|/g, ""), /fetch\(\) promise does not reject/);
});

test("a quote hard-wrapped across lines in a <pre> lands", () => {
  const { dom } = inPage(RFC_HTML);
  // The agent quotes it as one line; the page has it across three.
  const out = highlightInPage([
    "The device MUST NOT request tokens more frequently than the interval specified in the device authorization response."
  ]);

  assert.equal(out.matched, 1, JSON.stringify(out.results));
  assert.match(markedText(dom), /device MUST NOT request tokens/);
});

test("a quote with curly quotes, nbsp and an em dash lands against ASCII", () => {
  const { dom } = inPage(BLOG_HTML);
  const out = highlightInPage([
    'The team I worked with in 1998 had a rule I have never forgotten - when we could not decide between two designs, we shipped the one we "knew was worse", on purpose'
  ]);

  assert.equal(out.matched, 1, JSON.stringify(out.results));
  assert.match(markedText(dom), /knew was worse/);
});

test("three quotes across the three fixtures all land in one pass each", () => {
  const cases = [
    [DOCS_HTML, "a then() handler must check the Response.ok property"],
    [RFC_HTML, "If the interval field is absent, clients MUST use five seconds."],
    [BLOG_HTML, "the worse one taught us the constraint we didn't know we had"]
  ];

  for (const [html, quote] of cases) {
    inPage(html);
    const out = highlightInPage([quote]);
    assert.equal(out.matched, 1, "failed on: " + quote);
  }
});

// ---- the other half of the acceptance case ----------------------------------

test("a quote that is not on the page is skipped silently", () => {
  const { dom } = inPage(DOCS_HTML);
  const out = highlightInPage(["This sentence appears nowhere on the page whatsoever."]);

  assert.equal(out.ok, true);
  assert.equal(out.matched, 0);
  assert.equal(out.missed, 1);
  assert.equal(marks(dom).length, 0);
  assert.equal(out.results[0].matched, false);
});

test("a missing quote does not stop the ones around it", () => {
  const { dom } = inPage(DOCS_HTML);
  const out = highlightInPage([
    "nowhere to be found at all",
    "must check the Response.ok property",
    "also entirely absent from this document"
  ]);

  assert.equal(out.ok, true);
  assert.deepEqual(
    out.results.map((r) => r.matched),
    [false, true, false]
  );
  assert.equal(marks(dom).length >= 1, true);
});

// ---- behaviour --------------------------------------------------------------

test("the first match is scrolled into view, and only the first", () => {
  const { scrolled } = inPage(RFC_HTML);
  highlightInPage([
    "interval field is absent",
    "The device MUST NOT request tokens"
  ]);

  assert.equal(scrolled.length, 1);
  assert.equal(scrolled[0].opts.block, "center");
});

test("nothing is scrolled when nothing matched", () => {
  const { scrolled } = inPage(RFC_HTML);
  const out = highlightInPage(["not present anywhere"]);
  assert.equal(out.matched, 0);
  assert.equal(scrolled.length, 0);
});

test("running twice does not nest or duplicate marks", () => {
  const { dom } = inPage(RFC_HTML);
  const quote = "clients MUST use five seconds";

  highlightInPage([quote]);
  const first = marks(dom).length;
  highlightInPage([quote]);
  const second = marks(dom).length;

  assert.equal(second, first, "second pass changed the mark count");
  assert.equal(dom.window.document.querySelectorAll("mark mark").length, 0, "marks nested");
});

test("the page text is unchanged by highlighting", () => {
  const { dom } = inPage(BLOG_HTML);
  const before = dom.window.document.body.textContent;
  highlightInPage(["we shipped the one we"]);
  assert.equal(dom.window.document.body.textContent, before);
});

test("script and style contents are never matched", () => {
  const html = [
    "<!doctype html><html><body>",
    "<script>var secret = 'findMeInScript';</script>",
    "<style>.x { color: findMeInStyle; }</style>",
    "<p>ordinary body text</p>",
    "</body></html>"
  ].join("\n");
  const { dom } = inPage(html);

  const out = highlightInPage(["findMeInScript", "findMeInStyle", "ordinary body text"]);
  assert.deepEqual(
    out.results.map((r) => r.matched),
    [false, false, true]
  );
  assert.equal(marks(dom).length, 1);
});

test("a quote drifting in the middle still anchors", () => {
  inPage(RFC_HTML);
  // "five" swapped for "5" — close enough that the anchor plus similarity holds.
  const out = highlightInPage([
    "If the interval field is absent, clients MUST use 5 seconds."
  ]);
  assert.equal(out.matched, 1, JSON.stringify(out.results));
});

test("a quote sharing only an opening phrase is rejected, not force-matched", () => {
  inPage(RFC_HTML);
  const out = highlightInPage([
    "The device MUST NOT be painted blue, nor shall it be fed after midnight under any circumstances at all"
  ]);
  assert.equal(out.matched, 0);
});

test("empty and non-string quotes are ignored without throwing", () => {
  inPage(DOCS_HTML);
  const out = highlightInPage(["", "   "]);
  assert.equal(out.ok, true);
  assert.equal(out.matched, 0);
});

// ---- worker side ------------------------------------------------------------

function installFakeChrome({ onExecute, onCss } = {}) {
  const calls = { css: [], exec: [] };
  globalThis.chrome = {
    scripting: {
      async insertCSS(opts) {
        calls.css.push(opts);
        if (onCss) return onCss(opts);
      },
      async executeScript(opts) {
        calls.exec.push(opts);
        return onExecute(opts);
      }
    }
  };
  return calls;
}

test("highlightTab injects CSS then the highlighter", async () => {
  const calls = installFakeChrome({
    onExecute: () => [{ result: { ok: true, total: 1, matched: 1, missed: 0, results: [] } }]
  });

  const out = await highlightTab(7, ["a quote"]);
  assert.equal(out.matched, 1);
  assert.equal(calls.css.length, 1);
  assert.match(calls.css[0].css, /dejavu-highlight/);
  assert.equal(calls.exec[0].target.tabId, 7);
  assert.deepEqual(calls.exec[0].args, [["a quote"]]);
});

test("highlightTab drops unusable quotes before injecting", async () => {
  const calls = installFakeChrome({ onExecute: () => [{ result: { ok: true } }] });
  const out = await highlightTab(7, ["", null, 42, "   "]);

  assert.equal(out.ok, false);
  assert.match(out.error, /no usable quotes/);
  assert.equal(calls.exec.length, 0);
});

test("a tab that refuses injection resolves rather than throwing", async () => {
  installFakeChrome({
    onExecute: () => {
      throw new Error("Cannot access contents of the page.");
    }
  });

  const out = await highlightTab(7, ["a quote"]);
  assert.equal(out.ok, false);
  assert.equal(out.missed, 1);
  assert.match(out.error, /Cannot access/);
});
