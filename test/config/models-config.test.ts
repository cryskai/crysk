// odd/tasks/role-model-routing.md E-b: `models` and `credentials` as person-only
// keys in every config entry point, the clean break for `routing` and
// `summary.model`, and the repair tools that read a config which no longer parses.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPlatformPerson } from "#ci/platform-config";
import { materializeCiOpenCodeData } from "#ci/setup";
import { runDoctorCommand } from "#commands/doctor";
import { loadEffectiveConfig } from "#config/config";
import {
  initConfigTemplate,
  mergeConfig,
  parseGlobalConfig,
  parseLocalConfig,
} from "#review/preflight";
import { loadRunConfig } from "#review/run";
import { configRows } from "#ui/config";
import { setConfigValue } from "#ui/config-edit";
import type { CliUsageError } from "../../src/errors";

const ROUTING_GONE =
  '`routing` is gone: set models per role, e.g. `"models": {"hunter.logic": ["claude:sonnet-latest"]}`';

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

async function scratch(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "crysk-models-config-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("models and credentials are person-only keys (S1, S5)", () => {
  const person = {
    models: {
      default: ["claude:sonnet-latest"],
      "hunter.logic": [
        { model: "opencode:openai/gpt-5", effort: "high" },
        "claude:opus-latest",
      ],
    },
    credentials: { claude: ["subscription", "api_key"] },
  };

  test("the person file admits both and returns them as written", () => {
    const layer = parseGlobalConfig(JSON.stringify(person));
    expect(layer.models).toEqual(person.models);
    expect(layer.credentials).toEqual({ claude: ["subscription", "api_key"] });
  });

  test("the platform person layer admits both", () => {
    expect(() =>
      assertPlatformPerson(person, "/tmp/config.json"),
    ).not.toThrow();
  });

  test("a repo file may not set either", () => {
    for (const key of ["models", "credentials"] as const) {
      expect(
        messageOf(() =>
          parseLocalConfig(JSON.stringify({ [key]: person[key] })),
        ),
      ).toStartWith(`.crysk/config.json: ${key} is a per-person key`);
    }
  });

  test("the merge carries both from the person layer, with their source", () => {
    const merged = mergeConfig(parseGlobalConfig(JSON.stringify(person)), {});
    expect(merged.effective.models).toEqual(person.models);
    expect(merged.effective.credentials).toEqual({
      claude: ["subscription", "api_key"],
    });
    expect(merged.sources.models).toBe("global");
    expect(merged.sources.credentials).toBe("global");
  });

  test("absent, both report default and the effective config has neither", () => {
    const merged = mergeConfig(undefined, {});
    expect(merged.effective.models).toBeUndefined();
    expect(merged.effective.credentials).toBeUndefined();
    expect(merged.sources.models).toBe("default");
    expect(merged.sources.credentials).toBe("default");
  });

  test("a bad model name names the file, the role and the position", () => {
    expect(
      messageOf(() =>
        parseGlobalConfig(
          JSON.stringify({ models: { default: ["claude:sonnet"] } }),
        ),
      ),
    ).toStartWith(
      '~/.crysk/config.json models.default[0]: "claude:sonnet" is not a model name: write "claude:sonnet-latest"',
    );
  });

  test("a secret pasted as a model is refused and never echoed", () => {
    const secret = "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const message = messageOf(() =>
      parseGlobalConfig(
        JSON.stringify({ models: { default: [`opencode:openai/${secret}`] } }),
      ),
    );
    expect(message).toContain("credentials are not permitted in models");
    expect(message).not.toContain(secret);
  });
});

