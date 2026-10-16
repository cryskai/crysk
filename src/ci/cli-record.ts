// The CLI's writer for cli.json (odd/tasks/agent-first-ci.md, T2c). In action mode
// (PRHERO_OUTCOME_DIR set) it leaves the record the publisher reads. Without it,
// it does nothing and prints nothing, so local and watcher runs stay byte-identical.
//
// It never throws: the review's own result is not the record's to block. A write
// that cannot land prints one line, and the publisher then reads an earlier record
// or none at all. The write goes through the trigger's atomic writer, so the
// publisher never reads a half-written file.
//
// WHY ONLY BUILTINS (plus this directory's own builtins-only modules): the CLI
// imports this module, and the rule that keeps src/ci modules free of node_modules
// applies here too. outcome.ts and trigger.ts import nothing outside builtins.

import { CLI_RECORD_FILE, type CliRecord } from "./outcome";
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

// The errno code only (ENOENT, EACCES, ...). The message names the path, and the
// path does not belong in a runner log.
function errnoCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unknown";
  }
  const code = error.code;
  return typeof code === "string" && code !== "" ? code : "unknown";
}
