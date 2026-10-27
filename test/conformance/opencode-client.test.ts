import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  AsyncEventSink,
  ProviderEvent,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  createOpenCodeClient,
  createTurnState,
  isMessageOwned,
  mapOpenCodeEvents,
  type OpenCodeSdkLike,
  reconcileMessages,
  terminalProofFromAssistant,
} from "../../src/transports/opencode-client";
import {
  assertMcpConnected,
  translateMcpConfig,
} from "../../src/transports/opencode-mcp";
import type { OpenCodeClientEvent } from "../../src/transports/opencode-sdk";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";

const FIXTURE_DIR = path.join(import.meta.dir, "..", "fixtures", "opencode");
const SESSION_ID = "ses_test";

const ASSISTANT: Record<string, unknown> & {
  id?: string;
  path: { cwd: string; root: string };
  sessionID: string;
} = {
  ...(JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, "assistant-message.json"), "utf-8"),
  ) as Record<string, unknown>),
  sessionID: SESSION_ID,
  path: { cwd: "/tmp/work", root: "/" },
};

// The REAL tool surface, read live from `client.tool.ids()` against opencode
// 1.18.23 while diagnosing issue #122. It is transcribed rather than derived:
// the SDK types `tools` as an OPEN `{[key: string]: boolean}` map and
// enumerate nothing, so this list is the only record of what the provider
// actually offers — and of the fact that NONE of it is spelled the way the
// engine's canonical (Claude Code namespace) tool names are.
const OPENCODE_TOOL_IDS = [
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
] as const;

interface FakeSdk {
  sdk: OpenCodeSdkLike;
  iterators: () => number;
  streamReturns: () => number;
  promptCalls: () => Array<Record<string, unknown>>;
  abortCalls: () => number;
  createdAt: () => number;
  subscribedAt: () => number;
  toolIdsAt: () => number;
  promptedAt: () => number;
  toolIdsCalls: () => Array<Record<string, unknown> | undefined>;
  emit: (event: unknown) => void;
  endStream: () => void;
  setMessages: (messages: unknown[]) => void;
  setStatus: (status: Record<string, unknown> | undefined) => void;
  setMcpStatus: (status: Record<string, unknown>) => void;
  mcpStatusCalls: () => Array<Record<string, unknown> | undefined>;
  // #223: every call this session's OTHER observers make against
  // `session.status` / `event.subscribe`, recorded verbatim so a test can
  // assert they carry the same `directory` session.create registered.
  statusCalls: () => Array<Record<string, unknown> | undefined>;
  subscribeCalls: () => Array<Record<string, unknown> | undefined>;
  // #157: every call to `permission.reply`, verbatim, so a test can assert
  // the exact ids pr-hero sent — and how many times it sent them.
  replyCalls: () => Array<Record<string, unknown>>;
  // F002: releases every `permission.reply` call parked on
  // `permissionReplyHangs`, so a test can assert what happens to a
  // DUPLICATE delivered while the first reply is still genuinely in
  // flight, rather than a race that depends on microtask ordering.
  releasePendingReplies: () => void;
}

function fakeSdk(
  options: {
    promptHangs?: boolean;
    // `undefined` means "the live surface". An Error rejects the call; an
    // array (including an empty one) resolves with exactly those ids.
    toolIds?: readonly string[] | Error;
    // #157: `undefined` means every `permission.reply` call succeeds
    // (`{data: true}`, the real 200 shape). A string simulates the SDK's own
    // `ThrowOnError = false` convention — an API-level refusal RESOLVES with
    // `{data: undefined, error}`, never a rejected promise.
    permissionReplyError?: string;
    // F002: when true, every `permission.reply` call parks on an internal
    // gate until the test calls `releasePendingReplies()` — the only way to
    // deterministically hold a reply "in flight" for a concurrent-duplicate
    // test, rather than depending on how many microtask hops a fast-resolving
    // fake happens to take.
    permissionReplyHangs?: boolean;
    // Distinct ids per createSession, in call order. Default is SESSION_ID
    // for every create, which is what the single-session tests pin.
    sessionIds?: readonly string[];
  } = {},
): FakeSdk {
  const prompts: Array<Record<string, unknown>> = [];
  const toolIdsCalls: Array<Record<string, unknown> | undefined> = [];
  let aborts = 0;
  let order = 0;
  let creates = 0;
  let createdAt = 0;
  let subscribedAt = 0;
  let toolIdsAt = 0;
  let promptedAt = 0;
  let messages: unknown[] = [];
  // #127: GET /session/status, the poll observer's turn boundary. Measured
  // against opencode 1.18.23: a working session is listed {"type":"busy"} and
  // one that is not working is simply OMITTED — an idle session is never
  // reported as {"type":"idle"}.
  let statuses: Record<string, unknown> = {};
  // #141: `GET /mcp`, the readback §E compares against what pr-hero declared.
  // Measured shape (scripts/opencode-mcp-probe.ts): {"<name>":{"status":"connected"}},
  // and {} when nothing is connected.
  let mcpStatus: Record<string, unknown> = {};
  const mcpStatusCalls: Array<Record<string, unknown> | undefined> = [];
  // #223: the real server scopes BOTH `GET /event` and `GET /session/status`
  // by `directory` (measured against opencode 1.18.30). session.create is
  // the one call that names the directory a session actually lives under;
  // every other observer of that session has to name the SAME one or it is
  // watching an instance that has never heard of it.
  let createdDirectory: string | undefined;
  const statusCalls: Array<Record<string, unknown> | undefined> = [];
  const subscribeCalls: Array<Record<string, unknown> | undefined> = [];
  const queue: unknown[] = [];
  let notify: (() => void) | undefined;
  let ended = false;

  let iterators = 0;
  let streamReturns = 0;
  const replyCalls: Array<Record<string, unknown>> = [];
  let releasePendingReplies: (() => void) | undefined;
  const pendingRepliesGate = options.permissionReplyHangs
    ? new Promise<void>((resolve) => {
        releasePendingReplies = resolve;
      })
    : undefined;
  const sdk: OpenCodeSdkLike = {
    createOpencodeClient: () => ({
      mcp: {
        status: async (opts) => {
          mcpStatusCalls.push(opts as Record<string, unknown> | undefined);
          return { data: mcpStatus };
        },
      },
      permission: {
        reply: async (opts) => {
          replyCalls.push(opts as Record<string, unknown>);
          if (pendingRepliesGate) await pendingRepliesGate;
          if (options.permissionReplyError !== undefined) {
            return { error: options.permissionReplyError };
          }
          return { data: true };
        },
      },
      tool: {
        ids: async (opts) => {
          toolIdsAt = ++order;
          toolIdsCalls.push(opts as Record<string, unknown> | undefined);
          if (options.toolIds instanceof Error) throw options.toolIds;
          return { data: [...(options.toolIds ?? OPENCODE_TOOL_IDS)] };
        },
      },
      session: {
        create: async (opts) => {
          createdAt = ++order;
          const id = options.sessionIds?.[creates] ?? SESSION_ID;
          creates += 1;
          createdDirectory = (opts as { directory?: string } | undefined)
            ?.directory;
          return {
            data: { id, directory: (opts as { directory: string }).directory },
          };
        },
        prompt: async (opts) => {
          promptedAt = ++order;
          prompts.push(opts as Record<string, unknown>);
          if (options.promptHangs) await new Promise(() => {});
          return {
            data: {
              id: "msg_041ddb5a0001orXfEB1f2tRCLO",
              role: "user",
              sessionID: options.sessionIds?.[0] ?? SESSION_ID,
            },
          };
        },
        messages: async () => ({ data: messages }),
        status: async (opts) => {
          // Recorded verbatim, BEFORE the match decision — this is what the
          // production call actually sent, not what the fake thinks of it.
          statusCalls.push(opts as Record<string, unknown> | undefined);
          const directory = (opts as { directory?: string } | undefined)
            ?.directory;
          // #223: a directory that does not match the one session.create
          // registered watches an instance that never heard of this
          // session — measured (opencode 1.18.30) as `{}`, indistinguishable
          // from "this session is idle".
          if (directory !== createdDirectory) return { data: {} };
          return { data: statuses };
        },
        abort: async () => {
          aborts += 1;
          return { data: {} };
        },
      },
      event: {
        subscribe: async (params) => {
          subscribedAt = ++order;
          subscribeCalls.push(params as Record<string, unknown> | undefined);
          const directory = (params as { directory?: string } | undefined)
            ?.directory;
          // #223: same scoping as session.status above. A mismatched
          // directory still yields a live, endable stream — the real server
          // keeps delivering server.connected/heartbeat on it — it just
          // never carries THIS session's queued events.
          const scoped = directory === createdDirectory;
          // One iterator object. Bun does not run an async-generator
          // `finally` on `return()` if `next()` never ran, so the close
          // signal is the `return` method itself — that is also what the
          // catch-path unwind calls.
          const inner = (async function* subscribeStream() {
            iterators += 1;
            for (;;) {
              if (scoped) {
                while (queue.length > 0) yield queue.shift();
              }
              if (ended) return;
              await new Promise<void>((r) => {
                notify = r;
              });
            }
          })();
          const stream = {
            [Symbol.asyncIterator]() {
              return stream;
            },
            next: (value?: undefined) => inner.next(value),
            return: async () => {
              streamReturns += 1;
              return await inner.return();
            },
            throw: (error?: unknown) => inner.throw(error),
          };
          return { stream };
        },
      },
    }),
  };

  return {
    sdk,
    iterators: () => iterators,
    streamReturns: () => streamReturns,
    promptCalls: () => prompts,
    abortCalls: () => aborts,
    createdAt: () => createdAt,
    subscribedAt: () => subscribedAt,
    toolIdsAt: () => toolIdsAt,
    promptedAt: () => promptedAt,
    toolIdsCalls: () => toolIdsCalls,
    replyCalls: () => replyCalls,
    releasePendingReplies: () => releasePendingReplies?.(),
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
    setMessages: (m) => {
      messages = m;
    },
    setStatus: (status: Record<string, unknown> | undefined) => {
      statuses = status === undefined ? {} : { [SESSION_ID]: status };
    },
    setMcpStatus: (status: Record<string, unknown>) => {
      mcpStatus = status;
    },
    mcpStatusCalls: () => mcpStatusCalls,
    statusCalls: () => statusCalls,
    subscribeCalls: () => subscribeCalls,
  };
}

const CODEGRAPH_BIN = "/opt/homebrew/bin/codegraph";

// Byte-for-byte what review()/reviewPr() write (CODEGRAPH_ONLY_MCP_CONFIG,
// src/review/run.ts since cli-decomp-08), so the fixture cannot drift from
// the file the translation actually receives.
const CLAUDE_MCP_JSON = JSON.stringify({
  mcpServers: {
    codegraph: {
      type: "stdio",
      command: "codegraph",
      args: ["serve", "--mcp"],
    },
  },
});

// What a repo with no `.codegraph` index gets (EMPTY_MCP_CONFIG, src/review/run.ts).
const EMPTY_MCP_JSON = JSON.stringify({ mcpServers: {} });

function rig(
  fake: FakeSdk,
  overrides: Partial<Parameters<typeof createOpenCodeClient>[0]> = {},
) {
  return createOpenCodeClient({
    createMessageId: () => String(ASSISTANT.parentID),
    loadSdk: async () => fake.sdk,
    // Attests exactly what it is asked to gate — the "correct launcher"
    // shape. A test that needs to exercise an UNattested launcher (the
    // free-tier gateway attestation fix) overrides `launchServer` itself
    // rather than changing this default, so every other test in this file
    // that never touches `credentialKind: "provider_free"` keeps asking
    // for nothing (`freeTierGatewayAsk` arrives as `[]`) and attesting
    // nothing back, unaffected.
    launchServer: async (
      _mcp?: unknown,
      freeTierGatewayAsk?: readonly string[],
    ) => ({
      url: "http://127.0.0.1:1",
      pid: 1,
      gatewayAsk: freeTierGatewayAsk ?? [],
      close: async () => {},
    }),
    model: { providerID: "openai", modelID: "test-model" },
    readSystemPrompt: async () => "SYSTEM",
    readMcpConfig: async () => EMPTY_MCP_JSON,
    codegraphBinaryPath: CODEGRAPH_BIN,
    ...overrides,
  });
}

// The CANONICAL tool names, verbatim from `BINDING_ALLOWED_TOOLS` and from
// every bundled hunter prompt's `tools:` line. They are Claude Code's
// namespace and OpenCode has never understood a single one of them; this
// fixture used to read ["read", "grep"], a mock shaped to the same guess that
// shipped issue #121, which is why 2818 offline tests stayed green while the
// live map denied nothing and allowed nothing.
const INPUT = {
  cwd: "/tmp/work",
  userPrompt: "review this",
  systemPromptPath: "/tmp/system.md",
  tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
};

// What the transport must send for that input against the live surface: EVERY
// enumerated id present, the three translatable allows true, everything else
// explicitly false. No key is absent, so "what does OpenCode do with an absent
// key" stops being a question this transport's safety depends on.
//
// #141: `codegraph_codegraph_explore` is here too, and it is FALSE because
// this input declares no mcp registry. It is written rather than omitted for
// exactly the reason every other id is — an absent key asks for the provider's
// default — and it is never reported by `tool.ids()` even when its server IS
// connected (measured, #141 fact 3), so it has to be written from pr-hero's
// own knowledge or it can never be written at all.
const EXPECTED_TOOL_MAP = {
  invalid: false,
  question: false,
  bash: false,
  read: true,
  glob: true,
  grep: true,
  edit: false,
  write: false,
  task: false,
  webfetch: false,
  todowrite: false,
  websearch: false,
  skill: false,
  apply_patch: false,
  codegraph_codegraph_explore: false,
};

function messageEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: SESSION_ID,
      info: { ...ASSISTANT, sessionID: SESSION_ID, ...overrides },
    },
  };
}

