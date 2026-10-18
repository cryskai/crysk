// Pure-decision tests for the inline review surface (ROADMAP B6): anchorability
// prediction, cross-run matching, and the post plan those two combine into.
// All offline — literal in → literal out, same discipline as size-gate.test.ts.

import { describe, expect, test } from "bun:test";
import {
  buildPostPlan,
  classifyAnchorability,
  FINDING_LINE_WINDOW,
  type HunkAnchors,
  matchPostedFindings,
  type PostableFinding,
  type PostedFindingComment,
  parseHunkAnchors,
  resolvePostLine,
} from "#pr/inline";
import { claimFingerprint } from "#pr/preflight";

function finding(
  path: string,
  line: number,
  overrides: Partial<PostableFinding> = {},
): PostableFinding {
  return {
    id: `F${line}`,
    path,
    line,
    claim: "a defect",
    tier: "blocking",
    ...overrides,
  };
}

function posted(
  path: string,
  line: number,
  overrides: Partial<PostedFindingComment> = {},
): PostedFindingComment {
  return {
    id: overrides.id ?? line,
    channel: overrides.channel ?? "review",
    marker: {
      path,
      line,
      headSha: "aaaa000011112222333344445555666677778888",
      // Matches finding()'s default claim ("a defect") so the exact-match
      // fingerprint check (F002 fix) does not spuriously break every test
      // that relies on the default finding/posted pairing actually
      // matching. Tests that need a genuine MISMATCH override this.
      c: claimFingerprint("a defect"),
    },
    ...overrides,
  };
}

// A single-record unified diff whose one hunk covers `count` RIGHT-side lines
// starting at line 1, all as fresh `+` content — enough to build a HunkAnchors
// fixture without hand-writing hundreds of context lines.
function diffAddingLines(path: string, count: number): string {
  const body = Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join(
    "\n",
  );
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${count} @@\n` +
    `${body}\n`
  );
}

// Two disjoint hunks, matching the spec's "outside every hunk" example
// (128-135, 157-184) shape without needing that exact size.
function diffTwoHunks(path: string): string {
  const hunkA = Array.from({ length: 8 }, (_, i) => ` context ${i}`).join("\n");
  const hunkB = Array.from({ length: 28 }, (_, i) => ` context ${i}`).join(
    "\n",
  );
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -128,8 +128,8 @@\n` +
    `${hunkA}\n` +
    `@@ -157,28 +157,28 @@\n` +
    `${hunkB}\n`
  );
}

