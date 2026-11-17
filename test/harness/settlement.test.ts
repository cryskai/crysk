import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StepSpec } from "#review/step-runner";
import type {
  AsyncEventSink,
  ProviderEvent,
  ProviderTerminalProof,
  ProviderTransport,
  TransportOutcome,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import {
  type ActiveSession,
  createSettlement,
  createWriteLease,
  DEFAULT_CANCELLATION_DEADLINE_MS,
  HARNESS_GRACE_MARGIN_MS,
  type SettlementReceipt,
  type SettlementSession,
  synthesizeInternalFailure,
  synthesizeUnconfirmed,
} from "../../src/execution/settlement";

const USAGE: TransportOutcome["usage"] = {
  wallMs: 1,
  tokens: { inputUncached: 1 },
  completeness: "complete",
  billingMode: "subscription",
};

function okOutcome(
  overrides: Partial<TransportOutcome> = {},
): TransportOutcome {
  return {
    completion: "success",
    protocolIntegrity: "verified",
    finalText: '{"findings":[]}',
    usage: USAGE,
    stderrTail: "",
    ...overrides,
  };
}

function proof(eventId: string): ProviderTerminalProof {
  return {
    eventId,
    providerStatus: "process_group_exited",
    providerObservedAt: new Date().toISOString(),
    exitCode: 0,
  };
}

function makeTransport(
  backend: ProviderTransport["backend"],
  execute: ProviderTransport["execute"],
  deadlineMs = 60_000,
): ProviderTransport {
  return {
    backend,
    capabilities: async () => ({
      backend,
      status: "ready",
      auth: {
        kind: "claude_subscription_oauth",
        projectionReady: true,
        probe: "not_run",
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
      cancellation: { deadlineMs, conformance: "passed" },
      billing: { mode: "subscription" },
      issues: [],
    }),
    execute,
    classifyFailure: () => undefined,
  };
}

function abortSignalPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("WriteLease", () => {
  test("starts valid and flips to invalid on first invalidation", () => {
    const lease = createWriteLease("lease-1");
    expect(lease.id).toBe("lease-1");
    expect(lease.valid).toBe(true);
    lease.invalidate("test");
    expect(lease.valid).toBe(false);
  });

  test("invalidation is idempotent — the hook fires exactly once", () => {
    const reasons: string[] = [];
    const lease = createWriteLease("lease-2", {
      onInvalidate: (reason) => reasons.push(reason),
    });
    lease.invalidate("first");
    lease.invalidate("second");
    expect(reasons).toEqual(["first"]);
  });
});

describe("settlement terminal slot", () => {
  test("first valid terminal wins; later ones are counted but rejected", () => {
    const settlement = createSettlement("sess", 1);
    expect(
      settlement.acceptTerminal("transport", "completed", proof("p1")),
    ).toBe(true);
    expect(settlement.terminal?.origin).toBe("transport");
    expect(settlement.rejectedCount).toBe(0);
    expect(settlement.acceptTerminal("provider", "failed")).toBe(false);
    expect(settlement.acceptTerminal("harness", "cancelled")).toBe(false);
    // §5.3 step 5: a later terminal can NEVER replace the accepted one.
    expect(settlement.terminal?.status).toBe("completed");
    expect(settlement.rejectedCount).toBe(2);
  });

  test("after close() every terminal is rejected, none applied", () => {
    const settlement = createSettlement("sess", 2);
    settlement.close();
    expect(settlement.acceptTerminal("transport", "failed")).toBe(false);
    expect(settlement.terminal).toBeUndefined();
    expect(settlement.rejectedCount).toBe(1);
  });

  test("a proof-bearing acceptance stamps terminationConfirmedAt", () => {
    let calls = 0;
    const settlement = createSettlement("sess", 3, {
      now: () => {
        calls++;
        return `t${calls}`;
      },
    });
    settlement.acceptTerminal("harness", "cancelled", proof("p"));
    expect(settlement.receipt("cancelled_confirmed").timestamps).toEqual({
      startedAt: "t1",
      settledAt: "t4",
      terminationConfirmedAt: "t2",
      leaseInvalidatedAt: "t3",
    });
  });
});

describe("receipt assembly", () => {
  test("completed maps to not_required confirmation unless proof exists", () => {
    const withProof = createSettlement("s", 1);
    withProof.acceptTerminal("transport", "completed", proof("p"));
    const receiptProof = withProof.receipt("completed");
    expect(receiptProof.termination.confirmation).toBe("process_group_exited");
    expect(receiptProof.resources.remoteStatus).toBe("completed");
    expect(receiptProof.lateWriteFence.closed).toBe(true);

    const withoutProof = createSettlement("s", 2).receipt("completed");
    expect(withoutProof.termination.confirmation).toBe("not_required");
    expect(withoutProof.termination.requested).toBe(false);
  });

  test("unconfirmed outcomes force requested + unknown_may_continue defaults", () => {
    const receipt = createSettlement("s", 7).receipt(
      "local_fenced_remote_unconfirmed",
    );
    expect(receipt.termination.requested).toBe(true);
    expect(receipt.termination.confirmation).toBe("unconfirmed");
    expect(receipt.resources.remoteStatus).toBe("unknown_may_continue");
    expect(receipt.attempt).toBe(7);
  });

  test("rejected data-plane events land on the closed fence", () => {
    const settlement = createSettlement("s", 1);
    settlement.rejectDataPlaneEvents(3);
    const receipt = settlement.receipt("failed");
    expect(receipt.lateWriteFence.rejectedEvents).toBe(3);
    expect(receipt.warnings).toEqual([]);
  });

  test("synthesizeUnconfirmed records the quarantine note", () => {
    const settlement = createSettlement("s", 1);
    const receipt = synthesizeUnconfirmed(settlement);
    expect(receipt.outcome).toBe("local_termination_unconfirmed");
    expect(receipt.warnings.some((w) => w.includes("quarantined"))).toBe(true);
    expect(receipt.resources.processGroupAlive).toBe("unknown");
  });

  test("synthesizeUnconfirmed can emit the SDK fenced variant", () => {
    const receipt = synthesizeUnconfirmed(createSettlement("s", 1), {
      outcome: "local_fenced_remote_unconfirmed",
      processGroupAlive: "not_applicable",
    });
    expect(receipt.outcome).toBe("local_fenced_remote_unconfirmed");
    expect(receipt.resources.processGroupAlive).toBe("not_applicable");
  });

  test("synthesizeInternalFailure converts an invariant failure into a warning", () => {
    const receipt = synthesizeInternalFailure(
      createSettlement("s", 1),
      new Error("clock exploded"),
    );
    expect(receipt.outcome).toBe("local_termination_unconfirmed");
    expect(
      receipt.warnings.some((w) =>
        w.includes("internal settlement invariant failure"),
      ),
    ).toBe(true);
    expect(receipt.warnings.some((w) => w.includes("clock exploded"))).toBe(
      true,
    );
  });
});

describe("StepExecutionHarness settlement integration", () => {
  let dir: string;
  let systemPromptPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-settle-"));
    systemPromptPath = path.join(dir, "system.md");
    await writeFile(systemPromptPath, "system prompt");
    await mkdir(path.join(dir, "logs"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  function spec(overrides: Partial<StepSpec> = {}): StepSpec {
    return {
      name: "hunter-reliability",
      systemPromptPath,
      prompt: "Review diff",
      tools: [],
      mcpConfigPath: path.join(dir, "mcp.json"),
      model: "claude-sonnet-4-5",
      effort: "high",
      cwd: dir,
      outPath: path.join(dir, "hunter-reliability.json"),
      timeoutMs: 5_000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
      ...overrides,
    };
  }

  function harnessWith(
    transport: ProviderTransport,
    options: {
      signal?: AbortSignal;
      graceMarginMs?: number;
      nowIso?: () => string;
      onSessionSettled?: (info: {
        session: ActiveSession;
        settlement: SettlementSession;
        receipt: SettlementReceipt;
      }) => void;
    } = {},
  ): StepExecutionHarness {
    return new StepExecutionHarness({
      transport,
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      ...options,
    });
  }

  // Receipts are keyed on BOTH axes — step name and attempt — because every
  // step of a run shares one steps/ directory.
  const settlementPath = (spec: StepSpec, attempt = 1) =>
    path.join(
      path.dirname(spec.outPath),
      `settlement.${spec.name}.attempt${attempt}.json`,
    );

  test("§13 line 738 — success resolves a completed receipt with process-group confirmation from the transport's terminalProof", async () => {
    const captured: {
      session?: ActiveSession;
      settlement?: SettlementSession;
      receipt?: SettlementReceipt;
    } = {};
    const transport = makeTransport("claude-code", async (_req, ctx) => {
      await ctx.events.push({
        sessionId: _req.sessionId,
        attempt: _req.attempt,
        seq: 1,
        observedAt: new Date().toISOString(),
        type: "terminal",
        origin: "transport",
        status: "completed",
        proof: proof("p1"),
        integrity: "verified",
      } satisfies ProviderEvent);
      return okOutcome({ terminalProof: proof("p1") });
    });
    const result = await harnessWith(transport, {
      onSessionSettled: (info) => Object.assign(captured, info),
    }).run(spec());

    expect(result.status).toBe("ok");
    const { receipt, session } = captured;
    if (!receipt || !session) throw new Error("settlement never observed");
    expect(receipt.outcome).toBe("completed");
    expect(receipt.termination.requested).toBe(false);
    expect(receipt.termination.confirmation).toBe("process_group_exited");
    expect(receipt.resources.remoteStatus).toBe("completed");
    expect(receipt.lateWriteFence.closed).toBe(true);
    expect(receipt.lateWriteFence.rejectedEvents).toBe(0);
    expect(receipt.timestamps.settledAt >= receipt.timestamps.startedAt).toBe(
      true,
    );

    const persisted = (await Bun.file(settlementPath(spec())).json()) as {
      outcome: string;
      sessionId: string;
    };
    expect(persisted.outcome).toBe("completed");
    expect(persisted.sessionId).toBe(session.id);

    // §5.1: settled always resolves to the same receipt.
    await expect(session.settled).resolves.toBe(receipt);
  });

  test("user cancellation mid-attempt with a transport terminal settles cancelled_confirmed", async () => {
    const external = new AbortController();
    const captured: { receipt?: SettlementReceipt } = {};
    const transport = makeTransport("claude-code", async (_req, ctx) => {
      await abortSignalPromise(ctx.signal);
      return okOutcome({
        completion: "cancelled",
        terminalProof: proof("sigterm"),
        exitCode: 143,
      });
    });

    const runPromise = harnessWith(transport, {
      signal: external.signal,
      onSessionSettled: (info) => {
        captured.receipt = info.receipt;
      },
    }).run(spec());

    await sleep(10);
    external.abort();
    const result = await runPromise;

    expect(result.status).toBe("failed");
    expect(captured.receipt?.outcome).toBe("cancelled_confirmed");
    expect(captured.receipt?.termination.requested).toBe(true);
    expect(captured.receipt?.termination.confirmation).toBe(
      "process_group_exited",
    );
    expect(captured.receipt?.resources.remoteStatus).toBe("cancelled");
    expect(captured.receipt?.timestamps.abortRequestedAt).toBeDefined();
  });

  test("grace expiry: harness-origin terminal accepted exactly once; late transport terminal counted, never applied; artifacts untouched", async () => {
    const external = new AbortController();
    let releaseLate!: (outcome: TransportOutcome) => void;
    const late = new Promise<TransportOutcome>((resolve) => {
      releaseLate = resolve;
    });
    const transport = makeTransport(
      "claude-code",
      // Ignores the abort signal entirely and only resolves when the test
      // releases it — well after the settlement grace has expired.
      async () => late,
      20,
    );

    const captured: {
      session?: ActiveSession;
      settlement?: SettlementSession;
      receipt?: SettlementReceipt;
    } = {};
    const runPromise = harnessWith(transport, {
      signal: external.signal,
      graceMarginMs: 10,
      onSessionSettled: (info) => Object.assign(captured, info),
    }).run(spec());

    await sleep(10);
    external.abort();
    const result = await runPromise;

    expect(result.status).toBe("failed");
    const { receipt, session, settlement } = captured;
    if (!receipt || !session || !settlement) {
      throw new Error("settlement never observed");
    }
    expect(receipt.outcome).toBe("local_termination_unconfirmed");
    expect(receipt.termination.confirmation).toBe("unconfirmed");
    expect(receipt.resources.remoteStatus).toBe("unknown_may_continue");
    expect(receipt.warnings.some((w) => w.includes("quarantined"))).toBe(true);
    // The one harness-origin non-success terminal won the CAS slot.
    expect(settlement.terminal?.origin).toBe("harness");
    expect(settlement.terminal?.status).toBe("cancelled");

    const persistedBefore = await Bun.file(settlementPath(spec())).text();

    // The late transport terminal arrives after grace expiry.
    releaseLate(okOutcome({ terminalProof: proof("late") }));
    await sleep(20);

    // Counted, never applied.
    expect(settlement.rejectedCount).toBe(1);
    // Its parse-capable payload was refused on the fence too.
    expect(settlement.rejectedEvents).toBeGreaterThanOrEqual(1);
    // No artifact was ever written from the late delivery...
    expect(await Bun.file(spec().outPath).exists()).toBe(false);
    // ...and this step's attempt-1 receipt was written exactly once
    // (byte-identical).
    expect(await Bun.file(settlementPath(spec())).text()).toBe(persistedBefore);
    // §5.1: even this path resolved its settled promise.
    await expect(session.settled).resolves.toBe(receipt);
  }, 10_000);

  test("§13 line 747 — after sink closure a late event cannot mutate artifacts: refused, counted, no rewrite", async () => {
    let sinkRef: AsyncEventSink | undefined;
    const transport = makeTransport("claude-code", async (_req, ctx) => {
      sinkRef = ctx.events;
      return okOutcome();
    });
    const captured: { settlement?: SettlementSession } = {};
    const step = spec();
    await harnessWith(transport, {
      onSessionSettled: (info) => {
        captured.settlement = info.settlement;
      },
    }).run(step);

    const artifactBefore = await Bun.file(step.outPath).text();
    const persistedBefore = await Bun.file(settlementPath(step)).text();
    const settlement = captured.settlement;
    if (!settlement) throw new Error("settlement never observed");
    const rejectedBefore = settlement.rejectedEvents;

    expect(sinkRef).toBeDefined();
    const base = {
      sessionId: "late-session",
      attempt: 1,
      seq: 99,
      observedAt: new Date().toISOString(),
    };
    expect(
      await sinkRef?.push({
        ...base,
        type: "delta",
        text: '{"findings":[{"id":"EVIL"}]}',
      }),
    ).toBe("closed");
    expect(
      await sinkRef?.push({
        ...base,
        seq: 100,
        type: "terminal",
        origin: "provider",
        status: "completed",
        integrity: "verified",
      }),
    ).toBe("closed");

    expect(settlement.rejectedEvents).toBe(rejectedBefore + 2);
    expect(await Bun.file(step.outPath).text()).toBe(artifactBefore);
    expect(await Bun.file(settlementPath(step)).text()).toBe(persistedBefore);
  });

  test("settled never rejects — a broken injected clock converts to local_termination_unconfirmed with an internal warning", async () => {
    let calls = 0;
    // Allow the two timestamps createSettlement+receipt legitimately capture,
    // then break — simulating an invariant failure during receipt assembly.
    const nowIso = () => {
      calls++;
      if (calls > 2) throw new Error("clock exploded mid-settlement");
      return new Date().toISOString();
    };
    const transport = makeTransport("claude-code", async () => okOutcome());
    const captured: { receipt?: SettlementReceipt } = {};
    const result = await harnessWith(transport, {
      nowIso,
      onSessionSettled: (info) => {
        captured.receipt = info.receipt;
      },
    }).run(spec());

    // The caller-visible StepResult shape is unchanged.
    expect(result.status).toBe("ok");
    const receipt = captured.receipt;
    expect(receipt?.outcome).toBe("local_termination_unconfirmed");
    // The last-resort conversion still produced an honest, warning-bearing
    // receipt rather than a rejection (§5.1).
    expect(
      receipt?.warnings.some(
        (w) => w.includes("internal settlement") || w.includes("hand-built"),
      ),
    ).toBe(true);
  });

  test("cancellation before the first attempt admits nothing and still reports failure", async () => {
    const external = new AbortController();
    external.abort();
    let executed = 0;
    const transport = makeTransport("claude-code", async () => {
      executed++;
      return okOutcome();
    });
    const result = await harnessWith(transport, {
      signal: external.signal,
    }).run(spec());
    expect(executed).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    // No session was admitted, so there is no receipt — the message must not
    // invent one (naming attempt0.json would repeat the settlement.json lie).
    expect(result.stderrTail).toContain("no attempt was admitted");
    expect(result.stderrTail).not.toContain("attempt0.json");
  });

  test("a cancelled step's stderr names the receipt file that was really written", async () => {
    const external = new AbortController();
    const transport = makeTransport("claude-code", async (_req, ctx) => {
      await abortSignalPromise(ctx.signal);
      return okOutcome({
        completion: "cancelled",
        terminalProof: proof("sigterm"),
        exitCode: 143,
      });
    });
    const step = spec();
    const runPromise = harnessWith(transport, {
      signal: external.signal,
    }).run(step);
    await sleep(10);
    external.abort();
    const result = await runPromise;

    expect(result.status).toBe("failed");
    // The pointer must resolve to a file that exists — the string it replaced
    // ("see settlement.json") named a file this engine has never written.
    const pointed = settlementPath(step, result.attempts);
    expect(result.stderrTail).toContain(pointed);
    expect(existsSync(pointed)).toBe(true);
    expect(result.stderrTail).not.toContain("(see settlement.json)");
  });

  test("deadline defaults to the §5.2 CLI value when capabilities are unusable", async () => {
    const transport = makeTransport("claude-code", async () => okOutcome());
    transport.capabilities = async () => {
      throw new Error("no capability probe offline");
    };
    const captured: { session?: ActiveSession } = {};
    await harnessWith(transport, {
      onSessionSettled: (info) => {
        captured.session = info.session;
      },
    }).run(spec());
    expect(captured.session?.cancellationDeadlineMs).toBe(
      DEFAULT_CANCELLATION_DEADLINE_MS,
    );
  });

  test("declared cancellation deadlines flow into the ActiveSession record", async () => {
    const transport = makeTransport(
      "claude-code",
      async () => okOutcome(),
      1234,
    );
    const captured: { session?: ActiveSession } = {};
    await harnessWith(transport, {
      onSessionSettled: (info) => {
        captured.session = info.session;
      },
    }).run(spec());
    expect(captured.session?.cancellationDeadlineMs).toBe(1234);
    expect(captured.session?.writeLease.valid).toBe(false);
    expect(captured.session?.controller.signal.aborted).toBe(false);
    expect(HARNESS_GRACE_MARGIN_MS).toBe(1000);
  });

  test("§5.1 — a data-plane write failure still settles: lease closed, receipt persisted, run terminates", async () => {
    const transport = makeTransport("claude-code", async () => okOutcome());
    // A directory at outPath makes writeJsonAtomically's rename fail —
    // the data-plane failure class pr-hero F001 flagged on this PR.
    const specObj = spec();
    await mkdir(specObj.outPath, { recursive: true });
    const settled: {
      receipt?: SettlementReceipt;
      session?: ActiveSession;
    } = {};
    const result = await harnessWith(transport, {
      onSessionSettled: (info) => {
        settled.receipt = info.receipt;
        settled.session = info.session;
      },
    }).run(specObj);

    expect(result.status).toBe("failed");
    const receipt = settled.receipt;
    if (!receipt) throw new Error("session did not settle");
    expect(settled.session?.writeLease.valid).toBe(false);
    const persisted = JSON.parse(
      await readFile(
        path.join(
          path.dirname(specObj.outPath),
          `settlement.${specObj.name}.attempt${settled.session?.attempt ?? 1}.json`,
        ),
        "utf-8",
      ),
    ) as SettlementReceipt;
    expect(persisted.timestamps.settledAt).toBe(receipt.timestamps.settledAt);
  });

  test("per-attempt settlement files — a retry never clobbers the previous attempt's receipt (§422)", async () => {
    let calls = 0;
    const transport = makeTransport("claude-code", async (_req, ctx) => {
      calls++;
      if (calls === 1) {
        await ctx.events.push({
          sessionId: "s",
          attempt: 1,
          seq: 1,
          observedAt: new Date().toISOString(),
          type: "terminal",
          origin: "transport",
          status: "failed",
          integrity: "verified",
        });
        return {
          completion: "failed" as const,
          protocolIntegrity: "verified" as const,
          finalText: "",
          usage: USAGE,
          stderrTail: "transient network error ECONNRESET",
          timedOut: false,
          exitCode: 1,
        };
      }
      return okOutcome();
    });
    const specObj = spec({ maxAttempts: 2 });
    const settledReceipts: SettlementReceipt[] = [];
    await harnessWith(transport, {
      onSessionSettled: ({ receipt }) => {
        settledReceipts.push(receipt);
      },
    }).run(specObj);

    expect(settledReceipts.length).toBe(2);
    const attempt1 = JSON.parse(
      await readFile(settlementPath(specObj, 1), "utf-8"),
    ) as SettlementReceipt;
    const attempt2 = JSON.parse(
      await readFile(settlementPath(specObj, 2), "utf-8"),
    ) as SettlementReceipt;
    // Attempt 1's audit record survives attempt 2's success.
    expect(attempt1.outcome === "completed").toBe(false);
    expect(attempt2.outcome).toBe("completed");
    expect(
      existsSync(path.join(path.dirname(specObj.outPath), "settlement.json")),
    ).toBe(false);
    // Nor the step-less name that used to collide across steps.
    expect(
      existsSync(
        path.join(path.dirname(specObj.outPath), "settlement.attempt1.json"),
      ),
    ).toBe(false);
  });

  test("per-step settlement files — two steps settling at the same attempt in one steps/ dir keep both receipts", async () => {
    // The steps of a run all share one steps/ directory (hunters, summarizer,
    // refuters, scout). A receipt keyed only on the attempt number made every
    // step clobber the previous one's audit record — four real steps left one
    // file behind. Both axes are load-bearing.
    const reliability = spec();
    const resilience = spec({
      name: "hunter-resilience",
      outPath: path.join(dir, "hunter-resilience.json"),
    });
    expect(path.dirname(reliability.outPath)).toBe(
      path.dirname(resilience.outPath),
    );

    const runStep = (step: StepSpec) => {
      const transport = makeTransport("claude-code", async () => okOutcome());
      return harnessWith(transport).run(step);
    };

    // Parallel, as the pipeline really runs them: distinct final paths also
    // give writeJsonAtomically distinct `${outPath}.tmp` staging paths.
    const [first, second] = await Promise.all([
      runStep(reliability),
      runStep(resilience),
    ]);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");

    // Both receipts survived — neither step clobbered the other.
    const reliabilityReceipt = JSON.parse(
      await readFile(settlementPath(reliability, 1), "utf-8"),
    ) as SettlementReceipt;
    const resilienceReceipt = JSON.parse(
      await readFile(settlementPath(resilience, 1), "utf-8"),
    ) as SettlementReceipt;

    // Existence alone is weak: each file must name its OWN step's session.
    expect(reliabilityReceipt.attempt).toBe(1);
    expect(resilienceReceipt.attempt).toBe(1);
    expect(reliabilityReceipt.sessionId.startsWith("hunter-reliability-")).toBe(
      true,
    );
    expect(resilienceReceipt.sessionId.startsWith("hunter-resilience-")).toBe(
      true,
    );
    expect(reliabilityReceipt.sessionId).not.toBe(resilienceReceipt.sessionId);

    // The step-less name is what the two writes used to collide on.
    expect(existsSync(path.join(dir, "settlement.attempt1.json"))).toBe(false);
  });
});
