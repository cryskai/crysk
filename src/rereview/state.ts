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
  formatLocs,
  identitiesMatch,
  identityFromFinding,
  identityFromLocs,
} from "#rereview/identity";
import type { Finding, Severity } from "#review/findings";
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
  // The highest R### number ever assigned on this PR (see renderStateBlock).
  // An old block without the field reads as the highest id among its rows.
  hw: number;
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
    const hw = asStateHw(parsed, findings);
    if (hw === null) return null;
    return {
      headSha,
      findings,
      hw,
      ...(reviews === undefined ? {} : { reviews }),
    };
  } catch {
    return null;
  }
}

// WHY hw is written on every block: a retired row leaves the block, and its id
// must not be handed to a new finding on a later run. The merge sees only the
// rows a block still holds, so the high-water mark is the one record that
// outlives the row. It is never below the highest row id, so an absent or
// stale caller value cannot let an id be reused.
export function renderStateBlock(
  headSha: string,
  findings: readonly StateFinding[],
  reviews?: number,
  hw?: number,
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
  payload.hw = Math.max(
    hw ?? 0,
    highestStableNumber(findings.map((f) => f.id)),
  );
  return `${stateMarker(headSha)}\n<!-- ${encodeStateJson(payload)} -->`;
}

// `claimFingerprint("")` is a REAL constant hash (`e3b0c44298fc`), not an
// absence marker — every claim-less row would otherwise share ONE identity
// on `c` (#206's second-order bug: `resolvePriorTie`/`resolveRowTie` in
// rereview/prepare.ts already refuse to trust that constant for a tie-break,
// but the state block itself still wrote it, and nothing guarantees every
// FUTURE consumer of `c` will re-derive that same caution). `id` is unique
// within one state block by construction (a fresh id is always above the
// high-water mark, so it never reuses one),
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

function highestStableNumber(ids: readonly string[]): number {
  let max = 0;
  for (const id of ids) {
    const match = R_ID.exec(id);
    if (match?.[1] === undefined) continue;
    const n = Number(match[1]);
    if (n > max) max = n;
  }
  return max;
}

export interface CapResult {
  kept: LiveFinding[];
  droppedUnconfirmed: number;
  droppedCarried: number;
}

export interface CapOptions {
  reviews?: number;
  hw?: number;
  // Ids this run's survivors touched or added. They are never evicted and they
  // still count toward the size, so the block reports what this run found.
  protectedIds?: ReadonlySet<string>;
}