describe("createOpenCodeClient", () => {
  // THE ordering rule. event.subscribe() is live and unbuffered, so a
  // subscription opened after the prompt silently misses the early events —
  // and those are the ones carrying the first deltas. The contract calls
  // createSession() and streamEvents() as separate steps, so the buffering
  // has to happen inside createSession or the window is unavoidable.
  test("subscribes BEFORE prompting, never after", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);
    expect(fake.subscribedAt()).toBeGreaterThan(0);
    expect(fake.promptedAt()).toBeGreaterThan(0);
    expect(fake.subscribedAt()).toBeLessThan(fake.promptedAt());
  });

  // #223: session.create now registers the session under the STEP's cwd
  // (input.cwd), not the server's own — so a subscription that does not name
  // the same directory watches an instance that has never heard of this
  // session and only ever sees server.connected/heartbeat.
  test("subscribes with the same directory session.create registered", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);
    expect(fake.subscribeCalls()).toEqual([{ directory: INPUT.cwd }]);
  });

  // #128: the allow map is a snapshot of tool.ids(), and an id registered
  // between that call and session.prompt() is an ABSENT key — OpenCode's
  // default is "all tools enabled". No construction-level fix exists (the
  // prompt body types `tools` as an open map, no wildcard). The remaining
  // narrowing is to take the snapshot adjacent to the prompt, after the
  // awaited create+subscribe round-trips, so the window is [ids → prompt]
  // instead of [ids → create → subscribe → prompt].
  test("enumerates the tool surface after subscribe and immediately before prompt", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);
    expect(fake.createdAt()).toBeGreaterThan(0);
    expect(fake.subscribedAt()).toBeGreaterThan(fake.createdAt());
    expect(fake.toolIdsAt()).toBeGreaterThan(fake.subscribedAt());
    expect(fake.promptedAt()).toBe(fake.toolIdsAt() + 1);
  });

  // session.prompt is a BLOCKING call that returns the finished message —
  // the probe measured 4.5s. The ROADMAP forbids completing an attempt from
  // one blocking HTTP call, so it is the TRIGGER and nothing else; a prompt
  // that never returns must not stop the stream from delivering.
  test("a prompt that never returns does not block the session", async () => {
    const fake = fakeSdk({ promptHangs: true });
    const client = rig(fake);
    const session = await Promise.race([
      client.createSession(INPUT),
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error("blocked")), 500),
      ),
    ]);
    expect((session as { id: string }).id).toBe(SESSION_ID);
  });

  test("the prompt carries the system prompt, the tools and the cwd", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);
    const body = fake.promptCalls()[0]?.body as Record<string, unknown>;
    expect(body.system).toBe("SYSTEM");
    expect(body.parts).toEqual([{ type: "text", text: "review this" }]);
    // §6: the tool map is an ALLOWLIST expressed as explicit booleans. A tool
    // the spec did not name must be false, not merely absent — "absent" is a
    // request for the provider's default, and the default is not ours.
    expect(body.tools).toEqual(EXPECTED_TOOL_MAP);
  });
});

// ---------------------------------------------------------------------------
// Issue #122. The map handed to session.prompt was built by writing the
// engine's CANONICAL tool names straight into it — Claude Code's namespace,
// which OpenCode has never spoken. `tools` is an OPEN map, so unknown keys are
// accepted and silently ignored: no error, no warning, nothing in the
// response. Of the five keys sent, only "bash" landed, and only by the
// coincidence that OpenCode happens to spell its shell tool that way.
//
// Two failures in one. The allowlist allowed nothing — the #116 smoke's
// hunters ran ~10s each emitting pure narration ("Inspecting codegraph and
// relevant consumers") about tool use they never performed. And the denylist
// denied nothing beyond bash, leaving write/edit/apply_patch/task/webfetch/
// websearch as ABSENT keys asking for whatever OpenCode's default is. That
// second half is what makes the report a lie rather than a gap:
// production-runtime.ts hardcodes `allowMapOnly: true` and reports it as
// `allowMapEnforced` into the capability report the D1-11 admission gate
// trusts. An isolation control that is silently a no-op while the report
// calls it enforced is worse than an absent one (CLAUDE.md rule 4).
// ---------------------------------------------------------------------------
// The `tools` map as the provider received it. Reads the recorded prompt call
// rather than any client-side state, because "what we intended to send" is the
// claim that was already false.
function sentTools(fake: FakeSdk): Record<string, boolean> {
  const call = fake.promptCalls()[0];
  if (call === undefined) throw new Error("no prompt was sent");
  return (call.body as Record<string, unknown>).tools as Record<
    string,
    boolean
  >;
}

describe("createOpenCodeClient tool-surface translation (#122)", () => {
  test("enumerates the provider surface and denies every id it was not asked to allow", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);

    expect(sentTools(fake)).toEqual(EXPECTED_TOOL_MAP);

    // Enumeration is not optional and not cached from a hardcoded list: the
    // surface is READ from the provider, scoped to the same directory the
    // prompt runs in.
    expect(fake.toolIdsCalls()).toHaveLength(1);
    expect(fake.toolIdsCalls()[0]).toEqual({
      directory: "/tmp/work",
    });
  });

  test("the sent map carries no key from the engine's canonical namespace", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);

    const keys = Object.keys(sentTools(fake));

    // The exact bug: these were sent verbatim and silently discarded.
    expect(keys).not.toContain("Read");
    expect(keys).not.toContain("Grep");
    expect(keys).not.toContain("Glob");
    expect(keys.filter((key) => key.startsWith("mcp__"))).toEqual([]);
    // The enumerated surface, plus the MCP ids pr-hero knows about and the
    // provider does not report (#141 fact 3) — measured on both endpoints,
    // before and after connect. Written explicitly rather than omitted for the
    // same reason as every enumerated id: an absent key asks for the
    // provider's default. Nothing else reaches the provider at all.
    expect(keys.sort()).toEqual(
      [...OPENCODE_TOOL_IDS, "codegraph_codegraph_explore"].sort(),
    );
  });

  test("every write-capable and escape-hatch tool is explicitly false, by name", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);

    const tools = sentTools(fake);
    for (const denied of [
      "write",
      "edit",
      "apply_patch",
      "task",
      "bash",
      "webfetch",
      "websearch",
    ]) {
      expect(tools[denied]).toBe(false);
    }
  });

  // PARITY, not construction. `mcp__codegraph__codegraph_explore` maps onto no
  // OpenCode built-in, and that is the correct outcome: on claude-code a repo
  // with no codegraph index runs its hunters with the other three tools and an
  // empty mcp.json. Mirroring that means the MCP name is simply absent from a
  // built-in map and the run proceeds. MCP expressibility on OpenCode is a
  // separate open question (#122 q2) — opencode-sdk.ts threads an
  // mcpConfigPath into the request that this client never applies.
  test("an unmappable canonical name is dropped, not invented and not fatal", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    expect(session.id).toBe(SESSION_ID);
    expect(Object.values(sentTools(fake)).filter(Boolean)).toHaveLength(3);
  });

  test("an allow the provider does not offer never appears in the map", async () => {
    // A surface WITHOUT `grep` — a plugin build, an older opencode, a future
    // rename. The allowlist may only ever intersect the real surface;
    // inventing a key would be the absent-key hazard in reverse.
    const fake = fakeSdk({ toolIds: ["read", "glob", "bash", "write"] });
    const client = rig(fake);
    await client.createSession(INPUT);

    expect(sentTools(fake)).toEqual({
      read: true,
      glob: true,
      bash: false,
      write: false,
      // Off-surface by nature, still written: see EXPECTED_TOOL_MAP.
      codegraph_codegraph_explore: false,
    });
  });

  test("the resolved map is recorded on the session for the attempt's diagnostics", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    // #116's ledger requires the tools/MCP axis be provable by READING
    // artifacts, not assumed from source. The session carries the map the
    // transport actually sent so the attempt can stamp it into stderrTail.
    expect(session.toolMap).toEqual(EXPECTED_TOOL_MAP);
  });
});

// ---------------------------------------------------------------------------
// Free-tier gateway fix (2026-09-26). OpenCode's free catalogue 403s any turn
// whose tools map denies `bash` or `read` outright — see
// FREE_TIER_GATEWAY_TOOLS's WHY in opencode-client.ts for the full observed
// matrix. Scoped to `credentialKind === "provider_free"` alone: every other
// route (the tests above, all of them, none of which set `credentialKind`)
// must keep sending `bash: false` and never gain a permission key.
// ---------------------------------------------------------------------------
const TOOL_LESS_INPUT = { ...INPUT, tools: [] as string[] };

interface LaunchServerCall {
  mcp: unknown;
  freeTierGatewayAsk: readonly string[] | undefined;
}

function launchServerSpy(): {
  launchServer: (
    mcp?: unknown,
    freeTierGatewayAsk?: readonly string[],
  ) => Promise<{
    url: string;
    pid: number;
    gatewayAsk: readonly string[];
    close: () => Promise<void>;
  }>;
  calls: () => LaunchServerCall[];
} {
  const calls: LaunchServerCall[] = [];
  return {
    launchServer: async (
      mcp?: unknown,
      freeTierGatewayAsk?: readonly string[],
    ) => {
      calls.push({ mcp, freeTierGatewayAsk });
      // Attests exactly what it was asked to gate — a "correct launcher"
      // per the free-tier gateway attestation fix. The dedicated
      // unattested-launcher test below builds its OWN fake instead of
      // adding an escape hatch here.
      return {
        url: "http://127.0.0.1:1",
        pid: 1,
        gatewayAsk: freeTierGatewayAsk ?? [],
        close: async () => {},
      };
    },
    calls: () => calls,
  };
}

describe("createOpenCodeClient free-tier gateway fix", () => {
  test("a non-free route is byte-identical to today: bash stays false, no server ask", async () => {
    const fake = fakeSdk();
    const spy = launchServerSpy();
    const client = rig(fake, { launchServer: spy.launchServer });
    await client.createSession(INPUT);

    expect(sentTools(fake).bash).toBe(false);
    expect(sentTools(fake).read).toBe(true);
    expect(spy.calls()).toEqual([{ mcp: {}, freeTierGatewayAsk: [] }]);
  });

  test("a free route with a hunter-shaped spec keeps read granted and asks only for bash", async () => {
    const fake = fakeSdk();
    const spy = launchServerSpy();
    const client = rig(fake, {
      launchServer: spy.launchServer,
      credentialKind: "provider_free",
    });
    await client.createSession(INPUT);

    const tools = sentTools(fake);
    expect(tools.bash).toBeUndefined();
    expect("bash" in tools).toBe(false);
    expect(tools.read).toBe(true);
    expect(spy.calls()).toEqual([{ mcp: {}, freeTierGatewayAsk: ["bash"] }]);
  });

  test("a free route with a tool-less spec asks for both bash and read, never false", async () => {
    const fake = fakeSdk();
    const spy = launchServerSpy();
    const client = rig(fake, {
      launchServer: spy.launchServer,
      credentialKind: "provider_free",
    });
    await client.createSession(TOOL_LESS_INPUT);

    const tools = sentTools(fake);
    expect("bash" in tools).toBe(false);
    expect("read" in tools).toBe(false);
    expect(spy.calls()).toEqual([
      { mcp: {}, freeTierGatewayAsk: ["bash", "read"] },
    ]);
  });

  test("the session's recorded tool map also omits the asked ids, not just the sent one", async () => {
    const fake = fakeSdk();
    const client = rig(fake, { credentialKind: "provider_free" });
    const session = await client.createSession(TOOL_LESS_INPUT);

    expect("bash" in (session.toolMap ?? {})).toBe(false);
    expect("read" in (session.toolMap ?? {})).toBe(false);
  });

  // The residual risk #195 flags: the registry caches ONE opencode client per
  // route, so a hunter-shaped step and a tool-less step on the SAME
  // provider_free route share this server. Its permission config is fixed at
  // spawn, so a session that would need a DIFFERENT ask set than the one
  // already live must fail loud rather than silently inherit the wrong
  // isolation posture.
  test("a second concurrent session needing a different free-tier ask set fails loud", async () => {
    const fake = fakeSdk({ sessionIds: ["ses_a", "ses_b"] });
    const client = rig(fake, { credentialKind: "provider_free" });

    // Session A stays open (never aborted, never ended) so the shared server
    // is never released as idle before session B arrives.
    await client.createSession(INPUT);

    await expect(client.createSession(TOOL_LESS_INPUT)).rejects.toThrow(
      /free-tier gateway permission set/,
    );
  });

  // -------------------------------------------------------------------------
  // Launch-seam attestation. The tools-map deletion loop above is only safe
  // because the launched server actually gates the denied ids on its own
  // permission surface — and `launchServer` is caller-injectable, so that is
  // an assumption about an argument, not a guaranteed fact. These tests
  // exercise createSession's own runtime check of the launcher's
  // attestation (`OpenCodeServerHandle.gatewayAsk`), independent of the
  // type system.
  // -------------------------------------------------------------------------
  test("(a) a launcher that ignores the ask argument makes createSession refuse before any session or prompt", async () => {
    const fake = fakeSdk();
    let closed = 0;
    const client = rig(fake, {
      // Ignores freeTierGatewayAsk entirely (never declares the parameter)
      // and returns a handle that attests nothing — the exact shape the
      // attestation check exists to catch: a launcher that was never
      // updated to honour its second argument.
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {
          closed++;
        },
      }),
      credentialKind: "provider_free",
    });

    await expect(client.createSession(TOOL_LESS_INPUT)).rejects.toThrow(
      /did not attest the free-tier gateway ask posture/,
    );
    // Nothing beyond the launch itself was ever attempted: no tool
    // enumeration, no session, no prompt with bash lifted off the deny map.
    expect(fake.toolIdsCalls()).toHaveLength(0);
    expect(fake.createdAt()).toBe(0);
    expect(fake.promptCalls()).toHaveLength(0);
    // And the refused server does not outlive the refusal.
    expect(closed).toBe(1);
  });

  test("(b) a launcher that attests exactly the asked set lets the session proceed normally", async () => {
    const fake = fakeSdk();
    const spy = launchServerSpy();
    const client = rig(fake, {
      launchServer: spy.launchServer,
      credentialKind: "provider_free",
    });

    const session = await client.createSession(TOOL_LESS_INPUT);

    expect(session.id).toBe(SESSION_ID);
    expect(fake.promptCalls()).toHaveLength(1);
    expect(spy.calls()).toEqual([
      { mcp: {}, freeTierGatewayAsk: ["bash", "read"] },
    ]);
  });

  test("(c) a non-free route needs no attestation even from a handle that attests nothing", async () => {
    const fake = fakeSdk();
    const client = rig(fake, {
      // Same unattested handle as (a) above, but no credentialKind at all:
      // deniedGatewayTools is empty, so the attestation check never fires.
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {},
      }),
    });

    const session = await client.createSession(INPUT);

    expect(session.id).toBe(SESSION_ID);
    expect(sentTools(fake).bash).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fail closed. A session whose tool surface cannot be established is the
