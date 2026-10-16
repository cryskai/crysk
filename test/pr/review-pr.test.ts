// T2c unit A (odd/tasks/agent-first-ci.md, S3): the CLI's pipeline outcome record.
// reviewPr() has no seam for the gh fetches around its pipeline, so the decision
// is tested through recordPipelineOutcome, and the call site is pinned by reading
// the source the way test/architecture/gate-skip-settlement.test.ts does.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_RECORD_FILE, parseCliRecord } from "#ci/outcome";
import { recordPipelineOutcome } from "#pr/review-pr";

const SHA = "a".repeat(40);

describe("recordPipelineOutcome", () => {
  let dir: string;

  function written(): string | undefined {
    try {
      return readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8");
    } catch {
      return undefined;
    }
  }

  function setup(): void {
    dir = mkdtempSync(path.join(os.tmpdir(), "prhero-pipeline-record-"));
  }

  test("a finished pipeline with live hunters records reviewed, with the head it reviewed", () => {
    setup();
    try {
      recordPipelineOutcome({ sessionFailed: false }, SHA, {
        PRHERO_OUTCOME_DIR: dir,
      });
      expect(parseCliRecord(written() ?? "")).toEqual({
        v: 1,
        outcome: "reviewed",
        head_sha: SHA,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a finished pipeline whose every hunter failed records hunters-failed", () => {
    setup();
    try {
      recordPipelineOutcome({ sessionFailed: true }, SHA, {
        PRHERO_OUTCOME_DIR: dir,
      });
      expect(parseCliRecord(written() ?? "")).toEqual({
        v: 1,
        outcome: "hunters-failed",
        head_sha: SHA,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pipeline that never returned writes nothing: its throw reaches the fatal record", () => {
    setup();
    try {
      recordPipelineOutcome(undefined, SHA, { PRHERO_OUTCOME_DIR: dir });
      expect(written()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a head that is not a 40-character lowercase SHA is left out, so the record still parses", () => {
    setup();
    try {
      recordPipelineOutcome({ sessionFailed: false }, "not-a-sha", {
        PRHERO_OUTCOME_DIR: dir,
      });
      expect(parseCliRecord(written() ?? "")).toEqual({
        v: 1,
        outcome: "reviewed",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no outcome directory it writes nothing", () => {
    setup();
    try {
      recordPipelineOutcome({ sessionFailed: false }, SHA, {});
      expect(written()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reviewPr's call site for the pipeline record", () => {
  test("the record is written after runPipeline returns and before publishRunOutcome", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "../../src/pr/review-pr.ts"),
      "utf8",
    );
    const pipelineAt = source.indexOf("result = await runPipeline(");
    const recordAt = source.search(/^\s*recordPipelineOutcome\(/m);
    const publishAt = source.indexOf("return await publishRunOutcome({");
    expect(pipelineAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(pipelineAt);
    expect(publishAt).toBeGreaterThan(recordAt);
  });
});
