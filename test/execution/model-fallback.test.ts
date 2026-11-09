// odd/tasks/role-model-routing.md S4 (E-d): a role's models are tried in
// order. The run moves to the next model only when the provider failed it (a
// rate limit, no quota, a network error, a truncated stream, a timeout, a
// model the provider does not serve), never on a bad answer, and never on a
// context-window, output-limit or safety-refusal error (L6 item 8). The model
// that ran is recorded. These tests drive the real runtime
// (createProductionRuntime -> MultiProviderRunner -> StepExecutionHarness)
// with scripted transports, so every effect is observed where a review sees it.
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
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  ProviderCapabilityReport,
  ProviderTransport,
  RunnerBackend,
  TransportFailureCause,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  attemptLogPath,
  settlementReceiptPath,
} from "../../src/execution/step-artifacts";
import type { NormalizedUsage } from "../../src/execution/usage-normalized";
import {
  createProductionRuntime,
  type ProductionRuntimeOptions,
  planOpenCodeCredentials,
  soleOpenCodeCredentialOf,
} from "../../src/production-runtime";
import { OpenCodeAuthBroker } from "../../src/security/credential-broker";
import {
  admitRoutePlan,
  type D1_11ReadinessEvidence,
  DefaultTransportRegistry,
} from "../../src/transport-registry";
import { successfulClaudeCredentialBroker } from "../support/claude-credential-broker";

const MACHO_PREFIX = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

let originalTmpdir: string | undefined;
let isolatedTmpdir: string;

beforeAll(async () => {
  originalTmpdir = process.env.TMPDIR;
  isolatedTmpdir = await mkdtemp(path.join(tmpdir(), "pr-hero-fallback-tmp-"));
  process.env.TMPDIR = isolatedTmpdir;
});

afterAll(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(isolatedTmpdir, { recursive: true, force: true });
});

const SUBSCRIPTION: NormalizedUsage = {
  wallMs: 10,
  tokens: { totalKnown: 1 },
  completeness: "complete",
  billingMode: "subscription",
  costSource: "subscription",
};

function metered(cashCostUsd: number): NormalizedUsage {
  return {
    wallMs: 10,
    tokens: { outputVisible: 10, outputKnown: 10, totalKnown: 20 },
    completeness: "complete",
    billingMode: "metered",
    costSource: "provider",
    cashCostUsd,
  };
}

function ok(usage: NormalizedUsage = SUBSCRIPTION): TransportOutcome {
  return {
    completion: "success",
    protocolIntegrity: "verified",
    finalText: '{"findings":[]}',
    usage,
    stderrTail: "",
  };
}

function fail(
  failureCause: TransportFailureCause,
  usage: NormalizedUsage = SUBSCRIPTION,
): TransportOutcome {
  return {
    completion: "failed",
    protocolIntegrity: "verified",
    finalText: "",
    usage,
    stderrTail: `provider error: ${failureCause}`,
    failureCause,
  };
}

type Script = (
  request: TransportRequest,
  signal: AbortSignal,
) => TransportOutcome | Promise<TransportOutcome>;

// A transport whose outcome is scripted by the model it is sent, recording
// every request in order.
function scriptedTransport(
  backend: RunnerBackend,
  script: Script,
  requests: TransportRequest[],
  billing: ProviderCapabilityReport["billing"] = {
    mode: "subscription",
    pricingReady: true,
  },
): ProviderTransport {
  return {
    backend,
    admissionIdentity:
      backend === "claude-code"
        ? { executable: "claude", provider: "anthropic" }
        : { executable: "opencode", provider: "opencode" },
    cancellationSemantics:
      backend === "claude-code" ? "process-exit" : "provider-proof",
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
      cancellation: { deadlineMs: 200, conformance: "passed" },
      billing,
      issues: [],
    }),
    execute: async (request, context) => {
      requests.push(request);
      return script(request, context.signal);
    },
    classifyFailure: () => undefined,
  };
}

