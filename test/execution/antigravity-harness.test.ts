// odd/tasks/antigravity-oauth.md T3 (S5): an antigravity step's credential
// projection fails closed (it never degrades to the operator's environment),
// and the harness never labels an antigravity route claude/anthropic.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderTransport,
  ResolvedModelRoute,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import type { CredentialKind } from "../../src/model/provider-capabilities";
import {
  type CredentialBroker,
  type CredentialProjection,
  CredentialProjectionError,
} from "../../src/security/credential-broker";

class ThrowingBroker implements CredentialBroker {
  projectCalls = 0;
  constructor(private readonly error: Error) {}
  async project(): Promise<CredentialProjection> {
    this.projectCalls++;
    throw this.error;
  }
}

function okOutcome(): TransportOutcome {
  return {
    completion: "success",
    protocolIntegrity: "verified",
    finalText: "{}",
    usage: {
      wallMs: 0,
      tokens: {},
      completeness: "complete",
      billingMode: "subscription",
      costSource: "provider",
      cashCostUsd: 0,
    },
    stderrTail: "",
  };
}

function transportFor(
  backend: ProviderTransport["backend"],
  requests: TransportRequest[],
  declared: boolean,
): ProviderTransport {
  return {
    backend,
    ...(declared
      ? {
          admissionIdentity: { executable: "agy", provider: "google" },
          cancellationSemantics: "process-exit" as const,
        }
      : {}),
    capabilities: async () => {
      throw new Error("not used");
    },
    classifyFailure: () => undefined,
    async execute(request) {
      requests.push(request);
      return okOutcome();
    },
  };
}

const AGY_ROUTE: ResolvedModelRoute = {
  backend: "antigravity",
  provider: "google",
  modelFamily: "gemini-4-argon-high",
  modelSnapshot: "gemini-4-argon-high",
};

