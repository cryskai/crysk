// The action's credential refresh step (cryskai/platform odd/tasks/openai-oauth.md,
// E3): renews an OpenCode subscription login on the customer's runner, seals the
// new record with the target's GitHub public key, and hands the platform only
// the ciphertext, which it writes back as the same CRYSK_OPENCODE_<P>_OAUTH
// secret.
//
// It runs only when the platform dispatched the workflow with
// `operation: refresh-credential` (action.yml), after the connect step and
// `bun install`. A review never renews a rotating login (E1): the refresh token
// rotates on use and a reused one is refused for good, so this step is the one
// serialized place where the chain moves.
//
// The order is the contract with the platform (CREDENTIAL_REFRESH_PATHS):
//   1. `targets`: the public key of the secret's target. Everything that can fail
//      on the runner (provider, record, key) is checked before step 2, so a
//      failure there spends nothing and the platform may dispatch again.
//   2. `begin`: the platform records that the stored refresh token is about to
//      be spent. Then ONE POST to the provider's token endpoint, never retried:
//      a request that may have reached the provider may have spent the token.
//   3. `result`: the sealed record, or `{failure}`. Once the provider answered
//      with new tokens the stored refresh token is spent, so the sealed record
//      is kept in memory and this POST is retried for minutes before giving up.
//
// WHY nothing is written: no file, no step output. Every token is masked with
// `::add-mask::` before anything else is printed, and every message goes through
// `redact`, so no value reaches the log even when a request fails.
//
// The provider's behavior (token URL, client id, permanent errors, account id)
// is data in src/security/oauth-providers.ts; this script never names a provider.

import {
  type OAuthProviderDescriptor,
  oauthProvider,
} from "../security/oauth-providers";
import {
  type OpenCodeOAuthRecord,
  opencodeSecretsFor,
  opencodeSecretToken,
  parseCryskSecrets,
} from "./crysk-secrets";
import { PLATFORM_API_URL } from "./platform";

// ---------------------------------------------------------------------------
// The platform contract. The Crysk platform implements the same three
// endpoints (docs/github-actions.md, "Subscription logins"). Every request is a
// JSON POST with `Authorization: Bearer <run token>` (the connect step's) and
// `X-Crysk-Dispatch-Id: <dispatch id>` (the workflow_dispatch input).
// ---------------------------------------------------------------------------

export const CREDENTIAL_REFRESH_PATHS = {
  targets: "/runs/credential-refresh/targets",
  begin: "/runs/credential-refresh/begin",
  result: "/runs/credential-refresh",
} as const;

// `targets` and `begin` carry only the provider; the platform checks it against
// the refresh it dispatched.
export interface CredentialRefreshProviderBody {
  provider: string;
}

// `targets` answers the GitHub public key of the secret's target (the
// organization or the repository), as GitHub's `.../secrets/public-key` does.
export interface CredentialRefreshTargetsReply {
  key_id: string;
  key: string;
}

export type CredentialRefreshResultBody =
  | {
      provider: string;
      key_id: string;
      // Standard padded base64 of the libsodium sealed box, as GitHub's
      // "create or update a secret" API takes it. The sealed plaintext is the
      // secret's value: standard base64 of the record's JSON, as
      // CRYSK_OPENCODE_<P>_OAUTH stores it.
      encrypted_value: string;
      // ISO 8601, UTC. When the provider issued the new access token (the
      // runner's clock at its answer) and when the record says it expires.
      issued_at: string;
      expires_at: string;
      // The provider's account id (ChatGPT's account for OpenAI), or null.
      provider_account_id: string | null;
    }
  | {
      provider: string;
      // One of the descriptor's permanent error codes (log in again), or
      // PROVIDER_ERROR_FAILURE.
      failure: string;
    };

// The provider answered with an error that is not one of its permanent codes
// (a 5xx, a 429, an unknown code, or a 200 without an access token). Whether the
// stored refresh token survived is unknown; the platform decides what follows.
export const PROVIDER_ERROR_FAILURE = "provider_error";

// The result POST is retried on a transport failure, a 5xx or a 429, with this
// backoff, for at most RESULT_RETRY_BUDGET_MS. The worst case for the step is
// that budget plus one request timeout; the platform's lease must outlast it.
export const RESULT_RETRY_BUDGET_MS = 10 * 60 * 1000;
const RESULT_RETRY_FIRST_DELAY_MS = 5_000;
const RESULT_RETRY_MAX_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
// OpenCode's own fallback when the token response states no `expires_in`.
const DEFAULT_EXPIRES_IN_S = 3600;

