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
  type AdmissionStatusInput,
  type CiAdmissionLedgerState,
  holdCiAdmissionLedger,
  publishCiSkip,
  releaseCiAdmissionLedger,
  settleCiAdmissionLedger,
  settleHeldAdmissionLedgerOnSignal,
} from "#pr/admission";
import type {
  fetchCommitStatuses,
  fetchCommitStatusList,
  fetchPrCommitShas,
  repostMarkedPrComment,
} from "#pr/pr";
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
  // failure status. An admission skip or a manual-required verdict in gate mode
  // gets a status too (the decision is in admission.ts, admissionSkipDecision's
  // WHY): a skipped head must never read as a head nobody decided about.
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
      over: {
        ciMode?: "gate" | "advisory";
        headSha?: string;
        isCi?: boolean;
        admission?: AdmissionStatusInput;
        readStatuses?: typeof fetchCommitStatusList;
        listCommits?: typeof fetchPrCommitShas;
        readHeadStatus?: typeof fetchCommitStatuses;
      } = {},
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
        // No seam reaches gh by default: an empty commit list fails the carry closed, and an
        // empty head read is no override, so the status is written as planned.
        listCommits: async () => [],
        readHeadStatus: async () => [],
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

    // The override holds on the head itself: a re-run or reopen of the gate on an overridden head
    // must not write the skip's verdict over the human's decision. A read that fails writes as planned.
    describe("an override on the head stands over a skip's status", () => {
      const OVERRIDE_ROW = {
        state: "success",
        context: "pr-hero",
        created_at: "2026-10-17T11:00:00Z",
        description: "pr-hero: overridden by @alice",
      };
      const FAILURE_ROW = {
        state: "failure",
        context: "pr-hero",
        created_at: "2026-10-16T10:00:00Z",
        description:
          "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
      };

      // Captures what the process writes to stderr while `fn` runs (the skip's log lines).
      async function captureStderr<T>(
        fn: () => Promise<T>,
      ): Promise<{ result: T; stderr: string }> {
        const original = process.stderr.write;
        let stderr = "";
        process.stderr.write = ((chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        }) as typeof process.stderr.write;
        try {
          return { result: await fn(), stderr };
        } finally {
          process.stderr.write = original;
        }
      }

      test("an overridden head gets no status write, and one line says the override stands", async () => {
        const calls: StatusCall[] = [];
        const { result: code, stderr } = await captureStderr(() =>
          publishCiSkip(
            gateInput("skipped-size", recordingStatus(calls), {
              readHeadStatus: async () => [OVERRIDE_ROW, FAILURE_ROW],
            }),
          ),
        );
        expect(code).toBe(0);
        expect(calls).toEqual([]);
        expect(
          stderr.split("\n").filter((line) => line.includes("override")),
        ).toHaveLength(1);
      });

      test("a verdict newer than the override means it no longer stands: the write goes ahead", async () => {
        const calls: StatusCall[] = [];
        await publishCiSkip(
          gateInput("skipped-size", recordingStatus(calls), {
            readHeadStatus: async () => [
              { ...FAILURE_ROW, created_at: "2026-10-17T12:00:00Z" },
              OVERRIDE_ROW,
            ],
          }),
        );
        expect(calls.map((c) => c.state)).toEqual(["failure"]);
      });

      test("a head with no override takes the skip's status as planned", async () => {
        const calls: StatusCall[] = [];
        await publishCiSkip(
          gateInput("skipped-size", recordingStatus(calls), {
            readHeadStatus: async () => [FAILURE_ROW],
          }),
        );
        expect(calls.map((c) => c.state)).toEqual(["failure"]);
      });

      test("a failed head read writes the status as planned", async () => {
        const calls: StatusCall[] = [];
        await publishCiSkip(
          gateInput("skipped-size", recordingStatus(calls), {
            readHeadStatus: async () => {
              throw new CliError("gh timed out");
            },
          }),
        );
        expect(calls.map((c) => c.state)).toEqual(["failure"]);
      });
    });

    test("an admission skip without an admission verdict posts no status (other callers)", async () => {
      const calls: StatusCall[] = [];
      await publishCiSkip(
        gateInput("skipped-coverage", recordingStatus(calls)),
      );
      expect(calls).toEqual([]);
    });

    // Carry-forward (the owner's decision): a skipped head inherits the verdict
    // of the last reviewed head. The reviewed head is read from the summary, the
    // verdict from its own status list (never the combined endpoint, which would
    // show an override in place of the failure under it).
    describe("an admission skip carries the reviewed head's verdict", () => {
      const REVIEWED_HEAD = "a".repeat(40);
      const CARRIED_FROM = "carried from aaaaaaa";
      const T1 = "2026-10-16T10:00:00Z";
      const T2 = "2026-10-16T11:00:00Z";
      const BLOCKING_2 =
        "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override";
      const OVERRIDE = "pr-hero: overridden by @alice";

      type Row = {
        state: string;
        context: string;
        created_at: string;
        description?: string | null;
      };
      const row = (
        state: string,
        description: string,
        created_at: string,
        context = "pr-hero",
      ): Row => ({ state, context, created_at, description });

      // A status reader that records each call and answers with the rows given.
      function readerWith(rows: Row[] | null) {
        const reads: string[] = [];
        const read = async (_root: string, sha: string) => {
          reads.push(sha);
          return rows;
        };
        return { read, reads };
      }

      function admissionInput(
        reason: AdmissionStatusInput["reason"],
        over: { reviewedHead?: string | null; priorBlocking?: number } = {},
      ): AdmissionStatusInput {
        return {
          reason,
          reviewedHead:
            over.reviewedHead === undefined ? REVIEWED_HEAD : over.reviewedHead,
          priorBlocking: over.priorBlocking ?? 0,
        };
      }

      async function skipWith(
        rows: Row[] | null,
        reason: AdmissionStatusInput["reason"],
        over: {
          reviewedHead?: string | null;
          priorBlocking?: number;
          ciMode?: "gate" | "advisory";
          isCi?: boolean;
        } = {},
      ): Promise<{ calls: StatusCall[]; reads: string[] }> {
        const calls: StatusCall[] = [];
        const { read, reads } = readerWith(rows);
        await publishCiSkip(
          gateInput("skipped-coverage", recordingStatus(calls), {
            ciMode: over.ciMode ?? "gate",
            isCi: over.isCi ?? true,
            admission: admissionInput(reason, over),
            readStatuses: read,
            // The PR's commits, oldest first, the head last: the only earlier commit is the reviewed one.
            listCommits: async () => [REVIEWED_HEAD, STATUS_HEAD],
          }),
        );
        return { calls, reads };
      }

      test("a low-risk skip carries the reviewed head's failure, with its count, onto the new head", async () => {
        const { calls } = await skipWith(
          [row("failure", BLOCKING_2, T1)],
          "low-risk-delta",
        );
        expect(calls).toEqual([
          {
            sha: STATUS_HEAD,
            state: "failure",
            description: `pr-hero: 2 blocking finding(s) ${CARRIED_FROM} — fix and push, or /pr-hero override`,
            targetUrl: `${REPO_WEB_URL}/pull/${PR}`,
          },
        ]);
      });

      test("a below-threshold skip carries the reviewed head's success as no review needed", async () => {
        const { calls } = await skipWith(
          [row("success", "pr-hero: review posted", T1)],
          "below-threshold",
        );
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          [
            "success",
            `pr-hero: no review needed (prior findings below the re-review score floor); ${CARRIED_FROM}`,
          ],
        ]);
      });

      test("an override on the reviewed head is never carried: the failure under it is", async () => {
        const { calls } = await skipWith(
          [row("success", OVERRIDE, T2), row("failure", BLOCKING_2, T1)],
          "low-risk-delta",
        );
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          [
            "failure",
            `pr-hero: 2 blocking finding(s) ${CARRIED_FROM} — fix and push, or /pr-hero override`,
          ],
        ]);
      });

      test("the newest non-override verdict wins over an older one", async () => {
        const { calls } = await skipWith(
          [
            row("failure", BLOCKING_2, T1),
            row(
              "failure",
              "pr-hero: 3 blocking finding(s) — fix and push, or /pr-hero override",
              T2,
            ),
          ],
          "low-risk-delta",
        );
        expect(calls.map((c) => c.description)).toEqual([
          `pr-hero: 3 blocking finding(s) ${CARRIED_FROM} — fix and push, or /pr-hero override`,
        ]);
      });

      test("a pending or error row, or a row on another context, is no verdict: fail closed", async () => {
        const { calls } = await skipWith(
          [
            row("pending", "pr-hero reviewing", T2),
            row("error", "review did not finish", T2),
            row("failure", BLOCKING_2, T1, "pr-hero/local"),
          ],
          "low-risk-delta",
        );
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          [
            "failure",
            "pr-hero skipped the review (delta touches only low-risk paths) and found no earlier verdict — /pr-hero review reviews it",
          ],
        ]);
      });

      test("no reviewed head fails closed, and nothing is read", async () => {
        const { calls, reads } = await skipWith([], "once-per-pr", {
          reviewedHead: null,
        });
        expect(reads).toEqual([]);
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          [
            "failure",
            "pr-hero skipped the review (once_per_pr policy allows one automatic review) and found no earlier verdict — /pr-hero review reviews it",
          ],
        ]);
      });

      test("a failed status read fails closed rather than inheriting nothing", async () => {
        const { calls, reads } = await skipWith(null, "low-risk-delta");
        expect(reads).toEqual([REVIEWED_HEAD]);
        expect(calls.map((c) => c.state)).toEqual(["failure"]);
        expect(calls[0]?.description).toContain("found no earlier verdict");
      });

      test("a reviewed head with no status rows fails closed", async () => {
        const { calls } = await skipWith([], "low-risk-delta");
        expect(calls.map((c) => c.state)).toEqual(["failure"]);
        expect(calls[0]?.description).toContain("found no earlier verdict");
      });

      test("a carried failure with no count takes the admission's blocking count", async () => {
        const { calls } = await skipWith(
          [
            row(
              "failure",
              "pr-hero skipped the review: diff over the size gate. /pr-hero review reviews it anyway",
              T1,
            ),
          ],
          "low-risk-delta",
          { priorBlocking: 3 },
        );
        expect(calls.map((c) => c.description)).toEqual([
          `pr-hero: 3 blocking finding(s) ${CARRIED_FROM} — fix and push, or /pr-hero override`,
        ]);
      });

      test("a carried failure with no count and no blocking count fails closed", async () => {
        const { calls } = await skipWith(
          [
            row(
              "failure",
              "pr-hero skipped the review: diff over the size gate. /pr-hero review reviews it anyway",
              T1,
            ),
          ],
          "low-risk-delta",
          { priorBlocking: 0 },
        );
        expect(calls.map((c) => c.description)).toEqual([
          "pr-hero skipped the review (delta touches only low-risk paths) and found no earlier verdict — /pr-hero review reviews it",
        ]);
      });

      test("an exhausted budget is a failure naming the budget, never a carried green", async () => {
        const calls: StatusCall[] = [];
        const { read, reads } = readerWith([
          row("success", "pr-hero: review posted", T1),
        ]);
        await publishCiSkip(
          gateInput("manual-required", recordingStatus(calls), {
            admission: admissionInput("max-attempts-exhausted"),
            readStatuses: read,
          }),
        );
        expect(reads).toEqual([]);
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          [
            "failure",
            "pr-hero: review budget for this PR is used up — /pr-hero review reviews this head",
          ],
        ]);
      });

      test("a manual-only policy is a failure that names the manual trigger", async () => {
        const calls: StatusCall[] = [];
        const { read } = readerWith([]);
        await publishCiSkip(
          gateInput("manual-required", recordingStatus(calls), {
            admission: admissionInput("manual-only-policy"),
            readStatuses: read,
          }),
        );
        expect(calls.map((c) => c.state)).toEqual(["failure"]);
        expect(calls[0]?.description).toContain("manual_only");
        expect(calls[0]?.description).toContain(
          "/pr-hero review reviews this head",
        );
      });

      test("a same-head skip writes nothing: its status already exists", async () => {
        const { calls, reads } = await skipWith(
          [row("failure", BLOCKING_2, T1)],
          "same-head",
        );
        expect(calls).toEqual([]);
        expect(reads).toEqual([]);
      });

      test("advisory mode writes nothing, as today", async () => {
        const { calls } = await skipWith(
          [row("failure", BLOCKING_2, T1)],
          "low-risk-delta",
          { ciMode: "advisory" },
        );
        expect(calls).toEqual([]);
      });

      test("a run without --ci writes nothing", async () => {
        const { calls } = await skipWith(
          [row("failure", BLOCKING_2, T1)],
          "low-risk-delta",
          { ciMode: "advisory", isCi: false },
        );
        expect(calls).toEqual([]);
      });

      // The carry's source is this PR's own commit statuses: the newest earlier commit with a
      // verdict, walked from the head's index. The summary marker's head is never read for it.
      describe("the carry source is the PR's own commit statuses, not the summary's head", () => {
        const COMMIT_OLD = "c".repeat(40); // sha7 ccccccc
        const COMMIT_MID = "e".repeat(40); // sha7 eeeeeee
        const FORGED = "f".repeat(40);
        const LOW_RISK = "delta touches only low-risk paths";
        // The i-th commit of a synthetic PR, a distinct full sha for each i below 256.
        const shaAt = (i: number) => i.toString(16).padStart(2, "0").repeat(20);
        const GREEN = [row("success", "pr-hero: review posted", T1)];

        // `commits` is the PR's list, oldest first, the head last; `bySha` answers each commit's
        // status list (a missing sha reads as no rows, a null entry as a failed read).
        async function walk(
          commits: string[] | null,
          bySha: Record<string, Row[] | null>,
          over: {
            reviewedHead?: string | null;
            reason?: AdmissionStatusInput["reason"];
          } = {},
        ) {
          const calls: StatusCall[] = [];
          const reads: string[] = [];
          await publishCiSkip(
            gateInput("skipped-coverage", recordingStatus(calls), {
              admission: admissionInput(over.reason ?? "low-risk-delta", {
                reviewedHead: over.reviewedHead,
              }),
              listCommits: async () => commits,
              readStatuses: async (_root, sha) => {
                reads.push(sha);
                return sha in bySha ? (bySha[sha] ?? null) : [];
              },
            }),
          );
          return { calls, reads };
        }

        test("a forged summary head is never read: the verdict comes from the PR's own commits", async () => {
          const { calls, reads } = await walk(
            [COMMIT_OLD, COMMIT_MID, STATUS_HEAD],
            {
              [FORGED]: GREEN,
              [COMMIT_MID]: [row("failure", BLOCKING_2, T1)],
              [COMMIT_OLD]: GREEN,
            },
            { reviewedHead: FORGED },
          );
          expect(reads).not.toContain(FORGED);
          expect(calls.map((c) => [c.state, c.description])).toEqual([
            [
              "failure",
              "pr-hero: 2 blocking finding(s) carried from eeeeeee — fix and push, or /pr-hero override",
            ],
          ]);
        });

        test("a previous commit with no status is skipped: the one before it carries", async () => {
          const { calls, reads } = await walk(
            [COMMIT_OLD, COMMIT_MID, STATUS_HEAD],
            {
              [COMMIT_MID]: [],
              [COMMIT_OLD]: [row("success", "pr-hero: review posted", T1)],
            },
          );
          expect(reads).toEqual([COMMIT_MID, COMMIT_OLD]);
          expect(calls.map((c) => c.description)).toEqual([
            `pr-hero: no review needed (${LOW_RISK}); carried from ccccccc`,
          ]);
        });

        test("a status read that fails on an earlier commit fails closed, without skipping to an older verdict", async () => {
          const { calls, reads } = await walk(
            [COMMIT_OLD, COMMIT_MID, STATUS_HEAD],
            {
              [COMMIT_MID]: null,
              [COMMIT_OLD]: [row("success", "pr-hero: review posted", T1)],
            },
          );
          expect(reads).toEqual([COMMIT_MID]);
          expect(calls.map((c) => c.state)).toEqual(["failure"]);
          expect(calls[0]?.description).toContain("found no earlier verdict");
        });

        test("a commit list that cannot be read fails closed, and no status is read", async () => {
          const { calls, reads } = await walk(null, { [COMMIT_OLD]: GREEN });
          expect(reads).toEqual([]);
          expect(calls[0]?.state).toBe("failure");
          expect(calls[0]?.description).toContain("found no earlier verdict");
        });

        test("a head missing from the PR's commits fails closed, and no status is read", async () => {
          // A force-push, or a list cut short by GitHub's cap, leaves the head out of the list.
          const { calls, reads } = await walk([COMMIT_OLD, COMMIT_MID], {
            [COMMIT_OLD]: GREEN,
            [COMMIT_MID]: GREEN,
          });
          expect(reads).toEqual([]);
          expect(calls[0]?.state).toBe("failure");
          expect(calls[0]?.description).toContain("found no earlier verdict");
        });

        test("the walk reads at most 20 earlier commits: a verdict on the 21st is not found", async () => {
          const commits = [
            ...Array.from({ length: 21 }, (_, i) => shaAt(i + 1)),
            STATUS_HEAD,
          ];
          const { calls, reads } = await walk(commits, { [shaAt(1)]: GREEN });
          expect(reads).toHaveLength(20);
          expect(reads).not.toContain(shaAt(1));
          expect(calls[0]?.description).toContain("found no earlier verdict");
        });

        test("the walk reads 20 earlier commits: a verdict on the 20th is found", async () => {
          const commits = [
            ...Array.from({ length: 21 }, (_, i) => shaAt(i + 1)),
            STATUS_HEAD,
          ];
          const { calls, reads } = await walk(commits, { [shaAt(2)]: GREEN });
          expect(reads).toHaveLength(20);
          expect(calls.map((c) => c.description)).toEqual([
            `pr-hero: no review needed (${LOW_RISK}); carried from ${shaAt(2).slice(0, 7)}`,
          ]);
        });

        test("the current head is excluded even when it has a status", async () => {
          const { calls, reads } = await walk([COMMIT_OLD, STATUS_HEAD], {
            [STATUS_HEAD]: [row("failure", BLOCKING_2, T2)],
            [COMMIT_OLD]: GREEN,
          });
          expect(reads).toEqual([COMMIT_OLD]);
          expect(calls.map((c) => c.description)).toEqual([
            `pr-hero: no review needed (${LOW_RISK}); carried from ccccccc`,
          ]);
        });

        test("a verdict carried onto an earlier skipped head is a verdict, and carries again", async () => {
          const { calls } = await walk([COMMIT_OLD, COMMIT_MID, STATUS_HEAD], {
            [COMMIT_MID]: [
              row(
                "success",
                `pr-hero: no review needed (${LOW_RISK}); carried from ccccccc`,
                T2,
              ),
            ],
            [COMMIT_OLD]: [row("failure", BLOCKING_2, T1)],
          });
          expect(calls.map((c) => [c.state, c.description])).toEqual([
            [
              "success",
              `pr-hero: no review needed (${LOW_RISK}); carried from eeeeeee`,
            ],
          ]);
        });

        test("an override on an earlier commit does not stop the carry: the failure beneath it is carried", async () => {
          const { calls } = await walk([COMMIT_OLD, STATUS_HEAD], {
            [COMMIT_OLD]: [
              row("success", OVERRIDE, T2),
              row("failure", BLOCKING_2, T1),
            ],
          });
          expect(calls.map((c) => c.description)).toEqual([
            "pr-hero: 2 blocking finding(s) carried from ccccccc — fix and push, or /pr-hero override",
          ]);
        });
      });

      test("every fail-closed description names the unlock and fits the status limit", async () => {
        const carried: AdmissionStatusInput["reason"][] = [
          "once-per-pr",
          "below-threshold",
          "low-risk-delta",
        ];
        for (const reason of carried) {
          const { calls } = await skipWith([], reason);
          const description = calls[0]?.description ?? "";
          expect(description.endsWith("/pr-hero review reviews it")).toBe(true);
          expect(description.length).toBeLessThanOrEqual(140);
        }
      });
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
