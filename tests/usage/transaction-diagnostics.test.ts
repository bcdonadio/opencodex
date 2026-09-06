import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureUpstreamHeaders, captureUpstreamPayloadFacts } from "../../src/server/transaction-upstream-facts";
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
import { recordContextTransformation, recordCompletedCompaction, recordReconstructedContext, recordContextEstimate,
  recordProtocolEvent, recordRequestShape } from "../../src/server/transaction-capture";
import type { RequestLogContext } from "../../src/server/request-log";
import { recordAdapterReasoning } from "../../src/server/request-log";
import { recordForwardedRequest } from "../../src/server/transaction-capture";
import type { AdapterRequest } from "../../src/adapters/base";
import { captureAdapterExecution, finalizeDiagnostics, transportObserver } from "../../src/server/transaction-capture";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import { noteAttemptSend } from "../../src/server/request-log";
import type { OcxProviderConfig } from "../../src/types";

test("custom adapter execution retains unobserved calls across retries and attempt changes", async () => {
  const ctx = { provider: "custom", model: "m" } as RequestLogContext;
  const attempt = beginRequestAttempt(1, "custom", "m", "custom");
  ctx.activeAttempt = attempt;
  const provider = { adapter: "custom" } as OcxProviderConfig;
  finalizeDiagnostics(ctx, 502, "custom", Date.now());
  expect(ctx.diagnostics?.upstreamCallMade).toBe(false);
  for (let i = 0; i < 2; i++) {
    noteAttemptSend(attempt, 25, i ? "key-429" : undefined);
    await captureAdapterExecution(ctx, providerFetch(provider, undefined, {
      observeTransport: transportObserver(ctx),
    }), async () => Response.json({ ok: true }));
  }
  finalizeDiagnostics(ctx, 200, "custom", Date.now());
  expect(attempt.sendCount).toBe(2);
  expect(attempt.sends).toBeUndefined();
  expect(attempt.recoveryKinds).toEqual(["key-429"]);
  expect(ctx.diagnostics?.upstreamCallMade).toBeUndefined();
  expect(ctx.diagnostics?.fieldAvailability.upstreamCallMade?.status).toBe("not_observed");
  ctx.activeAttempt = beginRequestAttempt(2, "next", "m", "custom");
  noteAttemptSend(ctx.activeAttempt, 1);
  await captureAdapterExecution(ctx, providerFetch(provider, undefined, {
    observeTransport: transportObserver(ctx),
  }), async () => { throw new Error("adapter failed before any observable dispatch"); }).catch(() => {});
  finalizeDiagnostics(ctx, 502, "custom", Date.now());
  expect(ctx.activeAttempt.sendCount).toBe(1);
  expect(ctx.activeAttempt.sends).toBeUndefined();
  expect(ctx.diagnostics?.upstreamCallMade).not.toBe(false);
});

test("custom adapter physical executor owns multiple sends and rejected admission", async () => {
  const ctx = { provider: "custom", model: "m" } as RequestLogContext;
  ctx.activeAttempt = beginRequestAttempt(1, "custom", "m", "custom");
  const provider = { adapter: "custom", fetch: Object.assign(async () => Response.json({ ok: true }), {
    preconnect() {},
  }) } as unknown as OcxProviderConfig;
  noteAttemptSend(ctx.activeAttempt, 1);
  await captureAdapterExecution(ctx, providerFetch(provider, undefined, {
    observeTransport: transportObserver(ctx),
  }), async executor => {
    await executor("https://example.test/responses", { method: "POST", body: "{}" });
    return executor.unpacedFetch!("https://example.test/responses", { method: "POST", body: "{}" });
  });
  finalizeDiagnostics(ctx, 200, "physical", Date.now());
  expect(ctx.activeAttempt.sendCount).toBe(2);
  expect(ctx.activeAttempt.sends).toHaveLength(2);
  expect(ctx.diagnostics?.upstreamCallMade).toBe(true);

  const rejected = { provider: "custom", model: "m" } as RequestLogContext;
  rejected.activeAttempt = beginRequestAttempt(1, "custom", "m", "custom");
  noteAttemptSend(rejected.activeAttempt, 1);
  const executor = providerFetch(provider, undefined, {
    observeTransport: transportObserver(rejected),
    beforeDispatch() { throw new Error("admission rejected"); },
  });
  await captureAdapterExecution(rejected, executor, fetch => fetch("https://example.test"))
    .catch(() => {});
  finalizeDiagnostics(rejected, 502, "rejected", Date.now());
  expect(rejected.activeAttempt.sendCount).toBe(0);
  expect(rejected.activeAttempt.sends).toBeUndefined();
  expect(rejected.diagnostics?.upstreamCallMade).toBe(false);

  const paced = { provider: "custom", model: "m" } as RequestLogContext;
  paced.activeAttempt = beginRequestAttempt(1, "custom", "m", "custom");
  noteAttemptSend(paced.activeAttempt, 1);
  const pacedExecutor = providerFetch(provider, undefined, { observeTransport: transportObserver(paced) });
  pacedExecutor.waitForPacing = async () => { throw new Error("pacing rejected"); };
  await captureAdapterExecution(paced, pacedExecutor, async fetch => {
    await fetch.waitForPacing!();
    return fetch.unpacedFetch!("https://example.test");
  }).catch(() => {});
  finalizeDiagnostics(paced, 502, "paced", Date.now());
  expect(paced.activeAttempt.sendCount).toBe(0);
  expect(paced.activeAttempt.sends).toBeUndefined();
  expect(paced.diagnostics?.upstreamCallMade).toBe(false);
});

