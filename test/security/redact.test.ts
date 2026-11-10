import { describe, expect, test } from "bun:test";
import { redactSessionText } from "../../src/execution/claude-session-trace";
import { redactEvidenceText } from "../../src/security/evidence-redaction";
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

// Audit R2 (odd/tasks/review-traces.md L25): shapes no redactor caught. Every
// fake credential is assembled here at run time, never written out whole, so
// secret scanning on push has nothing to match.
const PEM_BODY = `MIIEow${"Qk9mN2xZ".repeat(8)}`;
const PEM_KEY = [
  `-----BEGIN RSA ${"PRIVATE"} KEY-----`,
  PEM_BODY,
  `${"Zz8yWq".repeat(6)}==`,
  `-----END RSA ${"PRIVATE"} KEY-----`,
].join("\n");
const OPENSSH_KEY = [
  `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----`,
  PEM_BODY,
  `-----END OPENSSH ${"PRIVATE"} KEY-----`,
].join("\n");
const AWS_KEY_ID = `${"AKIA"}Q7W2E9R4T6Y1U3I5`;
const AWS_SESSION_KEY_ID = `${"ASIA"}Z8X7C6V5B4N3M2L1`;
const AWS_SECRET = `wJalrXUtnFEMI/K7MDENG/${"bPxRfiCY"}9q8w7e6r5t`;
const DB_PASSWORD = "Pw0rd-db-9f8e7d";
const STRIPE_LIVE = `${"sk_"}live_${"4eC39HqLyjWDarjt"}T1zdp7dc`;
const STRIPE_RESTRICTED = `${"rk_"}live_${"51HbX2eZvKYlo2C0"}aB9cD8eF`;
const JWT = [
  `${"eyJ"}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`,
  `${"eyJ"}zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ`,
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
].join(".");
const TOKEN_VALUE = `Zq81${"xR4vN7mB2kL9"}pQ3w`;

describe("redactEvidenceText: secret shapes (audit R2)", () => {
  test.each([
    [
      "a PEM private key block",
      `key:\n${PEM_KEY}\ndone`,
      "key:\n[REDACTED]\ndone",
    ],
    ["an OpenSSH private key block", OPENSSH_KEY, "[REDACTED]"],
    [
      "a PEM block cut before its END line",
      `-----BEGIN ${"PRIVATE"} KEY-----\n${PEM_BODY}`,
      "[REDACTED]",
    ],
    ["an AWS access key id", `id ${AWS_KEY_ID} used`, "id [REDACTED] used"],
    ["an AWS temporary key id", `id ${AWS_SESSION_KEY_ID}`, "id [REDACTED]"],
    [
      "an AWS secret in an env file",
      `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}\nAWS_REGION=us-east-1`,
      "AWS_SECRET_ACCESS_KEY=[REDACTED]\nAWS_REGION=us-east-1",
    ],
    [
      "an AWS secret in the credentials file",
      `aws_secret_access_key = ${AWS_SECRET}`,
      "aws_secret_access_key = [REDACTED]",
    ],
    [
      "a quoted client_secret",
      `{"client_id": "app", "client_secret": "${TOKEN_VALUE}"}`,
      '{"client_id": "app", "client_secret": "[REDACTED]"}',
    ],
    [
      "a postgres URL password",
      `postgres://app:${DB_PASSWORD}@db.internal:5432/app`,
      "postgres://[REDACTED]@db.internal:5432/app",
    ],
    [
      "a mysql URL password",
      `mysql://root:${DB_PASSWORD}@localhost/shop`,
      "mysql://[REDACTED]@localhost/shop",
    ],
    [
      "a mongodb+srv URL password",
      `uri: "mongodb+srv://svc:${DB_PASSWORD}@cluster0.example.net/db"`,
      'uri: "mongodb+srv://[REDACTED]@cluster0.example.net/db"',
    ],
    [
      "a redis URL with only a password",
      `redis://:${DB_PASSWORD}@cache:6379`,
      "redis://[REDACTED]@cache:6379",
    ],
    [
      "an amqp URL password",
      `amqp://guest:${DB_PASSWORD}@mq/vhost`,
      "amqp://[REDACTED]@mq/vhost",
    ],
    ["a Stripe live secret key", `stripe ${STRIPE_LIVE}`, "stripe [REDACTED]"],
    [
      "a Stripe restricted key",
      `stripe ${STRIPE_RESTRICTED}`,
      "stripe [REDACTED]",
    ],
    ["an unlabeled JWT", `cached ${JWT} here`, "cached [REDACTED] here"],
    [
      "a doubly escaped api_key",
      `{\\"api_key\\":\\"${TOKEN_VALUE}\\"}`,
      '{\\"api_key\\":\\"[REDACTED]\\"}',
    ],
  ])("%s is redacted", (_name, input, expected) => {
    expect(redactEvidenceText(input)).toBe(expected);
  });

  test.each([
    "apiToken",
    "github_token",
    "authToken",
    "npm_token",
    "private_key",
    "client_secret",
    "x-api-key",
    "SECRET_KEY_BASE",
  ])("a quoted %s value is redacted and the JSON still parses", (name) => {
    const out = redactEvidenceText(JSON.stringify({ [name]: TOKEN_VALUE }));
    expect(JSON.parse(out)).toEqual({ [name]: "[REDACTED]" });
  });

  test.each([
    ['"input_tokens": 1234, "cache_read_input_tokens": 99'],
    ['"max_tokens": "4096"'],
    ['"token_type": "Bearer"'],
    ['"sessionId": "11111111-1111-4111-8111-111111111111"'],
    ["const tokenCount = usage.total;"],
    ["apiKeySource: environment"],
    ["const privateKey = loadKey(path);"],
    ["postgres://db.internal:5432/app"],
    ["git+ssh://git@github.com/cryskai/crysk.git"],
    [
      "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----",
    ],
    ["author: Juan, sk_live_ is the Stripe prefix"],
    ["the eyJ prefix starts a base64 JSON header"],
    ["AWS_REGION=us-east-1 TOKEN_COUNT=12"],
  ])("ordinary text is kept: %s", (text) => {
    expect(redactEvidenceText(text)).toBe(text);
  });

  test.each([
    PEM_KEY,
    `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`,
    `postgres://app:${DB_PASSWORD}@db/app`,
    `"apiToken": "${TOKEN_VALUE}"`,
    `{\\"api_key\\":\\"${TOKEN_VALUE}\\"}`,
    `${JWT} ${STRIPE_LIVE} ${AWS_KEY_ID}`,
  ])("redacting twice gives the same text (%#)", (text) => {
    const once = redactEvidenceText(text);
    expect(redactEvidenceText(once)).toBe(once);
  });
});

