# Progressive discovery

Browser and CLI runs now use:

1. Read the local metadata index (browser) or StubTabSource (CLI).
2. Shortlist to 50 metadata candidates for large inventories, with canonical URL
   deduplication and a lane for group diversity. This is lexical discovery, not a
   semantic recall guarantee. Version queries and route fragments remain distinct.
3. Metadata triage chooses up to 20 previews at the default read budget. Larger
   budgets can preview up to 48; the separate hard preview budget is always 48.
4. `peek_tab(id)` returns `{id,description,heading,paragraph,textStatus}` totaling
   at most 600 characters, usually about 150 tokens. Tokens vary by language.
   It reads meta/OG description, h1 and the first paragraph without Readability.
5. One preview-selection model turn (one JSON correction allowed) chooses full
   reads and rejects title matches that are actually sales pages. Empty previews
   are not proof of useless content. Blocked/error previews are skipped.
6. Read independently with at most four operations in flight. The host reserves
   each budget slot before I/O, including failures. Writes and searches are barriers.
7. Verify passages before highlights or skill writing. Tight-mode selection uses
   eight-page batches; loose-mode selection compares the selected corpus together.

Every preview/read emits before and after trace events. Parallel operations can
interleave; use tab references and recording tool-call IDs to associate them.
Neither previews nor peek-only tabs enter passage verification or highlighting.
Replay records and validates previewed tab identities too.

## Host and source contract

The sixth model tool is `peek_tab`; existing Tab and TraceEvent shapes stay intact.
TabSource gains optional `peek(id)`; StubTabSource implements it from fixture text,
and MessageTabSource sends operation `peek` over its injected protocol. A remote
protocol adapter must implement that operation. Browser composition injects
`progressive: true` and `readConcurrency: 4`; the CLI does the same. Direct host
callers retain legacy defaults (`false`, `1`) unless they opt in explicitly.

Browser reads can include optional `url` and `cached` transport fields. The host
checks the URL against selected metadata before accepting evidence, and reports
cache hits. No agent module imports extension code or Chrome APIs.

## Cache and incremental index

- Open-tab metadata lives in extension-origin IndexedDB, updated on create,
  update, close, replacement, window attachment, group changes and relevant date
  changes. Closed rows are removed. A cold worker reconciles live IDs once;
  unchanged saved metadata can reuse visit dates for up to an hour.
- An inverted keyword index is maintained incrementally in worker memory and
  reconstructed from persisted metadata after a restart. No embedding service is
  used. Index queries do not inject scripts or fetch page contents.
- History remains a separate opt-in pipeline: bounded local scan, metadata
  shortlist, selected-page reopening. This change does not archive full history.
- Source text uses URL + SHA-256 keys, at most 100 entries and a 24-hour lifetime.
  Each hit checks a per-document UUID and MutationObserver revision in the current
  page. Navigation/reload/DOM changes invalidate reuse. A page changing during
  extraction produces an error result rather than an incorrectly attributed quote.
- Synchronous highlight wrappers preserve source text and are excluded from our
  observer; pending page changes are counted first, and observation resumes in
  `finally`. Actual text mutations still invalidate the cache.
- Concurrent requests for the same tab share extraction. Persistent writes are
  serialized for eviction/clear correctness. Storage failure leaves a memory-only
  fallback and emits a diagnostic. Incognito metadata/text is not persisted.
- No cached text is used for discarded/frozen/loading tabs: they return blocked
  without activation/reload. A browser API wait times out after ten seconds; an
  injection already dispatched cannot be cancelled by that timeout.

To clear cached text and rebuild open-tab metadata, inspect the extension service
worker and run `await dejavu.clearLocalCorpus()`. API credentials are unaffected.
Uninstalling the extension removes its local databases. Browser API references:
[tabs lifecycle and discarded state](https://developer.chrome.com/docs/extensions/reference/api/tabs)
and [on-demand script execution](https://developer.chrome.com/docs/extensions/reference/api/scripting).

## Validation

```sh
node --test agent/evals/progressive.test.js test/progressive-browser.test.js
node --test agent/tests/*.test.js agent/evals/*.test.js test/*.test.js
node agent/run-local.js --offline "fix the device flow refresh"
node agent/run-local.js --live "fix the device flow refresh"
```

Tests cover 20 previews → eight full reads, a rejected marketing preview, failed
read recovery, actual overlap with a concurrency ceiling of four, strict read and
peek budgets, malformed selection correction, and a write barrier until verification.
IndexedDB tests use fake-indexeddb; page tests use jsdom. They cover persistence
after worker restart, incremental update/remove, duplicate-heavy inventories,
expiry/eviction, in-flight clear, navigation, source mutation and highlight wrappers.
Final deterministic regression: 184 passed, 12 live tests skipped. The standalone
live CLI run below was executed separately; the offline CLI also completed cleanly.

One live OpenRouter run on the existing 20 stubs previewed seven tabs, chose two
full reads, and completed through write_skill in six model turns. Web gap-fill
returned marked unavailable stubs in that run. This is a real model test with fake
tabs; it does not establish Chrome latency or cache performance on real pages.

Manual browser smoke test: reload the unpacked extension, run a goal twice, and
look for verified cache hits on the second run. Edit/navigate a selected page and
check that it is re-extracted. Discard a candidate through Chrome's discards page;
it should remain discarded while the trace reports a blocked preview. Open, rename,
group and close tabs, then rerun to confirm index updates. Real Chrome smoke testing
remains outstanding because Computer Use permissions were unavailable.
