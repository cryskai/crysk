import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { selfInvocation } from "../src/assets";
import { prheroLayout } from "../src/home-preflight";
import { SUPPORTED_OPENCODE_SDK_VERSION } from "../src/transport-registry";
import {
  detectInstallMethod,
  detectShadowInstalls,
  isCheckCacheFresh,
  PRHERO_GITHUB_REPO,
  planUpgrade,
  type ReconcileUpgradeOptions,
  readUpgradeCache,
  reconcileUpgrade,
  selectOpenCodeSdkInstaller,
  spawnOpenCodeSdkInstaller,
  type UpgradeCheckCache,
  writeUpgradeCache,
} from "../src/updater";

describe("updater (lifecycle foundations)", () => {
  const home = "/home/user";
  const layout = prheroLayout(home);
  const standaloneBin = path.join(home, ".prhero", "bin", "pr-hero");

  test("1.4 Canonical repo constant is pinned to cryskai/crysk", () => {
    expect(PRHERO_GITHUB_REPO).toBe("cryskai/crysk");
  });

  describe("1.1 Install method detection and shadow-installs", () => {
    test("detects standalone binary when execPath is in ~/.prhero/bin", () => {
      const method = detectInstallMethod({
        execPath: standaloneBin,
        home,
        version: "1.0.0",
      });
      expect(method.kind).toBe("standalone");
      if (method.kind === "standalone") {
        expect(method.binaryPath).toBe(standaloneBin);
      }
    });

    test("detects a standalone binary in ~/.crysk/bin", () => {
      const bin = path.join(home, ".crysk", "bin", "pr-hero");
      const method = detectInstallMethod({
        execPath: bin,
        home,
        version: "1.0.0",
      });
      expect(method).toEqual({ kind: "standalone", binaryPath: bin });
    });

    test("detects source checkout when version is dev or running from source repo", () => {
      const method = detectInstallMethod({
        execPath: "/usr/local/bin/bun",
        home,
        version: "dev",
        isDev: true,
      });
      expect(method.kind).toBe("source");
    });

    test("detects npm/bun global installation otherwise", () => {
      const method = detectInstallMethod({
        execPath: "/usr/local/bin/node",
        home,
        version: "1.0.0",
        isDev: false,
      });
      expect(method.kind).toBe("package_manager");
      if (method.kind === "package_manager") {
        expect(method.manager).toBe("npm");
      }
    });

    test("detects shadow installs without mutating them", async () => {
      const shadows = await detectShadowInstalls({
        currentBinary: standaloneBin,
        which: async (bin) => {
          if (bin === "pr-hero")
            return ["/usr/local/bin/pr-hero", standaloneBin];
          return [];
        },
      });
      expect(shadows).toContain("/usr/local/bin/pr-hero");
      expect(shadows).not.toContain(standaloneBin);
    });
  });

  describe("1.1 & 1.2 Upgrade planning, sibling temp, and .bak lifecycle", () => {
    test("source checkout yields informative no-op plan", async () => {
      const plan = await planUpgrade({
        installMethod: { kind: "source" },
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        home,
      });
      expect(plan.action).toBe("noop_source");
      expect(plan.steps).toHaveLength(0);
      expect(plan.message).toContain("source checkout");
    });

    test("standalone binary plans download to sibling temp, sha256 check, and .bak rename", async () => {
      const plan = await planUpgrade({
        installMethod: { kind: "standalone", binaryPath: standaloneBin },
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        home,
        platform: "darwin",
        arch: "arm64",
      });

      expect(plan.action).toBe("upgrade_standalone");
      // The binary is installed as `crysk` beside the one that is running
      // (updater-binaries.test.ts covers the pr-hero alias).
      const crysk = path.join(path.dirname(standaloneBin), "crysk");
      expect(plan.targetBinary).toBe(crysk);
      expect(plan.tempBinary).toMatch(/\.tmp\.[a-z0-9]+$/);
      expect(path.dirname(plan.tempBinary || "")).toBe(
        path.dirname(standaloneBin),
      );
      expect(plan.bakBinary).toBe(`${crysk}.bak`);
      expect(plan.downloadUrl).toContain("v1.1.0/crysk-darwin-arm64");
      expect(plan.checksumsUrl).toContain("v1.1.0/SHA256SUMS");
    });

    test("already up-to-date standalone plan yields up_to_date action", async () => {
      const plan = await planUpgrade({
        installMethod: { kind: "standalone", binaryPath: standaloneBin },
        currentVersion: "1.1.0",
        targetVersion: "1.1.0",
        home,
      });
      expect(plan.action).toBe("up_to_date");
    });
  });

  describe("1.3 Upgrade check cache and TTL", () => {
    test("reads and writes upgrade cache to upgradeCheckPath", () => {
      const cache: UpgradeCheckCache = {
        checked_at: "2026-08-24T12:00:00.000Z",
        current_version: "1.0.0",
        latest_version: "1.1.0",
        reconciled_version: "1.0.0",
        release_url: "https://github.com/cryskai/crysk/releases/tag/v1.1.0",
      };

      const storage: Record<string, string> = {};
      writeUpgradeCache(layout.upgradeCheckPath, cache, {
        writeFile: (p, content) => {
          storage[p] = content;
        },
      });

      const read = readUpgradeCache(layout.upgradeCheckPath, {
        readFile: (p) => storage[p],
      });

      expect(read).toEqual(cache);
    });

    test("isCheckCacheFresh enforces 24h TTL", () => {
      const now = new Date("2026-08-24T12:00:00.000Z").getTime();
      const fresh = {
        checked_at: new Date(now - 12 * 3600 * 1000).toISOString(),
        current_version: "1.0.0",
        latest_version: "1.1.0",
      };
      const stale = {
        checked_at: new Date(now - 25 * 3600 * 1000).toISOString(),
        current_version: "1.0.0",
        latest_version: "1.1.0",
      };

      expect(isCheckCacheFresh(fresh, now)).toBe(true);
      expect(isCheckCacheFresh(stale, now)).toBe(false);
      expect(isCheckCacheFresh(undefined, now)).toBe(false);
    });
  });

  describe("1.5 Reconcile step execution", () => {
    test("reconcileUpgrade runs skills sync, MCP verification, migrations, and doctor check", async () => {
      let skillsSynced = false;
      let mcpVerified = false;
      let storeMigrated = false;
      let daemonsReloaded = false;
      let sdkEnsured = false;
      const order: string[] = [];

      const result = await reconcileUpgrade({
        home,
        syncSkills: async () => {
          skillsSynced = true;
          return { synced: ["SKILL.md"], errors: [] };
        },
        verifyMcp: async () => {
          mcpVerified = true;
          return { ok: true };
        },
        migrateStore: async () => {
          storeMigrated = true;
          return { ok: true, version: 3 };
        },
        reloadDaemons: async () => {
          daemonsReloaded = true;
          order.push("reload");
          return { reloaded: ["watch"] };
        },
        ensureOpenCodeSdk: async () => {
          sdkEnsured = true;
          order.push("sdk");
        },
        runDoctorCheck: async () => {
          order.push("doctor");
          return { overall: "healthy" };
        },
      });

      expect(result.ok).toBe(true);
      expect(skillsSynced).toBe(true);
      expect(mcpVerified).toBe(true);
      expect(storeMigrated).toBe(true);
      expect(daemonsReloaded).toBe(true);
      expect(sdkEnsured).toBe(true);
      expect(order).toEqual(["reload", "sdk", "doctor"]);
    });
  });
});

