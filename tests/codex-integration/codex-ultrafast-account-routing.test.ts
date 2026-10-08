import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { CodexModelAvailabilityError, resolveCodexAuthContext } from "../../src/codex/auth-context";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { isDirectCallerEntitledToCodexUltrafast, resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import type { CodexModelEntitlementSnapshot } from "../../src/codex/model-entitlements";
import { clearThreadAccountMap } from "../../src/codex/routing";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { resolveResponsesCodexAuth } from "../../src/server/responses/core-auth";
import type { RouteResult } from "../../src/router";

const MODEL = "gpt-6.1-sol";
const TIER = { id: "ultrafast" as const, name: "Ultrafast", description: "Fast inference" };
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {},
    codexAccounts: [
      { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "account-a" },
      { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "account-b" },
    ],
    activeCodexAccountId: "pool-a",
    activeCodexAccountPinned: "pool-a",
  };
}

function snapshot(
  grants: Readonly<Record<string, readonly string[]>>,
  model = MODEL,
  modelsByAccount: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["pool-a", new Set([model])], ["pool-b", new Set([model])],
  ]),
): CodexModelEntitlementSnapshot {
  return {
    modelsByAccount,
    ultrafastTierByAccount: new Map(Object.entries(grants).map(([id, models]) => [
      id, new Map(models.map(model => [model, TIER])),
    ])),
    confirmedAccountIds: new Set(["pool-a", "pool-b"]),
    clientVersionByAccount: new Map([["pool-a", "0.159.0"], ["pool-b", "0.159.0"]]),
    credentialIdentities: new Map(),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-ultrafast-routing-"));
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  clearThreadAccountMap();
  resetCodexModelEntitlementCacheForTests();
  for (const id of ["pool-a", "pool-b"]) {
    saveCodexAccountCredential(id, {
      accessToken: `token-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 300_000,
      chatgptAccountId: `account-${id}`,
    });
  }
});

afterEach(() => {
  clearThreadAccountMap();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

describe("Codex Ultrafast account selection", () => {
  test("detours a pinned model-capable account to the account granted Ultrafast", async () => {
    const cfg = config();
    const entitlements = snapshot({ "pool-b": [MODEL] });
    const context = await resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: MODEL,
      serviceTier: "ultrafast",
      resolveCodexModelEntitlements: async () => entitlements,
      primeCodexPoolQuotas: async () => {},
    });
    expect(context.accountId).toBe("pool-b");
    expect(cfg.activeCodexAccountPinned).toBe("pool-a");
  });

  test("initial Responses auth carries the selected tier into pool account selection", async () => {
    const cfg = config();
    const provider = {
      adapter: "openai-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward" as const,
    };
    const route = {
      providerName: "openai", provider, modelId: MODEL, codexAccountMode: "pool",
    } as RouteResult;
    const result = await resolveResponsesCodexAuth(
      new Request("http://localhost/v1/responses", { method: "POST" }),
      cfg, route,
      { resolveCodexModelEntitlements: async () => snapshot({ "pool-b": [MODEL] }) },
      false, false, "ultrafast",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.authCtx.accountId).toBe("pool-b");
  });

  test("also detours Astra and leaves an ordinary priority request on the pin", async () => {
    const cfg = config();
    const model = "gpt-6-astra";
    const entitlements = snapshot({ "pool-b": [model] }, model);
    const resolve = (serviceTier: string) => resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: model, serviceTier, resolveCodexModelEntitlements: async () => entitlements,
      primeCodexPoolQuotas: async () => {},
    });
    expect((await resolve("ultrafast")).accountId).toBe("pool-b");
    expect((await resolve("priority")).accountId).toBe("pool-a");
  });

  test("rejects Ultrafast when the model grant exists but no account has its tier", async () => {
    await expect(resolveCodexAuthContext(new Headers(), config(), "pool", {
      modelId: MODEL,
      serviceTier: "ultrafast",
      resolveCodexModelEntitlements: async () => snapshot({}),
      primeCodexPoolQuotas: async () => {},
    })).rejects.toBeInstanceOf(CodexModelAvailabilityError);
  });

  test("an explicit account selector cannot borrow another account's Ultrafast grant", async () => {
    await expect(resolveCodexAuthContext(new Headers(), config(), "pool", {
      accountId: "pool-a",
      modelId: MODEL,
      serviceTier: "ultrafast",
      resolveCodexModelEntitlements: async () => snapshot({ "pool-b": [MODEL] }),
      primeCodexPoolQuotas: async () => {},
    })).rejects.toBeInstanceOf(CodexModelAvailabilityError);
  });

  test("a tier declaration on another account does not supply the model grant", async () => {
    const modelGrants = new Map<string, ReadonlySet<string>>([
      ["pool-a", new Set([MODEL])], ["pool-b", new Set()],
    ]);
    await expect(resolveCodexAuthContext(new Headers(), config(), "pool", {
      modelId: MODEL, serviceTier: "ultrafast",
      resolveCodexModelEntitlements: async () => snapshot({ "pool-b": [MODEL] }, MODEL, modelGrants),
      primeCodexPoolQuotas: async () => {},
    })).rejects.toBeInstanceOf(CodexModelAvailabilityError);
  });

  test("an alternate-account retry refuses a model-capable account without Ultrafast", async () => {
    await expect(resolveCodexAuthContext(new Headers(), config(), "pool", {
      excludeAccountId: "pool-a", modelId: MODEL, serviceTier: "ultrafast",
      resolveCodexModelEntitlements: async () => snapshot({ "pool-a": [MODEL] }),
      primeCodexPoolQuotas: async () => {},
    })).rejects.toBeInstanceOf(CodexModelAvailabilityError);
  });

  test("canonical Ultrafast spelling still enforces the account grant", async () => {
    await expect(resolveCodexAuthContext(new Headers(), config(), "pool", {
      modelId: MODEL, serviceTier: " UltraFast ",
      resolveCodexModelEntitlements: async () => snapshot({}),
      primeCodexPoolQuotas: async () => {},
    })).rejects.toBeInstanceOf(CodexModelAvailabilityError);
  });

  test("a caller-owned main pin detours when only the pool account owns Ultrafast", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    const headers = new Headers({ authorization: "Bearer caller-token", "chatgpt-account-id": "caller-account" });
    const context = await resolveCodexAuthContext(headers, cfg, "pool", {
      modelId: MODEL, serviceTier: "ultrafast", requestScopedMainCredential: true,
      isDirectCallerEntitledToCodexUltrafast: async () => false,
      resolveCodexModelEntitlements: async () => snapshot({ "pool-b": [MODEL] }),
      primeCodexPoolQuotas: async () => {},
    });
    expect(context.accountId).toBe("pool-b");
  });

  test("a caller-owned main pin retains its own confirmed Ultrafast grant", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    const headers = new Headers({ authorization: "Bearer caller-token", "chatgpt-account-id": "caller-account" });
    const context = await resolveCodexAuthContext(headers, cfg, "pool", {
      modelId: MODEL, serviceTier: "ultrafast", requestScopedMainCredential: true,
      isDirectCallerEntitledToCodexUltrafast: async () => true,
      resolveCodexModelEntitlements: async () => snapshot({}),
    });
    expect(context).toMatchObject({ kind: "main", accountId: null });
    expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("retry cannot fall back to an unentitled request-owned main credential", async () => {
    const headers = new Headers({ authorization: "Bearer caller-token", "chatgpt-account-id": "caller-account" });
    await expect(resolveCodexAuthContext(headers, config(), "pool", {
      excludeAccountId: "pool-a", modelId: MODEL, serviceTier: "ultrafast",
      requestScopedMainCredential: true,
      isDirectCallerEntitledToCodexUltrafast: async () => false,
      resolveCodexModelEntitlements: async () => snapshot({}),
    })).rejects.toBeInstanceOf(CodexModelAvailabilityError);
  });

  test("caller-owned Direct refuses Ultrafast without its own tier grant", async () => {
    const headers = new Headers({ authorization: "Bearer caller-token", "chatgpt-account-id": "caller-account" });
    await expect(resolveCodexAuthContext(headers, config(), "direct", {
      modelId: MODEL,
      serviceTier: "ultrafast",
      isDirectCallerEntitledToCodexUltrafast: async () => false,
    })).rejects.toBeInstanceOf(CodexModelAvailabilityError);
  });

  test("Direct tier evidence comes from its own confirmed model roster", async () => {
    const headers = new Headers({ authorization: "Bearer caller-token", "chatgpt-account-id": "caller-account" });
    const fetcher = (async () => Response.json({ models: [{
      slug: MODEL, supported_in_api: true, visibility: "list",
      service_tiers: [TIER], additional_speed_tiers: ["ultrafast"],
    }] })) as typeof fetch;
    expect(await isDirectCallerEntitledToCodexUltrafast(headers, MODEL, { fetcher, clientVersion: "0.159.0" })).toBe(true);
    expect(await isDirectCallerEntitledToCodexUltrafast(headers, "gpt-6-astra", { fetcher, clientVersion: "0.159.0" })).toBe(false);
  });
});
