import { describe, expect, test } from "bun:test";
import type {
  AsyncEventSink,
  ProviderEvent,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  createOpenCodeClient,
  type OpenCodeSdkLike,
} from "../../src/transports/opencode-client";
import type { OpenCodeTransportClock } from "../../src/transports/opencode-sdk";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";
import { flush } from "../support/flush";

// Issue #124. `message.part.delta` filters on `field === "text"` — the FIELD
// NAME — and the SDK gives `ReasoningPart` a member literally called `text`,
// exactly as `TextPart` has. So a reasoning model's private thinking was
// concatenated into finalText as if it were the answer, and every hunter
// failed format_violation over an artifact whose "result tail" showed
// reasoning prose where a reader expects JSON.
//
// The delta event carries NO part type (its whole payload is
// {sessionID, messageID, partID, field, delta}), so the type has to be
// correlated from `message.part.updated`, which carries the full Part.

const SESSION_ID = "ses_reasoning";
const USER_MESSAGE = "msg_user";
const ASSISTANT_MESSAGE = "msg_assistant";
const USER_PART = "prt_user_text";
const REASONING_PART = "prt_reasoning";
const ANSWER_PART = "prt_answer_text";

const ANSWER = '{"findings":[]}';
// The two concatenated reasoning deltas from the #116 smoke pass 3 artifact,
// missing separator and all — that missing space is what proved two deltas
// had been glued together into what the log presented as an answer.
const REASONING_A = "**Planning read-only codegraph inspection**";
const REASONING_B =
  "I'm tracing the retry options from their declaration through every call site.";

class ManualClock implements OpenCodeTransportClock {
  private pending: Array<() => void> = [];

  schedule(_ms: number, fn: () => void): () => void {
    this.pending.push(fn);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== fn);
    };
  }

  fireAll(): void {
    for (const fn of this.pending.splice(0)) fn();
  }
}

class RecordingSink implements AsyncEventSink {
  readonly events: ProviderEvent[] = [];

  async push(event: ProviderEvent): Promise<"accepted" | "closed"> {
    this.events.push(event);
    return "accepted";
  }

  close(): void {}
}

// A hang must read as a verdict, not as bun's generic 5 s timeout.
function withinWindow<T>(work: Promise<T>, hung: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(hung), 250);
    }),
  ]);
}

function messageUpdated(
  id: string,
  role: "user" | "assistant",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "message.updated",
    properties: {
      sessionID: SESSION_ID,
      info: {
        id,
        role,
        sessionID: SESSION_ID,
        time: { created: 1 },
        ...(role === "assistant"
          ? {
              path: { cwd: "/tmp/pr-hero-test", root: "/" },
              parentID: USER_MESSAGE,
            }
          : {}),
        ...extra,
      },
    },
  };
}

function partUpdated(
  id: string,
  messageID: string,
  type: string,
  text: string,
): Record<string, unknown> {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: SESSION_ID,
      part: { id, messageID, sessionID: SESSION_ID, type, text },
      time: 1,
    },
  };
}

const IDLE = {
  type: "session.idle",
  properties: { sessionID: SESSION_ID },
} as Record<string, unknown>;

function partDelta(partID: string, delta: string): Record<string, unknown> {
  return {
    type: "message.part.delta",
    properties: {
      sessionID: SESSION_ID,
      messageID: ASSISTANT_MESSAGE,
      partID,
      field: "text",
      delta,
    },
  };
}

// The turn's PROOF: the completed assistant message, which is the only
// provider-issued completion record either §197 observer can reach. It is not
// the turn's boundary — #127 — so every stream below ends with IDLE, the
// event that actually says the turn is over.
const COMPLETED = messageUpdated(ASSISTANT_MESSAGE, "assistant", {
  parentID: USER_MESSAGE,
  finish: "stop",
  time: { created: 1, completed: 1_787_811_448_694 },
  tokens: { input: 24_012, output: 6 },
  cost: 0.01,
});

