// Known-bad corpus decisions (GitHub #43), pure so every detector, join and
// rendering rule is pinned offline. corpus/corpus.ts is the I/O shell: it walks
// merged PRs through `gh api graphql`, diffs and blames through git, and this
// module decides what those bytes mean.
//
// PURITY CONTRACT, same as pr/reverts-preflight.ts and load-bearing for the same
// reason: nothing here reads the filesystem, spawns git or gh, touches the
// network, or READS A CLOCK. The artifact must be byte-identical across two
// renders of the same data, so `diff` on it means "history changed", never
// "time passed". Every duration below is the difference of two RECORDED
// timestamps (git/gh-returned strings), never a measurement against now.
//
// Scope, straight from the issue: CANDIDATES for a human glance only. No
// review runs, nothing is scored, nothing is labelled THE defect. A bug-fix
// PR proves something was wrong — not that a reviewer should have caught it,
// and not which change introduced it.

// The byte-level git protocol constants live in ONE place: a second copy of
// "\x1f means field separator" is a second place to be wrong about a delimiter
// no author can type but every parser here trusts.
import {
  type CommitPullRef,
  GIT_LOG_FIELD_SEP,
  pickCommitPull,
} from "#pr/reverts-preflight";
import { unquotePath } from "#review/size-gate";
import { CliUsageError } from "../errors";

// ---------------------------------------------------------------------------
// Flag values. Both defaults are spelled as literals inside review/preflight.ts's
// HELP_TEXT too; that file CANNOT import them from here (this module imports
// CliUsageError from it, so the reverse edge would be a runtime cycle). The
// corpus tests pin the two spellings together.

export const DEFAULT_PROXIMITY_DAYS = "7";

// WHY a cap at all: the proximity join walks every commit in the window
// against every unresolved fix, and the window is only ever a heuristic — a
// 365-day "nearby" suspect is numerically indistinguishable from noise while
// doubling the git-log window it forces. 90 days is the outer edge of "the
// code still resembles what the fix touched".
export const MAX_PROXIMITY_DAYS = 90;

// The proximity window in days. Validated HERE, not in parseArgs, so the
// range check is testable offline next to the join that consumes it; the
// flag's string travels verbatim through parseArgs exactly like --since's.
export function validateProximityDays(raw: string | undefined): number {
  const value = raw ?? DEFAULT_PROXIMITY_DAYS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PROXIMITY_DAYS) {
    throw new CliUsageError(
      `--proximity-days must be an integer between 1 and ${MAX_PROXIMITY_DAYS}, ` +
        `got: ${value}`,
    );
  }
  return parsed;
}

export const DEFAULT_BUG_LABELS = "bug";

// Split, trim, drop empties, dedupe preserving first-seen order. Case is
// KEPT, never lowercased: GitHub labels are case-sensitive, and "Bug" and
// "bug" are two distinct labels there — folding them here would silently
// stop matching a repo that only spells it one way.
export function splitBugLabels(csv: string | undefined): string[] {
  const value = csv ?? DEFAULT_BUG_LABELS;
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const part of value.split(",")) {
    const label = part.trim();
    if (label.length === 0) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  // An explicitly-passed csv that names nothing ("--bug-labels ,") would
  // silently disable the bug-issue source entirely — the exact "typo'd key
  // reads as no triggers" failure parseLocalConfig guards against.
  if (labels.length === 0) {
    throw new CliUsageError(
      `--bug-labels must name at least one label, got: ${csv}`,
    );
  }
  return labels;
}

// ---------------------------------------------------------------------------
// The data model.

export type CorpusSource =
  | "fix-subject"
  | "bug-issue"
  | "incident-keyword"
  | "proximity"
  | "review-thread";

// Tier order in the artifact, descending confidence. These sit BELOW the
// revert tiers conceptually (body-linked > pattern-only): git's own
// machine-written linkage outranks anything inferred here. The artifact
// header says so; the revert candidates themselves live in `pr-hero reverts`.
export type CorpusConfidence =
  | "issue-linked"
  | "blame-linked"
  | "keyword-only"
  | "proximity"
  | "review-caught";

export interface IntroducerInfo {
  pr: number | null;
  title: string | null;
  mergedAt: string | null;
  // The commit git blame named. Always set when the introducer exists at all
  // (a PR was resolved OR it was a direct push) — the sha is the one fact
  // both paths share.
  blamedSha: string;
  // Evidence for the human glance: WHERE blame pointed, in the exact
  // `<file> <start>,<end>` form the `git blame -L` argument used.
  blamedFile: string;
  blamedRange: string;
}

// A fix-shaped candidate: any PR the fixes/incidents/proximity sources
// produced. Different detectors may all match one PR; `sources` records
// every one that did.
export interface CorpusCandidate {
  fixPr: number;
  fixTitle: string;
  fixMergedAt: string | null;
  sources: CorpusSource[];
  // The section the entry renders under — resolved by selectCorpus's ladder,
  // not by whichever detector happened to fire first.
  confidence: CorpusConfidence;
  // Excerpt of the matching line (see excerptLine's rules).
  matchedText: string;
  // bug-issue evidence: every issue ref found in the body with the labels
  // that matched the bug-labels set (empty for a ref that matched none).
  issueRefs: { number: number; matchedLabels: string[] }[];
  // Replay range = the DEFECT SITE: the lines the fix changed are where the
  // bug lived, so base..head of the FIX PR is what a reviewer would replay.
  fixBaseSha: string | null;
  fixHeadSha: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  introducer: IntroducerInfo | null;
  alsoBlamedCount: number;
  // Files skipped because the fix renamed them — blame cannot point at a
  // line range that changed path, and hiding the skip would overstate the
  // evidence.
  blameSkippedRenames: number;
  proximitySuspects: {
    pr: number;
    title: string | null;
    mergedAt: string | null;
    sharedFiles: number;
    gapDays: number;
  }[];
}

// A thread-shaped candidate: the review-thread source's own kind. Different
// in kind from a fix candidate — this is a CAUGHT defect, labeled as such.
export interface ThreadCandidate {
  pr: number;
  title: string;
  mergedAt: string | null;
  threads: {
    path: string;
    line: number | null;
    firstCommentAt: string;
    excerpt: string;
    pushSha: string;
  }[];
  // True when reviewThreads(first:50) reported more threads than it
  // returned. The cap is a COST decision (a 500-thread PR is not 500 cases);
  // truncation is recorded rather than silent so the count in the artifact
  // can never be read as exhaustive.
  threadsTruncated: boolean;
  // Enrichment (STEP G): the PR's own range and size, exactly like a fix
  // candidate's — the replay range of the PR review caught the bug in.
  baseSha: string | null;
  headSha: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

// The shared evidence-excerpt rules: strip the ASCII control characters git
// streams carry (\x1f/\x1e would corrupt the markdown), collapse whitespace
// (matched "lines" come from free text that wraps), truncate. Stripping
// BEFORE collapsing matters: a control char between two spaces would
// otherwise leave a double space behind. Spaces are \x20 — not a control
// character — so they survive by construction. The strip is a char-code
// filter rather than a regex because the bytes it removes are the same
// delimiter bytes this repo's git parsers are built to trust.
function stripControlChars(line: string): string {
  let out = "";
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) out += char;
  }
  return out;
}

function excerptLine(line: string, max: number): string {
  return stripControlChars(line).replace(/\s+/g, " ").trim().slice(0, max);
}

// The fix-subject evidence is the TITLE itself — the anchored match IS the
// subject — run through the same excerpt rules as every other evidence line.
export function evidenceExcerpt(title: string): string {
  return excerptLine(title, 160);
}

