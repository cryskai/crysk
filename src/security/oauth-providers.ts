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
}

export const OAUTH_PROVIDERS: readonly OAuthProviderDescriptor[] = [
  { id: "openai", rotatesRefreshToken: true },
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
