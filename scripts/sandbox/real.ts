// The real I/O for the sandbox runner: gh and git as child processes, the wall
// clock, a scratch directory under the OS temp dir, and stdout. Nothing in the
// logic imports this file; the entry point wires it, and tests never do.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  Clock,
  Gh,
  GhResult,
  Git,
  GitResult,
  SandboxDeps,
  Workspace,
} from "./ports";

async function run(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): Promise<GhResult> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export const realGh: Gh = (args) => run(["gh", ...args]);

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
  run(["git", ...args], cwd, GIT_ENV);

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

export function realDeps(): SandboxDeps {
  return {
    gh: realGh,
    git: realGit,
    clock: realClock,
    workspace: realWorkspace,
    log: (line) => console.log(line),
  };
}
