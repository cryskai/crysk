// The skills' version cache, under ~/.crysk/skills/.
//
// An installed skill is a stub that runs `crysk skills load <skill>`, and the
// playbook it should get is the one of the engine version that reviewed the
// pull request, not the newest one: a team that pins the workflow to a version
// needs that version's instructions. Two caches keep that fast with no network
// call on load:
//
// - engines.json maps a repository root to the engine version of the newest
//   review `crysk status` has read, with that review's time. Status runs every
//   round of the triage loop, so a new engine version replaces the entry the
//   first time it shows, and status on an old pull request does not undo it.
// - playbooks/<version>/<skill>/<file> holds a file exactly as that version
//   ships it. A published version never changes, so these never go stale.
//
// Every read and write is best-effort: a missing, unreadable or read-only home
// falls back to the bundled files, it never fails a load or a status read.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPlainEngineVersion } from "#ci/review-admission";
import { prheroLayout } from "./home-preflight";

function enginesPath(home: string): string {
  return path.join(prheroLayout(home).skillsCacheDir, "engines.json");
}

function playbookPath(
  home: string,
  version: string,
  skill: string,
  file: string,
): string {
  return path.join(
    prheroLayout(home).skillsCacheDir,
    "playbooks",
    version,
    skill,
    file,
  );
}

function readEngines(home: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(enginesPath(home), "utf8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// WHY write-then-rename: two agents can run status on the same machine at
// once, and a torn engines.json would read as empty and drop every entry.
function writeAtomically(target: string, content: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, target);
}

interface EngineEntry {
  version: string;
  at: string | null;
}

function engineEntry(value: unknown): EngineEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, at } = value as { version?: unknown; at?: unknown };
  if (!isPlainEngineVersion(version)) return undefined;
  return { version, at: typeof at === "string" ? at : null };
}

export function readEngineVersion(
  home: string,
  repoRoot: string,
): string | undefined {
  return engineEntry(readEngines(home)[repoRoot])?.version;
}

// Whether a review at `at` may replace the recorded one. WHY by time and not by
// the higher version: a release can be rolled back, and the lower version is
// then the right one. A review of unknown age never replaces a known entry.
function supersedes(at: string | null, current: EngineEntry): boolean {
  if (at === null) return false;
  const time = Date.parse(at);
  if (Number.isNaN(time)) return false;
  const currentTime = current.at === null ? Number.NaN : Date.parse(current.at);
  return Number.isNaN(currentTime) || time >= currentTime;
}

export function recordEngineVersion(
  home: string,
  repoRoot: string,
  version: string,
  at: string | null = null,
): void {
  if (!isPlainEngineVersion(version)) return;
  try {
    const engines = readEngines(home);
    const current = engineEntry(engines[repoRoot]);
    if (current !== undefined && !supersedes(at, current)) return;
    engines[repoRoot] = { version, at };
    writeAtomically(enginesPath(home), `${JSON.stringify(engines, null, 2)}\n`);
  } catch {
    // Best-effort: the next load serves the bundled playbook and the next
    // status names the reload again.
  }
}

// `skill` and `file` must already be names the bundled skill ships: the load
// command validates them against the package's manifest before calling these.
export function readCachedSkillFile(
  home: string,
  version: string,
  skill: string,
  file: string,
): string | undefined {
  if (!isPlainEngineVersion(version)) return undefined;
  try {
    return readFileSync(playbookPath(home, version, skill, file), "utf8");
  } catch {
    return undefined;
  }
}

export function writeCachedSkillFile(
  home: string,
  version: string,
  skill: string,
  file: string,
  content: string,
): void {
  if (!isPlainEngineVersion(version)) return;
  try {
    writeAtomically(playbookPath(home, version, skill, file), content);
  } catch {
    // Best-effort: the next load delegates again.
  }
}
