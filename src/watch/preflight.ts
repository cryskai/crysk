// Everything the watcher (ROADMAP B3) must decide, expressed as pure
// functions so it is all testable offline — same contract as review/preflight.ts
// and pr/preflight.ts: nothing here touches the filesystem, git, gh, launchd
// or the clock. watch/watch.ts is the I/O shell that acts on these.
//
// The watcher's model is a TICK, not a daemon: launchd (or cron) runs
// `pr-hero watch --once` every N minutes, each tick launches AT MOST ONE
// review, and every decision an unattended process makes about spending
// money is pinned here where a test can hold it still.

import path from "node:path";
import { isFullCommitId } from "#git/refs";
import { PR_COMMENT_MARKER_PREFIX } from "#pr/preflight";
import type { NumstatFile } from "#review/preflight";
import {
  DEFAULT_SIZE_GATE,
  evaluateSizeGate,
  type SizeGateConfig,
} from "#review/size-gate";
import type { SelfInvocation } from "../assets";
import { CliUsageError } from "../errors";
import { type PrheroLayout, prheroLayout } from "../home-preflight";

// ---------------------------------------------------------------------------
// ~/.prhero/ layout — one source for every path the watcher owns, so the
// shell, the plist and the docs cannot drift apart on where things live.

// Extends PrheroLayout (never redeclares its fields) so a new field there —
// metricsDbPath (W4 / #23) was the first — cannot silently drift out of
// this spread; tsc rejects an object literal missing a field the moment
// PrheroLayout grows one.
export interface PrheroHomePaths extends PrheroLayout {
  plistPath: string;
}

export function prheroHomePaths(home: string): PrheroHomePaths {
  const layout = prheroLayout(home);
  return {
    ...layout,
    plistPath: path.join(
      home,
      "Library",
      "LaunchAgents",
      `${WATCH_LAUNCHD_LABEL}.plist`,
    ),
  };
}

// ---------------------------------------------------------------------------
// ~/.prhero/watch.json — the explicit opt-in. A repo is watched ONLY if
// listed here; nothing in a repo's own .prhero/ can subscribe it to
// automatic spend. Parsed loudly, ledger-style: every failing field names
// itself and its got-value, because a silently mis-read config either burns
// money on the wrong repo or silently watches nothing.

export const DEFAULT_DAILY_CAP = 5;

export interface WatchRepoConfig {
  // As written in the config (tilde and all); the shell expands it.
  path: string;
  post: boolean;
  // false (the default): one review per PR — any prior review of the PR
  // NUMBER blocks it, whatever head it covered. true: the original (pr,
  // head) key — every push re-arms the PR. See candidateSkipReason.
  onPush: boolean;
  // The size gate's per-repo thresholds (see size-gate.ts). A MISSING key
  // falls back to DEFAULT_SIZE_GATE, so every config file written before
  // the gate landed keeps working untouched.
  maxChangedLines: number;
  maxChangedFiles: number;
}

export interface WatchWindow {
  start: string; // "HH:MM", local time
  end: string;
}

export interface WatchConfig {
  repos: WatchRepoConfig[];
  dailyCap: number;
  window: WatchWindow | null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseWatchConfig(raw: string): WatchConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `watch.json is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError("watch.json must be a single JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const repos = record.repos;
  if (!Array.isArray(repos)) {
    throw new CliUsageError(
      `watch.json "repos" must be an array, got: ${JSON.stringify(repos)}`,
    );
  }
  const parsedRepos: WatchRepoConfig[] = repos.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CliUsageError(`watch.json repos[${i}] must be an object`);
    }
    const repo = entry as Record<string, unknown>;
    if (typeof repo.path !== "string" || repo.path.trim().length === 0) {
      throw new CliUsageError(
        `watch.json repos[${i}].path must be a non-empty string, got: ` +
          JSON.stringify(repo.path),
      );
    }
    const post = repo.post ?? false;
    if (typeof post !== "boolean") {
      throw new CliUsageError(
        `watch.json repos[${i}].post must be a boolean, got: ` +
          JSON.stringify(repo.post),
      );
    }
    const onPush = repo.on_push ?? false;
    if (typeof onPush !== "boolean") {
      throw new CliUsageError(
        `watch.json repos[${i}].on_push must be a boolean, got: ` +
          JSON.stringify(repo.on_push),
      );
    }
    return {
      path: repo.path,
      post,
      onPush,
      maxChangedLines: sizeLimit(
        repo.max_changed_lines,
        DEFAULT_SIZE_GATE.maxChangedLines,
        i,
        "max_changed_lines",
      ),
      maxChangedFiles: sizeLimit(
        repo.max_changed_files,
        DEFAULT_SIZE_GATE.maxChangedFiles,
        i,
        "max_changed_files",
      ),
    };
  });
  const cap = record.daily_cap ?? DEFAULT_DAILY_CAP;
  // Zero is legal on purpose: `"daily_cap": 0` is the pause switch — the
  // watcher keeps observing (and dry-runs keep working) but launches nothing.
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0) {
    throw new CliUsageError(
      `watch.json "daily_cap" must be a non-negative integer, got: ` +
        JSON.stringify(record.daily_cap),
    );
  }
  const window = parseWindow(record.window);
  return { repos: parsedRepos, dailyCap: cap, window };
}

// Zero is legal and MEANINGFUL — like daily_cap's pause switch, it is the
// documented "disable this limit" value, not a nonsense input — so the
// validation floor is 0, not 1. Absent falls back to the shipped default.
function sizeLimit(
  value: unknown,
  fallback: number,
  i: number,
  key: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CliUsageError(
      `watch.json repos[${i}].${key} must be a non-negative integer ` +
        `(0 disables the limit), got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseWindow(value: unknown): WatchWindow | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(
      `watch.json "window" must be null or {start, end}, got: ` +
        JSON.stringify(value),
    );
  }
  const window = value as Record<string, unknown>;
  for (const field of ["start", "end"] as const) {
    if (typeof window[field] !== "string" || !HHMM.test(window[field])) {
      throw new CliUsageError(
        `watch.json "window.${field}" must be "HH:MM" (24h), got: ` +
          JSON.stringify(window[field]),
      );
    }
  }
  const start = window.start as string;
  const end = window.end as string;
  // start === end would be an always-closed window: a config bug with a
  // plausible face ("all day" is `null`, not a degenerate range).
  if (start === end) {
    throw new CliUsageError(
      `watch.json "window" start and end must differ (got ${start} twice); ` +
        "use null for no window",
    );
  }
  return { start, end };
}

