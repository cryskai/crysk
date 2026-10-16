// The real runner's child processes, under fakes. A child that never answers is
// the failure this file pins: every gh and git call has a deadline, and a stall
// past it is a failed call, not a hung run. The fakes are the point: a child
// whose pipes stay open after a kill is exactly what a stalled git push looks like.

import { describe, expect, test } from "bun:test";
import * as real from "../../scripts/sandbox/real";
import { runCommand } from "../../scripts/sandbox/real";

interface FakeChild {
  child: real.Child;
  killed(): boolean;
}

// A child that never writes. kill() ends it like a real one: `exited` settles,
// and its pipes close only when `closePipesOnKill` is set. A grandchild that
// inherited a pipe keeps it open, which is the case the grace bound exists for.
function silentChild(closePipesOnKill: boolean): FakeChild {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const pipe = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
      },
    });
  let settleExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    settleExit = resolve;
  });
  let killed = false;
  return {
    child: {
      stdout: pipe(),
      stderr: pipe(),
      exited,
      kill() {
        killed = true;
        if (closePipesOnKill) {
          for (const controller of controllers) controller.close();
        }
        settleExit(137);
      },
    },
    killed: () => killed,
  };
}

describe("runCommand: a stalled child is killed and fails like a non-zero exit", () => {
  test("a child that never answers is killed at the deadline, and the call fails", async () => {
    const fake = silentChild(true);
    const result = await runCommand(["gh", "pr", "list"], {
      timeoutMs: 5,
      spawn: () => fake.child,
    });
    expect(fake.killed()).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("timed out");
  }, 500);

  test("a grandchild that keeps a pipe open cannot stall the runner past the grace bound", async () => {
    const fake = silentChild(false);
    const result = await runCommand(["git", "push", "origin", "main"], {
      timeoutMs: 5,
      killGraceMs: 5,
      spawn: () => fake.child,
    });
    expect(fake.killed()).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 500);
});

describe("deadlines", () => {
  test("gh calls get 120 s, and a clone or a push gets 300 s", () => {
    expect(real.GH_TIMEOUT_MS).toBe(120_000);
    expect(real.TRANSFER_TIMEOUT_MS).toBe(300_000);
    expect(real.ghTimeoutMs(["pr", "list"])).toBe(120_000);
    expect(
      real.ghTimeoutMs(["repo", "clone", "juanmaagd/pr-hero-sandbox", "/x"]),
    ).toBe(300_000);
    expect(real.gitTimeoutMs(["push", "origin", "main"])).toBe(300_000);
    expect(real.gitTimeoutMs(["commit", "-m", "x"])).toBe(120_000);
  });
});
