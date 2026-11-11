// §6.3: redaction occurs BEFORE events, callbacks, logs, persistence, and
// thrown user-visible errors. These patterns are the persisted-witness
// allowlist: anything matching them is replaced wholesale rather than
// partially, because a partially-redacted credential is still a credential.
const REDACTED = "[REDACTED]";

const REDACTION_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+\S+/gi,
  // Google API keys: `AIza` and 35 characters.
  /AIza[0-9A-Za-z_-]{35}/g,
  // Groq (`gsk_`) and xAI (`xai-`) keys. The minimum length keeps model and
  // provider names that share the prefix (`xai-grok-4`) readable.
  /gsk_[A-Za-z0-9]{20,}/g,
  /xai-[A-Za-z0-9]{20,}/g,
];

// A keyword followed by a value: `token: abc`, `api_key="abc"`, `password hunter2`. When
// only whitespace separates the two, the next word may be ordinary prose ("access token is
// invalid"), which is the provider's sentence and not a secret. Those few words are kept; any
// other word after whitespace, and anything after a delimiter, is still treated as a value.
const KEYWORD_VALUE = /(api[_-]?key|token|password)((?:["':=]|\s)+)(\S+)/gi;
const PROSE_AFTER_KEYWORD = new Set([
  "is",
  "was",
  "are",
  "were",
  "has",
  "have",
  "had",
  "will",
  "would",
  "can",
  "could",
  "must",
  "should",
  "not",
  "no",
  "in",
  "on",
  "at",
  "of",
  "or",
  "and",
  "to",
  "for",
  "from",
  "with",
  "expired",
  "invalid",
  "rejected",
  "revoked",
  "missing",
  "required",
  "provided",
  "found",
  "refused",
  "denied",
]);

export function redactDiagnostic(text: string): string {
  let redacted = text;
  for (const pattern of REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted.replace(
    KEYWORD_VALUE,
    (match: string, _keyword: string, separator: string, word: string) =>
      /^\s+$/.test(separator) &&
      // Only trailing sentence punctuation is ignored: `is1234` or `no123!` is a value
      // that happens to start with a prose word, and stays redacted.
      PROSE_AFTER_KEYWORD.has(word.toLowerCase().replace(/[.,;:!?)\]"']+$/, ""))
        ? match
        : REDACTED,
  );
}

// Plain hex and base64 are NOT in REDACTION_PATTERNS: error output and logs
// carry commit SHAs and digests, and redacting them would hide the evidence.
// They are refused only where a whole config value is validated (a model name,
// an effort, a config key), which never holds a SHA or a digest.
//
// Hex: 32 characters or more, the shortest common key length (MD5-sized).
const WHOLE_HEX = /^[0-9a-fA-F]{32,}$/;
// Base64: 40 characters or more of the standard alphabet plus `_`, padding
// allowed, with upper case, lower case and a digit. `-` and `.` are left out
// on purpose: model ids are hyphenated or dotted words
// (`Llama-4-Maverick-17B-128E-Instruct-FP8`), keys are not.
const WHOLE_BASE64 = /^[A-Za-z0-9+/_]{40,}={0,2}$/;

function isLongBase64(value: string): boolean {
  return (
    WHOLE_BASE64.test(value) &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /[0-9]/.test(value)
  );
}

// Whether a whole config value looks like a credential: a key shape that
// redactDiagnostic knows, or a long plain hex or base64 value.
export function looksLikeCredential(value: string): boolean {
  return (
    redactDiagnostic(value) !== value ||
    WHOLE_HEX.test(value) ||
    isLongBase64(value)
  );
}

// A config value for a message: `[REDACTED]` when the whole value looks like a
// credential, otherwise redactDiagnostic's output.
export function redactConfigValue(value: string): string {
  if (WHOLE_HEX.test(value) || isLongBase64(value)) return REDACTED;
  return redactDiagnostic(value);
}
