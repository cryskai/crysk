// Summary-comment state block for item 7 (`docs/item7-rereview-design.md` §3.6).
// Pure. Second marker family on the summary, disjoint from `pr-hero-report`
// and `pr-hero-finding`. Recovers cross-run identity (including Outside Diff)
// from the PR alone — no ~/.prhero, no run directory (O-4).
//
// Placement is load-bearing (R2-S9): AFTER the report marker and visible
// body. `findMarkedCommentId` requires `body.startsWith(pr-hero-report)`,
// so a leading state block would orphan the summary every run.
//
// `R###` ids are stable and never reused (R2-S1). `claim` is required
// because a `channel:"outside"` finding's only copy lives in this block;
// the next PATCH would otherwise erase it (R2-S3).

import { isFullCommitId } from "#git/refs";
import { claimFingerprint } from "#pr/preflight";
import {
  identitiesMatch,
  identityFromFinding,
  identityFromLocs,
} from "#rereview/identity";
import type { Finding } from "#review/findings";
import {
  type FindingChannel,
  type GateStatus,
  isRecoveredSeverity,
  isRecoveredTier,
  type PhaseBResult,
  type PriorRecord,
  type RecoveredSeverity,
  type RecoveredTier,
  TIER_UNRECOVERABLE,
} from "./classify";

export const PR_STATE_MARKER_PREFIX = "<!-- pr-hero-state ";
export const GITHUB_ISSUE_COMMENT_MAX = 65536;

export type LiveStatus = "carried" | "unconfirmed" | "suppressed" | "deferred";

export interface StateFinding {
  id: string;
  sev: RecoveredSeverity;
  tier: RecoveredTier;
  channel: FindingChannel;
  locs: string[];
  c: string;
  claim: string;
}

export interface LiveFinding extends StateFinding {
  status: LiveStatus;
}

export interface ParsedStateBlock {
  headSha: string;
  findings: StateFinding[];
  reviews?: number;
}

const STATE_HEADER = /^<!-- pr-hero-state v=1 head=([0-9a-f]{40}) -->/;
const HTML_COMMENT = /<!--([\s\S]*?)-->/;
const R_ID = /^R(\d{3,})$/;

export function stateMarker(headSha: string): string {
  return `${PR_STATE_MARKER_PREFIX}v=1 head=${headSha} -->`;
}

export function parseStateBlock(body: string): ParsedStateBlock | null {
  const start = body.indexOf(PR_STATE_MARKER_PREFIX);
  if (start === -1) return null;
  const fromMarker = body.slice(start);
  const headerLine = fromMarker.split("\n", 1)[0] ?? "";
  const header = STATE_HEADER.exec(headerLine);
  if (header?.[1] === undefined) return null;
  const headSha = header[1];
  if (!isFullCommitId(headSha)) return null;
  const afterHeader = fromMarker.slice(headerLine.length);
  const jsonComment = HTML_COMMENT.exec(afterHeader);
  if (jsonComment?.[1] === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(jsonComment[1].trim());
    const findings = asStateFindings(parsed);
    if (findings === null) return null;
    const reviews = asStateReviews(parsed);
    if (reviews === null) return null;
    return { headSha, findings, ...(reviews === undefined ? {} : { reviews }) };
  } catch {
    return null;
  }
}

export function renderStateBlock(
  headSha: string,
  findings: readonly StateFinding[],
  reviews?: number,
): string {
  const payload: Record<string, unknown> = {
    findings: findings.map((f) => ({
      id: f.id,
      sev: f.sev,
      tier: f.tier,
      channel: f.channel,
      locs: f.locs,
      c: f.c,
      claim: f.claim,
    })),
  };
  if (reviews !== undefined && Number.isInteger(reviews) && reviews >= 1) {
    payload.reviews = reviews;
  }
  return `${stateMarker(headSha)}\n<!-- ${encodeStateJson(payload)} -->`;
}

// `claimFingerprint("")` is a REAL constant hash (`e3b0c44298fc`), not an
// absence marker — every claim-less row would otherwise share ONE identity
// on `c` (#206's second-order bug: `resolvePriorTie`/`resolveRowTie` in
// rereview/prepare.ts already refuse to trust that constant for a tie-break,
// but the state block itself still wrote it, and nothing guarantees every
// FUTURE consumer of `c` will re-derive that same caution). `id` is unique
// within one state block by construction (`nextStableId` never reuses one),
// so a claim-less row fingerprints its own id instead of nothing.
function liveFingerprint(id: string, claim: string): string {
  if (claim.trim().length > 0) return claimFingerprint(claim);
  return claimFingerprint(`pr-hero:unrecoverable-claim:${id}`);
}

