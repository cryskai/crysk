import { describe, expect, test } from "bun:test";
import { claimFingerprint } from "#pr/preflight";
import {
  type PriorRecord,
  SEVERITY_UNRECOVERABLE,
  TIER_UNRECOVERABLE,
} from "#rereview/classify";
import { planDiscovery } from "#rereview/plan";
import {
  bindPriorsToPosted,
  buildPhaseBQueue,
  collapseTargets,
  decideLastHeadDelta,
  enrichPriorsFromThreads,
  parseNameStatus,
  prepareDiscovery,
  priorsFromPostedMarkers,
  priorsFromStateFindings,
  type RereviewGit,
  readRereviewProvenance,
  shouldAbortEmptyDiscovery,
  toRereviewProvenance,
} from "#rereview/prepare";
import {
  assembleLive,
  type LiveFinding,
  parseStateBlock,
  renderStateBlock,
  stateFinding,
} from "#rereview/state";
import type { Finding } from "#review/findings";
import { renderInlineComment } from "#review/report";
import { triageMarker } from "#triage/triage";

const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const L = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const H = "cccccccccccccccccccccccccccccccccccccccc";
const MISSING = "dddddddddddddddddddddddddddddddddddddddd";

function git(over: Partial<RereviewGit> = {}): RereviewGit {
  return {
    commitExists: async () => true,
    isAncestor: async () => true,
    nameOnly: async () => [],
    ...over,
  };
}

describe("shouldAbortEmptyDiscovery — S-empty", () => {
  test("a first review with an empty diff still errors", () => {
    expect(
      shouldAbortEmptyDiscovery(
        planDiscovery({ case: "A", full: false, lastComplete: true }),
        "",
      ),
    ).toBe(true);
  });

  test("a re-review empty delta is not an error", () => {
    expect(
      shouldAbortEmptyDiscovery(
        planDiscovery({ case: "C", full: false, lastComplete: true }),
        "",
      ),
    ).toBe(false);
    expect(
      shouldAbortEmptyDiscovery(
        planDiscovery({ case: "B", full: false, lastComplete: true }),
        "",
      ),
    ).toBe(false);
  });

  test("a non-empty patch never aborts", () => {
    expect(
      shouldAbortEmptyDiscovery(
        planDiscovery({ case: "A", full: false, lastComplete: true }),
        "diff --git a/x b/x\n",
      ),
    ).toBe(false);
  });
});

describe("prepareDiscovery", () => {
  test("case A — no prior, unrestricted B..H", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: null,
      summaryComplete: true,
      findingMarkers: [],
      git: git(),
    });
    expect(prepared.case).toBe("A");
    expect(prepared.discoveryPaths).toBeNull();
    expect(prepared.discoveryFrom).toBe(B);
    expect(prepared.plan.emptyDeltaIsError).toBe(true);
    expect(toRereviewProvenance(prepared)).toBeUndefined();
  });

  test("S-A — summary gone, L recovered from latest finding-marker created_at", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: null,
      summaryComplete: true,
      findingMarkers: [
        { headSha: MISSING, createdAt: "2026-08-20T00:00:00Z" },
        { headSha: L, createdAt: "2026-08-21T00:00:00Z" },
      ],
      git: git({ isAncestor: async () => true }),
    });
    expect(prepared.last).toEqual({
      L,
      source: "finding_markers",
      lastComplete: true,
    });
    expect(prepared.case).toBe("C");
    expect(prepared.plan.emptyDeltaIsError).toBe(false);
  });

  test("S-empty — restricted intersection empty skips discovery, does not error", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: L,
      summaryComplete: true,
      findingMarkers: [],
      git: git({
        nameOnly: async (from) => (from === B ? ["src/a.ts"] : ["vendor/x"]),
      }),
    });
    expect(prepared.case).toBe("C");
    expect(prepared.discoveryPaths).toEqual([]);
    expect(prepared.discoverySkippedEmptyDelta).toBe(true);
    expect(prepared.plan.emptyDeltaIsError).toBe(false);
    expect(toRereviewProvenance(prepared)?.discovery_skipped_empty_delta).toBe(
      true,
    );
  });

  test("S-merge — discovery files are files(B..H) ∩ files(L..H)", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: L,
      summaryComplete: true,
      findingMarkers: [],
      git: git({
        nameOnly: async (from) =>
          from === B
            ? ["src/a.ts", "src/b.ts"]
            : ["src/b.ts", "vendor/upstream.ts"],
      }),
    });
    expect(prepared.case).toBe("C");
    expect(prepared.discoveryPaths).toEqual(["src/b.ts"]);
    expect(prepared.discoveryFrom).toBe(L);
    expect(prepared.discoverySkippedEmptyDelta).toBe(false);
    expect(toRereviewProvenance(prepared)?.discovery_restricted).toBe(true);
  });

  test("W-cli — --full widens C to B..H and keeps the real case", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: true,
      summaryHead: L,
      summaryComplete: true,
      findingMarkers: [],
      git: git({
        nameOnly: async () => {
          throw new Error("restricted name-only must not run under --full");
        },
      }),
    });
    expect(prepared.case).toBe("C");
    expect(prepared.plan.discovery).toBe("full");
    expect(prepared.plan.discoveryRestricted).toBe(false);
    expect(prepared.discoveryPaths).toBeNull();
    expect(prepared.discoveryFrom).toBe(B);
    expect(toRereviewProvenance(prepared)?.discovery_restricted).toBe(false);
  });

  test("case B without --full skips discovery", async () => {
    const prepared = await prepareDiscovery({
      B,
      H: L,
      full: false,
      summaryHead: L,
      summaryComplete: true,
      findingMarkers: [],
      git: git(),
    });
    expect(prepared.case).toBe("B");
    expect(prepared.plan.skipDiscovery).toBe(true);
    expect(prepared.discoveryPaths).toEqual([]);
    expect(prepared.discoverySkippedEmptyDelta).toBe(true);
  });

  // Rereview-coverage fix — the end-to-end reproduction of the reported
  // defect (MusiveTech/musive PR 1823): a PARTIAL run's summary marker at
  // L===H (case B) must NOT take the skipDiscovery branch. `discoveryFrom`
  // === B (the unrestricted, full B..H range — `plan.discovery !== "restricted"`
  // routes prepareDiscovery to the B..H branch, never the L..H one) and
  // `discoverySkippedEmptyDelta` is false, which is exactly what makes
  // cli.ts's `activeHunters` non-empty again.
  test("a partial summary marker at L===H forces full discovery instead of skipping it", async () => {
    const prepared = await prepareDiscovery({
      B,
      H: L,
      full: false,
      summaryHead: L,
      summaryComplete: false,
      findingMarkers: [],
      git: git(),
    });
    expect(prepared.case).toBe("B");
    expect(prepared.last.lastComplete).toBe(false);
    expect(prepared.plan.skipDiscovery).toBe(false);
    expect(prepared.plan.discovery).toBe("full");
    expect(prepared.plan.verifyAll).toBe(true);
    expect(prepared.discoveryPaths).toBeNull();
    expect(prepared.discoveryFrom).toBe(B);
    expect(prepared.discoverySkippedEmptyDelta).toBe(false);
    expect(toRereviewProvenance(prepared)?.last_review_complete).toBe(false);
  });

  test("D4 — L exists but is not an ancestor → full B..H, verify-all", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: L,
      summaryComplete: true,
      findingMarkers: [],
      git: git({ isAncestor: async () => false }),
    });
    expect(prepared.case).toBe("D");
    expect(prepared.plan.discovery).toBe("full");
    expect(prepared.plan.verifyAll).toBe(true);
    expect(prepared.discoveryPaths).toBeNull();
    expect(toRereviewProvenance(prepared)?.case).toBe("D");
    expect(toRereviewProvenance(prepared)?.last_review_complete).toBe(true);
  });

  // Coverage for the case the force-push fix depends on: D4 had a test, E did
  // not. `commitExists: false` is the whole force-push simulation — no network,
  // no real orphaned commit, just the seam prepareDiscovery already owns.
  test("case E — L orphaned by a force-push → full B..H, verify-all", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: MISSING,
      summaryComplete: true,
      findingMarkers: [],
      git: git({
        commitExists: async () => false,
        isAncestor: async () => {
          throw new Error("a missing object must never be probed for ancestry");
        },
        nameOnly: async () => {
          throw new Error("case E must not ask git for an L..H file list");
        },
      }),
    });
    expect(prepared.case).toBe("E");
    expect(prepared.last.L).toBe(MISSING);
    expect(prepared.plan.discovery).toBe("full");
    expect(prepared.plan.verifyAll).toBe(true);
    expect(prepared.plan.emptyDeltaIsError).toBe(false);
    expect(prepared.discoveryPaths).toBeNull();
    expect(prepared.discoveryFrom).toBe(B);
    expect(
      decideLastHeadDelta({ case: prepared.case, L: prepared.last.L }),
    ).toEqual({ kind: "unreachable", sha: MISSING });
  });

  test("W-prov — a first review carries no rereview block", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: null,
      summaryComplete: true,
      findingMarkers: [],
      git: git(),
    });
    expect(toRereviewProvenance(prepared, 4)).toBeUndefined();
  });
});