test("adapter diagnostics setup failure preserves execution and thrown errors", async () => {
  const ctx = {} as RequestLogContext;
  Object.defineProperty(ctx, "activeAttempt", { get() { throw new Error("diagnostics unavailable"); } });
  const executor = providerFetch({ adapter: "custom" } as OcxProviderConfig);
  const result = Response.json({ ok: true });
  expect(await captureAdapterExecution(ctx, executor, async fetch => {
    expect(fetch).toBe(executor);
    return result;
  })).toBe(result);
  const failure = new Error("original adapter failure");
  await expect(captureAdapterExecution(ctx, executor, async () => { throw failure; })).rejects.toBe(failure);
});

test("prepared custom adapter admission never claims an invocation before execution", () => {
  const ctx = { provider: "custom", model: "m" } as RequestLogContext;
  ctx.activeAttempt = beginRequestAttempt(1, "custom", "m", "custom");
  noteAttemptSend(ctx.activeAttempt, 1);
  transportObserver(ctx)({ kind: "prepared" });
  // The outer pacing wait rejects, so the adapter execution boundary is never entered.
  finalizeDiagnostics(ctx, 499, "admission", Date.now());
  expect(ctx.activeAttempt.sendCount).toBe(0);
  expect(ctx.activeAttempt.sends).toBeUndefined();
  expect(ctx.diagnostics?.upstreamCallMade).toBe(false);
});

test("adapter context counts survive log ingestion before reasoning metadata and deduplicate same build", () => {
  const ctx = {} as RequestLogContext;
  const request = { url: "https://example.test", headers: {}, body: "{}", contextLog: [
    { kind: "adapter_normalization", injected: { message: 1 }, dropped: { message: 1 } },
    { kind: "instruction_injection", truncated: { instruction: 2 } },
  ] } as AdapterRequest;
  recordAdapterReasoning(ctx, request);
  recordAdapterReasoning(ctx, request);
  expect(ctx.diagnostics?.locallyInjectedItemCounts).toEqual({ message: 1 });
  expect(ctx.diagnostics?.droppedItemCounts).toEqual({ message: 1 });
  expect(ctx.diagnostics?.truncatedItemCounts).toEqual({ instruction: 2 });
  expect(normalizeTransactionDiagnostics(ctx.diagnostics)?.truncatedItemCounts).toEqual({ instruction: 2 });
});

test("forwarded shape cannot carry counts from a prior send into an oversized retry", () => {
  const ctx = {} as RequestLogContext;
  recordForwardedRequest(ctx, "http", JSON.stringify({ model: "first", input: [{ role: "user", content: "hi" }] }));
  expect(ctx.diagnostics?.forwardedInputItemCount).toBe(1);
  recordForwardedRequest(ctx, "http", JSON.stringify({ model: "second", input: "x".repeat(1024 * 1024) }));
  expect(ctx.diagnostics?.forwardedInputItemCount).toBeUndefined();
  expect(ctx.diagnostics?.forwardedModel).toBeUndefined();
});

test("caller observes supported inline attachments and additional tools without retaining data URIs", () => {
  const ctx = {} as RequestLogContext;
  recordRequestShape(ctx, { max_completion_tokens: 10, input: [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,YWJj" },
      { type: "input_file", file_data: "data:application/pdf;base64,YWI=" }] },
    { type: "additional_tools", tools: [{ type: "function", name: "never-retain-tool-name" }] },
  ] });
  expect(ctx.diagnostics?.attachmentBytes).toBe(5);
  expect(ctx.diagnostics?.toolDefinitionCount).toBe(1);
  expect(ctx.diagnostics?.maxOutputTokens).toBe(10);
  expect(JSON.stringify(ctx.diagnostics)).not.toContain("data:");
  expect(JSON.stringify(ctx.diagnostics)).not.toContain("never-retain-tool-name");
});

test("context observations preserve operation provenance and reject arbitrary counter labels", () => {
  const ctx = {} as RequestLogContext;
  recordContextTransformation(ctx, { kind: "developer_guidance", injected: { developer: 1, ...{ secret_prompt: 42 } } });
  recordReconstructedContext(ctx, { input: [{ role: "user" }] }, 3);
  recordContextTransformation(ctx, { kind: "media_tool_bridge", dropped: { tool_definition: 2 }, injected: { tool_definition: 1 } });
  recordContextTransformation(ctx, { kind: "raw_prompt_secret", injected: { message: 3 } });
  expect(ctx.diagnostics?.contextTransformationKinds).toEqual(["developer_guidance", "previous_response_replay", "media_tool_bridge"]);
  expect(ctx.diagnostics?.locallyInjectedItemCounts).toEqual({ developer: 1, tool_definition: 1 });
  expect(ctx.diagnostics?.droppedItemCounts).toEqual({ tool_definition: 2 });
  expect(JSON.stringify(ctx.diagnostics)).not.toContain("secret");
  expect(ctx.diagnostics?.reconstructedInputCount).toBe(1);
  expect(ctx.diagnostics?.replayedItemCount).toBe(3);
});

test("compaction telemetry requires completed output and deduplicates bridge and relay", () => {
  const ctx = {} as RequestLogContext;
  recordRequestShape(ctx, { input: [{ type: "compaction_trigger" }] });
  expect(ctx.diagnostics?.compactionOccurred).toBeUndefined();
  recordProtocolEvent(ctx, { type: "response.failed", response: { output: [{ type: "compaction" }] } });
  expect(ctx.diagnostics?.compactionOccurred).toBeUndefined();
  const before = Date.now();
  recordProtocolEvent(ctx, { type: "response.completed", response: { output: [{ type: "compaction", encrypted_content: "never-retain-this" }] } });
  recordCompletedCompaction(ctx, "upstream");
  expect(ctx.diagnostics?.compactionOccurred).toBe(true);
  expect(ctx.diagnostics?.compactionCount).toBe(1);
  expect(Number(ctx.diagnostics?.lastCompactionAt)).toBeGreaterThanOrEqual(before);
  expect(ctx.diagnostics?.events.filter(event => event.type === "context.compacted")).toHaveLength(1);
  expect(JSON.stringify(ctx.diagnostics)).not.toContain("never-retain-this");
});

