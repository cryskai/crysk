// D1-06: the OpenCode server the SDK client talks to, launched under pr-hero's
// own threat model instead of the SDK's convenience helper.
//
// WHY NOT `createOpencodeServer` from @opencode-ai/sdk. Its implementation is
// `launch("opencode", args, { env: { ...process.env, ... } })`, and both
// halves of that are disqualifying here:
//
//   * it inherits the operator's ENTIRE environment, so the child would see
//     the operator's real HOME and walk straight past the §6.1 credential
//     projection — the projection would exist and protect nothing;
//   * it resolves `opencode` off PATH, while §13 requires preflight and
//     execution to use the same verified absolute binary.
//
// It also defaults to port 4096, a fixed port two concurrent reviews would
// collide on. This module asks for an ephemeral port and reads back the URL
// the server actually prints.

import type { CredentialKind } from "../execution/contracts";
import {
  ACTIVE_SERVER_CLOSERS,
  type SpawnedProcess,
} from "../execution/spawned-process";
import type { CredentialBroker } from "../security/credential-broker";
import { mcpConfigIsEmpty, type OpenCodeMcpConfig } from "./opencode-mcp";

// The line the server prints on startup, verified live against
// opencode 1.18.23: "opencode server listening on http://127.0.0.1:<port>".
const LISTENING_PREFIX = "opencode server listening";
const LISTENING_URL = /on\s+(https?:\/\/[^\s]+)/;

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
// Same cascade shape as the CLI transport (§5.2): TERM, a bounded grace, then
// KILL. The numbers are smaller because a server that will not stop is not
// holding a paid generation — only a port.
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_REAP_MS = 2_000;

// A piped stream nobody reads is a time bomb: the OS pipe buffer fills at
// ~64 KiB and the child BLOCKS in write(), stalling the whole server with no
// signal to the caller. Both pipes therefore keep a reader for the child's
// entire life, not just for startup.
async function drainToNowhere(stream: unknown): Promise<void> {
  try {
    for await (const _chunk of stream as AsyncIterable<Uint8Array>) {
      // Discarded on purpose — the point is to keep the pipe empty.
    }
  } catch {
    // A closed or errored pipe needs no draining.
  }
}

export interface OpenCodeServerHandle {
  readonly url: string;
  readonly pid: number;
  // Free-tier gateway fix: the gateway-ask ids this handle's OWN launcher
  // actually wrote into the server's `permission` config (sorted) — see
  // `freeTierGatewayAsk` below and `launchOpenCodeServer`'s config assembly
  // for where it is decided. opencode-client.ts's createSession reads this
  // BACK before it ever deletes a `false` entry off the tools map for a
  // denied id, so the deletion is only ever as safe as this field is honest.
  //
  // Optional, not required, by explicit scope decision: dozens of test
  // fakes across the suite construct a bare `{url, pid, close}` literal for
  // routes that never touch the free-tier gate, and turning every one of
  // them into a required-field update would be unrelated churn far outside
  // this fix. Absence is read as "this launcher attests nothing" by the
  // check in createSession, which fails CLOSED on it — an unattested
  // launcher can never satisfy a non-empty ask requirement, so an absent
  // field is exactly as safe as one that is present and empty.
  readonly gatewayAsk?: readonly string[];
  close(): Promise<void>;
}