// V1 (odd/tasks/review-traces.md): a workflow file a hunter Read lost every
// line that names a token or a secret, though none of its values can be one.
// A value that is a GitHub Actions expression, a permission word, a
// placeholder, an environment reference, a boolean or a small number is kept.
describe("redactEvidenceText: values that cannot be secrets", () => {
  test.each([
    ["a permission word", "permissions:\n  id-token: write\n  contents: read"],
    ["a permission none", "id-token: none"],
    ["inherited secrets", "    secrets: inherit"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
    ["a GitHub expression", "github-token: ${{ github.token }}"],
    [
      "a secret passed by expression",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
      "CRYSK_CLAUDE_API_KEY=${{ secrets.CRYSK_CLAUDE_API_KEY }}",
    ],
    [
      "an expression holding quotes",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
      "CRYSK_X_API_KEY=${{ secrets[format('CRYSK_{0}_API_KEY', inputs.p)] }}",
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
    ["a quoted expression", '"api_key": "${{ secrets.API_KEY }}"'],
    ["a YAML block scalar", "crysk-secrets: |"],
    ["a section whose next line is a key", "secrets:\n  CRYSK_X: inherit"],
    ["an angle-bracket placeholder", "api_key: <your-api-key>"],
    ["an x placeholder", "API_TOKEN=xxxxxxxx"],
    ["a starred placeholder", 'password: "***"'],
    ["changeme", "SECRET_KEY=changeme"],
    ["a shell variable", "GITHUB_TOKEN=$GITHUB_TOKEN"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
    ["a braced shell variable", "GITHUB_TOKEN=${GITHUB_TOKEN}"],
    ["a process.env reference", "apiKey: process.env.ANTHROPIC_API_KEY"],
    ["a boolean", "id-token: false"],
    ["a small number", "refresh_token: 0"],
  ])("%s is kept", (_name, text) => {
    expect(redactEvidenceText(text)).toBe(text);
  });

  test.each([
    ["a numeric PIN", "password=1234", "password=[REDACTED]"],
    [
      "a YAML value on the line after its key",
      `password:\n  ${TOKEN_VALUE}`,
      "password:\n  [REDACTED]",
    ],
    [
      "a key on the line after a secrets: section",
      `secrets:\n  API_TOKEN: ${TOKEN_VALUE}`,
      "secrets:\n  API_TOKEN: [REDACTED]",
    ],
    [
      "text after a closed expression",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
      '"api_key": "${{ x }}literal }}"',
      '"api_key": "[REDACTED]"',
    ],
    [
      "a permission word with more after it",
      "token: write-abc123",
      "token: [REDACTED]",
    ],
    [
      "a dollar sign that starts a password",
      "password: $ecret1",
      "password: [REDACTED]",
    ],
    [
      "a long number under a key name",
      "API_KEY=123456789012345678",
      "API_KEY=[REDACTED]",
    ],
    [
      "a placeholder word inside a value",
      "api_key=xxxabc123",
      "api_key=[REDACTED]",
    ],
  ])("%s is still redacted", (_name, text, expected) => {
    expect(redactEvidenceText(text)).toBe(expected);
  });
});

// The trace's redactor (redactSessionText) adds wider session names (auth,
// oauth, credential, session) and reads camelCase unquoted names.
describe("redactSessionText: values that cannot be secrets", () => {
  test.each([
    [
      "an OAuth secret passed by expression",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
      "CRYSK_OPENCODE_OPENAI_OAUTH=${{ secrets.CRYSK_OPENCODE_OPENAI_OAUTH }}",
    ],
    ["a YAML block scalar", "          crysk-secrets: |"],
    ["a credential placeholder", "credentials: <path-to-credentials>"],
    [
      "a camelCase secret from the environment",
      "clientSecret: process.env.CLIENT_SECRET",
    ],
  ])("%s is kept", (_name, text) => {
    expect(redactSessionText(text)).toBe(text);
  });

  test("a camelCase secret with a literal value is still redacted", () => {
    expect(redactSessionText(`clientSecret: ${TOKEN_VALUE}`)).toBe(
      "clientSecret: [REDACTED]",
    );
  });
});

// A sandbox trace showed `id-[REDACTED]` for `id-token: write` and
// `github-[REDACTED] github.[REDACTED]` for `github-token: ${{ github.token }}`:
// redactDiagnostic's keyword rule read a workflow file a hunter Read as a list
// of credentials. The trace keeps its own copy of that rule, and redactDiagnostic
// (which also backs config validation) is unchanged.
const WORKFLOW = [
  "# Crysk review. The job mints an id-token so the run can call the platform,",
  "# and the github-token below lets it post comments. No token is stored, and",
  "# the api-key comes from a repository secret.",
  "name: crysk",
  "on:",
  "  workflow_call:",
  "    secrets:",
  "      api-token:",
  "        required: true",
  "        description: The token the review uses",
  "permissions:",
  "  contents: read",
  "  pull-requests: write",
  "  id-token: write",
  "jobs:",
  "  review:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: cryskai/crysk@v1",
  "        with:",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
  "          github-token: ${{ github.token }}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
  "          api-key: ${{ secrets.CRYSK_CLAUDE_API_KEY }}",
  "        env:",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
  "          CRYSK_CLAUDE_API_KEY: ${{ secrets.CRYSK_CLAUDE_API_KEY }}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
  "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
  "          CRYSK_X_API_KEY: ${{ secrets[format('CRYSK_{0}_API_KEY', inputs.p)] }}",
  "          #   CRYSK_CLAUDE_OAUTH_TOKEN — from `claude setup-token`: a long-lived",
  "          #     (~1 year) token draws on your Claude subscription.",
  '      - run: crysk review --token "$GITHUB_TOKEN"',
  "  reusable:",
  "    uses: ./.github/workflows/crysk-reusable.yml",
  "    secrets: inherit",
].join("\n");

describe("redactSessionText: a workflow file stays readable", () => {
  test("a workflow with permissions, expressions and comments about tokens loses nothing", () => {
    expect(redactSessionText(WORKFLOW)).toBe(WORKFLOW);
  });

  test.each([
    ["a permission word after a token name", "  id-token: write"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
    ["an expression after a token name", "github-token: ${{ github.token }}"],
    [
      "an expression after a quoted token name",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text, asserted, not evaluated
      '--token "${{ secrets.GITHUB_TOKEN }}"',
    ],
    ["a compound name followed by prose", "mints an id-token so the run"],
    ["a token followed by prose", "The token the review uses"],
    ["an api key followed by prose", "the api-key comes from a secret"],
    ["a dash after a token name", "CRYSK_CLAUDE_OAUTH_TOKEN — from setup"],
    ["a product path holding sk-", "./.github/workflows/crysk-reusable.yml"],
    [
      "a YAML key on the line after a token key",
      "api-token:\n  required: true",
    ],
  ])("%s is kept", (_name, text) => {
    expect(redactSessionText(text)).toBe(text);
  });
});

// Every shape redactDiagnostic redacts in the tests above, with a real secret
// value, plus the shapes redactEvidenceText redacts: the trace must never be
// weaker than it was when it ran redactDiagnostic.
describe("redactSessionText: every real secret is still redacted", () => {
  test.each([
    [
      "an sk- key",
      "auth failed for sk-a1B2c3D4e5F6g7H8",
      "sk-a1B2c3D4e5F6g7H8",
    ],
    ["a ghp_ token", `push denied: ghp_${"a1_".repeat(10)}`, "a1_".repeat(10)],
    ["a gho_ token", `gho_${"z9".repeat(20)}`, "z9".repeat(20)],
    ["a ghu_ token", `ghu_${"z9".repeat(20)}`, "z9".repeat(20)],
    ["a ghs_ token", `ghs_${"z9".repeat(20)}`, "z9".repeat(20)],
    ["a ghr_ token", `ghr_${"z9".repeat(20)}`, "z9".repeat(20)],
    ["a Bearer header", "authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    ["a lower-case bearer header", "AUTHORIZATION: bearer tok", "tok"],
    [
      "a Bearer value in prose",
      "sent Bearer abc.def.ghi upstream",
      "abc.def.ghi",
    ],
    ["a JSON api_key", '{"api_key": "supersecret123"}', "supersecret123"],
    ["a JSON api-key in text", 'config {"api-key":"abcd1234"}', "abcd1234"],
    ["a password assignment", "password=hunter2", "hunter2"],
    ["a token assignment", "token: abc123", "abc123"],
    [
      "a compound token name assigned",
      "github-token: abc123def456",
      "abc123def456",
    ],
    ["a password glued to a prose word", "password is1234", "is1234"],
    ["a password with digits after can", "password can8472", "can8472"],
    ["a token glued to no", "token no123!", "no123"],
    ["a token glued to to", "token to123", "to123"],
    [
      "a token value after a space",
      "invalid token abc123def456",
      "abc123def456",
    ],
    [
      "a long token value with no digit",
      "the token AbCdEfGhIjKlMnOpQrSt was used",
      "AbCdEfGhIjKlMnOpQrSt",
    ],
    [
      "an api key sk- value",
      "api key sk-ant-api03-AbCdEf123456",
      "AbCdEf123456",
    ],
    [
      "a password word in prose",
      "the password swordfish was wrong",
      "swordfish",
    ],
    ["a Google key", `provider refused ${GOOGLE_KEY} at startup`, GOOGLE_KEY],
    ["a Groq key", `provider refused ${GROQ_KEY} at startup`, GROQ_KEY],
    ["an xAI key", `provider refused ${XAI_KEY} at startup`, XAI_KEY],
    ["a PEM private key", `key:\n${PEM_KEY}\ndone`, PEM_BODY],
    ["an AWS key id", `id ${AWS_KEY_ID} used`, AWS_KEY_ID],
    ["an AWS secret", `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, AWS_SECRET],
    ["a URL password", `postgres://app:${DB_PASSWORD}@db/app`, DB_PASSWORD],
    ["a Stripe key", `stripe ${STRIPE_LIVE}`, STRIPE_LIVE],
    ["a JWT", `cached ${JWT} here`, JWT],
    [
      "a YAML value on the next line",
      `password:\n  ${TOKEN_VALUE}`,
      TOKEN_VALUE,
    ],
    ["a quoted token", `"apiToken": "${TOKEN_VALUE}"`, TOKEN_VALUE],
    [
      "a secret in a workflow env",
      `${WORKFLOW}\n  API_TOKEN: ${TOKEN_VALUE}`,
      TOKEN_VALUE,
    ],
    ...["sk-zz9Z8Y7X6W5V", "q".repeat(22), "eyJhbGciOi", "abcd1234"].map(
      (secret) => [
        `the combined diagnostic tail without ${secret.slice(0, 6)}`,
        [
          "error: request to provider failed",
          `sent key sk-zz9Z8Y7X6W5V and ghp_${"q".repeat(22)}`,
          "header was Bearer eyJhbGciOi",
          'config {"api-key":"abcd1234"}',
        ].join("\n"),
        secret,
      ],
    ),
  ])("%s", (_name, text, secret) => {
    const out = redactSessionText(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED");
  });

  test.each([
    [WORKFLOW],
    ["token: abc123 and password=hunter2"],
    [`provider refused ${GOOGLE_KEY} with Bearer abc.def`],
  ])("redacting twice gives the same text (%#)", (text) => {
    const once = redactSessionText(text);
    expect(redactSessionText(once)).toBe(once);
  });
});
