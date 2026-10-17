import { describe, expect, test } from "bun:test";
import {
  formatProviderRefusalDetail,
  OpenCodeSdkTransport,
} from "../../src/transports/opencode-sdk";

// A provider refusal witness with a fixed `status=` slot, as the transport
// writes it. Only the slot decides the cause; the provider's own message is
// free text and must never steer it (#213).
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
};

function classify(detail: string) {
  const transport = new OpenCodeSdkTransport({ client: {} as never });
  return transport.classifyFailure({ ...base, stderrTail: detail });
}

describe("a provider refusal whose status is 404", () => {
  test("classifies as model_unavailable", () => {
    expect(
      classify(
        formatProviderRefusalDetail({
          name: "openai",
          statusCode: 404,
          retryable: false,
          message: "The model `gpt-9` does not exist",
        }),
      ),
    ).toBe("model_unavailable");
  });

  test("the status slot decides, not the message wording", () => {
    expect(
      classify(
        formatProviderRefusalDetail({
          name: "openai",
          statusCode: 403,
          retryable: false,
          message: "upstream said status=404 for another route",
        }),
      ),
    ).toBe("runtime_unavailable");
  });
});

describe("other refusal statuses keep their cause", () => {
  test("a 429 refusal stays rate_limit", () => {
    expect(
      classify(
        formatProviderRefusalDetail({
          name: "openai",
          statusCode: 429,
          retryable: false,
          message: "slow down",
        }),
      ),
    ).toBe("rate_limit");
  });

  test("a 500 refusal stays network_transient", () => {
    expect(
      classify(
        formatProviderRefusalDetail({
          name: "openai",
          statusCode: 500,
          retryable: false,
          message: "Unexpected server error",
        }),
      ),
    ).toBe("network_transient");
  });

  test("a 403 refusal stays runtime_unavailable", () => {
    expect(
      classify(
        formatProviderRefusalDetail({
          name: "openai",
          statusCode: 403,
          retryable: false,
          message: "forbidden",
        }),
      ),
    ).toBe("runtime_unavailable");
  });
});
