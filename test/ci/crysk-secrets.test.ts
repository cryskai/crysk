// The CRYSK_* secrets intake (odd/tasks/role-model-routing.md, S8/S9, L12-L13,
// unit U1): the name grammar, the provider normalization and the `_OAUTH`
// record check. Pure, so every case runs through parseCryskSecrets directly;
// the setup step's own use of it is covered in test/ci/setup.test.ts.

import { describe, expect, test } from "bun:test";
import {
  cryskSecretsPresence,
  opencodeSecretsFor,
  opencodeSecretToken,
  parseCryskSecrets,
} from "#ci/crysk-secrets";

const b64 = (value: unknown) =>
  Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  ).toString("base64");

const OAUTH_RECORD = {
  type: "oauth" as const,
  access: "SENTINEL-ACCESS-0a1b",
  refresh: "SENTINEL-REFRESH-0a1b",
  expires: 1_900_000_000_000,
};

describe("parseCryskSecrets: the name grammar", () => {
  test("keeps the two Claude credentials and maps them to subscription and api_key", () => {
    const parsed = parseCryskSecrets(
      [
        "CRYSK_CLAUDE_OAUTH_TOKEN=SENTINEL-OAUTH-1",
        "CRYSK_CLAUDE_API_KEY=SENTINEL-KEY-1",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.notices).toEqual([]);
    expect(parsed.secrets.claude).toEqual({
      subscription: "SENTINEL-OAUTH-1",
      api_key: "SENTINEL-KEY-1",
    });
    expect(parsed.secrets.opencode.size).toBe(0);
    expect(parsed.names).toEqual([
      "CRYSK_CLAUDE_API_KEY",
      "CRYSK_CLAUDE_OAUTH_TOKEN",
    ]);
  });

  test("keeps OpenCode API keys and OAuth records per normalized provider", () => {
    const parsed = parseCryskSecrets(
      [
        "CRYSK_OPENCODE_DEEPSEEK_API_KEY=SENTINEL-DS",
        `CRYSK_OPENCODE_OPENAI_OAUTH=${b64(OAUTH_RECORD)}`,
        "CRYSK_OPENCODE_GITHUB_COPILOT_API_KEY=SENTINEL-GH",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.secrets.opencode.get("DEEPSEEK")).toEqual({
      apiKey: "SENTINEL-DS",
    });
    expect(parsed.secrets.opencode.get("OPENAI")).toEqual({
      oauth: OAUTH_RECORD,
    });
    expect(parsed.secrets.opencode.get("GITHUB_COPILOT")).toEqual({
      apiKey: "SENTINEL-GH",
    });
  });

  test("a provider holding both an API key and an OAuth record keeps both", () => {
    const parsed = parseCryskSecrets(
      [
        "CRYSK_OPENCODE_OPENAI_API_KEY=SENTINEL-OA",
        `CRYSK_OPENCODE_OPENAI_OAUTH=${b64(OAUTH_RECORD)}`,
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.secrets.opencode.get("OPENAI")).toEqual({
      apiKey: "SENTINEL-OA",
      oauth: OAUTH_RECORD,
    });
  });

  test("the provider runs up to the fixed suffix, so a provider ending in _API still parses", () => {
    const parsed = parseCryskSecrets("CRYSK_OPENCODE_FOO_API_API_KEY=SENTINEL");
    expect(parsed.problems).toEqual([]);
    expect([...parsed.secrets.opencode.keys()]).toEqual(["FOO_API"]);
  });

  test("an empty or whitespace-only value counts as absent, with no notice and no mask", () => {
    const parsed = parseCryskSecrets(
      [
        "CRYSK_CLAUDE_OAUTH_TOKEN=",
        "CRYSK_CLAUDE_API_KEY=   ",
        "CRYSK_OPENCODE_DEEPSEEK_API_KEY=",
        "CRYSK_OPENCODE_OPENAI_OAUTH=",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.notices).toEqual([]);
    expect(parsed.masks).toEqual([]);
    expect(parsed.secrets.claude).toEqual({});
    expect(parsed.secrets.opencode.size).toBe(0);
    expect(parsed.names).toEqual([]);
  });

  test("the reserved Claude account suffix is ignored with a notice naming only the name", () => {
    const parsed = parseCryskSecrets(
      [
        "CRYSK_CLAUDE_OAUTH_TOKEN_BACKUP=SENTINEL-BACKUP",
        "CRYSK_CLAUDE_API_KEY_TEAM_2=SENTINEL-TEAM",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.secrets.claude).toEqual({});
    expect(parsed.notices).toEqual([
      "CRYSK_CLAUDE_OAUTH_TOKEN_BACKUP is reserved for several Claude accounts, which Crysk does not read yet; it is ignored.",
      "CRYSK_CLAUDE_API_KEY_TEAM_2 is reserved for several Claude accounts, which Crysk does not read yet; it is ignored.",
    ]);
    expect(parsed.notices.join("\n")).not.toContain("SENTINEL");
    // Still masked: the value is a secret even though it is not read.
    expect(parsed.masks).toEqual(["SENTINEL-BACKUP", "SENTINEL-TEAM"]);
  });

  test("any other CRYSK_ name is dropped with a notice naming it", () => {
    for (const name of [
      "CRYSK_CLAUDE_OAUTH",
      "CRYSK_OPENCODE_API_KEY",
      "CRYSK_OPENCODE_OAUTH",
      "CRYSK_OPENCODE__API_KEY",
      "CRYSK_OPENCODE_DEEPSEEK_TOKEN",
      "CRYSK_OPENAI_API_KEY",
    ]) {
      const parsed = parseCryskSecrets(`${name}=SENTINEL-DROP`);
      expect(parsed.problems).toEqual([]);
      expect(parsed.secrets.claude).toEqual({});
      expect(parsed.secrets.opencode.size).toBe(0);
      expect(parsed.names).toEqual([]);
      expect(parsed.notices).toEqual([
        `${name} is not a Crysk credential name; it is ignored.`,
      ]);
      expect(parsed.masks).toEqual(["SENTINEL-DROP"]);
    }
  });

  test("a name outside CRYSK_ is dropped with a notice naming its line, never the name", () => {
    const parsed = parseCryskSecrets(
      ["CRYSK_CLAUDE_API_KEY=SENTINEL-K", "OTHER_SECRET=SENTINEL-OTHER"].join(
        "\n",
      ),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.notices).toEqual([
      "line 2 of the crysk-secrets input is not a Crysk credential; it is ignored.",
    ]);
    expect(parsed.masks).toContain("SENTINEL-OTHER");
    expect(parsed.secrets.claude).toEqual({ api_key: "SENTINEL-K" });
  });

  test("a lowercase name is not a Crysk name: dropped by line number", () => {
    const parsed = parseCryskSecrets("crysk_claude_api_key=SENTINEL-LOWER");
    expect(parsed.secrets.claude).toEqual({});
    expect(parsed.notices).toEqual([
      "line 1 of the crysk-secrets input is not a Crysk credential; it is ignored.",
    ]);
    expect(parsed.notices.join("")).not.toContain("crysk_claude");
  });

  test("the old secret names are recorded by presence only, never kept", () => {
    const parsed = parseCryskSecrets(
      [
        "CLAUDE_CODE_OAUTH_TOKEN=SENTINEL-OLD-1",
        "ANTHROPIC_API_KEY=",
        "OPENCODE_AUTH_JSON=SENTINEL-OLD-3",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.notices).toEqual([]);
    expect(parsed.legacy).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENCODE_AUTH_JSON",
    ]);
    expect(parsed.secrets.claude).toEqual({});
    expect(parsed.names).toEqual([]);
    expect(parsed.masks).toEqual(["SENTINEL-OLD-1", "SENTINEL-OLD-3"]);
  });

  test("blank lines and Windows line endings are tolerated; values are trimmed", () => {
    const parsed = parseCryskSecrets(
      "\r\n  CRYSK_CLAUDE_API_KEY=  SENTINEL-CRLF  \r\n\n",
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.secrets.claude).toEqual({ api_key: "SENTINEL-CRLF" });
    expect(parsed.masks).toEqual(["SENTINEL-CRLF"]);
  });

  test("the value runs from the first =, so base64 padding survives", () => {
    const parsed = parseCryskSecrets("CRYSK_CLAUDE_API_KEY=abc==def=");
    expect(parsed.secrets.claude).toEqual({ api_key: "abc==def=" });
  });

  test("a name given twice with values is refused, naming only the name", () => {
    const parsed = parseCryskSecrets(
      [
        "CRYSK_CLAUDE_API_KEY=SENTINEL-A",
        "CRYSK_CLAUDE_API_KEY=",
        "CRYSK_CLAUDE_API_KEY=SENTINEL-B",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([
      "CRYSK_CLAUDE_API_KEY is given more than once",
    ]);
    expect(parsed.masks).toEqual(["SENTINEL-A", "SENTINEL-B"]);
  });

  test("a line that is not NAME=value is refused by line number and masked whole", () => {
    // What a hand-made `base64` without -w0 leaves: the value wraps at 76
    // characters and its tail lands on lines of their own.
    const parsed = parseCryskSecrets(
      [
        "CRYSK_CLAUDE_API_KEY=SENTINEL-OK",
        "SENTINELFRAGMENTwithoutequals",
        "QQ==",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([
      "line 2 of the crysk-secrets input is not NAME=value (a value split across lines? encode _OAUTH secrets with base64 -w0)",
    ]);
    // A tail that happens to look like NAME=value cannot be told apart from a
    // name: it is dropped by line number, never named, and masked whole.
    expect(parsed.notices).toEqual([
      "line 3 of the crysk-secrets input is not a Crysk credential; it is ignored.",
    ]);
    expect(parsed.masks).toEqual([
      "SENTINEL-OK",
      "SENTINELFRAGMENTwithoutequals",
      "QQ==",
    ]);
    expect([...parsed.problems, ...parsed.notices].join("\n")).not.toContain(
      "SENTINEL",
    );
  });

  test("strings shorter than 4 characters are never masked, so a stray = cannot blank the log", () => {
    const parsed = parseCryskSecrets(
      ["CRYSK_CLAUDE_API_KEY=abc", "X=="].join("\n"),
    );
    expect(parsed.secrets.claude).toEqual({ api_key: "abc" });
    expect(parsed.masks).toEqual([]);
  });
});

describe("parseCryskSecrets: the _OAUTH record", () => {
  test("decodes base64 of a JSON object whose type is oauth", () => {
    const parsed = parseCryskSecrets(
      `CRYSK_OPENCODE_ANTHROPIC_OAUTH=${b64(OAUTH_RECORD)}`,
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.secrets.opencode.get("ANTHROPIC")?.oauth).toEqual(
      OAUTH_RECORD,
    );
  });

  test("masks the base64 value and every string inside the record but its type", () => {
    const record = {
      ...OAUTH_RECORD,
      enterpriseUrl: "SENTINEL-URL",
      nested: { token: "SENTINEL-NESTED" },
    };
    const value = b64(record);
    const parsed = parseCryskSecrets(`CRYSK_OPENCODE_OPENAI_OAUTH=${value}`);
    expect(parsed.masks).toEqual([
      value,
      "SENTINEL-ACCESS-0a1b",
      "SENTINEL-REFRESH-0a1b",
      "SENTINEL-URL",
      "SENTINEL-NESTED",
    ]);
    expect(parsed.masks).not.toContain("oauth");
  });

  test("refuses a value that is not standard padded base64, naming only the secret", () => {
    for (const value of [
      "not base64!",
      "SENTINEL_-url_safe",
      // Valid alphabet, wrong length (unpadded).
      b64(OAUTH_RECORD).replace(/=+$/, "").slice(0, -1),
    ]) {
      const parsed = parseCryskSecrets(`CRYSK_OPENCODE_OPENAI_OAUTH=${value}`);
      expect(parsed.problems).toEqual([
        "CRYSK_OPENCODE_OPENAI_OAUTH is not base64 (encode the OpenCode auth record with base64 -w0)",
      ]);
      expect(parsed.secrets.opencode.size).toBe(0);
      expect(parsed.masks).toEqual([value]);
    }
  });

  test("refuses base64 that is not a JSON object", () => {
    for (const decoded of ['{"type": "oauth"', '["oauth"]', '"oauth"', "1"]) {
      const parsed = parseCryskSecrets(
        `CRYSK_OPENCODE_OPENAI_OAUTH=${b64(decoded)}`,
      );
      expect(parsed.problems).toEqual([
        "CRYSK_OPENCODE_OPENAI_OAUTH does not decode to a JSON object",
      ]);
      expect(parsed.secrets.opencode.size).toBe(0);
    }
  });

  test("refuses a record whose type is not oauth, never quoting it", () => {
    for (const record of [
      { type: "api", key: "SENTINEL-API" },
      { access: "SENTINEL-NO-TYPE" },
    ]) {
      const parsed = parseCryskSecrets(
        `CRYSK_OPENCODE_OPENAI_OAUTH=${b64(record)}`,
      );
      expect(parsed.problems).toEqual([
        'CRYSK_OPENCODE_OPENAI_OAUTH is not an OpenCode OAuth record (its type is not "oauth")',
      ]);
      expect(parsed.problems.join("")).not.toContain("SENTINEL");
      expect(parsed.secrets.opencode.size).toBe(0);
    }
  });

  test("a refused _OAUTH does not stop the other secrets from parsing", () => {
    const parsed = parseCryskSecrets(
      [
        "CRYSK_OPENCODE_OPENAI_OAUTH=%%%",
        "CRYSK_CLAUDE_API_KEY=SENTINEL-K",
      ].join("\n"),
    );
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.secrets.claude).toEqual({ api_key: "SENTINEL-K" });
  });
});

describe("opencodeSecretToken: a plan provider id to its <P>", () => {
  test("uppercases and turns - and . into _", () => {
    expect(opencodeSecretToken("deepseek")).toBe("DEEPSEEK");
    expect(opencodeSecretToken("github-copilot")).toBe("GITHUB_COPILOT");
    expect(opencodeSecretToken("amazon-bedrock")).toBe("AMAZON_BEDROCK");
    expect(opencodeSecretToken("wafer.ai")).toBe("WAFER_AI");
    expect(opencodeSecretToken("openrouter")).toBe("OPENROUTER");
    expect(opencodeSecretToken("Zai_Coding")).toBe("ZAI_CODING");
  });

  test("refuses ids no secret name can carry", () => {
    for (const id of ["", "-foo", "foo-", "foo--bar", "foo.", "a/b", "fo o"]) {
      expect(opencodeSecretToken(id)).toBeUndefined();
    }
  });

  test("every token it returns parses back through the grammar as that provider", () => {
    for (const id of [
      "deepseek",
      "github-copilot",
      "wafer.ai",
      "openrouter",
      "amazon-bedrock",
      "zai_coding-plan",
      "foo-api",
    ]) {
      const token = opencodeSecretToken(id) as string;
      for (const suffix of ["API_KEY", "OAUTH"]) {
        const value = suffix === "OAUTH" ? b64(OAUTH_RECORD) : "SENTINEL";
        const parsed = parseCryskSecrets(
          `CRYSK_OPENCODE_${token}_${suffix}=${value}`,
        );
        expect(parsed.problems).toEqual([]);
        expect([...parsed.secrets.opencode.keys()]).toEqual([token]);
      }
    }
  });
});

describe("opencodeSecretsFor and cryskSecretsPresence", () => {
  const parsed = parseCryskSecrets(
    [
      "CRYSK_CLAUDE_API_KEY=SENTINEL-K",
      "CRYSK_OPENCODE_WAFER_AI_API_KEY=SENTINEL-W",
      `CRYSK_OPENCODE_OPENAI_OAUTH=${b64(OAUTH_RECORD)}`,
    ].join("\n"),
  );

  test("looks a plan provider up by normalizing it, never by reversing a name", () => {
    expect(opencodeSecretsFor(parsed.secrets, "wafer.ai")).toEqual({
      apiKey: "SENTINEL-W",
    });
    expect(opencodeSecretsFor(parsed.secrets, "openai")?.oauth).toEqual(
      OAUTH_RECORD,
    );
    expect(opencodeSecretsFor(parsed.secrets, "deepseek")).toBeUndefined();
    expect(opencodeSecretsFor(parsed.secrets, "-bad")).toBeUndefined();
  });

  test("presence names kinds and providers only", () => {
    expect(cryskSecretsPresence(parsed)).toEqual({
      names: [
        "CRYSK_CLAUDE_API_KEY",
        "CRYSK_OPENCODE_OPENAI_OAUTH",
        "CRYSK_OPENCODE_WAFER_AI_API_KEY",
      ],
      claude: ["api_key"],
      opencodeProviders: ["OPENAI", "WAFER_AI"],
    });
    expect(JSON.stringify(cryskSecretsPresence(parsed))).not.toContain(
      "SENTINEL",
    );
  });

  test("Claude kinds come in the credentials order: subscription, then api_key", () => {
    const both = parseCryskSecrets(
      ["CRYSK_CLAUDE_API_KEY=k", "CRYSK_CLAUDE_OAUTH_TOKEN=t"].join("\n"),
    );
    expect(cryskSecretsPresence(both).claude).toEqual([
      "subscription",
      "api_key",
    ]);
  });
});
