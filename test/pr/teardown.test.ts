// Offline behavior tests for pr/teardown.ts (settleCommitStatusAndLedger,
// finalizePrReviewRun): the two `finally` blocks wrapping reviewPr()'s run.
// Zero direct tests existed before this file (rg over test/ for both
// exported names returned nothing).
//
// tryPublishCommitStatus (#pr/status) now threads an invisible-to-production
// `spawnFn` into postCommitStatus — the same established seam pr.ts's own
// gh()-backed functions already carry — so these tests double the real `gh`
// boundary instead of replacing tryPublishCommitStatus's swallow-errors
// behavior with a fake. `settleCiAdmissionLedger` (#pr/admission) still has
// no spawnFn of its own (its ledger persist call has none, and admission.ts
// is out of scope for this slice), so `settle` stays a whole-function seam;
// every fake used below still runs the REAL pure `settleAdmissionAttempt`
// transform, so assertions read the resulting ledger record's observable
// state rather than a list of call args. `releasePidLock` stays real: a
// plain `fs.rm` against a caller-supplied path, so a real temp lock file is
// already the observable.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AdmissionAttemptStatus,
  type AdmissionRecord,
  admissionRecordFingerprint,
  settleAdmissionAttempt,
} from "#ci/admission-ledger";
import type { CiAdmissionLedgerState } from "#pr/admission";
import type { InlinePostOutcome } from "#pr/inline";
import {
  COMMIT_STATUS_CONTEXT,
  LOCAL_COMMIT_STATUS_CONTEXT,
  resolveCiPosture,
} from "#pr/preflight";
import {
  heldCommitStatusLock,
  holdCommitStatusLock,
  releaseCommitStatusLock,
  settleHeldCommitStatusOnSignal,
} from "#pr/status";
import { finalizePrReviewRun, settleCommitStatusAndLedger } from "#pr/teardown";
import type { PipelineResult } from "#review/pipeline";
import { CliError } from "../../src/errors";

const HEAD = "a".repeat(40);
const POLICY_HASH = "abc123def4567890";
const PR = 42;
const SETTLED_REASON = "review path exited without terminal settlement";
const ORIGINAL_REASON = "original-reason-marker";

function baseRecord(overrides: Partial<AdmissionRecord> = {}): AdmissionRecord {
  return {
    schemaVersion: 1,
    prNumber: PR,
    headSha: HEAD,
    policyHash: POLICY_HASH,
    reservationId: admissionRecordFingerprint(PR, HEAD, POLICY_HASH),
    attemptNumber: 1,
    status: "reserved",
    decisionReason: ORIGINAL_REASON,
    priorScore: null,
    blockingCount: null,
    advisoryCount: null,
    workflowRunId: null,
    createdAt: "2026-08-28T12:00:00.000Z",
    settledAt: null,
    ...overrides,
  };
}

function ledgerState(status: AdmissionAttemptStatus): CiAdmissionLedgerState {
  return {
    record: baseRecord({ status }),
    checkRunId: 7,
    headSha: HEAD,
    operatorRoot: "/repo",
  };
}

// The fake `settle` every test below passes: it runs the SAME pure
// settleAdmissionAttempt transform the real settleCiAdmissionLedger uses,
// mutating the passed-in state's `record` in place. That makes the ledger
// state (not a call-args list) the observable — the only part of
// settleCiAdmissionLedger's effect this slice can prove without a gh seam
// in admission.ts.
const fakeSettle = async (
  state: CiAdmissionLedgerState | null,
  status: AdmissionAttemptStatus,
  reason: string,
): Promise<void> => {
  if (state === null) return;
  state.record = settleAdmissionAttempt(state.record, status, reason);
};

// Only `sessionFailed` is read by the code under test (commitStatusCompletion
// via settleCommitStatusAndLedger); the rest of PipelineResult's shape is
// pipeline internals this slice has no business constructing.
function pipelineResult(sessionFailed: boolean): PipelineResult {
  return { sessionFailed } as unknown as PipelineResult;
}

