// odd/tasks/role-model-routing.md U4 (S4, S8, S9; L12 "Several providers: one
// OpenCode server per credential (provider + kind) with a per-route broker").
// A review whose models name several OpenCode providers runs, each route through
// an OpenCode server projected with exactly that route's one credential record.
// These tests drive the production path: admission
// (prepareProductionAdmissionContext) -> createProductionRuntime ->
// MultiProviderRunner -> StepExecutionHarness, with per-route scripted
// transports standing in for the OpenCode server so nothing spawns or spends.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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
import type { ModelsConfig } from "#model/model-name";
import {
  createResolvedRoutePlan,
  type ResolvedStepRoute,
  resolveStepRoute,
} from "#model/routing";
import type { StepSpec } from "#review/step-runner";
import type {
  CredentialKind,
  ProviderCapabilityReport,
  ProviderTransport,
  TransportFailureCause,
  TransportOutcome,
  TransportRequest,
} from "../src/execution/contracts";
import {
  createProductionRuntime,
  type ProductionAdmissionContext,
  prepareProductionAdmissionContext,
} from "../src/production-runtime";
import { createOpenCodeBrokerPool } from "../src/runner-authority";
import {
  type CredentialBroker,
  OpenCodeApiTokenBroker,
  OpenCodeAuthBroker,
  OpenCodeFreeBroker,
} from "../src/security/credential-broker";
import {
  createDefaultTransportRegistry,
  DefaultTransportRegistry,
  type TransportFactoryOptions,
} from "../src/transport-registry";
import { successfulClaudeCredentialBroker } from "./support/claude-credential-broker";

const MACHO_PREFIX = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

// The auth file the CI setup step builds from CRYSK_OPENCODE_* secrets: a
// DeepSeek API key, an OpenAI subscription and a z.ai API key, side by side.
const STORE = {
  deepseek: { type: "api", key: "sk-deepseek-test" },
  openai: { type: "oauth", access: "oa-access", refresh: "oa-refresh" },
  zai: { type: "api", key: "sk-zai-test" },
};
const SECRET_NAMES = [
  "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
  "CRYSK_OPENCODE_OPENAI_OAUTH",
  "CRYSK_OPENCODE_ZAI_API_KEY",
];

// The production broker for each kind, reading the fake store above instead of
// the operator's real one.
function fakeStoreBroker(
  kind: CredentialKind,
  provider: string,
): CredentialBroker {
  const readerFn = async () => JSON.stringify(STORE);
  if (kind === "provider_free")
    return new OpenCodeFreeBroker(provider, { readerFn });
  if (kind === "provider_api_token") {
    return new OpenCodeApiTokenBroker(provider, { readerFn });
  }
  return new OpenCodeAuthBroker({ readerFn });
}

let originalTmpdir: string | undefined;
let isolatedTmpdir: string;

beforeAll(async () => {
  originalTmpdir = process.env.TMPDIR;
  isolatedTmpdir = await mkdtemp(path.join(tmpdir(), "pr-hero-multicred-tmp-"));
  process.env.TMPDIR = isolatedTmpdir;
});

afterAll(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(isolatedTmpdir, { recursive: true, force: true });
});

async function writeFixture(
  dir: string,
  name: string,
  bytes: Buffer,
): Promise<{ canonicalPath: string; sha256: string }> {
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  await chmod(file, 0o755);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { canonicalPath: await realpath(file), sha256: hasher.digest("hex") };
}

let tmpDir: string;
let claude: { canonicalPath: string; sha256: string };
let opencode: { canonicalPath: string; sha256: string };

beforeEach(async () => {
  tmpDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "pr-hero-multicred-")),
  );
  claude = await writeFixture(
    tmpDir,
    "claude",
    Buffer.concat([MACHO_PREFIX, Buffer.from("#!/bin/sh\nexit 0\n")]),
  );
  opencode = await writeFixture(
    tmpDir,
    "opencode",
    Buffer.from(
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "1.18.30"\n  exit 0\nfi\nexit 0\n',
    ),
  );
  await writeFile(path.join(tmpDir, "system.md"), "system");
  await writeFile(path.join(tmpDir, "mcp.json"), "{}");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