// The recorded probe (test/fixtures/opencode/probe-events.json) shows the
// exact ordering this replays: a part is ANNOUNCED by `message.part.updated`
// before any delta for it arrives, and its owning message is announced by
// `message.updated` before that.
function reasoningThenAnswerStream(): Array<Record<string, unknown>> {
  return [
    messageUpdated(USER_MESSAGE, "user"),
    // TRAP 2's exhibit: the user's part carries the PROMPT text.
    partUpdated(USER_PART, USER_MESSAGE, "text", "review this"),
    messageUpdated(ASSISTANT_MESSAGE, "assistant", { parentID: USER_MESSAGE }),
    partUpdated(REASONING_PART, ASSISTANT_MESSAGE, "reasoning", ""),
    partDelta(REASONING_PART, REASONING_A),
    partDelta(REASONING_PART, REASONING_B),
    partUpdated(ANSWER_PART, ASSISTANT_MESSAGE, "text", ""),
    partDelta(ANSWER_PART, ANSWER),
    partUpdated(ANSWER_PART, ASSISTANT_MESSAGE, "text", ANSWER),
    COMPLETED,
    IDLE,
  ];
}

function reasoningOnlyStream(): Array<Record<string, unknown>> {
  return [
    messageUpdated(USER_MESSAGE, "user"),
    partUpdated(USER_PART, USER_MESSAGE, "text", "review this"),
    messageUpdated(ASSISTANT_MESSAGE, "assistant", { parentID: USER_MESSAGE }),
    partUpdated(REASONING_PART, ASSISTANT_MESSAGE, "reasoning", ""),
    partDelta(REASONING_PART, REASONING_A),
    partDelta(REASONING_PART, REASONING_B),
    COMPLETED,
    IDLE,
  ];
}

function fakeSdk(events: Array<Record<string, unknown>>): OpenCodeSdkLike {
  return {
    createOpencodeClient: () => ({
      // #141: `GET /mcp`, the readback the client performs before prompting.
      // These rigs declare no registry, so the verified answer is "nothing
      // connected" — which is a declaration too, not an absence of one.
      mcp: { status: async () => ({ data: {} }) },
      permission: { reply: async () => ({ data: true }) },
      session: {
        create: async (opts) => ({
          data: {
            id: SESSION_ID,
            directory: (opts as { directory: string }).directory,
          },
        }),
        prompt: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        // #127: the poll observer's turn boundary. An empty map is a session
        // that is not working — measured: opencode omits an idle session
        // rather than reporting {"type":"idle"}. Here the stream settles the
        // attempt, so this only has to be answerable.
        status: async () => ({ data: {} }),
        abort: async () => ({ data: true }),
      },
      // The ids the real `client.tool.ids()` returns on opencode 1.18.23; a
      // fake in a namespace the provider does not use is how the allow-map
      // defect stayed green over 2818 tests (#122).
      tool: {
        ids: async () => ({
          data: [
            "invalid",
            "question",
            "bash",
            "read",
            "glob",
            "grep",
            "edit",
            "write",
            "task",
            "webfetch",
            "todowrite",
            "websearch",
            "skill",
            "apply_patch",
          ],
        }),
      },
      event: {
        subscribe: async () => ({
          stream: {
            async *[Symbol.asyncIterator]() {
              for (const event of events) yield event;
            },
          },
        }),
      },
    }),
  };
}

function rigClient(events: Array<Record<string, unknown>>) {
  return createOpenCodeClient({
    createMessageId: () => USER_MESSAGE,
    loadSdk: async () => fakeSdk(events),
    launchServer: async () => ({
      url: "http://127.0.0.1:1",
      pid: 1,
      close: async () => {},
    }),
    model: { providerID: "openai", modelID: "test-model" },
    readSystemPrompt: async () => "SYSTEM",
  });
}

