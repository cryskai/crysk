// Waiting on the workflow runs of a scenario: the polls that read them, the cancel
// that stops one still going, and the lookup for a run the poll never saw. The
// scenario runner and `clean` both stop runs this way, so the logic lives here once,
// together with the poll and the interrupt types they share. It is a module of its
// own because clean (pr.ts) cannot import scenario.ts, which imports pr.ts.

import { WORKFLOW_NAME } from "./markers";
import { COMMENT_RUN_CLOCK_SKEW_MS } from "./observe";
import type { SandboxDeps, Signal } from "./ports";
import { SANDBOX_REPO } from "./rails";
import { ghJson } from "./repo";

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
// How long a phase waits for its run (2700 s). WHY 45 minutes: a live free-model review
// once took 24m36s, and at the old 25-minute ceiling it was cancelled just before it
// finished. The workflow's own ceiling is 90 minutes, so 45 still leaves room for a slow
// review; a run still going at this deadline is cancelled and reported as timed out.
export const DEFAULT_TIMEOUT_MS = 45 * 60_000;
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

// The timing knobs a runner accepts, for its waits and for tests to shorten them.
// Smoke's options carry the same three fields, so they pass through unchanged.
export interface RunTiming {
  pollIntervalMs?: number;
  timeoutMs?: number;
  cancelWaitMs?: number;
}

export interface RunListItem {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  workflowName: string;
  url: string;
  event?: string;
  // The run's title, which for a PR-triggered run is the PR's title. A comment run
  // shows the title of the PR it was started on.
  displayTitle: string;
  createdAt: string;
}

export const RUN_FIELDS =
  "databaseId,headSha,status,conclusion,workflowName,url,event,displayTitle,createdAt";

export interface PollTiming {
  intervalMs: number;
  timeoutMs: number;
}

// The error a poll must not retry: the read found something it cannot decide,
// such as an ambiguous run, and another identical read would not decide it.
export class Unrecoverable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unrecoverable";
  }
}

export class Interrupted extends Error {
  constructor(readonly signal: Signal) {
    super(`interrupted by ${signal}`);
    this.name = "Interrupted";
  }
}

// What a wait listens to: the signal that ends it, and the promise that wakes a
// sleep in progress at that same moment.
export interface Stop {
  signal(): Signal | undefined;
  readonly wake: Promise<never>;
}

export function throwIfStopped(stop: Stop | undefined): void {
  const signal = stop?.signal();
  if (signal !== undefined) throw new Interrupted(signal);
}

// Which runs belong to one scenario PR. Its pull_request runs are on its branch. Its
// issue_comment runs are on main and name no branch, so they are matched by the PR's
// title, which is unique to one scenario branch, and by creation time: a run created
// before the PR, less the skew, cannot be one of its runs.
export interface RunScope {
  branch: string;
  title: string;
  // When GitHub created the PR. Undefined before a PR is open: no comment run can
  // exist then, so only the branch is read.
  prCreatedAtMs?: number;
  // When the scenario started (its push, or the PR's creation for a PR listed later).
  // It stands in for the PR's creation while the PR does not exist yet.
  startedAtMs: number;
}

// The runs of the workflow on a branch. A scenario branch is created by one run
// and never reused, so every workflow run on it belongs to that scenario.
export async function listBranchRuns(
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
    RUN_FIELDS,
  ]);
  return runs.filter((r) => r.workflowName === WORKFLOW_NAME);
}

