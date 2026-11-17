// Phase 3 (Pillar 3, GitHub Actions CI): Review CLI Integration & CI
// Headless Shell. Ties Phase 1's reporter (ci/reporter.ts) and Phase 2's
// gates (ci/gates.ts) into the CLI surface: `--ci`/`--budget-usd`/
// `--step-summary` parsing, environment auto-detection, and the pure "what
// to publish" compositions reviewPr's shell calls mechanically (see cli.ts's
// reviewPr — the size-gate and budget-gate CI branches). The exit-code
// contract is pinned in test/review/exit-code.test.ts.
//
// Style mirrors ci/gates.test.ts / ci/reporter.test.ts: no mocks, no I/O,
// plain literals for the upstream types.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ciForceReviewDispatch } from "#ci/force-comment";
import {
  assertRunMatchesPr,
  type CiGateSkipPlan,
  ciGateSkipOutputs,
  deriveCiBillingMode,
  planCiLimitsSkip,
  planCiReview,
  planCiSizeSkip,
  SKIP_BUDGET_COMMENT_MARKER,
  SKIP_SIZE_COMMENT_MARKER,
  shouldPublishCiReview,
  shouldWriteCiOutputs,
  shouldWriteStepSummary,
} from "#ci/gates";
import {
  type CiOutputs,
  reportFatalCiError,
  withCiWorkflowGroup,
} from "#ci/reporter";
import type { Finding, FindingsDocument, Telemetry } from "#review/findings";
import {
  isCiEnvironment,
  parseArgs,
  removedFlagWarnings,
} from "#review/preflight";
import type { SizeGateVerdict } from "#review/size-gate";
import { CliUsageError } from "../../src/errors";

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    category: 12,
    path: "src/app.ts",
    line: 42,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "the value is stored in seconds and read as milliseconds",
    proof_refs: [],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 2,
    hop_trail: [],
    dedupe_key: `${overrides.path ?? "src/app.ts"}::12`,
    ...overrides,
  };
}

// Minimal fixture for assertRunMatchesPr below: only `.pr` is inspected, but
// the function's signature takes a full FindingsDocument. Duplicated from
// test/cli.test.ts's own (larger) `doc()` rather than imported — no shared
// test-fixture module exists in this repo (see that file's own fakeGh note).
const TELEMETRY: Telemetry = {
  index_ms: 0,
  index_mode: "sync",
  index_disk_mb: 0,
  wall_ms: 1000,
  tokens_in: 10,
  tokens_out: 10,
  tokens_total: 20,
};

