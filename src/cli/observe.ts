import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";
import { formatUsageReport } from "./usage-report";
import { USAGE_RANGES, USAGE_SURFACES } from "../usage/summary";
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { renameAtomicFile } from "../lib/windows-atomic-replace";
import {
  SUPPORT_EXPORT_MAX_REQUEST_IDS,
  SUPPORT_EXPORT_MAX_WINDOW_MS,
} from "../diagnostics/support-export";

const USAGE = `Usage:
  ocx observe logs [--provider <name>] [--model <id>] [--status <code>]
      [--conversation <id>] [--limit <n>] [--follow] [--json|--jsonl]
  ocx logs explain <request-id> [--json]
  ocx logs export (--request <id> ... | --from <ms> --to <ms>) [--out <path>] [--force]
  ocx logs rebuild-index
  ocx logs index-status
  ocx observe usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>]
      [--provider <name>] [--model <id>] [--json]
  ocx observe storage [codex-logs [status|protect|unprotect|repair|compact] [--mode <compat|quiet>]] [--json]
  ocx observe memory [--json]
  ocx observe debug [--json]
  ocx observe claude-inbound [--limit <n>] [--json]
  ocx observe injection [--limit <n>] [--json]`;

type LogEntry = Record<string, unknown> & { id?: string | number; timestamp?: string; provider?: string; model?: string; status?: number };

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

function logRows(data: unknown): LogEntry[] {
  if (Array.isArray(data)) return data as LogEntry[];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["logs", "entries", "requests"]) if (Array.isArray(record[key])) return record[key] as LogEntry[];
  }
  return [];
}

function formatLog(row: LogEntry): string {
  const time = String(row.timestamp ?? row.createdAt ?? "");
  const route = [row.provider, row.model].filter(Boolean).join("/");
  const status = row.status ?? row.statusCode ?? "?";
  const duration = row.durationMs !== undefined ? `${String(row.durationMs)}ms` : "";
  // The conversation id is shown because a conversation FILTER whose output never names the
  // conversation is hard to trust: an empty result and a wrong-id result look identical (#2704).
  const conversation = typeof row.conversationId === "string" && row.conversationId.length > 0
    ? `conv=${row.conversationId}`
    : "";
  return [time, String(status), route, duration, conversation].filter(Boolean).join("  ");
}

async function logs(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const wantsJsonl = takeFlag(args, "--jsonl");
  const follow = takeFlag(args, "--follow") || takeFlag(args, "-f");
  const provider = takeOption(args, "--provider");
  const model = takeOption(args, "--model");
  const status = takeOption(args, "--status");
  // Both spellings, because the server accepts both (`request-log.ts:1032`) and an operator
  // should not have to remember which one this surface wanted.
  const conversationId = takeOption(args, "--conversation") ?? takeOption(args, "--conversationId");
  const limit = takeIntegerOption(args, "--limit", { min: 1 }) ?? 200;
  rejectArgs(args, USAGE);
  if (wantsJson && wantsJsonl) throw new CliUsageError("--json and --jsonl cannot be combined", USAGE);
  if (follow && wantsJson) {
    throw new CliUsageError("--follow cannot be combined with --json; use --jsonl for streaming JSONL", USAGE);
  }
  let seen = new Set<string>();
  do {
    const data = await runtimeRequest(`/api/logs${query({ provider, model, status, conversationId, limit })}`, {}, deps);
    const rows = logRows(data);
    if (!follow && wantsJson) printData(data, true);
    else {
      for (const row of rows) {
        const key = String(row.id ?? `${row.timestamp}:${row.provider}:${row.model}:${row.status}`);
        if (follow && seen.has(key)) continue;
        if (wantsJsonl) console.log(JSON.stringify(row));
        else console.log(formatLog(row));
        seen.add(key);
      }
    }
    if (!follow) return;
    if (seen.size > 5_000) seen = new Set([...seen].slice(-2_500));
    await Bun.sleep(1_000);
  } while (true);
}

