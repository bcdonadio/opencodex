import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { useT } from "../i18n/shared";

export interface AliasEditorRequest {
  title: string;
  label: string;
  initialValue: string;
}

export default function AliasEditorDialog({
  request,
  opener,
  onCancel,
  onSubmit,
}: {
  request: AliasEditorRequest;
  opener: HTMLElement | null;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const [value, setValue] = useState(request.initialValue);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [opener]);

  const handleCancel = useCallback((event: SyntheticEvent) => {
    event.preventDefault();
    onCancel();
  }, [onCancel]);

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby={titleId} onCancel={handleCancel}>
      <button
        type="button"
        className="modal-backdrop-dismiss"
        aria-label={t("common.close")}
        tabIndex={-1}
        onClick={onCancel}
      />
      <form
        className="modal-card"
        role="document"
        onClick={event => event.stopPropagation()}
        onSubmit={event => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        <div className="modal-head">
          <h3 id={titleId}>{request.title}</h3>
        </div>
        <label className="field" htmlFor={inputId}>
          <span className="muted text-label">{request.label}</span>
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className="input"
          type="text"
          value={value}
          autoFocus
          onChange={event => setValue(event.target.value)}
        />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="submit" className="btn btn-primary">{t("common.save")}</button>
        </div>
      </form>
    </dialog>
  );
}
