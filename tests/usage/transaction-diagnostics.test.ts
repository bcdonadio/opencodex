import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  readUsageSnapshotForManagement,
  resetUsageReadCacheForTests,
  usageLogPath,
  type PersistedUsageAttempt,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { closeRequestHistoryIndex, requestHistoryRowById } from "../../src/routing/history/indexer";
import { requestLogDto } from "../../src/server/management/shared";

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
  closeRequestHistoryIndex();
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

describe("durability boundary regressions", () => {
  test("late failure survives downstream finalization and persistence at the event cap", () => {
    const diagnostics = createTransactionDiagnostics({ requestId: "late-terminal", receivedAt: 1 });
    for (let index = 0; index < 200; index++) recordDiagnosticEvent(diagnostics, {
      type: "response.output_text.delta", at: index + 1, source: "upstream",
    });
    for (const event of [
      { type: "response.failed", source: "upstream" },
      { type: "downstream.terminal.sent", source: "downstream" },
      { type: "request.finalized", source: "proxy" },
      { type: "request.persisted", source: "proxy" },
    ] as const) recordDiagnosticEvent(diagnostics, { ...event, at: 300 });
    const normalized = normalizeTransactionDiagnostics(diagnostics)!;
    expect(normalized.events).toHaveLength(64);
    expect(normalized.events.slice(-4).map(event => event.type)).toEqual([
      "response.failed", "downstream.terminal.sent", "request.finalized", "request.persisted",
    ]);
    expect(normalized.droppedDiagnosticEventCount).toBe(140);
    expect(normalizeTransactionDiagnostics(normalized)).toEqual(normalized);
  });

  test("raw oversized collections retain tail terminals with bounded element access", () => {
    const diagnostics = createTransactionDiagnostics({ requestId: "raw-tail", receivedAt: 1 });
    let eventReads = 0;
    const rawEvents = new Array(1_000_000);
    const rawSends = new Array(1_000_000);
    for (let index = 0; index < 64; index++) rawEvents[index] = {
      eventSequence: index + 1, type: "response.output_text.delta", at: 1, source: "upstream",
    };
    rawEvents[999_997] = { eventSequence: 999_998, type: "response.failed", at: 2, source: "upstream" };
    rawEvents[999_999] = { eventSequence: 1_000_000, type: "request.finalized", at: 3, source: "proxy" };
    diagnostics.events = new Proxy(rawEvents, { get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) eventReads++;
      return Reflect.get(target, key, receiver);
    } });
    const normalized = normalizeTransactionDiagnostics(diagnostics)!;
    expect(eventReads).toBeLessThanOrEqual(128);
    expect(normalized.events.slice(-2).map(event => event.type)).toEqual(["response.failed", "request.finalized"]);
    expect(normalized.droppedDiagnosticEventCount).toBe(1_000_000 - 64);
    for (let index = 0; index < 16; index++) rawSends[index] = {
      sendId: `send-${index}`, sendOrdinal: index + 1, startedAt: 1,
    };
    rawSends[999_999] = { sendId: "last-send", sendOrdinal: 1_000_000, startedAt: 2, endedAt: 3, status: 503 };
    let sendReads = 0;
    const sends = normalizeDiagnosticSends(new Proxy(rawSends, { get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) sendReads++;
      return Reflect.get(target, key, receiver);
    } }));
    expect(sendReads).toBeLessThanOrEqual(32);
    expect(sends?.at(-1)).toMatchObject({ sendId: "last-send", status: 503 });
  });

  test("live finalized attempt snapshots cannot drift after a late send callback", () => {
    const attempt = baseAttempt();
    const send = beginDiagnosticSend(attempt, { startedAt: 1, reasoningWireField: "thinking.type", reasoningWireValue: "adaptive" });
    finishDiagnosticSend(send, { endedAt: 2, status: 200 });
    addRequestLog({ requestId: "snapshot", timestamp: 1, provider: "test", model: "test", status: 200,
      durationMs: 1, usageStatus: "reported", attempts: [attempt] });
    finishDiagnosticSend(send, { endedAt: 3, status: 503 });
    const live = getRequestLogEntries()[0]!;
    expect(live.attempts?.[0]?.sends?.[0]).toMatchObject({ endedAt: 2, status: 200, reasoningWireValue: "adaptive" });
    expect(readUsageEntries()[0]?.attempts).toEqual(live.attempts);
  });

  test("reusing a live row cannot persist an earlier write outcome", () => {
    addRequestLog({ requestId: "reused", timestamp: 1, provider: "test", model: "test", status: 200,
      durationMs: 1, usageStatus: "unreported", diagnostics: createTransactionDiagnostics({ requestId: "reused", receivedAt: 1 }) });
    const live = getRequestLogEntries()[0]!;
    expect(live.diagnostics?.recordPersisted).toBe(true);
    appendUsageEntry(live);
    const canonical = readUsageEntries().at(-1)!.diagnostics!;
    for (const field of ["recordPersisted", "persistedAt", "persistenceErrorCode", "persistenceLagMs"]) expect(canonical[field]).toBeUndefined();
    expect(canonical.events.some(event => event.type === "request.persisted")).toBe(false);
    unlinkSync(usageLogPath());
    mkdirSync(usageLogPath());
    expect(() => addRequestLog(live)).not.toThrow();
    expect(getRequestLogEntries().at(-1)?.diagnostics).toMatchObject({ recordPersisted: false, persistenceErrorCode: "append_failed" });
    expect(getRequestLogEntries().at(-1)?.diagnostics?.persistedAt).toBeUndefined();
  });

  test("management scan reports rejected lines across warm reads, append and replacement", async () => {
    const row = { requestId: "valid", provider: "test", model: "test", timestamp: 1, status: 200, durationMs: 1, usageStatus: "unreported" };
    writeFileSync(usageLogPath(), `\n${JSON.stringify(row)}\n{bad\n{}\n   \n`);
    expect((await readUsageSnapshotForManagement()).invalidEntriesDropped).toBe(2);
    expect((await readUsageSnapshotForManagement()).invalidEntriesDropped).toBe(2);
    appendFileSync(usageLogPath(), `${JSON.stringify({ ...row, requestId: "next" })}\nnull\n`);
    const appended = await readUsageSnapshotForManagement();
    expect(appended.entries).toHaveLength(2);
    expect(appended.invalidEntriesDropped).toBe(3);
    writeFileSync(usageLogPath(), `${JSON.stringify(row)}\n`);
    expect((await readUsageSnapshotForManagement()).invalidEntriesDropped).toBe(0);
    const initial = `{bad\n${JSON.stringify(row)}\n${JSON.stringify({ ...row, requestId: "second" })}\n`;
    writeFileSync(usageLogPath(), initial);
    resetUsageReadCacheForTests();
    const window = Buffer.byteLength(initial) + 32;
    expect((await readUsageSnapshotForManagement(window)).invalidEntriesDropped).toBe(1);
    appendFileSync(usageLogPath(), `${JSON.stringify({ ...row, requestId: "third" })}\n`);
    const trimmed = await readUsageSnapshotForManagement(window);
    expect(trimmed.invalidEntriesDropped).toBe(0);
    expect(trimmed.truncatedPrefixBytes).toBeGreaterThan(0);
    resetUsageReadCacheForTests();
    expect((await readUsageSnapshotForManagement(window)).entries).toEqual(trimmed.entries);
  });
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
    // Later owner contributions must survive earlier unsupported/default entries.
    diagnostics.fieldAvailability.errorMessage = { status: "redacted", source: "upstream" };
    diagnostics.fieldAvailability.sends = { status: "truncated", source: "transport" };
    diagnostics.fieldAvailability.upstreamResponseId = { status: "observed", source: "upstream" };

    const normalized = normalizeTransactionDiagnostics(diagnostics)!;
    expect(Object.keys(normalized.fieldAvailability)).toHaveLength(64);
    expect(normalized.fieldAvailability.fieldAvailability).toEqual({
      status: "truncated",
      source: "persistence",
    });
    expect(normalized.captureTruncated).toBe(true);
    expect(normalized.fieldAvailability.errorMessage?.status).toBe("redacted");
    expect(normalized.fieldAvailability.sends?.status).toBe("truncated");
    expect(normalized.fieldAvailability.upstreamResponseId?.status).toBe("observed");
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
  // Hand-authored contract witnesses, deliberately independent of the normalizer's
  // field lists and capture builders. Distinct values reveal provenance conflation.
  function completeEnvelope(): TransactionDiagnosticsV1 {
    return {
      schemaVersion: 1, diagnosticCaptureVersion: 1, transactionId: "ocx-txn-contract",
      recordKind: "request", correlationSource: "mixed", correlationConfidence: "direct",
      receivedAt: 1_000, timestampSource: "proxy_wall_clock", droppedDiagnosticEventCount: 0,
      captureTruncated: false, redactionApplied: true, redactionVersion: 1, retentionClass: "usage_ledger",
      parentRequestId: "parent-request", retryOfRequestId: "retry-request", replayOfRequestId: "replay-request",
      codexThreadId: "thread-child", codexTurnId: "turn-child", codexSessionId: "session-client",
      rootThreadId: "thread-root", rootTurnId: "turn-root", parentThreadId: "thread-parent",
      agentId: "agent-child", parentAgentId: "agent-parent", agentRole: "reviewer",
      clientRequestId: "client-request", clientResponseId: "client-response",
      upstreamResponseId: "resp-terminal", previousResponseId: "resp-previous",
      originalPreviousResponseId: "resp-original", forwardedPreviousResponseId: "resp-forwarded",
      upstreamRequestId: "upstream-request", upstreamConversationId: "upstream-conversation",
      upstreamSessionId: "upstream-session", upstreamEventId: "event-terminal", policyEventId: "policy-event",
      traceId: "trace-request", spanId: "span-request", parentSpanId: "span-parent",
      connectionId: "connection-client", upstreamConnectionId: "connection-provider",
      connectionGeneration: 2, requestSequenceOnConnection: 3, upstreamRequestSequenceOnConnection: 4,
      admittedAt: 1_001, routeSelectedAt: 1_003, queuedAt: 1_002,
      upstreamConnectStartedAt: 1_004, upstreamConnectedAt: 1_006, handshakeCompletedAt: 1_009,
      upstreamRequestSentAt: 1_010, upstreamHeadersAt: 1_015, responseCreatedAt: 1_016,
      firstEventAt: 1_016, lastEventAt: 1_070, upstreamTerminalAt: 1_070,
      downstreamTerminalSentAt: 1_072, downstreamClosedAt: 1_074, finalizedAt: 1_075,
      queueMs: 1, connectMs: 2, handshakeMs: 3, upstreamTimeToFirstEventMs: 6, firstOutputMs: 30,
      upstreamDurationMs: 60, downstreamDeliveryLagMs: 2, finalizationLagMs: 3, idleBeforeFailureMs: 40,
      clockAnomaly: false, derivedFields: ["connectMs", "handshakeMs", "firstOutputMs"],
      clientProduct: "codex", clientVersion: "0.120.0", codexCoreVersion: "0.119.0", desktopVersion: "1.2.3",
      originator: "codex_cli_rs", inboundProtocol: "responses", inboundTransport: "websocket",
      upstreamProtocol: "responses", upstreamTransport: "http", adapterName: "openai-responses",
      protocolVersion: "v1", proxyVersion: "2.43.0", runtimeName: "bun", runtimeVersion: "1.3.0",
      osPlatform: "linux", architecture: "x64", osVersion: "6.18", adapterVersion: "1",
      proxyCommit: "abcdef123456", proxyBuildId: "build-test", proxyInstanceId: "instance-test",
      configRevision: "config-1", routeConfigRevision: "route-2", modelCatalogRevision: "catalog-3",
      relevantFeatureFlags: ["diagnostics"], diagnosticMode: "bounded",
      forwardedModel: "wire-model", responseModel: "response-model", responseEffort: "minimal",
      routeKind: "fallback", routeDecisionId: "decision-request", selectedCandidate: "candidate-selected",
      fallbackReason: "transient-5xx", rewriteReason: "alias", settingsRevision: "settings-current",
      settingsUpdatedAt: 900, settingsAppliedAt: 950, requestSettingsRevision: "settings-request",
      modelSwitchRequested: false, modelSwitchApplied: false,
      authMode: "oauth", accountPseudonym: "p123abc", accountSelectionSource: "pool",
      accountAffinity: "p456def", accountChangedBetweenAttempts: true, accountPoolSelectionReason: "fallback",
      subscriptionPlan: "pro", entitlementSource: "provider", entitlementObservedAt: 990,
      cyberAccessStatus: "unknown", cyberAccessProgram: "unknown", modelAccessStatus: "allowed",
      authRefreshOccurred: true, authRefreshResult: "success",
      requestBytes: 401, forwardedRequestBytes: 402, inputItemCount: 10, messageCount: 3,
      toolDefinitionCount: 2, toolCallCount: 1, toolResultCount: 1, imageCount: 1, audioCount: 0,
      fileCount: 0, encryptedItemCount: 1, reasoningItemCount: 1, conversationItemCount: 6,
      attachmentBytes: 501, toolResultBytes: 502, largestToolResultBytes: 503,
      contextWindowTokens: 128_000, contextUsageRatioEstimate: 0.125, maxOutputTokens: 4_096,
      tokenEstimateMethod: "byte_estimate", previousResponseUsed: true, continuationMode: "delta",
      deltaInputCount: 2, reconstructedInputCount: 6, replayedItemCount: 3,
      locallyInjectedItemCounts: { message: 1 }, contextTransformationKinds: ["continuation_replay"],
      droppedItemCounts: { reasoning: 2 }, truncatedItemCounts: { message: 0 }, compactionOccurred: true,
      compactionCount: 1, lastCompactionAt: 980, toolChoiceMode: "auto", parallelToolCalls: false,
      streamingRequested: true, storeRequested: false, truncationMode: "disabled",
      endpointClass: "responses", upstreamHostname: "api.example.test", method: "POST",
      httpStatus: 200, websocketHandshakeStatus: 101, terminalMappedStatus: 502,
      upstreamContentType: "text/event-stream", protocolEventType: "response.failed",
      terminalEventType: "response.failed", lastEventType: "response.failed", lastEventSequence: 3,
      lastOutputKind: "message", outputItemCountsByType: { message: 1, reasoning: 0 }, streamEventCount: 3,
      bytesReceived: 701, bytesForwarded: 702, outputDeliveredBeforeFailure: true,
      upstreamRequestAccepted: true, streamAborted: true, connectionReused: false,
      websocketCloseCode: 1000, websocketCloseReason: "terminal received", closedBy: "upstream",
      connectionAgeMs: 800, reconnectCount: 1, heartbeatTimeout: false, idleTimeoutMs: 900,
      bodyStallMs: 0, bodyOverflowBytes: 0, transportPhase: "terminal_sse", terminalSource: "upstream",
      closeReason: "terminal", upstreamErrorCode: "server_error", errorType: "server_error",
      errorParam: "response.id", errorMessage: "Synthetic provider failure", retryable: false,
      retryAfterMs: 1_100, incompleteReason: "max_output_tokens", contentFilterResult: "unknown",
      errorEnvelopeSchema: "responses", errorMessageTruncated: false, unknownErrorFieldNames: ["future_code"],
      refusalCategory: "unknown", policyRuleId: "rule-observed", policyStage: "output",
      policyDecisionSource: "upstream", errorOrigin: "upstream", requestIdHeader: "x-request-id",
      upstreamTraceHeaders: ["x-request-id", "traceparent"], retryDelayMs: 20,
      retryDecision: "stop", retryBudgetRemaining: 0, recoveryReason: "transient-5xx",
      policyFallbackAttempted: false, policyFallbackOutcome: "not_attempted",
      previousResponseRewriteApplied: true, resumeMode: "replay", stateRestored: true,
      stateRestoreSource: "memory", upstreamCallMade: true, correlationMismatch: false,
      responseIdMismatch: false, duplicateTerminalSuppressed: true,
      cancellationSource: "client", cancellationReason: "client_disconnect",
      usageSource: "upstream", usageReportedAt: 1_069, usagePartial: true, usageMissingReason: "terminal_failure",
      lastKnownUsageResponseId: "resp-terminal", billedUsageSource: "unknown", usageMissingCount: 0,
      requestLimit: 100, tokenLimit: 10_000, accountWindowLimit: 200, accountWindowRemaining: 199,
      accountWindowResetAt: 2_000, rateLimitReachedType: "none", spendControlReached: false,
      quotaErrorCode: "none", logSink: "usage.jsonl", truncationReason: "none", expiresAt: 90_000,
      events: [
        { eventSequence: 1, type: "response.created", at: 1_016, elapsedMs: 16,
          source: "upstream", responseId: "resp-terminal", eventId: "event-created" },
        { eventSequence: 2, type: "response.output_text.delta", at: 1_030, elapsedMs: 30,
          source: "upstream", responseId: "resp-terminal", eventId: "event-output" },
        { eventSequence: 3, type: "response.failed", at: 1_070, elapsedMs: 70,
          source: "upstream", responseId: "resp-terminal", eventId: "event-terminal" },
      ],
      fieldAvailability: {
        upstreamResponseId: { status: "observed", source: "upstream" },
        recordPersisted: { status: "not_observed", source: "persistence" },
        persistedAt: { status: "not_observed", source: "persistence" },
        connectMs: { status: "derived", source: "transport" },
        modelSwitchAppliedAt: { status: "unsupported", source: "proxy" },
        modelSwitchEffectiveFromRequestId: { status: "not_observed", source: "route" },
        parentAgentId: { status: "observed", source: "client" },
        billedUsageSource: { status: "unknown", source: "adapter" },
      },
    };
  }

  function completeAttempt(): PersistedUsageAttempt {
    return {
      ordinal: 1, attemptId: "ocx-attempt-contract", attemptStartedAt: 1_003, attemptEndedAt: 1_071,
      upstreamTransport: "http", provider: "attempt-provider", model: "attempt-model",
      adapter: "openai-responses", status: 502, durationMs: 68, streamAborted: true, firstOutputMs: 27,
      sendCount: 1, recoveryKinds: ["transient-5xx"], usageStatus: "reported", accountLogLabel: "p123abc",
      inputTokenEstimate: 81, usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24,
        contextTotalTokens: 101, cachedInputTokens: 2, cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4, reasoningOutputTokens: 5 }, totalTokens: 24,
      errorCode: "upstream_error", requestedEffort: "high", effectiveEffort: "medium",
      reasoningWireField: "thinking.budget_tokens", reasoningWireValue: 2_048,
      tierOutcome: { canonical: "priority", wireKind: "service-tier", wireValue: "priority",
        fastOutcome: "downgraded", fastDowngradeReason: "response-declined", callerTierDropped: false,
        callerFastSuppressedByConfig: false, confirmation: "downgraded", responseServiceTier: "default" },
      sends: [{ sendId: "ocx-send-contract", sendOrdinal: 1, startedAt: 1_010, endedAt: 1_070,
        upstreamTransport: "http", endpointClass: "responses", provider: "send-provider", model: "send-model",
        adapter: "openai-responses", accountLogLabel: "p456def", forwardedModel: "send-wire-model",
        requestedEffort: "low", effectiveEffort: "minimal", reasoningWireField: "reasoning.enabled",
        reasoningWireValue: false, serviceTier: "flex", recoveryReason: "transient-5xx", retryReason: "retry",
        status: 502, httpStatus: 200, websocketHandshakeStatus: 101, upstreamRequestId: "send-request",
        upstreamResponseId: "send-response", upstreamEventId: "send-event", bytesForwarded: 901,
        bytesReceived: 902, upstreamRequestAccepted: true, streamAborted: true, connectionReused: false }],
    };
  }

  function completeRow(): PersistedUsageEntry {
    return {
      requestId: "ocx-contract", timestamp: 1_000, provider: "row-provider", model: "row-model",
      requestedAlias: "caller-alias", requestedModel: "caller-model", resolvedModel: "resolved-model",
      shadowCallRewrittenFrom: "helper-model", surface: "claude", apiKeyId: "configured-test",
      admissionKind: "configured", inboundProtocol: "responses", accountLogLabel: "p123abc",
      conversationId: "opaque-group", requestedEffort: "ultra", effectiveEffort: "xhigh",
      reasoningWireField: "reasoning.effort", reasoningWireValue: "xhigh", callerServiceTier: "auto",
      requestedServiceTier: "priority", requestedSpeedLabel: "fast", configuredServiceTier: "default",
      configuredSpeedLabel: "standard", modelSupportsServiceTier: false, responseServiceTier: "flex",
      tierOutcome: { fastOutcome: "not-requested", confirmation: "unknown", callerTierDropped: true,
        callerFastSuppressedByConfig: true, wireKind: null, wireValue: null },
      status: 502, durationMs: 75, firstOutputMs: 30, usageStatus: "reported",
      usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24, contextTotalTokens: 101,
        cachedInputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, reasoningOutputTokens: 5 },
      totalTokens: 24, errorCode: "upstream_error", terminalStatus: "failed", closeReason: "terminal",
      upstreamError: "Synthetic provider failure", localTerminalReason: "provider-terminal",
      affinity: "rebound", transportPhase: "terminal_sse", terminalSource: "upstream",
      diagnostics: completeEnvelope(), attempts: [completeAttempt()],
    };
  }

  test("contract: every accepted envelope fact survives normalization unchanged", () => {
    const expected = completeEnvelope();
    expect(normalizeTransactionDiagnostics(expected)).toEqual(expected);
  });

  test("contract: complete row survives JSONL, cold reload and management DTO", async () => {
    const expected = completeRow();
    appendUsageEntry(expected);
    const jsonl = JSON.parse(readFileSync(usageLogPath(), "utf8").trim());
    expect(jsonl).toEqual(expected);
    expect(normalizePersistedUsageRow(jsonl)).toEqual(expected);
    resetUsageReadCacheForTests();
    const persisted = readUsageEntries()[0]!;
    expect(persisted).toEqual(expected);
    const reloaded = requestLogEntryFromPersistedUsage(persisted);
    expect(reloaded).toMatchObject(expected);
    const dto = JSON.parse(JSON.stringify(requestLogDto(reloaded)));
    expect(dto).toMatchObject(expected);
    const historyRow = await requestHistoryRowById(expected.requestId);
    expect(historyRow).toEqual(expected);
    closeRequestHistoryIndex();
    expect(await requestHistoryRowById(expected.requestId)).toEqual(expected);
    expect(dto.inboundTransport).toBe("websocket");
    expect(dto.upstreamTransport).toBe("http");
  });

  test("contract: an exact local zero-send attempt remains explicit after restart", () => {
    const attempt = baseAttempt({ provider: "cursor", locallyAnswered: true,
      usage: { inputTokens: 0, outputTokens: 0 }, totalTokens: 0 });
    const expected: PersistedUsageEntry = { requestId: "local-zero", timestamp: 1,
      model: "local-model", provider: "cursor", status: 200, durationMs: 0,
      usageStatus: "reported", attempts: [attempt] };
    appendUsageEntry(expected);
    resetUsageReadCacheForTests();
    const reloaded = requestLogEntryFromPersistedUsage(readUsageEntries()[0]!);
    expect(reloaded.attempts).toEqual([attempt]);
    expect(requestLogDto(reloaded)).toMatchObject({ attempts: [attempt] });
    expect(reloaded.attempts?.[0]?.sends).toBeUndefined();
    expect(reloaded.attempts?.[0]?.usage?.estimated).toBeUndefined();
  });

  test.each([
    { field: "reasoning.effort", value: "high" },
    { field: "thinking.budget_tokens", value: 0 },
    { field: "reasoning.enabled", value: false },
    { field: "reasoning.enabled", value: true },
  ])("contract: reasoning wire primitive $field=$value survives every scope", ({ field, value }) => {
    const row = completeRow();
    // Alias loss has its own exact-row regression; it must not mask these cases.
    delete row.requestedAlias;
    row.reasoningWireField = field;
    row.reasoningWireValue = value;
    row.attempts![0]!.reasoningWireField = field;
    row.attempts![0]!.reasoningWireValue = value;
    row.attempts![0]!.sends![0]!.reasoningWireField = field;
    row.attempts![0]!.sends![0]!.reasoningWireValue = value;
    appendUsageEntry(row);
    resetUsageReadCacheForTests();
    const persisted = readUsageEntries()[0]!;
    expect(persisted).toEqual(row);
    const dto = requestLogDto(requestLogEntryFromPersistedUsage(persisted));
    expect(dto).toMatchObject(row);
    expect(dto.reasoningWireValue).toBe(value);
    expect(persisted.attempts?.[0]?.reasoningWireValue).toBe(value);
    expect(persisted.attempts?.[0]?.sends?.[0]?.reasoningWireValue).toBe(value);
  });

  test("contract: unavailable facts keep their status and source without invented values", () => {
    const row = completeRow();
    delete row.requestedAlias;
    row.diagnostics = {
      schemaVersion: 1, diagnosticCaptureVersion: 1, transactionId: "ocx-txn-unavailable",
      recordKind: "request", correlationSource: "proxy", correlationConfidence: "unknown",
      receivedAt: 1_000, timestampSource: "proxy_wall_clock", events: [],
      droppedDiagnosticEventCount: 0, captureTruncated: true, redactionApplied: true,
      redactionVersion: 1, retentionClass: "usage_ledger",
      logSink: "usage.jsonl",
      fieldAvailability: {
        clientRequestId: { status: "redacted", source: "client" },
        upstreamEventId: { status: "truncated", source: "upstream" },
        connectMs: { status: "derived", source: "derived" },
        recordPersisted: { status: "not_observed", source: "persistence" },
        persistedAt: { status: "not_observed", source: "persistence" },
        modelSwitchApplied: { status: "unsupported", source: "proxy" },
        responseEffort: { status: "unknown", source: "adapter" },
      },
    };
    appendUsageEntry(row);
    resetUsageReadCacheForTests();
    const persisted = readUsageEntries()[0]!;
    expect(persisted.diagnostics).toEqual(row.diagnostics);
    expect(requestLogDto(requestLogEntryFromPersistedUsage(persisted)).diagnostics).toEqual(row.diagnostics);
    for (const field of Object.keys(row.diagnostics.fieldAvailability)) {
      expect(persisted.diagnostics).not.toHaveProperty(field);
    }
  });

  test("contract: legacy, unknown and malformed members remain isolated across JSONL reload", () => {
    const legacy = { requestId: "legacy-contract", timestamp: 1, model: "old", provider: "openai",
      status: 200, durationMs: 0, usageStatus: "unreported" };
    const malformed = { ...legacy, requestId: "malformed-contract", futureTopLevel: "drop",
      diagnostics: { ...completeEnvelope(), futureEnvelope: "drop", inputItemCount: -1,
        streamingRequested: "yes", responseEffort: "invented", upstreamTransport: "pipe",
        events: [{ eventSequence: 1, type: "future.event", at: 2, source: "upstream" }],
        fieldAvailability: { upstreamResponseId: { status: "observed", source: "upstream", future: "drop" },
          futureField: { status: "observed", source: "client" } } },
      attempts: [{ ...baseAttempt(), futureAttempt: "drop", sends: [
        { sendId: "valid-send", sendOrdinal: 1, startedAt: 2, futureSend: "drop",
          reasoningWireField: "reasoning.effort", reasoningWireValue: true, bytesReceived: -1 },
        { sendId: "invalid-send", sendOrdinal: -1, startedAt: 2 },
      ] }, { ...baseAttempt(), ordinal: 0 }] };
    writeFileSync(usageLogPath(), [legacy, malformed, { ...legacy, requestId: "future-schema",
      diagnostics: { ...completeEnvelope(), schemaVersion: 99 } }].map(row => JSON.stringify(row)).join("\n") + "\n");
    resetUsageReadCacheForTests();
    const rows = readUsageEntries();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(legacy);
    const dto = requestLogDto(requestLogEntryFromPersistedUsage(rows[1]!));
    expect(dto).not.toHaveProperty("futureTopLevel");
    const diagnostics = dto.diagnostics as TransactionDiagnosticsV1;
    for (const field of ["futureEnvelope", "inputItemCount", "streamingRequested", "responseEffort", "upstreamTransport"]) {
      expect(diagnostics).not.toHaveProperty(field);
    }
    expect(diagnostics.events).toEqual([]);
    expect(diagnostics.fieldAvailability).toMatchObject({
      upstreamResponseId: { status: "observed", source: "upstream" },
      responseEffort: { status: "redacted", source: "upstream" },
    });
    expect(diagnostics.fieldAvailability).not.toHaveProperty("futureField");
    expect(diagnostics.fieldAvailability.upstreamResponseId).not.toHaveProperty("future");
    expect(rows[1]?.attempts).toHaveLength(1);
    expect(rows[1]?.attempts?.[0]).not.toHaveProperty("futureAttempt");
    expect(rows[1]?.attempts?.[0]?.sends).toEqual([{ sendId: "valid-send", sendOrdinal: 1,
      startedAt: 2, reasoningWireField: "reasoning.effort" }]);
    expect(requestLogDto(requestLogEntryFromPersistedUsage(rows[0]!))).not.toHaveProperty("diagnostics");
    expect(requestLogDto(requestLogEntryFromPersistedUsage(rows[2]!))).not.toHaveProperty("diagnostics");
  });

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
