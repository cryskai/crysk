import type { NumstatFile } from "#review/preflight";
import { diffRecordPath, splitDiffRecords } from "#review/size-gate";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// path -> right-side (head) line numbers the patch changes: added lines and
// the head-side position of each removal.
export function changeSitesByPath(patch: string): Map<string, Set<number>> {
  const sites = new Map<string, Set<number>>();
  for (const record of splitDiffRecords(patch)) {
    const target = diffRecordPath(record);
    if (target === undefined) continue;
    const lines = changeSitesForRecord(record);
    if (lines.size === 0) continue;
    const existing = sites.get(target);
    if (existing === undefined) {
      sites.set(target, lines);
    } else {
      for (const line of lines) existing.add(line);
    }
  }
  return sites;
}

function changeSitesForRecord(record: string): Set<number> {
  const out = new Set<number>();
  let right = 0;
  let inHunk = false;
  for (const line of record.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      right = Number.parseInt(header[1] as string, 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      out.add(right);
      right++;
      continue;
    }
    if (line.startsWith(" ")) {
      right++;
      continue;
    }
    if (line.startsWith("-")) {
      // A removal has no head line of its own; its site is the head position it occupied.
      out.add(right);
      continue;
    }
    if (line.startsWith("\\")) continue;
    inHunk = false;
  }
  return out;
}

export interface BaseMergeFilterResult {
  patch: string;
  droppedHunks: number;
}

// Keeps a hunk of the last-head..new-head patch only when its head-side range
// touches a line the PR's own merge-base..head patch changes. The test is a
// range overlap, not an exact line match: two diffs of the same file can align
// a repeated line (a blank line, a closing brace) differently, and the context
// lines of a hunk absorb that. The cost is that a base-branch hunk within a few
// lines of an author's change is kept, which errs toward showing more.
// Records with no hunks (binary, rename-only, mode-only) and records whose path
// the PR patch does not mention pass through: the filter never drops what it
// cannot read.
export function keepPrOwnedHunks(
  deltaPatch: string,
  prPatch: string,
): BaseMergeFilterResult {
  const sites = changeSitesByPath(prPatch);
  const emitted: string[] = [];
  let droppedHunks = 0;
  for (const record of splitDiffRecords(deltaPatch)) {
    const path = diffRecordPath(record);
    if (path === undefined) {
      emitted.push(record);
      continue;
    }
    const { preamble, hunks } = splitHunks(record);
    if (hunks.length === 0) {
      emitted.push(record);
      continue;
    }
    const pathSites = sites.get(path);
    if (pathSites === undefined) {
      emitted.push(record);
      continue;
    }
    const kept = hunks.filter((hunk) => hunkTouchesSites(hunk, pathSites));
    droppedHunks += hunks.length - kept.length;
    if (kept.length === 0) continue;
    emitted.push(preamble, ...kept);
  }
  return { patch: emitted.join(""), droppedHunks };
}

// The per-file counts `git diff --numstat` would give for this patch, read
// from the patch itself: once hunks are left out, no git range describes what
// remains. One entry per record with a resolvable path; a record with no hunk
// (binary, rename only, mode only) counts as a file with no lines.
export function patchNumstat(patch: string): NumstatFile[] {
  const files: NumstatFile[] = [];
  for (const record of splitDiffRecords(patch)) {
    const path = diffRecordPath(record);
    if (path === undefined) continue;
    let insertions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of record.split("\n")) {
      if (HUNK_HEADER.test(line)) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith("+")) insertions++;
      else if (line.startsWith("-")) deletions++;
      else if (!line.startsWith(" ") && !line.startsWith("\\")) inHunk = false;
    }
    files.push({
      path,
      insertions,
      deletions,
      binary:
        /^Binary files /m.test(record) || /^GIT binary patch$/m.test(record),
    });
  }
  return files;
}

interface RecordHunks {
  preamble: string;
  hunks: string[];
}

// Slices by character offset so each piece keeps its own bytes, newlines
// included: preamble + hunks reproduce the record exactly.
function splitHunks(record: string): RecordHunks {
  const starts: number[] = [];
  let offset = 0;
  for (const line of record.split("\n")) {
    if (HUNK_HEADER.test(line)) starts.push(offset);
    offset += line.length + 1;
  }
  if (starts.length === 0) return { preamble: record, hunks: [] };
  const hunks = starts.map((start, i) =>
    record.slice(start, starts[i + 1] ?? record.length),
  );
  return { preamble: record.slice(0, starts[0] as number), hunks };
}

function hunkTouchesSites(hunk: string, pathSites: Set<number>): boolean {
  const header = HUNK_HEADER.exec(hunk);
  if (header === null) return false;
  const start = Number.parseInt(header[1] as string, 10);
  const count = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
  const end = start + Math.max(count, 1);
  for (let n = start; n <= end; n++) {
    if (pathSites.has(n)) return true;
  }
  return false;
}