export const REFRESH_OPERATION = "refresh-credential";

export type Sealer = (value: string) => string;

// Loads libsodium and returns a sealer for one GitHub public key, or throws when
// the key is not a 32-byte X25519 key in standard base64. Loaded lazily, here
// only, so no other step's import closure gains the package.
export async function githubSealer(publicKeyBase64: string): Promise<Sealer> {
  const { default: sodium } = await import("libsodium-wrappers");
  await sodium.ready;
  let key: Uint8Array;
  try {
    key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new Error("the target's public key is not base64");
  }
  if (key.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error("the target's public key is not the expected size");
  }
  return (value) =>
    sodium.to_base64(
      sodium.crypto_box_seal(sodium.from_string(value), key),
      sodium.base64_variants.ORIGINAL,
    );
}

export interface CredentialRefreshDeps {
  fetch: typeof fetch;
  env: Readonly<Record<string, string | undefined>>;
  // The crysk-secrets input, read from stdin by the entry point.
  cryskSecrets: string;
  baseUrl: string;
  stdout: (text: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function escapeCommandData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The JWT payload's claims, or undefined when the token is not a JWT.
function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8"),
    );
    return isPlainObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

function claimAt(
  claims: unknown,
  pathParts: readonly (string | number)[],
): unknown {
  let value: unknown = claims;
  for (const part of pathParts) {
    if (typeof part === "number") {
      if (!Array.isArray(value)) return undefined;
      value = value[part];
    } else {
      if (!isPlainObject(value)) return undefined;
      value = value[part];
    }
  }
  return value;
}

// The account id the descriptor says where to find: the first claim path that
// holds a non-empty string in the first token that has one, else the stored
// record's field (OpenCode's order: extractAccountId, then the record's).
export function accountIdFor(
  descriptor: OAuthProviderDescriptor,
  tokens: Record<string, unknown>,
  record: OpenCodeOAuthRecord,
): string | undefined {
  const source = descriptor.accountId;
  if (source === undefined) return undefined;
  for (const tokenName of source.tokens) {
    const claims = jwtClaims(tokens[tokenName]);
    if (claims === undefined) continue;
    for (const claimPath of source.claims) {
      const value = claimAt(claims, claimPath);
      if (typeof value === "string" && value !== "") return value;
    }
  }
  const kept = record[source.recordField];
  return typeof kept === "string" && kept !== "" ? kept : undefined;
}

// The error code in a token endpoint's error body: RFC 6749's string `error`,
// OpenAI's `error.code`, or a top-level `code`.
export function providerErrorCode(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined;
  const { error, code } = body;
  if (typeof error === "string" && error !== "") return error;
  if (isPlainObject(error) && typeof error.code === "string" && error.code) {
    return error.code;
  }
  return typeof code === "string" && code !== "" ? code : undefined;
}

export async function runCredentialRefresh(
  deps: CredentialRefreshDeps,
): Promise<number> {
  const secrets: string[] = [];
  const redact = (text: string): string => {
    let safe = text;
    // Longest first, so a secret that contains another is hidden whole.
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      if (secret !== "") safe = safe.split(secret).join("***");
    }
    return safe;
  };
  const mask = (value: string): void => {
    if (value.length < 4 || secrets.includes(value)) return;
    secrets.push(value);
    deps.stdout(`::add-mask::${escapeCommandData(value)}\n`);
  };
  const fail = (message: string): number => {
    deps.stdout(
      `::error title=crysk::${escapeCommandData(redact(`Crysk credential refresh failed: ${message}`))}\n`,
    );
    return 1;
  };

  const operation = deps.env.CRYSK_OPERATION ?? "";
  if (operation !== REFRESH_OPERATION) {
    return fail(
      `the operation input is "${operation}", which is neither "review" (the default) nor "${REFRESH_OPERATION}".`,
    );
  }
  const providerId = deps.env.CRYSK_REFRESH_PROVIDER ?? "";
  const descriptor = oauthProvider(providerId);
  const token = opencodeSecretToken(providerId);
  if (descriptor === undefined || token === undefined) {
    return fail(
      `the refresh-provider input "${providerId}" is not a subscription provider Crysk can renew.`,
    );
  }
  const secretName = `CRYSK_OPENCODE_${token}_OAUTH`;
  const runToken = deps.env.CRYSK_RUN_TOKEN ?? "";
  const dispatchId = deps.env.CRYSK_DISPATCH_ID ?? "";
  if (runToken === "" || dispatchId === "") {
    return fail(
      "no Crysk run token or dispatch id reached this step; a refresh runs only when the Crysk platform dispatches it.",
    );
  }
  mask(runToken);

