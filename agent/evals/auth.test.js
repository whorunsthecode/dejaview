import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterModel } from '../host.js';

test('OpenRouter 401 reports how to replace the key, does not retry or echo the response', async () => {
  let calls = 0;
  const model = createOpenRouterModel({
    env: { OPENROUTER_API_KEY: 'test-secret' },
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 401, text: async () => 'test-secret in an untrusted error body' };
    }
  });
  await assert.rejects(model({ messages: [] }), error => {
    assert.match(error.message, /OpenRouter rejected the API key \(HTTP 401\)/);
    assert.match(error.message, /Save changes/);
    assert.ok(!error.message.includes('test-secret'));
    return true;
  });
  assert.equal(calls, 1);
});
