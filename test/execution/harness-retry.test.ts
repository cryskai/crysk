// PR0 (D1-08 tasks 0.1-0.5): the harness's live attempt loop must decide
// retry disposition via decideRetryDisposition/causeFromLegacyFailureClass
// (§7), not the legacy step-runner classifyFailure vocabulary — and it must
// call the TRANSPORT's own classifyFailure, a second previously-unwired
// mechanism (D1-08 design, "PR0 delta" table). These are harness-observable
// tripwires: they fail if the wiring is ever removed again.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StepSpec } from "#review/step-runner";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
  TransportFailureCause,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import type { NormalizedUsage } from "../../src/execution/usage-normalized";

const USAGE: NormalizedUsage = {
  wallMs: 1,
  tokens: { inputUncached: 1 },
  completeness: "complete",
  billingMode: "subscription",
  costSource: "provider",
  cashCostUsd: 0,
};

const CAPABILITIES: ProviderCapabilityReport = {
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
};

function failOutcome(
  overrides: Partial<TransportOutcome> = {},
): TransportOutcome {
  return {
    completion: "failed",
    protocolIntegrity: "unverified",
    finalText: "not valid json",
    usage: USAGE,
    stderrTail: "",
    ...overrides,
  };
}

function okOutcome(): TransportOutcome {
  return {
    completion: "success",
    protocolIntegrity: "verified",
    finalText: JSON.stringify({ findings: [] }),
    usage: USAGE,
    stderrTail: "",
  };
}

// A fake transport that replays a scripted sequence of outcomes, one per
// `execute()` call (the last entry repeats if more calls arrive than
// scripted), and records every request it received.
function makeScriptedTransport(
  outcomes: readonly TransportOutcome[],
  classify: (
    outcome: TransportOutcome,
  ) => TransportFailureCause | undefined = () => undefined,
): { transport: ProviderTransport; requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  let calls = 0;
  const transport: ProviderTransport = {
    backend: "claude-code",
    capabilities: async () => CAPABILITIES,
    execute: async (request) => {
      requests.push(request);
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
      calls++;
      return outcome;
    },
    classifyFailure: classify,
  };
  return { transport, requests };
}

