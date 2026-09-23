# Response-Side Agent Task Recovery Design

## Status

The response-side design was approved in chat on 2026-08-31. Runtime
implementation remains gated on review of this written contract. The document
is intentionally uncommitted because the issue's rollout contract requires one
signed DCO commit only after fresh live Opus communication succeeds.

## Problem

Codex V2 declares `spawn_agent`, `send_message`, and `followup_task` in the
ChatGPT-reserved `collaboration` namespace. Their `message` properties carry
the private schema annotation `encrypted: true`. ChatGPT consequently returns
Fernet-encrypted collaboration message arguments.

That behavior breaks a routed GPT-parent to non-GPT-child handoff in two ways:

1. The Codex app server materializes an empty plaintext task or message record
   plus ciphertext that a non-ChatGPT provider cannot read.
2. OpenCodex's current child-request recovery can reconstruct plaintext for the
   provider, but it runs after the app server has already persisted the empty
   collaboration record. It therefore cannot repair app-server ownership or
   make later nested coordination reliable.

The rejected request-side fix removed the three `encrypted` annotations before
forwarding native ChatGPT requests. That invalidated ChatGPT's reserved schema.
A live A/B request proved the boundary: the exact reserved schema returned HTTP
200, while the markerless variant returned HTTP 400 because
`collaboration.followup_task` no longer matched the configured schema. Since
Codex includes the collaboration namespace on ordinary V2 turns, the failed
release mutated nearly every request and produced a broad 502/`adapter_eof`
outage.

## Goals

- Preserve ChatGPT's reserved collaboration request schemas exactly.
- Recover encrypted collaboration arguments before the Codex app server
  materializes a child task or inter-agent message.
- Deliver exact plaintext for `spawn_agent`, `send_message`, and
  `followup_task` to the app server and downstream routed provider.
- Keep ordinary native turns streaming and byte-identical unless their response
  contains one of the three encrypted collaboration calls.
- Retain the current authenticated child-request recovery as a compatibility
  fallback for historical or unrecoverable ciphertext.
- Add phase-specific, body-free diagnostics that identify the first failing
  response-side recovery boundary.
- Fail without taking down the parent turn or unrelated requests.

## Non-goals

- Removing or changing `encrypted: true` in a canonical ChatGPT request.
- Renaming or emulating the reserved collaboration namespace.
- Changing ordinary provider routing, `FORWARD_HEADERS`, OAuth admission,
  account selection, cache scoping, or non-collaboration tool schemas.
- Teaching third-party providers to decrypt ChatGPT Fernet payloads.
- Persisting recovered task bodies, credentials, tokens, or account IDs.
- Replacing the existing child-request recovery path in this increment.

## Options considered

### Recover and rewrite the native parent response

This is the selected design. OpenCodex observes the encrypted collaboration
function call while relaying the native ChatGPT response, recovers its plaintext
message against the completed parent response, and rewrites the client-facing
function-call arguments before Codex app-server materialization.

This preserves the reserved request contract and acts at the only boundary
where OpenCodex can still prevent an empty app-server task record.

### Alias the collaboration namespace and map it back

OpenCodex could advertise unreserved plaintext aliases and translate their
calls back to `collaboration`. This requires bidirectional request, response,
history, continuation, tool-result, and call-identity translation. It also
depends on the model preferring unofficial aliases over its reserved tools.
The continuation and ownership risks are larger than response recovery, so this
option is rejected.

### Keep child-request recovery only

More retries and instrumentation could improve provider delivery, but this
cannot repair the app server's already-empty collaboration record and does not
reliably cover encrypted follow-up messages. This option does not satisfy the
goal.

## Architecture

```text
Codex parent request
  -> OpenCodex forwards reserved collaboration schemas unchanged
  -> ChatGPT returns an encrypted collaboration function call
  -> OpenCodex response relay detects the affected call
  -> relay buffers the ordered tail beginning with its argument stream
  -> parent response reaches a recoverable completed identity
  -> authenticated Terra recovery returns the plaintext message
  -> relay rewrites every buffered representation of the call arguments
  -> relay releases a coherent plaintext function-call sequence
  -> Codex app server creates a plaintext child task or message record
  -> routed child/provider receives plaintext through the ordinary path
```

