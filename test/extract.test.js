/**
 * Text extraction.
 *
 * The in-page half runs against a real jsdom document and the real vendored
 * Readability, so "extraction succeeds on an article" is demonstrated rather
 * than mocked. The orchestration half runs against a fake chrome.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { readTab, readTabs, extractInPage, MAX_CHARS } from "../extension/extract.js";

// Chrome injects the vendored file as a classic script, where the top-level
// `function Readability` becomes a page global. Evaluating it inside the jsdom
// window reproduces that exactly — and proves the vendored file itself is sound,
// which importing the npm package instead would quietly skip.
const READABILITY_SRC = readFileSync(new URL("../extension/vendor/readability.js", import.meta.url), "utf8");

/** A jsdom window with Readability loaded the way a content script would see it. */
function pageFrom(html, url) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  dom.window.eval(READABILITY_SRC);
  return dom.window;
}

const PARAGRAPH =
  "The device MUST NOT request tokens more frequently than the interval specified in the " +
  "device authorization response. If the interval field is absent, clients use five seconds. " +
  "Upon receipt of the slow_down error, the client increases the polling interval by five " +
  "seconds for all subsequent requests, and ignoring that is what gets a device blocked. ";

function articlePage(paragraphs = 6) {
  const body = Array.from({ length: paragraphs }, () => "<p>" + PARAGRAPH + "</p>").join("\n");
  const html =
    "<!doctype html><html><head><title>RFC 8628: Device Authorization Grant</title></head>" +
    "<body><nav><a href='/'>home</a><a href='/specs'>specs</a></nav>" +
    "<article>" + body + "</article>" +
    "<footer>Copyright 2024. Subscribe to our newsletter!</footer></body></html>";
  return pageFrom(html, "https://datatracker.example/rfc8628");
}

/** Put a window's document and Readability where the injected function expects them. */
function inPage(win) {
  globalThis.document = win.document;
  globalThis.Readability = win.Readability;
}

test("extracts clean article text and reports ok", () => {
  inPage(articlePage());
  const out = extractInPage(MAX_CHARS);

  assert.equal(out.textStatus, "ok");
  assert.match(out.text, /device MUST NOT request tokens/);
  assert.match(out.title, /8628/);
  assert.doesNotMatch(out.text, /Subscribe to our newsletter/);
  assert.equal(out.truncated, false);
});

test("does not mutate the live document", () => {
  const win = articlePage();
  const doc = win.document;
  const before = doc.body.innerHTML;
  inPage(win);
  extractInPage(MAX_CHARS);
  assert.equal(doc.body.innerHTML, before);
});

test("truncates long articles on a boundary and flags it", () => {
  inPage(articlePage(60));
  const out = extractInPage(500);

  assert.equal(out.textStatus, "ok");
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 501, "length was " + out.text.length);
  assert.ok(out.text.endsWith("\u2026"));

  // The cut must land on a word boundary: the kept body is a prefix of the full
  // text, and the character it stopped before is whitespace, never mid-word.
  const full = extractInPage(Number.MAX_SAFE_INTEGER).text;
  const body = out.text.slice(0, -1);
  assert.ok(full.startsWith(body), "truncated text is not a prefix of the full text");
  assert.equal(full.charAt(body.length).trim(), "", "cut landed mid-word");
});

test("a blank app tab is empty, not an error", () => {
  const html =
    "<!doctype html><html><head><title>dashboard</title></head>" +
    "<body><div id='root'></div></body></html>";
  inPage(pageFrom(html, "https://app.example/"));

  const out = extractInPage(MAX_CHARS);
  assert.equal(out.textStatus, "empty");
  assert.equal(out.text, null);
});

test("a PDF is blocked before Readability is consulted", () => {
  globalThis.document = { contentType: "application/pdf", title: "spec.pdf" };
  globalThis.Readability = undefined;

  const out = extractInPage(MAX_CHARS);
  assert.equal(out.textStatus, "blocked");
  assert.equal(out.text, null);
  assert.match(out.error, /application\/pdf/);
});

