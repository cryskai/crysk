// The end-of-run result block. Written twice (once per mode) and testable in
// neither until WU4 pulled it into one pure renderer — so these are the first
// assertions the last thing an operator reads has ever had.
//
// The load-bearing one is `prints the claim`: for the whole of Phase B this
// block reported counts and file paths and never said what the run found, so
// the payload of a five-minute $4 review could only be read by opening a file.
// Every assertion about a claim below is there to keep that from coming back.

import { describe, expect, test } from "bun:test";
import type { Finding, FindingsDocument, Telemetry } from "#review/findings";
import { planEstimateLine } from "#ui/plan";
import { type ResultInput, renderResult } from "#ui/result";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const joined = (lines: string[]): string => stripAnsi(lines.join("\n"));

const telemetry: Telemetry = {
  index_ms: 0,
  index_mode: "sync",
  index_disk_mb: 0,
  wall_ms: 327_000,
  tokens_in: 1,
  tokens_out: 1,
  tokens_total: 2,
  cost_usd_est: 4.09,
};

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "F001",
  category: 5,
  path: "src/triage-write.ts",
  line: 70,
  severity: "BLOCKER",
  evidence_class: "deterministic",
  refuter_verdict: "corroborated",
  causal_disposition: "introduced",
  claim:
    "path+line is not a unique key — a second finding at the same location " +
    "binds to the wrong comparison row",
  proof_refs: ["src/triage-write.ts:70 (the lookup)"],
  hunter: "reliability",
  tier: "blocking",
  hops_used: 3,
  hop_trail: [],
  dedupe_key: "src/triage-write.ts:70",
  ...over,
});

const doc = (over: Partial<FindingsDocument> = {}): FindingsDocument => ({
  schema_version: "1.0.0",
  pr: 6,
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  model: "sonnet",
  iteration: 0,
  parity_hunter_fired: false,
  run_status: "complete",
  telemetry,
  findings: [finding()],
  debug: { refuted: [] },
  ...over,
});

const input = (over: Partial<ResultInput> = {}): ResultInput => ({
  doc: doc(),
  costUsd: 4.09,
  wallMs: 327_000,
  estimate: { low: 3.5, high: 5.25 },
  runDir: "/tmp/pr-hero-runs/pr-6-17069c75-1",
  artifacts: ["report.md", "findings.json"],
  sessionFailed: false,
  styles: false,
  width: 80,
  ...over,
});

describe("renderResult header", () => {
  test("counts and money on one rule, tiers derived from the document", () => {
    const lines = renderResult(input());
    const rule = stripAnsi(lines[1] ?? "");
    expect(rule).toContain("╭─ 1 blocking · 0 advisory · 0 refuted");
    expect(rule).toContain("$4.09 · 5m27s");
    expect(rule.endsWith("─╮")).toBe(true);
    expect(rule.length).toBe(80);
  });

  test("advisory and refuted are counted, never conflated", () => {
    const rule = stripAnsi(
      renderResult(
        input({
          doc: doc({
            findings: [
              finding(),
              finding({ id: "F002", tier: "advisory", severity: "WARNING" }),
            ],
            debug: {
              refuted: [
                { ...finding({ id: "F003" }), refuter_verdict: "refuted" },
              ],
            },
          }),
        }),
      )[1] ?? "",
    );
    expect(rule).toContain("1 blocking · 1 advisory · 1 refuted");
  });

  test("a partial run says so in the header, not in a footnote", () => {
    expect(
      stripAnsi(
        renderResult(input({ doc: doc({ run_status: "partial" }) }))[1] ?? "",
      ),
    ).toContain("partial · 1 blocking");
  });

  test("a terminal too narrow for both halves keeps the counts", () => {
    const rule = stripAnsi(renderResult(input({ width: 20 }))[1] ?? "");
    expect(rule).toContain("blocking");
    expect(rule).not.toContain("$4.09");
  });

  test("the spend that comes off a narrow rule is relocated, never dropped", () => {
    // Width is clamped to MIN_WIDTH (40), which is still too narrow for both
    // halves — so the actual spend must reappear as its own footer row.
    const text = joined(renderResult(input({ width: 20 })));
    expect(text).toContain("spent");
    expect(text).toContain("$4.09 · 5m27s");
  });

  test("a wide rule carries the spend itself and adds no spent row", () => {
    const text = joined(renderResult(input({ width: 80 })));
    expect(text).toContain("$4.09 · 5m27s");
    expect(text).not.toContain("spent");
  });
});

