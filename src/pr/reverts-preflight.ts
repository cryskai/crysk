// Revert/hotfix mining decisions (GitHub #41), pure so every classification
// rule is pinned offline. pr/reverts.ts is the I/O shell: it runs `git log` over
// the default branch and asks `gh api` for the PR numbers and diff sizes.
//
// PURITY CONTRACT, and it is load-bearing rather than stylistic: nothing here
// reads the filesystem, spawns git or gh, touches the network, or READS A
// CLOCK. The artifact must be byte-identical across two runs over unchanged
// history, so `diff` on it means "history changed", never "time passed". An
// elapsed duration is therefore always the difference of two RECORDED
// timestamps, never a measurement against now.
//
// What this module does NOT do, by the issue's explicit scope: it never runs
// a review, never scores, and never labels what the defect was. Everything it
// emits is a CANDIDATE for a human glance.

import { CliUsageError } from "../errors";

// Two years of default branch history. WHY this number: a revert is only
// useful as a known-bad case while the surrounding code still resembles the
// tree a reviewer would see, and a full-history scan on a busy repo spends
// minutes of `git log` plus one gh call per hit to surface commits nobody
// would replay. Two years is long enough that a quiet repo still yields a
// corpus, short enough that a busy one stays a seconds-long read-only scan.
export const DEFAULT_REVERTS_SINCE = "24 months ago";

// The record separators handed to `git log --format`. \x1f (unit separator)
// and \x1e (record separator) are ASCII control characters that git will not
// emit from a commit message — which is the entire point: a message that
// contains newlines, pipes, quotes or the word "commit" still parses, because
// the delimiter is a byte no author can type into a subject or body.
export const GIT_LOG_FIELD_SEP = "\x1f";
export const GIT_LOG_RECORD_SEP = "\x1e";
export const GIT_LOG_FORMAT = `--format=%H${GIT_LOG_FIELD_SEP}%ct${GIT_LOG_FIELD_SEP}%s${GIT_LOG_FIELD_SEP}%b${GIT_LOG_RECORD_SEP}`;

