// T2c unit A (odd/tasks/agent-first-ci.md, S3): the CLI's outcome record writer.
// In action mode (PRHERO_OUTCOME_DIR set) writeCliRecord leaves cli.json for the
// publisher; without it nothing is written and nothing is printed. A write that
// cannot land must never throw, because the review's own result is not the
// record's to block.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCliRecord } from "#ci/cli-record";
import { CLI_RECORD_FILE, type CliRecord, parseCliRecord } from "#ci/outcome";

const SHA = "e".repeat(40);

function captureStderr(fn: () => void): { chunks: string[] } {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = origWrite;
  }
  return { chunks };
}

describe("writeCliRecord", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "prhero-cli-record-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const record: CliRecord = { v: 1, outcome: "reviewed", head_sha: SHA };

  test("with PRHERO_OUTCOME_DIR unset, nothing is written and nothing is printed", () => {
    const { chunks } = captureStderr(() => writeCliRecord(record, {}));
    expect(chunks).toEqual([]);
    expect(existsSync(path.join(root, CLI_RECORD_FILE))).toBe(false);
  });

  test("with PRHERO_OUTCOME_DIR empty, it behaves exactly as when unset", () => {
    const { chunks } = captureStderr(() =>
      writeCliRecord(record, { PRHERO_OUTCOME_DIR: "" }),
    );
    expect(chunks).toEqual([]);
    expect(existsSync(path.join(root, CLI_RECORD_FILE))).toBe(false);
  });

  test("with PRHERO_OUTCOME_DIR set, cli.json parses back to the same record and leaves no temp file", () => {
    const dir = path.join(root, "outcome");
    writeCliRecord(record, { PRHERO_OUTCOME_DIR: dir });
    const written = readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8");
    expect(parseCliRecord(written)).toEqual(record);
    expect(existsSync(path.join(dir, `${CLI_RECORD_FILE}.tmp`))).toBe(false);
  });

  test("the last write wins: a fatal error overwrites an earlier reviewed record", () => {
    const dir = path.join(root, "outcome");
    const env = { PRHERO_OUTCOME_DIR: dir };
    writeCliRecord(record, env);
    writeCliRecord({ v: 1, outcome: "error", cls: { kind: "unknown" } }, env);
    const written = readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8");
    expect(parseCliRecord(written)?.outcome).toBe("error");
  });

  test("a write that cannot land does not throw and prints exactly one line naming only the errno code", () => {
    // A regular file where the directory should be: mkdir fails with ENOTDIR.
    // (writeRecordAtomically creates a missing directory, so a merely missing
    // directory is not a failure to test.)
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "");
    const dir = path.join(blocker, "outcome");
    let thrown: unknown;
    let chunks: string[] = [];
    try {
      ({ chunks } = captureStderr(() =>
        writeCliRecord(record, { PRHERO_OUTCOME_DIR: dir }),
      ));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(
      "pr-hero: could not write the outcome record: ENOTDIR\n",
    );
    expect(chunks.join("")).not.toContain(dir);
  });
});
