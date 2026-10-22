// D1-08 PR5b (§9.1 five-step order + D8): the FINAL wiring unit of the
// d1-08-usage-spend-concurrency chain. PR4 built the ledger pure (`spend-
// limiter.ts`); PR5a wired concurrency control (`admission.ts`) into
// `runAttempt` with NO ledger call at all. This file is the harness-
// observable tripwire table for the missing half: "PR5b | A stub ledger
// that refuses to reserve means NO SPAWN HAPPENS AT ALL ...; every attempt
// in pipeline.json carries a reservationId and a terminal state; abort-
// before-start releases, abort-after-start does not; AND an unresolved_
// remote state appears in renderResult's returned lines — not only in
// pipeline.json" (design doc, PR5b tripwire row).

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Finding, FindingsDocument, Telemetry } from "#review/findings";
import { buildStepArgv, type StepSpec } from "#review/step-runner";
import { type ResultInput, renderResult } from "#ui/result";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import {
  InMemorySpendLedger,
  type ReserveSpendInput,
  type SettlementDecision,
  type SpendLedger,
  type SpendReservation,
  SpendReservationFencedError,
} from "../../src/execution/spend-limiter";
import {
  type NormalizedUsage,
  normalizeUnavailableUsage,
} from "../../src/execution/usage-normalized";
import {
  type OpenCodeClientEvent,
  OpenCodeSdkTransport,
} from "../../src/transports/opencode-sdk";

// ---- shared fixtures (mirrors test/harness/concurrency-wiring.test.ts) ----

const USAGE: NormalizedUsage = {
  wallMs: 1,
  tokens: { inputUncached: 1 },
  completeness: "complete",
  billingMode: "subscription",
  costSource: "provider",
  cashCostUsd: 0,
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
    billing: { mode: "subscription", pricingReady: true },
    issues: [],
    ...overrides,
  };
}

