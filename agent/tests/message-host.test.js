import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMessageHost } from '../message-host.js';
import { MSG } from '../../shared/messages.js';
import { StubTabSource } from '../tab-sources.js';
import { createOfflineModel } from '../offline-model.js';
import { isTraceEvent } from '../../shared/types.js';

function setup(options = {}) {
  const sent = [];
  let subscribed = null;
  let detached = false;
  const host = attachMessageHost({ tabSource: new StubTabSource(),
    renderSkill: payload => payload.body,
    send: (type, payload) => sent.push({ type, payload }),
    on: (type, callback) => { assert.equal(type, MSG.RUN); subscribed = callback; return () => { detached = true; }; },
    model: createOfflineModel(), ...options });
  return { host, sent, dispatch: payload => subscribed(payload), detached: () => detached };
}

test('message host runs K1 and emits exact TRACE and SKILL payload wrappers', async () => {
  const { host, sent } = setup();
  const result = await host.run({ goal: 'test' });
  assert.equal(result.status, 'complete');
  const traces = sent.filter(x => x.type === MSG.TRACE);
  assert.ok(traces.length);
  for (const { payload } of traces) {
    assert.deepEqual(Object.keys(payload), ['event']);
    isTraceEvent(payload.event);
  }
  const skills = sent.filter(x => x.type === MSG.SKILL);
  assert.equal(skills.length, 1);
  assert.deepEqual(skills[0].payload, { markdown: result.skill.body });
  assert.equal(host.busy, false);
});

test('invalid RUN and concurrent RUN do not start extra model loops', async () => {
  let finish, calls = 0;
  const { host, sent } = setup({ runner: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(await host.run({ goal: '' }), null);
  const pending = host.run({ goal: 'first' });
  assert.equal(await host.run({ goal: 'second' }), null);
  assert.equal(calls, 1);
  finish({ status: 'partial', skill: null });
  await pending;
  assert.ok(sent.some(x => x.payload.event.kind === 'error'));
  assert.ok(sent.some(x => x.payload.event.kind === 'note'));
});

test('malformed events fail loudly for direct callers and malformed Markdown is rejected', async () => {
  const badTrace = setup({ runner: async ({ onTrace }) => onTrace({ kind: 'done' }) });
  await assert.rejects(badTrace.host.run({ goal: 'test' }), /missing field/);
  const badSkill = setup({ runner: async () => ({ skill: { body: 'x' } }), renderSkill: () => undefined });
  await assert.rejects(badSkill.host.run({ goal: 'test' }), /Markdown/);
  assert.equal(badSkill.sent.some(x => x.type === MSG.SKILL), false);
});

test('dispose detaches listener and suppresses pending run output', async () => {
  let finish;
  const { host, sent, detached } = setup({ runner: () => new Promise(resolve => { finish = resolve; }) });
  const pending = host.run({ goal: 'test' });
  host.dispose();
  finish({ skill: { body: 'late' } });
  await pending;
  assert.equal(detached(), true);
  assert.deepEqual(sent, []);
  await assert.rejects(host.run({ goal: 'test' }), /disposed/);
});
