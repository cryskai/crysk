import { expect, test } from "bun:test";
import type {
  AsyncEventSink,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  createOpenCodeClient,
  createTurnState,
  mapOpenCodeEvents,
  type OpenCodeSdkClientApi,
} from "../../src/transports/opencode-client";
import {
  type OpenCodeClientEvent,
  OpenCodeSdkTransport,
  type OpenCodeTransportClock,
} from "../../src/transports/opencode-sdk";

const request: TransportRequest = {
  sessionId: "local",
  attempt: 1,
  route: {
    backend: "opencode",
    provider: "openai",
    modelFamily: "gpt",
    modelSnapshot: "model",
  },
  executionModel: "model",
  effort: "high",
  systemPromptPath: "/unused",
  systemPromptSha256: "x",
  userPrompt: "review",
  cwd: "/tmp/authorized",
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
const sink: AsyncEventSink = { push: async () => "accepted", close() {} };
async function flush() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class AdvancingClock implements OpenCodeTransportClock {
  private time = 0;
  private timers = new Set<{ at: number; fn: () => void }>();
  nowMs() {
    return this.time;
  }
  schedule(ms: number, fn: () => void) {
    const timer = { at: this.time + ms, fn };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  }
  async advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers]
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.time = next.at;
      this.timers.delete(next);
      next.fn();
      await flush();
    }
    this.time = target;
    await flush();
  }
}
function setup(
  options: {
    gate?: Promise<void>;
    hangPoll?: boolean;
    cooperative?: boolean;
  } = {},
) {
  const signals: Record<string, AbortSignal | undefined> = {};
  let prompts = 0;
  let polls = 0;
  let activePolls = 0;
  let peakPolls = 0;
  const api: OpenCodeSdkClientApi = {
    mcp: {
      status: async (_p, r) => {
        signals.mcp = r?.signal;
        return { data: {} };
      },
    },
    permission: {
      reply: async () => ({ data: true }),
    },
    tool: {
      ids: async (_p, r) => {
        signals.tools = r?.signal;
        return { data: ["read"] };
      },
    },
    session: {
      create: async (_p, r) => {
        signals.create = r?.signal;
        await options.gate;
        return { data: { id: "s", directory: request.cwd } };
      },
      prompt: async (_p, r) => {
        signals.prompt = r?.signal;
        prompts++;
        return { data: {} };
      },
      status: async (_p, r) => {
        signals.status = r?.signal;
        polls++;
        if (!options.hangPoll) return { data: { s: { type: "idle" } } };
        activePolls++;
        peakPolls = Math.max(peakPolls, activePolls);
        return new Promise((_, reject) => {
          if (options.cooperative)
            r?.signal?.addEventListener(
              "abort",
              () => {
                activePolls--;
                reject(new Error("aborted"));
              },
              { once: true },
            );
        });
      },
      messages: async (_p, r) => {
        signals.messages = r?.signal;
        return { data: [] };
      },
      abort: async () => ({ data: true }),
    },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  };
  const client = createOpenCodeClient({
    loadSdk: async () => ({ createOpencodeClient: () => api }),
    launchServer: async () => ({
      url: "http://unused.invalid",
      pid: 1,
      close: async () => {},
    }),
    model: { providerID: "openai", modelID: "model" },
    readSystemPrompt: async () => "",
  });
  return {
    client,
    signals,
    counts: () => ({ prompts, polls, peakPolls, activePolls }),
  };
}

test("cancelled setup cannot submit a late prompt or assert zero spend", async () => {
  const gate = deferred();
  const rig = setup({ gate: gate.promise });
  const ctrl = new AbortController();
  const pending = new OpenCodeSdkTransport({
    client: rig.client,
    cleanupMs: 2,
  }).execute(request, { signal: ctrl.signal, events: sink });
  await flush();
  ctrl.abort();
  const out = await pending;
  expect(rig.signals.create?.aborted).toBe(true);
  expect(out.usage.completeness).toBe("unavailable");
  gate.resolve();
  await flush();
  expect(rig.counts().prompts).toBe(0);
});

