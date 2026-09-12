import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { peekTab, peekInPage } from '../extension/peek.js';
import { pageRevision, TextCache } from '../extension/text-cache.js';
import { highlightInPage } from '../extension/highlight.js';
import { LocalStore, MemoryStore } from '../extension/local-store.js';
import { TabIndex } from '../extension/tab-index.js';
import { MetadataIndex } from '../shared/metadata-index.js';

const event = () => {
  const handlers = new Set();
  return { addListener: fn => handlers.add(fn), removeListener: fn => handlers.delete(fn), fire: (...args) => handlers.forEach(fn => fn(...args)) };
};

test('peek selects metadata and a paragraph without cloning or mutating a page', () => {
  const dom = new JSDOM(`<meta property="og:description" content="${'description '.repeat(80)}"><h1>Mobile shader precision</h1><main><p>${'Use highp. '.repeat(100)}</p></main>`, { runScripts: 'outside-only' });
  const before = dom.window.document.documentElement.outerHTML;
  dom.window.document.cloneNode = () => { throw new Error('Peek must not clone the page'); };
  const result = dom.window.eval(`(${peekInPage.toString()})(600)`);
  assert.equal(result.textStatus, 'ok');
  assert.equal(result.heading, 'Mobile shader precision');
  assert.ok(result.description.length + result.heading.length + result.paragraph.length <= 600);
  assert.equal(dom.window.document.documentElement.outerHTML, before);
  dom.window.close();
});

test('discarded/frozen/loading tabs are never injected during peeks or cached reads', async () => {
  for (const state of [{ discarded: true }, { frozen: true }, { status: 'loading' }]) {
    let injected = 0, reads = 0;
    const api = { tabs: { get: async () => ({ url: 'https://example.org', ...state }) }, scripting: { executeScript: async () => { injected++; } } };
    const cache = new TextCache({ api, store: new MemoryStore(), read: async () => { reads++; } });
    assert.equal((await peekTab(1, api)).textStatus, 'blocked');
    assert.equal((await cache.get(1)).textStatus, 'blocked');
    assert.equal(injected, 0); assert.equal(reads, 0);
  }
});

test('IndexedDB persists URL/hash text, checks revisions, deduplicates in-flight reads and evicts', async () => {
  const factory = new IDBFactory(), store = new LocalStore('cache-test', factory);
  let revision = 'document-1:0', url = 'https://example.org/a', reads = 0;
  const api = { tabs: { get: async () => ({ url }) }, scripting: { executeScript: async () => [{ result: revision }] } };
  const read = async id => { reads++; return { id, text: `Source version ${revision}`, textStatus: 'ok' }; };
  const cache = new TextCache({ api, store, read, maxEntries: 1 });
  await Promise.all([cache.get(1), cache.get(1)]);
  assert.equal(reads, 1);
  assert.equal((await cache.get(1)).cached, true);
  const saved = await store.all();
  assert.match(saved[0].hash, /^[a-f0-9]{64}$/);
  const restored = new TextCache({ api, store: new LocalStore('cache-test', factory), read, maxEntries: 1 });
  assert.equal((await restored.get(1)).cached, true); assert.equal(reads, 1);
  revision = 'document-1:1';
  assert.equal((await restored.get(1)).cached, false); assert.equal(reads, 2);
  url = 'https://example.org/b';
  await restored.get(1);
  assert.equal((await store.all()).length, 1);
  await restored.clear(); assert.equal((await store.all()).length, 0);
});

test('cache never attributes extraction to a page that changed during the read', async () => {
  let revision = 'before';
  const store = new MemoryStore();
  const cache = new TextCache({ store,
    api: { tabs: { get: async () => ({ url: 'https://example.org' }) }, scripting: { executeScript: async () => [{ result: revision }] } },
    read: async id => { revision = 'after'; return { id, text: 'Old text', textStatus: 'ok' }; }
  });
  assert.equal((await cache.get(1)).textStatus, 'error');
  assert.equal((await store.all()).length, 0);
});

test('highlighting does not invalidate a revision; actual text mutations do', async () => {
  const dom = new JSDOM('<main><p>Use high precision for the shader calculation.</p></main>', { url: 'https://example.org', runScripts: 'outside-only' });
  const stamp = () => dom.window.eval(`(${pageRevision.toString()})()`);
  const before = stamp();
  const result = dom.window.eval(`(${highlightInPage.toString()})(["Use high precision for the shader calculation."])`);
  assert.equal(result.matched, 1);
  await Promise.resolve(); assert.equal(stamp(), before);
  dom.window.document.querySelector('p').append(' Updated constraint.');
  assert.notEqual(stamp(), before);
  dom.window.close();
});