const READY_OPENCODE_EVIDENCE: D1_11ReadinessEvidence = {
  sdkAvailable: true,
  credentialAuthority: true,
  workspaceBroker: true,
  pricingReady: true,
};

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
    await mkdtemp(path.join(tmpdir(), "pr-hero-fallback-")),
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

// The hunter's route, built the way the plan builds it: by role, from `models`.
function hunterRoute(models: string[]): ResolvedStepRoute {
  const config: ModelsConfig = { "hunter.reliability": models };
  return resolveStepRoute({
    stepKey: "hunter-reliability",
    role: "hunter",
    modelRole: "hunter.reliability",
    models: config,
  });
}

function stepFor(
  route: ResolvedStepRoute,
  overrides: Partial<StepSpec> = {},
): StepSpec {
  return {
    name: "hunter-reliability",
    systemPromptPath: path.join(tmpDir, "system.md"),
    prompt: "review",
    tools: ["Read"],
    mcpConfigPath: path.join(tmpDir, "mcp.json"),
    model: "sonnet",
    effort: "high",
    cwd: tmpDir,
    outPath: path.join(tmpDir, "steps", "hunter-reliability.draft.json"),
    timeoutMs: 5000,
    maxAttempts: 1,
    parse: (text: string) => JSON.parse(text),
    route: route.route,
    ...(route.fallbacks === undefined
      ? {}
      : { fallbackRoutes: route.fallbacks.map((f) => f.route) }),
    ...overrides,
  };
}

