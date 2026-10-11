const integerToken = /^(?:[+-]?(?:0|[1-9](?:_?[0-9])*)|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/;

/**
 * Read structure and strings without requiring unrelated TOML i64 values to fit JS numbers.
 * Only a parser input copy changes; callers must not consume its integer values.
 * Bun still validates the entire document, including duplicate keys and trailing syntax.
 */
export function parseTomlStructure(content: string): object {
  try { return Bun.TOML.parse(content); } catch {
    return Bun.TOML.parse(projectUnsafeIntegers(content));
  }
}

function projectUnsafeIntegers(content: string): string {
  const pieces: string[] = [];
  let copied = 0;
  let inValue = false;
  let depth = 0;
  for (let i = 0; i < content.length;) {
    const char = content[i]!;
    if (char === "#") {
      const end = content.indexOf("\n", i);
      i = end < 0 ? content.length : end;
    } else if (char === '"' || char === "'") {
      const multiline = content.startsWith(char.repeat(3), i);
      i += multiline ? 3 : 1;
      while (i < content.length) {
        if (char === '"' && content[i] === "\\") { i += 2; continue; }
        if (content[i] !== char) { i += 1; continue; }
        if (!multiline) { i += 1; break; }
        let end = i;
        while (content[end] === char) end += 1;
        if (end - i >= 3) { i = end; break; }
        i = end;
      }
    } else if (char === "=") {
      inValue = true;
      i += 1;
    } else if (char === "\n" || char === "\r") {
      if (depth === 0) inValue = false;
      i += 1;
    } else if (/\s/.test(char) || char === ",") {
      i += 1;
    } else if (char === "[" || char === "{") {
      if (inValue) depth += 1;
      i += 1;
    } else if (char === "]" || char === "}") {
      if (inValue) depth = Math.max(0, depth - 1);
      i += 1;
    } else {
      const start = i;
      while (i < content.length && !/[\s,\[\]{}=#"']/.test(content[i]!)) i += 1;
      const token = content.slice(start, i);
      // Numeric inline-table keys are legal and must keep their identity.
      const next = content.slice(i).match(/^\s*(.)/)?.[1];
      if (!inValue || next === "=" || !integerToken.test(token)) continue;
      const value = BigInt(token.replaceAll("_", ""));
      if (value < -(1n << 63n) || value >= (1n << 63n)
        || (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER))) continue;
      pieces.push(content.slice(copied, start), "0");
      copied = i;
    }
  }
  pieces.push(content.slice(copied));
  return pieces.join("");
}
