import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  copyPreviousResponseReplayProvenance,
  expandPreviousResponseInput,
  flushPendingResponseSpillsForTests,
  flushResponseState,
  getStoredResponseBytesForTests,
  markBodyNonPersistable,
  previousResponseReplayFailure,
  previousResponseReplayPrefixLength,
  rememberResponseState,
  responseAdmissionCountersForTests,
  responseContinuationRetainedStoreSnapshot,
  setResponseStateByteCapForTests,
} from "../../src/responses/state";
import {
  deleteResponseSpill,
  readResponseSpill,
  responseSpillDirectory,
  setResponseSpillPayloadCapForTests,
  setSpillIoForTest,
  writeResponseSpillDurably,
} from "../../src/responses/spill-store";
import {
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../../src/lib/windows-secret-acl";
import {
  resetWindowsPrincipalForTests,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
} from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const canSymlink = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), "ocx-state-symlink-probe-"));
  try {
    symlinkSync(join(probeDir, "probe-target"), join(probeDir, "probe-link"));
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
    throw e;
  } finally {
    removeTreeWithRetry(probeDir);
  }
})();

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const SYNTHETIC_SID = { success: true, exitCode: 0, timedOut: false, stdout: "S-1-5-21-1-2-3-1001\nocx-test\n" };
function forceWindowsAclLane(): void {
  setPlatformForTests("win32");
  setWindowsPrincipalRunnerForTests(() => SYNTHETIC_SID);
  setAsyncWindowsPrincipalRunnerForTests(async () => SYNTHETIC_SID);
}

