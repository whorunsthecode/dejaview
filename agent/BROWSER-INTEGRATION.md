# Browser integration handoff

`attachMessageHost` in `message-host.js` now binds the existing application messages
to K1. The four message constants and shared data shapes are unchanged:

- Input: `RUN { goal }`.
- Live output: `TRACE { event }`, with every event validated.
- Completed output: `SKILL { markdown }`, using an injected serializer.
- Verified output: `HIGHLIGHT { tabId, quotes: string[] }`. Each quote is an exact
  span from that tab’s read snapshot. An empty array clears the tab’s selection.
  The extension must route this payload to the corresponding page; DOM behavior
  is not implemented or tested by the agent host.

The composition entry point supplies a TabSource, runtime credentials, the agreed
Markdown serializer, and optional send/on transport functions. The adapter prevents
overlapping runs, releases its listener on disposal, and suppresses late output
after disposal. K1 still owns its read budget and all tool control flow.

Remaining browser-owned work:

1. Implement tab list/read handlers. Enumerate open tabs; obtain history visits only
   for those URLs. Extract text only after an explicit read request, preserving the
   blocked/empty/error statuses. Return the existing shared Tab/read shapes.
2. Agree and inject MessageTabSource's request/reply protocol; the existing four
   application messages do not themselves define tab RPC.
3. Change the panel's TRACE receiver to render `payload.event`. It currently renders
   the outer payload, which fails the shared trace validator for the agreed envelope.
4. Supply a credential-loading runtime. A browser worker cannot load Node's `.env`;
   do not package `.env` as an extension asset. A local Node host can retain the keys,
   while a browser-hosted implementation needs an explicit credential configuration.
5. Supply the SKILL serializer/download handling separately. This adapter does not
   invent the conversion output format or import Chrome APIs.

No files in extension/ or shared/ were changed for this handoff. The browser bridge
is not yet connected to real tabs. Earlier ownership instructions reserve extension/
for Rohan; permission to implement that half is pending.

Validation: `node --test agent/tests/*.test.js` (16 tests).
