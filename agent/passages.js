import { verifyQuotes } from './verify-quotes.js';

async function loadPrompt(mode) {
  const url = new URL(mode === 'loose' ? './prompts/loose.md' : './prompts/passages.md', import.meta.url);
  if (globalThis.process?.versions?.node) return (await import('node:fs/promises')).readFile(url, 'utf8');
  const response = await fetch(url);
  if (!response.ok) throw new Error('Unable to load passage prompt');
  return response.text();
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validate(value, tabs) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'empty,passages' || !Array.isArray(value.passages) || !Array.isArray(value.empty)) throw new Error('Expected passages and empty arrays');
  const known = new Set(tabs.map(tab => tab.id)), counts = new Map(), empty = new Set();
  for (const item of value.passages) {
    if (!object(item) || Object.keys(item).sort().join(',') !== 'quote,tabId,why' || !known.has(item.tabId) ||
        typeof item.quote !== 'string' || !item.quote.trim() || typeof item.why !== 'string' || !item.why.trim()) throw new Error('Each passage needs a known tabId, quote and why');
    counts.set(item.tabId, (counts.get(item.tabId) ?? 0) + 1);
    if (counts.get(item.tabId) > 4) throw new Error(`Tab ${item.tabId} has more than four passages`);
  }
  for (const item of value.empty) {
    if (!object(item) || Object.keys(item).sort().join(',') !== 'tabId,why' || !known.has(item.tabId) ||
        counts.has(item.tabId) || empty.has(item.tabId) || typeof item.why !== 'string' || !item.why.trim()) throw new Error('Each empty entry needs a distinct unquoted tabId and why');
    empty.add(item.tabId);
  }
  if (counts.size + empty.size !== known.size) throw new Error('Account for every readable tab with passages or an empty entry');
  return value;
}

function validateLoose(value, tabs) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'none,rhymes' || !Array.isArray(value.rhymes) || value.rhymes.length > 3) throw new Error('Expected at most three rhymes and none');
  const known = new Set(tabs.map(tab => tab.id));
  for (const item of value.rhymes) {
    if (!object(item) || Object.keys(item).sort().join(',') !== 'connection,quote,tabId' || !known.has(item.tabId) ||
      typeof item.quote !== 'string' || !item.quote.trim() || typeof item.connection !== 'string' || !item.connection.trim()) throw new Error('Each rhyme requires a known tabId, quote and connection');
  }
  if (value.rhymes.length ? value.none !== null : typeof value.none !== 'string' || !value.none.trim()) throw new Error('Explain none only when there are no rhymes');
  return { passages: value.rhymes.map(p => ({ ...p, why: p.connection })), empty: [], none: value.none };
}
export function ageInMonths(firstVisit, now = Date.now()) {
  return typeof firstVisit === 'number' && Number.isFinite(firstVisit) ? Math.max(0, Math.floor((now - firstVisit) / (30.4375 * 86400000))) : null;
}

/** Select from READ snapshots only. Never insert raw model quotes into the main loop. */
export async function selectPassages({ goal, tabs, model, maxModelCalls = 2, mode = 'tight', now = Date.now() }) {
  if (!['tight', 'loose'].includes(mode)) throw new Error('mode must be tight or loose');
  const readable = tabs.filter(tab => tab.textStatus === 'ok' && typeof tab.text === 'string' && tab.text.trim());
  if (!readable.length) return { passages: [], empty: [], verification: { ok: [], repaired: [], failed: [] }, rawOutputs: [], modelCalls: 0, none: mode === 'loose' ? 'No readable tabs to compare.' : null };
  const prompt = await loadPrompt(mode);
  const messages = [{ role: 'system', content: prompt.replace('{goal}', () => goal) }, { role: 'user', content: JSON.stringify({ tabs: readable.map(({ id, title, url, firstVisit, text }) => ({ id, title, url, firstVisit, text, ...(mode === 'loose' ? { ageMonths: ageInMonths(firstVisit, now) } : {}) })) }) }];
  const rawOutputs = [];
  for (let attempt = 0; attempt < Math.min(2, maxModelCalls); attempt++) {
    const response = await model({ phase: mode === 'loose' ? 'loose' : 'passages', messages: structuredClone(messages), responseFormat: { type: 'json_object' }, maxOutputTokens: 8192 });
    rawOutputs.push(typeof response?.content === 'string' ? response.content : JSON.stringify(response) ?? 'undefined');
    let parsed;
    try {
      if (response?.role !== 'assistant' || typeof response.content !== 'string' || response.tool_calls?.length) throw new Error('Expected JSON passage response without tool calls');
      parsed = (mode === 'loose' ? validateLoose : validate)(JSON.parse(response.content), readable);
    } catch (cause) {
      if (attempt + 1 < Math.min(2, maxModelCalls)) {
        messages.push({ role: 'assistant', content: rawOutputs.at(-1) }, { role: 'user', content: `Parse/validation error: ${cause.message}. Return corrected JSON only; copy quotes exactly.` });
        continue;
      }
      throw Object.assign(new Error(`Passage selection failed: ${cause.message}`, { cause }), { rawOutputs, modelCalls: attempt + 1 });
    }
    const verification = verifyQuotes(parsed.passages, new Map(readable.map(tab => [tab.id, tab])));
    // Strip originalQuote/method diagnostics before exposing anything downstream.
    const passages = [...verification.ok, ...verification.repaired].map(({ tabId, quote, why, connection }) => ({ tabId, quote, why, ...(mode === 'loose' ? { connection, ageMonths: ageInMonths(readable.find(t => t.id === tabId).firstVisit, now) } : {}) }));
    return { passages, empty: parsed.empty, none: mode === 'loose' && !passages.length ? (parsed.none ?? 'No rhymes survived exact quote verification.') : null, verification, rawOutputs, modelCalls: attempt + 1 };
  }
  throw new Error('No model turns remaining for passage selection');
}
