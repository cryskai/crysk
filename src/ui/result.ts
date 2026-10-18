// The end-of-run result block, as LINES. Third member of the terminal
// surface's pure half (ui/primitives.ts formats, ui/select.ts asks, this one reports):
// same contract as both — everything is a total function of its inputs, the
// style flag and the width arrive as PARAMETERS, and the I/O shell in cli.ts
// owns the printing and every exit code.
//
// WHY it exists at all: this block was written TWICE, once at the end of
// local mode and once at the end of PR mode, with different label padding and
// a `posted:` line that duplicated one already printed during the run. Two
// copies of the last thing an operator reads is two chances to drift, and
// neither copy could be tested because both were a run of `log()` calls
// inside a 400-line async shell. The mode-specific parts (comparison,
// worktree hint, extra artifacts) are optional inputs, not a second renderer.
//
// WHY it prints the FINDINGS: after five minutes and $4 the terminal used to
// report counts and file paths and never once said what was found — the
// payload was the one thing you had to leave the terminal to read. Everything
// below the header exists to end that.

import type { ComparisonResult } from "#compare/compare";
import type { Finding, FindingsDocument } from "#review/findings";
import {
  blobUrl,
  coverageSentence,
  formatElapsed,
  movedHeadSentence,
} from "#review/report";
import type { UnresolvedSpend } from "../execution/spend-limiter";
import { freeRouteEstimateText } from "./plan";
import {
  cyan,
  dim,
  green,
  red,
  row,
  severityLabel,
  shortPath,
  terminalWidth,
  truncate,
  wrapText,
  yellow,
} from "./primitives";
import { FREE_STEPS_NOTE, type FreeBillingMode } from "./select";

interface ResultComparison {
  greptileFound: boolean;
  // The whole bucketing, not the three cardinalities: a Greptile-only finding
  // is a recall miss with a name, a file and a line, and printing only its
  // count is how a measured miss reads as a rounding error.
  result: ComparisonResult;
}

interface ResultWorktree {
  gitDirOwner: string;
  worktreePath: string;
}

// D1-08 PR5b (D8): the run's unresolved spend reservations, surfaced here so
// the fencing gap (design decision D7: breaker state does not survive a
// process restart) is visible in the terminal a human actually reads, not
// only in pipeline.json. A plain alias over `UnresolvedSpend[]` — the
// pipeline-level shape already carries everything this block prints.
export type ResultUnresolved = readonly UnresolvedSpend[];

// What it takes to turn a finding into something clickable. Absent when the
// repo has no usable github remote, which is the honest degradation: the block
// falls back to today's plain `path:line` and never prints a guessed url.
//
// WHY a URL and not an interactive findings browser (the thing this replaced):
// a url survives in scrollback and can be opened whenever the reader gets to
// it, while an interactive view forces a decision in the moment and dies with
// the process. The cheaper surface is also the more durable one.
export interface ResultLinks {
  // Canonical repo web url, no trailing slash: `https://github.com/owner/repo`.
  webUrl: string;
  // The sha the review actually read. Blob links are pinned to it, never to a
  // branch name — a branch link drifts and starts pointing at other people's
  // code under our claim.
  headSha: string;
  // PR mode only. Its presence is what earns the PR's own url a line, and it
  // is also the pull number every comment fragment hangs off.
  pr?: number;
  // findingId -> the url of the comment this finding was POSTED as, when it
  // was. Preferred over a blob link because it lands the reader in the
  // conversation where they will reply, not in a read-only file view.
  commentUrls?: ReadonlyMap<string, string>;
}

