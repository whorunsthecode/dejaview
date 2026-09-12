import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, createOpenRouterModel } from '../host.js';
import { selectPassages } from '../passages.js';
import { StubTabSource } from '../tab-sources.js';
const json = value => ({ role: 'assistant', content: JSON.stringify(value) });
const source = new StubTabSource();
const call = (name, args, id = name) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const payload = { name: 'test', description: 'test', body: 'test', sources: [{ url: 'https://example.org/gap', firstVisit: 123 }] };
const triage = async ({ messages }) => {
  const tabs = JSON.parse(messages.at(-1).content).tabs;
  return json({ open: [{ id: 481, why: 'Documents device authorization and polling steps.' }], skip: tabs.filter(t => t.id !== 481).map(t => ({ id: t.id, why: 'Outside the isolated coverage fixture.' })), note: null });
};
const select = async ({ messages }) => json({ passages: JSON.parse(messages.at(-1).content).tabs.map(t => ({ tabId: t.id, quote: t.text.split('\n\n')[0], why: 'Explains the procedure.' })), empty: [] });
const gaps = async () => json({ covered: 'Your tabs cover device polling.', gaps: [1, 2, 3].map(i => ({ missing: `Missing deployment constraint ${i}`, query: `constraint ${i}` })) });
async function coverage(options = {}) {
  const events = [], highlights = [];
  const result = await runAgent({ goal: 'Device polling and deployment constraints', tabSource: source,
    triageModel: triage, passageModel: select, gapModel: gaps, model: async () => call('write_skill', payload),
    env: {}, onTrace: e => events.push(e), onHighlight: p => highlights.push(p), ...options });
  return { result, events, highlights };
}
test('gap note precedes each actual search; host caps excess gaps at two and preserves web provenance', async () => {
  let fetched = 0;
  const { result, events, highlights } = await coverage({ env: { ENABLE_EXA: '1', EXA_API_KEY: 'test' }, fetchImpl: async (_, init) => {
    assert.equal(JSON.parse(init.body).contents.highlights, true);
    fetched++;
    return new Response(JSON.stringify({ results: [{ title: 'External procedure', url: 'https://example.org/gap', highlights: ['An exact Exa excerpt.'] }] }));
  } });
  assert.equal(result.status, 'complete'); assert.equal(fetched, 2); assert.equal(result.searches, 2);
  const indices = events.map((e, i) => e.kind === 'tool' && e.label.startsWith('Searching the web') ? i : -1).filter(i => i >= 0);
  assert.equal(indices.length, 2);
  for (const i of indices) {
    assert.equal(events[i - 1].kind, 'note'); assert.match(events[i - 1].label, /Missing:/);
    assert.equal(events[i + 1].kind, 'result'); assert.match(events[i + 1].label, /Found 1 sources/);
  }
  const web = result.passages.filter(p => p.source === 'web');
  assert.equal(web.length, 2); assert.ok(web.every(p => p.firstVisit === null));
  assert.deepEqual(result.skill.sources, [{ url: 'https://example.org/gap', source: 'web', firstVisit: null }]);
  const replies = result.messages.filter(m => m.role === 'tool' && m.tool_call_id.startsWith('gap-search')).map(m => JSON.parse(m.content));
  assert.ok(replies.flat().every(r => r.source === 'web' && r.firstVisit === null));
  assert.ok(highlights.every(p => p.tabId === 481));
});
test('missing key produces marked stubs and unavailable notes without fetching', async () => {
  const { result, events } = await coverage({ env: { ENABLE_EXA: '1' }, fetchImpl: () => { throw new Error('Must not fetch'); } });
  assert.equal(result.status, 'complete'); assert.equal(result.searches, 2);
  assert.ok(events.some(e => e.kind === 'note' && /Search is unavailable/.test(e.label)));
  assert.ok(!result.passages.some(p => p.source === 'web'));
  const stub = JSON.parse(result.messages.find(m => m.tool_call_id === 'gap-search-1').content)[0];
  assert.equal(stub.stub, true); assert.equal(stub.source, 'web');
});
test('a model search cannot bypass the coverage gate; errors remain recoverable', async () => {
  let turns = 0, fetched = 0;
  const { result } = await coverage({ gapModel: async () => json({ covered: 'Covered.', gaps: [] }),
    fetchImpl: () => { fetched++; throw new Error('Must not fetch'); },
    model: async () => ++turns === 1 ? call('web_search', { query: 'unannounced search' }) : call('write_skill', payload) });
  assert.equal(result.status, 'complete'); assert.equal(fetched, 0);
  assert.match(result.messages.find(m => m.tool_call_id === 'web_search').content, /host-managed/);
});
test('Exa failures emit results after gap notes and do not crash the run', async () => {
  const { result, events } = await coverage({ env: { ENABLE_EXA: '1', EXA_API_KEY: 'test' }, fetchImpl: async () => { throw new Error('network unavailable'); } });
  assert.equal(result.status, 'complete'); assert.equal(result.searches, 2);
  assert.equal(events.filter(e => e.kind === 'result' && /Search failed/.test(e.label)).length, 2);
});
test('loose mode verifies quotes, emits age/mechanism, and never assesses gaps', async () => {
  const tabs = await source.list(), old = tabs.find(t => t.id === 485), events = [], highlights = [];
  const result = await runAgent({ goal: 'Choose a prototype to learn an unknown constraint', mode: 'loose', tabSource: source, env: {}, stopAfterPassages: true,
    triageModel: async () => json({ open: [{ id: 485, why: 'Tests designs by shipping a learning prototype.' }], skip: tabs.filter(t => t.id !== 485).map(t => ({ id: t.id, why: 'Outside this isolated structural comparison.' })), note: null }),
    passageModel: async () => json({ rhymes: [{ tabId: 485, quote: old.text.split('\n\n')[0], connection: 'Ship a disposable version to expose the unknown constraint before choosing a production design.' }], none: null }),
    gapModel: () => { throw new Error('Loose mode must not assess gaps'); }, onTrace: e => events.push(e), onHighlight: p => highlights.push(p) });
  assert.equal(result.passages[0].source, 'tab'); assert.ok(result.passages[0].ageMonths > 20);
  assert.ok(events.some(e => e.kind === 'note' && /months old/.test(e.label) && /unknown constraint/.test(e.detail)));
  assert.ok(old.text.includes(highlights[0].quotes[0]));
});
test('loose schema rejects a fourth rhyme and unknown IDs; invalid modes reject', async () => {
  const tabs = (await source.list()).filter(t => t.id === 485);
  await assert.rejects(selectPassages({ goal: 'test', tabs, mode: 'loose', model: async () => json({ rhymes: Array.from({ length: 4 }, () => ({ tabId: 485, quote: 'x', connection: 'y' })), none: null }) }), /three rhymes/);
  await assert.rejects(selectPassages({ goal: 'test', tabs, mode: 'third', model: () => {} }), /tight or loose/);
});

