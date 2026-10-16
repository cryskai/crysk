// The scenario runner. A scenario is data (scenarios.ts). This file executes it
// against the real sandbox: each phase acts on the scenario PR, waits for the run
// that action starts, observes the PR, and checks its expectations against that one
// observation. Every scenario gets its own branch and PR, and cleanup runs in a
// finally, unless --keep asked for the PR to stay.
//
// smoke is the review-free scenario, run through this same code (smoke.ts).

import { type CheckResult, describeCheck, evaluateChecks } from "./expect";
import { STATUS_CONTEXT, WORKFLOW_NAME } from "./markers";
import {
  type CommentFact,
  classifyComment,
  classifyPath,
  invariantViolations,
  type Observation,
  type RunFact,
  type SmokePath,
} from "./observe";
import {
  Interrupted,
  type Interrupts,
  pollUntil,
  type PollTiming,
  SIGNAL_EXIT_CODES,
  stopAfterInterrupt,
  Unrecoverable,
  watchInterrupts,
} from "./poll";
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
import {
  renderReport,
  renderScenarioTable,
  type ScenarioResult,
} from "./report";
import {
  type Action,
  findScenario,
  type Phase,
  type Scenario,
} from "./scenarios";
import {
  PLANTED_COMMIT_MESSAGE,
  plantedVolume,
  VOLUME_PATH,
  validateRef,
  WORKFLOW_PATH,
  workflowFor,
} from "./seed";
import { type VariantName, workflowVariant } from "./variants";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 25 * 60_000;
// How long cleanup waits for a cancelled run to report completed. The workflow's
// own ceiling is 90 minutes, so a run still going past this is left to finish on
// its own, and its PR stays open until it does.
export const DEFAULT_CANCEL_WAIT_MS = 10 * 60_000;

export interface RunOptions {
  ref: string;
  keep: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  cancelWaitMs?: number;
}

interface RunListItem {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  workflowName: string;
  url: string;
  event?: string;
}

const RUN_FIELDS =
  "databaseId,headSha,status,conclusion,workflowName,url,event";

// What a running scenario knows so far. Named Live, not Scenario, because the
// scenario data in scenarios.ts is the Scenario type.
interface Live {
  scenario: string;
  branch: string;
  dir: string;
  pushed: boolean;
  pr?: ScenarioPr;
  headSha?: string;
  // The run the latest wait returned, observed by the next observe.
  run?: RunListItem;
  // The run of the current wait as last seen, recorded as each poll reads it. A
  // wait that is interrupted or times out leaves it set, so cleanup can cancel it.
  inFlight?: { databaseId: number; completed: boolean };
  // The issue_comment runs that existed before this scenario's comment. The
  // comment's own run is the one that appears after it.
  commentRunsBefore?: Set<number>;
}

function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

// Runs the named scenarios in order. Returns 0 when every expectation and every
// S7 check passed, and 1 otherwise, including a refused or failed scenario. A
// SIGINT or SIGTERM stops the invocation after the cleanup and returns the
// signal's exit code, so the scenarios that did not start are not run at all.
export async function runScenarios(
  input: SandboxDeps,
  names: readonly string[],
  options: RunOptions,
): Promise<number> {
  validateRef(options.ref);
  const deps: SandboxDeps = {
    ...input,
    gh: guardedGh(input.gh),
    git: guardedGit(input.git),
  };
  const scenarios = names.map((name) => {
    const found = findScenario(name);
    if (found === undefined) throw new Error(`unknown scenario ${name}`);
    return found;
  });

  const results: ScenarioResult[] = [];
  // The PRs this invocation opened. With --keep they stay open, so the next
  // scenario of the same run may pass the serialization check past them. Without
  // --keep they are closed, and any that stay open (a failed cleanup) still block.
  const opened: number[] = [];
  // Installed for the whole invocation, so a signal between scenarios stops it too.
  const interrupts = watchInterrupts(input.signals, deps.log);
  try {
    for (const [index, scenario] of scenarios.entries()) {
      const blocked = await serializationBlock(
        deps,
        options.keep ? opened : [],
      );
      if (blocked !== undefined) {
        results.push({
          name: scenario.name,
          path: "not run",
          checks: [],
          s7: [],
          error: blocked,
          refused: true,
          exitCode: 1,
        });
        const rest = scenarios.slice(index + 1).map((s) => s.name);
        if (rest.length > 0) deps.log(`not run: ${rest.join(", ")}`);
        break;
      }
      results.push(await runOne(deps, scenario, options, opened, interrupts));
      if (interrupts.received() !== undefined) {
        const rest = scenarios.slice(index + 1).map((s) => s.name);
        if (rest.length > 0) deps.log(`not run: ${rest.join(", ")}`);
        break;
      }
    }
  } finally {
    interrupts.dispose();
  }
  for (const line of renderScenarioTable(results)) deps.log(line);
  const signal = interrupts.received();
  if (signal !== undefined) return SIGNAL_EXIT_CODES[signal];
  return results.every((r) => r.exitCode === 0) ? 0 : 1;
}

