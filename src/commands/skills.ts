// `pr-hero skills install`: the non-interactive twin of the wizard's skills step. It installs
// pr-hero's bundled agent skills (crysk-loop, plus crysk-ci-setup, crysk-pr, and the general crysk
// skill when bundled) into every detected coding agent that has a skills directory, so an agent
// can run it with no TTY. It never registers the MCP server and never touches launchd; the wizard
// still owns those.

import os from "node:os";
import { detectAgentEnvironments, syncSkills } from "../agent-env";
import { resolveEngineAssets } from "../assets";
import type { CliOptions } from "../review/preflight";

export interface SkillsInstallDeps {
  home?: string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string | undefined;
  writeFile?: (path: string, content: string) => Promise<void> | void;
  which?: (binary: string) => string | null | Promise<string | null>;
  log?: (line: string) => void;
}

export async function skillsInstallCommand(
  options: CliOptions,
  deps: SkillsInstallDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const home = deps.home ?? os.homedir();
  const envs = await detectAgentEnvironments({
    home,
    exists: deps.exists,
    which: deps.which,
  });
  const assets = resolveEngineAssets();

  let withSkillsDir = 0;
  let failed = false;
  for (const env of envs) {
    if (!env.skillsDir) continue;
    withSkillsDir += 1;
    const res = await syncSkills(env, assets, {
      exists: deps.exists,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      force: options.force === true,
    });
    // An old-name copy the sync removed, or kept because of the user's edits.
    for (const old of res.legacy ?? []) {
      log(
        old.status === "removed"
          ? `removed the old ${old.skill} skill from ${env.displayName}`
          : `kept the old ${old.skill} skill in ${env.displayName} (${old.reason}); delete it by hand when you no longer need it`,
      );
    }
    if (res.driftDetected && !options.force) {
      failed = true;
      log(
        `local edits found in ${env.displayName}'s pr-hero skills; rerun with --force to overwrite them`,
      );
      continue;
    }
    if (res.errors.length > 0) {
      failed = true;
      for (const message of res.errors) {
        log(`error: ${env.displayName}: ${message}`);
      }
      continue;
    }
    if (res.upToDate) {
      log(`skills already up to date for ${env.displayName}`);
      continue;
    }
    log(
      `installed ${res.synced.length} skill file(s) for ${env.displayName} (${env.skillsDir})`,
    );
  }

  if (withSkillsDir === 0) {
    log(
      "no coding agent with a skills directory was found (Claude Code, Cursor, Windsurf, Codex, Antigravity, OpenCode)",
    );
    return 1;
  }
  return failed ? 1 : 0;
}
