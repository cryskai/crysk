// The real I/O for the sandbox runner: gh and git as child processes, the wall
// clock, a scratch directory under the OS temp dir, and stdout. Nothing in the
// logic imports this file; the entry point wires it, and tests never do.

import { randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  Clock,
  Gh,
  GhResult,
  Git,
  GitResult,
  LockHolder,
  RunLockFile,
  SandboxDeps,
  Signal,
  SignalSource,
  Workspace,
} from "./ports";

// The part of a child process the runner reads. Bun.spawn returns it; a test
// hands in a fake, so a child that never answers can be simulated offline.
export interface Child {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export type Spawn = (
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> },
) => Child;

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  spawn?: Spawn;
  timeoutMs: number;
  killGraceMs?: number;
}

const spawnBun: Spawn = (cmd, opts) =>
  Bun.spawn(cmd, { ...opts, stdout: "pipe", stderr: "pipe" });

// The deadlines of every gh and git call. A call that outlives its budget is
// killed and fails like a non-zero exit, so a stall can neither hang the run
// past its deadline nor past cleanup. Named here so the budgets are reviewed in
// one place.
export const GH_TIMEOUT_MS = 120_000;
// A clone and a push move the whole repository, so they get the long budget.
export const TRANSFER_TIMEOUT_MS = 300_000;
// After a kill, how long the output may take to settle. A grandchild that
// inherited a pipe can hold it open, and the grace keeps that from stalling.
export const KILL_GRACE_MS = 5_000;
const TIMEOUT_EXIT_CODE = 124;

export function ghTimeoutMs(args: readonly string[]): number {
  return args[0] === "repo" && args[1] === "clone"
    ? TRANSFER_TIMEOUT_MS
    : GH_TIMEOUT_MS;
}

export function gitTimeoutMs(args: readonly string[]): number {
  return args[0] === "push" ? TRANSFER_TIMEOUT_MS : GH_TIMEOUT_MS;
}

const TIMED_OUT = Symbol("timed-out");

// Resolves with the value, or with TIMED_OUT once `ms` has passed. The timer is
// cleared on the normal path, so a finished call leaves nothing running.
async function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// Runs one command and returns its output. On the deadline the child is killed,
// and the call returns a non-zero result rather than waiting on a pipe that a
// killed child may never close.
export async function runCommand(
  cmd: string[],
  opts: RunOptions,
): Promise<GhResult> {
  const child = (opts.spawn ?? spawnBun)(cmd, {
    cwd: opts.cwd,
    env: opts.env,
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr }));
  const first = await within(output, opts.timeoutMs);
  if (first !== TIMED_OUT) return first;
  child.kill("SIGKILL");
  // Killing the child normally closes its pipes, so the output settles and is
  // read to the end. The grace bounds the wait for the case where it does not.
  await within(
    output.catch(() => undefined),
    opts.killGraceMs ?? KILL_GRACE_MS,
  );
  return {
    exitCode: TIMEOUT_EXIT_CODE,
    stdout: "",
    stderr: `timed out after ${Math.round(opts.timeoutMs / 1000)}s: ${cmd.slice(0, 2).join(" ")}`,
  };
}

export const realGh: Gh = (args) =>
  runCommand(["gh", ...args], { timeoutMs: ghTimeoutMs(args) });

// The user's own git config stays in force: pushing to the sandbox needs their
// credentials. Only the prompt is disabled, so a missing credential fails the
// run instead of hanging it. Identity is fixed so commits never depend on it.
const GIT_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "pr-hero sandbox",
  GIT_AUTHOR_EMAIL: "sandbox@pr-hero.invalid",
  GIT_COMMITTER_NAME: "pr-hero sandbox",
  GIT_COMMITTER_EMAIL: "sandbox@pr-hero.invalid",
};

export const realGit: Git = (args, cwd): Promise<GitResult> =>
  runCommand(["git", ...args], {
    cwd,
    env: GIT_ENV,
    timeoutMs: gitTimeoutMs(args),
  });

// The process's own signals. The runner listens only for the length of a scenario.
export const realSignals: SignalSource = {
  on: (signal: Signal, handler) => {
    process.on(signal, handler);
  },
  off: (signal: Signal, handler) => {
    process.off(signal, handler);
  },
};