// S6: runs are serialized. Returns the refusal reason when a scenario PR that this
// run may not pass is still open, and logs which one.
async function serializationBlock(
  deps: SandboxDeps,
  exempt: readonly number[],
): Promise<string | undefined> {
  const open = (await listScenarioPrs(deps)).filter(
    (pr) => !exempt.includes(pr.number),
  );
  if (open.length === 0) return undefined;
  deps.log(
    `refusing to start: ${open.length} scenario PR(s) still open (runs are serialized):`,
  );
  for (const pr of open)
    deps.log(`  #${pr.number} ${pr.headRefName} ${pr.url}`);
  deps.log("close them with `bun scripts/sandbox.ts clean`, then re-run");
  return `${open.length} scenario PR(s) still open`;
}

async function runOne(
  deps: SandboxDeps,
  scenario: Scenario,
  options: RunOptions,
  opened: number[],
  interrupts: Interrupts,
): Promise<ScenarioResult> {
  const branch = `${SCENARIO_BRANCH_PREFIX}${scenario.name}-${utcStamp(deps.clock.now())}`;
  assertScenarioBranch(branch);
  const live: Live = {
    scenario: scenario.name,
    branch,
    dir: await deps.workspace.mkdtemp(),
    pushed: false,
  };
  const checks: CheckResult[] = [];
  const s7: string[] = [];
  let path = "no observation";
  let error: string | undefined;
  // The work stops making calls once a signal lands; cleanup below uses deps.
  const work = stopAfterInterrupt(deps, interrupts);
  try {
    await cloneSandbox(work, live.dir);
    if (scenario.phases.some((p) => p.action.kind === "comment")) {
      await requirePinnedMain(work, live.dir, options.ref);
    }
    let previous: Observation | undefined;
    for (const [index, phase] of scenario.phases.entries()) {
      await perform(work, live, phase.action, options.ref, opened);
      const polled = await waitForRun(work, live, phase, options, interrupts);
      live.run = polled.run;
      if (!polled.completed) {
        deps.log(
          `timed out after ${Math.round(pollTiming(options).timeoutMs / 1000)}s waiting for the run; collecting what is visible`,
        );
      }
      const obs = await collect(work, live);
      // A run that did not complete has no path to read. It is reported as
      // timed-out and fails the scenario, whatever its partial evidence says.
      const observed: SmokePath = polled.completed
        ? classifyPath(obs)
        : "timed-out";
      path = observed;
      const violations = invariantViolations(obs);
      const tag = scenario.phases.length > 1 ? `[${index + 1}] ` : "";
      // A check after a prior outcome is asserted only when the phase before it
      // left an outcome comment; otherwise it is named, so the skip is explained.
      const priorOutcome =
        previous?.comments.some((c) => c.kind === "outcome") === true;
      const after = phase.afterPriorOutcome ?? [];
      if (!priorOutcome) {
        for (const check of after) {
          deps.log(
            `  not asserted: ${scenario.name} [${index + 1}] ${describeCheck(check)} (phase ${index} posted no outcome comment)`,
          );
        }
      }
      const asserted = priorOutcome
        ? [...phase.checks, ...after]
        : phase.checks;
      // A failed check of a run whose hunters failed is the free model's flake. It
      // keeps its failure and exit code; only its label says why. A head that posted
      // success was reviewed, whatever an outcome comment still says, so it is no flake.
      const freeModelFlake =
        observed === "hunters-failed" && obs.status?.state !== "success";
      const phaseChecks = evaluateChecks(asserted, obs).map(
        (r): CheckResult =>
          freeModelFlake && !r.pass
            ? { ...r, cause: "free-model-hunters-failed" }
            : r,
      );
      checks.push(...phaseChecks.map((r) => ({ ...r, label: tag + r.label })));
      s7.push(...violations);
      const passed =
        polled.completed &&
        violations.length === 0 &&
        phaseChecks.every((r) => r.pass);
      for (const line of renderReport(
        obs,
        observed,
        violations,
        passed ? 0 : 1,
      )) {
        deps.log(line);
      }
      if (!polled.completed) {
        error = `timed out after ${Math.round(pollTiming(options).timeoutMs / 1000)}s waiting for the run`;
        break;
      }
      previous = obs;
    }
  } catch (caught) {
    // An interrupt is logged by its handler; anything else is a failed step.
    error = caught instanceof Error ? caught.message : String(caught);
    if (!(caught instanceof Interrupted)) {
      deps.log(`scenario ${scenario.name} stopped early: ${error}`);
    }
  }
  const cleanupError = await finish(deps, live, options);
  await deps.workspace.remove(live.dir).catch(() => undefined);
  const failure = error ?? cleanupError;
  return {
    name: scenario.name,
    prUrl: live.pr?.url,
    path,
    checks,
    s7,
    error: failure,
    exitCode:
      failure === undefined && checks.every((c) => c.pass) && s7.length === 0
        ? 0
        : 1,
  };
}