test("context estimate provenance clears unavailable window and does not invent billing", () => {
  const ctx = { usageLogInputTokens: 50 } as RequestLogContext;
  recordContextEstimate(ctx, 100);
  expect(ctx.diagnostics?.contextUsageRatioEstimate).toBe(0.5);
  expect(ctx.diagnostics?.fieldAvailability.contextWindowTokens).toEqual({ status: "observed", source: "adapter" });
  recordContextEstimate(ctx);
  expect(ctx.diagnostics?.contextWindowTokens).toBeUndefined();
  expect(ctx.diagnostics?.contextUsageRatioEstimate).toBeUndefined();
  delete ctx.usageLogInputTokens;
  recordContextEstimate(ctx, 100);
  expect(ctx.diagnostics?.tokenEstimateMethod).toBeUndefined();
  expect(ctx.diagnostics?.billedUsageSource).toBeUndefined();
});
import { closeRequestHistoryIndex, requestHistoryRowById } from "../../src/routing/history/indexer";
import { requestLogDto } from "../../src/server/management/shared";
import { observeRequestTransport, recordRequestedReasoning } from "../../src/server/transaction-capture";
import { recordAuthRefresh, recordAuthSend, recordRouteAuth } from "../../src/server/transaction-auth-capture";
import { noteAttemptSend } from "../../src/server/request-log";
import { captureRetryDelay } from "../../src/server/transaction-recovery-capture";
import { applyClientIdentitySnapshot } from "../../src/server/transaction-client-capture";
import { buildResponsesWsData, selectForwardHeaders } from "../../src/server/ws-bridge";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";

test("reasoning and tier snapshots distinguish caller configuration and actual wire facts", () => {
  const ctx = { requestedEffort: "high", callerServiceTier: "priority", configuredServiceTier: "flex", requestedServiceTier: "priority" } as RequestLogContext;
  observeRequestTransport(ctx, "http");
  recordRequestedReasoning(ctx, "high", "low");
  ctx.requestedEffort = "high->medium";
  ctx.effectiveEffort = "medium";
  ctx.reasoningWireField = "reasoning.effort";
  ctx.reasoningWireValue = "medium";
  recordForwardedRequest(ctx, "http", JSON.stringify({ model: "model", reasoning: { effort: "medium" }, service_tier: "default" }));
  const send = ctx.activeAttempt?.sends?.[0];
  expect(normalizeTransactionDiagnostics(ctx.diagnostics)).toMatchObject({ callerEffort: "high", configuredEffort: "low", configuredEffortSource: "local_codex_root_config" });
  expect(send).toMatchObject({ callerEffort: "high", configuredEffort: "low", effectiveEffort: "medium", reasoningWireValue: "medium",
    callerServiceTier: "priority", configuredServiceTier: "flex", serviceTier: "default" });
  const normalizedSend = normalizeDiagnosticSends([send])[0];
  expect(normalizedSend).toMatchObject({ callerEffort: "high", configuredEffort: "low", callerServiceTier: "priority", configuredServiceTier: "flex", serviceTier: "default" });
  recordForwardedRequest(ctx, "http", JSON.stringify({ model: "model" }));
  expect(ctx.activeAttempt?.sends?.[1]?.serviceTier).toBeUndefined();
  recordForwardedRequest(ctx, "http", JSON.stringify({ model: "model", service_tier: "person@example.com" }));
  expect(ctx.activeAttempt?.sends?.[2]?.serviceTier).toBeUndefined();
  expect(JSON.stringify(ctx.activeAttempt?.sends)).not.toContain("person@example.com");
  expect(ctx.diagnostics?.responseEffort).toBeUndefined();
});

test("client identity capture reads explicit headers and more specific per-request metadata", () => {
  const ctx = {} as RequestLogContext;
  observeRequestTransport(ctx, "http", new Request("http://localhost/v1/responses", { headers: {
    "x-client-request-id": "client-first", "x-request-id": "client-alias",
    "session-id": "session-one", "x-codex-parent-thread-id": "parent-header",
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-one", turn_id: "turn-one", parent_thread_id: "parent-meta", unknown: "private-value" }),
    "user-agent": "codex_cli_rs/0.153.0 (private-hostname /private/path)",
  } }));
  recordRequestShape(ctx, { client_metadata: { thread_id: "body-thread", parent_thread_id: "body-parent", root_thread_id: "invented-root" }, input: [] });
  const d = normalizeTransactionDiagnostics(ctx.diagnostics)!;
  expect(d.clientRequestId).toBe("client-first");
  expect(d.codexThreadId).toBe("body-thread");
  expect(d.codexTurnId).toBe("turn-one");
  expect(d.codexSessionId).toBe("session-one");
  expect(d.parentThreadId).toBe("body-parent");
  expect(d.clientProduct).toBe("codex_cli_rs");
  expect(d.clientVersion).toBe("0.153.0");
  expect(d.rootThreadId).toBeUndefined();
  expect(d.fieldAvailability.rootThreadId?.status).toBe("unsupported");
  expect(d.codexCoreVersion).toBeUndefined();
  expect(d.desktopVersion).toBeUndefined();
  expect(JSON.stringify(d)).not.toMatch(/private-hostname|private-value|private\/path|invented-root/);
});