export interface LaunchOpenCodeServerOptions {
  // Absolute and already verified by the caller. This module refuses a bare
  // name rather than resolving one itself: resolution is where the binary is
  // hashed, and a launcher that quietly accepted "opencode" would reintroduce
  // exactly the PATH lookup §13 forbids.
  readonly verifiedBinaryPath: string;
  // The COMPLETE environment for the child. Passed through untouched — this
  // module never merges process.env into it, which is the whole point. The ONE
  // documented addition is `mcp` below, and it is a value pr-hero computed
  // rather than one inherited from anywhere.
  readonly env: Readonly<Record<string, string>>;
  // #141: the run's MCP registry, translated from the Claude-shaped mcp.json
  // the binding policy already gates. Delivered as `OPENCODE_CONFIG_CONTENT`
  // at SPAWN, so the servers are connected from the server's first byte —
  // there is then no window between "server up" and "MCP connected" for a
  // prompt to fall into (the #128 race class). An empty registry delivers no
  // config at all: parity with claude-code on a repo with no codegraph index,
  // where the hunters run on read/grep/glob and pr-hero makes no claim about
  // the child's tool channels.
  readonly mcp?: OpenCodeMcpConfig;
  // Free-tier gateway fix (opencode-client.ts's FREE_TIER_GATEWAY_TOOLS):
  // gateway-required ids the calling session does NOT grant. Empty/undefined
  // for every route but `provider_free` — opencode-client.ts's createSession
  // is the only caller that ever populates it, gated on credentialKind, so a
  // metered/OAuth route reaches this launcher exactly as it always has. See
  // the WHY at the config assembly below for what each id gets instead of a
  // tools-map `false`.
  readonly freeTierGatewayAsk?: readonly string[];
  readonly spawnFn?: typeof Bun.spawn;
  // Injectable for offline tests; production signals the child by pid. Same
  // shape as ClaudeCodeCliTransport's, so the two shutdown paths read alike.
  readonly killFn?: (pid: number, signal?: string | number) => unknown;
  readonly startupTimeoutMs?: number;
  readonly termGraceMs?: number;
  readonly killReapMs?: number;
  readonly hostname?: string;
  // Handed the server's own close right after spawn, before the startup wait:
  // a signal in that window (up to startupTimeoutMs) must be able to stop a
  // server that has not announced its URL yet.
  readonly onSpawned?: (close: () => Promise<void>) => void;
}

export function openCodeServerArgv(
  binaryPath: string,
  hostname: string,
): string[] {
  return [
    binaryPath,
    "serve",
    // No external plugins. Two reasons, and the second is the one that
    // matters: it drops the plugin.added flood the probe recorded (45 of 71
    // events for one prompt), and it keeps third-party plugin code out of a
    // process holding a projected credential.
    "--pure",
    "--hostname",
    hostname,
    // Ephemeral, always. The URL is read back from stdout.
    "--port",
    "0",
  ];
}

