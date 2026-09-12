import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../host.js';
import { selectPeeks } from '../peeks.js';
import { createTools } from '../tools.js';

const json = content => ({ role: 'assistant', content: JSON.stringify(content) });
const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const skill = { name: 'precision', description: 'Shader precision', body: 'Use high precision.', sources: [] };
const finish = () => ({ role: 'assistant', content: null, tool_calls: [tool('finish', 'write_skill', skill)] });
const tabs = Array.from({ length: 20 }, (_, id) => ({ id, title: `Shader precision ${id}`, url: `https://example.org/${id}`, windowId: 1, groupTitle: 'Shaders', firstVisit: null, lastAccessed: 0, text: null, textStatus: 'empty' }));
const triage = async () => json({ open: tabs.map(t => ({ id: t.id, why: 'May explain shader precision constraints.' })), skip: [], note: 'Compare the preview procedures.' });
const gaps = async () => json({ covered: 'Precision procedure present.', gaps: [] });

test('peek twenty, reject marketing, read eight with bounded parallelism and recover a thrown read', async () => {
  let active = 0, peak = 0, reads = 0, peeked = 0;
  const trace = [], highlights = [];
  const source = {
    list: async () => tabs,
    peek: async id => { peeked++; return { id, textStatus: 'ok', description: id === 0 ? 'Buy our shader platform today' : 'Set highp precision in fragment shaders', heading: '', paragraph: '' }; },
    read: async id => {
      assert.notEqual(id, 0); reads++; active++; peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (id === 3) throw new Error('A tab closed');
        return { id, textStatus: 'ok', text: 'Use high precision for the shader calculation.' };
      } finally { active--; }
    }
  };
  const result = await runAgent({ goal: 'fix mobile shader banding', tabSource: source, env: {}, progressive: true, readConcurrency: 4,
    onTrace: e => trace.push(e), onHighlight: e => highlights.push(e), triageModel: triage,
    peekModel: async ({ messages }) => {
      const input = JSON.parse(messages.at(-1).content);
      assert.equal(input.tabs.length, 20); assert.equal(input.cap, 8);
      assert.match(input.tabs.find(t => t.id === 0).preview.description, /Buy/);
      return json({ open: tabs.slice(1, 9).map(t => ({ id: t.id, why: 'Preview names the shader precision setting.' })), note: 'Skip the platform sales page.' });
    },
    passageModel: async ({ messages }) => json({ passages: JSON.parse(messages.at(-1).content).tabs.map(t => ({ tabId: t.id, quote: t.text, why: 'Names the precision setting.' })), empty: [] }),
    gapModel: gaps, model: finish
  });
  assert.equal(result.status, 'complete'); assert.equal(peeked, 20); assert.equal(result.peeks, 20);
  assert.equal(reads, 8); assert.equal(result.reads, 8); assert.equal(peak, 4);
  assert.equal(result.passages.length, 7);
  assert.ok(highlights.every(h => h.tabId !== 0));
  assert.ok(trace.some(e => /Peeked 20; selected 8/.test(e.label)));
  for (const id of tabs.map(t => t.id)) {
    const before = trace.findIndex(e => e.kind === 'tool' && e.label === 'Peeking at tab' && e.ref === id);
    const after = trace.findIndex(e => e.kind === 'result' && e.label.startsWith(`Preview ${id}:`));
    assert.ok(before >= 0 && after > before);
  }
  const readStarts = trace.map((e, i) => [e, i]).filter(([e]) => e.kind === 'tool' && e.label.startsWith('Opening'));
  const firstResult = trace.findIndex(e => e.kind === 'result' && (e.label.startsWith('Tab ') || e.label.startsWith('read_tab failed')));
  assert.ok(readStarts.slice(0, 4).every(([, i]) => i < firstResult));
});

