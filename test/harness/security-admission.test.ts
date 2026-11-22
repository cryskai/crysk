import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutableAllowlistEntry } from "#model/provider-capabilities";
import { ClaudeCodeRunner, type StepSpec } from "#review/step-runner";
import type {
  ProviderTransport,
  StepAdmissionGate,
  TransportRequest,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";

describe("Security authorization and admission ordering", () => {
  let rootDir: string;
  let outsideDir: string;
  let binDir: string;
  let claudeBinaryPath: string;
  let binarySha256: string;
  let allowlist: ExecutableAllowlistEntry[];

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "pr-hero-adm-root-"));
    outsideDir = await mkdtemp(path.join(tmpdir(), "pr-hero-adm-outside-"));
    binDir = await mkdtemp(path.join(tmpdir(), "pr-hero-adm-bin-"));

    rootDir = await realpath(rootDir);
    outsideDir = await realpath(outsideDir);
    binDir = await realpath(binDir);

    claudeBinaryPath = path.join(binDir, "claude");
    const bytes = Buffer.from(
      '#!/bin/sh\necho \'{"result":"{\\"findings\\":[]}"}\'\n',
    );
    await writeFile(claudeBinaryPath, bytes);
    await chmod(claudeBinaryPath, 0o755);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    binarySha256 = hasher.digest("hex");

    allowlist = [
      {
        absolutePath: claudeBinaryPath,
        sha256: binarySha256,
      },
    ];
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    await rm(binDir, { recursive: true, force: true }).catch(() => {});
  });

  test("workspace denial produces zero admission, transport, or spawn calls and preserves typed path_not_approved", async () => {
    const trace: string[] = [];
    let admissionCount = 0;
    let transportCount = 0;
    let spawnCount = 0;

    const admissionGate: StepAdmissionGate = {
      admit: async (spec) => {
        admissionCount++;
        trace.push(`admission:${spec.name}`);
      },
    };

    const fakeSpawn = (() => {
      spawnCount++;
      return {
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const transport: ProviderTransport = {
      backend: "claude-code",
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
        cancellation: { deadlineMs: 7500, conformance: "passed" },
        billing: { mode: "subscription", pricingReady: true },
        issues: [],
      }),
      execute: async (req) => {
        transportCount++;
        trace.push(`transport:${req.sessionId}`);
        return {
          completion: "success",
          protocolIntegrity: "verified",
          finalText: '{"findings":[]}',
          usage: {
            wallMs: 10,
            tokens: { inputUncached: 10 },
            completeness: "complete" as const,
            billingMode: "subscription" as const,
            costSource: "provider" as const,
            cashCostUsd: 0,
          },
          stderrTail: "",
        };
      },
      classifyFailure: () => undefined,
    };

    const harness = new StepExecutionHarness({
      workspaceRoot: rootDir,
      executableAllowlist: allowlist,
      binaryPath: claudeBinaryPath,
      admissionGate,
      transport,
      spawnFn: fakeSpawn,
      onAuthEvent: (event) => trace.push(`auth:${event.kind}:${event.status}`),
    });

    const escapingStep: StepSpec = {
      name: "hunter-reliability",
      systemPromptPath: path.join(rootDir, "prompt.md"),
      prompt: "Review diff",
      tools: ["Read"],
      mcpConfigPath: path.join(rootDir, "mcp.json"),
      model: "claude-sonnet-4-5",
      effort: "high",
      cwd: path.join(rootDir, "..", path.basename(outsideDir)),
      outPath: path.join(rootDir, "out.json"),
      timeoutMs: 5000,
      maxAttempts: 2,
      parse: (text) => JSON.parse(text),
    };

    await writeFile(escapingStep.systemPromptPath, "system prompt");
    await writeFile(escapingStep.mcpConfigPath, "{}");

    const result = await harness.run(escapingStep);

    expect(result.status).toBe("failed");
    expect(result.denialCode).toBe("path_not_approved");
    expect(admissionCount).toBe(0);
    expect(transportCount).toBe(0);
    expect(spawnCount).toBe(0);
    expect(trace).toContain("auth:workspace:denied");
    expect(trace.filter((e) => e.startsWith("admission:"))).toHaveLength(0);
    expect(trace.filter((e) => e.startsWith("transport:"))).toHaveLength(0);
  });

  test("executable denial produces zero admission, transport, or spawn calls and preserves typed executable_not_approved", async () => {
    const trace: string[] = [];
    let admissionCount = 0;
    let transportCount = 0;
    let spawnCount = 0;

    const admissionGate: StepAdmissionGate = {
      admit: async (spec) => {
        admissionCount++;
        trace.push(`admission:${spec.name}`);
      },
    };

    const fakeSpawn = (() => {
      spawnCount++;
      return {
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const transport: ProviderTransport = {
      backend: "claude-code",
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
        cancellation: { deadlineMs: 7500, conformance: "passed" },
        billing: { mode: "subscription", pricingReady: true },
        issues: [],
      }),
      execute: async (req) => {
        transportCount++;
        trace.push(`transport:${req.sessionId}`);
        return {
          completion: "success",
          protocolIntegrity: "verified",
          finalText: '{"findings":[]}',
          usage: {
            wallMs: 10,
            tokens: { inputUncached: 10 },
            completeness: "complete" as const,
            billingMode: "subscription" as const,
            costSource: "provider" as const,
            cashCostUsd: 0,
          },
          stderrTail: "",
        };
      },
      classifyFailure: () => undefined,
    };

    const harness = new StepExecutionHarness({
      workspaceRoot: rootDir,
      executableAllowlist: allowlist,
      binaryPath: "/unapproved/bin/claude",
      admissionGate,
      transport,
      spawnFn: fakeSpawn,
      onAuthEvent: (event) => trace.push(`auth:${event.kind}:${event.status}`),
    });

    const step: StepSpec = {
      name: "hunter-reliability",
      systemPromptPath: path.join(rootDir, "prompt.md"),
      prompt: "Review diff",
      tools: ["Read"],
      mcpConfigPath: path.join(rootDir, "mcp.json"),
      model: "claude-sonnet-4-5",
      effort: "high",
      cwd: rootDir,
      outPath: path.join(rootDir, "out.json"),
      timeoutMs: 5000,
      maxAttempts: 2,
      parse: (text) => JSON.parse(text),
    };

    await writeFile(step.systemPromptPath, "system prompt");
    await writeFile(step.mcpConfigPath, "{}");

    const result = await harness.run(step);

    expect(result.status).toBe("failed");
    expect(result.denialCode).toBe("executable_not_approved");
    expect(admissionCount).toBe(0);
    expect(transportCount).toBe(0);
    expect(spawnCount).toBe(0);
    expect(trace).toContain("auth:executable:denied");
    expect(trace.filter((e) => e.startsWith("admission:"))).toHaveLength(0);
    expect(trace.filter((e) => e.startsWith("transport:"))).toHaveLength(0);
  });

  test("valid authorization occurs before admission, admission occurs once, transport receives verified identities and executes once", async () => {
    const trace: string[] = [];
    let admissionCount = 0;
    let transportCount = 0;
    let receivedRequest: TransportRequest | undefined;

    const admissionGate: StepAdmissionGate = {
      admit: async () => {
        admissionCount++;
        trace.push("admission:admit");
      },
    };

    const transport: ProviderTransport = {
      backend: "claude-code",
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
        cancellation: { deadlineMs: 7500, conformance: "passed" },
        billing: { mode: "subscription", pricingReady: true },
        issues: [],
      }),
      execute: async (req) => {
        transportCount++;
        receivedRequest = req;
        trace.push("transport:execute");
        return {
          completion: "success",
          protocolIntegrity: "verified",
          finalText: JSON.stringify({ findings: [{ id: "F001" }] }),
          usage: {
            wallMs: 25,
            tokens: { inputUncached: 100, outputVisible: 20 },
            completeness: "complete" as const,
            billingMode: "subscription" as const,
            costSource: "provider" as const,
            cashCostUsd: 0.01,
          },
          stderrTail: "",
        };
      },
      classifyFailure: () => undefined,
    };

    const harness = new StepExecutionHarness({
      workspaceRoot: rootDir,
      executableAllowlist: allowlist,
      binaryPath: claudeBinaryPath,
      admissionGate,
      transport,
      onAuthEvent: (event) => trace.push(`auth:${event.kind}:${event.status}`),
    });

    const step: StepSpec = {
      name: "hunter-reliability",
      systemPromptPath: path.join(rootDir, "prompt.md"),
      prompt: "Review diff",
      tools: ["Read", "Grep"],
      mcpConfigPath: path.join(rootDir, "mcp.json"),
      model: "claude-sonnet-4-5",
      effort: "high",
      cwd: path.join(rootDir, "src", ".."),
      outPath: path.join(rootDir, "out.json"),
      timeoutMs: 5000,
      maxAttempts: 2,
      parse: (text) => JSON.parse(text),
    };

    await writeFile(step.systemPromptPath, "system prompt");
    await writeFile(step.mcpConfigPath, "{}");

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(admissionCount).toBe(1);
    expect(transportCount).toBe(1);

    const authWsIdx = trace.indexOf("auth:workspace:approved");
    const authExecIdx = trace.indexOf("auth:executable:approved");
    const admissionIdx = trace.indexOf("admission:admit");
    const transportIdx = trace.indexOf("transport:execute");

    expect(authWsIdx).toBeGreaterThanOrEqual(0);
    expect(authExecIdx).toBeGreaterThanOrEqual(0);
    expect(admissionIdx).toBeGreaterThan(Math.max(authWsIdx, authExecIdx));
    expect(transportIdx).toBeGreaterThan(admissionIdx);

    expect(receivedRequest).toBeDefined();
    // The transport must see the broker-canonicalized cwd, not the raw alias.
    expect(receivedRequest?.cwd).toBe(rootDir);
    expect(receivedRequest?.isolation.verifiedBinaryPath).toBeDefined();
    expect(
      receivedRequest?.isolation.verifiedBinaryPath.length,
    ).toBeGreaterThan(0);
    // The hash the executable authority verified travels with the path, so the
    // attempt evidence never has to read the binary again.
    expect(receivedRequest?.isolation.verifiedBinarySha256).toBe(binarySha256);
  });

  test("transport request receives the canonicalized path when step.cwd traverses a symlinked subdir", async () => {
    let receivedCwd: string | undefined;

    const realSubdir = path.join(rootDir, "real-subdir");
    await mkdir(realSubdir, { recursive: true });
    const linkPath = path.join(rootDir, "link-subdir");
    await symlink(realSubdir, linkPath);

    const transport: ProviderTransport = {
      backend: "claude-code",
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
        cancellation: { deadlineMs: 7500, conformance: "passed" },
        billing: { mode: "subscription", pricingReady: true },
        issues: [],
      }),
      execute: async (req) => {
        receivedCwd = req.cwd;
        return {
          completion: "success",
          protocolIntegrity: "verified",
          finalText: '{"findings":[]}',
          usage: {
            wallMs: 10,
            tokens: {},
            completeness: "complete" as const,
            billingMode: "subscription" as const,
            costSource: "provider" as const,
            cashCostUsd: 0,
          },
          stderrTail: "",
        };
      },
      classifyFailure: () => undefined,
    };

    const harness = new StepExecutionHarness({
      workspaceRoot: rootDir,
      executableAllowlist: allowlist,
      binaryPath: claudeBinaryPath,
      transport,
    });

    const step: StepSpec = {
      name: "hunter-reliability",
      systemPromptPath: path.join(rootDir, "prompt.md"),
      prompt: "Review diff",
      tools: ["Read"],
      mcpConfigPath: path.join(rootDir, "mcp.json"),
      model: "claude-sonnet-4-5",
      effort: "high",
      cwd: linkPath,
      outPath: path.join(rootDir, "out.json"),
      timeoutMs: 5000,
      maxAttempts: 2,
      parse: (text) => JSON.parse(text),
    };

    await writeFile(step.systemPromptPath, "system prompt");
    await writeFile(step.mcpConfigPath, "{}");

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(receivedCwd).toBe(await realpath(realSubdir));
  });

  test("production ClaudeCodeRunner facade enforces harness authorization and fails closed on unapproved workspace", async () => {
    let spawnCalls = 0;
    const fakeSpawn = (() => {
      spawnCalls++;
      return {
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const runner = new ClaudeCodeRunner({
      workspaceRoot: rootDir,
      spawnFn: fakeSpawn,
    });

    const escapingStep: StepSpec = {
      name: "hunter-reliability",
      systemPromptPath: path.join(rootDir, "prompt.md"),
      prompt: "Review diff",
      tools: ["Read"],
      mcpConfigPath: path.join(rootDir, "mcp.json"),
      model: "claude-sonnet-4-5",
      effort: "high",
      cwd: path.join(rootDir, "..", path.basename(outsideDir)),
      outPath: path.join(rootDir, "out.json"),
      timeoutMs: 5000,
      maxAttempts: 2,
      parse: (text) => JSON.parse(text),
    };

    await writeFile(escapingStep.systemPromptPath, "prompt");
    await writeFile(escapingStep.mcpConfigPath, "{}");

    const result = await runner.run(escapingStep);

    expect(result.status).toBe("failed");
    expect(result.denialCode).toBe("path_not_approved");
    expect(spawnCalls).toBe(0);
  });
});
