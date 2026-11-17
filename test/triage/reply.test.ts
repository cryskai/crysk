// Pure-decision tests for triage-reply parent matching and resolve
// decisions (W1 / issues #20 #21 #22). Offline, no gh.

import { describe, expect, test } from "bun:test";
import type { PostedFindingComment } from "#pr/inline";
import {
  claimFingerprint,
  findingMarker,
  parseFindingMarker,
} from "#pr/preflight";
import {
  countedTriageReplies,
  decideThreadResolve,
  findingAnswered,
  findingIdentityForMarkerMatch,
  matchPostedFindingExact,
  replyAnswersReview,
  replyHeadAnswers,
} from "#triage/reply";
import { triageMarker } from "#triage/triage";

const HEAD = "c".repeat(40);
const OTHER_HEAD = "d".repeat(40);
const CLAIM_A = "the latch never resets on unmount";
const CLAIM_B = "the queue has no backoff cap";

function posted(input: {
  id: number;
  path: string;
  line: number;
  claim: string;
  headSha?: string;
  channel?: "review" | "issue";
  liveLine?: number;
}): PostedFindingComment {
  const headSha = input.headSha ?? HEAD;
  const body = findingMarker({
    path: input.path,
    line: input.line,
    headSha,
    claim: input.claim,
  });
  const marker = parseFindingMarker(body);
  if (marker === null) throw new Error("test fixture marker failed to parse");
  return {
    id: input.id,
    channel: input.channel ?? "review",
    marker,
    livePath: input.path,
    liveLine: input.liveLine,
  };
}

describe("findingIdentityForMarkerMatch", () => {
  function diffHunkAt(path: string, start: number, count: number): string {
    const body = Array.from(
      { length: count },
      (_, i) => `+line ${start + i}`,
    ).join("\n");
    return (
      `diff --git a/${path} b/${path}\n` +
      `index 0000000..1111111 100644\n` +
      `--- a/${path}\n` +
      `+++ b/${path}\n` +
      `@@ -0,0 +${start},${count} @@\n` +
      `${body}\n`
    );
  }

  test("remaps to the post line when findings.json cites off-hunk but proof_refs do not", () => {
    const path = "src/a.ts";
    const diffPatch = diffHunkAt(path, 27, 5);
    const result = findingIdentityForMarkerMatch({
      path,
      line: 19,
      claim: CLAIM_A,
      proof_refs: [`${path}:27`],
      diffPatch,
    });
    expect(result.findingsLine).toBe(19);
    expect(result.identity.line).toBe(27);
  });

  test("keeps findings.json line when it already sits in the hunk", () => {
    const path = "docs/runbook.md";
    const diffPatch = diffHunkAt(path, 140, 10);
    const result = findingIdentityForMarkerMatch({
      path,
      line: 144,
      claim: CLAIM_A,
      diffPatch,
    });
    expect(result.identity.line).toBe(144);
    expect(result.findingsLine).toBe(144);
  });
});

describe("matchPostedFindingExact", () => {
  const finding = { path: "docs/runbook.md", line: 144, claim: CLAIM_A };

  test("matches the pr-hero marker, ignoring a sibling at the same live line", () => {
    // 1724 shape: Greptile is NOT in `posted` (fetchPostedFindingComments
    // drops non-markers), but another pr-hero finding CAN sit nearby. The
    // matcher must not use liveLine, or a drifted sibling steals the parent.
    const result = matchPostedFindingExact({
      finding,
      headSha: HEAD,
      posted: [
        posted({
          id: 11,
          path: "docs/runbook.md",
          line: 140,
          claim: CLAIM_B,
          liveLine: 144,
        }),
        posted({
          id: 22,
          path: "docs/runbook.md",
          line: 144,
          claim: CLAIM_A,
          liveLine: 200,
        }),
      ],
    });
    expect(result).toEqual({
      kind: "matched",
      posted: expect.objectContaining({ id: 22 }),
    });
  });

  test("does not match on path+line alone when the claim fingerprint differs", () => {
    const result = matchPostedFindingExact({
      finding,
      headSha: HEAD,
      posted: [
        posted({
          id: 11,
          path: "docs/runbook.md",
          line: 144,
          claim: CLAIM_B,
        }),
      ],
    });
    expect(result).toEqual({ kind: "none" });
    expect(claimFingerprint(CLAIM_A)).not.toBe(claimFingerprint(CLAIM_B));
  });

  test("does not match a different head", () => {
    const result = matchPostedFindingExact({
      finding,
      headSha: HEAD,
      posted: [
        posted({
          id: 22,
          path: "docs/runbook.md",
          line: 144,
          claim: CLAIM_A,
          headSha: OTHER_HEAD,
        }),
      ],
    });
    expect(result).toEqual({ kind: "none" });
  });

  test("ambiguous when two posted comments share the fingerprint", () => {
    const result = matchPostedFindingExact({
      finding,
      headSha: HEAD,
      posted: [
        posted({
          id: 22,
          path: "docs/runbook.md",
          line: 144,
          claim: CLAIM_A,
        }),
        posted({
          id: 99,
          path: "docs/runbook.md",
          line: 144,
          claim: CLAIM_A,
        }),
      ],
    });
    expect(result).toEqual({ kind: "ambiguous", ids: [22, 99] });
  });
});

