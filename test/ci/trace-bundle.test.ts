import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  buildTraceBundle,
  encodeTrace,
  GENAI_SEMCONV_VERSION,
  type KeyValue,
  type OtlpSpan,
  snakeKey,
  type TraceBundle,
  type TraceCodec,
  type TraceRunInput,
} from "../../src/ci/trace-bundle";
import { redactSessionJsonl } from "../../src/execution/claude-session-trace";

const HEAD = "067297acd7e7aac125a156bf597f4d05d255659e";
const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const SYSTEM_PROMPT = "PLANTED-SYSTEM you are the reliability hunter";
const USER_PROMPT = "PLANTED-PROMPT review this diff";
const ANSWER = "PLANTED-ANSWER one finding";
const THINKING = "PLANTED-THINKING the cache is stale";
const TOOL_ARGS = { file_path: "src/secret.ts" };
const TOOL_RESULT = "PLANTED-RESULT export const x = 1";
const CLAIM = "PLANTED-CLAIM stale derived state";
const FAILURE = "PLANTED-FAILURE the provider said no";
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function usage(over: Record<string, unknown> = {}) {
  return {
    wallMs: 24040,
    tokens: {
      inputUncached: 8,
      inputCacheRead: 47217,
      inputCacheWrite: 14487,
      outputVisible: 2548,
      outputReasoning: 100,
    },
    completeness: "complete",
    billingMode: "subscription",
    costSource: "subscription",
    cashCostUsd: 0,
    notionalCostUsd: 0.0881657,
    ...over,
  };
}

function evidence(
  step: string,
  attempt: number,
  model: string,
  completion: "success" | "failed",
  startS: number,
  endS: number,
) {
  return {
    schemaVersion: 1,
    sessionId: `${step}-${attempt}`,
    attempt,
    stepName: step,
    identity: {
      route: {
        backend: model.startsWith("opencode:") ? "opencode" : "claude-code",
        provider: model.startsWith("opencode:") ? "openai" : "anthropic",
        modelSnapshot: model,
      },
      executionModel: model,
    },
    settlement: {
      outcome: completion === "success" ? "completed" : "failed",
      timestamps: { startedAt: at(startS), settledAt: at(endS) },
    },
    delivered: completion === "success",
    outcome: {
      completion,
      protocolIntegrity: "verified",
      usage: usage(),
    },
  };
}

// A Claude CLI session: the prompt, a thinking block, a tool call answered one
// second later, then the final text, the way the CLI writes one line per block.
function claudeSession(): string {
  const lines = [
    {
      type: "user",
      timestamp: at(1),
      message: { role: "user", content: USER_PROMPT },
    },
    {
      type: "assistant",
      timestamp: at(2),
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-5",
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "thinking", thinking: THINKING }],
      },
    },
    {
      type: "assistant",
      timestamp: at(3),
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-5",
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Read", input: TOOL_ARGS },
        ],
      },
    },
    {
      type: "user",
      timestamp: at(4),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: TOOL_RESULT },
        ],
      },
    },
    {
      type: "assistant",
      timestamp: at(5),
      message: {
        id: "msg_2",
        model: "claude-sonnet-4-5",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: ANSWER }],
      },
    },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

// An OpenCode capture whose readback holds a grep call. The capture still holds
// an `apiToken` value, as redactEvidence leaves it (L29).
function openCodeCapture(): string {
  return JSON.stringify({
    schemaVersion: 1,
    sessionId: "ses_1",
    attempt: 1,
    records: [
      {
        seq: 1,
        observedMs: T0 + 10_000,
        kind: "http_request",
        data: { apiToken: SECRET },
      },
      {
        seq: 2,
        observedMs: T0 + 14_000,
        kind: "readback",
        data: {
          messages: [
            {
              info: { id: "m1", role: "user" },
              parts: [{ id: "p1", type: "text", text: USER_PROMPT }],
            },
            {
              info: {
                id: "m2",
                role: "assistant",
                modelID: "gpt-5",
                finish: "stop",
              },
              parts: [
                {
                  id: "p2",
                  type: "tool",
                  tool: "grep",
                  callID: "call_1",
                  state: {
                    status: "completed",
                    input: { pattern: "x" },
                    output: TOOL_RESULT,
                    time: { start: T0 + 11_000, end: T0 + 12_000 },
                  },
                },
                { id: "p3", type: "text", text: ANSWER },
              ],
            },
          ],
        },
      },
    ],
  });
}

const HUNTER_STEP = {
  name: "hunter-reliability",
  model: "sonnet",
  effort: "xhigh",
  effort_applied: true,
  tools: ["Read", "Grep"],
  systemPromptPath: "/runner/runs/pr-7/steps/hunter-reliability.system.md",
  outPath: "/runner/runs/pr-7/steps/hunter-reliability.draft.json",
  status: "ok",
  attempts: 1,
  attemptEvidencePath: "steps/evidence.hunter-reliability.attempt1.json",
  tracePaths: ["steps/trace.hunter-reliability.attempt1.jsonl"],
  route: {
    backend: "claude-code",
    provider: "anthropic",
    gateway: "direct",
    modelFamily: "sonnet",
    modelSnapshot: "sonnet",
  },
  usage_v2: usage(),
  reservations: [{ reservationId: "r-1", state: "settled" }],
};

const REFUTER_STEP = {
  name: "refuter-F001",
  model: "opencode:openai/gpt-5",
  effort: "high",
  tools: [],
  systemPromptPath: "/runner/runs/pr-7/steps/refuter.system.md",
  outPath: "/runner/runs/pr-7/steps/refuter-F001.result.json",
  status: "ok",
  attempts: 1,
  usage_v2: usage({ billingMode: "metered", cashCostUsd: 0.25 }),
};

