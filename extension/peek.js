import { MAX_PEEK_CHARS, validatePeek } from '../shared/peek.js';
import { withTimeout } from '../shared/concurrency.js';

export async function peekTab(id, api = globalThis.chrome) {
  const empty = textStatus => ({ id, textStatus, description: '', heading: '', paragraph: '' });
  try {
    const tab = await api.tabs.get(id);
    if (tab.discarded || tab.frozen || tab.status === 'loading' || !/^https?:\/\//i.test(tab.url ?? '') || tab.url.startsWith('https://chromewebstore.google.com/')) return empty('blocked');
    const frames = await withTimeout(api.scripting.executeScript({ target: { tabId: id }, func: peekInPage, args: [MAX_PEEK_CHARS] }));
    return validatePeek({ id, ...frames?.[0]?.result }, id);
  } catch { return empty('error'); }
}

/** No Readability, clone, body scan or page mutation: only four cheap selectors. */
export function peekInPage(cap) {
  const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const description = clean(document.querySelector('meta[name="description"]')?.content || document.querySelector('meta[property="og:description"]')?.content).slice(0, 240);
  const heading = clean(document.querySelector('h1')?.textContent).slice(0, 120);
  const paragraph = clean(document.querySelector('article p, main p, p')?.textContent).slice(0, Math.max(0, cap - description.length - heading.length));
  return { description, heading, paragraph, textStatus: description || heading || paragraph ? 'ok' : 'empty' };
}
