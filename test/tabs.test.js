/**
 * Tab enumeration and dating, against a fake chrome.
 *
 * The rule under test is the one the whole product rests on: a tab's date comes
 * from the EARLIEST recorded visit to its URL, and is null rather than guessed
 * when history has nothing to say.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isTab } from "../shared/types.js";
import { listTabs, countDated, contractViolations, formatFirstVisit } from "../extension/tabs.js";

const MAR_2024 = 1710460800000;
const JAN_2024 = 1706745600000;
const SEP_2025 = 1757600000000;

/**
 * @param {object} opts
 * @param {any[]} opts.tabs        what chrome.tabs.query resolves to
 * @param {Record<string, any>} [opts.history]  url -> visit array, or a thrown Error
 * @param {Record<number, any>} [opts.groups]   groupId -> group, or a thrown Error
 */
function installFakeChrome({ tabs, history = {}, groups = {} }) {
  const calls = { getVisits: [], groupGet: [] };
  globalThis.chrome = {
    tabs: { query: async () => tabs },
    history: {
      async getVisits({ url }) {
        calls.getVisits.push(url);
        const entry = history[url];
        if (entry instanceof Error) throw entry;
        return entry ?? [];
      }
    },
    tabGroups: {
      async get(id) {
        calls.groupGet.push(id);
        const entry = groups[id];
        if (entry instanceof Error) throw entry;
        if (!entry) throw new Error(`No group with id: ${id}`);
        return entry;
      }
    }
  };
  return calls;
}

/** A chrome.tabs.Tab with sane defaults. */
function fakeTab(over = {}) {
  return {
    id: 1,
    url: "https://example.com/",
    title: "Example",
    windowId: 1,
    groupId: -1,
    lastAccessed: SEP_2025,
    ...over
  };
}

test("firstVisit is the earliest visit, not the most recent", async () => {
  installFakeChrome({
    tabs: [fakeTab({ url: "https://rfc.example/8628" })],
    history: {
      "https://rfc.example/8628": [
        { visitTime: SEP_2025 },
        { visitTime: MAR_2024 }, // earliest, out of order on purpose
        { visitTime: SEP_2025 + 86400000 }
      ]
    }
  });
  const [tab] = await listTabs();
  assert.equal(tab.firstVisit, MAR_2024);
});

test("a tab history has never seen is undated, not guessed", async () => {
  installFakeChrome({ tabs: [fakeTab()], history: {} });
  const [tab] = await listTabs();
  assert.equal(tab.firstVisit, null);
  assert.equal(formatFirstVisit(tab.firstVisit), "undated");
});

test("firstVisit never falls back to lastAccessed", async () => {
  // The failure this guards: an old tab touched today looking brand new.
  installFakeChrome({ tabs: [fakeTab({ lastAccessed: SEP_2025 })], history: {} });
  const [tab] = await listTabs();
  assert.equal(tab.firstVisit, null);
  assert.notEqual(tab.firstVisit, tab.lastAccessed);
});

test("a history lookup that throws yields null rather than failing the run", async () => {
  installFakeChrome({
    tabs: [fakeTab({ url: "https://blocked.example/" })],
    history: { "https://blocked.example/": new Error("incognito") }
  });
  const [tab] = await listTabs();
  assert.equal(tab.firstVisit, null);
});

test("visits with no visitTime are ignored", async () => {
  installFakeChrome({
    tabs: [fakeTab()],
    history: { "https://example.com/": [{}, { visitTime: MAR_2024 }] }
  });
  const [tab] = await listTabs();
  assert.equal(tab.firstVisit, MAR_2024);
});

test("group titles are attached, and unnamed or ungrouped tabs get null", async () => {
  installFakeChrome({
    tabs: [
      fakeTab({ id: 1, groupId: 7 }),
      fakeTab({ id: 2, groupId: 8 }),
      fakeTab({ id: 3, groupId: -1 })
    ],
    groups: {
      7: { id: 7, title: "auth" },
      8: { id: 8, title: "" } // user never named it
    }
  });
  const tabs = await listTabs();
  assert.equal(tabs[0].groupTitle, "auth");
  assert.equal(tabs[1].groupTitle, null);
  assert.equal(tabs[2].groupTitle, null);
});

