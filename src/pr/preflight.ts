// Everything PR mode (ROADMAP B1) must decide beyond what local mode already
// decides, expressed as pure functions so it is all testable offline — same
// contract as review/preflight.ts: nothing here touches the filesystem, git, gh, or
// the network. cli.ts and pr/pr.ts are the I/O shells that act on these.
//
// PR mode splits "the repo" into two roots, and every decision below names
// the one it serves:
//   - the OPERATOR root: the --repo checkout. Owns .prhero/ trust
//     (config+gotchas) and gh. Never reviewed. Worktree add/fetch and the
//     default run dir now hang off the global ~/.prhero/ home (W3 / #24),
//     keyed by origin, with one git-dir owner per remote.
//   - the REVIEW root: a detached worktree at the PR's head. The pipeline's
//     cwd, the tree the codegraph index describes. Never trusted for config.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CANCELLED_STATUS_DESCRIPTION } from "#ci/publish";
import type {
  Bucket,
  ComparisonResult,
  PrHeroFindingRef,
} from "#compare/compare";
import type { GreptileFinding } from "#compare/greptile";
import { isFullCommitId } from "#git/refs";
import type { RunStatus } from "#review/findings";
import {
  assertOutsideRepo,
  type CliOptions,
  type NumstatDiffStat,
  type NumstatFile,
} from "#review/preflight";
import {
  evaluateSizeGate,
  evaluateSizeGateAggregate,
  type SizeGateConfig,
  type SizeGateVerdict,
} from "#review/size-gate";
import { CliError, CliUsageError } from "../errors";

export type PrState = "OPEN" | "CLOSED" | "MERGED";

// Where the base rev came from. Printed in the plan for the same reason
// BaseRefResolution.source exists: a base derived from the merge commit and
// one read off the base branch carry very different guarantees.
export type PrBaseSource = "merge-commit-parent" | "base-branch";

export interface PrTarget {
  number: number;
  title: string;
  state: PrState;
  headSha: string;
  // A rev EXPRESSION, not always a sha: for a merged PR it is
  // `<mergeCommit>^1`, canonicalized to a full sha by the shell's rev-parse
  // helper after the fetch.
  baseRef: string;
  // The branch the PR targets. The fetch needs it by name (see fetchPrRefs
  // in pr/pr.ts), so it rides along with the resolved rev.
  baseRefName: string;
  baseSource: PrBaseSource;
  // GitHub's own counters projected into the numstat shape, so a --dry-run
  // can print a cost band before anything is fetched.
  ghDiffStat: NumstatDiffStat;
}

// Parses the raw stdout of `gh pr view <n> --json number,title,state,
// headRefOid,baseRefName,baseRefOid,mergeCommit,additions,deletions,
// changedFiles`. Every field is validated loudly and names itself when it is
// missing or mistyped: a PR record read wrong reviews a range nobody asked
// for, and gh's output is still input from outside this process.
export function resolvePrTarget(raw: string): PrTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `gh pr view returned invalid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError("gh pr view must return a single JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const number = readCount(record, "number");
  if (number < 1) {
    throw new CliUsageError(
      `gh pr view "number" must be positive, got: ${number}`,
    );
  }
  const title = readString(record, "title");
  const state = readString(record, "state");
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
    throw new CliUsageError(
      `gh pr view "state" must be OPEN, CLOSED or MERGED, got: ` +
        JSON.stringify(state),
    );
  }
  const headSha = readSha(record, "headRefOid");
  const baseRefName = readString(record, "baseRefName");
  const ghDiffStat: NumstatDiffStat = {
    files: readCount(record, "changedFiles"),
    insertions: readCount(record, "additions"),
    deletions: readCount(record, "deletions"),
  };

  if (state === "MERGED") {
    // WHY the merge commit's FIRST PARENT and never baseRefOid: for a merged
    // PR, baseRefOid is the base branch tip as it stands TODAY — it has
    // moved past the merge, and diffing from it reproduces exactly the
    // reversed-range bug the merge-base default fixed (see resolveDiffFrom
    // in cli.ts). `mergeCommit^1` is base as it was when the PR landed, for
    // merge, squash, and rebase merges alike.
    const mergeOid = readMergeCommitOid(record);
    if (mergeOid === null) {
      // Should not happen. Guessing a base here would silently review a
      // range GitHub never showed anyone, so refuse instead.
      throw new CliError(
        `PR ${number} is MERGED but gh reports no mergeCommit — cannot ` +
          "derive the base it was merged into; refusing to guess",
      );
    }
    return {
      number,
      title,
      state,
      headSha,
      baseRef: `${mergeOid}^1`,
      baseRefName,
      baseSource: "merge-commit-parent",
      ghDiffStat,
    };
  }
  // OPEN, or CLOSED without merging: the base tip recorded on the PR is the
  // honest endpoint, and the merge-base step downstream trims it to the
  // branch point exactly as local mode does.
  return {
    number,
    title,
    state,
    headSha,
    baseRef: readSha(record, "baseRefOid"),
    baseRefName,
    baseSource: "base-branch",
    ghDiffStat,
  };
}

// Parses the stdout of the NO-ARGUMENT `gh pr view --json number`, which gh
// resolves against the checkout's current branch — the call behind bare
// `--pr`. Same loud register as resolvePrTarget: a mis-read number would
// review a PR nobody is standing on.
export function resolveCurrentPrNumber(raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `gh pr view returned invalid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError("gh pr view must return a single JSON object");
  }
  const number = (parsed as Record<string, unknown>).number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new CliUsageError(
      `gh pr view "number" must be a positive integer, got: ` +
        JSON.stringify(number),
    );
  }
  return number;
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliUsageError(
      `gh pr view "${field}" must be a non-empty string, got: ` +
        JSON.stringify(value),
    );
  }
  return value;
}

