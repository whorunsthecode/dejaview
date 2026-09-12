export async function assessGaps({ goal, passages, queries, model, maxModelCalls = 2 }) {
  const url = new URL('./prompts/gaps.md', import.meta.url);
  const prompt = globalThis.process?.versions?.node ? await (await import('node:fs/promises')).readFile(url, 'utf8') : await (await fetch(url)).text();
  const messages = [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ goal, passages, attemptedQueries: queries }) }];
  const rawOutputs = [];
  for (let i = 0; i < Math.min(2, maxModelCalls); i++) {
    const response = await model({ phase: 'gaps', messages: structuredClone(messages), responseFormat: { type: 'json_object' } });
    rawOutputs.push(response?.content ?? '');
    try {
      const value = JSON.parse(response.content);
      if (response.role !== 'assistant' || response.tool_calls?.length || !value || typeof value.covered !== 'string' || !value.covered.trim() || !Array.isArray(value.gaps)) throw new Error('Expected covered sentence and gaps array');
      for (const gap of value.gaps) if (!gap || typeof gap.missing !== 'string' || !gap.missing.trim() || typeof gap.query !== 'string' || !gap.query.trim()) throw new Error('Each gap needs missing and query');
      return { ...value, rawOutputs, modelCalls: i + 1 };
    } catch (error) {
      if (i + 1 >= Math.min(2, maxModelCalls)) throw Object.assign(new Error(`Coverage validation failed: ${error.message}`), { rawOutputs, modelCalls: i + 1 });
      messages.push({ role: 'assistant', content: rawOutputs.at(-1) }, { role: 'user', content: `Validation error: ${error.message}. Return corrected JSON only.` });
    }
  }
  throw new Error('No turns remaining for coverage assessment');
}
