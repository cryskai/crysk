import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderTransport,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  isHarnessStderrAnnotation,
  StepExecutionHarness,
} from "../../src/execution/harness";
import {
  InMemorySpendLedger,
  type ReserveSpendInput,
  type SettlementDecision,
  type SpendLedger,
  type SpendReservation,
} from "../../src/execution/spend-limiter";
import { envBillsMetered } from "../../src/execution/usage-normalized";
import { stepFailureReason } from "../../src/review/pipeline";
import {
  credentialKindBillsMetered,
  credentialKindForRoute,
} from "../../src/runner-authority";
import type {
  CredentialBroker,
  CredentialProjection,
} from "../../src/security/credential-broker";
import { CredentialProjectionError } from "../../src/security/credential-broker";

// In-memory broker over a real temp dir so destroy() is observable on disk.
class FakeBroker implements CredentialBroker {
  projectCalls = 0;
  destroyCalls = 0;
  lastProjection?: CredentialProjection;

  constructor(private readonly error?: CredentialProjectionError) {}

  async project(_input: {
    readonly sessionId: string;
    readonly credentialRef: string;
    readonly kind: string;
    readonly verifiedBinaryPath: string;
  }): Promise<CredentialProjection> {
    this.projectCalls++;
    if (this.error) throw this.error;
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-fake-proj-"));
    const projection: CredentialProjection = {
      projectionId: `cred-fake-${this.projectCalls}`,
      kind: "claude_subscription_oauth",
      syntheticHome: home,
      syntheticConfigHome: path.join(home, ".claude"),
      syntheticTmp: path.join(home, "tmp"),
      env: { HOME: home, TMPDIR: path.join(home, "tmp") },
      files: [],
      destroy: async () => {
        this.destroyCalls++;
        await rm(home, { recursive: true, force: true });
      },
    };
    this.lastProjection = projection;
    return projection;
  }
}

function recordingTransport(requests: TransportRequest[]): ProviderTransport {
  return {
    backend: "claude-code",
    capabilities: async () => {
      throw new Error("not used");
    },
    classifyFailure: () => undefined,
    async execute(request) {
      requests.push(request);
      return {
        completion: "success",
        protocolIntegrity: "verified",
        finalText: "{}",
        usage: {
          wallMs: 0,
          tokens: {},
          completeness: "complete",
          billingMode: "subscription",
        },
        stderrTail: "",
      } satisfies TransportOutcome;
    },
  };
}

// #150: a stand-in for OpenCodeSdkTransport's declaration — its server owns
// ONE credential projection for the server's whole lifetime (#149), so it
// never reads `request.isolation` and declares as much.
function serverLifetimeTransport(
  requests: TransportRequest[],
): ProviderTransport {
  return {
    backend: "opencode",
    credentialProjection: "server-lifetime",
    capabilities: async () => {
      throw new Error("not used");
    },
    classifyFailure: () => undefined,
    async execute(request) {
      requests.push(request);
      return {
        completion: "success",
        protocolIntegrity: "verified",
        finalText: "{}",
        usage: {
          wallMs: 0,
          tokens: {},
          completeness: "complete",
          billingMode: "subscription",
        },
        stderrTail: "",
      } satisfies TransportOutcome;
    },
  };
}

// #279: a transport reporting METERED usage — `recordingTransport` above
// always reports `billingMode: "subscription"`, which is exactly wrong for
// exercising `settlementFromUsage`'s rules (spend-limiter.ts) against a
// degraded attempt's own reservation.
function meteredTransport(
  requests: TransportRequest[],
  usage: TransportOutcome["usage"],
): ProviderTransport {
  return {
    backend: "claude-code",
    capabilities: async () => {
      throw new Error("not used");
    },
    classifyFailure: () => undefined,
    async execute(request) {
      requests.push(request);
      return {
        completion: "success",
        protocolIntegrity: "verified",
        finalText: "{}",
        usage,
        stderrTail: "",
      } satisfies TransportOutcome;
    },
  };
}

// Wraps the real, already-tested InMemorySpendLedger so these tests assert
// WIRING (was `reserve()` called, how many times, with which bucket) rather
// than re-testing the ledger's own CAS semantics — mirrors
// test/harness/spend-wiring.test.ts's SpyLedger exactly.
class SpyLedger implements SpendLedger {
  private readonly inner = new InMemorySpendLedger();
  reserveCalls: ReserveSpendInput[] = [];

  async reserve(
    input: ReserveSpendInput,
    token: Parameters<InMemorySpendLedger["reserve"]>[1],
  ): Promise<SpendReservation> {
    this.reserveCalls.push(input);
    return this.inner.reserve(input, token);
  }

