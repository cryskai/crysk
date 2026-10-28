// Behavior tests for publishRunOutcome (src/pr/publish-outcome.ts), the
// post-pipeline tail extracted out of reviewPr(). See that module's header
// for the hazard this suite exists to prove: `posted` is declared OUTSIDE
// reviewPr()'s try block (both its finally blocks read it on every exit
// path, including a throw partway through this tail), so `onPosted` must
// fire the INSTANT `postFindingsIfEnabled` resolves — never only at the end.
//
// Boundary-doubling note — a DELIBERATE exception to "double at boundaries
// you do not control" (robust-testing rule 4), disclosed rather than hidden
// behind an internal mock: `postFindingsIfEnabled` (src/pr/posting.ts) and
// `computeComparison` (src/pr/comparison.ts) call real `gh`-backed
// helpers (`ghRepoWebUrl`, `postInlineFindings`, `fetchPrComments`) WITHOUT
// exposing an injectable `spawnFn` at their own parameter surface —
// confirmed by reading both files. That is the same "genuine I/O shell, no
// offline seam" limitation test/cli.test.ts already documents for
// reviewPr() itself and for src/pr/discovery.ts's own fetches. Consequently
// this suite cannot make `postFindingsIfEnabled` PRODUCE a truthy posted
// outcome without mocking those internals, which the task instructions
// forbid — doubling `gh`/`git` here would mean re-implementing the seam the
// production code itself does not have, not testing through one. Instead:
//   - `operatorRoot` is a plain (non-git) temp directory, so every `gh`/
//     `git` call made through it fails FAST and DETERMINISTICALLY offline
//     (verified manually: `gh pr view <n>` against a non-git directory
//     returns in ~20ms with "fatal: not a git repository", no network
//     round-trip) — `ghRepoWebUrl` and `gitRemoteWebUrl` both degrade to
//     `undefined` on that failure. `computeComparison` no longer touches gh
//     (it only writes comparison.json into the run dir), so it always records
//     its artifact here. None of this throws. This
//     only holds with `GH_REPO` unset (it overrides gh's repo detection
//     regardless of cwd) — saved/deleted/restored below, same as
//     `GITHUB_STEP_SUMMARY`/`GITHUB_OUTPUT`, so the suite controls its own
//     failure mode instead of assuming the ambient environment's.
//   - `postEnabled: false` makes `postFindingsIfEnabled` a total, real,
//     zero-I/O no-op (`{ posted: null, postedWebUrl: undefined }`) — this
//     module's own early-return, not a double.
//   - The "a later step throws" half of test 1 is forced through a REAL
//     system-boundary failure instead: `GITHUB_STEP_SUMMARY` pointed at a
//     path inside a directory that does not exist, so `publishCiReviewIfEligible`'s
//     real `node:fs/promises` `appendFile` call rejects with ENOENT.
//   - The outcome-record tests drive the posting stage through the postFindings
//     seam on PublishRunOutcomeInput, so a rejecting post and a resolved post are
//     both deterministic. The seam is test-only; production leaves it unset.
// The result still proves the exact hazard: `onPosted`'s value is captured
// before that later throw, and reverts to "never called" the instant the
// call is moved past it (mutation-checked below).

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFatalCliRecord } from "#ci/cli-record";
import { CLI_RECORD_FILE, parseCliRecord } from "#ci/outcome";
import type { InlinePostOutcome } from "#pr/inline";
import {
  type PublishRunOutcomeInput,
  publishRunOutcome,
} from "#pr/publish-outcome";
import {
  classifyPrior,
  type PhaseBContext,
  type PriorRecord,
} from "#rereview/classify";
import { assembleLive, type GateRow } from "#rereview/state";
import type { Finding, SkillOutput } from "#review/findings";
import type { PipelineResult } from "#review/pipeline";
import type { CliOptions } from "#review/preflight";
import { estimateCost } from "#review/report";
import { CliError } from "../../src/errors";
import { zeroUsage } from "../../src/usage";

function baseOptions(over: Partial<CliOptions> = {}): CliOptions {
  return {
    repo: ".",
    head: "HEAD",
    hopBudget: 3,
    scout: false,
    full: false,
    dryRun: false,
    yes: false,
    post: false,
    twoDot: false,
    onPush: false,
    force: false,
    all: false,
    fixes: false,
    incidents: false,
    issues: false,
    proximity: false,
    threads: false,
    ...over,
  };
}

