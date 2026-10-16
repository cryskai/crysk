// Two invocations that race on one stale lock must end with exactly one holder. A
// takeover is several file operations, and a check-then-remove between two of them
// lets the other invocation's live lock be deleted. The race is run over a fake file
// system in which every operation waits for its turn: a schedule decides which
// invocation takes each turn, so the test covers the interleavings rather than
// whichever one the event loop happens to produce.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireRunLock, type LockAttempt } from "../../scripts/sandbox/lock";
import { type LockIo, realRunLock } from "../../scripts/sandbox/real";

type Actor = "A" | "B";

const PID_A = 1001;
const PID_B = 1002;
const DEAD_PID = 999;
// The path is only a name in the fake file system. It sits under the OS temp dir so a
// build that ignored the fake would still touch nothing the operator owns.
const LOCK_DIR = path.join(tmpdir(), "pr-hero-sandbox-race");
const LOCK = path.join(LOCK_DIR, "sandbox.lock");

afterAll(() => {
  rmSync(LOCK_DIR, { recursive: true, force: true });
});

// The schedule's turns, in order. An operation requests its turn and resolves when the
// schedule grants it. A schedule that runs out grants whichever actor is waiting, so
// every race finishes. An actor that has finished is skipped.
class Turns {
  private readonly waiting = new Map<Actor, () => void>();
  private readonly finished = new Set<Actor>();
  private next = 0;

  constructor(private readonly schedule: readonly Actor[]) {}

  turn(actor: Actor): Promise<void> {
    return new Promise((resolve) => {
      this.waiting.set(actor, resolve);
      this.grant();
    });
  }

  finish(actor: Actor): void {
    this.finished.add(actor);
    this.grant();
  }

  private grant(): void {
    while (this.next < this.schedule.length) {
      const who = this.schedule[this.next] as Actor;
      if (this.finished.has(who)) {
        this.next += 1;
        continue;
      }
      const resolve = this.waiting.get(who);
      if (resolve === undefined) return;
      this.waiting.delete(who);
      this.next += 1;
      resolve();
      return;
    }
    for (const who of ["A", "B"] as const) {
      const resolve = this.waiting.get(who);
      if (resolve !== undefined) {
        this.waiting.delete(who);
        resolve();
        return;
      }
    }
  }
}

function enoent(file: string): Error {
  return Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
}

function eexist(file: string): Error {
  return Object.assign(new Error(`EEXIST: ${file}`), { code: "EEXIST" });
}

interface Race {
  attempts: LockAttempt[];
  files: Map<string, string>;
  ops: string[];
}

// One race: both invocations take the stale lock recorded by DEAD_PID, in the order
// the schedule sets. Each file operation is one turn, and renames and links keep
// their POSIX meaning (a rename replaces its target, a link never does).
async function race(schedule: readonly Actor[]): Promise<Race> {
  const turns = new Turns(schedule);
  const files = new Map<string, string>([[LOCK, `${DEAD_PID}\n`]]);
  const ops: string[] = [];

  const ioFor = (actor: Actor): LockIo => {
    const step = async (op: string, file: string) => {
      await turns.turn(actor);
      ops.push(`${actor} ${op} ${file.replace(LOCK, "lock")}`);
    };
    return {
      readFile: async (file) => {
        await step("read", file);
        const text = files.get(file);
        if (text === undefined) throw enoent(file);
        return text;
      },
      writeExclusive: async (file, content) => {
        await step("create", file);
        if (files.has(file)) throw eexist(file);
        files.set(file, content);
      },
      rename: async (from, to) => {
        await step("rename", from);
        const text = files.get(from);
        if (text === undefined) throw enoent(from);
        files.delete(from);
        files.set(to, text);
      },
      link: async (from, to) => {
        await step("link", to);
        const text = files.get(from);
        if (text === undefined) throw enoent(from);
        if (files.has(to)) throw eexist(to);
        files.set(to, text);
      },
      unlink: async (file) => {
        await step("unlink", file);
        files.delete(file);
      },
      mkdir: async () => undefined,
      alive: (pid) => pid !== DEAD_PID,
    };
  };

  const run = async (actor: Actor, pid: number): Promise<LockAttempt> => {
    try {
      return await acquireRunLock(realRunLock(LOCK, pid, ioFor(actor)));
    } finally {
      turns.finish(actor);
    }
  };
  const attempts = await Promise.all([run("A", PID_A), run("B", PID_B)]);
  return { attempts, files, ops };
}

// Exactly one invocation holds the lock, and the file names its pid: no stale
// leftover, and no lock another invocation took was deleted.
async function checkSchedule(schedule: readonly Actor[]): Promise<string[]> {
  const result = await race(schedule);
  const holders = result.attempts.flatMap((attempt, index) =>
    attempt.held ? [index === 0 ? PID_A : PID_B] : [],
  );
  const leftovers = [...result.files.keys()].filter((name) => name !== LOCK);
  const problems: string[] = [];
  if (holders.length !== 1) {
    problems.push(`${holders.length} holders`);
  } else if (result.files.get(LOCK) !== `${holders[0]}\n`) {
    problems.push(
      `the lock names ${result.files.get(LOCK)?.trim()}, not the holder ${holders[0]}`,
    );
  }
  if (leftovers.length > 0)
    problems.push(`leftover files ${leftovers.join(", ")}`);
  if (problems.length > 0) {
    throw new Error(
      `schedule ${schedule.join("")} ops [${result.ops.join(", ")}]: ${problems.join("; ")}`,
    );
  }
  return result.ops;
}

// A small seeded generator, so the random schedules are the same on every run.
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

describe("two starts racing on one stale lock", () => {
  test("the fake file system is what the lock touches", async () => {
    const ops = await checkSchedule(["A", "A", "A", "A", "A", "A", "A", "A"]);
    expect(ops.length).toBeGreaterThan(0);
  });

  test("run to completion one after the other, either way round, the second start is refused", async () => {
    for (const first of ["A", "B"] as const) {
      const second = first === "A" ? "B" : "A";
      const schedule: Actor[] = Array.from({ length: 40 }, () => first);
      schedule.push(...Array.from({ length: 40 }, () => second));
      await checkSchedule(schedule);
    }
  });

  test("one start paused at every point while the other runs to the end", async () => {
    for (let k = 0; k <= 40; k += 1) {
      for (const [first, second] of [
        ["A", "B"],
        ["B", "A"],
      ] as const) {
        const schedule: Actor[] = [
          ...Array.from({ length: k }, () => first),
          ...Array.from({ length: 40 }, () => second),
        ];
        await checkSchedule(schedule);
      }
    }
  });

  test("random interleavings of the two starts end with exactly one holder", async () => {
    const random = seeded(20261017);
    const sawRestore = { value: false };
    for (let run = 0; run < 2000; run += 1) {
      const schedule: Actor[] = Array.from({ length: 40 }, () =>
        random() < 0.5 ? "A" : "B",
      );
      const ops = await checkSchedule(schedule);
      if (ops.some((op) => op.includes(" link "))) sawRestore.value = true;
    }
    // The sweep reaches the case that matters: one start moves the other's live lock
    // aside, finds it is not the stale one, and puts it back.
    expect(sawRestore.value).toBe(true);
  });
});
