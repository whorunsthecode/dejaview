import { MSG, on, request } from "../../shared/messages.js";
import { isTraceEvent } from "../../shared/types.js";

const traceEl = document.getElementById("trace");
const statusEl = document.getElementById("status");
const form = document.getElementById("run-form");
const goalEl = document.getElementById("goal");

/** Build a valid TraceEvent for something that happened in the panel itself. */
function panelEvent(kind, label, detail = "") {
  return { t: Date.now(), kind, label, detail, ref: null };
}

function renderEvent(ev) {
  isTraceEvent(ev);
  const li = document.createElement("li");
  li.className = ev.kind;
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = ev.kind;
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = ev.label;
  li.appendChild(kind);
  li.appendChild(label);
  if (ev.detail) {
    const d = document.createElement("span");
    d.className = "detail";
    d.textContent = ev.detail;
    li.appendChild(d);
  }
  traceEl.appendChild(li);
}

function clearTrace() {
  while (traceEl.firstChild) traceEl.removeChild(traceEl.firstChild);
}

function setStatus(text, state) {
  statusEl.textContent = text;
  statusEl.className = state ?? "";
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
    setStatus(`worker unreachable — ${err.message}`, "bad");
    renderEvent(panelEvent("error", "Could not reach the service worker.", err.message));
  }
}

/** Trace events stream in from the worker one at a time while a run is going. */
on(MSG.TRACE, (payload) => renderEvent(payload));

on(MSG.SKILL, (payload) => {
  renderEvent(panelEvent("done", `Wrote ${payload?.name ?? "SKILL.md"}.`, payload?.description ?? ""));
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const goal = goalEl.value.trim();
  if (!goal) return;

  clearTrace();
  renderEvent(panelEvent("plan", `Goal: ${goal}`, "Sent to the service worker."));

  try {
    const reply = await request(MSG.RUN, { goal });
    if (reply?.ok) {
      renderEvent(
        panelEvent(
          "result",
          `${reply.total} tabs enumerated.`,
          `${reply.dated} dated from history, ${reply.undated} undated. ${reply.note ?? ""}`.trim()
        )
      );
      if (reply.violations) {
        renderEvent(
          panelEvent("error", `${reply.violations} tabs broke the Tab contract.`, "See the worker console.")
        );
      }
    } else {
      renderEvent(panelEvent("error", "Worker rejected the run.", reply?.error ?? "no reason given"));
    }
  } catch (err) {
    renderEvent(panelEvent("error", "RUN failed.", err.message));
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
loadStubs().catch((err) => {
  renderEvent(panelEvent("error", "Failed to load trace stubs.", err.message));
});
