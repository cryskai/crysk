// Triage reply marker (ROADMAP B6b) — pure. The FIRST line of the consumer's
// coding agent's reply in a finding's own thread, so a future reader (a
// human, or 6c's ledger write-back) can tell "this finding was triaged" from
// "nobody has looked yet" without parsing prose.
//
// NO I/O. Same contract as pr/preflight.ts/pr/inline.ts: no gh, no git, no
// network, no filesystem, no clock. The consuming skill (this repo's
// `skills/pr-hero-triage/`) runs in the CONSUMER's coding agent, outside
// this process entirely — this module only defines the wire format both
// sides agree on.
//
import { MARKER_OPEN, matchMarkerPrefix } from "../brand";

// Disjoint from PR_COMMENT_MARKER_PREFIX and PR_FINDING_MARKER_PREFIX on
// purpose, same reasoning as their own disjointness (pr/preflight.ts): a
// triage reply lands in the SAME comment stream as the summary and the
// per-finding markers (review comment threads and issue comments alike), so
// a matcher that could confuse any of the three families would misfile a
// reply as a finding, or a finding as a reply. See the three-way
// disjointness test in test/triage/triage.test.ts.
export const TRIAGE_MARKER_PREFIX = `${MARKER_OPEN}triage `;

// The FOUR tags an author may write (ROADMAP B6b table) — deliberately NOT
// the `refuter_verdict` schema enum (review/findings.ts), which is sacred under
// rule 5 and not ours to extend. This is a separate, project-owned
// vocabulary the triage loop invented, so adding a tag here costs no schema
// change and no coordination with the lab.
export type TriageTag = "applied" | "dismissed" | "deferred" | "misclassified";

const TRIAGE_TAGS: ReadonlySet<string> = new Set<TriageTag>([
  "applied",
  "dismissed",
  "deferred",
  "misclassified",
]);

// Who wrote the tag. Mirrors 6c's `actor` field on ComparisonRow (not wired
// here — this module only defines the marker both sides read/write) so a
// reader can eventually tell "a human overrode this row" from "the agent
// decided" without a second vocabulary.
export type TriageActor = "agent" | "human";

const TRIAGE_ACTORS: ReadonlySet<string> = new Set<TriageActor>([
  "agent",
  "human",
]);

// The adjudicator's own vocabulary (ROADMAP B6b "What the adjudicator
// returns"), NOT the same set as TriageTag — the author's tag is what they
// claim, this is what the isolated judge independently ruled. Deliberately
// disjoint from `refuter_verdict` (review/findings.ts) for the same reason TriageTag
// is: that enum is schema-shared with the lab and sacred under rule 5, this
// one is project-owned and costs no coordination to extend.
export type TriageVerdict = "upheld" | "rejected" | "inconclusive";

const TRIAGE_VERDICTS: ReadonlySet<string> = new Set<TriageVerdict>([
  "upheld",
  "rejected",
  "inconclusive",
]);

const FULL_SHA = /^[0-9a-f]{40}$/;

// Tags that spawn an adjudicator (SKILL.md step 4) and therefore MUST carry
// its verdict on the marker. `applied` pays no adjudicator and is excluded
// on purpose — see the builder/parser below for what that means in both
// directions.
export const ADJUDICATED_TAGS: ReadonlySet<TriageTag> = new Set<TriageTag>([
  "dismissed",
  "deferred",
  "misclassified",
]);

export interface TriageMarkerFields {
  tag: TriageTag;
  headSha: string;
  actor: TriageActor;
  // Optional destination when tag is "deferred". W1 (issue #21/#22): a
  // deferred finding is a TAG plus reasoning, not a mandate to create a
  // GitHub issue — some agents run on providers that are not GitHub, and
  // the coding agent decides whether an issue exists. When supplied it
  // must be a positive integer; meaningless for every other tag and
  // ignored if supplied there.
  issue?: number;
  // The isolated adjudicator's ruling (ROADMAP B6b "the label is the
  // verdict and it closes the row"). REQUIRED for `dismissed`, `deferred`,
  // and `misclassified` — the three tags that spawn an adjudicator — for
  // the same reason `issue` is required for `deferred`: without it, 6c
  // cannot tell a settled finding from an unsettled one, and the escalation
  // rule (2 consecutive `inconclusive` heads) has nothing to count.
  // FORBIDDEN for `applied`, stricter than `issue`'s "ignored if supplied":
  // `applied` never spawns an adjudicator (SKILL.md, ROADMAP B6b), so a
  // verdict on an `applied` marker is not harmless noise, it is a false
  // claim that a ruling happened when the rule says none may. The builder
  // throws and the parser rejects rather than silently drop it.
  verdict?: TriageVerdict;
}

const TRIAGE_BADGE: Record<TriageTag, { emoji: string; label: string }> = {
  applied: { emoji: "✅", label: "APPLIED" },
  dismissed: { emoji: "❌", label: "DISMISSED" },
  deferred: { emoji: "📋", label: "DEFERRED" },
  misclassified: { emoji: "🏷️", label: "MISCLASSIFIED" },
};

// Visible second line of a triage reply. The marker is an HTML comment, so
// GitHub renders it invisible — a body that is only the marker tells the
// ledger everything and the human nothing (found on pr-hero PR #6). The
// driver owns this string so a skill cannot omit it the way the 1724
// Greptile-thread replies did.
export function triageBadge(fields: TriageMarkerFields): string {
  const badge = TRIAGE_BADGE[fields.tag];
  const parts = [`${badge.emoji} **${badge.label}**`, fields.actor];
  if (fields.verdict !== undefined) {
    parts.push(`adjudicator: ${fields.verdict}`);
  }
  if (fields.tag === "deferred" && fields.issue !== undefined) {
    parts.push(`#${fields.issue}`);
  }
  return parts.join(" · ");
}

