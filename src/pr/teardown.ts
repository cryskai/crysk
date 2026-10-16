// PR mode's teardown: the two `finally` blocks wrapping reviewPr()'s run.
// Relocated out of reviewPr() (src/pr/review-pr.ts): the ledger-settle check
// duplicated in both finally blocks factored into one shared
// `settleLedgerIfPending` helper (still called from both), identifiers moved
// onto explicit parameters, control flow otherwise unchanged. The WHY
// comments below move with the code they explain.

import { recordUnsettledStatus } from "#ci/cli-record";
import { OVERRIDE_DESCRIPTION_PREFIX } from "#ci/publish";
import type { CiAdmissionLedgerState } from "#pr/admission";
import { settleCiAdmissionLedger } from "#pr/admission";
import type { InlinePostOutcome } from "#pr/inline";
import { fetchCommitStatuses } from "#pr/pr";
import {
  blockingCommitStatusRequest,
  type CiMode,
  COMMIT_STATUS_CONTEXT,
  type CommitStatusContext,
  type CommitStatusFact,
  commitStatusCompletion,
  commitStatusRequest,
  latestStatusInContext,
} from "#pr/preflight";
import {
  heldCommitStatusSince,
  publishFinalCommitStatus,
  releaseCommitStatusLock,
  tryPublishCommitStatus,
} from "#pr/status";
import type { PipelineResult } from "#review/pipeline";
import { runGc } from "#store/gc";
import { log } from "#ui/primitives";
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

// The rule (docs/github-actions.md, "Overriding a red gate"): an override stands
// against a review that was already running when it was posted, and a review started
// after it replaces it. So the override stands when the newest `pr-hero` status is a
// successful override and was created after this run started. A later review has posted its own
// status since, which is then the newest, so this check is false and its write goes
// ahead as before.
//
// WHY the floor to the second: GitHub's created_at has one-second precision. An
// override in the run's own second is taken as posted during the run, the side that
// keeps a human's unlock.
//
// The description comes from the statuses reader, fetchCommitStatuses (pr.ts), which
// requests it. A status without one is never taken as an override.
export function overrideStandsOverRun(
  statuses: readonly CommitStatusFact[],
  runStartedMs: number,
): boolean {
  const latest = latestStatusInContext(statuses, COMMIT_STATUS_CONTEXT);
  if (latest === null) return false;
  // WHY the state too: an override is a success. A status that merely carries the
  // description (a failure or a pending one) is not an override, and must not hold
  // the gate open over a review that finished.
  if (latest.state !== "success") return false;
  const description = latest.description;
  if (
    typeof description !== "string" ||
    !description.startsWith(OVERRIDE_DESCRIPTION_PREFIX)
  ) {
    return false;
  }
  const createdMs = Date.parse(latest.created_at);
  if (Number.isNaN(createdMs)) return false;
  return createdMs >= Math.floor(runStartedMs / 1000) * 1000;
}

// Whether an override posted during this run stands over its final write. Only a run
// that took the lock has a start to compare with. A failed read is no evidence of an
// override, so the write goes ahead, as before (fail open to the review's verdict).
async function overrideStandsOverThisRun(
  operatorRoot: string,
  headSha: string,
  spawnFn: typeof Bun.spawn | undefined,
  readStatuses: typeof fetchCommitStatuses,
): Promise<boolean> {
  const startedMs = heldCommitStatusSince();
  if (startedMs === null) return false;
  let statuses: readonly CommitStatusFact[];
  try {
    statuses = await readStatuses(operatorRoot, headSha, { spawnFn });
  } catch {
    return false;
  }
  return overrideStandsOverRun(statuses, startedMs);
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
// The exception is a body that already threw (`bodyFailed`, set by reviewPr's
// catch). The body's error is then the run's failure, and it must reach the
// CLI unchanged: a throw from this finally would replace it, and
// writeFatalCliRecord would record the status error's class instead of the
// real cause. So that write still goes out, through tryPublishCommitStatus,
// and a failed post only logs. Nothing throws on that path, so the ledger
// settles here too, rather than in finalizePrReviewRun.
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
  // True when the review body threw (reviewPr's inner catch). Gate then writes
  // best-effort, so the body's own error is never replaced by a status error.
  bodyFailed?: boolean;
  spawnFn?: typeof Bun.spawn;
  settle?: typeof settleCiAdmissionLedger;
  // The head's statuses, read before a gate's final write to see whether an override
  // posted during this run stands (overrideStandsOverRun). Production omits it and
  // gets the real reader; a test injects one.
  readStatuses?: typeof fetchCommitStatuses;
  // Where the CLI's outcome record is written (PRHERO_OUTCOME_DIR). Production omits
  // it, and the record writer then reads process.env, as every other writer does.
  env?: Readonly<Record<string, string | undefined>>;
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
    // WHY only the gate's own final write: a body that threw is written best-effort,
    // and that error status is not the review's verdict. It is not checked here, and
    // the publisher's own error branch posts an `error` status for that CLI record
    // without reading the head (src/ci/publish.ts, remoteOrLocal), so it can still
    // replace an override. Advisory is left as it was: this rule is the gate's.
    const overrideStands =
      effectiveMode === "gate" &&
      input.bodyFailed !== true &&
      (await overrideStandsOverThisRun(
        input.operatorRoot,
        input.headSha,
        input.spawnFn,
        input.readStatuses ?? fetchCommitStatuses,
      ));
    if (overrideStands) {
      // WHY one line and no status: the override stays the head's status. This run's
      // findings and PR comments are not affected by this write.
      log(
        "pr-hero: an override on this head stands, so this review's verdict is not written over it.",
      );
    } else if (effectiveMode === "gate" && input.bodyFailed !== true) {
      try {
        await publishFinalCommitStatus(
          input.operatorRoot,
          input.headSha,
          request,
          input.spawnFn,
        );
      } catch (error) {
        // WHY the record: the review was delivered, so the head's required check must not
        // stay pending after it. The record keeps the status that did not land, and the
        // publisher step later in this job posts it once more. The rethrow still fails
        // this run. Only success and failure are recorded: a finished review's status is
        // one of those two, and the record names no other.
        if (request.state === "success" || request.state === "failure") {
          recordUnsettledStatus(
            input.headSha,
            { state: request.state, description: request.description },
            input.env,
          );
        }
        throw error;
      }
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
