// What a scenario PR shows, and what it means. Pure: the runner collects raw
// facts from gh, and everything below decides from those facts alone, so each
// path and each invariant is pinned by a fixture rather than by a live run.
//
// Two rules keep the classifier honest. First, the path is read from the
// evidence on the PR and the run, never from the status state alone: the S7
// invariants are checked separately, so a status that violates S7 cannot also
// decide the path. Second, a path with no positive evidence is no-outcome, not
// a guess.

import {
  FINDING_MARKER_PREFIX,
  OUTCOME_MARKER_PREFIX,
  OVERRIDE_MARKER_PREFIX,
  PRH_CODE,
  REPORT_MARKER_PREFIX,
  SKIP_MARKERS,
  type SkipReason,
} from "./markers";

// The catalog code of "every hunter failed" (src/ci/outcome.ts, ERROR_CATALOG).
// Both the outcome comment and the status carry it, and both read as the same path.
const HUNTERS_FAILED_CODE = "PRH-HUNTERS-FAILED";

// WHY this family: a run whose every failed hunter shares one cause with a code of its own
// is rendered with that code (publish.ts huntersFailedRendering, outcome.ts renderHunterCause),
// so an all-hunters-dead run can post PRH-MODEL-UNAVAILABLE instead of PRH-HUNTERS-FAILED. The
// flake tolerance and its label are about the path, not the code, so the family is one path.
// PRH-CRED-UNUSABLE is not in the set on its code alone: the credential preflight posts it on
// a run that never reached a hunter. Only the sentence renderHunterCause writes, which names
// the route's provider and model, marks it as the hunters-failed path.
const HUNTERS_FAILED_FAMILY: ReadonlySet<string> = new Set([
  HUNTERS_FAILED_CODE,
  "PRH-MODEL-UNAVAILABLE",
]);
const HUNTER_ROUTE_SENTENCE =
  /The route [^\s/]+\/\S+ has no usable credential record/;
// The status description is clipped to 140 characters (publish.ts statusDescription), and a
// long provider and model push the sentence's tail past the cut. Only its opening is read
// there: the preflight's own PRH-CRED-UNUSABLE sentence opens "The <backend>/opencode route",
// never "The route <provider>/", so the opening alone still tells the two apart.
const HUNTER_ROUTE_STATUS = /^PRH-CRED-UNUSABLE: The route [^\s/]+\//;

// The error-status half of the hunters-failed path, shared with scenario.ts's flake gate.
export function isHuntersFailedStatus(description: string): boolean {
  const code = /^PRH-[A-Z]+(?:-[A-Z]+)*/.exec(description)?.[0];
  return isHuntersFailed(code, HUNTER_ROUTE_STATUS.test(description));
}

export function isHuntersFailed(
  code: string | undefined,
  hunterRoute: boolean,
): boolean {
  if (code === undefined) return false;
  if (HUNTERS_FAILED_FAMILY.has(code)) return true;
  return code === "PRH-CRED-UNUSABLE" && hunterRoute;
}

// The owner lead an outcome's summary opens with (src/ci/outcome.ts ownerLead). It is
// read off the body, so a check can name the owner the reader sees, not the code alone.
const OWNER_LEAD =
  /^(Your configuration:|Provider(?: [^:\n]+)?:|pr-hero defect:|Unclassified:)/m;

// The slack allowed between a comment's created_at and the run it started. GitHub
// stamps both, so the gap is small; the window only keeps a run created a moment
// before the comment from being mistaken for an earlier one.
export const COMMENT_RUN_CLOCK_SKEW_MS = 5_000;

export type CommentKind =
  | "report"
  | "finding"
  | "outcome"
  | "skip"
  | "override"
  | "adjudication"
  | "other";

