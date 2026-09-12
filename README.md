# dejavu

Chrome extension (MV3). An agent that reads your open tabs and, optionally, recent
browsing history, and converts what you have already read into a `SKILL.md` your
coding agent can execute later.

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
5. Press **keys** and paste an [OpenRouter](https://openrouter.ai/keys) key, then press
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
4. Names any gap out loud, and only then searches the web or looks at recent history.
5. Writes a `SKILL.md`, citing each source with the date you first opened that tab, and
   highlights the passages it used in the pages they came from.

Tick **Include recent history** before running to let step 4 also consider pages you
visited recently but no longer have open. See [agent/HISTORY.md](agent/HISTORY.md).

## Where the skill goes

The result panel offers three targets:

- **obsidian** — writes the note straight into your vault over the `obsidian://` URI
  scheme. No server, no account, no OAuth. A long skill is copied to the clipboard and
  the empty note opened instead, because a protocol URL is truncated silently and half a
  note is worse than an explicit paste.
- **copy** — the markdown on your clipboard, for Google Docs, Notion, or a PR body.
- **download** — a correctly named `.md`, taken from the skill's own frontmatter.

Set a vault and folder once, if you want them:

```js
chrome.storage.local.set({ OBSIDIAN_VAULT: "notes", OBSIDIAN_FOLDER: "skills" })
```

With no vault set, Obsidian uses whichever one is open.

## Habits

Press **habits** in the panel header for a visualiser of what you are actually reading:
the age of your open tabs, which sites they come from, how you have grouped them, and how
many of them history cannot date.

The same page can read your browsing history — the shape of your day, your week, and
where the time actually goes — but only when you press **read history** on it. Nothing is
computed until you ask, and nothing leaves the browser.

## Architecture

Two halves that never import each other, except through one deliberate seam. They speak
only through the message types in `shared/messages.js`.

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

| Message     | Direction      | Payload                                       |
| ----------- | -------------- | --------------------------------------------- |
| `PING`      | panel → worker | liveness handshake; replies with tab counts   |
| `RUN`       | panel → worker | `{ goal, includeHistory }`; replies with whether a run started |
| `TRACE`     | worker → panel | `{ event }`, one validated step at a time     |
| `SKILL`     | worker → panel | `{ markdown }`, the finished file             |
| `HIGHLIGHT` | agent → worker | `{ tabId, quotes }`; applied in the page      |

- `extension/tabs.js` — enumeration and first-visit dating.
- `extension/extract.js` — on-demand Readability, truncated to ~6000 characters.
- `extension/highlight.js` — normalised fuzzy matching of verbatim quotes in a page.
- `extension/history.js` — the bounded recent-history lookup, used only when asked.
- `extension/agent-bridge.js` — the seam: gives the agent its TabSource, credentials and
  the `SKILL.md` serializer.
- `extension/viz/` — the habits page.
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
| `storage`               | Hold your API keys locally so you type them once.                      |
| `sidePanel`             | The panel itself.                                                      |
| `host_permissions: <all_urls>` | Reading a chosen tab can mean any site, so the grant cannot be narrowed ahead of time. |

There is **no content script**. Both page-side jobs run through `chrome.scripting`, so
nothing is injected into a page until the agent has decided that page is worth opening.

## Privacy

By default, history is used only to date already-open tabs — `chrome.history.getVisits`
for URLs already in `chrome.tabs.query`, never a sweep of everything you have read.

Two features go further, and both are off until you turn them on:

- **Include recent history** on a run does a bounded recent-history lookup, offering up to
  50 metadata candidates for the model to choose from. Only selected pages are reopened
  and read, sharing the eight-read limit with open tabs.
- **read history** on the habits page reads recent history to draw the charts. It is
  computed in the page, shown to you, and stored nowhere.

Neither runs in the background, and neither happens unless you ask for it in that session.
Beyond that:

- Page text is extracted only from tabs the agent opens, never in bulk, and never stored —
  it lives in the run and is gone when the run ends.
- Your API keys live in `chrome.storage.local`, on this machine, and are sent only to
  OpenRouter and, if you add a key for it, Exa.
- Nothing is sent anywhere else. There is no telemetry.
- Dates mean earliest *retained* visits, not guaranteed first-ever visits.
- Loading unpacked packages the whole folder, so a `.env` in the repo root ships with it.
  Use the panel's key fields for the extension and keep `.env` for the Node runner.

## Web search (optional)

The agent works from your tabs alone. Give it an [Exa](https://exa.ai/) key — in the
panel's **keys** form — and it can also close a gap your tabs do not cover, but only after
naming that gap out loud first.

In the Node runner both of these must be set, since the key alone does not turn search on:

```
EXA_API_KEY=...
ENABLE_EXA=1
```

Check it before relying on it:

```
npm run try:exa -- "oauth device flow slow_down repeated backoff"
```

## Run the agent without a browser

```
npm run run:local -- "fix the device flow refresh"     # offline unless a key is set
npm run run:local -- --live "fix the device flow refresh"
npm run run:local -- --offline "fix the device flow refresh"
```

Runs against the fixture tabs in `shared/stubs.json`. `--offline` uses a deterministic
model fixture and makes no network calls, which is the fast way to check plumbing. The
local CLI never reads your personal history; that needs the injected browser source.

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
  Readability extraction, in-page highlighting, side panel, export targets, habits page.
- `agent/` — Karmen. Agentic loop, tool definitions, triage prompt, passage selection,
  skill conversion, loose-match mode, gap-fill search, history discovery, fallback.
- `shared/` — neither side edits without saying so. Data contract lives here.

<<<<<<< HEAD
The composition bridge in `extension/agent-bridge.js` injects browser sources into the
agent host. Agent production modules do not import extension code or Chrome APIs.
=======
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
and highlighted across sites. There is no content script declared in the manifest;
a small revision observer stays in pages after an on-demand read to invalidate cache entries.
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
Higher budgets increase latency and cost. Browser and CLI runs preview up to 20
metadata-selected candidates by default before choosing full reads. `peek_tab`
returns at most 600 characters and never supplies quoted evidence. Previews and
reads run with at most four operations in flight; full reads still share one budget.

An IndexedDB-backed inverted index stores normal-profile open-tab metadata and
updates on tab events. It reconciles once per worker wake, rather than enumerating
and dating everything per run. History discovery remains opt-in and bounded; it
is not continuously indexed. Selected source text is cached locally by URL and
SHA-256 hash for up to 24 hours, at most 100 entries, with document-revision checks
before reuse. Incognito metadata/text is not persisted. Discarded, frozen and
loading pages are skipped without activating or reloading them. See
[progressive discovery and validation](agent/PROGRESSIVE.md) for limits and clearing storage.

## Env

The Node CLI loads keys from the ignored `.env`. The browser host reads extension
storage populated by the panel; it does not load `.env`. Never package that file.
>>>>>>> 16e04d06a6175aff21d748344d442ea25c965dfa