async function makeStep(
  dir: string,
  overrides: Partial<StepSpec> = {},
): Promise<StepSpec> {
  const systemPromptPath = path.join(dir, "system.md");
  await writeFile(systemPromptPath, "system prompt");
  return {
    name: "hunter-reliability",
    systemPromptPath,
    prompt: "Review diff",
    tools: [],
    mcpConfigPath: path.join(dir, "mcp.json"),
    model: "claude-sonnet-4-5",
    effort: "high",
    cwd: dir,
    outPath: path.join(dir, "out.json"),
    timeoutMs: 5_000,
    maxAttempts: 2,
    parse: (text) => JSON.parse(text),
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-harness-retry-"));
  await mkdir(path.join(dir, "logs"), { recursive: true });
  return dir;
}

describe("PR0 — live retry decision (§7)", () => {
  // 0.1 RED
  test("a transport classified rate_limit makes the harness sleep before the next attempt", async () => {
    const dir = await tempDir();
    const trace: string[] = [];
    const { transport, requests } = makeScriptedTransport(
      [failOutcome(), okOutcome()],
      () => "rate_limit",
    );
    const scriptedExecute = transport.execute;
    transport.execute = async (request, context) => {
      trace.push(`execute:${request.attempt}`);
      return scriptedExecute(request, context);
    };
    const sleepCalls: number[] = [];
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        trace.push(`sleep:${ms}`);
      },
    });
    const step = await makeStep(dir);

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(requests.length).toBe(2);
    // §7 line 416: a rate_limit cause backs off (capped exponential, base
    // 1000ms) instead of retrying instantly — the legacy loop had no delay
    // concept at all, so this is impossible to pass unwired.
    expect(sleepCalls).toEqual([1_000]);
    expect(trace).toEqual(["execute:1", "sleep:1000", "execute:2"]);
  });

  // 0.2 RED — delta row 2: the legacy loop's unconditional `break` after a
  // format retry forfeits the ENTIRE remaining transient budget the moment a
  // format-reminder retry fails to deliver, even for an unrelated transient
  // cause. No existing test pins this: it is invisible to the current suite.
  test("a format retry that fails to deliver does not forfeit the transient budget", async () => {
    const dir = await tempDir();
    // attempt 1: unrecognized failure -> format_violation -> format retry.
    // attempt 2 (the format retry): transport says network_transient.
    // attempt 3: succeeds. Legacy would have stopped dead after attempt 2
    // (the unconditional `break` following a failed format retry).
    let call = 0;
    const { transport, requests } = makeScriptedTransport(
      [failOutcome(), failOutcome(), okOutcome()],
      () => {
        call++;
        return call === 2 ? "network_transient" : undefined;
      },
    );
    const step = await makeStep(dir, { maxAttempts: 2 });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const outcome = await harness.run(step);

    expect(outcome.status).toBe("ok");
    expect(outcome.attempts).toBe(3);
    expect(requests.length).toBe(3);
    expect(requests[1]?.userPrompt).toContain("REMINDER");
  });

  // 0.3 RED — D3: the new transient budget MUST bind to the existing
  // per-step `maxAttempts` knob, not failure-policy's own defaults (which
  // would silently raise worst-case spawns from 3 to 5 — a 67% cost hike).
  test("maxTransientAttempts binds to step.maxAttempts-1, capping worst-case spawns", async () => {
    const dir = await tempDir();
    const alwaysTransient = Array.from({ length: 6 }, () => failOutcome());
    const { transport, requests } = makeScriptedTransport(
      alwaysTransient,
      () => "network_transient",
    );
    const step = await makeStep(dir, { maxAttempts: 3 });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const result = await harness.run(step);

    expect(result.status).toBe("failed");
    // 1 initial + (maxAttempts - 1) transient retries = maxAttempts, never
    // the module default's 1 + 3 = 4.
    expect(requests.length).toBe(3);
    expect(result.attempts).toBe(3);
  });

  // 0.4 RED — a watchdog timeout must be attributable in the persisted
  // attempt log distinctly from a plain network failure; the legacy loop
  // collapsed both into the same "transient" classification with no way to
  // tell them apart during incident triage.
  test("watchdog_timeout is recorded distinctly from network_transient in the attempt log", async () => {
    const dir = await tempDir();
    const { transport } = makeScriptedTransport(
      [
        failOutcome({ timedOut: true }),
        failOutcome({ timedOut: false }),
        okOutcome(),
      ],
      () => "network_transient",
    );
    const step = await makeStep(dir, { maxAttempts: 3 });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const result = await harness.run(step);
    expect(result.status).toBe("ok");

    const logsDir = path.join(dir, "logs");
    const first = await Bun.file(
      path.join(logsDir, `${step.name}.1.log`),
    ).text();
    const second = await Bun.file(
      path.join(logsDir, `${step.name}.2.log`),
    ).text();

    // Both attempts legacy-classify as "transient" (preserved vocabulary —
    // test/step-runner.test.ts pins this literal), but the new §7 cause line
    // tells them apart.
    expect(first).toContain("classification: transient");
    expect(first).toContain("cause: watchdog_timeout");
    expect(second).toContain("classification: transient");
    expect(second).toContain("cause: network_transient");
  });

  // #126: moving the transport's own tallies off the classification witness
  // is only half the fix — they still have to be READABLE, or the change
  // trades a wrong retry disposition for a blind incident triage. The attempt
  // log is where they land, redacted like everything else that hits disk.
  test("transport diagnostics are persisted beside the witness, not inside it", async () => {
    const dir = await tempDir();
    const { transport } = makeScriptedTransport(
      [
        failOutcome({
          stderrTail: "[pr-hero] opencode sdk: stream errored: boom",
          diagnosticsTail:
            "[pr-hero] opencode sdk: 429 poll round(s) timed out; timeouts cannot win the terminal slot",
        }),
        okOutcome(),
      ],
      () => "network_transient",
    );
    const step = await makeStep(dir, { maxAttempts: 2 });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    await harness.run(step);

    const first = await Bun.file(
      path.join(dir, "logs", `${step.name}.1.log`),
    ).text();

    expect(first).toContain("--- transport diagnostics ---");
    expect(first).toContain("429 poll round(s) timed out");
    // The witness section keeps the provider's words and nothing else.
    const witnessSection = first.slice(
      first.indexOf("--- stderr tail (4096) ---"),
      first.indexOf("--- transport diagnostics ---"),
    );
    expect(witnessSection).toContain("stream errored: boom");
    expect(witnessSection).not.toContain("poll round(s) timed out");
  });

  // #175 half 2: the observed models are only worth parsing if a human can
  // read them back. The attempt log is where they stop -- see the "where it
  // stops" note on TransportOutcome.observedModels.
  test("observed models are persisted in the attempt log", async () => {
    const dir = await tempDir();
    const { transport } = makeScriptedTransport(
      [
        failOutcome({
          observedModels: [
            {
              model: "claude-haiku-4-5-20251001",
              canonicalModel: "claude-haiku-4-5",
            },
            { model: "claude-sonnet-5-20260115" },
          ],
        }),
        okOutcome(),
      ],
      () => "network_transient",
    );
    const step = await makeStep(dir, { maxAttempts: 2 });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    await harness.run(step);

    const first = await Bun.file(
      path.join(dir, "logs", `${step.name}.1.log`),
    ).text();
    const second = await Bun.file(
      path.join(dir, "logs", `${step.name}.2.log`),
    ).text();

    expect(first).toContain("--- observed models ---");
    expect(first).toContain(
      "claude-haiku-4-5-20251001 (canonical: claude-haiku-4-5)",
    );
    expect(first).toContain("claude-sonnet-5-20260115");
    // The section is written even when nothing was observed, so the log
    // format is fixed rather than varying with what an attempt happened to
    // see -- the same rule the transport-diagnostics section follows.
    expect(second).toContain("--- observed models ---");
  });

  test("a watchdog-killed attempt flushes its attempt log with timed_out: true (#185)", async () => {
    const dir = await tempDir();
    let calls = 0;
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => CAPABILITIES,
      execute: async (_req, { signal }) => {
        calls++;
        if (calls === 1) {
          return new Promise<TransportOutcome>((resolve) => {
            signal.addEventListener("abort", () => {
              resolve(failOutcome({ timedOut: true }));
            });
          });
        }
        return okOutcome();
      },
      classifyFailure: () => undefined,
    };

    const step = await makeStep(dir, {
      timeoutMs: 30,
      maxAttempts: 2,
    });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(calls).toBe(2);

    const firstLog = await Bun.file(
      path.join(dir, "logs", `${step.name}.1.log`),
    ).text();
    expect(firstLog).toContain("timed_out: true");
    expect(firstLog).toContain("classification: transient");
    expect(firstLog).toContain("cause: watchdog_timeout");
    expect(firstLog).toContain("Step timed out after 30ms");

    const firstReceipt = JSON.parse(
      await Bun.file(
        path.join(dir, `settlement.${step.name}.attempt1.json`),
      ).text(),
    );
    expect(firstReceipt.lateWriteFence.closed).toBe(true);
    expect(firstReceipt.lateWriteFence.rejectedEvents).toBe(1);

    const secondLog = await Bun.file(
      path.join(dir, "logs", `${step.name}.2.log`),
    ).text();
    expect(secondLog).toContain("timed_out: false");
    expect(secondLog).toContain("classification: ok");
  });
});