export interface ResultInput {
  // The document, not a pre-chewed tally: every count in the header is
  // derived here, from the same bytes that were just written to disk, so the
  // terminal and findings.json cannot disagree about what the run found.
  doc: FindingsDocument;
  // CASH, and only cash — the figure the header's `$X.XX` reports and the one
  // budget enforcement is allowed to read (§8: "Budget enforcement uses cash
  // only"). On a Claude subscription or a free route this is a truthful $0.00.
  costUsd: number;
  // #173 (§8: "Artifacts and reports show cash and notional totals
  // separately"). The list-basis figure a subscription run was NOT charged,
  // kept strictly apart from `costUsd` and rendered with its own label — the
  // design's "research comparisons may use notional only when clearly
  // labelled" is a rendering obligation, not just a storage one.
  //
  // Optional, and absent means NO ROW rather than a `$0.00` one: a runner that
  // reports no normalized usage has no list figure to show, and printing one
  // it never produced is the fabrication the whole usage slice exists to
  // prevent.
  notionalUsd?: number;
  // W3-FOOTER: the route's billing, derived by freeBillingMode from the same
  // free-step count the plan card prints. Absent means no free share, and the
  // footer keeps its subscription wording byte for byte.
  billing?: FreeBillingMode;
  wallMs: number;
  estimate: { low: number; high: number };
  // One directory plus the basenames written inside it. The full paths still
  // go to pipeline.json — three absolute paths sharing a 60-char prefix cost
  // three lines and carry one bit each (the shortPath rule, applied to the
  // place that motivated it).
  runDir: string;
  artifacts: string[];
  comparison?: ResultComparison;
  // PR mode only: the worktree is kept and reused BY DECISION, so the block
  // hands over the exact removal command. `worktree remove`, never `rm -rf` —
  // a live codegraph daemon holds .codegraph/daemon.sock.
  worktree?: ResultWorktree;
  links?: ResultLinks;
  // PR mode only, and only on a CONFIRMED mismatch (GitHub #39): the PR's
  // head as GitHub reported it immediately before posting, when it is not
  // the head this run reviewed. Optional, matching this interface's own
  // style for mode-specific inputs (`comparison`, `links`, `worktree`) —
  // unlike renderPrComment's required parameter, there is exactly ONE
  // production call site for this block and its test pins it, so an
  // omission cannot hide in a second caller.
  movedHeadSha?: string;
  sessionFailed: boolean;
  // D1-08 PR5b (D8): present and non-empty exactly when at least one spend
  // reservation ended `unresolved_remote` this run. Its presence is what
  // marks the header's `$X.XX` figure as a FLOOR rather than a total (the
  // known cost is real; the unresolved bucket's true cost is not) and what
  // earns the run a footer row naming the fenced bucket(s).
  unresolved?: ResultUnresolved;
  styles: boolean;
  width?: number;
}

const MIN_WIDTH = 40;
const MAX_WIDTH = 96;
// Body indents: the marker column, then the prose column under it.
const MARKER_INDENT = "  ";
const PROSE_INDENT = "     ";
// How many Greptile-only rows are worth a line each before the tail becomes a
// count. Real PRs carry a handful; a 20-row dump would bury the findings this
// block exists to show.
const MAX_GREPTILE_ROWS = 5;
// Wide enough for the longest footer label ("estimate", "worktree") plus a gap.
const FOOTER_LABEL_WIDTH = 12;

// Deliberately NOT ui/primitives.ts's box(): box truncates every body line to fit its
// border, and the one thing this block must never truncate away is a claim.
// So the card is a RULE — the top edge only — and the body below it is plain
// indented text that wraps. Shape: `╭─ left ───── right ─╮`.
// `spentDropped` is not cosmetic bookkeeping: when the terminal is too narrow
// for both halves the counts win and the spend comes OFF the rule, so the
// caller has to put it back as its own row. Reported rather than assumed,
// because "the money is never dropped" is only true if somebody relocates it.
function headerRule(
  left: string,
  right: string,
  width: number,
  styles: boolean,
): { line: string; spentDropped: boolean } {
  // 8 = "╭─ " + " " around the fill + " ─╮".
  const fill = width - left.length - right.length - 8;
  if (fill < 1) {
    const shown = truncate(left, Math.max(width - 6, 1));
    return {
      line:
        dim("╭─ ", styles) +
        shown +
        dim(` ${"─".repeat(Math.max(width - 5 - shown.length, 1))}╮`, styles),
      spentDropped: true,
    };
  }
  return {
    line:
      dim("╭─ ", styles) +
      left +
      dim(` ${"─".repeat(fill)} `, styles) +
      right +
      dim(" ─╮", styles),
    spentDropped: false,
  };
}

