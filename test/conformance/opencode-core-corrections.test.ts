import { expect, test } from "bun:test";
import type { TransportRequest } from "../../src/execution/contracts";
import { settlementFromUsage } from "../../src/execution/spend-limiter";
import {
  createOpenCodeClient,
  createTurnState,
  mapOpenCodeEvents,
  reconcileMessages,
} from "../../src/transports/opencode-client";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";

const sid = "ses_core";
const uid = "msg_core_user";
const cwd = "/tmp";
const assistant = (extra: Record<string, unknown> = {}) => ({
  id: "msg_answer",
  role: "assistant",
  sessionID: sid,
  parentID: uid,
  path: { cwd, root: cwd },
  time: { completed: 1 },
  finish: "stop",
  cost: 0.5,
  tokens: { input: 2, output: 3 },
  ...extra,
});
const part = (extra: Record<string, unknown> = {}) => ({
  id: "prt_answer",
  messageID: "msg_answer",
  sessionID: sid,
  type: "text",
  text: "ANSWER",
  ...extra,
});
const event = (info: unknown) => ({
  type: "message.updated",
  properties: { sessionID: sid, info },
});
const request: TransportRequest = {
  sessionId: "local",
  attempt: 1,
  route: {
    backend: "opencode",
    provider: "openai",
    modelFamily: "model",
    modelSnapshot: "model",
  },
  executionModel: "model",
  effort: "high",
  systemPromptPath: "/unused",
  systemPromptSha256: "x",
  userPrompt: "review",
  cwd,
  tools: ["Read"],
  isolation: {
    credentialProjectionId: "x",
    env: {},
    syntheticHome: "/tmp/x",
    syntheticConfigHome: "/tmp/x",
    syntheticTmp: "/tmp/x",
    verifiedBinaryPath: "/unused",
  },
};
async function run(
  messages: unknown[],
  stream: unknown[] = [],
  refusal = false,
) {
  const client = createOpenCodeClient({
    createMessageId: () => uid,
    model: { providerID: "openai", modelID: "model" },
    readSystemPrompt: async () => "",
    launchServer: async () => ({
      url: "http://unused.invalid",
      pid: 1,
      close: async () => {},
    }),
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        tool: { ids: async () => ({ data: ["read"] }) },
        mcp: { status: async () => ({ data: {} }) },
        permission: { reply: async () => ({ data: true }) },
        session: {
          create: async () => ({ data: { id: sid, directory: cwd } }),
          prompt: async () =>
            refusal
              ? {
                  error: {
                    name: "TransportError",
                    data: {
                      message: "Socket closed waiting for request 404af.",
                    },
                  },
                }
              : { data: {} },
          status: async () => ({ data: { [sid]: { type: "idle" } } }),
          messages: async () => ({ data: messages }),
          abort: async () => ({ data: true }),
        },
        event: {
          subscribe: async () => ({
            stream: (async function* () {
              yield* stream;
            })(),
          }),
        },
      }),
    }),
  });
  return new OpenCodeSdkTransport({
    client,
    billingMode: "metered",
    pollIntervalMs: 1,
    pollRoundMs: 10,
    maxQuietRounds: 3,
    abortConfirmMs: 1,
    cleanupMs: 1,
  }).execute(request, {
    signal: new AbortController().signal,
    events: { push: async () => "accepted", close() {} },
  });
}
test("ambiguous dispatched error cannot certify zero cash", async () => {
  const result = await run([], [], true);
  expect(result.usage.completeness).toBe("unavailable");
  expect(settlementFromUsage(result.usage).kind).not.toBe("settle");
});
test("foreign part lineage cannot establish a final result", () => {
  const result = reconcileMessages(
    [
      {
        info: assistant(),
        parts: [part({ messageID: "foreign", sessionID: "other" })],
      },
    ],
    createTurnState(sid, uid),
  );
  expect(result.failure).toBeDefined();
});
test("missing parts coverage cannot establish a final result", () => {
  const result = reconcileMessages(
    [{ info: assistant() }],
    createTurnState(sid, uid),
  );
  expect(result.terminalProof).toBeUndefined();
});
test.each(["tool", "reasoning", "file"])(
  "every part type consumes bounded identity capacity: %s",
  (type) => {
    const state = createTurnState(sid, uid);
    const result = reconcileMessages(
      [
        {
          info: assistant(),
          parts: Array.from({ length: 4097 }, (_, i) =>
            part({
              id: `prt_${i}`,
              type,
              callID: `call_${i}`,
              state: { status: "completed" },
            }),
          ),
        },
      ],
      state,
    );
    expect(result.failure).toBeDefined();
  },
);
test("all serialized readback payloads consume bytes", () => {
  const result = reconcileMessages(
    [
      {
        info: assistant(),
        parts: [
          part({
            type: "tool",
            state: {
              status: "completed",
              output: "X".repeat(4 * 1024 * 1024 + 1),
            },
          }),
        ],
      },
    ],
    createTurnState(sid, uid),
  );
  expect(result.failure).toBeDefined();
});
test("4096 parts is inclusive, not an overflow", () => {
  const result = reconcileMessages(
    [
      {
        info: assistant(),
        parts: Array.from({ length: 4096 }, (_, i) =>
          part({ id: `prt_${i}`, type: "reasoning", text: "" }),
        ),
      },
    ],
    createTurnState(sid, uid),
  );
  expect(result.failure).toBeUndefined();
});
test("SSE part capacity cannot silently evict", () => {
  const state = createTurnState(sid, uid);
  mapOpenCodeEvents(event(assistant()), sid, state);
  expect(() => {
    for (let i = 0; i < 4097; i++)
      mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: {
            sessionID: sid,
            part: part({ id: `prt_${i}`, type: "reasoning" }),
          },
        },
        sid,
        state,
      );
  }).toThrow();
});

test("a previously foreign assistant cannot change parent identity", () => {
  const state = createTurnState(sid, uid);
  mapOpenCodeEvents(event(assistant({ parentID: "msg_other" })), sid, state);
  const result = reconcileMessages(
    [{ info: assistant(), parts: [part()] }],
    state,
  );
  expect(result.failure).toBeDefined();
  expect(result.terminalProof).toBeUndefined();
});
test("retained delta strings jointly consume the 4 MiB memory budget", () => {
  const state = createTurnState(sid, uid);
  mapOpenCodeEvents(event(assistant()), sid, state);
  expect(() => {
    for (let index = 0; index < 5; index++) {
      const id = `prt_delta_${index}`;
      mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: { sessionID: sid, part: part({ id, text: "" }) },
        },
        sid,
        state,
      );
      for (let sequence = 0; sequence < 17; sequence++) {
        mapOpenCodeEvents(
          {
            type: "message.part.delta",
            properties: {
              sessionID: sid,
              messageID: "msg_answer",
              partID: id,
              field: "text",
              delta:
                String(sequence).padStart(2, "0") + "x".repeat(60 * 1024 - 2),
            },
          },
          sid,
          state,
        );
      }
    }
  }).toThrow("byte budget exceeded");
});