  async settle(
    reservationId: string,
    decision: Extract<SettlementDecision, { kind: "settle" }>,
    idempotencyKey: string,
  ): Promise<void> {
    return this.inner.settle(reservationId, decision, idempotencyKey);
  }

  async releaseUnstarted(
    reservationId: string,
    idempotencyKey: string,
  ): Promise<void> {
    return this.inner.releaseUnstarted(reservationId, idempotencyKey);
  }

  async markUnresolvedRemote(
    reservationId: string,
    idempotencyKey: string,
  ): Promise<void> {
    return this.inner.markUnresolvedRemote(reservationId, idempotencyKey);
  }
}

function makeHarness(transport: ProviderTransport, broker?: CredentialBroker) {
  return new StepExecutionHarness({
    transport,
    // Marks the harness as offline-test (skips the production allowlist gate).
    spawnFn: (() => ({
      exited: Promise.resolve(0),
    })) as unknown as typeof Bun.spawn,
    // Injected, never read off the real environment: these arms turn on
    // whether an AMBIENT credential survives into the child, so a test that
    // consulted `process.env` would pass or fail by whatever the operator
    // happened to have exported.
    childEnv: {
      HOME: "/Users/juanma-real-home",
      USER: "juanma",
      TMPDIR: "/var/folders/real-tmp",
      CLAUDE_CONFIG_DIR: "/Users/juanma-real-home/.claude",
      PATH: "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "sk-ambient-operator-key",
      ANTHROPIC_AUTH_TOKEN: "ambient-operator-bearer",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-ambient",
      ANTHROPIC_BASE_URL: "https://gateway.operator.example",
    },
    credentialBroker: broker,
  });
}

async function runStep(
  harness: StepExecutionHarness,
  parse: (text: string) => unknown = (text) => JSON.parse(text),
) {
  const promptDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cred-probe-"));
  const systemPromptPath = path.join(promptDir, "system.md");
  await Bun.write(systemPromptPath, "system prompt");
  return harness.run({
    name: "cred-probe",
    systemPromptPath,
    prompt: "p",
    tools: [],
    model: "sonnet",
    effort: "high",
    cwd: "/tmp/ws",
    outPath: `/tmp/cred-probe-${Date.now()}.json`,
    mcpConfigPath: "/tmp/mcp.json",
    timeoutMs: 1000,
    maxAttempts: 1,
    parse,
  });
}

