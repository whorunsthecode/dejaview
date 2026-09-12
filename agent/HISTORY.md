# Optional recent history

Reload the unpacked extension, open its panel, and check **Include recent history**
before running. The checkbox starts off and applies to that run. The background
handler accepts only the boolean `true`; a run freezes that choice while active.
The existing history permission is reused; no new permission or background collector
was added. Reading open-tab visit dates remains existing behavior when the option is off.

## Discovery contract

`shared/history.js` defines a separate HistoryCandidate validator and metadata
projection. Fields: historyId (string), url, title, visitCount, lastVisit (epoch),
firstVisit (earliest retained epoch or null). These are not Tab objects.

The host accepts `includeHistory: true` plus an injected HistorySource:

- `search({query, mode, excludeUrls, limit})` returns candidate metadata only.
- `open(candidate)` reuses or opens the selected URL and returns real Tab metadata
  once loaded. Text extraction is still performed by the existing read_tab handler.

The browser implementation lives in extension/history.js. It queries at most 10,000
URLs from the retained 90-day window, excludes non-HTTP(S) pages and already-open
URLs, deduplicates fragments/tracking parameters while preserving route fragments
and version queries, then shortlists at most 200. Ranking uses title/URL keyword
matches, visits and recency. Loose mode reserves half the shortlist for older
retained pages; the model still decides whether any have a useful mechanism.
This bounded search can miss relevant older pages when more than 10,000 URLs exist.

Only the shortlist is sent to the history-selection model, without page text.
Earliest retained dates are queried for those shortlisted URLs only. Null stays
unknown; opening a page does not replace its original discovery date with today.
No local archive is written during ordinary runs. Explicit RECORD captures the
run's selected metadata/content like other recording; treat that fixture accordingly.

## Execution and output

Tight: open tabs → verified passages → named material gap → history discovery and
selection → reopen/read/verify → reassess coverage → Exa only for remaining gaps.

Loose: open tabs → initial rhymes → one history shortlist → read selected pages →
reselect across all read text, keeping at most three verified rhymes total.

One history discovery pass per run. Eight reads by default across existing and reopened
pages, including failed reopen attempts. The panel offers 24 and 48; the host accepts
`maxReads` from 1 to 48, and Node accepts `READ_LIMIT`. With history enabled and a
budget above eight, initial triage reserves one third (at most eight) for history.
No extra model tool is added; history is
an injected host step. History model turns count toward the existing 20-turn limit.
One JSON/schema correction is permitted; remaining invalid output becomes a visible
note and the run continues. Budget exhaustion skips history with a visible note.

Selected pages open inactive and remain open for inspection/highlights. Existing
matching tabs are reused. Loading times out after 15 seconds; closed tabs, redirects
to a different normalized URL and extraction failures recover without a reopening
loop. Only actual numeric browser tab IDs enter the highlighter. Reopened pages
supply today's text, not an archived copy of the page when visited.

Verified passages and final source citations retain source:history, historyId,
earliest retained visit, and lastVisit. The serializer labels them “from browsing
history; earliest recorded visit …”. Open-tab dates use the same honest wording.
Web excerpts retain source:web and a null visit date. Existing shared Tab and
TraceEvent shapes are unchanged.

## Validation

```sh
node --test agent/tests/*.test.js agent/evals/*.test.js test/*.test.js
node --env-file=.env --test agent/evals/history.test.js
```

Full deterministic regression after capacity changes: 156 passed, 12 live tests skipped.
Scale fixtures cover 500 open tabs, 10,000 history URLs, and full tight runs at
8, 24 and 48 reads with verification batches of eight. These use scripted models;
they prove bounds and data flow, not semantic recall. No live scale run was made.
Previously completed live history
acceptance: 3 combined reads, 2 verified history passages, zero Exa searches after
reassessment. That test uses real OpenRouter decisions and injected fake browser
history, not access to the user's personal Chrome history.

Browser adapter tests cover bounds, deduplication, dates, inactive reopening,
reuse, redirects, closure and timeout. A DOM integration test uses the actual
vendored Readability, verifier and highlighter. A panel DOM test checks default-off
and both RUN payload values. A recording test captures reopened tab IDs, reproduces
trace/highlight payloads, and rejects replay when the reopened pages are absent.

Real Chrome smoke testing remains outstanding: Computer Use returned “Computer Use
permissions are not granted.” The shipped golden fixture was not overwritten.

## Manual browser acceptance

1. Reload deja-view at chrome://extensions and open the panel.
2. Choose an article you previously visited within the retained window, then close
   its tab. Keep a small set of open tabs that covers only part of your goal.
3. Enable Include recent history and run a goal whose missing procedure the closed
   article addresses. Expect gap → history lookup → selected page reopened inactive
   → extraction and highlights. The agent may honestly skip a weak match.
4. Inspect that reopened page: selected quotes should be marked. Inspect the skill
   Sources section: it must identify browsing history and the retained visit date.
5. Repeat with the checkbox off: no history search or history-driven reopen should
   occur. Existing open-tab date lookups may still happen.
6. For demo insurance, capture with the browser-connected Node host and keep all
   referenced tabs open. K6 file recording/replay is Node-only; the service worker
   does not directly read/write golden-run.json. Reopening a tab changes its ID.