function reviewedRun(): TraceRunInput {
  return {
    outcome: "reviewed",
    code: null,
    cli: { v: 1, outcome: "reviewed", head_sha: HEAD },
    pipeline: {
      schema_version: "1.0.0",
      head_sha: HEAD,
      engine: { name: "pr-hero", version: "1.4.2" },
      route_plan: {
        steps: [
          { stepKey: "hunter-reliability", role: "hunter" },
          { stepKey: "refuter-F001", role: "refuter" },
        ],
      },
      routePlan: { steps: [] },
      scout: { enabled: false, status: "skipped", leads_truncated: 0 },
      consolidation: { status: "ok", findings_in: 2, findings_out: 1 },
      steps: [HUNTER_STEP, REFUTER_STEP],
    },
    findings: {
      schema_version: "1.1.0",
      model: "sonnet",
      run_status: "complete",
      findings: [
        {
          id: "F001",
          tier: "blocking",
          refuter_verdict: "corroborated",
          claim: CLAIM,
        },
      ],
      debug: { refuted: [], deduped: [{ kept: "F001", merged: "F002" }] },
    },
    steps: [
      {
        name: "hunter-reliability",
        systemPrompt: SYSTEM_PROMPT,
        output: '{"findings":[]}',
        attempts: [
          {
            attempt: 1,
            evidence: evidence(
              "hunter-reliability",
              1,
              "sonnet",
              "success",
              1,
              6,
            ),
            sessionJsonl: claudeSession(),
          },
        ],
      },
      {
        name: "refuter-F001",
        systemPrompt: SYSTEM_PROMPT,
        attempts: [
          {
            attempt: 1,
            evidence: evidence(
              "refuter-F001",
              1,
              "opencode:openai/gpt-5",
              "success",
              10,
              15,
            ),
            openCodeCapture: openCodeCapture(),
          },
        ],
      },
    ],
    prNumber: 7,
    headSha: HEAD,
    engineVersion: "1.4.2",
    startedAtMs: T0,
    endedAtMs: T0 + 20_000,
  };
}

function huntersFailedRun(): TraceRunInput {
  const failedStep = {
    ...HUNTER_STEP,
    status: "failed",
    attempts: 2,
    failure: FAILURE,
    model_attempts: [
      {
        model: "sonnet",
        route: HUNTER_STEP.route,
        status: "failed",
        attempts: 2,
        effort: "xhigh",
        effort_applied: true,
        cause: "quota_exhausted",
      },
    ],
  };
  return {
    outcome: "hunters-failed",
    code: "CRYSK-PROVIDER-LIMITED",
    cli: {
      v: 1,
      outcome: "hunters-failed",
      head_sha: HEAD,
      hunter_failures: [
        { cause: "quota_exhausted", provider: "anthropic", detail: FAILURE },
      ],
    },
    pipeline: { engine: { version: "1.4.2" }, steps: [failedStep] },
    steps: [
      {
        name: "hunter-reliability",
        attempts: [1, 2].map((n) => ({
          attempt: n,
          evidence: evidence("hunter-reliability", n, "sonnet", "failed", n, n),
        })),
      },
    ],
    prNumber: 7,
    headSha: HEAD,
    engineVersion: "1.4.2",
    startedAtMs: T0,
    endedAtMs: T0 + 9_000,
  };
}

// No run directory: the CLI refused at admission and left only cli.json.
function admissionRefusal(): TraceRunInput {
  return {
    outcome: "error",
    code: "CRYSK-CRED-UNUSABLE",
    cli: {
      v: 1,
      outcome: "error",
      cls: { kind: "credential", failureClass: "missing_provider_record" },
      params: { provider: "openai", backend: "opencode" },
    },
    steps: [],
    prNumber: 7,
    headSha: HEAD,
    engineVersion: "1.4.2",
    startedAtMs: T0,
    endedAtMs: T0 + 3_000,
  };
}

function spans(bundle: TraceBundle): OtlpSpan[] {
  return bundle.otlp.resourceSpans.flatMap((r) =>
    r.scopeSpans.flatMap((s) => s.spans),
  );
}

function attr(span: OtlpSpan | undefined, key: string): unknown {
  const value = span?.attributes.find((item) => item.key === key)?.value;
  if (value === undefined) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  return value.arrayValue.values.map((item) =>
    "stringValue" in item ? item.stringValue : item,
  );
}

function named(bundle: TraceBundle, name: string): OtlpSpan {
  const span = spans(bundle).find((item) => item.name === name);
  if (span === undefined) throw new Error(`no span named ${name}`);
  return span;
}

const nanos = (seconds: number) =>
  String(BigInt(T0 + seconds * 1000) * 1_000_000n);

const CONTENT_KEYS = [
  "gen_ai.system_instructions",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
];

