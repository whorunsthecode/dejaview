import { isTraceEvent } from '../shared/types.js';

export async function loadTriagePrompt() {
  const url = new URL('./prompts/triage.md', import.meta.url);
  if (globalThis.process?.versions?.node) {
    const { readFile } = await import('node:fs/promises');
    return readFile(url, 'utf8');
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error('Unable to load triage prompt');
  return response.text();
}

/** Explicit allowlist: even prefilled stubs cannot leak text or textStatus. */
export function triageMetadata(tabs) {
  const seen = new Set();
  return tabs.map(tab => {
    if (!Number.isFinite(tab.id) || seen.has(tab.id)) throw new Error('Triage input IDs must be unique finite numbers');
    seen.add(tab.id);
    return {
      id: tab.id, title: tab.title, url: tab.url, groupTitle: tab.groupTitle,
      firstVisit: tab.firstVisit === null ? null : new Date(tab.firstVisit).toISOString().slice(0, 10)
    };
  });
}

function canonicalDocument(url) {
  try {
    const value = new URL(url);
    if (!value.hash.includes('/') && !value.hash.startsWith('#!')) value.hash = '';
    for (const key of [...value.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$)/i.test(key)) value.searchParams.delete(key);
    }
    value.searchParams.sort();
    return value.href;
  } catch { return url; }
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validateTriage(value, tabs) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'note,open,skip') throw new Error('Expected exactly open, skip and note');
  if (!Array.isArray(value.open) || !Array.isArray(value.skip)) throw new Error('open and skip must be arrays');
  if (value.note !== null && (typeof value.note !== 'string' || !value.note.trim())) throw new Error('note must be nonempty text or null');
  const known = new Set(tabs.map(tab => tab.id)), seen = new Set(), issues = [];
  const documents = new Map();
  for (const choice of [...value.open, ...value.skip]) {
    if (!object(choice) || Object.keys(choice).sort().join(',') !== 'id,why') throw new Error('Each choice needs exactly id and why');
    if (!known.has(choice.id)) { issues.push(`Unknown tab ID: ${choice.id}`); continue; }
    if (seen.has(choice.id)) issues.push(`Repeated tab ID: ${choice.id}; it must occur once across both lists`);
    seen.add(choice.id);
    if (typeof choice.why !== 'string' || !choice.why.trim()) { issues.push(`Missing reason for tab ${choice.id}`); continue; }
    if (choice.why.trim().split(/\s+/u).length >= 15) issues.push(`Reason for tab ${choice.id} must be under 15 words`);
    const content = choice.why.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u)
      .filter(word => word && !new Set(['relevant','relevance','related','useful','helpful','information','very','highly','directly','potentially','to','the','this','that','goal','topic','is','it','seems','looks','a','an','for','about','and','not','unrelated']).has(word));
    if (!content.length) issues.push(`Reason for tab ${choice.id} only asserts relevance`);
  }
  const missing = [...known].filter(id => !seen.has(id));
  if (missing.length) issues.push(`Every tab must appear once in open or skip; missing IDs: ${missing.join(', ')}`);
  for (const { id } of value.open) {
    if (!known.has(id)) continue;
    const key = canonicalDocument(tabs.find(tab => tab.id === id).url);
    if (documents.has(key)) issues.push(`Open tabs ${documents.get(key)} and ${id} point to the same document; choose one`);
    documents.set(key, id);
  }
  if (issues.length) throw new Error(issues.join('; '));
  return value;
}

/** One logical triage, at most two model responses; no tab reads or other tools. */
export async function runTriage({ goal, tabs, cap = 8, model, onTrace = () => {} }) {
  if (!Number.isInteger(cap) || cap < 0 || cap > 8) throw new Error('Triage cap must be between 0 and 8');
  const metadata = triageMetadata(tabs);
  const template = await loadTriagePrompt();
  const messages = [
    { role: 'system', content: template.replace(/\{goal\}|\{cap\}/g, match => match === '{goal}' ? goal : String(cap)) },
    { role: 'user', content: JSON.stringify({ tabs: metadata }) }
  ];
  const rawOutputs = [];
  const emit = (kind, label) => {
    const event = { t: Date.now(), kind, label, detail: '', ref: null };
    isTraceEvent(event); onTrace(event);
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    // Network failures are handled by the transport, never by the JSON-repair retry.
    const response = await model({ phase: 'triage', messages: structuredClone(messages), responseFormat: { type: 'json_object' } });
    const raw = response?.content;
    rawOutputs.push(typeof raw === 'string' ? raw : JSON.stringify(response) ?? 'undefined');
    let parsed;
    try {
      if (response?.role !== 'assistant' || typeof raw !== 'string' || response.tool_calls?.length) throw new Error('Expected assistant JSON text without tool calls');
      parsed = validateTriage(JSON.parse(raw), metadata);
    } catch (cause) {
      if (attempt === 0) {
        emit('note', `Triage response needs correction: ${cause.message}`);
        messages.push({ role: 'assistant', content: rawOutputs.at(-1) },
          { role: 'user', content: `Parse/validation error: ${cause.message}. Return a complete replacement JSON object, not a patch. The goal remains: ${JSON.stringify(goal)}.
Known tab IDs: ${JSON.stringify(metadata.map(tab => tab.id))}.
Construct the replacement in this order:
1. Finalize the open list, with unique IDs and one representative per document.
2. Build skip from the known IDs NOT in that final open list. Never copy an open entry into skip. When removing a duplicate document view, move only that removed ID into skip; keep its representative only in open.
3. Check that concatenating open IDs and skip IDs has exactly ${metadata.length} entries, each known ID exactly once. Correct every reported issue together; do not carry over conflicting entries from the previous response.
Recheck ALL reasons, including entries moved into skip: use 6–10 words and never more than 14. A duplicate reason can be "Duplicate: same document as tab 123."` });
        continue;
      }
      emit('error', `Triage failed after one retry: ${cause.message}`);
      const error = new Error(`Triage failed: ${cause.message}`, { cause });
      Object.assign(error, { rawOutputs, modelCalls: 2, traceEmitted: true });
      throw error;
    }
    const truncated = parsed.open.length > cap ? parsed.open.splice(cap) : [];
    if (truncated.length) {
      parsed.skip.push(...truncated.map(({ id }) => ({ id, why: 'Read budget reserved for higher-priority tabs.' })));
      emit('note', `Triage proposed ${parsed.open.length + truncated.length} reads; capped at ${cap}.`);
    }
    return { ...parsed, rawOutputs, modelCalls: attempt + 1, truncated: truncated.length };
  }
}
