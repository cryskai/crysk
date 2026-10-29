// §6.3: redaction occurs BEFORE events, callbacks, logs, persistence, and
// thrown user-visible errors. These patterns are the persisted-witness
// allowlist: anything matching them is replaced wholesale rather than
// partially, because a partially-redacted credential is still a credential.
const REDACTED = "[REDACTED]";

const REDACTION_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+\S+/gi,
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
      PROSE_AFTER_KEYWORD.has(word.toLowerCase().replace(/[^a-z]+$/, ""))
        ? match
        : REDACTED,
  );
}
