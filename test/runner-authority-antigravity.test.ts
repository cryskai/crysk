// odd/tasks/antigravity-oauth.md T2 (S4): the antigravity backend has a
// credential kind of its own, but no binding, transport or broker yet (T3-T4).
// Until then an `agy:` plan must be refused before anything spends, and never
// run on another backend.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createResolvedRoutePlan,
  resolveStepRoute,
} from "../src/model/routing";
import { createProductionRuntime } from "../src/production-runtime";
import {
  credentialKindBillsMetered,
  credentialKindForRoute,
  prepareProductionRunnerAuthority,
  resolveBindingAuthority,
  withAgyDiscoveryAllowlist,
} from "../src/runner-authority";
import { AgyCredentialBroker } from "../src/security/credential-broker";
import { DefaultTransportRegistry } from "../src/transport-registry";

// #303: verifying the Claude fixture snapshots it under os.tmpdir(), so a
// per-file TMPDIR keeps it away from the operator's real snapshot base, as in
// production-runtime.test.ts.
let originalTmpdir: string | undefined;
let isolatedTmpdir = "";
beforeAll(async () => {
  originalTmpdir = process.env.TMPDIR;
  isolatedTmpdir = await mkdtemp(path.join(tmpdir(), "crysk-agy-tmpdir-"));
  process.env.TMPDIR = isolatedTmpdir;
});
afterAll(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(isolatedTmpdir, { recursive: true, force: true });
});

describe("antigravity credential kind (S4)", () => {
  test("an antigravity route binds the Google subscription OAuth kind", () => {
    expect(credentialKindForRoute("antigravity", "google")).toBe(
      "antigravity_subscription_oauth",
    );
  });

  test("the subscription kind is not metered", () => {
    expect(credentialKindBillsMetered("antigravity_subscription_oauth")).toBe(
      false,
    );
    expect(credentialKindBillsMetered("provider_api_token")).toBe(true);
  });

  test("codex still has no credential authority", () => {
    expect(() => credentialKindForRoute("codex", "openai")).toThrow(
      'No credential authority is bound for backend "codex"',
    );
  });

  test("claude-code and opencode kinds are unchanged", () => {
    expect(credentialKindForRoute("claude-code", "anthropic")).toBe(
      "claude_subscription_oauth",
    );
    expect(credentialKindForRoute("opencode", "openai")).toBe(
      "opencode_chatgpt_oauth",
    );
    expect(credentialKindForRoute("opencode", "deepseek")).toBe(
      "provider_api_token",
    );
  });
});

describe("an agy plan fails closed until its transport exists (S4)", () => {
  test("binding authority refuses antigravity by name", async () => {
    const result = await resolveBindingAuthority("antigravity", "google", {
      workspaceRoot: tmpdir(),
    });
    expect(result.binding).toBeUndefined();
    expect(result.error).toBe(
      "the antigravity backend (agy: models) is not available yet: Crysk cannot run an agy: model in this version, so choose a claude: or opencode: model",
    );
  });

  test("codex keeps its refusal byte for byte", async () => {
    const result = await resolveBindingAuthority("codex", "openai", {
      workspaceRoot: tmpdir(),
    });
    expect(result.error).toBe('unsupported production backend "codex" in PR1');
  });

  let workspace = "";
  let claude = { canonicalPath: "", sha256: "" };
  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "crysk-agy-admission-"));
    // A verifiable Claude executable, so a Claude route binds and the agy
    // route's own refusal is what stops the plan, whichever comes first.
    const bytes = Buffer.concat([
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
      Buffer.from("#!/bin/sh\nexit 0\n"),
    ]);
    const claudePath = path.join(workspace, "claude");
    await writeFile(claudePath, bytes);
    await chmod(claudePath, 0o755);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    claude = {
      canonicalPath: await realpath(claudePath),
      sha256: hasher.digest("hex"),
    };
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  // T4 registers the transport, so the route reaches its executable check: a
  // runtime with no verified agy still refuses the plan before anything runs.
  test("a runtime for a plan naming agy, first or as a fallback, with no verified agy is refused", async () => {
    for (const models of [
      ["agy:gemini-4-argon-high", "claude:sonnet-latest"],
      ["claude:sonnet-latest", "agy:gemini-4-argon-high"],
    ]) {
      const step = resolveStepRoute({
        stepKey: "hunter-logic",
        role: "hunter",
        modelRole: "hunter.logic",
        models: { "hunter.logic": models },
      });
      const plan = createResolvedRoutePlan([step]);
      let error: unknown;
      try {
        const runtime = await createProductionRuntime({
          workspaceRoot: workspace,
          plan,
          mode: "production",
          binaryPath: claude.canonicalPath,
          executableAllowlists: {
            "claude-code": [
              { absolutePath: claude.canonicalPath, sha256: claude.sha256 },
            ],
          },
        });
        await runtime.dispose();
      } catch (caught) {
        error = caught;
      }
      expect(error, models.join(",")).toBeInstanceOf(Error);
      expect((error as Error).message, models.join(",")).toContain(
        "executable allowlist required for antigravity binding authority",
      );
      expect((error as Error).message, models.join(",")).not.toContain(
        "not available yet",
      );
    }
  });
});