// runtime being unavailable — there is no partial map and no hardcoded
// fallback, because either one would re-create the exact "we believe this is
// enforced" claim the defect was made of.
// ---------------------------------------------------------------------------
describe("createOpenCodeClient tool-surface failure (#122)", () => {
  test("a rejecting tool.ids aborts the session before any prompt is sent", async () => {
    const fake = fakeSdk({ toolIds: new Error("boom") });
    const client = rig(fake);

    await expect(client.createSession(INPUT)).rejects.toThrow(/tool/i);
    expect(fake.promptCalls()).toHaveLength(0);
  });

  // #128 moved enumeration after session.create, so a surface failure now
  // has a remote session to unwind. The prompt still must not fire.
  test("a rejecting tool.ids still aborts a session that already exists", async () => {
    const fake = fakeSdk({ toolIds: new Error("boom") });
    const client = rig(fake);

    await expect(client.createSession(INPUT)).rejects.toThrow(/tool/i);
    expect(fake.promptCalls()).toHaveLength(0);
    expect(fake.abortCalls()).toBe(1);
    expect(fake.streamReturns()).toBe(1);
  });

  test("an empty surface is refused rather than treated as 'deny nothing'", async () => {
    const fake = fakeSdk({ toolIds: [] });
    const client = rig(fake);

    await expect(client.createSession(INPUT)).rejects.toThrow(/tool/i);
    expect(fake.promptCalls()).toHaveLength(0);
  });

  test("the transport classifies an unestablishable surface as runtime_unavailable", async () => {
    const fake = fakeSdk({ toolIds: new Error("boom") });
    const transport = new OpenCodeSdkTransport({ client: rig(fake) });
    const sink: AsyncEventSink = {
      push: async (_event: ProviderEvent) => "accepted" as const,
      close: async () => {},
    };
    const request: TransportRequest = {
      sessionId: "oc-sess-122",
      attempt: 1,
      route: {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt",
        modelSnapshot: "gpt-test-snapshot",
      },
      executionModel: "gpt-test-snapshot",
      effort: "high",
      systemPromptPath: "/tmp/system.md",
      systemPromptSha256: "deadbeef",
      userPrompt: "review this",
      cwd: "/tmp/work",
      tools: INPUT.tools,
      isolation: {
        credentialProjectionId: "proj-1",
        env: {},
        syntheticHome: "/tmp/home",
        syntheticConfigHome: "/tmp/config",
        syntheticTmp: "/tmp/tmp",
        verifiedBinaryPath: "/usr/bin/true",
      },
    };

    const outcome = await transport.execute(request, {
      signal: new AbortController().signal,
      events: sink,
    });

    expect(outcome.completion).toBe("failed");
    // Terminal, and NOT a format_violation: the model never saw the attempt,
    // so spending the format-reminder budget on it is the issue-#121 mistake.
    expect(transport.classifyFailure(outcome)).toBe("runtime_unavailable");
    expect(fake.promptCalls()).toHaveLength(0);
  });
});

