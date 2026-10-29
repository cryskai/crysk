// Offline tests for revert/hotfix mining (GitHub #41): the git-log record
// parser, the ANCHORED classifier, the two non-optional filters, the gh
// payload readers, the renderer, and the `reverts` command token. Literal in
// → literal out; nothing touches the fs, git, gh, or a clock.
//
// PROVENANCE: every commit subject and every sha below was captured
// READ-ONLY from MusiveTech/musive on 2026-08-16 (`git log` over origin/dev
// — that repo's default branch is `dev`, not `main`). The five REJECTED
// subjects are real history too, and they are the whole reason the classifier
// anchors at position 0 instead of searching for a substring. The SHAS are a
// mix and each block below says which: two reverted shas are real captured
// 40-hex values, the rest are synthetic — either padding of a real captured
// prefix or a stand-in where the capture recorded only the subject.

import { describe, expect, test } from "bun:test";
import {
  classifyRevertCommit,
  DEFAULT_REVERTS_SINCE,
  dedupeRevertPairs,
  dropSamePrReverts,
  formatMergeToRevertGap,
  GIT_LOG_FIELD_SEP,
  GIT_LOG_RECORD_SEP,
  type GitLogRecord,
  parseCommitPulls,
  parseGitLogRecords,
  parsePullDetails,
  pickCommitPull,
  type RevertCandidate,
  renderRevertsArtifact,
  repoSlugFromWebUrl,
  revertedPrFromBranch,
  revertReasonBody,
  selectRevertCandidates,
} from "#pr/reverts-preflight";
import { HELP_TEXT, parseArgs } from "#review/preflight";
import { CliUsageError } from "../../src/errors";

// The three commits of the real 478/483 revert (app/web/common). Only the
// 9-character PREFIXES are captured — 4ee802e43, 5c8c4fa4e, fea0540a0; the
// tails are SYNTHETIC padding to the 40 hex the parser requires. Nothing here
// depends on a sha resolving in a real repo, so the padding costs nothing —
// but a fixture that claims a provenance it does not have is exactly the
// failure class this project has already paid for once.
const SHA_A = "4ee802e43aa1bd0c2f0e4f2d19b7c8a3d5e6f7a8";
const SHA_B = "5c8c4fa4e12b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
const SHA_C = "fea0540a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e";

// Real captured reverted shas.
const REVERTED_SHA_COMMENTS_PLAYER = "86892b2f4ce61dd4829ae61120ac103f0abde3b9";
const REVERTED_SHA_RACE_CONDITION = "0674b3adf04902e65530d9ae3741de84a2417066";
// SYNTHETIC — the capture recorded the subject, not the linked sha.
const REVERTED_SHA_SLIDER = "1276a1276a1276a1276a1276a1276a1276a1276a";
const REVERTED_SHA_UPLOAD_CARD = "0abc1def2abc3def4abc5def6abc7def8abc9de0";

function record(over: Partial<GitLogRecord>): GitLogRecord {
  return {
    sha: SHA_A,
    committedAtSec: 1_770_000_000,
    subject: "chore: nothing to see here",
    body: "",
    ...over,
  };
}

function candidate(over: Partial<RevertCandidate>): RevertCandidate {
  return {
    revertCommitSha: SHA_A,
    revertCommittedAtSec: 1_770_000_000,
    revertSubject: 'Revert "feat: a thing"',
    revertBody: "",
    confidence: "body-linked",
    revertingPr: 483,
    revertingPrMergedAt: "2026-03-02T12:30:00Z",
    revertedPr: 478,
    revertedPrTitle: "feat: username cannot change",
    revertedPrMergedAt: "2026-03-01T10:00:00Z",
    revertedBaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    revertedHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    additions: 120,
    deletions: 8,
    changedFiles: 5,
    collapsedCommits: 1,
    ...over,
  };
}

