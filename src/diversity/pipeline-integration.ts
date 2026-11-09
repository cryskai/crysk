import type { ResolvedRoutePlan } from "#model/routing";
import type { DraftFinding } from "#review/drafts";
import { SCHEMA_VERSION_V1_1 } from "#review/findings";
import type { AgentSpec, ReviewSpec } from "#review/spec";
import { resolveSpecialty } from "#review/spec";
import type { StepResult } from "#review/step-runner";
import type { ResolvedModelRoute } from "../execution/contracts";
import {
  type NormalizedUsage,
  normalizeInclusiveUsage,
} from "../execution/usage-normalized";
import {
  appendAttempt,
  appendObservation,
  type DiversityAttemptRecord,
  type DiversityLedger,
  emptyDiversityLedger,
  summarizeDiversityAccounting,
} from "./accounting";
import { synthesizeDeterministicAdjudication } from "./adjudication";
import {
  assertDiversityCapabilityOrThrow,
  checkInternalFindingsCapability,
  type InternalCapabilityReport,
} from "./admission";
import { buildAdjudicationGroups, type FindingObservation } from "./clustering";
import { DiversityAdmissionError } from "./errors";
import {
  assertRouteFingerprintStable,
  assertSpendUnderCap,
  type BenchmarkTarget,
  buildDiversityPlan,
  type DiversityLeg,
  type DiversityPlan,
  expandDiversityAgents,
} from "./identity";
import { projectAdjudicationToFindings } from "./projection";
import { validateFrozenExternalTarget } from "./target-validation";

export interface DiversityPipelineRecord {
  readonly enabled: boolean;
  readonly status: "ok" | "partial" | "skipped" | "failed";
  readonly armId?: string;
  readonly planFingerprint?: string;
  readonly legCount?: number;
  readonly attemptCount?: number;
  readonly observationCount?: number;
  readonly failureCount?: number;
  readonly cashCostUsd?: number;
  readonly notionalCostUsd?: number;
}

export interface DiversityExecutionContext {
  readonly enabled: boolean;
  readonly plan?: DiversityPlan;
  readonly ledger: DiversityLedger;
  readonly routeAgents: readonly AgentSpec[];
}

export interface PrepareDiversityInput {
  readonly reviewSpec: ReviewSpec;
  readonly cliModel?: string;
  readonly frontmatterModel?: (agentKey: string) => string | undefined;
  readonly target?: BenchmarkTarget;
  readonly runtimeTarget?: BenchmarkTarget;
  readonly promptFingerprint?: string;
  readonly buildFingerprint?: string;
  readonly capabilityCheck?: () => InternalCapabilityReport;
}

export function prepareDiversityExecution(
  input: PrepareDiversityInput,
): DiversityExecutionContext {
  const diversity = input.reviewSpec.multiModelDiversity;
  if (!diversity?.enabled) {
    return {
      enabled: false,
      ledger: emptyDiversityLedger(),
      routeAgents: input.reviewSpec.agents,
    };
  }
  assertDiversityCapabilityOrThrow(
    input.capabilityCheck?.() ?? checkInternalFindingsCapability(),
  );
  const frozenTarget = input.target ?? input.runtimeTarget;
  const plan = buildDiversityPlan({
    spec: input.reviewSpec,
    c2SchemaVersion: SCHEMA_VERSION_V1_1,
    cliModel: input.cliModel,
    frontmatterModel: input.frontmatterModel,
    target: frozenTarget,
    promptFingerprint: input.promptFingerprint,
    buildFingerprint: input.buildFingerprint,
  });
  if (plan.target && input.runtimeTarget) {
    validateFrozenExternalTarget(plan.target, input.runtimeTarget);
  }
  const expanded = expandDiversityAgents(input.reviewSpec, plan);
  return {
    enabled: true,
    plan,
    ledger: emptyDiversityLedger(),
    routeAgents: expanded.map((agent) => ({
      key: agent.key,
      specialty: agent.specialty,
      file: agent.file,
      role: agent.role,
      trigger: agent.trigger,
      model: agent.model,
    })),
  };
}

export function executionHuntersForTriggered(
  reviewSpec: ReviewSpec,
  ctx: DiversityExecutionContext,
  triggeredBaseHunters: readonly AgentSpec[],
): readonly AgentSpec[] {
  if (!ctx.enabled || !ctx.plan) return triggeredBaseHunters;
  const expanded = expandDiversityAgents(reviewSpec, ctx.plan);
  const hunters: AgentSpec[] = [];
  for (const base of triggeredBaseHunters) {
    const legs = expanded.filter(
      (agent) =>
        agent.role === "hunter" &&
        (agent.key === base.key || agent.key.startsWith(`${base.key}--`)),
    );
    if (legs.length === 0) {
      hunters.push(base);
      continue;
    }
    for (const leg of legs) {
      hunters.push({
        key: leg.key,
        specialty: leg.specialty,
        file: leg.file,
        role: leg.role,
        trigger: leg.trigger,
        model: leg.model,
      });
    }
  }
  return hunters;
}

