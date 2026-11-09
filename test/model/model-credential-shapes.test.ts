// odd/tasks/role-model-routing.md E-f F2 (L37, L39, D4): a Google, Groq or xAI
// key, or a long plain hex or base64 value, pasted where a model name or an
// effort goes is refused and never echoed. Fake keys are built here, never
// written out whole.
import { describe, expect, test } from "bun:test";
import {
  ModelNameError,
  parseModelName,
  parseModelsConfig,
} from "#model/model-name";

const GOOGLE_KEY = `AIza${"Sy0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT_-".padEnd(35, "x")}`;
const GROQ_KEY = `gsk_${"a1B2c3D4e5".repeat(5)}Zz`;
const XAI_KEY = `xai-${"Q9w8E7r6T5".repeat(8)}`;
const HEX_64 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const BASE64_KEY = "dGhpc0lzTm90QVJlYWxLZXlCdXRMb29rc0xpa2VPbmUxMjM0NTY3OA==";
const SECRETS = [GOOGLE_KEY, GROQ_KEY, XAI_KEY, HEX_64, BASE64_KEY];

const NAME_REFUSAL =
  "a model name looks like a credential, and credentials are not permitted in models";

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelNameError);
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

describe("a credential pasted as a model name (F2)", () => {
  test("the whole name is refused unseen", () => {
    for (const secret of SECRETS) {
      expect(messageOf(() => parseModelName(secret))).toBe(NAME_REFUSAL);
    }
  });

  test("as the model of an OpenCode name it is refused unseen", () => {
    for (const secret of SECRETS) {
      const message = messageOf(() =>
        parseModelName(`opencode:deepseek/${secret.replace(/=+$/, "")}`),
      );
      expect(message).toBe(NAME_REFUSAL);
    }
  });

  // An AWS-style secret: base64 with `/` and `+`, so no single segment is long.
  test("a base64 key that contains / and + is refused unseen", () => {
    const slashed = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    for (const raw of [
      `opencode:amazon-bedrock/${slashed}`,
      `opencode:${slashed}`,
      slashed,
    ]) {
      expect(messageOf(() => parseModelName(raw))).toBe(NAME_REFUSAL);
    }
  });

  test("a real model name with a key-like prefix still parses", () => {
    expect(parseModelName("opencode:xai/grok-4-fast").model).toBe(
      "grok-4-fast",
    );
    expect(
      parseModelName("opencode:openrouter/qwen/Qwen3-Coder-480B-A35B-Instruct")
        .model,
    ).toBe("qwen/Qwen3-Coder-480B-A35B-Instruct");
  });
});

describe("a credential pasted as an effort (F2)", () => {
  test("refused on an OpenCode and a Claude model, the value never echoed", () => {
    for (const model of ["opencode:openai/gpt-5", "claude:opus-latest"]) {
      for (const secret of SECRETS) {
        const message = messageOf(() =>
          parseModelsConfig({ default: [{ model, effort: secret }] }),
        );
        expect(message).toBe(
          "models.default[0]: the effort looks like a credential, and credentials are not permitted in models",
        );
      }
    }
  });
});

describe("the quote helper prints [REDACTED] for a whole credential-shaped value (F2)", () => {
  test("an unknown role", () => {
    for (const secret of [HEX_64, BASE64_KEY]) {
      const message = messageOf(() =>
        parseModelsConfig({ [secret]: ["claude:sonnet-latest"] }),
      );
      expect(message).toStartWith('models has an unknown role "[REDACTED]"');
      expect(message).not.toContain(secret);
    }
  });

  test("an unknown entry key", () => {
    const message = messageOf(() =>
      parseModelsConfig({
        default: [{ model: "claude:sonnet-latest", [HEX_64]: "x" }],
      }),
    );
    expect(message).toBe(
      'models.default[0] has an unknown key "[REDACTED]": an entry takes model and effort',
    );
  });

  // Touched existing behavior: an ordinary value is still quoted as written.
  test("an ordinary unknown role is still quoted as written", () => {
    expect(
      messageOf(() => parseModelsConfig({ hunters: ["claude:sonnet-latest"] })),
    ).toStartWith('models has an unknown role "hunters"');
  });
});
