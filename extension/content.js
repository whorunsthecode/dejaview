// Content script. Injected into all pages.
// Responsible for: readable-text extraction and in-page highlighting.
// Stub: replies "not implemented" to any message.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  sendResponse({ ok: false, error: "not implemented" });
  return true;
});
