// smoke: one planted-bug PR through the free route, end to end, then cleanup.
//
// The PR is opened from a branch off main that pins the same action ref as the
// workflow it runs under, so the run exercises the ref under test and nothing
// else. The run is found by head sha (not by "latest"), because a stale run on
// an earlier head must never be read as this one. Whatever happens after the PR
// exists, cleanup runs in a finally: a scenario PR is never left open by accident
// unless --keep asked for it. Cleanup is also where a run still in flight is
// stopped: it is cancelled and waited on before its PR may close, so the
// serialization lock is never released while the review keeps running. A run the
// poll never saw is looked for on the scenario's branch first, because its
// `opened` event may have queued it after the scenario stopped looking.

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
// How long cleanup looks for a run it has no record of. The `opened` event queues
// the run asynchronously, so it can appear a while after the PR exists, or after
// a `gh pr create` that reported failure.
export const ORPHAN_LOOKUP_MS = 60_000;
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
  // The head pushed, once the push is confirmed. Cleanup looks for its run when
  // the poll never recorded one.
  headSha?: string;
  pr?: ScenarioPr;
  // The head's run as last seen. Cleanup cancels it unless it was seen completed.
  run?: { databaseId: number; completed: boolean };
}

// How cleanup ended. `failed` is an error, or a run left open after its cancel.
// `abandoned` is a second signal that ended the cleanup waits; it names the
// signal and whether a PR was left open with what it left behind.
type Cleanup =
  | { outcome: "done" }
  | { outcome: "failed" }
  | { outcome: "abandoned"; prOpen: boolean; signal: Signal };

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
  // Installed for the scenario and its cleanup. The first signal ends the work at
  // its next wait or call; a second one, during cleanup, ends cleanup's waits.
  const interrupts = watchInterrupts(deps.signals, deps.log);
  let scenarioCode: 0 | 1 = 1;
  let interruptedBy: Signal | undefined;
  let cleanup: Cleanup = { outcome: "done" };
  try {
    scenarioCode = await runScenario(
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
    // Only a signal that arrived before this point interrupted the scenario.
    interruptedBy = interrupts.endScenario();
    cleanup = await finish(deps, scenario, options, interrupts);
    interrupts.dispose();
    await deps.workspace.remove(dir).catch(() => undefined);
  }
  return resultCode(cleanup, interruptedBy, scenarioCode);
}

