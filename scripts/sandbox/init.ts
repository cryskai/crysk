// init: bring the sandbox to the state a scenario run needs, idempotently.
//
// Order matters. The repo must exist before anything can be cloned, the clone
// must be the sandbox before anything is pushed, and the secrets and routing
// variable are set last, after main is pinned, so a failed push never leaves a
// routing variable pointing at a workflow that is not there. Within the secrets
// step the claude route's token check comes first, so a missing token changes no
// routing.
//
// Idempotence is by content, not by hope: each desired file is compared with
// the clone, and a commit is made only for the paths that differ. A second run
// with the same ref therefore sends no write at all.

import type { SandboxDeps } from "./ports";
import { isNotFound } from "./ports";
import { guardedGh, guardedGit, SANDBOX_REPO } from "./rails";
import { cloneSandbox, commitPaths, ghJson, ghOk, git } from "./repo";
import {
  CLAUDE_TOKEN_SECRET,
  DEFAULT_ROUTE,
  OPENCODE_AUTH_SECRET,
  OPENCODE_AUTH_VALUE,
  REPO_DESCRIPTION,
  ROUTING_VARIABLE,
  type Route,
  routingValueFor,
  sandboxFiles,
  validateRef,
  WORKFLOW_PATH,
} from "./seed";

// `route` decides the reviews' model route. The default is claude: the routing
// variable is unset and the workflow runs the engine's default stack on the
// subscription token. opencode:<snapshot> sets the variable to that free model.
export async function runInit(
  input: SandboxDeps,
  ref: string,
  route: Route = DEFAULT_ROUTE,
): Promise<void> {
  validateRef(ref);
  // Refused before anything is written, so a bad snapshot changes nothing.
  const routing =
    route.kind === "opencode"
      ? routingValueFor(route.modelSnapshot)
      : undefined;
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
  await ensureSecrets(deps, route);
  if (routing === undefined) await ensureRoutingUnset(deps);
  else await ensureRoutingVariable(deps, routing);
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

// GitHub never returns a secret's value, so init can only check presence. One
// listing serves both checks. A present secret is left alone; this is stated in the
// output, not hidden.
//
// The claude route needs CLAUDE_CODE_OAUTH_TOKEN, and its absence is refused with the
// command that sets it: the runner never sets a secret's value. The OpenCode auth
// secret is written on every route. It is harmless while PRHERO_ROUTING is unset, and
// the opencode route reads it.
async function ensureSecrets(deps: SandboxDeps, route: Route): Promise<void> {
  const names = (
    await ghJson<{ name: string }[]>(deps, [
      "secret",
      "list",
      "-R",
      SANDBOX_REPO,
      "--json",
      "name",
    ])
  ).map((secret) => secret.name);
  if (route.kind === "claude") {
    if (!names.includes(CLAUDE_TOKEN_SECRET)) {
      throw new Error(
        `${CLAUDE_TOKEN_SECRET} is not set on ${SANDBOX_REPO}, so the claude route has no subscription to run on. ` +
          `The owner sets it with: gh secret set ${CLAUDE_TOKEN_SECRET} --repo ${SANDBOX_REPO}`,
      );
    }
    deps.log(
      `secret ${CLAUDE_TOKEN_SECRET}: present (values are never read back, so not rewritten)`,
    );
  }
  if (names.includes(OPENCODE_AUTH_SECRET)) {
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

// The claude route runs on the engine's default stack, which an unset variable selects:
// the workflow's `routing:` input is then empty, and the setup step reads an empty
// routing as no routing config (src/ci/setup.ts). So a present variable is deleted, and
// an absent one is left alone, which keeps a second run write-free.
async function ensureRoutingUnset(deps: SandboxDeps): Promise<void> {
  const got = await deps.gh([
    "variable",
    "get",
    ROUTING_VARIABLE,
    "-R",
    SANDBOX_REPO,
  ]);
  if (got.exitCode !== 0) {
    if (!isNotFound(got.stderr)) {
      throw new Error(
        `gh variable get failed, so nothing was deleted: ${got.stderr.trim()}`,
      );
    }
    deps.log(
      `variable ${ROUTING_VARIABLE}: absent, the default Claude stack runs`,
    );
    return;
  }
  await ghOk(deps, [
    "variable",
    "delete",
    ROUTING_VARIABLE,
    "--repo",
    SANDBOX_REPO,
  ]);
  deps.log(
    `variable ${ROUTING_VARIABLE}: deleted, the default Claude stack runs`,
  );
}

// A variable's value can be read back, so it is compared and set only when it
// differs or is absent.
async function ensureRoutingVariable(
  deps: SandboxDeps,
  routing: string,
): Promise<void> {
  const got = await deps.gh([
    "variable",
    "get",
    ROUTING_VARIABLE,
    "-R",
    SANDBOX_REPO,
  ]);
  if (got.exitCode === 0 && got.stdout.trimEnd() === routing) {
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
    routing,
  ]);
  deps.log(`variable ${ROUTING_VARIABLE}: ${why}, set`);
}