describe("createOpenCodeClient", () => {
  test("buffered events survive the gap between createSession and streamEvents", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);
    // #124: a delta names a part, and a part is only an answer channel once
    // `message.part.updated` has announced it under an assistant message.
    // These two events are the stream's preamble, not its subject.
    fake.emit({
      type: "message.updated",
      properties: {
        sessionID: SESSION_ID,
        info: {
          id: "msg_a",
          role: "assistant",
          sessionID: SESSION_ID,
          parentID: ASSISTANT.parentID,
          path: ASSISTANT.path,
          time: { created: 1 },
        },
      },
    });
    fake.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESSION_ID,
        part: {
          id: "prt_answer",
          messageID: "msg_a",
          sessionID: SESSION_ID,
          type: "text",
          text: "",
        },
        time: 1,
      },
    });
    fake.emit({
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
        partID: "prt_answer",
        messageID: "msg_a",
        field: "text",
        delta: "early",
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    fake.endStream();

    const seen: string[] = [];
    for await (const event of client.streamEvents(session)) {
      if (event.kind === "delta") seen.push(event.text);
    }
    expect(seen).toEqual(["early"]);
  });

  // #127: a completed assistant message is a completed STEP. The terminal
  // arrives at the turn boundary — session.idle — and quotes the last
  // completion record seen before it.
  test("the stream stops at the terminal and yields the provider's proof", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);
    fake.emit(messageEvent());
    fake.emit({ type: "session.idle", properties: { sessionID: SESSION_ID } });
    fake.endStream();

    const kinds: string[] = [];
    for await (const event of client.streamEvents(session)) {
      kinds.push(event.kind);
      if (event.kind === "terminal") {
        expect(event.proof.eventId).toBe(ASSISTANT.id as string);
        // Normalised, not the raw finish reason — see PR #82's BLOCKER.
        expect(event.proof.providerStatus).toBe("completed");
      }
    }
    expect(kinds).toContain("terminal");
  });

  // #228: the subscription loop reads ONE directory-scoped stream shared by
  // every concurrent hunter's session on the same server, and used to
  // `evidence.record("event", raw)` every event it saw — roughly 55% of a
  // real capture's records turned out to be OTHER sessions' events, which
  // filled the record/byte cap long before this session's own silence
  // window. The provider's session id can live in `properties.sessionID`,
  // `properties.part.sessionID`, or `properties.info.sessionID`; an event
  // carrying none of those (no session id anywhere) is still recorded, since
  // there is nothing to filter it against.
  test("records only this session's own events plus session-less ones, never another session's", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession({
      ...INPUT,
      correlation: { sessionId: "h", attempt: 1 },
    });

    fake.emit({ type: "own.top", properties: { sessionID: SESSION_ID } });
    fake.emit({ type: "foreign.top", properties: { sessionID: "ses_other" } });
    fake.emit({
      type: "own.part",
      properties: { part: { sessionID: SESSION_ID } },
    });
    fake.emit({
      type: "foreign.part",
      properties: { part: { sessionID: "ses_other" } },
    });
    fake.emit({
      type: "own.info",
      properties: { info: { sessionID: SESSION_ID } },
    });
    fake.emit({
      type: "foreign.info",
      properties: { info: { sessionID: "ses_other" } },
    });
    fake.emit({ type: "sessionless", properties: { foo: "bar" } });
    await new Promise((r) => setTimeout(r, 10));
    fake.endStream();

    const capture = client.takeEvidence?.("h", 1);
    expect(capture).toBeDefined();
    const parsed = JSON.parse(
      (capture as { redactedJson: string }).redactedJson,
    );
    const recordedTypes = (
      parsed.records as Array<{ kind: string; data: { type?: string } }>
    )
      .filter((r) => r.kind === "event")
      .map((r) => r.data.type);

    expect(recordedTypes).toEqual([
      "own.top",
      "own.part",
      "own.info",
      "sessionless",
    ]);
  });

  // #157 (pr-157-8df2fca3-6): a hunter's tool call for a path OUTSIDE the
  // reviewed worktree tripped `permission.asked` for `external_directory`
  // twice in one run, and pr-hero never answers OpenCode's permission
  // prompt — the tool call sat blocked until the silence tripwire killed the
  // attempt 150s later at $0. The server-side deny config
  // (opencode-server.ts) is the primary control; this is defense in depth
  // for whatever it does not cover, so it rejects ANY permission, not only
  // `external_directory`.
  test("an own-session permission.asked immediately rejects the request, exactly once", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.emit({
      type: "permission.asked",
      properties: {
        id: "per_01ABC",
        sessionID: SESSION_ID,
        permission: "external_directory",
        patterns: ["/Users/juanma/.prhero/repos/.../mobile/*"],
        metadata: {},
        always: [],
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    fake.endStream();
    // Drain so the pump has certainly run to completion.
    for await (const _event of client.streamEvents(session)) {
      // no-op: only the reply side effect is under test here
    }

    expect(fake.replyCalls()).toEqual([
      { requestID: "per_01ABC", directory: INPUT.cwd, reply: "reject" },
    ]);
  });

  test("a permission.asked for another session triggers no reply", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.emit({
      type: "permission.asked",
      properties: {
        id: "per_other",
        sessionID: "ses_other",
        permission: "external_directory",
        patterns: ["/anywhere"],
        metadata: {},
        always: [],
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    fake.endStream();
    for await (const _event of client.streamEvents(session)) {
      // no-op
    }

    expect(fake.replyCalls()).toEqual([]);
  });

  test("a failing reject reply settles the attempt failed with the witness, well before usefulProgressMs, not protocol_truncation", async () => {
    const fake = fakeSdk({ permissionReplyError: "permission service down" });
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.emit({
      type: "permission.asked",
      properties: {
        id: "per_fails",
        sessionID: SESSION_ID,
        permission: "external_directory",
        patterns: ["/blocked"],
        metadata: {},
        always: [],
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    // Races against a real, bounded timeout rather than draining forever:
    // against UNMODIFIED code nothing ever settles `streamEvents`, and a
    // plain `for await` would hang the whole file, not just this test.
    const iterator = client.streamEvents(session)[Symbol.asyncIterator]();
    let thrown: Error | undefined;
    try {
      for (;;) {
        const step = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("test timeout: stream never settled")),
              200,
            );
          }),
        ]);
        if (step.done) break;
      }
    } catch (error) {
      thrown = error as Error;
    } finally {
      fake.endStream();
      await iterator.return?.();
    }

    expect(thrown?.message).toContain("permission service down");
    // Ties this failure to the marker classifyFailure keys on
    // (opencode-sdk.ts's formatPermissionRejectFailureDetail) rather than a
    // coincidental substring match.
    expect(thrown?.message).toContain(
      "failed to reject an OpenCode permission request",
    );
  });

  // PR #228 review, F002 (CRITICAL, corroborated): the SSE client can
  // redeliver events after a Last-Event-ID reconnect — the same redelivery
  // hazard #227 dedupes for stream deltas. A replayed `permission.asked`
  // used to send a SECOND reply for a request the server already closed; if
  // that second reply failed, the catch settled a successfully-denied
  // prompt as a terminal `runtime_unavailable`.
  test("a redelivered permission.asked replies only once and does not fail the attempt (F002)", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    const event = {
      type: "permission.asked",
      properties: {
        id: "per_dup",
        sessionID: SESSION_ID,
        permission: "external_directory",
        patterns: ["/blocked"],
        metadata: {},
        always: [],
      },
    };
    fake.emit(event);
    fake.emit(event); // SSE redelivery of the SAME requestID
    await new Promise((r) => setTimeout(r, 10));
    fake.endStream();

    let thrown: Error | undefined;
    try {
      for await (const _event of client.streamEvents(session)) {
        // drain
      }
    } catch (error) {
      thrown = error as Error;
    }

    expect(fake.replyCalls()).toHaveLength(1);
    expect(thrown).toBeUndefined();
  });

  // The specific race the fix must close: the requestID has to be recorded
  // BEFORE the reply is awaited, not after it resolves — otherwise a
  // duplicate arriving while the first reply is genuinely still in flight
  // races the write instead of losing to it deterministically.
  test("a duplicate delivered while the first reply is still pending triggers no second reply (F002)", async () => {
    const fake = fakeSdk({ permissionReplyHangs: true });
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    const event = {
      type: "permission.asked",
      properties: {
        id: "per_pending",
        sessionID: SESSION_ID,
        permission: "external_directory",
        patterns: ["/blocked"],
        metadata: {},
        always: [],
      },
    };
    fake.emit(event);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.replyCalls()).toHaveLength(1);

    // The duplicate arrives while the first reply is still parked on the
    // gate — genuinely in flight, not merely fast.
    fake.emit(event);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.replyCalls()).toHaveLength(1);

    fake.releasePendingReplies();
    await new Promise((r) => setTimeout(r, 10));
    fake.endStream();
    for await (const _event of client.streamEvents(session)) {
      // drain
    }
  });

  test("permission.asked for two different requestIDs replies to both (F002)", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.emit({
      type: "permission.asked",
      properties: {
        id: "per_a",
        sessionID: SESSION_ID,
        permission: "external_directory",
        patterns: ["/a"],
        metadata: {},
        always: [],
      },
    });
    fake.emit({
      type: "permission.asked",
      properties: {
        id: "per_b",
        sessionID: SESSION_ID,
        permission: "external_directory",
        patterns: ["/b"],
        metadata: {},
        always: [],
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    fake.endStream();
    for await (const _event of client.streamEvents(session)) {
      // drain
    }

    expect(fake.replyCalls().map((c) => c.requestID)).toEqual([
      "per_a",
      "per_b",
    ]);
  });

  function askEvent(id: string) {
    return {
      type: "permission.asked",
      properties: {
        id,
        sessionID: SESSION_ID,
        permission: "external_directory",
        patterns: [],
        metadata: {},
        always: [],
      },
    };
  }

  // PR #228 review (round 2), F002 (CRITICAL, corroborated): the bounded
  // `respondedPermissions` set used to be maintained with `rememberId`,
  // which evicts the OLDEST requestID once the cap is full — the same
  // pattern every other bounded id set in this file uses. But an evicted
  // requestID is indistinguishable from one this session never saw, so a
  // later SSE redelivery of THAT evicted id would pass the dedupe guard and
  // fire a second `permission.reply` for a request the server already
  // closed. 512 distinct prompts inside one step is already anomalous, so
  // the fix fails the attempt closed instead of ever forgetting an id.
  test("the permission request cap is exceeded, fails the attempt closed instead of forgetting old requestIDs (F002)", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    const CAP = 512;
    for (let i = 0; i < CAP; i++) fake.emit(askEvent(`per_${i}`));
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.replyCalls()).toHaveLength(CAP);

    // One more DISTINCT requestID, past the cap.
    fake.emit(askEvent("per_overflow"));
    await new Promise((r) => setTimeout(r, 20));
    fake.endStream();

    // Races against a real, bounded timeout rather than draining forever —
    // same pattern as "a failing reject reply settles..." above.
    const iterator = client.streamEvents(session)[Symbol.asyncIterator]();
    let thrown: Error | undefined;
    try {
      for (;;) {
        const step = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("test timeout: stream never settled")),
              200,
            );
          }),
        ]);
        if (step.done) break;
      }
    } catch (error) {
      thrown = error as Error;
    } finally {
      await iterator.return?.();
    }

    expect(thrown?.message).toContain("permission request cap exceeded (512)");
    // No reply ever went out for the id that pushed past the cap.
    expect(fake.replyCalls()).toHaveLength(CAP);
    expect(fake.replyCalls().some((c) => c.requestID === "per_overflow")).toBe(
      false,
    );
  });

  // Regression/sanity companion to the cap test above: a set holding many
  // (but not cap-exceeding) ids must not spontaneously start misbehaving —
  // the first id ever added is still exactly as protected as it was when
  // the set was empty. Because it deliberately stays under the cap, this
  // test does NOT by itself catch a `rememberId`-eviction regression (with
  // this few ids, `rememberId`'s own eviction never triggers either) — the
  // cap test above is the one that does.
  test("a redelivery of the first requestID after the set holds many ids still sends no second reply (F002)", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    const MANY = 300;
    for (let i = 0; i < MANY; i++) fake.emit(askEvent(`many_${i}`));
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.replyCalls()).toHaveLength(MANY);

    // Redeliver the very FIRST requestID ever seen.
    fake.emit(askEvent("many_0"));
    await new Promise((r) => setTimeout(r, 20));
    fake.endStream();

    let thrown: Error | undefined;
    try {
      for await (const _event of client.streamEvents(session)) {
        // drain
      }
    } catch (error) {
      thrown = error as Error;
    }

    expect(fake.replyCalls()).toHaveLength(MANY);
    expect(thrown).toBeUndefined();
  });

  // #223: pollStatus's boundary is GET /session/status, scoped by `directory`
  // exactly like GET /event — it must query the SAME directory session.create
  // registered (state.turn.expectedCwd, which IS input.cwd) or it watches an
  // instance that has never heard of this session.
  test("polls status with the same directory session.create registered", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);
    fake.setStatus({ type: "busy" });

    await client.pollStatus(session);

    expect(fake.statusCalls()).toEqual([{ directory: INPUT.cwd }]);
  });

  // #127. The poll observer used to scan session.messages() for the last
  // completed assistant message and call that the turn's terminal. At any poll
  // instant "last completed" is step 1 until step 2 exists, so it agreed with
  // the stream observer for a defective reason — two observers of one wrong
  // fact are not two observers, which is why §197 could not catch this.
  //
  // Its boundary is now GET /session/status: a different endpoint, queried
  // directly, and the only genuinely independent thing available to a caller
  // with no event stream.
  test("poll reports pending while the session is still working", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.setStatus({ type: "busy" });
    fake.setMessages([
      {
        info: { id: ASSISTANT.parentID, role: "user", sessionID: SESSION_ID },
        parts: [],
      },
    ]);
    expect((await client.pollStatus(session)).kind).toBe("pending");

    // A completed step, mid-turn. THE defect: this used to be a terminal.
    fake.setMessages([
      {
        info: { id: ASSISTANT.parentID, role: "user", sessionID: SESSION_ID },
        parts: [],
      },
      { info: ASSISTANT, parts: [] },
    ]);
    expect((await client.pollStatus(session)).kind).toBe("pending");

    // A session in backoff is neither done nor idle: more steps are coming.
    fake.setStatus({ type: "retry", attempt: 2, message: "429", next: 1 });
    expect((await client.pollStatus(session)).kind).toBe("pending");

    // The work stopped, so opencode drops the session from the status map.
    fake.setStatus(undefined);
    const done = await client.pollStatus(session);
    expect(done.kind).toBe("terminal");
    if (done.kind !== "terminal") throw new Error("unreachable");
    // The SAME proof the stream produces. §197 needs two INDEPENDENT
    // observers of one fact, not two facts that happen to look alike — so
    // both paths run through terminalProofFromAssistant.
    expect(done.proof.eventId).toBe(ASSISTANT.id as string);
  });

  // A poll-won turn is a supported delivery path (its answer text already
  // rides `terminalFinalText`), so a hunter this observer is the FIRST to see
  // a completed tool call for — the stream never delivered a "tool" event for
  // this turn — must still be able to prove it looked. Two messages, dev's
  // shape: the tool call lives on its own `finish: "tool-calls"` step, the
  // answer on a second message parented to it (opencode-client.ts's
  // `isIntermediateToolStep`).
  test("a poll-only completed tool call is tallied on the terminal result (#214)", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    const toolStepId = "msg_tool_step";
    const finalMessage = {
      ...ASSISTANT,
      id: "msg_poll_final",
      parentID: toolStepId,
    };

    fake.setStatus({ type: "busy" });
    expect((await client.pollStatus(session)).kind).toBe("pending");

    fake.setMessages([
      {
        info: { id: ASSISTANT.parentID, role: "user", sessionID: SESSION_ID },
        parts: [],
      },
      {
        info: {
          id: toolStepId,
          role: "assistant",
          sessionID: SESSION_ID,
          parentID: ASSISTANT.parentID,
          path: { cwd: "/tmp/work", root: "/" },
          finish: "tool-calls",
          time: { completed: 1 },
        },
        parts: [
          {
            id: "prt_tool_read",
            sessionID: SESSION_ID,
            messageID: toolStepId,
            type: "tool",
            callID: "call_read_1",
            tool: "read",
            state: { status: "completed" },
          },
        ],
      },
      {
        info: finalMessage,
        parts: [
          {
            id: "prt_final",
            sessionID: SESSION_ID,
            messageID: "msg_poll_final",
            type: "text",
            text: '{"findings":[]}',
          },
        ],
      },
    ]);
    fake.setStatus(undefined);

    const result = await client.pollStatus(session);
    expect(result.kind).toBe("terminal");
    if (result.kind !== "terminal") throw new Error("unreachable");
    expect(result.completedToolCallIds).toEqual(["call_read_1"]);
  });

  // pr-hero review F001 (round 2, opencode-client.ts:809): end-to-end through
  // the REAL client and the REAL transport (not a mocked `OpenCodeClientLike`
  // — the defect lives entirely inside `handlePartUpdated`, which a mocked
  // transport-level test bypasses). Before the fix, the stream emitted ZERO
  // `{kind:"tool"}` events for an error->completed callID, so this attempt's
  // `outcome.toolInvocations` silently stayed 0 despite a real completion the
  // stream itself watched happen.
  test("a stream call observed error then completed still tallies once at the transport level (F001 round 2)", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const transport = new OpenCodeSdkTransport({ client });
    const sink: AsyncEventSink = {
      push: async (_event: ProviderEvent) => "accepted" as const,
      close: async () => {},
    };
    const request: TransportRequest = {
      sessionId: "oc-sess-f001-round2",
      attempt: 1,
      route: {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt",
        modelSnapshot: "gpt-test-snapshot",
      },
      executionModel: "gpt-test-snapshot",
      effort: "high",
      systemPromptPath: "/tmp/system.md",
      systemPromptSha256: "deadbeef",
      userPrompt: "review this",
      cwd: "/tmp/work",
      tools: INPUT.tools,
      isolation: {
        credentialProjectionId: "proj-1",
        env: {},
        syntheticHome: "/tmp/home",
        syntheticConfigHome: "/tmp/config",
        syntheticTmp: "/tmp/tmp",
        verifiedBinaryPath: "/usr/bin/true",
      },
    };

    const pending = transport.execute(request, {
      signal: new AbortController().signal,
      events: sink,
    });

    // #124: createSession()/streamEvents() run inside execute() — early
    // events survive the gap by buffering (see the "buffered events survive"
    // test above), so emitting right away is safe.
    fake.emit(messageEvent());
    fake.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESSION_ID,
        part: {
          id: "prt_tool_err_ok",
          messageID: ASSISTANT.id,
          sessionID: SESSION_ID,
          type: "tool",
          callID: "call_err_then_ok",
          tool: "read",
          state: { status: "error" },
        },
      },
    });
    fake.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESSION_ID,
        part: {
          id: "prt_tool_err_ok",
          messageID: ASSISTANT.id,
          sessionID: SESSION_ID,
          type: "tool",
          callID: "call_err_then_ok",
          tool: "read",
          state: { status: "completed" },
        },
      },
    });
    fake.emit({ type: "session.idle", properties: { sessionID: SESSION_ID } });
    fake.endStream();

    const outcome = await pending;
    expect(outcome.completion).toBe("success");
    expect(outcome.toolInvocations).toBe(1);
  });

  // pr-hero review F001 (round 3, opencode-client.ts:812 as b7b45c1 left it):
  // the D-9/D-11 race, live. A non-stream observer (here, a POLL round that
  // reconciles the readback but is not itself the turn's final message — the
  // same reconcile a prompt_result readback also runs) sees callID A
  // "completed" BEFORE the stream's own SSE event for that exact completion
  // ever arrives. Round 2 deduped the stream's `{kind:"tool"}` emission
  // against the SHARED `completedToolCallIds` set that reconcile had already
  // written — so the stream's own emission was suppressed. When the STREAM,
  // not the poll, goes on to win the turn's terminal (no poll TERMINAL ever
  // reports this callID), the transport's union never learns of it from any
  // channel, and `toolInvocations` comes out 0 for a hunt that plainly
  // looked. Driven at the client's own session/pollStatus/streamEvents
  // surface (not through `OpenCodeSdkTransport`) so the ONLY poll
  // observation is the one this test drives by hand — a transport-owned
  // background poll loop sharing the same session would race unpredictably
  // against it and make the exact sequence being tested nondeterministic.
  test("a non-winning poll reconcile does not suppress the stream's own tally when the stream wins the terminal (F001 round 3)", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    // Arm `observedActive` (a "busy" status is required before pollStatus
    // will ever read back messages at all).
    fake.setStatus({ type: "busy" });
    expect((await client.pollStatus(session)).kind).toBe("pending");

    // A readback of a STILL-IN-PROGRESS turn (no `time.completed`, so it can
    // never itself be the winning terminal) that already shows call_race
    // completed — the non-winning reconcile this test is about.
    fake.setMessages([
      {
        info: { id: ASSISTANT.parentID, role: "user", sessionID: SESSION_ID },
        parts: [],
      },
      {
        info: {
          id: ASSISTANT.id,
          role: "assistant",
          sessionID: SESSION_ID,
          parentID: ASSISTANT.parentID,
          path: ASSISTANT.path,
          time: { created: 1 },
        },
        parts: [
          {
            id: "prt_tool_race",
            sessionID: SESSION_ID,
            messageID: ASSISTANT.id,
            type: "tool",
            callID: "call_race",
            tool: "read",
            state: { status: "completed" },
          },
        ],
      },
    ]);
    fake.setStatus(undefined);
    expect((await client.pollStatus(session)).kind).toBe("pending");

    // NOW the stream independently delivers its own SSE events for the SAME
    // callID and wins the terminal — no poll terminal ever reports it.
    fake.emit(messageEvent());
    fake.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESSION_ID,
        part: {
          id: "prt_tool_race",
          messageID: ASSISTANT.id,
          sessionID: SESSION_ID,
          type: "tool",
          callID: "call_race",
          tool: "read",
          state: { status: "completed" },
        },
      },
    });
    fake.emit({ type: "session.idle", properties: { sessionID: SESSION_ID } });
    fake.endStream();

    const toolEvents: OpenCodeClientEvent[] = [];
    for await (const event of client.streamEvents(session)) {
      if (event.kind === "tool") toolEvents.push(event);
    }
    expect(toolEvents).toEqual([
      { kind: "tool", tool: "read", callId: "call_race" },
    ]);
  });

  // Absence is the boundary, but it is ALSO what a wrong or missing
  // `directory` scope looks like — #223 measured (opencode 1.18.30) that
  // `GET /session/status` given a directory other than the one session.create
  // registered returns {} for a session that is BUSY at that moment, the same
  // shape as one that has finished. The response cannot tell the two apart,
  // so an absence that has never been contradicted proves nothing; it only
  // counts once this observer has seen the provider name this session.
  test("poll never reads an unseen session's absence as a finished turn", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.setStatus(undefined);
    fake.setMessages([
      {
        info: { id: ASSISTANT.parentID, role: "user", sessionID: SESSION_ID },
        parts: [],
      },
      { info: ASSISTANT, parts: [] },
    ]);

    expect((await client.pollStatus(session)).kind).toBe("pending");
  });

  // The explicit arm of SessionStatus. This build omits an idle session rather
  // than sending it, but the union declares {type:"idle"} and a build that
  // does send it names the session — which both proves visibility and ends the
  // turn in one observation.
  test("an explicit idle status is a boundary on its own", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.setStatus({ type: "idle" });
    fake.setMessages([
      {
        info: { id: ASSISTANT.parentID, role: "user", sessionID: SESSION_ID },
        parts: [],
      },
      { info: ASSISTANT, parts: [] },
    ]);

    expect((await client.pollStatus(session)).kind).toBe("terminal");
  });

  // #157: pr-157-8df2fca3-4's complete capture — `GET /session/status`
  // reported this exact retry/account_rate_limit status for the whole
  // attempt, and the old code only ever read `type: "retry"` as "the provider
  // is still working" (line ~2578's `observedActive = true`), so the poll
  // kept the attempt alive for the full usefulProgressMs budget over a quota
  // that was never coming back. `account_rate_limit` is the only
  // `action.reason` observed across all three hunter captures of that run.
  const LIMIT_MESSAGE =
    "5 hour usage limit reached. It will reset in 22 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_01M17B67W4Q9BE4T0910EQ0NRY/go";

  test("a poll-observed account usage limit fails fast with the provider's message (#157)", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.setStatus({
      type: "retry",
      attempt: 1,
      message: LIMIT_MESSAGE,
      action: {
        reason: "account_rate_limit",
        provider: "opencode-go",
        title: "Go limit reached",
      },
    });

    const result = await client.pollStatus(session);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.detail).toContain(LIMIT_MESSAGE);
    expect(result.detail).toContain("account_rate_limit");
  });

  test("a poll-observed retry with no action reason keeps polling, not failed (#157)", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.setStatus({ type: "retry", attempt: 2, message: "429", next: 1 });

    expect((await client.pollStatus(session)).kind).toBe("pending");
  });

  test("a poll-observed retry with an unrecognised action reason keeps polling (#157)", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.setStatus({
      type: "retry",
      attempt: 1,
      message: "provider is retrying",
      action: { reason: "some_future_reason", provider: "opencode-go" },
    });

    expect((await client.pollStatus(session)).kind).toBe("pending");
  });

  // pr-hero F002/F003 on this PR, both BLOCKER, and both right — they are the
  // same defect seen twice. The background pump and streamEvents() iterated
  // the SAME subscription.stream. Two consumers on one async iterator race:
  // the pump consumed the event that flipped `drained` and then dropped it,
  // and its for-await exit fires an implicit .return() on the SHARED
  // generator, which can end it under the real consumer. This repo documented
  // that exact hazard in opencode-sdk.ts and then walked into it.
  //
  // Downstream it is worse than a dropped event: execute() builds finalText
  // from the deltas the STREAM saw, so if the poll recovers the terminal
  // instead, the attempt is reported success with silently truncated output.
  test("no event is lost at the buffered-to-live handoff", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    const delta = (text: string) => ({
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
        partID: "prt_answer",
        messageID: "msg_a",
        field: "text",
        delta: text,
      },
    });

    // #124: a delta names a part, and a part is only an answer channel once
    // `message.part.updated` has announced it under an assistant message.
    // These two events are the stream's preamble, not its subject.
    fake.emit({
      type: "message.updated",
      properties: {
        sessionID: SESSION_ID,
        info: {
          id: "msg_a",
          role: "assistant",
          sessionID: SESSION_ID,
          parentID: ASSISTANT.parentID,
          path: ASSISTANT.path,
          time: { created: 1 },
        },
      },
    });
    fake.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESSION_ID,
        part: {
          id: "prt_answer",
          messageID: "msg_a",
          sessionID: SESSION_ID,
          type: "text",
          text: "",
        },
        time: 1,
      },
    });

    // Two before anyone calls streamEvents (the buffered window)...
    fake.emit(delta("a"));
    fake.emit(delta("b"));
    await new Promise((r) => setTimeout(r, 10));

    const seen: string[] = [];
    const consuming = (async () => {
      for await (const event of client.streamEvents(session)) {
        if (event.kind === "delta") seen.push(event.text);
      }
    })();

    // ...and more arriving exactly across the switch to live.
    await new Promise((r) => setTimeout(r, 5));
    fake.emit(delta("c"));
    fake.emit(delta("d"));
    await new Promise((r) => setTimeout(r, 10));
    fake.endStream();
    await consuming;

    expect(seen.join("")).toBe("abcd");
  });

  test("the subscription has exactly ONE consumer", () => {
    // The structural guarantee behind the test above: a second for-await on
    // the same stream is the bug, so the count is the invariant.
    const fake = fakeSdk();
    const client = rig(fake);
    return (async () => {
      const session = await client.createSession(INPUT);
      fake.emit({
        type: "message.part.delta",
        properties: { sessionID: SESSION_ID, field: "text", delta: "x" },
      });
      await new Promise((r) => setTimeout(r, 5));
      fake.endStream();
      for await (const _event of client.streamEvents(session)) {
        // drain
      }
      expect(fake.iterators()).toBe(1);
    })();
  });

  // pr-hero F005. readSystemPrompt was awaited AFTER the server was
  // launched, the remote session created and the state registered — so a
  // throw there left a running server, a live remote session and a pump
  // behind, with the caller never given the id needed to abort any of it.
  //
  // The best unwind is the one with nothing to unwind: the prompt read is the
  // single step that fails on the operator's own filesystem, so it now runs
  // before anything is spawned at all.
  test("an unreadable system prompt never spawns anything", async () => {
    const fake = fakeSdk();
    let launched = 0;
    const client = createOpenCodeClient({
      loadSdk: async () => fake.sdk,
      launchServer: async () => {
        launched += 1;
        return { url: "http://127.0.0.1:1", pid: 1, close: async () => {} };
      },
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => {
        throw new Error("system prompt unreadable");
      },
    });
    await expect(client.createSession(INPUT)).rejects.toThrow(/unreadable/);
    expect(launched).toBe(0);
  });

  // And for the failures that CAN only happen after the server is up, the
  // unwind has to actually run.
  test("a failure after launch closes the server it started", async () => {
    const fake = fakeSdk();
    let closed = 0;
    const broken: OpenCodeSdkLike = {
      createOpencodeClient: () => ({
        ...fake.sdk.createOpencodeClient({ baseUrl: "" }),
        session: {
          ...fake.sdk.createOpencodeClient({ baseUrl: "" }).session,
          create: async () => {
            throw new Error("remote session refused");
          },
        },
      }),
    };
    const client = createOpenCodeClient({
      loadSdk: async () => broken,
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {
          closed += 1;
        },
      }),
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });
    await expect(client.createSession(INPUT)).rejects.toThrow(/refused/);
    expect(closed).toBe(1);
  });

  // Issue #121, second half. The SDK's `RequestResult` has TWO arms under the
  // default `ThrowOnError = false`: `{ data, error: undefined }` and
  // `{ data: undefined, error }`. The local interface declared only the first,
  // so an API error — a rejected model, a bad body, a 500 — reached
  // `created.data.id` with `data` undefined and became a TypeError. A
  // TypeError carries none of the provider's diagnosis and, being unmapped,
  // was classified a FORMAT violation and burned a format retry.
  test("a session.create error response fails with a diagnosable error", async () => {
    const fake = fakeSdk();
    const base = fake.sdk.createOpencodeClient({ baseUrl: "" });
    const erroring: OpenCodeSdkLike = {
      createOpencodeClient: () => ({
        ...base,
        session: {
          ...base.session,
          create: async () => ({
            data: undefined,
            error: { message: "model not found" },
          }),
        },
      }),
    };
    const client = createOpenCodeClient({
      loadSdk: async () => erroring,
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {},
      }),
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });

    // The provider's own words must survive into the message: they are the
    // whole reason the operator can tell an infrastructure failure from a
    // model one.
    await expect(client.createSession(INPUT)).rejects.toThrow(
      /session\.create.*model not found/s,
    );
  });

  // pr-hero F004. A server per SESSION means every attempt leaves a spawned
  // process behind, released only by a whole-client close() that is not even
  // part of OpenCodeClientLike. One server hosts many sessions; that is what
  // the API is for.
  test("one server hosts every session of a client", async () => {
    const fake = fakeSdk();
    let launches = 0;
    const client = createOpenCodeClient({
      loadSdk: async () => fake.sdk,
      launchServer: async () => {
        launches += 1;
        return {
          url: "http://127.0.0.1:1",
          pid: 1,
          close: async () => {},
        };
      },
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });
    await client.createSession(INPUT);
    await client.createSession(INPUT);
    expect(launches).toBe(1);
  });

  // pr-hero's re-review on this PR, and it is a regression the PREVIOUS fix
  // introduced: sharing one server across sessions created a cross-session
  // teardown that per-session servers could not have. `states.set` happens
  // only after session.create AND event.subscribe both succeed, so a sibling
  // still mid-establishment is invisible to `states.size === 0` — and a
  // failing call would SIGTERM the server that healthy sibling is using.
  test("a failing session never kills a sibling's server", async () => {
    const fake = fakeSdk();
    let closed = 0;
    let firstCreate = true;
    let releaseSecondCreate!: () => void;
    const secondCreateBlocked = new Promise<void>((r) => {
      releaseSecondCreate = r;
    });

    const base = fake.sdk.createOpencodeClient({ baseUrl: "" });
    const sdk: OpenCodeSdkLike = {
      createOpencodeClient: () => ({
        ...base,
        session: {
          ...base.session,
          create: async () => {
            if (firstCreate) {
              firstCreate = false;
              throw new Error("remote session refused");
            }
            // The sibling is parked exactly in the pre-states.set window.
            await secondCreateBlocked;
            return { data: { id: SESSION_ID, directory: INPUT.cwd } };
          },
        },
      }),
    };
    const client = createOpenCodeClient({
      loadSdk: async () => sdk,
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {
          closed += 1;
        },
      }),
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });

    const failing = client.createSession(INPUT);
    const sibling = client.createSession(INPUT);
    await expect(failing).rejects.toThrow(/refused/);
    // The failure has already unwound; the sibling has not registered yet.
    expect(closed).toBe(0);

    releaseSecondCreate();
    await sibling;
    expect(closed).toBe(0);
  });

  // The other half of the same unwind: a remote session that WAS created
  // before the failure is real work on the provider's side, and dropping the
  // local map entry does not release it.
  test("the unwind releases a remote session it already created", async () => {
    const fake = fakeSdk();
    const base = fake.sdk.createOpencodeClient({ baseUrl: "" });
    const sdk: OpenCodeSdkLike = {
      createOpencodeClient: () => ({
        ...base,
        event: {
          subscribe: async () => {
            throw new Error("subscribe failed");
          },
        },
      }),
    };
    const client = createOpenCodeClient({
      loadSdk: async () => sdk,
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {},
      }),
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });
    await expect(client.createSession(INPUT)).rejects.toThrow(/subscribe/);
    expect(fake.abortCalls()).toBe(1);
  });

  test("abort reaches the provider", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);
    await client.abort(session);
    expect(fake.abortCalls()).toBe(1);
  });

  // #131: the Map entry used to live until whole-client close(). abort() is
  // the attempt's teardown, so it owns the release. pollStatus must not
  // throw afterwards — a throw is a failed observation the harness counts
  // and retries forever (opencode-sdk.ts:707). It also must not answer
  // `{kind:"failed"}`: runPoll would settle session_failed and steal the
  // abortConfirmMs window.
  test("abort releases the session so a later poll does not throw", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);
    await client.abort(session);
    const result = await client.pollStatus(session);
    expect(result.kind).toBe("pending");
  });

  test("abort is idempotent after the session is released", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);
    await client.abort(session);
    await client.abort(session);
    expect(fake.abortCalls()).toBe(1);
  });

  test("abort of the last session releases the shared server", async () => {
    const fake = fakeSdk();
    let closed = 0;
    const client = rig(fake, {
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {
          closed += 1;
        },
      }),
    });
    const session = await client.createSession(INPUT);
    expect(closed).toBe(0);
    await client.abort(session);
    expect(closed).toBe(1);
  });

  test("abort of one session does not kill a sibling's server", async () => {
    const fake = fakeSdk({ sessionIds: ["ses_a", "ses_b"] });
    let closed = 0;
    const client = rig(fake, {
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {
          closed += 1;
        },
      }),
    });
    const first = await client.createSession(INPUT);
    const second = await client.createSession(INPUT);
    await client.abort(first);
    expect(closed).toBe(0);
    expect((await client.pollStatus(second)).kind).toBe("pending");
    await client.abort(second);
    expect(closed).toBe(1);
  });

  // pr-hero ships with ZERO runtime dependencies; the SDK is an optional
  // peer. A Claude-only install that never routes here must not break, and
  // one that DOES route here must be told what to install rather than
  // handed a module-resolution stack trace.
  test("a missing SDK fails with an actionable message", async () => {
    const client = createOpenCodeClient({
      loadSdk: async () => {
        throw new Error("Cannot find module '@opencode-ai/sdk'");
      },
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {},
      }),
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });
    await expect(client.createSession(INPUT)).rejects.toThrow(
      /@opencode-ai\/sdk/,
    );
  });
});

