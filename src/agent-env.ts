import crypto from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type EngineAssets,
  isNpxCacheInvocation,
  NPX_REGISTRATION_REFUSED,
} from "./assets";
import {
  LEGACY_MCP_SERVER_KEY,
  LEGACY_SKILL_NAMES,
  MCP_SERVER_KEY,
  SKILL_NAMES,
} from "./brand";

export type AgentEnvId =
  | "claude"
  | "cursor"
  | "windsurf"
  | "codex"
  | "antigravity"
  | "opencode";

export type AgentEnvStatus = "active" | "detected_inactive" | "coming_soon";

export interface AgentEnvCapabilities {
  skills: boolean;
  mcp: boolean;
}

export interface AgentEnvAuthStatus {
  authenticated: boolean;
  message: string;
  tokenSource?: "env" | "file" | "session";
}

export interface AgentEnvDetection {
  id: AgentEnvId;
  displayName: string;
  status: AgentEnvStatus;
  binaryFound: boolean;
  binaryPath?: string;
  version?: string;
  auth: AgentEnvAuthStatus;
  skillsDir?: string;
  mcpConfigFile?: string;
}

export interface McpRegistration {
  command: string;
  args: string[];
}

export interface DetectAgentEnvironmentsOptions {
  home?: string;
  which?: (binary: string) => string | null | Promise<string | null>;
  exists?: (path: string) => boolean;
}

export interface SyncSkillsOptions {
  force?: boolean;
  readFile?: (path: string) => string | undefined;
  writeFile?: (path: string, content: string) => Promise<void> | void;
  exists?: (path: string) => boolean;
  // The legacy cleanup's deletes, so a faked filesystem fakes them too.
  unlink?: (path: string) => void;
  rmdir?: (path: string) => void;
}

export type SkillSyncStatus =
  | "installed"
  | "updated"
  | "current"
  | "drift-kept";

export interface SkillSyncOutcome {
  skill: string;
  status: SkillSyncStatus;
  // Set for drift-kept: why the local copy was left alone.
  reason?: string;
}

// What sync did with a pre-rename skill dir once its replacement was installed.
export interface LegacySkillOutcome {
  skill: string;
  // removed: the dir is gone. kept: a file the user edited, or one sync never
  // recorded, is still there, so the dir stays and the user is told.
  status: "removed" | "kept";
  reason?: string;
}

export interface SyncSkillsResult {
  synced: string[];
  // One outcome per bundled skill, in sync order, for this agent environment.
  skills: SkillSyncOutcome[];
  // Present only when an old-name dir was found.
  legacy?: LegacySkillOutcome[];
  upToDate?: boolean;
  driftDetected?: boolean;
  errors: string[];
}

const NO_DIGEST_DRIFT_REASON =
  "local copy differs and has no recorded digest; not overwritten — run `pr-hero upgrade` to replace it with the bundled copy";

export interface RegisterMcpOptions {
  readFile?: (path: string) => string | undefined;
  writeFile?: (path: string, content: string) => Promise<void> | void;
  exists?: (path: string) => boolean;
}