describe("decideThreadResolve", () => {
  test("resolves an inline applied reply", () => {
    expect(decideThreadResolve({ channel: "review" })).toBe("resolve");
  });

  test("skips issue-comment findings (no review thread)", () => {
    expect(decideThreadResolve({ channel: "issue" })).toBe(
      "skip-issue-channel",
    );
  });

  test("leaves inconclusive threads open", () => {
    expect(
      decideThreadResolve({ channel: "review", verdict: "inconclusive" }),
    ).toBe("skip-inconclusive");
  });

  test("resolves dismissed/deferred when the adjudicator settled", () => {
    expect(decideThreadResolve({ channel: "review", verdict: "upheld" })).toBe(
      "resolve",
    );
    expect(
      decideThreadResolve({ channel: "review", verdict: "rejected" }),
    ).toBe("resolve");
  });
});

describe("replyAnswersReview", () => {
  const POSTED = "a".repeat(40);
  const REVIEWED = "b".repeat(40);
  const OTHER = "c".repeat(40);
  const VERDICT = Date.parse("2026-10-30T10:00:00Z");
  const BEFORE = "2026-10-30T09:00:00Z";
  const AFTER = "2026-10-30T11:00:00Z";

  test("a reply at the reviewed head answers a finding posted on that head", () => {
    expect(
      replyAnswersReview({
        replyHead: REVIEWED,
        replyCreatedAt: BEFORE,
        findingHead: REVIEWED,
        reviewedHead: REVIEWED,
        verdictAt: VERDICT,
      }),
    ).toBe(true);
  });

  test("a reply at the reviewed head answers a finding carried from an older head", () => {
    expect(
      replyAnswersReview({
        replyHead: REVIEWED,
        replyCreatedAt: BEFORE,
        findingHead: POSTED,
        reviewedHead: REVIEWED,
        verdictAt: VERDICT,
      }),
    ).toBe(true);
  });

  test("a reply at the posted head, created after the verdict, answers a carried finding", () => {
    expect(
      replyAnswersReview({
        replyHead: POSTED,
        replyCreatedAt: AFTER,
        findingHead: POSTED,
        reviewedHead: REVIEWED,
        verdictAt: VERDICT,
      }),
    ).toBe(true);
  });

  test("a reply at the posted head, created before the verdict, does not answer a carried finding", () => {
    expect(
      replyAnswersReview({
        replyHead: POSTED,
        replyCreatedAt: BEFORE,
        findingHead: POSTED,
        reviewedHead: REVIEWED,
        verdictAt: VERDICT,
      }),
    ).toBe(false);
  });

  test("a posted-head reply with an unknown time or an unknown verdict time fails closed", () => {
    expect(
      replyAnswersReview({
        replyHead: POSTED,
        replyCreatedAt: undefined,
        findingHead: POSTED,
        reviewedHead: REVIEWED,
        verdictAt: VERDICT,
      }),
    ).toBe(false);
    expect(
      replyAnswersReview({
        replyHead: POSTED,
        replyCreatedAt: AFTER,
        findingHead: POSTED,
        reviewedHead: REVIEWED,
        verdictAt: null,
      }),
    ).toBe(false);
  });

  test("a reply at the posted head answers it when the pull request has no summary", () => {
    expect(
      replyAnswersReview({
        replyHead: POSTED,
        replyCreatedAt: BEFORE,
        findingHead: POSTED,
        reviewedHead: null,
        verdictAt: null,
      }),
    ).toBe(true);
  });

  test("a reply at a head that is neither the posted nor the reviewed one never answers", () => {
    for (const reviewedHead of [REVIEWED, null]) {
      expect(
        replyAnswersReview({
          replyHead: OTHER,
          replyCreatedAt: AFTER,
          findingHead: POSTED,
          reviewedHead,
          verdictAt: VERDICT,
        }),
      ).toBe(false);
    }
  });
});

