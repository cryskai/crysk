// Phase 2 (Pillar 3, GitHub Actions CI): bounded unattended spend. Pure
// budget-gate evaluation plus the CI-mode skip payload builders that turn an
// already-computed size-gate verdict or budget comparison into the two
// things a CI run needs to publish — a PR comment and a step-summary
// payload — without spawning agents or touching the filesystem/network.
//
// Mirrors ci/reporter.test.ts's style: no mocks, no I/O, plain literals for
// the upstream types (SizeGateVerdict from size-gate.ts, CiSummaryData from
// ci/reporter.ts).

import { describe, expect, test } from "bun:test";
import {
  CI_DEFAULT_METERED_MAX_CHANGED_FILES,
  type CiGateSkip,
  type CiSizeGateSkipInput,
  ciLimitsGateSkip,
  ciSizeGateSkip,
  deriveCiBillingMode,
  evaluatePlatformLimits,
  planCiExcludedSkip,
  planCiLimitsSkip,
  resolveCiSizeLimits,
  SKIP_BUDGET_COMMENT_MARKER,
  sizeGateUnlimitedNoticeMessage,
} from "#ci/gates";
import { renderStepSummary } from "#ci/reporter";
import {
  openCodeProvidersOfModels,
  openCodeRoutesBillMetered,
} from "#ci/setup";
import type { SizeGateVerdict } from "#review/size-gate";

