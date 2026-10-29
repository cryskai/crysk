// Offline tests for the known-bad corpus (GitHub #43): the anchored fix
// detector, the keyword-window issue-ref reader, the incident keywords, the
// diff-hunk/blame parsers, the proximity join, thread qualification, the
// payload readers, selection/tier resolution, the renderer, and the `corpus`
// command token. Literal in → literal out; nothing touches the fs, git, gh,
// or a clock.
//
// PROVENANCE: every PR title, body, sha and timestamp below is SYNTHETIC,
// written to pin these rules — except the three REJECTED subjects in the
// isFixSubject block, which are real MusiveTech/musive history quoted by
// issue #43 as the reason the detector anchors at position 0. Nothing here
// depends on a sha resolving in a real repo.

import { describe, expect, test } from "bun:test";
import {
  type BlamedSha,
  blameArgv,
  buildThreadBatchQuery,
  type CommitIndexEntry,
  type CommitPrRef,
  type CorpusWorking,
  DEFAULT_BUG_LABELS,
  DEFAULT_PROXIMITY_DAYS,
  evidenceExcerpt,
  type IntroducerInfo,
  isFixSubject,
  isIncidentText,
  isLockfilePath,
  isSelfIntroducer,
  issueRefsFromBody,
  joinProximity,
  MAX_PROXIMITY_SUSPECTS,
  type MergedPrNode,
  matchBugLabels,
  type ProximityFix,
  parentBelongsToFix,
  parseBlamePorcelain,
  parseCommitDates,
  parseCommitIndex,
  parseCommitParents,
  parseCutoffTimestamp,
  parseDiffHunks,
  parseIssueLabels,
  parseMergedPrPage,
  parsePullCommits,
  parsePullFiles,
  parseThreadBatch,
  pickIntroducer,
  qualifyThreads,
  renderCorpusArtifact,
  resolvedThreadsWithPath,
  selectCorpus,
  splitBugLabels,
  THREAD_BATCH_SIZE,
  THREAD_PAGE_SIZE,
  type ThreadCandidate,
  TIER_ORDER,
  validateProximityDays,
  walkPageKept,
} from "#corpus/preflight";
import { HELP_TEXT, parseArgs } from "#review/preflight";
import { CliUsageError } from "../../src/errors";

// SYNTHETIC 40-hex stand-ins, first-seen order pinned by nothing but these
// tests. The a/b/c… prefixes keep fixtures readable without pretending to be
// captured shas.
const SHA_A = "4ee802e43aa1bd0c2f0e4f2d19b7c8a3d5e6f7a8";
const SHA_B = "5c8c4fa4e12b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
const SHA_C = "fea0540a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e";
const SHA_D = "0abc1def2abc3def4abc5def6abc7def8abc9de0";
const SHA_E = "1276a1276a1276a1276a1276a1276a1276a1276a";

function working(over: Partial<CorpusWorking>): CorpusWorking {
  return {
    fixPr: 490,
    fixTitle: "fix: correct the upload queue stall",
    fixMergedAt: "2026-03-10T12:00:00Z",
    matchedSources: ["fix-subject"],
    matchedText: "fix: correct the upload queue stall",
    issueRefs: [],
    fixBaseSha: null,
    fixHeadSha: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    introducer: null,
    alsoBlamedCount: 0,
    blameSkippedRenames: 0,
    proximitySuspects: [],
    ...over,
  };
}

function introducer(over: Partial<IntroducerInfo>): IntroducerInfo {
  return {
    pr: 478,
    title: "feat: username cannot change",
    mergedAt: "2026-03-01T10:00:00Z",
    blamedSha: SHA_A,
    blamedFile: "src/app.ts",
    blamedRange: "12,18",
    ...over,
  };
}

function threadCandidate(over: Partial<ThreadCandidate>): ThreadCandidate {
  return {
    pr: 512,
    title: "feat: new upload card",
    mergedAt: "2026-03-08T09:00:00Z",
    threads: [
      {
        path: "src/app.ts",
        line: 132,
        firstCommentAt: "2026-03-07T09:00:00Z",
        excerpt: "The queue stalls when offline.",
        pushSha: SHA_C,
      },
    ],
    threadsTruncated: false,
    baseSha: null,
    headSha: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    ...over,
  };
}

describe("isFixSubject — the anchored rule's whole point", () => {
  const matches: string[] = [
    "fix: correct the upload queue stall",
    "fix(app): correct the upload queue stall",
    "fix!: drop the legacy path",
    "bugfix: correct the upload queue stall",
    "bugfix(web)!: rework the retry loop",
    "FIX: uppercase type still conventional",
  ];
  for (const subject of matches) {
    test(`accepted: ${subject.slice(0, 48)}`, () => {
      expect(isFixSubject(subject)).toBe(true);
    });
  }

  // Every one of these is real musive history (quoted by issue #43) and
  // NONE of them is a fix PR — a substring search on fix|bugfix accepts all
  // three, and a corpus polluted with them spends the human glance.
  const rejected: string[] = [
    "docs(mus-638): handle rollback success status",
    "test(MUS-518): re-pin the rollback-scan tripwire after the reformat",
    "ci: MUS-598 revert temporary Biome probe",
  ];
  for (const subject of rejected) {
    test(`REJECTED: ${subject.slice(0, 56)}`, () => {
      expect(isFixSubject(subject)).toBe(false);
    });
  }

  test("the type must sit at position 0, not anywhere in the subject", () => {
    expect(isFixSubject("chore: apply the fix from #120")).toBe(false);
    expect(isFixSubject("revert fix: not a conventional type")).toBe(false);
    expect(isFixSubject("fixed: past tense is not a type")).toBe(false);
  });
});

describe("issueRefsFromBody", () => {
  test("every keyword form matches", () => {
    for (const keyword of [
      "close",
      "closes",
      "closed",
      "fix",
      "fixes",
      "fixed",
      "resolve",
      "resolves",
      "resolved",
    ]) {
      expect(issueRefsFromBody(`${keyword} #1204`)).toEqual([1204]);
    }
  });

  test("colon forms and mixed prose match", () => {
    expect(issueRefsFromBody("Fixes: #42")).toEqual([42]);
    expect(
      issueRefsFromBody("This resolves ticket #7 once and for all"),
    ).toEqual([7]);
  });

  test("multiple refs on one line, deduped in first-seen order", () => {
    expect(
      issueRefsFromBody("fixes #1 and resolves #2, also closes #1"),
    ).toEqual([1, 2]);
  });

  test("a bare #<n> without a keyword never matches", () => {
    expect(issueRefsFromBody("see #123 for context")).toEqual([]);
    expect(issueRefsFromBody("#1 and #2")).toEqual([]);
  });

  test("the keyword and the ref must share a line", () => {
    expect(issueRefsFromBody("fixes\n#123")).toEqual([]);
  });

  test("the 40-char window is inclusive at 40 and closed at 41", () => {
    // One space + 39 x's = exactly 40 gap characters between keyword and #.
    expect(issueRefsFromBody(`fixes ${"x".repeat(39)}#123`)).toEqual([123]);
    expect(issueRefsFromBody(`fixes ${"x".repeat(40)}#123`)).toEqual([]);
  });

  test("cross-repo owner/repo#n refs are skipped", () => {
    expect(issueRefsFromBody("fixes other/repo#123")).toEqual([]);
    expect(issueRefsFromBody("fixes #1 and other/repo#2")).toEqual([1]);
  });
});

