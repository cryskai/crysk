// Shared plumbing for the runners: a checked clone of the sandbox, and helpers
// that turn a failed call into an error with its stderr attached. Callers pass
// guarded deps, so every call made here has already passed the rails.

import type { SandboxDeps } from "./ports";
import { assertSandboxRemote, SANDBOX_REPO } from "./rails";

export async function ghOk(
  deps: SandboxDeps,
  args: readonly string[],
): Promise<string> {
  const result = await deps.gh(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

export async function ghJson<T>(
  deps: SandboxDeps,
  args: readonly string[],
): Promise<T> {
  return JSON.parse(await ghOk(deps, args)) as T;
}

export async function git(
  deps: SandboxDeps,
  dir: string,
  args: readonly string[],
): Promise<string> {
  const result = await deps.git(args, dir);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

// Clones the sandbox into `dir` and confirms that its origin is the sandbox
// before anything is pushed. `git push origin` trusts the remote it finds, so
// the check belongs here, at the one place a clone is made.
export async function cloneSandbox(
  deps: SandboxDeps,
  dir: string,
): Promise<void> {
  await ghOk(deps, ["repo", "clone", SANDBOX_REPO, dir]);
  const origin = (await git(deps, dir, ["remote", "get-url", "origin"])).trim();
  assertSandboxRemote(origin);
}

// Commits exactly `paths` with `message`. Only the named paths are staged, so a
// commit can never sweep in an unrelated change left in the scratch clone.
export async function commitPaths(
  deps: SandboxDeps,
  dir: string,
  paths: readonly string[],
  message: string,
): Promise<void> {
  await git(deps, dir, ["add", "--", ...paths]);
  await git(deps, dir, ["commit", "-m", message]);
}
