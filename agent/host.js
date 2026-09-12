import { isTab, isTraceEvent } from '../shared/types.js';
import { toolSchemas, validateArguments, createTools } from './tools.js';
import { requestJSON } from './transport.js';
import { runTriage } from './triage.js';
import { selectPassages } from './passages.js';
import { assessGaps } from './gaps.js';
import { selectHistory } from './history.js';
import { HISTORY_LIMIT, historyUrl, historyMetadata } from '../shared/history.js';
import { DEFAULT_READ_LIMIT, PASSAGE_BATCH_SIZE, readLimit } from '../shared/limits.js';
import { MAX_PEEKS } from '../shared/peek.js';
import { mapConcurrent } from '../shared/concurrency.js';
import { selectPeeks } from './peeks.js';

export const DEFAULT_MODEL = 'google/gemini-2.5-flash';
export const MAX_READS = DEFAULT_READ_LIMIT;
export const MAX_ITERATIONS = 20;
export const MAX_SEARCHES = 2;

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
  return async ({ messages, tools, responseFormat, maxOutputTokens = 4096 }) => {
    if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for a live run');
    let data;
    try {
      data = await requestJSON('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.OPENROUTER_MODEL || DEFAULT_MODEL, messages,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
          ...(responseFormat ? { response_format: responseFormat, max_tokens: maxOutputTokens } : {}) })
      }, { fetchImpl, timeoutMs });
    } catch (error) {
      if (error.status === 401) {
        throw new Error('OpenRouter rejected the API key (HTTP 401). Open keys, paste your current OpenRouter API key, then Save changes. In the CLI, update OPENROUTER_API_KEY.');
      }
      throw error;
    }
    return data.choices?.[0]?.message;
  };
}

/**
 * @param {object} options
 * @param {string} options.goal
 * @param {import('./tab-sources.js').TabSource} options.tabSource
 * @param {(event: import('../shared/types.js').TraceEvent) => void} options.onTrace
 * @returns {Promise<{status:string,skill:object|null,reads:number,iterations:number,messages:Array,triage:object|null}>}
 */
