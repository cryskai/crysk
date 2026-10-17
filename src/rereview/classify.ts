// Phase B prior classification for item 7 (`docs/item7-rereview-design.md` §3.3).
// Pure: git facts + recovered triage in, a status or a verify-queue entry out.
// No LLM, no I/O. Phase E (overlap / worsening) and phase F (verdicts) are
// separate — this module only settles what the design says settles before
// hunters run, and queues the rest.
//
// Precedence is ordered rules, not first-match-wins rows. Rename rewrites
// paths and re-enters at rule 1 (R2-C1); triage outranks touched (O-3);
// `resolved` is never inferred from absence (C1).

import type { Severity, Tier } from "#review/findings";
import type { AdjudicationVerdict } from "#triage/adjudication";
import type { TriageTag, TriageVerdict } from "#triage/triage";
import {
  type FindingIdentity,
  formatLocs,
  identitiesMatch,
  identityFromFinding,
  identityFromLocs,
  mapIdentityPaths,
} from "./identity";

// #206: a re-review whose posted priors have no readable `pr-hero-state`
// block (routine, not rare — a FIRST review never writes one at all, see
// `postInlineFindings`'s `framing === undefined` branch in src/pr/pr.ts,
// so EVERY PR's second review takes this path) used to invent
// `sev: "WARNING"` / `tier: "advisory"` for every carried prior — the exact
// silent downgrade the headline's severity-not-tier design (report.ts)
// exists to prevent. These sentinels let a prior say "I could not recover
// this field" without pretending it is a real Severity/Tier: a consumer
// that still switches on the 4/2 real values keeps its old exhaustive
// behavior, and every place this sentinel newly reaches (verify-queue
// priority, worsening, CI admission scoring, the headline count) fails
// toward VISIBILITY instead of toward the wrong bucket. Deliberately local
// sentinels, not a widened `Severity`/`Tier` — those two stay exactly what
// the lab's `Finding` schema expects (project rule 5, schema compatibility
// is sacred); this is pr-hero's own internal PR-comment bookkeeping, never
// read by the lab's scorer.
export const SEVERITY_UNRECOVERABLE = "UNRECOVERABLE" as const;
export type RecoveredSeverity = Severity | typeof SEVERITY_UNRECOVERABLE;

export const TIER_UNRECOVERABLE = "unrecoverable" as const;
export type RecoveredTier = Tier | typeof TIER_UNRECOVERABLE;

export function isRecoveredSeverity(
  value: unknown,
): value is RecoveredSeverity {
  return (
    value === "BLOCKER" ||
    value === "CRITICAL" ||
    value === "WARNING" ||
    value === "SUGGESTION" ||
    value === SEVERITY_UNRECOVERABLE
  );
}

export function isRecoveredTier(value: unknown): value is RecoveredTier {
  return (
    value === "blocking" || value === "advisory" || value === TIER_UNRECOVERABLE
  );
}

export type RereviewCase = "A" | "B" | "C" | "D" | "E";

export type GateStatus =
  | "carried"
  | "verified-gone"
  | "unconfirmed"
  | "suppressed"
  | "deferred"
  | "returned"
  | "re-tiered"
  | "queued"
  // T5b: the author's latest dismissal, upheld by the CI adjudicator
  // (src/triage/adjudication.ts). The one triage outcome that leaves the gate count.
  | "ci-dismissed";

export type VerifyTrigger =
  | "applied"
  | "touched"
  | "overlap"
  | "verify_all"
  | "case_b_reply";

export type FindingChannel = "inline" | "outside";

export interface PriorTriage {
  tag: TriageTag;
  // `applied` carries no adjudicator verdict (`src/triage/triage.ts` ADJUDICATED_TAGS).
  verdict: TriageVerdict | null;
  // ISO-8601 from GitHub. Null means we cannot prove newness (R2-S9).
  createdAt: string | null;
  // T5b: the reply that carried this marker, the finding's thread it sits on, the
  // author's argument (the reply body below the marker line), and the CI verdict on
  // THIS reply, read only from a CI_ADJUDICATOR_LOGIN reply. Absent on a triage read
  // from anywhere but a thread.
  replyId?: number;
  threadId?: number;
  argument?: string;
  ciVerdict?: AdjudicationVerdict | null;
}

export interface PriorRecord {
  id: string;
  sev: RecoveredSeverity;
  tier: RecoveredTier;
  channel: FindingChannel;
  locs: readonly string[];
  claim: string;
  triage: PriorTriage | null;
  // Case B rule 7b: any new reply on the prior thread, including tags
  // other than a newly-applied `applied` (that one is rule 7).
  newThreadReply: boolean;
}

export interface PhaseBContext {
  case: RereviewCase;
  deletedFiles: ReadonlySet<string>;
  renameMap: ReadonlyMap<string, string>;
  touched: (identity: FindingIdentity) => boolean;
  summaryUpdatedAt: string | null;
  // Rereview-coverage fix wiring gap:
  // `DiscoveryPlan.verifyAll` (rereview/plan.ts) was
  // computed for every case but never READ by any production code — this
  // function forced verify_all purely off `case === "D" || "E"`, and
  // buildPhaseBQueue (rereview/prepare.ts) passed it only `case`, never the
  // plan. That made `planDiscovery`'s `verifyAll: true` for a forced-full
  // case B/C (an incomplete prior run) a silent no-op: the refuter-failed
  // prior would stay merely `carried` (case B's empty L===H nameStatus never
  // touches anything) or `queued: touched` at best (case C) — never
  // `verify_all`. This field closes that gap: `true` forces verify_all
  // exactly like case D/E do, for ANY case, so a forced-full re-review
  // actually re-verifies every prior instead of trusting them unexamined.
  verifyAll?: boolean;
}

