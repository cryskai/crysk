// smoke: one planted-bug PR through the free route, end to end, then cleanup.
//
// The PR is opened from a branch off main that pins the same action ref as the
// workflow it runs under, so the run exercises the ref under test and nothing
// else. The run is found by head sha (not by "latest"), because a stale run on
// an earlier head must never be read as this one. Whatever happens after the PR
// exists, cleanup runs in a finally: a scenario PR is never left open by accident
// unless --keep asked for it.

import { STATUS_CONTEXT, WORKFLOW_NAME } from "./markers";
import {
  type CommentFact,
  classifyComment,
  classifyPath,
  exitCodeFor,
  invariantViolations,
  type Observation,
} from "./observe";
import type { SandboxDeps } from "./ports";
import {
  closeScenarioPr,
  deleteScenarioBranch,
  listScenarioPrs,
  type ScenarioPr,
} from "./pr";
import {
  assertScenarioBranch,
  guardedGh,
  guardedGit,
  SANDBOX_REPO,
  SCENARIO_BRANCH_PREFIX,
} from "./rails";
import { cloneSandbox, commitPaths, ghJson, ghOk, git } from "./repo";
import { renderReport } from "./report";
import {
  PLANTED_COMMIT_MESSAGE,
  plantedVolume,
  VOLUME_PATH,
  validateRef,
  WORKFLOW_PATH,
  workflowFor,
} from "./seed";

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_TIMEOUT_MS = 25 * 60_000;

