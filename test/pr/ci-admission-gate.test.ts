// Offline behavior tests for pr/ci-admission-gate.ts's evaluateCiAdmissionGate
// — zero direct tests existed before this file (rg over test/ for the name
// returned nothing).
//
// Every gh()-backed call this gate makes (listAdmissionCheckRuns,
// fetchPrComments, fetchPrReviewComments, ghPrHeroWorkflowRunHeads,
// ghCompareChangedFilesWithStatus) already accepts an invisible-to-production
// `options.spawnFn` — the gate itself just never exposed it, so it gained one
// `spawnFn` field threaded to all five. `recordCiAdmissionGateSkip` has no
// spawnFn of its own (its ledger persist goes through admission.ts, out of
// scope for this slice), so the gate also gained a `recordSkip` seam.
// `publishCiSkip` is exercised FOR REAL (no seam): with `options.post` left
// unset it never touches gh, only the two env-path files GITHUB_STEP_SUMMARY
// and GITHUB_OUTPUT, so their content is asserted as the real observable
// instead of a fake's captured args. The exception is gate mode, which reads the
// reviewed head's status history and posts the carried verdict through the same
// spawnFn (the last describe in this file asserts those calls).
//
// Every test runs through withGateEnv, which snapshots and restores all four
// GitHub Actions env vars this gate reads. bun:test shares one process.env
// across every file in the run, and ci.yml runs `bun test` itself inside
// Actions where these vars are real — a bare `delete process.env.X` here
// would permanently erase Actions' own values for the rest of that run.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ADMISSION_CHECK_RUN_NAME,
  type AdmissionRecord,
  serializeAdmissionRecord,
} from "#ci/admission-ledger";
import { renderCiAdmissionBlock } from "#ci/review-admission";
import {
  type CiAdmissionLedgerState,
  settleCiAdmissionLedger,
  settleCiGateSkip,
} from "#pr/admission";
import {
  evaluateCiAdmissionGate,
  isCiConfigError,
  recordCiConfigErrorSkip,
  yieldToInFlightReview,
} from "#pr/ci-admission-gate";
import { CommentsTruncatedError, upsertAdmissionCheckRun } from "#pr/pr";
import {
  COMMIT_STATUS_CONTEXT,
  type CommitStatusContext,
  LOCAL_COMMIT_STATUS_CONTEXT,
  PR_COMMENT_MARKER_PREFIX,
} from "#pr/preflight";
import {
  type CliOptions,
  EMPTY_LOCAL_CONFIG,
  type LocalConfig,
} from "#review/preflight";
import { CliError } from "../../src/errors";

const PR = 42;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const GATE_ENV_KEYS = [
  "GITHUB_STEP_SUMMARY",
  "GITHUB_OUTPUT",
  "GITHUB_HEAD_REF",
  "GITHUB_ACTOR",
] as const;
type GateEnvKey = (typeof GATE_ENV_KEYS)[number];

// Snapshots and restores every env var this gate reads, so a test's absence
// of a value (e.g. no GITHUB_HEAD_REF) never leaks past this call — neither
// into the next test in this file nor, inside real CI, into Actions' own
// environment for the rest of the job.
async function withGateEnv<T>(
  overrides: Partial<Record<GateEnvKey, string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous: Partial<Record<GateEnvKey, string>> = {};
  for (const key of GATE_ENV_KEYS) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of GATE_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function baseOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    repo: "/repo",
    head: HEAD_B,
    full: false,
    hopBudget: 8,
    dryRun: false,
    yes: false,
    twoDot: false,
    onPush: false,
    force: false,
    all: false,
    fixes: false,
    incidents: false,
    issues: false,
    proximity: false,
    threads: false,
    ...overrides,
  };
}

function summaryComment(
  id: number,
  head: string,
  counts: { blocking: number; advisory: number },
  reviews: number,
): { id: number; user: string; body: string } {
  return {
    id,
    user: "pr-hero[bot]",
    body:
      `${PR_COMMENT_MARKER_PREFIX}head=${head} -->\n` +
      renderCiAdmissionBlock(head, counts, reviews),
  };
}

function admissionCheckRunRecord(
  overrides: Partial<AdmissionRecord> = {},
): AdmissionRecord {
  return {
    schemaVersion: 1,
    prNumber: PR,
    headSha: HEAD_B,
    policyHash: "deadbeefcafefeed",
    reservationId: "reservation-1",
    attemptNumber: 1,
    status: "completed",
    decisionReason: "review complete",
    priorScore: 2,
    blockingCount: 1,
    advisoryCount: 1,
    workflowRunId: null,
    createdAt: "2026-08-28T12:00:00.000Z",
    settledAt: "2026-08-28T12:05:00.000Z",
    ...overrides,
  };
}

// argv-substring matching, same shape as test/ci/admission-integration.test.ts's
// makeFakeGh — duplicated per this repo's convention that a test file's own
// gh fixture is not a shared module.
type ScriptEntry = {
  match: string[];
  response: { stdout?: string; stderr?: string; exitCode?: number };
};