function legForAgent(
  plan: DiversityPlan,
  agent: AgentSpec,
): DiversityLeg | undefined {
  return plan.legs.find(
    (leg) => leg.agentKey === agent.key || leg.executionKey === agent.key,
  );
}

function usageFromStep(result: StepResult): NormalizedUsage {
  if (result.usageV2) return result.usageV2;
  return normalizeInclusiveUsage({
    wallMs: result.usage.wall_ms,
    inputTotal: result.usage.tokens_in,
    outputTotal: result.usage.tokens_out,
    billingMode: "unknown",
    costSource: "unknown",
    cashCostUsd: result.usage.cost_usd_est,
    notionalCostUsd: result.usage.cost_usd_est,
  });
}

function scaleUsageFraction(
  usage: NormalizedUsage,
  fraction: number,
): NormalizedUsage {
  const scale = (value: number | undefined) =>
    value === undefined ? undefined : value * fraction;
  return {
    ...usage,
    cashCostUsd: scale(usage.cashCostUsd),
    notionalCostUsd: scale(usage.notionalCostUsd),
    tokens: {
      ...usage.tokens,
      inputKnown: scale(usage.tokens.inputKnown),
      outputKnown: scale(usage.tokens.outputKnown),
      totalKnown: scale(usage.tokens.totalKnown),
      providerReportedTotal: scale(usage.tokens.providerReportedTotal),
    },
  };
}

export function assertDiversityLegRoutes(
  plan: DiversityPlan,
  routePlan: ResolvedRoutePlan,
): void {
  for (const leg of plan.legs) {
    const step = routePlan.steps.find(
      (candidate) => candidate.stepKey === leg.stepKey,
    );
    if (!step) {
      throw new DiversityAdmissionError(
        `missing resolved route for leg ${leg.legId}`,
      );
    }
    assertRouteFingerprintStable(
      leg.routeFingerprint,
      step.routeFingerprint,
      leg.legId,
    );
  }
}

export function assertDiversitySpendUnderCap(
  plan: DiversityPlan,
  ledger: DiversityLedger,
): void {
  const totals = summarizeDiversityAccounting(ledger);
  assertSpendUnderCap(plan, totals.cashCostUsd);
}

export function recordDiversityHunterFailure(
  ledger: DiversityLedger,
  plan: DiversityPlan,
  agent: AgentSpec,
): DiversityLedger {
  const resolvedLeg = legForAgent(plan, agent);
  if (!resolvedLeg) {
    throw new DiversityAdmissionError(
      `no diversity leg for failed hunter ${agent.key}`,
    );
  }
  const attemptId = `${resolvedLeg.legId}-a0`;
  const attempt: DiversityAttemptRecord = {
    attemptId,
    legId: resolvedLeg.legId,
    armId: plan.armId,
    specialty: resolveSpecialty(agent),
    replicate: 1,
    attempt: 0,
    status: "failed",
    usage: normalizeInclusiveUsage({
      wallMs: 0,
      inputTotal: 0,
      outputTotal: 0,
      billingMode: "unknown",
      costSource: "unknown",
    }),
  };
  return appendAttempt(ledger, attempt);
}

export function recordDiversityHunterResult(
  ledger: DiversityLedger,
  plan: DiversityPlan,
  agent: AgentSpec,
  result: StepResult,
  leg?: DiversityLeg,
  executedRoute?: ResolvedModelRoute,
): DiversityLedger {
  const resolvedLeg = leg ?? legForAgent(plan, agent);
  if (!resolvedLeg) {
    throw new DiversityAdmissionError(
      `no diversity leg for hunter ${agent.key}`,
    );
  }
  const totalAttempts = Math.max(1, result.attempts);
  const usage = usageFromStep(result);
  const perAttemptUsage =
    totalAttempts === 1
      ? [usage]
      : Array.from({ length: totalAttempts }, (_, _index) =>
          scaleUsageFraction(usage, 1 / totalAttempts),
        );
  let next = ledger;
  for (let attemptNum = 1; attemptNum <= totalAttempts; attemptNum++) {
    const attemptUsage = perAttemptUsage[attemptNum - 1] ?? usage;
    const isTerminal = attemptNum === totalAttempts;
    const attemptId = `${resolvedLeg.legId}-a${attemptNum}`;
    const attempt: DiversityAttemptRecord = {
      attemptId,
      legId: resolvedLeg.legId,
      armId: plan.armId,
      specialty: resolveSpecialty(agent),
      replicate: 1,
      attempt: attemptNum,
      status: !isTerminal
        ? "retry"
        : result.status === "ok"
          ? "completed"
          : "failed",
      usage: attemptUsage,
    };
    next = appendAttempt(next, attempt);
  }
  if (result.status !== "ok") return next;
  const terminalAttemptId = `${resolvedLeg.legId}-a${totalAttempts}`;
  const routeProvenance: ResolvedModelRoute = executedRoute ?? {
    backend: "claude-code",
    provider: "anthropic",
    modelFamily: resolvedLeg.model.split("/")[0] ?? "unknown",
    modelSnapshot: resolvedLeg.model,
  };
  const output = result.output as { findings?: DraftFinding[] } | undefined;
  const findings = output?.findings ?? [];
  for (const [index, finding] of findings.entries()) {
    const observation: FindingObservation = {
      observationId: `${terminalAttemptId}-o${index + 1}`,
      specialty: resolveSpecialty(agent),
      legId: resolvedLeg.legId,
      backend: routeProvenance.backend,
      provider: routeProvenance.provider,
      modelFamily: routeProvenance.modelFamily,
      modelSnapshot: routeProvenance.modelSnapshot,
      ...(routeProvenance.modelVariant === undefined
        ? {}
        : { modelVariant: routeProvenance.modelVariant }),
      replicate: 1,
      attempt: totalAttempts,
      promptFingerprint: plan.promptFingerprint ?? "unknown",
      routeFingerprint: resolvedLeg.routeFingerprint,
      path: finding.path,
      line: finding.line,
      symbol: finding.symbol,
      category: finding.category,
      severity: finding.severity,
      claim: finding.claim,
      evidence: finding.proof_refs.join(";"),
      proofRefs: finding.proof_refs,
      causalHypothesis: finding.claim,
      artifactSha256: finding.dedupe_key,
    };
    next = appendObservation(next, {
      observation,
      attemptId: terminalAttemptId,
      legId: resolvedLeg.legId,
      armId: plan.armId,
    });
  }
  return next;
}

