// Row builders and resume rules of refuter-replay and consolidate-replay
// (odd/tasks/route-plan-harness.md T3, S3 and S6). Pure: no runner.
import { describe, expect, test } from "bun:test";
import type { Finding } from "#review/findings";
import type { StepResult } from "#review/step-runner";
import {
  consolidateConfigMatches,
  consolidateStepRow,
  refuterReplayCaseKey,
  refuterReplayDone,
  refuterReplayRow,
} from "../../src/harness/replay-rows";
import { singleStepRoute } from "../../src/harness/single-step";

const sonnet = singleStepRoute("refuter", "sonnet");

function jsonl(rows: object[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("refuterReplayDone", () => {
  const oldRow = {
    run: "/runs/a",
    finding: "F001",
    source: "posted",
    model: "sonnet",
    status: "ok",
  };

  test("rows written with the old model-string key resume", () => {
    const done = refuterReplayDone(jsonl([oldRow]), sonnet);
    expect([...done]).toEqual(["/runs/a|F001|posted"]);
    // The other spelling of the same route resumes them too.
    expect(
      refuterReplayDone(
        jsonl([oldRow]),
        singleStepRoute("refuter", "claude:sonnet-latest"),
      ).size,
    ).toBe(1);
  });

  test("a row from another model, a failed row or an unsourced old row", () => {
    const text = jsonl([
      { ...oldRow, model: "opus" },
      { ...oldRow, finding: "F002", status: "failed" },
      { run: "/runs/a", finding: "F003", model: "sonnet", status: "ok" },
    ]);
    // An old row with no source was a posted finding.
    expect([...refuterReplayDone(text, sonnet)]).toEqual([
      "/runs/a|F003|posted",
    ]);
  });

  test("new rows resume on their fingerprint, never across backends", () => {
    const opencode = singleStepRoute("refuter", "opencode:openai/gpt-x");
    const text = jsonl([
      {
        ...oldRow,
        model: "opencode:openai/gpt-x",
        step_route_fingerprint: opencode.identity.stepRouteFingerprint,
      },
    ]);
    expect(refuterReplayDone(text, opencode).size).toBe(1);
    expect(refuterReplayDone(text, sonnet).size).toBe(0);
  });

  test("the case key matches the done key, with posted as the default", () => {
    expect(refuterReplayCaseKey({ run: "/runs/a", finding: "F001" })).toBe(
      "/runs/a|F001|posted",
    );
    expect(
      refuterReplayCaseKey({
        run: "/runs/a",
        finding: "F001",
        source: "refuted",
      }),
    ).toBe("/runs/a|F001|refuted");
  });
});

describe("refuterReplayRow", () => {
  const finding = {
    id: "F001",
    severity: "high",
    tier: "posted",
    refuter_verdict: "corroborated",
  } as unknown as Finding;
  const replayCase = {
    run: "/runs/a",
    finding: "F001",
    expect: "keep" as const,
    label: "real",
  };

  test("an answered case carries today's fields and the route identity", () => {
    const result = {
      name: "refuter-F001",
      status: "ok",
      output: {
        results: [{ id: "F001", outcome: "refuted", proof_refs: ["a.ts:1"] }],
      },
      usageV2: { notionalCostUsd: 0.5, wallMs: 1200 },
    } as unknown as StepResult;
    expect(
      refuterReplayRow({
        replayCase,
        finding,
        route: sonnet,
        result,
        promptCheck: "match",
      }),
    ).toEqual({
      run: "/runs/a",
      finding: "F001",
      source: "posted",
      model: "sonnet",
      route: sonnet.identity.route,
      route_fingerprint: sonnet.identity.routeFingerprint,
      step_route_fingerprint: sonnet.identity.stepRouteFingerprint,
      severity: "high",
      tier: "posted",
      original_verdict: "corroborated",
      verdict: "refuted",
      refuter_proof_refs: ["a.ts:1"],
      status: "ok",
      denial: null,
      stderr_tail: null,
      expect: "keep",
      label: "real",
      prompt_check: "match",
      notional_usd: 0.5,
      wall_ms: 1200,
    } as never);
  });

  test("a failed step reads as inconclusive, as runRefuter treats it", () => {
    const row = refuterReplayRow({
      replayCase: { ...replayCase, source: "refuted" },
      finding,
      route: singleStepRoute("refuter", "opencode:openai/gpt-x"),
      result: {
        name: "refuter-F001",
        status: "failed",
        stderrTail: "quota",
      } as unknown as StepResult,
      promptCheck: "unrecorded",
    });
    expect(row).toMatchObject({
      source: "refuted",
      model: "opencode:openai/gpt-x",
      original_verdict: "refuted",
      verdict: "inconclusive",
      status: "failed",
      stderr_tail: "quota",
      notional_usd: null,
    });
    expect(row.route.backend).toBe("opencode");
  });
});

describe("consolidateConfigMatches", () => {
  const route = singleStepRoute("consolidate", "sonnet");
  const config = {
    arm: "hunters",
    tool: "crysk",
    model: "sonnet",
    variant: "base",
  };

  test("an existing --out written before the seam still matches", () => {
    expect(consolidateConfigMatches({ ...config }, config, route)).toBe(true);
    // The pinned model may be another spelling of the same route.
    expect(
      consolidateConfigMatches(
        { ...config, variant: "base" },
        { ...config, model: "claude:sonnet-latest" },
        singleStepRoute("consolidate", "claude:sonnet-latest"),
      ),
    ).toBe(true);
  });

  test("another arm, tool, variant or model is a different experiment", () => {
    const seen = { ...config, variant: "base" };
    expect(
      consolidateConfigMatches(seen, { ...config, variant: "strict" }, route),
    ).toBe(false);
    expect(
      consolidateConfigMatches(seen, { ...config, arm: "refuter" }, route),
    ).toBe(false);
    const opus = singleStepRoute("consolidate", "opus");
    expect(
      consolidateConfigMatches(seen, { ...config, model: "opus" }, opus),
    ).toBe(false);
  });
});

describe("consolidateStepRow", () => {
  const route = singleStepRoute("consolidate", "sonnet");

  test("a plan row carries the model and route identity", () => {
    const row = consolidateStepRow({
      label: "cal-1",
      ids: ["F001", "F002"],
      route,
      result: {
        name: "consolidate-cal-1",
        status: "ok",
        output: [{ primary: "F001", sources: ["F001", "F002"] }],
        usageV2: { notionalCostUsd: 0.1 },
      } as unknown as StepResult,
    });
    expect(row).toEqual({
      label: "cal-1",
      status: "ok",
      plan: [{ primary: "F001", sources: ["F001", "F002"] }],
      in: 2,
      out: 1,
      notional_usd: 0.1,
      model: "sonnet",
      route: route.identity.route,
      route_fingerprint: route.identity.routeFingerprint,
      step_route_fingerprint: route.identity.stepRouteFingerprint,
    } as never);
  });

  test("a failed step is a fallback that keeps every finding", () => {
    const row = consolidateStepRow({
      label: "cal-1",
      ids: ["F001"],
      route,
      result: {
        name: "consolidate-cal-1",
        status: "failed",
        stderrTail: "x".repeat(400),
      } as unknown as StepResult,
    });
    expect(row).toMatchObject({
      status: "fallback",
      in: 1,
      out: 1,
      notional_usd: null,
      step_route_fingerprint: route.identity.stepRouteFingerprint,
    });
    expect(row.reason).toHaveLength(300);
  });
});