export interface RegisterMcpResult {
  registered: boolean;
  alreadyRegistered?: boolean;
  configFile: string;
  error?: string;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function detectAgentEnvironments(
  options: DetectAgentEnvironmentsOptions = {},
): Promise<AgentEnvDetection[]> {
  const home = options.home ?? os.homedir();
  const which = options.which ?? ((bin: string) => Bun.which(bin));
  const exists = options.exists ?? existsSync;

  const results: AgentEnvDetection[] = [];

  // 1. Claude Code
  const claudeBin = await which("claude");
  const claudeDirExists =
    exists(path.join(home, ".claude")) ||
    exists(path.join(home, ".claude.json"));
  if (claudeBin || claudeDirExists) {
    results.push({
      id: "claude",
      displayName: "Claude Code",
      status: "active",
      binaryFound: Boolean(claudeBin),
      binaryPath: claudeBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: path.join(home, ".claude", "skills"),
      mcpConfigFile: path.join(home, ".claude", "mcp.json"),
    });
  }

  // 2. Cursor
  const cursorBin = await which("cursor");
  const cursorDirExists =
    exists(path.join(home, ".cursor")) ||
    exists(path.join(home, ".config", "cursor"));
  if (cursorBin || cursorDirExists) {
    results.push({
      id: "cursor",
      displayName: "Cursor",
      status: "active",
      binaryFound: Boolean(cursorBin),
      binaryPath: cursorBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: path.join(home, ".cursor", "skills"),
      mcpConfigFile: path.join(home, ".cursor", "mcp.json"),
    });
  }

  // 3. Windsurf
  const windsurfBin = await which("windsurf");
  const windsurfDirExists =
    exists(path.join(home, ".windsurf")) ||
    exists(path.join(home, ".codeium", "windsurf"));
  if (windsurfBin || windsurfDirExists) {
    results.push({
      id: "windsurf",
      displayName: "Windsurf",
      status: "active",
      binaryFound: Boolean(windsurfBin),
      binaryPath: windsurfBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: path.join(home, ".windsurf", "skills"),
      mcpConfigFile: path.join(home, ".windsurf", "mcp.json"),
    });
  }

  // 4. Codex
  const codexBin = await which("codex");
  const codexDirExists =
    exists(path.join(home, ".codex")) ||
    exists(path.join(home, ".config", "codex"));
  if (codexBin || codexDirExists) {
    results.push({
      id: "codex",
      displayName: "OpenAI Codex CLI",
      status: "active",
      binaryFound: Boolean(codexBin),
      binaryPath: codexBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: path.join(home, ".codex", "skills"),
      mcpConfigFile: path.join(home, ".codex", "mcp.json"),
    });
  }

  // 5. Antigravity / Gemini
  const agyBin = (await which("antigravity")) || (await which("agy"));
  const agyDirExists =
    exists(path.join(home, ".gemini")) ||
    exists(path.join(home, ".antigravity"));
  if (agyBin || agyDirExists) {
    results.push({
      id: "antigravity",
      displayName: "Antigravity",
      status: "active",
      binaryFound: Boolean(agyBin),
      binaryPath: agyBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: exists(path.join(home, ".gemini", "config", "skills"))
        ? path.join(home, ".gemini", "config", "skills")
        : path.join(home, ".antigravity", "skills"),
      mcpConfigFile: path.join(home, ".antigravity", "mcp.json"),
    });
  }

  // 6. OpenCode
  const opencodeBin = await which("opencode");
  const opencodeDirExists =
    exists(path.join(home, ".opencode")) ||
    exists(path.join(home, ".config", "opencode"));
  if (opencodeBin || opencodeDirExists) {
    results.push({
      id: "opencode",
      displayName: "OpenCode",
      status: "active",
      binaryFound: Boolean(opencodeBin),
      binaryPath: opencodeBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: path.join(home, ".opencode", "skills"),
      mcpConfigFile: path.join(home, ".opencode", "mcp.json"),
    });
  }

  return results;
}

type SkillRole = keyof typeof SKILL_NAMES;

interface BundledSkill {
  role: SkillRole;
  name: string;
  files: Record<string, string>;
}

// The skills this build ships, in sync order, named once for sync and inspect.
// The triage skill is always shipped; the others only when their asset list is
// filled, as an engine build without them must not install an empty dir.
function bundledSkills(assets: EngineAssets): BundledSkill[] {
  const byRole: Record<SkillRole, Record<string, string> | undefined> = {
    triage: assets.triageSkillFiles,
    ciSetup: assets.ciSetupSkillFiles,
    pr: assets.prSkillFiles,
    general: assets.generalSkillFiles,
  };
  const skills: BundledSkill[] = [];
  for (const role of Object.keys(SKILL_NAMES) as SkillRole[]) {
    const files = byRole[role];
    if (!files) continue;
    if (role !== "triage" && Object.keys(files).length === 0) continue;
    skills.push({ role, name: SKILL_NAMES[role], files });
  }
  return skills;
}

interface SkillDirIo {
  exists: (path: string) => boolean;
  readFile: (path: string) => string | undefined;
  unlink?: (path: string) => void;
  rmdir?: (path: string) => void;
  // Delete nothing unless every recorded file still matches its digest. The legacy
  // cleanup needs it: removing the untouched files of an edited skill leaves a
  // SKILL.md that points at files that are gone.
  allOrNothing?: boolean;
}

export interface RemoveSkillDirResult {
  removed: string[];
  skippedModified: string[];
  // Recorded files still on disk because they could not be read or unlinked. Their
  // digest is kept, so a later run can retry them.
  failed: string[];
  errors: string[];
  // False when anything is left in the dir: an edited file, or a copy with no
  // recorded digest. Nothing here ever deletes a dir recursively.
  dirRemoved: boolean;
}

// Removes the files a skill dir's digest.json recorded, but only those still
// equal to their recorded hash; an edited file is skipped and keeps its dir.
// The dir itself goes only if that left it empty (a non-recursive rmdir).
export function removeSkillDir(
  targetDir: string,
  io: SkillDirIo,
): RemoveSkillDirResult {
  const unlink = io.unlink ?? unlinkSync;
  const rmdir = io.rmdir ?? rmdirSync;
  const digestFile = path.join(targetDir, "digest.json");
  const removed: string[] = [];
  const skippedModified: string[] = [];
  const errors: string[] = [];

  let digest: { files?: Record<string, string> } | undefined;
  if (io.exists(digestFile)) {
    try {
      const raw = io.readFile(digestFile);
      if (raw) digest = JSON.parse(raw);
    } catch {
      // Ignored
    }
  }

  let skillSkippedModified = false;
  // Recorded files still on disk after this pass: unreadable, or their unlink failed.
  const failed: string[] = [];
  const subdirs = new Set<string>();
  if (io.allOrNothing && digest?.files) {
    const edited: string[] = [];
    const unreadable: string[] = [];
    for (const [logicalName, hash] of Object.entries(digest.files)) {
      const filePath = path.join(targetDir, logicalName);
      if (!io.exists(filePath)) continue;
      const content = io.readFile(filePath);
      if (content === undefined) unreadable.push(logicalName);
      else if (sha256(content) !== hash) edited.push(logicalName);
    }
    if (edited.length > 0 || unreadable.length > 0) {
      return {
        removed: [],
        skippedModified: edited,
        failed: unreadable,
        errors: [],
        dirRemoved: false,
      };
    }
  }
  if (digest?.files) {
    for (const [logicalName, expectedHash] of Object.entries(digest.files)) {
      const filePath = path.join(targetDir, logicalName);
      if (!io.exists(filePath)) continue;

      const content = io.readFile(filePath);
      if (content === undefined) {
        failed.push(logicalName);
        continue;
      }

      if (sha256(content) === expectedHash) {
        try {
          unlink(filePath);
          removed.push(logicalName);
          for (
            let dir = path.dirname(filePath);
            dir !== targetDir && dir.startsWith(targetDir);
            dir = path.dirname(dir)
          ) {
            subdirs.add(dir);
          }
        } catch (err) {
          failed.push(logicalName);
          errors.push(
            `Failed to remove ${filePath}: ${(err as Error).message}`,
          );
        }
      } else {
        skippedModified.push(logicalName);
        skillSkippedModified = true;
      }
    }
  }

  // The digest goes only once every recorded file is gone: it is the only record that
  // makes a leftover provably removable on a later run.
  if (!skillSkippedModified && failed.length === 0 && io.exists(digestFile)) {
    try {
      unlink(digestFile);
      removed.push("digest.json");
    } catch (err) {
      errors.push(`Failed to remove ${digestFile}: ${(err as Error).message}`);
    }
  }

  // Emptied subdirs (assets/, references/), deepest first, then the skill dir.
  // A non-empty one throws and stays: that is the point of not recursing.
  const dirs = [...subdirs].sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    try {
      rmdir(dir);
    } catch {
      // Not empty: something the digest did not cover is in there.
    }
  }
  let dirRemoved = false;
  try {
    rmdir(targetDir);
    dirRemoved = true;
  } catch {
    // Not empty, or already gone.
  }