// A POSITIVE type test for the same reason report.ts's findingLocationLine
// carries one: `=== undefined ||` let a null symbol through to `.length` and
// threw. This was the EARLIER of the two crash sites in PR #50's defect — the
// terminal block an operator reads at the end of every run, reached before
// posting is ever attempted.
function locationOf(f: Finding): string {
  return typeof f.symbol === "string" && f.symbol.length > 0
    ? `${f.path}:${f.line} · ${f.symbol}`
    : `${f.path}:${f.line}`;
}

// The tier as a marker, because the tier is what decides whether a human must
// act (the rule severityLabel's colour half already encodes). Returned WITH
// its trailing space: ⛔ is one code unit but renders TWO columns wide, so the
// padding cannot be computed from `.length` and is baked in here instead —
// otherwise the severity column of a blocking and an advisory finding sit one
// column apart on screen while looking identical in a string comparison.
function tierMarker(f: Finding): string {
  return f.tier === "blocking" ? "⛔ " : "·  ";
}

// Where a reader should go to act on this finding, in priority order:
//   1. its own posted comment, when the run posted one — that is the thread
//      the reply belongs in, so it beats a read-only file view outright;
//   2. the blob at the reviewed head sha, via report.ts's shared blobUrl.
// `undefined` when there are no links at all, which is the plain-location
// fallback, never a fabricated url.
function findingUrl(
  f: Finding,
  links: ResultLinks | undefined,
): string | undefined {
  if (links === undefined) return undefined;
  const posted = links.commentUrls?.get(f.id);
  if (posted !== undefined) return posted;
  return blobUrl(links.webUrl, links.headSha, f.path, `L${f.line}`);
}

// One finding: marker + severity + location, the claim wrapped underneath, the
// refuter's verdict as the provenance line, and — last, because it is the
// ACTION rather than the evidence — a clickable url. NOTHING is truncated — a
// claim is the payload, and a payload you have to open a file to read is the
// defect this whole work unit fixes.
//
// The url gets a whole line to itself and is passed through neither wrapText
// nor truncate: a folded url is not clickable and a truncated one is a lie
// about where the finding lives, so an overlong line is the correct trade
// (exactly the reasoning wrapText's own comment gives for never splitting a
// long word, and the worktree-removal command below).
//
// Built with padding computed from the UNSTYLED severity and painted per
// segment: an escape sequence inside a measured string is counted as visible
// width, which is the same trap markerRowLines documents in cli.ts.
function findingLines(
  f: Finding,
  indent: string,
  width: number,
  styles: boolean,
  links: ResultLinks | undefined,
): string[] {
  const pad = " ".repeat(Math.max(10 - f.severity.length, 1));
  const prose = indent + PROSE_INDENT.slice(0, 3);
  const proseWidth = Math.max(width - prose.length, 20);
  const url = findingUrl(f, links);
  return [
    `${indent}${tierMarker(f)}` +
      `${severityLabel(f.severity, f.tier, styles)}${pad}` +
      cyan(locationOf(f), styles),
    ...wrapText(f.claim, proseWidth).map((line) => prose + line),
    prose +
      dim(
        `↳ refuter ${f.refuter_verdict} · ${f.hops_used} hop(s) · ` +
          `${f.hunter} · ${f.evidence_class}`,
        styles,
      ),
    ...(url === undefined
      ? []
      : [prose + dim("↗ ", styles) + cyan(url, styles)]),
  ];
}