// Marker + badge + reasoning, in that order. The driver prepends the wire
// format; `--body-file` is reasoning prose only. A blank reasoning still
// emits marker and badge — applied can be a one-line pointer, and an empty
// file must not drop the human-visible tag.
export function renderTriageReplyBody(
  fields: TriageMarkerFields,
  reasoning: string,
): string {
  const head = `${triageMarker(fields)}\n\n${triageBadge(fields)}`;
  const prose = reasoning.trim();
  return prose.length === 0 ? `${head}\n` : `${head}\n\n${prose}\n`;
}

// Builds the marker. `verdict` is required for the three adjudicated tags
// and forbidden for `applied`. `issue` on `deferred` is optional.
export function triageMarker(fields: TriageMarkerFields): string {
  if (
    fields.tag === "deferred" &&
    fields.issue !== undefined &&
    (!Number.isInteger(fields.issue) || fields.issue <= 0)
  ) {
    throw new Error(
      "triageMarker: tag=deferred issue must be a positive integer",
    );
  }
  if (ADJUDICATED_TAGS.has(fields.tag) && fields.verdict === undefined) {
    throw new Error(
      `triageMarker: tag=${fields.tag} requires a verdict — it spawns an ` +
        "adjudicator (ROADMAP B6b)",
    );
  }
  if (fields.tag === "applied" && fields.verdict !== undefined) {
    throw new Error(
      "triageMarker: tag=applied must not carry a verdict — applied pays " +
        "no adjudicator (ROADMAP B6b)",
    );
  }
  const issuePart =
    fields.tag === "deferred" && fields.issue !== undefined
      ? ` issue=${fields.issue}`
      : "";
  const verdictPart =
    fields.verdict !== undefined ? ` verdict=${fields.verdict}` : "";
  return (
    `${TRIAGE_MARKER_PREFIX}tag=${fields.tag} head=${fields.headSha} ` +
    `actor=${fields.actor}${issuePart}${verdictPart} -->`
  );
}

export interface ParsedTriageMarker {
  tag: TriageTag;
  headSha: string;
  actor: TriageActor;
  // Present only when tag is "deferred" AND the marker carried a valid
  // `issue=` field. Absent is a valid deferred (reasoning-only).
  issue?: number;
  // Present only when tag is "dismissed", "deferred", or "misclassified"
  // (parseTriageMarker enforces this the same way it enforces `issue`) —
  // absent for "applied", which never returns null for a MISSING verdict
  // but DOES for a PRESENT one (see parseTriageMarker).
  verdict?: TriageVerdict;
}

// Parses ONLY the first line of a reply body, mirroring
// parseFindingMarker's exact-prefix contract: a marker quoted mid-reply
// (someone pasting a prior triage into a new comment) must never parse as a
// fresh one. Returns null for anything malformed rather than guessing — a
// mis-parsed triage becomes a silently wrong verdict in the store.
export function parseTriageMarker(body: string): ParsedTriageMarker | null {
  const prefix = matchMarkerPrefix(body, TRIAGE_MARKER_PREFIX);
  if (prefix === undefined) return null;
  const firstLine = body.split("\n", 1)[0] ?? "";
  if (!firstLine.endsWith(" -->")) return null;
  const fields = firstLine.slice(
    prefix.length,
    firstLine.length - " -->".length,
  );
  const parts = new Map<string, string>();
  for (const token of fields.split(" ")) {
    if (token.length === 0) continue;
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    parts.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const rawTag = parts.get("tag");
  const headSha = parts.get("head");
  const rawActor = parts.get("actor");
  if (rawTag === undefined || headSha === undefined || rawActor === undefined) {
    return null;
  }
  if (!TRIAGE_TAGS.has(rawTag)) return null;
  if (!TRIAGE_ACTORS.has(rawActor)) return null;
  if (!FULL_SHA.test(headSha)) return null;
  const tag = rawTag as TriageTag;
  const actor = rawActor as TriageActor;

  // `applied` pays no adjudicator (SKILL.md, ROADMAP B6b), so a verdict on
  // an `applied` marker is not a harmless extra field, it is a false claim
  // that an adjudicator ruled when the rule says none may run — reject it
  // the same way an unknown tag is rejected, rather than silently ignore it.
  if (tag === "applied") {
    if (parts.has("verdict")) return null;
    return { tag, headSha, actor };
  }

  // `dismissed`, `deferred`, and `misclassified` all spawn an adjudicator
  // (SKILL.md step 4) and therefore MUST carry its verdict — the same
  // two-way guard `deferred`/`issue` already has, and for the same reason:
  // a missing verdict would silently read as "settled" (6c would count it
  // as answered) when in fact nobody has ruled on it at all, and the
  // escalation rule (2 consecutive `inconclusive` heads) would have nothing
  // to count.
  const rawVerdict = parts.get("verdict");
  if (rawVerdict === undefined || !TRIAGE_VERDICTS.has(rawVerdict)) {
    return null;
  }
  const verdict = rawVerdict as TriageVerdict;

  // `deferred` MAY carry a valid issue number. A missing `issue=` is a
  // valid reasoning-only defer (W1). A present but non-positive / NaN
  // value is still malformed — that is a broken destination, not "no
  // destination".
  if (tag === "deferred") {
    const rawIssue = parts.get("issue");
    if (rawIssue === undefined) {
      return { tag, headSha, actor, verdict };
    }
    const issue = Number.parseInt(rawIssue, 10);
    if (!Number.isInteger(issue) || issue <= 0) return null;
    return { tag, headSha, actor, issue, verdict };
  }
  return { tag, headSha, actor, verdict };
}
