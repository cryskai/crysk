import { describe, expect, test } from "bun:test";
import type { TransportRequest } from "../../src/execution/contracts";
import { resolveFailureCause } from "../../src/execution/failure-policy";
import { OpenCodeApiTokenBroker } from "../../src/security/credential-broker";
import { createOpenCodeClient } from "../../src/transports/opencode-client";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";
import { launchProjectedOpenCodeServer } from "../../src/transports/opencode-server";

// The live shape: an OpenCode route whose provider has no record in the auth store.
// The server is launched under a real broker, so the projection error is the typed
// CredentialProjectionError raised by OpenCodeApiTokenBroker.project, not a stub.
const PROVIDER = "no-such-model-free";

function transportWithMissingRecord(): OpenCodeSdkTransport {
  const client = createOpenCodeClient({
    loadSdk: async () => ({}) as never,
    readSystemPrompt: async () => "SYSTEM",
    model: { providerID: PROVIDER, modelID: "no-such-model" },
    launchServer: () =>
      launchProjectedOpenCodeServer({
        broker: new OpenCodeApiTokenBroker(PROVIDER, {
          readerFn: async () => "{}",
        }),
        credentialKind: "provider_api_token",
        verifiedBinaryPath: "/usr/bin/true",
      } as never),
  } as never);
  return new OpenCodeSdkTransport({ client });
}

const REQUEST = {
  sessionId: "oc-projection",
  attempt: 1,
  route: {
    backend: "opencode",
    provider: PROVIDER,
    modelFamily: "no-such-model",
    modelSnapshot: "no-such-model-free",
  },
  executionModel: "no-such-model-free",
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
} as unknown as TransportRequest;

describe("a credential projection the auth store cannot serve", () => {
  test("the attempt carries the typed cause missing_provider_record", async () => {
    const outcome = await transportWithMissingRecord().execute(REQUEST, {
      signal: new AbortController().signal,
      events: { push: () => {} } as never,
    });
    expect(outcome.completion).toBe("failed");
    expect(outcome.stderrTail).toContain(
      "Credential projection failed (missing_provider_record)",
    );
    expect(outcome.failureCause).toBe("missing_provider_record");
  });

  test("the typed cause beats the witness classifier", () => {
    const base = {
      completion: "failed" as const,
      protocolIntegrity: "unverified" as const,
      finalText: "",
      usage: {
        wallMs: 1,
        tokens: { inputUncached: 1 },
        completeness: "complete" as const,
        billingMode: "subscription" as const,
        costSource: "provider" as const,
        cashCostUsd: 0,
      },
      stderrTail:
        "[pr-hero] opencode sdk: session creation failed: Credential projection failed (missing_provider_record)",
    };
    const resolution = resolveFailureCause({
      outcome: { ...base, failureCause: "missing_provider_record" },
      classifyFailure: () => "runtime_unavailable",
      parseThrew: false,
    });
    expect(resolution).toEqual({
      kind: "cause",
      cause: "missing_provider_record",
    });
  });
});
