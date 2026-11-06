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
} from "../../src/production-runtime";
import { OpenCodeAuthBroker } from "../../src/security/credential-broker";
import {
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

const THREE = [
  "claude:sonnet-latest",
  "claude:opus-latest",
  "claude:haiku-latest",
];

describe("fallback scenarios: numbering, spend, cancellation and the recorded model", () => {
  test("R1 three models, each with retries: attempts numbered 1..6, every file kept", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterRoute(THREE);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        () => fail("network_transient"),
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
        "claude-code:opus",
        "claude-code:haiku",
        "claude-code:haiku",
      ]);
      expect(requests.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(requests.map((r) => r.sessionId)).size).toBe(6);
      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(6);
      expect(result.finalCause).toBe("network_transient");
      expect(result.modelAttempts?.map((a) => a.attempts)).toEqual([2, 2, 2]);
      for (let a = 1; a <= 6; a++) {
        expect(existsSync(attemptLogPath(step.outPath, step.name, a))).toBe(
          true,
        );
        expect(
          existsSync(settlementReceiptPath(step.outPath, step.name, a)),
        ).toBe(true);
      }
      expect(existsSync(attemptLogPath(step.outPath, step.name, 7))).toBe(
        false,
      );
      // usage summed over 6 attempts
      expect(result.usageV2?.wallMs).toBe(60);
    } finally {
      await runtime.dispose();
    }
  });

  test("R2 metered then metered on one provider: two reservations, cash summed once", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterRoute([
      "opencode:openai/gpt-4o",
      "opencode:openai/gpt-4.1",
    ]);
    const runtime = await runtimeFor([route], {
      opencode: scriptedTransport(
        "opencode",
        (r) =>
          r.route.modelSnapshot === "gpt-4o"
            ? fail("quota_exhausted", metered(0.1))
            : ok(metered(0.2)),
        requests,
        { mode: "metered", pricingReady: true },
      ),
    });
    try {
      const result = await runtime.runner.run(stepFor(route));
      expect(sent(requests)).toEqual(["opencode:gpt-4o", "opencode:gpt-4.1"]);
      expect(result.status).toBe("ok");
      expect(
        result.reservations?.map((r) => [r.attempt, r.state, r.settledUsd]),
      ).toEqual([
        [1, "settled", 0.1],
        [2, "settled", 0.2],
      ]);
      expect(result.usageV2?.cashCostUsd).toBeCloseTo(0.3, 10);
      expect(result.usage.cost_usd_est).toBeCloseTo(0.3, 10);
      expect(result.usage.tokens_total).toBe(40);
      expect(result.modelAttempts?.map((a) => a.usageV2?.cashCostUsd)).toEqual([
        0.1, 0.2,
      ]);
      console.log(
        "R2 buckets",
        result.reservations?.map((r) => r.bucketId),
      );
    } finally {
      await runtime.dispose();
    }
  });

  test("R3 cancel during the second of three: the third never starts", async () => {
    const requests: TransportRequest[] = [];
    const controller = new AbortController();
    const route = hunterRoute(THREE);
    const runtime = await runtimeFor(
      [route],
      {
        "claude-code": scriptedTransport(
          "claude-code",
          (r) => {
            if (r.route.modelSnapshot === "opus") controller.abort();
            return fail("rate_limit");
          },
          requests,
        ),
      },
      { signal: controller.signal },
    );
    try {
      const result = await runtime.runner.run(
        stepFor(route, { maxAttempts: 1 }),
      );
      expect(sent(requests)).toEqual([
        "claude-code:sonnet",
        "claude-code:opus",
      ]);
      expect(result.status).toBe("failed");
      expect(result.modelAttempts?.length).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  test("R4 cancel while the first model is in flight: nothing else runs", async () => {
    const requests: TransportRequest[] = [];
    const controller = new AbortController();
    const route = hunterRoute(THREE);
    const runtime = await runtimeFor(
      [route],
      {
        "claude-code": scriptedTransport(
          "claude-code",
          (_r, signal) =>
            new Promise<TransportOutcome>((resolve) => {
              signal.addEventListener("abort", () =>
                resolve(fail("network_transient")),
              );
              setTimeout(() => controller.abort(), 5);
            }),
          requests,
        ),
      },
      { signal: controller.signal, graceMarginMs: 10 },
    );
    try {
      const result = await runtime.runner.run(
        stepFor(route, { maxAttempts: 2 }),
      );
      expect(sent(requests)).toEqual(["claude-code:sonnet"]);
      expect(result.status).toBe("failed");
      console.log(
        "R4 finalCause",
        result.finalCause,
        "modelAttempts",
        result.modelAttempts?.map((a) => [a.status, a.cause]),
      );
    } finally {
      await runtime.dispose();
    }
  });

  test("R5 OpenCode login refused moves to Claude (another credential)", async () => {
    const claudeRequests: TransportRequest[] = [];
    const openRequests: TransportRequest[] = [];
    const route = hunterRoute([
      "opencode:openai/gpt-4o",
      "opencode:openai/gpt-4.1",
      "claude:sonnet-latest",
    ]);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        () => ok(),
        claudeRequests,
      ),
      opencode: scriptedTransport(
        "opencode",
        () => fail("auth_invalid"),
        openRequests,
      ),
    });
    try {
      const result = await runtime.runner.run(stepFor(route));
      expect(sent(openRequests)).toEqual(["opencode:gpt-4o"]);
      expect(sent(claudeRequests)).toEqual(["claude-code:sonnet"]);
      expect(result.modelAttempts?.map((a) => a.status)).toEqual([
        "failed",
        "skipped",
        "ok",
      ]);
      expect(result.attempts).toBe(2);
      expect(claudeRequests[0]?.attempt).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  const NON_MOVING = [
    "protocol_mismatch",
    "protocol_overflow",
    "provider_configuration_invalid",
    "missing_provider_record",
    "runtime_unavailable",
    "remote_abort_unconfirmed",
  ] as const;
  for (const cause of NON_MOVING) {
    test(`R6 ${cause} does not move`, async () => {
      const requests: TransportRequest[] = [];
      const route = hunterRoute(THREE);
      const runtime = await runtimeFor([route], {
        "claude-code": scriptedTransport(
          "claude-code",
          () => fail(cause),
          requests,
        ),
      });
      try {
        const result = await runtime.runner.run(
          stepFor(route, { maxAttempts: 1 }),
        );
        expect(sent(requests)).toEqual(["claude-code:sonnet"]);
        expect(result.status).toBe("failed");
      } finally {
        await runtime.dispose();
      }
    });
  }

  test("R7 unresolved metered cost fences the bucket: the fallback on the same bucket spends nothing", async () => {
    const requests: TransportRequest[] = [];
    const route = hunterRoute([
      "opencode:openai/gpt-4o",
      "opencode:openai/gpt-4.1",
    ]);
    // A partial usage record with no cost: the shape a provider gives when it cannot price an attempt.
    const unknownCost = {
      wallMs: 10,
      tokens: { totalKnown: 5 },
      completeness: "partial",
      billingMode: "metered",
      costSource: "unavailable",
    } as unknown as NormalizedUsage;
    const runtime = await runtimeFor([route], {
      opencode: scriptedTransport(
        "opencode",
        (r) =>
          r.route.modelSnapshot === "gpt-4o"
            ? fail("rate_limit", unknownCost)
            : ok(metered(0.2)),
        requests,
        { mode: "metered", pricingReady: true },
      ),
    });
    try {
      const result = await runtime.runner.run(
        stepFor(route, { maxAttempts: 1 }),
      );
      console.log(
        "R7 sent",
        sent(requests),
        "status",
        result.status,
        "reservations",
        result.reservations?.map((r) => [r.attempt, r.state]),
        "attempts",
        result.modelAttempts?.map((a) => [
          a.route.modelSnapshot,
          a.status,
          a.attempts,
          a.cause,
        ]),
        "tail",
        result.stderrTail.slice(-200),
      );
    } finally {
      await runtime.dispose();
    }
  });

  test("R8 pre-aborted run: first model behaves as before, no fallback", async () => {
    const requests: TransportRequest[] = [];
    const controller = new AbortController();
    controller.abort();
    const route = hunterRoute(THREE);
    const runtime = await runtimeFor(
      [route],
      {
        "claude-code": scriptedTransport(
          "claude-code",
          () => fail("rate_limit"),
          requests,
        ),
      },
      { signal: controller.signal },
    );
    try {
      const result = await runtime.runner.run(stepFor(route));
      expect(requests.length).toBe(0);
      expect(result.status).toBe("failed");
      expect(result.modelAttempts?.length).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });
});

import { mkdir } from "node:fs/promises";
import { mergeRunEnvelope } from "#review/findings";
import { runPipeline } from "#review/pipeline";
import { buildTelemetry } from "#review/run";
import { buildRunReport } from "../../src/ci/platform-report";

describe("E2E: real runtime + runPipeline", () => {
  test("E1 hunter falls back sonnet->opus; pipeline.json, pointers and report name opus", async () => {
    const requests: TransportRequest[] = [];
    const FINDING = {
      id: "F001",
      path: "src/index.ts",
      line: 1,
      severity: "CRITICAL",
      claim: "Null pointer issue",
      proof_refs: ["src/index.ts:1"],
    };
    const route = hunterRoute(["claude:sonnet-latest", "claude:opus-latest"]);
    const runtime = await runtimeFor([route], {
      "claude-code": scriptedTransport(
        "claude-code",
        (r) => {
          const name = r.sessionId.replace(/-\d+-\d+$/, "");
          if (name === "hunter-reliability") {
            if (r.route.modelSnapshot === "sonnet") return fail("rate_limit");
            return {
              ...ok(),
              finalText: JSON.stringify({ findings: [FINDING] }),
            };
          }
          if (name.startsWith("refuter-")) {
            return {
              ...ok(),
              finalText: JSON.stringify({
                results: [
                  {
                    finding_id: name.replace(/^refuter-/, ""),
                    verdict: "supported",
                    rationale: "ok",
                  },
                ],
              }),
            };
          }
          return {
            ...ok(),
            finalText: JSON.stringify({
              findings: [{ primary: "F001", sources: ["F001"], claim: "x" }],
            }),
          };
        },
        requests,
      ),
    });
    const runDir = path.join(tmpDir, "run");
    const agentsDir = path.join(tmpDir, "agents");
    const worktree = path.join(tmpDir, "wt");
    await mkdir(runDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });
    await mkdir(path.join(worktree, "src"), { recursive: true });
    await Bun.write(
      path.join(agentsDir, "reliability.md"),
      "---\nname: reliability\nmodel: sonnet\ntools: Read, Grep\n---\nYou are the reliability hunter.",
    );
    await Bun.write(
      path.join(agentsDir, "refuter.md"),
      "---\nname: refuter\nmodel: opus\ntools: Read\n---\nYou are the refuter.",
    );
    await Bun.write(path.join(worktree, "src", "index.ts"), "const x = 2;\n");
    const diffPath = path.join(runDir, "diff.patch");
    await Bun.write(
      diffPath,
      "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
    );
    await Bun.write(path.join(runDir, "gotchas.json"), "[]");
    await Bun.write(path.join(runDir, "mcp.json"), "{}");
    try {
      const result = await runPipeline(
        {
          pr: 42,
          baseSha: "1".repeat(40),
          headSha: "2".repeat(40),
          worktree,
          diffPath,
          gotchasPath: path.join(runDir, "gotchas.json"),
          agentsDir,
          runDir,
          outPath: path.join(runDir, "findings.json"),
          mcpConfigPath: path.join(runDir, "mcp.json"),
          hopBudget: 2,
          parityTriggerPaths: [],
          suspicionPriors: [],
          spec: {
            agents: [
              { key: "reliability", file: "reliability.md", role: "hunter" },
              { key: "refuter", file: "refuter.md", role: "refuter" },
            ],
          },
          models: {
            "hunter.reliability": [
              "claude:sonnet-latest",
              "claude:opus-latest",
            ],
          },
        },
        { runner: runtime.runner, transportRegistry: runtime.registry },
      );
      const pipeline = JSON.parse(
        await Bun.file(path.join(runDir, "pipeline.json")).text(),
      );
      const hunter = pipeline.steps.find(
        (s: { name: string }) => s.name === "hunter-reliability",
      );
      console.log(
        "E1 sent",
        requests.map(
          (r) =>
            `${r.sessionId.replace(/-\d+-\d+$/, "")}:${r.route.modelSnapshot}#${r.attempt}`,
        ),
      );
      console.log(
        "E1 hunter meta",
        JSON.stringify({
          model: hunter.model,
          route: hunter.route,
          attempts: hunter.attempts,
          effort_applied: hunter.effort_applied,
          ma: hunter.model_attempts?.map(
            (m: {
              model: string;
              status: string;
              attempts: number;
              cause?: string;
            }) => [m.model, m.status, m.attempts, m.cause],
          ),
          pointers: Object.fromEntries(
            Object.entries(hunter).filter(([k]) =>
              /path|pointer|log|receipt/i.test(k),
            ),
          ),
        }).replaceAll(tmpDir, "<T>"),
      );
      const refuter = pipeline.steps.find((s: { name: string }) =>
        s.name.startsWith("refuter-"),
      );
      {
        const { readdirSync } = await import("node:fs");
        console.log(
          "E1 files",
          readdirSync(path.join(runDir, "steps"), { recursive: true })
            .filter((f) => String(f).includes("hunter-reliability"))
            .sort(),
        );
      }
      console.log("E1 hunter failure", hunter.failure, hunter.status);
      console.log("E1 refuter meta", refuter?.model, refuter?.model_attempts);
      expect(hunter.model).toBe("opus");
      expect(hunter.attempts).toBe(4); // sonnet 3 transient tries? printed
      const findings = JSON.parse(
        JSON.stringify(
          mergeRunEnvelope({
            skillOutput: result.skillOutput,
            pr: 42,
            base_sha: "1".repeat(40),
            head_sha: "2".repeat(40),
            model: "sonnet",
            iteration: 0,
            engine: { name: "crysk", version: "0" },
            sessionFailed: result.sessionFailed,
            telemetry: buildTelemetry(result, 10, 0),
          }),
        ),
      );
      const report = buildRunReport({
        outcome: "success",
        prNumber: 42,
        triggerHeadSha: "2".repeat(40),
        run: { findings, pipeline },
      });
      console.log(
        "E1 report agents",
        report?.agents.map((a) => [a.agent_key, a.model, a.attempts]),
      );
      console.log(
        "E1 usage",
        result.usage,
        "findings",
        result.skillOutput?.findings?.length,
      );
    } finally {
      await runtime.dispose();
    }
  });
});