// `calls`, when given, receives every argv: the yield tests below read the
// check-run upsert itself, since that request IS the ledger write.
function makeFakeGh(
  script: ScriptEntry[],
  calls?: string[][],
): typeof Bun.spawn {
  const encoder = new TextEncoder();
  return ((argv: string[]) => {
    calls?.push(argv);
    const joined = argv.join(" ");
    const entry = script.find((s) =>
      s.match.every((token) => joined.includes(token)),
    );
    const scripted = entry?.response ?? { stdout: "", exitCode: 0 };
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    return {
      stdout: stream(scripted.stdout ?? ""),
      stderr: stream(scripted.stderr ?? ""),
      exited: Promise.resolve(scripted.exitCode ?? 0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
}

const EMPTY_CHECK_RUNS: ScriptEntry = {
  match: ["check-runs"],
  response: { stdout: "" },
};
const EMPTY_REVIEW_COMMENTS: ScriptEntry = {
  match: ["pulls", "comments"],
  response: { stdout: "" },
};
const REPO_VIEW: ScriptEntry = {
  match: ["repo", "view", "owner,name"],
  response: {
    stdout: JSON.stringify({ owner: { login: "acme" }, name: "widgets" }),
  },
};
const compareResponse = (changedPath: string): ScriptEntry => ({
  match: ["compare"],
  response: {
    stdout: JSON.stringify({
      files: [{ filename: changedPath, status: "modified" }],
    }),
  },
});

async function tmpCiFiles(): Promise<{
  summaryPath: string;
  outputPath: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-gate-"));
  return {
    summaryPath: path.join(dir, "step-summary.md"),
    outputPath: path.join(dir, "outputs.txt"),
  };
}

describe("evaluateCiAdmissionGate — early no-op guards", () => {
  test("a dry run touches no gh call and resolves the default policy", async () => {
    const result = await withGateEnv({}, () =>
      evaluateCiAdmissionGate({
        ciMode: "advisory",
        operatorRoot: "/repo",
        prNumber: PR,
        headSha: HEAD_B,
        config: EMPTY_LOCAL_CONFIG,
        isCi: true,
        options: baseOptions({ dryRun: true }),
        // No spawnFn: any gh call here would throw "gh not found on PATH" in
        // an environment without gh installed, or make a real network call
        // in one that has it — either way, this proves the guard, not a mock.
      }),
    );
    expect(result).toEqual({
      ciPolicy: {
        schemaVersion: 1,
        mode: "risk_aware",
        maxAttempts: 2,
        rereviewMinScore: expect.any(Number),
        blockingWeight: expect.any(Number),
        advisoryWeight: expect.any(Number),
        reservationTtlSeconds: expect.any(Number),
      },
      ciPolicyHash: expect.any(String),
      ledgerRecords: [],
      exitCode: undefined,
    });
  });

  test("outside CI, the gate is a pure pass-through", async () => {
    const result = await withGateEnv({}, () =>
      evaluateCiAdmissionGate({
        ciMode: "advisory",
        operatorRoot: "/repo",
        prNumber: PR,
        headSha: HEAD_B,
        config: EMPTY_LOCAL_CONFIG,
        isCi: false,
        options: baseOptions({ dryRun: false, force: false }),
      }),
    );
    expect(result.ledgerRecords).toEqual([]);
    expect(result.exitCode).toBeUndefined();
  });

  test("--force reads the real ledger row back but skips the admission decision", async () => {
    // The comments fetch is scripted to return an already-reviewed-this-head
    // summary — a decision the admission block would turn into a "skip" if
    // --force did not bypass it entirely. A silent no-op here would not
    // distinguish "guard held" from "guard bypassed on harmless input", so
    // the script deliberately hands it a non-harmless one. The check-runs
    // response also carries one real record, so an empty ledgerRecords
    // result can only mean "read and got nothing", never "never read".
    const record = admissionCheckRunRecord();
    const spawnFn = makeFakeGh([
      {
        match: ["check-runs"],
        response: {
          stdout: `${JSON.stringify({
            name: ADMISSION_CHECK_RUN_NAME,
            status: "completed",
            output: { text: serializeAdmissionRecord(record) },
          })}\n`,
        },
      },
      {
        match: ["issues", "comments"],
        response: {
          stdout: `${JSON.stringify(summaryComment(1, HEAD_B, { blocking: 0, advisory: 1 }, 1))}\n`,
        },
      },
      EMPTY_REVIEW_COMMENTS,
    ]);
    const recordCalls: unknown[] = [];
    const result = await withGateEnv({}, () =>
      evaluateCiAdmissionGate({
        ciMode: "advisory",
        operatorRoot: "/repo",
        prNumber: PR,
        headSha: HEAD_B,
        config: EMPTY_LOCAL_CONFIG,
        isCi: true,
        options: baseOptions({ dryRun: false, force: true }),
        spawnFn,
        recordSkip: async (recorded) => {
          recordCalls.push(recorded);
        },
      }),
    );
    expect(result.ledgerRecords).toEqual([record]);
    expect(result.exitCode).toBeUndefined();
    expect(recordCalls).toEqual([]);
  });
});

describe("evaluateCiAdmissionGate — admission decisions", () => {
  test("a PR with no posted summary comment runs, recording nothing", async () => {
    const spawnFn = makeFakeGh([
      EMPTY_CHECK_RUNS,
      { match: ["issues", "comments"], response: { stdout: "" } },
      EMPTY_REVIEW_COMMENTS,
    ]);
    const recordCalls: unknown[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    const result = await withGateEnv(
      { GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outputPath },
      () =>
        evaluateCiAdmissionGate({
          ciMode: "advisory",
          operatorRoot: "/repo",
          prNumber: PR,
          headSha: HEAD_B,
          config: EMPTY_LOCAL_CONFIG,
          isCi: true,
          options: baseOptions(),
          spawnFn,
          recordSkip: async (recorded) => {
            recordCalls.push(recorded);
          },
        }),
    );
    expect(result.exitCode).toBeUndefined();
    expect(recordCalls).toEqual([]);
    await expect(readFile(summaryPath, "utf8")).rejects.toThrow();
  });

  test("re-running the same reviewed head skips, records it, and publishes the coverage-skip step summary", async () => {
    const spawnFn = makeFakeGh([
      EMPTY_CHECK_RUNS,
      {
        match: ["issues", "comments"],
        response: {
          stdout: `${JSON.stringify(summaryComment(1, HEAD_B, { blocking: 0, advisory: 1 }, 1))}\n`,
        },
      },
      EMPTY_REVIEW_COMMENTS,
    ]);
    const recordCalls: { reason: string; headSha: string }[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    const result = await withGateEnv(
      { GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outputPath },
      () =>
        evaluateCiAdmissionGate({
          ciMode: "advisory",
          operatorRoot: "/repo",
          prNumber: PR,
          headSha: HEAD_B,
          config: EMPTY_LOCAL_CONFIG,
          isCi: true,
          options: baseOptions(),
          spawnFn,
          recordSkip: async (recorded) => {
            recordCalls.push({
              reason: recorded.reason,
              headSha: recorded.headSha,
            });
          },
        }),
    );
    expect(result.exitCode).toBe(0);
    expect(recordCalls).toEqual([
      { reason: "this commit was already reviewed", headSha: HEAD_B },
    ]);
    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("this commit was already reviewed");
    const outputs = await readFile(outputPath, "utf8");
    expect(outputs).toContain("status=skipped-coverage");
  });

  test("an exhausted attempt budget on a new head requires manual override", async () => {
    const spawnFn = makeFakeGh([
      EMPTY_CHECK_RUNS,
      {
        match: ["issues", "comments"],
        response: {
          stdout: `${JSON.stringify(summaryComment(1, HEAD_A, { blocking: 0, advisory: 1 }, 2))}\n`,
        },
      },
      EMPTY_REVIEW_COMMENTS,
      REPO_VIEW,
      compareResponse("docs/readme.md"),
    ]);
    const recordCalls: { reason: string }[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    const result = await withGateEnv(
      { GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outputPath },
      () =>
        evaluateCiAdmissionGate({
          ciMode: "advisory",
          operatorRoot: "/repo",
          prNumber: PR,
          headSha: HEAD_B,
          config: EMPTY_LOCAL_CONFIG,
          isCi: true,
          options: baseOptions(),
          spawnFn,
          recordSkip: async (recorded) => {
            recordCalls.push({ reason: recorded.reason });
          },
        }),
    );
    expect(result.exitCode).toBe(0);
    expect(recordCalls).toEqual([
      {
        reason: "automatic review budget exhausted (2/2 attempts on this PR).",
      },
    ]);
    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("automatic review budget exhausted");
    expect(summary).toContain("Remaining budget");
    const outputs = await readFile(outputPath, "utf8");
    expect(outputs).toContain("status=manual-required");
  });

  test("observe-only mode logs a would-skip decision but never records or publishes it", async () => {
    const spawnFn = makeFakeGh([
      EMPTY_CHECK_RUNS,
      {
        match: ["issues", "comments"],
        response: {
          stdout: `${JSON.stringify(summaryComment(1, HEAD_B, { blocking: 0, advisory: 1 }, 1))}\n`,
        },
      },
      EMPTY_REVIEW_COMMENTS,
    ]);
    const recordCalls: unknown[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    const observeOnlyConfig: LocalConfig = {
      ...EMPTY_LOCAL_CONFIG,
      ci_admission_observe_only: true,
    };
    const result = await withGateEnv(
      { GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outputPath },
      () =>
        evaluateCiAdmissionGate({
          ciMode: "advisory",
          operatorRoot: "/repo",
          prNumber: PR,
          headSha: HEAD_B,
          config: observeOnlyConfig,
          isCi: true,
          options: baseOptions(),
          spawnFn,
          recordSkip: async (recorded) => {
            recordCalls.push(recorded);
          },
        }),
    );
    expect(result.exitCode).toBeUndefined();
    expect(recordCalls).toEqual([]);
    await expect(readFile(summaryPath, "utf8")).rejects.toThrow();
  });

  test("a truncated comment fetch fails open to run, recording nothing", async () => {
    const spawnFn = (() => {
      throw new CommentsTruncatedError("comments truncated");
    }) as unknown as typeof Bun.spawn;
    // Only the comments fetch needs to throw; give evaluateCiAdmissionGate a
    // fake that always throws to prove the catch block, not a scripted
    // response, is what keeps this offline.
    const recordCalls: unknown[] = [];
    const result = await withGateEnv({}, () =>
      evaluateCiAdmissionGate({
        ciMode: "advisory",
        operatorRoot: "/repo",
        prNumber: PR,
        headSha: HEAD_B,
        config: EMPTY_LOCAL_CONFIG,
        isCi: true,
        options: baseOptions(),
        spawnFn,
        recordSkip: async (recorded) => {
          recordCalls.push(recorded);
        },
      }),
    );
    expect(result.exitCode).toBeUndefined();
    expect(recordCalls).toEqual([]);
  });
});

// yieldToInFlightReview: the second stand-down point, after reviewPr already
// reserved a CI ledger row. Both gh calls it makes (the commit-status read
// and the check-run upsert inside the real settleCiAdmissionLedger) go
// through one fake, so the observables are the exit code, the ledger record,
// the check-run request GitHub would receive, and the stderr line.
// #326, end to end through the gate: the PR's first head was budget-skipped
// (its run concluded success, spent nothing), the second was reviewed, and a
// third head arrives. The gate must admit the third head, and it must read
// each other head's ledger exactly once (the bounded-I/O half of the fix).
describe("evaluateCiAdmissionGate — a gate-skipped head does not spend an attempt (#326)", () => {
  const HEAD_C = "c".repeat(40);

  test("the gate admits the new head and reads each other workflow head's ledger once", async () => {
    const gateSkipped = admissionCheckRunRecord({
      headSha: HEAD_A,
      reservationId: "reservation-gate-skip",
      status: "gate-skipped",
      decisionReason: "estimated cost exceeds the configured CI budget ceiling",
    });
    const checkRunLine = (record: AdmissionRecord) =>
      `${JSON.stringify({
        id: 1,
        name: "pr-hero/ci-admission",
        status: "completed",
        output: { text: JSON.stringify(record) },
      })}\n`;
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [
        {
          match: ["run", "list"],
          response: {
            stdout: JSON.stringify([
              { headSha: HEAD_A, conclusion: "success" },
              { headSha: HEAD_B, conclusion: "success" },
            ]),
          },
        },
        {
          match: [`commits/${HEAD_A}/check-runs`],
          response: { stdout: checkRunLine(gateSkipped) },
        },
        {
          match: [`commits/${HEAD_B}/check-runs`],
          response: { stdout: checkRunLine(admissionCheckRunRecord()) },
        },
        {
          match: ["issues", "comments"],
          response: {
            stdout: `${JSON.stringify(summaryComment(1, HEAD_B, { blocking: 0, advisory: 1 }, 1))}\n`,
          },
        },
        EMPTY_REVIEW_COMMENTS,
        REPO_VIEW,
        compareResponse("src/pipeline.ts"),
        EMPTY_CHECK_RUNS,
      ],
      calls,
    );
    const recordCalls: unknown[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    const result = await withGateEnv(
      {
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_HEAD_REF: "feat/gate-skip",
      },
      () =>
        evaluateCiAdmissionGate({
          ciMode: "advisory",
          operatorRoot: "/repo",
          prNumber: PR,
          headSha: HEAD_C,
          config: EMPTY_LOCAL_CONFIG,
          isCi: true,
          options: baseOptions({ head: HEAD_C }),
          spawnFn,
          recordSkip: async (recorded) => {
            recordCalls.push(recorded);
          },
        }),
    );

    expect(result.exitCode).toBeUndefined();
    expect(recordCalls).toEqual([]);
    const readsOf = (head: string) =>
      calls.filter((argv) =>
        argv.join(" ").includes(`commits/${head}/check-runs`),
      ).length;
    expect(readsOf(HEAD_A)).toBe(1);
    expect(readsOf(HEAD_B)).toBe(1);
    expect(readsOf(HEAD_C)).toBe(1);
  });

  // F002: GitHub's check-runs endpoint defaults to filter=latest, which hides
  // every earlier admission attempt on a head. The fake below answers with the
  // newest row only unless the request carries filter=all, so this goes red
  // unless the per-head read asks for history through the real shell.
  test("keeps a head whose history has a completed attempt even though its latest row is gate-skipped", async () => {
    const completed = admissionCheckRunRecord({
      headSha: HEAD_A,
      reservationId: "reservation-a-completed",
      status: "completed",
      attemptNumber: 1,
    });
    const gateSkipped = admissionCheckRunRecord({
      headSha: HEAD_A,
      reservationId: "reservation-a-gate-skip",
      status: "gate-skipped",
      attemptNumber: 2,
      decisionReason: "estimated cost exceeds the configured CI budget ceiling",
    });
    const checkRunLine = (record: AdmissionRecord) =>
      `${JSON.stringify({
        id: 1,
        name: "pr-hero/ci-admission",
        status: "completed",
        output: { text: JSON.stringify(record) },
      })}\n`;
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [
        {
          match: ["run", "list"],
          response: {
            stdout: JSON.stringify([
              { headSha: HEAD_A, conclusion: "success" },
              { headSha: HEAD_B, conclusion: "success" },
            ]),
          },
        },
        {
          // Listed before the plain entry below, which also matches this URL.
          match: [`commits/${HEAD_A}/check-runs`, "filter=all"],
          response: {
            stdout: checkRunLine(completed) + checkRunLine(gateSkipped),
          },
        },
        {
          match: [`commits/${HEAD_A}/check-runs`],
          response: { stdout: checkRunLine(gateSkipped) },
        },
        {
          match: [`commits/${HEAD_B}/check-runs`],
          response: { stdout: checkRunLine(admissionCheckRunRecord()) },
        },
        {
          match: ["issues", "comments"],
          response: {
            stdout: `${JSON.stringify(summaryComment(1, HEAD_B, { blocking: 0, advisory: 1 }, 1))}\n`,
          },
        },
        EMPTY_REVIEW_COMMENTS,
        REPO_VIEW,
        compareResponse("src/pipeline.ts"),
        EMPTY_CHECK_RUNS,
      ],
      calls,
    );
    const recordCalls: { reason: string }[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    const result = await withGateEnv(
      {
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_HEAD_REF: "feat/gate-skip",
      },
      () =>
        evaluateCiAdmissionGate({
          ciMode: "advisory",
          operatorRoot: "/repo",
          prNumber: PR,
          headSha: HEAD_C,
          config: EMPTY_LOCAL_CONFIG,
          isCi: true,
          options: baseOptions({ head: HEAD_C }),
          spawnFn,
          recordSkip: async (recorded) => {
            recordCalls.push({ reason: recorded.reason });
          },
        }),
    );

    // HEAD_A and HEAD_B both spent an attempt, so maxAttempts (2) is exhausted
    // and the gate records a manual-required skip. A dropped HEAD_A would leave
    // one attempt and let the run through.
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]?.reason).toBe(
      "automatic review budget exhausted (2/2 attempts on this PR).",
    );
    expect(result.exitCode).toBe(0);

    const checkRunReads = (head: string) =>
      calls
        .map((argv) => argv.join(" "))
        .filter((line) => line.includes(`commits/${head}/check-runs`));
    // The per-head reads ask for history. HEAD_C is not a workflow head in this
    // test, so its only read is the latest-only ledgerRecords read, which must
    // not ask for history. The history read for a current head that IS a
    // workflow head is asserted in the next test.
    expect(checkRunReads(HEAD_A)).toHaveLength(1);
    expect(checkRunReads(HEAD_A)[0]).toContain("filter=all");
    expect(checkRunReads(HEAD_B)).toHaveLength(1);
    expect(checkRunReads(HEAD_B)[0]).toContain("filter=all");
    expect(checkRunReads(HEAD_C)).toHaveLength(1);
    expect(checkRunReads(HEAD_C)[0]).not.toContain("filter=all");
  });

  // The current head can be a workflow head too (a prior concluded run on this
  // same head). Its newest row alone is gate-skipped, which looks unspent, but
  // its history holds a failed attempt that spent. The head must stay counted:
  // dropping it would admit a review past the budget. The count map must read
  // that history; ledgerRecords stays latest-only for its other readers.
  test("keeps the current head when its latest row is gate-skipped but its history has a failed attempt", async () => {
    const failed = admissionCheckRunRecord({
      headSha: HEAD_C,
      reservationId: "reservation-c-failed",
      status: "failed",
      attemptNumber: 1,
    });
    const gateSkipped = admissionCheckRunRecord({
      headSha: HEAD_C,
      reservationId: "reservation-c-gate-skip",
      status: "gate-skipped",
      attemptNumber: 2,
      decisionReason: "estimated cost exceeds the configured CI budget ceiling",
    });
    const checkRunLine = (record: AdmissionRecord) =>
      `${JSON.stringify({
        id: 1,
        name: "pr-hero/ci-admission",
        status: "completed",
        output: { text: JSON.stringify(record) },
      })}\n`;
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [
        {
          match: ["run", "list"],
          response: {
            stdout: JSON.stringify([
              { headSha: HEAD_B, conclusion: "success" },
              { headSha: HEAD_C, conclusion: "success" },
            ]),
          },
        },
        {
          // Listed before the plain entry below, which also matches this URL.
          match: [`commits/${HEAD_C}/check-runs`, "filter=all"],
          response: {
            stdout: checkRunLine(failed) + checkRunLine(gateSkipped),
          },
        },
        {
          match: [`commits/${HEAD_C}/check-runs`],
          response: { stdout: checkRunLine(gateSkipped) },
        },
        {
          match: [`commits/${HEAD_B}/check-runs`],
          response: { stdout: checkRunLine(admissionCheckRunRecord()) },
        },
        {
          match: ["issues", "comments"],
          response: {
            stdout: `${JSON.stringify(summaryComment(1, HEAD_B, { blocking: 0, advisory: 1 }, 1))}\n`,
          },
        },
        EMPTY_REVIEW_COMMENTS,
        REPO_VIEW,
        compareResponse("src/pipeline.ts"),
        EMPTY_CHECK_RUNS,
      ],
      calls,
    );
    const recordCalls: { reason: string }[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    const result = await withGateEnv(
      {
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_HEAD_REF: "feat/gate-skip",
      },
      () =>
        evaluateCiAdmissionGate({
          ciMode: "advisory",
          operatorRoot: "/repo",
          prNumber: PR,
          headSha: HEAD_C,
          config: EMPTY_LOCAL_CONFIG,
          isCi: true,
          options: baseOptions({ head: HEAD_C }),
          spawnFn,
          recordSkip: async (recorded) => {
            recordCalls.push({ reason: recorded.reason });
          },
        }),
    );

    // HEAD_B (completed) and HEAD_C (failed, then gate-skipped) both spent, so
    // maxAttempts (2) is exhausted and the gate records a manual-required skip.
    // A dropped HEAD_C would leave one attempt and admit the review.
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]?.reason).toBe(
      "automatic review budget exhausted (2/2 attempts on this PR).",
    );
    expect(result.exitCode).toBe(0);

    const checkRunReads = (head: string) =>
      calls
        .map((argv) => argv.join(" "))
        .filter((line) => line.includes(`commits/${head}/check-runs`));
    // HEAD_C is read twice: the history read for the workflow-head count, and
    // the latest-only read that ledgerRecords (reservation and terminal
    // counting) still uses.
    const headCReads = checkRunReads(HEAD_C);
    expect(headCReads).toHaveLength(2);
    expect(
      headCReads.filter((line) => line.includes("filter=all")),
    ).toHaveLength(1);
    expect(
      headCReads.filter((line) => !line.includes("filter=all")),
    ).toHaveLength(1);
  });
});

// #326: the SIZE gate and the BUDGET gate settle through settleCiGateSkip. The
// row must say `gate-skipped`, not `skipped`: an admission skip keeps counting,
// and a gate skip spent nothing.
describe("settleCiGateSkip — a size or budget skip settles as gate-skipped (#326)", () => {
  const GATE_REASON = "diff exceeds the configured size gate";

  test("a reserved record takes the gate-skipped status and reason, and the check run carries it", async () => {
    const state = gateLedgerState("reserved");
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [{ match: ["check-runs"], response: { stdout: '{"id":99}' } }],
      calls,
    );

    await settleCiGateSkip(state, GATE_REASON, { spawnFn });

    expect(state.record.status).toBe("gate-skipped");
    expect(state.record.decisionReason).toBe(GATE_REASON);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("output[summary]=gate-skipped (attempt 1)");
  });

  test("a null ledger (outside CI) is a no-op", async () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeGh([], calls);

    await settleCiGateSkip(null, GATE_REASON, { spawnFn });

    expect(calls).toEqual([]);
  });
});

describe("settleCiAdmissionLedger — a gate-skipped record is terminal (#326)", () => {
  test("keeps its status and reason, and nothing is sent to GitHub", async () => {
    const state = gateLedgerState("gate-skipped");
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [{ match: ["check-runs"], response: { stdout: '{"id":99}' } }],
      calls,
    );

    await settleCiAdmissionLedger(state, "failed", "settled after the skip", {
      spawnFn,
    });

    expect(state.record.status).toBe("gate-skipped");
    expect(state.record.decisionReason).toBe(
      "reason recorded before settlement",
    );
    expect(calls).toEqual([]);
  });
});

describe("upsertAdmissionCheckRun — a gate-skipped check run (#326)", () => {
  test("concludes skipped, so GitHub renders it grey as the old skip did", async () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [{ match: ["check-runs"], response: { stdout: '{"id":99}' } }],
      calls,
    );

    await upsertAdmissionCheckRun(
      "/repo",
      { headSha: HEAD_A, record: gateLedgerState("gate-skipped").record },
      { spawnFn },
    );

    expect(calls[0]).toContain("conclusion=skipped");
  });
});