const mockLoadSdk = async () =>
  ({
    createOpencodeClient: () => ({ session: {}, event: {} }),
  }) as unknown as import("../src/transports/opencode-client").OpenCodeSdkLike;

function routeFor(role: string, models: string[]): ResolvedStepRoute {
  const config: ModelsConfig = { [role]: models };
  return resolveStepRoute({
    stepKey: role.replace(".", "-"),
    role: role.startsWith("hunter.") ? "hunter" : "refuter",
    modelRole: role,
    models: config,
  });
}

function stepFor(route: ResolvedStepRoute): StepSpec {
  return {
    name: route.stepKey,
    systemPromptPath: path.join(tmpDir, "system.md"),
    prompt: "review",
    tools: ["Read"],
    mcpConfigPath: path.join(tmpDir, "mcp.json"),
    model: "sonnet",
    effort: "high",
    cwd: tmpDir,
    outPath: path.join(tmpDir, "steps", `${route.stepKey}.draft.json`),
    timeoutMs: 5000,
    maxAttempts: 1,
    parse: (text: string) => JSON.parse(text),
    route: route.route,
    ...(route.fallbacks === undefined
      ? {}
      : { fallbackRoutes: route.fallbacks.map((f) => f.route) }),
  };
}

async function admit(
  routes: ResolvedStepRoute[],
  extra: {
    freeModelProbe?: (p: string, m: string) => Promise<boolean>;
    openCodeBroker?: CredentialBroker;
  } = {},
): Promise<ProductionAdmissionContext | { readonly error: string }> {
  return await prepareProductionAdmissionContext({
    workspaceRoot: tmpDir,
    plan: createResolvedRoutePlan(routes),
    env: { PATH: tmpDir },
    loadSdk: mockLoadSdk,
    openCodeSecretNames: SECRET_NAMES,
    openCodeBrokerFor: createOpenCodeBrokerPool(fakeStoreBroker),
    credentialBrokers: {
      "claude-code": successfulClaudeCredentialBroker,
      ...(extra.openCodeBroker === undefined
        ? {}
        : { opencode: extra.openCodeBroker }),
    },
    freeModelProbe: extra.freeModelProbe ?? (async () => false),
    authorityDeps: {
      existsFn: (p) =>
        p === claude.canonicalPath ||
        p === opencode.canonicalPath ||
        p.startsWith(tmpDir),
      realpathFn: async (p) => p,
    },
  });
}

function admitted(
  result: ProductionAdmissionContext | { readonly error: string },
): ProductionAdmissionContext {
  if ("error" in result) throw new Error(`admission refused: ${result.error}`);
  return result;
}

// One OpenCode "server" per transport instance, the way the real client
// launches one lazily on its first session and closes it on dispose. Each
// records the broker and kind the registry handed its factory, which is what
// the real launcher (openCodeLaunchServerFor) projects the server with.
interface FakeServer {
  readonly provider: string;
  readonly broker: CredentialBroker | undefined;
  readonly kind: CredentialKind | undefined;
  launched: number;
  closed: number;
}

type Script = (
  request: TransportRequest,
  signal: AbortSignal,
) => TransportOutcome | Promise<TransportOutcome>;

function ok(): TransportOutcome {
  return {
    completion: "success",
    protocolIntegrity: "verified",
    finalText: '{"findings":[]}',
    usage: {
      wallMs: 10,
      tokens: { totalKnown: 1 },
      completeness: "complete",
      billingMode: "subscription",
      costSource: "subscription",
    },
    stderrTail: "",
  };
}

function fail(failureCause: TransportFailureCause): TransportOutcome {
  return { ...ok(), completion: "failed", finalText: "", failureCause };
}

