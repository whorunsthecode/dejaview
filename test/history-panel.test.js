import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('panel defaults history off and sends the explicit checkbox choice with RUN', async () => {
  const dom = new JSDOM(await readFile(new URL('../extension/panel/panel.html', import.meta.url), 'utf8'), { url: 'https://panel.example/' });
  const saved = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  const requests = [];
  try {
    globalThis.document = dom.window.document;
    globalThis.fetch = async () => ({ json: async () => [] });
    globalThis.chrome = { runtime: {
      getURL: path => path,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async message => {
        requests.push(message);
        return message.type === 'PING' ? { ok: true, hasKey: true, tabCount: 1, windowCount: 1 } : { ok: true, needsKey: true };
      }
    } };
    await import('../extension/panel/panel.js');
    const box = document.getElementById('include-history');
    assert.equal(box.checked, false);
    assert.equal(document.getElementById('read-limit'), null);
    document.getElementById('goal').value = 'Find a stored procedure';
    for (const checked of [false, true]) {
      box.checked = checked;
      document.getElementById('run-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(requests.filter(r => r.type === 'RUN').at(-1).payload, { goal: 'Find a stored procedure', includeHistory: checked });
    }
  } finally { Object.assign(globalThis, saved); dom.window.close(); }
});
