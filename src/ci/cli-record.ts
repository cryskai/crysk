// The CLI's writer for cli.json (odd/tasks/agent-first-ci.md, T2c). In action mode
// (PRHERO_OUTCOME_DIR set) it leaves the record the publisher reads. Without it,
// it does nothing and prints nothing, so local and watcher runs stay byte-identical.
//
// It never throws: the review's own result is not the record's to block. A write
// that cannot land prints one line, and the publisher then reads an earlier record
// or none at all. The write goes through the trigger's atomic writer, so the
// publisher never reads a half-written file.
//
// The record names what was DELIVERED, and the first, most specific writer wins.
// Before any of them, just before the CLI posts its pending hold, it writes a progress
// record instead: reviewing, which names the head the lock is on (recordReviewing,
// called from src/pr/plan.ts). It is progress, not an outcome, so every outcome
// below overwrites it.
// - hunters-failed: recordPipelineOutcome (src/pr/review-pr.ts), when the pipeline
//   returns with every hunter failed. Nothing was delivered, so it is a record of its own.
// - skipped: publishCiSkip (src/pr/admission.ts), once the notice is on the PR (or
//   the log line is printed, when posting is off).
// - reviewed: recordReviewDelivered, from publishRunOutcome (src/pr/publish-outcome.ts),
//   once the findings post completes, or once the artifacts exist when posting is off.
//   recordUnsettledStatus (src/pr/teardown.ts) may then add the final status a gate run
//   could not write, and it rewrites a reviewed record only.
// - error: a writer that catches a failure at its own step (a posting, a skip notice),
//   or writeFatalCliRecord for anything else.
// The pipeline finishing is not the review being delivered, and the commit status does
// not say delivery: its success phase means the pipeline finished without every hunter
// failing (its description is "review posted" or "review complete", or in gate mode a blocking count or a partial review). So the status and
// the record can differ. A posting that throws after a finished pipeline leaves the
// status success and the record error, and the publisher reports that error. The
// publisher posts its own status later under the same context ("pr-hero") when it
// knows the head, and that later status is the one GitHub shows.
// A failure after the pipeline returns and before delivery leaves no reviewed record,
// including a throw in the pipeline closure's finally or in the workflow group close.
//
// WHY ONLY BUILTINS (plus this directory's own builtins-only modules): the CLI
// imports this module, and the rule that keeps src/ci modules free of node_modules
// applies here too. outcome.ts and trigger.ts import nothing outside builtins.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLI_RECORD_FILE,
  type CliErrorClass,
  type CliRecord,
  type HunterFailureRecord,
  knownTransportCause,
  PENDING_AT_FILE,
  parseCliRecord,
  safeModelName,
  safeProviderName,
  type UnsettledStatus,
} from "./outcome";
import { NODE_FS, writeRecordAtomically } from "./trigger";

export function writeCliRecord(
  record: CliRecord,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const dir = env.PRHERO_OUTCOME_DIR ?? "";
  if (dir === "") return;
  const written = inheritProgressHead(record, dir);
  try {
    writeRecordAtomically(
      dir,
      CLI_RECORD_FILE,
      `${JSON.stringify(written)}\n`,
      NODE_FS,
    );
  } catch (error) {
    process.stderr.write(
      `pr-hero: could not write the outcome record: ${errnoCode(error)}\n`,
    );
  }
}

// WHY an outcome inherits the reviewing head (F002 on #330): the pending lock sits on
// the head the reviewing record names, and an outcome written after the hold may name
// no head of its own. The publisher would then answer on the trigger's head and leave
// the real lock pending. The reviewing record is this run's own statement of that head,
// so an outcome without one takes it. An outcome that names its head keeps its own.
function inheritProgressHead(record: CliRecord, dir: string): CliRecord {
  if (record.head_sha !== undefined || record.outcome === "reviewing") {
    return record;
  }
  const earlier = readEarlierRecord(dir);
  if (earlier?.outcome !== "reviewing" || earlier.head_sha === undefined) {
    return record;
  }
  return { ...record, head_sha: earlier.head_sha };
}

// The progress writer: src/pr/plan.ts calls it just before posting the pending hold, with
// the head that status is about to be posted on. It is written before the post, so no
// kill can leave a landed lock without a record. It is written whether or not the post
// lands, because the CLI tried to hold: the publisher must be able to tell this run's
// lock from a run that took none. A head that is not a 40-character lowercase SHA
// writes nothing, since the record would not parse, and the publisher reads an
// unparseable record as none.
export function recordReviewing(
  headSha: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const head = cliHeadField(headSha);
  if (head.head_sha === undefined) return;
  writeCliRecord({ v: 1, outcome: "reviewing", head_sha: head.head_sha }, env);
}

// The head field a record may name: 40 lowercase hex, or nothing, so the record still
// parses when the head is not one. The pipeline record and the delivery record share it.
export function cliHeadField(headSha: string): { head_sha?: string } {
  return /^[0-9a-f]{40}$/.test(headSha) ? { head_sha: headSha } : {};
}

// The per-hunter entries of a hunters-failed record. WHY each field is checked here and
// not left to the reader: a value the reader would refuse makes the whole record
// unreadable, and the publisher then reports no outcome at all. So a cause outside the
// vocabulary, or a provider or model that is not a safe short string, is left out of its
// entry, and the entry still says that its hunter failed.
export function hunterFailureRecords(
  failures: readonly {
    readonly cause?: string;
    readonly provider?: string;
    readonly model?: string;
  }[],
): HunterFailureRecord[] {
  return failures.map((failure) => {
    const entry: HunterFailureRecord = {};
    const cause = knownTransportCause(failure.cause);
    if (cause !== undefined) entry.cause = cause;
    const provider = safeProviderName(failure.provider);
    if (provider !== undefined) entry.provider = provider;
    const model = safeModelName(failure.model);
    if (model !== undefined) entry.model = model;
    return entry;
  });
}

