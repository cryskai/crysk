import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFreeModelProbe,
  defaultRun,
  freeVerdictKey,
  isFreeModel,
} from "#model/free-discovery";
import { exactBindingCapabilityIssues } from "#model/provider-capabilities";
import { createResolvedRoutePlan, resolveStepRoute } from "#model/routing";
import type {
  ProviderCapabilityReport,
  RunnerBackend,
} from "../src/execution/contracts";
import {
  createProductionRuntime,
  d1_11EvidenceFromExactBinding,
  planOpenCodeCredentials,
  prepareProductionAdmissionContext,
  probeBindingsReadiness,
  productionFallbackRegistry,
  soleOpenCodeCredentialOf,
} from "../src/production-runtime";
import {
  credentialKindBillsMetered,
  credentialKindForRoute,
  openCodeCredentialBroker,
  openCodeCredentialBrokerForKind,
} from "../src/runner-authority";
import {
  CredentialProjectionError,
  OpenCodeApiTokenBroker,
  OpenCodeAuthBroker,
  OpenCodeFreeBroker,
} from "../src/security/credential-broker";
import {
  createDefaultTransportRegistry,
  DefaultTransportRegistry,
  openCodeLaunchServerFor,
} from "../src/transport-registry";

async function writeOpenCodeFixture(
  dir: string,
  version = "1.18.30",
): Promise<{ canonicalPath: string; sha256: string }> {
  const p = path.join(dir, "opencode");
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "${version}"\n  exit 0\nfi\nexit 0\n`;
  const bytes = Buffer.from(script);
  await writeFile(p, bytes);
  await chmod(p, 0o755);
  const canonicalPath = await realpath(p);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { canonicalPath, sha256: hasher.digest("hex") };
}

// The run's OpenCode auth file, with the `opencode` API record a metered route of
// that provider needs: admission refuses a non-free route whose provider has no
// record (openCodeCredentialRefusal, production-runtime.ts).
async function writeOpenCodeAuth(dir: string): Promise<string> {
  const dataHome = path.join(dir, "xdg-auth");
  await mkdir(path.join(dataHome, "opencode"), { recursive: true });
  await writeFile(
    path.join(dataHome, "opencode", "auth.json"),
    JSON.stringify({ opencode: { type: "api", key: "k" } }),
  );
  return dataHome;
}

function freeStdout(
  provider: string,
  model: string,
  overrides: {
    status?: unknown;
    input?: unknown;
    output?: unknown;
    read?: unknown;
    write?: unknown;
    omitCost?: boolean;
    omitCache?: boolean;
  } = {},
): string {
  const cost = overrides.omitCost
    ? ""
    : `,\n  "cost": ${
        overrides.omitCache
          ? `{"input": ${overrides.input ?? 0}, "output": ${overrides.output ?? 0}}`
          : `{"input": ${overrides.input ?? 0}, "output": ${overrides.output ?? 0}, "cache": {"read": ${overrides.read ?? 0}, "write": ${overrides.write ?? 0}}}`
      }`;
  return `${provider}/${model}\n{\n  "id": "${model}",\n  "providerID": "${provider}",\n  "status": ${JSON.stringify(overrides.status ?? "active")}${cost}\n}\n`;
}

// `_logical` is the name the step used to be routed from; the model name now
// carries the backend, so the route comes from provider and model alone.
function opencodeStep(
  stepKey: string,
  _logical: string,
  provider: string,
  modelSnapshot: string,
) {
  return resolveStepRoute({
    stepKey,
    role: "hunter",
    cliModel: `opencode:${provider}/${modelSnapshot}`,
  });
}

function mockOpencodeTransport() {
  return {
    backend: "opencode" as const,
    capabilities: async (): Promise<ProviderCapabilityReport> => ({
      backend: "opencode",
      status: "ready" as const,
      auth: {
        kind: "opencode_chatgpt_oauth" as const,
        projectionReady: true,
        probe: "passed" as const,
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: true,
        codegraphPolicy: true,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: true,
        usageMode: "snapshot" as const,
      },
      cancellation: { deadlineMs: 5000, conformance: "passed" as const },
      billing: { mode: "subscription" as const, pricingReady: true },
      issues: [],
    }),
    execute: async () => {
      throw new Error("not used");
    },
    classifyFailure: () => undefined,
  };
}

describe("#182 provider_free kind", () => {
  test("credentialKindBillsMetered is false for provider_free (explicit pin, not metered)", () => {
    expect(credentialKindBillsMetered("provider_free")).toBe(false);
    expect(credentialKindBillsMetered("provider_api_token")).toBe(true);
    expect(credentialKindBillsMetered("opencode_chatgpt_oauth")).toBe(false);
    expect(credentialKindBillsMetered("claude_subscription_oauth")).toBe(false);
  });

  test("kind-based broker selection: free/api/oauth", () => {
    expect(
      openCodeCredentialBrokerForKind("provider_free", "opencode"),
    ).toBeInstanceOf(OpenCodeFreeBroker);
    expect(
      openCodeCredentialBrokerForKind("provider_api_token", "zai"),
    ).toBeInstanceOf(OpenCodeApiTokenBroker);
    expect(
      openCodeCredentialBrokerForKind("opencode_chatgpt_oauth", "openai"),
    ).toBeInstanceOf(OpenCodeAuthBroker);
  });

  test("provider-keyed default still resolves opencode provider to metered pre-probe; #169 zai-coding-plan untouched", () => {
    expect(credentialKindForRoute("opencode", "opencode")).toBe(
      "provider_api_token",
    );
    expect(credentialKindForRoute("opencode", "zai-coding-plan")).toBe(
      "provider_api_token",
    );
    expect(credentialKindForRoute("opencode", "zai")).toBe(
      "provider_api_token",
    );
    expect(credentialKindForRoute("opencode", "openai")).toBe(
      "opencode_chatgpt_oauth",
    );
    expect(openCodeCredentialBroker("zai-coding-plan")).toBeInstanceOf(
      OpenCodeApiTokenBroker,
    );
  });
});

describe("#182 OpenCodeFreeBroker", () => {
  test("projects an empty projection with no auth file", async () => {
    // #280: the constructor now takes a provider, matching
    // OpenCodeApiTokenBroker — but a provider with no auth.json at all
    // still projects the exact empty tree #182 always produced.
    const broker = new OpenCodeFreeBroker("opencode");
    const projection = await broker.project({
      sessionId: "s",
      credentialRef: "opencode-auth:opencode",
      kind: "provider_free",
      verifiedBinaryPath: "/fake/opencode",
    });
    try {
      expect(projection.kind).toBe("provider_free");
      expect(projection.files).toEqual([]);
      expect(projection.env.HOME).toBe(projection.syntheticHome);
      expect(projection.env.TMPDIR).toBe(projection.syntheticTmp);
      expect(projection.env.XDG_DATA_HOME).toContain(projection.syntheticHome);
      expect(projection.env.XDG_CONFIG_HOME).toContain(
        projection.syntheticHome,
      );
      const authFile = path.join(
        projection.syntheticHome,
        ".local",
        "share",
        "opencode",
        "auth.json",
      );
      expect(existsSync(authFile)).toBe(false);
    } finally {
      await projection.destroy();
    }
    expect(existsSync(projection.syntheticHome)).toBe(false);
  });

  test("refuses any other kind by name", async () => {
    const broker = new OpenCodeFreeBroker("opencode");
    for (const kind of [
      "provider_api_token",
      "opencode_chatgpt_oauth",
      "claude_subscription_oauth",
    ] as const) {
      let error: unknown;
      try {
        await broker.project({
          sessionId: "s",
          credentialRef: "opencode-auth:opencode",
          kind,
          verifiedBinaryPath: "/fake/opencode",
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(kind);
      expect((error as Error).message).toContain("OpenCodeFreeBroker");
      // Never the degrading class: harness.ts degrades exactly
      // missing_subscription_record to operator env.
      if (error instanceof CredentialProjectionError) {
        expect(error.failureClass).not.toBe("missing_subscription_record");
      }
    }
  });
});

// #280: `openCodeCredentialBrokerForKind` now threads the provider into
// OpenCodeFreeBroker's constructor (production-runtime.ts's
// `needsFreeDefault` path, wired after the #182 probe swap). This proves the
// factory binds the RIGHT provider — not a shared default, and not the
// first provider constructed — by pointing two independently-built brokers
// at the same real auth.json and checking each reads only its own key.
describe("#280 openCodeCredentialBrokerForKind binds provider_free to the given provider", () => {
  test("the wired broker reads that provider's own record, and a different provider stays empty", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-bound-"));
    const priorXdgDataHome = process.env.XDG_DATA_HOME;
    try {
      const authDir = path.join(tmpDir, "opencode");
      await mkdir(authDir, { recursive: true });
      await writeFile(
        path.join(authDir, "auth.json"),
        JSON.stringify({
          "zai-coding-plan": { type: "api", key: "ZAI-KEY-test-fake" },
          openai: { type: "oauth", access: "AT-openai-test-fake" },
        }),
      );
      process.env.XDG_DATA_HOME = tmpDir;

      const bound = openCodeCredentialBrokerForKind(
        "provider_free",
        "zai-coding-plan",
      );
      expect(bound).toBeInstanceOf(OpenCodeFreeBroker);
      const projection = await bound.project({
        sessionId: "s",
        credentialRef: "opencode-auth:zai-coding-plan",
        kind: "provider_free",
        verifiedBinaryPath: "/fake/opencode",
      });
      try {
        expect(projection.files).toHaveLength(1);
      } finally {
        await projection.destroy();
      }

      const differentProvider = openCodeCredentialBrokerForKind(
        "provider_free",
        "mistral",
      );
      const emptyProjection = await differentProvider.project({
        sessionId: "s",
        credentialRef: "opencode-auth:mistral",
        kind: "provider_free",
        verifiedBinaryPath: "/fake/opencode",
      });
      try {
        expect(emptyProjection.files).toEqual([]);
      } finally {
        await emptyProjection.destroy();
      }
    } finally {
      if (priorXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorXdgDataHome;
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("#182 isFreeModel strict predicate (live shape, fake spawn)", () => {
  test("true for all-zero active; argv carries --refresh", async () => {
    let seenArgv: readonly string[] = [];
    const ok = await isFreeModel({
      binaryPath: "/fake/opencode",
      provider: "opencode",
      model: "muse-spark-1.3-contributor-free",
      run: async (argv) => {
        seenArgv = argv;
        return {
          exitCode: 0,
          stdout: freeStdout("opencode", "muse-spark-1.3-contributor-free"),
        };
      },
    });
    expect(ok).toBe(true);
    expect([...seenArgv]).toEqual([
      "/fake/opencode",
      "models",
      "opencode",
      "--verbose",
      "--refresh",
    ]);
  });

  test("false for paid leaves (zai/glm-4.5 shape)", async () => {
    const ok = await isFreeModel({
      binaryPath: "/fake/opencode",
      provider: "zai",
      model: "glm-4.5",
      run: async () => ({
        exitCode: 0,
        stdout:
          `zai/glm-4.5\n` +
          JSON.stringify({
            id: "glm-4.5",
            providerID: "zai",
            status: "active",
            cost: { input: 0.6, output: 2.2, cache: { read: 0.11, write: 0 } },
          }),
      }),
    });
    expect(ok).toBe(false);
  });

  test("false for every single non-zero leaf, inactive status, missing fields", async () => {
    const base = {
      binaryPath: "/fake/opencode",
      provider: "opencode",
      model: "m",
    } as const;
    for (const overrides of [
      { input: 0.01 },
      { output: 0.01 },
      { read: 0.01 },
      { write: 0.01 },
      { status: "inactive" },
      { omitCost: true },
      { omitCache: true },
    ]) {
      const ok = await isFreeModel({
        ...base,
        run: async () => ({
          exitCode: 0,
          stdout: freeStdout("opencode", "m", overrides),
        }),
      });
      expect(ok).toBe(false);
    }
  });

  test("fail closed: spawn error, non-zero exit, bad JSON, missing header, relative binary", async () => {
    expect(
      await isFreeModel({
        binaryPath: "/fake/opencode",
        provider: "opencode",
        model: "m",
        run: async () => {
          throw new Error("no binary");
        },
      }),
    ).toBe(false);
    expect(
      await isFreeModel({
        binaryPath: "/fake/opencode",
        provider: "opencode",
        model: "m",
        run: async () => ({ exitCode: 1, stdout: "" }),
      }),
    ).toBe(false);
    expect(
      await isFreeModel({
        binaryPath: "/fake/opencode",
        provider: "opencode",
        model: "m",
        run: async () => ({
          exitCode: 0,
          stdout: "opencode/m\n{ not json",
        }),
      }),
    ).toBe(false);
    expect(
      await isFreeModel({
        binaryPath: "/fake/opencode",
        provider: "opencode",
        model: "wanted",
        run: async () => ({
          exitCode: 0,
          stdout: freeStdout("opencode", "other"),
        }),
      }),
    ).toBe(false);
    expect(
      await isFreeModel({
        binaryPath: "relative/opencode",
        provider: "opencode",
        model: "m",
        run: async () => ({
          exitCode: 0,
          stdout: freeStdout("opencode", "m"),
        }),
      }),
    ).toBe(false);
  });

  test("header splits on FIRST slash so model ids containing / match exactly", async () => {
    const ok = await isFreeModel({
      binaryPath: "/fake/opencode",
      provider: "opencode",
      model: "a/b",
      run: async () => ({
        exitCode: 0,
        stdout: freeStdout("opencode", "a/b"),
      }),
    });
    expect(ok).toBe(true);
    const wrongProvider = await isFreeModel({
      binaryPath: "/fake/opencode",
      provider: "other",
      model: "a/b",
      run: async () => ({
        exitCode: 0,
        stdout: freeStdout("opencode", "a/b"),
      }),
    });
    expect(wrongProvider).toBe(false);
  });

  test("createFreeModelProbe memoises per (provider, model)", async () => {
    let calls = 0;
    const probe = createFreeModelProbe({
      binaryPath: "/fake/opencode",
      run: async () => {
        calls++;
        return { exitCode: 0, stdout: freeStdout("opencode", "m") };
      },
    });
    expect(await probe("opencode", "m")).toBe(true);
    expect(await probe("opencode", "m")).toBe(true);
    expect(calls).toBe(1);
    expect(await probe("opencode", "other")).toBe(false);
    expect(calls).toBe(2);
  });

  test("freeVerdictKey keeps slash-colliding pairs independent", async () => {
    // ("a","b/c") and ("a/b","c") share the `${provider}/${model}` join
    // "a/b/c" — with a colliding key the second probe would reuse the first
    // verdict without spawning. The counting run proves two spawns happened.
    expect(freeVerdictKey("a", "b/c")).not.toBe(freeVerdictKey("a/b", "c"));
    let calls = 0;
    const probe = createFreeModelProbe({
      binaryPath: "/fake/opencode",
      run: async (argv) => {
        calls++;
        const provider = argv[2] as string;
        if (provider === "a") {
          return { exitCode: 0, stdout: freeStdout("a", "b/c") };
        }
        return { exitCode: 0, stdout: "a/b/c\n{}" };
      },
    });
    expect(await probe("a", "b/c")).toBe(true);
    expect(await probe("a/b", "c")).toBe(false);
    expect(calls).toBe(2);
  });

  test("defaultRun times out a hung spawn fast, kills it, and leaves no lingering proc", async () => {
    // Offline and darwin-safe: /bin/sleep hangs without network, and the
    // distinctive duration below is what the lingering-proc check greps for.
    const marker = "23.731";
    const start = Date.now();
    await expect(defaultRun(["/bin/sleep", marker], 50)).rejects.toThrow(
      /timed out/,
    );
    expect(Date.now() - start).toBeLessThan(10_000);
    const ps = Bun.spawn(["ps", "-A", "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(ps.stdout).text();
    await ps.exited;
    expect(out).not.toContain(marker);
  });

  test("isFreeModel fails closed fast on a real spawn with a tiny timeout", async () => {
    // Real spawn, offline, darwin-safe: /bin/sleep errors immediately on the
    // non-numeric "models" arg, so this resolves false without hanging — the
    // contract is fast-false, never a hang, whatever the binary does.
    const start = Date.now();
    const ok = await isFreeModel({
      binaryPath: "/bin/sleep",
      provider: "opencode",
      model: "m",
      timeoutMs: 50,
    });
    expect(ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  test("the fake-run path ignores timeoutMs: a slow fake still resolves", async () => {
    const ok = await isFreeModel({
      binaryPath: "/bin/sleep",
      provider: "opencode",
      model: "m",
      timeoutMs: 50,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { exitCode: 0, stdout: freeStdout("opencode", "m") };
      },
    });
    // The injected run is the test's own clock: timeoutMs bounds only the
    // default spawn, so a slow fake still resolves true — existing fake-run
    // tests stay green with or without the new field. (The /bin/sleep
    // binaryPath here never spawns; `run` replaces it.)
    expect(ok).toBe(true);
  });
});

describe("#182 wiring: bindings, server, gates", () => {
  test("free binding: kind, broker, pricing not_applicable, evidence, no blocking issue", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-"));
    try {
      const opencode = await writeOpenCodeFixture(tmpDir);
      const step = opencodeStep(
        "hunter",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode",
        "muse-spark-1.3-contributor-free",
      );
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry({ mode: "conformance" });
      registry.register("opencode", mockOpencodeTransport());
      const probe = await probeBindingsReadiness({
        workspaceRoot: tmpDir,
        plan,
        openCodeBinaryPath: opencode.canonicalPath,
        executableAllowlists: {
          opencode: [
            { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
          ],
        },
        registry,
        mode: "conformance",
        freeModelProbe: async (provider, model) =>
          provider === "opencode" &&
          model === "muse-spark-1.3-contributor-free",
      });
      try {
        expect(probe.decision.ok).toBe(true);
        const binding = probe.bindings.get(step.routeFingerprint);
        if (!binding) throw new Error("missing binding");
        expect(binding.credential.kind).toBe("provider_free");
        expect(binding.credential.broker).toBeInstanceOf(OpenCodeFreeBroker);
        const report = await binding.capabilities();
        expect(report.auth.kind).toBe("provider_free");
        expect(report.billing.pricingApplicability).toBe("not_applicable");
        expect(report.billing.mode).toBe("subscription");
        expect(report.billing.cashCostAccountingValid).toBe(true);
        const evidence = d1_11EvidenceFromExactBinding(report, true);
        expect(evidence.credentialAuthority).toBe(true);
        expect(evidence.pricingReady).toBe(true);
        const blocking = exactBindingCapabilityIssues(report).filter(
          (i) => i.blocking,
        );
        expect(blocking).toEqual([]);
      } finally {
        await probe.dispose();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("registry stamps free for the free kind (settlement guard reads it)", async () => {
    const fakeClient = {
      createSession: async () => ({ id: "s" }),
      async *streamEvents() {},
      pollStatus: async () => ({ kind: "pending" }) as const,
      abort: async () => {},
    };
    const registry = createDefaultTransportRegistry({
      mode: "conformance",
      sdkVersion: "1.18.25",
      serverVersion: "1.18.30",
      openCodeClient: fakeClient as never,
      credentialKind: "provider_free",
    });
    const transport = registry.get("opencode", {
      routeFingerprint: "fp",
      route: {
        backend: "opencode",
        provider: "opencode",
        modelFamily: "muse-spark",
        modelSnapshot: "muse-spark-1.3-contributor-free",
      },
      credentialKind: "provider_free",
    }) as unknown as { usageBillingMode: string };
    // #182 follow-up: "free", not "subscription" — `settlementFromUsage`'s
    // free-nonzero rule keys on this stamp, and a subscription badge would
    // settle a flipped attempt's priced cost as a truthful zero.
    expect(transport.usageBillingMode).toBe("free");
  });

  test("admission: all-free plan resolves free server credential with the shared broker instance", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-adm-"));
    try {
      await writeOpenCodeFixture(tmpDir);
      const step = opencodeStep(
        "hunter",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode",
        "muse-spark-1.3-contributor-free",
      );
      const plan = createResolvedRoutePlan([step]);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir },
        loadSdk: async () =>
          ({
            createOpencodeClient: () => ({ session: {}, event: {} }),
          }) as never,
        freeModelProbe: async () => true,
      });
      if ("error" in admission) throw new Error(admission.error);
      expect(admission.registry.openCodeCredentialKind).toBe("provider_free");
      expect(
        admission.authorityOptions.credentialBrokers?.opencode,
      ).toBeInstanceOf(OpenCodeFreeBroker);
      expect(admission.registry.openCodeCredentialBroker).toBe(
        admission.authorityOptions.credentialBrokers?.opencode,
      );
      expect(admission.freeModelProbe).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // U4 (S9): a free and a metered route used to be refused here, because one
  // server credential served both. Each route now binds its own kind and
  // broker, and the registry carries no plan-wide default.
  test("admission: mixed free/metered plan binds each route by its own kind, never OAuth", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-mix-"));
    try {
      await writeOpenCodeFixture(tmpDir);
      const plan = createResolvedRoutePlan([
        opencodeStep("hunter", "opencode/free-model", "opencode", "free-model"),
        opencodeStep(
          "refuter",
          "opencode/paid-model",
          "opencode",
          "paid-model",
        ),
      ]);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir, XDG_DATA_HOME: await writeOpenCodeAuth(tmpDir) },
        loadSdk: async () =>
          ({
            createOpencodeClient: () => ({ session: {}, event: {} }),
          }) as never,
        freeModelProbe: async (_p, m) => m === "free-model",
      });
      if ("error" in admission) throw new Error(admission.error);
      expect(admission.registry.openCodeCredentialKind).toBeUndefined();
      expect(admission.registry.openCodeCredentialBroker).toBeUndefined();
      expect(
        admission.authorityOptions.credentialBrokers?.opencode,
      ).toBeUndefined();
      const runtime = await createProductionRuntime({
        ...admission.authorityOptions,
        plan,
        workspaceRoot: tmpDir,
        registry: admission.registry,
        mode: "conformance",
        ...(admission.freeModelProbe === undefined
          ? {}
          : { freeModelProbe: admission.freeModelProbe }),
      });
      try {
        const kinds = [...runtime.bindings.values()]
          .map((b) => [b.route.modelSnapshot, b.credential.kind])
          .sort();
        expect(kinds).toEqual([
          ["free-model", "provider_free"],
          ["paid-model", "provider_api_token"],
        ]);
        for (const binding of runtime.bindings.values()) {
          expect(binding.credential.broker).toBeInstanceOf(
            binding.credential.kind === "provider_free"
              ? OpenCodeFreeBroker
              : OpenCodeApiTokenBroker,
          );
        }
      } finally {
        await runtime.dispose();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("runtime fallback with probe: all-free plan binds free end to end", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-rt-"));
    try {
      const opencode = await writeOpenCodeFixture(tmpDir);
      const step = opencodeStep(
        "hunter",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode",
        "muse-spark-1.3-contributor-free",
      );
      const plan = createResolvedRoutePlan([step]);
      // No registry: exercises productionFallbackRegistry with the
      // soleCredentialOverride (the real fallback path, not a mock).
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        openCodeBinaryPath: opencode.canonicalPath,
        executableAllowlists: {
          opencode: [
            { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
          ],
        },
        mode: "conformance",
        freeModelProbe: async () => true,
      });
      try {
        const binding = runtime.bindings.get(step.routeFingerprint);
        expect(binding?.credential.kind).toBe("provider_free");
        expect(
          (runtime.registry as DefaultTransportRegistry).openCodeCredentialKind,
        ).toBe("provider_free");
      } finally {
        await runtime.dispose();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("runtime refuses loudly when the server is free but bindings never probed", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-div-"));
    try {
      const opencode = await writeOpenCodeFixture(tmpDir);
      const step = opencodeStep(
        "hunter",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode",
        "muse-spark-1.3-contributor-free",
      );
      const plan = createResolvedRoutePlan([step]);
      // Admission WITH probe decides free for the server…
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir },
        loadSdk: async () =>
          ({
            createOpencodeClient: () => ({ session: {}, event: {} }),
          }) as never,
        freeModelProbe: async () => true,
      });
      if ("error" in admission) throw new Error(admission.error);
      // …but the runtime is built WITHOUT the probe, so bindings stay
      // metered behind a free server. That divergence must refuse, never
      // silently serve metered routes from an empty projection.
      let error: unknown;
      try {
        await createProductionRuntime({
          ...admission.authorityOptions,
          plan,
          workspaceRoot: tmpDir,
          openCodeBinaryPath: opencode.canonicalPath,
          registry: admission.registry,
          mode: "conformance",
        });
      } catch (e) {
        error = e;
      }
      expect(String((error as Error)?.message ?? error)).toMatch(
        /freeModelProbe|empty projection|free/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("runtime refuses loudly on the partial mix: free server, some free some metered bindings", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-partial-"));
    try {
      await writeOpenCodeFixture(tmpDir);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([
          opencodeStep(
            "hunter",
            "opencode/free-model",
            "opencode",
            "free-model",
          ),
        ]),
        env: { PATH: tmpDir },
        loadSdk: async () =>
          ({
            createOpencodeClient: () => ({ session: {}, event: {} }),
          }) as never,
        freeModelProbe: async () => true,
      });
      if ("error" in admission) throw new Error(admission.error);
      expect(admission.registry.openCodeCredentialKind).toBe("provider_free");
      // The runtime probes with a DIFFERENT verdict set than the admission:
      // one binding stays free, the other resolves metered behind a free
      // server. Without the partial-mix branch this would fail closed later
      // at projection (missing_provider_record); the guard refuses loudly.
      const mixedPlan = createResolvedRoutePlan([
        opencodeStep("hunter", "opencode/free-model", "opencode", "free-model"),
        opencodeStep(
          "refuter",
          "opencode/paid-model",
          "opencode",
          "paid-model",
        ),
      ]);
      let error: unknown;
      try {
        await createProductionRuntime({
          ...admission.authorityOptions,
          plan: mixedPlan,
          workspaceRoot: tmpDir,
          registry: admission.registry,
          mode: "conformance",
          freeModelProbe: async (_p, m) => m === "free-model",
        });
      } catch (e) {
        error = e;
      }
      expect(String((error as Error)?.message ?? error)).toMatch(/paid-model/);
      expect(String((error as Error)?.message ?? error)).toMatch(
        /freeModelProbe/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("runtime admits a free server with all bindings free (partial-mix guard stays quiet)", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-allfree-"));
    try {
      await writeOpenCodeFixture(tmpDir);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([
          opencodeStep(
            "hunter",
            "opencode/free-model",
            "opencode",
            "free-model",
          ),
        ]),
        env: { PATH: tmpDir },
        loadSdk: async () =>
          ({
            createOpencodeClient: () => ({ session: {}, event: {} }),
          }) as never,
        freeModelProbe: async () => true,
      });
      if ("error" in admission) throw new Error(admission.error);
      const allFreePlan = createResolvedRoutePlan([
        opencodeStep("hunter", "opencode/free-model", "opencode", "free-model"),
        opencodeStep(
          "refuter",
          "opencode/other-free",
          "opencode",
          "other-free",
        ),
      ]);
      const runtime = await createProductionRuntime({
        ...admission.authorityOptions,
        plan: allFreePlan,
        workspaceRoot: tmpDir,
        registry: admission.registry,
        mode: "conformance",
        freeModelProbe: async () => true,
      });
      try {
        for (const binding of runtime.bindings.values()) {
          expect(binding.credential.kind).toBe("provider_free");
        }
      } finally {
        await runtime.dispose();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("CLI threading: admission auto-creates a probe from the resolved binary; a failing binary stays metered without hanging", async () => {
    // No freeModelProbe supplied — the CLI path. The fixture binary resolves
    // via PATH discovery but cannot execute (Mach-O prefix + bytes, not a
    // program), so the live spawn fails fast and fail-closed keeps metered.
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-auto-"));
    try {
      const opencode = await writeOpenCodeFixture(tmpDir);
      const plan = createResolvedRoutePlan([
        opencodeStep("hunter", "opencode/some-model", "opencode", "some-model"),
      ]);
      const start = Date.now();
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: {
          PATH: `${tmpDir}:/usr/bin:/bin`,
          XDG_DATA_HOME: await writeOpenCodeAuth(tmpDir),
        },
        loadSdk: async () =>
          ({
            createOpencodeClient: () => ({ session: {}, event: {} }),
          }) as never,
      });
      expect(Date.now() - start).toBeLessThan(10_000);
      if ("error" in admission) throw new Error(admission.error);
      // Metered preserved: the probe ran (and failed closed) rather than the
      // plan silently upgrading — or silently skipping the probe entirely.
      expect(admission.registry.openCodeCredentialKind).toBe(
        "provider_api_token",
      );
      expect(admission.freeModelProbe).toBeDefined();
      expect(opencode.canonicalPath.length).toBeGreaterThan(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("CLI threading: the admission's shared probe drives registry-built runtimes free end to end", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-wired-"));
    try {
      await writeOpenCodeFixture(tmpDir);
      const plan = createResolvedRoutePlan([
        opencodeStep("hunter", "opencode/free-model", "opencode", "free-model"),
        opencodeStep(
          "refuter",
          "opencode/other-free",
          "opencode",
          "other-free",
        ),
      ]);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir },
        loadSdk: async () =>
          ({
            createOpencodeClient: () => ({ session: {}, event: {} }),
          }) as never,
        freeModelProbe: async () => true,
      });
      if ("error" in admission) throw new Error(admission.error);
      expect(admission.registry.openCodeCredentialKind).toBe("provider_free");
      // Exactly what cli.ts now forwards: the admission's shared instance
      // into a registry-built runtime — server-free implies bindings-free
      // with no re-spawn and no divergence refusal.
      const runtime = await createProductionRuntime({
        ...admission.authorityOptions,
        plan,
        workspaceRoot: tmpDir,
        registry: admission.registry,
        mode: "conformance",
        ...(admission.freeModelProbe === undefined
          ? {}
          : { freeModelProbe: admission.freeModelProbe }),
      });
      try {
        expect(
          (runtime.registry as DefaultTransportRegistry).openCodeCredentialKind,
        ).toBe("provider_free");
        for (const binding of runtime.bindings.values()) {
          expect(binding.credential.kind).toBe("provider_free");
        }
      } finally {
        await runtime.dispose();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("planOpenCodeCredentials stays provider-based without verdicts (free needs the async probe)", () => {
    const plan = createResolvedRoutePlan([
      opencodeStep("h", "opencode/m", "opencode", "m"),
    ]);
    expect(
      soleOpenCodeCredentialOf(planOpenCodeCredentials(plan, undefined)),
    ).toEqual({
      kind: "provider_api_token",
      provider: "opencode",
    });
  });

  test("openCodeLaunchServerFor default stays OAuth; free kind always travels explicitly", async () => {
    // Kind-less callers get the OAuth pair — the fallback, never free.
    const launcher = openCodeLaunchServerFor({});
    expect(typeof launcher).toBe("function");
    const fallback = productionFallbackRegistry({ mode: "conformance" });
    expect(
      (fallback as DefaultTransportRegistry).openCodeCredentialKind,
    ).toBeUndefined();
    // A free binding forwards its kind explicitly on acquire().
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-exp-"));
    try {
      const opencode = await writeOpenCodeFixture(tmpDir);
      const step = opencodeStep(
        "hunter",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode",
        "muse-spark-1.3-contributor-free",
      );
      const plan = createResolvedRoutePlan([step]);
      const seen: string[] = [];
      const recordingRegistry = {
        get(_backend: RunnerBackend, opts?: { credentialKind?: string }) {
          if (opts?.credentialKind) seen.push(opts.credentialKind);
          return mockOpencodeTransport() as never;
        },
        has: () => true,
        getCapabilityReport: async () => mockOpencodeTransport().capabilities(),
        getAllCapabilityReports: async () => new Map(),
      };
      const probe = await probeBindingsReadiness({
        workspaceRoot: tmpDir,
        plan,
        openCodeBinaryPath: opencode.canonicalPath,
        executableAllowlists: {
          opencode: [
            { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
          ],
        },
        registry: recordingRegistry as never,
        mode: "conformance",
        freeModelProbe: async () => true,
      });
      try {
        const binding = probe.bindings.get(step.routeFingerprint);
        if (!binding) throw new Error("missing binding");
        await binding.acquire(
          {
            credentialProjectionId: "x",
            env: {},
            syntheticHome: "",
            syntheticConfigHome: "",
            syntheticTmp: "",
            verifiedBinaryPath: opencode.canonicalPath,
          },
          recordingRegistry as never,
        );
        expect(seen).toContain("provider_free");
      } finally {
        await probe.dispose();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
