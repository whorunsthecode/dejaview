/** Extension-origin storage only. Separate namespace from API credentials. */
export class MemoryStore {
  constructor() { this.rows = new Map(); }
  async all() { return structuredClone([...this.rows.values()]); }
  async put(row) { this.rows.set(row.key, structuredClone(row)); }
  async delete(key) { this.rows.delete(key); }
  async clear() { this.rows.clear(); }
}

export class LocalStore {
  constructor(name, factory = globalThis.indexedDB) { this.name = name; this.factory = factory; }
  open() {
    if (!this.ready) this.ready = new Promise((resolve, reject) => {
      if (!this.factory) return reject(new Error('IndexedDB unavailable'));
      const req = this.factory.open(`dejavu-${this.name}`, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('rows', { keyPath: 'key' });
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Local database upgrade blocked'));
    });
    return this.ready;
  }
  async operation(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('rows', mode);
      const request = fn(tx.objectStore('rows'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Local storage operation failed'));
    });
  }
  all() { return this.operation('readonly', s => s.getAll()); }
  put(row) { return this.operation('readwrite', s => s.put(row)); }
  delete(key) { return this.operation('readwrite', s => s.delete(key)); }
  clear() { return this.operation('readwrite', s => s.clear()); }
}
