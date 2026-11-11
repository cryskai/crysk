import { createHash } from "node:crypto";
import { modelNameFromAlias } from "#model/model-name";
import {
  agentStepKey,
  type ResolvedModelRoute,
  type ResolvedStepRoute,
  resolveStepRoute,
} from "#model/routing";
import {
  type AgentSpec,
  type ReviewSpec,
  resolveSpecialty,
} from "#review/spec";
import { DiversityAdmissionError } from "./errors";

export interface BenchmarkTarget {
  readonly repoId: string;
  readonly pr: number;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface DiversityLeg {
  readonly legId: string;
  readonly specialty: string;
  readonly agentKey: string;
  readonly logicalModel: string;
  readonly model: string;
  readonly routeFingerprint: string;
  // The route the leg resolved to, the one its routeFingerprint names. Not
  // part of the plan payload (the fingerprint already is), so legIds and the
  // plan fingerprint stay what they were. Provenance reads it when a step
  // carries no executed route (S2).
  readonly route: ResolvedModelRoute;
  readonly executionKey: string;
  readonly stepKey: string;
}

export interface DiversityPlan {
  readonly armId: string;
  readonly feature: "multi-model-diversity";
  readonly c2SchemaVersion: string;
  readonly target?: BenchmarkTarget;
  readonly buildFingerprint?: string;
  readonly promptFingerprint?: string;
  readonly legs: readonly DiversityLeg[];
  readonly maxLegs: number;
  readonly cashCapUsd: number;
  readonly planFingerprint: string;
}

export interface ExpandedAgentSpec extends AgentSpec {
  readonly legId: string;
  readonly executionKey: string;
}

export function deriveLegId(
  specialty: string,
  modelCanonical: string,
  routeFingerprint: string,
): string {
  return createHash("sha256")
    .update(`${specialty}|${modelCanonical}|${routeFingerprint}`)
    .digest("hex")
    .slice(0, 16);
}

export function deriveExecutionKey(agentKey: string, legId: string): string {
  return `${agentKey}@${legId}`;
}

export function diversityLegAgentKey(baseKey: string, legId: string): string {
  return `${baseKey}--${legId}`;
}

function canonicalPlanPayload(
  plan: Omit<DiversityPlan, "planFingerprint">,
): string {
  const legs = [...plan.legs]
    .map(
      (leg) =>
        `${leg.legId}:${leg.specialty}:${leg.agentKey}:${leg.logicalModel}:${leg.model}:${leg.routeFingerprint}:${leg.executionKey}:${leg.stepKey}`,
    )
    .sort()
    .join(";");
  const target = plan.target
    ? `${plan.target.repoId}|${plan.target.pr}|${plan.target.baseSha}|${plan.target.headSha}`
    : "";
  return [
    plan.armId,
    plan.feature,
    plan.c2SchemaVersion,
    target,
    plan.buildFingerprint ?? "",
    plan.promptFingerprint ?? "",
    String(plan.maxLegs),
    String(plan.cashCapUsd),
    legs,
  ].join(";");
}

export function freezeDiversityPlan(
  plan: Omit<DiversityPlan, "planFingerprint">,
): DiversityPlan {
  const planFingerprint = createHash("sha256")
    .update(canonicalPlanPayload(plan))
    .digest("hex");
  return Object.freeze({ ...plan, planFingerprint });
}

export interface BuildDiversityPlanInput {
  readonly spec: ReviewSpec;
  readonly c2SchemaVersion: string;
  readonly cliModel?: string;
  readonly frontmatterModel?: (agentKey: string) => string | undefined;
  readonly target?: BenchmarkTarget;
  readonly buildFingerprint?: string;
  readonly promptFingerprint?: string;
}

export function buildDiversityPlan(
  input: BuildDiversityPlanInput,
): DiversityPlan {
  const diversity = input.spec.multiModelDiversity;
  if (!diversity?.enabled) {
    throw new DiversityAdmissionError(
      "buildDiversityPlan requires multiModelDiversity.enabled",
    );
  }

  const legs: DiversityLeg[] = [];
  for (const agent of input.spec.agents) {
    if (agent.role !== "hunter") continue;
    const models = agent.models;
    if (!models || models.length === 0) continue;
    const specialty = resolveSpecialty(agent);
    for (const model of models) {
      // A leg's model is internal: a bare alias or a full model name. Its
      // own model is the step's spec model, which outranks `models`, the
      // frontmatter and the profile in resolveStepChoices; only `--model`
      // outranks it, and it is passed. So this is the route the run plan
      // gives the leg's step, which assertDiversityLegRoutes checks (S2).
      const parsed = { canonical: modelNameFromAlias(model).raw };
      const provisionalKey = diversityLegAgentKey(
        agent.key,
        deriveLegId(specialty, parsed.canonical, "pending"),
      );
      const stepRoute = resolveStepRoute({
        stepKey: agentStepKey({ key: provisionalKey, role: "hunter" }),
        role: "hunter",
        cliModel: input.cliModel,
        specModel: model,
        frontmatterModel: input.frontmatterModel?.(agent.key),
      });
      const legId = deriveLegId(
        specialty,
        parsed.canonical,
        stepRoute.routeFingerprint,
      );
      const agentKey = diversityLegAgentKey(agent.key, legId);
      const executionKey = deriveExecutionKey(agent.key, legId);
      const stepKey = agentStepKey({ key: agentKey, role: "hunter" });
      legs.push({
        legId,
        specialty,
        agentKey,
        logicalModel: model,
        model: parsed.canonical,
        routeFingerprint: stepRoute.routeFingerprint,
        route: stepRoute.route,
        executionKey,
        stepKey,
      });
    }
  }

  if (legs.length === 0) {
    throw new DiversityAdmissionError(
      "multiModelDiversity enabled but no hunter carries models[]",
    );
  }
  if (legs.length > diversity.maxLegs) {
    throw new DiversityAdmissionError(
      `leg count ${legs.length} exceeds maxLegs ${diversity.maxLegs}`,
    );
  }

  const legIds = new Set(legs.map((leg) => leg.legId));
  if (legIds.size !== legs.length) {
    throw new DiversityAdmissionError("duplicate legId after expansion");
  }
  const executionKeys = new Set(legs.map((leg) => leg.executionKey));
  if (executionKeys.size !== legs.length) {
    throw new DiversityAdmissionError("duplicate executionKey after expansion");
  }

  return freezeDiversityPlan({
    armId: diversity.armId,
    feature: "multi-model-diversity",
    c2SchemaVersion: input.c2SchemaVersion,
    target: input.target,
    buildFingerprint: input.buildFingerprint,
    promptFingerprint: input.promptFingerprint,
    legs,
    maxLegs: diversity.maxLegs,
    cashCapUsd: diversity.cashCapUsd,
  });
}

export function expandDiversityAgents(
  spec: ReviewSpec,
  plan: DiversityPlan,
): readonly ExpandedAgentSpec[] {
  const expanded: ExpandedAgentSpec[] = [];
  for (const agent of spec.agents) {
    if (agent.role === "refuter") {
      expanded.push({
        ...agent,
        legId: agent.key,
        executionKey: agent.key,
      });
      continue;
    }
    const models = agent.models;
    if (!models || models.length === 0) {
      expanded.push({
        ...agent,
        legId: agent.key,
        executionKey: agent.key,
      });
      continue;
    }
    for (const leg of plan.legs) {
      if (!leg.agentKey.startsWith(`${agent.key}--`)) continue;
      expanded.push({
        ...agent,
        key: leg.agentKey,
        specialty: leg.specialty,
        model: leg.logicalModel,
        models: undefined,
        legId: leg.legId,
        executionKey: leg.executionKey,
      });
    }
    if (
      models.length > 0 &&
      !plan.legs.some((leg) => leg.agentKey.startsWith(`${agent.key}--`))
    ) {
      throw new DiversityAdmissionError(
        `no expanded legs found for hunter ${agent.key}`,
      );
    }
  }
  return expanded;
}

export function routeStepsForDiversityPlan(
  plan: DiversityPlan,
  routes: readonly ResolvedStepRoute[],
): readonly ResolvedStepRoute[] {
  const byStep = new Map(routes.map((route) => [route.stepKey, route]));
  return plan.legs.map((leg) => {
    const route = byStep.get(leg.stepKey);
    if (!route) {
      throw new DiversityAdmissionError(
        `missing resolved route for leg step ${leg.stepKey}`,
      );
    }
    return route;
  });
}

export function assertRouteFingerprintStable(
  frozen: string,
  current: string,
  legId: string,
): void {
  if (frozen !== current) {
    throw new DiversityAdmissionError(
      `route drift for leg ${legId}: frozen ${frozen} != current ${current}`,
    );
  }
}

export function assertSpendUnderCap(
  plan: DiversityPlan,
  projectedCashUsd: number,
): void {
  if (projectedCashUsd > plan.cashCapUsd) {
    throw new DiversityAdmissionError(
      `projected cash ${projectedCashUsd} exceeds cap ${plan.cashCapUsd}`,
    );
  }
}
