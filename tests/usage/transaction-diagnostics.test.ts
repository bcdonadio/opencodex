import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_DIAGNOSTIC_ERROR_BYTES,
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_ID_BYTES,
  MAX_DIAGNOSTIC_SENDS,
  beginDiagnosticSend,
  createTransactionDiagnostics,
  finishDiagnosticSend,
  normalizeTransactionDiagnostics,
  recordDiagnosticEvent,
  sanitizeDiagnosticIdentifier,
  type TransactionDiagnosticsV1,
} from "../../src/diagnostics/transaction";
import {
  addRequestLog,
  beginRequestAttempt,
  clearRequestLogsForTests,
  finishRequestAttempt,
  getRequestLogEntries,
  requestLogEntryFromPersistedUsage,
} from "../../src/server/request-log";
import {
  appendUsageEntry,
  normalizePersistedUsageRow,
  readUsageEntries,
  resetUsageReadCacheForTests,
  usageLogPath,
  type PersistedUsageAttempt,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-transaction-diagnostics-"));
  process.env.OPENCODEX_HOME = home;
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
});

afterEach(() => {
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
});

function baseAttempt(overrides: Partial<PersistedUsageAttempt> = {}): PersistedUsageAttempt {
  return {
    ordinal: 1,
    provider: "openai",
    model: "gpt-test",
    adapter: "openai-responses",
    status: 200,
    durationMs: 20,
    sendCount: 0,
    recoveryKinds: [],
    usageStatus: "reported",
    ...overrides,
  };
}

