import { afterEach, describe, expect, test } from "bun:test";
import type { OcxConfig } from "../src/types";
import { handleResponses } from "../src/server/responses";
import { enablePlaintextCollaborationDelivery } from "../src/responses/collaboration-plaintext";
import {
  agentMessage,
  codexHeaders,
  originalFetch,
  post,
  providerResponse,
} from "./helpers/agent-task-recovery";

const nativeTools = [
  {
    type: "function",
    name: "spawn_agent",
    parameters: {
      type: "object",
      properties: {
        task_name: { type: "string" },
        message: { type: "string", encrypted: true },
      },
      required: ["task_name", "message"],
    },
  },
  {
    type: "function",
    name: "send_message",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string" },
        message: { type: "string", encrypted: true },
      },
      required: ["target", "message"],
    },
  },
  {
    type: "function",
    name: "followup_task",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string" },
        message: { type: "string", encrypted: true },
      },
      required: ["target", "message"],
    },
  },
  {
    type: "function",
    name: "ordinary_secret_tool",
    parameters: {
      type: "object",
      properties: { value: { type: "string", encrypted: true } },
      required: ["value"],
    },
  },
];

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
      "anthropic-test": {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "key",
        apiKey: "anthropic-test-key",
      },
      "xai-test": {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "xai-test-key",
      },
      "cortex-test": {
        adapter: "openai-chat",
        baseUrl: "https://cortex.example/v1",
        authMode: "key",
        apiKey: "cortex-test-key",
      },
    },
    agentTaskRecovery: { enabled: true },
  } as OcxConfig;
}

function chatCompletion(model: string): Response {
  return Response.json({
    id: `chatcmpl-${model}`,
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ack" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

describe("plaintext V2 collaboration delivery", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("rewrites collaboration namespace carriers copy-on-write and leaves unrelated bodies identical", () => {
    const original = {
      model: "gpt-5.6-sol",
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [nativeTools[0], nativeTools[3]],
      }],
      input: [{ type: "message", role: "user", content: "delegate" }],
    };
    const snapshot = structuredClone(original);
    const rewritten = enablePlaintextCollaborationDelivery(original);

    expect(rewritten.changedTools).toBe(1);
    expect(rewritten.body).not.toBe(original);
    expect(original).toEqual(snapshot);
    const namespace = (rewritten.body as typeof original).tools[0];
    expect(namespace.tools[0].parameters.properties.message).toEqual({ type: "string" });
    expect(namespace.tools[1].parameters.properties.value.encrypted).toBe(true);

    const unchanged = { model: "gpt-5.6-sol", input: [{ type: "message", role: "user", content: "plain" }] };
    expect(enablePlaintextCollaborationDelivery(unchanged)).toEqual({ body: unchanged, changedTools: 0 });
  });

  test("native parent emits plaintext collaboration arguments and routed leaves receive a long payload unchanged", async () => {
    let nativeBody: Record<string, any> | null = null;
    const routedBodies = new Map<string, Record<string, any>>();
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, any>;
      if (url.includes("chatgpt.com")) {
        if (url.endsWith("/models")) {
          return Response.json({ models: [{ slug: "gpt-5.6-sol" }] });
        }
        nativeBody = body;
        return providerResponse();
      }
      if (url.includes("api.anthropic.com")) {
        routedBodies.set("anthropic", body);
        return Response.json({
          id: "msg_plaintext",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ack" }],
          model: "claude-opus-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      if (url.includes("api.x.ai")) {
        routedBodies.set("xai", body);
        return chatCompletion("grok-4.6");
      }
      if (url.includes("cortex.example")) {
        routedBodies.set("cortex-hq", body);
        return chatCompletion("zai-org/GLM-5.3");
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const parentInput = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Delegate the review." }] },
      { type: "additional_tools", role: "developer", tools: nativeTools },
    ];
    const parentResponse = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...Object.fromEntries(codexHeaders()) },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: parentInput, stream: false }),
    }), config(), { model: "", provider: "" }, {
      isDirectCallerEntitledToCodexModel: async () => true,
    });
    expect(parentResponse.status).toBe(200);

    const forwardedTools = nativeBody!.input.at(-1).tools as typeof nativeTools;
    for (const name of ["spawn_agent", "send_message", "followup_task"]) {
      const tool = forwardedTools.find(candidate => candidate.name === name)!;
      expect(tool.parameters.properties.message).toEqual({ type: "string" });
    }
    expect(forwardedTools.find(candidate => candidate.name === "ordinary_secret_tool")!
      .parameters.properties.value.encrypted).toBe(true);

    const payload = [
      "NESTED-PLAINTEXT-BEGIN-6393",
      "The native parent must hand this task to a routed leaf without backend encryption.",
      "0123456789abcdef".repeat(385),
      "NESTED-PLAINTEXT-END-6393",
    ].join("\n");
    const childInput = agentMessage([{ type: "encrypted_content", encrypted_content: payload }]);
    for (const model of [
      "anthropic-test/claude-opus-5",
      "xai-test/grok-4.6",
      "cortex-test/zai-org/GLM-5.3",
    ]) {
      const response = await post(config(), model, structuredClone(childInput), codexHeaders());
      if (response.status !== 200) throw new Error(`${model}: ${await response.text()}`);
    }

    const anthropicMessages = routedBodies.get("anthropic")!.messages as Array<{ role: string; content: unknown }>;
    expect(anthropicMessages.at(-1)).toEqual({ role: "user", content: payload });
    for (const provider of ["xai", "cortex-hq"]) {
      const messages = routedBodies.get(provider)!.messages as Array<{ role: string; content: unknown }>;
      expect(messages.at(-1)).toEqual({ role: "user", content: payload });
    }
  });
});