function makeRequest(): TransportRequest {
  return {
    sessionId: "oc-sess-1",
    attempt: 1,
    route: {
      backend: "opencode",
      provider: "openai",
      modelFamily: "gpt",
      modelSnapshot: "gpt-test-snapshot",
    },
    executionModel: "gpt-test-snapshot",
    effort: "high",
    systemPromptPath: "/tmp/pr-hero-test/system.md",
    systemPromptSha256: "deadbeef",
    userPrompt: "review this",
    cwd: "/tmp/pr-hero-test",
    tools: ["Read"],
    isolation: {
      credentialProjectionId: "proj-1",
      env: {},
      syntheticHome: "/tmp/pr-hero-test/home",
      syntheticConfigHome: "/tmp/pr-hero-test/config",
      syntheticTmp: "/tmp/pr-hero-test/tmp",
      verifiedBinaryPath: "/usr/bin/true",
    },
  };
}

async function runAttempt(events: Array<Record<string, unknown>>) {
  const clock = new ManualClock();
  const transport = new OpenCodeSdkTransport({
    client: rigClient(events),
    clock,
    cleanupMs: 20,
    pollIntervalMs: 10,
    pollRoundMs: 20,
  });
  let done = false;
  const attempt = transport
    .execute(makeRequest(), {
      signal: new AbortController().signal,
      events: new RecordingSink(),
    })
    .then((result) => {
      done = true;
      return result;
    });
  // Every deadline the transport owns is fired BY HAND — the §197
  // post-win observation window that settles a provider terminal is one of
  // them. Nothing here sleeps a real one (PR #118: host-dependent waits are
  // how this suite flaked before).
  //
  // #214: TWO flushes before each fire, not one. A fixture whose stream
  // yields more than one client event per raw SSE event (#214's "tool" event
  // rides the same raw update as #228's "activity") needs one more
  // microtask hop per extra event to fully drain a still-in-flight
  // `pushGuarded` race before `clock.fireAll()` runs — one flush left that
  // push's own stall timer as the only pending callback, which `fireAll`
  // then "won" on `clock.fireAll`'s behalf instead of the real push.
  for (let round = 0; round < 50 && !done; round += 1) {
    await flush();
    await flush();
    clock.fireAll();
  }
  const outcome = await withinWindow(attempt, undefined);
  if (outcome === undefined) throw new Error("the attempt never settled");
  return { transport, outcome };
}

describe("a reasoning model's thinking is not the answer", () => {
  test("only text parts are harvested into finalText", async () => {
    const { outcome } = await runAttempt(reasoningThenAnswerStream());

    expect(outcome.finalText).toBe(ANSWER);
    expect(outcome.finalText).not.toContain(REASONING_A);
    expect(outcome.finalText).not.toContain(REASONING_B);
    expect(outcome.completion).toBe("success");
    expect(outcome.toolInvocations).toBe(0);
  });

  // TRAP 2 in its second form. The fix has to consume `message.part.updated`
  // for the part TYPE, and that same event fires for the USER message — whose
  // recorded part carries the prompt text itself. A delta naming the user's
  // part must not become answer text either.
  test("the user's own part can never feed finalText", async () => {
    const events = reasoningThenAnswerStream();
    // Before the completion AND before the boundary: the stream now ends
    // with session.idle (#127), so length-1 would land after the turn ended.
    events.splice(
      events.length - 2,
      0,
      partDelta(USER_PART, "PROMPT ECHOED BACK"),
    );
    const { outcome } = await runAttempt(events);

    expect(outcome.finalText).toBe(ANSWER);
    expect(outcome.finalText).not.toContain("PROMPT ECHOED BACK");
  });

  // A delta whose part was never announced is DROPPED, not accepted. Accepting
  // it reopens exactly this bug for every part type the provider adds next;
  // dropping it fails toward a loud, retryable empty answer instead of a
  // silently corrupted one.
  test("a delta for an unannounced part is dropped", async () => {
    const events = reasoningThenAnswerStream();
    events.splice(
      events.length - 2,
      0,
      partDelta("prt_never_announced", "UNANNOUNCED"),
    );
    const { outcome } = await runAttempt(events);

    expect(outcome.finalText).toBe(ANSWER);
    expect(outcome.finalText).not.toContain("UNANNOUNCED");
  });
});