export function projectDiversityDrafts(ctx: DiversityExecutionContext): {
  drafts: DraftFinding[];
  partial: boolean;
} {
  if (!ctx.enabled || !ctx.plan) {
    return { drafts: [], partial: false };
  }
  const observations = ctx.ledger.observations.map(
    (record) => record.observation,
  );
  let partial = ctx.ledger.failures.length > 0;
  if (observations.length === 0) {
    return { drafts: [], partial };
  }
  const groups = buildAdjudicationGroups(observations);
  const drafts: DraftFinding[] = [];
  for (const group of groups) {
    if (group.ambiguous) {
      partial = true;
      continue;
    }
    const adjudication = synthesizeDeterministicAdjudication(group);
    if (!adjudication || adjudication.relation === "inconclusive") {
      partial = true;
      continue;
    }
    const specialty =
      group.clusters[0]?.observations[0]?.specialty ?? "unknown";
    const projected = projectAdjudicationToFindings(adjudication, specialty);
    partial = partial || projected.partial;
    for (const finding of projected.findings) {
      const { tier: _tier, refuter_verdict: _verdict, ...draft } = finding;
      drafts.push(draft as DraftFinding);
    }
  }
  return { drafts, partial };
}

export function buildDiversityPipelineRecord(
  ctx: DiversityExecutionContext,
  partial: boolean,
): DiversityPipelineRecord | undefined {
  if (!ctx.enabled) {
    return { enabled: false, status: "skipped" };
  }
  if (!ctx.plan) {
    return { enabled: true, status: "failed" };
  }
  const totals = ctx.ledger.attempts.reduce(
    (acc, attempt) => ({
      cash: acc.cash + (attempt.usage.cashCostUsd ?? 0),
      notional: acc.notional + (attempt.usage.notionalCostUsd ?? 0),
    }),
    { cash: 0, notional: 0 },
  );
  return {
    enabled: true,
    status: partial ? "partial" : "ok",
    armId: ctx.plan.armId,
    planFingerprint: ctx.plan.planFingerprint,
    legCount: ctx.plan.legs.length,
    attemptCount: ctx.ledger.attempts.length,
    observationCount: ctx.ledger.observations.length,
    failureCount: ctx.ledger.failures.length,
    cashCostUsd: totals.cash,
    notionalCostUsd: totals.notional,
  };
}

export function diversityDebugFromLedger(
  ctx: DiversityExecutionContext,
): Record<string, unknown> | undefined {
  if (!ctx.enabled || !ctx.plan) return undefined;
  return {
    planFingerprint: ctx.plan.planFingerprint,
    attempts: ctx.ledger.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      legId: attempt.legId,
      armId: attempt.armId,
      specialty: attempt.specialty,
      replicate: attempt.replicate,
      attempt: attempt.attempt,
      status: attempt.status,
      cashCostUsd: attempt.usage.cashCostUsd ?? null,
      notionalCostUsd: attempt.usage.notionalCostUsd ?? null,
    })),
    observations: ctx.ledger.observations.map((record) => ({
      observationId: record.observation.observationId,
      attemptId: record.attemptId,
      legId: record.legId,
      armId: record.armId,
      specialty: record.observation.specialty,
      path: record.observation.path,
      backend: record.observation.backend,
      provider: record.observation.provider,
      modelFamily: record.observation.modelFamily,
      modelSnapshot: record.observation.modelSnapshot,
      ...(record.observation.modelVariant === undefined
        ? {}
        : { modelVariant: record.observation.modelVariant }),
    })),
  };
}
