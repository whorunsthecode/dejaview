/**
 * The side panel.
 *
 * One renderer serves both paths. Live events arrive over the bus as TRACE and
 * are drawn as they land; when no key is set there is nothing to run, and the
 * scripted trace in shared/trace-stubs.json can be replayed through the same
 * renderer at the pacing its own timestamps imply. Nothing about the drawing
 * code knows which of the two it is showing.
 */
import { MSG, on, request } from "../../shared/messages.js";
import { isTraceEvent } from "../../shared/types.js";
import { skillFilename, skillDescription, replayDelay, elide } from "./format.js";
import { obsidianTarget } from "./export.js";

const els = {
  trace: document.getElementById("trace"),
  empty: document.getElementById("empty"),
  status: document.getElementById("status"),
  form: document.getElementById("run-form"),
  goal: document.getElementById("goal"),
  run: document.getElementById("run"),
  includeHistory: document.getElementById("include-history"),
  readLimit: document.getElementById("read-limit"),
  result: document.getElementById("result"),
  skillName: document.getElementById("skill-name"),
  skillDesc: document.getElementById("skill-desc"),
  skillBody: document.getElementById("skill-body"),
  download: document.getElementById("download"),
  obsidian: document.getElementById("obsidian"),
  copy: document.getElementById("copy"),
  keyForm: document.getElementById("key-form"),
  apiKey: document.getElementById("api-key"),
  exaKey: document.getElementById("exa-key"),
  keysToggle: document.getElementById("keys-toggle"),
  habits: document.getElementById("habits")
};

/** Resolved tab titles, keyed by tab id, so a `ref` can name its source. */
const titles = new Map();

let running = false;
let currentSkill = null;

/** Read once at boot so the Obsidian click handler never awaits before copying. */
let obsidianSettings = { vault: undefined, folder: undefined };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const assetUrl = (path) =>
  chrome?.runtime?.getURL ? chrome.runtime.getURL(path) : "../../" + path;

// ---- trace ------------------------------------------------------------

/** A valid TraceEvent describing something the panel itself did. */
function panelEvent(kind, label, detail = "") {
  return { t: Date.now(), kind, label, detail, ref: null };
}

/**
 * Name the tab a trace event points at. Live tabs answer immediately; a scripted
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
  els.includeHistory.disabled = next;
  els.readLimit.disabled = next;
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

/**
 * Copy, with a fallback.
 *
 * navigator.clipboard.writeText needs the document focused, and a side panel can
 * lose focus at exactly the wrong moment. The execCommand path is deprecated but
 * has neither requirement, and works in an extension page that declares
 * clipboardWrite. Returns the reason on failure rather than swallowing it.
 *
 * @returns {Promise<{ok: boolean, via?: string, error?: string}>}
 */
async function copyText(text) {
  let first = "";
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true, via: "clipboard api" };
  } catch (err) {
    first = err?.message ?? String(err);
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (copied) return { ok: true, via: "execCommand" };
    return { ok: false, error: first + " / execCommand returned false" };
  } catch (err) {
    return { ok: false, error: first + " / " + (err?.message ?? String(err)) };
  }
}

els.copy?.addEventListener("click", async () => {
  if (!currentSkill) return;
  const result = await copyText(currentSkill);
  if (result.ok) {
    setStatus("copied to clipboard", "ok");
  } else {
    setStatus("could not copy", "bad");
    renderEvent(panelEvent("error", "Copy failed.", result.error));
  }
});

/**
 * Send the skill to Obsidian over its own URI scheme — no server, no account.
 * A long note goes via the clipboard instead, because a protocol URL is
 * truncated silently and a half-written note is worse than an explicit paste.
 */
els.obsidian?.addEventListener("click", async () => {
  if (!currentSkill) return;

  const target = obsidianTarget({
    vault: obsidianSettings.vault,
    folder: obsidianSettings.folder,
    filename: skillFilename(currentSkill),
    markdown: currentSkill
  });

  // Only when the note is too large to write through the URL at all.
  if (target.mode === "manual") {
    const copied = await copyText(currentSkill);
    renderEvent(
      copied.ok
        ? panelEvent(
            "note",
            "Skill copied — paste it into Obsidian.",
            "Too large to write through obsidian:// (" + target.chunks + " calls needed)."
          )
        : panelEvent("error", "Too large for Obsidian, and the copy failed.", copied.error + " — use download.")
    );
    return;
  }

  // Written straight into the note: the first call creates it, any others append
  // in order. Sequential, because two protocol launches at once can arrive out of
  // order and scramble the note.
  try {
    for (let i = 0; i < target.urls.length; i++) {
      openProtocol(target.urls[i]);
      if (i < target.urls.length - 1) await sleep(350);
    }
  } catch (err) {
    renderEvent(panelEvent("error", "Obsidian did not open.", err.message));
    return;
  }

  renderEvent(
    panelEvent(
      "note",
      "Wrote " + target.path + " to Obsidian.",
      target.chunks === 1 ? "One call." : target.chunks + " calls, appended in order."
    )
  );
});

/**
 * Hand a URL to the OS protocol handler.
 *
 * An anchor click rather than chrome.tabs.create: creating a tab for a non-http
 * scheme leaves a blank tab behind for every call, and this has to fire several
 * times in a row.
 */
function openProtocol(url) {
  const link = document.createElement("a");
  link.href = url;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

els.habits?.addEventListener("click", () => {
  chrome.tabs.create({ url: assetUrl("extension/viz/viz.html") });
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

  const includeHistory = Boolean(els.includeHistory?.checked);

  clearTrace();
  hideSkill();
  setRunning(true);
  renderEvent(panelEvent("plan", "Goal: " + goal, els.includeHistory.checked ? "Reading open tabs, with recent history available if useful." : "Reading the tabs you already have open."));

  try {
    const reply = await request(MSG.RUN, { goal, includeHistory: els.includeHistory.checked, maxReads: Number(els.readLimit.value) });

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
      // result and download as a file with nothing to do with what was asked.
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
// ---- credentials ------------------------------------------------------

function showKeyForm() {
  els.keyForm.hidden = false;
  els.apiKey.focus();
}

els.keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = els.apiKey.value.trim();
  if (!key) return;

  // Stored in this browser's extension storage, never in the repo.
  await chrome.storage.local.set({ OPENROUTER_API_KEY: key });
  els.apiKey.value = "";
  els.keyForm.hidden = true;
  renderEvent(panelEvent("note", "Key saved. Run again for a real pass over your tabs."));
  setStatus("key saved", "ok");
});

/** Vault and folder for the Obsidian export, if the user set them. */
async function loadObsidianSettings() {
  try {
    const stored = await chrome.storage.local.get(["OBSIDIAN_VAULT", "OBSIDIAN_FOLDER"]);
    obsidianSettings = { vault: stored.OBSIDIAN_VAULT, folder: stored.OBSIDIAN_FOLDER };
  } catch {
    // No vault set is fine: Obsidian falls back to the last one opened.
  }
}

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
    setStatus(`worker v${reply.version} · ${reply.tabCount} tabs · ${reply.windowCount} windows · ${reply.permissions?.length ?? 0} permissions`, "ok");
    if (!reply.hasKey) showKeyForm();
  } catch (err) {
    setStatus("worker unreachable", "bad");
    renderEvent(panelEvent("error", "Could not reach the service worker.", err.message));
  }
}

setRunning(false);
await loadObsidianSettings();
await preloadStubTitles();
await handshake();
