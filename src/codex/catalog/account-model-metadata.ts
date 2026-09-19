import type {
  CodexAccountModelMetadata,
  CodexCyberAccessProgram,
  CodexModelEntitlementSnapshot,
} from "../model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import { isMainCodexAccountTarget } from "../account-namespaces";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS, NATIVE_OPENAI_MODELS } from "./native-models";
import { isNativeAliasCatalogEntry } from "./metadata";
import { COMBO_NAMESPACE } from "../../combos";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import type { RawEntry } from "./parsing";

const METADATA_FIELDS = ["model_specialty", "available_access_programs"] as const;

function clearMetadata(entry: RawEntry): void {
  for (const field of METADATA_FIELDS) delete entry[field];
}

function commonMetadata(
  values: readonly CodexAccountModelMetadata[],
): CodexAccountModelMetadata | undefined {
  if (values.length === 0) return undefined;
  const result: {
    model_specialty?: "cyber";
    available_access_programs?: { cyber: readonly CodexCyberAccessProgram[] };
  } = {};
  if (values.every(value => value.model_specialty === "cyber")) result.model_specialty = "cyber";
  if (values.every(value => value.available_access_programs !== undefined)) {
    const common = values.slice(1).reduce<CodexCyberAccessProgram[]>(
      (programs, value) => programs.filter(program => value.available_access_programs!.cyber.includes(program)),
      [...values[0]!.available_access_programs!.cyber],
    );
    result.available_access_programs = { cyber: common };
  }
  return result;
}

function applyMetadata(entry: RawEntry, metadata: CodexAccountModelMetadata | undefined): void {
  clearMetadata(entry);
  if (metadata?.model_specialty !== undefined) entry.model_specialty = metadata.model_specialty;
  if (metadata?.available_access_programs !== undefined) {
    entry.available_access_programs = {
      cyber: [...metadata.available_access_programs.cyber],
    };
  }
}

/** Project only authenticated roster metadata onto genuine native catalog identities. */
export function applyAccountModelMetadata(
  entries: RawEntry[],
  snapshot: CodexModelEntitlementSnapshot,
  accountTargets: ReadonlyMap<string, string>,
  bareEligibleAccountIds?: ReadonlySet<string>,
): void {
  for (const entry of entries) {
    // Template-derived routed and combo rows can carry these fields from their native source.
    // Scrub first, then restore them only for an authenticated native identity below.
    clearMetadata(entry);
    const accountSlug = trustedAccountBoundNativeCatalogSlug(entry);
    if (accountSlug !== undefined && typeof entry.slug === "string") {
      const selector = entry.slug.slice(0, entry.slug.indexOf("/"));
      const accountId = accountTargets.get(selector);
      const normalizedAccountId = accountId && isMainCodexAccountTarget(accountId)
        ? MAIN_CODEX_ACCOUNT_ID
        : accountId;
      const confirmed = normalizedAccountId !== undefined
        && snapshot.confirmedAccountIds.has(normalizedAccountId)
        && snapshot.modelsByAccount.get(normalizedAccountId)?.has(accountSlug) === true;
      applyMetadata(entry, confirmed
        ? snapshot.metadataByAccount?.get(normalizedAccountId)?.get(accountSlug)
        : undefined);
      continue;
    }

    if (typeof entry.slug !== "string"
      || !NATIVE_OPENAI_MODELS.includes(entry.slug)
      || isNativeAliasCatalogEntry(entry)
      || entry.owned_by === COMBO_NAMESPACE
      || (entry.owned_by !== undefined
        && entry.owned_by !== null
        && entry.owned_by !== OPENAI_CODEX_PROVIDER_ID)) continue;
    const eligibleAccountIds = [...snapshot.credentialIdentities.keys()].filter(accountId => (
      !bareEligibleAccountIds || bareEligibleAccountIds.has(accountId)
    )).filter(accountId => (
      !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(entry.slug as string)
      || snapshot.modelsByAccount.get(accountId)?.has(entry.slug as string) === true
    ));
    const eligibleMetadata = eligibleAccountIds.flatMap(accountId => {
      if (!snapshot.confirmedAccountIds.has(accountId)) return [{}];
      return [snapshot.metadataByAccount?.get(accountId)?.get(entry.slug as string) ?? {}];
    });
    applyMetadata(entry, commonMetadata(eligibleMetadata));
  }
}
