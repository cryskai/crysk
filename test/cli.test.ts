// Caller-level tests for cli.ts's remaining orchestration: main()'s
// fatal-exit wiring, the summarizer/scout activation shape, the
// gotchas/cost/discovery/ignore-rule wiring both review shells share, and
// the in-flight commit-status lock. Same fake-gh pattern as
// test/pr/pr.test.ts, extended to capture stdin (needed to tell a leftover
// W1 finding issue comment from the summary comment — both hit the same
// `issues/<pr>/comments` endpoint).
//
// The step-14 posting orchestration itself (postInlineFindings/
// postInlineIfEligible) and its pure decisions (postingExitCode,
// computeDroppedFindingIds) moved to test/pr/inline-post.test.ts alongside
// src/pr/pr.ts and src/pr/inline.ts (cli-decomp S2, Cluster C). The
// `post`/`triage`/`usage`/`doctor` verbs' own wiring tests (runPostCommand,
// runTriageCommand/runTriageReplyCommand, originUsageScope,
// runDoctorCommand) moved to test/commands/*.test.ts alongside
// src/commands/*.ts (cli-decomp S3), duplicating the doc()/finding() half of
// the fixture block below; the makeFakeGh/ndjson/OPERATOR_ROOT half stays
// here too, still needed by "CI admission reviewCount" below.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AdmissionRecord,
  serializeAdmissionRecord,
} from "#ci/admission-ledger";
import { CANCELLED_STATUS_DESCRIPTION } from "#ci/publish";
import {
  evaluateCiReviewAdmission,
  resolveCiAdmissionAttemptCount,
} from "#ci/review-admission";
import {
  ADMISSION_CHECK_RUN_NAME,
  listAdmissionCheckRuns,
  type postCommitStatus,
} from "#pr/pr";
import {
  CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
  type CommitStatusRequest,
  PR_FINDING_MARKER_PREFIX,
} from "#pr/preflight";
import type {
  CliOptions,
  NumstatDiffStat,
  NumstatFile,
  SummarySettings,
} from "#review/preflight";
import { DEFAULT_SIZE_GATE, type SizeGateConfig } from "#review/size-gate";
import {
  createRunDir,
  heldCommitStatusLock,
  holdCommitStatusLock,
  main,
  pipelineScoutInput,
  pipelineSummarizerInput,
  releaseCommitStatusLock,
  resolvePrDryRunSizeGate,
  settleHeldCommitStatusOnSignal,
} from "../src/cli";
import { canonicalRemoteId } from "../src/home-preflight";
import { readLocalIgnoreRules } from "../src/ignore-read";

// ---------------------------------------------------------------------------
// FakeGh: records every call's argv AND stdin (decoded), in order. Routes
// responses by argv predicate, same shape as test/pr/pr.test.ts's makeFakeGh —
// duplicated rather than imported: pr/pr.ts's test harness is a TEST file, and
// importing test fixtures across test files is the kind of coupling that
// breaks one suite when the other's fixture shape changes for unrelated
// reasons.

interface ScriptedResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  // Streams and exit settle only when kill() fires — the shape of a `gh`
  // call GitHub accepted and never answered. Ported from
  // test/step-runner.test.ts's makeFakeSpawn, which is how that module's
  // watchdog is exercised without a real 30-minute wait; the collapse loop's
  // watchdog needs the same lever.
  hang?: boolean;
}

interface ScriptEntry {
  match: string[];
  response?: ScriptedResponse;
  // Sequential per-call responses for the SAME matched argv (call-counting):
  // consumed in order across repeated calls to the same endpoint, the last
  // entry repeating once exhausted. Needed to simulate a re-fetch of the
  // SAME endpoint returning a DIFFERENT answer than the first fetch did —
  // e.g. a concurrent process posting a comment between this run's plan
  // snapshot and its immediately-pre-post re-fetch. `response` and
  // `responses` are mutually exclusive; `response` is a plain single-value
  // shorthand kept for every pre-existing script.
  responses?: ScriptedResponse[];
}

