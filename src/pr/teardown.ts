// PR mode's teardown: the two `finally` blocks wrapping reviewPr()'s run.
// Relocated out of reviewPr() (src/pr/review-pr.ts): the ledger-settle check
// duplicated in both finally blocks factored into one shared
// `settleLedgerIfPending` helper (still called from both), identifiers moved
// onto explicit parameters, control flow otherwise unchanged. The WHY
// comments below move with the code they explain.

import { recordUnsettledStatus } from "#ci/cli-record";
import { overrideCutoffMs, overrideStandsOverRun } from "#ci/override";
import { formatWorkflowCommand } from "#ci/reporter";
import type { CiAdmissionLedgerState } from "#pr/admission";
import {
  finishedPartialMatches,
  partialCountsIn,
  settleCiAdmissionLedger,
} from "#pr/admission";
import type { InlinePostOutcome } from "#pr/inline";
import { fetchCommitStatuses, fetchCommitStatusList } from "#pr/pr";
import {
  blockingCommitStatusRequest,
  type CiMode,
  COMMIT_STATUS_CONTEXT,
  type CommitStatusContext,
  type CommitStatusFact,
  commitStatusCompletion,
  commitStatusRequest,
  partialReviewCommitStatusRequest,
} from "#pr/preflight";
import {
  heldCommitStatusPendingLanded,
  heldCommitStatusSince,
  publishFinalCommitStatus,
  releaseCommitStatusLock,
  tryPublishCommitStatus,
} from "#pr/status";
import type { PipelineResult } from "#review/pipeline";
import { runGc } from "#store/gc";
import { log } from "#ui/primitives";
import { isStatusContext } from "../brand";
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

// The override cutoff of this run: the instant at or after which an override counts as posted
// during it (overrideCutoffMs, src/ci/override.ts). The CLI computes it here, once per settle,
// while the lock is held, and uses the same value for its own check and for the unsettled
// record the publisher reads. Null when the run took no lock, so it has no start to judge an
// override against.
//
// WHY the cutoff carries the landed decision: the 5 s clock-skew allowance is only safe while
// this run's own pending is on the head, because that pending is what witnesses the start.
// When the pending did not land, the cutoff is the start itself, so an override created a few
// seconds before the start is not taken as posted during the run.
function thisRunOverrideCutoff(): number | null {
  const startedMs = heldCommitStatusSince();
  if (startedMs === null) return null;
  return overrideCutoffMs(startedMs, heldCommitStatusPendingLanded());
}

// Whether an override posted during this run stands over its final write. The rule itself
// is overrideStandsOverRun (src/ci/override.ts), applied to the cutoff the CLI computed.
//
// The wait before the one retry of a failed override read (overrideStandsOverThisRun).
const OVERRIDE_READ_RETRY_DELAY_MS = 2_000;

