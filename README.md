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

- **obsidian** — opens the note in your vault over the `obsidian://` URI scheme. No
  server, no account, no OAuth. Windows truncates a protocol URL near 2048 characters,
  and the cut usually lands mid-escape, so Obsidian drops the content and leaves a
  correctly named empty note. Rather than risk that, anything over 2000 characters — which
  is most skills — is put on your clipboard and the note opened ready for **Ctrl+V**.
  Only a short skill travels inside the URL.
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
- `extension/peek.js` — cheap previews, capped short so they can never stand in as evidence.
- `extension/tab-index.js` — the IndexedDB metadata index, kept fresh on tab events.
- `extension/text-cache.js` — extracted text, cached by hash with revision checks.
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
| `clipboardWrite`        | Put a finished skill on your clipboard for the Obsidian and copy buttons. |
| `sidePanel`             | The panel itself.                                                      |
| `host_permissions: <all_urls>` | Reading a chosen tab can mean any site, so the grant cannot be narrowed ahead of time. |

There is **no content script** declared in the manifest. Both page-side jobs run through
`chrome.scripting`, so nothing is injected into a page until the agent has decided that
page is worth opening. One exception worth naming: after an on-demand read, a small
revision observer stays behind in that page so a cached extract can be invalidated when
the page changes.

## Privacy

By default, history is used only to date already-open tabs — `chrome.history.getVisits`
for URLs already in `chrome.tabs.query`, never a sweep of everything you have read.

Two features go further, and both are off until you turn them on:

- **Include recent history** on a run scans up to 10,000 recent URLs locally and offers at
  most 200 metadata candidates for the model to choose from. Only selected pages are
  reopened and read, sharing the page budget with open tabs.
- **read history** on the habits page reads recent history to draw the charts. It is
  computed in the page, shown to you, and stored nowhere.

Neither runs in the background, and neither happens unless you ask for it in that session.
Beyond that:

- Page text is extracted only from tabs the agent opens, never in bulk. Text it did read
  is cached locally by URL and SHA-256 hash for up to 24 hours, at most 100 entries, and
  checked against the page's revision before reuse.
- Open-tab **metadata** is kept in an IndexedDB index that updates on tab events, so a run
  does not re-enumerate and re-date everything. Metadata only; no page text, and nothing
  from an incognito window is persisted.
- Previews are cheap and deliberately weak evidence: `peek_tab` returns at most 600
  characters and can never supply a quote. At most four previews or reads are in flight at
  once. See [agent/PROGRESSIVE.md](agent/PROGRESSIVE.md) for the limits and how to clear
  the stored data.
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

The composition bridge in `extension/agent-bridge.js` injects browser sources into the
agent host. Agent production modules do not import extension code or Chrome APIs.
