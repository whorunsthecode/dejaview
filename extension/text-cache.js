import { LocalStore } from './local-store.js';
import { readTab } from './extract.js';
import { withTimeout } from '../shared/concurrency.js';

/** A per-document revision check makes URL/hash storage safe across DOM changes. */
export function pageRevision() {
  const key = '__dejavuDocumentRevisionV1';
  if (!globalThis[key]) {
    const state = { id: crypto.randomUUID(), revision: 0 };
    const observer = new MutationObserver(() => state.revision++);
    state.observer = observer;
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    globalThis[key] = state;
  }
  if (globalThis[key].observer.takeRecords().length) globalThis[key].revision++;
  return `${location.href}|${globalThis[key].id}|${globalThis[key].revision}`;
}

export class TextCache {
  constructor({ api = globalThis.chrome, store = new LocalStore('text-cache'), read = readTab, maxEntries = 100, now = () => Date.now() } = {}) {
    Object.assign(this, { api, store, read, maxEntries, now });
    this.rows = new Map(); this.pending = new Map(); this.warning = null; this.writes = Promise.resolve(); this.generation = 0;
    this.ready = store.all().then(rows => { for (const row of rows) if (row.at > now() - 86400000) this.rows.set(row.key, row); else void store.delete(row.key).catch(() => {}); }).catch(e => { this.warning = e.message; });
  }
  async revision(id) {
    const frames = await withTimeout(this.api.scripting.executeScript({ target: { tabId: id }, injectImmediately: true, func: pageRevision }));
    const stamp = frames?.[0]?.result;
    if (typeof stamp !== 'string') throw new Error('No document revision returned');
    return stamp;
  }
  get(id) {
    if (!this.pending.has(id)) this.pending.set(id, this.load(id, this.generation).finally(() => this.pending.delete(id)));
    return this.pending.get(id);
  }
  async load(id, generation) {
    await this.ready;
    const fail = (textStatus, error) => ({ id, text: null, textStatus, error });
    try {
      const tab = await this.api.tabs.get(id);
      if (tab.discarded || tab.frozen || (tab.pendingUrl && tab.pendingUrl !== tab.url)) return fail('blocked', 'Page is unloaded or navigating; open it manually before reading.');
      if (!/^https?:\/\//i.test(tab.url ?? '')) return fail('blocked', 'Page cannot be scripted.');
      const before = await this.revision(id);
      const hit = [...this.rows.values()].find(row => row.url === tab.url && row.stamp === before && row.at > this.now() - 86400000);
      if (hit) return { id, ...hit.result, url: tab.url, cached: true };
      const result = await withTimeout(this.read(id));
      const after = await this.revision(id);
      const current = await this.api.tabs.get(id);
      if (before !== after || current.url !== tab.url) return fail('error', 'Page changed during extraction; retry when stable.');
      if (result.textStatus === 'ok' && typeof result.text === 'string' && !tab.incognito) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.text));
        const hash = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
        const row = { key: `${tab.url}|${hash}`, url: tab.url, hash, stamp: before, at: this.now(), result: { text: result.text, textStatus: result.textStatus } };
        this.writes = this.writes.then(async () => {
          if (generation !== this.generation) return;
          // Remove older versions of this URL; cap total stored source text.
          for (const [key, old] of this.rows) if (old.url === tab.url) { this.rows.delete(key); await this.store.delete(key).catch(e => { this.warning = e.message; }); }
          this.rows.set(row.key, row);
          while (this.rows.size > this.maxEntries) {
            const oldest = [...this.rows.values()].sort((a, b) => a.at - b.at)[0];
            this.rows.delete(oldest.key); await this.store.delete(oldest.key).catch(e => { this.warning = e.message; });
          }
          await this.store.put(row).catch(e => { this.warning = e.message; });
        });
        await this.writes;
      }
      return { ...result, url: tab.url, cached: false };
    } catch (e) { return fail('error', e.message); }
  }
  /** Text already extracted for a URL, or null. Never reads a page to answer. */
  async textFor(url) {
    await this.ready;
    const rows = [...this.rows.values()].filter(row => row.url === url);
    if (!rows.length) return null;
    return rows.sort((a, b) => b.at - a.at)[0].result?.text ?? null;
  }
  async clear() { this.generation++; await this.ready; await this.writes; this.rows.clear(); await this.store.clear(); }
}
