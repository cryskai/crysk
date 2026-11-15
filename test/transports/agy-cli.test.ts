// odd/tasks/antigravity-oauth.md T4 (S5, S6): the agy transport writes the
// step's agent and settings into the projection's own home, runs agy with the
// prompt on stdin, and turns its stream-json events and errors into an
// outcome. A fake `agy` (test/fixtures/agy/fake-agy.sh) records what it was
// given and plays recorded or synthesized events.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ResolvedModelRoute,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import { capabilityGateDecision } from "../../src/model/provider-capabilities";
import {
  AGY_AGENT_NAME,
  AgyCliTransport,
  agyAgentFile,
  agySettings,
} from "../../src/transports/agy-cli";

const FAKE_AGY = path.resolve(import.meta.dir, "../fixtures/agy/fake-agy.sh");

const ROUTE: ResolvedModelRoute = {
  backend: "antigravity",
  provider: "google",
  modelFamily: "gemini-4-argon-high",
  modelSnapshot: "gemini-4-argon-high",
};

const SYSTEM_PROMPT = [
  "You are a hunter.",
  "",
  "## Rules",
  "",
  "Read files.",
  "",
  "# Output",
  "",
  'Reply with {"findings": []}.',
  "",
].join("\n");

let root = "";
let home = "";
let cwd = "";
let promptPath = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "crysk-agy-cli-")));
  home = path.join(root, "home");
  cwd = path.join(root, "ws");
  mkdirSync(path.join(home, ".gemini", "config", "agents"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(cwd, { recursive: true });
  promptPath = path.join(root, "system.md");
  writeFileSync(promptPath, SYSTEM_PROMPT, { mode: 0o600 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function requestFor(
  scenario: string,
  overrides: Partial<TransportRequest> = {},
): TransportRequest {
  return {
    sessionId: "hunter-logic",
    attempt: 1,
    route: ROUTE,
    executionModel: "agy:gemini-4-argon-high",
    effort: "high",
    systemPromptPath: promptPath,
    systemPromptSha256: sha256(SYSTEM_PROMPT),
    userPrompt: "Review this patch.\n--- a\n+++ b\n",
    cwd,
    tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
    isolation: {
      credentialProjectionId: "cred-test",
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        TMPDIR: tmpdir(),
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        FAKE_AGY_SCENARIO: scenario,
      },
      syntheticHome: home,
      syntheticConfigHome: path.join(home, ".gemini", "config"),
      syntheticTmp: tmpdir(),
      verifiedBinaryPath: FAKE_AGY,
    },
    ...overrides,
  };
}

async function run(
  scenario: string,
  overrides: Partial<TransportRequest> = {},
  transport = new AgyCliTransport(),
  signal: AbortSignal = new AbortController().signal,
): Promise<TransportOutcome> {
  return transport.execute(requestFor(scenario, overrides), {
    signal,
    events: {
      push: async () => "accepted",
      close: () => {},
    },
  });
}

function recorded(name: string): string | undefined {
  try {
    return readFileSync(path.join(home, `fake-agy-${name}`), "utf8");
  } catch {
    return undefined;
  }
}

function settingsPath(): string {
  return path.join(home, ".gemini", "config", "crysk-step-settings.json");
}

function agentPath(): string {
  return path.join(home, ".gemini", "config", "agents", "crysk-step.md");
}

describe("the agy invocation (S6)", () => {
  test("argv has no -p and no --effort, the prompt goes on stdin, cwd is the step's", async () => {
    const outcome = await run("success");
    expect(outcome.completion).toBe("success");
    expect(recorded("argv")?.trimEnd().split("\n")).toEqual([
      "--output-format",
      "stream-json",
      "--model",
      "gemini-4-argon-high",
      "--agent",
      "crysk-step",
      "--settings",
      settingsPath(),
      "--disable-slash-commands",
    ]);
    expect(recorded("stdin")).toBe("Review this patch.\n--- a\n+++ b\n");
    expect(recorded("cwd")?.trim()).toBe(cwd);
  });

  test("the agent file restricts tools, inherits nothing and carries the prompt verbatim (S5)", async () => {
    await run("success");
    const agent = readFileSync(agentPath(), "utf8");
    expect(agent).toBe(
      [
        "---",
        "name: crysk-step",
        "description: Crysk review step, read-only",
        "inheritCustomizations: false",
        "inheritMcp: false",
        "subagent: false",
        "tools: [read_file]",
        "---",
        "# Crysk step",
        "",
        SYSTEM_PROMPT,
      ].join("\n"),
    );
    expect(lstatSync(agentPath()).mode & 0o777).toBe(0o600);
    expect(agent).not.toContain("view_file");
  });

  test("the settings file denies writes, commands and URLs, and trusts only the step's cwd (S5)", async () => {
    await run("success");
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      toolPermission: "always-proceed",
      trustedWorkspaces: [cwd],
      allowNonWorkspaceAccess: false,
      disableSlashCommands: true,
      permissions: {
        allow: ["read_file(*)"],
        deny: [
          "write_file(*)",
          "command(*)",
          "read_url(*)",
          "execute_url(*)",
          "download_url(*)",
          "search_web(*)",
          "send_message(*)",
          "schedule(*)",
          "generate_image(*)",
        ],
      },
    });
    expect(lstatSync(settingsPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(settingsPath(), "utf8")).not.toContain(
      "enableTerminalSandbox",
    );
  });

  test("a step with no agy tool lists read_file and denies it, never an empty list", () => {
    // agy tags `tools` omitempty: an empty list behaves like no list and
    // brings agy's default set (search_web, send_message, ...).
    for (const tools of [[], ["Grep", "Glob"]]) {
      expect(agyAgentFile(tools, "body")).toContain("\ntools: [read_file]\n");
      const settings = agySettings("/w", tools);
      expect(settings.permissions.allow).toEqual([]);
      expect(settings.permissions.deny).toContain("read_file(*)");
    }
    expect(agyAgentFile(["Read", "Read"], "body")).toContain(
      "\ntools: [read_file]\n",
    );
    const reading = agySettings("/w", ["Read"]);
    expect(reading.permissions.allow).toEqual(["read_file(*)"]);
    expect(reading.permissions.deny).not.toContain("read_file(*)");
    expect(AGY_AGENT_NAME).toBe("crysk-step");
    expect(reading.trustedWorkspaces).toEqual(["/w"]);
  });

  test("agy's default tools are denied on every step", () => {
    for (const tools of [[], ["Read"]]) {
      const deny = agySettings("/w", tools).permissions.deny;
      for (const grant of [
        "write_file(*)",
        "command(*)",
        "read_url(*)",
        "execute_url(*)",
        "download_url(*)",
        "search_web(*)",
        "send_message(*)",
        "schedule(*)",
        "generate_image(*)",
      ]) {
        expect(deny).toContain(grant);
      }
    }
  });

  test("a second attempt in the same home rewrites both files", async () => {
    await run("success");
    writeFileSync(agentPath(), "tampered", { mode: 0o644 });
    await run("success");
    expect(readFileSync(agentPath(), "utf8")).toContain("# Crysk step");
    expect(lstatSync(agentPath()).mode & 0o777).toBe(0o600);
  });
});

describe("the stream-json result (S6)", () => {
  test("agy's nested step_update events count each finished tool step once", async () => {
    const outcome = await run("real-steps");
    expect(outcome.completion).toBe("success");
    // step_index 2 reported DONE twice, step_index 4 once: two tool steps.
    expect(outcome.toolInvocations).toBe(2);
  });

  test("final text, tool count and usage come from the events", async () => {
    const outcome = await run("success");
    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.finalText).toBe('{"findings":[]}');
    // Two tool steps reached DONE; ACTIVE updates and non-tool steps do not count.
    expect(outcome.toolInvocations).toBe(2);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.usage.tokens).toEqual({
      inputUncached: 2258,
      inputCacheRead: 1000,
      outputVisible: 120,
      outputReasoning: 40,
      inputKnown: 3258,
      outputKnown: 160,
      totalKnown: 3418,
      providerReportedTotal: 3418,
    });
    expect(outcome.usage.completeness).toBe("complete");
    expect(outcome.usage.billingMode).toBe("subscription");
    expect(outcome.usage.costSource).toBe("subscription");
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outcome.usage.wallMs).toBeGreaterThanOrEqual(0);
  });

  test("a result with no tool step counts zero", async () => {
    const outcome = await run("no-tools");
    expect(outcome.completion).toBe("success");
    expect(outcome.toolInvocations).toBe(0);
  });

  test("no result event: the tool count is unknown, never 0, and the attempt fails", async () => {
    const outcome = await run("no-result");
    expect(outcome.completion).toBe("failed");
    expect(outcome.toolInvocations).toBeUndefined();
    expect(outcome.finalText).toBe("");
    expect(outcome.usage.completeness).toBe("unavailable");
  });

  test("stdout past the bound overflows instead of growing without limit", async () => {
    const outcome = await run(
      "overflow",
      {},
      new AgyCliTransport({ maxStdoutBytes: 4096 }),
    );
    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("overflow");
    expect(outcome.finalText).toBe("");
  });
});