// Findings in document order, except that findings sharing a root cause are
// pulled together under their cluster id. That grouping is real signal the old
// block flattened into a bare "K distinct root cause(s)": three findings on
// one defect and three separate defects are the same number there.
//
// MEASUREMENT ONLY, exactly as review/root-cause.ts insists: this reorders lines on a
// terminal. Nothing here touches findings[], and findings.json is already on
// disk by the time this runs.
function findingsSection(
  doc: FindingsDocument,
  width: number,
  styles: boolean,
  links: ResultLinks | undefined,
): string[] {
  if (doc.findings.length === 0) return [];
  const byId = new Map(doc.findings.map((f) => [f.id, f]));
  // Only clusters with two or more findings STILL PRESENT earn a header: a
  // refuted sibling leaves a cluster of one, and "shared root cause" over a
  // single finding is noise.
  const groups = new Map<string, Finding[]>();
  for (const cluster of doc.debug.root_causes?.clusters ?? []) {
    const members = cluster.finding_ids
      .map((id) => byId.get(id))
      .filter((f): f is Finding => f !== undefined);
    if (members.length > 1) groups.set(cluster.id, members);
  }
  const clusterOf = new Map<string, string>();
  for (const [id, members] of groups) {
    for (const member of members) clusterOf.set(member.id, id);
  }
  const lines: string[] = [];
  const emitted = new Set<string>();
  for (const finding of doc.findings) {
    if (emitted.has(finding.id)) continue;
    const cluster = clusterOf.get(finding.id);
    const members = cluster === undefined ? undefined : groups.get(cluster);
    if (cluster === undefined || members === undefined) {
      lines.push(
        "",
        ...findingLines(finding, MARKER_INDENT, width, styles, links),
      );
      emitted.add(finding.id);
      continue;
    }
    lines.push(
      "",
      MARKER_INDENT +
        dim(`${cluster} · ${members.length} findings, one root cause`, styles),
    );
    for (const member of members) {
      lines.push(
        ...findingLines(member, `${MARKER_INDENT}  `, width, styles, links),
      );
      emitted.add(member.id);
    }
  }
  return lines;
}

// The terminal half of GitHub #39, and the summary comment's twin — same
// sentence, same order relative to the incompleteness notice, different
// paint. It sits ABOVE incompleteLines for the reason spelled out in
// renderPrComment: this one says WHICH CODE everything below describes, the
// #42 one says how much of it was looked at, and reading them the other way
// round is reading them wrong.
//
// NOT suppressed on `sessionFailed`, unlike incompleteLines: a dead session
// posts nothing, so the moved head can only reach here from a run that
// really did post — and if a caller ever does hand it in on a failed
// session, "the PR moved" is still true and still worth the two lines.
function movedHeadLines(
  reviewedSha: string,
  currentSha: string,
  width: number,
  styles: boolean,
): string[] {
  const headWidth = Math.max(width - MARKER_INDENT.length, 20);
  const proseWidth = Math.max(width - PROSE_INDENT.length, 20);
  return [
    "",
    ...wrapText(
      "the PR head moved while this review ran — the comments are pinned " +
        "to the commit that was reviewed",
      headWidth,
    ).map((line) => MARKER_INDENT + yellow(line, styles)),
    // Wrapped, never truncated, for findingLines' reason: a 40-char sha cut
    // in half is worse than no sha at all.
    ...wrapText(
      movedHeadSentence(reviewedSha, currentSha, (text) => text),
      proseWidth,
    ).map((line) => PROSE_INDENT + dim(line, styles)),
  ];
}

// The terminal half of GitHub #42, and the same argument as the summary
// comment's: `partial · ` in the header rule says the run was incomplete in
// two words, but two words next to five counts is a footnote wearing a
// header's clothes, and the green all-clear below it read as a clean bill
// anyway. So a partial run gets a line of its own that NAMES what was lost,
// and the green line is withdrawn (see renderResult).
//
// Suppressed when `sessionFailed`: a dead session prints "every hunter failed
// — this run reviewed nothing." last, which is the whole message there, and
// listing the same corpses one paragraph earlier only softens it.
function incompleteLines(
  doc: FindingsDocument,
  width: number,
  styles: boolean,
): string[] {
  // Wrapped, never truncated, for findingLines' reason: the one thing this
  // block must not do is drop the half of a sentence that says what is
  // missing.
  const headWidth = Math.max(width - MARKER_INDENT.length, 20);
  const proseWidth = Math.max(width - PROSE_INDENT.length, 20);
  return [
    "",
    ...wrapText(
      "incomplete review — at least one agent did not finish, so the " +
        "counts above are a floor, not a verdict",
      headWidth,
    ).map((line) => MARKER_INDENT + yellow(line, styles)),
    ...wrapText(
      coverageSentence(doc, (key) => key),
      proseWidth,
    ).map((line) => PROSE_INDENT + dim(line, styles)),
  ];
}

