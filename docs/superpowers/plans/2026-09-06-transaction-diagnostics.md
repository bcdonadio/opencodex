# Transaction Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, durable, privacy-safe request/attempt/send diagnostics and a sanitized support export without changing inference behavior.

**Architecture:** Preserve `usage.jsonl` as the only durable authority. Existing request-log fields stay canonical; an additive `diagnostics` envelope owns new lifecycle, correlation, shape, wire, error, availability, and persistence evidence, while attempts gain bounded send records. Capture hooks are non-throwing and support export constructs a fresh allowlisted object from normalized canonical rows.

**Tech Stack:** Bun 1.4.0, strict TypeScript, Bun test, React/Vite dashboard, Astro/Starlight docs.

**Spec:** `docs/superpowers/specs/2026-09-06-transaction-diagnostics-design.md`

## Global Constraints

- Do not stop, restart, replace, or probe the active production `opencodex-proxy`; use synthetic fixtures and isolated `OPENCODEX_HOME` directories.
- Do not add dependencies. If that becomes unavoidable, stop before adding one because Socket scoring, exact pinning, and cryptographic verification are mandatory.
- Never retain raw request/response bodies, prompts, instructions, tool schemas/arguments/results, source code, attachment content, encrypted blobs, hidden reasoning, credentials, cookies, auth headers, raw account/org/project IDs, full URLs, local paths, argv, or environment dumps.
- Every external value is allowlisted, bounded, control-character stripped, and secret-redacted before persistence. Logging/diagnostic failures never alter routing, retries, response status/body, cancellation, or inference.
- Preserve absent, unsupported, not observed, redacted, truncated, and unknown as distinct states; never infer policy triggers, entitlement, model confirmation, upstream IDs, or billed usage.
- Keep `usage.jsonl` authoritative. `routing-history.sqlite` remains a rebuildable projection and `/api/logs` remains a bounded operational ring.
- All commits use `--signoff`, a subject no longer than 50 characters, and a hard-wrapped explanatory body.

---

### Task 1: Versioned diagnostics schema and durable round trip

**Files:**
- Create: `src/diagnostics/transaction.ts`
- Create: `tests/usage/transaction-diagnostics.test.ts`
- Modify: `src/usage/log.ts`
- Modify: `src/server/request-log.ts`
- Modify: `scripts/test-layout/layout.json`
- Modify: `tests/fixtures/test-layout-expected.json`

**Interfaces:**
- Produces: `TransactionDiagnosticsV1`, `DiagnosticSendV1`, `createTransactionDiagnostics()`, `normalizeTransactionDiagnostics()`, `recordDiagnosticEvent()`, `beginDiagnosticSend()`, `finishDiagnosticSend()`, and `sanitizeDiagnosticIdentifier()`.
- Produces: optional `diagnostics` on `RequestLogContext`, `RequestLogEntry`, and `PersistedUsageEntry`; optional `attemptId`, `attemptStartedAt`, `attemptEndedAt`, `upstreamTransport`, and `sends` on `PersistedUsageAttempt`.
- Preserves: existing top-level request/attempt fields and old-row compatibility.

- [ ] **Step 1: Write schema and round-trip tests that fail because the module and fields do not exist**

```ts
const diagnostics = createTransactionDiagnostics({
  requestId: "ocx-test",
  receivedAt: 1_000,
  proxyVersion: "2.43.0",
  inboundProtocol: "responses",
  inboundTransport: "websocket",
});
recordDiagnosticEvent(diagnostics, { type: "response.created", at: 1_010, source: "upstream", responseId: "resp_test" });
expect(normalizeTransactionDiagnostics(diagnostics)).toMatchObject({
  schemaVersion: 1,
  diagnosticCaptureVersion: 1,
  recordKind: "request",
  receivedAt: 1_000,
  responseCreatedAt: 1_010,
  upstreamResponseId: "resp_test",
});
```

