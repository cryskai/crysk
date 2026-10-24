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
import {
  cancelTiming,
  findLiveRuns,
  pollTiming,
  type RunScope,
  type RunTiming,
  stopRun,
} from "./runs";

export interface ScenarioPr {
  number: number;
  headRefName: string;
  url: string;
}

// An open scenario PR as the listing reports it: its title and creation time are what
// the run lookup matches its comment runs by.
export interface ListedPr extends ScenarioPr {
  title: string;
  createdAt: string;
}

// What gh returns for an open PR: the scenario fields, plus where its head lives.
interface OpenPr extends ListedPr {
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
// start while this list is not empty. The list is read whole and filtered here, not
// searched: GitHub's search index lags the PR list, so a PR opened moments ago can be
// missing from a search. The page is far above any repository's open PRs, so a scenario
// PR behind a long run of newer, unrelated PRs is still in it.
export async function listScenarioPrs(deps: SandboxDeps): Promise<ListedPr[]> {
  const open = await ghJson<OpenPr[]>(deps, [
    "pr",
    "list",
    "-R",
    SANDBOX_REPO,
    "--state",
    "open",
    "--json",
    "number,headRefName,url,title,createdAt,isCrossRepository,headRepositoryOwner",
    "--limit",
    "1000",
  ]);
  return open
    .filter(isScenarioPr)
    .map(({ number, headRefName, url, title, createdAt }) => ({
      number,
      headRefName,
      url,
      title,
      createdAt,
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

// A PR is closed only after the runs of the PR are stopped. Closing it over a
// live run releases the serialization lock while the review keeps running, so
// clean keeps the order smoke's cleanup keeps: cancel, wait, then close. A run
// that will not stop keeps its PR open, for the next clean.
export async function runClean(
  input: SandboxDeps,
  options: RunTiming = {},
): Promise<number> {
  const deps = guarded(input);
  const open = await listScenarioPrs(deps);
  let failed = 0;
  for (const pr of open) {
    try {
      if (!(await stopPrRuns(deps, pr, options))) {
        failed += 1;
        deps.log(
          `left open: ${pr.url} stays open until its run ends (then clean)`,
        );
        continue;
      }
      deps.log(`closing ${pr.url} and deleting ${pr.headRefName}`);
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

// Cancels each run of the PR that is still going, and waits for every one to report
// completed. Returns false when one did not stop within the cancel wait. No stop
// signal reaches clean, so its waits run to their bounds.
async function stopPrRuns(
  deps: SandboxDeps,
  pr: ListedPr,
  options: RunTiming,
): Promise<boolean> {
  const created = Date.parse(pr.createdAt);
  const scope: RunScope = {
    branch: pr.headRefName,
    title: pr.title,
    pr: pr.number,
    prCreatedAtMs: created,
    startedAtMs: created,
  };
  const runIds = await findLiveRuns(
    deps,
    scope,
    pollTiming(options),
    undefined,
  );
  for (const runId of runIds) {
    if (!(await stopRun(deps, runId, cancelTiming(options), undefined))) {
      return false;
    }
  }
  return true;
}

function guarded(input: SandboxDeps): SandboxDeps {
  return { ...input, gh: guardedGh(input.gh), git: guardedGit(input.git) };
}
