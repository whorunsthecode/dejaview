import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runTriage, triageMetadata, validateTriage } from '../triage.js';
import { runAgent, createOpenRouterModel } from '../host.js';
import { StubTabSource } from '../tab-sources.js';
import { isTab, isTraceEvent } from '../../shared/types.js';

const tabs = await new StubTabSource().list();
const GOAL = 'Fix device authorization polling: respect slow_down and handle connection timeouts.';
const decision = (openIds = [481, 482, 492], note = 'Device polling documentation and issue reports form an auth cluster.') => ({
  open: openIds.map(id => ({ id, why: 'Expect device polling intervals and timeout handling steps.' })),
  skip: tabs.filter(tab => !openIds.includes(tab.id)).map(tab => ({ id: tab.id, why: [487, 488].includes(tab.id) ? 'Duplicate: another view of selected device-flow documentation.' : 'Different procedure or page purpose from device polling.' })),
  note
});
const response = value => ({ role: 'assistant', content: JSON.stringify(value) });

// These are repeatable contract tests. The live acceptance tests below do not use
// expected decisions as model input or retry until they pass.
test('20 valid tabs retain original six IDs, two near-duplicates and three new landing pages', () => {
  assert.equal(tabs.length, 20); tabs.forEach(isTab);
  assert.deepEqual(tabs.slice(0, 6).map(tab => tab.id), [481,482,483,484,485,486]);
  assert.equal(tabs.find(tab => tab.id === 486).textStatus, 'blocked');
});

test('triage sees only permitted metadata and exact UTC dates, never prefilled text/status', async () => {
  const input = tabs.map(tab => ({ ...tab, text: 'SECRET_CONTENT_SENTINEL', extra: 'SECRET_EXTRA_SENTINEL' }));
  let calls = 0;
  await runTriage({ goal: GOAL, tabs: input, model: async request => {
    calls++;
    assert.equal(request.phase, 'triage');
    assert.equal(request.tools, undefined);
    assert.equal(JSON.stringify(request).includes('SECRET_'), false);
    const metadata = JSON.parse(request.messages.at(-1).content).tabs;
    assert.deepEqual(Object.keys(metadata[0]), ['id','title','url','groupTitle','firstVisit']);
    assert.equal(metadata[0].firstVisit, '2024-03-15');
    assert.equal(metadata[1].firstVisit, '2024-03-01');
    return response(decision());
  } });
  assert.equal(calls, 1);
});

test('over-cap model output is truncated and accounted for in skip with a note', async () => {
  const events = [];
  const result = await runTriage({ goal: GOAL, tabs, model: async () => response(decision(tabs.filter(t => ![487,488].includes(t.id)).slice(0, 12).map(t => t.id))), onTrace: e => { isTraceEvent(e); events.push(e); } });
  assert.equal(result.open.length, 8); assert.equal(result.skip.length, 12);
  assert.equal(result.truncated, 4);
  assert.ok(events.some(e => e.kind === 'note' && /12 reads; capped at 8/.test(e.label)));
  validateTriage(resultWithoutMetadata(result), tabs);
});
function resultWithoutMetadata({ open, skip, note }) { return { open, skip, note }; }

test('malformed JSON gets exactly one retry with its parse error appended', async () => {
  let calls = 0;
  const result = await runTriage({ goal: GOAL, tabs, model: async ({ messages }) => {
    if (++calls === 1) return { role: 'assistant', content: '{bad' };
    assert.match(messages.at(-1).content, /Parse\/validation error:/);
    assert.equal(messages.at(-2).content, '{bad');
    return response(decision());
  } });
  assert.equal(calls, 2); assert.equal(result.modelCalls, 2);
  const events = []; calls = 0;
  await assert.rejects(runTriage({ goal: GOAL, tabs, model: async () => { calls++; return { role:'assistant', content:'not json' }; }, onTrace: e => events.push(e) }), error => {
    assert.deepEqual(error.rawOutputs, ['not json', 'not json']); return true;
  });
  assert.equal(calls, 2); assert.equal(events.at(-1).kind, 'error');
});

test('wrong IDs, omitted tabs, duplicate IDs, long and generic reasons are rejected', () => {
  for (const change of [
    d => { d.open[0].id = 9999; }, d => { d.skip.pop(); },
    d => { d.open[1].id = d.open[0].id; },
    d => { d.open[0].why = 'Relevant to the goal'; },
    d => { d.skip[0].why = 'Unrelated'; },
    d => { d.open[0].why = Array(15).fill('polling').join(' '); }
  ]) { const d = decision(); change(d); assert.throws(() => validateTriage(d, tabs)); }
});

