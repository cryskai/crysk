import { parseFindingMarker } from "#pr/preflight";
import { parseTriageMarker, triageMarker } from "#triage/triage";

// triage-without-skill S1: a team without the crysk-loop skill answers a finding with a plain comment, and it
// must not stay blocked for that. A reply in a finding's inline thread whose text starts with the word
// "applied" (any case) reads as the marker `crysk triage reply` would have written for it: `applied` at the
// head the finding was posted on, by a human. Only `applied`: the other tags carry an adjudicator's verdict,
// which a plain comment cannot. The reply still has to pass every rule a marked one does (its author's write
// access, the staleness rule, the newest reply in the thread), because those run on the rewritten body.
const PLAIN_APPLIED = /^\s*applied\b/i;

export function isPlainApplied(body: string): boolean {
  return parseTriageMarker(body) === null && PLAIN_APPLIED.test(body);
}

// The comments with each plain `applied` reply rewritten to carry the marker its finding implies. A comment
// that already carries a marker, or that does not reply to a finding comment in the same list, is left as it
// is, so applying this twice changes nothing.
export function withPlainAppliedReplies<
  T extends { id?: number; body: string; in_reply_to_id?: number | null },
>(comments: readonly T[]): T[] {
  const findingHeads = new Map<number, string>();
  for (const comment of comments) {
    if (comment.id === undefined) continue;
    const marker = parseFindingMarker(comment.body);
    if (marker !== null) findingHeads.set(comment.id, marker.headSha);
  }
  if (findingHeads.size === 0) return [...comments];
  return comments.map((comment) => {
    const parent = comment.in_reply_to_id;
    if (parent === undefined || parent === null) return comment;
    const headSha = findingHeads.get(parent);
    if (headSha === undefined || !isPlainApplied(comment.body)) return comment;
    const marker = triageMarker({ tag: "applied", headSha, actor: "human" });
    return { ...comment, body: `${marker}\n\n${comment.body.trim()}` };
  });
}