describe("PR0 — tripwire: classifyFailure ownership (D1-08 spec)", () => {
  // 0.5 RED tripwire.
  test("harness.ts never imports the legacy classifyFailure and only references this.transport.classifyFailure", () => {
    const src = readFileSync(
      path.join(import.meta.dir, "../../src/execution/harness.ts"),
      "utf8",
    );

    const stepRunnerImport = src.match(
      /import\s+(?:type\s+)?\{([^{}]*)\}\s*from\s*"#review\/step-runner"/,
    );
    expect(stepRunnerImport).not.toBeNull();
    expect((stepRunnerImport as RegExpMatchArray)[1]).not.toMatch(
      /\bclassifyFailure\b/,
    );

    const lines = src.split("\n");
    const hitLines = lines.filter((line) => line.includes("classifyFailure"));
    expect(hitLines.length).toBeGreaterThan(0);
    for (const line of hitLines) {
      expect(line).toMatch(/(\bthis\.)?transport\.classifyFailure/);
      // Never a bound method (`.bind(`) or a lambda re-implementing it
      // (would look like `(outcome) => classifyFailure(...)` or similar).
      expect(line).not.toMatch(/classifyFailure\s*\.bind\(/);
      expect(line).not.toMatch(/=>\s*.*classifyFailure\(/);
    }
  });
});

describe("vacuous hunt is not a delivered draft (#214, #299)", () => {
  test("tools + zero invocations + empty findings fails the step without a format retry", async () => {
    const dir = await tempDir();
    const { transport, requests } = makeScriptedTransport([
      { ...okOutcome(), toolInvocations: 0 },
    ]);
    const step = await makeStep(dir, {
      tools: ["Read", "Grep"],
      maxAttempts: 2,
    });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const result = await harness.run(step);

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(requests.length).toBe(1);
    expect(await Bun.file(step.outPath).exists()).toBe(false);

    const log = await Bun.file(
      path.join(dir, "logs", `${step.name}.1.log`),
    ).text();
    expect(log).toContain("classification: terminal");
    expect(log).toContain("cause: legacy_terminal");
    expect(log).toContain("tool_invocations: 0");
    expect(log).not.toContain("classification: format");
  });

  test("tools + zero invocations + a finding fails the step too (#299)", async () => {
    // df63033a-2: a logic hunter returned one finding "inferred from the
    // diff" with zero tool calls and the old, empty-only gate delivered it.
    const dir = await tempDir();
    const { transport, requests } = makeScriptedTransport([
      {
        ...okOutcome(),
        finalText: JSON.stringify({ findings: [{ id: "F001" }] }),
        toolInvocations: 0,
      },
    ]);
    const step = await makeStep(dir, {
      tools: ["Read", "Grep"],
      maxAttempts: 2,
    });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const result = await harness.run(step);

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(requests.length).toBe(1);
    expect(await Bun.file(step.outPath).exists()).toBe(false);

    const log = await Bun.file(
      path.join(dir, "logs", `${step.name}.1.log`),
    ).text();
    expect(log).toContain("cause: legacy_terminal");
    expect(log).toContain("tool_invocations: 0");
  });

  test("a finding backed by a tool call still delivers (#299)", async () => {
    const dir = await tempDir();
    const finding = { findings: [{ id: "F001" }] };
    const { transport } = makeScriptedTransport([
      {
        ...okOutcome(),
        finalText: JSON.stringify(finding),
        toolInvocations: 3,
      },
    ]);
    const step = await makeStep(dir, { tools: ["Read"] });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(result.output).toEqual(finding);
  });

  test("a non-hunter shape with tools and zero invocations still delivers (#299)", async () => {
    // Refuter `results` and summarizer prose carry no findings array: the
    // widened gate must not reach them.
    for (const body of [
      { results: [{ finding_id: "F001", outcome: "refuted", proof_refs: [] }] },
      { prose: "p", score: 3, score_reason: "r" },
    ]) {
      const dir = await tempDir();
      const { transport } = makeScriptedTransport([
        {
          ...okOutcome(),
          finalText: JSON.stringify(body),
          toolInvocations: 0,
        },
      ]);
      const step = await makeStep(dir, {
        name: "refuter-F001",
        tools: ["Read"],
      });
      const harness = new StepExecutionHarness({
        transport,
        spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
        sleep: async () => {},
      });

      const result = await harness.run(step);
      expect(result.status).toBe("ok");
    }
  });

  test("looked and found nothing still delivers", async () => {
    const dir = await tempDir();
    const { transport } = makeScriptedTransport([
      { ...okOutcome(), toolInvocations: 1 },
    ]);
    const step = await makeStep(dir, { tools: ["Read"] });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ findings: [] });
    expect(await Bun.file(step.outPath).json()).toEqual({ findings: [] });
  });

  test("scout tools:[] at zero invocations still delivers", async () => {
    const dir = await tempDir();
    const { transport } = makeScriptedTransport([
      { ...okOutcome(), toolInvocations: 0 },
    ]);
    const step = await makeStep(dir, {
      name: "scout",
      tools: [],
    });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const result = await harness.run(step);
    expect(result.status).toBe("ok");
  });

  test("an unknown count stays ungated (Claude-shaped transport)", async () => {
    const dir = await tempDir();
    const { transport } = makeScriptedTransport([okOutcome()]);
    const step = await makeStep(dir, { tools: ["Read"] });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const result = await harness.run(step);
    expect(result.status).toBe("ok");

    const log = await Bun.file(
      path.join(dir, "logs", `${step.name}.1.log`),
    ).text();
    expect(log).toContain("classification: ok");
    expect(log).not.toContain("tool_invocations:");
  });
});

