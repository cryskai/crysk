import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderTransport,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  MAX_SYSTEM_PROMPT_BYTES,
  StepExecutionHarness,
} from "../../src/execution/harness";
import type { ClaudeCodeCliTransportOptions } from "../../src/transports/claude-code-cli";
import { ClaudeCodeCliTransport } from "../../src/transports/claude-code-cli";

function makeRequest(
  overrides: Partial<TransportRequest> = {},
): TransportRequest {
  return {
    sessionId: "sess-1",
    attempt: 1,
    route: {
      backend: "claude-code",
      provider: "anthropic",
      modelFamily: "claude",
      modelSnapshot: "claude-test-model",
    },
    executionModel: "claude-test-model",
    effort: "high",
    systemPromptPath: "/tmp/pr-hero-prompt-integrity/system.md",
    systemPromptSha256: "deadbeef",
    userPrompt: "review this",
    cwd: "/tmp/pr-hero-prompt-integrity",
    tools: ["Read"],
    isolation: {
      credentialProjectionId: "proj-1",
      env: {},
      syntheticHome: "/tmp/pr-hero-prompt-integrity/home",
      syntheticConfigHome: "/tmp/pr-hero-prompt-integrity/config",
      syntheticTmp: "/tmp/pr-hero-prompt-integrity/tmp",
      verifiedBinaryPath: "/usr/bin/true",
    },
    ...overrides,
  };
}

const zeroUsage: TransportOutcome["usage"] = {
  wallMs: 0,
  tokens: {},
  completeness: "complete",
  billingMode: "subscription",
};

describe("§6.3 prompt integrity: transport pre-spawn verification", () => {
  let spawnCount: number;

  const makeTransport = (
    fns: Pick<ClaudeCodeCliTransportOptions, "promptLstatFn" | "promptHashFn">,
  ): ClaudeCodeCliTransport => {
    spawnCount = 0;
    return new ClaudeCodeCliTransport({
      ...fns,
      spawnFn: (() => {
        spawnCount++;
        return {
          pid: 424242,
          stdout: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(JSON.stringify({ result: "ok" })),
              );
              c.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
          exited: Promise.resolve(0),
          kill() {},
        };
      }) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
    });
  };

  beforeEach(() => {
    spawnCount = 0;
  });

  test("symlinked system prompt is denied before any spawn", async () => {
    const transport = makeTransport({
      promptLstatFn: () => ({ mode: 0o100600, isSymbolicLink: true }),
      promptHashFn: () => "deadbeef",
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.stderrTail).toContain("symlink");
    expect(outcome.stderrTail).toContain("no spawn");
    expect(spawnCount).toBe(0);
  });

  test("wrong-mode system prompt is denied with the observed mode", async () => {
    const transport = makeTransport({
      promptLstatFn: () => ({ mode: 0o100644, isSymbolicLink: false }),
      promptHashFn: () => "deadbeef",
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.stderrTail).toContain("expected 600");
    expect(outcome.stderrTail).toContain("644");
    expect(spawnCount).toBe(0);
  });

  test("tampered prompt content fails hash comparison before any spawn", async () => {
    const transport = makeTransport({
      promptLstatFn: () => ({ mode: 0o100600, isSymbolicLink: false }),
      promptHashFn: () =>
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.stderrTail).toContain("hash mismatch");
    expect(spawnCount).toBe(0);
  });

  test("unreadable system prompt is denied before any spawn", async () => {
    const transport = makeTransport({
      promptLstatFn: () => undefined,
      promptHashFn: () => "deadbeef",
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.stderrTail).toContain("unreadable");
    expect(spawnCount).toBe(0);
  });

  test("verified 0600 regular file with matching hash reaches spawn", async () => {
    const transport = makeTransport({
      promptLstatFn: () => ({ mode: 0o100600, isSymbolicLink: false }),
      promptHashFn: () => "deadbeef",
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.completion).toBe("success");
    expect(spawnCount).toBe(1);
  });
});

describe("§6.3 prompt integrity: harness bounds and hash pinning", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "pr-hero-prompt-harness-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const fakeTransport = (requests: TransportRequest[]): ProviderTransport => ({
    backend: "claude-code",
    capabilities: async () => {
      throw new Error("not used");
    },
    execute: async (request) => {
      requests.push(request);
      return {
        completion: "success",
        protocolIntegrity: "verified",
        finalText: '{"findings":[]}',
        usage: zeroUsage,
        stderrTail: "",
      } satisfies TransportOutcome;
    },
    classifyFailure: () => undefined,
  });

  const harnessWith = (requests: TransportRequest[]): StepExecutionHarness =>
    new StepExecutionHarness({
      transport: fakeTransport(requests),
      spawnFn: (() => {
        throw new Error("spawn must never be reached in this test");
      }) as unknown as typeof Bun.spawn,
    });

  test("oversized system prompt fails the step with zero attempts and zero transport calls", async () => {
    const promptPath = path.join(tempDir, "big.system.md");
    await writeFile(promptPath, "x".repeat(MAX_SYSTEM_PROMPT_BYTES + 1));
    const requests: TransportRequest[] = [];
    const harness = harnessWith(requests);

    const result = await harness.run({
      name: "hunter-oversized",
      systemPromptPath: promptPath,
      prompt: "p",
      tools: [],
      model: "sonnet",
      effort: "high",
      cwd: tempDir,
      outPath: path.join(tempDir, "out.json"),
      mcpConfigPath: path.join(tempDir, "mcp.json"),
      timeoutMs: 1000,
      maxAttempts: 3,
      parse: (text) => JSON.parse(text),
    });

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(result.stderrTail).toContain(String(MAX_SYSTEM_PROMPT_BYTES));
    expect(requests).toHaveLength(0);
  });

  test("harness pins the sha256 of the prompt content into the transport request", async () => {
    const promptBody = "trusted system prompt body";
    const promptPath = path.join(tempDir, "system.md");
    await writeFile(promptPath, promptBody);
    await chmod(promptPath, 0o600);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(Buffer.from(promptBody));
    const expectedSha256 = hasher.digest("hex");

    const requests: TransportRequest[] = [];
    const harness = harnessWith(requests);

    const result = await harness.run({
      name: "hunter-hash",
      systemPromptPath: promptPath,
      prompt: "p",
      tools: [],
      model: "sonnet",
      effort: "high",
      cwd: tempDir,
      outPath: path.join(tempDir, "out.json"),
      mcpConfigPath: path.join(tempDir, "mcp.json"),
      timeoutMs: 1000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
    });

    expect(result.status).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0].systemPromptSha256).toBe(expectedSha256);
  });

  test("missing system prompt file fails the step before any transport call", async () => {
    const requests: TransportRequest[] = [];
    const harness = harnessWith(requests);

    const result = await harness.run({
      name: "hunter-missing",
      systemPromptPath: path.join(tempDir, "does-not-exist.md"),
      prompt: "p",
      tools: [],
      model: "sonnet",
      effort: "high",
      cwd: tempDir,
      outPath: path.join(tempDir, "out.json"),
      mcpConfigPath: path.join(tempDir, "mcp.json"),
      timeoutMs: 1000,
      maxAttempts: 2,
      parse: (text) => JSON.parse(text),
    });

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(result.stderrTail).toContain("Could not read system prompt");
    expect(requests).toHaveLength(0);
  });
});
