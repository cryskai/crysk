import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { opencodeSecretName } from "../../src/ci/crysk-secrets";
import {
  OAUTH_PROVIDERS,
  oauthProvider,
  oauthSecretName,
  reviewCopyOfRecord,
} from "../../src/security/oauth-providers";

// The refresh values are OpenCode's own (v1.18.30,
// packages/opencode/src/plugin/openai/codex.ts), so the runner renews a login
// exactly as OpenCode would. A change here must be checked against OpenCode.
describe("oauth-providers — the refresh descriptor", () => {
  test("OpenAI refreshes at auth.openai.com with Codex's client id", () => {
    const openai = oauthProvider("openai");
    expect(openai?.rotatesRefreshToken).toBe(true);
    expect(openai?.refresh).toEqual({
      tokenUrl: "https://auth.openai.com/oauth/token",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
  });

  test("OpenAI's permanent errors are Codex's plus the standard invalid_grant", () => {
    expect(
      [...(oauthProvider("openai")?.permanentErrors ?? [])].sort(),
    ).toEqual([
      "invalid_grant",
      "refresh_token_expired",
      "refresh_token_invalidated",
      "refresh_token_reused",
    ]);
  });

  test("OpenAI's account id is read as OpenCode reads it", () => {
    expect(oauthProvider("openai")?.accountId).toEqual({
      recordField: "accountId",
      tokens: ["id_token", "access_token"],
      claims: [
        ["chatgpt_account_id"],
        ["https://api.openai.com/auth", "chatgpt_account_id"],
        ["organizations", 0, "id"],
      ],
    });
  });

  test("OpenAI's secret keeps its OpenCode name", () => {
    expect(oauthProvider("openai")?.secretName).toBe(
      "CRYSK_OPENCODE_OPENAI_OAUTH",
    );
    expect(oauthSecretName("openai")).toBe("CRYSK_OPENCODE_OPENAI_OAUTH");
    expect(oauthSecretName("openai")).toBe(
      opencodeSecretName("openai", "oauth"),
    );
  });

  test("an unknown provider has no secret name", () => {
    expect(oauthSecretName("anthropic")).toBeUndefined();
    expect(oauthSecretName("")).toBeUndefined();
  });

  test("every provider's token URL is https and its ids and secret names are unique", () => {
    const names = OAUTH_PROVIDERS.map((provider) => provider.secretName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^CRYSK_[A-Z0-9_]+_OAUTH$/);

    const ids = OAUTH_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const provider of OAUTH_PROVIDERS) {
      expect(provider.refresh.tokenUrl.startsWith("https://")).toBe(true);
    }
  });

  test("the module imports nothing, so a pre-install step may read it", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "../../src/security/oauth-providers.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});

// Antigravity (odd/tasks/antigravity-oauth.md, S2/S3, L6): agy's own Google
// installed-app client. T0 proved the client secret pairs with this client id
// and that a refresh returns no new refresh token.
describe("oauth-providers — Antigravity", () => {
  const antigravity = oauthProvider("antigravity");

  test("refreshes at Google's token endpoint with agy's client and its secret", () => {
    expect(antigravity?.refresh.tokenUrl).toBe(
      "https://oauth2.googleapis.com/token",
    );
    expect(antigravity?.refresh.clientId).toBe(
      "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    );
    expect(Object.keys(antigravity?.refresh.extraParams ?? {})).toEqual([
      "client_secret",
    ]);
    expect(antigravity?.refresh.extraParams?.client_secret).toMatch(
      /^GOCSPX-K58[A-Za-z0-9_-]{25}$/,
    );
  });

  test("does not rotate its refresh token, so a review keeps it", () => {
    expect(antigravity?.rotatesRefreshToken).toBe(false);
    const record = { type: "oauth", access: "a", refresh: "r", expires: 1 };
    expect(reviewCopyOfRecord("antigravity", record)).toEqual(record);
  });

  test("its permanent errors are Google's OAuth refusals", () => {
    expect([...(antigravity?.permanentErrors ?? [])].sort()).toEqual([
      "invalid_client",
      "invalid_grant",
      "invalid_rapt",
      "invalid_request",
      "invalid_scope",
      "unauthorized_client",
      "unsupported_grant_type",
    ]);
  });

  test("its account id is the id_token's email, else its sub", () => {
    expect(antigravity?.accountId).toEqual({
      recordField: "accountId",
      tokens: ["id_token"],
      claims: [["email"], ["sub"]],
    });
  });

  test("its secret is CRYSK_ANTIGRAVITY_OAUTH", () => {
    expect(antigravity?.secretName).toBe("CRYSK_ANTIGRAVITY_OAUTH");
    expect(oauthSecretName("antigravity")).toBe("CRYSK_ANTIGRAVITY_OAUTH");
  });
});