describe("a turn that reasoned and never answered", () => {
  test("harvests nothing and says so in its own notes", async () => {
    const { outcome } = await runAttempt(reasoningOnlyStream());

    expect(outcome.finalText).toBe("");
    // The VOLUME of discarded reasoning, never its text: `notes` becomes
    // stderrTail, which is classifyFailure's witness, so model prose in there
    // would make the tool's own subject matter look like provider diagnostics.
    expect(outcome.stderrTail).toContain("reasoning");
    expect(outcome.stderrTail).not.toContain(REASONING_A);
    expect(outcome.stderrTail).not.toContain(REASONING_B);
  });

  // §7 freezes the cause vocabulary, and format_violation is the wrong bucket:
  // the model never emitted an answer part, so there is nothing malformed to
  // reformat and a format reminder spends that budget on nothing. The answer
  // channel delivered no content — protocol_truncation — whose disposition is
  // a fresh attempt on the TRANSIENT budget, which is the remedy that can
  // actually work.
  test("classifies as protocol_truncation, not a format violation", async () => {
    const { transport, outcome } = await runAttempt(reasoningOnlyStream());

    expect(transport.classifyFailure(outcome)).toBe("protocol_truncation");
  });

  // ORDERING, the same rule the session-creation and prompt-refusal witnesses
  // live under: a last-resort marker must never shadow a retryable 429 or 401
  // that the provider's own text carries.
  test("still yields to the auth and rate-limit witnesses", async () => {
    const { transport, outcome } = await runAttempt(reasoningOnlyStream());

    expect(
      transport.classifyFailure({
        ...outcome,
        stderrTail: `${outcome.stderrTail}\n[pr-hero] opencode sdk: stream errored: 429 rate limit`,
      }),
    ).toBe("rate_limit");
    expect(
      transport.classifyFailure({
        ...outcome,
        stderrTail: `${outcome.stderrTail}\n[pr-hero] opencode sdk: stream errored: 401 unauthorized`,
      }),
    ).toBe("auth_invalid");
  });
});