// odd/tasks/antigravity-oauth.md T3 (S5): the antigravity binding, its broker
// and its executable authority. It binds only when an `antigravity` transport
// is registered (T4); without one the T2 refusal above still stands.
describe("antigravity binding authority (T3)", () => {
  let dir = "";
  let agy = { absolutePath: "", sha256: "" };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "crysk-agy-bin-"));
    const bytes = Buffer.from("#!/bin/sh\nexit 0\n");
    const agyPath = path.join(dir, "agy");
    await writeFile(agyPath, bytes);
    await chmod(agyPath, 0o755);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    agy = {
      absolutePath: await realpath(agyPath),
      sha256: hasher.digest("hex"),
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("binds the Google subscription kind, its ref, bucket and broker when the transport is registered", async () => {
    const result = await resolveBindingAuthority("antigravity", "google", {
      workspaceRoot: dir,
      env: {},
      antigravityBinaryPath: agy.absolutePath,
      executableAllowlists: { antigravity: [agy] },
      isTransportRegistered: (backend) => backend === "antigravity",
    });
    expect(result.error).toBeUndefined();
    expect(result.binding?.backend).toBe("antigravity");
    expect(result.binding?.binaryPath).toBe(agy.absolutePath);
    expect(result.binding?.credentialKind).toBe(
      "antigravity_subscription_oauth",
    );
    expect(result.binding?.credentialRef).toBe("antigravity-oauth");
    expect(result.binding?.bucketId).toBe("antigravity");
    expect(result.binding?.credentialBroker).toBeInstanceOf(
      AgyCredentialBroker,
    );
    expect(result.binding?.executableAllowlist).toEqual([agy]);
  });

  test("an injected antigravity broker is the one bound", async () => {
    const broker = new AgyCredentialBroker({ readerFn: async () => "{}" });
    const result = await resolveBindingAuthority("antigravity", "google", {
      workspaceRoot: dir,
      antigravityBinaryPath: agy.absolutePath,
      executableAllowlists: { antigravity: [agy] },
      credentialBrokers: { antigravity: broker },
      isTransportRegistered: () => true,
    });
    expect(result.binding?.credentialBroker).toBe(broker);
  });

  test("with no registered transport the T2 refusal stands, even with a verified binary", async () => {
    for (const isTransportRegistered of [undefined, () => false]) {
      const result = await resolveBindingAuthority("antigravity", "google", {
        workspaceRoot: dir,
        antigravityBinaryPath: agy.absolutePath,
        executableAllowlists: { antigravity: [agy] },
        ...(isTransportRegistered === undefined
          ? {}
          : { isTransportRegistered }),
      });
      expect(result.binding).toBeUndefined();
      expect(result.error).toBe(
        "the antigravity backend (agy: models) is not available yet: Crysk cannot run an agy: model in this version, so choose a claude: or opencode: model",
      );
    }
  });

  test("an agy binary outside the allowlist is refused", async () => {
    const result = await resolveBindingAuthority("antigravity", "google", {
      workspaceRoot: dir,
      antigravityBinaryPath: agy.absolutePath,
      executableAllowlists: {
        antigravity: [
          { absolutePath: agy.absolutePath, sha256: "0".repeat(64) },
        ],
      },
      isTransportRegistered: () => true,
    });
    expect(result.binding).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  test("never falls back to the Claude binary override", async () => {
    const result = await resolveBindingAuthority("antigravity", "google", {
      workspaceRoot: dir,
      binaryPath: agy.absolutePath,
      env: { PATH: "" },
      executableAllowlists: { antigravity: [agy] },
      isTransportRegistered: () => true,
    });
    expect(result.error).toBe("agy binary not found on PATH");
  });

  test("discovery resolves agy on PATH to its realpath and sha256", async () => {
    const resolved = await withAgyDiscoveryAllowlist({
      workspaceRoot: dir,
      env: { PATH: `/nonexistent${path.delimiter}${dir}` },
    });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;
    expect(resolved.antigravityBinaryPath).toBe(agy.absolutePath);
    expect(resolved.executableAllowlists?.antigravity).toEqual([agy]);
  });

  test("discovery refuses a missing agy and a relative override", async () => {
    expect(
      await withAgyDiscoveryAllowlist({
        workspaceRoot: dir,
        env: { PATH: "" },
      }),
    ).toEqual({ error: "agy binary not found on PATH" });
    expect(
      await withAgyDiscoveryAllowlist({
        workspaceRoot: dir,
        antigravityBinaryPath: "bin/agy",
      }),
    ).toEqual({ error: "binary override must be an absolute path: bin/agy" });
  });

  test("a plan naming agy, even only as a fallback, resolves its executable", async () => {
    const step = resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      modelRole: "hunter.logic",
      models: {
        "hunter.logic": ["opencode:deepseek/v4", "agy:gemini-4-argon-high"],
      },
    });
    const opencodeBytes = Buffer.from("#!/bin/sh\nexit 0\n# opencode\n");
    await writeFile(path.join(dir, "opencode"), opencodeBytes);
    await chmod(path.join(dir, "opencode"), 0o755);
    const options = await prepareProductionRunnerAuthority(
      dir,
      createResolvedRoutePlan([step]),
      {},
      { env: { PATH: dir } },
    );
    expect("error" in options).toBe(false);
    if ("error" in options) return;
    expect(options.executableAllowlists?.antigravity).toEqual([agy]);
    expect(options.executableAllowlists?.opencode?.length).toBe(1);
  });

  test("a plan without agy resolves no agy executable", async () => {
    const step = resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      modelRole: "hunter.logic",
      models: { "hunter.logic": ["opencode:deepseek/v4"] },
    });
    await writeFile(path.join(dir, "opencode"), "#!/bin/sh\n");
    await chmod(path.join(dir, "opencode"), 0o755);
    const options = await prepareProductionRunnerAuthority(
      dir,
      createResolvedRoutePlan([step]),
      {},
      { env: { PATH: dir } },
    );
    if ("error" in options) throw new Error(options.error);
    expect(options.executableAllowlists?.antigravity).toBeUndefined();
    expect(options.antigravityBinaryPath).toBeUndefined();
  });
});