test('preview validation retries once, forbids unknown/blocked IDs, and truncates excess reads', async () => {
  const previews = tabs.map(t => ({ id: t.id, textStatus: t.id === 0 ? 'blocked' : 'ok', description: '', heading: '', paragraph: '' }));
  let calls = 0;
  const selected = await selectPeeks({ goal: 'precision', tabs, previews, cap: 3, model: async () => {
    calls++;
    return calls === 1 ? json({ open: [{ id: 0, why: 'Try the blocked tab.' }], note: null })
      : json({ open: tabs.slice(1, 8).map(t => ({ id: t.id, why: 'Names a precision procedure.' })), note: null });
  } });
  assert.equal(selected.modelCalls, 2); assert.equal(selected.open.length, 3); assert.equal(selected.truncated, 4);
  await assert.rejects(selectPeeks({ goal: 'precision', tabs, previews, cap: 3, model: async () => json({ open: [{ id: 999, why: 'Unknown page procedure.' }], note: null }) }), /Unknown tab ID/);
});

test('peek cannot seed quoted evidence and the host enforces a separate 48-peek budget', async () => {
  let count = 0;
  const source = { list: async () => tabs, read: async () => { throw new Error('No full reads expected'); }, peek: async id => { count++; return { id, textStatus: 'ok', description: 'Preview only', heading: '', paragraph: '' }; } };
  const tools = createTools({ tabSource: source });
  await tools.handlers.peek_tab({ id: 1 });
  await assert.rejects(tools.handlers.search_in_tab({ id: 1, query: 'Preview' }), /Read tab/);
  count = 0;
  let turns = 0;
  const result = await runAgent({ goal: 'precision', env: {}, tabSource: source, readConcurrency: 4, onTrace: () => {},
    triageModel: async () => json({ open: [], skip: tabs.map(t => ({ id: t.id, why: 'Defer to isolated tool budget test.' })), note: null }), gapModel: gaps,
    model: async () => ++turns === 1 ? { role: 'assistant', content: null, tool_calls: [...Array.from({ length: 50 }, (_, i) => tool(`p${i}`, 'peek_tab', { id: i % 20 })), tool('finish', 'write_skill', skill)] } : finish()
  });
  assert.equal(result.status, 'complete'); assert.equal(result.peeks, 48); assert.equal(count, 48); assert.equal(result.reads, 0);
  assert.match(result.messages.find(m => m.tool_call_id === 'p48').content, /Peek budget exhausted/);
});

test('parallel read batches reserve budget before I/O and writes wait for verification', async () => {
  let reads = 0, turns = 0;
  const result = await runAgent({ goal: 'precision', env: {}, maxReads: 3, readConcurrency: 4, tabSource: {
    list: async () => tabs, read: async id => { reads++; await new Promise(r => setTimeout(r, 2)); return { id, text: 'Source.', textStatus: 'ok' }; }
  }, onTrace: () => {}, triageModel: async () => json({ open: [], skip: tabs.map(t => ({ id: t.id, why: 'Defer to isolated parallel read test.' })), note: null }),
  passageModel: async ({ messages }) => json({ passages: JSON.parse(messages.at(-1).content).tabs.map(t => ({ tabId: t.id, quote: t.text, why: 'Source procedure.' })), empty: [] }), gapModel: gaps,
  model: async () => ++turns === 1 ? { role: 'assistant', content: null, tool_calls: [...Array.from({ length: 10 }, (_, i) => tool(`r${i}`, 'read_tab', { id: i })), tool('too-early', 'write_skill', skill)] } : finish() });
  assert.equal(reads, 3); assert.equal(result.reads, 3); assert.equal(result.status, 'complete');
  assert.match(result.messages.find(m => m.tool_call_id === 'r3').content, /Read budget exhausted/);
  assert.match(result.messages.find(m => m.tool_call_id === 'too-early').content, /verification first/);
});

test('navigation after listing cannot seed a read cache for the old page', async () => {
  const tools = createTools({ tabSource: { list: async () => tabs, read: async id => ({ id, text: 'Different page.', textStatus: 'ok', url: 'https://other.org/new' }) } });
  await tools.handlers.list_tabs();
  await assert.rejects(tools.handlers.read_tab({ id: 1 }), /source identity changed/);
  await assert.rejects(tools.handlers.search_in_tab({ id: 1, query: 'Different' }), /Read tab/);
});
