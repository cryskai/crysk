// Waiting on the workflow runs of a scenario branch: list them, cancel the ones
// still going, and wait for each to report completed. Smoke's cleanup and `clean`
// both stop runs this way, so the logic lives here once. It is a module of its own
// because clean (pr.ts) cannot import smoke.ts, which imports pr.ts.

import { WORKFLOW_NAME } from "./markers";
import type { SandboxDeps, Signal } from "./ports";
import { SANDBOX_REPO } from "./rails";
import { ghJson } from "./repo";

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
}

export interface PollTiming {
  intervalMs: number;
  timeoutMs: number;
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
    "databaseId,headSha,status,conclusion,workflowName,url",
  ]);
  return runs.filter((r) => r.workflowName === WORKFLOW_NAME);
}

// Looks for a run on the branch that is not completed, and returns the ids as soon
// as one is seen. When none appears within the bound, that is reported and cleanup
// goes on, so the PR still closes.
export async function findOrphanRuns(
  deps: SandboxDeps,
  branch: string,
  poll: PollTiming,
  stop: Stop | undefined,
): Promise<number[]> {
  const found = await pollUntil(
    deps,
    stop,
    { ...poll, timeoutMs: ORPHAN_LOOKUP_MS },
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
// that fires ends the wait at once, whether it is asleep or about to read.
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

function sleepUnlessStopped(
  clock: SandboxDeps["clock"],
  ms: number,
  stop: Stop | undefined,
): Promise<void> {
  return stop === undefined
    ? clock.sleep(ms)
    : Promise.race([stop.wake, clock.sleep(ms)]);
}
