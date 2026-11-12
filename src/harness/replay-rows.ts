// The rows and resume rules of refuter-replay and consolidate-replay
// (odd/tasks/route-plan-harness.md S3, S6), here so the gates and offline
// tests cover them; the scripts keep only their CLI wiring. Every row that ran
// a step records the model string it was given and the route identity of the
// step it ran. Resume accepts rows written before the seam, keyed by the model
// string alone, so no paid row is orphaned.
import type { PlanEntry } from "#review/consolidate";
import type { RefuterResult } from "#review/drafts";
import type { Finding } from "#review/findings";
import type { StepResult } from "#review/step-runner";
import {
  type RouteIdentityFields,
  ranOnRoute,
  routeIdentityFields,
  type SingleStepRoute,
} from "./single-step";

export interface RefuterReplayCase {
  readonly run: string;
  readonly finding: string;
  readonly expect: "keep" | "drop";
  readonly label: string;
  // "refuted": the finding lives in findings.json debug.refuted, not in the
  // posted list (the run deleted it). Its id may collide with a posted one.
  readonly source?: "posted" | "refuted";
  readonly note?: string;
}

// The source is part of the key: a refuted finding's id may collide with a
// posted one, and the two must not resume each other. The model is not: which
// route a row ran on is ranOnRoute's question.
export function refuterReplayCaseKey(c: {
  readonly run: string;
  readonly finding: string;
  readonly source?: string;
}): string {
  return `${c.run}|${c.finding}|${c.source ?? "posted"}`;
}

// The case keys already answered on this route in an existing --out. A failed
// step (quota, auth, timeout) is not an answer: it reruns.
export function refuterReplayDone(
  jsonl: string,
  route: SingleStepRoute,
): Set<string> {
  const done = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      run: string;
      finding: string;
      source?: string;
      model?: string;
      step_route_fingerprint?: string;
      status: string;
    };
    if (row.status === "ok" && ranOnRoute(row, route)) {
      done.add(refuterReplayCaseKey(row));
    }
  }
  return done;
}

export type RefuterPromptCheck = "match" | "unrecorded" | "candidate";

export function refuterReplayRow(input: {
  readonly replayCase: RefuterReplayCase;
  readonly finding: Finding;
  readonly route: SingleStepRoute;
  readonly result: StepResult;
  readonly promptCheck: RefuterPromptCheck;
}) {
  const { replayCase: c, finding: f, route, result } = input;
  // A failed step reads as `inconclusive`, exactly as runRefuter treats it.
  const entry =
    result.status === "ok"
      ? (result.output as RefuterResult).results[0]
      : undefined;
  return {
    run: c.run,
    finding: f.id,
    source: c.source ?? "posted",
    model: route.model,
    ...routeIdentityFields(route.identity),
    severity: f.severity,
    tier: f.tier,
    original_verdict: c.source === "refuted" ? "refuted" : f.refuter_verdict,
    verdict: entry?.outcome ?? "inconclusive",
    refuter_proof_refs: entry?.proof_refs ?? [],
    status: result.status,
    denial: result.denialCode ?? null,
    stderr_tail:
      result.status === "ok" ? null : (result.stderrTail ?? "").slice(-400),
    expect: c.expect,
    label: c.label,
    prompt_check: input.promptCheck,
    notional_usd: result.usageV2?.notionalCostUsd ?? null,
    wall_ms: result.usageV2?.wallMs ?? null,
  };
}

// consolidate-replay pins its experiment in config.json, because its audit is
// keyed by PR label only. The pin keeps the shape it had before the seam, so
// an existing --out keeps resuming; the model matches on its route, so another
// spelling of the same model is the same experiment.
export interface ConsolidateReplayConfig {
  readonly arm: string;
  readonly tool: string;
  readonly model: string;
  readonly variant: string;
}

export function consolidateConfigMatches(
  seen: Partial<Record<keyof ConsolidateReplayConfig, unknown>>,
  current: ConsolidateReplayConfig,
  route: SingleStepRoute,
): boolean {
  return (
    seen.arm === current.arm &&
    seen.tool === current.tool &&
    seen.variant === current.variant &&
    ranOnRoute({ model: seen.model }, route)
  );
}

export type ConsolidateStepRow = {
  readonly label: string;
  readonly status: "ok" | "fallback";
  readonly reason?: string;
  readonly plan?: PlanEntry[];
  readonly in: number;
  readonly out: number;
  readonly notional_usd: number | null;
  readonly model: string;
} & RouteIdentityFields;

// The audit row of a PR whose consolidation step ran. A failed step is a
// fallback that keeps every finding, and is retried on resume.
export function consolidateStepRow(input: {
  readonly label: string;
  readonly ids: readonly string[];
  readonly route: SingleStepRoute;
  readonly result: StepResult;
}): ConsolidateStepRow {
  const { label, ids, route, result } = input;
  const ran = {
    model: route.model,
    ...routeIdentityFields(route.identity),
  };
  const notional_usd = result.usageV2?.notionalCostUsd ?? null;
  if (result.status !== "ok") {
    return {
      label,
      status: "fallback",
      reason: (result.stderrTail ?? "").slice(-300),
      in: ids.length,
      out: ids.length,
      notional_usd,
      ...ran,
    };
  }
  const plan = result.output as PlanEntry[];
  return {
    label,
    status: "ok",
    plan,
    in: ids.length,
    out: plan.length,
    notional_usd,
    ...ran,
  };
}