// ---------------------------------------------------------------------------
// Detector 1: fix-shaped subjects.
//
// ANCHORED at position 0, never a substring search — the single most
// important correctness rule in reverts' classifier, ported with it. A
// substring match on fix|bugfix accepts plausible-looking history that is no
// fix at all; every one of these is real musive history and NONE of them is
// a fix PR:
//   docs(mus-638): handle rollback success status
//   test(MUS-518): re-pin the rollback-scan tripwire after the reformat
//   ci: MUS-598 revert temporary Biome probe
// A corpus polluted with those spends the human glance the whole artifact
// exists to make cheap.

const FIX_SUBJECT = /^(fix|bugfix)(\([^)]*\))?!?:/i;

export function isFixSubject(title: string): boolean {
  return FIX_SUBJECT.test(title);
}

// ---------------------------------------------------------------------------
// Detector 2: closing-keyword issue refs in a PR body.

// `#<n>` preceded (same line, ≤40 chars before) by a closing keyword. The
// 40-char window keeps "fixes #123" and "fixes, a while later, #123" apart
// without a full grammar. Bare `#123` without a keyword never matches: every
// PR body mentions numbers.
const ISSUE_REF =
  /\b(?:closes?|closed|fix|fixes|fixed|resolves?|resolved)\b[^#\n]{0,40}#(\d+)/gi;

export function issueRefsFromBody(body: string): number[] {
  const refs: number[] = [];
  for (const match of body.matchAll(ISSUE_REF)) {
    const whole = match[0];
    const number = Number(match[1]);
    // The text between the keyword and the '#': a '/' there means the ref is
    // cross-repo (`owner/repo#123`) and names an issue of ANOTHER repository
    // — this repo's bug labels say nothing about it.
    const hashAt = whole.indexOf("#");
    if (hashAt > 0 && whole.slice(0, hashAt).includes("/")) continue;
    if (!Number.isInteger(number) || number < 1) continue;
    if (!refs.includes(number)) refs.push(number);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Detector 3: incident keywords.
//
// CRITICAL: bare issue-tracker ids must NEVER be a signal. musive carries
// `MUS-<n>` in EVERY commit subject; a tracker id says an issue exists, not
// that the tracked thing is an incident, and matching it would select the
// entire history. Word boundaries + this exact keyword set are what keep the
// detector from becoming "every PR that references its own tracker".
const INCIDENT_KEYWORDS = ["incident", "outage", "sentry", "crashlytics"];

function incidentLine(line: string): boolean {
  for (const keyword of INCIDENT_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(line)) return true;
  }
  return false;
}

// Returns the matched line as the evidence excerpt (title wins over body —
// the title is the PR's own one-line summary of itself), or null when
// nothing matched.
export function isIncidentText(title: string, body: string): string | null {
  for (const line of [title, ...body.split("\n")]) {
    if (incidentLine(line)) return excerptLine(line, 160);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The fix diff → blame plan.

// ≤40 files blamed per PR. A fix that touches more is a mega-PR whose blame
// would cost 40+ git calls to say "lots of people touched lots of lines" —
// the human glance gets the diff size line and can widen later.
export const MAX_BLAMED_FILES = 40;

// ≤20 merged ranges per file. Same cost logic, one level down: 20 blame
// calls on ONE file is already a file rewritten wholesale.
export const MAX_MERGED_RANGES = 20;

export interface PreImageRange {
  start: number;
  end: number;
}

export interface DiffFilePlan {
  path: string;
  // Pre-image (`-a,b` side) line ranges: the lines the FIX changed are where
  // the bug lived, so they are what blame is pointed at. Sorted, with
  // overlapping or adjacent (±1 line) ranges merged to fewer blame calls.
  // Empty when the file has hunks but no pre-image lines at all — the fix
  // added code where none was, so there is nothing pre-existing to blame.
  ranges: PreImageRange[];
}

export interface DiffBlamePlan {
  files: DiffFilePlan[];
  // Files the diff showed as renames. Blame is skipped for them: the
  // pre-image of a rename section is not a defect site anyone can point at.
  renamedPaths: string[];
  // Cap accounting, recorded rather than silent: counts of files/ranges
  // dropped beyond MAX_BLAMED_FILES / MAX_MERGED_RANGES.
  droppedFiles: number;
  droppedRanges: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiffHunks(diffText: string): DiffBlamePlan {
  interface Section {
    srcPath: string | null;
    dstPath: string | null;
    renamed: boolean;
    hunks: number;
    ranges: PreImageRange[];
  }
  const sections: Section[] = [];
  let section: Section | null = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      section = {
        srcPath: null,
        dstPath: null,
        renamed: false,
        hunks: 0,
        ranges: [],
      };
      sections.push(section);
      continue;
    }
    if (section === null) continue;
    // The PRE-IMAGE path (`--- a/…`) is the path blame needs: blame runs
    // against the parent commit, where the old path is the only path.
    if (line.startsWith("--- a/")) {
      section.srcPath = unquotePath(line.slice(6));
      continue;
    }
    if (line.startsWith("+++ b/")) {
      section.dstPath = unquotePath(line.slice(6));
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      section.renamed = true;
      if (line.startsWith("rename to ")) {
        section.dstPath = unquotePath(line.slice("rename to ".length));
      }
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk === null) continue;
    section.hunks++;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (!Number.isInteger(start) || !Number.isInteger(count)) continue;
    // count 0 = pure insertion at that position: no pre-image lines exist.
    if (count === 0) continue;
    section.ranges.push({ start, end: start + count - 1 });
  }

  const plan: DiffBlamePlan = {
    files: [],
    renamedPaths: [],
    droppedFiles: 0,
    droppedRanges: 0,
  };
  for (const section of sections) {
    if (section.renamed) {
      plan.renamedPaths.push(
        section.dstPath ?? section.srcPath ?? "(path unreadable)",
      );
      continue;
    }
    if (section.hunks === 0) continue; // mode change / binary: nothing to blame
    if (plan.files.length >= MAX_BLAMED_FILES) {
      plan.droppedFiles++;
      continue;
    }
    const merged = mergeRanges(section.ranges);
    if (merged.length > MAX_MERGED_RANGES) {
      plan.droppedRanges += merged.length - MAX_MERGED_RANGES;
      merged.length = MAX_MERGED_RANGES;
    }
    plan.files.push({
      path: section.srcPath ?? section.dstPath ?? "(path unreadable)",
      ranges: merged,
    });
  }
  return plan;
}

// Overlapping ranges merge, and so do ADJACENT ones (end + 1 == next start):
// one blame call over [5,20] beats three over [5,10], [11,15], [16,20], and
// the answer is identical. A gap of 2+ lines stays split — those untouched
// lines are not part of the defect site.
function mergeRanges(ranges: PreImageRange[]): PreImageRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: PreImageRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end + 1) {
      if (range.end > last.end) last.end = range.end;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Blame reading.

// The blame argv, built here so the flags that decide WHICH commit gets named
// are testable rather than buried in a spawn call.
//
// `-w -M -C` are load-bearing, and the measurement that bought them (2026-08-17,
// MusiveTech/musive): on a pure tabs→spaces reformat, blame WITHOUT them named
// `feat(backend): files folder system` — a 644-file, 42k-line reformat that did
// not write a line of the logic; WITH them it named `fix: download song`, the
// commit an independent forensic pass had separately identified as the true
// origin. `-w` ignores whitespace-only changes, `-M` follows lines moved inside
// a file, `-C` follows lines moved or copied in from other files.
//
// It is a PARTIAL fix and the tier is still not trustworthy: on a biome REFLOW
// (a one-line arrow body split across three lines) the same measurement showed
// the flags change nothing, because those really are new lines and blame is
// right to say so. `blame-linked` keeps meaning "the last toucher of these
// lines", which a human still has to check.
export function blameArgv(
  parentSha: string,
  filePath: string,
  range: PreImageRange,
): string[] {
  return [
    "blame",
    "--porcelain",
    "-w",
    "-M",
    "-C",
    "-L",
    `${range.start},${range.end}`,
    parentSha,
    "--",
    filePath,
  ];
}

// `git blame --porcelain`: header lines are exactly
// `<40-hex sha> <orig-line> <final-line>[ <count>]`; content lines open with
// a TAB; everything else (author, boundary, previous, filename…) is metadata
// that never matches the header shape. Distinct shas, first-seen order —
// deterministic for deterministic input.
const BLAME_HEADER = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/;

export function parseBlamePorcelain(raw: string): string[] {
  const shas: string[] = [];
  for (const line of raw.split("\n")) {
    const header = BLAME_HEADER.exec(line);
    const sha = header?.[1];
    if (sha !== undefined && !shas.includes(sha)) shas.push(sha);
  }
  return shas;
}

// `git show -s --format=%H\x1f%ct <shas…>` → sha → committer unix seconds.
// One batch per PR: the dates exist to pick ONE introducer, and a spawn per
// sha would bill the same latency this command is trying not to have.
export function parseCommitDates(raw: string): Map<string, number> {
  const dates = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const fields = line.split(GIT_LOG_FIELD_SEP);
    if (fields.length < 2) {
      throw new CliUsageError(
        `commit date record has ${fields.length} field(s), expected 2 (sha, date)`,
      );
    }
    const sha = (fields[0] ?? "").trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new CliUsageError(
        `commit date record has no full sha, got: ${sha}`,
      );
    }
    const seconds = Number((fields[1] ?? "").trim());
    if (!Number.isInteger(seconds)) {
      throw new CliUsageError(
        `commit date record ${sha} has a non-integer date: ${fields[1]}`,
      );
    }
    dates.set(sha, seconds);
  }
  return dates;
}

// `git rev-list --parents -n 1 <sha>` → the parent SHAs, in the order git
// printed them. First-parent is [0]. A root commit is a legal empty list.
// Used by the shell to tell merge (2 parents) from squash/rebase (1 parent)
// without asking GitHub for a merge_method it does not expose after merge.
export function parseCommitParents(raw: string): string[] {
  const line = raw.trim().split("\n")[0] ?? "";
  const fields = line.split(/\s+/).filter((field) => field.length > 0);
  if (fields.length === 0) {
    throw new CliUsageError("commit parents record is empty");
  }
  const sha = fields[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new CliUsageError(
      `commit parents record has no full sha, got: ${sha}`,
    );
  }
  const parents = fields.slice(1);
  for (const parent of parents) {
    if (!/^[0-9a-f]{40}$/.test(parent)) {
      throw new CliUsageError(
        `commit parents record has a non-sha parent: ${parent}`,
      );
    }
  }
  return parents;
}

export interface BlamedSha {
  sha: string;
  committedAtSec: number;
  file: string;
  range: string;
}

export interface IntroducerPick {
  sha: string;
  file: string;
  range: string;
  alsoBlamedCount: number;
}

// The NEWEST commit blame named wins, ties broken by sha ascending so two
// runs over unchanged history cannot disagree. WHY newest rather than oldest:
// blame names every commit that ever touched the range, and the most recent
// toucher is the best single guess at "the code as the fix found it" — an
// older touch may have been perfectly fine and fixed forward since. The rest
// are counted, not hidden.
export function pickIntroducer(blamed: BlamedSha[]): IntroducerPick | null {
  if (blamed.length === 0) return null;
  // The same sha in several ranges is ONE candidate (one commit edited the
  // same broken function twice); its evidence is the first range seen.
  const bySha = new Map<string, BlamedSha>();
  for (const entry of blamed) {
    if (!bySha.has(entry.sha)) bySha.set(entry.sha, entry);
  }
  let winner: BlamedSha | null = null;
  for (const entry of bySha.values()) {
    if (winner === null) {
      winner = entry;
      continue;
    }
    if (entry.committedAtSec > winner.committedAtSec) {
      winner = entry;
    } else if (
      entry.committedAtSec === winner.committedAtSec &&
      entry.sha.localeCompare(winner.sha) < 0
    ) {
      winner = entry;
    }
  }
  if (winner === null) return null;
  return {
    sha: winner.sha,
    file: winner.file,
    range: winner.range,
    alsoBlamedCount: bySha.size - 1,
  };
}

// ---------------------------------------------------------------------------
// Proximity.

// WHY lockfiles are excluded from the overlap: a shared lockfile says nothing
// about causation and matches nearly every busy-week PR pair — without this,
// "touched the same files" degenerates into "was open that week".
export const LOCKFILE_PATHS =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum)$|\.(?:lock|lockb)$/;