// ---------------------------------------------------------------------------
// #141: the Claude-shaped mcp.json translated into OpenCode's `Config.mcp`.
//
// TRANSLATED, never duplicated. `src/security/binding-policy.ts` already
// validates that exact file — no symlink, `mcpServers` empty or exactly
// ["codegraph"], optional sha256 pin — so a second OpenCode-shaped config
// would be a registry the integrity gate never sees. The two shapes are not
// compatible: Claude writes `mcpServers` / "stdio" / command-string + args
// array, OpenCode reads `mcp` / "local" / one command ARRAY
// (McpLocalConfig, types.gen.d.ts:946-969).
// ---------------------------------------------------------------------------
describe("translateMcpConfig (#141)", () => {
  test("emits OpenCode's McpLocalConfig for the codegraph server, byte-exact", () => {
    expect(
      translateMcpConfig({
        json: CLAUDE_MCP_JSON,
        configPath: "/run/mcp.json",
        cwd: "/tmp/work",
        codegraphBinaryPath: CODEGRAPH_BIN,
      }),
    ).toEqual({
      codegraph: {
        type: "local",
        command: [CODEGRAPH_BIN, "serve", "--mcp", "-p", "/tmp/work"],
        enabled: true,
      },
    });
  });

  // `-p <cwd>` is REQUIRED, not decorative. The OpenCode server process
  // inherits pr-hero's process cwd, NOT the review target: in PR mode the
  // target is a worktree, so a codegraph that resolved its project from cwd
  // would index the operator's checkout and answer every hunter about the
  // wrong tree — silently, since it would answer.
  test("scopes the server to the step's cwd, not the launcher's", () => {
    const config = translateMcpConfig({
      json: CLAUDE_MCP_JSON,
      configPath: "/run/mcp.json",
      cwd: "/tmp/worktrees/pr-141",
      codegraphBinaryPath: CODEGRAPH_BIN,
    });
    expect(config.codegraph?.command).toEqual([
      CODEGRAPH_BIN,
      "serve",
      "--mcp",
      "-p",
      "/tmp/worktrees/pr-141",
    ]);
  });

  // Parity with claude-code on a repo with no index (src/cli.ts:1263-1272):
  // an empty registry means no MCP at all, and the hunters run on
  // read/grep/glob. #116's pass-3 ledger recorded that as CORRECT.
  test("an empty registry translates to no servers at all", () => {
    expect(
      translateMcpConfig({
        json: EMPTY_MCP_JSON,
        configPath: "/run/mcp.json",
        cwd: "/tmp/work",
        codegraphBinaryPath: CODEGRAPH_BIN,
      }),
    ).toEqual({});
  });

  // FAIL LOUD, never degrade. The production env projection is exactly
  // {HOME, TMPDIR, XDG_DATA_HOME, XDG_CONFIG_HOME} (credential-broker.ts:
  // 449-457) — there is no PATH — so the bare "codegraph" the Claude-side
  // file carries cannot resolve in the child. Degrading to it would produce a
  // server that never connects, and E's readback would then abort the attempt
  // with a diagnosis pointing at the wrong thing.
  test("refuses to emit a command it cannot resolve to an absolute binary", () => {
    expect(() =>
      translateMcpConfig({
        json: CLAUDE_MCP_JSON,
        configPath: "/run/mcp.json",
        cwd: "/tmp/work",
      }),
    ).toThrow(/codegraph/i);
  });

  test("refuses a relative binary override for the same reason", () => {
    expect(() =>
      translateMcpConfig({
        json: CLAUDE_MCP_JSON,
        configPath: "/run/mcp.json",
        cwd: "/tmp/work",
        codegraphBinaryPath: "bin/codegraph",
      }),
    ).toThrow(/absolute/i);
  });

  // This translation knows how to build exactly one command. A server it does
  // not recognise must not be silently dropped — a dropped server is a tool
  // the prompt was promised and the model never gets, which is the absent-key
  // hazard resolveToolMap exists to kill.
  test("refuses a server it cannot express", () => {
    expect(() =>
      translateMcpConfig({
        json: JSON.stringify({
          mcpServers: { github: { type: "stdio", command: "gh-mcp" } },
        }),
        configPath: "/run/mcp.json",
        cwd: "/tmp/work",
        codegraphBinaryPath: CODEGRAPH_BIN,
      }),
    ).toThrow(/github/);
  });

  // A remote transport has no command to translate at all.
  test("refuses a non-stdio server", () => {
    expect(() =>
      translateMcpConfig({
        json: JSON.stringify({
          mcpServers: {
            codegraph: { type: "sse", url: "http://127.0.0.1:9/sse" },
          },
        }),
        configPath: "/run/mcp.json",
        cwd: "/tmp/work",
        codegraphBinaryPath: CODEGRAPH_BIN,
      }),
    ).toThrow(/stdio/);
  });

  test("refuses a file that is not JSON, naming the path", () => {
    expect(() =>
      translateMcpConfig({
        json: "{",
        configPath: "/run/mcp.json",
        cwd: "/tmp/work",
        codegraphBinaryPath: CODEGRAPH_BIN,
      }),
    ).toThrow(/\/run\/mcp\.json/);
  });
});