Assert a complete `appendUsageEntry` → `readUsageEntries` →
`requestLogEntryFromPersistedUsage` round trip, legacy rows without diagnostics,
invalid enum/member dropping, event/send bounds, UTF-8 byte caps, and direct
`addRequestLog` sanitization. Include regression assertions that `apiKeyId`,
`admissionKind`, `inboundProtocol`, `localTerminalReason`, `affinity`,
`transportPhase`, `terminalSource`, and successful terminal metadata survive reload.

- [ ] **Step 2: Run the focused tests and confirm the missing-module/field failures**

Run: `bun test tests/usage/transaction-diagnostics.test.ts tests/usage/request-log.test.ts tests/usage/usage-log.test.ts`

Expected: failure caused by missing transaction diagnostics exports and durable fields.

- [ ] **Step 3: Implement the pure bounded schema and normalization**

```ts
export const TRANSACTION_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_CAPTURE_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_EVENTS = 64;
export const MAX_DIAGNOSTIC_SENDS = 16;
export const MAX_DIAGNOSTIC_ID_BYTES = 256;
export const MAX_DIAGNOSTIC_ERROR_BYTES = 500;

export interface TransactionDiagnosticsV1 {
  schemaVersion: 1;
  diagnosticCaptureVersion: 1;
  transactionId: string;
  recordKind: "request";
  correlationSource: "proxy" | "client" | "upstream" | "mixed";
  correlationConfidence: "direct" | "derived" | "unknown";
  receivedAt: number;
  timestampSource: "proxy_wall_clock";
  events: DiagnosticEventV1[];
  fieldAvailability: Record<string, DiagnosticAvailabilityV1>;
  droppedDiagnosticEventCount: number;
  captureTruncated: boolean;
  redactionApplied: boolean;
  redactionVersion: 1;
  retentionClass: "usage_ledger";
  [supportedOptionalField: string]: unknown;
}
```

Use explicit builders/normalizers and closed allowlists rather than spreading
untrusted objects. Generate `transactionId`, `attemptId`, and `sendId` with random
proxy IDs. Preserve first and terminal events when event/send caps are reached.

- [ ] **Step 4: Wire the envelope through every persistence projection**

Add typed fields in `src/usage/log.ts`; normalize each nested object; include the
envelope and repaired legacy fields in `addFinalRequestLog`, `addRequestLog`, and
`requestLogEntryFromPersistedUsage`. Persist successful terminal metadata, not only
failures. Defensively sanitize `upstreamError` in the normalizer.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun test tests/usage/transaction-diagnostics.test.ts tests/usage/request-log.test.ts tests/usage/usage-log.test.ts tests/usage/usage-failure-persistence.test.ts`

Run: `bun run typecheck`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/diagnostics/transaction.ts src/usage/log.ts src/server/request-log.ts tests/usage/transaction-diagnostics.test.ts tests/usage/request-log.test.ts tests/usage/usage-log.test.ts scripts/test-layout/layout.json tests/fixtures/test-layout-expected.json
git commit --signoff -m "feat: persist transaction diagnostics" -m "Add one bounded versioned diagnostics envelope and preserve request, attempt, send, terminal, and availability facts through JSONL normalization and restart hydration.\n\nOld rows remain readable and all externally derived metadata is defensively sanitized before retention."
```