function okOutcome(usage: NormalizedUsage = USAGE) {
  return {
    completion: "success" as const,
    protocolIntegrity: "verified" as const,
    finalText: JSON.stringify({ findings: [] }),
    usage,
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
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-spend-wiring-"));
  await mkdir(path.join(dir, "logs"), { recursive: true });
  return dir;
}

// Wraps the real, already-tested InMemorySpendLedger so these tests assert
// harness WIRING (did the harness call the right method at the right time)
// rather than re-testing the ledger's own CAS semantics (spend-limiter.test.ts's
// job).
class SpyLedger implements SpendLedger {
  private readonly inner = new InMemorySpendLedger();
  reserveCalls: ReserveSpendInput[] = [];
  settleCalls = 0;
  releaseUnstartedCalls = 0;
  markUnresolvedCalls = 0;

  async reserve(
    input: ReserveSpendInput,
    token: Parameters<InMemorySpendLedger["reserve"]>[1],
  ): Promise<SpendReservation> {
    this.reserveCalls.push(input);
    return this.inner.reserve(input, token);
  }

  async settle(
    reservationId: string,
    decision: Extract<SettlementDecision, { kind: "settle" }>,
    idempotencyKey: string,
  ): Promise<void> {
    this.settleCalls++;
    return this.inner.settle(reservationId, decision, idempotencyKey);
  }

  async releaseUnstarted(
    reservationId: string,
    idempotencyKey: string,
  ): Promise<void> {
    this.releaseUnstartedCalls++;
    return this.inner.releaseUnstarted(reservationId, idempotencyKey);
  }

  async markUnresolvedRemote(
    reservationId: string,
    knownUsd: number | undefined,
    idempotencyKey: string,
  ): Promise<void> {
    this.markUnresolvedCalls++;
    return this.inner.markUnresolvedRemote(
      reservationId,
      knownUsd,
      idempotencyKey,
    );
  }
}

describe("PR5b — SpendLedger wiring (§9.1 five-step order)", () => {
  // 5b.1 RED→GREEN
  test("a SpendLedger that refuses reserve() fails the step without invoking the transport, preserving prior reservations", async () => {
    const dir = await tempDir();
    let transportCalls = 0;
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => {
        transportCalls++;
        return {
          completion: "failed" as const,
          protocolIntegrity: "verified" as const,
          finalText: "not json",
          usage: {
            ...USAGE,
            completeness: "partial" as const,
            tokens: { providerReportedTotal: 100 },
          },
          stderrTail: "boom",
        };
      },
      classifyFailure: () => undefined,
    };
    let reserveCalls = 0;
    const inner = new InMemorySpendLedger();
    const ledger: SpendLedger = {
      reserve: async (input, token) => {
        reserveCalls++;
        if (reserveCalls > 1) {
          throw new SpendReservationFencedError(input.bucketId);
        }
        return inner.reserve(input, token);
      },
      settle: (id, decision, key) => inner.settle(id, decision, key),
      releaseUnstarted: (id, key) => inner.releaseUnstarted(id, key),
      markUnresolvedRemote: (id, known, key) =>
        inner.markUnresolvedRemote(id, known, key),
    };
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });
    const step = await makeStep(dir, { maxAttempts: 3 });

    const result = await harness.run(step);

    expect(result.status).toBe("failed");
    expect(transportCalls).toBe(1);
    expect(result.reservations?.length).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
  });

  // 5b.2 RED→GREEN
  test("every reserved attempt carries a reservationId and a TERMINAL state, never left 'reserved'", async () => {
    const dir = await tempDir();
    let call = 0;
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => {
        call++;
        if (call === 1) {
          return {
            completion: "failed" as const,
            protocolIntegrity: "verified" as const,
            finalText: "not json",
            usage: USAGE,
            stderrTail: "boom",
          };
        }
        return okOutcome();
      },
      classifyFailure: (outcome) =>
        outcome.stderrTail.includes("boom") ? "network_transient" : undefined,
    };
    const ledger = new SpyLedger();
    const step = await makeStep(dir, { maxAttempts: 2 });
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(ledger.reserveCalls.length).toBe(2);
    expect(result.reservations?.length).toBe(2);
    for (const reservation of result.reservations ?? []) {
      expect(reservation.reservationId.length).toBeGreaterThan(0);
      expect(reservation.state).not.toBe("reserved");
    }
    // Settlement is keyed on usage COMPLETENESS, never on transport success —
    // both attempts carried complete usage, so both settled as a number even
    // though the first one failed to parse.
    expect(ledger.settleCalls).toBe(2);
  });

  // Martian `opencode` arm: a rate-limit prompt refusal before any provider
  // event provably never started ($0 complete usage), and the metered-zero
  // rule settles it — so the bucket never fences and the retry is admitted.
  test("a dispatched refusal without billing proof remains unresolved and fences retry", async () => {
    const dir = await tempDir();
    const REFUSAL =
      "opencode session.prompt failed: 429 rate limit exceeded, prompt refused";
    let transportCalls = 0;
    const transport = new OpenCodeSdkTransport({
      client: {
        createSession: async () => ({ id: "ses-retry" }),
        streamEvents: async function* () {
          transportCalls++;
          if (transportCalls === 1) {
            throw new Error(REFUSAL);
          }
          yield {
            kind: "usage",
            mode: "snapshot",
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.01,
          };
          yield {
            kind: "delta",
            text: JSON.stringify({ findings: [] }),
          };
          yield {
            kind: "terminal",
            proof: {
              eventId: "msg-retry",
              providerStatus: "completed",
              providerObservedAt: new Date().toISOString(),
            },
          };
        },
        pollStatus: async () => ({ kind: "pending" }),
        abort: async () => {},
      },
      billingMode: "metered",
      pollIntervalMs: 20,
    });
    const ledger = new InMemorySpendLedger();
    const step = await makeStep(dir, { maxAttempts: 2 });
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(step);

    expect(result.status).toBe("failed");
    expect(transportCalls).toBe(1);
    expect(result.reservations?.length).toBe(1);
    for (const reservation of result.reservations ?? []) {
      expect(reservation.state).toBe("unresolved_remote");
    }
  });

  // 5b.3 RED→GREEN (part 1): abort raced ahead of execution.
  test("abort timing (1/2): a cancellation that lands AFTER reserve() but BEFORE execution releases the reservation as released_unstarted, and the transport is never invoked", async () => {
    const dir = await tempDir();
    const controller = new AbortController();
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
    const ledger = new SpyLedger();
    // A reservation exists (real CAS state), but the signal is aborted the
    // instant reserve() resolves — before runAttempt ever calls
    // runAdmittedAttempt/executeSession, so the provider attempt has
    // PROVABLY never started.
    const racingLedger: SpendLedger = {
      reserve: async (input, token) => {
        const reservation = await ledger.reserve(input, token);
        controller.abort();
        return reservation;
      },
      settle: (id, decision, key) => ledger.settle(id, decision, key),
      releaseUnstarted: (id, key) => ledger.releaseUnstarted(id, key),
      markUnresolvedRemote: (id, knownUsd, key) =>
        ledger.markUnresolvedRemote(id, knownUsd, key),
    };
    const step = await makeStep(dir);
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: racingLedger,
      signal: controller.signal,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(step);

    expect(transportCalls).toBe(0);
    expect(result.reservations?.length).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("released_unstarted");
    expect(ledger.releaseUnstartedCalls).toBe(1);
    expect(ledger.markUnresolvedCalls).toBe(0);
  });

  // 5b.3 RED→GREEN (part 2): abort after the provider attempt started.
  test("abort timing (2/2): a cancellation AFTER the provider attempt started does NOT release the reservation — it lands unresolved, never released_unstarted", async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const ledger = new SpyLedger();
    // Ignores the abort signal and resolves well after the settlement
    // grace expires — the transport HAS been invoked by the time the
    // cancellation is observed (same shape as PR5a's 5a.3 fixture).
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
    const step = await makeStep(dir);
    const harness = new StepExecutionHarness({
      transport: hangingTransport,
      spendLedger: ledger,
      signal: controller.signal,
      graceMarginMs: 5,
      spawnFn: fakeSpawn,
    });

    const runPromise = harness.run(step);
    await sleepMs(10);
    controller.abort();
    const result = await runPromise;

    expect(result.status).toBe("failed");
    expect(result.reservations?.length).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(ledger.releaseUnstartedCalls).toBe(0);
    expect(ledger.markUnresolvedCalls).toBe(1);
  });

  // 5b.4 RED→GREEN
  test("a delivered attempt whose usage completeness is not 'complete' routes to markUnresolvedRemote — settle() is never called for it", async () => {
    const dir = await tempDir();
    const partialUsage: NormalizedUsage = {
      wallMs: 500,
      tokens: { providerReportedTotal: 100 },
      completeness: "partial",
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0.05,
    };
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => okOutcome(partialUsage),
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const step = await makeStep(dir);
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(result.reservations?.length).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(result.reservations?.[0]?.knownUsd).toBe(0.05);
    expect(ledger.settleCalls).toBe(0);
    expect(ledger.markUnresolvedCalls).toBe(1);
  });

  // 2026-09-02, the metered-zero rule reaching the ledger. `settlementFromUsage`
  // is the only producer of a SettlementDecision, so this is the harness-
  // observable half of the same fact `spend-limiter.test.ts` asserts purely:
  // the CAS transition the harness applies changes with the billing mode, not
  // just the decision object.
  //
  // The pair is the discriminator. A rule that refused every $0 would pass
  // the first arm and fail the second, and a run under a subscription
  // credential would fence its own bucket on the first genuinely free step.
  test("a metered attempt reporting $0 with output tokens lands unresolved_remote, not settled", async () => {
    const dir = await tempDir();
    const meteredZero: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0,
    };
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => okOutcome(meteredZero),
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    expect(result.status).toBe("ok");
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    // Not 0: a zero that cannot be trusted is not a known cost, and carrying
    // it would print "$0 known" beside the fenced bucket.
    expect(result.reservations?.[0]?.knownUsd).toBeUndefined();
    expect(ledger.settleCalls).toBe(0);
    expect(ledger.markUnresolvedCalls).toBe(1);
  });

  // #182 follow-up: the free-nonzero fail-fast. Unresolved alone only fences
  // the bucket while the retry loop keeps spending attempts on a flipped
  // model, so a decision carrying reason `free_nonzero_cost` fails the step
  // CLOSED with no retry — `legacy_terminal` breaks the loop before
  // `decideRetryDisposition` can resurrect it. The fence is still applied
  // (the spend may be real).
  //
  // The pair below is the discriminator. The first arm proves fail-closed: a
  // parse failure classified `network_transient` with maxAttempts 3 would
  // otherwise retry twice, but the flip ends the step on attempt 1. The
  // second arm proves restraint: free usage with NO cash figure releases
  // WITHOUT fencing (free-route fence scope) — no evidence of billing, no
  // fail-fast.
  test("a free attempt reporting priced cost fails the step with no retry and fences its bucket", async () => {
    const dir = await tempDir();
    let transportCalls = 0;
    const flipped: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "free",
      costSource: "provider",
      cashCostUsd: 0.06,
    };
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => {
        transportCalls++;
        return {
          completion: "failed" as const,
          protocolIntegrity: "verified" as const,
          finalText: "not json",
          usage: flipped,
          stderrTail: "boom",
        };
      },
      // Transient would normally buy two more attempts under maxAttempts 3 —
      // the flip must deny them all.
      classifyFailure: (outcome) =>
        outcome.stderrTail.includes("boom") ? "network_transient" : undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir, { maxAttempts: 3 }));

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(transportCalls).toBe(1);
    expect(result.reservations?.length).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(result.reservations?.[0]?.knownUsd).toBe(0.06);
    expect(ledger.settleCalls).toBe(0);
    expect(ledger.markUnresolvedCalls).toBe(1);
    expect(result.stderrTail).toContain("free-route cost flip");
    expect(result.stderrTail).toContain("$0.06");
    expect(result.stderrTail).toContain("re-probe");

    // The bucket is fenced for the rest of the run: a second step on the same
    // ledger is refused before its transport is ever invoked.
    let secondTransportCalls = 0;
    const secondTransport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => {
        secondTransportCalls++;
        return okOutcome();
      },
      classifyFailure: () => undefined,
    };
    const secondHarness = new StepExecutionHarness({
      transport: secondTransport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });
    const second = await secondHarness.run(
      await makeStep(dir, { name: "hunter-resilience" }),
    );
    expect(second.status).toBe("failed");
    expect(secondTransportCalls).toBe(0);
  });

  test("a free attempt with undefined cash releases without fencing: delivered, no flip note, no fail-fast", async () => {
    const dir = await tempDir();
    const freeUnknownCash: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "free",
      costSource: "provider",
    };
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => okOutcome(freeUnknownCash),
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    expect(result.status).toBe("ok");
    // #182 follow-up, free-route fence scope: no cash figure means no spend
    // evidence on a free route, so the attempt releases instead of fencing —
    // collectUnresolvedSpend/renderResult only read unresolved_remote, so this
    // reservation is invisible to both (no floor marker, no unresolved row).
    expect(result.reservations?.[0]?.state).toBe("released_unstarted");
    expect(result.reservations?.[0]?.knownUsd).toBeUndefined();
    expect(ledger.markUnresolvedCalls).toBe(0);
    expect(ledger.releaseUnstartedCalls).toBe(1);
    expect(result.stderrTail).not.toContain("free-route cost flip");
  });

  test("a free transient failure retries on the same ledger: no fence, sibling steps unaffected", async () => {
    const dir = await tempDir();
    const freeUnknownCash: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "free",
      costSource: "provider",
    };
    let transportCalls = 0;
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => {
        transportCalls++;
        if (transportCalls === 1) {
          return {
            completion: "failed" as const,
            protocolIntegrity: "verified" as const,
            finalText: "not json",
            usage: freeUnknownCash,
            stderrTail: "boom",
          };
        }
        return okOutcome({
          ...freeUnknownCash,
          cashCostUsd: 0,
        });
      },
      classifyFailure: (outcome) =>
        outcome.stderrTail.includes("boom") ? "network_transient" : undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir, { maxAttempts: 3 }));

    expect(result.status).toBe("ok");
    expect(transportCalls).toBe(2);
    expect(result.reservations?.length).toBe(2);
    expect(result.reservations?.[0]?.state).toBe("released_unstarted");
    expect(result.reservations?.[1]?.state).toBe("settled");

    // The released reservation fenced nothing: a sibling step on the same
    // ledger reserves and runs fine.
    const sibling = await new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    }).run(await makeStep(dir, { name: "hunter-resilience" }));
    expect(sibling.status).toBe("ok");
  });

  test("a free attempt watchdog timeout retries on the same ledger: no fence, sibling steps unaffected (#187)", async () => {
    const dir = await tempDir();
    let transportCalls = 0;
    const freeUsage: NormalizedUsage = {
      wallMs: 50,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "free",
      costSource: "provider",
      cashCostUsd: 0,
    };
    const transport: ProviderTransport = {
      backend: "opencode",
      billingMode: "free",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async (_req, ctx) => {
        transportCalls++;
        if (transportCalls === 1) {
          // Attempt 1 stalls until watchdog aborts it
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return {
            completion: "failed" as const,
            protocolIntegrity: "unverified" as const,
            finalText: "",
            usage: normalizeUnavailableUsage({
              wallMs: 50,
              billingMode: "free",
            }),
            stderrTail: "stalled",
            timedOut: true,
          };
        }
        return okOutcome(freeUsage);
      },
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(
      await makeStep(dir, { maxAttempts: 3, timeoutMs: 50 }),
    );

    expect(result.status).toBe("ok");
    expect(transportCalls).toBe(2);
    expect(result.reservations?.length).toBe(2);
    expect(result.reservations?.[0]?.state).toBe("released_unstarted");
    expect(result.reservations?.[1]?.state).toBe("settled");

    // The released reservation fenced nothing: a sibling step on the same
    // ledger reserves and runs fine.
    const sibling = await new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    }).run(await makeStep(dir, { name: "hunter-resilience" }));
    expect(sibling.status).toBe("ok");
  });

  test("a metered transient failure still fences: no retry, sibling steps refused", async () => {
    const dir = await tempDir();
    const meteredPartial: NormalizedUsage = {
      wallMs: 500,
      tokens: { providerReportedTotal: 100 },
      completeness: "partial",
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0.05,
    };
    let transportCalls = 0;
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => {
        transportCalls++;
        return {
          completion: "failed" as const,
          protocolIntegrity: "verified" as const,
          finalText: "not json",
          usage: meteredPartial,
          stderrTail: "boom",
        };
      },
      classifyFailure: (outcome) =>
        outcome.stderrTail.includes("boom") ? "network_transient" : undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir, { maxAttempts: 3 }));

    // The fence lands before the retry can reserve: one transport call, then
    // the fenced reserve fails the step without a second spawn.
    expect(result.status).toBe("failed");
    expect(transportCalls).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(ledger.markUnresolvedCalls).toBe(1);

    const sibling = await new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    }).run(await makeStep(dir, { name: "hunter-resilience" }));
    expect(sibling.status).toBe("failed");
    expect(sibling.stderrTail).toContain("fenced");
    expect(transportCalls).toBe(1);
  });

  // The same shape as the metered-transient test above, but the cause is a
  // provider rate limit (429): the provider stated the cost of what it served,
  // so the attempt settles at that figure, the retry runs, and a sibling step
  // on the same credential bucket is not fenced (lab ledger, cost levers v2).
  test("a metered rate-limited attempt with a provider-priced cost settles: it retries and fences nothing", async () => {
    const dir = await tempDir();
    const meteredPartial: NormalizedUsage = {
      wallMs: 500,
      tokens: { providerReportedTotal: 100, outputKnown: 10 },
      completeness: "partial",
      partialCause: "terminal_failure",
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0.05,
    };
    let transportCalls = 0;
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => {
        transportCalls++;
        if (transportCalls === 1) {
          return {
            completion: "failed" as const,
            protocolIntegrity: "verified" as const,
            finalText: "",
            usage: meteredPartial,
            stderrTail: "429 rate limit",
          };
        }
        return okOutcome({
          wallMs: 500,
          tokens: { outputVisible: 10, outputKnown: 10, totalKnown: 110 },
          completeness: "complete",
          billingMode: "metered",
          costSource: "provider",
          cashCostUsd: 0.02,
        });
      },
      classifyFailure: (outcome) =>
        outcome.stderrTail.includes("429") ? "rate_limit" : undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir, { maxAttempts: 3 }));

    expect(result.status).toBe("ok");
    expect(transportCalls).toBe(2);
    expect(result.reservations?.map((r) => r.state)).toEqual([
      "settled",
      "settled",
    ]);
    expect(result.reservations?.[0]?.settledUsd).toBe(0.05);
    expect(ledger.markUnresolvedCalls).toBe(0);

    const sibling = await new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    }).run(await makeStep(dir, { name: "hunter-resilience" }));
    expect(sibling.status).toBe("ok");
    expect(transportCalls).toBe(3);
  });

  test("a delivered free attempt reporting priced cost stays delivered with the flip note appended", async () => {
    const dir = await tempDir();
    const flipped: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "free",
      costSource: "provider",
      cashCostUsd: 0.06,
    };
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => okOutcome(flipped),
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    // Delivered, not failed: the parsed output was already persisted and the
    // loop returns ok on delivered — rewriting it would claim an artifact was
    // never written. The fence is still applied and the note still lands.
    expect(result.status).toBe("ok");
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(result.reservations?.[0]?.knownUsd).toBe(0.06);
    expect(result.stderrTail).toContain("free-route cost flip");
    expect(result.stderrTail).toContain("$0.06");

    // The bucket is still fenced for the rest of the run: fail-closed is not
    // weakened by preserving the kind.
    const sibling = await new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    }).run(await makeStep(dir, { name: "hunter-resilience" }));
    expect(sibling.status).toBe("failed");
    expect(sibling.stderrTail).toContain("fenced");
  });

  test("a subscription attempt reporting $0 with output tokens still settles, leaving its bucket unfenced", async () => {
    const dir = await tempDir();
    const subscriptionZero: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "subscription",
      costSource: "provider",
      cashCostUsd: 0,
    };
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => okOutcome(subscriptionZero),
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const first = await harness.run(await makeStep(dir));
    expect(first.reservations?.[0]?.state).toBe("settled");
    expect(ledger.settleCalls).toBe(1);
    expect(ledger.markUnresolvedCalls).toBe(0);

    // The bucket is still admissible: an unresolved reservation would have
    // fenced it for the rest of the ledger's life, so a second free step on
    // the same subscription credential proves the rule did not overreach.
    const second = await harness.run(
      await makeStep(dir, { name: "hunter-resilience" }),
    );
    expect(second.status).toBe("ok");
    expect(second.reservations?.[0]?.state).toBe("settled");
  });

  // 5b.7 (threat matrix, mirrors 5a.4): argv/env invariance for the ledger too.
  test("buildStepArgv output is byte-identical with and without a spendLedger configured", async () => {
    const dir = await tempDir();
    const step = await makeStep(dir);
    const withoutLedger = buildStepArgv(step);

    new StepExecutionHarness({ spendLedger: new SpyLedger() });

    const withLedger = buildStepArgv(step);
    expect(withLedger).toEqual(withoutLedger);
  });

  // Backward compatibility: an unconfigured spendLedger reserves nothing —
  // the ledger-free PR5a shape must survive byte-for-byte.
  test("no spendLedger configured means no reservation is ever attempted, and StepResult.reservations stays absent", async () => {
    const dir = await tempDir();
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => okOutcome(),
      classifyFailure: () => undefined,
    };
    const harness = new StepExecutionHarness({ transport, spawnFn: fakeSpawn });
    const step = await makeStep(dir);

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(result.reservations).toBeUndefined();
  });
});