describe("models.judge (L6 item 5)", () => {
  test("models the judge was not measured on are named in a warning", () => {
    const warnings: string[] = [];
    const layer = parseGlobalConfig(
      JSON.stringify({
        models: { judge: ["claude:haiku-latest", "claude:opus-latest"] },
      }),
      undefined,
      warnings,
    );
    // Kept as written: the plan drops them, so a later measured model works.
    expect(layer.models?.judge).toEqual([
      "claude:haiku-latest",
      "claude:opus-latest",
    ]);
    expect(warnings).toEqual([
      "~/.crysk/config.json: models.judge skips claude:haiku-latest: the materiality judge runs only on claude:sonnet-latest or claude:opus-latest.",
    ]);
  });

  test("with none left, the warning says the judge stands down", () => {
    const warnings: string[] = [];
    parseGlobalConfig(
      JSON.stringify({ models: { judge: ["opencode:openai/gpt-5"] } }),
      undefined,
      warnings,
    );
    expect(warnings).toEqual([
      "~/.crysk/config.json: models.judge skips opencode:openai/gpt-5: the materiality judge runs only on claude:sonnet-latest or claude:opus-latest, so it stands down.",
    ]);
  });

  test("measured models only: no warning", () => {
    const warnings: string[] = [];
    parseGlobalConfig(
      JSON.stringify({ models: { judge: ["claude:opus-latest"] } }),
      undefined,
      warnings,
    );
    expect(warnings).toEqual([]);
  });
});

describe("credentials values (S5)", () => {
  test("one kind, or both in either order", () => {
    for (const claude of [
      ["subscription"],
      ["api_key"],
      ["api_key", "subscription"],
    ] as const) {
      expect(
        parseGlobalConfig(JSON.stringify({ credentials: { claude } }))
          .credentials,
      ).toEqual({ claude });
    }
  });

  test("a value outside the closed set is refused without echoing it", () => {
    const secret = "sk-ant-oat01-BBBBBBBBBBBBBBBBBBBBBBBB";
    const message = messageOf(() =>
      parseGlobalConfig(JSON.stringify({ credentials: { claude: [secret] } })),
    );
    expect(message).toBe(
      '~/.crysk/config.json credentials.claude[0] must be "subscription" or "api_key"',
    );
  });

  test("an empty list, a repeat, a non-list and another backend are refused", () => {
    expect(
      messageOf(() =>
        parseGlobalConfig(JSON.stringify({ credentials: { claude: [] } })),
      ),
    ).toBe(
      "~/.crysk/config.json credentials.claude must list subscription, api_key or both, in the order to try them",
    );
    expect(
      messageOf(() =>
        parseGlobalConfig(
          JSON.stringify({
            credentials: { claude: ["api_key", "api_key"] },
          }),
        ),
      ),
    ).toBe('~/.crysk/config.json credentials.claude lists "api_key" twice');
    expect(
      messageOf(() =>
        parseGlobalConfig(JSON.stringify({ credentials: ["subscription"] })),
      ),
    ).toBe(
      '~/.crysk/config.json credentials must be an object, e.g. `"credentials": {"claude": ["subscription", "api_key"]}`',
    );
    expect(
      messageOf(() =>
        parseGlobalConfig(
          JSON.stringify({ credentials: { opencode: ["api_key"] } }),
        ),
      ),
    ).toStartWith(
      '~/.crysk/config.json credentials has an unknown key "opencode": only claude is supported',
    );
  });
});