test("path syntax in client identity is redacted across capture and normalization", () => {
  for (const value of ["../../Users/" + "alice/.codex/auth.json", "../../etc/passwd", "./secrets/key",
    "route/../secrets/key", "route/./key", "~/private/key", "~alice/private/key",
    ".codex/auth.json", "route/..", "route/.private", "/private/key", "..\\secrets\\key", "C:private/key"]) {
    const ctx = {} as RequestLogContext;
    observeRequestTransport(ctx, "http", new Request("http://localhost", { headers: { "thread-id": value } }));
    recordRequestShape(ctx, { previous_response_id: value, client_metadata: { session_id: value } });
    const d = normalizeTransactionDiagnostics(ctx.diagnostics)!;
    for (const field of ["codexThreadId", "codexSessionId", "previousResponseId", "originalPreviousResponseId"]) {
      expect(d[field]).toBeUndefined();
      expect(d.fieldAvailability[field]?.status).toBe("redacted");
    }
    expect(JSON.stringify(d)).not.toContain(value);
    const raw = createTransactionDiagnostics({ requestId: "ocx-path-identity", receivedAt: 1_000 });
    Object.assign(raw, { codexThreadId: value, previousResponseId: value });
    const normalized = normalizeTransactionDiagnostics(raw)!;
    expect(normalized.codexThreadId).toBeUndefined();
    expect(normalized.previousResponseId).toBeUndefined();
    expect(normalized.fieldAvailability.codexThreadId?.status).toBe("redacted");
  }
});

test("continuation presence survives identifier redaction and truncation", () => {
  for (const value of ["person@example.com", "https://private.example/key", "resp_" + "x".repeat(MAX_DIAGNOSTIC_ID_BYTES)]) {
    const ctx = {} as RequestLogContext;
    const body = { previous_response_id: value, input: [] };
    recordRequestShape(ctx, body);
    recordRequestShape(ctx, body, undefined, true);
    const d = normalizeTransactionDiagnostics(ctx.diagnostics)!;
    expect(d.previousResponseUsed).toBe(true);
    expect(d.continuationMode).toBe("previous_response");
    expect(d.previousResponseId).toBeUndefined();
    expect(d.originalPreviousResponseId).toBeUndefined();
    expect(d.forwardedPreviousResponseId).toBeUndefined();
    expect(d.previousResponseRewriteApplied).toBeUndefined();
    expect(d.fieldAvailability.previousResponseId?.status).toBe(value.startsWith("resp_") ? "truncated" : "redacted");
    expect(body.previous_response_id).toBe(value);
  }
  for (const value of [undefined, null, ""]) {
    const ctx = {} as RequestLogContext;
    recordRequestShape(ctx, { previous_response_id: value, input: [] });
    expect(ctx.diagnostics?.previousResponseUsed).toBe(false);
    expect(ctx.diagnostics?.continuationMode).toBe("explicit_input");
  }
});

test("WebSocket metadata and invalid client identifiers remain bounded and privacy safe", () => {
  const ctx = {} as RequestLogContext;
  observeRequestTransport(ctx, "websocket", new Request("http://localhost/v1/responses", { headers: {
    "x-codex-parent-thread-id": "person@example.com", "user-agent": "unknown/1.2.3 private",
    "x-codex-turn-metadata": "[1,2,3]",
  } }));
  recordRequestShape(ctx, { client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "frame-thread", session_id: "frame-session" }),
    agent_id: "invented-agent", client_version: "invented-version",
  } });
  const d = normalizeTransactionDiagnostics(ctx.diagnostics)!;
  expect(d.codexThreadId).toBe("frame-thread");
  expect(d.codexSessionId).toBe("frame-session");
  expect(d.parentThreadId).toBeUndefined();
  expect(d.fieldAvailability.parentThreadId?.status).toBe("redacted");
  expect(d.clientVersion).toBeUndefined();
  expect(d.fieldAvailability.clientVersion?.status).toBe("not_observed");
  expect(d.agentId).toBeUndefined();
  expect(JSON.stringify(d)).not.toMatch(/person@example|conceal-redaction|invented-agent|invented-version/);
  const oversized = {} as RequestLogContext;
  observeRequestTransport(oversized, "http", new Request("http://localhost", { headers: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "x".repeat(17000) }),
  } }));
  expect(oversized.diagnostics?.codexThreadId).toBeUndefined();
});

test("WebSocket upgrade preserves sanitized identity separately from forward headers across turns", () => {
  const headers = new Headers({ "user-agent": "codex_vscode/0.153.0 (private-machine)",
    "x-codex-turn-id": "upgrade-turn", "x-request-id": "upgrade-request",
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-one" }),
  });
  const forwarded = selectForwardHeaders(headers);
  const socket = buildResponsesWsData(forwarded, { kind: "loopback" } as DataPlaneAdmission, undefined, undefined, headers);
  expect(socket.headers?.has("user-agent")).toBe(false);
  expect(socket.headers?.has("x-request-id")).toBe(false);
  expect(JSON.stringify(socket.clientIdentitySnapshot)).not.toContain("private-machine");
  for (const turn of ["turn-one", "turn-two"]) {
    const ctx = {} as RequestLogContext;
    observeRequestTransport(ctx, "websocket", new Request("http://localhost/v1/responses", { headers: forwarded }));
    applyClientIdentitySnapshot(ctx.diagnostics, socket.clientIdentitySnapshot);
    recordRequestShape(ctx, { client_metadata: { turn_id: turn } });
    const d = normalizeTransactionDiagnostics(ctx.diagnostics)!;
    expect(d.clientProduct).toBe("codex_vscode");
    expect(d.clientVersion).toBe("0.153.0");
    expect(d.clientRequestId).toBe("upgrade-request");
    expect(d.codexThreadId).toBe("thread-one");
    expect(d.codexTurnId).toBe(turn);
  }
  expect(socket.clientIdentitySnapshot?.fields.codexTurnId).toBe("upgrade-turn");
});