// Only the two shell forms (`~` and `~/...`) expand — `~user` is left alone,
// because guessing another user's home would point the watcher at a repo
// nobody configured.
export function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

// The write-side inverse of expandTilde: paths STORED in watch.json contract
// $HOME back to `~`, so the file stays readable, matches the README's
// examples, and survives a home-directory rename.
export function contractTilde(p: string, home: string): string {
  if (p === home) return "~";
  if (p.startsWith(`${home}${path.sep}`)) {
    return `~/${p.slice(home.length + 1)}`;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Config management (watch add/remove) — the config file is machine-owned so
// nobody hand-edits JSON. Both rewrites are SURGICAL over the raw JSON
// record, never a re-projection of the parsed WatchConfig: parseWatchConfig
// tolerates unknown keys (top-level and per-repo alike), so a canonical
// re-projection would silently drop whatever a future version — or a careful
// hand — put there. The raw text is still validated through parseWatchConfig
// FIRST: a malformed config fails loud instead of being "repaired" into
// data loss.

// A stored path and a freshly resolved repo root must collide however the
// config spells the repo — `~/x` and `/Users/user/x` are the same entry.
function sameRepoPath(stored: string, repoRoot: string, home: string): boolean {
  return path.resolve(expandTilde(stored, home)) === path.resolve(repoRoot);
}

function serializeConfig(record: unknown): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export interface ConfigUpsert {
  // The new file body, ready to write.
  config: string;
  action: "added" | "updated";
  // As recorded in the file: the tilde-contracted form on an add, the
  // entry's own existing spelling on an update.
  storedPath: string;
}

export interface WatchRepoFlags {
  post: boolean;
  onPush: boolean;
  // Size-gate thresholds, written on every add/update like every other flag
  // here — absent on the command line means "the shipped default", per this
  // command's disclosed reset semantics.
  maxChangedLines: number;
  maxChangedFiles: number;
}

// Idempotent by design: re-adding a listed repo UPDATES its flags in place
// (every other key of the entry survives) and is never an error — `watch
// add` doubles as "change this repo's settings", and an absent flag RESETS
// to its default rather than keeping the old value (disclosed semantics:
// the command line states the whole intent). A null raw means no config
// file yet: one is created with the shipped defaults.
export function upsertWatchRepo(
  raw: string | null,
  repoRoot: string,
  flags: WatchRepoFlags,
  home: string,
): ConfigUpsert {
  const storedPath = contractTilde(repoRoot, home);
  if (raw === null) {
    return {
      config: serializeConfig({
        repos: [repoEntry(storedPath, flags)],
        daily_cap: DEFAULT_DAILY_CAP,
        window: null,
      }),
      action: "added",
      storedPath,
    };
  }
  // Loud validation first; the raw re-parse below is then known-shaped.
  parseWatchConfig(raw);
  const record = JSON.parse(raw) as Record<string, unknown>;
  const repos = record.repos as Record<string, unknown>[];
  for (const entry of repos) {
    if (sameRepoPath(entry.path as string, repoRoot, home)) {
      entry.post = flags.post;
      entry.on_push = flags.onPush;
      entry.max_changed_lines = flags.maxChangedLines;
      entry.max_changed_files = flags.maxChangedFiles;
      return {
        config: serializeConfig(record),
        action: "updated",
        storedPath: entry.path as string,
      };
    }
  }
  repos.push(repoEntry(storedPath, flags));
  return { config: serializeConfig(record), action: "added", storedPath };
}

// One shape for both the create and the append path: two literals would
// drift the day a knob is added.
function repoEntry(
  storedPath: string,
  flags: WatchRepoFlags,
): Record<string, unknown> {
  return {
    path: storedPath,
    post: flags.post,
    on_push: flags.onPush,
    max_changed_lines: flags.maxChangedLines,
    max_changed_files: flags.maxChangedFiles,
  };
}

export interface ConfigRemoval {
  // null when nothing changed (the repo was not listed) — the caller skips
  // the write, so a no-op remove cannot even reformat the file.
  config: string | null;
  action: "removed" | "not-listed";
}

// Removing the last repo leaves `"repos": []` — a VALID config state
// ("watch nothing"): parseWatchConfig accepts it and a tick over zero repos
// gates, logs and exits cleanly. Deleting the file instead would throw away
// the operator's cap and window settings.
export function removeWatchRepo(
  raw: string,
  repoRoot: string,
  home: string,
): ConfigRemoval {
  parseWatchConfig(raw);
  const record = JSON.parse(raw) as Record<string, unknown>;
  const repos = record.repos as Record<string, unknown>[];
  const kept = repos.filter(
    (entry) => !sameRepoPath(entry.path as string, repoRoot, home),
  );
  if (kept.length === repos.length) {
    return { config: null, action: "not-listed" };
  }
  record.repos = kept;
  return { config: serializeConfig(record), action: "removed" };
}

// Start-inclusive, end-EXCLUSIVE, so back-to-back windows neither overlap
// nor gap. An inverted range (start > end) is an overnight window — 22:00 to
// 06:00 means "late evening through early morning", not an error.
export function insideWindow(
  window: WatchWindow | null,
  localMinutes: number,
): boolean {
  if (window === null) return true;
  const start = hhmmToMinutes(window.start);
  const end = hhmmToMinutes(window.end);
  return start < end
    ? localMinutes >= start && localMinutes < end
    : localMinutes >= start || localMinutes < end;
}

function hhmmToMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

// ---------------------------------------------------------------------------
// gh output parsers — the same loud register as resolvePrTarget: gh's output
// is input from outside this process, and a mis-read PR list makes an
// unattended watcher spend money on a range nobody asked about.

export interface WatchPrCandidate {
  pr: number;
  head: string;
  isDraft: boolean;
  // GitHub's own aggregate counters, free in the same list response — the
  // size gate's zero-extra-call first tier.
  additions: number;
  deletions: number;
  changedFiles: number;
}

// Parses the raw stdout of `gh pr list --json <PR_LIST_JSON_FIELDS>` (open
// PRs only — gh's default state filter is the one the watcher wants).
export function parsePrList(raw: string): WatchPrCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `gh pr list returned invalid JSON: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliUsageError("gh pr list must return a JSON array");
  }
  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CliUsageError(`gh pr list [${i}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const pr = record.number;
    if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1) {
      throw new CliUsageError(
        `gh pr list [${i}].number must be a positive integer, got: ` +
          JSON.stringify(pr),
      );
    }
    const head = record.headRefOid;
    if (typeof head !== "string" || !isFullCommitId(head)) {
      throw new CliUsageError(
        `gh pr list [${i}].headRefOid must be a full 40-hex commit id, ` +
          `got: ${JSON.stringify(head)}`,
      );
    }
    const isDraft = record.isDraft;
    if (typeof isDraft !== "boolean") {
      throw new CliUsageError(
        `gh pr list [${i}].isDraft must be a boolean, got: ` +
          JSON.stringify(isDraft),
      );
    }
    return {
      pr,
      head,
      isDraft,
      additions: countField(record, i, "additions"),
      deletions: countField(record, i, "deletions"),
      changedFiles: countField(record, i, "changedFiles"),
    };
  });
}