describe("buildTraceBundle: a reviewed run", () => {
  const bundle = buildTraceBundle(reviewedRun(), true);
  const all = spans(bundle);
  const root = named(bundle, "invoke_workflow crysk.review");
  const hunter = named(bundle, "invoke_agent hunter-reliability");
  const chat = named(bundle, "chat sonnet");
  const read = named(bundle, "execute_tool Read");

  test("one root, a step per pipeline step, a chat per attempt, a tool span per call", () => {
    expect(all.map((span) => span.name)).toEqual([
      "invoke_workflow crysk.review",
      "invoke_agent hunter-reliability",
      "chat sonnet",
      "execute_tool Read",
      "invoke_agent refuter-F001",
      "chat opencode:openai/gpt-5",
      "execute_tool grep",
    ]);
    expect(root.parentSpanId).toBeUndefined();
    expect(hunter.parentSpanId).toBe(root.spanId);
    expect(chat.parentSpanId).toBe(hunter.spanId);
    expect(read.parentSpanId).toBe(chat.spanId);
    expect(new Set(all.map((span) => span.traceId)).size).toBe(1);
    expect(new Set(all.map((span) => span.spanId)).size).toBe(all.length);
  });

  test("the operation names follow the GenAI conventions", () => {
    expect(all.map((span) => attr(span, "gen_ai.operation.name"))).toEqual([
      "invoke_workflow",
      "invoke_agent",
      "chat",
      "execute_tool",
      "invoke_agent",
      "chat",
      "execute_tool",
    ]);
  });

  test("the root names the run", () => {
    expect(bundle.outcome).toBe("reviewed");
    expect(bundle.code).toBeNull();
    expect(attr(root, "crysk.run.outcome")).toBe("reviewed");
    expect(attr(root, "crysk.run.status")).toBe("complete");
    expect(attr(root, "crysk.pr.number")).toBe(7);
    expect(attr(root, "crysk.engine.version")).toBe("1.4.2");
    expect(attr(root, "crysk.head.sha")).toBe(HEAD);
    expect(attr(root, "crysk.model.setup")).toBe("sonnet");
    expect(attr(root, "crysk.genai.semconv")).toBe(GENAI_SEMCONV_VERSION);
    expect(root.status).toEqual({ code: 1 });
  });

  test("the stage outcomes of pipeline.json and findings.json ride on the root", () => {
    expect(attr(root, "crysk.pipeline.consolidation.findings_in")).toBe(2);
    expect(attr(root, "crysk.pipeline.scout.leads_truncated")).toBe(0);
    expect(attr(root, "crysk.findings.findings.0.refuter_verdict")).toBe(
      "corroborated",
    );
    expect(attr(root, "crysk.findings.debug.deduped.0.merged")).toBe("F002");
    // camelCase duplicates of route_plan are not repeated.
    expect(
      root.attributes.some((item) =>
        item.key.startsWith("crysk.pipeline.route_plan_"),
      ),
    ).toBe(false);
  });

  test("a chat span carries the model, provider, inclusive usage and list cost", () => {
    expect(attr(chat, "gen_ai.provider.name")).toBe("anthropic");
    expect(attr(chat, "gen_ai.request.model")).toBe("sonnet");
    expect(attr(chat, "gen_ai.response.model")).toBe("claude-sonnet-4-5");
    expect(attr(chat, "gen_ai.response.finish_reasons")).toEqual(["end_turn"]);
    // Input counts the cache, output the reasoning (the conventions' totals).
    expect(attr(chat, "gen_ai.usage.input_tokens")).toBe(8 + 47217 + 14487);
    expect(attr(chat, "gen_ai.usage.output_tokens")).toBe(2548 + 100);
    expect(attr(chat, "gen_ai.usage.cache_read.input_tokens")).toBe(47217);
    expect(attr(chat, "gen_ai.usage.cache_creation.input_tokens")).toBe(14487);
    expect(attr(chat, "gen_ai.usage.reasoning.output_tokens")).toBe(100);
    expect(attr(chat, "gen_ai.usage.cost")).toBe(0.0881657);
    expect(attr(chat, "crysk.attempt.number")).toBe(1);
    expect(attr(chat, "crysk.attempt.status")).toBe("success");
  });

  test("a metered attempt's cost is its cash cost", () => {
    const opencode = buildTraceBundle(
      {
        ...reviewedRun(),
        steps: [
          {
            name: "refuter-F001",
            attempts: [
              {
                attempt: 1,
                evidence: {
                  ...evidence("refuter-F001", 1, "gpt", "success", 1, 2),
                  outcome: {
                    completion: "success",
                    usage: usage({ billingMode: "metered", cashCostUsd: 0.25 }),
                  },
                },
              },
            ],
          },
        ],
      },
      false,
    );
    expect(attr(named(opencode, "chat gpt"), "gen_ai.usage.cost")).toBe(0.25);
  });

  test("usage and cost sit on the chat span only, never on its step or the root", () => {
    for (const span of [root, hunter, read]) {
      expect(attr(span, "gen_ai.usage.input_tokens")).toBeUndefined();
      expect(attr(span, "gen_ai.usage.cost")).toBeUndefined();
    }
  });

  test("every span has both times, and each one is from the run's records", () => {
    expect(chat.startTimeUnixNano).toBe(nanos(1));
    expect(chat.endTimeUnixNano).toBe(nanos(6));
    expect(read.startTimeUnixNano).toBe(nanos(3));
    expect(read.endTimeUnixNano).toBe(nanos(4));
    expect(hunter.startTimeUnixNano).toBe(nanos(1));
    expect(hunter.endTimeUnixNano).toBe(nanos(6));
    expect(named(bundle, "execute_tool grep").startTimeUnixNano).toBe(
      nanos(11),
    );
    expect(root.startTimeUnixNano).toBe(nanos(0));
    expect(root.endTimeUnixNano).toBe(nanos(20));
    for (const span of all) {
      expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(
        BigInt(span.startTimeUnixNano),
      );
    }
  });

  test("content: system prompt, messages and tool call follow the v1.41.0 message schema", () => {
    expect(
      JSON.parse(String(attr(chat, "gen_ai.system_instructions"))),
    ).toEqual([{ type: "text", content: SYSTEM_PROMPT }]);
    expect(JSON.parse(String(attr(chat, "gen_ai.input.messages")))).toEqual([
      { role: "user", parts: [{ type: "text", content: USER_PROMPT }] },
    ]);
    expect(JSON.parse(String(attr(chat, "gen_ai.output.messages")))).toEqual([
      {
        role: "assistant",
        finish_reason: "tool_use",
        parts: [
          { type: "reasoning", content: THINKING },
          {
            type: "tool_call",
            id: "toolu_1",
            name: "Read",
            arguments: TOOL_ARGS,
          },
        ],
      },
      {
        role: "assistant",
        finish_reason: "end_turn",
        parts: [{ type: "text", content: ANSWER }],
      },
    ]);
    expect(attr(read, "gen_ai.tool.name")).toBe("Read");
    expect(attr(read, "gen_ai.tool.call.id")).toBe("toolu_1");
    expect(
      JSON.parse(String(attr(read, "gen_ai.tool.call.arguments"))),
    ).toEqual(TOOL_ARGS);
    expect(attr(read, "gen_ai.tool.call.result")).toBe(TOOL_RESULT);
  });

  test("content: an OpenCode attempt's readback gives its messages and tool calls", () => {
    const grep = named(bundle, "execute_tool grep");
    expect(
      JSON.parse(String(attr(grep, "gen_ai.tool.call.arguments"))),
    ).toEqual({
      pattern: "x",
    });
    expect(attr(grep, "gen_ai.tool.call.result")).toBe(TOOL_RESULT);
    const opencode = named(bundle, "chat opencode:openai/gpt-5");
    expect(attr(opencode, "gen_ai.response.model")).toBe("gpt-5");
    expect(attr(opencode, "gen_ai.response.finish_reasons")).toEqual(["stop"]);
  });

  test("content: the raw transcripts ride along, the OpenCode capture redacted", () => {
    expect(
      bundle.transcripts.map(({ step, attempt, model, kind }) => ({
        step,
        attempt,
        model,
        kind,
      })),
    ).toEqual([
      {
        step: "hunter-reliability",
        attempt: 1,
        model: "sonnet",
        kind: "claude-session-jsonl",
      },
      {
        step: "refuter-F001",
        attempt: 1,
        model: "opencode:openai/gpt-5",
        kind: "opencode-capture",
      },
    ]);
    expect(bundle.transcripts[0]?.text).toBe(claudeSession());
    const capture = bundle.transcripts[1]?.text ?? "";
    expect(capture).not.toContain(SECRET);
    expect(JSON.parse(capture).records[0].data.apiToken).toBe("[REDACTED]");
  });

  test("content: a finding's claim reaches the root as text", () => {
    expect(attr(root, "crysk.findings.findings.0.claim")).toBe(CLAIM);
  });
});

