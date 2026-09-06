import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  normalizeDiagnosticSends,
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

test("upstream hostname normalization accepts only closed diagnostic classes", () => {
  const base = createTransactionDiagnostics({ requestId: "host-class", receivedAt: Date.now() });
  for (const host of ["tenant.example", "api.openai.com", "localhost", "127.0.0.1", "a-secret-token"]) {
    expect(normalizeTransactionDiagnostics({ ...base, upstreamHostname: host })?.upstreamHostname).toBeUndefined();
  }
  expect(normalizeTransactionDiagnostics({ ...base, upstreamHostname: "custom" })?.upstreamHostname).toBe("custom");
});

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

test("capture acceptance: append failure remains live, bounded and nonfatal", () => {
  mkdirSync(usageLogPath(), { recursive: true });
  expect(() => addRequestLog({ requestId: "append-failure", timestamp: Date.now(), model: "test", provider: "test",
    status: 200, durationMs: 1, usageStatus: "unreported",
    diagnostics: createTransactionDiagnostics({ requestId: "append-failure", receivedAt: Date.now() }),
  })).not.toThrow();
  const row = getRequestLogEntries()[0]!;
  expect(row.diagnostics?.recordPersisted).toBe(false);
  expect(row.diagnostics?.persistenceErrorCode).toBe("append_failed");
  expect(row.diagnostics?.persistedAt).toBeUndefined();
  expect(JSON.stringify(row)).not.toContain(home);
});

