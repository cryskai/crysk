// settleCiAdmissionLedger: the one guard that keeps a later exit (or
// teardown's finally) from overwriting a run that already reached a terminal
// status. The only gh boundary is the check-run upsert, doubled through
// `spawnFn`; the ledger record and the check run sent to GitHub are the
// observables.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AdmissionAttemptStatus,
  type AdmissionRecord,
  admissionRecordFingerprint,
} from "#ci/admission-ledger";
import { ciGateSkipOutputs } from "#ci/gates";
import { CLI_RECORD_FILE, parseCliRecord } from "#ci/outcome";
import {
  type CiAdmissionLedgerState,
  holdCiAdmissionLedger,
  publishCiSkip,
  releaseCiAdmissionLedger,
  settleCiAdmissionLedger,
  settleHeldAdmissionLedgerOnSignal,
} from "#pr/admission";
import type { repostMarkedPrComment } from "#pr/pr";
import type { publishFinalCommitStatus } from "#pr/status";
import { CliError } from "../../src/errors";

const HEAD = "b".repeat(40);
const PR = 7;
const POLICY_HASH = "0123456789abcdef";
const ORIGINAL_REASON = "reason recorded before settlement";
const SETTLE_REASON = "review path exited without terminal settlement";

function ledgerState(status: AdmissionAttemptStatus): CiAdmissionLedgerState {
  const record: AdmissionRecord = {
    schemaVersion: 1,
    prNumber: PR,
    headSha: HEAD,
    policyHash: POLICY_HASH,
    reservationId: admissionRecordFingerprint(PR, HEAD, POLICY_HASH),
    attemptNumber: 1,
    status,
    decisionReason: ORIGINAL_REASON,
    priorScore: null,
    blockingCount: null,
    advisoryCount: null,
    workflowRunId: null,
    createdAt: "2026-09-17T12:00:00.000Z",
    settledAt: null,
  };
  return { record, checkRunId: 11, headSha: HEAD, operatorRoot: "/repo" };
}

