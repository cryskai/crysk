import { describe, expect, test } from "bun:test";
import type {
  AsyncEventSink,
  ProviderEvent,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  createOpenCodeClient,
  createTurnState,
  mapOpenCodeEvents,
  type OpenCodeSdkLike,
} from "../../src/transports/opencode-client";
import type { OpenCodeTransportClock } from "../../src/transports/opencode-sdk";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";
import { flush } from "../support/flush";

// Issue #127. OpenCode creates ONE assistant message PER STEP, and every one
// of them carries its own `time.completed`. Instrumented on the live provider
// (openai/gpt-5.6-luna, a prompt forcing one `read`):
//
//   [  168ms] NEW assistant msg_052aa8a6c001…
//   [ 8676ms] COMPLETED   msg_052aa8a6c001…   (assistants so far: 1)
//   [ 8676ms] NEW assistant msg_052aaabaa001…
//   [10789ms] COMPLETED   msg_052aaabaa001…   (assistants so far: 2)
//   [10789ms] NEW assistant msg_052aab3eb001…
//   [13039ms] COMPLETED   msg_052aab3eb001…   (assistants so far: 3)
//   ASSISTANT MESSAGES: 3   —   session.idle events: 1
//
// `time.completed` says THIS STEP ended. The turn ends once, at `session.idle`.
// Treating any completed assistant message as the TURN's terminal settled the
// attempt on step 1, harvested the model's plan narration and killed a working
// model — every "hunter finished in 10-33s with one line" symptom.
//
// A boundary and a proof are different things: `session.idle` says the turn
// ended, the last completed assistant message supplies the provider-issued
// proof content. This file pins both, on both §197 observers.

const SESSION_ID = "ses_turn";
const USER_MESSAGE = "msg_user";
const STEPS = ["msg_step_1", "msg_step_2", "msg_step_3"] as const;
const STEP_TEXT = ["plan-narration ", "tool-narration ", '{"findings":[]}'];
// Deliberately different per step, so a sum can never be mistaken for a
// coincidence and REPLACE semantics can never be mistaken for a sum.
const STEP_TOKENS = [
  { input: 100, output: 10, cost: 0.01 },
  { input: 200, output: 20, cost: 0.02 },
  { input: 300, output: 30, cost: 0.03 },
];
const TURN_INPUT = 600;
const TURN_OUTPUT = 60;
const TURN_COST = 0.06;
const COMPLETED_AT = 1_787_811_448_694;

const TOOL_IDS = [
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
];

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

function withinWindow<T>(work: Promise<T>, hung: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(hung), 250);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// The recorded event vocabulary (test/fixtures/opencode/probe-events.json).
// ---------------------------------------------------------------------------

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

function partDelta(
  messageID: string,
  partID: string,
  delta: string,
): Record<string, unknown> {
  return {
    type: "message.part.delta",
    properties: {
      sessionID: SESSION_ID,
      messageID,
      partID,
      field: "text",
      delta,
    },
  };
}

function sessionIdle(): Record<string, unknown> {
  return { type: "session.idle", properties: { sessionID: SESSION_ID } };
}

// One agentic STEP: its own assistant message, its own text part, its own
// completion record. The completed form is the message the poll observer finds
// in session.messages() too, so both observers derive their proof from it.
function stepCompleted(index: number): Record<string, unknown> {
  const tokens = STEP_TOKENS[index] as {
    input: number;
    output: number;
    cost: number;
  };
  return messageUpdated(STEPS[index] as string, "assistant", {
    finish: "stop",
    parentID: USER_MESSAGE,
    time: { created: 1, completed: COMPLETED_AT + index },
    tokens: { input: tokens.input, output: tokens.output },
    cost: tokens.cost,
  });
}

function stepEvents(index: number): Array<Record<string, unknown>> {
  const messageId = STEPS[index] as string;
  const partId = `prt_step_${index}`;
  return [
    messageUpdated(messageId, "assistant", { parentID: USER_MESSAGE }),
    partUpdated(partId, messageId, "text", ""),
    partDelta(messageId, partId, STEP_TEXT[index] as string),
    partUpdated(partId, messageId, "text", STEP_TEXT[index] as string),
    stepCompleted(index),
  ];
}