describe("buildTraceBundle: trace_content false", () => {
  const bundle = buildTraceBundle(huntersFailedRun(), false);
  const reviewed = buildTraceBundle(reviewedRun(), false);

  test("no content attribute, no status message and no transcript", () => {
    for (const candidate of [bundle, reviewed]) {
      expect(candidate.content).toBe(false);
      expect(candidate.transcripts).toEqual([]);
      for (const span of spans(candidate)) {
        for (const key of CONTENT_KEYS) {
          expect(attr(span, key)).toBeUndefined();
        }
        expect(span.status).not.toHaveProperty("message");
      }
    }
  });

  test("no string attribute holds whitespace or anything past one word", () => {
    const text = (kv: KeyValue): string[] =>
      "stringValue" in kv.value
        ? [kv.value.stringValue]
        : "arrayValue" in kv.value
          ? kv.value.arrayValue.values.flatMap((item) =>
              "stringValue" in item ? [item.stringValue] : [],
            )
          : [];
    const strings = [bundle, reviewed].flatMap((candidate) =>
      spans(candidate).flatMap((span) => span.attributes.flatMap(text)),
    );
    expect(strings.length).toBeGreaterThan(0);
    expect(
      strings.filter((value) => !/^[\x21-\x7e]{1,200}$/.test(value)),
    ).toEqual([]);
    const serialized = JSON.stringify([bundle, reviewed]);
    for (const planted of [
      SYSTEM_PROMPT,
      USER_PROMPT,
      ANSWER,
      THINKING,
      TOOL_RESULT,
      CLAIM,
      FAILURE,
    ]) {
      expect(serialized).not.toContain(planted);
    }
  });

  test("the metadata stays: models, tokens, cost and times", () => {
    const chat = named(reviewed, "chat sonnet");
    expect(attr(chat, "gen_ai.request.model")).toBe("sonnet");
    expect(attr(chat, "gen_ai.usage.input_tokens")).toBe(8 + 47217 + 14487);
    expect(attr(chat, "gen_ai.usage.cost")).toBe(0.0881657);
    expect(attr(named(reviewed, "execute_tool Read"), "gen_ai.tool.name")).toBe(
      "Read",
    );
  });
});