describe("harness with a CredentialBroker", () => {
  test("child env uses synthetic HOME/TMPDIR and drops the real HOME and CLAUDE_CONFIG_DIR", async () => {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker();
    const harness = makeHarness(recordingTransport(requests), broker);
    const result = await runStep(harness);
    expect(result.status).toBe("ok");

    expect(broker.projectCalls).toBe(1);
    const projection = broker.lastProjection;
    if (projection === undefined) throw new Error("projection missing");
    const isolation = requests[0].isolation;
    expect(isolation.credentialProjectionId).toBe(projection.projectionId);
    expect(isolation.syntheticHome).toBe(projection.syntheticHome);
    expect(isolation.syntheticConfigHome).toBe(projection.syntheticConfigHome);
    expect(isolation.syntheticTmp).toBe(projection.syntheticTmp);
    expect(isolation.env.HOME).toBe(projection.syntheticHome);
    expect(isolation.env.TMPDIR).toBe(projection.syntheticTmp);
    expect(JSON.stringify(isolation.env)).not.toContain("juanma-real-home");
    expect(isolation.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(existsSync(projection.syntheticHome)).toBe(false);

    // Non-credential passthrough keys survive the overlay.
    expect(isolation.env.PATH).toBe("/usr/bin:/bin");
    expect(isolation.env.USER).toBe("juanma");
  });

  // 2026-09-02, #177 follow-up: the projection owns the CREDENTIAL, not only
  // HOME/TMPDIR. An ambient ANTHROPIC_API_KEY riding the enumerated
  // passthrough used to survive the overlay untouched on exactly the path
  // whose purpose is handing the child one freshly projected subscription
  // record — and #177 made that leak observable, because the billing basis is
  // now read off this same env.
  test("a projection strips the ambient credentials the passthrough carried", async () => {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker();
    const harness = makeHarness(recordingTransport(requests), broker);
    const result = await runStep(harness);
    expect(result.status).toBe("ok");

    const env = requests[0].isolation.env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("ambient");
    // The other half of the defect, and the reason it stopped being inert:
    // this env is what decides how the attempt's money is filed. A leaked key
    // billed a subscription run as metered cash.
    expect(envBillsMetered(env)).toBe(false);

    // EXCLUDED on purpose, and asserted so the exclusion is a decision rather
    // than an oversight: ANTHROPIC_BASE_URL is not a credential. It sits in
    // the passthrough beside HTTP(S)_PROXY/SSL_CERT_* as network-routing
    // config, and the projection supplies no endpoint — stripping it would
    // silently send the projection path somewhere the no-projection path
    // does not go.
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.operator.example");
  });

  // The no-projection path is CI, and it is the one that already cost a real
  // failure: dropping CLAUDE_CODE_OAUTH_TOKEN lost pr-hero's first CI
  // self-review (2026-08-27) to "Not logged in". Credential projection needs
  // darwin + /usr/bin/security (runner-authority.ts `claudeCredentialBroker`),
  // so every CI runner lands here with no projection at all, and the strip
  // above must not reach it.
  test("without a projection the ambient credentials still reach the child", async () => {
    const requests: TransportRequest[] = [];
    const harness = makeHarness(recordingTransport(requests));
    const result = await runStep(harness);
    expect(result.status).toBe("ok");

    const env = requests[0].isolation.env;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ambient-operator-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ambient-operator-bearer");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-ambient");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.operator.example");
    // #177's own arm: a key with no projection is a real per-token spend and
    // must keep filing as cash.
    expect(envBillsMetered(env)).toBe(true);
    // And the projection-owned trio is untouched too — there is no projection
    // to own it.
    expect(env.HOME).toBe("/Users/juanma-real-home");
    expect(env.TMPDIR).toBe("/var/folders/real-tmp");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/juanma-real-home/.claude");
  });

  test("destroy runs after success AND after failed steps", async () => {
    for (const parse of [
      (text: string) => JSON.parse(text),
      (): unknown => {
        throw new Error("never delivered");
      },
    ]) {
      const requests: TransportRequest[] = [];
      const broker = new FakeBroker();
      const harness = makeHarness(recordingTransport(requests), broker);
      const result = await runStep(harness, parse);
      expect(broker.destroyCalls).toBe(1);
      if (result.status === "failed") {
        expect(result.stderrTail).not.toContain("destroy failed");
      }
      expect(
        existsSync(broker.lastProjection?.syntheticHome ?? "/nonexistent"),
      ).toBe(false);
    }
  });

  test("projection failure degrades to operator env with a stated warning instead of killing the step", async () => {
    let admitted = false;
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker(
      new CredentialProjectionError("missing_subscription_record"),
    );
    const harness = new StepExecutionHarness({
      transport: recordingTransport(requests),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: { HOME: "/Users/juanma-real-home" },
      admissionGate: {
        admit: () => {
          admitted = true;
        },
      },
      credentialBroker: broker,
    });
    const result = await runStep(harness);
    // Deliberate degradation (2026-08-26): reviews must keep working when the
    // CLI's credential store moves; the fallback is the pre-D1-05 enumerated
    // environment, loudly announced.
    expect(result.stderrTail).toContain("missing_subscription_record");
    expect(result.stderrTail).toContain("child runs with operator environment");
    expect(result.stderrTail).not.toContain("AT-");
    // The child saw the operator HOME, not a synthetic one.
    expect(requests.length).toBe(1);
    expect(requests[0]?.isolation.env.HOME).toBe("/Users/juanma-real-home");
    // The isolation record describes what ACTUALLY ran — no false synthetic
    // identity (§6.1 invariant env.HOME === syntheticHome).
    expect(requests[0]?.isolation.credentialProjectionId).toBe(
      "operator-env-fallback",
    );
    expect(requests[0]?.isolation.syntheticHome).toBe(
      "/Users/juanma-real-home",
    );
    expect(admitted).toBe(true);
    expect(broker.destroyCalls).toBe(0);
  });

  // #279 (fixed 2026-09-24 by Juanma, option 2 — see the WHY on
  // `StepExecutionHarnessOptions.reservesSpend`/`degradedProjectionBucketId`,
  // harness.ts). `missing_subscription_record` is the one failure class the
  // harness degrades instead of killing the step (the arm just above): no
  // projection runs, `buildChildEnv` falls back to the env UNSTRIPPED, and
  // the ambient credentials the passthrough carried reach the child after
  // all — even though a credential broker WAS attached to the route
  // (`resolveBindingAuthority`, runner-authority.ts, would have called
  // `credentialKindForRoute(..., hasBroker: true)` for it, exactly the case
  // that says subscription per #161's corrected rule). Usage filing reads
  // this SAME env and correctly concludes metered.
  //
  // That admission/filing DISAGREEMENT is permanent by design — admission
  // cannot see a runtime degrade, and #279's fix does not touch bind time.
  // What this test used to end on was the OTHER half: nothing fenced the
  // spend on this path. It no longer does — the LAST assertions below are
  // the deliberate flip fixing #279 promised, not a surprise: a
  // `spendLedger` configured with `reservesSpend: false` (a subscription
  // binding, unchanged) now opens and settles exactly ONE reservation for
  // this attempt, on the SAME child env usage filing already reads.
  test("#279: a degraded projection leaves the ambient key reaching the child, usage filing correctly reads it as metered, and the harness now reserves and settles that spend", async () => {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker(
      new CredentialProjectionError("missing_subscription_record"),
    );
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport: meteredTransport(requests, {
        wallMs: 5,
        tokens: { outputVisible: 40, outputKnown: 40, totalKnown: 40 },
        completeness: "complete",
        billingMode: "metered",
      }),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      // Same ambient key `makeHarness` seeds elsewhere in this file as "the
      // operator's real key" — constructed directly here (rather than via
      // `makeHarness`) because this test also needs the #279 spend options.
      childEnv: {
        HOME: "/Users/juanma-real-home",
        USER: "juanma",
        PATH: "/usr/bin:/bin",
        ANTHROPIC_API_KEY: "sk-ambient-operator-key",
      },
      credentialBroker: broker,
      spendLedger: ledger,
      reservesSpend: false,
      degradedProjectionBucketId: "mirrored-metered-bucket",
    });
    const result = await runStep(harness);
    expect(result.status).toBe("ok");
    expect(result.stderrTail).toContain("missing_subscription_record");
    // Never silent: the result says the attempt was accounted as metered.
    expect(result.stderrTail).toContain("ambient credential bills metered");

    // The ACTUAL child env: unstripped, because the projection never ran.
    const env = requests[0]?.isolation.env;
    expect(env?.ANTHROPIC_API_KEY).toBe("sk-ambient-operator-key");
    // What usage filing (`claudeCliCostBasis` -> `envBillsMetered`,
    // claude-code-cli.ts) correctly concludes from this same env.
    expect(envBillsMetered(env ?? {})).toBe(true);

    // What ADMISSION concluded before any of this happened, for the exact
    // same key and the exact same fact ("a broker is attached") — it cannot
    // see that this particular attempt's projection will degrade. Left
    // UNCHANGED by #279's fix on purpose (option 2 never touches bind time).
    const admissionKind = credentialKindForRoute(
      "claude-code",
      "anthropic",
      { ANTHROPIC_API_KEY: "sk-ambient-operator-key" },
      true,
    );
    expect(credentialKindBillsMetered(admissionKind)).toBe(false);

    // THE FLIP: the spend admission could not see is no longer unaccounted
    // for. One reservation, opened against the MIRRORED metered bucket
    // (never the binding's own — `degradedProjectionBucketId`), settled on
    // the attempt's complete usage.
    expect(ledger.reserveCalls).toHaveLength(1);
    expect(ledger.reserveCalls[0]?.bucketId).toBe("mirrored-metered-bucket");
    expect(result.reservations).toHaveLength(1);
    expect(result.reservations?.[0]?.state).toBe("settled");
  });

  test("attack-signal projection failures still fail closed before admission", async () => {
    let admitted = false;
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker(
      new CredentialProjectionError("projection_layout_invalid"),
    );
    const harness = new StepExecutionHarness({
      transport: recordingTransport(requests),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: { HOME: "/Users/juanma-real-home" },
      admissionGate: {
        admit: () => {
          admitted = true;
        },
      },
      credentialBroker: broker,
    });
    const result = await runStep(harness);
    // A symlinked projection layout is an attack signal, not a moved store:
    // running an adversarial-diff agent with operator credentials precisely
    // when the defense tripped would be worse than no review.
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(admitted).toBe(false);
    expect(requests.length).toBe(0);
    expect(result.stderrTail).toContain("projection_layout_invalid");
    expect(result.stderrTail).not.toContain("operator environment");
  });

  // #133: `missing_provider_record` is the metered kind's own failure class,
  // and it must NOT join the one-class degradation above. The degrade exists
  // because Claude's subscription store MOVED, which is an environment fact;
  // an absent provider API token is not, and running the step anyway would
  // hand an adversarial-diff agent the operator's ambient provider keys on a
  // route that bills real cash.
  test("a missing provider record fails closed instead of degrading", async () => {
    let admitted = false;
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker(
      new CredentialProjectionError("missing_provider_record"),
    );
    const harness = new StepExecutionHarness({
      transport: recordingTransport(requests),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: { HOME: "/Users/juanma-real-home" },
      admissionGate: {
        admit: () => {
          admitted = true;
        },
      },
      credentialBroker: broker,
    });
    const result = await runStep(harness);
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(admitted).toBe(false);
    expect(requests.length).toBe(0);
    expect(result.stderrTail).toContain("missing_provider_record");
    expect(result.stderrTail).not.toContain("operator environment");
  });

  test("hanging credential projection fails before spawn within the projection budget", async () => {
    const requests: TransportRequest[] = [];
    const hangingBroker: CredentialBroker = {
      project: () => new Promise(() => {}),
    };
    const harness = new StepExecutionHarness({
      transport: recordingTransport(requests),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: {
        HOME: "/Users/juanma-real-home",
        PATH: "/usr/bin:/bin",
      },
      credentialBroker: hangingBroker,
      credentialProjectionTimeoutMs: 25,
    });
    const result = await runStep(harness);
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(requests).toHaveLength(0);
    expect(result.stderrTail).toContain("broker_error");
  });

  test("late credential projection after timeout is destroyed instead of leaked", async () => {
    const requests: TransportRequest[] = [];
    let resolveLate: ((projection: CredentialProjection) => void) | undefined;
    let destroyCalls = 0;
    const slowBroker: CredentialBroker = {
      project: async () =>
        new Promise<CredentialProjection>((resolve) => {
          resolveLate = resolve;
        }),
    };
    const harness = new StepExecutionHarness({
      transport: recordingTransport(requests),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: {
        HOME: "/Users/juanma-real-home",
        PATH: "/usr/bin:/bin",
      },
      credentialBroker: slowBroker,
      credentialProjectionTimeoutMs: 25,
    });

    const resultPromise = runStep(harness);
    const result = await resultPromise;
    expect(result.status).toBe("failed");
    expect(requests).toHaveLength(0);

    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-late-proj-"));
    const lateProjection: CredentialProjection = {
      projectionId: "late-projection",
      kind: "claude_subscription_oauth",
      syntheticHome: home,
      syntheticConfigHome: path.join(home, ".claude"),
      syntheticTmp: path.join(home, "tmp"),
      env: { HOME: home },
      files: [],
      destroy: async () => {
        destroyCalls++;
        await rm(home, { recursive: true, force: true });
      },
    };
    resolveLate?.(lateProjection);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(destroyCalls).toBe(1);
  });

  test("destroy failure is appended to stderrTail instead of thrown or replacing the outcome", async () => {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker();
    const harness = makeHarness(recordingTransport(requests), broker);
    // Sabotage destroy AFTER projection succeeds.
    const originalProject = broker.project.bind(broker);
    broker.project = async (input) => {
      const projection = await originalProject(input);
      projection.destroy = async () => {
        broker.destroyCalls++;
        throw new Error("EBUSY sabotage");
      };
      return projection;
    };
    const result = await runStep(harness);
    expect(result.status).toBe("ok");
    expect(broker.destroyCalls).toBe(1);
    expect(result.stderrTail).toContain(
      "[pr-hero] credential projection destroy failed",
    );
  });
});

