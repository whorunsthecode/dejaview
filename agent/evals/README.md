# K2 triage evaluation

Offline regression and contract tests:

```sh
node --test agent/tests/*.test.js agent/evals/triage.test.js
```

Three live runs of the same goal with OpenRouter (Node loads the ignored .env;
its contents are not printed):

```sh
node --env-file=.env --test agent/evals/triage.test.js
```

Without OPENROUTER_API_KEY, the three live cases explicitly skip. Set
TRIAGE_EVAL_OUTPUT_DIR to an output directory to retain complete raw model
responses for successes and failures. Failures always print the full response,
including the one permitted repair response. This suite never retries a failed
acceptance test until it passes.

## Decisions

- Use device authorization polling as the goal because original fixtures 481 and
  482 cover that topic. Keep the original six objects exactly; append 14 synthetic
  fixtures, including two duplicate views and three new landing pages.
- Feed triage only id, title, url, groupTitle, and firstVisit. Format firstVisit as
  YYYY-MM-DD in UTC in this model-only projection; null stays null. The shared Tab
  shape and stored epoch dates are unchanged.
- Ask for JSON mode, with no function tools, and a 4096-token output budget.
  Every known tab must appear exactly once in open or skip. Validate all reasons
  as 1–14 whitespace-separated words and reject generic relevance-only reasons.
- Use one repair opportunity for JSON or schema/decision errors. Report all long
  reasons together so the one correction can address them. Network retry remains
  the existing transport's responsibility.
- Reject simultaneously selected views of the same canonical document. Ignore
  ordinary fragments and common tracking parameters for this comparison, while
  preserving version queries and hash routes. Semantic near-duplicates remain a
  model judgment. Duplicate skip reasons start with `Duplicate:` for aggregation.
- Truncate excess valid selections in ranked order and move overflow to skip with
  a budget explanation. No minimum number of opens is forced in production; the
  3–8 requirement applies to this particular live fixture goal.
- The host enumerates metadata, runs triage as its first model turn, then actually
  executes the selected reads. Those reads consume K1's existing eight-call budget.
  Later loop reads, if any, consume the remaining same budget. Triage, including
  its correction if used, counts toward the 20-model-turn run limit.
- Emit one aggregate skip count without pretending every nonduplicate skip has
  the same cause. Each selected read has its why in the tool trace detail and a
  result event after execution. No per-skip traces are emitted.
- Add triageModel injection for isolated tests; production uses the same configured
  model for triage and the subsequent loop. The offline fixture models the JSON
  exchange explicitly and is not represented as real triage judgment.

## Live evaluation outcome

Initial batch: one model-contract failure (long reasons remaining after repair)
and two eval-harness failures (an assertion method typo, since fixed). The model
outputs were printed in full. The next batch passed 2/3; its failure repaired a
duplicate selection but introduced an overlong duplicate skip reason. This led
to shorter duplicate examples and explicit rechecking of all reasons on repair.

Final fresh batch: 3/3 passed, opening 4, 5, and 6 tabs. All runs selected an
original on-topic tab and avoided the pricing page and three landing pages.
Every final output parsed and all open/skip reasons were under 15 words. Runs 1
and 2 used the one permitted repair; run 3 succeeded on the first response.
This is a three-run acceptance result, not a guarantee of general reliability.

No passage selection, skill-writing logic, extension files, or shared types or
message schemas were changed.


# K3 passage verification evaluation

```sh
node --test agent/tests/*.test.js agent/evals/*.test.js
node --env-file=.env --test agent/evals/quotes.test.js
```

The live suite runs the actual metadata triage, stub reads and passage model, then
stops before skill writing. The same OAuth goal runs three times. Each run must
return at least one quote and retain at least 90%; every emitted highlight is
independently checked against its source. Failures print complete model outputs.
No keys are printed. The live cases skip explicitly without credentials.

Observed fresh batch: 8/8, 7/7 and 8/8 quotes survived, with 6, 6 and 7 reads.
All 34 deterministic tests passed; the offline CLI also completed with blocked
and throwing reads. Browser DOM highlighting itself remains extension-owned.

Decisions made for K3:

- Select from actual read snapshots, not list metadata or unread stub text. Run
  selection after each read batch, before the continuing tool model. Reject a
  same-batch write_skill until the pending reads have passed selection.
- Verify exact substrings first, then normalized matching with offsets back into
  original UTF-16 text. Normalization changes only whitespace, specified Unicode
  punctuation and zero-width characters. No edit distance or fuzzy matching.
- Prefix repair requires a unique full 60-character normalized anchor. Short or
  ambiguous anchors are dropped. Extend to a simple punctuation sentence boundary;
  abbreviations are not parsed. Any repair still returns a contiguous source span.
- Permit one JSON/schema correction turn; quote failures themselves are dropped
  without another model request. Selection turns count toward the existing 20-turn
  budget. Allow 8192 output tokens for multi-tab quotes.
- Blocked/error/empty sources bypass the passage model. Every readable supplied tab
  needs 1–4 passages or an empty reason. Retain raw outputs and failed quote
  diagnostics in passageSelections for evals, never in the continuing conversation
  or highlight payloads. Only sanitized verified passages feed those consumers.
