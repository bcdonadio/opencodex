import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import AliasEditorDialog, { type AliasEditorRequest } from "../components/AliasEditorDialog";

export type RequestAlias = (request: AliasEditorRequest) => Promise<string | null>;

export function useAliasEditor(): { requestAlias: RequestAlias; dialog: ReactNode } {
  const [pending, setPending] = useState<{ request: AliasEditorRequest; opener: HTMLElement | null } | null>(null);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  const finish = useCallback((value: string | null) => {
    const resolve = resolverRef.current;
    if (!resolve) return;
    resolverRef.current = null;
    setPending(null);
    resolve(value);
  }, []);

  const requestAlias = useCallback<RequestAlias>((nextRequest) => {
    if (resolverRef.current) return Promise.resolve(null);
    return new Promise(resolve => {
      resolverRef.current = resolve;
      setPending({
        request: nextRequest,
        opener: document.activeElement as HTMLElement | null,
      });
    });
  }, []);

  useEffect(() => () => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(null);
  }, []);

  return {
    requestAlias,
    dialog: pending ? (
      <AliasEditorDialog
        request={pending.request}
        opener={pending.opener}
        onCancel={() => finish(null)}
        onSubmit={finish}
      />
    ) : null,
  };
}