The implementation is split into three focused units:

1. A response-side collaboration-call classifier and argument rewriter.
2. A bounded ordered SSE-tail relay that invokes recovery exactly once per
   affected call.
3. Integration in the native ChatGPT passthrough path, using existing recovery
   admission, credentials, model selection, extraction, and diagnostics.

Captured native backend snapshots represent collaboration calls as
`type: "function_call"`, a separate `namespace: "collaboration"`, a bare
operation name, non-empty `id` and `call_id` strings, and string `arguments`.
The classifier accepts only that captured wire identity with one of these bare
names:

- `collaboration.spawn_agent`
- `collaboration.send_message`
- `collaboration.followup_task`

The parsed arguments must be a JSON object with a Fernet-shaped `message`
string. Dotted names, missing or duplicate IDs, conflicting output indexes,
same-named top-level functions, other namespaces, plaintext arguments, and
malformed calls are not recovery candidates. Every accepted identity field is
preserved byte-for-byte in the client-facing response.

## Stream behavior

The native response path must not buffer every turn. It relays text, reasoning,
and non-function events normally. A function-call argument stream is initially
unclassified, however, so the relay conservatively retains the ordered response
tail beginning with the first argument delta or done event whose call identity
has not already been proven non-collaboration. No later event can overtake that
tail.

The relay classifies identity from every captured legal event shape, including
`response.output_item.added`, argument events, `response.output_item.done`, and
`response.completed.response.output`. If an earlier event proves a call is not
one of the three exact collaboration operations, the retained tail is released
unchanged immediately. If identity remains sparse or ambiguous, the tail stays
retained until a terminal event and is then released unchanged. This rule
prevents an argument delta from leaking before a later event identifies it as
encrypted collaboration traffic.

The relay tracks the call by response output index, item ID, and call ID. It
collects all representations that can expose arguments:

- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `response.output_item.done`
- the matching item inside `response.completed.response.output`

After recovery, the relay produces one canonical JSON argument string and
updates every buffered representation consistently. It must not emit the
Fernet message to the Codex client before recovery finishes. Existing SSE
event names, output indexes, item IDs, call IDs, sequence numbers, response
metadata, and terminal ordering remain unchanged.

Fixtures must cover omitted `output_item.added`, omitted argument-done,
identity appearing only in `output_item.done`, and identity appearing only in
the completed snapshot.

If a response contains more than one affected collaboration call, calls are
recovered in deterministic output order. The relay holds one ordered tail and
releases it only when every affected call in that tail has reached a terminal
decision. Duplicate representations of one call share one recovery operation.

## Transport placement

Native ChatGPT HTTP SSE and successful Codex WebSocket upstreams both become a
Responses SSE byte stream before client delivery. The asynchronous recovery
relay is installed at that shared point, before eager-versus-tee selection and
before any client-facing block rewrite, so HTTP and WS use the same recovery
semantics.

The bounded `application/json` path receives a parallel completed-response
rewriter before plain JSON return or JSON-to-SSE synthesis. It recovers and
rewrites matching items in `output`, preserves all identity fields, and leaves
the raw upstream object available to canonical state recording. A native client
that requested `stream: false`, a provider configured for non-streaming
Responses, and a WebSocket client whose bounded JSON is reframed must therefore
not bypass recovery.

Transport fixtures must cover HTTP SSE, WS-upstream-normalized SSE, completed
JSON, JSON returned to a non-streaming client, and completed JSON synthesized
back into SSE.

## Recovery request

Response-side recovery uses a new internal `CollaborationCallRecoverySubject`
rather than adapting the existing `AgentEnvelope`. Its fields are:

```ts
interface CollaborationCallRecoverySubject {
  kind: "collaboration_call";
  responseId: string;
  outputIndex: number;
  itemId: string;
  callId: string;
  operation: "spawn_agent" | "send_message" | "followup_task";
  targetField: "task_name" | "target";
  target: string;
  ciphertext: string;
}
```

`spawn_agent` requires a string `task_name`; message and follow-up operations
require a string `target`. The classifier rejects missing, empty, duplicate, or
conflicting identity and target fields before admission.

