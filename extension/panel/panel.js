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
import { credentialState, persistCredentials } from "./credentials.js";
import { createNotionPage } from "./notion.js";
import { createGoogleDoc } from "./gdocs.js";
import { SETTING_KEYS as REDISCOVERY_KEYS, normalizeSettings } from "../rediscovery/settings.js";
import { sourceUrls, handOff } from "../slices/handoff.js";
import {
  LOCAL_SETTING_KEYS,
  normalizeLocalSettings,
  probeLocal,
  setupNote
} from "../local-model.js";

const els = {
  trace: document.getElementById("trace"),
  empty: document.getElementById("empty"),
  status: document.getElementById("status"),
  form: document.getElementById("run-form"),
  goal: document.getElementById("goal"),
  run: document.getElementById("run"),
  includeHistory: document.getElementById("include-history"),
  result: document.getElementById("result"),
  skillName: document.getElementById("skill-name"),
  skillDesc: document.getElementById("skill-desc"),
  skillBody: document.getElementById("skill-body"),
  download: document.getElementById("download"),
  obsidian: document.getElementById("obsidian"),
  copy: document.getElementById("copy"),
  slice: document.getElementById("slice"),
  notion: document.getElementById("notion"),
  gdocs: document.getElementById("gdocs"),
  notionToken: document.getElementById("notion-token"),
  notionParent: document.getElementById("notion-parent"),
  googleClient: document.getElementById("google-client"),
  redirectHint: document.getElementById("redirect-hint"),
  keyForm: document.getElementById("key-form"),
  apiKey: document.getElementById("api-key"),
  exaKey: document.getElementById("exa-key"),
  keysToggle: document.getElementById("keys-toggle"),
  habits: document.getElementById("habits"),
  surprise: document.getElementById("surprise"),
  nudge: document.getElementById("nudge"),
  nudgeTitle: document.getElementById("nudge-title"),
  nudgeMeta: document.getElementById("nudge-meta"),
  nudgeOpen: document.getElementById("nudge-open"),
  nudgeLess: document.getElementById("nudge-less"),
  nudgeDismiss: document.getElementById("nudge-dismiss"),
  redEnabled: document.getElementById("red-enabled"),
  redHistory: document.getElementById("red-history"),
  redAge: document.getElementById("red-age"),
  redThreshold: document.getElementById("red-threshold"),
  redStats: document.getElementById("red-stats"),
  redClear: document.getElementById("red-clear"),
  localEnabled: document.getElementById("local-enabled"),
  localUrl: document.getElementById("local-url"),
  localName: document.getElementById("local-name"),
  localNote: document.getElementById("local-note"),
  localTest: document.getElementById("local-test"),
  localResult: document.getElementById("local-result")
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
  // Keep internal limits in the trace contract without presenting them as a
  // user setting or implying that only this many open tabs were considered.
  if (/^Page budget:/.test(ev.label)) return;
  const displayLabel = ev.label
    .replace(/^Previewing \d+ candidates before committing full reads\.$/, 'Checking promising sources.')
    .replace(/^Peeked \d+; selected \d+ full reads\.$/, 'Source selection complete.')
    .replace(/^Locally shortlisted \d+ of \d+ open tabs.*$/, 'Shortlisted promising sources from your open tabs.')
    .replace(/^Preview \d+: /, 'Preview: ');
  els.empty.hidden = true;

  const li = document.createElement("li");
  li.className = ev.kind;

  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = ev.kind;
  li.appendChild(kind);

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = displayLabel;
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
  // The line is one row and truncates; the title keeps the whole of it readable.
  els.status.title = text;
  els.status.className = state ?? "";
}

function setRunning(next) {
  running = next;
  els.goal.disabled = next;
  els.run.disabled = next;
  els.includeHistory.disabled = next;
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
  await withBusy(els.obsidian, sendToObsidian);
});

