// Verification-leg namespace for item 7 (`docs/item7-rereview-design.md` §3.4).
// Pure. Follows `runRefuter`'s step shape (one subject, nonced tags, engine-
// owned verdict vocabulary) but NEVER shares ids, artifacts, or the verdict
// map with the refuter in the same run (C3, R2-S1).
//
// `runVerify` itself is not here yet — this module is the contract the
// pipeline spawn has to call, so the first live wiring cannot invent a
// second `F001` collision.

import path from "node:path";
import { blockForgesNonce, wrapBlock } from "#review/boundary";
import type { Severity } from "#review/findings";
import {
  type GateStatus,
  type RecoveredSeverity,
  SEVERITY_UNRECOVERABLE,
  type VerifyTrigger,
} from "./classify";
import {
  type IdentityInput,
  identitiesMatch,
  identityFromFinding,
  identityFromLocs,
} from "./identity";

export const VERIFY_BATCH_FILE = "verify-batch.json";
export const VERIFY_STEPS_DIR = "verify";
export const VERIFIER_AGENT = "verifier";

export interface VerifyQueueEntry {
  priorId: string;
  sev: RecoveredSeverity;
  trigger: VerifyTrigger;
  claim: string;
  locs: readonly string[];
  authorReply: string;
  commentBody: string;
  triageTag: string;
  deltaHunks: string;
}

export interface VerifySubject extends VerifyQueueEntry {
  vId: string;
}

// Three verdicts, each named once in the request. The parse still accepts
// `downgraded-latent` because it shares the refuter's validator, and
// mapVerifyVerdict keeps such a finding open; the request does not offer it,
// because "a real defect nothing can execute yet" is an answer to the
// refuter's question, not to "is it still present".
export const VERIFY_OUTPUT_CONTRACT = [
  "Your final message must be exactly one JSON object — no prose, no code",
  'fences — of the shape {"results":[{"finding_id":"...","outcome":"...",',
  '"proof_refs":["..."]}]} with exactly one verdict per submitted V### id —',
  "never implied, never extra. `outcome` is one of:",
  "- `refuted`: the defect is no longer present in the checkout, and",
  "  `proof_refs` cites the lines that show it.",
  "- `corroborated`: the defect is still present.",
  "- `inconclusive`: you could not tell.",
].join("\n");

export function verifySubjectId(index: number): string {
  return `V${String(index).padStart(3, "0")}`;
}

export function verifyStepName(vId: string): string {
  return `verify-${vId}`;
}

export function verifyArtifactDir(stepsDir: string, vId: string): string {
  return path.join(stepsDir, VERIFY_STEPS_DIR, vId);
}

export function verifyBatchPath(stepsDir: string): string {
  return path.join(stepsDir, VERIFY_BATCH_FILE);
}

// First trigger wins. Case D/E verify-all must not double-charge a prior
// already queued by applied/touched/overlap (round 3).
export function dedupeVerifyQueue(
  queued: readonly VerifyQueueEntry[],
): VerifyQueueEntry[] {
  const seen = new Set<string>();
  const out: VerifyQueueEntry[] = [];
  for (const entry of queued) {
    if (seen.has(entry.priorId)) continue;
    seen.add(entry.priorId);
    out.push(entry);
  }
  return out;
}

const SEV_RANK: Record<Severity, number> = {
  BLOCKER: 0,
  CRITICAL: 1,
  WARNING: 2,
  SUGGESTION: 3,
};

// An unrecoverable severity ranks BEFORE BLOCKER, not after SUGGESTION: we
// genuinely do not know whether the underlying finding is a live BLOCKER
// (#206), so treating it as low priority would let a capacity cut evict the
// one entry most worth re-checking. Ranking it most urgent means a known
// SUGGESTION is evicted before an unknown severity ever is.
function verifyQueueRank(sev: RecoveredSeverity): number {
  return sev === SEVERITY_UNRECOVERABLE ? -1 : SEV_RANK[sev];
}

