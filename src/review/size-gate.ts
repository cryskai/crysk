// The size gate: "this diff is too big — skip it". Pure, offline-testable,
// and deliberately dumb — it counts lines and files and compares them to two
// numbers.
//
// WHY this exists, stated exactly and no wider: it is a COST AND
// PREDICTABILITY gate, NOT a quality gate. Measured on our own runs, small
// trees bill $1.9–$4.8, while the 45-file / +2775 −1237 bench tree billed
// $6.58–$17.92 across 18 iterations — the cost roughly triples AND its spread
// widens to ~2.7x, so a big tree is both expensive and unbudgetable.
//
// What this gate does NOT claim, because we measured it and it is not true:
// that a bigger diff reviews WORSE. Attention dilution was tested and
// falsified in fixtures/scale-probe.ts, and the one measured Greptile-only
// miss came from a 7-file PR. Nothing here — comment, message or flag help —
// may imply otherwise.

import {
  BUILTIN_IGNORE_RULES,
  compileIgnoreRules,
  type IgnoreRule,
} from "../ignore-file";
import type { IgnoreFileReadResult } from "../ignore-read";
import type { NumstatDiffStat, NumstatFile } from "./preflight";

export interface SizeGateConfig {
  // <= 0 disables the limit. Both knobs, independently.
  maxChangedLines: number;
  maxChangedFiles: number;
  excludeRules: IgnoreRule[];
}

// The shipped defaults. 4000 lines sits above the everyday PR; 150 files is
// the "this is a mechanical sweep, not a review" ceiling.
//
// The line default has a history, and the arc matters because the middle of
// it was a wrong diagnosis. 1500 shipped first, extrapolated from
// "everything measured cheap was under 830 lines". Then this repo's own PR
// #1 (1603 lines) printed `size gate: SKIP` and a $3.18-6.86 cost band in the
// same breath — the gate refusing, on cost grounds, a diff whose cost was
// ordinary. The conclusion drawn at the time was "the limit is too tight",
// and it was raised to 2500.
//
// That was treating the symptom. The real cause was that the gate was
// counting lines it was not actually filtering out of the bill:
//   - F001 — the exclusion list shrank the GATE's count but not the diff
//     handed to the hunters, so an excluded lockfile was still paid for in
//     full. The count and the bill were two different numbers.
//   - whitespace — a formatter sweep consumed budget it costs nothing to
//     review, because the count was taken from a plain `--numstat`.
// With both fixed (the reviewed diff IS the filtered diff, and the gate
// counts from `git diff -w --ignore-blank-lines`), the number the gate
// measures is the number that gets paid for, and 1500 was a real 1500. So it
// stood, and 2500 stayed retired — for a while.
//
// The band 830..4000 is still unmeasured. If a diff in it ever bills like the
// bench tree, this number is the thing to revisit — with a measurement, not
// another extrapolation.
//
// On 2026-09-25 the default moved again, 1500 -> 4000 — NOT a measurement
// this time, an owner decision: 1500 was skipping too many real PRs outright,
// and that cost (a review that never runs) was judged worse than the
// cost/predictability this gate exists to manage. This is the same bench tree
// cited above: +2775 -1237 across 45 files is ~4000 lines, so the new default
// sits right AT that tree's size, not "well below" it as the old default did.
// This says nothing about review quality at 4000 lines — see the file header,
// this is a COST gate, never a quality one — only that the owner would rather
// pay/wait for a big review than silently skip it.
//
// The default RULES — not a hand-written glob list — are generated-content
// only: lockfiles, minified bundles and jest-style snapshots are enormous,
// mechanical, and nothing a hunter can usefully read. Excluding them keeps
// the gate from firing on a PR whose real change is ten lines beside a
// regenerated lockfile. `BUILTIN_IGNORE_RULES` (src/ignore-file.ts) parses
// these same 9 exclusions from plain gitignore LINES through the exact
// dialect a user's own `.prheroignore` goes through, so the shape here is
// `IgnoreRule[]`, not `string[]`.
export const DEFAULT_SIZE_GATE: SizeGateConfig = {
  maxChangedLines: 4000,
  maxChangedFiles: 150,
  excludeRules: BUILTIN_IGNORE_RULES,
};

export type SizeGateVerdict =
  | {
      ok: true;
      effectiveLines: number;
      effectiveFiles: number;
      excludedFiles: number;
      excludedLines: number;
    }
  | {
      ok: false;
      reason: "lines" | "files";
      effectiveLines: number;
      effectiveFiles: number;
      excludedFiles: number;
      excludedLines: number;
      limit: number;
      message: string;
    };