describe("tool-call parts survive the SSE path (#214)", () => {
  const TOOL_PART = "prt_tool_read";
  const DUMP =
    'Building the value ledger to check the tab geometry for contradictions.{"findings":[]}';
  // #228's ownership/step model: a real OpenCode turn puts a completed tool
  // part on its OWN step message (`finish: "tool-calls"`), never on the same
  // message as the final answer — see opencode-client.ts's
  // `isIntermediateToolStep` and the transport conformance test "user prompt
  // text, reasoning, and intermediate tool-step text are excluded from final
  // answer". A single-message fixture (tool part + answer on one id) used to
  // work before that guard existed; now the answer text on a `hasToolCalls`
  // message is dropped as narration, so these fixtures use a second,
  // parented message for the real answer, matching that shape.
  const ASSISTANT_FINAL_MESSAGE = "msg_assistant_final";

  function partDeltaFor(
    messageId: string,
    partID: string,
    delta: string,
  ): Record<string, unknown> {
    return {
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
        messageID: messageId,
        partID,
        field: "text",
        delta,
      },
    };
  }

  function completedFor(
    messageId: string,
    parentId: string,
  ): Record<string, unknown> {
    return messageUpdated(messageId, "assistant", {
      parentID: parentId,
      finish: "stop",
      time: { created: 1, completed: 1_787_811_448_694 },
      tokens: { input: 24_012, output: 6 },
      cost: 0.01,
    });
  }

  test("a one-step prose dump with no tool parts stamps 0", async () => {
    const events: Array<Record<string, unknown>> = [
      messageUpdated(USER_MESSAGE, "user"),
      partUpdated(USER_PART, USER_MESSAGE, "text", "review this"),
      messageUpdated(ASSISTANT_MESSAGE, "assistant"),
      partUpdated(ANSWER_PART, ASSISTANT_MESSAGE, "text", ""),
      partDelta(ANSWER_PART, DUMP),
      partUpdated(ANSWER_PART, ASSISTANT_MESSAGE, "text", DUMP),
      COMPLETED,
      IDLE,
    ];
    const { outcome } = await runAttempt(events);

    expect(outcome.completion).toBe("success");
    expect(outcome.finalText).toBe(DUMP);
    expect(outcome.toolInvocations).toBe(0);
    expect(outcome.diagnosticsTail).toContain(
      "observed 0 completed tool invocation(s)",
    );
  });

  test("one Read call then empty findings stamps 1", async () => {
    const events: Array<Record<string, unknown>> = [
      messageUpdated(USER_MESSAGE, "user"),
      partUpdated(USER_PART, USER_MESSAGE, "text", "review this"),
      // Step 1: the intermediate tool-calling step.
      messageUpdated(ASSISTANT_MESSAGE, "assistant", {
        finish: "tool-calls",
        time: { created: 1, completed: 2 },
      }),
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          part: {
            id: TOOL_PART,
            messageID: ASSISTANT_MESSAGE,
            sessionID: SESSION_ID,
            type: "tool",
            callID: "call_read_1",
            tool: "read",
            state: { status: "completed" },
          },
        },
      },
      // Step 2: the final step, parented to step 1, carrying the real answer.
      messageUpdated(ASSISTANT_FINAL_MESSAGE, "assistant", {
        parentID: ASSISTANT_MESSAGE,
      }),
      partUpdated(ANSWER_PART, ASSISTANT_FINAL_MESSAGE, "text", ""),
      partDeltaFor(ASSISTANT_FINAL_MESSAGE, ANSWER_PART, ANSWER),
      partUpdated(ANSWER_PART, ASSISTANT_FINAL_MESSAGE, "text", ANSWER),
      completedFor(ASSISTANT_FINAL_MESSAGE, ASSISTANT_MESSAGE),
      IDLE,
    ];
    const { outcome } = await runAttempt(events);

    expect(outcome.completion).toBe("success");
    expect(outcome.finalText).toBe(ANSWER);
    expect(outcome.toolInvocations).toBe(1);
    expect(outcome.diagnosticsTail).toContain(
      "observed 1 completed tool invocation(s)",
    );
    expect(outcome.diagnosticsTail).toContain("(read)");
  });

  // #228's `hasOutstandingTools` refuses to finalize a turn while a tool is
  // still "pending"/"running" — a genuinely-stuck pending announcement (the
  // shape this test used to script) can no longer reach a terminal at all,
  // so it stopped exercising "announcing is not looking" and started
  // exercising the harness watchdog instead. "error" is the other terminal
  // status #214 excludes from the count (see the WHY comment on the "tool"
  // branch in opencode-client.ts's `handlePartUpdated`), and it lets the turn
  // actually finish, so it is what this fixture now scripts.
  test("an errored Read call then empty findings stamps 0 — an error is not a look", async () => {
    const events: Array<Record<string, unknown>> = [
      messageUpdated(USER_MESSAGE, "user"),
      partUpdated(USER_PART, USER_MESSAGE, "text", "review this"),
      messageUpdated(ASSISTANT_MESSAGE, "assistant", {
        finish: "tool-calls",
        time: { created: 1, completed: 2 },
      }),
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          part: {
            id: TOOL_PART,
            messageID: ASSISTANT_MESSAGE,
            sessionID: SESSION_ID,
            type: "tool",
            callID: "call_read_1",
            tool: "read",
            state: { status: "error" },
          },
        },
      },
      messageUpdated(ASSISTANT_FINAL_MESSAGE, "assistant", {
        parentID: ASSISTANT_MESSAGE,
      }),
      partUpdated(ANSWER_PART, ASSISTANT_FINAL_MESSAGE, "text", ""),
      partDeltaFor(ASSISTANT_FINAL_MESSAGE, ANSWER_PART, DUMP),
      partUpdated(ANSWER_PART, ASSISTANT_FINAL_MESSAGE, "text", DUMP),
      completedFor(ASSISTANT_FINAL_MESSAGE, ASSISTANT_MESSAGE),
      IDLE,
    ];
    const { outcome } = await runAttempt(events);

    expect(outcome.completion).toBe("success");
    expect(outcome.finalText).toBe(DUMP);
    expect(outcome.toolInvocations).toBe(0);
  });
});