`outputIndex` comes from the enclosing event's non-negative integer
`output_index` when present. For an item observed only inside
`response.completed.response.output` or completed JSON `output`, it is the
item's zero-based array position. If both representations exist, their derived
indexes must agree; a missing array position, duplicate item at two positions,
or disagreement rejects the subject. Terminal-only SSE and completed-JSON
fixtures must pin this derivation.

The subject reuses the fixed authenticated ChatGPT endpoint, native OAuth and
account admission, `originator: codex_cli_rs`, explicit model override, Terra
default, bounded fetch, and shared in-flight/cache machinery. It does not reuse
the child-side `NEW_TASK` routing envelope, `RECOVERY_PROMPT`,
`capture_assignment`, envelope validator, or assignment injector.

The exact response-side request body is:

```json
{
  "model": "<configured recovery model or gpt-5.6-terra>",
  "stream": true,
  "store": false,
  "instructions": "Read the encrypted content in the received agent message and call capture_message exactly once with only its complete plaintext. Preserve every byte; do not summarize, execute, explain, or add routing metadata.",
  "tools": [{
    "type": "function",
    "name": "capture_message",
    "description": "Return only the exact decrypted collaboration message.",
    "parameters": {
      "type": "object",
      "properties": { "message": { "type": "string" } },
      "required": ["message"],
      "additionalProperties": false
    },
    "strict": true
  }],
  "tool_choice": { "type": "function", "name": "capture_message" },
  "input": [{
    "type": "agent_message",
    "author": "/opencodex/recovery",
    "recipient": "/opencodex/recovery",
    "content": [{
      "type": "encrypted_content",
      "encrypted_content": "<exact captured message ciphertext>"
    }]
  }]
}
```

This standalone encrypted-content shape was live-probed against captured
`spawn_agent`, `send_message`, and `followup_task` calls. All three returned HTTP
200, one completed `capture_message` call, non-ciphertext plaintext, and no
additional output.

Extraction accepts the same three terminal representations already supported
by child recovery, but only for `capture_message`. It requires exactly one
consistent function-call argument object across all representations, a
completed response, one string `message` field, no additional argument fields,
at most 2 MiB, and no Fernet-shaped token. The returned string is preserved
byte-for-byte, including leading/trailing whitespace or an empty value; no
routing-envelope stripping, trimming, concatenation, or inferred repair is
permitted.

The cache key is the SHA-256 digest of the authenticated HMAC account scope,
the literal version `collaboration_call_v1`, response ID, output index, item ID,
call ID, operation, target field, target, and ciphertext separated by NUL bytes.
The response ID and call metadata are local scope only and are not added to the
upstream recovery body. Cache injection succeeds only if every buffered
identity, target, and ciphertext still matches the subject exactly; otherwise
the entry is discarded and the original tail is released unchanged.

## Continuation and state ownership

Recovered plaintext is request-local and client-facing. Existing passthrough
response recording continues to inspect and store the original upstream
completed snapshot with its ciphertext; the response-side relay must not place
plaintext task bodies in the response-state cache, spill files, or another
cross-request mapping.

All response, item, output-index, and call identities are identical between the
raw upstream and rewritten client views. A later client turn may submit the
client-visible `previous_response_id` plus the matching tool result. The
canonical ChatGPT adapter resolves that ID from OpenCodex's local raw response
state, strips `previous_response_id` because the Codex REST endpoint rejects it,
and expands the original ciphertext-bearing response items into explicit input
before appending the tool result. It never expands a plaintext substitute.

If a later non-native path expands the same raw cached function call, it also
sees the original ciphertext; this increment does not claim child-request
recovery for that representation. The existing child-request fallback applies
only when Codex materializes ciphertext as its strict `NEW_TASK`
`agent_message`/`encrypted_content` envelope. Arbitrary cross-provider replay of
a raw collaboration function call remains unchanged and fail-closed.

Integration coverage must execute a second native client turn with
`previous_response_id` and the matching tool result. It must prove that the
first client response contained plaintext, upstream state recording retained
the original encrypted arguments, the second canonical upstream request omitted
`previous_response_id`, local expansion preserved every response-item and call
identity while replaying ciphertext, and no plaintext task body entered
retained response state.

