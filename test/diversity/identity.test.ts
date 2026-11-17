import { describe, expect, test } from "bun:test";
import { defaultReviewSpec, validateReviewSpec } from "#review/spec";
import {
  buildDiversityPlan,
  deriveExecutionKey,
  deriveLegId,
  diversityLegAgentKey,
  expandDiversityAgents,
} from "../../src/diversity/identity";

describe("diversity identity", () => {
  test("legacy default spec stays byte-stable without diversity config", () => {
    const spec = defaultReviewSpec();
    expect(spec.multiModelDiversity).toBeUndefined();
    expect(spec.agents.every((agent) => agent.models === undefined)).toBe(true);
  });

  test("deriveLegId is stable for the same specialty/model/route tuple", () => {
    const a = deriveLegId("reliability", "anthropic/claude-sonnet-4", "fp1");
    const b = deriveLegId("reliability", "anthropic/claude-sonnet-4", "fp1");
    expect(a).toBe(b);
    expect(a).not.toBe(deriveLegId("reliability", "openai/gpt-5", "fp1"));
  });

  test("execution keys never overload specialty or agent key", () => {
    const legId = deriveLegId(
      "reliability",
      "anthropic/claude-sonnet-4",
      "fp1",
    );
    const executionKey = deriveExecutionKey("reliability", legId);
    expect(executionKey).toContain("@");
    expect(executionKey).not.toBe("reliability");
    expect(diversityLegAgentKey("reliability", legId)).toContain("--");
  });

  test("expandDiversityAgents preserves specialty while diverging keys", () => {
    const spec = validateReviewSpec({
      multiModelDiversity: {
        enabled: true,
        armId: "arm-a",
        maxLegs: 2,
      },
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          models: ["sonnet", "opus"],
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
    const plan = buildDiversityPlan({
      spec,
      c2SchemaVersion: "1.1.0",
    });
    const expanded = expandDiversityAgents(spec, plan);
    const hunters = expanded.filter((agent) => agent.role === "hunter");
    expect(hunters).toHaveLength(2);
    expect(new Set(hunters.map((agent) => agent.key)).size).toBe(2);
    expect(hunters.every((agent) => agent.specialty === "reliability")).toBe(
      true,
    );
  });
});