// Loud, like every other field here: a size counter silently read as 0 would
// wave a monster PR straight past the gate — the exact failure the gate
// exists to prevent — and it would look identical to a genuinely tiny PR.
function countField(
  record: Record<string, unknown>,
  i: number,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CliUsageError(
      `gh pr list [${i}].${key} must be a non-negative integer, got: ` +
        JSON.stringify(value),
    );
  }
  return value;
}

// Parses the raw stdout of `gh pr view <n> --json files` into the same
// NumstatFile shape the local gate uses, so ONE evaluateSizeGate serves both
// the git path and the GitHub path — two size gates would drift.
//
// `binary` is always false: GitHub's file list carries no binary marker, and
// for a binary file it simply reports 0/0 — which is what a binary file
// contributes anyway, so the gate's arithmetic is unaffected.
export function parsePrFiles(raw: string): NumstatFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `gh pr view --json files returned invalid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(
      "gh pr view --json files must return a JSON object",
    );
  }
  const files = (parsed as Record<string, unknown>).files;
  if (!Array.isArray(files)) {
    throw new CliUsageError(
      `gh pr view --json files "files" must be an array, got: ${JSON.stringify(files)}`,
    );
  }
  return files.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CliUsageError(`gh pr view files[${i}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const filePath = record.path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new CliUsageError(
        `gh pr view files[${i}].path must be a non-empty string, got: ` +
          JSON.stringify(filePath),
      );
    }
    return {
      path: filePath,
      insertions: countField(record, i, "additions"),
      deletions: countField(record, i, "deletions"),
      binary: false,
    };
  });
}

// ---------------------------------------------------------------------------
// The cross-machine guard. A posted pr-hero comment now declares which head
// it reviewed (prCommentMarker in pr/preflight.ts); reading that declaration
// back out is how one machine's watcher learns another machine already paid
// for this head.

// The exact-token contract (rereview-coverage fix): a marker's
// first line is either the plain complete form, or the plain form plus the
// space-separated `coverage=partial` token — and NOTHING else. An
// abbreviated or garbage trailing token (`coverage=partiallyDone`,
// `coverage=PARTIAL`, a stray space) fails the WHOLE match rather than being
// coerced into either bucket, mirroring how a malformed sha already failed
// the whole marker before this fix (never a partial match). This single
// regex backs both readers below so their heads can never drift apart.
//
// WHY this is also the correct behavior for an OLDER pr-hero deployed
// elsewhere, unaware of the coverage token: its own copy of this regex has
// no optional group, so it fails to match a partial marker's first line
// entirely and reads it as the legacy headless marker — no head declared,
// covers none, PR stays eligible. That is the fail-safe direction (more
// review, never a truncated one), and it is what motivates fail-closed
// (not fail-complete) as THIS reader's answer for a garbage token too.
const MARKER_HEAD_RE =
  /^<!-- pr-hero-report head=([0-9a-f]{40})( coverage=partial)? -->/;

// NEVER throws: comment bodies are foreign text (bots, humans, pasted
// reports), and a guard that crashes on someone else's comment takes the
// whole watcher down with it. An old-format marker (`<!-- pr-hero-report -->`,
// no head=) returns null — it declares NO head, so it covers none and the
// PR stays eligible; a malformed or abbreviated head reads the same way.
//
// Every existing consumer (markerDeclaredHeads below; cli.ts's CI-admission
// authority check and its previousHeadSha reconcile read) needs the head
// unchanged regardless of whether the run that posted it completed — none of
// them care about completeness, only identity — so this stays a thin
// projection of parsePrCommentMarker rather than a second regex to keep in
// sync.
export function parseMarkerHead(body: string): string | null {
  return parsePrCommentMarker(body)?.head ?? null;
}

export interface PrCommentMarkerFields {
  head: string;
  complete: boolean;
}

// The coverage-aware reader (rereview-coverage fix): cli.ts's
// re-review discovery seam needs to know not just WHICH head a posted
// summary comment covers, but whether that run actually finished — a
// PARTIAL run's own L must never be trusted the same way a COMPLETE run's
// is (see resolveLastReviewedHead's `lastComplete` in rereview/plan.ts).
export function parsePrCommentMarker(
  body: string,
): PrCommentMarkerFields | null {
  if (typeof body !== "string") return null;
  if (!body.startsWith(PR_COMMENT_MARKER_PREFIX)) return null;
  const newlineAt = body.indexOf("\n");
  const firstLine = newlineAt === -1 ? body : body.slice(0, newlineAt);
  const match = MARKER_HEAD_RE.exec(firstLine);
  if (match === null) return null;
  const head = match[1];
  if (head === undefined) return null;
  return { head, complete: match[2] === undefined };
}