export function isLockfilePath(path: string): boolean {
  return LOCKFILE_PATHS.test(path);
}

export interface CommitIndexEntry {
  sha: string;
  committedAtSec: number;
  files: string[];
}

export interface CommitPrRef {
  pr: number;
  title: string | null;
  mergedAt: string | null;
}

export interface ProximityFix {
  fixPr: number;
  fixMergedAt: string | null;
  // The files blame was pointed at for this fix (the defect site) — the
  // overlap is computed over exactly those.
  files: string[];
}

export interface ProximitySuspect {
  pr: number;
  title: string | null;
  mergedAt: string | null;
  sharedFiles: number;
  gapDays: number;
}

// At most three suspects: the list exists to hand a human a NEXT place to
// look, and three already-tested places beat an unranked page of them.
export const MAX_PROXIMITY_SUSPECTS = 3;

const DAY_MS = 86_400_000;

// The pure join. `fixes` are the unresolved entries only — that gate is the
// caller's rule (an entry whose introducer resolved has no need of a
// heuristic), which is why it is not re-tested here. Every duration is the
// difference of two recorded stamps: fixMergedAt (GitHub) minus the commit's
// committer seconds (git).
export function joinProximity(
  fixes: ProximityFix[],
  commitIndex: CommitIndexEntry[],
  proximityDays: number,
  prBySha: Map<string, CommitPrRef>,
): Map<number, ProximitySuspect[]> {
  const out = new Map<number, ProximitySuspect[]>();
  const windowMs = proximityDays * DAY_MS;
  for (const fix of fixes) {
    out.set(fix.fixPr, []);
    if (fix.fixMergedAt === null) continue;
    const fixMs = Date.parse(fix.fixMergedAt);
    if (Number.isNaN(fixMs)) continue;
    // Lockfiles drop out of the DEFECT-SIDE set too, so a fix that only
    // touched a lockfile matches nobody — deliberately: it is not a defect
    // site anyone can replay.
    const fixFiles = new Set(fix.files.filter((p) => !isLockfilePath(p)));
    if (fixFiles.size === 0) continue;
    // Group by PR first: one PR with three commits in the window is ONE
    // suspect (the same triple-weighting lesson as reverts' pair dedupe) —
    // union the shared files, keep the SMALLEST gap (its most recent commit).
    const perPr = new Map<
      number,
      { ref: CommitPrRef; shared: Set<string>; gapDays: number }
    >();
    for (const commit of commitIndex) {
      const ref = prBySha.get(commit.sha);
      if (ref === undefined) continue; // direct push, or a PR outside the walk
      if (ref.pr === fix.fixPr) continue; // a PR is never prior to itself
      const gapMs = fixMs - commit.committedAtSec * 1000;
      // 0 < gap ≤ N: strictly before the fix (a commit AT the fix's merge
      // instant is the fix itself), and inside the window — exactly N days
      // is in, N days plus a second is out.
      if (!(gapMs > 0 && gapMs <= windowMs)) continue;
      const shared = commit.files.filter(
        (p) => !isLockfilePath(p) && fixFiles.has(p),
      );
      if (shared.length === 0) continue;
      const gapDays = Math.round((gapMs / DAY_MS) * 10) / 10;
      const existing = perPr.get(ref.pr);
      if (existing === undefined) {
        perPr.set(ref.pr, {
          ref,
          shared: new Set(shared),
          gapDays,
        });
        continue;
      }
      for (const p of shared) existing.shared.add(p);
      if (gapDays < existing.gapDays) existing.gapDays = gapDays;
    }
    const suspects = [...perPr.values()].map((entry) => ({
      pr: entry.ref.pr,
      title: entry.ref.title,
      mergedAt: entry.ref.mergedAt,
      sharedFiles: entry.shared.size,
      gapDays: entry.gapDays,
    }));
    suspects.sort((a, b) => {
      if (a.sharedFiles !== b.sharedFiles) return b.sharedFiles - a.sharedFiles;
      const am = a.mergedAt === null ? Number.NaN : Date.parse(a.mergedAt);
      const bm = b.mergedAt === null ? Number.NaN : Date.parse(b.mergedAt);
      if (!Number.isNaN(am) && !Number.isNaN(bm) && am !== bm) return bm - am;
      if (Number.isNaN(am) !== Number.isNaN(bm)) {
        return Number.isNaN(am) ? 1 : -1;
      }
      return a.pr - b.pr;
    });
    out.set(fix.fixPr, suspects.slice(0, MAX_PROXIMITY_SUSPECTS));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Review threads.

// 50 threads per PR / 50 PRs per graphql batch. Both are COST caps: the
// thread list beyond the first page and the PRs beyond a batch are capped
// work a $0 read-only scan cannot grow into. Truncation is recorded
// (threadsTruncated), never silent.
export const THREAD_PAGE_SIZE = 50;
export const THREAD_BATCH_SIZE = 50;

// The batch document. PR numbers are integers interpolated into the query
// text — the ONLY safe interpolation, because they arrived as validated
// integers from our own walk parser: no quoting context exists for them to
// break. Everything else travels as graphql variables.
export function buildThreadBatchQuery(numbers: number[]): string {
  const aliases = numbers
    .map(
      (n, i) =>
        `p${i}: pullRequest(number:${n}){reviewThreads(first:${THREAD_PAGE_SIZE})` +
        "{pageInfo{hasNextPage}nodes{isResolved comments(first:1){nodes{" +
        "path line originalLine createdAt body author{__typename}}}}}}",
    )
    .join(" ");
  return (
    "query($repoOwner:String!,$repoName:String!){repository(owner:$repoOwner," +
    `name:$repoName){${aliases}}}`
  );
}

export interface RawReviewThread {
  isResolved: boolean;
  path: string | null;
  line: number | null;
  firstCommentAt: string | null;
  excerpt: string | null;
  // GraphQL `__typename` of the first comment's author. Measured on musive
  // 2026-08-16: 96 of 109 caught entries were Greptile-bot threads and only
  // 13 had any human thread — #43's source is "HUMAN review comments", so
  // bot-authored threads are excluded by resolvedThreadsWithPath (`Bot`),
  // not by the query.
  authorType: string | null;
}

export interface ThreadBatchEntry {
  threads: RawReviewThread[];
  truncated: boolean;
}

// The batch response, parsed against the numbers that were asked for (alias
// pN ↔ numbers[N]). Malformed input fails loud naming the query — a silently
// dropped PR's threads would read as "caught nothing", the plausible wrong
// answer. A null alias (PR invisible to this token) is an empty entry, not
// an error: that PR is simply not a candidate.
export function parseThreadBatch(
  raw: string,
  numbers: number[],
): { entries: ThreadBatchEntry[]; nullAliases: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError(
      "gh api graphql (reviewThreads batch) returned invalid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(
      "gh api graphql (reviewThreads batch) response is not an object",
    );
  }
  const data = (parsed as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CliUsageError(
      "gh api graphql (reviewThreads batch) returned no data",
    );
  }
  // The aliases live under data.repository — the same envelope the merged-PR
  // walk reads — NOT directly under data. Verified against the live response:
  // {"data":{"repository":{"p0":{…}}}}. Reading data.p0 found undefined and
  // failed every batch with "alias p0 is not an object" on the first real run.
  const repository = (data as Record<string, unknown>).repository;
  if (
    typeof repository !== "object" ||
    repository === null ||
    Array.isArray(repository)
  ) {
    throw new CliUsageError(
      "gh api graphql (reviewThreads batch) returned no repository",
    );
  }
  const out: ThreadBatchEntry[] = [];
  let nullAliases = 0;
  for (const [i, number] of numbers.entries()) {
    const node = (repository as Record<string, unknown>)[`p${i}`];
    if (node === null) {
      // A null alias can mean a PR invisible to this token OR a partially
      // executed batch under load; either way the PR contributes no threads
      // here and the caller counts it so a systemic outbreak is visible.
      nullAliases++;
      out.push({ threads: [], truncated: false });
      continue;
    }
    if (typeof node !== "object" || Array.isArray(node)) {
      throw new CliUsageError(
        `gh api graphql (reviewThreads batch) alias p${i} (PR #${number}) is not an object`,
      );
    }
    const connection = (node as Record<string, unknown>).reviewThreads;
    if (
      typeof connection !== "object" ||
      connection === null ||
      !Array.isArray((connection as Record<string, unknown>).nodes)
    ) {
      throw new CliUsageError(
        `gh api graphql (reviewThreads batch) returned no thread list for PR #${number}`,
      );
    }
    const pageInfo = (connection as Record<string, unknown>).pageInfo;
    const truncated =
      typeof pageInfo === "object" &&
      pageInfo !== null &&
      (pageInfo as Record<string, unknown>).hasNextPage === true;
    const threads: RawReviewThread[] = [];
    for (const entry of (connection as Record<string, unknown>)
      .nodes as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const comments = record.comments;
      const first =
        typeof comments === "object" && comments !== null
          ? (
              (comments as Record<string, unknown>).nodes as
                | unknown[]
                | undefined
            )?.[0]
          : undefined;
      const comment =
        typeof first === "object" && first !== null
          ? (first as Record<string, unknown>)
          : {};
      const line = comment.line;
      const originalLine = comment.originalLine;
      const author =
        typeof comment.author === "object" && comment.author !== null
          ? (comment.author as Record<string, unknown>)
          : {};
      threads.push({
        isResolved: record.isResolved === true,
        path: typeof comment.path === "string" ? comment.path : null,
        line:
          typeof line === "number" && Number.isInteger(line)
            ? line
            : typeof originalLine === "number" && Number.isInteger(originalLine)
              ? originalLine
              : null,
        firstCommentAt:
          typeof comment.createdAt === "string" ? comment.createdAt : null,
        excerpt:
          typeof comment.body === "string"
            ? excerptLine(comment.body, 200)
            : null,
        authorType:
          typeof author.__typename === "string" ? author.__typename : null,
      });
    }
    out.push({ threads, truncated });
  }
  return { entries: out, nullAliases };
}

// Survivors = PRs with ≥1 RESOLVED, PATH-CARRYING, HUMAN-authored thread.
// Unresolved threads are review in progress (or declined); a thread without a
// path is an overall-pr comment, which qualifies nothing; and a bot-authored
// thread is a machine catch, not the "real review findings" source #43 names
// — on musive that filter is the difference between 109 caught PRs and 13.
export function resolvedThreadsWithPath(
  threads: RawReviewThread[],
): RawReviewThread[] {
  return threads.filter(
    (thread) =>
      thread.isResolved && thread.path !== null && thread.authorType !== "Bot",
  );
}

export interface ThreadRecord {
  path: string;
  line: number | null;
  firstCommentAt: string;
  excerpt: string;
}

export interface QualifiedThread extends ThreadRecord {
  // The commit that plausibly addressed the thread — see the approximation
  // note in the artifact: GitHub's ReviewThread exposes no resolvedAt, so
  // "resolved after a push" is approximated by "a commit landed after the
  // thread's first comment and the thread's path is in the PR's diff; which
  // push touched which line is not distinguishable from these endpoints".
  pushSha: string;
}

// The join over already-fetched data (commits and files from the REST
// endpoints). A thread qualifies iff (a) SOME commit is strictly later than
// its first comment — pushSha records the LATEST such commit, ties broken by
// sha ascending for determinism — AND (b) the thread's path is among the
// PR's file paths, compared exactly (both sides come from GitHub, so the
// encodings already agree).
export function qualifyThreads(
  threads: ThreadRecord[],
  commits: PullCommitRef[],
  filePaths: string[],
): QualifiedThread[] {
  const paths = new Set(filePaths);
  const ordered = [...commits]
    .filter(
      (commit) =>
        commit.committedAt !== null &&
        !Number.isNaN(Date.parse(commit.committedAt)),
    )
    .sort((a, b) => {
      const am = Date.parse(a.committedAt ?? "");
      const bm = Date.parse(b.committedAt ?? "");
      return bm === am ? a.sha.localeCompare(b.sha) : bm - am;
    });
  const out: QualifiedThread[] = [];
  for (const thread of threads) {
    const commentMs = Date.parse(thread.firstCommentAt);
    if (Number.isNaN(commentMs)) continue;
    const push = ordered.find(
      (commit) => Date.parse(commit.committedAt ?? "") > commentMs,
    );
    if (push === undefined) continue;
    if (!paths.has(thread.path)) continue;
    out.push({ ...thread, pushSha: push.sha });
  }
  return out;
}

// ---------------------------------------------------------------------------
// gh/git payload readers for the walk and its satellites.

// `git rev-list --max-count=1 --format=%ct --before=<since> <ref>` → the
// concrete cutoff instant, as unix seconds. Empty output is NOT an error: it
// means the repo's whole history is inside the window (nothing is older than
// --since), so the walk has no cutoff and reads everything.
export function parseCutoffTimestamp(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (/^\d+$/.test(candidate)) {
      const seconds = Number(candidate);
      if (Number.isInteger(seconds) && seconds > 0) return seconds;
    }
  }
  throw new CliUsageError(
    "rev-list cutoff output has no committer timestamp line",
  );
}