// What the shell does with a verdict. Pure so the three callers (local,
// PR, and the tests) cannot drift on who gets a prompt vs a hard skip.
//
// proceed — under the limit, or --force already answered "review anyway".
// skip    — over the limit AND nobody can be asked: --yes (the watcher
//           spawns with it) or a non-TTY stdin. This is the load-bearing
//           unattended path; a prompt here would never fire, which is
//           exactly how the gate used to be bypassed by accident.
// prompt  — over the limit, interactive TTY, no --force. The operator
//           already typed the review command; dying and making them
//           re-run with --force is the same answer with worse UX.
export type SizeGateDisposition =
  | { action: "proceed" }
  | { action: "skip"; message: string }
  | { action: "prompt" };

export function sizeGateDisposition(
  verdict: SizeGateVerdict,
  opts: { force: boolean; yes: boolean; interactive: boolean },
): SizeGateDisposition {
  if (verdict.ok || opts.force) return { action: "proceed" };
  if (opts.yes || !opts.interactive) {
    return { action: "skip", message: verdict.message };
  }
  return { action: "prompt" };
}

// Exclusions are applied FIRST and the REMAINDER is what gets compared: the
// whole point of the list is that a regenerated lockfile must not push a
// small change over the line. Lines are checked before files, because the
// line count is what actually drives the bill (files is the coarser
// backstop).
export function evaluateSizeGate(
  files: NumstatFile[],
  config: SizeGateConfig,
): SizeGateVerdict {
  const matcher = compileIgnoreRules(config.excludeRules);
  let effectiveLines = 0;
  let effectiveFiles = 0;
  let excludedLines = 0;
  let excludedFiles = 0;
  for (const file of files) {
    const lines = file.insertions + file.deletions;
    if (matcher.match(file.path) !== undefined) {
      excludedFiles++;
      excludedLines += lines;
      continue;
    }
    effectiveFiles++;
    effectiveLines += lines;
  }
  const counts = {
    effectiveLines,
    effectiveFiles,
    excludedFiles,
    excludedLines,
  };
  if (config.maxChangedLines > 0 && effectiveLines > config.maxChangedLines) {
    return {
      ok: false,
      reason: "lines",
      ...counts,
      limit: config.maxChangedLines,
      message: gateMessage(
        `${effectiveLines} effective changed line${plural(effectiveLines)} ` +
          `exceeds the ${config.maxChangedLines}-line limit`,
        counts,
        "--max-changed-lines",
      ),
    };
  }
  if (config.maxChangedFiles > 0 && effectiveFiles > config.maxChangedFiles) {
    return {
      ok: false,
      reason: "files",
      ...counts,
      limit: config.maxChangedFiles,
      message: gateMessage(
        `${effectiveFiles} effective changed file${plural(effectiveFiles)} ` +
          `exceeds the ${config.maxChangedFiles}-file limit`,
        counts,
        "--max-changed-files",
      ),
    };
  }
  return { ok: true, ...counts };
}

// THE POINT OF THE EXCLUSION LIST, restated as an invariant: the number the
// gate measures and the number that gets paid for must be the SAME number.
// Before this existed, exclusions shrank the gate's count while the hunters
// were still handed the full unfiltered diff — so a PR with a regenerated
// 5000-line lockfile passed the gate on a small effective count and then paid
// to feed that lockfile to every hunter, defeating the gate in exactly the
// case it was built for.
//
// So the excluded files fall out of the REVIEWED DIFF itself: `diff.patch` is
// this function's output, which makes it literally what the hunters saw, and
// the cost basis is `effectiveDiffStat` over the SAME rule set — both now
// share the one matcher this module builds via `compileIgnoreRules`, so they
// cannot independently drift on what counts as excluded (the "Single Shared
// Matcher" requirement this consolidation exists to satisfy).
//
// Filtering a unified diff by path has to be done on RECORDS, never on lines:
// a `diff --git ` header at column 0 starts a record and everything up to the
// next one belongs to it (content lines always carry a ` `/`+`/`-`/`\` prefix,
// so they can never be mistaken for a header). Whole records are dropped or
// kept — never individual hunks.
export interface ExcludedPath {
  path: string;
  // The excluding rule's source line — see IgnoreRule.pattern.
  pattern: string;
  source: "builtin" | "user";
  line?: number;
}

export interface DiffFilterResult {
  // The effective diff: every record whose destination path matched an
  // exclusion rule removed. Byte-identical to the input when nothing matched.
  patch: string;
  // Destination paths of the dropped records, in diff order. Empty means the
  // filter was a no-op — callers use this to decide whether a raw copy of the
  // diff is worth keeping and what to report as provenance.
  droppedPaths: string[];
  // Per-path provenance: which rule (and source) excluded it, in diff order,
  // parallel to droppedPaths.
  exclusions: ExcludedPath[];
}

