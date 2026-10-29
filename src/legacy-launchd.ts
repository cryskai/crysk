// The pr-hero → Crysk rename renamed the launchd labels (io.prhero.* →
// io.crysk.*). Installing the new agent must not leave the old one running a
// second copy, and uninstalling must not leave it behind, so both call this.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

export const LEGACY_WATCH_LAUNCHD_LABEL = "io.prhero.watch";
export const LEGACY_GC_LAUNCHD_LABEL = "io.prhero.gc";

export function legacyPlistPath(home: string, label: string): string {
  return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

// Unloads (best effort: it may not be loaded) and deletes the old plist.
// Silent when the old agent was never installed.
export async function retireLegacyAgent(input: {
  home: string;
  legacyLabel: string;
  run: (cmd: string[]) => Promise<{ ok: boolean; stderr: string }>;
  log: (line: string) => void;
}): Promise<void> {
  const plist = legacyPlistPath(input.home, input.legacyLabel);
  if (!existsSync(plist)) return;
  await input.run(["launchctl", "unload", "-w", plist]);
  await rm(plist, { force: true });
  input.log(`removed legacy ${input.legacyLabel} agent (${plist})`);
}