test("capture acceptance: live append success does not pretend disk knows write completion", () => {
  addRequestLog({ requestId: "append-success", timestamp: Date.now(), model: "test", provider: "test",
    status: 200, durationMs: 1, usageStatus: "unreported",
    diagnostics: createTransactionDiagnostics({ requestId: "append-success", receivedAt: Date.now() }),
  });
  const row = getRequestLogEntries()[0]!;
  expect(row.diagnostics?.recordPersisted).toBe(true);
  expect(row.diagnostics?.persistedAt).toBeNumber();
  expect(row.diagnostics?.persistenceLagMs).toBeUndefined(); // No finalized transition on direct insertion.
  const durable = readUsageEntries()[0]!;
  expect(durable.diagnostics?.recordPersisted).toBeUndefined();
  expect(durable.diagnostics?.fieldAvailability.recordPersisted?.status).toBe("not_observed");
});

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
      errorMessage: `${"Bearer"} ${"abcdefghijklmnopqrstuvwxyz"} ${"😀".repeat(200)}`,
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

  test("marks redacted and truncated response IDs unavailable for direct correlation", () => {
    const redacted = createTransactionDiagnostics({ requestId: "ocx-redacted-id", receivedAt: 1_000 });
    recordDiagnosticEvent(redacted, {
      type: "response.created",
      at: 1_001,
      source: "upstream",
      responseId: "sk-" + "abcdefghijklmnopqrstuvwxyz",
    });
    expect(redacted.upstreamResponseId).toBeUndefined();
    expect(redacted.events[0]?.responseId).toBeUndefined();
    expect(redacted.fieldAvailability.upstreamResponseId).toEqual({
      status: "redacted",
      source: "upstream",
    });
    expect(redacted.correlationConfidence).toBe("unknown");

    const truncated = createTransactionDiagnostics({ requestId: "ocx-truncated-id", receivedAt: 2_000 });
    recordDiagnosticEvent(truncated, {
      type: "response.created",
      at: 2_001,
      source: "upstream",
      responseId: `resp_${"😀".repeat(100)}`,
    });
    expect(truncated.upstreamResponseId).toBeUndefined();
    expect(truncated.events[0]?.responseId).toBeUndefined();
    expect(truncated.fieldAvailability.upstreamResponseId).toEqual({
      status: "truncated",
      source: "upstream",
    });
    expect(truncated.correlationConfidence).toBe("unknown");
    expect(truncated.captureTruncated).toBe(true);
  });

  test("reports availability-map truncation within the map and envelope", () => {
    const diagnostics = createTransactionDiagnostics({ requestId: "ocx-availability-cap", receivedAt: 1_000 });
    const fieldNames = [
      "parentRequestId", "retryOfRequestId", "replayOfRequestId", "codexThreadId", "codexTurnId",
      "codexSessionId", "rootThreadId", "rootTurnId", "parentThreadId", "agentId", "parentAgentId",
      "clientRequestId", "clientResponseId", "upstreamResponseId", "previousResponseId",
      "originalPreviousResponseId", "forwardedPreviousResponseId", "upstreamRequestId",
      "upstreamConversationId", "upstreamSessionId", "upstreamEventId", "policyEventId", "traceId",
      "spanId", "parentSpanId", "connectionId", "upstreamConnectionId", "proxyCommit", "proxyBuildId",
      "proxyInstanceId", "configRevision", "routeConfigRevision", "modelCatalogRevision", "routeDecisionId",
      "selectedCandidate", "settingsRevision", "requestSettingsRevision", "modelSwitchEffectiveFromRequestId",
      "lastKnownUsageResponseId", "agentRole", "clientProduct", "clientVersion", "codexCoreVersion",
      "desktopVersion", "originator", "upstreamProtocol", "adapterName", "protocolVersion", "proxyVersion",
      "runtimeName", "runtimeVersion", "osPlatform", "architecture", "osVersion", "adapterVersion",
      "diagnosticMode", "forwardedModel", "responseModel", "responseEffort", "routeKind", "fallbackReason",
      "rewriteReason", "authMode", "accountPseudonym", "accountSelectionSource", "accountAffinity",
      "accountPoolSelectionReason", "subscriptionPlan",
    ];
    diagnostics.fieldAvailability = Object.fromEntries(fieldNames.map(name => [
      name,
      { status: "not_observed", source: "proxy" },
    ]));

    const normalized = normalizeTransactionDiagnostics(diagnostics)!;
    expect(Object.keys(normalized.fieldAvailability)).toHaveLength(64);
    expect(normalized.fieldAvailability.fieldAvailability).toEqual({
      status: "truncated",
      source: "persistence",
    });
    expect(normalized.captureTruncated).toBe(true);
  });

  test("rejects prohibited URLs, paths, environment fragments, accounts, and reasoning text", () => {
    const diagnostics = createTransactionDiagnostics({ requestId: "ocx-prohibited", receivedAt: 1_000 });
    Object.assign(diagnostics, {
      upstreamHostname: "https://provider.example/v1?token=secret",
      accountPseudonym: "person@example.com",
      subscriptionPlan: "HOME=/home/person",
      errorParam: "/home/person/private.json",
      cancellationReason: "analysis: hidden chain of thought",
      errorMessage: "failed reading /home/person/private.json",
    });

    const normalized = normalizeTransactionDiagnostics(diagnostics)!;
    for (const field of [
      "upstreamHostname",
      "accountPseudonym",
      "subscriptionPlan",
      "errorParam",
      "cancellationReason",
      "errorMessage",
    ]) expect(normalized).not.toHaveProperty(field);

    const attempt = baseAttempt();
    const send = beginDiagnosticSend(attempt, {
      startedAt: 1_001,
      upstreamTransport: "http",
      accountLogLabel: "person@example.com",
      model: "https://provider.example/model",
      adapter: "/home/person/adapter.ts",
      requestedEffort: "analysis: reveal private reasoning",
      effectiveEffort: "PATH=/usr/local/bin",
      serviceTier: "project/person-secret",
      recoveryReason: "chain of thought says retry",
    });
    expect(send).toEqual(expect.objectContaining({
      sendId: expect.stringMatching(/^ocx-send-/),
      sendOrdinal: 1,
      startedAt: 1_001,
      upstreamTransport: "http",
    }));
    for (const field of [
      "accountLogLabel",
      "model",
      "adapter",
      "requestedEffort",
      "effectiveEffort",
      "serviceTier",
      "recoveryReason",
    ]) expect(send).not.toHaveProperty(field);
  });

  test("rejects file URI and cross-platform path forms without dropping route tokens", () => {
    const prohibited = [
      "file:/etc/passwd",
      "file:///etc/passwd",
      "file:C:/" + "Users/" + "alice/token",
      "C:/" + "Users/" + "alice/token",
      "C:\\Users\\alice\\token",
      "//server/share/token",
      "\\\\server\\share\\token",
    ];
    for (const value of prohibited) {
      const diagnostics = createTransactionDiagnostics({ requestId: "ocx-path-matrix", receivedAt: 1_000 });
      Object.assign(diagnostics, { adapterName: value });
      const normalized = normalizeTransactionDiagnostics(diagnostics)!;
      expect(normalized.adapterName).toBeUndefined();
      expect(normalized.fieldAvailability.adapterName).toEqual({
        status: "redacted",
        source: "proxy",
      });

      const send = beginDiagnosticSend(baseAttempt(), {
        startedAt: 1_001,
        provider: value,
        model: value,
        adapter: value,
      });
      expect(send.provider).toBeUndefined();
      expect(send.model).toBeUndefined();
      expect(send.adapter).toBeUndefined();
    }

    const allowed = beginDiagnosticSend(baseAttempt(), {
      startedAt: 2_000,
      provider: "openai",
      model: "openai/gpt-5.6-sol",
      adapter: "openai-responses",
      forwardedModel: "openrouter/meta-llama/llama-3.1",
    });
    expect(allowed).toMatchObject({
      provider: "openai",
      model: "openai/gpt-5.6-sol",
      adapter: "openai-responses",
      forwardedModel: "openrouter/meta-llama/llama-3.1",
    });
  });

  test("normalizes only bounded event and send prefixes", () => {
    const diagnostics = createTransactionDiagnostics({ requestId: "ocx-work-cap", receivedAt: 1_000 });
    const event = (eventSequence: number) => ({
      eventSequence,
      type: "response.output_item.added",
      at: 1_000 + eventSequence,
      source: "upstream",
    });
    const events = new Array(1_000_000);
    for (let index = 0; index <= MAX_DIAGNOSTIC_EVENTS; index += 1) events[index] = event(index + 1);
    Object.defineProperty(events, MAX_DIAGNOSTIC_EVENTS + 1, {
      get: () => { throw new Error("event traversal escaped bounded prefix"); },
    });
    diagnostics.events = events;
    expect(() => normalizeTransactionDiagnostics(diagnostics)).not.toThrow();

    const sends = new Array(1_000_000);
    for (let index = 0; index <= MAX_DIAGNOSTIC_SENDS; index += 1) {
      sends[index] = { sendId: `ocx-send-${index}`, sendOrdinal: index + 1, startedAt: index + 1 };
    }
    Object.defineProperty(sends, MAX_DIAGNOSTIC_SENDS + 1, {
      get: () => { throw new Error("send traversal escaped bounded prefix"); },
    });
    expect(() => normalizeDiagnosticSends(sends)).not.toThrow();
  });

  test("keeps the previous terminal send until a capped in-flight send finishes", () => {
    const attempt = baseAttempt();
    for (let index = 0; index < MAX_DIAGNOSTIC_SENDS; index += 1) {
      const retained = beginDiagnosticSend(attempt, { startedAt: 1_000 + index });
      finishDiagnosticSend(retained, { endedAt: 2_000 + index, status: 200 });
    }
    const priorTerminalId = attempt.sends?.at(-1)?.sendId;

    const inFlight = beginDiagnosticSend(attempt, { startedAt: 3_000 });
    expect(attempt.sends?.at(-1)?.sendId).toBe(priorTerminalId);
    expect(attempt.sends?.some(send => send.sendId === inFlight.sendId)).toBe(false);

    finishDiagnosticSend(inFlight, { endedAt: 4_000, status: 503 });
    expect(attempt.sends?.at(-1)).toMatchObject({ sendId: inFlight.sendId, status: 503 });
  });

  test("never duplicates a retained send when overflow follows an earlier terminal", () => {
    const sends = Array.from({ length: MAX_DIAGNOSTIC_SENDS + 1 }, (_, index) => ({
      sendId: `ocx-send-${index + 1}`,
      sendOrdinal: index + 1,
      startedAt: 1_000 + index,
      ...(index === 1 ? { endedAt: 2_000, status: 200 } : {}),
    }));

    const normalized = normalizeDiagnosticSends(sends)!;
    expect(normalized).toHaveLength(MAX_DIAGNOSTIC_SENDS);
    expect(new Set(normalized.map(send => send.sendId)).size).toBe(normalized.length);
    expect(normalized.some(send => send.sendId === "ocx-send-2")).toBe(true);
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
      upstreamError: `Authorization: ${"Bearer"} ${"abcdefghijklmnopqrstuvwxyz"}\n${"😀".repeat(200)}`,
      diagnostics,
    });

    const inMemory = getRequestLogEntries()[0]!;
    const persisted = readUsageEntries()[0]!;
    expect(inMemory.upstreamError).toBe(persisted.upstreamError);
    expect(inMemory.upstreamError).toContain("[REDACTED]");
    expect(Buffer.byteLength(inMemory.upstreamError!, "utf8"))
      .toBeLessThanOrEqual(MAX_DIAGNOSTIC_ERROR_BYTES);
    expect(inMemory.diagnostics?.clientRequestId).toEqual(persisted.diagnostics?.clientRequestId);
    expect(inMemory.diagnostics?.fieldAvailability.clientRequestId).toEqual(persisted.diagnostics?.fieldAvailability.clientRequestId);
    expect(inMemory.diagnostics?.recordPersisted).toBe(true);
    expect(persisted.diagnostics?.recordPersisted).toBeUndefined();
    expect(inMemory.diagnostics?.clientRequestId).toBeUndefined();
    expect(inMemory.diagnostics?.fieldAvailability.clientRequestId).toEqual({
      status: "redacted",
      source: "client",
    });
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

  test("addRequestLog cannot be interrupted by a throwing diagnostics object", () => {
    const throwingDiagnostics = new Proxy({}, {
      get: () => { throw new Error("hostile diagnostics getter"); },
    });

    expect(() => addRequestLog({
      requestId: "ocx-throwing-diagnostics",
      timestamp: 1,
      provider: "openai",
      model: "gpt-test",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      diagnostics: throwingDiagnostics as TransactionDiagnosticsV1,
    })).not.toThrow();
    expect(getRequestLogEntries()[0]?.diagnostics).toBeUndefined();
    expect(readUsageEntries()[0]?.requestId).toBe("ocx-throwing-diagnostics");
  });

  test("direct upstream errors with prohibited local context are not persisted", () => {
    addRequestLog({
      requestId: "ocx-prohibited-error",
      timestamp: 1,
      provider: "openai",
      model: "gpt-test",
      status: 502,
      durationMs: 1,
      usageStatus: "unreported",
      upstreamError: "failed at /home/person/private.json with person@example.com",
    });

    expect(getRequestLogEntries()[0]?.upstreamError).toBeUndefined();
    expect(readUsageEntries()[0]?.upstreamError).toBeUndefined();
  });

  test("existing display errors retain public upgrade guidance while diagnostic copies reject URLs", () => {
    const message = "this model requires a subscription, upgrade for access: https://ollama.com/upgrade";
    const diagnostics = createTransactionDiagnostics({ requestId: "upgrade", receivedAt: 1 });
    diagnostics.errorMessage = message;
    addRequestLog({ requestId: "upgrade", timestamp: 1, provider: "ollama", model: "test", status: 403,
      durationMs: 1, usageStatus: "unreported", upstreamError: message, diagnostics });
    expect(getRequestLogEntries()[0]?.upstreamError).toBe(message);
    expect(readUsageEntries()[0]?.upstreamError).toBe(message);
    expect(readUsageEntries()[0]?.diagnostics?.errorMessage).toBeUndefined();
  });

  test("review: display guidance exception never restores arbitrary private URL paths", () => {
    for (const url of ["https://private.example/private-path?private-query", "https://user:pass" + "@" + "private.example/private-path",
      "https://ollama.com/upgrade/private-path", "https://ollama.com/upgrade?private-query"]) {
      addRequestLog({ requestId: "guidance-url", timestamp: 1, provider: "test", model: "test", status: 403,
        durationMs: 1, usageStatus: "unreported", upstreamError: `blocked: ${url}` });
      expect(JSON.stringify(getRequestLogEntries()[0])).not.toContain("private");
      expect(JSON.stringify(readUsageEntries().at(-1))).not.toContain("private-path");
    }
  });

  test("direct upstream errors reject file URI, drive, and UNC path variants", () => {
    const prohibited = [
      "file:/etc/passwd",
      "file:C:/" + "Users/" + "alice/token",
      "C:/" + "Users/" + "alice/token",
      "C:\\Users\\alice\\token",
      "//server/share/token",
      "\\\\server\\share\\token",
    ];
    prohibited.forEach((upstreamError, index) => addRequestLog({
      requestId: `ocx-path-error-${index}`,
      timestamp: index + 1,
      provider: "openai",
      model: "gpt-test",
      status: 502,
      durationMs: 1,
      usageStatus: "unreported",
      upstreamError,
    }));

    expect(getRequestLogEntries().map(entry => entry.upstreamError))
      .toEqual(Array.from({ length: prohibited.length }, () => undefined));
    expect(readUsageEntries().map(entry => entry.upstreamError))
      .toEqual(Array.from({ length: prohibited.length }, () => undefined));
  });
});
