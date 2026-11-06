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
    ["Bearer", `Bearer ${"a1".repeat(15)}`],
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
    expect(
      publishedText(`key: -----BEGIN PRIVATE KEY-----\n${"a".repeat(64)}`),
    ).toBe("key: [REDACTED]");
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
      "a://".repeat(75_000),
      "sk-".repeat(100_000),
      "@".repeat(300_000),
      "A_TOKEN=".repeat(40_000),
      "-----BEGIN PRIVATE KEY-----aaaaaaaaaaaaaaaaaaaaa ".repeat(6_000),
      "-----BEGIN PRIVATE KEY-----".repeat(10_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      publishedText(input);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});

describe("publishedText, measured against GitHub's own renderer", () => {
  test("a character reference cannot spell a mention", () => {
    for (const text of ["&#64;octocat", "&#x40;octocat", "&commat;octocat"]) {
      expect(publishedText(text)).not.toMatch(/&(#|commat)/);
    }
  });

  test("every prefix GitHub reads as a mention is defused", () => {
    for (const text of ["@octocat", "(@octocat)", "foo-@octocat"]) {
      expect(publishedText(text)).toContain(`@${ZWSP}octocat`);
    }
  });

  test("paths, URLs and emails that GitHub does not read as a mention stay intact", () => {
    for (const text of [
      "src/@types/foo.d.ts",
      "http://example.com/@scope/pkg",
      "someone@example.com",
    ]) {
      expect(publishedText(text)).toBe(text);
    }
  });
});

describe("publishedText leaves code in a claim alone", () => {
  const CODE = [
    "const API_KEY = process.env.API_KEY",
    "const TOKEN = getToken();",
    "MAX_TOKEN = 4096",
    'SECRET = os.environ["SECRET"]',
    "GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}",
    "enum { TOKEN = 'token' }",
    "PASSWORD=$(cat /run/secrets/db)",
    "MAX_TOKENS=1000000000",
    "bearer verifyAccessTokenSignature",
    "Uses bearer authentication/authorization middleware",
    "Bearer authTokenFromHeaderValueXYZ",
    "sk-fading-circle-animation-delay",
    "redis://:${REDIS_PASSWORD}@cache:6379",
    "ssh://git@github.com/org/repo.git",
  ];
  for (const text of CODE) {
    test(text, () => {
      expect(publishedText(text).replaceAll(ZWSP, "")).toBe(text);
    });
  }

  test("a private key with no end keeps the sentence after it", () => {
    const out = publishedText(
      `-----BEGIN PRIVATE KEY----- ${"A".repeat(64)} ${"B".repeat(64)} rotate this key now`,
    );
    expect(out).toBe("[REDACTED] rotate this key now");
  });
});

describe("publishedText catches secrets beside word characters and in more names", () => {
  const TOKEN = `ghp_${"a".repeat(36)}`;
  test("after an underscore, as Markdown emphasis or an identifier", () => {
    for (const text of [`_${TOKEN}_`, `__${TOKEN}__`, `foo_${TOKEN}`]) {
      expect(publishedText(text)).not.toContain(TOKEN);
    }
  });

  test("a JWT", () => {
    const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
    expect(publishedText(`header ${jwt}`)).toBe("header [REDACTED]");
  });

  test("names where the keyword is not last, YAML, and quoted values with spaces", () => {
    expect(publishedText("AWS_SECRET_ACCESS_KEY=abcd1234")).toBe(
      "AWS_SECRET_ACCESS_KEY=[REDACTED]",
    );
    expect(publishedText("SECRET_KEY=abcd1234")).toBe("SECRET_KEY=[REDACTED]");
    expect(publishedText("DB_PASSWORD: hunter2hunter")).toBe(
      "DB_PASSWORD: [REDACTED]",
    );
    expect(publishedText('PASSWORD="my pass word"')).toBe(
      "PASSWORD=[REDACTED]",
    );
  });

  test("URL credentials: an @ in the password, and a long user-only token", () => {
    expect(publishedText("https://u:p@ss@host.example/x")).not.toContain("ss@");
    expect(
      publishedText(`https://${"a".repeat(40)}@github.com/o/r`),
    ).not.toContain("a".repeat(40));
  });
});

describe("publishedText judges an assignment by its value", () => {
  const KEPT = [
    "enum { TOKEN = 'tokens' }",
    'const ACCESS_TOKEN = "access_token";',
    'const API_KEY_HEADER = "x-api-key";',
    "REFRESH_TOKEN: 'refresh_token',",
    "TOKEN=undefined",
    "TOKEN=getToken",
    "API_KEY=config",
    "SECRET: Uint8Array",
    "TOKEN: Uint8Array;",
    "PRIVATE_KEY: Base64String",
    "password: string",
    "api_key: string",
    "max_tokens=1000000",
    "TOKEN_LIMIT=1_000_000",
    "config/credentials:100-120",
    "tokenizer=bert-base-1",
    'const PASSWORD = "password"',
  ];
  for (const text of KEPT) {
    test(`keeps ${text}`, () => {
      expect(publishedText(text)).toBe(text);
    });
  }

  const REDACTED: readonly [string, string][] = [
    ['"password":"hunter2"', '"password":[REDACTED]'],
    ["password=hunter2", "password=[REDACTED]"],
    ["secret_key=abc123def456", "secret_key=[REDACTED]"],
    ["x-api-key: abc123def456", "x-api-key: [REDACTED]"],
    ["DB_PASSWORD: correcthorse", "DB_PASSWORD: [REDACTED]"],
    ["DB_PASSWORD=correcthorse", "DB_PASSWORD=[REDACTED]"],
    ["password=123-456", "password=[REDACTED]"],
    ["api_key=12-34-56", "api_key=[REDACTED]"],
    ["SECRET: 123-456", "SECRET: [REDACTED]"],
  ];
  for (const [text, expected] of REDACTED) {
    test(`redacts ${text}`, () => {
      expect(publishedText(text)).toBe(expected);
    });
  }
});