// Runs one phase's action. The first phase opens the PR; later phases push or
// comment on it.
async function perform(
  deps: SandboxDeps,
  live: Live,
  action: Action,
  ref: string,
  opened: number[],
): Promise<void> {
  if (action.kind === "open") {
    await git(deps, live.dir, ["checkout", "-b", live.branch]);
    await pinVariant(deps, live, action.variant, ref);
    await deps.workspace.write(live.dir, VOLUME_PATH, plantedVolume());
    await commitPaths(deps, live.dir, [VOLUME_PATH], PLANTED_COMMIT_MESSAGE);
    await pushBranch(deps, live);
    const pr = await openPr(deps, live);
    opened.push(pr.number);
    deps.log(`PR: ${pr.url}`);
    return;
  }
  if (action.kind === "push") {
    // A push with nothing new would be an empty commit, which the rails do not
    // make. A scenario that pushes must change the workflow, and says so if not.
    if (!(await pinVariant(deps, live, action.variant, ref))) {
      throw new Error(
        `the ${action.variant} workflow is already on ${live.branch}, so the push would be empty`,
      );
    }
    await pushBranch(deps, live);
    return;
  }
  const pr = requirePr(live);
  live.commentRunsBefore = new Set(
    (await listCommentRuns(deps)).map((r) => r.databaseId),
  );
  const url = await ghOk(deps, [
    "pr",
    "comment",
    String(pr.number),
    "-R",
    SANDBOX_REPO,
    "--body",
    action.body,
  ]);
  deps.log(`comment: ${url.trim()}`);
}

// Writes the variant's workflow onto the branch when it differs, and commits it.
// Returns whether a commit was made.
async function pinVariant(
  deps: SandboxDeps,
  live: Live,
  variant: VariantName,
  ref: string,
): Promise<boolean> {
  const wanted = workflowVariant(variant, ref);
  if ((await deps.workspace.read(live.dir, WORKFLOW_PATH)) === wanted) {
    return false;
  }
  await deps.workspace.write(live.dir, WORKFLOW_PATH, wanted);
  await commitPaths(
    deps,
    live.dir,
    [WORKFLOW_PATH],
    variantMessage(variant, ref),
  );
  return true;
}

function variantMessage(variant: VariantName, ref: string): string {
  return variant === "normal"
    ? `sandbox: pin action to ${ref}`
    : `sandbox: ${variant} variant for ${ref}`;
}