// The two fields every production consumer of a parsed marker actually
// wants, with the "nothing posted yet" default folded in ONE place: a null
// marker (no comment, or one that failed to parse) declares no head — there
// is nothing to distrust, so it reads as complete. Both reviewPr()'s
// discovery seam (src/pr/review-pr.ts) and the CI admission gate
// (src/pr/ci-admission-gate.ts) independently needed `summaryHead`/
// `summaryComplete` derived from a parsed marker; before this helper existed
// each site re-wrote the same `marker?.head ?? null` / `marker?.complete ??
// true` pair inline, which is exactly the shape that can drift — one call
// site could gain a real default (a stray `true` literal, say) while the
// other kept threading the marker's own value, silently reopening the
// rereview-coverage fix's failure mode (a forced-full re-review from a
// partial marker that only ONE of the two consumers still notices).
export function summaryMarkerFields(marker: PrCommentMarkerFields | null): {
  summaryHead: string | null;
  summaryComplete: boolean;
} {
  return {
    summaryHead: marker?.head ?? null,
    summaryComplete: marker?.complete ?? true,
  };
}

// Every head any pr-hero-marked comment on the PR declares. Duplicates are
// harmless (the guard only asks "is this head among them").
//
// Rereview-coverage fix (explicitly unchanged): a PARTIAL marker's
// head still counts as "declared" here — parseMarkerHead returns the head
// for both wire forms, and this function does not distinguish them. There is
// deliberately NO automatic relaunch loop for a PR whose review keeps timing
// out: the watcher's one-review-per-PR eligibility stays exactly as it was.
// Recovery is an explicit `pr-hero review --pr N`, a CI re-run of the same
// commit (CI admission does not treat a partial same-head review as done,
// see evaluateCiReviewAdmission), or a new push; each forces a full
// re-review via `lastComplete` (rereview/plan.ts). Never the watcher noticing
// coverage=partial and retrying on its own.
export function markerDeclaredHeads(comments: { body: string }[]): string[] {
  const heads: string[] = [];
  for (const comment of comments) {
    const head = parseMarkerHead(comment?.body);
    if (head !== null) heads.push(head);
  }
  return heads;
}

// Whether ANY pr-hero marker comment exists on the PR, head-declaring or
// not. Distinct from markerDeclaredHeads on purpose: a legacy headless
// marker declares no head — it can never prove THIS head was reviewed — but
// it does prove the PR was reviewed at some point, which is exactly what
// the one-review-per-PR default (on_push: false) needs to know. Same
// never-throw contract as parseMarkerHead: bodies are foreign text.
export function markerCommentSeen(comments: { body: string }[]): boolean {
  return comments.some(
    (comment) =>
      typeof comment?.body === "string" &&
      comment.body.startsWith(PR_COMMENT_MARKER_PREFIX),
  );
}

// ---------------------------------------------------------------------------
// The attempts guard (poison-PR): max 2 total launches per (pr, head), so a
// PR that keeps killing the review cannot eat the daily cap every day
// forever. Attempts are counted from RUN ARTIFACTS, not from memory:
//
//   - a run that reached the pipeline wrote pipeline.json, which carries the
//     full `pr` and `head_sha` — parsed fields, the preferred source (the
//     ledger's must-use-parsed-fields rule applied to the guard);
//   - a run that died before the pipeline wrote anything still created its
//     run dir, whose NAME encodes pr + sha8 (prRunDirCandidate) — the
//     fallback for exactly the dirs whose artifacts genuinely lack the sha.
//
// parsePipelineMeta is TOLERANT (null, never throw) against the module's own
// loud grain, deliberately: a corrupt pipeline.json falls back to the
// dir-name count, which errs toward COUNTING the attempt — the fail-safe
// direction for money — while a loud throw would brick every future tick on
// one damaged artifact, and skipping the dir would retry a poison PR
// forever.
//
// What this cannot see, and why that is fine: a spawn that dies in
// preflight (bad gotchas, missing agents dir) creates no run dir at all, so
// its attempts stay 0 — but every launch appends to watch.log BEFORE the
// spawn, so the daily cap still bounds the damage at `daily_cap` failed
// launches per day.

export const MAX_WATCH_ATTEMPTS = 2;

export interface RunDirFact {
  name: string;
  // null when the dir has no parseable pipeline.json.
  pipelineMeta: { pr: number; head_sha: string } | null;
}

export function parsePipelineMeta(
  raw: string,
): { pr: number; head_sha: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const pr = record.pr;
  const head = record.head_sha;
  // pr 0 is legal: local-mode runs share the runs root and record the
  // schema's "not a PR" value — they parse fine and never match a real PR.
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 0) return null;
  if (typeof head !== "string" || !isFullCommitId(head)) return null;
  return { pr, head_sha: head };
}

export function countAttempts(
  dirs: RunDirFact[],
  pr: number,
  headSha: string,
): number {
  // pr is a validated integer and the sha slice is hex, so the pattern
  // contains no regex metacharacters.
  const namePattern = new RegExp(`^pr-${pr}-${headSha.slice(0, 8)}-\\d+$`);
  let count = 0;
  for (const dir of dirs) {
    if (dir.pipelineMeta !== null) {
      // Parsed fields win over the dir name whenever they exist.
      if (dir.pipelineMeta.pr === pr && dir.pipelineMeta.head_sha === headSha) {
        count++;
      }
      continue;
    }
    if (namePattern.test(dir.name)) count++;
  }
  return count;
}

