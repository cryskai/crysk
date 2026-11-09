import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutableAllowlistEntry } from "#model/provider-capabilities";
import { createResolvedRoutePlan, resolveStepRoute } from "#model/routing";
import type { StepSpec } from "#review/step-runner";
import { ConcurrencyAttemptAdmissionGate } from "../src/execution/admission";
import { ConcurrencyLimiter } from "../src/execution/concurrency-limiter";
import type {
  AsyncEventSink,
  IsolationProjection,
  ProviderCapabilityReport,
  ProviderEvent,
  ProviderTerminalProof,
  ProviderTransport,
  ResolvedModelRoute,
  RunnerBackend,
  TransportOutcome,
  TransportRequest,
} from "../src/execution/contracts";
import { StepExecutionHarness } from "../src/execution/harness";
import type { SettlementReceipt } from "../src/execution/settlement";
import { InMemorySpendLedger } from "../src/execution/spend-limiter";
import { settlementReceiptPath } from "../src/execution/step-artifacts";
import { createProductionRuntime } from "../src/production-runtime";
import type { CredentialBroker } from "../src/security/credential-broker";
import { OpenCodeAuthBroker } from "../src/security/credential-broker";
import { WorkspaceReadBroker } from "../src/security/workspace-read-broker";
import type {
  D1_11ReadinessEvidence,
  TransportFactoryOptions,
} from "../src/transport-registry";
import {
  createDefaultTransportRegistry,
  DefaultTransportRegistry,
  SUPPORTED_OPENCODE_SDK_VERSION,
  SUPPORTED_OPENCODE_SERVER_VERSION,
  type TransportRegistry,
} from "../src/transport-registry";
import type { OpenCodeSdkLike } from "../src/transports/opencode-client";
import { createOpenCodeClient } from "../src/transports/opencode-client";
import {
  type OpenCodeClientEvent,
  type OpenCodeClientLike,
  type OpenCodePollResult,
  OpenCodeSdkTransport,
} from "../src/transports/opencode-sdk";
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
    path.join(tmpdir(), "pr-hero-prod-tl-tmpdir-"),
  );
  process.env.TMPDIR = isolatedTmpdir;
});

afterAll(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(isolatedTmpdir, { recursive: true, force: true });
});

const ISOLATION_STUB: IsolationProjection = {
  credentialProjectionId: "test-projection",
  env: {},
  syntheticHome: "/tmp/home",
  syntheticConfigHome: "/tmp/config",
  syntheticTmp: "/tmp/tmp",
  verifiedBinaryPath: "/usr/bin/opencode",
};