function logStream(records: GitLogRecord[]): string {
  return records
    .map(
      (r) =>
        `${r.sha}${GIT_LOG_FIELD_SEP}${r.committedAtSec}` +
        `${GIT_LOG_FIELD_SEP}${r.subject}${GIT_LOG_FIELD_SEP}${r.body}` +
        `${GIT_LOG_RECORD_SEP}\n`,
    )
    .join("");
}

describe("parseGitLogRecords", () => {
  test("reads a two-commit stream back field for field", () => {
    const raw = logStream([
      record({ sha: SHA_A, committedAtSec: 1_771_000_000, subject: "a" }),
      record({ sha: SHA_B, committedAtSec: 1_770_000_000, subject: "b" }),
    ]);
    expect(parseGitLogRecords(raw)).toEqual([
      { sha: SHA_A, committedAtSec: 1_771_000_000, subject: "a", body: "" },
      { sha: SHA_B, committedAtSec: 1_770_000_000, subject: "b", body: "" },
    ]);
  });

  test("keeps a body's internal blank lines", () => {
    const body = `This reverts commit ${REVERTED_SHA_RACE_CONDITION}.\n\nThe upload queue stalled in prod.\n\nRolling back until MUS-706 lands.`;
    const raw = logStream([record({ body })]);
    const parsed = parseGitLogRecords(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.body).toBe(body);
  });

  test("an empty stream is zero records, not an error", () => {
    expect(parseGitLogRecords("")).toEqual([]);
    expect(parseGitLogRecords("\n")).toEqual([]);
  });

  test("a malformed record fails loud rather than vanishing", () => {
    expect(() => parseGitLogRecords(`nope${GIT_LOG_RECORD_SEP}\n`)).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseGitLogRecords(
        `zzz${GIT_LOG_FIELD_SEP}1${GIT_LOG_FIELD_SEP}s${GIT_LOG_FIELD_SEP}${GIT_LOG_RECORD_SEP}`,
      ),
    ).toThrow(CliUsageError);
  });
});

describe("classifyRevertCommit — body-linked", () => {
  const linked: [string, string][] = [
    [
      'Revert "feat(app): MUS-584 add comments-player WaveformProgressSource adapter"',
      REVERTED_SHA_COMMENTS_PLAYER,
    ],
    [
      'revert: "Fix/no ref/public project control slider (#1276)" (#1277)',
      REVERTED_SHA_SLIDER,
    ],
    ['Revert "fix: race condition restructure"', REVERTED_SHA_RACE_CONDITION],
    ['Revert "refactor: new uploading status card"', REVERTED_SHA_UPLOAD_CARD],
  ];

  for (const [subject, sha] of linked) {
    test(`${subject.slice(0, 48)} → body-linked`, () => {
      const classified = classifyRevertCommit(
        record({ subject, body: `This reverts commit ${sha}.` }),
      );
      expect(classified?.confidence).toBe("body-linked");
      expect(classified?.revertedSha).toBe(sha);
    });
  }

  test("the body link outranks a subject that matches nothing", () => {
    const classified = classifyRevertCommit(
      record({
        subject: "fix(app): undo the waveform adapter",
        body: `This reverts commit ${REVERTED_SHA_COMMENTS_PLAYER}.`,
      }),
    );
    expect(classified?.confidence).toBe("body-linked");
  });

  test("only the FIRST link is taken; the pair dedupe collapses the rest", () => {
    const classified = classifyRevertCommit(
      record({
        subject: 'Revert "feat: two things"',
        body: `This reverts commit ${REVERTED_SHA_COMMENTS_PLAYER}.\n\nThis reverts commit ${REVERTED_SHA_RACE_CONDITION}.`,
      }),
    );
    expect(classified?.revertedSha).toBe(REVERTED_SHA_COMMENTS_PLAYER);
  });
});