interface RecordedCall {
  argv: string[];
  stdin: string | undefined;
}

function argvContains(argv: string[], tokens: string[]): boolean {
  const joined = argv.join(" ");
  return tokens.every((token) => joined.includes(token));
}

function makeFakeGh(script: ScriptEntry[]): {
  spawnFn: typeof Bun.spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // gh api's create/update calls always print `{"id": N}`-shaped JSON; N
  // increments per call so two comments created in the same test never
  // collide on id.
  let nextId = 100;
  // Per-entry call counter, only consulted when an entry uses `responses`
  // (sequential) rather than `response` (single, repeats forever).
  const responseIndex = new Map<ScriptEntry, number>();
  const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
    const stdin =
      opts?.stdin === undefined ? undefined : decoder.decode(opts.stdin);
    calls.push({ argv, stdin });
    const entry = script.find((s) => argvContains(argv, s.match));
    let scripted: ScriptedResponse | undefined;
    if (entry?.responses) {
      const i = responseIndex.get(entry) ?? 0;
      scripted = entry.responses[Math.min(i, entry.responses.length - 1)];
      responseIndex.set(entry, i + 1);
    } else {
      scripted = entry?.response;
    }
    if (scripted === undefined) {
      // Default: any unscripted --method POST/PATCH create succeeds with a
      // fresh id — covers the summary create/patch without a script entry
      // per call.
      //
      // GATED on --method since GitHub #39, and the gate is the point: an
      // unscripted READ used to get `{"id":N}` too, which was harmless only
      // as long as nothing read a scalar. `ghPrHeadSha` reads one (`gh pr
      // view --json headRefOid -q .headRefOid`), and a fabricated `{"id":102}`
      // is not the reviewed sha, so every unscripted post test started
      // reporting a moved head. An unscripted read now answers with NOTHING,
      // which ghPrHeadSha reads as "could not verify" and renders as silence
      // — the honest default for a question the script never answered. Tests
      // that need a definite answer script `headRefOid` explicitly.
      scripted = argv.includes("--method")
        ? { stdout: JSON.stringify({ id: nextId++ }), exitCode: 0 }
        : { stdout: "", exitCode: 0 };
    }
    const held: ReadableStreamDefaultController<Uint8Array>[] = [];
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (scripted?.hang) {
            held.push(controller);
            return;
          }
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    const stdout = stream(scripted.stdout ?? "");
    const stderr = stream(scripted.stderr ?? "");
    if (!scripted.hang) resolveExit(scripted.exitCode ?? 0);
    return {
      stdout,
      stderr,
      exited,
      kill() {
        for (const controller of held) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
        resolveExit(143);
      },
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

function ndjson(rows: unknown[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

const OPERATOR_ROOT = "/repo";
const OLD_HEAD = "a".repeat(40);

function _findingIssueCommentPosts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (c) =>
      c.argv.join(" ").includes("issues/42/comments") &&
      c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
  );
}

function _summaryStdins(calls: RecordedCall[]): string[] {
  return calls
    .filter((c) => c.stdin?.startsWith("<!-- pr-hero-report "))
    .map((c) => c.stdin ?? "");
}

describe("CLI summarizer activation", () => {
  test("default-on activation supplies the bundled prompt and model override", () => {
    const settings: SummarySettings = { enabled: true, model: "opus" };
    expect(pipelineSummarizerInput(settings)).toEqual({
      summarizer: {
        promptPath: path.join(
          import.meta.dir,
          "..",
          "prompts",
          "summarizer.md",
        ),
        model: "opus",
      },
    });
  });

  test("--no-summary's resolved setting preserves WU2 optional absence", () => {
    expect(pipelineSummarizerInput({ enabled: false })).toEqual({});
  });
});

describe("CLI scout activation (ROADMAP-DOORDASH M5)", () => {
  const BUNDLED = path.join(import.meta.dir, "..", "prompts", "scout.md");

  test("off resolves to WU2's optional absence — the pipeline sees no scout key", () => {
    expect(pipelineScoutInput({ scout: false })).toEqual({});
    expect(pipelineScoutInput({ scout: false, scoutModel: "haiku" })).toEqual(
      {},
    );
  });

  test("on supplies the bundled prompt, and the model only when asked for", () => {
    expect(pipelineScoutInput({ scout: true })).toEqual({
      scout: { promptPath: BUNDLED },
    });
    expect(pipelineScoutInput({ scout: true, scoutModel: "haiku" })).toEqual({
      scout: { promptPath: BUNDLED, model: "haiku" },
    });
  });

  // §3.12 obligation 9, and the failure it prevents is a hard CliError on
  // EVERY run, not a subtle one: `preflightAgentsDir` treats a
  // `review-*.md` / `deep-review-*.md` file in the agents dir that the spec
  // does not name as a prompt-set mismatch and refuses to start.
  test("the prompt lives in prompts/, is not agent-named, and exists on disk", async () => {
    const resolved = (
      pipelineScoutInput({ scout: true }) as {
        scout: { promptPath: string };
      }
    ).scout.promptPath;
    const base = path.basename(resolved);
    expect(base).toBe("scout.md");
    expect(base.startsWith("review-")).toBe(false);
    expect(base.startsWith("deep-review-")).toBe(false);
    expect(path.basename(path.dirname(resolved))).toBe("prompts");
    expect(resolved).not.toContain(`${path.sep}agents${path.sep}`);
    expect(await Bun.file(resolved).exists()).toBe(true);
  });

  // Not a style check: `tools:` in this file is IGNORED by the engine
  // (pipeline.ts forces []), so a frontmatter tools line here would document
  // a capability the scout does not have and cannot get.
  test("the bundled prompt claims no tools and pins no model", async () => {
    const raw = await Bun.file(BUNDLED).text();
    const frontmatter = raw.split("---")[1] ?? "";
    expect(frontmatter).not.toContain("tools:");
    // No `model:` on purpose — DEFAULT_SCOUT_MODEL owns that seat, so the
    // file's sha256 stays the one M4 ratified.
    expect(frontmatter).not.toContain("model:");
  });
});

// review-pr-behavior-seams (Goal B): invariant 10's two scans — "every
// renderResult(/renderReport( call carries its notionalCostInput companion"
// (#173) and "every gotchas gate asks the shared predicate, and none
// re-implements the old empty-only check" — moved to
// test/architecture/review-shell-invariants.test.ts as a DIRECTORY scan over
// src/review/ and src/pr/ (plus src/doctor.ts for the gotchas-literal check,
// which sits outside both). A hardcoded file list here would go dark the
// moment either scanned file moved; the directory scan does not need to
// change when that happens, and a third review shell trips it automatically
// instead of silently going unchecked. `init`'s own gotchas-block wiring
// stays in test/commands/init.test.ts — a different topic (init's wiring,
// not the two review shells).

// review-pr-behavior-seams: the rereview-coverage fix's wiring pins (1: the
// activeHunters/discoveryHunters gate; 2: prepareDiscovery's computed
// summaryComplete; 3: buildPhaseBQueue's plan.verifyAll) moved off this
// source-text scan entirely. The whole re-review/delta-detection step
// relocated to src/pr/discovery.ts (resolvePrDiscovery + discoveryHunters) —
// an orchestrator over ALREADY-FETCHED comment data plus a small git
// adapter, which is what makes it testable with fakes even though
// reviewPr() itself has no seam for the `gh` fetches around it. See
// test/pr/discovery.test.ts: `discoveryHunters` proves 1 directly (a pure
// function of `skipDiscovery` alone); the two `resolvePrDiscovery` tests
// prove 2 and 3 TOGETHER through the real, falsifiable outcome — a partial
// last review forces `verifyAll` and queues an untouched prior for
// re-verification, a complete one does not.
//
// The CI admission gate's OWN marker-fields wiring (previously part of this
// same family) is covered separately, just above: `summaryMarkerFields` is
// shared and mutation-tested in test/watch/preflight.test.ts, with a narrow
// structural check here for the gate's own gh-backed shell (no injectable
// seam, same limitation discovery.ts's header names for its own fetches).

// review-pr-behavior-seams: invariants 5, 6 and 9 (rules threaded into the
// gate config, the dry-run degrade rule, and "no call site can drop the
// rules argument") moved OFF this source-text scan entirely.
//   - 5 & 9 are now `sizeGateConfigFor`'s own behavior — a REQUIRED third
//     parameter (unlike sizeGateConfig's own optional one), tested with a
//     real custom rule in test/review/size-gate.test.ts. Both review shells
//     call it instead of sizeGateConfig directly.
//   - 6 is `resolvePrDryRunNumstat`'s own behavior, tested through the real
//     downstream size-gate verdict in test/pr/target.test.ts.
//   - 7 & 8 (root/ref selection for `.prheroignore`) moved to
//     src/pr/range.ts (resolveEagerLocalIgnore / resolveBaseRefIgnore /
//     resolvePrFetchAndRange) and are tested in test/pr/range.test.ts: 7 with
//     a `readLocal` fake keyed by root, 8 with the same scripted-GitRunner
//     fake shape as readBaseRefIgnoreRules's own tests in
//     test/git/git.test.ts (content answered only for the RESOLVED sha).
//     resolvePrFetchAndRange's own call-site wiring keeps one narrow
//     structural check there — it is a genuine I/O shell (fetchPrRefs has no
//     offline seam), same class of limitation as the CI-admission check
//     above.

function runDirOptions(over: Partial<CliOptions> = {}): CliOptions {
  return {
    repo: ".",
    head: "HEAD",
    hopBudget: 3,
    scout: false,
    full: false,
    dryRun: false,
    yes: false,
    post: false,
    twoDot: false,
    onPush: false,
    force: false,
    all: false,
    fixes: false,
    incidents: false,
    issues: false,
    proximity: false,
    threads: false,
    ...over,
  };
}

// W4 Phase 6 remediation (sdd-verify option D): offline tests closing the
// PARTIAL scenarios the verify report flagged for the --out product fix.
// `runGit`/`tmpGitRepo` spawn a REAL git binary against a throwaway tmp dir
// — the only way to exercise gitOriginUrl/resolveRepoHome's actual decision
// (present vs. absent origin) without faking git itself. Duplicated (not
// shared) in test/commands/usage.test.ts, which needs the same fixture for
// originUsageScope's own suite (cli-decomp S3): this file's own precedent is
// to duplicate rather than import test fixtures across files.

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

async function tmpGitRepo(
  originUrl: string | null,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-git-"));
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await runGit(dir, ["config", "user.name", "Test"]);
  if (originUrl !== null) {
    await runGit(dir, ["remote", "add", "origin", originUrl]);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("createRunDir — --out product fix D (W4 Phase 6)", () => {
  test("--out on a checkout WITH origin still ingests: repoId is the canonical origin", async () => {
    const originUrl = "https://github.com/acme/widgets.git";
    const repo = await tmpGitRepo(originUrl);
    const outDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-out-"));
    try {
      const { runDir, repoId } = await createRunDir(
        runDirOptions({ out: outDir }),
        repo.dir,
        "c".repeat(40),
      );
      expect(runDir).toBe(path.resolve(outDir));
      expect(repoId).toBe(canonicalRemoteId(originUrl));
    } finally {
      await repo.cleanup();
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("--out on a checkout WITHOUT origin stays the escape hatch: repoId is null, no throw", async () => {
    const repo = await tmpGitRepo(null);
    const outDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-out-"));
    try {
      const { runDir, repoId } = await createRunDir(
        runDirOptions({ out: outDir }),
        repo.dir,
        "c".repeat(40),
      );
      expect(runDir).toBe(path.resolve(outDir));
      expect(repoId).toBeNull();
    } finally {
      await repo.cleanup();
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// prheroignore Phase 3 — the read paths (local working tree, base-ref)
// ---------------------------------------------------------------------------

describe("readLocalIgnoreRules — the working-tree read (local review, PR review without --ci)", () => {
  test("absent file: defaults only, no error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-local-"));
    try {
      expect(await readLocalIgnoreRules(dir)).toEqual({
        rules: [],
        found: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("valid file: its rules parse as user rules", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-local-"));
    try {
      await Bun.write(path.join(dir, ".prheroignore"), "vendor/**\n");
      const result = await readLocalIgnoreRules(dir);
      expect(result.found).toBe(true);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0]?.pattern).toBe("vendor/**");
      expect(result.rules[0]?.source).toBe("user");
      expect(result.rules[0]?.line).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("malformed file: loud abort naming the resolved path, line, and text — aborts the WHOLE file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-local-"));
    try {
      await Bun.write(path.join(dir, ".prheroignore"), "ok/**\n!\n");
      const ignorePath = path.join(dir, ".prheroignore");
      const escaped = ignorePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await expect(readLocalIgnoreRules(dir)).rejects.toThrow(
        new RegExp(`^${escaped}:2: .*offending line.*"!"`),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("directory named .prheroignore: loud abort, never treated as absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-local-"));
    try {
      await mkdir(path.join(dir, ".prheroignore"));
      await expect(readLocalIgnoreRules(dir)).rejects.toThrow(
        /is not a regular file/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unreadable file (permission denied): loud abort, never treated as absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-local-"));
    const ignorePath = path.join(dir, ".prheroignore");
    try {
      await Bun.write(ignorePath, "vendor/**\n");
      await chmod(ignorePath, 0o000);
      await expect(readLocalIgnoreRules(dir)).rejects.toThrow(
        /could not be read/,
      );
    } finally {
      await chmod(ignorePath, 0o644).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// PR1b Addition 1 (#5557): the aggregate-only dry-run estimate cannot express
// exclusions at all — no per-file paths, so `.prheroignore` widens what was
// already a "wrong in the conservative direction" gap from tens of lines
// (lockfiles) to potentially thousands (a whole ignored directory). Ported
// from watch/watch.ts's tier-2 pattern: when gh's per-file list is TRUSTWORTHY (not
// truncated), evaluate the real per-file gate; otherwise fall back to the
// aggregate estimate and label it.
describe("resolvePrDryRunSizeGate — the PR --dry-run size-gate estimate (Addition 1)", () => {
  const gateConfig: SizeGateConfig = {
    ...DEFAULT_SIZE_GATE,
    maxChangedLines: 1500,
    excludeRules: [
      {
        pattern: "openspec/**",
        negated: false,
        globs: ["**/openspec/**"],
        source: "user",
        line: 1,
      },
    ],
  };

  function file(path: string, lines: number): NumstatFile {
    return { path, insertions: lines, deletions: 0, binary: false };
  }

  test("per-file data available: excluded files are subtracted BEFORE the limit check (the central scenario)", () => {
    // 29 files x 100 lines under openspec/ (excluded) + one 100-line file —
    // 3000 raw lines, 100 effective. The aggregate-only estimate would SKIP a
    // PR the real per-file gate accepts; this is exactly that reproduction.
    const perFile: NumstatFile[] = [
      ...Array.from({ length: 29 }, (_, i) =>
        file(`openspec/changes/thing/f${i}.md`, 100),
      ),
      file("src/cli.ts", 100),
    ];
    const ghDiffStat: NumstatDiffStat = {
      files: 30,
      insertions: 3000,
      deletions: 0,
    };
    const result = resolvePrDryRunSizeGate({ ghDiffStat, perFile, gateConfig });
    expect(result.verdict.ok).toBe(true);
    if (result.verdict.ok) {
      expect(result.verdict.effectiveLines).toBe(100);
      expect(result.verdict.excludedFiles).toBe(29);
    }
    expect(result.note).not.toContain("truncated");
  });

  test("per-file list is null (truncated/unavailable): falls back to the aggregate estimate, labelled", () => {
    const ghDiffStat: NumstatDiffStat = {
      files: 30,
      insertions: 3000,
      deletions: 0,
    };
    const result = resolvePrDryRunSizeGate({
      ghDiffStat,
      perFile: null,
      gateConfig,
    });
    // The aggregate path cannot apply exclusions at all — same reproduction
    // as above, but this time the SKIP is real: gh's own truncated list left
    // no trustworthy per-file answer to fall back on.
    expect(result.verdict.ok).toBe(false);
    expect(result.note).toContain("truncated");
  });

  test("small PR: both per-file and aggregate agree it passes", () => {
    const perFile: NumstatFile[] = [file("src/a.ts", 10)];
    const ghDiffStat: NumstatDiffStat = {
      files: 1,
      insertions: 10,
      deletions: 0,
    };
    const result = resolvePrDryRunSizeGate({ ghDiffStat, perFile, gateConfig });
    expect(result.verdict.ok).toBe(true);
  });
});

// Pillar 3 Phase 5, gap closure #2: reportFatalCiError above is only reached
// from runCli()'s catch, which fires only for errors that ESCAPE main(). But
// main() catches and RETURNS for the two failures docs/github-actions.md
// names as the reasons this job can go red — a malformed argument (parseArgs
// throws, exit 2) and a CliError/CliUsageError from a command body (exit 1,
// which is exactly what a bad or expired GITHUB_TOKEN produces, since pr/pr.ts
// raises CliError for `gh not found` and for a failed `gh pr view`). Neither
// ever reached runCli's catch, so a consumer workflow branching on
// `outputs.status == 'error'` saw `status` completely unset — indistinguishable
// from a step whose outputs were never read.
describe("main — status=error on the exits that never reached runCli's catch", () => {
  let savedOutput: string | undefined;
  let savedStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    savedOutput = process.env.GITHUB_OUTPUT;
    // main() prints HELP_TEXT and error lines; swallow them so the suite's
    // output stays readable. Restored in afterEach.
    savedStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = savedStderrWrite;
    // The suite itself may be RUNNING inside GitHub Actions, where
    // GITHUB_OUTPUT is genuinely set — restore exactly, and delete when it
    // was absent, or the "not a job step" case below silently tests nothing.
    if (savedOutput === undefined) {
      process.env.GITHUB_OUTPUT = undefined;
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = savedOutput;
    }
  });

  test("a malformed argument writes status=error and still exits 2", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-main-parse-"));
    const outputPath = path.join(dir, "github_output");
    process.env.GITHUB_OUTPUT = outputPath;
    try {
      const code = await main(["review", "--no-such-flag"]);
      expect(code).toBe(2);
      expect(await Bun.file(outputPath).text()).toContain("status=error\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a CliError from a command body writes status=error and still exits 1", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-main-clierror-"));
    const outputPath = path.join(dir, "github_output");
    const notARepo = path.join(dir, "not-a-repo");
    await mkdir(notARepo, { recursive: true });
    process.env.GITHUB_OUTPUT = outputPath;
    try {
      // resolveRepoRoot is postCommand's first statement and throws CliError
      // ("not a git repository") — no network, no agent spawn, one failing
      // `git rev-parse`.
      const code = await main([
        "post",
        "--pr",
        "5",
        "--from",
        dir,
        "--repo",
        notARepo,
      ]);
      expect(code).toBe(1);
      expect(await Bun.file(outputPath).text()).toContain("status=error\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("outside a job step ($GITHUB_OUTPUT unset) neither exit writes anything", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-main-local-"));
    const notARepo = path.join(dir, "not-a-repo");
    await mkdir(notARepo, { recursive: true });
    process.env.GITHUB_OUTPUT = undefined;
    delete process.env.GITHUB_OUTPUT;
    try {
      expect(await main(["review", "--no-such-flag"])).toBe(2);
      expect(
        await main(["post", "--pr", "5", "--from", dir, "--repo", notARepo]),
      ).toBe(1);
      // Nothing to assert a file against — the point is that the local exit
      // codes are untouched and no write is attempted at all.
      expect(process.env.GITHUB_OUTPUT).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CI admission reviewCount — ledger check runs feed admission", () => {
  test("resolveCiAdmissionAttemptCount uses terminal ledger rows from check-runs", async () => {
    const head = "e".repeat(40);
    const policyHash = "policyhash123456";
    const record: AdmissionRecord = {
      schemaVersion: 1,
      prNumber: 42,
      headSha: head,
      policyHash,
      reservationId: "reservation123456",
      attemptNumber: 1,
      status: "failed",
      decisionReason: "provider failed",
      priorScore: null,
      blockingCount: null,
      advisoryCount: null,
      workflowRunId: null,
      createdAt: "2026-08-28T12:00:00.000Z",
      settledAt: "2026-08-28T12:05:00.000Z",
    };
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["check-runs"],
        response: {
          stdout: ndjson([
            {
              id: 77,
              name: ADMISSION_CHECK_RUN_NAME,
              status: "completed",
              output: { text: serializeAdmissionRecord(record) },
            },
          ]),
        },
      },
    ]);
    const ledgerRecords = await listAdmissionCheckRuns(OPERATOR_ROOT, head, {
      spawnFn,
    });
    expect(ledgerRecords).toEqual([record]);
    expect(calls[0]?.argv.join(" ")).toContain(`commits/${head}/check-runs`);

    const reviewCount = resolveCiAdmissionAttemptCount({
      stateCount: 0,
      workflowHeads: new Set<string>(),
      ledgerRecords,
    });
    expect(reviewCount).toBe(1);

    const exhausted = evaluateCiReviewAdmission({
      currentHead: "f".repeat(40),
      summaryHead: OLD_HEAD,
      markerSeen: true,
      reviewCount: 2,
      state: null,
      admission: null,
      postedFindings: null,
      policy: {
        schemaVersion: 1,
        mode: "risk_aware",
        maxAttempts: 2,
        rereviewMinScore: 4,
        blockingWeight: 2,
        advisoryWeight: 1,
        reservationTtlSeconds: 3600,
      },
      deltaTouchesPriorFindings: false,
      deltaRisk: null,
    });
    expect(exhausted.action).toBe("manual-required");
  });
});

describe("the in-flight commit-status lock this process holds", () => {
  const lock = {
    operatorRoot: "/repo",
    sha: "c".repeat(40),
    targetUrl: "https://github.com/org/repo/pull/162",
  };

  afterEach(() => {
    releaseCommitStatusLock();
  });

  test("nothing is held before a pending is published", () => {
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("holding records exactly what settling needs", () => {
    holdCommitStatusLock(lock);
    expect(heldCommitStatusLock()).toEqual(lock);
  });

  test("releasing clears it, so the normal settle cannot leave it set", () => {
    holdCommitStatusLock(lock);
    releaseCommitStatusLock();
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("releasing twice is a no-op", () => {
    holdCommitStatusLock(lock);
    releaseCommitStatusLock();
    releaseCommitStatusLock();
    expect(heldCommitStatusLock()).toBeNull();
  });
});

describe("settleHeldCommitStatusOnSignal", () => {
  const lock = {
    operatorRoot: "/repo",
    sha: "d".repeat(40),
    targetUrl: "https://github.com/org/repo/pull/162",
  };

  afterEach(() => {
    releaseCommitStatusLock();
  });

  function recordingPoster(): {
    post: typeof postCommitStatus;
    calls: {
      operatorRoot: string;
      sha: string;
      request: CommitStatusRequest;
      options: unknown;
    }[];
  } {
    const calls: {
      operatorRoot: string;
      sha: string;
      request: CommitStatusRequest;
      options: unknown;
    }[] = [];
    const post = (async (
      operatorRoot: string,
      sha: string,
      request: CommitStatusRequest,
      _spawnFn?: unknown,
      options?: unknown,
    ) => {
      calls.push({ operatorRoot, sha, request, options });
    }) as unknown as typeof postCommitStatus;
    return { post, calls };
  }

  test("holding nothing posts nothing", async () => {
    const { post, calls } = recordingPoster();
    await settleHeldCommitStatusOnSignal(post);
    expect(calls).toHaveLength(0);
  });

  test("settles the held sha with one bounded attempt", async () => {
    holdCommitStatusLock(lock);
    const { post, calls } = recordingPoster();
    await settleHeldCommitStatusOnSignal(post);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.operatorRoot).toBe(lock.operatorRoot);
    expect(calls[0]?.sha).toBe(lock.sha);
    expect(calls[0]?.request.state).toBe("error");
    expect(calls[0]?.request.description).toBe(CANCELLED_STATUS_DESCRIPTION);
    expect(calls[0]?.options).toEqual({
      attempts: 1,
      timeoutMs: CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
    });
  });

  test("take-and-clear: a second signal posts nothing", async () => {
    // Actions cancels with SIGINT and follows with SIGTERM before the grace
    // period ends. Both handlers can be in flight at once, and the lock must
    // be claimed before the await, not after it.
    holdCommitStatusLock(lock);
    const { post, calls } = recordingPoster();
    await Promise.all([
      settleHeldCommitStatusOnSignal(post),
      settleHeldCommitStatusOnSignal(post),
    ]);
    expect(calls).toHaveLength(1);
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("a failing settle never escapes the handler", async () => {
    holdCommitStatusLock(lock);
    const post = (async () => {
      throw new Error("missing permission (HTTP 403)");
    }) as unknown as typeof postCommitStatus;
    await expect(settleHeldCommitStatusOnSignal(post)).resolves.toBeUndefined();
  });
});

// T2c unit A (odd/tasks/agent-first-ci.md, S3): the fatal exits of main() leave
// cli.json in action mode. An early validation (a malformed argument) writes
// nothing: it is a pre-review exit the publisher reads as stopped-before-reporting.
describe("main — the outcome record in action mode", () => {
  let savedOutcome: string | undefined;
  let savedStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    savedOutcome = process.env.PRHERO_OUTCOME_DIR;
    savedStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = savedStderrWrite;
    if (savedOutcome === undefined) {
      delete process.env.PRHERO_OUTCOME_DIR;
    } else {
      process.env.PRHERO_OUTCOME_DIR = savedOutcome;
    }
  });

  test("a CliError from a command body records error, unclassified, and still exits 1", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-main-record-"));
    const outcome = path.join(dir, "outcome");
    const notARepo = path.join(dir, "not-a-repo");
    await mkdir(notARepo, { recursive: true });
    process.env.PRHERO_OUTCOME_DIR = outcome;
    try {
      const code = await main([
        "post",
        "--pr",
        "5",
        "--from",
        dir,
        "--repo",
        notARepo,
      ]);
      expect(code).toBe(1);
      const record = JSON.parse(
        await Bun.file(path.join(outcome, "cli.json")).text(),
      );
      expect(record).toEqual({
        v: 1,
        outcome: "error",
        cls: { kind: "unknown" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a malformed argument writes no record and still exits 2", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-main-noparse-"));
    const outcome = path.join(dir, "outcome");
    await mkdir(outcome, { recursive: true });
    process.env.PRHERO_OUTCOME_DIR = outcome;
    try {
      expect(await main(["review", "--no-such-flag"])).toBe(2);
      expect(await Bun.file(path.join(outcome, "cli.json")).exists()).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // runCli's catch calls process.exit, so no test can reach it. This pins the
  // write's place instead: the record is written inside that catch, before the
  // rethrow that a local run takes when $GITHUB_OUTPUT is unset.
  test("runCli's catch writes the fatal record before any rethrow", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../src/cli.ts"),
    ).text();
    const runCliAt = source.indexOf("export async function runCli(");
    const writeAt = source.indexOf("writeFatalCliRecord(", runCliAt);
    const rethrowAt = source.indexOf("throw error;", runCliAt);
    expect(runCliAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(runCliAt);
    expect(rethrowAt).toBeGreaterThan(writeAt);
  });
});
