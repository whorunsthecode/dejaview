# dejavu

Chrome extension (MV3). An agent that reads open tabs and, optionally, recent
browsing history to produce a `SKILL.md` your coding agent can execute later.

**Thesis.** Open tabs are the only reading list nobody curates. Every open tab is an
implicit bookmark with a date. Some are from 2024 and relevant again now. No chatbox can
see this. dejavu converts them into an artifact that outlives the session.

## Load unpacked

Requires **Chrome 121 or newer** (`tab.lastAccessed` landed in 121; the manifest
declares that floor, so an older Chrome refuses to install rather than misbehaving).

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

## Permissions

| Permission | Purpose |
| --- | --- |
| `tabs` | Enumerate open-tab metadata. |
| `tabGroups` | Read the user's group titles. |
| `scripting` | Extract and highlight selected pages on demand. |
| `history` | Date open tabs and optionally discover recent pages. |
| `storage` | Keep API credentials in local extension storage. |
| `sidePanel` | Display the run and downloadable skill. |

`host_permissions` includes `<all_urls>` so selected articles can be extracted
and highlighted across sites. There is no content script running continuously.
No build step and no `npm install` are needed to load the extension.

Messages in `shared/messages.js`: `PING` checks worker status; `RUN` starts a run;
`TRACE` streams progress; `HIGHLIGHT` marks verified quotes; `SKILL` delivers output.
Browser extraction lives in `extension/extract.js`, highlights in
`extension/highlight.js`, and the host in `agent/host.js`; contracts are validated
by `shared/types.js`. Run `npm run run:local` for the CLI and `npm test` for tests.

## Privacy

By default, history is used only to date already-open tabs. With **Include recent
history** enabled, a bounded recent-history lookup scans up to 10,000 URLs locally and produces up to 200 metadata
candidates for model selection. Only selected pages are reopened and read, sharing
the configured read limit with open tabs (8 by default; panel options 24 and 48).
There is no background history collection.
Dates mean earliest retained visits, not guaranteed first-ever visits.

Large open-tab inventories are ranked locally to at most 50 metadata candidates
before model triage, using goal keywords and group diversity. This heuristic can
miss lexical mismatches; no ranking-quality guarantee is implied. Tight-mode
passage extraction runs in batches of eight read pages; loose mode compares all
selected pages together. CLI users can set `READ_LIMIT=24` or `READ_LIMIT=48`.
Higher budgets increase latency and cost. Reads remain serial; there is no peek
tool, persistent index, text cache, or discarded-tab recovery in this change.

## Env

The Node CLI loads keys from the ignored `.env`. The browser host reads extension
storage populated by the panel; it does not load `.env`. Never package that file.
