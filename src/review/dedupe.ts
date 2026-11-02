// Prose Step 5 as a pure function: merge every hunter's drafts, collapse
// duplicates, renumber survivors. Deterministic — same input, same output.

import type { DraftFinding } from "./drafts";
import { isNotCausedByPr, type Severity } from "./findings";
import { isSafetyProtected } from "./materiality-gate";

// A survivor is a draft whose id has been renumbered to the canonical
// F001, F002, … sequence (and, for a cross-category winner, whose proof_refs
// absorbed its losers' evidence).
export type DedupedSurvivor = DraftFinding;

// A loser is the original hunter-assigned draft VERBATIM plus the surviving
// finding's post-renumber id — the shape debug.deduped[] requires so a
// benchmark miss stays attributable.
export type DedupeLoser = DraftFinding & { merged_into: string };

const SEVERITY_RANK: Record<Severity, number> = {
  BLOCKER: 0,
  CRITICAL: 1,
  WARNING: 2,
  SUGGESTION: 3,
};

// Pass 2 collapses same-path:symbol findings only when their lines sit
// inside this window of each other (connected components). JUDGEMENT, but
// measured: Musive PR 1727 had a same-defect pair 43 lines apart (935 vs
// 978, one try/catch/finally) and a distinct-defect pair 391 apart (544 vs
// 935, tap-to-audio vs timer leak). 100 clears the same-block pair with
// slack and still splits 544 from 935. Widen only with another measurement.
// Direction of error is under-merge: a duplicate comment is visible, an
// over-merge that dumps an in-diff finding into the summary is not.
export const DEDUPE_SYMBOL_LINE_WINDOW = 100;

// Tokens that carry no defect identity. A closed list on purpose: the
// threshold below is only meaningful under the exact tokenizer and stopword
// list that produced it, so this list is part of the calibration and a test
// re-derives the corpus scores through it.
const CLAIM_STOPWORDS = new Set(
  (
    "a an the is are was were be been being and or but if then so that this " +
    "these those it its of to in on for with as at by from into no not " +
    "never every any all when after before once each other same which whose " +
    "there here"
  ).split(" "),
);

// Claim overlap that licenses a discard. JUDGEMENT, but measured: over the 20
// within-arm draft pairs in test/fixtures/dedupe-142-drafts.json (issue #153's
// corpus, ground truth known), same-defect pairs score 0.286-0.667 and
// different-defect pairs score 0.143-0.310. 0.35 sits above EVERY
// different-defect pair, so the direction of error is under-merge: a duplicate
// comment is visible, a destroyed BLOCKER is not.
//
// State the weakness plainly. The margin is thin (0.310 vs 0.35) and the
// calibration is one 29-line fixture. Musive PR 1727's must-merge pair
// (935/978) survives only as line numbers in the comment above — its claim
// text was never recorded — so this design CANNOT guarantee that pair still
// merges, and duplicates that used to collapse may now post twice. The
// severe-loser trace in review/report.ts's "Not reported" section is what keeps the
// residual risk visible instead of silent.
export const DEDUPE_CLAIM_OVERLAP_THRESHOLD = 0.35;

// Below this many distinct tokens a claim is refused as a fold candidate: a
// short claim scores high overlap against anything that happens to contain its
// few tokens, so the coefficient stops discriminating. The observed minimum on
// the real corpus is 14 distinct tokens, so this guard never fires on the
// calibration set — it is a guard against a degenerate case that set does not
// contain.
export const DEDUPE_CLAIM_MIN_TOKENS = 8;