function gateLedgerState(
  status: AdmissionRecord["status"],
): CiAdmissionLedgerState {
  return {
    record: admissionCheckRunRecord({
      headSha: HEAD_A,
      reservationId: "reservation-gate-skip",
      status,
      decisionReason: "reason recorded before settlement",
    }),
    checkRunId: 11,
    headSha: HEAD_A,
    operatorRoot: "/repo",
  };
}

describe("yieldToInFlightReview", () => {
  // musive #1935's shape: another review set its pending status 47s before
  // this run looked. Well inside the 90-minute in-flight TTL.
  const PENDING_AT = "2026-10-02T14:11:13Z";
  const NOW_MS = Date.parse("2026-10-02T14:12:00Z");
  const YIELD_REASON =
    "another pr-hero review is already in flight on this head";
  const SKIP_LINE = "skip: a pr-hero review is already in-flight on this head";
  const WARNING_LINE =
    "warning: a pr-hero review is already in-flight on this head; continuing";
  const LEDGER_CHECK_RUN_ID = 11;

  function commitStatus(
    state: "pending" | "success",
    context: CommitStatusContext = COMMIT_STATUS_CONTEXT,
  ): ScriptEntry {
    return {
      match: [`commits/${HEAD_B}/status`],
      response: {
        stdout: `${JSON.stringify({
          state,
          context,
          created_at: PENDING_AT,
        })}\n`,
      },
    };
  }

  const CHECK_RUN_PATCH: ScriptEntry = {
    match: [`check-runs/${LEDGER_CHECK_RUN_ID}`],
    response: { stdout: JSON.stringify({ id: LEDGER_CHECK_RUN_ID }) },
  };

  function reservedLedger(): CiAdmissionLedgerState {
    return {
      record: admissionCheckRunRecord({
        status: "reserved",
        decisionReason: "admission: run",
        settledAt: null,
      }),
      checkRunId: LEDGER_CHECK_RUN_ID,
      headSha: HEAD_B,
      operatorRoot: "/repo",
    };
  }

  function checkRunCalls(calls: string[][]): string[][] {
    return calls.filter((argv) => argv.join(" ").includes("check-runs"));
  }

  async function capturingStderr<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; logged: string }> {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      return { result: await fn(), logged: chunks.join("") };
    } finally {
      process.stderr.write = origWrite;
    }
  }

  test("in CI, standing down for an in-flight review settles the reservation as yielded, not failed", async () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [commitStatus("pending"), CHECK_RUN_PATCH],
      calls,
    );
    const ledger = reservedLedger();

    const { result, logged } = await capturingStderr(() =>
      yieldToInFlightReview({
        operatorRoot: "/repo",
        headSha: HEAD_B,
        options: { yes: true, force: false },
        statusContext: COMMIT_STATUS_CONTEXT,
        ciAdmissionLedger: ledger,
        spawnFn,
        nowMs: NOW_MS,
      }),
    );

    expect(result).toBe(0);
    expect(logged).toBe(`${SKIP_LINE}\n`);
    expect(ledger.record.status).toBe("yielded");
    expect(ledger.record.decisionReason).toBe(YIELD_REASON);
    const upserts = checkRunCalls(calls);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toContain("status=completed");
    expect(upserts[0]).toContain("conclusion=skipped");
    expect(upserts[0]).toContain("output[summary]=yielded (attempt 1)");
  });

  test("standing down writes a yielded outcome record in action mode, and nothing without the outcome directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-yield-record-"));
    const saved = process.env.PRHERO_OUTCOME_DIR;
    try {
      const yieldOnce = () =>
        capturingStderr(() =>
          yieldToInFlightReview({
            operatorRoot: "/repo",
            headSha: HEAD_B,
            options: { yes: true, force: false },
            statusContext: COMMIT_STATUS_CONTEXT,
            ciAdmissionLedger: reservedLedger(),
            spawnFn: makeFakeGh([commitStatus("pending"), CHECK_RUN_PATCH], []),
            nowMs: NOW_MS,
          }),
        );

      process.env.PRHERO_OUTCOME_DIR = dir;
      const withDir = await yieldOnce();
      expect(withDir.result).toBe(0);
      const written = await readFile(path.join(dir, "cli.json"), "utf8");
      expect(JSON.parse(written)).toEqual({ v: 1, outcome: "yielded" });

      delete process.env.PRHERO_OUTCOME_DIR;
      const without = await yieldOnce();
      expect(without).toEqual(withDir);
      expect(await readFile(path.join(dir, "cli.json"), "utf8")).toBe(written);
    } finally {
      if (saved === undefined) {
        delete process.env.PRHERO_OUTCOME_DIR;
      } else {
        process.env.PRHERO_OUTCOME_DIR = saved;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("outside CI there is no ledger: the watcher child still stands down and writes no check run", async () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeGh([commitStatus("pending")], calls);

    const { result, logged } = await capturingStderr(() =>
      yieldToInFlightReview({
        operatorRoot: "/repo",
        headSha: HEAD_B,
        options: { yes: true, force: false },
        statusContext: LOCAL_COMMIT_STATUS_CONTEXT,
        ciAdmissionLedger: null,
        spawnFn,
        nowMs: NOW_MS,
      }),
    );

    expect(result).toBe(0);
    expect(logged).toBe(`${SKIP_LINE}\n`);
    expect(checkRunCalls(calls)).toEqual([]);
  });

  test("a head whose latest pr-hero status is not pending proceeds silently and settles nothing", async () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [commitStatus("success"), CHECK_RUN_PATCH],
      calls,
    );
    const ledger = reservedLedger();

    const { result, logged } = await capturingStderr(() =>
      yieldToInFlightReview({
        operatorRoot: "/repo",
        headSha: HEAD_B,
        options: { yes: true, force: false },
        statusContext: COMMIT_STATUS_CONTEXT,
        ciAdmissionLedger: ledger,
        spawnFn,
        nowMs: NOW_MS,
      }),
    );

    expect(result).toBeUndefined();
    expect(logged).toBe("");
    expect(ledger.record.status).toBe("reserved");
    expect(checkRunCalls(calls)).toEqual([]);
  });

  test.each([
    [
      "--force (the CI comment override)",
      { yes: true, force: true },
      COMMIT_STATUS_CONTEXT,
    ],
    [
      "an interactive run (no --yes)",
      { yes: false, force: false },
      LOCAL_COMMIT_STATUS_CONTEXT,
    ],
  ] as const)(
    "%s warns and continues over an in-flight review, leaving the reservation to the run",
    async (_name, options, statusContext) => {
      const calls: string[][] = [];
      const spawnFn = makeFakeGh(
        [commitStatus("pending"), CHECK_RUN_PATCH],
        calls,
      );
      const ledger = reservedLedger();

      const { result, logged } = await capturingStderr(() =>
        yieldToInFlightReview({
          operatorRoot: "/repo",
          headSha: HEAD_B,
          options,
          statusContext,
          ciAdmissionLedger: ledger,
          spawnFn,
          nowMs: NOW_MS,
        }),
      );

      expect(result).toBeUndefined();
      expect(logged).toBe(`${WARNING_LINE}\n`);
      expect(ledger.record.status).toBe("reserved");
      expect(checkRunCalls(calls)).toEqual([]);
    },
  );

  // Fix D: a watcher child (--yes, no --ci) reads both run contexts, because the
  // watcher and local runs post their pending on pr-hero/local. The fixture is the
  // watcher child's own posture, so a local review already in flight stops the
  // second paid review on the same head.
  test("a watcher child stands down for a fresh pr-hero/local pending on the head", async () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [commitStatus("pending", LOCAL_COMMIT_STATUS_CONTEXT)],
      calls,
    );

    const { result, logged } = await capturingStderr(() =>
      yieldToInFlightReview({
        operatorRoot: "/repo",
        headSha: HEAD_B,
        options: { yes: true, force: false },
        statusContext: LOCAL_COMMIT_STATUS_CONTEXT,
        ciAdmissionLedger: null,
        spawnFn,
        nowMs: NOW_MS,
      }),
    );

    expect(result).toBe(0);
    expect(logged).toBe(`${SKIP_LINE}\n`);
    expect(checkRunCalls(calls)).toEqual([]);
  });

  // The contested line, deliberately preserved: a --ci run must not stand down for
  // a local pending. Its yield would leave the pr-hero gate unwritten, because only
  // a --ci run writes that context and the local run never will. Review-pr.ts:388
  // runs this check before the plan step and its pending post, so a pending the
  // run itself posts can never reach this check.
  test("a --ci run does not stand down for a pr-hero/local pending: the gate status stays its to write", async () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [commitStatus("pending", LOCAL_COMMIT_STATUS_CONTEXT), CHECK_RUN_PATCH],
      calls,
    );
    const ledger = reservedLedger();

    const { result, logged } = await capturingStderr(() =>
      yieldToInFlightReview({
        operatorRoot: "/repo",
        headSha: HEAD_B,
        options: { yes: true, force: false },
        statusContext: COMMIT_STATUS_CONTEXT,
        ciAdmissionLedger: ledger,
        spawnFn,
        nowMs: NOW_MS,
      }),
    );

    expect(result).toBeUndefined();
    expect(logged).toBe("");
    expect(ledger.record.status).toBe("reserved");
    expect(checkRunCalls(calls)).toEqual([]);
  });
});