function greptileLines(
  comparison: ResultComparison,
  doc: FindingsDocument,
  width: number,
  styles: boolean,
): string[] {
  const { greptileOnly, both, prheroOnly } = comparison.result;
  const lines = [
    "",
    `${MARKER_INDENT}${dim("vs Greptile ", styles)} pr-hero ` +
      `${prheroOnly.length} · both ${both.length} · greptile ` +
      `${greptileOnly.length}` +
      (comparison.greptileFound
        ? ""
        : dim("  (no Greptile comment on this PR)", styles)),
  ];
  // The recall misses, by name. This is the number the whole head-to-head
  // exists to measure, and until WU4 widened ComparisonOutcome the terminal
  // could not name a single one of them.
  const shown = greptileOnly.slice(0, MAX_GREPTILE_ROWS);
  for (const miss of shown) {
    lines.push(
      PROSE_INDENT +
        yellow(
          truncate(
            `↳ missed ${miss.path}:${miss.startLine} — ${miss.title}`,
            Math.max(width - PROSE_INDENT.length, 20),
          ),
          styles,
        ),
    );
  }
  if (greptileOnly.length > shown.length) {
    lines.push(
      PROSE_INDENT +
        dim(
          `↳ and ${greptileOnly.length - shown.length} more — see ` +
            "comparison.md",
          styles,
        ),
    );
  }
  // A pr-hero-only finding is not automatically a win, and a `both` row is not
  // automatically a match (compare/compare.ts's window over-matches by design), so the
  // block points at the file that shows the pairings rather than scoring them.
  if (doc.findings.length > 0 && comparison.greptileFound) {
    lines.push(PROSE_INDENT + dim("↳ pairings: comparison.md", styles));
  }
  return lines;
}