// The issue_comment runs of the workflow, newest first. A comment run is on main, so
// the caller matches it to its PR with isPrCommentRun.
export async function listCommentRuns(
  deps: SandboxDeps,
): Promise<RunListItem[]> {
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

// Whether a comment run belongs to the PR with this title, created at or after
// `sinceMs` (less the clock skew between this machine and GitHub's run times).
export function isPrCommentRun(
  run: RunListItem,
  title: string,
  sinceMs: number,
): boolean {
  return (
    run.workflowName === WORKFLOW_NAME &&
    run.displayTitle === title &&
    Date.parse(run.createdAt) >= sinceMs - COMMENT_RUN_CLOCK_SKEW_MS
  );
}

// Every run of the PR, in any state: its pull_request runs and its matching comment
// runs. The one lookup both the scenario's cleanup and `clean` use, so a run that
// only one of them could see is not missed by the other.
export async function listPrRuns(
  deps: SandboxDeps,
  scope: RunScope,
): Promise<RunListItem[]> {
  const onBranch = await listBranchRuns(deps, scope.branch);
  const since = scope.prCreatedAtMs;
  if (since === undefined) return onBranch;
  const comments = (await listCommentRuns(deps)).filter((r) =>
    isPrCommentRun(r, scope.title, since),
  );
  return [...onBranch, ...comments];
}

// The ids of the PR's runs that are not completed, which cleanup must cancel. A run
// the `opened` event queues can appear a while after the PR exists, so while the PR is
// fresh (or, before it exists, the scenario's push), this polls until the lookup
// window closes. An old PR gets one read, and that read's failure is thrown: a cleanup
// that cannot read the runs must not take their absence for granted.
export async function findLiveRuns(
  deps: SandboxDeps,
  scope: RunScope,
  poll: PollTiming,
  stop: Stop | undefined,
): Promise<number[]> {
  const read = async () =>
    (await listPrRuns(deps, scope))
      .filter((r) => r.status !== "completed")
      .map((r) => r.databaseId);
  const ageMs =
    deps.clock.now().getTime() - (scope.prCreatedAtMs ?? scope.startedAtMs);
  const windowMs = ORPHAN_LOOKUP_MS - ageMs;
  // A NaN age (a creation time GitHub did not report) is not fresh either.
  if (!(windowMs > 0)) return read();
  const found = await pollUntil(
    deps,
    stop,
    { ...poll, timeoutMs: windowMs },
    read,
    (ids) => ids.length > 0,
  );
  if (found.done) return found.last ?? [];
  deps.log(
    `no run on ${scope.branch} appeared within ${Math.round(windowMs / 1000)}s; nothing to cancel`,
  );
  return [];
}

// Cancels a run that is not known to be completed, then waits for it to report
// completed within the cancel deadline. Returns whether it completed. Every read
// and the cancel go through the poll's tolerance, so one transient gh error is a
// retry, not a failed cleanup. A run that completed before the cancel, or while
// gh refused it, is done, not a failure.
export async function stopRun(
  deps: SandboxDeps,
  runId: number,
  timing: PollTiming,
  stop: Stop | undefined,
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
export async function cancelRun(
  deps: SandboxDeps,
  runId: number,
): Promise<void> {
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

export function pollTiming(options: RunTiming): PollTiming {
  return {
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export function cancelTiming(options: RunTiming): PollTiming {
  return {
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.cancelWaitMs ?? DEFAULT_CANCEL_WAIT_MS,
  };
}

// Calls `read` until `done` accepts its value, sleeping between tries. A failed
// read is one miss: only MAX_CONSECUTIVE_POLL_FAILURES in a row end the poll, and
// the last error is thrown then. A read that finds nothing does not reset the
// last value seen, so the caller still learns about a run seen earlier. A stop
// that fires ends the wait at once, whether it is asleep or about to read, and an
// Unrecoverable read is not retried: another identical read would decide nothing.
export async function pollUntil<T>(
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
      if (error instanceof Interrupted || error instanceof Unrecoverable) {
        throw error;
      }
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

function sleepUnlessStopped(
  clock: SandboxDeps["clock"],
  ms: number,
  stop: Stop | undefined,
): Promise<void> {
  return stop === undefined
    ? clock.sleep(ms)
    : Promise.race([stop.wake, clock.sleep(ms)]);
}
