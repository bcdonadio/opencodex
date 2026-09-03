import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Providers from "../src/pages/Providers";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null;
let kind: "oauth" | "api-key";
let requests: Array<{ path: string; method: string; body?: unknown }>;

const providerFor = () => kind === "oauth" ? "anthropic" : "xai";

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  clearClientResourceStoresForTests();
  win = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  root = null;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  clearClientResourceStoresForTests();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
});

function installFetch() {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      requests.push({
        path: `${url.pathname}${url.search}`,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const provider = providerFor();
      if (url.pathname === "/api/config") {
        return Response.json({
          port: 10100,
          defaultProvider: provider,
          providers: {
            [provider]: kind === "oauth"
              ? { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" }
              : { adapter: "openai", baseUrl: "https://api.x.ai/v1", authMode: "key", hasApiKey: true },
          },
        });
      }
      if (url.pathname === "/api/oauth/providers") {
        return Response.json({ providers: kind === "oauth" ? [provider] : [] });
      }
      if (url.pathname === "/api/oauth/status") return Response.json({ loggedIn: true });
      if (url.pathname === "/api/oauth/accounts") {
        return Response.json({
          activeAccountId: "oauth-1",
          accounts: [{ id: "oauth-1", alias: "Existing OAuth", email: "person@example.test", active: true }],
        });
      }
      if (url.pathname === "/api/providers/keys" && method === "GET") {
        return Response.json({ keys: [{ id: "key-1", label: "Existing key", masked: "sk-…1234", active: true }] });
      }
      if (url.pathname === "/api/oauth/accounts/alias" || url.pathname === "/api/providers/keys/alias") {
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/provider-quotas") return Response.json({ reports: [] });
      if (url.pathname === "/api/selected-models") return Response.json({ selected: {}, available: {} });
      if (url.pathname === "/api/usage") return Response.json({ providers: [], models: [] });
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: {} });
      if (url.pathname === "/api/codex-auth/accounts") return Response.json({ accounts: [] });
      if (url.pathname === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: null, autoSwitchThreshold: 80 });
      return Response.json({});
    },
  });
}

async function mountAndOpenAccounts() {
  installFetch();
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Providers apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 120)); });

  const rail = host.querySelector<HTMLButtonElement>('[role="option"]');
  expect(rail).toBeTruthy();
  await act(async () => { rail!.click(); });
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });

  const tab = host.querySelector<HTMLButtonElement>("#pws-tab-accounts");
  expect(tab).toBeTruthy();
  await act(async () => { tab!.click(); });
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 20)); });
}

for (const scenario of [
  {
    kind: "oauth" as const,
    initial: "Existing OAuth",
    expectedPath: "/api/oauth/accounts/alias",
    expectedBody: { provider: "anthropic", accountId: "oauth-1", alias: "Renamed" },
  },
  {
    kind: "api-key" as const,
    initial: "Existing key",
    expectedPath: "/api/providers/keys/alias",
    expectedBody: { name: "xai", id: "key-1", alias: "Renamed" },
  },
]) {
  test(`${scenario.kind} aliases use the shared dialog and preserve their wire contract`, async () => {
    kind = scenario.kind;
    await mountAndOpenAccounts();
    const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "Edit alias");
    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");

    await act(async () => {
      trigger!.click();
      await Promise.resolve();
    });
    const dialog = win.document.querySelector<HTMLDialogElement>("dialog");
    const input = dialog?.querySelector<HTMLInputElement>("input");
    expect(input?.value).toBe(scenario.initial);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "  Renamed  ");
      input!.dispatchEvent(new win.Event("input", { bubbles: true }));
      dialog!.querySelector<HTMLFormElement>("form")!
        .dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
      await new Promise(resolve => win.setTimeout(resolve, 120));
    });

    expect(requests.find(request => request.path === scenario.expectedPath && request.method === "PUT"))
      .toEqual({ path: scenario.expectedPath, method: "PUT", body: scenario.expectedBody });
    expect(win.document.body.textContent).toContain("Alias saved");
  });
}

test("canceling a provider credential alias edit issues no write", async () => {
  kind = "oauth";
  await mountAndOpenAccounts();
  const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "Edit alias")!;
  await act(async () => { trigger.click(); await Promise.resolve(); });
  const dialog = win.document.querySelector<HTMLDialogElement>("dialog")!;
  const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "Cancel")!;
  await act(async () => { cancel.click(); await Promise.resolve(); });

  expect(requests.some(request => request.method === "PUT" && request.path.endsWith("/alias"))).toBe(false);
  expect(win.document.querySelector("dialog")).toBeNull();
});
