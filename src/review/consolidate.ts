import { wrapBlock } from "#review/boundary";
import type { Finding } from "#review/findings";

// The consolidation stage's pure half, measured offline on the Martian 50
// (lab bench/METRICS.md 2026-10-27, base variant, F1 39.7 -> 42.3).
// scripts/consolidate-replay.ts imports these, so the bench and the engine
// cannot drift.

export interface PlanEntry {
  primary: string;
  sources: string[];
  split?: boolean;
  // A rescued merged-away draft: its own location and evidence are posted.
  draft?: string;
  claim: string;
}

export interface MergedDraft {
  id: string;
  merged_into: string;
  path: string;
  line: number;
  severity: Finding["severity"];
  claim: string;
  proof_refs: string[];
}

// Rejects a plan that drops a finding, names an unknown one, or detaches a
// primary from its sources. A rejected plan falls back to the input as is,
// so a bad call can cost precision but never recall.
export function validatePlan(
  raw: unknown,
  ids: string[],
  draftIds: Set<string>,
): PlanEntry[] {
  const plan = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error("no findings array");
  }
  const known = new Set(ids);
  const covered = new Set<string>();
  const out: PlanEntry[] = [];
  for (const e of plan as PlanEntry[]) {
    if (typeof e?.primary !== "string" || !known.has(e.primary)) {
      throw new Error(`unknown primary ${String(e?.primary)}`);
    }
    if (!Array.isArray(e.sources) || !e.sources.includes(e.primary)) {
      throw new Error(`${e.primary}: primary missing from sources`);
    }
    for (const s of e.sources) {
      if (!known.has(s)) throw new Error(`unknown source ${s}`);
      covered.add(s);
    }
    if (typeof e.claim !== "string" || e.claim.trim().length === 0) {
      throw new Error(`${e.primary}: empty claim`);
    }
    if (e.draft !== undefined) {
      if (!draftIds.has(e.draft)) throw new Error(`unknown draft ${e.draft}`);
      if (e.split !== true)
        throw new Error(`${e.draft}: a rescue must be a split`);
    }
    out.push({ ...e, split: e.split === true });
  }
  const missing = ids.filter((id) => !covered.has(id));
  if (missing.length > 0) throw new Error(`dropped ${missing.join(",")}`);
  return out;
}

// One output finding per plan entry. A merge keeps the primary's location,
// severity, tier and verdict, and pools the evidence. A split aside was never
// refuted on its own, so it posts advisory with `not_submitted`.
export function applyPlan(
  findings: Finding[],
  plan: PlanEntry[],
  drafts: MergedDraft[],
): Finding[] {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const draftById = new Map(drafts.map((d) => [d.id, d]));
  const splits = new Map<string, number>();
  return plan.map((e) => {
    const primary = byId.get(e.primary) as Finding;
    const proofRefs = [
      ...new Set(e.sources.flatMap((s) => byId.get(s)?.proof_refs ?? [])),
    ];
    if (!e.split) {
      return { ...primary, claim: e.claim, proof_refs: proofRefs };
    }
    const n = (splits.get(e.primary) ?? 0) + 1;
    splits.set(e.primary, n);
    const draft = e.draft === undefined ? undefined : draftById.get(e.draft);
    return {
      ...primary,
      id: `${primary.id}s${n}`,
      claim: e.claim,
      ...(draft === undefined
        ? { proof_refs: primary.proof_refs }
        : {
            path: draft.path,
            line: draft.line,
            severity: draft.severity,
            proof_refs: draft.proof_refs,
          }),
      tier: "advisory",
      refuter_verdict: "not_submitted",
    };
  });
}

// The fields the consolidator sees, in input order. It never sees evidence,
// tier or verdict: it works from the claims alone (prompts/consolidate.md).
export function consolidationInput(findings: readonly Finding[]) {
  return findings.map((f) => ({
    id: f.id,
    path: f.path,
    line: f.line,
    severity: f.severity,
    hunter: f.hunter,
    claim: f.claim,
  }));
}

// The measured user prompt was `Findings:\n<JSON>`. The engine wraps the JSON
// in the run's nonce boundary (§3.4): claims are hunter prose about
// attacker-controlled code. wrapBlock throws BoundaryNonceError when a claim
// carries the nonce; the caller treats that as a passthrough.
export function consolidationPrompt(
  findings: readonly Finding[],
  nonce: string,
): string {
  return `Findings:\n${wrapBlock(
    "findings",
    nonce,
    JSON.stringify(consolidationInput(findings), null, 2),
  )}`;
}

// Engine-side guard over a validated plan, applied in finish() where tiers are
// known. It enforces in code the rules the prompt already states ("primary is
// the most severe source"; one output finding per defect), because the model
// does not always keep them, and a slip must never move a blocking finding off
// the blocking tier or post it twice. Measured effect: of the 49 Martian 50
// plans, 2 change (sentry-3, discourse-4).
//
// `stats`, when passed, receives the number of entries the three rules
// changed: promoted, folded away, or appended. pipeline.json records it so a
// repair is never silent.
export function enforcePlanInvariants(
  plan: PlanEntry[],
  findings: readonly Finding[],
  stats?: { repairs: number },
): PlanEntry[] {
  const blocking = new Set(
    findings.filter((f) => f.tier === "blocking").map((f) => f.id),
  );
  let repairs = 0;

  // Rule 1 — promotion: a merge whose primary is not blocking would post the
  // merged finding off the blocking tier, so the first blocking source leads.
  const promoted = plan.map((e) => {
    if (e.split || blocking.has(e.primary)) return e;
    const first = e.sources.find((s) => blocking.has(s));
    if (first === undefined) return e;
    repairs += 1;
    return { ...e, primary: first };
  });

  // Rule 2 — fold: two non-split entries with one primary would post that
  // finding twice. Splits are asides with their own ids and never fold.
  const folded: PlanEntry[] = [];
  const firstByPrimary = new Map<string, PlanEntry>();
  for (const e of promoted) {
    if (e.split) {
      folded.push(e);
      continue;
    }
    const first = firstByPrimary.get(e.primary);
    if (first === undefined) {
      const copy = { ...e, sources: [...e.sources] };
      firstByPrimary.set(e.primary, copy);
      folded.push(copy);
      continue;
    }
    for (const s of e.sources) {
      if (!first.sources.includes(s)) first.sources.push(s);
    }
    repairs += 1;
  }

  // Rule 3 — orphan: a blocking finding carried only by a split (or by a
  // non-blocking merge) would no longer post on the blocking tier.
  const covered = new Set(
    folded
      .filter((e) => !e.split && blocking.has(e.primary))
      .flatMap((e) => e.sources),
  );
  for (const f of findings) {
    if (f.tier !== "blocking" || covered.has(f.id)) continue;
    folded.push({
      primary: f.id,
      sources: [f.id],
      split: false,
      claim: f.claim,
    });
    repairs += 1;
  }

  if (stats !== undefined) stats.repairs = repairs;
  return folded;
}