describe("buildTraceBundle: findings in a metadata trace", () => {
  // Single words, so the word rule alone would let them through: each can
  // quote the customer's code, and platform-report.ts keeps them on the runner
  // for a metadata_only repository (METADATA_ONLY_FINDING_FIELDS).
  const SYMBOL = "PLANTED_SYMBOL_monthlyCosts";
  const DEDUPE = "src/secret.ts:PLANTED_DEDUPE:15";
  const HOP = "src/secret.ts:PLANTED_HOP";
  const PROOF = "src/secret.ts:PLANTED_PROOF";
  function run(): TraceRunInput {
    const base = reviewedRun();
    return {
      ...base,
      findings: {
        schema_version: "1.1.0",
        findings: [
          {
            id: "F001",
            path: "src/secret.ts",
            line: 42,
            tier: "blocking",
            refuter_verdict: "corroborated",
            symbol: SYMBOL,
            dedupe_key: DEDUPE,
            hop_trail: [HOP],
            proof_refs: [PROOF],
          },
        ],
        debug: {
          refuted: [{ id: "F009", symbol: SYMBOL }],
          deduped: [{ kept: "F001", dedupe_key: DEDUPE }],
          root_causes: {
            clusters: [{ ids: ["F001"] }],
            distinct_root_causes: 1,
          },
        },
      },
    };
  }

  test("each finding keeps only the report step's metadata fields", () => {
    const bundle = buildTraceBundle(run(), false);
    const serialized = JSON.stringify(bundle);
    for (const planted of [SYMBOL, DEDUPE, HOP, PROOF]) {
      expect(serialized).not.toContain(planted);
    }
    const root = named(bundle, "invoke_workflow crysk.review");
    expect(attr(root, "crysk.findings.findings.0.id")).toBe("F001");
    expect(attr(root, "crysk.findings.findings.0.path")).toBe("src/secret.ts");
    expect(attr(root, "crysk.findings.findings.0.tier")).toBe("blocking");
    expect(attr(root, "crysk.findings.findings.0.refuter_verdict")).toBe(
      "corroborated",
    );
  });

  test("the debug records become counts", () => {
    const root = named(
      buildTraceBundle(run(), false),
      "invoke_workflow crysk.review",
    );
    expect(attr(root, "crysk.findings.debug.refuted")).toBe(1);
    expect(attr(root, "crysk.findings.debug.deduped")).toBe(1);
    expect(attr(root, "crysk.findings.debug.root_causes.clusters")).toBe(1);
    expect(
      attr(root, "crysk.findings.debug.root_causes.distinct_root_causes"),
    ).toBe(1);
  });

  test("with content, the findings go whole", () => {
    const root = named(
      buildTraceBundle(run(), true),
      "invoke_workflow crysk.review",
    );
    expect(attr(root, "crysk.findings.findings.0.symbol")).toBe(SYMBOL);
    expect(attr(root, "crysk.findings.debug.deduped.0.dedupe_key")).toBe(
      DEDUPE,
    );
  });
});

describe("buildTraceBundle: a hunters-failed run", () => {
  const bundle = buildTraceBundle(huntersFailedRun(), true);
  const root = named(bundle, "invoke_workflow crysk.review");
  const step = named(bundle, "invoke_agent hunter-reliability");
  const chats = spans(bundle).filter((span) => span.name === "chat sonnet");

  test("the outcome and the code reach the bundle and the root", () => {
    expect(bundle.outcome).toBe("hunters-failed");
    expect(bundle.code).toBe("CRYSK-PROVIDER-LIMITED");
    expect(attr(root, "crysk.run.code")).toBe("CRYSK-PROVIDER-LIMITED");
    expect(attr(root, "crysk.cli.hunter_failures.0.cause")).toBe(
      "quota_exhausted",
    );
    expect(root.status).toEqual({ code: 2, message: "CRYSK-PROVIDER-LIMITED" });
  });

  test("each failed attempt is its own chat span with the model's cause", () => {
    expect(chats.map((span) => attr(span, "crysk.attempt.number"))).toEqual([
      1, 2,
    ]);
    for (const chat of chats) {
      expect(chat.status.code).toBe(2);
      expect(attr(chat, "crysk.attempt.cause")).toBe("quota_exhausted");
      expect(attr(chat, "crysk.attempt.status")).toBe("failed");
    }
    expect(step.status).toEqual({ code: 2, message: FAILURE });
    expect(attr(step, "crysk.step.status")).toBe("failed");
  });
});

describe("buildTraceBundle: an admission refusal with no run directory", () => {
  const bundle = buildTraceBundle(admissionRefusal(), false);
  const [root, ...rest] = spans(bundle);

  test("one root span with the outcome, the code and the CLI class", () => {
    expect(rest).toEqual([]);
    expect(bundle.outcome).toBe("error");
    expect(bundle.code).toBe("CRYSK-CRED-UNUSABLE");
    expect(root?.name).toBe("invoke_workflow crysk.review");
    expect(attr(root, "crysk.run.code")).toBe("CRYSK-CRED-UNUSABLE");
    expect(attr(root, "crysk.cli.class")).toBe("credential");
    expect(attr(root, "crysk.cli.params.provider")).toBe("openai");
    expect(root?.startTimeUnixNano).toBe(nanos(0));
    expect(root?.endTimeUnixNano).toBe(nanos(3));
    expect(root?.status).toEqual({ code: 2 });
  });
});

describe("every leaf of a pipeline.json step reaches its step span", () => {
  function leaves(value: unknown, prefix: string): Array<[string, unknown]> {
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item !== "object")) {
        return [[prefix, value]];
      }
      return value.flatMap((item, index) => leaves(item, `${prefix}.${index}`));
    }
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).flatMap(([key, item]) =>
        leaves(item, `${prefix}.${snakeKey(key)}`),
      );
    }
    return [[prefix, value]];
  }

  test.each([
    ["a reviewed step", reviewedRun(), "hunter-reliability", HUNTER_STEP],
    [
      "a failed step",
      huntersFailedRun(),
      "hunter-reliability",
      (huntersFailedRun().pipeline as { steps: unknown[] }).steps[0],
    ],
  ])("%s", (_label, run, name, meta) => {
    const span = named(buildTraceBundle(run, true), `invoke_agent ${name}`);
    const expected = leaves(meta, "crysk.step");
    expect(expected.length).toBeGreaterThan(10);
    for (const [key, value] of expected) {
      expect([key, attr(span, key)]).toEqual([key, value]);
    }
  });

  test("snake_case keys the platform's crysk.* rule accepts", () => {
    expect(snakeKey("attemptEvidencePath")).toBe("attempt_evidence_path");
    expect(snakeKey("usage_v2")).toBe("usage_v2");
    expect(snakeKey("inputCacheRead")).toBe("input_cache_read");
    expect(snakeKey("HTTPStatus")).toBe("http_status");
  });
});

