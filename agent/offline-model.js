/** Deterministic plumbing fixture, not triage or conversion logic. No network calls. */
export function createOfflineModel() {
  let step = 0;
  return async ({ messages, phase }) => {
    if (phase === 'peek-selection') {
      const { tabs, cap } = JSON.parse(messages.at(-1).content);
      return { role: 'assistant', content: JSON.stringify({ open: tabs.slice(0, cap).map(t => ({ id: t.id, why: 'Exercise readable previews in the offline fixture.' })), note: 'Offline preview fixture, not model judgment.' }) };
    }
    if (phase === 'gaps') return { role: 'assistant', content: JSON.stringify({ covered: 'The offline tabs demonstrate OAuth procedures.', gaps: [{ missing: 'Mobile shader banding procedure.', query: 'mobile shader banding' }] }) };
    if (phase === 'loose') return { role: 'assistant', content: JSON.stringify({ rhymes: [], none: 'No analogy evaluated by this deterministic fixture.' }) };
    if (phase === 'passages') {
      const tabs = JSON.parse(messages.at(-1).content).tabs;
      return { role: 'assistant', content: JSON.stringify({ passages: tabs.map(tab => ({
        tabId: tab.id, quote: tab.text.split('\n\n')[0], why: 'Exact source span for the offline plumbing fixture.'
      })), empty: [] }) };
    }
    if (phase === 'triage') {
      const tabs = JSON.parse(messages.at(-1).content).tabs;
      const selected = new Set([481, 486]);
      return { role: 'assistant', content: JSON.stringify({
        open: tabs.filter(tab => selected.has(tab.id)).map(tab => ({ id: tab.id, why: 'Exercise this tab in the offline plumbing fixture.' })),
        skip: tabs.filter(tab => !selected.has(tab.id)).map(tab => ({ id: tab.id, why: 'Outside the deterministic plumbing fixture selection.' })),
        note: 'Offline fixture selection; no model judgment is being tested.'
      }) };
    }
    const results = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    const tabs = results.find(Array.isArray) ?? [];
    const readable = tabs.find(tab => tab.textStatus === 'ok');
    const blocked = tabs.find(tab => tab.textStatus === 'blocked');
    const sequence = [
      ['list_tabs', {}, 'Offline fixture: inspect available metadata.'],
      ['read_tab', { id: readable?.id }, 'Offline fixture: exercise a readable tab.'],
      ['read_tab', { id: blocked?.id ?? readable?.id }, 'Offline fixture: exercise a blocked tab.'],
      ['search_in_tab', { id: readable?.id, query: 'token' }, 'Offline fixture: search text already read.'],
      ['read_tab', { id: -1 }, 'Offline fixture: deliberately exercise an unknown-tab exception.'],
      ['web_search', { query: 'mobile shader banding' }, 'The offline fixtures do not cover mobile shader banding; web search is disabled.'],
      ['write_skill', {
        name: 'offline-coverage-note', description: 'Offline plumbing fixture; not an executable skill.',
        body: 'No model ran. The OAuth fixture tabs do not support the requested shader procedure. Live triage and conversion remain unverified.', sources: []
      }, 'Offline fixture: finish with an honest coverage note.']
    ];
    const [name, args, content] = sequence[step++];
    return { role: 'assistant', content, tool_calls: [{ id: `offline-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
  };
}
