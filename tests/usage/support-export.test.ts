import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import {
  SUPPORT_EXPORT_MAX_BYTES,
  SUPPORT_EXPORT_MAX_RECORDS,
  buildSupportExport,
} from "../../src/diagnostics/support-export";
import type { PersistedUsageEntry } from "../../src/usage/log";

function policyEntry(requestId = "ocx-policy", timestamp = 1_500): PersistedUsageEntry {
  return {
    requestId,
    timestamp,
    provider: "openai",
    model: "gpt-5.6-sol",
    requestedModel: "gpt-5.6-sol",
    resolvedModel: "gpt-5.6-sol",
    accountLogLabel: "p123abc",
    conversationId: "private-shared-id",
    status: 400,
    durationMs: 250,
    usageStatus: "unreported",
    errorCode: "policy_rejected",
    upstreamError: "Bearer secret should never survive",
    attempts: [{
      ordinal: 1,
      attemptId: "ocx-attempt-1",
      attemptStartedAt: 1_510,
      attemptEndedAt: 1_740,
      provider: "openai",
      model: "gpt-5.6-sol",
      adapter: "openai-responses",
      status: 400,
      durationMs: 230,
      sendCount: 1,
      sends: [{
        sendId: "ocx-send-1",
        sendOrdinal: 1,
        startedAt: 1_520,
        endedAt: 1_730,
        upstreamRequestId: "private-shared-id",
        upstreamResponseId: "private-response",
        status: 400,
      }],
      recoveryKinds: [],
      usageStatus: "unreported",
      accountLogLabel: "p123abc",
    }],
    diagnostics: {
      schemaVersion: 1,
      diagnosticCaptureVersion: 1,
      transactionId: "ocx-txn-1",
      recordKind: "request",
      correlationSource: "mixed",
      correlationConfidence: "direct",
      receivedAt: timestamp,
      timestampSource: "proxy_wall_clock",
      codexThreadId: "private-shared-id",
      codexTurnId: "private-turn",
      upstreamResponseId: "private-response",
      connectionId: "private-connection",
      traceId: "private-trace",
      errorMessage: "https://evil.example/failure?token=secret",
      requestIdHeader: "Bearer header-secret",
      events: [{
        eventSequence: 1,
        type: "response.failed",
        at: 1_730,
        source: "upstream",
        responseId: "private-response",
      }],
      fieldAvailability: {},
      droppedDiagnosticEventCount: 0,
      captureTruncated: false,
      redactionApplied: true,
      redactionVersion: 1,
      retentionClass: "usage_ledger",
      unknownFutureField: "/home/person/private.txt",
    },
  };
}

