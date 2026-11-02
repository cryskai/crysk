import { describe, expect, test } from "bun:test";
import {
  claimSimilarity,
  DEDUPE_CLAIM_MIN_TOKENS,
  DEDUPE_CLAIM_OVERLAP_THRESHOLD,
  DEDUPE_SYMBOL_LINE_WINDOW,
  type DedupeLoser,
  mergeAndDedupe,
} from "#review/dedupe";
import type { DraftFinding } from "#review/drafts";
import fixture from "../fixtures/dedupe-142-drafts.json";

// The old default claim ("stale derived state after mutation") carried FOUR
// distinct tokens once stopwords are dropped — below DEDUPE_CLAIM_MIN_TOKENS,
// so every fixture built on it would refuse to fold and the suite would be
// asserting the guard, not the merge. These are realistic hunter prose: the
// default and its paraphrase describe ONE defect (overlap 0.923), DISTINCT
// describes another (overlap 0.000 against both). Verified through the
// production tokenizer, not by hand — see the drift-guard test below.
const DEFAULT_CLAIM =
  "abortUpload deletes the upload record but never clears the derived " +
  "progress state, so the list keeps rendering a stale row for an upload " +
  "that no longer exists after the mutation settles";
const WEAKER_LENS_CLAIM =
  "the derived progress state is not cleared when abortUpload deletes the " +
  "upload record, so a stale row keeps rendering in the list";
const DISTINCT_CLAIM =
  "the retry loop reuses one idempotency token across attempts, so a " +
  "duplicated server-side charge is created whenever the first attempt " +
  "actually succeeded before timing out";

function draft(overrides: Partial<DraftFinding> = {}): DraftFinding {
  return {
    id: "R1",
    category: 1,
    path: "src/upload.ts",
    line: 42,
    symbol: "abortUpload",
    severity: "WARNING",
    evidence_class: "inferential",
    causal_disposition: "introduced",
    claim: DEFAULT_CLAIM,
    proof_refs: ["diff-hunk#1"],
    hunter: "reliability",
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "src/upload.ts:abortUpload:1",
    ...overrides,
  };
}

// The #153 calibration corpus: ten verbatim hunter drafts over one 29-line
// file with two planted BLOCKER defects, both inside authorize(). `defect` is
// the ground-truth partition and is NOT an engine input — it exists so a test
// can say "these two drafts describe the same defect" without a human
// re-reading prose every time.
interface FixtureDraft {
  arm: string;
  hunter: string;
  defect: "fail-open" | "stale-cache";
  category: number;
  path: string;
  line: number;
  symbol: string;
  severity: string;
  dedupe_key: string;
  proof_refs: string[];
  claim: string;
}

const FIXTURE_DRAFTS = fixture.drafts as FixtureDraft[];

function armDrafts(arm: string): DraftFinding[] {
  return FIXTURE_DRAFTS.filter((d) => d.arm === arm).map((d, i) =>
    draft({
      id: `R${i + 1}`,
      category: d.category,
      path: d.path,
      line: d.line,
      symbol: d.symbol,
      severity: d.severity as DraftFinding["severity"],
      claim: d.claim,
      proof_refs: d.proof_refs,
      hunter: d.hunter as DraftFinding["hunter"],
      dedupe_key: d.dedupe_key,
    }),
  );
}

function fixtureDraft(arm: string, hunter: string, line: number): DraftFinding {
  const match = FIXTURE_DRAFTS.find(
    (d) => d.arm === arm && d.hunter === hunter && d.line === line,
  );
  if (match === undefined) {
    throw new Error(`no fixture draft ${arm}/${hunter}/${line}`);
  }
  return draft({
    id: `${hunter}-${line}`,
    category: match.category,
    path: match.path,
    line: match.line,
    symbol: match.symbol,
    severity: match.severity as DraftFinding["severity"],
    claim: match.claim,
    proof_refs: match.proof_refs,
    hunter: match.hunter as DraftFinding["hunter"],
    dedupe_key: match.dedupe_key,
  });
}

