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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordPendingCreatedAt,
  recordReviewDelivered,
  recordReviewing,
  recordUnsettledStatus,
  writeCliRecord,
  writeFatalCliRecord,
} from "#ci/cli-record";
import {
  CLI_RECORD_FILE,
  type CliRecord,
  PENDING_AT_FILE,
  parseCliRecord,
} from "#ci/outcome";

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

  // CHANGED (F003 on #330): the temp name is unique per write, so a leftover can
  // sit under any name. The check looks for any `.tmp` entry instead of the old
  // fixed `cli.json.tmp`, which a unique name would never produce.
  test("with PRHERO_OUTCOME_DIR set, cli.json parses back to the same record and leaves no temp file", () => {
    const dir = path.join(root, "outcome");
    writeCliRecord(record, { PRHERO_OUTCOME_DIR: dir });
    const written = readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8");
    expect(parseCliRecord(written)).toEqual(record);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  // WHY a directory, not a read-only file (F003 on #330): a directory at a path
  // fails any write to that path for every user, root included, where a chmod
  // does not. The old fixed temp name is the one a stale file would occupy.
  test("a directory left at the old fixed temp name does not stop the write", () => {
    const dir = path.join(root, "outcome");
    mkdirSync(path.join(dir, `${CLI_RECORD_FILE}.tmp`), { recursive: true });
    const { chunks } = captureStderr(() =>
      writeCliRecord(record, { PRHERO_OUTCOME_DIR: dir }),
    );
    expect(chunks).toEqual([]);
    expect(
      parseCliRecord(readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8")),
    ).toEqual(record);
  });

  // WHY the head is inherited (F002 on #330): a terminal record written after this
  // run's pending hold names no head of its own, and the publisher would then post
  // on the trigger's head, not the one the lock is on. The reviewing record is this
  // run's own statement of that head, so the terminal record carries it forward.
  test("a terminal record with no head of its own takes the head of this run's reviewing record", () => {
    const env = { PRHERO_OUTCOME_DIR: path.join(root, "outcome") };
    recordReviewing(SHA, env);
    const posting = {
      v: 1,
      outcome: "error",
      cls: { kind: "unknown" },
      params: { step: "posting the review" },
    } as const;
    writeCliRecord(posting, env);
    expect(
      parseCliRecord(
        readFileSync(
          path.join(env.PRHERO_OUTCOME_DIR, CLI_RECORD_FILE),
          "utf8",
        ),
      ),
    ).toEqual({ ...posting, head_sha: SHA });
  });

  test("a terminal record that names its own head keeps it over the reviewing record's", () => {
    const env = { PRHERO_OUTCOME_DIR: path.join(root, "outcome") };
    const other = "f".repeat(40);
    recordReviewing(SHA, env);
    writeCliRecord({ v: 1, outcome: "reviewed", head_sha: other }, env);
    expect(
      parseCliRecord(
        readFileSync(
          path.join(env.PRHERO_OUTCOME_DIR, CLI_RECORD_FILE),
          "utf8",
        ),
      ),
    ).toEqual({ v: 1, outcome: "reviewed", head_sha: other });
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
    // WHY this row: the publisher reads the unsettled status from this record. A
    // fatal error after the teardown rethrows must keep it, or the fix is lost.
    [
      "reviewed",
      {
        v: 1,
        outcome: "reviewed",
        head_sha: SHA,
        unsettled_status: {
          state: "failure",
          description: "pr-hero: 1 blocking finding(s)",
        },
      },
    ],
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

  // WHY overwritten, not kept (F001 on #330): a reviewing record is this run's
  // progress, not an outcome, so the fatal error replaces it. The error keeps the
  // reviewing head, so the publisher posts on the head the lock is on.
  test("a reviewing record is overwritten by the fatal error, which keeps the reviewing head, and nothing is printed", () => {
    recordReviewing(SHA, env);
    const { chunks } = captureStderr(() => writeFatalCliRecord(unmapped, env));
    expect(parseCliRecord(onDisk())).toEqual({
      v: 1,
      outcome: "error",
      cls: unmapped,
      head_sha: SHA,
    });
    expect(chunks).toEqual([]);
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

describe("recordPendingCreatedAt (SB3)", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "prhero-cli-pending-at-"));
    dir = path.join(root, "outcome");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("writes the pending's created_at in action mode", () => {
    recordPendingCreatedAt("2026-10-17T10:00:00Z", {
      PRHERO_OUTCOME_DIR: dir,
    });
    expect(readFileSync(path.join(dir, PENDING_AT_FILE), "utf8")).toBe(
      "2026-10-17T10:00:00Z\n",
    );
  });

  test("writes nothing outside action mode", () => {
    recordPendingCreatedAt("2026-10-17T10:00:00Z", {});
    expect(existsSync(path.join(dir, PENDING_AT_FILE))).toBe(false);
  });
});

describe("recordReviewing", () => {
  let root: string;
  let dir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "prhero-cli-reviewing-"));
    dir = path.join(root, "outcome");
    env = { PRHERO_OUTCOME_DIR: dir };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function onDisk(): string {
    return readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8");
  }

  // WHY this record: the CLI took the pending lock on this head, and nothing else
  // is known yet. The publisher reads the lock on this head, so the head is the
  // whole record.
  test("writes reviewing with the head the pending status was posted on", () => {
    recordReviewing(SHA, env);
    expect(parseCliRecord(onDisk())).toEqual({
      v: 1,
      outcome: "reviewing",
      head_sha: SHA,
    });
  });

  test("a head that is not a 40-character lowercase SHA writes nothing, since the record would not parse", () => {
    const { chunks } = captureStderr(() => recordReviewing("not-a-sha", env));
    expect(chunks).toEqual([]);
    expect(existsSync(path.join(dir, CLI_RECORD_FILE))).toBe(false);
  });

  test("with PRHERO_OUTCOME_DIR unset, nothing is written", () => {
    recordReviewing(SHA, {});
    expect(existsSync(dir)).toBe(false);
  });
});

// WHY this writer: the teardown's final status write failed after the review was
// delivered. It rewrites the reviewed record with the status the CLI could not write,
// so the publisher step later in the same job can post it. It only ever upgrades a
// reviewed record: any other record keeps its own outcome.
describe("recordUnsettledStatus", () => {
  let root: string;
  let dir: string;
  let env: Record<string, string>;
  const UNSETTLED = {
    state: "failure",
    description:
      "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
  } as const;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "prhero-cli-unsettled-"));
    dir = path.join(root, "outcome");
    env = { PRHERO_OUTCOME_DIR: dir };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function onDisk(): string {
    return readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8");
  }

  test("rewrites a reviewed record with its head and the status the CLI could not write", () => {
    recordReviewDelivered(SHA, env);
    recordUnsettledStatus(SHA, UNSETTLED, env);
    expect(parseCliRecord(onDisk())).toEqual({
      v: 1,
      outcome: "reviewed",
      head_sha: SHA,
      unsettled_status: UNSETTLED,
    });
  });

  // Fix 4: the override cutoff rides on the unsettled record, so the publisher can tell an
  // override posted during this run from one posted before it, without re-deriving the cutoff.
  test("records the override cutoff next to the status, when the caller has one", () => {
    recordReviewDelivered(SHA, env);
    recordUnsettledStatus(SHA, UNSETTLED, env, 1_792_238_395_000);
    expect(parseCliRecord(onDisk())).toEqual({
      v: 1,
      outcome: "reviewed",
      head_sha: SHA,
      unsettled_status: UNSETTLED,
      override_cutoff_ms: 1_792_238_395_000,
    });
  });

  test.each([
    ["no cutoff", null],
    ["zero", 0],
    ["a fraction", 1.5],
    ["a negative number", -1],
  ])(
    "leaves override_cutoff_ms out when the cutoff is %s, since the reader would refuse it",
    (_label, overrideCutoffMs) => {
      recordReviewDelivered(SHA, env);
      recordUnsettledStatus(SHA, UNSETTLED, env, overrideCutoffMs);
      expect(parseCliRecord(onDisk())).toEqual({
        v: 1,
        outcome: "reviewed",
        head_sha: SHA,
        unsettled_status: UNSETTLED,
      });
    },
  );

  test.each([
    ["an error", { v: 1, outcome: "error", cls: { kind: "unknown" } }],
    ["a hunters-failed", { v: 1, outcome: "hunters-failed", head_sha: SHA }],
  ] as const)("leaves an earlier %s record alone", (_label, earlier) => {
    writeCliRecord(earlier as CliRecord, env);
    recordUnsettledStatus(SHA, UNSETTLED, env);
    expect(parseCliRecord(onDisk())).toEqual(earlier);
  });

  test("writes nothing when no record exists yet", () => {
    recordUnsettledStatus(SHA, UNSETTLED, env);
    expect(existsSync(path.join(dir, CLI_RECORD_FILE))).toBe(false);
  });

  test("a head that is not a 40-character lowercase SHA leaves the record as it was", () => {
    recordReviewDelivered(SHA, env);
    recordUnsettledStatus("not-a-sha", UNSETTLED, env);
    expect(parseCliRecord(onDisk())).toEqual({
      v: 1,
      outcome: "reviewed",
      head_sha: SHA,
    });
  });

  test("with PRHERO_OUTCOME_DIR unset, nothing is written and nothing is printed", () => {
    const { chunks } = captureStderr(() =>
      recordUnsettledStatus(SHA, UNSETTLED, {}),
    );
    expect(chunks).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });
});
