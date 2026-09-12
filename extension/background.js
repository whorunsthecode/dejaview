/**
 * Service worker. Owns the privileged APIs: tabs, history, scripting, storage.
 *
 * MV3 workers are killed when idle and restarted on the next message, so this
 * file must stay re-runnable from the top on every wake. Nothing here may hold
 * state in module scope that matters across wakes.
 */
import { MSG, on } from "../shared/messages.js";
import { listTabs, countDated, contractViolations, formatFirstVisit } from "./tabs.js";
import { readTab, readTabs, MAX_CHARS } from "./extract.js";
import { highlightTab } from "./highlight.js";
import { loadEnv, startRun, isRunning, renderSkill } from "./agent-bridge.js";

const manifest = chrome.runtime.getManifest();

// Clicking the toolbar icon opens the side panel. This setting persists, so
// registering it once at install is enough.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    ?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch((err) => console.warn("dejavu: setPanelBehavior failed", err));
});

/**
 * Liveness handshake, sent by the panel when it opens. The reply proves three
 * things at once: the worker woke, its module graph loaded, and the permissions
 * in the manifest are actually granted — chrome.tabs.query throws without them.
 */
on(MSG.PING, async () => {
  const [tabs, windows] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll()
  ]);
  const env = await loadEnv();
  return {
    ok: true,
    version: manifest.version,
    permissions: manifest.permissions,
    tabCount: tabs.length,
    windowCount: windows.length,
    // Lets the panel ask for a key on open, rather than after a wasted run.
    hasKey: Boolean(env.OPENROUTER_API_KEY),
    hasExa: Boolean(env.EXA_API_KEY)
  };
});

/**
 * Start a run. Enumerates and dates every open tab, logs the result, and returns
 * the counts. The agent loop that consumes this list is Karmen's; it will report
 * progress as a stream of TRACE messages rather than in this reply.
 */
on(MSG.RUN, async (payload) => {
  const goal = typeof payload?.goal === "string" ? payload.goal.trim() : "";
  if (!goal) return { ok: false, error: "RUN needs a non-empty goal" };

  const tabs = await listTabs();
  const counts = countDated(tabs);
  const violations = contractViolations(tabs);

  console.groupCollapsed(`dejavu: ${counts.total} tabs (${counts.dated} dated, ${counts.undated} undated)`);
  console.table(
    tabs.map((t) => ({
      id: t.id,
      firstVisit: formatFirstVisit(t.firstVisit),
      group: t.groupTitle ?? "—",
      win: t.windowId,
      status: t.textStatus,
      title: t.title.slice(0, 60)
    }))
  );
  // The raw objects, so the contract shape can be inspected directly.
  console.log("dejavu: tabs", tabs);
  if (violations.length) console.error("dejavu: contract violations", violations);
  console.groupEnd();

  const env = await loadEnv();
  if (!env.OPENROUTER_API_KEY) {
    // No key, no run. Say so, rather than quietly handing back something canned.
    return { ok: true, goal, ...counts, violations: violations.length, started: false, needsKey: true };
  }
  if (isRunning()) return { ok: false, error: "a run is already in progress" };

  // Fire and forget: progress reaches the panel as TRACE, the finished file as
  // SKILL. This reply only reports that the loop got under way.
  startRun({ goal, env });
  return { ok: true, goal, ...counts, violations: violations.length, started: true };
});

/**
 * Highlight passages the agent chose, in the tab they came from. Quotes are
 * matched after normalising both sides; one that cannot be found is skipped
 * rather than failing the batch, because a near-miss on one passage should not
 * cost the user the others.
 */
on(MSG.HIGHLIGHT, async (payload) => {
  const tabId = typeof payload?.tabId === "number" ? payload.tabId : null;
  if (tabId === null) return { ok: false, error: "HIGHLIGHT needs a tabId" };
  return highlightTab(tabId, payload?.quotes);
});

// TRACE and SKILL travel outward from the worker, so there is deliberately no
// listener for them here.

/**
 * Debug handle for the service worker console (chrome://extensions -> Inspect).
 *
 *   await dejavu.listTabs()
 *   await dejavu.readTab(<id>)        one tab, on demand
 *   await dejavu.readTabs([a, b, c])  a batch where one failure cannot stop the rest
 *   await dejavu.highlightTab(<id>, ["a verbatim quote"])
 *
 * Extraction is deliberately reachable only from here and from the agent's
 * read_tab tool. Nothing in this worker extracts text on its own.
 */
globalThis.dejavu = { listTabs, readTab, readTabs, highlightTab, loadEnv, renderSkill, MAX_CHARS };