export function stateFinding(input: {
  id: string;
  sev: RecoveredSeverity;
  tier: RecoveredTier;
  channel: FindingChannel;
  locs: readonly string[];
  claim: string;
}): StateFinding {
  return {
    id: input.id,
    sev: input.sev,
    tier: input.tier,
    channel: input.channel,
    locs: [...input.locs],
    c: liveFingerprint(input.id, input.claim),
    claim: input.claim,
  };
}

export function nextStableId(existingIds: readonly string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const match = R_ID.exec(id);
    if (match?.[1] === undefined) continue;
    const n = Number(match[1]);
    if (n > max) max = n;
  }
  return formatR(max + 1);
}

export function assignFreshIds(
  previousIds: readonly string[],
  fresh: readonly Omit<StateFinding, "id">[],
): StateFinding[] {
  const ids = [...previousIds];
  return fresh.map((f) => {
    const id = nextStableId(ids);
    ids.push(id);
    return { ...f, id };
  });
}

// Previous ids — including retired verified-gone — feed nextStableId so an
// id is never reused (R2-S1). Survivors keep their stored rows; fresh
// findings take the next R###.
export function rewriteStateFindings(input: {
  previous: readonly StateFinding[];
  survivingIds: ReadonlySet<string>;
  fresh: readonly Omit<StateFinding, "id">[];
}): StateFinding[] {
  const kept = input.previous.filter((f) => input.survivingIds.has(f.id));
  const previousIds = input.previous.map((f) => f.id);
  return [...kept, ...assignFreshIds(previousIds, input.fresh)];
}

export interface CapResult {
  kept: LiveFinding[];
  droppedUnconfirmed: number;
  droppedCarried: number;
}

// On overflow, evict unconfirmed first, then carried. Never suppressed
// (would resurface as fresh) and never deferred (O-3). Round 3 C-R3-1.
export function capLiveFindings(
  entries: readonly LiveFinding[],
  bodyWithoutState: string,
  headSha: string,
  maxBody: number = GITHUB_ISSUE_COMMENT_MAX,
): CapResult {
  const kept = [...entries];
  let droppedUnconfirmed = 0;
  let droppedCarried = 0;
  while (kept.length > 0 && !fits(bodyWithoutState, headSha, kept, maxBody)) {
    const unconfirmed = lastIndexWith(kept, "unconfirmed");
    if (unconfirmed !== -1) {
      kept.splice(unconfirmed, 1);
      droppedUnconfirmed++;
      continue;
    }
    const carried = lastIndexWith(kept, "carried");
    if (carried !== -1) {
      kept.splice(carried, 1);
      droppedCarried++;
      continue;
    }
    break;
  }
  return { kept, droppedUnconfirmed, droppedCarried };
}

function fits(
  bodyWithoutState: string,
  headSha: string,
  entries: readonly LiveFinding[],
  maxBody: number,
): boolean {
  const stored = entries.map(stripStatus);
  const block = renderStateBlock(headSha, stored);
  return bodyWithoutState.length + block.length <= maxBody;
}

function stripStatus(entry: LiveFinding): StateFinding {
  const { status: _status, ...stored } = entry;
  return stored;
}

function lastIndexWith(
  entries: readonly LiveFinding[],
  status: LiveStatus,
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.status === status) return i;
  }
  return -1;
}

function encodeStateJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
    .replaceAll("-->", "--\\u003e");
}

function asStateFindings(parsed: unknown): StateFinding[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return null;
  const out: StateFinding[] = [];
  for (const row of findings) {
    const finding = asStateFinding(row);
    if (finding === null) return null;
    out.push(finding);
  }
  return out;
}

function asStateReviews(parsed: unknown): number | undefined | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const reviews = (parsed as { reviews?: unknown }).reviews;
  if (reviews === undefined) return undefined;
  if (
    typeof reviews !== "number" ||
    !Number.isInteger(reviews) ||
    reviews < 1
  ) {
    return null;
  }
  return reviews;
}

function asStateFinding(row: unknown): StateFinding | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || !R_ID.test(r.id)) return null;
  if (!isRecoveredSeverity(r.sev) || !isRecoveredTier(r.tier)) return null;
  if (r.channel !== "inline" && r.channel !== "outside") return null;
  if (
    !Array.isArray(r.locs) ||
    !r.locs.every((loc) => typeof loc === "string")
  ) {
    return null;
  }
  if (typeof r.c !== "string" || !/^[0-9a-f]{12}$/.test(r.c)) return null;
  if (typeof r.claim !== "string") return null;
  return {
    id: r.id,
    sev: r.sev,
    tier: r.tier,
    channel: r.channel,
    locs: r.locs as string[],
    c: r.c,
    claim: r.claim,
  };
}

