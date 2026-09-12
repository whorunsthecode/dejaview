# deja-view

Chrome extension (MV3). An agent that reads your open tabs and, optionally, recent
browsing history, and converts what you have already read into a `SKILL.md` your
coding agent can execute later.

**Thesis.** Open tabs are the only reading list nobody curates. Every open tab is an
implicit bookmark with a date. Some are from 2024 and relevant again now. No chatbox can
see this. deja-view converts them into an artifact that outlives the session.

## Load unpacked

Requires **Chrome 121 or newer** (`tab.lastAccessed` landed in 121; the manifest
declares that floor, so an older Chrome refuses to install rather than misbehaving).

1. `git clone` this repo.
2. Chrome → `chrome://extensions` → toggle **Developer mode**.
3. **Load unpacked** → select the repo root, the folder holding `manifest.json`.
4. Click the deja-view icon to open the side panel.
5. Press **keys** and either paste an [OpenRouter](https://openrouter.ai/keys) key or
   turn on **Local model** to use a model on your own machine, then press **run**
   with something you are actually working on.

No build step and no `npm install`. The extension has zero runtime dependencies —
Readability is vendored into `extension/vendor/` because MV3 forbids loading remote code.
`npm install` is only needed to run the tests.

With no model configured — neither a key nor a local server — the panel will not invent
a result. It says so, and offers a scripted demo run over `shared/stubs.json` instead —
clearly labelled, so a canned file never gets mistaken for a real one.

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

The result panel offers five targets, one icon each:

- **obsidian** — opens the note in your vault over the `obsidian://` URI scheme. No
  server, no account, no OAuth. Windows truncates a protocol URL near 2048 characters,
  and the cut usually lands mid-escape, so Obsidian drops the content and leaves a
  correctly named empty note. Rather than risk that, anything over 2000 characters — which
  is most skills — is put on your clipboard and the note opened ready for **Ctrl+V**.
  Only a short skill travels inside the URL.
- **notion** — creates a real Notion page under a parent you choose. Notion has no
  markdown endpoint, so the skill is parsed into typed blocks: headings, numbered steps,
  code, quotes. Frontmatter becomes a YAML code block rather than stray prose.
- **docs** — creates a Google Doc. Drive converts the markdown on upload, so headings and
  lists arrive as real formatting rather than a wall of text.
- **copy** — the markdown on your clipboard, for anywhere else.
- **download** — a correctly named `.md`, taken from the skill's own frontmatter.

Each target is optional and needs its own credential, entered once under **keys**. The
setup costs differ a lot, so pick by how much you want to spend:

| Target | Setup | Where it goes |
| --- | --- | --- |
| Obsidian | none | your vault |
| Notion | make an integration, share one page with it | a page under that parent |
| Google Docs | a Google Cloud OAuth client id | your Drive |

**Notion.** Create an internal integration at
[notion.so/my-integrations](https://www.notion.so/my-integrations), copy its token, then
open the Notion page you want skills filed under and share it with that integration.
Paste the token and the page URL under **keys**. The integration can only see pages you
explicitly share, so the token cannot reach the rest of your workspace.

**Google Docs.** Create an OAuth client id (type: *Web application*) in a Google Cloud
project with the Drive API enabled, and add the redirect URI shown in the **keys** form —
it contains this install's extension id — to that client. Paste the client id under
**keys**. The only scope requested is `drive.file`, which covers files this extension
creates and nothing else in your Drive.

Set a vault and folder once, if you want them:

```js
chrome.storage.local.set({ OBSIDIAN_VAULT: "notes", OBSIDIAN_FOLDER: "skills" })
```

With no vault set, Obsidian uses whichever one is open.

## Rediscovery

The other half of the thesis: things you read months ago are only useful if
something reminds you of them at the moment they matter.

When you land on a page that means you are working — a Google Doc, a GitHub
repo, a Notion page, a Linear or Jira ticket — deja-view works out what it is
about and looks through what you already have open for something older that
relates. If it finds one, the toolbar icon gets a badge and the panel shows a
single strip: the page, when you first read it, and one sentence on why it came
up. Clicking it opens that page scrolled to the passage, using a
[text fragment](https://developer.mozilla.org/docs/Web/URI/Fragment/Text_fragments)
link, so nothing is injected into the page to get you there.

Everything about it is built to stay quiet:

- **At most one nudge an hour, three a day**, and never the same item twice
  unless you ask for it.
- **Undated items never qualify.** The claim is "you read this months ago", and
  without a first-visit date that claim cannot be made. It is never guessed.
- **One shared word is not a relationship.** Two are, or one that appears
  nowhere else in your tabs.
- **Dismissing teaches it.** Every nudge has *less like this* and a dismiss;
  both push that theme down the ranking, the explicit one about three times
  harder. Ignore a theme enough and it stops coming up.
- **No modal, no sound, no focus change.** The strip appears in the flow and
  waits. It cannot interrupt typing.
- **No model and no network.** Matching is lexical and runs on your machine.

Press **surprise me** for the manual version: one thing at random, weighted
toward pages you spent real time on and have not been back to. It ignores the
threshold and the rate limits, because you asked.

Under **keys → Rediscovery** are the switch, the age floor (30 days by
default), the confidence threshold, and the feature's own scoreboard — how many
nudges it has made and what share of them you opened. If it is not earning its
interruptions, that number is where you will see it.

## Slices

A slice is a themed piece of your reading, written out as one self-contained
Markdown document you can send to someone.

Two ways in:

- **Habits → what you are reading about → export this theme.** Your open tabs are
  grouped by what they have in common, or by the name you gave the tab group.
  Tabs that fall into no theme are left out rather than swept into a pile called
  "other", and a theme is only ever named after a word a person wrote — a title
  or a group name, never a hostname, or you end up with a theme called "medium".
- **The panel's result → the slice button.** The sources a run actually cited are
  a result set like any other, so they go through the same screen.

**Nothing is generated until you confirm.** The review screen comes first and
shows every item that would be included, with its title, domain, first-read date,
and the exact passage that would be quoted. Each has a toggle. You add the title
and an intro line there.

- **Anything on the sensitive domain list is switched off before you see it** —
  health, money, adult, dating, legal and immigration, job hunting, crisis
  services, religion and politics, and private inboxes — and the count is shown
  whether or not you expand the list. Filtering you cannot see is worse than no
  filtering, because you would trust the result more than it deserves. It matches
  on the domain, not the page text, so it will miss things: the review screen is
  the safeguard, the list only sets the defaults. Add your own with
  `chrome.storage.local.set({ SENSITIVE_DOMAINS: ["acme.corp"] })`.
- **A page that was never read has no passage**, and says so rather than showing
  an empty quote. There is a button to read those, which is the only part of this
  flow that opens anything.

The document has the title, the intro, then each item as a heading with its link,
date, a one-sentence note on why it is in the slice, and the quoted passage —
grouped by sub-theme when the model finds a real one — and a closing paragraph on
what the collection adds up to.

Without an OpenRouter key it still generates, but the grouping and commentary are
assembled mechanically and **the document's own footer says so**. A reader who
cannot tell model prose from a word count will trust the wrong half.

Slices are kept on this machine. Reopen one to edit it, or **regenerate** it after
reading more on the theme: anything new that matches is added, and everything you
removed stays removed. From a saved slice you can copy it, download the `.md`, or
send it to Obsidian, Notion or Google Docs.

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
| `NUDGE`     | worker → panel | `{ nudge }`, one rediscovery, unprompted      |
| `NUDGE_STATE` | panel → worker | the pending nudge, the accept rate, the settings |
| `NUDGE_ACTION` | panel → worker | `{ id, action }` — opened, dismissed, less like this |
| `SURPRISE`  | panel → worker | resurface one thing on request                |

- `extension/tabs.js` — enumeration and first-visit dating.
- `extension/extract.js` — on-demand Readability, truncated to ~6000 characters.
- `extension/highlight.js` — normalised fuzzy matching of verbatim quotes in a page.
- `extension/history.js` — the bounded recent-history lookup, used only when asked.
- `extension/peek.js` — cheap previews, capped short so they can never stand in as evidence.
- `extension/tab-index.js` — the IndexedDB metadata index, kept fresh on tab events.
- `extension/text-cache.js` — extracted text, cached by hash with revision checks.
- `extension/agent-bridge.js` — the seam: gives the agent its TabSource, credentials and
  the `SKILL.md` serializer.
- `extension/rediscovery/triggers.js` — what counts as a page you are working on.
- `extension/rediscovery/rank.js` — the bar an old page has to clear to interrupt you.
- `extension/rediscovery/budget.js` — one an hour, three a day, and the accept rate.
- `extension/rediscovery/dwell.js` — foreground time, and the weighted draw behind *surprise me*.
- `extension/rediscovery/engine.js` — the watcher that puts those together.
- `extension/slices/themes.js` — the clustering behind "what you are reading about".
- `extension/slices/sensitive.js` — the domain list a slice excludes by default.
- `extension/slices/review.js` — what the review screen shows before anything is written.
- `extension/slices/render.js` — the Markdown document itself.
- `extension/slices/compose.js` — the model step, and what the document says without one.
- `extension/local-model.js` — the local-model provider, and the rule that it never falls back to the cloud.
- `extension/panel/export.js` — the Obsidian URI plan, chunked so nothing is truncated.
- `extension/panel/notion.js` — markdown parsed into Notion blocks.
- `extension/panel/gdocs.js` — the Google OAuth flow and the Drive upload.
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
| `identity`             | The Google OAuth redirect, only when you use the Docs export.          |
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

**Rediscovery is the one part that runs in the background, and it is on by
default.** It has to be: a nudge that only arrives when you go looking for it is
not a nudge. What that means exactly:

- It sees the title and URL of pages you finish loading, the same metadata the
  tab index already holds. It **reads a page's content only on a page that
  triggers** — a doc, a repo, a Notion page, a ticket — and only when a nudge
  could actually result, so being inside its rate limit means the page is never
  looked at. What it reads is a 600-character peek, never a full extraction.
- It keeps a **dwell table**: how long each page was in the foreground, capped
  per session, for at most 500 pages. That is what weights *surprise me*.
- It keeps a **log of every nudge** — the trigger, the item, and what you did —
  which is what the accept rate in settings is computed from.
- All of it is local, and none of it reaches a model or the network: the
  matching is lexical and runs in the worker.
- Turn it off under **keys → Rediscovery** and it stops. The switch is checked
  before the extension looks at any page content, writes any dwell, or shows any
  badge, so *off* means none of those three happen.

Two further features are off until you turn them on:

- **Include recent history** on a run scans up to 10,000 recent URLs locally and offers at
  most 200 metadata candidates for the model to choose from. Only selected pages are
  reopened and read, sharing the page budget with open tabs.
- **read history** on the habits page reads recent history to draw the charts. It is
  computed in the page, shown to you, and stored nowhere.

Neither of those two runs in the background, and neither happens unless you ask
for it in that session. Rediscovery can use recent history as well, and that is
a third switch of its own, off by default.

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
  the stored data. `dejavu.clearLocalCorpus()` in the worker console clears the
  text cache, the tab index, and rediscovery's log and dwell table together.
- A **slice** is the only thing here built to be shared, so it is the only place
  where something private leaving the machine is possible. It is gated on an
  explicit confirmation after a screen showing every item, with the sensitive
  domain list applied and counted first. Saved slices stay local until you press
  one of the send buttons. When a model writes the prose, the titles, dates and
  already-extracted passages of the items you kept are what it is sent — never
  page text, and never an item you removed.
- Your API keys and connector credentials live in `chrome.storage.local`, on this
  machine, and are sent only to the service each belongs to: OpenRouter, Exa, Notion
  or Google. A finished skill goes to a connector only when you press its button.
- **Local model** under **keys** moves every model call to a server on your own
  machine. While it is on there is no cloud fallback of any kind: an unreachable
  local server produces an error, never a quiet request to OpenRouter. Web search
  is separate and still leaves the machine if you have given it an Exa key.
- Nothing is sent anywhere else. There is no telemetry.
- Dates mean earliest *retained* visits, not guaranteed first-ever visits.
- Loading unpacked packages the whole folder, so a `.env` in the repo root ships with it.
  Use the panel's key fields for the extension and keep `.env` for the Node runner.

## Running the model locally

Under **keys → Local model** there is one switch: *process everything on this
machine*. With it on, runs and slice write-ups go to a model on your own machine
instead of OpenRouter.

**While it is on, nothing falls back to the cloud.** If the local server is not
reachable, the work fails and says so. A fallback would be the one behaviour that
defeats the point of the switch, at the one moment you would be least likely to
notice it.

### What you need to install

Anything that speaks the OpenAI chat-completions API. The field wants that
server's base URL, so this is not tied to one product:

| Server | Base URL | The bit people get stuck on |
| --- | --- | --- |
| [Ollama](https://ollama.com) | `http://localhost:11434/v1` | start it with `OLLAMA_ORIGINS` set (below) |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` | turn on **Enable CORS** in the server tab |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | `http://localhost:8080/v1` | nothing; it allows every origin |

With Ollama, which is the shortest path:

```bash
ollama pull qwen2.5:7b
OLLAMA_ORIGINS=chrome-extension://* ollama serve
```

`OLLAMA_ORIGINS` is the step that matters. Ollama checks the `Origin` header and
rejects a `chrome-extension://` caller by default, which looks exactly like the
server being down. The **keys** form prints your install's own extension id so
you can narrow that wildcard, and the **test the connection** button tells you
which of the two problems you have, including whether the model you named is
actually pulled.

### What works well, and what is best-effort

- **Slices** are one JSON call. Any competent 7B or 8B handles them, and the
  generated document's footer records that a local model wrote it.
- **A full run** drives a tool-calling loop over many turns. That is a much
  harder ask: use a model with real tool support (`qwen2.5:7b` and `llama3.1:8b`
  are reasonable starting points) and expect it to be worse than the hosted
  default. If it goes wrong it will do so visibly in the trace, not silently.
- Local generation is slow enough that the timeout is three minutes rather than
  the thirty seconds used for the hosted path.

The status line in the panel says `local model` or `openrouter` at all times, so
where your reading is going is never something you have to remember.

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