describe("transaction diagnostics schema", () => {
  test("derives response-created correlation through the v1 lifecycle builder", () => {
    const diagnostics = createTransactionDiagnostics({
      requestId: "ocx-test",
      receivedAt: 1_000,
      proxyVersion: "2.43.0",
      inboundProtocol: "responses",
      inboundTransport: "websocket",
    });

    recordDiagnosticEvent(diagnostics, {
      type: "response.created",
      at: 1_010,
      source: "upstream",
      responseId: "resp_test",
    });

    expect(normalizeTransactionDiagnostics(diagnostics)).toMatchObject({
      schemaVersion: 1,
      diagnosticCaptureVersion: 1,
      transactionId: expect.stringMatching(/^ocx-txn-/),
      recordKind: "request",
      correlationSource: "mixed",
      correlationConfidence: "direct",
      receivedAt: 1_000,
      responseCreatedAt: 1_010,
      upstreamResponseId: "resp_test",
      proxyVersion: "2.43.0",
      inboundProtocol: "responses",
      inboundTransport: "websocket",
      timestampSource: "proxy_wall_clock",
      redactionApplied: true,
      redactionVersion: 1,
      retentionClass: "usage_ledger",
    });
  });

  test("bounds lifecycle events and sends while retaining the first and final records", () => {
    const diagnostics = createTransactionDiagnostics({ requestId: "ocx-bounds", receivedAt: 1_000 });
    recordDiagnosticEvent(diagnostics, { type: "request.received", at: 1_000, source: "proxy" });
    for (let index = 0; index < MAX_DIAGNOSTIC_EVENTS + 6; index += 1) {
      recordDiagnosticEvent(diagnostics, {
        type: "response.output_item.added",
        at: 1_001 + index,
        source: "upstream",
      });
    }
    recordDiagnosticEvent(diagnostics, { type: "response.failed", at: 2_000, source: "upstream" });

    const normalized = normalizeTransactionDiagnostics(diagnostics)!;
    expect(normalized.events).toHaveLength(MAX_DIAGNOSTIC_EVENTS);
    expect(normalized.events[0]?.type).toBe("request.received");
    expect(normalized.events.at(-1)?.type).toBe("response.failed");
    expect(normalized.droppedDiagnosticEventCount).toBe(8);
    expect(normalized.captureTruncated).toBe(true);

    const attempt = baseAttempt();
    for (let index = 0; index < MAX_DIAGNOSTIC_SENDS + 2; index += 1) {
      const send = beginDiagnosticSend(attempt, {
        startedAt: 3_000 + index,
        upstreamTransport: "http",
      });
      finishDiagnosticSend(send, {
        endedAt: 4_000 + index,
        status: index === MAX_DIAGNOSTIC_SENDS + 1 ? 503 : 200,
      });
    }
    expect(attempt.sendCount).toBe(MAX_DIAGNOSTIC_SENDS + 2);
    expect(attempt.sends).toHaveLength(MAX_DIAGNOSTIC_SENDS);
    expect(attempt.sends?.[0]?.sendOrdinal).toBe(1);
    expect(attempt.sends?.at(-1)).toMatchObject({
      sendOrdinal: MAX_DIAGNOSTIC_SENDS + 2,
      status: 503,
    });
  });

  test("generates proxy IDs and wall-clock bounds for request attempts", () => {
    const attempt = beginRequestAttempt(1, "openai", "gpt-test", "openai-responses");
    expect(attempt.attemptId).toMatch(/^ocx-attempt-/);
    expect(attempt.attemptStartedAt).toBeGreaterThan(0);

    finishRequestAttempt(attempt, 200, 25);
    expect(attempt.attemptEndedAt).toBe(attempt.attemptStartedAt! + 25);
  });

  test("uses UTF-8 byte caps and strips controls and secrets from retained strings", () => {
    const identifier = sanitizeDiagnosticIdentifier(`resp\n${"😀".repeat(100)}\u0000`)!;
    expect(identifier).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(Buffer.byteLength(identifier, "utf8")).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ID_BYTES);

    const diagnostics = createTransactionDiagnostics({
      requestId: `ocx-${"😀".repeat(100)}`,
      receivedAt: 1_000,
    });
    Object.assign(diagnostics, {
      errorMessage: `Bearer abcdefghijklmnopqrstuvwxyz ${"😀".repeat(200)}`,
    });
    const normalized = normalizeTransactionDiagnostics(diagnostics)!;
    expect(normalized.errorMessage).toContain("[REDACTED]");
    expect(normalized.errorMessage).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(Buffer.byteLength(normalized.errorMessage as string, "utf8"))
      .toBeLessThanOrEqual(MAX_DIAGNOSTIC_ERROR_BYTES);
  });

  test("drops unsupported schemas, enum values, fields, events, and availability members", () => {
    const valid = createTransactionDiagnostics({ requestId: "ocx-invalid", receivedAt: 1_000 });
    const malformed = {
      ...valid,
      inboundTransport: "pipe",
      unknownInjectedField: "must-not-survive",
      events: [
        ...valid.events,
        { eventSequence: 1, type: "made.up", at: 1_001, source: "upstream" },
      ],
      fieldAvailability: {
        upstreamResponseId: { status: "observed", source: "upstream" },
        invalidState: { status: "present", source: "upstream" },
        invalidSource: { status: "observed", source: "filesystem" },
      },
    } as unknown as TransactionDiagnosticsV1;

    const normalized = normalizeTransactionDiagnostics(malformed)!;
    expect(normalized).not.toHaveProperty("inboundTransport");
    expect(normalized).not.toHaveProperty("unknownInjectedField");
    expect(normalized.events).toHaveLength(0);
    expect(normalized.fieldAvailability).toEqual({
      upstreamResponseId: { status: "observed", source: "upstream" },
    });
    expect(normalizeTransactionDiagnostics({ ...valid, schemaVersion: 2 } as never)).toBeUndefined();
  });
});