// The newest run dir for a (pr, head) — highest -<n> suffix, mirroring the
// smallest-unused-integer allocation in cli.ts. Cosmetic consumer only (the
// notification's finding counts), so null on no match, never a throw.
export function latestRunDirName(
  names: string[],
  pr: number,
  headSha: string,
): string | null {
  const pattern = new RegExp(`^pr-${pr}-${headSha.slice(0, 8)}-(\\d+)$`);
  let best: string | null = null;
  let bestN = -1;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match === null) continue;
    const n = Number(match[1]);
    if (n > bestN) {
      bestN = n;
      best = name;
    }
  }
  return best;
}

// Blocking/advisory counts from a findings.json body already parsed as JSON.
// Tolerant (null, never throw): the counts only decorate a notification, and
// a notification must never take the tick down — same contract as
// ghRepoWebUrl's "cosmetic by contract".
export function findingsTierCounts(
  parsed: unknown,
): { blocking: number; advisory: number } | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const findings = (parsed as Record<string, unknown>).findings;
  if (!Array.isArray(findings)) return null;
  let blocking = 0;
  for (const finding of findings) {
    if (typeof finding !== "object" || finding === null) return null;
    if ((finding as Record<string, unknown>).tier === "blocking") blocking++;
  }
  // Advisory is the remainder, the same projection cli.ts's summary uses.
  return { blocking, advisory: findings.length - blocking };
}

// ---------------------------------------------------------------------------
// The tick decision — every already-fetched fact in, one launch (at most)
// out. The shell gathers; this decides.

export type SkipReason =
  | "draft"
  | "reviewed-local"
  | "reviewed-remote"
  | "reviewed-prior-head"
  | "too-large"
  | "nothing-to-review"
  | "attempts-exhausted"
  | "in-flight";

export interface TickRepoFacts {
  // Expanded absolute operator checkout — the spawn's cwd and the skip
  // lines' identity.
  path: string;
  post: boolean;
  // The re-arm policy (config on_push): false = one review per PR, any
  // prior review of the number blocks; true = the (pr, head) key, every
  // push re-arms.
  onPush: boolean;
  prs: WatchPrCandidate[];
  // Parsed findings.json fields (pr + head_sha) of PR reviews that did not
  // fail their session — never dir names.
  localReviews: { pr: number; head: string }[];
  // Marker facts per PR: the declared heads AND whether any marker comment
  // exists at all (a legacy headless marker is seen but declares nothing).
  // A PR absent here means "comments not fetched" — the shell may skip the
  // fetch for candidates a cheaper check already killed, and an unfetched
  // PR must read as unguarded, not covered.
  remoteHeads: { pr: number; heads: string[]; markerSeen: boolean }[];
  attempts: { pr: number; head: string; count: number }[];
  // PR numbers the size gate rejected THIS TICK. Computed fresh by the
  // shell every tick and never persisted — see the recompute-every-tick WHY
  // on candidateSkipReason. A PR absent here was either under the limits or
  // never evaluated (the shell settles cheaper reasons first).
  tooLarge: number[];
  // PR numbers whose changed files are ALL generated content the size gate
  // excludes — so the effective diff is empty and there is nothing to review.
  // Same fresh-every-tick, never-persisted rule as tooLarge. WHY it is its
  // own reason and not folded into too-large: spawning here would have the
  // child CLI exit on an empty effective diff without creating a run dir, and
  // a run dir is where attempts are counted — so the watcher would re-spawn
  // the same PR every tick forever. Skipping it here is what stops that loop.
  nothingToReview: number[];
  // Heads with a fresh pending `pr-hero` commit status. Shell-gathered
  // (fetchCommitStatuses + isInFlightCommitStatus); a PR absent here is
  // not in-flight, same unfetched-means-unguarded rule as remoteHeads.
  inFlight: { pr: number; head: string }[];
  // Latest pr-hero status is pending, any age. Distinct from inFlight: a
  // stale pending on an already-reviewed PR is NOT in-flight (must not
  // block a launch) but MUST be settled to success so the yellow dot does
  // not stick after a crash between comment-post and status-complete.
  pending: { pr: number; head: string }[];
}

export type TickGate = "open" | "window-closed" | "cap-reached";

export interface TickGateInput {
  window: WatchWindow | null;
  localMinutes: number;
  dailyCap: number;
  launchedToday: number;
}

// Window before cap: outside the window the operator said "never at this
// hour", which is stronger than "not again today" — and the real tick
// checks this gate BEFORE any gh call, so a closed window costs nothing.
export function tickGate(input: TickGateInput): TickGate {
  if (!insideWindow(input.window, input.localMinutes)) return "window-closed";
  if (input.launchedToday >= input.dailyCap) return "cap-reached";
  return "open";
}

export interface TickInput extends TickGateInput {
  repos: TickRepoFacts[];
}

export interface TickSkip {
  repo: string;
  pr: number;
  head: string;
  reason: SkipReason;
}

export interface TickLaunch {
  repo: string;
  post: boolean;
  pr: number;
  head: string;
}

export interface TickDecision {
  gate: TickGate;
  skips: TickSkip[];
  // FIFO-ordered, kept whole so a dry run can show what stands in line
  // behind the pick.
  eligible: TickLaunch[];
  // null unless the gate is open AND something is eligible.
  launch: TickLaunch | null;
}

// ONE review per tick MAX, across all repos: eligible candidates sort by PR
// number ascending (oldest PR first — deterministic FIFO) and the first one
// wins. The sort is stable, so two repos sharing a PR number tie-break by
// their order in the config — the operator's own priority order.
//
// Skips and eligibility are computed even when the gate is closed: the $0
// dry run wants the full picture ("would run were it not for the window"),
// and a gated launch stays null either way.
export function decideTick(input: TickInput): TickDecision {
  const gate = tickGate(input);
  const skips: TickSkip[] = [];
  const eligible: TickLaunch[] = [];
  for (const repo of input.repos) {
    for (const candidate of repo.prs) {
      const reason = candidateSkipReason(repo, candidate);
      if (reason !== null) {
        skips.push({
          repo: repo.path,
          pr: candidate.pr,
          head: candidate.head,
          reason,
        });
        continue;
      }
      eligible.push({
        repo: repo.path,
        post: repo.post,
        pr: candidate.pr,
        head: candidate.head,
      });
    }
  }
  eligible.sort((a, b) => a.pr - b.pr);
  return {
    gate,
    skips,
    eligible,
    launch: gate === "open" ? (eligible[0] ?? null) : null,
  };
}