describe("renderResult findings", () => {
  test("prints the claim — the whole point of the block", () => {
    const text = joined(renderResult(input()));
    expect(text).toContain("path+line is not a unique key");
    expect(text).toContain("to the wrong comparison row");
  });

  test("severity, tier marker and location head the finding", () => {
    const text = joined(renderResult(input()));
    expect(text).toContain("⛔ BLOCKER");
    expect(text).toContain("src/triage-write.ts:70");
  });

  test("a symbol rides along with the location when the finding has one", () => {
    expect(
      joined(
        renderResult(
          input({
            doc: doc({ findings: [finding({ symbol: "writeTriage" })] }),
          }),
        ),
      ),
    ).toContain("src/triage-write.ts:70 · writeTriage");
  });

  // The SECOND crash site of the PR #50 defect, and the earlier one: locationOf
  // guarded with `=== undefined ||` and then read `.length`, so a null symbol
  // threw here — in the terminal block an operator reads at the end of every
  // run — before posting was ever reached. Same cast-past-the-type reproduction
  // as the report renderer's.
  test("a runtime-null symbol renders the location instead of throwing", () => {
    const nullSymbol = {
      ...finding(),
      symbol: null,
    } as unknown as Finding;
    const text = joined(
      renderResult(input({ doc: doc({ findings: [nullSymbol] }) })),
    );
    expect(text).toContain("src/triage-write.ts:70");
    expect(text).not.toContain("·  ·");
    expect(text).not.toContain("null");
  });

  test("an advisory finding is marked as one, not as blocking", () => {
    const text = joined(
      renderResult(
        input({
          doc: doc({
            findings: [finding({ tier: "advisory", severity: "WARNING" })],
          }),
        }),
      ),
    );
    expect(text).toContain("WARNING");
    expect(text).not.toContain("⛔");
  });

  test("the refuter's verdict, hops, hunter and evidence class are stated", () => {
    expect(joined(renderResult(input()))).toContain(
      "↳ refuter corroborated · 3 hop(s) · reliability · deterministic",
    );
  });

  test("a long claim WRAPS, never truncates — no ellipsis anywhere in it", () => {
    const claim = `${"alpha beta gamma delta epsilon zeta eta theta ".repeat(4)}end`;
    const lines = renderResult(
      input({ doc: doc({ findings: [finding({ claim })] }) }),
    );
    const text = joined(lines);
    expect(text).toContain("end");
    expect(text).not.toContain("…");
    // Wrapped to the prose column, not back to the left margin.
    const proseLines = lines.filter((l) => l.startsWith("     alpha"));
    expect(proseLines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(96);
  });

  test("findings sharing a root cause are grouped under their cluster", () => {
    const text = joined(
      renderResult(
        input({
          doc: doc({
            findings: [
              finding({ id: "F001" }),
              finding({ id: "F002", path: "src/other.ts", line: 9 }),
            ],
            debug: {
              refuted: [],
              root_causes: {
                clusters: [
                  {
                    id: "RC001",
                    anchor: "src/triage-write.ts:70",
                    finding_ids: ["F001", "F002"],
                  },
                ],
                distinct_root_causes: 1,
              },
            },
          }),
        }),
      ),
    );
    expect(text).toContain("RC001 · 2 findings, one root cause");
  });

  test("a cluster of one earns no header — a refuted sibling leaves one behind", () => {
    const text = joined(
      renderResult(
        input({
          doc: doc({
            findings: [finding({ id: "F001" })],
            debug: {
              refuted: [],
              root_causes: {
                clusters: [
                  {
                    id: "RC001",
                    anchor: "x",
                    finding_ids: ["F001", "F002-refuted"],
                  },
                ],
                distinct_root_causes: 1,
              },
            },
          }),
        }),
      ),
    );
    expect(text).not.toContain("RC001");
    expect(text).toContain("path+line is not a unique key");
  });

  test("every finding is printed exactly once, grouped or not", () => {
    const text = joined(
      renderResult(
        input({
          doc: doc({
            findings: [
              finding({ id: "F001", claim: "first claim" }),
              finding({ id: "F002", claim: "second claim" }),
              finding({ id: "F003", claim: "third claim" }),
            ],
            debug: {
              refuted: [],
              root_causes: {
                clusters: [
                  { id: "RC001", anchor: "a", finding_ids: ["F001", "F003"] },
                  { id: "RC002", anchor: "b", finding_ids: ["F002"] },
                ],
                distinct_root_causes: 2,
              },
            },
          }),
        }),
      ),
    );
    for (const claim of ["first claim", "second claim", "third claim"]) {
      expect(text.split(claim).length - 1).toBe(1);
    }
  });

  test("no findings says so, and names the refuted ones it dropped", () => {
    const text = joined(
      renderResult(
        input({
          doc: doc({
            findings: [],
            debug: {
              refuted: [{ ...finding(), refuter_verdict: "refuted" }],
            },
          }),
        }),
      ),
    );
    expect(text).toContain("no findings survived to this point");
    expect(text).toContain("1 refuted and dropped");
  });

  test("refuted findings are counted, never listed in full", () => {
    const text = joined(
      renderResult(
        input({
          doc: doc({
            debug: {
              refuted: [
                {
                  ...finding({ id: "F009", claim: "a refuted claim" }),
                  refuter_verdict: "refuted",
                },
              ],
            },
          }),
        }),
      ),
    );
    expect(text).toContain("1 refuted");
    expect(text).not.toContain("a refuted claim");
  });
});

describe("renderResult comparison", () => {
  // The Greptile head-to-head is retired: no input carries it any more, and
  // the terminal block never names it.
  test("no rendered line mentions Greptile, even on a PR-mode run", () => {
    const text = joined(
      renderResult(
        input({
          worktree: { gitDirOwner: "/repo", worktreePath: "/wt/pr-6" },
          links: {
            webUrl: "https://github.com/o/r/pull/6",
            headSha: "b".repeat(40),
            pr: 6,
          },
          artifacts: ["report.md", "findings.json", "post.json"],
        }),
      ),
    );
    expect(text).not.toContain("Greptile");
    expect(text).not.toContain("comparison.md");
  });
});

describe("renderResult footer", () => {
  test("ONE run dir plus the basenames, never three absolute paths", () => {
    const text = joined(
      renderResult(
        input({ artifacts: ["report.md", "findings.json", "post.json"] }),
      ),
    );
    // Each basename once, and the directory prefix exactly once — the whole
    // point of the collapse (three absolute paths carried one bit each).
    for (const name of ["report.md", "findings.json", "post.json"]) {
      expect(text.split(name).length - 1).toBe(1);
    }
    const hits = text.split("/tmp/pr-hero-runs/pr-6-17069c75-1").length - 1;
    expect(hits).toBe(1);
    // At 80 columns the value column wraps rather than overrunning the width.
    for (const line of renderResult(
      input({ artifacts: ["report.md", "findings.json", "post.json"] }),
    )) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("the estimate band survives, because an overrun is only visible against it", () => {
    expect(joined(renderResult(input()))).toContain("$3.50–$5.25");
  });

  // #173 (§8: "Artifacts and reports show cash and notional totals
  // separately. Budget enforcement uses cash only; research comparisons may
  // use notional only when clearly labelled.").
  //
  // The header's figure is CASH, and on a subscription route cash is $0.00 —
  // truthfully, but uselessly on its own. Without this row a subscription run
  // would print `$0.00` and the list-basis figure the operator has been
  // reading for months would simply vanish from the terminal. The row is what
  // makes the change a relocation rather than a loss, and its wording is what
  // keeps the two numbers from being read as one.
  describe("cash and notional are shown apart (#173)", () => {
    test("a notional total is its own labelled row, never folded into the header figure", () => {
      const text = joined(
        renderResult(input({ costUsd: 0, notionalUsd: 0.0455 })),
      );
      expect(text).toContain("notional");
      expect(text).toContain("$0.05");
      // Labelled as not-cash, per §8's "only when clearly labelled".
      expect(text).toContain("list price");
      expect(text).toContain("not charged");
      // The header keeps reporting cash, and cash alone.
      const rule = stripAnsi(
        renderResult(input({ costUsd: 0, notionalUsd: 0.0455 }))[1] ?? "",
      );
      expect(rule).toContain("$0.00");
      expect(rule).not.toContain("$0.05");
    });

    // The legacy path — a runner reporting no normalized usage at all — must
    // stay byte-identical, which an always-present row with a `$0.00` default
    // would break while still passing the assertion above.
    test("no notional figure means no row at all, not a zero one", () => {
      const text = joined(renderResult(input()));
      expect(text).not.toContain("notional");
      expect(renderResult(input({ notionalUsd: undefined }))).toEqual(
        renderResult(input()),
      );
    });

    test("a metered run with real cash and no notional keeps a single figure", () => {
      const text = joined(renderResult(input({ costUsd: 4.09 })));
      expect(text).toContain("$4.09");
      expect(text).not.toContain("notional");
    });

    // The row's value is the longest in the footer, so it is the one that
    // would overrun a narrow terminal if it ever bypassed `row()`'s wrapping.
    //
    // Asserted over the lines this row ADDS, not over the whole render: the
    // block already emits lines longer than the width for reasons that predate
    // it and are not wrapping failures — an unbreakable run-dir path, and
    // finding prose. Asserting every line would have been a false premise that
    // fails against correct code.
    test("the row wraps to the value column instead of overrunning a narrow terminal", () => {
      const width = 20; // clamped to MIN_WIDTH (40) by the renderer
      const without = renderResult(input({ costUsd: 0, width }));
      const added = renderResult(
        input({ costUsd: 0, notionalUsd: 0.0455, width }),
      ).filter((line, i) => line !== without[i]);
      expect(added.length).toBeGreaterThan(1); // it really did wrap
      for (const line of added) expect(line.length).toBeLessThanOrEqual(40);
    });

    test("the row emits no escape sequences with styles off", () => {
      for (const line of renderResult(
        input({ costUsd: 0, notionalUsd: 0.0455, styles: false }),
      )) {
        expect(line).not.toContain(ESC);
      }
    });
  });

  test("no `posted:` line — step 14 already printed one during the run", () => {
    const text = joined(
      renderResult(input({ artifacts: ["report.md", "post.json"] })),
    );
    expect(text).not.toContain("posted:");
    // The durable trace is the receipt in the artifact list instead.
    expect(text).toContain("post.json");
  });

  test("the worktree hint hands over worktree remove, never rm -rf", () => {
    const text = joined(
      renderResult(
        input({
          worktree: { gitDirOwner: "/repo", worktreePath: "/wt/pr-6" },
        }),
      ),
    );
    expect(text).toContain("kept for finding-verification");
    expect(text).toContain("git -C /repo worktree remove --force /wt/pr-6");
    expect(text).not.toContain("rm -rf");
  });

  test("local mode gets no worktree hint", () => {
    expect(joined(renderResult(input()))).not.toContain("worktree");
  });

  test("a dead session says so, last, after every count", () => {
    const lines = renderResult(input({ sessionFailed: true }));
    expect(stripAnsi(lines[lines.length - 1] ?? "")).toContain(
      "every hunter failed — this run reviewed nothing.",
    );
  });

  test("a dead run gets NO green all-clear — a clean bill would be a lie", () => {
    const lines = renderResult(
      input({
        doc: doc({ findings: [], run_status: "partial" }),
        sessionFailed: true,
      }),
    );
    const text = joined(lines);
    expect(text).not.toContain("no findings survived");
    expect(stripAnsi(lines[lines.length - 1] ?? "")).toContain(
      "every hunter failed",
    );
  });

  test("a live session never claims one failed", () => {
    expect(joined(renderResult(input()))).not.toContain("every hunter failed");
  });
});

// GitHub #42, the terminal half. A run where some agents died and the
// survivors found nothing used to print a GREEN "no findings survived to this
// point" under a header whose only trace of the loss was the word `partial`.
// Green is the strongest clean-bill signal this block has, and it was being
// spent on a review that never finished looking.
describe("renderResult incomplete runs", () => {
  const partialTelemetry: Telemetry = {
    ...telemetry,
    per_agent: {
      reliability: { tokens_total: 60, duration_ms: 1000, status: "ok" },
      parity: { tokens_total: 0, duration_ms: 0, status: "failed" },
    } as Telemetry["per_agent"],
  };
  const partial = (over: Partial<FindingsDocument> = {}): FindingsDocument =>
    doc({ run_status: "partial", telemetry: partialTelemetry, ...over });

  test("a partial run with zero findings gets NO green all-clear", () => {
    const text = joined(
      renderResult(input({ doc: partial({ findings: [] }) })),
    );
    expect(text).not.toContain("no findings survived");
    expect(text).toContain("incomplete review — at least one agent did not");
  });

  test("the notice names who completed and who did not", () => {
    const text = joined(
      renderResult(input({ doc: partial({ findings: [] }) })),
    );
    expect(text).toContain("Completed: reliability. Did not complete: parity");
    expect(text).toContain("(failed)");
  });

  test("the notice sits above the findings, not after them", () => {
    const text = joined(renderResult(input({ doc: partial() })));
    expect(text.indexOf("incomplete review")).toBeLessThan(
      text.indexOf("src/triage-write.ts:70"),
    );
  });

  test("a partial run that names nobody still says the record is silent", () => {
    const text = joined(
      renderResult(
        input({
          doc: partial({
            findings: [],
            telemetry: { ...telemetry, per_agent: undefined },
          }),
        }),
      ),
    );
    expect(text).toContain("incomplete review");
    expect(text).toContain("The run record does not name which");
  });

  // The dead-session line is the whole message when every hunter failed
  // (its own WHY says so), so this notice stands down rather than listing the
  // same corpses one paragraph earlier.
  test("a dead session gets the red line only, not the incomplete notice", () => {
    const text = joined(
      renderResult(
        input({ doc: partial({ findings: [] }), sessionFailed: true }),
      ),
    );
    expect(text).not.toContain("incomplete review");
    expect(text).toContain("every hunter failed");
  });

  test("a complete run keeps its green all-clear and grows no notice", () => {
    const text = joined(renderResult(input({ doc: doc({ findings: [] }) })));
    expect(text).toContain("no findings survived to this point");
    expect(text).not.toContain("incomplete review");
  });

  // The renderer contract's own acceptance criterion (CLAUDE.md): styles off
  // means not one escape byte, on EVERY branch — including this one, whose
  // two new paints (yellow headline, dim coverage line) are the newest place
  // an unconditional colour could hide.
  test("styles off emits zero ANSI bytes on the partial branch", () => {
    for (const lines of [
      renderResult(input({ doc: partial({ findings: [] }), styles: false })),
      renderResult(input({ doc: partial(), styles: false })),
    ]) {
      expect(lines.join("\n")).not.toContain(ESC);
    }
  });

  // GitHub #39, the terminal half of the moved-head disclosure. The comment
  // says it on the PR; this says it to the operator watching the run, and
  // both derive the sentence from movedHeadSentence so they cannot drift.
  const MOVED = "d".repeat(40);

  test("a moved head prints the notice with both shas in full", () => {
    const text = joined(renderResult(input({ movedHeadSha: MOVED })));
    expect(text).toContain(
      "the PR head moved while this review ran — the comments are pinned",
    );
    // Wrap-tolerant: the sentence is wrapped, never truncated, and each sha
    // survives whole on whichever line it lands on — a 40-char sha cut in
    // half would be worse than no sha at all.
    expect(text).toContain(`Reviewed ${"b".repeat(40)};`);
    expect(text).toContain("the PR head is now");
    expect(text).toContain(MOVED);
    expect(text).toContain("Everything below describes the");
  });

  test("the moved-head notice sits above the findings, not after them", () => {
    const text = joined(renderResult(input({ movedHeadSha: MOVED })));
    expect(text.indexOf("the PR head moved")).toBeLessThan(
      text.indexOf("src/triage-write.ts:70"),
    );
  });

  // The same composition the summary comment pins: which code the block is
  // about, THEN how much of it was looked at, then the payload.
  test("partial AND moved prints both notices, moved first", () => {
    const text = joined(
      renderResult(input({ doc: partial(), movedHeadSha: MOVED })),
    );
    const moved = text.indexOf("the PR head moved");
    const incomplete = text.indexOf("incomplete review");
    expect(moved).toBeGreaterThan(-1);
    expect(moved).toBeLessThan(incomplete);
    expect(incomplete).toBeLessThan(text.indexOf("src/triage-write.ts:70"));
    expect(text).toContain("Did not complete: parity");
  });

  test("an unmoved head prints nothing about a head at all", () => {
    const text = joined(renderResult(input()));
    expect(text).not.toContain("the PR head moved");
    expect(text).not.toContain("Reviewed ");
  });

  // The renderer contract again: two more paints (yellow headline, dim
  // sentence) that must vanish entirely with styles off.
  test("styles off emits zero ANSI bytes on the moved-head branch", () => {
    for (const lines of [
      renderResult(input({ movedHeadSha: MOVED, styles: false })),
      renderResult(
        input({ doc: partial(), movedHeadSha: MOVED, styles: false }),
      ),
    ]) {
      expect(lines.join("\n")).not.toContain(ESC);
    }
  });
});

// The work unit that replaced a planned interactive findings browser with
// printed urls, and the reason it is the better trade: a url persists in
// scrollback and can be opened whenever, while an interactive view forces a
// decision in the moment and dies with the process. Which means the url is
// worthless unless it survives INTACT — never wrapped, never truncated — which
// is what most of these assertions are about.
describe("renderResult links", () => {
  const links = {
    webUrl: "https://github.com/musive/pr-hero",
    headSha: "b".repeat(40),
  };
  const blob = `https://github.com/musive/pr-hero/blob/${"b".repeat(40)}/src/triage-write.ts#L70`;
  const commentUrl = "https://github.com/musive/pr-hero/pull/6#discussion_r99";

  test("no links input means today's block, verbatim — plain path:line", () => {
    const text = joined(renderResult(input()));
    expect(text).toContain("src/triage-write.ts:70");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("↗");
  });

  test("a finding with no posted comment links to the blob at the head sha", () => {
    const text = joined(renderResult(input({ links })));
    expect(text).toContain(blob);
  });

  test("a POSTED finding links to its comment, never to the blob", () => {
    const text = joined(
      renderResult(
        input({
          links: {
            ...links,
            pr: 6,
            commentUrls: new Map([["F001", commentUrl]]),
          },
        }),
      ),
    );
    expect(text).toContain(commentUrl);
    expect(text).not.toContain(blob);
  });

  test("a finding absent from the comment map still gets its blob link", () => {
    const text = joined(
      renderResult(
        input({
          doc: doc({
            findings: [finding(), finding({ id: "F002", path: "src/x.ts" })],
          }),
          links: {
            ...links,
            pr: 6,
            commentUrls: new Map([["F001", commentUrl]]),
          },
        }),
      ),
    );
    expect(text).toContain(commentUrl);
    expect(text).toContain("/blob/");
    expect(text).toContain("/src/x.ts#L70");
  });

  test("the PR's own url is printed once, right under the header rule", () => {
    const lines = renderResult(input({ links: { ...links, pr: 6 } }));
    const text = joined(lines);
    expect(stripAnsi(lines[2] ?? "")).toContain(
      "https://github.com/musive/pr-hero/pull/6",
    );
    expect(text.split("/pull/6\n").length - 1).toBe(1);
  });

  test("local mode has no PR, so no PR url line — only blob links", () => {
    const lines = renderResult(input({ links }));
    expect(joined(lines)).not.toContain("/pull/");
    expect(joined(lines)).toContain(blob);
  });

  // The load-bearing one. A url folded across two lines is not clickable, so an
  // overlong line is the correct trade at any width.
  test("a url is NEVER folded or truncated, even at 60 columns", () => {
    const lines = renderResult(
      input({ width: 60, links: { ...links, pr: 6 } }),
    ).map(stripAnsi);
    expect(lines.some((l) => l.includes(blob))).toBe(true);
    expect(
      lines.some((l) => l.includes("https://github.com/musive/pr-hero/pull/6")),
    ).toBe(true);
    // No ellipsis anywhere: truncate() never touched either url.
    expect(lines.join("\n")).not.toContain("…");
  });

  test("a grouped finding keeps its link under the cluster header", () => {
    const text = joined(
      renderResult(
        input({
          links,
          doc: doc({
            findings: [
              finding({ id: "F001" }),
              finding({ id: "F002", path: "src/other.ts", line: 9 }),
            ],
            debug: {
              refuted: [],
              root_causes: {
                clusters: [
                  {
                    id: "RC001",
                    anchor: "src/triage-write.ts:70",
                    finding_ids: ["F001", "F002"],
                  },
                ],
                distinct_root_causes: 1,
              },
            },
          }),
        }),
      ),
    );
    expect(text).toContain("RC001 · 2 findings, one root cause");
    expect(text).toContain(blob);
    expect(text).toContain("/src/other.ts#L9");
  });

  test("styles off means not one escape byte, links and all", () => {
    expect(
      renderResult(
        input({
          links: {
            ...links,
            pr: 6,
            commentUrls: new Map([["F001", commentUrl]]),
          },
        }),
      ).join("\n"),
    ).not.toContain(ESC);
  });

  test("painting a url changes the bytes around it, never the url", () => {
    const over: Partial<ResultInput> = { links: { ...links, pr: 6 } };
    expect(joined(renderResult(input({ ...over, styles: true })))).toBe(
      joined(renderResult(input(over))),
    );
  });
});

describe("renderResult styling", () => {
  const styled = (over: Partial<ResultInput> = {}): string[] =>
    renderResult(input({ styles: true, ...over }));

  test("styles off means not one escape byte", () => {
    expect(renderResult(input()).join("\n")).not.toContain(ESC);
  });

  test("styles on paints, including the findings", () => {
    expect(
      styled({
        worktree: { gitDirOwner: "/repo", worktreePath: "/wt/pr-6" },
        sessionFailed: true,
      }).join("\n"),
    ).toContain(ESC);
  });

  test("painting changes the bytes around the text, never the text", () => {
    const over: Partial<ResultInput> = {
      worktree: { gitDirOwner: "/repo", worktreePath: "/wt/pr-6" },
    };
    expect(joined(styled(over))).toBe(joined(renderResult(input(over))));
  });

  test("returns lines and prints nothing itself", () => {
    const lines = renderResult(input());
    expect(Array.isArray(lines)).toBe(true);
    // Leading blank: the block separates itself from the progress panel above.
    expect(lines[0]).toBe("");
  });
});

// W3-FOOTER: a free OpenCode route is not billed, so the footer must not say
// it was "not charged on a subscription" (false there), and a mixed route must
// name its free share. Rows wrap at the value column, so the wording is read
// with whitespace collapsed; the wrapping itself has its own tests above.
describe("renderResult footer on a free route (W3-FOOTER)", () => {
  const flat = (lines: string[]): string => joined(lines).replace(/\s+/g, " ");
  const notional = { notionalUsd: 0.0455 };

  test("billing free: the notional row names a free route, never a subscription", () => {
    const text = flat(renderResult(input({ ...notional, billing: "free" })));
    expect(text).toContain(
      "$0.05 at list price — not charged on a free route; budget limits read the cash figure above",
    );
    expect(text).not.toContain("subscription");
  });

  test("billing mixed: the estimate row appends the free-steps note", () => {
    const text = flat(renderResult(input({ ...notional, billing: "mixed" })));
    expect(text).toContain("$3.50–$5.25 (free steps not billed)");
    // The notional row keeps today's wording: only the free share changed.
    expect(text).toContain("not charged on a subscription");
  });

  test("billing free: the estimate row carries the plan card's free wording, never a bare band", () => {
    const text = flat(renderResult(input({ ...notional, billing: "free" })));
    // The plan card prints this line for the same band and the same free
    // route; the footer must read the same verdict, not its own rewording.
    const planCard = planEstimateLine({
      estimate: { low: 3.5, high: 5.25 },
      hunterCount: 1,
      summarizer: true,
      freeRoute: { free: 5, total: 5 },
    });
    expect(planCard).toBe(
      "estimate: free route (token-derived $3.50 – $5.25, not billed)",
    );
    expect(text).toContain(
      "estimate free route (token-derived $3.50 – $5.25, not billed)",
    );
    expect(text).not.toContain("estimate $3.50–$5.25");
  });

  test("billing undefined: the estimate row keeps the bare band", () => {
    const text = flat(renderResult(input({ ...notional, billing: undefined })));
    expect(text).toContain("estimate $3.50–$5.25");
    expect(text).not.toContain("token-derived");
  });

  test("billing undefined: byte-identical to a run that never heard of billing", () => {
    expect(renderResult(input({ ...notional }))).toEqual(
      renderResult(input({ ...notional, billing: undefined })),
    );
    expect(flat(renderResult(input({ ...notional })))).toContain(
      "not charged on a subscription",
    );
  });

  test("styles off: a free-route footer carries no escape bytes", () => {
    for (const billing of ["free", "mixed"] as const) {
      const lines = renderResult(
        input({ ...notional, billing, styles: false }),
      );
      expect(lines.join("\n")).not.toContain("\x1b");
    }
  });
});