  return { removed, skippedModified, failed, errors, dirRemoved };
}

// Every dir name a skill may sit under on disk: current names, then old ones.
// The uninstaller plans from this too, so it cleans both generations.
export function allSkillDirNames(): string[] {
  return [...Object.values(SKILL_NAMES), ...Object.values(LEGACY_SKILL_NAMES)];
}

function legacyKeptReason(res: RemoveSkillDirResult): string {
  const parts: string[] = [];
  if (res.skippedModified.length > 0) {
    parts.push(`edited ${res.skippedModified.join(", ")} kept`);
  }
  if (res.failed.length > 0) {
    parts.push(
      `${res.failed.join(", ")} could not be read or removed (digest kept for a retry)`,
    );
  }
  return parts.length > 0
    ? parts.join("; ")
    : "files with no recorded digest kept";
}

// Decision table for each bundled skill in an agent's skills dir. The disk and
// the digest.json recorded by the last sync decide, file by file:
//
//   file on disk         | recorded digest for the file | action
//   ---------------------+------------------------------+------------------------------------
//   missing              | (any)                        | write it
//   equals the bundle    | (any)                        | nothing to write
//   differs from bundle  | none (no digest recorded)    | keep it: drift-kept unless force
//   differs from bundle  | == disk hash (untouched)     | overwrite it: updated
//   differs from bundle  | != disk hash (user edited)   | keep it: drift-kept unless force
//
// `force` overwrites every differing file. A skill with any kept file is
// drift-kept as a whole and nothing of it is written, so one skill never ends up
// half one version and half another. A skill whose files all match the bundle
// and that has no digest records one (writing only digest.json) and reports
// current; that is how a pre-digest install becomes protected. A kept file never
// gets a digest recorded over it: that would make the user's bytes look like the
// product of a sync, and the next sync would overwrite them.
export async function syncSkills(
  env: AgentEnvDetection,
  assets: EngineAssets,
  options: SyncSkillsOptions = {},
): Promise<SyncSkillsResult> {
  if (!env.skillsDir) {
    return {
      synced: [],
      skills: [],
      errors: ["No skills directory resolved for environment"],
    };
  }

  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });
  const writeFile =
    options.writeFile ??
    ((p: string, c: string) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, c, "utf-8");
    });

  const skillsToSync = bundledSkills(assets);
  const allSynced: string[] = [];
  const allErrors: string[] = [];
  const outcomes: SkillSyncOutcome[] = [];
  let driftDetected = false;

  for (const skill of skillsToSync) {
    const targetDir = path.join(env.skillsDir, skill.name);
    const digestFile = path.join(targetDir, "digest.json");

    // 1. Read existing digest
    let existingDigest:
      | { files?: Record<string, string>; engine_version?: string }
      | undefined;
    if (exists(digestFile)) {
      try {
        const raw = readFile(digestFile);
        if (raw) existingDigest = JSON.parse(raw);
      } catch {
        // Ignored
      }
    }

    // 2. Read upstream assets and check hashes
    const upstreamContents: Record<string, string> = {};
    const upstreamHashes: Record<string, string> = {};

    for (const [logicalName, srcPath] of Object.entries(skill.files)) {
      const content = readFile(srcPath);
      if (content === undefined) {
        return {
          synced: [],
          skills: outcomes,
          errors: [`Missing upstream asset for ${logicalName} at ${srcPath}`],
        };
      }
      upstreamContents[logicalName] = content;
      upstreamHashes[logicalName] = sha256(content);
    }

    // 3. Classify each file by the decision table above
    let toWrite: string[] = [];
    const keptReasons: string[] = [];
    const existed = new Set<string>();
    let fullyCurrent = true;
    for (const [logicalName, upstreamHash] of Object.entries(upstreamHashes)) {
      const destFile = path.join(targetDir, logicalName);
      if (!exists(destFile)) {
        toWrite.push(logicalName);
        fullyCurrent = false;
        continue;
      }

      const diskContent = readFile(destFile);
      if (diskContent === undefined) {
        toWrite.push(logicalName);
        fullyCurrent = false;
        continue;
      }
      existed.add(logicalName);

      const diskHash = sha256(diskContent);
      if (diskHash === upstreamHash) continue;
      fullyCurrent = false;

      // The recorded hash is the disk hash of the last sync: equal means the
      // file was never edited since, so upstream may replace it safely.
      const recordedHash = existingDigest?.files?.[logicalName];
      if (options.force || recordedHash === diskHash) {
        toWrite.push(logicalName);
        continue;
      }

      // A user edit since the last sync, or a copy that was never recorded.
      const reason = existingDigest
        ? `Local edits detected in ${destFile}. Pass force to overwrite.`
        : NO_DIGEST_DRIFT_REASON;
      keptReasons.push(reason);
      allErrors.push(existingDigest ? reason : `${destFile}: ${reason}`);
    }

    // force overwrites everything: a skill that is not already fully current
    // is rewritten whole, the same as before the decision table existed.
    if (options.force && !(fullyCurrent && existingDigest)) {
      toWrite = Object.keys(upstreamHashes);
    }

    if (keptReasons.length > 0) {
      driftDetected = true;
      outcomes.push({
        skill: skill.name,
        status: "drift-kept",
        reason: keptReasons[0],
      });
      continue;
    }

    // 4. Nothing to write: record the digest of a copy that already matches
    if (toWrite.length === 0) {
      if (!existingDigest) {
        const digest = {
          files: upstreamHashes,
          synced_at: new Date().toISOString(),
          engine_version: assets.version,
        };
        await writeFile(digestFile, `${JSON.stringify(digest, null, 2)}\n`);
      }
      outcomes.push({ skill: skill.name, status: "current" });
      continue;
    }

    // 5. Write the files that need it, then the digest
    for (const logicalName of toWrite) {
      await writeFile(
        path.join(targetDir, logicalName),
        upstreamContents[logicalName],
      );
      allSynced.push(logicalName);
    }

    const newDigest = {
      files: upstreamHashes,
      synced_at: new Date().toISOString(),
      engine_version: assets.version,
    };
    await writeFile(digestFile, `${JSON.stringify(newDigest, null, 2)}\n`);
    outcomes.push({
      skill: skill.name,
      status: existed.size === 0 ? "installed" : "updated",
    });
  }

  const upToDate =
    !driftDetected &&
    allSynced.length === 0 &&
    outcomes.every((o) => o.status === "current");

  // An old-name dir goes only once the skill of the same role stands under the
  // new name; while the new copy is kept for the user's edits, the old one
  // keeps serving. Removal is digest-gated, so an edited file survives.
  const standing = new Set(
    outcomes.filter((o) => o.status !== "drift-kept").map((o) => o.skill),
  );
  const legacy: LegacySkillOutcome[] = [];
  for (const skill of skillsToSync) {
    if (!standing.has(skill.name)) continue;
    const legacyName = LEGACY_SKILL_NAMES[skill.role];
    const legacyDir = path.join(env.skillsDir, legacyName);
    if (!exists(legacyDir)) continue;
    const res = removeSkillDir(legacyDir, {
      exists,
      readFile,
      allOrNothing: true,
      ...(options.unlink ? { unlink: options.unlink } : {}),
      ...(options.rmdir ? { rmdir: options.rmdir } : {}),
    });
    allErrors.push(...res.errors);
    legacy.push({
      skill: legacyName,
      status: res.dirRemoved ? "removed" : "kept",
      ...(res.dirRemoved ? {} : { reason: legacyKeptReason(res) }),
    });
  }

  return {
    synced: allSynced,
    skills: outcomes,
    ...(legacy.length > 0 ? { legacy } : {}),
    ...(upToDate ? { upToDate: true } : {}),
    ...(driftDetected ? { driftDetected: true } : {}),
    errors: allErrors,
  };
}

