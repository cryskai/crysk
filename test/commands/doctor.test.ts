import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDoctorCommand } from "#commands/doctor";

// `tmpHome`/`tmpRoot`/`MUSIVE_CONFIG` below now serve only
// runDoctorCommand's config-load-resilience suite: the loadEffectiveConfig/
// loadGlobalConfigLayer suites that used to sit here moved to
// test/config/config.test.ts alongside src/config/config.ts (cli-decomp S2,
// Cluster A). Duplicated there rather than imported from here, per this
// file's own fakeGh precedent above.
// ---------------------------------------------------------------------------

async function tmpHome(global?: string): Promise<{
  home: string;
  cleanup: () => Promise<void>;
}> {
  const home = await mkdtemp(path.join(tmpdir(), "pr-hero-home-"));
  if (global !== undefined) {
    await mkdir(path.join(home, ".prhero"), { recursive: true });
    await Bun.write(path.join(home, ".prhero", "config.json"), global);
  }
  return {
    home,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

async function tmpRoot(repoConfig?: string): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "pr-hero-root-"));
  if (repoConfig !== undefined) {
    await mkdir(path.join(root, ".prhero"), { recursive: true });
    await Bun.write(path.join(root, ".prhero", "config.json"), repoConfig);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const MUSIVE_CONFIG = JSON.stringify(
  {
    agents_dir: "/Users/juanma/Desktop/deep-review/agents/slice3b-clean",
    default_base: "dev",
    parity_trigger_paths: [],
    suspicion_priors: [],
    summary: { enabled: false },
  },
  null,
  2,
);

// W3 remediation (opencode-production-runtime PR3 verify #4997): doctorCommand
// used to call loadEffectiveConfig() BEFORE runDoctor(), so a missing --config
// file or malformed repo config.json threw and doctorCommand never ran a
// single diagnostic — inverting the purpose of a command that exists to
// diagnose exactly that kind of misconfiguration. runDoctorCommand fixes this:
// a config-load failure becomes one blocking DoctorCheckItem prepended to the
// report, and every other diagnostic still runs and still renders.
describe("runDoctorCommand — config-load resilience (W3)", () => {
  test("malformed repo config.json still runs other diagnostics and exits nonzero", async () => {
    const home = await tmpHome();
    // Deliberately invalid JSON — this is what parseLocalConfig throws on,
    // exercised through the REAL loadEffectiveConfig, not a mocked loader.
    const repo = await tmpRoot("{ not valid json");
    try {
      const { report, lines } = await runDoctorCommand({
        repoRoot: repo.root,
        workspaceRoot: repo.root,
        home: home.home,
        styles: false,
        width: 80,
        // Stubbed so the test never shells out to real git/claude/gh/codegraph
        // — this test is about the config-failure WIRING, not system probing,
        // which test/doctor.test.ts already covers via runDoctor directly.
        runDoctorFn: async (opts) => {
          expect(opts?.repoRoot).toBe(repo.root);
          return {
            overall: "healthy",
            exitCode: 0,
            checks: [
              {
                name: "git",
                severity: "healthy",
                message: "git version 2.40.0",
              },
            ],
          };
        },
      });

      const configCheck = report.checks.find((c) => c.name === "config");
      expect(configCheck?.severity).toBe("blocking");
      expect(configCheck?.message).toContain("configuration failed to load");
      // The rest of the diagnostics from runDoctorFn are NOT discarded.
      expect(report.checks.some((c) => c.name === "git")).toBe(true);
      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      expect(lines.join("\n")).toContain("git");
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });

  test("a missing --config file still runs other diagnostics and exits nonzero", async () => {
    const home = await tmpHome();
    const repo = await tmpRoot();
    try {
      const missing = path.join(repo.root, "nope", "config.json");
      const { report } = await runDoctorCommand({
        repoRoot: repo.root,
        workspaceRoot: repo.root,
        home: home.home,
        configFlag: missing,
        styles: false,
        width: 80,
        runDoctorFn: async () => ({
          overall: "healthy",
          exitCode: 0,
          checks: [
            { name: "gh", severity: "healthy", message: "gh version 2.30.0" },
          ],
        }),
      });

      const configCheck = report.checks.find((c) => c.name === "config");
      expect(configCheck?.severity).toBe("blocking");
      expect(configCheck?.message).toContain(
        `config file not found: ${missing}`,
      );
      expect(report.checks.some((c) => c.name === "gh")).toBe(true);
      expect(report.exitCode).toBe(1);
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });

  test("happy path: a valid config loads cleanly and no config check is added", async () => {
    const home = await tmpHome();
    const repo = await tmpRoot(MUSIVE_CONFIG);
    try {
      const { report } = await runDoctorCommand({
        repoRoot: repo.root,
        workspaceRoot: repo.root,
        home: home.home,
        styles: false,
        width: 80,
        runDoctorFn: async () => ({
          overall: "degraded",
          exitCode: 0,
          checks: [
            {
              name: "gh",
              severity: "degraded",
              message: "gh missing",
              hint: "brew install gh",
            },
          ],
        }),
      });

      expect(report.checks.some((c) => c.name === "config")).toBe(false);
      expect(report.overall).toBe("degraded");
      expect(report.exitCode).toBe(0);
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });
});

describe("runDoctorCommand — an OpenCode model needs a resolvable SDK", () => {
  const degradedProbe = async () => ({
    overall: "degraded" as const,
    exitCode: 0 as const,
    checks: [
      {
        name: "provider",
        severity: "degraded" as const,
        message: "capability report production degraded: sdk missing",
        hint: "Claude-backed steps are unverified here",
      },
    ],
  });

  test("an OpenCode model with no installed SDK blocks even when the probe row is degraded", async () => {
    const home = await tmpHome(
      JSON.stringify({
        models: { default: ["opencode:opencode/big-pickle"] },
      }),
    );
    const repo = await tmpRoot();
    try {
      const { report } = await runDoctorCommand({
        repoRoot: repo.root,
        workspaceRoot: repo.root,
        home: home.home,
        styles: false,
        width: 80,
        runDoctorFn: degradedProbe,
        readSdkVersion: async () => undefined,
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const sdk = report.checks.find((c) => c.name === "opencode-sdk");
      expect(sdk?.severity).toBe("blocking");
      expect(sdk?.message).toContain("crysk upgrade --reconcile");
      expect(sdk?.message).toContain("@opencode-ai/sdk@1.18.25");
      const probe = report.checks.find((c) => c.name === "provider");
      expect(probe?.severity).toBe("degraded");
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });

  test("Claude-only models do not add an OpenCode SDK row", async () => {
    const home = await tmpHome(
      JSON.stringify({
        models: { default: ["claude:sonnet-latest"] },
      }),
    );
    const repo = await tmpRoot();
    try {
      let reads = 0;
      const { report } = await runDoctorCommand({
        repoRoot: repo.root,
        workspaceRoot: repo.root,
        home: home.home,
        styles: false,
        width: 80,
        runDoctorFn: degradedProbe,
        readSdkVersion: async () => {
          reads += 1;
          return undefined;
        },
      });

      expect(reads).toBe(0);
      expect(report.checks.some((c) => c.name === "opencode-sdk")).toBe(false);
      expect(report.overall).toBe("degraded");
      expect(report.exitCode).toBe(0);
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });
});

// model-profiles S6: the command resolves the configuration and tells the
// doctor whether any step runs on the Claude CLI. Required unless proven not.
describe("runDoctorCommand — Claude CLI required only when a step uses it", () => {
  const seen = async (
    global: string | undefined,
    repoConfig?: string,
  ): Promise<boolean | undefined> => {
    const home = await tmpHome(global);
    const repo = await tmpRoot(repoConfig);
    try {
      let claudeRequired: boolean | undefined;
      await runDoctorCommand({
        repoRoot: repo.root,
        workspaceRoot: repo.root,
        home: home.home,
        styles: false,
        width: 80,
        runDoctorFn: async (opts) => {
          claudeRequired = opts?.claudeRequired;
          return { overall: "healthy", exitCode: 0, checks: [] };
        },
        readSdkVersion: async () => "1.18.25",
      });
      return claudeRequired;
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  };

  test("zero-config requires it", async () => {
    expect(await seen(undefined)).toBe(true);
  });

  test("a Claude models config requires it", async () => {
    expect(
      await seen(
        JSON.stringify({ models: { default: ["claude:opus-latest"] } }),
      ),
    ).toBe(true);
  });

  test("an all-OpenCode models config does not", async () => {
    expect(
      await seen(
        JSON.stringify({ models: { default: ["opencode:openai/gpt-4o"] } }),
      ),
    ).toBe(false);
  });

  test("a legacy summary.model is a Claude summary model, so it requires it", async () => {
    expect(
      await seen(
        JSON.stringify({
          models: { default: ["opencode:openai/gpt-4o"] },
          summary: { model: "haiku" },
        }),
      ),
    ).toBe(true);
  });

  test("a config that fails to load still requires it", async () => {
    expect(
      await seen(
        JSON.stringify({ models: { default: ["opencode:openai/gpt-4o"] } }),
        "{ not valid json",
      ),
    ).toBe(true);
  });
});