describe("the runtime binds an agy route through its registry (T3)", () => {
  test("a registry with an antigravity transport lifts the T2 refusal", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crysk-agy-runtime-"));
    try {
      const bytes = Buffer.from("#!/bin/sh\nexit 0\n");
      const agyPath = path.join(dir, "agy");
      await writeFile(agyPath, bytes);
      await chmod(agyPath, 0o755);
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(bytes);
      const entry = {
        absolutePath: await realpath(agyPath),
        sha256: hasher.digest("hex"),
      };
      const step = resolveStepRoute({
        stepKey: "hunter-logic",
        role: "hunter",
        modelRole: "hunter.logic",
        models: { "hunter.logic": ["agy:gemini-4-argon-high"] },
      });
      const registry = new DefaultTransportRegistry();
      let factoryCalls = 0;
      registry.register("antigravity", () => {
        factoryCalls++;
        throw new Error("fake antigravity transport reached");
      });
      let error: unknown;
      try {
        const runtime = await createProductionRuntime({
          workspaceRoot: dir,
          plan: createResolvedRoutePlan([step]),
          mode: "production",
          registry,
          antigravityBinaryPath: entry.absolutePath,
          executableAllowlists: { antigravity: [entry] },
        });
        await runtime.dispose();
      } catch (caught) {
        error = caught;
      }
      // Bound: the run went past binding authority to the registered transport.
      expect(String(error)).not.toContain("not available yet");
      expect(factoryCalls).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