async function sendToObsidian() {
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
      "Requested Obsidian to open " + target.path + ".",
      "Obsidian desktop must be installed with a vault open. If nothing opens, use Download to save the complete skill."
    )
  );
}

/**
 * Mark a button as working.
 *
 * A class rather than swapped text: these buttons hold an <svg>, so writing
 * textContent would delete the icon and never bring it back.
 */
async function withBusy(button, fn) {
  button.classList.add("busy");
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.classList.remove("busy");
    button.disabled = false;
  }
}

/** Shared shape for the export buttons that call a remote API. */
async function exportTo(button, label, run) {
  if (!currentSkill) return;

  try {
    const result = await withBusy(button, run);
    if (result.ok) {
      renderEvent(panelEvent("done", "Created in " + label + ".", result.url ?? ""));
      setStatus("sent to " + label.toLowerCase(), "ok");
      if (result.url) chrome.tabs.create({ url: result.url, active: false }).catch(() => {});
    } else {
      renderEvent(panelEvent("error", label + " export failed.", result.error ?? "no reason given"));
      setStatus(label.toLowerCase() + " failed", "bad");
    }
  } catch (err) {
    renderEvent(panelEvent("error", label + " export failed.", err?.message ?? String(err)));
  }
}

els.notion?.addEventListener("click", () =>
  exportTo(els.notion, "Notion", async () => {
    const stored = await chrome.storage.local.get(["NOTION_TOKEN", "NOTION_PARENT"]);
    if (!stored.NOTION_TOKEN || !stored.NOTION_PARENT) {
      showKeyForm();
      return { ok: false, error: "Set a Notion token and parent page under keys first." };
    }
    return createNotionPage({
      token: stored.NOTION_TOKEN,
      parentId: stored.NOTION_PARENT,
      title: skillFilename(currentSkill).replace(/\.md$/, ""),
      markdown: currentSkill
    });
  })
);

els.gdocs?.addEventListener("click", () =>
  exportTo(els.gdocs, "Google Docs", async () => {
    const stored = await chrome.storage.local.get(["GOOGLE_CLIENT_ID"]);
    if (!stored.GOOGLE_CLIENT_ID) {
      showKeyForm();
      return { ok: false, error: "Set a Google OAuth client id under keys first." };
    }
    return createGoogleDoc({
      clientId: stored.GOOGLE_CLIENT_ID,
      name: skillFilename(currentSkill).replace(/\.md$/, ""),
      markdown: currentSkill
    });
  })
);

/**
 * Export the pages this run actually cited as a shareable slice.
 *
 * The sources are a result set like any other, so they go through the same
 * review screen: what would be included, what was filtered out and why, and
 * nothing written until it is confirmed.
 */
