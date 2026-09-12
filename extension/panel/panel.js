/**
 * The side panel.
 *
 * One renderer serves both paths. Live events arrive over the bus as TRACE and
 * are drawn as they land; when the agent loop is not wired yet, the scripted
 * run in shared/trace-stubs.json is replayed through the same renderer at the
 * pacing its own timestamps imply, so the demo reads like a run rather than a
 * dump. Nothing about the drawing code knows which of the two it is showing.
 */
import { MSG, on, request } from "../../shared/messages.js";
import { isTraceEvent } from "../../shared/types.js";

const traceEl = document.getElementById("trace");
const statusEl = document.getElementById("status");
const form = document.getElementById("run-form");
const goalEl = document.getElementById("goal");

/** Resolved tab titles, keyed by tab id, so a `ref` can name its source. */
const titles = new Map();

let running = false;
let currentSkill = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const assetUrl = (path) =>
  chrome?.runtime?.getURL ? chrome.runtime.getURL(path) : "../../" + path;

// ---- trace ------------------------------------------------------------

/** A valid TraceEvent describing something the panel itself did. */
function panelEvent(kind, label, detail = "") {
  return { t: Date.now(), kind, label, detail, ref: null };
}

/**
 * Name the tab a trace event points at. Live tabs answer immediately; a stubbed
 * run refers to ids that no longer exist, which is why the stub titles are
 * preloaded. Anything still unknown keeps its id rather than showing nothing.
 */
async function titleFor(ref) {
  if (titles.has(ref)) return titles.get(ref);

  let title = null;
  try {
    const tab = await chrome.tabs.get(ref);
    title = tab?.title || tab?.url || null;
  } catch {
    title = null;
  }

  titles.set(ref, title);
  return title;
}

function renderEvent(ev) {
  isTraceEvent(ev);
  els.empty.hidden = true;

  const li = document.createElement("li");
  li.className = ev.kind;

  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = ev.kind;
  li.appendChild(kind);

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = ev.label;
  li.appendChild(label);

  if (ev.detail) {
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = ev.detail;
    li.appendChild(detail);
  }

  if (ev.ref !== null) {
    const chip = document.createElement("span");
    chip.className = "ref";
    chip.textContent = "tab " + ev.ref;
    li.appendChild(chip);

    // Resolved after the row is placed, so ordering never waits on a lookup.
    titleFor(ev.ref).then((title) => {
      if (title) chip.textContent = elide(title);
    });
  }

  els.trace.appendChild(li);
  scrollToLatest();
}

/** Newest at the bottom, and kept in view unless the user has scrolled up. */
function scrollToLatest() {
  const main = els.trace.parentElement;
  const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 120;
  if (nearBottom) main.scrollTop = main.scrollHeight;
}

function clearTrace() {
  while (els.trace.firstChild) els.trace.removeChild(els.trace.firstChild);
  els.empty.hidden = false;
}

// ---- state ------------------------------------------------------------

function setStatus(text, state) {
  els.status.textContent = text;
  els.status.className = state ?? "";
}

/**
 * Ask the worker to identify itself. This is the round trip that proves the
 * skeleton works: panel opens, message goes out, reply comes back.
 */
async function handshake() {
  setStatus("waking worker…", "pending");
  try {
    const reply = await request(MSG.PING, {});
    if (!reply?.ok) throw new Error(reply?.error ?? "worker replied without ok");
    setStatus(
      `worker v${reply.version} · ${reply.tabCount} tabs · ${reply.windowCount} windows · ${reply.permissions.length} permissions`,
      "ok"
    );
  } catch (err) {
    renderEvent(panelEvent("error", "Malformed TRACE event.", err.message));
  }
});

on(MSG.SKILL, (payload) => {
  showSkill(payload?.markdown ?? "");
  setRunning(false);
});

// ---- the run ----------------------------------------------------------

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (running) return;

  const goal = els.goal.value.trim();
  if (!goal) return;

  clearTrace();
  renderEvent(panelEvent("plan", `Goal: ${goal}`, "Sent to the service worker."));

  try {
    const reply = await request(MSG.RUN, { goal });
    if (reply?.ok) {
      renderEvent(
        panelEvent(
          "result",
          reply.total + " tabs enumerated.",
          reply.dated + " dated from history, " + reply.undated + " undated."
        )
      );
      return;
    }

    if (reply.needsKey) {
      // Never answer a real goal with the scripted run: it would look like a
      // result and download as a file that has nothing to do with what was asked.
      showKeyForm();
      renderEvent(
        panelEvent(
          "error",
          "No OpenRouter key set, so no agent ran.",
          "Add a key above. Until then the only thing available is the scripted demo run."
        )
      );
      setRunning(false);
      return;
    }

    // The scripted run narrates its own enumeration, so adding one here would
    // say it twice and break the read. replayScriptedRun owns the status line
    // from this point, and labels itself as scripted.
    await replayScriptedRun();
    setRunning(false);
  } catch (err) {
    renderEvent(panelEvent("error", "The run could not start.", err.message));
    setRunning(false);
  }
});

/** The scripted trace from shared/, so the panel has something to show on open. */
async function loadStubs() {
  const url = chrome?.runtime?.getURL
    ? chrome.runtime.getURL("shared/trace-stubs.json")
    : "../../shared/trace-stubs.json";
  const res = await fetch(url);
  const events = await res.json();
  events.forEach(renderEvent);
}

await handshake();