export interface GitLogRecord {
  sha: string;
  // Committer date, unix seconds (%ct). Seconds rather than an ISO string
  // because it is only ever used as a SORT KEY here; the human-facing
  // timestamps in the artifact are the PRs' own merged_at values from gh.
  committedAtSec: number;
  subject: string;
  body: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

// Splits the `git log GIT_LOG_FORMAT` stream. Fails loud on a chunk that is
// not four fields with a real sha: a silently dropped commit is a silently
// missing candidate, and this command's whole value is that the list is
// complete for the window it claims.
export function parseGitLogRecords(raw: string): GitLogRecord[] {
  const records: GitLogRecord[] = [];
  for (const chunk of raw.split(GIT_LOG_RECORD_SEP)) {
    // git writes a newline after each record's trailing separator, so every
    // chunk after the first opens with one. Stripping leading newlines only
    // (not a full trim) keeps a body's own leading content intact.
    const cleaned = chunk.replace(/^[\r\n]+/, "");
    if (cleaned.trim().length === 0) continue;
    const fields = cleaned.split(GIT_LOG_FIELD_SEP);
    if (fields.length < 4) {
      throw new CliUsageError(
        `git log record has ${fields.length} field(s), expected 4 ` +
          "(sha, committer date, subject, body)",
      );
    }
    const sha = (fields[0] ?? "").trim();
    if (!FULL_SHA.test(sha)) {
      throw new CliUsageError(`git log record has no full sha, got: ${sha}`);
    }
    const committedAtSec = Number((fields[1] ?? "").trim());
    if (!Number.isInteger(committedAtSec)) {
      throw new CliUsageError(
        `git log record ${sha} has a non-integer committer date: ${fields[1]}`,
      );
    }
    records.push({
      sha,
      committedAtSec,
      subject: fields[2] ?? "",
      // Everything after the third separator is body, separators included —
      // a body cannot contain \x1f, so a rejoin is lossless.
      body: fields.slice(3).join(GIT_LOG_FIELD_SEP).replace(/\s+$/, ""),
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Classification. ANCHORED at position 0, never a substring search.
//
// This is the single most important correctness rule in the command. A
// substring match on revert|rollback|hotfix produces false positives that
// look entirely plausible — every one of these is real musive history and
// NONE of them is a revert:
//   docs(mus-638): handle rollback success status
//   test(MUS-518): re-pin the rollback-scan tripwire after the reformat
//   fix(MUS-706): hoist rollback captures so the catch can revert the cover
//   ci: MUS-598 revert temporary Biome probe
//   fix(app): JD2 round-1 corrections — flush-overlap rollback, ...
// A corpus polluted with those is worse than no corpus: it spends the human
// glance the whole artifact is trying to make cheap.

export type RevertConfidence = "body-linked" | "pattern-only";

// git's own machine-written linkage, the highest-confidence signal there is.
// Case-sensitive and anchored to a line start: git writes exactly this.
const BODY_LINK = /^This reverts commit ([0-9a-f]{40})\.?/m;

// `Revert "…"` is git's generated subject. Case-insensitive because a
// hand-typed lowercase `revert "…"` means the same thing and the ANCHOR, not
// the capital R, is what keeps the false positives out.
const SUBJECT_QUOTED = /^revert\s+"/i;

// Conventional-commit revert type at position 0: `revert:` or
// `revert(scope):`, with the optional `!` breaking-change marker.
const SUBJECT_CONVENTIONAL = /^revert(\([^)]*\))?!?:/i;

// `Merge pull request #<n> from <owner>/<branch>` — GitHub's own merge
// subject. Only the BRANCH segment is pattern-matched, so a PR that merely
// mentions a revert in its title cannot qualify.
const MERGE_SUBJECT = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/;

// A branch whose name starts with hotfix or revert, allowing the separator
// forms seen in real history: `hotfix/`, `hotfix-prod/`, `revert/`,
// `revert-`. Anchored and separator-terminated so `revertigo/x` cannot match.
const REVERT_BRANCH = /^(hotfix|revert)([-/]|$)/i;

// GitHub's revert branches carry the reverted PR number for free:
// `revert-478-feat-username-cannot-change` → 478.
const BRANCH_PR = /^revert[-/](\d+)(?:[-/]|$)/i;

export interface ClassifiedRevert {
  sha: string;
  committedAtSec: number;
  subject: string;
  body: string;
  confidence: RevertConfidence;
  // body-linked only: the sha the body says was reverted.
  revertedSha: string | null;
  // From `Merge pull request #<n>`: the PR that DID the reverting.
  mergePr: number | null;
  // From a `revert-<n>-…` branch: the PR that WAS reverted.
  branchPr: number | null;
}

export function parseRevertedSha(body: string): string | null {
  // First match only. One logical revert can name several shas across several
  // commits; the pair dedupe below is what collapses those, not this.
  const match = BODY_LINK.exec(body);
  return match?.[1] ?? null;
}

export function parseMergeSubject(
  subject: string,
): { pr: number; branch: string } | null {
  const match = MERGE_SUBJECT.exec(subject);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const pr = Number(match[1]);
  if (!Number.isInteger(pr) || pr < 1) return null;
  return { pr, branch: match[2] };
}

export function revertedPrFromBranch(branch: string): number | null {
  const match = BRANCH_PR.exec(branch);
  if (match?.[1] === undefined) return null;
  const pr = Number(match[1]);
  return Number.isInteger(pr) && pr >= 1 ? pr : null;
}

// Returns null for anything that is not a revert. body-linked is tested
// FIRST and stands on its own: git wrote that line, so it outranks whatever
// a human typed into the subject.
export function classifyRevertCommit(
  record: GitLogRecord,
): ClassifiedRevert | null {
  const merge = parseMergeSubject(record.subject);
  const base = {
    sha: record.sha,
    committedAtSec: record.committedAtSec,
    subject: record.subject,
    body: record.body,
    mergePr: merge?.pr ?? null,
    branchPr: merge === null ? null : revertedPrFromBranch(merge.branch),
  };
  const revertedSha = parseRevertedSha(record.body);
  if (revertedSha !== null) {
    return { ...base, confidence: "body-linked", revertedSha };
  }
  const subjectMatches =
    SUBJECT_QUOTED.test(record.subject) ||
    SUBJECT_CONVENTIONAL.test(record.subject);
  const branchMatches = merge !== null && REVERT_BRANCH.test(merge.branch);
  if (subjectMatches || branchMatches) {
    return { ...base, confidence: "pattern-only", revertedSha: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Candidates: a classified commit with whatever the gh lookups resolved.

export interface RevertCandidate {
  revertCommitSha: string;
  revertCommittedAtSec: number;
  revertSubject: string;
  revertBody: string;
  confidence: RevertConfidence;
  revertingPr: number | null;
  revertingPrMergedAt: string | null;
  revertedPr: number | null;
  revertedPrTitle: string | null;
  revertedPrMergedAt: string | null;
  // The range to replay the reverted PR: base.sha..head.sha.
  revertedBaseSha: string | null;
  revertedHeadSha: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  // How many revert commits collapsed into this representative. 1 means it
  // stood alone.
  collapsedCommits: number;
}

// FILTER 1, and it is not optional. A revert whose reverting PR equals the
// reverted PR never crossed a merge boundary: somebody added a commit and
// removed it again inside one branch, so nothing ever shipped and there is no
// regression to catch. Found by probing real data — musive 0f309d0ed resolves
// to PR 1534 on BOTH sides. Without this the corpus inflates with cases where
// the "known bad" code was never on the default branch at all.
export function dropSamePrReverts(
  candidates: RevertCandidate[],
): RevertCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.revertedPr === null ||
      candidate.revertingPr === null ||
      candidate.revertedPr !== candidate.revertingPr,
  );
}

// FILTER 2, equally not optional. One logical revert is frequently several
// commits — musive reverted PR 478 via PR 483 in three commits (4ee802e43,
// 5c8c4fa4e, fea0540a0) across app/web/common. That is ONE case. Counting it
// three times would triple-weight a single decision in any tally built on
// this artifact.
//
// The representative is the EARLIEST commit of the pair (the one that opened
// the revert), and the count of what collapsed into it is recorded so the
// artifact never hides the merge.
export function dedupeRevertPairs(
  candidates: RevertCandidate[],
): RevertCandidate[] {
  const byPair = new Map<string, RevertCandidate>();
  const order: string[] = [];
  for (const candidate of candidates) {
    // When NEITHER side resolved to a PR number there is no pair to dedupe
    // on, and collapsing on a shared "unknown" key would silently merge two
    // unrelated commits. Such a candidate keys on its own sha instead.
    const key =
      candidate.revertedPr === null && candidate.revertingPr === null
        ? `sha:${candidate.revertCommitSha}`
        : `pair:${candidate.revertedPr ?? "?"}:${candidate.revertingPr ?? "?"}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, { ...candidate, collapsedCommits: 1 });
      order.push(key);
      continue;
    }
    const earliest =
      candidate.revertCommittedAtSec < existing.revertCommittedAtSec
        ? candidate
        : existing;
    byPair.set(key, {
      ...earliest,
      collapsedCommits: existing.collapsedCommits + 1,
    });
  }
  return order.map((key) => {
    const candidate = byPair.get(key);
    if (candidate === undefined) {
      throw new CliUsageError(`dedupe lost the candidate keyed ${key}`);
    }
    return candidate;
  });
}

// Both filters plus the artifact's deterministic order: newest reverting
// commit first, ties broken by sha so two runs over unchanged history cannot
// disagree about which of two same-second commits comes first.
export function selectRevertCandidates(
  candidates: RevertCandidate[],
): RevertCandidate[] {
  const kept = dedupeRevertPairs(dropSamePrReverts(candidates));
  return [...kept].sort((a, b) =>
    b.revertCommittedAtSec === a.revertCommittedAtSec
      ? a.revertCommitSha.localeCompare(b.revertCommitSha)
      : b.revertCommittedAtSec - a.revertCommittedAtSec,
  );
}

// ---------------------------------------------------------------------------
// gh payload readers. The pure reader names the FIELD it could not read, and the shell re-wraps adding the
// endpoint only it knows.

export interface CommitPullRef {
  number: number;
  title: string | null;
  mergedAt: string | null;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliUsageError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// `gh api repos/<slug>/commits/<sha>/pulls` → the PRs a commit belongs to.
// VERIFIED: this endpoint returns additions/deletions/changed_files as NULL,
// which is why the size fields come from a second /pulls/<n> call and never
// from here. Anything that is not a merged PR object is skipped rather than
// fatal — an unmerged or malformed entry is not a case, and one odd row must
// not kill a scan of hundreds of commits.
export function parseCommitPulls(raw: string): CommitPullRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError("commit pulls response is not JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new CliUsageError("commit pulls response is not an array");
  }
  const refs: CommitPullRef[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const number = optionalNumber(record.number);
    if (number === null || !Number.isInteger(number) || number < 1) continue;
    refs.push({
      number,
      title: optionalString(record.title),
      mergedAt: optionalString(record.merged_at),
    });
  }
  return refs;
}

// A commit can belong to more than one PR (a branch merged into a branch).
// The FIRST is GitHub's own primary association and the one the web UI shows;
// picking anything else would need a rule this command has no evidence for.
export function pickCommitPull(refs: CommitPullRef[]): CommitPullRef | null {
  return refs[0] ?? null;
}

export interface PullDetails {
  number: number;
  title: string | null;
  mergedAt: string | null;
  baseSha: string | null;
  headSha: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

// `gh api repos/<slug>/pulls/<n>` → the fields the artifact needs that the
// commit-pulls endpoint leaves null: the diff size and the base/head shas
// that make up the replay range.
export function parsePullDetails(raw: string): PullDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError("pull details response is not JSON");
  }
  const record = asRecord(parsed, "pull details response");
  const number = optionalNumber(record.number);
  if (number === null || !Number.isInteger(number) || number < 1) {
    throw new CliUsageError("pull details response has no number");
  }
  const base = record.base;
  const head = record.head;
  return {
    number,
    title: optionalString(record.title),
    mergedAt: optionalString(record.merged_at),
    baseSha:
      typeof base === "object" && base !== null
        ? optionalString((base as Record<string, unknown>).sha)
        : null,
    headSha:
      typeof head === "object" && head !== null
        ? optionalString((head as Record<string, unknown>).sha)
        : null,
    additions: optionalNumber(record.additions),
    deletions: optionalNumber(record.deletions),
    changedFiles: optionalNumber(record.changed_files),
  };
}

// `https://github.com/owner/repo` → `owner/repo`, the path segment `gh api
// repos/<slug>/…` wants. Deliberately built on top of review/preflight.ts's
// repoWebUrlFromRemote (which already normalises the three remote shapes)
// rather than parsing a remote again: a second URL parser is a second place
// for the owner to be wrong.
export function repoSlugFromWebUrl(webUrl: string): string | null {
  const prefix = "https://github.com/";
  if (!webUrl.startsWith(prefix)) return null;
  const slug = webUrl.slice(prefix.length).replace(/\/+$/, "");
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
}

// ---------------------------------------------------------------------------
// The artifact.

export interface RevertsArtifact {
  repoSlug: string;
  ref: string;
  since: string;
  scannedCommits: number;
  candidates: RevertCandidate[];
}

const CANDIDATE_WARNING = [
  "> **These are CANDIDATES REQUIRING HUMAN CONFIRMATION, not confirmed",
  "> defects.** A revert is not always a defect: reverts also happen for",
  "> product reasons, merge accidents and dependency rollbacks. Every entry",
  "> below needs a human glance — and its stated reason is recorded here so",
  "> that glance is cheap — before it is treated as a known-bad case.",
];

const CLASS_ORDER: RevertConfidence[] = ["body-linked", "pattern-only"];

const CLASS_NOTE: Record<RevertConfidence, string> = {
  "body-linked":
    "The commit body carries git's own `This reverts commit <sha>.` line — " +
    "machine-written linkage, the highest confidence available.",
  "pattern-only":
    'No body link. Matched by an anchored subject (`Revert "…"`, ' +
    "`revert:`) or a merge from a `hotfix`/`revert` branch. Lower " +
    "confidence: check what it actually reverted.",
};

export function renderRevertsArtifact(artifact: RevertsArtifact): string {
  const out: string[] = [];
  out.push("# crysk — revert/hotfix candidates");
  out.push("");
  out.push(`- repository: \`${artifact.repoSlug}\``);
  out.push(`- ref: \`${artifact.ref}\``);
  out.push(`- window: \`--since ${artifact.since}\``);
  out.push(
    `- scanned: ${artifact.scannedCommits} commit(s) · ` +
      `${artifact.candidates.length} candidate(s)`,
  );
  for (const confidence of CLASS_ORDER) {
    const count = artifact.candidates.filter(
      (candidate) => candidate.confidence === confidence,
    ).length;
    out.push(`- ${confidence}: ${count}`);
  }
  out.push("");
  out.push(...CANDIDATE_WARNING);
  out.push("");
  for (const confidence of CLASS_ORDER) {
    const group = artifact.candidates.filter(
      (candidate) => candidate.confidence === confidence,
    );
    out.push(`## ${confidence} (${group.length})`);
    out.push("");
    out.push(CLASS_NOTE[confidence]);
    out.push("");
    if (group.length === 0) {
      out.push("_None in this window._");
      out.push("");
      continue;
    }
    for (const candidate of group) {
      out.push(...renderCandidate(candidate));
    }
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

function renderCandidate(candidate: RevertCandidate): string[] {
  const out: string[] = [];
  const title = candidate.revertedPrTitle ?? "(title unresolved)";
  out.push(
    candidate.revertedPr === null
      ? `### reverted PR unresolved — ${shortSha(candidate.revertCommitSha)}`
      : `### PR #${candidate.revertedPr} — ${title}`,
  );
  out.push("");
  out.push(
    `- reverted PR: ${prField(candidate.revertedPr)}, merged ` +
      `${stampField(candidate.revertedPrMergedAt)}`,
  );
  out.push(
    `- reverting PR: ${prField(candidate.revertingPr)}, merged ` +
      `${stampField(candidate.revertingPrMergedAt)}`,
  );
  out.push(
    `- elapsed: ${formatMergeToRevertGap(
      candidate.revertedPrMergedAt,
      candidate.revertingPrMergedAt,
    )}`,
  );
  out.push(`- reverting commit: \`${candidate.revertCommitSha}\``);
  out.push(`- replay range: ${replayRange(candidate)}`);
  out.push(`- diff size: ${diffSize(candidate)}`);
  out.push(`- stated reason: ${candidate.revertSubject.trim() || "(none)"}`);
  if (candidate.collapsedCommits > 1) {
    out.push(
      `- collapsed: ${candidate.collapsedCommits} revert commits share this ` +
        "reverted/reverting PR pair; the earliest is shown",
    );
  }
  const reason = revertReasonBody(candidate.revertBody);
  if (reason.length > 0) {
    out.push("");
    for (const line of reason) out.push(`> ${line}`);
  }
  out.push("");
  return out;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function prField(pr: number | null): string {
  return pr === null ? "unresolved" : `#${pr}`;
}

function stampField(stamp: string | null): string {
  return stamp ?? "unknown";
}

function replayRange(candidate: RevertCandidate): string {
  if (
    candidate.revertedBaseSha === null ||
    candidate.revertedHeadSha === null
  ) {
    return "unresolved";
  }
  return `\`${candidate.revertedBaseSha}..${candidate.revertedHeadSha}\``;
}

function diffSize(candidate: RevertCandidate): string {
  if (candidate.additions === null || candidate.deletions === null) {
    return "unknown";
  }
  const files =
    candidate.changedFiles === null
      ? "unknown files"
      : `${candidate.changedFiles} file(s)`;
  return `+${candidate.additions}/-${candidate.deletions}, ${files}`;
}

// The body MINUS git's machine-written lines: `This reverts commit …` says
// nothing a human needs, and the sha is already rendered above. What is left
// is the author's stated reason, which is the whole point of recording it.
export function revertReasonBody(body: string): string[] {
  const lines = body
    .split("\n")
    .filter(
      (line) => !/^This reverts commit [0-9a-f]{40}\.?$/.test(line.trim()),
    )
    .map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && (lines[0] ?? "").length === 0) lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").length === 0) {
    lines.pop();
  }
  return lines;
}

// Difference of two RECORDED timestamps. Never a clock read — see the purity
// contract at the top of this file: an artifact carrying "3 days ago" would
// change every day on unchanged history and make `diff` meaningless.
export function formatMergeToRevertGap(
  fromIso: string | null,
  toIso: string | null,
): string {
  if (fromIso === null || toIso === null) return "unknown";
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return "unknown";
  const totalMinutes = Math.round((to - from) / 60_000);
  if (totalMinutes < 0) return "unknown";
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return `${parts.join(" ")} between merge and revert`;
}