// Carry-forward in gate mode (the owner's decision): a head the admission gate
// skips inherits the verdict of the last reviewed head, so the required check
// never reads green on a push nobody reviewed. These run the real gate and
// publishCiSkip; the only gh boundary is the fake.
describe("evaluateCiAdmissionGate — a gate-mode admission skip carries the reviewed verdict", () => {
  const T1 = "2026-10-16T10:00:00Z";
  const T2 = "2026-10-16T11:00:00Z";

  // HEAD_A was reviewed (summary marker) and a docs-only push HEAD_B arrived. The
  // risk-aware policy skips HEAD_B as a low-risk delta.
  // The PR's commits, oldest first: HEAD_A is the earlier one, HEAD_B the head the gate evaluates.
  const PR_COMMITS: ScriptEntry = {
    match: [`pulls/${PR}/commits`],
    response: { stdout: `${HEAD_A}\n${HEAD_B}\n` },
  };

  // `summaryHead` is the head the summary marker names (the reviewed head, unless a test forges it).
  function gateScript(
    statusesEntry: ScriptEntry,
    summaryHead: string = HEAD_A,
    extra: ScriptEntry[] = [],
  ): ScriptEntry[] {
    return [
      EMPTY_CHECK_RUNS,
      {
        match: ["issues", "comments"],
        response: {
          stdout: `${JSON.stringify(summaryComment(1, summaryHead, { blocking: 0, advisory: 1 }, 1))}\n`,
        },
      },
      EMPTY_REVIEW_COMMENTS,
      REPO_VIEW,
      compareResponse("docs/readme.md"),
      PR_COMMITS,
      statusesEntry,
      ...extra,
    ];
  }

  const statusRows = (rows: Array<Record<string, string>>): ScriptEntry => ({
    match: [`commits/${HEAD_A}/statuses`],
    response: {
      stdout: rows.map((r) => `${JSON.stringify(r)}\n`).join(""),
    },
  });

  // Every status write this run made: the POST to the statuses endpoint.
  function statusWrites(calls: string[][]): string[][] {
    return calls.filter((argv) =>
      argv.some((token) => token.startsWith("repos/{owner}/{repo}/statuses/")),
    );
  }

  async function runGate(
    script: ScriptEntry[],
    ciMode: "gate" | "advisory",
    calls: string[][],
  ) {
    const { summaryPath, outputPath } = await tmpCiFiles();
    return withGateEnv(
      { GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outputPath },
      () =>
        evaluateCiAdmissionGate({
          ciMode,
          operatorRoot: "/repo",
          prNumber: PR,
          headSha: HEAD_B,
          config: EMPTY_LOCAL_CONFIG,
          isCi: true,
          options: baseOptions(),
          spawnFn: makeFakeGh(script, calls),
          recordSkip: async () => {},
        }),
    );
  }

  test("a docs-only push after a red review posts the red verdict on the new head", async () => {
    const calls: string[][] = [];
    const result = await runGate(
      gateScript(
        statusRows([
          {
            state: "success",
            context: "pr-hero",
            created_at: T2,
            description: "pr-hero: overridden by @alice",
          },
          {
            state: "failure",
            context: "pr-hero",
            created_at: T1,
            description:
              "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
          },
        ]),
      ),
      "gate",
      calls,
    );
    expect(result.exitCode).toBe(0);
    const writes = statusWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(`repos/{owner}/{repo}/statuses/${HEAD_B}`);
    expect(writes[0]).toContain("state=failure");
    expect(writes[0]).toContain("context=pr-hero");
    expect(writes[0]).toContain(
      "description=pr-hero: 2 blocking finding(s) carried from aaaaaaa — fix and push, or /pr-hero override",
    );
  });

  test("an unreadable reviewed-head history posts a fail-closed failure on the new head", async () => {
    const calls: string[][] = [];
    await runGate(
      gateScript({
        match: [`commits/${HEAD_A}/statuses`],
        response: { stdout: "", exitCode: 1 },
      }),
      "gate",
      calls,
    );
    const writes = statusWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(`repos/{owner}/{repo}/statuses/${HEAD_B}`);
    expect(writes[0]).toContain("state=failure");
    expect(writes[0]).toContain(
      "description=pr-hero skipped the review (delta touches only low-risk paths) and found no earlier verdict — /pr-hero review reviews it",
    );
  });

  // The forged-marker case: a commenter posts a summary naming a green head. The carry must not read
  // that head, and must carry the red verdict the PR's own earlier commit carries.
  test("a forged summary marker naming a green head cannot carry green: the PR's own red verdict is carried", async () => {
    const FORGED = "f".repeat(40);
    const calls: string[][] = [];
    const green: ScriptEntry = {
      match: [`commits/${FORGED}/statuses`],
      response: {
        stdout: `${JSON.stringify({
          state: "success",
          context: "pr-hero",
          created_at: T1,
          description: "review posted",
        })}\n`,
      },
    };
    await runGate(
      gateScript(
        statusRows([
          {
            state: "failure",
            context: "pr-hero",
            created_at: T1,
            description:
              "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
          },
        ]),
        FORGED,
        [green],
      ),
      "gate",
      calls,
    );
    expect(
      calls.some((argv) =>
        argv.join(" ").includes(`commits/${FORGED}/statuses`),
      ),
    ).toBe(false);
    const writes = statusWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("state=failure");
    expect(writes[0]).toContain(
      "description=pr-hero: 2 blocking finding(s) carried from aaaaaaa — fix and push, or /pr-hero override",
    );
  });

  // A re-run or reopen of the gate on an overridden head: the skip must not write over the override.
  test("a re-run on a head the human overrode writes no skip status over the override", async () => {
    const calls: string[][] = [];
    const headOverride: ScriptEntry = {
      match: [`commits/${HEAD_B}/status?`],
      response: {
        stdout: `${JSON.stringify({
          state: "success",
          context: "pr-hero",
          created_at: T2,
          description: "pr-hero: overridden by @alice",
        })}\n`,
      },
    };
    const result = await runGate(
      gateScript(
        statusRows([
          {
            state: "failure",
            context: "pr-hero",
            created_at: T1,
            description:
              "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
          },
        ]),
        HEAD_A,
        [headOverride],
      ),
      "gate",
      calls,
    );
    expect(result.exitCode).toBe(0);
    expect(statusWrites(calls)).toEqual([]);
  });

  test("advisory mode reads no history and posts no status on the new head", async () => {
    const calls: string[][] = [];
    await runGate(
      gateScript(
        statusRows([
          {
            state: "failure",
            context: "pr-hero",
            created_at: T1,
            description:
              "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
          },
        ]),
      ),
      "advisory",
      calls,
    );
    expect(statusWrites(calls)).toEqual([]);
    expect(
      calls.some((argv) => argv.some((t) => t.includes("/statuses?"))),
    ).toBe(false);
  });
});

