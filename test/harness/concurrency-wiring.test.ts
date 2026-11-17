// D1-08 PR5a (§9.1 step 1 / §9.2): concurrency wiring ONLY — control flow,
// no ledger call (that's PR5b). `AttemptAdmissionGate` (admission.ts) wraps
// `ConcurrencyLimiter` (PR3, dormant until now) and the harness threads a
// lease acquire + `finally` release + bucketId around every attempt inside
// PR0's `runAttempt`. These are harness-observable tripwires: they fail if
// the wiring is ever removed again — the design's own PR5a tripwire row:
// "Two steps on one bucket with ceiling 1 start serialized in recorded FIFO
// order; a stub gate that refuses a lease makes the pipeline fail."

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildStepArgv, type StepSpec } from "#review/step-runner";
import type { AttemptAdmissionGate } from "../../src/execution/admission";
import { ConcurrencyAttemptAdmissionGate } from "../../src/execution/admission";
import { ConcurrencyLimiter } from "../../src/execution/concurrency-limiter";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import type { NormalizedUsage } from "../../src/execution/usage-normalized";

const USAGE: NormalizedUsage = {
  wallMs: 1,
  tokens: { inputUncached: 1 },
  completeness: "complete",
  billingMode: "subscription",
};

function capabilities(
  overrides: Partial<ProviderCapabilityReport> = {},
): ProviderCapabilityReport {
  return {
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
    billing: { mode: "subscription" },
    issues: [],
    ...overrides,
  };
}

