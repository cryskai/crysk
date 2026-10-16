// Offline doubles for scripts/sandbox. Every gh and git call lands in `events`
// next to the runner's log lines, in order, so a test can assert both what was
// called and what was printed before it (the PR URL before the close, say).
//
// The workspace is in memory: the clone is simulated by seeding the directory
// the runner asks `gh repo clone` for, so the runner's own reads and writes are
// exercised without touching the real disk or the network.

import type {
  Clock,
  Gh,
  GhResult,
  Git,
  GitResult,
  SandboxDeps,
  Signal,
  SignalSource,
  Workspace,
} from "../../scripts/sandbox/ports";
import { SANDBOX_REMOTE_URL } from "../../scripts/sandbox/rails";

export const ok = (stdout = ""): GhResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});
export const fail = (stderr: string, exitCode = 1): GhResult => ({
  exitCode,
  stdout: "",
  stderr,
});
export const gitOk = (stdout = ""): GitResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});
export const gitFail = (stderr: string, exitCode = 1): GitResult => ({
  exitCode,
  stdout: "",
  stderr,
});

export interface MemoryWorkspace extends Workspace {
  dirs: Map<string, Map<string, string>>;
  seed(dir: string, files: ReadonlyMap<string, string>): void;
}

export function memoryWorkspace(): MemoryWorkspace {
  const dirs = new Map<string, Map<string, string>>();
  let counter = 0;
  return {
    dirs,
    seed(dir, files) {
      dirs.set(dir, new Map(files));
    },
    async mkdtemp() {
      counter += 1;
      const dir = `/scratch/clone-${counter}`;
      dirs.set(dir, new Map());
      return dir;
    },
    async remove(dir) {
      dirs.delete(dir);
    },
    async read(dir, rel) {
      return dirs.get(dir)?.get(rel);
    },
    async write(dir, rel, content) {
      const files = dirs.get(dir) ?? new Map<string, string>();
      files.set(rel, content);
      dirs.set(dir, files);
    },
  };
}

// A signal source a test can fire. `listeners` counts the handlers still
// installed, so a test can prove the runner removed its own.
export interface FakeSignals extends SignalSource {
  fire(signal: Signal): void;
  listeners(): number;
}

export function fakeSignals(): FakeSignals {
  const handlers = new Map<Signal, Set<() => void>>();
  const of = (signal: Signal) => {
    let set = handlers.get(signal);
    if (set === undefined) {
      set = new Set();
      handlers.set(signal, set);
    }
    return set;
  };
  return {
    on: (signal, handler) => {
      of(signal).add(handler);
    },
    off: (signal, handler) => {
      of(signal).delete(handler);
    },
    fire: (signal) => {
      for (const handler of [...of(signal)]) handler();
    },
    listeners: () => {
      let count = 0;
      for (const set of handlers.values()) count += set.size;
      return count;
    },
  };
}

export interface Harness {
  deps: SandboxDeps;
  events: string[];
  ghCalls: string[][];
  gitCalls: { args: string[]; cwd: string }[];
  logs: string[];
  clock: Clock & { sleeps: number[] };
  workspace: MemoryWorkspace;
  signals: FakeSignals;
}

export type GhScript = (
  args: readonly string[],
  h: Harness,
) => GhResult | Promise<GhResult>;
export type GitScript = (
  args: readonly string[],
  cwd: string,
  h: Harness,
) => GitResult | Promise<GitResult>;

export const START_ISO = "2026-10-16T14:30:00.000Z";
export const HEAD_SHA = "b".repeat(40);

// The default git answers for a repository with commits, pointed at the sandbox.
export const defaultGit: GitScript = (args) => {
  if (args[0] === "rev-parse") return gitOk(`${HEAD_SHA}\n`);
  if (args[0] === "remote") return gitOk(`${SANDBOX_REMOTE_URL}\n`);
  return gitOk();
};

function fakeClock(startIso: string): Clock & { sleeps: number[] } {
  let current = Date.parse(startIso);
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(current),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
  };
}

export function harness(script: { gh: GhScript; git?: GitScript }): Harness {
  const events: string[] = [];
  const ghCalls: string[][] = [];
  const gitCalls: { args: string[]; cwd: string }[] = [];
  const logs: string[] = [];
  const clock = fakeClock(START_ISO);
  const workspace = memoryWorkspace();
  const gitScript = script.git ?? defaultGit;
  const signals = fakeSignals();
  const h: Harness = {
    deps: undefined as unknown as SandboxDeps,
    events,
    ghCalls,
    gitCalls,
    logs,
    clock,
    workspace,
    signals,
  };
  const gh: Gh = async (args) => {
    ghCalls.push([...args]);
    events.push(`gh ${args.join(" ")}`);
    return script.gh(args, h);
  };
  const git: Git = async (args, cwd) => {
    gitCalls.push({ args: [...args], cwd });
    events.push(`git ${args.join(" ")}`);
    return gitScript(args, cwd, h);
  };
  const log = (line: string) => {
    logs.push(line);
    events.push(`log ${line}`);
  };
  h.deps = { gh, git, clock, workspace, signals, log };
  return h;
}