const HEAD_SHA = "b".repeat(40);
const BASE_SHA = "a".repeat(40);

function baseSkillOutput(): SkillOutput {
  return {
    findings: [],
    debug: { refuted: [] },
    parity_hunter_fired: false,
    run_status: "complete",
  };
}

// Only `id`, `tier` and the render-facing scalars matter to the code under
// test; the enum-valued fields are filled with the first legal-looking value
// the renderer never branches on for these tests.
function findingFixture(id: string, tier: "blocking" | "advisory"): Finding {
  return {
    id,
    category: 1,
    path: "src/a.ts",
    line: 3,
    severity: "WARNING",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: `claim ${id}`,
    proof_refs: [],
    hunter: "reliability",
    tier,
    hops_used: 0,
    hop_trail: [],
    dedupe_key: `key-${id}`,
  } as unknown as Finding;
}

function baseResult(
  over: {
    sessionFailed?: boolean;
    skillOutput?: SkillOutput;
    gatePriors?: readonly GateRow[];
  } = {},
): PipelineResult {
  return {
    skillOutput: over.skillOutput ?? baseSkillOutput(),
    perAgent: {},
    usage: { ...zeroUsage(), cost_usd_est: 0.42 },
    sessionFailed: over.sessionFailed ?? false,
    unresolved: [],
    ...(over.gatePriors === undefined ? {} : { gatePriors: over.gatePriors }),
  } as unknown as PipelineResult;
}

// The gate rows the pipeline hands over, built by the same two functions the
// pipeline itself calls, so these tests run the real classification.
function gateRowsOf(
  priors: readonly PriorRecord[],
  ctx: PhaseBContext,
  verifyVerdicts: ReadonlyMap<
    string,
    "verified-gone" | "unconfirmed" | "carried"
  > = new Map(),
): GateRow[] {
  const settled = priors.map((prior) => classifyPrior(prior, ctx));
  return assembleLive({ settled, priors, verifyVerdicts }).gateRows;
}

function blockingPrior(id: string, locs: string[]): PriorRecord {
  return {
    id,
    sev: "CRITICAL",
    tier: "blocking",
    channel: "inline",
    locs,
    claim: `prior ${id}`,
    triage: null,
    newThreadReply: false,
  };
}

// Every test uses the SAME sentinel discipline for the onPosted capture:
// "not-called" is not a legal InlinePostOutcome | null value, so a test
// asserting the capture moved off it is asserting onPosted actually ran —
// not merely that it ran with some particular (possibly default) value.
const NOT_CALLED = Symbol("onPosted not called");

function captureOnPosted(): {
  onPosted: (posted: InlinePostOutcome | null) => void;
  calls: (InlinePostOutcome | null)[];
  value: () => InlinePostOutcome | null | typeof NOT_CALLED;
} {
  const calls: (InlinePostOutcome | null)[] = [];
  return {
    onPosted: (posted) => {
      calls.push(posted);
    },
    calls,
    value: () =>
      calls.length === 0 ? NOT_CALLED : (calls[calls.length - 1] ?? null),
  };
}

// Isolation (robust-testing rule 14): every env var a test or the code
// under test reads gets saved before and restored after, never just deleted
// — `GH_REPO` is the one that would otherwise silently upgrade the suite's
// "gh fails offline against a non-git dir" assumption into a live,
// possibly-authenticated API call whenever the ambient environment sets it.
const ISOLATED_ENV_VARS = [
  "GITHUB_STEP_SUMMARY",
  "GITHUB_OUTPUT",
  "GH_REPO",
  "PRHERO_OUTCOME_DIR",
];

