import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DiversityBenchmarkError,
  deriveRunValidity,
  recordPromotion,
  refuseLiveRunWithoutAuthorization,
  requiresExplicitLiveAuthorization,
  scoreBenchmarkRuns,
  validateBenchmarkPlan,
} from "../../src/diversity/benchmark";

const planPath = path.join(
  import.meta.dir,
  "../../docs/benchmarks/d3-musive-plan.json",
);

describe("diversity benchmark", () => {
  test("validates frozen plan with R>=3 and interleaving", () => {
    const plan = validateBenchmarkPlan(
      JSON.parse(readFileSync(planPath, "utf8")),
    );
    expect(plan.interleaved).toBe(true);
    expect(plan.treatmentArm.replicates).toBeGreaterThanOrEqual(3);
  });

  test("excludes invalid runs from promotion metrics", () => {
    const plan = validateBenchmarkPlan(
      JSON.parse(readFileSync(planPath, "utf8")),
    );
    const report = scoreBenchmarkRuns(
      [
        {
          runId: "r1",
          armId: "diversity",
          replicate: 1,
          observedBuildFingerprint: "wrong",
          observedPromptFingerprint: plan.promptFingerprint,
          controlCompleted: true,
          treatmentCompleted: true,
          blindingIntact: true,
          interleavingIntact: true,
          uniqueTruePositives: 2,
          recall: 1,
          cleanPrRestraint: 1,
          blindSpots: 0,
        },
        {
          runId: "r2",
          armId: "diversity",
          replicate: 2,
          observedBuildFingerprint: plan.buildFingerprint,
          observedPromptFingerprint: plan.promptFingerprint,
          controlCompleted: true,
          treatmentCompleted: true,
          blindingIntact: true,
          interleavingIntact: true,
          uniqueTruePositives: 1,
          recall: 0.5,
          cleanPrRestraint: 1,
          blindSpots: 1,
        },
      ],
      plan,
    );
    expect(report.invalidRuns).toBe(1);
    expect(report.validRuns).toBe(1);
    expect(report.recall).toBe(0.5);
    expect(report.blindSpots).toBe(1);
  });

  test("deriveRunValidity rejects drifted fingerprints and broken blinding", () => {
    const plan = validateBenchmarkPlan(
      JSON.parse(readFileSync(planPath, "utf8")),
    );
    expect(
      deriveRunValidity(
        {
          runId: "bad",
          armId: "diversity",
          replicate: 1,
          observedBuildFingerprint: plan.buildFingerprint,
          observedPromptFingerprint: plan.promptFingerprint,
          controlCompleted: true,
          treatmentCompleted: false,
          blindingIntact: true,
          interleavingIntact: true,
          uniqueTruePositives: 0,
          recall: 0,
          cleanPrRestraint: 1,
          blindSpots: 0,
        },
        plan,
      ),
    ).toBe(false);
  });

  test("deriveRunValidity accepts completed dual-arm evidence", () => {
    const plan = validateBenchmarkPlan(
      JSON.parse(readFileSync(planPath, "utf8")),
    );
    expect(
      deriveRunValidity(
        {
          runId: "good",
          armId: "diversity",
          replicate: 1,
          observedBuildFingerprint: plan.buildFingerprint,
          observedPromptFingerprint: plan.promptFingerprint,
          controlCompleted: true,
          treatmentCompleted: true,
          blindingIntact: true,
          interleavingIntact: true,
          uniqueTruePositives: 1,
          recall: 1,
          cleanPrRestraint: 1,
          blindSpots: 0,
        },
        plan,
      ),
    ).toBe(true);
  });

  test("requires separate live authorization and explicit promotion", () => {
    expect(requiresExplicitLiveAuthorization()).toBe(true);
    expect(() => refuseLiveRunWithoutAuthorization()).toThrow(
      DiversityBenchmarkError,
    );
    expect(() => refuseLiveRunWithoutAuthorization()).toThrow(
      /live benchmark run requires separate authorization/,
    );
    expect(() => recordPromotion({ approved: false, scope: "none" })).toThrow();
    expect(recordPromotion({ approved: true, scope: "reliability" })).toEqual({
      approved: true,
      scope: "reliability",
    });
  });

  test("d3 run mode refuses without live authorization", () => {
    const script = path.join(import.meta.dir, "../../scripts/d3.ts");
    const result = spawnSync("bun", ["run", script, "run"], {
      cwd: path.join(import.meta.dir, "../.."),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(
      /live benchmark run requires separate authorization/,
    );
  });
});