function scriptedRegistry(script: Script): {
  registry: DefaultTransportRegistry;
  servers: FakeServer[];
  requests: TransportRequest[];
} {
  const servers: FakeServer[] = [];
  const requests: TransportRequest[] = [];
  const registry = new DefaultTransportRegistry();
  registry.register("opencode", (opts?: TransportFactoryOptions) => {
    const provider = opts?.route?.provider ?? "opencode";
    const server: FakeServer = {
      provider,
      broker: opts?.credentialBroker,
      kind: opts?.credentialKind,
      launched: 0,
      closed: 0,
    };
    const capabilities = async (): Promise<ProviderCapabilityReport> => ({
      backend: "opencode",
      status: "ready",
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
      cancellation: { deadlineMs: 200, conformance: "passed" },
      billing: { mode: "subscription", pricingReady: true },
      issues: [],
    });
    const transport: ProviderTransport & { dispose(): Promise<void> } = {
      backend: "opencode",
      admissionIdentity: { executable: "opencode", provider },
      cancellationSemantics: "provider-proof",
      credentialProjection: "server-lifetime",
      capabilities,
      execute: async (request, context) => {
        if (server.launched === server.closed) {
          server.launched += 1;
          if (!servers.includes(server)) servers.push(server);
        }
        requests.push(request);
        return await script(request, context.signal);
      },
      classifyFailure: () => undefined,
      dispose: async () => {
        if (server.launched > server.closed) server.closed += 1;
      },
    };
    return transport;
  });
  return { registry, servers, requests };
}

