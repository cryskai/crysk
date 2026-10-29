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
  ADMISSION_CHECK_RUN_NAME,
  type AdmissionAttemptStatus,
  type AdmissionRecord,
  admissionRecordFingerprint,
  serializeAdmissionRecord,
} from "#ci/admission-ledger";
import { ciGateSkipOutputs } from "#ci/gates";
import { CLI_RECORD_FILE, parseCliRecord } from "#ci/outcome";
import {
  ciReviewPolicyHash,
  resolveCiReviewPolicy,
} from "#ci/review-admission";
import {
  type AdmissionStatusInput,
  type CiAdmissionLedgerState,
  carriedBlockingDescription,
  carriedSuccessDescription,
  holdCiAdmissionLedger,
  isReviewVerdictStatus,
  publishCiSkip,
  releaseCiAdmissionLedger,
  reserveCiAdmissionLedger,
  settleCiAdmissionLedger,
  settleHeldAdmissionLedgerOnSignal,
} from "#pr/admission";
import {
  fetchCommitStatuses,
  type fetchCommitStatusList,
  type fetchPrCommitShas,
  type repostMarkedPrComment,
} from "#pr/pr";
import {
  blockingCommitStatusRequest,
  COMMIT_STATUS_CONTEXT,
  commitStatusRequest,
  skipCommitStatusRequest,
} from "#pr/preflight";
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
      const saved = process.env.CRYSK_OUTCOME_DIR;
      process.env.CRYSK_OUTCOME_DIR = dir;
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
      saved = process.env.CRYSK_OUTCOME_DIR;
      process.env.CRYSK_OUTCOME_DIR = dir;
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
        spawnFn?: typeof Bun.spawn;
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

      // One gate over two names: an override an older action posted only on pr-hero still
      // stands over a newer-version crysk verdict that is older than it.
      test("an override on the legacy pr-hero context alone stands over an older crysk verdict", async () => {
        const calls: StatusCall[] = [];
        await publishCiSkip(
          gateInput("skipped-size", recordingStatus(calls), {
            readHeadStatus: async () => [
              { ...FAILURE_ROW, context: "crysk" },
              OVERRIDE_ROW,
            ],
          }),
        );
        expect(calls).toEqual([]);
      });

      test("an override on crysk stands, in the new description", async () => {
        const calls: StatusCall[] = [];
        await publishCiSkip(
          gateInput("skipped-size", recordingStatus(calls), {
            readHeadStatus: async () => [
              {
                ...OVERRIDE_ROW,
                context: "crysk",
                description: "crysk: overridden by @alice",
              },
              FAILURE_ROW,
            ],
          }),
        );
        expect(calls).toEqual([]);
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

      // The production reader, not a throwing seam: a non-zero gh exit is a failed read. The status is
      // written as planned, and one warning says the override could not be checked.
      test("a failed head read through the real reader writes the status as planned, and warns", async () => {
        const calls: StatusCall[] = [];
        const gh = ghSpawn({ exitCode: 1, stdout: "" });
        const { result: code, stderr } = await captureStderr(() =>
          publishCiSkip(
            gateInput("skipped-size", recordingStatus(calls), {
              readHeadStatus: undefined,
              spawnFn: gh.spawnFn,
            }),
          ),
        );
        expect(code).toBe(0);
        expect(
          gh.calls.some((argv) =>
            argv.join(" ").includes(`commits/${STATUS_HEAD}/status`),
          ),
        ).toBe(true);
        expect(calls.map((c) => [c.sha, c.state])).toEqual([
          [STATUS_HEAD, "failure"],
        ]);
        expect(stderr).toContain("::warning::");
        expect(stderr).toContain(STATUS_HEAD.slice(0, 7));
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
            description: `crysk: 2 blocking finding(s) ${CARRIED_FROM} — fix and push, or /pr-hero override`,
            targetUrl: `${REPO_WEB_URL}/pull/${PR}`,
          },
        ]);
      });

      // The rename: a verdict is written on crysk and, for one version, on pr-hero. The carry reads
      // either name as the gate and writes the new spelling.
      test("a verdict on the crysk context, in the new description, is carried in the new description", async () => {
        const { calls } = await skipWith(
          [
            row(
              "failure",
              "crysk: 2 blocking finding(s) — fix and push, or /pr-hero override",
              T1,
              "crysk",
            ),
          ],
          "low-risk-delta",
        );
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          [
            "failure",
            `crysk: 2 blocking finding(s) ${CARRIED_FROM} — fix and push, or /pr-hero override`,
          ],
        ]);
      });

      test("a legacy verdict only the pr-hero context carries, newer than a crysk green, is the one carried", async () => {
        const { calls } = await skipWith(
          [
            row("success", "review posted", T1, "crysk"),
            row("failure", BLOCKING_2, T2, "pr-hero"),
          ],
          "below-threshold",
        );
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          [
            "failure",
            `crysk: 2 blocking finding(s) ${CARRIED_FROM} — fix and push, or /pr-hero override`,
          ],
        ]);
      });

      // S5: a partial review is a red review verdict. A skip inherits it red, never the older green under it.
      const PARTIAL_1_OF_4 =
        "pr-hero: review partial (1 of 4 hunters failed, set 938084) — /pr-hero review retries it";
      const PARTIAL_CARRIED =
        "crysk: review partial (1 of 4 hunters failed, set 938084) carried from aaaaaaa — /pr-hero review retries it";

      // W3-PARTIAL S2: the repeat form is a review verdict, and it is a source for the carry: the skip
      // inherits today's carried text, because the carried form is generic and keeps its existing wording.
      test("the repeat form is a review verdict, and a skip carries it as the same carried text", async () => {
        const REPEAT_1_OF_4 =
          "pr-hero: review partial again (1 of 4 hunters failed, set 938084) — fix the failing route or /pr-hero override";
        expect(
          isReviewVerdictStatus({
            state: "failure",
            description: REPEAT_1_OF_4,
          }),
        ).toBe(true);
        const { calls } = await skipWith(
          [row("failure", REPEAT_1_OF_4, T1)],
          "low-risk-delta",
        );
        expect(calls).toEqual([
          {
            sha: STATUS_HEAD,
            state: "failure",
            description: PARTIAL_CARRIED,
            targetUrl: expect.any(String),
          },
        ]);
      });

      test("the matcher admits the partial text and its carried form as a review verdict", () => {
        expect(
          isReviewVerdictStatus({
            state: "failure",
            description: PARTIAL_1_OF_4,
          }),
        ).toBe(true);
        expect(
          isReviewVerdictStatus({
            state: "failure",
            description: PARTIAL_CARRIED,
          }),
        ).toBe(true);
        // A partial text with a wrong count shape, or the retry sentence removed, is no verdict.
        expect(
          isReviewVerdictStatus({
            state: "failure",
            description:
              "pr-hero: review partial (one of four) — /pr-hero review retries it",
          }),
        ).toBe(false);
      });

      // W4-R363 S1: a carry keeps the verdict's own failed-set key when it has one, and an earlier verdict
      // without a key is carried as the same earlier text, never upgraded to a key it never had.
      test("a skip carries an earlier partial verdict without a set key as that same text", async () => {
        const OLD_PARTIAL =
          "pr-hero: review partial (1 of 4 hunters failed) — /pr-hero review retries it";
        const { calls } = await skipWith(
          [row("failure", OLD_PARTIAL, T1)],
          "low-risk-delta",
        );
        expect(calls).toEqual([
          {
            sha: STATUS_HEAD,
            state: "failure",
            description:
              "crysk: review partial (1 of 4 hunters failed) carried from aaaaaaa — /pr-hero review retries it",
            targetUrl: `${REPO_WEB_URL}/pull/${PR}`,
          },
        ]);
      });

      test("a low-risk skip carries the reviewed head's partial failure, red, onto the new head", async () => {
        const { calls } = await skipWith(
          [row("failure", PARTIAL_1_OF_4, T1)],
          "low-risk-delta",
        );
        expect(calls).toEqual([
          {
            sha: STATUS_HEAD,
            state: "failure",
            description: PARTIAL_CARRIED,
            targetUrl: `${REPO_WEB_URL}/pull/${PR}`,
          },
        ]);
      });

      test("a partial failure newer than an older green is carried red, never the green", async () => {
        const { calls } = await skipWith(
          [
            row("success", "pr-hero: review complete", T1),
            row("failure", PARTIAL_1_OF_4, T2),
          ],
          "below-threshold",
        );
        expect(calls[0]?.state).toBe("failure");
        expect(calls[0]?.description).toBe(PARTIAL_CARRIED);
      });

      test("a below-threshold skip carries the reviewed head's success as no review needed", async () => {
        const { calls } = await skipWith(
          [row("success", "review posted", T1)],
          "below-threshold",
        );
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          [
            "success",
            `crysk: no review needed (prior findings below the re-review score floor); ${CARRIED_FROM}`,
          ],
        ]);
      });

      // A stop skips like the other carried reasons: it inherits the last verdict, red or green, and
      // never passes a head that has none.
      test("a stopped skip carries the reviewed head's blocking failure, so the gate stays red", async () => {
        const { calls } = await skipWith(
          [row("failure", BLOCKING_2, T1)],
          "stopped",
        );
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          [
            "failure",
            `crysk: 2 blocking finding(s) ${CARRIED_FROM} — fix and push, or /pr-hero override`,
          ],
        ]);
      });

      test("a stopped skip carries the reviewed head's success, naming the stop", async () => {
        const { calls } = await skipWith(
          [row("success", "review posted", T1)],
          "stopped",
        );
        const description = `crysk: no review needed (automatic reviews stopped by a maintainer); ${CARRIED_FROM}`;
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          ["success", description],
        ]);
        // The carried text is itself a verdict, so a later skip can chain from it.
        expect(isReviewVerdictStatus({ state: "success", description })).toBe(
          true,
        );
      });

      test("a stopped skip with no earlier verdict fails closed", async () => {
        const { calls } = await skipWith(null, "stopped");
        expect(calls.map((c) => [c.state, c.description])).toEqual([
          [
            "failure",
            "crysk skipped the review (automatic reviews stopped by a maintainer) and found no earlier verdict — /pr-hero review reviews it",
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
            `crysk: 2 blocking finding(s) ${CARRIED_FROM} — fix and push, or /pr-hero override`,
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
          `crysk: 3 blocking finding(s) ${CARRIED_FROM} — fix and push, or /pr-hero override`,
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
            "crysk skipped the review (delta touches only low-risk paths) and found no earlier verdict — /pr-hero review reviews it",
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
            "crysk skipped the review (once_per_pr policy allows one automatic review) and found no earlier verdict — /pr-hero review reviews it",
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

      // A size-skip failure is written with no review behind it, so it is no verdict. The admission's own
      // count (priorBlocking 3) must not rescue it into a carried "3 blocking finding(s)".
      test("a size-skip failure is no verdict, even with the admission's blocking count: fail closed", async () => {
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
          "crysk skipped the review (delta touches only low-risk paths) and found no earlier verdict — /pr-hero review reviews it",
        ]);
      });

      test("a size-skip failure with no admission count either: fail closed", async () => {
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
          "crysk skipped the review (delta touches only low-risk paths) and found no earlier verdict — /pr-hero review reviews it",
        ]);
      });

      test("an exhausted budget is a failure naming the budget, never a carried green", async () => {
        const calls: StatusCall[] = [];
        const { read, reads } = readerWith([
          row("success", "review posted", T1),
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
            "crysk: review budget for this PR is used up — /pr-hero review reviews this head",
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
        const GREEN = [row("success", "review posted", T1)];
        // Writers' own descriptions, so a drift in them fails these tests too.
        const SIZE_SKIP = skipCommitStatusRequest({
          kind: "size",
          targetUrl: undefined,
        }).description;
        const FAIL_CLOSED_LOW_RISK =
          "crysk skipped the review (delta touches only low-risk paths) and found no earlier verdict — /pr-hero review reviews it";

        // `commits` is the PR's list, oldest first, the head last; `bySha` answers each commit's
        // status list (a missing sha reads as no rows, a null entry as a failed read).
        async function walk(
          commits: string[] | null,
          bySha: Record<string, Row[] | null>,
          over: {
            reviewedHead?: string | null;
            reason?: AdmissionStatusInput["reason"];
            priorBlocking?: number;
          } = {},
        ) {
          const calls: StatusCall[] = [];
          const reads: string[] = [];
          await publishCiSkip(
            gateInput("skipped-coverage", recordingStatus(calls), {
              admission: admissionInput(over.reason ?? "low-risk-delta", {
                reviewedHead: over.reviewedHead,
                priorBlocking: over.priorBlocking,
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
              "crysk: 2 blocking finding(s) carried from eeeeeee — fix and push, or /pr-hero override",
            ],
          ]);
        });

        test("a previous commit with no status is skipped: the one before it carries", async () => {
          const { calls, reads } = await walk(
            [COMMIT_OLD, COMMIT_MID, STATUS_HEAD],
            {
              [COMMIT_MID]: [],
              [COMMIT_OLD]: [row("success", "review posted", T1)],
            },
          );
          expect(reads).toEqual([COMMIT_MID, COMMIT_OLD]);
          expect(calls.map((c) => c.description)).toEqual([
            `crysk: no review needed (${LOW_RISK}); carried from ccccccc`,
          ]);
        });

        test("a status read that fails on an earlier commit fails closed, without skipping to an older verdict", async () => {
          const { calls, reads } = await walk(
            [COMMIT_OLD, COMMIT_MID, STATUS_HEAD],
            {
              [COMMIT_MID]: null,
              [COMMIT_OLD]: [row("success", "review posted", T1)],
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
            `crysk: no review needed (${LOW_RISK}); carried from ${shaAt(2).slice(0, 7)}`,
          ]);
        });

        test("the current head is excluded even when it has a status", async () => {
          const { calls, reads } = await walk([COMMIT_OLD, STATUS_HEAD], {
            [STATUS_HEAD]: [row("failure", BLOCKING_2, T2)],
            [COMMIT_OLD]: GREEN,
          });
          expect(reads).toEqual([COMMIT_OLD]);
          expect(calls.map((c) => c.description)).toEqual([
            `crysk: no review needed (${LOW_RISK}); carried from ccccccc`,
          ]);
        });

        test("a verdict carried onto an earlier skipped head is a verdict, and carries again", async () => {
          const { calls } = await walk([COMMIT_OLD, COMMIT_MID, STATUS_HEAD], {
            [COMMIT_MID]: [
              row(
                "success",
                `crysk: no review needed (${LOW_RISK}); carried from ccccccc`,
                T2,
              ),
            ],
            [COMMIT_OLD]: [row("failure", BLOCKING_2, T1)],
          });
          expect(calls.map((c) => [c.state, c.description])).toEqual([
            [
              "success",
              `crysk: no review needed (${LOW_RISK}); carried from eeeeeee`,
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
            "crysk: 2 blocking finding(s) carried from ccccccc — fix and push, or /pr-hero override",
          ]);
        });

        // The walk takes only a review's verdict (a finished review, or a verdict carried from this PR).
        // A skip, a fail-closed, a budget or a manual-only failure is not one, so the walk passes over it.
        test("a green on an earlier commit is carried past a size-skip failure on the commit after it", async () => {
          const { calls } = await walk([COMMIT_OLD, COMMIT_MID, STATUS_HEAD], {
            [COMMIT_OLD]: GREEN,
            [COMMIT_MID]: [row("failure", SIZE_SKIP, T2)],
          });
          expect(calls.map((c) => [c.state, c.description])).toEqual([
            [
              "success",
              `crysk: no review needed (${LOW_RISK}); carried from ccccccc`,
            ],
          ]);
        });

        test("a red count on an earlier commit is carried past a fail-closed failure on the commit after it", async () => {
          const { calls } = await walk([COMMIT_OLD, COMMIT_MID, STATUS_HEAD], {
            [COMMIT_OLD]: [row("failure", BLOCKING_2, T1)],
            [COMMIT_MID]: [row("failure", FAIL_CLOSED_LOW_RISK, T2)],
          });
          expect(calls.map((c) => [c.state, c.description])).toEqual([
            [
              "failure",
              "crysk: 2 blocking finding(s) carried from ccccccc — fix and push, or /pr-hero override",
            ],
          ]);
        });

        // priorBlocking is 3 here on purpose: a skip counted as a verdict would carry "3 blocking", so
        // a fail-closed result proves the skip was passed over, not that it had no count.
        test("the walk reads past a skip failure to the next commit, and fails closed when only skips remain", async () => {
          const { calls, reads } = await walk(
            [COMMIT_OLD, COMMIT_MID, STATUS_HEAD],
            {
              [COMMIT_MID]: [row("failure", SIZE_SKIP, T2)],
              [COMMIT_OLD]: [row("failure", SIZE_SKIP, T1)],
            },
            { priorBlocking: 3 },
          );
          expect(reads).toEqual([COMMIT_MID, COMMIT_OLD]);
          expect(calls.map((c) => [c.state, c.description])).toEqual([
            [
              "failure",
              "crysk skipped the review (delta touches only low-risk paths) and found no earlier verdict — /pr-hero review reviews it",
            ],
          ]);
        });

        test("skip failures on every commit within the cap fail closed, and a verdict beyond the cap is not reached", async () => {
          const commits = [
            ...Array.from({ length: 21 }, (_, i) => shaAt(i + 1)),
            STATUS_HEAD,
          ];
          const bySha: Record<string, Row[] | null> = {
            [shaAt(1)]: GREEN,
          };
          for (let i = 2; i <= 21; i++) {
            bySha[shaAt(i)] = [row("failure", SIZE_SKIP, T1)];
          }
          const { calls, reads } = await walk(commits, bySha, {
            priorBlocking: 3,
          });
          expect(reads).toHaveLength(20);
          expect(reads).not.toContain(shaAt(1));
          expect(calls.map((c) => c.description)).toEqual([
            "crysk skipped the review (delta touches only low-risk paths) and found no earlier verdict — /pr-hero review reviews it",
          ]);
        });

        // The writers' own description families are the verdicts the walk takes; a skip, budget, or manual
        // failure is not. Each is built by the writer it names, so the test cannot drift from the code.
        test("a built finished review's success is taken as the verdict to carry", async () => {
          const posted = commitStatusRequest({
            phase: "success",
            posted: true,
            targetUrl: undefined,
            context: COMMIT_STATUS_CONTEXT,
          }).description;
          const { calls } = await walk([COMMIT_OLD, STATUS_HEAD], {
            [COMMIT_OLD]: [row("success", posted, T1)],
          });
          expect(calls.map((c) => c.description)).toEqual([
            `crysk: no review needed (${LOW_RISK}); carried from ccccccc`,
          ]);
        });

        test("a built finished review's blocking failure is taken with its count", async () => {
          const blocking = blockingCommitStatusRequest({
            blockingCount: 4,
            targetUrl: undefined,
            context: COMMIT_STATUS_CONTEXT,
          }).description;
          const { calls } = await walk([COMMIT_OLD, STATUS_HEAD], {
            [COMMIT_OLD]: [row("failure", blocking, T1)],
          });
          expect(calls.map((c) => c.description)).toEqual([
            "crysk: 4 blocking finding(s) carried from ccccccc — fix and push, or /pr-hero override",
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
      saved = process.env.CRYSK_OUTCOME_DIR;
      process.env.CRYSK_OUTCOME_DIR = dir;
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
      delete process.env.CRYSK_OUTCOME_DIR;
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
    const saved = process.env.CRYSK_OUTCOME_DIR;
    try {
      delete process.env.CRYSK_OUTCOME_DIR;
      const without = await publish("skipped-size");
      expect(existsSync(path.join(dir, CLI_RECORD_FILE))).toBe(false);

      process.env.CRYSK_OUTCOME_DIR = dir;
      const withDir = await publish("skipped-size");
      expect(withDir).toEqual(without);
      expect(without.stderr).toContain("pr-hero review skipped — fixture");
    } finally {
      restoreOutcomeDir(saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The verdict allowlist: a status is a review's verdict only when a writer of a verdict built its text.
// The positives are built by the writers themselves, so a drift in a writer fails here, not silently.
describe("isReviewVerdictStatus: a review's verdict, by the writers that build it", () => {
  const CARRIED_SHA = "c".repeat(40);
  const finished = (posted: boolean) =>
    commitStatusRequest({
      phase: "success",
      posted,
      targetUrl: undefined,
      context: COMMIT_STATUS_CONTEXT,
    }).description;
  const blocking = (blockingCount: number) =>
    blockingCommitStatusRequest({
      blockingCount,
      targetUrl: undefined,
      context: COMMIT_STATUS_CONTEXT,
    }).description;
  const skip = (kind: "size" | "budget") =>
    skipCommitStatusRequest({ kind, targetUrl: undefined }).description;

  test.each([
    ["review posted", "success", finished(true)],
    ["review complete", "success", finished(false)],
    ["one blocking finding", "failure", blocking(1)],
    ["twelve blocking findings", "failure", blocking(12)],
    [
      "a carried success",
      "success",
      carriedSuccessDescription(
        "delta touches only low-risk paths",
        CARRIED_SHA,
      ),
    ],
    [
      "a carried failure",
      "failure",
      carriedBlockingDescription(2, CARRIED_SHA),
    ],
  ])("%s is a verdict", (_name, state, description) => {
    expect(isReviewVerdictStatus({ state, description })).toBe(true);
  });

  test.each([
    ["a size skip", "failure", skip("size")],
    ["a budget skip", "failure", skip("budget")],
    [
      "a fail-closed failure",
      "failure",
      "pr-hero skipped the review (delta touches only low-risk paths) and found no earlier verdict — /pr-hero review reviews it",
    ],
    [
      "a budget used up",
      "failure",
      "pr-hero: review budget for this PR is used up — /pr-hero review reviews this head",
    ],
    [
      "a manual-only policy",
      "failure",
      "pr-hero: review needs a manual trigger (ci_review_policy is manual_only) — /pr-hero review reviews this head",
    ],
    ["an override", "success", "pr-hero: overridden by @alice"],
    ["a pending review", "pending", "pr-hero reviewing"],
    ["a crashed review", "error", "review did not finish"],
    ["zero blocking findings", "failure", blocking(0)],
    ["a success with no text", "success", null],
    ["a failure with no text", "failure", undefined],
    [
      "a carried success with the reason cut off",
      "success",
      "pr-hero: no review needed (delta touches only low-risk paths)",
    ],
    ["a verdict with a word added", "success", `${finished(true)} twice`],
  ])("%s is not a verdict", (_name, state, description) => {
    expect(isReviewVerdictStatus({ state, description })).toBe(false);
  });
});

// The override check's read (fetchCommitStatuses with failClosed). Through the real reader and a fake gh:
// a failed read must not look like a head with no status rows, a dropped row must not hide an override,
// and an empty successful read is still no rows.
describe("fetchCommitStatuses with failClosed", () => {
  test("a failed read throws, instead of answering no rows", async () => {
    const gh = ghSpawn({ exitCode: 1, stdout: "" });
    await expect(
      fetchCommitStatuses("/unused", HEAD, {
        spawnFn: gh.spawnFn,
        failClosed: true,
      }),
    ).rejects.toThrow(CliError);
  });

  test("a row that does not parse throws, because the row it drops could be the override", async () => {
    const gh = ghSpawn({
      exitCode: 0,
      stdout: `not-json\n${JSON.stringify({ state: "success", context: "pr-hero", created_at: "2026-10-17T11:00:00Z" })}\n`,
    });
    await expect(
      fetchCommitStatuses("/unused", HEAD, {
        spawnFn: gh.spawnFn,
        failClosed: true,
      }),
    ).rejects.toThrow(CliError);
  });

  test("a head with no status rows reads as no rows, not as a failure", async () => {
    const gh = ghSpawn({ exitCode: 0, stdout: "" });
    await expect(
      fetchCommitStatuses("/unused", HEAD, {
        spawnFn: gh.spawnFn,
        failClosed: true,
      }),
    ).resolves.toEqual([]);
  });

  test("an abbreviated sha throws, rather than answering no rows", async () => {
    const gh = ghSpawn({ exitCode: 0, stdout: "" });
    await expect(
      fetchCommitStatuses("/unused", "abc", {
        spawnFn: gh.spawnFn,
        failClosed: true,
      }),
    ).rejects.toThrow(CliError);
    expect(gh.calls).toHaveLength(0);
  });
});

function restoreOutcomeDir(saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env.CRYSK_OUTCOME_DIR;
  } else {
    process.env.CRYSK_OUTCOME_DIR = saved;
  }
}

// Review #360: a reserve POST that failed adopts a check run only when the
// run carries this call's POST nonce. A reused active record already belongs to
// another run's check run with the same external_id, attempt and createdAt, so
// those fields alone would make two workflow runs settle one row.
describe("reserveCiAdmissionLedger — adoption after a failed POST", () => {
  const RESERVE_POLICY = resolveCiReviewPolicy({});
  const RESERVE_HASH = ciReviewPolicyHash(RESERVE_POLICY);

  function failingPostGh(lookupStdout: string): {
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
      const lookup = argv.join(" ").includes("check_name=");
      return {
        stdout: stream(lookup ? lookupStdout : ""),
        stderr: stream(lookup ? "" : "gh timed out after 15000 ms"),
        exited: Promise.resolve(lookup ? 0 : 1),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    return { spawnFn, calls };
  }

  function rowFor(record: AdmissionRecord): string {
    return `${JSON.stringify({
      id: 812,
      name: ADMISSION_CHECK_RUN_NAME,
      status: "in_progress",
      external_id: record.reservationId,
      output: { text: serializeAdmissionRecord(record) },
    })}\n`;
  }

  test("a reused active record looks up but never adopts another run's check run", async () => {
    const active: AdmissionRecord = {
      schemaVersion: 1,
      prNumber: PR,
      headSha: HEAD,
      policyHash: RESERVE_HASH,
      reservationId: admissionRecordFingerprint(PR, HEAD, RESERVE_HASH),
      attemptNumber: 1,
      status: "reserved",
      decisionReason: ORIGINAL_REASON,
      priorScore: null,
      blockingCount: null,
      advisoryCount: null,
      workflowRunId: "111",
      createdAt: new Date().toISOString(),
      settledAt: null,
    };
    const { spawnFn, calls } = failingPostGh(rowFor(active));
    await expect(
      reserveCiAdmissionLedger({
        operatorRoot: "/repo",
        prNumber: PR,
        headSha: HEAD,
        policy: RESERVE_POLICY,
        policyHash: RESERVE_HASH,
        existing: [active],
        decisionReason: "admitted",
        spawnFn,
      }),
    ).rejects.toThrow("gh timed out after 15000 ms");
    // The sibling run has no nonce, so the lookup reads it as no match and the
    // POST is retried rather than adopted.
    expect(calls.some((argv) => argv.join(" ").includes("check_name="))).toBe(
      true,
    );
    expect(calls.filter((argv) => argv.includes("POST"))).toHaveLength(2);
  });

  test("a record this run created looks the failed POST up", async () => {
    const { spawnFn, calls } = failingPostGh("");
    await expect(
      reserveCiAdmissionLedger({
        operatorRoot: "/repo",
        prNumber: PR,
        headSha: HEAD,
        policy: RESERVE_POLICY,
        policyHash: RESERVE_HASH,
        existing: [],
        decisionReason: "admitted",
        spawnFn,
      }),
    ).rejects.toThrow("gh timed out after 15000 ms");
    expect(
      calls.filter((argv) => argv.join(" ").includes("check_name=")),
    ).toHaveLength(2);
  });
});