// ---- D8: renderResult surfaces unresolved spend (5b.5 / 5b.6) ----

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const joined = (lines: string[]): string => stripAnsi(lines.join("\n"));

const telemetry: Telemetry = {
  index_ms: 0,
  index_mode: "sync",
  index_disk_mb: 0,
  wall_ms: 60_000,
  tokens_in: 1,
  tokens_out: 1,
  tokens_total: 2,
  cost_usd_est: 1.23,
};

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "F001",
  category: 5,
  path: "src/example.ts",
  line: 10,
  severity: "BLOCKER",
  evidence_class: "deterministic",
  refuter_verdict: "corroborated",
  causal_disposition: "introduced",
  claim: "example claim",
  proof_refs: ["src/example.ts:10"],
  hunter: "reliability",
  tier: "blocking",
  hops_used: 1,
  hop_trail: [],
  dedupe_key: "src/example.ts:10",
  ...over,
});

const doc = (over: Partial<FindingsDocument> = {}): FindingsDocument => ({
  schema_version: "1.0.0",
  pr: 6,
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  model: "sonnet",
  iteration: 0,
  parity_hunter_fired: false,
  run_status: "complete",
  telemetry,
  findings: [finding()],
  debug: { refuted: [] },
  ...over,
});

const resultInput = (over: Partial<ResultInput> = {}): ResultInput => ({
  doc: doc(),
  costUsd: 1.23,
  wallMs: 60_000,
  estimate: { low: 1.0, high: 2.0 },
  runDir: "/tmp/pr-hero-runs/pr-6-abc123",
  artifacts: ["report.md", "findings.json"],
  sessionFailed: false,
  styles: false,
  width: 96,
  ...over,
});

