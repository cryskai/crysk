// odd/tasks/openai-profile.md S1: the `profile` key. Person config only, like
// `models`, because it chooses the model and the bill. Absent means the
// fallback profile.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPlatformPerson } from "#ci/platform-config";
import {
  FALLBACK_PROFILE,
  MODEL_PROFILES,
  resolveProfile,
} from "#model/profiles";
import {
  mergeConfig,
  parseGlobalConfig,
  parseLocalConfig,
} from "#review/preflight";
import { loadRunConfig, routingConfigured } from "#review/run";
import { configRows } from "#ui/config";
import { setConfigValue } from "#ui/config-edit";

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

const KNOWN = Object.keys(MODEL_PROFILES).join(", ");

describe("the profile key (S1)", () => {
  test("the person file admits a known profile", () => {
    expect(
      parseGlobalConfig(JSON.stringify({ profile: "claude" })).profile,
    ).toBe("claude");
  });

  test("the platform person layer admits it", () => {
    expect(() =>
      assertPlatformPerson({ profile: "claude" }, "/tmp/config.json"),
    ).not.toThrow();
  });

  test("a repo file may not set it", () => {
    expect(
      messageOf(() => parseLocalConfig(JSON.stringify({ profile: "claude" }))),
    ).toStartWith(".crysk/config.json: profile is a per-person key");
  });

  test("an unknown profile names the known ones", () => {
    expect(
      messageOf(() => parseGlobalConfig(JSON.stringify({ profile: "gemini" }))),
    ).toBe(
      `~/.crysk/config.json profile must be one of ${KNOWN} (got "gemini")`,
    );
  });

  test("a non-string profile is refused", () => {
    expect(
      messageOf(() => parseGlobalConfig(JSON.stringify({ profile: 3 }))),
    ).toBe(`~/.crysk/config.json profile must be one of ${KNOWN}`);
  });

  test("the merge carries it from the person layer with its source", () => {
    const merged = mergeConfig(
      parseGlobalConfig(JSON.stringify({ profile: "claude" })),
      {},
    );
    expect(merged.effective.profile).toBe("claude");
    expect(merged.sources.profile).toBe("global");
  });

  test("absent, the source is default and the fallback profile is active", () => {
    const merged = mergeConfig(undefined, {});
    expect(merged.effective.profile).toBeUndefined();
    expect(merged.sources.profile).toBe("default");
    expect(resolveProfile(merged.effective.profile)).toBe(FALLBACK_PROFILE);
  });

  test("resolveProfile returns the registered profile", () => {
    for (const [id, profile] of Object.entries(MODEL_PROFILES)) {
      expect(resolveProfile(id)).toBe(profile);
    }
  });

  test("crysk config shows the row with its source", () => {
    const merged = mergeConfig(
      parseGlobalConfig(JSON.stringify({ profile: "claude" })),
      {},
    );
    const row = configRows(merged.effective, merged.sources).find(
      (r) => r.key === "profile",
    );
    expect(row).toMatchObject({
      key: "profile",
      value: "claude",
      source: "global",
    });
  });

  test("crysk config edits it in the person file and refuses an unknown value", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "crysk-profile-config-"));
    try {
      await mkdir(path.join(home, ".crysk"));
      await setConfigValue({
        layer: "person",
        key: "profile",
        value: "claude",
        home,
      });
      const written = JSON.parse(
        await readFile(path.join(home, ".crysk", "config.json"), "utf8"),
      );
      expect(written.profile).toBe("claude");
      await expect(
        setConfigValue({
          layer: "person",
          key: "profile",
          value: "gemini",
          home,
        }),
      ).rejects.toThrow(`profile must be one of ${KNOWN} (got "gemini")`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("one source for the run's profile (S3, S5)", () => {
  test("loadRunConfig resolves the person file's profile once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crysk-profile-run-"));
    try {
      await mkdir(path.join(dir, "home", ".crysk"), { recursive: true });
      await mkdir(path.join(dir, "repo"));
      await writeFile(
        path.join(dir, "home", ".crysk", "config.json"),
        JSON.stringify({ profile: "claude" }),
      );
      const run = await loadRunConfig({
        root: path.join(dir, "repo"),
        home: path.join(dir, "home"),
        configFlag: undefined,
        options: {} as never,
        warn: () => {},
      });
      expect(run.config.profile).toBe("claude");
      expect(run.profile).toBe(MODEL_PROFILES.claude as never);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a chosen profile makes a plan that fails to build fatal, like models", () => {
    expect(routingConfigured({})).toBe(false);
    expect(routingConfigured({ profile: "claude" })).toBe(true);
    expect(
      routingConfigured({ models: { default: ["claude:sonnet-latest"] } }),
    ).toBe(true);
  });
});
