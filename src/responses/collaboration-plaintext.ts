const COLLABORATION_MESSAGE_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCollaborationMessageTool(tool: Record<string, unknown>, insideCollaboration: boolean): boolean {
  if (tool.type !== "function" || typeof tool.name !== "string" || !COLLABORATION_MESSAGE_TOOLS.has(tool.name)) {
    return false;
  }
  if (insideCollaboration) return true;
  if (!isPlainRecord(tool.parameters) || !isPlainRecord(tool.parameters.properties)) return false;
  return tool.name === "spawn_agent"
    ? Object.hasOwn(tool.parameters.properties, "task_name")
    : Object.hasOwn(tool.parameters.properties, "target");
}

function plaintextFunctionTool(tool: Record<string, unknown>, insideCollaboration: boolean): {
  tool: Record<string, unknown>;
  changed: number;
} {
  if (!isCollaborationMessageTool(tool, insideCollaboration)) return { tool, changed: 0 };
  const parameters = tool.parameters;
  if (!isPlainRecord(parameters) || !isPlainRecord(parameters.properties)) return { tool, changed: 0 };
  const message = parameters.properties.message;
  if (!isPlainRecord(message) || message.encrypted !== true) return { tool, changed: 0 };
  const { encrypted: _encrypted, ...plaintextMessage } = message;
  return {
    tool: {
      ...tool,
      parameters: {
        ...parameters,
        properties: { ...parameters.properties, message: plaintextMessage },
      },
    },
    changed: 1,
  };
}

function plaintextTool(tool: unknown, insideCollaboration = false): { tool: unknown; changed: number } {
  if (!isPlainRecord(tool)) return { tool, changed: 0 };
  if (tool.type === "namespace" && tool.name === "collaboration" && Array.isArray(tool.tools)) {
    const mapped = plaintextToolGroup(tool.tools, true);
    return mapped.changed > 0
      ? { tool: { ...tool, tools: mapped.tools }, changed: mapped.changed }
      : { tool, changed: 0 };
  }
  return plaintextFunctionTool(tool, insideCollaboration);
}

function plaintextToolGroup(tools: unknown[], insideCollaboration = false): {
  tools: unknown[];
  changed: number;
} {
  let changed = 0;
  const mapped = tools.map((tool) => {
    const result = plaintextTool(tool, insideCollaboration);
    changed += result.changed;
    return result.tool;
  });
  return { tools: changed > 0 ? mapped : tools, changed };
}

/**
 * Codex marks V2 collaboration message arguments `encrypted: true`, which makes
 * ChatGPT return Fernet-only tool arguments that routed children cannot read.
 * The recovery opt-in explicitly chooses plaintext collaboration delivery, so
 * remove only those three transport annotations and preserve every other schema.
 */
export function enablePlaintextCollaborationDelivery(body: unknown): {
  body: unknown;
  changedTools: number;
} {
  if (!isPlainRecord(body)) return { body, changedTools: 0 };
  let changedTools = 0;
  let tools = body.tools;
  if (Array.isArray(body.tools)) {
    const mapped = plaintextToolGroup(body.tools);
    tools = mapped.tools;
    changedTools += mapped.changed;
  }

  let input = body.input;
  if (Array.isArray(body.input)) {
    let inputChanged = false;
    input = body.input.map((item) => {
      if (!isPlainRecord(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const mapped = plaintextToolGroup(item.tools);
      changedTools += mapped.changed;
      if (mapped.changed === 0) return item;
      inputChanged = true;
      return { ...item, tools: mapped.tools };
    });
    if (!inputChanged) input = body.input;
  }

  if (changedTools === 0) return { body, changedTools: 0 };
  return {
    body: {
      ...body,
      ...(Array.isArray(body.tools) ? { tools } : {}),
      ...(Array.isArray(body.input) ? { input } : {}),
    },
    changedTools,
  };
}
