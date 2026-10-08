import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { COMBO_NAMESPACE } from "../../src/combos";
import {
  resolveCodexModelEntitlements,
  resetCodexModelEntitlementCacheForTests,
  type CodexModelEntitlementCredentialSnapshot,
} from "../../src/codex/model-entitlements";
import { applyNativeUltraFastTier } from "../../src/codex/catalog/access-programs";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import { repoPath } from "../helpers/repo-root";

const ASTRA = "gpt-6-astra";
const TEST_CLIENT_VERSION = "0.159.0";
const ULTRA_TIER = {
  id: "ultrafast",
  name: "Ultrafast",
  description: "The fastest available responses for latency-sensitive work.",
};
const PRIORITY_TIER = {
  id: "priority",
  name: "Fast",
  description: "2x speed, increased usage",
};

function credential(accountId: string): CodexModelEntitlementCredentialSnapshot {
  return {
    accountId,
    accessToken: `test-token-${accountId}`,
    chatgptAccountId: `chatgpt-${accountId}`,
    credentialIdentity: `test:${accountId}`,
  };
}

function rosterFetcher(options: { mainUltra?: boolean; poolUltra?: boolean } = {}): typeof fetch {
  return (async (_input, init) => {
    const account = new Headers(init?.headers).get("chatgpt-account-id");
    const hasUltra = account === `chatgpt-${MAIN_CODEX_ACCOUNT_ID}`
      ? options.mainUltra !== false
      : options.poolUltra === true;
    return Response.json({ models: [{
      slug: ASTRA,
      supported_in_api: true,
      visibility: "list",
      service_tiers: [PRIORITY_TIER, ...(hasUltra ? [ULTRA_TIER] : [])],
      additional_speed_tiers: ["fast", ...(hasUltra ? ["ultrafast"] : [])],
    }] });
  }) as typeof fetch;
}

function rowsWithStaleUltra(): RawEntry[] {
  return [
    { slug: ASTRA, service_tiers: [PRIORITY_TIER, ULTRA_TIER], additional_speed_tiers: ["fast", "ultrafast"] },
    { slug: `desktop/${ASTRA}`, opencodex_catalog_kind: "account-selector-v1", service_tiers: [PRIORITY_TIER, ULTRA_TIER], additional_speed_tiers: ["fast", "ultrafast"] },
    { slug: `pool/${ASTRA}`, opencodex_catalog_kind: "account-selector-v1", service_tiers: [PRIORITY_TIER, ULTRA_TIER], additional_speed_tiers: ["fast", "ultrafast"] },
    { slug: `openai-apikey/${ASTRA}`, service_tiers: [PRIORITY_TIER, ULTRA_TIER], additional_speed_tiers: ["fast", "ultrafast"] },
    { slug: ASTRA, owned_by: COMBO_NAMESPACE, service_tiers: [PRIORITY_TIER, ULTRA_TIER], additional_speed_tiers: ["fast", "ultrafast"] },
    { slug: ASTRA, opencodex_catalog_kind: "combo-native-alias-v1", service_tiers: [PRIORITY_TIER, ULTRA_TIER], additional_speed_tiers: ["fast", "ultrafast"] },
    { slug: "other/latency-model", opencodex_catalog_kind: "routed-provider", service_tiers: [ULTRA_TIER], additional_speed_tiers: ["ultrafast"] },
    { slug: ASTRA, owned_by: "other", service_tiers: [PRIORITY_TIER], additional_speed_tiers: ["fast"] },
    { slug: `deleted/${ASTRA}`, opencodex_catalog_kind: "account-selector-v1", service_tier: "ultrafast", default_service_tier: "ultrafast", service_tiers: [PRIORITY_TIER, ULTRA_TIER], additional_speed_tiers: ["fast", "ultrafast"] },
  ];
}

const selectors = new Map([
  ["desktop", MAIN_CODEX_ACCOUNT_ID],
  ["pool", "pool-account"],
]);

beforeEach(() => resetCodexModelEntitlementCacheForTests());

