import type { BenchmarkTarget } from "./identity";

export interface DiversityBenchmarkArm {
  readonly armId: string;
  readonly enabled: boolean;
  readonly replicates: number;
}

export interface DiversityBenchmarkPlan {
  readonly planId: string;
  readonly target: BenchmarkTarget;
  readonly controlArm: DiversityBenchmarkArm;
  readonly treatmentArm: DiversityBenchmarkArm;
  readonly buildFingerprint: string;
  readonly promptFingerprint: string;
  readonly interleaved: true;
  readonly stopOnInvalidRun: true;
}

export class DiversityBenchmarkError extends Error {}

function must(condition: boolean, message: string): void {
  if (!condition) throw new DiversityBenchmarkError(message);
}

export function validateBenchmarkPlan(
  candidate: unknown,
): DiversityBenchmarkPlan {
  must(
    typeof candidate === "object" && candidate !== null,
    "benchmark plan must be an object",
  );
  const plan = candidate as Record<string, unknown>;
  must(
    typeof plan.planId === "string" && plan.planId.length > 0,
    "planId required",
  );
  must(
    typeof plan.target === "object" && plan.target !== null,
    "target required",
  );
  const target = plan.target as Record<string, unknown>;
  must(typeof target.repoId === "string", "target.repoId required");
  must(typeof target.pr === "number" && target.pr > 0, "target.pr required");
  must(
    typeof target.baseSha === "string" && target.baseSha.length === 40,
    "target.baseSha must be 40 hex chars",
  );
  must(
    typeof target.headSha === "string" && target.headSha.length === 40,
    "target.headSha must be 40 hex chars",
  );
  const control = plan.controlArm as Record<string, unknown>;
  const treatment = plan.treatmentArm as Record<string, unknown>;
  must(control?.enabled === false, "control arm must be disabled diversity");
  must(treatment?.enabled === true, "treatment arm must enable diversity");
  must(
    typeof treatment.replicates === "number" && treatment.replicates >= 3,
    "treatment replicates must be >= 3",
  );
  must(plan.interleaved === true, "plan must be interleaved");
  must(
    typeof plan.buildFingerprint === "string" &&
      plan.buildFingerprint.length > 0,
    "buildFingerprint required",
  );
  must(
    typeof plan.promptFingerprint === "string" &&
      plan.promptFingerprint.length > 0,
    "promptFingerprint required",
  );
  must(plan.stopOnInvalidRun === true, "stopOnInvalidRun must be true");
  return plan as unknown as DiversityBenchmarkPlan;
}

export interface BenchmarkRunEvidence {
  readonly runId: string;
  readonly armId: string;
  readonly replicate: number;
  readonly observedBuildFingerprint: string;
  readonly observedPromptFingerprint: string;
  readonly controlCompleted: boolean;
  readonly treatmentCompleted: boolean;
  readonly blindingIntact: boolean;
  readonly interleavingIntact: boolean;
  readonly uniqueTruePositives: number;
  readonly recall: number;
  readonly cleanPrRestraint: number;
  readonly blindSpots: number;
  readonly replicateOmitted?: boolean;
}

export interface ScoredBenchmarkRun extends BenchmarkRunEvidence {
  readonly valid: boolean;
}

export function deriveRunValidity(
  run: BenchmarkRunEvidence,
  plan: DiversityBenchmarkPlan,
): boolean {
  if (run.replicateOmitted === true) return false;
  if (!run.blindingIntact || !run.interleavingIntact) return false;
  if (!run.controlCompleted || !run.treatmentCompleted) return false;
  if (run.observedBuildFingerprint !== plan.buildFingerprint) return false;
  if (run.observedPromptFingerprint !== plan.promptFingerprint) return false;
  if (run.replicate < 1 || run.replicate > plan.treatmentArm.replicates) {
    return false;
  }
  return true;
}

export interface BenchmarkScoreReport {
  readonly recall: number;
  readonly cleanPrRestraint: number;
  readonly blindSpots: number;
  readonly validRuns: number;
  readonly invalidRuns: number;
}

export function scoreBenchmarkRuns(
  runs: readonly BenchmarkRunEvidence[],
  plan?: DiversityBenchmarkPlan,
): BenchmarkScoreReport {
  const scored: ScoredBenchmarkRun[] = plan
    ? runs.map((run) => ({ ...run, valid: deriveRunValidity(run, plan) }))
    : runs.map((run) => ({
        ...run,
        valid: (run as ScoredBenchmarkRun).valid ?? false,
      }));
  const validRuns = scored.filter((run) => run.valid);
  const invalidRuns = scored.length - validRuns.length;
  const _uniqueTp = validRuns.reduce(
    (sum, run) => sum + run.uniqueTruePositives,
    0,
  );
  const recall =
    validRuns.length === 0
      ? 0
      : validRuns.reduce((sum, run) => sum + run.recall, 0) / validRuns.length;
  const cleanPrRestraint =
    validRuns.length === 0
      ? 0
      : validRuns.reduce((sum, run) => sum + run.cleanPrRestraint, 0) /
        validRuns.length;
  const blindSpots = validRuns.reduce((sum, run) => sum + run.blindSpots, 0);
  return {
    recall,
    cleanPrRestraint,
    blindSpots,
    validRuns: validRuns.length,
    invalidRuns,
  };
}

export function requiresExplicitLiveAuthorization(): boolean {
  return true;
}

export interface PromotionDecision {
  readonly approved: boolean;
  readonly scope: string;
}

export function recordPromotion(
  decision: PromotionDecision,
): PromotionDecision {
  if (!decision.approved) {
    throw new DiversityBenchmarkError(
      "promotion requires explicit human approval",
    );
  }
  return decision;
}

export function refuseLiveRunWithoutAuthorization(): never {
  throw new DiversityBenchmarkError(
    "live benchmark run requires separate authorization",
  );
}
