// Scenario PRs and their branches: list them, close them, and delete their
// branches. Every call here goes through the same rails as the rest of the
// runner, and a PR is only ever closed when its head is a sandbox/ branch.

import type { SandboxDeps } from "./ports";
import {
  assertScenarioBranch,
  guardedGh,
  guardedGit,
  SANDBOX_OWNER,
  SANDBOX_REPO,
  SCENARIO_BRANCH_PREFIX,
} from "./rails";
import { ghJson, ghOk } from "./repo";

export interface ScenarioPr {
  number: number;
  headRefName: string;
  url: string;
}

// What gh returns for an open PR: the scenario fields, plus where its head lives.
interface OpenPr extends ScenarioPr {
  isCrossRepository: boolean;
  headRepositoryOwner: { login: string } | null;
}

// A scenario PR is a same-repo PR from a sandbox/ branch owned by the sandbox
// owner. A branch name alone decides nothing: anyone can open a fork PR with a
// sandbox/ head on this public repo, and such a PR is neither a lock nor
// something clean may close. An owner that gh cannot name (a deleted fork)
// fails the same test.
function isScenarioPr(pr: OpenPr): boolean {
  return (
    pr.isCrossRepository === false &&
    pr.headRepositoryOwner?.login === SANDBOX_OWNER &&
    pr.headRefName.startsWith(SCENARIO_BRANCH_PREFIX)
  );
}

// The open scenario PRs. This is also the serialization check: smoke refuses to
// start while this list is not empty.
export async function listScenarioPrs(
  deps: SandboxDeps,
): Promise<ScenarioPr[]> {
  const open = await ghJson<OpenPr[]>(deps, [
    "pr",
    "list",
    "-R",
    SANDBOX_REPO,
    "--state",
    "open",
    "--json",
    "number,headRefName,url,isCrossRepository,headRepositoryOwner",
    "--limit",
    "100",
  ]);
  return open.filter(isScenarioPr).map(({ number, headRefName, url }) => ({
    number,
    headRefName,
    url,
  }));
}

export async function closeScenarioPr(
  deps: SandboxDeps,
  pr: ScenarioPr,
): Promise<void> {
  assertScenarioBranch(pr.headRefName);
  await ghOk(deps, [
    "pr",
    "close",
    String(pr.number),
    "-R",
    SANDBOX_REPO,
    "--delete-branch",
  ]);
}

export async function deleteScenarioBranch(
  deps: SandboxDeps,
  branch: string,
): Promise<void> {
  assertScenarioBranch(branch);
  await ghOk(deps, [
    "api",
    `repos/${SANDBOX_REPO}/git/refs/heads/${branch}`,
    "-X",
    "DELETE",
  ]);
}

export async function runList(input: SandboxDeps): Promise<number> {
  const deps = guarded(input);
  const open = await listScenarioPrs(deps);
  if (open.length === 0) {
    deps.log("no open sandbox/ PRs");
    return 0;
  }
  for (const pr of open) deps.log(`#${pr.number} ${pr.headRefName} ${pr.url}`);
  return 0;
}

export async function runClean(input: SandboxDeps): Promise<number> {
  const deps = guarded(input);
  const open = await listScenarioPrs(deps);
  let failed = 0;
  for (const pr of open) {
    deps.log(`closing ${pr.url} and deleting ${pr.headRefName}`);
    try {
      await closeScenarioPr(deps, pr);
    } catch (error) {
      failed += 1;
      deps.log(
        `could not close ${pr.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (open.length === 0) deps.log("no open sandbox/ PRs");
  return failed === 0 ? 0 : 1;
}

function guarded(input: SandboxDeps): SandboxDeps {
  return { ...input, gh: guardedGh(input.gh), git: guardedGit(input.git) };
}
