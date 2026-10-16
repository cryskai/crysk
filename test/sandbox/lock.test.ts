// The run lock: one scenario invocation at a time on this machine. The policy is
// tested over a memory lock, and the file itself over a real directory, so the
// exclusive create and the pid check are the real calls. Nothing here touches the
// operator's ~/.prhero: the real adapter is always given a temp path.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireRunLock, releaseRunLock } from "../../scripts/sandbox/lock";
import { SANDBOX_REPO } from "../../scripts/sandbox/rails";
import { realRunLock } from "../../scripts/sandbox/real";
import { runScenarios } from "../../scripts/sandbox/scenario";
import { sandboxFiles } from "../../scripts/sandbox/seed";
import { FAKE_PID, fail, harness, memoryRunLock, ok } from "./fakes";
import { FakeGithub } from "./world";

const REF = "v0.2.0";
const OPTIONS = {
  ref: REF,
  keep: false,
  pollIntervalMs: 15_000,
  timeoutMs: 60_000,
  cancelWaitMs: 60_000,
};
const PR_URL = `https://github.com/${SANDBOX_REPO}/pull/7`;

const dirs: string[] = [];
function lockFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-lock-"));
  dirs.push(dir);
  return path.join(dir, "sandbox.lock");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("the lock file, on a real directory", () => {
  test("the exclusive create lets one start take the lock, and a second start is refused", async () => {
    const file = lockFile();
    const first = realRunLock(file, 4321);
    const second = realRunLock(file, 5555);
    expect(await first.create()).toBe(true);
    expect(await second.create()).toBe(false);
    expect(await second.holder()).toEqual({ kind: "pid", pid: 4321 });
    expect(readFileSync(file, "utf8")).toBe("4321\n");
  });

  test("a release removes the lock only while it records the releasing pid", async () => {
    const file = lockFile();
    const first = realRunLock(file, 4321);
    const stranger = realRunLock(file, 5555);
    await first.create();
    await stranger.remove(5555);
    expect(await first.holder()).toEqual({ kind: "pid", pid: 4321 });
    await first.remove(4321);
    expect(await first.holder()).toEqual({ kind: "none" });
  });

  test("a file that names no pid is unreadable, never absent", async () => {
    const file = lockFile();
    const lock = realRunLock(file, 4321);
    writeFileSync(file, "");
    expect(await lock.holder()).toEqual({ kind: "unreadable" });
    writeFileSync(file, "abc\n");
    expect(await lock.holder()).toEqual({ kind: "unreadable" });
  });

  test("a process that has exited is not alive, and this one is", async () => {
    const lock = realRunLock(lockFile(), 4321);
    const child = Bun.spawn(["/usr/bin/true"]);
    await child.exited;
    expect(lock.alive(child.pid)).toBe(false);
    expect(lock.alive(process.pid)).toBe(true);
  });
});

describe("the policy, over a memory lock", () => {
  test("a live holder refuses the start, and its lock is left alone", async () => {
    const lock = memoryRunLock({ recorded: 7777, livePids: [7777] });
    const attempt = await acquireRunLock(lock);
    expect(attempt.held).toBe(false);
    if (attempt.held) throw new Error("unreachable");
    expect(attempt.reason).toContain("pid 7777 holds it and is running");
    expect(lock.recorded()).toBe(7777);
  });

  test("a stale holder is taken over, and the takeover is logged", async () => {
    const lock = memoryRunLock({ recorded: 8888 });
    const world = new FakeGithub({ ref: REF });
    const h = world.harness(lock);
    expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(0);
    expect(
      h.logs.some(
        (l) =>
          l ===
          `took over ${lock.path} from pid 8888, which is no longer running`,
      ),
    ).toBe(true);
    expect(world.events.some((e) => e.startsWith("pr create"))).toBe(true);
    expect(lock.recorded()).toBeUndefined();
  });

  test("an unreadable lock refuses the start and is left in place", async () => {
    const lock = memoryRunLock({ recorded: "unreadable" });
    const world = new FakeGithub({ ref: REF });
    const h = world.harness(lock);
    expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(1);
    expect(h.logs.some((l) => l.includes("names no pid"))).toBe(true);
    expect(lock.recorded()).toBe("unreadable");
    expect(world.events.some((e) => e.startsWith("pr create"))).toBe(false);
  });

  test("the lock is released when the invocation succeeds", async () => {
    const lock = memoryRunLock();
    const h = new FakeGithub({ ref: REF }).harness(lock);
    expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(0);
    expect(lock.recorded()).toBeUndefined();
  });

  test("the lock is released when a scenario fails", async () => {
    const lock = memoryRunLock();
    const h = new FakeGithub({
      ref: REF,
      forceCredentialOutcome: true,
    }).harness(lock);
    expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(1);
    expect(lock.recorded()).toBeUndefined();
  });

  test("the lock is released when a signal ends the invocation", async () => {
    // The signal lands once, inside the scenario's first poll, so the wait is
    // interrupted. Firing on every listing would be a second signal, which abandons
    // cleanup, and that is a different test.
    const lock = memoryRunLock();
    let fired = false;
    const h = harness({
      lock,
      gh: (args, hh) => {
        if (args[0] === "pr" && args[1] === "list") return ok("[]");
        if (args[0] === "repo" && args[1] === "clone") {
          hh.workspace.seed(String(args[3]), sandboxFiles(REF));
          return ok();
        }
        if (args[0] === "pr" && args[1] === "create") return ok(`${PR_URL}\n`);
        if (args[0] === "pr" && args[1] === "close") return ok();
        if (args[0] === "run" && args[1] === "list") {
          if (!fired) {
            fired = true;
            hh.signals.fire("SIGINT");
          }
          return ok("[]");
        }
        return fail(`unexpected gh call: ${args.join(" ")}`);
      },
    });
    expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(130);
    expect(lock.recorded()).toBeUndefined();
  });

  test("a second invocation on the same machine is refused while the first runs", async () => {
    const lock = memoryRunLock();
    const world = new FakeGithub({ ref: REF });
    const first = world.harness(lock);
    const second = harness({
      lock,
      gh: () => fail("the refused invocation must start nothing"),
    });
    let refusedCode: number | undefined;
    const original = first.deps.gh;
    // The second invocation starts while the first holds the lock, at the first PR open.
    first.deps.gh = async (args) => {
      if (args[0] === "pr" && args[1] === "create") {
        refusedCode = await runScenarios(second.deps, ["review-free"], OPTIONS);
      }
      return original(args);
    };
    expect(await runScenarios(first.deps, ["review-free"], OPTIONS)).toBe(0);
    expect(refusedCode).toBe(1);
    expect(second.ghCalls).toEqual([]);
    expect(
      second.logs.some((l) =>
        l.includes(`pid ${FAKE_PID} holds it and is running`),
      ),
    ).toBe(true);
    expect(lock.recorded()).toBeUndefined();
  });
});

describe("the policy's release", () => {
  test("releasing a lock this process does not hold leaves it in place", async () => {
    const lock = memoryRunLock({ recorded: 8888 });
    await releaseRunLock(lock);
    expect(lock.recorded()).toBe(8888);
  });
});
