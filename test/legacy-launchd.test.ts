import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { retireLegacyAgent } from "../src/legacy-launchd";
import { GC_LAUNCHD_LABEL, gcPlistPath } from "../src/store/gc-preflight";
import { WATCH_LAUNCHD_LABEL } from "../src/watch/preflight";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "crysk-launchd-"));
  mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const plist = (label: string) =>
  path.join(home, "Library", "LaunchAgents", `${label}.plist`);

describe("launchd labels", () => {
  test("the agents are named io.crysk.*", () => {
    expect(WATCH_LAUNCHD_LABEL).toBe("io.crysk.watch");
    expect(GC_LAUNCHD_LABEL).toBe("io.crysk.gc");
    expect(gcPlistPath(home)).toBe(plist("io.crysk.gc"));
  });
});

describe("retireLegacyAgent", () => {
  test("unloads and removes the old io.prhero plist", async () => {
    writeFileSync(plist("io.prhero.watch"), "<plist/>");
    const calls: string[][] = [];
    const lines: string[] = [];
    await retireLegacyAgent({
      home,
      legacyLabel: "io.prhero.watch",
      run: async (cmd) => {
        calls.push(cmd);
        return { ok: true, stderr: "" };
      },
      log: (l) => lines.push(l),
    });
    expect(calls).toEqual([
      ["launchctl", "unload", "-w", plist("io.prhero.watch")],
    ]);
    expect(existsSync(plist("io.prhero.watch"))).toBe(false);
    expect(lines.join("\n")).toContain("io.prhero.watch");
  });

  test("an unload that fails still removes the file", async () => {
    writeFileSync(plist("io.prhero.gc"), "<plist/>");
    await retireLegacyAgent({
      home,
      legacyLabel: "io.prhero.gc",
      run: async () => ({ ok: false, stderr: "not loaded" }),
      log: () => {},
    });
    expect(existsSync(plist("io.prhero.gc"))).toBe(false);
  });

  test("nothing installed under the old label: no launchctl call, no output", async () => {
    const calls: string[][] = [];
    await retireLegacyAgent({
      home,
      legacyLabel: "io.prhero.watch",
      run: async (cmd) => {
        calls.push(cmd);
        return { ok: true, stderr: "" };
      },
      log: () => {
        throw new Error("should not log");
      },
    });
    expect(calls).toEqual([]);
  });
});
