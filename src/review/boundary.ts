// The boundary-tag rule (C4, `docs/c4-preamble-design.md` §3.3-§3.4): every
// block of a prompt that this engine did not author is wrapped in a named tag
// carrying a per-run nonce, so text inside it cannot end its own block and
// speak as the engine.
//
// This module is driver source: it is covered by the engine version, NOT by
// the prompt-set fingerprint. A prompt-set edit can neither add a tag nor
// remove one.
//
// WHY a nonce instead of Cloudflare's strip (`docs/cloudflare-ai-code-review.md`
// :186-193). Cloudflare deletes boundary-tag names from user content because a
// FIXED tag vocabulary can be forged from inside that content. Their inputs are
// MR bodies and comments, where deleting a stray `</mr_body>` costs nothing.
// Our first and largest block is a diff: stripping `</patch>`-shaped strings
// out of it corrupts the code under review — a legitimate PR can add exactly
// those literals, and a reviewer reading mutated source produces findings about
// code that does not exist. That is a worse failure than the one being
// prevented. A nonce closes the same hole without touching a byte, because the
// tag name cannot be forged by content that was fixed before the nonce existed.

// Closed vocabulary. Item 7 widens it here, not at a call site, so a new
// untrusted block cannot be wrapped under an invented tag name.
export type BoundaryTag =
  | "patch"
  | "scout_leads"
  | "finding"
  | "findings"
  | "gotchas"
  | "priors"
  | "previous_finding"
  | "author_reply"
  | "comment_body"
  | "triage_tag";

// 8 hex characters: short enough to cost nothing in a prompt, wide enough
// (2^32) that guessing it from inside attacker-authored content is not a
// strategy. Fixed here rather than at the call site so every artifact this
// engine writes carries the same shape.
export const BOUNDARY_NONCE_CHARS = 8;

// Bounded, because an unbounded regeneration loop against content that somehow
// contains every draw would hang a paid run instead of failing it.
export const MAX_NONCE_ATTEMPTS = 16;

export class BoundaryNonceError extends Error {}

export function generateBoundaryNonce(): string {
  const bytes = new Uint8Array(BOUNDARY_NONCE_CHARS / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ONE definition of "this block could forge its own closing tag", shared by
// nonce selection and by every driver-side guard. Two spellings of this
// predicate is how one of them ends up subtly weaker than the other.
export function blockForgesNonce(content: string, nonce: string): boolean {
  return content.includes(nonce);
}

// O-3.3. The nonce is chosen against the blocks that exist when it is chosen —
// the patch, the operator gotchas, the operator priors — and regenerated on
// collision. Astronomically unlikely, cheap to check, and the check is what
// makes the guarantee a guarantee rather than an argument about probability.
//
// `generate` is injectable so a test can force a collision on the first draw;
// production never passes it.
export function selectBoundaryNonce(
  blocks: string[],
  generate: () => string = generateBoundaryNonce,
): string {
  for (let attempt = 0; attempt < MAX_NONCE_ATTEMPTS; attempt++) {
    const nonce = generate();
    if (!blocks.some((block) => blockForgesNonce(block, nonce))) return nonce;
  }
  throw new BoundaryNonceError(
    `no boundary nonce survived ${MAX_NONCE_ATTEMPTS} attempts against ${blocks.length} blocks`,
  );
}

// EMPTY CONTENT RENDERS TO THE EMPTY STRING, never to an empty tag pair. This
// is load-bearing twice over: `renderLeadsBlock` already returns "" so a scout
// that found nothing produces the control arm's byte-identical hunter prompt
// (`review/scout.ts`'s note on M6), and an empty priors list must likewise leave no
// trace in a system prompt. A `<scout_leads nonce></scout_leads nonce>` pair
// would break both.
//
// Throwing on a forged nonce is the last line of defence, not the first: every
// block whose content can arrive after the nonce was committed is guarded by
// the driver before it reaches here (see `runScout` and `runRefuter`), because
// a throw at prompt-composition time would kill a paid run. A throw that does
// escape means a block reached composition unguarded — which is a defect to
// see, not one to paper over by shipping a forgeable boundary.
export function wrapBlock(
  tag: BoundaryTag,
  nonce: string,
  content: string,
): string {
  if (content.length === 0) return "";
  if (blockForgesNonce(content, nonce)) {
    throw new BoundaryNonceError(
      `<${tag}> content carries the run's boundary nonce and could forge its own closing tag`,
    );
  }
  return `<${tag} ${nonce}>\n${content}\n</${tag} ${nonce}>`;
}
