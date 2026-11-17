import { describe, expect, test } from "bun:test";
import { validateReviewSpec } from "#review/spec";
import {
  assertDiversityCapabilityOrThrow,
  checkInternalFindingsCapability,
  requireInternalFindingsCapability,
} from "../../src/diversity/admission";
import { DiversityCapabilityError } from "../../src/diversity/errors";
import {
  assertRouteFingerprintStable,
  buildDiversityPlan,
} from "../../src/diversity/identity";

const diversitySpec = validateReviewSpec({
  multiModelDiversity: {
    enabled: true,
    armId: "m6-diversity",
    maxLegs: 3,
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

describe("internal v1.1 capability admission", () => {
  test("passes pr-hero-owned conformance without sibling dependencies", () => {
    const report = checkInternalFindingsCapability();
    expect(report.ok).toBe(true);
    expect(report.c2SchemaVersion).toBe("1.1.0");
    expect(() => requireInternalFindingsCapability()).not.toThrow();
  });

  test("blocks before spawn when internal v1.1 capability report is corrupt", () => {
    expect(() =>
      assertDiversityCapabilityOrThrow({
        ok: false,
        c2SchemaVersion: "1.1.0",
        reason: "conformance case corrupt expected accept",
      }),
    ).toThrow(DiversityCapabilityError);
    expect(() => requireInternalFindingsCapability()).not.toThrow();
  });
});

describe("diversity plan admission", () => {
  test("stable expansion creates distinct leg and execution identities", () => {
    const plan = buildDiversityPlan({
      spec: diversitySpec,
      c2SchemaVersion: "1.1.0",
    });
    expect(plan.legs).toHaveLength(2);
    const legIds = plan.legs.map((leg) => leg.legId);
    expect(new Set(legIds).size).toBe(2);
    const executionKeys = plan.legs.map((leg) => leg.executionKey);
    expect(new Set(executionKeys).size).toBe(2);
    const replay = buildDiversityPlan({
      spec: diversitySpec,
      c2SchemaVersion: "1.1.0",
    });
    expect(replay.planFingerprint).toBe(plan.planFingerprint);
  });

  test("rejects route drift before authorization", () => {
    expect(() => assertRouteFingerprintStable("abc", "def", "leg-1")).toThrow(
      /route drift/,
    );
  });
});
