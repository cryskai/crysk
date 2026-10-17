// Pure-decision tests for PR mode (ROADMAP B1): the --pr flag surface, the
// PR-record parser, the two-root naming rules, the worktree reuse gate, and
// the comparison.json projection. All offline, literal in → literal out.
//
// The two real fixtures below are REAL `gh pr view` bodies captured
// 2026-08-10 with
//   gh pr view <n> --json number,title,state,headRefOid,baseRefName,\
//     baseRefOid,mergeCommit,additions,deletions,changedFiles
// against musive PRs 1682 and 1660, inlined verbatim — the shape this parser
// handles is the shape gh actually emits, not the shape a spec described.

import { describe, expect, test } from "bun:test";
import {
  SKIP_BUDGET_COMMENT_MARKER,
  SKIP_COVERAGE_COMMENT_MARKER,
  SKIP_SIZE_COMMENT_MARKER,
} from "#ci/gates";
import { CANCELLED_STATUS_DESCRIPTION } from "#ci/publish";
import type { ComparisonResult, PrHeroFindingRef } from "#compare/compare";
import type { GreptileFinding } from "#compare/greptile";
import {
  blockingCommitStatusRequest,
  buildComparisonJson,
  CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
  COMMIT_STATUS_CONTEXT,
  COMMIT_STATUS_DESCRIPTION_MAX,
  COMMIT_STATUS_TIMEOUT_MS,
  commitStatusCompletion,
  commitStatusRequest,
  decideWorktree,
  findingMarker,
  findMarkedCommentId,
  IN_FLIGHT_TTL_MS,
  isInFlightCommitStatus,
  LOCAL_COMMIT_STATUS_CONTEXT,
  latestStatusInContext,
  PR_COMMENT_COVERAGE_PARTIAL_TOKEN,
  PR_COMMENT_MARKER_PREFIX,
  PR_FINDING_MARKER_PREFIX,
  PR_REREVIEW_CLOSED_MARKER_PREFIX,
  parseFindingMarker,
  partialReviewDescription,
  prCommentMarker,
  prHtmlUrl,
  prRunDirCandidate,
  RUN_STATUS_CONTEXTS,
  resolveCiMode,
  resolveCiPosture,
  resolveCurrentPrNumber,
  resolvePrTarget,
  settleRequestForCancellation,
  skipCommitStatusRequest,
  worktreeDirty,
} from "#pr/preflight";
import { PR_STATE_MARKER_PREFIX } from "#rereview/state";
import { parseArgs } from "#review/preflight";
import { TRIAGE_MARKER_PREFIX } from "#triage/triage";
import { CliError, CliUsageError } from "../../src/errors";

// Merged the ordinary way: mergeCommit present, base branch is the default.
const PR_1682_MERGED = `{"additions":21,"baseRefName":"dev","baseRefOid":"b22c3b367f6ac8531ad40e172f7aa82384dbbeb1","changedFiles":7,"deletions":8,"headRefOid":"e3ab386a63020c6f5c21d814d176ff33849eef8d","mergeCommit":{"oid":"0f7d53cc602a0dbf51372e8a601fef87ea85cc94"},"number":1682,"state":"MERGED","title":"chore(MUS-716): loading-flag resets, style arrays and fetch check (slice 5)"}`;

// Closed WITHOUT merging, and stacked: its base is another PR's branch, not
// the default branch — baseRefName matters to the fetch in exactly this case.
const PR_1660_CLOSED = `{"additions":175,"baseRefName":"chore/MUS-708-4a-pin-script","baseRefOid":"7395db0d33d0f3fae8eb2f98795c8748335986ca","changedFiles":5,"deletions":174,"headRefOid":"30e038b0c71742432eea11a7d5964c97251c5e49","mergeCommit":null,"number":1660,"state":"CLOSED","title":"chore(MUS-708): pin root/backend/common ranges [5/8]"}`;

// synthetic: no open PR existed at capture time; shape mirrors 1660
// (mergeCommit null).
const PR_OPEN_SYNTHETIC = `{"additions":175,"baseRefName":"chore/MUS-708-4a-pin-script","baseRefOid":"7395db0d33d0f3fae8eb2f98795c8748335986ca","changedFiles":5,"deletions":174,"headRefOid":"30e038b0c71742432eea11a7d5964c97251c5e49","mergeCommit":null,"number":1660,"state":"OPEN","title":"chore(MUS-708): pin root/backend/common ranges [5/8]"}`;