// The comment starts main's workflow, so main must be pinned to the ref under
// test before anything is pushed. Otherwise the review would run a different
// action and report it as this one.
async function requirePinnedMain(
  deps: SandboxDeps,
  dir: string,
  ref: string,
): Promise<void> {
  if ((await deps.workspace.read(dir, WORKFLOW_PATH)) !== workflowFor(ref)) {
    throw new Error(
      `main's workflow is not pinned to ${ref}, and a comment run uses main's workflow; ` +
        `run \`bun scripts/sandbox.ts init --ref ${ref}\` first`,
    );
  }
}

// Plain fast-forward pushes only: the rails refuse anything else (rails.ts).
async function pushBranch(deps: SandboxDeps, live: Live): Promise<void> {
  // Recorded before the push: a push that fails after the branch was created
  // still has to be cleaned up.
  live.pushed = true;
  await git(deps, live.dir, ["push", "-u", "origin", live.branch]);
  live.headSha = (await git(deps, live.dir, ["rev-parse", "HEAD"])).trim();
}

async function openPr(deps: SandboxDeps, live: Live): Promise<ScenarioPr> {
  const out = await ghOk(deps, [
    "pr",
    "create",
    "-R",
    SANDBOX_REPO,
    "--base",
    "main",
    "--head",
    live.branch,
    "--title",
    `pr-hero sandbox ${live.scenario} ${live.branch}`,
    "--body",
    `Scenario PR from pr-hero's sandbox runner (\`bun scripts/sandbox.ts run ${live.scenario}\`). ` +
      "It is closed by the runner unless --keep was given.",
  ]);
  const url = out.trim().split("\n").at(-1) ?? "";
  const match = /\/pull\/(\d+)$/.exec(url);
  if (match === null)
    throw new Error(`gh pr create printed no PR URL: ${out.trim()}`);
  const pr: ScenarioPr = {
    number: Number(match[1]),
    headRefName: live.branch,
    url,
  };
  live.pr = pr;
  return pr;
}

function requirePr(live: Live): ScenarioPr {
  if (live.pr === undefined)
    throw new Error("the scenario PR does not exist yet");
  return live.pr;
}