export function filterDiffByIgnoreRules(
  patch: string,
  rules: readonly IgnoreRule[],
): DiffFilterResult {
  const records = splitDiffRecords(patch);
  if (records.length === 0) return { patch, droppedPaths: [], exclusions: [] };
  const matcher = compileIgnoreRules(rules);
  const kept: string[] = [];
  const droppedPaths: string[] = [];
  const exclusions: ExcludedPath[] = [];
  for (const record of records) {
    const target = diffRecordPath(record);
    // A record whose path cannot be resolved is KEPT. Failing open here is
    // the conservative direction: the worst case is paying to review a file
    // that could have been excluded, where failing closed would silently
    // delete real changed code out of the reviewed diff. PRESERVED across
    // this rename/consolidation — see the pin in test/size-gate.test.ts.
    const hit = target !== undefined ? matcher.match(target) : undefined;
    if (target !== undefined && hit !== undefined) {
      droppedPaths.push(target);
      exclusions.push({
        path: target,
        pattern: hit.pattern,
        source: hit.source,
        line: hit.line,
      });
      continue;
    }
    kept.push(record);
  }
  return { patch: kept.join(""), droppedPaths, exclusions };
}

// Split on column-0 `diff --git ` headers, keeping each record's own bytes
// (including its trailing newline) so a no-op filter reassembles the input
// exactly. Anything before the first header — git emits nothing there, but a
// hand-assembled patch might — is carried as a leading record with no path,
// which the fail-open rule above keeps.
export function splitDiffRecords(patch: string): string[] {
  const records: string[] = [];
  let start = -1;
  let offset = 0;
  for (const line of patch.split("\n")) {
    const lineLength = line.length + 1;
    if (line.startsWith("diff --git ")) {
      if (start !== -1) records.push(patch.slice(start, offset));
      start = offset;
    } else if (start === -1 && line.length > 0) {
      start = offset;
    }
    offset += lineLength;
  }
  if (start !== -1) records.push(patch.slice(start));
  return records;
}

// The DESTINATION path of a record, resolved the same way and for the same
// reason as resolveNumstatPath (review/preflight.ts): a rename must be matched on
// where the file ENDED UP, or a renamed lockfile silently stops being
// excluded. Preference order runs from the most explicit source to the least:
//
//   `rename to` / `copy to`  — the only unambiguous destination for a rename,
//                              and present even when the record is binary and
//                              carries no ---/+++ pair at all;
//   `+++ b/<path>`           — the ordinary textual case;
//   `--- a/<path>`           — a deletion (+++ is /dev/null), where the source
//                              path is the only path there is;
//   the header itself        — binary adds/deletes, which have neither.
//
// git quotes paths with control or non-ASCII characters
// (`"caf\303\251/bun.lock"`), and this unquotes them. resolveNumstatPath in
// review/preflight.ts now unquotes too: the asymmetry was NOT harmless — such a file
// was dropped from diff.patch while its lines stayed in the gate's count, so
// the gate could refuse a PR whose effective diff was small. Both sides must
// keep unquoting or that divergence comes straight back.
export function diffRecordPath(record: string): string | undefined {
  const lines = record.split("\n");
  let minusPath: string | undefined;
  for (const line of lines) {
    if (line.startsWith("rename to ")) return unquotePath(line.slice(10));
    if (line.startsWith("copy to ")) return unquotePath(line.slice(8));
    if (line.startsWith("+++ ")) {
      const target = stripDiffPrefix(line.slice(4));
      if (target !== undefined) return target;
    }
    if (line.startsWith("--- ") && minusPath === undefined) {
      minusPath = stripDiffPrefix(line.slice(4));
    }
    // The header and the ---/+++ pair live in the record's preamble; hunks
    // below can contain any text at all, so stop before reading them as
    // metadata.
    if (line.startsWith("@@")) break;
  }
  if (minusPath !== undefined) return minusPath;
  return headerPath(lines[0] ?? "");
}

// `a/<path>` / `b/<path>`, with /dev/null meaning "this side does not exist".
function stripDiffPrefix(field: string): string | undefined {
  // The path may be followed by a tab and a timestamp (git does not emit one,
  // other producers do).
  const raw = unquotePath(field.split("\t")[0] ?? "");
  if (raw === "/dev/null") return undefined;
  return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
}