function okOutcome() {
  return {
    completion: "success" as const,
    protocolIntegrity: "verified" as const,
    finalText: JSON.stringify({ findings: [] }),
    usage: USAGE,
    stderrTail: "",
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fakeSpawn = (() => ({}) as unknown) as typeof Bun.spawn;

async function makeStep(
  dir: string,
  overrides: Partial<StepSpec> = {},
): Promise<StepSpec> {
  const name = overrides.name ?? "hunter-reliability";
  const systemPromptPath = path.join(dir, `${name}.system.md`);
  await writeFile(systemPromptPath, "system prompt");
  return {
    name,
    systemPromptPath,
    prompt: "Review diff",
    tools: [],
    mcpConfigPath: path.join(dir, "mcp.json"),
    model: "claude-sonnet-4-5",
    effort: "high",
    cwd: dir,
    outPath: path.join(dir, `${name}.out.json`),
    timeoutMs: 5_000,
    maxAttempts: 1,
    parse: (text) => JSON.parse(text),
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-concurrency-wiring-"));
  await mkdir(path.join(dir, "logs"), { recursive: true });
  return dir;
}

describe("PR5a — AttemptAdmissionGate concurrency wiring", () => {
  // 5a.1 RED
  test("two steps sharing one bucket at ceiling 1 start strictly in submission order via the harness", async () => {
    const dir = await tempDir();
    const limiter = new ConcurrencyLimiter({ bucketCeiling: 1 });
    const gate = new ConcurrencyAttemptAdmissionGate(limiter);
    const events: string[] = [];

    function makeSlowTransport(
      name: string,
      delayMs: number,
    ): ProviderTransport {
      return {
        backend: "claude-code",
        capabilities: async () => capabilities(),
        execute: async () => {
          events.push(`${name}-start`);
          await sleepMs(delayMs);
          events.push(`${name}-end`);
          return okOutcome();
        },
        classifyFailure: () => undefined,
      };
    }

    const stepA = await makeStep(dir, { name: "hunter-a" });
    const stepB = await makeStep(dir, { name: "hunter-b" });

    const harnessA = new StepExecutionHarness({
      transport: makeSlowTransport("A", 20),
      attemptAdmissionGate: gate,
      rateLimitBucketId: "shared-bucket",
      spawnFn: fakeSpawn,
    });
    const harnessB = new StepExecutionHarness({
      transport: makeSlowTransport("B", 20),
      attemptAdmissionGate: gate,
      rateLimitBucketId: "shared-bucket",
      spawnFn: fakeSpawn,
    });

    const resultAPromise = harnessA.run(stepA);
    // Let A's admission definitely land first — removes any ambiguity from
    // async fs reads racing with B's own admission call.
    await sleepMs(10);
    const resultBPromise = harnessB.run(stepB);

    const [resultA, resultB] = await Promise.all([
      resultAPromise,
      resultBPromise,
    ]);

    expect(resultA.status).toBe("ok");
    expect(resultB.status).toBe("ok");
    // Strictly ordered, never overlapping: B cannot start until A releases.
    expect(events).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  // 5a.2 RED
  test("a stub AttemptAdmissionGate that refuses a lease fails the step without invoking the transport", async () => {
    const dir = await tempDir();
    let transportCalls = 0;
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => {
        transportCalls++;
        return okOutcome();
      },
      classifyFailure: () => undefined,
    };
    const refusingGate: AttemptAdmissionGate = {
      acquire: async () => {
        throw new Error("admission refused (stub)");
      },
    };
    const harness = new StepExecutionHarness({
      transport,
      attemptAdmissionGate: refusingGate,
      spawnFn: fakeSpawn,
    });
    const step = await makeStep(dir);

    await expect(harness.run(step)).rejects.toThrow("admission refused (stub)");
    expect(transportCalls).toBe(0);
  });

  // 5a.3 RED
  test("a bucket fenced by local_fenced_remote_unconfirmed refuses a second step's admission without contacting the transport", async () => {
    const dir = await tempDir();
    const limiter = new ConcurrencyLimiter({ bucketCeiling: 5 });
    const gate = new ConcurrencyAttemptAdmissionGate(limiter);

    const controller = new AbortController();
    // Ignores the abort signal entirely and only resolves well after the
    // settlement grace has expired — the "SDK abort without provider
    // confirmation" shape (design doc line 290) that legitimately produces
    // local_fenced_remote_unconfirmed for a non-CLI backend.
    const hangingTransport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () =>
        capabilities({
          backend: "opencode",
          cancellation: { deadlineMs: 5, conformance: "passed" },
        }),
      execute: async () => {
        await sleepMs(40);
        return okOutcome();
      },
      classifyFailure: () => undefined,
    };
    const stepA = await makeStep(dir, { name: "hunter-a" });
    const harnessA = new StepExecutionHarness({
      transport: hangingTransport,
      attemptAdmissionGate: gate,
      rateLimitBucketId: "fenced-bucket",
      signal: controller.signal,
      graceMarginMs: 5,
      spawnFn: fakeSpawn,
    });

    const runPromise = harnessA.run(stepA);
    await sleepMs(10);
    controller.abort();
    const resultA = await runPromise;
    expect(resultA.status).toBe("failed");

    let transportBCalls = 0;
    const transportB: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => {
        transportBCalls++;
        return okOutcome();
      },
      classifyFailure: () => undefined,
    };
    const stepB = await makeStep(dir, { name: "hunter-b" });
    const harnessB = new StepExecutionHarness({
      transport: transportB,
      attemptAdmissionGate: gate,
      rateLimitBucketId: "fenced-bucket",
      spawnFn: fakeSpawn,
    });

    const resultB = await harnessB.run(stepB);
    expect(resultB.status).toBe("failed");
    expect(transportBCalls).toBe(0);
  });

  // 5a.4 RED — threat matrix: argv/env invariance.
  test("buildStepArgv output is byte-identical with and without an attemptAdmissionGate configured", async () => {
    const dir = await tempDir();
    const step = await makeStep(dir);
    const withoutGate = buildStepArgv(step);

    // Constructing (and using) a harness with an attemptAdmissionGate must
    // have zero effect on argv composition — buildStepArgv takes only a
    // StepSpec and never consults harness options.
    const gate: AttemptAdmissionGate = {
      acquire: async () => ({
        leaseId: "lease-1",
        rateLimitBucketId: "bucket-1",
        release: () => {},
      }),
    };
    new StepExecutionHarness({ attemptAdmissionGate: gate });

    const withGate = buildStepArgv(step);
    expect(withGate).toEqual(withoutGate);
  });
});