function harnessWith(
  transport: ProviderTransport,
  broker: CredentialBroker | undefined,
  spawned: { count: number },
  admitted: { count: number },
) {
  return new StepExecutionHarness({
    transport,
    spawnFn: (() => {
      spawned.count++;
      return { exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn,
    childEnv: { HOME: "/Users/operator-real-home", PATH: "/usr/bin:/bin" },
    admissionGate: {
      admit: () => {
        admitted.count++;
      },
    },
    ...(broker === undefined ? {} : { credentialBroker: broker }),
  });
}

async function runStep(
  harness: StepExecutionHarness,
  extra: {
    route?: ResolvedModelRoute;
    credentialKind?: CredentialKind;
  } = {},
) {
  const promptDir = await mkdtemp(path.join(tmpdir(), "crysk-agy-harness-"));
  const systemPromptPath = path.join(promptDir, "system.md");
  await Bun.write(systemPromptPath, "system prompt");
  try {
    return await harness.run({
      name: "agy-probe",
      systemPromptPath,
      prompt: "p",
      tools: [],
      model: "gemini-4-argon-high",
      effort: "high",
      cwd: "/tmp/ws",
      outPath: path.join(promptDir, "out.json"),
      mcpConfigPath: "/tmp/mcp.json",
      timeoutMs: 1000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
      ...(extra.route === undefined ? {} : { route: extra.route }),
      ...(extra.credentialKind === undefined
        ? {}
        : { credentialKind: extra.credentialKind }),
    });
  } finally {
    await rm(promptDir, { recursive: true, force: true });
  }
}

describe("an antigravity projection failure refuses the step (S5)", () => {
  for (const error of [
    // The class the harness degrades for Claude: never for antigravity.
    new CredentialProjectionError("missing_subscription_record"),
    new CredentialProjectionError("source_read_failed"),
    new CredentialProjectionError("malformed_payload"),
    new Error("third-party broker text with a token AT-SECRET-fake"),
  ]) {
    const label =
      error instanceof CredentialProjectionError
        ? error.failureClass
        : "broker_error";
    test(`${label}: no operator environment, no admission, no spawn`, async () => {
      const requests: TransportRequest[] = [];
      const spawned = { count: 0 };
      const admitted = { count: 0 };
      const broker = new ThrowingBroker(error);
      const result = await runStep(
        harnessWith(
          transportFor("antigravity", requests, true),
          broker,
          spawned,
          admitted,
        ),
        {
          route: AGY_ROUTE,
          credentialKind: "antigravity_subscription_oauth",
        },
      );
      expect(broker.projectCalls).toBe(1);
      expect(result.status).toBe("failed");
      expect(result.stderrTail).toBe(
        `Credential projection failed (${label}); step failed before any spawn`,
      );
      expect(result.stderrTail).not.toContain("operator environment");
      expect(result.stderrTail).not.toContain("SECRET");
      expect(requests.length).toBe(0);
      expect(admitted.count).toBe(0);
      expect(spawned.count).toBe(0);
    });
  }

  test("an antigravity transport refuses even when the step carries no credential kind", async () => {
    const requests: TransportRequest[] = [];
    const spawned = { count: 0 };
    const admitted = { count: 0 };
    const result = await runStep(
      harnessWith(
        transportFor("antigravity", requests, true),
        new ThrowingBroker(
          new CredentialProjectionError("missing_subscription_record"),
        ),
        spawned,
        admitted,
      ),
      { route: AGY_ROUTE },
    );
    expect(result.status).toBe("failed");
    expect(result.stderrTail).toBe(
      "Credential projection failed (missing_subscription_record); step failed before any spawn",
    );
    expect(requests.length).toBe(0);
    expect(admitted.count).toBe(0);
    expect(spawned.count).toBe(0);
  });

  test("a Claude step still degrades missing_subscription_record to the operator environment", async () => {
    const requests: TransportRequest[] = [];
    const spawned = { count: 0 };
    const admitted = { count: 0 };
    const result = await runStep(
      harnessWith(
        {
          ...transportFor("claude-code", requests, false),
        },
        new ThrowingBroker(
          new CredentialProjectionError("missing_subscription_record"),
        ),
        spawned,
        admitted,
      ),
    );
    expect(result.status).toBe("ok");
    expect(result.stderrTail).toContain("child runs with operator environment");
    expect(requests[0]?.isolation.env.HOME).toBe("/Users/operator-real-home");
  });
});

describe("the harness labels an antigravity route google (S5)", () => {
  test("a test transport with no declared identity admits a google route", async () => {
    const requests: TransportRequest[] = [];
    const result = await runStep(
      harnessWith(
        transportFor("antigravity", requests, false),
        undefined,
        { count: 0 },
        { count: 0 },
      ),
      { route: AGY_ROUTE },
    );
    expect(result.status).toBe("ok");
    expect(requests[0]?.route).toEqual(AGY_ROUTE);
  });

  test("with no route, the default route names google and the model, never claude", async () => {
    const requests: TransportRequest[] = [];
    const result = await runStep(
      harnessWith(
        transportFor("antigravity", requests, false),
        undefined,
        { count: 0 },
        { count: 0 },
      ),
    );
    expect(result.status).toBe("ok");
    expect(requests[0]?.route).toEqual({
      backend: "antigravity",
      provider: "google",
      modelFamily: "gemini-4-argon-high",
      modelSnapshot: "gemini-4-argon-high",
    });
  });

  test("a Claude test transport keeps its claude/anthropic default route", async () => {
    const requests: TransportRequest[] = [];
    await runStep(
      harnessWith(
        transportFor("claude-code", requests, false),
        undefined,
        { count: 0 },
        { count: 0 },
      ),
    );
    expect(requests[0]?.route).toEqual({
      backend: "claude-code",
      provider: "anthropic",
      modelFamily: "claude",
      modelSnapshot: "gemini-4-argon-high",
    });
  });
});
