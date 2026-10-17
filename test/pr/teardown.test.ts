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
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AdmissionAttemptStatus,
  type AdmissionRecord,
  admissionRecordFingerprint,
  settleAdmissionAttempt,
} from "#ci/admission-ledger";
import {
  recordReviewDelivered,
  recordReviewing,
  writeCliRecord,
} from "#ci/cli-record";
import { CLI_RECORD_FILE, parseCliRecord } from "#ci/outcome";
import { overrideStandsOverRun } from "#ci/override";
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
import { unresolvedBlockingCount } from "#rereview/state";
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

describe("settleCommitStatusAndLedger — a partial review is red in gate mode (S1, S4)", () => {
  // The hunter counts ride on the pipeline result; a partial review had some hunters fail.
  const partialResult = (hunterFailures: number, sessionFailed = false) =>
    ({
      sessionFailed,
      hunterCount: 4,
      hunterFailedCount: hunterFailures,
    }) as unknown as PipelineResult;

  const PARTIAL_DESCRIPTION =
    "pr-hero: review partial (1 of 4 hunters failed) — /pr-hero review retries it";

  test.each([
    [
      "some hunters failed, nothing blocking: failure, with the retry",
      partialResult(1),
      0,
      "pr-hero",
      "ciGate",
      { state: "failure", description: PARTIAL_DESCRIPTION },
    ],
    [
      "a blocking count still wins over the partial review",
      partialResult(1),
      2,
      "pr-hero",
      "ciGate",
      {
        state: "failure",
        description:
          "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
      },
    ],
    [
      "advisory mode keeps a partial review green",
      partialResult(1),
      0,
      "pr-hero/local",
      "advisory",
      { state: "success", description: "review complete" },
    ],
    [
      "every hunter failed is still error, never the partial verdict",
      partialResult(4, true),
      0,
      "pr-hero",
      "ciGate",
      { state: "error", description: "review did not finish" },
    ],
  ] as const)(
    "%s",
    async (_name, result, blockingCount, context, mode, expected) => {
      const { spawnFn, calls } = makeStatusSpawn();
      await settleCommitStatusAndLedger({
        result,
        posted: null,
        operatorRoot: "/repo",
        headSha: HEAD,
        statusTargetUrl: "https://runs.example/1",
        ciAdmissionLedger: null,
        spawnFn,
        ciMode: mode === "ciGate" ? "gate" : "advisory",
        statusContext:
          context === "pr-hero"
            ? COMMIT_STATUS_CONTEXT
            : LOCAL_COMMIT_STATUS_CONTEXT,
        blockingCount,
      });
      expect(calls).toHaveLength(1);
      expect(parseStatusFlags(calls[0] as string[])).toEqual({
        state: expected.state,
        context:
          context === "pr-hero"
            ? COMMIT_STATUS_CONTEXT
            : LOCAL_COMMIT_STATUS_CONTEXT,
        description: expected.description,
        target_url: "https://runs.example/1",
      });
    },
  );
});

