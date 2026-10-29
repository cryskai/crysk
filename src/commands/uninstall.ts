import os from "node:os";
import { resolveRepoRoot } from "#git/git";
import type { CliOptions } from "#review/preflight";
import { log } from "#ui/primitives";
import { executeUninstallPlan, planUninstallation } from "../uninstaller";

export async function uninstallCommand(options: CliOptions): Promise<number> {
  const home = os.homedir();
  const repoRoot = options.repo
    ? await resolveRepoRoot(options.repo).catch(() => undefined)
    : await resolveRepoRoot(process.cwd()).catch(() => undefined);

  const plan = await planUninstallation({
    home,
    purge: options.purge,
    repoRoot,
  });

  if (options.dryRun) {
    log("Planned uninstallation steps (--dry-run):");
    for (const s of [...plan.programSteps, ...plan.dataSteps]) {
      log(`  • ${s.desc}`);
    }
    if (plan.warnings.length > 0) {
      for (const w of plan.warnings) log(`warning: ${w}`);
    }
    return 0;
  }

  const res = await executeUninstallPlan(plan);
  if (!res.ok) {
    for (const err of res.errors) log(`warning: ${err}`);
  }

  log("✓ crysk uninstallation complete.");
  return 0;
}