function formatR(n: number): string {
  return `R${String(n).padStart(3, "0")}`;
}

export function isLiveStatus(status: GateStatus): status is LiveStatus {
  return (
    status === "carried" ||
    status === "unconfirmed" ||
    status === "suppressed" ||
    status === "deferred"
  );
}

// WHY a triage-driven return or re-tier is persisted as `carried`: the state
// block is the only memory the next run has, and its live rows are the next
// run's priors. The author's triage stays on the thread and is re-read every
// run, so a misclassified prior, or a dismissal the adjudicator rejected,
// settles the same way again. Dropping it here let two pushes clear a blocking
// finding: run N counted it, the block forgot it, and run N+1 read zero. That
// is self-grading (S7). A worsening return is not kept, because this run's own
// stronger survivor is what carries that finding forward.
export function assembleLive(input: {
  settled: readonly PhaseBResult[];
  priors: readonly PriorRecord[];
  verifyVerdicts: ReadonlyMap<string, GateStatus>;
}): {
  live: LiveFinding[];
  // Every prior the re-review did not verify gone, returned and re-tiered rows
  // included. `live` keeps the triage-driven ones (see the WHY above
  // assembleLive) and drops only a worsening return. The gate keeps all of
  // them: see unresolvedBlockingCount below.
  // Written to the in-memory result only, never to the state block or
  // pipeline.json, so the persisted `live[]` contract is unchanged.
  gateRows: GateRow[];
  verifiedGone: number;
  verifiedGoneIds: string[];
  returned: number;
  reTiered: number;
} {
  const priorById = new Map(input.priors.map((prior) => [prior.id, prior]));
  const live: LiveFinding[] = [];
  const gateRows: GateRow[] = [];
  const verifiedGoneIds: string[] = [];
  let returned = 0;
  let reTiered = 0;
  for (const row of input.settled) {
    let status: GateStatus = row.status;
    if (status === "queued") {
      status = input.verifyVerdicts.get(row.id) ?? "unconfirmed";
    }
    if (status === "verified-gone") {
      verifiedGoneIds.push(row.id);
      continue;
    }
    const gatePrior = priorById.get(row.id);
    if (gatePrior !== undefined) {
      gateRows.push({
        id: gatePrior.id,
        tier: gatePrior.tier,
        locs: row.locs,
        status,
      });
    }
    // Only a triage-driven settlement persists, as `carried`: the author's
    // misclassified tag, or a dismissal the adjudicator rejected. A worsening
    // return stays out, because this run's own stronger survivor carries it.
    let persisted: LiveStatus | undefined;
    if (
      status === "returned" &&
      gatePrior?.triage?.tag === "dismissed" &&
      gatePrior.triage.verdict === "rejected"
    ) {
      persisted = "carried";
    } else if (status === "re-tiered") {
      persisted = "carried";
    } else if (isLiveStatus(status)) {
      persisted = status;
    }
    // WHY a persisted row counts only as carried: the delta line draws carried,
    // re-tiered and returned as disjoint buckets, so a prior also counted here
    // rendered as "1 carried · 1 re-tiered". Only a return or re-tier that stays
    // out of live keeps its own count, which is a worsening return. So
    // `reTiered` is zero for every settlement that has a prior: a re-tier always
    // persists. The field stays because fillRereviewProvenance writes
    // re_tiered to pipeline.json and reads it back when phaseB is absent.
    if (persisted !== undefined && gatePrior !== undefined) {
      live.push({
        id: gatePrior.id,
        sev: gatePrior.sev,
        tier: gatePrior.tier,
        channel: gatePrior.channel,
        locs: row.locs,
        c: liveFingerprint(gatePrior.id, gatePrior.claim),
        claim: gatePrior.claim,
        status: persisted,
      });
    } else if (status === "returned") {
      returned++;
    } else if (status === "re-tiered") {
      reTiered++;
    }
  }
  return {
    live,
    gateRows,
    verifiedGone: verifiedGoneIds.length,
    verifiedGoneIds,
    returned,
    reTiered,
  };
}