async function runtimeFor(
  routes: ResolvedStepRoute[],
  transports: Partial<Record<RunnerBackend, ProviderTransport>>,
  extra: Partial<ProductionRuntimeOptions> = {},
) {
  const registry = new DefaultTransportRegistry();
  for (const [backend, transport] of Object.entries(transports)) {
    if (transport !== undefined) {
      registry.register(backend as RunnerBackend, transport);
    }
  }
  const usesOpenCode = transports.opencode !== undefined;
  return createProductionRuntime({
    workspaceRoot: tmpDir,
    plan: createResolvedRoutePlan(routes),
    binaryPath: claude.canonicalPath,
    ...(usesOpenCode ? { openCodeBinaryPath: opencode.canonicalPath } : {}),
    executableAllowlists: {
      "claude-code": [
        { absolutePath: claude.canonicalPath, sha256: claude.sha256 },
      ],
      ...(usesOpenCode
        ? {
            opencode: [
              { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
            ],
          }
        : {}),
    },
    registry,
    mode: "conformance",
    ...(usesOpenCode
      ? { evidence: new Map([["opencode", READY_OPENCODE_EVIDENCE]]) }
      : {}),
    credentialBrokers: {
      "claude-code": successfulClaudeCredentialBroker,
      ...(usesOpenCode
        ? {
            opencode: new OpenCodeAuthBroker({
              readerFn: async () =>
                JSON.stringify({
                  openai: { type: "oauth", access: "test", refresh: "test" },
                }),
            }),
          }
        : {}),
    },
    authorityDeps: {
      existsFn: (p) =>
        p === claude.canonicalPath ||
        p === opencode.canonicalPath ||
        p.startsWith(tmpDir),
      realpathFn: async (p) => p,
    },
    ...extra,
  });
}

// Which model each request was sent, in order.
function sent(requests: TransportRequest[]): string[] {
  return requests.map((r) => `${r.route.backend}:${r.route.modelSnapshot}`);
}

const SONNET_THEN_OPUS = ["claude:sonnet-latest", "claude:opus-latest"];

describe("the causes that move to the next model", () => {
  const MOVING: TransportFailureCause[] = [
    "rate_limit",
    "quota_exhausted",
    "network_transient",
    "protocol_truncation",
    "model_unavailable",
  ];
  for (const cause of MOVING) {
    test(`${cause} on the first model runs the second, and the step records both`, async () => {
      const requests: TransportRequest[] = [];
      const route = hunterRoute(SONNET_THEN_OPUS);
      const runtime = await runtimeFor([route], {
        "claude-code": scriptedTransport(
          "claude-code",
          (r) => (r.route.modelSnapshot === "sonnet" ? fail(cause) : ok()),
          requests,
        ),
      });
      try {
        const result = await runtime.runner.run(stepFor(route));
        expect(sent(requests)).toEqual([
          "claude-code:sonnet",
          "claude-code:opus",
        ]);
        expect(result.status).toBe("ok");
        expect(result.output).toEqual({ findings: [] });
        expect(result.attempts).toBe(2);
        expect(result.failureCause).toBeUndefined();
        expect(result.finalCause).toBeUndefined();
        expect(
          result.modelAttempts?.map((a) => ({
            model: a.route.modelSnapshot,
            status: a.status,
            attempts: a.attempts,
            cause: a.cause,
          })),
        ).toEqual([
          { model: "sonnet", status: "failed", attempts: 1, cause },
          {
            model: "opus",
            status: "ok",
            attempts: 1,
            cause: undefined,
          },
        ]);
      } finally {
        await runtime.dispose();
      }
    });
  }

  test("a timeout moves too: the harness's own watchdog cause reaches the fallback", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterRoute(SONNET_THEN_OPUS);
    const runtime = await runtimeFor(
      [route],
      {
        "claude-code": scriptedTransport(
          "claude-code",
          (r, signal) =>
            r.route.modelSnapshot === "sonnet"
              ? new Promise<TransportOutcome>((resolve) => {
                  // Hangs until the harness's watchdog aborts it.
                  signal.addEventListener("abort", () =>
                    resolve(fail("network_transient")),
                  );
                })
              : ok(),
          requests,
        ),
      },
      { graceMarginMs: 10 },
    );
    try {
      const result = await runtime.runner.run(
        stepFor(route, { timeoutMs: 30 }),
      );
      expect(sent(requests)).toEqual([
        "claude-code:sonnet",
        "claude-code:opus",
      ]);
      expect(result.status).toBe("ok");
      expect(result.modelAttempts?.[0]?.cause).toBe("watchdog_timeout");
      expect(result.modelAttempts?.[1]?.status).toBe("ok");
    } finally {
      await runtime.dispose();
    }
  });

  test("each model keeps its own retries before the next one runs", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterRoute(SONNET_THEN_OPUS);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        (r) =>
          r.route.modelSnapshot === "sonnet" ? fail("network_transient") : ok(),
        requests,
      ),
    });
    try {
      const step = stepFor(route, { maxAttempts: 2 });
      const result = await runtime.runner.run(step);
      expect(sent(requests)).toEqual([
        "claude-code:sonnet",
        "claude-code:sonnet",
        "claude-code:opus",
      ]);
      expect(result.attempts).toBe(3);
      expect(result.modelAttempts?.map((a) => a.attempts)).toEqual([2, 1]);
      // Attempts are numbered across models, so no model's audit record
      // overwrites another's, and the step's pointer names the last one.
      expect(requests.map((r) => r.attempt)).toEqual([1, 2, 3]);
      for (const attempt of [1, 2, 3]) {
        expect(
          existsSync(attemptLogPath(step.outPath, step.name, attempt)),
        ).toBe(true);
        expect(
          existsSync(settlementReceiptPath(step.outPath, step.name, attempt)),
        ).toBe(true);
      }
    } finally {
      await runtime.dispose();
    }
  });
});