describe("isIncidentText", () => {
  test("each keyword matches, case-insensitively, on word boundaries", () => {
    for (const word of ["incident", "outage", "sentry", "crashlytics"]) {
      expect(isIncidentText(`prod ${word} at 3am`, "")).toContain(word);
      expect(isIncidentText(`${word.toUpperCase()} at 3am`, "")).toContain(
        word.toUpperCase(),
      );
    }
  });

  test("the body is scanned line by line when the title is clean", () => {
    const matched = isIncidentText(
      "fix: retry harder",
      "context\nan outage was declared\naftermath",
    );
    expect(matched).toBe("an outage was declared");
  });

  // CRITICAL non-example: a tracker id says an issue EXISTS, not that the
  // tracked thing is an incident — musive carries MUS-<n> in every subject,
  // and matching it would select the entire history.
  test("bare tracker ids are never a signal", () => {
    expect(
      isIncidentText("fix(MUS-706): hoist rollback captures", ""),
    ).toBeNull();
    expect(
      isIncidentText("chore: MUS-598 cleanup", "MUS-706 follow-up"),
    ).toBeNull();
  });

  test("matchedText collapses whitespace, strips controls, truncates at 160", () => {
    expect(isIncidentText("incident   \x1f  spike", "")).toBe("incident spike");
    const long = `incident ${"x".repeat(200)}`;
    expect(isIncidentText(long, "")).toHaveLength(160);
  });

  test("a clean title and body return null", () => {
    expect(isIncidentText("fix: retry harder", "no keywords here")).toBeNull();
  });
});

describe("evidenceExcerpt", () => {
  test("the title excerpt follows the same rules at 160", () => {
    expect(evidenceExcerpt("fix:  a \x1e b")).toBe("fix: a b");
    expect(evidenceExcerpt(`fix: ${"y".repeat(300)}`)).toHaveLength(160);
  });
});

describe("parseDiffHunks", () => {
  const DIFF = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,4 +10,5 @@ export function upload()",
    " context line",
    "@@ -30,2 +31,3 @@",
    " more context",
    "@@ -50,2 +0,0 @@",
    "-deleted lines",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,8 @@",
    "+added lines",
    "diff --git a/src/old.ts b/src/renamed.ts",
    "similarity index 98%",
    "rename from src/old.ts",
    "rename to src/renamed.ts",
  ].join("\n");

  test("modify and delete-only hunks both yield PRE-IMAGE ranges", () => {
    const plan = parseDiffHunks(DIFF);
    const app = plan.files.find((file) => file.path === "src/app.ts");
    expect(app?.ranges).toEqual([
      { start: 10, end: 13 },
      { start: 30, end: 31 },
      { start: 50, end: 51 },
    ]);
  });

  test("a pure-addition file has hunks but no pre-image lines", () => {
    const plan = parseDiffHunks(DIFF);
    const added = plan.files.find((file) => file.path === "src/new.ts");
    expect(added?.ranges).toEqual([]);
  });

  test("a rename is skipped and counted, not blamed", () => {
    const plan = parseDiffHunks(DIFF);
    expect(plan.renamedPaths).toEqual(["src/renamed.ts"]);
    expect(plan.files.some((file) => file.path.includes("old"))).toBe(false);
  });

  test("overlapping and adjacent ranges merge; a 2-line gap does not", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -10,4 +10,5 @@",
      "@@ -14,3 +15,3 @@",
      "@@ -30,4 +31,4 @@",
      "@@ -36,2 +37,2 @@",
    ].join("\n");
    const plan = parseDiffHunks(diff);
    expect(plan.files[0]?.ranges).toEqual([
      { start: 10, end: 16 }, // adjacent: 13|14
      { start: 30, end: 33 },
      { start: 36, end: 37 }, // 2 untouched lines (34,35) keep the split
    ]);
  });

  test("beyond the caps, files and ranges are dropped and counted", () => {
    const many: string[] = [];
    for (let i = 0; i < 41; i++) {
      many.push(
        `diff --git a/f${i}.ts b/f${i}.ts`,
        `--- a/f${i}.ts`,
        `+++ b/f${i}.ts`,
        "@@ -5,2 +5,3 @@",
      );
    }
    const capped = parseDiffHunks(many.join("\n"));
    expect(capped.files).toHaveLength(40);
    expect(capped.droppedFiles).toBe(1);

    const hunks: string[] = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
    ];
    for (let i = 0; i < 25; i++) {
      // Starts 3 apart: disjoint by 2 lines, so nothing merges.
      hunks.push(`@@ -${1 + i * 3},1 +${2 + i * 3},1 @@`);
    }
    const big = parseDiffHunks(hunks.join("\n"));
    expect(big.files[0]?.ranges).toHaveLength(20);
    expect(big.droppedRanges).toBe(5);
  });
});

describe("blameArgv", () => {
  // -w/-M/-C are the measured half of the introducer fix: without them a
  // whitespace-only reformat is named as the introducer of code it never
  // wrote. The whole argv is pinned so the `--` separator and the range/path
  // order cannot drift either.
  test("carries -w, -M and -C, and the range/path shape around them", () => {
    expect(
      blameArgv("a".repeat(40), "src/app.ts", { start: 12, end: 18 }),
    ).toEqual([
      "blame",
      "--porcelain",
      "-w",
      "-M",
      "-C",
      "-L",
      "12,18",
      "a".repeat(40),
      "--",
      "src/app.ts",
    ]);
  });

  test("a one-line range still renders as start,end", () => {
    const argv = blameArgv(SHA_B, "src/push.ts", { start: 40, end: 40 });
    expect(argv[argv.indexOf("-L") + 1]).toBe("40,40");
  });
});

describe("parseBlamePorcelain", () => {
  const PORCELAIN = [
    `${SHA_A} 1 1 1`,
    "author Dev",
    "author-mail <dev@example.com>",
    "summary introduce the stall",
    "filename src/app.ts",
    "\tthe bugged line",
    `${SHA_B} 2 2`,
    "boundary",
    "author Other",
    "\tanother bugged line",
    `${SHA_A} 3 3`,
  ].join("\n");

  test("distinct header shas, in first-seen order", () => {
    expect(parseBlamePorcelain(PORCELAIN)).toEqual([SHA_A, SHA_B]);
  });

  test("content and metadata lines are ignored, empty input is empty", () => {
    expect(parseBlamePorcelain("")).toEqual([]);
    expect(parseBlamePorcelain("\tcode\nauthor X\nboundary")).toEqual([]);
  });
});

describe("parseCommitDates / pickIntroducer", () => {
  test("reads the batched sha,date rows", () => {
    const dates = parseCommitDates(
      `${SHA_A}\x1f1770000000\n${SHA_B}\x1f1770000100\n`,
    );
    expect(dates.get(SHA_A)).toBe(1770000000);
    expect(dates.get(SHA_B)).toBe(1770000100);
    expect(() => parseCommitDates(`nope\x1f1\n`)).toThrow(CliUsageError);
    expect(() => parseCommitDates(`${SHA_A}\x1flater\n`)).toThrow(
      CliUsageError,
    );
  });

  const blamed = (sha: string, committedAtSec: number): BlamedSha => ({
    sha,
    committedAtSec,
    file: "src/app.ts",
    range: "12,18",
  });

  test("the NEWEST commit wins and the rest are counted", () => {
    const pick = pickIntroducer([
      blamed(SHA_A, 1000),
      blamed(SHA_B, 2000),
      blamed(SHA_C, 1500),
    ]);
    expect(pick?.sha).toBe(SHA_B);
    expect(pick?.alsoBlamedCount).toBe(2);
  });

  test("a tie is broken by sha ascending — determinism, not coin flips", () => {
    const pick = pickIntroducer([
      blamed(SHA_C, 1000),
      blamed(SHA_A, 1000),
      blamed(SHA_B, 1000),
    ]);
    expect(pick?.sha).toBe(SHA_A);
    expect(pick?.alsoBlamedCount).toBe(2);
  });

  test("the same sha across several ranges is ONE candidate", () => {
    const pick = pickIntroducer([
      { ...blamed(SHA_A, 1000), range: "12,18" },
      { ...blamed(SHA_A, 1000), range: "40,44", file: "src/lib.ts" },
    ]);
    expect(pick?.sha).toBe(SHA_A);
    expect(pick?.alsoBlamedCount).toBe(0);
    expect(pick?.range).toBe("12,18");
  });

  test("no blame rows means no introducer", () => {
    expect(pickIntroducer([])).toBeNull();
  });
});

