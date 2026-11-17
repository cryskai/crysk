import { describe, expect, test } from "bun:test";
import {
  applyUsageUpdate,
  envBillsMetered,
  normalizeInclusiveUsage,
  normalizePartialUsage,
  projectLegacyUsage,
  sumNormalizedUsage,
  UsageModeMismatchError,
} from "../../src/execution/usage-normalized";

describe("normalizeInclusiveUsage — proven inclusion split (§8 line 455)", () => {
  test("splits a proven-inclusive total into disjoint cache leaves plus a non-negative residual", () => {
    const result = normalizeInclusiveUsage({
      wallMs: 4200,
      inputTotal: 100,
      inputCacheRead: 30,
      inputCacheWrite: 10,
      outputTotal: 50,
      outputReasoning: 20,
      billingMode: "metered",
    });

    expect(result.tokens.inputCacheRead).toBe(30);
    expect(result.tokens.inputCacheWrite).toBe(10);
    expect(result.tokens.inputOther).toBe(60);
    expect(result.tokens.outputReasoning).toBe(20);
    expect(result.tokens.outputOther).toBe(30);
    expect(result.completeness).toBe("complete");
  });

  test("triangulation: a different provider's shape (cache-read only, no cache-write) still splits correctly", () => {
    const result = normalizeInclusiveUsage({
      wallMs: 0,
      inputTotal: 1000,
      inputCacheRead: 400,
      outputTotal: 200,
      billingMode: "metered",
    });

    expect(result.tokens.inputCacheRead).toBe(400);
    expect(result.tokens.inputCacheWrite).toBeUndefined();
    expect(result.tokens.inputOther).toBe(600);
    expect(result.tokens.outputReasoning).toBeUndefined();
    expect(result.tokens.outputOther).toBe(200);
  });

  test("never adds the cache detail atop the inclusive total", () => {
    const result = normalizeInclusiveUsage({
      wallMs: 0,
      inputTotal: 100,
      inputCacheRead: 40,
      outputTotal: 0,
      billingMode: "metered",
    });

    const leafSum =
      (result.tokens.inputCacheRead ?? 0) + (result.tokens.inputOther ?? 0);
    expect(leafSum).toBe(100);
    expect(leafSum).not.toBe(140);
  });

  test("clamps the residual to non-negative even when reported detail exceeds the total", () => {
    const result = normalizeInclusiveUsage({
      wallMs: 0,
      inputTotal: 10,
      inputCacheRead: 15,
      outputTotal: 0,
      billingMode: "metered",
    });

    expect(result.tokens.inputOther).toBe(0);
  });
});

describe("normalizePartialUsage — unproven inclusion (§8 line 457)", () => {
  test("keeps providerReportedTotal and marks completeness partial with no invented split", () => {
    const result = normalizePartialUsage({
      wallMs: 500,
      providerReportedTotal: 1234,
      billingMode: "metered",
    });

    expect(result.completeness).toBe("partial");
    expect(result.tokens.providerReportedTotal).toBe(1234);
    expect(result.tokens.inputOther).toBeUndefined();
    expect(result.tokens.outputOther).toBeUndefined();
    expect(result.tokens.inputKnown).toBeUndefined();
    expect(result.tokens.outputKnown).toBeUndefined();
  });

  test("triangulation: a different total still comes through untouched, never split", () => {
    const result = normalizePartialUsage({
      wallMs: 0,
      providerReportedTotal: 42,
      billingMode: "subscription",
    });

    expect(result.tokens.providerReportedTotal).toBe(42);
    expect(result.completeness).toBe("partial");
  });
});

