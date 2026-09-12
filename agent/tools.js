import { isTab } from '../shared/types.js';
import { search as exaSearch } from './exa.js';

export const toolSchemas = [
  {
    name: "list_tabs",
    description: "Return metadata for all open tabs. Cheap. Call first. No text is included.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "read_tab",
    description: "Fetch the readable text of one tab. Expensive. Max 8 reads per run.",
    parameters: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "search_in_tab",
    description: "Search within one tab's text for a query. Use for long documents.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number" },
        query: { type: "string" }
      },
      required: ["id", "query"],
      additionalProperties: false
    }
  },
  {
    name: "web_search",
    description: "Fetch external results. Call only after stating a coverage gap.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "write_skill",
    description: "Terminal call. Emit the final SKILL.md and end the run.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              firstVisit: { type: ["number", "null"] }
            },
            required: ["url", "firstVisit"]
          }
        }
      },
      required: ["name", "description", "body", "sources"],
      additionalProperties: false
    }
  }
];

export function validateArguments(name, args) {
  const schema = toolSchemas.find(tool => tool.name === name)?.parameters;
  if (!schema) throw new Error(`Unknown tool ${name}`);
  function check(value, rule, path) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(type) || (type === 'number' && !Number.isFinite(value))) throw new Error(`${path}: expected ${types.join('|')}`);
    if (type === 'object') {
      for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${path}: missing ${key}`);
      for (const key of Object.keys(value)) {
        if (rule.properties?.[key]) check(value[key], rule.properties[key], `${path}.${key}`);
        else if (rule.additionalProperties === false) throw new Error(`${path}: unexpected ${key}`);
      }
    }
    if (type === 'array') value.forEach((item, i) => check(item, rule.items, `${path}[${i}]`));
  }
  check(args, schema, name);
  if ('query' in args && !args.query.trim()) throw new Error('query must not be empty');
  return args;
}

/** Each run owns its read cache and terminal state. The host owns the read budget. */
export function createTools({ tabSource, env = {}, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  const readTabs = new Map();
  let skill = null;
  const handlers = {
    async list_tabs() {
      const tabs = await tabSource.list();
      return tabs.map(tab => {
        // A message source may already omit text; validate the full shared shape first.
        isTab({ ...tab, text: Object.hasOwn(tab, 'text') ? tab.text : null });
        const { text, ...metadata } = tab;
        return metadata;
      });
    },
    async read_tab({ id }) {
      const result = await tabSource.read(id);
      if (!result || result.id !== id || !['ok', 'empty', 'blocked', 'error'].includes(result.textStatus) ||
          (result.text !== null && typeof result.text !== 'string')) throw new Error('Invalid tab read response');
      const value = { id, text: result.text, textStatus: result.textStatus };
      readTabs.set(id, value);
      return value;
    },
    async search_in_tab({ id, query }) {
      if (!readTabs.has(id)) throw new Error(`Read tab ${id} before searching it`);
      const text = readTabs.get(id).text ?? '';
      const lower = text.toLowerCase();
      const terms = [query.toLowerCase(), ...query.toLowerCase().split(/\s+/)].filter(Boolean);
      const ranges = [];
      for (const term of new Set(terms)) {
        let offset = 0;
        while (ranges.length < 5) {
          const found = lower.indexOf(term, offset);
          if (found < 0) break;
          const start = Math.max(0, found - 160), end = Math.min(text.length, found + term.length + 240);
          if (!ranges.some(([a, b]) => start < b && end > a)) ranges.push([start, end]);
          offset = found + term.length;
        }
      }
      return { id, excerpts: ranges.sort((a, b) => a[0] - b[0]).map(([a, b]) => text.slice(a, b)) };
    },
    async web_search({ query }) {
      if (env.ENABLE_EXA !== '1' || !env.EXA_API_KEY) return [{
        title: '[STUB — no web search performed]', url: '', source: 'web', firstVisit: null, stub: true,
        highlights: ['External coverage is unavailable. Set ENABLE_EXA=1 and EXA_API_KEY to search.']
      }];
      const results = await exaSearch(query, { fetchImpl, apiKey: env.EXA_API_KEY, signal: AbortSignal.timeout(timeoutMs) });
      return results.map(({ title, url, highlights }) => {
        if (typeof title !== 'string' || typeof url !== 'string' || !highlights.every(x => typeof x === 'string')) throw new Error('Invalid Exa search result');
        return { title, url, highlights, source: 'web', firstVisit: null };
      });
    },
    async write_skill(payload) {
      if (skill) throw new Error('write_skill may only be called once');
      skill = structuredClone(payload);
      return { ok: true };
    }
  };
  return { handlers, getSkill: () => skill };
}