// On overflow, evict unconfirmed first, then carried, and only PRIOR rows of
// tier advisory. Never suppressed (would resurface as fresh), never deferred
// (O-3), and never a blocking row. Round 3 C-R3-1.
// WHY a blocking row is never evicted: the next review's gate counts the rows
// the state block holds. A blocking row dropped here makes that gate read green
// with the finding still open, which is self-grading (S7). When the block is
// still too large after every advisory prior is gone, the caller keeps the
// render as is, and GitHub reports the size failure.
export function capLiveFindings(
  entries: readonly LiveFinding[],
  bodyWithoutState: string,
  headSha: string,
  maxBody: number = GITHUB_ISSUE_COMMENT_MAX,
  options: CapOptions = {},
): CapResult {
  const kept = [...entries];
  let droppedUnconfirmed = 0;
  let droppedCarried = 0;
  const protectedIds = options.protectedIds ?? new Set<string>();
  while (
    kept.length > 0 &&
    !fits(bodyWithoutState, headSha, kept, maxBody, options)
  ) {
    const unconfirmed = lastEvictableIndex(kept, "unconfirmed", protectedIds);
    if (unconfirmed !== -1) {
      kept.splice(unconfirmed, 1);
      droppedUnconfirmed++;
      continue;
    }
    const carried = lastEvictableIndex(kept, "carried", protectedIds);
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
  options: CapOptions,
): boolean {
  const stored = entries.map(stripStatus);
  const block = renderStateBlock(headSha, stored, options.reviews, options.hw);
  return bodyWithoutState.length + block.length <= maxBody;
}

function stripStatus(entry: LiveFinding): StateFinding {
  const { status: _status, ...stored } = entry;
  return stored;
}

function lastEvictableIndex(
  entries: readonly LiveFinding[],
  status: LiveStatus,
  protectedIds: ReadonlySet<string>,
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.status !== status) continue;
    if (entry.tier !== "advisory" || protectedIds.has(entry.id)) continue;
    return i;
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

// An absent hw reads as the highest id among the block's rows, which is what a
// block written before the mark existed can prove. A present hw must be a
// non-negative integer, or the whole block is rejected like any other malformed
// field.
function asStateHw(
  parsed: unknown,
  findings: readonly StateFinding[],
): number | null {
  const raw = (parsed as { hw?: unknown }).hw;
  if (raw === undefined) return highestStableNumber(findings.map((f) => f.id));
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
  return raw;
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

export interface SurvivorPair {
  survivor: number;
  row: number;
}

// The one pairing rule, shared by the gate count and the state merge. Each
// blocking survivor takes the first unpaired row in PAIR_PREFERENCE order whose
// identity matches it; one-to-one; an advisory survivor never pairs.
export function pairBlockingSurvivors(
  survivors: readonly GateSurvivor[],
  rows: readonly { tier: RecoveredTier; locs: readonly string[] }[],
): SurvivorPair[] {
  const identities = rows.map((row) => identityFromLocs(row.locs));
  const paired = new Set<number>();
  const pairs: SurvivorPair[] = [];
  survivors.forEach((survivor, s) => {
    // An advisory survivor never pairs: it cannot clear a blocking prior.
    if (survivor.tier !== "blocking") return;
    const survivorIdentity = identityFromFinding({
      path: survivor.path,
      line: survivor.line,
      proof_refs: survivor.proof_refs,
    });
    for (const tier of PAIR_PREFERENCE) {
      const pick = rows.findIndex(
        (row, i) =>
          !paired.has(i) &&
          row.tier === tier &&
          identitiesMatch(identities[i] ?? new Map(), survivorIdentity),
      );
      if (pick !== -1) {
        paired.add(pick);
        pairs.push({ survivor: s, row: pick });
        return;
      }
    }
  });
  return pairs;
}

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

  const paired = new Set(
    pairBlockingSurvivors(survivors, open).map((p) => p.row),
  );

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

// The state merge (S1, S2, S6, S7). Pure. The live priors of this run, plus the
// previous block's rows and high-water mark, plus this run's survivors, in; the
// rows the state block should hold out, the new high-water mark, and how many
// prior advisory identities the size cap dropped.
//
// WHY the POST and the PATCH of one run call this with the same inputs: the
// create-first POST and the closing PATCH must write the same state block, or a
// PATCH that re-renders the state can drop or renumber rows the POST recorded.

export interface FreshStateFinding extends GateSurvivor {
  severity: Severity;
  claim: string;
  channel: FindingChannel;
}

export interface MergeStateInput {
  headSha: string;
  reviews: number;
  live: readonly LiveFinding[];
  previous: { findings: readonly StateFinding[]; hw: number } | null;
  fresh: readonly FreshStateFinding[];
  stateBudget: number;
}

export interface MergedState {
  rows: LiveFinding[];
  hw: number;
  dropped: number;
}

// Visible body the state block must leave room for. The PATCH body is longer
// than the POST body (review links, a moved head line) and the drop note is one
// line, so a fixed reserve covers both and keeps the state block a function of
// the POST inputs alone.
const VISIBLE_BODY_RESERVE = 4096;

export function stateBlockBudget(referenceBodyLength: number): number {
  return Math.max(
    0,
    GITHUB_ISSUE_COMMENT_MAX - referenceBodyLength - VISIBLE_BODY_RESERVE,
  );
}

export function mergeStateFindings(input: MergeStateInput): MergedState {
  const priorIds = [
    ...(input.previous?.findings ?? []).map((f) => f.id),
    ...input.live.map((row) => row.id),
  ];
  let hw = Math.max(input.previous?.hw ?? 0, highestStableNumber(priorIds));
  const rows: LiveFinding[] = input.live.map((row) => ({ ...row }));
  const touched = new Set<string>();

  const pairs = pairBlockingSurvivors(
    input.fresh,
    rows.map((row) => ({ tier: row.tier, locs: row.locs })),
  );
  const rowOfSurvivor = new Map(pairs.map((p) => [p.survivor, p.row]));
  // WHY a second, advisory-only pass: without it a re-found advisory appends a
  // new row every review, and the state grows until the cap evicts it. Pairing
  // an advisory survivor with an advisory row is safe, because neither side is
  // a row the gate count reads. It never takes a blocking or unrecoverable row,
  // so the fail-closed rule of pairBlockingSurvivors still holds.
  const takenRows = new Set(pairs.map((p) => p.row));
  const rowIdentities = rows.map((row) => identityFromLocs(row.locs));
  for (const [s, finding] of input.fresh.entries()) {
    if (finding.tier !== "advisory" || rowOfSurvivor.has(s)) continue;
    const identity = identityFromFinding(finding);
    const pick = rows.findIndex(
      (row, i) =>
        !takenRows.has(i) &&
        row.tier === "advisory" &&
        identitiesMatch(rowIdentities[i] ?? new Map(), identity),
    );
    if (pick === -1) continue;
    takenRows.add(pick);
    rowOfSurvivor.set(s, pick);
  }
  for (const [s, finding] of input.fresh.entries()) {
    const locs = formatLocs(identityFromFinding(finding));
    const rowIndex = rowOfSurvivor.get(s);
    if (rowIndex !== undefined) {
      // A suppressed prior keeps its severity and tier: the adjudicator's
      // upheld dismissal is the record, and this run's survivor only moves
      // where the finding sits and what it says.
      const prior = rows[rowIndex];
      if (prior === undefined) continue;
      const keepsRating = prior.status === "suppressed";
      rows[rowIndex] = {
        ...stateFinding({
          id: prior.id,
          sev: keepsRating ? prior.sev : finding.severity,
          tier: keepsRating ? prior.tier : finding.tier,
          channel: finding.channel,
          locs,
          claim: finding.claim,
        }),
        status: prior.status,
      };
      touched.add(prior.id);
      continue;
    }
    // WHY an unpaired survivor appends: a blocking survivor with no matching row
    // is new, and an advisory one matched no advisory row. An advisory never
    // takes a blocking row (see pairBlockingSurvivors), so it cannot clear a
    // blocking prior that sits at its spot. Appending is the fail-closed choice.
    hw += 1;
    const id = formatR(hw);
    rows.push({
      ...stateFinding({
        id,
        sev: finding.severity,
        tier: finding.tier,
        channel: finding.channel,
        locs,
        claim: finding.claim,
      }),
      status: "unconfirmed",
    });
    touched.add(id);
  }

  const capped = capLiveFindings(rows, "", input.headSha, input.stateBudget, {
    reviews: input.reviews,
    hw,
    protectedIds: touched,
  });
  return {
    rows: capped.kept,
    hw,
    dropped: capped.droppedUnconfirmed + capped.droppedCarried,
  };
}

// One visible line, placed next to the state block, saying the size cap dropped
// identities from the state. Empty when nothing was dropped.
export function droppedStateNote(count: number): string {
  if (count <= 0) return "";
  const noun = count === 1 ? "finding identity was" : "finding identities were";
  return `_${count} ${noun} dropped from the state block to keep this comment within GitHub's size limit._`;
}