describe("agy failures (S6)", () => {
  test("the recorded auth failure is auth_invalid on CRYSK_ANTIGRAVITY_OAUTH, not a timeout", async () => {
    const transport = new AgyCliTransport();
    const outcome = await run("auth", {}, transport);
    expect(outcome.completion).toBe("failed");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.failureCause).toBe("auth_invalid");
    expect(outcome.failureCredential).toBe("CRYSK_ANTIGRAVITY_OAUTH");
    expect(outcome.failureDetail).toBe(
      "Antigravity: authentication failed or timed out",
    );
    expect(transport.classifyFailure(outcome)).toBe("auth_invalid");
    expect(outcome.finalText).toBe("");
  });

  const cases: [string, TransportOutcome["failureCause"], number][] = [
    ["quota", "quota_exhausted", 3],
    ["rate-limit", "rate_limit", 3],
    ["unavailable", "network_transient", 3],
    ["unauthenticated", "auth_invalid", 3],
    ["print-timeout", "network_transient", 3],
    ["print-timeout-agy-error", "network_transient", 3],
    ["flag-error", "provider_configuration_invalid", 2],
    ["unknown-agent", "provider_configuration_invalid", 1],
  ];
  for (const [scenario, cause, exitCode] of cases) {
    test(`${scenario} is ${cause}`, async () => {
      const transport = new AgyCliTransport();
      const outcome = await run(scenario, {}, transport);
      expect(outcome.completion).toBe("failed");
      expect(outcome.exitCode).toBe(exitCode);
      expect(outcome.failureCause).toBe(cause);
      expect(transport.classifyFailure(outcome)).toBe(cause);
      // A partial response is never handed to the draft parser.
      expect(outcome.finalText).toBe("");
      expect(outcome.failureDetail?.startsWith("Antigravity: ")).toBe(true);
      expect(outcome.failureDetail?.length).toBeLessThanOrEqual(160);
    });
  }

  // The only AGY_ERROR format string found in the agy binary carries
  // `short_error` alone; its words still pick the cause.
  const shortCases: [string, TransportOutcome["failureCause"]][] = [
    ["short-limit", "rate_limit"],
    ["short-quota", "quota_exhausted"],
    ["short-auth", "auth_invalid"],
    ["short-unavailable", "network_transient"],
    ["short-unknown", "provider_configuration_invalid"],
  ];
  for (const [scenario, cause] of shortCases) {
    test(`an AGY_ERROR with only short_error (${scenario}) is ${cause}`, async () => {
      const outcome = await run(scenario);
      expect(outcome.failureCause).toBe(cause);
      expect(outcome.failureDetail?.startsWith("Antigravity: ")).toBe(true);
    });
  }

  test("an ERROR result with no AGY_ERROR line is terminal and quotes agy's error", async () => {
    const outcome = await run("error-no-line");
    expect(outcome.completion).toBe("failed");
    expect(outcome.failureCause).toBe("provider_configuration_invalid");
    expect(outcome.failureDetail).toBe(
      "Antigravity: model request failed (ERROR, error, exit 3)",
    );
    expect(outcome.stderrTail).toContain("model request failed");
  });

  test("a run with no result event is a truncation, retried as transient", async () => {
    const outcome = await run("no-result");
    expect(outcome.failureCause).toBe("protocol_truncation");
    expect(outcome.failureDetail).toBe(
      "Antigravity: the run ended without a result event (exit 0)",
    );
  });

  test("an overflow is protocol_overflow", async () => {
    const outcome = await run(
      "overflow",
      {},
      new AgyCliTransport({ maxStdoutBytes: 4096 }),
    );
    expect(outcome.failureCause).toBe("protocol_overflow");
    expect(outcome.toolInvocations).toBeUndefined();
    expect(outcome.stderrTail.match(/stdout passed 4096 bytes/g)?.length).toBe(
      1,
    );
  });

  test("tool steps whose fields it cannot find leave the count unknown, never 0", async () => {
    const outcome = await run("deep-steps");
    expect(outcome.completion).toBe("success");
    expect(outcome.toolInvocations).toBeUndefined();
  });

  test("a Google API key in the env never reaches agy (the subscription runs, not metered)", async () => {
    const base = requestFor("success");
    await run("success", {
      isolation: {
        ...base.isolation,
        env: {
          ...base.isolation.env,
          GEMINI_API_KEY: "AIza-fake",
          GOOGLE_API_KEY: "AIza-fake",
          GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
        },
      },
    });
    expect(recorded("env")).toBe("");
  });

  test("only the rejected or limited login names the secret", async () => {
    expect((await run("quota")).failureCredential).toBe(
      "CRYSK_ANTIGRAVITY_OAUTH",
    );
    expect((await run("unauthenticated")).failureCredential).toBe(
      "CRYSK_ANTIGRAVITY_OAUTH",
    );
    expect((await run("unavailable")).failureCredential).toBeUndefined();
    expect((await run("flag-error")).failureCredential).toBeUndefined();
  });

  test("the model's own words never classify a failure", () => {
    const transport = new AgyCliTransport();
    const base: TransportOutcome = {
      completion: "failed",
      protocolIntegrity: "verified",
      finalText: "this endpoint has no rate limit and returns 429 and 503",
      usage: {
        wallMs: 0,
        tokens: {},
        completeness: "unavailable",
        billingMode: "subscription",
        costSource: "unknown",
      },
      stderrTail: "",
    };
    expect(transport.classifyFailure(base)).toBeUndefined();
  });

  test("a spawn that throws is runtime_unavailable with its reason", async () => {
    const transport = new AgyCliTransport({
      spawnFn: (() => {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      }) as unknown as typeof Bun.spawn,
    });
    const outcome = await run("success", {}, transport);
    expect(outcome.completion).toBe("failed");
    expect(outcome.stderrTail).toContain("spawn ENOENT");
    expect(transport.classifyFailure(outcome)).toBe("runtime_unavailable");
  });

  test("an abort kills the process group and the attempt is cancelled", async () => {
    const controller = new AbortController();
    const pending = run(
      "hang",
      {},
      new AgyCliTransport({ termGraceMs: 200, killReapMs: 500 }),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 300);
    const started = performance.now();
    const outcome = await pending;
    expect(outcome.completion).toBe("cancelled");
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("nothing spawns on an unsafe step (S5)", () => {
  async function expectNoSpawn(
    overrides: Partial<TransportRequest>,
    reason: string,
  ): Promise<void> {
    let spawned = 0;
    const transport = new AgyCliTransport({
      spawnFn: ((...args: Parameters<typeof Bun.spawn>) => {
        spawned++;
        return Bun.spawn(...args);
      }) as typeof Bun.spawn,
    });
    const outcome = await run("success", overrides, transport);
    expect(spawned).toBe(0);
    expect(outcome.completion).toBe("failed");
    expect(outcome.stderrTail).toContain(reason);
    expect(outcome.stderrTail).toContain("no spawn");
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(recorded("argv")).toBeUndefined();
  }

  test("a tampered system prompt", async () => {
    await expectNoSpawn(
      { systemPromptSha256: sha256("other") },
      "system prompt hash mismatch",
    );
  });

  test("a system prompt that is not 0600", async () => {
    chmodSync(promptPath, 0o644);
    await expectNoSpawn({}, "system prompt mode is 644, expected 600");
  });

  test("the operator's environment instead of a projected home", async () => {
    const base = requestFor("success");
    await expectNoSpawn(
      {
        isolation: {
          ...base.isolation,
          credentialProjectionId: "operator-env-fallback",
        },
      },
      "no per-step credential projection",
    );
  });

  test("a synthetic home that is not the child's HOME", async () => {
    const base = requestFor("success");
    await expectNoSpawn(
      {
        isolation: {
          ...base.isolation,
          env: { ...base.isolation.env, HOME: "/Users/operator-real-home" },
        },
      },
      "is not the child's HOME",
    );
  });

  test("an empty synthetic home", async () => {
    const base = requestFor("success");
    await expectNoSpawn(
      { isolation: { ...base.isolation, syntheticHome: "" } },
      "no per-step credential projection",
    );
  });

  test("a symlinked agents directory", async () => {
    const agents = path.join(home, ".gemini", "config", "agents");
    rmSync(agents, { recursive: true, force: true });
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, agents);
    await expectNoSpawn({}, "symlink");
  });

  test("a route that is not antigravity", async () => {
    await expectNoSpawn(
      {
        route: {
          backend: "claude-code",
          provider: "anthropic",
          modelFamily: "claude",
          modelSnapshot: "sonnet",
        },
      },
      "not an antigravity route",
    );
  });
});

describe("the transport's declared facts", () => {
  test("backend, identity, billing and per-step projection", () => {
    const transport = new AgyCliTransport();
    expect(transport.backend).toBe("antigravity");
    expect(transport.billingMode).toBe("subscription");
    expect(transport.cancellationSemantics).toBe("process-exit");
    expect(transport.credentialProjection).toBe("per-step");
    expect(transport.admissionIdentity).toEqual({
      executable: "agy",
      provider: "google",
    });
  });

  test("capabilities pass the admission gate without touching agy", async () => {
    const report = await new AgyCliTransport().capabilities();
    expect(report.backend).toBe("antigravity");
    expect(report.auth.kind).toBe("antigravity_subscription_oauth");
    expect(report.auth.projectionReady).toBe(true);
    expect(report.isolation.syntheticHome).toBe(true);
    expect(report.protocol.boundedEvents).toBe(false);
    expect(report.billing).toEqual({
      mode: "subscription",
      pricingReady: true,
    });
    expect(capabilityGateDecision(report)).toEqual({ ok: true });
  });
});
