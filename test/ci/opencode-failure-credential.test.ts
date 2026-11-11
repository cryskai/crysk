// S7 (odd/tasks/model-profiles.md): an OpenCode route's credential failure names the
// CRYSK_OPENCODE_* secret to fix, not Anthropic's. The record carries the secret name
// (HunterFailureRecord.credential), the reader accepts it, and the CI texts lead with
// the OpenCode fix. Claude's texts are pinned elsewhere (outcome.test.ts, publish.test.ts).
import { describe, expect, test } from "bun:test";
import {
  chooseOpenCodeSecret,
  OPENCODE_SECRET_NAME_RE,
  opencodeSecretName,
} from "../../src/ci/crysk-secrets";
import {
  knownFailureCredential,
  parseCliRecord,
  renderCode,
  renderHunterCause,
} from "../../src/ci/outcome";
import type { FailureCredential } from "../../src/execution/contracts";

const DEEPSEEK_KEY = "CRYSK_OPENCODE_DEEPSEEK_API_KEY" as FailureCredential;
const OPENAI_OAUTH = "CRYSK_OPENCODE_OPENAI_OAUTH" as FailureCredential;
const RUN = {
  pr: 7,
  runId: "123",
  runUrl: "https://example.test/run",
  step: "review",
  detail: "every hunter failed",
};

describe("opencodeSecretName: the one builder of an OpenCode secret's name", () => {
  test("names the API key and OAuth secrets with the provider token", () => {
    expect(opencodeSecretName("deepseek", "api_key")).toBe(
      "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
    );
    expect(opencodeSecretName("wafer.ai", "api_key")).toBe(
      "CRYSK_OPENCODE_WAFER_AI_API_KEY",
    );
    expect(opencodeSecretName("openai", "oauth")).toBe(
      "CRYSK_OPENCODE_OPENAI_OAUTH",
    );
  });

  test("names nothing for a provider id no secret name can carry", () => {
    expect(opencodeSecretName("", "api_key")).toBeUndefined();
    expect(opencodeSecretName("bad id", "oauth")).toBeUndefined();
  });

  test("chooseOpenCodeSecret still picks the same names (previous behavior)", () => {
    expect(
      chooseOpenCodeSecret("deepseek", ["CRYSK_OPENCODE_DEEPSEEK_API_KEY"]),
    ).toEqual({ kind: "api_key", secret: "CRYSK_OPENCODE_DEEPSEEK_API_KEY" });
    expect(
      chooseOpenCodeSecret("openai", [
        "CRYSK_OPENCODE_OPENAI_OAUTH",
        "CRYSK_OPENCODE_OPENAI_API_KEY",
      ]),
    ).toEqual({
      kind: "oauth",
      secret: "CRYSK_OPENCODE_OPENAI_OAUTH",
      unused: "CRYSK_OPENCODE_OPENAI_API_KEY",
    });
  });
});

describe("knownFailureCredential: the record reader accepts OpenCode secret names", () => {
  test("accepts the names the builder produces", () => {
    for (const name of [
      "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
      "CRYSK_OPENCODE_WAFER_AI_API_KEY",
      "CRYSK_OPENCODE_OPENAI_OAUTH",
    ]) {
      expect(knownFailureCredential(name)).toBe(name as FailureCredential);
    }
  });

  test("keeps accepting the Claude variables (previous behavior)", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      expect(knownFailureCredential(name)).toBe(name as FailureCredential);
    }
  });

  test("agrees with the secrets grammar on every candidate, valid or not", () => {
    // outcome.ts cannot import crysk-secrets.ts at runtime (builtins-only guard), so it
    // holds a copy of the pattern. This pins the copy to the grammar.
    for (const name of [
      "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
      "CRYSK_OPENCODE_FOO_API_API_KEY",
      "CRYSK_OPENCODE_OPENAI_OAUTH",
      "CRYSK_OPENCODE__API_KEY",
      "CRYSK_OPENCODE_deepseek_API_KEY",
      "CRYSK_OPENCODE_A__B_API_KEY",
      "CRYSK_OPENCODE_DEEPSEEK_TOKEN",
      "CRYSK_CLAUDE_API_KEY",
      "CRYSK_OPENCODE_DEEPSEEK_API_KEY\n",
      "x",
    ]) {
      expect(
        knownFailureCredential(name) !== undefined,
        `${JSON.stringify(name)}`,
      ).toBe(OPENCODE_SECRET_NAME_RE.test(name));
    }
  });

  test("a CLI record naming an OpenCode secret is readable", () => {
    const record = parseCliRecord(
      JSON.stringify({
        v: 1,
        outcome: "hunters-failed",
        head_sha: "a".repeat(40),
        hunter_failures: [
          {
            cause: "auth_invalid",
            provider: "deepseek",
            model: "deepseek-chat",
            credential: "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
          },
        ],
      }),
    );
    expect(record?.hunter_failures?.[0]?.credential).toBe(DEEPSEEK_KEY);
  });

  test("a CLI record with a malformed secret name stays unreadable", () => {
    const record = parseCliRecord(
      JSON.stringify({
        v: 1,
        outcome: "hunters-failed",
        head_sha: "a".repeat(40),
        hunter_failures: [
          { cause: "auth_invalid", credential: "CRYSK_OPENCODE__API_KEY" },
        ],
      }),
    );
    expect(record).toBeUndefined();
  });
});