export interface MergedPrNode {
  number: number;
  title: string;
  body: string | null;
  mergedAt: string | null;
  // The walk's SORT KEY. GitHub's pullRequests connection cannot order by
  // mergedAt (IssueOrderField has no MERGED_AT — verified live, the walk
  // failed closed on the first real run), so the walk orders by updatedAt and
  // this field carries that order.
  updatedAt: string | null;
  mergeCommitSha: string | null;
  baseRefName: string;
}

export interface MergedPrPage {
  endCursor: string | null;
  hasNextPage: boolean;
  nodes: MergedPrNode[];
}

// One page of the merged-PR walk. Fails loud naming the query (the parseReviewThreads
// discipline): a half-parsed page would silently shorten the scan and report
// "no candidates" with a completely plausible face.
export function parseMergedPrPage(raw: string): MergedPrPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError(
      "gh api graphql (merged PR walk) returned invalid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(
      "gh api graphql (merged PR walk) response is not an object",
    );
  }
  const repository = (parsed as Record<string, unknown>).data;
  const connection =
    typeof repository === "object" && repository !== null
      ? ((repository as Record<string, unknown>).repository as unknown)
      : undefined;
  const pullRequests =
    typeof connection === "object" && connection !== null
      ? ((connection as Record<string, unknown>).pullRequests as unknown)
      : undefined;
  if (
    typeof pullRequests !== "object" ||
    pullRequests === null ||
    !Array.isArray((pullRequests as Record<string, unknown>).nodes)
  ) {
    throw new CliUsageError(
      "gh api graphql (merged PR walk) returned no pullRequests connection",
    );
  }
  const pageInfo = (pullRequests as Record<string, unknown>).pageInfo;
  // `typeof null === "object"`, so a null pageInfo used to pass the object
  // check and then throw a raw TypeError on `.endCursor` — the shell only
  // remaps CliUsageError, so that reached the operator mid-walk with no
  // page named. Same shape as parseThreadBatch's pageInfo guard.
  if (typeof pageInfo !== "object" || pageInfo === null) {
    throw new CliUsageError(
      "gh api graphql (merged PR walk) returned no pullRequests connection",
    );
  }
  const record = pullRequests as {
    nodes: unknown[];
    pageInfo: Record<string, unknown>;
  };
  const hasNextPage = record.pageInfo.hasNextPage === true;
  const endCursor =
    typeof record.pageInfo.endCursor === "string"
      ? record.pageInfo.endCursor
      : null;
  // A continuing page without a cursor would loop forever on the same
  // request. Fail loud rather than hang.
  if (hasNextPage && endCursor === null) {
    throw new CliUsageError(
      "gh api graphql (merged PR walk) hasNextPage is true but endCursor is missing",
    );
  }
  const nodes: MergedPrNode[] = [];
  for (const [i, entry] of record.nodes.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new CliUsageError(
        `gh api graphql (merged PR walk) node ${i} is not an object`,
      );
    }
    const node = entry as Record<string, unknown>;
    const number = node.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
      throw new CliUsageError(
        `gh api graphql (merged PR walk) node ${i} has no number`,
      );
    }
    if (typeof node.title !== "string") {
      throw new CliUsageError(
        `gh api graphql (merged PR walk) PR #${number} has no title`,
      );
    }
    if (typeof node.baseRefName !== "string") {
      throw new CliUsageError(
        `gh api graphql (merged PR walk) PR #${number} has no baseRefName`,
      );
    }
    const mergeCommit = node.mergeCommit;
    const oid =
      typeof mergeCommit === "object" && mergeCommit !== null
        ? (mergeCommit as Record<string, unknown>).oid
        : undefined;
    nodes.push({
      number,
      title: node.title,
      body: typeof node.body === "string" ? node.body : null,
      mergedAt: typeof node.mergedAt === "string" ? node.mergedAt : null,
      updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : null,
      mergeCommitSha: typeof oid === "string" ? oid : null,
      baseRefName: node.baseRefName,
    });
  }
  return {
    endCursor,
    hasNextPage,
    nodes,
  };
}