describe("settleCommitStatusAndLedger — gate mode (S4)", () => {
  const BLOCKING_DESCRIPTION =
    "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override";

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

// Fix C: when the review body already threw, a failed final status write must not
// replace that error. The write is still attempted, its failure is logged, and the
// lock is released; the body's own error is what the run exits with.
describe("settleCommitStatusAndLedger — a failed status write after the body threw", () => {
  const ORIGINAL = new Error("ORIGINAL");

  // Same shape as ci-admission-gate.test.ts's capturingStderr (log writes stderr).
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

  test("the body's own error escapes, the status failure is logged, and the lock is released", async () => {
    holdCommitStatusLock({
      operatorRoot: "/repo",
      sha: HEAD,
      targetUrl: undefined,
    });
    const { spawnFn, calls } = makeStatusSpawn({ fail: true });
    const ledger = ledgerState("reserved");
    let escaped: unknown = "nothing escaped";
    const { logged } = await capturingStderr(async () => {
      try {
        try {
          throw ORIGINAL;
        } finally {
          await settleCommitStatusAndLedger({
            result: undefined,
            posted: null,
            operatorRoot: "/repo",
            headSha: HEAD,
            statusTargetUrl: undefined,
            ciAdmissionLedger: ledger,
            spawnFn,
            settle: fakeSettle,
            ciMode: "gate",
            statusContext: COMMIT_STATUS_CONTEXT,
            blockingCount: null,
            bodyFailed: true,
          });
        }
      } catch (error) {
        escaped = error;
      }
    });
    // gh was really attempted and really failed: the write did not land.
    expect(calls.length).toBeGreaterThan(0);
    expect(escaped).toBe(ORIGINAL);
    expect(logged).toContain("warning: commit status (error): ");
    expect(heldCommitStatusLock()).toBeNull();
    // The write no longer throws, so the inner finally settles the ledger itself.
    expect(ledger.record.status).toBe("failed");
    expect(ledger.record.decisionReason).toBe(SETTLED_REASON);
  });

  test("a body that succeeds still fails the run with a CliError when its status write fails", async () => {
    holdCommitStatusLock({
      operatorRoot: "/repo",
      sha: HEAD,
      targetUrl: undefined,
    });
    const { spawnFn } = makeStatusSpawn({ fail: true });
    let thrown: unknown;
    try {
      await settleCommitStatusAndLedger({
        result: pipelineResult(false),
        posted: null,
        operatorRoot: "/repo",
        headSha: HEAD,
        statusTargetUrl: undefined,
        ciAdmissionLedger: null,
        spawnFn,
        ciMode: "gate",
        statusContext: COMMIT_STATUS_CONTEXT,
        blockingCount: 0,
        bodyFailed: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(heldCommitStatusLock()).toBeNull();
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

  // The count the publish step hands over, computed by the same function, so
  // these pin the chain from the gate's rows to the posted status.
  test("a same-head forced re-review with a live blocking prior posts failure through the gate count", async () => {
    const count = unresolvedBlockingCount(
      [],
      [
        {
          id: "R001",
          tier: "blocking",
          locs: ["src/app.ts:10"],
          status: "carried",
        },
      ],
    );
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
      blockingCount: count,
    });
    expect(calls).toHaveLength(1);
    const flags = parseStatusFlags(calls[0] as string[]);
    expect(flags.state).toBe("failure");
    expect(flags.description).toBe(
      "pr-hero: 1 blocking finding(s) — fix and push, or /pr-hero override",
    );
  });

  test("a fix the verifier refuted posts success through the gate count", async () => {
    const count = unresolvedBlockingCount(
      [],
      [
        {
          id: "R001",
          tier: "blocking",
          locs: ["src/app.ts:10"],
          status: "verified-gone",
        },
      ],
    );
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
      blockingCount: count,
    });
    expect(calls).toHaveLength(1);
    expect(parseStatusFlags(calls[0] as string[]).state).toBe("success");
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
      return undefined;
    });
    expect(contexts).toEqual([LOCAL_COMMIT_STATUS_CONTEXT]);
  });
});

// WHY these tests: a gate review can finish and be delivered, and then its final status
// write fail. The required check then stays pending, and the publisher step later in the
// same job can post that status only if the CLI recorded it. The record is written here,
// and the CliError still fails the run.
describe("settleCommitStatusAndLedger — the unsettled final status", () => {
  async function outcomeEnv(): Promise<{
    env: Record<string, string>;
    recordPath: string;
  }> {
    const root = await mkdtemp(path.join(tmpdir(), "pr-hero-teardown-cli-"));
    const dir = path.join(root, "outcome");
    return {
      env: { PRHERO_OUTCOME_DIR: dir },
      recordPath: path.join(dir, CLI_RECORD_FILE),
    };
  }

  function settleInput(
    env: Record<string, string>,
    overrides: {
      spawnFn?: typeof Bun.spawn;
      blockingCount?: number;
      bodyFailed?: boolean;
    } = {},
  ): Parameters<typeof settleCommitStatusAndLedger>[0] {
    return {
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: null,
      env,
      ciMode: "gate" as const,
      statusContext: COMMIT_STATUS_CONTEXT,
      blockingCount: 0,
      ...overrides,
    };
  }

  test.each([
    ["a clean review", 0, { state: "success", description: "review complete" }],
    [
      "a review with blocking findings",
      2,
      {
        state: "failure",
        description:
          "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
      },
    ],
  ] as const)(
    "%s: the delivered record keeps the status that did not land, and the run still fails",
    async (_label, blockingCount, expected) => {
      const { env, recordPath } = await outcomeEnv();
      recordReviewDelivered(HEAD, env);
      const { spawnFn } = makeStatusSpawn({ fail: true });
      let thrown: unknown;
      try {
        await settleCommitStatusAndLedger(
          settleInput(env, { spawnFn, blockingCount }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect(parseCliRecord(readFileSync(recordPath, "utf8"))).toEqual({
        v: 1,
        outcome: "reviewed",
        head_sha: HEAD,
        unsettled_status: expected,
      });
      expect(heldCommitStatusLock()).toBeNull();
    },
  );

  // Runs the body's throw and the settle in its finally, the shape reviewPr's
  // catch and finally create, and returns the error that escaped. The
  // best-effort write logs its own warning, so stderr is discarded here.
  async function throwThenSettle(
    body: Error,
    input: Parameters<typeof settleCommitStatusAndLedger>[0],
  ): Promise<unknown> {
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let escaped: unknown = "nothing escaped";
    try {
      try {
        throw body;
      } finally {
        await settleCommitStatusAndLedger(input);
      }
    } catch (error) {
      escaped = error;
    } finally {
      process.stderr.write = origWrite;
    }
    return escaped;
  }

  // WHY: the body can throw after the review was delivered (cli.json is
  // reviewed). Then the gate's pending status has no other writer, so the
  // record keeps the status that did not land for the publisher to repost.
  test.each([
    ["a clean review", 0, { state: "success", description: "review complete" }],
    [
      "a review with blocking findings",
      2,
      {
        state: "failure",
        description:
          "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
      },
    ],
  ] as const)(
    "%s: a body that failed after delivery records the status that did not land, and its own error still escapes",
    async (_label, blockingCount, expected) => {
      const { env, recordPath } = await outcomeEnv();
      recordReviewDelivered(HEAD, env);
      const { spawnFn, calls } = makeStatusSpawn({ fail: true });
      const body = new Error("body failed after delivery");
      const escaped = await throwThenSettle(
        body,
        settleInput(env, { spawnFn, blockingCount, bodyFailed: true }),
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(escaped).toBe(body);
      expect(parseCliRecord(readFileSync(recordPath, "utf8"))).toEqual({
        v: 1,
        outcome: "reviewed",
        head_sha: HEAD,
        unsettled_status: expected,
      });
      expect(heldCommitStatusLock()).toBeNull();
    },
  );

  test("a body that failed after delivery records nothing when its final write lands", async () => {
    const { env, recordPath } = await outcomeEnv();
    recordReviewDelivered(HEAD, env);
    const { spawnFn, calls } = makeStatusSpawn();
    const body = new Error("body failed after delivery");
    const escaped = await throwThenSettle(
      body,
      settleInput(env, { spawnFn, bodyFailed: true }),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(escaped).toBe(body);
    expect(parseCliRecord(readFileSync(recordPath, "utf8"))).toEqual({
      v: 1,
      outcome: "reviewed",
      head_sha: HEAD,
    });
  });

  // Fix 4: the record carries the override cutoff the CLI computed from the run's start, so the
  // publisher's repost can tell an override posted during this run from one posted before it,
  // without re-deriving the cutoff. The cutoff keeps the 5 s allowance only when the run's own
  // pending landed (overrideCutoffMs, src/ci/override.ts).
  test.each([
    ["landed", true, Date.parse("2026-10-17T12:00:00Z") - 5_000],
    ["not landed", false, Date.parse("2026-10-17T12:00:00Z")],
  ] as const)(
    "the unsettled record carries the override cutoff when the pending %s",
    async (_label, pendingLanded, expectedCutoff) => {
      const { env, recordPath } = await outcomeEnv();
      recordReviewDelivered(HEAD, env);
      const STAMP = Date.parse("2026-10-17T12:00:00Z");
      holdCommitStatusLock(
        {
          operatorRoot: "/repo",
          sha: HEAD,
          targetUrl: undefined,
          context: COMMIT_STATUS_CONTEXT,
        },
        STAMP,
        pendingLanded,
      );
      const { spawnFn } = makeStatusSpawn({ fail: true });
      const error = await settleCommitStatusAndLedger({
        ...settleInput(env, { spawnFn }),
        readStatuses: async () => [],
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CliError);
      expect(parseCliRecord(readFileSync(recordPath, "utf8"))).toMatchObject({
        outcome: "reviewed",
        unsettled_status: { state: "success" },
        override_cutoff_ms: expectedCutoff,
      });
    },
  );

  // Fix 3: a body that failed after delivery still writes the review's verdict, so the override
  // check guards that write too. An override posted during the run stands: nothing is written
  // (no gh call, so the failing spawn is never reached) and nothing is recorded as unsettled.
  test("a body that failed after delivery with a failure verdict writes nothing over an override posted during the run, and records no unsettled status", async () => {
    const { env, recordPath } = await outcomeEnv();
    recordReviewDelivered(HEAD, env);
    holdCommitStatusLock({
      operatorRoot: "/repo",
      sha: HEAD,
      targetUrl: undefined,
      context: COMMIT_STATUS_CONTEXT,
    });
    const { spawnFn, calls } = makeStatusSpawn({ fail: true });
    const body = new Error("body failed after delivery");
    const escaped = await throwThenSettle(body, {
      ...settleInput(env, { spawnFn, blockingCount: 2, bodyFailed: true }),
      readStatuses: async () => [
        {
          state: "success",
          context: COMMIT_STATUS_CONTEXT,
          created_at: new Date(Date.now() + 120_000).toISOString(),
          description:
            "pr-hero: overridden by @maintainer — no review on this head",
        },
      ],
    });
    expect(calls).toHaveLength(0);
    expect(escaped).toBe(body);
    expect(parseCliRecord(readFileSync(recordPath, "utf8"))).toEqual({
      v: 1,
      outcome: "reviewed",
      head_sha: HEAD,
    });
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("a body that failed before delivery records nothing: the record still says reviewing", async () => {
    const { env, recordPath } = await outcomeEnv();
    recordReviewing(HEAD, env);
    const { spawnFn, calls } = makeStatusSpawn({ fail: true });
    const body = new Error("body failed before delivery");
    const escaped = await throwThenSettle(
      body,
      settleInput(env, { spawnFn, bodyFailed: true }),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(escaped).toBe(body);
    expect(parseCliRecord(readFileSync(recordPath, "utf8"))).toEqual({
      v: 1,
      outcome: "reviewing",
      head_sha: HEAD,
    });
  });

  // Advisory never grades, so its failed write records nothing. A gate run on
  // the local context is demoted to advisory the same way (effectiveMode).
  test.each([
    [
      "advisory mode",
      { ciMode: "advisory", statusContext: COMMIT_STATUS_CONTEXT },
    ],
    [
      "a gate run on the local context",
      { ciMode: "gate", statusContext: LOCAL_COMMIT_STATUS_CONTEXT },
    ],
  ] as const)(
    "%s: a body that failed after delivery records nothing when its write fails",
    async (_label, posture) => {
      const { env, recordPath } = await outcomeEnv();
      recordReviewDelivered(HEAD, env);
      const { spawnFn, calls } = makeStatusSpawn({ fail: true });
      const body = new Error("body failed after delivery");
      const escaped = await throwThenSettle(body, {
        ...settleInput(env, { spawnFn, bodyFailed: true }),
        ...posture,
      });
      expect(calls.length).toBeGreaterThan(0);
      expect(escaped).toBe(body);
      expect(parseCliRecord(readFileSync(recordPath, "utf8"))).toEqual({
        v: 1,
        outcome: "reviewed",
        head_sha: HEAD,
      });
    },
  );

  test("an earlier error record is left alone, and the run still fails", async () => {
    const { env, recordPath } = await outcomeEnv();
    writeCliRecord({ v: 1, outcome: "error", cls: { kind: "unknown" } }, env);
    const { spawnFn } = makeStatusSpawn({ fail: true });
    let thrown: unknown;
    try {
      await settleCommitStatusAndLedger(settleInput(env, { spawnFn }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(parseCliRecord(readFileSync(recordPath, "utf8"))).toEqual({
      v: 1,
      outcome: "error",
      cls: { kind: "unknown" },
    });
  });
});

// An override stands against a review that was already running when it was posted:
// the review's own final write must not replace it. A review started after the
// override replaces it, which is the ordinary write. The settle tests inject the
// reader (readStatuses); the production reader requests `description` too (pr.test.ts
// pins the request), so these statuses carry the field as GitHub sends it.
describe("overrideStandsOverRun — which override stands", () => {
  const OVERRIDE =
    "pr-hero: overridden by @maintainer — no review on this head";
  const RUN_START = Date.parse("2026-10-17T12:00:00Z");
  const status = (
    description: string | undefined,
    createdMs: number,
    context: string = COMMIT_STATUS_CONTEXT,
    state = "success",
  ) => ({
    state,
    context,
    created_at: new Date(createdMs).toISOString(),
    ...(description === undefined ? {} : { description }),
  });

  test("an override created after the run started stands", () => {
    expect(
      overrideStandsOverRun([status(OVERRIDE, RUN_START + 60_000)], RUN_START),
    ).toBe(true);
  });

  test("an override created before the run started does not stand", () => {
    expect(
      overrideStandsOverRun([status(OVERRIDE, RUN_START - 60_000)], RUN_START),
    ).toBe(false);
  });

  test("the newest pr-hero status decides: a review's status after the override means no override stands", () => {
    expect(
      overrideStandsOverRun(
        [
          status(OVERRIDE, RUN_START + 60_000),
          status(
            "pr-hero reviewing",
            RUN_START + 120_000,
            COMMIT_STATUS_CONTEXT,
            "pending",
          ),
        ],
        RUN_START,
      ),
    ).toBe(false);
  });

  test("an override on the local context never stands over a gate review", () => {
    expect(
      overrideStandsOverRun(
        [status(OVERRIDE, RUN_START + 60_000, LOCAL_COMMIT_STATUS_CONTEXT)],
        RUN_START,
      ),
    ).toBe(false);
  });

  test("a status without a description, or with another one, is not an override", () => {
    expect(
      overrideStandsOverRun([status(undefined, RUN_START + 60_000)], RUN_START),
    ).toBe(false);
    expect(
      overrideStandsOverRun(
        [
          status(
            "pr-hero: 2 blocking finding(s)",
            RUN_START + 60_000,
            COMMIT_STATUS_CONTEXT,
            "failure",
          ),
        ],
        RUN_START,
      ),
    ).toBe(false);
  });

  test("no statuses, the read's fail-open answer, means no override stands", () => {
    expect(overrideStandsOverRun([], RUN_START)).toBe(false);
  });

  test("an override description on a status that is not a success does not stand", () => {
    expect(
      overrideStandsOverRun(
        [
          status(
            OVERRIDE,
            RUN_START + 60_000,
            COMMIT_STATUS_CONTEXT,
            "failure",
          ),
        ],
        RUN_START,
      ),
    ).toBe(false);
  });
});

describe("settleCommitStatusAndLedger — an override posted during this run", () => {
  const OVERRIDE =
    "pr-hero: overridden by @maintainer — no review on this head";
  const LOCK: Parameters<typeof holdCommitStatusLock>[0] = {
    operatorRoot: "/repo",
    sha: HEAD,
    targetUrl: undefined,
    context: COMMIT_STATUS_CONTEXT,
  };
  const overrideAt = (createdMs: number) => ({
    state: "success",
    context: COMMIT_STATUS_CONTEXT,
    created_at: new Date(createdMs).toISOString(),
    description: OVERRIDE,
  });
  // The statuses of a gate run: the POSTs are the only calls that carry a `state=` flag.
  const postCount = (calls: string[][]) =>
    calls.filter((argv) => parseStatusFlags(argv).state !== undefined).length;

  afterEach(() => {
    releaseCommitStatusLock();
  });

  function gateInput(
    spawnFn: typeof Bun.spawn,
    overrides: Partial<Parameters<typeof settleCommitStatusAndLedger>[0]> = {},
  ): Parameters<typeof settleCommitStatusAndLedger>[0] {
    return {
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: null,
      spawnFn,
      ciMode: "gate",
      statusContext: COMMIT_STATUS_CONTEXT,
      blockingCount: 0,
      ...overrides,
    };
  }

  test("an override posted after the review started stands: no final write, the lock is released, and one log line", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = makeStatusSpawn();
    // log() writes to stderr, so that is the stream a test reads.
    const logged: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await settleCommitStatusAndLedger(
        gateInput(spawnFn, {
          readStatuses: async () => [overrideAt(Date.now() + 120_000)],
        }),
      );
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(postCount(calls)).toBe(0);
    expect(heldCommitStatusLock()).toBeNull();
    expect(logged.join("\n")).toContain("override");
  });

  test("an override posted before the review started does not stand: the final write happens", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        readStatuses: async () => [overrideAt(Date.now() - 120_000)],
      }),
    );
    expect(postCount(calls)).toBe(1);
    expect(heldCommitStatusLock()).toBeNull();
  });

  // Fix 1: the run's start is stamped before the pending POST, so the time the POST takes
  // is inside the run. The override checks compare against that stamp with a
  // clock-skew allowance (src/ci/override.ts).
  test("an override created 10 s after the run started, while the pending POST was slow, stands", async () => {
    const STAMP = Date.parse("2026-10-17T12:00:00Z");
    holdCommitStatusLock(LOCK, STAMP);
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        readStatuses: async () => [overrideAt(STAMP + 10_000)],
      }),
    );
    expect(postCount(calls)).toBe(0);
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("an override created 3 s before the run started stands, inside the clock-skew allowance", async () => {
    const STAMP = Date.parse("2026-10-17T12:00:00Z");
    holdCommitStatusLock(LOCK, STAMP);
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        readStatuses: async () => [overrideAt(STAMP - 3_000)],
      }),
    );
    expect(postCount(calls)).toBe(0);
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("an override created 60 s before the run started does not stand: the final write happens", async () => {
    const STAMP = Date.parse("2026-10-17T12:00:00Z");
    holdCommitStatusLock(LOCK, STAMP);
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        readStatuses: async () => [overrideAt(STAMP - 60_000)],
      }),
    );
    expect(postCount(calls)).toBe(1);
    expect(heldCommitStatusLock()).toBeNull();
  });

  // Fix 3: the 5-second allowance covers the clock skew between the run's start and
  // GitHub's clock, and it is only safe while this run's own pending status is the newest
  // pr-hero status to witness that start. When that pending did not land, an override
  // created up to 5 s before the start would read as posted during the run, so the
  // allowance is dropped and the run compares with its start alone.
  test("pending landed: an override created 3 s before the run started stands, inside the allowance", async () => {
    const STAMP = Date.parse("2026-10-17T12:00:00Z");
    holdCommitStatusLock(LOCK, STAMP, true);
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        readStatuses: async () => [overrideAt(STAMP - 3_000)],
      }),
    );
    expect(postCount(calls)).toBe(0);
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("pending failed: an override created 3 s before the run started does not stand: the final write happens", async () => {
    const STAMP = Date.parse("2026-10-17T12:00:00Z");
    holdCommitStatusLock(LOCK, STAMP, false);
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        readStatuses: async () => [overrideAt(STAMP - 3_000)],
      }),
    );
    expect(postCount(calls)).toBe(1);
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("pending failed: an override created 2 s after the run started still stands", async () => {
    const STAMP = Date.parse("2026-10-17T12:00:00Z");
    holdCommitStatusLock(LOCK, STAMP, false);
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        readStatuses: async () => [overrideAt(STAMP + 2_000)],
      }),
    );
    expect(postCount(calls)).toBe(0);
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("a failed statuses read writes the final status, as before", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        readStatuses: async () => {
          throw new Error("gh api timed out");
        },
      }),
    );
    expect(postCount(calls)).toBe(1);
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("the failed read's empty answer also writes the final status", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = makeStatusSpawn();
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, { readStatuses: async () => [] }),
    );
    expect(postCount(calls)).toBe(1);
  });

  test("a gate run that never held the lock reads nothing and writes as before", async () => {
    const { spawnFn, calls } = makeStatusSpawn();
    let reads = 0;
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        readStatuses: async () => {
          reads += 1;
          return [overrideAt(Date.now() + 120_000)];
        },
      }),
    );
    expect(reads).toBe(0);
    expect(postCount(calls)).toBe(1);
  });

  // Fix 2: an `error` write is not a verdict, so it never checks the override, whether or
  // not a body threw. A review whose hunters all failed (sessionFailed) posts `error`, and
  // it replaces a fresh override. The publisher's error write reads no head either, so the
  // two writers give one answer.
  test("a sessionFailed error write is not a verdict: it reads no override and writes over a fresh one", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = makeStatusSpawn();
    let reads = 0;
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        result: pipelineResult(true),
        readStatuses: async () => {
          reads += 1;
          return [overrideAt(Date.now() + 120_000)];
        },
      }),
    );
    expect(postCount(calls)).toBe(1);
    expect(reads).toBe(0);
    expect(heldCommitStatusLock()).toBeNull();
  });

  // A verdict still respects the override: a failure verdict with a fresh override writes
  // nothing. This is the verdict-only scope's other half.
  test("a failure verdict with a fresh override present writes nothing", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = makeStatusSpawn();
    let reads = 0;
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        blockingCount: 2,
        readStatuses: async () => {
          reads += 1;
          return [overrideAt(Date.now() + 120_000)];
        },
      }),
    );
    expect(reads).toBe(1);
    expect(postCount(calls)).toBe(0);
    expect(heldCommitStatusLock()).toBeNull();
  });

  // The body's best-effort error status is not the gate's verdict, so the check does
  // not guard it, whether the body threw or not (the sessionFailed test above).
  test("a body that threw still writes its best-effort status: the check covers the gate's verdict only", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = makeStatusSpawn();
    let reads = 0;
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        bodyFailed: true,
        result: pipelineResult(true),
        readStatuses: async () => {
          reads += 1;
          return [overrideAt(Date.now() + 120_000)];
        },
      }),
    );
    expect(reads).toBe(0);
    expect(postCount(calls)).toBe(1);
  });

  test("advisory mode is unaffected: the final status is written and nothing is read", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = makeStatusSpawn();
    let reads = 0;
    await settleCommitStatusAndLedger(
      gateInput(spawnFn, {
        ciMode: "advisory",
        readStatuses: async () => {
          reads += 1;
          return [overrideAt(Date.now() + 120_000)];
        },
      }),
    );
    expect(reads).toBe(0);
    expect(postCount(calls)).toBe(1);
  });
});

