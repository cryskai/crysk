// T2c unit A (odd/tasks/agent-first-ci.md, S3): the CLI's outcome record writer.
// In action mode (PRHERO_OUTCOME_DIR set) writeCliRecord leaves cli.json for the
// publisher; without it nothing is written and nothing is printed. A write that
// cannot land must never throw, because the review's own result is not the
// record's to block.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordReviewDelivered,
  writeCliRecord,
  writeFatalCliRecord,
} from "#ci/cli-record";
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

describe("writeFatalCliRecord", () => {
  let root: string;
  let dir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "prhero-cli-fatal-"));
    dir = path.join(root, "outcome");
    env = { PRHERO_OUTCOME_DIR: dir };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const reviewed: CliRecord = { v: 1, outcome: "reviewed", head_sha: SHA };
  const unmapped = { kind: "route", reason: "unmapped" } as const;

  function onDisk(): string {
    return readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8");
  }

  test("a reviewed record survives a later fatal error, and one line names the kept outcome", () => {
    writeCliRecord(reviewed, env);
    const { chunks } = captureStderr(() =>
      writeFatalCliRecord({ kind: "unknown" }, env),
    );
    expect(parseCliRecord(onDisk())).toEqual(reviewed);
    expect(chunks).toEqual([
      "pr-hero: kept the recorded reviewed outcome; a later step failed\n",
    ]);
  });

  const kept: Array<[string, CliRecord]> = [
    ["hunters-failed", { v: 1, outcome: "hunters-failed", head_sha: SHA }],
    ["skipped", { v: 1, outcome: "skipped", skip: "size" }],
    ["yielded", { v: 1, outcome: "yielded" }],
  ];

  test.each(kept)(
    "a %s record survives a later fatal error, and one line names its outcome",
    (outcome, record) => {
      writeCliRecord(record, env);
      const { chunks } = captureStderr(() =>
        writeFatalCliRecord({ kind: "unknown" }, env),
      );
      expect(parseCliRecord(onDisk())).toEqual(record);
      expect(chunks).toEqual([
        `pr-hero: kept the recorded ${outcome} outcome; a later step failed\n`,
      ]);
    },
  );

  test("no record yet: the fatal error is written with its class, and nothing is printed", () => {
    const { chunks } = captureStderr(() => writeFatalCliRecord(unmapped, env));
    expect(parseCliRecord(onDisk())).toEqual({
      v: 1,
      outcome: "error",
      cls: unmapped,
    });
    expect(chunks).toEqual([]);
  });

  test("a malformed record is replaced by the fatal error, and nothing is printed", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CLI_RECORD_FILE), "{not json");
    const { chunks } = captureStderr(() => writeFatalCliRecord(unmapped, env));
    expect(parseCliRecord(onDisk())).toEqual({
      v: 1,
      outcome: "error",
      cls: unmapped,
    });
    expect(chunks).toEqual([]);
  });

  // WHY kept, not replaced: the writer closest to the failure (a posting or a
  // skip notice that threw) already named its step, and the top-level catch
  // knows less. The trigger clears cli.json at job start, so this record is ours.
  test("an earlier error record that names its step is kept, and one line names the kept outcome", () => {
    const posting = {
      v: 1,
      outcome: "error",
      cls: { kind: "unknown" },
      params: { step: "posting the review" },
    } as const;
    writeCliRecord(posting, env);
    const { chunks } = captureStderr(() => writeFatalCliRecord(unmapped, env));
    expect(parseCliRecord(onDisk())).toEqual(posting);
    expect(chunks).toEqual([
      "pr-hero: kept the recorded error outcome; a later step failed\n",
    ]);
  });

  test("with PRHERO_OUTCOME_DIR unset, nothing is written and nothing is printed", () => {
    const { chunks } = captureStderr(() => writeFatalCliRecord(unmapped, {}));
    expect(chunks).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  test("a fatal write that cannot land does not throw and prints one errno line", () => {
    // Same blocker as writeCliRecord's test: a regular file where the directory
    // should be. The read of the earlier record fails too, and must not throw.
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "");
    const blocked = { PRHERO_OUTCOME_DIR: path.join(blocker, "outcome") };
    let thrown: unknown;
    let chunks: string[] = [];
    try {
      ({ chunks } = captureStderr(() =>
        writeFatalCliRecord(unmapped, blocked),
      ));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    expect(chunks).toEqual([
      "pr-hero: could not write the outcome record: ENOTDIR\n",
    ]);
  });
});

describe("recordReviewDelivered", () => {
  let root: string;
  let dir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "prhero-cli-delivered-"));
    dir = path.join(root, "outcome");
    env = { PRHERO_OUTCOME_DIR: dir };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function onDisk(): string {
    return readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8");
  }

  test("writes reviewed with the head the review was delivered for", () => {
    recordReviewDelivered(SHA, env);
    expect(parseCliRecord(onDisk())).toEqual({
      v: 1,
      outcome: "reviewed",
      head_sha: SHA,
    });
  });

  test("leaves out a head that is not a 40-character lowercase SHA, so the record still parses", () => {
    recordReviewDelivered("not-a-sha", env);
    expect(parseCliRecord(onDisk())).toEqual({ v: 1, outcome: "reviewed" });
  });

  test("with PRHERO_OUTCOME_DIR unset, nothing is written", () => {
    recordReviewDelivered(SHA, {});
    expect(existsSync(dir)).toBe(false);
  });
});
