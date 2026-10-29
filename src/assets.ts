// Authority for packaged-asset resolution and self-invocation.
// Single authority across dev, npm, and compiled runtimes.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  BUNDLED_AGENT_FILES,
  CI_SETUP_SKILL_FILES,
  CONSOLIDATE_PROMPT_PATH,
  GENERAL_SKILL_FILES,
  PR_SKILL_FILES,
  SCOUT_PROMPT_PATH,
  SUMMARIZER_PROMPT_PATH,
  TRIAGE_SKILL_FILES,
} from "./asset-manifest";

export type AssetMode = "dev" | "npm" | "compiled";

export interface EngineAssets {
  mode: AssetMode;
  bundledAgentFiles: Record<string, string>; // logical filename → path, from the manifest (every mode)
  defaultAgentsDir: string; // the prompts/default dir in dev/npm, or embedded asset directory when compiled
  consolidatePromptPath: string;
  scoutPromptPath: string;
  summarizerPromptPath: string;
  triageSkillFiles: Record<string, string>; // logical filename → path, from the manifest
  ciSetupSkillFiles: Record<string, string>; // logical filename → path, from the manifest
  prSkillFiles: Record<string, string>; // logical filename → path, from the manifest
  generalSkillFiles: Record<string, string>; // logical filename → path, from the manifest
  version: string; // baked at compile; package.json otherwise
}

export interface SelfInvocation {
  command: string; // absolute: the bun binary (dev/npm) or the compiled binary itself
  args: string[]; // [absolute cli.ts] in dev/npm; [] when compiled
}

declare const __PRHERO_VERSION__: string | undefined;

export function detectAssetMode(): AssetMode {
  // Bun compiled binaries embed files into /$bunfs/root/
  if (
    import.meta.dir.startsWith("/$bunfs") ||
    import.meta.url.startsWith("file:///$bunfs")
  ) {
    return "compiled";
  }

  // Check if we are inside a node_modules package or no .git directory
  const gitDir = path.resolve(import.meta.dir, "../.git");
  if (import.meta.dir.includes("node_modules") || !existsSync(gitDir)) {
    return "npm";
  }

  return "dev";
}

function resolveVersion(): string {
  if (typeof __PRHERO_VERSION__ === "string" && __PRHERO_VERSION__.length > 0) {
    return __PRHERO_VERSION__;
  }

  try {
    const pkgPath = path.resolve(import.meta.dir, "../package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") {
        return pkg.version;
      }
    }
  } catch {
    // Ignore read errors
  }

  return "0.2.6";
}

export function resolveEngineAssets(): EngineAssets {
  const mode = detectAssetMode();
  const version = resolveVersion();

  let defaultAgentsDir = path.dirname(BUNDLED_AGENT_FILES["review-refuter.md"]);
  if (mode !== "compiled") {
    const fsDefaultDir = path.resolve(import.meta.dir, "../prompts/default");
    if (existsSync(fsDefaultDir)) {
      defaultAgentsDir = fsDefaultDir;
    }
  }

  return {
    mode,
    bundledAgentFiles: BUNDLED_AGENT_FILES,
    defaultAgentsDir,
    consolidatePromptPath: CONSOLIDATE_PROMPT_PATH,
    scoutPromptPath: SCOUT_PROMPT_PATH,
    summarizerPromptPath: SUMMARIZER_PROMPT_PATH,
    triageSkillFiles: TRIAGE_SKILL_FILES,
    ciSetupSkillFiles: CI_SETUP_SKILL_FILES,
    prSkillFiles: PR_SKILL_FILES,
    generalSkillFiles: GENERAL_SKILL_FILES,
    version,
  };
}

export function selfInvocation(): SelfInvocation {
  const mode = detectAssetMode();
  if (mode === "compiled") {
    return {
      command: process.execPath,
      args: [],
    };
  }

  return {
    command: process.execPath,
    args: [path.resolve(import.meta.dir, "cli.ts")],
  };
}

// WHY: `npx pr-hero` runs from npm's temporary cache (~/.npm/_npx/<hash>/), which npm
// may delete at any time. An MCP config or a launchd plist that records that path
// breaks silently once it is gone, so registration refuses it and names the fix.
export const NPX_REGISTRATION_REFUSED =
  "Crysk is running from npx's temporary cache; install crysk (npm i -g crysk) to register";
const NPX_CACHE_SEGMENT = /[\\/]_npx[\\/]/;
export function isNpxCacheInvocation(invocation: SelfInvocation): boolean {
  return [invocation.command, ...invocation.args].some((part) =>
    NPX_CACHE_SEGMENT.test(part),
  );
}

// Read through resolveEngineAssets() rather than the constants in index.ts:
// the version a run is stamped with must be the one that would be published,
// and a hand-maintained duplicate drifts. That one resolver also covers the
// compiled binary, whose version is baked in at build time because its
// package.json is not shipped inside the executable.
// C4 O-0. `version` alone does not discriminate: for a source checkout it is
// package.json's, which said 0.1.0 from the scaffold commit onwards, so every
// run this engine has ever written — before and after a change that alters
// what every agent reads — reports the same engine. That is not a cosmetic gap. The Cal.com Martian
// baseline is ratified as valid ACROSS engine versions on the condition that
// the frontier is annotated (docs/martian-bench.md), and an artifact whose
// engine field cannot change cannot annotate anything.
//
// The revision is the git commit, which moves on its own and needs nobody to
// remember a bump — the failure mode this whole item exists to remove.
//
// PURE half, so the fallbacks are testable without a filesystem or a spawn.
export function deriveEngineIdentity(
  pkg: { name?: string; version?: string },
  revision: { ok: boolean; stdout: string },
): { name: string; version: string; revision?: string } {
  const sha = revision.ok ? revision.stdout.trim() : "";
  return {
    name: pkg.name ?? "pr-hero",
    version: pkg.version ?? "0.0.0",
    // ABSENT rather than "unknown" when git cannot answer. A checkout without
    // git, or a tarball install, still has to be able to run a review — a run
    // that refused to start over a provenance field would trade a paid review
    // for a string. Absent reads as "this run could not name its commit",
    // which is exactly true, and it is also what every pre-C4 artifact says.
    ...(sha.length === 0 ? {} : { revision: sha }),
  };
}

// The engine's own checkout root, for reading its revision. Computed HERE because
// this module is the single place allowed to derive a filesystem path from
// import.meta (packaging.test.ts pins that), and the answer depends on which file
// asks: import.meta.dir is the directory of the module that evaluates it. From
// src/ the parent is the checkout; from src/git/ the same expression lands on
// src/ itself.
//
// Moving engineIdentity into src/git/ with its own `path.join(import.meta.dir,
// "..")` intact did shift the path by one level. It did NOT produce a wrong
// revision, and that is worth stating precisely rather than overclaiming: git
// discovers the repository upward from any subdirectory, so `git -C src/` and
// `git -C <checkout>` return the same HEAD. The shift was invisible here only
// because git happened to be forgiving. The single-authority rule is what keeps
// a relocation from silently changing which path a module resolves, in a runtime
// where nothing upstream would absorb the mistake.
export function engineCheckoutRoot(): string {
  return path.join(import.meta.dir, "..");
}