// PR #315 review F001: the progress reason (pipeline.ts stepFailureReason)
// reads a step's stderrTail AFTER the harness has appended its bookkeeping
// lines. These drive the harness's REAL appends — not literal copies — so a
// reworded annotation the predicate stops matching fails here.
describe("progress reason over the harness's real annotations", () => {
  const SPAWN_LINE =
    "[pr-hero] spawn failed: E2BIG: argument list too long; no child started";

  test("a degraded, metered failed step still reports the transport's cause", async () => {
    const harness = new StepExecutionHarness({
      transport: {
        backend: "claude-code",
        capabilities: async () => {
          throw new Error("not used");
        },
        classifyFailure: () => undefined,
        async execute() {
          return {
            completion: "failed",
            protocolIntegrity: "unverified",
            finalText: "",
            usage: {
              wallMs: 0,
              tokens: {},
              completeness: "complete",
              billingMode: "metered",
            },
            stderrTail: SPAWN_LINE,
          } satisfies TransportOutcome;
        },
      },
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      // An ambient metered key, so the degraded attempt opens a reservation
      // and the harness appends its metered note too (#279).
      childEnv: {
        HOME: "/Users/juanma-real-home",
        PATH: "/usr/bin:/bin",
        ANTHROPIC_API_KEY: "sk-ambient-operator-key",
      },
      credentialBroker: new FakeBroker(
        new CredentialProjectionError("missing_subscription_record"),
      ),
      spendLedger: new SpyLedger(),
      reservesSpend: false,
      degradedProjectionBucketId: "mirrored-metered-bucket",
    });
    const result = await runStep(harness);
    expect(result.status).toBe("failed");
    // Precondition: the tail really does END in harness annotations, so the
    // assertion below discriminates — a "last line" reader would fail it.
    const lines = result.stderrTail.split("\n");
    expect(lines.at(-1)).toStartWith(
      "[pr-hero] ambient credential bills metered",
    );
    expect(lines.at(-2)).toStartWith(
      "[pr-hero] credential projection unavailable (missing_subscription_record)",
    );
    expect(lines.filter(isHarnessStderrAnnotation)).toHaveLength(2);
    expect(stepFailureReason(result.stderrTail)).toBe(
      "spawn failed: E2BIG: argument list too long; no child started",
    );
  });

  // A successful transport with an EMPTY tail, so the reading below holds
  // whether or not the destroy-failure append duplicates the existing tail.
  test("a destroy-failure annotation is never itself a reason", async () => {
    const broker = new FakeBroker();
    const harness = makeHarness(recordingTransport([]), broker);
    const original = broker.project.bind(broker);
    broker.project = async (input) => {
      const projection = await original(input);
      projection.destroy = async () => {
        throw new Error("EBUSY sabotage");
      };
      return projection;
    };
    const result = await runStep(harness);
    const lines = result.stderrTail.split("\n").filter((l) => l.trim() !== "");
    expect(lines.at(-1)).toBe("[pr-hero] credential projection destroy failed");
    expect(lines.every(isHarnessStderrAnnotation)).toBe(true);
    expect(stepFailureReason(result.stderrTail)).toBeUndefined();
  });
});