// ---------------------------------------------------------------------------
// #141 §E: the readback. This is the OpenCode analogue of claude-code's
// `--strict-mcp-config`, and it is strictly stronger because it is VERIFIED
// rather than declared.
// ---------------------------------------------------------------------------
describe("assertMcpConnected (#141)", () => {
  test("accepts exactly the declared set, connected", () => {
    expect(() =>
      assertMcpConnected({ codegraph: { status: "connected" } }, ["codegraph"]),
    ).not.toThrow();
  });

  test("accepts an empty status for an empty declaration", () => {
    expect(() => assertMcpConnected({}, [])).not.toThrow();
  });

  // Measured (#141 fact 7): `--pure` suppresses neither config-delivered nor
  // config-FILE MCP servers, so a server launched with the operator's real
  // HOME loads ~/.config/opencode/opencode.jsonc and connects whatever the
  // operator configured. Production is shielded only INCIDENTALLY, by the
  // synthetic XDG_CONFIG_HOME. An extra server is an undeclared tool channel
  // in a process holding a projected credential.
  test("refuses a server pr-hero did not declare", () => {
    expect(() =>
      assertMcpConnected(
        {
          codegraph: { status: "connected" },
          "operator-thing": { status: "connected" },
        },
        ["codegraph"],
      ),
    ).toThrow(/operator-thing/);
  });

  test("refuses a declared server that is missing", () => {
    expect(() => assertMcpConnected({}, ["codegraph"])).toThrow(/codegraph/);
  });

  test("refuses a declared server that is not connected", () => {
    expect(() =>
      assertMcpConnected({ codegraph: { status: "failed" } }, ["codegraph"]),
    ).toThrow(/failed/);
  });

  // An unreadable response proves nothing, and "nothing extra is connected"
  // is exactly the claim that cannot be made from it.
  test("refuses a response it cannot read", () => {
    expect(() => assertMcpConnected("connected", [])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// #141: MCP applied, end to end through the client.
//
// The defect this closes: `mcpConfigPath` was threaded from the harness, into
// the transport request, into createSession — and then applied to nothing. The
// OpenCode route's hunters ran without codegraph on every repo, indexed or
// not, and no artifact said so.
// ---------------------------------------------------------------------------
const MCP_INPUT = { ...INPUT, mcpConfigPath: "/run/mcp.json" };

function launchRecorder() {
  const launches: Array<unknown> = [];
  return {
    launches: () => launches,
    launchServer: async (mcp?: unknown) => {
      launches.push(mcp);
      return { url: "http://127.0.0.1:1", pid: 1, close: async () => {} };
    },
  };
}

describe("createOpenCodeClient MCP delivery (#141)", () => {
  test("hands the translated registry to the server launch, not to a running server", async () => {
    const fake = fakeSdk();
    fake.setMcpStatus({ codegraph: { status: "connected" } });
    const launcher = launchRecorder();
    const client = rig(fake, {
      launchServer: launcher.launchServer,
      readMcpConfig: async () => CLAUDE_MCP_JSON,
    });

    await client.createSession(MCP_INPUT);

    // Config present from the server's first byte is the point: it leaves no
    // window between "server up" and "MCP connected" (the #128 race class).
    expect(launcher.launches()).toEqual([
      {
        codegraph: {
          type: "local",
          command: [CODEGRAPH_BIN, "serve", "--mcp", "-p", "/tmp/work"],
          enabled: true,
        },
      },
    ]);
  });

  test("reads the registry the binding policy already gates, by its own path", async () => {
    const fake = fakeSdk();
    fake.setMcpStatus({ codegraph: { status: "connected" } });
    const read: string[] = [];
    const client = rig(fake, {
      readMcpConfig: async (p: string) => {
        read.push(p);
        return CLAUDE_MCP_JSON;
      },
    });

    await client.createSession(MCP_INPUT);

    // One source of truth. A second, OpenCode-shaped config would be a
    // registry `binding-policy.ts` never validates.
    expect(read).toEqual(["/run/mcp.json"]);
  });

  test("allows the codegraph MCP tool once its server is delivered", async () => {
    const fake = fakeSdk();
    fake.setMcpStatus({ codegraph: { status: "connected" } });
    const client = rig(fake, { readMcpConfig: async () => CLAUDE_MCP_JSON });

    const session = await client.createSession(MCP_INPUT);

    expect(session.toolMap).toEqual({
      ...EXPECTED_TOOL_MAP,
      codegraph_codegraph_explore: true,
    });
  });

  // Parity, and #116's pass-3 ledger recorded it as CORRECT: a repo with no
  // index yields {"mcpServers":{}}, no MCP is delivered, and the hunters run
  // on read/grep/glob. The empty case must not fail the readback.
  test("a repo with no codegraph index delivers nothing and still runs", async () => {
    const fake = fakeSdk();
    const launcher = launchRecorder();
    const client = rig(fake, {
      launchServer: launcher.launchServer,
      readMcpConfig: async () => EMPTY_MCP_JSON,
    });

    const session = await client.createSession(MCP_INPUT);

    expect(launcher.launches()).toEqual([{}]);
    expect(session.toolMap?.codegraph_codegraph_explore).toBe(false);
    expect(fake.promptCalls()).toHaveLength(1);
  });

  // FAIL LOUD, never degrade. The opencode child is spawned with no PATH, so
  // the bare "codegraph" the Claude-side file carries cannot start.
  test("an unresolvable codegraph binary aborts before any prompt is sent", async () => {
    const fake = fakeSdk();
    const client = rig(fake, {
      readMcpConfig: async () => CLAUDE_MCP_JSON,
      codegraphBinaryPath: undefined,
    });

    await expect(client.createSession(MCP_INPUT)).rejects.toThrow(/codegraph/i);
    expect(fake.promptCalls()).toHaveLength(0);
  });

  test("a declared registry with no reader configured aborts rather than skipping MCP", async () => {
    const fake = fakeSdk();
    const client = rig(fake, { readMcpConfig: undefined });

    await expect(client.createSession(MCP_INPUT)).rejects.toThrow(/mcp/i);
    expect(fake.promptCalls()).toHaveLength(0);
  });

  // ONE server hosts every session of a client, and its MCP config is fixed at
  // spawn. A second session with a different cwd would silently ride the first
  // one's `-p`, which is the wrong-tree failure the `-p` exists to prevent.
  test("refuses a second session whose registry differs from the launched one", async () => {
    const fake = fakeSdk();
    fake.setMcpStatus({ codegraph: { status: "connected" } });
    const client = rig(fake, { readMcpConfig: async () => CLAUDE_MCP_JSON });

    await client.createSession(MCP_INPUT);
    await expect(
      client.createSession({ ...MCP_INPUT, cwd: "/tmp/other-worktree" }),
    ).rejects.toThrow(/server/i);
  });
});

// ---------------------------------------------------------------------------
// #141 §E: the readback, at the client. claude-code declares its isolation
// with `--strict-mcp-config`; this route VERIFIES it, which is strictly
// stronger. Every mismatch aborts the attempt before the model is prompted.
// ---------------------------------------------------------------------------
describe("createOpenCodeClient MCP readback (#141)", () => {
  test("verifies the connected set before the model is prompted", async () => {
    const fake = fakeSdk();
    fake.setMcpStatus({ codegraph: { status: "connected" } });
    const client = rig(fake, { readMcpConfig: async () => CLAUDE_MCP_JSON });

    await client.createSession(MCP_INPUT);

    expect(fake.mcpStatusCalls()).toEqual([{ directory: "/tmp/work" }]);
  });

  // Measured (#141 fact 7): `--pure` suppresses neither config-delivered nor
  // config-FILE MCP servers, so a server that ever saw the operator's real
  // HOME connects whatever ~/.config/opencode/opencode.jsonc names.
  test("an undeclared server aborts before any prompt is sent", async () => {
    const fake = fakeSdk();
    fake.setMcpStatus({
      codegraph: { status: "connected" },
      "operator-thing": { status: "connected" },
    });
    const client = rig(fake, { readMcpConfig: async () => CLAUDE_MCP_JSON });

    await expect(client.createSession(MCP_INPUT)).rejects.toThrow(
      /operator-thing/,
    );
    expect(fake.promptCalls()).toHaveLength(0);
  });

  test("a declared server that never connected aborts before any prompt", async () => {
    const fake = fakeSdk();
    fake.setMcpStatus({});
    const client = rig(fake, { readMcpConfig: async () => CLAUDE_MCP_JSON });

    await expect(client.createSession(MCP_INPUT)).rejects.toThrow(/codegraph/);
    expect(fake.promptCalls()).toHaveLength(0);
  });

  test("a declared server in any non-connected state aborts before any prompt", async () => {
    const fake = fakeSdk();
    fake.setMcpStatus({ codegraph: { status: "failed" } });
    const client = rig(fake, { readMcpConfig: async () => CLAUDE_MCP_JSON });

    await expect(client.createSession(MCP_INPUT)).rejects.toThrow(/failed/);
    expect(fake.promptCalls()).toHaveLength(0);
  });

  // The empty declaration is a declaration: "no MCP", verified. A server
  // leaking in from anywhere is the same threat whether or not pr-hero asked
  // for one of its own.
  test("an undeclared server aborts even when pr-hero delivered nothing", async () => {
    const fake = fakeSdk();
    fake.setMcpStatus({ "operator-thing": { status: "connected" } });
    const client = rig(fake, { readMcpConfig: async () => EMPTY_MCP_JSON });

    await expect(client.createSession(MCP_INPUT)).rejects.toThrow(
      /operator-thing/,
    );
    expect(fake.promptCalls()).toHaveLength(0);
  });
});

describe("Work Unit 2: Client Reconciliation & Canonical Ownership (U2-C2, U2-C3, U2-C4)", () => {
  describe("U2-C2: Canonical Message Ownership & Session Boundary", () => {
    test("unowned assistant message is rejected even when currentUserId was absent", () => {
      const state = createTurnState("ses_1", undefined, "/tmp/work");
      const unownedMessage = {
        ...ASSISTANT,
        id: "msg_unowned_assistant",
        sessionID: "ses_1",
        parentID: "msg_unknown_user",
        finish: "stop",
        time: { created: 100, completed: 200 },
      };

      expect(isMessageOwned(unownedMessage.id, state)).toBe(false);

      const proof = terminalProofFromAssistant(unownedMessage, state);
      expect(proof).toBeUndefined();

      const reconciled = reconcileMessages([unownedMessage], state);
      expect(reconciled.terminalProof).toBeUndefined();
    });

    test("cross-session message is rejected by terminal proof and reconciliation", () => {
      const state = createTurnState("ses_canonical", "msg_user_1", "/tmp/work");
      state.parentLinks.set("msg_asst_1", "msg_user_1");
      const crossSessionMessage = {
        ...ASSISTANT,
        id: "msg_asst_1",
        sessionID: "ses_other_foreign",
        parentID: "msg_user_1",
        finish: "stop",
        time: { created: 100, completed: 200 },
      };

      const proof = terminalProofFromAssistant(crossSessionMessage, state);
      expect(proof).toBeUndefined();

      const reconciled = reconcileMessages([crossSessionMessage], state);
      expect(reconciled.terminalProof).toBeUndefined();
    });
  });

  describe("U2-C3: Canonical Readback Part Order & Terminal-Only Aggregation", () => {
    test("readback parts replace stale delta order", () => {
      const state = createTurnState("ses_1", "msg_user_1", "/tmp/work");
      state.messageDetails.set("msg_asst_1", {
        id: "msg_asst_1",
        role: "assistant",
        parentID: "msg_user_1",
        partIds: ["prt_stale_2", "prt_stale_1"],
      });

      const messageWithCanonicalParts = {
        id: "msg_asst_1",
        role: "assistant",
        path: { cwd: "/tmp/work" },
        sessionID: "ses_1",
        parentID: "msg_user_1",
        finish: "stop",
        time: { created: 100, completed: 200 },
        parts: [
          {
            id: "prt_stale_1",
            sessionID: "ses_1",
            messageID: "msg_asst_1",
            type: "text",
            text: "First part ",
          },
          {
            id: "prt_stale_2",
            sessionID: "ses_1",
            messageID: "msg_asst_1",
            type: "text",
            text: "Second part",
          },
        ],
      };

      reconcileMessages([messageWithCanonicalParts], state);
      const detail = state.messageDetails.get("msg_asst_1");
      expect(detail?.partIds).toEqual(["prt_stale_1", "prt_stale_2"]);
    });

    test("canonicalFinalText aggregates only the terminal completed assistant message, excluding previous steps", () => {
      const state = createTurnState("ses_1", "msg_user_1", "/tmp/work");
      const step1 = {
        id: "msg_asst_step1",
        role: "assistant",
        path: { cwd: "/tmp/work" },
        sessionID: "ses_1",
        parentID: "msg_user_1",
        finish: "stop",
        time: { created: 100, completed: 150 },
        parts: [
          {
            id: "prt_step1",
            sessionID: "ses_1",
            messageID: "msg_asst_step1",
            type: "text",
            text: "Previous step reasoning prose. ",
          },
        ],
      };
      const step2 = {
        id: "msg_asst_step2",
        role: "assistant",
        path: { cwd: "/tmp/work" },
        sessionID: "ses_1",
        parentID: "msg_user_1",
        finish: "stop",
        time: { created: 160, completed: 200 },
        parts: [
          {
            id: "prt_step2",
            sessionID: "ses_1",
            messageID: "msg_asst_step2",
            type: "text",
            text: "Final answer only.",
          },
        ],
      };

      const reconciled = reconcileMessages([step1, step2], state);
      expect(reconciled.finalText).toBe("Final answer only.");
    });
  });

  describe("U2-C4: Explicit Bounds Across All Part Types & 4 MiB Readback Cap", () => {
    test("exhausting part limits triggers integrity failure instead of silent eviction", () => {
      const state = createTurnState("ses_1", "msg_user_1", "/tmp/work");
      for (let i = 0; i < 4096; i += 1) {
        state.trackedPartOwners.set(`prt_prior_${i}`, "msg_asst_1");
      }

      const messageWithOverLimitPart = {
        id: "msg_asst_1",
        role: "assistant",
        path: { cwd: "/tmp/work" },
        sessionID: "ses_1",
        parentID: "msg_user_1",
        finish: "stop",
        time: { created: 100, completed: 200 },
        parts: [
          {
            id: "prt_excess",
            sessionID: "ses_1",
            messageID: "msg_asst_1",
            type: "reasoning",
            text: "excess reasoning",
          },
        ],
      };

      const reconciled = reconcileMessages([messageWithOverLimitPart], state);
      expect(reconciled.failure).toBe(
        "[pr-hero] opencode client: maximum tracked parts exceeded",
      );
      expect(state.integrityFailure).toBe(
        "[pr-hero] opencode client: maximum tracked parts exceeded",
      );
      expect(state.trackedPartOwners.has("prt_prior_0")).toBe(true);
    });

    test("exceeding 4 MiB readback text cap triggers integrity failure", () => {
      const state = createTurnState("ses_1", "msg_user_1", "/tmp/work");
      const largeText = "x".repeat(4 * 1024 * 1024 + 16);
      const oversizedMessage = {
        id: "msg_asst_1",
        role: "assistant",
        path: { cwd: "/tmp/work" },
        sessionID: "ses_1",
        parentID: "msg_user_1",
        finish: "stop",
        time: { created: 100, completed: 200 },
        parts: [{ id: "prt_large", type: "text", text: largeText }],
      };

      const reconciled = reconcileMessages([oversizedMessage], state);
      expect(reconciled.failure).toBe(
        "[pr-hero] opencode client: total readback byte budget exceeded",
      );
      expect(state.integrityFailure).toBe(
        "[pr-hero] opencode client: total readback byte budget exceeded",
      );
    });
  });
});

// #223: session.prompt() resolves with the finished message and reconciles it
// purely to ingest identity/usage/error state — the event stream is the only
// delivery channel, so that reconcile must never advance `emittedText` (the
// "already delivered to the consumer" bookkeeping `handlePartDelta` and
// `handlePartUpdated` both trust). These tests drive `reconcileMessages` and
// `mapOpenCodeEvents` directly, in hand-picked order, so the ordering between
// a prompt-result reconcile and the part's own stream lifecycle is exact and
// never a timing race.
describe("Prompt-result reconcile must not advance emission ahead of the stream (#223)", () => {
  const SESS = "ses_promptrace";
  const FULL_TEXT = "the answer is 42";
  const DELTA_CHUNKS = ["the ", "answer ", "is ", "42"];

  function completedAssistant(): Record<string, unknown> {
    return {
      id: "msg_asst_1",
      sessionID: SESS,
      role: "assistant",
      path: { cwd: "/tmp/work", root: "/" },
      parentID: "msg_user_1",
      finish: "stop",
      time: { created: 100, completed: 200 },
    };
  }

  function promptResultRecord(): Record<string, unknown> {
    return {
      info: completedAssistant(),
      parts: [
        {
          id: "prt_ans_1",
          messageID: "msg_asst_1",
          sessionID: SESS,
          type: "text",
          text: FULL_TEXT,
        },
      ],
    };
  }

  test("cache and reasoning tokens ride the emitted usage event beside input and output", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    const info = {
      ...completedAssistant(),
      tokens: {
        input: 2,
        output: 3,
        reasoning: 1,
        cache: { read: 50, write: 4 },
      },
    };

    const events = mapOpenCodeEvents(
      { type: "message.updated", properties: { sessionID: SESS, info } },
      SESS,
      state,
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "usage",
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 50,
        cacheWriteTokens: 4,
        reasoningTokens: 1,
      }),
    );
  });

  test("emit:false ingests identity, usage and the text snapshot without advancing emittedText", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");

    const reconciled = reconcileMessages([promptResultRecord()], state, {
      emit: false,
    });

    // Ingestion still happened: ownership, the terminal proof and the
    // computed finalText are all present.
    expect(reconciled.terminalProof?.eventId).toBe("msg_asst_1");
    expect(reconciled.finalText).toBe(FULL_TEXT);
    expect(state.messageDetails.get("msg_asst_1")?.finish).toBe("stop");
    // But the bookkeeping a later stream event checks against was left
    // untouched — no delta was ever handed to a consumer.
    expect(state.partDetails.get("prt_ans_1")?.text).toBe(FULL_TEXT);
    expect(state.partDetails.get("prt_ans_1")?.emittedText).toBe("");
    expect(reconciled.events).toEqual([]);
  });

  test("fixed (emit:false) call site: the same replayed lifecycle delivers the answer exactly once", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");

    reconcileMessages([promptResultRecord()], state, { emit: false });
    expect(state.partDetails.get("prt_ans_1")?.emittedText).toBe("");

    const collected: unknown[] = [];
    collected.push(
      ...mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: {
            sessionID: SESS,
            part: {
              id: "prt_ans_1",
              messageID: "msg_asst_1",
              sessionID: SESS,
              type: "text",
              text: "",
            },
          },
        },
        SESS,
        state,
      ),
    );
    for (const chunk of DELTA_CHUNKS) {
      collected.push(
        ...mapOpenCodeEvents(
          {
            type: "message.part.delta",
            properties: {
              sessionID: SESS,
              messageID: "msg_asst_1",
              partID: "prt_ans_1",
              field: "text",
              delta: chunk,
            },
          },
          SESS,
          state,
        ),
      );
    }
    // No throw: the final snapshot exactly matches what the deltas already
    // built up, so it is recognized as already-delivered and produces no
    // further event.
    collected.push(
      ...mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: {
            sessionID: SESS,
            part: {
              id: "prt_ans_1",
              messageID: "msg_asst_1",
              sessionID: SESS,
              type: "text",
              text: FULL_TEXT,
            },
          },
        },
        SESS,
        state,
      ),
    );

    expect(collected).toEqual(
      DELTA_CHUNKS.map((text) => ({ kind: "delta", text })),
    );
    expect(state.partDetails.get("prt_ans_1")?.emittedText).toBe(FULL_TEXT);
  });

  // Regression (a): the normal ordering, where the part's deltas and its
  // final snapshot have ALREADY arrived and been fully emitted over the
  // stream by the time the prompt-result reconcile runs. It must be a no-op
  // regardless of `emit`, because `alreadyEmitted === snapshotText` short-
  // circuits before either branch that could advance or duplicate anything.
  test("regression (a): a late prompt-result reconcile after the stream already delivered the text is a no-op", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    // currentUserId/expectedCwd only matter for ownership on the assistant
    // message itself, which the prompt-result reconcile below establishes;
    // seed the part as already fully streamed BEFORE that happens.
    state.parts.set("prt_ans_1", "answer");
    state.partDetails.set("prt_ans_1", {
      id: "prt_ans_1",
      messageId: "msg_asst_1",
      type: "text",
      text: FULL_TEXT,
      emittedText: FULL_TEXT,
    });

    const reconciled = reconcileMessages([promptResultRecord()], state, {
      emit: false,
    });

    expect(reconciled.finalText).toBe(FULL_TEXT);
    expect(state.partDetails.get("prt_ans_1")?.emittedText).toBe(FULL_TEXT);
    expect(state.integrityFailure).toBeUndefined();
  });

  // Regression (b): prompt_result carries the finished answer but the stream
  // never replays the text part at all (dropped, or the turn ends before it
  // does). The answer must still be delivered once, through the session.idle
  // boundary reading `detail.text` against an `emittedText` the ingest-only
  // reconcile correctly left empty.
  test("regression (b): prompt-result with no stream text events at all is delivered once at the session.idle boundary", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");

    reconcileMessages([promptResultRecord()], state, { emit: false });
    expect(state.partDetails.get("prt_ans_1")?.emittedText).toBe("");

    // The assistant's own message.updated is what establishes state.lastProof
    // — the session.idle boundary has nothing to report without it.
    const updatedEvents = mapOpenCodeEvents(
      {
        type: "message.updated",
        properties: { sessionID: SESS, info: completedAssistant() },
      },
      SESS,
      state,
    );
    expect(updatedEvents).toEqual([]);

    const idleEvents = mapOpenCodeEvents(
      { type: "session.idle", properties: { sessionID: SESS } },
      SESS,
      state,
    );

    expect(idleEvents).toEqual([
      { kind: "delta", text: FULL_TEXT },
      {
        kind: "terminal",
        proof: {
          eventId: "msg_asst_1",
          providerStatus: "completed",
          providerObservedAt: new Date(200).toISOString(),
        },
      },
    ]);
  });

  // Regression (c): the real duplicate-delta contract this fix preserves —
  // the SAME event id redelivered (e.g. after an SSE `Last-Event-ID`
  // reconnect) is still deduplicated, never appended twice. Identity here is
  // the event id, not the delta's text: see the "dedupe by event id"
  // describe block below for why a text-suffix check was wrong.
  test("regression (c): a duplicate delta with the same event id is still deduplicated", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.parts.set("prt_dup_1", "answer");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");

    const first = mapOpenCodeEvents(
      {
        id: "evt_dup_1",
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg_asst_1",
          partID: "prt_dup_1",
          field: "text",
          delta: "hello ",
        },
      },
      SESS,
      state,
    );
    const duplicate = mapOpenCodeEvents(
      {
        id: "evt_dup_1",
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg_asst_1",
          partID: "prt_dup_1",
          field: "text",
          delta: "hello ",
        },
      },
      SESS,
      state,
    );

    expect(first).toEqual([{ kind: "delta", text: "hello " }]);
    expect(duplicate).toEqual([]);
    expect(state.partDetails.get("prt_dup_1")?.emittedText).toBe("hello ");
  });
});