test('persistent tab index updates on events and never rescans tabs per run', async () => {
  const factory = new IDBFactory();
  const store = new LocalStore('index-test', factory);
  const raw = new Map(Array.from({ length: 500 }, (_, id) => [id, { id, url: `https://example.org/${id}`, title: id === 250 ? 'Mobile shader banding' : 'Other reference', groupId: -1, windowId: 1 }]));
  let queries = 0, conversions = 0;
  const api = { tabs: { query: async () => { queries++; return [...raw.values()]; }, onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event() } };
  const convert = async t => { conversions++; return { ...t, groupTitle: null, text: null, textStatus: 'empty', firstVisit: null, lastAccessed: 0 }; };
  const index = new TabIndex({ api, store, convert });
  assert.equal((await index.list()).length, 500);
  assert.ok((await index.candidates('shader banding')).some(t => t.id === 250));
  await index.list(); await index.candidates('different goal');
  assert.equal(queries, 1); assert.equal(conversions, 500);
  raw.set(250, { ...raw.get(250), title: 'Changed topic' });
  api.tabs.onUpdated.fire(250, { title: 'Changed topic' }, raw.get(250));
  await index.list(); assert.equal(conversions, 501);
  assert.ok(!index.index.postings.has('banding'));
  raw.delete(0); api.tabs.onRemoved.fire(0);
  assert.equal((await index.list()).length, 499);
  assert.ok(!(await store.all()).some(r => r.key === 0));
  index.dispose();
  const restarted = new TabIndex({ api, store: new LocalStore('index-test', factory), convert });
  assert.equal((await restarted.list()).length, 499);
  assert.equal(queries, 2); assert.equal(conversions, 501);
  raw.set(501, { ...raw.get(1), id: 501, url: 'https://other.org/501', title: 'Shader precision' });
  api.tabs.onCreated.fire(raw.get(501));
  assert.ok((await restarted.candidates('shader precision')).some(t => t.id === 501));
  restarted.dispose();
});

test('incognito metadata and extracted text are not persisted', async () => {
  const store = new MemoryStore();
  const api = { tabs: { query: async () => [{ id: 1, incognito: true }], get: async () => ({ url: 'https://example.org', incognito: true }) }, scripting: { executeScript: async () => [{ result: 'same' }] } };
  const index = new TabIndex({ api, store, convert: async () => { throw new Error('Must not index incognito'); } });
  assert.equal((await index.list()).length, 0);
  const cache = new TextCache({ api, store, read: async id => ({ id, text: 'Private', textStatus: 'ok' }) });
  await cache.get(1); assert.equal((await store.all()).length, 0);
  index.dispose();
});

test('hundreds of duplicate URLs cannot consume the entire index shortlist', () => {
  const index = new MetadataIndex();
  for (let id = 0; id < 400; id++) index.upsert({ id, title: 'Shader shader precision', url: `https://example.org/a?utm_source=${id}`, groupTitle: null });
  for (let id = 400; id < 460; id++) index.upsert({ id, title: 'Shader precision procedure', url: `https://example.org/docs/${id}`, groupTitle: null });
  const found = index.query('shader precision');
  assert.equal(found.length, 50);
  assert.equal(found.filter(t => t.id < 400).length, 1);
});

test('cache expiry and clearing an in-flight extraction prevent stale persistence', async () => {
  let now = 1000, release, started;
  const began = new Promise(resolve => { started = resolve; });
  const store = new MemoryStore();
  const api = { tabs: { get: async () => ({ url: 'https://example.org' }) }, scripting: { executeScript: async () => [{ result: 'unchanged' }] } };
  let reads = 0;
  const cache = new TextCache({ api, store, now: () => now, read: async id => { reads++; return { id, text: 'Source.', textStatus: 'ok' }; } });
  await cache.get(1); now += 86400001;
  assert.equal((await cache.get(1)).cached, false); assert.equal(reads, 2);
  const pending = new TextCache({ api, store: new MemoryStore(), read: async id => { started(); await new Promise(resolve => { release = resolve; }); return { id, text: 'Source.', textStatus: 'ok' }; } });
  const request = pending.get(1); await began; await pending.clear(); release(); await request;
  assert.equal((await pending.store.all()).length, 0);
});

test('a storage failure degrades to an explicit memory-cache diagnostic', async () => {
  const unavailable = async () => { throw new Error('Storage denied'); };
  const cache = new TextCache({ store: { all: unavailable, put: unavailable, delete: unavailable },
    api: { tabs: { get: async () => ({ url: 'https://example.org' }) }, scripting: { executeScript: async () => [{ result: 'stable' }] } },
    read: async id => ({ id, text: 'Source.', textStatus: 'ok' })
  });
  assert.equal((await cache.get(1)).textStatus, 'ok');
  assert.equal((await cache.get(1)).cached, true);
  assert.match(cache.warning, /Storage denied/);
});