export async function launchOpenCodeServer(
  options: LaunchOpenCodeServerOptions,
): Promise<OpenCodeServerHandle> {
  const {
    verifiedBinaryPath,
    env,
    spawnFn = Bun.spawn,
    killFn = process.kill,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    termGraceMs = DEFAULT_TERM_GRACE_MS,
    killReapMs = DEFAULT_KILL_REAP_MS,
    hostname = "127.0.0.1",
    mcp,
    freeTierGatewayAsk,
    onSpawned,
  } = options;

  if (!verifiedBinaryPath.startsWith("/")) {
    throw new Error(
      `opencode server binary must be an absolute, verified path: ${verifiedBinaryPath}`,
    );
  }

  // The projection, plus the run's own MCP registry when there is one. The
  // config is READ from `OPENCODE_CONFIG_CONTENT` at startup, which is the
  // mechanism the SDK's own helper uses (dist/server.js:15) and the one
  // measured to work under `--pure` (#141 fact 1). Written here rather than by
  // the caller so the "exactly the projected environment" rule keeps a single
  // enforcement point.
  //
  // #157 (pr-157-8df2fca3-6): a hunter's tool call for a path OUTSIDE the
  // reviewed worktree tripped OpenCode's `permission.asked` for
  // `external_directory` twice in one run, and pr-hero never answers that
  // prompt — the tool call sat blocked until the silence tripwire killed the
  // attempt 150s later at $0. `permission.external_directory: "deny"` is
  // delivered UNCONDITIONALLY (not gated on `mcp`, unlike the block below) so
  // the provider refuses the read/write itself instead of asking and waiting
  // forever. This tightens the §13 isolation threat model (CLAUDE.md rule
  // 4); the client's own reject-on-ask handling (opencode-client.ts's
  // "permission.asked" case) is defense in depth for whatever this config
  // does not cover, never the primary control.
  // Free-tier gateway fix (2026-09-26), scoped to `provider_free` alone by
  // explicit OWNER decision: OpenCode's free catalogue 403s any turn whose
  // tools map denies `bash` or `read` outright (the full observed matrix is
  // on FREE_TIER_GATEWAY_TOOLS in opencode-client.ts). Every other route
  // keeps sending those two `false` in the tools map as it always has, and
  // `freeTierGatewayAsk` stays empty for it, so `gatewayAskPermission` below
  // is `{}` and this object is BYTE IDENTICAL to before this change.
  //
  // For a `provider_free` route, opencode-client.ts's createSession keeps
  // each denied id OFF the tools map's false list instead (the gateway sees
  // a present, non-denied tool and admits the turn) and asks THIS config to
  // mark it "ask" here. That is a real relaxation of the tools-map control,
  // and it is safe only because isolation for these two ids moves entirely
  // to a DIFFERENT control: OpenCode's own permission gate, backed by
  // pr-hero's unconditional auto-reject on every `permission.asked` event
  // (opencode-client.ts's "permission.asked" handler, a few sessions'
  // worth of history below the #157 WHY right above this function). An
  // "ask" that is never answered never executes — OpenCode blocks the tool
  // call until it gets a reply, exactly like the `external_directory` case
  // #157 already describes — so the auto-reject exists NOT to make the call
  // succeed but to make it fail FAST: a rejected call costs one turn, an
  // unanswered one costs the full 150s silence-tripwire stall #157 measured.
  // The owner accepted this trade because the gateway refuses the stronger
  // posture (a denied tool) outright; it is not this module improvising a
  // weaker one on its own judgment.
  const gatewayAskPermission: Record<string, "ask"> = {};
  for (const tool of freeTierGatewayAsk ?? []) {
    gatewayAskPermission[tool] = "ask";
  }
  // The handle's attestation (OpenCodeServerHandle.gatewayAsk): read back
  // from what this function is ABOUT to write into `permission`, not echoed
  // from the `freeTierGatewayAsk` argument — a duplicate in that argument
  // must not inflate the attested set, and the attestation must describe
  // this config, not this call's input.
  const attestedGatewayAsk = Object.keys(gatewayAskPermission).sort();
  const config: {
    mcp?: OpenCodeMcpConfig;
    // Widened to "ask" | "deny" rather than an intersection with
    // Record<string, "ask">: an index signature applies to EVERY key,
    // `external_directory` included, so a plain `Record<string, "ask">`
    // would also demand `external_directory` be "ask" and reject "deny".
    permission: { external_directory: "deny" } & Record<string, "ask" | "deny">;
  } =
    mcp === undefined || mcpConfigIsEmpty(mcp)
      ? {
          permission: {
            external_directory: "deny",
            ...gatewayAskPermission,
          },
        }
      : {
          mcp,
          permission: {
            external_directory: "deny",
            ...gatewayAskPermission,
          },
        };
  const childEnv: Record<string, string> = {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };

  const proc = spawnFn(openCodeServerArgv(verifiedBinaryPath, hostname), {
    // EXACTLY the projected environment. Never `...process.env`.
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  }) as SpawnedProcess & { readonly pid: number };

  // stderr is never parsed, so it is drained from the very first byte. It was
  // piped and then never read at all, which is the same pipe-full stall as
  // stdout with none of the startup logic to disguise it.
  void drainToNowhere(proc.stderr);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      killFn(proc.pid, "SIGTERM");
    } catch {
      // Already gone; nothing to escalate to.
    }
    const escalated = await Promise.race([
      proc.exited.then(() => "exited" as const),
      new Promise<"grace">((resolve) =>
        setTimeout(() => resolve("grace"), termGraceMs),
      ),
    ]);
    if (escalated === "grace") {
      try {
        killFn(proc.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      // BOUNDED reap. A child that does not die to SIGKILL is unreapable from
      // here — it is stuck in uninterruptible state or already a zombie whose
      // parent is elsewhere — and waiting on it forever would hang the
      // caller's shutdown on a process nothing can influence. Same reasoning
      // as the CLI transport's reap bound (§5.2).
      await Promise.race([
        proc.exited,
        new Promise<void>((resolve) => setTimeout(resolve, killReapMs)),
      ]);
    }
  };

  onSpawned?.(close);

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        void close();
        reject(
          new Error(
            `opencode server did not announce a listening URL within ${startupTimeoutMs}ms`,
          ),
        );
      });
    }, startupTimeoutMs);

    void proc.exited.then((code) => {
      finish(() => {
        reject(
          new Error(`opencode server exited during startup (code ${code})`),
        );
      });
    });

    void (async () => {
      // Accumulated across chunks on purpose: the announcement arrives split
      // in practice, and a parser that only inspected whole chunks would miss
      // a server that started perfectly well and then time out on it.
      let buffered = "";
      let announced = false;
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
          // Once the URL is out, this loop stops PARSING but keeps READING:
          // the server logs for the rest of its life, and a pipe with no
          // reader fills and blocks the child in write().
          if (announced) continue;
          if (settled) {
            announced = true;
            continue;
          }
          buffered += decoder.decode(chunk, { stream: true });
          // COMPLETE lines only. A partial one can match both the prefix and
          // the URL pattern while the port is still arriving — "…127.0.0.1:6"
          // parses cleanly and points the client at port 6. The trailing
          // fragment stays buffered until its newline lands.
          const lines = buffered.split("\n");
          const complete = lines.slice(0, -1);
          buffered = lines[lines.length - 1] ?? "";
          for (const line of complete) {
            if (!line.startsWith(LISTENING_PREFIX)) continue;
            const match = line.match(LISTENING_URL);
            if (match === null) {
              finish(() => {
                void close();
                reject(
                  new Error(
                    `opencode server announced a line with no parseable URL: ${line}`,
                  ),
                );
              });
              announced = true;
              break;
            }
            finish(() => resolve(match[1]));
            announced = true;
            break;
          }
        }
      } catch {
        finish(() => {
          void close();
          reject(new Error("opencode server stdout ended before startup"));
        });
      }
    })();
  });

  return { url, pid: proc.pid, gatewayAsk: attestedGatewayAsk, close };
}