// `diff --git a/<src> b/<dst>`. The separator is ambiguous when a path itself
// contains " b/", so prefer the split where source and destination agree (the
// non-rename case, which is nearly all of them) and fall back to the first
// candidate. Only reached for records that carry no other path evidence.
function headerPath(header: string): string | undefined {
  if (!header.startsWith("diff --git ")) return undefined;
  const rest = header.slice(11);
  let first: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (!rest.startsWith(" b/", i)) continue;
    const source = unquotePath(rest.slice(0, i));
    const destination = unquotePath(rest.slice(i + 1));
    const src = source.startsWith("a/") ? source.slice(2) : source;
    const dst = destination.startsWith("b/")
      ? destination.slice(2)
      : destination;
    if (src === dst) return dst;
    if (first === undefined) first = dst;
  }
  return first;
}

// git's C-style quoting, undone. Only the escapes git actually emits.
export function unquotePath(field: string): string {
  const raw = field.trim();
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) {
    return raw;
  }
  const body = raw.slice(1, -1);
  let out = "";
  const bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length === 0) return;
    out += new TextDecoder().decode(new Uint8Array(bytes));
    bytes.length = 0;
  };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      flush();
      out += body[i];
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}$/.exec(body.slice(i + 1, i + 4));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    flush();
    const simple: Record<string, string> = {
      n: "\n",
      t: "\t",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    out += simple[next] ?? next;
    i += 1;
  }
  flush();
  return out;
}

// The cost basis: the same aggregate the plan and the cost band read, but
// summed over the files that SURVIVE the exclusions. Feeding estimateCost the
// raw stat would price a lockfile the hunters never see.
export function effectiveDiffStat(
  files: NumstatFile[],
  rules: readonly IgnoreRule[],
): NumstatDiffStat {
  const matcher = compileIgnoreRules(rules);
  let count = 0;
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    if (matcher.match(file.path) !== undefined) continue;
    count++;
    insertions += file.insertions;
    deletions += file.deletions;
  }
  return { files: count, insertions, deletions };
}