describe("classifyRevertCommit — pattern-only", () => {
  const patterns: string[] = [
    "Merge pull request #1614 from MusiveTech/hotfix/MUS-notifications-v19-compat",
    "Merge pull request #1405 from MusiveTech/hotfix-prod/MUS-446-stalled-upload-cleanup-keys",
    "Merge pull request #1032 from MusiveTech/revert/remove-bun-restore-yarn",
    "Merge pull request #483 from MusiveTech/revert-478-feat-username-cannot-change",
    "revert: remove bun, restore yarn and node",
  ];

  for (const subject of patterns) {
    test(`${subject.slice(0, 56)} → pattern-only`, () => {
      const classified = classifyRevertCommit(record({ subject }));
      expect(classified?.confidence).toBe("pattern-only");
      expect(classified?.revertedSha).toBeNull();
    });
  }

  test("the merge subject yields the reverting PR number", () => {
    const classified = classifyRevertCommit(
      record({
        subject:
          "Merge pull request #1614 from MusiveTech/hotfix/MUS-notifications-v19-compat",
      }),
    );
    expect(classified?.mergePr).toBe(1614);
    expect(classified?.branchPr).toBeNull();
  });

  test("a revert-<n>- branch yields the reverted PR for free", () => {
    const classified = classifyRevertCommit(
      record({
        subject:
          "Merge pull request #483 from MusiveTech/revert-478-feat-username-cannot-change",
      }),
    );
    expect(classified?.mergePr).toBe(483);
    expect(classified?.branchPr).toBe(478);
  });
});

describe("classifyRevertCommit — the anchored rule's whole point", () => {
  // Every one of these is REAL musive history and NONE of them is a revert.
  // A substring search on revert|rollback|hotfix accepts all five.
  const falsePositives: string[] = [
    "docs(mus-638): handle rollback success status",
    "test(MUS-518): re-pin the rollback-scan tripwire after the reformat",
    "fix(MUS-706): hoist rollback captures so the catch can revert the cover",
    "ci: MUS-598 revert temporary Biome probe",
    "fix(app): JD2 round-1 corrections — flush-overlap rollback, fork auto-scroll offset...",
  ];

  for (const subject of falsePositives) {
    test(`REJECTED: ${subject.slice(0, 56)}`, () => {
      expect(classifyRevertCommit(record({ subject }))).toBeNull();
    });
  }

  test("a merge from an ordinary branch is not a revert", () => {
    expect(
      classifyRevertCommit(
        record({
          subject: "Merge pull request #900 from MusiveTech/fix/rollback-scan",
        }),
      ),
    ).toBeNull();
  });
});

describe("revertedPrFromBranch", () => {
  test("takes the number when it is there", () => {
    expect(revertedPrFromBranch("revert-478-feat-username-cannot-change")).toBe(
      478,
    );
    expect(revertedPrFromBranch("revert/1276-slider")).toBe(1276);
  });

  test("leaves it empty when it is not", () => {
    expect(revertedPrFromBranch("revert/remove-bun-restore-yarn")).toBeNull();
    expect(revertedPrFromBranch("hotfix/MUS-446")).toBeNull();
  });
});