test("uncooperative SDK poll occupies one slot instead of accumulating requests", async () => {
  const rig = setup({ hangPoll: true });
  await new OpenCodeSdkTransport({
    client: rig.client,
    pollIntervalMs: 2,
    pollRoundMs: 3,
    maxQuietRounds: 3,
    cleanupMs: 2,
  }).execute(request, { signal: new AbortController().signal, events: sink });
  expect(rig.counts().polls).toBe(1);
  expect(rig.signals.status?.aborted).toBe(true);
});

test("cooperative SDK polls abort before replacement and setup/prompt/readback receive signals", async () => {
  const rig = setup({ hangPoll: true, cooperative: true });
  await new OpenCodeSdkTransport({
    client: rig.client,
    pollIntervalMs: 2,
    pollRoundMs: 3,
    maxQuietRounds: 3,
    cleanupMs: 2,
  }).execute(request, { signal: new AbortController().signal, events: sink });
  expect(rig.counts().polls).toBe(3);
  expect(rig.counts().peakPolls).toBe(1);
  expect(rig.counts().activePolls).toBe(0);
  for (const name of ["create", "mcp", "tools", "prompt", "status"])
    expect(rig.signals[name]).toBeInstanceOf(AbortSignal);
  const readback = setup();
  const ctrl = new AbortController();
  const session = await readback.client.createSession({
    ...request,
    signal: ctrl.signal,
  });
  await readback.client.pollStatus(session, ctrl.signal);
  expect(readback.signals.messages).toBe(ctrl.signal);
  ctrl.abort();
  expect(readback.signals.prompt?.aborted).toBe(true);
  await readback.client.abort(session);
});

for (const pollRoundMs of [2_000, 200_000]) {
  test(`useful deadline is 150 seconds regardless of ${pollRoundMs}ms hung poll`, async () => {
    const rig = setup({ hangPoll: true });
    const clock = new AdvancingClock();
    let finished = false;
    const pending = new OpenCodeSdkTransport({
      client: rig.client,
      clock,
      pollRoundMs,
      cleanupMs: 1,
    }).execute(request, { signal: new AbortController().signal, events: sink });
    void pending.then(() => {
      finished = true;
    });
    await flush();
    await clock.advance(149_999);
    expect(finished).toBe(false);
    await clock.advance(2);
    const out = await pending;
    expect(out.completion).toBe("failed");
    expect(out.stderrTail).toContain("incomplete");
    expect(rig.signals.status?.aborted).toBe(true);
  });
}

test("setup deadline aborts concrete SDK I/O and suppresses late prompt", async () => {
  const gate = deferred();
  const rig = setup({ gate: gate.promise });
  const clock = new AdvancingClock();
  const pending = new OpenCodeSdkTransport({
    client: rig.client,
    clock,
  }).execute(request, { signal: new AbortController().signal, events: sink });
  await flush();
  // The default setup deadline (opencode-sdk.ts DEFAULT_SETUP_DEADLINE_MS).
  await clock.advance(45_000);
  const out = await pending;
  expect(out.completion).toBe("failed");
  expect(rig.signals.create?.aborted).toBe(true);
  expect(out.usage.completeness).toBe("unavailable");
  gate.resolve();
  await flush();
  expect(rig.counts().prompts).toBe(0);
});

test("only advancing owned reasoning snapshots prove useful progress", () => {
  const state = createTurnState("s", "u");
  const message = (id: string, role: string, parentID?: string) =>
    mapOpenCodeEvents(
      {
        type: "message.updated",
        properties: {
          sessionID: "s",
          info: { id, sessionID: "s", role, parentID },
        },
      },
      "s",
      state,
    );
  message("u", "user");
  message("a", "assistant", "u");
  message("foreign", "assistant", "other");
  const reasoning = (messageID: string, text: string): OpenCodeClientEvent[] =>
    mapOpenCodeEvents(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s",
          part: {
            id: `r-${messageID}`,
            sessionID: "s",
            messageID,
            type: "reasoning",
            text,
          },
        },
      },
      "s",
      state,
    );
  expect(reasoning("a", "one")).toEqual([
    { kind: "reasoning", progress: true },
  ]);
  expect(reasoning("a", "one")).toEqual([
    { kind: "reasoning", progress: false },
  ]);
  expect(reasoning("a", "one two")).toEqual([
    { kind: "reasoning", progress: true },
  ]);
  expect(reasoning("foreign", "other")).toEqual([]);
});

