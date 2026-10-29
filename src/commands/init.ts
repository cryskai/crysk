import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadGlobalConfigLayer } from "#config/config";
import { remoteHeadRef, resolveRepoRoot } from "#git/git";
import { resolveBaseRef } from "#git/refs";
import {
  BUNDLED_AGENTS_DIR_LABEL,
  type CliOptions,
  GOTCHAS_TEMPLATE,
  initConfigTemplate,
  initGitReminder,
  initGotchasInstructions,
  initTemplateOmissions,
} from "#review/preflight";
import { log } from "#ui/primitives";
import { readBrandEnv } from "../brand";
import { resolveRepoDir } from "../brand-paths";

// `pr-hero init` — the other half of making `pr-hero review` a zero-flag
// command. It writes the two files local mode looks for and nothing else, and
// it never overwrites: a config or a gotchas file already on disk is the
// user's work, and the whole value of gotchas is that a human wrote them.
export async function init(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepoRoot(options.repo);
  const dir = resolveRepoDir(repoRoot);
  await mkdir(dir, { recursive: true });

  // NOT resolveAgentsDirSetting: that one is the review-time precedence
  // (flag > config > env) and it throws when nothing is set. init has no
  // config to read yet — it is writing one — and a missing prompt set must
  // still produce a usable scaffold. When no flag or env is given, agents_dir
  // is omitted entirely so the repo uses the engine's bundled default.
  const agentsFromEnv = readBrandEnv(process.env, "AGENTS_DIR");
  const agentsSeed = options.agents
    ? { dir: path.resolve(options.agents), source: "--agents" }
    : agentsFromEnv?.value
      ? { dir: path.resolve(agentsFromEnv.value), source: agentsFromEnv.name }
      : undefined;
  const baseSeed = resolveBaseRef({
    flag: options.base,
    remoteHead: await remoteHeadRef(repoRoot),
  });

  // C5 O-9. The global file is read but never written: init scaffolds the TEAM
  // file, and the person/capped keys the global already supplies are left OUT
  // of it. Without this the command ships the duplication C5 exists to delete
  // — §0.5 measured three byte-identical configs on one machine, all three
  // restating the same agents_dir and summary block.
  const { filePath: globalConfigPath, layer: globalLayer } =
    await loadGlobalConfigLayer(os.homedir());
  const templateInput = {
    ...(agentsSeed === undefined ? {} : { agentsDir: agentsSeed.dir }),
    defaultBase: baseSeed.ref,
    ...(globalLayer === undefined ? {} : { global: globalLayer }),
    agentsDirFromFlag: options.agents !== undefined,
  };
  const omitted = initTemplateOmissions(templateInput);

  // `repoConfigPath`, not `configPath`: C5 put a second config.json under
  // ~/.prhero/, and a bare `configPath` in a codebase where PrheroLayout
  // deliberately retired that name (home-preflight.ts) is the same ambiguity
  // the retirement exists to delete. `init` writes the TEAM file and only the
  // team file — the global layer is the operator's own, and scaffolding it
  // from inside a repo would be this command reaching outside its checkout.
  const repoConfigPath = path.join(dir, "config.json");
  const gotchasPath = path.join(dir, "gotchas.md");
  const wrote: string[] = [];
  const kept: string[] = [];
  for (const [file, contents] of [
    [repoConfigPath, initConfigTemplate(templateInput)],
    [gotchasPath, GOTCHAS_TEMPLATE],
  ] as const) {
    if (existsSync(file)) {
      kept.push(file);
      continue;
    }
    await Bun.write(file, contents);
    wrote.push(file);
  }

  log(`crysk init — ${dir}`);
  log();
  for (const file of wrote) log(`  wrote  ${file}`);
  for (const file of kept) log(`  kept   ${file} (already exists, untouched)`);
  log();
  // The seed line has to follow the FILE, not the seed: a scaffold that
  // omitted agents_dir while the terminal still reported "agents_dir <path>
  // (from the suggested clean set)" would send the reader looking for a line
  // that is not in the file they were just told was written.
  log(
    omitted.agentsDir
      ? globalLayer?.agents_dir
        ? `  agents_dir    ${globalLayer.agents_dir} (from ${globalConfigPath})`
        : `  agents_dir    ${BUNDLED_AGENTS_DIR_LABEL}`
      : `  agents_dir    ${agentsSeed?.dir} (from ${agentsSeed?.source})`,
  );
  log(`  default_base  ${baseSeed.ref} (from ${baseSeed.source})`);
  if (omitted.keys.length > 0) {
    log();
    log(
      `  Left out of ${repoConfigPath}: ${omitted.keys.join(", ")} — ` +
        `${globalConfigPath} already supplies ${
          omitted.keys.length === 1 ? "that key" : "those keys"
        }, and restating them here is the duplication the global layer ` +
        "exists to delete.",
    );
  }
  log();
  // Unconditional on purpose, and NOT "consistency-fixed" below: this is
  // advice ("commit the config dir or ignore it"), true in every state this command
  // can leave the repo in. It asserts nothing about the contents of a file.
  log(initGitReminder(path.basename(dir)));
  log();
  // The block that follows DOES assert file contents, and the write above is
  // skipped whenever the file already exists — so it is a function of which of
  // `wrote`/`kept` the gotchas file landed in, never a constant. Printed
  // unconditionally it told a repo with real gotchas to delete a marker line
  // that is not in its file. When the file was kept, the only honest source
  // for what to say about it is the gate itself, over the bytes on disk.
  const gotchasOutcome = wrote.includes(gotchasPath)
    ? ({ written: true } as const)
    : ({
        written: false,
        // `.catch("")`: the file was on disk a moment ago — that is why it was
        // kept — and a read that loses that race must not turn `init` into a
        // crash. An empty read renders the "empty" arm, which is the correct
        // advice for a file that is no longer there.
        contents: await Bun.file(gotchasPath)
          .text()
          .catch(() => ""),
      } as const);
  const dirName = path.basename(dir);
  for (const line of initGotchasInstructions(gotchasOutcome, dirName)) {
    log(line);
  }
  return 0;
}