function readSha(record: Record<string, unknown>, field: string): string {
  const value = readString(record, field);
  if (!isFullCommitId(value)) {
    throw new CliUsageError(
      `gh pr view "${field}" must be a full 40-hex commit id, got: ` +
        JSON.stringify(value),
    );
  }
  return value;
}

function readCount(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CliUsageError(
      `gh pr view "${field}" must be a non-negative integer, got: ` +
        JSON.stringify(value),
    );
  }
  return value;
}

function readMergeCommitOid(record: Record<string, unknown>): string | null {
  const value = record.mergeCommit;
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(
      'gh pr view "mergeCommit" must be null or an object with "oid"',
    );
  }
  const oid = (value as Record<string, unknown>).oid;
  if (typeof oid !== "string" || !isFullCommitId(oid)) {
    throw new CliUsageError(
      `gh pr view "mergeCommit.oid" must be a full 40-hex commit id, got: ` +
        JSON.stringify(oid),
    );
  }
  return oid;
}

// PR-mode variant of runDirCandidate: the PR number leads so runs of the
// same PR sort together, and the head sha still pins WHICH bytes the run
// reviewed — a re-review after a force-push gets a new name, never a
// collision with the old evidence.
export function prRunDirCandidate(
  root: string,
  pr: number,
  headSha: string,
  n: number,
): string {
  return path.join(root, `pr-${pr}-${headSha.slice(0, 8)}-${n}`);
}