describe("countedTriageReplies", () => {
  const WRITER_LOGIN = "dev";
  const READER_LOGIN = "visitor";
  const VERDICT = Date.parse("2026-11-10T12:00:00Z");
  const BEFORE = "2026-11-10T11:00:00Z";
  const AFTER = "2026-11-10T13:00:00Z";
  const writers = new Map<string, boolean | null>([
    [WRITER_LOGIN, true],
    [READER_LOGIN, false],
  ]);
  const reply = (
    id: number,
    user: string | undefined,
    head: string,
    created_at?: string,
  ) => ({
    id,
    user,
    created_at,
    body: `${triageMarker({ tag: "applied", headSha: head, actor: "agent" })}\n\nreasoning`,
  });
  const plain = { id: 1, user: "someone", body: "a comment" };

  test("keeps a comment that is not a triage reply", () => {
    const result = countedTriageReplies({
      comments: [plain],
      writers: new Map(),
      reviewedHead: HEAD,
      verdictAt: VERDICT,
    });
    expect(result).toEqual({ kept: [plain], uncounted: [] });
  });

  test("keeps a reply from a login with write access", () => {
    const kept = reply(2, WRITER_LOGIN, HEAD, AFTER);
    const result = countedTriageReplies({
      comments: [kept],
      writers,
      reviewedHead: HEAD,
      verdictAt: VERDICT,
    });
    expect(result).toEqual({ kept: [kept], uncounted: [] });
  });

  test("drops a reply from a login without write access and names it once", () => {
    const result = countedTriageReplies({
      comments: [
        reply(2, READER_LOGIN, HEAD, AFTER),
        reply(3, READER_LOGIN, HEAD, AFTER),
      ],
      writers,
      reviewedHead: HEAD,
      verdictAt: VERDICT,
    });
    expect(result).toEqual({ kept: [], uncounted: [READER_LOGIN] });
  });

  test("an author whose permission did not read fails the whole read", () => {
    const result = countedTriageReplies({
      comments: [reply(2, "unread", HEAD, AFTER)],
      writers: new Map<string, boolean | null>([["unread", null]]),
      reviewedHead: HEAD,
      verdictAt: VERDICT,
    });
    expect(result).toBeNull();
  });

  test("an author missing from the map fails the whole read", () => {
    const result = countedTriageReplies({
      comments: [reply(2, "missing", HEAD, AFTER)],
      writers,
      reviewedHead: HEAD,
      verdictAt: VERDICT,
    });
    expect(result).toBeNull();
  });

  test("drops a stale reply at an older head, created before the verdict, without naming it", () => {
    const result = countedTriageReplies({
      comments: [reply(2, READER_LOGIN, OTHER_HEAD, BEFORE)],
      writers,
      reviewedHead: HEAD,
      verdictAt: VERDICT,
    });
    expect(result).toEqual({ kept: [], uncounted: [] });
  });

  test("keeps a reply stamped with the reviewed head even when it predates the verdict", () => {
    const kept = reply(2, WRITER_LOGIN, HEAD, BEFORE);
    const result = countedTriageReplies({
      comments: [kept],
      writers,
      reviewedHead: HEAD,
      verdictAt: VERDICT,
    });
    expect(result).toEqual({ kept: [kept], uncounted: [] });
  });

  test("with no summary no reply is stale, so an older-head reply is kept", () => {
    const kept = reply(2, WRITER_LOGIN, OTHER_HEAD, BEFORE);
    const result = countedTriageReplies({
      comments: [kept],
      writers,
      reviewedHead: null,
      verdictAt: VERDICT,
    });
    expect(result).toEqual({ kept: [kept], uncounted: [] });
  });

  // A stale reply is not an answer, so its author is never asked for a permission: an unread
  // permission on it must not turn the whole read into null.
  test("a stale reply is dropped before its author is asked", () => {
    const stale = reply(2, "ghost", OTHER_HEAD, BEFORE);
    const absent = countedTriageReplies({
      comments: [stale],
      writers: new Map(),
      reviewedHead: HEAD,
      verdictAt: VERDICT,
    });
    expect(absent).not.toBeNull();
    expect(absent?.kept).toEqual([]);
    expect(absent?.uncounted).toEqual([]);

    const unread = countedTriageReplies({
      comments: [stale],
      writers: new Map<string, boolean | null>([["ghost", null]]),
      reviewedHead: HEAD,
      verdictAt: VERDICT,
    });
    expect(unread).not.toBeNull();
    expect(unread?.kept).toEqual([]);
    expect(unread?.uncounted).toEqual([]);
  });

  // WHY the boundary is exact: a reply made at the verdict's own instant was not written after the
  // verdict, so the review that wrote the verdict could not have seen it.
  test("a reply created at the verdict's own instant is stale, one second later is kept", () => {
    const VERDICT_ISO = "2026-11-10T12:00:00Z";
    const atVerdict = reply(2, WRITER_LOGIN, OTHER_HEAD, VERDICT_ISO);
    const droppedAtVerdict = countedTriageReplies({
      comments: [atVerdict],
      writers,
      reviewedHead: HEAD,
      verdictAt: Date.parse(VERDICT_ISO),
    });
    expect(droppedAtVerdict).toEqual({ kept: [], uncounted: [] });

    const later = reply(3, WRITER_LOGIN, OTHER_HEAD, "2026-11-10T12:00:01Z");
    const keptLater = countedTriageReplies({
      comments: [later],
      writers,
      reviewedHead: HEAD,
      verdictAt: Date.parse(VERDICT_ISO),
    });
    expect(keptLater).toEqual({ kept: [later], uncounted: [] });
  });
});