const SETTLE_SKIP_REASONS: ReadonlySet<SkipReason> = new Set([
  "reviewed-local",
  "reviewed-remote",
  "attempts-exhausted",
]);

// A leftover pending on a head this tick will not launch again.
// reviewed-local/remote: THIS head's review finished, the complete POST
// did not. attempts-exhausted: the review died and will not retry, so the
// yellow dot must not stick forever. NOT reviewed-prior-head: that only
// proves an EARLIER head was reviewed; a pending on the current head is a
// live review (manual re-review) and must not be overwritten with success.
// Live ticks settle these; dry-run must not.
export function pendingReviewsToSettle(
  skips: readonly TickSkip[],
  repos: readonly Pick<TickRepoFacts, "path" | "pending">[],
): { repo: string; pr: number; head: string }[] {
  const out: { repo: string; pr: number; head: string }[] = [];
  const seen = new Set<string>();
  for (const skip of skips) {
    if (!SETTLE_SKIP_REASONS.has(skip.reason)) continue;
    const repo = repos.find((entry) => entry.path === skip.repo);
    if (repo === undefined) continue;
    if (
      !repo.pending.some(
        (entry) => entry.pr === skip.pr && entry.head === skip.head,
      )
    ) {
      continue;
    }
    const key = `${skip.repo}:${skip.pr}:${skip.head}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo: skip.repo, pr: skip.pr, head: skip.head });
  }
  return out;
}

// The checks run in a FIXED order because the first hit is the reason a
// human reads in the log: draft → reviewed-local → local prior head →
// too-large → reviewed-remote → remote prior marker → in-flight → attempts.
// The same-head checks run BEFORE the prior-head ones so the more specific
// reason always wins. in-flight sits after "already reviewed" (a completed
// review is more specific than a pending status) and before attempts, so a
// live run is not launched a second time just because attempts is still 1.
//
// The re-arm policy: under on_push (the original behavior) a new push
// changes the head, every (pr, head) key is fresh by construction, and an
// updated PR becomes eligible again — with auto-post the comment tracks the
// live head. Under the DEFAULT (on_push: false) each PR is reviewed ONCE:
// any prior review of the PR number — a local findings.json at any head,
// or any pr-hero marker comment whatever it declares (a legacy headless
// marker proves a review happened even though it covers no specific head) —
// skips it as `reviewed-prior-head`, so a push never re-bills a review.
function candidateSkipReason(
  repo: TickRepoFacts,
  candidate: WatchPrCandidate,
): SkipReason | null {
  if (candidate.isDraft) return "draft";
  if (
    repo.localReviews.some(
      (r) => r.pr === candidate.pr && r.head === candidate.head,
    )
  ) {
    return "reviewed-local";
  }
  if (!repo.onPush && repo.localReviews.some((r) => r.pr === candidate.pr)) {
    return "reviewed-prior-head";
  }
  // The size gate (size-gate.ts) — a COST skip, not a quality judgement and
  // not a failure. It sits here, after the local review checks and before
  // the remote ones, because the shell can settle it from facts it already
  // holds and thereby skip the per-PR comments fetch for an oversized PR.
  //
  // Three properties this skip MUST have, each of which a later change could
  // quietly break:
  //
  //   (a) It does NOT consume an attempt. MAX_WATCH_ATTEMPTS exists for a
  //       POISON PR — one that keeps killing the review — and attempts are
  //       counted from run artifacts, which a gate skip never creates (the
  //       CLI gate fires before createPrRunDir). Nothing here touches the
  //       attempts bookkeeping below, and nothing here may start.
  //   (b) It writes NO review marker, local or remote. A force-push can
  //       shrink a PR back under the limits, and it must become eligible on
  //       the very next tick — so the verdict is RECOMPUTED every tick from
  //       live gh counters and never persisted anywhere.
  //   (c) It does NOT arm the on_push "one review per PR" state. That state
  //       is armed by a findings.json or a marker comment, both of which
  //       only a review that actually ran produces. A skip is not a review;
  //       treating it as one would permanently retire the PR.
  if (repo.tooLarge.includes(candidate.pr)) return "too-large";
  // The other end of the same instrument: everything changed is excluded
  // generated content, so a review would read an empty diff. Same three
  // properties as above — no attempt, no marker, recomputed every tick.
  if (repo.nothingToReview.includes(candidate.pr)) return "nothing-to-review";
  const remote = repo.remoteHeads.find((r) => r.pr === candidate.pr);
  if ((remote?.heads ?? []).includes(candidate.head)) {
    return "reviewed-remote";
  }
  if (!repo.onPush && remote?.markerSeen === true) {
    return "reviewed-prior-head";
  }
  // Cross-machine in-flight lock: a pending `pr-hero` commit status on this
  // head, younger than IN_FLIGHT_TTL_MS. Same three properties as too-large
  // (no attempt consumed, no marker written, recomputed every tick) PLUS it
  // is the thing that closes the accepted ~10-min dual-watcher race for as
  // long as the first review is actually running.
  if (
    repo.inFlight.some(
      (entry) => entry.pr === candidate.pr && entry.head === candidate.head,
    )
  ) {
    return "in-flight";
  }
  const attempts =
    repo.attempts.find(
      (a) => a.pr === candidate.pr && a.head === candidate.head,
    )?.count ?? 0;
  if (attempts >= MAX_WATCH_ATTEMPTS) return "attempts-exhausted";
  return null;
}

// The pre-launch exclusion veto's pure half (design D6, prheroignore Phase
// 6): tier 2 in gatherRepoFacts (watch/watch.ts) only runs a per-file rescue for a
// candidate whose AGGREGATE already exceeds a limit, so a PR whose aggregate
// is already under both limits — but whose changed files are ALL excluded
// content — never gets a per-file evaluation at all. Without this veto it
// launches straight into an empty effective diff, the CLI exits before
// creating a run dir, and with no run dir the attempts guard cannot see it —
// so it relaunches every tick, burning the daily cap and the tick's one
// launch slot on a PR the size gate would have rescued anyway.
//
// SAME truncation guard as tier 2 (`perFile.length >= candidateChangedFiles`),
// carried here because under-counting in THIS direction is the OPPOSITE
// failure of tier 2's own under-count risk: tier 2 under-counting falsely
// RESCUES a monster PR, while under-counting here would falsely VETO a
// launch tier 1 already cleared — silently dropping a real review. Both
// directions are closed by the same one-line guard.
export function preLaunchExclusionVeto(
  perFile: NumstatFile[],
  candidateChangedFiles: number,
  gateConfig: SizeGateConfig,
): boolean {
  if (perFile.length < candidateChangedFiles) return false;
  const verdict = evaluateSizeGate(perFile, gateConfig);
  return verdict.ok && verdict.effectiveFiles === 0;
}

// ---------------------------------------------------------------------------
// watch.log — append-only, one line per event, and the daily-cap COUNTER:
// today's `launched` lines ARE the count, no separate state file. The
// launched line is appended BEFORE the spawn on purpose (fail-safe
// direction: a crash mid-review must still count toward the cap — err
// toward counting, because the failure mode of over-counting is a skipped
// review and the failure mode of under-counting is unbounded spend).

// LOCAL-time ISO 8601 with the numeric offset, never toISOString's UTC: the
// cap is a local-calendar-day budget, and a UTC date would roll the counter
// over at whatever local hour UTC midnight happens to be.
export function localIsoTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function logLine(ts: string, text: string): string {
  return `${ts} ${text}`;
}

export function skipLine(
  ts: string,
  repoBase: string,
  pr: number,
  headSha: string,
  reason: SkipReason,
): string {
  return `${ts} skip repo=${repoBase} pr=${pr} head=${headSha.slice(0, 8)} reason=${reason}`;
}

// THE format contract with countLaunchedToday below — change them together.
export function launchedLine(
  ts: string,
  pr: number,
  repoBase: string,
  headSha: string,
): string {
  return `${ts} launched pr=${pr} repo=${repoBase} head=${headSha.slice(0, 8)}`;
}

export interface ReviewOutcome {
  pr: number;
  ok: boolean;
  exitCode: number;
  counts: { blocking: number; advisory: number } | null;
}

export function outcomeLine(
  ts: string,
  repoBase: string,
  outcome: ReviewOutcome,
): string {
  const status = outcome.ok ? "status=ok" : "status=failed";
  const detail = outcome.ok
    ? outcome.counts === null
      ? ""
      : ` blocking=${outcome.counts.blocking} advisory=${outcome.counts.advisory}`
    : ` exit=${outcome.exitCode}`;
  return `${ts} outcome pr=${outcome.pr} repo=${repoBase} ${status}${detail}`;
}

// Counts today's launches back out of the raw log text. dayPrefix is the
// local "YYYY-MM-DD" — the first 10 chars of localIsoTimestamp, so writer
// and counter agree on what "today" means by construction. The match is
// deliberately narrow (timestamp token, then the literal `launched` token):
// skip/outcome/free-text lines must never inflate the cap, and a foreign
// line must never crash the parse.
export function countLaunchedToday(logText: string, dayPrefix: string): number {
  let count = 0;
  for (const line of logText.split("\n")) {
    const match = /^(\S+)\s+launched(?:\s|$)/.exec(line);
    if (match === null) continue;
    if ((match[1] ?? "").startsWith(dayPrefix)) count++;
  }
  return count;
}

export interface LastActivity {
  launched: string | null;
  outcome: string | null;
}

// The status view's "what happened last": the FINAL launched and outcome
// lines of the log, whole — the line already carries its timestamp, pr,
// repo and result, so re-parsing it into fields would only lose fidelity.
// Same event-token discipline as the cap counter: free text never matches.
export function lastLogActivity(logText: string): LastActivity {
  let launched: string | null = null;
  let outcome: string | null = null;
  for (const line of logText.split("\n")) {
    if (/^\S+\s+launched(?:\s|$)/.test(line)) launched = line;
    else if (/^\S+\s+outcome(?:\s|$)/.test(line)) outcome = line;
  }
  return { launched, outcome };
}

// ---------------------------------------------------------------------------
// The lockfile — belt and suspenders under cron or a hand-run tick (launchd
// itself is already single-instance per label). Advisory: the file holds a
// PID, a live PID means "another tick is running, exit quietly", a dead one
// is stolen.

export function parseLockPid(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return pid > 0 ? pid : null;
}

// ---------------------------------------------------------------------------
// The launchd agent (macOS). Rendering is pure string-out so a test can pin
// the exact plist; loading it is the shell's job.

export const WATCH_LAUNCHD_LABEL = "io.prhero.watch";

export interface WatchPlistInput {
  // The engine's OWN invocation (assets.ts's selfInvocation()), never a fixed
  // runtime + entry-script pair and never a bare `pr-hero`. Two traps, one
  // field:
  //
  // launchd starts agents with a bare-bones PATH (/usr/bin:/bin) that has
  // never heard of bun, so a name that resolves in every terminal resolves in
  // nothing launchd starts — selfInvocation answers absolute on both halves.
  //
  // And a compiled binary IS the entry: it contributes no script path at all.
  // The pair could not say that, so it rendered `<binary> /$bunfs/root/cli.ts
  // watch --once`, whose second argument exists on no machine. launchd ran it
  // every interval, the CLI rejected the path as an unknown command every
  // time, into a log nobody reads — and `watch install` reported success.
  invocation: SelfInvocation;
  intervalSeconds: number;
  // launchd's stdout/stderr for the tick process — the SEPARATE launchd.log,
  // so the spawned review's progress noise can never land in watch.log and
  // corrupt the cap counter.
  logPath: string;
  // The CURRENT process's PATH, captured at install time: the tick spawns
  // gh, git, codegraph and claude, none of which live on launchd's default
  // PATH — the install-time shell knows where they are, launchd does not.
  pathEnv: string;
}

export function renderWatchPlist(input: WatchPlistInput): string {
  const programArguments = [input.invocation.command, ...input.invocation.args];
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${WATCH_LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...[...programArguments, "watch", "--once"].map(
      (arg) => `    <string>${xmlEscape(arg)}</string>`,
    ),
    `  </array>`,
    `  <key>StartInterval</key>`,
    `  <integer>${input.intervalSeconds}</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(input.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(input.logPath)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${xmlEscape(input.pathEnv)}</string>`,
    `  </dict>`,
    `</dict>`,
    `</plist>`,
  ];
  return `${lines.join("\n")}\n`;
}

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// StartInterval read back OUT of an installed plist, for `watch status`.
// TOLERANT (null, never throw) against the module's loud grain: the plist
// on disk may predate this parser or have been edited by hand, and status
// is a read-only report — "installed (interval unreadable)" is the honest
// answer, a crash is not.
export function parsePlistInterval(plist: string): number | null {
  const match = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(
    plist,
  );
  if (match === null) return null;
  const seconds = Number(match[1]);
  return seconds > 0 ? seconds : null;
}

// ---------------------------------------------------------------------------
// The macOS notification — argv for `osascript`, built here so the
// AppleScript string escaping is testable. The args are spawned as an ARRAY
// (no shell anywhere), so the only escaping that exists is AppleScript's
// own string literal: backslash and double quote.

export function osascriptNotifyArgs(title: string, text: string): string[] {
  const quote = (s: string): string =>
    `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return [
    "osascript",
    "-e",
    `display notification ${quote(text)} with title ${quote(title)}`,
  ];
}

export function outcomeNotificationText(outcome: ReviewOutcome): string {
  if (!outcome.ok) {
    return `PR #${outcome.pr} review failed (exit ${outcome.exitCode})`;
  }
  if (outcome.counts === null) {
    return `PR #${outcome.pr} reviewed (counts unavailable)`;
  }
  return (
    `PR #${outcome.pr}: ${outcome.counts.blocking} blocking, ` +
    `${outcome.counts.advisory} advisory`
  );
}