  const parse = parseCryskSecrets(deps.cryskSecrets);
  for (const value of parse.masks) mask(value);
  const problem = parse.problems.find((text) => text.startsWith(secretName));
  if (problem !== undefined) return fail(`${problem}.`);
  const record = opencodeSecretsFor(parse.secrets, providerId)?.oauth;
  if (record === undefined) {
    return fail(
      `${secretName} is not set in the crysk-secrets input; connect the subscription again from the Crysk dashboard.`,
    );
  }
  const storedRefresh = record.refresh;
  if (typeof storedRefresh !== "string" || storedRefresh === "") {
    return fail(
      `${secretName} holds no refresh token; connect the subscription again from the Crysk dashboard.`,
    );
  }

  const post = async (
    endpoint: string,
    body: unknown,
  ): Promise<{ ok: true; reply: unknown } | { ok: false; status?: number }> => {
    try {
      const response = await deps.fetch(`${deps.baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runToken}`,
          "X-Crysk-Dispatch-Id": dispatchId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, status: response.status };
      return { ok: true, reply: await response.json().catch(() => ({})) };
    } catch {
      return { ok: false };
    }
  };
  const describe = (status: number | undefined): string =>
    status === undefined ? "the request could not complete" : `HTTP ${status}`;

  // Retried while the platform may still take it (a transport failure, a 5xx, a
  // 429); any other 4xx is a refusal and retrying cannot change it.
  const postResult = async (
    body: CredentialRefreshResultBody,
  ): Promise<{ ok: true } | { ok: false; status?: number }> => {
    const deadline = deps.now() + RESULT_RETRY_BUDGET_MS;
    let delay = RESULT_RETRY_FIRST_DELAY_MS;
    for (;;) {
      const sent = await post(CREDENTIAL_REFRESH_PATHS.result, body);
      if (sent.ok) return { ok: true };
      const retryable =
        sent.status === undefined || sent.status >= 500 || sent.status === 429;
      if (!retryable || deps.now() + delay > deadline) return sent;
      await deps.sleep(delay);
      delay = Math.min(delay * 2, RESULT_RETRY_MAX_DELAY_MS);
    }
  };
  const reportFailure = async (
    failure: string,
    message: string,
  ): Promise<number> => {
    const sent = await postResult({ provider: providerId, failure });
    return fail(
      sent.ok
        ? message
        : `${message} The platform was not told (${describe(sent.status)}).`,
    );
  };

