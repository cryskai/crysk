// S8 of odd/tasks/remove-scout-parity.md: the parity hunter left the product,
// and nothing a user already has stops working. The config key, the
// `models.hunter.parity` role and a leftover `deep-review-parity.md` in a custom
// prompt directory are accepted, have no effect, and warn exactly once; `config
// set` refuses the key. The lab keeps working: `defaultReviewSpec()` still
// carries the conditional hunter, and old documents still validate. The tail of
// every message is quoted by the changelog, so it is asserted verbatim.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPlatformPerson } from "#ci/platform-config";
import { loadEffectiveConfig } from "#config/config";
import { FALLBACK_PROFILE } from "#model/profiles";
import { buildResolvedRoutePlan, InvalidModelError } from "#model/routing";
import {
  type Finding,
  type FindingsDocument,
  SCHEMA_VERSION,
  validateFindingsDocument,
} from "#review/findings";
import { runPipeline } from "#review/pipeline";
import {
  agentsDirProblems,
  CONFIG_DIRECTION,
  initConfigTemplate,
  localReviewSpec,
  mergeConfig,
  parseGlobalConfig,
  parseLocalConfig,
} from "#review/preflight";
import { resolvePromptSet } from "#review/run";
import { defaultReviewSpec, validateReviewSpec } from "#review/spec";
import type { StepResult, StepSpec } from "#review/step-runner";
import { configRows } from "#ui/config";
import { setConfigValue, unsetConfigValue } from "#ui/config-edit";
import { BUNDLED_AGENT_FILES } from "../src/asset-manifest";
import { CliError } from "../src/errors";

const TAIL = "is ignored: the parity hunter was removed";