export function renderResult(input: ResultInput): string[] {
  const width = Math.max(
    Math.min(input.width ?? terminalWidth(), MAX_WIDTH),
    MIN_WIDTH,
  );
  const styles = input.styles;
  const doc = input.doc;
  const blocking = doc.findings.filter((f) => f.tier === "blocking").length;
  const advisory = doc.findings.length - blocking;
  const refuted = doc.debug.refuted.length;
  // `partial` in the header, never in a footnote: a run where a hunter died
  // found less than a complete one would have, and every count above is read
  // in that light or misread.
  const status = doc.run_status === "partial" ? "partial · " : "";
  const left =
    `${status}${blocking} blocking · ${advisory} advisory · ` +
    `${refuted} refuted`;
  // D8: a bucket fenced by an unresolved_remote reservation means the real
  // cost of that bucket's attempt is UNKNOWN — printing a bare `$X.XX` there
  // is the exact "$0 on parse failure" collapse this slice exists to kill,
  // just relocated to the terminal's header line. `≥` marks it a floor.
  const hasUnresolved = (input.unresolved?.length ?? 0) > 0;
  const costLabel = `${hasUnresolved ? "≥" : ""}$${input.costUsd.toFixed(2)}`;
  const right = `${costLabel} · ${formatElapsed(input.wallMs)}`;
  const header = headerRule(left, right, width, styles);
  // The PR's own url, directly under the rule rather than down in the artifact
  // footer, for two reasons. It is the WHERE of everything above and below it,
  // so it belongs with the counts it describes; and the footer is built out of
  // row(), which wraps its value to the value column — the one thing a url
  // must never do. Local mode has no PR and gets no such line.
  const prUrl =
    input.links?.pr === undefined
      ? undefined
      : `${input.links.webUrl}/pull/${input.links.pr}`;
  // GitHub #42: an incomplete run says so above its own payload, naming the
  // agents that were lost, so nothing below is read as full coverage.
  const incomplete = doc.run_status === "partial" && !input.sessionFailed;
  const lines = [
    "",
    header.line,
    ...(prUrl === undefined
      ? []
      : [MARKER_INDENT + dim("↗ ", styles) + cyan(prUrl, styles)]),
    // GitHub #39, above the #42 block on purpose — see movedHeadLines.
    ...(input.movedHeadSha === undefined
      ? []
      : movedHeadLines(doc.head_sha, input.movedHeadSha, width, styles)),
    ...(incomplete ? incompleteLines(doc, width, styles) : []),
    ...findingsSection(doc, width, styles, input.links),
  ];
  // A green all-clear is only allowed when the review actually RAN. A dead
  // session also reaches here with `findings: []`, and "no findings" over a
  // review that never happened is the same lie the comparison and posting
  // guards exist to prevent (cli.ts steps 13/14) — the red line below is the
  // whole message in that case.
  //
  // `partial` joined that exclusion for GitHub #42: a run where some agents
  // died and the survivors found nothing is not a clean bill either, and
  // green is the strongest clean-bill signal this block has. The yellow
  // notice above already carries the count and the names, so the branch is
  // simply withdrawn rather than restated.
  if (doc.findings.length === 0 && !input.sessionFailed && !incomplete) {
    lines.push(
      "",
      MARKER_INDENT +
        green("no findings survived to this point", styles) +
        (refuted === 0 ? "" : dim(` — ${refuted} refuted and dropped`, styles)),
    );
  }
  if (input.comparison) {
    lines.push(...greptileLines(input.comparison, doc, width, styles));
  }
  // The footer goes through row(), so a run dir plus four basenames wraps to
  // the value column instead of running off the terminal. Values are handed to
  // it UNPAINTED for the reason row() documents: it measures the value to
  // place the wrap, and an escape sequence inside one is counted as width.
  const footer = { styles, width, indent: 2, labelWidth: FOOTER_LABEL_WIDTH };
  lines.push(
    "",
    ...row(
      "run dir",
      shortPath(input.runDir) +
        (input.artifacts.length === 0
          ? ""
          : ` · ${input.artifacts.join(" · ")}`),
      footer,
    ),
    // The band is kept because it is the only thing that makes an overrun
    // visible: both recorded cost incidents were under-estimates, and rule 6
    // says every live run lands in a ledger.
    ...row(
      "estimate",
      input.billing === "free"
        ? freeRouteEstimateText(input.estimate)
        : input.billing === "mixed"
          ? `$${input.estimate.low.toFixed(2)}–$${input.estimate.high.toFixed(2)} ${FREE_STEPS_NOTE}`
          : `$${input.estimate.low.toFixed(2)}–$${input.estimate.high.toFixed(2)}`,
      footer,
    ),
  );
  // #173: the second half of the §8 cash/notional split, and the reason the
  // header's `$0.00` on a subscription run is informative rather than broken.
  // Its own row, its own label, and wording that names the basis — a bare
  // second dollar figure beside the first is exactly the mixing §8 forbids.
  if (input.notionalUsd !== undefined) {
    lines.push(
      ...row(
        "notional",
        input.billing === "free"
          ? `$${input.notionalUsd.toFixed(2)} at list price — not charged on a free route; ` +
              "budget limits read the cash figure above"
          : `$${input.notionalUsd.toFixed(2)} at list price — not charged on a ` +
              "subscription; budget limits read the cash figure above",
        footer,
      ),
    );
  }
  // D8: naming the fenced bucket(s) HERE, not only in pipeline.json, is the
  // whole point of this row — see the module-level ResultUnresolved comment.
  if (hasUnresolved) {
    const buckets = [
      ...new Set((input.unresolved ?? []).map((u) => u.bucketId)),
    ];
    lines.push(
      ...row(
        "unresolved",
        `${input.unresolved?.length} spend reservation(s) unresolved in ` +
          `bucket(s) ${buckets.join(", ")} — cost above is a floor; see ` +
          "pipeline.json",
        footer,
      ),
    );
  }
  // The relocation headerRule reported: on a terminal too narrow for the rule
  // to carry both halves, what this run actually cost gets its own row instead
  // of disappearing with the rule's right-hand segment.
  if (header.spentDropped) {
    lines.push(...row("spent", right, footer));
  }
  if (input.worktree) {
    lines.push(
      ...row(
        "worktree",
        "kept for finding-verification; remove it with",
        footer,
      ),
      // The command on its OWN line and never wrapped: it exists to be copied,
      // and a command broken across two indented lines is not copyable.
      PROSE_INDENT +
        dim(
          `git -C ${input.worktree.gitDirOwner} worktree remove --force ` +
            input.worktree.worktreePath,
          styles,
        ),
    );
  }
  // The line that outranks every count above it. The exit code is the SHELL's
  // (return 1 in local mode, postingExitCode in PR mode) — this only says so.
  if (input.sessionFailed) {
    lines.push(
      "",
      MARKER_INDENT +
        red("every hunter failed — this run reviewed nothing.", styles),
    );
  }
  return lines;
}
