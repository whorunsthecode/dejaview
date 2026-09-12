export const MSG = Object.freeze({
  RUN: "RUN",
  TRACE: "TRACE",
  HIGHLIGHT: "HIGHLIGHT",
  SKILL: "SKILL"
});

/**
 * Send a message via chrome.runtime. No-op in non-extension contexts.
 * @param {keyof typeof MSG} type
 * @param {object} payload
 */
export function send(type, payload) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  chrome.runtime.sendMessage({ type, payload });
}

/**
 * Subscribe to a message type. Returns unsubscribe fn.
 * @param {keyof typeof MSG} type
 * @param {(payload: any, sender: any) => void} handler
 */
export function on(type, handler) {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return () => {};
  const listener = (msg, sender) => {
    if (msg && msg.type === type) handler(msg.payload, sender);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