// A CI run that exits on a configuration error (gotchas, prompt set) before it
// reviews anything writes a gate-skipped row for its head, so that head does not
// spend one of the PR's automatic attempts (#326 gives the gate skips the same
// treatment). The error itself is rethrown by the caller, unchanged.
describe("recordCiConfigErrorSkip — a configuration error before the review spends nothing", () => {
  const CONFIG_REASON = "configuration error before the review";

  test("writes a gate-skipped row for the head", async () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeGh(
      [{ match: ["check-runs"], response: { stdout: '{"id":99}' } }],
      calls,
    );

    await recordCiConfigErrorSkip({
      operatorRoot: "/repo",
      prNumber: PR,
      config: EMPTY_LOCAL_CONFIG,
      resolveHeadSha: async () => HEAD_A,
      reason: CONFIG_REASON,
      spawnFn,
    });

    expect(
      calls.some((argv) =>
        argv.join(" ").includes("output[summary]=gate-skipped (attempt 1)"),
      ),
    ).toBe(true);
  });

  test("a head lookup that fails writes nothing and does not throw", async () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeGh([], calls);

    await expect(
      recordCiConfigErrorSkip({
        operatorRoot: "/repo",
        prNumber: PR,
        config: EMPTY_LOCAL_CONFIG,
        resolveHeadSha: async () => {
          throw new Error("gh pr view failed");
        },
        reason: CONFIG_REASON,
        spawnFn,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("isCiConfigError — only a classified configuration CliError qualifies", () => {
  test.each([
    { kind: "gotchas", reason: "empty" },
    { kind: "gotchas", reason: "placeholder" },
    { kind: "prompt-set" },
  ] as const)("$kind is a configuration error", (cls) => {
    expect(isCiConfigError(new CliError("bad config", { cls }))).toBe(true);
  });

  test("an unclassified error is not one", () => {
    expect(isCiConfigError(new CliError("network down"))).toBe(false);
    expect(isCiConfigError(new Error("boom"))).toBe(false);
  });

  test("a classified error of another class is not one", () => {
    expect(
      isCiConfigError(new CliError("no spend", { cls: { kind: "invariant" } })),
    ).toBe(false);
  });
});

// A gh call that never answers must not park the CI run: the caller is about to
// rethrow the configuration error, and that error has to reach the operator.
describe("recordCiConfigErrorSkip — a hung GitHub call is bounded", () => {
  test("a head lookup that never answers gives up within the bound, writing nothing", async () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeGh([], calls);
    const started = Date.now();

    await recordCiConfigErrorSkip({
      operatorRoot: "/repo",
      prNumber: PR,
      config: EMPTY_LOCAL_CONFIG,
      resolveHeadSha: () => new Promise<string>(() => {}),
      reason: "configuration error before the review",
      spawnFn,
      timeoutMs: 25,
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toEqual([]);
  });
});
