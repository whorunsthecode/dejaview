/**
 * The panel's two settings groups, and the write they ride on.
 *
 * Its own file because node caches a module per process: panel.js can only be
 * imported once, bound to the first DOM it sees, so a second test driving it in
 * another file's process would be talking to the wrong document.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('the toggles save with the credentials, and with no credential typed at all', async () => {
  // Both settings groups ride the credential write. A merge that rebuilt this
  // handler already dropped them once: the toggles kept working on screen and
  // silently persisted nothing, which is invisible until the next reload.
  const dom = new JSDOM(await readFile(new URL('../extension/panel/panel.html', import.meta.url), 'utf8'), { url: 'https://panel.example/' });
  const savedGlobals = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  const data = {};
  try {
    globalThis.document = dom.window.document;
    globalThis.fetch = async () => ({ json: async () => [] });
    globalThis.chrome = {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getURL: path => path,
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage: async () => ({ ok: true, hasKey: true, tabCount: 1, windowCount: 1 })
      },
      storage: { local: {
        get: async keys => Object.fromEntries(keys.map(key => [key, data[key]])),
        set: async update => { Object.assign(data, update); }
      } }
    };
    await import('../extension/panel/panel.js');
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));

    // showKeyForm awaits storage several times before it finishes populating the
    // fields; setting them too early would just be overwritten by that fill.
    document.getElementById('keys-toggle').click();
    for (let i = 0; i < 12; i++) await tick();

    document.getElementById('local-enabled').checked = true;
    document.getElementById('local-url').value = 'localhost:11434';
    document.getElementById('local-name').value = 'qwen2.5:7b';
    document.getElementById('red-enabled').checked = false;

    // No credential typed: the save must still happen.
    document.getElementById('key-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    for (let i = 0; i < 12; i++) await tick();

    assert.equal(data.LOCAL_MODEL_ENABLED, true, 'the local switch did not persist');
    assert.equal(data.LOCAL_MODEL_URL, 'http://localhost:11434/v1', 'the URL was stored unnormalised');
    assert.equal(data.LOCAL_MODEL_NAME, 'qwen2.5:7b');
    assert.equal(data.REDISCOVERY_ENABLED, false, 'the rediscovery switch did not persist');
  } finally {
    Object.assign(globalThis, savedGlobals);
    dom.window.close();
  }
});
