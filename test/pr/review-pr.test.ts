// T2c unit A (odd/tasks/agent-first-ci.md, S3): the CLI's pipeline outcome record.
// reviewPr() has no seam for the gh fetches around its pipeline, so the decision
// is tested through recordPipelineOutcome, and the call site is pinned by reading
// the source the way test/architecture/gate-skip-settlement.test.ts does.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_RECORD_FILE, parseCliRecord } from "#ci/outcome";
import { postAdjudicationReplies, recordPipelineOutcome } from "#pr/review-pr";

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

  // WHY no reviewed here: the pipeline finishing is not the review being
  // delivered. publishRunOutcome writes reviewed once the findings are posted
  // (or the artifacts exist when posting is off), so a posting failure never
  // leaves a reviewed record behind.
  test("a finished pipeline with live hunters writes nothing: reviewed waits for the delivery", () => {
    setup();
    try {
      recordPipelineOutcome({ sessionFailed: false }, SHA, {
        PRHERO_OUTCOME_DIR: dir,
      });
      expect(written()).toBeUndefined();
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
      recordPipelineOutcome({ sessionFailed: true }, "not-a-sha", {
        PRHERO_OUTCOME_DIR: dir,
      });
      expect(parseCliRecord(written() ?? "")).toEqual({
        v: 1,
        outcome: "hunters-failed",
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
    const publishAt = source.indexOf("await publishRunOutcome({");
    expect(pipelineAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(pipelineAt);
    expect(publishAt).toBeGreaterThan(recordAt);
  });
});

// Fix C: the inner try records that its body threw, and the commit-status settle
// reads that flag, so a failed status write cannot replace the body's own error.
// reviewPr itself is not driveable offline (gh and git at its head), so this pins
// the wiring by source, the same way the call-site test above does.
describe("reviewPr's commit-status settle knows whether the body threw", () => {
  test("the inner catch marks the body failed and rethrows it, and the settle call passes the flag", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "../../src/pr/review-pr.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /\} catch \(error\) \{\s*bodyFailed = true;\s*throw error;\s*\} finally \{/,
    );
    const settle = /await settleCommitStatusAndLedger\(\{([\s\S]*?)\}\);/.exec(
      source,
    );
    expect(settle).not.toBeNull();
    expect(settle?.[1]).toMatch(/\bbodyFailed,/);
  });
});

describe("recordPipelineOutcome carries each failed hunter's cause", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function outcomeDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-hunter-causes-"));
    dirs.push(dir);
    return dir;
  }

  test("the record names each hunter's cause, provider and model", () => {
    const dir = outcomeDir();
    recordPipelineOutcome(
      {
        sessionFailed: true,
        hunterFailures: [
          { cause: "model_unavailable", provider: "opencode", model: "gpt-4o" },
          { cause: "model_unavailable", provider: "opencode", model: "gpt-4o" },
        ],
      },
      SHA,
      { PRHERO_OUTCOME_DIR: dir },
    );
    expect(
      parseCliRecord(readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8")),
    ).toEqual({
      v: 1,
      outcome: "hunters-failed",
      head_sha: SHA,
      hunter_failures: [
        { cause: "model_unavailable", provider: "opencode", model: "gpt-4o" },
        { cause: "model_unavailable", provider: "opencode", model: "gpt-4o" },
      ],
    });
  });

  test("a provider that is not a safe short string is left out, and the record still parses", () => {
    const dir = outcomeDir();
    recordPipelineOutcome(
      {
        sessionFailed: true,
        hunterFailures: [
          { cause: "model_unavailable", provider: "bad\nprovider" },
        ],
      },
      SHA,
      { PRHERO_OUTCOME_DIR: dir },
    );
    expect(
      parseCliRecord(readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8")),
    ).toEqual({
      v: 1,
      outcome: "hunters-failed",
      head_sha: SHA,
      hunter_failures: [{ cause: "model_unavailable" }],
    });
  });

  test("a failure with no transport cause is recorded as an entry without one", () => {
    const dir = outcomeDir();
    recordPipelineOutcome({ sessionFailed: true, hunterFailures: [{}] }, SHA, {
      PRHERO_OUTCOME_DIR: dir,
    });
    expect(
      parseCliRecord(readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8")),
    ).toEqual({
      v: 1,
      outcome: "hunters-failed",
      head_sha: SHA,
      hunter_failures: [{}],
    });
  });
});

// T5b: each adjudication verdict is posted as a reply on its finding's thread.
// The in-run verdict already settled this run's gate, so a failed post is a
// warning, never a failed run: the next run then counts the finding again,
// which fails closed.
describe("postAdjudicationReplies", () => {
  const HEAD = "d".repeat(40);
  const ADJUDICATION = {
    priorId: "R001",
    threadId: 100,
    replyId: 200,
    verdict: "upheld" as const,
    evidence: ["src/a.ts:10"],
  };

  // Same gh double shape pr.test.ts uses: one spawn per call, stdin recorded.
  function fakeGh(exitCode: number, stderr = "") {
    const calls: { argv: string[]; stdin: string | undefined }[] = [];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
      calls.push({
        argv,
        stdin:
          opts?.stdin === undefined ? undefined : decoder.decode(opts.stdin),
      });
      const stream = (text: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (text) controller.enqueue(encoder.encode(text));
            controller.close();
          },
        });
      return {
        stdout: stream(exitCode === 0 ? JSON.stringify({ id: 300 }) : ""),
        stderr: stream(stderr),
        exited: Promise.resolve(exitCode),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    return { spawnFn, calls };
  }

  test("POSTs one reply on the thread, carrying the marker, badge and evidence", async () => {
    const { spawnFn, calls } = fakeGh(0);
    await postAdjudicationReplies({
      operatorRoot: "/repo",
      pr: 42,
      headSha: HEAD,
      adjudications: [ADJUDICATION],
      spawnFn,
    });
    expect(calls).toHaveLength(1);
    const argv = calls[0]?.argv.join(" ") ?? "";
    expect(argv).toContain("--method POST");
    expect(argv).toContain("pulls/42/comments");
    expect(argv).toContain("in_reply_to=100");
    const body = calls[0]?.stdin ?? "";
    expect(
      body.startsWith(
        `<!-- pr-hero-adjudication verdict=upheld reply=200 head=${HEAD} -->`,
      ),
    ).toBe(true);
    expect(body).toContain("✅ **CI adjudication: upheld**");
    expect(body).toContain("Evidence:\n- `src/a.ts:10`");
  });

  test("a failed post prints a ::warning:: line and does not throw", async () => {
    const { spawnFn } = fakeGh(1, "boom");
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await postAdjudicationReplies({
        operatorRoot: "/repo",
        pr: 42,
        headSha: HEAD,
        adjudications: [ADJUDICATION],
        spawnFn,
      });
    } finally {
      process.stdout.write = original;
    }
    expect(
      lines.some((line) =>
        line.includes(
          "::warning::pr-hero: could not post the CI adjudication for R001:",
        ),
      ),
    ).toBe(true);
  });
});
