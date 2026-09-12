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
import { skillFilename, skillDescription, replayDelay, elide } from "./format.js";

const els = {
  trace: document.getElementById("trace"),
  empty: document.getElementById("empty"),
  status: document.getElementById("status"),
  form: document.getElementById("run-form"),
  goal: document.getElementById("goal"),
  run: document.getElementById("run"),
  result: document.getElementById("result"),
  skillName: document.getElementById("skill-name"),
  skillDesc: document.getElementById("skill-desc"),
  skillBody: document.getElementById("skill-body"),
  download: document.getElementById("download"),
  keyForm: document.getElementById("key-form"),
  apiKey: document.getElementById("api-key"),
  exaKey: document.getElementById("exa-key"),
  keysToggle: document.getElementById("keys-toggle")
};

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

function setRunning(next) {
  running = next;
  els.goal.disabled = next;
  els.run.disabled = next;
  els.run.textContent = next ? "running…" : "run";
}

// ---- result -----------------------------------------------------------

function showSkill(markdown) {
  currentSkill = markdown ?? "";
  els.skillName.textContent = skillFilename(currentSkill);
  els.skillDesc.textContent = skillDescription(currentSkill);
  els.skillBody.textContent = currentSkill;
  els.result.hidden = false;
  scrollToLatest();
}

function hideSkill() {
  currentSkill = null;
  els.result.hidden = true;
  els.skillBody.textContent = "";
}

els.download.addEventListener("click", () => {
  if (!currentSkill) return;

  const blob = new Blob([currentSkill], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = skillFilename(currentSkill);

  // The anchor has to be in the document for click() to start a download in
  // every Chrome build; a detached one silently does nothing on some of them.
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoked late: revoking immediately can cancel a download still starting.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

// ---- incoming ---------------------------------------------------------

// The agent host sends TRACE as { event }, so the envelope is unwrapped here.
on(MSG.TRACE, (payload) => {
  try {
    const ev = payload.event;
    renderEvent(ev);
    if (ev.kind === "done" || ev.kind === "error") setRunning(false);
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
  hideSkill();
  setRunning(true);
  renderEvent(panelEvent("plan", "Goal: " + goal, "Reading the tabs you already have open."));

  try {
    const reply = await request(MSG.RUN, { goal });

    if (!reply?.ok) {
      renderEvent(panelEvent("error", "The worker rejected the run.", reply?.error ?? "no reason given"));
      setRunning(false);
      return;
    }

    // When the loop is live it reports through TRACE, so the panel stays in its
    // running state until a done/error event or the finished SKILL arrives.
    if (reply.started) {
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

/**
 * Replay the scripted run until the agent loop is connected. The status line
 * says so plainly — the trace should never imply work that did not happen.
 */
async function replayScriptedRun() {
  setStatus("scripted run", "pending");

  const events = await fetch(assetUrl("shared/trace-stubs.json")).then((r) => r.json());

  let previous = events[0]?.t ?? 0;
  for (const ev of events) {
    await sleep(replayDelay(previous, ev.t));
    previous = ev.t;
    renderEvent(ev);
  }

  const markdown = await fetch(assetUrl("extension/panel/demo-skill.md")).then((r) => r.text());
  showSkill(markdown);
}

// ---- boot -------------------------------------------------------------

// ---- credentials ------------------------------------------------------

/**
 * A key already saved is never read back into the field — the placeholder says
 * it is there, and leaving the field blank keeps it.
 */
function showKeyForm({ hasKey = false, hasExa = false } = {}) {
  els.apiKey.placeholder = hasKey ? "saved — leave blank to keep" : "sk-or-...";
  els.exaKey.placeholder = hasExa ? "saved — leave blank to keep" : "exa key";
  els.keyForm.hidden = false;
  if (!hasKey) els.apiKey.focus();
}

els.keysToggle.addEventListener("click", async () => {
  if (!els.keyForm.hidden) {
    els.keyForm.hidden = true;
    return;
  }
  const stored = await chrome.storage.local.get(["OPENROUTER_API_KEY", "EXA_API_KEY"]);
  showKeyForm({ hasKey: Boolean(stored.OPENROUTER_API_KEY), hasExa: Boolean(stored.EXA_API_KEY) });
});

els.keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const openrouter = els.apiKey.value.trim();
  const exa = els.exaKey.value.trim();
  if (!openrouter && !exa) {
    els.keyForm.hidden = true;
    return;
  }

  // Stored in this browser's extension storage, never in the repo. A blank field
  // leaves whatever is already saved alone.
  const update = {};
  if (openrouter) update.OPENROUTER_API_KEY = openrouter;
  if (exa) update.EXA_API_KEY = exa;
  await chrome.storage.local.set(update);

  els.apiKey.value = "";
  els.exaKey.value = "";
  els.keyForm.hidden = true;

  const saved = Object.keys(update)
    .map((k) => (k === "EXA_API_KEY" ? "Exa" : "OpenRouter"))
    .join(" and ");
  renderEvent(
    panelEvent(
      "note",
      saved + " key saved.",
      exa ? "Web search is on for gaps your tabs do not cover." : "Run again for a real pass over your tabs."
    )
  );
  setStatus("keys saved", "ok");
});

/** Preload stub tab titles so a scripted run's refs resolve to real titles. */
async function preloadStubTitles() {
  try {
    const tabs = await fetch(assetUrl("shared/stubs.json")).then((r) => r.json());
    for (const tab of tabs) {
      if (typeof tab?.id === "number" && !titles.has(tab.id)) titles.set(tab.id, tab.title ?? null);
    }
  } catch {
    // Only cosmetic: without it, a scripted run shows tab ids instead of titles.
  }
}

/**
 * Ask the worker to identify itself. The reply proves the worker woke, its
 * module graph loaded, and the manifest permissions are actually granted.
 */
async function handshake() {
  setStatus("waking worker…", "pending");
  try {
    const reply = await request(MSG.PING, {});
    if (!reply?.ok) throw new Error(reply?.error ?? "worker replied without ok");
    setStatus(reply.tabCount + " tabs · " + reply.windowCount + " windows", "ok");
    if (!reply.hasKey) showKeyForm({ hasKey: false, hasExa: reply.hasExa });
  } catch (err) {
    setStatus("worker unreachable", "bad");
    renderEvent(panelEvent("error", "Could not reach the service worker.", err.message));
  }
}

setRunning(false);
await preloadStubTitles();
await handshake();