const OPENCODE_ROUTING = {
  default: { backend: "opencode", provider: "opencode" },
};
const CLAUDE_ROUTING = {
  default: { backend: "claude-code", provider: "anthropic" },
};

async function withHome(
  routing: unknown | undefined,
  raw?: string,
): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), "prhero-reconcile-"));
  const layout = prheroLayout(home);
  await mkdir(layout.dir, { recursive: true });
  if (raw !== undefined) {
    await writeFile(layout.reviewConfigPath, raw);
  } else if (routing !== undefined) {
    await writeFile(layout.reviewConfigPath, JSON.stringify({ routing }));
  }
  return {
    home,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

function quietReconcile(
  home: string,
  overrides: ReconcileUpgradeOptions = {},
): Promise<{ ok: boolean; errors: string[] }> {
  return reconcileUpgrade({
    home,
    syncSkills: async () => ({ synced: [], errors: [] }),
    verifyMcp: async () => ({ ok: true }),
    migrateStore: async () => ({ ok: true }),
    reloadDaemons: async () => ({ reloaded: [] }),
    runDoctorCheck: async () => ({ overall: "healthy" }),
    which: () => null,
    spawnInstaller: async () => {
      throw new Error("spawn should not run");
    },
    ...overrides,
  });
}

describe("selectOpenCodeSdkInstaller", () => {
  const spec = `@opencode-ai/sdk@${SUPPORTED_OPENCODE_SDK_VERSION}`;

  test("prefers npm and pins the spec under the product home", () => {
    expect(
      selectOpenCodeSdkInstaller({
        npmPath: "/usr/bin/npm",
        bunPath: "/usr/bin/bun",
        layoutDir: "/Users/x/.prhero",
      }),
    ).toEqual([
      "/usr/bin/npm",
      "install",
      "--ignore-scripts",
      "--no-fund",
      "--no-audit",
      "--prefix",
      "/Users/x/.prhero",
      spec,
    ]);
  });

  test("falls back to bun add with scripts ignored and an exact pin", () => {
    expect(
      selectOpenCodeSdkInstaller({
        npmPath: null,
        bunPath: "/usr/bin/bun",
        layoutDir: "/Users/x/.prhero",
      }),
    ).toEqual([
      "/usr/bin/bun",
      "add",
      "--exact",
      "--ignore-scripts",
      "--cwd",
      "/Users/x/.prhero",
      spec,
    ]);
  });

  test("neither package manager is an error that names reconcile", () => {
    expect(() =>
      selectOpenCodeSdkInstaller({
        npmPath: null,
        bunPath: null,
        layoutDir: "/Users/x/.prhero",
      }),
    ).toThrow(/neither npm nor bun is on PATH/);
    expect(() =>
      selectOpenCodeSdkInstaller({
        npmPath: null,
        bunPath: null,
        layoutDir: "/Users/x/.prhero",
      }),
    ).toThrow(/crysk upgrade --reconcile/);
  });
});

describe("spawnOpenCodeSdkInstaller", () => {
  test("rejects a child that never exits and omits the prefix from the error", async () => {
    const error = await spawnOpenCodeSdkInstaller(
      ["/bin/sleep", "30"],
      40,
    ).then(
      () => {
        throw new Error("installer resolved");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).toContain("timed out after 40ms");
    expect(error.message).toContain("crysk upgrade --reconcile");
    expect(error.message).not.toContain("/bin/sleep");
  });
});

describe("reconcileUpgrade installs the OpenCode SDK only when routing needs it", () => {
  test("Claude-only routing does not spawn", async () => {
    const fixture = await withHome(CLAUDE_ROUTING);
    try {
      let spawned = false;
      const result = await quietReconcile(fixture.home, {
        readSdkVersion: async () => undefined,
        spawnInstaller: async () => {
          spawned = true;
          return { code: 0, stderr: "" };
        },
      });
      expect(spawned).toBe(false);
      expect(result.ok).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test("OpenCode routing with a missing SDK installs via npm before doctor", async () => {
    const fixture = await withHome(OPENCODE_ROUTING);
    const layout = prheroLayout(fixture.home);
    try {
      let installed = false;
      let doctorSawInstall = false;
      let reads = 0;
      let argv: readonly string[] = [];
      const result = await quietReconcile(fixture.home, {
        readSdkVersion: async () => {
          reads += 1;
          return reads < 3 ? undefined : "1.18.25";
        },
        which: (bin) => (bin === "npm" ? "/usr/bin/npm" : null),
        spawnInstaller: async (next) => {
          installed = true;
          argv = next;
          return { code: 0, stderr: "" };
        },
        runDoctorCheck: async () => {
          doctorSawInstall = installed;
          return { overall: "healthy" };
        },
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(doctorSawInstall).toBe(true);
      expect(reads).toBe(3);
      expect(argv).toContain(
        `@opencode-ai/sdk@${SUPPORTED_OPENCODE_SDK_VERSION}`,
      );
      expect(argv).toContain("--ignore-scripts");
      expect(argv[argv.indexOf("--prefix") + 1]).toBe(layout.dir);
    } finally {
      await fixture.cleanup();
    }
  });

  test("OpenCode routing that already has the pinned SDK does not spawn", async () => {
    const fixture = await withHome(OPENCODE_ROUTING);
    try {
      let spawned = false;
      const result = await quietReconcile(fixture.home, {
        readSdkVersion: async () => "1.18.25",
        spawnInstaller: async () => {
          spawned = true;
          return { code: 0, stderr: "" };
        },
      });
      expect(spawned).toBe(false);
      expect(result.ok).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test("compiled mode reads the SDK from the reconcile home and does not spawn", async () => {
    const fixture = await withHome(OPENCODE_ROUTING);
    const packageDir = path.join(
      prheroLayout(fixture.home).nodeModulesDir,
      "@opencode-ai",
      "sdk",
    );
    try {
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          version: "1.18.25",
          exports: { "./v2": { import: "./dist/v2/index.js" } },
        }),
      );
      let spawned = false;
      const result = await quietReconcile(fixture.home, {
        assetMode: "compiled",
        which: (bin) => (bin === "npm" ? "/usr/bin/npm" : null),
        spawnInstaller: async () => {
          spawned = true;
          throw new Error("spawn should not run");
        },
      });
      expect(spawned).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("no npm and no bun reports both and does not spawn", async () => {
    const fixture = await withHome(OPENCODE_ROUTING);
    try {
      let spawned = false;
      let doctorRan = false;
      const result = await quietReconcile(fixture.home, {
        readSdkVersion: async () => undefined,
        which: () => null,
        spawnInstaller: async () => {
          spawned = true;
          return { code: 0, stderr: "" };
        },
        runDoctorCheck: async () => {
          doctorRan = true;
          return { overall: "healthy" };
        },
      });
      expect(spawned).toBe(false);
      expect(doctorRan).toBe(true);
      expect(result.ok).toBe(false);
      const text = result.errors.join("\n");
      expect(text).toContain("neither npm nor bun is on PATH");
      expect(text).toContain("crysk upgrade --reconcile");
    } finally {
      await fixture.cleanup();
    }
  });

  test("routing.disabled with an OpenCode default does not spawn", async () => {
    const fixture = await withHome({
      disabled: true,
      default: OPENCODE_ROUTING.default,
    });
    try {
      let spawned = false;
      const result = await quietReconcile(fixture.home, {
        readSdkVersion: async () => undefined,
        spawnInstaller: async () => {
          spawned = true;
          return { code: 0, stderr: "" };
        },
      });
      expect(spawned).toBe(false);
      expect(result.ok).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test("a malformed config is an error and does not spawn", async () => {
    const fixture = await withHome(undefined, "{");
    try {
      let spawned = false;
      let doctorRan = false;
      const result = await quietReconcile(fixture.home, {
        spawnInstaller: async () => {
          spawned = true;
          return { code: 0, stderr: "" };
        },
        runDoctorCheck: async () => {
          doctorRan = true;
          return { overall: "healthy" };
        },
      });
      expect(spawned).toBe(false);
      expect(doctorRan).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("not valid JSON");
    } finally {
      await fixture.cleanup();
    }
  });

  test("a live install lock refuses a second reconcile and hides the home", async () => {
    const fixture = await withHome(OPENCODE_ROUTING);
    const lockPath = path.join(
      prheroLayout(fixture.home).dir,
      "opencode-sdk.lock",
    );
    try {
      await writeFile(lockPath, `${process.pid}\n`);
      let spawned = false;
      const result = await quietReconcile(fixture.home, {
        readSdkVersion: async () => undefined,
        spawnInstaller: async () => {
          spawned = true;
          return { code: 0, stderr: "" };
        },
      });
      expect(spawned).toBe(false);
      expect(result.ok).toBe(false);
      const text = result.errors.join("\n");
      expect(text).toContain("already running");
      expect(text).toContain(`pid ${process.pid}`);
      expect(text).not.toContain(fixture.home);
    } finally {
      await fixture.cleanup();
    }
  });

  test("a dead install lock is taken and the install still runs", async () => {
    const fixture = await withHome(OPENCODE_ROUTING);
    const lockPath = path.join(
      prheroLayout(fixture.home).dir,
      "opencode-sdk.lock",
    );
    const held = Bun.spawn(["/bin/sleep", "30"]);
    held.kill();
    await held.exited;
    try {
      await writeFile(lockPath, `${held.pid}\n`);
      let spawned = false;
      const result = await quietReconcile(fixture.home, {
        readSdkVersion: async () => (spawned ? "1.18.25" : undefined),
        which: (bin) => (bin === "npm" ? "/usr/bin/npm" : null),
        spawnInstaller: async () => {
          spawned = true;
          return { code: 0, stderr: "" };
        },
      });
      expect(spawned).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("the lock holds the pid before the installer runs", async () => {
    const fixture = await withHome(OPENCODE_ROUTING);
    const lockPath = path.join(
      prheroLayout(fixture.home).dir,
      "opencode-sdk.lock",
    );
    try {
      let pidText = "";
      const result = await quietReconcile(fixture.home, {
        readSdkVersion: async () => (pidText === "" ? undefined : "1.18.25"),
        which: (bin) => (bin === "npm" ? "/usr/bin/npm" : null),
        spawnInstaller: async () => {
          pidText = await Bun.file(lockPath).text();
          return { code: 0, stderr: "" };
        },
      });
      expect(pidText.trim()).toBe(String(process.pid));
      expect(result.ok).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test("an EEXIST from the installer is reported once", async () => {
    const fixture = await withHome(OPENCODE_ROUTING);
    try {
      let calls = 0;
      const result = await quietReconcile(fixture.home, {
        readSdkVersion: async () => undefined,
        which: (bin) => (bin === "npm" ? "/usr/bin/npm" : null),
        spawnInstaller: async () => {
          calls += 1;
          const error = new Error("collision") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        },
      });
      expect(calls).toBe(1);
      expect(result.ok).toBe(false);
      const text = result.errors.join("\n");
      expect(text).toContain("collision");
      expect(text).not.toContain("already running");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("reconcile re-registers the MCP server", () => {
  test("moves a pre-rename pr-hero entry to the crysk key", async () => {
    const fixture = await withHome(undefined);
    try {
      const mcpPath = path.join(fixture.home, ".claude", "mcp.json");
      await mkdir(path.dirname(mcpPath), { recursive: true });
      await writeFile(
        mcpPath,
        JSON.stringify({
          mcpServers: {
            "pr-hero": { command: "/old/pr-hero", args: ["mcp"], timeout: 9 },
          },
        }),
      );

      // No verifyMcp: the default path is the one that registers.
      const result = await quietReconcile(fixture.home, {
        verifyMcp: undefined,
      });

      expect(result.errors).toEqual([]);
      const self = selfInvocation();
      const parsed = JSON.parse(await readFile(mcpPath, "utf-8"));
      expect(parsed.mcpServers).toEqual({
        crysk: {
          command: self.command,
          args: [...self.args, "mcp"],
          timeout: 9,
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