// The whole turn, minus its boundary. The three steps only.
function turnSteps(): Array<Record<string, unknown>> {
  return [
    messageUpdated(USER_MESSAGE, "user"),
    partUpdated("prt_user", USER_MESSAGE, "text", "review this"),
    ...stepEvents(0),
    ...stepEvents(1),
    ...stepEvents(2),
    // The recorded probe emits the completed assistant message TWICE, byte for
    // byte (indices 21 and 22). A per-EVENT sum would double-count the last
    // step; a per-MESSAGE latest-value sum cannot.
    stepCompleted(2),
  ];
}

// The poll observer's view of the same turn: what session.messages() returns.
function messagesAfter(steps: number): unknown[] {
  const list: unknown[] = [
    { info: { id: USER_MESSAGE, role: "user", sessionID: SESSION_ID } },
  ];
  for (let i = 0; i < steps; i += 1) {
    list.push({
      info: props(stepCompleted(i)).info,
      parts: [
        {
          id: `prt_step_${i}`,
          messageID: STEPS[i],
          sessionID: SESSION_ID,
          type: "text",
          text: STEP_TEXT[i],
        },
      ],
    });
  }
  return list;
}

function props(event: Record<string, unknown>): Record<string, never> & {
  info?: unknown;
} {
  return event.properties as Record<string, never> & { info?: unknown };
}

// ---------------------------------------------------------------------------
// The fake SDK. Stream, status map and message list are all driven by hand.
// ---------------------------------------------------------------------------

interface FakeSdk {
  sdk: OpenCodeSdkLike;
  emit: (event: Record<string, unknown>) => void;
  endStream: () => void;
  setStatus: (status: Record<string, unknown> | undefined) => void;
  setMessages: (messages: unknown[]) => void;
  statusCalls: () => number;
}