describe("content redaction", () => {
  test("a secret in a prompt, a tool argument or a tool result never leaves", () => {
    const run = reviewedRun();
    const session = claudeSession()
      .replace(USER_PROMPT, `${USER_PROMPT} token=${SECRET}`)
      .replace(TOOL_RESULT, `${TOOL_RESULT} ${SECRET}`)
      .replace('"src/secret.ts"', `"${SECRET}"`);
    const steps = run.steps.map((step) =>
      step.name === "hunter-reliability"
        ? {
            ...step,
            systemPrompt: `${SYSTEM_PROMPT} ${SECRET}`,
            attempts: step.attempts.map((a) => ({
              ...a,
              sessionJsonl: session,
            })),
          }
        : step,
    );
    const bundle = buildTraceBundle({ ...run, steps }, true);
    // The transcript itself is the E1 copy, already redacted on the runner.
    const otlp = JSON.stringify(bundle.otlp);
    expect(otlp).toContain(USER_PROMPT);
    expect(otlp).not.toContain(SECRET);
  });
});

// B1: the word rule let a single word through raw, so a bare key in a field
// such as a finding's symbol skipped redaction. Each key below is one word.
const KEYS = {
  anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ",
  aws: "AKIAIOSFODNN7EXAMPLE",
  openai: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  github: SECRET,
};
const leaked = (bundle: TraceBundle): string[] => {
  const serialized = JSON.stringify(bundle);
  return Object.values(KEYS).filter((key) => serialized.includes(key));
};

// Every string leaf of a record, replaced by a bare key.
function plantEvery(value: unknown): unknown {
  if (typeof value === "string") return KEYS.github;
  if (Array.isArray(value)) return value.map(plantEvery);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, plantEvery(item)]),
    );
  }
  return value;
}

// The reviewed run with a bare key in every string leaf of its records and as
// every step's name.
function plantedEverywhere(): TraceRunInput {
  const run = reviewedRun();
  return {
    ...run,
    cli: plantEvery(run.cli),
    pipeline: plantEvery(run.pipeline),
    findings: plantEvery(run.findings),
    steps: run.steps.map((step) => ({
      ...step,
      name: KEYS.github,
      attempts: step.attempts.map((attempt) => ({
        ...attempt,
        evidence: plantEvery(attempt.evidence),
      })),
    })),
  };
}

describe("redaction: a bare key in a single-word value", () => {
  // The finding fields the verifier found raw (content mode keeps them), and
  // leaves a metadata trace keeps too: a pipeline.json step leaf, an evidence
  // leaf, a cli.json leaf and a tool name.
  function plantedRun(): TraceRunInput {
    const run = reviewedRun();
    const findings = run.findings as { findings: Record<string, unknown>[] };
    const pipeline = run.pipeline as { steps: Record<string, unknown>[] };
    return {
      ...run,
      cli: { v: 1, outcome: "reviewed", cls: { kind: KEYS.anthropic } },
      pipeline: {
        ...pipeline,
        steps: [
          {
            ...HUNTER_STEP,
            route: { ...HUNTER_STEP.route, gateway: KEYS.aws },
          },
          REFUTER_STEP,
        ],
      },
      findings: {
        ...findings,
        findings: findings.findings.map((finding) => ({
          ...finding,
          symbol: KEYS.anthropic,
          dedupe_key: KEYS.aws,
          proof_refs: [KEYS.openai],
          hop_trail: [KEYS.github],
        })),
      },
      steps: run.steps.map((step) => ({
        ...step,
        attempts: step.attempts.map((attempt) => {
          const doc = attempt.evidence as {
            identity: { route: Record<string, unknown> };
          };
          return {
            ...attempt,
            evidence: {
              ...doc,
              identity: {
                ...doc.identity,
                route: { ...doc.identity.route, backend: KEYS.openai },
              },
            },
            // The OpenCode capture is redacted here. A Claude session is the
            // CLI's redacted copy already (redactSessionJsonl), the next test.
            ...(attempt.openCodeCapture === undefined
              ? {}
              : {
                  openCodeCapture: attempt.openCodeCapture.replace(
                    '"tool":"grep"',
                    `"tool":"${KEYS.github}"`,
                  ),
                }),
          };
        }),
      })),
    };
  }

  test.each([true, false])(
    "content %p: none of the planted keys leaves raw",
    (content) => {
      expect(leaked(buildTraceBundle(plantedRun(), content))).toEqual([]);
    },
  );

  // The trace step sends the session file the CLI wrote, whose copy ran
  // redactSessionJsonl; the bundle does not redact that text a second time.
  test("a Claude session as the CLI copies it carries no key", () => {
    const run = reviewedRun();
    const session = redactSessionJsonl(
      claudeSession().replace('"name":"Read"', `"name":"${KEYS.github}"`),
    );
    const steps = run.steps.map((step) => ({
      ...step,
      attempts: step.attempts.map((attempt) =>
        attempt.sessionJsonl === undefined
          ? attempt
          : { ...attempt, sessionJsonl: session },
      ),
    }));
    expect(leaked(buildTraceBundle({ ...run, steps }, true))).toEqual([]);
  });

  test("content true: the finding's single-word fields arrive redacted, not dropped", () => {
    const root = named(
      buildTraceBundle(plantedRun(), true),
      "invoke_workflow crysk.review",
    );
    expect(attr(root, "crysk.findings.findings.0.symbol")).toBe("[REDACTED]");
    expect(attr(root, "crysk.findings.findings.0.proof_refs")).toEqual([
      "[REDACTED]",
    ]);
  });

  test.each([true, false])(
    "content %p: a key in any string leaf of the run's records never leaves",
    (content) => {
      expect(leaked(buildTraceBundle(plantedEverywhere(), content))).toEqual(
        [],
      );
    },
  );
});