function claimTokens(claim: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of claim.toLowerCase().split(/[^a-z0-9_]+/)) {
    // Length 1 drops the array/index noise ("a", "i", "x") that survives the
    // stopword list without naming anything.
    if (raw.length <= 1) continue;
    if (CLAIM_STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

// OVERLAP COEFFICIENT, |A n B| / min(|A|,|B|) — deliberately not Jaccard.
// Jaccard does not separate on this corpus: same-defect pairs score
// 0.143-0.417 and different-defect pairs 0.049-0.156, ranges that CROSS, so no
// Jaccard threshold exists that folds duplicates without also folding distinct
// defects. Overlap normalises by the shorter claim, which is what makes a
// terse hunter's paraphrase of a verbose hunter's claim score as the same
// defect.
//
// Returns 0 when either claim is under DEDUPE_CLAIM_MIN_TOKENS: refusing to
// score is refusing permission to discard.
export function claimSimilarity(a: string, b: string): number {
  const left = claimTokens(a);
  const right = claimTokens(b);
  const smaller = Math.min(left.size, right.size);
  if (smaller < DEDUPE_CLAIM_MIN_TOKENS) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared++;
  }
  return shared / smaller;
}

// The permission to DISCARD a claim. Grouping (exact key, path proximity)
// stays a wide recall net; this is the narrow gate in front of the delete.
function mayFold(loser: DraftFinding, winner: DraftFinding): boolean {
  return (
    claimSimilarity(loser.claim, winner.claim) >= DEDUPE_CLAIM_OVERLAP_THRESHOLD
  );
}

// Richest claim: higher severity first, then more proof_refs; a full tie
// keeps the earlier finding (first appearance), which keeps the pass stable.
function pickRichest(group: DraftFinding[]): DraftFinding {
  return group.reduce((best, candidate) => {
    const bySeverity =
      SEVERITY_RANK[candidate.severity] - SEVERITY_RANK[best.severity];
    if (bySeverity < 0) return candidate;
    if (
      bySeverity === 0 &&
      candidate.proof_refs.length > best.proof_refs.length
    ) {
      return candidate;
    }
    return best;
  });
}

// Connected components on |lineA - lineB| <= window, preserving the group's
// first-appearance order so survivors still emit where the cluster first
// showed up. Transitive on purpose: 935 and 978 join through each other
// without a middle finding; 544 cannot join them without a finding every
// ~100 lines in between, which 1727 did not have.
function clusterByProximity(
  group: DraftFinding[],
  window: number,
): DraftFinding[][] {
  const n = group.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let cursor = i;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = group[i];
      const b = group[j];
      if (a === undefined || b === undefined) continue;
      if (Math.abs(a.line - b.line) > window) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj) parent[ri] = rj;
    }
  }
  const clusters: DraftFinding[][] = [];
  const indexByRoot = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const member = group[i];
    if (member === undefined) continue;
    const root = find(i);
    const existing = indexByRoot.get(root);
    if (existing === undefined) {
      indexByRoot.set(root, clusters.length);
      clusters.push([member]);
    } else {
      clusters[existing]?.push(member);
    }
  }
  return clusters;
}

// One round of folding: the richest remaining member leads, and every other
// remaining member folds into it ONLY IF the claim gate says so. Members that
// do not fold stay for the next round and get their own survivor. Repeat until
// the group is empty.
//
// Similarity is measured ONLY against the round's winner, never member to
// member. Text similarity is not transitive: a "bridge" claim that reads like
// both of two dissimilar claims would let them chain into one component and
// discard a real defect — the same failure mode the proximity net already has,
// re-introduced through prose. Measuring against the leader means every
// discard was licensed pairwise against the claim that actually survives.
//
// Returned in first-appearance order of each winner within `group`, so the
// callers' "survivor surfaces where its cluster first appeared" ordering holds
// whether a group yields one winner or five.
function foldGroup(
  group: DraftFinding[],
): Array<{ winner: DraftFinding; folded: DraftFinding[] }> {
  const rounds: Array<{ winner: DraftFinding; folded: DraftFinding[] }> = [];
  let remaining = group;
  while (remaining.length > 0) {
    const winner = pickRichest(remaining);
    const folded: DraftFinding[] = [];
    const carried: DraftFinding[] = [];
    for (const member of remaining) {
      if (member === winner) continue;
      if (mayFold(member, winner)) folded.push(member);
      else carried.push(member);
    }
    rounds.push({ winner, folded });
    remaining = carried;
  }
  const orderOf = new Map<DraftFinding, number>();
  group.forEach((member, i) => {
    if (!orderOf.has(member)) orderOf.set(member, i);
  });
  return rounds.sort(
    (a, b) =>
      (orderOf.get(a.winner) as number) - (orderOf.get(b.winner) as number),
  );
}

