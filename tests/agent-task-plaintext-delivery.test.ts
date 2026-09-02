import { afterEach, describe, expect, test } from "bun:test";
import type { OcxConfig } from "../src/types";
import { handleResponses } from "../src/server/responses";
import {
  codexHeaders,
  originalFetch,
  providerResponse,
} from "./helpers/agent-task-recovery";

const reservedCollaborationTools = [
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
] as const;

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
    },
    agentTaskRecovery: { enabled: true },
  } as OcxConfig;
}

describe("reserved V2 collaboration request contract", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("forwards all three encrypted message annotations unchanged to canonical ChatGPT", async () => {
    let forwardedBody: Record<string, any> | null = null;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return Response.json({ models: [{ slug: "gpt-5.6-sol" }] });
      }
      forwardedBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, any>;
      return providerResponse();
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...Object.fromEntries(codexHeaders()) },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Delegate the review." }] },
          { type: "additional_tools", role: "developer", tools: reservedCollaborationTools },
        ],
        stream: false,
      }),
    }), config(), { model: "", provider: "" }, {
      isDirectCallerEntitledToCodexModel: async () => true,
    });

    expect(response.status).toBe(200);
    const forwardedTools = forwardedBody!.input.at(-1).tools as typeof reservedCollaborationTools;
    for (const name of ["spawn_agent", "send_message", "followup_task"]) {
      const tool = forwardedTools.find(candidate => candidate.name === name)!;
      expect(tool.parameters.properties.message).toEqual({ type: "string", encrypted: true });
    }
  });
});