### Task 2: HTTP, SSE, and WebSocket lifecycle capture

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/request-log.ts`
- Modify: `src/server/relay.ts`
- Modify: `src/server/ws-bridge.ts`
- Modify: `src/server/responses/core.ts`
- Modify: `src/server/responses/fetch-helpers.ts`
- Modify: `src/server/responses/codex-ws-correlation.ts`
- Modify: `src/server/responses/codex-ws-exchange.ts`
- Modify: `src/server/responses/codex-ws-session.ts`
- Modify: `src/server/responses/ws-upstream.ts`
- Modify: `src/server/chat-native.ts`
- Modify: `src/server/images.ts`
- Modify: `src/server/live.ts`
- Modify: `src/server/search.ts`
- Modify: `src/server/responses/compact.ts`
- Test: `tests/responses/ws-endpoint.test.ts`
- Test: `tests/responses/ws-upstream.test.ts`
- Test: `tests/responses/ws-upstream-reuse.test.ts`
- Test: `tests/responses/sse-failed-tail.test.ts`
- Test: `tests/server/relay-eager.test.ts`

**Interfaces:**
- Consumes: Task 1 diagnostics accumulator and send helpers.
- Produces: `observeRequestTransport()`, `recordRequestShape()`, `recordForwardedRequest()`, `recordUpstreamResponse()`, and protocol-event observations used by every Responses transport.

- [ ] **Step 1: Write failing protocol tests**

Use synthetic streams and socket fixtures to assert:

```ts
expect(log.status).toBe(400);
expect(log.diagnostics?.httpStatus).toBe(200);
expect(log.diagnostics?.terminalMappedStatus).toBe(400);
expect(log.diagnostics?.upstreamResponseId).toBe("resp_policy");
expect(log.diagnostics?.outputDeliveredBeforeFailure).toBe(true);
expect(log.usageStatus).toBe("unreported");
```

Also cover failure without usage/response ID, multiple responses per inbound/upstream
socket, pre-open WS fallback versus post-send failure, ordinary `error` versus
`response.failed`, cancellation/disconnect/incomplete, out-of-order/duplicate
terminals, connection reuse/generation/sequence, settings/model/account changes,
and observer exceptions that leave client bytes/status unchanged.

- [ ] **Step 2: Run focused tests and confirm diagnostics assertions fail**

Run: `bun test tests/responses/ws-endpoint.test.ts tests/responses/ws-upstream.test.ts tests/responses/ws-upstream-reuse.test.ts tests/responses/sse-failed-tail.test.ts tests/server/relay-eager.test.ts`

- [ ] **Step 3: Capture ingress and safe request shape**

At HTTP/WS request creation, stamp `inboundTransport`, endpoint class, method,
originator, client request ID, explicit allowlisted `client_metadata.thread_id` and
`turn_id`, previous-response IDs, request options, and bounded shape counts. Keep
the existing hashed `conversationId` separate. For WS, generate one connection ID
per accepted socket and increment `requestSequenceOnConnection` per create frame.

- [ ] **Step 4: Capture each physical send without changing admission semantics**

Immediately around actual HTTP fetch or WS send, begin/finish a bounded send record.
Record forwarded body byte size and parsed scalar/count facts, actual provider/model/
account/effort/tier snapshot, transport, endpoint class, retry/recovery reason, and
whether the send occurred. Do not catch or reinterpret admission/auth exceptions.

- [ ] **Step 5: Capture response headers and protocol lifecycle centrally**

Capture real HTTP status/content type and only `x-request-id`,
`openai-request-id`, `x-ratelimit-*`, and already-bounded Codex metadata. Extend the
shared SSE/WS parsed-event hook to record response-created IDs/timestamps, event
sequence/type/count/bytes, output type counts, response model/tier/effort, terminal
event/source, structured error fields, usage provenance, and duplicate/mismatch
facts. Preserve the first error and response-created ID even when no usage follows.

- [ ] **Step 6: Capture downstream terminal/close and compute derived timings**

Stamp terminal delivery, close, finalize, and monotonic durations. Distinguish real
upstream terminal, HTTP non-2xx, WS open/send/close, client cancellation, body stall/
overflow, and synthetic EOF. Mark derived status/timing fields explicitly.

- [ ] **Step 7: Run protocol, persistence, and type checks**

Run: `bun test tests/responses/ws-endpoint.test.ts tests/responses/ws-upstream.test.ts tests/responses/ws-upstream-reuse.test.ts tests/responses/sse-failed-tail.test.ts tests/server/relay-eager.test.ts tests/usage/transaction-diagnostics.test.ts tests/usage/request-log.test.ts`

Run: `bun run typecheck`

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/server src/diagnostics tests/responses tests/server tests/usage
git commit --signoff -m "feat: capture transport lifecycle" -m "Record explicit HTTP, SSE, and WebSocket lifecycle, correlation, status, response, retry, and bounded request-shape evidence at the protocol boundaries that actually expose it.\n\nObservers remain best-effort and do not change admission, routing, fallback, cancellation, or response delivery."
```