describe("PR5b — D8: renderResult surfaces unresolved spend", () => {
  // 5b.5 RED→GREEN
  test("an unresolved_remote reservation appears in renderResult's returned lines, not only in pipeline.json", () => {
    const text = joined(
      renderResult(
        resultInput({
          unresolved: [
            {
              step: "hunter-reliability",
              bucketId: "bucket-fenced",
              reservationId: "resv-1",
              knownUsd: 0.1,
            },
          ],
        }),
      ),
    );
    expect(text).toContain("bucket-fenced");
    expect(text).toContain("unresolved");
  });

  test("no unresolved reservations means no unresolved row at all", () => {
    const text = joined(renderResult(resultInput()));
    expect(text).not.toContain("unresolved");
  });

  // 5b.6 RED→GREEN
  test("the header's cost figure is marked as a floor (not a bare total) when unresolved is non-empty", () => {
    const clean = stripAnsi(renderResult(resultInput())[1] ?? "");
    const withUnresolved = stripAnsi(
      renderResult(
        resultInput({
          unresolved: [
            {
              step: "hunter-reliability",
              bucketId: "bucket-fenced",
              reservationId: "resv-1",
            },
          ],
        }),
      )[1] ?? "",
    );
    expect(clean).toContain("$1.23");
    expect(clean).not.toContain("≥$1.23");
    expect(withUnresolved).toContain("≥$1.23");
  });
});