describe("account-scoped native Ultrafast catalog metadata", () => {
  test("projects only confirmed account evidence and preserves existing Fast metadata", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential(MAIN_CODEX_ACCOUNT_ID), credential("pool-account")],
      fetcher: rosterFetcher({ mainUltra: true, poolUltra: false }),
      clientVersion: TEST_CLIENT_VERSION,
      now: 1_000,
    });
    const rows = rowsWithStaleUltra();

    applyNativeUltraFastTier(rows, snapshot, selectors, true);

    expect(snapshot.ultrafastTierByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.get(ASTRA)).toEqual(ULTRA_TIER);
    expect(snapshot.ultrafastTierByAccount?.get("pool-account")?.has(ASTRA)).toBe(false);
    expect(rows[0]?.service_tiers).toEqual([PRIORITY_TIER, ULTRA_TIER]);
    expect(rows[0]?.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    expect(rows[1]?.service_tiers).toEqual([PRIORITY_TIER, ULTRA_TIER]);
    expect(rows[2]?.service_tiers).toEqual([PRIORITY_TIER]);
    expect(rows[2]?.additional_speed_tiers).toEqual(["fast"]);
    expect(rows[3]?.service_tiers).toEqual([PRIORITY_TIER]);
    expect(rows[4]?.service_tiers).toEqual([PRIORITY_TIER]);
    expect(rows[5]?.service_tiers).toEqual([PRIORITY_TIER]);
    expect(rows[6]?.service_tiers).toEqual([ULTRA_TIER]);
    expect(rows[7]?.service_tiers).toEqual([PRIORITY_TIER]);
    expect(rows[7]?.additional_speed_tiers).toEqual(["fast"]);
    expect(rows[8]?.service_tiers).toEqual([PRIORITY_TIER]);
    expect(rows[8]?.service_tier).toBeUndefined();
    expect(rows[8]?.default_service_tier).toBeUndefined();
    expect(rows[8]?.additional_speed_tiers).toEqual(["fast"]);
  });

  test("bare Pool rows advertise a tier granted only to a stored account; Direct stays main-only", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential(MAIN_CODEX_ACCOUNT_ID), credential("pool-account")],
      fetcher: rosterFetcher({ mainUltra: false, poolUltra: true }),
      clientVersion: TEST_CLIENT_VERSION, now: 1_000,
    });
    const pooled: RawEntry[] = [{ slug: ASTRA, service_tiers: [PRIORITY_TIER], additional_speed_tiers: ["fast"] }];
    applyNativeUltraFastTier(pooled, snapshot, selectors, true);
    expect(pooled[0]?.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    const direct: RawEntry[] = [{ slug: ASTRA, service_tiers: [PRIORITY_TIER] }];
    applyNativeUltraFastTier(direct, snapshot, selectors, true, new Set([MAIN_CODEX_ACCOUNT_ID]));
    expect(direct[0]?.service_tiers).toEqual([PRIORITY_TIER]);
  });

  test("opt-out and unconfirmed or absent evidence remove stale native Ultrafast", async () => {
    const confirmed = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential(MAIN_CODEX_ACCOUNT_ID)],
      fetcher: rosterFetcher({ mainUltra: true }),
      clientVersion: TEST_CLIENT_VERSION,
      now: 1_000,
    });
    const optedOut = rowsWithStaleUltra();
    applyNativeUltraFastTier(optedOut, confirmed, selectors, false);
    expect(optedOut[0]?.service_tiers).toEqual([PRIORITY_TIER]);
    expect(optedOut[1]?.additional_speed_tiers).toEqual(["fast"]);

    const unconfirmed = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("unknown-account")],
      fetcher: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
      clientVersion: TEST_CLIENT_VERSION,
      now: 2_000,
    });
    const stale = rowsWithStaleUltra();
    applyNativeUltraFastTier(stale, unconfirmed, selectors, true);
    expect(stale[0]?.service_tiers).toEqual([PRIORITY_TIER]);
    expect(stale[1]?.service_tiers).toEqual([PRIORITY_TIER]);

    const absent = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential(MAIN_CODEX_ACCOUNT_ID)],
      fetcher: (async () => Response.json({ models: [{
        slug: "gpt-6-sol", supported_in_api: true, visibility: "list",
      }] })) as typeof fetch,
      clientVersion: TEST_CLIENT_VERSION,
      now: 3_000,
    });
    const noLongerEntitled = rowsWithStaleUltra();
    applyNativeUltraFastTier(noLongerEntitled, absent, selectors, true);
    expect(absent.confirmedAccountIds.has(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
    expect(noLongerEntitled[0]?.service_tiers).toEqual([PRIORITY_TIER]);
  });

  test("bounded declaration validation rejects oversized, duplicate, hidden, and malformed text", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential(MAIN_CODEX_ACCOUNT_ID)],
      fetcher: (async () => Response.json({ models: [
        {
          slug: ASTRA,
          supported_in_api: true,
          visibility: "list",
          service_tiers: [{ id: "ultrafast", name: "Ultra".repeat(1000), description: "unbounded" }],
          additional_speed_tiers: ["ultrafast"],
        },
        {
          slug: "gpt-6-sol",
          supported_in_api: true,
          visibility: "list",
          service_tiers: [ULTRA_TIER, ULTRA_TIER],
          additional_speed_tiers: ["ultrafast"],
        },
        {
          slug: "gpt-6-luna",
          supported_in_api: true,
          visibility: "list",
          service_tiers: [{ ...ULTRA_TIER, description: "bad\uD800" }],
          additional_speed_tiers: ["ultrafast"],
        },
        {
          slug: "gpt-6.1-sol",
          supported_in_api: true,
          visibility: "hide",
          service_tiers: [ULTRA_TIER],
          additional_speed_tiers: ["ultrafast"],
        },
      ] })) as typeof fetch,
      clientVersion: TEST_CLIENT_VERSION,
      now: 1_000,
    });
    const stale = rowsWithStaleUltra();

    applyNativeUltraFastTier(stale, snapshot, selectors, true);

    expect(snapshot.confirmedAccountIds.has(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
    expect(snapshot.ultrafastTierByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.has(ASTRA)).toBe(false);
    expect(snapshot.ultrafastTierByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.has("gpt-6-sol")).toBe(false);
    expect(snapshot.ultrafastTierByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.has("gpt-6-luna")).toBe(false);
    expect(snapshot.modelsByAccount.get(MAIN_CODEX_ACCOUNT_ID)?.has("gpt-6.1-sol")).toBe(false);
    expect(stale[0]?.service_tiers).toEqual([PRIORITY_TIER]);
  });

  test("all catalog publication paths apply the authenticated tier projection", () => {
    const convergence = readFileSync(repoPath("src", "codex", "convergence.ts"), "utf8");
    const retainedSync = readFileSync(repoPath("src", "codex", "catalog", "retained-sync.ts"), "utf8");
    const serveOptions = readFileSync(repoPath("src", "server", "index", "serve-options.ts"), "utf8");
    expect(convergence).toContain("applyNativeUltraFastTier(catalog.models, modelEntitlements, accountTargets, config.ultraFastTier === true, bareEligibleAccountIds)");
    expect(retainedSync).toContain("applyNativeUltraFastTier(catalog.models, modelEntitlements, accountTargets, config.ultraFastTier === true, bareEligibleAccountIds)");
    expect(serveOptions).toContain("applyNativeUltraFastTier(entries, modelEntitlements, accountTargets, config.ultraFastTier === true, bareEligibleAccountIds)");
  });
});