export interface SmokeOptions {
  ref: string;
  keep: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface RunListItem {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  workflowName: string;
  url: string;
}

interface Scenario {
  branch: string;
  pushed: boolean;
  pr?: ScenarioPr;
}

const SMOKE_PR_BODY =
  "Scenario PR from pr-hero's sandbox runner (`bun scripts/sandbox.ts smoke`). " +
  "It carries one planted bug and is closed by the runner unless --keep was given.";

export function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export async function runSmoke(
  input: SandboxDeps,
  options: SmokeOptions,
): Promise<number> {
  validateRef(options.ref);
  const deps: SandboxDeps = {
    ...input,
    gh: guardedGh(input.gh),
    git: guardedGit(input.git),
  };

  const open = await listScenarioPrs(deps);
  if (open.length > 0) {
    deps.log(
      `refusing to start: ${open.length} scenario PR(s) still open (runs are serialized):`,
    );
    for (const pr of open)
      deps.log(`  #${pr.number} ${pr.headRefName} ${pr.url}`);
    deps.log("close them with `bun scripts/sandbox.ts clean`, then re-run");
    return 1;
  }

  const branch = `${SCENARIO_BRANCH_PREFIX}smoke-${utcStamp(deps.clock.now())}`;
  assertScenarioBranch(branch);
  const scenario: Scenario = { branch, pushed: false };
  const dir = await deps.workspace.mkdtemp();
  let exitCode: 0 | 1 = 1;
  try {
    await cloneSandbox(deps, dir);
    const headSha = await pushScenario(deps, dir, scenario, options.ref);
    const pr = await openPr(deps, scenario);
    deps.log(`PR: ${pr.url}`);

    const run = await waitForRun(deps, headSha, branch, options);
    const observed = await collect(deps, pr, headSha, run);
    const path = classifyPath(observed);
    const violations = invariantViolations(observed);
    exitCode = exitCodeFor(path, violations);
    for (const line of renderReport(observed, path, violations, exitCode))
      deps.log(line);
  } catch (error) {
    deps.log(
      `smoke stopped early: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    exitCode = await finish(deps, scenario, options.keep, exitCode);
    await deps.workspace.remove(dir).catch(() => undefined);
  }
  return exitCode;
}

// Commits the planted bug on a branch off main. If the workflow on main pins
// another ref, the branch gets its own pin commit first, so the run under test
// uses the ref the operator asked for.
async function pushScenario(
  deps: SandboxDeps,
  dir: string,
  scenario: Scenario,
  ref: string,
): Promise<string> {
  await git(deps, dir, ["checkout", "-b", scenario.branch]);
  const pinned = workflowFor(ref);
  if ((await deps.workspace.read(dir, WORKFLOW_PATH)) !== pinned) {
    await deps.workspace.write(dir, WORKFLOW_PATH, pinned);
    await commitPaths(
      deps,
      dir,
      [WORKFLOW_PATH],
      `sandbox: pin action to ${ref}`,
    );
  }
  await deps.workspace.write(dir, VOLUME_PATH, plantedVolume());
  await commitPaths(deps, dir, [VOLUME_PATH], PLANTED_COMMIT_MESSAGE);
  // Recorded before the push: a push that fails after the branch was created
  // still has to be cleaned up.
  scenario.pushed = true;
  await git(deps, dir, ["push", "-u", "origin", scenario.branch]);
  return (await git(deps, dir, ["rev-parse", "HEAD"])).trim();
}

async function openPr(
  deps: SandboxDeps,
  scenario: Scenario,
): Promise<ScenarioPr> {
  const out = await ghOk(deps, [
    "pr",
    "create",
    "-R",
    SANDBOX_REPO,
    "--base",
    "main",
    "--head",
    scenario.branch,
    "--title",
    `pr-hero sandbox smoke ${scenario.branch}`,
    "--body",
    SMOKE_PR_BODY,
  ]);
  const url = out.trim().split("\n").at(-1) ?? "";
  const match = /\/pull\/(\d+)$/.exec(url);
  if (match === null)
    throw new Error(`gh pr create printed no PR URL: ${out.trim()}`);
  const pr: ScenarioPr = {
    number: Number(match[1]),
    headRefName: scenario.branch,
    url,
  };
  scenario.pr = pr;
  return pr;
}

// Polls for the run of this head. Returns the run as soon as it completes, or
// the last one seen when the timeout passes, so the report still says what
// the PR looked like when the runner gave up.
async function waitForRun(
  deps: SandboxDeps,
  headSha: string,
  branch: string,
  options: SmokeOptions,
): Promise<RunListItem | undefined> {
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = deps.clock.now().getTime() + timeout;
  for (;;) {
    const runs = await ghJson<RunListItem[]>(deps, [
      "run",
      "list",
      "-R",
      SANDBOX_REPO,
      "--branch",
      branch,
      "--event",
      "pull_request",
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,status,conclusion,workflowName,url",
    ]);
    const run = runs.find(
      (r) => r.headSha === headSha && r.workflowName === WORKFLOW_NAME,
    );
    if (run?.status === "completed") return run;
    if (deps.clock.now().getTime() >= deadline) {
      deps.log(
        `timed out after ${Math.round(timeout / 1000)}s waiting for the run; collecting what is visible`,
      );
      return run;
    }
    await deps.clock.sleep(interval);
  }
}

// Reads the observables of the head. Each source is a separate call, so a failure
// in one is an error for the whole smoke, not a silently empty field.
async function collect(
  deps: SandboxDeps,
  pr: ScenarioPr,
  headSha: string,
  run: RunListItem | undefined,
): Promise<Observation> {
  const runView =
    run === undefined
      ? undefined
      : await ghJson<{
          status: string;
          conclusion: string | null;
          jobs: { steps: { name: string; conclusion: string | null }[] }[];
        }>(deps, [
          "run",
          "view",
          String(run.databaseId),
          "-R",
          SANDBOX_REPO,
          "--json",
          "status,conclusion,jobs",
        ]);
  const combined = await ghJson<{
    statuses: { context: string; state: string; description: string }[];
  }>(deps, ["api", `repos/${SANDBOX_REPO}/commits/${headSha}/status`]);
  const issueComments = await ghJson<{ body: string }[]>(deps, [
    "api",
    `repos/${SANDBOX_REPO}/issues/${pr.number}/comments?per_page=100`,
  ]);
  const inlineComments = await ghJson<{ body: string }[]>(deps, [
    "api",
    `repos/${SANDBOX_REPO}/pulls/${pr.number}/comments?per_page=100`,
  ]);
  const artifacts =
    run === undefined
      ? []
      : (
          await ghJson<{ artifacts: { name: string }[] }>(deps, [
            "api",
            `repos/${SANDBOX_REPO}/actions/runs/${run.databaseId}/artifacts`,
          ])
        ).artifacts.map((a) => a.name);
  const comments: CommentFact[] = [
    ...issueComments.map((c) => classifyComment(c.body, "issue")),
    ...inlineComments.map((c) => classifyComment(c.body, "inline")),
  ];
  const latest = combined.statuses.find((s) => s.context === STATUS_CONTEXT);
  return {
    prNumber: pr.number,
    prUrl: pr.url,
    headSha,
    run:
      run === undefined || runView === undefined
        ? undefined
        : {
            id: run.databaseId,
            status: runView.status,
            conclusion: runView.conclusion,
            steps: runView.jobs.flatMap((j) => j.steps),
          },
    status:
      latest === undefined
        ? undefined
        : { state: latest.state, description: latest.description },
    comments,
    artifacts,
  };
}

// Cleanup. --keep leaves everything in place and says where it is. Otherwise the
// PR is closed with its branch, or a branch with no PR is deleted. A failure here
// turns the run into exit 1, because a scenario PR left open breaks serialization.
async function finish(
  deps: SandboxDeps,
  scenario: Scenario,
  keep: boolean,
  exitCode: 0 | 1,
): Promise<0 | 1> {
  if (keep) {
    if (scenario.pushed) {
      deps.log(
        `kept: ${scenario.pr?.url ?? "no PR"} on ${scenario.branch} (clean with \`bun scripts/sandbox.ts clean\`)`,
      );
    }
    return exitCode;
  }
  try {
    if (scenario.pr !== undefined) {
      deps.log(`closing ${scenario.pr.url} and deleting ${scenario.branch}`);
      await closeScenarioPr(deps, scenario.pr);
    } else if (scenario.pushed) {
      deps.log(`deleting ${scenario.branch}`);
      await deleteScenarioBranch(deps, scenario.branch);
    }
    return exitCode;
  } catch (error) {
    deps.log(
      `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