// cryskai/platform#12 item 5: the OpenCode half of the metered ceiling reads
// the routes the models name, not merely whether an auth file exists.
describe("openCodeRoutesBillMetered", () => {
  const deepseek = ["CRYSK_OPENCODE_DEEPSEEK_API_KEY"];
  const metered = (models: unknown, names: readonly string[] | undefined) =>
    openCodeRoutesBillMetered({
      providers: openCodeProvidersOfModels(models),
      authFilePresent: true,
      openCodeSecretNames: names,
    });

  test("an auth file whose providers no model uses does not make a Claude-only run metered", () => {
    expect(metered(undefined, deepseek)).toBe(false);
    expect(metered({ default: ["claude:sonnet-latest"] }, deepseek)).toBe(
      false,
    );
  });

  test("a model on a provider bound to an API key is metered, fallbacks included", () => {
    expect(
      metered(
        {
          refuter: [
            "claude:opus-latest",
            "opencode:deepseek/deepseek-v4-flash",
          ],
        },
        deepseek,
      ),
    ).toBe(true);
  });

  test("a ChatGPT subscription route is not metered", () => {
    expect(
      metered({ default: ["opencode:openai/gpt-5.5"] }, [
        "CRYSK_OPENCODE_OPENAI_OAUTH",
      ]),
    ).toBe(false);
  });

  test("without a manifest the provider literal decides, as the run binds it", () => {
    expect(
      metered({ default: ["opencode:deepseek/deepseek-v4-flash"] }, undefined),
    ).toBe(true);
    expect(metered({ default: ["opencode:openai/gpt-5.5"] }, undefined)).toBe(
      false,
    );
  });

  test("routes that could not be resolved leave the decision to the auth file", () => {
    expect(
      openCodeRoutesBillMetered({
        providers: undefined,
        authFilePresent: true,
        openCodeSecretNames: deepseek,
      }),
    ).toBe(true);
  });

  test("no auth file stays unmetered, as before: a free opencode/* model invoices nothing", () => {
    expect(
      openCodeRoutesBillMetered({
        providers: ["opencode"],
        authFilePresent: false,
        openCodeSecretNames: undefined,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluatePlatformLimits — platform-owned-cost L55. The engine keeps ONE
// comparison: a run that bills an API key is skipped when the month's limit is
// used up, or when the platform's estimate is over the per-review limit or over
// what is left of the month. Every other input is a pass.
// ---------------------------------------------------------------------------

describe("evaluatePlatformLimits", () => {
  const metered = "metered" as const;

  test("the month's limit used up skips, with or without an estimate", () => {
    expect(
      evaluatePlatformLimits({
        billingMode: metered,
        limits: { reviewUsd: 12, monthLeftUsd: 0 },
      }),
    ).toEqual({ allowed: false, hit: "month-used-up" });
    expect(
      evaluatePlatformLimits({
        billingMode: metered,
        limits: { monthLeftUsd: 0, estimateUsd: 0 },
      }),
    ).toEqual({ allowed: false, hit: "month-used-up" });
  });

  test("an estimate over the per-review limit skips", () => {
    expect(
      evaluatePlatformLimits({
        billingMode: metered,
        limits: { reviewUsd: 12, estimateUsd: 12.5 },
      }),
    ).toEqual({ allowed: false, hit: "review-limit" });
  });

  test("an estimate over what is left of the month skips", () => {
    expect(
      evaluatePlatformLimits({
        billingMode: metered,
        limits: { reviewUsd: 12, monthLeftUsd: 3, estimateUsd: 3.5 },
      }),
    ).toEqual({ allowed: false, hit: "month-left" });
  });

  test("an estimate exactly at a limit passes (inclusive boundary)", () => {
    expect(
      evaluatePlatformLimits({
        billingMode: metered,
        limits: { reviewUsd: 12, monthLeftUsd: 12, estimateUsd: 12 },
      }),
    ).toEqual({ allowed: true });
  });

  test("an estimate within both limits passes", () => {
    expect(
      evaluatePlatformLimits({
        billingMode: metered,
        limits: { reviewUsd: 12, monthLeftUsd: 40, estimateUsd: 4.5 },
      }),
    ).toEqual({ allowed: true });
  });

  // The stated limit of the design: a model the platform cannot price is not
  // capped per review.
  test("no estimate and a month with money left runs the review", () => {
    expect(
      evaluatePlatformLimits({
        billingMode: metered,
        limits: { reviewUsd: 12, monthLeftUsd: 5 },
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluatePlatformLimits({
        billingMode: metered,
        limits: { reviewUsd: 12 },
      }),
    ).toEqual({ allowed: true });
  });

  test("with both limits over, the per-review limit is the one named", () => {
    expect(
      evaluatePlatformLimits({
        billingMode: metered,
        limits: { reviewUsd: 5, monthLeftUsd: 3, estimateUsd: 9 },
      }),
    ).toEqual({ allowed: false, hit: "review-limit" });
  });

  test("a subscription (or free) run is never skipped, whatever the limits say", () => {
    expect(
      evaluatePlatformLimits({
        billingMode: "subscription",
        limits: { reviewUsd: 1, monthLeftUsd: 0, estimateUsd: 999 },
      }),
    ).toEqual({ allowed: true });
  });

  // The platform omits `limits` when the dispatch was forced (`/crysk review`,
  // `recheck`), and a standalone or older-platform run never had any.
  test("without limits (a forced run, a standalone run) nothing is skipped", () => {
    expect(
      evaluatePlatformLimits({ billingMode: metered, limits: undefined }),
    ).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// ciSizeGateSkip
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

const failedFilesGate: SizeGateVerdict = {
  ok: false,
  reason: "files",
  effectiveLines: 300,
  effectiveFiles: 90,
  excludedFiles: 0,
  excludedLines: 0,
  limit: 50,
  message: "90 effective changed files exceeds the 50-file limit",
};

const passingGate: SizeGateVerdict = {
  ok: true,
  effectiveLines: 40,
  effectiveFiles: 3,
  excludedFiles: 0,
  excludedLines: 0,
};

describe("ciSizeGateSkip", () => {
  test("returns null outside CI mode, even when the gate failed", () => {
    expect(
      ciSizeGateSkip({
        isCi: false,
        verdict: failedLinesGate,
        prNumber: 55,
        maxChangedLines: 1000,
        maxChangedFiles: 50,
      }),
    ).toBeNull();
  });

  test("returns null in CI mode when the gate passed", () => {
    expect(
      ciSizeGateSkip({
        isCi: true,
        verdict: passingGate,
        prNumber: 55,
        maxChangedLines: 1000,
        maxChangedFiles: 50,
      }),
    ).toBeNull();
  });

  test("in CI mode with a failed (lines) verdict, builds a comment and a skipped-size summary without throwing", () => {
    const input: CiSizeGateSkipInput = {
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    };
    const skip: CiGateSkip | null = ciSizeGateSkip(input);
    expect(skip).not.toBeNull();
    expect(skip?.summary).toEqual({
      kind: "skipped-size",
      prNumber: 55,
      changedLines: 1200,
      changedFiles: 60,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
  });

  test("on a platform repository the step summary points at the dashboard, like the comment", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
      platformConnected: true,
    });
    if (skip === null) throw new Error("expected a skip");
    const rendered = renderStepSummary(skip.summary);
    expect(rendered).toContain("raise the size limits in the Crysk dashboard");
    expect(rendered).not.toContain("max-changed-lines");
    expect(skip.comment).not.toContain("max-changed-lines");
  });

  test("in CI mode with a failed (files) verdict, still builds a valid payload", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedFilesGate,
      prNumber: 12,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(skip?.summary).toEqual({
      kind: "skipped-size",
      prNumber: 12,
      changedLines: 300,
      changedFiles: 90,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
  });

  test("the comment markdown starts with a machine-readable pr-hero marker", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(skip?.comment.startsWith("<!-- crysk-skip-size -->")).toBe(true);
  });

  test("the comment reports the changed lines/files against their limits", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(skip?.comment).toContain("1200");
    expect(skip?.comment).toContain("60");
    expect(skip?.comment).toContain("1000");
    expect(skip?.comment).toContain("50");
  });

  test("the comment never reads as a reprimand — no quality/blame language", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    const lowered = skip?.comment.toLowerCase() ?? "";
    expect(lowered).not.toContain("bad");
    expect(lowered).not.toContain("low quality");
    expect(lowered).not.toContain("reject");
  });

  test("a knob that is off is named as off in the comment, never as 0", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 0,
    });
    expect(skip?.comment).toContain("(max 1000 lines / no file limit)");
    expect(skip?.comment).not.toContain("0 files");
  });

  test("both knobs on keep the original wording", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(skip?.comment).toContain("(max 1000 lines / 50 files)");
  });

  test("the summary payload renders cleanly through ci-reporter's renderStepSummary (shape compatibility)", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(skip).not.toBeNull();
    if (skip === null) throw new Error("unreachable");
    expect(() => renderStepSummary(skip.summary)).not.toThrow();
    const rendered = renderStepSummary(skip.summary);
    expect(rendered).toContain("PR #55");
    expect(rendered).toContain("1200 (limit 1000)");
  });
});

// ---------------------------------------------------------------------------
// ciBudgetGateSkip
// ---------------------------------------------------------------------------

describe("ciLimitsGateSkip", () => {
  const over = {
    isCi: true,
    billingMode: "metered" as const,
    limits: { reviewUsd: 12, estimateUsd: 12.5 },
    prNumber: 56,
  };

  test("returns null outside CI mode, even when a limit was hit", () => {
    expect(ciLimitsGateSkip({ ...over, isCi: false })).toBeNull();
  });

  test("returns null in CI mode when the review is within the limits", () => {
    expect(
      ciLimitsGateSkip({ ...over, limits: { reviewUsd: 12, estimateUsd: 8 } }),
    ).toBeNull();
  });

  test("returns null on a subscription route, even over the limits", () => {
    expect(
      ciLimitsGateSkip({ ...over, billingMode: "subscription" }),
    ).toBeNull();
  });

  test("in CI mode over a limit, builds a comment and a skipped-budget summary naming the limit", () => {
    const skip: CiGateSkip | null = ciLimitsGateSkip(over);
    expect(skip).not.toBeNull();
    expect(skip?.summary).toEqual({
      kind: "skipped-budget",
      prNumber: 56,
      limit: "review-limit",
    });
  });

  test("the comment markdown starts with the machine-readable skip-budget marker", () => {
    const skip = ciLimitsGateSkip(over);
    expect(skip?.comment.startsWith(`${SKIP_BUDGET_COMMENT_MARKER}\n`)).toBe(
      true,
    );
    expect(SKIP_BUDGET_COMMENT_MARKER).toBe("<!-- crysk-skip-budget -->");
  });

  test("the comment names the limit that was hit and the dashboard setting, with no dollar figure", () => {
    const perReview = ciLimitsGateSkip(over)?.comment ?? "";
    expect(perReview).toContain("per-review limit");
    expect(perReview).toContain("Review > Limits");
    expect(perReview).not.toContain("$");
    const used = ciLimitsGateSkip({
      ...over,
      limits: { monthLeftUsd: 0 },
    })?.comment;
    expect(used).toContain("monthly review limit");
    expect(used).toContain("used up");
    expect(used).toContain("Review > Limits");
    const left = ciLimitsGateSkip({
      ...over,
      limits: { monthLeftUsd: 3, estimateUsd: 4 },
    })?.comment;
    expect(left).toContain("monthly limit");
    expect(left).toContain("left");
  });

  test("the comment keeps the /crysk review force hint of a platform repository", () => {
    expect(ciLimitsGateSkip(over)?.comment).toContain("/crysk review");
  });

  test("the comment never reads as a reprimand — no quality/blame language", () => {
    const lowered = ciLimitsGateSkip(over)?.comment.toLowerCase() ?? "";
    expect(lowered).not.toContain("bad");
    expect(lowered).not.toContain("low quality");
    expect(lowered).not.toContain("reject");
  });

  test("the summary payload renders cleanly through ci-reporter's renderStepSummary (shape compatibility)", () => {
    const skip = ciLimitsGateSkip(over);
    expect(skip).not.toBeNull();
    if (skip === null) throw new Error("unreachable");
    const rendered = renderStepSummary(skip.summary);
    expect(rendered).toContain("PR #56");
    expect(rendered).toContain("per-review limit");
    expect(rendered).not.toContain("$");
  });
});

describe("planCiLimitsSkip", () => {
  const over = {
    isCi: true,
    billingMode: "metered" as const,
    limits: { reviewUsd: 12, estimateUsd: 12.5 },
    prNumber: 56,
    ciMode: "gate" as const,
  };

  test("is today's skipped-budget plan: same marker, status and zero counts, no cost output", () => {
    const plan = planCiLimitsSkip({ ...over, force: false });
    expect(plan?.markerPrefix).toBe(SKIP_BUDGET_COMMENT_MARKER);
    expect(plan?.outputs).toEqual({
      status: "skipped-budget",
      findings_count: 0,
      blocking_count: 0,
      advisory_count: 0,
      run_dir: "",
    });
    expect(plan?.summaryMarkdown).toContain("PR #56");
  });

  // `/crysk review` (CI `--force`) answers "run this one anyway". The platform
  // also omits the limits for it, so this is the second line of defence.
  test("a forced run is never skipped, even when limits are present", () => {
    expect(planCiLimitsSkip({ ...over, force: true })).toBeNull();
  });

  test("a run within the limits has no plan", () => {
    expect(
      planCiLimitsSkip({
        ...over,
        limits: { reviewUsd: 12, estimateUsd: 1 },
        force: false,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveCiBillingMode — issue #156. The CI budget gate compared a
// token-derived estimate against a real-dollar ceiling on a route where the
// real dollar figure is $0.00, so it refused work for an imaginary overrun.
// This is the pure half of the fix: which route is actually metered.
// ---------------------------------------------------------------------------

describe("deriveCiBillingMode", () => {
  test("a non-empty ANTHROPIC_API_KEY is metered", () => {
    expect(deriveCiBillingMode({ ANTHROPIC_API_KEY: "sk-test" })).toBe(
      "metered",
    );
  });

  // action.yml:111 binds `ANTHROPIC_API_KEY: ${{ inputs.anthropic-api-key }}`
  // UNCONDITIONALLY, and GitHub renders an unset input as the empty string —
  // so every subscription-route CI run carries `ANTHROPIC_API_KEY=""` in the
  // child env. Trimming is what keeps that from reading as an invoice.
  test("an empty ANTHROPIC_API_KEY is subscription — action.yml always binds the variable", () => {
    expect(deriveCiBillingMode({ ANTHROPIC_API_KEY: "" })).toBe("subscription");
  });

  test("a whitespace-only ANTHROPIC_API_KEY is subscription", () => {
    expect(deriveCiBillingMode({ ANTHROPIC_API_KEY: "   " })).toBe(
      "subscription",
    );
  });

  // 2026-09-02, #177. The rule this function states is "the mere PRESENCE of a
  // key keeps the ceiling: we cannot rule out that it bills" — and
  // ANTHROPIC_AUTH_TOKEN is a key by that rule. `ENV_PASSTHROUGH`
  // (harness.ts) projects it into the child immediately beside
  // ANTHROPIC_API_KEY as the same credential class, so a route carrying it
  // spends per token exactly as a route carrying the API key does. Its
  // omission was never a decision — the doctrine above never mentions it.
  //
  // Nil-delta for the shipped action: action.yml binds only
  // `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, so no generated
  // workflow can newly acquire a ceiling from this arm.
  test("a non-empty ANTHROPIC_AUTH_TOKEN is metered — same credential class", () => {
    expect(deriveCiBillingMode({ ANTHROPIC_AUTH_TOKEN: "bearer-test" })).toBe(
      "metered",
    );
  });

  // Whitespace-only, not empty — the two are different cases and only this one
  // needs the trim (`""` is already falsy). Naming it "empty" would be the
  // same class of overstatement #177 corrected in this function's own comment.
  test("a whitespace-only ANTHROPIC_AUTH_TOKEN is subscription", () => {
    expect(deriveCiBillingMode({ ANTHROPIC_AUTH_TOKEN: "  " })).toBe(
      "subscription",
    );
  });

  test("an empty ANTHROPIC_AUTH_TOKEN is subscription", () => {
    expect(deriveCiBillingMode({ ANTHROPIC_AUTH_TOKEN: "" })).toBe(
      "subscription",
    );
  });

  test("an OAuth token alone is subscription", () => {
    expect(
      deriveCiBillingMode({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" }),
    ).toBe("subscription");
  });

  // The conservative direction, asserted explicitly so nobody "fixes" it into
  // a precedence claim. This repo does NOT know which credential the Claude
  // CLI bills when both are present: action.yml:111-112 binds both,
  // test/harness/env-projection.test.ts:48-56 asserts both survive the
  // projection with no precedence, and defaultClaudeAuthProbe
  // (src/model/provider-capabilities.ts:402-405) ORs them into one boolean. This
  // rule does not need that answer — a wrong "unlimited" produces a real
  // invoice, a wrong ceiling produces a skipped review the operator clears
  // with one line of YAML.
  test("BOTH credentials set is metered — we cannot rule out that the key bills", () => {
    expect(
      deriveCiBillingMode({
        ANTHROPIC_API_KEY: "sk-test",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      }),
    ).toBe("metered");
  });

  test("an empty env is subscription", () => {
    expect(deriveCiBillingMode({})).toBe("subscription");
  });

  // omit ⇒ env-only. OpenCode env blobs must not become a second Anthropic
  // key: envBillsMetered stays the Claude usage-stamp, and this ceiling ORs
  // the OpenCode routes' verdict through the optional second argument only.
  test("omitting openCodeBillsMetered is env-only — OpenCode env blobs do not meter", () => {
    expect(
      deriveCiBillingMode({
        OPENCODE_AUTH_JSON: '{"deepseek":{"type":"api","key":"sk-test-fake"}}',
      }),
    ).toBe("subscription");
    expect(
      deriveCiBillingMode(
        {
          OPENCODE_AUTH_JSON:
            '{"deepseek":{"type":"api","key":"sk-test-fake"}}',
        },
        {},
      ),
    ).toBe("subscription");
  });

  // An OpenCode route bound to an API key can invoice — same conservative
  // doctrine as Anthropic keys. Which routes do is openCodeRoutesBillMetered's
  // call (ci/setup.ts); this function only ORs its verdict in.
  test("openCodeBillsMetered is metered with no Anthropic env — deepseek API-token CI", () => {
    expect(deriveCiBillingMode({}, { openCodeBillsMetered: true })).toBe(
      "metered",
    );
  });

  test("openCodeBillsMetered beside Claude OAuth is still metered", () => {
    expect(
      deriveCiBillingMode(
        { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
        { openCodeBillsMetered: true },
      ),
    ).toBe("metered");
  });

  test("openCodeBillsMetered false is env-only", () => {
    expect(deriveCiBillingMode({}, { openCodeBillsMetered: false })).toBe(
      "subscription",
    );
  });

  test("an OpenCode API-key route is metered for the limits gate", () => {
    const billingMode = deriveCiBillingMode({}, { openCodeBillsMetered: true });
    expect(
      evaluatePlatformLimits({
        billingMode,
        limits: { reviewUsd: 12, estimateUsd: 13 },
      }).allowed,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveCiSizeLimits — the size gate's route-aware half of the #156 policy.
// ---------------------------------------------------------------------------

describe("resolveCiSizeLimits", () => {
  test("subscription, nothing configured: both limits off and announced", () => {
    expect(
      resolveCiSizeLimits({
        flags: {},
        config: undefined,
        billingMode: "subscription",
      }),
    ).toEqual({
      maxChangedLines: 0,
      maxChangedFiles: 0,
      defaultedOff: ["lines", "files"],
    });
  });

  test("metered, nothing configured: the action's former limits", () => {
    expect(
      resolveCiSizeLimits({
        flags: {},
        config: undefined,
        billingMode: "metered",
      }),
    ).toEqual({
      maxChangedLines: undefined,
      maxChangedFiles: 50,
      defaultedOff: [],
    });
    expect(CI_DEFAULT_METERED_MAX_CHANGED_FILES).toBe(50);
  });

  test("an explicit flag wins on a subscription", () => {
    expect(
      resolveCiSizeLimits({
        flags: { maxChangedLines: 2500, maxChangedFiles: 40 },
        config: undefined,
        billingMode: "subscription",
      }),
    ).toEqual({
      maxChangedLines: 2500,
      maxChangedFiles: 40,
      defaultedOff: [],
    });
  });

  test("an explicit 0 flag stays 0 on a metered route", () => {
    expect(
      resolveCiSizeLimits({
        flags: { maxChangedLines: 0, maxChangedFiles: 0 },
        config: undefined,
        billingMode: "metered",
      }),
    ).toEqual({
      maxChangedLines: 0,
      maxChangedFiles: 0,
      defaultedOff: [],
    });
  });

  test("a repo-config value is left for sizeGateConfig on a subscription", () => {
    expect(
      resolveCiSizeLimits({
        flags: {},
        config: { max_changed_lines: 3000 },
        billingMode: "subscription",
      }),
    ).toEqual({
      maxChangedLines: undefined,
      maxChangedFiles: 0,
      defaultedOff: ["files"],
    });
  });

  test("a repo-config value is left for sizeGateConfig on a metered route", () => {
    expect(
      resolveCiSizeLimits({
        flags: {},
        config: { max_changed_files: 10 },
        billingMode: "metered",
      }),
    ).toEqual({
      maxChangedLines: undefined,
      maxChangedFiles: undefined,
      defaultedOff: [],
    });
  });
});

// ---------------------------------------------------------------------------
// sizeGateUnlimitedNoticeMessage — a NOTE for the knobs this policy turned off.
// ---------------------------------------------------------------------------

describe("sizeGateUnlimitedNoticeMessage", () => {
  test("returns null when nothing was defaulted off", () => {
    expect(
      sizeGateUnlimitedNoticeMessage({
        maxChangedLines: 2500,
        maxChangedFiles: 40,
        defaultedOff: [],
      }),
    ).toBeNull();
  });

  test("names both knobs when both were defaulted off", () => {
    const message = sizeGateUnlimitedNoticeMessage({
      maxChangedLines: 0,
      maxChangedFiles: 0,
      defaultedOff: ["lines", "files"],
    });
    expect(message).toContain("no changed-lines or changed-files limit");
    expect(message).toContain("max-changed-lines");
  });

  test("names only the knob that was defaulted off", () => {
    const message = sizeGateUnlimitedNoticeMessage({
      maxChangedLines: undefined,
      maxChangedFiles: 0,
      defaultedOff: ["files"],
    });
    expect(message).toContain("no changed-files limit");
    expect(message).not.toContain("changed-lines or");
  });
});

// #317: a PR whose every changed file is excluded has nothing to review. The
// plan is a finished no-op: no comment, zero counts, and a summary that names
// what was excluded and says nothing was spent.
describe("planCiExcludedSkip", () => {
  test("builds status=skipped-excluded outputs with zero counts and no comment", () => {
    const plan = planCiExcludedSkip({
      prNumber: 7,
      excludedPaths: ["package-lock.json", "ROADMAP.md"],
      ciMode: "gate",
    });
    expect(plan.postsComment).toBe(false);
    expect(plan.outputs).toEqual({
      status: "skipped-excluded",
      findings_count: 0,
      blocking_count: 0,
      advisory_count: 0,
      run_dir: "",
    });
  });

  test("the step summary names the excluded paths and says nothing was spent", () => {
    const plan = planCiExcludedSkip({
      prNumber: 7,
      excludedPaths: ["package-lock.json", "ROADMAP.md"],
      ciMode: "advisory",
    });
    expect(plan.summaryMarkdown).toContain("PR #7");
    expect(plan.summaryMarkdown).toContain("package-lock.json");
    expect(plan.summaryMarkdown).toContain("ROADMAP.md");
    expect(plan.summaryMarkdown).toContain(
      "Nothing was spawned and nothing was spent",
    );
    expect(plan.summaryMarkdown).not.toContain("found nothing");
    expect(plan.summaryMarkdown).not.toContain("\x1b");
  });

  test("the summary lists at most five paths and counts the rest, like every other path list", () => {
    const excludedPaths = Array.from(
      { length: 8 },
      (_, i) => `gen/file-${i}.lock`,
    );
    const plan = planCiExcludedSkip({
      prNumber: 7,
      excludedPaths,
      ciMode: "gate",
    });
    expect(plan.summaryMarkdown).toContain("gen/file-4.lock");
    expect(plan.summaryMarkdown).not.toContain("gen/file-5.lock");
    expect(plan.summaryMarkdown).toContain("+3 more");
  });

  test("a backtick in an author's path cannot break out of its code span", () => {
    const plan = planCiExcludedSkip({
      prNumber: 7,
      excludedPaths: ["weird`name.lock"],
      ciMode: "gate",
    });
    expect(plan.summaryMarkdown).toContain("`weird'name.lock`");
    expect(plan.summaryMarkdown).not.toContain("weird`name");
  });
});
