import { isTab, isTraceEvent } from "../shared/types.js";

/**
 * Run one agent loop. Currently: reads stubs, emits a hardcoded fake trace.
 * Replace the fake sequence with a real model loop once tools.js is wired up.
 *
 * @param {object} opts
 * @param {string} opts.goal
 * @param {Array} opts.tabs                                stub tabs
 * @param {(ev: import("../shared/types.js").TraceEvent) => void} opts.emit
 */
export async function runFakeLoop({ goal, tabs, emit }) {
  tabs.forEach((t) => isTab(t));

  const now = Date.now();
  const step = (i) => now + i * 500;

  const events = [
    { t: step(0),  kind: "plan",   label: `Goal: ${goal}`,                                         detail: `${tabs.length} tabs open.`,       ref: null },
    { t: step(1),  kind: "tool",   label: "list_tabs()",                                            detail: "",                                 ref: null },
    { t: step(2),  kind: "result", label: `${tabs.length} tabs enumerated.`,                       detail: "",                                 ref: null },
    { t: step(3),  kind: "plan",   label: "Opening the two that look most on-topic.",              detail: "",                                 ref: null },
    { t: step(4),  kind: "tool",   label: `read_tab: ${tabs[0].title}`,                            detail: "",                                 ref: tabs[0].id },
    { t: step(5),  kind: "result", label: "Useful.",                                               detail: "",                                 ref: tabs[0].id },
    { t: step(6),  kind: "tool",   label: `read_tab: ${tabs[1].title}`,                            detail: "",                                 ref: tabs[1].id },
    { t: step(7),  kind: "result", label: "Useful.",                                               detail: "",                                 ref: tabs[1].id },
    { t: step(8),  kind: "note",   label: "Simulated run. No model call yet.",                     detail: "Replace runFakeLoop with the real loop once tools.js is wired.", ref: null },
    { t: step(9),  kind: "done",   label: "Fake run complete.",                                    detail: "",                                 ref: null }
  ];

  for (const ev of events) {
    isTraceEvent(ev);
    emit(ev);
  }
}