// #150: a transport that declares it does not consume the harness's
// per-step credential projection (the OpenCode SDK transport's
// server-lifetime projection, #149) must never have one materialized,
// written to disk, or destroyed on its behalf — and a broker that would
// degrade must never even be given the chance to.
describe("#150: a transport declaring server-lifetime credential projection", () => {
  test("the broker's project() is never called, the step succeeds, and no projection warning is stated", async () => {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker();
    const harness = makeHarness(serverLifetimeTransport(requests), broker);
    const result = await runStep(harness);

    expect(result.status).toBe("ok");
    expect(broker.projectCalls).toBe(0);
    expect(broker.destroyCalls).toBe(0);
    expect(result.stderrTail).not.toContain("credential projection");
    expect(result.stderrTail).not.toContain("operator environment");

    // The isolation record says the honest thing — server-lifetime, not a
    // fallback masquerading as one (§6.1 invariant: no false synthetic
    // identity, and no false "this was a degrade" either).
    expect(requests).toHaveLength(1);
    expect(requests[0]?.isolation.credentialProjectionId).toBe(
      "server-lifetime",
    );
  });

  test("a broker that would throw missing_subscription_record never gets the chance to — the step succeeds undegraded", async () => {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker(
      new CredentialProjectionError("missing_subscription_record"),
    );
    const harness = makeHarness(serverLifetimeTransport(requests), broker);
    const result = await runStep(harness);

    expect(result.status).toBe("ok");
    expect(broker.projectCalls).toBe(0);
    // The degrade branch (harness.ts) is unreachable here: project() was
    // never called, so its failure class never surfaces.
    expect(result.stderrTail).not.toContain("missing_subscription_record");
    expect(result.stderrTail).not.toContain("operator environment");
    expect(requests[0]?.isolation.credentialProjectionId).toBe(
      "server-lifetime",
    );
  });

  test("a transport with no declaration keeps projecting (the fail-safe default)", async () => {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker();
    // recordingTransport() declares no `credentialProjection` at all —
    // absent must mean "per-step", i.e. today's behaviour, unchanged.
    const harness = makeHarness(recordingTransport(requests), broker);
    const result = await runStep(harness);

    expect(result.status).toBe("ok");
    expect(broker.projectCalls).toBe(1);
    expect(broker.destroyCalls).toBe(1);
    const projection = broker.lastProjection;
    if (projection === undefined) throw new Error("projection missing");
    expect(requests[0]?.isolation.credentialProjectionId).toBe(
      projection.projectionId,
    );
  });
});

