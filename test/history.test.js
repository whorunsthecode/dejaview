import test from 'node:test';
import assert from 'node:assert/strict';
import { browserHistorySource } from '../extension/history.js';
import { HISTORY_DAYS } from '../shared/history.js';
const now = Date.now(), day = 86400000;
const item = (i, age = 1) => ({ id: String(i), url: `https://example.org/docs/${i}`, title: 'Keychain storage', lastVisitTime: now - age * day, visitCount: 2 });
function fake(items) {
  const calls = { searches: [], visits: [], created: [] }, tabs = new Map();
  const api = {
    history: {
      search: async query => { calls.searches.push(query); return items; },
      getVisits: async ({ url }) => { calls.visits.push(url); return [{ visitTime: now - 100 * day }, { visitTime: now - 60 * day }]; }
    },
    tabs: {
      query: async () => [...tabs.values()],
      create: async opts => { calls.created.push(opts); const tab = { id: 42, url: opts.url, status: 'complete', windowId: 1 }; tabs.set(42, tab); return tab; },
      get: async id => { if (!tabs.has(id)) throw new Error('Tab closed'); return tabs.get(id); }
    }
  };
  return { api, calls, tabs };
}
test('history discovery is bounded, excludes open/non-web/old URLs, and dates only shortlisted candidates', async () => {
  const f = fake([...Array.from({ length: 80 }, (_, i) => item(i)), { ...item(100), url: 'chrome://settings' }, item(101, 100), { ...item(102), url: item(1).url + '?utm_source=duplicate' }]);
  const source = browserHistorySource({ api: f.api, now: () => now });
  assert.equal(f.calls.searches.length, 0);
  const found = await source.search({ query: 'Keychain', excludeUrls: [item(0).url], limit: 99 });
  assert.equal(found.length, 50); assert.equal(f.calls.visits.length, 50);
  assert.equal(new Set(found.map(c => c.url)).size, 50);
  assert.ok(found.every(c => !['0','100','101'].includes(c.historyId)));
  assert.ok(found.every(c => c.firstVisit === now - 60 * day));
  assert.deepEqual(f.calls.searches[0], { text: '', startTime: now - HISTORY_DAYS * day, endTime: now, maxResults: 2000 });
  assert.equal(f.calls.created.length, 0);
});
test('loose shortlist reserves space for older pages outside a dominant topic cluster', async () => {
  const f = fake([...Array.from({ length: 55 }, (_, i) => item(i)), { ...item(999, 80), title: 'Design a disposable prototype', visitCount: 1 }]);
  const found = await browserHistorySource({ api: f.api, now: () => now }).search({ query: 'Keychain', mode: 'loose' });
  assert.ok(found.some(c => c.historyId === '999')); assert.equal(found.length, 50);
});
test('unknown earliest visit stays null instead of being replaced by the latest visit', async () => {
  const f = fake([item(1)]); f.api.history.getVisits = async () => { throw new Error('Denied'); };
  const [c] = await browserHistorySource({ api: f.api, now: () => now }).search({ query: 'storage' });
  assert.equal(c.firstVisit, null); assert.equal(c.lastVisit, item(1).lastVisitTime);
});
test('reopen uses inactive real tabs and retains the pre-reopen history date', async () => {
  const f = fake([item(1)]), source = browserHistorySource({ api: f.api, now: () => now });
  const [c] = await source.search({ query: 'storage' });
  const tab = await source.open(c);
  assert.deepEqual(f.calls.created, [{ url: c.url, active: false }]);
  assert.equal(tab.id, 42); assert.equal(tab.firstVisit, now - 60 * day); assert.equal(tab.text, null);
  const again = await source.open(c); assert.equal(again.id, 42); assert.equal(f.calls.created.length, 1);
});
test('redirects, closed pages and loading timeouts fail without another reopen attempt', async () => {
  for (const behavior of ['redirect', 'closed', 'timeout']) {
    const f = fake([item(1)]), source = browserHistorySource({ api: f.api, now: () => now, loadTimeoutMs: 0 });
    const [c] = await source.search({ query: 'storage' });
    f.api.tabs.get = async () => {
      if (behavior === 'closed') throw new Error('Tab closed');
      return { id: 42, url: behavior === 'redirect' ? 'https://example.org/login' : c.url, status: behavior === 'timeout' ? 'loading' : 'complete', windowId: 1 };
    };
    await assert.rejects(source.open(c), /redirected|closed|timed out/);
    assert.equal(f.calls.created.length, 1);
  }
});

test('reopened article extracts, verifies and highlights the exact quote using the existing DOM code', async () => {
  const { JSDOM } = await import('jsdom');
  const { readFile } = await import('node:fs/promises');
  const { extractInPage } = await import('../extension/extract.js');
  const { highlightInPage } = await import('../extension/highlight.js');
  const { verifyQuotes } = await import('../agent/verify-quotes.js');
  const f = fake([item(1)]), source = browserHistorySource({ api: f.api, now: () => now });
  const [c] = await source.search({ query: 'storage' });
  const tab = await source.open(c);
  const text = 'Store the refresh token using SecItemAdd with the generic password class.';
  const dom = new JSDOM(`<html><head><title>Keychain storage</title></head><body><article>${Array.from({ length: 8 }, () => `<p>${text} Choose a stable service and account to retrieve this value later.</p>`).join('')}</article></body></html>`, { url: tab.url, runScripts: 'outside-only' });
  const saved = { document: globalThis.document, Readability: globalThis.Readability };
  try {
    dom.window.eval(await readFile(new URL('../extension/vendor/readability.js', import.meta.url), 'utf8'));
    globalThis.document = dom.window.document; globalThis.Readability = dom.window.Readability;
    const extracted = extractInPage(6000); assert.equal(extracted.textStatus, 'ok');
    const verified = verifyQuotes([{ tabId: tab.id, quote: text, why: 'Names the storage API.' }], new Map([[tab.id, extracted]]));
    assert.equal(verified.ok.length, 1);
    const highlighted = highlightInPage(verified.ok.map(p => p.quote));
    assert.equal(highlighted.matched, 1);
    assert.ok(document.querySelector('mark.dejavu-highlight'));
  } finally { Object.assign(globalThis, saved); dom.window.close(); }
});
