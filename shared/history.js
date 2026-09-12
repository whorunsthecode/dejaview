/** History discovery is separate from Tab: history IDs are strings, never tab IDs.
 * HistorySource.search({query, mode, excludeUrls, limit}) -> HistoryCandidate[]
 * HistorySource.open(candidate) -> real Tab metadata after loading (no extraction).
 * A run explicitly opts in before either method may be called.
 */
export const HISTORY_DAYS = 90;
export const HISTORY_LIMIT = 200;
export const HISTORY_SCAN_LIMIT = 10000;
export function historyUrl(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!u.hash.includes('/') && !u.hash.startsWith('#!')) u.hash = '';
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|gclid$|fbclid$)/i.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    return u.href;
  } catch { return null; }
}
/** Throws on malformed discovery metadata; no fake Tab fields or page text. */
export function isHistoryCandidate(v) {
  if (!v || typeof v.historyId !== 'string' || !v.historyId || typeof v.title !== 'string' || !historyUrl(v.url) ||
    !Number.isFinite(v.lastVisit) || !Number.isFinite(v.visitCount) || v.visitCount < 0 ||
    (v.firstVisit !== null && (!Number.isFinite(v.firstVisit) || v.firstVisit > v.lastVisit))) throw new Error('Invalid history candidate');
  return true;
}
export function historyMetadata(v) {
  isHistoryCandidate(v);
  const { historyId, title, url, firstVisit, lastVisit, visitCount } = v;
  return { historyId, title, url, firstVisit, lastVisit, visitCount };
}
