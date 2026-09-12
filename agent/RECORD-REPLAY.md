# Record and replay

From the repository root, with credentials already in the ignored `.env`:

```sh
RECORD=1 ENABLE_EXA=1 node agent/run-local.js --live "your demo goal"
REPLAY=1 REPLAY_SPEED=4 node agent/run-local.js "your demo goal"
```

RECORD defaults off. REPLAY defaults off. Set only one to 1; enabling both is an
error. REPLAY_SPEED is a positive speed multiplier (1 preserves recorded timing,
4 runs four times faster). The recorded goal is authoritative during replay.
The current CLI's startup banner predates replay; network behavior is controlled
inside host.js. No extension or replay-specific consumer changes are required.

Recording writes `agent/fixtures/golden-run.json` atomically after a complete run.
Failed or partial runs preserve an existing golden file and report an error. The
JSON header explains tab requirements. It contains timestamped model responses,
tool calls/results, trace events, highlight payloads and the completed result.
Credentials and model requests/HTTP headers are not serialized.

Replay validates the fixture, enumerates current tab metadata, and rejects missing
IDs or changed URLs before emitting any recorded output. It never reads pages or
calls a model/search. Trace timestamps and payload bytes are retained; delivery
intervals are scaled. It uses the same validated trace callback and injected
highlight callback as a live run. The existing message adapter emits TRACE,
HIGHLIGHT and the final SKILL using its unchanged serializer path.

## Captured fixture and browser handoff

The checked-in-path fixture currently captures a **live model run over StubTabSource**:
OAuth device polling, slow_down handling, and macOS Keychain storage. It completed
with 6 reads, 2 Exa searches and 5 model turns. This proves recording/replay plumbing;
it is not a capture of the user's Chrome tabs and is not stage-ready insurance.

Before the demo, run the actual browser-connected host with RECORD=1 against the
same Chrome profile and exact tabs used on stage. Then leave those tabs open and
on the same URLs. Reopening a tab changes its ID. The fixture's text refers to the
recorded snapshot; DOM changes can still break matching even if a URL is unchanged.
Supply the same skill serializer in both runs. The browser owner still needs to
connect tab RPC and route HIGHLIGHT; this task does not implement the extension.

## Tests

```sh
node --test agent/evals/replay.test.js
```

Tests cover complete capture, equal consumer bytes, timing scale, zero model/page
read calls, missing IDs, changed URLs, malformed traces, conflicting flags, and
preserving golden data after a failed run. The captured live fixture also replays
with fetch, socket connect, TLS connect and HTTP(S) request APIs replaced by
throwing guards; there are zero network attempts.

Literal Wi-Fi-off acceptance is **not verified**. macOS rejected hardware-network
control with `AuthorizationCreate() failed: -60008`; an OS network-denial sandbox
also failed with `sandbox_apply: Operation not permitted`. API guards are not a
substitute for physical disconnection. On the demo machine, manually turn Wi-Fi
off, run the replay command, confirm completion/highlights, then restore Wi-Fi.
