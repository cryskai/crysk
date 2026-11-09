// The CRYSK_* secrets intake (odd/tasks/role-model-routing.md, S8/S9, L12-L13).
//
// The workflow names each Crysk secret explicitly and hands them to the action as
// one `crysk-secrets` input of `NAME=value` lines:
//
//   crysk-secrets: |
//     CRYSK_CLAUDE_OAUTH_TOKEN=${{ secrets.CRYSK_CLAUDE_OAUTH_TOKEN }}
//     CRYSK_OPENCODE_DEEPSEEK_API_KEY=${{ secrets.CRYSK_OPENCODE_DEEPSEEK_API_KEY }}
//
// WHY explicit names and never `toJSON(secrets)` (L13): the action, and whatever
// it installs, must never receive the customer's other secrets. A secret the
// repository does not have arrives as an empty value, which counts as absent.
//
// This module is the grammar and nothing else: pure, builtins only (Buffer is a
// global), so the trigger, which runs before `bun install`, can import it later.
// It never prints. Every message it returns names a secret or a line number,
// never a value, and `masks` lists every value the caller must `::add-mask::`
// before it writes anything else.
//
// The names (S8):
//   CRYSK_CLAUDE_OAUTH_TOKEN          Claude Code subscription (`claude setup-token`)
//   CRYSK_CLAUDE_API_KEY              Claude Code on an Anthropic API key
//   CRYSK_OPENCODE_<P>_API_KEY        an OpenCode provider's API key
//   CRYSK_OPENCODE_<P>_OAUTH          base64 of that provider's `opencode auth login` record
// <P> is the Models.dev provider id uppercased with `-` and `.` as `_`
// (opencodeSecretToken). CRYSK_CLAUDE_(OAUTH_TOKEN|API_KEY)_<NAME> is reserved
// for several Claude accounts (S6, out of scope) and ignored with a notice.

export type ClaudeCredentialKind = "subscription" | "api_key";

// The `opencode auth login` record of an OAuth provider. Only `type` is checked:
// the rest is the provider's own shape (access, refresh, expires, ...), carried
// whole into the OpenCode auth file (U3, setup.ts), so the child can refresh it.
export interface OpenCodeOAuthRecord {
  readonly type: "oauth";
  readonly [field: string]: unknown;
}

export interface OpenCodeProviderSecrets {
  apiKey?: string;
  oauth?: OpenCodeOAuthRecord;
}

export interface CryskSecrets {
  // Keyed by the S5 credential kinds, so `credentials.claude` reads it directly.
  readonly claude: { subscription?: string; api_key?: string };
  // Keyed by <P>, the normalized provider token. Look a plan provider up with
  // opencodeSecretsFor, which normalizes the provider: a secret name is never
  // reversed into a provider id (`WAFER_AI` could be `wafer.ai` or `wafer-ai`).
  readonly opencode: ReadonlyMap<string, OpenCodeProviderSecrets>;
}

// The names the engine read before S8. Recorded by presence only, for the clean
// break (U5), which names the new secret for each.
export const LEGACY_SECRET_NAMES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENCODE_AUTH_JSON",
] as const;
export type LegacySecretName = (typeof LEGACY_SECRET_NAMES)[number];

export interface CryskSecretsParse {
  readonly secrets: CryskSecrets;
  // The kept names, sorted. Names only: they are already in the workflow file.
  readonly names: readonly string[];
  // The old names that arrived with a value, in LEGACY_SECRET_NAMES order.
  readonly legacy: readonly LegacySecretName[];
  // Every value to mask, in input order, without repeats.
  readonly masks: readonly string[];
  // Ignored names, for a `::notice::`. Names or line numbers only.
  readonly notices: readonly string[];
  // Non-empty means the input is refused. Names or line numbers only.
  readonly problems: readonly string[];
}

const CLAUDE_NAMES: Readonly<Record<string, ClaudeCredentialKind>> = {
  CRYSK_CLAUDE_OAUTH_TOKEN: "subscription",
  CRYSK_CLAUDE_API_KEY: "api_key",
};
const CLAUDE_RESERVED_RE = /^CRYSK_CLAUDE_(?:OAUTH_TOKEN|API_KEY)_[A-Z0-9_]+$/;
// <P> is exactly the image of opencodeSecretToken: one or more [A-Z0-9] runs
// joined by single underscores. The provider runs up to the fixed suffix, so a
// provider whose own name ends in `_API` still parses (FOO_API + _API_KEY).
const OPENCODE_RE =
  /^CRYSK_OPENCODE_([A-Z0-9]+(?:_[A-Z0-9]+)*)_(API_KEY|OAUTH)$/;
