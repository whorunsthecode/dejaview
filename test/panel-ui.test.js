/**
 * Panel chrome: the icons and the accessible names that stand in for labels.
 *
 * An <svg><use> that points at a missing symbol renders nothing at all — no
 * error, no fallback, just an empty button. That is the failure worth a test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const PANEL = new URL("../extension/panel/panel.html", import.meta.url);

async function panelDocument() {
  const dom = new JSDOM(await readFile(PANEL, "utf8"), { url: "https://panel.example/" });
  return dom.window.document;
}

test("every icon reference resolves to a symbol that exists", async () => {
  const document = await panelDocument();
  const uses = [...document.querySelectorAll("use")];
  assert.ok(uses.length >= 5, "expected the export row to be iconified");

  for (const use of uses) {
    const href = use.getAttribute("href");
    assert.match(href, /^#/, "an icon must reference a symbol in this document");
    assert.ok(
      document.querySelector("symbol" + href),
      "no <symbol> for " + href + " — the button would render empty"
    );
  }
});

test("each export target has its own icon and an accessible name", async () => {
  const document = await panelDocument();

  for (const id of ["obsidian", "notion", "gdocs", "copy", "download"]) {
    const button = document.getElementById(id);
    assert.ok(button, "missing the " + id + " button");
    assert.ok(button.querySelector("svg use"), id + " has no icon");
    // Icon-only buttons carry no text, so the name has to come from somewhere.
    assert.ok(button.getAttribute("aria-label"), id + " has no accessible name");
    assert.ok(button.getAttribute("title"), id + " has no hover label");
  }
});

test("the three connectors each get a distinct mark", async () => {
  const document = await panelDocument();
  const iconOf = (id) => document.getElementById(id).querySelector("use").getAttribute("href");

  const marks = ["obsidian", "notion", "gdocs"].map(iconOf);
  assert.deepEqual(marks, ["#i-obsidian", "#i-notion", "#i-gdocs"]);
  assert.equal(new Set(marks).size, 3, "two connectors share an icon");
});

test("the sprite is a definition, not a visible picture", async () => {
  const document = await panelDocument();
  const sprite = document.querySelector("svg.sprite");
  assert.ok(sprite, "no sprite");
  assert.equal(sprite.getAttribute("aria-hidden"), "true");
  // It must sit outside every control, or the symbols would render inside one.
  assert.equal(sprite.closest("button"), null);
});

test("a failed export leaves the button's icon intact", async () => {
  const dom = new JSDOM(await readFile(PANEL, "utf8"), { url: "https://panel.example/" });
  const saved = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };

  try {
    const listeners = [];
    globalThis.document = dom.window.document;
    globalThis.fetch = async () => ({ json: async () => [], text: async () => "" });
    globalThis.chrome = {
      runtime: {
        getURL: (path) => path,
        onMessage: { addListener: (fn) => listeners.push(fn), removeListener() {} },
        // No key set, so nothing runs; the button state is all this test is after.
        sendMessage: async () => ({ ok: true, hasKey: true, tabCount: 0, windowCount: 0 })
      },
      // No Notion credentials: the export bails before any network call.
      storage: { local: { get: async () => ({}), set: async () => {} } }
    };

    const { MSG } = await import("../shared/messages.js");
    await import("../extension/panel/panel.js");

    // A finished skill, delivered the way the worker delivers one.
    for (const fn of listeners) fn({ type: MSG.SKILL, payload: { markdown: "# a skill\n" } }, {}, () => {});

    const notion = document.getElementById("notion");
    notion.dispatchEvent(new dom.window.Event("click"));

    // The handler awaits storage twice before it reports; poll rather than
    // guessing a tick count, so the assertions below cannot pass vacuously.
    for (let i = 0; i < 50 && !document.querySelector("#trace li.error"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    // Proves the handler actually ran, so the assertions below are not vacuous.
    assert.ok(
      document.querySelector("#trace li.error"),
      "the export never reported its missing credentials"
    );
    assert.ok(notion.querySelector("svg use"), "the icon was destroyed by the busy state");
    assert.equal(notion.disabled, false, "the button stayed disabled after failing");
    assert.equal(notion.classList.contains("busy"), false, "the spinner was left spinning");
  } finally {
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});