async function runLive({ goal, tabSource, onTrace, env = globalThis.process?.env ?? {},
  fetchImpl = globalThis.fetch, timeoutMs = 30000, model = createOpenRouterModel({ env, fetchImpl, timeoutMs }), triageModel = model, passageModel = model, onHighlight = () => {}, stopAfterPassages = false, mode = 'tight', gapModel = model, stopAfterCoverage = false, journal = () => {}, includeHistory = false, historySource = null, historyModel = model, maxReads = env.READ_LIMIT ?? DEFAULT_READ_LIMIT, progressive = false, peekModel = model, readConcurrency = 1 }) {
  maxReads = readLimit(maxReads);
  if (!Number.isInteger(readConcurrency) || readConcurrency < 1 || readConcurrency > 4) throw new Error('Read concurrency must be from 1 to 4');
  if (typeof includeHistory !== 'boolean') throw new Error('includeHistory must be a boolean');
  if (!['tight', 'loose'].includes(mode)) throw new Error('mode must be tight or loose');
  if (typeof onTrace !== 'function') throw new Error('onTrace callback is required');
  const emit = (kind, label, detail = '', ref = null) => {
    const event = { t: Date.now(), kind, label, detail, ref };
    isTraceEvent(event); // Deliberately outside tool/model error recovery.
    onTrace(event);
  };
  const tools = createTools({ tabSource, env, fetchImpl, timeoutMs });
  const schemas = toolSchemas.map(tool => ({ type: 'function', function: tool }));
  const messages = [];
  let reads = 0, peeks = 0, iterations = 0, triage = null, searches = 0, coveragePending = true;
  let peekSelection = null;
  const attemptedQueries = [], coverageAssessments = [], allReadTabs = new Map();
  const invalidAttempts = new Map();
  const pendingTabs = new Map();
  let passages = [];
  const passageSelections = [], historySelections = [];
  const historyTabs = new Map();
  let historyAttempted = false;
  const finish = (status, label) => {
    for (const warning of tabSource.diagnostics?.() ?? []) emit('note', warning);
    emit('done', label);
    return { status, skill: tools.getSkill(), reads, peeks, peekSelection, iterations, messages, triage, passages, passageSelections, searches, coverageAssessments, historySelections, mode };
  };
  let prompt;
  try { prompt = (await loadSystemPrompt()).replace('{readCap}', String(maxReads)); }
  catch (error) { emit('error', error.message); return finish('error', 'Stopped: system prompt unavailable.'); }
  messages.push({ role: 'system', content: prompt }, { role: 'user', content: goal }, { role: 'user', content: `Run mode: ${mode}. The host performs passage selection and coverage assessment before continuation. Web searches are executed by that coverage step only. Preserve source:web and firstVisit:null on web citations. Preserve source:history on reopened history pages. Dates are earliest retained visits, never guaranteed first-ever visits. Never describe web or history sources as tabs that were already open.` });
  emit('plan', `Goal: ${goal}`);
  emit('note', `Page budget: ${maxReads} reads shared across open tabs and history.`);
  // Enumerate once before the first model turn. Feed triage an explicit metadata
  // projection, not the full list result (which may include other shared fields).
  emit('tool', 'Listing tabs for triage');
  let tabs;
  journal('tool_call', { name: 'list_tabs', args: {} });
  try { tabs = await tools.handlers.list_tabs(); journal('tool_result', { name: 'list_tabs', result: tabs }); }
  catch (error) {
    journal('tool_result', { name: 'list_tabs', result: { error: { message: error.message } } });
    emit('result', `list_tabs failed: ${error.message}`);
    emit('error', 'Cannot triage without tab metadata.');
    return finish('error', 'Stopped before reading any tabs.');
  }
  emit('result', `Listed ${tabs.length} tabs for triage`);
  async function discoverHistory(query) {
    if (!includeHistory || historyAttempted) return false;
    historyAttempted = true;
    if (reads >= maxReads || iterations >= MAX_ITERATIONS - 1) {
      emit('note', 'History skipped: no read or model budget remains.'); return false;
    }
    if (!historySource?.search || !historySource?.open) {
      emit('note', 'History search unavailable in this host.'); return false;
    }
    emit('tool', 'Searching recent history', query);
    journal('tool_call', { name: 'history_search', args: { query, limit: HISTORY_LIMIT } });
    let candidates;
    try {
      const found = await historySource.search({ query, mode, excludeUrls: tabs.map(t => t.url), limit: HISTORY_LIMIT });
      if (!Array.isArray(found)) throw new Error('History source must return an array');
      const seenUrls = new Set(tabs.map(t => historyUrl(t.url))), seenIds = new Set();
      candidates = [];
      for (const raw of found) {
        const item = historyMetadata(raw), key = historyUrl(item.url);
        if (seenUrls.has(key) || seenIds.has(item.historyId)) continue;
        seenUrls.add(key); seenIds.add(item.historyId); candidates.push(item);
        if (candidates.length === HISTORY_LIMIT) break;
      }
      journal('tool_result', { name: 'history_search', result: candidates });
    } catch (error) {
      journal('tool_result', { name: 'history_search', result: { error: { message: error.message } } });
      emit('result', `History search unavailable: ${error.message}`); return false;
    }
    emit('result', `Found ${candidates.length} history candidates (metadata only)`);
    let selection;
    try {
      selection = await selectHistory({ goal, query, mode, candidates, cap: maxReads - reads,
        model: historyModel, maxModelCalls: Math.min(2, MAX_ITERATIONS - iterations - 1) });
      iterations += selection.modelCalls; historySelections.push(selection);
    } catch (error) {
      iterations += error.modelCalls ?? 1;
      emit('note', `History selection unavailable: ${error.message}`); return false;
    }
    if (selection.note) emit('plan', selection.note);
    if (selection.truncated) emit('note', `History reads capped to ${selection.open.length} remaining slots.`);
    await mapConcurrent(selection.open.slice(0, maxReads - reads), readConcurrency, async choice => {
      const candidate = candidates.find(c => c.historyId === choice.historyId);
      emit('tool', `Reopening history page: ${candidate.title}`, choice.why);
      journal('tool_call', { name: 'history_read', args: { historyId: candidate.historyId, url: candidate.url } });
      const readNumber = ++reads;
      let result, tab, reopenedMetadata;
      try {
        tab = await historySource.open(candidate); isTab(tab);
        if (!Number.isInteger(tab.id) || tab.id < 0 || historyUrl(tab.url) !== historyUrl(candidate.url)) throw new Error('History source returned an invalid page identity');
        if (tabs.some(t => t.id === tab.id && historyUrl(t.url) !== historyUrl(tab.url))) throw new Error('History source reused another tab ID');
        const { text, ...metadata } = tab;
        reopenedMetadata = metadata;
        if (!tabs.some(t => t.id === tab.id)) tabs.push(metadata);
        historyTabs.set(tab.id, candidate);
        result = await tools.handlers.read_tab({ id: tab.id });
        if (result.url && historyUrl(result.url) !== historyUrl(candidate.url)) throw new Error('History page navigated before extraction; source identity changed.');
        const snapshot = { ...metadata, ...result, firstVisit: candidate.firstVisit };
        pendingTabs.set(tab.id, snapshot); allReadTabs.set(tab.id, snapshot); coveragePending = true;
        messages.push({ role: 'user', content: `Reopened history source: ${JSON.stringify({ ...candidate, tabId: tab.id, source: 'history' })}` },
          { role: 'assistant', content: null, tool_calls: [{ id: `history-read-${readNumber}`, type: 'function', function: { name: 'read_tab', arguments: JSON.stringify({ id: tab.id }) } }] },
          { role: 'tool', tool_call_id: `history-read-${readNumber}`, content: JSON.stringify(result) });
      } catch (error) { result = { error: { message: error.message } }; }
      journal('tool_result', { name: 'history_read', result, ...(reopenedMetadata ? { tab: reopenedMetadata } : {}) });
      emit('result', result.error ? `History page unavailable: ${result.error.message}` : `History page ${tab.id}: ${result.textStatus}, ${result.text?.length ?? 0} characters`);
    });
    return pendingTabs.size > 0;
  }

  try {
    const initialReadCap = includeHistory && maxReads > 8 ? maxReads - Math.min(8, Math.floor(maxReads / 3)) : maxReads;
    const previewing = progressive && typeof tabSource.peek === 'function';
    const candidates = tabs.length > 50 && tabSource.candidates ? await tabSource.candidates(goal, mode) : undefined;
    triage = await runTriage({ goal, tabs, mode, candidates, cap: previewing ? Math.min(MAX_PEEKS, Math.max(20, initialReadCap)) : initialReadCap, model: triageModel,
      onTrace: event => { isTraceEvent(event); onTrace(event); } });
    iterations = triage.modelCalls;
    if (previewing && triage.open.length) {
      emit('plan', `Previewing ${triage.open.length} candidates before committing full reads.`);
      const previews = await mapConcurrent(triage.open, readConcurrency, async choice => {
        const id = `peek-${++peeks}`, args = { id: choice.id };
        emit('tool', 'Peeking at tab', choice.why, choice.id);
        journal('tool_call', { name: 'peek_tab', args, id });
        let result;
        try { result = await tools.handlers.peek_tab(args); }
        catch (error) { result = { id: choice.id, description: '', heading: '', paragraph: '', textStatus: 'error', error: { message: error.message ?? String(error) } }; }
        journal('tool_result', { name: 'peek_tab', result, id });
        emit('result', `Preview ${choice.id}: ${result.textStatus}`, result.error?.message ?? '', choice.id);
        return result;
      });
      if (previews.every(p => p.textStatus === 'error' || p.textStatus === 'blocked')) {
        emit('error', 'No preview could be read. Open a selected source tab and retry; browser extraction must work before continuing.');
        return finish('error', 'Stopped: all previews were unavailable; no further model calls or skill output.');
      }
      const selectedIds = new Set(triage.open.map(t => t.id));
      peekSelection = await selectPeeks({ goal, tabs: tabs.filter(t => selectedIds.has(t.id)), previews, cap: initialReadCap, model: peekModel, mode });
      iterations += peekSelection.modelCalls;
      const kept = new Set(peekSelection.open.map(c => c.id));
      triage.skip.push(...triage.open.filter(c => !kept.has(c.id)).map(c => ({ id: c.id, why: 'Preview did not warrant a full read.' })));
      triage.open = peekSelection.open;
      triage.note = peekSelection.note ?? triage.note;
      if (peekSelection.truncated) emit('note', `Preview selection exceeded the read budget; dropped ${peekSelection.truncated}.`);
      emit('note', `Peeked ${previews.length}; selected ${triage.open.length} full reads.`);
    }
  } catch (error) {
    iterations += error.modelCalls ?? 1;
    triage = { rawOutputs: error.rawOutputs ?? [] };
    if (!error.traceEmitted) emit('error', error.message);
    return finish('error', 'Stopped: triage failed before any tab reads.');
  }
  emit('plan', triage.note ?? `Selected ${triage.open.length} of ${tabs.length} tabs.`);
  const duplicates = triage.skip.filter(choice => /^duplicate:/i.test(choice.why)).length;
  emit('note', `Skipped ${triage.skip.length}: ${duplicates} duplicates, ${triage.skip.length - duplicates} other skips.`);
  // Preserve a normal tool conversation for subsequent reasoning. The host, not
  // a second model decision, executes the validated initial selection.
  if (tabs.length > 50) {
    const selected = new Set(triage.open.map(t => t.id));
    messages.push({ role: 'user', content: `Local metadata triage selected these tabs from ${tabs.length} open tabs: ${JSON.stringify(tabs.filter(t => selected.has(t.id)))}. Decisions: ${JSON.stringify(triage.open)}. Skipped ${triage.skip.length}. The selected tabs are now being read; continue from their results without repeating triage.` });
  } else messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'triage-list', type: 'function', function: { name: 'list_tabs', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'triage-list', content: JSON.stringify(tabs) },
    { role: 'user', content: `Metadata triage completed: ${JSON.stringify({ open: triage.open, skip: triage.skip, note: triage.note })}. The selected tabs are now being read. Continue from their results without repeating triage.` });
  let initialReads = triage.open.length ? {
    role: 'assistant', content: null,
    tool_calls: triage.open.map(({ id }, i) => ({ id: `triage-read-${i}`, type: 'function', function: { name: 'read_tab', arguments: JSON.stringify({ id }) } }))
  } : null;
  while (initialReads || iterations < MAX_ITERATIONS) {
    if (!initialReads && pendingTabs.size) {
      const batch = mode === 'loose' ? allReadTabs : new Map([...pendingTabs].slice(0, PASSAGE_BATCH_SIZE));
      emit('plan', `Selecting passages from ${batch.size} read tabs.`);
      let selection;
      try {
        selection = await selectPassages({ goal, tabs: [...batch.values()], model: passageModel, mode,
          maxModelCalls: MAX_ITERATIONS - iterations });
        iterations += selection.modelCalls;
      } catch (error) {
        iterations += error.modelCalls ?? 1;
        passageSelections.push({ rawOutputs: error.rawOutputs ?? [] });
        emit('error', error.message);
        return finish('error', 'Stopped: passage selection failed.');
      }
      passageSelections.push(selection);
      const enriched = selection.passages.map(p => {
        const history = historyTabs.get(p.tabId), tab = allReadTabs.get(p.tabId);
        return { ...p, source: history ? 'history' : 'tab', url: tab?.url, firstVisit: tab?.firstVisit ?? null,
          ...(history ? { historyId: history.historyId, lastVisit: history.lastVisit } : {}) };
      });
      passages = (mode === 'loose' ? [] : passages.filter(passage => !batch.has(passage.tabId))).concat(enriched);
      if (mode === 'loose') {
        if (selection.none) emit('note', selection.none);
        for (const p of enriched) emit('note', `Rhyme: tab ${p.tabId}, ${p.ageMonths === null ? 'age unknown' : p.ageMonths + ' months old'}`, p.connection, p.tabId);
      }
      const { repaired, failed } = selection.verification;
      if (repaired.length || failed.length) emit('note', `Quotes: repaired ${repaired.length}, dropped ${failed.length}.`);
      for (const item of selection.empty) emit('note', `Tab ${item.tabId}: no procedural passages.`, item.why, item.tabId);
      // Only sanitized, verified spans enter the continuing model conversation.
      messages.push({ role: 'user', content: `Use only these verified passages as quoted evidence for these tabs: ${JSON.stringify({ passages: enriched, empty: selection.empty })}` });
      for (const tabId of batch.keys()) {
        await onHighlight({ tabId, quotes: selection.passages.filter(p => p.tabId === tabId).map(p => p.quote) });
      }
      for (const tabId of batch.keys()) pendingTabs.delete(tabId);
      if (pendingTabs.size) continue;
    }
    if (!initialReads && mode === 'loose' && await discoverHistory(goal)) continue;
    if (!initialReads && stopAfterPassages) return finish('passages', 'Passage selection and verification completed.');
    if (!initialReads && mode === 'tight' && coveragePending && searches < MAX_SEARCHES && iterations < MAX_ITERATIONS) {
      let coverage;
      try {
        coverage = await assessGaps({ goal, passages, queries: attemptedQueries, model: gapModel, maxModelCalls: MAX_ITERATIONS - iterations });
        iterations += coverage.modelCalls;
      } catch (error) {
        iterations += error.modelCalls ?? 1;
        emit('error', error.message); return finish('error', 'Stopped: coverage assessment failed.');
      }
      coverageAssessments.push(coverage);
      if (includeHistory && !historyAttempted && coverage.gaps.length) {
        emit('note', `${coverage.covered} Missing: ${coverage.gaps.map(g => g.missing).join('; ')}`);
        if (await discoverHistory(coverage.gaps.map(g => g.query).join(' '))) continue;
      }
      const remaining = MAX_SEARCHES - searches;
      if (coverage.gaps.length > remaining) emit('note', `Search cap: considering only ${remaining} remaining gaps.`);
      const fresh = coverage.gaps.filter((gap, i, list) => !attemptedQueries.includes(gap.query) && list.findIndex(g => g.query === gap.query) === i).slice(0, remaining);
      for (const gap of fresh) {
        emit('note', `${coverage.covered} Missing: ${gap.missing}`);
        const callId = `gap-search-${searches + 1}`, args = { query: gap.query };
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'web_search', arguments: JSON.stringify(args) } }] });
        emit('tool', `Searching the web for ${gap.missing}`, gap.query);
        journal('tool_call', { name: 'web_search', args, id: callId });
        searches++; attemptedQueries.push(gap.query);
        let result;
        try { result = await tools.handlers.web_search(args); }
        catch (error) { result = { error: { message: error.message } }; }
        journal('tool_result', { name: 'web_search', result, id: callId });
        messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(result) });
        const unavailable = Array.isArray(result) && result.some(r => r.stub);
        emit('result', result.error ? `Search failed: ${result.error.message}` : unavailable ? 'Web search unavailable: marked stub returned' : `Found ${result.length} sources on ${gap.missing}`);
        if (unavailable) emit('note', 'Search is unavailable. Set ENABLE_EXA=1 and EXA_API_KEY to enable it.');
        if (Array.isArray(result)) for (const source of result.filter(r => !r.stub)) {
          for (const quote of source.highlights) passages.push({ quote, why: gap.missing, title: source.title, url: source.url, source: 'web', firstVisit: null });
        }
      }
      messages.push({ role: 'user', content: `Coverage assessed. Use these passages with their provenance intact: ${JSON.stringify(passages)}. Attempted searches: ${searches}/${MAX_SEARCHES}.` });
      coveragePending = false;
    }
    if (!initialReads && stopAfterCoverage) return finish('coverage', 'Passages and coverage assessment completed.');
    if (!initialReads && iterations >= MAX_ITERATIONS) break;
    let response;
    const isInitialRead = initialReads !== null;
    try {
      if (isInitialRead) { response = initialReads; initialReads = null; }
      else { iterations++; response = await model({ messages: structuredClone(messages), tools: schemas }); }
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
    const executeCall = async call => {
      const name = call.function.name;
      let args, result, ref = null;
      try { args = JSON.parse(call.function.arguments); } catch { /* Report below as a tool result. */ }
      if (Number.isFinite(args?.id)) ref = args.id;
      const choice = isInitialRead ? triage.open.find(choice => choice.id === ref) : null;
      emit('tool', choice ? `Opening ${tabs.find(tab => tab.id === ref)?.title ?? ref}` : `Calling ${name}`,
        choice?.why ?? (typeof args?.query === 'string' ? args.query : ''), ref);
      journal('tool_call', { name, args: args ?? null, id: call.id });
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
          if (reads >= maxReads) throw new Error(`Read budget exhausted: all ${maxReads} read_tab calls used. Use already-read tabs or finish.`);
          reads++; // Failed and blocked reads consume budget too.
        }
        if (name === 'peek_tab') {
          if (peeks >= MAX_PEEKS) throw new Error(`Peek budget exhausted: ${MAX_PEEKS} previews used.`);
          peeks++;
        }
        if (name === 'web_search') throw new Error(mode === 'loose' ? 'Gap-fill search is tight-mode only.' : 'Search is host-managed: coverage must name the gap before searching; at most two searches per run.');
        if (name === 'write_skill' && pendingTabs.size) throw new Error('Newly read tabs need passage verification first. Retry write_skill after verification.');
        if (name === 'write_skill') {
          // Preserve provenance at the host boundary; the writer/Markdown format is unchanged.
          const webUrls = new Set(passages.filter(p => p.source === 'web').map(p => p.url));
          const historyByUrl = new Map(passages.filter(p => p.source === 'history').map(p => [p.url, p]));
          args = { ...args, sources: args.sources.map(source => {
            const history = historyByUrl.get(source.url);
            if (history) return { ...source, source: 'history', historyId: history.historyId, firstVisit: history.firstVisit, lastVisit: history.lastVisit };
            return webUrls.has(source.url) ? { ...source, source: 'web', firstVisit: null } : source;
          }) };
        }
        result = await tools.handlers[name](args);
        if (name === 'read_tab') {
          const expectedUrl = tabs.find(tab => tab.id === args.id)?.url;
          if (result.url && expectedUrl && historyUrl(result.url) !== historyUrl(expectedUrl)) throw new Error('Tab navigated since selection; refusing to quote a different page.');
          const snapshot = { ...tabs.find(tab => tab.id === args.id), ...result };
          pendingTabs.set(args.id, snapshot); allReadTabs.set(args.id, snapshot); coveragePending = true;
        }
      } catch (error) { result = { error: { message: error instanceof Error ? error.message : String(error) } }; }
      journal('tool_result', { name, result, id: call.id });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      let label = result.error ? `${name} failed: ${result.error.message}` : `${name} completed`;
      if (name === 'list_tabs' && !result.error) label = `Listed ${result.length} tabs (metadata only)`;
      if (name === 'read_tab' && !result.error) label = `Tab ${ref}: ${result.textStatus}, ${result.text?.length ?? 0} characters${result.cached ? ' (verified cache hit)' : ''}`;
      if (name === 'peek_tab' && !result.error) label = `Preview ${ref}: ${result.textStatus}`;
      if (name === 'search_in_tab' && !result.error) label = `Found ${result.excerpts.length} excerpts`;
      if (name === 'web_search' && !result.error) label = result[0]?.title?.startsWith('[STUB') ? 'Web search unavailable: marked stub returned' : `Found ${result.length} web results`;
      emit('result', label, '', ref);
    };
    // Only adjacent independent reads/previews overlap; writes and searches are barriers.
    for (let i = 0; i < calls.length;) {
      const name = calls[i].function.name;
      if (name === 'read_tab' || name === 'peek_tab') {
        let end = i + 1;
        while (end < calls.length && calls[end].function.name === name) end++;
        await mapConcurrent(calls.slice(i, end), readConcurrency, executeCall);
        i = end;
      } else await executeCall(calls[i++]);
    }
    if (tools.getSkill()) return finish('complete', 'write_skill completed.');
  }
  iterations = MAX_ITERATIONS;
  return finish('partial', 'Iteration limit reached (20). Returning partial result.');
}