describe("parseNameStatus", () => {
  // The empty string is what an unreachable L feeds Phase B instead of a diff
  // that cannot be taken: it must parse to "nothing touched", not throw.
  test("empty stdout is an empty delta, not a parse failure", () => {
    const parsed = parseNameStatus("");
    expect(parsed.files).toEqual([]);
    expect(parsed.deleted).toEqual([]);
    expect(parsed.renameMap.size).toBe(0);
  });

  test("S-revert — a deleted path is still a touched file", () => {
    const parsed = parseNameStatus("M\tsrc/a.ts\nD\tsrc/gone.ts\n");
    expect(parsed.deleted).toEqual(["src/gone.ts"]);
    expect(parsed.files).toEqual(["src/a.ts", "src/gone.ts"]);
  });

  test("renames rewrite from → to and keep both paths", () => {
    const parsed = parseNameStatus("R100\told.ts\tnew.ts\n");
    expect(parsed.renameMap.get("old.ts")).toBe("new.ts");
    expect(parsed.files).toEqual(["new.ts", "old.ts"]);
  });
});

describe("buildPhaseBQueue", () => {
  test("case C queues a touched prior and leaves an untouched one for overlap", () => {
    const { queued, overlapCandidates, settled } = buildPhaseBQueue({
      case: "C",
      priors: [
        {
          id: "R001",
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          locs: ["src/a.ts:10"],
          claim: "touched",
          triage: null,
          newThreadReply: false,
        },
        {
          id: "R002",
          sev: "WARNING",
          tier: "advisory",
          channel: "inline",
          locs: ["src/b.ts:1"],
          claim: "carried",
          triage: null,
          newThreadReply: false,
        },
      ],
      nameStatus: {
        files: ["src/a.ts"],
        deleted: [],
        renameMap: new Map(),
      },
      summaryUpdatedAt: null,
    });
    expect(queued.map((e) => `${e.priorId}:${e.trigger}`)).toEqual([
      "R001:touched",
    ]);
    expect(overlapCandidates.map((e) => e.priorId)).toEqual(["R002"]);
    expect(settled.map((s) => `${s.id}:${s.status}`)).toEqual([
      "R001:queued",
      "R002:carried",
    ]);
  });

  test("D4 — case D queues every prior as verify_all", () => {
    const { queued } = buildPhaseBQueue({
      case: "D",
      priors: [
        {
          id: "R001",
          sev: "WARNING",
          tier: "advisory",
          channel: "inline",
          locs: ["src/a.ts:10"],
          claim: "still live?",
          triage: null,
          newThreadReply: false,
        },
      ],
      nameStatus: { files: [], deleted: [], renameMap: new Map() },
      summaryUpdatedAt: null,
    });
    expect(queued.map((e) => e.trigger)).toEqual(["verify_all"]);
  });

  // Rereview-coverage fix wiring gap:
  // `planDiscovery`'s `verifyAll` field was computed but never READ by
  // production code — `classifyPrior` only forced verify_all off `ctx.case
  // === "D" || "E"`, and `decideRereviewCase` is unchanged by this fix (case
  // stays B/C), so setting `plan.verifyAll: true` for a forced-full case B/C
  // would otherwise be a no-op: the refuter-failed prior would never be
  // re-verified, which is half the defect surviving the fix. `verifyAll`
  // must now win regardless of case — mirroring exactly what D/E already do
  // — and case B's empty L===H nameStatus (nothing "touched") proves it: with
  // `verifyAll` unset the prior is merely `carried`.
  test("verifyAll forces verify_all on case B even with an empty (L===H) nameStatus", () => {
    const priors = [
      {
        id: "R001",
        sev: "CRITICAL" as const,
        tier: "blocking" as const,
        channel: "inline" as const,
        locs: ["src/a.ts:10"],
        claim: "the prior refuter never confirmed this",
        triage: null,
        newThreadReply: false,
      },
    ];
    const nameStatus = { files: [], deleted: [], renameMap: new Map() };

    const forced = buildPhaseBQueue({
      case: "B",
      priors,
      nameStatus,
      summaryUpdatedAt: null,
      verifyAll: true,
    });
    expect(forced.queued.map((e) => `${e.priorId}:${e.trigger}`)).toEqual([
      "R001:verify_all",
    ]);

    const notForced = buildPhaseBQueue({
      case: "B",
      priors,
      nameStatus,
      summaryUpdatedAt: null,
      verifyAll: false,
    });
    expect(notForced.queued).toEqual([]);
    expect(notForced.settled[0]?.status).toBe("carried");
  });
});

