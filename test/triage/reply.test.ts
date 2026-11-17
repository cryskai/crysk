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
  decideThreadResolve,
  existingRowTriageAtHead,
  existingTriageAtHead,
  findingIdentityForMarkerMatch,
  matchPostedFindingExact,
  replyAnswersReview,
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

describe("existingTriageAtHead", () => {
  test("detects a same-head triage reply on the parent", () => {
    expect(
      existingTriageAtHead({
        parentId: 22,
        headSha: HEAD,
        replies: [
          {
            in_reply_to_id: 22,
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\nok`,
          },
        ],
      }),
    ).toBe(true);
  });

  test("a different head is not a skip", () => {
    expect(
      existingTriageAtHead({
        parentId: 22,
        headSha: HEAD,
        replies: [
          {
            in_reply_to_id: 22,
            body: `${triageMarker({ tag: "applied", headSha: OTHER_HEAD, actor: "agent" })}\nok`,
          },
        ],
      }),
    ).toBe(false);
  });

  test("a reply to a different parent is not a skip", () => {
    expect(
      existingTriageAtHead({
        parentId: 22,
        headSha: HEAD,
        replies: [
          {
            in_reply_to_id: 11,
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\nok`,
          },
        ],
      }),
    ).toBe(false);
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

describe("existingRowTriageAtHead", () => {
  const rowReply = (row: string, headSha: string) => ({
    body: `${triageMarker({ tag: "applied", headSha, actor: "agent", row })}\n\nok`,
  });

  test("detects a same-head reply that names the row", () => {
    expect(
      existingRowTriageAtHead({
        rowId: "R001",
        headSha: HEAD,
        comments: [rowReply("R001", HEAD)],
      }),
    ).toBe(true);
  });

  test("the same row at another head is not a skip", () => {
    expect(
      existingRowTriageAtHead({
        rowId: "R001",
        headSha: HEAD,
        comments: [rowReply("R001", OTHER_HEAD)],
      }),
    ).toBe(false);
  });

  test("another row at the same head is not a skip", () => {
    expect(
      existingRowTriageAtHead({
        rowId: "R001",
        headSha: HEAD,
        comments: [rowReply("R002", HEAD)],
      }),
    ).toBe(false);
  });

  test("a marker with no row is not a skip", () => {
    expect(
      existingRowTriageAtHead({
        rowId: "R001",
        headSha: HEAD,
        comments: [
          {
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nok`,
          },
        ],
      }),
    ).toBe(false);
  });

  test("an empty list is not a skip", () => {
    expect(
      existingRowTriageAtHead({ rowId: "R001", headSha: HEAD, comments: [] }),
    ).toBe(false);
  });
});
