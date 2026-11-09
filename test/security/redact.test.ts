import { describe, expect, test } from "bun:test";
import {
  looksLikeCredential,
  redactConfigValue,
  redactDiagnostic,
} from "../../src/security/redact";

describe("redactDiagnostic (§6.3 redaction-before-persistence)", () => {
  test("redacts Anthropic-style sk- keys", () => {
    expect(redactDiagnostic("auth failed for sk-a1B2c3D4e5F6g7H8")).toBe(
      "auth failed for [REDACTED]",
    );
  });

  test("redacts GitHub token families ghp/gho/ghu/ghs/ghr", () => {
    const token = `ghp_${"a1_".repeat(10)}`;
    expect(redactDiagnostic(`push denied: ${token}`)).toBe(
      "push denied: [REDACTED]",
    );
    for (const prefix of ["gho_", "ghu_", "ghs_", "ghr_"]) {
      expect(redactDiagnostic(`${prefix}${"z9".repeat(20)}`)).toBe(
        "[REDACTED]",
      );
    }
  });

  test("redacts Bearer authorization values case-insensitively", () => {
    expect(redactDiagnostic("authorization: Bearer abc.def.ghi")).toBe(
      "authorization: [REDACTED]",
    );
    expect(redactDiagnostic("AUTHORIZATION: bearer tok")).toBe(
      "AUTHORIZATION: [REDACTED]",
    );
  });

  test("redacts api_key/token/password assignments", () => {
    // \S+ in the binding pattern consumes up to the next whitespace, so a
    // JSON string's closing quote/brace is swallowed into the replacement.
    expect(redactDiagnostic('{"api_key": "supersecret123"}')).toBe(
      '{"[REDACTED]',
    );
    // The whole match — keyword included — becomes [REDACTED].
    expect(redactDiagnostic("password=hunter2")).toBe("[REDACTED]");
    expect(redactDiagnostic("token: abc123")).toBe("[REDACTED]");
  });

  // The keyword pattern read "token is" in "OAuth access token is invalid" as a token
  // assignment and printed "access [REDACTED] invalid", hiding the provider's sentence.
  test("ordinary prose that follows the keyword is not a secret", () => {
    for (const sentence of [
      "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
      "The API key was rejected by the provider",
      "your token has expired",
      "password must not be empty",
      "no api key provided",
    ]) {
      expect(redactDiagnostic(sentence)).toBe(sentence);
    }
  });

  // A value that starts with an allowed prose word is still a value: only trailing
  // sentence punctuation may be ignored, never digits or symbols (the verifier's probe).
  test("a prose word glued to digits or symbols is still redacted", () => {
    expect(redactDiagnostic("password is1234")).toBe("[REDACTED]");
    expect(redactDiagnostic("password can8472")).toBe("[REDACTED]");
    expect(redactDiagnostic("token no123!")).toBe("[REDACTED]");
    expect(redactDiagnostic("token to123")).toBe("[REDACTED]");
    expect(redactDiagnostic("your token has expired.")).toBe(
      "your token has expired.",
    );
  });

  test("a value after the keyword is still redacted, with or without a delimiter", () => {
    expect(redactDiagnostic("invalid token abc123def456")).toBe(
      "invalid [REDACTED]",
    );
    expect(redactDiagnostic("api key sk-ant-api03-AbCdEf123456")).toBe(
      "api key [REDACTED]",
    );
    expect(redactDiagnostic("the password swordfish was wrong")).toBe(
      "the [REDACTED] was wrong",
    );
    expect(redactDiagnostic("token: is")).toBe("[REDACTED]");
    expect(redactDiagnostic("rejected api_key=is")).toBe("rejected [REDACTED]");
    expect(redactDiagnostic("Authorization: Bearer abc.def")).toBe(
      "Authorization: [REDACTED]",
    );
  });

  test("near-misses are preserved verbatim", () => {
    // sk- needs >= 8 following chars; this has 7.
    expect(redactDiagnostic("sk-1234567")).toBe("sk-1234567");
    // ghp_ needs >= 20 following chars; this has 5.
    expect(redactDiagnostic("ghp_short")).toBe("ghp_short");
    // No separator/value after the keyword.
    expect(redactDiagnostic("tokenizer and passwordless flow")).toBe(
      "tokenizer and passwordless flow",
    );
    // Bearer without a value.
    expect(redactDiagnostic("Bearer")).toBe("Bearer");
  });

  test("redacts every occurrence in a combined diagnostic tail", () => {
    const text = [
      "error: request to provider failed",
      `sent key sk-zz9Z8Y7X6W5V and ghp_${"q".repeat(22)}`,
      "header was Bearer eyJhbGciOi",
      'config {"api-key":"abcd1234"}',
    ].join("\n");
    const redacted = redactDiagnostic(text);
    expect(redacted).not.toContain("sk-zz9Z8Y7X6W5V");
    expect(redacted).not.toContain("q".repeat(22));
    expect(redacted).not.toContain("eyJhbGciOi");
    expect(redacted).not.toContain("abcd1234");
    expect(redacted.split("[REDACTED]").length - 1).toBeGreaterThanOrEqual(4);
  });
});