function doc(overrides: Partial<FindingsDocument> = {}): FindingsDocument {
  return {
    schema_version: "1.0.0",
    pr: 42,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    model: "sonnet",
    iteration: 0,
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: TELEMETRY,
    findings: [],
    debug: { refuted: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isCiEnvironment — design 3.1: Boolean(GITHUB_ACTIONS || CI || options.ci)
// ---------------------------------------------------------------------------

describe("isCiEnvironment", () => {
  test("false with no --ci flag and no env vars", () => {
    expect(isCiEnvironment({}, {})).toBe(false);
  });

  test("true when GITHUB_ACTIONS is set (auto-detection)", () => {
    expect(isCiEnvironment({}, { GITHUB_ACTIONS: "true" })).toBe(true);
  });

  test("true when CI is set", () => {
    expect(isCiEnvironment({}, { CI: "true" })).toBe(true);
  });

  test("true when --ci is explicitly passed, regardless of env", () => {
    expect(isCiEnvironment({ ci: true }, {})).toBe(true);
  });

  test("an explicit --ci: false does not override a true env var", () => {
    // options.ci is `boolean | undefined`; false is a real value here only
    // when parseArgs never actually produces it (there is no --no-ci flag —
    // this is the "OR", not "AND", boundary named in design 3.1).
    expect(isCiEnvironment({ ci: false }, { GITHUB_ACTIONS: "true" })).toBe(
      true,
    );
  });

  test("GITHUB_ACTIONS=false (the literal string) is still truthy per Boolean() semantics", () => {
    // Matches design 3.1's literal formula exactly: Boolean(process.env.X)
    // treats ANY non-empty string as true, including the string "false" —
    // GitHub Actions itself never sets the var to that, but the formula is
    // pinned here so a future "helpful" `=== "true"` rewrite is caught.
    expect(isCiEnvironment({}, { GITHUB_ACTIONS: "false" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — --ci / --step-summary / --no-step-summary, and the retired --budget-usd
// ---------------------------------------------------------------------------

describe("parseArgs — --ci", () => {
  test("parses --ci on review --pr", () => {
    const { options } = parseArgs(["review", "--pr", "5", "--ci"]);
    expect(options.ci).toBe(true);
  });

  test("--ci without --pr is a silently dropped intention — rejected", () => {
    expect(() => parseArgs(["review", "--ci"])).toThrow(/--pr/);
  });

  test("--ci only applies to the review or setup command", () => {
    // Phase 4 (CI Scaffolding) gave --ci a second, command-scoped meaning on
    // `setup`; the "which commands accept it" error message widened to
    // match. Every other command is still rejected.
    expect(() =>
      parseArgs(["post", "--pr", "5", "--from", "run1", "--ci"]),
    ).toThrow(/review or setup command/);
  });
});

// platform-owned-cost T7 (S7): `--budget-usd` is retired. It stays accepted
// anywhere, whatever its value, has no effect, and says so once.
describe("parseArgs — --budget-usd (retired)", () => {
  const base = parseArgs(["review", "--pr", "5", "--ci"]).options;

  test.each([
    ["a float", "7.5"],
    ["zero", "0"],
    ["a negative number", "-1"],
    ["a non-number", "lots"],
  ])("accepts %s, with no effect on any other option", (_, value) => {
    const { options } = parseArgs([
      "review",
      "--pr",
      "5",
      "--ci",
      "--budget-usd",
      value,
    ]);
    expect(options.removedFlags).toEqual(["--budget-usd"]);
    expect({ ...options, removedFlags: undefined }).toEqual({
      ...base,
      removedFlags: undefined,
    });
    expect("budgetUsd" in options).toBe(false);
  });

  test("is accepted without --ci too: nothing is dropped silently any more, it is announced", () => {
    const { options } = parseArgs(["review", "--pr", "5", "--budget-usd", "5"]);
    expect(options.removedFlags).toEqual(["--budget-usd"]);
  });

  test("produces exactly one warning, however often it is given", () => {
    const { options } = parseArgs([
      "review",
      "--pr",
      "5",
      "--ci",
      "--budget-usd",
      "5",
      "--budget-usd",
      "6",
    ]);
    expect(removedFlagWarnings(options)).toEqual([
      "--budget-usd is ignored: dollar limits moved to the Crysk platform (Review > Limits in the dashboard)",
    ]);
  });

  test("the scout flags keep their own warning beside it", () => {
    const { options } = parseArgs(["review", "--scout", "--budget-usd", "5"]);
    expect(removedFlagWarnings(options)).toEqual([
      "--scout is ignored: the scout stage was removed",
      "--budget-usd is ignored: dollar limits moved to the Crysk platform (Review > Limits in the dashboard)",
    ]);
  });
});

describe("parseArgs — --ci-mode", () => {
  test("accepts gate and advisory with review --ci", () => {
    expect(
      parseArgs(["review", "--pr", "5", "--ci", "--ci-mode", "gate"]).options
        .ciMode,
    ).toBe("gate");
    expect(
      parseArgs(["review", "--pr", "5", "--ci", "--ci-mode", "advisory"])
        .options.ciMode,
    ).toBe("advisory");
  });

  test("is unset when not given: the run resolves the mode, not the parser", () => {
    expect(
      parseArgs(["review", "--pr", "5", "--ci"]).options.ciMode,
    ).toBeUndefined();
  });

  test("an invalid value fails loud", () => {
    expect(() =>
      parseArgs(["review", "--pr", "5", "--ci", "--ci-mode", "warn"]),
    ).toThrow(/--ci-mode/);
  });

  test("--ci-mode without --ci is a silently dropped intention — rejected", () => {
    expect(() =>
      parseArgs(["review", "--pr", "5", "--ci-mode", "advisory"]),
    ).toThrow(/--ci/);
  });

  test("--ci-mode on setup --ci is accepted: the scaffold writes it into the workflow", () => {
    expect(
      parseArgs(["setup", "--ci", "--ci-mode", "advisory"]).options.ciMode,
    ).toBe("advisory");
  });

  test("--ci-mode on setup without --ci is still rejected", () => {
    expect(() => parseArgs(["setup", "--ci-mode", "advisory"])).toThrow(
      /--ci-mode/,
    );
  });
});

describe("parseArgs — --step-summary / --no-step-summary", () => {
  test("--step-summary sets stepSummary true", () => {
    const { options } = parseArgs([
      "review",
      "--pr",
      "5",
      "--ci",
      "--step-summary",
    ]);
    expect(options.stepSummary).toBe(true);
  });

  test("--no-step-summary sets stepSummary false", () => {
    const { options } = parseArgs([
      "review",
      "--pr",
      "5",
      "--ci",
      "--no-step-summary",
    ]);
    expect(options.stepSummary).toBe(false);
  });

  test("unset stepSummary defaults to undefined (the shell treats it as on)", () => {
    const { options } = parseArgs(["review", "--pr", "5", "--ci"]);
    expect(options.stepSummary).toBeUndefined();
  });

  test("--step-summary without --ci is a silently dropped intention — rejected", () => {
    expect(() => parseArgs(["review", "--pr", "5", "--step-summary"])).toThrow(
      /--ci/,
    );
  });
});

// ---------------------------------------------------------------------------
// ciGateSkipOutputs — spec 1.1's $GITHUB_OUTPUT contract for a skip.
// ---------------------------------------------------------------------------

describe("ciGateSkipOutputs", () => {
  test("skipped-size: zero counts, no run dir, and no cost field (the engine reports no dollars)", () => {
    const outputs: CiOutputs = ciGateSkipOutputs("skipped-size");
    expect(outputs).toEqual({
      status: "skipped-size",
      findings_count: 0,
      blocking_count: 0,
      advisory_count: 0,
      run_dir: "",
    });
  });

  test("skipped-budget keeps today's status, with the same zero counts", () => {
    const outputs = ciGateSkipOutputs("skipped-budget");
    expect(outputs.status).toBe("skipped-budget");
    expect(outputs.findings_count).toBe(0);
    expect(outputs.run_dir).toBe("");
    expect("cost_usd_est" in outputs).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planCiSizeSkip / planCiLimitsSkip — the ONE pure call reviewPr's shell
// makes for a gate skip: everything it needs (comment, marker, summary
// markdown, outputs) built from the SAME numbers, so the PR comment and the
// step summary can never independently drift.
// ---------------------------------------------------------------------------

const failedLinesGate: SizeGateVerdict = {
  ok: false,
  reason: "lines",
  effectiveLines: 1200,
  effectiveFiles: 60,
  excludedFiles: 0,
  excludedLines: 0,
  limit: 1000,
  message: "1200 effective changed lines exceeds the 1000-line limit",
};

const passingGate: SizeGateVerdict = {
  ok: true,
  effectiveLines: 40,
  effectiveFiles: 3,
  excludedFiles: 0,
  excludedLines: 0,
};

describe("planCiSizeSkip", () => {
  test("null when the gate passed", () => {
    expect(
      planCiSizeSkip({
        isCi: true,
        ciMode: "advisory",
        verdict: passingGate,
        prNumber: 55,
        maxChangedLines: 1000,
        maxChangedFiles: 50,
      }),
    ).toBeNull();
  });

  test("null outside CI even when the gate failed", () => {
    expect(
      planCiSizeSkip({
        isCi: false,
        ciMode: "advisory",
        verdict: failedLinesGate,
        prNumber: 55,
        maxChangedLines: 1000,
        maxChangedFiles: 50,
      }),
    ).toBeNull();
  });

  // S4, skip-summary chain: review-pr -> planCiSizeSkip -> renderStepSummary.
  test("a gate run's size-skip summary carries the gate footer, not the merge-gate disclaimer", () => {
    const plan = planCiSizeSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
      ciMode: "gate",
    });
    expect(plan?.summaryMarkdown).toContain(
      "Assistant report backing the crysk commit status, the required check in gate mode.</sub>",
    );
    expect(plan?.summaryMarkdown).not.toContain("not a merge gate");
  });

  test("builds the full plan: comment, marker, summary markdown, and status=skipped-size outputs", () => {
    const plan: CiGateSkipPlan | null = planCiSizeSkip({
      isCi: true,
      ciMode: "advisory",
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error("unreachable");
    expect(plan.markerPrefix).toBe(SKIP_SIZE_COMMENT_MARKER);
    expect(plan.comment.startsWith(SKIP_SIZE_COMMENT_MARKER)).toBe(true);
    expect(plan.comment).toContain("Comment `/crysk review`");
    expect(plan.comment).toContain(ciForceReviewDispatch(55));
    expect(plan.summaryMarkdown).toContain("PR #55");
    expect(plan.outputs).toEqual({
      status: "skipped-size",
      findings_count: 0,
      blocking_count: 0,
      advisory_count: 0,
      run_dir: "",
    });
  });
});

// ---------------------------------------------------------------------------
// The CI limits gate by billing mode (issue #156 route policy, L55 limits).
// The platform's limits skip only a run that bills an API key: how the run
// bills is the engine's own `deriveCiBillingMode`, which the platform cannot
// see. These compose the same two pure functions the shell composes
// (src/pr/plan.ts), so a wiring change that drops one has to break a test here.
// ---------------------------------------------------------------------------

function limitsGateFor(input: {
  env: Record<string, string | undefined>;
  limits: Parameters<typeof planCiLimitsSkip>[0]["limits"];
  force?: boolean;
}): CiGateSkipPlan | null {
  return planCiLimitsSkip({
    isCi: true,
    ciMode: "advisory",
    billingMode: deriveCiBillingMode(input.env),
    limits: input.limits,
    prNumber: 156,
    force: input.force ?? false,
  });
}

describe("CI limits gate by billing mode", () => {
  const over = { reviewUsd: 12, estimateUsd: 25 };

  test("subscription route: never skipped, at any estimate or with the month used up", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" };
    expect(limitsGateFor({ env, limits: over })).toBeNull();
    expect(limitsGateFor({ env, limits: { monthLeftUsd: 0 } })).toBeNull();
  });

  test("metered route over the per-review limit: skipped, naming the limit and the dashboard", () => {
    const plan = limitsGateFor({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      limits: over,
    });
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error("unreachable");
    expect(plan.outputs.status).toBe("skipped-budget");
    expect(plan.comment.startsWith(SKIP_BUDGET_COMMENT_MARKER)).toBe(true);
    expect(plan.comment).toContain("per-review limit");
    expect(plan.comment).toContain("Review > Limits");
  });

  test("metered route within the limits, or with no limits at all: runs", () => {
    const env = { ANTHROPIC_API_KEY: "sk-test" };
    expect(
      limitsGateFor({ env, limits: { reviewUsd: 12, estimateUsd: 11 } }),
    ).toBeNull();
    expect(limitsGateFor({ env, limits: undefined })).toBeNull();
  });

  test("an OpenCode route bound to an API key counts as metered", () => {
    const plan = planCiLimitsSkip({
      isCi: true,
      ciMode: "advisory",
      billingMode: deriveCiBillingMode({}, { openCodeBillsMetered: true }),
      limits: { monthLeftUsd: 0 },
      prNumber: 156,
      force: false,
    });
    expect(plan?.outputs.status).toBe("skipped-budget");
  });

  test("`/crysk review` (force) is never skipped", () => {
    expect(
      limitsGateFor({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        limits: { monthLeftUsd: 0, reviewUsd: 1, estimateUsd: 99 },
        force: true,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// planCiReview — the "reviewed" (non-skip) outcome's summary + outputs.
// Exercises the assistant-posture bullet directly: blocking findings still
// publish, and the outputs/summary never encode a pass/fail verdict.
// ---------------------------------------------------------------------------

describe("planCiReview", () => {
  test("blocking findings are published in the summary, not suppressed", () => {
    const findings = [
      finding({ id: "F001", tier: "blocking", severity: "BLOCKER" }),
      finding({ id: "F002", tier: "advisory", severity: "SUGGESTION" }),
    ];
    const plan = planCiReview({
      prNumber: 5,
      headSha: "a".repeat(40),
      findings,
      wallMs: 90_000,
      model: "sonnet",
      runDir: "/tmp/run",
      ciMode: "advisory",
    });
    expect(plan.summaryMarkdown).toContain("src/app.ts");
    expect(plan.summaryMarkdown).toContain("blocking");
    expect(plan.outputs.status).toBe("reviewed");
    expect(plan.outputs.findings_count).toBe(2);
    expect(plan.outputs.blocking_count).toBe(1);
    expect(plan.outputs.advisory_count).toBe(1);
    expect(plan.outputs.run_dir).toBe("/tmp/run");
  });

  test("a clean review (no findings) still status=reviewed, not skipped", () => {
    const plan = planCiReview({
      prNumber: 5,
      headSha: "a".repeat(40),
      findings: [],
      wallMs: 30_000,
      model: "sonnet",
      runDir: "/tmp/run",
      ciMode: "advisory",
    });
    expect(plan.outputs.status).toBe("reviewed");
    expect(plan.outputs.findings_count).toBe(0);
    expect(plan.summaryMarkdown).toContain("No findings detected");
  });
});

// ---------------------------------------------------------------------------
// shouldWriteCiOutputs / shouldWriteStepSummary — the pure decision behind
// "Step summary file writing when $GITHUB_STEP_SUMMARY is provided" /
// "Output parameter writing when $GITHUB_OUTPUT is provided".
// ---------------------------------------------------------------------------

describe("shouldWriteCiOutputs", () => {
  test("true when in CI and the output path is a non-empty string", () => {
    expect(shouldWriteCiOutputs(true, "/tmp/gh-output")).toBe(true);
  });

  test("false when not in CI, even with a path present", () => {
    expect(shouldWriteCiOutputs(false, "/tmp/gh-output")).toBe(false);
  });

  test("false when the path is undefined", () => {
    expect(shouldWriteCiOutputs(true, undefined)).toBe(false);
  });

  test("false when the path is an empty string", () => {
    expect(shouldWriteCiOutputs(true, "")).toBe(false);
  });
});

describe("shouldWriteStepSummary", () => {
  test("true when in CI, the flag is unset (default on), and the path is present", () => {
    expect(shouldWriteStepSummary(true, undefined, "/tmp/summary.md")).toBe(
      true,
    );
  });

  test("true when the flag is explicitly on", () => {
    expect(shouldWriteStepSummary(true, true, "/tmp/summary.md")).toBe(true);
  });

  test("false when the flag is explicitly off (--no-step-summary)", () => {
    expect(shouldWriteStepSummary(true, false, "/tmp/summary.md")).toBe(false);
  });

  test("false when not in CI", () => {
    expect(shouldWriteStepSummary(false, undefined, "/tmp/summary.md")).toBe(
      false,
    );
  });

  test("false when the path is undefined", () => {
    expect(shouldWriteStepSummary(true, undefined, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldPublishCiReview — design D6's "a failed session publishes nothing",
// applied to the CI headless channel. `sessionFailed` means EVERY hunter
// died, which leaves `doc.findings` empty; publishing that as
// `status=reviewed` + a "No findings detected" step summary would tell a
// human the PR came back clean from a review that never ran. The job still
// exits non-zero, but a red job whose own artifacts assert a clean review is
// worse than a red job with no artifacts at all.
// ---------------------------------------------------------------------------

describe("shouldPublishCiReview", () => {
  test("true for a CI run whose session completed", () => {
    expect(shouldPublishCiReview(true, false)).toBe(true);
  });

  test("a crashed CI session publishes NO reviewed outputs or step summary", () => {
    expect(shouldPublishCiReview(true, true)).toBe(false);
  });

  test("false outside CI, session outcome notwithstanding", () => {
    expect(shouldPublishCiReview(false, false)).toBe(false);
    expect(shouldPublishCiReview(false, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withCiWorkflowGroup — spec 2.1's `::group::` / `::endgroup::` pairing.
// An unclosed group is not a cosmetic defect: everything the runner logs
// afterwards, the `::error::` annotation explaining the crash included, stays
// folded inside a collapsed section. The pairing therefore has to hold on the
// FAILURE path, which is the only path where reading the log matters.
// ---------------------------------------------------------------------------

describe("withCiWorkflowGroup", () => {
  test("wraps the body in a matched group/endgroup pair", async () => {
    const lines: string[] = [];
    const result = await withCiWorkflowGroup(
      true,
      "pr-hero review",
      (line) => lines.push(line),
      async () => {
        lines.push("body");
        return "value";
      },
    );
    expect(result).toBe("value");
    expect(lines).toEqual(["::group::pr-hero review", "body", "::endgroup::"]);
  });

  test("emits ::endgroup:: even when the body throws, and rethrows", async () => {
    const lines: string[] = [];
    await expect(
      withCiWorkflowGroup(
        true,
        "pr-hero review",
        (line) => lines.push(line),
        async () => {
          throw new Error("EROFS: read-only file system");
        },
      ),
    ).rejects.toThrow("EROFS: read-only file system");
    expect(lines).toEqual(["::group::pr-hero review", "::endgroup::"]);
  });

  test("emits no workflow commands at all outside CI", async () => {
    const lines: string[] = [];
    const result = await withCiWorkflowGroup(
      false,
      "pr-hero review",
      (line) => lines.push(line),
      async () => "value",
    );
    expect(result).toBe("value");
    expect(lines).toEqual([]);
  });
});

describe("assertRunMatchesPr — Threat Matrix: Git repository selection", () => {
  test("a run-dir for the SAME pr passes silently", () => {
    expect(() =>
      assertRunMatchesPr(doc({ pr: 42 }), 42, "/runs/x"),
    ).not.toThrow();
  });

  // Deferred from PR2's verification (WARN-1's scope note): the `post` verb
  // must reject a run-dir belonging to a DIFFERENT PR than --pr names,
  // rather than silently publishing PR #17's findings to PR #18.
  test("a run-dir for a DIFFERENT pr is rejected, naming both", () => {
    try {
      assertRunMatchesPr(doc({ pr: 17 }), 18, "/runs/pr-17-run");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("17");
      expect((error as Error).message).toContain("18");
      expect((error as Error).message).toContain("/runs/pr-17-run");
    }
  });
});

// Pillar 3 Phase 5, gap closure: spec 1.1's `status` output enum listed
// `error` from the start, but nothing ever wrote it — a fatal, unhandled
// failure crashed the process with no $GITHUB_OUTPUT at all, so a workflow
// branching on `steps.x.outputs.status == 'error'` could never fire.
// reportFatalCiError is runCli()'s last-resort catch-all: it writes
// status=error (with zeroed counters — there is no completed review to
// report numbers for) and emits a `::error::` workflow command, so the
// contract's fifth enum member finally has a real emitter.
describe("reportFatalCiError — spec 1.1's fatal `error` status, finally wired", () => {
  test("writes status=error with zeroed counters to $GITHUB_OUTPUT", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-fatal-ci-error-"));
    const outputPath = path.join(dir, "github_output");
    try {
      await reportFatalCiError(new Error("boom"), outputPath);
      const written = await Bun.file(outputPath).text();
      expect(written).toContain("status=error\n");
      expect(written).toContain("findings_count=0\n");
      expect(written).toContain("blocking_count=0\n");
      expect(written).toContain("advisory_count=0\n");
      expect(written).not.toContain("cost_usd_est");
      expect(written).toContain("run_dir=\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("emits a ::error:: workflow command carrying the error message", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-fatal-ci-error-"));
    const outputPath = path.join(dir, "github_output");
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      await reportFatalCiError(new Error("authentication failed"), outputPath);
      const logged = chunks.join("");
      expect(logged).toContain("::error::authentication failed");
    } finally {
      process.stderr.write = origWrite;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a non-Error thrown value is stringified rather than crashing the reporter", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-fatal-ci-error-"));
    const outputPath = path.join(dir, "github_output");
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      await reportFatalCiError("a plain string rejection", outputPath);
      expect(chunks.join("")).toContain("::error::a plain string rejection");
    } finally {
      process.stderr.write = origWrite;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does nothing when there is no $GITHUB_OUTPUT path (not a real CI job step)", async () => {
    // Must not throw — this is the branch a genuinely local crash takes.
    await expect(
      reportFatalCiError(new Error("boom"), undefined),
    ).resolves.toBeUndefined();
  });

  test("an unwritable $GITHUB_OUTPUT does not mask the ::error:: annotation", async () => {
    // A path under a nonexistent directory: appendCiOutputs's appendFile
    // rejects. The original fatal error still has to reach the log — a
    // broken output file is not a reason to lose the ::error:: annotation
    // that is the ONLY signal a local dev/CI operator gets otherwise.
    const unwritablePath = path.join(
      tmpdir(),
      "pr-hero-does-not-exist",
      "nested",
      "github_output",
    );
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        reportFatalCiError(new Error("boom"), unwritablePath),
      ).resolves.toBeUndefined();
      expect(chunks.join("")).toContain("::error::boom");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
