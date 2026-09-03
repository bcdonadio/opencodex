import { expect, test } from "bun:test";

test("runtime GUI sources never use browser-native prompt dialogs", async () => {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const promptCalls: string[] = [];

  for await (const path of glob.scan({ cwd: new URL("../src/", import.meta.url).pathname })) {
    const source = await Bun.file(new URL(`../src/${path}`, import.meta.url)).text();
    if (/\b(?:window\s*\.\s*)?prompt\s*\(/.test(source)) promptCalls.push(path);
  }

  expect(promptCalls.sort()).toEqual([]);
});