### Task 3: Sanitized support export API and CLI

**Files:**
- Create: `src/diagnostics/support-export.ts`
- Create: `tests/usage/support-export.test.ts`
- Modify: `src/server/management/request-history-routes.ts`
- Modify: `src/server/management/route-registry.ts`
- Modify: `src/cli/observe.ts`
- Modify: `src/cli/capabilities.ts`
- Modify: `src/cli/registry.ts`
- Modify: `src/cli/help.ts`
- Test: `tests/usage/request-history-index.test.ts`
- Test: `tests/cli/cli-usage-report.test.ts`
- Test: `tests/cli/cli-capabilities.test.ts`

**Interfaces:**
- Consumes: normalized canonical usage entries from `readUsageEntriesForManagement()`.
- Produces: `buildSupportExport(selection, entries, options): TransactionSupportExportV1`.
- Produces: `GET /api/transaction-diagnostics/export` and `ocx logs export`.

- [ ] **Step 1: Write failing exporter, API, and CLI tests**

```ts
const bundle = buildSupportExport(
  { requestIds: ["ocx-policy"] },
  [syntheticPolicyEntry],
  { generatedAt: 2_000, pseudonymKey: new Uint8Array(32) },
);
expect(bundle.exportSchemaVersion).toBe(1);
expect(bundle.records).toHaveLength(1);
expect(JSON.stringify(bundle)).not.toContain("Bearer secret");
expect(bundle.unavailableFields).toContain("policyEventId");
```

Cover at most 32 IDs, 24-hour window, 2,000 rows, 8 MiB output, deterministic
per-export pseudonyms, selection gaps, old rows, adversarial error/header metadata,
query-bearing URLs, local paths, unknown fields, explicit truncation/completeness,
and no reads from routing-history SQLite.

- [ ] **Step 2: Run focused tests and confirm missing exports/routes fail**

Run: `bun test tests/usage/support-export.test.ts tests/usage/request-history-index.test.ts tests/cli/cli-usage-report.test.ts tests/cli/cli-capabilities.test.ts`

- [ ] **Step 3: Implement allowlisted exporter**

```ts
export const SUPPORT_EXPORT_MAX_REQUEST_IDS = 32;
export const SUPPORT_EXPORT_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SUPPORT_EXPORT_MAX_RECORDS = 2_000;
export const SUPPORT_EXPORT_MAX_BYTES = 8 * 1024 * 1024;

export type SupportExportSelection =
  | { requestIds: readonly string[] }
  | { from: number; to: number };
```

Construct records field-by-field. Re-pseudonymize private correlation/account IDs
with a random per-export HMAC key that is never emitted. Retain proxy-local bundle
IDs. Add coverage, gaps, unavailable fields, redaction/truncation versions, and the
two explicit related issue URLs.

- [ ] **Step 4: Add authenticated management route**

Parse repeated `requestId` or exact `from`/`to`; reject mixed/empty/invalid/out-of-
range selection. Read normalized canonical rows and return JSON with download-safe
headers. Register the route; do not expose a caller-supplied filesystem path.

- [ ] **Step 5: Add CLI command and explicit write semantics**

Implement `ocx logs export --request <id>` (repeatable) or `--from <ms> --to <ms>`.
Default to JSON stdout. `--out <path>` writes only explicitly, uses exclusive create,
and requires `--force` to replace. Never print the management token or log path.

- [ ] **Step 6: Run focused tests, regenerate the capability surface, and typecheck**

Run: `bun run skill:surface`