export interface CommentFact {
  source: "issue" | "inline";
  kind: CommentKind;
  code?: string;
  // An outcome that names a hunter route's credential record (PRH-CRED-UNUSABLE), so the
  // hunters-failed path rendered it (see HUNTER_ROUTE_SENTENCE).
  hunterRoute?: true;
  // An outcome's owner lead, when its summary names one (OWNER_LEAD).
  lead?: string;
  skip?: SkipReason;
  // A report, an outcome or a finding names the head it was written for (a finding
  // in its marker). Only a report for the head under test counts as this run's
  // review, and only an outcome for it decides this run's path: an earlier head's
  // comment on the same PR is not.
  head?: string;
  // When GitHub stored the comment. Set for the comments of a phase that waits on a
  // comment run, so a skip marker can be tied to that run and not to an earlier one.
  createdAt?: string;
  // S4: set only on a finding whose header reads `🔴 blocking`. Absent otherwise,
  // so an advisory finding's fact is the same shape it always was.
  blocking?: true;
  // Fix A: a report's blocking entries in its `### Comments Outside Diff` section,
  // the findings the PR shows with no inline anchor. Set only when there is at
  // least one, so a report without one keeps the shape it always had.
  outsideDiffBlocking?: number;
  // T5b: the verdict of a CI adjudication reply (`verdict=` on its marker line).
  verdict?: string;
  // D3: the paths of a report's state-block rows (every loc of every row, once each), so a check can read what the PR's state remembers. Set only on a report that carries a state block.
  statePaths?: string[];
  // A finding's anchor, read off its marker (`path=<p> line=<n>`, preflight.ts findingMarker).
  // The line is the one the marker names, so a check reads the site the product posted.
  path?: string;
  line?: number;
}