describe("parseHunkAnchors + classifyAnchorability", () => {
  test("inside a hunk is anchorable", () => {
    const patch = diffAddingLines("src/size-gate.ts", 486);
    const anchors = parseHunkAnchors(patch);
    expect(
      classifyAnchorability({ path: "src/size-gate.ts", line: 345 }, anchors),
    ).toBe("anchorable");
  });

  test("outside every hunk is un-anchorable", () => {
    const patch = diffTwoHunks("src/pr.ts");
    const anchors = parseHunkAnchors(patch);
    expect(
      classifyAnchorability({ path: "src/pr.ts", line: 68 }, anchors),
    ).toBe("un-anchorable");
    // Sanity: a line the hunks DO cover is anchorable, so this is testing the
    // boundary and not an empty anchor set.
    expect(
      classifyAnchorability({ path: "src/pr.ts", line: 130 }, anchors),
    ).toBe("anchorable");
  });

  test("a path absent from the diff entirely is un-anchorable", () => {
    const anchors: HunkAnchors = new Map();
    expect(
      classifyAnchorability({ path: "src/never-touched.ts", line: 1 }, anchors),
    ).toBe("un-anchorable");
  });

  test("a deletion-only line never anchors (right side did not move)", () => {
    const patch =
      "diff --git a/src/a.ts b/src/a.ts\n" +
      "index 0000000..1111111 100644\n" +
      "--- a/src/a.ts\n" +
      "+++ b/src/a.ts\n" +
      "@@ -1,3 +1,1 @@\n" +
      " kept line\n" +
      "-removed line\n" +
      "-removed line 2\n";
    const anchors = parseHunkAnchors(patch);
    // Only the one context line survives on the right side, at line 1.
    expect(classifyAnchorability({ path: "src/a.ts", line: 1 }, anchors)).toBe(
      "anchorable",
    );
    expect(classifyAnchorability({ path: "src/a.ts", line: 2 }, anchors)).toBe(
      "un-anchorable",
    );
  });

  // F001 fix: `\ No newline at end of file` is not tail-only. Verified
  // against REAL `git diff` output (editing the last line of a file that
  // itself lacked a trailing newline): the marker appears immediately after
  // the last `-` line, and the hunk continues with a `+` content line in
  // the SAME hunk. Before the fix, the catch-all `inHunk = false` treated
  // that marker as the hunk's end, so the trailing `+` line was dropped
  // from the anchor set and classifyAnchorability reported it
  // un-anchorable even though GitHub would accept an inline comment there.
  test("a mid-hunk 'no newline' marker does not drop the +line that follows it", () => {
    const patch =
      "diff --git a/f.txt b/f.txt\n" +
      "index 757ad52..d76aff9 100644\n" +
      "--- a/f.txt\n" +
      "+++ b/f.txt\n" +
      "@@ -1,3 +1,3 @@\n" +
      " line1\n" +
      " line2\n" +
      "-lastline\n" +
      "\\ No newline at end of file\n" +
      "+EDITED lastline\n";
    const anchors = parseHunkAnchors(patch);
    expect(classifyAnchorability({ path: "f.txt", line: 3 }, anchors)).toBe(
      "anchorable",
    );
  });

  // Same real shape, but the NEW file also lacks a trailing newline: git
  // emits the marker a SECOND time, right after the final `+` line. The
  // marker must never anchor a phantom line by itself, and the `+` line
  // immediately before it must still count.
  test("a 'no newline' marker after the trailing +line still anchors that line, and adds nothing of its own", () => {
    const patch =
      "diff --git a/f.txt b/f.txt\n" +
      "index 757ad52..541d5b5 100644\n" +
      "--- a/f.txt\n" +
      "+++ b/f.txt\n" +
      "@@ -1,3 +1,3 @@\n" +
      " line1\n" +
      " line2\n" +
      "-lastline\n" +
      "\\ No newline at end of file\n" +
      "+EDITED lastline\n" +
      "\\ No newline at end of file\n";
    const anchors = parseHunkAnchors(patch);
    expect(classifyAnchorability({ path: "f.txt", line: 3 }, anchors)).toBe(
      "anchorable",
    );
    expect(anchors.get("f.txt")?.size).toBe(3);
  });
});

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

const HEAD = "aaaa000011112222333344445555666677778888";

