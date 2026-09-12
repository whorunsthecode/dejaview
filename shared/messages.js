/**
 * The message bus. Everything the panel, the service worker and the content
 * script say to each other goes through here.
 *
 * Direction is a convention, not something the code enforces:
 *
 *   PING       panel  -> worker    liveness handshake; replies
 *   RUN        panel  -> worker    start a run; replies with an ack
 *   TRACE      worker -> panel     one trace event; no reply
 *   HIGHLIGHT  worker -> content   highlight a passage in a page; replies
 *   SKILL      worker -> panel     the finished SKILL.md; no reply
 */

export const MSG = Object.freeze({
  PING: "PING",
  RUN: "RUN",
  TRACE: "TRACE",
  HIGHLIGHT: "HIGHLIGHT",
  SKILL: "SKILL"
});

function hasRuntime() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
}

/**
 * Fire and forget. For the one-way types (TRACE, SKILL), where nothing is
 * waiting on a reply and a sleeping receiver is not an error.
 * @param {keyof typeof MSG} type
 * @param {object} payload
 */
export function send(type, payload) {
  if (!hasRuntime()) return;
  // Rejection here is routine: it only means nothing was listening.
  Promise.resolve(chrome.runtime.sendMessage({ type, payload })).catch(() => {});
}

/**
 * Send and wait for the reply. Rejects if nothing is listening for `type`,
 * which is the honest outcome when the worker failed to start.
 * @param {keyof typeof MSG} type
 * @param {object} payload
 * @returns {Promise<any>}
 */
export async function request(type, payload) {
  if (!hasRuntime()) {
    throw new Error(`request(${type}): no chrome.runtime in this context`);
  }
  try {
    return await chrome.runtime.sendMessage({ type, payload });
  } catch (err) {
    throw new Error(`request(${type}) failed: ${err?.message ?? String(err)}`);
  }
}

/**
 * Subscribe to one message type. Whatever the handler returns becomes the
 * reply; return undefined to send none. Returns an unsubscribe fn.
 *
 * Chrome hands every message to every listener, so a listener that does not own
 * this type has to return undefined straight away. Returning true there would
 * hold the response port open and stall the listener that does own it.
 *
 * @param {keyof typeof MSG} type
 * @param {(payload: any, sender: any) => any} handler
 * @returns {() => void}
 */
export function on(type, handler) {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return () => {};

  const listener = (msg, sender, sendResponse) => {
    if (!msg || msg.type !== type) return undefined;

    let result;
    try {
      result = handler(msg.payload, sender);
    } catch (err) {
      sendResponse({ ok: false, error: err?.message ?? String(err) });
      return false;
    }

    if (result && typeof result.then === "function") {
      result
        .then((value) => sendResponse(value))
        .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
      return true; // hold the port open until the promise settles
    }

    if (result !== undefined) sendResponse(result);
    return false;
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
