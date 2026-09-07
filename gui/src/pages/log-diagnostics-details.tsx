import { useMemo, useState, type ReactNode } from "react";
import { useI18n, type TKey } from "../i18n/shared";
import { parseLogDiagnostics, parseAttemptEvidence, type EvidenceFields } from "./log-diagnostics";

const labels: Record<string, TKey> = {
  httpStatus: "logs.diagnostics.http", terminalMappedStatus: "logs.diagnostics.mapped",
  outputDeliveredBeforeFailure: "logs.diagnostics.output", terminalSource: "logs.diagnostics.terminal",
  transportPhase: "logs.diagnostics.phase", usageMissingReason: "logs.diagnostics.usage",
};
const states: Record<string, TKey> = {
  observed: "logs.diagnostics.observed", derived: "logs.diagnostics.derived",
  unsupported: "logs.diagnostics.unsupported", not_observed: "logs.diagnostics.notObserved",
  redacted: "logs.diagnostics.redacted", truncated: "logs.diagnostics.truncated", unknown: "logs.diagnostics.unknown",
};
type DiagnosticsProps = {
  diagnostics?: unknown; attempts?: unknown; requestId?: string; apiBase: string;
};

function LazyDisclosure({ title, children, className }: {
  title: ReactNode; children: () => ReactNode; className?: string;
}) {
  const [open, setOpen] = useState(false);
  return <details className={className} onToggle={event => {
    if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
  }}>
    <summary>{title}</summary>
    {open && children()}
  </details>;
}

export function LogDiagnosticsDetails(props: DiagnosticsProps) {
  const { t } = useI18n();
  return <LazyDisclosure title={t("logs.diagnostics.title")} className="log-diagnostics log-detail-section">
    {() => <DiagnosticsContent {...props} />}
  </LazyDisclosure>;
}

function DiagnosticsContent({ diagnostics, attempts, requestId, apiBase }: DiagnosticsProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const evidence = useMemo(() => parseLogDiagnostics(diagnostics), [diagnostics]);
  const download = async () => {
    if (!requestId || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // The app's installed fetch wrapper supplies the dashboard session, as for /api/logs.
      const response = await fetch(`${apiBase}/api/transaction-diagnostics/export?requestId=${encodeURIComponent(requestId)}`);
      if (!response.ok) throw new Error("export_failed");
      const bundle: unknown = await response.json();
      if (!bundle || typeof bundle !== "object" || !("exportSchemaVersion" in bundle) || bundle.exportSchemaVersion !== 1) throw new Error("invalid_export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      try {
        anchor.href = url;
        anchor.download = "transaction-diagnostics.json";
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        URL.revokeObjectURL(url);
      }
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  const renderFields = (fields: EvidenceFields) => (
    <dl className="log-diagnostics-grid">
      {Object.entries(fields).map(([key, value]) => (
        <div key={key}>
          <dt>{labels[key] ? t(labels[key]) : <code>{key}</code>}</dt>
          <dd>{typeof value === "boolean" ? t(value ? "logs.diagnostics.yes" : "logs.diagnostics.no") : <code>{String(value)}</code>}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <>
      {!evidence ? <p>{t("logs.diagnostics.unavailable")}</p> : <>
        {evidence.fields.captureTruncated && <p>{t("logs.diagnostics.truncated")}</p>}
        <h4>{t("logs.diagnostics.evidence")}</h4>
        {renderFields(evidence.fields)}
        <LazyDisclosure title={t("logs.diagnostics.lifecycle")}>
          {() => evidence.events.length ? <ol>{evidence.events.map((event, i) => <li key={i}>
            <LazyDisclosure title={<code>{event.type} · {event.eventSequence}</code>}>
              {() => renderFields(event)}
            </LazyDisclosure>
          </li>)}</ol> : <p>{t("logs.diagnostics.unavailable")}</p>}
        </LazyDisclosure>
        <h4>{t("logs.diagnostics.availability")}</h4>
        <dl className="log-diagnostics-grid">{Object.entries(evidence.availability).map(([key, value]) => <div key={key}>
          <dt><code>{key}</code></dt><dd>{t(states[value.status])}{value.source && <> · <code>{value.source}</code></>}</dd>
        </div>)}</dl>
      </>}
      <LazyDisclosure title={t("logs.diagnostics.attempts")}>
        {() => Array.isArray(attempts) && attempts.length ? attempts.slice(0, 64).map((attempt, i) => (
          <LazyDisclosure key={i} title={<>{t("logs.diagnostics.attempts")} · {i + 1}</>}>
            {() => parseAttemptEvidence([attempt]).map((send, j) => (
              <LazyDisclosure key={j} title={<code>{send.sendId ?? send.attemptId ?? j + 1}</code>}>
                {() => renderFields(send)}
              </LazyDisclosure>
            ))}
          </LazyDisclosure>
        )) : <p>{t("logs.diagnostics.unavailable")}</p>}
      </LazyDisclosure>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!requestId || busy} onClick={() => void download()}>
        {t(busy ? "logs.diagnostics.downloading" : "logs.diagnostics.download")}
      </button>
      {failed && <p role="alert">{t("logs.diagnostics.failed")}</p>}
    </>
  );
}
