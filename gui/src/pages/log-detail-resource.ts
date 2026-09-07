import { useCallback, useEffect, useState } from "react";
import type { LogEntry } from "./Logs";
import { sanitizeLogEvidence } from "./log-diagnostics";
import { sanitizeLogEntryRouteDecision } from "./log-route-decision";

interface DetailResult {
  summary: LogEntry;
  apiBase: string;
  attempt: number;
  entry?: LogEntry;
  error: boolean;
}

/** A selected summary never masquerades as complete diagnostic evidence. */
export function useLogDetail(apiBase: string, summary: LogEntry) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<DetailResult>();
  const needsDetail = summary.detailAvailable === true;
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    if (!needsDetail) return;
    const controller = new AbortController();
    let active = true;
    const fail = () => {
      if (active) setResult({ summary, apiBase, attempt, error: true });
    };
    const timeout = window.setTimeout(() => { controller.abort(); fail(); }, 15_000);
    void (async () => {
      try {
        if (!summary.requestId) throw new Error("missing_request_id");
        const response = await fetch(`${apiBase}/api/logs/detail?requestId=${encodeURIComponent(summary.requestId)}`, { signal: controller.signal });
        if (!response.ok) throw new Error("detail_unavailable");
        const value: unknown = await response.json();
        if (!active || controller.signal.aborted) return;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_detail");
        const entry = value as LogEntry;
        if (entry.requestId !== summary.requestId || entry.timestamp !== summary.timestamp
          || typeof entry.model !== "string" || typeof entry.provider !== "string"
          || !Number.isFinite(entry.status) || !Number.isFinite(entry.durationMs)) throw new Error("invalid_detail");
        const clean = sanitizeLogEvidence(sanitizeLogEntryRouteDecision(entry));
        delete clean.detailAvailable;
        setResult({ summary, apiBase, attempt, entry: clean, error: false });
      } catch {
        if (!controller.signal.aborted) fail();
      } finally { window.clearTimeout(timeout); }
    })();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [apiBase, summary, needsDetail, attempt]);
  const current = result?.summary === summary && result.apiBase === apiBase && result.attempt === attempt ? result : undefined;
  return {
    entry: needsDetail ? current?.entry ?? summary : summary,
    loading: needsDetail && current === undefined,
    error: needsDetail && current?.error === true,
    retry,
  };
}
