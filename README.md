# dejavu

Chrome extension (MV3). An agent that reads open tabs and, optionally, recent
browsing history to produce a `SKILL.md` your coding agent can execute later.

**Thesis.** Open tabs are the only reading list nobody curates. Every open tab is an
implicit bookmark with a date. Some are from 2024 and relevant again now. No chatbox can
see this. dejavu converts them into an artifact that outlives the session.

## Load unpacked

1. `git clone` this repo.
2. Chrome → `chrome://extensions` → toggle Developer mode.
3. Click "Load unpacked" → select this folder.
4. Open the side panel from the extensions toolbar and add your OpenRouter key.
5. Optionally check **Include recent history** before running. Selected history pages
   reopen inactive for extraction and highlights. See [history behavior and tests](agent/HISTORY.md).

## Run the agent locally (no browser)

```
node agent/run-local.js "fix the device flow refresh"
```

Reads `shared/stubs.json`. Uses OpenRouter when configured; pass `--offline` for
the deterministic plumbing fixture. Browser history requires the injected browser
source; the local CLI does not read personal history.

## Ownership

- `extension/` — Rohan. Manifest, tab enumeration, first-visit dating, on-demand
  Readability extraction, in-page highlighting, side panel, download. Both page-side
  jobs run through `chrome.scripting`, so there is no standing content script.
- `agent/` — Karmen. Agentic loop, tool definitions, triage prompt, passage selection,
  skill conversion, loose-match mode, gap-fill search, deterministic fallback.
- `shared/` — neither side edits without saying so. Data contract lives here.

The composition bridge in `extension/agent-bridge.js` injects browser sources into
the agent host. Agent production modules do not import extension code or Chrome APIs.

## Privacy

By default, history is used only to date already-open tabs. With **Include recent
history** enabled, a bounded recent-history lookup produces up to 50 metadata
candidates for model selection. Only selected pages are reopened and read, sharing
the eight-read limit with open tabs. There is no background history collection.
Dates mean earliest retained visits, not guaranteed first-ever visits.

## Env

The Node CLI loads keys from the ignored `.env`. The browser host reads extension
storage populated by the panel; it does not load `.env`. Never package that file.