// The message names the COST reason and the escape hatch, in that order: an
// operator who hits this must be able to tell in one line that nothing is
// wrong with their PR and exactly which two levers move the gate.
//
// It quotes the MEASUREMENT rather than predicting THIS diff's bill. The
// limit is configurable, so "this costs $7-18" would be plainly false at a
// tightened threshold — and a gate that overstates its own evidence is the
// first step toward the quality claim we do not have.
function gateMessage(
  headline: string,
  counts: { excludedFiles: number; excludedLines: number },
  limitFlag: string,
): string {
  const exclusion =
    counts.excludedFiles > 0
      ? ` (${counts.excludedLines} line${plural(counts.excludedLines)} in ` +
        `${counts.excludedFiles} excluded file${plural(counts.excludedFiles)} ` +
        "were not counted)"
      : "";
  return (
    `${headline}${exclusion}. Cost scales with diff size and gets less ` +
    "predictable as it does (our 45-file bench tree billed $6.58-17.92, a " +
    "~2.7x spread), so Crysk skips past the limit rather than guess at " +
    `the bill. Raise ${limitFlag}, or pass --force to review it anyway.`
  );
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

// The same gate against an AGGREGATE (files + insertions + deletions) with
// no per-file paths — so no exclusion can apply and the answer is an upper
// bound on the effective size. Used exactly where the per-file data costs a
// round-trip we have chosen not to pay: the PR dry run (which promises to
// fetch nothing) and the watcher's free first tier. It can only ever be
// wrong in the CONSERVATIVE direction — it may say "too large" for a diff
// whose lockfiles would have rescued it — so every caller must either label
// it an estimate or escalate to real per-file data before acting.
//
// WHY THE GATE IS TWO DIFFERENT INSTRUMENTS, and it is not an oversight:
// where git is reachable (local mode, PR mode after the fetch) the count
// comes from `git diff -w --ignore-blank-lines --numstat`, so a formatter
// sweep counts zero. GitHub's counters — `additions`/`deletions`/
// `changedFiles` here, and `gh pr view --json files` in the watcher's second
// tier — carry NO whitespace information at all, and no amount of arithmetic
// can recover it. Those paths are whitespace-NAIVE and must say so wherever
// they print, because a reformat can push them over a limit that the real
// git-side gate would never have fired. Both errors point the same way
// (overcount, never undercount), which is what makes the asymmetry safe.
export function evaluateSizeGateAggregate(
  stat: { files: number; insertions: number; deletions: number },
  config: SizeGateConfig,
): SizeGateVerdict {
  const counts = {
    effectiveLines: stat.insertions + stat.deletions,
    effectiveFiles: stat.files,
    excludedFiles: 0,
    excludedLines: 0,
  };
  if (
    config.maxChangedLines > 0 &&
    counts.effectiveLines > config.maxChangedLines
  ) {
    return {
      ok: false,
      reason: "lines",
      ...counts,
      limit: config.maxChangedLines,
      message: gateMessage(
        `${counts.effectiveLines} changed line${plural(counts.effectiveLines)} ` +
          `exceeds the ${config.maxChangedLines}-line limit`,
        counts,
        "--max-changed-lines",
      ),
    };
  }
  if (
    config.maxChangedFiles > 0 &&
    counts.effectiveFiles > config.maxChangedFiles
  ) {
    return {
      ok: false,
      reason: "files",
      ...counts,
      limit: config.maxChangedFiles,
      message: gateMessage(
        `${counts.effectiveFiles} changed file${plural(counts.effectiveFiles)} ` +
          `exceeds the ${config.maxChangedFiles}-file limit`,
        counts,
        "--max-changed-files",
      ),
    };
  }
  return { ok: true, ...counts };
}

// The CLI's own knobs on top of the defaults. Undefined means "not asked
// for", never 0 — 0 is a real value here (it DISABLES the limit), so the
// two cannot be collapsed.
//
// `userRules` is ADDITIVE and optional on purpose: no caller passes it yet
// (that lands with the local/base-ref `.prheroignore` reads), and omitting
// it must reproduce today's exact behavior byte-for-byte — that is what
// keeps `sizeGateConfig({})` equal to `DEFAULT_SIZE_GATE` even after this
// parameter exists. Builtins are always FIRST, user rules LAST, matching
// the dialect's own evaluation order (see compileIgnoreRules).
export function sizeGateConfig(
  overrides: {
    maxChangedLines?: number;
    maxChangedFiles?: number;
  },
  config?: {
    max_changed_lines?: number;
    max_changed_files?: number;
  },
  userRules?: readonly IgnoreRule[],
): SizeGateConfig {
  return {
    maxChangedLines:
      overrides.maxChangedLines ??
      config?.max_changed_lines ??
      DEFAULT_SIZE_GATE.maxChangedLines,
    maxChangedFiles:
      overrides.maxChangedFiles ??
      config?.max_changed_files ??
      DEFAULT_SIZE_GATE.maxChangedFiles,
    excludeRules:
      userRules !== undefined
        ? [...BUILTIN_IGNORE_RULES, ...userRules]
        : DEFAULT_SIZE_GATE.excludeRules,
  };
}

// The wiring wrapper both review shells actually call (#177/O-8): the two
// unexported I/O shells (review(), reviewPr()) each resolve an
// IgnoreFileReadResult from a DIFFERENT read (working tree / operator root /
// base ref) and then must thread its `.rules` — never the read result
// itself, never a dropped default `[]` — into sizeGateConfig's third
// parameter. Before this wrapper existed that was a plain call to
// sizeGateConfig with `.rules` picked out ad hoc at each of the three call
// sites (local review, PR dry run, PR real run), which is exactly the shape
// that can drift silently: `userRules` is OPTIONAL on sizeGateConfig itself
// (see its own WHY), so a call that quietly drops the third argument still
// compiles and produces a config with only the built-in exclusions — a
// user's `.prheroignore` rule stops applying and nothing fails loud.
// `ignore` is a REQUIRED parameter here (its VALUE may still be `undefined`,
// e.g. reviewPr()'s CI dry run has no working-tree read to offer) precisely
// so a caller cannot drop it by omission the way it could drop
// sizeGateConfig's own optional third argument.
export function sizeGateConfigFor(
  overrides: {
    maxChangedLines?: number;
    maxChangedFiles?: number;
  },
  config:
    | { max_changed_lines?: number; max_changed_files?: number }
    | undefined,
  ignore: IgnoreFileReadResult | undefined,
): SizeGateConfig {
  return sizeGateConfig(overrides, config, ignore?.rules);
}

// A one-line projection for the plan/dry-run output. Kept here so the local
// and PR shells (and the watch dry run) cannot drift in how they phrase it.
export function sizeGateLine(verdict: SizeGateVerdict): string {
  const excluded =
    verdict.excludedFiles > 0
      ? `, ${verdict.excludedFiles} file(s)/${verdict.excludedLines} line(s) excluded`
      : "";
  return verdict.ok
    ? `size gate: pass — ${verdict.effectiveLines} effective line(s) in ` +
        `${verdict.effectiveFiles} file(s)${excluded}`
    : `size gate: SKIP — ${verdict.message}`;
}