describe("isSelfIntroducer / parentBelongsToFix / parseCommitParents", () => {
  test("self is the same PR number; a different PR or a direct push is not", () => {
    expect(isSelfIntroducer(490, 490)).toBe(true);
    expect(isSelfIntroducer(490, 478)).toBe(false);
    expect(isSelfIntroducer(490, null)).toBe(false);
  });

  test("parentBelongsToFix uses GitHub's primary association", () => {
    expect(
      parentBelongsToFix(490, [
        { number: 490, title: null, mergedAt: null },
        { number: 12, title: null, mergedAt: null },
      ]),
    ).toBe(true);
    expect(
      parentBelongsToFix(490, [{ number: 478, title: null, mergedAt: null }]),
    ).toBe(false);
    expect(parentBelongsToFix(490, [])).toBe(false);
  });

  test("parseCommitParents returns parents in git order; a root is empty", () => {
    expect(parseCommitParents(`${SHA_A} ${SHA_B} ${SHA_C}\n`)).toEqual([
      SHA_B,
      SHA_C,
    ]);
    expect(parseCommitParents(`${SHA_A}\n`)).toEqual([]);
  });

  test("malformed parent records fail loud", () => {
    expect(() => parseCommitParents("")).toThrow(CliUsageError);
    expect(() => parseCommitParents("notasha\n")).toThrow(CliUsageError);
    expect(() => parseCommitParents(`${SHA_A} zzz\n`)).toThrow(CliUsageError);
  });
});

describe("validateProximityDays / splitBugLabels", () => {
  test("defaults and the 1..90 boundaries", () => {
    expect(validateProximityDays(undefined)).toBe(7);
    expect(validateProximityDays("7")).toBe(7);
    expect(validateProximityDays("1")).toBe(1);
    expect(validateProximityDays("90")).toBe(90);
    expect(() => validateProximityDays("0")).toThrow(CliUsageError);
    expect(() => validateProximityDays("91")).toThrow(CliUsageError);
    expect(() => validateProximityDays("3.5")).toThrow(CliUsageError);
    expect(() => validateProximityDays("week")).toThrow(CliUsageError);
  });

  test("labels split, trim, drop empties, dedupe — case preserved", () => {
    expect(splitBugLabels(undefined)).toEqual(["bug"]);
    expect(splitBugLabels("bug, incident ,bug, sev1")).toEqual([
      "bug",
      "incident",
      "sev1",
    ]);
    expect(splitBugLabels("Bug,bug")).toEqual(["Bug", "bug"]);
    expect(() => splitBugLabels(" , ")).toThrow(CliUsageError);
  });
});

describe("isLockfilePath", () => {
  test("the named lockfiles and the generic .lock/.lockb suffix", () => {
    expect(isLockfilePath("package-lock.json")).toBe(true);
    expect(isLockfilePath("apps/web/pnpm-lock.yaml")).toBe(true);
    expect(isLockfilePath("yarn.lock")).toBe(true);
    expect(isLockfilePath("go.sum")).toBe(true);
    expect(isLockfilePath("Cargo.lock")).toBe(true);
    expect(isLockfilePath("src/app.lockb")).toBe(true);
    expect(isLockfilePath("src/lock.ts")).toBe(false);
    expect(isLockfilePath("src/PackageLock.json")).toBe(false);
  });
});

describe("joinProximity", () => {
  const FIX_MS = Date.parse("2026-03-10T12:00:00Z");
  const fix: ProximityFix = {
    fixPr: 490,
    fixMergedAt: "2026-03-10T12:00:00Z",
    files: ["src/app.ts", "src/lib.ts"],
  };
  const commit = (
    sha: string,
    iso: string,
    files: string[],
  ): CommitIndexEntry => ({
    sha,
    committedAtSec: Math.floor(Date.parse(iso) / 1000),
    files,
  });
  const prBySha = new Map<string, CommitPrRef>(
    [
      {
        sha: SHA_A,
        pr: 480,
        title: "feat: a",
        mergedAt: "2026-03-07T12:00:00Z",
      },
      {
        sha: SHA_B,
        pr: 470,
        title: "feat: b",
        mergedAt: "2026-03-03T12:00:00Z",
      },
      {
        sha: SHA_C,
        pr: 460,
        title: "feat: c",
        mergedAt: "2026-02-01T00:00:00Z",
      },
      {
        sha: SHA_D,
        pr: 450,
        title: "feat: d",
        mergedAt: "2026-03-12T12:00:00Z",
      },
      { sha: SHA_E, pr: 490, title: null, mergedAt: null },
    ].map((entry) => [entry.sha, entry]),
  );

  test("lockfiles never count toward the overlap", () => {
    const suspects = joinProximity(
      [
        fix,
        {
          fixPr: 491,
          fixMergedAt: "2026-03-10T12:00:00Z",
          files: ["package-lock.json"],
        },
      ],
      [
        commit(SHA_A, "2026-03-07T12:00:00Z", [
          "src/app.ts",
          "package-lock.json",
        ]),
      ],
      7,
      prBySha,
    );
    // PR 480 shares one real file with #490; the lockfile overlap is not
    // counted. #491's only file is a lockfile, so it matches nobody.
    expect(suspects.get(490)?.map((s) => s.pr)).toEqual([480]);
    expect(suspects.get(490)?.[0]?.sharedFiles).toBe(1);
    expect(suspects.get(491)).toEqual([]);
  });

  test("gap window edges: exactly N days in, N+1s out, future and self out", () => {
    const suspects = joinProximity(
      [fix],
      [
        // exactly 7 days before the fix → in
        commit(SHA_B, "2026-03-03T12:00:00Z", ["src/app.ts"]),
        // 7 days + 1 second → out
        commit(SHA_C, "2026-03-03T11:59:59Z", ["src/app.ts"]),
        // after the fix → out
        commit(SHA_D, "2026-03-11T12:00:00Z", ["src/app.ts"]),
        // the fix's own merge commit → out (a PR is not prior to itself)
        commit(SHA_E, "2026-03-10T12:00:00Z", ["src/app.ts"]),
      ],
      7,
      prBySha,
    );
    expect(suspects.get(490)?.map((s) => s.pr)).toEqual([470]);
    expect(suspects.get(490)?.[0]?.gapDays).toBe(7);
  });

  test("commits that join to no PR are not suspects", () => {
    const suspects = joinProximity(
      [fix],
      [commit("f".repeat(40), "2026-03-08T12:00:00Z", ["src/app.ts"])],
      7,
      prBySha,
    );
    expect(suspects.get(490)).toEqual([]);
  });

  test("sort is sharedFiles desc, then mergedAt desc, then pr asc; cap 3", () => {
    const index: CommitIndexEntry[] = [];
    const bySha = new Map(prBySha);
    // Four 1-file suspects at gaps 4, 3, 2, 1 days — all in the window.
    for (const [i, sha] of [SHA_A, SHA_B, SHA_C, SHA_D].entries()) {
      const days = i + 1;
      const iso = new Date(FIX_MS - days * 86_400_000).toISOString();
      index.push(commit(sha, iso, ["src/app.ts"]));
      bySha.set(sha, {
        pr: 480 - i * 10,
        title: null,
        mergedAt: iso,
      });
    }
    const suspects = joinProximity([fix], index, 7, bySha).get(490);
    expect(suspects).toHaveLength(MAX_PROXIMITY_SUSPECTS);
    // All share 1 file; mergedAt desc = smallest gap first: PR 480 (1d),
    // 470 (2d), 460 (3d) survive, 450 (4d) is the one dropped.
    expect(suspects?.map((s) => s.pr)).toEqual([480, 470, 460]);
  });

  test("one PR with several commits is ONE suspect (unioned files, min gap)", () => {
    const samePr = new Map(prBySha);
    samePr.set(
      SHA_B,
      samePr.get(SHA_A) ?? { pr: 480, title: null, mergedAt: null },
    );
    const suspects = joinProximity(
      [fix],
      [
        commit(SHA_A, "2026-03-09T12:00:00Z", ["src/app.ts"]),
        commit(SHA_B, "2026-03-08T12:00:00Z", ["src/lib.ts"]),
      ],
      7,
      samePr,
    );
    expect(suspects.get(490)).toHaveLength(1);
    expect(suspects.get(490)?.[0]?.sharedFiles).toBe(2);
    expect(suspects.get(490)?.[0]?.gapDays).toBe(1);
  });
});

