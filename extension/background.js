/**
 * Service worker. Owns the privileged APIs: tabs, history, scripting, storage.
 *
 * MV3 workers are killed when idle and restarted on the next message, so this
 * file must stay re-runnable from the top on every wake. Nothing here may hold
 * state in module scope that matters across wakes.
 */
import { MSG, on } from "../shared/messages.js";
import { listTabs, countDated, contractViolations, formatFirstVisit } from "./tabs.js";

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
  return {
    ok: true,
    version: manifest.version,
    permissions: manifest.permissions,
    tabCount: tabs.length,
    windowCount: windows.length
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

  return {
    ok: true,
    goal,
    ...counts,
    violations: violations.length,
    started: false,
    note: "tabs enumerated and dated; agent loop not wired yet"
  };
});

// TRACE, HIGHLIGHT and SKILL travel outward from the worker, so there is
// deliberately no listener for them here.