test('host triage is the first model turn; selected reads carry reasons and share K1 budget', async () => {
  const events = [], phases = [], readIds = [];
  let toolTurn = 0;
  const terminal = { name:'write_skill', arguments:JSON.stringify({name:'test',description:'test',body:'test',sources:[]}) };
  const result = await runAgent({ gapModel: async () => ({ role: 'assistant', content: JSON.stringify({ covered: 'Isolated triage test.', gaps: [] }) }), goal: GOAL, tabSource: {
    list: async () => tabs,
    read: async id => { assert.equal(phases[0], 'triage'); readIds.push(id); return { id, text:null, textStatus:'blocked' }; }
  }, maxReads: 8, model: async ({ phase, messages }) => {
    phases.push(phase ?? 'tools');
    if (phase === 'triage') return response(decision(tabs.filter(t => ![487,488].includes(t.id)).slice(0, 10).map(t => t.id)));
    if (++toolTurn === 1) return { role:'assistant', content:null, tool_calls:[{id:'ninth',type:'function',function:{name:'read_tab',arguments:'{"id":499}'}}] };
    assert.match(messages.at(-1).content, /Read budget exhausted/);
    return {role:'assistant',content:null,tool_calls:[{id:'end',type:'function',function:terminal}]};
  }, onTrace: e => { isTraceEvent(e); events.push(e); } });
  assert.equal(result.status, 'complete'); assert.equal(result.reads, 8); assert.equal(readIds.length, 8);
  assert.equal(phases.filter(x => x === 'triage').length, 1);
  assert.equal(events.filter(e => e.label.startsWith('Skipped ')).length, 1);
  const opened = events.filter(e => e.kind === 'tool' && e.label.startsWith('Opening '));
  assert.equal(opened.length, 8); assert.ok(opened.every(e => e.detail === decision().open[0].why));
  assert.ok(events.find(e => e.kind === 'plan' && e.label === decision().note));
  const pairs = events.filter(e => ['tool','result'].includes(e.kind));
  for(let i=0;i<pairs.length;i+=2) { assert.equal(pairs[i].kind,'tool'); assert.equal(pairs[i+1].kind,'result'); }
});

test('failed triage never reads a tab or starts the regular tool loop', async () => {
  let reads = 0, calls = 0; const events = [];
  const result = await runAgent({ gapModel: async () => ({ role: 'assistant', content: JSON.stringify({ covered: 'Isolated triage test.', gaps: [] }) }), goal:GOAL, tabSource:{ list:async()=>tabs, read:async()=>{reads++;} },
    model:async()=>{calls++;return {role:'assistant',content:'broken'};}, onTrace:e=>events.push(e) });
  assert.equal(result.status,'error'); assert.equal(reads,0); assert.equal(calls,2);
  assert.ok(events.some(e=>e.kind==='error'));
});

test('duplicate document views are rejected without collapsing version queries or hash routes', () => {
  assert.throws(() => validateTriage(decision([481,482,487]), tabs), /same document/);
  for (const urls of [
    ['https://example.com/docs?version=1', 'https://example.com/docs?version=2'],
    ['https://example.com/#/docs/a', 'https://example.com/#/docs/b']
  ]) {
    const input = tabs.slice(0,2).map((tab,i) => ({ ...tab, url: urls[i] }));
    assert.doesNotThrow(() => validateTriage({ open: input.map(tab => ({id:tab.id,why:'Inspect this distinct documentation version.'})), skip:[], note:null },input));
  }
});

test('repair request reports all long reasons together', async () => {
  const bad = decision();
  bad.open[0].why = bad.open[1].why = Array(15).fill('polling').join(' ');
  let calls = 0;
  await runTriage({goal:GOAL,tabs,model:async ({messages})=>{
    if(++calls===1) return response(bad);
    assert.match(messages.at(-1).content,/tab 481/);
    assert.match(messages.at(-1).content,/tab 482/);
    return response(decision());
  }});
  assert.equal(calls,2);
});

test('OpenRouter triage requests JSON mode without exposing function tools', async () => {
  const model = createOpenRouterModel({env:{OPENROUTER_API_KEY:'fake'},fetchImpl:async (_,init)=>{
    const body=JSON.parse(init.body);
    assert.deepEqual(body.response_format,{type:'json_object'});
    assert.equal(body.tools,undefined); assert.equal(body.tool_choice,undefined);
    return new Response(JSON.stringify({choices:[{message:response(decision())}]}));
  }});
  await runTriage({goal:GOAL,tabs,model});
});