describe("encodeTrace: the size cap", () => {
  // The body uncompressed: pieces joined as they are, so a size is a JSON size.
  const codec = (
    piece: (bytes: Uint8Array) => Uint8Array = (bytes) => bytes,
  ): TraceCodec => ({
    overhead: 0,
    piece,
    join: (pieces) => Buffer.concat(pieces),
  });
  const identity = codec();
  const big = (char: string, size: number) => char.repeat(size);
  function run(): TraceRunInput {
    const base = reviewedRun();
    return {
      ...base,
      steps: base.steps.map((step) =>
        step.name === "hunter-reliability"
          ? {
              ...step,
              attempts: [
                ...step.attempts,
                {
                  attempt: 2,
                  evidence: evidence(
                    "hunter-reliability",
                    2,
                    "sonnet",
                    "success",
                    6,
                    7,
                  ),
                  sessionJsonl: big("b", 30_000),
                },
              ],
            }
          : step,
      ),
    };
  }
  const full = encodeTrace(
    run(),
    true,
    {
      compressed: Number.MAX_SAFE_INTEGER,
      decompressed: Number.MAX_SAFE_INTEGER,
    },
    identity,
  );
  const sizeOf = (bundle: TraceBundle) =>
    new TextEncoder().encode(JSON.stringify(bundle)).byteLength;

  test("a bundle under both caps is sent whole", () => {
    expect(full.ok && full.bundle.truncated).toBe(false);
    expect(full.ok && full.bundle.transcripts.length).toBe(3);
  });

  test("the largest transcript goes first, and truncated is set", () => {
    if (!full.ok) throw new Error("unreachable");
    const limit = sizeOf(full.bundle) - 1;
    const result = encodeTrace(
      run(),
      true,
      { compressed: limit, decompressed: Number.MAX_SAFE_INTEGER },
      identity,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.truncated).toBe(true);
    expect(result.droppedTranscripts).toBe(1);
    expect(result.droppedContent).toBe(false);
    expect(result.bundle.transcripts.map((t) => t.attempt)).toEqual([1, 1]);
    expect(
      attr(named(result.bundle, "chat sonnet"), "gen_ai.input.messages"),
    ).toBeDefined();
  });

  test("then every transcript, then the content; the metadata survives", () => {
    if (!full.ok) throw new Error("unreachable");
    const noTranscripts = sizeOf({
      ...full.bundle,
      transcripts: [],
      truncated: true,
    });
    const result = encodeTrace(
      run(),
      true,
      { compressed: Number.MAX_SAFE_INTEGER, decompressed: noTranscripts - 1 },
      identity,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedTranscripts).toBe(3);
    expect(result.droppedContent).toBe(true);
    expect(result.bundle.truncated).toBe(true);
    expect(result.bundle.content).toBe(true);
    expect(result.bundle.transcripts).toEqual([]);
    for (const span of spans(result.bundle)) {
      for (const key of CONTENT_KEYS) expect(attr(span, key)).toBeUndefined();
    }
    expect(
      attr(named(result.bundle, "chat sonnet"), "gen_ai.usage.input_tokens"),
    ).toBe(8 + 47217 + 14487);
    expect(new TextDecoder().decode(result.body)).toBe(
      JSON.stringify(result.bundle),
    );
  });

  test("an encoding that throws counts as over the cap, and the metadata still goes", () => {
    // JSON.stringify throws a RangeError past the engine's string limit; a
    // bundle that cannot be encoded must lose its transcripts, not the trace.
    const strict = codec((bytes) => {
      if (new TextDecoder().decode(bytes).includes("bbbb")) {
        throw new RangeError("Invalid string length");
      }
      return bytes;
    });
    const result = encodeTrace(
      run(),
      true,
      {
        compressed: Number.MAX_SAFE_INTEGER,
        decompressed: Number.MAX_SAFE_INTEGER,
      },
      strict,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedTranscripts).toBe(1);
    expect(result.bundle.truncated).toBe(true);
  });

  test("a bundle whose metadata alone is over a cap is not sent", () => {
    const result = encodeTrace(
      run(),
      true,
      { compressed: 100, decompressed: 100 },
      identity,
    );
    expect(result.ok).toBe(false);
  });

  // B2: the encoder re-encoded the whole bundle once per dropped transcript,
  // so its work grew with the square of the transcripts. Each transcript is
  // now compressed at most once, and the whole body at most three times.
  test("the work stays bounded however many transcripts must drop", () => {
    const base = reviewedRun();
    const sizes = Array.from({ length: 50 }, (_, i) => 1_000 + i * 97);
    const many: TraceRunInput = {
      ...base,
      steps: base.steps.map((step) =>
        step.name === "hunter-reliability"
          ? {
              ...step,
              attempts: sizes.map((size, i) => ({
                attempt: i + 1,
                evidence: evidence(
                  "hunter-reliability",
                  i + 1,
                  "sonnet",
                  "success",
                  1,
                  6,
                ),
                sessionJsonl: big("c", size),
              })),
            }
          : step,
      ),
    };
    const whole = encodeTrace(
      many,
      true,
      {
        compressed: Number.MAX_SAFE_INTEGER,
        decompressed: Number.MAX_SAFE_INTEGER,
      },
      identity,
    );
    if (!whole.ok) throw new Error("unreachable");
    const fullSize = sizeOf(whole.bundle);
    // Room for the metadata and content plus about half the transcripts.
    const withoutTranscripts = sizeOf({ ...whole.bundle, transcripts: [] });
    const limit =
      withoutTranscripts + Math.floor((fullSize - withoutTranscripts) / 2);
    let compressed = 0;
    const counting = codec((bytes) => {
      compressed += bytes.byteLength;
      return bytes;
    });
    const result = encodeTrace(
      many,
      true,
      { compressed: limit, decompressed: Number.MAX_SAFE_INTEGER },
      counting,
    );
    if (!result.ok) throw new Error("the capped trace was not built");
    expect(result.bundle.truncated).toBe(true);
    expect(result.body.byteLength).toBeLessThanOrEqual(limit);
    // The largest went first: what is left are the smallest.
    const kept = result.bundle.transcripts.map((t) => t.text.length);
    const smallest = [
      ...sizes,
      ...whole.bundle.transcripts
        .filter((t) => t.step !== "hunter-reliability")
        .map((t) => t.text.length),
    ]
      .sort((a, b) => a - b)
      .slice(0, kept.length);
    expect([...kept].sort((a, b) => a - b)).toEqual(smallest);
    expect(compressed).toBeLessThanOrEqual(fullSize + 3 * limit);
  });

  test("the default body is one gzip stream of the kept pieces", () => {
    const result = encodeTrace(run(), true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.bundle.transcripts.length).toBe(3);
    // gunzip checks the CRC-32 and the length of the joined pieces.
    expect(
      JSON.parse(new TextDecoder().decode(gunzipSync(result.body))),
    ).toEqual(result.bundle);
  });

  test("the body is gzip by default", () => {
    const result = encodeTrace(admissionRefusal(), false);
    if (!result.ok) throw new Error("unreachable");
    expect([...result.body.slice(0, 2)]).toEqual([0x1f, 0x8b]);
    expect(
      JSON.parse(new TextDecoder().decode(gunzipSync(result.body))),
    ).toEqual(result.bundle);
  });
});