const COMPLETE_EVIDENCE: D1_11ReadinessEvidence = {
  sdkAvailable: true,
  credentialAuthority: true,
  workspaceBroker: true,
  pricingReady: true,
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

function mixedAllowlists(
  claude: { canonicalPath: string; sha256: string },
  opencode: { canonicalPath: string; sha256: string },
): Partial<
  Record<"claude-code" | "opencode", readonly ExecutableAllowlistEntry[]>
> {
  return {
    "claude-code": [
      { absolutePath: claude.canonicalPath, sha256: claude.sha256 },
    ],
    opencode: [
      { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
    ],
  };
}

function createRecordingTransport(
  requests: TransportRequest[],
  backend: "claude-code" | "opencode" = "claude-code",
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

function makeStep(tmpDir: string, overrides: Partial<StepSpec> = {}): StepSpec {
  return {
    name: "hunter-reliability",
    systemPromptPath: path.join(tmpDir, "system.md"),
    prompt: "review",
    tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
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

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalProof(eventId: string): ProviderTerminalProof {
  return {
    eventId,
    providerStatus: "process_group_exited",
    providerObservedAt: new Date().toISOString(),
    exitCode: 0,
  };
}

function wrapRegistryWithReleaseTracking(registry: DefaultTransportRegistry): {
  registry: TransportRegistry;
  releases: string[];
} {
  const releases: string[] = [];
  const wrapped: TransportRegistry = {
    register: (backend, factoryOrInstance) =>
      registry.register(backend, factoryOrInstance),
    has: (backend) => registry.has(backend),
    get: (backend, options) => registry.get(backend, options),
    getCapabilityReport: (backend, options) =>
      registry.getCapabilityReport(backend, options),
    getAllCapabilityReports: (options) =>
      registry.getAllCapabilityReports(options),
    release: (routeFingerprint) => {
      releases.push(routeFingerprint);
      registry.release(routeFingerprint);
    },
  };
  return { registry: wrapped, releases };
}

class DestroyOrderBroker implements CredentialBroker {
  // #150: observable proof that the harness's per-step projection call
  // itself never happens for a transport declaring server-lifetime — not
  // just that its destroy never fires (which merely follows from the
  // projection never existing).
  projectCalls = 0;

  constructor(
    private readonly inner: CredentialBroker,
    private readonly order: string[],
  ) {}

  async project(
    input: Parameters<CredentialBroker["project"]>[0],
  ): ReturnType<CredentialBroker["project"]> {
    this.projectCalls++;
    const projection = await this.inner.project(input);
    const destroy = projection.destroy.bind(projection);
    return {
      ...projection,
      destroy: async () => {
        this.order.push("projection-destroy");
        await destroy();
      },
    };
  }
}

describe("Task 2.1 RED: production transport lifecycle", () => {
  let tmpDir: string;
  let claudeFixture: { canonicalPath: string; sha256: string };
  let opencodeFixture: { canonicalPath: string; sha256: string };

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-prod-tl-"));
    tmpDir = await realpath(tmpDir);
    claudeFixture = await writeClaudeFixture(tmpDir);
    opencodeFixture = await writeOpenCodeFixture(tmpDir);
    await writeFile(path.join(tmpDir, "system.md"), "system");
    await writeFile(
      path.join(tmpDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          codegraph: { command: "codegraph", args: ["mcp"] },
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("route-keyed transport cache", () => {
    test("DefaultTransportRegistry caches transports per routeFingerprint not per backend", () => {
      const registry = new DefaultTransportRegistry();
      registry.register("opencode", () => {
        return createRecordingTransport([], "opencode");
      });

      const routeA: ResolvedModelRoute = {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
        modelVariant: "high",
      };
      const routeB: ResolvedModelRoute = {
        backend: "opencode",
        provider: "anthropic",
        modelFamily: "claude-3-5-sonnet",
        modelSnapshot: "claude-3-5-sonnet-20241022",
      };

      const optionsA: TransportFactoryOptions = {
        routeFingerprint: "fp-route-a",
        route: routeA,
      };
      const optionsB: TransportFactoryOptions = {
        routeFingerprint: "fp-route-b",
        route: routeB,
      };

      const firstA = registry.get("opencode", optionsA);
      const secondA = registry.get("opencode", optionsA);
      const firstB = registry.get("opencode", optionsB);

      expect(firstA).toBe(secondA);
      expect(firstB).not.toBe(firstA);
    });

    test("variant routes do not share one backend-cached opencode transport instance", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register("opencode", () =>
        createRecordingTransport([], "opencode"),
      );

      const stepA = resolveStepRoute({
        stepKey: "refuter-a",
        role: "refuter",
        models: {
          default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
        },
      });
      const stepB = resolveStepRoute({
        stepKey: "refuter-b",
        role: "refuter",
        models: {
          default: [
            {
              model: "opencode:anthropic/claude-3-5-sonnet-20241022",
              effort: "default",
            },
          ],
        },
      });
      const plan = createResolvedRoutePlan([stepA, stepB]);

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        credentialBrokers: {
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

      const bindingA = runtime.bindings.get(stepA.routeFingerprint);
      const bindingB = runtime.bindings.get(stepB.routeFingerprint);
      expect(bindingA).toBeDefined();
      expect(bindingB).toBeDefined();
      if (bindingA === undefined || bindingB === undefined) return;

      const leaseA = await bindingA.acquire(ISOLATION_STUB, registry);
      const leaseB = await bindingB.acquire(ISOLATION_STUB, registry);

      expect(leaseA.transport).not.toBe(leaseB.transport);
      await leaseA.dispose();
      await leaseB.dispose();
    });
  });

  describe("binding lease lifecycle", () => {
    test("binding.acquire dispose releases the route-scoped lease so the next acquire is fresh", async () => {
      const disposeLog: string[] = [];
      let factoryCalls = 0;

      const registry: TransportRegistry = {
        register() {},
        has: () => true,
        get(_backend, options?: TransportFactoryOptions) {
          factoryCalls += 1;
          const key =
            typeof options?.routeFingerprint === "string"
              ? options.routeFingerprint
              : "backend-only";
          return {
            backend: "opencode" as const,
            capabilities: async () =>
              createRecordingTransport([], "opencode").capabilities(),
            execute: async () => ({
              completion: "success" as const,
              protocolIntegrity: "verified" as const,
              finalText: "{}",
              usage: {
                wallMs: 1,
                tokens: {},
                completeness: "complete" as const,
                billingMode: "subscription" as const,
                costSource: "provider" as const,
                cashCostUsd: 0,
              },
              stderrTail: "",
            }),
            classifyFailure: () => undefined,
            __leaseKey: key,
          } as ProviderTransport & { __leaseKey: string };
        },
        getCapabilityReport: async () =>
          createRecordingTransport([], "opencode").capabilities(),
        getAllCapabilityReports: async () => new Map(),
        release(routeFingerprint: string) {
          disposeLog.push(routeFingerprint);
        },
      } as TransportRegistry & {
        release(routeFingerprint: string): void;
      };

      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        models: {
          default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
        },
      });
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([step]),
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        credentialBrokers: {
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

      const binding = runtime.bindings.get(step.routeFingerprint);
      expect(binding).toBeDefined();
      if (binding === undefined) return;

      const lease1 = await binding.acquire(ISOLATION_STUB, registry);
      await lease1.dispose();
      const lease2 = await binding.acquire(ISOLATION_STUB, registry);

      expect(disposeLog).toEqual([step.routeFingerprint]);
      expect(lease2.transport).not.toBe(lease1.transport);
      expect(factoryCalls).toBe(2);
    });

    test("binding.acquire forwards openCodeBinaryPath to registry.get for opencode bindings", async () => {
      let capturedOptions: TransportFactoryOptions | undefined;

      const registry: TransportRegistry = {
        register() {},
        has: () => true,
        get(_backend, options?: TransportFactoryOptions) {
          capturedOptions = options;
          return {
            backend: "opencode" as const,
            capabilities: async () =>
              createRecordingTransport([], "opencode").capabilities(),
            execute: async () => ({
              completion: "success" as const,
              protocolIntegrity: "verified" as const,
              finalText: "{}",
              usage: {
                wallMs: 1,
                tokens: {},
                completeness: "complete" as const,
                billingMode: "subscription" as const,
                costSource: "provider" as const,
                cashCostUsd: 0,
              },
              stderrTail: "",
            }),
            classifyFailure: () => undefined,
          } as ProviderTransport;
        },
        getCapabilityReport: async () =>
          createRecordingTransport([], "opencode").capabilities(),
        getAllCapabilityReports: async () => new Map(),
      };

      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        models: {
          default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
        },
      });
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([step]),
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        credentialBrokers: {
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

      const binding = runtime.bindings.get(step.routeFingerprint);
      expect(binding).toBeDefined();
      if (binding === undefined) return;

      const lease = await binding.acquire(ISOLATION_STUB, registry);
      await lease.dispose();

      expect(capturedOptions?.openCodeBinaryPath).toBe(
        opencodeFixture.canonicalPath,
      );
      expect(capturedOptions?.observedOpenCodeIdentity?.sdkVersion).toBe(
        SUPPORTED_OPENCODE_SDK_VERSION,
      );
      expect(capturedOptions?.observedOpenCodeIdentity?.serverVersion).toBe(
        SUPPORTED_OPENCODE_SERVER_VERSION,
      );
    });
  });

  describe("exact OpenCode provider/model/variant requests", () => {
    test("built-in opencode factory must pass route provider/model into createOpenCodeClient", async () => {
      const promptModels: Array<{
        providerID: string;
        modelID: string;
      }> = [];
      const route: ResolvedModelRoute = {
        backend: "opencode",
        provider: "anthropic",
        modelFamily: "claude-3-5-sonnet",
        modelSnapshot: "claude-3-5-sonnet-20241022",
        modelVariant: "thinking",
      };

      const loadSdk = async (): Promise<OpenCodeSdkLike> => ({
        createOpencodeClient: () => ({
          // #122: the tool surface is READ from the provider, so a fake that
          // cannot report one cannot open a session at all. That is the point
          // — enumerating is the only way "denied" means anything.
          tool: {
            ids: async () => ({ data: ["read", "grep", "glob", "bash"] }),
          },
          // #141: the readback the client performs before prompting. This
          // request declares no mcp registry, so the verified answer is
          // "nothing connected".
          mcp: { status: async () => ({ data: {} }) },
          permission: { reply: async () => ({ data: true }) },
          session: {
            create: async (opts?: unknown) => ({
              data: {
                id: "oc-sess-1",
                directory:
                  (opts as { directory?: string } | undefined)?.directory ??
                  tmpDir,
              },
            }),
            prompt: async (options: {
              model?: { providerID: string; modelID: string };
              body?: { model: { providerID: string; modelID: string } };
            }) => {
              const model = options.model ?? options.body?.model;
              if (model) promptModels.push(model);
              return { data: {} };
            },
            messages: async () => ({ data: {} }),
            // #127: the poll observer's turn boundary, GET /session/status.
            // An empty map is a session opencode is not working on — it omits
            // an idle session rather than reporting {"type":"idle"}.
            status: async () => ({ data: {} }),
            abort: async () => ({ data: {} }),
          },
          event: {
            subscribe: async () => ({
              stream: (async function* () {
                yield undefined;
              })(),
            }),
          },
        }),
      });

      const client = createOpenCodeClient({
        model: { providerID: route.provider, modelID: route.modelSnapshot },
        loadSdk,
        readSystemPrompt: async () => "system prompt",
        launchServer: async () => ({
          url: "http://127.0.0.1:4096",
          pid: 4242,
          close: async () => {},
        }),
      });

      await client.createSession({
        cwd: tmpDir,
        userPrompt: "review",
        systemPromptPath: path.join(tmpDir, "system.md"),
        tools: ["Read"],
      });

      expect(promptModels).toEqual([
        {
          providerID: route.provider,
          modelID: route.modelSnapshot,
        },
      ]);
    });
  });

  // #141: the registry is where the client learns which codegraph binary
  // exists and where the launch closure learns there is a registry to carry.
  // The threaded-and-never-applied path this issue closes ran through exactly
  // this factory, so the wiring gets its own test rather than being trusted to
  // the type checker.
  describe("built-in opencode factory MCP wiring (#141)", () => {
    test("carries the run's registry into the launch, resolved to the configured binary", async () => {
      const launches: unknown[] = [];
      const mcpJson = path.join(tmpDir, "mcp.json");
      await Bun.write(
        mcpJson,
        JSON.stringify({
          mcpServers: {
            codegraph: {
              type: "stdio",
              command: "codegraph",
              args: ["serve", "--mcp"],
            },
          },
        }),
      );

      const loadSdk = async (): Promise<OpenCodeSdkLike> => ({
        createOpencodeClient: () => ({
          tool: { ids: async () => ({ data: ["read"] }) },
          mcp: {
            status: async () => ({
              data: { codegraph: { status: "connected" } },
            }),
          },
          permission: { reply: async () => ({ data: true }) },
          session: {
            create: async (opts?: unknown) => ({
              data: {
                id: "oc-sess-141",
                directory:
                  (opts as { directory?: string } | undefined)?.directory ??
                  tmpDir,
              },
            }),
            prompt: async () => ({
              data: {
                id: "msg_user_0",
                role: "user",
                sessionID: "oc-sess-141",
              },
            }),
            messages: async () => ({ data: {} }),
            status: async () => ({ data: {} }),
            abort: async () => ({ data: {} }),
          },
          event: {
            subscribe: async () => ({
              // Just enough of a real turn to settle: an assistant message
              // with a completion record, one text part, and the `session.idle`
              // boundary (#127).
              stream: (async function* () {
                const sessionID = "oc-sess-141";
                yield {
                  type: "message.updated",
                  properties: {
                    sessionID,
                    info: {
                      role: "assistant",
                      id: "msg_1",
                      parentID: "msg_user_0",
                      sessionID,
                      time: { completed: 1_700_000_000_000 },
                      finish: "stop",
                    },
                  },
                };
                yield {
                  type: "message.part.updated",
                  properties: {
                    sessionID,
                    part: { id: "prt_1", messageID: "msg_1", type: "text" },
                  },
                };
                yield {
                  type: "message.part.delta",
                  properties: {
                    sessionID,
                    partID: "prt_1",
                    field: "text",
                    delta: "{}",
                  },
                };
                yield { type: "session.idle", properties: { sessionID } };
              })(),
            }),
          },
        }),
      });

      const registry = new DefaultTransportRegistry({
        mode: "conformance",
        sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION,
        serverVersion: SUPPORTED_OPENCODE_SERVER_VERSION,
        loadSdk,
        codegraphBinaryPath: "/opt/homebrew/bin/codegraph",
        launchServer: async (mcp?: unknown) => {
          launches.push(mcp);
          return {
            url: "http://127.0.0.1:4096",
            pid: 4242,
            close: async () => {},
          };
        },
      });
      const transport = registry.get("opencode");
      const sink: AsyncEventSink = {
        push: async () => "accepted" as const,
        close: async () => {},
      };
      const controller = new AbortController();

      await transport.execute(
        {
          sessionId: "oc-141",
          attempt: 1,
          route: {
            backend: "opencode",
            provider: "anthropic",
            modelFamily: "claude",
            modelSnapshot: "claude-test",
          },
          executionModel: "claude-test",
          effort: "high",
          systemPromptPath: path.join(tmpDir, "system.md"),
          systemPromptSha256: "deadbeef",
          userPrompt: "review",
          cwd: tmpDir,
          tools: ["Read", "mcp__codegraph__codegraph_explore"],
          mcpConfigPath: mcpJson,
          isolation: ISOLATION_STUB,
        },
        { signal: controller.signal, events: sink },
      );

      expect(launches).toEqual([
        {
          codegraph: {
            type: "local",
            command: [
              "/opt/homebrew/bin/codegraph",
              "serve",
              "--mcp",
              "-p",
              tmpDir,
            ],
            enabled: true,
          },
        },
      ]);
    });
  });

  describe("binding tool and MCP admission", () => {
    async function createClaudeRuntime(requests: TransportRequest[]) {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const registry = new DefaultTransportRegistry();
      registry.register(
        "claude-code",
        createRecordingTransport(requests, "claude-code"),
      );
      return {
        step,
        runtime: await createProductionRuntime({
          workspaceRoot: tmpDir,
          plan: createResolvedRoutePlan([step]),
          binaryPath: claudeFixture.canonicalPath,
          executableAllowlists: {
            "claude-code": [
              {
                absolutePath: claudeFixture.canonicalPath,
                sha256: claudeFixture.sha256,
              },
            ],
          },
          registry,
          mode: "conformance",
        }),
      };
    }

    test("denies bash before transport execute with zero attempts", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          tools: ["Read", "bash"],
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/bash|allow.?map|tool/i);
    });

    test("denies Write/Edit/Task before transport execute", async () => {
      for (const denied of ["Write", "Edit", "Task"] as const) {
        const requests: TransportRequest[] = [];
        const { step, runtime } = await createClaudeRuntime(requests);

        const result = await runtime.runner.run(
          makeStep(tmpDir, {
            tools: ["Read", denied],
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        );

        expect(result.status).toBe("failed");
        expect(result.attempts).toBe(0);
        expect(requests).toHaveLength(0);
        expect(result.stderrTail).toMatch(
          new RegExp(`${denied}|allow.?map|tool`, "i"),
        );
      }
    });

    test("denies unknown tools outside the allow map before transport execute", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          tools: ["Read", "WebSearch"],
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/WebSearch|allow.?map|tool/i);
    });

    test("denies non-codegraph MCP tool prefixes before transport execute", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          tools: ["Read", "mcp__playwright__browser_navigate"],
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/codegraph|mcp/i);
    });

    test("denies mcp.json that registers a non-codegraph server", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);
      const badMcpPath = path.join(tmpDir, "bad-mcp.json");
      await writeFile(
        badMcpPath,
        JSON.stringify({
          mcpServers: {
            playwright: { command: "npx", args: ["playwright", "mcp"] },
          },
        }),
      );

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          mcpConfigPath: badMcpPath,
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/codegraph|mcp/i);
    });

    test("denies symlinked mcp.json before transport execute", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);
      const outsideDir = await mkdtemp(path.join(tmpdir(), "pr-hero-mcp-out-"));
      const outsideMcp = path.join(outsideDir, "outside-mcp.json");
      await writeFile(
        outsideMcp,
        JSON.stringify({
          mcpServers: {
            codegraph: { command: "codegraph", args: ["mcp"] },
          },
        }),
      );
      const linkPath = path.join(tmpDir, "linked-mcp.json");
      await symlink(outsideMcp, linkPath);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          mcpConfigPath: linkPath,
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/symlink|mcp/i);

      await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    });

    test("denies mcp.json content hash mismatch before transport execute", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);
      const mcpPath = path.join(tmpDir, "pinned-mcp.json");
      const content = JSON.stringify({
        mcpServers: {
          codegraph: { command: "codegraph", args: ["mcp"] },
        },
      });
      await writeFile(mcpPath, content);

      const result = await runtime.runner.run({
        ...makeStep(tmpDir, {
          mcpConfigPath: mcpPath,
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
        mcpConfigSha256: sha256Hex("stale-content"),
      } as StepSpec & { mcpConfigSha256: string });

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/hash|mcp/i);
    });
  });

  describe("pre-confirm authority gates", () => {
    test("missing SDK blocks opencode step before transport execute and spend reservation", async () => {
      const requests: TransportRequest[] = [];
      const ledger = new InMemorySpendLedger();
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        models: {
          default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
        },
      });

      const registry = new DefaultTransportRegistry({
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        binaryPath: opencodeFixture.canonicalPath,
        readSystemPrompt: async () => "system",
        launchServer: async () => ({
          url: "http://127.0.0.1:4096",
          pid: 1,
          close: async () => {},
        }),
        loadSdk: async () => {
          throw new Error("Cannot find module '@opencode-ai/sdk'");
        },
      });

      const harness = new StepExecutionHarness({
        workspaceRoot: tmpDir,
        registry,
        executableAllowlist: [
          {
            absolutePath: opencodeFixture.canonicalPath,
            sha256: opencodeFixture.sha256,
          },
        ],
        binaryPath: opencodeFixture.canonicalPath,
        spendLedger: ledger,
        reservedUsdPerAttempt: 0.01,
        spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
      });

      const result = await harness.run(
        makeStep(tmpDir, {
          model: "openai/gpt-4o",
          route: step.route,
          routeKey: step.routeFingerprint,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.reservations ?? []).toHaveLength(0);
      expect(result.stderrTail).toMatch(/sdk|@opencode-ai/i);
    });

    test("unverified opencode binary blocks before transport execute and spend reservation", async () => {
      const requests: TransportRequest[] = [];
      const ledger = new InMemorySpendLedger();
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        models: {
          default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
        },
      });

      const registry = new DefaultTransportRegistry();
      registry.register(
        "opencode",
        createRecordingTransport(requests, "opencode"),
      );

      const harness = new StepExecutionHarness({
        workspaceRoot: tmpDir,
        registry,
        executableAllowlist: [
          {
            absolutePath: opencodeFixture.canonicalPath,
            sha256: "0".repeat(64),
          },
        ],
        binaryPath: opencodeFixture.canonicalPath,
        spendLedger: ledger,
        reservedUsdPerAttempt: 0.01,
        spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
      });

      const result = await harness.run(
        makeStep(tmpDir, {
          model: "openai/gpt-4o",
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.reservations ?? []).toHaveLength(0);
      expect(result.denialCode).toBe("executable_not_approved");
    });

    test("declared constants cannot bypass unobserved versions: unversioned or unsupported binary denies binding acquisition", async () => {
      const unsuppDir = await mkdtemp(path.join(tmpDir, "unsupp-opencode-"));
      const unsupportedFixture = await writeOpenCodeFixture(
        unsuppDir,
        "1.18.99",
      );
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        models: {
          default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
        },
      });
      const registry = createDefaultTransportRegistry({
        mode: "conformance",
        openCodeClient: {
          createSession: async () => ({}) as never,
        } as never,
      });

      await expect(
        createProductionRuntime({
          workspaceRoot: tmpDir,
          plan: createResolvedRoutePlan([step]),
          binaryPath: claudeFixture.canonicalPath,
          openCodeBinaryPath: unsupportedFixture.canonicalPath,
          executableAllowlists: mixedAllowlists(
            claudeFixture,
            unsupportedFixture,
          ),
          registry,
          mode: "conformance",
          evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
          credentialBrokers: {
            opencode: new OpenCodeAuthBroker({
              readerFn: async () =>
                JSON.stringify({
                  openai: { type: "oauth", access: "test", refresh: "test" },
                }),
            }),
          },
        }),
      ).rejects.toThrow(/Unsupported observed OpenCode pair/);
    });
  });

  describe("binding drift and harness-owned opencode timeout", () => {
    test("route drift under a frozen routeKey forces re-probe before transport execute", async () => {
      const requests: TransportRequest[] = [];
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        models: {
          default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
        },
      });
      const registry = new DefaultTransportRegistry();
      registry.register(
        "opencode",
        createRecordingTransport(requests, "opencode"),
      );

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([step]),
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        credentialBrokers: {
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

      const driftedRoute: ResolvedModelRoute = {
        ...step.route,
        modelVariant: "drifted-variant",
      };

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          model: "openai/gpt-4o",
          routeKey: step.routeFingerprint,
          route: driftedRoute,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/drift|re-probe|fingerprint/i);
    });

    test("harness enforces opencode step timeout without passing timeoutMs to transport", async () => {
      const captured: TransportRequest[] = [];
      const hangingTransport: ProviderTransport = {
        backend: "opencode",
        admissionIdentity: { executable: "opencode", provider: "opencode" },
        cancellationSemantics: "provider-proof",
        capabilities: async () => {
          const base = await createRecordingTransport(
            [],
            "opencode",
          ).capabilities();
          return {
            ...base,
            cancellation: { deadlineMs: 5, conformance: "passed" },
          };
        },
        execute: async (request) => {
          captured.push(request);
          await new Promise<never>(() => {});
          return {
            completion: "success",
            protocolIntegrity: "verified",
            finalText: "{}",
            usage: {
              wallMs: 0,
              tokens: {},
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

      const registry = new DefaultTransportRegistry();
      registry.register("opencode", hangingTransport);

      const harness = new StepExecutionHarness({
        registry,
        spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
        graceMarginMs: 0,
      });

      const runPromise = harness.run(
        makeStep(tmpDir, {
          timeoutMs: 40,
          route: {
            backend: "opencode",
            provider: "openai",
            modelFamily: "gpt-4o",
            modelSnapshot: "gpt-4o",
          },
        }),
      );

      const result = await Promise.race([
        runPromise,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("harness did not enforce step timeout")),
            500,
          );
        }),
      ]);

      expect(result.status).toBe("failed");
      expect(captured).toHaveLength(1);
      expect(captured[0]).not.toHaveProperty("timeoutMs");
      expect(result.stderrTail).toMatch(/timeout|timed out/i);
    });
  });

  describe("Task 2.3 RED: unknown-outcome fencing, settlement, and ordered disposal", () => {
    async function createClaudeProductionRuntime(
      requests: TransportRequest[],
      options: { signal?: AbortSignal } = {},
    ) {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const baseRegistry = new DefaultTransportRegistry();
      baseRegistry.register(
        "claude-code",
        createRecordingTransport(requests, "claude-code"),
      );
      const { registry, releases } =
        wrapRegistryWithReleaseTracking(baseRegistry);
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([step]),
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: {
          "claude-code": [
            {
              absolutePath: claudeFixture.canonicalPath,
              sha256: claudeFixture.sha256,
            },
          ],
        },
        registry,
        mode: "conformance",
        // The claude step must not fall through to the host's Keychain.
        credentialBrokers: { "claude-code": successfulClaudeCredentialBroker },
        signal: options.signal,
      });
      return { step, runtime, releases };
    }

    test("production runner acquires binding transport lease per step and disposes after settlement", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime, releases } =
        await createClaudeProductionRuntime(requests);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("ok");
      expect(releases).toEqual([step.routeFingerprint]);
    });

    test("unconfirmed opencode abort through production runner fences the binding credential bucket", async () => {
      const limiter = new ConcurrencyLimiter({ bucketCeiling: 5 });
      const gate = new ConcurrencyAttemptAdmissionGate(limiter);

      const controller = new AbortController();
      let transportCalls = 0;
      const hangingTransport: ProviderTransport = {
        backend: "opencode",
        admissionIdentity: { executable: "opencode", provider: "opencode" },
        cancellationSemantics: "provider-proof",
        capabilities: async () => {
          const base = await createRecordingTransport(
            [],
            "opencode",
          ).capabilities();
          return {
            ...base,
            cancellation: { deadlineMs: 5, conformance: "passed" },
          };
        },
        execute: async () => {
          transportCalls += 1;
          if (transportCalls === 1) {
            await new Promise<never>(() => {});
          }
          return {
            completion: "success",
            protocolIntegrity: "verified",
            finalText: '{"findings":[]}',
            usage: {
              wallMs: 1,
              tokens: {},
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

      const baseRegistry = new DefaultTransportRegistry();
      baseRegistry.register("opencode", hangingTransport);
      const sharedRuntimeOptions = {
        workspaceRoot: tmpDir,
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        mode: "conformance" as const,
        evidence: new Map<RunnerBackend, D1_11ReadinessEvidence>([
          ["opencode", COMPLETE_EVIDENCE],
        ]),
        attemptAdmissionGate: gate,
        graceMarginMs: 5,
        credentialBrokers: {
          opencode: new OpenCodeAuthBroker({
            readerFn: async () =>
              JSON.stringify({
                openai: { type: "oauth", access: "test", refresh: "test" },
              }),
          }),
        },
        authorityDeps: {
          existsFn: (p: string) =>
            p === claudeFixture.canonicalPath ||
            p === opencodeFixture.canonicalPath ||
            p.startsWith(tmpDir),
          realpathFn: async (p: string) => p,
        },
      };

      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        models: {
          default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
        },
      });
      const plan = createResolvedRoutePlan([step]);

      const runtimeA = await createProductionRuntime({
        ...sharedRuntimeOptions,
        plan,
        registry: baseRegistry,
        signal: controller.signal,
      });

      const binding = runtimeA.bindings.get(step.routeFingerprint);
      expect(binding?.credential.bucketId).toBeDefined();

      const runPromise = runtimeA.runner.run(
        makeStep(tmpDir, {
          name: "hunter-a",
          model: "openai/gpt-4o",
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );
      while (transportCalls === 0) {
        await sleep(2);
      }
      controller.abort();
      const resultA = await runPromise;
      expect(resultA.status).toBe("failed");
      await sleep(50);

      const runtimeB = await createProductionRuntime({
        ...sharedRuntimeOptions,
        plan,
        registry: baseRegistry,
      });

      const resultB = await runtimeB.runner.run(
        makeStep(tmpDir, {
          name: "hunter-b",
          model: "openai/gpt-4o",
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(resultB.status).toBe("failed");
      expect(transportCalls).toBe(1);
    });

    test("runtime.dispose releases all active binding transport leases", async () => {
      const baseRegistry = new DefaultTransportRegistry();
      baseRegistry.register(
        "claude-code",
        createRecordingTransport([], "claude-code"),
      );
      baseRegistry.register(
        "opencode",
        createRecordingTransport([], "opencode"),
      );

      const stepClaude = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const stepOpenCode = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        models: {
          default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
        },
      });
      const { registry, releases } =
        wrapRegistryWithReleaseTracking(baseRegistry);

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([stepClaude, stepOpenCode]),
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        credentialBrokers: {
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

      const claudeBinding = runtime.bindings.get(stepClaude.routeFingerprint);
      const openCodeBinding = runtime.bindings.get(
        stepOpenCode.routeFingerprint,
      );
      expect(claudeBinding).toBeDefined();
      expect(openCodeBinding).toBeDefined();
      if (claudeBinding === undefined || openCodeBinding === undefined) return;

      await claudeBinding.acquire(ISOLATION_STUB, registry);
      await openCodeBinding.acquire(ISOLATION_STUB, registry);
      expect(releases).toHaveLength(0);

      await runtime.dispose();

      expect(releases.sort()).toEqual(
        [stepClaude.routeFingerprint, stepOpenCode.routeFingerprint].sort(),
      );
    });

    // #150: this test used to be named "...before credential projection
    // destroy" and asserted a FOURTH teardown step, "projection-destroy",
    // after "server-close" — proving the harness materialized and destroyed
    // a per-step credential projection for every OpenCode attempt. That
    // projection had no consumer: `OpenCodeSdkTransport.execute` never read
    // `request.isolation` (the server's own #149 projection is what
    // actually protects it), so the harness now skips the per-step broker
    // call entirely for a transport declaring `credentialProjection:
    // "server-lifetime"`. The corrected expectation is the same three
    // stream/client/server steps with NO fourth step, because no per-step
    // projection was ever created to destroy.
    test("opencode step teardown disposes stream then client then server, with no per-step credential projection to destroy", async () => {
      const teardownOrder: string[] = [];
      const mockClient: OpenCodeClientLike & { close(): Promise<void> } = {
        createSession: async () => ({ id: "sess-1" }),
        streamEvents: () => ({
          [Symbol.asyncIterator]() {
            const inner = (async function* () {
              yield {
                kind: "terminal" as const,
                proof: terminalProof("e1"),
              };
            })();
            return {
              next: () => inner.next(),
              return: async () => {
                teardownOrder.push("stream-disposed");
                const result = await inner.return?.();
                return result ?? { done: true as const, value: undefined };
              },
            };
          },
        }),
        pollStatus: async () => ({ kind: "pending" }),
        abort: async () => {},
        close: async () => {
          teardownOrder.push("client-close");
          teardownOrder.push("server-close");
        },
      };

      const broker = new DestroyOrderBroker(
        new OpenCodeAuthBroker({
          readerFn: async () =>
            JSON.stringify({
              openai: { type: "oauth", access: "test", refresh: "test" },
            }),
        }),
        teardownOrder,
      );

      const registry = new DefaultTransportRegistry({
        mode: "conformance",
        sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION,
        serverVersion: SUPPORTED_OPENCODE_SERVER_VERSION,
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        binaryPath: opencodeFixture.canonicalPath,
        openCodeClient: mockClient,
      });

      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        models: {
          default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
        },
      });

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([step]),
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        credentialBrokers: { opencode: broker },
        authorityDeps: {
          existsFn: (p) =>
            p === claudeFixture.canonicalPath ||
            p === opencodeFixture.canonicalPath ||
            p.startsWith(tmpDir),
          realpathFn: async (p) => p,
        },
      });

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          model: "openai/gpt-4o",
          route: step.route,
          routeKey: step.routeFingerprint,
          parse: (text) => (text === "" ? {} : JSON.parse(text)),
        }),
      );

      expect(result.status).toBe("ok");
      expect(teardownOrder).toEqual([
        "stream-disposed",
        "client-close",
        "server-close",
      ]);
      // #150: the broker's project() was never called for this step at all
      // — not merely "called and its destroy landed last".
      expect(broker.projectCalls).toBe(0);
    });

    test("transient retry through production runner persists one settlement receipt per attempt", async () => {
      let calls = 0;
      const scriptedTransport: ProviderTransport = {
        backend: "claude-code",
        capabilities: async () =>
          createRecordingTransport([], "claude-code").capabilities(),
        execute: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              completion: "failed",
              protocolIntegrity: "unverified",
              finalText: "not json",
              usage: {
                wallMs: 1,
                tokens: {},
                completeness: "complete",
                billingMode: "subscription",
                costSource: "provider",
                cashCostUsd: 0,
              },
              stderrTail: "ECONNRESET",
            };
          }
          return {
            completion: "success",
            protocolIntegrity: "verified",
            finalText: '{"findings":[]}',
            usage: {
              wallMs: 1,
              tokens: {},
              completeness: "complete",
              billingMode: "subscription",
              costSource: "provider",
              cashCostUsd: 0,
            },
            stderrTail: "",
          };
        },
        classifyFailure: (outcome) =>
          outcome.completion === "failed" ? "network_transient" : undefined,
      };

      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const baseRegistry = new DefaultTransportRegistry();
      baseRegistry.register("claude-code", scriptedTransport);
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([step]),
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: {
          "claude-code": [
            {
              absolutePath: claudeFixture.canonicalPath,
              sha256: claudeFixture.sha256,
            },
          ],
        },
        registry: baseRegistry,
        mode: "conformance",
        // The claude step must not fall through to the host's Keychain.
        credentialBrokers: { "claude-code": successfulClaudeCredentialBroker },
      });

      const outPath = path.join(tmpDir, "hunter-reliability.json");
      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          outPath,
          maxAttempts: 2,
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("ok");
      expect(calls).toBe(2);

      const attempt1Path = settlementReceiptPath(
        outPath,
        "hunter-reliability",
        1,
      );
      const attempt2Path = settlementReceiptPath(
        outPath,
        "hunter-reliability",
        2,
      );
      expect(existsSync(attempt1Path)).toBe(true);
      expect(existsSync(attempt2Path)).toBe(true);

      const receipt1 = JSON.parse(
        await readFile(attempt1Path, "utf8"),
      ) as SettlementReceipt;
      const receipt2 = JSON.parse(
        await readFile(attempt2Path, "utf8"),
      ) as SettlementReceipt;
      expect(receipt1.outcome).not.toBe(receipt2.outcome);
      expect(receipt2.outcome).toBe("completed");
    });

    test("claude step does not pass timeoutMs on TransportRequest", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeProductionRuntime(requests);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          timeoutMs: 40,
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("ok");
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("timeoutMs");
    });
  });
});