// A line is NAME=value when it starts with an identifier and an `=`; the value
// runs from the FIRST `=`, so base64 padding survives.
const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
// Names printed back are only these: a CRYSK_ name or an old name. Anything else
// may be the tail of a value split across lines (a base64 wrapped at 76
// characters can look like `QQ==`), so it is reported by line number only.
const CRYSK_NAME_RE = /^CRYSK_[A-Z0-9_]+$/;
// Standard base64, padded: what `base64 -w0` and the platform write.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// No credential is this short, and masking one would blank common text such as
// a lone `=` across the whole job log.
const MIN_MASK_LENGTH = 4;
// <P>'s source: a Models.dev style provider id. Dots are accepted (`wafer.ai`)
// and become `_` like dashes, as S8 says; `_` itself stays `_`.
const PROVIDER_ID_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;

const SPLIT_HINT =
  "(a value split across lines? encode _OAUTH secrets with base64 -w0)";

// A plan provider id to the <P> of its secret names, or undefined when no secret
// name can carry it (empty, a leading, trailing or doubled separator, or any
// other character). Two ids that differ only in `-`, `.` or `_` share a token;
// Models.dev has no such pair today.
export function opencodeSecretToken(providerId: string): string | undefined {
  if (!PROVIDER_ID_RE.test(providerId)) return undefined;
  return providerId.toUpperCase().replace(/[.-]/g, "_");
}

export function opencodeSecretsFor(
  secrets: CryskSecrets,
  providerId: string,
): OpenCodeProviderSecrets | undefined {
  const token = opencodeSecretToken(providerId);
  return token === undefined ? undefined : secrets.opencode.get(token);
}

// U3 (L12 decision 5): an `_OAUTH` secret is read for this provider only, the
// one whose subscription record the engine projects (OPENCODE_OAUTH_PROVIDER in
// security/credential-broker.ts, not imported so this module stays builtins-only;
// a test pins the two equal). Another provider's OAuth record has no broker yet.
export const OPENCODE_OAUTH_SECRET_PROVIDER = "openai";

export type OpenCodeSecretChoice =
  | {
      readonly kind: "oauth" | "api_key";
      // The secret whose value builds the provider's auth record.
      readonly secret: string;
      // A secret of the same provider that is set but not used.
      readonly unused?: string;
      readonly problem?: undefined;
    }
  | { readonly problem: string; readonly kind?: undefined };

// Which CRYSK_* secret serves an OpenCode provider, from the secret NAMES alone,
// so the setup step that writes the auth record and credentialKindForRoute, which
// binds the kind, read one rule and cannot disagree. Undefined when no secret
// serves it. The subscription comes first (L12 decision 4), like the Claude
// order's default. The provider is normalized with opencodeSecretToken; a secret
// name is never reversed into a provider.
// outcome.ts matches this refusal to give it its own fix (the provider's
// _API_KEY); test/ci/publish.test.ts runs this function's text through it.
const UNSUPPORTED_OAUTH_TEXT = `is an OpenCode subscription record, which Crysk reads only for ${OPENCODE_OAUTH_SECRET_PROVIDER} for now`;
export function chooseOpenCodeSecret(
  providerId: string,
  names: readonly string[],
): OpenCodeSecretChoice | undefined {
  const token = opencodeSecretToken(providerId);
  if (token === undefined) return undefined;
  const apiKey = `CRYSK_OPENCODE_${token}_API_KEY`;
  const oauth = `CRYSK_OPENCODE_${token}_OAUTH`;
  const hasApiKey = names.includes(apiKey);
  if (names.includes(oauth)) {
    if (providerId !== OPENCODE_OAUTH_SECRET_PROVIDER) {
      return {
        problem: `${oauth} ${UNSUPPORTED_OAUTH_TEXT}; set ${apiKey} instead`,
      };
    }
    return hasApiKey
      ? { kind: "oauth", secret: oauth, unused: apiKey }
      : { kind: "oauth", secret: oauth };
  }
  return hasApiKey ? { kind: "api_key", secret: apiKey } : undefined;
}

// What the setup step may tell later steps: names and kinds, never a value.
export function cryskSecretsPresence(parse: CryskSecretsParse): {
  names: string[];
  claude: ClaudeCredentialKind[];
  opencodeProviders: string[];
} {
  const claude = (["subscription", "api_key"] as const).filter(
    (kind) => parse.secrets.claude[kind] !== undefined,
  );
  return {
    names: [...parse.names],
    claude,
    opencodeProviders: [...parse.secrets.opencode.keys()].sort(),
  };
}