// #149: the environment the server may inherit from pr-hero's own process.
//
// This list is deliberately NOT the harness's ENV_PASSTHROUGH, and the
// difference is the whole point. That list serves a claude-code child and
// carries ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN.
// opencode reads ambient provider keys as credential SOURCES — measured live
// on 1.18.23: launching with an otherwise-projected env plus a fake
// ANTHROPIC_API_KEY connected the `anthropic` provider, and plus a fake
// OPENAI_API_KEY connected `openai`. Composing the server's env from the
// harness's list would therefore reintroduce, through the fix, the very leak
// #149 is about.
//
// So: operational keys only. Nothing here can name a credential or a home.
const SERVER_ENV_PASSTHROUGH: readonly string[] = [
  // Not optional: the projection carries no PATH, and the measured-clean
  // configuration included it. `{HOME}` alone was never measured.
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

export function composeOpenCodeServerEnv(
  base: Readonly<Record<string, string | undefined>>,
  projectionEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const composed: Record<string, string> = {};
  for (const key of SERVER_ENV_PASSTHROUGH) {
    const value = base[key];
    if (value !== undefined) composed[key] = value;
  }
  // Last, and unconditionally: HOME/TMPDIR/XDG_* are the projection's to own.
  // An inherited value surviving here is the defect, not a fallback.
  return { ...composed, ...projectionEnv };
}

export interface LaunchProjectedOpenCodeServerOptions
  extends Omit<LaunchOpenCodeServerOptions, "env"> {
  // The credential authority's broker for this backend. Defaulting one here
  // would be a second source of truth beside runner-authority.ts, so the
  // caller supplies the same instance the binding was resolved with.
  readonly broker: CredentialBroker;
  // #133: REQUIRED, and paired with `broker` above for the same reason it is
  // not defaulted here. The kind is per-ROUTE now — an opencode route on any
  // provider but `openai` runs on a metered API token — so a default in this
  // file would be a second source of truth beside runner-authority.ts, and
  // the wrong half of the pair would only surface at projection time inside a
  // live run. Required drags every caller through tsc instead.
  readonly credentialKind: CredentialKind;
  // pr-hero's own environment, filtered through SERVER_ENV_PASSTHROUGH.
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

// The server's env is its ENTIRE environment, and the server outlives every
// individual step, so the projection it runs under must outlive them too:
// one projection per SERVER, destroyed by the handle's close(). Handing the
// shared server a per-step projection would leave its HOME pointing at a
// directory deleted when that step settled, while siblings still used it.
export async function launchProjectedOpenCodeServer(
  options: LaunchProjectedOpenCodeServerOptions,
): Promise<OpenCodeServerHandle> {
  const { broker, credentialKind, baseEnv = {}, ...launchOptions } = options;

  const projection = await broker.project({
    // Three of these four are voided by the OpenCode broker; `kind` is the one
    // it reads. #133: it is no longer a constant. The kind is decided per
    // route by runner-authority.ts's credentialKindForRoute, and this server
    // is handed the one its binding resolved.
    //
    // SCOPE NOTE, not solved here: this server is ONE per backend and
    // outlives every step, so a plan mixing an `openai` OAuth route with a
    // `zai` API-token route needs two credentials behind one server. That
    // case is refused upstream — the metered route has no pricing table yet,
    // so the exact-binding gate blocks it per binding before anything
    // launches (test/production-runtime.test.ts, "a plan mixing an OAuth
    // provider and an API-token provider is refused per binding"). When #137
    // prices those routes, this becomes reachable and needs a server per
    // credential; until then it must fail LOUD, which it does — a broker
    // handed the wrong kind refuses it by name.
    sessionId: "opencode-server",
    credentialRef: "opencode-auth",
    kind: credentialKind,
    verifiedBinaryPath: launchOptions.verifiedBinaryPath,
  });

  // Registered for the signal path (spawned-process.ts closeAllServers)
  // BEFORE the launch, so a signal during startup still stops the spawned
  // server and destroys the projection. One memoized close serves every
  // caller: a signal arriving while a normal close is in flight awaits that
  // same close instead of finding nothing to wait for. It leaves the registry
  // only once the projection is gone.
  let stopServer: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await stopServer?.();
      } finally {
        try {
          await projection.destroy();
        } finally {
          ACTIVE_SERVER_CLOSERS.delete(close);
        }
      }
    })();
    return closing;
  };
  ACTIVE_SERVER_CLOSERS.add(close);

  let handle: OpenCodeServerHandle;
  try {
    handle = await launchOpenCodeServer({
      ...launchOptions,
      env: composeOpenCodeServerEnv(baseEnv, projection.env),
      onSpawned: (stop) => {
        stopServer = stop;
      },
    });
  } catch (error) {
    // The client resets its launch promise on failure and will project again,
    // so a projection abandoned here is a credential left on disk per retry.
    await close();
    throw error;
  }

  return {
    url: handle.url,
    pid: handle.pid,
    // Carried through, not dropped: this function builds a FRESH handle
    // object rather than returning `handle` itself (its `close` has to wrap
    // `projection.destroy()`), and forgetting a field here silently loses
    // it for every production caller — `defaultOpenCodeLaunchServer` and
    // `openCodeLaunchServerFor` both go through this path, so a dropped
    // `gatewayAsk` here would empty the attestation `createSession` reads
    // in the ONE codepath production actually runs.
    gatewayAsk: handle.gatewayAsk,
    close,
  };
}
