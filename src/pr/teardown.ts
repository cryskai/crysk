// PR mode's teardown: the two `finally` blocks wrapping reviewPr()'s run.
// Relocated out of reviewPr() (src/pr/review-pr.ts): the ledger-settle check
// duplicated in both finally blocks factored into one shared
// `settleLedgerIfPending` helper (still called from both), identifiers moved
// onto explicit parameters, control flow otherwise unchanged. The WHY
// comments below move with the code they explain.

import type { CiAdmissionLedgerState } from "#pr/admission";
import { settleCiAdmissionLedger } from "#pr/admission";
import type { InlinePostOutcome } from "#pr/inline";
import {
  blockingCommitStatusRequest,
  type CiMode,
  COMMIT_STATUS_CONTEXT,
  type CommitStatusContext,
  commitStatusCompletion,
  commitStatusRequest,
} from "#pr/preflight";
import {
  publishFinalCommitStatus,
  releaseCommitStatusLock,
  tryPublishCommitStatus,
} from "#pr/status";
import type { PipelineResult } from "#review/pipeline";
import { runGc } from "#store/gc";
import { releasePidLock } from "../home";

// The ledger has no equivalent hand-off to the SIGTERM/SIGINT handlers (which
// settle only the commit status, via holdCommitStatusLock). Any throw or
// early return that skipped explicit settlement lands here — checked in BOTH
// finally blocks below, because the outer one must also catch a throw from
// inside the inner finally itself (e.g. settleCiAdmissionLedger rejecting
// after the status publish).
//
// `settle` is a test-only seam (default: the real settleCiAdmissionLedger):
// admission.ts is out of scope for this slice and its ledger persist call
// has no spawnFn of its own, so offline tests inject a fake here instead of
// touching that module. Every production caller omits it.
async function settleLedgerIfPending(
  ciAdmissionLedger: CiAdmissionLedgerState | null,
  settle: typeof settleCiAdmissionLedger = settleCiAdmissionLedger,
): Promise<void> {
  if (
    ciAdmissionLedger !== null &&
    (ciAdmissionLedger.record.status === "reserved" ||
      ciAdmissionLedger.record.status === "provider-started")
  ) {
    await settle(
      ciAdmissionLedger,
      "failed",
      "review path exited without terminal settlement",
    );
  }
}

// The inner `finally`: the commit status must settle BEFORE the lock is
// released, and the lock must be released on every path — throw, early
// return, or normal exit. The release sits in a try/finally around the
// write, so a gate-mode throw (S4, below) still releases it.
//
// Two write paths, one per mode. Advisory uses tryPublishCommitStatus, which
// swallows a failed gh post: that is today's posture, and a failed write
// there only logs. Gate uses publishFinalCommitStatus, which rethrows. The
// status is the required check in gate, so a write that never landed must
// fail the run, and the throw reaches the CLI's catch as exit 1 with an
// `::error::` annotation. The throw skips the ledger settle below, and
// finalizePrReviewRun (the outer finally) settles that reservation instead.
//
// `spawnFn` threads into the write (status.ts's own seam, invisible to
// production), so a test can prove the real `gh` boundary: a failed gh post
// still lets this function release the lock and settle the ledger in
// advisory, and a gate write that really fails throws only after the release.
// `settle` stays a whole-function seam (default: the real
// settleCiAdmissionLedger): admission.ts is out of scope for this slice and
// its ledger persist call has no spawnFn of its own.
export async function settleCommitStatusAndLedger(input: {
  result: PipelineResult | undefined;
  posted: InlinePostOutcome | null;
  operatorRoot: string;
  headSha: string;
  statusTargetUrl: string | undefined;
  ciAdmissionLedger: CiAdmissionLedgerState | null;
  ciMode: CiMode;
  // The context this run's status posts on (resolveCiPosture). Only the gate's
  // own context is ever graded: a run on any other context is advisory.
  statusContext: CommitStatusContext;
  // The blocking-tier count of the findings doc, or null when publishing never
  // built one. Gate reads it; advisory ignores it.
  blockingCount: number | null;
  spawnFn?: typeof Bun.spawn;
  settle?: typeof settleCiAdmissionLedger;
}): Promise<void> {
  // Only the gate's own context is graded (T3 S7): any other context is
  // advisory, so a run asked for gate without a `--ci` context still cannot
  // write a verdict onto pr-hero. resolveCiPosture keeps the pair consistent in
  // production; this keeps the write safe if they ever diverge.
  const effectiveMode: CiMode =
    input.statusContext === COMMIT_STATUS_CONTEXT ? input.ciMode : "advisory";
  const completion = commitStatusCompletion({
    pipelineFinished: input.result !== undefined,
    sessionFailed: input.result?.sessionFailed === true,
    ciMode: effectiveMode,
    blockingCount: input.blockingCount,
  });
  const request =
    completion.phase === "failure"
      ? blockingCommitStatusRequest({
          blockingCount: completion.blockingCount,
          targetUrl: input.statusTargetUrl,
          context: input.statusContext,
        })
      : commitStatusRequest({
          phase: completion.phase,
          posted: input.posted !== null,
          targetUrl: input.statusTargetUrl,
          context: input.statusContext,
        });
  try {
    if (effectiveMode === "gate") {
      await publishFinalCommitStatus(
        input.operatorRoot,
        input.headSha,
        request,
        input.spawnFn,
      );
    } else {
      await tryPublishCommitStatus(
        input.operatorRoot,
        input.headSha,
        request,
        input.spawnFn,
      );
    }
  } finally {
    // Settled, so nothing is held: the signal handlers must never post a
    // second, contradicting status over the one just written. Released on
    // every path, including a gate-mode throw above.
    releaseCommitStatusLock();
  }
  await settleLedgerIfPending(input.ciAdmissionLedger, input.settle);
}

// The outer `finally`: releases the pid lock and runs gc no matter how the
// whole review path exited, after a last ledger-settlement chance covering a
// throw from inside the inner finally above.
//
// `settle`/`gc` are test-only seams (defaults: the real
// settleCiAdmissionLedger/runGc), same rationale as
// settleCommitStatusAndLedger above — runGc shells out to `gh pr view` with
// no spawnFn of its own. `releasePidLock` stays real: it is a plain
// `fs.rm` against a caller-supplied path, so a real temp lock file is
// already the observable, and faking it would hide the very fs effect the
// test wants to prove.
export async function finalizePrReviewRun(input: {
  ciAdmissionLedger: CiAdmissionLedgerState | null;
  lockPath: string;
  home: string;
  repoId: string;
  settle?: typeof settleCiAdmissionLedger;
  gc?: typeof runGc;
}): Promise<void> {
  const gc = input.gc ?? runGc;
  await settleLedgerIfPending(input.ciAdmissionLedger, input.settle);
  await releasePidLock(input.lockPath);
  await gc({
    home: input.home,
    repoId: input.repoId,
    dryRun: false,
    silent: true,
  });
}