// WHY the read is strict: the reader is asked with failClosed "read", so a failed gh read throws instead
// of looking like a head with no override (fetchCommitStatuses, src/pr/pr.ts). A malformed row is
// skipped, not a failure: a valid fresh override on the same head still stands over the run.
// WHY a failed read still writes the verdict: on a failed read we cannot tell whether an override
// stands, so the verdict is written as planned. That is a tradeoff, not a guarantee: this write can
// replace an override on the head that we could not read. Holding the verdict back would leave the
// head with no status, the same gap the override rule exists to prevent elsewhere, so we take the
// rarer overwrite and log a warning that says so.
// WHY one retry (2 s, the sleep injected by the caller or Bun.sleep): a failed read is often a blip,
// and a second read narrows the window in which an override is missed. The retry narrows the window
// only: when it fails too, the fallback is unchanged, the verdict is written with its warning.
async function overrideStandsOverThisRun(
  operatorRoot: string,
  headSha: string,
  spawnFn: typeof Bun.spawn | undefined,
  readStatuses: typeof fetchCommitStatuses,
  cutoffMs: number | null,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<boolean> {
  if (cutoffMs === null) return false;
  const readOnce = () =>
    readStatuses(operatorRoot, headSha, {
      spawnFn,
      failClosed: "read",
    });
  let statuses: readonly CommitStatusFact[];
  try {
    statuses = await readOnce();
  } catch {
    // One retry after a short wait narrows the window; when it fails too, the fallback below is
    // the same as before the retry existed.
    try {
      await sleep(OVERRIDE_READ_RETRY_DELAY_MS);
      statuses = await readOnce();
    } catch {
      return overrideReadFallback(headSha);
    }
  }
  return overrideStandsOverRun(statuses, cutoffMs);
}

// The override read's fallback: the verdict is written, and the warning says the head was not read.
function overrideReadFallback(headSha: string): false {
  log(
    formatWorkflowCommand(
      "warning",
      `pr-hero: could not read the statuses of ${headSha.slice(0, 7)}, so the override check could not read the head and the verdict is written`,
    ),
  );
  return false;
}

// W3-PARTIAL S1: the head's previous verdict is this same partial (N of M), so this write is the repeat.
// The full-history reader (fetchCommitStatusList) is the one read: the combined endpoint keeps only the
// newest row per context, and this run's own pending hides the previous verdict there. The newest row
// that is not pending is that verdict, and a null or throwing read keeps today's text.
async function previousPartialIsSame(
  operatorRoot: string,
  headSha: string,
  spawnFn: typeof Bun.spawn | undefined,
  readHistory: typeof fetchCommitStatusList,
  failed: number,
  total: number,
  set: string | undefined,
): Promise<boolean> {
  let history: readonly CommitStatusFact[] | null;
  try {
    history = await readHistory(operatorRoot, headSha, { spawnFn });
  } catch {
    return false;
  }
  if (history === null) return false;
  const previous = history.find(
    (row) =>
      isStatusContext(row.context, COMMIT_STATUS_CONTEXT) &&
      row.state !== "pending",
  );
  const description = previous?.description;
  if (typeof description !== "string" || !finishedPartialMatches(description)) {
    return false;
  }
  const counts = partialCountsIn(description);
  // W4-R363 S1: the same counts are not the same verdict when another hunter failed. A previous text with no
  // set key (written before the key) reads as not the same, so the plain text is written; so does a run
  // that read no failed-hunter names, since nothing then says which hunters failed.
  return (
    set !== undefined &&
    counts !== null &&
    counts.failed === failed &&
    counts.total === total &&
    counts.set === set
  );
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
// real cause. So that write still goes out, through tryPublishCommitStatus
// (unless an override stands, which is checked first only for a verdict write),
// and a failed post only logs. Nothing throws on that path, so the ledger
// settles here too, rather than in finalizePrReviewRun. The body may have
// failed after the review was delivered, so a failed gate post is still
// recorded as unsettled, as on the throw path above (see the else branch).
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
  // W3-PARTIAL S1: the full-history reader for the repeat check (fetchCommitStatusList). Production omits it; a test injects one.
  readHistory?: typeof fetchCommitStatusList;
  // The wait before the override read's one retry. Production omits it (Bun.sleep); a test injects one.
  sleep?: (ms: number) => Promise<void>;
  // Where the CLI's outcome record is written (CRYSK_OUTCOME_DIR). Production omits
  // it, and the record writer then reads process.env, as every other writer does.
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  // Only the gate's own context is graded (T3 S7): any other context is
  // advisory, so a run asked for gate without a `--ci` context still cannot
  // write a verdict onto pr-hero. resolveCiPosture keeps the pair consistent in
  // production; this keeps the write safe if they ever diverge.
  const effectiveMode: CiMode =
    input.statusContext === COMMIT_STATUS_CONTEXT ? input.ciMode : "advisory";
  // S4: the hunter counts ride on the pipeline result, the same object the run's other
  // verdict inputs come from. No separate parameter could disagree with it.
  const completion = commitStatusCompletion({
    pipelineFinished: input.result !== undefined,
    sessionFailed: input.result?.sessionFailed === true,
    ciMode: effectiveMode,
    blockingCount: input.blockingCount,
    ...(input.result?.hunterCount === undefined
      ? {}
      : { hunterCount: input.result.hunterCount }),
    ...(input.result?.hunterFailedCount === undefined
      ? {}
      : { hunterFailures: input.result.hunterFailedCount }),
    ...(input.result?.hunterFailures === undefined
      ? {}
      : {
          hunterFailureNames: input.result.hunterFailures.map((f) => f.name),
        }),
    ...(input.result?.noReviewerRan === true ? { noReviewerRan: true } : {}),
  });
  let request =
    completion.phase === "failure"
      ? blockingCommitStatusRequest({
          blockingCount: completion.blockingCount,
          targetUrl: input.statusTargetUrl,
          context: input.statusContext,
        })
      : completion.phase === "partial"
        ? partialReviewCommitStatusRequest({
            failed: completion.failed,
            total: completion.total,
            set: completion.set,
            targetUrl: input.statusTargetUrl,
            context: input.statusContext,
          })
        : commitStatusRequest({
            phase: completion.phase,
            posted: input.posted !== null,
            targetUrl: input.statusTargetUrl,
            context: input.statusContext,
          });
  // The cutoff is read once, while the lock is still held. The check below and both unsettled
  // records use this value, so the CLI and the publisher judge an override by the same instant.
  const overrideCutoff = thisRunOverrideCutoff();
  try {
    // WHY only a verdict write checks the override: `success` and `failure` are the review's
    // verdict, which an override holds against. An `error` write is a failed review, whether
    // a body threw or every hunter failed, and it may replace the override (the rule in
    // docs/github-actions.md, "Overriding a red gate"). The publisher applies the same rule
    // (src/ci/publish.ts). Advisory is left as it was: this rule is the gate's.
    // W3-PARTIAL S1 / F002: a partial that repeats the head's previous finished partial (same N and M) is
    // written as the repeat text. The history read happens here, before the override read, so the override
    // check stays immediately ahead of the write and no read widens the window where an override can land.
    // Only a partial completion reads history, and only where the run's start is known (the same
    // precondition as the override read).
    if (
      completion.phase === "partial" &&
      overrideCutoff !== null &&
      (await previousPartialIsSame(
        input.operatorRoot,
        input.headSha,
        input.spawnFn,
        input.readHistory ?? fetchCommitStatusList,
        completion.failed,
        completion.total,
        completion.set,
      ))
    ) {
      request = partialReviewCommitStatusRequest({
        failed: completion.failed,
        total: completion.total,
        set: completion.set,
        targetUrl: input.statusTargetUrl,
        context: input.statusContext,
        repeat: true,
      });
    }
    const verdictWrite =
      request.state === "success" || request.state === "failure";
    const overrideStands =
      effectiveMode === "gate" &&
      verdictWrite &&
      (await overrideStandsOverThisRun(
        input.operatorRoot,
        input.headSha,
        input.spawnFn,
        input.readStatuses ?? fetchCommitStatuses,
        overrideCutoff,
        input.sleep,
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
            overrideCutoff,
          );
        }
        throw error;
      }
    } else {
      const landed = await tryPublishCommitStatus(
        input.operatorRoot,
        input.headSha,
        request,
        input.spawnFn,
      );
      // WHY the record here too: a body that threw after publishRunOutcome delivered
      // the review leaves cli.json `reviewed`, and then this gate status is the pending
      // one with no other writer. Same record as the throw path above, so the publisher
      // step can repost what did not land. Gate only: advisory never grades, and a local
      // run demoted to advisory is advisory here too. recordUnsettledStatus rewrites only
      // a reviewed record, so a body that failed before delivery is left alone.
      if (
        !landed &&
        effectiveMode === "gate" &&
        (request.state === "success" || request.state === "failure")
      ) {
        recordUnsettledStatus(
          input.headSha,
          { state: request.state, description: request.description },
          input.env,
          overrideCutoff,
        );
      }
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
