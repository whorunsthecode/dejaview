# dejavu

Chrome extension (MV3). An agent that reads your open tabs and converts what you've
already read into a `SKILL.md` your coding agent can execute later.

**Thesis.** Open tabs are the only reading list nobody curates. Every open tab is an
implicit bookmark with a date. Some are from 2024 and relevant again now. No chatbox can
see this. dejavu converts them into an artifact that outlives the session.

## Load unpacked

Requires **Chrome 121 or newer** (`tab.lastAccessed` landed in 121; the manifest
declares that floor, so an older Chrome refuses to install rather than misbehaving).

1. `git clone` this repo.
2. Chrome → `chrome://extensions` → toggle **Developer mode**.
3. **Load unpacked** → select the repo root, the folder holding `manifest.json`.
4. Click the dejavu icon to open the side panel.
5. Paste an [OpenRouter](https://openrouter.ai/keys) key when the panel asks, and press
   **run** with something you are actually working on.

No build step and no `npm install`. The extension has zero runtime dependencies —
Readability is vendored into `extension/vendor/` because MV3 forbids loading remote code.
`npm install` is only needed to run the tests.

Without a key the panel will not invent a result. It says so, and offers a scripted demo
run over `shared/stubs.json` instead — clearly labelled, so a canned file never gets
mistaken for a real one.

## What a run does

1. Enumerates every tab in every window, and dates each one from the **earliest** visit
   its URL has in history. A tab history cannot date is `undated`, never guessed.
2. Triages on titles, URLs and dates alone — deciding what is worth opening *without*
   reading anything is the point, so nothing is extracted up front.
3. Reads only the tabs it chose, injecting Readability on demand, capped at 8 reads.
4. Names any gap out loud, and only then searches the web to close it.
5. Writes a `SKILL.md`, citing each source with the date you first opened that tab, and
   highlights the passages it used in the pages they came from.

## Architecture

Two halves that never import each other. They speak only through the message types in
`shared/messages.js`.

```
  side panel  ──RUN──▶  service worker  ──▶  agent loop (agent/)
  (panel/)    ◀─TRACE──  (background.js)  ◀──  tools: list_tabs, read_tab,
              ◀─SKILL──         │               search_in_tab, web_search,
                                │               write_skill
                                ▼
                         chrome.tabs / history / scripting
                                │
                                ▼
                      the pages themselves (Readability, highlighting)
```

| Message     | Direction        | Payload                                        |
| ----------- | ---------------- | ---------------------------------------------- |
| `PING`      | panel → worker   | liveness handshake; replies with tab counts    |
| `RUN`       | panel → worker   | `{ goal }`; replies with whether a run started  |
| `TRACE`     | worker → panel   | `{ event }`, one validated step at a time       |
| `SKILL`     | worker → panel   | `{ markdown }`, the finished file               |
| `HIGHLIGHT` | agent → worker   | `{ tabId, quotes }`; applied in the page        |

- `extension/tabs.js` — enumeration and first-visit dating.
- `extension/extract.js` — on-demand Readability, truncated to ~6000 characters.
- `extension/highlight.js` — normalised fuzzy matching of verbatim quotes in a page.
- `extension/agent-bridge.js` — supplies the agent its TabSource, credentials and the
  `SKILL.md` serializer.
- `agent/` — the loop itself: triage, passage selection, gap-fill, conversion.

`HIGHLIGHT` is the one message that never rides the bus end to end: a context does not
receive its own `runtime.sendMessage`, so the bridge applies it directly.

## Permissions

Every permission in `manifest.json` and the one thing it is for:

| Permission              | Why                                                                   |
| ----------------------- | --------------------------------------------------------------------- |
| `tabs`                  | Enumerate open tabs and read their titles and URLs.                    |
| `tabGroups`             | Read a tab group's title, so grouped tabs keep the name you gave them. |
| `history`               | Date an already-open tab. See Privacy below.                           |
| `scripting`             | Inject Readability and the highlighter, only into tabs the agent picks. |
| `storage`               | Hold your API key locally so you type it once.                         |
| `sidePanel`             | The panel itself.                                                      |
| `host_permissions: <all_urls>` | Reading a chosen tab can mean any site, so the grant cannot be narrowed ahead of time. |

There is **no content script**. Both page-side jobs run through `chrome.scripting`, so
nothing is injected into a page until the agent has decided that page is worth opening.

## Privacy

The `history` permission is used exclusively to date tabs that are already open
(`chrome.history.getVisits({url})` for URLs in `chrome.tabs.query`). Browsing history is
never enumerated or mined as a corpus.

Also true, and worth saying plainly:

- Page text is extracted only from tabs the agent explicitly opens, never in bulk, and is
  never stored — it lives in the run and is gone when the run ends.
- Your API key is kept in `chrome.storage.local`, on this machine, and is sent only to
  OpenRouter (and Exa, if you add a key for it).
- Nothing is sent anywhere else. There is no telemetry.
- Loading unpacked packages the whole folder, so a `.env` sitting in the repo root ships
  with it. Use the panel's key field for the extension and keep `.env` for the Node
  runner below.

## Web search (optional)

The agent works from your tabs alone. Give it an [Exa](https://exa.ai/) key and it can
also close a gap your tabs do not cover — but only after naming that gap out loud first,
so a search never quietly papers over thin coverage.

In the extension, press **keys** in the panel header and fill the Exa field. In the Node
runner, both of these must be set, since the key alone does not turn search on:

```
EXA_API_KEY=...
ENABLE_EXA=1
```

Check the key before you rely on it:

```
npm run try:exa -- "oauth device flow slow_down repeated backoff"
```

It prints the gate state and then makes one real request, so a misconfigured setup fails
there instead of halfway through a demo.

## Run the agent without a browser

```
npm run run:local -- "fix the device flow refresh"     # offline unless a key is set
npm run run:local -- --live "fix the device flow refresh"
npm run run:local -- --offline "fix the device flow refresh"
```

Runs against the fixture tabs in `shared/stubs.json`. `--offline` uses a deterministic
model fixture and makes no network calls, which is the fast way to check plumbing.
`--live` needs `OPENROUTER_API_KEY`; copy `.env.example` to `.env` and fill it in.

## Tests

```
npm install
npm test
```

Node's built-in runner, no framework. Extraction and highlighting run against real jsdom
documents and the real vendored Readability, so a broken vendoring step fails the suite
rather than passing it. Tests needing live API keys skip themselves without one.

## Ownership

- `extension/` — Rohan. Manifest, tab enumeration, first-visit dating, on-demand
  Readability extraction, in-page highlighting, side panel, download, agent bridge.
- `agent/` — Karmen. Agentic loop, tool definitions, triage prompt, passage selection,
  skill conversion, loose-match mode, gap-fill search, deterministic fallback.
- `shared/` — neither side edits without saying so. Data contract lives here.

Nothing in `extension/` imports from `agent/` except `agent-bridge.js`, which exists to be
the single seam between them.
