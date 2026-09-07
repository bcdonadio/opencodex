import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { LogDiagnosticsDetails } from "../src/pages/log-diagnostics-details";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: unknown[];
let win: Window;
let root: Root;
let container: HTMLElement;
const originalFetch = globalThis.fetch;
const diagnostics = {
  schemaVersion: 1, diagnosticCaptureVersion: 1, transactionId: "tx-selected", recordKind: "request",
  receivedAt: 1000, timestampSource: "proxy_wall_clock", retentionClass: "usage_ledger",
  redactionVersion: 1, correlationSource: "proxy", correlationConfidence: "direct",
  captureTruncated: false, redactionApplied: true, droppedDiagnosticEventCount: 0,
  httpStatus: 200, fieldAvailability: { usageSource: { status: "not_observed", source: "upstream" } },
  events: Array.from({ length: 64 }, (_, i) => ({ eventSequence: i + 1, at: 1000 + i,
    type: "response.created", source: "upstream", responseId: `response-${i}` })),
};
const attempts = Array.from({ length: 64 }, (_, i) => ({ attemptId: `attempt-${i}`, ordinal: i + 1,
  sends: Array.from({ length: 16 }, (_, j) => ({ sendId: `send-${i}-${j}`, sendOrdinal: j + 1, startedAt: 1000 })) }));

beforeEach(async () => {
  previous = globals.map(key => Reflect.get(globalThis, key));
  win = new Window({ url: "http://localhost" });
  globals.forEach(key => Object.defineProperty(globalThis, key, { configurable: true,
    value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(win, key) }));
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  win.close();
  globals.forEach((key, i) => Object.defineProperty(globalThis, key, { configurable: true, value: previous[i] }));
});
async function mount(evidence: unknown = diagnostics, sends: unknown = attempts) {
  await act(async () => root.render(<LanguageProvider><LogDiagnosticsDetails diagnostics={evidence}
    attempts={sends} requestId="req/selected?" apiBase="http://localhost" /></LanguageProvider>));
}
async function toggle(element: HTMLDetailsElement, open = true) {
  await act(async () => {
    element.open = open;
    element.dispatchEvent(new win.Event("toggle"));
  });
}
function disclosure(text: string) {
  return [...container.querySelectorAll("summary")].find(summary => summary.textContent?.startsWith(text))!.parentElement as HTMLDetailsElement;
}

test("closed diagnostics does not traverse evidence or mount hidden fields", async () => {
  let reads = 0;
  await mount({ get schemaVersion() { reads++; return 1; } }, [{ get attemptId() { reads++; return "attempt"; } }]);
  expect(reads).toBe(0);
  expect(container.querySelectorAll("dl, button").length).toBe(0);
});

test("opening diagnostics preserves fields and availability while bounding large hidden collections", async () => {
  await mount();
  await toggle(disclosure("Diagnostics"));
  expect(container.textContent).toContain("tx-selected");
  expect(container.textContent).toContain("Not observed");
  expect(container.textContent).not.toContain("response-0");
  expect(container.textContent).not.toContain("send-0-0");
  expect(container.querySelectorAll("*").length).toBeLessThan(250);
  await toggle(disclosure("Diagnostics"), false);
  expect(container.querySelectorAll("dl, button").length).toBe(0);
});

test("event and attempt disclosures expose selected evidence and unmount it on collapse", async () => {
  await mount();
  await toggle(disclosure("Diagnostics"));
  await toggle(disclosure("Lifecycle"));
  expect(container.textContent).not.toContain("response-0");
  const event = disclosure("response.created");
  await toggle(event);
  expect(container.textContent).toContain("response-0");
  await toggle(event, false);
  expect(container.textContent).not.toContain("response-0");
  await toggle(disclosure("Attempts"));
  await toggle(disclosure("Attempts and sends · 1"));
  const attempt = disclosure("send-0-0");
  expect(attempt.querySelector("dl")).toBeNull();
  await toggle(attempt);
  expect(attempt.textContent).toContain("attempt-0");
  expect(attempt.textContent).toContain("startedAt");
});

test("export targets only selected request and retains busy and failure feedback", async () => {
  let resolve!: (response: Response) => void;
  const requests: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Promise<Response>(done => { resolve = done; });
  }) as typeof fetch;
  await mount();
  expect(requests).toEqual([]);
  await toggle(disclosure("Diagnostics"));
  const button = container.querySelector("button")!;
  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  expect(requests).toEqual(["http://localhost/api/transaction-diagnostics/export?requestId=req%2Fselected%3F"]);
  await act(async () => resolve(new Response("failed", { status: 500 })));
  expect(button.disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(disclosure("Diagnostics").open).toBe(true);
});
