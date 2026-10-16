// init: bring the sandbox to the state a scenario run needs, idempotently.
//
// Order matters. The repo must exist before anything can be cloned, the clone
// must be the sandbox before anything is pushed, and the secret and variable
// are set last, after main is pinned, so a failed push never leaves a routing
// variable pointing at a workflow that is not there.
//
// Idempotence is by content, not by hope: each desired file is compared with
// the clone, and a commit is made only for the paths that differ. A second run
// with the same ref therefore sends no write at all.

import type { SandboxDeps } from "./ports";
import { isNotFound } from "./ports";
import { guardedGh, guardedGit, SANDBOX_REPO } from "./rails";
import { cloneSandbox, commitPaths, ghJson, ghOk, git } from "./repo";
import {
  OPENCODE_AUTH_SECRET,
  OPENCODE_AUTH_VALUE,
  REPO_DESCRIPTION,
  ROUTING_VALUE,
  ROUTING_VARIABLE,
  sandboxFiles,
  validateRef,
  WORKFLOW_PATH,
} from "./seed";

export async function runInit(input: SandboxDeps, ref: string): Promise<void> {
  validateRef(ref);
  const deps: SandboxDeps = {
    ...input,
    gh: guardedGh(input.gh),
    git: guardedGit(input.git),
  };
  await ensureRepo(deps);
  const dir = await deps.workspace.mkdtemp();
  try {
    await cloneSandbox(deps, dir);
    await seedMain(deps, dir, ref);
  } finally {
    await deps.workspace.remove(dir);
  }
  await ensureOpenCodeSecret(deps);
  await ensureRoutingVariable(deps);
}

async function ensureRepo(deps: SandboxDeps): Promise<void> {
  const view = await deps.gh(["repo", "view", SANDBOX_REPO, "--json", "name"]);
  if (view.exitCode === 0) {
    deps.log(`repo: ${SANDBOX_REPO} exists`);
    return;
  }
  // Anything but a not-found answer stops here: creating a repo on an unknown
  // answer could collide with one that exists but could not be read right now.
  if (!isNotFound(view.stderr)) {
    throw new Error(
      `gh repo view failed, so nothing was created: ${view.stderr.trim()}`,
    );
  }
  await ghOk(deps, [
    "repo",
    "create",
    SANDBOX_REPO,
    "--public",
    "--description",
    REPO_DESCRIPTION,
  ]);
  deps.log(`repo: created public ${SANDBOX_REPO}`);
}

async function seedMain(
  deps: SandboxDeps,
  dir: string,
  ref: string,
): Promise<void> {
  const hasMain =
    (await deps.git(["rev-parse", "--verify", "--quiet", "HEAD"], dir))
      .exitCode === 0;
  // An empty repo has an unborn HEAD. Pointing it at main is local only; the
  // push below is the first thing that creates the branch on GitHub.
  if (!hasMain)
    await git(deps, dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  const changed: string[] = [];
  for (const [rel, content] of sandboxFiles(ref)) {
    if ((await deps.workspace.read(dir, rel)) === content) continue;
    await deps.workspace.write(dir, rel, content);
    changed.push(rel);
  }
  if (changed.length === 0) {
    deps.log(`main: already at ${ref}, nothing to push`);
    return;
  }
  // A re-run with another ref changes only the workflow pin, and says so in the
  // commit message; anything else is a (re)seed.
  const pinOnly =
    hasMain && changed.length === 1 && changed[0] === WORKFLOW_PATH;
  const message = pinOnly
    ? `sandbox: pin action to ${ref}`
    : "sandbox: seed main";
  await commitPaths(deps, dir, changed, message);
  await git(deps, dir, ["push", "origin", "main"]);
  deps.log(`main: pushed "${message}" (${changed.length} file(s))`);
}

// GitHub never returns a secret's value, so init can only check presence. A
// present secret is left alone; this is stated in the output, not hidden.
async function ensureOpenCodeSecret(deps: SandboxDeps): Promise<void> {
  const secrets = await ghJson<{ name: string }[]>(deps, [
    "secret",
    "list",
    "-R",
    SANDBOX_REPO,
    "--json",
    "name",
  ]);
  if (secrets.some((s) => s.name === OPENCODE_AUTH_SECRET)) {
    deps.log(
      `secret ${OPENCODE_AUTH_SECRET}: present (values are never read back, so not rewritten)`,
    );
    return;
  }
  await ghOk(deps, [
    "secret",
    "set",
    OPENCODE_AUTH_SECRET,
    "-R",
    SANDBOX_REPO,
    "--body",
    OPENCODE_AUTH_VALUE,
  ]);
  deps.log(`secret ${OPENCODE_AUTH_SECRET}: set to {}`);
}

// A variable's value can be read back, so it is compared and set only when it
// differs or is absent.
async function ensureRoutingVariable(deps: SandboxDeps): Promise<void> {
  const got = await deps.gh([
    "variable",
    "get",
    ROUTING_VARIABLE,
    "-R",
    SANDBOX_REPO,
  ]);
  if (got.exitCode === 0 && got.stdout.trimEnd() === ROUTING_VALUE) {
    deps.log(`variable ${ROUTING_VARIABLE}: unchanged`);
    return;
  }
  if (got.exitCode !== 0 && !isNotFound(got.stderr)) {
    throw new Error(
      `gh variable get failed, so nothing was set: ${got.stderr.trim()}`,
    );
  }
  const why = got.exitCode === 0 ? "differs" : "absent";
  await ghOk(deps, [
    "variable",
    "set",
    ROUTING_VARIABLE,
    "-R",
    SANDBOX_REPO,
    "--body",
    ROUTING_VALUE,
  ]);
  deps.log(`variable ${ROUTING_VARIABLE}: ${why}, set`);
}
