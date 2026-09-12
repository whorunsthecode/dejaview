# Real Chrome scale test — 2026-09-12

## Recovery confirmed after force quit and restoration

The single-tab background test passed in 1,886 ms after the user force-quit
Chrome and the saved 479-tab window was restored (478 imported tabs plus the
existing test tab). Chrome had 483 tabs across all windows including another
smoke-test tab. The source had a new tab ID after restart and was complete,
not discarded, not frozen, and **inactive throughout the test**.

- Preview: ok, 104 characters.
- Extraction: ok, 2,998 characters, cold cache.
- Repeat read: ok, 2,998 characters, verified cache hit.
- Verbatim verifier: one exact quote passed; none repaired or failed.
- Live highlighter: one match, zero misses.
- Model calls: zero.

The restart cleared the observed background injection stall. The original full
model runs below remain failed historical results; no new paid full run was
performed. Reproduce the no-model check by opening
`chrome-extension://<extension-id>/test/browser-smoke.html`, clicking
“Load source and return” for the existing Flowise tab, then “Test background
extraction”. The test reuses the production preview, cache, extraction, verifier,
and highlighter implementations. Local regression suite: 215 passed, 12 skipped.

## Follow-up: isolated loaded-tab test

No additional OpenRouter or Exa calls were made. Keeping the existing Flowise
tab active produced an `ok` preview, 2,998 characters of extracted source text,
and a second `ok` read with `cached: true`. Background reads of that same loaded,
non-discarded, non-frozen tab timed out. Explicit document targeting and a
page-world probe also remained pending while it was in the background.

Preview failures now preserve the failing stage and browser error in the trace.
An entirely blocked/error preview batch stops with an error before preview
selection, gap search or skill writing, avoiding further model spending.
Metadata lookup is now bounded too. The source/tab/trace shapes are unchanged.
This establishes active-tab extraction and cache reuse, not background-scale
success. Automatic activation of hundreds of tabs has not been introduced.

Goal: Build a visual agent interface in 3D.

Inventory: 478 imported tabs plus other open/test tabs; extension enumerated 482
tabs across three windows. History discovery was off. Full-read budget was eight.
No personal link inventory or credentials are included in this report.

## Results

Two actual browser/model runs completed via write_skill, but neither produced a
usable source-backed skill. This is a failed end-to-end acceptance test.

| Measurement | First run | After fixes |
| --- | ---: | ---: |
| Enumerated tabs | 482 | 482 |
| Local shortlist | 50 | 50 |
| Attempted previews | 17 | 17 |
| Blocked previews | 16 | 0 |
| Error previews | 1 | 17 |
| Full reads | 0 | 0 |
| Verified source passages | 0 | 0 |

The second run ranked WorldClaw first after retaining the two-character term
`3D` in the lexical index. Exa was unavailable in the browser run and returned
marked stubs. A configured CLI .env does not establish browser configuration.

Chrome diagnostics reported no discarded tabs, with 372 of 482 marked loading.
The initial loading guard was too broad. Committed pages now use immediate
injection; discarded, frozen and pending-navigation pages remain blocked.
Despite that change, all previews still errored. A direct injection probe on a
visibly loaded page remained pending during observation. The exact remaining
browser injection failure is unresolved; it must not be claimed as a model or
ranking failure, or as proven to be caused by the tab count.

## Fixes and regression checks

- Resolved committed merge markers preventing panel JavaScript initialization.
- Preserved `3D` and other meaningful short tokens in both ranking paths.
- Use immediate injection for preview, revision, extraction and highlighting.
- Added tests for short-term ranking and committed pages with slow resources.
- Full local suite: 213 passed, 12 skipped, zero failures.
- Private scripts/phone-tabs.txt is ignored and untracked.

Parallel full reads, warm-cache hits and live highlights remain unverified in
this browser session because no extraction succeeded. Next investigate browser
injection timeouts/errors on one existing loaded page, then rerun the same goal
and check a warm-cache run. Do not increase the read cap to mask this failure.