describe("Task 3.1 RED U3 BE1a/b: terminal arbitration, stalled observation, and bounded settlement", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-u3-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createStubClient(overrides: {
    stream?: AsyncIterable<OpenCodeClientEvent>;
    pollStatus?: () => Promise<OpenCodePollResult>;
    abort?: () => Promise<void>;
    close?: () => Promise<void>;
  }): OpenCodeClientLike {
    return {
      createSession: async () => ({ id: "oc-sess-test" }),
      streamEvents: () => overrides.stream ?? (async function* () {})(),
      pollStatus: overrides.pollStatus ?? (async () => ({ kind: "pending" })),
      abort: overrides.abort ?? (async () => {}),
      close: overrides.close ?? (async () => {}),
    };
  }

  function createStubRequest(dir: string): TransportRequest {
    return {
      sessionId: "test-session-u3",
      attempt: 1,
      route: {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
      },
      executionModel: "gpt-4o",
      effort: "high",
      systemPromptPath: path.join(dir, "system.md"),
      systemPromptSha256: "deadbeef",
      userPrompt: "review this code",
      cwd: dir,
      tools: ["Read"],
      isolation: ISOLATION_STUB,
    };
  }

  function createStubSink(): AsyncEventSink & { events: ProviderEvent[] } {
    const events: ProviderEvent[] = [];
    return {
      events,
      push: async (event) => {
        events.push(event);
        return "accepted";
      },
      close: () => {},
    };
  }

  // --- BE1a: Completion race ---
  test("BE1a completion race: cancellation admitted before settlement fences success even with completed terminal proof", async () => {
    const proof: ProviderTerminalProof = {
      eventId: "evt-proof-1",
      providerStatus: "completed",
      providerObservedAt: new Date().toISOString(),
    };

    async function* stream(): AsyncIterable<OpenCodeClientEvent> {
      yield { kind: "delta", text: "result text" };
      yield { kind: "terminal", proof };
    }

    const client = createStubClient({ stream: stream() });
    const transport = new OpenCodeSdkTransport({
      client,
      cleanupMs: 50,
      abortConfirmMs: 50,
    });

    const sink = createStubSink();
    const controller = new AbortController();
    const executePromise = transport.execute(createStubRequest(tmpDir), {
      signal: controller.signal,
      events: sink,
    });

    // Wait for stream to emit terminal candidate into the slot (drain window starts)
    await sleep(10);
    // Admit cancellation before the drain window settles
    controller.abort();

    const outcome = await executePromise;

    // Cancellation admitted before settlement fences success
    expect(outcome.completion).toBe("cancelled");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.terminalProof?.eventId).toBe("evt-proof-1");
    expect(outcome.finalText).toBe("result text");
  });

  test("BE1a completion race: settled outcome is immutable against late conflict or late stream error", async () => {
    const winnerProof: ProviderTerminalProof = {
      eventId: "evt-winner",
      providerStatus: "completed",
      providerObservedAt: new Date().toISOString(),
    };
    const conflictingProof: ProviderTerminalProof = {
      eventId: "evt-conflict",
      providerStatus: "failed",
      providerObservedAt: new Date().toISOString(),
    };

    let pollCount = 0;
    let emitLateError: (() => void) | undefined;
    async function* stream(): AsyncIterable<OpenCodeClientEvent> {
      yield { kind: "delta", text: "done" };
      yield { kind: "terminal", proof: winnerProof };
      await new Promise<void>((resolve) => {
        emitLateError = resolve;
      });
      throw new Error("late stream disconnect");
    }

    const client = createStubClient({
      stream: stream(),
      pollStatus: async () => {
        pollCount += 1;
        if (pollCount > 3) {
          return { kind: "terminal", proof: conflictingProof };
        }
        return { kind: "pending" };
      },
    });

    const transport = new OpenCodeSdkTransport({
      client,
      cleanupMs: 10,
      pollIntervalMs: 5,
    });

    const sink = createStubSink();
    const outcome = await transport.execute(createStubRequest(tmpDir), {
      signal: new AbortController().signal,
      events: sink,
    });

    // Settled as success
    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.terminalProof?.eventId).toBe("evt-winner");

    // Trigger late error and poll conflict after settlement
    emitLateError?.();
    await sleep(20);

    // Outcome must remain immutable and not overwritten
    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
  });

  test("BE1a completion race: late terminal proof after abort_unconfirmed settlement does not overwrite outcome", async () => {
    let lateProofReady = false;
    const lateProof: ProviderTerminalProof = {
      eventId: "evt-late",
      providerStatus: "completed",
      providerObservedAt: new Date().toISOString(),
    };

    const client = createStubClient({
      stream: (async function* () {
        await sleep(100);
        yield { kind: "terminal", proof: lateProof };
      })(),
      pollStatus: async () => {
        if (lateProofReady) {
          return { kind: "terminal", proof: lateProof };
        }
        return { kind: "pending" };
      },
    });

    const transport = new OpenCodeSdkTransport({
      client,
      abortConfirmMs: 15,
      cleanupMs: 10,
    });

    const controller = new AbortController();
    const executePromise = transport.execute(createStubRequest(tmpDir), {
      signal: controller.signal,
      events: createStubSink(),
    });

    await sleep(5);
    controller.abort();

    const outcome = await executePromise;

    // Unconfirmed abort settles
    expect(outcome.completion).toBe("cancelled");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.terminalProof).toBeUndefined();

    // Late proof arrives after settlement
    lateProofReady = true;
    await sleep(20);

    // Outcome must remain unchanged
    expect(outcome.completion).toBe("cancelled");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.terminalProof).toBeUndefined();
  });

  // --- BE1b: Stalled observation ---
  test("BE1b stalled observation: repeated heartbeats do not extend deadline and trip quiet bound as protocol_truncation", async () => {
    let heartbeatCount = 0;
    async function* heartbeatStream(): AsyncIterable<OpenCodeClientEvent> {
      for (;;) {
        await sleep(2);
        heartbeatCount += 1;
        yield { kind: "heartbeat" };
      }
    }

    const client = createStubClient({
      stream: heartbeatStream(),
      pollStatus: async () => ({ kind: "pending" }),
    });

    const transport = new OpenCodeSdkTransport({
      client,
      pollIntervalMs: 5,
      pollRoundMs: 5,
      maxQuietRounds: 3,
    });

    const sink = createStubSink();
    const outcome = await transport.execute(createStubRequest(tmpDir), {
      signal: new AbortController().signal,
      events: sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("truncated");
    expect(outcome.stderrTail).toContain("quiet-round budget");
    expect(transport.classifyFailure(outcome)).toBe("protocol_truncation");
    expect(heartbeatCount).toBeGreaterThan(0);
  });

  test("BE1b stalled observation: hung poll requests time out boundedly and trip quiet bound", async () => {
    const client = createStubClient({
      stream: (async function* () {})(),
      pollStatus: async () => {
        // Hung request: never resolves
        await new Promise<never>(() => {});
        return { kind: "pending" };
      },
    });

    const transport = new OpenCodeSdkTransport({
      client,
      pollRoundMs: 10,
      pollIntervalMs: 5,
      maxQuietRounds: 3,
    });

    const startTime = Date.now();
    const outcome = await transport.execute(createStubRequest(tmpDir), {
      signal: new AbortController().signal,
      events: createStubSink(),
    });
    const elapsedMs = Date.now() - startTime;

    expect(elapsedMs).toBeLessThan(500);
    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("truncated");
    expect(outcome.stderrTail).toContain("quiet-round budget");
    expect(transport.classifyFailure(outcome)).toBe("protocol_truncation");
  });

  test("BE1b bounded cleanup: hung client.abort is capped by cleanup budget during teardown", async () => {
    let abortCalled = false;
    const client = createStubClient({
      stream: {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw new Error("stream failure");
            },
          };
        },
      },
      abort: async () => {
        abortCalled = true;
        // Hung abort: never resolves
        await new Promise<never>(() => {});
      },
    });

    const transport = new OpenCodeSdkTransport({
      client,
      cleanupMs: 20,
    });

    const startTime = Date.now();
    const outcome = await transport.execute(createStubRequest(tmpDir), {
      signal: new AbortController().signal,
      events: createStubSink(),
    });
    const elapsedMs = Date.now() - startTime;

    expect(abortCalled).toBe(true);
    expect(elapsedMs).toBeLessThan(400);
    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
  });
});

