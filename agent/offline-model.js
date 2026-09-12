/** Deterministic plumbing fixture, not triage or conversion logic. No network calls. */
export function createOfflineModel() {
  let step = 0;
  return async ({ messages }) => {
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
