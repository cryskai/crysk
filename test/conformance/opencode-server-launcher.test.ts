import { describe, expect, test } from "bun:test";
import type { CredentialKind } from "../../src/execution/contracts";
import {
  ACTIVE_SERVER_CLOSERS,
  closeAllServers,
} from "../../src/execution/spawned-process";
import type { CredentialBroker } from "../../src/security/credential-broker";
import {
  composeOpenCodeServerEnv,
  launchOpenCodeServer,
  launchProjectedOpenCodeServer,
} from "../../src/transports/opencode-server";

const BIN = "/opt/homebrew/bin/opencode";
const PID = 515151;

interface FakeServer {
  spawnFn: typeof Bun.spawn;
  argv: () => string[];
  env: () => Record<string, string> | undefined;
  emit: (line: string) => void;
  killFn: (pid: number, signal?: string | number) => void;
  stdoutPulls: () => number;
  stderrRead: () => boolean;
  signals: () => Array<string | number | undefined>;
  finish: (code: number) => void;
}

function fakeServer(options: { pid?: number } = {}): FakeServer {
  let argv: string[] = [];
  let env: Record<string, string> | undefined;
  let push!: (chunk: string) => void;
  let closeOut!: () => void;
  const signals: Array<string | number | undefined> = [];
  let releaseExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    releaseExit = resolve;
  });
  const encoder = new TextEncoder();

  let stderrRead = false;
  // `pull` fires only when a consumer is actually taking chunks. If the
  // reader returned after startup, this counter stops moving — which is
  // exactly the defect under test.
  let pulls = 0;
  const stdout = new ReadableStream<Uint8Array>({
    pull() {
      pulls += 1;
    },
    start(controller) {
      push = (chunk) => controller.enqueue(encoder.encode(chunk));
      closeOut = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
    },
  });

  const spawnFn = ((cmd: string[], opts?: { env?: Record<string, string> }) => {
    argv = cmd;
    env = opts?.env;
    return {
      pid: options.pid ?? PID,
      stdout,
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          stderrRead = true;
          c.close();
        },
      }),
      exited,
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  return {
    spawnFn,
    killFn: (_pid: number, signal?: string | number) => {
      signals.push(signal);
    },
    argv: () => argv,
    env: () => env,
    stdoutPulls: () => pulls,
    stderrRead: () => stderrRead,
    emit: (line) => push(line),
    signals: () => signals,
    finish: (code) => {
      closeOut();
      releaseExit(code);
    },
  };
}

const LISTENING = "opencode server listening on http://127.0.0.1:51234\n";

