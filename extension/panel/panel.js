import { MSG, send, on } from "../../shared/messages.js";
import { isTraceEvent } from "../../shared/types.js";

const traceEl = document.getElementById("trace");
const form = document.getElementById("run-form");
const goalEl = document.getElementById("goal");

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

async function loadStubs() {
  const url = chrome?.runtime?.getURL
    ? chrome.runtime.getURL("shared/trace-stubs.json")
    : "../../shared/trace-stubs.json";
  const res = await fetch(url);
  const events = await res.json();
  events.forEach(renderEvent);
}

on(MSG.TRACE, (payload) => renderEvent(payload));

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const goal = goalEl.value.trim();
  if (!goal) return;
  clearTrace();
  send(MSG.RUN, { goal });
});

loadStubs().catch((err) => {
  const li = document.createElement("li");
  li.className = "error";
  li.textContent = "failed to load trace stubs: " + err.message;
  traceEl.appendChild(li);
});