// The override check reads the head through the real reader (fetchCommitStatuses), not a seam.
// The read's gh call is the one carrying `--jq`; the status POST carries none, so a fake can
// fail the read alone and let the verdict write go through.
function readSplitSpawn(read: { ok: boolean; stdout: string }): {
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
    const isRead = argv.includes("--jq");
    const ok = !isRead || read.ok;
    return {
      stdout: stream(isRead ? read.stdout : ""),
      stderr: stream(ok ? "" : "gh: HTTP 500"),
      exited: Promise.resolve(ok ? 0 : 1),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

describe("settleCommitStatusAndLedger — the override read is strict and logged", () => {
  const OVERRIDE =
    "pr-hero: overridden by @maintainer — no review on this head";
  const LOCK: Parameters<typeof holdCommitStatusLock>[0] = {
    operatorRoot: "/repo",
    sha: HEAD,
    targetUrl: undefined,
    context: COMMIT_STATUS_CONTEXT,
  };
  const postCount = (calls: string[][]) =>
    calls.filter((argv) => parseStatusFlags(argv).state !== undefined).length;
  const overrideRow = (createdMs: number) =>
    `${JSON.stringify({
      state: "success",
      context: COMMIT_STATUS_CONTEXT,
      created_at: new Date(createdMs).toISOString(),
      description: OVERRIDE,
      target_url: null,
    })}\n`;

  afterEach(() => {
    releaseCommitStatusLock();
  });

  async function captureStderr(run: () => Promise<unknown>): Promise<string> {
    const logged: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await run();
    } finally {
      process.stderr.write = originalWrite;
    }
    return logged.join("\n");
  }

  function gateInput(
    spawnFn: typeof Bun.spawn,
  ): Parameters<typeof settleCommitStatusAndLedger>[0] {
    return {
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: null,
      spawnFn,
      ciMode: "gate",
      statusContext: COMMIT_STATUS_CONTEXT,
      blockingCount: 0,
    };
  }

  test("a failed head read writes the verdict and logs a warning that says so", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = readSplitSpawn({ ok: false, stdout: "" });
    const logged = await captureStderr(() =>
      settleCommitStatusAndLedger(gateInput(spawnFn)),
    );
    expect(postCount(calls)).toBe(1);
    expect(logged).toContain("::warning");
    expect(logged).toContain("could not read the statuses");
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("a malformed row next to a valid fresh override: the override stands, nothing is written, and no warning is logged", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = readSplitSpawn({
      ok: true,
      stdout: `not a status row\n${overrideRow(Date.now() + 120_000)}`,
    });
    const logged = await captureStderr(() =>
      settleCommitStatusAndLedger(gateInput(spawnFn)),
    );
    expect(postCount(calls)).toBe(0);
    expect(logged).not.toContain("::warning");
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("a read that succeeds with a fresh override writes nothing, as before", async () => {
    holdCommitStatusLock(LOCK);
    const { spawnFn, calls } = readSplitSpawn({
      ok: true,
      stdout: overrideRow(Date.now() + 120_000),
    });
    const logged = await captureStderr(() =>
      settleCommitStatusAndLedger(gateInput(spawnFn)),
    );
    expect(postCount(calls)).toBe(0);
    expect(logged).not.toContain("::warning");
    expect(heldCommitStatusLock()).toBeNull();
  });
});
