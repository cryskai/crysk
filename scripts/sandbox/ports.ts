// The injected seams of the sandbox runner. Every impure edge (gh, git, the
// clock, the scratch directory, the output) enters through one of these, so the
// runners and their rails run offline under test with fakes. The real
// implementations live in ./real.ts; nothing else here touches the outside world.

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// An argument vector, never a shell string: a value cannot smuggle in a flag.
export type Gh = (args: readonly string[]) => Promise<GhResult>;

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Git = (args: readonly string[], cwd: string) => Promise<GitResult>;

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

// The scratch area: a fresh clone per run, under the OS temp dir. Reads report
// an absent file as undefined rather than throwing, because init compares
// desired content against what is there.
export interface Workspace {
  mkdtemp(): Promise<string>;
  remove(dir: string): Promise<void>;
  read(dir: string, rel: string): Promise<string | undefined>;
  write(dir: string, rel: string, content: string): Promise<void>;
}

// The two signals an operator sends to stop a run. The runner listens for them
// only while a scenario is in flight, so Ctrl-C cleans up instead of leaving a PR.
export type Signal = "SIGINT" | "SIGTERM";

export interface SignalSource {
  on(signal: Signal, handler: () => void): void;
  off(signal: Signal, handler: () => void): void;
}

export interface SandboxDeps {
  gh: Gh;
  git: Git;
  clock: Clock;
  workspace: Workspace;
  signals: SignalSource;
  log: (line: string) => void;
}

// Whether gh's answer means "this does not exist" rather than "I could not
// tell". Only the former may lead to a create or a set: treating an unknown
// answer as absence could overwrite something that is there.
export function isNotFound(stderr: string): boolean {
  return /could not resolve to a repository|not found|404|could not find/i.test(
    stderr,
  );
}
