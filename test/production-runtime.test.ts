import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ExecutableAllowlistEntry,
  exactBindingCapabilityGate,
  exactBindingCapabilityIssues,
} from "#model/provider-capabilities";
import {
  computeRouteFingerprint,
  createResolvedRoutePlan,
  type RoutingConfig,
  resolveStepRoute,
} from "#model/routing";
import { buildStepArgv } from "#review/step-runner";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
  RunnerBackend,
  TransportOutcome,
  TransportRequest,
} from "../src/execution/contracts";
import {
  type NormalizedUsage,
  normalizeUnavailableUsage,
} from "../src/execution/usage-normalized";
import {
  collectDoctorExactBindingReports,
  createProductionRuntime,
  MultiProviderRunner,
  ProductionRuntimeError,
  probeBindingsReadiness,
} from "../src/production-runtime";
import {
  resolveBindingAuthority,
  resolveRunnerAuthority,
} from "../src/runner-authority";
import type {
  CredentialBroker,
  CredentialProjection,
} from "../src/security/credential-broker";
import {
  CredentialProjectionError,
  OpenCodeApiTokenBroker,
  OpenCodeAuthBroker,
} from "../src/security/credential-broker";
import { authorizeWorkspaceCwd } from "../src/security/execution-authority";
import {
  admitRoutePlan,
  type D1_11ReadinessEvidence,
  DefaultTransportRegistry,
  OpenCodeProductionGatedError,
} from "../src/transport-registry";
import { ClaudeCodeCliTransport } from "../src/transports/claude-code-cli";
import { successfulClaudeCredentialBroker } from "./support/claude-credential-broker";

const MACHO_PREFIX = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

// #303: the harnesses this file builds verify real Mach-O fixtures, which
// snapshots them under os.tmpdir() and, once per process, sweeps that base.
// A per-file TMPDIR keeps both away from the operator's real
// $TMPDIR/prhero-exec-snapshots (Bun's os.tmpdir() re-reads TMPDIR per call).
let originalTmpdir: string | undefined;
let isolatedTmpdir: string;

beforeAll(async () => {
  originalTmpdir = process.env.TMPDIR;
  isolatedTmpdir = await mkdtemp(
    path.join(tmpdir(), "pr-hero-prod-rt-tmpdir-"),
  );
  process.env.TMPDIR = isolatedTmpdir;
});

afterAll(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(isolatedTmpdir, { recursive: true, force: true });
});

const stubClaudeCredentialBroker: CredentialBroker = {
  async project() {
    throw new Error("stub broker: capability-gate tests never project");
  },
};

