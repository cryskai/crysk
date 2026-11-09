// init: bring the sandbox to the state a scenario run needs, idempotently.
//
// Order matters. The repo must exist before anything can be cloned, the clone
// must be the sandbox before anything is pushed, and the secrets check and the
// models variable come last, after main is pinned, so a failed push never leaves a
// models variable pointing at a workflow that is not there. The token check comes
// before the variable, so a missing token changes no models.
//
// Idempotence is by content, not by hope: each desired file is compared with
// the clone, and a commit is made only for the paths that differ. A second run
// with the same ref therefore sends no write at all.

import type { SandboxDeps } from "./ports";
import { isNotFound } from "./ports";
import { guardedGh, guardedGit, SANDBOX_REPO } from "./rails";
import { cloneSandbox, commitPaths, ghJson, ghOk, git } from "./repo";
import {
  API_KEY_SECRET,
  CLAUDE_TOKEN_SECRET,
  DEFAULT_ROUTE,
  MODELS_VARIABLE,
  modelsValueFor,
  REPO_DESCRIPTION,
  type Route,
  sandboxFiles,
  validateRef,
  WORKFLOW_PATH,
} from "./seed";

// `route` decides the reviews' models. The default is claude: CRYSK_MODELS is unset
// and the workflow runs the engine's default Claude models on the subscription
// token. opencode:<snapshot> sets the variable to that free model.
export async function runInit(
  input: SandboxDeps,
  ref: string,
  route: Route = DEFAULT_ROUTE,
): Promise<void> {
  validateRef(ref);
  // Refused before anything is written, so a bad snapshot changes nothing.
  const models =
    route.kind === "opencode" ? modelsValueFor(route.modelSnapshot) : undefined;
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
  await ensureToken(deps);
  if (models === undefined) await ensureModelsUnset(deps);
  else await ensureModelsVariable(deps, models);
}

async function secretNames(deps: SandboxDeps): Promise<string[]> {
  return (
    await ghJson<{ name: string }[]>(deps, [
      "secret",
      "list",
      "-R",
      SANDBOX_REPO,
      "--json",
      "name",
    ])
  ).map((secret) => secret.name);
}

// Refuses every route while CRYSK_CLAUDE_API_KEY is set on the sandbox: both routes
// run Claude (the opencode route its materiality judge), and a credentials order that
// lists api_key would bill per token. A listing failure refuses too, since an unknown
// answer cannot prove the key is absent. It deletes nothing: the owner does. The old
// ANTHROPIC_API_KEY is not checked: the scaffold no longer passes it, so it cannot bill.
async function refuseStrayApiKey(deps: SandboxDeps): Promise<void> {
  const listed = await deps.gh([
    "secret",
    "list",
    "-R",
    SANDBOX_REPO,
    "--json",
    "name",
  ]);
  if (listed.exitCode !== 0) {
    throw new Error(
      `gh secret list failed, so nothing was written: ${listed.stderr.trim()}`,
    );
  }
  const names = (JSON.parse(listed.stdout) as { name: string }[]).map(
    (secret) => secret.name,
  );
  if (names.includes(API_KEY_SECRET)) {
    throw new Error(
      `${API_KEY_SECRET} is set on the sandbox; its reviews run Claude on the subscription and must not be able to bill per token. ` +
        `Remove it: gh secret delete ${API_KEY_SECRET} --repo ${SANDBOX_REPO}`,
    );
  }
}

// An existing repo is checked for the stray key before anything else is written: the
// seed and the secrets come after this step. A repo this step creates has no secrets.
async function ensureRepo(deps: SandboxDeps): Promise<void> {
  const view = await deps.gh(["repo", "view", SANDBOX_REPO, "--json", "name"]);
  if (view.exitCode === 0) {
    await refuseStrayApiKey(deps);
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

// GitHub never returns a secret's value, so init can only check presence, and it sets
// no secret. Every route needs CRYSK_CLAUDE_OAUTH_TOKEN: the action's credential check
// counts only a CRYSK_* secret, and the Claude steps of every route run on it. Its
// absence is refused with the commands that set it: the runner never sets a value.
async function ensureToken(deps: SandboxDeps): Promise<void> {
  if (!(await secretNames(deps)).includes(CLAUDE_TOKEN_SECRET)) {
    throw new Error(
      `${CLAUDE_TOKEN_SECRET} is not set on ${SANDBOX_REPO}, so no review has a Claude subscription to run on. ` +
        `The owner sets it with: claude setup-token, then gh secret set ${CLAUDE_TOKEN_SECRET} --repo ${SANDBOX_REPO}`,
    );
  }
  deps.log(
    `secret ${CLAUDE_TOKEN_SECRET}: present (values are never read back, so not rewritten)`,
  );
}

// The claude route runs the engine's default models, which an unset variable selects:
// the workflow's `models:` input is then empty, and the setup step reads an empty input
// as no models (src/ci/setup.ts). So a present variable is deleted, and an absent one
// is left alone, which keeps a second run write-free.
async function ensureModelsUnset(deps: SandboxDeps): Promise<void> {
  const got = await deps.gh([
    "variable",
    "get",
    MODELS_VARIABLE,
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
      `variable ${MODELS_VARIABLE}: absent, the default Claude models run`,
    );
    return;
  }
  await ghOk(deps, [
    "variable",
    "delete",
    MODELS_VARIABLE,
    "--repo",
    SANDBOX_REPO,
  ]);
  deps.log(
    `variable ${MODELS_VARIABLE}: deleted, the default Claude models run`,
  );
}

// A variable's value can be read back, so it is compared and set only when it
// differs or is absent.
async function ensureModelsVariable(
  deps: SandboxDeps,
  models: string,
): Promise<void> {
  const got = await deps.gh([
    "variable",
    "get",
    MODELS_VARIABLE,
    "-R",
    SANDBOX_REPO,
  ]);
  if (got.exitCode === 0 && got.stdout.trimEnd() === models) {
    deps.log(`variable ${MODELS_VARIABLE}: unchanged`);
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
    MODELS_VARIABLE,
    "-R",
    SANDBOX_REPO,
    "--body",
    models,
  ]);
  deps.log(`variable ${MODELS_VARIABLE}: ${why}, set`);
}
