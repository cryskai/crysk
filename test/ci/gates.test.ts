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
  type BudgetGateVerdict,
  budgetDisabledWarningMessage,
  budgetUnlimitedNoticeMessage,
  CI_DEFAULT_METERED_BUDGET_USD,
  CI_DEFAULT_METERED_MAX_CHANGED_FILES,
  type CiBudgetGateSkipInput,
  type CiGateSkip,
  type CiSizeGateSkipInput,
  ciBudgetGateSkip,
  ciSizeGateSkip,
  deriveCiBillingMode,
  evaluateBudgetGate,
  resolveCiBudgetCeiling,
  resolveCiSizeLimits,
  sizeGateUnlimitedNoticeMessage,
} from "#ci/gates";
import { renderStepSummary } from "#ci/reporter";
import type { SizeGateVerdict } from "#review/size-gate";

// ---------------------------------------------------------------------------
// evaluateBudgetGate
// ---------------------------------------------------------------------------

describe("evaluateBudgetGate", () => {
  test("allows a cost strictly below the budget, with no reason", () => {
    const verdict: BudgetGateVerdict = evaluateBudgetGate(4.5, 10);
    expect(verdict).toEqual({ allowed: true });
  });

  test("allows a cost exactly equal to the budget (inclusive boundary)", () => {
    const verdict = evaluateBudgetGate(10, 10);
    expect(verdict).toEqual({ allowed: true });
  });

  test("disallows a cost above the budget and states both figures", () => {
    const verdict = evaluateBudgetGate(12.5, 10);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("$12.50");
    expect(verdict.reason).toContain("$10.00");
  });

  // size-gate.ts:20 already settled what a non-positive spend knob means in
  // this repo: "<= 0 disables the limit. Both knobs, independently." The
  // budget ceiling ships beside max-changed-lines / max-changed-files in the
  // same action.yml and feeds the same preflight, so it has to read the same
  // way — a non-positive ceiling is NO ceiling, not a $0 one.
  //
  // The two failure modes are not symmetric, which is what decides it. Read
  // as "no ceiling" when the operator meant "spend nothing", the cost of
  // being wrong is one visible review, still bounded by the size gate that
  // runs independently. Read as "always skip" when the operator meant "no
  // ceiling", pr-hero goes silently dark and every run still exits 0 green —
  // the same shape of failure as a lint gate that checks nothing and passes.
  test("treats a zero budget as no ceiling, matching size-gate's <= 0 convention", () => {
    expect(evaluateBudgetGate(0, 0)).toEqual({ allowed: true });
    expect(evaluateBudgetGate(0.01, 0)).toEqual({ allowed: true });
    expect(evaluateBudgetGate(9999, 0)).toEqual({ allowed: true });
  });

  test("treats a negative budget as no ceiling too", () => {
    expect(evaluateBudgetGate(12.5, -1)).toEqual({ allowed: true });
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

describe("ciBudgetGateSkip", () => {
  test("returns null outside CI mode, even when the cost exceeds the budget", () => {
    expect(
      ciBudgetGateSkip({
        isCi: false,
        estimatedCostUsd: 12.5,
        budgetUsd: 10,
        prNumber: 56,
      }),
    ).toBeNull();
  });

  test("returns null in CI mode when the cost is within budget", () => {
    expect(
      ciBudgetGateSkip({
        isCi: true,
        estimatedCostUsd: 8,
        budgetUsd: 10,
        prNumber: 56,
      }),
    ).toBeNull();
  });

  // The disable convention has to survive the whole path, not just the
  // predicate: a CI run configured with no ceiling must publish nothing at
  // all, rather than a courteous notice explaining it skipped everything.
  test("returns null in CI mode when the budget is disabled with <= 0", () => {
    expect(
      ciBudgetGateSkip({
        isCi: true,
        estimatedCostUsd: 999,
        budgetUsd: 0,
        prNumber: 56,
      }),
    ).toBeNull();
  });

  test("in CI mode with an over-budget estimate, builds a comment and a skipped-budget summary without throwing", () => {
    const input: CiBudgetGateSkipInput = {
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    };
    const skip: CiGateSkip | null = ciBudgetGateSkip(input);
    expect(skip).not.toBeNull();
    expect(skip?.summary).toEqual({
      kind: "skipped-budget",
      prNumber: 56,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
    });
  });

  test("the comment markdown starts with a machine-readable pr-hero marker", () => {
    const skip = ciBudgetGateSkip({
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    });
    expect(skip?.comment.startsWith("<!-- crysk-skip-budget -->")).toBe(true);
  });

  test("the comment states both the estimated cost and the budget ceiling", () => {
    const skip = ciBudgetGateSkip({
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    });
    expect(skip?.comment).toContain("$12.50");
    expect(skip?.comment).toContain("$10.00");
  });

  test("the comment never reads as a reprimand — no quality/blame language", () => {
    const skip = ciBudgetGateSkip({
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    });
    const lowered = skip?.comment.toLowerCase() ?? "";
    expect(lowered).not.toContain("bad");
    expect(lowered).not.toContain("low quality");
    expect(lowered).not.toContain("reject");
  });

  test("the summary payload renders cleanly through ci-reporter's renderStepSummary (shape compatibility)", () => {
    const skip = ciBudgetGateSkip({
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    });
    expect(skip).not.toBeNull();
    if (skip === null) throw new Error("unreachable");
    expect(() => renderStepSummary(skip.summary)).not.toThrow();
    const rendered = renderStepSummary(skip.summary);
    expect(rendered).toContain("PR #56");
    expect(rendered).toContain("$12.50 (budget $10.00)");
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
  // file presence through the optional second argument only.
  test("omitting openCodeAuthPresent is env-only — OpenCode env blobs do not meter", () => {
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

  // Presence of the 0600 auth.json means we cannot rule out an invoice —
  // same conservative doctrine as Anthropic keys. The executable CI path
  // is a deepseek (or any non-openai) API-token store; we do not parse the
  // file here. openai type:api is refused at the broker, not remapped.
  test("openCodeAuthPresent is metered with no Anthropic env — deepseek API-token CI", () => {
    expect(deriveCiBillingMode({}, { openCodeAuthPresent: true })).toBe(
      "metered",
    );
  });

  test("openCodeAuthPresent beside Claude OAuth is still metered", () => {
    expect(
      deriveCiBillingMode(
        { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
        { openCodeAuthPresent: true },
      ),
    ).toBe("metered");
  });

  test("openCodeAuthPresent false is env-only", () => {
    expect(deriveCiBillingMode({}, { openCodeAuthPresent: false })).toBe(
      "subscription",
    );
  });

  test("deepseek-style OpenCode auth gets the default metered ceiling", () => {
    const billingMode = deriveCiBillingMode({}, { openCodeAuthPresent: true });
    expect(
      resolveCiBudgetCeiling({ configured: undefined, billingMode }),
    ).toEqual({
      budgetUsd: CI_DEFAULT_METERED_BUDGET_USD,
      source: "default-metered",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveCiBudgetCeiling — total over four cases, and `source` is what the
// shell branches on so the two non-operator outcomes stay distinguishable.
// ---------------------------------------------------------------------------

describe("resolveCiBudgetCeiling", () => {
  test("an operator value wins on a metered route", () => {
    expect(
      resolveCiBudgetCeiling({ configured: 5, billingMode: "metered" }),
    ).toEqual({ budgetUsd: 5, source: "operator" });
  });

  // How an operator imposes a ceiling on a subscription route: `budget-usd: 5`
  // is honoured verbatim, exactly as it is on a metered one.
  test("an operator value wins on a subscription route too", () => {
    expect(
      resolveCiBudgetCeiling({ configured: 5, billingMode: "subscription" }),
    ).toEqual({ budgetUsd: 5, source: "operator" });
  });

  test("unset on a metered route falls back to the default ceiling", () => {
    expect(
      resolveCiBudgetCeiling({ configured: undefined, billingMode: "metered" }),
    ).toEqual({
      budgetUsd: CI_DEFAULT_METERED_BUDGET_USD,
      source: "default-metered",
    });
  });

  test("unset on a subscription route has no ceiling at all", () => {
    expect(
      resolveCiBudgetCeiling({
        configured: undefined,
        billingMode: "subscription",
      }),
    ).toEqual({ budgetUsd: undefined, source: "unlimited-subscription" });
  });

  // 0 and negatives are how an operator DISABLES the ceiling on a metered
  // route (evaluateBudgetGate's `<= 0` convention). Swallowing them into the
  // default-metered branch would silently reimpose the $10 they just removed.
  test("an explicit 0 takes the operator branch, never the metered default", () => {
    expect(
      resolveCiBudgetCeiling({ configured: 0, billingMode: "metered" }),
    ).toEqual({ budgetUsd: 0, source: "operator" });
  });

  test("an explicit negative takes the operator branch too", () => {
    expect(
      resolveCiBudgetCeiling({ configured: -1, billingMode: "metered" }),
    ).toEqual({ budgetUsd: -1, source: "operator" });
  });
});

// ---------------------------------------------------------------------------
// budgetUnlimitedNoticeMessage — ci/gates.ts:107-115's "a disable is only
// safe when it is loud" applied to the new no-ceiling branch, which produces
// no ceiling and would otherwise be silent.
// ---------------------------------------------------------------------------

describe("budgetUnlimitedNoticeMessage", () => {
  test("only the unlimited-subscription branch speaks", () => {
    expect(
      budgetUnlimitedNoticeMessage({ budgetUsd: 5, source: "operator" }),
    ).toBeNull();
    expect(
      budgetUnlimitedNoticeMessage({
        budgetUsd: CI_DEFAULT_METERED_BUDGET_USD,
        source: "default-metered",
      }),
    ).toBeNull();
    expect(
      budgetUnlimitedNoticeMessage({
        budgetUsd: undefined,
        source: "unlimited-subscription",
      }),
    ).not.toBeNull();
  });

  test("states the reason, the surviving size gate, and how to impose a ceiling", () => {
    const message = budgetUnlimitedNoticeMessage({
      budgetUsd: undefined,
      source: "unlimited-subscription",
    });
    expect(message).not.toBeNull();
    if (message === null) throw new Error("unreachable");
    expect(message).toBe(
      "no budget-usd ceiling was applied: this route has no per-token invoice " +
        "credential (a Claude subscription or a free route), so a run draws on " +
        "quota rather than a per-token invoice and the estimated cost is not a " +
        "dollar figure to gate on. The size gate resolves from the route separately. " +
        "Set `budget-usd: <n>` to impose a ceiling anyway.",
    );
  });

  // W3-FOOTER: the notice runs on a free OpenCode route too, so it must not
  // name the Claude subscription as the only cause.
  test("names no single provider: a free route is covered by the same notice", () => {
    const message = budgetUnlimitedNoticeMessage({
      budgetUsd: undefined,
      source: "unlimited-subscription",
    });
    expect(message).toContain("a free route");
    expect(message).not.toContain("authenticates against");
  });

  // Two different facts: "you disabled the ceiling you configured" and "no
  // ceiling was resolved because the route draws on a subscription". Merging
  // them would tell an operator who configured nothing that they disabled
  // something.
  test("is distinct from budgetDisabledWarningMessage", () => {
    const notice = budgetUnlimitedNoticeMessage({
      budgetUsd: undefined,
      source: "unlimited-subscription",
    });
    expect(notice).not.toBe(budgetDisabledWarningMessage(0));
    expect(notice?.toLowerCase()).not.toContain("disabled");
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
