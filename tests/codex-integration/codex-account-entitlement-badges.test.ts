import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolAccountDto } from "../../src/codex/auth-api/account-list";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import {
  cachedCodexAccountEntitlements,
  resetCodexModelEntitlementCacheForTests,
  resolveCodexModelEntitlements,
  type CodexModelEntitlementCredentialSnapshot,
} from "../../src/codex/model-entitlements";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";

let isolated: ReturnType<typeof installIsolatedCodexHome>;
const pool = "badge-pool";

function credential(accountId: string): CodexModelEntitlementCredentialSnapshot {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return {
    accountId, accessToken: "main-token", chatgptAccountId: "main-chatgpt",
    credentialIdentity: "main:main-chatgpt",
  };
  const generation = readCodexAccountRecord(accountId)!.generation;
  return {
    accountId, accessToken: "pool-token", chatgptAccountId: "pool-chatgpt",
    credentialIdentity: `pool:${generation}:pool-chatgpt`,
  };
}

function row(slug: string, cyber: string[] = [], ultrafast = false): Record<string, unknown> {
  return {
    slug, supported_in_api: true, visibility: "list",
    available_access_programs: { cyber },
    ...(ultrafast ? {
      service_tiers: [{ id: "ultrafast", name: "Ultrafast", description: "Higher speed" }],
      additional_speed_tiers: ["ultrafast"],
    } : {}),
  };
}

async function observe(accountId: string, rows: Record<string, unknown>[], version = "0.146.0", now = 1_000): Promise<void> {
  await resolveCodexModelEntitlements({ codexAccounts: [] }, {
    credentials: [credential(accountId)], clientVersion: version, now,
    fetcher: (async () => Response.json({ models: rows })) as typeof fetch,
  });
}

beforeEach(() => {
  isolated = installIsolatedCodexHome("ocx-account-badges-");
  resetCodexModelEntitlementCacheForTests();
  writeFileSync(join(isolated.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "main-token", account_id: "main-chatgpt" },
  }));
  saveCodexAccountCredential(pool, {
    accessToken: "pool-token", refreshToken: "pool-refresh",
    expiresAt: Date.now() + 60_000, chatgptAccountId: "pool-chatgpt",
  });
});
afterEach(() => resetCodexModelEntitlementCacheForTests());

test("projects each account's confirmed grants into the pool DTO", async () => {
  const now = Date.now();
  await observe(MAIN_CODEX_ACCOUNT_ID, [row("gpt-daybreak-blue-latest", ["daybreak_blue"])], "0.146.0", now);
  await observe(pool, [row("gpt-6-astra", ["daybreak_red"], true)], "0.146.0", now);
  expect(cachedCodexAccountEntitlements(MAIN_CODEX_ACCOUNT_ID)).toEqual(["daybreak-blue"]);
  expect(cachedCodexAccountEntitlements(pool)).toEqual(["daybreak-red", "ultrafast"]);
  expect(cachedCodexAccountEntitlements("__direct_codex__:caller")).toEqual([]);
  const config = { codexAccounts: [{ id: pool, email: "pool@example.test", isMain: false }] };
  const dto = poolAccountDto(config, config.codexAccounts[0]!, { quota: null, needsReauth: false }, true, false, 0, false);
  expect(dto.entitlements).toEqual(["daybreak-red", "ultrafast"]);
});

test("uses the newest roster and drops expired or replaced credentials", async () => {
  await observe(pool, [row("gpt-6-astra", ["daybreak_blue"], true)], "0.146.0", 1_000);
  expect(cachedCodexAccountEntitlements(pool, 1_001)).toEqual(["daybreak-blue", "ultrafast"]);
  await observe(pool, [row("gpt-6-astra")], "0.147.0", 2_000);
  expect(cachedCodexAccountEntitlements(pool, 2_001)).toEqual([]);
  expect(cachedCodexAccountEntitlements(pool, 400_000)).toEqual([]);
  saveCodexAccountCredential(pool, {
    accessToken: "replacement", refreshToken: "replacement-refresh",
    expiresAt: Date.now() + 60_000, chatgptAccountId: "replacement-chatgpt",
  });
  expect(cachedCodexAccountEntitlements(pool, 2_001)).toEqual([]);
});

test("drops main badges when the local login changes", async () => {
  await observe(MAIN_CODEX_ACCOUNT_ID, [row("gpt-daybreak-blue-latest", ["daybreak_blue"])]);
  expect(cachedCodexAccountEntitlements(MAIN_CODEX_ACCOUNT_ID, 1_001)).toEqual(["daybreak-blue"]);
  writeFileSync(join(isolated.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "new-token", account_id: "other-chatgpt" },
  }));
  expect(cachedCodexAccountEntitlements(MAIN_CODEX_ACCOUNT_ID, 1_001)).toEqual([]);
});

test("ignores unconfirmed rosters and hidden or disabled models", async () => {
  await observe(pool, [row("gpt-6-astra", ["daybreak_blue"], true)]);
  await observe(pool, [], "0.147.0", 2_000);
  expect(cachedCodexAccountEntitlements(pool, 2_001)).toEqual([]);
  await observe(pool, [{ ...row("gpt-6-astra", ["daybreak_blue"], true), visibility: "hide" },
    { ...row("gpt-6.1-sol", ["daybreak_red"], true), supported_in_api: false }, row("gpt-6-sol")], "0.148.0", 3_000);
  expect(cachedCodexAccountEntitlements(pool, 3_001)).toEqual([]);
});

afterEach(() => isolated.restore());
