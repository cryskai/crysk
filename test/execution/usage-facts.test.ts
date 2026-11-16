import { describe, expect, test } from "bun:test";
import {
  claudeAttemptUsageFacts,
  credentialOfBillingMode,
  openCodeAttemptUsageFacts,
} from "../../src/execution/usage-facts";

// One assistant line as the Claude CLI writes it in its session JSONL (shape read from a real
// session, CLI 2.1.x): `output_tokens` includes thinking, and `cache_creation` splits the write.
function assistant(
  id: string,
  model: string,
  usage: {
    input: number;
    read: number;
    write5m: number;
    write1h: number;
    output: number;
    thinking: number;
  },
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id,
      model,
      usage: {
        input_tokens: usage.input,
        cache_creation_input_tokens: usage.write5m + usage.write1h,
        cache_read_input_tokens: usage.read,
        output_tokens: usage.output,
        output_tokens_details: { thinking_tokens: usage.thinking },
        cache_creation: {
          ephemeral_5m_input_tokens: usage.write5m,
          ephemeral_1h_input_tokens: usage.write1h,
        },
      },
    },
  });
}

const first = assistant("msg_1", "claude-sonnet-5-5", {
  input: 2,
  read: 5674,
  write5m: 0,
  write1h: 5484,
  output: 156,
  thinking: 15,
});
const second = assistant("msg_2", "claude-sonnet-5-5", {
  input: 3,
  read: 11158,
  write5m: 700,
  write1h: 0,
  output: 40,
  thinking: 0,
});

describe("claudeAttemptUsageFacts", () => {
  test("one request per message id, in answer order, with thinking moved out of output", () => {
    // The CLI writes one line per content block, each carrying the same usage.
    const session = [first, first, second, first].join("\n");
    const facts = claudeAttemptUsageFacts({
      attempt: 2,
      credential: "api",
      provider: "anthropic",
      session,
      summary: [
        {
          model: "claude-sonnet-5-5",
          counts: [5, 16832, 700, 5484, 181, 15],
        },
      ],
    });
    expect(facts).toEqual({
      attempt: 2,
      credential: "api",
      requests: [
        ["anthropic", "claude-sonnet-5-5", 2, 5674, 0, 5484, 141, 15],
        ["anthropic", "claude-sonnet-5-5", 3, 11158, 700, 0, 40, 0],
      ],
    });
  });

  test("what the CLI's per-model summary counts beyond the transcript is a remainder", () => {
    const facts = claudeAttemptUsageFacts({
      attempt: 1,
      credential: "subscription",
      provider: "anthropic",
      session: [first, second].join("\n"),
      summary: [
        { model: "claude-sonnet-5-5", counts: [5, 16832, 700, 5484, 181, 15] },
        // A side model the CLI ran outside the conversation.
        { model: "claude-haiku-5-5", counts: [9500, 0, 0, 0, 28, 0] },
      ],
    });
    expect(facts?.remainders).toEqual([
      ["anthropic", "claude-haiku-5-5", 9500, 0, 0, 0, 28, 0],
    ]);
    expect(facts?.gaps).toBeUndefined();
  });

  test("a summary without the lifetime or thinking split is compared on the combined leaves", () => {
    const facts = claudeAttemptUsageFacts({
      attempt: 1,
      credential: "api",
      provider: "anthropic",
      session: first,
      // An older CLI: the write is one figure and output includes thinking.
      summary: [
        { model: "claude-sonnet-5-5", counts: [2, 5674, 5484, 0, 156, 0] },
      ],
    });
    expect(facts?.remainders).toBeUndefined();
  });

  test("a line the copy omitted or a truncated copy is a gap, and the summary covers what it lost", () => {
    const omitted = JSON.stringify({ crysk: "session line omitted" });
    const truncated = JSON.stringify({ crysk: "session truncated" });
    const facts = claudeAttemptUsageFacts({
      attempt: 1,
      credential: "api",
      provider: "anthropic",
      session: [first, omitted, truncated].join("\n"),
      summary: [
        { model: "claude-sonnet-5-5", counts: [5, 16832, 700, 5484, 181, 15] },
      ],
    });
    expect(facts?.gaps).toEqual(["line_omitted", "truncated"]);
    expect(facts?.remainders).toEqual([
      ["anthropic", "claude-sonnet-5-5", 3, 11158, 700, 0, 40, 0],
    ]);
  });

  test("no session copy: the whole summary is the remainder; no summary: a gap", () => {
    const noSession = claudeAttemptUsageFacts({
      attempt: 1,
      credential: "api",
      provider: "anthropic",
      session: undefined,
      summary: [
        { model: "claude-sonnet-5-5", counts: [5, 16832, 700, 5484, 181, 15] },
      ],
    });
    expect(noSession).toEqual({
      attempt: 1,
      credential: "api",
      requests: [],
      remainders: [
        ["anthropic", "claude-sonnet-5-5", 5, 16832, 700, 5484, 181, 15],
      ],
      gaps: ["no_session"],
    });
    // A killed attempt prints no result, but its session is written.
    const killed = claudeAttemptUsageFacts({
      attempt: 3,
      credential: "api",
      provider: "anthropic",
      session: first,
      summary: undefined,
    });
    expect(killed?.requests).toHaveLength(1);
    expect(killed?.gaps).toEqual(["no_summary"]);
  });

  test("lines that are not assistant usage, malformed lines and zero-usage messages are not requests", () => {
    const synthetic = assistant("msg_s", "<synthetic>", {
      input: 0,
      read: 0,
      write5m: 0,
      write1h: 0,
      output: 0,
      thinking: 0,
    });
    const user = JSON.stringify({ type: "user", message: { content: "hi" } });
    const facts = claudeAttemptUsageFacts({
      attempt: 1,
      credential: "api",
      provider: "anthropic",
      session: ["{not json", user, synthetic, "", second].join("\n"),
      summary: [
        { model: "claude-sonnet-5-5", counts: [3, 11158, 700, 0, 40, 0] },
      ],
    });
    expect(facts?.requests).toEqual([
      ["anthropic", "claude-sonnet-5-5", 3, 11158, 700, 0, 40, 0],
    ]);
    expect(facts?.remainders).toBeUndefined();
  });
});

