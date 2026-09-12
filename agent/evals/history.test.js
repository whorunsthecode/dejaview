import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, createOpenRouterModel } from '../host.js';
import { StubTabSource } from '../tab-sources.js';
import { isHistoryCandidate } from '../../shared/history.js';
import { HISTORY_LIMIT } from '../../shared/history.js';
import { renderSkill } from '../../extension/agent-bridge.js';

const json = value => ({ role: 'assistant', content: JSON.stringify(value) });
const originals = await new StubTabSource().list();
const date = Date.now() - 30 * 86400000;
const candidate = i => ({ historyId: `closed-${i}`, url: `https://example.org/keychain/${i}`, title: 'Store refresh tokens in Keychain', visitCount: 3, firstVisit: date, lastVisit: date + 1000 });
function fixture({ enabled = true, selected = [481], count = 2, openError = false, status = 'ok', searchError = false, mode = 'tight' } = {}) {
  const added = new Map(), events = [], highlights = [], stats = { lookups: 0, opens: 0, reads: 0, historyModels: 0 };
  const candidates = Array.from({ length: count }, (_, i) => candidate(i));
  const tabSource = { list: async () => [...originals, ...added.values()], read: async id => {
    stats.reads++; const t = added.get(id) ?? originals.find(t => t.id === id);
    return { id, text: t.text, textStatus: t.textStatus };
  } };
  const historySource = {
    search: async () => { stats.lookups++; if (searchError) throw new Error('History denied'); return candidates.map(c => ({ ...c, text: 'UNREAD_SECRET' })); },
    open: async c => {
      stats.opens++; if (openError) throw new Error('Page closed while loading');
      const id = 9000 + Number(c.historyId.split('-')[1]);
      const tab = { id, url: c.url, title: c.title, firstVisit: c.firstVisit, lastAccessed: Date.now(), windowId: 1, groupTitle: null,
        text: status === 'ok' ? 'Store the refresh token using SecItemAdd with the generic password class.' : null, textStatus: status };
      added.set(id, tab); return { ...tab, text: null, textStatus: 'empty' };
    }
  };
  const options = {
    maxReads: 8, goal: 'Implement OAuth device polling and store refresh tokens in Keychain.', mode, includeHistory: enabled, tabSource, historySource, env: {},
    onTrace: e => events.push(e), onHighlight: p => highlights.push(p),
    triageModel: async () => json({ open: selected.map(id => ({ id, why: 'Inspect protocol rules for device polling.' })), skip: originals.filter(t => !selected.includes(t.id)).map(t => ({ id: t.id, why: 'Different procedure from device token storage.' })), note: null }),
    historyModel: async ({ messages }) => {
      stats.historyModels++;
      assert.ok(!JSON.stringify(messages).includes('UNREAD_SECRET'));
      const input = JSON.parse(messages.at(-1).content);
      assert.ok(input.candidates.length <= HISTORY_LIMIT);
      return json({ open: input.candidates.map(c => ({ historyId: c.historyId, why: 'Explains Keychain persistence.' })), note: 'Previously visited storage procedures.' });
    },
    passageModel: async ({ messages }) => {
      const tabs = JSON.parse(messages.at(-1).content).tabs;
      if (mode === 'loose') return json({ rhymes: tabs.slice(-3).map(t => ({ tabId: t.id, quote: t.text.split('\n\n')[0], connection: 'Persist a durable state while transient attempts change.' })), none: null });
      return json({ passages: tabs.map(t => ({ tabId: t.id, quote: t.text.split('\n\n')[0], why: 'Supplies an implementation step.' })), empty: [] });
    },
    gapModel: async ({ messages }) => {
      const { passages } = JSON.parse(messages.at(-1).content);
      return json({ covered: 'Open tabs cover device polling.', gaps: passages.some(p => p.source === 'history') ? [] : [{ missing: 'Keychain refresh-token storage.', query: 'Keychain refresh token storage' }] });
    },
    model: async () => ({ role: 'assistant', content: null, tool_calls: [{ id: 'finish', type: 'function', function: { name: 'write_skill', arguments: JSON.stringify({ name: 'test', description: 'test', body: 'Test procedure.', sources: [{ url: candidate(0).url, firstVisit: null }] }) } }] })
  };
  return { options, added, candidates, stats, events, highlights };
}
test('history off performs zero discovery, reopen or selection calls', async () => {
  const f = fixture({ enabled: false }); const result = await runAgent(f.options);
  assert.equal(result.status, 'complete'); assert.equal(f.stats.lookups, 0); assert.equal(f.stats.opens, 0); assert.equal(f.stats.historyModels, 0);
});
test('gap then history, verified highlights, coverage reassessment and history citations survive', async () => {
  const f = fixture(); const result = await runAgent(f.options);
  assert.equal(result.status, 'complete'); assert.equal(result.reads, 3); assert.equal(result.searches, 0);
  assert.equal(f.stats.lookups, 1);
  const lookup = f.events.findIndex(e => e.kind === 'tool' && e.label === 'Searching recent history');
  assert.equal(f.events[lookup - 1].kind, 'note'); assert.match(f.events[lookup - 1].label, /Missing:/);
  assert.equal(result.coverageAssessments.length, 2);
  const evidence = result.passages.filter(p => p.source === 'history'); assert.equal(evidence.length, 2);
  for (const p of evidence) assert.ok(f.added.get(p.tabId).text.includes(p.quote));
  for (const p of f.highlights.filter(p => p.tabId >= 9000)) assert.ok(p.quotes.every(q => f.added.get(p.tabId).text.includes(q)));
  assert.equal(result.skill.sources[0].source, 'history'); assert.equal(result.skill.sources[0].firstVisit, date);
  assert.match(renderSkill(result.skill), /from browsing history; earliest recorded visit/);
  assert.ok(!JSON.stringify(result.messages).includes('UNREAD_SECRET'));
});
test('remaining combined budget caps history reads, including failed reopen attempts', async () => {
  for (const openError of [false, true]) {
    const f = fixture({ selected: [481,482,483,484,485,486,489], count: 3, openError });
    const result = await runAgent(f.options);
    assert.equal(result.status, 'complete'); assert.equal(result.reads, 8); assert.equal(f.stats.opens, 1);
    assert.ok(f.events.some(e => /History reads capped/.test(e.label)));
  }
});
test('exhausted read budget never enumerates history or reopens pages', async () => {
  const f = fixture({ selected: [481,482,483,484,485,486,489,490] });
  const result = await runAgent(f.options);
  assert.equal(result.reads, 8); assert.equal(f.stats.lookups, 0); assert.equal(f.stats.opens, 0);
});
test('failed history lookup, blocked text and failed reopening recover before Exa', async () => {
  for (const config of [{ searchError: true }, { openError: true }, { status: 'blocked' }]) {
    const f = fixture(config); const result = await runAgent(f.options);
    assert.equal(result.status, 'complete'); assert.equal(result.searches, 1);
    assert.ok(!result.passages.some(p => p.source === 'history'));
    const lookup = f.events.findIndex(e => e.label === 'Searching recent history');
    const web = f.events.findIndex(e => e.label.startsWith('Searching the web'));
    assert.ok(lookup >= 0 && web > lookup);
  }
});
test('host deduplicates already open pages and bounds metadata sent to model', async () => {
  const f = fixture({ count: HISTORY_LIMIT + 10 });
  f.candidates.unshift({ ...candidate(99), url: originals[0].url + '?utm_source=history' });
  const result = await runAgent(f.options);
  assert.equal(result.reads, 8); assert.equal(f.stats.opens, 7);
  assert.ok(!result.passages.some(p => p.historyId === 'closed-99'));
});
test('loose mode searches history once and keeps at most three verified rhymes total', async () => {
  const f = fixture({ mode: 'loose', count: 4 }); const result = await runAgent(f.options);
  assert.equal(result.status, 'complete'); assert.equal(f.stats.lookups, 1); assert.equal(result.searches, 0);
  assert.ok(result.passages.length <= 3); assert.ok(result.passages.some(p => p.source === 'history'));
});
test('history strings are not accepted as browser tab IDs', async () => {
  const f = fixture(); f.options.historySource.open = async c => ({ ...originals[0], id: c.historyId, url: c.url });
  const result = await runAgent(f.options);
  assert.equal(result.status, 'complete'); assert.equal(f.stats.reads, 1);
  assert.ok(f.events.some(e => /id must be number/.test(e.label)));
  assert.throws(() => isHistoryCandidate({ ...candidate(1), historyId: 1 }));
});
test('recording includes reopened tab IDs and replay requires those pages', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dejavu-history-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture({ count: 1 }), fixturePath = join(dir, 'run.json');
  const live = await runAgent({ ...f.options, fixturePath, env: { RECORD: '1' } });
  const recorded = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.ok(recorded.referencedTabs.some(t => t.id === 9000));
  assert.equal(recorded.events.filter(e => e.kind === 'tool_call').length, recorded.events.filter(e => e.kind === 'tool_result').length);
  const replayed = [], replayHighlights = [];
  const result = await runAgent({ goal: 'replay', fixturePath, tabSource: f.options.tabSource,
    env: { REPLAY: '1', REPLAY_SPEED: '10000' }, onTrace: e => replayed.push(e), onHighlight: p => replayHighlights.push(p),
    historySource: { search: () => { throw new Error('Must not query history'); } } });
  assert.deepEqual(result, live); assert.deepEqual(replayed, f.events); assert.deepEqual(replayHighlights, f.highlights);
  f.added.clear();
  await assert.rejects(runAgent({ goal: 'replay', fixturePath, tabSource: f.options.tabSource, env: { REPLAY: '1' }, onTrace: () => {} }), /9000/);
});


test('live model discovers a closed history source, verifies it and reassesses coverage', { skip: !process.env.OPENROUTER_API_KEY }, async () => {
  const f = fixture({ count: 2 });
  const live = createOpenRouterModel({ env: process.env });
  const result = await runAgent({ ...f.options,
    goal: 'Explain OAuth device polling and identify which macOS Keychain API stores a refresh token.',
    gapModel: live, passageModel: live, historyModel: live });
  try {
    assert.equal(result.status, 'complete'); assert.equal(f.stats.lookups, 1);
    assert.ok(f.stats.opens >= 1 && result.reads <= 8);
    const historical = result.passages.filter(p => p.source === 'history');
    assert.ok(historical.length > 0);
    for (const p of historical) assert.ok(f.added.get(p.tabId).text.includes(p.quote));
    const index = f.events.findIndex(e => e.label === 'Searching recent history');
    assert.match(f.events[index - 1].label, /Missing:/);
    console.log(`Live history: ${result.reads} reads; ${historical.length} verified history passages; ${result.searches} web searches.`);
  } catch (error) {
    console.error(JSON.stringify({ events: f.events, selections: result.historySelections, coverage: result.coverageAssessments }, null, 2)); throw error;
  }
});