// ---------------------------------------------------------------------------
// `watch status` — a read-only report over whatever exists. The shell
// gathers the facts (it never throws on an absent piece: no config, no log,
// no plist and no lock are all ordinary states worth reporting), and this
// renders them — same shape as the dry-run printer, pure so a test can pin
// every branch.

export interface WatchStatusFacts {
  // Named for the file it carries (~/.prhero/watch.json), never `configPath`
  // — C5 retired that name on PrheroLayout because it stopped identifying a
  // file. This field is the one consumer that retirement provably cannot
  // reach: it belongs to a DIFFERENT type, so `watchConfigPath: paths.
  // watchConfigPath` in watch/watch.ts would have compiled just as happily as
  // `configPath:` did. Renamed by hand, and pinned by a test, because a
  // mechanism that cannot enforce a rule has to be paired with one that can.
  watchConfigPath: string;
  // null = no config file. configError carries the parse failure when the
  // file exists but is invalid — status REPORTS brokenness instead of
  // crashing over it, because a status you cannot run on a broken setup is
  // useless exactly when you need it.
  config: WatchConfig | null;
  configError: string | null;
  launchedToday: number;
  plistPath: string;
  installed: boolean;
  // null when not installed OR the plist's StartInterval is unreadable.
  intervalSeconds: number | null;
  lockPid: number | null;
  lastLaunched: string | null;
  lastOutcome: string | null;
}