// The platform's rules for a bundle, copied from
// cryskai/platform apps/api/src/runs/trace.ts (traceBundleSchema, CRYSK_CODE,
// CRYSK_KEY, SPAN_NAME). Tests never read the platform repository: when the
// platform changes, these copies change with it.
describe("contract: a built bundle passes the platform's traceBundleSchema", () => {
  const OUTCOMES = [
    "reviewed",
    "hunters-failed",
    "skipped",
    "yielded",
    "error",
  ];
  const KINDS = ["claude-session-jsonl", "opencode-capture", "system-prompt"];
  const CRYSK_CODE = /^CRYSK-[A-Z0-9-]{1,58}$/;
  const CRYSK_KEY = /^crysk\.[a-z0-9_.]{1,100}$/;
  const HEX_ID = /^[0-9a-fA-F]{1,32}$/;
  const DIGITS = /^\d+$/;

  function violations(bundle: TraceBundle): string[] {
    const out: string[] = [];
    if (bundle.schema !== "crysk.trace.v1") out.push("schema");
    if (!OUTCOMES.includes(bundle.outcome)) out.push("outcome");
    if (bundle.code !== null && !CRYSK_CODE.test(bundle.code)) out.push("code");
    if (typeof bundle.content !== "boolean") out.push("content");
    if (typeof bundle.truncated !== "boolean") out.push("truncated");
    if (!Array.isArray(bundle.otlp.resourceSpans)) out.push("resourceSpans");
    for (const t of bundle.transcripts) {
      if (t.step.length < 1 || t.step.length > 200) out.push("transcript.step");
      if (
        !Number.isInteger(t.attempt) ||
        t.attempt < 1 ||
        t.attempt > 100_000
      ) {
        out.push("transcript.attempt");
      }
      if (t.model.length > 200) out.push("transcript.model");
      if (!KINDS.includes(t.kind)) out.push("transcript.kind");
      if (typeof t.text !== "string") out.push("transcript.text");
    }
    for (const span of spans(bundle)) {
      if (!HEX_ID.test(span.spanId) || span.spanId.length !== 16) {
        out.push(`${span.name}: spanId`);
      }
      if (!/^[0-9a-f]{32}$/.test(span.traceId))
        out.push(`${span.name}: traceId`);
      if (!DIGITS.test(span.startTimeUnixNano)) out.push(`${span.name}: start`);
      if (!DIGITS.test(span.endTimeUnixNano)) out.push(`${span.name}: end`);
      for (const { key } of span.attributes) {
        // Unlisted crysk.* keys survive metadata mode only in this shape.
        if (key.startsWith("crysk.") && !CRYSK_KEY.test(key)) {
          out.push(`${span.name}: ${key}`);
        }
      }
    }
    return out;
  }

  test.each([
    ["reviewed, content", reviewedRun(), true],
    ["reviewed, metadata", reviewedRun(), false],
    ["hunters-failed", huntersFailedRun(), true],
    ["admission refusal", admissionRefusal(), false],
    // Redaction leaves `[REDACTED]` in names and values: still in shape.
    ["keys everywhere, content", plantedEverywhere(), true],
    ["keys everywhere, metadata", plantedEverywhere(), false],
  ] as const)("%s", (_label, run, content) => {
    const bundle = buildTraceBundle(run, content);
    expect(violations(bundle)).toEqual([]);
    // The body is JSON the platform's z.json() accepts: a round trip is exact.
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
  });

  test("a code the platform would drop is never built", () => {
    for (const run of [reviewedRun(), huntersFailedRun(), admissionRefusal()]) {
      const { code } = buildTraceBundle(run, false);
      expect(code === null || CRYSK_CODE.test(code)).toBe(true);
    }
  });
});