- Add a small passages.js helper for prompt loading and validation. Inject
  passageModel/onHighlight for tests and transport. stopAfterPassages lets evals
  exercise K3 without creating or invoking skill output.
- The shared message constants specify no HIGHLIGHT payload schema, so the adapter
  sends { tabId, quotes: string[] }; document this in the browser handoff. The
  extension must still implement routing and highlighting. No shared shapes changed.

# K5 loose match and gap-fill

```sh
node --test agent/evals/loose.test.js
node --env-file=.env --test agent/evals/loose.test.js
AGENT_MODE=loose node agent/run-local.js --live "your situation"
```

Host callers can set `mode: "tight" | "loose"`. Tight is the default; the CLI
can select loose through AGENT_MODE without an extension/UI change. The tight
passage prompt and metadata triage implementation remain unchanged. Loose
selection uses all successfully read snapshots whenever new reads arrive, so the
three-rhyme maximum applies to the whole selected set, not each batch. Its quotes
use the same verifier. Age is elapsed months (30.4375 days per month), never guessed
for a null date. Connection quality remains model judgment; no poetry heuristics
are used in production code.

Coverage is a separate JSON model turn from prompts/gaps.md, after verified tight
passages and before continuation. The host emits each missing-coverage note before
executing its synthetic web_search call. At most two searches run, including
failed/stub attempts; duplicate queries are skipped. Direct model web_search calls
receive recoverable errors instead of bypassing the coverage gate. More than two
proposed gaps are truncated with a note. One malformed JSON/schema correction is
allowed and counts toward the 20-turn budget.

Exa's existing HTTP client already requested highlights, so it was reused. The
ENABLE_EXA=1 flag remains required alongside the key. Missing configuration returns
marked stub results and an explicit unavailable note. Web excerpts are not sent to
the tab highlighter: there is no page read snapshot to verify against. They retain
source:web and firstVisit:null in tool replies, passage collections, subsequent
model context, and matching final source citations. Tab passages carry source:tab.
These are agent-owned evidence fields; shared tab/trace shapes and the skill writer
implementation are unchanged.

Live results: the isolated loose selector chose old tab 485 in 3/3 runs, with
explicit mechanisms. The full unchanged-triage pipeline chose it in 2/3 runs. The
miss selected OAuth tabs before loose selection; this is the previously identified
triage limitation, not hidden by changing the prompt or forcing a tab into the set.
A goal requesting an unavailable exact SHA-256 digest returned none. A real partial
coverage run named the Keychain gap first, made one Exa search and retained ten web
passages. Another complete live capture used both allowed searches.

# K6 replay

See ../RECORD-REPLAY.md for one-line switching, fixture limitations and the outstanding
literal Wi-Fi-off acceptance test. Five replay tests pass, including byte-identical
consumer messages with process network APIs disabled. The full offline regression
suite now has 45 passing tests; ten live-only cases skip without credentials.

## Goal-drift guardrail follow-up

A subsequent user-run K5 suite failed full loose acceptance (old tab 485 in only
1/3 runs). Two runs inferred an OAuth task from the dominant tab cluster despite
the supplied community-kitchen goal. Goal interpolation was correct.

Applied the requested prompt-only change in prompts/triage.md: the stated goal is
authoritative, unrelated group size is not evidence of that goal, and selecting
one tab or none is legitimate. The group heuristic is now explicitly conditional
on matching the goal. No selection code, fixtures, or acceptance thresholds changed.

Fresh combined live loose/triage batch: 22/23 tests passed. The full loose pipeline
opened only tab 485 in all three runs (3/3); isolated loose selection also found it
3/3, the no-rhyme case returned none, and live gap-fill retained its required order.
Tight triage passed 2/3: its third run initially selected duplicate RFC views; the
single correction removed that duplicate but introduced ID 481 in both open and
skip. The validator rejected it loudly. This remains a distinct model-contract
failure; the combined live suite is not fully green. All 45 deterministic tests
still pass. These small batches do not establish general reliability.

## Duplicate-ID correction fix

The validator now reports all detected repeated IDs, missing IDs, duplicate open
URLs and reason errors together, rather than stopping at the first repeated ID.
The one permitted correction receives the authoritative goal and complete ID
inventory, then explicit instructions to finalize open and construct skip from
its complement. No conflicting choice is silently deleted or reassigned. The
initial triage prompt explains the same partition rule. A repeated ID remaining
after correction still fails before any reads.

Added regressions for combined partition/document errors and the exact observed
failure (fix RFC duplication but introduce tab 481 into both lists). Added a live
case that deliberately supplies duplicate RFC views on the first turn and calls
OpenRouter for the single correction; it returned 3 open and 17 skip with no overlap.

Fresh combined live batch: 25/25 tests passed, including tight triage 3/3 and full
loose pipeline 3/3. The separately run forced live correction also passed. The
47 deterministic tests passed before the live runs. No acceptance threshold was
relaxed and no extra model retry was added. These observed passes do not guarantee
that future model responses will always satisfy the contract.