// Reports whether the skills read as synced. A copy without a recorded digest is
// not synced yet (the next sync records it), and a differing copy that is not
// the untouched recorded one is drift: the same rule syncSkills applies.
//
// `legacy` names each pre-rename dir still on disk (sync keeps one the user
// edited), so a leftover is visible; it never changes `synced`.
export function inspectSkillsSync(
  env: AgentEnvDetection,
  assets: EngineAssets,
  options: {
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string | undefined;
  } = {},
): { synced: boolean; drift: boolean; legacy: string[] } {
  const skillsDir = env.skillsDir;
  if (!skillsDir) return { synced: false, drift: false, legacy: [] };
  const exists = options.exists ?? existsSync;
  const legacy = Object.values(LEGACY_SKILL_NAMES).filter((name) =>
    exists(path.join(skillsDir, name)),
  );
  return { ...inspectBundledSkills(env, assets, options), legacy };
}

function inspectBundledSkills(
  env: AgentEnvDetection,
  assets: EngineAssets,
  options: {
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string | undefined;
  },
): { synced: boolean; drift: boolean } {
  if (!env.skillsDir) return { synced: false, drift: false };
  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });

  const skillsToCheck = bundledSkills(assets);
  let everyDigestRecorded = true;
  for (const skill of skillsToCheck) {
    const targetDir = path.join(env.skillsDir, skill.name);
    const digestFile = path.join(targetDir, "digest.json");

    let existingDigest: { files?: Record<string, string> } | undefined;
    if (exists(digestFile)) {
      try {
        const raw = readFile(digestFile);
        if (raw) existingDigest = JSON.parse(raw);
      } catch {
        return { synced: false, drift: false };
      }
    } else {
      everyDigestRecorded = false;
    }

    for (const [logicalName, srcPath] of Object.entries(skill.files)) {
      const destFile = path.join(targetDir, logicalName);
      if (!exists(destFile)) return { synced: false, drift: false };

      const srcContent = readFile(srcPath);
      const destContent = readFile(destFile);
      if (!srcContent || !destContent) return { synced: false, drift: false };

      const diskHash = sha256(destContent);
      const upstreamHash = sha256(srcContent);
      if (diskHash === upstreamHash) continue;

      const recordedHash = existingDigest?.files?.[logicalName];
      if (diskHash !== recordedHash) {
        return { synced: false, drift: true };
      }
      return { synced: false, drift: false };
    }
  }

  return { synced: everyDigestRecorded, drift: false };
}

