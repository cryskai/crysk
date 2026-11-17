import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "#review/preflight";
import {
  cycleStringPreset,
  getEditableLayerEntries,
  renderConfigEditCard,
  renderConfigLayerSelection,
  saveLayerConfig,
  setConfigValue,
  stepNumericValue,
  toggleBooleanValue,
  unsetConfigValue,
} from "#ui/config-edit";

describe("6.1 & 6.2 & 6.3 Interactive Config Editor & Headless Set/Unset", () => {
  const tmpDir = path.join(
    os.tmpdir(),
    `prhero-config-test-${Math.random().toString(36).slice(2)}`,
  );
  const home = path.join(tmpDir, "home");
  const repo = path.join(tmpDir, "repo");

  mkdirSync(path.join(home, ".prhero"), { recursive: true });
  mkdirSync(path.join(repo, ".prhero"), { recursive: true });

  test("renderers produce zero ANSI bytes with styles off", () => {
    const layerLines = renderConfigLayerSelection(
      ["Person", "Team", "Watch"],
      0,
      80,
      false,
    );
    expect(layerLines.join("\n")).not.toContain("\x1b[");

    const editLines = renderConfigEditCard(
      "Person Configuration",
      [{ key: "summary.enabled", value: "true", desc: "Enable AI summary" }],
      0,
      80,
      false,
    );
    expect(editLines.join("\n")).not.toContain("\x1b[");
  });

  test("setConfigValue for Person layer updates ~/.prhero/config.json with 2-space indentation", async () => {
    const personConfigPath = path.join(home, ".prhero", "config.json");
    writeFileSync(personConfigPath, "{}\n");

    const res = await setConfigValue({
      layer: "person",
      key: "max_verification_steps",
      value: "4",
      home,
    });

    expect(res.status).toBe("ok");
    const content = JSON.parse(readFileSync(personConfigPath, "utf-8"));
    expect(content.max_verification_steps).toBe(4);
  });

  test("setConfigValue for Team layer accepts and annotates over-ceiling capped values", async () => {
    const personConfigPath = path.join(home, ".prhero", "config.json");
    const repoConfigPath = path.join(repo, ".prhero", "config.json");
    writeFileSync(
      personConfigPath,
      JSON.stringify({ max_verification_steps: 3 }, null, 2),
    );
    writeFileSync(repoConfigPath, "{}\n");

    const res = await setConfigValue({
      layer: "team",
      key: "max_verification_steps",
      value: "5",
      home,
      repoRoot: repo,
    });

    expect(res.status).toBe("ok");
    expect(res.annotation).toBeDefined();
    expect(res.annotation).toContain("effective value remains 3");

    const content = JSON.parse(readFileSync(repoConfigPath, "utf-8"));
    expect(content.max_verification_steps).toBe(5);

    // Test max_changed_lines capped annotation
    writeFileSync(
      personConfigPath,
      JSON.stringify({ max_changed_lines: 1500 }, null, 2),
    );
    const linesRes = await setConfigValue({
      layer: "team",
      key: "max_changed_lines",
      value: "2500",
      home,
      repoRoot: repo,
    });
    expect(linesRes.status).toBe("ok");
    expect(linesRes.annotation).toContain("effective value remains 1500");

    // Test post capped annotation when person is false and team is set to true
    writeFileSync(personConfigPath, JSON.stringify({ post: false }, null, 2));

    const postRes = await setConfigValue({
      layer: "team",
      key: "post",
      value: "true",
      home,
      repoRoot: repo,
    });
    expect(postRes.status).toBe("ok");
    expect(postRes.annotation).toContain(
      "written: true — your effective value remains false, capped by your Person layer",
    );

    // Test setting post directly on person layer
    await setConfigValue({
      layer: "person",
      key: "post",
      value: "false",
      home,
    });
    const updatedPerson = JSON.parse(readFileSync(personConfigPath, "utf-8"));
    expect("scout" in updatedPerson).toBe(false);
    expect(updatedPerson.post).toBe(false);
  });

  test("setConfigValue for Team layer fails when repoRoot is missing", async () => {
    expect(
      setConfigValue({
        layer: "team",
        key: "default_base",
        value: "develop",
        home,
      }),
    ).rejects.toThrow(
      "cannot edit team configuration outside a git repository",
    );
  });

  test("setConfigValue for Watcher layer parses window 'HH:MM-HH:MM' and daily_cap", async () => {
    const watchConfigPath = path.join(home, ".prhero", "watch.json");
    writeFileSync(watchConfigPath, "{}\n");

    await setConfigValue({
      layer: "watch",
      key: "daily_cap",
      value: "10",
      home,
    });
    await setConfigValue({
      layer: "watch",
      key: "window",
      value: "09:00-18:00",
      home,
    });

    const content = JSON.parse(readFileSync(watchConfigPath, "utf-8"));
    expect(content.daily_cap).toBe(10);
    expect(content.window).toEqual({ start: "09:00", end: "18:00" });
  });

  test("unsetConfigValue removes key with 2-space indentation write-back", async () => {
    const watchConfigPath = path.join(home, ".prhero", "watch.json");
    writeFileSync(
      watchConfigPath,
      JSON.stringify(
        { daily_cap: 10, window: { start: "09:00", end: "18:00" } },
        null,
        2,
      ),
    );

    await unsetConfigValue({
      layer: "watch",
      key: "window",
      home,
    });

    const content = JSON.parse(readFileSync(watchConfigPath, "utf-8"));
    expect(content.window).toBeUndefined();
    expect(content.daily_cap).toBe(10);

    // Unset scout and post on person layer
    const personConfigPath = path.join(home, ".prhero", "config.json");
    writeFileSync(
      personConfigPath,
      JSON.stringify(
        { scout: true, post: false, max_verification_steps: 4 },
        null,
        2,
      ),
    );
    await unsetConfigValue({
      layer: "person",
      key: "scout",
      home,
    });
    await unsetConfigValue({
      layer: "person",
      key: "post",
      home,
    });
    const updatedPerson = JSON.parse(readFileSync(personConfigPath, "utf-8"));
    expect(updatedPerson.scout).toBeUndefined();
    expect(updatedPerson.post).toBeUndefined();
    expect(updatedPerson.max_verification_steps).toBe(4);
  });

  test("parseArgs parses config set and unset with flags", () => {
    const parsedSet = parseArgs([
      "config",
      "set",
      "summary.model",
      "claude-3-opus",
      "--person",
    ]);
    expect(parsedSet.command).toBe("config");
    expect(parsedSet.options.configSubcommand).toBe("set");
    expect(parsedSet.options.configKey).toBe("summary.model");
    expect(parsedSet.options.configValue).toBe("claude-3-opus");
    expect(parsedSet.options.configLayer).toBe("person");

    const parsedUnset = parseArgs(["config", "unset", "window", "--watch"]);
    expect(parsedUnset.command).toBe("config");
    expect(parsedUnset.options.configSubcommand).toBe("unset");
    expect(parsedUnset.options.configKey).toBe("window");
    expect(parsedUnset.options.configLayer).toBe("watch");
  });

  describe("Phase 2: Renderers & Mutation Helpers", () => {
    test("getEditableLayerEntries returns only scalar editable keys and omits complex arrays", () => {
      const repoData = {
        default_base: "main",
        max_changed_lines: 1500,
        max_changed_files: 150,
        max_verification_steps: 8,
        summary: { enabled: true },
        post: false,
        parity_trigger_paths: ["**/foo/**"],
        suspicion_priors: [{ path: "a.ts", weight: 3, reason: "hot" }],
      };
      const entries = getEditableLayerEntries("team", repoData);
      const keys = entries.map((e) => e.key);
      expect(keys).toEqual([
        "default_base",
        "max_changed_lines",
        "max_changed_files",
        "max_verification_steps",
        "summary.enabled",
        "post",
      ]);
      expect(keys).not.toContain("scout");
      expect(keys).not.toContain("parity_trigger_paths");
      expect(keys).not.toContain("suspicion_priors");
      expect(keys).not.toContain("summary.model");
      expect(entries.find((e) => e.key === "summary.enabled")?.value).toBe(
        "[✓] true",
      );
      expect(entries.find((e) => e.key === "post")?.value).toBe("[ ] false");

      const personData = {
        max_changed_lines: 2000,
        summary: { enabled: false },
        post: true,
      };
      const personEntries = getEditableLayerEntries("person", personData);
      expect(personEntries.map((e) => e.key)).toEqual([
        "max_changed_lines",
        "max_changed_files",
        "max_verification_steps",
        "summary.enabled",
        "post",
      ]);
      expect(
        personEntries.find((e) => e.key === "max_changed_lines")?.value,
      ).toBe("2000");
      expect(
        personEntries.find((e) => e.key === "summary.enabled")?.value,
      ).toBe("[ ] false");
      expect(personEntries.find((e) => e.key === "post")?.value).toBe(
        "[✓] true",
      );
      expect(
        personEntries.find((e) => e.key === "max_verification_steps")?.value,
      ).toBe("(not set)");

      const watchData = {
        daily_cap: 15,
        window: { start: "08:00", end: "20:00" },
      };
      const watchEntries = getEditableLayerEntries("watch", watchData);
      expect(watchEntries.map((e) => e.key)).toEqual(["daily_cap", "window"]);
      expect(watchEntries.find((e) => e.key === "daily_cap")?.value).toBe("15");
      expect(watchEntries.find((e) => e.key === "window")?.value).toBe(
        "08:00-20:00",
      );
    });

    test("stepNumericValue steps with delta and clamps to min", () => {
      expect(stepNumericValue(1500, 250, 0)).toBe(1750);
      expect(stepNumericValue(1500, -250, 0)).toBe(1250);
      expect(stepNumericValue(100, -250, 0)).toBe(0);
      expect(stepNumericValue(0, -250, 0)).toBe(0);
      expect(stepNumericValue(8, 1, 0)).toBe(9);
      expect(stepNumericValue(0, -1, 0)).toBe(0);
    });

    test("toggleBooleanValue alternates boolean", () => {
      expect(toggleBooleanValue(true)).toBe(false);
      expect(toggleBooleanValue(false)).toBe(true);
    });

    test("cycleStringPreset cycles presets in order", () => {
      const presets = ["main", "master", "develop"] as const;
      expect(cycleStringPreset("main", presets)).toBe("master");
      expect(cycleStringPreset("master", presets)).toBe("develop");
      expect(cycleStringPreset("develop", presets)).toBe("main");
      expect(cycleStringPreset("unknown", presets)).toBe("main");
    });

    test("renderConfigEditCard renders title, entries, cursor and annotation", () => {
      const lines = renderConfigEditCard(
        "Repository Configuration (.prhero/config.json)",
        [
          {
            key: "default_base",
            value: "main",
            desc: "Default base branch",
            type: "string",
          },
          {
            key: "max_changed_lines",
            value: "1500",
            desc: "Line budget",
            type: "number",
          },
        ],
        0,
        100,
        false,
        "written: 2500 — your effective value remains 1500, capped by Person layer",
      );
      expect(lines.join("\n")).not.toContain("\x1b[");
      expect(lines.join("\n")).toContain("Repository Configuration");
      expect(lines.join("\n")).toContain("default_base");
      expect(lines.join("\n")).toContain("capped by Person layer");
      expect(lines.join("\n")).toContain("[ Save changes ]");
      expect(lines.join("\n")).toContain("[ Discard & back ]");
      expect(lines.join("\n")).toContain("[ Clear all (unset) ]");
    });

    test("saveLayerConfig writes entire draft to target file with 2-space indentation", async () => {
      const personConfigPath = path.join(home, ".prhero", "config.json");
      const draft = {
        max_changed_lines: 2500,
        max_changed_files: 200,
        summary: { enabled: true },
      };

      const res = await saveLayerConfig({
        layer: "person",
        draft,
        home,
      });

      expect(res.status).toBe("ok");
      const content = JSON.parse(readFileSync(personConfigPath, "utf-8"));
      expect(content).toEqual(draft);
    });
  });
});
