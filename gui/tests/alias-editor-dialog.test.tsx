import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { useAliasEditor, type RequestAlias } from "../src/hooks/useAliasEditor";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null;
let requestAlias: RequestAlias;
let resolved: Array<string | null>;

function Probe() {
  const editor = useAliasEditor();
  requestAlias = editor.requestAlias;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void editor.requestAlias({
            title: "Edit alias",
            label: "Alias value",
            initialValue: "Existing",
          }).then(value => resolved.push(value));
        }}
      >Open editor</button>
      {editor.dialog}
    </>
  );
}

beforeEach(async () => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  root = null;
  resolved = [];

  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Probe /></LanguageProvider>);
  });
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
});

async function open(): Promise<{ trigger: HTMLButtonElement; dialog: HTMLDialogElement; input: HTMLInputElement }> {
  const trigger = host.querySelector("button") as HTMLButtonElement;
  trigger.focus();
  await act(async () => {
    trigger.click();
    await Promise.resolve();
  });
  const dialog = win.document.querySelector("dialog") as HTMLDialogElement;
  const input = dialog.querySelector("input") as HTMLInputElement;
  return { trigger, dialog, input };
}

test("renders a labelled native dialog and resolves the exact submitted value", async () => {
  const { trigger, dialog, input } = await open();
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector("h3")?.textContent).toBe("Edit alias");
  expect(dialog.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("Alias value");
  expect(input.value).toBe("Existing");
  expect(win.document.activeElement).toBe(input);

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "  exact value  ");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    dialog.querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });

  expect(resolved).toEqual(["  exact value  "]);
  expect(win.document.querySelector("dialog")).toBeNull();
  expect(win.document.activeElement).toBe(trigger);
});

test("empty input is a valid submitted value", async () => {
  const { dialog, input } = await open();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    dialog.querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(resolved).toEqual([""]);
});

test("Cancel, Escape, and backdrop dismissal each resolve null", async () => {
  let opened = await open();
  await act(async () => {
    [...opened.dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "Cancel")!.click();
    await Promise.resolve();
  });

  opened = await open();
  await act(async () => {
    opened.dialog.dispatchEvent(new win.Event("cancel", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });

  opened = await open();
  await act(async () => {
    opened.dialog.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click();
    await Promise.resolve();
  });

  expect(resolved).toEqual([null, null, null]);
});

test("overlapping requests are canceled without opening another dialog", async () => {
  await open();
  let second: string | null | undefined;
  await act(async () => {
    second = await requestAlias({ title: "Second", label: "Second", initialValue: "" });
  });
  expect(second).toBeNull();
  expect(win.document.querySelectorAll("dialog")).toHaveLength(1);
});

test("unmounting the owner cancels the pending request", async () => {
  await open();
  const current = root!;
  await act(async () => { current.unmount(); });
  root = null;
  await Promise.resolve();
  expect(resolved).toEqual([null]);
  expect(win.document.querySelector("dialog")).toBeNull();
});
