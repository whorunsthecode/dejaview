import { MSG, send as sharedSend, on as sharedOn } from '../shared/messages.js';
import { isTraceEvent } from '../shared/types.js';
import { runAgent } from './host.js';

/**
 * Bind the existing four application messages to K1 without importing browser APIs.
 * The composition entry point injects tabSource, credentials, and the agreed skill
 * serializer. Runtime credentials must be supplied by that entry point: browsers
 * cannot load Node's .env automatically.
 *
 * Call dispose() when the hosting page/transport closes. It suppresses subsequent
 * output; it cannot cancel an already running model request (K1 has no cancel API).
 * renderSkill receives the validated write_skill payload and returns Markdown.
 */
export function attachMessageHost({
  tabSource, env = {}, renderSkill,
  send = sharedSend, on = sharedOn, runner = runAgent,
  ...runnerOptions
}) {
  if (!tabSource?.list || !tabSource?.read) throw new Error('A TabSource with list() and read(id) is required');
  if (typeof renderSkill !== 'function') throw new Error('An agreed renderSkill(payload) serializer is required');
  let active = false;
  let disposed = false;
  function trace(kind, label) {
    const event = { t: Date.now(), kind, label, detail: '', ref: null };
    isTraceEvent(event);
    if (!disposed) send(MSG.TRACE, { event });
  }
  async function run(payload) {
    if (disposed) throw new Error('Agent message host is disposed');
    if (!payload || typeof payload.goal !== 'string' || !payload.goal.trim()) {
      trace('error', 'RUN requires a nonempty goal.');
      return null;
    }
    if (active) {
      trace('note', 'A run is already in progress. Wait for it to finish.');
      return null;
    }
    active = true;
    try {
      const result = await runner({
        ...runnerOptions, goal: payload.goal, tabSource, env,
        onTrace(event) {
          isTraceEvent(event);
          if (!disposed) send(MSG.TRACE, { event });
        }
      });
      if (result.skill && !disposed) {
        const markdown = await renderSkill(result.skill);
        if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('Skill serializer must return nonempty Markdown');
        if (!disposed) send(MSG.SKILL, { markdown });
      }
      return result;
    } finally { active = false; }
  }
  // The shared on() handler cannot return an async runtime response. Output travels
  // through TRACE/SKILL; run() is separately exposed for callers that need a result.
  const unsubscribe = on(MSG.RUN, payload => {
    void run(payload).catch(error => {
      trace('error', `Agent message host failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  return {
    run,
    get busy() { return active; },
    dispose() { disposed = true; unsubscribe(); }
  };
}