// Only "is this null or not" is read by the code under test; the rest of
// InlinePostOutcome's shape is posting-stage internals.
function postedOutcome(): InlinePostOutcome {
  return { reviewOutcome: "posted" } as unknown as InlinePostOutcome;
}

// Isolation: the commit-status lock is module-level state (status.ts's own
// WHY explains it has to be), so a test that fails before the production
// code's own release runs must not leak a held lock into the next test.
afterEach(() => {
  releaseCommitStatusLock();
});

async function tmpLockPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-teardown-"));
  const lockPath = path.join(dir, "pid.lock");
  await writeFile(lockPath, "1234\n");
  return lockPath;
}

// Fakes the `gh` boundary tryPublishCommitStatus's postCommitStatus call
// hits. `fail: true` makes every attempt fail (postCommitStatus retries
// twice by default before giving up and throwing), which is exactly the
// gh-failure shape tryPublishCommitStatus's own try/catch is supposed to
// swallow.
function makeStatusSpawn(options?: { fail?: boolean; onCall?: () => void }): {
  spawnFn: typeof Bun.spawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const encoder = new TextEncoder();
  const spawnFn = ((argv: string[]) => {
    calls.push(argv);
    options?.onCall?.();
    const ok = options?.fail !== true;
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    return {
      stdout: stream(""),
      stderr: stream(ok ? "" : "boom"),
      exited: Promise.resolve(ok ? 0 : 1),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

// The commit-status request is sent as repeated `-f key=value` gh args;
// this reads them back into a plain object so assertions read like a
// request body, not an argv diff.
function parseStatusFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-f" && typeof argv[i + 1] === "string") {
      const raw = argv[i + 1] as string;
      const eq = raw.indexOf("=");
      if (eq !== -1) flags[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
  }
  return flags;
}

describe("settleCommitStatusAndLedger — commit status matrix", () => {
  test.each([
    [
      "no result yet, nothing posted",
      undefined,
      null,
      { state: "error", description: "review did not finish" },
    ],
    [
      "no result yet, a stray posted outcome",
      undefined,
      postedOutcome(),
      { state: "error", description: "review did not finish" },
    ],
    [
      "finished clean, nothing posted",
      pipelineResult(false),
      null,
      { state: "success", description: "review complete" },
    ],
    [
      "finished clean, posted",
      pipelineResult(false),
      postedOutcome(),
      { state: "success", description: "review posted" },
    ],
    [
      "finished but session failed, nothing posted",
      pipelineResult(true),
      null,
      { state: "error", description: "review did not finish" },
    ],
    [
      "finished but session failed, still posted",
      pipelineResult(true),
      postedOutcome(),
      { state: "error", description: "review did not finish" },
    ],
  ] as const)("%s", async (_name, result, posted, expected) => {
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger({
      result,
      posted,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: "https://runs.example/1",
      ciAdmissionLedger: null,
      spawnFn,
      ciMode: "advisory",
      statusContext: COMMIT_STATUS_CONTEXT,
      blockingCount: null,
    });
    expect(calls).toHaveLength(1);
    const flags = parseStatusFlags(calls[0] as string[]);
    expect(flags).toEqual({
      state: expected.state,
      context: COMMIT_STATUS_CONTEXT,
      description: expected.description,
      target_url: "https://runs.example/1",
    });
  });
});

describe("settleCommitStatusAndLedger — commit status lock lifecycle", () => {
  test("holds the lock while gh is posting the commit status, releases it after", async () => {
    holdCommitStatusLock({
      operatorRoot: "/repo",
      sha: HEAD,
      targetUrl: undefined,
    });
    let lockDuringPost: unknown = "not observed";
    const { spawnFn } = makeStatusSpawn({
      onCall: () => {
        lockDuringPost = heldCommitStatusLock();
      },
    });
    await settleCommitStatusAndLedger({
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: null,
      spawnFn,
      ciMode: "advisory",
      statusContext: COMMIT_STATUS_CONTEXT,
      blockingCount: null,
    });
    expect(lockDuringPost).not.toBeNull();
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("a gh failure while posting the commit status still releases the lock and settles the ledger", async () => {
    holdCommitStatusLock({
      operatorRoot: "/repo",
      sha: HEAD,
      targetUrl: undefined,
    });
    const { spawnFn, calls } = makeStatusSpawn({ fail: true });
    const ledger = ledgerState("reserved");
    await settleCommitStatusAndLedger({
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: ledger,
      spawnFn,
      settle: fakeSettle,
      ciMode: "advisory",
      statusContext: COMMIT_STATUS_CONTEXT,
      blockingCount: null,
    });
    // gh was really attempted (and really failed) — this is not a no-op.
    expect(calls.length).toBeGreaterThan(0);
    expect(heldCommitStatusLock()).toBeNull();
    expect(ledger.record.status).toBe("failed");
    expect(ledger.record.decisionReason).toBe(SETTLED_REASON);
  });
});

describe("settleCommitStatusAndLedger — gate mode (S4)", () => {
  const BLOCKING_DESCRIPTION =
    "pr-hero: 2 blocking finding(s) — fix and push; /pr-hero review re-runs this head";

  test.each([
    [
      "blocking findings are failure, with the count and the unlock",
      pipelineResult(false),
      2,
      { state: "failure", description: BLOCKING_DESCRIPTION },
    ],
    [
      "clean is success",
      pipelineResult(false),
      0,
      { state: "success", description: "review complete" },
    ],
    [
      "a crash is error even with blocking findings",
      pipelineResult(true),
      2,
      { state: "error", description: "review did not finish" },
    ],
    [
      "an unknown count is error, never a clean success",
      pipelineResult(false),
      null,
      { state: "error", description: "review did not finish" },
    ],
  ] as const)("%s", async (_name, result, blockingCount, expected) => {
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger({
      result,
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: "https://runs.example/1",
      ciAdmissionLedger: null,
      spawnFn,
      ciMode: "gate",
      statusContext: COMMIT_STATUS_CONTEXT,
      blockingCount,
    });
    expect(calls).toHaveLength(1);
    expect(parseStatusFlags(calls[0] as string[])).toEqual({
      state: expected.state,
      context: COMMIT_STATUS_CONTEXT,
      description: expected.description,
      target_url: "https://runs.example/1",
    });
  });

  test("a failed final write throws a CliError, still releases the lock, and leaves the ledger for the outer finally", async () => {
    holdCommitStatusLock({
      operatorRoot: "/repo",
      sha: HEAD,
      targetUrl: undefined,
    });
    const { spawnFn, calls } = makeStatusSpawn({ fail: true });
    const ledger = ledgerState("reserved");
    let thrown: unknown;
    try {
      await settleCommitStatusAndLedger({
        result: pipelineResult(false),
        posted: null,
        operatorRoot: "/repo",
        headSha: HEAD,
        statusTargetUrl: undefined,
        ciAdmissionLedger: ledger,
        spawnFn,
        settle: fakeSettle,
        ciMode: "gate",
        statusContext: COMMIT_STATUS_CONTEXT,
        blockingCount: 0,
      });
    } catch (error) {
      thrown = error;
    }
    // gh was really attempted and really failed: the write did not land.
    expect(calls.length).toBeGreaterThan(0);
    // CliError is what the CLI turns into exit 1 and the `::error::` annotation.
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as Error).message).toContain(
      "commit status (success) was not written",
    );
    expect(heldCommitStatusLock()).toBeNull();
    // The inner finally throws before its ledger settle; finalizePrReviewRun
    // (the outer finally) is the one that settles a pending reservation.
    expect(ledger.record.status).toBe("reserved");
  });
});

const LEDGER_GUARD_CASES: readonly [
  AdmissionAttemptStatus,
  AdmissionAttemptStatus,
  string,
][] = [
  ["reserved", "failed", SETTLED_REASON],
  ["provider-started", "failed", SETTLED_REASON],
  ["completed", "completed", ORIGINAL_REASON],
  ["skipped", "skipped", ORIGINAL_REASON],
  ["failed", "failed", ORIGINAL_REASON],
  ["cancelled", "cancelled", ORIGINAL_REASON],
  ["yielded", "yielded", ORIGINAL_REASON],
  ["unknown", "unknown", ORIGINAL_REASON],
];

describe("settleCommitStatusAndLedger — ledger settlement guard", () => {
  test.each(LEDGER_GUARD_CASES)(
    "status=%s ends as %s",
    async (startStatus, expectedStatus, expectedReason) => {
      const { spawnFn } = makeStatusSpawn();
      const ledger = ledgerState(startStatus);
      await settleCommitStatusAndLedger({
        result: pipelineResult(false),
        posted: null,
        operatorRoot: "/repo",
        headSha: HEAD,
        statusTargetUrl: undefined,
        ciAdmissionLedger: ledger,
        spawnFn,
        settle: fakeSettle,
        ciMode: "advisory",
        statusContext: COMMIT_STATUS_CONTEXT,
        blockingCount: null,
      });
      expect(ledger.record.status).toBe(expectedStatus);
      expect(ledger.record.decisionReason).toBe(expectedReason);
    },
  );

  test("settles nothing when there is no ledger reservation to begin with", async () => {
    const { spawnFn } = makeStatusSpawn();
    const calls: unknown[] = [];
    await settleCommitStatusAndLedger({
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: null,
      spawnFn,
      settle: async () => {
        calls.push(1);
      },
      ciMode: "advisory",
      statusContext: COMMIT_STATUS_CONTEXT,
      blockingCount: null,
    });
    expect(calls).toEqual([]);
  });
});

describe("finalizePrReviewRun — cleanup ordering", () => {
  test("settles the ledger and releases the pid lock before gc ever looks at it", async () => {
    const lockPath = await tmpLockPath();
    const ledger = ledgerState("reserved");
    const observed = { settleSawLock: false, gcSawLock: true };
    await finalizePrReviewRun({
      ciAdmissionLedger: ledger,
      lockPath,
      home: "/home/pr-hero",
      repoId: "owner/repo",
      settle: async (state, status, reason) => {
        observed.settleSawLock = existsSync(lockPath);
        await fakeSettle(state, status, reason);
      },
      gc: async () => {
        observed.gcSawLock = existsSync(lockPath);
        return { collected: 0, kept: 0, failed: 0 };
      },
    });
    expect(observed).toEqual({ settleSawLock: true, gcSawLock: false });
    expect(existsSync(lockPath)).toBe(false);
    expect(ledger.record.status).toBe("failed");
  });

  test("removes the pid lock before gc runs even when gc itself throws", async () => {
    const lockPath = await tmpLockPath();
    await expect(
      finalizePrReviewRun({
        ciAdmissionLedger: null,
        lockPath,
        home: "/home/pr-hero",
        repoId: "owner/repo",
        gc: async () => {
          throw new Error("gc boom");
        },
      }),
    ).rejects.toThrow("gc boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("passes gc the exact repo scope, always non-dry and always silent", async () => {
    const lockPath = await tmpLockPath();
    const gcCalls: unknown[] = [];
    await finalizePrReviewRun({
      ciAdmissionLedger: null,
      lockPath,
      home: "/home/pr-hero",
      repoId: "owner/repo",
      gc: async (input) => {
        gcCalls.push(input);
        return { collected: 0, kept: 0, failed: 0 };
      },
    });
    expect(gcCalls).toEqual([
      {
        home: "/home/pr-hero",
        repoId: "owner/repo",
        dryRun: false,
        silent: true,
      },
    ]);
  });

  // `yielded` rides along because an in-flight stand-down returns from inside
  // the OUTER try only, so finalizePrReviewRun is the one teardown it meets.
  test.each(
    LEDGER_GUARD_CASES.filter(([status]) =>
      ["reserved", "completed", "yielded"].includes(status),
    ),
  )(
    "ledger settlement guard: status=%s ends as %s",
    async (startStatus, expectedStatus, expectedReason) => {
      const lockPath = await tmpLockPath();
      const ledger = ledgerState(startStatus);
      await finalizePrReviewRun({
        ciAdmissionLedger: ledger,
        lockPath,
        home: "/home/pr-hero",
        repoId: "owner/repo",
        settle: fakeSettle,
        gc: async () => ({ collected: 0, kept: 0, failed: 0 }),
      });
      expect(ledger.record.status).toBe(expectedStatus);
      expect(ledger.record.decisionReason).toBe(expectedReason);
    },
  );
});

// T3 S7 (the verifier's BLOCKER): `pr-hero` is the CI gate. A run that is not
// an explicit `--ci` run never writes it: local `review --pr`, the watcher's
// child, and CI=1 without --ci all post on `pr-hero/local`, advisory. The
// posture comes from the one resolver reviewPr uses, so these cases drive the
// production decision, not a hand-picked context.
describe("S7: only an explicit --ci run writes the pr-hero context", () => {
  test("a local advisory run with blocking findings posts success on pr-hero/local, never on pr-hero", async () => {
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger({
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: null,
      spawnFn,
      ciMode: "advisory",
      statusContext: LOCAL_COMMIT_STATUS_CONTEXT,
      blockingCount: 2,
    });
    expect(calls).toHaveLength(1);
    expect(parseStatusFlags(calls[0] as string[])).toEqual({
      state: "success",
      context: LOCAL_COMMIT_STATUS_CONTEXT,
      description: "review complete",
    });
  });

  test("a --ci gate run with blocking findings posts failure on pr-hero", async () => {
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger({
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: null,
      spawnFn,
      ...resolveCiPosture({ ci: true }),
      blockingCount: 2,
    });
    expect(calls).toHaveLength(1);
    const flags = parseStatusFlags(calls[0] as string[]);
    expect(flags.context).toBe(COMMIT_STATUS_CONTEXT);
    expect(flags.state).toBe("failure");
  });

  test("a local run asked for gate still grades nothing: the mixed input posts advisory on pr-hero/local", async () => {
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger({
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: null,
      spawnFn,
      ciMode: "gate",
      statusContext: LOCAL_COMMIT_STATUS_CONTEXT,
      blockingCount: 2,
    });
    expect(calls).toHaveLength(1);
    const flags = parseStatusFlags(calls[0] as string[]);
    expect(flags.context).toBe(LOCAL_COMMIT_STATUS_CONTEXT);
    expect(flags.state).toBe("success");
  });

  test("S7 pin: every non-ci posture, every outcome, never writes the pr-hero context", async () => {
    const outcomes: Array<[PipelineResult | undefined, number | null]> = [
      [undefined, null],
      [pipelineResult(false), null],
      [pipelineResult(false), 0],
      [pipelineResult(false), 2],
      [pipelineResult(true), 2],
    ];
    let posts = 0;
    for (const ciMode of [undefined, "gate", "advisory"] as const) {
      const posture = resolveCiPosture({ ci: false, ciMode });
      for (const [result, blockingCount] of outcomes) {
        const { spawnFn, calls } = makeStatusSpawn();
        await settleCommitStatusAndLedger({
          result,
          posted: null,
          operatorRoot: "/repo",
          headSha: HEAD,
          statusTargetUrl: undefined,
          ciAdmissionLedger: null,
          spawnFn,
          ...posture,
          blockingCount,
        });
        for (const argv of calls) {
          posts += 1;
          expect(parseStatusFlags(argv).context).toBe(
            LOCAL_COMMIT_STATUS_CONTEXT,
          );
        }
      }
    }
    expect(posts).toBeGreaterThan(0);
  });

  test("a cancelled local run settles its own pending on pr-hero/local, never pr-hero", async () => {
    holdCommitStatusLock({
      operatorRoot: "/repo",
      sha: HEAD,
      targetUrl: undefined,
      context: LOCAL_COMMIT_STATUS_CONTEXT,
    });
    const contexts: string[] = [];
    await settleHeldCommitStatusOnSignal(async (_root, _sha, request) => {
      contexts.push(request.context);
    });
    expect(contexts).toEqual([LOCAL_COMMIT_STATUS_CONTEXT]);
  });
});