describe("qualifyThreads", () => {
  const thread = {
    path: "src/app.ts",
    line: 42,
    firstCommentAt: "2026-03-01T10:00:00Z",
    excerpt: "stalls offline",
  };
  const commits = [
    { sha: SHA_A, committedAt: "2026-03-01T09:59:59Z" }, // before
    { sha: SHA_B, committedAt: "2026-03-01T10:00:00Z" }, // equal — NOT later
    { sha: SHA_C, committedAt: "2026-03-01T11:00:00Z" },
    { sha: SHA_D, committedAt: "2026-03-02T00:00:00Z" }, // latest later
  ];

  test("a strictly-later commit and a matching path qualify; pushSha is the LATEST", () => {
    const qualified = qualifyThreads([thread], commits, ["src/app.ts"]);
    expect(qualified).toHaveLength(1);
    expect(qualified[0]?.pushSha).toBe(SHA_D);
  });

  test("no strictly-later commit means no qualification", () => {
    expect(
      qualifyThreads([thread], commits.slice(0, 2), ["src/app.ts"]),
    ).toEqual([]);
  });

  test("the thread's path must be among the PR's files", () => {
    expect(qualifyThreads([thread], commits, ["src/other.ts"])).toEqual([]);
  });

  test("an undatable first comment disqualifies that thread only", () => {
    const qualified = qualifyThreads(
      [thread, { ...thread, firstCommentAt: "" }],
      commits,
      ["src/app.ts"],
    );
    expect(qualified).toHaveLength(1);
  });
});