// A gh double: records every argv and answers with the given exit code and
// stdout, like `gh api` does.
function ghSpawn(response: { exitCode: number; stdout: string }): {
  spawnFn: typeof Bun.spawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const encoder = new TextEncoder();
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text) controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  const spawnFn = ((argv: string[]) => {
    calls.push(argv);
    return {
      stdout: stream(response.stdout),
      stderr: stream(response.exitCode === 0 ? "" : "gh: boom"),
      exited: Promise.resolve(response.exitCode),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

describe("settleCiAdmissionLedger — a terminal record is never re-settled", () => {
  test.each([
    "completed",
    "failed",
    "cancelled",
    "skipped",
    "yielded",
  ] as const)(
    "a %s record keeps its status and reason and nothing is sent to GitHub",
    async (terminal) => {
      const state = ledgerState(terminal);
      const { spawnFn, calls } = ghSpawn({ exitCode: 0, stdout: '{"id":99}' });

      await settleCiAdmissionLedger(state, "failed", SETTLE_REASON, {
        spawnFn,
      });

      expect(state.record.status).toBe(terminal);
      expect(state.record.decisionReason).toBe(ORIGINAL_REASON);
      expect(calls).toEqual([]);
    },
  );
});

describe("settleCiAdmissionLedger — a pending record is settled and published", () => {
  test.each(["reserved", "provider-started", "unknown"] as const)(
    "a %s record takes the new status and reason, and the check run carries it",
    async (pending) => {
      const state = ledgerState(pending);
      const { spawnFn, calls } = ghSpawn({ exitCode: 0, stdout: '{"id":99}' });

      await settleCiAdmissionLedger(state, "failed", SETTLE_REASON, {
        spawnFn,
      });

      expect(state.record.status).toBe("failed");
      expect(state.record.decisionReason).toBe(SETTLE_REASON);
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("output[summary]=failed (attempt 1)");
      expect(state.checkRunId).toBe(99);
    },
  );

  test("a gh failure still leaves the record settled and does not throw", async () => {
    const state = ledgerState("reserved");
    const { spawnFn } = ghSpawn({ exitCode: 1, stdout: "" });

    await settleCiAdmissionLedger(state, "failed", SETTLE_REASON, { spawnFn });

    expect(state.record.status).toBe("failed");
    expect(state.record.decisionReason).toBe(SETTLE_REASON);
    expect(state.checkRunId).toBe(11);
  });

  test("no reservation means nothing to settle and nothing sent", async () => {
    const { spawnFn, calls } = ghSpawn({ exitCode: 0, stdout: '{"id":99}' });

    await settleCiAdmissionLedger(null, "failed", SETTLE_REASON, { spawnFn });

    expect(calls).toEqual([]);
  });
});

describe("settleHeldAdmissionLedgerOnSignal", () => {
  test("a provider-started row becomes cancelled and is published", async () => {
    const state = ledgerState("provider-started");
    holdCiAdmissionLedger(state);
    const { spawnFn, calls } = ghSpawn({ exitCode: 0, stdout: '{"id":42}' });

    await settleHeldAdmissionLedgerOnSignal((held, status, reason, options) =>
      settleCiAdmissionLedger(held, status, reason, {
        ...options,
        spawnFn,
      }),
    );

    expect(state.record.status).toBe("cancelled");
    expect(state.record.decisionReason).toBe(
      "workflow cancelled before the review produced anything",
    );
    expect(calls.length).toBe(1);
  });

  test("a second signal finds nothing left to settle", async () => {
    const state = ledgerState("provider-started");
    holdCiAdmissionLedger(state);
    const settle = async () => {
      state.record = { ...state.record, status: "cancelled" };
    };
    await Promise.all([
      settleHeldAdmissionLedgerOnSignal(settle),
      settleHeldAdmissionLedgerOnSignal(settle),
    ]);
    expect(state.record.status).toBe("cancelled");
  });

  test("a completed row is not rewritten", async () => {
    const state = ledgerState("completed");
    holdCiAdmissionLedger(state);
    let calls = 0;
    await settleHeldAdmissionLedgerOnSignal(async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(state.record.status).toBe("completed");
    releaseCiAdmissionLedger();
  });
});

// T2c unit A (odd/tasks/agent-first-ci.md, S3): publishCiSkip is the single path
// for the size, budget, coverage and manual-required notices. In action mode it
// also leaves the skip kind in cli.json; the notice itself is unchanged.
describe("publishCiSkip: the outcome record", () => {
  const SKIP_CASES: ReadonlyArray<
    [
      Parameters<typeof ciGateSkipOutputs>[0],
      "size" | "budget" | "coverage" | "manual-required",
    ]
  > = [
    ["skipped-size", "size"],
    ["skipped-budget", "budget"],
    ["skipped-coverage", "coverage"],
    ["manual-required", "manual-required"],
  ];

  function planFor(status: Parameters<typeof ciGateSkipOutputs>[0]) {
    return {
      comment: "skip comment",
      markerPrefix: "<!-- pr-hero-skip-test -->",
      summaryMarkdown: "skip summary\n",
      outputs: ciGateSkipOutputs(status, 0),
    };
  }

  async function publish(
    status: Parameters<typeof ciGateSkipOutputs>[0],
  ): Promise<{ code: number; stderr: string }> {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await publishCiSkip({
        operatorRoot: "/unused",
        prNumber: PR,
        post: false,
        isCi: false,
        stepSummaryFlag: false,
        plan: planFor(status),
        noticeMessage: "pr-hero review skipped — fixture",
      });
      return { code, stderr: chunks.join("") };
    } finally {
      process.stderr.write = origWrite;
    }
  }

  test.each(SKIP_CASES)(
    "%s is recorded as skipped for %s, with no head (the plan carries none)",
    async (status, skip) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-skip-record-"));
      const saved = process.env.PRHERO_OUTCOME_DIR;
      process.env.PRHERO_OUTCOME_DIR = dir;
      try {
        expect((await publish(status)).code).toBe(0);
        const written = readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8");
        expect(parseCliRecord(written)).toEqual({
          v: 1,
          outcome: "skipped",
          skip,
        });
      } finally {
        restoreOutcomeDir(saved);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // S4: in gate mode a size or budget skip is a red head, so the skip posts a
  // failure status. Admission skips and manual-required post none in either
  // mode: they are an open decision, not a verdict on the diff.
  describe("commit status in gate mode (S4)", () => {
    const STATUS_HEAD = "d".repeat(40);
    let dir: string;
    let saved: string | undefined;

    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "prhero-skip-status-"));
      saved = process.env.PRHERO_OUTCOME_DIR;
      process.env.PRHERO_OUTCOME_DIR = dir;
    });

    afterEach(() => {
      restoreOutcomeDir(saved);
      rmSync(dir, { recursive: true, force: true });
    });

    type StatusCall = {
      sha: string;
      state: string;
      description: string;
      targetUrl: string | undefined;
    };

    // The run's repo web url, injected so no test shells out to `gh`.
    const REPO_WEB_URL = "https://github.com/org/repo";

    function recordingStatus(
      calls: StatusCall[],
      failWith?: Error,
    ): typeof publishFinalCommitStatus {
      return async (_root, sha, request) => {
        calls.push({
          sha,
          state: request.state,
          description: request.description,
          targetUrl: request.targetUrl,
        });
        if (failWith) throw failWith;
      };
    }

    function gateInput(
      status: Parameters<typeof ciGateSkipOutputs>[0],
      postStatus: typeof publishFinalCommitStatus,
      over: { ciMode?: "gate" | "advisory"; headSha?: string } = {},
    ) {
      return {
        operatorRoot: "/unused",
        prNumber: PR,
        post: false,
        isCi: true,
        stepSummaryFlag: false,
        plan: planFor(status),
        noticeMessage: "pr-hero review skipped — fixture",
        ciMode: "gate" as const,
        headSha: STATUS_HEAD,
        postStatus,
        repoWebUrl: async () => REPO_WEB_URL,
        ...over,
      };
    }

    // T3 advisory 3: a size or budget skip status names the run, like every
    // other status the CLI writes, so a reader can click through to the PR.
    test("a size skip's failure status carries the run's pull URL", async () => {
      const calls: StatusCall[] = [];
      await publishCiSkip(gateInput("skipped-size", recordingStatus(calls)));
      expect(calls[0]?.targetUrl).toBe(`${REPO_WEB_URL}/pull/${PR}`);
    });

    test("a budget skip's failure status carries the run's pull URL", async () => {
      const calls: StatusCall[] = [];
      await publishCiSkip(gateInput("skipped-budget", recordingStatus(calls)));
      expect(calls[0]?.targetUrl).toBe(`${REPO_WEB_URL}/pull/${PR}`);
    });

    test("a size skip in gate mode posts one failure status on the head, naming the unlock", async () => {
      const calls: StatusCall[] = [];
      const code = await publishCiSkip(
        gateInput("skipped-size", recordingStatus(calls)),
      );
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.sha).toBe(STATUS_HEAD);
      expect(calls[0]?.state).toBe("failure");
      expect(calls[0]?.description).toContain("size gate");
      expect(calls[0]?.description).toContain(
        "/pr-hero review reviews it anyway",
      );
    });

    test("a budget skip in gate mode posts failure too", async () => {
      const calls: StatusCall[] = [];
      await publishCiSkip(gateInput("skipped-budget", recordingStatus(calls)));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.state).toBe("failure");
      expect(calls[0]?.description).toContain("CI budget");
    });

    test("advisory mode posts no skip status, as today", async () => {
      const calls: StatusCall[] = [];
      await publishCiSkip(
        gateInput("skipped-size", recordingStatus(calls), {
          ciMode: "advisory",
        }),
      );
      expect(calls).toEqual([]);
    });

    test("an admission skip (coverage) in gate mode posts no status: an open decision", async () => {
      const calls: StatusCall[] = [];
      await publishCiSkip(
        gateInput("skipped-coverage", recordingStatus(calls)),
      );
      expect(calls).toEqual([]);
    });

    test("manual-required in gate mode posts no status", async () => {
      const calls: StatusCall[] = [];
      await publishCiSkip(gateInput("manual-required", recordingStatus(calls)));
      expect(calls).toEqual([]);
    });

    test("a size skip with no known head posts no status, even in gate mode", async () => {
      const calls: StatusCall[] = [];
      await publishCiSkip(
        gateInput("skipped-size", recordingStatus(calls), {
          headSha: undefined,
        }),
      );
      expect(calls).toEqual([]);
    });

    test("a failed status write in gate mode fails loud and leaves no skipped record", async () => {
      const calls: StatusCall[] = [];
      const failure = new CliError("commit status write failed");
      await expect(
        publishCiSkip(
          gateInput("skipped-size", recordingStatus(calls, failure)),
        ),
      ).rejects.toBe(failure);
      expect(calls).toHaveLength(1);
      // The record claims the skip reached the PR. The status is part of that
      // claim, so a status that did not land must not leave one behind.
      expect(existsSync(path.join(dir, CLI_RECORD_FILE))).toBe(false);
    });
  });

  // WHY the order: the skipped record tells the publisher the skip reached the
  // PR. Written before the repost, a notice that then failed would still read
  // as skipped, and the record would name an outcome that never happened.
  describe("with post on", () => {
    let dir: string;
    let saved: string | undefined;

    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "prhero-skip-post-"));
      saved = process.env.PRHERO_OUTCOME_DIR;
      process.env.PRHERO_OUTCOME_DIR = dir;
    });

    afterEach(() => {
      restoreOutcomeDir(saved);
      rmSync(dir, { recursive: true, force: true });
    });

    function skipInput(repost: typeof repostMarkedPrComment) {
      return {
        operatorRoot: "/unused",
        prNumber: PR,
        post: true,
        isCi: false,
        stepSummaryFlag: false,
        plan: planFor("skipped-size"),
        noticeMessage: "pr-hero review skipped — fixture",
        repost,
      };
    }

    function readRecord(): unknown {
      return parseCliRecord(
        readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8"),
      );
    }

    test("the skipped record is written only after the notice is reposted", async () => {
      let recordAtRepost: boolean | undefined;
      const repost = (async () => {
        recordAtRepost = existsSync(path.join(dir, CLI_RECORD_FILE));
        return { commentId: 1, deletedIds: [] };
      }) as typeof repostMarkedPrComment;
      expect(await publishCiSkip(skipInput(repost))).toBe(0);
      expect(recordAtRepost).toBe(false);
      expect(readRecord()).toEqual({ v: 1, outcome: "skipped", skip: "size" });
    });

    test("a notice that cannot be reposted records error at the notice step, never skipped, and rethrows", async () => {
      const failure = new CliError("gh api (post PR comment) failed: fixture");
      const repost = (async () => {
        throw failure;
      }) as typeof repostMarkedPrComment;
      await expect(publishCiSkip(skipInput(repost))).rejects.toBe(failure);
      expect(readRecord()).toEqual({
        v: 1,
        outcome: "error",
        cls: { kind: "unknown" },
        params: { step: "posting the skip notice" },
      });
    });

    test("with no outcome directory, a reposted notice writes nothing", async () => {
      delete process.env.PRHERO_OUTCOME_DIR;
      const repost = (async () => ({
        commentId: 1,
        deletedIds: [],
      })) as typeof repostMarkedPrComment;
      expect(await publishCiSkip(skipInput(repost))).toBe(0);
      expect(existsSync(path.join(dir, CLI_RECORD_FILE))).toBe(false);
    });
  });

  test("the notice and the exit code are identical with and without the outcome directory", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-skip-same-"));
    const saved = process.env.PRHERO_OUTCOME_DIR;
    try {
      delete process.env.PRHERO_OUTCOME_DIR;
      const without = await publish("skipped-size");
      expect(existsSync(path.join(dir, CLI_RECORD_FILE))).toBe(false);

      process.env.PRHERO_OUTCOME_DIR = dir;
      const withDir = await publish("skipped-size");
      expect(withDir).toEqual(without);
      expect(without.stderr).toContain("pr-hero review skipped — fixture");
    } finally {
      restoreOutcomeDir(saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function restoreOutcomeDir(saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env.PRHERO_OUTCOME_DIR;
  } else {
    process.env.PRHERO_OUTCOME_DIR = saved;
  }
}
