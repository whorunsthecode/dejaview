# Browser integration handoff

The browser bridge in extension/agent-bridge.js injects real tab list/read handlers,
credentials from extension storage, the skill serializer, and highlight routing.
Agent production modules do not depend on Chrome APIs or extension modules.

- Panel input: RUN { goal, includeHistory?: boolean }. The worker normalizes the
  history flag to an explicit boolean and freezes it for the run.
- Live output: TRACE { event }, validated before delivery.
- Verified output: HIGHLIGHT { tabId, quotes }, routed to the actual page.
- Completion: SKILL { markdown }, using the injected serializer.

History is optional, off by default, and uses the separate shared/history.js
contract. The browser source returns history candidates without fake tab IDs;
selected pages are reopened before existing extraction and highlighting run.
See HISTORY.md for budgets, provenance, test results and manual browser acceptance.

K6 fixture recording/replay remains confined to the Node host. A service worker
cannot load Node credentials or filesystem fixtures. Existing Node replay tests
also cover reopened history tab IDs; no browser replay bypass was added.
