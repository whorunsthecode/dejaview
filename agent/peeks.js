import { validateTriage } from './triage.js';

export async function selectPeeks({ goal, tabs, previews, cap, model, mode = 'tight' }) {
  const url = new URL('./prompts/peeks.md', import.meta.url);
  const prompt = globalThis.process?.versions?.node
    ? await (await import('node:fs/promises')).readFile(url, 'utf8')
    : await fetch(url).then(r => { if (!r.ok) throw new Error('Cannot load peek prompt'); return r.text(); });
  const available = tabs.filter(t => ['ok', 'empty'].includes(previews.find(p => p.id === t.id)?.textStatus));
  if (!available.length) return { open: [], note: 'No previewed page is currently readable.', modelCalls: 0, truncated: 0, rawOutputs: [] };
  const messages = [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ goal, mode, cap, tabs: available.map(t => ({ id: t.id, title: t.title, url: t.url, groupTitle: t.groupTitle, firstVisit: t.firstVisit, preview: previews.find(p => p.id === t.id) })) }) }];
  const rawOutputs = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await model({ phase: 'peek-selection', messages: structuredClone(messages), responseFormat: { type: 'json_object' } });
    rawOutputs.push(response?.content);
    try {
      if (response?.role !== 'assistant' || response.tool_calls?.length) throw new Error('Expected assistant JSON');
      const parsed = JSON.parse(response.content);
      if (!parsed || Object.keys(parsed).sort().join(',') !== 'note,open' || !Array.isArray(parsed.open)) throw new Error('Expected exactly open and note');
      const ids = new Set(parsed.open.map(c => c?.id));
      validateTriage({ ...parsed, skip: available.filter(t => !ids.has(t.id)).map(t => ({ id: t.id, why: 'Preview did not warrant a full read.' })) }, available);
      return { ...parsed, open: parsed.open.slice(0, cap), truncated: Math.max(0, parsed.open.length - cap), modelCalls: attempt + 1, rawOutputs };
    } catch (error) {
      if (attempt) throw Object.assign(new Error(`Peek selection failed: ${error.message}`), { modelCalls: 2, rawOutputs });
      messages.push({ role: 'assistant', content: response?.content ?? '' }, { role: 'user', content: `Validation error: ${error.message}. Return a complete corrected JSON object once.` });
    }
  }
}