test("recovery reasons belong to each actual dispatch, including repeated recovery kinds", () => {
  const ctx: RequestLogContext = { provider: "test", model: "test",
    activeAttempt: beginRequestAttempt(1, "test", "test", "openai-responses") };
  observeRequestTransport(ctx, "http");
  for (const reason of [undefined, "transient-5xx", "connection-reset", "transient-5xx", undefined] as const) {
    noteAttemptSend(ctx.activeAttempt, undefined, reason);
    recordForwardedRequest(ctx, "http");
  }
  expect(ctx.activeAttempt?.sends?.map(send => send.retryReason)).toEqual([
    undefined, "transient-5xx", "connection-reset", "transient-5xx", undefined,
  ]);
  expect(ctx.activeAttempt?.sends?.map(send => send.recoveryReason)).toEqual([
    undefined, "transient-5xx", "connection-reset", "transient-5xx", undefined,
  ]);
  expect(ctx.activeAttempt?.recoveryKinds).toEqual(["transient-5xx", "connection-reset"]);
  expect(ctx.diagnostics?.retryDecision).toBe("retry_dispatched");
  expect(ctx.diagnostics?.recoveryReason).toBe("transient-5xx");
  expect(ctx.diagnostics?.retryBudgetRemaining).toBeUndefined();
  expect(ctx.diagnostics?.fieldAvailability.retryBudgetRemaining?.status).toBe("unsupported");
});

test("scheduled retry delay and restored state require positive owner evidence", () => {
  const ctx: RequestLogContext = { provider: "test", model: "test" };
  observeRequestTransport(ctx, "http");
  recordReconstructedContext(ctx, { previous_response_id: "response-prior", input: [] }, 0);
  expect(ctx.diagnostics?.stateRestored).toBeUndefined();
  expect(ctx.diagnostics?.fieldAvailability.stateRestored?.status).toBe("not_observed");
  expect(captureRetryDelay(ctx, 120)).toBe(120);
  expect(ctx.diagnostics?.retryDelayMs).toBe(120);
  expect(ctx.diagnostics?.retryDecision).toBe("retry_wait_scheduled");
  expect(captureRetryDelay(ctx, Number.NaN)).toBeNaN();
  expect(ctx.diagnostics?.retryDelayMs).toBe(120);
  recordReconstructedContext(ctx, { input: [{ role: "user", content: "private-content" }] }, 1);
  expect(ctx.diagnostics?.stateRestored).toBe(true);
  expect(ctx.diagnostics?.stateRestoreSource).toBe("previous_response_replay");
  expect(ctx.diagnostics?.resumeMode).toBe("local_replay");
  expect(JSON.stringify(normalizeTransactionDiagnostics(ctx.diagnostics))).not.toContain("private-content");
  expect(normalizeTransactionDiagnostics(ctx.diagnostics)?.stateRestoreSource).toBe("previous_response_replay");
});

test("auth capture observes resolved facts without retaining account identities", () => {
  const ctx = { diagnostics: createTransactionDiagnostics({ requestId: "auth-test" }) } as RequestLogContext;
  recordRouteAuth(ctx, "forward", { kind: "pool", fixedAccount: true });
  expect(ctx.diagnostics?.authMode).toBe("forward");
  expect(ctx.diagnostics?.accountSelectionSource).toBe("explicit_selector");
  expect(ctx.diagnostics?.fieldAvailability.accountAffinity?.status).toBe("not_observed");
  expect(ctx.diagnostics?.accountPoolSelectionReason).toBeUndefined();
  ctx.accountLogLabel = "raw-private-account";
  recordAuthSend(ctx);
  expect(ctx.diagnostics?.accountPseudonym).toBeUndefined();
  recordRouteAuth(ctx, "oauth");
  expect(ctx.diagnostics?.accountSelectionSource).toBeUndefined();
  recordRouteAuth(ctx, "untrusted-auth-mode");
  expect(ctx.diagnostics?.authMode).toBeUndefined();
  recordAuthRefresh(ctx, "failed");
  const normalized = normalizeTransactionDiagnostics(ctx.diagnostics)!;
  expect(normalized.authRefreshOccurred).toBe(true);
  expect(normalized.authRefreshResult).toBe("failed");
  expect(JSON.stringify(normalized)).not.toContain("raw-private-account");
});

test("account changes require sends from distinct observed attempt owners", () => {
  const ctx = { diagnostics: createTransactionDiagnostics({ requestId: "auth-change" }) } as RequestLogContext;
  ctx.activeAttempt = beginRequestAttempt(1, "provider", "model", "adapter");
  ctx.accountLogLabel = "pabcdef";
  recordForwardedRequest(ctx, "http");
  expect(ctx.diagnostics?.accountPseudonym).toBe("pabcdef");
  expect(ctx.diagnostics?.accountChangedBetweenAttempts).toBeUndefined();
  ctx.accountLogLabel = "p123456";
  recordForwardedRequest(ctx, "http");
  expect(ctx.diagnostics?.accountChangedBetweenAttempts).toBeUndefined();
  ctx.activeAttempt = beginRequestAttempt(2, "provider", "model", "adapter");
  recordForwardedRequest(ctx, "websocket");
  expect(ctx.diagnostics?.accountChangedBetweenAttempts).toBe(false);
  ctx.activeAttempt = beginRequestAttempt(3, "provider", "model", "adapter");
  ctx.accountLogLabel = "main";
  recordForwardedRequest(ctx, "http");
  expect(ctx.diagnostics?.accountChangedBetweenAttempts).toBe(true);
  ctx.accountLogLabel = undefined;
  ctx.activeAttempt = beginRequestAttempt(4, "provider", "model", "adapter");
  recordForwardedRequest(ctx, "http");
  expect(ctx.diagnostics?.accountPseudonym).toBeUndefined();
  expect(ctx.diagnostics?.accountChangedBetweenAttempts).toBe(true);
});