for (let run = 1; run <= 3; run++) {
  test(`live triage acceptance ${run}/3: ${GOAL}`, { skip: !process.env.OPENROUTER_API_KEY && 'Use node --env-file=.env --test agent/evals/triage.test.js for live evaluation' }, async () => {
    let result;
    const save = async value => {
      if (!process.env.TRIAGE_EVAL_OUTPUT_DIR) return;
      await mkdir(process.env.TRIAGE_EVAL_OUTPUT_DIR, { recursive: true });
      await writeFile(join(process.env.TRIAGE_EVAL_OUTPUT_DIR, `run-${run}.json`), JSON.stringify({ goal: GOAL, ...value }, null, 2));
    };
    try {
      result = await runTriage({ goal:GOAL, tabs, model:createOpenRouterModel({env:process.env, timeoutMs:45000}) });
      const parsed = JSON.parse(result.rawOutputs.at(-1));
      validateTriage(parsed,tabs);
      assert.ok(result.open.length>=3 && result.open.length<=8, `Opened ${result.open.length} tabs`);
      assert.equal(result.open.some(x=>[483,489,490,491].includes(x.id)),false,'Opened a known marketing/landing page');
      assert.ok(result.open.some(x=>[481,482].includes(x.id)),'Neither clearly on-topic tab was selected');
      for (const choice of [...result.open,...result.skip]) {
        assert.ok(choice.why.trim().split(/\s+/u).length<15,choice.why);
        assert.doesNotMatch(choice.why,/^(?:very |highly )?relevant to (?:the |this )?goal[.!]?$/i);
      }
      await save({ passed: true, result });
      console.log(`Run ${run}: opened ${result.open.map(x=>x.id).join(', ')}; JSON valid; reasons under 15 words.`);
    } catch (error) {
      await save({ passed: false, error: error.message, rawOutputs: error.rawOutputs ?? result?.rawOutputs ?? [] });
      console.error(`\nFULL MODEL OUTPUT — triage run ${run}\n${(error.rawOutputs ?? result?.rawOutputs ?? ['No model output received']).join('\n--- retry ---\n')}\n`);
      throw error;
    }
  });
}


test('correction reports duplicate IDs, missing IDs and duplicate documents together', async () => {
  const bad = decision([481, 482, 487]);
  bad.skip.push({ ...bad.open[0] });
  bad.skip = bad.skip.filter(t => t.id !== 500);
  let calls = 0;
  const result = await runTriage({ goal: GOAL, tabs, model: async ({ messages }) => {
    if (++calls === 1) return response(bad);
    const correction = messages.at(-1).content;
    assert.match(correction, /Repeated tab ID: 481/);
    assert.match(correction, /missing IDs: 500/);
    assert.match(correction, /482 and 487.*same document/);
    assert.match(correction, /Build skip from the known IDs NOT in that final open list/);
    assert.match(correction, /exactly 20 entries/);
    assert.ok(correction.includes(GOAL));
    return response(decision());
  } });
  assert.equal(result.modelCalls, 2);
  assert.equal(new Set([...result.open, ...result.skip].map(t => t.id)).size, tabs.length);
});

test('correction that fixes duplicate RFC views but repeats 481 still fails before reads', async () => {
  let calls = 0, reads = 0;
  const first = decision([481, 482, 487]);
  const correction = decision(); correction.skip.push({ ...correction.open[0] });
  const result = await runAgent({ goal: GOAL, env: {}, onTrace: () => {}, tabSource: {
    list: async () => tabs, read: async () => { reads++; throw new Error('Must not read'); }
  }, model: async () => response(++calls === 1 ? first : correction) });
  assert.equal(result.status, 'error'); assert.equal(calls, 2); assert.equal(reads, 0);
});

test('live correction fixes duplicate document views without overlapping open and skip IDs', { skip: !process.env.OPENROUTER_API_KEY }, async () => {
  const liveModel = createOpenRouterModel({ env: process.env, timeoutMs: 45000 });
  let calls = 0;
  try {
    const result = await runTriage({ goal: GOAL, tabs, model: request => ++calls === 1
      ? response(decision([481, 482, 487])) : liveModel(request) });
    assert.equal(result.modelCalls, 2);
    validateTriage(JSON.parse(result.rawOutputs.at(-1)), tabs);
    const openIds = new Set(result.open.map(t => t.id));
    assert.ok(result.skip.every(t => !openIds.has(t.id)));
    console.log(`Live correction: ${result.open.length} open, ${result.skip.length} skip; no overlap.`);
  } catch (error) { console.error('FULL CORRECTION OUTPUT', error.rawOutputs); throw error; }
});
