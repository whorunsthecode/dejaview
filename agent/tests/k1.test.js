import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, createOpenRouterModel } from '../host.js';
import { createTools, validateArguments } from '../tools.js';
import { StubTabSource, MessageTabSource } from '../tab-sources.js';
import { createOfflineModel } from '../offline-model.js';
import { isTraceEvent } from '../../shared/types.js';
import { MSG } from '../../shared/messages.js';

const payload = { name: 'test', description: 'test', body: 'test', sources: [] };
let nextId = 0;
const call = (name, args = {}) => ({ id: `test-${++nextId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
function scripted(responses) { let index = 0; return async () => responses[index++]; }
async function run(model, options = {}) {
  const events = [];
  const result = await runAgent({ goal: 'test', tabSource: new StubTabSource(), env: {}, model,
    onTrace: event => { isTraceEvent(event); events.push(event); },
    gapModel: async () => ({ role: 'assistant', content: JSON.stringify({ covered: 'Isolated K1 test.', gaps: [] }) }),
    passageModel: async ({ messages }) => ({ role: 'assistant', content: JSON.stringify({ passages: [], empty: JSON.parse(messages.at(-1).content).tabs.map(tab => ({ tabId: tab.id, why: 'Isolated K1 test.' })) }) }),
    triageModel: async ({ messages }) => ({ role: 'assistant', content: JSON.stringify({ open: [], skip: JSON.parse(messages.at(-1).content).tabs.map(tab => ({ id: tab.id, why: 'Deferred for isolated tool-loop test.' })), note: null }) }), ...options });
  const pairs = events.filter(event => ['tool', 'result'].includes(event.kind));
  assert.equal(pairs.length % 2, 0);
  for (let i = 0; i < pairs.length; i += 2) {
    assert.equal(pairs[i].kind, 'tool'); assert.equal(pairs[i + 1].kind, 'result');
    assert.equal(pairs[i].ref, pairs[i + 1].ref);
  }
  return { result, events, outputs: result.messages.filter(m => m.role === 'tool' && m.tool_call_id !== 'triage-list').map(m => JSON.parse(m.content)) };
}

test('offline fixture completes via write_skill with blocked and thrown reads', async () => {
  const { result, outputs } = await run(createOfflineModel());
  assert.equal(result.status, 'complete');
  assert.ok(result.reads >= 1 && result.reads <= 8);
  assert.ok(outputs.some(x => x.textStatus === 'blocked' && x.text === null));
  assert.ok(outputs.some(x => x.error?.message.includes('Unknown tab')));
  assert.deepEqual(outputs.at(-1), { ok: true });
  assert.ok(outputs[0].every(tab => !Object.hasOwn(tab, 'text')));
});

test('hard cap survives a batch, with failures consuming budget', async () => {
  let readCount = 0;
  const tabSource = { list: async () => [], read: async () => { readCount++; throw new Error('broken'); } };
  const { result, outputs } = await run(scripted([
    reply(...Array.from({ length: 10 }, () => call('read_tab', { id: 481 }))),
    reply(call('write_skill', payload))
  ]), { tabSource });
  assert.equal(readCount, 8); assert.equal(result.reads, 8);
  assert.match(outputs[8].error.message, /budget exhausted/);
  assert.equal(result.status, 'complete');
});

test('search requires a read and excerpts are verbatim; blocked/empty/error are normal', async () => {
  const source = new StubTabSource();
  const tools = createTools({ tabSource: source });
  await assert.rejects(tools.handlers.search_in_tab({ id: 481, query: 'token' }), /before searching/);
  const { text } = await tools.handlers.read_tab({ id: 481 });
  const { excerpts } = await tools.handlers.search_in_tab({ id: 481, query: 'token' });
  assert.ok(excerpts.length); assert.ok(excerpts.every(x => text.includes(x)));
  for (const textStatus of ['blocked', 'empty', 'error']) {
    const t = createTools({ tabSource: { read: async id => ({ id, text: null, textStatus }) } });
    assert.deepEqual(await t.handlers.read_tab({ id: 1 }), { id: 1, text: null, textStatus });
  }
});

test('malformed JSON gets one correction opportunity; repeated invalid arguments disable tool', async () => {
  const malformed = call('read_tab'); malformed.function.arguments = '{';
  const { outputs, result } = await run(scripted([
    reply(malformed), reply(call('read_tab', { id: 'wrong' })),
    reply(call('read_tab', { id: 481 })), reply(call('write_skill', payload))
  ]));
  assert.match(outputs[0].error.message, /Retry once/);
  assert.match(outputs[1].error.message, /Retry exhausted/);
  assert.match(outputs[2].error.message, /disabled/);
  assert.equal(result.reads, 0);
  const corrected = await run(scripted([reply(malformed), reply(call('read_tab', { id: 481 })), reply(call('write_skill', payload))]));
  assert.equal(corrected.result.reads, 1);
});

test('runtime schema checks nested sources and unexpected fields', () => {
  assert.throws(() => validateArguments('list_tabs', { text: true }), /unexpected/);
  assert.throws(() => validateArguments('write_skill', { ...payload, sources: [{ url: 'x' }] }), /firstVisit/);
  assert.throws(() => validateArguments('search_in_tab', { id: 1, query: '' }), /empty/);
});

test('terminal tool only writes once, and subsequent batch tools never execute', async () => {
  let called = false;
  const { result, outputs } = await run(scripted([reply(call('write_skill', payload), call('write_skill', payload), call('read_tab', { id: 481 }))]),
    { tabSource: { list: async () => [], read: async () => { called = true; } } });
  assert.equal(called, false); assert.equal(result.status, 'complete');
  assert.deepEqual(outputs[0], { ok: true });
  assert.match(outputs[1].error.message, /only be called once/);
  assert.ok(outputs[2].error);
  const tools = createTools({ tabSource: {} });
  await tools.handlers.write_skill(payload);
  await assert.rejects(tools.handlers.write_skill(payload), /once/);
});

test('20 iterations produce a partial result and done', async () => {
  const { result, events } = await run(async () => ({ role: 'assistant', content: 'still thinking' }));
  assert.equal(result.status, 'partial'); assert.equal(result.iterations, 20);
  assert.equal(events.at(-1).kind, 'done');
});

test('trace callback errors remain loud, not swallowed as tool errors', async () => {
  await assert.rejects(runAgent({ goal: 'test', tabSource: new StubTabSource(), model: scripted([reply(call('list_tabs'))]),
    onTrace: event => { if (event.kind === 'result') throw new Error('trace sink failed'); } }), /trace sink failed/);
});

test('OpenRouter sends tools and retries network failures only once', async () => {
  let requests = 0;
  const fetchImpl = async (url, init) => {
    requests++;
    assert.match(url, /openrouter/);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'test-model'); assert.equal(body.tools.length, 5);
    if (requests === 1) throw new TypeError('network');
    return new Response(JSON.stringify({ choices: [{ message: reply(call('write_skill', payload)) }] }));
  };
  const { result } = await run(createOpenRouterModel({ env: { OPENROUTER_API_KEY: 'fake', OPENROUTER_MODEL: 'test-model' }, fetchImpl }));
  assert.equal(result.status, 'complete'); assert.equal(requests, 2);
  for (const response of [() => new Response('denied', { status: 401 }), () => new Response('not JSON')]) {
    let count = 0;
    const model = createOpenRouterModel({ env: { OPENROUTER_API_KEY: 'fake' }, fetchImpl: async () => { count++; return response(); } });
    assert.equal((await run(model)).result.status, 'error'); assert.equal(count, 1);
  }
});

test('network timeouts abort and stop cleanly after one retry', async () => {
  let attempts = 0;
  const model = createOpenRouterModel({ env: { OPENROUTER_API_KEY: 'fake' }, timeoutMs: 5,
    fetchImpl: async (_, { signal }) => {
      attempts++;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
  const { result, events } = await run(model);
  assert.equal(attempts, 2); assert.equal(result.status, 'error');
  assert.ok(events.some(event => event.kind === 'error' && /timed out/.test(event.label)));
});

test('Exa is gated, clearly stubbed, and normalizes enabled responses', async () => {
  const off = createTools({ tabSource: {}, fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.match((await off.handlers.web_search({ query: 'x' }))[0].title, /STUB/);
  let calls = 0;
  const live = createTools({ tabSource: {}, env: { ENABLE_EXA: '1', EXA_API_KEY: 'fake' }, fetchImpl: async (_, init) => {
    calls++; assert.equal(JSON.parse(init.body).contents.highlights, true);
    return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://example.com', highlights: ['q'], score: 1 }] }));
  } });
  assert.deepEqual(await live.handlers.web_search({ query: 'x' }), [{ title: 't', url: 'https://example.com', highlights: ['q'], source: 'web', firstVisit: null }]);
  assert.equal(calls, 1);
});

test('message adapter correlates concurrent replies and cleans up; times out without responder', async () => {
  const listeners = new Set();
  // Test-only codec. This is not a proposal for the shared wire contract.
  const protocol = { requestType: MSG.RUN, responseType: MSG.TRACE,
    encodeRequest: x => x, decodeResponse: x => x };
  const onMessage = (_, callback) => { listeners.add(callback); return () => listeners.delete(callback); };
  const source = new MessageTabSource({ protocol, onMessage, sendMessage: (_, request) => {
    queueMicrotask(() => {
      for (const callback of [...listeners]) callback({ requestId: request.requestId, result: request.operation === 'list' ? [] : { id: request.id, text: null, textStatus: 'blocked' } });
    });
  } });
  const [list, read] = await Promise.all([source.list(), source.read(486)]);
  assert.deepEqual(list, []); assert.equal(read.id, 486); assert.equal(listeners.size, 0);
  const missing = new MessageTabSource({ protocol, onMessage, sendMessage: () => {}, timeoutMs: 5 });
  await assert.rejects(missing.list(), /timed out/); assert.equal(listeners.size, 0);
  assert.throws(() => new MessageTabSource({}), /agreed/);
});
