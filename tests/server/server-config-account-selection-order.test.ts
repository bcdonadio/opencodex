import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, readConfigDiagnostics } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-config-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) removeTreeWithRetry(testDir);
  testDir = "";
});

function backupNames(): string[] {
  return readdirSync(testDir).filter(name => name.startsWith("config.json.invalid-"));
}

function writeConfig(content: unknown): void {
  writeFileSync(
    getConfigPath(),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf-8",
  );
}

describe("codex account selection order", () => {
  function writePriorityConfig(
    codexAccountPriorities: unknown,
    overrides: Record<string, unknown> = {},
  ): void {
    writeConfig({
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
      codexAccountPriorities,
      ...overrides,
    });
  }

  test("round-trips pool ids, the main account, and negative order", () => {
    const priorities = { work: 2, side: 1, __main__: -2 };
    writePriorityConfig(priorities);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.config.codexAccountPriorities).toEqual(priorities);
    expect(Object.hasOwn(getDefaultConfig(), "codexAccountPriorities")).toBe(false);
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "work"],
    ["a fractional value", { work: 1.5 }],
    ["a stringified number", { work: "2" }],
    ["a boolean", { work: true }],
    ["an above-range value", { work: 101 }],
    ["a below-range value", { work: -101 }],
    ["a reserved constructor key", { constructor: 1 }],
    ["a slash in the key", { "work/account": 1 }],
  ] as const)("degrades %s to no ordering without discarding the rest of the config", (_label, priorities) => {
    writePriorityConfig(priorities);

    const diagnostics = readConfigDiagnostics();
    // Selection order is a preference: a malformed map must never trip the
    // backup-and-defaults repair path that would reset providers.
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.codexAccountPriorities).toBeUndefined();
    expect(Object.keys(diagnostics.config.providers)).toContain("openai");
    expect(backupNames()).toHaveLength(0);
    expect(diagnostics.warnings).toContainEqual(expect.stringContaining("account selection order is disabled"));
  });

  test("degrades a literal __proto__ entry, which JSON.parse materializes as an own key", () => {
    writeConfig(
      '{"port":10100,"providers":{"openai":{"adapter":"openai-responses",'
      + '"baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward"}},'
      + '"defaultProvider":"openai","codexAccountPriorities":{"__proto__":1,"work":2}}',
    );

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.config.codexAccountPriorities).toBeUndefined();
    expect(Object.keys(diagnostics.config.providers)).toContain("openai");
    expect(diagnostics.warnings).toContainEqual(expect.stringContaining("account selection order is disabled"));
  });

  test("warns when load degrades a malformed selection-order map", () => {
    writePriorityConfig({ work: 101 });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const loaded = loadConfig();
      expect(loaded.codexAccountPriorities).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("account selection order is disabled"));
      expect(backupNames()).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("keeps a valid pin and degrades a malformed one", () => {
    writePriorityConfig({ work: 1 }, { activeCodexAccountPinned: "work" });
    expect(readConfigDiagnostics().config.activeCodexAccountPinned).toBe("work");

    writePriorityConfig({ work: 1 }, { activeCodexAccountPinned: "work/account" });
    const degraded = readConfigDiagnostics();
    expect(degraded.source).toBe("file");
    expect(degraded.config.activeCodexAccountPinned).toBeUndefined();
    expect(degraded.config.codexAccountPriorities).toEqual({ work: 1 });
    expect(degraded.warnings).toContainEqual(expect.stringContaining("no longer pinned"));
  });
});