Run: `bun test tests/usage/support-export.test.ts tests/usage/request-history-index.test.ts tests/cli/cli-usage-report.test.ts tests/cli/cli-capabilities.test.ts tests/ci-workflows/skill-ocx.test.ts`

Run: `bun run typecheck`

Expected: all pass and generated skill surface is synchronized.

- [ ] **Step 7: Commit**

```bash
git add src/diagnostics/support-export.ts src/server/management src/cli skills/ocx tests/usage/support-export.test.ts tests/usage/request-history-index.test.ts tests/cli tests/ci-workflows/skill-ocx.test.ts scripts/test-layout/layout.json tests/fixtures/test-layout-expected.json
git commit --signoff -m "feat: export support diagnostics" -m "Add a bounded authenticated export over normalized usage-ledger rows and expose it through ocx logs without consulting the derived history index.\n\nThe bundle is allowlisted, consistently re-pseudonymized, size bounded, and never published automatically."
```

### Task 4: Dashboard diagnostics details and export

**Files:**
- Modify: `gui/src/pages/Logs.tsx`
- Modify: `gui/src/api.ts` or the existing Logs fetch owner used by `Logs.tsx`
- Modify: every `gui/src/i18n/*.ts` locale catalog
- Modify: `gui/src/styles.css`
- Test: `gui/tests/logs-auto-refresh.test.tsx`
- Test: `gui/tests/locale-parity.test.ts`

**Interfaces:**
- Consumes: diagnostics fields already present in the `/api/logs` DTO and the support-export API.
- Produces: compact expandable Diagnostics section and explicit selected-request bundle download.

- [ ] **Step 1: Write failing GUI tests**

Render one log with mapped 400, raw HTTP 200, `response.created` ID, output-before-
failure, terminal source/phase, and a missing-usage reason. Assert readable labels,
the normal table unchanged, keyboard-accessible disclosure, and export download
request for the selected request ID. Assert failure is shown without closing the
detail dialog.

- [ ] **Step 2: Run tests and confirm the missing UI fails**

Run: `cd gui && bun test tests/logs-auto-refresh.test.tsx tests/locale-parity.test.ts`

- [ ] **Step 3: Extend the strict DTO parser and detail dialog**

Accept only the diagnostics schema and primitive/nested allowlisted fields. Render
identity/provenance, raw-versus-mapped status, response IDs, lifecycle, request-shape
counts, terminal/error, attempt/send, and explicit unavailable/truncated markers in
an expandable section. Do not add raw JSON fields that the API did not validate.

- [ ] **Step 4: Add explicit support bundle download**

Fetch `/api/transaction-diagnostics/export?requestId=<encoded>` only on click,
create a temporary JSON blob download, revoke its URL, and surface localized errors.
No background export, publication, or clipboard copy occurs.

- [ ] **Step 5: Add every locale key and style the expandable metadata**

Use `useT()` for all visible copy. Preserve focus, labels, semantic buttons/details,
and readable wrapping for IDs.

- [ ] **Step 6: Run focused GUI validation**

Run: `cd gui && bun test tests/logs-auto-refresh.test.tsx tests/locale-parity.test.ts`

Run: `cd gui && bun run lint:i18n`

