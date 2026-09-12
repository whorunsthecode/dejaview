import { historyUrl } from '../shared/history.js';

export const TRIAGE_LIMIT = 50;
const stop = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'how', 'can', 'into']);
const words = text => [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length > 2 && !stop.has(w)))];

/** Local metadata ranking only. Preserve routes/version queries and never fetch pages. */
export function shortlistTabs(tabs, goal, mode = 'tight') {
  const unique = new Map();
  for (const tab of tabs) {
    const key = historyUrl(tab.url);
    if (key && !unique.has(key)) unique.set(key, tab);
  }
  const pool = [...unique.values()];
  const terms = words(goal);
  const docs = pool.map(tab => ({ tab, tokens: new Set(words(`${tab.title} ${tab.url} ${tab.groupTitle ?? ''}`)) }));
  const weights = new Map(terms.map(term => [term, Math.log(1 + pool.length / (1 + docs.filter(d => d.tokens.has(term)).length))]));
  const scored = docs.map(d => ({ ...d, score: terms.reduce((n, term) => n + (d.tokens.has(term) ? weights.get(term) : 0), 0) }));
  scored.sort((a, b) => b.score - a.score || a.tab.id - b.tab.id);
  // Keep a diversity lane so lexical mismatches and loose analogies get a chance.
  const selected = scored.slice(0, mode === 'loose' ? 25 : 40).map(d => d.tab);
  const groups = new Set(selected.map(t => t.groupTitle || new URL(t.url).hostname));
  const remaining = scored.map(d => d.tab).filter(t => !selected.includes(t));
  for (const tab of remaining) {
    const group = tab.groupTitle || new URL(tab.url).hostname;
    if (selected.length >= TRIAGE_LIMIT) break;
    if (!groups.has(group)) { selected.push(tab); groups.add(group); }
  }
  for (const tab of remaining) {
    if (selected.length >= TRIAGE_LIMIT) break;
    if (!selected.includes(tab)) selected.push(tab);
  }
  return selected;
}