// D-13: `handlePartDelta`'s old dedup check compared the delta's TEXT
// against the tail already emitted (`emittedText.endsWith(delta)`), which
// silently ate any legitimately repeated token — not just an exact provider
// redelivery. Identity for a redelivered event is the event's own `id`
// (OpenCode's SSE client reconnects with `Last-Event-ID` and can redeliver
// the same event verbatim — see serverSentEvents.gen.js), never its text.
describe("dedupe by event id, not text-suffix (D-13)", () => {
  const SESS = "ses_delta_id_dedupe";

  test("a. repeated tokens: every delta with a distinct id is emitted and the final snapshot matches", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.parts.set("prt_repeat_1", "answer");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");

    const deltas = [
      { id: "evt_1", delta: "a" },
      { id: "evt_2", delta: "b" },
      { id: "evt_3", delta: "b" },
      { id: "evt_4", delta: "c" },
    ];
    const collected: unknown[] = [];
    for (const { id, delta } of deltas) {
      collected.push(
        ...mapOpenCodeEvents(
          {
            id,
            type: "message.part.delta",
            properties: {
              sessionID: SESS,
              messageID: "msg_asst_1",
              partID: "prt_repeat_1",
              field: "text",
              delta,
            },
          },
          SESS,
          state,
        ),
      );
    }

    expect(collected).toEqual([
      { kind: "delta", text: "a" },
      { kind: "delta", text: "b" },
      { kind: "delta", text: "b" },
      { kind: "delta", text: "c" },
    ]);
    expect(state.partDetails.get("prt_repeat_1")?.emittedText).toBe("abbc");

    // The later snapshot restating the true text must not throw a
    // "conflicting snapshot observed" error.
    const snapshotEvents = mapOpenCodeEvents(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESS,
          part: {
            id: "prt_repeat_1",
            messageID: "msg_asst_1",
            sessionID: SESS,
            type: "text",
            text: "abbc",
          },
        },
      },
      SESS,
      state,
    );
    expect(snapshotEvents).toEqual([]);
    expect(state.integrityFailure).toBeUndefined();
  });

  test("b. repeated JSON closer: a legitimately repeated '}' delta is applied, not dropped, with no snapshot", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.parts.set("prt_json_1", "answer");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");

    const deltas = [
      { id: "evt_j1", delta: '{"a":{"b":1' },
      { id: "evt_j2", delta: "}" },
      { id: "evt_j3", delta: "}" },
    ];
    for (const { id, delta } of deltas) {
      mapOpenCodeEvents(
        {
          id,
          type: "message.part.delta",
          properties: {
            sessionID: SESS,
            messageID: "msg_asst_1",
            partID: "prt_json_1",
            field: "text",
            delta,
          },
        },
        SESS,
        state,
      );
    }

    expect(state.partDetails.get("prt_json_1")?.emittedText).toBe(
      '{"a":{"b":1}}',
    );
  });

  test("c. same-id replay: the second delivery of the same event id is dropped and text is not doubled", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.parts.set("prt_same_1", "answer");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");

    const event = {
      id: "evt_same_1",
      type: "message.part.delta",
      properties: {
        sessionID: SESS,
        messageID: "msg_asst_1",
        partID: "prt_same_1",
        field: "text",
        delta: "b",
      },
    };

    const first = mapOpenCodeEvents(event, SESS, state);
    const second = mapOpenCodeEvents(event, SESS, state);

    expect(first).toEqual([{ kind: "delta", text: "b" }]);
    expect(second).toEqual([]);
    expect(state.partDetails.get("prt_same_1")?.emittedText).toBe("b");
  });

  test("d. id-less deltas have no identity to compare, so two identical ones are both applied", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.parts.set("prt_noid_1", "answer");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");

    const event = {
      type: "message.part.delta",
      properties: {
        sessionID: SESS,
        messageID: "msg_asst_1",
        partID: "prt_noid_1",
        field: "text",
        delta: "b",
      },
    };

    const first = mapOpenCodeEvents(event, SESS, state);
    const second = mapOpenCodeEvents(event, SESS, state);

    expect(first).toEqual([{ kind: "delta", text: "b" }]);
    expect(second).toEqual([{ kind: "delta", text: "b" }]);
    expect(state.partDetails.get("prt_noid_1")?.emittedText).toBe("bb");
  });

  test("e. buffered unknown-owner delta reconciles exactly once, then drops the same id again", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");

    // Part announced with an empty snapshot before ownership is known —
    // buffered as type "part.updated".
    const announceEvents = mapOpenCodeEvents(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESS,
          part: {
            id: "prt_buf_1",
            messageID: "msg_asst_1",
            sessionID: SESS,
            type: "text",
            text: "",
          },
        },
      },
      SESS,
      state,
    );
    expect(announceEvents).toEqual([]);

    // Delta arrives before ownership is known too — buffered as
    // "part.delta", carrying its event id along.
    const deltaBeforeOwnership = mapOpenCodeEvents(
      {
        id: "evt_buf_1",
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg_asst_1",
          partID: "prt_buf_1",
          field: "text",
          delta: "hello",
        },
      },
      SESS,
      state,
    );
    expect(deltaBeforeOwnership).toEqual([]);

    // Ownership established: the buffer reconciles both observations.
    const reconciledEvents = mapOpenCodeEvents(
      {
        type: "message.updated",
        properties: {
          sessionID: SESS,
          info: {
            id: "msg_asst_1",
            role: "assistant",
            sessionID: SESS,
            path: { cwd: "/tmp/work", root: "/" },
            parentID: "msg_user_1",
          },
        },
      },
      SESS,
      state,
    );
    expect(reconciledEvents).toEqual([{ kind: "delta", text: "hello" }]);
    expect(state.partDetails.get("prt_buf_1")?.emittedText).toBe("hello");

    // The same event id arriving again after reconciliation is now a
    // genuine replay (ownership is known) and must be dropped.
    const replay = mapOpenCodeEvents(
      {
        id: "evt_buf_1",
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg_asst_1",
          partID: "prt_buf_1",
          field: "text",
          delta: "hello",
        },
      },
      SESS,
      state,
    );
    expect(replay).toEqual([]);
    expect(state.partDetails.get("prt_buf_1")?.emittedText).toBe("hello");
  });
});

