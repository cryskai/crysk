import os from "node:os";
import { activityCommand } from "#commands/activity";
import { doctorCommand } from "#commands/doctor";
import { init } from "#commands/init";
import { uninstallCommand } from "#commands/uninstall";
import { upgradeCommand } from "#commands/upgrade";
import { loadEffectiveConfig } from "#config/config";
import { resolveRepoRoot } from "#git/git";
import type { CliOptions, LocalConfig } from "#review/preflight";
import { review } from "#review/review";
import {
  runConfigSubmenu,
  runLifecycleSubmenu,
  runMenuLoop,
  runWatcherSubmenu,
} from "#ui/menu";
import { styleEnabled, terminalWidth } from "#ui/primitives";
import { runReviewMenu } from "#ui/review-menu";
import { watchCommand } from "#watch/watch";
import { resolveMenuContext } from "../menu-context";
import { runWizard } from "../wizard";

export async function menuCommand(options: CliOptions): Promise<number> {
  const repoRoot = options.repo
    ? await resolveRepoRoot(options.repo).catch(() => undefined)
    : await resolveRepoRoot(process.cwd()).catch(() => undefined);
  const context = await resolveMenuContext(repoRoot ?? process.cwd());

  return await runMenuLoop({
    context,
    styles: styleEnabled(process.stderr),
    width: terminalWidth(),
    dispatchAction: async (action) => {
      switch (action) {
        case "review": {
          let effectiveConfig: LocalConfig | undefined;
          if (repoRoot) {
            try {
              const loaded = await loadEffectiveConfig({
                root: repoRoot,
                home: os.homedir(),
                configFlag: options.config,
              });
              effectiveConfig = loaded.effective;
            } catch {
              // ignore
            }
          }
          const res = await runReviewMenu({
            styles: styleEnabled(process.stderr),
            width: terminalWidth(),
            effectiveConfig,
            defaultBase:
              context.kind === "configured-repo"
                ? context.defaultBase
                : undefined,
          });
          if (res.action === "launch") {
            return await review(res.options);
          }
          return "back";
        }
        case "init": {
          return await init(options);
        }
        case "activity": {
          return await activityCommand(options);
        }
        case "doctor": {
          return await doctorCommand(options);
        }
        case "config": {
          return await runConfigSubmenu({
            styles: styleEnabled(process.stderr),
            width: terminalWidth(),
            repoRoot: repoRoot ?? undefined,
            home: os.homedir(),
          });
        }
        case "watcher": {
          return await runWatcherSubmenu({
            styles: styleEnabled(process.stderr),
            width: terminalWidth(),
            inRepo: context.kind !== "not-a-repo",
            home: os.homedir(),
            dispatch: async (subcmd) => {
              if (subcmd === "status")
                return await watchCommand({ ...options, watch: "status" });
              if (subcmd === "install")
                return await watchCommand({ ...options, watch: "install" });
              if (subcmd === "uninstall")
                return await watchCommand({ ...options, watch: "uninstall" });
              if (subcmd === "add")
                return await watchCommand({ ...options, watch: "add" });
              if (subcmd === "add-on-push")
                return await watchCommand({
                  ...options,
                  watch: "add",
                  onPush: true,
                });
              if (subcmd === "remove")
                return await watchCommand({ ...options, watch: "remove" });
              return 0;
            },
          });
        }
        case "lifecycle": {
          return await runLifecycleSubmenu({
            styles: styleEnabled(process.stderr),
            width: terminalWidth(),
            dispatch: async (subcmd) => {
              if (subcmd === "upgrade") return await upgradeCommand(options);
              if (subcmd === "setup")
                return await runWizard({ cwd: repoRoot ?? process.cwd() });
              if (subcmd === "uninstall")
                return await uninstallCommand(options);
              return 0;
            },
          });
        }
        case "quit": {
          return 0;
        }
        default:
          return 0;
      }
    },
  });
}