describe("CRYSK-CRED-REJECTED on an OpenCode route names the OpenCode secret", () => {
  test("a rejected API key: the fix sets that provider's key, with no Claude step", () => {
    const rendered = renderHunterCause(
      "auth_invalid",
      { ...RUN, provider: "deepseek", model: "deepseek-chat" },
      "action",
      { credential: DEEPSEEK_KEY },
    );
    expect(rendered?.code).toBe("CRYSK-CRED-REJECTED");
    expect(rendered?.what).toBe(
      "Provider deepseek rejected the credential in CRYSK_OPENCODE_DEEPSEEK_API_KEY",
    );
    expect(rendered?.annotation).toContain(
      "gh secret set CRYSK_OPENCODE_DEEPSEEK_API_KEY",
    );
    expect(rendered?.summary.join("\n")).toContain(
      "gh secret set CRYSK_OPENCODE_DEEPSEEK_API_KEY",
    );
    expect(rendered?.annotation).not.toContain("claude setup-token");
    expect(rendered?.summary.join("\n")).not.toContain("claude setup-token");
    expect(rendered?.summary.join("\n")).not.toContain("Claude Console");
  });

  test("a rejected OpenAI subscription record: the fix logs in to OpenCode again", () => {
    const rendered = renderHunterCause(
      "auth_invalid",
      { ...RUN, provider: "openai", model: "gpt-5" },
      "action",
      { credential: OPENAI_OAUTH },
    );
    expect(rendered?.code).toBe("CRYSK-CRED-REJECTED");
    expect(rendered?.what).toContain("CRYSK_OPENCODE_OPENAI_OAUTH");
    expect(rendered?.summary.join("\n")).toContain("opencode auth login");
    expect(rendered?.summary.join("\n")).toContain(
      "gh secret set CRYSK_OPENCODE_OPENAI_OAUTH",
    );
    expect(rendered?.summary.join("\n")).not.toContain("claude setup-token");
  });

  test("renderCode picks the OpenCode variant from the secret alone", () => {
    const rendered = renderCode(
      "CRYSK-CRED-REJECTED",
      {
        provider: "deepseek",
        secret: "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
        pr: 7,
      },
      "action",
    );
    expect(rendered.summary.join("\n")).not.toContain("claude setup-token");
    expect(rendered.summary.join("\n")).toContain(
      "gh secret set CRYSK_OPENCODE_DEEPSEEK_API_KEY",
    );
  });
});

describe("CRYSK-PROVIDER-LIMITED on an OpenCode route names the OpenCode secret", () => {
  test("an API key out of quota: names the secret and the provider account, not Anthropic", () => {
    const rendered = renderHunterCause(
      "quota_exhausted",
      { ...RUN, provider: "deepseek", model: "deepseek-chat" },
      "action",
      { credential: DEEPSEEK_KEY },
    );
    expect(rendered?.code).toBe("CRYSK-PROVIDER-LIMITED");
    expect(rendered?.what).toContain("CRYSK_OPENCODE_DEEPSEEK_API_KEY");
    expect(rendered?.summary.join("\n")).not.toContain("Anthropic");
    expect(rendered?.summary.join("\n")).not.toContain("credentials.claude");
  });

  test("an OpenAI subscription at its usage limit: offers the API key to bill per token", () => {
    const rendered = renderHunterCause(
      "quota_exhausted",
      { ...RUN, provider: "openai", model: "gpt-5" },
      "action",
      { credential: OPENAI_OAUTH },
    );
    expect(rendered?.code).toBe("CRYSK-PROVIDER-LIMITED");
    expect(rendered?.what).toContain("CRYSK_OPENCODE_OPENAI_OAUTH");
    expect(rendered?.summary.join("\n")).toContain(
      "gh secret set CRYSK_OPENCODE_OPENAI_API_KEY",
    );
    expect(rendered?.summary.join("\n")).not.toContain("credentials.claude");
  });

  test("with no credential and no detail the default wording stands (previous behavior)", () => {
    const rendered = renderHunterCause(
      "quota_exhausted",
      { ...RUN, provider: "deepseek" },
      "action",
      {},
    );
    expect(rendered).toEqual(
      renderCode(
        "CRYSK-PROVIDER-LIMITED",
        { ...RUN, provider: "deepseek" },
        "action",
      ),
    );
  });
});

describe("Claude credentials keep their variants (previous behavior)", () => {
  const CONTEXTS = ["action", "local"] as const;
  const BASE = { provider: "anthropic", pr: 7, runId: "1", step: "review" };

  test("each Claude secret renders CRYSK-CRED-REJECTED as its api_key or oauth variant", () => {
    for (const ctx of CONTEXTS) {
      for (const [secret, variant] of [
        ["ANTHROPIC_API_KEY", "api_key"],
        ["ANTHROPIC_AUTH_TOKEN", "api_key"],
        ["CRYSK_CLAUDE_API_KEY", "api_key"],
        ["CLAUDE_CODE_OAUTH_TOKEN", "oauth"],
        ["CRYSK_CLAUDE_OAUTH_TOKEN", "oauth"],
        ["SOMETHING_ELSE", "default"],
      ] as const) {
        const params = { ...BASE, secret };
        expect(renderCode("CRYSK-CRED-REJECTED", params, ctx)).toEqual(
          renderCode("CRYSK-CRED-REJECTED", params, ctx, variant),
        );
      }
    }
  });

  test("a Claude credential out of quota never picks an OpenCode variant", () => {
    for (const ctx of CONTEXTS) {
      for (const [credential, variant] of [
        ["ANTHROPIC_API_KEY", "api_key"],
        ["CLAUDE_CODE_OAUTH_TOKEN", "subscription"],
        ["ANTHROPIC_AUTH_TOKEN", "every_hunter"],
      ] as const) {
        const detail = "Credit balance is too low";
        expect(
          renderHunterCause("quota_exhausted", BASE, ctx, {
            credential,
            detail,
          }),
        ).toEqual(
          renderCode(
            "CRYSK-PROVIDER-LIMITED",
            { ...BASE, detail },
            ctx,
            variant,
          ),
        );
      }
    }
  });
});
