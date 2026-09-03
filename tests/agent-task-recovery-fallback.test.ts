import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  noteSubagentModelFailure,
  resetSubagentModelFallbackStateForTests,
} from "../src/codex/subagent-model-fallback";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  responseContinuationRetainedStoreSnapshot,
} from "../src/responses/state";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import {
  codexHeaders,
  encryptedInput,
  FERNET_TASK,
  originalFetch,
  post,
  providerResponse,
  recoverySse,
  routedConfig,
} from "./helpers/agent-task-recovery";

describe("agent task recovery fallback routing", () => {
  beforeEach(() => {
    resetAgentTaskRecoveryState();
    resetSubagentModelFallbackStateForTests();
    clearResponseStateMemoryForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
    resetSubagentModelFallbackStateForTests();
    clearResponseStateForTests();
  });

  test("routes a recovered task through the healthy routed fallback", async () => {
    const config = routedConfig();
    config.subagentModelFallback = ["xai/grok-4.6"];
    noteSubagentModelFailure("xai/grok-4.5", "429", config);

    const fetchedUrls: string[] = [];
    const providerModels: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("chatgpt.com")) {
        return new Response(recoverySse("Dispatch this recovered task through the healthy fallback."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      const raw = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(raw) as { model?: string };
      providerModels.push(body.model ?? "");
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      config,
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex");
    expect(fetchedUrls[1]).toContain("api.x.ai");
    expect(providerModels).toEqual(["grok-4.6"]);
  });

  test("restores encrypted history when post-recovery fallback becomes native", async () => {
    const config = routedConfig();
    config.subagentModelFallback = ["gpt-5.5"];
    noteSubagentModelFailure("gpt-5.5", "429", config);
    const headers = codexHeaders("acct-native-after-recovery", {
      "x-codex-parent-thread-id": "parent-native-after-recovery",
    });
    const prior = encryptedInput();
    const current = encryptedInput({ messageType: "MESSAGE" });
    let recoveryFetches = 0;
    const nativeBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const raw = typeof init?.body === "string" ? init.body : "";
      if (url.includes("chatgpt.com") && raw.includes("capture_assignment")) {
        recoveryFetches += 1;
        if (recoveryFetches === 2) {
          resetSubagentModelFallbackStateForTests();
          noteSubagentModelFailure("xai/grok-4.5", "429", config);
          noteSubagentModelFailure("grok-4.5", "429", config);
        }
        return new Response(recoverySse(
          raw.includes("Message Type: MESSAGE") ? "Current message." : "Prior task.",
        ), { status: 200 });
      }
      if (url.includes("chatgpt.com")) nativeBodies.push(raw);
      return providerResponse();
    }) as typeof fetch;

    expect((await post(config, "xai/grok-4.5", structuredClone(prior), headers)).status).toBe(200);
    const response = await post(config, "xai/grok-4.5", [
      structuredClone(prior[0]),
      structuredClone(current[0]),
    ], headers);

    expect(response.status).toBe(200);
    expect(recoveryFetches).toBe(2);
    expect(nativeBodies).toHaveLength(1);
    expect(nativeBodies[0]).toContain(FERNET_TASK);
    expect(nativeBodies[0]).not.toContain("Prior task.");
    expect(nativeBodies[0]).not.toContain("Current message.");
    expect(responseContinuationRetainedStoreSnapshot().count).toBe(1);
  });
});