// The per-page keep filter plus the STOP rule. Kept = merged at/after the
// cutoff AND based on the default branch. The stop signal keys on the walk's
// ORDER (updatedAt, falling back to mergedAt when the API omitted it): a page
// with nothing at/after the cutoff on that order guarantees every later page
// is older still. WHY ordering by updatedAt loses nothing: GitHub sets
// updatedAt >= mergedAt on every PR, so any PR merged at/after the cutoff
// also sorts at/after it and cannot hide below the stop point. The cost is
// pages of old-but-recently-commented merged PRs, which the mergedAt filter
// discards. Base-branch filtering must NOT trigger the stop — a quiet week on
// the default branch is not the end of history, it is just a page of
// feature-branch PRs.
export function walkPageKept(input: {
  nodes: MergedPrNode[];
  cutoffMs: number | null;
  defaultBranch: string;
}): { kept: MergedPrNode[]; olderExhausted: boolean } {
  const keptByDate: MergedPrNode[] = [];
  let inDateOnOrder = false;
  for (const node of input.nodes) {
    if (node.mergedAt === null) continue; // MERGED without a date: not datable
    const ms = Date.parse(node.mergedAt);
    if (Number.isNaN(ms)) continue;
    if (input.cutoffMs !== null && ms < input.cutoffMs) continue;
    keptByDate.push(node);
  }
  for (const node of input.nodes) {
    const orderStamp = node.updatedAt ?? node.mergedAt;
    if (orderStamp === null) continue;
    const ms = Date.parse(orderStamp);
    if (Number.isNaN(ms)) continue;
    if (input.cutoffMs === null || ms >= input.cutoffMs) {
      inDateOnOrder = true;
      break;
    }
  }
  return {
    kept: keptByDate.filter((node) => node.baseRefName === input.defaultBranch),
    olderExhausted: input.cutoffMs !== null && !inDateOnOrder,
  };
}

