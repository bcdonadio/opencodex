import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OcxConfig } from "../src/types";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import {
  codexHeaders,
  encryptedInput,
  originalFetch,
  post,
  recoverySse,
} from "./helpers/agent-task-recovery";

function anthropicRecoveryConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anthropic-test",
    providers: {
      "anthropic-test": {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "key",
        apiKey: "anthropic-test-key",
      },
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
    agentTaskRecovery: { enabled: true },
  } as OcxConfig;
}

describe("payload-only encrypted agent recovery on Anthropic", () => {
  beforeEach(() => resetAgentTaskRecoveryState());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
  });

  test("sends one canonical payload text block to Anthropic after recovery", async () => {
    const assignment = [
      "Implement the end-to-end payload-only recovery regression.",
      "Preserve every byte, including indentation and blank lines.",
      "Do not include routing metadata in the provider task.",
      "line-04: " + "0123456789abcdef".repeat(40),
      "line-05: finish only after the tests and docs are updated.",
    ].join("\n");
    const recoveryBodies: string[] = [];
    const anthropicBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.includes("chatgpt.com")) {
        recoveryBodies.push(body);
        return new Response(recoverySse(assignment), { status: 200 });
      }
      if (url.includes("api.anthropic.com")) {
        anthropicBodies.push(JSON.parse(body) as Record<string, unknown>);
        return Response.json({
          id: "msg_recovery",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "claude-opus-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const response = await post(
      anthropicRecoveryConfig(),
      "anthropic-test/claude-opus-5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(recoveryBodies).toHaveLength(1);
    expect(anthropicBodies).toHaveLength(1);
    const messages = anthropicBodies[0]!.messages as Array<{ role?: string; content?: unknown }>;
    const terminal = messages.at(-1);
    expect(terminal?.role).toBe("user");
    expect(terminal?.content === assignment || JSON.stringify(terminal?.content) === JSON.stringify([{ type: "text", text: assignment }])).toBe(true);
    const terminalText = typeof terminal?.content === "string"
      ? terminal.content
      : Array.isArray(terminal?.content) && terminal.content.length === 1
        ? (terminal.content[0] as { text?: unknown })?.text
        : undefined;
    expect(terminalText).toBe(assignment);
    expect(JSON.stringify(anthropicBodies[0])).not.toContain("Message Type: NEW_TASK");
    expect(JSON.stringify(anthropicBodies[0])).not.toContain("Task name:");
    expect(JSON.stringify(anthropicBodies[0])).not.toContain("Sender:");
    expect(JSON.stringify(anthropicBodies[0])).not.toContain("Payload:");
    expect(JSON.stringify(anthropicBodies[0])).not.toContain("gAAAA");
  });
});
