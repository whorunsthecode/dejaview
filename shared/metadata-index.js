import { historyUrl } from './history.js';
const stop = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'how', 'can', 'into', 'to', 'of', 'in', 'on', 'at', 'as', 'by', 'or', 'an', 'is', 'be', 'it', 'we', 'do', 'us']);
export const indexTerms = text => [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length >= 2 && !stop.has(t)))];

/** Incremental inverted index: tokenize only inserts/updates, never the corpus per query. */
export class MetadataIndex {
  constructor() { this.rows = new Map(); this.postings = new Map(); this.tokens = new Map(); }
  remove(id) {
    for (const term of this.tokens.get(id) ?? []) {
      const posting = this.postings.get(term); posting.delete(id);
      if (!posting.size) this.postings.delete(term);
    }
    this.rows.delete(id); this.tokens.delete(id);
  }
  upsert(tab) {
    this.remove(tab.id); this.rows.set(tab.id, tab);
    const tokens = indexTerms(`${tab.title} ${tab.url} ${tab.groupTitle ?? ''}`);
    this.tokens.set(tab.id, tokens);
    for (const term of tokens) {
      if (!this.postings.has(term)) this.postings.set(term, new Set());
      this.postings.get(term).add(tab.id);
    }
  }
  query(goal, { limit = 50, mode = 'tight' } = {}) {
    const scores = new Map();
    for (const term of indexTerms(goal)) {
      const ids = this.postings.get(term) ?? new Set();
      const weight = Math.log(1 + this.rows.size / (1 + ids.size));
      for (const id of ids) scores.set(id, (scores.get(id) ?? 0) + weight);
    }
    const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const selected = new Set(), urls = new Set();
    const add = id => {
      const url = historyUrl(this.rows.get(id).url);
      if (url && !urls.has(url)) { selected.add(id); urls.add(url); }
    };
    for (const [id] of ranked) {
      if (selected.size >= Math.floor(limit * (mode === 'loose' ? 0.5 : 0.8))) break;
      add(id);
    }
    const group = t => t.groupTitle || (() => { try { return new URL(t.url).hostname; } catch { return ''; } })();
    const groups = new Set([...selected].map(id => group(this.rows.get(id))));
    for (const [id, row] of this.rows) {
      if (selected.size >= limit) break;
      if (!groups.has(group(row))) { add(id); groups.add(group(row)); }
    }
    for (const id of [...ranked.map(([id]) => id), ...this.rows.keys()]) {
      if (selected.size >= limit) break;
      add(id);
    }
    return [...selected].map(id => this.rows.get(id));
  }
}
