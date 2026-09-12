import { MSG } from "../shared/messages.js";

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case MSG.RUN:
      // not implemented
      break;
    case MSG.TRACE:
      // not implemented
      break;
    case MSG.HIGHLIGHT:
      // not implemented
      break;
    case MSG.SKILL:
      // not implemented
      break;
  }
});