export function capVerificationQueue(
  queued: readonly VerifyQueueEntry[],
  max: number,
): { verify: VerifyQueueEntry[]; capped: VerifyQueueEntry[] } {
  const unique = dedupeVerifyQueue(queued);
  if (max < 0) {
    return { verify: [], capped: unique };
  }
  const ranked = unique
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const rank = verifyQueueRank(a.entry.sev) - verifyQueueRank(b.entry.sev);
      return rank !== 0 ? rank : a.index - b.index;
    })
    .map((row) => row.entry);
  return {
    verify: ranked.slice(0, max),
    capped: ranked.slice(max),
  };
}

export function assignVerifyIds(
  queued: readonly VerifyQueueEntry[],
): VerifySubject[] {
  return queued.map((entry, i) => ({
    ...entry,
    vId: verifySubjectId(i + 1),
  }));
}

// Phase E (W-order): the queue closes AFTER dedupe. A discovery survivor
// whose identity overlaps a prior that was not already queued appends that
// prior with trigger `overlap`. First trigger still wins (dedupe).
export function appendOverlapTriggers(
  queued: readonly VerifyQueueEntry[],
  candidates: readonly VerifyQueueEntry[],
  survivors: readonly IdentityInput[],
): VerifyQueueEntry[] {
  const extra: VerifyQueueEntry[] = [];
  for (const candidate of candidates) {
    const priorIdent = identityFromLocs(candidate.locs);
    if (priorIdent.size === 0) continue;
    const hits = survivors.some((survivor) =>
      identitiesMatch(priorIdent, identityFromFinding(survivor)),
    );
    if (!hits) continue;
    extra.push({ ...candidate, trigger: "overlap" });
  }
  return dedupeVerifyQueue([...queued, ...extra]);
}

export function triggerCounts(queued: readonly VerifyQueueEntry[]): {
  applied: number;
  touched: number;
  overlap: number;
  verify_all: number;
} {
  const counts = { applied: 0, touched: 0, overlap: 0, verify_all: 0 };
  for (const entry of queued) {
    if (entry.trigger === "case_b_reply") {
      counts.applied++;
      continue;
    }
    counts[entry.trigger]++;
  }
  return counts;
}

export function closeVerifyQueue(input: {
  queued: readonly VerifyQueueEntry[];
  overlapCandidates?: readonly VerifyQueueEntry[];
  survivors?: readonly IdentityInput[];
  max: number;
}): { verify: VerifyQueueEntry[]; capped: VerifyQueueEntry[] } {
  const closed = appendOverlapTriggers(
    input.queued,
    input.overlapCandidates ?? [],
    input.survivors ?? [],
  );
  return capVerificationQueue(closed, input.max);
}

export function mapVerifyVerdict(
  outcome: "refuted" | "corroborated" | "downgraded-latent" | "inconclusive",
): GateStatus {
  if (outcome === "refuted") return "verified-gone";
  if (outcome === "inconclusive") return "unconfirmed";
  return "carried";
}

// A judge-proposed semantic match is a verification trigger, never a
// classification. The return type cannot name `carried`, `suppressed`, or
// `verified-gone` (J-trigger).
export function judgeProposedMatch(priorId: string): {
  action: "queue";
  trigger: "overlap";
  priorId: string;
} {
  return { action: "queue", trigger: "overlap", priorId };
}

export function composeVerifyPrompt(
  subject: VerifySubject,
  nonce: string,
): string | null {
  const previousFinding = JSON.stringify(
    {
      id: subject.vId,
      prior_id: subject.priorId,
      locs: subject.locs,
      claim: subject.claim,
    },
    null,
    2,
  );
  const blocks = [
    previousFinding,
    subject.deltaHunks,
    subject.authorReply,
    subject.commentBody,
    subject.triageTag,
  ];
  if (blocks.some((block) => blockForgesNonce(block, nonce))) return null;
  return [
    "Is the defect this earlier finding describes still present in the code",
    "checked out in your working directory? That checkout is the pull request",
    "at its current head.",
    "",
    wrapBlock("previous_finding", nonce, previousFinding),
    wrapBlock("patch", nonce, subject.deltaHunks),
    wrapBlock("author_reply", nonce, subject.authorReply),
    wrapBlock("comment_body", nonce, subject.commentBody),
    wrapBlock("triage_tag", nonce, subject.triageTag),
    "",
    VERIFY_OUTPUT_CONTRACT,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
