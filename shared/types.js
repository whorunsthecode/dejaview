/**
 * @typedef {Object} Tab
 * @property {number} id
 * @property {string} url
 * @property {string} title
 * @property {number} windowId
 * @property {string|null} groupTitle
 * @property {number|null} firstVisit   ms epoch, from history.getVisits; null if unavailable
 * @property {number} lastAccessed
 * @property {string|null} text         null until read_tab
 * @property {"ok"|"empty"|"blocked"|"error"} textStatus
 */

/**
 * @typedef {Object} TraceEvent
 * @property {number} t
 * @property {"plan"|"tool"|"result"|"note"|"done"|"error"} kind
 * @property {string} label
 * @property {string} detail
 * @property {number|null} ref
 */

const TAB_TEXT_STATUS = new Set(["ok", "empty", "blocked", "error"]);
const TRACE_KIND = new Set(["plan", "tool", "result", "note", "done", "error"]);

/**
 * Throws if `v` is not a valid Tab.
 * @param {unknown} v
 * @returns {v is Tab}
 */
export function isTab(v) {
  if (!v || typeof v !== "object") throw new Error("isTab: not an object");
  const t = /** @type {any} */ (v);
  const req = ["id", "url", "title", "windowId", "groupTitle", "firstVisit", "lastAccessed", "text", "textStatus"];
  for (const k of req) {
    if (!(k in t)) throw new Error(`isTab: missing field '${k}'`);
  }
  if (typeof t.id !== "number") throw new Error("isTab: id must be number");
  if (typeof t.url !== "string") throw new Error("isTab: url must be string");
  if (typeof t.title !== "string") throw new Error("isTab: title must be string");
  if (typeof t.windowId !== "number") throw new Error("isTab: windowId must be number");
  if (t.groupTitle !== null && typeof t.groupTitle !== "string") throw new Error("isTab: groupTitle must be string|null");
  if (t.firstVisit !== null && typeof t.firstVisit !== "number") throw new Error("isTab: firstVisit must be number|null");
  if (typeof t.lastAccessed !== "number") throw new Error("isTab: lastAccessed must be number");
  if (t.text !== null && typeof t.text !== "string") throw new Error("isTab: text must be string|null");
  if (!TAB_TEXT_STATUS.has(t.textStatus)) throw new Error(`isTab: bad textStatus '${t.textStatus}'`);
  return true;
}

/**
 * Throws if `v` is not a valid TraceEvent.
 * @param {unknown} v
 * @returns {v is TraceEvent}
 */
export function isTraceEvent(v) {
  if (!v || typeof v !== "object") throw new Error("isTraceEvent: not an object");
  const e = /** @type {any} */ (v);
  const req = ["t", "kind", "label", "detail", "ref"];
  for (const k of req) {
    if (!(k in e)) throw new Error(`isTraceEvent: missing field '${k}'`);
  }
  if (typeof e.t !== "number") throw new Error("isTraceEvent: t must be number");
  if (!TRACE_KIND.has(e.kind)) throw new Error(`isTraceEvent: bad kind '${e.kind}'`);
  if (typeof e.label !== "string") throw new Error("isTraceEvent: label must be string");
  if (typeof e.detail !== "string") throw new Error("isTraceEvent: detail must be string");
  if (e.ref !== null && typeof e.ref !== "number") throw new Error("isTraceEvent: ref must be number|null");
  return true;
}
