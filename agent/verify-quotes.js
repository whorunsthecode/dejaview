/** Normalize for searching while retaining UTF-16 offsets into the ORIGINAL text. */
function normalize(text) {
  let value = '';
  const starts = [], ends = [];
  for (let at = 0; at < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(at));
    const end = at + char.length;
    let replacement = char;
    if (/[\u200B-\u200D\u2060\uFEFF]/u.test(char)) { at = end; continue; }
    if (/\s/u.test(char)) replacement = ' ';
    else if (/[\u2018\u2019\u201A\u201B]/u.test(char)) replacement = "'";
    else if (/[\u201C\u201D\u201E\u201F]/u.test(char)) replacement = '"';
    else if (/[\u2010-\u2015\u2212]/u.test(char)) replacement = '-';
    else if (char === '\u2026') replacement = '...';
    if (replacement === ' ' && value.endsWith(' ')) ends[ends.length - 1] = end;
    else {
      value += replacement;
      for (let i = 0; i < replacement.length; i++) { starts.push(at); ends.push(end); }
    }
    at = end;
  }
  return { value, starts, ends };
}

function sentenceEnd(text, prefixEnd) {
  // Simple punctuation boundary only; no fuzzy matching or language parser.
  const boundary = /[.!?\u2026]+["'\u201D\u2019)\]]*(?=\s|$)/gu;
  boundary.lastIndex = Math.max(0, prefixEnd - 1);
  const match = boundary.exec(text);
  return match ? match.index + match[0].length : text.length;
}

/**
 * @param {Array<{tabId:number,quote:string,why:string}>} passages
 * @param {Map<number,object>|Record<number,object>} tabsById
 * @returns {{ok:Array,repaired:Array,failed:Array}}
 * ok entries pass untouched. Repairs preserve originalQuote and record method;
 * quote ALWAYS contains one actual span from the original source. failed entries
 * are diagnostics only and must never be sent to the skill/highlight consumers.
 */
export function verifyQuotes(passages, tabsById) {
  if (!Array.isArray(passages)) throw new TypeError('passages must be an array');
  if (!tabsById || typeof tabsById !== 'object') throw new TypeError('tabsById must be a Map or keyed object');
  const result = { ok: [], repaired: [], failed: [] };
  const normalizedTabs = new Map();
  for (const passage of passages) {
    const tab = tabsById instanceof Map ? tabsById.get(passage?.tabId)
      : Object.hasOwn(tabsById, passage?.tabId) ? tabsById[passage.tabId] : undefined;
    const text = tab?.text;
    if (!Number.isFinite(passage?.tabId) || typeof passage?.quote !== 'string' || !passage.quote.trim() ||
        typeof text !== 'string' || !text.length || (tab.textStatus !== undefined && tab.textStatus !== 'ok')) {
      result.failed.push({ ...passage, reason: 'Missing quote or readable source tab.' }); continue;
    }
    if (text.includes(passage.quote)) { result.ok.push(passage); continue; }
    if (!normalizedTabs.has(passage.tabId)) normalizedTabs.set(passage.tabId, normalize(text));
    const source = normalizedTabs.get(passage.tabId);
    const query = normalize(passage.quote).value;
    let start = query.trim() ? source.value.indexOf(query) : -1;
    let sourceStart, sourceEnd, method;
    if (start >= 0) {
      sourceStart = source.starts[start]; sourceEnd = source.ends[start + query.length - 1];
      method = 'normalized';
    } else {
      // Only a full 60-character anchor qualifies; do not rescue a short generic
      // opening. Ambiguous anchors are dropped rather than guessing a location.
      const chars = Array.from(query);
      const prefix = chars.length >= 60 ? chars.slice(0, 60).join('') : '';
      start = prefix ? source.value.indexOf(prefix) : -1;
      if (start >= 0 && source.value.indexOf(prefix, start + 1) < 0) {
        sourceStart = source.starts[start];
        sourceEnd = sentenceEnd(text, source.ends[start + prefix.length - 1]);
        method = 'prefix';
      }
    }
    if (method) {
      const quote = text.slice(sourceStart, sourceEnd);
      if (!quote || !text.includes(quote)) throw new Error('Quote repair did not produce an original source span');
      result.repaired.push({ ...passage, quote, originalQuote: passage.quote, method });
    } else result.failed.push({ ...passage, reason: 'No exact, normalized, or unique 60-character prefix match.' });
  }
  return result;
}