els.slice?.addEventListener("click", async () => {
  if (!currentSkill) return;

  const urls = sourceUrls(currentSkill);
  if (!urls.length) {
    renderEvent(panelEvent("note", "Nothing to export.", "This skill cites no sources with a URL."));
    return;
  }

  await withBusy(els.slice, async () => {
    const url = await handOff({
      urls,
      label: skillDescription(currentSkill) || skillFilename(currentSkill).replace(/\.md$/, ""),
      terms: []
    });
    if (url) await chrome.tabs.create({ url });
  });
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
    const reply = await request(MSG.RUN, { goal, includeHistory });

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
// ---- rediscovery ------------------------------------------------------

/** The nudge currently on screen, if any. At most one is ever shown. */
let pendingNudge = null;

/**
 * Draw a rediscovery.
 *
 * Deliberately undramatic: no modal, no sound, no focus change. It appears in
 * the flow above the trace and waits. The three things it says are the ones
 * needed to judge it without opening anything — what it is, when you read it,
 * and why it came up now.
 */
function renderNudge(nudge) {
  if (!nudge?.item) return hideNudge();
  pendingNudge = nudge;

  els.nudgeTitle.textContent = nudge.item.title;
  els.nudgeTitle.title = nudge.item.url;

  const when = nudge.firstReadOn
    ? "First read " + nudge.firstReadOn + ", " + nudge.age + "."
    : "First read: unknown.";
  els.nudgeMeta.textContent = when + " " + nudge.why;
  els.nudgeOpen.title = nudge.passage
    ? "Open at: “" + elide(nudge.passage, 80) + "”"
    : "Open " + nudge.item.url;

  els.nudge.hidden = false;
}

function hideNudge() {
  pendingNudge = null;
  els.nudge.hidden = true;
}

/**
 * Record what the user did. The bar goes away first: an answer that waits on a
 * round trip feels like a jam, and the worker's reply changes nothing on screen.
 */
async function answerNudge(action) {
  const nudge = pendingNudge;
  if (!nudge) return;
  hideNudge();

  try {
    const reply = await request(MSG.NUDGE_ACTION, { id: nudge.id, action });
    if (!reply?.ok) {
      renderEvent(panelEvent("error", "Could not record that answer.", reply?.error ?? "no reason given"));
    } else if (action === "less") {
      setStatus("noted — less like that", "ok");
    } else if (action === "dismiss") {
      setStatus("dismissed", "ok");
    }
  } catch (err) {
    renderEvent(panelEvent("error", "Could not reach the worker.", err.message));
  }

  await refreshRediscovery({ quiet: true });
}

els.nudgeOpen?.addEventListener("click", () => answerNudge("open"));
els.nudgeDismiss?.addEventListener("click", () => answerNudge("dismiss"));
els.nudgeLess?.addEventListener("click", () => answerNudge("less"));

// A nudge can arrive while the panel is open; usually it is shut and the badge
// carries it until the panel next asks.
on(MSG.NUDGE, (payload) => {
  renderNudge(payload?.nudge);
});

els.surprise?.addEventListener("click", async () => {
  setStatus("looking for something you forgot…", "pending");
  try {
    const reply = await request(MSG.SURPRISE, {});
    if (reply?.fired) {
      renderNudge(reply.nudge);
      setStatus("resurfaced", "ok");
    } else {
      // Nothing to show is a real answer, not a failure.
      setStatus(reply?.reason ?? "nothing to surface", "");
    }
  } catch (err) {
    setStatus("worker unreachable", "bad");
    renderEvent(panelEvent("error", "Could not ask for a rediscovery.", err.message));
  }
});

/** The feature's own scoreboard, so it can be seen failing rather than argued about. */
function renderRediscoveryStats(stats) {
  if (!els.redStats) return;
  if (!stats?.total) {
    els.redStats.textContent = "Nothing surfaced yet.";
    return;
  }
  const rate = stats.acceptRate === null
    ? "none answered yet"
    : Math.round(stats.acceptRate * 100) + "% opened";
  const parts = [
    stats.total + " surfaced",
    stats.answered + " answered",
    rate
  ];
  if (stats.less) parts.push(stats.less + " marked less like this");
  els.redStats.textContent = parts.join(" · ") + ".";
}

/** Ask the worker for the pending nudge and the log summary. */
async function refreshRediscovery({ quiet = false } = {}) {
  try {
    const state = await request(MSG.NUDGE_STATE, {});
    if (!state?.ok) return null;
    renderRediscoveryStats(state.stats);
    if (state.pending) renderNudge(state.pending);
    return state;
  } catch (err) {
    // The worker being asleep is not worth a line in the trace.
    if (!quiet) renderEvent(panelEvent("error", "Could not read the rediscovery log.", err.message));
    return null;
  }
}

els.redClear?.addEventListener("click", async () => {
  try {
    await request(MSG.NUDGE_ACTION, { action: "clear-log" });
  } catch {
    // Nothing useful to say: the refresh below will show whether it worked.
  }
  hideNudge();
  await refreshRediscovery({ quiet: true });
  setStatus("rediscovery log cleared", "ok");
});

// ---- local model -------------------------------------------------------

/** The setup step differs per server, and it is the one everybody trips on. */
function renderLocalNote() {
  if (!els.localNote) return;
  const origin = chrome.runtime?.id ? "chrome-extension://" + chrome.runtime.id : undefined;
  els.localNote.textContent = setupNote(els.localUrl?.value || "", origin);
}

async function fillLocalSettings() {
  let settings;
  try {
    settings = normalizeLocalSettings(await chrome.storage.local.get(LOCAL_SETTING_KEYS));
  } catch {
    settings = normalizeLocalSettings({});
  }
  if (els.localEnabled) els.localEnabled.checked = settings.LOCAL_MODEL_ENABLED;
  if (els.localUrl) els.localUrl.value = settings.LOCAL_MODEL_URL;
  if (els.localName) els.localName.value = settings.LOCAL_MODEL_NAME;
  renderLocalNote();
  return settings;
}

/** Normalized, so a half-typed URL or a blank model name cannot be stored. */
function collectLocalSettings() {
  return normalizeLocalSettings({
    LOCAL_MODEL_ENABLED: Boolean(els.localEnabled?.checked),
    LOCAL_MODEL_URL: els.localUrl?.value,
    LOCAL_MODEL_NAME: els.localName?.value
  });
}

els.localUrl?.addEventListener("input", renderLocalNote);

/**
 * Prove the server is there before a run depends on it. Without this the whole
 * failure mode is a long wait followed by an unexplained error.
 */
els.localTest?.addEventListener("click", async () => {
  els.localTest.disabled = true;
  els.localResult.textContent = "checking…";

  const settings = normalizeLocalSettings({
    LOCAL_MODEL_URL: els.localUrl?.value,
    LOCAL_MODEL_NAME: els.localName?.value
  });
  const result = await probeLocal({ settings });
  els.localTest.disabled = false;

  if (!result.ok) {
    els.localResult.textContent = result.error;
    return;
  }
  if (result.has === false) {
    els.localResult.textContent =
      "Reached " + result.base + ", but it has no “" + settings.LOCAL_MODEL_NAME +
      "”. It does have: " + result.models.slice(0, 6).join(", ") + ".";
    return;
  }
  els.localResult.textContent =
    "Reached " + result.base + (result.models.length ? " · " + result.models.length + " model(s) available." : ".");
});

/** The four rediscovery settings, and the control each is edited with. */
const REDISCOVERY_FIELDS = [
  { key: "REDISCOVERY_ENABLED", field: "redEnabled", kind: "bool" },
  { key: "REDISCOVERY_HISTORY", field: "redHistory", kind: "bool" },
  { key: "REDISCOVERY_MIN_AGE_DAYS", field: "redAge", kind: "number" },
  { key: "REDISCOVERY_THRESHOLD", field: "redThreshold", kind: "number" }
];

async function fillRediscoverySettings() {
  let settings;
  try {
    settings = normalizeSettings(await chrome.storage.local.get(REDISCOVERY_KEYS));
  } catch {
    settings = normalizeSettings({});
  }
  for (const { key, field, kind } of REDISCOVERY_FIELDS) {
    const input = els[field];
    if (!input) continue;
    if (kind === "bool") input.checked = settings[key] === true;
    else input.value = String(settings[key]);
  }
  return settings;
}

/** Written through normalizeSettings, so a typed-in 0 or 9999 cannot be stored. */
function collectRediscoverySettings() {
  const raw = {};
  for (const { key, field, kind } of REDISCOVERY_FIELDS) {
    const input = els[field];
    if (!input) continue;
    raw[key] = kind === "bool" ? input.checked : input.value;
  }
  const settings = normalizeSettings(raw);
  return settings;
}

// ---- credentials ------------------------------------------------------

/** Every credential the panel stores, and the field it comes from. */
const CREDENTIALS = [
  { key: "OPENROUTER_API_KEY", field: "apiKey", label: "OpenRouter", secret: true },
  { key: "EXA_API_KEY", field: "exaKey", label: "Exa", secret: true },
  { key: "NOTION_TOKEN", field: "notionToken", label: "Notion", secret: true },
  { key: "NOTION_PARENT", field: "notionParent", label: "Notion parent", secret: false },
  { key: "GOOGLE_CLIENT_ID", field: "googleClient", label: "Google client id", secret: false }
];

/**
 * A stored secret is never read back into its field — the placeholder says it is
 * there, and leaving the field blank keeps it. A non-secret (a page URL, a client
 * id) is shown, since seeing it is how you check it is right.
 */
async function showKeyForm() {
  els.keyForm.hidden = false;

  try {
    const stored = await chrome.storage.local.get(CREDENTIALS.map((c) => c.key));
    for (const { key, field, secret } of CREDENTIALS) {
      const input = els[field];
      if (!input) continue;
      const state = credentialState(stored[key], secret, key);
      const badge = document.getElementById(input.id + '-status');
      if (badge) badge.textContent = state;
      if (secret) {
        input.placeholder = state === 'Saved locally' ? 'Saved — leave blank to keep' : state === 'Needs attention' ? 'Paste the original key again' : 'Paste key, then Save changes';
      } else if (stored[key]) {
        input.value = stored[key];
      }
    }
  } catch {
    // Worth continuing without: the fields still accept new values.
  }

  await fillRediscoverySettings();
  await fillLocalSettings();
  await refreshRediscovery({ quiet: true });

  // The redirect Google has to be told about, shown rather than documented,
  // because it contains this install's own extension id.
  if (els.redirectHint && chrome.identity?.getRedirectURL) {
    els.redirectHint.textContent = "Authorised redirect URI: " + chrome.identity.getRedirectURL();
  }

  if (!els.apiKey.value) els.apiKey.focus();
}

els.keysToggle?.addEventListener("click", () => {
  if (els.keyForm.hidden) showKeyForm();
  else els.keyForm.hidden = true;
});

els.keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = document.getElementById('save-key');
  const feedback = document.getElementById('key-feedback');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Saving…';
  const entries = CREDENTIALS.map(entry => ({ ...entry, value: els[entry.field]?.value ?? '' }));
  try {
    // Both settings groups ride the same write: someone who came here only to
    // turn a toggle off must not have to type a key to make it stick.
    const update = await persistCredentials(chrome.storage.local, entries, {
      ...collectRediscoverySettings(),
      ...collectLocalSettings()
    });
    const saved = entries.filter(entry => Object.hasOwn(update, entry.key));
    for (const { key, field, secret, value } of saved) {
      const input = els[field];
      if (secret && input.value === value) input.value = '';
      if (secret) input.placeholder = 'Saved — leave blank to keep';
      const badge = document.getElementById(input.id + '-status');
      if (badge) badge.textContent = credentialState(update[key], secret, key);
    }
    const message = saved.length ? saved.map(entry => entry.label).join(', ') + ' saved locally.' : 'Settings saved. Existing keys kept.';
    if (feedback) feedback.textContent = message;
    renderEvent(panelEvent('note', message, 'Saved key fields stay blank to protect your credentials.'));
    setStatus('saved', 'ok');
  } catch (error) {
    if (feedback) feedback.textContent = error.message;
    setStatus('save needs attention', 'bad');
  } finally {
    button.disabled = false;
    button.textContent = 'Save changes';
  }
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
    // Kept short, but where the model runs stays in it: that is the difference
    // between this reading leaving the machine and not.
    const where = reply.provider === "local" ? " · local model" : reply.provider === "cloud" ? " · openrouter" : "";
    setStatus(`${reply.tabCount} tabs · ${reply.windowCount} windows${where}`, "ok");
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
// A nudge that fired while the panel was shut is waiting on the badge, not here.
await refreshRediscovery({ quiet: true });
