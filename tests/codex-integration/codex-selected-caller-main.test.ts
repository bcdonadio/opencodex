import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexMainSubstitutionUnavailableError,
  materializeCodexUpstreamAuth,
  materializeCodexUpstreamAuthAsync,
  resolveCodexAuthContext,
} from "../../src/codex/auth-context";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  handleCodexAuthAPI,
  markAccountNeedsReauth,
} from "../../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import {
  acquireNativeMainProfileDrain,
  codexAccountSelectionForTurn,
  tryAdmitTurn,
} from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    activeCodexAccountId: "pool-a",
    providers: {
      routed: { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" },
      chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.test/backend-api/codex", authMode: "forward" },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
    ],
  };
}

function callerHeaders(): Headers {
  return new Headers({
    authorization: "Bearer caller-keyring-token",
    "chatgpt-account-id": "caller-keyring-account",
  });
}

function savePoolCredential(): void {
  saveCodexAccountCredential("pool-a", {
    accessToken: "pool-token",
    refreshToken: "pool-refresh",
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: "pool-account",
  });
}

beforeEach(() => {
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  testDir = mkdtempSync(join(tmpdir(), "ocx-selected-caller-main-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth("pool-a");
});

afterEach(() => {
  setIcaclsRunnerForTests(null);
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth("pool-a");
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(testDir);
});

describe("selected caller-owned main", () => {
  test("a no-pool caller fallback stays independent of native-profile drain", async () => {
    const cfg = config();
    cfg.codexAccounts = [];
    cfg.activeCodexAccountId = undefined;
    const drain = acquireNativeMainProfileDrain("auth-context-caller-fallback-test");
    const turn = tryAdmitTurn();
    try {
      await expect(resolveCodexAuthContext(callerHeaders(), cfg, "pool", {
        requestScopedMainCredential: true,
        beginCodexAccountSelection: codexAccountSelectionForTurn(turn!),
      })).resolves.toEqual({ kind: "main", accountId: null });
    } finally {
      turn?.release();
      drain?.release();
    }
  });

  test("a validated caller bearer satisfies a manually pinned main Pool selection", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    savePoolCredential();
    const inbound = callerHeaders();
    inbound.set("openai-beta", "responses=experimental");
    let storedMainReads = 0;
    const context = await resolveCodexAuthContext(inbound, cfg, "pool", {
      modelId: "gpt-5.5",
      requestScopedMainCredential: true,
      getValidMainAccountToken: async () => {
        storedMainReads += 1;
        throw new Error("caller-backed main must not read auth.json");
      },
      primeCodexPoolQuotas: async () => {},
    });
    expect(context).toMatchObject({ kind: "main", accountId: null });
    expect(context).not.toHaveProperty("accessToken");
    expect(context).not.toHaveProperty("writerGeneration");
    expect(storedMainReads).toBe(0);
    expect(materializeCodexUpstreamAuth(inbound, context)).toEqual(inbound);
    expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("caller-backed main never substitutes a stored credential", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    const inbound = callerHeaders();
    const context = await resolveCodexAuthContext(inbound, cfg, "pool", {
      requestScopedMainCredential: true,
    });
    expect(context).toMatchObject({ kind: "main", accountId: null });
    expect(() => materializeCodexUpstreamAuth(inbound, context, { substituteMainCredential: true }))
      .toThrow(CodexMainSubstitutionUnavailableError);
    let refreshes = 0;
    await expect(materializeCodexUpstreamAuthAsync(inbound, context, {
      substituteMainCredential: true,
      nativeMainRefreshDependencies: {
        refreshToken: async () => {
          refreshes += 1;
          throw new Error("caller-owned main cannot refresh stored credentials");
        },
      },
    })).rejects.toBeInstanceOf(CodexMainSubstitutionUnavailableError);
    expect(refreshes).toBe(0);
  });

  test("a manually pinned stored Pool account still outranks a request-scoped main bearer", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = "pool-a";
    cfg.activeCodexAccountPinned = "pool-a";
    savePoolCredential();
    const context = await resolveCodexAuthContext(callerHeaders(), cfg, "pool", {
      modelId: "gpt-5.5",
      requestScopedMainCredential: true,
      primeCodexPoolQuotas: async () => {},
    });
    expect(context).toMatchObject({ kind: "pool", accountId: "pool-a", accessToken: "pool-token" });
    expect(cfg.activeCodexAccountPinned).toBe("pool-a");
  });

  test("a caller-entitled gated model honors a manually pinned request-scoped main", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    savePoolCredential();
    let checks = 0;
    const context = await resolveCodexAuthContext(callerHeaders(), cfg, "pool", {
      modelId: "gpt-daybreak-blue-latest",
      requestScopedMainCredential: true,
      isDirectCallerEntitledToCodexModel: async () => { checks += 1; return true; },
      resolveCodexModelEntitlements: async () => ({
        modelsByAccount: new Map([["pool-a", new Set(["gpt-daybreak-blue-latest"])]]),
        confirmedAccountIds: new Set(["pool-a"]),
        credentialIdentities: new Map(),
      }),
      primeCodexPoolQuotas: async () => {},
    });
    expect(context).toMatchObject({ kind: "main", accountId: null });
    expect(checks).toBe(1);
    expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("an unentitled caller uses a gated Pool detour without clearing pinned main", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    savePoolCredential();
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID, Number.MAX_SAFE_INTEGER);
    const context = await resolveCodexAuthContext(callerHeaders(), cfg, "pool", {
      modelId: "gpt-daybreak-blue-latest",
      requestScopedMainCredential: true,
      isDirectCallerEntitledToCodexModel: async () => false,
      resolveCodexModelEntitlements: async () => ({
        modelsByAccount: new Map([["pool-a", new Set(["gpt-daybreak-blue-latest"])]]),
        confirmedAccountIds: new Set(["pool-a"]),
        credentialIdentities: new Map(),
      }),
      primeCodexPoolQuotas: async () => {},
    });
    expect(context).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("an older gated resolution cannot overwrite a newer manual main selection", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = "pool-a";
    cfg.activeCodexAccountPinned = "pool-a";
    savePoolCredential();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const stale = resolveCodexAuthContext(callerHeaders(), cfg, "pool", {
      modelId: "gpt-daybreak-blue-latest",
      requestScopedMainCredential: true,
      isDirectCallerEntitledToCodexModel: async () => false,
      resolveCodexModelEntitlements: async (_config, options) => {
        started();
        await gate;
        expect(options?.excludeAccountIds?.has(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
        return {
          modelsByAccount: new Map([["pool-a", new Set(["gpt-daybreak-blue-latest"])]]),
          confirmedAccountIds: new Set(["pool-a"]),
          credentialIdentities: new Map(),
        };
      },
      primeCodexPoolQuotas: async () => {},
    });
    await didStart;
    const request = new Request("http://localhost/api/codex-auth/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: MAIN_CODEX_ACCOUNT_ID }),
    });
    expect((await handleCodexAuthAPI(request, new URL(request.url), cfg))?.status).toBe(200);
    release();
    await expect(stale).resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("an older caller entitlement cannot override a newer manual Pool selection", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    savePoolCredential();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const stale = resolveCodexAuthContext(callerHeaders(), cfg, "pool", {
      modelId: "gpt-daybreak-blue-latest",
      requestScopedMainCredential: true,
      isDirectCallerEntitledToCodexModel: async () => { started(); await gate; return true; },
      resolveCodexModelEntitlements: async () => ({
        modelsByAccount: new Map([["pool-a", new Set(["gpt-daybreak-blue-latest"])]]),
        confirmedAccountIds: new Set(["pool-a"]),
        credentialIdentities: new Map(),
      }),
      primeCodexPoolQuotas: async () => {},
    });
    await didStart;
    const request = new Request("http://localhost/api/codex-auth/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "pool-a" }),
    });
    expect((await handleCodexAuthAPI(request, new URL(request.url), cfg))?.status).toBe(200);
    release();
    await expect(stale).resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(cfg.activeCodexAccountPinned).toBe("pool-a");
  });
});
