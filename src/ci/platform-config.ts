// Platform mode: apply the review configuration the Crysk platform returned with
// the run token, so the engine's own two-layer read (src/config/config.ts,
// mergeConfig + CONFIG_DIRECTION) resolves it against the repository's
// `.crysk/config.json` with each key's own rule.
//
// `person` is the runner's personal layer: setup.ts writes it into the personal
// config file it already writes `routing` to (see materializeCiOpenCodeData).
// `repo` is used ONLY when the checkout has no repo config of its own, and then
// it reaches the engine through the existing `--config` override, which
// repoints the repo layer and nothing else. The file lives next to the platform
// config under the runner's temp directory, outside the workspace: the PR's own
// tree must never be written to, and a reviewed PR must never influence config
// (the engine reads the repo layer from the operator root, never the worktree).
//
// WHY the engine's parsers validate here although the platform already did: the
// engine is the authority on its own rules, and the platform's copy of them can
// lag a release. WHY every failure throws: a review with the wrong limits is
// worse than no review, so the setup step turns each one into a red run. No
// message carries a value, only the layer, the key the engine names, and a file.
//
// This runs after `bun install` (it imports the engine's parsers), unlike the
// connect step in platform.ts, which only hands the raw object over as a file.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGlobalConfig, parseLocalConfig } from "#review/preflight";
import { resolveRepoDir } from "../brand-paths";
import { type PlatformConfig, parsePlatformConfig } from "./platform";

// Names the layer the parser's own message is templated over, so an error
// reads `platform config.repo max_changed_lines must be ...`.
const PERSON_LABEL = "platform config.person";
const REPO_LABEL = "platform config.repo";

// The repo layer's file, beside the platform config file the connect step wrote.
const REPO_LAYER_FILE_NAME = "platform-repo-config.json";

export class PlatformConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformConfigError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

// The file the connect step left. A missing or malformed one fails loudly: the
// step that reads it only runs when the connect step announced it.
export function readPlatformConfig(file: string): PlatformConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PlatformConfigError(
      `the platform config file ${file} could not be read: ${messageOf(error)}`,
    );
  }
  const config = parsePlatformConfig(parsed);
  if (!config.ok) {
    throw new PlatformConfigError(
      `the platform config file ${file} is malformed: ${config.message}`,
    );
  }
  return config.config ?? { person: {}, repo: {} };
}

// Refuses a person layer the engine's person parser would refuse, naming the file
// it was about to be written to. Nothing is written before this passes.
export function assertPlatformPerson(
  person: Record<string, unknown>,
  targetFile: string,
): void {
  try {
    parseGlobalConfig(JSON.stringify(person), PERSON_LABEL);
  } catch (error) {
    throw new PlatformConfigError(
      `${messageOf(error)} (it was to be written to ${targetFile})`,
    );
  }
}

export type PlatformRepoLayerResult =
  // `repo` was empty: nothing to deliver.
  | { status: "empty" }
  // The checkout has its own repo config file; it wins whole.
  | { status: "repo-file-wins"; file: string }
  // `repo` was written to `file`, to be passed as `--config`.
  | { status: "written"; file: string };

// Decides whether the platform's repo layer applies, and delivers it as a temp
// file when it does.
//
// WHY the existence check is resolveRepoDir + config.json: that is exactly the
// path loadEffectiveConfig opens, `.crysk/` first and the pre-rename `.prhero/`
// when that is all there is. A second hand-written list of names would be a
// second chance to disagree with the engine about whether a repo file exists.
// `root` is the operator root, the same one the engine reads.
export async function deliverPlatformRepoLayer(input: {
  repo: Record<string, unknown>;
  root: string;
  dir: string;
}): Promise<PlatformRepoLayerResult> {
  if (Object.keys(input.repo).length === 0) return { status: "empty" };

  const own = path.join(resolveRepoDir(input.root), "config.json");
  if (existsSync(own)) return { status: "repo-file-wins", file: own };

  const raw = JSON.stringify(input.repo);
  try {
    parseLocalConfig(raw, REPO_LABEL);
  } catch (error) {
    throw new PlatformConfigError(messageOf(error));
  }
  const file = path.join(input.dir, REPO_LAYER_FILE_NAME);
  try {
    await mkdir(input.dir, { recursive: true, mode: 0o700 });
    await writeFile(file, `${raw}\n`, { mode: 0o600 });
  } catch (error) {
    throw new PlatformConfigError(
      `the platform repo config could not be written to ${file}: ${messageOf(error)}`,
    );
  }
  return { status: "written", file };
}
