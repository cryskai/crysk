// T5b: the CI-side adjudicator's record (odd/tasks/agent-first-ci.md, D5).
//
// A `/pr-hero recheck` run asks the adjudicator to rule on the author's latest
// `dismissed` reply to a blocking finding, and posts the ruling as a reply on the
// finding's thread. That reply is the only CI verdict the gate trusts, and only
// when all of these hold:
//   - GitHub says the reply's author is CI_ADJUDICATOR_LOGIN. The marker's own
//     text proves nothing, since anyone can type it;
//   - its `reply=` names the comment id of the thread's LATEST triage reply, so a
//     newer dismissal is pending again;
//   - that triage reply is `dismissed`, and the verdict is `upheld` (D5: only a
//     dismissal leaves the count; `deferred` and `misclassified` never do);
//   - its `head=` is the head under review.
// A run under a token whose login is not CI_ADJUDICATOR_LOGIN posts replies the
// gate never trusts, so it fails closed: the finding stays counted.

export const ADJUDICATION_MARKER_PREFIX = "<!-- pr-hero-adjudication ";

// The login GitHub stamps on comments posted with the workflow's GITHUB_TOKEN.
export const CI_ADJUDICATOR_LOGIN = "github-actions[bot]";

// The most adjudicator calls one run makes. A pending dismissal past the cap
// stays pending, still counted, and the next recheck takes it.
export const MAX_ADJUDICATIONS_PER_RUN = 5;

export type AdjudicationVerdict = "upheld" | "rejected" | "inconclusive";

const ADJUDICATION_VERDICTS: ReadonlySet<string> = new Set<AdjudicationVerdict>(
  ["upheld", "rejected", "inconclusive"],
);

const FULL_SHA = /^[0-9a-f]{40}$/;
const COMMENT_ID = /^[1-9][0-9]{0,19}$/;

export interface AdjudicationMarker {
  verdict: AdjudicationVerdict;
  // The comment id of the author's triage reply this verdict rules on.
  reply: number;
  // The head the adjudicator read. A verdict counts only on that head: a push may
  // change the code it ruled on, so a later head needs a new recheck.
  head: string;
}

export function adjudicationMarker(marker: AdjudicationMarker): string {
  return `${ADJUDICATION_MARKER_PREFIX}verdict=${marker.verdict} reply=${marker.reply} head=${marker.head} -->`;
}

// Parses only the first line, and returns null for anything malformed, the same
// discipline as parseTriageMarker (src/triage/triage.ts).
export function parseAdjudicationMarker(
  body: string,
): AdjudicationMarker | null {
  if (!body.startsWith(ADJUDICATION_MARKER_PREFIX)) return null;
  const firstLine = body.split("\n", 1)[0] ?? "";
  if (!firstLine.endsWith(" -->")) return null;
  const fields = firstLine.slice(
    ADJUDICATION_MARKER_PREFIX.length,
    firstLine.length - " -->".length,
  );
  const parts = new Map<string, string>();
  for (const token of fields.split(" ")) {
    if (token.length === 0) continue;
    const eq = token.indexOf("=");
    if (eq === -1) return null;
    const key = token.slice(0, eq);
    if (parts.has(key)) return null;
    parts.set(key, token.slice(eq + 1));
  }
  if (parts.size !== 3) return null;
  const verdict = parts.get("verdict");
  const reply = parts.get("reply");
  const head = parts.get("head");
  if (verdict === undefined || !ADJUDICATION_VERDICTS.has(verdict)) return null;
  if (reply === undefined || !COMMENT_ID.test(reply)) return null;
  if (head === undefined || !FULL_SHA.test(head)) return null;
  const replyId = Number(reply);
  if (!Number.isSafeInteger(replyId)) return null;
  return {
    verdict: verdict as AdjudicationVerdict,
    reply: replyId,
    head,
  };
}

// One pending dismissal the adjudicator rules on.
export interface AdjudicationSubject {
  priorId: string;
  // The finding's own review comment: the thread the verdict is posted on.
  threadId: number;
  // The author's `dismissed` reply the verdict names.
  replyId: number;
  sev: string;
  locs: readonly string[];
  claim: string;
  // The author's argument: the triage reply's body below its marker line.
  argument: string;
}

export interface AdjudicationOutcome {
  priorId: string;
  threadId: number;
  replyId: number;
  verdict: AdjudicationVerdict;
  // path:line citations the adjudicator gave. Empty when it failed.
  evidence: string[];
  // Set when no ruling exists: the step failed or timed out, the argument forged
  // the nonce, or no refuter is configured. The verdict is then "inconclusive" and
  // nothing is posted, so the dismissal stays pending and a later recheck rules on it.
  failed?: true;
}