// PR-mode twin of createRunDir, differing in exactly two ways: the candidate
// carries the PR number, and the outside-the-repo assertion runs against
// BOTH roots — artifacts inside either tree would contaminate a review.
export async function createPrRunDir(
  options: CliOptions,
  operatorRoot: string,
  worktreePath: string,
  runsRoot: string,
  prNumber: number,
  headSha: string,
): Promise<string> {
  const dir = predictPrRunDir(
    options,
    operatorRoot,
    worktreePath,
    runsRoot,
    prNumber,
    headSha,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

// The same resolution WITHOUT the mkdir, because a PR-mode --dry-run must
// create nothing at all (local mode's dry run does create its run dir; PR
// mode deliberately does not) — yet the plan should still print the exact
// dir a confirmed run would use, and an --out that violates the containment
// rule should still fail inside the free dry run.
export function predictPrRunDir(
  options: CliOptions,
  operatorRoot: string,
  worktreePath: string,
  runsRoot: string,
  prNumber: number,
  headSha: string,
): string {
  if (options.out) {
    const explicit = path.resolve(options.out);
    assertOutsideRepo(explicit, operatorRoot);
    assertOutsideRepo(explicit, worktreePath);
    return explicit;
  }
  const root = runsRoot;
  // Smallest unused integer, same reason as createRunDir: a run that cost
  // money is evidence and must never be overwritten.
  for (let n = 1; ; n++) {
    const candidate = prRunDirCandidate(root, prNumber, headSha, n);
    if (existsSync(candidate)) continue;
    assertOutsideRepo(candidate, operatorRoot);
    assertOutsideRepo(candidate, worktreePath);
    return candidate;
  }
}

export interface PrDryRunSizeGateResult {
  verdict: SizeGateVerdict;
  note: string;
}

// PR1b Addition 1 (#5557): the PR `--dry-run` size-gate estimate, fixed to
// use per-file data when it is trustworthy — pure, so the truncation-guard
// branching is unit-testable without a live `gh` call.
//
// Ported from watch/watch.ts's tier-2 pattern, not rewritten: the aggregate path
// (`{files, insertions, deletions}`, no paths) cannot express exclusions at
// all, so `.prheroignore` widens what was already a "wrong in the
// conservative direction" gap (see the WHY this replaces at the call site)
// from tens of lines (lockfiles) to potentially thousands (a whole ignored
// directory) — a gate that SKIPs a PR the real per-file run happily accepts
// reads as a broken tool, not a conservative estimate.
//
// `perFile: null` is the caller's signal that gh's own `files` list was
// truncated or unavailable — see watch/watch.ts:322-327's identical guard: a SHORT
// list under-counts, and under-counting here would falsely RESCUE exactly
// the monster this gate exists to stop, so an untrustworthy list is never
// used to compute a passing verdict.
export function resolvePrDryRunSizeGate(input: {
  ghDiffStat: NumstatDiffStat;
  perFile: NumstatFile[] | null;
  gateConfig: SizeGateConfig;
}): PrDryRunSizeGateResult {
  if (input.perFile !== null) {
    return {
      verdict: evaluateSizeGate(input.perFile, input.gateConfig),
      note:
        "(estimate from gh's per-file list; `.prheroignore` exclusions " +
        "apply, but the count is still not whitespace-adjusted — GitHub's " +
        "counters carry no whitespace information)",
    };
  }
  return {
    verdict: evaluateSizeGateAggregate(input.ghDiffStat, input.gateConfig),
    note:
      "(estimate from GitHub's aggregate counters; gh's per-file list was " +
      "truncated or unavailable, so exclusions are not applied and the " +
      "count is not whitespace-adjusted)",
  };
}

// `git status --porcelain` over the REVIEW worktree, reduced to one bit.
// `.codegraph/` entries are ignored: the index is built INTO the worktree by
// design and is always untracked there, so without this filter every
// reusable worktree would read dirty and reuse would never happen. Anything
// else — a tracked file edited during finding-verification, a stray
// untracked file — makes the tree dirty and forces a recreate: B0's
// dirty-tree lesson applied to the reuse path (uncommitted bytes would be
// reviewed but never reported).
export function worktreeDirty(porcelain: string): boolean {
  for (const line of porcelain.split("\n")) {
    if (line.trim().length === 0) continue;
    // Porcelain v1: two status characters, a space, then the path.
    const entry = line.slice(3);
    if (entry === ".codegraph" || entry.startsWith(".codegraph/")) continue;
    return true;
  }
  return false;
}

export type WorktreeAction = "create" | "reuse" | "recreate";

export interface WorktreeDecision {
  action: WorktreeAction;
  // Printed next to the action: a "recreate" without its cause reads as
  // churn, and the two causes call for different reactions from a human.
  reason: string;
}

// The reuse gate, stated once as a table so it is arguable. Recreate over
// repair on every mismatch: a worktree is disposable by construction, and
// checkout/clean surgery inside one saves nothing worth the risk of
// reviewing bytes nobody fetched.
export function decideWorktree(input: {
  exists: boolean;
  headMatches: boolean;
  dirty: boolean;
}): WorktreeDecision {
  if (!input.exists) {
    return { action: "create", reason: "no worktree for this PR yet" };
  }
  if (!input.headMatches) {
    return {
      action: "recreate",
      reason:
        "its HEAD is not the PR's head (the PR was updated or force-pushed " +
        "since the last review)",
    };
  }
  if (input.dirty) {
    return {
      action: "recreate",
      reason:
        "it has uncommitted changes beyond .codegraph/ (edits made while " +
        "verifying findings must not leak into a review)",
    };
  }
  return {
    action: "reuse",
    reason: "HEAD matches the PR head and the tree is clean",
  };
}

// The tag that makes posting idempotent (ROADMAP B2): the FIRST line of
// every comment pr-hero publishes. An HTML comment renders invisibly on
// GitHub, so readers see the report and the machine sees the tag.
// renderPrComment (report.ts) writes it; findMarkedCommentId reads it.
//
// B3 added the head declaration: the emitted marker carries the FULL head
// sha the posted review describes, so the watch guard (watch/preflight.ts)
// can tell from the comment alone whether THIS head was already reviewed on
// another machine. Matching, though, stays on the bare prefix — comments
// already in the wild carry the old headless `<!-- pr-hero-report -->`, and
// a matcher that required the head (or the closing `-->` right after the
// name) would orphan every one of them, so --post would stack a second
// comment instead of updating. The trailing space in the prefix is
// deliberate: both formats continue with a space (` -->` / ` head=`), while
// a foreign lookalike marker such as `<!-- pr-hero-reporter -->` does not.
export const PR_COMMENT_MARKER_PREFIX = "<!-- pr-hero-report ";

// The re-review closing comment (pr/pr.ts's postInlineFindings). A re-review
// only PATCHes the summary, and GitHub neither notifies on an edit nor moves
// the comment down the timeline, so a clean re-review used to leave the PR
// looking untouched. This marker tags the short comment that closes the run.
// Its own `pr-hero-<noun>` namespace, so findMarkedCommentId's summary lookup
// (prefix `pr-hero-report `) can never mistake it for the summary.
export const PR_REREVIEW_CLOSED_MARKER_PREFIX = "<!-- pr-hero-rereview-closed ";

// Rereview-coverage fix (GitHub #42's re-review half, MusiveTech/musive
// #1823): a PARTIAL run (some hunters or the refuter failed, but not all —
// `sessionFailed` false) used to post the exact same marker a COMPLETE run
// posts. The next `pr-hero review --pr N` on the same head then trusted
// L===H and skipped discovery entirely, so the missing hunters never ran
// and the failed refuter never re-verified anything — silently, forever,
// until a genuinely new push arrived. This token is the fix's whole wire
// contract: named once, spelled once, consulted by exact match only (see
// parsePrCommentMarker in watch/preflight.ts).
export const PR_COMMENT_COVERAGE_PARTIAL_TOKEN = "coverage=partial";

// `complete` defaults to `true` so every pre-existing one-argument call —
// every already-posted comment, every test in this codebase — stays
// BYTE-IDENTICAL to the marker this function emitted before this fix. Only
// `renderPrComment` (report.ts), which actually knows `doc.run_status`,
// passes `false`.
export function prCommentMarker(headSha: string, complete = true): string {
  return complete
    ? `<!-- pr-hero-report head=${headSha} -->`
    : `<!-- pr-hero-report head=${headSha} ${PR_COMMENT_COVERAGE_PARTIAL_TOKEN} -->`;
}

// Finds the comment a --post run should update. A comment matches only when
// its body STARTS WITH the marker prefix: a marker quoted mid-body (someone
// replying with the report pasted in) must never be treated as ours. The
// LAST match wins — the API returns oldest→newest, so last is newest — and
// idempotency is find-and-update, never stack: if legacy duplicates exist we
// update the newest and leave history alone. None → null (the caller
// creates).
// `prefix` defaults to the summary comment's own marker, so every existing
// caller stays byte-identical. Parameterized (ROADMAP Pillar 3) so
// pr/pr.ts's postPrComment can reuse this exact find-or-update logic for a CI
// gate-skip comment under its own marker (ci/gates.ts's
// SKIP_SIZE_COMMENT_MARKER / SKIP_BUDGET_COMMENT_MARKER) — the same
// idempotency the summary comment already gets, so a repeat CI run on the
// same still-failing PR updates the existing skip comment instead of
// stacking a new one on every push.
export function findMarkedCommentId(
  comments: { id: number; body: string }[],
  prefix: string = PR_COMMENT_MARKER_PREFIX,
): number | null {
  let found: number | null = null;
  for (const comment of comments) {
    if (typeof comment?.body !== "string") continue;
    if (!comment.body.startsWith(prefix)) continue;
    found = comment.id;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Per-finding identity marker (ROADMAP B6) — the FIRST line of every inline
// review comment and un-anchorable issue comment pr-hero posts. It exists so
// a second run on the same PR can tell "I already posted this finding" from
// "this is new", without trusting `dedupe_key` or `root_cause_id`: both are
// derived by the hunter/dedupe pipeline fresh each run and are NOT stable
// across runs (a re-run can renumber or re-merge findings that describe the
// exact same defect). Identity here is LOCATION + OWNERSHIP — the marker
// prefix names the comment as ours, and path+line is what pr/inline.ts's
// matcher keys on.
//
// WHY the path is percent-encoded, stated exactly: c717fe4 (size-gate.ts)
// fixed a bug from the SAME failure family — git C-quotes any path with a
// space or non-ASCII byte (`core.quotepath`), and one code path unquoted
// while a sibling did not, so a file silently vanished from one side of a
// count that was supposed to agree with the other. A raw path pasted into an
// HTML comment attribute has the identical exposure: it can contain spaces,
// `=`, `--`, or bytes that break naive re-parsing of the marker's own fields.
// Percent-encoding removes the ambiguity at the source — the SAME reason
// resolveNumstatPath/diffRecordPath route every path through unquotePath —
// rather than adding another ad-hoc unescaper that could drift from the
// encoder the way the two unquote call sites once did.
//
// `c` (first 12 hex of sha256 over the normalized claim) is a TIE-BREAKER
// only, never a requirement: claim text is regenerated by an LLM every run
// and is not expected to be byte-stable, so parseFindingMarker must still
// treat a marker with a mismatched or absent `c` as parseable — matching on
// it is pr/inline.ts's business, not this parser's.
//
// Disjoint from PR_COMMENT_MARKER_PREFIX on purpose: both markers now live
// in the same issue-comment stream (the summary comment and per-finding
// issue comments post to the same PR), and a matcher that could mistake one
// marker family for the other would either orphan the summary comment or
// treat a per-finding comment as the summary. See the prefix-disjointness
// test in test/pr/preflight.test.ts.
export const PR_FINDING_MARKER_PREFIX = "<!-- pr-hero-finding ";

export interface FindingMarkerFields {
  path: string;
  line: number;
  headSha: string;
  // Normalized claim text this marker's `c` was derived from. Optional on
  // the encode side's caller convenience is not needed — findingMarker
  // always requires it, since `c` has no meaning without the claim it was
  // computed over.
  claim: string;
}

// First 12 hex chars of sha256(claim.trim()) — enough entropy to break a tie
// between two candidates at the same distance, nowhere near enough (nor
// intended) to be a content-addressed identity on its own. Exported so
// pr/inline.ts's matcher can derive the SAME fingerprint over a current-run
// finding's claim to compare against a posted marker's `c` — design D3's
// tie-breaker only works if both sides compute it identically.
export function claimFingerprint(claim: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(claim.trim())
    .digest("hex")
    .slice(0, 12);
}

export function findingMarker(fields: FindingMarkerFields): string {
  const path = encodeURIComponent(fields.path);
  const c = claimFingerprint(fields.claim);
  return (
    `${PR_FINDING_MARKER_PREFIX}path=${path} line=${fields.line} ` +
    `head=${fields.headSha} c=${c} -->`
  );
}

export interface ParsedFindingMarker {
  path: string;
  line: number;
  headSha: string;
  // The `c` tie-breaker as stored in the marker, verbatim (not re-derived —
  // this parser has no access to the finding it once matched).
  c: string;
}

// Parses ONLY the first line of a comment body, mirroring
// findMarkedCommentId's exact-prefix contract: a marker quoted mid-body
// (someone replying with the comment pasted in) must never parse as ours.
// Returns null for anything that is not a well-formed marker rather than
// throwing — a malformed or foreign marker-shaped line is a match failure,
// not a fatal error, and the caller (the matcher) treats "unparseable" the
// same as "no prior comment": it posts fresh rather than guess.
export function parseFindingMarker(body: string): ParsedFindingMarker | null {
  if (!body.startsWith(PR_FINDING_MARKER_PREFIX)) return null;
  const firstLine = body.split("\n", 1)[0] ?? "";
  if (!firstLine.endsWith(" -->")) return null;
  const fields = firstLine.slice(
    PR_FINDING_MARKER_PREFIX.length,
    firstLine.length - " -->".length,
  );
  const parts = new Map<string, string>();
  for (const token of fields.split(" ")) {
    if (token.length === 0) continue;
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    parts.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const rawPath = parts.get("path");
  const rawLine = parts.get("line");
  const headSha = parts.get("head");
  const c = parts.get("c");
  if (
    rawPath === undefined ||
    rawLine === undefined ||
    headSha === undefined ||
    c === undefined
  ) {
    return null;
  }
  const line = Number.parseInt(rawLine, 10);
  if (!Number.isInteger(line)) return null;
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  return { path, line, headSha, c };
}

// ---------------------------------------------------------------------------
// comparison.json — the machine-readable half of the head-to-head artifact.

export interface ComparisonGreptileClaim {
  index: number;
  path: string;
  start_line: number;
  end_line: number;
  title: string;
  description: string;
}

export interface ComparisonPrHeroClaim {
  id: string;
  path: string;
  line: number;
  claim: string;
  tier: string;
}

export interface ComparisonRow {
  bucket: Bucket;
  greptile: ComparisonGreptileClaim | null;
  prhero: ComparisonPrHeroClaim | null;
  // Always null here, and present ON PURPOSE — the A3 lesson: a verdict
  // recorded without its reasoning cannot be re-examined when new evidence
  // arrives. These two columns exist to be filled by the triage (6b/6c),
  // and the ledger (B4) will accumulate them across PRs.
  verdict: null;
  reasoning: null;
  // Who will eventually write verdict/reasoning — always null at build time
  // for the same reason verdict/reasoning are: this row is fresh off a
  // review, nobody has triaged it yet. `comparison.json` carries no
  // `schema_version` (it is pr-hero's own artifact, not the findings schema
  // shared with the lab — rule 5 does not apply), so this field costs no
  // coordination (ROADMAP B6c, decided 2026-08-12).
  actor: null;
}

export interface ComparisonJson {
  pr: number;
  head_sha: string;
  diff_from_sha: string;
  run_dir: string;
  // ISO 8601, stamped by the I/O caller (this module owns no clock): the
  // ledger (B4) orders a PR's runs by it so the LATEST run is the one that
  // votes. Files written before this field existed are ordered by mtime.
  generated_at: string;
  // "complete" or "partial" — stamped so B4's ledger can weigh a comparison
  // by how much of the engine actually ran. (A run where EVERY hunter died
  // never reaches this file: the caller skips the comparison outright,
  // because "pr-hero 0" from a review that never happened would be recorded
  // as a measured miss.)
  run_status: RunStatus;
  // found: false is "Greptile left no comment", which must stay
  // distinguishable from "Greptile commented and reported nothing" —
  // renderComparison keeps them apart in prose, and the JSON must not
  // collapse them either.
  greptile: { found: boolean };
  rows: ComparisonRow[];
}

// A mechanical projection of the SAME ComparisonResult renderComparison
// consumes — never a second comparison pass, or the .md and the .json could
// disagree about what matched. Row order mirrors the rendering: the measured
// miss (greptile_only) leads.
export function buildComparisonJson(input: {
  pr: number;
  headSha: string;
  diffFromSha: string;
  runDir: string;
  generatedAt: string;
  runStatus: RunStatus;
  greptileFound: boolean;
  result: ComparisonResult;
}): ComparisonJson {
  const rows: ComparisonRow[] = [];
  for (const finding of input.result.greptileOnly) {
    rows.push(row("greptile_only", greptileClaim(finding), null));
  }
  for (const pair of input.result.both) {
    rows.push(
      row("both", greptileClaim(pair.greptile), prheroClaim(pair.prhero)),
    );
  }
  for (const finding of input.result.prheroOnly) {
    rows.push(row("prhero_only", null, prheroClaim(finding)));
  }
  return {
    pr: input.pr,
    head_sha: input.headSha,
    diff_from_sha: input.diffFromSha,
    run_dir: input.runDir,
    generated_at: input.generatedAt,
    run_status: input.runStatus,
    greptile: { found: input.greptileFound },
    rows,
  };
}

function row(
  bucket: Bucket,
  greptile: ComparisonGreptileClaim | null,
  prhero: ComparisonPrHeroClaim | null,
): ComparisonRow {
  return {
    bucket,
    greptile,
    prhero,
    verdict: null,
    reasoning: null,
    actor: null,
  };
}

function greptileClaim(finding: GreptileFinding): ComparisonGreptileClaim {
  return {
    index: finding.index,
    path: finding.path,
    start_line: finding.startLine,
    end_line: finding.endLine,
    title: finding.title,
    description: finding.description,
  };
}

function prheroClaim(finding: PrHeroFindingRef): ComparisonPrHeroClaim {
  return {
    id: finding.id,
    path: finding.path,
    line: finding.line,
    claim: finding.claim,
    tier: finding.tier,
  };
}

// ---------------------------------------------------------------------------
// Commit status (in-flight signal on the PR head). GitHub Check Runs need a
// GitHub App; this CLI posts as the operator via `gh`, so the write path is
// the Commit Statuses API. Same yellow/green dot in the merge box, no
// Conversation comment. context is stable so the CI admission gate can read
// the latest `pr-hero` status back as the cross-machine in-flight lock.

// The gate. The required check reads this name, and only an explicit `--ci`
// run writes it (T3 S7): the author's agent, a local run and the watcher can
// never move the gate, so their statuses go to LOCAL_COMMIT_STATUS_CONTEXT.
export const COMMIT_STATUS_CONTEXT = "pr-hero";

// Every non-CI run posts here: a local `review --pr`, the watcher's child, and
// CI=1 without --ci. Advisory states and descriptions only, so a local run
// that finishes with blocking findings cannot overwrite a red gate on the same
// head. A different context, not a different state set, is what keeps the gate
// safe: the posting code is shared and only the context name differs.
export const LOCAL_COMMIT_STATUS_CONTEXT = "pr-hero/local";

export type CommitStatusContext =
  | typeof COMMIT_STATUS_CONTEXT
  | typeof LOCAL_COMMIT_STATUS_CONTEXT;

// Every context a run's status can sit on. The watcher and local runs (no --ci)
// read all of them: neither may start a review of a head that CI or another
// local run is already reviewing. A `--ci` run reads only COMMIT_STATUS_CONTEXT:
// it stands down for CI, never for a local run whose result the gate cannot see
// (ci-admission-gate.ts yieldToInFlightReview picks the set by posture).
export const RUN_STATUS_CONTEXTS: readonly CommitStatusContext[] = [
  COMMIT_STATUS_CONTEXT,
  LOCAL_COMMIT_STATUS_CONTEXT,
];

// The contexts a run's in-flight yield reads (ci-admission-gate.ts
// yieldToInFlightReview). A `--ci` run reads only the gate; every other run reads
// all of them. Kept here, beside the constants, so the admission gate never names
// the gate context itself (test/pr/status-context.test.ts pins who may).
export function inFlightContextsFor(
  statusContext: CommitStatusContext,
): readonly CommitStatusContext[] {
  return statusContext === COMMIT_STATUS_CONTEXT
    ? [COMMIT_STATUS_CONTEXT]
    : RUN_STATUS_CONTEXTS;
}

// DEFAULT_PIPELINE_TIMEOUT_MS is 75 min (pipeline.ts). A TTL inside that
// window would double-launch a slow live run still inside its watchdog.
export const IN_FLIGHT_TTL_MS = 90 * 60 * 1000;

// Same bound as GH_PR_VIEW_TIMEOUT_MS (store/gc-preflight.ts): a hung statuses
// API must not pin watch.lock or delay a pipeline that already confirmed.
export const COMMIT_STATUS_TIMEOUT_MS = 15_000;

// The cancellation settle runs inside a signal handler, and the runner
// SIGKILLs shortly after the signal. Two attempts at COMMIT_STATUS_TIMEOUT_MS
// outlive that grace window, and a settle that outlives SIGKILL is no settle
// at all — so the cancellation path trades the retry for landing in time.
export const CANCELLATION_COMMIT_STATUS_TIMEOUT_MS = 5_000;

// GitHub's commit-status description is a short field (historically 140).
export const COMMIT_STATUS_DESCRIPTION_MAX = 140;

export type CommitStatusState = "pending" | "success" | "failure" | "error";

// S4. `gate` (the CI default): the pr-hero commit status, which is the
// required check, goes red on blocking findings, a size or budget skip, and a
// crash. `advisory`: today's posture, a finished review is always green. Only
// CI runs have a mode; a local run is always advisory (see resolveCiMode).
export type CiMode = "gate" | "advisory";

// The mode a run actually uses. Only an explicit `--ci` run has a mode, and
// `ci` is that flag, never the CI/GITHUB_ACTIONS environment: a developer shell
// that exports CI=1 is not the gate, and a local `review --pr` that posted
// `failure` would turn a required check red for a reason its operator did not
// ask for. `ciMode` is undefined when --ci-mode was not given; gate is the
// default for an explicit CI run.
export function resolveCiMode(ciMode: CiMode | undefined, ci: boolean): CiMode {
  if (!ci) return "advisory";
  return ciMode ?? "gate";
}

// The one posture a run resolves from its own flags: the mode and the context
// its statuses post on. Both key on `--ci` alone, so no path can pair the
// gate's context with an advisory local run, and reviewPr resolves once and
// threads both values down (T3 S7).
export function resolveCiPosture(options: { ci?: boolean; ciMode?: CiMode }): {
  ciMode: CiMode;
  statusContext: CommitStatusContext;
} {
  const ci = options.ci === true;
  return {
    ciMode: resolveCiMode(options.ciMode, ci),
    statusContext: ci ? COMMIT_STATUS_CONTEXT : LOCAL_COMMIT_STATUS_CONTEXT,
  };
}

export interface CommitStatusFact {
  state: string;
  context: string;
  created_at: string;
  // The status's description, read only where an override must be told apart from
  // a review's own status (teardown.ts overrideStandsOverRun). Absent when the
  // reader did not return it, which is never taken as an override.
  description?: string | null;
  // The run URL the status links to. Read only by `pr-hero status`, which names the run
  // that wrote the gate. Absent when the reader did not return it.
  target_url?: string | null;
}

export interface CommitStatusRequest {
  state: CommitStatusState;
  // The POST writes this context, so it is the request's to choose: a non-CI
  // run's request names the local context, and only a `--ci` run's names pr-hero.
  context: CommitStatusContext;
  description: string;
  targetUrl: string | undefined;
}

export function clipStatusDescription(text: string): string {
  if (text.length <= COMMIT_STATUS_DESCRIPTION_MAX) return text;
  return text.slice(0, COMMIT_STATUS_DESCRIPTION_MAX);
}

// `posted` only changes the success description: "review posted" when this
// run published a comment, "review complete" when it did not (--post off,
// or posting never ran). This is the advisory vocabulary and the crash/pending
// vocabulary: it never builds `failure`. A blocking finding turns red only
// through blockingCommitStatusRequest, and only in gate mode.
export function commitStatusRequest(input: {
  phase: "pending" | "success" | "error";
  posted: boolean;
  targetUrl: string | undefined;
  context: CommitStatusContext;
}): CommitStatusRequest {
  const description =
    input.phase === "pending"
      ? "pr-hero reviewing"
      : input.phase === "error"
        ? "review did not finish"
        : input.posted
          ? "review posted"
          : "review complete";
  return {
    state: input.phase === "pending" ? "pending" : input.phase,
    context: input.context,
    description: clipStatusDescription(description),
    targetUrl: input.targetUrl,
  };
}

// S4, gate mode: a finished review with unresolved blocking findings. The count
// is the gate's own (rereview/state.ts): this run's blocking survivors plus every
// live blocking prior that a verifier verdict or a deletion did not clear. A
// same-head `/pr-hero review` re-runs that same count, so it stays red. The
// ways to green are a fix that the re-review verifies gone, or
// `/pr-hero override`. A triage reply never lowers the count on its own (S7).
// Gate-only: the only caller is a gate-mode settle, which is always a `--ci` run.
// The context defaults to LOCAL so a caller that forgets it cannot reach the
// gate; the gate's callers pass COMMIT_STATUS_CONTEXT explicitly.
export function blockingCommitStatusRequest(input: {
  blockingCount: number;
  targetUrl: string | undefined;
  context?: CommitStatusContext;
}): CommitStatusRequest {
  return {
    state: "failure",
    context: input.context ?? LOCAL_COMMIT_STATUS_CONTEXT,
    description: clipStatusDescription(
      `pr-hero: ${input.blockingCount} blocking finding(s) — fix and push, or /pr-hero override`,
    ),
    targetUrl: input.targetUrl,
  };
}

// S4, gate mode: a size or budget skip is red, so an unreviewed head cannot
// read as a clean one. `/pr-hero review` force-runs the review past both
// gates, which is the unlock the description names.
// Gate-only, like blockingCommitStatusRequest: the context defaults to LOCAL, and
// the one production caller (the admission gate's publishCiSkip) passes pr-hero.
export function skipCommitStatusRequest(input: {
  kind: "size" | "budget";
  targetUrl: string | undefined;
  context?: CommitStatusContext;
}): CommitStatusRequest {
  const reason =
    input.kind === "size"
      ? "diff over the size gate"
      : "estimated cost over the CI budget";
  return {
    state: "failure",
    context: input.context ?? LOCAL_COMMIT_STATUS_CONTEXT,
    description: clipStatusDescription(
      `pr-hero skipped the review: ${reason}. /pr-hero review reviews it anyway`,
    ),
    targetUrl: input.targetUrl,
  };
}

// What settling an abandoned run needs, and nothing else. The process that
// posted the pending is the only one that knows all three, and by the time a
// signal arrives reviewPr's scope is unreachable — so this is what the
// module-level lock in cli.ts carries across that gap.
export interface HeldCommitStatusLock {
  operatorRoot: string;
  sha: string;
  targetUrl: string | undefined;
  // The context the held pending was posted on, so the signal settle clears
  // that pending and no other. Absent means local: the settle then never names
  // the gate, so a lock taken without one cannot overwrite a CI verdict (T3 S7).
  context?: CommitStatusContext;
}

// The pure half of the cancellation settle: lock in, the exact three
// arguments postCommitStatus takes out. `phase: "error"` is reused verbatim
// — its description, "review did not finish", is already the honest sentence
// for a cancelled run, so no new vocabulary enters the status contract.
//
// The SHA is the load-bearing field. It is the head the pending was posted
// on, captured at publish time; resolving the head again inside a signal
// handler could name a different commit and leave the real lock standing.
export function settleRequestForCancellation(
  lock: HeldCommitStatusLock | null,
): { operatorRoot: string; sha: string; request: CommitStatusRequest } | null {
  if (lock === null) return null;
  // WHY PRH-CANCELLED and not "review did not finish": a signal is a cancel, and the
  // action's cancel-settle step writes the same text when this settle does not land
  // first (src/ci/publish.ts runCancelSettle). Either writer leaves one coded status.
  return {
    operatorRoot: lock.operatorRoot,
    sha: lock.sha,
    request: {
      ...commitStatusRequest({
        phase: "error",
        posted: false,
        targetUrl: lock.targetUrl,
        context: lock.context ?? LOCAL_COMMIT_STATUS_CONTEXT,
      }),
      description: clipStatusDescription(CANCELLED_STATUS_DESCRIPTION),
    },
  };
}

// The finally-block matrix. A finished pipeline that is not sessionFailed is
// success even if --post threw (the review ran; the comment is a separate
// write). Anything else — crash before pipeline return, or every hunter dead —
// is error in both modes.
//
// S4 adds one red verdict on top, gate only: a finished review with blocking
// findings is failure, and the count rides along for the description. Advisory
// never reads the count, so it keeps the two-state matrix exactly. An unknown
// count (publishRunOutcome threw before the findings doc existed) is error in
// gate: a gate cannot call a review it never read clean.
export type CommitStatusCompletion =
  | { phase: "success" | "error" }
  | { phase: "failure"; blockingCount: number }
  | { phase: "partial"; failed: number; total: number };

// S1, gate mode: a finished review where some hunters failed but not all, and no blocking
// finding survived. The gate cannot call that green: a reviewer that never ran may have been
// the one that would have blocked. `/pr-hero review` runs the head again, which is the unlock.
// The variable parts are the failed count (N) and the hunters that ran (M).
export function partialReviewDescription(
  failed: number,
  total: number,
): string {
  return clipStatusDescription(
    `pr-hero: review partial (${failed} of ${total} hunters failed) — /pr-hero review retries it`,
  );
}

export function partialReviewCommitStatusRequest(input: {
  failed: number;
  total: number;
  targetUrl: string | undefined;
  context: CommitStatusContext;
}): CommitStatusRequest {
  return {
    state: "failure",
    context: input.context,
    description: partialReviewDescription(input.failed, input.total),
    targetUrl: input.targetUrl,
  };
}

export function commitStatusCompletion(input: {
  pipelineFinished: boolean;
  sessionFailed: boolean;
  ciMode: CiMode;
  blockingCount: number | null;
  // S4: M and N. Absent means no hunter counts were read, which is never a partial review.
  hunterCount?: number;
  hunterFailures?: number;
  // The pipeline's own statement that no hunter ran on a run meant to review
  // (PipelineResult.noReviewerRan). Absent reads as false.
  noReviewerRan?: boolean;
}): CommitStatusCompletion {
  if (!input.pipelineFinished || input.sessionFailed) return { phase: "error" };
  if (input.ciMode === "advisory") return { phase: "success" };
  if (input.blockingCount === null) return { phase: "error" };
  // WHY a blocking count wins over a partial review: a blocking finding is more actionable
  // than a retry. The author has a concrete fix to push, and the description keeps that text.
  if (input.blockingCount > 0) {
    return { phase: "failure", blockingCount: input.blockingCount };
  }
  // WHY a review in which no reviewer ran is not green: the budget ceiling or an unusable
  // gotchas file can stop the run before any hunter starts, and sessionFailed stays false
  // because no hunter failed. The gate cannot call that clean, so it reads as a review
  // that did not finish. The pipeline says so itself (noReviewerRan): a zero hunter count
  // alone is also a re-review that skipped discovery on purpose, which is a finished review.
  if (input.noReviewerRan === true) return { phase: "error" };
  // A missing count on either side reads as no partial review: a failed count without its M
  // is not a verdict the gate can word.
  const failed = input.hunterFailures ?? 0;
  const total = input.hunterCount ?? 0;
  if (failed >= 1 && total >= failed) {
    return { phase: "partial", failed, total };
  }
  return { phase: "success" };
}

export function prHtmlUrl(
  repoUrl: string | undefined,
  pr: number,
): string | undefined {
  if (repoUrl === undefined || repoUrl.trim() === "") return undefined;
  if (!Number.isInteger(pr) || pr < 1) return undefined;
  const url = `${repoUrl.replace(/\/$/, "")}/pull/${pr}`;
  return URL.canParse(url) ? url : undefined;
}

export function latestStatusInContext(
  statuses: readonly CommitStatusFact[],
  context: CommitStatusContext,
): CommitStatusFact | null {
  let latest: CommitStatusFact | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const status of statuses) {
    if (status.context !== context) continue;
    const createdMs = Date.parse(status.created_at);
    if (Number.isNaN(createdMs)) continue;
    if (createdMs >= latestMs) {
      latest = status;
      latestMs = createdMs;
    }
  }
  return latest;
}

// Latest status for our context, by created_at — GitHub's list is usually
// newest-first, but the watcher must not depend on that. A pending older
// than the TTL is NOT in-flight: the process likely died, and the next tick
// must be allowed to launch.
// In-flight in ANY of the given contexts: each context's own latest status is
// judged, so a fresh pending on one never hides behind a settled one on another.
// The default reads the gate alone, which is a `--ci` run's yield. A non-CI run
// passes RUN_STATUS_CONTEXTS, so it also stands down for a local pending.
export function isInFlightCommitStatus(
  statuses: readonly CommitStatusFact[],
  nowMs: number,
  ttlMs: number = IN_FLIGHT_TTL_MS,
  contexts: readonly CommitStatusContext[] = [COMMIT_STATUS_CONTEXT],
): boolean {
  return contexts.some((context) => {
    const latest = latestStatusInContext(statuses, context);
    if (latest === null || latest.state !== "pending") return false;
    const createdMs = Date.parse(latest.created_at);
    if (Number.isNaN(createdMs)) return false;
    return nowMs - createdMs < ttlMs;
  });
}