// An OpenCode capture as the evidence collector writes it: the newest `readback` record holds the
// session's messages as OpenCode returned them.
function capture(messages: unknown[] | undefined): string {
  return JSON.stringify({
    schemaVersion: 1,
    records: [
      { kind: "readback", data: { messages: [] } },
      ...(messages === undefined
        ? []
        : [{ kind: "readback", data: { messages } }]),
    ],
  });
}

const route = { provider: "aiand", model: "deepseek-ai/deepseek-v4.1-flash" };
const totals = {
  inputUncached: 100,
  inputCacheRead: 2000,
  inputCacheWrite: 30,
  outputVisible: 40,
  outputReasoning: 5,
};

describe("openCodeAttemptUsageFacts", () => {
  test("one request per assistant message of the newest readback, as the provider reported it", () => {
    const facts = openCodeAttemptUsageFacts({
      attempt: 1,
      credential: "free",
      route,
      capture: capture([
        { info: { role: "user" }, parts: [] },
        {
          info: {
            role: "assistant",
            providerID: "aiand",
            modelID: "deepseek-ai/deepseek-v4.1-flash",
            tokens: {
              input: 60,
              output: 25,
              reasoning: 5,
              cache: { read: 1200, write: 30 },
            },
          },
          parts: [],
        },
        {
          info: {
            role: "assistant",
            providerID: "aiand",
            modelID: "deepseek-ai/deepseek-v4.1-flash",
            tokens: {
              input: 40,
              output: 15,
              reasoning: 0,
              cache: { read: 800, write: 0 },
            },
          },
          parts: [],
        },
      ]),
      totals,
    });
    expect(facts).toEqual({
      attempt: 1,
      credential: "free",
      requests: [
        ["aiand", "deepseek-ai/deepseek-v4.1-flash", 60, 1200, 30, 0, 25, 5],
        ["aiand", "deepseek-ai/deepseek-v4.1-flash", 40, 800, 0, 0, 15, 0],
      ],
    });
  });

  test("no readback: the attempt's totals are the remainder under its route, and a gap says so", () => {
    for (const lost of [
      undefined,
      capture(undefined).replace('"readback"', '"other"'),
    ]) {
      expect(
        openCodeAttemptUsageFacts({
          attempt: 2,
          credential: "subscription",
          route,
          capture: lost,
          totals,
        }),
      ).toEqual({
        attempt: 2,
        credential: "subscription",
        requests: [],
        remainders: [
          ["aiand", "deepseek-ai/deepseek-v4.1-flash", 100, 2000, 30, 0, 40, 5],
        ],
        gaps: ["no_readback"],
      });
    }
  });

  test("an attempt that reached no session reports nothing", () => {
    expect(
      openCodeAttemptUsageFacts({
        attempt: 1,
        credential: "api",
        route,
        capture: undefined,
        totals: {},
      }),
    ).toBeUndefined();
  });
});

test("credentialOfBillingMode names the platform's credential, and nothing for an unknown mode", () => {
  expect(credentialOfBillingMode("metered")).toBe("api");
  expect(credentialOfBillingMode("subscription")).toBe("subscription");
  expect(credentialOfBillingMode("free")).toBe("free");
  expect(credentialOfBillingMode("unknown")).toBeUndefined();
});
