import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { credentialState, persistCredentials } from '../extension/panel/credentials.js';
import { createNotionPage } from '../extension/panel/notion.js';

// All values in this file are synthetic; never load the user's keys.
const entry = value => ({ key: 'NOTION_TOKEN', label: 'Notion', secret: true, value });

test('blank credentials retain previous values while new entries are saved with settings', async () => {
  const data = { OPENROUTER_API_KEY: 'test-existing' };
  const storage = {
    set: async update => Object.assign(data, update),
    get: async keys => Object.fromEntries(keys.map(key => [key, data[key]]))
  };
  await persistCredentials(storage, [entry(' test-notion '), { ...entry(''), key: 'OPENROUTER_API_KEY' }], { rediscoveryEnabled: false });
  assert.deepEqual(data, { OPENROUTER_API_KEY: 'test-existing', NOTION_TOKEN: 'test-notion', rediscoveryEnabled: false });
  assert.equal(credentialState(data.NOTION_TOKEN), 'Saved locally');
  assert.equal(credentialState(undefined), 'Not saved');
});

test('malformed pasted tokens are rejected before storage or a Notion request', async () => {
  for (const token of ['test\u200btoken', '\u201ctest-token\u201d', 'test token', '"test-token"']) {
    let writes = 0;
    await assert.rejects(persistCredentials({ set: async () => { writes++; } }, [entry(token)]), /Notion: paste only the key/);
    assert.equal(writes, 0);
    assert.equal(credentialState(token), 'Needs attention');
    const result = await createNotionPage({ token, parentId: 'a'.repeat(32), markdown: '# Example' });
    assert.equal(result.ok, false);
    assert.match(result.error, /unsupported characters/);
    assert.ok(!result.error.includes(token));
  }
});

test('failed or unretained storage writes report a safe error', async () => {
  for (const storage of [
    { set: async () => { throw new Error('test-secret-do-not-show'); } },
    { set: async () => {}, get: async () => ({}) }
  ]) {
    await assert.rejects(persistCredentials(storage, [entry('test-token')]), error => {
      assert.match(error.message, /Could not confirm the save/);
      assert.ok(!error.message.includes('test-secret'));
      return true;
    });
  }
});

test('a key for another provider cannot be saved as OpenRouter', async () => {
  let writes = 0;
  await assert.rejects(persistCredentials({ set: async () => { writes++; } }, [
    { ...entry('test-other-provider'), key: 'OPENROUTER_API_KEY', label: 'OpenRouter' }
  ]), /OpenRouter: paste the full API key beginning sk-or-/);
  assert.equal(writes, 0);
  assert.equal(credentialState('test-other-provider', true, 'OPENROUTER_API_KEY'), 'Needs attention');
});

test('panel confirms a save, keeps keys blank on reopen, and preserves edits after a failed save', async () => {
  const dom = new JSDOM(await readFile(new URL('../extension/panel/panel.html', import.meta.url), 'utf8'), { url: 'https://panel.example/' });
  const savedGlobals = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  const data = { OPENROUTER_API_KEY: 'sk-or-v1-test-existing' };
  let failWrite = false;
  try {
    globalThis.document = dom.window.document;
    globalThis.fetch = async () => ({ json: async () => [] });
    globalThis.chrome = {
      runtime: {
        getURL: path => path,
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage: async () => ({ ok: true, hasKey: true, tabCount: 1, windowCount: 1 })
      },
      storage: { local: {
        get: async keys => Object.fromEntries(keys.map(key => [key, data[key]])),
        set: async update => { if (failWrite) throw new Error('storage unavailable'); Object.assign(data, update); }
      } }
    };
    await import('../extension/panel/panel.js');
    const form = document.getElementById('key-form');
    const button = document.getElementById('save-key');
    const input = document.getElementById('notion-token');
    const badge = document.getElementById('notion-token-status');
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    document.getElementById('keys-toggle').click();
    await tick();
    assert.equal(document.getElementById('api-key-status').textContent, 'Saved locally');
    assert.equal(document.getElementById('api-key').value, '');
    input.value = 'test-notion';
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await tick();
    assert.equal(data.NOTION_TOKEN, 'test-notion');
    assert.equal(input.value, '');
    assert.equal(badge.textContent, 'Saved locally');
    assert.equal(form.hidden, false);
    assert.equal(button.disabled, false);
    document.getElementById('keys-toggle').click();
    document.getElementById('keys-toggle').click();
    await tick();
    assert.equal(badge.textContent, 'Saved locally');
    assert.equal(input.value, '');
    failWrite = true;
    input.value = 'test-replacement';
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await tick();
    assert.equal(input.value, 'test-replacement');
    assert.equal(data.NOTION_TOKEN, 'test-notion');
    assert.match(document.getElementById('key-feedback').textContent, /Could not confirm the save/);
    assert.equal(button.disabled, false);
  } finally {
    Object.assign(globalThis, savedGlobals);
    dom.window.close();
  }
});