describe("authenticated native Ultrafast declarations", () => {
  for (const model of [ASTRA, "gpt-6.1-sol"]) {
    test(`retains ${model} upstream Ultrafast evidence`, async () => {
      const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
        credentials: [credential(MAIN_CODEX_ACCOUNT_ID)],
        fetcher: (async () => Response.json({ models: [{
          slug: model, supported_in_api: true, visibility: "list",
          service_tiers: [PRIORITY_TIER, ULTRA_TIER],
          additional_speed_tiers: ["fast", "ultrafast"],
        }] })) as typeof fetch,
        clientVersion: TEST_CLIENT_VERSION, now: 1_000,
      });
      expect(snapshot.ultrafastTierByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.get(model)).toEqual(ULTRA_TIER);
      const rows: RawEntry[] = [
        { slug: model, service_tiers: [PRIORITY_TIER], additional_speed_tiers: ["fast"] },
        { slug: `desktop/${model}`, opencodex_catalog_kind: "account-selector-v1", service_tiers: [PRIORITY_TIER], additional_speed_tiers: ["fast"] },
        { slug: `pool/${model}`, opencodex_catalog_kind: "account-selector-v1", service_tiers: [PRIORITY_TIER], additional_speed_tiers: ["fast"] },
      ];
      applyNativeUltraFastTier(rows, snapshot, selectors, true);
      for (const row of rows.slice(0, 2)) {
        expect(row.service_tiers).toEqual([PRIORITY_TIER, ULTRA_TIER]);
        expect(row.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
      }
      expect(rows[2]?.service_tiers).toEqual([PRIORITY_TIER]);
      applyNativeUltraFastTier(rows, snapshot, selectors, false);
      expect(rows[0]?.service_tiers).toEqual([PRIORITY_TIER]);

    });
  }
});