describe("the causes that never move", () => {
  const STAYING: TransportFailureCause[] = [
    "context_window_exceeded",
    "output_limit_exceeded",
    "safety_refusal",
  ];
  for (const cause of STAYING) {
    test(`${cause} stops on the first model (L6 item 8)`, async () => {
      const requests: TransportRequest[] = [];
      const route = hunterRoute(SONNET_THEN_OPUS);
      const runtime = await runtimeFor([route], {
        "claude-code": scriptedTransport(
          "claude-code",
          () => fail(cause),
          requests,
        ),
      });
      try {
        const result = await runtime.runner.run(stepFor(route));
        expect(sent(requests)).toEqual(["claude-code:sonnet"]);
        expect(result.status).toBe("failed");
        expect(result.failureCause).toBe(cause);
        expect(result.finalCause).toBe(cause);
        expect(result.attempts).toBe(1);
        expect(result.modelAttempts?.map((a) => a.route.modelSnapshot)).toEqual(
          ["sonnet"],
        );
      } finally {
        await runtime.dispose();
      }
    });
  }

  test("a bad answer is the model's, not the provider's: no move", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterRoute(SONNET_THEN_OPUS);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        () => ({ ...ok(), finalText: "not json at all" }),
        requests,
      ),
    });
    try {
      const result = await runtime.runner.run(stepFor(route));
      // The first try and its one format retry, both on sonnet.
      expect(sent(requests)).toEqual([
        "claude-code:sonnet",
        "claude-code:sonnet",
      ]);
      expect(result.status).toBe("failed");
      expect(result.finalCause).toBe("format_violation");
      expect(result.failureCause).toBeUndefined();
      expect(result.attempts).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  test("a cancelled run starts no further model", async () => {
    const requests: TransportRequest[] = [];
    const controller = new AbortController();
    const route = hunterRoute(SONNET_THEN_OPUS);
    const runtime = await runtimeFor(
      [route],
      {
        "claude-code": scriptedTransport(
          "claude-code",
          () => {
            controller.abort();
            return fail("rate_limit");
          },
          requests,
        ),
      },
      { signal: controller.signal },
    );
    try {
      const result = await runtime.runner.run(stepFor(route));
      expect(sent(requests)).toEqual(["claude-code:sonnet"]);
      expect(result.status).toBe("failed");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("auth_invalid skips the models on the same credential", () => {
  test("a Claude login failure skips every Claude model and runs the OpenCode one", async () => {
    const claudeRequests: TransportRequest[] = [];
    const openRequests: TransportRequest[] = [];
    const route = hunterRoute([
      "claude:sonnet-latest",
      "claude:opus-latest",
      "opencode:openai/gpt-4o",
    ]);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        () => fail("auth_invalid"),
        claudeRequests,
      ),
      opencode: scriptedTransport("opencode", () => ok(), openRequests),
    });
    try {
      const result = await runtime.runner.run(stepFor(route));
      expect(sent(claudeRequests)).toEqual(["claude-code:sonnet"]);
      expect(sent(openRequests)).toEqual(["opencode:gpt-4o"]);
      expect(result.status).toBe("ok");
      expect(
        result.modelAttempts?.map((a) => [
          a.route.modelSnapshot,
          a.status,
          a.attempts,
          a.cause,
        ]),
      ).toEqual([
        ["sonnet", "failed", 1, "auth_invalid"],
        ["opus", "skipped", 0, "auth_invalid"],
        ["gpt-4o", "ok", 1, undefined],
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  test("with no other credential left, the step fails on the login error", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterRoute(SONNET_THEN_OPUS);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        () => fail("auth_invalid"),
        requests,
      ),
    });
    try {
      const result = await runtime.runner.run(stepFor(route));
      expect(sent(requests)).toEqual(["claude-code:sonnet"]);
      expect(result.status).toBe("failed");
      expect(result.failureCause).toBe("auth_invalid");
      expect(result.modelAttempts?.map((a) => a.status)).toEqual([
        "failed",
        "skipped",
      ]);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("spend and usage across models", () => {
  test("each attempt reserves on its own model's binding, and usage stays per model", async () => {
    const claudeRequests: TransportRequest[] = [];
    const openRequests: TransportRequest[] = [];
    const route = hunterRoute([
      "claude:sonnet-latest",
      "opencode:openai/gpt-4o",
    ]);
    const runtime = await runtimeFor([route], {
      // A subscription Claude that is out of quota, then a metered OpenCode
      // model that answers: mixed billing in one step.
      "claude-code": scriptedTransport(
        "claude-code",
        () => fail("quota_exhausted"),
        claudeRequests,
      ),
      opencode: scriptedTransport(
        "opencode",
        () => ok(metered(0.25)),
        openRequests,
        { mode: "metered", pricingReady: true },
      ),
    });
    try {
      const result = await runtime.runner.run(stepFor(route));
      expect(result.status).toBe("ok");
      // Only the metered attempt reserves, as it would have alone.
      expect(result.reservations?.length).toBe(1);
      expect(result.reservations?.[0]?.attempt).toBe(2);
      expect(result.reservations?.[0]?.state).toBe("settled");
      // The step's total keeps the real cash, and each model keeps its own
      // billing, so the mix does not collapse into one wrong label.
      expect(result.usageV2?.cashCostUsd).toBe(0.25);
      expect(result.usage.cost_usd_est).toBe(0.25);
      expect(result.modelAttempts?.map((a) => a.usageV2?.billingMode)).toEqual([
        "subscription",
        "metered",
      ]);
      expect(result.modelAttempts?.[1]?.usageV2?.cashCostUsd).toBe(0.25);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("a list of one behaves exactly as before", () => {
  test("a provider failure ends the step, and nothing new is recorded", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterRoute(["claude:sonnet-latest"]);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        () => fail("rate_limit"),
        requests,
      ),
    });
    try {
      const step = stepFor(route);
      expect(step.fallbackRoutes).toBeUndefined();
      const result = await runtime.runner.run(step);
      expect(sent(requests)).toEqual(["claude-code:sonnet"]);
      expect(result.status).toBe("failed");
      expect(result.failureCause).toBe("rate_limit");
      expect(result.attempts).toBe(1);
      expect(result.modelAttempts).toBeUndefined();
      expect(requests[0]?.attempt).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("every model is admitted and bound before anything runs", () => {
  test("a fallback on a backend with no executable fails the runtime, before any request", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterRoute([
      "claude:sonnet-latest",
      "opencode:openai/gpt-4o",
    ]);
    const registry = new DefaultTransportRegistry();
    registry.register(
      "claude-code",
      scriptedTransport("claude-code", () => ok(), requests),
    );
    await expect(
      createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([route]),
        binaryPath: claude.canonicalPath,
        executableAllowlists: {
          "claude-code": [
            { absolutePath: claude.canonicalPath, sha256: claude.sha256 },
          ],
        },
        registry,
        mode: "conformance",
        credentialBrokers: {
          "claude-code": successfulClaudeCredentialBroker,
        },
      }),
    ).rejects.toThrow(/opencode/i);
    expect(requests).toHaveLength(0);
  });

  test("a binding is frozen for every candidate", async () => {
    const route = hunterRoute(["claude:sonnet-latest", "claude:opus-latest"]);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport("claude-code", () => ok(), []),
    });
    try {
      expect(runtime.bindings.has(route.routeFingerprint)).toBe(true);
      const fallback = route.fallbacks?.[0];
      expect(fallback).toBeDefined();
      expect(runtime.bindings.has(fallback?.routeFingerprint ?? "")).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  test("route admission refuses a fallback on a backend that is not registered", async () => {
    const route = hunterRoute([
      "claude:sonnet-latest",
      "opencode:openai/gpt-4o",
    ]);
    const registry = new DefaultTransportRegistry();
    registry.register(
      "claude-code",
      scriptedTransport("claude-code", () => ok(), []),
    );
    await expect(
      admitRoutePlan(createResolvedRoutePlan([route]), registry, {
        mode: "production",
      }),
    ).rejects.toThrow(/opencode/i);
  });

  // U4 (S9): this used to be refused at plan time ("one OpenCode credential per
  // run"). Each fallback now binds its own credential, so a refused login on one
  // provider moves to the other (test/opencode-multi-credential.test.ts).
  test("OpenCode fallbacks on two providers are two credentials, none refused", () => {
    const route = hunterRoute([
      "opencode:openai/gpt-4o",
      "opencode:zai/glm-4.6",
    ]);
    const credentials = planOpenCodeCredentials(
      createResolvedRoutePlan([route]),
      undefined,
    );
    expect(credentials).toEqual([
      { provider: "openai", kind: "opencode_chatgpt_oauth" },
      { provider: "zai", kind: "provider_api_token" },
    ]);
    expect(soleOpenCodeCredentialOf(credentials)).toBeUndefined();
  });
});

// S7 (E-g, E2): each model of a list runs at its own effort. The pipeline
// resolves them (`entry ?? frontmatter ?? role default`) into `effort` and
// `fallbackEfforts`; the runner used to copy the first model's effort into
// every candidate.
describe("each model runs at its own effort", () => {
  function hunterEntries(
    entries: NonNullable<ModelsConfig["hunter.reliability"]>,
  ): ResolvedStepRoute {
    return resolveStepRoute({
      stepKey: "hunter-reliability",
      role: "hunter",
      modelRole: "hunter.reliability",
      models: { "hunter.reliability": entries },
    });
  }

  test("a fallback is sent its own effort, not the first model's", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterEntries([
      { model: "claude:sonnet-latest", effort: "max" },
      { model: "claude:opus-latest", effort: "low" },
    ]);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        (request) =>
          request.route.modelSnapshot === "sonnet"
            ? fail("model_unavailable")
            : ok(),
        requests,
      ),
    });
    try {
      const result = await runtime.runner.run(
        stepFor(route, { effort: "max", fallbackEfforts: ["low"] }),
      );
      expect(result.status).toBe("ok");
      expect(requests.map((r) => [r.route.modelSnapshot, r.effort])).toEqual([
        ["sonnet", "max"],
        ["opus", "low"],
      ]);
      expect(result.modelAttempts?.map((a) => a.effort)).toEqual([
        "max",
        "low",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  test("a refused login still skips the other models on its credential, whatever their effort", async () => {
    const claudeRequests: TransportRequest[] = [];
    const openRequests: TransportRequest[] = [];
    const route = hunterEntries([
      { model: "claude:sonnet-latest", effort: "max" },
      { model: "claude:opus-latest", effort: "low" },
      "opencode:openai/gpt-4o",
    ]);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        () => fail("auth_invalid"),
        claudeRequests,
      ),
      opencode: scriptedTransport("opencode", () => ok(), openRequests),
    });
    try {
      const result = await runtime.runner.run(
        stepFor(route, { effort: "max", fallbackEfforts: ["low", "xhigh"] }),
      );
      expect(sent(claudeRequests)).toEqual(["claude-code:sonnet"]);
      expect(openRequests.map((r) => r.effort)).toEqual(["xhigh"]);
      expect(
        result.modelAttempts?.map((a) => [
          a.route.modelSnapshot,
          a.status,
          a.effort,
        ]),
      ).toEqual([
        ["sonnet", "failed", "max"],
        ["opus", "skipped", "low"],
        ["gpt-4o", "ok", "xhigh"],
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  test("a step built without fallbackEfforts keeps running every model at its effort", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterRoute(SONNET_THEN_OPUS);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        (request) =>
          request.route.modelSnapshot === "sonnet" ? fail("rate_limit") : ok(),
        requests,
      ),
    });
    try {
      await runtime.runner.run(stepFor(route, { effort: "medium" }));
      expect(requests.map((r) => r.effort)).toEqual(["medium", "medium"]);
    } finally {
      await runtime.dispose();
    }
  });
});