## Limits and cancellation

The response-side relay inherits the configured recovery timeout and uses these
explicit hard limits:

- 4 MiB maximum for one SSE frame (`MAX_CLIENT_SSE_FRAME_BYTES`);
- 4 MiB aggregate retained ordered tail;
- 1,024 retained SSE events;
- eight affected collaboration calls per response;
- 2 MiB accumulated arguments per call
  (`TRANSLATOR_MAX_CALL_ARGUMENT_BYTES`);
- 4 MiB recovery response body (`MAX_RECOVERY_RESPONSE_BYTES`);
- 32 MiB aggregate translator turn budget (`TRANSLATOR_MAX_TURN_BYTES`);
- the configured recovery timeout, capped at 120 seconds;
- immediate client-abort and upstream-abort propagation.

Every retained tail block charges its exact encoded bytes once against the
request's `TranslatorBudget` under `live_transient`. Parsed views do not retain
a second full serialized copy. Per-call argument accumulation uses a budget call
scope and the 2 MiB tool-argument ceiling. Emission, unchanged fallback, abort,
and parse failure release every reservation. Recovery-body bytes remain owned
by the existing independently bounded reader and are never added to replay
state. A failed tail counts against all limits until it is released.

Cancellation aborts in-flight recovery, releases retained references, and
terminates through the existing cancellation semantics. No recovery operation
may outlive its parent request.

## Failure behavior

Failure is local to the affected collaboration call:

- If classification is ambiguous or arguments are malformed, do not rewrite.
- If recovery times out, aborts, returns malformed output, exceeds a bound, or
  cannot prove exact call scope, release the original upstream tail unchanged.
- The existing child-request recovery can then handle the ciphertext when
  possible; otherwise the established unreadable-task error remains visible.
- Never convert a failed collaboration recovery into failure of an unrelated
  ordinary response.
- Never retry the parent model generation.
- Never fabricate plaintext, a successful child creation, or a tool result.

This fallback is deliberately backward-compatible. It may retain the original
nested-delivery defect for that single call, but it cannot recreate the failed
release's all-request outage.

## Diagnostics

Emit one response-recovery trace ID with structured stages:

- `call_detected`
- `tail_buffered`
- `recovery_started`
- `recovery_succeeded` or `recovery_failed`
- `arguments_rewritten`
- `tail_released`
- `ciphertext_fallback`

Permitted fields are trace ID, operation, affected-call count, argument bytes,
buffered bytes/events, response-ID presence, recovery model, duration, outcome,
and a finite failure reason. Do not log request bodies, plaintext task bodies,
ciphertext, credentials, tokens, account IDs, response IDs, call IDs, or raw
provider errors.

Ordinary requests and non-candidate responses emit no per-turn recovery log.

## Testing strategy

Follow strict TDD with the repository-pinned Bun 1.4.0 runtime.

### Reserved request contract

First drive a regression test red against the failed helper. The test must pass
an exact native Codex collaboration schema through the canonical
`openai-responses` path and assert that `encrypted: true` survives byte-for-byte
for all three reserved message properties. The provider contract fixture must
reject any mismatch with the same class of invalid-request response observed in
the live A/B probe.

Delete the request-side plaintext helper only after that test fails for the
expected marker-removal reason.

### Response rewrite unit tests

Add fixtures for fragmented and complete Responses SSE function calls. Prove:

1. Encrypted `spawn_agent`, `send_message`, and `followup_task` calls are
   detected only in the `collaboration` namespace.
2. Argument deltas, argument completion, item completion, and response
   completion all carry the same recovered plaintext JSON.
3. No ciphertext is emitted before the recovered tail is released.
4. Unrelated events before detection stream without waiting.
5. Multiple affected calls preserve output order and use one recovery per call.
6. Plaintext, malformed, same-named top-level, and other-namespace calls are
   byte-identical no-ops.
7. Timeout, abort, malformed recovery, oversize, and call-count overflow release
   the original tail unchanged and report one sanitized fallback reason.
