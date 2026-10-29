// The git domain: the shared `git()` spawn wrapper, the base-ref
// `.prheroignore` read, and the local-mode git-derived resolvers (repo root,
// remote base, diff-from range, remote/result links) that used to live
// duplicated across cli.ts and six other shells (store/gc.ts, home.ts,
// pr/pr.ts, watch/watch.ts, pr/reverts.ts, corpus/corpus.ts). Every consumer
// now imports from here instead of carrying its own copy.
//
// Pure extraction: every WHY comment below is carried over verbatim from
// cli.ts, unchanged in meaning or behavior.

import path from "node:path";
import type {
  BaseRefResolution,
  CliOptions,
  LocalConfig,
} from "#review/preflight";
import { dim, markerRowLines } from "#ui/primitives";
import type { ResultLinks } from "#ui/result";
import { IGNORE_FILE_NAME, LEGACY_IGNORE_FILE_NAME } from "../brand-paths";
import { CliError } from "../errors";
import {
  IgnoreFileError,
  parseIgnoreFile,
  parseIgnoreLsTree,
} from "../ignore-file";
import {
  type IgnoreFileReadResult,
  reContextualizeIgnoreError,
} from "../ignore-read";
import {
  headContainedInBaseMessage,
  isFullCommitId,
  listPaths,
  parseRemoteHead,
  repoWebUrlFromRemote,
  resolveBaseRef,
} from "./refs";

// Exclusions are a MUTATION of the reviewed diff, so they are stated out
// loud: an operator who is told "3 files reviewed" must be able to see that
// two more were dropped, and where the unfiltered bytes went. It sits in the
// decision block because an exclusion is what the size gate's numbers were
// computed after.
//
// "excluded file(s)", not "generated file(s)": the 9 built-in defaults are
// generated content, but a ignore-file user rule can drop anything —
// this line describes what happened to the diff, not why the operator chose
// to.
export function exclusionLines(
  droppedPaths: string[],
  styles: boolean,
  width: number,
): string[] {
  if (droppedPaths.length === 0) return [];
  return markerRowLines(
    "!",
    `exclusions: ${droppedPaths.length} excluded file(s) dropped from the ` +
      `reviewed diff (${listPaths(droppedPaths)}); the unfiltered diff is ` +
      "kept as diff.raw.patch",
    dim,
    styles,
    width,
  );
}