describe("selectCorpus", () => {
  test("the tier ladder: issue > blame > proximity > keyword", () => {
    const selected = selectCorpus([
      working({
        fixPr: 101,
        matchedSources: ["fix-subject", "bug-issue"],
        issueRefs: [{ number: 12, matchedLabels: ["bug"] }],
      }),
      working({
        fixPr: 102,
        introducer: introducer({ pr: 480 }),
      }),
      working({
        fixPr: 103,
        introducer: introducer({ pr: null }),
        proximitySuspects: [
          { pr: 470, title: null, mergedAt: null, sharedFiles: 2, gapDays: 3 },
        ],
      }),
      working({
        fixPr: 104,
        introducer: introducer({ pr: null }),
      }),
    ]);
    expect(selected.map((c) => c.confidence)).toEqual([
      "issue-linked",
      "blame-linked",
      "proximity",
      "keyword-only",
    ]);
    // Proximity suspects also add the proximity SOURCE.
    expect(selected[2]?.sources).toContain("proximity");
  });

  test("duplicate fix PRs merge sources and issue-ref evidence", () => {
    const selected = selectCorpus([
      working({
        matchedSources: ["fix-subject"],
        matchedText: "fix: a",
        issueRefs: [{ number: 5, matchedLabels: [] }],
      }),
      working({
        matchedSources: ["incident-keyword", "bug-issue"],
        matchedText: "",
        issueRefs: [
          { number: 5, matchedLabels: ["bug"] },
          { number: 6, matchedLabels: [] },
        ],
      }),
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.sources).toEqual([
      "fix-subject",
      "incident-keyword",
      "bug-issue",
    ]);
    expect(selected[0]?.issueRefs).toEqual([
      { number: 5, matchedLabels: ["bug"] },
      { number: 6, matchedLabels: [] },
    ]);
  });

  test("a PR cannot introduce what it itself fixed — introducer nulled", () => {
    const selected = selectCorpus([
      working({ introducer: introducer({ pr: 490 }) }),
    ]);
    expect(selected[0]?.introducer).toBeNull();
    // And the tier falls through to keyword-only (no suspects either).
    expect(selected[0]?.confidence).toBe("keyword-only");
  });

  test("a self-nulled introducer with proximity suspects falls to proximity", () => {
    const selected = selectCorpus([
      working({
        introducer: introducer({ pr: 490 }),
        proximitySuspects: [
          { pr: 470, title: null, mergedAt: null, sharedFiles: 2, gapDays: 3 },
        ],
      }),
    ]);
    expect(selected[0]?.introducer).toBeNull();
    expect(selected[0]?.confidence).toBe("proximity");
  });

  // The pin for the defect where the ladder and the renderer disagreed: the
  // ladder resolved proximity BEFORE keyword-only while TIER_ORDER printed
  // keyword-only first, under a header promising descending confidence.
  // Peeling one signal at a time off a single fully-evidenced entry makes
  // the ladder state its own precedence, and that sequence must BE the
  // rendered order — so reordering either side alone fails here.
  test("TIER_ORDER is the order the ladder actually resolves in", () => {
    const suspects = [
      { pr: 470, title: null, mergedAt: null, sharedFiles: 2, gapDays: 3 },
    ];
    const peeled = [
      // Everything resolves.
      working({
        matchedSources: ["fix-subject", "bug-issue"],
        introducer: introducer({ pr: 480 }),
        proximitySuspects: suspects,
      }),
      // Drop the issue link.
      working({
        matchedSources: ["fix-subject"],
        introducer: introducer({ pr: 480 }),
        proximitySuspects: suspects,
      }),
      // Drop blame too.
      working({
        matchedSources: ["fix-subject"],
        introducer: introducer({ pr: null }),
        proximitySuspects: suspects,
      }),
      // Nothing left but the keyword.
      working({
        matchedSources: ["fix-subject"],
        introducer: introducer({ pr: null }),
        proximitySuspects: [],
      }),
    ];
    const ladder = peeled.map(
      (entry) => selectCorpus([entry])[0]?.confidence ?? null,
    );
    // review-caught is the thread half of the corpus, rendered last and
    // never produced by this ladder.
    expect(TIER_ORDER[TIER_ORDER.length - 1]).toBe("review-caught");
    expect(ladder).toEqual(TIER_ORDER.slice(0, -1));
  });

  test("order: fixMergedAt desc, tie by fixPr asc, undatable last", () => {
    const selected = selectCorpus([
      working({ fixPr: 500, fixMergedAt: "2026-03-10T00:00:00Z" }),
      working({ fixPr: 480, fixMergedAt: "2026-03-10T00:00:00Z" }),
      working({ fixPr: 470, fixMergedAt: "2026-03-12T00:00:00Z" }),
      working({ fixPr: 460, fixMergedAt: null }),
    ]);
    expect(selected.map((c) => c.fixPr)).toEqual([470, 480, 500, 460]);
  });
});

describe("payload readers", () => {
  describe("parseCutoffTimestamp", () => {
    test("takes the timestamp row, empty means no cutoff", () => {
      expect(parseCutoffTimestamp(`commit ${SHA_A}\n1770000000\n`)).toBe(
        1770000000,
      );
      expect(parseCutoffTimestamp("")).toBeNull();
      expect(parseCutoffTimestamp("\n")).toBeNull();
    });

    test("anything else fails loud", () => {
      expect(() => parseCutoffTimestamp("commit abc\nnope\n")).toThrow(
        CliUsageError,
      );
    });
  });

  describe("parseMergedPrPage", () => {
    const page = JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            pageInfo: { endCursor: "CUR", hasNextPage: true },
            nodes: [
              {
                number: 512,
                title: "feat: new upload card",
                body: "Closes #99",
                mergedAt: "2026-03-08T09:00:00Z",
                updatedAt: "2026-03-09T09:00:00Z",
                mergeCommit: { oid: SHA_D },
                baseRefName: "dev",
              },
              {
                number: 511,
                title: "chore: y",
                body: null,
                mergedAt: null,
                updatedAt: null,
                mergeCommit: null,
                baseRefName: "dev",
              },
            ],
          },
        },
      },
    });

    test("reads nodes and pagination back", () => {
      const parsed = parseMergedPrPage(page);
      expect(parsed.endCursor).toBe("CUR");
      expect(parsed.hasNextPage).toBe(true);
      expect(parsed.nodes[0]).toEqual({
        number: 512,
        title: "feat: new upload card",
        body: "Closes #99",
        mergedAt: "2026-03-08T09:00:00Z",
        updatedAt: "2026-03-09T09:00:00Z",
        mergeCommitSha: SHA_D,
        baseRefName: "dev",
      });
      expect(parsed.nodes[1]?.mergedAt).toBeNull();
    });

    test("the finished-walk page: hasNextPage false, endCursor null", () => {
      const last = JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { endCursor: null, hasNextPage: false },
              nodes: [
                {
                  number: 1,
                  title: "fix: x",
                  baseRefName: "dev",
                },
              ],
            },
          },
        },
      });
      const parsed = parseMergedPrPage(last);
      expect(parsed.hasNextPage).toBe(false);
      expect(parsed.endCursor).toBeNull();
      expect(parsed.nodes).toHaveLength(1);
    });

    test("null pageInfo fails loud as CliUsageError, not a TypeError", () => {
      const payload = JSON.stringify({
        data: {
          repository: {
            pullRequests: { pageInfo: null, nodes: [] },
          },
        },
      });
      expect(() => parseMergedPrPage(payload)).toThrow(CliUsageError);
      expect(() => parseMergedPrPage(payload)).toThrow(
        /pullRequests connection/,
      );
    });

    test("hasNextPage true with no endCursor fails loud", () => {
      const payload = JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: true, endCursor: null },
              nodes: [],
            },
          },
        },
      });
      expect(() => parseMergedPrPage(payload)).toThrow(CliUsageError);
      expect(() => parseMergedPrPage(payload)).toThrow(/endCursor/);
    });

    test("malformed responses fail loud naming the query", () => {
      expect(() => parseMergedPrPage("not json")).toThrow(/merged PR walk/);
      expect(() => parseMergedPrPage("{}")).toThrow(/merged PR walk/);
      expect(() => parseMergedPrPage('{"data":{}}')).toThrow(/merged PR walk/);
      const noTitle = JSON.stringify({
        data: {
          repository: {
            pullRequests: { pageInfo: {}, nodes: [{ number: 1 }] },
          },
        },
      });
      expect(() => parseMergedPrPage(noTitle)).toThrow(/PR #1 has no title/);
    });
  });

  describe("walkPageKept", () => {
    const node = (over: Partial<MergedPrNode>): MergedPrNode => ({
      number: 512,
      title: "feat: x",
      body: null,
      mergedAt: "2026-03-08T09:00:00Z",
      updatedAt: "2026-03-08T09:00:00Z",
      mergeCommitSha: null,
      baseRefName: "dev",
      ...over,
    });

    test("keeps in-window default-branch PRs only", () => {
      const { kept, olderExhausted } = walkPageKept({
        nodes: [
          node({}),
          node({ baseRefName: "feature-x" }),
          node({
            mergedAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          }),
          node({ mergedAt: null, updatedAt: null }),
        ],
        cutoffMs: Date.parse("2026-01-01T00:00:00Z"),
        defaultBranch: "dev",
      });
      expect(kept.map((n) => n.number)).toEqual([512]);
      expect(olderExhausted).toBe(false);
    });

    test("a fully-older page exhausts the walk (order key: updatedAt)", () => {
      const { olderExhausted } = walkPageKept({
        nodes: [
          node({
            mergedAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-06-01T00:00:00Z",
          }),
        ],
        cutoffMs: Date.parse("2026-01-01T00:00:00Z"),
        defaultBranch: "dev",
      });
      expect(olderExhausted).toBe(true);
    });

    test("an old merge recently commented does NOT exhaust and is NOT kept", () => {
      // The completeness case for ordering by updatedAt: a merged-years-ago
      // PR with fresh bot activity sorts early, keeps the walk alive, and is
      // discarded by the mergedAt filter.
      const { kept, olderExhausted } = walkPageKept({
        nodes: [node({ mergedAt: "2025-01-01T00:00:00Z" })],
        cutoffMs: Date.parse("2026-01-01T00:00:00Z"),
        defaultBranch: "dev",
      });
      expect(kept).toHaveLength(0);
      expect(olderExhausted).toBe(false);
    });

    test("a page of in-date feature-branch PRs does NOT exhaust the walk", () => {
      const { olderExhausted } = walkPageKept({
        nodes: [node({ baseRefName: "feature-x" })],
        cutoffMs: Date.parse("2026-01-01T00:00:00Z"),
        defaultBranch: "dev",
      });
      expect(olderExhausted).toBe(false);
    });

    test("a null updatedAt falls back to mergedAt for the stop rule", () => {
      const { olderExhausted } = walkPageKept({
        nodes: [
          node({
            mergedAt: "2025-01-01T00:00:00Z",
            updatedAt: null,
          }),
        ],
        cutoffMs: Date.parse("2026-01-01T00:00:00Z"),
        defaultBranch: "dev",
      });
      expect(olderExhausted).toBe(true);
    });

    test("with no cutoff the walk never stops early", () => {
      const { kept, olderExhausted } = walkPageKept({
        nodes: [
          node({
            mergedAt: "2020-01-01T00:00:00Z",
            updatedAt: "2020-01-01T00:00:00Z",
          }),
        ],
        cutoffMs: null,
        defaultBranch: "dev",
      });
      expect(kept).toHaveLength(1);
      expect(olderExhausted).toBe(false);
    });
  });

  describe("parseCommitIndex", () => {
    test("reads format records with their numstat files, binary included", () => {
      const index = parseCommitIndex(
        [
          `${SHA_A}\x1f1770000000`,
          "3\t1\tsrc/app.ts",
          "-\t-\tassets/logo.png",
          "0\t5\tsrc/gone.ts",
          `${SHA_B}\x1f1770000100`,
          "2\t2\tsrc/lib.ts",
        ].join("\n"),
      );
      expect(index).toEqual([
        {
          sha: SHA_A,
          committedAtSec: 1770000000,
          files: ["src/app.ts", "assets/logo.png", "src/gone.ts"],
        },
        { sha: SHA_B, committedAtSec: 1770000100, files: ["src/lib.ts"] },
      ]);
    });

    // Captured verbatim from `git log -m --first-parent --format=%H\x1f%ct
    // --no-renames --numstat` (git 2.54.0) over a real merge-based repo: a
    // merge commit and a direct push, each header followed by a BLANK line
    // before its numstat block. The merge's files reaching the index is the
    // whole fix — `prBySha` keys on merge shas, so if the merge carries no
    // files the proximity join resolves nothing at all.
    test("the real -m --first-parent shape: merge files reach the index", () => {
      const mergeSha = "3de15a8bae3786960ac81485b8f94f17628a1d75";
      const pushSha = "01222c4af7eb00b6d9a1cc2c5b4838e61421a23d";
      const index = parseCommitIndex(
        [
          `${mergeSha}\x1f1786709127`,
          "",
          "168\t0\tdocs/runbooks/mus-638-song-bucket-rollout.md",
          `${pushSha}\x1f1785767142`,
          "",
          "1\t1\tpackages/app/package.json",
          "",
        ].join("\n"),
      );
      expect(index).toEqual([
        {
          sha: mergeSha,
          committedAtSec: 1786709127,
          files: ["docs/runbooks/mus-638-song-bucket-rollout.md"],
        },
        {
          sha: pushSha,
          committedAtSec: 1785767142,
          files: ["packages/app/package.json"],
        },
      ]);
    });

    // Not a statement about merges any more (with --first-parent they do emit
    // numstat) — this is parser tolerance for a genuinely fileless record: an
    // empty commit, or a merge whose first-parent diff is empty.
    test("a record with no numstat lines carries no files", () => {
      const index = parseCommitIndex(`${SHA_A}\x1f1770000000\n`);
      expect(index).toEqual([
        { sha: SHA_A, committedAtSec: 1770000000, files: [] },
      ]);
    });

    test("malformed records fail loud", () => {
      expect(() => parseCommitIndex(`zzz\x1f1\n`)).toThrow(CliUsageError);
      expect(() => parseCommitIndex(`${SHA_A}\x1flater\n`)).toThrow(
        CliUsageError,
      );
    });
  });

  describe("parseIssueLabels", () => {
    test("takes the label names and the PR flag", () => {
      expect(
        parseIssueLabels(
          JSON.stringify({
            labels: [{ name: "bug" }, { name: "incident" }, { name: null }],
            pull_request: { url: "x" },
          }),
        ),
      ).toEqual({ names: ["bug", "incident"], isPull: true });
      expect(parseIssueLabels("{}")).toEqual({ names: [], isPull: false });
    });

    test("malformed responses fail loud", () => {
      expect(() => parseIssueLabels("nope")).toThrow(CliUsageError);
      expect(() => parseIssueLabels('{"labels": 3}')).toThrow(CliUsageError);
    });
  });

  describe("matchBugLabels", () => {
    const bugLabels = new Set(["bug", "incident"]);
    const issue = (names: string[], isPull = false) => ({ names, isPull });

    // The defect this function exists to close: GitHub's issues API answers
    // for PRs, so a `fixes #1234` aimed at a labelled PR used to promote the
    // candidate to `issue-linked`, the artifact's highest tier.
    test("a ref that is a PR confers nothing even when labelled bug", () => {
      const { byRef, anyMatch } = matchBugLabels(
        [1234],
        new Map([[1234, issue(["bug"], true)]]),
        bugLabels,
      );
      expect(anyMatch).toBe(false);
      // Still listed — an evaluated ref is evidence, not an omission.
      expect(byRef.get(1234)).toEqual([]);
    });

    test("a ref that is a real issue with a bug label promotes", () => {
      const { byRef, anyMatch } = matchBugLabels(
        [77],
        new Map([[77, issue(["bug", "needs-triage"])]]),
        bugLabels,
      );
      expect(anyMatch).toBe(true);
      expect(byRef.get(77)).toEqual(["bug"]);
    });

    test("an issue with no matching label confers nothing", () => {
      const { byRef, anyMatch } = matchBugLabels(
        [77],
        new Map([[77, issue(["docs"])]]),
        bugLabels,
      );
      expect(anyMatch).toBe(false);
      expect(byRef.get(77)).toEqual([]);
    });

    test("unresolved (404 → null) and never-fetched refs both degrade", () => {
      const { byRef, anyMatch } = matchBugLabels(
        [10, 11],
        new Map([[10, null]]),
        bugLabels,
      );
      expect(anyMatch).toBe(false);
      expect(byRef.get(10)).toEqual([]);
      expect(byRef.get(11)).toEqual([]);
    });

    test("labels match case-sensitively — GitHub labels are", () => {
      const { anyMatch } = matchBugLabels(
        [77],
        new Map([[77, issue(["Bug"])]]),
        bugLabels,
      );
      expect(anyMatch).toBe(false);
    });
  });

  describe("parsePullCommits / parsePullFiles", () => {
    test("commits take the committer date, the landing instant", () => {
      const commits = parsePullCommits(
        JSON.stringify([
          {
            sha: SHA_A,
            commit: {
              author: { date: "2020-01-01T00:00:00Z" },
              committer: { date: "2026-03-01T11:00:00Z" },
            },
          },
          { sha: SHA_B, commit: {} },
        ]),
      );
      expect(commits).toEqual([
        { sha: SHA_A, committedAt: "2026-03-01T11:00:00Z" },
        { sha: SHA_B, committedAt: null },
      ]);
    });

    test("files are the filename field", () => {
      expect(
        parsePullFiles(JSON.stringify([{ filename: "src/app.ts" }, {}])),
      ).toEqual(["src/app.ts"]);
    });

    test("malformed responses fail loud", () => {
      expect(() => parsePullCommits("{}")).toThrow(CliUsageError);
      expect(() => parsePullFiles("nope")).toThrow(CliUsageError);
    });

    test("a concatenated commits page longer than GitHub's default 30 still round-trips", () => {
      const rows = Array.from({ length: 31 }, (_, i) => ({
        sha: `${SHA_A.slice(0, 38)}${i.toString(16).padStart(2, "0")}`,
        commit: { committer: { date: "2026-03-01T11:00:00Z" } },
      }));
      expect(parsePullCommits(JSON.stringify(rows))).toHaveLength(31);
    });

    test("a concatenated files page longer than per_page=100 still round-trips", () => {
      const rows = Array.from({ length: 101 }, (_, i) => ({
        filename: `f${i}.ts`,
      }));
      expect(parsePullFiles(JSON.stringify(rows))).toHaveLength(101);
    });
  });

  describe("buildThreadBatchQuery / parseThreadBatch", () => {
    test("the query aliases validated integers, caps threads at 50, and does not fetch login", () => {
      const query = buildThreadBatchQuery([512, 513]);
      expect(query).toContain("p0: pullRequest(number:512)");
      expect(query).toContain("p1: pullRequest(number:513)");
      expect(query).toContain(`reviewThreads(first:${THREAD_PAGE_SIZE})`);
      expect(query).toContain("author{__typename}");
      expect(query).not.toContain("login");
      const opens = (query.match(/{/g) ?? []).length;
      const closes = (query.match(/}/g) ?? []).length;
      expect(opens).toBe(closes);
    });

    // The live envelope puts the aliases under data.repository — verified
    // against a real response on 2026-08-16; a fixture with them directly
    // under data is how the shape bug shipped in the first place.
    const batch = JSON.stringify({
      data: {
        repository: {
          p0: {
            reviewThreads: {
              pageInfo: { hasNextPage: true },
              nodes: [
                {
                  isResolved: true,
                  comments: {
                    nodes: [
                      {
                        path: "src/app.ts",
                        line: 132,
                        originalLine: null,
                        createdAt: "2026-03-07T09:00:00Z",
                        body: "stalls   when  offline",
                        author: { login: "gabriel", __typename: "User" },
                      },
                    ],
                  },
                },
                {
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        path: "src/other.ts",
                        line: null,
                        originalLine: 7,
                        createdAt: "2026-03-06T09:00:00Z",
                        body: "unresolved thread",
                        author: { login: "greptile[bot]", __typename: "Bot" },
                      },
                    ],
                  },
                },
                {
                  isResolved: true,
                  comments: {
                    nodes: [
                      {
                        path: "src/bot.ts",
                        line: 9,
                        originalLine: null,
                        createdAt: "2026-03-05T09:00:00Z",
                        body: "bot-caught, not human",
                        author: { login: "greptile[bot]", __typename: "Bot" },
                      },
                    ],
                  },
                },
              ],
            },
          },
          p1: null,
        },
      },
    });

    test("reads resolved/unresolved threads, excerpt rules, truncation", () => {
      const parsed = parseThreadBatch(batch, [512, 513]);
      expect(parsed.entries[0]?.truncated).toBe(true);
      expect(parsed.entries[0]?.threads[0]).toEqual({
        isResolved: true,
        path: "src/app.ts",
        line: 132,
        firstCommentAt: "2026-03-07T09:00:00Z",
        excerpt: "stalls when offline",
        authorType: "User",
      });
      // originalLine stands in when line is null.
      expect(parsed.entries[0]?.threads[1]?.line).toBe(7);
      expect(parsed.entries[1]?.threads).toEqual([]);
      expect(parsed.nullAliases).toBe(1);
    });

    test("resolvedThreadsWithPath keeps only HUMAN resolved threads with a path", () => {
      const parsed = parseThreadBatch(batch, [512, 513]);
      expect(
        resolvedThreadsWithPath(parsed.entries[0]?.threads ?? []).map(
          (thread) => thread.path,
        ),
      ).toEqual(["src/app.ts"]);
    });

    test("malformed batches fail loud naming the PR", () => {
      expect(() => parseThreadBatch("nope", [512])).toThrow(
        /reviewThreads batch/,
      );
      expect(() =>
        parseThreadBatch(
          JSON.stringify({ data: { repository: { p0: {} } } }),
          [512],
        ),
      ).toThrow(/PR #512/);
    });

    test("aliases directly under data (no repository) fail loud", () => {
      expect(() =>
        parseThreadBatch(JSON.stringify({ data: { p0: null } }), [512]),
      ).toThrow(/no repository/);
    });
  });
});