// `git log -m --first-parent --format=%H\x1f%ct --no-renames --numstat` → the
// commit/file index the proximity join runs over. Format records carry the
// \x1f and are followed by a blank line before the numstat block; numstat
// lines are `<added>\t<deleted>\t<path>` where a binary file's counters are
// `-` but the PATH still counts (a binary change is still a change to that
// file). A merge commit's first-parent numstat is the ONLY numstat the join
// can use: it resolves commits to PRs through `mergeCommitSha`, so the
// commits a merge absorbed are never in that map and their files would never
// arrive. A record with no numstat lines at all is still legal (an empty
// commit, or a merge whose first-parent diff is empty) and carries no files.
export function parseCommitIndex(raw: string): CommitIndexEntry[] {
  const out: CommitIndexEntry[] = [];
  let current: CommitIndexEntry | null = null;
  for (const line of raw.split("\n")) {
    if (line.includes(GIT_LOG_FIELD_SEP)) {
      const fields = line.split(GIT_LOG_FIELD_SEP);
      if (fields.length < 2) {
        throw new CliUsageError(
          `commit index record has ${fields.length} field(s), expected 2 (sha, date)`,
        );
      }
      const sha = (fields[0] ?? "").trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new CliUsageError(
          `commit index record has no full sha, got: ${sha}`,
        );
      }
      const committedAtSec = Number((fields[1] ?? "").trim());
      if (!Number.isInteger(committedAtSec)) {
        throw new CliUsageError(
          `commit index record ${sha} has a non-integer date: ${fields[1]}`,
        );
      }
      current = { sha, committedAtSec, files: [] };
      out.push(current);
      continue;
    }
    if (current === null) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    // Tabs inside a path only appear in git's quoted form, which escapes
    // them; rejoining keeps such a path whole instead of truncating it.
    current.files.push(unquotePath(fields.slice(2).join("\t")));
  }
  return out;
}

export interface IssueLabels {
  names: string[];
  // GitHub's issues API returns PRs too; recorded so the caller can tell a
  // referenced PR from an actual issue.
  isPull: boolean;
}

// `gh api repos/<slug>/issues/<n>` → the labels + is-it-a-PR. Labels come
// back verbatim: matching against the bug-labels set happens case-sensitively
// at the caller, because GitHub labels are case-sensitive.
export function parseIssueLabels(raw: string): IssueLabels {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError("issue response is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError("issue response is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const labels = record.labels;
  if (labels !== undefined && !Array.isArray(labels)) {
    throw new CliUsageError("issue response labels is not an array");
  }
  const names: string[] = [];
  for (const entry of (labels ?? []) as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return {
    names,
    isPull:
      typeof record.pull_request === "object" && record.pull_request !== null,
  };
}

export interface BugLabelMatch {
  // Per referenced number, the bug labels it carries. EVERY ref gets an
  // entry — a ref that confers nothing is still rendered as evidence the
  // scan looked at, so it must survive with an empty list, never be dropped.
  byRef: Map<number, string[]>;
  anyMatch: boolean;
}

// Which `fixes #N` refs actually confer the `bug-issue` source.
//
// The `isPull` skip is the whole point. GitHub's issues API answers for pull
// requests too, so `fixes #1234` pointing at a PR resolves happily and its
// labels look exactly like an issue's. Counting them promoted such a
// candidate to `issue-linked`, this artifact's HIGHEST tier, on the strength
// of a label somebody put on a pull request — the confusion `parseIssueLabels`
// records `isPull` to prevent, which no caller was reading.
//
// Labels match case-sensitively (`bug` is not `Bug`): GitHub label names are
// case-sensitive, so lowercasing would silently widen a set the user spelled
// out. Unresolved (404 → null) and never-fetched (undefined) refs both
// degrade to no labels rather than throwing; a fact missing about one issue
// is not a broken scan.
export function matchBugLabels(
  refs: number[],
  labelsByRef: Map<number, IssueLabels | null>,
  bugLabels: Set<string>,
): BugLabelMatch {
  const byRef = new Map<number, string[]>();
  let anyMatch = false;
  for (const number of refs) {
    const labels = labelsByRef.get(number);
    const matched =
      labels === null || labels === undefined || labels.isPull
        ? []
        : labels.names.filter((label) => bugLabels.has(label));
    byRef.set(number, matched);
    if (matched.length > 0) anyMatch = true;
  }
  return { byRef, anyMatch };
}

export interface PullCommitRef {
  sha: string;
  committedAt: string | null;
}

// `gh api repos/<slug>/pulls/<n>/commits`. The committer date (not author
// date) is taken: it is the instant the commit landed in the PR's history,
// which is what "a commit arrived after the comment" is about — an author
// date can predate the PR by years.
export function parsePullCommits(raw: string): PullCommitRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError("pull commits response is not JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new CliUsageError("pull commits response is not an array");
  }
  const out: PullCommitRef[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.sha !== "string" || record.sha.length === 0) continue;
    const commit = record.commit;
    const committer =
      typeof commit === "object" && commit !== null
        ? (commit as Record<string, unknown>).committer
        : undefined;
    const date =
      typeof committer === "object" && committer !== null
        ? (committer as Record<string, unknown>).date
        : undefined;
    out.push({
      sha: record.sha,
      committedAt: typeof date === "string" ? date : null,
    });
  }
  return out;
}