export async function registerMcpServer(
  env: AgentEnvDetection,
  reg: McpRegistration,
  options: RegisterMcpOptions = {},
): Promise<RegisterMcpResult> {
  if (!env.mcpConfigFile) {
    return {
      registered: false,
      configFile: "",
      error: "No MCP configuration file path resolved for environment",
    };
  }
  if (isNpxCacheInvocation({ command: reg.command, args: reg.args })) {
    return {
      registered: false,
      configFile: env.mcpConfigFile,
      error: NPX_REGISTRATION_REFUSED,
    };
  }

  const configFile = env.mcpConfigFile;
  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });
  const writeFile =
    options.writeFile ??
    ((p: string, c: string) => {
      mkdirSync(path.dirname(p), { recursive: true });
      const tmpPath = `${p}.tmp.${Date.now()}`;
      writeFileSync(tmpPath, c, "utf-8");
      try {
        renameSync(tmpPath, p);
      } catch (err) {
        try {
          if (existsSync(tmpPath)) {
            unlinkSync(tmpPath);
          }
        } catch {
          // ignore cleanup error
        }
        throw err;
      }
    });

  if (exists(configFile)) {
    try {
      const stat = lstatSync(configFile);
      if (stat.isSymbolicLink()) {
        return {
          registered: false,
          configFile,
          error: `Refusing to edit symlinked MCP config file: ${configFile}`,
        };
      }
    } catch {
      // ignore
    }
  }

  let config: {
    mcpServers?: Record<string, Record<string, unknown>>;
  } = {};

  if (exists(configFile)) {
    const raw = readFile(configFile);
    if (raw && raw.trim().length > 0) {
      try {
        config = JSON.parse(raw);
      } catch (err) {
        return {
          registered: false,
          configFile,
          error: `Failed to parse existing MCP config at ${configFile}: ${(err as Error).message}`,
        };
      }
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const current = config.mcpServers[MCP_SERVER_KEY];
  const legacy = config.mcpServers[LEGACY_MCP_SERVER_KEY];
  // A leftover legacy entry is not "already registered": it still has to go.
  if (matchesRegistration(current, reg) && legacy === undefined) {
    return {
      registered: true,
      alreadyRegistered: true,
      configFile,
    };
  }

  // Backup original config if it existed
  if (exists(configFile)) {
    const raw = readFile(configFile);
    if (raw) {
      await writeFile(`${configFile}.bak`, raw);
    }
  }

  // The legacy entry moves to the new key in this one write. Its fields the
  // registration does not own (env, timeout, disabled...) are the user's
  // edits, so they carry over; command and args come from the registration.
  config.mcpServers[MCP_SERVER_KEY] = {
    ...asRecord(legacy),
    ...asRecord(current),
    command: reg.command,
    args: reg.args,
  };
  delete config.mcpServers[LEGACY_MCP_SERVER_KEY];

  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);

  return {
    registered: true,
    configFile,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function matchesRegistration(entry: unknown, reg: McpRegistration): boolean {
  const server = asRecord(entry);
  return (
    server !== undefined &&
    server.command === reg.command &&
    JSON.stringify(server.args) === JSON.stringify(reg.args)
  );
}

// "legacy" is registered and working, but under the pre-rename key; setup
// moves it.
export function inspectMcpRegistration(
  env: AgentEnvDetection,
  reg: McpRegistration,
  options: {
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string | undefined;
  } = {},
): "current" | "legacy" | "missing" {
  if (!env.mcpConfigFile) return "missing";
  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });

  if (!exists(env.mcpConfigFile)) return "missing";
  try {
    const raw = readFile(env.mcpConfigFile);
    if (!raw) return "missing";
    const servers = asRecord(JSON.parse(raw)?.mcpServers);
    // A leftover legacy key next to a matching new one is still a migration to do,
    // exactly as registerMcpServer sees it.
    if (matchesRegistration(servers?.[MCP_SERVER_KEY], reg)) {
      return servers?.[LEGACY_MCP_SERVER_KEY] === undefined
        ? "current"
        : "legacy";
    }
    if (matchesRegistration(servers?.[LEGACY_MCP_SERVER_KEY], reg)) {
      return "legacy";
    }
    return "missing";
  } catch {
    return "missing";
  }
}

