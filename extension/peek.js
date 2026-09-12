import { MAX_PEEK_CHARS, validatePeek } from '../shared/peek.js';
import { withTimeout } from '../shared/concurrency.js';

export async function peekTab(id, api = globalThis.chrome, { timeoutMs = 10000, throwOnError = false } = {}) {
  const empty = textStatus => ({ id, textStatus, description: '', heading: '', paragraph: '' });
  let stage = 'tab metadata';
  try {
    const tab = await withTimeout(api.tabs.get(id), timeoutMs);
    if (tab.discarded || tab.frozen || (tab.pendingUrl && tab.pendingUrl !== tab.url) || !/^https?:\/\//i.test(tab.url ?? '') || tab.url.startsWith('https://chromewebstore.google.com/')) return empty('blocked');
    stage = 'preview injection';
    const frames = await withTimeout(api.scripting.executeScript({ target: { tabId: id }, injectImmediately: true, func: peekInPage, args: [MAX_PEEK_CHARS] }), timeoutMs);
    stage = 'preview validation';
    return validatePeek({ id, ...frames?.[0]?.result }, id);
  } catch (error) {
    if (throwOnError) throw new Error(`Tab ${id} ${stage}: ${error.message}`, { cause: error });
    return empty('error');
  }
}

/** No Readability, clone, body scan or page mutation: only four cheap selectors. */
export function peekInPage(cap) {
  const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const description = clean(document.querySelector('meta[name="description"]')?.content || document.querySelector('meta[property="og:description"]')?.content).slice(0, 240);
  const heading = clean(document.querySelector('h1')?.textContent).slice(0, 120);
  const paragraph = clean(document.querySelector('article p, main p, p')?.textContent).slice(0, Math.max(0, cap - description.length - heading.length));
  return { description, heading, paragraph, textStatus: description || heading || paragraph ? 'ok' : 'empty' };
}