// `gh api repos/<slug>/pulls/<n>/files` → the paths, for the thread
// qualification's path-membership half.
export function parsePullFiles(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError("pull files response is not JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new CliUsageError("pull files response is not an array");
  }
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const filename = (entry as Record<string, unknown>).filename;
    if (typeof filename === "string" && filename.length > 0) out.push(filename);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selection.

// What the shell knows about one classified PR before tier resolution.
// `matchedSources` carries only the DETECTOR matches (fix-subject,
// incident-keyword, bug-issue); the proximity source and the confidence tier
// are resolved here, once, over the whole set.
export interface CorpusWorking {
  fixPr: number;
  fixTitle: string;
  fixMergedAt: string | null;
  matchedSources: CorpusSource[];
  matchedText: string;
  issueRefs: { number: number; matchedLabels: string[] }[];
  fixBaseSha: string | null;
  fixHeadSha: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  introducer: IntroducerInfo | null;
  alsoBlamedCount: number;
  blameSkippedRenames: number;
  proximitySuspects: ProximitySuspect[];
}

// Canonical source order for `sources` lines — stable regardless of the
// order detectors happened to fire in.
const SOURCE_ORDER: CorpusSource[] = [
  "fix-subject",
  "incident-keyword",
  "bug-issue",
  "proximity",
];

function stampMs(stamp: string | null): number {
  if (stamp === null) return Number.NaN;
  return Date.parse(stamp);
}

// A PR cannot introduce what it itself fixed — circular blame evidence.
// Shared by the shell (drop before proximity runs) and selectCorpus
// (defense in depth). Direct pushes (`null`) are not self.
export function isSelfIntroducer(
  fixPr: number,
  introducerPr: number | null,
): boolean {
  return introducerPr === fixPr;
}

// Rebase-and-merge detection: merge_commit_sha is the last rebased commit,
// so its sole parent still belongs to THIS PR. Squash's parent is the
// previous default-branch tip (another PR, or none). pickCommitPull is
// GitHub's primary association — the same rule blameResolve uses for the
// introducer itself.
export function parentBelongsToFix(
  fixPr: number,
  pulls: CommitPullRef[],
): boolean {
  const primary = pickCommitPull(pulls);
  return primary !== null && primary.number === fixPr;
}

// Tier resolution + dedupe + the artifact's deterministic order.
export function selectCorpus(entries: CorpusWorking[]): CorpusCandidate[] {
  // One entry per fix PR, sources merged: the shell keys its map by PR, but
  // the merge rule lives HERE so a duplicate can never survive to the
  // artifact even if a future caller builds the list differently.
  const byPr = new Map<number, CorpusWorking>();
  for (const entry of entries) {
    const existing = byPr.get(entry.fixPr);
    if (existing === undefined) {
      byPr.set(entry.fixPr, { ...entry });
      continue;
    }
    const sources = new Set([
      ...existing.matchedSources,
      ...entry.matchedSources,
    ]);
    existing.matchedSources = SOURCE_ORDER.filter((source) =>
      sources.has(source),
    );
    const refs = new Map(existing.issueRefs.map((ref) => [ref.number, ref]));
    for (const ref of entry.issueRefs) {
      const seen = refs.get(ref.number);
      if (seen === undefined) {
        refs.set(ref.number, ref);
        continue;
      }
      seen.matchedLabels = [
        ...new Set([...seen.matchedLabels, ...ref.matchedLabels]),
      ];
    }
    existing.issueRefs = [...refs.values()];
    if (existing.matchedText.length === 0) {
      existing.matchedText = entry.matchedText;
    }
  }

  const candidates: CorpusCandidate[] = [];
  for (const entry of byPr.values()) {
    // Defensive filter (dropSamePrReverts' lesson): a PR cannot introduce
    // what it itself fixed — when blame resolves the introducer to the fix
    // PR itself, the evidence is circular and the introducer is nulled.
    const introducer =
      entry.introducer !== null &&
      isSelfIntroducer(entry.fixPr, entry.introducer.pr)
        ? null
        : entry.introducer;
    const sources = SOURCE_ORDER.filter((source) =>
      entry.matchedSources.includes(source),
    );
    let confidence: CorpusConfidence;
    if (sources.includes("bug-issue")) {
      confidence = "issue-linked";
    } else if (introducer !== null && introducer.pr !== null) {
      confidence = "blame-linked";
    } else if (entry.proximitySuspects.length > 0) {
      confidence = "proximity";
      if (!sources.includes("proximity")) sources.push("proximity");
    } else {
      confidence = "keyword-only";
    }
    candidates.push({
      fixPr: entry.fixPr,
      fixTitle: entry.fixTitle,
      fixMergedAt: entry.fixMergedAt,
      sources,
      confidence,
      matchedText: entry.matchedText,
      issueRefs: entry.issueRefs,
      fixBaseSha: entry.fixBaseSha,
      fixHeadSha: entry.fixHeadSha,
      additions: entry.additions,
      deletions: entry.deletions,
      changedFiles: entry.changedFiles,
      introducer,
      alsoBlamedCount: entry.alsoBlamedCount,
      blameSkippedRenames: entry.blameSkippedRenames,
      proximitySuspects: entry.proximitySuspects,
    });
  }

  // Deterministic order: newest fix first; ties by PR ascending; undatable
  // entries last rather than interleaved by sort accident.
  return candidates.sort((a, b) => {
    const am = stampMs(a.fixMergedAt);
    const bm = stampMs(b.fixMergedAt);
    if (!Number.isNaN(am) && !Number.isNaN(bm) && am !== bm) return bm - am;
    if (Number.isNaN(am) !== Number.isNaN(bm)) {
      return Number.isNaN(am) ? 1 : -1;
    }
    return a.fixPr - b.fixPr;
  });
}

// ---------------------------------------------------------------------------
// The artifact.

// The lookups that did not answer during the scan, separated by CAUSE because
// they mean different things: "GitHub said no" is not "this clone is stale" is
// not "git could not blame that range". Each one silently costs a candidate its
// evidence — a commit→PR lookup that 404s leaves `introducer.pr = null`, which
// the tier ladder reads as a direct push and demotes accordingly. Measured
// 2026-08-17: a degraded run reported 12 blame-linked where a clean re-run
// reported 428, and the two artifacts were byte-indistinguishable.
export interface CorpusLookupFailures {
  // `repos/<slug>/commits/<sha>/pulls` answered 404. Distinct from the same
  // call answering 200 with an empty list, which really does mean direct push.
  commitPrLookup404: number;
  // The merge commit GitHub named is not in this clone (stale clone or
  // rewritten history) — the whole PR gets no blame evidence.
  mergeCommitAbsent: number;
  // `git blame` failed on one range; that range contributes nothing.
  blameRangeSkipped: number;
}

export interface CorpusArtifact {
  repoSlug: string;
  ref: string;
  since: string;
  scannedPrs: number;
  // Which source flags the run actually had. A count of 0 for a source that
  // never ran reads exactly like "ran and found nothing", and that ambiguity
  // is a lie of omission the artifact must not carry.
  sourcesRun: string[];
  // Rendered ALWAYS, zeros included, for the reason written on sourcesRun just
  // above: an omitted count and a count of zero are the same bytes to a reader,
  // and here that ambiguity is precisely the defect being fixed.
  lookupFailures: CorpusLookupFailures;
  candidates: CorpusCandidate[];
  threadCandidates: ThreadCandidate[];
}

const DEGRADED_WARNING = [
  "> **This run was DEGRADED — the counts above are not the counts a clean",
  "> run would produce.** Some lookups never answered, so evidence this scan",
  "> should have had is simply missing, and candidates may sit in a WEAKER",
  "> tier than they deserve: an introducer that failed to resolve is recorded",
  "> exactly like one that resolved to a direct push. Re-run before reading",
  "> the tier counts, or any absent introducer, as a fact about the code.",
];

const CANDIDATE_WARNING = [
  "> **These are CANDIDATES REQUIRING HUMAN CONFIRMATION, not confirmed",
  "> defects.** A bug-fix PR proves something was wrong, not that a review",
  "> should have caught it; blame names the LAST toucher of the fixed lines,",
  "> not necessarily the introducer; proximity is not causation; and the",
  "> review-caught entries are the OTHER side of the corpus — defects review",
  "> DID catch. Every entry below needs a human glance before it is treated",
  "> as a known-bad case.",
];

// Descending confidence, and it MUST equal the order `selectCorpus`'s ladder
// resolves in — the two disagreed: the ladder tries proximity before falling
// through to keyword-only (a candidate with suspects has strictly more
// evidence than one where nothing resolved), while this list rendered
// keyword-only above proximity under a header promising descending
// confidence. The renderer was the one lying. Exported so a test can pin the
// two together instead of trusting them to drift in step.
export const TIER_ORDER: CorpusConfidence[] = [
  "issue-linked",
  "blame-linked",
  "proximity",
  "keyword-only",
  "review-caught",
];

const TIER_NOTE: Record<CorpusConfidence, string> = {
  "issue-linked":
    "The fix PR references an issue carrying one of the bug labels — the " +
    "strongest signal this artifact has.",
  "blame-linked":
    "git blame on the fixed lines resolved to a PR. Blame names the LAST " +
    "toucher, which is not always the introducer — check the blamed range.",
  "keyword-only":
    "Matched by an anchored fix subject or an incident keyword alone; " +
    "nothing else resolved. Lowest confidence: verify before replaying.",
  proximity:
    "No introducer resolved; prior PRs touched the same files inside the " +
    "window. Correlation, not causation — the shared files are the only " +
    "evidence.",
  "review-caught":
    "A resolved review thread that a later push plausibly addressed — the " +
    "OTHER side of the corpus: defects review DID catch. GitHub exposes no " +
    "resolvedAt, so 'a commit landed after the first comment and the " +
    "thread's path is in the diff' is the approximation; which push touched " +
    "which line is not distinguishable from these endpoints.",
};

export function renderCorpusArtifact(artifact: CorpusArtifact): string {
  const out: string[] = [];
  out.push("# crysk — known-bad corpus candidates (beyond reverts)");
  out.push("");
  out.push(`- repository: \`${artifact.repoSlug}\``);
  out.push(`- ref: \`${artifact.ref}\``);
  out.push(`- window: \`--since ${artifact.since}\``);
  out.push(`- scanned: ${artifact.scannedPrs} merged PR(s)`);
  out.push(`- sources run: ${artifact.sourcesRun.join(", ") || "(none)"}`);
  const failures = artifact.lookupFailures;
  out.push(`- failed lookups — commit→PR (404): ${failures.commitPrLookup404}`);
  out.push(
    "- failed lookups — merge commit absent from this clone (stale clone " +
      `or rewritten history): ${failures.mergeCommitAbsent}`,
  );
  out.push(
    `- failed lookups — blame range skipped: ${failures.blameRangeSkipped}`,
  );
  for (const source of SOURCE_ORDER) {
    const count = artifact.candidates.filter((candidate) =>
      candidate.sources.includes(source),
    ).length;
    out.push(`- source ${source}: ${count} candidate(s)`);
  }
  out.push(
    `- source review-thread: ${artifact.threadCandidates.length} caught PR(s)`,
  );
  for (const tier of TIER_ORDER) {
    const count =
      tier === "review-caught"
        ? artifact.threadCandidates.length
        : artifact.candidates.filter(
            (candidate) => candidate.confidence === tier,
          ).length;
    out.push(`- tier ${tier}: ${count}`);
  }
  out.push("");
  out.push(
    "> Tier order below is descending confidence and sits BELOW the revert " +
      "tiers of `crysk reverts` — git's machine-written body linkage " +
      "outranks everything inferred here. The revert candidates themselves " +
      "live in that command's artifact; this one widens the corpus beyond " +
      "reverts.",
  );
  out.push("");
  if (
    failures.commitPrLookup404 > 0 ||
    failures.mergeCommitAbsent > 0 ||
    failures.blameRangeSkipped > 0
  ) {
    out.push(...DEGRADED_WARNING);
    out.push("");
  }
  out.push(...CANDIDATE_WARNING);
  out.push("");
  for (const tier of TIER_ORDER) {
    if (tier === "review-caught") {
      renderThreadSection(out, artifact.threadCandidates);
      continue;
    }
    const group = artifact.candidates.filter(
      (candidate) => candidate.confidence === tier,
    );
    out.push(`## ${tier} (${group.length})`);
    out.push("");
    out.push(TIER_NOTE[tier]);
    out.push("");
    if (group.length === 0) {
      out.push("_None in this window._");
      out.push("");
      continue;
    }
    for (const candidate of group) {
      out.push(...renderFixCandidate(candidate));
    }
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

function renderFixCandidate(candidate: CorpusCandidate): string[] {
  const out: string[] = [];
  out.push(`### fix PR #${candidate.fixPr} — ${candidate.fixTitle}`);
  out.push("");
  out.push(`- merged at: ${candidate.fixMergedAt ?? "unknown"}`);
  out.push(
    `- replay range (defect site): ${replayRange(candidate.fixBaseSha, candidate.fixHeadSha)}`,
  );
  out.push(`- diff size: ${diffSize(candidate)}`);
  out.push(`- sources: ${candidate.sources.join(", ")}`);
  out.push(`- evidence: ${candidate.matchedText}`);
  if (candidate.issueRefs.length > 0) {
    const refs = candidate.issueRefs
      .map((ref) =>
        ref.matchedLabels.length > 0
          ? `#${ref.number} (${ref.matchedLabels.join(", ")})`
          : `#${ref.number}`,
      )
      .join(", ");
    out.push(`- issue refs: ${refs}`);
  }
  out.push(`- introducer: ${introducerLine(candidate.introducer)}`);
  if (candidate.alsoBlamedCount > 0) {
    out.push(`- also blamed: ${candidate.alsoBlamedCount} other commit(s)`);
  }
  if (candidate.blameSkippedRenames > 0) {
    out.push(
      `- renamed file(s) skipped by blame: ${candidate.blameSkippedRenames}`,
    );
  }
  if (candidate.proximitySuspects.length > 0) {
    const suspects = candidate.proximitySuspects
      .map((suspect) => {
        const title = suspect.title === null ? "" : ` "${suspect.title}"`;
        return `#${suspect.pr}${title} (${suspect.sharedFiles} shared file(s), ${suspect.gapDays}d before the fix)`;
      })
      .join(", ");
    out.push(`- proximity suspects: ${suspects}`);
  }
  out.push("");
  return out;
}

function renderThreadSection(
  out: string[],
  threadCandidates: ThreadCandidate[],
): void {
  const ordered = [...threadCandidates].sort((a, b) => {
    const am = stampMs(a.mergedAt);
    const bm = stampMs(b.mergedAt);
    if (!Number.isNaN(am) && !Number.isNaN(bm) && am !== bm) return bm - am;
    if (Number.isNaN(am) !== Number.isNaN(bm)) {
      return Number.isNaN(am) ? 1 : -1;
    }
    return a.pr - b.pr;
  });
  out.push(`## review-caught (${ordered.length})`);
  out.push("");
  out.push(TIER_NOTE["review-caught"]);
  out.push("");
  if (ordered.length === 0) {
    out.push("_None in this window._");
    out.push("");
    return;
  }
  for (const candidate of ordered) {
    out.push(`### PR #${candidate.pr} — ${candidate.title} (caught in review)`);
    out.push("");
    out.push(`- merged at: ${candidate.mergedAt ?? "unknown"}`);
    out.push(
      `- replay range (defect site): ${replayRange(candidate.baseSha, candidate.headSha)}`,
    );
    out.push(
      `- diff size: ${diffSize({
        additions: candidate.additions,
        deletions: candidate.deletions,
        changedFiles: candidate.changedFiles,
      })}`,
    );
    for (const thread of candidate.threads) {
      const at =
        thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
      out.push(
        `- thread: \`${at}\` · first comment ${thread.firstCommentAt} · ` +
          `a commit landed after it: \`${thread.pushSha}\``,
      );
      if (thread.excerpt.length > 0) {
        out.push(`    excerpt: ${thread.excerpt}`);
      }
    }
    if (candidate.threadsTruncated) {
      out.push(
        `- note: resolved threads truncated at ${THREAD_PAGE_SIZE} — more ` +
          "exist than are shown",
      );
    }
    out.push("");
  }
}

function introducerLine(introducer: IntroducerInfo | null): string {
  if (introducer === null) return "unresolved";
  const where = `\`${introducer.blamedSha}\` at \`${introducer.blamedFile}:${introducer.blamedRange}\``;
  if (introducer.pr === null) {
    return `direct push — blame ${where}`;
  }
  const title =
    introducer.title === null ? "(title unresolved)" : `"${introducer.title}"`;
  return (
    `PR #${introducer.pr} ${title}, merged ` +
    `${introducer.mergedAt ?? "unknown"} — blame ${where}`
  );
}

function replayRange(base: string | null, head: string | null): string {
  if (base === null || head === null) return "unresolved";
  return `\`${base}..${head}\``;
}

function diffSize(size: {
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}): string {
  if (size.additions === null || size.deletions === null) return "unknown";
  const files =
    size.changedFiles === null
      ? "unknown files"
      : `${size.changedFiles} file(s)`;
  return `+${size.additions}/-${size.deletions}, ${files}`;
}