describe("launchOpenCodeServer", () => {
  test("resolves the URL the server prints, not a guessed one", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: { HOME: "/tmp/proj" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    expect(server.url).toBe("http://127.0.0.1:51234");
    fake.finish(0);
    await server.close();
  });

  // The SDK's own createOpencodeServer defaults to port 4096, a FIXED port —
  // two concurrent reviews would collide on it. An ephemeral port plus reading
  // back the real URL is the only shape that survives parallel hunters.
  test("always asks for an ephemeral port", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    const argv = fake.argv();
    expect(argv[0]).toBe(BIN);
    expect(argv).toContain("serve");
    const portIndex = argv.indexOf("--port");
    expect(portIndex).toBeGreaterThan(0);
    expect(argv[portIndex + 1]).toBe("0");
    fake.finish(0);
    await server.close();
  });

  // --pure runs the server without external plugins. Two reasons, and the
  // second is the one that matters: it drops the plugin.added flood the probe
  // recorded (45 of 71 events), AND it keeps third-party plugin code out of a
  // process that holds a projected credential (§6 threat model).
  test("runs without external plugins", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    expect(fake.argv()).toContain("--pure");
    fake.finish(0);
    await server.close();
  });

  // THE isolation test. The SDK's helper does
  // `launch("opencode", args, {env: {...process.env, …}})` — inheriting the
  // operator's whole environment, which would hand the child the operator's
  // real HOME and walk straight past the §6.1 credential projection.
  test("passes EXACTLY the projected environment, never process.env", async () => {
    const fake = fakeServer();
    const projected = {
      HOME: "/tmp/projection",
      XDG_DATA_HOME: "/tmp/projection/.local/share",
    };
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: projected,
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    // #157: OPENCODE_CONFIG_CONTENT is now delivered unconditionally (the
    // permission-deny config below), so "exactly the projected environment"
    // means the projection plus that one documented addition — never a merge
    // of process.env, which is what this test actually guards.
    expect(fake.env()).toEqual({
      ...projected,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { external_directory: "deny" },
      }),
    });
    fake.finish(0);
    await server.close();
  });

  // #141 §D: MCP arrives in the child's ENVIRONMENT at spawn, so the servers
  // are connected from the server's first byte. Nothing is added to a running
  // server after the fact, which is what leaves no window between "server up"
  // and "MCP connected" — the #128 race class.
  test("carries the MCP registry in OPENCODE_CONFIG_CONTENT at spawn", async () => {
    const fake = fakeServer();
    const projected = { HOME: "/tmp/projection" };
    const mcp = {
      codegraph: {
        type: "local" as const,
        command: ["/opt/homebrew/bin/codegraph", "serve", "--mcp", "-p", "/w"],
        enabled: true as const,
      },
    };
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: projected,
      mcp,
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;

    const env = fake.env();
    // #157: permission-deny now rides alongside mcp in the same delivered
    // config.
    expect(env?.OPENCODE_CONFIG_CONTENT).toBe(
      JSON.stringify({
        mcp,
        permission: { external_directory: "deny" },
      }),
    );
    // The projection is still passed through in full; the config is the ONE
    // documented addition, never a merge of process.env.
    expect(env?.HOME).toBe("/tmp/projection");
    expect(Object.keys(env ?? {}).sort()).toEqual([
      "HOME",
      "OPENCODE_CONFIG_CONTENT",
    ]);
    fake.finish(0);
    await server.close();
  });

  // Parity with claude-code on a repo with no codegraph index: pr-hero writes
  // {"mcpServers":{}} and the hunters run on read/grep/glob. An empty `mcp`
  // object delivered as config would be a claim about the child's tool
  // channels that pr-hero is not making — so `mcp` itself is still omitted
  // here. #157: the permission-deny config is NOT gated on `mcp` the same
  // way, since it is a threat-model floor rather than a claim about tool
  // channels, so it still ships even with nothing to say about MCP.
  test("delivers only the permission-deny config when there is no MCP to deliver", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: { HOME: "/tmp/projection" },
      mcp: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    expect(fake.env()).toEqual({
      HOME: "/tmp/projection",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { external_directory: "deny" },
      }),
    });
    fake.finish(0);
    await server.close();
  });

  // #157 (pr-157-8df2fca3-6): a hunter's tool call for a path OUTSIDE the
  // reviewed worktree tripped `permission.asked` for `external_directory`
  // twice in one run (resilience at 168.9s, reliability at 374.0s), and since
  // pr-hero never answered OpenCode's permission prompt the tool call sat
  // blocked until the silence tripwire killed the attempt 150s later at $0.
  // Failing closed AT THE SOURCE means the provider itself refuses the
  // read/write instead of asking and waiting forever — this tightens the §13
  // isolation threat model (CLAUDE.md rule 4), it does not loosen it.
  test("denies external_directory access in the delivered config, with or without an MCP registry", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: { HOME: "/tmp/projection" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    const config = JSON.parse(fake.env()?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      permission?: { external_directory?: string };
    };
    expect(config.permission?.external_directory).toBe("deny");
    fake.finish(0);
    await server.close();
  });

  // Free-tier gateway fix (2026-09-26): opencode-client.ts's createSession
  // passes `freeTierGatewayAsk` only for a `provider_free` route, and only
  // with the ids that route's OWN spec does not grant — this module never
  // decides which ids, only how to render whatever list it is given. See
  // FREE_TIER_GATEWAY_TOOLS in opencode-client.ts for the observed 403 matrix
  // that makes this necessary, and the WHY at this function's config
  // assembly for why "ask" (not "allow", not simply omitting the key)
  // preserves isolation.
  test("marks a free-tier gateway tool 'ask' instead of denying it, alongside external_directory", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: { HOME: "/tmp/projection" },
      freeTierGatewayAsk: ["bash"],
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    expect(fake.env()).toEqual({
      HOME: "/tmp/projection",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { external_directory: "deny", bash: "ask" },
      }),
    });
    fake.finish(0);
    await server.close();
  });

  test("marks every free-tier gateway tool named 'ask', not only the first", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: { HOME: "/tmp/projection" },
      freeTierGatewayAsk: ["bash", "read"],
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    const config = JSON.parse(fake.env()?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      permission?: Record<string, string>;
    };
    expect(config.permission).toEqual({
      external_directory: "deny",
      bash: "ask",
      read: "ask",
    });
    fake.finish(0);
    await server.close();
  });

  // Pin: an empty list is indistinguishable from omitting the option
  // entirely — every non-`provider_free` route reaches this launcher with
  // `freeTierGatewayAsk` either absent or `[]`, and both must produce the
  // exact byte-identical config this file's OTHER tests already pin.
  test("an empty freeTierGatewayAsk adds no permission key beyond external_directory", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: { HOME: "/tmp/projection" },
      freeTierGatewayAsk: [],
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    expect(fake.env()).toEqual({
      HOME: "/tmp/projection",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { external_directory: "deny" },
      }),
    });
    fake.finish(0);
    await server.close();
  });

  test("a free-tier gateway ask coexists with a delivered MCP registry", async () => {
    const fake = fakeServer();
    const mcp = {
      codegraph: {
        type: "local" as const,
        command: ["/opt/homebrew/bin/codegraph", "serve", "--mcp", "-p", "/w"],
        enabled: true as const,
      },
    };
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: { HOME: "/tmp/projection" },
      mcp,
      freeTierGatewayAsk: ["bash"],
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    expect(fake.env()?.OPENCODE_CONFIG_CONTENT).toBe(
      JSON.stringify({
        mcp,
        permission: { external_directory: "deny", bash: "ask" },
      }),
    );
    fake.finish(0);
    await server.close();
  });

  test("refuses a binary path that was never resolved to an absolute one", async () => {
    const fake = fakeServer();
    await expect(
      launchOpenCodeServer({
        verifiedBinaryPath: "opencode",
        env: {},
        spawnFn: fake.spawnFn,
        killFn: fake.killFn,
      }),
    ).rejects.toThrow(/absolute/i);
    // §13: nothing may spawn before the binary is verified.
    expect(fake.argv()).toEqual([]);
  });

  test("a server that never announces itself is killed, not awaited forever", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
      startupTimeoutMs: 5,
      // Bounded on purpose. The startup timer fires `void close()` and
      // rejects immediately, so with the 2s production defaults this test
      // would return while ~4s of real timer-driven cascade kept running
      // against the shared fake, after the suite had already reported.
      termGraceMs: 5,
      killReapMs: 5,
    });
    await expect(pending).rejects.toThrow(/did not announce|timed out/i);
    // Let the fire-and-forget cascade finish INSIDE the test that started it.
    fake.finish(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.signals()).toContain("SIGTERM");
  });

  test("a server that exits during startup fails loud", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.finish(1);
    await expect(pending).rejects.toThrow(/exited/i);
  });

  // The line arrives split across chunks in practice; a parser that only
  // inspects whole chunks drops the announcement and then times out on a
  // server that started perfectly well.
  test("the announcement is found even when it arrives in pieces", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit("opencode server li");
    fake.emit("stening on http://127.0.0.1:6");
    fake.emit("1234\n");
    const server = await pending;
    expect(server.url).toBe("http://127.0.0.1:61234");
    fake.finish(0);
    await server.close();
  });

  // pr-hero F002 on this PR. The reader returned once the URL was parsed, so
  // nothing drained proc.stdout for the rest of the child's life — and the
  // handle exposes no way to resume. A server that logs after startup fills
  // the ~64 KiB pipe buffer and BLOCKS in write(), stalling with no signal to
  // the caller. stderr was worse: piped and never read at all.
  test("both pipes keep a reader after startup", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;

    const pullsAfterStartup = fake.stdoutPulls();
    // Post-startup chatter must still be consumed, not left in the pipe.
    for (let i = 0; i < 64; i += 1) fake.emit(`request ${i} served\n`);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.stdoutPulls()).toBeGreaterThan(pullsAfterStartup);
    expect(fake.stderrRead()).toBe(true);

    fake.finish(0);
    await server.close();
  });

  test("close escalates TERM then KILL and is idempotent", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
      termGraceMs: 5,
    });
    fake.emit(LISTENING);
    const server = await pending;

    const closing = server.close();
    // The child ignores TERM; the cascade must escalate rather than hang.
    await new Promise((r) => setTimeout(r, 30));
    fake.finish(0);
    await closing;

    expect(fake.signals()).toContain("SIGTERM");
    expect(fake.signals()).toContain("SIGKILL");
    const before = fake.signals().length;
    await server.close();
    expect(fake.signals().length).toBe(before);
  });
});

