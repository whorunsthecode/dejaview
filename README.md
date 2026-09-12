# dejavu

Chrome extension (MV3). An agent that reads your open tabs and converts what you've
already read into a `SKILL.md` your coding agent can execute later.

**Thesis.** Open tabs are the only reading list nobody curates. Every open tab is an
implicit bookmark with a date. Some are from 2024 and relevant again now. No chatbox can
see this. dejavu converts them into an artifact that outlives the session.

## Load unpacked

1. `git clone` this repo.
2. Chrome → `chrome://extensions` → toggle Developer mode.
3. Click "Load unpacked" → select this folder.
4. Open the side panel from the extensions toolbar. You should see stubbed trace events.

## Run the agent locally (no browser)

```
node agent/run-local.js "fix the device flow refresh"
```

Reads `shared/stubs.json` and prints a fake trace to stdout. Proves the plumbing; replace
`runFakeLoop` in `agent/host.js` with a real model loop once tools are wired.

## Ownership

- `extension/` — Rohan. Manifest, tab enumeration, first-visit dating, on-demand
  Readability extraction, in-page highlighting, side panel, download. Both page-side
  jobs run through `chrome.scripting`, so there is no standing content script.
- `agent/` — Karmen. Agentic loop, tool definitions, triage prompt, passage selection,
  skill conversion, loose-match mode, gap-fill search, deterministic fallback.
- `shared/` — neither side edits without saying so. Data contract lives here.

Nothing in `extension/` imports from `agent/` or vice versa. The two halves communicate
through the four message types in `shared/messages.js` only.

## Privacy

The `history` permission is used exclusively to date tabs that are already open
(`chrome.history.getVisits({url})` for URLs in `chrome.tabs.query`). Browsing history is
never enumerated or mined as a corpus.

## Env

Copy `.env.example` to `.env` and fill in keys. Nothing reads them yet.