export function mergeAndDedupe(drafts: DraftFinding[]): {
  survivors: DedupedSurvivor[];
  deduped: DedupeLoser[];
} {
  // Loser → the finding it merged into. Chained at the end: a pass-1 loser
  // whose winner then loses pass 2 must point at the ultimate survivor.
  const winnerOf = new Map<DraftFinding, DraftFinding>();

  // Pass 1 — exact dedupe_key groups. Map preserves insertion order, so
  // winners come out in first-appearance order of their groups.
  //
  // An exact key match is NOT proof of the same defect, and #153 paid for
  // that: in the opencode arm `src/authz.ts:authorize:6` was the key of both
  // the stale-cache draft (L16) and the fail-open draft (L26) — one key, two
  // planted BLOCKERs — and take-all destroyed one of them before pass 2 ever
  // ran. The key is built from `symbol`, which is free text a model writes,
  // so it is a recall net like any other. A member that does not fold emits
  // as its own survivor and flows into pass 2.
  //
  // Pass 1 deliberately does NOT fold proof_refs (it never has); leaving that
  // alone keeps this change about the discard decision only.
  const byKey = new Map<string, DraftFinding[]>();
  for (const draft of drafts) {
    const group = byKey.get(draft.dedupe_key);
    if (group) group.push(draft);
    else byKey.set(draft.dedupe_key, [draft]);
  }
  const pass1: DraftFinding[] = [];
  for (const group of byKey.values()) {
    for (const { winner, folded } of foldGroup(group)) {
      pass1.push(winner);
      for (const loser of folded) winnerOf.set(loser, winner);
    }
  }

  // Pass 2 — cross-category collapse on PATH, with `symbol` dropped as an
  // identity axis entirely (#153). It was free text a model writes, and it
  // failed both ways on the same 29-line file: three hunters spelled one
  // defect `authorize`, `authorize / roleCache` and `roleCache` and got three
  // findings, while two hunters agreeing on `authorize` had their independent
  // BLOCKERs merged into a claim about a different defect.
  //
  // Symbol-less findings now participate too. The old exclusion was written
  // because path-alone keying would over-merge distinct defects file-wide —
  // true, and the warning still names a real risk, but it assumed
  // DISCARD-ON-COLLISION. Grouping no longer discards anything: the claim gate
  // does, and a conservative gate does not discard non-duplicates.
  //
  // Grouping stays a recall net for "same defect, different hunter category",
  // not "everything in this file is one bug". Musive PR 1727 collapsed a
  // tap-to-audio finding at playAudio:544 into a timer-leak finding at :935
  // because both carried symbol `playAudio`; pickRichest kept line 544
  // (off-diff) and the in-diff leak posted only as Evidence inside the
  // summary. Proximity still forms the candidate cluster — only the connected
  // component whose lines fall inside DEDUPE_SYMBOL_LINE_WINDOW — and greedy
  // leader-based folding then decides, inside that cluster, what may be
  // discarded.
  const byPath = new Map<string, DraftFinding[]>();
  for (const draft of pass1) {
    const group = byPath.get(draft.path);
    if (group) group.push(draft);
    else byPath.set(draft.path, [draft]);
  }
  // A winner's FOLDED members, not its whole proximity cluster: the cluster is
  // the candidate net, and folding refs from a candidate that was never
  // discarded would attach one defect's evidence to another's finding.
  const foldedInto = new Map<DraftFinding, DraftFinding[]>();
  const clusterWinnerOf = new Map<DraftFinding, DraftFinding>();
  for (const group of byPath.values()) {
    for (const cluster of clusterByProximity(
      group,
      DEDUPE_SYMBOL_LINE_WINDOW,
    )) {
      for (const { winner, folded } of foldGroup(cluster)) {
        foldedInto.set(winner, folded);
        clusterWinnerOf.set(winner, winner);
        for (const loser of folded) {
          clusterWinnerOf.set(loser, winner);
          winnerOf.set(loser, winner);
        }
      }
    }
  }

  // Emit survivors in first-appearance order: a collapsed cluster's winner
  // surfaces at the position where the cluster first appeared. The winner
  // keeps its own category; losers' proof_refs fold in after the winner's
  // own, deduplicated. Two clusters that share a path:symbol (1727: 544 vs
  // 935/978) each emit — emittedKeys used to be path:symbol and would have
  // dropped the second cluster.
  const survivorsRaw: DraftFinding[] = [];
  const emittedWinners = new Set<DraftFinding>();
  // Folded survivors are new objects; winnerOf chains still point at the
  // original winner, so renumbering has to key on that original.
  const originalOf = new Map<DraftFinding, DraftFinding>();
  // #457: the tier now reads causal_disposition, so a merged group must not
  // take its winner's word for it alone. Every draft that ends in a winner, in
  // either pass, is a witness: when the winner says the PR did not cause the
  // defect but any merged draft says it did (introduced, worsened, activated,
  // or unknown), the survivor keeps that draft's disposition. One hunter's
  // "pre-existing" must not clear a defect another hunter traced to this PR.
  const mergedInto = new Map<DraftFinding, DraftFinding[]>();
  for (const draft of drafts) {
    let root = draft;
    for (let next = winnerOf.get(root); next !== undefined && next !== root; ) {
      root = next;
      next = winnerOf.get(root);
    }
    if (root === draft) continue;
    const members = mergedInto.get(root);
    if (members) members.push(draft);
    else mergedInto.set(root, [draft]);
  }
  // The safety guard reads only the survivor's own claim and path, and the
  // winner's wording is all a survivor keeps. When a merged draft the guard
  // protects (auth, secrets, data loss) folds into a winner whose wording it
  // does not protect, the group cannot vouch that the PR is innocent: the
  // survivor's disposition becomes `unknown`, which keeps it blocking. Never
  // `introduced`, which no hunter said.
  const blamingDisposition = (winner: DraftFinding) => {
    if (!isNotCausedByPr(winner.causal_disposition)) return undefined;
    const members = mergedInto.get(winner) ?? [];
    const blamer = members.find(
      (member) => !isNotCausedByPr(member.causal_disposition),
    );
    if (blamer !== undefined) return blamer.causal_disposition;
    const lostSafety =
      !isSafetyProtected(winner) &&
      members.some((member) => isSafetyProtected(member));
    return lostSafety ? ("unknown" as const) : undefined;
  };
  for (const draft of pass1) {
    const winner = clusterWinnerOf.get(draft) as DraftFinding;
    if (emittedWinners.has(winner)) continue;
    emittedWinners.add(winner);
    const losers = foldedInto.get(winner) as DraftFinding[];
    const blame = blamingDisposition(winner);
    if (losers.length === 0) {
      const survivor =
        blame === undefined ? winner : { ...winner, causal_disposition: blame };
      survivorsRaw.push(survivor);
      originalOf.set(survivor, winner);
      continue;
    }
    const foldedRefs = [...winner.proof_refs];
    for (const member of losers) {
      for (const ref of member.proof_refs) {
        if (!foldedRefs.includes(ref)) foldedRefs.push(ref);
      }
    }
    const folded = {
      ...winner,
      proof_refs: foldedRefs,
      ...(blame === undefined ? {} : { causal_disposition: blame }),
    };
    survivorsRaw.push(folded);
    originalOf.set(folded, winner);
  }

  // Renumbering happens HERE, before the refuter (a JD finding): the refuter
  // batch, verdict mapping, and losers' merged_into all use these final ids —
  // renumbering later would leave debug.deduped[] pointing at dead ids.
  const finalId = new Map<DraftFinding, string>();
  const survivors = survivorsRaw.map((survivor, i) => {
    const id = `F${String(i + 1).padStart(3, "0")}`;
    const original = originalOf.get(survivor) ?? survivor;
    finalId.set(original, id);
    return { ...survivor, id };
  });

  const resolve = (loser: DraftFinding): string => {
    let current = loser;
    let next = winnerOf.get(current);
    while (next) {
      current = next;
      next = winnerOf.get(current);
    }
    return finalId.get(current) as string;
  };

  // Losers in original input order, each verbatim plus merged_into.
  const deduped: DedupeLoser[] = [];
  for (const draft of drafts) {
    if (winnerOf.has(draft)) {
      deduped.push({ ...draft, merged_into: resolve(draft) });
    }
  }

  return { survivors, deduped };
}
