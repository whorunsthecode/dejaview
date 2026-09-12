import test from 'node:test';
import assert from 'node:assert/strict';
import { runTriage } from '../triage.js';
import { runAgent } from '../host.js';
import { shortlistTabs } from '../shortlist.js';
import { readLimit } from '../../shared/limits.js';

const json = value => ({ role: 'assistant', content: JSON.stringify(value) });
const tabs = Array.from({ length: 500 }, (_, id) => ({ id, title: id === 250 ? 'Shader banding mobile precision fix' : `Reference document ${id}`, url: `https://docs.example.org/pages/${id}`, groupTitle: null, firstVisit: null, windowId: 1, lastAccessed: 0, text: 'Use high precision for the shader calculation.', textStatus: 'ok' }));

test('500-tab triage bounds model input and finds an exact problem title in the middle', async () => {
  const trace = [];
  const result = await runTriage({ goal: 'fix shader banding on mobile', tabs, onTrace: e => trace.push(e), model: async ({ messages }) => {
    const input = JSON.parse(messages.at(-1).content).tabs;
    assert.ok(input.length <= 50);
    assert.ok(input.some(t => t.id === 250));
    assert.ok(input.every(t => !('text' in t)));
    return json({ open: [{ id: 250, why: 'Explains mobile shader precision and banding fixes.' }], note: null });
  } });
  assert.equal(result.open.length, 1);
  assert.equal(result.skip.length, 499);
  assert.match(trace[0].label, /50 of 500/);
});

test('local shortlist removes tracking duplicates but retains distinct paths and versions', () => {
  const base = tabs[0];
  const result = shortlistTabs([
    { ...base, id: 1, url: 'https://example.org/docs?v=1' },
    { ...base, id: 2, url: 'https://example.org/docs?v=1&utm_source=mail#heading' },
    { ...base, id: 3, url: 'https://example.org/docs?v=2' },
    { ...base, id: 4, url: 'https://example.org/other' },
    { ...base, id: 5, url: 'chrome://settings' },
  ], 'reference');
  assert.deepEqual(result.map(t => t.id), [1, 3, 4]);
});

for (const budget of [8, 24, 48]) test(`${budget} reads from 500 tabs verify in batches of eight and finish`, async () => {
  let reads = 0, batches = 0;
  const highlights = [];
  const result = await runAgent({ goal: 'shader precision', env: {}, maxReads: budget, onTrace: () => {},
    tabSource: { list: async () => tabs, read: async id => { reads++; return tabs[id]; } },
    onHighlight: e => highlights.push(e),
    triageModel: async ({ messages }) => json({ open: JSON.parse(messages.at(-1).content).tabs.slice(0, budget).map(t => ({ id: t.id, why: 'Documents a shader precision procedure.' })), note: null }),
    passageModel: async ({ messages }) => {
      const batch = JSON.parse(messages.at(-1).content).tabs;
      assert.ok(batch.length <= 8); batches++;
      return json({ passages: batch.map(t => ({ tabId: t.id, quote: t.text, why: 'Specifies shader precision.' })), empty: [] });
    },
    gapModel: async () => json({ covered: 'Shader precision is specified.', gaps: [] }),
    model: async () => ({ role: 'assistant', content: null, tool_calls: [{ id: 'finish', type: 'function', function: { name: 'write_skill', arguments: JSON.stringify({ name: 'precision', description: 'Precision procedure', body: 'Use high precision.', sources: [] }) } }] }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(reads, budget); assert.equal(result.reads, budget);
  assert.equal(batches, budget / 8); assert.equal(highlights.length, budget);
  assert.equal(result.passages.length, budget);
});

test('default remains selective and invalid larger budgets throw', () => {
  assert.equal(readLimit(), 8);
  for (const value of [0, 49, 1.5, 'unlimited']) assert.throws(() => readLimit(value));
});
