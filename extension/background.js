/**
 * Service worker. Owns the privileged APIs: tabs, history, scripting, storage.
 *
 * MV3 workers are killed when idle and restarted on the next message, so this
 * file must stay re-runnable from the top on every wake. Nothing here may hold
 * state in module scope that matters across wakes.
 */
import { MSG, on } from "../shared/messages.js";

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
 * Start a run. This only acknowledges for now. The agent loop that replaces it
 * is Karmen's, and it will report progress as a stream of TRACE messages rather
 * than in this reply, so the panel must not wait on this for results.
 */
on(MSG.RUN, async (payload) => {
  const goal = typeof payload?.goal === "string" ? payload.goal.trim() : "";
  if (!goal) return { ok: false, error: "RUN needs a non-empty goal" };

  const tabs = await chrome.tabs.query({});
  return {
    ok: true,
    goal,
    tabCount: tabs.length,
    started: false,
    note: "worker reached; agent loop not wired yet"
  };
});

// TRACE, HIGHLIGHT and SKILL travel outward from the worker, so there is
// deliberately no listener for them here.
