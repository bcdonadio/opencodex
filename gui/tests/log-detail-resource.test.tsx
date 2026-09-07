import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { useLogDetail } from "../src/pages/log-detail-resource";
import type { LogEntry } from "../src/pages/Logs";

const originalFetch = globalThis.fetch;
const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: unknown[];
let browser: Window;
let root: Root;
let container: HTMLElement;
const row: LogEntry = { requestId: "req/one?", timestamp: 10, model: "test", provider: "test", status: 200, durationMs: 2, detailAvailable: true };
function Probe({ entry = row, apiBase = "http://isolated" }: { entry?: LogEntry; apiBase?: string }) {
  const detail = useLogDetail(apiBase, entry);
  return <><span>{detail.loading ? "loading" : detail.error ? "failed" : detail.entry.model}</span>
    <button onClick={detail.retry}>retry</button><pre>{JSON.stringify(detail.entry)}</pre></>;
}
async function render(entry = row, apiBase = "http://isolated") {
  await act(async () => { root.render(<Probe entry={entry} apiBase={apiBase} />); });
}
beforeEach(async () => {
  previous = keys.map(key => Reflect.get(globalThis, key));
  browser = new Window();
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(browser, key === "window" ? "self" : key) });
  container = document.createElement("div"); document.body.append(container);
  const { createRoot } = await import("react-dom/client"); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  jest.useRealTimers();
  browser.close(); globalThis.fetch = originalFetch;
  keys.forEach((key, i) => Object.defineProperty(globalThis, key, { configurable: true, value: previous[i] }));
});
test("selected summary fetches only its encoded ID and rejects unknown evidence", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async input => {
    calls.push(String(input));
    return Response.json({ ...row, model: "full", diagnostics: { rawBody: "private" } });
  }) as typeof fetch;
  await render();
  expect(calls).toEqual(["http://isolated/api/logs/detail?requestId=req%2Fone%3F"]);
  expect(container.querySelector("span")!.textContent).toBe("full");
  expect(container.querySelector("pre")!.textContent).not.toContain("private");
});
test("legacy full rows do not fetch a detail endpoint", async () => {
  let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch;
  await render({ ...row, detailAvailable: undefined });
  expect(calls).toBe(0); expect(container.querySelector("span")!.textContent).toBe("test");
});
test("eviction and malformed identity stay visibly failed and retry can recover", async () => {
  let mode = 0;
  globalThis.fetch = (async () => mode === 0 ? Response.json({}, { status: 404 })
    : Response.json({ ...row, requestId: mode === 1 ? "wrong" : row.requestId, model: "recovered" })) as typeof fetch;
  await render(); expect(container.querySelector("span")!.textContent).toBe("failed");
  mode = 1; await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("span")!.textContent).toBe("failed");
  mode = 2; await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("span")!.textContent).toBe("recovered");
});
test("late body from an aborted selection cannot overwrite the new resource", async () => {
  let finish!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (input, init) => {
    if (String(input).startsWith("http://isolated/")) {
      signal = init?.signal as AbortSignal;
      return { ok: true, json: () => new Promise(resolve => { finish = resolve; }) } as Response;
    }
    return Response.json({ ...row, requestId: "second", model: "second-full" });
  }) as typeof fetch;
  await render(); expect(container.querySelector("span")!.textContent).toBe("loading");
  await render({ ...row, requestId: "second" }, "http://other");
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish({ ...row, model: "obsolete" }); });
  expect(container.querySelector("span")!.textContent).toBe("second-full");
  expect(container.textContent).not.toContain("obsolete");
});

test("a stalled detail request times out visibly and ignores a late body", async () => {
  jest.useFakeTimers();
  let finish!: (value: unknown) => void;
  globalThis.fetch = (async () => ({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) }) as Response) as typeof fetch;
  await render();
  expect(container.querySelector("span")!.textContent).toBe("loading");
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(container.querySelector("span")!.textContent).toBe("failed");
  await act(async () => { finish({ ...row, model: "too-late" }); });
  expect(container.querySelector("span")!.textContent).toBe("failed");
});