async function runtimeFrom(
  admission: ProductionAdmissionContext,
  routes: ResolvedStepRoute[],
  registry: DefaultTransportRegistry,
  signal?: AbortSignal,
) {
  return await createProductionRuntime({
    ...admission.authorityOptions,
    plan: createResolvedRoutePlan(routes),
    workspaceRoot: tmpDir,
    registry,
    evidence: admission.evidence,
    mode: "production",
    ...(admission.freeModelProbe === undefined
      ? {}
      : { freeModelProbe: admission.freeModelProbe }),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function projectedRecord(
  broker: CredentialBroker | undefined,
  kind: CredentialKind | undefined,
): Promise<Record<string, unknown>> {
  if (broker === undefined || kind === undefined) {
    throw new Error("the server got no broker or no kind");
  }
  const projection = await broker.project({
    sessionId: "s",
    credentialRef: "r",
    kind,
    verifiedBinaryPath: opencode.canonicalPath,
  });
  try {
    const file = projection.files[0];
    return file === undefined
      ? {}
      : (JSON.parse(await readFile(file.path, "utf8")) as Record<
          string,
          unknown
        >);
  } finally {
    await projection.destroy();
  }
}

describe("U4: several OpenCode providers in one review", () => {
  test("a plan naming two OpenCode providers is admitted, each route on its own credential", async () => {
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
    ]);
    const refuter = routeFor("refuter", ["opencode:openai/gpt-5"]);
    const admission = admitted(await admit([hunter, refuter]));
    // No plan-wide credential: the registry carries no default broker or kind,
    // and the authority no shared broker, because there is no one answer.
    expect(
      admission.authorityOptions.credentialBrokers?.opencode,
    ).toBeUndefined();
    const registry = admission.registry as DefaultTransportRegistry;
    expect(registry.openCodeCredentialBroker).toBeUndefined();
    expect(registry.openCodeCredentialKind).toBeUndefined();

    const { registry: scripted } = scriptedRegistry(() => ok());
    const runtime = await runtimeFrom(admission, [hunter, refuter], scripted);
    try {
      const deepseek = runtime.bindings.get(hunter.routeFingerprint);
      const openai = runtime.bindings.get(refuter.routeFingerprint);
      expect(deepseek?.credential.kind).toBe("provider_api_token");
      expect(deepseek?.credential.broker).toBeInstanceOf(
        OpenCodeApiTokenBroker,
      );
      expect(openai?.credential.kind).toBe("opencode_chatgpt_oauth");
      expect(openai?.credential.broker).toBeInstanceOf(OpenCodeAuthBroker);
      // Two credentials, two rate-limit buckets.
      expect(deepseek?.credential.bucketId).not.toBe(
        openai?.credential.bucketId,
      );
    } finally {
      await runtime.dispose();
    }
  });

  test("each route's server is projected with exactly its own credential record", async () => {
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
    ]);
    const refuter = routeFor("refuter", ["opencode:openai/gpt-5"]);
    const admission = admitted(await admit([hunter, refuter]));
    const { registry, servers } = scriptedRegistry(() => ok());
    const runtime = await runtimeFrom(admission, [hunter, refuter], registry);
    try {
      const results = await Promise.all([
        runtime.runner.run(stepFor(hunter)),
        runtime.runner.run(stepFor(refuter)),
      ]);
      expect(results.map((r) => r.status)).toEqual(["ok", "ok"]);
      const byProvider = new Map(servers.map((s) => [s.provider, s]));
      expect([...byProvider.keys()].sort()).toEqual(["deepseek", "openai"]);
      for (const [provider, server] of byProvider) {
        const binding = [...runtime.bindings.values()].find(
          (b) => b.route.provider === provider,
        );
        // The server's broker is the binding's own instance (#149, per route).
        expect(server.broker).toBe(binding?.credential.broker);
        expect(server.kind).toBe(binding?.credential.kind);
        // One-record projection: only this provider's record, never another's.
        expect(await projectedRecord(server.broker, server.kind)).toEqual({
          [provider]: STORE[provider as keyof typeof STORE],
        });
      }
    } finally {
      await runtime.dispose();
    }
  });

  test("a free and a metered OpenCode route mix, each billed by its own kind", async () => {
    const hunter = routeFor("hunter.logic", ["opencode:zai/glm-free"]);
    const refuter = routeFor("refuter", ["opencode:zai/glm-5"]);
    const admission = admitted(
      await admit([hunter, refuter], {
        freeModelProbe: async (_p, m) => m === "glm-free",
      }),
    );
    // Real registry, fake client: the usage stamp each route's transport gets.
    const registry = createDefaultTransportRegistry({
      mode: "conformance",
      sdkVersion: "1.18.25",
      serverVersion: "1.18.30",
      openCodeClient: {
        createSession: async () => ({ id: "s" }),
        async *streamEvents() {},
        pollStatus: async () => ({ kind: "pending" }) as const,
        abort: async () => {},
      } as never,
    });
    const runtime = await runtimeFrom(
      admission,
      [hunter, refuter],
      registry as DefaultTransportRegistry,
    );
    try {
      const free = runtime.bindings.get(hunter.routeFingerprint);
      const paid = runtime.bindings.get(refuter.routeFingerprint);
      expect(free?.credential.kind).toBe("provider_free");
      expect(free?.credential.broker).toBeInstanceOf(OpenCodeFreeBroker);
      expect(paid?.credential.kind).toBe("provider_api_token");
      expect(paid?.credential.broker).toBeInstanceOf(OpenCodeApiTokenBroker);
      const stamps: string[] = [];
      for (const binding of [free, paid]) {
        if (binding === undefined) throw new Error("missing binding");
        const lease = await binding.acquire({} as never, registry);
        stamps.push(
          (lease.transport as unknown as { usageBillingMode: string })
            .usageBillingMode,
        );
        await lease.dispose();
      }
      expect(stamps).toEqual(["free", "metered"]);
      expect((await paid?.capabilities())?.billing.mode).toBe("metered");
    } finally {
      await runtime.dispose();
    }
  });

  test("a refused login on one provider falls back to the other provider's credential", async () => {
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
      "opencode:deepseek/deepseek-reasoner",
      "opencode:openai/gpt-5",
    ]);
    const admission = admitted(await admit([hunter]));
    const { registry, requests } = scriptedRegistry((request) =>
      request.route.provider === "deepseek" ? fail("auth_invalid") : ok(),
    );
    const runtime = await runtimeFrom(admission, [hunter], registry);
    try {
      const result = await runtime.runner.run(stepFor(hunter));
      expect(result.status).toBe("ok");
      // The second DeepSeek model shares the refused credential and is skipped.
      expect(
        requests.map((r) => `${r.route.provider}/${r.route.modelSnapshot}`),
      ).toEqual(["deepseek/deepseek-chat", "openai/gpt-5"]);
    } finally {
      await runtime.dispose();
    }
  });

  test("two steps on one route at once share its server, closed after the last", async () => {
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
    ]);
    const refuter = routeFor("refuter", ["opencode:openai/gpt-5"]);
    const admission = admitted(await admit([hunter, refuter]));
    // Both steps are in flight before either finishes, so each one's own
    // teardown sees the other's lease and leaves the server up.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    const { registry, servers } = scriptedRegistry(async () => {
      inFlight += 1;
      if (inFlight === 2) release();
      await gate;
      return ok();
    });
    const runtime = await runtimeFrom(admission, [hunter, refuter], registry);
    try {
      const results = await Promise.all([
        runtime.runner.run({
          ...stepFor(hunter),
          name: "hunter-a",
          outPath: path.join(tmpDir, "steps", "hunter-a.draft.json"),
        }),
        runtime.runner.run({
          ...stepFor(hunter),
          name: "hunter-b",
          outPath: path.join(tmpDir, "steps", "hunter-b.draft.json"),
        }),
      ]);
      expect(results.map((r) => r.status)).toEqual(["ok", "ok"]);
      expect(servers).toHaveLength(1);
      expect(servers[0]?.launched).toBe(1);
      expect(servers[0]?.closed).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  test("every server is closed after success and failure", async () => {
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
    ]);
    const refuter = routeFor("refuter", ["opencode:openai/gpt-5"]);
    const admission = admitted(await admit([hunter, refuter]));
    const { registry, servers } = scriptedRegistry((request) =>
      request.route.provider === "openai"
        ? fail("context_window_exceeded")
        : ok(),
    );
    const runtime = await runtimeFrom(admission, [hunter, refuter], registry);
    try {
      const results = await Promise.all([
        runtime.runner.run(stepFor(hunter)),
        runtime.runner.run(stepFor(refuter)),
      ]);
      expect(results.map((r) => r.status)).toEqual(["ok", "failed"]);
      expect(servers).toHaveLength(2);
      for (const server of servers) {
        expect(server.closed).toBe(server.launched);
      }
    } finally {
      await runtime.dispose();
    }
  });

  test("every server is closed when the run is aborted mid-step", async () => {
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
    ]);
    const refuter = routeFor("refuter", ["opencode:openai/gpt-5"]);
    const admission = admitted(await admit([hunter, refuter]));
    const controller = new AbortController();
    let started = 0;
    const { registry, servers } = scriptedRegistry(
      (_request, signal) =>
        new Promise<TransportOutcome>((resolve) => {
          started += 1;
          if (started === 2) controller.abort();
          const settle = () => resolve(fail("network_transient"));
          if (signal.aborted) settle();
          else signal.addEventListener("abort", settle, { once: true });
        }),
    );
    const runtime = await runtimeFrom(
      admission,
      [hunter, refuter],
      registry,
      controller.signal,
    );
    try {
      await Promise.all([
        runtime.runner.run(stepFor(hunter)),
        runtime.runner.run(stepFor(refuter)),
      ]);
      expect(servers).toHaveLength(2);
      for (const server of servers) {
        expect(server.closed).toBe(server.launched);
      }
    } finally {
      await runtime.dispose();
    }
  });

  test("disposing the runtime closes a server whose lease never ended", async () => {
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
    ]);
    const refuter = routeFor("refuter", ["opencode:openai/gpt-5"]);
    const admission = admitted(await admit([hunter, refuter]));
    const { registry, servers } = scriptedRegistry(() => ok());
    const runtime = await runtimeFrom(admission, [hunter, refuter], registry);
    const binding = runtime.bindings.get(hunter.routeFingerprint);
    if (binding === undefined) throw new Error("missing binding");
    // A lease taken and never returned: a step torn down mid-flight.
    const lease = await binding.acquire({} as never, registry);
    await lease.transport.execute(
      {
        route: hunter.route,
      } as unknown as TransportRequest,
      { signal: new AbortController().signal } as never,
    );
    expect(servers.map((s) => s.launched - s.closed)).toEqual([1]);
    await runtime.dispose();
    expect(servers.map((s) => s.launched - s.closed)).toEqual([0]);
  });

  test("admission refuses a caller's single OpenCode broker for a plan with two credentials", async () => {
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
    ]);
    const refuter = routeFor("refuter", ["opencode:zai/glm-5"]);
    const result = await admit([hunter, refuter], {
      // Same kind for both providers, so no type lock would catch it: the zai
      // record would be projected into the deepseek route's server.
      openCodeBroker: fakeStoreBroker("provider_api_token", "zai"),
    });
    if (!("error" in result)) throw new Error("expected a refusal");
    expect(result.error).toContain("deepseek provider_api_token");
    expect(result.error).toContain("zai provider_api_token");
    expect(result.error).toContain("credentialBrokers.opencode");
  });
});

