/**
 * Exa search client.
 *
 * Raw HTTP rather than the exa-js SDK: agent/ has no dependencies and the repo has
 * no bundler, and these tools have to run both under node and, later, inside the MV3
 * service worker. `fetch` is the one transport available in both.
 *
 * The request shape is Exa's documented recommendation — query, type, and highlights,
 * and nothing else. Adding numResults, category or domain filters without a task that
 * requires them is the integration mistake Exa's own guidance calls out first.
 */

const SEARCH_ENDPOINT = "https://api.exa.ai/search";
const PLACEHOLDER = "paste-your-exa-api-key-here";

/**
 * @typedef {Object} SearchResult
 * @property {string} title
 * @property {string} url
 * @property {string|null} publishedDate
 * @property {string[]} highlights   token-efficient excerpts Exa picked from the page
 */

let injectedKey = null;

/**
 * Supply the key explicitly. The service worker has no process.env, so the extension
 * side must call this before the first search.
 * @param {string|null} key
 */
export function setApiKey(key) {
  injectedKey = key || null;
}

function resolveKey(explicit) {
  const key =
    explicit ??
    injectedKey ??
    (typeof process !== "undefined" ? process.env?.EXA_API_KEY : null) ??
    null;
  if (!key) {
    throw new Error("EXA_API_KEY is not set. Copy .env.example to .env and fill it in.");
  }
  if (key === PLACEHOLDER) {
    throw new Error("EXA_API_KEY is still the placeholder. Paste your real key from exa.ai/api-keys.");
  }
  return key;
}

/**
 * Search the web. Returns page excerpts, not a synthesized answer: the agent does its
 * own reasoning over these, the same way it does over tab text.
 * @param {string} query
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch, apiKey?: string}} [opts]
 *   fetchImpl and apiKey let a host inject its own transport and key (tests, per-run env)
 *   instead of relying on the globals.
 * @returns {Promise<SearchResult[]>}
 */
export async function search(query, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("exa.search: query must be a non-empty string");
  }

  const res = await fetchImpl(SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": resolveKey(opts.apiKey)
    },
    body: JSON.stringify({
      query,
      type: "auto",
      contents: { highlights: true }
    }),
    signal: opts.signal
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`exa /search failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.results ?? []).map(toResult);
}

/**
 * @param {any} r
 * @returns {SearchResult}
 */
function toResult(r) {
  return {
    title: typeof r.title === "string" && r.title ? r.title : r.url,
    url: r.url,
    publishedDate: r.publishedDate ?? null,
    highlights: Array.isArray(r.highlights) ? r.highlights : []
  };
}