// The hunters that failed, by name, in the order their lines appear in a run's log. A
// failed hunter prints `hunter <name>: failed` (src/ui/progress.ts startLineRenderer): the
// line keeps GitHub's timestamp and job prefix, so the match is on the words alone. Each name
// once, however many lines it has.
export function hunterFailuresIn(log: string): string[] {
  const names: string[] = [];
  for (const match of log.matchAll(/\bhunter ([^\s:]+): failed\b/g)) {
    const name = match[1] ?? "";
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface RunFact {
  id: number;
  // The event that started the run. A comment-triggered run and the pull_request
  // run of the same PR are different runs, and a check must tell them apart.
  event?: string;
  status: string;
  conclusion: string | null;
  steps: { name: string; conclusion: string | null }[];
}

export interface StatusFact {
  state: string;
  description: string;
}

export interface Observation {
  prNumber: number;
  prUrl: string;
  headSha: string;
  run?: RunFact;
  status?: StatusFact;
  comments: CommentFact[];
  artifacts: string[];
  // When the trigger comment of the phase was created, in epoch ms. Only set for a
  // phase that waits on a comment run; a run it started was created after this.
  triggeredAt?: number;
  // The reactions on that trigger comment, by content (`eyes`, `-1`, `confused`).
  // Absent on a phase with no trigger comment, so a check can tell "no reaction"
  // from "not observed".
  reactions?: readonly string[];
  // The hunters that failed in the observed run, by name, read from its log. Absent
  // unless the phase asked for the log (scenario.ts collect), so a check can tell
  // "no hunter failed" from "the log was not read".
  hunterFailures?: readonly string[];
  // The head the phase did not observe, read for a check that compares it before and
  // after the phase (rerun-after-push). Absent on every other phase.
  newerHead?: {
    sha: string;
    before?: StatusFact;
    after?: StatusFact;
  };
}

export type SmokePath =
  | "reviewed"
  | "hunters-failed"
  | `error:${string}`
  | `skipped:${string}`
  | "timed-out"
  | "no-outcome";

export function outcomeCodeOf(body: string): string | undefined {
  return PRH_CODE.exec(body)?.[0];
}

// The blocking entries in a report's `### Comments Outside Diff` section
// (report.ts outsideDiffSection): one entry per finding, each opening with its
// header line. The section ends at the next heading or at the `---` rule that
// precedes the footer, so a blocking-looking line after either is not an entry.
const OUTSIDE_DIFF_HEADING = "### Comments Outside Diff";
const BLOCKING_ENTRY_HEADER = "🔴 blocking · ";

export function outsideDiffBlockingCount(body: string): number {
  let inSection = false;
  let count = 0;
  for (const line of body.split("\n")) {
    if (!inSection) {
      if (line.startsWith(OUTSIDE_DIFF_HEADING)) inSection = true;
      continue;
    }
    if (/^#{1,3} /.test(line) || line === "---") break;
    if (line.startsWith(BLOCKING_ENTRY_HEADER)) count += 1;
  }
  return count;
}

// D3: the state block a report carries (report.ts writes it after the body): the line
// after `<!-- pr-hero-state v=1 `, a `<!-- {json} -->` comment. Its findings' first locs
// name the paths the PR's state remembers; the line number after the last colon is dropped.
const STATE_LINE_PREFIX = "<!-- pr-hero-state v=1 ";

export function statePathsOf(body: string): string[] | undefined {
  const lines = body.split("\n");
  const at = lines.findIndex((line) => line.startsWith(STATE_LINE_PREFIX));
  const json = lines[at + 1];
  if (at === -1 || json === undefined) return undefined;
  if (!json.startsWith("<!-- ") || !json.endsWith(" -->")) return undefined;
  let state: unknown;
  try {
    state = JSON.parse(json.slice("<!-- ".length, -" -->".length));
  } catch {
    return undefined;
  }
  const findings = (state as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings)) return undefined;
  const paths: string[] = [];
  // Every loc, not the first: formatLocs sorts a row's locs by path, so the first one
  // can be a proof_ref's file rather than the finding's own.
  for (const row of findings) {
    const locs = (row as { locs?: unknown } | null)?.locs;
    if (!Array.isArray(locs)) continue;
    for (const loc of locs) {
      if (typeof loc !== "string") continue;
      const colon = loc.lastIndexOf(":");
      const path = colon === -1 ? loc : loc.slice(0, colon);
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

// T5b: the marker the CI adjudicator writes on its reply to a dismissal. Its verdict is
// the `verdict=` token on that line; a line without one reads as no verdict.
const ADJUDICATION_MARKER_PREFIX = "<!-- pr-hero-adjudication ";

export function classifyComment(
  body: string,
  source: "issue" | "inline",
): CommentFact {
  const first = (body.split("\n", 1)[0] ?? "").trim();
  if (first.startsWith(REPORT_MARKER_PREFIX)) {
    const head = /\bhead=([0-9a-f]{40})\b/.exec(first)?.[1];
    const outside = outsideDiffBlockingCount(body);
    const statePaths = statePathsOf(body);
    return {
      source,
      kind: "report",
      ...(head === undefined ? {} : { head }),
      ...(outside === 0 ? {} : { outsideDiffBlocking: outside }),
      ...(statePaths === undefined ? {} : { statePaths }),
    };
  }
  if (first.startsWith(FINDING_MARKER_PREFIX)) {
    // The tier is in the finding's header line (report.ts findingHeaderLine),
    // and it is the only tier evidence a reader of the PR sees. Its marker names
    // the head, so the check can tell this head's finding from an older one.
    const head = /\bhead=([0-9a-f]{40})\b/.exec(first)?.[1];
    const blocking = body.includes("🔴 blocking");
    // The anchor is in the same first line as the head (findingMarker, preflight.ts).
    const anchor = /\bpath=(\S+) line=(\d+)\b/.exec(first);
    return {
      source,
      kind: "finding",
      ...(head === undefined ? {} : { head }),
      ...(blocking ? { blocking: true as const } : {}),
      ...(anchor === null
        ? {}
        : { path: decodeMarkerPath(anchor[1]), line: Number(anchor[2]) }),
    };
  }
  if (first.startsWith(OUTCOME_MARKER_PREFIX)) {
    // The head is "unknown" when the publisher had no sha; such an outcome has no head.
    const head = /\bhead=([0-9a-f]{40})\b/.exec(first)?.[1];
    const code = outcomeCodeOf(body);
    const lead = OWNER_LEAD.exec(body)?.[1];
    return {
      source,
      kind: "outcome",
      code,
      ...(head === undefined ? {} : { head }),
      ...(lead === undefined ? {} : { lead }),
      ...(code === "PRH-CRED-UNUSABLE" && HUNTER_ROUTE_SENTENCE.test(body)
        ? { hunterRoute: true as const }
        : {}),
    };
  }
  if (first.startsWith(ADJUDICATION_MARKER_PREFIX)) {
    const verdict = /\bverdict=([a-z]+)\b/.exec(first)?.[1];
    return {
      source,
      kind: "adjudication",
      ...(verdict === undefined ? {} : { verdict }),
    };
  }
  for (const [reason, marker] of Object.entries(SKIP_MARKERS)) {
    if (first === marker)
      return { source, kind: "skip", skip: reason as SkipReason };
  }
  if (first.startsWith(OVERRIDE_MARKER_PREFIX)) {
    // The head names the commit the override unlocked; an override is valid for that head only.
    const head = /\bhead=([0-9a-f]{40})\b/.exec(first)?.[1];
    return head === undefined
      ? { source, kind: "override" }
      : { source, kind: "override", head };
  }
  return { source, kind: "other" };
}

// A skip notice names no head, and the product reposts it without removing it.
// So on a comment-triggered phase it counts only when this run posted it: a
// notice is created at or after the trigger (the same window the own-evidence
// check uses). A notice an earlier run left behind is not this run's skip, and a
// forced review of the same head (/pr-hero review after a size skip) decides
// the path from its own report. A phase with no trigger has no window to test,
// so every notice counts there, as it always has.
// Exported for the override check: an override is this run's only when the run
// posted it, the same proof a skip notice needs.
export function postedByThisRun(
  comment: CommentFact,
  obs: Observation,
): boolean {
  if (obs.triggeredAt === undefined) return true;
  if (comment.createdAt === undefined) return false;
  return (
    Date.parse(comment.createdAt) >= obs.triggeredAt - COMMENT_RUN_CLOCK_SKEW_MS
  );
}

export function classifyPath(obs: Observation): SmokePath {
  // An outcome of an earlier head is that head's failure, not this one's. It still
  // counts for S7 (invariantViolations reads every outcome on the PR).
  const outcome = obs.comments.find(
    (c) =>
      c.kind === "outcome" && (c.head === undefined || c.head === obs.headSha),
  );
  if (outcome !== undefined) {
    if (isHuntersFailed(outcome.code, outcome.hunterRoute === true))
      return "hunters-failed";
    return `error:${outcome.code ?? "no-code"}`;
  }
  const skip = obs.comments.find(
    (c) => c.kind === "skip" && postedByThisRun(c, obs),
  );
  if (skip?.skip !== undefined) return `skipped:${skip.skip}`;

  // S4: a gate failure is a finished review's verdict too, so with this head's
  // report it is `reviewed`. A size or budget skip never leaves a report, so a
  // failure here is never one.
  const hasReport = obs.comments.some(
    (c) => c.kind === "report" && c.head === obs.headSha,
  );
  if (
    hasReport &&
    (obs.status?.state === "success" || obs.status?.state === "failure")
  ) {
    return "reviewed";
  }

  // The status is written apart from the outcome comment, so a read can see it
  // alone. Its code is the same failure the comment names, so it classifies the
  // same way; an error status with any other code stays `error:<code>`.
  const statusCode = /^PRH-[A-Z]+(?:-[A-Z]+)*/.exec(
    obs.status?.description ?? "",
  )?.[0];
  // The publisher writes this code on an error status as well as in the outcome
  // comment (#330). Only that positive evidence decides hunters-failed: a failed
  // step plus an uploaded run directory also fits a finished pipeline whose post
  // threw, and a real all-hunters-dead run uploads nothing (review #332, F007).
  // Without either, a failed step is no-outcome.
  if (
    obs.status?.state === "error" &&
    isHuntersFailedStatus(obs.status.description)
  )
    return "hunters-failed";
  if (obs.status?.state === "error" && statusCode !== undefined)
    return `error:${statusCode}`;
  return "no-outcome";
}

// The S7 invariants from #330's review rounds, checked literally. They are
// reported as violations even when the path itself looks fine.
export function invariantViolations(obs: Observation): string[] {
  const violations: string[] = [];
  const status = obs.status;
  if (status?.state === "error" && !/^PRH-/.test(status.description)) {
    violations.push(
      `S7 violation: error status without a PRH- code: "${status.description}"`,
    );
  }
  if (
    status?.state === "success" &&
    obs.comments.some((c) => c.kind === "outcome")
  ) {
    violations.push(
      "S7 violation: outcome comment on a head whose status is success",
    );
  }
  if (status?.state === "pending" && obs.run?.status === "completed") {
    violations.push(
      "S7 violation: status still pending after the run completed",
    );
  }
  return violations;
}

// The engine percent-encodes the marker's path (`path=src%2Fvolume.ts`, findingMarker in
// src/pr/preflight.ts), so a check comparing it to a repository path must decode it first
// (live, sandbox PR #61: the planted-site check saw `src%2Fvolume.ts:4` and failed). A
// malformed escape is kept as written.
function decodeMarkerPath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