describe("Task 5.1 RED U5 BE3a/b: generic facts, isolation safeguards, and concurrent parity", () => {
  let tmpDir: string;
  let claudeFixture: { canonicalPath: string; sha256: string };
  let opencodeFixture: { canonicalPath: string; sha256: string };

  beforeEach(async () => {
    tmpDir = await mkdtemp(
      path.join(tmpdir(), "pr-hero-u5-generic-isolation-"),
    );
    claudeFixture = await writeClaudeFixture(tmpDir);
    opencodeFixture = await writeOpenCodeFixture(tmpDir);
    await writeFile(path.join(tmpDir, "system.md"), "system prompt content");
    await writeFile(
      path.join(tmpDir, "mcp.json"),
      JSON.stringify({ mcpServers: { codegraph: { command: "codegraph" } } }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- CWD and Path resolution ---
  test("git -C, relative paths, and absolute paths each resolve authorized canonical cwd; mismatch denies", async () => {
    const broker = new WorkspaceReadBroker({ workspaceRoot: tmpDir });
    const subDir = path.join(tmpDir, "packages", "core");
    await mkdir(subDir, { recursive: true });
    const canonicalSub = await realpath(subDir);

    // 1. Relative path resolution
    const relAuth = broker.authorizePath(path.join("packages", "core"));
    expect(relAuth.approved).toBe(true);
    if (relAuth.approved) {
      expect(relAuth.canonicalPath).toBe(canonicalSub);
    }

    // 2. Absolute path resolution
    const absAuth = broker.authorizePath(subDir);
    expect(absAuth.approved).toBe(true);
    if (absAuth.approved) {
      expect(absAuth.canonicalPath).toBe(canonicalSub);
    }

    // 3. git -C resolution
    const gitAuth = broker.authorizeGitArgs(["-C", "packages/core", "status"]);
    expect(gitAuth.approved).toBe(true);
    if (gitAuth.approved) {
      expect(gitAuth.canonicalPath).toBe(canonicalSub);
    }

    // 4. Mismatch / escape path denial
    const escapeAuth = broker.authorizePath(path.join(tmpDir, "..", "outside"));
    expect(escapeAuth.approved).toBe(false);
    expect(escapeAuth.code).toBe("path_not_approved");

    // 5. git -C escape denial
    const gitEscapeAuth = broker.authorizeGitArgs([
      "-C",
      "../outside",
      "status",
    ]);
    expect(gitEscapeAuth.approved).toBe(false);
    expect(gitEscapeAuth.code).toBe("path_not_approved");

    // 6. Symlink escape denial through harness
    const outsideDir = await mkdtemp(path.join(tmpdir(), "outside-sandbox-"));
    const symlinkEscape = path.join(tmpDir, "escaped_link");
    await symlink(outsideDir, symlinkEscape);
    try {
      const harness = new StepExecutionHarness({
        transport: createRecordingTransport([], "claude-code"),
        workspaceRoot: tmpDir,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlist: [
          {
            absolutePath: claudeFixture.canonicalPath,
            sha256: claudeFixture.sha256,
          },
        ],
      });
      const res = await harness.run(
        makeStep(tmpDir, {
          cwd: symlinkEscape,
        }),
      );
      expect(res.status).toBe("failed");
      expect(res.denialCode).toBe("path_not_approved");
      expect(res.stderrTail).toMatch(/escapes workspace root/i);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("every SDK operation receives and verifies authorized canonical cwd", async () => {
    const subDir = path.join(tmpDir, "subproject");
    await mkdir(subDir, { recursive: true });
    const canonicalSub = await realpath(subDir);

    let recordedCwdOnCreate: string | undefined;
    const client: OpenCodeClientLike = {
      createSession: async (input) => {
        recordedCwdOnCreate = input.cwd;
        return { id: "sess-cwd-1" };
      },
      // #214: this step's `tools:` list is non-empty (`makeStep`'s default),
      // so an empty `findings` draft with zero observed tool invocations
      // reads as a hunt that never looked (`isVacuousHunt`) and the
      // harness now refuses it — a `{kind:"tool"}` event is enough to prove
      // this mocked session looked, without this cwd-plumbing test needing
      // to care about findings content.
      streamEvents: () =>
        (async function* () {
          yield { kind: "tool", tool: "read" };
          yield { kind: "delta", text: '{"findings":[]}' };
        })(),
      pollStatus: async () => ({
        kind: "terminal",
        proof: {
          eventId: "evt-cwd-1",
          providerStatus: "completed",
          providerObservedAt: new Date().toISOString(),
        },
      }),
      abort: async () => {},
      close: async () => {},
    };

    const transport = new OpenCodeSdkTransport({
      client,
      pollIntervalMs: 5,
      pollRoundMs: 10,
    });

    const harness = new StepExecutionHarness({
      transport,
      workspaceRoot: tmpDir,
      binaryPath: opencodeFixture.canonicalPath,
      executableAllowlist: [
        {
          absolutePath: opencodeFixture.canonicalPath,
          sha256: opencodeFixture.sha256,
        },
      ],
    });

    const result = await harness.run(
      makeStep(tmpDir, {
        cwd: subDir,
        route: {
          backend: "opencode",
          provider: "opencode",
          modelFamily: "opencode",
          modelSnapshot: "gpt-4o",
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(recordedCwdOnCreate).toBe(canonicalSub);
  });

  // --- BE3a: Concurrent parity & sibling survival ---
  test("BE3a concurrent parity: Claude outcomes remain unchanged while concurrent OpenCode session runs", async () => {
    const claudeRequests: TransportRequest[] = [];
    const claudeTransport = createRecordingTransport(
      claudeRequests,
      "claude-code",
    );

    let opencodeDone = false;
    const opencodeClient: OpenCodeClientLike = {
      createSession: async () => ({ id: "sess-oc-parity" }),
      // #214: see the WHY comment on the cwd test above — this step's tools
      // list is non-empty, so the mocked session needs a `{kind:"tool"}`
      // event to avoid the vacuous-hunt gate over its empty findings draft.
      streamEvents: () =>
        (async function* () {
          yield { kind: "tool", tool: "read" };
          yield { kind: "delta", text: '{"findings":[]}' };
        })(),
      pollStatus: async () => {
        opencodeDone = true;
        return {
          kind: "terminal",
          proof: {
            eventId: "proof-oc",
            providerStatus: "completed",
            providerObservedAt: new Date().toISOString(),
          },
        };
      },
      abort: async () => {},
      close: async () => {},
    };

    const opencodeTransport = new OpenCodeSdkTransport({
      client: opencodeClient,
      pollIntervalMs: 5,
      pollRoundMs: 10,
    });

    const claudeHarness = new StepExecutionHarness({
      transport: claudeTransport,
      workspaceRoot: tmpDir,
      binaryPath: claudeFixture.canonicalPath,
      executableAllowlist: [
        {
          absolutePath: claudeFixture.canonicalPath,
          sha256: claudeFixture.sha256,
        },
      ],
    });

    const opencodeHarness = new StepExecutionHarness({
      transport: opencodeTransport,
      workspaceRoot: tmpDir,
      binaryPath: opencodeFixture.canonicalPath,
      executableAllowlist: [
        {
          absolutePath: opencodeFixture.canonicalPath,
          sha256: opencodeFixture.sha256,
        },
      ],
    });

    const [claudeResult, opencodeResult] = await Promise.all([
      claudeHarness.run(
        makeStep(tmpDir, {
          name: "claude-parity-step",
          route: {
            backend: "claude-code",
            provider: "anthropic",
            modelFamily: "claude",
            modelSnapshot: "sonnet",
          },
        }),
      ),
      opencodeHarness.run(
        makeStep(tmpDir, {
          name: "opencode-concurrent-step",
          route: {
            backend: "opencode",
            provider: "opencode",
            modelFamily: "opencode",
            modelSnapshot: "gpt-4o",
          },
        }),
      ),
    ]);

    expect(claudeResult.status).toBe("ok");
    expect(claudeResult.attempts).toBe(1);
    expect(claudeRequests).toHaveLength(1);
    expect(claudeRequests[0].route.provider).toBe("anthropic");

    expect(opencodeResult.status).toBe("ok");
    expect(opencodeDone).toBe(true);
  });

  test("BE3a sibling survival: cancelling or aborting one session leaves sibling session and server unaffected", async () => {
    let session1Aborted = false;
    let session2Completed = false;

    // Single shared client / transport representing shared server
    const client: OpenCodeClientLike = {
      createSession: async (input) => ({
        id: input.userPrompt.includes("session-1") ? "sess-1" : "sess-2",
      }),
      streamEvents: (sess) =>
        (async function* () {
          if (sess.id === "sess-1") {
            // Hung session 1 yielding streamed content
            for (;;) {
              await new Promise((r) => setTimeout(r, 5));
              yield { kind: "delta", text: "session-1 partial" };
            }
          } else {
            // #214: session 2 must complete `ok` to prove it survived
            // session 1's cancellation — see the WHY comment on the cwd test
            // above for why a tool event is needed here too.
            yield { kind: "tool", tool: "read" };
            yield { kind: "delta", text: '{"findings":[]}' };
          }
        })(),
      pollStatus: async (sess) => {
        if (sess.id === "sess-1") {
          return { kind: "pending" };
        }
        session2Completed = true;
        return {
          kind: "terminal",
          proof: {
            eventId: "sess-2-proof",
            providerStatus: "completed",
            providerObservedAt: new Date().toISOString(),
          },
        };
      },
      abort: async (sess) => {
        if (sess.id === "sess-1") {
          session1Aborted = true;
        }
      },
      close: async () => {},
    };

    const transport = new OpenCodeSdkTransport({
      client,
      pollIntervalMs: 5,
      pollRoundMs: 10,
      abortConfirmMs: 20,
    });

    const cancelController = new AbortController();
    const harness1 = new StepExecutionHarness({
      transport,
      workspaceRoot: tmpDir,
      binaryPath: opencodeFixture.canonicalPath,
      executableAllowlist: [
        {
          absolutePath: opencodeFixture.canonicalPath,
          sha256: opencodeFixture.sha256,
        },
      ],
      signal: cancelController.signal,
      graceMarginMs: 10,
    });

    const harness2 = new StepExecutionHarness({
      transport,
      workspaceRoot: tmpDir,
      binaryPath: opencodeFixture.canonicalPath,
      executableAllowlist: [
        {
          absolutePath: opencodeFixture.canonicalPath,
          sha256: opencodeFixture.sha256,
        },
      ],
    });

    // Start session 1
    const p1 = harness1.run(
      makeStep(tmpDir, {
        prompt: "session-1 prompt",
        route: {
          backend: "opencode",
          provider: "opencode",
          modelFamily: "opencode",
          modelSnapshot: "gpt-4o",
        },
      }),
    );

    // Cancel session 1 shortly after
    setTimeout(() => cancelController.abort(), 10);

    // Run sibling session 2
    const res2 = await harness2.run(
      makeStep(tmpDir, {
        prompt: "session-2 prompt",
        route: {
          backend: "opencode",
          provider: "opencode",
          modelFamily: "opencode",
          modelSnapshot: "gpt-4o",
        },
      }),
    );

    const res1 = await p1;

    expect(res1.status).toBe("failed");
    expect(res1.stderrTail).toMatch(/cancel/i);
    expect(session1Aborted).toBe(true);

    // Sibling session 2 completed successfully and undisturbed
    expect(res2.status).toBe("ok");
    expect(session2Completed).toBe(true);
    expect(res2.resultText).toBe('{"findings":[]}');
  });

  // --- BE3b: Unsafe lifecycle, generic facts, and refusal safeguards ---
  test("BE3b unsafe lifecycle: unauthorized tools are denied before transport execute", async () => {
    const requests: TransportRequest[] = [];
    const transport = createRecordingTransport(requests, "opencode");

    const step = resolveStepRoute({
      stepKey: "hunter-reliability",
      role: "hunter",
      models: {
        default: [{ model: "opencode:openai/gpt-4o", effort: "high" }],
      },
    });

    const registry = new DefaultTransportRegistry();
    registry.register("opencode", transport);

    const runtime = await createProductionRuntime({
      workspaceRoot: tmpDir,
      plan: createResolvedRoutePlan([step]),
      binaryPath: opencodeFixture.canonicalPath,
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

    const result = await runtime.runner.run(
      makeStep(tmpDir, {
        tools: ["Read", "bash"],
        routeKey: step.routeFingerprint,
        route: step.route,
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(requests).toHaveLength(0);
    expect(result.stderrTail).toMatch(/bash|allow.?map|tool/i);
  });

  test("BE3b unsafe lifecycle: missing non-Claude generic facts fail-closed refusal", async () => {
    // Non-Claude transport missing admissionIdentity and cancellationSemantics
    const bareTransport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => ({
        backend: "opencode",
        status: "ready",
        issues: [],
        auth: {
          kind: "opencode_chatgpt_oauth",
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
      }),
      execute: async () => {
        throw new Error("Should never be called");
      },
      classifyFailure: () => undefined,
    };

    const harness = new StepExecutionHarness({
      transport: bareTransport,
      workspaceRoot: tmpDir,
      binaryPath: opencodeFixture.canonicalPath,
      executableAllowlist: [
        {
          absolutePath: opencodeFixture.canonicalPath,
          sha256: opencodeFixture.sha256,
        },
      ],
    });

    const result = await harness.run(
      makeStep(tmpDir, {
        route: {
          backend: "opencode",
          provider: "opencode",
          modelFamily: "opencode",
          modelSnapshot: "gpt-4o",
        },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.denialCode).toBe("executable_not_approved");
    expect(result.attempts).toBe(0);
    expect(result.stderrTail).toMatch(
      /missing required generic execution facts/i,
    );
  });

  test("BE3b unsafe lifecycle: legacy Claude preserves defaults when generic facts are omitted", async () => {
    const requests: TransportRequest[] = [];
    const bareClaudeTransport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => ({
        backend: "claude-code",
        status: "ready",
        issues: [],
        auth: {
          kind: "claude_subscription_oauth",
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
      }),
      execute: async (req) => {
        requests.push(req);
        return {
          completion: "success",
          protocolIntegrity: "verified",
          finalText: '{"findings":[]}',
          usage: {
            wallMs: 10,
            tokens: { inputKnown: 10, outputKnown: 5, totalKnown: 15 },
            completeness: "complete",
            billingMode: "subscription",
            costSource: "subscription",
          },
          stderrTail: "",
        };
      },
      classifyFailure: () => undefined,
    };

    const harness = new StepExecutionHarness({
      transport: bareClaudeTransport,
      workspaceRoot: tmpDir,
      binaryPath: claudeFixture.canonicalPath,
      executableAllowlist: [
        {
          absolutePath: claudeFixture.canonicalPath,
          sha256: claudeFixture.sha256,
        },
      ],
    });

    const result = await harness.run(makeStep(tmpDir));
    expect(result.status).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0].route.provider).toBe("anthropic");
    expect(requests[0].route.backend).toBe("claude-code");
  });

  test("BE3b unsafe lifecycle: mixed-provider refusal preserves credential isolation", async () => {
    // Transport declared for provider 'openai'
    const openAiTransport: ProviderTransport = {
      backend: "opencode",
      admissionIdentity: {
        executable: "opencode",
        provider: "openai",
      },
      cancellationSemantics: "provider-proof",
      defaultRoute: {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
      },
      capabilities: async () => ({
        backend: "opencode",
        status: "ready",
        issues: [],
        auth: {
          kind: "opencode_chatgpt_oauth",
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
      }),
      execute: async () => {
        throw new Error("Should not execute with mismatched provider");
      },
      classifyFailure: () => undefined,
    };

    const harness = new StepExecutionHarness({
      transport: openAiTransport,
      workspaceRoot: tmpDir,
      binaryPath: opencodeFixture.canonicalPath,
      executableAllowlist: [
        {
          absolutePath: opencodeFixture.canonicalPath,
          sha256: opencodeFixture.sha256,
        },
      ],
    });

    // Step specifies anthropic provider under openai transport
    const result = await harness.run(
      makeStep(tmpDir, {
        route: {
          backend: "opencode",
          provider: "anthropic",
          modelFamily: "claude",
          modelSnapshot: "sonnet",
        },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.denialCode).toBe("executable_not_approved");
    expect(result.attempts).toBe(0);
    expect(result.stderrTail).toMatch(/provider mismatch/i);
  });

  test("BE3b unsafe lifecycle: unconfirmed abort distinguishes request vs ack vs confirmation without claiming remote cessation", async () => {
    let abortCalled = false;
    const client: OpenCodeClientLike = {
      createSession: async () => ({ id: "sess-unconfirmed" }),
      streamEvents: () =>
        (async function* () {
          for (;;) {
            await new Promise((r) => setTimeout(r, 5));
            yield { kind: "delta", text: "unconfirmed partial" };
          }
        })(),
      pollStatus: async () => ({ kind: "pending" }),
      abort: async () => {
        abortCalled = true;
        // Simulates remote provider that never confirms cessation
      },
      close: async () => {},
    };

    const transport = new OpenCodeSdkTransport({
      client,
      abortConfirmMs: 20,
      cleanupMs: 10,
      pollIntervalMs: 5,
      pollRoundMs: 10,
    });

    const cancelController = new AbortController();
    let settledReceipt: SettlementReceipt | undefined;

    const harness = new StepExecutionHarness({
      transport,
      workspaceRoot: tmpDir,
      binaryPath: opencodeFixture.canonicalPath,
      executableAllowlist: [
        {
          absolutePath: opencodeFixture.canonicalPath,
          sha256: opencodeFixture.sha256,
        },
      ],
      signal: cancelController.signal,
      graceMarginMs: 10,
      onSessionSettled: (ev) => {
        settledReceipt = ev.receipt;
      },
    });

    const runPromise = harness.run(
      makeStep(tmpDir, {
        route: {
          backend: "opencode",
          provider: "opencode",
          modelFamily: "opencode",
          modelSnapshot: "gpt-4o",
        },
      }),
    );

    setTimeout(() => cancelController.abort(), 10);
    const result = await runPromise;

    expect(abortCalled).toBe(true);
    expect(result.status).toBe("failed");
    expect(settledReceipt).toBeDefined();

    // 1. Abort requested timestamp exists (request)
    expect(settledReceipt?.timestamps.abortRequestedAt).toBeDefined();

    // 2. Lease invalidated timestamp exists (acknowledgement / local fence)
    expect(settledReceipt?.timestamps.leaseInvalidatedAt).toBeDefined();

    // 3. Confirmation is unconfirmed (no remote cessation claim)
    expect(settledReceipt?.termination.requested).toBe(true);
    expect(settledReceipt?.termination.confirmation).toBe("unconfirmed");

    // 4. Remote status honestly reports unknown_may_continue
    expect(settledReceipt?.resources.remoteStatus).toBe("unknown_may_continue");

    // 5. Process group alive is not_applicable for SDK transport
    expect(settledReceipt?.resources.processGroupAlive).toBe("not_applicable");

    // 6. Outcome is local_fenced_remote_unconfirmed
    expect(settledReceipt?.outcome).toBe("local_fenced_remote_unconfirmed");
  });
});
