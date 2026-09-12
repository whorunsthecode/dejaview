import { MetadataIndex } from '../shared/metadata-index.js';
import { historyUrl } from '../shared/history.js';
import { LocalStore } from './local-store.js';
import { toTab } from './tabs.js';
import { mapConcurrent } from '../shared/concurrency.js';

/** Reconcile once per worker wake; Chrome events maintain metadata thereafter. */
export class TabIndex {
  constructor({ api = globalThis.chrome, store = new LocalStore('tab-index'), convert = toTab } = {}) {
    Object.assign(this, { api, store, convert });
    this.index = new MetadataIndex(); this.raw = new Map(); this.warning = null;
    this.listeners = []; this.visits = new Map(); this.groups = new Map();
    this.queue = this.bootstrap();
    const listen = (event, callback) => {
      if (!event?.addListener) return;
      const handler = (...args) => { this.queue = this.queue.then(() => callback(...args)).catch(e => { this.warning = e.message; }); };
      event.addListener(handler); this.listeners.push(() => event.removeListener(handler));
    };
    listen(api.tabs.onCreated, tab => this.update(tab));
    listen(api.tabs.onUpdated, (id, changes, tab) => this.update({ ...(this.raw.get(id) ?? {}), ...tab, ...changes, id }));
    listen(api.tabs.onRemoved, id => this.remove(id));
    listen(api.tabs.onReplaced, async (added, removed) => { await this.remove(removed); await this.update(await api.tabs.get(added)); });
    listen(api.tabs.onAttached, async id => this.update(await api.tabs.get(id)));
    listen(api.tabGroups?.onUpdated, async group => {
      this.groups.delete(group.id);
      for (const tab of this.raw.values()) if (tab.groupId === group.id) await this.update(tab);
    });
    listen(api.history?.onVisitRemoved, async () => {
      this.visits.clear();
      for (const tab of this.raw.values()) await this.update(tab);
    });
    listen(api.history?.onVisited, async item => {
      this.visits.delete(item.url);
      for (const tab of this.raw.values()) if ((tab.url || tab.pendingUrl) === item.url) await this.update(tab);
    });
  }
  async persist(method, value) {
    try { await this.store[method](value); } catch (e) { this.warning = e.message; }
  }
  signature(tab) { return JSON.stringify([tab.url || tab.pendingUrl, tab.title, tab.windowId, tab.groupId]); }
  async bootstrap() {
    let saved = [];
    try { saved = await this.store.all(); } catch (e) { this.warning = e.message; }
    const byId = new Map(saved.map(row => [row.key, row]));
    const live = await this.api.tabs.query({});
    const ids = new Set(live.filter(t => !t.incognito).map(t => t.id));
    for (const row of saved) if (!ids.has(row.key)) await this.persist('delete', row.key);
    await mapConcurrent(live, 4, async tab => {
      if (tab.incognito || !Number.isInteger(tab.id)) return;
      const old = byId.get(tab.id);
      if (old?.signature === this.signature(tab) && old.savedAt > Date.now() - 3600000) {
        this.raw.set(tab.id, tab); this.index.upsert({ ...old.tab, lastAccessed: tab.lastAccessed ?? 0 });
      } else await this.update(tab);
    });
  }
  async update(tab) {
    if (!Number.isInteger(tab.id)) return;
    if (tab.incognito) return this.remove(tab.id);
    this.raw.set(tab.id, tab);
    const metadata = await this.convert(tab, this.visits, this.groups);
    this.index.upsert(metadata);
    await this.persist('put', { key: tab.id, signature: this.signature(tab), tab: metadata, savedAt: Date.now() });
  }
  async remove(id) { this.raw.delete(id); this.index.remove(id); await this.persist('delete', id); }
  async list() { await this.queue; return [...this.index.rows.values()].map(t => ({ ...t })); }
  async candidates(goal, mode) {
    await this.queue;
    // Canonical duplicates are collapsed before ranking so copies cannot crowd out procedures.
    const seen = new Set();
    return this.index.query(goal, { limit: 50, mode }).filter(tab => {
      const key = historyUrl(tab.url);
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 50);
  }
  async clear() {
    await this.queue; await this.store.clear();
    this.index = new MetadataIndex(); this.raw.clear(); this.visits.clear(); this.groups.clear();
    this.queue = this.bootstrap(); await this.queue;
  }
  dispose() { for (const remove of this.listeners) remove(); }
}
