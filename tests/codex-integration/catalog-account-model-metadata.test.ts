import { describe, expect, test } from "bun:test";
import { applyAccountModelMetadata } from "../../src/codex/catalog/account-model-metadata";
import {
  resolveCodexModelEntitlements,
  type CodexModelEntitlementSnapshot,
} from "../../src/codex/model-entitlements";

const DAYBREAK = "gpt-daybreak-blue-latest";

function snapshot(
  metadata: Record<string, Record<string, unknown>>,
  confirmed = Object.keys(metadata),
): CodexModelEntitlementSnapshot {
  return {
    modelsByAccount: new Map(Object.keys(metadata).map(account => [account, new Set([DAYBREAK])])),
    metadataByAccount: new Map(Object.entries(metadata).map(([account, value]) => [
      account,
      new Map([[DAYBREAK, value]]),
    ])) as CodexModelEntitlementSnapshot["metadataByAccount"],
    clientVersionByAccount: new Map(Object.keys(metadata).map(account => [account, "0.155.1"])),
    confirmedAccountIds: new Set(confirmed),
    credentialIdentities: new Map(Object.keys(metadata).map(account => [account, `test:${account}`])),
  };
}

describe("authenticated catalog model metadata", () => {
  test("retains only validated fields from an authenticated roster", async () => {
    const resolved = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [{
        accountId: "main",
        accessToken: "token",
        chatgptAccountId: "chatgpt-main",
        credentialIdentity: "test:main",
      }],
      fetcher: (async () => Response.json({ models: [{
        slug: DAYBREAK,
        supported_in_api: true,
        visibility: "list",
        model_specialty: "cyber",
        available_access_programs: {
          cyber: ["standard", "unknown", "daybreak_blue"],
          internal: ["secret"],
        },
        unrelated_private_field: "discard-me",
      }] })) as typeof fetch,
      now: 1_000,
      clientVersion: "0.155.1",
    });
    expect(resolved.metadataByAccount?.get("main")?.get(DAYBREAK)).toEqual({
      model_specialty: "cyber",
      available_access_programs: { cyber: ["standard", "daybreak_blue"] },
    });
  });

  test("projects per-account metadata and the conservative bare intersection", () => {
    const entries = [
      { slug: DAYBREAK, model_specialty: "stale", available_access_programs: { cyber: ["stale"] } },
      { slug: `alice/${DAYBREAK}`, opencodex_catalog_kind: "account-selector-v1" },
      { slug: `bob/${DAYBREAK}`, opencodex_catalog_kind: "account-selector-v1" },
      { slug: `openai/${DAYBREAK}` },
    ];
    applyAccountModelMetadata(entries, snapshot({
      a: { model_specialty: "cyber", available_access_programs: { cyber: ["standard", "daybreak_blue"] } },
      b: { model_specialty: "cyber", available_access_programs: { cyber: ["standard"] } },
    }), new Map([["alice", "a"], ["bob", "b"]]));

    expect(entries[0]).toMatchObject({
      model_specialty: "cyber",
      available_access_programs: { cyber: ["standard"] },
    });
    expect(entries[1]).toMatchObject({ available_access_programs: { cyber: ["standard", "daybreak_blue"] } });
    expect(entries[2]).toMatchObject({ available_access_programs: { cyber: ["standard"] } });
    expect(entries[3]).not.toHaveProperty("available_access_programs");
    expect(JSON.parse(JSON.stringify(entries))[1].available_access_programs.cyber).toEqual(["standard", "daybreak_blue"]);
  });

  test("clears stale metadata after omission and preserves an explicit empty program list", () => {
    const omitted = [{
      slug: DAYBREAK,
      model_specialty: "cyber",
      available_access_programs: { cyber: ["daybreak_blue"] },
    }];
    applyAccountModelMetadata(omitted, snapshot({ a: {} }), new Map());
    expect(omitted[0]).not.toHaveProperty("model_specialty");
    expect(omitted[0]).not.toHaveProperty("available_access_programs");

    const explicitEmpty = [{ slug: DAYBREAK }];
    applyAccountModelMetadata(explicitEmpty, snapshot({
      a: { available_access_programs: { cyber: [] } },
    }), new Map());
    expect(explicitEmpty[0].available_access_programs).toEqual({ cyber: [] });
  });

  test("does not project unconfirmed account metadata", () => {
    const entries = [{ slug: DAYBREAK }, {
      slug: `alice/${DAYBREAK}`,
      opencodex_catalog_kind: "account-selector-v1",
      model_specialty: "cyber",
    }];
    applyAccountModelMetadata(entries, snapshot({ a: { model_specialty: "cyber" } }, []), new Map([["alice", "a"]]));
    expect(entries.every(entry => entry.model_specialty === undefined)).toBe(true);
  });

  test("an unconfirmed eligible account suppresses bare ungated metadata", () => {
    const entries = [{ slug: "gpt-5.6-sol", available_access_programs: { cyber: ["standard"] } }];
    const evidence = snapshot({
      a: { available_access_programs: { cyber: ["standard"] } },
      b: {},
    }, ["a"]);
    evidence.modelsByAccount.get("a")!.add("gpt-5.6-sol");
    evidence.modelsByAccount.get("b")!.add("gpt-5.6-sol");
    applyAccountModelMetadata(entries, evidence, new Map());
    expect(entries[0]).not.toHaveProperty("available_access_programs");
  });

  test("scrubs inherited metadata from routed and native-alias combo rows", () => {
    const entries = [{
      slug: `gateway/${DAYBREAK}`,
      owned_by: "gateway",
      model_specialty: "cyber",
      available_access_programs: { cyber: ["daybreak_blue"] },
    }, {
      slug: "gpt-5.6-sol",
      owned_by: "combo",
      opencodex_catalog_kind: "combo-native-alias-v1",
      model_specialty: "cyber",
      available_access_programs: { cyber: ["standard"] },
    }];
    applyAccountModelMetadata(entries, snapshot({
      a: { model_specialty: "cyber", available_access_programs: { cyber: ["standard"] } },
    }), new Map());
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("model_specialty");
      expect(entry).not.toHaveProperty("available_access_programs");
    }
  });
});