describe("parseArgs --pr", () => {
  test("reads the PR number", () => {
    expect(parseArgs(["review", "--pr", "1682"]).options.pr).toBe(1682);
  });

  test("is absent unless given", () => {
    expect(parseArgs(["review"]).options.pr).toBeUndefined();
  });

  test("must be a positive integer", () => {
    for (const value of ["0", "-3", "2.5", "many"]) {
      expect(() => parseArgs(["review", "--pr", value])).toThrow(CliUsageError);
    }
  });

  // Each exclusion in both flag orders: the check runs after the loop, so
  // whichever flag comes first must not smuggle the other through.
  test("excludes --base", () => {
    expect(() => parseArgs(["review", "--pr", "5", "--base", "dev"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--base", "dev", "--pr", "5"])).toThrow(
      CliUsageError,
    );
  });

  // The default head IS "HEAD", so the exclusion must fire on explicitness,
  // not on the value — an explicit --head HEAD still contradicts --pr.
  test("excludes --head even when the value equals the default", () => {
    expect(() => parseArgs(["review", "--pr", "5", "--head", "HEAD"])).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseArgs(["review", "--head", "feature", "--pr", "5"]),
    ).toThrow(CliUsageError);
  });

  test("excludes --two-dot", () => {
    expect(() => parseArgs(["review", "--pr", "5", "--two-dot"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--two-dot", "--pr", "5"])).toThrow(
      CliUsageError,
    );
  });

  test("each exclusion names the conflicting flag", () => {
    for (const [argv, flag] of [
      [["review", "--pr", "5", "--base", "dev"], "--base"],
      [["review", "--pr", "5", "--head", "x"], "--head"],
      [["review", "--pr", "5", "--two-dot"], "--two-dot"],
    ] as const) {
      try {
        parseArgs([...argv]);
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain(flag);
        expect((error as Error).message).toContain("--pr");
      }
    }
  });

  test("everything PR mode keeps working still parses beside it", () => {
    const { options } = parseArgs([
      "review",
      "--pr",
      "1682",
      "--repo",
      "/tmp/repo",
      "--agents",
      "/tmp/agents",
      "--out",
      "/tmp/runs",
      "--gotchas",
      "/g.md",
      "--config",
      "/c.json",
      "--model",
      "opus",
      "--hop-budget",
      "4",
      "--dry-run",
      "--yes",
    ]);
    expect(options.pr).toBe(1682);
    expect(options.repo).toBe("/tmp/repo");
    expect(options.agents).toBe("/tmp/agents");
    expect(options.out).toBe("/tmp/runs");
    expect(options.gotchas).toBe("/g.md");
    expect(options.config).toBe("/c.json");
    expect(options.model).toBe("opus");
    expect(options.hopBudget).toBe(4);
    expect(options.dryRun).toBe(true);
    expect(options.yes).toBe(true);
  });
});

describe("parseArgs bare --pr", () => {
  test("a trailing bare --pr means the current branch's PR", () => {
    expect(parseArgs(["review", "--pr"]).options.pr).toBe("current");
  });

  test("--pr followed by a flag stays bare, and the flag still parses", () => {
    const { options } = parseArgs(["review", "--pr", "--post"]);
    expect(options.pr).toBe("current");
    expect(options.post).toBe(true);
  });

  // THE guard for the optional value: only a digit-leading token is a PR
  // number, so the command word can never be swallowed as one.
  test("the non-digit rule protects the command token", () => {
    const { command, options } = parseArgs(["--pr", "review"]);
    expect(command).toBe("review");
    expect(options.pr).toBe("current");
  });

  // Digit-leading on purpose, not full-match: digit-leading garbage must
  // reach the validator and fail loudly, never silently become branch-mode.
  test("digit-leading garbage still fails the --pr validator by name", () => {
    for (const value of ["0", "2.5", "12abc"]) {
      try {
        parseArgs(["review", "--pr", value]);
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain("--pr");
      }
    }
  });

  test("the exclusions still fire in bare mode, both flag orders", () => {
    for (const argv of [
      ["review", "--pr", "--base", "dev"],
      ["review", "--base", "dev", "--pr"],
    ]) {
      try {
        parseArgs(argv);
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain("--base");
      }
    }
  });
});

describe("resolveCurrentPrNumber", () => {
  test("reads the number gh reports for the current branch", () => {
    expect(resolveCurrentPrNumber('{"number":1682}')).toBe(1682);
  });

  test("invalid JSON and non-objects fail loud", () => {
    expect(() => resolveCurrentPrNumber("not json")).toThrow(CliUsageError);
    expect(() => resolveCurrentPrNumber("[]")).toThrow(CliUsageError);
    expect(() => resolveCurrentPrNumber("null")).toThrow(CliUsageError);
  });

  test("a missing or bad number names the field", () => {
    for (const raw of ["{}", '{"number":0}', '{"number":2.5}']) {
      try {
        resolveCurrentPrNumber(raw);
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain("number");
      }
    }
  });
});

describe("parseArgs --post", () => {
  test("defaults to undefined", () => {
    expect(parseArgs(["review"]).options.post).toBeUndefined();
    expect(parseArgs(["review", "--pr", "5"]).options.post).toBeUndefined();
  });

  test("parses beside --pr, in either flag order", () => {
    expect(parseArgs(["review", "--pr", "5", "--post"]).options.post).toBe(
      true,
    );
    expect(parseArgs(["review", "--post", "--pr", "5"]).options.post).toBe(
      true,
    );
  });

  // Posting publishes a PR comment, so without --pr there is no PR to
  // publish to — and the error must name both flags.
  test("without --pr it throws, naming both flags", () => {
    for (const argv of [
      ["review", "--post"],
      ["review", "--post", "--repo", "/tmp/x"],
    ]) {
      try {
        parseArgs(argv);
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain("--post");
        expect((error as Error).message).toContain("--pr");
      }
    }
  });
});

// ROADMAP B6 (WU6): the `post` verb — `pr-hero post --pr <n> --from
// <run-dir> [--dry-run]` — reads a prior run's findings.json off disk
// instead of running a fresh review (the `ledger` verb's precedent).
describe("parseArgs post command", () => {
  test("is a recognized command, and the unknown-command list names it", () => {
    expect(parseArgs(["post", "--pr", "5", "--from", "/runs/x"]).command).toBe(
      "post",
    );
    try {
      parseArgs(["audit"]);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("post");
    }
  });

  test("requires --pr", () => {
    try {
      parseArgs(["post", "--from", "/runs/x"]);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("--pr");
    }
  });

  test("requires --from", () => {
    try {
      parseArgs(["post", "--pr", "5"]);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("--from");
    }
  });

  test("--from is read, and rejected on every other command", () => {
    const { options } = parseArgs(["post", "--pr", "5", "--from", "/runs/x"]);
    expect(options.from).toBe("/runs/x");
    for (const argv of [
      ["review", "--from", "/runs/x"],
      ["ledger", "--from", "/runs/x"],
    ]) {
      try {
        parseArgs(argv);
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain("--from");
      }
    }
  });

  // Bare --pr and a numeric --pr both parse; post's own required-flag check
  // does not care WHICH shape --pr took, only that it is present.
  test("accepts bare --pr (current branch's PR)", () => {
    const { options } = parseArgs(["post", "--pr", "--from", "/runs/x"]);
    expect(options.pr).toBe("current");
    expect(options.from).toBe("/runs/x");
  });

  test("--dry-run parses beside post, without --post the flag", () => {
    const { options } = parseArgs([
      "post",
      "--pr",
      "5",
      "--from",
      "/runs/x",
      "--dry-run",
    ]);
    expect(options.dryRun).toBe(true);
    expect(options.post).toBeUndefined();
  });
});

// ROADMAP B6c: the `triage` verb — `pr-hero triage --pr <n> --from
// <run-dir> [--dry-run]` — shares `post`'s exact shape (both --pr and
// --from required, --from otherwise rejected everywhere else).
describe("parseArgs triage command", () => {
  test("is a recognized command, and the unknown-command list names it", () => {
    expect(
      parseArgs(["triage", "--pr", "5", "--from", "/runs/x"]).command,
    ).toBe("triage");
    try {
      parseArgs(["audit"]);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("triage");
    }
  });

  test("requires --pr and --from", () => {
    expect(() => parseArgs(["triage", "--from", "/runs/x"])).toThrow(/--pr/);
    expect(() => parseArgs(["triage", "--pr", "5"])).toThrow(/--from/);
  });

  test("--from is read, and rejected on every other command", () => {
    const { options } = parseArgs(["triage", "--pr", "5", "--from", "/runs/x"]);
    expect(options.from).toBe("/runs/x");
    expect(() => parseArgs(["review", "--from", "/runs/x"])).toThrow(/--from/);
  });

  test("accepts bare --pr (current branch's PR), and --dry-run parses beside it", () => {
    const { options } = parseArgs([
      "triage",
      "--pr",
      "--from",
      "/runs/x",
      "--dry-run",
    ]);
    expect(options.pr).toBe("current");
    expect(options.from).toBe("/runs/x");
    expect(options.dryRun).toBe(true);
  });
});

describe("parseArgs triage reply", () => {
  const required = [
    "triage",
    "reply",
    "--pr",
    "5",
    "--from",
    "/runs/x",
    "--finding",
    "F001",
    "--tag",
    "applied",
    "--body-file",
    "/tmp/reason.md",
  ];

  test("parses the reply sub-word and its flags", () => {
    const { command, options } = parseArgs(required);
    expect(command).toBe("triage");
    expect(options.triage).toBe("reply");
    expect(options.finding).toBe("F001");
    expect(options.tag).toBe("applied");
    expect(options.bodyFile).toBe("/tmp/reason.md");
  });

  test("requires --finding, --tag and --body-file", () => {
    expect(() =>
      parseArgs(["triage", "reply", "--pr", "5", "--from", "/runs/x"]),
    ).toThrow(/--finding/);
    expect(() =>
      parseArgs([
        "triage",
        "reply",
        "--pr",
        "5",
        "--from",
        "/runs/x",
        "--finding",
        "F001",
      ]),
    ).toThrow(/--tag/);
    expect(() =>
      parseArgs([
        "triage",
        "reply",
        "--pr",
        "5",
        "--from",
        "/runs/x",
        "--finding",
        "F001",
        "--tag",
        "applied",
      ]),
    ).toThrow(/--body-file/);
  });

  test("dismissed requires --verdict; applied forbids it", () => {
    expect(() =>
      parseArgs([
        "triage",
        "reply",
        "--pr",
        "5",
        "--from",
        "/runs/x",
        "--finding",
        "F001",
        "--tag",
        "dismissed",
        "--body-file",
        "/tmp/r.md",
      ]),
    ).toThrow(/--verdict/);
    expect(() => parseArgs([...required, "--verdict", "upheld"])).toThrow(
      /applied cannot take --verdict/,
    );
  });

  test("deferred does not require --issue", () => {
    const { options } = parseArgs([
      "triage",
      "reply",
      "--pr",
      "5",
      "--from",
      "/runs/x",
      "--finding",
      "F001",
      "--tag",
      "deferred",
      "--verdict",
      "upheld",
      "--body-file",
      "/tmp/r.md",
    ]);
    expect(options.tag).toBe("deferred");
    expect(options.issue).toBeUndefined();
    expect(options.verdict).toBe("upheld");
  });

  test("--issue is rejected on non-deferred tags", () => {
    expect(() => parseArgs([...required, "--issue", "12"])).toThrow(
      /--issue only applies to --tag deferred/,
    );
  });

  test("reply flags are rejected on the bind-only triage verb", () => {
    expect(() =>
      parseArgs([
        "triage",
        "--pr",
        "5",
        "--from",
        "/runs/x",
        "--finding",
        "F001",
      ]),
    ).toThrow(/--finding only applies to triage reply/);
  });

  test("an unknown tag fails loud", () => {
    expect(() =>
      parseArgs([
        "triage",
        "reply",
        "--pr",
        "5",
        "--from",
        "/runs/x",
        "--finding",
        "F001",
        "--tag",
        "wontfix",
        "--body-file",
        "/tmp/r.md",
      ]),
    ).toThrow(/--tag must be/);
  });
});

describe("prCommentMarker", () => {
  const HEAD = "e3ab386a63020c6f5c21d814d176ff33849eef8d";

  test("declares the full head sha and starts with the matcher's prefix", () => {
    const marker = prCommentMarker(HEAD);
    expect(marker).toBe(`<!-- pr-hero-report head=${HEAD} -->`);
    expect(marker.startsWith(PR_COMMENT_MARKER_PREFIX)).toBe(true);
  });

  // The old headless marker must ALSO start with the prefix — that identity
  // is the whole backward-compatibility argument for prefix matching.
  test("the legacy headless marker starts with the same prefix", () => {
    expect("<!-- pr-hero-report -->".startsWith(PR_COMMENT_MARKER_PREFIX)).toBe(
      true,
    );
  });

  // Rereview-coverage fix (partial-review posting a marker that reads as
  // complete, GitHub #42's re-review half): omitting `complete` — or passing
  // it explicitly true — must stay BYTE-IDENTICAL to the pre-fix marker.
  // Every already-posted comment, and every one-argument caller in this
  // codebase, depends on that.
  test("complete (default, and explicit true) is byte-identical to the old marker", () => {
    expect(prCommentMarker(HEAD)).toBe(`<!-- pr-hero-report head=${HEAD} -->`);
    expect(prCommentMarker(HEAD, true)).toBe(
      `<!-- pr-hero-report head=${HEAD} -->`,
    );
  });

  // A partial run's marker still starts with PR_COMMENT_MARKER_PREFIX (so
  // findMarkedCommentId keeps finding/updating the SAME comment — no second
  // summary), but carries the named coverage token so a reader can tell this
  // run never finished.
  test("incomplete carries the named coverage token and still matches the prefix", () => {
    const marker = prCommentMarker(HEAD, false);
    expect(marker).toBe(
      `<!-- pr-hero-report head=${HEAD} ${PR_COMMENT_COVERAGE_PARTIAL_TOKEN} -->`,
    );
    expect(marker.startsWith(PR_COMMENT_MARKER_PREFIX)).toBe(true);
  });
});

describe("findMarkedCommentId", () => {
  const HEAD = "e3ab386a63020c6f5c21d814d176ff33849eef8d";
  const marked = (id: number) => ({
    id,
    body: `${prCommentMarker(HEAD)}\n\n## pr-hero review — 1 blocking`,
  });
  // The format every comment already in the wild carries — posted before
  // B3 taught the marker to declare a head.
  const legacyMarked = (id: number) => ({
    id,
    body: "<!-- pr-hero-report -->\n\n## pr-hero review — 1 blocking",
  });

  test("no comments is null", () => {
    expect(findMarkedCommentId([])).toBeNull();
  });

  test("one marked comment is found by id", () => {
    expect(findMarkedCommentId([marked(101)])).toBe(101);
  });

  // THE backward-compatibility pin: matching moved to the bare prefix so
  // OLD comments keep being found and PATCHed — a matcher that required
  // `head=` would stack a second comment on every pre-B3 PR.
  test("a legacy headless comment is still found", () => {
    expect(findMarkedCommentId([legacyMarked(55)])).toBe(55);
  });

  test("a legacy comment and a new one mix; the last still wins", () => {
    expect(findMarkedCommentId([legacyMarked(10), marked(20)])).toBe(20);
  });

  // ROADMAP Pillar 3: the `prefix` parameter, defaulted to
  // PR_COMMENT_MARKER_PREFIX so every call above (all single-argument) stays
  // byte-identical. A custom prefix matches ONLY comments under that exact
  // marker — a summary comment must never be mistaken for a CI skip comment,
  // or vice versa.
  test("a custom prefix matches only comments under that exact marker", () => {
    const skipMarked = (id: number) => ({
      id,
      body: `${SKIP_SIZE_COMMENT_MARKER}\n## pr-hero review skipped`,
    });
    expect(
      findMarkedCommentId(
        [marked(10), skipMarked(20)],
        SKIP_SIZE_COMMENT_MARKER,
      ),
    ).toBe(20);
    expect(
      findMarkedCommentId([marked(10)], SKIP_SIZE_COMMENT_MARKER),
    ).toBeNull();
  });

  // The exact-prefix lesson (a real `<!-- linear-linkback -->` bot comment
  // motivated it): a foreign marker that merely shares the leading words
  // must not match — the trailing space in the prefix rejects it.
  test("a lookalike foreign marker is not ours", () => {
    expect(
      findMarkedCommentId([
        { id: 9, body: "<!-- pr-hero-reporter -->\nsomeone else's bot" },
        { id: 10, body: "<!-- pr-hero-reportage head=abc -->" },
      ]),
    ).toBeNull();
  });

  test("only marked comments match in a mix", () => {
    expect(
      findMarkedCommentId([
        { id: 1, body: "LGTM" },
        marked(2),
        { id: 3, body: "one more pass please" },
      ]),
    ).toBe(2);
  });

  // Idempotency is find-and-update, never stack: with legacy duplicates the
  // NEWEST (last in API order) gets the update and history stays untouched.
  test("two marked comments yield the LAST id", () => {
    expect(
      findMarkedCommentId([marked(10), { id: 20, body: "noise" }, marked(30)]),
    ).toBe(30);
  });

  // Only a body that STARTS with the marker is ours: a human quoting the
  // report (or indenting it) must never have their comment overwritten.
  test("a marker quoted mid-body is not a match", () => {
    expect(
      findMarkedCommentId([
        {
          id: 7,
          body: `replying to the bot:\n${prCommentMarker(HEAD)}\nquoted`,
        },
        { id: 8, body: ` ${prCommentMarker(HEAD)} leading space` },
      ]),
    ).toBeNull();
  });
});

// The collision test named in design D3: every marker family now posts into
// the same issue-comment stream (the summary comment, per-finding issue
// comments, the rereview state block, triage replies, and — ROADMAP Pillar 3
// — the two CI gate-skip comments), so a matcher that could confuse one for
// another would misfile a comment across families.
//
// Phase 3 (Pillar 3 apply-progress handoff #1) registers the two skip
// markers here rather than leaving them unaddressed: they are field-less,
// self-closing tags (`<!-- pr-hero-skip-size -->`), unlike the four
// `<!-- pr-hero-<noun> ` + trailing-space prefixes, so the trailing-space
// argument that keeps THOSE four disjoint does not apply to them — they need
// their own proof. And the existing test only ever checked PR_FINDING vs
// PR_COMMENT; strengthened here to every pair across all six, closing the
// PR_STATE/TRIAGE gap noted in the same handoff.
describe("marker prefix disjointness", () => {
  const ALL_MARKER_PREFIXES: readonly [string, string][] = [
    ["PR_COMMENT_MARKER_PREFIX", PR_COMMENT_MARKER_PREFIX],
    ["PR_FINDING_MARKER_PREFIX", PR_FINDING_MARKER_PREFIX],
    ["PR_STATE_MARKER_PREFIX", PR_STATE_MARKER_PREFIX],
    ["TRIAGE_MARKER_PREFIX", TRIAGE_MARKER_PREFIX],
    ["SKIP_SIZE_COMMENT_MARKER", SKIP_SIZE_COMMENT_MARKER],
    ["SKIP_BUDGET_COMMENT_MARKER", SKIP_BUDGET_COMMENT_MARKER],
    ["SKIP_COVERAGE_COMMENT_MARKER", SKIP_COVERAGE_COMMENT_MARKER],
    ["PR_REREVIEW_CLOSED_MARKER_PREFIX", PR_REREVIEW_CLOSED_MARKER_PREFIX],
  ];

  test("neither marker prefix is a prefix of the other (legacy pair, kept for regression pinning)", () => {
    expect(PR_FINDING_MARKER_PREFIX.startsWith(PR_COMMENT_MARKER_PREFIX)).toBe(
      false,
    );
    expect(PR_COMMENT_MARKER_PREFIX.startsWith(PR_FINDING_MARKER_PREFIX)).toBe(
      false,
    );
  });

  test("every pair across all six marker families is mutually disjoint", () => {
    const colliding: string[] = [];
    for (let i = 0; i < ALL_MARKER_PREFIXES.length; i++) {
      for (let j = 0; j < ALL_MARKER_PREFIXES.length; j++) {
        if (i === j) continue;
        const [nameA, a] = ALL_MARKER_PREFIXES[i] as [string, string];
        const [nameB, b] = ALL_MARKER_PREFIXES[j] as [string, string];
        if (a.startsWith(b)) colliding.push(`${nameA} starts with ${nameB}`);
      }
    }
    expect(colliding).toEqual([]);
  });
});

describe("findingMarker + parseFindingMarker", () => {
  const HEAD = "e3ab386a63020c6f5c21d814d176ff33849eef8d";

  test("round-trips path, line, and head", () => {
    const marker = findingMarker({
      path: "src/pr.ts",
      line: 68,
      headSha: HEAD,
      claim: "unhandled null dereference",
    });
    expect(marker.startsWith(PR_FINDING_MARKER_PREFIX)).toBe(true);
    const parsed = parseFindingMarker(marker);
    expect(parsed?.path).toBe("src/pr.ts");
    expect(parsed?.line).toBe(68);
    expect(parsed?.headSha).toBe(HEAD);
    expect(parsed?.c).toMatch(/^[0-9a-f]{12}$/);
  });

  // The C-quoting family of bugs (c717fe4): a path with a space or a
  // percent-meaningful character must survive the marker round-trip intact.
  test("percent-encodes a path with a space or reserved character", () => {
    const marker = findingMarker({
      path: "café/a file.ts",
      line: 5,
      headSha: HEAD,
      claim: "x",
    });
    expect(marker).not.toContain("café/a file.ts");
    expect(parseFindingMarker(marker)?.path).toBe("café/a file.ts");
  });

  test("the same claim yields the same tie-breaker; a different claim does not", () => {
    const a = findingMarker({
      path: "a.ts",
      line: 1,
      headSha: HEAD,
      claim: "the same defect",
    });
    const b = findingMarker({
      path: "a.ts",
      line: 1,
      headSha: HEAD,
      claim: "the same defect",
    });
    const c = findingMarker({
      path: "a.ts",
      line: 1,
      headSha: HEAD,
      claim: "a different defect",
    });
    expect(parseFindingMarker(a)?.c).toBe(parseFindingMarker(b)?.c);
    expect(parseFindingMarker(a)?.c).not.toBe(parseFindingMarker(c)?.c);
  });

  test("a marker quoted mid-body does not parse (mirrors findMarkedCommentId)", () => {
    const marker = findingMarker({
      path: "a.ts",
      line: 1,
      headSha: HEAD,
      claim: "x",
    });
    expect(parseFindingMarker(`quoting:\n${marker}`)).toBeNull();
    expect(parseFindingMarker(` ${marker}`)).toBeNull();
  });

  test("a foreign marker-shaped body does not parse", () => {
    expect(parseFindingMarker("not a marker at all")).toBeNull();
    expect(parseFindingMarker(PR_COMMENT_MARKER_PREFIX)).toBeNull();
  });

  test("a malformed marker (missing field) does not parse", () => {
    expect(
      parseFindingMarker("<!-- pr-hero-finding path=a.ts line=1 -->"),
    ).toBeNull();
  });
});

describe("resolvePrTarget", () => {
  test("MERGED resolves base to the merge commit's first parent", () => {
    expect(resolvePrTarget(PR_1682_MERGED)).toEqual({
      number: 1682,
      title:
        "chore(MUS-716): loading-flag resets, style arrays and fetch " +
        "check (slice 5)",
      state: "MERGED",
      headSha: "e3ab386a63020c6f5c21d814d176ff33849eef8d",
      baseRef: "0f7d53cc602a0dbf51372e8a601fef87ea85cc94^1",
      baseRefName: "dev",
      baseSource: "merge-commit-parent",
      ghDiffStat: { files: 7, insertions: 21, deletions: 8 },
    });
  });

  test("CLOSED-unmerged uses the recorded base tip, stacked bases included", () => {
    const target = resolvePrTarget(PR_1660_CLOSED);
    expect(target.state).toBe("CLOSED");
    expect(target.baseRef).toBe("7395db0d33d0f3fae8eb2f98795c8748335986ca");
    expect(target.baseSource).toBe("base-branch");
    expect(target.baseRefName).toBe("chore/MUS-708-4a-pin-script");
    expect(target.headSha).toBe("30e038b0c71742432eea11a7d5964c97251c5e49");
    expect(target.ghDiffStat).toEqual({
      files: 5,
      insertions: 175,
      deletions: 174,
    });
  });

  test("OPEN behaves exactly like CLOSED-unmerged", () => {
    const target = resolvePrTarget(PR_OPEN_SYNTHETIC);
    expect(target.state).toBe("OPEN");
    expect(target.baseRef).toBe("7395db0d33d0f3fae8eb2f98795c8748335986ca");
    expect(target.baseSource).toBe("base-branch");
  });

  test("invalid JSON fails loud", () => {
    expect(() => resolvePrTarget("not json")).toThrow(CliUsageError);
    expect(() => resolvePrTarget("[]")).toThrow(CliUsageError);
    expect(() => resolvePrTarget("null")).toThrow(CliUsageError);
  });

  test("a missing field names itself", () => {
    const record = JSON.parse(PR_1682_MERGED) as Record<string, unknown>;
    delete record.headRefOid;
    try {
      resolvePrTarget(JSON.stringify(record));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("headRefOid");
    }
  });

  // The abbreviated-sha lesson (preflight's isFullCommitId): a short id in
  // the record must fail here, never propagate into artifacts.
  test("an abbreviated sha is rejected, naming the field", () => {
    const record = JSON.parse(PR_1682_MERGED) as Record<string, unknown>;
    record.headRefOid = "e3ab386a";
    try {
      resolvePrTarget(JSON.stringify(record));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("headRefOid");
    }
  });

  test("MERGED with a null mergeCommit refuses to guess", () => {
    const record = JSON.parse(PR_1682_MERGED) as Record<string, unknown>;
    record.mergeCommit = null;
    const raw = JSON.stringify(record);
    expect(() => resolvePrTarget(raw)).toThrow(CliError);
    try {
      resolvePrTarget(raw);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("refusing to guess");
    }
  });
});

describe("PR naming", () => {
  test("run dirs lead with the PR and pin the head sha", () => {
    const root = "/Users/x/Desktop/musive-prhero-runs";
    const head = "e3ab386a63020c6f5c21d814d176ff33849eef8d";
    expect(prRunDirCandidate(root, 1682, head, 1)).toBe(
      `${root}/pr-1682-e3ab386a-1`,
    );
    expect(prRunDirCandidate(root, 1682, head, 2)).toBe(
      `${root}/pr-1682-e3ab386a-2`,
    );
  });
});

describe("worktreeDirty", () => {
  test("an empty status is clean", () => {
    expect(worktreeDirty("")).toBe(false);
    expect(worktreeDirty("\n")).toBe(false);
  });

  // THE filter this function exists for: the index is always untracked in
  // the worktree, and reading it as dirt would make reuse impossible.
  test("the untracked .codegraph/ alone is clean", () => {
    expect(worktreeDirty("?? .codegraph/\n")).toBe(false);
  });

  test("a modified tracked file is dirty", () => {
    expect(worktreeDirty(" M src/a.ts\n")).toBe(true);
  });

  test("any other untracked file is dirty", () => {
    expect(worktreeDirty("?? notes.md\n")).toBe(true);
    // .codegraph entries do not launder the rest of the status.
    expect(worktreeDirty("?? .codegraph/\n?? notes.md\n")).toBe(true);
  });

  test("a lookalike path outside .codegraph/ is dirty", () => {
    expect(worktreeDirty("?? .codegraphx/file\n")).toBe(true);
    expect(worktreeDirty(" M src/.codegraph-notes.md\n")).toBe(true);
  });
});

describe("decideWorktree", () => {
  test("the full decision table", () => {
    const table = [
      [{ exists: false, headMatches: false, dirty: false }, "create"],
      [{ exists: false, headMatches: true, dirty: true }, "create"],
      [{ exists: true, headMatches: false, dirty: false }, "recreate"],
      [{ exists: true, headMatches: false, dirty: true }, "recreate"],
      [{ exists: true, headMatches: true, dirty: true }, "recreate"],
      [{ exists: true, headMatches: true, dirty: false }, "reuse"],
    ] as const;
    for (const [input, action] of table) {
      expect(decideWorktree(input).action).toBe(action);
    }
  });

  test("every decision carries a reason, and the two recreate causes differ", () => {
    const headMoved = decideWorktree({
      exists: true,
      headMatches: false,
      dirty: false,
    });
    const dirtied = decideWorktree({
      exists: true,
      headMatches: true,
      dirty: true,
    });
    expect(headMoved.reason.length).toBeGreaterThan(0);
    expect(dirtied.reason.length).toBeGreaterThan(0);
    expect(headMoved.reason).not.toBe(dirtied.reason);
  });
});

describe("buildComparisonJson", () => {
  const matched: GreptileFinding = {
    index: 1,
    path: "src/a.ts",
    startLine: 100,
    endLine: 104,
    title: "Stale cache",
    description: "The derived value is never invalidated.",
  };
  const missed: GreptileFinding = {
    index: 2,
    path: "src/b.ts",
    startLine: 7,
    endLine: 7,
    title: "Missed",
    description: "Only Greptile saw this.",
  };
  const paired: PrHeroFindingRef = {
    id: "F001",
    path: "src/a.ts",
    line: 102,
    claim: "Cached list survives the mutation.",
    tier: "blocking",
  };
  const extra: PrHeroFindingRef = {
    id: "F002",
    path: "src/c.ts",
    line: 40,
    claim: "Only pr-hero saw this.",
    tier: "advisory",
  };
  const result: ComparisonResult = {
    greptileOnly: [missed],
    both: [{ greptile: matched, prhero: paired }],
    prheroOnly: [extra],
  };

  test("projects the same result the renderer consumes, miss first", () => {
    const json = buildComparisonJson({
      pr: 1682,
      headSha: "e3ab386a63020c6f5c21d814d176ff33849eef8d",
      diffFromSha: "b22c3b367f6ac8531ad40e172f7aa82384dbbeb1",
      runDir: "/x/musive-prhero-runs/pr-1682-e3ab386a-1",
      generatedAt: "2026-08-10T18:00:00.000Z",
      runStatus: "complete",
      greptileFound: true,
      result,
    });
    expect(json.pr).toBe(1682);
    expect(json.generated_at).toBe("2026-08-10T18:00:00.000Z");
    expect(json.head_sha).toBe("e3ab386a63020c6f5c21d814d176ff33849eef8d");
    expect(json.diff_from_sha).toBe("b22c3b367f6ac8531ad40e172f7aa82384dbbeb1");
    expect(json.run_dir).toBe("/x/musive-prhero-runs/pr-1682-e3ab386a-1");
    expect(json.run_status).toBe("complete");
    expect(json.greptile).toEqual({ found: true });
    expect(json.rows.map((r) => r.bucket)).toEqual([
      "greptile_only",
      "both",
      "prhero_only",
    ]);
    expect(json.rows[0]).toEqual({
      bucket: "greptile_only",
      greptile: {
        index: 2,
        path: "src/b.ts",
        start_line: 7,
        end_line: 7,
        title: "Missed",
        description: "Only Greptile saw this.",
      },
      prhero: null,
      verdict: null,
      reasoning: null,
      actor: null,
    });
    expect(json.rows[1]).toEqual({
      bucket: "both",
      greptile: {
        index: 1,
        path: "src/a.ts",
        start_line: 100,
        end_line: 104,
        title: "Stale cache",
        description: "The derived value is never invalidated.",
      },
      prhero: {
        id: "F001",
        path: "src/a.ts",
        line: 102,
        claim: "Cached list survives the mutation.",
        tier: "blocking",
      },
      verdict: null,
      reasoning: null,
      actor: null,
    });
    expect(json.rows[2]).toEqual({
      bucket: "prhero_only",
      greptile: null,
      prhero: {
        id: "F002",
        path: "src/c.ts",
        line: 40,
        claim: "Only pr-hero saw this.",
        tier: "advisory",
      },
      verdict: null,
      reasoning: null,
      actor: null,
    });
  });

  // The A3 lesson made structural: the triage columns exist, and they ship
  // empty — never pre-filled, never omitted. `actor` (ROADMAP B6c) joins
  // them for the same reason: nobody has triaged this row yet.
  test("every row ships verdict, reasoning and actor as literal nulls", () => {
    const json = buildComparisonJson({
      pr: 1682,
      headSha: "e3ab386a63020c6f5c21d814d176ff33849eef8d",
      diffFromSha: "b22c3b367f6ac8531ad40e172f7aa82384dbbeb1",
      runDir: "/x/runs/pr-1682-e3ab386a-1",
      generatedAt: "2026-08-10T18:00:00.000Z",
      runStatus: "complete",
      greptileFound: true,
      result,
    });
    expect(json.rows.length).toBeGreaterThan(0);
    for (const row of json.rows) {
      expect(row.verdict).toBeNull();
      expect(row.reasoning).toBeNull();
      expect(row.actor).toBeNull();
    }
  });

  // found: false ("no Greptile comment") must stay distinguishable from
  // "Greptile commented and reported nothing" (found: true, no rows).
  test("a PR without a Greptile comment records found: false", () => {
    const json = buildComparisonJson({
      pr: 1660,
      headSha: "30e038b0c71742432eea11a7d5964c97251c5e49",
      diffFromSha: "7395db0d33d0f3fae8eb2f98795c8748335986ca",
      runDir: "/x/runs/pr-1660-30e038b0-1",
      generatedAt: "2026-08-10T18:05:00.000Z",
      runStatus: "partial",
      greptileFound: false,
      result: { greptileOnly: [], both: [], prheroOnly: [extra] },
    });
    expect(json.greptile.found).toBe(false);
    // A partial run's comparison stays readable, weighted by its status —
    // only the all-hunters-dead case is never written at all (cli.ts skips
    // it: "pr-hero 0" from a review that never ran is not a measured miss).
    expect(json.run_status).toBe("partial");
    expect(json.rows).toHaveLength(1);
    expect(json.rows[0].bucket).toBe("prhero_only");
    expect(json.rows[0].greptile).toBeNull();
  });
});

describe("commitStatusRequest", () => {
  const targetUrl = "https://github.com/org/repo/pull/7";

  test("pending is yellow, not a verdict", () => {
    expect(
      commitStatusRequest({
        phase: "pending",
        posted: true,
        targetUrl,
        context: COMMIT_STATUS_CONTEXT,
      }),
    ).toEqual({
      state: "pending",
      context: COMMIT_STATUS_CONTEXT,
      description: "pr-hero reviewing",
      targetUrl,
    });
  });

  test("a finished review is success whether or not it posted", () => {
    expect(
      commitStatusRequest({
        phase: "success",
        posted: true,
        targetUrl,
        context: COMMIT_STATUS_CONTEXT,
      }).description,
    ).toBe("review posted");
    expect(
      commitStatusRequest({
        phase: "success",
        posted: false,
        targetUrl: undefined,
        context: COMMIT_STATUS_CONTEXT,
      }),
    ).toEqual({
      state: "success",
      context: COMMIT_STATUS_CONTEXT,
      description: "review complete",
      targetUrl: undefined,
    });
  });

  test("sessionFailed / crash is error in either mode, never failure", () => {
    const request = commitStatusRequest({
      phase: "error",
      posted: false,
      targetUrl,
      context: COMMIT_STATUS_CONTEXT,
    });
    expect(request.state).toBe("error");
    expect(request.description).toBe("review did not finish");
    // Blocking findings alone never make a crashed run red as `failure`:
    // gate mode turns findings into `failure` only on a finished review.
    expect(
      commitStatusCompletion({
        pipelineFinished: true,
        sessionFailed: true,
        ciMode: "gate",
        blockingCount: 2,
      }),
    ).toEqual({ phase: "error" });
  });
});

describe("settleRequestForCancellation", () => {
  const lock = {
    operatorRoot: "/repo",
    sha: "a".repeat(40),
    targetUrl: "https://github.com/org/repo/pull/162",
    context: COMMIT_STATUS_CONTEXT as typeof COMMIT_STATUS_CONTEXT,
  };

  test("a lock taken by a local run settles on pr-hero/local, never on pr-hero", () => {
    const request = settleRequestForCancellation({
      ...lock,
      context: LOCAL_COMMIT_STATUS_CONTEXT,
    })?.request;
    expect(request?.context).toBe(LOCAL_COMMIT_STATUS_CONTEXT);
  });

  test("a lock with no recorded context settles on the local context, never the gate's", () => {
    const { context: _omitted, ...bare } = lock;
    expect(settleRequestForCancellation(bare)?.request.context).toBe(
      LOCAL_COMMIT_STATUS_CONTEXT,
    );
  });

  test("holding no lock settles nothing", () => {
    expect(settleRequestForCancellation(null)).toBeNull();
  });

  // #347 F003: the signal settle and the action's cancel-settle step write one coded text.
  test("a cancelled run settles as PRH-CANCELLED, the same text the action's cancel step writes", () => {
    expect(settleRequestForCancellation(lock)?.request).toMatchObject({
      state: "error",
      description: CANCELLED_STATUS_DESCRIPTION,
    });
  });

  test("settles the exact sha the lock was taken on, as error", () => {
    // The sha is load-bearing: PR #162's cancelled run posted its pending on
    // 1b57c92 and the settle has to land on THAT head, not on whatever the
    // operator checkout points at by the time the signal arrives.
    expect(settleRequestForCancellation(lock)).toEqual({
      operatorRoot: "/repo",
      sha: lock.sha,
      request: {
        state: "error",
        context: COMMIT_STATUS_CONTEXT,
        // #347 F003: a cancel is coded, so the S7 invariant (an error status
        // carries a PRH- code) holds whichever of the two cancel writers lands.
        description: CANCELLED_STATUS_DESCRIPTION,
        targetUrl: lock.targetUrl,
      },
    });
  });

  test("a lock with no target url settles without one", () => {
    const request = settleRequestForCancellation({
      ...lock,
      targetUrl: undefined,
    })?.request;
    expect(request?.state).toBe("error");
    expect(request?.targetUrl).toBeUndefined();
  });
});

describe("CANCELLATION_COMMIT_STATUS_TIMEOUT_MS", () => {
  test("is short enough to beat the runner's SIGKILL grace period", () => {
    // A settle that outlives SIGKILL is no settle at all: the normal 15s
    // bound (times two attempts) is longer than the grace window a cancelled
    // Actions job gets.
    expect(CANCELLATION_COMMIT_STATUS_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(CANCELLATION_COMMIT_STATUS_TIMEOUT_MS).toBeLessThan(
      COMMIT_STATUS_TIMEOUT_MS,
    );
  });
});

const gateTargetUrl = "https://github.com/org/repo/pull/7";

describe("commitStatusCompletion — gate mode (S4)", () => {
  test("a finished review with blocking findings is failure, carrying the count", () => {
    expect(
      commitStatusCompletion({
        pipelineFinished: true,
        sessionFailed: false,
        ciMode: "gate",
        blockingCount: 2,
      }),
    ).toEqual({ phase: "failure", blockingCount: 2 });
  });

  test("clean and advisory-only reviews are success (blockingCount 0)", () => {
    expect(
      commitStatusCompletion({
        pipelineFinished: true,
        sessionFailed: false,
        ciMode: "gate",
        blockingCount: 0,
      }),
    ).toEqual({ phase: "success" });
  });

  test("a crash, a session failure, or a findings count it never built is error, never failure", () => {
    expect(
      commitStatusCompletion({
        pipelineFinished: false,
        sessionFailed: false,
        ciMode: "gate",
        blockingCount: 2,
      }),
    ).toEqual({ phase: "error" });
    expect(
      commitStatusCompletion({
        pipelineFinished: true,
        sessionFailed: true,
        ciMode: "gate",
        blockingCount: 2,
      }),
    ).toEqual({ phase: "error" });
    // publishRunOutcome threw before the findings doc existed: the count is
    // unknown, and a gate cannot call an unknown count clean.
    expect(
      commitStatusCompletion({
        pipelineFinished: true,
        sessionFailed: false,
        ciMode: "gate",
        blockingCount: null,
      }),
    ).toEqual({ phase: "error" });
  });
});

describe("commitStatusCompletion — advisory mode keeps today's states", () => {
  test("blocking findings still succeed in advisory", () => {
    expect(
      commitStatusCompletion({
        pipelineFinished: true,
        sessionFailed: false,
        ciMode: "advisory",
        blockingCount: 2,
      }),
    ).toEqual({ phase: "success" });
  });

  test("a finished non-failed pipeline is success, with an unknown count too", () => {
    expect(
      commitStatusCompletion({
        pipelineFinished: true,
        sessionFailed: false,
        ciMode: "advisory",
        blockingCount: null,
      }),
    ).toEqual({ phase: "success" });
  });

  test("sessionFailed and a crash before pipeline return are error", () => {
    expect(
      commitStatusCompletion({
        pipelineFinished: true,
        sessionFailed: true,
        ciMode: "advisory",
        blockingCount: 0,
      }),
    ).toEqual({ phase: "error" });
    expect(
      commitStatusCompletion({
        pipelineFinished: false,
        sessionFailed: false,
        ciMode: "advisory",
        blockingCount: null,
      }),
    ).toEqual({ phase: "error" });
  });
});

describe("blockingCommitStatusRequest", () => {
  test("is failure, names the count and the unlock, and fits GitHub's description", () => {
    const request = blockingCommitStatusRequest({
      blockingCount: 2,
      targetUrl: gateTargetUrl,
      context: COMMIT_STATUS_CONTEXT,
    });
    expect(request).toEqual({
      state: "failure",
      context: COMMIT_STATUS_CONTEXT,
      description:
        "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
      targetUrl: gateTargetUrl,
    });
    expect(request.description.length).toBeLessThanOrEqual(
      COMMIT_STATUS_DESCRIPTION_MAX,
    );
  });
});

describe("skipCommitStatusRequest (S4 size and budget skips)", () => {
  test("a size skip is failure and says the review was skipped and /pr-hero review reviews it anyway", () => {
    const request = skipCommitStatusRequest({
      kind: "size",
      targetUrl: gateTargetUrl,
      context: COMMIT_STATUS_CONTEXT,
    });
    expect(request.state).toBe("failure");
    expect(request.context).toBe(COMMIT_STATUS_CONTEXT);
    expect(request.description).toContain("skipped");
    expect(request.description).toContain("size gate");
    expect(request.description).toContain("/pr-hero review reviews it anyway");
    expect(request.description.length).toBeLessThanOrEqual(
      COMMIT_STATUS_DESCRIPTION_MAX,
    );
  });

  test("a budget skip is failure with the same unlock", () => {
    const request = skipCommitStatusRequest({
      kind: "budget",
      targetUrl: gateTargetUrl,
      context: COMMIT_STATUS_CONTEXT,
    });
    expect(request.state).toBe("failure");
    expect(request.description).toContain("skipped");
    expect(request.description).toContain("CI budget");
    expect(request.description).toContain("/pr-hero review reviews it anyway");
    expect(request.description.length).toBeLessThanOrEqual(
      COMMIT_STATUS_DESCRIPTION_MAX,
    );
  });
});

describe("resolveCiMode", () => {
  test("a CI run with no explicit mode is gate", () => {
    expect(resolveCiMode(undefined, true)).toBe("gate");
  });

  test("an explicit advisory stays advisory", () => {
    expect(resolveCiMode("advisory", true)).toBe("advisory");
  });

  test("an explicit gate stays gate", () => {
    expect(resolveCiMode("gate", true)).toBe("gate");
  });

  test("a local run is advisory whatever the flag says: today's posture", () => {
    expect(resolveCiMode(undefined, false)).toBe("advisory");
    expect(resolveCiMode("gate", false)).toBe("advisory");
  });
});

describe("resolveCiPosture: the explicit --ci flag alone picks the gate and the context", () => {
  test("only --ci writes pr-hero; a run without it is advisory on pr-hero/local", () => {
    expect(resolveCiPosture({ ci: true })).toEqual({
      ciMode: "gate",
      statusContext: COMMIT_STATUS_CONTEXT,
    });
    expect(resolveCiPosture({ ci: true, ciMode: "advisory" })).toEqual({
      ciMode: "advisory",
      statusContext: COMMIT_STATUS_CONTEXT,
    });
    expect(resolveCiPosture({})).toEqual({
      ciMode: "advisory",
      statusContext: LOCAL_COMMIT_STATUS_CONTEXT,
    });
    expect(resolveCiPosture({ ci: false, ciMode: "gate" })).toEqual({
      ciMode: "advisory",
      statusContext: LOCAL_COMMIT_STATUS_CONTEXT,
    });
  });

  test("the context is the only way to write pr-hero: no non-ci posture names it", () => {
    for (const ciMode of [undefined, "gate", "advisory"] as const) {
      expect(resolveCiPosture({ ci: false, ciMode }).statusContext).toBe(
        LOCAL_COMMIT_STATUS_CONTEXT,
      );
    }
  });

  test("the local context is distinct from the gate's, and both are in the run's read set", () => {
    expect(LOCAL_COMMIT_STATUS_CONTEXT).toBe("pr-hero/local");
    expect(LOCAL_COMMIT_STATUS_CONTEXT).not.toBe(COMMIT_STATUS_CONTEXT);
    expect(RUN_STATUS_CONTEXTS).toEqual([
      COMMIT_STATUS_CONTEXT,
      LOCAL_COMMIT_STATUS_CONTEXT,
    ]);
  });
});

describe("the readers: CI yields to pr-hero only, the watcher to both", () => {
  const now = Date.parse("2026-08-18T17:00:00.000Z");
  const fresh = "2026-08-18T16:30:00.000Z";
  const localPending = {
    state: "pending",
    context: LOCAL_COMMIT_STATUS_CONTEXT,
    created_at: fresh,
  };
  const ciPending = {
    state: "pending",
    context: COMMIT_STATUS_CONTEXT,
    created_at: fresh,
  };

  test("the CI yield (default read) ignores a local pending: a CI run never stands down for a local one", () => {
    expect(isInFlightCommitStatus([localPending], now)).toBe(false);
  });

  test("the watcher's read sees a local pending and a CI pending", () => {
    expect(
      isInFlightCommitStatus(
        [localPending],
        now,
        undefined,
        RUN_STATUS_CONTEXTS,
      ),
    ).toBe(true);
    expect(
      isInFlightCommitStatus([ciPending], now, undefined, RUN_STATUS_CONTEXTS),
    ).toBe(true);
  });

  test("latestStatusInContext reads one context: a CI pending is never the local latest", () => {
    expect(
      latestStatusInContext([ciPending], LOCAL_COMMIT_STATUS_CONTEXT),
    ).toBeNull();
    expect(
      latestStatusInContext(
        [ciPending, localPending],
        LOCAL_COMMIT_STATUS_CONTEXT,
      ),
    ).toEqual(localPending);
  });
});

describe("prHtmlUrl", () => {
  test("joins the repo url to the pull path", () => {
    expect(prHtmlUrl("https://github.com/org/repo", 12)).toBe(
      "https://github.com/org/repo/pull/12",
    );
    expect(prHtmlUrl("https://github.com/org/repo/", 12)).toBe(
      "https://github.com/org/repo/pull/12",
    );
  });

  test("absent or blank repo url yields undefined", () => {
    expect(prHtmlUrl(undefined, 12)).toBeUndefined();
    expect(prHtmlUrl("  ", 12)).toBeUndefined();
  });

  test("a non-integer PR or a non-URL repo is undefined", () => {
    expect(prHtmlUrl("https://github.com/org/repo", 0)).toBeUndefined();
    expect(prHtmlUrl("not a url", 12)).toBeUndefined();
  });
});

describe("isInFlightCommitStatus", () => {
  const now = Date.parse("2026-08-18T17:00:00.000Z");
  const fresh = "2026-08-18T16:30:00.000Z";
  const stale = "2026-08-18T15:00:00.000Z";

  test("a fresh pending pr-hero status is in-flight", () => {
    expect(
      isInFlightCommitStatus(
        [
          {
            state: "pending",
            context: COMMIT_STATUS_CONTEXT,
            created_at: fresh,
          },
        ],
        now,
      ),
    ).toBe(true);
  });

  test("a pending older than the TTL is not in-flight", () => {
    expect(now - Date.parse(stale)).toBeGreaterThan(IN_FLIGHT_TTL_MS);
    expect(
      isInFlightCommitStatus(
        [
          {
            state: "pending",
            context: COMMIT_STATUS_CONTEXT,
            created_at: stale,
          },
        ],
        now,
      ),
    ).toBe(false);
  });

  test("success, other contexts, and garbage dates never skip", () => {
    expect(
      isInFlightCommitStatus(
        [
          {
            state: "success",
            context: COMMIT_STATUS_CONTEXT,
            created_at: fresh,
          },
        ],
        now,
      ),
    ).toBe(false);
    expect(
      isInFlightCommitStatus(
        [{ state: "pending", context: "ci", created_at: fresh }],
        now,
      ),
    ).toBe(false);
    expect(
      isInFlightCommitStatus(
        [
          {
            state: "pending",
            context: COMMIT_STATUS_CONTEXT,
            created_at: "not-a-date",
          },
        ],
        now,
      ),
    ).toBe(false);
    expect(isInFlightCommitStatus([], now)).toBe(false);
  });

  test("the newest pr-hero status wins, even if the list is oldest-first", () => {
    expect(
      isInFlightCommitStatus(
        [
          {
            state: "pending",
            context: COMMIT_STATUS_CONTEXT,
            created_at: "2026-08-18T16:00:00.000Z",
          },
          {
            state: "success",
            context: COMMIT_STATUS_CONTEXT,
            created_at: fresh,
          },
        ],
        now,
      ),
    ).toBe(false);
  });
});

describe("findMarkedCommentId — the re-review closing comment is never the summary", () => {
  test("a closing comment posted after the summary does not steal the summary's id", () => {
    const comments = [
      {
        id: 1,
        body: `<!-- pr-hero-report head=${"a".repeat(40)} -->\nsummary`,
      },
      {
        id: 2,
        body: `${PR_REREVIEW_CLOSED_MARKER_PREFIX}head=${"b".repeat(40)} -->\nclosed`,
      },
    ];
    expect(findMarkedCommentId(comments)).toBe(1);
  });
});

describe("commitStatusCompletion — a partial review is red in gate mode (S1, S2)", () => {
  const gate = (over: {
    blockingCount?: number | null;
    hunterCount?: number;
    hunterFailures?: number;
    ciMode?: "gate" | "advisory";
    sessionFailed?: boolean;
    noReviewerRan?: boolean;
  }) =>
    commitStatusCompletion({
      ...(over.noReviewerRan === undefined
        ? {}
        : { noReviewerRan: over.noReviewerRan }),
      pipelineFinished: true,
      sessionFailed: over.sessionFailed ?? false,
      ciMode: over.ciMode ?? "gate",
      blockingCount: over.blockingCount === undefined ? 0 : over.blockingCount,
      ...(over.hunterCount === undefined
        ? {}
        : { hunterCount: over.hunterCount }),
      ...(over.hunterFailures === undefined
        ? {}
        : { hunterFailures: over.hunterFailures }),
    });

  test("some hunters failed, none blocking: failure, carrying N and M", () => {
    expect(gate({ hunterCount: 4, hunterFailures: 1 })).toEqual({
      phase: "partial",
      failed: 1,
      total: 4,
    });
  });

  test("the exact partial text names N of M and the retry", () => {
    expect(partialReviewDescription(1, 4)).toBe(
      "pr-hero: review partial (1 of 4 hunters failed) — /pr-hero review retries it",
    );
  });

  test("a blocking count wins over a partial review: the blocking verdict stays", () => {
    expect(
      gate({ blockingCount: 2, hunterCount: 4, hunterFailures: 1 }),
    ).toEqual({ phase: "failure", blockingCount: 2 });
  });

  test("no hunter counts at all means no partial: success, as before", () => {
    expect(gate({})).toEqual({ phase: "success" });
  });

  test("zero failed hunters stays success, a skipped discovery too, but no reviewer run is error in gate mode", () => {
    // A re-review that skipped discovery: zero hunters, and a finished review.
    expect(gate({ hunterCount: 0, hunterFailures: 0 })).toEqual({
      phase: "success",
    });
    expect(
      gate({ hunterCount: 0, hunterFailures: 0, noReviewerRan: true }),
    ).toEqual({ phase: "error" });
    expect(
      gate({
        ciMode: "advisory",
        hunterCount: 0,
        hunterFailures: 0,
        noReviewerRan: true,
      }),
    ).toEqual({ phase: "success" });
    expect(gate({ hunterCount: 4, hunterFailures: 0 })).toEqual({
      phase: "success",
    });
  });

  test("a partial review is still a session failure when every hunter failed", () => {
    expect(
      gate({ sessionFailed: true, hunterCount: 4, hunterFailures: 4 }),
    ).toEqual({ phase: "error" });
  });

  test("advisory mode keeps a partial review green (S3)", () => {
    expect(
      gate({ ciMode: "advisory", hunterCount: 4, hunterFailures: 1 }),
    ).toEqual({ phase: "success" });
  });
});
