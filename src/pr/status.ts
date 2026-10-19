import { postCommitStatus } from "#pr/pr";
import {
  CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
  type commitStatusRequest,
  type HeldCommitStatusLock,
  settleRequestForCancellation,
} from "#pr/preflight";
import { log } from "#ui/primitives";
import { CliError } from "../errors";

// WHY this module-level state exists (paid for on PR #162, 2026-09-01): a run
// cancelled by the workflow's `cancel-in-progress` concurrency group posted its
// pending on the head it was legitimately reviewing and then never settled it,
// because the SIGTERM/SIGINT handlers end in `process.exit()` — which skips
// reviewPr's `finally`. The next run read that pending back through
// isInFlightCommitStatus, saw a lock younger than the 90-minute TTL, and
// skipped: PR #162 went unreviewed while the `review` job still reported
// success.
//
// The lock cannot tell "another process is working" from "a dead process left
// this behind" — it is a cross-machine TOCTOU guard, not a liveness probe. So
// the fix is on the holder's side: the process that took the lock releases it
// on the way out. This closes the CANCELLATION case, which is by far the most
// common one, because `cancel-in-progress: true` on a head-ref concurrency
// group fires on EVERY push, not only a force-push. A runner that dies with no
// signal at all (hard kill, OOM, a dropped machine) still reaches nothing here
// and remains covered only by the TTL.
//
// Module state, and the same precedent as `unregisterActiveRun(process.pid)`:
// a signal handler installed in runCli cannot see reviewPr's scope, so what it
// needs has to be parked where both can reach it.
let heldLock: HeldCommitStatusLock | null = null;
// When the lock was taken, in ms: the run's own start, which plan.ts reads before the
// pending post and passes in. The override check (teardown.ts, src/ci/override.ts)
// compares it with GitHub's status times, which are server time, so the two differ by
// whatever the runner's clock skew is; the override rule's allowance covers that.
let heldSinceMs: number | null = null;
// Whether this run's own pending status landed (plan.ts passes it with the hold). The
// start above is only a witness while that pending is on the head: when it did not land,
// no pr-hero status vouches for the start, so the override check compares with no
// clock-skew allowance (teardown.ts). Defaults to landed, the case every caller had before
// this flag existed.
let heldPendingLanded = true;

export function holdCommitStatusLock(
  lock: HeldCommitStatusLock,
  nowMs: number = Date.now(),
  pendingLanded: boolean = true,
): void {
  heldLock = lock;
  heldSinceMs = nowMs;
  heldPendingLanded = pendingLanded;
}

export function releaseCommitStatusLock(): void {
  heldLock = null;
  heldSinceMs = null;
  heldPendingLanded = true;
}

export function heldCommitStatusSince(): number | null {
  return heldSinceMs;
}

export function heldCommitStatusPendingLanded(): boolean {
  return heldPendingLanded;
}

export function heldCommitStatusLock(): HeldCommitStatusLock | null {
  return heldLock;
}

// Settles the pending this process is holding, then exits — the caller is a
// signal handler and MUST still reach its `process.exit(code)`.
//
// Take-and-clear BEFORE the await, not after: Actions cancels with SIGINT and
// follows with SIGTERM before the grace period ends, so both handlers can be
// in flight at once and a peek-then-post would settle twice. `post` is a seam
// only so the take-and-clear and the bound below are testable offline.
//
// Every error is swallowed on purpose. Failing to settle leaves us exactly
// where PR #162 left us — never worse — and a throw here would cost the exit
// code the handler owes the runner.
export async function settleHeldCommitStatusOnSignal(
  post: typeof postCommitStatus = postCommitStatus,
): Promise<void> {
  const settle = settleRequestForCancellation(heldLock);
  releaseCommitStatusLock();
  if (settle === null) return;
  try {
    await post(settle.operatorRoot, settle.sha, settle.request, undefined, {
      attempts: 1,
      timeoutMs: CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
    });
  } catch {
    // Ignore
  }
}

// `spawnFn` is the same invisible-to-production seam postCommitStatus
// already accepts (pr.ts's own established pattern): every existing call
// site omits it and gets `Bun.spawn`, exactly as before. It exists so an
// offline test can prove this function's actual swallow-errors behavior —
// a failed `gh` call caught here and logged, never rethrown — instead of
// replacing the whole function with a fake that can only assert it was
// called, not what it really does when gh fails.
//
// Resolves true when the status landed and false when it did not. The swallow is
// unchanged: a caller that ignores the result gets the same posture as before. The
// result exists for the one caller that must act on a failed write, the body-failed
// path in settleCommitStatusAndLedger (src/pr/teardown.ts).
export async function tryPublishCommitStatus(
  operatorRoot: string,
  sha: string,
  request: ReturnType<typeof commitStatusRequest>,
  spawnFn?: typeof Bun.spawn,
  onCreatedAt?: (createdAt: string) => void,
): Promise<boolean> {
  try {
    const createdAt = await postCommitStatus(
      operatorRoot,
      sha,
      request,
      spawnFn,
    );
    if (createdAt !== undefined) onCreatedAt?.(createdAt);
    return true;
  } catch (error) {
    log(
      `warning: commit status (${request.state}): ${(error as Error).message}`,
    );
    return false;
  }
}

// S4, gate mode: the FINAL write does not swallow. In gate the status is the
// required check, so a write that never landed must fail the run (exit 1 and
// an `::error::` annotation, via the CLI's catch) rather than log a warning
// over a head GitHub still shows as pending. The pending write stays
// best-effort in both modes, and advisory keeps tryPublishCommitStatus.
export async function publishFinalCommitStatus(
  operatorRoot: string,
  sha: string,
  request: ReturnType<typeof commitStatusRequest>,
  spawnFn?: typeof Bun.spawn,
): Promise<void> {
  try {
    await postCommitStatus(operatorRoot, sha, request, spawnFn);
  } catch (error) {
    throw new CliError(
      `commit status (${request.state}) was not written, so the required check on this head is not settled: ${(error as Error).message}`,
    );
  }
}