async function explain(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const requestId = args.shift();
  const wantsJson = takeFlag(args, "--json");
  if (!requestId) throw new CliUsageError("request id is required", USAGE);
  rejectArgs(args, USAGE);
  const encoded = encodeURIComponent(requestId);
  const result = await runtimeRequest(`/api/request-history/${encoded}/route-decision`, {}, deps);
  printData(result, wantsJson, wantsJson ? undefined : [JSON.stringify(result, null, 2)]);
}

function takeRepeatedOptions(args: string[], flag: string): string[] {
  const values: string[] = [];
  while (args.includes(flag)) {
    const value = takeOption(args, flag);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function writeSupportExport(path: string, text: string, force: boolean): void {
  if (force) {
    const temporary = join(dirname(path), `.ocx-support-${process.pid}-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, text, { encoding: "utf8" });
      closeSync(descriptor);
      descriptor = undefined;
      renameAtomicFile(temporary, path, undefined, "support-export");
      return;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }
  try {
    writeFileSync(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliUsageError("support bundle already exists; re-run with --force to replace it", USAGE);
    }
    throw error;
  }
}

async function exportSupportBundle(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const requestIds = takeRepeatedOptions(args, "--request");
  const from = takeIntegerOption(args, "--from", { min: 0 });
  const to = takeIntegerOption(args, "--to", { min: 0 });
  const out = takeOption(args, "--out");
  const force = takeFlag(args, "--force");
  rejectArgs(args, USAGE);
  const hasRequests = requestIds.length > 0;
  const hasRange = from !== undefined || to !== undefined;
  if (hasRequests === hasRange) {
    throw new CliUsageError("provide --request values or exact --from/--to, never both", USAGE);
  }
  if (hasRequests && requestIds.length > SUPPORT_EXPORT_MAX_REQUEST_IDS) {
    throw new CliUsageError(`--request may be repeated at most ${SUPPORT_EXPORT_MAX_REQUEST_IDS} times`, USAGE);
  }
  if (hasRange && (from === undefined || to === undefined)) {
    throw new CliUsageError("--from and --to must be provided together", USAGE);
  }
  if (from !== undefined && to !== undefined
    && (from > to || to - from > SUPPORT_EXPORT_MAX_WINDOW_MS)) {
    throw new CliUsageError("--from/--to must be ascending and span no more than 24 hours", USAGE);
  }
  if (force && out === undefined) throw new CliUsageError("--force requires --out", USAGE);

  const search = new URLSearchParams();
  if (hasRequests) {
    for (const requestId of requestIds) search.append("requestId", requestId);
  } else {
    search.set("from", String(from));
    search.set("to", String(to));
  }
  const result = await runtimeRequest(`/api/transaction-diagnostics/export?${search}`, {}, deps);
  const serialized = JSON.stringify(result);
  if (out !== undefined) writeSupportExport(out, serialized, force);
  else console.log(serialized);
}

async function rebuildIndex(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const { rebuildRequestHistoryIndex } = await import("../routing/history/indexer");
  const meta = await rebuildRequestHistoryIndex();
  if (wantsJson) printData(meta, true);
  else {
    console.log(`Request-history index rebuilt (${meta.dbPath})`);
    console.log(`  schema version: ${meta.schemaVersion}`);
    console.log(`  indexed rows:   ${meta.indexedRows}`);
    console.log(`  source size:    ${meta.sourceSize} bytes`);
    console.log(`  last error:     ${meta.lastError ?? "none"}`);
  }
}

async function indexStatus(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const { requestHistoryIndexStatus } = await import("../routing/history/indexer");
  const meta = await requestHistoryIndexStatus();
  if (wantsJson) printData(meta, true);
  else {
    console.log(`Request-history index (${meta.dbPath})`);
    console.log(`  schema version: ${meta.schemaVersion}`);
    console.log(`  indexed rows:   ${meta.indexedRows}`);
    console.log(`  source size:    ${meta.sourceSize} bytes`);
    console.log(`  indexed offset: ${meta.indexedOffset} bytes`);
    console.log(`  last error:     ${meta.lastError ?? "none"}`);
  }
}

async function usage(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const range = takeOption(args, "--range") ?? "30d";
  const surface = takeOption(args, "--surface") ?? "all";
  const provider = takeOption(args, "--provider");
  const model = takeOption(args, "--model");
  // `1d` is accepted here as well as server-side so the CLI does not reject an
  // alias the API would have understood.
  const ranges = [...USAGE_RANGES, "1d"];
  if (!ranges.includes(range)) throw new CliUsageError(`--range must be one of ${USAGE_RANGES.join(", ")} (1d aliases today)`, USAGE);
  if (!USAGE_SURFACES.includes(surface as (typeof USAGE_SURFACES)[number])) {
    throw new CliUsageError(`--surface must be one of ${USAGE_SURFACES.join(", ")}`, USAGE);
  }
  rejectArgs(args, USAGE);
  const result = await runtimeRequest(`/api/usage${query({ range, surface, provider, model })}`, {}, deps);
  // Built only when it will be printed: JavaScript evaluates arguments before
  // the call, so passing formatUsageReport(...) inline would run the human
  // renderer during --json and let its assumptions affect a path that is meant
  // to bypass it entirely.
  if (wantsJson) printData(result, true);
  else printData(result, false, formatUsageReport(result as Parameters<typeof formatUsageReport>[0]));
}

async function simple(path: string, argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const limit = takeIntegerOption(args, "--limit", { min: 1 });
  rejectArgs(args, USAGE);
  const result = await runtimeRequest(`${path}${query({ limit })}`, {}, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function storage(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  if (argv[0] !== "codex-logs") {
    await simple("/api/storage", argv, deps);
    return;
  }

  const args = argv.slice(1);
  const action = args[0] && !args[0].startsWith("-") ? args.shift()! : "status";
  const wantsJson = takeFlag(args, "--json");
  const mode = takeOption(args, "--mode");
  rejectArgs(args, USAGE);

  let result: unknown;
  if (action === "status") {
    if (mode !== undefined) throw new CliUsageError("--mode is only valid with codex-logs protect", USAGE);
    result = await runtimeRequest("/api/storage/codex-logs", {}, deps);
  } else if (action === "protect") {
    const requestedMode = mode ?? "compat";
    if (requestedMode !== "compat" && requestedMode !== "quiet") {
      throw new CliUsageError("--mode must be compat or quiet", USAGE);
    }
    result = await runtimeRequest("/api/storage/codex-logs/protect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: requestedMode }),
    }, deps);
  } else if (action === "unprotect" || action === "repair" || action === "compact") {
    if (mode !== undefined) throw new CliUsageError("--mode is only valid with codex-logs protect", USAGE);
    result = await runtimeRequest(`/api/storage/codex-logs/${action}`, { method: "POST" }, deps);
  } else {
    throw new CliUsageError(`unknown codex-logs action ${action}`, USAGE);
  }

  printData(result, wantsJson, summaryLines(result));
}

export async function handleObserveCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "logs", ...rest] = argv;
    if (sub === "logs") {
      const action = rest[0];
      if (action === "explain") await explain(rest.slice(1), deps);
      else if (action === "export") await exportSupportBundle(rest.slice(1), deps);
      else if (action === "rebuild-index") await rebuildIndex(rest.slice(1), deps);
      else if (action === "index-status") await indexStatus(rest.slice(1), deps);
      else await logs(rest, deps);
    }
    else if (sub === "usage") await usage(rest, deps);
    else if (sub === "storage") await storage(rest, deps);
    else if (sub === "memory") await simple("/api/system/memory", rest, deps);
    else if (sub === "debug") await simple("/api/debug", rest, deps);
    else if (sub === "claude-inbound") await simple("/api/claude/inbound-debug", rest, deps);
    else if (sub === "injection") await simple("/api/debug/injection-logs", rest, deps);
    else throw new CliUsageError(`unknown observe command ${sub}`, USAGE);
  });
}

export const OBSERVE_USAGE = USAGE;