describe("publishRunOutcome", () => {
  let operatorRoot: string;
  let runDir: string;
  let home: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    operatorRoot = await mkdtemp(path.join(tmpdir(), "prhero-publish-op-"));
    runDir = await mkdtemp(path.join(tmpdir(), "prhero-publish-run-"));
    home = await mkdtemp(path.join(tmpdir(), "prhero-publish-home-"));
    savedEnv = {};
    for (const key of ISOLATED_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await rm(operatorRoot, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    for (const key of ISOLATED_ENV_VARS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function baseInput(
    over: Partial<PublishRunOutcomeInput> = {},
  ): PublishRunOutcomeInput {
    const { onPosted } = captureOnPosted();
    return {
      result: baseResult(),
      started: performance.now(),
      indexMs: 0,
      runDir,
      prNumber: 42,
      diffFromSha: BASE_SHA,
      headSha: HEAD_SHA,
      options: baseOptions(),
      agentFiles: new Map(),
      promptSet: { name: "default", sha256: "deadbeef" },
      operatorRoot,
      baseRef: "main",
      diffStat: { files: 1, insertions: 1, deletions: 0 },
      droppedPaths: [],
      diffPatch: "",
      home,
      repoId: null,
      postEnabled: false,
      rereview: undefined,
      phaseB: undefined,
      gitDirOwner: operatorRoot,
      worktreePath: operatorRoot,
      isCi: false,
      estimate: estimateCost({ files: 1, insertions: 1, deletions: 0 }, 1),
      ciAdmissionLedger: null,
      onPosted,
      onBlockingCount: () => {},
      ciMode: "advisory",
      ...over,
    };
  }

  // Guard clause: the extracted function starts with the SAME
  // `result === undefined` check reviewPr() used to run before this tail —
  // preserved verbatim, so a pipeline that never produced a result still
  // throws before touching onPosted or any artifact.
  test("result undefined throws the same CliError and never calls onPosted", async () => {
    const { onPosted, calls } = captureOnPosted();
    const input = baseInput({ result: undefined, onPosted });
    await expect(publishRunOutcome(input)).rejects.toThrow(CliError);
    await expect(publishRunOutcome(input)).rejects.toThrow(
      "internal: pipeline returned no result",
    );
    expect(calls).toEqual([]);
  });

  // T2d-1 (S2): this is an engine invariant, so the record names it as the
  // pr-hero defect class (PRH-ENGINE-DEFECT), and the message stays the same.
  test("the no-result invariant carries the invariant class", async () => {
    const { onPosted } = captureOnPosted();
    const error = await publishRunOutcome(
      baseInput({ result: undefined, onPosted }),
    ).then(
      () => {
        throw new Error("expected publishRunOutcome to throw");
      },
      (e: CliError) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect(error.cls).toEqual({ kind: "invariant" });
    expect(error.message).toBe("internal: pipeline returned no result");
  });

  // W3-FOOTER: the plan's free-route count travels into the footer, so a free
  // run is not footed as a subscription run. Footer lines go to stderr.
  test("a free route's notional row says so, carried from the plan's count", async () => {
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      },
    );
    try {
      await publishRunOutcome(
        baseInput({
          result: {
            ...baseResult(),
            usageV2: { notionalCostUsd: 0.05 },
          } as unknown as PipelineResult,
          freeRoute: { free: 2, total: 2 },
        }),
      );
    } finally {
      spy.mockRestore();
    }
    const footer = written.join("").replace(/\s+/g, " ");
    expect(footer).toContain("not charged on a free route");
    expect(footer).not.toContain("subscription");
  });

  // Task item 2 (first half): posting disabled is postFindingsIfEnabled's
  // own real, zero-I/O early return — onPosted must receive exactly what
  // that early return produced (null), and the non-CI exit code follows
  // postingExitCode(null) = 0.
  test("posting disabled: onPosted(null), exits via postingExitCode(null)", async () => {
    const { onPosted, value } = captureOnPosted();
    const exitCode = await publishRunOutcome(
      baseInput({ postEnabled: false, isCi: false, onPosted }),
    );
    expect(value()).toBeNull();
    expect(exitCode).toBe(0);
  });

  // Task item 2 (second half): a failed session still runs the whole tail
  // (artifacts are written, posting is attempted-but-null via
  // postInlineIfEligible's own sessionFailed guard) and then short-circuits
  // to exit 1 BEFORE reaching ciExitCode/postingExitCode, exactly as
  // reviewPr() did inline.
  test("session failed: onPosted(null), returns 1 before the exit-code ternary", async () => {
    const { onPosted, value } = captureOnPosted();
    const exitCode = await publishRunOutcome(
      baseInput({
        result: baseResult({ sessionFailed: true }),
        postEnabled: false,
        isCi: false,
        onPosted,
      }),
    );
    expect(value()).toBeNull();
    expect(exitCode).toBe(1);
  });

  // Task item 3: the happy path's artifacts and return value are exactly
  // what reviewPr() reads afterwards (findings.json / report.md on disk,
  // exit code 0 with nothing posted and no CI ledger to settle).
  // S4: the gate reads the blocking count from the same findings document the
  // CI publish reads, so the sink must carry the tier:"blocking" count only.
  test("onBlockingCount carries this run's blocking survivors when no prior is live", async () => {
    const blockingCounts: number[] = [];
    const exitCode = await publishRunOutcome(
      baseInput({
        result: baseResult({
          skillOutput: {
            ...baseSkillOutput(),
            findings: [
              findingFixture("F001", "blocking"),
              findingFixture("F002", "blocking"),
              findingFixture("F003", "advisory"),
            ],
          },
        }),
        onBlockingCount: (count) => {
          blockingCounts.push(count);
        },
      }),
    );
    expect(exitCode).toBe(0);
    expect(blockingCounts).toEqual([2]);
  });

  // The gate count is UNRESOLVED blocking findings, not this run's survivors:
  // this run's blocking survivors plus every live blocking prior that nothing
  // verified gone. Three holes read green before it: a re-review carrying a
  // blocking prior, a same-head forced re-review with zero survivors, and a
  // self-asserted triage suppressing the prior.
  describe("the gate count is unresolved, not this run's survivors", () => {
    const caseC: PhaseBContext = {
      case: "C",
      deletedFiles: new Set(),
      renameMap: new Map(),
      touched: () => false,
      summaryUpdatedAt: null,
    };

    async function unresolvedCountFor(result: PipelineResult): Promise<number> {
      const counts: number[] = [];
      await publishRunOutcome(
        baseInput({
          result,
          onBlockingCount: (count) => {
            counts.push(count);
          },
        }),
      );
      expect(counts).toHaveLength(1);
      return counts[0] ?? -1;
    }

    test("a same-head forced re-review with a live blocking prior is unresolved, not green", async () => {
      // Case B: discovery is skipped, so there are no survivors at all. The one
      // carried blocking prior is still unresolved.
      const gatePriors = gateRowsOf(
        [blockingPrior("R001", ["src/app.ts:10"])],
        { ...caseC, case: "B" },
      );
      expect(await unresolvedCountFor(baseResult({ gatePriors }))).toBe(1);
    });

    test("case C with an untouched blocking prior counts it beside this run's own survivor", async () => {
      const gatePriors = gateRowsOf(
        [blockingPrior("R001", ["src/old.ts:4"])],
        caseC,
      );
      expect(
        await unresolvedCountFor(
          baseResult({
            gatePriors,
            skillOutput: {
              ...baseSkillOutput(),
              findings: [findingFixture("F001", "blocking")],
            },
          }),
        ),
      ).toBe(2);
    });

    test("a fix the verifier refuted reads green: the prior leaves the count", async () => {
      // touched, so the prior is queued and the verifier's refuted verdict
      // settles it verified-gone.
      const gatePriors = gateRowsOf(
        [blockingPrior("R001", ["src/app.ts:10"])],
        { ...caseC, touched: () => true },
        new Map([["R001", "verified-gone"]]),
      );
      expect(await unresolvedCountFor(baseResult({ gatePriors }))).toBe(0);
    });

    test("a prior whose every file was deleted reads green", async () => {
      const gatePriors = gateRowsOf(
        [blockingPrior("R001", ["src/app.ts:10"])],
        { ...caseC, deletedFiles: new Set(["src/app.ts"]) },
      );
      expect(await unresolvedCountFor(baseResult({ gatePriors }))).toBe(0);
    });

    test("a blocking prior at the same spot as an advisory survivor of this run still counts", async () => {
      // An advisory survivor never clears a blocking prior: identity matching
      // is a 5-line window, so it can pair with a different issue.
      const gatePriors = gateRowsOf(
        [blockingPrior("R001", ["src/app.ts:10"])],
        caseC,
      );
      const advisorySurvivor = {
        ...findingFixture("F001", "advisory"),
        path: "src/app.ts",
        line: 10,
      } as Finding;
      expect(
        await unresolvedCountFor(
          baseResult({
            gatePriors,
            skillOutput: { ...baseSkillOutput(), findings: [advisorySurvivor] },
          }),
        ),
      ).toBe(1);
    });
  });

  // S4, report artifact chain: publishRunOutcome -> writeRunReport -> report.md.
  // The mode this run resolved is the mode its report.md closing note names.
  test("a CI gate run's report.md closing note backs the required status, and never disclaims a merge gate", async () => {
    await publishRunOutcome(baseInput({ isCi: true, ciMode: "gate" }));
    const report = readFileSync(path.join(runDir, "report.md"), "utf8");
    expect(report).toContain(
      "This report backs the pr-hero commit status, the required check in gate mode",
    );
    expect(report).not.toContain("not a merge gate");
  });

  test("an advisory CI run's report.md keeps today's closing note", async () => {
    await publishRunOutcome(baseInput({ isCi: true, ciMode: "advisory" }));
    const report = readFileSync(path.join(runDir, "report.md"), "utf8");
    expect(report).toContain(
      "This is an assistant report, not a merge gate: every line above is a claim to verify",
    );
  });

  // S4, step summary chain: publishRunOutcome -> publishCiReviewIfEligible ->
  // planCiReview -> renderStepSummary -> $GITHUB_STEP_SUMMARY.
  test("a CI gate run's step summary carries the gate footer", async () => {
    const summaryPath = path.join(runDir, "step-summary.md");
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    await publishRunOutcome(baseInput({ isCi: true, ciMode: "gate" }));
    expect(readFileSync(summaryPath, "utf8")).toContain(
      "Assistant report backing the pr-hero commit status, the required check in gate mode.</sub>",
    );
  });

  test("happy path: writes findings.json and report.md, returns postingExitCode(null)", async () => {
    const exitCode = await publishRunOutcome(baseInput());
    expect(exitCode).toBe(0);
    const findingsPath = path.join(runDir, "findings.json");
    const reportPath = path.join(runDir, "report.md");
    expect(await Bun.file(findingsPath).exists()).toBe(true);
    expect(await Bun.file(reportPath).exists()).toBe(true);
    const doc = JSON.parse(await Bun.file(findingsPath).text());
    expect(doc.pr).toBe(42);
    expect(doc.head_sha).toBe(HEAD_SHA);
    expect(doc.base_sha).toBe(BASE_SHA);
    expect(doc.run_status).toBe("complete");
  });

  // Task item 1: posting "succeeds" (postFindingsIfEnabled's real, offline
  // no-op path — see the file header for why a truthy posted outcome is not
  // reachable without mocking gh internals) and a LATER real step throws
  // (publishCiReviewIfEligible's own `node:fs/promises` write, forced to
  // fail by pointing GITHUB_STEP_SUMMARY at a nonexistent directory). The
  // throw must propagate, and onPosted must have already fired.
  test("a later step throws after posting resolves: error propagates, onPosted already fired", async () => {
    process.env.GITHUB_STEP_SUMMARY = path.join(
      operatorRoot,
      "no-such-dir",
      "summary.md",
    );
    const { onPosted, value } = captureOnPosted();
    const input = baseInput({
      isCi: true,
      result: baseResult({ sessionFailed: false }),
      postEnabled: false,
      onPosted,
    });
    await expect(publishRunOutcome(input)).rejects.toThrow();
    expect(value()).not.toBe(NOT_CALLED);
    expect(value()).toBeNull();
  });

  // The outcome record at the delivery point. The posting stage is injected
  // through the postFindings seam: the real one reaches gh with no offline seam
  // of its own, so a rejecting or resolving fake is the only way to drive it.
  describe("the outcome record", () => {
    let outcome: string;

    const REVIEWED = { v: 1, outcome: "reviewed", head_sha: HEAD_SHA };
    const POSTING_FAILED = {
      v: 1,
      outcome: "error",
      cls: { kind: "unknown" },
      params: { step: "posting the review" },
    };
    const postsNothing = async () => ({
      posted: null,
      postedWebUrl: undefined,
    });
    // A post that resolves: it reaches the delivery point first, as the real
    // stage does. This fake passes posted null, since the outcome's shape is
    // large here; the non-null guarantee is pinned in test/pr/posting.test.ts.
    const postsAndDelivers = async (stage: { onDelivered?: () => void }) => {
      stage.onDelivered?.();
      return postsNothing();
    };

    beforeEach(() => {
      outcome = path.join(home, "outcome");
      process.env.PRHERO_OUTCOME_DIR = outcome;
    });

    function readCli(): unknown {
      return parseCliRecord(
        readFileSync(path.join(outcome, CLI_RECORD_FILE), "utf8"),
      );
    }

    function captureStderr(fn: () => void): string[] {
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
      return chunks;
    }

    test("a posting that throws records error at the posting step, never reviewed, and rethrows the same error", async () => {
      const postError = new Error("gh went away");
      const input = baseInput({
        postEnabled: true,
        postFindings: async () => {
          throw postError;
        },
      });
      await expect(publishRunOutcome(input)).rejects.toBe(postError);
      expect(readCli()).toEqual(POSTING_FAILED);
    });

    test("a posting that throws with no outcome directory writes nothing and still rethrows", async () => {
      delete process.env.PRHERO_OUTCOME_DIR;
      const postError = new Error("gh went away");
      const input = baseInput({
        postEnabled: true,
        postFindings: async () => {
          throw postError;
        },
      });
      await expect(publishRunOutcome(input)).rejects.toBe(postError);
      expect(existsSync(path.join(outcome, CLI_RECORD_FILE))).toBe(false);
    });

    // CHANGED (F002 on #330): reviewed is written at the delivery point inside
    // the posting stage, through onDelivered, not after the stage returns.
    test("reviewed is written at the delivery point: the post itself saw no record yet, and the record exists once it fires", async () => {
      let recordAtPost: boolean | undefined;
      let recordAtDelivery: boolean | undefined;
      const input = baseInput({
        postEnabled: true,
        postFindings: async (stage) => {
          recordAtPost = existsSync(path.join(outcome, CLI_RECORD_FILE));
          stage.onDelivered?.();
          recordAtDelivery = existsSync(path.join(outcome, CLI_RECORD_FILE));
          return postsNothing();
        },
      });
      expect(await publishRunOutcome(input)).toBe(0);
      expect(recordAtPost).toBe(false);
      expect(recordAtDelivery).toBe(true);
      expect(readCli()).toEqual(REVIEWED);
    });

    // WHY this test (F002 on #330): the receipt write runs after the delivery
    // point. A throw there is a failure after the review was delivered, so the
    // record keeps reviewed, and the posting error record is not written over it.
    test("a receipt-write throw after delivery keeps reviewed: the error propagates and no posting error replaces it", async () => {
      const receiptError = new Error("EACCES: receipt");
      const input = baseInput({
        postEnabled: true,
        postFindings: async (stage) => {
          stage.onDelivered?.();
          throw receiptError;
        },
      });
      await expect(publishRunOutcome(input)).rejects.toBe(receiptError);
      expect(readCli()).toEqual(REVIEWED);
    });

    test("a later step throws after posting: reviewed is kept, and the fatal path keeps it with one line", async () => {
      process.env.GITHUB_STEP_SUMMARY = path.join(
        operatorRoot,
        "no-such-dir",
        "summary.md",
      );
      const input = baseInput({
        isCi: true,
        postEnabled: true,
        postFindings: postsAndDelivers,
      });
      await expect(publishRunOutcome(input)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(readCli()).toEqual(REVIEWED);
      const chunks = captureStderr(() =>
        writeFatalCliRecord({ kind: "unknown" }),
      );
      expect(readCli()).toEqual(REVIEWED);
      expect(chunks).toEqual([
        "pr-hero: kept the recorded reviewed outcome; a later step failed\n",
      ]);
    });

    test("posting disabled: reviewed is written once the artifacts exist", async () => {
      expect(await publishRunOutcome(baseInput({ postEnabled: false }))).toBe(
        0,
      );
      const findings = path.join(runDir, "findings.json");
      expect(await Bun.file(findings).exists()).toBe(true);
      expect(readCli()).toEqual(REVIEWED);
    });

    test("posting disabled: when the artifacts cannot be written, no reviewed record is left", async () => {
      // A regular file where the run directory should be: the artifact writes
      // fail before the record would be written.
      const blocker = path.join(home, "blocker");
      writeFileSync(blocker, "");
      await expect(
        publishRunOutcome(
          baseInput({
            postEnabled: false,
            runDir: path.join(blocker, "run"),
          }),
        ),
      ).rejects.toThrow();
      expect(existsSync(path.join(outcome, CLI_RECORD_FILE))).toBe(false);
    });

    test("a failed session writes no reviewed record here: hunters-failed is the pipeline's", async () => {
      await publishRunOutcome(
        baseInput({
          result: baseResult({ sessionFailed: true }),
          postEnabled: false,
        }),
      );
      expect(existsSync(path.join(outcome, CLI_RECORD_FILE))).toBe(false);
    });
  });
});