// #149: the server launched with `env: {}` resolved the OPERATOR's real home
// for both config (their MCP servers) and data (their auth.json), so every
// OpenCode inference authenticated against their credential store while the
// per-attempt projection was built, never read, and destroyed. These tests
// pin the fix: the server runs under a projection whose lifetime is the
// server's, composed from an allowlist that is deliberately NOT the harness's.
describe("projected server launch (#149)", () => {
  interface FakeProjection {
    broker: CredentialBroker;
    destroys: () => number;
    projects: () => number;
  }

  const PROJECTION_ENV = {
    HOME: "/tmp/proj-home",
    TMPDIR: "/tmp/proj-home/tmp",
    XDG_DATA_HOME: "/tmp/proj-home/.local/share",
    XDG_CONFIG_HOME: "/tmp/proj-home/.config",
  } as const;

  function fakeBroker(
    options: { failWith?: Error; onDestroy?: () => void } = {},
  ): FakeProjection {
    let destroys = 0;
    let projects = 0;
    const broker: CredentialBroker = {
      project: async () => {
        projects += 1;
        if (options.failWith !== undefined) throw options.failWith;
        return {
          projectionId: "cred-fake",
          kind: "opencode_chatgpt_oauth",
          syntheticHome: PROJECTION_ENV.HOME,
          syntheticConfigHome: PROJECTION_ENV.XDG_CONFIG_HOME,
          syntheticTmp: PROJECTION_ENV.TMPDIR,
          env: { ...PROJECTION_ENV },
          files: [],
          destroy: async () => {
            destroys += 1;
            options.onDestroy?.();
          },
        };
      },
    };
    return { broker, destroys: () => destroys, projects: () => projects };
  }

  test("the spawn env is the server allowlist plus the projection, exactly", async () => {
    const fake = fakeServer();
    const proj = fakeBroker();
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      credentialKind: "opencode_chatgpt_oauth",
      baseEnv: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        // Measured live on opencode 1.18.23: an ambient provider key
        // CONNECTS that provider. Both of these are in the harness's
        // ENV_PASSTHROUGH, which is why the server cannot reuse that list —
        // composing from it would reintroduce this exact leak through the fix.
        ANTHROPIC_API_KEY: "sk-ant-must-not-reach-the-server",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-the-server",
        // The operator's real identity: pinned over by the projection.
        HOME: "/Users/operator",
        TMPDIR: "/var/folders/operator",
        // Not on any allowlist.
        EDITOR: "vim",
      },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    await pending;

    // #157: permission-deny is delivered unconditionally now, alongside the
    // allowlist-plus-projection env this test otherwise guards.
    expect(fake.env()).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      ...PROJECTION_ENV,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { external_directory: "deny" },
      }),
    });
  });

  // `launchProjectedOpenCodeServer` destructures `broker`/`credentialKind`/
  // `baseEnv` out of its options and forwards the rest — `freeTierGatewayAsk`
  // has to survive that spread untouched to reach launchOpenCodeServer's
  // config assembly.
  test("freeTierGatewayAsk survives the projected launch's option spread", async () => {
    const fake = fakeServer();
    const proj = fakeBroker();
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      credentialKind: "provider_free",
      freeTierGatewayAsk: ["bash", "read"],
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    await pending;

    expect(fake.env()).toEqual({
      PATH: "/usr/bin",
      ...PROJECTION_ENV,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: {
          external_directory: "deny",
          bash: "ask",
          read: "ask",
        },
      }),
    });
  });

  test("the projection wins over an allowlisted key of the same name", () => {
    // No overlap exists today (the allowlist is operational, the projection is
    // identity), so the launch tests above cannot exercise this. It is a
    // forward guard, and an untested one would be decoration: a broker that
    // later pinned PATH must not be silently overridden by pr-hero own.
    expect(
      composeOpenCodeServerEnv(
        { PATH: "/inherited/bin", LANG: "en_US.UTF-8" },
        { HOME: "/tmp/proj", PATH: "/projected/bin" },
      ),
    ).toEqual({
      PATH: "/projected/bin",
      LANG: "en_US.UTF-8",
      HOME: "/tmp/proj",
    });
  });

  test("close() destroys the projection", async () => {
    const fake = fakeServer();
    const proj = fakeBroker();
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      credentialKind: "opencode_chatgpt_oauth",
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
      termGraceMs: 5,
    });
    fake.emit(LISTENING);
    const server = await pending;

    const closing = server.close();
    fake.finish(0);
    await closing;

    expect(proj.destroys()).toBe(1);
  });

  // A signal (Ctrl-C, a cancelled CI job) used to kill only the claude CLI
  // children: the OpenCode server was in no registry, so it outlived pr-hero
  // with its projected credential on disk and a session that could keep
  // generating. Observed 2026-10-21: three `opencode serve` processes
  // reparented to init after a SIGTERM'd bench run.
  test("the signal path closes a live projected server and destroys its projection", async () => {
    ACTIVE_SERVER_CLOSERS.clear();
    const fake = fakeServer();
    const proj = fakeBroker();
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      credentialKind: "opencode_chatgpt_oauth",
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
      termGraceMs: 5,
    });
    fake.emit(LISTENING);
    await pending;

    const closing = closeAllServers();
    fake.finish(0);
    await closing;

    expect(fake.signals()).toContain("SIGTERM");
    expect(proj.destroys()).toBe(1);
    expect(ACTIVE_SERVER_CLOSERS.size).toBe(0);
  });

  test("a server already closed is not closed again on the signal path", async () => {
    ACTIVE_SERVER_CLOSERS.clear();
    const fake = fakeServer();
    const proj = fakeBroker();
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      credentialKind: "opencode_chatgpt_oauth",
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
      termGraceMs: 5,
    });
    fake.emit(LISTENING);
    const server = await pending;
    const closing = server.close();
    fake.finish(0);
    await closing;

    await closeAllServers();

    expect(proj.destroys()).toBe(1);
    expect(fake.signals()).toEqual(["SIGTERM"]);
  });

  test("a signal during an in-flight close waits for that close to destroy the projection", async () => {
    ACTIVE_SERVER_CLOSERS.clear();
    const fake = fakeServer();
    const proj = fakeBroker();
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      credentialKind: "opencode_chatgpt_oauth",
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
      termGraceMs: 1_000,
    });
    fake.emit(LISTENING);
    const server = await pending;
    void server.close();

    let signalSettled = false;
    const signalClose = closeAllServers().then(() => {
      signalSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signalSettled).toBe(false);
    expect(proj.destroys()).toBe(0);

    fake.finish(0);
    await signalClose;
    expect(proj.destroys()).toBe(1);
    expect(fake.signals()).toEqual(["SIGTERM"]);
  });

  test("a signal during startup stops the spawned server and destroys its projection", async () => {
    ACTIVE_SERVER_CLOSERS.clear();
    const fake = fakeServer();
    const proj = fakeBroker();
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      credentialKind: "opencode_chatgpt_oauth",
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
      termGraceMs: 5,
    });
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    const closing = closeAllServers();
    fake.finish(0);
    await closing;

    expect(fake.signals()).toContain("SIGTERM");
    expect(proj.destroys()).toBe(1);
    await expect(pending).rejects.toThrow();
    expect(proj.destroys()).toBe(1);
    expect(ACTIVE_SERVER_CLOSERS.size).toBe(0);
  });

  test("the projection outlives the process it authenticates", async () => {
    const fake = fakeServer();
    const order: string[] = [];
    const proj = fakeBroker({ onDestroy: () => order.push("destroy") });
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      credentialKind: "opencode_chatgpt_oauth",
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: (_pid, signal) => {
        order.push(String(signal));
      },
      termGraceMs: 5,
    });
    fake.emit(LISTENING);
    const server = await pending;

    const closing = server.close();
    fake.finish(0);
    await closing;

    // Destroying the auth store while the server still holds it would pull
    // the credential out from under a live process. The shutdown cascade runs
    // first; the projection goes last.
    expect(order).toEqual(["SIGTERM", "destroy"]);
  });

  test("a failed launch destroys the projection instead of leaking it", async () => {
    const proj = fakeBroker();
    await expect(
      launchProjectedOpenCodeServer({
        verifiedBinaryPath: BIN,
        broker: proj.broker,
        credentialKind: "opencode_chatgpt_oauth",
        baseEnv: { PATH: "/usr/bin" },
        spawnFn: (() => {
          throw new Error("spawn refused");
        }) as unknown as typeof Bun.spawn,
      }),
    ).rejects.toThrow("spawn refused");

    expect(proj.projects()).toBe(1);
    expect(proj.destroys()).toBe(1);
  });

  test("a projection failure fails the launch closed, with no spawn", async () => {
    const fake = fakeServer();
    const proj = fakeBroker({ failWith: new Error("no oauth record") });
    await expect(
      launchProjectedOpenCodeServer({
        verifiedBinaryPath: BIN,
        broker: proj.broker,
        credentialKind: "opencode_chatgpt_oauth",
        baseEnv: { PATH: "/usr/bin" },
        spawnFn: fake.spawnFn,
      }),
    ).rejects.toThrow("no oauth record");

    // Degrading to the operator's environment here is precisely the bug.
    expect(fake.argv()).toEqual([]);
  });

  test("the projection is asked for the opencode credential the authority binds", async () => {
    const fake = fakeServer();
    let seen: { kind: string; verifiedBinaryPath: string } | undefined;
    const broker: CredentialBroker = {
      project: async (input) => {
        seen = {
          kind: input.kind,
          verifiedBinaryPath: input.verifiedBinaryPath,
        };
        return {
          projectionId: "cred-fake",
          kind: input.kind,
          syntheticHome: PROJECTION_ENV.HOME,
          syntheticConfigHome: PROJECTION_ENV.XDG_CONFIG_HOME,
          syntheticTmp: PROJECTION_ENV.TMPDIR,
          env: { ...PROJECTION_ENV },
          files: [],
          destroy: async () => {},
        };
      },
    };
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker,
      credentialKind: "opencode_chatgpt_oauth",
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    await pending;

    expect(seen).toEqual({
      kind: "opencode_chatgpt_oauth",
      verifiedBinaryPath: BIN,
    });
  });

  // #133: the kind is per-ROUTE now (an opencode route on any provider but
  // `openai` is a metered API token), so the launcher cannot hold a literal.
  // A hardcoded `opencode_chatgpt_oauth` here would ask the api-token broker
  // for a kind it refuses — and, worse, would ask an OAuth broker to serve a
  // metered route if the pairing ever slipped the other way.
  test("the launcher asks for the credential kind it is given, not a literal", async () => {
    for (const kind of [
      "opencode_chatgpt_oauth",
      "provider_api_token",
    ] as const) {
      const fake = fakeServer();
      let seen: CredentialKind | undefined;
      const broker: CredentialBroker = {
        project: async (input) => {
          seen = input.kind;
          return {
            projectionId: "cred-fake",
            kind: input.kind,
            syntheticHome: PROJECTION_ENV.HOME,
            syntheticConfigHome: PROJECTION_ENV.XDG_CONFIG_HOME,
            syntheticTmp: PROJECTION_ENV.TMPDIR,
            env: { ...PROJECTION_ENV },
            files: [],
            destroy: async () => {},
          };
        },
      };
      const pending = launchProjectedOpenCodeServer({
        verifiedBinaryPath: BIN,
        broker,
        credentialKind: kind,
        baseEnv: { PATH: "/usr/bin" },
        spawnFn: fake.spawnFn,
        killFn: fake.killFn,
      });
      fake.emit(LISTENING);
      await pending;
      expect(seen).toBe(kind);
    }
  });
});