describe("format violation records why the draft was rejected", () => {
  test("the attempt log carries the parse error, so triage need not reverse-engineer it", async () => {
    const dir = await tempDir();
    const { transport } = makeScriptedTransport([okOutcome()]);
    const step = await makeStep(dir, {
      maxAttempts: 1,
      parse: () => {
        throw new Error(
          "finding RES-6 proof_refs cite paths absent from the reviewed tree: Foo.java:1",
        );
      },
    });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    const result = await harness.run(step);

    expect(result.status).toBe("failed");
    const log = await Bun.file(
      path.join(dir, "logs", `${step.name}.1.log`),
    ).text();
    expect(log).toContain("cause: format_violation");
    expect(log).toContain(
      "parse_error: finding RES-6 proof_refs cite paths absent from the reviewed tree: Foo.java:1",
    );
  });

  test("a write failure after a good parse is not reported as a parse error", async () => {
    // pr-hero F002 on #396: the catch also wraps the artifact writes, so a
    // persistence failure must not be logged as the parser's verdict.
    const dir = await tempDir();
    const { transport } = makeScriptedTransport([okOutcome()]);
    const blocked = path.join(dir, "blocked");
    await mkdir(blocked, { recursive: true });
    const step = await makeStep(dir, { maxAttempts: 1, outPath: blocked });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    expect((await harness.run(step)).status).toBe("failed");
    const log = await Bun.file(
      path.join(dir, "logs", `${step.name}.1.log`),
    ).text();
    expect(log).not.toContain("parse_error:");
  });

  test("a delivered attempt writes no parse_error line", async () => {
    const dir = await tempDir();
    const { transport } = makeScriptedTransport([okOutcome()]);
    const step = await makeStep(dir, { maxAttempts: 1 });
    const harness = new StepExecutionHarness({
      transport,
      spawnFn: (() => ({}) as unknown) as typeof Bun.spawn,
      sleep: async () => {},
    });

    expect((await harness.run(step)).status).toBe("ok");
    const log = await Bun.file(
      path.join(dir, "logs", `${step.name}.1.log`),
    ).text();
    expect(log).not.toContain("parse_error:");
  });
});