/** Recording/replay is confined to the host. The consumers receive the same events. */
export async function runAgent(options) {
  const env = options.env ?? globalThis.process?.env ?? {};
  if (env.RECORD === '1' && env.REPLAY === '1') throw new Error('Use RECORD=1 or REPLAY=1, not both.');
  if (typeof options.onTrace !== 'function') throw new Error('onTrace callback is required');
  const deliverTrace = event => { isTraceEvent(event); return options.onTrace(event); };
  const deliverHighlight = payload => (options.onHighlight ?? (() => {}))(payload);
  const fixturePath = options.fixturePath ?? new URL('./fixtures/golden-run.json', import.meta.url);
  if (env.REPLAY === '1') {
    if (!globalThis.process?.versions?.node) throw new Error('Fixture replay requires the local Node host.');
    const { readFile } = await import('node:fs/promises');
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    const speed = Number(env.REPLAY_SPEED ?? 1);
    if (!Number.isFinite(speed) || speed <= 0) throw new Error('REPLAY_SPEED must be a positive speed multiplier.');
    if (fixture.version !== 1 || !Array.isArray(fixture.events) || !Array.isArray(fixture.referencedTabs) || !fixture.result || fixture.result.status !== 'complete') throw new Error('Invalid or incomplete replay fixture.');
    let previous = 0;
    const references = new Set(fixture.referencedTabs.map(tab => tab.id));
    for (const entry of fixture.events) {
      if (!Number.isFinite(entry.at) || entry.at < previous || !['trace', 'highlight', 'model_response', 'tool_call', 'tool_result'].includes(entry.kind)) throw new Error('Invalid replay event or timestamp.');
      previous = entry.at;
      if (entry.kind === 'trace') isTraceEvent(entry.data);
      if (entry.kind === 'highlight' && (!references.has(entry.data?.tabId) || !Array.isArray(entry.data.quotes) || !entry.data.quotes.every(q => typeof q === 'string'))) throw new Error('Invalid replay highlight reference.');
    }
    // Enumerate actual tabs before emitting any captured output; no model, page read,
    // or web search is performed. MessageTabSource may use its local transport.
    const currentTabs = await options.tabSource.list();
    const missing = fixture.referencedTabs.filter(tab => !currentTabs.some(current => current.id === tab.id && current.url === tab.url));
    if (missing.length) {
      const message = `Replay cannot start: recorded tab IDs absent or showing different URLs: ${missing.map(t => t.id).join(', ')}. Restore the recorded demo tabs/profile.`;
      deliverTrace({ t: Date.now(), kind: 'error', label: message, detail: '', ref: null });
      throw new Error(message);
    }
    const started = performance.now();
    for (const entry of fixture.events) {
      if (!['trace', 'highlight'].includes(entry.kind)) continue;
      const delay = entry.at / speed - (performance.now() - started);
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      if (entry.kind === 'trace') await deliverTrace(structuredClone(entry.data));
      else await deliverHighlight(structuredClone(entry.data));
    }
    return structuredClone(fixture.result);
  }
  const recording = env.RECORD === '1';
  if (recording && !globalThis.process?.versions?.node) throw new Error('Recording requires the local Node host.');
  const started = performance.now(), events = [];
  const journal = (kind, data) => { if (recording) events.push({ at: performance.now() - started, kind, data: structuredClone(data) }); };
  const baseModel = options.model ?? createOpenRouterModel({ env, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
  const wrap = model => async request => {
    const response = await model(request);
    journal('model_response', { phase: request.phase ?? 'tools', response });
    return response;
  };
  const result = await runLive({ ...options, env, mode: options.mode ?? env.AGENT_MODE ?? 'tight', journal,
    model: wrap(baseModel), triageModel: wrap(options.triageModel ?? baseModel), peekModel: wrap(options.peekModel ?? baseModel), passageModel: wrap(options.passageModel ?? baseModel), gapModel: wrap(options.gapModel ?? baseModel), historyModel: wrap(options.historyModel ?? baseModel),
    onTrace(event) { journal('trace', event); return deliverTrace(event); },
    onHighlight(payload) { journal('highlight', payload); return deliverHighlight(payload); }
  });
  if (recording) {
    // A failed/partial run must never replace a usable golden capture.
    if (result.status !== 'complete') throw new Error(`Not recording golden fixture: run ended ${result.status}. Existing fixture preserved.`);
    const metadata = events.flatMap(e => e.kind === 'tool_result' && !e.data.result?.error ? (e.data.name === 'list_tabs' && Array.isArray(e.data.result) ? e.data.result : e.data.name === 'history_read' && e.data.tab ? [e.data.tab] : []) : []);
    const ids = new Set(events.filter(e => e.kind === 'highlight').map(e => e.data.tabId));
    for (const e of events) if (e.kind === 'tool_result' && ['read_tab', 'history_read'].includes(e.data.name) && !e.data.result.error) ids.add(e.data.result.id);
    for (const e of events) if (e.kind === 'tool_result' && e.data.name === 'peek_tab' && metadata.some(t => t.id === e.data.result?.id)) ids.add(e.data.result.id);
    const referencedTabs = [...ids].map(id => {
      const tab = metadata.find(tab => tab.id === id);
      if (!tab) throw new Error(`Cannot record missing tab metadata for ${id}`);
      return { id, url: tab.url };
    });
    const fixture = { _header: 'Captured run. Tab IDs AND URLs must match the open tabs in the same demo Chrome profile. Do not close/reopen or navigate these tabs after recording. StubTabSource captures are plumbing fixtures, not browser-demo insurance.', version: 1, tabSourceType: options.tabSource.constructor?.name ?? 'injected', recordedAt: new Date().toISOString(), goal: options.goal, referencedTabs, events, result };
    const { mkdir, writeFile, rename } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const path = fixturePath instanceof URL ? fileURLToPath(fixturePath) : fixturePath;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${globalThis.crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  }
  return result;
}
