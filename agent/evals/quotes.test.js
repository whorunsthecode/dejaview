import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyQuotes } from '../verify-quotes.js';
import { runAgent } from '../host.js';
import { selectPassages } from '../passages.js';
import { StubTabSource } from '../tab-sources.js';
import { attachMessageHost } from '../message-host.js';
import { MSG } from '../../shared/messages.js';

const passage = quote => ({ tabId: 1, quote, why: 'Explains the constraint.' });
function verify(text, quote) { return verifyQuotes([passage(quote)], { 1: { text } }); }
function repaired(text, quote, method = 'normalized') {
  const result = verify(text, quote);
  assert.equal(result.ok.length, 0); assert.equal(result.failed.length, 0);
  assert.equal(result.repaired.length, 1);
  assert.equal(result.repaired[0].method, method);
  assert.ok(text.includes(result.repaired[0].quote));
  return result.repaired[0].quote;
}
test('exact quote passes untouched', () => {
  const item = passage('Keep  both spaces.');
  assert.equal(verifyQuotes([item], new Map([[1, { text: item.quote }]])).ok[0], item);
});
test('curly quotes, whitespace, dashes, ellipses and zero-width characters restore source offsets', () => {
  assert.equal(repaired('Say “hello” now.', 'Say "hello" now.'), 'Say “hello” now.');
  assert.equal(repaired('Keep  both spaces.', 'Keep both spaces.'), 'Keep  both spaces.');
  const text = '😀 Say “go”…\u200b then—wait.\n\nNext step.';
  assert.equal(repaired(text, '😀 Say "go"... then-wait. Next step.'), text);
});
test('joined paragraphs become one real span; omitted middle sentences never pass unchanged', () => {
  const text = 'First sentence.\n\nSecond sentence.';
  assert.equal(repaired(text, 'First sentence. Second sentence.'), text);
  assert.equal(verify('First sentence. Missing middle. Last sentence.', 'First sentence. Last sentence.').failed.length, 1);
});
test('prefix fallback recovers only a real source sentence', () => {
  const text = 'When the request fails at the network layer, preserve the original request identity and retry once. Never retry HTTP errors.';
  const quote = text.slice(0, 60) + ' made up ending.';
  assert.equal(repaired(text, quote, 'prefix'), text.split('. ')[0] + '.');
  assert.equal(verify(text + ' ' + text, quote).failed.length, 1);
});
test('hallucinated, missing-tab, blocked and empty quotes are dropped', () => {
  assert.equal(verify('Real text.', 'A completely invented procedure.').failed.length, 1);
  assert.equal(verifyQuotes([passage('Real')], {}).failed.length, 1);
  assert.equal(verifyQuotes([passage('Real')], { 1: { text: 'Real', textStatus: 'blocked' } }).failed.length, 1);
  assert.equal(verify('Real', '').failed.length, 1);
});
const json = value => ({ role: 'assistant', content: JSON.stringify(value) });
const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const goal = 'Implement OAuth device authorization with correct polling and error handling';
const triageModel = async ({ messages }) => {
  const tabs = JSON.parse(messages.at(-1).content).tabs;
  return json({ open: [{ id: 481, why: 'Documents device authorization and polling steps.' }],
    skip: tabs.filter(t => t.id !== 481).map(t => ({ id: t.id, why: 'Outside this isolated passage verification fixture.' })), note: null });
};
test('passage JSON gets one correction attempt, then fails loudly', async () => {
  const tabs = [{ id: 1, text: 'Source.', textStatus: 'ok' }];
  let calls = 0;
  const result = await selectPassages({ goal, tabs, model: async ({ messages }) => {
    calls++;
    if (calls === 1) return { role: 'assistant', content: '{' };
    assert.match(messages.at(-1).content, /Parse\/validation error/);
    return json({ passages: [passage('Source.')], empty: [] });
  } });
  assert.equal(result.modelCalls, 2);
  await assert.rejects(selectPassages({ goal, tabs, model: async () => ({ role: 'assistant', content: '{' }) }), /Passage selection failed/);
});
test('host and HIGHLIGHT expose only verified spans, while reporting repair/drop counts', async () => {
  const sent = [], source = new StubTabSource();
  const text = (await source.read(481)).text;
  const quote = text.replace(/\s+/g, ' ');
  const host = attachMessageHost({ tabSource: source, env: {}, renderSkill: () => { throw new Error('Must not write a skill'); },
    send: (type, payload) => sent.push({ type, payload }), on: () => () => {},
    triageModel, stopAfterPassages: true,
    passageModel: async () => json({ passages: [{ tabId: 481, quote, why: 'Source procedure.' }, { tabId: 481, quote: 'INVENTED_UNSAFE_QUOTE', why: 'Invented.' }], empty: [] }) });
  const result = await host.run({ goal }); host.dispose();
  assert.equal(result.status, 'passages'); assert.equal(result.skill, null);
  assert.equal(result.passages.length, 1); assert.ok(text.includes(result.passages[0].quote));
  assert.ok(!JSON.stringify(result.messages).includes('INVENTED_UNSAFE_QUOTE'));
  assert.deepEqual(sent.find(x => x.type === MSG.HIGHLIGHT).payload, { tabId: 481, quotes: [result.passages[0].quote] });
  assert.ok(sent.some(x => x.payload.event?.label === 'Quotes: repaired 1, dropped 1.'));
  assert.ok(!sent.some(x => x.type === MSG.SKILL));
});
test('new read and write in one tool batch cannot bypass passage verification', async () => {
  let turns = 0, selections = 0;
  const result = await runAgent({ goal, tabSource: new StubTabSource(), env: {}, onTrace: () => {}, triageModel,
    passageModel: async ({ messages }) => { selections++; return json({ passages: [], empty: JSON.parse(messages.at(-1).content).tabs.map(t => ({ tabId: t.id, why: 'No procedure selected.' })) }); },
    gapModel: async () => json({ covered: 'Isolated quote test.', gaps: [] }),
    model: async () => ({ role: 'assistant', content: null, tool_calls: ++turns === 1
      ? [tool('r', 'read_tab', { id: 482 }), tool('w', 'write_skill', { name: 'test', description: 'test', body: 'test', sources: [] })]
      : [tool('w2', 'write_skill', { name: 'test', description: 'test', body: 'test', sources: [] })] }) });
  assert.equal(result.status, 'complete'); assert.equal(selections, 2);
  assert.match(result.messages.find(m => m.tool_call_id === 'w').content, /verification first/);
});