test("missing account observations prevent a later false no-change claim", () => {
  const ctx = { diagnostics: createTransactionDiagnostics({ requestId: "auth-unknown" }) } as RequestLogContext;
  ctx.activeAttempt = beginRequestAttempt(1, "provider", "model", "adapter");
  recordAuthSend(ctx);
  ctx.accountLogLabel = "main";
  ctx.activeAttempt = beginRequestAttempt(2, "provider", "model", "adapter");
  recordAuthSend(ctx);
  ctx.activeAttempt = beginRequestAttempt(3, "provider", "model", "adapter");
  recordAuthSend(ctx);
  expect(ctx.diagnostics?.accountChangedBetweenAttempts).toBeUndefined();
  expect(ctx.diagnostics?.fieldAvailability.accountChangedBetweenAttempts?.status).toBe("not_observed");
});

let home = "";
let previousHome: string | undefined;

test("upstream hostname normalization accepts only closed diagnostic classes", () => {
  const base = createTransactionDiagnostics({ requestId: "host-class", receivedAt: Date.now() });
  for (const host of ["tenant.example", "api.openai.com", "localhost", "127.0.0.1", "a-secret-token"]) {
    expect(normalizeTransactionDiagnostics({ ...base, upstreamHostname: host })?.upstreamHostname).toBeUndefined();
  }
  expect(normalizeTransactionDiagnostics({ ...base, upstreamHostname: "custom" })?.upstreamHostname).toBe("custom");
});

test("stream facts separate event IDs, acceptance and delivery evidence", async () => {
  const { recordForwardedRequest, recordProtocolEvent, finalizeDiagnostics, recordDeliveredOutput,
    recordDownstreamTerminal } = await import("../../src/server/transaction-capture");
  const ctx: import("../../src/server/request-log").RequestLogContext = { provider: "openai", model: "test" };
  recordForwardedRequest(ctx, "websocket");
  recordProtocolEvent(ctx, { type: "response.created", id: "event-not-response", event_id: "evt-created",
    sequence_number: 0, response: { id: "resp-accepted" } }, 0, true);
  expect(ctx.diagnostics?.upstreamRequestAccepted).toBe(true);
  expect(ctx.diagnostics?.upstreamResponseId).toBe("resp-accepted");
  expect(ctx.diagnostics?.upstreamEventId).toBe("evt-created");
  expect(ctx.diagnostics?.events.at(-1)?.eventId).toBe("evt-created");
  expect(ctx.activeAttempt?.sends?.[0]?.upstreamEventId).toBe("evt-created");
  recordProtocolEvent(ctx, { type: "response.failed", response: { id: "resp-accepted" } }, 0, true);
  ctx.firstOutputMs = 2; // Upstream TTFT is not downstream delivery.
  finalizeDiagnostics(ctx, 400, "failure", Date.now(), true);
  expect(ctx.diagnostics?.outputDeliveredBeforeFailure).toBeUndefined();
  expect(ctx.diagnostics?.downstreamTerminalSentAt).toBeUndefined();
  recordDeliveredOutput(ctx, "response.output_text.delta");
  recordDownstreamTerminal(ctx);
  finalizeDiagnostics(ctx, 400, "failure", Date.now(), true);
  expect(ctx.diagnostics?.outputDeliveredBeforeFailure).toBe(true);
  expect(ctx.diagnostics?.lastOutputKind).toBe("text");
  expect(ctx.diagnostics?.downstreamTerminalSentAt).toBeNumber();
});

test("stream facts reject unknown event values and synthetic IDs", async () => {
  const { recordForwardedRequest, recordProtocolEvent } = await import("../../src/server/transaction-capture");
  const ctx: import("../../src/server/request-log").RequestLogContext = { provider: "openai", model: "test" };
  recordForwardedRequest(ctx, "http");
  recordProtocolEvent(ctx, { type: "untrusted-private-text", id: "event-only", sequence_number: -2 }, 0, true);
  expect(ctx.diagnostics?.upstreamResponseId).toBeUndefined();
  expect(ctx.diagnostics?.protocolEventType).toBe("unknown");
  expect(ctx.diagnostics?.lastEventSequence).toBeUndefined();
  recordProtocolEvent(ctx, { type: "response.failed", event_id: "synthetic-id" }, 0, false, true);
  expect(ctx.diagnostics?.upstreamEventId).toBeUndefined();
  expect(JSON.stringify(ctx.diagnostics)).not.toContain("untrusted-private-text");
});

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
  test("retains turn replacement cancellation through normalization", () => {
    const raw = createTransactionDiagnostics({ receivedAt: 1 });
    raw.cancellationReason = "turn_replaced";
    expect(normalizeTransactionDiagnostics(raw)?.cancellationReason).toBe("turn_replaced");
  });

  test("only retains integer HTTP statuses in the protocol range", () => {
    for (const field of ["httpStatus", "websocketHandshakeStatus", "terminalMappedStatus"] as const) {
      for (const status of [0, 99, 200.5, 600, Infinity, NaN]) {
        const raw = createTransactionDiagnostics({ receivedAt: 1 });
        raw[field] = status;
        raw.fieldAvailability[field] = { status: "observed", source: "transport" };
        const normalized = normalizeTransactionDiagnostics(raw)!;
        expect(normalized[field]).toBeUndefined();
        expect(normalized.fieldAvailability[field]?.status).not.toBe("observed");
      }
      for (const status of [100, 101, 200, 499, 599]) {
        const raw = createTransactionDiagnostics({ receivedAt: 1 });
        raw[field] = status;
        expect(normalizeTransactionDiagnostics(raw)?.[field]).toBe(status);
      }
    }
  });

  test("reports capped diagnostic lists and counter maps", () => {
    for (const count of [64, 65, 200]) {
      const raw = createTransactionDiagnostics({ receivedAt: 1 });
      raw.derivedFields = Array.from({ length: count }, (_, i) => `field${i}`);
      raw.outputItemCountsByType = Object.fromEntries(raw.derivedFields.map(name => [name, 1]));
      const normalized = normalizeTransactionDiagnostics(raw)!;
      expect(normalized.derivedFields).toHaveLength(64);
      expect(Object.keys(normalized.outputItemCountsByType!)).toHaveLength(64);
      expect(normalized.captureTruncated).toBe(count > 64);
      if (count > 64) {
        expect(normalized.fieldAvailability.derivedFields?.status).toBe("truncated");
        expect(normalized.fieldAvailability.outputItemCountsByType?.status).toBe("truncated");
        expect(normalizeTransactionDiagnostics(normalized)?.captureTruncated).toBe(true);
      }
    }
  });
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

