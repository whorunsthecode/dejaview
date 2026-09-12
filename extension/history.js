import { HISTORY_DAYS, HISTORY_LIMIT, HISTORY_SCAN_LIMIT, historyUrl, historyMetadata } from '../shared/history.js';

/** Bounds apply before sending any metadata to a model. No background collection. */
export function browserHistorySource({ api = globalThis.chrome, now = () => Date.now(), loadTimeoutMs = 15000 } = {}) {
  return {
    async search({ query, mode = 'tight', excludeUrls = [], limit = HISTORY_LIMIT }) {
      const endTime = now(), startTime = endTime - HISTORY_DAYS * 86400000;
      const excluded = new Set(excludeUrls.map(historyUrl));
      const raw = await api.history.search({ text: '', startTime, endTime, maxResults: HISTORY_SCAN_LIMIT });
      const unique = new Map();
      for (const item of raw) {
        const key = historyUrl(item.url);
        if (!key || excluded.has(key) || typeof item.id !== 'string' || !Number.isFinite(item.lastVisitTime) || item.lastVisitTime < startTime || item.lastVisitTime > endTime) continue;
        if (!unique.has(key) || item.lastVisitTime > unique.get(key).lastVisitTime) unique.set(key, item);
      }
      const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
      const score = item => terms.reduce((n, term) => n + (`${item.title ?? ''} ${item.url}`.toLowerCase().includes(term) ? 1 : 0), 0);
      const pool = [...unique.values()];
      const max = Math.max(0, Math.min(HISTORY_LIMIT, limit));
      const ranked = [...pool].sort((a, b) => score(b) - score(a) || (b.visitCount ?? 0) - (a.visitCount ?? 0) || b.lastVisitTime - a.lastVisitTime);
      // Loose mode reserves half its shortlist for older retained pages. This is
      // candidate discovery, not forced model selection or a page read.
      const selected = mode === 'loose' ? ranked.slice(0, Math.ceil(max / 2)) : ranked.slice(0, max);
      if (mode === 'loose') for (const item of [...pool].sort((a, b) => a.lastVisitTime - b.lastVisitTime)) {
        if (selected.length >= max) break;
        if (!selected.includes(item)) selected.push(item);
      }
      return Promise.all(selected.map(async item => {
        let firstVisit = null;
        try {
          const dates = (await api.history.getVisits({ url: item.url })).map(v => v.visitTime).filter(t => Number.isFinite(t) && t >= startTime && t <= item.lastVisitTime);
          if (dates.length) firstVisit = Math.min(...dates);
        } catch { /* Missing visit details remain unknown. */ }
        return historyMetadata({ historyId: item.id, title: item.title ?? item.url, url: item.url,
          firstVisit, lastVisit: item.lastVisitTime, visitCount: Math.max(0, item.visitCount ?? 0) });
      }));
    },
    async open(candidate) {
      historyMetadata(candidate);
      // Reuse a page the user opened since discovery instead of duplicating it.
      let tab = (await api.tabs.query({})).find(t => !t.incognito && historyUrl(t.url ?? t.pendingUrl) === historyUrl(candidate.url));
      if (!tab) tab = await api.tabs.create({ url: candidate.url, active: false });
      if (!Number.isInteger(tab.id)) throw new Error('History reopen returned no real tab ID');
      const deadline = now() + loadTimeoutMs;
      while (true) {
        tab = await api.tabs.get(tab.id); // A closed tab rejects; no automatic reopening loop.
        if (tab.status === 'complete') break;
        if (now() >= deadline) throw new Error('History page load timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (historyUrl(tab.url) !== historyUrl(candidate.url)) throw new Error('History page redirected; refusing to attribute a different page to this visit');
      return { id: tab.id, url: tab.url, title: tab.title || candidate.title, windowId: tab.windowId,
        groupTitle: null, firstVisit: candidate.firstVisit, lastAccessed: tab.lastAccessed ?? 0, text: null, textStatus: 'empty' };
    }
  };
}