describe("pass 1 — dedupe_key groups", () => {
  test("higher severity wins the group", () => {
    const winner = draft({ id: "R1", severity: "CRITICAL" });
    const loser = draft({ id: "R2", severity: "WARNING" });
    const { survivors, deduped } = mergeAndDedupe([loser, winner]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.claim).toBe(winner.claim);
    expect(survivors[0]?.severity).toBe("CRITICAL");
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe("R2");
  });

  test("severity tie falls to more proof_refs", () => {
    const thin = draft({ id: "R1", proof_refs: ["a"] });
    const rich = draft({ id: "R2", proof_refs: ["a", "b", "c"] });
    const { survivors, deduped } = mergeAndDedupe([thin, rich]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.proof_refs).toEqual(["a", "b", "c"]);
    expect(deduped[0]?.id).toBe("R1");
  });
});

describe("pass 1 — a folded group keeps a disposition that blames the PR (#457)", () => {
  test("a pre-existing winner takes the introduced disposition a folded member reported", () => {
    const winner = draft({
      id: "R1",
      severity: "CRITICAL",
      causal_disposition: "pre-existing",
    });
    const loser = draft({
      id: "R2",
      severity: "WARNING",
      causal_disposition: "introduced",
    });
    const { survivors } = mergeAndDedupe([winner, loser]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.severity).toBe("CRITICAL");
    expect(survivors[0]?.causal_disposition).toBe("introduced");
  });

  test("a group where every member says pre-existing stays pre-existing", () => {
    const winner = draft({
      id: "R1",
      severity: "CRITICAL",
      causal_disposition: "pre-existing",
    });
    const loser = draft({
      id: "R2",
      severity: "WARNING",
      causal_disposition: "base-only",
    });
    const { survivors } = mergeAndDedupe([winner, loser]);
    expect(survivors[0]?.causal_disposition).toBe("pre-existing");
  });

  test("a protected member folded into an unprotected pre-existing winner leaves the survivor unknown", () => {
    const winner = draft({
      id: "R1",
      severity: "CRITICAL",
      causal_disposition: "pre-existing",
    });
    const loser = draft({
      id: "R2",
      severity: "WARNING",
      causal_disposition: "pre-existing",
      claim: `${DEFAULT_CLAIM} and the session token is written to the log`,
    });
    const { survivors } = mergeAndDedupe([winner, loser]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.claim).toBe(winner.claim);
    expect(survivors[0]?.causal_disposition).toBe("unknown");
  });

  test("an introduced winner keeps its own disposition", () => {
    const winner = draft({
      id: "R1",
      severity: "CRITICAL",
      causal_disposition: "worsened",
    });
    const loser = draft({
      id: "R2",
      severity: "WARNING",
      causal_disposition: "pre-existing",
    });
    const { survivors } = mergeAndDedupe([winner, loser]);
    expect(survivors[0]?.causal_disposition).toBe("worsened");
  });
});