// Deletes this server's entry under both its keys (and `extraKey`, a name a
// caller was asked to remove), so an unregister or an uninstall leaves nothing
// of either generation. True when something was removed.
function removeOneMcpServer(config: unknown, key: string): boolean {
  const servers = asRecord(asRecord(config)?.mcpServers);
  if (!servers || !(key in servers)) return false;
  delete servers[key];
  return true;
}

export function removeMcpServerEntries(config: unknown): boolean {
  const servers = asRecord(asRecord(config)?.mcpServers);
  if (!servers) return false;
  let removed = false;
  for (const key of [MCP_SERVER_KEY, LEGACY_MCP_SERVER_KEY]) {
    if (key in servers) {
      delete servers[key];
      removed = true;
    }
  }
  return removed;
}

export interface UnregisterMcpOptions {
  readFile?: (path: string) => string | undefined;
  writeFile?: (path: string, content: string) => Promise<void> | void;
  exists?: (path: string) => boolean;
}

export interface UnregisterMcpResult {
  unregistered: boolean;
  configFile?: string;
  error?: string;
}

// With no name, removes this product's entry under both keys. A caller naming
// another server removes only that one.
export async function unregisterMcpServer(
  env: AgentEnvDetection,
  serverName?: string,
  options: UnregisterMcpOptions = {},
): Promise<UnregisterMcpResult> {
  if (!env.mcpConfigFile) {
    return {
      unregistered: false,
      error: "No MCP config file resolved for environment",
    };
  }

  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });
  const writeFile =
    options.writeFile ??
    ((p: string, c: string) => {
      writeFileSync(p, c, "utf-8");
    });

  if (!exists(env.mcpConfigFile)) {
    return { unregistered: true, configFile: env.mcpConfigFile };
  }

  try {
    const raw = readFile(env.mcpConfigFile);
    if (!raw) return { unregistered: true, configFile: env.mcpConfigFile };
    const config = JSON.parse(raw);
    const removed =
      serverName === undefined ||
      serverName === MCP_SERVER_KEY ||
      serverName === LEGACY_MCP_SERVER_KEY
        ? removeMcpServerEntries(config)
        : removeOneMcpServer(config, serverName);
    if (removed) {
      await writeFile(
        env.mcpConfigFile,
        `${JSON.stringify(config, null, 2)}\n`,
      );
    }
    return { unregistered: true, configFile: env.mcpConfigFile };
  } catch (error) {
    return {
      unregistered: false,
      configFile: env.mcpConfigFile,
      error: `Failed to update MCP config: ${(error as Error).message}`,
    };
  }
}