// odd/tasks/role-model-routing.md E-f F2 (L37, L39, D4): Google, Groq and xAI key shapes
// are redacted everywhere; plain hex and base64 are not, because error output and logs
// carry commit SHAs and digests. Those are refused only where a whole config value is
// checked (looksLikeCredential). Fake keys are built here, never written out whole.
const GOOGLE_KEY = `AIza${"Sy0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT_-".padEnd(35, "x")}`;
const GROQ_KEY = `gsk_${"a1B2c3D4e5".repeat(5)}Zz`;
const XAI_KEY = `xai-${"Q9w8E7r6T5".repeat(8)}`;
const SHA1 = "1cb0127".padEnd(40, "a3f9");
const SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const BASE64_KEY = "dGhpc0lzTm90QVJlYWxLZXlCdXRMb29rc0xpa2VPbmUxMjM0NTY3OA==";

describe("redactDiagnostic: Google, Groq and xAI keys (F2)", () => {
  test("each key shape is redacted inside prose", () => {
    for (const key of [GOOGLE_KEY, GROQ_KEY, XAI_KEY]) {
      expect(redactDiagnostic(`provider refused ${key} at startup`)).toBe(
        "provider refused [REDACTED] at startup",
      );
    }
  });

  test("model and provider names that share a prefix are kept", () => {
    for (const text of [
      "opencode:xai/grok-4-fast",
      "opencode:openrouter/x-ai/grok-code-fast-1",
      "xai-grok-4 failed",
      "gsk_short",
      "AIzaShort",
    ]) {
      expect(redactDiagnostic(text)).toBe(text);
    }
  });

  test("commit SHAs and digests in error output survive (D4)", () => {
    const text = `checkout ${SHA1} failed; artifact sha256 ${SHA256} did not match`;
    expect(redactDiagnostic(text)).toBe(text);
    expect(redactDiagnostic(SHA256)).toBe(SHA256);
    expect(redactDiagnostic(BASE64_KEY)).toBe(BASE64_KEY);
  });
});

describe("looksLikeCredential: a whole config value (F2, D4)", () => {
  test("a key shape, a long hex or a long base64 value looks like a credential", () => {
    for (const value of [
      GOOGLE_KEY,
      GROQ_KEY,
      XAI_KEY,
      "sk-a1B2c3D4e5F6g7H8",
      SHA1,
      SHA256,
      SHA256.toUpperCase(),
      BASE64_KEY,
      BASE64_KEY.replace(/=+$/, ""),
    ]) {
      expect(looksLikeCredential(value)).toBe(true);
    }
  });

  test("model ids, variant names and short hex do not", () => {
    for (const value of [
      "sonnet-latest",
      "claude-sonnet-5-5",
      "Qwen3-Coder-480B-A35B-Instruct-FP8",
      "Llama-4-Maverick-17B-128E-Instruct-FP8",
      "global.anthropic.claude-haiku-4-5-20251001-v1",
      "deadbeef",
      "high",
      "xhigh",
      "thinking",
    ]) {
      expect(looksLikeCredential(value)).toBe(false);
    }
  });

  test("redactConfigValue prints [REDACTED] for the whole value, the rest as redactDiagnostic", () => {
    expect(redactConfigValue(SHA256)).toBe("[REDACTED]");
    expect(redactConfigValue(BASE64_KEY)).toBe("[REDACTED]");
    expect(redactConfigValue(`x ${GROQ_KEY}`)).toBe("x [REDACTED]");
    expect(redactConfigValue("unknown_key")).toBe("unknown_key");
  });
});