describe("transaction diagnostics persistence", () => {
  test("survives live entry through JSONL normalization and restart projection", () => {
    const diagnostics = createTransactionDiagnostics({
      requestId: "ocx-round-trip",
      receivedAt: 1_000,
      inboundProtocol: "responses",
      inboundTransport: "websocket",
    });
    recordDiagnosticEvent(diagnostics, {
      type: "response.created",
      at: 1_010,
      source: "upstream",
      responseId: "resp_round_trip",
    });
    diagnostics.fieldAvailability.upstreamResponseId = {
      status: "observed",
      source: "upstream",
    };

    const attempt = baseAttempt({
      attemptId: "ocx-attempt-test",
      attemptStartedAt: 1_001,
      attemptEndedAt: 1_020,
      upstreamTransport: "websocket",
    });
    const send = beginDiagnosticSend(attempt, {
      startedAt: 1_002,
      upstreamTransport: "websocket",
      forwardedModel: "gpt-test",
    });
    finishDiagnosticSend(send, { endedAt: 1_019, status: 200, upstreamResponseId: "resp_round_trip" });

    const entry: PersistedUsageEntry = {
      requestId: "ocx-round-trip",
      timestamp: 1_000,
      provider: "openai",
      model: "gpt-test",
      status: 200,
      durationMs: 20,
      usageStatus: "reported",
      apiKeyId: "configured-key",
      admissionKind: "configured",
      inboundProtocol: "responses",
      localTerminalReason: "adapter-local-terminal",
      affinity: "reused",
      transportPhase: "terminal_sse",
      terminalSource: "upstream",
      terminalStatus: "completed",
      closeReason: "terminal",
      diagnostics,
      attempts: [attempt],
    };

    appendUsageEntry(entry);
    const persisted = readUsageEntries()[0]!;
    const reloaded = requestLogEntryFromPersistedUsage(persisted);

    expect(persisted).toMatchObject({
      apiKeyId: "configured-key",
      admissionKind: "configured",
      inboundProtocol: "responses",
      localTerminalReason: "adapter-local-terminal",
      affinity: "reused",
      transportPhase: "terminal_sse",
      terminalSource: "upstream",
      terminalStatus: "completed",
      closeReason: "terminal",
      diagnostics: {
        schemaVersion: 1,
        upstreamResponseId: "resp_round_trip",
        fieldAvailability: {
          upstreamResponseId: { status: "observed", source: "upstream" },
        },
      },
      attempts: [{
        attemptId: "ocx-attempt-test",
        attemptStartedAt: 1_001,
        attemptEndedAt: 1_020,
        upstreamTransport: "websocket",
        sendCount: 1,
        sends: [{
          sendOrdinal: 1,
          upstreamTransport: "websocket",
          forwardedModel: "gpt-test",
          upstreamResponseId: "resp_round_trip",
          status: 200,
        }],
      }],
    });
    expect(reloaded).toMatchObject(persisted);
  });

  test("keeps legacy rows readable without inventing diagnostics", () => {
    writeFileSync(usageLogPath(), `${JSON.stringify({
      requestId: "ocx-legacy",
      timestamp: 1,
      provider: "openai",
      model: "gpt-old",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
    })}\n`);

    const persisted = readUsageEntries()[0]!;
    expect(persisted.requestId).toBe("ocx-legacy");
    expect(persisted.diagnostics).toBeUndefined();
    expect(requestLogEntryFromPersistedUsage(persisted).diagnostics).toBeUndefined();
  });

  test("normalizes direct addRequestLog input identically in memory and on disk", () => {
    const diagnostics = createTransactionDiagnostics({ requestId: "ocx-direct", receivedAt: 1_000 });
    Object.assign(diagnostics, {
      clientRequestId: `client\n${"😀".repeat(100)}`,
      inboundTransport: "pipe",
      unknownInjectedField: "drop-me",
    });

    addRequestLog({
      requestId: "ocx-direct",
      timestamp: 1_000,
      provider: "openai",
      model: "gpt-test",
      status: 502,
      durationMs: 1,
      usageStatus: "unreported",
      upstreamError: `Authorization: Bearer abcdefghijklmnopqrstuvwxyz\n${"😀".repeat(200)}`,
      diagnostics,
    });

    const inMemory = getRequestLogEntries()[0]!;
    const persisted = readUsageEntries()[0]!;
    expect(inMemory.upstreamError).toBe(persisted.upstreamError);
    expect(inMemory.upstreamError).toContain("[REDACTED]");
    expect(Buffer.byteLength(inMemory.upstreamError!, "utf8"))
      .toBeLessThanOrEqual(MAX_DIAGNOSTIC_ERROR_BYTES);
    expect(inMemory.diagnostics).toEqual(persisted.diagnostics);
    expect(inMemory.diagnostics?.clientRequestId).not.toContain("\n");
    expect(Buffer.byteLength(inMemory.diagnostics?.clientRequestId as string, "utf8"))
      .toBeLessThanOrEqual(MAX_DIAGNOSTIC_ID_BYTES);
    expect(inMemory.diagnostics).not.toHaveProperty("inboundTransport");
    expect(inMemory.diagnostics).not.toHaveProperty("unknownInjectedField");
  });

  test("drops malformed diagnostics without rejecting an otherwise valid usage row", () => {
    const row = normalizePersistedUsageRow({
      requestId: "ocx-malformed-diagnostics",
      timestamp: 1,
      provider: "openai",
      model: "gpt-test",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      diagnostics: { schemaVersion: 99 },
    });

    expect(row?.requestId).toBe("ocx-malformed-diagnostics");
    expect(row?.diagnostics).toBeUndefined();
  });
});