describe("S-B — enrichPriorsFromThreads newness", () => {
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const claim = "a live defect";

  test("a reply after summary.updated_at is new; a predating one is not", () => {
    const fingerprint = claimFingerprint(claim);
    const prior = {
      id: "R001",
      sev: "CRITICAL" as const,
      tier: "blocking" as const,
      channel: "inline" as const,
      locs: ["src/app.ts:10"],
      claim,
      triage: null,
      newThreadReply: false,
    };
    // path/line joined this fixture when the prior->comment binding stopped
    // keying on `c` alone (F001/F003). Same prior, same comment, same
    // assertions — the marker now simply carries the identity it always had.
    const posted = [
      { id: 22, marker: { path: "src/app.ts", line: 10, c: fingerprint } },
    ];
    const applied = `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n`;
    const after = enrichPriorsFromThreads({
      priors: [prior],
      posted,
      replies: [
        {
          in_reply_to_id: 22,
          body: applied,
          created_at: "2026-08-21T12:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-20T12:00:00Z",
    });
    expect(after[0]?.newThreadReply).toBe(true);
    expect(after[0]?.triage?.tag).toBe("applied");

    const before = enrichPriorsFromThreads({
      priors: [prior],
      posted,
      replies: [
        {
          in_reply_to_id: 22,
          body: applied,
          created_at: "2026-08-19T12:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-20T12:00:00Z",
    });
    expect(before[0]?.newThreadReply).toBe(false);

    const queuedAfter = buildPhaseBQueue({
      case: "B",
      priors: after,
      nameStatus: { files: [], deleted: [], renameMap: new Map() },
      summaryUpdatedAt: "2026-08-20T12:00:00Z",
    });
    expect(queuedAfter.queued.map((e) => e.trigger)).toEqual(["applied"]);

    const queuedBefore = buildPhaseBQueue({
      case: "B",
      priors: before,
      nameStatus: { files: [], deleted: [], renameMap: new Map() },
      summaryUpdatedAt: "2026-08-20T12:00:00Z",
    });
    expect(queuedBefore.queued).toEqual([]);
    expect(queuedBefore.settled[0]?.status).toBe("carried");
  });
});

describe("O-1c — collapseTargets ignore matcher leftovers", () => {
  const claim = "a live defect";

  test("carried priors produce no collapse even if a posted comment is unmatched", () => {
    expect(
      collapseTargets({
        verifiedGoneIds: [],
        priors: [{ id: "R001", claim, locs: ["src/app.ts:10"] }],
        posted: [
          {
            id: 9,
            channel: "review",
            marker: {
              path: "src/app.ts",
              line: 10,
              c: claimFingerprint(claim),
            },
          },
        ],
      }),
    ).toEqual([]);
  });

  test("verified-gone maps to the posted review comment", () => {
    expect(
      collapseTargets({
        verifiedGoneIds: ["R001"],
        priors: [{ id: "R001", claim, locs: ["src/app.ts:10"] }],
        posted: [
          {
            id: 9,
            channel: "review",
            marker: {
              path: "src/app.ts",
              line: 10,
              c: claimFingerprint(claim),
            },
          },
        ],
      }),
    ).toEqual([{ priorId: "R001", commentId: 9, channel: "review" }]);
  });
});

// ---------------------------------------------------------------------------
// F001/F002/F003 — the prior->comment binding is path:line, `c` is the
// tie-breaker it was always documented to be (`src/pr/preflight.ts:374-379`).
//
// Before this, both consumers keyed on `claimFingerprint(prior.claim)` ALONE
// and their `posted` parameter type was narrowed to `{ id, marker: { c } }`,
// so neither could reach the path and line the caller was already handing
// them. Two hats on one bug: identical claim text cross-wired two priors, and
// `priorsFromPostedMarkers`'s `claim: ""` — the path taken on the FIRST
// re-review of every PR, because a first review writes no state block — hashes
// to a constant no real marker carries, so both functions were silent no-ops
// there.
// ---------------------------------------------------------------------------

describe("F001/F003 — prior->comment binding by path:line", () => {
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const dismissed = `${triageMarker({
    tag: "dismissed",
    headSha: HEAD,
    actor: "human",
    verdict: "upheld",
  })}\n`;

  function prior(over: {
    id: string;
    locs: readonly string[];
    claim: string;
  }): PriorRecord {
    return {
      sev: "CRITICAL",
      tier: "blocking",
      channel: "inline",
      triage: null,
      newThreadReply: false,
      ...over,
    };
  }

  function comment(over: {
    id: number;
    path: string;
    line: number;
    claim: string;
    liveLine?: number;
  }) {
    return {
      id: over.id,
      channel: "review" as const,
      marker: {
        path: over.path,
        line: over.line,
        headSha: HEAD,
        c: claimFingerprint(over.claim),
      },
      livePath: over.path,
      liveLine: over.liveLine ?? over.line,
    };
  }

  test("two priors with identical claim text keep their own triage", () => {
    // The whole point: `c` is EQUAL across these two comments (same claim
    // text, different defects at different sites), so a fingerprint-only
    // lookup hands both priors the first comment — a `dismissed`+`upheld`
    // meant for R001 would suppress R002, a different and still-live finding.
    const claim = "the value is stored in seconds and read as milliseconds";
    const posted = [
      comment({ id: 111, path: "src/a.ts", line: 10, claim }),
      comment({ id: 222, path: "src/b.ts", line: 20, claim }),
    ];
    expect(posted[0]?.marker.c).toBe(posted[1]?.marker.c ?? "");

    const enriched = enrichPriorsFromThreads({
      priors: [
        prior({ id: "R001", locs: ["src/a.ts:10"], claim }),
        prior({ id: "R002", locs: ["src/b.ts:20"], claim }),
      ],
      posted,
      replies: [
        {
          in_reply_to_id: 111,
          body: dismissed,
          created_at: "2026-08-22T00:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-01T00:00:00Z",
    });
    expect(enriched.map((p) => [p.id, p.triage?.tag ?? null])).toEqual([
      ["R001", "dismissed"],
      ["R002", null],
    ]);
  });

  test("a claim-less prior recovered from posted markers still enriches", () => {
    // `priorsFromPostedMarkers` is the state === null fallback, and
    // `claimFingerprint("")` is the constant e3b0c44298fc, which no real
    // marker's `c` ever equals — so this whole path used to drop every triage
    // reply an author wrote. path:line is the identity both sides DO have.
    const priors = priorsFromPostedMarkers([
      { path: "src/a.ts", line: 10, channel: "inline", body: "" },
      { path: "src/b.ts", line: 20, channel: "inline", body: "" },
    ]);
    expect(priors.map((p) => p.claim)).toEqual(["", ""]);
    expect(claimFingerprint("")).toBe("e3b0c44298fc");

    const enriched = enrichPriorsFromThreads({
      priors,
      posted: [
        comment({ id: 111, path: "src/a.ts", line: 10, claim: "one" }),
        comment({ id: 222, path: "src/b.ts", line: 20, claim: "two" }),
      ],
      replies: [
        {
          in_reply_to_id: 222,
          body: dismissed,
          created_at: "2026-08-22T00:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-01T00:00:00Z",
    });
    expect(enriched.map((p) => [p.id, p.triage?.tag ?? null])).toEqual([
      ["R001", null],
      ["R002", "dismissed"],
    ]);
    expect(enriched[1]?.newThreadReply).toBe(true);
  });

  test("a base-driven live-line re-anchor still binds on the stored line", () => {
    // GitHub re-anchors a review comment's live `line` when the BASE advances
    // with no new push (`src/pr/inline.ts:213-219`). Marker stored at 100, live
    // projection 112, prior still at 100: zero drift, and live-only matching
    // would silently drop this author's triage.
    const enriched = enrichPriorsFromThreads({
      priors: [prior({ id: "R001", locs: ["src/c.ts:100"], claim: "drifted" })],
      posted: [
        comment({
          id: 333,
          path: "src/c.ts",
          line: 100,
          claim: "drifted",
          liveLine: 112,
        }),
      ],
      replies: [
        {
          in_reply_to_id: 333,
          body: dismissed,
          created_at: "2026-08-22T00:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-01T00:00:00Z",
    });
    expect(enriched[0]?.triage?.tag).toBe("dismissed");
  });

  test("`c` breaks a tie between two comments at the same path:line", () => {
    // Two distinct defects reported at one line: both candidates sit at
    // distance 0, so the tie-breaker does exactly the job it was named for.
    const posted = [
      comment({ id: 111, path: "src/a.ts", line: 10, claim: "defect one" }),
      comment({ id: 222, path: "src/a.ts", line: 10, claim: "defect two" }),
    ];
    const enriched = enrichPriorsFromThreads({
      priors: [
        prior({ id: "R001", locs: ["src/a.ts:10"], claim: "defect two" }),
      ],
      posted,
      replies: [
        {
          in_reply_to_id: 222,
          body: dismissed,
          created_at: "2026-08-22T00:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-01T00:00:00Z",
    });
    expect(enriched[0]?.triage?.tag).toBe("dismissed");
  });

  test("an unbreakable tie binds nothing — under-match, never over-match", () => {
    // Same path:line, same claim text, no claim on the prior to break it
    // with. Binding either one would be a guess, and the guess a ✅ on a live
    // finding. `pr/inline.ts`'s ambiguity rule, applied here.
    const enriched = enrichPriorsFromThreads({
      priors: [prior({ id: "R001", locs: ["src/a.ts:10"], claim: "" })],
      posted: [
        comment({ id: 111, path: "src/a.ts", line: 10, claim: "same" }),
        comment({ id: 222, path: "src/a.ts", line: 10, claim: "same" }),
      ],
      replies: [
        {
          in_reply_to_id: 111,
          body: dismissed,
          created_at: "2026-08-22T00:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-01T00:00:00Z",
    });
    expect(enriched[0]?.triage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #206 — a carried finding keeps its real sev/tier/claim
//
// `priorsFromPostedMarkers` runs whenever the previous summary's state block
// is unusable — including the ROUTINE case, not a rare one: a first review
// writes NO `pr-hero-state` block at all (`postInlineFindings`'s
// `framing === undefined` branch, src/pr/pr.ts, confirmed by
// `PR_CI_ADMISSION_PREFIX`'s own WHY in src/ci/review-admission.ts: "First
// reviews carry no item-7 pr-hero-state block"), so EVERY PR's second review
// takes this path. It used to hardcode sev/tier/claim; now it recovers them
// from the posted comment's own body via `parseFindingCommentBadge`.
// ---------------------------------------------------------------------------

describe("#206 — priorsFromPostedMarkers recovers from the posted comment body", () => {
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  function finding(overrides: Partial<Finding> & { id: string }): Finding {
    return {
      category: 3,
      path: "src/watch.ts",
      line: 614,
      severity: "BLOCKER",
      evidence_class: "deterministic",
      refuter_verdict: "corroborated",
      causal_disposition: "introduced",
      claim: "the retry never clears the prior timer, so two timers race",
      proof_refs: [],
      hunter: "reliability",
      tier: "blocking",
      hops_used: 1,
      hop_trail: [],
      dedupe_key: `${overrides.path ?? "src/watch.ts"}::3`,
      ...overrides,
    };
  }

  test("a posted BLOCKER comment recovers as BLOCKER/blocking with its claim", () => {
    const body = renderInlineComment(finding({ id: "F001" }), HEAD);
    const [prior] = priorsFromPostedMarkers([
      { path: "src/watch.ts", line: 614, channel: "inline", body },
    ]);
    expect(prior?.sev).toBe("BLOCKER");
    expect(prior?.tier).toBe("blocking");
    expect(prior?.claim).toBe(
      "the retry never clears the prior timer, so two timers race",
    );
  });

  test("a posted WARNING/advisory comment recovers accordingly (not just the BLOCKER path)", () => {
    const body = renderInlineComment(
      finding({
        id: "F002",
        severity: "WARNING",
        tier: "advisory",
        claim: "a minor style inconsistency",
      }),
      HEAD,
    );
    const [prior] = priorsFromPostedMarkers([
      { path: "src/watch.ts", line: 614, channel: "inline", body },
    ]);
    expect(prior?.sev).toBe("WARNING");
    expect(prior?.tier).toBe("advisory");
    expect(prior?.claim).toBe("a minor style inconsistency");
  });

  test("an unparseable body never defaults to WARNING/advisory — it is UNRECOVERABLE", () => {
    const [empty, foreign] = priorsFromPostedMarkers([
      { path: "src/a.ts", line: 1, channel: "inline", body: "" },
      {
        path: "src/b.ts",
        line: 2,
        channel: "inline",
        body: "a human's plain reply, not a pr-hero comment at all",
      },
    ]);
    for (const prior of [empty, foreign]) {
      expect(prior?.sev).toBe(SEVERITY_UNRECOVERABLE);
      expect(prior?.tier).toBe(TIER_UNRECOVERABLE);
      expect(prior?.sev).not.toBe("WARNING");
      expect(prior?.tier).not.toBe("advisory");
      expect(prior?.claim).toBe("");
    }
  });

  // The #205/#278 row shape, reproduced from a REALISTIC fixture (the badge
  // line format straight from the issue's own PR #278 evidence: "🔴 blocking
  // · BLOCKER · introduced · reliability") rather than always going through
  // today's renderer — a hand-built body is what actually sits on GitHub, and
  // the parser has to survive reading the wire format, not just its own
  // writer's output.
  test("regression — the #205/#278 row shape is no longer produced", () => {
    const realisticBody =
      `<!-- pr-hero-finding path=src%2Fwatch.ts line=614 head=${HEAD} ` +
      "c=deadbeefcafe -->\n" +
      "\n" +
      "🔴 blocking · BLOCKER · introduced · reliability\n" +
      "`src/watch.ts:614`\n" +
      "\n" +
      "the watcher retries without ever clearing the prior timer, so two " +
      "timers race\n" +
      "\n" +
      "<details><summary>Evidence (1)</summary>\n" +
      "\n" +
      "- `src/watch.ts:600`\n" +
      "\n" +
      "</details>\n";
    const [prior] = priorsFromPostedMarkers([
      {
        path: "src/watch.ts",
        line: 614,
        channel: "inline",
        body: realisticBody,
      },
    ]);
    // The buggy shape PR #205/#278 actually posted:
    // {"sev":"WARNING","tier":"advisory","c":"e3b0c44298fc","claim":""}
    expect(prior?.sev).not.toBe("WARNING");
    expect(prior?.tier).not.toBe("advisory");
    expect(prior?.claim).not.toBe("");
    expect(prior?.sev).toBe("BLOCKER");
    expect(prior?.tier).toBe("blocking");
    expect(prior?.claim).toBe(
      "the watcher retries without ever clearing the prior timer, so two " +
        "timers race",
    );
  });
});

describe("F002 — collapseTargets gives each verified-gone id its own thread", () => {
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  function comment(id: number, path: string, line: number, claim: string) {
    return {
      id,
      channel: "review" as const,
      marker: { path, line, headSha: HEAD, c: claimFingerprint(claim) },
      livePath: path,
      liveLine: line,
    };
  }

  test("a batch of claim-less priors collapses each to its own comment", () => {
    // The guaranteed-reachable shape from the review: every prior recovered
    // by `priorsFromPostedMarkers` carries `claim: ""`, so the old
    // fingerprint-only `.find()` returned the SAME first comment for every id
    // in the batch — a "✅ RESOLVED · verified gone" reply and a programmatic
    // thread-resolve landing on a finding nobody checked.
    const priors = priorsFromPostedMarkers([
      { path: "src/a.ts", line: 10, channel: "inline", body: "" },
      { path: "src/b.ts", line: 20, channel: "inline", body: "" },
      { path: "src/c.ts", line: 30, channel: "inline", body: "" },
    ]);
    expect(
      collapseTargets({
        verifiedGoneIds: ["R001", "R002", "R003"],
        priors,
        posted: [
          comment(111, "src/a.ts", 10, "one"),
          comment(222, "src/b.ts", 20, "two"),
          comment(333, "src/c.ts", 30, "three"),
        ],
      }),
    ).toEqual([
      { priorId: "R001", commentId: 111, channel: "review" },
      { priorId: "R002", commentId: 222, channel: "review" },
      { priorId: "R003", commentId: 333, channel: "review" },
    ]);
  });

  test("priors sharing claim text collapse to their own threads, not the first", () => {
    const claim = "a recurring pattern, reported at two sites";
    expect(
      collapseTargets({
        verifiedGoneIds: ["R001", "R002"],
        priors: [
          { id: "R001", claim, locs: ["src/a.ts:10"] },
          { id: "R002", claim, locs: ["src/b.ts:20"] },
        ],
        posted: [
          comment(111, "src/a.ts", 10, claim),
          comment(222, "src/b.ts", 20, claim),
        ],
      }),
    ).toEqual([
      { priorId: "R001", commentId: 111, channel: "review" },
      { priorId: "R002", commentId: 222, channel: "review" },
    ]);
  });

  test("a carried neighbour's thread is never taken by a verified-gone prior", () => {
    // One-to-one runs over EVERY prior, not just the retired ones: R002 is
    // carried and still live, and its comment sits within the line window of
    // R001's. Binding only the verified-gone subset would hand R001 whichever
    // comment came first and close a live finding's thread.
    expect(
      collapseTargets({
        verifiedGoneIds: ["R002"],
        priors: [
          { id: "R001", claim: "still live", locs: ["src/a.ts:10"] },
          { id: "R002", claim: "gone now", locs: ["src/a.ts:12"] },
        ],
        posted: [
          comment(111, "src/a.ts", 10, "still live"),
          comment(222, "src/a.ts", 12, "gone now"),
        ],
      }),
    ).toEqual([{ priorId: "R002", commentId: 222, channel: "review" }]);
  });
});

// ---------------------------------------------------------------------------
// F006 — the prior->comment assignment does not depend on `priors` order.
//
// The binder used to walk `priors` in plain array order, each one taking its
// nearest not-yet-consumed comment. When two priors' rankings cross over, the
// prior that happens to come FIRST wins a comment the other one needed and
// the second is pushed onto a farther one, or off the end entirely — two
// orderings of the same PR state producing two different sets of collapsed
// threads. `priors` order is whatever the state block happened to serialise,
// so this was a coin flip deciding where a "✅ RESOLVED · verified gone" reply
// lands.
// ---------------------------------------------------------------------------

describe("F006 — binding is global by distance, never by priors order", () => {
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  function comment(id: number, path: string, line: number, claim: string) {
    return {
      id,
      channel: "review" as const,
      marker: { path, line, headSha: HEAD, c: claimFingerprint(claim) },
      livePath: path,
      liveLine: line,
    };
  }

  // The crossover, drawn out:
  //   X = src/a.ts:10, Y = src/b.ts:40
  //   R002 spans both files — X at distance 0, Y at distance 1
  //   R001 has ONE loc, src/a.ts:11 — X at distance 1, and nothing else in
  //        window (Y is on a path R001 never mentions)
  // Nearest-first has exactly one answer: R002 takes X (0), and R001, whose
  // only candidate is now gone, binds nothing. Array order used to answer
  // "R001 takes X, R002 takes Y" whenever R001 came first.
  const X = comment(111, "src/a.ts", 10, "the X defect");
  const Y = comment(222, "src/b.ts", 40, "the Y defect");
  const R001 = {
    id: "R001",
    claim: "a prior whose only near comment is X",
    locs: ["src/a.ts:11"],
  };
  const R002 = {
    id: "R002",
    claim: "a prior anchored at X, with a second site near Y",
    locs: ["src/a.ts:10", "src/b.ts:41"],
  };

  test("the nearer prior wins the contested comment, whichever order it arrives in", () => {
    const forward = bindPriorsToPosted([R001, R002], [X, Y]);
    expect([...forward].map(([id, row]) => [id, row.id])).toEqual([
      ["R002", 111],
    ]);
    const reversed = bindPriorsToPosted([R002, R001], [X, Y]);
    expect([...reversed].map(([id, row]) => [id, row.id])).toEqual([
      ["R002", 111],
    ]);
  });

  test("reversing the posted comments changes nothing either", () => {
    const swapped = bindPriorsToPosted([R001, R002], [Y, X]);
    expect([...swapped].map(([id, row]) => [id, row.id])).toEqual([
      ["R002", 111],
    ]);
  });

  test("collapse follows the same assignment — R001's thread is never closed for it", () => {
    // The consequence, at the surface that posts the ✅: with R002 verified
    // gone, the reply must land on 111 and R001's own comment must stay
    // untouched — in BOTH orders.
    for (const priors of [
      [R001, R002],
      [R002, R001],
    ]) {
      expect(
        collapseTargets({
          verifiedGoneIds: ["R002"],
          priors,
          posted: [X, Y],
        }),
      ).toEqual([{ priorId: "R002", commentId: 111, channel: "review" }]);
    }
  });

  test("an equidistant contest over one comment binds nobody to it", () => {
    // The mirror of the prior-side ambiguity rule, and the case array order
    // used to settle by position: two priors, same distance, same comment,
    // and claims that cannot break it (neither fingerprint matches). Nobody
    // gets it — under-match, never a guess.
    const contested = comment(333, "src/c.ts", 50, "the real claim");
    const bound = bindPriorsToPosted(
      [
        { id: "R001", claim: "", locs: ["src/c.ts:50"] },
        { id: "R002", claim: "", locs: ["src/c.ts:50"] },
      ],
      [contested],
    );
    expect([...bound]).toEqual([]);
  });

  test("`c` still decides an equidistant contest when exactly one prior matches", () => {
    const claim = "the claim the comment was posted with";
    const contested = comment(444, "src/c.ts", 50, claim);
    const bound = bindPriorsToPosted(
      [
        {
          id: "R001",
          claim: "some other wording entirely",
          locs: ["src/c.ts:50"],
        },
        { id: "R002", claim, locs: ["src/c.ts:50"] },
      ],
      [contested],
    );
    expect([...bound].map(([id, row]) => [id, row.id])).toEqual([
      ["R002", 444],
    ]);
  });
});

// ---------------------------------------------------------------------------
// F007 — `readRereviewProvenance`: valid, absent, or LOUD.
//
// `post --from` has no pipeline in memory, so pipeline.json's `rereview` block
// is the only surviving record of what a re-review checked. A block that
// half-parses is worse than none: the delta silently falls back to the
// absence matcher it was built to retire.
// ---------------------------------------------------------------------------

describe("F007 — readRereviewProvenance", () => {
  const liveRow: LiveFinding = {
    id: "R001",
    sev: "CRITICAL",
    tier: "blocking",
    channel: "inline",
    status: "carried",
    locs: ["src/a.ts:10"],
    c: claimFingerprint("a claim"),
    claim: "a claim",
  };

  function block(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      case: "C",
      last_reviewed_head: L,
      last_head_source: "summary_marker",
      discovery_range: `${L}..${H}`,
      discovery_restricted: true,
      discovery_skipped_empty_delta: false,
      prior_findings: 1,
      settled_deterministically: 1,
      verified: 0,
      verification_capped: 0,
      verification_triggers: {
        applied: 0,
        touched: 0,
        overlap: 0,
        verify_all: 0,
      },
      live: [liveRow],
      ...over,
    };
  }

  test("a pipeline.json with no rereview block is absent, not invalid", () => {
    expect(readRereviewProvenance({ steps: [] })).toEqual({ kind: "absent" });
  });

  test("materiality_released_ids reads back, and stays absent when the block has none", () => {
    const withIds = readRereviewProvenance({
      rereview: block({ materiality_released_ids: ["R001"] }),
    });
    expect(
      withIds.kind === "ok" && withIds.rereview.materiality_released_ids,
    ).toEqual(["R001"]);
    const without = readRereviewProvenance({ rereview: block() });
    expect(
      without.kind === "ok" && "materiality_released_ids" in without.rereview,
    ).toBe(false);
  });

  test("a materiality_released_ids that is not a list of strings is invalid", () => {
    expect(
      readRereviewProvenance({
        rereview: block({ materiality_released_ids: [1] }),
      }),
    ).toEqual({
      kind: "invalid",
      problem: "rereview.materiality_released_ids",
    });
  });

  test("a complete block parses, and the optional counters default to zero", () => {
    const read = readRereviewProvenance({ rereview: block() });
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.rereview.case).toBe("C");
    expect(read.rereview.live).toEqual([liveRow]);
    expect(read.rereview.resolved_verified).toBe(0);
    expect(read.rereview.resolved_ids).toEqual([]);
  });

  // `last_review_complete` is OPTIONAL on read (rereview-coverage fix): an
  // artifact written before this fix has no such field at all, and it must
  // still parse — never `invalid` — defaulting to `true` (the pre-fix world
  // had no notion of a forced-full re-review, so "complete" is the accurate
  // back-compat reading, not a guess).
  test("an old artifact with no last_review_complete field still parses, defaulting true", () => {
    const read = readRereviewProvenance({ rereview: block() });
    expect(read.kind).toBe("ok");
    expect(read.kind === "ok" && read.rereview.last_review_complete).toBe(true);
  });

  test("last_review_complete: false survives the read verbatim", () => {
    const read = readRereviewProvenance({
      rereview: block({ last_review_complete: false }),
    });
    expect(read.kind === "ok" && read.rereview.last_review_complete).toBe(
      false,
    );
  });

  test("a non-boolean last_review_complete is invalid, naming the field", () => {
    expect(
      readRereviewProvenance({
        rereview: block({ last_review_complete: "no" }),
      }),
    ).toEqual({ kind: "invalid", problem: "rereview.last_review_complete" });
  });

  test("resolved_ids survives the read — collapse is decided from it", () => {
    const read = readRereviewProvenance({
      rereview: block({ resolved_verified: 2, resolved_ids: ["R004", "R005"] }),
    });
    expect(read.kind === "ok" && read.rereview.resolved_ids).toEqual([
      "R004",
      "R005",
    ]);
  });

  test("an unknown case is invalid, naming the field", () => {
    expect(readRereviewProvenance({ rereview: block({ case: "Z" }) })).toEqual({
      kind: "invalid",
      problem: "rereview.case",
    });
  });

  test("a live row missing its claim fingerprint is invalid, naming the row", () => {
    const { c: _dropped, ...noFingerprint } = liveRow;
    expect(
      readRereviewProvenance({ rereview: block({ live: [noFingerprint] }) }),
    ).toEqual({ kind: "invalid", problem: "rereview.live[0]" });
  });

  test("a live row with a status outside the live vocabulary is invalid", () => {
    // `verified-gone` retires an entry; it is never a live status, and a row
    // carrying one would render a retired finding as still on the PR.
    expect(
      readRereviewProvenance({
        rereview: block({ live: [{ ...liveRow, status: "verified-gone" }] }),
      }),
    ).toEqual({ kind: "invalid", problem: "rereview.live[0]" });
  });

  test("a well-formed `worsened` survives the read — W-worse needs both severities", () => {
    // `liveFindingLines` renders "returned R001: WARNING → CRITICAL" from
    // this and nothing else; dropping it would publish a summary naming one
    // severity where the run found two.
    const worsened = [
      {
        priorId: "R001",
        priorSev: "WARNING" as const,
        discoverySev: "CRITICAL" as const,
      },
    ];
    const read = readRereviewProvenance({ rereview: block({ worsened }) });
    expect(read.kind === "ok" && read.rereview.worsened).toEqual(worsened);
  });

  test("a `worsened` row with an unknown severity is invalid, naming the row", () => {
    expect(
      readRereviewProvenance({
        rereview: block({
          worsened: [
            { priorId: "R001", priorSev: "WARNING", discoverySev: "FATAL" },
          ],
        }),
      }),
    ).toEqual({ kind: "invalid", problem: "rereview.worsened[0]" });
  });

  test("a missing verification trigger is invalid, naming the trigger", () => {
    expect(
      readRereviewProvenance({
        rereview: block({
          verification_triggers: { applied: 0, touched: 0, overlap: 0 },
        }),
      }),
    ).toEqual({
      kind: "invalid",
      problem: "rereview.verification_triggers.verify_all",
    });
  });

  // pr-hero review #286: `discovery_skip_reason` / `discovery_excluded_paths`
  // disambiguate WHY discovery came up empty — added AFTER `discovery_skipped_
  // empty_delta` shipped, so every artifact written before this fix has
  // neither field. Same "optional on the TYPE, defaults on READ" contract as
  // `last_review_complete` and `worsened` above: absent must still parse, not
  // fail LOUD.
  test("old provenance with no discovery_skip_reason field still parses", () => {
    const read = readRereviewProvenance({ rereview: block() });
    expect(read.kind).toBe("ok");
    expect(
      read.kind === "ok" && read.rereview.discovery_skip_reason,
    ).toBeUndefined();
    expect(
      read.kind === "ok" && read.rereview.discovery_excluded_paths,
    ).toBeUndefined();
  });

  test("discovery_skip_reason and discovery_excluded_paths survive the read verbatim", () => {
    const read = readRereviewProvenance({
      rereview: block({
        discovery_skip_reason: "all_excluded",
        discovery_excluded_paths: ["dist/bundle.js"],
      }),
    });
    expect(read.kind === "ok" && read.rereview.discovery_skip_reason).toBe(
      "all_excluded",
    );
    expect(
      read.kind === "ok" && read.rereview.discovery_excluded_paths,
    ).toEqual(["dist/bundle.js"]);
  });

  test("an unknown discovery_skip_reason is invalid, naming the field", () => {
    expect(
      readRereviewProvenance({
        rereview: block({ discovery_skip_reason: "everything_is_fine" }),
      }),
    ).toEqual({
      kind: "invalid",
      problem: "rereview.discovery_skip_reason",
    });
  });

  test("a non-array discovery_excluded_paths is invalid, naming the field", () => {
    expect(
      readRereviewProvenance({
        rereview: block({ discovery_excluded_paths: "dist/bundle.js" }),
      }),
    ).toEqual({
      kind: "invalid",
      problem: "rereview.discovery_excluded_paths",
    });
  });
});

describe("binding keeps working when the stored claim was sanitized", () => {
  const HEAD = "b".repeat(40);
  const TOKEN = `ghp_${"a".repeat(36)}`;
  function comment(id: number, claim: string) {
    return {
      id,
      marker: { path: "src/a.ts", line: 10, c: claimFingerprint(claim) },
    };
  }

  test("a state row breaks a same-line tie with its stored fingerprint", () => {
    const raw = `leaks ${TOKEN}`;
    const other = "a different finding";
    const rows = parseStateBlock(
      renderStateBlock(
        HEAD,
        [raw, other].map((claim, i) =>
          stateFinding({
            id: `R00${i + 1}`,
            sev: "WARNING",
            tier: "advisory",
            channel: "inline",
            locs: ["src/a.ts:10"],
            claim,
          }),
        ),
        1,
        2,
      ),
    )?.findings;
    const bound = bindPriorsToPosted(priorsFromStateFindings(rows ?? []), [
      comment(1, raw),
      comment(2, other),
    ]);
    expect(bound.get("R001")?.id).toBe(1);
    expect(bound.get("R002")?.id).toBe(2);
  });

  test("a prior recovered from its comment breaks the tie with that comment's marker", () => {
    const claims = ["needs <T> at @scope", "a different finding"];
    const posted = claims.map((claim, i) => ({
      ...comment(i + 1, claim),
      body: renderInlineComment(
        {
          id: `F00${i + 1}`,
          path: "src/a.ts",
          line: 10,
          severity: "WARNING",
          tier: "advisory",
          claim,
          proof_refs: [],
          hunter: "x",
          refuter_verdict: "not_submitted",
          causal_disposition: "introduced",
        } as never,
        HEAD,
      ),
    }));
    const priors = priorsFromPostedMarkers(
      posted.map((p) => ({
        path: "src/a.ts",
        line: 10,
        channel: "inline" as const,
        body: p.body,
      })),
    );
    const bound = bindPriorsToPosted(priors, posted);
    expect(bound.get("R001")?.id).toBe(1);
    expect(bound.get("R002")?.id).toBe(2);
  });

  test("a carried row keeps the raw fingerprint", () => {
    const raw = `leaks ${TOKEN}`;
    const row = stateFinding({
      id: "R001",
      sev: "WARNING",
      tier: "advisory",
      channel: "inline",
      locs: ["src/a.ts:10"],
      claim: raw,
    });
    const stored = parseStateBlock(
      renderStateBlock(HEAD, [row], 1, 1),
    )?.findings;
    const priors = priorsFromStateFindings(stored ?? []);
    const { live } = assembleLive({
      settled: [
        { id: "R001", status: "carried", locs: ["src/a.ts:10"] },
      ] as never,
      priors,
      verifyVerdicts: new Map(),
    });
    expect(live[0]?.c).toBe(claimFingerprint(raw));
  });
});
