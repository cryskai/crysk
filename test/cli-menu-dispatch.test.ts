import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "#review/preflight";
import {
  clearDrawnLines,
  runConfigSubmenu,
  runLifecycleSubmenu,
  runWatcherSubmenu,
} from "#ui/menu";
import type { KeyReader } from "#ui/select";
import { getMenuOptions } from "../src/menu-context";

function fakeReader(chunks: (string | undefined)[]): KeyReader {
  let i = 0;
  return {
    raw: true,
    read: () => Promise.resolve(i < chunks.length ? chunks[i++] : undefined),
    close: () => {},
  };
}

describe("5.3 & 5.4 CLI Menu Dispatch & Dispatch Matrix", () => {
  test("parseArgs parses 'menu' as a valid command", () => {
    const parsed = parseArgs(["menu"]);
    expect(parsed.command).toBe("menu");
  });

  test("configured-repo displays review, activity, and all global items, omitting ledger", () => {
    const items = getMenuOptions({
      kind: "configured-repo",
      root: "/repo",
      name: "repo",
      defaultBase: "main",
    });
    const ids = items.map((i) => i.id);
    expect(ids).toContain("review");
    expect(ids).not.toContain("ledger");
    expect(ids).toContain("activity");
    expect(ids).toContain("watcher");
    expect(ids).toContain("config");
    expect(ids).toContain("doctor");
    expect(ids).toContain("lifecycle");
    expect(ids).toContain("quit");
  });

  test("unconfigured-repo displays init and omits review and ledger", () => {
    const items = getMenuOptions({
      kind: "unconfigured-repo",
      root: "/repo",
      name: "repo",
    });
    const ids = items.map((i) => i.id);
    expect(ids[0]).toBe("init");
    expect(ids).not.toContain("review");
    expect(ids).not.toContain("ledger");
  });

  test("not-a-repo omits init, review, and ledger", () => {
    const items = getMenuOptions({
      kind: "not-a-repo",
      cwd: "/somewhere",
    });
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain("init");
    expect(ids).not.toContain("review");
    expect(ids).not.toContain("ledger");
    expect(ids).toContain("activity");
    expect(ids).toContain("doctor");
  });

  test("lifecycle submenu dispatches upgrade, setup, and uninstall", async () => {
    const dispatched: string[] = [];
    const reader = fakeReader(["\r"]); // 1st option: upgrade

    const exitCode = await runLifecycleSubmenu({
      createReader: () => reader,
      styles: false,
      width: 80,
      dispatch: async (cmd) => {
        dispatched.push(cmd);
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(dispatched).toEqual(["upgrade"]);
  });

  test("watcher submenu offers add only when in repo", async () => {
    const outGlobal: string[] = [];
    const readerGlobal = fakeReader(["q"]);
    await runWatcherSubmenu({
      createReader: () => readerGlobal,
      styles: false,
      width: 80,
      inRepo: false,
      io: {
        write: (t) => outGlobal.push(t),
        line: (t = "") => outGlobal.push(`${t}\n`),
      },
    });
    expect(outGlobal.join("")).not.toContain("Add current repo");

    const outRepo: string[] = [];
    const readerRepo = fakeReader(["q"]);
    await runWatcherSubmenu({
      createReader: () => readerRepo,
      styles: false,
      width: 80,
      inRepo: true,
      io: {
        write: (t) => outRepo.push(t),
        line: (t = "") => outRepo.push(`${t}\n`),
      },
    });
    expect(outRepo.join("")).toContain("Add current repo");
    expect(outRepo.join("")).toContain("Add repo with on-push");
  });

  test("config submenu allows layer selection, editing, and returning back", async () => {
    const tmpHome = path.join(
      os.tmpdir(),
      `prhero-home-test-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpHome, { recursive: true });
    const out: string[] = [];
    // Key sequence:
    // 1. In layer selection: down ('j') to select Global (index 1), then Enter ('\r')
    // 2. In card edit: Right ('l') to increment max_changed_lines, then 'q' to go back to layer selection
    // 3. In layer selection: 'q' to exit submenu and return "back"
    const reader = fakeReader(["j", "\r", "l", "q", "q"]);

    const outcome = await runConfigSubmenu({
      createReader: () => reader,
      styles: false,
      width: 80,
      repoRoot: "/repo",
      home: tmpHome,
      io: {
        write: (t) => out.push(t),
        line: (t = "") => out.push(`${t}\n`),
      },
    });

    expect(outcome).toBe("back");
    const output = out.join("");
    expect(output).toContain("Select Configuration Layer");
    expect(output).toContain("Global Configuration");
  });

  test("config submenu disables repository layer outside git repo", async () => {
    const tmpHome = path.join(
      os.tmpdir(),
      `prhero-home-test-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpHome, { recursive: true });
    const out: string[] = [];
    const reader = fakeReader(["q"]);

    const outcome = await runConfigSubmenu({
      createReader: () => reader,
      styles: false,
      width: 80,
      repoRoot: undefined,
      home: tmpHome,
      io: {
        write: (t) => out.push(t),
        line: (t = "") => out.push(`${t}\n`),
      },
    });

    expect(outcome).toBe("back");
    expect(out.join("")).toContain("disabled outside git repository");
  });

  test("watcher submenu allows editing daily_cap and window via config option", async () => {
    const tmpHome = path.join(
      os.tmpdir(),
      `prhero-home-test-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpHome, { recursive: true });
    const out: string[] = [];
    // Key sequence:
    // 1. In watcher submenu: down ('j') to select "Configure limits & window" (index 1), then Enter ('\r')
    // 2. In watcher config card: 'q' to go back to watcher submenu
    // 3. In watcher submenu: 'q' to return "back"
    const reader = fakeReader(["j", "\r", "q", "q"]);

    const outcome = await runWatcherSubmenu({
      createReader: () => reader,
      styles: false,
      width: 80,
      inRepo: true,
      home: tmpHome,
      io: {
        write: (t) => out.push(t),
        line: (t = "") => out.push(`${t}\n`),
      },
    });

    expect(outcome).toBe("back");
    const output = out.join("");
    expect(output).toContain("Configure limits & window");
    expect(output).toContain("Watcher Daemon Configuration");
  });

  test("config editor saves changes when pressing Enter on [ Save changes ]", async () => {
    const tmpRepo = path.join(
      os.tmpdir(),
      `prhero-menu-test-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRepo, { recursive: true });
    const out: string[] = [];
    // Key sequence:
    // 1. In layer selection: Enter on Repo layer (index 0)
    // 2. In card: Right ('l') to increment max_changed_lines, then navigate down to [ Save changes ] (index 6: 6 fields = 6 'j's from index 0) and press Enter ('\r')
    // 3. 'q' to exit back to layer selection, 'q' to exit submenu
    const reader = fakeReader([
      "\r",
      "j",
      "l",
      "j",
      "j",
      "j",
      "j",
      "j",
      "\r",
      "q",
      "q",
    ]);

    const outcome = await runConfigSubmenu({
      createReader: () => reader,
      styles: false,
      width: 80,
      repoRoot: tmpRepo,
      io: {
        write: (t) => out.push(t),
        line: (t = "") => out.push(`${t}\n`),
      },
    });

    expect(outcome).toBe("back");
    const output = out.join("");
    expect(output).toContain("Saved");
    expect(output).toContain("[ Save changes ]");
    expect(output).toContain("[ Discard & back ]");
    expect(output).toContain("[ Clear all (unset) ]");
  });

  test("config editor restores default values in draft when selecting [ Clear all (unset) ]", async () => {
    const tmpRepo = path.join(
      os.tmpdir(),
      `prhero-menu-test-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRepo, { recursive: true });
    const out: string[] = [];
    // Key sequence:
    // 1. In layer selection: Enter on Repo layer (index 0)
    // 2. In card: navigate down to [ Clear all (unset) ] (index 8: 6 fields + 2 actions before it = index 8) and press Enter ('\r')
    // 3. 'q' to exit back to layer selection, 'q' to exit submenu
    const reader = fakeReader([
      "\r",
      "j",
      "j",
      "j",
      "j",
      "j",
      "j",
      "j",
      "j",
      "\r",
      "q",
      "q",
    ]);

    const outcome = await runConfigSubmenu({
      createReader: () => reader,
      styles: false,
      width: 80,
      repoRoot: tmpRepo,
      io: {
        write: (t) => out.push(t),
        line: (t = "") => out.push(`${t}\n`),
      },
    });

    expect(outcome).toBe("back");
    const output = out.join("");
    expect(output).toContain("Cleared draft overrides to (not set)");
  });

  test("clearDrawnLines emits erase sequences when repaint is true and nothing when false", () => {
    const outStyles: string[] = [];
    clearDrawnLines(
      {
        write: (t) => outStyles.push(t),
        line: (t = "") => outStyles.push(`${t}\n`),
      },
      5,
      true,
    );
    expect(outStyles.join("")).toContain("\x1b[5A");
    expect(outStyles.join("")).toContain("\x1b[2K");

    const outNoStyles: string[] = [];
    clearDrawnLines(
      {
        write: (t) => outNoStyles.push(t),
        line: (t = "") => outNoStyles.push(`${t}\n`),
      },
      5,
      false,
    );
    expect(outNoStyles.length).toBe(0);
  });

  test("review menu dispatch integration loads effectiveConfig and forwards to runReviewMenu", async () => {
    const tmpRepo = path.join(
      os.tmpdir(),
      `prhero-menu-dispatch-test-${Math.random().toString(36).slice(2)}`,
    );
    const tmpHome = path.join(
      os.tmpdir(),
      `prhero-home-dispatch-test-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(path.join(tmpRepo, ".prhero"), { recursive: true });
    mkdirSync(tmpHome, { recursive: true });
    await Bun.write(
      path.join(tmpRepo, ".prhero", "config.json"),
      JSON.stringify({
        default_base: "develop",
        post: true,
      }),
    );

    // Verify runReviewMenu receives the effectiveConfig and initialises correctly
    const { loadEffectiveConfig } = await import("#config/config");
    const { runReviewMenu } = await import("#ui/review-menu");
    const loaded = await loadEffectiveConfig({
      root: tmpRepo,
      home: tmpHome,
    });

    const reader = fakeReader(["j", "j", "j", "j", "j", "j", "\r"]);
    const outcome = await runReviewMenu({
      createReader: () => reader,
      styles: false,
      width: 80,
      effectiveConfig: loaded.effective,
    });

    expect(outcome.action).toBe("launch");
    if (outcome.action === "launch") {
      expect(outcome.options.base).toBe("develop");
      expect(outcome.options.post).toBe(true);
      expect(outcome.options.pr).toBe("current");
    }
  });
});
