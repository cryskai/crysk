// OAuth subscription providers, one descriptor each (cryskai/platform
// odd/tasks/openai-oauth.md, "Provider-generic"). Behavior that differs by
// provider is read from here, never branched on a provider name, so a provider
// that behaves like OpenAI is one more entry. The Crysk platform keeps the same
// table in packages/core/src/oauth-providers.ts.
//
// WHY no imports: the steps that run before `bun install` (the trigger, the
// connect step) may read it, and they are limited to runtime builtins.

export interface OAuthProviderDescriptor {
  // The OpenCode provider id, the key of its record in auth.json.
  readonly id: string;
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
];

export function oauthProvider(id: string): OAuthProviderDescriptor | undefined {
  return OAUTH_PROVIDERS.find((provider) => provider.id === id);
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
