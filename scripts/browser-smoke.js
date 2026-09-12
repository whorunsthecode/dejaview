import { peekTab } from '../extension/peek.js';
import { TextCache } from '../extension/text-cache.js';
import { verifyQuotes } from '../agent/verify-quotes.js';
import { highlightTab } from '../extension/highlight.js';
import { withTimeout } from '../shared/concurrency.js';

const out = document.querySelector('#out');
const buttons = [...document.querySelectorAll('button')];
const log = (stage, data) => { out.textContent += `${stage}: ${JSON.stringify(data)}\n`; };
async function target() {
  const [tab] = await chrome.tabs.query({ url: 'https://github.com/FlowiseAI/Flowise' });
  if (!tab) throw new Error('Existing Flowise tab not found.');
  return tab;
}
async function action(run) {
  out.textContent = '';
  buttons.forEach(b => b.disabled = true);
  try { await run(); } catch (error) { log('FAIL', error.message); }
  finally { buttons.forEach(b => b.disabled = false); }
}
document.querySelector('#load').onclick = () => action(async () => {
  const panel = await chrome.tabs.getCurrent();
  const tab = await target();
  await chrome.tabs.update(tab.id, { active: true });
  try {
    await withTimeout(new Promise((resolve, reject) => {
      const check = async () => {
        try {
          const now = await chrome.tabs.get(tab.id);
          if (now.status === 'complete' && !now.discarded) resolve();
          else timer = setTimeout(check, 200);
        } catch (error) { reject(error); }
      };
      let timer;
      check();
      setTimeout(() => { clearTimeout(timer); reject(new Error('Source did not finish loading')); }, 15000);
    }), 16000);
    log('Loaded source', { id: tab.id });
  } finally { await chrome.tabs.update(panel.id, { active: true }); }
});
document.querySelector('#run').onclick = () => action(async () => {
  const started = performance.now();
  const tab = await target();
  const all = await chrome.tabs.query({});
  log('Inventory', { total: all.length, sourceWindow: all.filter(t => t.windowId === tab.windowId).length });
  log('Source state', { id: tab.id, active: tab.active, status: tab.status, discarded: tab.discarded, frozen: tab.frozen });
  const peek = await peekTab(tab.id, chrome, { throwOnError: true });
  log('Preview', { status: peek.textStatus, chars: peek.description.length + peek.heading.length + peek.paragraph.length });
  if (peek.textStatus !== 'ok') throw new Error(`Preview ${peek.textStatus}; load the source first.`);
  const cache = new TextCache();
  const read = await cache.get(tab.id);
  log('Read', { status: read.textStatus, chars: read.text?.length, cached: read.cached, error: read.error });
  if (read.textStatus !== 'ok') throw new Error(read.error || read.textStatus);
  const warm = await cache.get(tab.id);
  log('Warm read', { status: warm.textStatus, chars: warm.text?.length, cached: warm.cached, error: warm.error });
  if (warm.textStatus !== 'ok' || !warm.cached) throw new Error('Warm cache was not reusable');
  const quote = 'Flowise has 3 different modules in a single mono repository.';
  const verified = verifyQuotes([{ tabId: tab.id, quote, why: 'Names the repository structure.' }], new Map([[tab.id, read]]));
  log('Quote verification', { ok: verified.ok.length, repaired: verified.repaired.length, failed: verified.failed.length });
  if (verified.ok.length !== 1) throw new Error('Known source sentence failed verification');
  const highlighted = await withTimeout(highlightTab(tab.id, [verified.ok[0].quote]));
  log('Highlight', highlighted);
  if (highlighted.matched !== 1) throw new Error('Expected one highlight');
  log('PASS', { ms: Math.round(performance.now() - started), modelCalls: 0 });
});
