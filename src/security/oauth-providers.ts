// OAuth subscription providers, one descriptor each (cryskai/platform
// odd/tasks/openai-oauth.md, "Provider-generic"). Behavior that differs by
// provider is read from here, never branched on a provider name, so a provider
// that behaves like OpenAI is one more entry. The Crysk platform keeps the same
// table in packages/core/src/oauth-providers.ts.
//
// WHY no imports: the steps that run before `bun install` (the trigger, the
// connect step) may read it, and they are limited to runtime builtins.

export interface OAuthProviderDescriptor {
  // The provider id: the key of its record in the subscription store and the
  // `refresh-provider` input's value.
  readonly id: string;
  // The GitHub Actions secret that holds the provider's login record (base64 of
  // its JSON). The workflow forwards it in the crysk-secrets input, and the
  // refresher writes the renewed record back under the same name.
  readonly secretName: string;
  // Whether the provider issues a new refresh token on every refresh and refuses
  // the old one afterwards (OpenAI answers `refresh_token_reused`). A review never
  // holds such a provider's refresh token: renewing it inside a run would spend
  // the stored chain and throw the new token away with the run's copy.
  readonly rotatesRefreshToken: boolean;
  // How the runner-side refresher renews the login (src/ci/credential-refresh.ts):
  // an RFC 6749 `grant_type=refresh_token` POST, form-encoded, to `tokenUrl` with
  // `client_id` and any `extraParams`.
  readonly refresh: {
    readonly tokenUrl: string;
    readonly clientId: string;
    readonly extraParams?: Readonly<Record<string, string>>;
  };
  // The provider error codes that mean the login is gone and the person must log
  // in again. Read from the token endpoint's error body (a string `error`, an
  // `error.code`, or a top-level `code`). Any other error is not permanent.
  readonly permanentErrors: readonly string[];
  // Where the record's account id comes from, or undefined when the provider has
  // none. The id is read from the JWT claims of the token response's `tokens`,
  // in order, trying each claim path in order; when none answers, the stored
  // record's `recordField` is kept.
  readonly accountId?: {
    readonly recordField: string;
    readonly tokens: readonly string[];
    readonly claims: readonly (readonly (string | number)[])[];
  };
}

// OpenAI's values are OpenCode's (v1.18.30,
// packages/opencode/src/plugin/openai/codex.ts: CLIENT_ID, refreshAccessToken,
// extractAccountIdFromClaims), so the refresher renews the login exactly as
// OpenCode itself would. The error codes are Codex's permanent refresh failures
// plus the standard OAuth `invalid_grant`.
export const OAUTH_PROVIDERS: readonly OAuthProviderDescriptor[] = [
  {
    id: "openai",
    secretName: "CRYSK_OPENCODE_OPENAI_OAUTH",
    rotatesRefreshToken: true,
    refresh: {
      tokenUrl: "https://auth.openai.com/oauth/token",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    },
    permanentErrors: [
      "refresh_token_reused",
      "refresh_token_expired",
      "refresh_token_invalidated",
      "invalid_grant",
    ],
    accountId: {
      recordField: "accountId",
      tokens: ["id_token", "access_token"],
      claims: [
        ["chatgpt_account_id"],
        ["https://api.openai.com/auth", "chatgpt_account_id"],
        ["organizations", 0, "id"],
      ],
    },
  },
  // Antigravity (agy) on a Google subscription. The client is agy's own Google
  // installed-app client (odd/tasks/antigravity-oauth.md, L6): a refresh answers
  // without a new refresh token, so the stored one is kept. The error codes are
  // RFC 6749's token endpoint refusals plus Google's `invalid_rapt` (a
  // reauthentication the person must complete in a browser).
  {
    id: "antigravity",
    secretName: "CRYSK_ANTIGRAVITY_OAUTH",
    rotatesRefreshToken: false,
    refresh: {
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId:
        "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      // Not a secret: Google documents an installed app's client secret as
      // non-confidential, and agy ships this one in its binary.
      extraParams: { client_secret: "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" },
    },
    permanentErrors: [
      "invalid_request",
      "invalid_client",
      "invalid_grant",
      "unauthorized_client",
      "unsupported_grant_type",
      "invalid_scope",
      "invalid_rapt",
    ],
    accountId: {
      recordField: "accountId",
      tokens: ["id_token"],
      claims: [["email"], ["sub"]],
    },
  },
];

export function oauthProvider(id: string): OAuthProviderDescriptor | undefined {
  return OAUTH_PROVIDERS.find((provider) => provider.id === id);
}

// The secret that holds a provider's login, or undefined for a provider that is
// not in the table.
export function oauthSecretName(id: string): string | undefined {
  return oauthProvider(id)?.secretName;
}

// A review refuses to start on a login whose access token expires within this
// margin. The longest review observed takes about 25 minutes; OpenAI's tokens
// live 240 hours, and the platform renews them at 80% of that.
export const REVIEW_EXPIRY_MARGIN_MS = 2 * 60 * 60 * 1000;

// The record's own expiry, in milliseconds since the epoch, or undefined when it
// states none. OpenCode's OAuth record keeps it as `expires`.
export function recordExpiresAt(record: unknown): number | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const expires = (record as Record<string, unknown>).expires;
  return typeof expires === "number" && Number.isFinite(expires)
    ? expires
    : undefined;
}

// The copy of a record a review may hold: for a rotating provider, every field
// but the refresh token, emptied. OpenCode's schema accepts "" and reads it only
// once the access token has expired, and then fails instead of rotating.
export function reviewCopyOfRecord<T extends object>(
  providerId: string,
  record: T,
): T {
  if (oauthProvider(providerId)?.rotatesRefreshToken !== true) return record;
  if (!("refresh" in record)) return record;
  return { ...record, refresh: "" };
}