export const LOOSE_GOAL = 'We are designing a community pop-up kitchen. We cannot choose between two service layouts because we do not yet know where diners queue. How should we choose a small disposable pilot that reveals the real bottleneck before committing to the permanent layout?';
export const NO_RHYME_GOAL = 'Return the exact 64-digit hexadecimal SHA-256 digest of a sealed random file that is not present in any tab. No design decision, analogy, or procedure is requested.';

test('live loose selection surfaces old tangential tab in at least two of three runs', { skip: !process.env.OPENROUTER_API_KEY }, async () => {
  const tabs = (await source.list()).filter(t => [481, 482, 483, 484, 485, 486].includes(t.id));
  const model = createOpenRouterModel({ env: process.env });
  let hits = 0;
  for (let i = 0; i < 3; i++) {
    const result = await selectPassages({ goal: LOOSE_GOAL, tabs, model, mode: 'loose' });
    console.log(`Loose ${i + 1}: ${JSON.stringify(result.passages.map(p => ({ tabId: p.tabId, connection: p.connection })))}`);
    try {
      assert.ok(result.passages.length <= 3);
      for (const p of result.passages) assert.ok(tabs.find(t => t.id === p.tabId).text.includes(p.quote));
      const old = result.passages.find(p => p.tabId === 485);
      if (old) { assert.match(old.connection, /constraint|learn|bottleneck|experiment|pilot|test|feedback|uncertain/i); hits++; }
    } catch (error) { console.error(result.rawOutputs); throw error; }
  }
  assert.ok(hits >= 2, `Old tab appeared ${hits}/3 times`);
});
test('live loose selection declines a goal with no plausible structural rhyme', { skip: !process.env.OPENROUTER_API_KEY }, async () => {
  const result = await selectPassages({ goal: NO_RHYME_GOAL, tabs: await source.list(), model: createOpenRouterModel({ env: process.env }), mode: 'loose' });
  try { assert.equal(result.passages.length, 0); assert.ok(result.none); }
  catch (error) { console.error(result.rawOutputs); throw error; }
  console.log(`None: ${result.none}`);
});
test('live tight partial coverage names the gap before actual Exa search', { skip: !process.env.OPENROUTER_API_KEY || !process.env.EXA_API_KEY }, async () => {
  const events = [];
  const result = await runAgent({ goal: 'Implement OAuth device polling and securely store the resulting refresh token in the macOS Keychain using the Security framework.',
    tabSource: source, env: { ...process.env, ENABLE_EXA: '1' }, stopAfterCoverage: true, onTrace: e => events.push(e) });
  try {
    assert.equal(result.status, 'coverage'); assert.ok(result.searches > 0 && result.searches <= 2);
    for (let i = 0; i < events.length; i++) if (events[i].kind === 'tool' && events[i].label.startsWith('Searching the web')) {
      assert.equal(events[i - 1].kind, 'note'); assert.match(events[i - 1].label, /Missing:/);
    }
    assert.ok(result.passages.some(p => p.source === 'web' && p.firstVisit === null));
  } catch (error) { console.error(JSON.stringify({ events, coverage: result.coverageAssessments, triage: result.triage }, null, 2)); throw error; }
  console.log(`Live gap-fill: ${result.searches} searches; ${result.passages.filter(p => p.source === 'web').length} web passages.`);
});


test('live full loose pipeline keeps topical triage unchanged and finds the old tab in two of three runs', { skip: !process.env.OPENROUTER_API_KEY }, async () => {
  let hits = 0;
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const result = await runAgent({ goal: LOOSE_GOAL, mode: 'loose', tabSource: source, stopAfterPassages: true, onTrace: () => {} });
    runs.push({ status: result.status, triage: result.triage, selections: result.passageSelections });
    if (result.status === 'passages' && result.passages.some(p => p.tabId === 485 && /constraint|learn|bottleneck|experiment|pilot|test|feedback|uncertain/i.test(p.connection))) hits++;
    console.log(`Full loose ${i + 1}: opened ${JSON.stringify(result.triage?.open?.map(t => t.id))}; rhymes ${JSON.stringify(result.passages.map(p => p.tabId))}`);
  }
  if (hits < 2) console.error('FULL LOOSE OUTPUTS', JSON.stringify(runs, null, 2));
  assert.ok(hits >= 2, `Unchanged triage delivered the old rhyme ${hits}/3 runs. Do not silently change triage to fix this.`);
});
