import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  OAUTH_PROVIDERS,
  oauthProvider,
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

  test("every provider's token URL is https and its ids are unique", () => {
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