for (let run = 1; run <= 3; run++) test(`live stubs passage survival run ${run}`, { skip: !process.env.OPENROUTER_API_KEY }, async () => {
  const source = new StubTabSource(), highlights = [];
  const result = await runAgent({ goal, tabSource: source, onTrace: () => {}, stopAfterPassages: true,
    onHighlight: payload => highlights.push(payload) });
  try {
    assert.equal(result.status, 'passages'); assert.equal(result.skill, null);
    const counts = result.passageSelections.reduce((sum, s) => {
      sum.survived += s.verification.ok.length + s.verification.repaired.length;
      sum.total += s.verification.ok.length + s.verification.repaired.length + s.verification.failed.length;
      return sum;
    }, { survived: 0, total: 0 });
    assert.ok(counts.total > 0); assert.ok(counts.survived / counts.total >= 0.9);
    for (const { tabId, quotes } of highlights) {
      const { text } = await source.read(tabId);
      assert.ok(quotes.every(quote => text.includes(quote)));
    }
    console.log(`Run ${run}: ${counts.survived}/${counts.total} quotes survived; ${result.reads} reads.`);
  } catch (error) {
    console.error('FULL MODEL OUTPUT', JSON.stringify({ triage: result.triage, selections: result.passageSelections }, null, 2));
    throw error;
  }
});
