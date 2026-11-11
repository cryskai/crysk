import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StepSpec } from "#review/step-runner";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
  ResolvedModelRoute,
  RunnerBackend,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import { DefaultTransportRegistry } from "../../src/transport-registry";

function createRecordingTransport(
  backend: RunnerBackend,
  requests: TransportRequest[],
): ProviderTransport {
  return {
    backend,
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
      cancellation: {
        deadlineMs: 5000,
        conformance: "passed",
      },
      billing: {
        mode: "subscription",
        pricingReady: true,
      },
      issues: [],
    }),
    execute: async (request: TransportRequest): Promise<TransportOutcome> => {
      requests.push(request);
      return {
        completion: "success",
        protocolIntegrity: "verified",
        finalText: '{"findings":[]}',
        usage: {
          wallMs: 50,
          tokens: { totalKnown: 5 },
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

describe("Task 2.1 RED: Harness Route Integration", () => {
  let tmpDir: string;
  let sysPromptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-route-test-"));
    tmpDir = await realpath(tmpDir);
    sysPromptPath = path.join(tmpDir, "system.md");
    await writeFile(sysPromptPath, "system prompt");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("harness consumes StepSpec.route directly and passes exact route to TransportRequest", async () => {
    const recordedRequests: TransportRequest[] = [];
    const transport = createRecordingTransport("claude-code", recordedRequests);

    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
    });

    const customRoute: ResolvedModelRoute = {
      backend: "claude-code",
      provider: "anthropic",
      modelFamily: "sonnet",
      modelSnapshot: "claude-sonnet-5-20250219",
      modelVariant: "thinking",
    };

    const spec: StepSpec = {
      name: "hunter-reliability",
      systemPromptPath: sysPromptPath,
      prompt: "review diff",
      tools: [],
      mcpConfigPath: path.join(tmpDir, "mcp.json"),
      model: "sonnet",
      effort: "high",
      cwd: tmpDir,
      outPath: path.join(tmpDir, "out.json"),
      timeoutMs: 10000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
      route: customRoute,
    };

    const result = await harness.run(spec);
    expect(result.status).toBe("ok");
    expect(recordedRequests).toHaveLength(1);
    expect(recordedRequests[0].route).toEqual(customRoute);
    expect(recordedRequests[0].route.modelVariant).toBe("thinking");
    expect(recordedRequests[0].route.modelSnapshot).toBe(
      "claude-sonnet-5-20250219",
    );
  });

  test("harness selects transport from TransportRegistry based on StepSpec.route.backend", async () => {
    const claudeRequests: TransportRequest[] = [];
    const opencodeRequests: TransportRequest[] = [];

    const registry = new DefaultTransportRegistry();
    registry.register(
      "claude-code",
      createRecordingTransport("claude-code", claudeRequests),
    );
    registry.register(
      "opencode",
      createRecordingTransport("opencode", opencodeRequests),
    );

    const harness = new StepExecutionHarness({
      registry,
      spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
    });

    const claudeSpec: StepSpec = {
      name: "hunter-reliability",
      systemPromptPath: sysPromptPath,
      prompt: "review diff 1",
      tools: [],
      mcpConfigPath: path.join(tmpDir, "mcp.json"),
      model: "sonnet",
      effort: "high",
      cwd: tmpDir,
      outPath: path.join(tmpDir, "out-1.json"),
      timeoutMs: 10000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
      route: {
        backend: "claude-code",
        provider: "anthropic",
        modelFamily: "sonnet",
        modelSnapshot: "sonnet",
      },
    };

    const opencodeSpec: StepSpec = {
      name: "refuter",
      systemPromptPath: sysPromptPath,
      prompt: "refute findings",
      tools: [],
      mcpConfigPath: path.join(tmpDir, "mcp.json"),
      model: "gpt-4o",
      effort: "high",
      cwd: tmpDir,
      outPath: path.join(tmpDir, "out-2.json"),
      timeoutMs: 10000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
      route: {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
      },
    };

    const res1 = await harness.run(claudeSpec);
    expect(res1.status).toBe("ok");
    expect(claudeRequests).toHaveLength(1);
    expect(claudeRequests[0].route.backend).toBe("claude-code");

    const res2 = await harness.run(opencodeSpec);
    expect(res2.status).toBe("ok");
    expect(opencodeRequests).toHaveLength(1);
    expect(opencodeRequests[0].route.backend).toBe("opencode");
  });

  test("zero reservations / zero spawns on route admission failure", async () => {
    const recordedRequests: TransportRequest[] = [];
    const registry = new DefaultTransportRegistry();
    registry.register(
      "claude-code",
      createRecordingTransport("claude-code", recordedRequests),
    );

    const harness = new StepExecutionHarness({
      registry,
      spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
    });

    const invalidSpec: StepSpec = {
      name: "unsupported-step",
      systemPromptPath: sysPromptPath,
      prompt: "review diff",
      tools: [],
      mcpConfigPath: path.join(tmpDir, "mcp.json"),
      model: "unsupported-model",
      effort: "high",
      cwd: tmpDir,
      outPath: path.join(tmpDir, "out.json"),
      timeoutMs: 10000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
      route: {
        backend: "codex" as RunnerBackend,
        provider: "openai",
        modelFamily: "codex",
        modelSnapshot: "codex",
      },
    };

    const result = await harness.run(invalidSpec);
    expect(result.status).toBe("failed");
    expect(recordedRequests).toHaveLength(0);
    expect(result.reservations ?? []).toHaveLength(0);
    expect(result.attempts).toBe(0);
  });

  test("harness without registry fails step when step.route is not claude-code", async () => {
    const recordedRequests: TransportRequest[] = [];
    const transport = createRecordingTransport("claude-code", recordedRequests);

    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
    });

    const opencodeSpec: StepSpec = {
      name: "opencode-step",
      systemPromptPath: sysPromptPath,
      prompt: "review diff",
      tools: [],
      mcpConfigPath: path.join(tmpDir, "mcp.json"),
      model: "openai/gpt-4o",
      effort: "high",
      cwd: tmpDir,
      outPath: path.join(tmpDir, "out.json"),
      timeoutMs: 10000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
      route: {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
      },
    };

    const result = await harness.run(opencodeSpec);
    expect(result.status).toBe("failed");
    expect(result.stderrTail).toContain(
      'No transport registry configured to handle backend "opencode"',
    );
    expect(recordedRequests).toHaveLength(0);
  });

  test("harness without registry fails step when step.backend is opencode (without step.route)", async () => {
    const recordedRequests: TransportRequest[] = [];
    const transport = createRecordingTransport("claude-code", recordedRequests);

    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
    });

    const opencodeSpec: StepSpec = {
      name: "opencode-legacy-step",
      systemPromptPath: sysPromptPath,
      prompt: "review diff",
      tools: [],
      mcpConfigPath: path.join(tmpDir, "mcp.json"),
      model: "sonnet",
      effort: "high",
      backend: "opencode",
      cwd: tmpDir,
      outPath: path.join(tmpDir, "out.json"),
      timeoutMs: 10000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
    };

    const result = await harness.run(opencodeSpec);
    expect(result.status).toBe("failed");
    expect(result.stderrTail).toContain(
      'No transport registry configured to handle backend "opencode"',
    );
    expect(recordedRequests).toHaveLength(0);
  });
});