describe("bounded upstream facts", () => {
  const fresh = () => createTransactionDiagnostics({ requestId: "facts-test", receivedAt: 1 });

  test("captures approved header identities and explicit finite limits only", () => {
    const d = fresh();
    captureUpstreamHeaders(d, new Headers({
      "x-request-id": "req_facts", "x-ratelimit-limit-requests": "42",
      "x-ratelimit-limit-tokens": "Infinity", "retry-after": "1.5",
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      "x-private-header": "private-header-value", authorization: "private-auth-value",
    }));
    expect(normalizeTransactionDiagnostics(d)).toMatchObject({ upstreamRequestId: "req_facts",
      requestIdHeader: "x-request-id", requestLimit: 42, retryAfterMs: 1500,
      traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef",
      upstreamTraceHeaders: ["traceparent"] });
    expect(d.tokenLimit).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("private");
  });

  test("redacts unsafe IDs and rejects freeform error values and parameter names", () => {
    const d = fresh();
    captureUpstreamHeaders(d, new Headers({ "x-request-id": "sk-" + "abcdefghijklmnopqrstuvwxyz" }));
    captureUpstreamPayloadFacts(d, { response: { error: { code: "cyber_policy", type: "server_error",
      param: "private_field", message: "private-body-text", retryable: false,
      retry_after_ms: 125, request_limit: 3, mystery: { secret: "private-value" } } } });
    expect(d).toMatchObject({ upstreamErrorCode: "cyber_policy", errorType: "server_error",
      errorEnvelopeSchema: "response.error", retryable: false, retryAfterMs: 125, requestLimit: 3,
      unknownErrorFieldNames: ["mystery"] });
    expect(d.upstreamRequestId).toBeUndefined();
    expect(d.errorMessage).toBeUndefined();
    captureUpstreamPayloadFacts(d, { error: { message: "😀".repeat(126) } });
    expect(d.errorMessageTruncated).toBe(true);
    expect(d.errorMessage).toBeUndefined();
    expect(d.errorParam).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("private");
    captureUpstreamPayloadFacts(d, { error: { code: "arbitrary_private_token", type: "arbitrary_private_token" } });
    expect(d.upstreamErrorCode).toBeUndefined();
    expect(d.errorType).toBeUndefined();
  });

  test("bounds unknown key inspection and never reads unknown values or getters", () => {
    const d = fresh();
    const error: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) Object.defineProperty(error, `field_${i}`, {
      enumerable: true, get: () => { throw new Error("unknown value read"); },
    });
    Object.defineProperty(error, "message", { get: () => { throw new Error("message read"); } });
    expect(() => captureUpstreamPayloadFacts(d, { error })).not.toThrow();
    expect(d.unknownErrorFieldNames).toHaveLength(64);
    expect(d.captureTruncated).toBe(true);
  });

  test("usage completeness reflects valid counters, including zero, without billing claims", () => {
    const d = fresh();
    captureUpstreamPayloadFacts(d, { type: "response.created" });
    expect(d.usagePartial).toBeUndefined();
    captureUpstreamPayloadFacts(d, { usage: { input_tokens: 0 } });
    expect(d).toMatchObject({ usagePartial: true, usageMissingCount: 1, usageSource: "upstream" });
    captureUpstreamPayloadFacts(d, { usage: { prompt_tokens: 0, completion_tokens: 0 } });
    expect(d).toMatchObject({ usagePartial: false, usageMissingCount: 0 });
    expect(d.usageMissingReason).toBeUndefined();
    captureUpstreamPayloadFacts(d, { type: "response.failed", response: { usage: { input_tokens: -1, output_tokens: "5" } } });
    expect(d).toMatchObject({ usagePartial: false, usageMissingCount: 2 });
    expect(d.billedUsageSource).toBeUndefined();
    expect(d.subscriptionPlan).toBeUndefined();
    expect(d.cyberAccessStatus).toBeUndefined();
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
      endpointClass: "responses", upstreamHostname: "custom", method: "POST",
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
describe("bounded caller and forwarded request shape", () => {
  test("keeps Messages blocks and structured UTF-8 results distinct from forwarded Responses", async () => {
    const { recordRequestShape } = await import("../../src/server/transaction-capture");
    const ctx = {} as import("../../src/server/request-log").RequestLogContext;
    const content = [{ type: "text", text: "secret é 😀\n\u0000" }, { type: "image", source: { type: "base64", data: "AQID" } }];
    const caller = { messages: [{ role: "assistant", content: [{ type: "tool_use", name: "secret-name" }, { type: "thinking", thinking: "secret" }, { type: "redacted_thinking", data: "secret" }] },
      { role: "user", content: [{ type: "tool_result", content }] }], tools: [{}] };
    const before = JSON.stringify(caller);
    recordRequestShape(ctx, caller, 987);
    recordRequestShape(ctx, { input: [{ type: "function_call_output", output: "ok" }] }, 123, true);
    const d = ctx.diagnostics!;
    expect(d.inputItemCount).toBe(2);
    expect(d.messageCount).toBe(2);
    expect(d.toolCallCount).toBe(1);
    expect(d.toolResultCount).toBe(1);
    expect(d.reasoningItemCount).toBe(2);
    expect(d.encryptedItemCount).toBe(1);
    expect(d.imageCount).toBe(1);
    expect(d.attachmentBytes).toBe(3);
    expect(d.toolResultBytes).toBe(Buffer.byteLength(JSON.stringify(content)));
    expect(d.forwardedInputItemCount).toBe(1);
    expect(d.forwardedMessageCount).toBe(0);
    expect(d.forwardedToolResultBytes).toBe(2);
    expect(d.requestBytes).toBe(987);
    expect(d.forwardedRequestBytes).toBe(123);
    expect(JSON.stringify(caller)).toBe(before);
    expect(JSON.stringify(d)).not.toContain("secret");
  });

  test("bounds structured results without invoking serialization and leaves remote sizes unknown", async () => {
    const { recordRequestShape } = await import("../../src/server/transaction-capture");
    const ctx = {} as import("../../src/server/request-log").RequestLogContext;
    let invoked = false;
    const output = { nested: { text: "x".repeat(1024 * 1024 + 1) }, toJSON() { invoked = true; throw new Error("do not serialize"); } };
    recordRequestShape(ctx, { input: [{ type: "function_call_output", output }, { type: "message", content: [{ type: "input_image", image_url: "https://example.invalid/private" }] }] });
    expect(invoked).toBe(false);
    expect(ctx.diagnostics!.toolResultBytes).toBeUndefined();
    expect(ctx.diagnostics!.fieldAvailability.toolResultBytes?.status).toBe("not_observed");
    expect(ctx.diagnostics!.attachmentBytes).toBeUndefined();
    expect(ctx.diagnostics!.fieldAvailability.attachmentBytes?.status).toBe("not_observed");
  });

  test("marks every partial classification and refreshes forwarded availability", async () => {
    const { recordRequestShape } = await import("../../src/server/transaction-capture");
    const ctx = {} as import("../../src/server/request-log").RequestLogContext;
    recordRequestShape(ctx, { input: "hello" });
    recordRequestShape(ctx, { messages: [{ role: "user", content: Array.from({ length: 3000 }, () => ({ type: "input_audio", input_audio: { data: "AQI=" } })) }] }, undefined, true);
    expect(ctx.diagnostics!.forwardedInputItemCount).toBe(1);
    expect(ctx.diagnostics!.fieldAvailability.forwardedAudioCount?.status).toBe("truncated");
    expect(ctx.diagnostics!.fieldAvailability.forwardedFileCount?.status).toBe("truncated");
    expect(ctx.diagnostics!.fieldAvailability.forwardedInputItemCount).toBeUndefined();
    recordRequestShape(ctx, { messages: [{ role: "assistant", tool_calls: [{}, {}], content: [] }, { role: "tool", content: "é" }] }, undefined, true);
    expect(ctx.diagnostics!.inputItemCount).toBe(1);
    expect(ctx.diagnostics!.forwardedToolCallCount).toBe(2);
    expect(ctx.diagnostics!.forwardedToolResultBytes).toBe(2);
    expect(ctx.diagnostics!.fieldAvailability.forwardedAudioCount).toBeUndefined();
  });

  test("matches JSON sizes for escapes, keys, primitives, nested arrays and lone surrogates", async () => {
    const { summarizeRequestShape } = await import("../../src/server/request-shape");
    for (const output of [null, { "é\n": [true, false, null, 123.5, "\ud800", "\b\t\r\f\"\\"] }, [], {}, [1, ["😀"]]]) {
      const shape = summarizeRequestShape({ input: [{ type: "function_call_output", output }] });
      expect(shape.values.toolResultBytes).toBe(Buffer.byteLength(JSON.stringify(output)));
    }
  });
  test("compact encrypted inputs and nested media use the same structural observer", async () => {
    const { summarizeRequestShape } = await import("../../src/server/request-shape");
    const shape = summarizeRequestShape({ input: [{ type: "compaction", encrypted_content: "private" },
      { type: "reasoning", encrypted_content: "private" }, { role: "user", content: [
        { type: "input_audio", input_audio: { data: "AQI=" } }, { type: "document", source: { type: "base64", data: "AQ==" } },
      ] }] });
    expect(shape.values.encryptedItemCount).toBe(2);
    expect(shape.values.reasoningItemCount).toBe(1);
    expect(shape.values.audioCount).toBe(1);
    expect(shape.values.fileCount).toBe(1);
    expect(shape.values.attachmentBytes).toBe(3);
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(summarizeRequestShape({ input: [{ type: "function_call_output", output: cyclic }] }).values.toolResultBytes).toBeUndefined();
  });
});