  // 1. The target's public key, and the sealer for it, before anything is spent.
  const targets = await post(CREDENTIAL_REFRESH_PATHS.targets, {
    provider: providerId,
  } satisfies CredentialRefreshProviderBody);
  if (!targets.ok) {
    return fail(
      `the Crysk platform did not answer the refresh target (${describe(targets.status)}); nothing was spent.`,
    );
  }
  const target = targets.reply;
  if (
    !isPlainObject(target) ||
    typeof target.key_id !== "string" ||
    target.key_id === "" ||
    typeof target.key !== "string"
  ) {
    return fail(
      "the Crysk platform answered the refresh target without a key_id and key; nothing was spent.",
    );
  }
  const keyId = target.key_id;
  let seal: Sealer;
  try {
    seal = await githubSealer(target.key);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`${detail}; nothing was spent.`);
  }

  // 2. The platform records the spend, then one request to the provider.
  const begun = await post(CREDENTIAL_REFRESH_PATHS.begin, {
    provider: providerId,
  } satisfies CredentialRefreshProviderBody);
  if (!begun.ok) {
    return fail(
      `the Crysk platform did not start the refresh (${describe(begun.status)}); nothing was spent.`,
    );
  }

  let response: Response;
  try {
    response = await deps.fetch(descriptor.refresh.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...descriptor.refresh.extraParams,
        grant_type: "refresh_token",
        refresh_token: storedRefresh,
        client_id: descriptor.refresh.clientId,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Not retried and not reported: the request may have reached the provider
    // and spent the stored token, so only the platform's own rule may follow.
    return fail(
      `the ${providerId} token endpoint could not be reached; the stored login may have been spent.`,
    );
  }
  let tokens: unknown;
  try {
    tokens = await response.json();
  } catch {
    tokens = undefined;
  }
  // Every token is masked before any other write, whatever the answer looks
  // like (`access_token`, `refresh_token`, `id_token`; not `token_type`, whose
  // `Bearer` would blank ordinary text across the log).
  if (isPlainObject(tokens)) {
    for (const [key, value] of Object.entries(tokens)) {
      if (key.endsWith("token") && typeof value === "string") mask(value);
    }
  }
  if (!response.ok) {
    const code = providerErrorCode(tokens);
    if (code !== undefined && descriptor.permanentErrors.includes(code)) {
      return reportFailure(
        code,
        `${providerId} refused the stored login (${code}); connect the subscription again from the Crysk dashboard.`,
      );
    }
    return reportFailure(
      PROVIDER_ERROR_FAILURE,
      `the ${providerId} token endpoint answered HTTP ${response.status}.`,
    );
  }
  if (
    !isPlainObject(tokens) ||
    typeof tokens.access_token !== "string" ||
    tokens.access_token === ""
  ) {
    return reportFailure(
      PROVIDER_ERROR_FAILURE,
      `the ${providerId} token endpoint answered without an access token.`,
    );
  }

  // 3. From here the stored refresh token is spent: nothing may stop the
  // result POST. The record is OpenCode's own shape after a refresh.
  const issuedAt = deps.now();
  const access = tokens.access_token;
  const refresh =
    typeof tokens.refresh_token === "string" && tokens.refresh_token !== ""
      ? tokens.refresh_token
      : storedRefresh;
  const expiresIn = tokens.expires_in;
  const jwtExp = jwtClaims(access)?.exp;
  const expires =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? issuedAt + expiresIn * 1000
      : typeof jwtExp === "number" && Number.isFinite(jwtExp)
        ? jwtExp * 1000
        : issuedAt + DEFAULT_EXPIRES_IN_S * 1000;
  const accountId = accountIdFor(descriptor, tokens, record);
  const recordField = descriptor.accountId?.recordField;
  const renewed: Record<string, unknown> = {
    type: "oauth",
    refresh,
    access,
    expires,
    ...(accountId !== undefined && recordField !== undefined
      ? { [recordField]: accountId }
      : {}),
  };
  const value = Buffer.from(JSON.stringify(renewed), "utf8").toString("base64");
  mask(value);
  let encrypted: string;
  try {
    encrypted = seal(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      `the renewed login could not be sealed (${detail}); the stored login was spent.`,
    );
  }
  const sent = await postResult({
    provider: providerId,
    key_id: keyId,
    encrypted_value: encrypted,
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: new Date(expires).toISOString(),
    provider_account_id: accountId ?? null,
  });
  if (!sent.ok) {
    return fail(
      `the Crysk platform did not take the renewed login (${describe(sent.status)}); the stored login was spent, so connect the subscription again from the Crysk dashboard.`,
    );
  }
  deps.stdout(
    `::notice title=crysk::${escapeCommandData(`Renewed the ${providerId} subscription login; it expires at ${new Date(expires).toISOString()}.`)}\n`,
  );
  return 0;
}

// Like the trigger and setup steps: the input arrives on stdin, never in the
// environment of a process bun starts.
const CRYSK_SECRETS_ENV = "CRYSK_SECRETS_INPUT";
const CRYSK_SECRETS_STDIN_FLAG = "--crysk-secrets-stdin";

if (import.meta.main) {
  if ((process.env[CRYSK_SECRETS_ENV] ?? "") !== "") {
    process.stderr.write(
      `crysk: the crysk-secrets input reached credential-refresh.ts through its environment; pipe it on stdin with ${CRYSK_SECRETS_STDIN_FLAG} and run bun with ${CRYSK_SECRETS_ENV} empty.\n`,
    );
    process.exit(1);
  }
  const cryskSecrets = process.argv.includes(CRYSK_SECRETS_STDIN_FLAG)
    ? await Bun.stdin.text()
    : "";
  process.exit(
    await runCredentialRefresh({
      fetch,
      env: process.env,
      cryskSecrets,
      baseUrl: PLATFORM_API_URL,
      stdout: (text) => process.stdout.write(text),
      now: () => Date.now(),
      sleep: (ms) => Bun.sleep(ms),
    }),
  );
}
