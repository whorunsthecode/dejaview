import { isTraceEvent } from '../shared/types.js';
import { toolSchemas, validateArguments, createTools } from './tools.js';
import { requestJSON } from './transport.js';

export const DEFAULT_MODEL = 'google/gemini-2.5-flash';
export const MAX_READS = 8;
export const MAX_ITERATIONS = 20;

async function loadSystemPrompt() {
  const url = new URL('./prompts/system.md', import.meta.url);
  if (globalThis.process?.versions?.node) {
    const { readFile, writeFile } = await import('node:fs/promises');
    const text = await readFile(url, 'utf8');
    if (text.trim()) return text;
    const placeholder = 'You are the Deja View browser agent.\n';
    await writeFile(url, placeholder);
    return placeholder;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error('Unable to load system prompt');
  return response.text();
}

export function createOpenRouterModel({ env = {}, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  return async ({ messages, tools }) => {
    if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for a live run');
    const data = await requestJSON('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.OPENROUTER_MODEL || DEFAULT_MODEL, messages, tools, tool_choice: 'auto' })
    }, { fetchImpl, timeoutMs });
    return data.choices?.[0]?.message;
  };
}

/**
 * @param {object} options
 * @param {string} options.goal
 * @param {import('./tab-sources.js').TabSource} options.tabSource
 * @param {(event: import('../shared/types.js').TraceEvent) => void} options.onTrace
 * @returns {Promise<{status:string,skill:object|null,reads:number,iterations:number,messages:Array}>}
 */
export async function runAgent({ goal, tabSource, onTrace, env = globalThis.process?.env ?? {},
  fetchImpl = globalThis.fetch, timeoutMs = 30000, model = createOpenRouterModel({ env, fetchImpl, timeoutMs }) }) {
  if (typeof onTrace !== 'function') throw new Error('onTrace callback is required');
  const emit = (kind, label, detail = '', ref = null) => {
    const event = { t: Date.now(), kind, label, detail, ref };
    isTraceEvent(event); // Deliberately outside tool/model error recovery.
    onTrace(event);
  };
  const tools = createTools({ tabSource, env, fetchImpl, timeoutMs });
  const schemas = toolSchemas.map(tool => ({ type: 'function', function: tool }));
  const messages = [];
  let reads = 0, iterations = 0;
  const invalidAttempts = new Map();
  const finish = (status, label) => {
    emit('done', label);
    return { status, skill: tools.getSkill(), reads, iterations, messages };
  };
  let prompt;
  try { prompt = await loadSystemPrompt(); }
  catch (error) { emit('error', error.message); return finish('error', 'Stopped: system prompt unavailable.'); }
  messages.push({ role: 'system', content: prompt }, { role: 'user', content: goal });
  emit('plan', `Goal: ${goal}`);
  for (iterations = 1; iterations <= MAX_ITERATIONS; iterations++) {
    let response;
    try {
      response = await model({ messages: structuredClone(messages), tools: schemas });
      if (!response || response.role !== 'assistant' ||
          (response.tool_calls !== undefined && !Array.isArray(response.tool_calls))) throw new Error('Malformed model response');
      if (response.content != null && typeof response.content !== 'string') throw new Error('Malformed model content');
      const ids = new Set();
      for (const call of response.tool_calls ?? []) {
        if (!call || typeof call.id !== 'string' || !call.id || ids.has(call.id) || call.type !== 'function' || typeof call.function?.name !== 'string') throw new Error('Malformed tool call envelope');
        ids.add(call.id);
      }
    } catch (error) {
      emit('error', `Model call failed: ${error.message}`);
      return finish('error', 'Stopped with a partial result.');
    }
    messages.push(response);
    if (response.content?.trim()) emit('plan', response.content.trim());
    const calls = response.tool_calls ?? [];
    if (!calls.length) {
      messages.push({ role: 'user', content: 'Continue using the available tools, or finish with write_skill. State unsupported coverage honestly.' });
      continue;
    }
    for (const call of calls) {
      const name = call.function.name;
      let args, result, ref = null;
      try { args = JSON.parse(call.function.arguments); } catch { /* Report below as a tool result. */ }
      if (Number.isFinite(args?.id)) ref = args.id;
      emit('tool', `Calling ${name}`, typeof args?.query === 'string' ? args.query : '', ref);
      try {
        if (tools.getSkill()) throw new Error('Run already ended: write_skill may only be called once; no further tools execute');
        if ((invalidAttempts.get(name) ?? 0) >= 2) throw new Error(`Argument retry exhausted for ${name}; this tool is disabled for this run`);
        try { validateArguments(name, args); }
        catch (error) {
          const count = (invalidAttempts.get(name) ?? 0) + 1;
          invalidAttempts.set(name, count);
          throw new Error(`Validation error: ${error.message}. ${count === 1 ? 'Retry once with corrected arguments.' : 'Retry exhausted; giving up on this tool.'}`);
        }
        invalidAttempts.delete(name);
        if (name === 'read_tab') {
          if (reads >= MAX_READS) throw new Error('Read budget exhausted: all 8 read_tab calls used. Use already-read tabs or finish.');
          reads++; // Failed and blocked reads consume budget too.
        }
        result = await tools.handlers[name](args);
      } catch (error) { result = { error: { message: error instanceof Error ? error.message : String(error) } }; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      let label = result.error ? `${name} failed: ${result.error.message}` : `${name} completed`;
      if (name === 'list_tabs' && !result.error) label = `Listed ${result.length} tabs (metadata only)`;
      if (name === 'read_tab' && !result.error) label = `Tab ${ref}: ${result.textStatus}, ${result.text?.length ?? 0} characters`;
      if (name === 'search_in_tab' && !result.error) label = `Found ${result.excerpts.length} excerpts`;
      if (name === 'web_search' && !result.error) label = result[0]?.title?.startsWith('[STUB') ? 'Web search unavailable: marked stub returned' : `Found ${result.length} web results`;
      emit('result', label, '', ref);
    }
    if (tools.getSkill()) return finish('complete', 'write_skill completed.');
  }
  iterations = MAX_ITERATIONS;
  return finish('partial', 'Iteration limit reached (20). Returning partial result.');
}