describe("pass 2 — cross-category collapse on path", () => {
  test("collapses when both carry a symbol; winner keeps its category and folds refs uniquely", () => {
    const winner = draft({
      id: "R1",
      category: 3,
      severity: "BLOCKER",
      proof_refs: ["a", "b"],
      dedupe_key: "src/upload.ts:abortUpload:3",
    });
    const loser = draft({
      id: "P1",
      category: 13,
      severity: "CRITICAL",
      proof_refs: ["b", "c"],
      hunter: "parity",
      dedupe_key: "src/upload.ts:abortUpload:13",
    });
    const { survivors, deduped } = mergeAndDedupe([winner, loser]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.category).toBe(3);
    // Winner's refs first, losers' distinct refs appended, no duplicates.
    expect(survivors[0]?.proof_refs).toEqual(["a", "b", "c"]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.merged_into).toBe("F001");
    // Loser is verbatim: its own refs, untouched by the fold.
    expect(deduped[0]?.proof_refs).toEqual(["b", "c"]);
  });

  // OLD OUTCOME, changed on purpose (#153). Symbol-less findings used to be
  // excluded from pass 2 outright, because keying on path alone would
  // over-merge distinct defects file-wide. That exclusion was protecting
  // against DISCARD-ON-COLLISION; the claim gate makes the discard
  // conditional, so they can participate again — and two drafts whose prose
  // IS the same claim now collapse, which is the correct answer.
  test("symbol-less findings on the same path collapse when the claim matches", () => {
    const a = draft({
      id: "R1",
      category: 1,
      symbol: undefined,
      dedupe_key: "src/upload.ts::1",
    });
    const b = draft({
      id: "R2",
      category: 5,
      symbol: undefined,
      claim: WEAKER_LENS_CLAIM,
      dedupe_key: "src/upload.ts::5",
    });
    const { survivors, deduped } = mergeAndDedupe([a, b]);
    expect(survivors).toHaveLength(1);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe("R2");
  });

  // DOCTRINE, preserved: this is the file-wide over-merge the old exclusion
  // named. Path-alone keying puts these two in one candidate group; only the
  // claim gate keeps the second defect alive.
  test("symbol-less findings on the same path stay split when the claims differ", () => {
    const a = draft({
      id: "R1",
      category: 1,
      symbol: undefined,
      dedupe_key: "src/upload.ts::1",
    });
    const b = draft({
      id: "R2",
      category: 5,
      symbol: undefined,
      claim: DISTINCT_CLAIM,
      dedupe_key: "src/upload.ts::5",
    });
    const { survivors, deduped } = mergeAndDedupe([a, b]);
    expect(survivors).toHaveLength(2);
    expect(deduped).toHaveLength(0);
  });

  test("distinct paths stay untouched even with the same symbol", () => {
    const a = draft({ id: "R1", path: "src/a.ts", dedupe_key: "src/a.ts:x:1" });
    const b = draft({ id: "R2", path: "src/b.ts", dedupe_key: "src/b.ts:x:1" });
    const { survivors, deduped } = mergeAndDedupe([a, b]);
    expect(survivors).toHaveLength(2);
    expect(deduped).toHaveLength(0);
  });

  test("same path:symbol findings far apart stay distinct (Musive #1727)", () => {
    const tap = draft({
      id: "R1",
      line: 544,
      proof_refs: ["store.ts:544"],
      dedupe_key: "src/upload.ts:abortUpload:1",
    });
    const leak = draft({
      id: "S1",
      line: 935,
      hunter: "resilience",
      category: 6,
      proof_refs: ["store.ts:935"],
      dedupe_key: "src/upload.ts:abortUpload:6",
    });
    const { survivors, deduped } = mergeAndDedupe([tap, leak]);
    expect(survivors).toHaveLength(2);
    expect(deduped).toHaveLength(0);
    expect(survivors.map((s) => s.line)).toEqual([544, 935]);
  });

  test("same path:symbol findings within the line window still collapse", () => {
    const leakA = draft({
      id: "S1",
      line: 935,
      hunter: "resilience",
      category: 6,
      proof_refs: ["store.ts:935"],
      dedupe_key: "src/upload.ts:abortUpload:6",
    });
    const leakB = draft({
      id: "L1",
      line: 978,
      hunter: "lifecycle",
      category: 2,
      proof_refs: ["store.ts:978"],
      dedupe_key: "src/upload.ts:abortUpload:2",
    });
    const { survivors, deduped } = mergeAndDedupe([leakA, leakB]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.line).toBe(935);
    expect(survivors[0]?.proof_refs).toEqual(["store.ts:935", "store.ts:978"]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe("L1");
  });

  test("1727 shape: off-diff metric and in-diff leak stay two survivors; nearby leak drafts still fold", () => {
    const tap = draft({
      id: "R1",
      line: 544,
      proof_refs: ["store.ts:544", "store.ts:938"],
      dedupe_key: "src/upload.ts:abortUpload:1",
    });
    const leakA = draft({
      id: "S1",
      line: 935,
      hunter: "resilience",
      category: 6,
      proof_refs: ["store.ts:935"],
      dedupe_key: "src/upload.ts:abortUpload:6",
    });
    const leakB = draft({
      id: "L1",
      line: 978,
      hunter: "lifecycle",
      category: 2,
      proof_refs: ["store.ts:978"],
      dedupe_key: "src/upload.ts:abortUpload:2",
    });
    const { survivors, deduped } = mergeAndDedupe([tap, leakA, leakB]);
    expect(survivors).toHaveLength(2);
    expect(survivors[0]?.line).toBe(544);
    expect(survivors[1]?.line).toBe(935);
    expect(survivors[1]?.proof_refs).toEqual(["store.ts:935", "store.ts:978"]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.merged_into).toBe("F002");
  });

  test("the line window is inclusive at DEDUPE_SYMBOL_LINE_WINDOW and exclusive past it", () => {
    const a = draft({
      id: "R1",
      line: 1,
      dedupe_key: "src/upload.ts:abortUpload:1",
    });
    const atWindow = draft({
      id: "R2",
      line: 1 + DEDUPE_SYMBOL_LINE_WINDOW,
      category: 5,
      dedupe_key: "src/upload.ts:abortUpload:5",
    });
    expect(mergeAndDedupe([a, atWindow]).survivors).toHaveLength(1);
    const past = draft({
      id: "R3",
      line: 1 + DEDUPE_SYMBOL_LINE_WINDOW + 1,
      category: 5,
      dedupe_key: "src/upload.ts:abortUpload:5",
    });
    expect(mergeAndDedupe([a, past]).survivors).toHaveLength(2);
  });
});

describe("renumbering and loser bookkeeping", () => {
  // DOCTRINE unchanged; the FIXTURE was wrong. These three dedupe_keys name
  // three paths but `path` was never overridden, so all three drafts sat on
  // the default src/upload.ts and were kept apart only by `symbol` — the one
  // axis #153 removed. Setting the path the keys already claimed is what the
  // test always meant.
  test("survivors renumber to F001, F002 in first-appearance order", () => {
    const first = draft({
      id: "Z9",
      path: "src/a.ts",
      dedupe_key: "src/a.ts:f:1",
      symbol: "f",
    });
    const second = draft({
      id: "A1",
      path: "src/b.ts",
      dedupe_key: "src/b.ts:g:2",
      symbol: "g",
    });
    const third = draft({
      id: "M5",
      path: "src/c.ts",
      dedupe_key: "src/c.ts:h:3",
      symbol: "h",
    });
    const { survivors } = mergeAndDedupe([first, second, third]);
    expect(survivors.map((s) => s.id)).toEqual(["F001", "F002", "F003"]);
    expect(survivors.map((s) => s.dedupe_key)).toEqual([
      "src/a.ts:f:1",
      "src/b.ts:g:2",
      "src/c.ts:h:3",
    ]);
  });

  test("merged_into names the post-renumber id, not the hunter draft id", () => {
    const standalone = draft({
      id: "R1",
      path: "src/other.ts",
      symbol: "solo",
      dedupe_key: "src/other.ts:solo:1",
    });
    const winner = draft({ id: "R2", severity: "BLOCKER" });
    const loser = draft({ id: "R3", severity: "WARNING" });
    const { survivors, deduped } = mergeAndDedupe([standalone, winner, loser]);
    // The winner is the SECOND survivor, so the loser must point at F002.
    expect(survivors[1]?.claim).toBe(winner.claim);
    expect(deduped[0]?.merged_into).toBe("F002");
  });

  test("losers carry the original draft verbatim plus merged_into", () => {
    const winner = draft({ id: "R1", severity: "BLOCKER" });
    const loser = draft({
      id: "R2",
      severity: "SUGGESTION",
      // DOCTRINE: still one defect through a weaker lens — the claim is now
      // realistic hunter prose instead of a four-word label, because a
      // four-word label can no longer license a discard.
      claim: WEAKER_LENS_CLAIM,
      proof_refs: ["x"],
      hops_used: 4,
    });
    const { deduped } = mergeAndDedupe([winner, loser]);
    const { merged_into, ...verbatim } = deduped[0] as DedupeLoser;
    expect(verbatim).toEqual(loser);
    expect(merged_into).toBe("F001");
  });

  test("a pass-1 loser whose winner falls in pass 2 points at the ultimate survivor", () => {
    const pass1Winner = draft({
      id: "R1",
      category: 1,
      severity: "CRITICAL",
      dedupe_key: "src/upload.ts:abortUpload:1",
    });
    const pass1Loser = draft({
      id: "R2",
      category: 1,
      severity: "WARNING",
      dedupe_key: "src/upload.ts:abortUpload:1",
    });
    const pass2Winner = draft({
      id: "P1",
      category: 13,
      severity: "BLOCKER",
      hunter: "parity",
      dedupe_key: "src/upload.ts:abortUpload:13",
    });
    const { survivors, deduped } = mergeAndDedupe([
      pass1Winner,
      pass1Loser,
      pass2Winner,
    ]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.category).toBe(13);
    expect(deduped).toHaveLength(2);
    for (const loser of deduped) {
      expect(loser.merged_into).toBe("F001");
    }
  });
});

describe("edges", () => {
  test("empty input yields empty survivors and deduped", () => {
    expect(mergeAndDedupe([])).toEqual({ survivors: [], deduped: [] });
  });

  test("single finding passes through with a renumbered id only", () => {
    const only = draft({ id: "R7" });
    const { survivors, deduped } = mergeAndDedupe([only]);
    expect(survivors).toEqual([{ ...only, id: "F001" }]);
    expect(deduped).toEqual([]);
  });

  test("same input always produces the same output", () => {
    const input = [
      draft({ id: "R1", severity: "BLOCKER" }),
      draft({ id: "R2", severity: "WARNING" }),
      draft({ id: "R3", path: "src/b.ts", dedupe_key: "src/b.ts:g:2" }),
    ];
    expect(mergeAndDedupe(input)).toEqual(mergeAndDedupe(input));
  });
});

// #153: `symbol` is free text a model writes, and using it as an identity key
// failed in BOTH directions on this corpus — it over-merged two independent
// BLOCKERs into one claim about a different defect, and it under-merged one
// defect into three findings because three hunters spelled the symbol three
// ways. These tests pin the corpus's ground-truth outcome, not a count.
describe("#153 claim-similarity gate — the calibration corpus", () => {
  const cacheClaim = (claim: string): boolean => /cache/i.test(claim);
  const failOpenClaim = (claim: string): boolean =>
    /roles\.length === 0|empty|no roles|no local roles/i.test(claim);

  test("claude-code arm: both planted defects survive as one finding each", () => {
    const { survivors } = mergeAndDedupe(armDrafts("claude-code"));
    expect(survivors).toHaveLength(2);
    // Direction 1 closed. The fail-open BLOCKER used to be a LOSER folded
    // into the cache claim and vanished from the report entirely; here it is
    // a survivor in its own right.
    const failOpen = survivors.filter((s) => failOpenClaim(s.claim));
    expect(failOpen).toHaveLength(1);
    expect(failOpen[0]?.line).toBe(26);
    expect(failOpen[0]?.severity).toBe("BLOCKER");
    // Direction 2 closed: `authorize`, `authorize / roleCache` and
    // `roleCache` are three spellings of one symbol for one defect; they
    // collapse to a single cache finding.
    const cache = survivors.filter((s) => cacheClaim(s.claim));
    expect(cache).toHaveLength(1);
    expect(cache[0]?.severity).toBe("BLOCKER");
  });

  test("claude-code arm: the three losers are the three redundant drafts", () => {
    const { deduped } = mergeAndDedupe(armDrafts("claude-code"));
    expect(deduped).toHaveLength(3);
    // The cache winner (F001) absorbs the two other cache drafts; the
    // fail-open winner (F002) absorbs the second fail-open draft.
    expect(deduped.map((l) => l.merged_into)).toEqual(["F001", "F002", "F001"]);
  });

  // Under-merge is the DOCTRINE, not a defect to paper over: these two cache
  // drafts score 0.286, below the gate, so the engine posts the same defect
  // twice rather than risk destroying one of them. A duplicate comment is
  // visible; a destroyed BLOCKER is not.
  test("opencode arm: three survivors, with the duplicate cache pair left split", () => {
    const { survivors } = mergeAndDedupe(armDrafts("opencode"));
    expect(survivors).toHaveLength(3);
    expect(survivors.filter((s) => failOpenClaim(s.claim))).toHaveLength(1);
    expect(survivors.filter((s) => cacheClaim(s.claim))).toHaveLength(2);
  });

  // Pass 1 over-merges too, and the issue text did not say so: in the
  // opencode arm `src/authz.ts:authorize:6` is the EXACT dedupe_key of both
  // the cache draft (L16) and the fail-open draft (L26). Same key, different
  // defects — take-all destroyed one before pass 2 ever ran.
  test("pass 1: two different defects under one exact dedupe_key both survive", () => {
    const cache = fixtureDraft("opencode", "resilience", 16);
    const failOpen = fixtureDraft("opencode", "resilience", 26);
    expect(cache.dedupe_key).toBe(failOpen.dedupe_key);
    const { survivors, deduped } = mergeAndDedupe([cache, failOpen]);
    expect(survivors).toHaveLength(2);
    expect(deduped).toHaveLength(0);
    expect(survivors.map((s) => s.line)).toEqual([16, 26]);
  });
});

describe("#153 claim-similarity gate — the gate itself", () => {
  // A short claim scores high overlap against anything that happens to
  // contain its handful of tokens, so overlap stops discriminating. The
  // observed minimum on the real corpus is 14 distinct tokens, so this guard
  // never fires there — it exists for the degenerate case that corpus does
  // not contain.
  test("claims below DEDUPE_CLAIM_MIN_TOKENS never fold, even when identical", () => {
    // Seven distinct tokens. Byte-identical text would score a raw overlap of
    // 1.0; the guard refuses to score it at all, because refusing to score is
    // refusing permission to discard.
    const short = "stale role cache grants revoked admin access";
    expect(claimSimilarity(short, short)).toBe(0);
    // The same function on a claim that clears the floor does score 1.
    expect(claimSimilarity(DEFAULT_CLAIM, DEFAULT_CLAIM)).toBe(1);
    const a = draft({ id: "R1", claim: short, severity: "BLOCKER" });
    const b = draft({ id: "R2", claim: short, severity: "WARNING" });
    const { survivors, deduped } = mergeAndDedupe([a, b]);
    expect(survivors).toHaveLength(2);
    expect(deduped).toHaveLength(0);
  });

  test("DEDUPE_CLAIM_MIN_TOKENS sits below the corpus minimum of 14", () => {
    expect(DEDUPE_CLAIM_MIN_TOKENS).toBe(8);
    for (const d of FIXTURE_DRAFTS) {
      // Self-similarity is 1 only when the claim clears the token floor.
      expect(claimSimilarity(d.claim, d.claim)).toBe(1);
    }
  });

  // Text similarity is NOT transitive. Union-find over pairwise similarity
  // would let a "bridge" claim chain two dissimilar claims into one component
  // and discard a real defect, which is exactly the failure the proximity
  // net already has. Measuring only against the round's winner is what
  // removes the chain.
  describe("bridge immunity — similarity is measured against the winner only", () => {
    const A =
      "the module level role cache is never invalidated, so a revoked " +
      "administrator keeps passing the only gate in front of the admin " +
      "routes forever";
    const B =
      "the role cache is never invalidated and the retry loop reuses one " +
      "idempotency token, so a revoked administrator keeps passing the gate " +
      "while a duplicated charge is created on a replayed attempt";
    const C =
      "the retry loop reuses one idempotency token on a replayed attempt, " +
      "so a duplicated charge is created against the customer";

    test("the bridge shape is real: A~B and B~C pass, A~C does not", () => {
      expect(claimSimilarity(A, B)).toBeGreaterThanOrEqual(
        DEDUPE_CLAIM_OVERLAP_THRESHOLD,
      );
      expect(claimSimilarity(B, C)).toBeGreaterThanOrEqual(
        DEDUPE_CLAIM_OVERLAP_THRESHOLD,
      );
      expect(claimSimilarity(A, C)).toBeLessThan(
        DEDUPE_CLAIM_OVERLAP_THRESHOLD,
      );
    });

    // The guarantee: with an ENDPOINT as leader, the far end is never
    // discarded. Union-find would have merged A-B-C into one component and
    // dropped C on the floor.
    test("with A richest, B folds into A and C survives untouched", () => {
      const a = draft({
        id: "A",
        claim: A,
        severity: "BLOCKER",
        proof_refs: ["a1", "a2", "a3"],
        dedupe_key: "src/upload.ts:abortUpload:1",
      });
      const b = draft({
        id: "B",
        claim: B,
        severity: "BLOCKER",
        proof_refs: ["b1"],
        category: 5,
        dedupe_key: "src/upload.ts:abortUpload:5",
      });
      const c = draft({
        id: "C",
        claim: C,
        severity: "BLOCKER",
        proof_refs: ["c1"],
        category: 6,
        hunter: "resilience",
        dedupe_key: "src/upload.ts:abortUpload:6",
      });
      const { survivors, deduped } = mergeAndDedupe([a, b, c]);
      expect(survivors).toHaveLength(2);
      expect(survivors.map((s) => s.claim)).toEqual([A, C]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.id).toBe("B");
      expect(deduped[0]?.merged_into).toBe("F001");
    });

    // The other arrangement, stated precisely rather than wished away: when
    // the BRIDGE is the leader, A and C both fold into it. That is the rule
    // working as designed — each discard was licensed pairwise against the
    // claim that survives, and B's prose really does state both defects.
    // What never happens is A and C licensing each other's discard.
    test("with B richest, A and C each fold against B directly", () => {
      const a = draft({
        id: "A",
        claim: A,
        severity: "BLOCKER",
        proof_refs: ["a1"],
        dedupe_key: "src/upload.ts:abortUpload:1",
      });
      const b = draft({
        id: "B",
        claim: B,
        severity: "BLOCKER",
        proof_refs: ["b1", "b2", "b3"],
        category: 5,
        dedupe_key: "src/upload.ts:abortUpload:5",
      });
      const c = draft({
        id: "C",
        claim: C,
        severity: "BLOCKER",
        proof_refs: ["c1"],
        category: 6,
        hunter: "resilience",
        dedupe_key: "src/upload.ts:abortUpload:6",
      });
      const { survivors, deduped } = mergeAndDedupe([a, b, c]);
      expect(survivors).toHaveLength(1);
      expect(survivors[0]?.claim).toBe(B);
      expect(deduped.map((l) => l.id)).toEqual(["A", "C"]);
    });
  });

  // The 0.35 threshold only means anything under the exact tokenizer and
  // stopword list that produced it. Recomputing the corpus THROUGH the
  // production function makes drift in either break loudly here instead of
  // silently recalibrating the gate in production.
  test("threshold drift guard: the corpus bounds still hold", () => {
    const round = (n: number): number => Number(n.toFixed(3));
    let pairs = 0;
    let same = 0;
    let diff = 0;
    for (const arm of ["claude-code", "opencode"]) {
      const group = FIXTURE_DRAFTS.filter((d) => d.arm === arm);
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const x = group[i] as FixtureDraft;
          const y = group[j] as FixtureDraft;
          const score = round(claimSimilarity(x.claim, y.claim));
          pairs++;
          if (x.defect === y.defect) {
            same++;
            // Documented same-defect range: 0.286 - 0.667.
            expect(score).toBeGreaterThanOrEqual(0.286);
            expect(score).toBeLessThanOrEqual(0.667);
          } else {
            diff++;
            // Documented different-defect range: 0.143 - 0.310.
            expect(score).toBeGreaterThanOrEqual(0.143);
            expect(score).toBeLessThanOrEqual(0.31);
            // The load-bearing invariant: no different-defect pair may ever
            // license a discard.
            expect(score).toBeLessThan(DEDUPE_CLAIM_OVERLAP_THRESHOLD);
          }
        }
      }
    }
    expect(pairs).toBe(20);
    expect(same).toBe(8);
    expect(diff).toBe(12);
    expect(DEDUPE_CLAIM_OVERLAP_THRESHOLD).toBe(0.35);
  });

  test("similarity is symmetric and empty claims never license a discard", () => {
    const a = DEFAULT_CLAIM;
    const b = WEAKER_LENS_CLAIM;
    expect(claimSimilarity(a, b)).toBe(claimSimilarity(b, a));
    expect(claimSimilarity("", a)).toBe(0);
    expect(claimSimilarity("", "")).toBe(0);
  });
});