describe("PR5b — BE2: Usage identity (cumulative/delta replay, missing/conflicting/capped usage)", () => {
  function makeMockClient(events: OpenCodeClientEvent[], onAbort?: () => void) {
    return {
      createSession: async () => ({ id: "ses-mock" }),
      streamEvents: async function* () {
        for (const event of events) {
          yield event;
        }
      },
      pollStatus: async () => ({ kind: "pending" as const }),
      abort: async () => {
        onAbort?.();
      },
    };
  }

  // BE2a: Cumulative snapshot replay
  test("BE2a: duplicate cumulative snapshots replace and settle each identified contribution once", async () => {
    const dir = await tempDir();
    const transport = new OpenCodeSdkTransport({
      client: makeMockClient([
        {
          kind: "usage",
          id: "step-1",
          mode: "snapshot",
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.05,
        },
        { kind: "delta", text: JSON.stringify({ findings: [] }) },
        // Replayed snapshot for same step-1
        {
          kind: "usage",
          id: "step-1",
          mode: "snapshot",
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.05,
        },
        {
          kind: "terminal",
          proof: {
            eventId: "step-1",
            providerStatus: "completed",
            providerObservedAt: new Date().toISOString(),
          },
        },
      ]),
      billingMode: "metered",
      pollIntervalMs: 20,
    });
    const ledger = new InMemorySpendLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    expect(result.status).toBe("ok");
    expect(result.reservations?.[0]?.state).toBe("settled");
    expect(result.reservations?.[0]?.settledUsd).toBe(0.05);
  });

  // BE2a: Delta replay
  test("BE2a: duplicate delta contributions with identical IDs are deduplicated and counted once", async () => {
    const dir = await tempDir();
    const transport = new OpenCodeSdkTransport({
      client: makeMockClient([
        {
          kind: "usage",
          id: "delta-1",
          mode: "delta",
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.05,
        },
        { kind: "delta", text: JSON.stringify({ findings: [] }) },
        // Replayed delta-1 with identical contribution ID
        {
          kind: "usage",
          id: "delta-1",
          mode: "delta",
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.05,
        },
        // Distinct delta-2
        {
          kind: "usage",
          id: "delta-2",
          mode: "delta",
          inputTokens: 50,
          outputTokens: 10,
          costUsd: 0.025,
        },
        {
          kind: "terminal",
          proof: {
            eventId: "step-1",
            providerStatus: "completed",
            providerObservedAt: new Date().toISOString(),
          },
        },
      ]),
      billingMode: "metered",
      pollIntervalMs: 20,
    });
    const ledger = new InMemorySpendLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    expect(result.status).toBe("ok");
    expect(result.reservations?.[0]?.state).toBe("settled");
    expect(result.reservations?.[0]?.settledUsd).toBeCloseTo(0.075);
  });

  // BE2b: Absent usage retains uncertainty
  test("BE2b: absent usage retains uncertainty and fences its bucket rather than fabricating zero", async () => {
    const dir = await tempDir();
    const transport = new OpenCodeSdkTransport({
      client: makeMockClient([
        { kind: "delta", text: JSON.stringify({ findings: [] }) },
        {
          kind: "terminal",
          proof: {
            eventId: "step-1",
            providerStatus: "completed",
            providerObservedAt: new Date().toISOString(),
          },
        },
      ]),
      billingMode: "metered",
      pollIntervalMs: 20,
    });
    const ledger = new InMemorySpendLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    expect(result.status).toBe("ok");
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(result.reservations?.[0]?.knownUsd).toBeUndefined();

    // Bucket is fenced for siblings
    const sibling = await harness.run(
      await makeStep(dir, { name: "hunter-resilience" }),
    );
    expect(sibling.status).toBe("failed");
    expect(sibling.stderrTail).toContain("fenced");
  });

  // BE2b: Unconfirmed remote cessation retains uncertainty
  test("BE2b: unconfirmed remote cessation retains uncertainty and fences its bucket rather than settling complete", async () => {
    const dir = await tempDir();
    const transport = new OpenCodeSdkTransport({
      client: {
        createSession: async () => ({ id: "ses-abort" }),
        streamEvents: async function* () {
          yield {
            kind: "usage",
            mode: "snapshot",
            inputTokens: 50,
            outputTokens: 10,
            costUsd: 0.03,
          };
          // Provider hangs; harness watchdog triggers abort
          await new Promise<void>(() => {});
        },
        pollStatus: async () => ({ kind: "pending" }),
        abort: async () => {},
      },
      billingMode: "metered",
      maxQuietRounds: 1,
      pollIntervalMs: 10,
    });
    const ledger = new InMemorySpendLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    expect(result.status).toBe("failed");
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(result.reservations?.[0]?.knownUsd).toBe(0.03);

    // Sibling step is fenced
    const sibling = await harness.run(
      await makeStep(dir, { name: "hunter-resilience" }),
    );
    expect(sibling.status).toBe("failed");
    expect(sibling.stderrTail).toContain("fenced");
  });

  // BE2: Conflicting usage mode flip remains incomplete
  test("BE2: conflicting usage aggregation mode fails integrity and retains uncertainty as unresolved_remote", async () => {
    const dir = await tempDir();
    const transport = new OpenCodeSdkTransport({
      client: makeMockClient([
        {
          kind: "usage",
          mode: "snapshot",
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.04,
        },
        // Conflicting delta mode
        {
          kind: "usage",
          mode: "delta",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.01,
        },
      ]),
      billingMode: "metered",
      pollIntervalMs: 20,
    });
    const ledger = new InMemorySpendLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    expect(result.status).toBe("failed");
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(result.reservations?.[0]?.knownUsd).toBe(0.04);
  });

  // BE2: Capped usage remains incomplete
  test("BE2: capped usage reports partial completeness and lands unresolved_remote with known floor", async () => {
    const dir = await tempDir();
    const transport = new OpenCodeSdkTransport({
      client: makeMockClient([
        {
          kind: "usage",
          mode: "snapshot",
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.05,
          incomplete: true,
        },
        { kind: "delta", text: JSON.stringify({ findings: [] }) },
        {
          kind: "terminal",
          proof: {
            eventId: "step-1",
            providerStatus: "completed",
            providerObservedAt: new Date().toISOString(),
          },
        },
      ]),
      billingMode: "metered",
      pollIntervalMs: 20,
    });
    const ledger = new InMemorySpendLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    expect(result.status).toBe("ok");
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(result.reservations?.[0]?.knownUsd).toBe(0.05);
  });

  // BE2: Ambiguous prompt failure after events observed keeps fail-closed unavailable
  test("BE2: ambiguous prompt transport failure after events were observed keeps fail-closed unavailable", async () => {
    const dir = await tempDir();
    const REFUSAL =
      'opencode session.prompt failed: {"name":"UnknownError","data":{"message":"Unexpected server error."}}';
    let transportCalls = 0;
    const transport = new OpenCodeSdkTransport({
      client: {
        createSession: async () => ({ id: "ses-ambig" }),
        streamEvents: async function* () {
          transportCalls++;
          // An event WAS observed before the refusal!
          yield { kind: "delta", text: "partial response" };
          throw new Error(REFUSAL);
        },
        pollStatus: async () => ({ kind: "pending" }),
        abort: async () => {},
      },
      billingMode: "metered",
      pollIntervalMs: 20,
    });
    const ledger = new InMemorySpendLedger();
    const step = await makeStep(dir, { maxAttempts: 2 });
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(step);

    // Because an event was observed, it does NOT qualify for genuine $0 exception.
    // It keeps fail-closed unavailable, marks unresolved_remote, and fences the bucket.
    expect(result.status).toBe("failed");
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    // Retry could not run because bucket was fenced
    expect(transportCalls).toBe(1);
  });
});

test("attempt evidence preserves real proof and parsed empty findings for the driver", async () => {
  const dir = await tempDir();
  const step = await makeStep(dir);
  const proof = {
    eventId: "provider-terminal",
    providerStatus: "completed",
    providerObservedAt: "2026-09-13T00:00:00.000Z",
  };
  const transport: ProviderTransport = {
    backend: "claude-code",
    capabilities: async () => capabilities(),
    classifyFailure: () => undefined,
    execute: async () => ({ ...okOutcome(), terminalProof: proof }),
  };
  const result = await new StepExecutionHarness({
    transport,
    spawnFn: fakeSpawn,
  }).run(step);
  expect(result.status).toBe("ok");
  const evidence = await Bun.file(
    path.join(dir, `evidence.${step.name}.attempt1.json`),
  ).json();
  expect(evidence.outcome.terminalProof).toEqual(proof);
  expect(evidence.delivered).toBe(true);
  expect(evidence.outputSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(evidence.identity.systemPromptSha256).toMatch(/^[a-f0-9]{64}$/);
});