describe("matchPostedFindings", () => {
  test("distance within the window matches (drift after intervening pushes)", () => {
    const result = matchPostedFindings({
      findings: [finding("src/a.ts", 100)],
      posted: [posted("src/a.ts", 100, { liveLine: 105 })],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.fresh).toHaveLength(0);
  });

  test("distance beyond the window does not match", () => {
    const result = matchPostedFindings({
      findings: [finding("src/a.ts", 100)],
      posted: [posted("src/a.ts", 106)],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(0);
    expect(result.fresh).toHaveLength(1);
  });

  test("the boundary is exact: window itself matches, window+1 does not", () => {
    const atWindow = matchPostedFindings({
      findings: [finding("src/a.ts", 100)],
      posted: [posted("src/a.ts", 100 + FINDING_LINE_WINDOW)],
      headSha: HEAD,
    });
    expect(atWindow.persist).toHaveLength(1);

    const pastWindow = matchPostedFindings({
      findings: [finding("src/a.ts", 100)],
      posted: [posted("src/a.ts", 100 + FINDING_LINE_WINDOW + 1)],
      headSha: HEAD,
    });
    expect(pastWindow.persist).toHaveLength(0);
  });

  test("same line, different path does not match", () => {
    const result = matchPostedFindings({
      findings: [finding("b.ts", 50)],
      posted: [posted("a.ts", 50)],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(0);
    expect(result.fresh).toHaveLength(1);
  });

  test("a renamed file matches on GitHub's live path, not the marker's", () => {
    const result = matchPostedFindings({
      findings: [finding("new.ts", 40)],
      posted: [posted("old.ts", 40, { livePath: "new.ts", liveLine: 40 })],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.persist[0]?.posted.marker.path).toBe("old.ts");
  });

  // The direction-of-error pin: an ambiguous tie must post fresh, never force
  // a match. This is the test that would fail if someone later widened the
  // window (making both candidates equidistant differently) or made the
  // match many-to-many (letting the finding pair with BOTH).
  test("an ambiguous tie posts as new rather than forcing a match", () => {
    const result = matchPostedFindings({
      findings: [finding("a.ts", 100)],
      posted: [posted("a.ts", 98), posted("a.ts", 102, { id: 2 })],
      headSha: HEAD,
    });
    expect(result.fresh).toHaveLength(1);
    expect(result.persist).toHaveLength(0);
    // Neither prior comment was consumed — both stay eligible as "resolved"
    // this run if nothing else claims them.
    expect(result.resolved).toHaveLength(2);
  });

  test("each posted comment is matched at most once (one-to-one)", () => {
    const shared = posted("a.ts", 100);
    const result = matchPostedFindings({
      findings: [finding("a.ts", 100), finding("a.ts", 101, { id: "F2" })],
      posted: [shared],
      headSha: HEAD,
    });
    // The first finding (exact distance 0) claims it; the second finding
    // finds nothing left to match and posts fresh instead of double-claiming.
    expect(result.persist).toHaveLength(1);
    expect(result.persist[0]?.finding.line).toBe(100);
    expect(result.fresh).toHaveLength(1);
    expect(result.fresh[0]?.line).toBe(101);
  });

  test("first-ever run: nothing posted before, everything is fresh", () => {
    const result = matchPostedFindings({
      findings: [finding("a.ts", 1), finding("b.ts", 2, { id: "F2" })],
      posted: [],
      headSha: HEAD,
    });
    expect(result.fresh).toHaveLength(2);
    expect(result.persist).toHaveLength(0);
    expect(result.resolved).toHaveLength(0);
  });

  // Fix 1 (R11 daylight): same head, marker line == finding line, but the
  // LIVE line drifted past the window (GitHub re-anchors on a base-branch
  // advance, with no push to the head). The generic window-only algorithm
  // reposts this (distance 12 > window 5); the exact same-head branch must
  // match on the marker's stored line instead.
  test("same head + exact marker line matches despite the live line drifting past the window", () => {
    const result = matchPostedFindings({
      findings: [finding("a.ts", 100)],
      posted: [posted("a.ts", 100, { liveLine: 112 })],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.fresh).toHaveLength(0);
  });

  // F002 fix: same head, same stored line, DIFFERENT claim. Before this
  // fix, the exact same-head branch keyed on path+line alone and never
  // consulted the fingerprint (it only ran for genuine WINDOWED ties), so a
  // distinct defect landing at a path:line that already carried an
  // unrelated posted comment was silently classified `persist` and never
  // surfaced — the invisible miss. Every OTHER exact-match test in this
  // file reuses the default (matching) claim/fingerprint pair; this is the
  // one that pins the mismatch actually causing a post, not a swallow.
  test("same head, same line, DIFFERENT claim: posts as new rather than persisting silently", () => {
    const result = matchPostedFindings({
      findings: [
        finding("a.ts", 100, { claim: "a brand new, unrelated defect" }),
      ],
      posted: [posted("a.ts", 100)], // marker.c fingerprints "a defect"
      headSha: HEAD,
    });
    expect(result.fresh).toHaveLength(1);
    expect(result.persist).toHaveLength(0);
  });

  // Fix 2 (WARN-1): pins the live-line preference on a DIFFERENT head, where
  // the exact same-head branch cannot fire and the live line is the only
  // operative key. Marker line (900) is nowhere near the finding (100); the
  // live line (102) is. Must fail if the `??` preference for the live line
  // is ever dropped in favour of the marker line.
  test("different head: the live line is the operative key, not the marker's stale line", () => {
    const DIFFERENT_HEAD = "ffff999988887777666655554444333322221111";
    const result = matchPostedFindings({
      findings: [finding("a.ts", 100)],
      posted: [posted("a.ts", 900, { liveLine: 102 })],
      headSha: DIFFERENT_HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.fresh).toHaveLength(0);
  });

  // Fix 4 (D3 tie-breaker): two candidates tied at the minimum window
  // distance; only one's marker fingerprint matches the finding's claim.
  // The fingerprint resolves the tie instead of falling through to fresh.
  test("a tied window match resolves via the fingerprint tie-breaker", () => {
    const targetFinding = finding("a.ts", 100, { claim: "the real defect" });
    const matchingFingerprint = claimFingerprint("the real defect");
    const result = matchPostedFindings({
      findings: [targetFinding],
      posted: [
        posted("a.ts", 98, {
          id: 1,
          marker: { ...posted("a.ts", 98).marker, c: matchingFingerprint },
        }),
        posted("a.ts", 102, { id: 2 }),
      ],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.persist[0]?.posted.id).toBe(1);
    expect(result.fresh).toHaveLength(0);
  });

  // Fix 4, constraint: a tie where NO candidate's fingerprint matches still
  // resolves to post-as-new, exactly as before the tie-breaker existed.
  test("a tied window match with no fingerprint hit still posts as new", () => {
    const result = matchPostedFindings({
      findings: [finding("a.ts", 100, { claim: "the real defect" })],
      posted: [posted("a.ts", 98, { id: 1 }), posted("a.ts", 102, { id: 2 })],
      headSha: HEAD,
    });
    expect(result.fresh).toHaveLength(1);
    expect(result.persist).toHaveLength(0);
  });

  // Fix 4, constraint: the fingerprint tie-breaker must NEVER override a
  // strictly nearer candidate. The nearer candidate (distance 1) has no
  // fingerprint match; the farther one (distance 3, still in-window) does.
  // The nearer candidate must still win.
  test("the fingerprint tie-breaker never overrides a strictly nearer candidate", () => {
    const targetFinding = finding("a.ts", 100, { claim: "the real defect" });
    const matchingFingerprint = claimFingerprint("the real defect");
    const result = matchPostedFindings({
      findings: [targetFinding],
      posted: [
        posted("a.ts", 101, { id: 1 }), // distance 1, no fingerprint match
        posted("a.ts", 103, {
          id: 2,
          marker: { ...posted("a.ts", 103).marker, c: matchingFingerprint },
        }), // distance 3, fingerprint matches, but is not the nearest
      ],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.persist[0]?.posted.id).toBe(1);
  });

  // Fix 4, constraint: the fingerprint tie-breaker must NEVER extend the
  // window. A candidate beyond the window with a matching fingerprint must
  // not be picked, even when it is the only candidate at all.
  test("the fingerprint tie-breaker never extends the window", () => {
    const targetFinding = finding("a.ts", 100, { claim: "the real defect" });
    const matchingFingerprint = claimFingerprint("the real defect");
    const result = matchPostedFindings({
      findings: [targetFinding],
      posted: [
        posted("a.ts", 110, {
          // distance 10, past the window; fingerprint matches, but a
          // fingerprint hit past the window is not a candidate at all.
          marker: { ...posted("a.ts", 110).marker, c: matchingFingerprint },
        }),
      ],
      headSha: HEAD,
    });
    expect(result.fresh).toHaveLength(1);
    expect(result.persist).toHaveLength(0);
  });
});

// Tier escalation (advisory posted, blocking found at the same place on a
// later head) must post fresh, never persist: the gate counts the blocking
// finding, and an old advisory comment left as the only match would be the
// invisible miss the module's demote-not-guess rule exists to prevent.
describe("matchPostedFindings — tier escalation", () => {
  const NEW_HEAD = "bbbb000011112222333344445555666677778888";

  test("advisory posted at line 35 + blocking finding at line 35 on a later head → fresh, comment unmatched", () => {
    const advisory = posted("src/session.ts", 35, {
      id: 701,
      tier: "advisory",
    });
    const result = matchPostedFindings({
      findings: [
        finding("src/session.ts", 35, {
          id: "F-escalated",
          claim: "a different, blocking defect",
          tier: "blocking",
        }),
      ],
      posted: [advisory],
      headSha: NEW_HEAD,
    });
    expect(result.persist).toHaveLength(0);
    expect(result.fresh.map((f) => f.id)).toEqual(["F-escalated"]);
    expect(result.resolved.map((p) => p.id)).toEqual([701]);
  });

  test("the guard never dissolves a tie: an advisory and an unrelated blocking comment at equal distance still post fresh", () => {
    // PR #349 round 1: filtering the advisory candidate first left the
    // blocking comment as the sole candidate, and the finding persisted onto
    // an unrelated defect's comment.
    const advisory = posted("src/session.ts", 34, {
      id: 801,
      tier: "advisory",
    });
    const unrelated = posted("src/session.ts", 38, {
      id: 802,
      tier: "blocking",
    });
    const result = matchPostedFindings({
      findings: [
        finding("src/session.ts", 36, {
          id: "F-tie",
          claim: "a claim neither comment fingerprints",
          tier: "blocking",
        }),
      ],
      posted: [advisory, unrelated],
      headSha: NEW_HEAD,
    });
    expect(result.persist).toHaveLength(0);
    expect(result.fresh.map((f) => f.id)).toEqual(["F-tie"]);
    expect(result.resolved.map((p) => p.id).sort()).toEqual([801, 802]);
  });

  test("a same-head windowed advisory winner on another line still posts the blocking finding fresh", () => {
    // PR #349 round 2: only the duplicate-marker case is exempt; a windowed
    // winner has a different line, so the fresh comment has its own marker.
    const result = matchPostedFindings({
      findings: [
        finding("src/session.ts", 38, {
          claim: "an unrelated blocking defect",
          tier: "blocking",
        }),
      ],
      posted: [posted("src/session.ts", 35, { tier: "advisory" })],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(0);
    expect(result.fresh).toHaveLength(1);
  });

  test("escalation on the same head stays a persist (a fresh comment would duplicate the marker)", () => {
    const result = matchPostedFindings({
      findings: [finding("src/session.ts", 35, { tier: "blocking" })],
      posted: [posted("src/session.ts", 35, { tier: "advisory" })],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.fresh).toHaveLength(0);
  });

  test("same tier still persists across heads", () => {
    const result = matchPostedFindings({
      findings: [finding("src/session.ts", 35, { tier: "blocking" })],
      posted: [posted("src/session.ts", 35, { tier: "blocking" })],
      headSha: NEW_HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.fresh).toHaveLength(0);
  });

  test("advisory finding against a blocking posted comment (de-escalation) still persists", () => {
    const result = matchPostedFindings({
      findings: [finding("src/session.ts", 35, { tier: "advisory" })],
      posted: [posted("src/session.ts", 35, { tier: "blocking" })],
      headSha: NEW_HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.fresh).toHaveLength(0);
  });

  test("an unknown tier on the posted side never blocks a persist", () => {
    const result = matchPostedFindings({
      findings: [finding("src/session.ts", 35, { tier: "blocking" })],
      posted: [posted("src/session.ts", 35)],
      headSha: NEW_HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.fresh).toHaveLength(0);
  });
});

describe("buildPostPlan", () => {
  test("mixed run: 1 resolved, 1 new, 2 persist", () => {
    const persistPosted1 = posted("a.ts", 10, { id: 1 });
    const persistPosted2 = posted("b.ts", 20, { id: 2 });
    const resolvedPosted = posted("c.ts", 30, { id: 3 });

    const plan = buildPostPlan({
      findings: [
        finding("a.ts", 10),
        finding("b.ts", 20, { id: "F2" }),
        finding("d.ts", 40, { id: "F3" }),
      ],
      anchors: new Map(),
      posted: [persistPosted1, persistPosted2, resolvedPosted],
      headSha: HEAD,
    });

    expect(plan.delta).toEqual({ resolved: 1, new: 1, persist: 2 });
    expect(plan.persisting).toHaveLength(2);
    expect(plan.resolved).toEqual([resolvedPosted]);
  });

  test("first run: 0 resolved, K new, 0 persist", () => {
    const plan = buildPostPlan({
      findings: [finding("a.ts", 1), finding("b.ts", 2, { id: "F2" })],
      anchors: new Map(),
      posted: [],
      headSha: HEAD,
    });
    expect(plan.delta).toEqual({ resolved: 0, new: 2, persist: 0 });
  });

  test("fresh findings split by anchorability into review vs issue comments", () => {
    const anchors = parseHunkAnchors(diffAddingLines("src/a.ts", 50));
    const plan = buildPostPlan({
      findings: [
        finding("src/a.ts", 10), // inside the hunk -> anchorable
        finding("src/never-touched.ts", 68, { id: "F2" }), // absent -> un-anchorable
      ],
      anchors,
      posted: [],
      headSha: HEAD,
    });
    expect(plan.reviewComments.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(plan.issueComments.map((f) => f.path)).toEqual([
      "src/never-touched.ts",
    ]);
  });

  test("an off-hunk finding re-anchors onto a hunter-cited in-diff proof_ref (Musive #1727)", () => {
    const anchors = parseHunkAnchors(diffHunkAt("src/a.ts", 900, 50));
    const plan = buildPostPlan({
      findings: [
        finding("src/a.ts", 544, {
          proof_refs: ["src/a.ts:544", "src/a.ts:938 (the retry)"],
        }),
      ],
      anchors,
      posted: [],
      headSha: HEAD,
    });
    expect(plan.reviewComments.map((f) => f.line)).toEqual([938]);
    expect(plan.issueComments).toEqual([]);
  });

  test("re-anchoring does not snap to the hunk start when no cited line is in it", () => {
    const anchors = parseHunkAnchors(diffHunkAt("src/a.ts", 900, 50));
    const plan = buildPostPlan({
      findings: [finding("src/a.ts", 544, { proof_refs: ["src/a.ts:544"] })],
      anchors,
      posted: [],
      headSha: HEAD,
    });
    expect(plan.reviewComments).toEqual([]);
    expect(plan.issueComments.map((f) => f.line)).toEqual([544]);
  });

  test("a re-anchored finding persists against a prior comment at the post line", () => {
    const anchors = parseHunkAnchors(diffHunkAt("src/a.ts", 900, 50));
    const plan = buildPostPlan({
      findings: [
        finding("src/a.ts", 544, {
          proof_refs: ["src/a.ts:938"],
        }),
      ],
      anchors,
      posted: [posted("src/a.ts", 938)],
      headSha: HEAD,
    });
    expect(plan.persisting).toHaveLength(1);
    expect(plan.reviewComments).toEqual([]);
    expect(plan.issueComments).toEqual([]);
    expect(plan.delta).toEqual({ resolved: 0, new: 0, persist: 1 });
  });
});

describe("resolvePostLine", () => {
  test("own line in the hunk wins even when a proof_ref cites another in-hunk line", () => {
    const anchors = parseHunkAnchors(diffHunkAt("src/a.ts", 900, 50));
    expect(
      resolvePostLine(
        finding("src/a.ts", 910, { proof_refs: ["src/a.ts:938"] }),
        anchors,
      ),
    ).toBe(910);
  });

  test("a range proof_ref uses the first cited line that sits in the hunk", () => {
    const anchors = parseHunkAnchors(diffHunkAt("src/a.ts", 900, 50));
    expect(
      resolvePostLine(
        finding("src/a.ts", 544, {
          proof_refs: ["src/a.ts:935-946 (retry path)"],
        }),
        anchors,
      ),
    ).toBe(935);
  });

  test("a proof_ref on a different path is ignored", () => {
    const anchors = parseHunkAnchors(diffHunkAt("src/a.ts", 900, 50));
    expect(
      resolvePostLine(
        finding("src/a.ts", 544, { proof_refs: ["src/other.ts:938"] }),
        anchors,
      ),
    ).toBeUndefined();
  });

  test("a path absent from the diff is undefined, not a guessed line", () => {
    const anchors = parseHunkAnchors(diffHunkAt("src/a.ts", 900, 50));
    expect(
      resolvePostLine(
        finding("src/never.ts", 544, { proof_refs: ["src/never.ts:1"] }),
        anchors,
      ),
    ).toBeUndefined();
  });
});