for (const progress of [false, true]) {
  test(`only attributable novelty extends the useful deadline: ${progress}`, async () => {
    const clock = new AdvancingClock();
    let wake: (() => void) | undefined;
    let queued: OpenCodeClientEvent | undefined;
    let finished = false;
    const transport = new OpenCodeSdkTransport({
      clock,
      cleanupMs: 1,
      client: {
        createSession: async () => ({ id: "s" }),
        async *streamEvents() {
          for (;;) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            if (queued) yield queued;
          }
        },
        pollStatus: async () => ({ kind: "pending" }),
        abort: async () => {},
      },
    });
    const pending = transport.execute(request, {
      signal: new AbortController().signal,
      events: sink,
    });
    void pending.then(() => {
      finished = true;
    });
    await flush();
    await clock.advance(149_000);
    queued = { kind: "reasoning", progress };
    wake?.();
    await flush();
    await clock.advance(1_001);
    await Bun.sleep(5); // The bounded iterator cleanup uses real I/O time.
    expect(finished).toBe(!progress);
    if (progress) await clock.advance(149_000);
    expect((await pending).completion).toBe("failed");
  });
}

// Commit 2: a tool status transition (novel pending/running/completed/error,
// mapped by the client to a bare `{ kind: "activity" }`) is real provider
// work, exactly like a novel-id reasoning delta or an advancing snapshot —
// tool execution time must not count as silence. A bare `{ kind: "reasoning"
// }` with no `progress` key (what the client emits for a replayed or
// id-less delta) must behave exactly like `progress: false`: `undefined !==
// true`, so it must NOT extend the deadline either.
test("an activity event (novel tool status transition) extends the useful-progress deadline like a novel reasoning delta", async () => {
  const clock = new AdvancingClock();
  let wake: (() => void) | undefined;
  let queued: OpenCodeClientEvent | undefined;
  let finished = false;
  const transport = new OpenCodeSdkTransport({
    clock,
    cleanupMs: 1,
    client: {
      createSession: async () => ({ id: "s" }),
      async *streamEvents() {
        for (;;) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          if (queued) yield queued;
        }
      },
      pollStatus: async () => ({ kind: "pending" }),
      abort: async () => {},
    },
  });
  const pending = transport.execute(request, {
    signal: new AbortController().signal,
    events: sink,
  });
  void pending.then(() => {
    finished = true;
  });
  await flush();
  await clock.advance(149_000);
  queued = { kind: "activity" };
  wake?.();
  await flush();
  await clock.advance(1_001);
  await Bun.sleep(5); // The bounded iterator cleanup uses real I/O time.
  expect(finished).toBe(false); // extended: not settled at the old deadline
  await clock.advance(149_000);
  expect((await pending).completion).toBe("failed"); // no further progress ever arrives
});

test("a bare reasoning marker with no progress key (a replayed or id-less delta) does not extend the deadline", async () => {
  const clock = new AdvancingClock();
  let wake: (() => void) | undefined;
  let queued: OpenCodeClientEvent | undefined;
  let finished = false;
  const transport = new OpenCodeSdkTransport({
    clock,
    cleanupMs: 1,
    client: {
      createSession: async () => ({ id: "s" }),
      async *streamEvents() {
        for (;;) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          if (queued) yield queued;
        }
      },
      pollStatus: async () => ({ kind: "pending" }),
      abort: async () => {},
    },
  });
  const pending = transport.execute(request, {
    signal: new AbortController().signal,
    events: sink,
  });
  void pending.then(() => {
    finished = true;
  });
  await flush();
  await clock.advance(149_000);
  queued = { kind: "reasoning" }; // no `progress` key at all, not `progress: false`
  wake?.();
  await flush();
  await clock.advance(1_001);
  await Bun.sleep(5);
  expect(finished).toBe(true); // NOT extended: silence still trips
  expect((await pending).completion).toBe("failed");
});
