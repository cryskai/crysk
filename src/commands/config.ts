import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEffectiveConfig, resolveOptionalRepoRoot } from "#config/config";
import type { CliOptions } from "#review/preflight";
import { renderConfig } from "#ui/config";
import {
  runConfigEditor,
  setConfigValue,
  unsetConfigValue,
} from "#ui/config-edit";
import { log, styleEnabled, terminalWidth } from "#ui/primitives";
import { resolveRepoDir } from "../brand-paths";
import { CliError } from "../errors";

// `pr-hero config` (C5 O-12 / D10 / §3.10) — read-only, $0, and deliberately
// the thinnest shell in this file: resolve the two layers through the SAME
// loadEffectiveConfig a review takes, hand the result to a pure renderer,
// print. Every decision it could get wrong lives in mergeConfig, which is
// already the engine's; re-deriving anything here is how the command that
// explains the config starts disagreeing with the config.
//
// It never writes either file. Editing config from menus is distribution
// pillar 2 (§3.10, "Not in scope"), and a command an operator runs to
// UNDERSTAND their setup must be safe to run without reading its flags first.
//
// stdout, like `ledger` and `usage`: the listing IS this command's product,
// so it stays pipeable. Everything human-facing elsewhere in this CLI goes to
// stderr via log(), which is what reserves the channel — and the style flag is
// therefore sniffed off stdout, the stream actually being written.
export async function configCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveOptionalRepoRoot(options);

  if (options.configSubcommand === "edit") {
    return await runConfigEditor({
      home: os.homedir(),
      repoRoot,
      styles: styleEnabled(process.stderr),
      width: terminalWidth(),
    });
  }

  if (options.configSubcommand === "set") {
    if (!options.configKey || !options.configValue) {
      throw new CliError("config set requires a key and value");
    }
    const layer = options.configLayer ?? "person";
    const res = await setConfigValue({
      layer,
      key: options.configKey,
      value: options.configValue,
      home: os.homedir(),
      repoRoot,
    });
    if (res.annotation) {
      log(res.annotation);
    } else {
      log(`✓ Updated ${layer} configuration (${options.configKey}).`);
    }
    return 0;
  }

  if (options.configSubcommand === "unset") {
    if (!options.configKey) {
      throw new CliError("config unset requires a key");
    }
    const layer = options.configLayer ?? "person";
    await unsetConfigValue({
      layer,
      key: options.configKey,
      home: os.homedir(),
      repoRoot,
    });
    log(`✓ Removed ${options.configKey} from ${layer} configuration.`);
    return 0;
  }
  const loaded = await loadEffectiveConfig({
    root: repoRoot,
    home: os.homedir(),
    configFlag: options.config,
  });
  const lines = renderConfig({
    effective: loaded.effective,
    sources: loaded.sources,
    repoConfigPath: repoRoot
      ? loaded.repoConfigPath
      : path.join(resolveRepoDir(process.cwd()), "config.json"),
    // Not carried on EffectiveConfig: the review path has no use for it (an
    // absent repo file is simply an absent layer), and widening a type six
    // callers share to serve one renderer is how shared shapes rot.
    repoPresent: repoRoot ? existsSync(loaded.repoConfigPath) : false,
    globalConfigPath: loaded.globalConfigPath,
    globalPresent: loaded.globalPresent,
    styles: styleEnabled(process.stdout),
    width: terminalWidth(),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