describe("U4: what a single-provider plan keeps", () => {
  test("one OpenCode credential still seeds one shared broker and the registry's default", async () => {
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
    ]);
    const refuter = routeFor("refuter", [
      "opencode:deepseek/deepseek-reasoner",
    ]);
    const admission = admitted(await admit([hunter, refuter]));
    const shared = admission.authorityOptions.credentialBrokers?.opencode;
    expect(shared).toBeInstanceOf(OpenCodeApiTokenBroker);
    const registry = admission.registry as DefaultTransportRegistry;
    expect(registry.openCodeCredentialBroker).toBe(shared);
    expect(registry.openCodeCredentialKind).toBe("provider_api_token");
    const { registry: scripted, servers } = scriptedRegistry(() => ok());
    const runtime = await runtimeFrom(admission, [hunter, refuter], scripted);
    try {
      await runtime.runner.run(stepFor(hunter));
      for (const binding of runtime.bindings.values()) {
        expect(binding.credential.broker).toBe(shared);
      }
      expect(servers[0]?.broker).toBe(shared);
    } finally {
      await runtime.dispose();
    }
  });

  test("each route's broker keeps its type lock: it refuses another kind by name", async () => {
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
    ]);
    const refuter = routeFor("refuter", ["opencode:openai/gpt-5"]);
    const admission = admitted(await admit([hunter, refuter]));
    const { registry } = scriptedRegistry(() => ok());
    const runtime = await runtimeFrom(admission, [hunter, refuter], registry);
    try {
      const deepseek = runtime.bindings.get(hunter.routeFingerprint);
      const openai = runtime.bindings.get(refuter.routeFingerprint);
      await expect(
        projectedRecord(deepseek?.credential.broker, "opencode_chatgpt_oauth"),
      ).rejects.toThrow(
        /OpenCodeApiTokenBroker projects only provider_api_token/,
      );
      await expect(
        projectedRecord(openai?.credential.broker, "provider_api_token"),
      ).rejects.toThrow(
        /OpenCodeAuthBroker projects only opencode_chatgpt_oauth/,
      );
    } finally {
      await runtime.dispose();
    }
  });

  test("a Claude route beside two OpenCode providers keeps its own transport and credential", async () => {
    const claudeRoute = routeFor("hunter.parity", ["claude:sonnet-latest"]);
    const hunter = routeFor("hunter.logic", [
      "opencode:deepseek/deepseek-chat",
    ]);
    const refuter = routeFor("refuter", ["opencode:openai/gpt-5"]);
    const admission = admitted(await admit([claudeRoute, hunter, refuter]));
    const { registry } = scriptedRegistry(() => ok());
    const claudeRequests: TransportRequest[] = [];
    let claudeFactoryBroker: CredentialBroker | undefined;
    registry.register("claude-code", (opts?: TransportFactoryOptions) => {
      claudeFactoryBroker = opts?.credentialBroker;
      return {
        backend: "claude-code",
        admissionIdentity: { executable: "claude", provider: "anthropic" },
        cancellationSemantics: "process-exit",
        capabilities: async () => ({
          backend: "claude-code",
          status: "ready",
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
          cancellation: { deadlineMs: 200, conformance: "passed" },
          billing: { mode: "subscription", pricingReady: true },
          issues: [],
        }),
        execute: async (request) => {
          claudeRequests.push(request);
          return ok();
        },
        classifyFailure: () => undefined,
      } satisfies ProviderTransport;
    });
    const runtime = await runtimeFrom(
      admission,
      [claudeRoute, hunter, refuter],
      registry,
    );
    try {
      const binding = runtime.bindings.get(claudeRoute.routeFingerprint);
      expect(binding?.credential.kind).toBe("claude_subscription_oauth");
      expect(binding?.credential.broker).toBe(successfulClaudeCredentialBroker);
      const result = await runtime.runner.run(stepFor(claudeRoute));
      expect(result.status).toBe("ok");
      expect(claudeRequests).toHaveLength(1);
      // No OpenCode broker reaches the Claude transport.
      expect(claudeFactoryBroker).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});
