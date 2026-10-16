// smoke: one planted-bug PR through the free route, end to end, then cleanup.
//
// The PR is opened from a branch off main that pins the same action ref as the
// workflow it runs under, so the run exercises the ref under test and nothing
// else. The run is found by head sha (not by "latest"), because a stale run on
// an earlier head must never be read as this one. Whatever happens after the PR
// exists, cleanup runs in a finally: a scenario PR is never left open by accident
// unless --keep asked for it. Cleanup is also where a run still in flight is
// stopped: it is cancelled and waited on before its PR may close, so the
// serialization lock is never released while the review keeps running.

import { STATUS_CONTEXT, WORKFLOW_NAME } from "./markers";
import {
  type CommentFact,
  classifyComment,
  classifyPath,
  exitCodeFor,
  invariantViolations,
  type Observation,
} from "./observe";
import type { SandboxDeps, Signal, SignalSource } from "./ports";
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
// How long cleanup waits for a cancelled run to report completed. The workflow's
// own ceiling is 90 minutes, so a run still going past this is left to finish
// on its own, and its PR stays open until it does.
export const DEFAULT_CANCEL_WAIT_MS = 10 * 60_000;
// Consecutive failed reads before a poll gives up. One transient gh error must
// not tear the PR down while the run is in flight.
export const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const SIGNAL_EXIT_CODES: Record<Signal, number> = { SIGINT: 130, SIGTERM: 143 };

export interface SmokeOptions {
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
}

interface Scenario {
  branch: string;
  pushed: boolean;
  pr?: ScenarioPr;
  // The head's run as last seen. Cleanup cancels it unless it was seen completed.
  run?: { databaseId: number; completed: boolean };
}