describe("routing is gone (S2)", () => {
  const routing = { routing: { default: { backend: "claude-code" } } };

  test("the person file refuses it with the new form", () => {
    expect(messageOf(() => parseGlobalConfig(JSON.stringify(routing)))).toBe(
      `~/.crysk/config.json: ${ROUTING_GONE}`,
    );
  });

  test("the repo file refuses it with the same message, not the per-person one", () => {
    const error = (() => {
      try {
        parseLocalConfig(JSON.stringify(routing));
      } catch (e) {
        return e as CliUsageError;
      }
      throw new Error("expected a throw");
    })();
    expect(error.message).toBe(`.crysk/config.json: ${ROUTING_GONE}`);
    expect(error.cls).toEqual({ kind: "config-parse", source: "repo-config" });
  });

  test("the platform person layer refuses it", () => {
    expect(() => assertPlatformPerson(routing, "/tmp/c.json")).toThrow(
      `platform config.person: ${ROUTING_GONE}`,
    );
  });

  // The setup step's routing backstop is gone (E-f F0, D6): the trigger stops a
  // workflow that still passes the input with PRH-INPUT-REMOVED, and setup
  // never receives it.
  test("an empty CI routing input is still Claude-default CI", async () => {
    const { dir, cleanup } = await scratch();
    try {
      await materializeCiOpenCodeData({
        home: dir,
        env: { HOME: dir },
        routing: "  ",
        opencodeAuth: "",
      });
      expect(existsSync(path.join(dir, ".crysk", "config.json"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("platform models win over a stale CI routing input", async () => {
    const { dir, cleanup } = await scratch();
    try {
      await materializeCiOpenCodeData({
        home: dir,
        env: { HOME: dir },
        routing: JSON.stringify(routing.routing),
        opencodeAuth: "",
        platformPerson: { models: { default: ["claude:opus-latest"] } },
      });
      const written = JSON.parse(
        await readFile(path.join(dir, ".crysk", "config.json"), "utf8"),
      );
      expect(written).toEqual({ models: { default: ["claude:opus-latest"] } });
    } finally {
      await cleanup();
    }
  });
});

describe("summary.model (L6 item 1)", () => {
  const NEW_FORM =
    'set the summary model per person, under models in your person config, e.g. `"models": {"summary": ["claude:haiku-latest"]}`';

  test('the person file converts "haiku" to models.summary, with a warning', () => {
    const warnings: string[] = [];
    const layer = parseGlobalConfig(
      JSON.stringify({ summary: { enabled: true, model: "haiku" } }),
      undefined,
      warnings,
    );
    expect(layer.summary).toEqual({ enabled: true });
    expect(layer.models).toEqual({ summary: ["claude:haiku-latest"] });
    expect(warnings).toEqual([
      '~/.crysk/config.json: summary.model is gone; "haiku" is read as `"models": {"summary": ["claude:haiku-latest"]}`. Write that instead of summary.model.',
    ]);
  });

  test("the person file keeps its own models.summary over the old key", () => {
    const warnings: string[] = [];
    const layer = parseGlobalConfig(
      JSON.stringify({
        summary: { model: "haiku" },
        models: {
          summary: ["claude:sonnet-latest"],
          default: ["claude:opus-latest"],
        },
      }),
      undefined,
      warnings,
    );
    expect(layer.models).toEqual({
      summary: ["claude:sonnet-latest"],
      default: ["claude:opus-latest"],
    });
    expect(warnings).toEqual([
      "~/.crysk/config.json: summary.model is gone and models.summary already sets the summary model. Delete summary.model.",
    ]);
  });

  test("the repo file drops it with a warning (what crysk init used to write)", () => {
    const warnings: string[] = [];
    const layer = parseLocalConfig(
      JSON.stringify({ summary: { enabled: true, model: "haiku" } }),
      undefined,
      warnings,
    );
    expect(layer.summary).toEqual({ enabled: true });
    expect(layer.models).toBeUndefined();
    expect(warnings).toEqual([
      ".crysk/config.json: summary.model is gone and is ignored here: the summary model is set per person, under models.summary in your person config (~/.crysk/config.json). Delete summary.model from this file.",
    ]);
  });

  test("any other value is refused with the new form, in both files", () => {
    for (const model of ["opus", "sonnet", "claude:haiku-latest", ""]) {
      expect(
        messageOf(() =>
          parseGlobalConfig(JSON.stringify({ summary: { model } })),
        ),
      ).toBe(`~/.crysk/config.json summary.model is gone: ${NEW_FORM}`);
      expect(
        messageOf(() =>
          parseLocalConfig(JSON.stringify({ summary: { model } })),
        ),
      ).toBe(`.crysk/config.json summary.model is gone: ${NEW_FORM}`);
    }
  });

  test("loadEffectiveConfig returns the warnings of both files and the converted models", async () => {
    const { dir, cleanup } = await scratch();
    try {
      const home = path.join(dir, "home");
      const root = path.join(dir, "repo");
      await mkdir(path.join(home, ".crysk"), { recursive: true });
      await mkdir(path.join(root, ".crysk"), { recursive: true });
      await writeFile(
        path.join(home, ".crysk", "config.json"),
        JSON.stringify({ summary: { model: "haiku" } }),
      );
      await writeFile(
        path.join(root, ".crysk", "config.json"),
        JSON.stringify({ default_base: "main", summary: { model: "haiku" } }),
      );
      const loaded = await loadEffectiveConfig({ root, home });
      expect(loaded.effective.models).toEqual({
        summary: ["claude:haiku-latest"],
      });
      expect(loaded.warnings).toHaveLength(2);
      expect(loaded.warnings[0]).toStartWith(
        "~/.crysk/config.json: summary.model is gone;",
      );
      expect(loaded.warnings[1]).toStartWith(
        ".crysk/config.json: summary.model is gone and is ignored here",
      );
    } finally {
      await cleanup();
    }
  });

  test("a review prints each config warning before it runs", async () => {
    const { dir, cleanup } = await scratch();
    try {
      await mkdir(path.join(dir, ".crysk"), { recursive: true });
      await writeFile(
        path.join(dir, ".crysk", "config.json"),
        JSON.stringify({ summary: { model: "haiku" } }),
      );
      const printed: string[] = [];
      await mkdir(path.join(dir, "repo"));
      await loadRunConfig({
        root: path.join(dir, "repo"),
        home: dir,
        configFlag: undefined,
        options: {},
        warn: (line) => printed.push(line),
      });
      expect(printed).toEqual([
        '~/.crysk/config.json: summary.model is gone; "haiku" is read as `"models": {"summary": ["claude:haiku-latest"]}`. Write that instead of summary.model.',
      ]);
    } finally {
      await cleanup();
    }
  });

  test("a config with no old keys loads with no warnings", async () => {
    const { dir, cleanup } = await scratch();
    try {
      const loaded = await loadEffectiveConfig({ home: dir });
      expect(loaded.warnings).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("crysk init no longer writes summary.model", () => {
  test("the scaffold has summary.enabled only and parses with no warning", () => {
    const text = initConfigTemplate({ defaultBase: "main" });
    expect(JSON.parse(text).summary).toEqual({ enabled: true });
    expect(text).not.toContain('"model"');
    const warnings: string[] = [];
    parseLocalConfig(text, undefined, warnings);
    expect(warnings).toEqual([]);
  });
});

describe("repair tools on a config that no longer parses", () => {
  test("crysk config set summary.model is refused with where it lives now", async () => {
    const { dir, cleanup } = await scratch();
    try {
      for (const layer of ["person", "team"] as const) {
        await expect(
          setConfigValue({
            layer,
            key: "summary.model",
            value: "opus",
            home: dir,
            repoRoot: dir,
          }),
        ).rejects.toThrow(
          'summary.model is gone: set the summary model per person, under models in ~/.crysk/config.json, e.g. "models": {"summary": ["claude:haiku-latest"]}',
        );
      }
    } finally {
      await cleanup();
    }
  });

  test("crysk doctor reports a removed routing key as a blocking config check", async () => {
    const { dir, cleanup } = await scratch();
    try {
      await mkdir(path.join(dir, ".crysk"), { recursive: true });
      await writeFile(
        path.join(dir, ".crysk", "config.json"),
        JSON.stringify({ routing: {} }),
      );
      const { report } = await runDoctorCommand({
        workspaceRoot: dir,
        home: dir,
        styles: false,
        width: 80,
        runDoctorFn: async () => ({
          overall: "healthy",
          exitCode: 0,
          checks: [],
        }),
        readSdkVersion: async () => undefined,
      });
      const config = report.checks.find((c) => c.name === "config");
      expect(config?.severity).toBe("blocking");
      expect(config?.message).toBe(
        `configuration failed to load: ~/.crysk/config.json: ${ROUTING_GONE}`,
      );
    } finally {
      await cleanup();
    }
  });

  test("crysk doctor reports a summary.model warning as degraded", async () => {
    const { dir, cleanup } = await scratch();
    try {
      await mkdir(path.join(dir, ".crysk"), { recursive: true });
      await writeFile(
        path.join(dir, ".crysk", "config.json"),
        JSON.stringify({ summary: { model: "haiku" } }),
      );
      const { report } = await runDoctorCommand({
        workspaceRoot: dir,
        home: dir,
        styles: false,
        width: 80,
        runDoctorFn: async () => ({
          overall: "healthy",
          exitCode: 0,
          checks: [],
        }),
        readSdkVersion: async () => undefined,
      });
      const config = report.checks.find((c) => c.name === "config");
      expect(config?.severity).toBe("degraded");
      expect(config?.message).toStartWith(
        "~/.crysk/config.json: summary.model is gone;",
      );
    } finally {
      await cleanup();
    }
  });

  test("crysk doctor checks the OpenCode SDK when a model runs on OpenCode", async () => {
    const { dir, cleanup } = await scratch();
    try {
      await mkdir(path.join(dir, ".crysk"), { recursive: true });
      await writeFile(
        path.join(dir, ".crysk", "config.json"),
        JSON.stringify({
          models: { "hunter.logic": ["opencode:openai/gpt-5"] },
        }),
      );
      const { report } = await runDoctorCommand({
        workspaceRoot: dir,
        home: dir,
        styles: false,
        width: 80,
        runDoctorFn: async () => ({
          overall: "healthy",
          exitCode: 0,
          checks: [],
        }),
        readSdkVersion: async () => undefined,
      });
      expect(
        report.checks.find((c) => c.name === "opencode-sdk")?.severity,
      ).toBe("blocking");
    } finally {
      await cleanup();
    }
  });

  test("crysk config shows models and credentials rows", () => {
    const merged = mergeConfig(
      parseGlobalConfig(
        JSON.stringify({
          models: {
            default: ["claude:sonnet-latest"],
            summary: ["claude:haiku-latest", "opencode:openai/gpt-5-mini"],
          },
          credentials: { claude: ["api_key"] },
        }),
      ),
      {},
    );
    const rows = configRows(merged.effective, merged.sources);
    expect(rows.find((r) => r.key === "models")).toMatchObject({
      value:
        "default=claude:sonnet-latest, summary=claude:haiku-latest,opencode:openai/gpt-5-mini",
      source: "global",
    });
    expect(rows.find((r) => r.key === "credentials")).toMatchObject({
      value: "claude=api_key",
      source: "global",
    });
    expect(rows.some((r) => r.key === "summary.model")).toBe(false);
  });

  test("an entry with an effort shows it beside its model (E-g)", () => {
    const merged = mergeConfig(
      parseGlobalConfig(
        JSON.stringify({
          models: {
            default: [{ model: "claude:sonnet-latest" }],
            refuter: [
              { model: "claude:opus-latest", effort: "max" },
              { model: "opencode:openai/gpt-5", effort: "high" },
              "claude:haiku-latest",
            ],
          },
        }),
      ),
      {},
    );
    expect(
      configRows(merged.effective, merged.sources).find(
        (r) => r.key === "models",
      ),
    ).toMatchObject({
      value:
        "default=claude:sonnet-latest, refuter=claude:opus-latest (effort max),opencode:openai/gpt-5 (effort high),claude:haiku-latest",
      source: "global",
    });
  });
});