function fakeSdk(): FakeSdk {
  const queue: unknown[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  // The session id is ABSENT from the map while the session is not working:
  // measured against opencode 1.18.23 (see the poll describe block below).
  let statuses: Record<string, unknown> = {};
  let messages: unknown[] = [];
  let statusCalls = 0;
  // #223: `GET /event` and `GET /session/status` are both scoped by
  // `directory` instance (measured against opencode 1.18.30). session.create
  // is what names the directory this session actually lives under; status
  // and subscribe below only see it when they name the SAME one.
  let createdDirectory: string | undefined;

  const sdk: OpenCodeSdkLike = {
    createOpencodeClient: () => ({
      // #141: `GET /mcp`, the readback the client performs before prompting.
      // These rigs declare no registry, so the verified answer is "nothing
      // connected" — which is a declaration too, not an absence of one.
      mcp: { status: async () => ({ data: {} }) },
      permission: { reply: async () => ({ data: true }) },
      tool: { ids: async () => ({ data: [...TOOL_IDS] }) },
      session: {
        create: async (opts) => {
          createdDirectory = (opts as { directory?: string } | undefined)
            ?.directory;
          return {
            data: {
              id: SESSION_ID,
              directory: (opts as { directory: string }).directory,
            },
          };
        },
        prompt: async () => ({ data: {} }),
        messages: async () => ({ data: messages }),
        status: async (opts) => {
          statusCalls += 1;
          const directory = (opts as { directory?: string } | undefined)
            ?.directory;
          if (directory !== createdDirectory) return { data: {} };
          return { data: statuses };
        },
        abort: async () => ({ data: {} }),
      },
      event: {
        subscribe: async (params) => {
          const directory = (params as { directory?: string } | undefined)
            ?.directory;
          const scoped = directory === createdDirectory;
          return {
            stream: {
              async *[Symbol.asyncIterator]() {
                for (;;) {
                  if (scoped) {
                    while (queue.length > 0) yield queue.shift();
                  }
                  if (ended) return;
                  await new Promise<void>((resolve) => {
                    notify = resolve;
                  });
                }
              },
            },
          };
        },
      },
    }),
  };

  return {
    sdk,
    emit: (event) => {
      queue.push(event);
      notify?.();
      notify = undefined;
    },
    endStream: () => {
      ended = true;
      notify?.();
      notify = undefined;
    },
    setStatus: (status) => {
      statuses = status === undefined ? {} : { [SESSION_ID]: status };
    },
    setMessages: (list) => {
      messages = list;
    },
    statusCalls: () => statusCalls,
  };
}

function rigClient(fake: FakeSdk) {
  return createOpenCodeClient({
    createMessageId: () => USER_MESSAGE,
    loadSdk: async () => fake.sdk,
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

interface Attempt {
  settled: () => boolean;
  pump: (rounds?: number) => Promise<void>;
  outcome: () => Promise<
    Awaited<ReturnType<OpenCodeSdkTransport["execute"]>> | undefined
  >;
}

function startAttempt(fake: FakeSdk): Attempt {
  const clock = new ManualClock();
  const transport = new OpenCodeSdkTransport({
    client: rigClient(fake),
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

  // Every deadline the transport owns is fired BY HAND; nothing here sleeps a
  // real one (PR #118: host-dependent waits are how this suite flaked before).
  const pump = async (rounds = 30): Promise<void> => {
    for (let round = 0; round < rounds && !done; round += 1) {
      await flush();
      clock.fireAll();
    }
    await flush();
  };

  return {
    settled: () => done,
    pump,
    outcome: () => withinWindow(attempt, undefined),
  };
}

// ---------------------------------------------------------------------------

describe("a multi-step turn ends once, at session.idle (#127)", () => {
  test("a completed step message is not the turn's terminal", async () => {
    const fake = fakeSdk();
    const attempt = startAttempt(fake);
    await attempt.pump(3);

    for (const event of turnSteps()) fake.emit(event);
    await attempt.pump(20);

    // THE defect. Three steps have completed; the turn has not. Settling here
    // is what stopped a working model after its plan narration.
    expect(attempt.settled()).toBe(false);
  });

  test("the boundary settles it, with the LAST step's proof", async () => {
    const fake = fakeSdk();
    const attempt = startAttempt(fake);
    await attempt.pump(3);
    for (const event of turnSteps()) fake.emit(event);
    await attempt.pump(20);

    fake.emit(sessionIdle());
    await attempt.pump(30);

    const outcome = await attempt.outcome();
    if (outcome === undefined) throw new Error("the attempt never settled");
    expect(outcome.completion).toBe("success");
    expect(outcome.terminalProof?.eventId).toBe(STEPS[2]);
    expect(outcome.terminalProof?.providerStatus).toBe("completed");
  });

  test("finalText spans the whole turn, not step 1", async () => {
    const fake = fakeSdk();
    const attempt = startAttempt(fake);
    await attempt.pump(3);
    for (const event of turnSteps()) fake.emit(event);
    fake.emit(sessionIdle());
    await attempt.pump(30);

    const outcome = await attempt.outcome();
    if (outcome === undefined) throw new Error("the attempt never settled");
    expect(outcome.finalText).toBe(STEP_TEXT.join(""));
  });

  // Usage rides the assistant message as a SNAPSHOT with REPLACE semantics, so
  // one message per step means the last step's counters would overwrite every
  // earlier one — under-reporting a multi-step turn in the direction that
  // hides spend. The turn's figure is the SUM of its steps' figures, and it is
  // summed per MESSAGE ID, never per event: the recorded probe emits the same
  // completed message twice.
  test("usage sums every step and double-counts none", async () => {
    const fake = fakeSdk();
    const attempt = startAttempt(fake);
    await attempt.pump(3);
    for (const event of turnSteps()) fake.emit(event);
    fake.emit(sessionIdle());
    await attempt.pump(30);

    const outcome = await attempt.outcome();
    if (outcome === undefined) throw new Error("the attempt never settled");
    expect(outcome.usage.tokens.inputKnown).toBe(TURN_INPUT);
    expect(outcome.usage.tokens.outputKnown).toBe(TURN_OUTPUT);
    expect(outcome.usage.cashCostUsd).toBeCloseTo(TURN_COST, 10);
  });
});

describe("the poll observer reaches the same verdict independently", () => {
  // The stream boundary is `session.idle`; the poll has no event stream, so it
  // reads `GET /session/status` — a different endpoint, queried directly. That
  // is what keeps §197's two observers independent instead of two pipes onto
  // one fact.
  //
  // Measured against opencode 1.18.23 at $0 (local `opencode serve`, a
  // model-free `POST /session/{id}/shell` running `sleep 6`):
  //   during the work  →  {"ses_…":{"type":"busy"}}
  //   after it, and for a freshly created session  →  {}
  // An idle session is ABSENT from the map; it is never reported as
  // {"type":"idle"}. Requiring the explicit value would have left this
  // observer permanently blind.
  test("a busy session is not a boundary, even with a completed step", async () => {
    const fake = fakeSdk();
    fake.setStatus({ type: "busy" });
    fake.setMessages(messagesAfter(1));
    const attempt = startAttempt(fake);
    await attempt.pump(20);

    expect(attempt.settled()).toBe(false);
    // The same message list settles the attempt the moment the session leaves
    // the status map (below), so this is the STATUS deciding, not an
    // unreachable message list.
    expect(fake.statusCalls()).toBeGreaterThan(0);
  });

  // A session in `retry` is neither done nor idle: the provider is backing off
  // and will produce more steps. `retryHintFromStatus` reads the same arm for
  // the policy's retryAfterMs; here it must only mean "not yet".
  test("a retrying session is not a boundary either", async () => {
    const fake = fakeSdk();
    fake.setStatus({
      type: "retry",
      attempt: 2,
      message: "429",
      next: Date.now() + 60_000,
    });
    fake.setMessages(messagesAfter(2));
    const attempt = startAttempt(fake);
    await attempt.pump(20);

    expect(attempt.settled()).toBe(false);
    expect(fake.statusCalls()).toBeGreaterThan(0);
  });

  test("absence after busy is the boundary, and the proof is the last step", async () => {
    const fake = fakeSdk();
    fake.setStatus({ type: "busy" });
    fake.setMessages(messagesAfter(3));
    const attempt = startAttempt(fake);
    await attempt.pump(6);
    expect(attempt.settled()).toBe(false);

    // The work finished: the session drops out of the status map.
    fake.setStatus(undefined);
    await attempt.pump(30);

    const outcome = await attempt.outcome();
    if (outcome === undefined) throw new Error("the attempt never settled");
    expect(outcome.terminalProof?.eventId).toBe(STEPS[2]);
  });

  // Absence is ambiguous on its own — it is also what a wrong OR MISSING
  // `directory` scope looks like. Measured (#223, opencode 1.18.30):
  // `GET /session/status` given a directory other than the one session.create
  // registered returns {} for a session that is BUSY at that moment, the same
  // shape as a session that has finished. So absence only means idle once
  // this observer has proved, through this same endpoint, that it can see
  // this session at all.
  test("absence alone, never having seen the session, is not a boundary", async () => {
    const fake = fakeSdk();
    fake.setStatus(undefined);
    fake.setMessages(messagesAfter(1));
    const attempt = startAttempt(fake);
    await attempt.pump(20);

    expect(attempt.settled()).toBe(false);
    // It really did ask — this is a decision, not a poll that never ran.
    expect(fake.statusCalls()).toBeGreaterThan(0);
  });

  // Decision 1: a dropped `session.idle` is exactly what this observer is
  // redundancy FOR. The stream reaches EOF with no boundary and cannot settle
  // the attempt; the poll still does, through the other endpoint. The
  // transport never synthesises a proof of its own.
  test("a dropped session.idle is recovered by the poll, not by the stream", async () => {
    const fake = fakeSdk();
    fake.setStatus({ type: "busy" });
    const attempt = startAttempt(fake);
    await attempt.pump(3);
    for (const event of turnSteps()) fake.emit(event);
    await attempt.pump(6);
    // No session.idle is ever emitted; the stream simply ends.
    fake.setMessages(messagesAfter(3));
    fake.endStream();
    await attempt.pump(6);
    expect(attempt.settled()).toBe(false);

    fake.setStatus(undefined);
    await attempt.pump(30);

    const outcome = await attempt.outcome();
    if (outcome === undefined) throw new Error("the attempt never settled");
    expect(outcome.terminalProof?.eventId).toBe(STEPS[2]);
    expect(outcome.stderrTail).toContain("stream EOF");
  });

  // The poll's ONLY arming signal is having seen this session named through
  // its own endpoint, and its first observation used to be taken a full
  // pollIntervalMs AFTER the prompt was fired. A turn that finishes inside
  // that first interval is therefore never observed working: absence is all
  // this observer ever sees, absence alone proves nothing (the test above),
  // and the fallback that exists precisely for a stream EOF without
  // `session.idle` has no path to a terminal at all. The attempt then runs to
  // the harness watchdog with a completed turn sitting in session.messages().
  //
  // Fixed by taking the first observation immediately and delaying between
  // rounds instead of before them. That NARROWS the window to the provider's
  // own busy-registration latency rather than closing it — the prompt is
  // fired-not-awaited, so a first poll can still precede registration — and it
  // is the most that a sampling observer can do without arming from the
  // stream, which would reopen #127 under a wrong status scope.
  test("a turn shorter than one poll interval still reaches a terminal", async () => {
    const fake = fakeSdk();
    fake.setStatus({ type: "busy" });
    const attempt = startAttempt(fake);

    // Microtasks only: NO clock deadline is fired here, so this is the window
    // strictly BEFORE the first poll interval elapses.
    for (let pass = 0; pass < 8; pass += 1) await flush();

    // The whole turn streams and drains inside that same window — still no
    // clock deadline — because a turn shorter than one poll interval delivers
    // its content inside that interval too. Draining it first is not
    // cosmetic: settling the attempt mid-drain reports success over a
    // TRUNCATED finalText, which is a different and worse outcome than the
    // hang this test pins.
    for (const event of turnSteps()) fake.emit(event);
    for (let pass = 0; pass < 8; pass += 1) await flush();
    // The stream carried no `session.idle`, so it cannot settle anything.
    expect(attempt.settled()).toBe(false);

    // The turn is over: the session drops out of the status map and the
    // subscription ends without ever having delivered a boundary — the exact
    // shape the poll observer is redundancy for.
    fake.setMessages(messagesAfter(3));
    fake.setStatus(undefined);
    fake.endStream();

    await attempt.pump(30);

    const outcome = await attempt.outcome();
    if (outcome === undefined) throw new Error("the attempt never settled");
    expect(outcome.terminalProof?.eventId).toBe(STEPS[2]);
    expect(outcome.finalText).toBe(STEP_TEXT[2]);
    // It really did observe the session while it was working; the arming is a
    // measurement, not a relaxed gate.
    expect(fake.statusCalls()).toBeGreaterThan(0);
  });
});

describe("the mapper separates the boundary from the proof", () => {
  test("a completed assistant message alone yields no terminal", () => {
    const state = createTurnState(
      SESSION_ID,
      USER_MESSAGE,
      "/tmp/pr-hero-test",
    );
    const events = [
      ...stepEvents(0).map((event) =>
        mapOpenCodeEvents(event, SESSION_ID, state),
      ),
    ].flat();

    expect(events.filter((event) => event.kind === "terminal")).toEqual([]);
  });

  test("session.idle yields exactly one terminal, from the last completion", () => {
    const state = createTurnState(
      SESSION_ID,
      USER_MESSAGE,
      "/tmp/pr-hero-test",
    );
    for (const event of turnSteps()) {
      mapOpenCodeEvents(event, SESSION_ID, state);
    }
    const first = mapOpenCodeEvents(sessionIdle(), SESSION_ID, state);
    const second = mapOpenCodeEvents(sessionIdle(), SESSION_ID, state);

    expect(first).toEqual([
      {
        kind: "terminal",
        proof: {
          eventId: STEPS[2],
          providerStatus: "completed",
          providerObservedAt: new Date(COMPLETED_AT + 2).toISOString(),
        },
      },
    ]);
    // One terminal per turn. A second idle cannot manufacture another.
    expect(second).toEqual([]);
  });

  test("an idle turn that completed nothing issues no proof at all", () => {
    const state = createTurnState(
      SESSION_ID,
      USER_MESSAGE,
      "/tmp/pr-hero-test",
    );
    mapOpenCodeEvents(messageUpdated(USER_MESSAGE, "user"), SESSION_ID, state);
    mapOpenCodeEvents(
      messageUpdated(STEPS[0] as string, "assistant"),
      SESSION_ID,
      state,
    );

    // The transport never issues its own provider proof: no completion record
    // observed means no terminal, and the attempt falls to the harness
    // watchdog rather than to a synthetic one.
    expect(mapOpenCodeEvents(sessionIdle(), SESSION_ID, state)).toEqual([]);
  });

  test("session.idle for another session is ignored", () => {
    const state = createTurnState(
      SESSION_ID,
      USER_MESSAGE,
      "/tmp/pr-hero-test",
    );
    for (const event of turnSteps()) {
      mapOpenCodeEvents(event, SESSION_ID, state);
    }

    expect(
      mapOpenCodeEvents(
        { type: "session.idle", properties: { sessionID: "ses_other" } },
        SESSION_ID,
        state,
      ),
    ).toEqual([]);
  });
});

// The usage map is bounded (MAX_TRACKED_MESSAGES, oldest-first) and the turn's
// figure used to be the sum of the entries STILL PRESENT. A turn longer than
// that cap therefore dropped an evicted step's tokens out of every later
// total, and the running figure could go DOWN at the instant of eviction —
// under-reporting spend, which this transport calls the worst direction to be
// wrong in. The cap is a MEMORY bound; it must never become an accounting one.
describe("bounded turns preserve usage and overflow fails closed", () => {
  // More steps than the cap, deliberately FRONT-LOADED: a first step far
  // larger than the ones after it is what makes eviction visible. With flat
  // per-step figures the truncated sum stays monotonic by accident and the
  // defect hides behind its own arithmetic.
  const OVERFLOW_STEPS = 512;
  const FIRST_STEP_INPUT = 10_000;
  const LATER_STEP_INPUT = 1;
  const STEP_OUTPUT = 1;
  const STEP_COST = 0.001;

  function overflowStep(index: number): Record<string, unknown> {
    return messageUpdated(`msg_overflow_${index}`, "assistant", {
      finish: "stop",
      time: { created: 1, completed: COMPLETED_AT + index },
      tokens: {
        input: index === 0 ? FIRST_STEP_INPUT : LATER_STEP_INPUT,
        output: STEP_OUTPUT,
      },
      cost: STEP_COST,
    });
  }

  test("a 513th identity fails without evicting the first step", () => {
    const state = createTurnState(
      SESSION_ID,
      USER_MESSAGE,
      "/tmp/pr-hero-test",
    );
    for (let i = 0; i < 512; i++)
      mapOpenCodeEvents(overflowStep(i), SESSION_ID, state);
    expect(() =>
      mapOpenCodeEvents(overflowStep(512), SESSION_ID, state),
    ).toThrow("message cap exceeded");
    expect(state.usage.has("msg_overflow_0")).toBe(true);
    expect(state.integrityFailure).toBeDefined();
  });

  function runOverflowTurn(): Array<{
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }> {
    const state = createTurnState(
      SESSION_ID,
      USER_MESSAGE,
      "/tmp/pr-hero-test",
    );
    const snapshots: Array<{
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    }> = [];
    for (let index = 0; index < OVERFLOW_STEPS; index += 1) {
      for (const event of mapOpenCodeEvents(
        overflowStep(index),
        SESSION_ID,
        state,
      )) {
        if (event.kind === "usage") {
          snapshots.push({
            ...(event.inputTokens !== undefined
              ? { inputTokens: event.inputTokens }
              : {}),
            ...(event.outputTokens !== undefined
              ? { outputTokens: event.outputTokens }
              : {}),
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          });
        }
      }
    }
    return snapshots;
  }

  test("the turn's figure is the sum of EVERY step, not of the survivors", () => {
    const snapshots = runOverflowTurn();
    const last = snapshots.at(-1);
    if (last === undefined) throw new Error("no usage snapshot was emitted");

    expect(snapshots.length).toBe(OVERFLOW_STEPS);
    expect(last.inputTokens).toBe(
      FIRST_STEP_INPUT + (OVERFLOW_STEPS - 1) * LATER_STEP_INPUT,
    );
    expect(last.outputTokens).toBe(OVERFLOW_STEPS * STEP_OUTPUT);
    expect(last.costUsd).toBeCloseTo(OVERFLOW_STEPS * STEP_COST, 10);
  });

  test("the running total never decreases within the memory bound", () => {
    const snapshots = runOverflowTurn();

    let previousInput = 0;
    let previousOutput = 0;
    let previousCost = 0;
    for (const [index, snapshot] of snapshots.entries()) {
      const input = snapshot.inputTokens ?? 0;
      const output = snapshot.outputTokens ?? 0;
      const cost = snapshot.costUsd ?? 0;
      if (input < previousInput || output < previousOutput) {
        throw new Error(
          `usage went backwards at step ${index}: ` +
            `${previousInput}/${previousOutput} -> ${input}/${output}`,
        );
      }
      expect(cost).toBeGreaterThanOrEqual(previousCost - 1e-12);
      previousInput = input;
      previousOutput = output;
      previousCost = cost;
    }
  });
});