describe("Responses state admission boundary (oversized direct-spill)", () => {
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-admission-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    // Every case here asserts the synchronous direct-spill lane; see the outer describe.
    setPlatformForTests("linux");
  });

  afterEach(() => {
    setSpillIoForTest(null);
    setResponseStateByteCapForTests(null);
    setResponseSpillPayloadCapForTests(null);
    setPlatformForTests(null);
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    setWindowsPrincipalRunnerForTests(null);
    setAsyncWindowsPrincipalRunnerForTests(null);
    resetWindowsPrincipalForTests();
    resetHardenedStateForTests();
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  function completedResponse(id: string, text: string) {
    return {
      id,
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      }],
    };
  }

  function expandChained(id: string): unknown {
    return expandPreviousResponseInput({
      model: "cursor/auto",
      previous_response_id: id,
      input: [{ type: "function_call_output", call_id: "call_next", output: "ok" }],
    });
  }

  test("oversized candidate direct-spills without demoting unrelated residents", () => {
    setResponseStateByteCapForTests(4 * 1024);
    rememberResponseState({ model: "m", input: "a" }, completedResponse("resp_small_1", "s1"));
    rememberResponseState({ model: "m", input: "b" }, completedResponse("resp_small_2", "s2"));
    const directBefore = responseAdmissionCountersForTests().directSpills;

    rememberResponseState({ model: "m", input: "big" }, completedResponse("resp_big", "x".repeat(8 * 1024)));

    expect(responseAdmissionCountersForTests().directSpills).toBe(directBefore + 1);
    const snapshot = responseContinuationRetainedStoreSnapshot();
    // Both small entries stay RESIDENT (evictable); the big entry is a stub (pinned).
    expect(snapshot.evictableBytes).toBeGreaterThan(0);
    expect(snapshot.pinnedBytes).toBeGreaterThan(0);
    expect(snapshot.bytes).toBeLessThan(4 * 1024);
    // All three chains still replay — availability is preserved through the spill.
    expect((expandChained("resp_small_1") as { input: unknown[] }).input.length).toBeGreaterThan(1);
    expect((expandChained("resp_small_2") as { input: unknown[] }).input.length).toBeGreaterThan(1);
    expect((expandChained("resp_big") as { input: unknown[] }).input.length).toBeGreaterThan(1);
  });

  test("candidate fitting the cap stays resident at the boundary", () => {
    setResponseStateByteCapForTests(8 * 1024);
    const directBefore = responseAdmissionCountersForTests().directSpills;
    rememberResponseState({ model: "m", input: "mid" }, completedResponse("resp_fit", "y".repeat(7 * 1024)));
    expect(responseAdmissionCountersForTests().directSpills).toBe(directBefore);
    // Resident, not a stub: resident bytes are the evictable class.
    expect(responseContinuationRetainedStoreSnapshot().evictableBytes).toBeGreaterThan(0);
    expect((expandChained("resp_fit") as { input: unknown[] }).input.length).toBeGreaterThan(1);
  });

  test("admission enforces the real spill envelope at the exact boundary", () => {
    setResponseStateByteCapForTests(1024);
    // Learn the true envelope (resident encoding + {version, responseId, ...} wrapper).
    rememberResponseState({ model: "m", input: "env" }, completedResponse("resp_env", "e".repeat(4096)));
    const dir = responseSpillDirectory();
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const envelope = statSync(join(dir, files[0])).size;
    clearResponseStateMemoryForTests();
    // Cap = envelope: admitted (envelope is not ABOVE the cap).
    setResponseSpillPayloadCapForTests(envelope);
    const directBefore = responseAdmissionCountersForTests().directSpills;
    rememberResponseState({ model: "m", input: "env" }, completedResponse("resp_env", "e".repeat(4096)));
    expect(responseAdmissionCountersForTests().directSpills).toBe(directBefore + 1);
    clearResponseStateMemoryForTests();
    // Cap = envelope - 1: the resident encoding still fits, but the real spill
    // envelope does not — post-write enforcement must tombstone it.
    setResponseSpillPayloadCapForTests(envelope - 1);
    const dropsBefore = responseAdmissionCountersForTests().oversizedDrops;
    rememberResponseState({ model: "m", input: "env" }, completedResponse("resp_env", "e".repeat(4096)));
    expect(responseAdmissionCountersForTests().oversizedDrops).toBe(dropsBefore + 1);
  });

  test("candidate above the spill payload ceiling is tombstoned, not retained", () => {
    setResponseStateByteCapForTests(1024);
    setResponseSpillPayloadCapForTests(2 * 1024);
    const dropsBefore = responseAdmissionCountersForTests().oversizedDrops;
    rememberResponseState({ model: "m", input: "huge" }, completedResponse("resp_huge", "z".repeat(8 * 1024)));
    expect(responseAdmissionCountersForTests().oversizedDrops).toBe(dropsBefore + 1);
    const body = {
      model: "m",
      previous_response_id: "resp_huge",
      input: [{ type: "function_call_output", call_id: "c", output: "ok" }],
    };
    expandPreviousResponseInput(body);
    expect(previousResponseReplayFailure(body)?.reason).toBe("spill_failed");
  });

  test("externally oversized snapshot file is refused before parse", () => {
    const refusalsBefore = responseAdmissionCountersForTests().snapshotOversizedRefusals;
    writeFileSync(join(home, "responses-state.json"), `{"version":2,"states":[${" ".repeat(33 * 1024 * 1024)}]}`);
    // First store access triggers the lazy load.
    rememberResponseState({ model: "m", input: "x" }, completedResponse("resp_after", "ok"));
    expect(responseAdmissionCountersForTests().snapshotOversizedRefusals).toBe(refusalsBefore + 1);
    // The store still works: the new entry is present and replays.
    expect((expandChained("resp_after") as { input: unknown[] }).input.length).toBeGreaterThan(1);
  });

  test("spill replay above the payload ceiling fails typed before read", () => {
    const ref = writeResponseSpillDurably("resp_ceiling", {
      createdAt: Date.now(),
      items: [{ role: "user", content: "q".repeat(4096) }],
    });
    setResponseSpillPayloadCapForTests(512);
    expect(readResponseSpill("resp_ceiling", ref)).toEqual({ ok: false, reason: "too_large" });
    // No-read proof: with the file GONE, a read-first implementation would say
    // "missing"; the ceiling check fires first.
    deleteResponseSpill(ref);
    expect(readResponseSpill("resp_ceiling", ref)).toEqual({ ok: false, reason: "too_large" });
  });

  test("over-ceiling same-ID tombstone defers the old generation until durable", async () => {
    setResponseStateByteCapForTests(1024);
    rememberResponseState({ model: "m", input: "v1" }, completedResponse("resp_tc", "a".repeat(4096)));
    const dir = responseSpillDirectory();
    expect(readdirSync(dir).length).toBe(1);
    // Over the tightened ceiling: tombstone — but the old generation must NOT be
    // deleted immediately (a crash would strand the durable old snapshot).
    setResponseSpillPayloadCapForTests(2048);
    rememberResponseState({ model: "m", input: "v2" }, completedResponse("resp_tc", "b".repeat(4096)));
    expect(readdirSync(dir).length).toBe(1);
    await flushResponseState();
    // After the tombstone is durable, the deferred unlink drains.
    expect(readdirSync(dir).length).toBe(0);
  });

  test("same-ID oversized replacement of a spilled entry keeps crash ordering", async () => {
    setResponseStateByteCapForTests(4096);
    rememberResponseState({ model: "m", input: "v1" }, completedResponse("resp_ss", "a".repeat(6 * 1024)));
    const dir = responseSpillDirectory();
    const gen1 = readdirSync(dir);
    expect(gen1.length).toBe(1);
    rememberResponseState({ model: "m", input: "v2" }, completedResponse("resp_ss", "b".repeat(6 * 1024)));
    // New generation written; old one deferred, not deleted at swap time.
    expect(readdirSync(dir).length).toBe(2);
    await flushResponseState();
    const gen3 = readdirSync(dir);
    expect(gen3.length).toBe(1);
    expect(gen3[0]).not.toBe(gen1[0]);
    // The replacement replays the NEW content.
    const expanded = expandChained("resp_ss") as { input: unknown[] };
    expect(JSON.stringify(expanded.input)).toContain("b".repeat(64));
  });

  test.skipIf(!canSymlink)("oversized symlinked snapshot is refused before parse", () => {
    const target = join(home, "big-snapshot-target.json");
    writeFileSync(target, `{"version":2,"states":[${" ".repeat(33 * 1024 * 1024)}]}`);
    symlinkSync(target, join(home, "responses-state.json"));
    const refusalsBefore = responseAdmissionCountersForTests().snapshotOversizedRefusals;
    rememberResponseState({ model: "m", input: "x" }, completedResponse("resp_sl", "ok"));
    expect(responseAdmissionCountersForTests().snapshotOversizedRefusals).toBe(refusalsBefore + 1);
  });

  test.skipIf(!canSymlink)("snapshot symlinked to a non-regular target is never read", () => {
    // /dev/null is the safe non-regular fixture (a FIFO would block an unfixed
    // read forever — that hang IS the pre-fix behavior this guards).
    symlinkSync("/dev/null", join(home, "responses-state.json"));
    rememberResponseState({ model: "m", input: "x" }, completedResponse("resp_nr", "ok"));
    expect((expandChained("resp_nr") as { input: unknown[] }).input.length).toBeGreaterThan(1);
  });

  test("materializing an over-ceiling spill reports spill_too_large", () => {
    setResponseStateByteCapForTests(1024);
    rememberResponseState({ model: "m", input: "big" }, completedResponse("resp_mat", "w".repeat(4 * 1024)));
    // The entry is now a spill stub; tightening the ceiling makes its replay refuse.
    setResponseSpillPayloadCapForTests(512);
    const body = {
      model: "m",
      previous_response_id: "resp_mat",
      input: [{ type: "function_call_output", call_id: "c", output: "ok" }],
    };
    expandPreviousResponseInput(body);
    expect(previousResponseReplayFailure(body)?.reason).toBe("spill_too_large");
  });

  test("direct-spill write failure installs a tombstone and keeps unrelated residents", () => {
    setResponseStateByteCapForTests(4 * 1024);
    rememberResponseState({ model: "m", input: "a" }, completedResponse("resp_keep", "keep"));
    setSpillIoForTest({
      write: () => {
        throw new Error("injected write failure");
      },
    });
    rememberResponseState({ model: "m", input: "big" }, completedResponse("resp_fail", "v".repeat(8 * 1024)));
    setSpillIoForTest(null);
    const body = {
      model: "m",
      previous_response_id: "resp_fail",
      input: [{ type: "function_call_output", call_id: "c", output: "ok" }],
    };
    expandPreviousResponseInput(body);
    expect(previousResponseReplayFailure(body)?.reason).toBe("spill_failed");
    expect((expandChained("resp_keep") as { input: unknown[] }).input.length).toBeGreaterThan(1);
  });

  // Windows routes oversized admission through the queued async publication
  // (src/responses/state.ts runPendingResponseSpill). The two cases above prove the sync
  // lane; these prove the same contract on the async one, after the queue settles.
  test("win32: post-write envelope enforcement tombstones through the async lane", async () => {
    forceWindowsAclLane();
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    setResponseStateByteCapForTests(1024);
    rememberResponseState({ model: "m", input: "env" }, completedResponse("resp_env_w", "e".repeat(4096)));
    await flushPendingResponseSpillsForTests();
    const dir = responseSpillDirectory();
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const envelope = statSync(join(dir, files[0])).size;
    const firstGeneration = files[0];
    clearResponseStateMemoryForTests();
    setResponseSpillPayloadCapForTests(envelope - 1);
    const dropsBefore = responseAdmissionCountersForTests().oversizedDrops;
    rememberResponseState({ model: "m", input: "env" }, completedResponse("resp_env_w", "e".repeat(4096)));
    await flushPendingResponseSpillsForTests();
    expect(responseAdmissionCountersForTests().oversizedDrops).toBe(dropsBefore + 1);
    const body = {
      model: "m",
      previous_response_id: "resp_env_w",
      input: [{ type: "function_call_output", call_id: "c", output: "ok" }],
    };
    expandPreviousResponseInput(body);
    // The async lane deletes the over-ceiling file and tombstones at publication time, so
    // replay reports the tombstone (spill_failed); the sync lane's spill_too_large is a
    // read-time classification of a file that was never written here.
    expect(previousResponseReplayFailure(body)?.reason).toBe("spill_failed");
    // The over-ceiling publication was deleted; only the first generation's file (orphaned by
    // the memory clear, owned by the orphan GC) remains.
    expect(readdirSync(dir)).toEqual([firstGeneration]);
  });

  test("win32: async direct-spill write failure installs a tombstone and keeps unrelated residents", async () => {
    forceWindowsAclLane();
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    setResponseStateByteCapForTests(4 * 1024);
    rememberResponseState({ model: "m", input: "a" }, completedResponse("resp_keep_w", "keep"));
    await flushPendingResponseSpillsForTests();
    // Unlike the sync lane, the queued candidate counts against the RAM cap while it waits,
    // which demotes "keep" too. Fail only the oversized candidate's write so the case still
    // proves the tombstone is scoped to the failing generation.
    const bigBytes = 8 * 1024;
    setSpillIoForTest({
      write: (fd, bytes) => {
        if (bytes.byteLength >= bigBytes) throw new Error("injected write failure");
        let offset = 0;
        while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
      },
    });
    rememberResponseState({ model: "m", input: "big" }, completedResponse("resp_fail_w", "v".repeat(bigBytes)));
    await flushPendingResponseSpillsForTests();
    setSpillIoForTest(null);
    const body = {
      model: "m",
      previous_response_id: "resp_fail_w",
      input: [{ type: "function_call_output", call_id: "c", output: "ok" }],
    };
    expandPreviousResponseInput(body);
    expect(previousResponseReplayFailure(body)?.reason).toBe("spill_failed");
    expect((expandChained("resp_keep_w") as { input: unknown[] }).input.length).toBeGreaterThan(1);
  });

  test("same-ID oversized replacement releases the old resident exactly once", () => {
    setResponseStateByteCapForTests(8 * 1024);
    rememberResponseState({ model: "m", input: "old" }, completedResponse("resp_swap", "small"));
    const bytesBefore = getStoredResponseBytesForTests();
    rememberResponseState({ model: "m", input: "new" }, completedResponse("resp_swap", "n".repeat(16 * 1024)));
    const bytesAfter = getStoredResponseBytesForTests();
    // Only the bounded stub replaced the resident: the delta is the stub/resident
    // metadata difference, nowhere near the 16 KiB candidate.
    expect(bytesAfter).toBeLessThan(bytesBefore + 512);
    // The replacement still replays the NEW (spilled) content.
    const expanded = expandChained("resp_swap") as { input: unknown[] };
    expect(expanded.input.length).toBeGreaterThan(1);
    expect(JSON.stringify(expanded.input)).toContain("n".repeat(64));
  });

  test("snapshot selection uses UTF-8 bytes, not UTF-16 length", async () => {
    // 600k 💡 = 1.2M UTF-16 code units (< 2 MiB length cap) but 2.4M UTF-8 bytes (> 2 MiB byte cap).
    const bulbs = "💡".repeat(600_000);
    rememberResponseState({ model: "m", input: "multi" }, completedResponse("resp_multibyte", bulbs));
    await flushResponseState();
    const raw = readFileSync(join(home, "responses-state.json"), "utf-8");
    expect(raw).not.toContain("resp_multibyte");
  });

  /**
   * Encrypted-agent-task recovery decrypts task text into the request body and promises
   * in-memory retention bounded by a 15-minute TTL. The continuation cache persists request
   * input to `responses-state.json`, so recording a recovered body would put that plaintext on
   * disk with no TTL at all. The guard lives in `rememberResponseState` so every recording path
   * inherits it.
   */
  describe("bodies marked non-persistable never reach the continuation cache", () => {
    test("a marked body is not stored and its text never reaches the snapshot", async () => {
      const recovered = {
        model: "m",
        input: [{ type: "message", role: "user", content: "RECOVERED-PLAINTEXT-SENTINEL" }],
      };
      markBodyNonPersistable(recovered);

      rememberResponseState(recovered, completedResponse("resp_recovered", "ok"), undefined, { force: true });
      await flushResponseState();

      // Not in memory: a later turn replaying that id gets its request back UNEXPANDED,
      // i.e. with no `input` grafted on from stored history.
      const replay = expandPreviousResponseInput({ previous_response_id: "resp_recovered" }) as {
        input?: unknown;
      };
      expect(replay.input).toBeUndefined();
      // Not on disk, and neither is the response id that would have carried it.
      const raw = existsSync(join(home, "responses-state.json"))
        ? readFileSync(join(home, "responses-state.json"), "utf-8")
        : "";
      expect(raw).not.toContain("RECOVERED-PLAINTEXT-SENTINEL");
      expect(raw).not.toContain("resp_recovered");
    });

    test("an unmarked body with identical shape IS stored — the guard is the marker, not the shape", async () => {
      const ordinary = {
        model: "m",
        input: [{ type: "message", role: "user", content: "ORDINARY-INPUT-SENTINEL" }],
      };

      rememberResponseState(ordinary, completedResponse("resp_ordinary", "ok"), undefined, { force: true });
      await flushResponseState();

      const raw = readFileSync(join(home, "responses-state.json"), "utf-8");
      expect(raw).toContain("resp_ordinary");
    });

    test("marking is per-object, so an unrelated body is unaffected", async () => {
      const marked = { model: "m", input: "marked", store: true };
      const sibling = { model: "m", input: "sibling", store: true };
      markBodyNonPersistable(marked);

      rememberResponseState(marked, completedResponse("resp_marked", "ok"), undefined, { force: true });
      rememberResponseState(sibling, completedResponse("resp_sibling", "ok"), undefined, { force: true });
      await flushResponseState();

      const raw = readFileSync(join(home, "responses-state.json"), "utf-8");
      expect(raw).not.toContain("resp_marked");
      expect(raw).toContain("resp_sibling");
    });

    test("explicit ephemeral retention replays in memory without reaching disk", async () => {
      const recovered = {
        model: "m",
        input: [{ type: "message", role: "user", content: "EPHEMERAL-PLAINTEXT-SENTINEL" }],
        store: false,
      };
      markBodyNonPersistable(recovered);
      const firstResponse = completedResponse("resp_ephemeral", "tool call");
      firstResponse.output[0]!.id = "msg_ephemeral";
      rememberResponseState(
        recovered,
        firstResponse,
        undefined,
        { force: true, ephemeral: true, ephemeralScope: "scope-a" },
      );

      const expanded = expandPreviousResponseInput({
        previous_response_id: "resp_ephemeral",
        input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
      }, undefined, "scope-a") as { input: unknown[] };
      expect(expanded.input[0]).toMatchObject({
        type: "message", role: "user", content: "EPHEMERAL-PLAINTEXT-SENTINEL",
      });
      expect(previousResponseReplayPrefixLength(expanded)).toBe(2);
      recovered.input[0]!.content = "MUTATED-AFTER-RECORD";
      firstResponse.output[0]!.content[0]!.text = "MUTATED-AFTER-RECORD";
      expect(JSON.stringify(expanded)).not.toContain("MUTATED-AFTER-RECORD");

      rememberResponseState(
        expanded,
        completedResponse("resp_ephemeral_child", "finished"),
        undefined,
        { force: true, ephemeral: true, ephemeralScope: "scope-a" },
      );
      expect((expandPreviousResponseInput({ previous_response_id: "resp_ephemeral_child" }, undefined, "scope-a") as {
        input?: unknown[];
      }).input).toHaveLength(4);

      const carried = expandPreviousResponseInput({
        previous_response_id: "resp_ephemeral",
        input: expanded.input.slice(0, 2),
      }, undefined, "scope-a") as { input: unknown[] };
      expect(carried.input).toHaveLength(2);
      rememberResponseState(
        carried,
        completedResponse("resp_ephemeral_carried", "carried"),
        undefined,
        { ephemeral: true, ephemeralScope: "scope-a" },
      );
      expect((expandPreviousResponseInput({ previous_response_id: "resp_ephemeral_carried" }, undefined, "scope-a") as {
        input?: unknown[];
      }).input).toBeDefined();

      const cloned = structuredClone(expanded);
      copyPreviousResponseReplayProvenance(expanded, cloned);
      rememberResponseState(
        cloned,
        completedResponse("resp_ephemeral_clone", "clone"),
        undefined,
        { ephemeral: true, ephemeralScope: "scope-a" },
      );
      expect((expandPreviousResponseInput({ previous_response_id: "resp_ephemeral_clone" }, undefined, "scope-a") as {
        input?: unknown[];
      }).input).toBeDefined();

      rememberResponseState(
        { input: ["ordinary snapshot trigger"] },
        completedResponse("resp_snapshot_trigger", "persist me"),
      );
      await flushResponseState();
      const raw = existsSync(join(home, "responses-state.json"))
        ? readFileSync(join(home, "responses-state.json"), "utf-8")
        : "";
      expect(raw).not.toContain("EPHEMERAL-PLAINTEXT-SENTINEL");
      expect(raw).not.toContain("resp_ephemeral");
      expect(raw).toContain("resp_snapshot_trigger");
    });

    test("ephemeral chain expiry is absolute and cannot be refreshed by descendants", () => {
      const realNow = Date.now;
      let clock = realNow();
      Date.now = () => clock;
      try {
        const recovered = { input: ["secret"] };
        markBodyNonPersistable(recovered);
        rememberResponseState(
          recovered,
          completedResponse("resp_ephemeral_root", "root"),
          undefined,
          { ephemeral: true, ephemeralScope: "scope-a" },
        );
        clock += 14 * 60 * 1_000;
        const expanded = expandPreviousResponseInput({ previous_response_id: "resp_ephemeral_root" }, undefined, "scope-a") as {
          input?: unknown[];
        };
        expect(expanded.input).toBeDefined();
        rememberResponseState(
          expanded,
          completedResponse("resp_ephemeral_descendant", "child"),
          undefined,
          { ephemeral: true, ephemeralScope: "scope-a" },
        );
        clock += 61 * 1_000;
        expect((expandPreviousResponseInput({ previous_response_id: "resp_ephemeral_root" }, undefined, "scope-a") as {
          input?: unknown[];
        }).input).toBeUndefined();
        expect((expandPreviousResponseInput({ previous_response_id: "resp_ephemeral_descendant" }, undefined, "scope-a") as {
          input?: unknown[];
        }).input).toBeUndefined();
      } finally {
        Date.now = realNow;
      }
    });

    test("ephemeral retention enforces task ownership and count capacity", () => {
      for (let index = 0; index < 129; index += 1) {
        const request = { input: [`secret-${index}`] };
        markBodyNonPersistable(request);
        rememberResponseState(
          request,
          completedResponse(`resp_ephemeral_count_${index}`, `result-${index}`),
          undefined,
          { ephemeral: true, ephemeralScope: "scope-a", clientThreadId: "task-a" },
        );
      }
      expect((expandPreviousResponseInput(
        { previous_response_id: "resp_ephemeral_count_0" },
        "task-a",
        "scope-a",
      ) as { input?: unknown[] }).input).toBeUndefined();
      expect((expandPreviousResponseInput(
        { previous_response_id: "resp_ephemeral_count_128" },
        "task-b",
        "scope-a",
      ) as { input?: unknown[] }).input).toBeUndefined();
      expect((expandPreviousResponseInput(
        { previous_response_id: "resp_ephemeral_count_128" },
        "task-a",
        "scope-a",
      ) as { input?: unknown[] }).input).toBeDefined();
    });

    test("ephemeral response IDs are isolated by credential scope", () => {
      for (const [scope, secret] of [["scope-a", "secret-a"], ["scope-b", "secret-b"]] as const) {
        const request = { input: [secret] };
        markBodyNonPersistable(request);
        rememberResponseState(
          request,
          completedResponse("resp_shared_ephemeral", scope),
          undefined,
          { ephemeral: true, ephemeralScope: scope, clientThreadId: "task-shared" },
        );
      }
      const replay = (scope?: string) => {
        const request = { previous_response_id: "resp_shared_ephemeral" };
        const result = expandPreviousResponseInput(request, "task-shared", scope) as { input?: unknown[] };
        return { request, result, failure: previousResponseReplayFailure(result) };
      };
      expect(JSON.stringify(replay("scope-a").result)).toContain("secret-a");
      expect(JSON.stringify(replay("scope-a").result)).not.toContain("secret-b");
      expect(JSON.stringify(replay("scope-b").result)).toContain("secret-b");
      expect(JSON.stringify(replay("scope-b").result)).not.toContain("secret-a");
      expect(replay("scope-c").failure).toEqual({
        code: "previous_response_not_found", reason: "ephemeral_scope_mismatch",
      });
      expect(replay().failure).toEqual({
        code: "previous_response_not_found", reason: "ephemeral_scope_mismatch",
      });
    });

    test("ephemeral byte capacity evicts oldest entries and rejects one oversized entry", () => {
      const rememberEphemeral = (id: string, content: string) => {
        const request = { input: [content] };
        markBodyNonPersistable(request);
        rememberResponseState(request, completedResponse(id, "ok"), undefined, { ephemeral: true, ephemeralScope: "scope-a" });
      };
      rememberEphemeral("resp_ephemeral_small", "small");
      rememberEphemeral("resp_ephemeral_bytes_1", "a".repeat(5 * 1024 * 1024));
      rememberEphemeral("resp_ephemeral_bytes_2", "b".repeat(5 * 1024 * 1024));
      expect((expandPreviousResponseInput({ previous_response_id: "resp_ephemeral_bytes_1" }, undefined, "scope-a") as {
        input?: unknown[];
      }).input).toBeUndefined();
      expect((expandPreviousResponseInput({ previous_response_id: "resp_ephemeral_bytes_2" }, undefined, "scope-a") as {
        input?: unknown[];
      }).input).toBeDefined();

      rememberEphemeral("resp_ephemeral_oversized", "z".repeat(9 * 1024 * 1024));
      expect((expandPreviousResponseInput({ previous_response_id: "resp_ephemeral_oversized" }, undefined, "scope-a") as {
        input?: unknown[];
      }).input).toBeUndefined();
      expect((expandPreviousResponseInput({ previous_response_id: "resp_ephemeral_bytes_2" }, undefined, "scope-a") as {
        input?: unknown[];
      }).input).toBeDefined();
    });
  });
});
