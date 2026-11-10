const MAX_BYTES = 4 * 1024 * 1024;
const REDACTED = "[REDACTED]";
const SECRET =
  /authorization|cookie|password|secret|api.?key|access.?token|refresh.?token|^token$|^key$/i;

// The words of an identifier, lower-cased. camelCase, snake_case, kebab-case
// and dotted names split the same way: `AWS_SECRET_ACCESS_KEY` and
// `awsSecretAccessKey` both give aws, secret, access, key.
export function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
}

const SECRET_WORDS = new Set([
  "secret",
  "secrets",
  "password",
  "passwords",
  "passwd",
  "passphrase",
  "apikey",
  "apitoken",
  "accesskey",
  "accesstoken",
  "authtoken",
  "privatekey",
  "secretkey",
  "clientsecret",
  "refreshtoken",
]);
const KEY_QUALIFIERS = new Set([
  "api",
  "access",
  "private",
  "secret",
  "client",
  "signing",
  "encryption",
  "master",
  "session",
]);

// Whether a name says its value is a credential: it holds a secret or password
// word anywhere, or it ends in `token` or in a qualified `key` (api, access,
// private...). Counts and descriptors survive: `max_tokens`, `token_type`,
// `tokenCount` and `apiKeySource` are not credentials.
export function isSecretName(name: string): boolean {
  const parts = nameParts(name);
  const last = parts.at(-1);
  if (last === undefined) return false;
  if (parts.some((part) => SECRET_WORDS.has(part))) return true;
  if (last === "token") return true;
  const qualifier = parts.at(-2);
  return (
    last === "key" && qualifier !== undefined && KEY_QUALIFIERS.has(qualifier)
  );
}

// Every pattern below stops at quotes and backslashes, so it can run on JSON
// text without breaking the parse that follows. Each one starts only where a
// run begins (lookbehind, not \b), so a long run of word characters is
// scanned once, not once per character.
const PEM_PRIVATE_KEY =
  /-----BEGIN[A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----(?:[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----|(?:[A-Za-z0-9+/=\s]|\\[nr])*)/g;
// `scheme://user:password@`, for every scheme: postgres, mysql, mongodb+srv,
// redis, amqp. The user goes too, since it is often a key id.
const URL_CREDENTIALS =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"<>\\]*:[^\s/@'"<>\\]+@/gi;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const STRIPE_KEY = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g;
const JWT =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
// `"name": "value"`, `name = 'value'` and `{\"name\":\"value\"}`: the value
// is quoted, so code such as `token_count = usage.total` keeps reading.
const QUOTED_ASSIGNMENT =
  /(?<![\w.-])([\w.-]+)(\\*["']?\s*[=:]\s*\\*["'])([^"'\\\r\n]+)/g;
// `NAME=value` and `name: value` in env, ini and YAML files, for UPPER_SNAKE,
// snake_case and kebab-case names. camelCase is left to the quoted form unless
// the caller asks for it, so `privateKey = loadKey()` in a code window reads as
// before; the session copy asks, since a YAML file spells `privateKey: abc`.
const UNQUOTED_ASSIGNMENT =
  /(?<![\w.-])([A-Za-z][\w-]*)(\s*[=:]\s*)([^\s,;&"'\\]+)/g;

/**
 * The credential shapes that need no surrounding context, plus assignments to
 * a name `isSecret` accepts. Safe on JSON text: it never removes a quote.
 */
export function redactSecretShapes(
  value: string,
  isSecret: (name: string) => boolean = isSecretName,
  unquotedCamelCase = false,
): string {
  return value
    .replace(PEM_PRIVATE_KEY, REDACTED)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(AWS_ACCESS_KEY_ID, REDACTED)
    .replace(STRIPE_KEY, REDACTED)
    .replace(JWT, REDACTED)
    .replace(QUOTED_ASSIGNMENT, (match, name: string, separator: string) =>
      isSecret(name) ? `${name}${separator}${REDACTED}` : match,
    )
    .replace(UNQUOTED_ASSIGNMENT, (match, name: string, separator: string) =>
      (unquotedCamelCase || !/[a-z][A-Z]/.test(name)) && isSecret(name)
        ? `${name}${separator}${REDACTED}`
        : match,
    );
}

export function redactEvidenceText(value: string): string {
  return redactSecretShapes(value)
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:[^\r\n]*/gi,
      "[REDACTED HEADER]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (text) => {
      try {
        const url = new URL(text);
        url.username = "";
        url.password = "";
        for (const key of [...url.searchParams.keys()])
          if (SECRET.test(key)) url.searchParams.set(key, "[REDACTED]");
        return url.toString();
      } catch {
        return "[REDACTED URL]";
      }
    })
    .replace(
      /\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|Bearer\s+[^\s,;]+)/gi,
      "[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[=:]\s*)[^\s,;&]+/gi,
      "$1[REDACTED]",
    );
}
/** JSON-only bounded traversal: never call getters, custom iterators or toJSON. */
export function redactEvidence(
  value: unknown,
  depth = 0,
  budget = { nodes: 0 },
): unknown {
  if (++budget.nodes > 20000 || depth > 12)
    throw new Error("capture shape limit");
  if (typeof value === "string") {
    if (value.length > MAX_BYTES) throw new Error("capture string limit");
    return redactEvidenceText(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (value === undefined) return null;
  if (typeof value !== "object") throw new Error("non-JSON capture value");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null)
    throw new Error("non-JSON capture object");
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (key === "length" && Array.isArray(value)) continue;
    if (!("value" in descriptor)) throw new Error("capture accessor rejected");
    if (!descriptor.enumerable) continue;
    result[key] = SECRET.test(key)
      ? "[REDACTED]"
      : redactEvidence(descriptor.value, depth + 1, budget);
  }
  return Array.isArray(value) ? Object.values(result) : result;
}