test("history and group lookups are cached, not repeated per tab", async () => {
  const calls = installFakeChrome({
    tabs: [
      fakeTab({ id: 1, url: "https://same.example/", groupId: 7 }),
      fakeTab({ id: 2, url: "https://same.example/", groupId: 7 }),
      fakeTab({ id: 3, url: "https://same.example/", groupId: 7 })
    ],
    history: { "https://same.example/": [{ visitTime: MAR_2024 }] },
    groups: { 7: { id: 7, title: "auth" } }
  });
  const tabs = await listTabs();
  assert.equal(tabs.length, 3);
  assert.deepEqual(calls.getVisits, ["https://same.example/"]);
  assert.deepEqual(calls.groupGet, [7]);
});

test("chrome:// tabs are blocked, undated, and never sent to history", async () => {
  const calls = installFakeChrome({ tabs: [fakeTab({ url: "chrome://extensions" })] });
  const [tab] = await listTabs();
  assert.equal(tab.textStatus, "blocked");
  assert.equal(tab.firstVisit, null);
  assert.deepEqual(calls.getVisits, []);
});

test("an ordinary tab is readable-but-unread until read_tab runs", async () => {
  installFakeChrome({ tabs: [fakeTab()] });
  const [tab] = await listTabs();
  assert.equal(tab.text, null);
  assert.equal(tab.textStatus, "empty");
});

test("a still-loading tab falls back to pendingUrl", async () => {
  installFakeChrome({
    tabs: [fakeTab({ url: undefined, pendingUrl: "https://loading.example/", title: undefined })],
    history: { "https://loading.example/": [{ visitTime: JAN_2024 }] }
  });
  const [tab] = await listTabs();
  assert.equal(tab.url, "https://loading.example/");
  assert.equal(tab.title, "https://loading.example/");
  assert.equal(tab.firstVisit, JAN_2024);
});

test("tabs with no id are dropped", async () => {
  installFakeChrome({ tabs: [fakeTab({ id: undefined }), fakeTab({ id: 2 })] });
  const tabs = await listTabs();
  assert.deepEqual(tabs.map((t) => t.id), [2]);
});

test("every enumerated tab satisfies the shared Tab contract", async () => {
  installFakeChrome({
    tabs: [
      fakeTab({ id: 1, url: "https://a.example/", groupId: 7 }),
      fakeTab({ id: 2, url: "chrome://extensions", groupId: -1 }),
      fakeTab({ id: 3, url: undefined, pendingUrl: "https://c.example/" }),
      fakeTab({ id: 4, lastAccessed: undefined })
    ],
    history: { "https://a.example/": [{ visitTime: MAR_2024 }] },
    groups: { 7: { id: 7, title: "auth" } }
  });
  const tabs = await listTabs();
  assert.equal(tabs.length, 4);
  for (const tab of tabs) assert.doesNotThrow(() => isTab(tab), `tab ${tab.id}`);
  assert.deepEqual(contractViolations(tabs), []);
});

test("countDated splits dated from undated", async () => {
  installFakeChrome({
    tabs: [
      fakeTab({ id: 1, url: "https://a.example/" }),
      fakeTab({ id: 2, url: "https://b.example/" }),
      fakeTab({ id: 3, url: "https://c.example/" })
    ],
    history: {
      "https://a.example/": [{ visitTime: MAR_2024 }],
      "https://b.example/": [{ visitTime: JAN_2024 }]
    }
  });
  assert.deepEqual(countDated(await listTabs()), { total: 3, dated: 2, undated: 1 });
});

test("contractViolations reports a bad tab without throwing", () => {
  const bad = contractViolations([{ id: 9, url: "https://x.example/" }]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].id, 9);
  assert.match(bad[0].error, /missing field/);
});

test("formatFirstVisit renders a day, or the word undated", () => {
  assert.equal(formatFirstVisit(MAR_2024), "2024-03-15");
  assert.equal(formatFirstVisit(null), "undated");
});