describe("dropSamePrReverts", () => {
  // musive 0f309d0ed resolves to PR 1534 on BOTH sides: a commit added and
  // removed inside one branch, so nothing ever shipped.
  test("drops a revert that never crossed a merge boundary", () => {
    const kept = dropSamePrReverts([
      candidate({ revertedPr: 1534, revertingPr: 1534 }),
      candidate({ revertedPr: 478, revertingPr: 483 }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.revertedPr).toBe(478);
  });

  test("an unresolved side is kept — it is not proof of a same-PR revert", () => {
    const kept = dropSamePrReverts([
      candidate({ revertedPr: null, revertingPr: 1614 }),
      candidate({ revertedPr: 478, revertingPr: null }),
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe("dedupeRevertPairs", () => {
  // The real three-commit case: 4ee802e43, 5c8c4fa4e and fea0540a0 all revert
  // PR 478 via PR 483 across app/web/common. That is ONE case.
  test("collapses the 478/483 trio onto its earliest commit", () => {
    const deduped = dedupeRevertPairs([
      candidate({
        revertCommitSha: SHA_B,
        revertCommittedAtSec: 1_770_000_200,
      }),
      candidate({
        revertCommitSha: SHA_A,
        revertCommittedAtSec: 1_770_000_100,
      }),
      candidate({
        revertCommitSha: SHA_C,
        revertCommittedAtSec: 1_770_000_300,
      }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.revertCommitSha).toBe(SHA_A);
    expect(deduped[0]?.collapsedCommits).toBe(3);
  });

  test("different pairs stay apart", () => {
    const deduped = dedupeRevertPairs([
      candidate({ revertedPr: 478, revertingPr: 483 }),
      candidate({
        revertCommitSha: SHA_B,
        revertedPr: 1276,
        revertingPr: 1277,
      }),
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((entry) => entry.collapsedCommits)).toEqual([1, 1]);
  });

  test("two fully unresolved commits never collapse onto each other", () => {
    const deduped = dedupeRevertPairs([
      candidate({
        revertCommitSha: SHA_A,
        revertedPr: null,
        revertingPr: null,
      }),
      candidate({
        revertCommitSha: SHA_B,
        revertedPr: null,
        revertingPr: null,
      }),
    ]);
    expect(deduped).toHaveLength(2);
  });
});

describe("selectRevertCandidates", () => {
  test("both filters run, and the order is newest reverting commit first", () => {
    const selected = selectRevertCandidates([
      candidate({
        revertCommitSha: SHA_B,
        revertCommittedAtSec: 1_770_000_200,
        revertedPr: 1276,
        revertingPr: 1277,
      }),
      candidate({
        revertCommitSha: SHA_A,
        revertCommittedAtSec: 1_770_000_100,
      }),
      candidate({
        revertCommitSha: SHA_C,
        revertCommittedAtSec: 1_770_000_400,
      }),
      candidate({
        revertCommitSha: "0f309d0ed0000000000000000000000000000000",
        revertCommittedAtSec: 1_770_000_900,
        revertedPr: 1534,
        revertingPr: 1534,
      }),
    ]);
    expect(selected.map((entry) => entry.revertCommitSha)).toEqual([
      SHA_B,
      SHA_A,
    ]);
    expect(selected[1]?.collapsedCommits).toBe(2);
  });
});

describe("parseCommitPulls / pickCommitPull", () => {
  // VERIFIED: this endpoint returns the size fields as null, which is why the
  // artifact takes them from a second /pulls/<n> call.
  const raw = JSON.stringify([
    {
      number: 483,
      title: 'Revert "feat: username cannot change"',
      merged_at: "2026-03-02T12:30:00Z",
      additions: null,
      deletions: null,
      changed_files: null,
    },
    { number: 999, title: "a second association", merged_at: null },
  ]);

  test("reads the associations in order", () => {
    expect(parseCommitPulls(raw)).toEqual([
      {
        number: 483,
        title: 'Revert "feat: username cannot change"',
        mergedAt: "2026-03-02T12:30:00Z",
      },
      { number: 999, title: "a second association", mergedAt: null },
    ]);
  });

  test("the first association is GitHub's primary one", () => {
    expect(pickCommitPull(parseCommitPulls(raw))?.number).toBe(483);
    expect(pickCommitPull([])).toBeNull();
  });

  test("no association is an empty list, not an error", () => {
    expect(parseCommitPulls("[]")).toEqual([]);
  });

  test("a non-array response fails loud", () => {
    expect(() => parseCommitPulls("{}")).toThrow(CliUsageError);
    expect(() => parseCommitPulls("not json")).toThrow(CliUsageError);
  });
});

describe("parsePullDetails", () => {
  test("takes the size and the replay range", () => {
    const details = parsePullDetails(
      JSON.stringify({
        number: 478,
        title: "feat: username cannot change",
        merged_at: "2026-03-01T10:00:00Z",
        additions: 120,
        deletions: 8,
        changed_files: 5,
        base: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        head: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      }),
    );
    expect(details).toEqual({
      number: 478,
      title: "feat: username cannot change",
      mergedAt: "2026-03-01T10:00:00Z",
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      additions: 120,
      deletions: 8,
      changedFiles: 5,
    });
  });

  test("null size fields survive as null instead of becoming 0", () => {
    const details = parsePullDetails(
      JSON.stringify({ number: 478, additions: null, changed_files: null }),
    );
    expect(details.additions).toBeNull();
    expect(details.changedFiles).toBeNull();
    expect(details.baseSha).toBeNull();
  });

  test("a response with no number fails loud", () => {
    expect(() => parsePullDetails("{}")).toThrow(CliUsageError);
    expect(() => parsePullDetails("[]")).toThrow(CliUsageError);
  });
});

describe("repoSlugFromWebUrl", () => {
  test("takes the slug the gh api path needs", () => {
    expect(repoSlugFromWebUrl("https://github.com/MusiveTech/musive")).toBe(
      "MusiveTech/musive",
    );
  });

  test("anything that is not a repo root is unusable", () => {
    expect(repoSlugFromWebUrl("https://example.com/a/b")).toBeNull();
    expect(repoSlugFromWebUrl("https://github.com/MusiveTech")).toBeNull();
    expect(
      repoSlugFromWebUrl("https://github.com/MusiveTech/musive/pull/478"),
    ).toBeNull();
  });
});

describe("revertReasonBody", () => {
  test("drops git's own line and keeps the human's", () => {
    expect(
      revertReasonBody(
        `This reverts commit ${REVERTED_SHA_RACE_CONDITION}.\n\nThe upload queue stalled in prod.`,
      ),
    ).toEqual(["The upload queue stalled in prod."]);
  });

  test("a body that is only the link renders nothing", () => {
    expect(
      revertReasonBody(`This reverts commit ${REVERTED_SHA_RACE_CONDITION}.`),
    ).toEqual([]);
  });
});

describe("formatMergeToRevertGap", () => {
  test("is the difference of two recorded stamps", () => {
    expect(
      formatMergeToRevertGap("2026-03-01T10:00:00Z", "2026-03-02T12:30:00Z"),
    ).toBe("1d 2h 30m between merge and revert");
    expect(
      formatMergeToRevertGap("2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z"),
    ).toBe("0m between merge and revert");
  });

  test("an unknown or backwards stamp says unknown rather than guessing", () => {
    expect(formatMergeToRevertGap(null, "2026-03-02T12:30:00Z")).toBe(
      "unknown",
    );
    expect(formatMergeToRevertGap("2026-03-02T12:30:00Z", null)).toBe(
      "unknown",
    );
    expect(formatMergeToRevertGap("not a date", "2026-03-02T12:30:00Z")).toBe(
      "unknown",
    );
    expect(
      formatMergeToRevertGap("2026-03-02T12:30:00Z", "2026-03-01T10:00:00Z"),
    ).toBe("unknown");
  });
});

describe("renderRevertsArtifact", () => {
  const artifact = {
    repoSlug: "MusiveTech/musive",
    ref: "origin/dev",
    since: DEFAULT_REVERTS_SINCE,
    scannedCommits: 4210,
    candidates: [
      candidate({
        revertBody: `This reverts commit ${REVERTED_SHA_COMMENTS_PLAYER}.\n\nThe adapter double-fired on seek.`,
        collapsedCommits: 3,
      }),
      candidate({
        revertCommitSha: SHA_B,
        revertCommittedAtSec: 1_769_000_000,
        confidence: "pattern-only" as const,
        revertSubject:
          "Merge pull request #1614 from MusiveTech/hotfix/MUS-notifications-v19-compat",
        revertingPr: 1614,
        revertedPr: null,
        revertedPrTitle: null,
        revertedPrMergedAt: null,
        revertedBaseSha: null,
        revertedHeadSha: null,
        additions: null,
        deletions: null,
        changedFiles: null,
      }),
    ],
  };

  test("says CANDIDATES REQUIRING HUMAN CONFIRMATION in the artifact itself", () => {
    const markdown = renderRevertsArtifact(artifact);
    expect(markdown).toContain("CANDIDATES REQUIRING HUMAN CONFIRMATION");
    expect(markdown).toContain("product reasons, merge accidents");
  });

  test("carries the fields a human glance needs", () => {
    const markdown = renderRevertsArtifact(artifact);
    expect(markdown).toContain("`MusiveTech/musive`");
    expect(markdown).toContain("`origin/dev`");
    expect(markdown).toContain(`--since ${DEFAULT_REVERTS_SINCE}`);
    expect(markdown).toContain("4210 commit(s)");
    expect(markdown).toContain("### PR #478 — feat: username cannot change");
    expect(markdown).toContain("reverting PR: #483");
    expect(markdown).toContain(`\`${SHA_A}\``);
    expect(markdown).toContain(
      "`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`",
    );
    expect(markdown).toContain("+120/-8, 5 file(s)");
    expect(markdown).toContain("1d 2h 30m between merge and revert");
    expect(markdown).toContain("> The adapter double-fired on seek.");
    expect(markdown).toContain("- collapsed: 3 revert commits");
  });

  test("body-linked comes first, and an unresolved entry still renders", () => {
    const markdown = renderRevertsArtifact(artifact);
    expect(markdown.indexOf("## body-linked")).toBeLessThan(
      markdown.indexOf("## pattern-only"),
    );
    expect(markdown).toContain("### reverted PR unresolved");
    expect(markdown).toContain("reverted PR: unresolved");
    expect(markdown).toContain("replay range: unresolved");
    expect(markdown).toContain("diff size: unknown");
  });

  test("an empty class says so rather than rendering a headless section", () => {
    const markdown = renderRevertsArtifact({ ...artifact, candidates: [] });
    expect(markdown).toContain("## body-linked (0)");
    expect(markdown).toContain("_None in this window._");
  });

  test("no ANSI bytes — it is a file, not a terminal surface", () => {
    expect(renderRevertsArtifact(artifact)).not.toContain("\x1b");
  });

  test("two calls over the same input are byte-identical", () => {
    expect(renderRevertsArtifact(artifact)).toBe(
      renderRevertsArtifact(artifact),
    );
  });
});

describe("parseArgs reverts", () => {
  test("reverts is a command", () => {
    const { command, options } = parseArgs(["reverts"]);
    expect(command).toBe("reverts");
    expect(options.since).toBeUndefined();
  });

  test("reads --since, --repo and --out", () => {
    const { options } = parseArgs([
      "reverts",
      "--repo",
      "/tmp/repo",
      "--since",
      "6 months ago",
      "--out",
      "/tmp/reverts.md",
    ]);
    expect(options.repo).toBe("/tmp/repo");
    expect(options.since).toBe("6 months ago");
    expect(options.out).toBe("/tmp/reverts.md");
  });

  test("--since never swallows the following flag", () => {
    expect(() => parseArgs(["reverts", "--since", "--out", "x"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["reverts", "--since"])).toThrow(CliUsageError);
  });

  // HELP_TEXT spells the default out as a literal rather than interpolating
  // DEFAULT_REVERTS_SINCE, because review/preflight.ts importing it back from
  // pr/reverts-preflight.ts (which imports CliUsageError from review/preflight.ts)
  // would be a real runtime cycle. This test is what keeps the two in step.
  test("the help text quotes the real default window", () => {
    expect(HELP_TEXT).toContain("crysk reverts");
    expect(HELP_TEXT).toContain("--since <git-date>");
    expect(HELP_TEXT).toContain(`Default: ${DEFAULT_REVERTS_SINCE}`);
  });

  test("--since only applies to reverts", () => {
    expect(() => parseArgs(["review", "--since", "6 months ago"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["ledger", "--since", "6 months ago"])).toThrow(
      CliUsageError,
    );
  });
});