export async function git(
  repo: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // Args as an ARRAY, never an interpolated shell string: `base` and `head`
  // are user input that reaches git verbatim, and a shell in the middle would
  // turn a branch name into an execution surface.
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

// ---------------------------------------------------------------------------
// ignore-file reads (ROADMAP prheroignore, Phase 3): local working tree
// and base-ref, mirroring the gotchas read's shape but never its fallback —
// a lookup failure here must never silently fall back to defaults-only, and
// a malformed file aborts the WHOLE review before any spend (same register
// as gotchasErrorMessage).

// The git runner shape `readBaseRefIgnoreRules` needs — the private `git()`
// above has no injectable seam of its own (unlike `gh()`'s `spawnFn`), so
// this function takes one explicitly and production wiring passes `git`
// itself; tests pass a scripted fake.
export type GitRunner = (
  repo: string,
  args: string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

// Base-ref read (CI mode) — design D2: `ls-tree` then `cat-file`, never
// `git show`, because `git show <ref>:<path>` exits 128 for BOTH an absent
// file and a bad rev, and this needs to tell those apart without parsing
// stderr. `ls-tree` alone does: exit 0 + empty stdout is absent (normal,
// defaults apply); non-zero exit is a genuine lookup failure.
//
// NEVER falls back to the working tree on any failure branch: the entire
// point of a base-ref read is that the PR author cannot choose which
// the ignore file governs their own review (design D1), and a fallback here
// would silently reopen that hole the moment the lookup itself failed —
// trading a loud, cheap abort for a quiet, expensive one.
export async function readBaseRefIgnoreRules(
  runGit: GitRunner,
  repo: string,
  baseSha: string,
): Promise<IgnoreFileReadResult> {
  // .cryskignore wins; the legacy .prheroignore is read only when the new name
  // is ABSENT at this ref. A .cryskignore that is present but unusable aborts
  // (inside the helper) instead of falling through to the old file.
  for (const name of [IGNORE_FILE_NAME, LEGACY_IGNORE_FILE_NAME]) {
    const read = await readBaseRefIgnoreFile(runGit, repo, baseSha, name);
    if (read !== undefined) return read;
  }
  return { rules: [], found: false };
}

// One name's ls-tree + cat-file; undefined when it is absent at the ref.
async function readBaseRefIgnoreFile(
  runGit: GitRunner,
  repo: string,
  baseSha: string,
  name: string,
): Promise<IgnoreFileReadResult | undefined> {
  // `--full-tree` makes the pathspec repo-root-relative regardless of what
  // `repo` itself is cwd-ed to — see D2.
  const lsTree = await runGit(repo, [
    "ls-tree",
    "--full-tree",
    baseSha,
    "--",
    name,
  ]);
  if (!lsTree.ok) {
    throw new CliError(
      `${name} lookup failed at ${baseSha}: git ls-tree exited ` +
        `non-zero — ${lsTree.stderr.trim()}`,
    );
  }
  const parsed = parseIgnoreLsTree(lsTree.stdout);
  if (parsed.kind === "absent") return undefined;
  if (parsed.kind === "reject") {
    // A root SYMLINK commits as mode 120000 with type `blob` (verified in a
    // scratch repo — see #5518): a type check alone would pass it through,
    // and `cat-file blob` on it returns the link TARGET (e.g. `/etc/passwd`)
    // for the parser to read as ignore patterns. Only the mode allowlist
    // (100644/100755) catches it; 040000 (tree/submodule-as-directory) and
    // 160000 (gitlink) are rejected the same way.
    throw new CliError(
      `${name} at ${baseSha} has mode ${parsed.mode}, not a regular ` +
        "file (100644/100755); refusing to read it as ignore rules",
    );
  }
  // parsed.kind === "blob". The sha came back from a subprocess, so it is
  // still untrusted input here — validated before it is handed to a SECOND
  // git invocation.
  if (!isFullCommitId(parsed.sha)) {
    throw new CliError(
      `${name} blob sha from git ls-tree is not a 40-hex sha: ` +
        JSON.stringify(parsed.sha),
    );
  }
  const catFile = await runGit(repo, ["cat-file", "blob", parsed.sha]);
  if (!catFile.ok) {
    throw new CliError(
      `${name} blob read failed at ${baseSha}: git cat-file exited ` +
        `non-zero — ${catFile.stderr.trim()}`,
    );
  }
  try {
    return {
      rules: parseIgnoreFile(catFile.stdout, "user", name),
      found: true,
    };
  } catch (error) {
    if (error instanceof IgnoreFileError) {
      throw new CliError(
        reContextualizeIgnoreError(error, `${baseSha}:${name}`),
      );
    }
    throw error;
  }
}

export async function gitCommitExists(
  repo: string,
  sha: string,
): Promise<boolean> {
  const result = await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  return result.ok;
}

export async function gitIsAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await git(repo, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  return result.ok;
}

// Parses `git diff --name-only` output: dedupes, drops blanks, sorts. It lived
// in rereview/prepare.ts until the git adapter was extracted, at which point
// keeping it there inverted the dependency -- this module is the bottom layer
// and would have been importing a feature domain to read git's own output.
export function parseNameOnly(stdout: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const path = line.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  out.sort();
  return out;
}

export async function gitNameOnly(
  repo: string,
  from: string,
  to: string,
): Promise<string[]> {
  const result = await git(repo, ["diff", "--name-only", `${from}..${to}`]);
  if (!result.ok) {
    throw new CliError(`git diff --name-only failed: ${result.stderr.trim()}`);
  }
  return parseNameOnly(result.stdout);
}

export async function gitNameStatus(
  repo: string,
  from: string,
  to: string,
): Promise<string> {
  const result = await git(repo, ["diff", "--name-status", `${from}..${to}`]);
  if (!result.ok) {
    throw new CliError(
      `git diff --name-status failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

export async function resolveCommit(
  repo: string,
  rev: string,
): Promise<string> {
  // `--end-of-options` stops a ref that starts with a dash from being read as
  // an option; `^{commit}` forces a tag or annotated object down to the
  // commit it points at.
  const result = await git(repo, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${rev}^{commit}`,
  ]);
  const sha = result.stdout.trim();
  if (!result.ok || !isFullCommitId(sha)) {
    throw new CliError(
      `cannot resolve "${rev}" to a commit in ${repo}` +
        (result.stderr.trim() ? `: ${result.stderr.trim()}` : ""),
    );
  }
  return sha;
}

// The repo's web url from the remote already on disk — no `gh`, no network,
// no cost, which is precisely why the terminal can afford a link on EVERY run
// and not only on a `--post` one (see repoWebUrlFromRemote's WHY). Cosmetic by
// contract, same as ghRepoWebUrl: any failure returns undefined and the block
// prints plain locations.
export async function gitRemoteWebUrl(
  repo: string,
): Promise<string | undefined> {
  const remote = await git(repo, ["remote", "get-url", "origin"]);
  if (!remote.ok) return undefined;
  return repoWebUrlFromRemote(remote.stdout);
}

// Local mode's links, and the ONE extra condition PR mode does not need: a PR
// head was fetched from origin, so it is pushed by construction, but a local
// `--head HEAD` is usually a commit that exists only here — and a blob link to
// an unpushed commit is a 404. `git branch -r --contains` answers "does any
// remote-tracking ref already contain this commit" from the local object db:
// free, offline, and the only thing standing between the block and a dead link.
//
// Safe because local mode reviews a COMMITTED range (`diffFromSha..headSha`,
// step 8) — every finding's line lives in headSha itself, so a link pinned to
// that sha points at the bytes the hunters actually read. Were the working
// tree ever reviewed directly, containment would prove nothing and this would
// have to go back to printing no links at all.
export async function localResultLinks(
  repoRoot: string,
  headSha: string,
): Promise<ResultLinks | undefined> {
  const webUrl = await gitRemoteWebUrl(repoRoot);
  if (webUrl === undefined) return undefined;
  const contains = await git(repoRoot, ["branch", "-r", "--contains", headSha]);
  if (!contains.ok || contains.stdout.trim().length === 0) return undefined;
  return { webUrl, headSha };
}

export async function resolveRepoRoot(repoOption: string): Promise<string> {
  const repoArg = path.resolve(repoOption);
  const toplevel = await git(repoArg, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    throw new CliError(`not a git repository: ${repoArg}`);
  }
  return toplevel.stdout.trim();
}

// The one git call the pure resolver cannot make. `symbolic-ref --quiet` exits
// non-zero when origin/HEAD is unset — normal on a local-only clone — so a
// failure here means "no remote head", not an error worth stopping for.
export async function remoteHeadRef(
  repoRoot: string,
): Promise<string | undefined> {
  const result = await git(repoRoot, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  return result.ok ? parseRemoteHead(result.stdout) : undefined;
}

export async function resolveBase(
  repoRoot: string,
  options: CliOptions,
  config: LocalConfig,
): Promise<BaseRefResolution> {
  // Only ask git when the answer can still change it: a flag or a configured
  // default_base already decides the ref, and a subprocess whose result is
  // discarded is just latency.
  const needsRemote = !options.base && !config.default_base;
  return resolveBaseRef({
    flag: options.base,
    configDefaultBase: config.default_base,
    remoteHead: needsRemote ? await remoteHeadRef(repoRoot) : undefined,
  });
}

// THE range fix. `git diff base..head` is a two-POINT diff: once base has
// advanced past the branch point, every commit base gained since shows up in
// the review as a REVERSED change the branch never made. Measured on the real
// target repo: for a branch already merged into `dev`, `git diff dev..branch`
// reported 111 files and 6175 deletions belonging to other people's work,
// while the correct range was empty.
//
// So the default diffs from the MERGE BASE (equivalent to `base...head`), and
// the merge-base commit is resolved EXPLICITLY rather than left implicit in a
// three-dot range: the plan has to print it, and the recorded base_sha has to
// be the commit the review was actually computed against.
//
// A failure here is unrelated histories, and it fails loud: silently falling
// back to the two-dot range would reintroduce exactly the bug this replaces.
export async function resolveDiffFrom(
  repoRoot: string,
  twoDot: boolean,
  baseLabel: string,
  headLabel: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  if (twoDot) return baseSha;
  const result = await git(repoRoot, ["merge-base", baseSha, headSha]);
  const sha = result.stdout.trim();
  if (!result.ok || !isFullCommitId(sha)) {
    throw new CliError(
      `no merge base between ${baseLabel} (${baseSha}) and ${headLabel} ` +
        `(${headSha})` +
        (result.stderr.trim() ? `: ${result.stderr.trim()}` : "") +
        ". The histories are unrelated, so there is no branch point to " +
        "review from. Pick a --base that shares history, or pass --two-dot " +
        "to diff the literal two-point range anyway.",
    );
  }
  if (sha === headSha) {
    throw new CliError(headContainedInBaseMessage(baseLabel, headLabel));
  }
  return sha;
}