// #279 (fixed 2026-09-24, option 2): the harness's own per-attempt fence for
// a degraded projection's ambient spend, isolated from the admission
// concerns the describe block above tests. Every harness here is built
// directly (not via `makeHarness`) and wires `spendLedger`/`reservesSpend`
// explicitly, so each test states its own binding shape rather than
// inheriting one.
describe("#279: fencing a degraded projection's ambient spend", () => {
  const METERED_COMPLETE = {
    wallMs: 5,
    tokens: { outputVisible: 40, outputKnown: 40, totalKnown: 40 },
    completeness: "complete" as const,
    billingMode: "metered" as const,
  };
  const METERED_INCOMPLETE = {
    ...METERED_COMPLETE,
    completeness: "unavailable" as const,
  };

  function degradingHarness(options: {
    readonly env: Record<string, string>;
    readonly ledger: SpyLedger;
    readonly reservesSpend: boolean;
    readonly usage?: TransportOutcome["usage"];
  }) {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker(
      new CredentialProjectionError("missing_subscription_record"),
    );
    return {
      requests,
      harness: new StepExecutionHarness({
        transport: meteredTransport(
          requests,
          options.usage ?? METERED_COMPLETE,
        ),
        spawnFn: (() => ({
          exited: Promise.resolve(0),
        })) as unknown as typeof Bun.spawn,
        childEnv: options.env,
        credentialBroker: broker,
        spendLedger: options.ledger,
        reservesSpend: options.reservesSpend,
        degradedProjectionBucketId: "mirrored-metered-bucket",
      }),
    };
  }

  test("degraded + ambient key, incomplete usage → unresolved → the bucket is fenced and a subsequent paid attempt on it is refused", async () => {
    const ledger = new SpyLedger();
    const { harness } = degradingHarness({
      env: { HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ambient" },
      ledger,
      reservesSpend: false,
      usage: METERED_INCOMPLETE,
    });
    const result = await runStep(harness);
    expect(result.reservations).toHaveLength(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");

    // The next paid attempt on the SAME (mirrored) bucket — a second,
    // independently degraded run sharing the SAME ledger — is refused
    // before its transport ever runs.
    const second = degradingHarness({
      env: { HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ambient" },
      ledger,
      reservesSpend: false,
      usage: METERED_INCOMPLETE,
    });
    const secondResult = await runStep(second.harness);
    expect(secondResult.status).toBe("failed");
    expect(secondResult.stderrTail).toContain("fenced");
    expect(second.requests).toHaveLength(0);
  });

  test("degraded + ambient key, complete usage → the reservation settles", async () => {
    const ledger = new SpyLedger();
    const { harness } = degradingHarness({
      env: { HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ambient" },
      ledger,
      reservesSpend: false,
    });
    const result = await runStep(harness);
    expect(result.reservations?.[0]?.state).toBe("settled");
  });

  test("degraded + no ambient key → no reservation", async () => {
    const ledger = new SpyLedger();
    const { harness } = degradingHarness({
      env: { HOME: "/tmp" },
      ledger,
      reservesSpend: false,
    });
    const result = await runStep(harness);
    expect(result.status).toBe("ok");
    expect(ledger.reserveCalls).toHaveLength(0);
    expect(result.reservations).toBeUndefined();
  });

  // Successful projection (not degraded): `buildChildEnv` strips the
  // ambient key before the child ever sees it, so even though the ledger IS
  // configured, `envBillsMetered` on the STRIPPED env is false and
  // `projectionDegraded` itself is false too — unchanged from before #279.
  test("successful projection + ambient key → the key is stripped and no reservation opens", async () => {
    const ledger = new SpyLedger();
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker();
    const harness = new StepExecutionHarness({
      transport: meteredTransport(requests, METERED_COMPLETE),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: { HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ambient" },
      credentialBroker: broker,
      spendLedger: ledger,
      reservesSpend: false,
      degradedProjectionBucketId: "mirrored-metered-bucket",
    });
    const result = await runStep(harness);
    expect(result.status).toBe("ok");
    expect(envBillsMetered(requests[0]?.isolation.env ?? {})).toBe(false);
    expect(ledger.reserveCalls).toHaveLength(0);
    expect(result.reservations).toBeUndefined();
  });

  // `reservesSpend: true` models a metered/free binding — unaffected by
  // #279, and structurally never degraded in production (a metered/free
  // claude-code binding never gets a `credentialBroker` attached at all —
  // `credentialKindForRoute`, runner-authority.ts: a broker's presence is
  // what forces the subscription kind in the first place). This test still
  // wires BOTH conditions true at once — the one shape production cannot
  // reach — specifically to prove the harness's reserve gate is an `||`,
  // not two independent reserves: a mutant with a separate `if` per
  // condition would call `reserve()` twice here, and this test would catch
  // it.
  test("a binding that already reserves (reservesSpend: true) reserves exactly once per attempt, even alongside a degraded ambient key", async () => {
    const ledger = new SpyLedger();
    const { harness } = degradingHarness({
      env: { HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ambient" },
      ledger,
      reservesSpend: true,
    });
    const result = await runStep(harness);
    expect(result.status).toBe("ok");
    expect(ledger.reserveCalls).toHaveLength(1);
    // The BINDING's own bucket (the harness's default, since this test does
    // not configure `rateLimitBucketId`) — never the degraded-mirror bucket,
    // because `reservesSpend: true` takes precedence in the bucket choice.
    expect(ledger.reserveCalls[0]?.bucketId).toBe("default");
    expect(result.reservations).toHaveLength(1);
  });

  // pr-hero review follow-up on this same slice (parent-verified): a
  // `reservesSpend: false` harness with a `spendLedger` but no
  // `degradedProjectionBucketId` used to silently fence the wrong bucket
  // (`rateLimitBucketId` — the binding's OWN, e.g. subscription, bucket) the
  // first time a degraded reservation opened. Dead in production (it always
  // computes and passes the mirrored bucket), but constructible by any
  // other caller. The fix makes that shape impossible to build at all.
  test("constructing reservesSpend:false + spendLedger WITHOUT degradedProjectionBucketId throws immediately", () => {
    expect(
      () =>
        new StepExecutionHarness({
          spendLedger: new InMemorySpendLedger(),
          reservesSpend: false,
          // degradedProjectionBucketId intentionally omitted.
        }),
    ).toThrow(/degradedProjectionBucketId/);
  });

  // The three shapes that must NOT throw: no ledger at all (ledger-free),
  // `reservesSpend: true` (the binding reserves into its own bucket, the
  // degraded-fence branch is never taken), and `reservesSpend: false` WITH
  // the bucket supplied (the one construction production actually uses).
  test("every OTHER spendLedger shape still constructs fine", () => {
    expect(() => new StepExecutionHarness({})).not.toThrow();
    expect(
      () =>
        new StepExecutionHarness({
          spendLedger: new InMemorySpendLedger(),
          reservesSpend: true,
        }),
    ).not.toThrow();
    expect(
      () =>
        new StepExecutionHarness({
          spendLedger: new InMemorySpendLedger(),
          reservesSpend: false,
          degradedProjectionBucketId: "mirrored-metered-bucket",
        }),
    ).not.toThrow();
  });

  // pr-hero review follow-up: the metered-accounting CLAIM ("this attempt
  // reserves against the spend ledger...") must describe a reservation that
  // ACTUALLY opened, never one merely intended. `admitAndExecute` can return
  // with `attempts: 0` and no reservation at all — an unreadable system
  // prompt is one such early return, checked BEFORE the admission gate/
  // retry loop ever runs — and the degrade itself already happened in
  // `run()`, before any of that. The base degrade warning is still owed
  // (the projection DID degrade); the reserve/fence claim is not (nothing
  // was reserved).
  test("degraded + ambient key + a zero-attempt early return → the degrade warning is stated, the reserve/fence claim is not", async () => {
    const ledger = new SpyLedger();
    const { harness } = degradingHarness({
      env: { HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ambient" },
      ledger,
      reservesSpend: false,
    });
    const result = await harness.run({
      name: "cred-probe-unreadable-prompt",
      systemPromptPath: "/nonexistent/pr-hero-279-system-prompt.md",
      prompt: "p",
      tools: [],
      model: "sonnet",
      effort: "high",
      cwd: "/tmp/ws",
      outPath: `/tmp/cred-probe-279-${Date.now()}.json`,
      mcpConfigPath: "/tmp/mcp.json",
      timeoutMs: 1000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
    });
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(result.reservations).toBeUndefined();
    expect(ledger.reserveCalls).toHaveLength(0);
    // The degrade itself is real and still stated.
    expect(result.stderrTail).toContain("missing_subscription_record");
    // The reserve/fence claim is NOT — nothing was reserved for a step that
    // never reached `runAttempt`.
    expect(result.stderrTail).not.toContain("ambient credential bills metered");
    expect(result.stderrTail).not.toContain(
      "reserves against the spend ledger",
    );
  });
});