test("a missing Readability global reports an error rather than throwing", () => {
  globalThis.document = new JSDOM("<p>hi</p>").window.document;
  globalThis.Readability = undefined;

  const out = extractInPage(MAX_CHARS);
  assert.equal(out.textStatus, "error");
  assert.match(out.error, /Readability failed to load/);
});

function installFakeChrome({ tabs = {}, onExecute } = {}) {
  const injected = [];
  globalThis.chrome = {
    tabs: {
      async get(id) {
        if (!tabs[id]) throw new Error("No tab with id: " + id);
        return tabs[id];
      }
    },
    scripting: {
      async executeScript(opts) {
        injected.push(opts);
        return onExecute(opts);
      }
    }
  };
  return injected;
}

const okResult = [{ result: { text: "clean text", textStatus: "ok", truncated: false } }];

test("readTab injects Readability before the extractor", async () => {
  const injected = installFakeChrome({
    tabs: { 1: { id: 1, url: "https://example.com/article" } },
    onExecute: (o) => (o.files ? [] : okResult)
  });

  const out = await readTab(1);
  assert.equal(out.textStatus, "ok");
  assert.equal(out.id, 1);
  assert.deepEqual(injected[0].files, ["extension/vendor/readability.js"]);
  assert.equal(typeof injected[1].func, "function");
});

test("a chrome:// tab is blocked without any injection attempt", async () => {
  const injected = installFakeChrome({
    tabs: { 2: { id: 2, url: "chrome://extensions" } },
    onExecute: () => {
      throw new Error("should never be called");
    }
  });

  const out = await readTab(2);
  assert.equal(out.textStatus, "blocked");
  assert.equal(out.text, null);
  assert.equal(injected.length, 0);
});

test("the chrome web store is blocked without any injection attempt", async () => {
  const injected = installFakeChrome({
    tabs: { 3: { id: 3, url: "https://chromewebstore.google.com/detail/abc" } },
    onExecute: () => {
      throw new Error("should never be called");
    }
  });

  assert.equal((await readTab(3)).textStatus, "blocked");
  assert.equal(injected.length, 0);
});

test("Chrome refusing to script a page maps to blocked, not error", async () => {
  installFakeChrome({
    tabs: { 4: { id: 4, url: "https://example.com/doc.pdf" } },
    onExecute: () => {
      throw new Error("Cannot access contents of the page. Extension manifest must request permission.");
    }
  });

  const out = await readTab(4);
  assert.equal(out.textStatus, "blocked");
  assert.match(out.error, /Cannot access/);
});

test("an unexpected injection failure is an error", async () => {
  installFakeChrome({
    tabs: { 5: { id: 5, url: "https://example.com/" } },
    onExecute: () => {
      throw new Error("Frame with ID 0 was removed");
    }
  });

  assert.equal((await readTab(5)).textStatus, "error");
});

test("a vanished tab is an error, not a crash", async () => {
  installFakeChrome({ tabs: {}, onExecute: () => okResult });
  const out = await readTab(999);
  assert.equal(out.textStatus, "error");
  assert.match(out.error, /No tab with id/);
});

test("one failure never stops the others in a batch", async () => {
  installFakeChrome({
    tabs: {
      1: { id: 1, url: "https://example.com/article" },
      2: { id: 2, url: "chrome://extensions" },
      3: { id: 3, url: "https://example.com/broken.pdf" },
      4: { id: 4, url: "https://example.com/second-article" }
    },
    onExecute: (o) => {
      if (o.target.tabId === 3) throw new Error("Cannot access contents of the page.");
      return o.files ? [] : okResult;
    }
  });

  const out = await readTabs([1, 2, 3, 4]);
  assert.deepEqual(
    out.map((r) => [r.id, r.textStatus]),
    [
      [1, "ok"],
      [2, "blocked"],
      [3, "blocked"],
      [4, "ok"]
    ]
  );
});

test("an injection that returns nothing is an error, not a silent ok", async () => {
  installFakeChrome({
    tabs: { 1: { id: 1, url: "https://example.com/" } },
    onExecute: (o) => (o.files ? [] : [{ result: undefined }])
  });

  const out = await readTab(1);
  assert.equal(out.textStatus, "error");
  assert.match(out.error, /no result/);
});