export function renderWatchStatus(facts: WatchStatusFacts): string[] {
  const row = (label: string, value: string): string =>
    `  ${label.padEnd(13)}${value}`;
  const lines = ["pr-hero watch — status", ""];
  if (facts.configError !== null) {
    lines.push(
      row("config", `INVALID — ${facts.watchConfigPath}: ${facts.configError}`),
    );
  } else if (facts.config === null) {
    lines.push(
      row(
        "config",
        `none (${facts.watchConfigPath}) — run "pr-hero watch add" inside a ` +
          "repo to opt it in",
      ),
    );
  } else {
    lines.push(row("config", facts.watchConfigPath));
    if (facts.config.repos.length === 0) {
      lines.push(row("", 'no repos watched — "pr-hero watch add" opts one in'));
    }
    for (const repo of facts.config.repos) {
      lines.push(
        row(
          "",
          `${repo.path} post=${repo.post} on_push=${repo.onPush} ` +
            `max_lines=${repo.maxChangedLines} max_files=${repo.maxChangedFiles}`,
        ),
      );
    }
    lines.push(
      row(
        "today",
        `${facts.launchedToday} of ${facts.config.dailyCap} launches used`,
      ),
    );
    lines.push(
      row(
        "window",
        facts.config.window === null
          ? "always"
          : `${facts.config.window.start}-${facts.config.window.end}`,
      ),
    );
  }
  // Without a valid config there is no cap to report against, but the log
  // exists independently — the raw count still says whether money moved.
  if (facts.config === null || facts.configError !== null) {
    lines.push(row("today", `${facts.launchedToday} launched`));
  }
  lines.push(
    row(
      "launchd",
      facts.installed
        ? facts.intervalSeconds === null
          ? `installed (${facts.plistPath}, interval unreadable)`
          : `installed — one tick every ${formatIntervalSeconds(facts.intervalSeconds)}`
        : 'not installed — run "pr-hero watch install" to start ticking',
    ),
  );
  lines.push(
    row(
      "lock",
      facts.lockPid === null
        ? "free"
        : `held by pid ${facts.lockPid} (a tick is running)`,
    ),
  );
  lines.push(row("last launch", facts.lastLaunched ?? "none recorded"));
  lines.push(row("last outcome", facts.lastOutcome ?? "none recorded"));
  return lines;
}

function formatIntervalSeconds(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}
