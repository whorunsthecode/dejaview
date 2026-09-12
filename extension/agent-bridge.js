/**
 * The bridge between Karmen's agent loop and the browser half.
 *
 * BROWSER-INTEGRATION.md lists five things the browser side owes the agent.
 * This file supplies three of them:
 *
 *   - a TabSource backed by real tabs (list + read on demand)
 *   - the renderSkill serializer, which turns write_skill output into Markdown
 *   - a credential source, since a service worker cannot read Node's .env
 *
 * It deliberately does NOT let attachMessageHost subscribe to RUN. The panel
 * calls RUN with request() and needs a reply, and only one listener may answer,
 * so background.js owns that handler and drives run() directly from it.
 */
import { MSG, send as sharedSend } from "../shared/messages.js";
import { attachMessageHost } from "../agent/message-host.js";
import { browserHistorySource } from './history.js';
import { readLimit } from '../shared/limits.js';
import { highlightTab } from "./highlight.js";
import { TabIndex } from './tab-index.js';
import { TextCache } from './text-cache.js';
import { peekTab } from './peek.js';

let browserServices;
export function getBrowserServices() {
  return browserServices ??= { index: new TabIndex(), cache: new TextCache() };
}
export const indexedListTabs = () => getBrowserServices().index.list();
export async function clearLocalCorpus() {
  const { index, cache } = getBrowserServices();
  await cache.clear(); await index.clear();
}

/** Settings the worker reads out of chrome.storage.local. */
export const SETTING_KEYS = ["OPENROUTER_API_KEY", "EXA_API_KEY", "OPENROUTER_MODEL", "AGENT_MODE"];

/**
 * Runtime credentials. A browser worker has no .env, so the key is whatever the
 * user saved in the panel; it lives in chrome.storage.local and never in the repo.
 * @returns {Promise<Record<string, string>>}
 */
export async function loadEnv() {
  const stored = await chrome.storage.local.get(SETTING_KEYS);
  const env = {};
  for (const key of SETTING_KEYS) {
    if (typeof stored[key] === "string" && stored[key].trim()) env[key] = stored[key].trim();
  }
  // The agent gates web search on this flag, not on the key alone.
  if (env.EXA_API_KEY) env.ENABLE_EXA = "1";
  return env;
}

/**
 * A TabSource over the real browser. `list` is cheap metadata plus history
 * dating; `read` injects Readability, and only when the agent asks for that tab.
 * @returns {{list: () => Promise<any[]>, read: (id: number) => Promise<any>}}
 */
export function browserTabSource() {
  const { index, cache } = getBrowserServices();
  return {
    list: () => index.list(),
    diagnostics: () => [index.warning && `Local tab index persistence: ${index.warning}`, cache.warning && `Local text cache persistence: ${cache.warning}`].filter(Boolean),
    candidates: (goal, mode) => index.candidates(goal, mode),
    peek: id => peekTab(id),
    read: async (id) => {
      const result = await cache.get(id);
      return { id: result.id, text: result.text, textStatus: result.textStatus, url: result.url, cached: result.cached === true };
    }
  };
}

// ---- the skill serializer ---------------------------------------------

/** Wrap a YAML scalar so continuation lines stay indented and parseable. */
function wrapYaml(value, indent = "  ", width = 78) {
  const words = String(value ?? "").replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? line + " " + word : word;
    if (candidate.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines[0] + lines.slice(1).map((l) => "\n" + indent + l).join("") : "";
}

/** kebab-case, and safe as a filename on every platform. */
function safeName(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || "skill";
}

/** ms epoch to a plain day, or the honest admission that there is no date. */
function sourceDate(firstVisit) {
  if (typeof firstVisit !== "number" || !Number.isFinite(firstVisit)) return null;
  const d = new Date(firstVisit);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Serialize a validated write_skill payload into the SKILL.md the agent's
 * convert-skill prompt describes: frontmatter, the procedure, then every source
 * with its source provenance and earliest retained visit date.
 *
 * @param {{name: string, description: string, body: string, sources: {url: string, firstVisit: number|null, source?: string}[]}} skill
 * @returns {string}
 */
export function renderSkill(skill) {
  if (!skill || typeof skill !== "object") throw new Error("renderSkill: no skill payload");

  const name = safeName(skill.name);
  const description = wrapYaml(skill.description) || "No description supplied.";
  const body = String(skill.body ?? "").trim();
  const sources = Array.isArray(skill.sources) ? skill.sources : [];

  const lines = ["---", "name: " + name, "description: " + description, "---", "", body, ""];

  lines.push("## Sources", "");
  if (!sources.length) {
    lines.push("- None. This skill was written without a cited source.");
  } else {
    for (const source of sources) {
      const date = sourceDate(source?.firstVisit);
      const provenance =
        source?.source === "web"
          ? "found by search, no open tab"
          : source?.source === "history"
            ? "from browsing history; " + (date ? "earliest recorded visit " + date : "visit date unknown")
          : date
            ? "open tab; earliest recorded visit " + date
            : "tab date unknown";
      lines.push("- " + (source?.url ?? "(no url)") + " — " + provenance);
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ---- the host ---------------------------------------------------------

let host = null;
let hostKey = null;
let running = false;

export function isRunning() {
  return running;
}

/**
 * TRACE and SKILL go to the panel over the bus. HIGHLIGHT cannot: a context does
 * not receive its own runtime messages, so a HIGHLIGHT the worker sent would
 * never reach the worker's own handler. It is applied directly instead.
 */
function sendFromAgent(type, payload) {
  if (type === MSG.HIGHLIGHT) {
    const tabId = payload?.tabId;
    if (typeof tabId === "number") {
      highlightTab(tabId, payload?.quotes).catch(() => {});
    }
    return;
  }
  sharedSend(type, payload);
}

function hostFor(env, includeHistory = false, maxReads = readLimit()) {
  const key = JSON.stringify({ env, includeHistory, maxReads });
  if (host && hostKey === key) return host;

  host?.dispose?.();
  hostKey = key;
  host = attachMessageHost({
    tabSource: browserTabSource(),
    progressive: true,
    readConcurrency: 4,
    includeHistory,
    maxReads,
    historySource: includeHistory ? browserHistorySource() : null,
    env,
    renderSkill,
    send: sendFromAgent,
    // background.js owns the RUN listener, so the host must not add a second one.
    on: () => () => {},
    mode: env.AGENT_MODE === "loose" ? "loose" : "tight"
  });
  return host;
}

/**
 * Start a run. Returns as soon as it is under way — progress reaches the panel
 * as TRACE events and the finished file as SKILL, never through this promise.
 *
 * @param {{goal: string, env: Record<string, string>, includeHistory?: boolean, maxReads?: number}} opts
 */
export function startRun({ goal, env, includeHistory = false, maxReads }) {
  const agent = hostFor(env, includeHistory, readLimit(maxReads));
  running = true;
  return agent
    .run({ goal })
    .catch((err) => {
      sharedSend(MSG.TRACE, {
        event: {
          t: Date.now(),
          kind: "error",
          label: "The run failed.",
          detail: err?.message ?? String(err),
          ref: null
        }
      });
    })
    .finally(() => {
      running = false;
    });
}