function pollTiming(options: RunOptions): PollTiming {
  return {
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function cancelTiming(options: RunOptions): PollTiming {
  return {
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.cancelWaitMs ?? DEFAULT_CANCEL_WAIT_MS,
  };
}

// Polls for the run the phase waits for, until it completes or the deadline
// passes. The run is recorded on the scenario as each poll sees it, so cleanup can
// stop it even when the wait is interrupted. The run last seen comes back with
// `completed` false on the deadline, so the report still shows what the PR looked
// like when the runner gave up.
async function waitForRun(
  deps: SandboxDeps,
  live: Live,
  phase: Phase,
  options: RunOptions,
  interrupts: Interrupts,
): Promise<{ completed: boolean; run?: RunListItem }> {
  const polled = await pollUntil(
    deps,
    interrupts,
    pollTiming(options),
    async () => {
      const run =
        phase.wait === "pull_request"
          ? await findPullRequestRun(deps, live)
          : await findCommentRun(deps, live);
      if (run !== undefined) {
        live.inFlight = {
          databaseId: run.databaseId,
          completed: run.status === "completed",
        };
      }
      return run;
    },
    (run) => run.status === "completed",
  );
  return { completed: polled.done, run: polled.last };
}

// The pull_request run of this head. Matched by head sha, so a stale run on an
// earlier head is never read as this one.
async function findPullRequestRun(
  deps: SandboxDeps,
  live: Live,
): Promise<RunListItem | undefined> {
  const runs = await ghJson<RunListItem[]>(deps, [
    "run",
    "list",
    "-R",
    SANDBOX_REPO,
    "--branch",
    live.branch,
    "--event",
    "pull_request",
    "--limit",
    "20",
    "--json",
    RUN_FIELDS,
  ]);
  return runs.find(
    (r) => r.headSha === live.headSha && r.workflowName === WORKFLOW_NAME,
  );
}

// The issue_comment run of the comment. It runs main's workflow, so its head is
// main's and it names no PR branch: it is found as the one run that appeared
// after the comment was posted, not by branch or head sha.
async function findCommentRun(
  deps: SandboxDeps,
  live: Live,
): Promise<RunListItem | undefined> {
  if (live.commentRunsBefore === undefined) {
    throw new Error("waiting for a comment run before any comment was posted");
  }
  const before = live.commentRunsBefore;
  const fresh = (await listCommentRuns(deps)).filter(
    (r) => !before.has(r.databaseId) && r.workflowName === WORKFLOW_NAME,
  );
  if (fresh.length > 1) {
    throw new Unrecoverable(
      `${fresh.length} new issue_comment runs appeared, so the comment run is ambiguous`,
    );
  }
  return fresh[0];
}

async function listCommentRuns(deps: SandboxDeps): Promise<RunListItem[]> {
  return ghJson<RunListItem[]>(deps, [
    "run",
    "list",
    "-R",
    SANDBOX_REPO,
    "--event",
    "issue_comment",
    "--limit",
    "50",
    "--json",
    RUN_FIELDS,
  ]);
}

// Reads the observables of the phase. Each source is a separate call, so a failure
// in one is an error for the whole scenario, not a silently empty field.
async function collect(deps: SandboxDeps, live: Live): Promise<Observation> {
  const pr = requirePr(live);
  const headSha = live.headSha;
  if (headSha === undefined)
    throw new Error("the branch has no head to observe");
  const run = live.run;
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
  const runFact: RunFact | undefined =
    run === undefined || runView === undefined
      ? undefined
      : {
          id: run.databaseId,
          event: run.event,
          status: runView.status,
          conclusion: runView.conclusion,
          steps: runView.jobs.flatMap((j) => j.steps),
        };
  return {
    prNumber: pr.number,
    prUrl: pr.url,
    headSha,
    run: runFact,
    status:
      latest === undefined
        ? undefined
        : { state: latest.state, description: latest.description },
    comments,
    artifacts,
  };
}

// Cleanup. --keep leaves the PR in place and says where it is. Otherwise a run
// still in flight is cancelled and waited on first, and only then is the PR closed
// with its branch, or a branch with no PR is deleted. A failure here is returned,
// so the scenario exits 1: a PR left open breaks serialization.
async function finish(
  deps: SandboxDeps,
  live: Live,
  options: RunOptions,
): Promise<string | undefined> {
  if (options.keep) {
    if (live.pushed) {
      deps.log(
        `kept: ${live.pr?.url ?? "no PR"} on ${live.branch} (clean with \`bun scripts/sandbox.ts clean\`)`,
      );
    }
    return undefined;
  }
  try {
    const inFlight = live.inFlight;
    if (inFlight !== undefined && !inFlight.completed) {
      const stopped = await stopRun(
        deps,
        inFlight.databaseId,
        cancelTiming(options),
      );
      if (!stopped) {
        const message = `left open: run ${inFlight.databaseId} has not completed after the cancel; its PR stays open until the run ends (then clean)`;
        deps.log(message);
        return message;
      }
    }
    if (live.pr !== undefined) {
      deps.log(`closing ${live.pr.url} and deleting ${live.branch}`);
      await closeScenarioPr(deps, live.pr);
    } else if (live.pushed) {
      deps.log(`deleting ${live.branch}`);
      await deleteScenarioBranch(deps, live.branch);
    }
    return undefined;
  } catch (error) {
    const message = `cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    deps.log(message);
    return message;
  }
}

// Cancels a run that is not known to be completed, then waits for it to report
// completed within the cancel deadline. Returns whether it completed. A run that
// already completed is left alone, so nothing is cancelled for nothing.
async function stopRun(
  deps: SandboxDeps,
  runId: number,
  timing: PollTiming,
): Promise<boolean> {
  if ((await runStatus(deps, runId)) === "completed") return true;
  deps.log(`cancelling run ${runId}`);
  await ghOk(deps, ["run", "cancel", String(runId), "-R", SANDBOX_REPO]);
  // No interrupts here: a second signal must not cut the cancel short.
  const after = await pollUntil(
    deps,
    undefined,
    timing,
    () => runStatus(deps, runId),
    (status) => status === "completed",
  );
  return after.done;
}

async function runStatus(deps: SandboxDeps, runId: number): Promise<string> {
  const view = await ghJson<{ status: string }>(deps, [
    "run",
    "view",
    String(runId),
    "-R",
    SANDBOX_REPO,
    "--json",
    "status",
  ]);
  return view.status;
}