describe("the config key", () => {
  test("a repo file's parity_trigger_paths is accepted, dropped, and warned about once, naming the file", () => {
    const warnings: string[] = [];
    const layer = parseLocalConfig(
      JSON.stringify({
        parity_trigger_paths: ["src/auth/**"],
        default_base: "main",
      }),
      ".crysk/config.json",
      warnings,
    );
    expect(layer).toEqual({ default_base: "main" });
    expect(warnings).toEqual([
      `.crysk/config.json: parity_trigger_paths ${TAIL}`,
    ]);
  });

  test("a person file's parity_trigger_paths is ignored too, not sent to the repo config", () => {
    const warnings: string[] = [];
    const layer = parseGlobalConfig(
      JSON.stringify({
        parity_trigger_paths: ["src/**"],
        max_changed_lines: 10,
      }),
      "~/.crysk/config.json",
      warnings,
    );
    expect("parity_trigger_paths" in layer).toBe(false);
    expect(layer.max_changed_lines).toBe(10);
    expect(warnings).toEqual([
      `~/.crysk/config.json: parity_trigger_paths ${TAIL}`,
    ]);
  });

  test("a value the old parser refused is ignored too", () => {
    for (const value of ["yes", 3, [""], null, []]) {
      const warnings: string[] = [];
      const layer = parseLocalConfig(
        JSON.stringify({ parity_trigger_paths: value }),
        "f.json",
        warnings,
      );
      expect(layer).toEqual({});
      expect(warnings).toEqual([`f.json: parity_trigger_paths ${TAIL}`]);
    }
  });

  test("a file without the key prints no parity warning", () => {
    const warnings: string[] = [];
    parseLocalConfig(JSON.stringify({ default_base: "main" }), "f", warnings);
    expect(warnings).toEqual([]);
  });

  test("the merged config has no key and no source, and the loader warns once per file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pr-cfg-"));
    try {
      const home = path.join(root, "home");
      const repo = path.join(root, "repo");
      mkdirSync(path.join(home, ".crysk"), { recursive: true });
      mkdirSync(path.join(repo, ".crysk"), { recursive: true });
      writeFileSync(
        path.join(home, ".crysk", "config.json"),
        '{"parity_trigger_paths":["a"]}',
      );
      writeFileSync(
        path.join(repo, ".crysk", "config.json"),
        '{"parity_trigger_paths":[]}',
      );
      const loaded = await loadEffectiveConfig({ root: repo, home });
      expect("parity_trigger_paths" in loaded.effective).toBe(false);
      expect("parity_trigger_paths" in loaded.sources).toBe(false);
      expect(loaded.warnings).toEqual([
        `~/.crysk/config.json: parity_trigger_paths ${TAIL}`,
        `.crysk/config.json: parity_trigger_paths ${TAIL}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a stored platform person with the key passes the platform's own check", () => {
    expect(() =>
      assertPlatformPerson(
        { parity_trigger_paths: ["x"], max_changed_lines: 4000 },
        "f",
      ),
    ).not.toThrow();
  });

  test("it is no setting any more: not in the direction table, the merge, the rows or the scaffold", () => {
    expect("parity_trigger_paths" in CONFIG_DIRECTION).toBe(false);
    const merged = mergeConfig(undefined, {});
    expect("parity_trigger_paths" in merged.effective).toBe(false);
    expect("parity_trigger_paths" in merged.sources).toBe(false);
    expect(
      configRows(merged.effective, merged.sources).map((row) => row.key),
    ).not.toContain("parity_trigger_paths");
    const scaffold = initConfigTemplate({ defaultBase: "main" });
    expect(scaffold).not.toContain("parity");
    // The scaffold must parse without a warning of its own.
    const warnings: string[] = [];
    parseLocalConfig(scaffold, ".crysk/config.json", warnings);
    expect(warnings).toEqual([]);
  });
});

describe("the models.hunter.parity role", () => {
  let root: string;
  let home: string;
  let agentsDir: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "pr-role-"));
    home = path.join(root, "home");
    agentsDir = path.join(root, "agents");
    mkdirSync(path.join(home, ".crysk"), { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    for (const agent of localReviewSpec({}).agents) {
      writeFileSync(
        path.join(agentsDir, agent.file),
        "---\nname: ok\nmodel: sonnet\n---\nbody\n",
      );
    }
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function resolveWith(models: Record<string, string[]>) {
    writeFileSync(
      path.join(home, ".crysk", "config.json"),
      JSON.stringify({ models }),
    );
    const loaded = await loadEffectiveConfig({ root, home });
    const warnings: string[] = [];
    const result = await resolvePromptSet(
      { agents: agentsDir },
      loaded,
      { profile: FALLBACK_PROFILE },
      (line) => warnings.push(line),
    );
    return { loaded, warnings, result };
  }

  test("is skipped with no throw, one warning, and no step when the spec has no parity hunter", async () => {
    const { loaded, warnings, result } = await resolveWith({
      "hunter.parity": ["claude:opus-latest"],
      "hunter.logic": ["claude:sonnet-latest"],
    });
    expect(warnings).toEqual([`models.hunter.parity ${TAIL}`]);
    const plan = buildResolvedRoutePlan({
      agents: result.spec.agents,
      models: loaded.effective.models,
      profile: FALLBACK_PROFILE,
      bundledAgents: true,
    });
    expect(plan.steps.map((s) => s.stepKey)).not.toContain("hunter-parity");
    const logic = plan.steps.find((s) => s.stepKey === "hunter-logic");
    expect(logic?.route.modelSnapshot).toContain("sonnet");
  });

  test("a review without the role warns about nothing", async () => {
    const { warnings } = await resolveWith({
      "hunter.logic": ["claude:sonnet-latest"],
    });
    expect(warnings).toEqual([]);
  });

  test("any other unknown hunter role still throws, and is not the parity warning", async () => {
    const { loaded, warnings, result } = await resolveWith({
      "hunter.nonesuch": ["claude:opus-latest"],
    });
    expect(warnings).toEqual([]);
    expect(() =>
      buildResolvedRoutePlan({
        agents: result.spec.agents,
        models: loaded.effective.models,
      }),
    ).toThrow(InvalidModelError);
    expect(() =>
      buildResolvedRoutePlan({
        agents: result.spec.agents,
        models: loaded.effective.models,
      }),
    ).toThrow(/^models\.hunter\.nonesuch names no hunter in this review: /);
  });

  test("the role next to an unknown one still throws for the unknown one", () => {
    expect(() =>
      buildResolvedRoutePlan({
        agents: localReviewSpec({}).agents,
        models: {
          "hunter.parity": ["claude:opus-latest"],
          "hunter.nonesuch": ["claude:opus-latest"],
        },
      }),
    ).toThrow(/^models\.hunter\.nonesuch names no hunter/);
  });
});

describe("a deep-review-parity.md left in a custom agents_dir", () => {
  let root: string;
  let agentsDir: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "pr-dir-"));
    agentsDir = path.join(root, "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const agent of localReviewSpec({}).agents) {
      writeFileSync(
        path.join(agentsDir, agent.file),
        "---\nname: ok\nmodel: sonnet\n---\nbody\n",
      );
    }
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function resolve() {
    const loaded = await loadEffectiveConfig({ root, home: root });
    const warnings: string[] = [];
    const result = await resolvePromptSet(
      { agents: agentsDir },
      loaded,
      { profile: FALLBACK_PROFILE },
      (line) => warnings.push(line),
    );
    return { warnings, result };
  }

  test("the review runs, the file is not used, and one warning says so", async () => {
    writeFileSync(
      path.join(agentsDir, "deep-review-parity.md"),
      "---\nname: parity\nmodel: sonnet\n---\nbody\n",
    );
    const { warnings, result } = await resolve();
    expect(warnings).toEqual([`deep-review-parity.md ${TAIL}`]);
    expect(result.spec.agents.map((a) => a.file)).not.toContain(
      "deep-review-parity.md",
    );
    expect([...result.agentFiles.keys()]).not.toContain("parity");
  });

  test("a clean directory warns about nothing", async () => {
    const { warnings } = await resolve();
    expect(warnings).toEqual([]);
  });

  test("any other unreferenced agent file is still an error", async () => {
    writeFileSync(path.join(agentsDir, "deep-review-extra.md"), "x");
    const error = await resolve().catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain(
      'the dir has "deep-review-extra.md" but no agent in the spec references it (it would never run)',
    );
  });

  test("a leftover parity file does not hide another unreferenced file", async () => {
    writeFileSync(path.join(agentsDir, "deep-review-parity.md"), "x");
    writeFileSync(path.join(agentsDir, "deep-review-extra.md"), "x");
    const error = await resolve().catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain("deep-review-extra.md");
    expect(message).not.toContain("deep-review-parity.md");
  });

  test("the lifecycle file keeps its own message, unchanged", async () => {
    writeFileSync(path.join(agentsDir, "deep-review-lifecycle.md"), "x");
    const error = await resolve().catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain(
      'the dir has "deep-review-lifecycle.md" but no agent in the spec references it ' +
        "(it would never run); the lifecycle hunter was retired from the default spec: " +
        "delete the file, or keep the hunter with " +
        "CRYSK_EXTRA_HUNTERS=lifecycle:deep-review-lifecycle.md",
    );
  });

  test("agentsDirProblems alone: the parity file is no problem, a missing spec file still is", () => {
    const files = localReviewSpec({}).agents.map((a) => a.file);
    expect(
      agentsDirProblems(files, [...files, "deep-review-parity.md"]),
    ).toEqual([]);
    expect(agentsDirProblems(files, files.slice(1))).toHaveLength(1);
  });
});

describe("crysk config set parity_trigger_paths", () => {
  let home: string;
  let repo: string;
  beforeEach(() => {
    const root = mkdtempSync(path.join(tmpdir(), "pr-set-"));
    home = path.join(root, "home");
    repo = path.join(root, "repo");
    mkdirSync(path.join(home, ".crysk"), { recursive: true });
    mkdirSync(path.join(repo, ".crysk"), { recursive: true });
  });
  afterEach(() => {
    rmSync(path.dirname(home), { recursive: true, force: true });
  });

  const MESSAGE =
    "parity_trigger_paths was removed: the parity hunter no longer exists";

  test("is refused on the team layer, whatever the value, and the file keeps its bytes", async () => {
    const file = path.join(repo, ".crysk", "config.json");
    const before = '{ "default_base":   "main" }\n';
    writeFileSync(file, before);
    for (const value of ["src/**", '["a/**"]', "", "[]"]) {
      const error = await setConfigValue({
        layer: "team",
        key: "parity_trigger_paths",
        value,
        home,
        repoRoot: repo,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toBe(MESSAGE);
      expect(readFileSync(file, "utf8")).toBe(before);
    }
  });

  test("is refused on the person layer with the same message, not 'use --team', and writes nothing", async () => {
    const file = path.join(home, ".crysk", "config.json");
    const error = await setConfigValue({
      layer: "person",
      key: "parity_trigger_paths",
      value: "src/**",
      home,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(MESSAGE);
    expect(existsSync(file)).toBe(false);
  });

  test("unsetting a stale key still works, in both files", async () => {
    const teamFile = path.join(repo, ".crysk", "config.json");
    writeFileSync(
      teamFile,
      JSON.stringify({ parity_trigger_paths: ["a"], default_base: "main" }),
    );
    await unsetConfigValue({
      layer: "team",
      key: "parity_trigger_paths",
      home,
      repoRoot: repo,
    });
    expect(JSON.parse(readFileSync(teamFile, "utf8"))).toEqual({
      default_base: "main",
    });
    const personFile = path.join(home, ".crysk", "config.json");
    writeFileSync(
      personFile,
      JSON.stringify({ parity_trigger_paths: ["a"], post: true }),
    );
    await unsetConfigValue({
      layer: "person",
      key: "parity_trigger_paths",
      home,
    });
    expect(JSON.parse(readFileSync(personFile, "utf8"))).toEqual({
      post: true,
    });
  });
});

describe("the bundled set and the product spec", () => {
  test("the product spec has no parity hunter and the bundle no parity prompt", () => {
    const spec = localReviewSpec({});
    expect(spec.agents.map((a) => a.key)).toEqual([
      "reliability",
      "resilience",
      "logic",
      "security",
      "refuter",
    ]);
    expect(spec.agents.some((a) => a.trigger !== undefined)).toBe(false);
    expect(Object.keys(BUNDLED_AGENT_FILES)).not.toContain(
      "deep-review-parity.md",
    );
    expect(
      existsSync(
        path.join(
          import.meta.dir,
          "..",
          "prompts",
          "default",
          "deep-review-parity.md",
        ),
      ),
    ).toBe(false);
  });
});

describe("what the lab keeps", () => {
  test("defaultReviewSpec() still carries the conditional parity hunter", () => {
    const spec = validateReviewSpec(defaultReviewSpec());
    const parity = spec.agents.find((a) => a.key === "parity");
    expect(parity).toEqual({
      key: "parity",
      file: "deep-review-parity.md",
      role: "hunter",
      trigger: "input",
    });
  });

  // The lab's path through the pipeline: no spec (so the legacy default wiring),
  // an agents directory that carries the parity prompt, and a trigger path that
  // matches the diff. The hunter runs and the envelope says so. (The same
  // wiring is also pinned in test/review/pipeline.test.ts.)
  test("a run with no spec, a parity prompt and a matching trigger still fires the hunter", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pr-lab-"));
    try {
      const agentsDir = path.join(dir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      for (const file of [
        "deep-review-reliability.md",
        "deep-review-resilience.md",
        "deep-review-parity.md",
      ]) {
        writeFileSync(
          path.join(agentsDir, file),
          "---\nname: h\nmodel: sonnet\ntools: Read\n---\n\n{{PRIORS}}\n\n{{GOTCHAS}}\n",
        );
      }
      writeFileSync(
        path.join(agentsDir, "review-refuter.md"),
        "---\nname: r\nmodel: sonnet\ntools: Read\n---\n\nRefute.\n",
      );
      const diffPath = path.join(dir, "diff.patch");
      writeFileSync(
        diffPath,
        "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
      );
      const gotchasPath = path.join(dir, "gotchas.md");
      writeFileSync(gotchasPath, "G-01: a seeded fact.");
      const seen: string[] = [];
      const runner = {
        async run(spec: StepSpec): Promise<StepResult> {
          seen.push(spec.name);
          return {
            name: spec.name,
            status: "ok",
            output: { findings: [] },
            usage: {
              wall_ms: 1,
              tokens_in: 1,
              tokens_out: 1,
              tokens_total: 2,
            },
            attempts: 1,
            stderrTail: "",
            resultText: "",
          };
        },
      };
      const run = (parityTriggerPaths: string[]) =>
        runPipeline(
          {
            pr: 1,
            baseSha: "a",
            headSha: "b",
            worktree: dir,
            diffPath,
            gotchasPath,
            agentsDir,
            runDir: path.join(dir, `run-${parityTriggerPaths.length}`),
            outPath: path.join(dir, "findings.json"),
            mcpConfigPath: path.join(dir, "mcp.json"),
            hopBudget: 4,
            parityTriggerPaths,
            suspicionPriors: [],
          },
          { runner },
        );
      const fired = await run(["**/app.ts"]);
      expect(seen.sort()).toEqual([
        "hunter-parity",
        "hunter-reliability",
        "hunter-resilience",
      ]);
      expect(fired.skillOutput.parity_hunter_fired).toBe(true);
      seen.length = 0;
      const quiet = await run([]);
      expect(seen.sort()).toEqual(["hunter-reliability", "hunter-resilience"]);
      expect(quiet.skillOutput.parity_hunter_fired).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a document from before the removal still validates and reads back", () => {
    const finding: Finding = {
      id: "F001",
      category: 13,
      path: "src/a.ts",
      line: 3,
      severity: "BLOCKER",
      evidence_class: "deterministic",
      refuter_verdict: "corroborated",
      causal_disposition: "introduced",
      claim: "shared component blast radius",
      proof_refs: ["diff-hunk#1"],
      hunter: "parity",
      tier: "blocking",
      hops_used: 1,
      hop_trail: [],
      dedupe_key: "a.ts:1",
    };
    const doc: FindingsDocument = {
      schema_version: SCHEMA_VERSION,
      pr: 1,
      base_sha: "b",
      head_sha: "h",
      model: "sonnet",
      iteration: 1,
      parity_hunter_fired: true,
      run_status: "complete",
      telemetry: {
        index_ms: 1,
        index_mode: "fresh",
        index_disk_mb: 1,
        wall_ms: 1,
        tokens_in: 1,
        tokens_out: 1,
        tokens_total: 2,
      },
      findings: [finding],
      debug: { refuted: [] },
    };
    const back = validateFindingsDocument(JSON.parse(JSON.stringify(doc)));
    expect(back).toEqual(doc);
    expect(back.parity_hunter_fired).toBe(true);
    expect(back.findings[0]?.hunter).toBe("parity");
  });
});