// SB3: the pending's own identity, written once it landed. The cancel settle compares the
// head's newest pending with this exact time, so it never overwrites another run's pending.
// Never throws, and writes nothing outside action mode.
// SB3, review #347 round 4: written just BEFORE the pending POST, so a cancel that lands
// after the pending committed on GitHub but before its created_at was recorded still finds
// this run's attempt. recordPendingCreatedAt replaces it once the POST answers.
export const PENDING_POSTING_PREFIX = "posting ";
export function recordPendingPosting(
  nowMs: number = Date.now(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const dir = env.PRHERO_OUTCOME_DIR ?? "";
  if (dir === "") return;
  try {
    writeRecordAtomically(
      dir,
      PENDING_AT_FILE,
      `${PENDING_POSTING_PREFIX}${nowMs}\n`,
      NODE_FS,
    );
  } catch (error) {
    process.stderr.write(
      `pr-hero: could not write the pending record: ${errnoCode(error)}\n`,
    );
  }
}

export function recordPendingCreatedAt(
  createdAt: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const dir = env.PRHERO_OUTCOME_DIR ?? "";
  if (dir === "") return;
  try {
    writeRecordAtomically(dir, PENDING_AT_FILE, `${createdAt}\n`, NODE_FS);
  } catch (error) {
    process.stderr.write(
      `pr-hero: could not write the pending record: ${errnoCode(error)}\n`,
    );
  }
}

// The delivery writer: publishRunOutcome calls it once the review is delivered (see the
// header for which delivery point, and why). A run that did not deliver never calls it.
export function recordReviewDelivered(
  headSha: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  writeCliRecord({ v: 1, outcome: "reviewed", ...cliHeadField(headSha) }, env);
}

// The unsettled-status writer: src/pr/teardown.ts calls it when a gate run's final status
// write fails after the review was delivered. The review is delivered, so the record stays
// reviewed, and it gains the status the CLI could not write, so the publisher step later in
// the same job can post it. The head is the one that status was written for, since that is
// the head whose required check is still pending. Only a reviewed record takes it: an error
// or hunters-failed record keeps its own outcome, and a head that is not a SHA writes nothing.
// It never throws, like the other writers.
//
// The override cutoff rides on the same record (override_cutoff_ms), when the caller has one: the
// CLI computes it once for the run (overrideCutoffMs, src/ci/override.ts), and the publisher
// compares an override with it before it reposts, without re-deriving it. A cutoff that is not a
// positive safe integer is left out, since the reader would refuse the record.
//
// WHY the earlier record is read here: the writer must know the outcome it would overwrite,
// and the write above has no such check of its own.
export function recordUnsettledStatus(
  headSha: string,
  status: UnsettledStatus,
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrideCutoffMs?: number | null,
): void {
  const dir = env.PRHERO_OUTCOME_DIR ?? "";
  if (dir === "") return;
  const head = cliHeadField(headSha);
  if (head.head_sha === undefined) return;
  if (readEarlierRecord(dir)?.outcome !== "reviewed") return;
  const cutoff =
    overrideCutoffMs !== undefined &&
    overrideCutoffMs !== null &&
    Number.isSafeInteger(overrideCutoffMs) &&
    overrideCutoffMs > 0
      ? { override_cutoff_ms: overrideCutoffMs }
      : {};
  writeCliRecord(
    {
      v: 1,
      outcome: "reviewed",
      ...head,
      unsettled_status: status,
      ...cutoff,
    },
    env,
  );
}

// The fatal path's writer: the CLI's catches call this, never writeCliRecord. It keeps
// any terminal or error record this job already wrote, and writes its own error when
// there is none, when the file does not parse, or when the earlier record is reviewing.
// One line on stderr says which outcome was kept.
//
// WHY keep an error record too: the writer closest to the failure knows more than this
// top-level catch. A posting or a skip notice that threw has already named its step, and
// replacing that record with an unclassified error would discard the step.
//
// WHY a reviewing record is overwritten (F001 on #330): it is progress, not an outcome.
// The error replaces it, and writeCliRecord carries its head over, so the publisher
// answers on the head the lock is on.
//
// WHY no check that the record belongs to this job: the trigger clears cli.json at
// job start (clearStaleMarkers in trigger.ts), so a record present here was written
// by this job.
export function writeFatalCliRecord(
  cls: CliErrorClass,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const dir = env.PRHERO_OUTCOME_DIR ?? "";
  if (dir === "") return;
  const earlier = readEarlierRecord(dir);
  if (earlier !== undefined && earlier.outcome !== "reviewing") {
    process.stderr.write(
      `pr-hero: kept the recorded ${earlier.outcome} outcome; a later step failed\n`,
    );
    return;
  }
  writeCliRecord({ v: 1, outcome: "error", cls }, env);
}

// The record this job already wrote, or undefined when there is none, it cannot be
// read, or it does not parse. Never throws: the fatal path must not fail while it
// reports a failure.
function readEarlierRecord(dir: string): CliRecord | undefined {
  try {
    const text = readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8");
    return parseCliRecord(text);
  } catch {
    return undefined;
  }
}

// The errno code only (ENOENT, EACCES, ...). The message names the path, and the
// path does not belong in a runner log.
function errnoCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unknown";
  }
  const code = error.code;
  return typeof code === "string" && code !== "" ? code : "unknown";
}
