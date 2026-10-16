// The CLI's writer for cli.json (odd/tasks/agent-first-ci.md, T2c). In action mode
// (PRHERO_OUTCOME_DIR set) it leaves the record the publisher reads. Without it,
// it does nothing and prints nothing, so local and watcher runs stay byte-identical.
//
// It never throws: the review's own result is not the record's to block. A write
// that cannot land prints one line, and the publisher then reads an earlier record
// or none at all. The write goes through the trigger's atomic writer, so the
// publisher never reads a half-written file.
//
// The pipeline's verdict stands. recordPipelineOutcome (src/pr/review-pr.ts) writes
// the terminal record (reviewed, hunters-failed, skipped, yielded) as soon as the
// pipeline returns, before posting. A failure after that point is fatal, and
// writeFatalCliRecord keeps the terminal record instead of replacing it with an
// error: a completed review whose posting then threw is still a completed review.
// The commit status settled in teardown reads the same completion predicate, so the
// record and the status agree.
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

// The fatal path's writer: the CLI's catches call this, never writeCliRecord. It
// replaces the record only when this job has no terminal record yet (an error, a
// malformed file, or no file). A terminal record this job already wrote stays, and
// one line on stderr says which outcome was kept.
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
  if (earlier !== undefined && earlier.outcome !== "error") {
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