type OAuthDecode =
  | { ok: true; record: OpenCodeOAuthRecord; leaves: string[] }
  | { ok: false; problem: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every string inside the record but its top-level `type`: GitHub registered the
// base64 text as the secret, never the tokens inside it, so these masks are the
// only thing that hides a decoded access or refresh token.
function stringLeaves(value: unknown, out: string[], skipType: boolean): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out, false);
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (skipType && key === "type") continue;
      stringLeaves(item, out, false);
    }
  }
}

function decodeOAuth(name: string, value: string): OAuthDecode {
  // Buffer.from(x, "base64") skips characters outside the alphabet without a
  // word, so the alphabet and the padded length are checked first.
  if (!BASE64_RE.test(value) || value.length % 4 !== 0) {
    return {
      ok: false,
      problem: `${name} is not base64 (encode the OpenCode auth record with base64 -w0)`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, problem: `${name} does not decode to a JSON object` };
  }
  if (parsed.type !== "oauth") {
    return {
      ok: false,
      problem: `${name} is not an OpenCode OAuth record (its type is not "oauth")`,
    };
  }
  const leaves: string[] = [];
  stringLeaves(parsed, leaves, true);
  return { ok: true, record: parsed as OpenCodeOAuthRecord, leaves };
}

export function parseCryskSecrets(raw: string): CryskSecretsParse {
  const claude: { subscription?: string; api_key?: string } = {};
  const opencode = new Map<string, OpenCodeProviderSecrets>();
  const names = new Set<string>();
  const legacy = new Set<LegacySecretName>();
  const masks: string[] = [];
  const notices: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  const mask = (text: string) => {
    if (text.length >= MIN_MASK_LENGTH && !masks.includes(text)) {
      masks.push(text);
    }
  };

  const lines = raw.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === "") continue;
    const lineNo = index + 1;
    const match = LINE_RE.exec(line);
    if (match === null) {
      mask(line);
      problems.push(
        `line ${lineNo} of the crysk-secrets input is not NAME=value ${SPLIT_HINT}`,
      );
      continue;
    }
    const name = match[1] as string;
    const value = (match[2] as string).trim();
    const printable =
      CRYSK_NAME_RE.test(name) ||
      (LEGACY_SECRET_NAMES as readonly string[]).includes(name);

    if (!printable) {
      mask(line);
      if (value !== "") mask(value);
      notices.push(
        `line ${lineNo} of the crysk-secrets input is not a Crysk credential; it is ignored.`,
      );
      continue;
    }
    // Empty counts as absent: a secret the repository does not have arrives as
    // `NAME=` from `${{ secrets.NAME }}`.
    if (value === "") continue;
    mask(value);

    if ((LEGACY_SECRET_NAMES as readonly string[]).includes(name)) {
      legacy.add(name as LegacySecretName);
      continue;
    }
    if (CLAUDE_RESERVED_RE.test(name)) {
      notices.push(
        `${name} is reserved for several Claude accounts, which Crysk does not read yet; it is ignored.`,
      );
      continue;
    }

    const claudeKind = CLAUDE_NAMES[name];
    const opencodeMatch = OPENCODE_RE.exec(name);
    if (claudeKind === undefined && opencodeMatch === null) {
      notices.push(`${name} is not a Crysk credential name; it is ignored.`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`${name} is given more than once`);
      continue;
    }
    seen.add(name);

    if (claudeKind !== undefined) {
      claude[claudeKind] = value;
      names.add(name);
      continue;
    }
    const token = (opencodeMatch as RegExpExecArray)[1] as string;
    const kind = (opencodeMatch as RegExpExecArray)[2];
    const entry: OpenCodeProviderSecrets = opencode.get(token) ?? {};
    if (kind === "API_KEY") {
      entry.apiKey = value;
    } else {
      const decoded = decodeOAuth(name, value);
      if (!decoded.ok) {
        problems.push(decoded.problem);
        continue;
      }
      for (const leaf of decoded.leaves) mask(leaf);
      entry.oauth = decoded.record;
    }
    opencode.set(token, entry);
    names.add(name);
  }

  return {
    secrets: { claude, opencode },
    names: [...names].sort(),
    legacy: LEGACY_SECRET_NAMES.filter((name) => legacy.has(name)),
    masks,
    notices,
    problems,
  };
}
