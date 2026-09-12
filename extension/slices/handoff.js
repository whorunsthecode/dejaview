/**
 * Handing a set of pages to the slice page.
 *
 * A result set lives wherever it was produced — the side panel, say — and the
 * review screen lives in its own page. The set travels through the store rather
 * than the URL: twenty URLs in a query string is a truncation waiting to happen,
 * and a truncated set would silently export the wrong thing.
 */
import { SliceStore, KIND } from "./store.js";

/** Where the slice page lives. */
export function slicePageUrl(query = "", api = globalThis.chrome) {
  return api.runtime.getURL("extension/slices/slices.html") + query;
}

/**
 * Pull the cited sources out of a rendered SKILL.md.
 *
 * renderSkill writes them as "- <url> — provenance" under a "## Sources"
 * heading. Only that section is read: a URL quoted in the procedure is an
 * example, not something the run actually cited.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function sourceUrls(markdown) {
  const text = String(markdown ?? "");
  const at = text.indexOf("## Sources");
  if (at === -1) return [];

  const section = text.slice(at);
  const urls = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^[-*]\s+<?(https?:\/\/[^\s<>)]+)>?/.exec(line.trim());
    if (match && !urls.includes(match[1])) urls.push(match[1]);
  }
  return urls;
}

/**
 * Stash a set of pages and return the URL that opens its review screen.
 *
 * @param {{urls: string[], label: string, terms?: string[], titles?: Record<string,string>}} set
 * @returns {Promise<string|null>} null when there is nothing to slice
 */
export async function handOff({ urls = [], label, terms = [], titles = {}, store = new SliceStore(), api = globalThis.chrome } = {}) {
  const unique = [...new Set(urls.filter((url) => /^https?:\/\//i.test(url)))];
  if (!unique.length) return null;

  const row = await store.save({ kind: KIND.handoff, urls: unique, label, terms, titles });
  return slicePageUrl("?handoff=" + encodeURIComponent(row.id), api);
}