export const realClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const realWorkspace: Workspace = {
  mkdtemp: () => mkdtemp(path.join(tmpdir(), "pr-hero-sandbox-")),
  remove: (dir) => rm(dir, { recursive: true, force: true }),
  read: async (dir, rel) => {
    try {
      return await readFile(path.join(dir, rel), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  write: async (dir, rel, content) => {
    const file = path.join(dir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  },
};

// The run lock's file: ~/.prhero/sandbox.lock, unless a test points it elsewhere.
export function defaultLockPath(): string {
  return path.join(homedir(), ".prhero", "sandbox.lock");
}

// The file operations the run lock makes. The real ones are node's. A test passes an
// in-memory set instead, so every operation can be interleaved with another start's.
export interface LockIo {
  readFile(file: string): Promise<string>;
  // Creates the file with `content`, failing with EEXIST when it exists (`wx`).
  writeExclusive(file: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  // Gives `to` a second name for the file at `from`. It fails with EEXIST when `to`
  // exists, unlike rename, which would replace it.
  link(from: string, to: string): Promise<void>;
  // Removes the file. A file that is already gone is not an error.
  unlink(file: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  alive(pid: number): boolean;
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

const nodeLockIo: LockIo = {
  readFile: (file) => readFile(file, "utf8"),
  writeExclusive: (file, content) => writeFile(file, content, { flag: "wx" }),
  rename,
  link,
  unlink: (file) => rm(file, { force: true }),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  alive: (target) => {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists and belongs to someone else, so it is alive.
      return hasCode(error, "EPERM");
    }
  },
};

// What a lock file's text records: a pid, or nothing usable.
function holderOf(text: string): LockHolder {
  const value = text.trim();
  return /^[1-9]\d*$/.test(value)
    ? { kind: "pid", pid: Number(value) }
    : { kind: "unreadable" };
}

// The lock as a file that records a pid. The exclusive create (`wx`) is what makes
// two racing starts safe: exactly one of them creates it. A file whose content is
// not a pid reads as unreadable, never as absent, so a start killed between the
// create and the write refuses rather than letting a second run in.
export function realRunLock(
  lockPath: string,
  pid: number = process.pid,
  io: LockIo = nodeLockIo,
): RunLockFile {
  const holder = async (): Promise<LockHolder> => {
    let text: string;
    try {
      text = await io.readFile(lockPath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { kind: "none" };
      throw error;
    }
    return holderOf(text);
  };
  return {
    path: lockPath,
    pid,
    create: async () => {
      await io.mkdir(path.dirname(lockPath));
      try {
        await io.writeExclusive(lockPath, `${pid}\n`);
        return true;
      } catch (error) {
        if (hasCode(error, "EEXIST")) return false;
        throw error;
      }
    },
    holder,
    remove: async (recorded) => {
      // The lock is moved to a name only this call knows, and what moved is read
      // there. Checking the lock's own name and then deleting it would be two steps,
      // and a start could take the lock between them, so the delete would remove that
      // start's live lock.
      const moved = `${lockPath}.stale-${pid}-${randomBytes(6).toString("hex")}`;
      try {
        await io.rename(lockPath, moved);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return;
        throw error;
      }
      const found = holderOf(await io.readFile(moved));
      if (found.kind === "pid" && found.pid === recorded) {
        await io.unlink(moved);
        return;
      }
      // Not the lock the caller meant: it is a live lock a racing start wrote after
      // the caller's read. It goes back under the lock's name. A link never replaces
      // a file, so if another start has created the lock since, the moved file is left
      // where it is, and the caller's create refuses.
      try {
        await io.link(moved, lockPath);
      } catch (error) {
        if (hasCode(error, "EEXIST")) return;
        throw error;
      }
      await io.unlink(moved);
    },
    alive: (target) => io.alive(target),
  };
}

export function realDeps(options: { lockPath?: string } = {}): SandboxDeps {
  return {
    gh: realGh,
    git: realGit,
    clock: realClock,
    workspace: realWorkspace,
    signals: realSignals,
    lock: realRunLock(options.lockPath ?? defaultLockPath()),
    log: (line) => console.log(line),
  };
}
