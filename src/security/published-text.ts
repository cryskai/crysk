// Text a model wrote about author-controlled input, on its way to a public
// surface: PR comments, the step summary, the state block. A pull request can
// steer what the model says, so GitHub must not act on any of it.
//
// WHY shapes and not the keyword rules of redact.ts: those are for error
// messages, where `password hunter2` is a leak. A finding is ABOUT code, so
// "the password field" and `token = getToken()` have to survive it. Redacting
// a word out of a claim would corrupt the review to protect nothing.
//
// WHY every quantifier that can start at many positions has a bound: this runs
// on whatever the model printed, and an unbounded prefix rescans from each
// character. One long word must not be able to stall publication.

const REDACTED = "[REDACTED]";
const ZERO_WIDTH_SPACE = "\u200b";

const SECRET_SHAPES: readonly RegExp[] = [
  // Runs to the end of the text when the closing line was cut off: half a
  // private key is still a private key.
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // The length floor keeps "the Bearer token is missing".
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
];

const URL_CREDENTIALS =
  /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]{0,256}:[^\s/@]{1,256}@/gi;

// Upper-case names only, as in a committed `.env`. `=(?!=)` keeps a comparison.
const ENV_ASSIGNMENT =
  /\b((?:[A-Z][A-Z0-9_]{0,60}_)?(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|CREDENTIALS?)\s*=(?!=)\s*)["']?[^\s"',;]+["']?/g;

export function redactSecrets(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, REDACTED);
  return out
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(ENV_ASSIGNMENT, `$1${REDACTED}`);
}

// A zero-width space leaves the text reading the same and stops GitHub from
// parsing a mention, an image or a tag out of it. Breaking `<` also means no
// model text can spell a marker the comment parsers read (`<!-- crysk-state`).
//
// Idempotent, because a posted claim is read back from its comment or the state
// block and rendered again.
function defuseMarkup(text: string): string {
  return text
    .replace(/@(?!\u200b)/g, `@${ZERO_WIDTH_SPACE}`)
    .replaceAll("![", `!${ZERO_WIDTH_SPACE}[`)
    .replace(/<(?=[a-zA-Z/!?])/g, `<${ZERO_WIDTH_SPACE}`)
    .replaceAll("-->", `--${ZERO_WIDTH_SPACE}>`);
}

export function publishedText(text: string): string {
  return defuseMarkup(redactSecrets(text));
}
