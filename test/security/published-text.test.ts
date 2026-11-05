import { describe, expect, test } from "bun:test";
import { publishedText } from "../../src/security/published-text";

const ZWSP = "\u200b";

describe("publishedText redacts credential shapes", () => {
  const SECRETS: readonly [string, string][] = [
    ["GitHub classic", `ghp_${"a".repeat(36)}`],
    ["GitHub fine-grained", `github_pat_${"a".repeat(40)}`],
    ["GitLab", `glpat-${"a".repeat(20)}`],
    ["AWS", "AKIAIOSFODNN7EXAMPLE"],
    ["Anthropic", `sk-ant-api03-${"a".repeat(40)}`],
    ["OpenAI", `sk-proj-${"a".repeat(40)}`],
    ["Stripe", `sk_live_${"a".repeat(24)}`],
    ["Slack", `xoxb-123456789012-${"a".repeat(24)}`],
    ["Google", `AIza${"a".repeat(35)}`],
    ["npm", `npm_${"a".repeat(36)}`],
    ["Bearer", `Bearer ${"a".repeat(30)}`],
  ];
  for (const [name, secret] of SECRETS) {
    test(name, () => {
      const out = publishedText(`before ${secret} after`);
      expect(out).toBe("before [REDACTED] after");
    });
  }

  test("a private key block, whole, even when the end is cut off", () => {
    const block =
      "-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----";
    expect(publishedText(`key: ${block} done`)).toBe("key: [REDACTED] done");
    expect(publishedText("key: -----BEGIN PRIVATE KEY-----\nabc")).toBe(
      "key: [REDACTED]",
    );
  });

  test("a URL password keeps the scheme and the host", () => {
    const out = publishedText("postgres://admin:hunter2@db.example/app");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("admin");
    expect(out).toContain("postgres://[REDACTED]@");
    expect(out).toContain("db.example/app");
  });

  test("an env-style assignment keeps the name and loses the value", () => {
    expect(publishedText("DB_PASSWORD=hunter2 is committed")).toBe(
      "DB_PASSWORD=[REDACTED] is committed",
    );
    expect(publishedText('API_KEY = "abc123"')).toBe("API_KEY = [REDACTED]");
  });
});

describe("publishedText keeps ordinary review prose", () => {
  const PROSE = [
    "task-runner-configuration-module is wrong",
    "risk-assessment-for-the-whole-pipeline",
    "the Bearer token is missing",
    "the password field is never hashed",
    "token = getToken() runs before the guard",
    "API_TOKEN == expected compares in constant time",
    "a < b and c > d",
    "see https://example.com/docs?x=1",
    "npm_config_registry is read too late",
  ];
  for (const text of PROSE) {
    test(text, () => {
      expect(publishedText(text)).toBe(text);
    });
  }
});

describe("publishedText defuses what GitHub would act on", () => {
  test("a mention notifies nobody", () => {
    const out = publishedText("cc @octocat and @org/team");
    expect(out).not.toMatch(/@[a-z]/);
    expect(out).toBe(`cc @${ZWSP}octocat and @${ZWSP}org/team`);
  });

  test("a Markdown image fetches nothing", () => {
    expect(publishedText("![x](https://evil.example/p.png)")).not.toContain(
      "![",
    );
  });

  test("raw HTML stays text", () => {
    const out = publishedText('<img src="https://evil.example/p.png">');
    expect(out).not.toMatch(/<[a-zA-Z/!?]/);
  });

  test("an HTML comment cannot open or close", () => {
    const out = publishedText("<!-- crysk-state v=1 --> trailing -->");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("-->");
  });

  test("a generic reads the same to a person", () => {
    expect(publishedText("Array<string>").replaceAll(ZWSP, "")).toBe(
      "Array<string>",
    );
  });
});

describe("publishedText as a function", () => {
  test("is idempotent, because a posted claim can be read back and posted again", () => {
    const once = publishedText(
      `@a ![b](c) <d> --> ghp_${"e".repeat(36)} DB_PASSWORD=f g://h:i@j`,
    );
    expect(publishedText(once)).toBe(once);
  });

  // A competitor's redactor rescanned a long token from each of its characters,
  // so one 30,000-character word stalled publication for minutes.
  test("stays fast on long hostile input", () => {
    const inputs = [
      "a".repeat(300_000),
      "a.".repeat(150_000),
      "a:".repeat(150_000),
      "-".repeat(300_000),
      "A_".repeat(150_000),
      "<".repeat(300_000),
      "-----BEGIN PRIVATE KEY-----".repeat(10_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      publishedText(input);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});