export interface RemoveSkillsOptions {
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string | undefined;
  unlink?: (path: string) => void;
  rmdir?: (path: string) => void;
}

export interface RemoveSkillsResult {
  removed: string[];
  skippedModified: string[];
  errors: string[];
}

// Removes every bundled skill under its current and its pre-rename name.
export async function removeSkills(
  env: AgentEnvDetection,
  options: RemoveSkillsOptions = {},
): Promise<RemoveSkillsResult> {
  if (!env.skillsDir) {
    return {
      removed: [],
      skippedModified: [],
      errors: ["No skills directory resolved for environment"],
    };
  }

  const exists = options.exists ?? existsSync;
  const io: SkillDirIo = {
    exists,
    readFile:
      options.readFile ??
      ((p: string) => {
        try {
          return readFileSync(p, "utf-8");
        } catch {
          return undefined;
        }
      }),
    unlink: options.unlink,
    rmdir: options.rmdir,
  };

  const result: RemoveSkillsResult = {
    removed: [],
    skippedModified: [],
    errors: [],
  };
  for (const name of allSkillDirNames()) {
    const targetDir = path.join(env.skillsDir, name);
    if (!exists(targetDir)) continue;
    const res = removeSkillDir(targetDir, io);
    result.removed.push(...res.removed);
    result.skippedModified.push(...res.skippedModified);
    result.errors.push(...res.errors);
  }
  return result;
}
