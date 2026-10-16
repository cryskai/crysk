// The CLI's writer for cli.json (odd/tasks/agent-first-ci.md, T2c). In action mode
// (PRHERO_OUTCOME_DIR set) it leaves the record the publisher reads. Without it,
// it does nothing and prints nothing, so local and watcher runs stay byte-identical.
//
// It never throws: the review's own result is not the record's to block. A write
// that cannot land prints one line, and the publisher then reads an earlier record
// or none at all. The write goes through the trigger's atomic writer, so the
// publisher never reads a half-written file.
//
// The record names what was DELIVERED, and the first, most specific writer wins:
// - hunters-failed: recordPipelineOutcome (src/pr/review-pr.ts), when the pipeline
//   returns with every hunter failed. Nothing was delivered, so it is a record of its own.
// - skipped: publishCiSkip (src/pr/admission.ts), once the notice is on the PR (or
//   the log line is printed, when posting is off).
// - reviewed: recordReviewDelivered, from publishRunOutcome (src/pr/publish-outcome.ts),
//   once the findings post completes, or once the artifacts exist when posting is off.
// - error: a writer that catches a failure at its own step (a posting, a skip notice),
//   or writeFatalCliRecord for anything else.
// The pipeline finishing is not the review being delivered, and the commit status does
// not say delivery: its success phase means the pipeline finished without every hunter
// failing (its description is "review posted" or "review complete"). So the status and
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
  parseCliRecord,
} from "./outcome";
import { NODE_FS, writeRecordAtomically } from "./trigger";

export function writeCliRecord(
  record: CliRecord,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const dir = env.PRHERO_OUTCOME_DIR ?? "";
  if (dir === "") return;
  try {
    writeRecordAtomically(
      dir,
      CLI_RECORD_FILE,
      `${JSON.stringify(record)}\n`,
      NODE_FS,
    );
  } catch (error) {
    process.stderr.write(
      `pr-hero: could not write the outcome record: ${errnoCode(error)}\n`,
    );
  }
}

// The head field a record may name: 40 lowercase hex, or nothing, so the record still
// parses when the head is not one. The pipeline record and the delivery record share it.
export function cliHeadField(headSha: string): { head_sha?: string } {
  return /^[0-9a-f]{40}$/.test(headSha) ? { head_sha: headSha } : {};
}

// The delivery writer: publishRunOutcome calls it once the review is delivered (see the
// header for which delivery point, and why). A run that did not deliver never calls it.
export function recordReviewDelivered(
  headSha: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  writeCliRecord({ v: 1, outcome: "reviewed", ...cliHeadField(headSha) }, env);
}

// The fatal path's writer: the CLI's catches call this, never writeCliRecord. It keeps
// ANY record this job already wrote, terminal or error, and writes its own error only
// when there is no parseable record (none, or a malformed file). One line on stderr
// says which outcome was kept.
//
// WHY keep an error record too: the writer closest to the failure knows more than this
// top-level catch. A posting or a skip notice that threw has already named its step, and
// replacing that record with an unclassified error would discard the step.
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
  if (earlier !== undefined) {
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