// ---------------------------------------------------------------------------
// The gate's unresolved-blocking count (S4, S6, S7). Pure: this run's
// survivors plus the re-review's gate rows in, one number out.
//
// The gate must count what the author still owes, not only what this run
// happened to find. A carried blocking prior that the re-review did not touch
// is still open, and so is a same-head forced re-review, which runs no hunters
// and so has no survivors at all. Before this count existed, both read green.
//
// A prior leaves the count only when something outside the author cleared it:
//   - verified-gone: the verifier refuted the finding, or every file it names
//     was deleted (classifyPrior settles that as verified-gone).
// Nothing this run concludes about a prior lowers it. An advisory survivor at a
// blocking prior's spot does not clear that prior: identity matching is a
// 5-line window, so a different issue can sit there, and the gate fails closed.
// A real fix leaves the count when the re-review VERIFIES it gone, and
// `/pr-hero override` covers a team that accepts the finding.
// A self-asserted triage tag never leaves the count (S7). `misclassified`
// lands as `re-tiered` (classifyPrior), and its tier is the author's claim,
// not the pipeline's, so it is not evidence. A dismissal the adjudicator upheld
// is `suppressed`, and it stays counted for the same reason.
// The next run's count reads the state block, so assembleLive keeps a
// triage-returned prior there as `carried`. Dropping it let two pushes clear it (S7).
//
// Dedupe key. Two rules, both stated so a reader can check them:
//   - a gate row is one prior, keyed by its id (R###). A duplicate row for the
//     same id counts once;
//   - only a BLOCKING survivor pairs, and it pairs with at most one gate row, by
//     the identity the worsening step already uses (identityFromLocs of the
//     prior against identityFromFinding of the survivor). It takes the first
//     unpaired match in PAIR_PREFERENCE order: a blocking row, an unrecoverable
//     row, then an advisory row. A paired row is carried by its survivor and not
//     counted again; a blocking survivor counts by its own tier. An advisory
//     survivor never pairs, so it cannot remove a blocking prior from the count.
// One-to-one is the fail-closed choice: two priors at one spot and one survivor
// count as two, because the survivor can be only one of them.
//
// Unrecoverable tiers ARE counted, as blocking. A prior whose tier could not be
// read back is unclassified, and the fail-visible rule (classify.ts) and S7 both
// forbid a green gate on a finding we cannot classify. Only a verifier verdict or
// a deleted file lowers such a row, and an advisory survivor at the same spot
// does not pair with it.

export interface GateRow {
  id: string;
  tier: RecoveredTier;
  locs: readonly string[];
  status: GateStatus;
}

export type GateSurvivor = Pick<
  Finding,
  "path" | "line" | "proof_refs" | "tier"
>;

// The order a blocking survivor pairs with a prior: its own tier first, then the
// unclassified tier, then advisory. The advisory row never changes the count,
// so it is only ever a last resort and never takes a row the count reads.
const PAIR_PREFERENCE: readonly RecoveredTier[] = [
  "blocking",
  TIER_UNRECOVERABLE,
  "advisory",
];

export function unresolvedBlockingCount(
  survivors: readonly GateSurvivor[],
  rows: readonly GateRow[],
): number {
  const blockingSurvivors = survivors.filter(
    (survivor) => survivor.tier === "blocking",
  ).length;

  // One entry per prior id, and verified-gone never enters the count.
  const seen = new Set<string>();
  const open: GateRow[] = [];
  for (const row of rows) {
    if (row.status === "verified-gone") continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    open.push(row);
  }

  const identities = open.map((row) => identityFromLocs(row.locs));
  const paired = new Set<number>();
  for (const survivor of survivors) {
    // An advisory survivor never pairs: it cannot clear a blocking prior.
    if (survivor.tier !== "blocking") continue;
    const survivorIdentity = identityFromFinding({
      path: survivor.path,
      line: survivor.line,
      proof_refs: survivor.proof_refs,
    });
    for (const tier of PAIR_PREFERENCE) {
      const pick = open.findIndex(
        (row, i) =>
          !paired.has(i) &&
          row.tier === tier &&
          identitiesMatch(identities[i] ?? new Map(), survivorIdentity),
      );
      if (pick !== -1) {
        paired.add(pick);
        break;
      }
    }
  }

  // WHY unrecoverable counts: fail closed, see the note above the GateRow type.
  // Counting only "blocking" would let an unreadable tier turn the gate green.
  let unpairedBlocking = 0;
  for (let i = 0; i < open.length; i++) {
    if (paired.has(i)) continue;
    const tier = open[i]?.tier;
    if (tier === "blocking" || tier === TIER_UNRECOVERABLE) unpairedBlocking++;
  }
  return blockingSurvivors + unpairedBlocking;
}