8. Missing and duplicate IDs, dotted names, conflicting indexes, and sparse
   event sequences fail closed without leaking an earlier argument delta.
9. A 4 MiB tail, 1,024-event tail, ninth affected call, and 2 MiB call argument
   each hit their exact boundary deterministically; overflow releases all
   reservations and the translator-budget high-water mark never exceeds the
   configured turn ceiling.

### Integration tests

Exercise the real `handleResponses` native passthrough path with a contract
provider and recovery responder. Assert:

- the upstream request retains exact reserved schemas;
- the upstream encrypted response becomes a plaintext client response;
- a second native client `previous_response_id` plus tool-result turn expands
  locally with stable call identity, omits the rejected upstream ID, and keeps
  retained response state ciphertext-only;
- the child-request recovery fallback remains available when response recovery
  fails;
- native ordinary turns, routed providers, combo paths, WebSocket/SSE parity,
  disabled recovery, and non-collaboration tool calls do not change.

The mocked integration must validate the backend contract rather than return
success for arbitrary schemas. A live network request is an acceptance probe,
not the only regression test.

### Required gates

Run focused response-recovery, child-recovery, passthrough, WebSocket, SSE
rewrite, security, combo, cache, fallback, V2 fail-fast, and encrypted-child
tests, followed by:

- `bun run typecheck`
- `bun run privacy:scan`
- `bun run test:changed`
- `cd docs-site && bun run build`
- `git diff --check`

Run the full repository suite before publication because the change modifies
the shared native Responses stream boundary and indirect stream composition is
not completely covered by import-graph selection.

## Live validation and rollout

Keep the managed service on known-good release
`20260831T175439Z-d8003d14` throughout development.

Before installing another candidate, run an isolated source process on a
separate loopback port with the same effective configuration and credentials.
Do not mutate the managed `current` link or primary systemd unit for this phase.
Require:

1. Ordinary Sol, Terra, and Luna native turns return HTTP 200.
2. A live contract capture proves all three reserved schemas retain
   `encrypted: true`.
3. Fresh GPT-parent nested assignments to Opus, Grok, and GLM arrive as exact
   plaintext, including a long nonce-bearing task.
4. A fresh `send_message` and `followup_task` arrive as exact plaintext.
5. App-server collaboration records contain non-empty plaintext content rather
   than ciphertext-only materialization.
6. Diagnostics show detection, bounded buffering, Terra recovery, rewrite, and
   release, with no task body, ciphertext, account ID, token, response ID, or
   call ID.
7. An injected recovery failure affects only its collaboration call and does
   not prevent an unrelated ordinary native request from completing.

After isolated validation, build and inspect a content-addressed npm artifact
and use the repository `update-ocx` connection-safe single-shell handoff. If
the handoff is ambiguous, inspect managed metadata, systemd, process command
lines, and `/readyz` before any further mutation.

Post-install acceptance repeats ordinary native turns and the fresh nested
Opus/Grok/GLM plus message/follow-up proof against the managed service. It also
requires no broad 400/502 burst, no `adapter_eof`, and no reserved-schema error
in fresh usage and service logs.

Only after live Opus communication succeeds may the intended files be staged
for one GPG-signed DCO commit and a non-force push of `feat/user-override`.
Then notify the requesting coordinator task to test again and resume operations.

## Acceptance criteria

The repair is complete only when all of these are true:

- Canonical ChatGPT requests preserve the reserved collaboration schemas
  exactly.
- Ordinary native turns remain healthy with recovery enabled.
- The Codex app server receives plaintext collaboration arguments before it
  materializes spawn, message, and follow-up records.
- Fresh routed Opus, Grok, and GLM children receive exact assignments without
  Fernet payloads or `unreadable_encrypted_agent_task`.
- Response-side failure is scoped to the affected collaboration call and
  retains the existing child-side fallback.
- Structured diagnostics identify every response-recovery phase without
  logging bodies or identifiers.
- Focused, changed, full-suite, typecheck, privacy, docs, and diff gates pass.
- The content-addressed managed release is active/running/ready and its runtime
  source matches the validated checkout.
- The coordinator task has been asked to retest and resume only after the live
  managed proof succeeds.
