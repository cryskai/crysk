import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { engineIdentity } from "#git/identity";
import { localReviewSpec } from "#review/preflight";
import {
  deriveEngineIdentity,
  resolveEngineAssets,
  selfInvocation,
} from "../src/assets";

describe("resolveEngineAssets", () => {
  test("returns populated assets in dev mode with existing paths", () => {
    const assets = resolveEngineAssets();
    expect(assets.mode).toBe("dev");
    expect(assets.version).toBeDefined();
    expect(assets.version.length).toBeGreaterThan(0);

    // Scout and summarizer paths exist
    expect(existsSync(assets.scoutPromptPath)).toBe(true);
    expect(existsSync(assets.summarizerPromptPath)).toBe(true);

    // Bundled agent files all exist on disk
    expect(Object.keys(assets.bundledAgentFiles).length).toBe(6);
    for (const [logicalName, filePath] of Object.entries(
      assets.bundledAgentFiles,
    )) {
      expect(typeof logicalName).toBe("string");
      expect(existsSync(filePath)).toBe(true);
    }

    // Triage skill files all exist on disk
    expect(Object.keys(assets.triageSkillFiles).length).toBe(2);
    for (const [logicalName, filePath] of Object.entries(
      assets.triageSkillFiles,
    )) {
      expect(typeof logicalName).toBe("string");
      expect(existsSync(filePath)).toBe(true);
    }

    // CI setup skill files all exist on disk. The OpenCode operator
    // procedure and admission refs must ship with SKILL.md so wizard
    // sync does not tell agents to read files that were never copied.
    expect(Object.keys(assets.ciSetupSkillFiles).sort()).toEqual(
      [
        "SKILL.md",
        "assets/admission-config.example.json",
        "assets/workflow.yml",
        "references/ci-admission.md",
        "references/opencode-ci.md",
      ].sort(),
    );
    for (const [logicalName, filePath] of Object.entries(
      assets.ciSetupSkillFiles,
    )) {
      expect(typeof logicalName).toBe("string");
      expect(existsSync(filePath)).toBe(true);
    }

    // defaultAgentsDir is populated in dev mode and points to existing directory
    expect(assets.defaultAgentsDir).toBeDefined();
    expect(existsSync(assets.defaultAgentsDir ?? "")).toBe(true);
  });

  test("manifest <-> prompts/default/ parity (build-time bidirectional check)", () => {
    const assets = resolveEngineAssets();
    const defaultDir = path.resolve(import.meta.dir, "../prompts/default");
    expect(existsSync(defaultDir)).toBe(true);

    const onDiskEntries = readdirSync(defaultDir).filter((file) => {
      // PROVENANCE.md and directories or non-md files are not agent files
      return file.endsWith(".md") && file !== "PROVENANCE.md";
    });

    const manifestEntries = Object.keys(assets.bundledAgentFiles);

    // Assert parity in both directions
    const missingInManifest = onDiskEntries.filter(
      (f) => !manifestEntries.includes(f),
    );
    const missingOnDisk = manifestEntries.filter(
      (f) => !onDiskEntries.includes(f),
    );

    expect(missingInManifest).toEqual([]);
    expect(missingOnDisk).toEqual([]);
    expect(manifestEntries.sort()).toEqual(onDiskEntries.sort());
  });

  test("manifest-loaded set satisfies localReviewSpec() (all six logical names, nothing extra)", () => {
    const assets = resolveEngineAssets();
    const spec = localReviewSpec();
    const specFiles = spec.agents.map((a) => a.file).sort();
    const manifestFiles = Object.keys(assets.bundledAgentFiles).sort();

    expect(manifestFiles).toEqual(specFiles);
  });
});

describe("selfInvocation", () => {
  test("returns absolute bun binary and absolute cli.ts in dev mode", () => {
    const inv = selfInvocation();
    expect(inv.command).toBe(process.execPath);
    expect(path.isAbsolute(inv.command)).toBe(true);
    expect(inv.args).toHaveLength(1);
    expect(inv.args[0]).toBe(path.resolve(import.meta.dir, "../src/cli.ts"));
    expect(existsSync(inv.args[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C4 O-0 — the engine identity has to be able to change
// ---------------------------------------------------------------------------

describe("deriveEngineIdentity", () => {
  test("carries the revision so two engines are distinguishable", () => {
    // The reason this obligation exists: `version` is read from package.json,
    // which has said 0.1.0 since the scaffold commit. Every run this engine
    // ever wrote reports the same engine, so an artifact could not tell a
    // pre-C4 review from a post-C4 one — and the Martian baseline is ratified
    // as valid across engine versions only on condition the frontier is
    // annotated. A field that never changes annotates nothing.
    expect(
      deriveEngineIdentity(
        { name: "pr-hero", version: "1.0.0" },
        { ok: true, stdout: "961acef\n" },
      ),
    ).toEqual({ name: "pr-hero", version: "1.0.0", revision: "961acef" });
  });

  test("omits revision rather than inventing one when git cannot answer", () => {
    // A tarball install or a checkout without git still has to run a review.
    // Refusing to start over a provenance string would trade a paid review for
    // a field, and "unknown" would be a value that sorts and compares like a
    // real commit.
    expect(
      deriveEngineIdentity(
        { name: "pr-hero", version: "1.0.0" },
        { ok: false, stdout: "" },
      ),
    ).toEqual({ name: "pr-hero", version: "1.0.0" });
  });

  test("treats an empty stdout on a zero exit as no revision", () => {
    // git can exit 0 and say nothing. An empty `revision: ""` in an artifact
    // reads as a commit whose name is the empty string.
    expect(
      deriveEngineIdentity(
        { name: "pr-hero", version: "1.0.0" },
        {
          ok: true,
          stdout: "  \n",
        },
      ).revision,
    ).toBeUndefined();
  });

  test("falls back on a package.json missing its own fields", () => {
    expect(deriveEngineIdentity({}, { ok: false, stdout: "" })).toEqual({
      name: "pr-hero",
      version: "0.0.0",
    });
  });
});

// The compiled binary's half of C4 O-0. `detectAssetMode()` reads
// `import.meta.dir`, which under `bun test` always reports "dev", so the
// compiled branch is unreachable without injecting the assets — which is
// exactly how a binary that died with `ENOENT: /$bunfs/package.json` on
// every `upgrade` walked past the whole suite.
describe("engineIdentity", () => {
  const assets = resolveEngineAssets();

  test("compiled mode takes the baked version and names no revision", async () => {
    // The revision assertion is the one that proves the spawn was SKIPPED
    // rather than merely tolerated: this checkout is a git repository, so a
    // compiled branch that still shelled out would come back with a real sha.
    expect(
      await engineIdentity({
        ...assets,
        mode: "compiled",
        version: "9.9.9-baked",
      }),
    ).toEqual({ name: "pr-hero", version: "9.9.9-baked" });
  });

  test("the version is the assets' version, never a second package.json read", async () => {
    const identity = await engineIdentity({ ...assets, version: "1.2.3-seam" });
    expect(identity.name).toBe("pr-hero");
    expect(identity.version).toBe("1.2.3-seam");
  });
});
