// S7 (odd/tasks/model-profiles.md): a failed OpenCode attempt names the CRYSK_OPENCODE_*
// secret its route ran on (TransportOutcome.failureCredential), so the CI fix can say
// which secret to replace, and a provider's 401 refusal is a rejected credential.
import { describe, expect, test } from "bun:test";
import type {
  CredentialKind,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import { resolveFailureCause } from "../../src/execution/failure-policy";
import { createDefaultTransportRegistry } from "../../src/transport-registry";
import {
  formatProviderRefusalDetail,
  OpenCodeSdkTransport,
} from "../../src/transports/opencode-sdk";

const REQUEST = {
  sessionId: "oc-failure-credential",
  attempt: 1,
  route: {
    backend: "opencode",
    provider: "deepseek",
    modelFamily: "deepseek-chat",
    modelSnapshot: "deepseek-chat",
  },
  executionModel: "deepseek-chat",
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

const failingClient = {
  createSession: async () => {
    throw new Error("401 unauthorized");
  },
  streamEvents: async function* () {},
  pollStatus: async () => ({ kind: "pending" }) as const,
  abort: async () => {},
};

function transportFor(
  provider: string | undefined,
  credentialKind?: CredentialKind,
): OpenCodeSdkTransport {
  const registry = createDefaultTransportRegistry({
    mode: "conformance",
    sdkVersion: "1.18.25",
    serverVersion: "1.18.30",
    openCodeClient: failingClient,
    ...(credentialKind === undefined ? {} : { credentialKind }),
    ...(provider === undefined
      ? {}
      : {
          route: {
            backend: "opencode",
            provider,
            modelFamily: "m",
            modelSnapshot: "m",
          },
        }),
  } as never);
  return registry.get("opencode") as OpenCodeSdkTransport;
}

async function failedOutcome(
  transport: OpenCodeSdkTransport,
): Promise<TransportOutcome> {
  return await transport.execute(REQUEST, {
    signal: new AbortController().signal,
    events: { push: async () => "accepted" } as never,
  });
}

describe("the factory names the secret an OpenCode route runs on", () => {
  test("an API-key route's failure names CRYSK_OPENCODE_<P>_API_KEY", async () => {
    const outcome = await failedOutcome(
      transportFor("deepseek", "provider_api_token"),
    );
    expect(outcome.completion).toBe("failed");
    expect(outcome.failureCredential).toBe(
      "CRYSK_OPENCODE_DEEPSEEK_API_KEY" as never,
    );
  });

  test("an OpenAI subscription route's failure names CRYSK_OPENCODE_OPENAI_OAUTH", async () => {
    const outcome = await failedOutcome(
      transportFor("openai", "opencode_chatgpt_oauth"),
    );
    expect(outcome.failureCredential).toBe(
      "CRYSK_OPENCODE_OPENAI_OAUTH" as never,
    );
  });

  test("a free route, or one whose kind is unknown, names no secret", async () => {
    expect(
      (await failedOutcome(transportFor("opencode", "provider_free")))
        .failureCredential,
    ).toBeUndefined();
    expect(
      (await failedOutcome(transportFor("deepseek"))).failureCredential,
    ).toBeUndefined();
    expect(
      (await failedOutcome(transportFor(undefined, "provider_api_token")))
        .failureCredential,
    ).toBeUndefined();
  });
});

describe("classifyFailure: a provider's 401 refusal is a rejected credential", () => {
  const transport = new OpenCodeSdkTransport({ client: failingClient });
  const outcomeWith = (stderrTail: string): TransportOutcome =>
    ({
      completion: "failed",
      protocolIntegrity: "unverified",
      finalText: "",
      stderrTail,
      usage: {},
    }) as unknown as TransportOutcome;

  // OpenAI's own 401 text: none of the generic auth words, so before S7 the refusal
  // marker filed it runtime_unavailable and the PR got the generic hunters text.
  test("status=401 with the provider's own words classifies auth_invalid", () => {
    const witness = formatProviderRefusalDetail({
      name: "APIError",
      statusCode: 401,
      retryable: false,
      message:
        "Incorrect API key provided: sk-xx. You can find your API key at https://platform.openai.com/account/api-keys.",
    });
    expect(transport.classifyFailure(outcomeWith(witness))).toBe(
      "auth_invalid",
    );
    expect(
      resolveFailureCause({
        outcome: outcomeWith(witness),
        classifyFailure: (outcome: TransportOutcome) =>
          transport.classifyFailure(outcome),
        parseThrew: false,
      } as never),
    ).toEqual({ kind: "cause", cause: "auth_invalid" });
  });

  test("other refusals keep their previous causes", () => {
    const refusal = (statusCode: number | undefined, retryable: boolean) =>
      transport.classifyFailure(
        outcomeWith(
          formatProviderRefusalDetail({
            name: "APIError",
            ...(statusCode === undefined ? {} : { statusCode }),
            retryable,
            message: "something went wrong",
          }),
        ),
      );
    expect(refusal(404, false)).toBe("model_unavailable");
    expect(refusal(403, false)).toBe("runtime_unavailable");
    expect(refusal(undefined, false)).toBe("runtime_unavailable");
    expect(refusal(400, true)).toBe("network_transient");
  });
});