// 2026-09-02, #177. THE one predicate that reads "does this environment carry
// a per-token credential?", and it has exactly two callers by design:
// `deriveCiBillingMode` (ci/gates.ts), which turns it into a CI spend ceiling,
// and the Claude CLI transport, which turns it into the billing mode STAMPED
// ON EVERY USAGE RECORD. Two copies would be two chances for the ceiling and
// the records to disagree about whether one run bills — and #177 is exactly
// that disagreement, found live: ci-gates already called an API-key route
// metered while the transport filed its spend as "not charged".
describe("envBillsMetered — the shared metered-credential signal (#177)", () => {
  test("a non-empty ANTHROPIC_API_KEY bills metered", () => {
    expect(envBillsMetered({ ANTHROPIC_API_KEY: "sk-test" })).toBe(true);
  });

  // The variable `ENV_PASSTHROUGH` (harness.ts) projects into the child
  // immediately beside ANTHROPIC_API_KEY, in the same credential class: a
  // bearer token for a gateway that bills per token. Omitting it was the
  // narrower half of #177 — the same real spend, one variable over.
  test("a non-empty ANTHROPIC_AUTH_TOKEN bills metered", () => {
    expect(envBillsMetered({ ANTHROPIC_AUTH_TOKEN: "bearer-test" })).toBe(true);
  });

  // action.yml:111 binds ANTHROPIC_API_KEY UNCONDITIONALLY and GitHub renders
  // an unset input as the empty string, so every subscription-route CI run
  // carries `ANTHROPIC_API_KEY=""`. Trimming is load-bearing, not defensive.
  test("an empty or whitespace-only value is not a metered signal", () => {
    expect(envBillsMetered({ ANTHROPIC_API_KEY: "" })).toBe(false);
    expect(envBillsMetered({ ANTHROPIC_API_KEY: "   " })).toBe(false);
    expect(envBillsMetered({ ANTHROPIC_AUTH_TOKEN: "" })).toBe(false);
    expect(envBillsMetered({ ANTHROPIC_AUTH_TOKEN: "\t " })).toBe(false);
  });

  test("an OAuth token alone is not a metered signal — that is the subscription", () => {
    expect(
      envBillsMetered({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" }),
    ).toBe(false);
  });

  // The conservative direction. This repo does NOT know which credential the
  // Claude CLI bills when both are present (ci/gates.ts states the gap at
  // length), and it does not need to: guess "subscription" wrongly and real
  // money is reported as not charged, which is the under-reporting failure
  // #177 exists to close.
  test("an OAuth token beside an API key still bills metered", () => {
    expect(
      envBillsMetered({
        ANTHROPIC_API_KEY: "sk-test",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      }),
    ).toBe(true);
  });

  test("an empty env is not a metered signal", () => {
    expect(envBillsMetered({})).toBe(false);
  });

  // #136 / opencode-ci: mixed `claude-code` subscription + OpenCode API-token
  // must not stamp Claude usage via this function. The CI ceiling ORs file
  // presence beside deriveCiBillingMode; this predicate stays Anthropic-env-only.
  test("OpenCode credentials are not an envBillsMetered signal — Claude stamp stays Anthropic-env-only", () => {
    expect(
      envBillsMetered({
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
        OPENCODE_AUTH_JSON: '{"deepseek":{"type":"api","key":"sk-test-fake"}}',
      }),
    ).toBe(false);
    expect(
      envBillsMetered({
        DEEPSEEK_API_KEY: "sk-test-fake",
      }),
    ).toBe(false);
  });
});

describe("usage records carry no money field", () => {
  test("builders, sums and the legacy projection emit tokens, completeness and credential class only", () => {
    const a = normalizeInclusiveUsage({
      wallMs: 100,
      inputTotal: 10,
      outputTotal: 10,
      billingMode: "subscription",
    });
    const b = normalizePartialUsage({
      wallMs: 100,
      providerReportedTotal: 5,
      billingMode: "subscription",
    });
    const total = sumNormalizedUsage(a, b);
    const costKeys = (value: object) =>
      Object.keys(value).filter((key) => /cost/i.test(key));

    expect(costKeys(a)).toEqual([]);
    expect(costKeys(b)).toEqual([]);
    expect(costKeys(total)).toEqual([]);
    expect(costKeys(projectLegacyUsage(total))).toEqual([]);
    expect(total.billingMode).toBe("subscription");
  });
});

describe("sumNormalizedUsage — accumulation across attempts", () => {
  test("keeps billingMode when both attempts agree", () => {
    const a = normalizeInclusiveUsage({
      wallMs: 1,
      inputTotal: 1,
      outputTotal: 1,
      billingMode: "metered",
    });
    const b = normalizeInclusiveUsage({
      wallMs: 1,
      inputTotal: 1,
      outputTotal: 1,
      billingMode: "metered",
    });

    const total = sumNormalizedUsage(a, b);
    expect(total.billingMode).toBe("metered");
  });

  test("falls back to unknown when attempts disagree rather than guessing", () => {
    const a = normalizeInclusiveUsage({
      wallMs: 1,
      inputTotal: 1,
      outputTotal: 1,
      billingMode: "metered",
    });
    const b = normalizeInclusiveUsage({
      wallMs: 1,
      inputTotal: 1,
      outputTotal: 1,
      billingMode: "subscription",
    });

    const total = sumNormalizedUsage(a, b);
    expect(total.billingMode).toBe("unknown");
  });

  test("completeness degrades to the worst of the two attempts", () => {
    const complete = normalizeInclusiveUsage({
      wallMs: 1,
      inputTotal: 1,
      outputTotal: 1,
      billingMode: "metered",
    });
    const partial = normalizePartialUsage({
      wallMs: 1,
      providerReportedTotal: 5,
      billingMode: "metered",
    });

    const total = sumNormalizedUsage(complete, partial);
    expect(total.completeness).toBe("partial");
  });

  test("merging complete and partial usage sums totalKnown via providerReportedTotal fallback per attempt", () => {
    const complete = normalizeInclusiveUsage({
      wallMs: 100,
      inputTotal: 100,
      outputTotal: 80,
      billingMode: "metered",
    });
    const partial = normalizePartialUsage({
      wallMs: 50,
      providerReportedTotal: 500,
      billingMode: "metered",
    });

    const total = sumNormalizedUsage(complete, partial);
    expect(total.tokens.totalKnown).toBe(680);
    expect(projectLegacyUsage(total).tokens_total).toBe(680);
  });

  test("token leaves and wall time sum across attempts", () => {
    const a = normalizeInclusiveUsage({
      wallMs: 100,
      inputTotal: 10,
      inputCacheRead: 4,
      outputTotal: 5,
      billingMode: "metered",
    });
    const b = normalizeInclusiveUsage({
      wallMs: 200,
      inputTotal: 20,
      inputCacheRead: 8,
      outputTotal: 7,
      billingMode: "metered",
    });

    const total = sumNormalizedUsage(a, b);
    expect(total.wallMs).toBe(300);
    expect(total.tokens.inputCacheRead).toBe(12);
    expect(total.tokens.inputKnown).toBe(30);
    expect(total.tokens.outputKnown).toBe(12);
  });
});

describe("applyUsageUpdate — snapshot/delta mode guard (§4.1 line 195)", () => {
  test("delta mode accumulates increments across updates", () => {
    let state = applyUsageUpdate(undefined, "delta", { inputUncached: 10 });
    state = applyUsageUpdate(state, "delta", {
      inputUncached: 5,
      outputVisible: 2,
    });

    expect(state.tokens.inputUncached).toBe(15);
    expect(state.tokens.outputVisible).toBe(2);
  });

  test("snapshot mode replaces rather than accumulates", () => {
    let state = applyUsageUpdate(undefined, "snapshot", { inputUncached: 10 });
    state = applyUsageUpdate(state, "snapshot", { inputUncached: 7 });

    expect(state.tokens.inputUncached).toBe(7);
  });

  test("a delta update after a snapshot start is rejected", () => {
    const state = applyUsageUpdate(undefined, "snapshot", {
      inputUncached: 10,
    });

    expect(() =>
      applyUsageUpdate(state, "delta", { inputUncached: 1 }),
    ).toThrow(UsageModeMismatchError);
  });

  test("a snapshot update after a delta start is rejected", () => {
    const state = applyUsageUpdate(undefined, "delta", { inputUncached: 10 });

    expect(() =>
      applyUsageUpdate(state, "snapshot", { inputUncached: 1 }),
    ).toThrow(UsageModeMismatchError);
  });
});

describe("projectLegacyUsage — exact legacy shape at the runPipeline boundary", () => {
  test("returns exactly the legacy field names/values for a complete normalized usage", () => {
    const usage = normalizeInclusiveUsage({
      wallMs: 4200,
      inputTotal: 120,
      inputCacheRead: 40,
      outputTotal: 60,
      outputReasoning: 10,
      billingMode: "metered",
    });

    const legacy = projectLegacyUsage(usage);
    expect(legacy).toEqual({
      wall_ms: 4200,
      tokens_in: 120,
      tokens_out: 60,
      tokens_total: 180,
    });
  });

  test("a partial usage preserves the total while leaving the in/out split at zero, never invented", () => {
    const usage = normalizePartialUsage({
      wallMs: 100,
      providerReportedTotal: 999,
      billingMode: "metered",
    });

    const legacy = projectLegacyUsage(usage);
    expect(legacy).toEqual({
      wall_ms: 100,
      tokens_in: 0,
      tokens_out: 0,
      tokens_total: 999,
    });
  });
});