export interface PhaseBResult {
  id: string;
  status: GateStatus;
  locs: string[];
  renamed: boolean;
  trigger?: VerifyTrigger;
}

export function classifyPrior(
  prior: PriorRecord,
  ctx: PhaseBContext,
): PhaseBResult {
  const original = identityFromLocs(prior.locs);
  const rewritten = mapIdentityPaths(
    original,
    (path) => ctx.renameMap.get(path) ?? path,
  );
  const locs = formatLocs(rewritten);
  const renamed = formatLocs(original).join("\0") !== locs.join("\0");

  if (everyFileDeleted(rewritten, ctx.deletedFiles)) {
    return { id: prior.id, status: "verified-gone", locs, renamed };
  }

  const triage = prior.triage;
  // D5: only a dismissal the CI adjudicator upheld leaves the count.
  if (triage?.tag === "dismissed" && triage.ciVerdict === "upheld") {
    return { id: prior.id, status: "ci-dismissed", locs, renamed };
  }
  if (triage?.tag === "dismissed" && triage.verdict === "upheld") {
    return { id: prior.id, status: "suppressed", locs, renamed };
  }
  if (triage?.tag === "dismissed" && triage.verdict === "rejected") {
    return { id: prior.id, status: "returned", locs, renamed };
  }
  if (triage?.tag === "deferred") {
    return { id: prior.id, status: "deferred", locs, renamed };
  }
  if (triage?.tag === "misclassified") {
    return { id: prior.id, status: "re-tiered", locs, renamed };
  }

  if (ctx.case === "D" || ctx.case === "E" || ctx.verifyAll === true) {
    return {
      id: prior.id,
      status: "queued",
      locs,
      renamed,
      trigger: "verify_all",
    };
  }

  if (triage?.tag === "applied" && appliedBuysVerify(triage, ctx)) {
    return {
      id: prior.id,
      status: "queued",
      locs,
      renamed,
      trigger: "applied",
    };
  }

  if (ctx.case === "B" && prior.newThreadReply) {
    return {
      id: prior.id,
      status: "queued",
      locs,
      renamed,
      trigger: "case_b_reply",
    };
  }

  if (ctx.touched(rewritten)) {
    return {
      id: prior.id,
      status: "queued",
      locs,
      renamed,
      trigger: "touched",
    };
  }

  return { id: prior.id, status: "carried", locs, renamed };
}

function everyFileDeleted(
  identity: FindingIdentity,
  deletedFiles: ReadonlySet<string>,
): boolean {
  if (identity.size === 0) return false;
  for (const path of identity.keys()) {
    if (!deletedFiles.has(path)) return false;
  }
  return true;
}

function appliedBuysVerify(triage: PriorTriage, ctx: PhaseBContext): boolean {
  if (ctx.case !== "B") return true;
  return isNewReply(triage.createdAt, ctx.summaryUpdatedAt);
}

function isNewReply(
  createdAt: string | null,
  summaryUpdatedAt: string | null,
): boolean {
  if (createdAt === null || summaryUpdatedAt === null) return false;
  return createdAt > summaryUpdatedAt;
}

const SEV_RANK: Record<Severity, number> = {
  BLOCKER: 0,
  CRITICAL: 1,
  WARNING: 2,
  SUGGESTION: 3,
};

export function isStrictlyHigherSev(
  discovery: Severity,
  prior: RecoveredSeverity,
): boolean {
  // An unrecoverable prior severity must not silently rank as "already
  // severe enough to stay suppressed" — #206's whole point is that an
  // unknown severity fails toward being LOOKED AT again, never toward
  // staying quiet. Any real rediscovery counts as strictly higher than
  // "unknown", the same "direction of error stays under-match" bias
  // `bindPriorsToPosted` (rereview/prepare.ts) already documents.
  if (prior === SEVERITY_UNRECOVERABLE) return true;
  return SEV_RANK[discovery] < SEV_RANK[prior];
}

export interface WorseningHit {
  priorId: string;
  priorSev: RecoveredSeverity;
  discoverySev: Severity;
}

// Phase E: a suppressed prior stays suppressed against a same-or-lower
// discovery finding, and RETURNS against a strictly-higher one (W-worse).
export function applyWorsening(input: {
  settled: readonly PhaseBResult[];
  priors: readonly PriorRecord[];
  survivors: readonly {
    path: string;
    line: number;
    proof_refs: readonly string[];
    severity: Severity;
  }[];
}): { settled: PhaseBResult[]; hits: WorseningHit[] } {
  const priorById = new Map(input.priors.map((prior) => [prior.id, prior]));
  const hits: WorseningHit[] = [];
  const settled = input.settled.map((row) => {
    if (row.status !== "suppressed") return row;
    const prior = priorById.get(row.id);
    if (prior === undefined) return row;
    const ident = identityFromLocs(row.locs);
    for (const survivor of input.survivors) {
      if (
        !identitiesMatch(
          ident,
          identityFromFinding({
            path: survivor.path,
            line: survivor.line,
            proof_refs: survivor.proof_refs,
          }),
        )
      ) {
        continue;
      }
      if (!isStrictlyHigherSev(survivor.severity, prior.sev)) continue;
      hits.push({
        priorId: row.id,
        priorSev: prior.sev,
        discoverySev: survivor.severity,
      });
      return { ...row, status: "returned" as const };
    }
    return row;
  });
  return { settled, hits };
}