describe("renderCorpusArtifact", () => {
  // The fix candidates go through selectCorpus — a real artifact only ever
  // renders selected candidates, and this exercises the ladder → renderer
  // hand-off with the tiers the section tests below assert.
  const artifact = {
    repoSlug: "MusiveTech/musive",
    ref: "origin/dev",
    since: "24 months ago",
    scannedPrs: 812,
    sourcesRun: ["--fixes", "--incidents", "--proximity", "--threads"],
    lookupFailures: {
      commitPrLookup404: 0,
      mergeCommitAbsent: 0,
      blameRangeSkipped: 0,
    },
    candidates: selectCorpus([
      working({
        fixPr: 483,
        matchedSources: ["fix-subject", "bug-issue"],
        issueRefs: [
          { number: 1204, matchedLabels: ["bug"] },
          { number: 1199, matchedLabels: [] },
        ],
        fixBaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fixHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        additions: 120,
        deletions: 8,
        changedFiles: 5,
        introducer: introducer({ blamedSha: SHA_A }),
        alsoBlamedCount: 2,
        blameSkippedRenames: 1,
        proximitySuspects: [],
      }),
      working({
        fixPr: 1614,
        fixMergedAt: "2026-02-01T00:00:00Z",
        matchedSources: ["fix-subject"],
        matchedText: "fix(app): notification compat",
        introducer: introducer({
          pr: null,
          title: null,
          mergedAt: null,
          blamedSha: SHA_B,
          blamedFile: "src/push.ts",
          blamedRange: "40,44",
        }),
        proximitySuspects: [
          {
            pr: 470,
            title: "feat: push v19",
            mergedAt: "2026-01-28T00:00:00Z",
            sharedFiles: 3,
            gapDays: 4,
          },
        ],
      }),
      working({
        fixPr: 900,
        matchedSources: ["incident-keyword"],
        matchedText: "prod outage at 3am",
      }),
      working({
        fixPr: 950,
        matchedSources: ["fix-subject"],
        matchedText: "fix: race condition",
        introducer: introducer({ pr: 478 }),
      }),
    ]),
    threadCandidates: [
      threadCandidate({
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        additions: 220,
        deletions: 30,
        changedFiles: 6,
      }),
      threadCandidate({
        pr: 513,
        mergedAt: "2026-03-09T00:00:00Z",
        threadsTruncated: true,
        threads: [],
      }),
    ],
  };

  const markdown = renderCorpusArtifact(artifact);

  test("says CANDIDATES REQUIRING HUMAN CONFIRMATION, adapted to this corpus", () => {
    expect(markdown).toContain("CANDIDATES REQUIRING HUMAN CONFIRMATION");
    expect(markdown).toContain("blame names the LAST toucher");
    expect(markdown).toContain("proximity is not causation");
    expect(markdown).toContain("defects review");
    expect(markdown).toContain("DID catch");
  });

  test("says these tiers sit below the reverts ones, and where reverts live", () => {
    expect(markdown).toContain("sits BELOW");
    expect(markdown).toContain("`crysk reverts`");
  });

  test("metadata carries repo, ref, window, scans, source and tier counts", () => {
    expect(markdown).toContain("`MusiveTech/musive`");
    expect(markdown).toContain("`origin/dev`");
    expect(markdown).toContain("--since 24 months ago");
    expect(markdown).toContain("812 merged PR(s)");
    expect(markdown).toContain("source fix-subject: 3 candidate(s)");
    expect(markdown).toContain("source bug-issue: 1 candidate(s)");
    expect(markdown).toContain("source review-thread: 2 caught PR(s)");
    expect(markdown).toContain("tier issue-linked: 1");
    expect(markdown).toContain("tier review-caught: 2");
  });

  test("sections render in tier order", () => {
    const order = [
      markdown.indexOf("## issue-linked"),
      markdown.indexOf("## blame-linked"),
      markdown.indexOf("## proximity"),
      markdown.indexOf("## keyword-only"),
      markdown.indexOf("## review-caught"),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("entries carry the fields a human glance needs", () => {
    expect(markdown).toContain(
      "### fix PR #483 — fix: correct the upload queue stall",
    );
    expect(markdown).toContain(
      "`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`",
    );
    expect(markdown).toContain("+120/-8, 5 file(s)");
    expect(markdown).toContain("sources: fix-subject, bug-issue");
    expect(markdown).toContain("issue refs: #1204 (bug), #1199");
    expect(markdown).toContain(
      'introducer: PR #478 "feat: username cannot change"',
    );
    expect(markdown).toContain(`\`${SHA_A}\` at \`src/app.ts:12,18\``);
    expect(markdown).toContain("also blamed: 2 other commit(s)");
    expect(markdown).toContain("renamed file(s) skipped by blame: 1");
  });

  test("direct-push introducers and proximity suspects render as such", () => {
    expect(markdown).toContain("introducer: direct push");
    expect(markdown).toContain(`\`${SHA_B}\` at \`src/push.ts:40,44\``);
    expect(markdown).toContain(
      'proximity suspects: #470 "feat: push v19" (3 shared file(s), 4d before the fix)',
    );
  });

  test("thread entries render caught-in-review, per-thread lines, truncation", () => {
    expect(markdown).toContain(
      "### PR #512 — feat: new upload card (caught in review)",
    );
    expect(markdown).toContain("`src/app.ts:132`");
    expect(markdown).toContain(`\`${SHA_C}\``);
    expect(markdown).toContain("excerpt: The queue stalls when offline.");
    expect(markdown).toContain(
      `- note: resolved threads truncated at ${THREAD_PAGE_SIZE}`,
    );
  });

  test("an empty tier says so rather than rendering a headless section", () => {
    const empty = renderCorpusArtifact({
      repoSlug: "MusiveTech/musive",
      ref: "origin/dev",
      since: "24 months ago",
      scannedPrs: 0,
      sourcesRun: ["--fixes"],
      lookupFailures: {
        commitPrLookup404: 0,
        mergeCommitAbsent: 0,
        blameRangeSkipped: 0,
      },
      candidates: [],
      threadCandidates: [],
    });
    expect(empty).toContain("## issue-linked (0)");
    expect(empty).toContain("_None in this window._");
    expect(empty).toContain("- sources run: --fixes");
  });

  // The defect these lines exist for: a run degraded by transient GitHub
  // failures used to render byte-identically to a complete one.
  test("a clean run still renders every failure count, at zero", () => {
    expect(markdown).toContain("- failed lookups — commit→PR (404): 0");
    expect(markdown).toContain(
      "- failed lookups — merge commit absent from this clone (stale clone " +
        "or rewritten history): 0",
    );
    expect(markdown).toContain("- failed lookups — blame range skipped: 0");
    expect(markdown).not.toContain("DEGRADED");
  });

  test("any non-zero failure count says the run was DEGRADED, and why", () => {
    for (const failures of [
      { commitPrLookup404: 3, mergeCommitAbsent: 0, blameRangeSkipped: 0 },
      { commitPrLookup404: 0, mergeCommitAbsent: 1, blameRangeSkipped: 0 },
      { commitPrLookup404: 0, mergeCommitAbsent: 0, blameRangeSkipped: 7 },
    ]) {
      const degraded = renderCorpusArtifact({
        ...artifact,
        lookupFailures: failures,
      });
      expect(degraded).toContain("DEGRADED");
      expect(degraded).toContain("WEAKER");
      expect(degraded).toContain("tier than they deserve");
      // The counts themselves stay readable beside the banner.
      expect(degraded).toContain(
        `- failed lookups — commit→PR (404): ${failures.commitPrLookup404}`,
      );
      expect(degraded).toContain(
        `- failed lookups — blame range skipped: ${failures.blameRangeSkipped}`,
      );
      // Gaining header lines must not cost the artifact its existing ones.
      expect(degraded).toContain("- sources run: --fixes, --incidents");
      expect(degraded).toContain("812 merged PR(s)");
      expect(degraded).toContain("tier issue-linked: 1");
      expect(degraded).toContain("CANDIDATES REQUIRING HUMAN CONFIRMATION");
    }
  });

  test("no ANSI bytes — it is a file, not a terminal surface", () => {
    expect(markdown).not.toContain("\x1b");
  });

  test("two calls over the same input are byte-identical", () => {
    expect(renderCorpusArtifact(artifact)).toBe(markdown);
  });
});

describe("parseArgs corpus", () => {
  test("corpus is a command, and no source is a usage error naming all five", () => {
    expect(() => parseArgs(["corpus"])).toThrow(CliUsageError);
    expect(() => parseArgs(["corpus"])).toThrow(/--fixes/);
    expect(() => parseArgs(["corpus"])).toThrow(/--incidents/);
    expect(() => parseArgs(["corpus"])).toThrow(/--issues/);
    expect(() => parseArgs(["corpus"])).toThrow(/--proximity/);
    expect(() => parseArgs(["corpus"])).toThrow(/--threads/);
  });

  test("the five booleans and two value flags round-trip", () => {
    const { command, options } = parseArgs([
      "corpus",
      "--fixes",
      "--incidents",
      "--issues",
      "--proximity",
      "--threads",
      "--proximity-days",
      "14",
      "--bug-labels",
      "bug,sev1",
      "--repo",
      "/tmp/repo",
      "--out",
      "/tmp/corpus.md",
      "--since",
      "6 months ago",
    ]);
    expect(command).toBe("corpus");
    expect(options.fixes).toBe(true);
    expect(options.incidents).toBe(true);
    expect(options.issues).toBe(true);
    expect(options.proximity).toBe(true);
    expect(options.threads).toBe(true);
    expect(options.proximityDays).toBe("14");
    expect(options.bugLabels).toBe("bug,sev1");
    expect(options.repo).toBe("/tmp/repo");
    expect(options.out).toBe("/tmp/corpus.md");
    expect(options.since).toBe("6 months ago");
  });

  test("--proximity implies --fixes, applied purely at parse time", () => {
    const { options } = parseArgs(["corpus", "--proximity"]);
    expect(options.fixes).toBe(true);
    expect(options.proximity).toBe(true);
  });

  test("--issues requires a classified-set source; --proximity satisfies it", () => {
    expect(() => parseArgs(["corpus", "--issues"])).toThrow(
      /upgrades classified PRs/,
    );
    expect(() => parseArgs(["corpus", "--issues", "--threads"])).toThrow(
      /upgrades classified PRs/,
    );
    expect(parseArgs(["corpus", "--issues", "--fixes"]).options.issues).toBe(
      true,
    );
    expect(parseArgs(["corpus", "--issues", "--proximity"]).options.fixes).toBe(
      true,
    );
  });

  test("--bug-labels requires --issues", () => {
    expect(() =>
      parseArgs(["corpus", "--fixes", "--bug-labels", "bug"]),
    ).toThrow(/--bug-labels requires --issues/);
    expect(
      parseArgs(["corpus", "--fixes", "--issues", "--bug-labels", "bug"])
        .options.bugLabels,
    ).toBe("bug");
  });

  test("each new flag is rejected on other commands", () => {
    for (const args of [
      ["review", "--fixes"],
      ["review", "--incidents"],
      ["review", "--issues"],
      ["review", "--proximity"],
      ["review", "--threads"],
      ["review", "--proximity-days", "7"],
      ["review", "--bug-labels", "bug"],
    ]) {
      expect(() => parseArgs(args)).toThrow(CliUsageError);
    }
  });

  test("--proximity-days and --bug-labels never swallow a following flag", () => {
    expect(() =>
      parseArgs(["corpus", "--fixes", "--proximity-days", "--out", "x"]),
    ).toThrow(CliUsageError);
    expect(() => parseArgs(["corpus", "--fixes", "--bug-labels"])).toThrow(
      CliUsageError,
    );
  });

  test("--since is accepted on corpus and rejected elsewhere", () => {
    expect(
      parseArgs(["corpus", "--fixes", "--since", "3 months ago"]).options.since,
    ).toBe("3 months ago");
    expect(() => parseArgs(["ledger", "--since", "3 months ago"])).toThrow(
      CliUsageError,
    );
  });

  // HELP_TEXT spells both defaults as literals rather than interpolating
  // DEFAULT_PROXIMITY_DAYS/DEFAULT_BUG_LABELS, because preflight.ts importing
  // them back from corpus/preflight.ts (which imports CliUsageError from
  // preflight.ts) would be a real runtime cycle — the same reason
  // DEFAULT_REVERTS_SINCE is spelled out. These tests keep the pairs in step.
  test("the help text names corpus, every new flag, and the real defaults", () => {
    expect(HELP_TEXT).toContain("crysk corpus");
    expect(HELP_TEXT).toContain("--fixes");
    expect(HELP_TEXT).toContain("--incidents");
    expect(HELP_TEXT).toContain("--issues");
    expect(HELP_TEXT).toContain("--proximity");
    expect(HELP_TEXT).toContain("--threads");
    expect(HELP_TEXT).toContain("--proximity-days");
    expect(HELP_TEXT).toContain("--bug-labels");
    expect(HELP_TEXT).toContain(`Default: ${DEFAULT_PROXIMITY_DAYS}`);
    expect(HELP_TEXT).toContain(`Default: ${DEFAULT_BUG_LABELS}`);
    expect(DEFAULT_PROXIMITY_DAYS).toBe("7");
    expect(DEFAULT_BUG_LABELS).toBe("bug");
  });

  test("the thread batch caps are the documented pair", () => {
    expect(THREAD_PAGE_SIZE).toBe(50);
    expect(THREAD_BATCH_SIZE).toBe(50);
  });
});