Run: `cd gui && bun run build`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add gui/src gui/tests
git commit --signoff -m "feat(gui): show transaction evidence" -m "Expose compact expandable transaction evidence and an explicit selected-request support bundle download in the Logs detail dialog.\n\nAll visible copy is localized and the existing table remains unchanged."
```

### Task 5: Public schema documentation and field matrix

**Files:**
- Create: `docs-site/src/content/docs/reference/transaction-diagnostics.md`
- Modify: `docs-site/src/content/docs/reference/cli/agents.md`
- Modify: `docs-site/src/content/docs/reference/management-api.md`
- Modify: `docs-site/src/content/docs/guides/web-dashboard.md`
- Modify: `docs-site/src/content/docs/reference/proxy-formats.md`
- Modify: `docs-site/astro.config.mjs`
- Modify: localized mirrors that directly describe changed CLI/API/dashboard behavior.
- Modify: `structure/05_gui-and-management-api.md`

**Interfaces:**
- Consumes: final schema/export bounds and behavior from Tasks 1–4.
- Produces: maintained public field contract and support workflow.

- [ ] **Step 1: Write the public reference from the approved spec**

Document type, unit, meaning, boundary, availability, redaction, retention, and
persistence/export behavior for every inventory field. Explicitly explain that
`status: 400` after a streamed `response.failed` is a mapped terminal status, not a
WS/HTTP handshake claim; `response.created` IDs can survive missing usage; and
subscription/Cyber enrollment, policy trigger/rule/stage, upstream request IDs,
rejected-token counts, and billed usage remain unknown unless explicitly exposed.

- [ ] **Step 2: Document the operator workflow**

Document `ocx logs export`, selection/window/size bounds, public re-
pseudonymization, authoritative `usage.jsonl` source, non-authoritative Logs ring/
history index, and the fact that generation never publishes or sends the bundle.

- [ ] **Step 3: Synchronize directly affected localized workflow text and structure**

Update command/API/dashboard descriptions without copying the full English matrix
into every locale. Ensure localized pages do not contradict the English source.

- [ ] **Step 4: Build docs**

Run: `cd docs-site && bun install --frozen-lockfile && bun run build`

Expected: build passes.

- [ ] **Step 5: Commit**

```bash
git add docs-site structure/05_gui-and-management-api.md
git commit --signoff -m "docs: explain support diagnostics" -m "Document the complete diagnostics field contract, provenance and privacy limits, source authority, and the bounded workflow for generating a support bundle.\n\nThe guide calls out unavailable OpenAI policy and entitlement facts instead of implying they can be inferred locally."
```

### Task 6: Acceptance matrix, broad verification, and review closure

**Files:**
- Modify: tests needed to close findings from the acceptance audit only.
- Modify: `docs/superpowers/specs/2026-09-06-transaction-diagnostics-design.md` only if implemented behavior differs and the implementation is corrected or the approved contract is narrowed explicitly.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: exact acceptance evidence and a review-ready branch.

- [ ] **Step 1: Audit every inventory row against code and tests**

For each named field, record one of existing durable, repaired loss, captured,
conditional/provider-specific, unavailable, excluded, or redundant alias. Verify no
unsupported field receives a fabricated value and every captured field crosses
capture → attempt/send → finalization → JSONL → reload → API → CLI/GUI/export as
applicable.

- [ ] **Step 2: Run changed and privacy gates**

Run: `bun run test:changed`

Run: `bun run privacy:scan`

Run: `bun run typecheck`

Run: `cd gui && bun test tests && bun run lint && bun run build && bun run lint:i18n`

Run: `cd docs-site && bun run build`

- [ ] **Step 3: Run the PR-ready full suite**

Run: `bun run test`

Expected: no failures. If environment-only failures match the repository's five
documented container cases exactly, report them verbatim and do not classify them as
regressions.

- [ ] **Step 4: Run independent whole-branch review and fix only load-bearing findings**

Review the exact merge-base-to-head diff for functional correctness, security/
privacy, compatibility, test quality, and acceptance coverage. Re-run only checks
whose evidence a fix invalidates.

- [ ] **Step 5: Store the durable implementation summary in LCM**

Run `lcm store` with the schema version, source-of-truth decision, export bounds,
privacy guarantees, key files, test evidence, and any unavailable OpenAI fields.

- [ ] **Step 6: Commit review fixes when needed**

```bash
git add src/diagnostics src/server src/usage src/cli gui/src gui/tests docs-site structure tests scripts/test-layout/layout.json tests/fixtures/test-layout-expected.json
git commit --signoff -m "fix: close diagnostics review gaps" -m "Address the concrete correctness or privacy findings from exact-head review and retain the documented compatibility and bounded-capture contracts."
```
