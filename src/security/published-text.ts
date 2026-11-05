// Text a model wrote about author-controlled input, on its way to a public
// surface: PR comments, the step summary, the state block. A pull request can
// steer what the model says, so GitHub must not act on any of it.
//
// WHY shapes and not the keyword rules of redact.ts: those are for error
// messages, where `password hunter2` is a leak. A finding is ABOUT code, so
// "the password field" and `const TOKEN = getToken()` have to survive it.
//
// WHY every repeat that can start at many positions has a bound: this runs on
// whatever the model printed, and one long word must not stall publication.
//
// What each defusal does was checked against GitHub's own renderer
// (`gh api markdown --mode gfm`), not assumed.

const REDACTED = "[REDACTED]";
const ZERO_WIDTH_SPACE = "\u200b";

// `(?<![A-Za-z0-9])` instead of `\b`: `\b` does not fire after `_`, and
// `_ghp_..._` is a token in Markdown emphasis.
const SECRET_SHAPES: readonly RegExp[] = [
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // The prefixed form and the older unbroken form. A bare `sk-` plus hyphens is
  // what a CSS class looks like.
  /(?<![A-Za-z0-9])sk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{32,}/g,
  /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9])xox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}/g,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}\b/g,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  // A digit is required: `Bearer verifyAccessTokenSignature` names a function.
  /(?<![A-Za-z0-9])Bearer\s+(?=[A-Za-z0-9._~+/=-]{0,512}\d)[A-Za-z0-9._~+/=-]{20,}/gi,
];

// `user:password@`, or a long user-only token. `git@` is a username, and `$`,
// `{` and `<` mean a placeholder (`redis://:${REDIS_PASSWORD}@cache`).
const URL_CREDENTIALS =
  /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)(?:[^\s/?#${<]{0,256}:[^\s/?#${<]{1,256}|[^\s/?#${<:@]{20,256})@/gi;

// An upper-case secret name holding a literal, as in a committed `.env` or YAML
// file. A value that is code stays: `TOKEN = getToken()`, `API_KEY=$(...)`,
// `KEY = process.env.KEY`. An unquoted value after a colon needs a digit, so a
// type annotation (`API_KEY: string`) stays too.
const SECRET_NAME =
  "[A-Z0-9_]{0,40}(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]{0,40}";
const UNQUOTED_VALUE = "[A-Za-z0-9_+/=@%!#^*~:-]{6,256}(?![A-Za-z0-9_.(\\[{$])";
const ENV_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9_])(${SECRET_NAME})(?:` +
    `(\\s*[=:](?![=:])\\s*)(?:"(?!\\$)[^"\\n]{6,256}"|'(?!\\$)[^'\\n]{6,256}')` +
    `|(=(?![=:]))(?!\\d+(?:[\\s,;]|$))${UNQUOTED_VALUE}` +
    `|(:\\s*)(?=[^\\s]{0,256}\\d)(?!\\d+(?:[\\s,;]|$))${UNQUOTED_VALUE}` +
    ")",
  "g",
);

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_BODY = /(?:\s*[A-Za-z0-9+/=]{16,})*/y;

// Up to the closing line, or, when that was cut off, across the base64 lines:
// half a private key is still a private key, and the sentence after it is not
// part of the key. A loop and not one regex, so many openers with no closer stay
// linear.
function redactPrivateKeys(text: string): string {
  if (!text.includes("PRIVATE KEY")) return text;
  let out = "";
  let from = 0;
  let noMoreEnds = false;
  PEM_BEGIN.lastIndex = 0;
  for (;;) {
    const begin = PEM_BEGIN.exec(text);
    if (begin === null) break;
    let to = PEM_BEGIN.lastIndex;
    let closed = false;
    if (!noMoreEnds) {
      PEM_END.lastIndex = to;
      closed = PEM_END.test(text);
      if (closed) to = PEM_END.lastIndex;
      else noMoreEnds = true;
    }
    if (!closed) {
      PEM_BODY.lastIndex = to;
      PEM_BODY.test(text);
      to = PEM_BODY.lastIndex;
    }
    out += text.slice(from, begin.index) + REDACTED;
    from = to;
    PEM_BEGIN.lastIndex = to;
  }
  return out + text.slice(from);
}

export function redactSecrets(text: string): string {
  let out = redactPrivateKeys(text);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, REDACTED);
  return out
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(
      ENV_ASSIGNMENT,
      (
        _match: string,
        name: string,
        quoted?: string,
        equals?: string,
        colon?: string,
      ) => `${name}${quoted ?? equals ?? colon ?? ""}${REDACTED}`,
    );
}

// A secret was removed from this text, so the words around it are not all the
// words the model wrote. A guard reading it for safety content must not treat it
// as complete.
export function wasRedacted(text: string): boolean {
  return text.includes(REDACTED);
}

// A zero-width space reads the same and stops GitHub from parsing a mention, an
// image or a tag out of the text. Breaking `<` also means no model text can spell
// a marker the comment parsers read. `@` after a letter, digit or `/` is left
// alone because GitHub does not read it as a mention, and emails, URLs and
// `src/@types` stay copyable. `&` is broken because `&#64;octocat` IS a mention.
//
// Idempotent, because a posted claim is read back from its comment and rendered
// again.
function defuseMarkup(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9/])@(?!\u200b)/g, `@${ZERO_WIDTH_SPACE}`)
    .replace(/&(?=#|commat)/gi, `&${ZERO_WIDTH_SPACE}`)
    .replaceAll("![", `!${ZERO_WIDTH_SPACE}[`)
    .replace(/<(?=[a-zA-Z/!?])/g, `<${ZERO_WIDTH_SPACE}`)
    .replaceAll("-->", `--${ZERO_WIDTH_SPACE}>`);
}

export function publishedText(text: string): string {
  return defuseMarkup(redactSecrets(text));
}