// The exit code, by precedence. A cleanup that failed, or left a PR open, is 1
// whatever else happened. Then a signal that interrupted the scenario gives its
// code, so a signal never turns a failed cleanup into a clean-looking exit. Only
// otherwise does the scenario's own result stand. An abandoned cleanup with its PR
// already closed exits with the code of the signal that abandoned it.
function resultCode(
  cleanup: Cleanup,
  interruptedBy: Signal | undefined,
  scenarioCode: 0 | 1,
): number {
  if (cleanup.outcome === "failed") return 1;
  if (cleanup.outcome === "abandoned") {
    return cleanup.prOpen ? 1 : SIGNAL_EXIT_CODES[cleanup.signal];
  }
  if (interruptedBy !== undefined) return SIGNAL_EXIT_CODES[interruptedBy];
  return scenarioCode;
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
  const headSha = (await git(deps, dir, ["rev-parse", "HEAD"])).trim();
  // Recorded once the push is confirmed: cleanup looks for a run of this head
  // even when no PR was ever created for it.
  scenario.headSha = headSha;
  return headSha;
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
    interrupts.scenario,
    timing,
    async () => {
      const runs = await listBranchRuns(deps, branch);
      const run = runs.find((r) => r.headSha === headSha);
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

// The runs of the workflow on a branch. A scenario branch is created by one run
// and never reused, so every workflow run on it belongs to that scenario.
async function listBranchRuns(
  deps: SandboxDeps,
  branch: string,
): Promise<RunListItem[]> {
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
  return runs.filter((r) => r.workflowName === WORKFLOW_NAME);
}

// Cleanup. --keep leaves everything in place and says where it is. Otherwise every
// run of the head that may still be going is cancelled and waited on first, and
// only a completed run's PR is closed, with its branch. A branch with no PR is
// deleted. A failure here, or a run left open, makes the exit 1, because a
// scenario PR left open breaks serialization.
async function finish(
  deps: SandboxDeps,
  scenario: Scenario,
  options: SmokeOptions,
  interrupts: Interrupts,
): Promise<Cleanup> {
  if (options.keep) {
    if (scenario.pushed) {
      deps.log(
        `kept: ${scenario.pr?.url ?? "no PR"} on ${scenario.branch} (clean with \`bun scripts/sandbox.ts clean\`)`,
      );
    }
    return { outcome: "done" };
  }
  let runIds: number[] = [];
  try {
    runIds = await runsToStop(deps, scenario, options, interrupts.cleanup);
    for (const runId of runIds) {
      const stopped = await stopRun(
        deps,
        runId,
        cancelTiming(options),
        interrupts.cleanup,
      );
      if (!stopped) {
        deps.log(
          `left open: run ${runId} has not completed after the cancel; its PR stays open until the run ends (then clean)`,
        );
        return { outcome: "failed" };
      }
    }
    if (scenario.pr !== undefined) {
      deps.log(`closing ${scenario.pr.url} and deleting ${scenario.branch}`);
      await closeScenarioPr(deps, scenario.pr);
    } else if (scenario.pushed) {
      deps.log(`deleting ${scenario.branch}`);
      await deleteScenarioBranch(deps, scenario.branch);
    }
    return { outcome: "done" };
  } catch (error) {
    if (error instanceof Interrupted) {
      deps.log(
        `left open: the cleanup wait was abandoned by a second ${error.signal}. Still open: ${leftOpen(scenario, runIds)}. Run \`bun scripts/sandbox.ts clean\` to close them.`,
      );
      return {
        outcome: "abandoned",
        prOpen: scenario.pr !== undefined,
        signal: error.signal,
      };
    }
    deps.log(
      `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { outcome: "failed" };
  }
}

// What cleanup may still have open, for the operator to close with `clean`.
function leftOpen(scenario: Scenario, runIds: readonly number[]): string {
  const items: string[] = [];
  if (scenario.pr !== undefined) items.push(scenario.pr.url);
  if (scenario.pushed) items.push(`branch ${scenario.branch}`);
  if (runIds.length > 0) {
    for (const id of runIds) items.push(`run ${id}`);
  } else if (
    scenario.run === undefined &&
    (scenario.pr !== undefined || scenario.headSha !== undefined)
  ) {
    items.push(`any run on ${scenario.branch}`);
  }
  return items.join(", ");
}

// The runs cleanup must cancel. A run on record decides it. Without one, a PR or
// a pushed head may still have a run that its `opened` event queued, so the
// branch is looked up for it.
async function runsToStop(
  deps: SandboxDeps,
  scenario: Scenario,
  options: SmokeOptions,
  stop: Stop,
): Promise<number[]> {
  if (scenario.run !== undefined) {
    return scenario.run.completed ? [] : [scenario.run.databaseId];
  }
  if (scenario.pr === undefined && scenario.headSha === undefined) return [];
  return findOrphanRuns(deps, scenario.branch, options, stop);
}

// Looks for a run on the branch that is not completed, and returns the ids as soon
// as one is seen. When none appears within the bound, that is reported and cleanup
// goes on, so the PR still closes.
async function findOrphanRuns(
  deps: SandboxDeps,
  branch: string,
  options: SmokeOptions,
  stop: Stop,
): Promise<number[]> {
  const found = await pollUntil(
    deps,
    stop,
    { ...pollTiming(options), timeoutMs: ORPHAN_LOOKUP_MS },
    async () =>
      (await listBranchRuns(deps, branch))
        .filter((r) => r.status !== "completed")
        .map((r) => r.databaseId),
    (ids) => ids.length > 0,
  );
  if (found.done) return found.last ?? [];
  deps.log(
    `no run on ${branch} appeared within ${ORPHAN_LOOKUP_MS / 1000}s; nothing to cancel`,
  );
  return [];
}

// Cancels a run that is not known to be completed, then waits for it to report
// completed within the cancel deadline. Returns whether it completed. Every read
// and the cancel go through the poll's tolerance, so one transient gh error is a
// retry, not a failed cleanup. A run that completed before the cancel, or while
// gh refused it, is done, not a failure.
async function stopRun(
  deps: SandboxDeps,
  runId: number,
  timing: PollTiming,
  stop: Stop,
): Promise<boolean> {
  let cancelled = false;
  const settled = await pollUntil(
    deps,
    stop,
    timing,
    async () => {
      if ((await runStatus(deps, runId)) === "completed") return true;
      if (!cancelled) {
        deps.log(`cancelling run ${runId}`);
        await cancelRun(deps, runId);
        cancelled = true;
      }
      return false;
    },
    (completed) => completed,
  );
  return settled.done;
}

// Sends the cancel. gh refuses to cancel a run that has completed, which is the
// outcome cleanup was after, so that refusal is not an error. Any other refusal is,
// and the caller's poll retries it.
async function cancelRun(deps: SandboxDeps, runId: number): Promise<void> {
  const result = await deps.gh([
    "run",
    "cancel",
    String(runId),
    "-R",
    SANDBOX_REPO,
  ]);
  if (result.exitCode === 0) return;
  if ((await runStatus(deps, runId)) === "completed") return;
  throw new Error(`gh run cancel ${runId} failed: ${result.stderr.trim()}`);
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
// last value seen, so the caller still learns about a run seen earlier. A stop
// that fires ends the wait at once, whether it is asleep or about to read.
async function pollUntil<T>(
  deps: SandboxDeps,
  stop: Stop | undefined,
  timing: PollTiming,
  read: () => Promise<T | undefined>,
  done: (value: T) => boolean,
): Promise<{ done: boolean; last?: T }> {
  const deadline = deps.clock.now().getTime() + timing.timeoutMs;
  let last: T | undefined;
  let failures = 0;
  for (;;) {
    throwIfStopped(stop);
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
    await sleepUnlessStopped(deps.clock, timing.intervalMs, stop);
  }
}

// ---------------------------------------------------------------------------
// Interrupts. The first SIGINT or SIGTERM ends the scenario's waits and work at
// once, and cleanup runs as after a normal end. A second signal ends cleanup's
// waits too: cleanup then reports what it may have left open and gives up. The
// handlers are installed for the run only and removed after it.
// ---------------------------------------------------------------------------

class Interrupted extends Error {
  constructor(readonly signal: Signal) {
    super(`interrupted by ${signal}`);
    this.name = "Interrupted";
  }
}

// What a wait listens to: the signal that ends it, and the promise that wakes a
// sleep in progress at that same moment.
interface Stop {
  signal(): Signal | undefined;
  readonly wake: Promise<never>;
}

export interface Interrupts {
  // Ends the scenario. Its first signal is the one that interrupts it.
  readonly scenario: Stop;
  // Ends cleanup's waits. Its second signal is the one that abandons them.
  readonly cleanup: Stop;
  // Marks the end of the scenario and returns the signal that interrupted it, if
  // any. Signals received after this arrived during cleanup.
  endScenario(): Signal | undefined;
  dispose(): void;
}

export function watchInterrupts(
  source: SignalSource,
  log: (line: string) => void,
): Interrupts {
  const received: Signal[] = [];
  let cleanupBegun = false;
  let wakeScenario!: (error: Error) => void;
  let wakeCleanup!: (error: Error) => void;
  const scenarioWake = new Promise<never>((_, reject) => {
    wakeScenario = reject;
  });
  const cleanupWake = new Promise<never>((_, reject) => {
    wakeCleanup = reject;
  });
  // Nobody may be waiting when a signal lands; that must not be an unhandled rejection.
  scenarioWake.catch(() => undefined);
  cleanupWake.catch(() => undefined);
  const installed = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => {
      received.push(signal);
      if (received.length === 1) {
        // A first signal during cleanup finds the scenario already over, so it
        // leaves the exit code alone. It is reported, not acted on.
        log(
          cleanupBegun
            ? `${signal} received during cleanup: the scenario had already ended, so it does not change the exit code`
            : `${signal} received: stopping the scenario and cleaning up`,
        );
        wakeScenario(new Interrupted(signal));
      } else if (received.length === 2) {
        log(`${signal} received again: abandoning the cleanup wait`);
        wakeCleanup(new Interrupted(signal));
      }
    };
    source.on(signal, handler);
    return { signal, handler };
  });
  return {
    scenario: { signal: () => received[0], wake: scenarioWake },
    cleanup: { signal: () => received[1], wake: cleanupWake },
    endScenario: () => {
      cleanupBegun = true;
      return received[0];
    },
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
      throwIfStopped(interrupts.scenario);
      return deps.gh(args);
    },
    git: async (args, cwd) => {
      throwIfStopped(interrupts.scenario);
      return deps.git(args, cwd);
    },
  };
}

function throwIfStopped(stop: Stop | undefined): void {
  const signal = stop?.signal();
  if (signal !== undefined) throw new Interrupted(signal);
}

function sleepUnlessStopped(
  clock: SandboxDeps["clock"],
  ms: number,
  stop: Stop | undefined,
): Promise<void> {
  return stop === undefined
    ? clock.sleep(ms)
    : Promise.race([stop.wake, clock.sleep(ms)]);
}
