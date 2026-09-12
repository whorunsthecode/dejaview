import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../host.js';
import { attachMessageHost } from '../message-host.js';
import { StubTabSource } from '../tab-sources.js';
import { createOfflineModel } from '../offline-model.js';
import { MSG } from '../../shared/messages.js';

const goal = 'Exercise captured trace and highlight plumbing';
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dejavu-replay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixturePath = join(dir, 'golden.json'), source = new StubTabSource();
  return { fixturePath, source };
}
async function capture(fixturePath, source, overrides = {}) {
  const sent = [];
  const host = attachMessageHost({ fixturePath, tabSource: source, env: { RECORD: '1' }, model: createOfflineModel(),
    send: (type, payload) => sent.push({ type, payload }), on: () => () => {}, renderSkill: payload => JSON.stringify(payload), ...overrides });
  const result = await host.run({ goal }); host.dispose();
  return { sent, result, fixture: JSON.parse(await readFile(fixturePath, 'utf8')) };
}
test('record/replay reproduce panel and highlight bytes with no model, fetch or read calls', async t => {
  const { fixturePath, source } = await setup(t);
  const { sent, result, fixture } = await capture(fixturePath, source);
  assert.equal(result.status, 'complete');
  assert.ok(fixture._header.includes('same demo Chrome profile'));
  for (const kind of ['trace', 'highlight', 'model_response', 'tool_call', 'tool_result']) assert.ok(fixture.events.some(e => e.kind === kind));
  assert.equal(fixture.events.filter(e => e.kind === 'tool_call').length, fixture.events.filter(e => e.kind === 'tool_result').length);
  assert.ok(fixture.events.every((e, i) => e.at >= (fixture.events[i - 1]?.at ?? 0)));
  assert.ok(fixture.referencedTabs.some(t => t.id === 481));
  const replayed = [];
  const forbidden = () => { throw new Error('Replay attempted a forbidden live operation'); };
  const host = attachMessageHost({ fixturePath, tabSource: { list: () => source.list(), read: forbidden },
    env: { REPLAY: '1', REPLAY_SPEED: '10000' }, model: forbidden, fetchImpl: forbidden,
    send: (type, payload) => replayed.push({ type, payload }), on: () => () => {}, renderSkill: payload => JSON.stringify(payload) });
  const replayResult = await host.run({ goal: 'ignored during replay' }); host.dispose();
  assert.equal(JSON.stringify(replayed), JSON.stringify(sent));
  assert.equal(JSON.stringify(replayResult), JSON.stringify(result));
  assert.ok(replayed.some(x => x.type === MSG.HIGHLIGHT)); assert.ok(replayed.some(x => x.type === MSG.SKILL));
});
test('missing recorded IDs or changed URLs fail before any recorded output or highlights', async t => {
  const { fixturePath, source } = await setup(t); await capture(fixturePath, source);
  for (const current of [[], (await source.list()).map(t => ({ ...t, url: 'https://different.example/' }))]) {
    const events = [], highlights = [];
    await assert.rejects(runAgent({ fixturePath, goal, env: { REPLAY: '1' }, tabSource: { list: async () => current },
      onTrace: e => events.push(e), onHighlight: p => highlights.push(p) }), /Replay cannot start.*481/);
    assert.equal(events.length, 1); assert.equal(events[0].kind, 'error'); assert.equal(highlights.length, 0);
  }
});
test('replay timing scales while recorded timestamps remain unchanged', async t => {
  const { fixturePath, source } = await setup(t);
  const { fixture } = await capture(fixturePath, source);
  const traces = fixture.events.filter(e => e.kind === 'trace').slice(0, 2);
  fixture.events = traces.map((e, i) => ({ ...e, at: i * 200 }));
  await writeFile(fixturePath, JSON.stringify(fixture));
  const delivered = [], started = performance.now();
  await runAgent({ fixturePath, goal, env: { REPLAY: '1', REPLAY_SPEED: '2' }, tabSource: source, onTrace: e => delivered.push(e) });
  assert.ok(performance.now() - started >= 80);
  assert.deepEqual(delivered, traces.map(e => e.data));
});
test('invalid replay config and malformed traces fail loudly; partial captures preserve golden file', async t => {
  const { fixturePath, source } = await setup(t); const { fixture } = await capture(fixturePath, source);
  const original = await readFile(fixturePath, 'utf8');
  await assert.rejects(runAgent({ goal, fixturePath, env: { RECORD: '1', REPLAY: '1' }, onTrace: () => {} }), /not both/);
  await assert.rejects(runAgent({ goal, fixturePath, tabSource: source, env: { REPLAY: '1', REPLAY_SPEED: '0' }, onTrace: () => {} }), /positive/);
  await assert.rejects(runAgent({ goal, fixturePath, tabSource: source, env: { RECORD: '1' }, model: async () => { throw new Error('Model unavailable'); }, onTrace: () => {} }), /Existing fixture preserved/);
  assert.equal(await readFile(fixturePath, 'utf8'), original);
  fixture.events.find(e => e.kind === 'trace').data.kind = 'invalid';
  await writeFile(fixturePath, JSON.stringify(fixture));
  await assert.rejects(runAgent({ goal, fixturePath, tabSource: source, env: { REPLAY: '1' }, onTrace: () => {} }));
});

test('captured live fixture replays with process network APIs disabled and identical consumer bytes', async () => {
  const fixturePath = new URL('../fixtures/golden-run.json', import.meta.url);
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const originals = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, tls: tls.connect, http: http.request, https: https.request };
  let networkAttempts = 0;
  const forbidden = () => { networkAttempts++; throw new Error('NETWORK DISABLED FOR REPLAY TEST'); };
  const sent = [];
  try {
    globalThis.fetch = forbidden; net.Socket.prototype.connect = forbidden; tls.connect = forbidden; http.request = forbidden; https.request = forbidden;
    const host = attachMessageHost({ fixturePath, tabSource: new StubTabSource(), env: { REPLAY: '1', REPLAY_SPEED: '100000' },
      model: forbidden, send: (type, payload) => sent.push({ type, payload }), on: () => () => {}, renderSkill: payload => JSON.stringify(payload) });
    const result = await host.run({ goal }); host.dispose();
    assert.equal(result.status, 'complete'); assert.equal(networkAttempts, 0);
  } finally {
    globalThis.fetch = originals.fetch; net.Socket.prototype.connect = originals.connect; tls.connect = originals.tls; http.request = originals.http; https.request = originals.https;
  }
  const expected = fixture.events.filter(e => ['trace', 'highlight'].includes(e.kind)).map(e => e.kind === 'trace'
    ? { type: MSG.TRACE, payload: { event: e.data } } : { type: MSG.HIGHLIGHT, payload: e.data });
  expected.push({ type: MSG.SKILL, payload: { markdown: JSON.stringify(fixture.result.skill) } });
  assert.equal(JSON.stringify(sent), JSON.stringify(expected));
});