describe("transaction support export", () => {
  test("keeps caller and configured reasoning and tiers distinct from wire settings", () => {
    const row = policyEntry();
    Object.assign(row.diagnostics!, {
      callerEffort: "low", configuredEffort: "high",
      configuredEffortSource: "local_codex_root_config",
    });
    Object.assign(row.attempts![0]!.sends![0]!, {
      callerEffort: "low", configuredEffort: "high", effectiveEffort: "medium",
      callerServiceTier: "priority", configuredServiceTier: "flex", serviceTier: "default",
    });
    const bundle = buildSupportExport({ requestIds: [row.requestId] }, [row]);
    expect(bundle.records[0]).toMatchObject({
      diagnostics: { callerEffort: "low", configuredEffort: "high", configuredEffortSource: "local_codex_root_config" },
      attempts: [{ sends: [{ callerEffort: "low", configuredEffort: "high", effectiveEffort: "medium",
        callerServiceTier: "priority", configuredServiceTier: "flex", serviceTier: "default" }] }],
    });
  });
  test("availability metadata does not stand in for captured values", () => {
    const row = policyEntry();
    row.diagnostics!.fieldAvailability = {
      subscriptionPlan: { status: "unknown", source: "upstream" },
      modelSwitchApplied: { status: "unsupported", source: "proxy" },
      policyEventId: { status: "unknown", source: "upstream" },
    };
    row.diagnostics!.modelSwitchRequested = false;
    const bundle = buildSupportExport({ requestIds: [row.requestId] }, [row]);
    expect(bundle.unavailableFields).toEqual(expect.arrayContaining([
      "subscriptionPlan", "modelSwitchApplied", "policyEventId",
    ]));
    expect(bundle.unavailableFields).not.toContain("modelSwitchRequested");
  });

  test("pseudonymizes revisions and trace IDs while preserving approved header names", () => {
    const row = policyEntry();
    const fields = ["proxyCommit", "proxyBuildId", "proxyInstanceId", "configRevision",
      "routeConfigRevision", "modelCatalogRevision", "routeDecisionId", "selectedCandidate",
      "settingsRevision", "requestSettingsRevision"];
    for (const field of fields) row.diagnostics![field] = "private-revision";
    row.diagnostics!.requestIdHeader = "x-request-id";
    row.diagnostics!.upstreamTraceHeaders = ["x-trace-id", "traceparent", "private-trace", "Bearer secret", "/home/private"];
    row.diagnostics!.modelSwitchAppliedAt = 1_600;
    row.diagnostics!.contextUsageRatioEstimate = 0.75;
    const first = buildSupportExport({ requestIds: [row.requestId] }, [row]);
    const second = buildSupportExport({ requestIds: [row.requestId] }, [row]);
    const diagnostic = first.records[0]!.diagnostics as Record<string, any>;
    for (const field of fields) expect(diagnostic[field]).toMatch(/^psn_[a-f0-9]{24}$/);
    expect(diagnostic.requestSettingsRevision).toBe(diagnostic.configRevision);
    expect(diagnostic.upstreamTraceHeaders).toEqual(["x-trace-id", "traceparent"]);
    expect(diagnostic.requestIdHeader).toBe("x-request-id");
    expect(diagnostic.traceId).toMatch(/^psn_[a-f0-9]{24}$/);
    expect(diagnostic.modelSwitchAppliedAt).toBe(1_600);
    expect(diagnostic.contextUsageRatioEstimate).toBe(0.75);
    expect(JSON.stringify(first)).not.toContain("private-revision");
    expect(first.records).not.toEqual(second.records);
  });

  test("distinguishes validation exclusions from byte truncation", () => {
    const row = policyEntry();
    row.model = "/home/private";
    const bundle = buildSupportExport({ requestIds: [row.requestId] }, [row]);
    expect(bundle.records).toHaveLength(0);
    expect(bundle.gaps).toContainEqual({ kind: "record_validation", omittedRecordCount: 1 });
    expect(bundle.gaps.some(gap => gap.kind === "byte_limit")).toBe(false);
    expect(bundle.exportCompleteness).toBe("partial");
  });

  test("preserves forwarded request shape counts without payload data", () => {
    const row = policyEntry();
    const fields = ["forwardedInputItemCount", "forwardedConversationItemCount", "forwardedMessageCount",
      "forwardedToolDefinitionCount", "forwardedToolCallCount", "forwardedToolResultCount",
      "forwardedReasoningItemCount", "forwardedEncryptedItemCount", "forwardedImageCount",
      "forwardedAudioCount", "forwardedFileCount", "forwardedAttachmentBytes",
      "forwardedToolResultBytes", "forwardedLargestToolResultBytes"];
    fields.forEach((field, index) => { row.diagnostics![field] = index; });
    row.diagnostics!.forwardedInput = [{ content: "private-payload" }];
    const bundle = buildSupportExport({ requestIds: [row.requestId] }, [row]);
    const diagnostic = bundle.records[0]!.diagnostics as Record<string, unknown>;
    fields.forEach((field, index) => { expect(diagnostic[field]).toBe(index); });
    expect(JSON.stringify(bundle)).not.toContain("private-payload");
  });

  test("reports incomplete canonical scans even when a selected request is found", () => {
    const row = policyEntry();
    const bundle = buildSupportExport({ requestIds: [row.requestId] }, [row], {
      canonicalScanIncomplete: true,
    });
    expect(bundle.records).toHaveLength(1);
    expect(bundle.gaps).toContainEqual({ kind: "log_coverage", omittedRecordCount: 0 });
    expect(bundle.exportCompleteness).toBe("partial");
  });

  test("computes coverage over large canonical ledgers without argument spreading", () => {
    const row: PersistedUsageEntry = {
      requestId: "old", timestamp: 1_000, provider: "a", model: "m",
      status: 200, durationMs: 1, usageStatus: "unsupported",
    };
    const bundle = buildSupportExport(
      { requestIds: ["missing"] }, Array.from({ length: 200_000 }, () => row),
      { generatedAt: 2_000, pseudonymKey: new Uint8Array(32) },
    );
    expect(bundle.logCoverageStart).toBe(1_000);
    expect(bundle.logCoverageEnd).toBe(1_000);
    expect(bundle.records).toHaveLength(0);
  });

  test("allowlists fields, keeps proxy IDs, and reports unavailable evidence", () => {
    const bundle = buildSupportExport(
      { requestIds: ["ocx-policy"] },
      [policyEntry()],
      { generatedAt: 2_000, pseudonymKey: new Uint8Array(32) },
    );
    const serialized = JSON.stringify(bundle);

    expect(bundle.exportSchemaVersion).toBe(1);
    expect(bundle.records).toHaveLength(1);
    expect(bundle.records[0]).toMatchObject({
      requestId: "ocx-policy",
      diagnostics: { transactionId: "ocx-txn-1" },
      attempts: [{ attemptId: "ocx-attempt-1", sends: [{ sendId: "ocx-send-1" }] }],
    });
    expect(bundle.unavailableFields).toContain("policyEventId");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("evil.example");
    expect(serialized).not.toContain("/home/person");
    expect(serialized).not.toContain("unknownFutureField");
    expect(bundle.relatedIssueUrls).toEqual([
      "https://github.com/openai/codex/issues/43131",
      "https://github.com/openai/codex/issues/42906",
    ]);
    expect((serialized.match(/https?:\/\//g) ?? [])).toHaveLength(2);
  });

  test("re-pseudonymizes private identifiers consistently with an unexported per-bundle key", () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const first = buildSupportExport(
      { requestIds: ["ocx-policy"] },
      [policyEntry()],
      { generatedAt: 2_000, pseudonymKey: key },
    );
    const again = buildSupportExport(
      { requestIds: ["ocx-policy"] },
      [policyEntry()],
      { generatedAt: 2_000, pseudonymKey: key },
    );
    const other = buildSupportExport(
      { requestIds: ["ocx-policy"] },
      [policyEntry()],
      { generatedAt: 2_000, pseudonymKey: new Uint8Array(32).fill(9) },
    );
    const record = first.records[0] as Record<string, any>;

    expect(record.conversationId).toBe(record.diagnostics.codexThreadId);
    expect(record.diagnostics.upstreamResponseId).toBe(record.diagnostics.events[0].responseId);
    expect(record.diagnostics.upstreamResponseId).toBe(record.attempts[0].sends[0].upstreamResponseId);
    expect(JSON.stringify(first)).not.toContain("private-shared-id");
    expect(JSON.stringify(first)).not.toContain("private-response");
    expect(JSON.stringify(first)).not.toContain(Buffer.from(key).toString("hex"));
    expect(again.records).toEqual(first.records);
    expect(other.records).not.toEqual(first.records);
  });

  test("reports missing request selections and old-row diagnostic gaps", () => {
    const bundle = buildSupportExport(
      { requestIds: ["old", "missing"] },
      [{
        requestId: "old", timestamp: 1_000, provider: "a", model: "m",
        status: 200, durationMs: 1, usageStatus: "unsupported",
      }],
      { generatedAt: 2_000, pseudonymKey: new Uint8Array(32) },
    );

    expect(bundle.records.map(record => record.requestId)).toEqual(["old"]);
    expect(bundle.exportCompleteness).toBe("partial");
    expect(bundle.gaps).toEqual(expect.arrayContaining([
      { kind: "request_not_found", requestId: "missing", omittedRecordCount: 1 },
      { kind: "field_unavailable", field: "diagnostics", omittedRecordCount: 1 },
    ]));
  });

  test("validates the exact id and time-window bounds", () => {
    const options = { generatedAt: 2_000, pseudonymKey: new Uint8Array(32) };
    expect(() => buildSupportExport({ requestIds: [] }, [], options)).toThrow();
    expect(() => buildSupportExport({ requestIds: Array.from({ length: 33 }, (_, i) => `r-${i}`) }, [], options)).toThrow();
    expect(() => buildSupportExport({ from: 2_000, to: 1_000 }, [], options)).toThrow();
    expect(() => buildSupportExport({ from: 0, to: 24 * 60 * 60 * 1_000 + 1 }, [], options)).toThrow();

    const bundle = buildSupportExport(
      { from: 1_000, to: 2_000 },
      [policyEntry("before", 999), policyEntry("first", 1_000), policyEntry("last", 2_000), policyEntry("after", 2_001)],
      options,
    );
    expect(bundle.records.map(record => record.requestId)).toEqual(["first", "last"]);
    expect(bundle.exportWindowStart).toBe(1_000);
    expect(bundle.exportWindowEnd).toBe(2_000);
  });

  test("caps records at 2,000 and reports the omitted count", () => {
    const entries = Array.from({ length: SUPPORT_EXPORT_MAX_RECORDS + 3 }, (_, index) =>
      policyEntry(`ocx-${index}`, 1_000 + index));
    const bundle = buildSupportExport(
      { from: 0, to: 10_000 }, entries,
      { generatedAt: 20_000, pseudonymKey: new Uint8Array(32) },
    );

    expect(bundle.records).toHaveLength(SUPPORT_EXPORT_MAX_RECORDS);
    expect(bundle.gaps).toContainEqual({ kind: "record_limit", omittedRecordCount: 3 });
    expect(bundle.exportCompleteness).toBe("partial");
  });

  test("serialized JSON never exceeds 8 MiB and byte truncation is explicit", () => {
    const events = Array.from({ length: 64 }, (_, index) => ({
      eventSequence: index + 1,
      type: "response.output_text.delta" as const,
      at: 1_001 + index,
      source: "upstream" as const,
      responseId: `response-${index}`,
    }));
    const entries = Array.from({ length: SUPPORT_EXPORT_MAX_RECORDS }, (_, index) => {
      const row = policyEntry(`ocx-large-${index}`, 1_000 + index);
      row.diagnostics!.events = events;
      row.upstreamError = "x".repeat(500);
      return row;
    });
    const bundle = buildSupportExport(
      { from: 0, to: 10_000 }, entries,
      { generatedAt: 20_000, pseudonymKey: new Uint8Array(32) },
    );

    expect(Buffer.byteLength(JSON.stringify(bundle), "utf8")).toBeLessThanOrEqual(SUPPORT_EXPORT_MAX_BYTES);
    expect(bundle.gaps.some(gap => gap.kind === "byte_limit")).toBe(true);
    expect(bundle.exportCompleteness).toBe("partial");
  });
});