interface PollTiming {
  intervalMs: number;
  timeoutMs: number;
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
  // Installed for the scenario only. A signal ends the work at its next wait or
  // call, and the finally below runs the same cleanup as a normal end.
  const interrupts = watchInterrupts(deps.signals, deps.log);
  let exitCode: 0 | 1 = 1;
  try {
    exitCode = await runScenario(
      stopAfterInterrupt(deps, interrupts),
      scenario,
      dir,
      options,
      interrupts,
    );
  } catch (error) {
    // An interrupt is logged by its handler; anything else is a failed step.
    if (!(error instanceof Interrupted)) {
      deps.log(
        `smoke stopped early: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    exitCode = await finish(deps, scenario, options, exitCode);
    interrupts.dispose();
    await deps.workspace.remove(dir).catch(() => undefined);
  }
  const signal = interrupts.received();
  return signal === undefined ? exitCode : SIGNAL_EXIT_CODES[signal];
}

async function runScenario(
  deps: SandboxDeps,
  scenario: Scenario,
  dir: string,
  options: SmokeOptions,
  interrupts: Interrupts,
): Promise<0 | 1> {
  await cloneSandbox(deps, dir);
  const headSha = await pushScenario(deps, dir, scenario, options.ref);
  const pr = await openPr(deps, scenario);
  deps.log(`PR: ${pr.url}`);

  const timing = pollTiming(options);
  const polled = await waitForRun(
    deps,
    scenario,
    interrupts,
    headSha,
    scenario.branch,
    timing,
  );
  if (!polled.completed) {
    deps.log(
      `timed out after ${Math.round(timing.timeoutMs / 1000)}s waiting for the run`,
    );
  }
  const observed = await collect(deps, pr, headSha, polled.run);
  const path = polled.completed ? classifyPath(observed) : "timed-out";
  const violations = invariantViolations(observed);
  const exitCode = exitCodeFor(path, violations);
  for (const line of renderReport(observed, path, violations, exitCode))
    deps.log(line);
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

// Polls for the run of this head until it completes, or the deadline passes. The
// run is recorded on the scenario as it is seen, so cleanup can stop it even when
// the poll itself is interrupted. On the deadline the run last seen is returned
// as not completed, and the report says the run timed out.
async function waitForRun(
  deps: SandboxDeps,
  scenario: Scenario,
  interrupts: Interrupts,
  headSha: string,
  branch: string,
  timing: PollTiming,
): Promise<{ completed: boolean; run?: RunListItem }> {
  const polled = await pollUntil(
    deps,
    interrupts,
    timing,
    async () => {
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
      if (run !== undefined) {
        scenario.run = {
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

// Cleanup. --keep leaves everything in place and says where it is. Otherwise a run
// still in flight is cancelled and waited on first, and only a completed run's PR
// is closed, with its branch. A branch with no PR is deleted. A failure here turns
// the run into exit 1, because a scenario PR left open breaks serialization.
async function finish(
  deps: SandboxDeps,
  scenario: Scenario,
  options: SmokeOptions,
  exitCode: 0 | 1,
): Promise<0 | 1> {
  if (options.keep) {
    if (scenario.pushed) {
      deps.log(
        `kept: ${scenario.pr?.url ?? "no PR"} on ${scenario.branch} (clean with \`bun scripts/sandbox.ts clean\`)`,
      );
    }
    return exitCode;
  }
  try {
    if (scenario.run !== undefined && !scenario.run.completed) {
      const stopped = await stopRun(
        deps,
        scenario.run.databaseId,
        cancelTiming(options),
      );
      if (!stopped) {
        deps.log(
          `left open: run ${scenario.run.databaseId} has not completed after the cancel; its PR stays open until the run ends (then clean)`,
        );
        return 1;
      }
    }
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

function pollTiming(options: SmokeOptions): PollTiming {
  return {
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function cancelTiming(options: SmokeOptions): PollTiming {
  return {
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.cancelWaitMs ?? DEFAULT_CANCEL_WAIT_MS,
  };
}

// Calls `read` until `done` accepts its value, sleeping between tries. A failed
// read is one miss: only MAX_CONSECUTIVE_POLL_FAILURES in a row end the poll, and
// the last error is thrown then. A read that finds nothing does not reset the
// last value seen, so the caller still learns about a run seen earlier.
async function pollUntil<T>(
  deps: SandboxDeps,
  interrupts: Interrupts | undefined,
  timing: PollTiming,
  read: () => Promise<T | undefined>,
  done: (value: T) => boolean,
): Promise<{ done: boolean; last?: T }> {
  const deadline = deps.clock.now().getTime() + timing.timeoutMs;
  let last: T | undefined;
  let failures = 0;
  for (;;) {
    throwIfInterrupted(interrupts);
    try {
      const value = await read();
      failures = 0;
      if (value !== undefined) {
        last = value;
        if (done(value)) return { done: true, last };
      }
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
      deps.log(
        `poll read failed (${failures} of ${MAX_CONSECUTIVE_POLL_FAILURES}), retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (deps.clock.now().getTime() >= deadline) return { done: false, last };
    await sleepUnlessInterrupted(deps.clock, timing.intervalMs, interrupts);
  }
}

// ---------------------------------------------------------------------------
// Interrupts. A SIGINT or SIGTERM during a scenario is not an exit: it ends the
// waits and the work at once, and the finally runs the cleanup a normal end runs.
// The handlers are installed for the scenario only and removed after it.
// ---------------------------------------------------------------------------

class Interrupted extends Error {
  constructor(readonly signal: Signal) {
    super(`interrupted by ${signal}`);
    this.name = "Interrupted";
  }
}

export interface Interrupts {
  // Rejects when a signal arrives, so a sleep in progress wakes at once.
  readonly interrupted: Promise<never>;
  received(): Signal | undefined;
  dispose(): void;
}

export function watchInterrupts(
  source: SignalSource,
  log: (line: string) => void,
): Interrupts {
  let received: Signal | undefined;
  let reject!: (error: Error) => void;
  const interrupted = new Promise<never>((_, rej) => {
    reject = rej;
  });
  // Nobody may be waiting when a signal lands; that must not be an unhandled rejection.
  interrupted.catch(() => undefined);
  const installed = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => {
      if (received !== undefined) return;
      received = signal;
      log(`${signal} received: stopping the scenario and cleaning up`);
      reject(new Interrupted(signal));
    };
    source.on(signal, handler);
    return { signal, handler };
  });
  return {
    interrupted,
    received: () => received,
    dispose: () => {
      for (const { signal, handler } of installed) source.off(signal, handler);
    },
  };
}

// The work after a signal makes no new call, so nothing is created once cleanup
// has begun: a PR opened after the close would be left behind.
function stopAfterInterrupt(
  deps: SandboxDeps,
  interrupts: Interrupts,
): SandboxDeps {
  return {
    ...deps,
    gh: async (args) => {
      throwIfInterrupted(interrupts);
      return deps.gh(args);
    },
    git: async (args, cwd) => {
      throwIfInterrupted(interrupts);
      return deps.git(args, cwd);
    },
  };
}

function throwIfInterrupted(interrupts: Interrupts | undefined): void {
  const signal = interrupts?.received();
  if (signal !== undefined) throw new Interrupted(signal);
}

function sleepUnlessInterrupted(
  clock: SandboxDeps["clock"],
  ms: number,
  interrupts: Interrupts | undefined,
): Promise<void> {
  return interrupts === undefined
    ? clock.sleep(ms)
    : Promise.race([interrupts.interrupted, clock.sleep(ms)]);
}
