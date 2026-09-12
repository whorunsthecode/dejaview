export async function selectHistory({ goal, query, mode, candidates, cap, model, maxModelCalls = 2 }) {
  if (!candidates.length || cap <= 0) return { open: [], note: null, modelCalls: 0, rawOutputs: [] };
  const url = new URL('./prompts/history.md', import.meta.url);
  const prompt = globalThis.process?.versions?.node ? await (await import('node:fs/promises')).readFile(url, 'utf8') : await (await fetch(url)).text();
  const messages = [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ goal, query, mode, candidates, cap }) }];
  const rawOutputs = [];
  for (let i = 0; i < Math.min(2, maxModelCalls); i++) {
    const response = await model({ phase: 'history', messages: structuredClone(messages), responseFormat: { type: 'json_object' } });
    rawOutputs.push(response?.content ?? '');
    try {
      const value = JSON.parse(response.content);
      if (response.role !== 'assistant' || response.tool_calls?.length || !value || Object.keys(value).sort().join(',') !== 'note,open' || !Array.isArray(value.open) || (value.note !== null && typeof value.note !== 'string')) throw new Error('Expected open array and note');
      const seen = new Set();
      for (const choice of value.open) {
        if (!choice || Object.keys(choice).sort().join(',') !== 'historyId,why' || !candidates.some(c => c.historyId === choice.historyId) || seen.has(choice.historyId) || typeof choice.why !== 'string' || !choice.why.trim()) throw new Error('Each selection needs a unique known historyId and reason');
        seen.add(choice.historyId);
      }
      return { ...value, open: value.open.slice(0, cap), truncated: Math.max(0, value.open.length - cap), modelCalls: i + 1, rawOutputs };
    } catch (error) {
      if (i + 1 >= Math.min(2, maxModelCalls)) throw Object.assign(new Error(`History selection failed: ${error.message}`), { modelCalls: i + 1, rawOutputs });
      messages.push({ role: 'assistant', content: rawOutputs.at(-1) }, { role: 'user', content: `Validation error: ${error.message}. Return corrected JSON only.` });
    }
  }
  throw new Error('No model turns remaining for history selection');
}