async function writeClaudeFixture(
  dir: string,
): Promise<{ canonicalPath: string; sha256: string }> {
  const claudePath = path.join(dir, "claude");
  const bytes = Buffer.concat([
    MACHO_PREFIX,
    Buffer.from('#!/bin/sh\necho \'{"result":"ok"}\'\n'),
  ]);
  await writeFile(claudePath, bytes);
  await chmod(claudePath, 0o755);
  const canonicalPath = await realpath(claudePath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { canonicalPath, sha256: hasher.digest("hex") };
}

async function writeOpenCodeFixture(
  dir: string,
  version = "1.18.30",
): Promise<{ canonicalPath: string; sha256: string }> {
  const opencodePath = path.join(dir, "opencode");
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "${version}"\n  exit 0\nfi\nexit 0\n`;
  const bytes = Buffer.from(script);
  await writeFile(opencodePath, bytes);
  await chmod(opencodePath, 0o755);
  const canonicalPath = await realpath(opencodePath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { canonicalPath, sha256: hasher.digest("hex") };
}

function claudeAllowlist(fixture: {
  canonicalPath: string;
  sha256: string;
}): Partial<Record<RunnerBackend, readonly ExecutableAllowlistEntry[]>> {
  return {
    "claude-code": [
      { absolutePath: fixture.canonicalPath, sha256: fixture.sha256 },
    ],
  };
}

function mixedAllowlists(
  claude: { canonicalPath: string; sha256: string },
  opencode: { canonicalPath: string; sha256: string },
): Partial<Record<RunnerBackend, readonly ExecutableAllowlistEntry[]>> {
  return {
    "claude-code": [
      { absolutePath: claude.canonicalPath, sha256: claude.sha256 },
    ],
    opencode: [
      { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
    ],
  };
}

function createMockTransport(
  backend: RunnerBackend,
  requests: TransportRequest[] = [],
  capabilityOverrides: Partial<ProviderCapabilityReport> = {},
): ProviderTransport {
  return {
    backend,
    admissionIdentity:
      backend === "claude-code"
        ? { executable: "claude", provider: "anthropic" }
        : { executable: "opencode", provider: "opencode" },
    cancellationSemantics:
      backend === "claude-code" ? "process-exit" : "provider-proof",
    defaultRoute:
      backend === "claude-code"
        ? {
            backend: "claude-code",
            provider: "anthropic",
            modelFamily: "claude",
            modelSnapshot: "sonnet",
          }
        : {
            backend: "opencode",
            provider: "opencode",
            modelFamily: "opencode",
            modelSnapshot: "gpt-4o",
          },
    capabilities: async (): Promise<ProviderCapabilityReport> => ({
      backend,
      status: "ready",
      auth: {
        kind:
          backend === "claude-code"
            ? "claude_subscription_oauth"
            : "opencode_chatgpt_oauth",
        projectionReady: true,
        probe: "passed",
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: true,
        codegraphPolicy: true,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: true,
        usageMode: "snapshot",
      },
      cancellation: { deadlineMs: 5000, conformance: "passed" },
      billing: { mode: "subscription", pricingReady: true },
      issues: [],
      ...capabilityOverrides,
    }),
    execute: async (request: TransportRequest): Promise<TransportOutcome> => {
      requests.push(request);
      return {
        completion: "success",
        protocolIntegrity: "verified",
        finalText: '{"findings":[]}',
        usage: {
          wallMs: 10,
          tokens: { totalKnown: 1 },
          completeness: "complete",
          billingMode: "subscription",
          costSource: "provider",
          cashCostUsd: 0,
        },
        stderrTail: "",
      };
    },
    classifyFailure: () => undefined,
  };
}

function makeStep(
  tmpDir: string,
  overrides: Partial<import("#review/step-runner").StepSpec> = {},
): import("#review/step-runner").StepSpec {
  return {
    name: "hunter-reliability",
    systemPromptPath: path.join(tmpDir, "system.md"),
    prompt: "review",
    tools: ["Read"],
    mcpConfigPath: path.join(tmpDir, "mcp.json"),
    model: "sonnet",
    effort: "high",
    cwd: tmpDir,
    outPath: path.join(tmpDir, "out.json"),
    timeoutMs: 5000,
    maxAttempts: 1,
    parse: (text: string) => JSON.parse(text),
    ...overrides,
  };
}

describe("production runtime PR1", () => {
  let tmpDir: string;
  let claudeFixture: { canonicalPath: string; sha256: string };

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-prod-rt-"));
    tmpDir = await realpath(tmpDir);
    claudeFixture = await writeClaudeFixture(tmpDir);
    await writeFile(path.join(tmpDir, "system.md"), "system");
    await writeFile(path.join(tmpDir, "mcp.json"), "{}");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("Task 1.1: route fingerprint identity and shared registry", () => {
    test("routeFingerprint changes when backend/provider/model/variant differ", () => {
      const baseRoute = {
        backend: "claude-code" as const,
        provider: "anthropic",
        gateway: "direct" as const,
        modelFamily: "sonnet",
        modelSnapshot: "sonnet",
      };
      const fpBase = computeRouteFingerprint(
        "anthropic/claude-sonnet-4-5",
        baseRoute,
      );
      const fpVariant = computeRouteFingerprint("anthropic/claude-sonnet-4-5", {
        ...baseRoute,
        modelVariant: "thinking",
      });
      const fpProvider = computeRouteFingerprint("openai/gpt-4o", {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
      });

      expect(fpBase).toHaveLength(64);
      expect(fpVariant).not.toBe(fpBase);
      expect(fpProvider).not.toBe(fpBase);
    });

    test("createProductionRuntime freezes one binding per routeFingerprint", async () => {
      const hunter = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const refuter = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opus",
      });
      const plan = createResolvedRoutePlan([hunter, refuter]);

      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      expect(runtime.bindings.size).toBe(2);
      expect(runtime.bindings.has(hunter.routeFingerprint)).toBe(true);
      expect(runtime.bindings.has(refuter.routeFingerprint)).toBe(true);
      expect(
        runtime.bindings.get(hunter.routeFingerprint)?.route.modelFamily,
      ).toBe("sonnet");
      expect(
        runtime.bindings.get(refuter.routeFingerprint)?.route.modelFamily,
      ).toBe("opus");
    });

    test("local and PR modes share the same registry for admission and execution", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      const readmission = await admitRoutePlan(plan, runtime.registry, {
        mode: "conformance",
      });
      expect(readmission.ok).toBe(true);
      expect(runtime.runner).toBeInstanceOf(MultiProviderRunner);
      expect(
        (runtime.runner as MultiProviderRunner).resolveBinding(
          makeStep(tmpDir, {
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        )?.key,
      ).toBe(step.routeFingerprint);
    });

    test("the runtime echoes the D1-11 evidence it was admitted with", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const evidence = new Map<RunnerBackend, D1_11ReadinessEvidence>([
        [
          "opencode",
          {
            sdkAvailable: true,
            credentialAuthority: true,
            workspaceBroker: true,
            pricingReady: true,
          },
        ],
      ]);

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
        evidence,
      });

      // The evidence has to survive the runtime boundary: admitRoutePlan reads
      // it ONLY from its own options, so every downstream admission call site
      // needs the runtime to hand it back out.
      expect(runtime.evidence).toBe(evidence);
    });

    test("a runtime built without evidence exposes none", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      expect(runtime.evidence).toBeUndefined();
    });

    test("invalid authority stops before any spawn or reservation", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      let spawnCount = 0;
      const spawnFn = (() => {
        spawnCount++;
        return {
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exited: Promise.resolve(0),
          kill() {},
        };
      }) as unknown as typeof Bun.spawn;

      await expect(
        createProductionRuntime({
          workspaceRoot: tmpDir,
          plan,
          binaryPath: path.join(tmpDir, "missing-claude"),
          registry,
          mode: "conformance",
          spawnFn,
          authorityDeps: {
            realpathFn: async () => {
              throw new Error("not found");
            },
          },
        }),
      ).rejects.toThrow(ProductionRuntimeError);

      expect(spawnCount).toBe(0);
    });

    test("Claude-only runtime preserves buildStepArgv bytes", () => {
      const spec = makeStep(tmpDir);
      const argv = buildStepArgv(spec);
      // #314: no positional prompt after `-p` — the prompt is stdin-only.
      expect(argv).toEqual([
        "claude",
        "-p",
        "--append-system-prompt-file",
        spec.systemPromptPath,
        "--output-format",
        "json",
        "--mcp-config",
        spec.mcpConfigPath,
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--tools",
        "Read",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "sonnet",
        "--effort",
        "high",
        "--exclude-dynamic-system-prompt-sections",
      ]);
    });

    test("resolveRunnerAuthority remains the Claude compatibility facade", async () => {
      const authority = await resolveRunnerAuthority({
        workspaceRoot: tmpDir,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
      });
      expect(authority.error).toBeUndefined();
      expect(authority.runnerOptions?.binaryPath).toBe(
        claudeFixture.canonicalPath,
      );
      expect(authority.runnerOptions?.executableAllowlist[0].sha256).toBe(
        claudeFixture.sha256,
      );
    });
  });

  describe("Task 1.3/1.4: authority denials before confirmation", () => {
    test("workspace cwd escape is denied with zero transport calls", async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), "pr-hero-out-"));
      const outside = await realpath(outsideDir);
      await writeFile(path.join(outside, "secret.txt"), "x");

      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const requests: TransportRequest[] = [];
      const registry = new DefaultTransportRegistry();
      registry.register(
        "claude-code",
        createMockTransport("claude-code", requests),
      );

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
        authorityDeps: {
          existsFn: (p) =>
            p === claudeFixture.canonicalPath || p.startsWith(tmpDir),
          realpathFn: async (p) => p,
        },
      });

      const result = await runtime.runner.run(
        makeStep(path.join(tmpDir, "..", path.basename(outside)), {
          cwd: path.join(tmpDir, "..", path.basename(outside)),
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.denialCode).toBe("path_not_approved");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);

      await rm(outside, { recursive: true, force: true }).catch(() => {});
    });

    test("authorizeWorkspaceCwd rejects relative escape before spawn", () => {
      const auth = authorizeWorkspaceCwd(tmpDir, "../outside");
      expect(auth.approved).toBe(false);
    });

    test("OpenCode without D1-11 evidence fails before runner is returned", async () => {
      const routingConfig: RoutingConfig = {
        mappings: {
          "openai/gpt-4o": {
            backend: "opencode",
            provider: "openai",
            modelFamily: "gpt-4o",
            modelSnapshot: "gpt-4o",
          },
        },
      };
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig,
      });
      const plan = createResolvedRoutePlan([step]);
      const opencodeFixture = await writeOpenCodeFixture(tmpDir);

      await expect(
        createProductionRuntime({
          workspaceRoot: tmpDir,
          plan,
          openCodeBinaryPath: opencodeFixture.canonicalPath,
          executableAllowlists: {
            opencode: [
              {
                absolutePath: opencodeFixture.canonicalPath,
                sha256: opencodeFixture.sha256,
              },
            ],
          },
          mode: "production",
        }),
      ).rejects.toThrow(OpenCodeProductionGatedError);
    });
  });

  describe("Task 1.5: interfaces and optional OpenCode", () => {
    test("binding.capabilities derives facts from the exact route binding", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      const binding = runtime.bindings.get(step.routeFingerprint);
      expect(binding).toBeDefined();
      if (binding === undefined) return;
      const report = await binding.capabilities();
      expect(report.routeKey).toBe(step.routeFingerprint);
      expect(report.backend).toBe("claude-code");
      expect(report.binary.resolved).toBe(true);
      expect(report.binary.sha256).toBe(claudeFixture.sha256);
      const brokered = binding.credential.broker !== undefined;
      expect(report.auth.projectionReady).toBe(brokered);
      expect(report.environment.syntheticHome).toBe(brokered);
      expect(report.environment.enumeratedPassthrough).toBe(!brokered);
    });

    // FOLLOW-UP-1: the legacy ProviderCapabilityReport carries THREE billing
    // modes (subscription | metered | unknown, model/provider-capabilities.ts:266)
    // while the exact contract carries two (contracts.ts:167). The producer
    // narrows `unknown` into `"subscription"`, so `cashCostAccountingValid`
    // must NOT be derived from the narrowed value — the design doc is
    // explicit that `billingMode: "unknown"` is a blocking preflight result
    // (docs/multi-runtime-model-diversity-design.md:461), and the pricing
    // gate cannot catch it because `unknown` is not `metered`.
    // #197 removed the clock seam these arms used to carry. There is no
    // bundled table left to age, so no arm below can rot on a calendar date
    // and none needs to name which provider's stamp it is anchored on.
    async function bindingReportForBilling(
      billing: ProviderCapabilityReport["billing"],
      routingConfig?: RoutingConfig,
      // #161: optional so every pre-existing caller below (which does not
      // care about the credential kind) stays byte-identical — no env means
      // no key means the pre-#161 subscription kind, same as always.
      env?: Readonly<Record<string, string | undefined>>,
      // #161 (corrected 2026-09-24): optional so a caller can prove the
      // "broker present" arm deterministically, on every host, instead of
      // depending on whether THIS host's Keychain default resolves.
      credentialBrokers?: { readonly "claude-code": CredentialBroker },
    ) {
      // No routingConfig resolves through the alias fallback in
      // model/routing.ts, which pins provider "anthropic" -- the catalogue's
      // own provider. That is what keeps every arm below meaning what it meant
      // before the provider gate existed.
      //
      // #175: it no longer pins a MODEL VERSION. A bare `sonnet` route now
      // carries `modelSnapshot: "sonnet"`, which the version-keyed bundled
      // table does not hold, so an arm that needs a CATALOGUED model has to
      // say so -- see PINNED_SNAPSHOT_ROUTE below.
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
        ...(routingConfig === undefined ? {} : { routingConfig }),
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register(
        "claude-code",
        createMockTransport("claude-code", [], { billing }),
      );
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
        ...(env === undefined ? {} : { env }),
        ...(credentialBrokers === undefined ? {} : { credentialBrokers }),
      });
      const binding = runtime.bindings.get(step.routeFingerprint);
      if (binding === undefined) throw new Error("missing binding");
      return await binding.capabilities();
    }

    test("an unknown legacy billing mode blocks the exact-binding gate through the real producer", async () => {
      const report = await bindingReportForBilling({
        mode: "unknown",
        pricingReady: false,
      });

      // The 2-state narrowing stays: `unknown` still projects as
      // "subscription" on the exact contract.
      expect(report.billing.mode).toBe("subscription");
      // ...which is exactly why the pricing gate cannot see it.
      expect(report.billing.pricingApplicability).toBe("not_applicable");
      // The cash-cost fact is the enforcement point, and it must say NO.
      expect(report.billing.cashCostAccountingValid).toBe(false);

      const decision = exactBindingCapabilityGate(report);
      expect(decision.ok).toBe(false);
      expect(decision.reason).toContain("cash_cost_accounting_invalid");
    });

    test("subscription and metered billing modes keep their spec-defined cash-cost accounting", async () => {
      const subscription = await bindingReportForBilling({
        mode: "subscription",
        pricingReady: false,
      });
      // Spec: subscription OAuth may truthfully report cashCostUsd: 0, with
      // no pricing table involved.
      expect(subscription.billing.cashCostAccountingValid).toBe(true);
      expect(exactBindingCapabilityGate(subscription).ok).toBe(true);

      // #197: "unpriced" is now simply a transport that reports no cost.
      // This arm used to need an EXPIRED bundled table beside it, because a
      // fresh one would have priced the route on the catalogue alone and the
      // arm would have stopped being the unpriced case it exists to prove.
      // With the table deleted there is one source, so the flag says it all.
      const meteredUnpriced = await bindingReportForBilling({
        mode: "metered",
        pricingReady: false,
      });
      // Spec: metered routes require provider cost.
      expect(meteredUnpriced.billing.cashCostAccountingValid).toBe(false);
      // The cash gate stays silent for metered (its guard is
      // `pricingApplicability !== "required"`); pricing_table_missing is the
      // blocker on this arm.
      const meteredDecision = exactBindingCapabilityGate(meteredUnpriced);
      expect(meteredDecision.ok).toBe(false);
      expect(meteredDecision.reason).toContain("pricing_table_missing");
      expect(meteredDecision.reason).not.toContain(
        "cash_cost_accounting_invalid",
      );

      const meteredPriced = await bindingReportForBilling({
        mode: "metered",
        pricingReady: true,
      });
      expect(meteredPriced.billing.cashCostAccountingValid).toBe(true);
      expect(exactBindingCapabilityGate(meteredPriced).ok).toBe(true);
    });

    // #161, end to end (corrected 2026-09-24 by Juanma): an ANTHROPIC_API_KEY
    // in the route's env upgrades `credentialKindForRoute`'s answer only when
    // NO credential broker will project for the route — a SUCCESSFUL
    // projection strips the key before the child ever spawns
    // (PROJECTION_OWNED_KEYS, harness.ts), so a projected route stays
    // subscription no matter what its env carries. (A degraded projection is
    // #279's known exception, not exercised by this admission-time test —
    // `resolveBindingAuthority` never awaits the real projection, only
    // whether a broker is attached; see
    // test/harness/credential-projection.test.ts for the real, degraded
    // path, and "the run's spend ledger is composed" describe block below —
    // "#279: a subscription binding still fences a degraded ambient-key
    // attempt" — for #279's own harness-wiring-through-production-runtime
    // coverage.) `FrozenRuntimeBinding.capabilities()` upgrades
    // `effectiveBillingMode` from that kind
    // (production-runtime.ts:~324, `credentialKindBillsMetered`). The mock
    // transport here reports the shape the REAL `ClaudeCodeCliTransport`
    // reports today — `mode: "subscription"` (the static, backend-wide
    // claim), `pricingReady: true` (#197) — so both arms below prove the
    // exact-binding mode follows the CREDENTIAL, not the transport claiming
    // metered itself.
    test("a key alongside a broker stays subscription — the broker wins, deterministically on every host", async () => {
      const subscriptionShapedReport = {
        mode: "subscription" as const,
        pricingReady: true,
      };
      const withoutKey = await bindingReportForBilling(
        subscriptionShapedReport,
      );
      expect(withoutKey.billing.mode).toBe("subscription");
      expect(withoutKey.billing.pricingApplicability).toBe("not_applicable");

      // The fake broker is what makes this deterministic: it proves the
      // precedence rule without depending on whether THIS host's real
      // Keychain default happens to resolve.
      const withKeyAndBroker = await bindingReportForBilling(
        subscriptionShapedReport,
        undefined,
        { ANTHROPIC_API_KEY: "sk-test" },
        { "claude-code": stubClaudeCredentialBroker },
      );
      expect(withKeyAndBroker.billing.mode).toBe("subscription");
      expect(withKeyAndBroker.billing.pricingApplicability).toBe(
        "not_applicable",
      );
      expect(exactBindingCapabilityGate(withKeyAndBroker).ok).toBe(true);
    });

    // The full path for "a key, no broker at all" — only exercisable end to
    // end on a host whose default Keychain broker genuinely resolves to
    // undefined (CI's ubuntu-latest); skipped on this darwin sandbox in
    // favour of the deterministic, platform-independent proof in
    // test/runner-authority.test.ts.
    test.skipIf(
      process.platform === "darwin" && existsSync("/usr/bin/security"),
    )(
      "a key with no broker upgrades the exact binding to metered and admits it",
      async () => {
        const withKey = await bindingReportForBilling(
          { mode: "subscription" as const, pricingReady: true },
          undefined,
          { ANTHROPIC_API_KEY: "sk-test" },
        );
        expect(withKey.billing.mode).toBe("metered");
        expect(withKey.billing.pricingApplicability).toBe("required");
        expect(withKey.billing.tokenPricingAvailable).toBe(true);
        expect(withKey.billing.cashCostAccountingValid).toBe(true);
        // Admitted, not refused for lack of pricing: this is the pairing
        // #161 depends on but does not itself provide (#197 provided it).
        // `ok` only reaches true with an empty `reason`
        // (capabilityGateDecision, model/provider-capabilities.ts), so this
        // alone rules out `pricing_table_missing` blocking the route.
        expect(exactBindingCapabilityGate(withKey).ok).toBe(true);
      },
    );

    // #197 deleted the bundled catalogue and the `||` arm that read it, so
    // `tokenPricingAvailable` is the transport's own claim and nothing else.
    // These two arms are what keeps that a decision rather than an accident:
    // the ONE thing that used to rescue a transport reporting no cost is gone,
    // and re-adding any second source turns the first arm red.
    describe("the transport's own claim is the only pricing source", () => {
      // #175's pinned snapshot, kept verbatim. It names
      // `claude-sonnet-5` — the exact model the deleted anthropic table
      // covered — so this route is the strongest possible case for a table
      // fallback, and it is refused anyway. A bare alias would have been
      // refused for a second reason (no version to look up), which is why the
      // pin is load-bearing here rather than incidental.
      const PINNED_SNAPSHOT_ROUTE: RoutingConfig = {
        default: {
          backend: "claude-code",
          provider: "anthropic",
          modelFamily: "claude-sonnet-5",
          modelSnapshot: "claude-sonnet-5",
        },
      };

      test("a formerly-catalogued model no longer rescues a transport that reports no cost", async () => {
        const report = await bindingReportForBilling(
          { mode: "metered", pricingReady: false },
          PINNED_SNAPSHOT_ROUTE,
        );

        expect(report.billing.pricingApplicability).toBe("required");
        expect(report.billing.tokenPricingAvailable).toBe(false);
        expect(report.billing.cashCostAccountingValid).toBe(false);
        const decision = exactBindingCapabilityGate(report);
        expect(decision.ok).toBe(false);
        expect(decision.reason).toContain("pricing_table_missing");
      });

      test("the transport's own pricingReady is what admits the same route", async () => {
        const report = await bindingReportForBilling(
          { mode: "metered", pricingReady: true },
          PINNED_SNAPSHOT_ROUTE,
        );

        expect(report.billing.tokenPricingAvailable).toBe(true);
        expect(report.billing.cashCostAccountingValid).toBe(true);
        expect(exactBindingCapabilityGate(report).ok).toBe(true);
      });
    });

    // 2026-09-02, the spend ledger's PRODUCTION composition. Everything the
    // ledger does was already built and tested (spend-limiter.test.ts for the
    // CAS semantics, spend-wiring.test.ts for the harness calls) — and none
    // of it ran, because nothing in src/ ever constructed a `SpendLedger`.
    // These arms are about the composition itself: one instance held by
    // `MultiProviderRunner` for the whole run, handed only to metered
    // bindings.
    //
    // Why that gap mattered enough to be a merge blocker rather than a
    // follow-up: admitting a metered route on the transport's own provider
    // cost (the describe above) is only safe because a bogus provider `$0` is
    // caught downstream. With no ledger, `settlementFromUsage` is never
    // called and the catch never fires.
    describe("the run's spend ledger is composed, and fences metered buckets", () => {
      // Counts execute() calls, which is the whole assertion: the difference
      // between REPORTING an unresolved reservation and FENCING on it is
      // whether the next attempt reaches the transport at all.
      function countingTransport(
        backend: RunnerBackend,
        usage: NormalizedUsage,
        capabilityOverrides: Partial<ProviderCapabilityReport> = {},
      ) {
        const base = createMockTransport(backend, [], capabilityOverrides);
        let executeCount = 0;
        const transport: ProviderTransport = {
          ...base,
          execute: async () => {
            executeCount += 1;
            return {
              completion: "success" as const,
              protocolIntegrity: "verified" as const,
              finalText: '{"findings":[]}',
              usage,
              stderrTail: "",
            };
          },
        };
        return { transport, executeCount: () => executeCount };
      }

      // Provider-reported $0 on a metered attempt that produced output — the
      // exact shape `settlementFromUsage`'s metered-zero rule refuses.
      const METERED_ZERO: NormalizedUsage = {
        wallMs: 10,
        tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
        completeness: "complete",
        billingMode: "metered",
        costSource: "provider",
        cashCostUsd: 0,
      };

      // Two steps sharing ONE route, so they share one bucket
      // (`bindingBucketId` keys on provider + credential).
      function openCodeOAuthRuntime(
        opencodeFixture: { canonicalPath: string; sha256: string },
        transport: ProviderTransport,
      ) {
        const step = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: "openai/gpt-4o",
          routingConfig: {
            mappings: {
              "openai/gpt-4o": {
                backend: "opencode",
                provider: "openai",
                modelFamily: "gpt-4o",
                modelSnapshot: "gpt-4o",
              },
            },
          },
        });
        const registry = new DefaultTransportRegistry();
        registry.register("opencode", transport);
        return {
          step,
          registry,
          options: {
            workspaceRoot: tmpDir,
            plan: createResolvedRoutePlan([step]),
            openCodeBinaryPath: opencodeFixture.canonicalPath,
            executableAllowlists: {
              opencode: [
                {
                  absolutePath: opencodeFixture.canonicalPath,
                  sha256: opencodeFixture.sha256,
                },
              ],
            },
            registry,
            mode: "conformance" as const,
            credentialBrokers: {
              opencode: new OpenCodeAuthBroker({
                readerFn: async () =>
                  JSON.stringify({
                    openai: { type: "oauth", access: "test", refresh: "test" },
                  }),
              }),
            },
            authorityDeps: {
              existsFn: (candidate: string) =>
                candidate === opencodeFixture.canonicalPath ||
                candidate.startsWith(tmpDir),
              realpathFn: async (candidate: string) => candidate,
            },
          },
        };
      }

      test("a metered $0 attempt fences its bucket, and the next step never reaches the transport", async () => {
        // The metered mode arrives from the TRANSPORT's own report here, not
        // from a `provider_api_token` credential. Both doors reach the same
        // `effectiveBillingMode` (production-runtime's #133/#161 note names
        // them), and splitting them keeps this arm about the WIRING: the
        // credential->metered derivation is already proven by the
        // "provider_api_token routes bill as metered" arms above, and the
        // transport->usage stamping by the OpenCode conformance suite. This
        // test owns the third link, which is the one that was missing.
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
        const metered = countingTransport("opencode", METERED_ZERO, {
          billing: { mode: "metered", pricingReady: true },
        });
        const { step, options } = openCodeOAuthRuntime(
          opencodeFixture,
          metered.transport,
        );
        const runtime = await createProductionRuntime(options);

        const first = await runtime.runner.run(
          makeStep(tmpDir, {
            name: "hunter-reliability",
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        );
        expect(first.reservations?.length).toBe(1);
        expect(first.reservations?.[0]?.state).toBe("unresolved_remote");
        expect(first.reservations?.[0]?.knownUsd).toBeUndefined();
        expect(metered.executeCount()).toBe(1);

        // A DIFFERENT step on the same bucket. Refused inside `reserve()`,
        // which runs before `runAdmittedAttempt` — so the count staying at 1
        // is the proof this is a fence and not a report.
        const second = await runtime.runner.run(
          makeStep(tmpDir, {
            name: "refuter",
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        );
        expect(second.status).toBe("failed");
        expect(second.stderrTail).toContain("fenced");
        expect(metered.executeCount()).toBe(1);
      });

      test("a subscription backend reserves nothing, so an unresolvable attempt cannot fence the next one", async () => {
        // The discriminator for the deliberate NON-wiring of subscription
        // bindings. `normalizeUnavailableUsage` is completeness
        // "unavailable", which `finalizeReservation` routes to
        // markUnresolvedRemote — so with a ledger attached this would fence
        // and the second run would be refused. On a subscription bucket that
        // would refuse the refuter over dollars that cannot be spent, against
        // a pipeline built to survive a lost hunter.
        const claude = countingTransport(
          "claude-code",
          normalizeUnavailableUsage({ wallMs: 10 }),
        );
        const step = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: "sonnet",
        });
        const registry = new DefaultTransportRegistry();
        registry.register("claude-code", claude.transport);
        const runtime = await createProductionRuntime({
          workspaceRoot: tmpDir,
          plan: createResolvedRoutePlan([step]),
          binaryPath: claudeFixture.canonicalPath,
          executableAllowlists: claudeAllowlist(claudeFixture),
          registry,
          mode: "conformance",
          // #279: a SUCCESSFUL projection, deterministically — see the WHY
          // on `successfulClaudeCredentialBroker`. This test is about the
          // NON-degraded case; its degraded sibling is
          // "#279: a subscription binding fences a degraded ambient-key
          // attempt..." below.
          credentialBrokers: {
            "claude-code": successfulClaudeCredentialBroker,
          },
        });

        const first = await runtime.runner.run(
          makeStep(tmpDir, {
            name: "hunter-reliability",
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        );
        const second = await runtime.runner.run(
          makeStep(tmpDir, {
            name: "refuter",
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        );

        // Absent, not empty: no reservation was ever attempted. That absence
        // IS the signal a claude-only run is meant to carry.
        expect(first.reservations).toBeUndefined();
        expect(second.reservations).toBeUndefined();
        expect(claude.executeCount()).toBe(2);
      });

      test("a fenced metered bucket does not refuse a different credential's steps", async () => {
        // `bindingBucketId` keys on provider + credential, so the fence lands
        // on the credential that could not account for its spend. A run
        // mixing backends must keep going on the ones that still can.
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
        const openStep = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: "openai/gpt-4o",
          routingConfig: {
            mappings: {
              "openai/gpt-4o": {
                backend: "opencode",
                provider: "openai",
                modelFamily: "gpt-4o",
                modelSnapshot: "gpt-4o",
              },
            },
          },
        });
        const claudeStep = resolveStepRoute({
          stepKey: "refuter",
          role: "refuter",
          cliModel: "sonnet",
        });
        const metered = countingTransport("opencode", METERED_ZERO, {
          billing: { mode: "metered", pricingReady: true },
        });
        const claude = countingTransport("claude-code", {
          wallMs: 10,
          tokens: { totalKnown: 1 },
          completeness: "complete",
          billingMode: "subscription",
          costSource: "provider",
          cashCostUsd: 0,
        });
        const registry = new DefaultTransportRegistry();
        registry.register("opencode", metered.transport);
        registry.register("claude-code", claude.transport);
        const runtime = await createProductionRuntime({
          workspaceRoot: tmpDir,
          plan: createResolvedRoutePlan([openStep, claudeStep]),
          binaryPath: claudeFixture.canonicalPath,
          openCodeBinaryPath: opencodeFixture.canonicalPath,
          executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
          registry,
          mode: "conformance",
          credentialBrokers: {
            // The claude step must not fall through to the host's Keychain.
            "claude-code": successfulClaudeCredentialBroker,
            opencode: new OpenCodeAuthBroker({
              readerFn: async () =>
                JSON.stringify({
                  openai: { type: "oauth", access: "test", refresh: "test" },
                }),
            }),
          },
          authorityDeps: {
            existsFn: (candidate: string) =>
              candidate === claudeFixture.canonicalPath ||
              candidate === opencodeFixture.canonicalPath ||
              candidate.startsWith(tmpDir),
            realpathFn: async (candidate: string) => candidate,
          },
        });

        const fenced = await runtime.runner.run(
          makeStep(tmpDir, {
            name: "hunter-reliability",
            routeKey: openStep.routeFingerprint,
            route: openStep.route,
          }),
        );
        expect(fenced.reservations?.[0]?.state).toBe("unresolved_remote");

        const survivor = await runtime.runner.run(
          makeStep(tmpDir, {
            name: "refuter",
            routeKey: claudeStep.routeFingerprint,
            route: claudeStep.route,
          }),
        );
        expect(survivor.status).toBe("ok");
        expect(claude.executeCount()).toBe(1);
      });

      // #279 (fixed 2026-09-24, option 2): the harness's OWN per-attempt
      // fence for a subscription binding whose Keychain projection degrades
      // onto an ambient key/token. `reservesSpend` stays FALSE for this
      // binding — unchanged from "a subscription backend reserves nothing"
      // above — what changed is that `MultiProviderRunner.run` now hands
      // EVERY binding the ledger unconditionally (production-runtime.ts,
      // the WHY above `isolation` in `run`), so the harness can open ONE
      // reservation for the ONE attempt whose projection actually degraded,
      // without touching admission's own subscription verdict.
      test("#279: a subscription binding fences a degraded ambient-key attempt, and a later non-degraded attempt on the SAME credential is unaffected", async () => {
        // Degrades exactly once (mirrors the real Keychain-record-moved
        // failure this option exists for), then succeeds — so the SECOND
        // run on this SAME binding proves the fence landed on the
        // ambient-key's OWN mirrored bucket, not the subscription binding's
        // bucket (`degradedMeteredBucketId`'s WHY, production-runtime.ts).
        let projectCalls = 0;
        const degradingBroker: CredentialBroker = {
          async project() {
            projectCalls++;
            if (projectCalls === 1) {
              throw new CredentialProjectionError(
                "missing_subscription_record",
              );
            }
            const projection: CredentialProjection = {
              projectionId: `cred-279-${projectCalls}`,
              kind: "claude_subscription_oauth",
              syntheticHome: tmpDir,
              syntheticConfigHome: path.join(tmpDir, ".claude"),
              syntheticTmp: tmpDir,
              env: {},
              files: [],
              destroy: async () => {},
            };
            return projection;
          },
        };
        // The ambient key this test's own attempt runs on — the harness's
        // `childEnv` defaults to `process.env`
        // (`MultiProviderRunner.run` never threads a test-injected env
        // through it), so this is the one seam that can put a real
        // ANTHROPIC_API_KEY in front of it. Saved and restored so this
        // test is deterministic standalone AND under
        // `ANTHROPIC_API_KEY=dummy-not-real bun test`.
        const priorKey = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = "sk-ambient-279-test";
        try {
          const claude = countingTransport("claude-code", METERED_ZERO);
          const step = resolveStepRoute({
            stepKey: "hunter-reliability",
            role: "hunter",
            cliModel: "sonnet",
          });
          const registry = new DefaultTransportRegistry();
          registry.register("claude-code", claude.transport);
          const runtime = await createProductionRuntime({
            workspaceRoot: tmpDir,
            plan: createResolvedRoutePlan([step]),
            binaryPath: claudeFixture.canonicalPath,
            executableAllowlists: claudeAllowlist(claudeFixture),
            registry,
            mode: "conformance",
            credentialBrokers: { "claude-code": degradingBroker },
          });

          const degraded = await runtime.runner.run(
            makeStep(tmpDir, {
              name: "hunter-reliability",
              routeKey: step.routeFingerprint,
              route: step.route,
            }),
          );
          // The degrade itself: this ONE attempt DID reserve and, on the
          // same metered-zero shape the OpenCode arm above fences on,
          // settled unresolved — never silent (stderrTail says so).
          expect(degraded.reservations?.length).toBe(1);
          expect(degraded.reservations?.[0]?.state).toBe("unresolved_remote");
          expect(degraded.stderrTail).toContain(
            "ambient credential bills metered",
          );
          expect(claude.executeCount()).toBe(1);

          // A SECOND attempt on the SAME binding — the broker now succeeds
          // (`projectCalls === 2` above), so THIS attempt is a normal,
          // non-degraded subscription run. If the fence above had landed on
          // the binding's OWN bucket, this would be refused too; it must
          // not be — that is the whole point of `degradedMeteredBucketId`
          // mirroring a DIFFERENT credential's bucket.
          const clean = await runtime.runner.run(
            makeStep(tmpDir, {
              name: "refuter",
              routeKey: step.routeFingerprint,
              route: step.route,
            }),
          );
          expect(clean.status).toBe("ok");
          expect(clean.reservations).toBeUndefined();
          expect(claude.executeCount()).toBe(2);
        } finally {
          if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
          else process.env.ANTHROPIC_API_KEY = priorKey;
        }
      });
    });

    // #133. The credential KIND is what decides how a route bills, and it is
    // provider-keyed: an OpenCode route on any provider but `openai` runs on a
    // metered API token. The legacy backend-wide report cannot know that --
    // it is produced before any route resolves -- so it keeps saying
    // "subscription" and the binding corrects it.
    //
    // Why the correction has to reach all THREE billing expressions and not
    // just `billing.mode`: `pricingApplicability`, `mode` and
    // `cashCostAccountingValid` each read the mode independently. Upgrading
    // only `mode` leaves `pricingApplicability` at "not_applicable", the
    // pricing gate never fires, and a metered route is admitted as
    // priced-not-required -- which is precisely the under-reporting this
    // issue exists to prevent: the run executes on real spend and reports $0.
    describe("provider_api_token routes bill as metered", () => {
      // #137 repointed this at a model the bundled zai table deliberately
      // omitted; #197 deleted that table, so "unpriced" is decided by the
      // mock transport's `pricingReady: false` alone and any zai model would
      // now do. `glm-5-turbo` stays: it is routable in OpenCode
      // (`opencode models`, 2026-09-02), so the arm keeps naming a model that
      // really exists rather than a placeholder.
      const UNPRICED_ZAI_MODEL = "zai/glm-5-turbo";

      async function openCodeBindingReport(
        provider: string,
        options?: { readonly logical?: string },
      ) {
        const logical = options?.logical ?? UNPRICED_ZAI_MODEL;
        const model = logical.split("/")[1];
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
        const routingConfig: RoutingConfig = {
          mappings: {
            [logical]: {
              backend: "opencode",
              provider,
              modelFamily: model,
              modelSnapshot: model,
            },
          },
        };
        const step = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: logical,
          routingConfig,
        });
        const plan = createResolvedRoutePlan([step]);
        const registry = new DefaultTransportRegistry();
        registry.register(
          "opencode",
          createMockTransport("opencode", [], {
            // Load-bearing: the mock's default is `pricingReady: true`, which
            // would make `tokenPricingAvailable` true from the transport alone
            // and the arm would prove nothing about the gate.
            billing: { mode: "subscription", pricingReady: false },
          }),
        );
        const runtime = await createProductionRuntime({
          workspaceRoot: tmpDir,
          plan,
          openCodeBinaryPath: opencodeFixture.canonicalPath,
          executableAllowlists: {
            opencode: [
              {
                absolutePath: opencodeFixture.canonicalPath,
                sha256: opencodeFixture.sha256,
              },
            ],
          },
          registry,
          mode: "conformance",
        });
        const binding = runtime.bindings.get(step.routeFingerprint);
        if (binding === undefined) throw new Error("missing binding");
        return { binding, report: await binding.capabilities() };
      }

      test("an unpriced zai route is refused by the pricing gate, not billed as a subscription", async () => {
        const { binding, report } = await openCodeBindingReport("zai");

        expect(binding.credential.kind).toBe("provider_api_token");
        expect(report.auth.kind).toBe("provider_api_token");
        expect(report.billing.mode).toBe("metered");
        // The three independent readers must move together.
        expect(report.billing.pricingApplicability).toBe("required");
        expect(report.billing.tokenPricingAvailable).toBe(false);
        expect(report.billing.cashCostAccountingValid).toBe(false);

        const issues = exactBindingCapabilityIssues(report);
        const pricing = issues.find(
          (issue) => issue.code === "pricing_table_missing",
        );
        expect(pricing).toBeDefined();
        expect(pricing?.blocking).toBe(true);
        expect(exactBindingCapabilityGate(report).ok).toBe(false);
      });

      test("the openai OAuth route on the same backend still bills as a subscription", async () => {
        const { binding, report } = await openCodeBindingReport("openai");

        expect(binding.credential.kind).toBe("opencode_chatgpt_oauth");
        expect(report.billing.mode).toBe("subscription");
        expect(report.billing.pricingApplicability).toBe("not_applicable");
        expect(report.billing.cashCostAccountingValid).toBe(true);
        expect(exactBindingCapabilityGate(report).ok).toBe(true);
      });

      // The upgrade is one-way. A metered legacy report on an OAuth route
      // must NOT be downgraded to subscription, and `unknown` must still
      // reach `cashCostAccountingValid: false` for every kind that is not
      // provider_api_token -- that is what keeps the narrowing comment on
      // FrozenRuntimeBinding.capabilities() true.
      test("the effective mode only ever upgrades", async () => {
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
        const routingConfig: RoutingConfig = {
          mappings: {
            "openai/gpt-4o": {
              backend: "opencode",
              provider: "openai",
              modelFamily: "gpt-4o",
              modelSnapshot: "gpt-4o",
            },
          },
        };
        const step = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: "openai/gpt-4o",
          routingConfig,
        });
        const plan = createResolvedRoutePlan([step]);
        const registry = new DefaultTransportRegistry();
        registry.register(
          "opencode",
          createMockTransport("opencode", [], {
            billing: { mode: "unknown", pricingReady: false },
          }),
        );
        const runtime = await createProductionRuntime({
          workspaceRoot: tmpDir,
          plan,
          openCodeBinaryPath: opencodeFixture.canonicalPath,
          executableAllowlists: {
            opencode: [
              {
                absolutePath: opencodeFixture.canonicalPath,
                sha256: opencodeFixture.sha256,
              },
            ],
          },
          registry,
          mode: "conformance",
        });
        const binding = runtime.bindings.get(step.routeFingerprint);
        if (binding === undefined) throw new Error("missing binding");
        const report = await binding.capabilities();

        expect(binding.credential.kind).toBe("opencode_chatgpt_oauth");
        expect(report.billing.mode).toBe("subscription");
        expect(report.billing.cashCostAccountingValid).toBe(false);
        const decision = exactBindingCapabilityGate(report);
        expect(decision.ok).toBe(false);
        expect(decision.reason).toContain("cash_cost_accounting_invalid");
      });

      // #133 scope note, proven rather than asserted: the OpenCode SERVER is
      // one per backend and outlives every step, so a plan mixing an `openai`
      // OAuth route with a `zai` API-token route would need two credentials
      // behind one server. That is out of scope here -- but it must fail
      // LOUD, not run one provider's steps under the other's credential.
      // `resolveFrozenBindings` gates per BINDING, so the unpriced metered
      // route is refused before anything launches.
      test("a plan mixing an OAuth provider and an API-token provider is refused per binding", async () => {
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
        const routingConfig: RoutingConfig = {
          mappings: {
            "openai/gpt-4o": {
              backend: "opencode",
              provider: "openai",
              modelFamily: "gpt-4o",
              modelSnapshot: "gpt-4o",
            },
            // #137: `glm-5-turbo`, not `glm-5`. The bundled zai table now
            // prices `glm-5`, and this arm needs the metered binding to be
            // refused for PRICING so `pricing_table_missing` is still what
            // proves the per-binding gate ran. `glm-5-turbo` is routable in
            // OpenCode and absent from z.ai's published table, so it stays
            // unpriceable on any clock -- which matters here because this
            // probe reads the wall clock and has no `now` seam.
            [UNPRICED_ZAI_MODEL]: {
              backend: "opencode",
              provider: "zai",
              modelFamily: UNPRICED_ZAI_MODEL.split("/")[1],
              modelSnapshot: UNPRICED_ZAI_MODEL.split("/")[1],
            },
          },
        };
        const oauthStep = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: "openai/gpt-4o",
          routingConfig,
        });
        const tokenStep = resolveStepRoute({
          stepKey: "refuter",
          role: "refuter",
          cliModel: UNPRICED_ZAI_MODEL,
          routingConfig,
        });
        const plan = createResolvedRoutePlan([oauthStep, tokenStep]);
        const registry = new DefaultTransportRegistry();
        registry.register(
          "opencode",
          createMockTransport("opencode", [], {
            billing: { mode: "subscription", pricingReady: false },
          }),
        );

        const probe = await probeBindingsReadiness({
          workspaceRoot: tmpDir,
          plan,
          openCodeBinaryPath: opencodeFixture.canonicalPath,
          executableAllowlists: {
            opencode: [
              {
                absolutePath: opencodeFixture.canonicalPath,
                sha256: opencodeFixture.sha256,
              },
            ],
          },
          registry,
          mode: "conformance",
        });

        expect(probe.decision.ok).toBe(false);
        expect(probe.decision.reason).toContain("pricing_table_missing");
        // The two bindings differ: the OAuth one is admissible on its own.
        const kinds = [...probe.bindings.values()]
          .map((binding) => binding.credential.kind)
          .sort();
        expect(kinds).toEqual(["opencode_chatgpt_oauth", "provider_api_token"]);
        await probe.dispose();
      });
    });

    // 2026-09-02: provider cost, the design's PRIMARY metered pricing source
    // (§8: "Metered routes require provider cost or a versioned rate-table
    // calculation" — provider cost is named FIRST; the table is the
    // fallback). `tokenPricingAvailable` has been a disjunction since #137,
    // but the first disjunct was never connected: every transport reported
    // `pricingReady: false`, so only the table could ever answer.
    //
    // These two arms are a PAIR. The first proves the OpenCode transport's
    // own claim now admits a route no catalogue can price; the second proves
    // the widening did not leak to the claude-code CLI, which reports no cost
    // of its own and for which the table really is the only path. Either arm
    // alone would also pass against a change that widened both.
    describe("a transport that reports provider cost prices its own routes", () => {
      // Same model the arms above use for "no catalogue can price this":
      // routable in OpenCode, absent from z.ai's published table on any
      // clock. Here it is the whole point — nothing but the transport's own
      // claim can be answering.
      const UNPRICED_ZAI_MODEL = "zai/glm-5-turbo";

      // A client that is never driven: `capabilities()` touches none of it.
      // Constructed rather than mocked so the report under test comes from
      // the REAL OpenCodeSdkTransport — a mock transport here would assert
      // the fixture's opinion of pricing readiness, not the transport's.
      const idleOpenCodeClient = {
        createSession: async () => ({ id: "sess-idle" }),
        streamEvents: async function* () {},
        pollStatus: async () => ({ kind: "pending" }) as const,
        abort: async () => {},
      };

      test("an uncatalogued metered model is admitted on the OpenCode transport's own cost reporting", async () => {
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
        const model = UNPRICED_ZAI_MODEL.split("/")[1];
        const routingConfig: RoutingConfig = {
          mappings: {
            [UNPRICED_ZAI_MODEL]: {
              backend: "opencode",
              provider: "zai",
              modelFamily: model,
              modelSnapshot: model,
            },
          },
        };
        const step = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: UNPRICED_ZAI_MODEL,
          routingConfig,
        });
        const plan = createResolvedRoutePlan([step]);
        // No `registry.register("opencode", ...)`: the registry's own factory
        // builds a real OpenCodeSdkTransport around the idle client.
        const registry = new DefaultTransportRegistry({
          mode: "conformance",
          openCodeClient: idleOpenCodeClient,
        });
        const runtime = await createProductionRuntime({
          workspaceRoot: tmpDir,
          plan,
          openCodeBinaryPath: opencodeFixture.canonicalPath,
          executableAllowlists: {
            opencode: [
              {
                absolutePath: opencodeFixture.canonicalPath,
                sha256: opencodeFixture.sha256,
              },
            ],
          },
          registry,
          mode: "conformance",
        });
        const binding = runtime.bindings.get(step.routeFingerprint);
        if (binding === undefined) throw new Error("missing binding");
        const report = await binding.capabilities();

        // #133 still decides the billing mode: this is a metered route.
        expect(binding.credential.kind).toBe("provider_api_token");
        expect(report.billing.mode).toBe("metered");
        expect(report.billing.pricingApplicability).toBe("required");
        // The catalogue cannot answer for this model on ANY clock, so the
        // transport's own claim is the only thing that can be.
        expect(report.billing.tokenPricingAvailable).toBe(true);
        expect(report.billing.cashCostAccountingValid).toBe(true);
        expect(exactBindingCapabilityGate(report).ok).toBe(true);
      });

      test("the claude-code CLI reports its own cost, so an unpriceable model there is admitted (#197)", async () => {
        // THE widening #197 asked for, asserted as an outcome rather than as
        // a flag. `pricingReady` is READ OFF the real ClaudeCodeCliTransport
        // rather than written as a literal: the literal would keep this arm
        // green if the transport were narrowed back, which is the direction
        // that would silently start refusing routes again.
        const claudeBilling = await new ClaudeCodeCliTransport().capabilities();
        expect(claudeBilling.billing.pricingReady).toBe(true);

        // An anthropic snapshot no bundled table ever carried — the point
        // being that no table is consulted at all any more. Before #197 this
        // exact route was REFUSED (`pricing_table_missing`, blocking); the
        // CLI's `total_cost_usd` is what admits it now.
        const routingConfig: RoutingConfig = {
          default: {
            backend: "claude-code",
            provider: "anthropic",
            modelFamily: "claude-sonnet-5",
            modelSnapshot: "claude-sonnet-4-1",
          },
        };
        const report = await bindingReportForBilling(
          {
            mode: "metered",
            pricingReady: claudeBilling.billing.pricingReady,
          },
          routingConfig,
        );

        expect(report.billing.pricingApplicability).toBe("required");
        expect(report.billing.tokenPricingAvailable).toBe(true);
        expect(report.billing.cashCostAccountingValid).toBe(true);
        expect(exactBindingCapabilityGate(report).ok).toBe(true);
      });
    });

    // 2026-09-02, the SECOND derivation of one fact. `capabilities()` reads
    // the billing mode off `this.credential.kind` — the kind
    // `resolveBindingAuthority` resolved for THIS route. The OpenCode
    // transport factory reads it off `merged.credentialKind`, which reaches
    // it only from the registry's construction-time `defaultOptions` or from
    // the options `registry.get()` was called with. Two sources for one fact
    // is how they diverge in silence (#149's "two brokers", same shape).
    //
    // The arm above is the one that shipped the gap: it builds a registry
    // with NO `credentialKind` and asserts `capabilities()` only, so the
    // transport's stamp was never observed. These arms drive a real attempt
    // through that same registry and read the emitted record, because the
    // stamp is what `settlementFromUsage`'s metered-zero rule keys on — a
    // metered route whose transport stamps "subscription" makes that rule
    // DEAD, and an unaccountable provider $0 settles as a truthful cost.
    describe("a registry built without a credential kind still bills a metered route metered", () => {
      // Routable in OpenCode, absent from every bundled table — so admission
      // rides on the transport's own provider-cost claim, exactly like the
      // arm above. `zai` is what makes the credential a
      // `provider_api_token`: `credentialKindForRoute` gives OAuth only to
      // `openai`.
      const UNPRICED_ZAI_MODEL = "zai/glm-5-turbo";

      // `MultiProviderRunner.run` pre-confirms the OpenCode SDK before every
      // opencode attempt, and `needsOpenCodeSdkProbe()` is false only for a
      // backend a caller OVERRODE with `registry.register("opencode", ...)`.
      // Every other opencode arm in this file registers an instance and so
      // never probes; these arms must NOT, because registering an instance
      // bypasses the factory — and the factory reading `credentialKind` is
      // the entire property under test. So these two are the only arms that
      // reach the probe, and `@opencode-ai/sdk` is an OPTIONAL dependency: on
      // any checkout installed without it the probe fails before anything
      // else, since it runs ahead of `acquire()` and ahead of credential
      // projection. Injecting `loadSdk` satisfies it without the package —
      // `probeOpenCodeSdk()` discards the result, and `createOpenCodeClient`
      // is on the branch an injected `openCodeClient` skips.
      //
      // What this seam is NOT: the fix for these arms' CI failure. That was
      // diagnosed as a missing SDK because hiding the package reproduced the
      // symptom exactly — and it did, because `sessionCount() === 0` is what
      // EVERY upstream failure looks like from down here. The real cause was
      // the credential broker below. A symptom match is not a cause; the
      // guard that told them apart is `assertAttemptRan`.
      const loadSdk = async () =>
        ({
          createOpencodeClient: () => ({ session: {}, event: {} }),
        }) as unknown as import("../src/transports/opencode-client").OpenCodeSdkLike;

      // A setup failure and the defect are INDISTINGUISHABLE at
      // `usage.billingMode`: an attempt that never ran emits no record, and
      // an attempt stamped wrong emits the wrong one — both leave the billing
      // assertion red. This repo has already paid for that shape ("a test red
      // against a broken system proves only the first failure"), and CI paid
      // for it again here: with the SDK absent these arms failed at
      // `sessionCount() === 0`, which is exactly what the bug would look
      // like. So the attempt is proven to have RUN first, and the failure
      // carries the runner's OWN reason — a missing optional SDK, a denied
      // workspace, an unregistered backend all name themselves in
      // `stderrTail` — instead of impersonating a billing defect.
      function assertAttemptRan(result: {
        status: string;
        attempts: number;
        stderrTail: string;
      }): void {
        if (result.status !== "ok" || result.attempts !== 1) {
          throw new Error(
            `no attempt ran, so nothing below can say anything about how it billed — this is an ENVIRONMENT failure, not a billing one: status=${result.status} attempts=${result.attempts} stderrTail=${result.stderrTail}`,
          );
        }
      }

      // Provider-reported $0 beside real output tokens — the exact shape the
      // metered-zero rule refuses, delivered through the REAL
      // OpenCodeSdkTransport rather than a mock's opinion of one. A mock
      // would stamp whatever the fixture says and prove nothing about the
      // factory.
      function meteredZeroClient() {
        let sessions = 0;
        const client = {
          createSession: async () => {
            sessions += 1;
            return { id: `oc-sess-${sessions}` };
          },
          // A fresh generator per call: one shared iterable would be
          // exhausted by the first attempt and silently deliver nothing to
          // the second.
          async *streamEvents() {
            // A hunter step is given Read. #214 fails a tools-given empty
            // draft that issued no tool-call parts; this fixture is about
            // billing, not vacuity, so it looks, then finds nothing.
            yield { kind: "tool" as const };
            yield { kind: "delta" as const, text: '{"findings":[]}' };
            yield {
              kind: "usage" as const,
              mode: "snapshot" as const,
              inputTokens: 10,
              outputTokens: 5,
              costUsd: 0,
            };
            yield {
              kind: "terminal" as const,
              proof: {
                eventId: "evt-metered-zero",
                providerStatus: "completed",
                providerObservedAt: "2026-09-02T00:00:00.000Z",
              },
            };
          },
          pollStatus: async () => ({ kind: "pending" }) as const,
          abort: async () => {},
        };
        return { client, sessionCount: () => sessions };
      }

      function zaiRuntimeOptions(
        opencodeFixture: { canonicalPath: string; sha256: string },
        openCodeClient: ReturnType<typeof meteredZeroClient>["client"],
      ) {
        const model = UNPRICED_ZAI_MODEL.split("/")[1];
        const step = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: UNPRICED_ZAI_MODEL,
          routingConfig: {
            mappings: {
              [UNPRICED_ZAI_MODEL]: {
                backend: "opencode",
                provider: "zai",
                modelFamily: model,
                modelSnapshot: model,
              },
            },
          },
        });
        // THE construction under test: no `credentialKind`. Every test, every
        // doctor probe and every caller of the public
        // `createProductionRuntime` that supplies its own registry lands
        // here, because only `productionFallbackRegistry` wires the kind at
        // construction time.
        const registry = new DefaultTransportRegistry({
          mode: "conformance",
          openCodeClient,
          loadSdk,
        });
        return {
          step,
          options: {
            workspaceRoot: tmpDir,
            plan: createResolvedRoutePlan([step]),
            openCodeBinaryPath: opencodeFixture.canonicalPath,
            executableAllowlists: {
              opencode: [
                {
                  absolutePath: opencodeFixture.canonicalPath,
                  sha256: opencodeFixture.sha256,
                },
              ],
            },
            registry,
            mode: "conformance" as const,
            // The defect the CI red actually exposed, and it is worse than a
            // red build: with no broker injected, `resolveBindingAuthority`
            // falls through to `openCodeCredentialBroker("zai")` — a real
            // `OpenCodeApiTokenBroker` reading the OPERATOR's
            // ~/.local/share/opencode/auth.json. On CI that file is absent and
            // projection failed (`source_read_failed`); on a developer
            // machine it SUCCEEDS, so every `bun test` was reading a real
            // credential store and projecting a real API key into a temp dir.
            // An offline suite must never touch the operator's credentials —
            // the green local run was the more dangerous of the two outcomes,
            // because nothing about it looked wrong.
            //
            // `readerFn` is the same seam the OAuth arms above use; only the
            // broker CLASS differs, because it must match the kind this route
            // resolves (`provider_api_token`, from `credentialKindForRoute`)
            // — the broker refuses any other kind by name. Injecting a broker
            // changes only WHERE the credential comes from, never which kind
            // the binding resolved, which is why the arms stay non-vacuous;
            // both assert that kind explicitly.
            credentialBrokers: {
              opencode: new OpenCodeApiTokenBroker("zai", {
                readerFn: async () =>
                  JSON.stringify({ zai: { type: "api", key: "test-token" } }),
              }),
            },
          },
        };
      }

      test("the emitted usage record carries the binding's own metered kind", async () => {
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
        const driven = meteredZeroClient();
        const { step, options } = zaiRuntimeOptions(
          opencodeFixture,
          driven.client,
        );
        const runtime = await createProductionRuntime(options);

        const binding = runtime.bindings.get(step.routeFingerprint);
        if (binding === undefined) throw new Error("missing binding");
        // The authoritative source, asserted first so a failure below reads
        // as a divergence and not as a mis-set-up route.
        expect(binding.credential.kind).toBe("provider_api_token");
        expect((await binding.capabilities()).billing.mode).toBe("metered");

        const result = await runtime.runner.run(
          makeStep(tmpDir, {
            name: "hunter-reliability",
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        );

        assertAttemptRan(result);
        // Proves the attempt reached the TRANSPORT, not merely that the
        // harness returned ok — the record under assertion is the one this
        // session produced.
        expect(driven.sessionCount()).toBe(1);
        expect(result.usageV2?.cashCostUsd).toBe(0);
        expect(result.usageV2?.tokens.outputKnown).toBe(5);
        // The whole point: the record and the report agree because they now
        // read the SAME field.
        expect(result.usageV2?.billingMode).toBe("metered");
      });

      test("and the $0 attempt therefore fences its bucket, so the next step never reaches the transport", async () => {
        // The consequence the stamp exists for. With the transport stamping
        // "subscription", `settlementFromUsage` settles this $0 as truthful,
        // nothing is fenced, and the second step executes — under-reporting
        // real spend, which is the failure this PR exists to prevent.
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
        const driven = meteredZeroClient();
        const { step, options } = zaiRuntimeOptions(
          opencodeFixture,
          driven.client,
        );
        const runtime = await createProductionRuntime(options);

        // Non-vacuity, asserted per arm: the fence below is only the
        // metered-zero rule's consequence if this route really is metered.
        expect(
          runtime.bindings.get(step.routeFingerprint)?.credential.kind,
        ).toBe("provider_api_token");

        const first = await runtime.runner.run(
          makeStep(tmpDir, {
            name: "hunter-reliability",
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        );
        // Same guard, same reason: a first step that never ran carries no
        // reservation at all, which reads identically to a $0 that settled.
        assertAttemptRan(first);
        expect(first.reservations?.[0]?.state).toBe("unresolved_remote");
        expect(first.reservations?.[0]?.knownUsd).toBeUndefined();
        expect(driven.sessionCount()).toBe(1);

        const second = await runtime.runner.run(
          makeStep(tmpDir, {
            name: "refuter",
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        );
        expect(second.status).toBe("failed");
        expect(second.stderrTail).toContain("fenced");
        // Refused inside `reserve()`, before `runAdmittedAttempt` — the
        // session count staying at 1 is what makes this a fence and not a
        // report.
        expect(driven.sessionCount()).toBe(1);
      });
    });

    // SUGGESTION-1: capabilities() is deliberately non-memoised (it re-probes
    // by design, and DefaultTransportRegistry.getCapabilityReport calls
    // transport.capabilities() on every call), so a caller that gates and
    // then re-collects pays two full probe passes. The readiness probe must
    // hand its reports back so doctor consumes ONE pass.
    test("probeBindingsReadiness probes each binding once and returns the reports it gated on", async () => {
      const hunter = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const refuter = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opus",
      });
      const plan = createResolvedRoutePlan([hunter, refuter]);

      let probeCount = 0;
      const base = createMockTransport("claude-code");
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", {
        ...base,
        capabilities: async () => {
          probeCount += 1;
          return await base.capabilities();
        },
      });

      const probe = await probeBindingsReadiness({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });
      try {
        expect(probe.decision.ok).toBe(true);
        expect(probe.bindings.size).toBe(2);
        expect(probe.reports.length).toBe(2);
        expect([...probe.reports].map((r) => r.routeKey).sort()).toEqual(
          [...probe.bindings.keys()].sort(),
        );
        // One probe per binding — no second collection pass.
        expect(probeCount).toBe(probe.bindings.size);
      } finally {
        await probe.dispose();
      }
    });

    // WHY this test exists: collectDoctorExactBindingReports carried TWO
    // disagreeing branches and only the `loadSdk`-injected one was ever
    // exercised by a test. The real doctor/wizard path passes no loadSdk, so
    // it fell through to a registry with no mode at all — which the OpenCode
    // transport factory defaults to "production" — and every OpenCode route
    // was gated on the very D1-11 evidence this diagnostic probe exists to
    // produce. Fully hermetic: PATH-scoped fixture binaries, and neither
    // transport's capabilities() spawns a process or loads @opencode-ai/sdk.
    test("collectDoctorExactBindingReports probes an OpenCode route without the production D1-11 gate when no SDK loader is injected", async () => {
      await writeOpenCodeFixture(tmpDir);
      const routingConfig: RoutingConfig = {
        mappings: [
          {
            logical: "opus",
            backend: "opencode",
            provider: "openai",
            modelFamily: "gpt-4o",
            modelSnapshot: "gpt-4o",
          },
        ],
      };

      const reports = await collectDoctorExactBindingReports({
        workspaceRoot: tmpDir,
        routingConfig,
        env: { PATH: tmpDir },
      });

      expect(reports.length).toBe(2);
      expect([...reports].map((report) => report.backend).sort()).toEqual([
        "claude-code",
        "opencode",
      ]);
    });

    test("mixed Claude/OpenCode conformance admits with evidence and dispatches by routeKey", async () => {
      const routingConfig: RoutingConfig = {
        mappings: {
          "openai/gpt-4o": {
            backend: "opencode",
            provider: "openai",
            modelFamily: "gpt-4o",
            modelSnapshot: "gpt-4o",
            modelVariant: "high",
          },
        },
      };
      const claudeStep = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const openStep = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig,
      });
      const plan = createResolvedRoutePlan([claudeStep, openStep]);
      const opencodeFixture = await writeOpenCodeFixture(tmpDir);

      const claudeRequests: TransportRequest[] = [];
      const openRequests: TransportRequest[] = [];
      const registry = new DefaultTransportRegistry();
      registry.register(
        "claude-code",
        createMockTransport("claude-code", claudeRequests),
      );
      registry.register(
        "opencode",
        createMockTransport("opencode", openRequests),
      );

      const evidence: D1_11ReadinessEvidence = {
        sdkAvailable: true,
        credentialAuthority: true,
        workspaceBroker: true,
        pricingReady: true,
      };

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", evidence]]),
        credentialBrokers: {
          // The claude step must not fall through to the host's Keychain.
          "claude-code": successfulClaudeCredentialBroker,
          opencode: new OpenCodeAuthBroker({
            readerFn: async () =>
              JSON.stringify({
                openai: { type: "oauth", access: "test", refresh: "test" },
              }),
          }),
        },
        authorityDeps: {
          existsFn: (p) =>
            p === claudeFixture.canonicalPath ||
            p === opencodeFixture.canonicalPath ||
            p.startsWith(tmpDir),
          realpathFn: async (p) => p,
        },
      });

      expect(runtime.bindings.size).toBe(2);

      const claudeResult = await runtime.runner.run(
        makeStep(tmpDir, {
          routeKey: claudeStep.routeFingerprint,
          route: claudeStep.route,
        }),
      );
      const openResult = await runtime.runner.run(
        makeStep(tmpDir, {
          routeKey: openStep.routeFingerprint,
          route: openStep.route,
        }),
      );

      expect(claudeResult.status).toBe("ok");
      expect(openResult.status).toBe("ok");
      expect(claudeRequests).toHaveLength(1);
      expect(openRequests).toHaveLength(1);
      expect(openRequests[0].route.modelVariant).toBe("high");
      expect(openRequests[0].route.provider).toBe("openai");
    });

    test("resolveBinding matches gateway when routeKey is omitted", async () => {
      const routingConfig: RoutingConfig = {
        mappings: {
          sonnet: {
            backend: "claude-code",
            provider: "anthropic",
            gateway: "direct",
            modelFamily: "sonnet",
            modelSnapshot: "sonnet",
          },
          haiku: {
            backend: "claude-code",
            provider: "anthropic",
            gateway: "configured",
            modelFamily: "haiku",
            modelSnapshot: "haiku",
          },
        },
      };
      const directStep = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
        routingConfig,
      });
      const configuredStep = resolveStepRoute({
        stepKey: "hunter-resilience",
        role: "hunter",
        cliModel: "haiku",
        routingConfig,
      });
      const plan = createResolvedRoutePlan([directStep, configuredStep]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });
      const runner = runtime.runner as MultiProviderRunner;
      const directBinding = runner.resolveBinding({
        ...makeStep(tmpDir, { route: directStep.route }),
        routeKey: undefined,
      });
      const configuredBinding = runner.resolveBinding({
        ...makeStep(tmpDir, { route: configuredStep.route }),
        routeKey: undefined,
      });
      expect(directBinding?.route.gateway).toBe("direct");
      expect(configuredBinding?.route.gateway).toBe("configured");
    });

    test("bindings sharing a credential coarsen to one bucket id across models", async () => {
      const stepA = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const stepB = resolveStepRoute({
        stepKey: "hunter-resilience",
        role: "hunter",
        cliModel: "haiku",
      });
      const plan = createResolvedRoutePlan([stepA, stepB]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      const bindingA = runtime.bindings.get(stepA.routeFingerprint);
      const bindingB = runtime.bindings.get(stepB.routeFingerprint);
      expect(bindingA).toBeDefined();
      expect(bindingB).toBeDefined();
      if (bindingA === undefined || bindingB === undefined) return;
      expect(bindingA.credential.bucketId).toBe(bindingB.credential.bucketId);
      expect(bindingA.credential.bucketId).not.toContain(
        stepA.routeFingerprint.slice(0, 16),
      );
    });

    test("resolveBindingAuthority rejects unsupported backends without fallback", async () => {
      const result = await resolveBindingAuthority(
        "codex",
        "openai",
        { workspaceRoot: tmpDir },
        {
          existsFn: () => true,
          realpathFn: async (p) => p,
          readFileFn: async () => new Uint8Array([1]),
        },
      );
      expect(result.error).toContain("unsupported");
    });

    test("explicit mismatched OpenCode route does not fall back to Claude", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });
      const runner = runtime.runner as MultiProviderRunner;
      const unmatchedOpenCodeRoute = {
        backend: "opencode" as const,
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
      };

      expect(
        runner.resolveBinding({
          ...makeStep(tmpDir),
          route: unmatchedOpenCodeRoute,
        }),
      ).toBeUndefined();

      const result = await runner.run(
        makeStep(tmpDir, { route: unmatchedOpenCodeRoute }),
      );
      expect(result.status).toBe("failed");
      expect(result.stderrTail).toContain("No admitted binding");
    });

    test("resolveBindingAuthority rejects deceptive OpenCode executables not in configured allowlist", async () => {
      const deceptivePath = path.join(tmpDir, "README.sh");
      await writeFile(deceptivePath, "#!/bin/sh\necho deceptive\n");
      await chmod(deceptivePath, 0o755);
      const canonical = await realpath(deceptivePath);

      const result = await resolveBindingAuthority(
        "opencode",
        "openai",
        {
          workspaceRoot: tmpDir,
          openCodeBinaryPath: canonical,
          executableAllowlists: {
            opencode: [
              {
                absolutePath: "/usr/local/bin/opencode",
                sha256:
                  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              },
            ],
          },
        },
        {
          existsFn: () => true,
          realpathFn: async (p) => p,
          readFileFn: async (p) => {
            const text = await readFile(p);
            return new Uint8Array(text);
          },
        },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("not in configured allowlist");
    });

    test("exposed runtime bindings reject structural mutation", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      expect(() => {
        (runtime.bindings as Map<string, unknown>).set("evil", {});
      }).toThrow(ProductionRuntimeError);

      const binding = runtime.bindings.get(step.routeFingerprint);
      expect(binding).toBeDefined();
      if (binding === undefined) return;
      expect(() => {
        (binding.tools.deniedTools as string[]).push("WebSearch");
      }).toThrow();
    });

    test("execution re-probes exact-binding capabilities before transport acquire", async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-exec-cap-"));
      const claudeFixture = await writeClaudeFixture(tmpDir);
      await writeFile(path.join(tmpDir, "mcp.json"), "{}");
      await writeFile(path.join(tmpDir, "system.md"), "system");
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry({ mode: "conformance" });
      let driftAtExecution = false;
      const mock = createMockTransport("claude-code");
      registry.register("claude-code", {
        ...mock,
        capabilities: async () => {
          if (!driftAtExecution) {
            return mock.capabilities();
          }
          return {
            backend: "claude-code",
            status: "blocking",
            auth: {
              kind: "claude_subscription_oauth",
              projectionReady: false,
              probe: "failed",
            },
            isolation: {
              syntheticHome: true,
              workspaceReadBroker: true,
              codegraphPolicy: false,
            },
            protocol: {
              terminalProof: true,
              boundedEvents: false,
              usageMode: "snapshot",
            },
            cancellation: { deadlineMs: 7500, conformance: "passed" },
            billing: { mode: "subscription", pricingReady: false },
            issues: [
              {
                code: "auth_failed",
                message: "auth drifted",
                blocking: true,
              },
            ],
          };
        },
      });
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
        credentialBrokers: {
          "claude-code": stubClaudeCredentialBroker,
        },
        authorityDeps: {
          existsFn: (p) =>
            p === claudeFixture.canonicalPath || p.startsWith(tmpDir),
          realpathFn: async (p) => p,
        },
      });
      driftAtExecution = true;
      const result = await runtime.runner.run({
        name: "hunter-reliability",
        systemPromptPath: path.join(tmpDir, "system.md"),
        prompt: "go",
        tools: ["Read"],
        mcpConfigPath: path.join(tmpDir, "mcp.json"),
        model: "sonnet",
        effort: "high",
        cwd: tmpDir,
        outPath: path.join(tmpDir, "out.json"),
        timeoutMs: 60_000,
        maxAttempts: 1,
        parse: () => ({}),
        route: step.route,
        routeKey: step.routeFingerprint,
      });
      expect(result.status).toBe("failed");
      expect(result.stderrTail).toContain(
        "Exact-binding capability gate failed",
      );
      expect(result.stderrTail).toContain("auth_failed");
      await rm(tmpDir, { recursive: true, force: true });
    });
  });
});