// D-11: the poll observer's own readback (opencode-client.ts pollStatus,
// `reconcileMessages(list, state.turn)`) reconciles with the DEFAULT `emit`
// (true) — unlike the #223 prompt_result call site above, which was fixed to
// `{ emit: false }` for exactly the same reason. The poll site discards
// `reconciled.events` the same way the prompt_result call site used to
// (opencode-sdk.ts's poll branch reads only `failure`/`terminalProof`/
// `finalText`/`usage`/`usageIncomplete`), so the same hazard applies: if the
// stream has already delivered a PREFIX of a text part when the poll's HTTP
// readback observes the part's already-persisted FULL text, the poll's
// reconcile advances `emittedText` to the full text for a consumer that was
// only ever handed the prefix. The stream's own still-in-flight remaining
// deltas for that part then find `emittedText` already past what was really
// delivered: `handlePartDelta`'s then text-suffix dedup check
// (`emittedText.endsWith(delta)`, since replaced by event-id dedupe — D-13)
// does not recognise them as already-covered, so they are appended AGAIN as
// duplicate delta events (corrupting delivery), and the part's own later
// snapshot/session.idle boundary event finds `snapshotText` shorter than the
// now-inflated `emittedText` and throws "conflicting snapshot observed" —
// exactly the failure #223 fixed at the other call site, reopened at this one.
//
// These tests drive `reconcileMessages` (the exact call the poll site makes)
// and `mapOpenCodeEvents` (the exact call the stream pump makes) directly, in
// the ordering a live race would produce, so it is exact and never a timing
// race.
describe("Poll-readback reconcile must not advance emission ahead of the stream (D-11)", () => {
  const SESS = "ses_pollrace";
  const FULL_TEXT = "the answer is 42";
  const DELTA_CHUNKS = ["the ", "answer ", "is ", "42"];

  function completedAssistant(): Record<string, unknown> {
    return {
      id: "msg_asst_1",
      sessionID: SESS,
      role: "assistant",
      path: { cwd: "/tmp/work", root: "/" },
      parentID: "msg_user_1",
      finish: "stop",
      time: { created: 100, completed: 200 },
    };
  }

  function pollReadbackRecord(): Record<string, unknown> {
    return {
      info: completedAssistant(),
      parts: [
        {
          id: "prt_ans_1",
          messageID: "msg_asst_1",
          sessionID: SESS,
          type: "text",
          text: FULL_TEXT,
        },
      ],
    };
  }

  // Mechanism validation for the fix: the exact same race, but with the poll
  // readback reconciled through `{ emit: false }` — what the fixed pollStatus
  // call site will pass. `events` is still discarded by the caller (mirroring
  // the real poll site, which never reads them), but `emittedText` must be
  // left untouched so the stream's own remaining, perfectly ordinary delivery
  // completes exactly once with no duplication and no thrown conflict.
  test("fixed (emit:false) poll readback: the same race delivers the answer exactly once", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");

    mapOpenCodeEvents(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESS,
          part: {
            id: "prt_ans_1",
            messageID: "msg_asst_1",
            sessionID: SESS,
            type: "text",
            text: "",
          },
        },
      },
      SESS,
      state,
    );
    const firstDeltaEvents = mapOpenCodeEvents(
      {
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg_asst_1",
          partID: "prt_ans_1",
          field: "text",
          delta: DELTA_CHUNKS[0],
        },
      },
      SESS,
      state,
    );
    expect(firstDeltaEvents).toEqual([
      { kind: "delta", text: DELTA_CHUNKS[0] },
    ]);

    const reconciled = reconcileMessages([pollReadbackRecord()], state, {
      emit: false,
    });
    expect(reconciled.terminalProof?.eventId).toBe("msg_asst_1");
    expect(reconciled.finalText).toBe(FULL_TEXT);
    // The fix: emittedText stays exactly what the stream actually delivered.
    expect(state.partDetails.get("prt_ans_1")?.emittedText).toBe(
      DELTA_CHUNKS[0],
    );

    const collected: unknown[] = [];
    for (const chunk of DELTA_CHUNKS.slice(1)) {
      collected.push(
        ...mapOpenCodeEvents(
          {
            type: "message.part.delta",
            properties: {
              sessionID: SESS,
              messageID: "msg_asst_1",
              partID: "prt_ans_1",
              field: "text",
              delta: chunk,
            },
          },
          SESS,
          state,
        ),
      );
    }
    // The final restating snapshot must be recognised as already delivered —
    // no throw, no further event.
    const snapshotEvents = mapOpenCodeEvents(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESS,
          part: {
            id: "prt_ans_1",
            messageID: "msg_asst_1",
            sessionID: SESS,
            type: "text",
            text: FULL_TEXT,
          },
        },
      },
      SESS,
      state,
    );

    expect(collected).toEqual(
      DELTA_CHUNKS.slice(1).map((text) => ({ kind: "delta", text })),
    );
    expect(snapshotEvents).toEqual([]);
    expect(state.partDetails.get("prt_ans_1")?.emittedText).toBe(FULL_TEXT);
    expect(state.integrityFailure).toBeUndefined();
  });
});

// #227 threaded the provider event id through `handlePartDelta`, giving
// reasoning deltas replay identity they lacked when f842a8b restricted useful
// progress to owned cumulative SNAPSHOTS only ("bare delta markers have no
// replay identity and cannot extend the deadline"). A delta carrying a NOVEL
// id is no longer a bare marker — replaying the SAME id (an SSE
// Last-Event-ID reconnect) is still not new work, and an id-less delta still
// has no identity to prove novelty with, so both keep emitting the old bare
// marker. Tool execution time counted as silence for a separate reason: this
// same file's `handlePartUpdated` tool branch emitted NOTHING at all for a
// tool part update, novel status transition or not. Both gaps fed the false
// "quiet-round budget" tripwire on reasoning-heavy or tool-heavy turns a real
// GLM/OpenAI stream produces.
describe("useful-progress credit for novel reasoning deltas and tool transitions", () => {
  const SESS = "ses_progress_credit";

  function ownReasoningPart(state: ReturnType<typeof createTurnState>) {
    state.parts.set("prt_r1", "reasoning");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");
  }

  test("a reasoning delta with a novel provider event id counts as progress", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    ownReasoningPart(state);

    const events = mapOpenCodeEvents(
      {
        id: "evt_reasoning_novel",
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg_asst_1",
          partID: "prt_r1",
          field: "text",
          delta: "thinking about it",
        },
      },
      SESS,
      state,
    );

    expect(events).toEqual([{ kind: "reasoning", progress: true }]);
  });

  test("the same reasoning delta id replayed does not count twice", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    ownReasoningPart(state);
    const send = () =>
      mapOpenCodeEvents(
        {
          id: "evt_reasoning_replay",
          type: "message.part.delta",
          properties: {
            sessionID: SESS,
            messageID: "msg_asst_1",
            partID: "prt_r1",
            field: "text",
            delta: "thinking about it",
          },
        },
        SESS,
        state,
      );

    expect(send()).toEqual([{ kind: "reasoning", progress: true }]);
    expect(send()).toEqual([{ kind: "reasoning" }]);
  });

  test("an id-less reasoning delta never counts as progress", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    ownReasoningPart(state);

    const events = mapOpenCodeEvents(
      {
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg_asst_1",
          partID: "prt_r1",
          field: "text",
          delta: "thinking about it",
        },
      },
      SESS,
      state,
    );

    expect(events).toEqual([{ kind: "reasoning" }]);
  });

  test("a reasoning delta for an unowned message emits nothing, novel id or not", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.parts.set("prt_r_foreign", "reasoning");
    state.assistantMessages.add("msg_foreign");
    state.parentLinks.set("msg_foreign", "someone_elses_prompt");

    const events = mapOpenCodeEvents(
      {
        id: "evt_reasoning_foreign",
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg_foreign",
          partID: "prt_r_foreign",
          field: "text",
          delta: "thinking about it",
        },
      },
      SESS,
      state,
    );

    expect(events).toEqual([]);
  });

  test("an owned tool part's novel status transition emits activity once; the same status again emits nothing", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");
    const toolStatus = (status: string) =>
      mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: {
            sessionID: SESS,
            part: {
              id: "prt_tool_1",
              messageID: "msg_asst_1",
              sessionID: SESS,
              type: "tool",
              callID: "call_1",
              state: { status },
            },
          },
        },
        SESS,
        state,
      );

    expect(toolStatus("pending")).toEqual([{ kind: "activity" }]);
    expect(toolStatus("pending")).toEqual([]);
    expect(toolStatus("running")).toEqual([{ kind: "activity" }]);
    expect(toolStatus("running")).toEqual([]);
    // #214: a novel transition INTO "completed" also stamps a look, off the
    // same `transitioned` gate as "activity" — see the WHY comment at the
    // "tool" branch in `handlePartUpdated`. `tool` reads "unknown" because
    // this fixture's part carries no `tool` field.
    expect(toolStatus("completed")).toEqual([
      { kind: "activity" },
      { kind: "tool", tool: "unknown", callId: "call_1" },
    ]);
  });

  // An SSE `Last-Event-ID` reconnect can re-deliver an OLDER status after a
  // newer one already landed (e.g. "running" replayed after "completed" was
  // already observed). `previousStatus !== status` credits that as a
  // transition — it IS a change from what was last stored, but it is not
  // FORWARD progress, so it must not earn `activity`. Rank: pending=0,
  // running=1, completed=2, error=2 (a terminal either way, so neither
  // outranks the other) — only a strictly increasing rank counts, and a
  // first observation always counts (previous rank is -1).
  test("a replayed older tool status after a newer one already landed emits nothing", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");
    const toolStatus = (status: string) =>
      mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: {
            sessionID: SESS,
            part: {
              id: "prt_tool_replay",
              messageID: "msg_asst_1",
              sessionID: SESS,
              type: "tool",
              callID: "call_replay",
              state: { status },
            },
          },
        },
        SESS,
        state,
      );

    // #214: see the WHY comment above — a novel transition into "completed"
    // also stamps a look.
    expect(toolStatus("completed")).toEqual([
      { kind: "activity" },
      { kind: "tool", tool: "unknown", callId: "call_replay" },
    ]);
    expect(toolStatus("running")).toEqual([]);
  });

  test("pending -> running -> completed emits exactly 3 activities", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");
    const toolStatus = (status: string) =>
      mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: {
            sessionID: SESS,
            part: {
              id: "prt_tool_forward",
              messageID: "msg_asst_1",
              sessionID: SESS,
              type: "tool",
              callID: "call_forward",
              state: { status },
            },
          },
        },
        SESS,
        state,
      );

    expect(toolStatus("pending")).toEqual([{ kind: "activity" }]);
    expect(toolStatus("running")).toEqual([{ kind: "activity" }]);
    // #214: see the WHY comment above — a novel transition into "completed"
    // also stamps a look.
    expect(toolStatus("completed")).toEqual([
      { kind: "activity" },
      { kind: "tool", tool: "unknown", callId: "call_forward" },
    ]);
  });

  test("completed -> error emits nothing: both are terminal, equal rank", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");
    const toolStatus = (status: string) =>
      mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: {
            sessionID: SESS,
            part: {
              id: "prt_tool_terminal",
              messageID: "msg_asst_1",
              sessionID: SESS,
              type: "tool",
              callID: "call_terminal",
              state: { status },
            },
          },
        },
        SESS,
        state,
      );

    // #214: see the WHY comment above — a novel transition into "completed"
    // also stamps a look.
    expect(toolStatus("completed")).toEqual([
      { kind: "activity" },
      { kind: "tool", tool: "unknown", callId: "call_terminal" },
    ]);
    expect(toolStatus("error")).toEqual([]);
  });

  // pr-hero review F001 (round 2, opencode-client.ts:809): the reverse order
  // of the test above. "error" then "completed" share TOOL_STATUS_RANK, so
  // the "completed" observation is NOT a forward transition and must not
  // stamp a SECOND "activity" — but it IS the first time this callID is
  // observed "completed", so the tool tally must still fire, keyed by set
  // membership rather than by rank.
  test("error -> completed emits the tool event but not a second activity (set membership, not rank)", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    state.assistantMessages.add("msg_asst_1");
    state.parentLinks.set("msg_asst_1", "msg_user_1");
    const toolStatus = (status: string) =>
      mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: {
            sessionID: SESS,
            part: {
              id: "prt_tool_error_then_ok",
              messageID: "msg_asst_1",
              sessionID: SESS,
              type: "tool",
              callID: "call_error_then_ok",
              state: { status },
            },
          },
        },
        SESS,
        state,
      );

    // error is the FIRST observation for this callID: rank -1 -> 2 IS a
    // forward transition, so it earns its own "activity" credit.
    expect(toolStatus("error")).toEqual([{ kind: "activity" }]);
    // completed shares error's rank, so no second "activity" — but the tool
    // tally is decoupled from rank and fires on its own first sighting.
    expect(toolStatus("completed")).toEqual([
      { kind: "tool", tool: "unknown", callId: "call_error_then_ok" },
    ]);
    expect(state.completedToolCallIds.has("call_error_then_ok")).toBe(true);
    // A further restatement of "completed" is neither a transition nor a
    // novel set member — nothing fires.
    expect(toolStatus("completed")).toEqual([]);
  });

  // #228's review: `reconcileMessages` (the ~250ms poll readback, `emit:
  // false`) ALSO writes `state.toolStates.set(callId, status)`
  // unconditionally, and three concurrent hunters sharing one server can
  // have a poll round observe a tool's "completed" status before the stream
  // ever delivers that same tool's "pending"/"running". If activity credit
  // were computed against `toolStates`, the stream's later real transitions
  // would compare against the rank the POLL already advanced to
  // "completed" and never earn credit.
  test("tool activity credit is computed independently of the poll reconcile's toolStates writes", () => {
    const state = createTurnState(SESS, "msg_user_1", "/tmp/work");
    const pollReadbackObservesCompletedFirst = {
      id: "msg_asst_1",
      role: "assistant",
      path: { cwd: "/tmp/work" },
      sessionID: SESS,
      parentID: "msg_user_1",
      parts: [
        {
          id: "prt_tool_poll_race",
          sessionID: SESS,
          messageID: "msg_asst_1",
          type: "tool",
          callID: "call_poll_race",
          state: { status: "completed" },
        },
      ],
    };
    reconcileMessages([pollReadbackObservesCompletedFirst], state, {
      emit: false,
    });
    // toolStates is exactly as unconditional as before this commit.
    expect(state.toolStates.get("call_poll_race")).toBe("completed");
    // pr-hero review F001/F002: the poll's own observation already recorded
    // this callID in the monotonic set.
    expect(state.completedToolCallIds.has("call_poll_race")).toBe(true);

    const toolStatus = (status: string) =>
      mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: {
            sessionID: SESS,
            part: {
              id: "prt_tool_poll_race",
              messageID: "msg_asst_1",
              sessionID: SESS,
              type: "tool",
              callID: "call_poll_race",
              state: { status },
            },
          },
        },
        SESS,
        state,
      );

    // The stream's OWN pending -> running -> completed still earns credit
    // for every forward step, unaffected by the poll having already stored
    // "completed" in toolStates.
    expect(toolStatus("pending")).toEqual([{ kind: "activity" }]);
    expect(toolStatus("running")).toEqual([{ kind: "activity" }]);
    // #214: "activity" is read off `toolActivityRank`, never `toolStates` —
    // the stream's own arrival at "completed" still stamps a look even
    // though the poll raced ahead and marked it complete in `toolStates`
    // already. The TALLY (pr-hero review F001 round 3) is the SAME story,
    // for the SAME reason: it is deduped against `streamCompletedToolCallIds`
    // — STREAM-OWNED, never the shared `completedToolCallIds` the poll
    // reconcile above already wrote. If this emission were deduped against
    // the shared set instead (round 2's shape), the poll's earlier
    // observation would suppress the stream's own `{kind:"tool"}` here —
    // and if the STREAM, not the poll, goes on to win the turn's terminal,
    // the transport's union would never learn of this callID from ANY
    // channel. So the stream still emits its own "tool" event even though
    // the shared set already has this callID.
    expect(toolStatus("completed")).toEqual([
      { kind: "activity" },
      { kind: "tool", tool: "unknown", callId: "call_poll_race" },
    ]);
    // The SHARED set still stays a union of one, not two: the poll's own
    // earlier write and the stream's later one are the same identity
    // (F002's "same call counts once" at the client layer) — this is a
    // reporting fact for `pollStatus`, independent of the stream's own
    // emission dedupe above.
    expect(state.completedToolCallIds.size).toBe(1);
  });
});