describe("replyHeadAnswers", () => {
  test("a reply at the reviewed head answers the review", () => {
    expect(
      replyHeadAnswers({
        findingHead: OTHER_HEAD,
        replyHead: HEAD,
        reviewedHead: HEAD,
      }),
    ).toBe(true);
  });

  test("a reply at the finding's own head answers a carried finding", () => {
    expect(
      replyHeadAnswers({
        findingHead: OTHER_HEAD,
        replyHead: OTHER_HEAD,
        reviewedHead: HEAD,
      }),
    ).toBe(true);
  });

  test("a reply at a foreign head does not answer", () => {
    expect(
      replyHeadAnswers({
        findingHead: OTHER_HEAD,
        replyHead: "e".repeat(40),
        reviewedHead: HEAD,
      }),
    ).toBe(false);
  });

  test("a row (no finding head) is answered only at the reviewed head", () => {
    expect(
      replyHeadAnswers({
        findingHead: null,
        replyHead: HEAD,
        reviewedHead: HEAD,
      }),
    ).toBe(true);
    expect(
      replyHeadAnswers({
        findingHead: null,
        replyHead: OTHER_HEAD,
        reviewedHead: HEAD,
      }),
    ).toBe(false);
  });

  test("with no reviewed head, a reply at the finding's own head still answers", () => {
    expect(
      replyHeadAnswers({
        findingHead: HEAD,
        replyHead: HEAD,
        reviewedHead: null,
      }),
    ).toBe(true);
  });
});

describe("findingAnswered", () => {
  const finding = (
    tag: string | null,
    ci_verdict: string | null,
    head = HEAD,
    replyHead = HEAD,
  ) => ({
    head,
    triage: tag === null ? null : { tag, head: replyHead },
    ci_verdict,
  });

  test("an applied reply at the reviewed head answers", () => {
    expect(findingAnswered(finding("applied", null), HEAD)).toBe(true);
  });

  test("a dismissal the CI adjudicator upheld answers", () => {
    expect(findingAnswered(finding("dismissed", "upheld"), HEAD)).toBe(true);
  });

  test("a dismissal with no ruling does not answer", () => {
    expect(findingAnswered(finding("dismissed", null), HEAD)).toBe(false);
  });

  test("a deferred reply does not answer", () => {
    expect(findingAnswered(finding("deferred", null), HEAD)).toBe(false);
  });

  test("no triage reply does not answer", () => {
    expect(findingAnswered(finding(null, null), HEAD)).toBe(false);
  });

  test("an applied reply at a foreign head does not answer", () => {
    expect(
      findingAnswered(finding("applied", null, HEAD, OTHER_HEAD), HEAD),
    ).toBe(false);
  });
});
