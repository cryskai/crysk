import { describe, expect, test } from "bun:test";
import {
  findingMarker,
  PR_COMMENT_COVERAGE_PARTIAL_TOKEN,
  PR_COMMENT_MARKER_PREFIX,
  prCommentMarker,
} from "#pr/preflight";
import { type PriorRecord, SEVERITY_UNRECOVERABLE } from "#rereview/classify";
import { assembleLive } from "#rereview/state";
import type { Finding, FindingsDocument, Telemetry } from "#review/findings";
import {
  estimateCost,
  formatElapsed,
  parseFindingCommentBadge,
  type ReportMeta,
  type RereviewLiveRow,
  renderInlineComment,
  renderIssueFindingComment,
  renderPrComment,
  renderReport,
  rereviewDeltaFromProvenance,
  scanAidEmoji,
  severityEmoji,
} from "#review/report";
import { clusterByRootCause } from "#review/root-cause";
import {
  outsideDiffBlockingCount,
  outsideDiffBlockingPaths,
} from "../../scripts/sandbox/observe";

const ANCHOR = "src/duration.ts:19-20";

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    category: 12,
    path: "src/app.ts",
    line: 42,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "the value is stored in seconds and read as milliseconds",
    proof_refs: [`${ANCHOR} (fromSeconds stores raw seconds)`],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 2,
    hop_trail: [],
    dedupe_key: `${overrides.path ?? "src/app.ts"}::12`,
    ...overrides,
  };
}

const TELEMETRY: Telemetry = {
  index_ms: 0,
  index_mode: "sync",
  index_disk_mb: 0,
  wall_ms: 754_000,
  tokens_in: 100,
  tokens_out: 20,
  tokens_total: 120,
  cost_usd_est: 12.9,
  per_agent: {
    reliability: { tokens_total: 60, duration_ms: 1000 },
    lifecycle: { tokens_total: 60, duration_ms: 1000 },
  },
};

function doc(overrides: Partial<FindingsDocument> = {}): FindingsDocument {
  const findings = overrides.findings ?? [];
  return {
    schema_version: "1.0.0",
    pr: 0,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    model: "sonnet",
    iteration: 0,
    engine: { name: "pr-hero", version: "1.0.0" },
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: TELEMETRY,
    findings,
    debug: { refuted: [], root_causes: clusterByRootCause(findings) },
    ...overrides,
  };
}

const META: ReportMeta = {
  repo: "musive",
  base: "main",
  head: "feature",
  diffStat: { files: 3, insertions: 120, deletions: 45 },
  costUsd: 12.9,
  wallMs: 754_000,
};

const SUMMARY = {
  prose:
    "This change adds a concise review summary. It preserves the findings surface.",
  score: 4,
  score_reason: "The diff is focused and the behavior is covered.",
};

describe("scanAidEmoji", () => {
  test("blocking findings scan as red whatever the hunter severity", () => {
    expect(scanAidEmoji({ severity: "BLOCKER", tier: "blocking" })).toBe("🔴");
    expect(scanAidEmoji({ severity: "CRITICAL", tier: "blocking" })).toBe("🔴");
  });

  test("advisory BLOCKER/CRITICAL/WARNING scan as yellow, SUGGESTION stays blue", () => {
    expect(scanAidEmoji({ severity: "CRITICAL", tier: "advisory" })).toBe("🟡");
    expect(scanAidEmoji({ severity: "BLOCKER", tier: "advisory" })).toBe("🟡");
    expect(scanAidEmoji({ severity: "WARNING", tier: "advisory" })).toBe("🟡");
    expect(scanAidEmoji({ severity: "SUGGESTION", tier: "advisory" })).toBe(
      "🔵",
    );
  });
});

describe("renderReport", () => {
  // The reason this whole module exists: one systemic defect reported at K
  // call sites must read as ONE thing to fix, not as K problems.
  test("a fan-out renders one root-cause heading listing every site", () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
      finding({ id: "F003", path: "src/c.ts", line: 30 }),
    ];
    const markdown = renderReport(doc({ findings }), META);
    expect(markdown).toContain("## Blocking (3 findings, 1 root cause)");
    expect(markdown).toContain(`### RC001 — \`${ANCHOR}\``);
    expect(markdown).toContain("One defect reported at 3 sites");
    expect(markdown).toContain("- F001 `src/a.ts:10` —");
    expect(markdown).toContain("- F002 `src/b.ts:20` —");
    expect(markdown).toContain("- F003 `src/c.ts:30` —");
    // Exactly one heading for the cluster, never one per site.
    expect(markdown.match(/^### /gm)?.length).toBe(1);
  });

  test("singletons render with their full detail", () => {
    const findings = [
      finding({
        id: "F001",
        symbol: "toMillis",
        proof_refs: ["src/a.ts:10 (producer)", "src/b.ts:20 (consumer)"],
      }),
      finding({
        id: "F002",
        path: "src/other.ts",
        line: 7,
        severity: "CRITICAL",
        evidence_class: "inferential",
        causal_disposition: "worsened",
        hunter: "lifecycle",
        proof_refs: ["src/other.ts:7 (unrelated anchor)"],
      }),
    ];
    const markdown = renderReport(doc({ findings }), META);
    expect(markdown).toContain("## Blocking (2 findings, 2 root causes)");
    expect(markdown).toContain("### F001 — `src/app.ts:42` (toMillis)");
    expect(markdown).toContain(
      "- BLOCKER · evidence deterministic · introduced · hunter reliability · " +
        "refuter corroborated",
    );
    expect(markdown).toContain("- Proof:");
    expect(markdown).toContain("  - src/b.ts:20 (consumer)");
    expect(markdown).toContain("### F002 — `src/other.ts:7`");
    expect(markdown).toContain("hunter lifecycle");
  });

  test("a finding with no symbol still renders", () => {
    const markdown = renderReport(
      doc({ findings: [finding({ id: "F001" })] }),
      META,
    );
    expect(markdown).toContain("### F001 — `src/app.ts:42`\n");
    expect(markdown).not.toContain("undefined");
  });

  // Older artifacts predate debug.root_causes entirely; the renderer must
  // recompute rather than degrade to a flat list.
  test("a document without debug.root_causes is clustered on the fly", () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
    ];
    const markdown = renderReport(
      doc({ findings, debug: { refuted: [] } }),
      META,
    );
    expect(markdown).toContain("## Blocking (2 findings, 1 root cause)");
    expect(markdown).toContain(`### RC001 — \`${ANCHOR}\``);
    expect(markdown).toContain("One defect reported at 2 sites");
  });

  test("clusters that straddle the tier split count only their own sites", () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
      finding({
        id: "F003",
        path: "src/c.ts",
        line: 30,
        severity: "WARNING",
        tier: "advisory",
      }),
    ];
    const markdown = renderReport(doc({ findings }), META);
    expect(markdown).toContain("## Blocking (2 findings, 1 root cause)");
    expect(markdown).toContain("One defect reported at 2 sites");
    expect(markdown).toContain("## Advisory (1 finding, 1 root cause)");
    expect(markdown).toContain("### F003 — `src/c.ts:30`");
  });

  test("an empty document renders every section without throwing", () => {
    const markdown = renderReport(doc(), META);
    expect(markdown).toContain("## Blocking (0 findings, 0 root causes)");
    expect(markdown).toContain("_Nothing blocking._");
    expect(markdown).toContain("## Advisory (0 findings, 0 root causes)");
    expect(markdown).toContain("_Nothing advisory._");
    expect(markdown).toContain(
      "Nothing was refuted, and nothing was merged as a duplicate.",
    );
    expect(markdown).toContain("3 files, +120 −45 · run complete · $12.90");
  });

  // #173 (§8: "Artifacts and reports show cash and notional totals
  // separately"). report.md is the artifact half of that sentence; the
  // terminal's own row is asserted in test/ui/result.test.ts.
  describe("cash and notional in the run line", () => {
    test("a notional figure is appended as its own labelled segment", () => {
      const markdown = renderReport(doc(), {
        ...META,
        costUsd: 0,
        notionalUsd: 0.0455,
      });
      expect(markdown).toContain("run complete · $0.00");
      expect(markdown).toContain("$0.05 at list price, not charged");
    });

    test("no notional figure leaves the run line byte-identical", () => {
      expect(renderReport(doc(), { ...META, notionalUsd: undefined })).toBe(
        renderReport(doc(), META),
      );
      expect(renderReport(doc(), META)).not.toContain("list price");
    });
  });

  test("advisory-only documents leave blocking empty", () => {
    const findings = [
      finding({ id: "F001", severity: "WARNING", tier: "advisory" }),
    ];
    const markdown = renderReport(doc({ findings }), META);
    expect(markdown).toContain("## Blocking (0 findings, 0 root causes)");
    expect(markdown).toContain("## Advisory (1 finding, 1 root cause)");
  });

  test("the not-reported section keeps drops attributable", () => {
    const { tier: _tier, ...base } = finding({
      id: "F009",
      claim: "double free",
    });
    const markdown = renderReport(
      doc({
        debug: {
          refuted: [{ ...base, refuter_verdict: "refuted" }],
          deduped: [],
          root_causes: clusterByRootCause([]),
        },
      }),
      META,
    );
    expect(markdown).toContain("1 refuted, 0 merged as duplicates.");
    expect(markdown).toContain(
      "- F009 `src/app.ts:42` — double free — refuted",
    );
  });

  // #153: a severe claim discarded as a duplicate left NO trace here — only a
  // count — and that is why an authorization-bypass BLOCKER merged into a
  // claim about a different defect stayed invisible for as long as it did.
  // debug.deduped[] recorded it the whole time; nothing surfaced it.
  test("severe dedupe losers are named, not just counted", () => {
    const { tier: _tier, ...severe } = finding({
      id: "R7",
      path: "src/authz.ts",
      line: 26,
      severity: "BLOCKER",
      claim: "the catch fallback grants every required role to a principal",
    });
    const { tier: _advisoryTier, ...advisory } = finding({
      id: "R8",
      path: "src/authz.ts",
      line: 8,
      severity: "SUGGESTION",
      claim: "the cache map could carry a TTL",
    });
    const markdown = renderReport(
      doc({
        debug: {
          refuted: [],
          deduped: [
            { ...severe, merged_into: "F001" },
            { ...advisory, merged_into: "F002" },
          ],
          root_causes: clusterByRootCause([]),
        },
      }),
      META,
    );
    expect(markdown).toContain("0 refuted, 2 merged as duplicates.");
    expect(markdown).toContain(
      "- `src/authz.ts:26` — the catch fallback grants every required role " +
        "to a principal — merged into F001",
    );
    // Advisory severity stays counted only: the trace exists to make a lost
    // BLOCKER visible, not to reprint every merge.
    expect(markdown).not.toContain("the cache map could carry a TTL");
  });

  test("a CRITICAL dedupe loser is named too, and the list is spaced off the count", () => {
    const { tier: _tier, ...critical } = finding({
      id: "R7",
      path: "src/authz.ts",
      line: 16,
      severity: "CRITICAL",
      claim: "roleCache is never invalidated",
    });
    const markdown = renderReport(
      doc({
        debug: {
          refuted: [],
          deduped: [{ ...critical, merged_into: "F001" }],
          root_causes: clusterByRootCause([]),
        },
      }),
      META,
    );
    expect(markdown).toContain(
      "0 refuted, 1 merged as duplicates.\n\n" +
        "- `src/authz.ts:16` — roleCache is never invalidated — " +
        "merged into F001",
    );
  });

  test("advisory-only dedupe losers keep the section to a bare count", () => {
    const { tier: _tier, ...advisory } = finding({
      id: "R8",
      severity: "WARNING",
      claim: "a warning that merged away",
    });
    const markdown = renderReport(
      doc({
        debug: {
          refuted: [],
          deduped: [{ ...advisory, merged_into: "F001" }],
          root_causes: clusterByRootCause([]),
        },
      }),
      META,
    );
    expect(markdown).toContain("0 refuted, 1 merged as duplicates.");
    expect(markdown).not.toContain("a warning that merged away");
  });

  test("a document with no per_agent telemetry still renders the run line", () => {
    const markdown = renderReport(
      doc({ telemetry: { ...TELEMETRY, per_agent: undefined } }),
      META,
    );
    expect(markdown).toContain("run complete");
    expect(markdown).not.toContain("Agents:");
  });

  test("per-agent status is surfaced when the engine recorded it", () => {
    const markdown = renderReport(
      doc({
        telemetry: {
          ...TELEMETRY,
          per_agent: {
            reliability: {
              tokens_total: 1,
              duration_ms: 1,
              status: "ok",
            } as never,
            lifecycle: {
              tokens_total: 1,
              duration_ms: 1,
              status: "failed",
            } as never,
          },
        },
      }),
      META,
    );
    expect(markdown).toContain("Agents: reliability ok · lifecycle failed");
  });

  test("hunter prose that could break markdown is neutralised", () => {
    const findings = [
      finding({
        id: "F001",
        claim: "line one\nline two",
        path: "src/`weird`.ts",
        proof_refs: ["src/x.ts:1 (a\nmultiline ref)"],
      }),
    ];
    const markdown = renderReport(doc({ findings }), META);
    expect(markdown).toContain("line one line two");
    expect(markdown).toContain("### F001 — `src/'weird'.ts:42`");
    expect(markdown).toContain("  - src/x.ts:1 (a multiline ref)");
  });

  test("rendering is deterministic", () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", severity: "WARNING", tier: "advisory" }),
    ];
    const first = renderReport(doc({ findings }), META);
    const second = renderReport(doc({ findings }), META);
    expect(first).toBe(second);
  });

  test("the closing note names the engine and disclaims a merge gate", () => {
    const markdown = renderReport(doc(), META);
    expect(markdown).toContain("Generated by pr-hero 1.0.0.");
    expect(markdown).toContain("not a merge gate");
  });

  test("renders the artifact summary after run lines and before findings", () => {
    const markdown = renderReport(
      doc({
        findings: [finding({ id: "F001" })],
        summary: SUMMARY,
      }),
      META,
    );
    const block =
      "### Summary\n\n" +
      `${SUMMARY.prose}\n\n` +
      `**Confidence: ${SUMMARY.score}/5** — ${SUMMARY.score_reason}`;
    expect(markdown).toContain(block);
    expect(markdown.indexOf("The parity hunter did not fire")).toBeLessThan(
      markdown.indexOf(block),
    );
    expect(markdown.indexOf(block)).toBeLessThan(
      markdown.indexOf("## Blocking"),
    );
  });

  test("an absent summary preserves the report output byte-for-byte", () => {
    const markdown = renderReport(doc(), META);
    expect(markdown).toBe(
      "# Review — musive main..feature\n\n" +
        "3 files, +120 −45 · run complete · $12.90 · 12m 34s\n\n" +
        "Agents: reliability ran · lifecycle ran\n\n" +
        "The parity hunter did not fire: no changed path matched its trigger.\n\n" +
        "## Blocking (0 findings, 0 root causes)\n\n" +
        "_Nothing blocking._\n\n" +
        "## Advisory (0 findings, 0 root causes)\n\n" +
        "_Nothing advisory._\n\n" +
        "## Not reported\n\n" +
        "Nothing was refuted, and nothing was merged as a duplicate.\n\n" +
        "---\n\n" +
        "Generated by pr-hero 1.0.0. This is an assistant report, not a merge " +
        "gate: every line above is a claim to verify, and `blocking` means " +
        '"a human should look before this ships", never "the merge is blocked".\n',
    );
  });
});

describe("renderPrComment", () => {
  const WEB_URL = "https://github.com/musivetech/musive";
  const HEAD = "b".repeat(40);

  // The idempotency contract: postPrComment finds the previous comment by
  // the marker prefix, so the marker must be the very first line, always —
  // and since B3 it declares the document's own head sha, so the watch
  // guard can read WHICH head this comment covers.
  test("the first line is the marker declaring doc.head_sha", () => {
    expect(
      renderPrComment(doc(), undefined, undefined, [], undefined).split(
        "\n",
      )[0],
    ).toBe(prCommentMarker(HEAD));
    expect(
      renderPrComment(
        doc({ findings: [finding({ id: "F001" })] }),
        undefined,
        undefined,
        [],
        undefined,
      ).split("\n")[0],
    ).toBe(prCommentMarker(HEAD));
  });

  // Rereview-coverage fix (self-healing): a COMPLETE run's marker
  // stays byte-identical to today — this is the wire-format promise the
  // watcher's cross-machine guard, the CI admission block, and every
  // already-posted comment depend on.
  test("a complete run's marker is byte-identical to the pre-fix plain form", () => {
    const body = renderPrComment(
      doc({ run_status: "complete" }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body.split("\n")[0]).toBe(`<!-- pr-hero-report head=${HEAD} -->`);
  });

  // A PARTIAL run's marker carries the named coverage token so the NEXT
  // `pr-hero review --pr N` can tell (via parsePrCommentMarker) that this
  // run never finished, and must not trust L===H as "nothing changed since
  // a clean review" (GitHub #42's re-review half — MusiveTech/musive #1823).
  test("a partial run's marker carries the coverage=partial token, still under the same prefix", () => {
    const body = renderPrComment(
      doc({ run_status: "partial", telemetry: PARTIAL_TELEMETRY }),
      undefined,
      undefined,
      [],
      undefined,
    );
    const firstLine = body.split("\n")[0] ?? "";
    expect(firstLine).toBe(
      `<!-- pr-hero-report head=${HEAD} ${PR_COMMENT_COVERAGE_PARTIAL_TOKEN} -->`,
    );
    expect(firstLine.startsWith(PR_COMMENT_MARKER_PREFIX)).toBe(true);
  });

  // findMarkedCommentId matches on the prefix; a rendered comment that
  // stopped starting with it would orphan its own update path.
  test("the rendered body starts with the matcher's prefix", () => {
    expect(
      renderPrComment(doc(), undefined, undefined, [], undefined).startsWith(
        PR_COMMENT_MARKER_PREFIX,
      ),
    ).toBe(true);
  });

  // doc.base_sha IS the diff-from commit (the recorded rule in cli.ts), so
  // the summary line's two 8-char shas name the exact range reviewed.
  // Counted by SEVERITY, not tier (Juanma's PR #2 feedback item 3): F003 is
  // WARNING/advisory and counts in "warning", while F001/F002 are BLOCKER
  // (default) and count in "critical" regardless of what tier they landed.
  test("the summary line carries the severity counts and the reviewed range", () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
      finding({
        id: "F003",
        path: "src/c.ts",
        line: 30,
        severity: "WARNING",
        tier: "advisory",
      }),
    ];
    const body = renderPrComment(
      doc({ findings }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).toContain("## pr-hero review");
    expect(body).toContain(
      "🔴 2 critical · 🟡 1 warning — `bbbbbbbb`, diff from `aaaaaaaa`",
    );
  });

  // Item 3's actual point: counted by SEVERITY, not tier — a real posted PR
  // (PR #2) had two CRITICAL findings BOTH downgraded to advisory tier, and
  // the old tier-based headline read "0 blocking · 2 advisory", hiding that
  // both were genuinely CRITICAL. This is the case that distinguishes the
  // two counting rules: severity-based reads 2 critical / 0 warning here,
  // tier-based would read 0 / 0 (both landed advisory, neither is WARNING).
  test("a downgraded CRITICAL still counts as critical, never hidden by its advisory tier", () => {
    const findings = [
      finding({
        id: "F001",
        severity: "CRITICAL",
        refuter_verdict: "downgraded-latent",
        tier: "advisory",
      }),
      finding({
        id: "F002",
        severity: "CRITICAL",
        refuter_verdict: "downgraded-latent",
        tier: "advisory",
      }),
    ];
    const body = renderPrComment(
      doc({ findings }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).toContain("🔴 2 critical · 🟡 0 warning");
  });

  // #19 W0: the headline above still counts hunter severity, but the
  // per-finding index must not scream 🔴 next to a finding the engine
  // already made advisory.
  test("a downgraded CRITICAL index line uses the advisory scan aid, not 🔴", () => {
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 10,
        severity: "CRITICAL",
        refuter_verdict: "downgraded-latent",
        tier: "advisory",
      }),
    ];
    const body = renderPrComment(
      doc({ findings }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).toContain(
      `${scanAidEmoji({ severity: "CRITICAL", tier: "advisory" })} \`src/a.ts:10\` — the value is stored`,
    );
    expect(body).not.toContain("🔴 `src/a.ts:10`");
  });

  // ROADMAP B6 rework (Juanma's PR #2 feedback item 1): the earlier "one
  // finding, one place" decision stripped the summary's finding list
  // entirely, which read as empty on first contact. This partially reverses
  // it — but the reinstated list is a ONE-LINE index (emoji, location, a
  // short lead-in) with no tier headings, no full claim paragraph, and no
  // Evidence block of its own; those still live only on the per-finding
  // comment (renderInlineComment/renderIssueFindingComment).
  test("the summary carries a one-line index, never tier headings or evidence blocks", () => {
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 10,
        proof_refs: ["src/duration.ts:19-20 (fromSeconds stores raw seconds)"],
      }),
      finding({
        id: "F002",
        path: "src/b.ts",
        line: 20,
        severity: "WARNING",
        tier: "advisory",
      }),
    ];
    const body = renderPrComment(
      doc({ findings }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).not.toContain("### 🔴 Blocking");
    expect(body).not.toContain("### 🟡 Advisory");
    expect(body).not.toContain("#### `src/a.ts:10`");
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("Evidence");
    // The one-line index DOES carry a short lead-in of the claim now — the
    // partial reversal above — so this only asserts the FULL claim sentence
    // never appears (that stays on the per-finding comment).
    expect(body).toContain(
      `${severityEmoji("BLOCKER")} \`src/a.ts:10\` — the value is stored ` +
        "in seconds and read as milliseconds",
    );
    // No finding ids: engine internals stay in report.md.
    expect(body).not.toContain("F001");
  });

  // Priority order (Juanma's PR #2 feedback): severity rank first (BLOCKER,
  // CRITICAL, WARNING, SUGGESTION), then path, then line — this is the ONE
  // place priority ordering actually applies; posted inline comments
  // themselves sort however GitHub lays out file/line, not by pr-hero.
  test("the index sorts by severity rank, then path, then line", () => {
    const findings = [
      finding({
        id: "F001",
        path: "src/z.ts",
        line: 1,
        severity: "SUGGESTION",
        tier: "advisory",
      }),
      finding({
        id: "F002",
        path: "src/a.ts",
        line: 5,
        severity: "CRITICAL",
      }),
      finding({
        id: "F003",
        path: "src/a.ts",
        line: 1,
        severity: "CRITICAL",
      }),
      finding({
        id: "F004",
        path: "src/m.ts",
        line: 1,
        severity: "WARNING",
        tier: "advisory",
      }),
    ];
    const body = renderPrComment(
      doc({ findings }),
      undefined,
      undefined,
      [],
      undefined,
    );
    const lines = body
      .split("\n")
      .filter(
        (l) =>
          (l.startsWith("🔴") || l.startsWith("🟡") || l.startsWith("🔵")) &&
          !l.includes("critical"),
      );
    expect(lines).toEqual([
      `🔴 \`src/a.ts:1\` — ${finding({ id: "F003" }).claim}`,
      `🔴 \`src/a.ts:5\` — ${finding({ id: "F002" }).claim}`,
      `🟡 \`src/m.ts:1\` — ${finding({ id: "F004" }).claim}`,
      `🔵 \`src/z.ts:1\` — ${finding({ id: "F001" }).claim}`,
    ]);
  });

  test("an index line links to the finding's comment when the url map has one", () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const body = renderPrComment(
      doc({ findings }),
      undefined,
      undefined,
      [],
      undefined,
      new Map([
        ["F001", "https://github.com/musivetech/musive/pull/1#discussion_r5"],
      ]),
    );
    expect(body).toContain(
      "🔴 [`src/a.ts:10`](https://github.com/musivetech/musive/pull/1#discussion_r5) — the value",
    );
  });

  test("an index line without a url map entry renders plain, unlinked text", () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const body = renderPrComment(
      doc({ findings }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).toContain("🔴 `src/a.ts:10` — the value");
    expect(body).not.toContain("[`src/a.ts:10`]");
  });

  test("zero findings render the explicit clean bill", () => {
    const body = renderPrComment(doc(), undefined, undefined, [], undefined);
    expect(body).toContain("🔴 0 critical · 🟡 0 warning");
    expect(body).toContain(
      "✅ pr-hero reviewed this PR and found nothing to report.",
    );
    expect(body).not.toContain("### ");
  });

  // GitHub #42. The defect these pin: a `partial` run with zero findings used
  // to print the ✅ clean bill, and the ONLY disclosure that some agents never
  // finished was the word `partial` inside the <sub> footer. The decision
  // (ROADMAP-DOORDASH M1) is that such a run still posts — visible noise
  // beats invisible loss — so every assertion here is about what the body
  // SAYS, never about whether it exists.
  const PARTIAL_TELEMETRY: Telemetry = {
    ...TELEMETRY,
    per_agent: {
      reliability: { tokens_total: 60, duration_ms: 1000, status: "ok" },
      resilience: { tokens_total: 0, duration_ms: 0, status: "failed" },
      refuter: { tokens_total: 10, duration_ms: 100, status: "ok" },
    } as Telemetry["per_agent"],
  };

  test("a partial run with zero findings never prints the clean bill", () => {
    const body = renderPrComment(
      doc({ run_status: "partial", telemetry: PARTIAL_TELEMETRY }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).not.toContain("✅");
    expect(body).not.toContain("found nothing to report");
    expect(body).toContain(
      "The agents that completed reported nothing. That is not a clean " +
        "bill: read it against the coverage above.",
    );
  });

  test("the incompleteness notice sits above the finding count, not in the footer", () => {
    const body = renderPrComment(
      doc({ run_status: "partial", telemetry: PARTIAL_TELEMETRY }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).toContain("⚠️ **This review is incomplete.**");
    expect(body.indexOf("This review is incomplete")).toBeLessThan(
      body.indexOf("🔴 0 critical"),
    );
    // The footer disclosure that used to be the only one still stands; it is
    // no longer load-bearing.
    expect(body).toContain("<sub>run partial · ");
  });

  test("the notice names who completed and who did not, with the status verbatim", () => {
    const body = renderPrComment(
      doc({ run_status: "partial", telemetry: PARTIAL_TELEMETRY }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).toContain(
      "Completed: `reliability`, `refuter`. Did not complete: " +
        "`resilience` (failed).",
    );
  });

  // Every path that can produce a partial run with nothing to name: the
  // gotchas early-return writes an EMPTY per_agent map, a timeout abandons
  // steps whose rows were never written, and a pre-v2 artifact has no
  // per_agent at all. The notice must still print on all of them.
  test("a partial run that names nobody still says so, and says why it cannot", () => {
    for (const per_agent of [{}, undefined]) {
      const body = renderPrComment(
        doc({
          run_status: "partial",
          telemetry: { ...TELEMETRY, per_agent },
        }),
        undefined,
        undefined,
        [],
        undefined,
      );
      expect(body).toContain("⚠️ **This review is incomplete.**");
      expect(body).toContain(
        "No agent is recorded as completed. The run record does not name " +
          "which agents were lost.",
      );
      expect(body).not.toContain("✅");
    }
  });

  test("a partial run WITH findings is qualified too — the notice is not a zero-findings branch", () => {
    const body = renderPrComment(
      doc({
        run_status: "partial",
        telemetry: PARTIAL_TELEMETRY,
        findings: [finding({ id: "F001" })],
      }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).toContain("⚠️ **This review is incomplete.**");
    expect(body).toContain("`resilience` (failed)");
  });

  test("a complete run keeps its clean bill and grows no notice", () => {
    const body = renderPrComment(doc(), undefined, undefined, [], undefined);
    expect(body).toContain(
      "✅ pr-hero reviewed this PR and found nothing to report.",
    );
    expect(body).not.toContain("This review is incomplete");
  });

  // GitHub #39. The defect these pin: the review POST carried no commit_id,
  // so a push landing mid-review re-anchored every comment against a newer
  // diff — silently, whenever the line still existed and now meant something
  // else. The pin lives in pr/pr.ts; this is the half the READER sees.
  const MOVED_HEAD = "d".repeat(40);

  test("a moved head is disclosed above everything, naming both shas in full", () => {
    const body = renderPrComment(doc(), undefined, undefined, [], MOVED_HEAD);
    expect(body).toContain("⚠️ **The PR moved while this review ran.**");
    expect(body).toContain(
      `Reviewed \`${"b".repeat(40)}\`; the PR head is now \`${MOVED_HEAD}\`. ` +
        "Everything below describes the reviewed commit.",
    );
    // Above the counts it qualifies — a reader who meets the number first has
    // already read it as a statement about the current head.
    expect(body.indexOf("The PR moved while this review ran")).toBeLessThan(
      body.indexOf("🔴 0 critical"),
    );
  });

  // The marker is the machine-readable half, and the watch guard (B3) reads
  // it to decide which head a posted comment covers. Writing the CURRENT head
  // there would tell the watcher the new head was reviewed — the same silent
  // lie, relocated.
  test("a moved head never reaches the marker, which still names the reviewed head", () => {
    const body = renderPrComment(doc(), undefined, undefined, [], MOVED_HEAD);
    expect(body.split("\n")[0]).toBe(prCommentMarker("b".repeat(40)));
    expect(body.split("\n")[0]).not.toContain(MOVED_HEAD);
  });

  // A run can be BOTH partial and posted against a moved head, and the two
  // notices compose in one fixed order: which code the comment is about
  // first, how much of it was looked at second. Reversing them makes the
  // coverage sentence read as a statement about the current head.
  test("partial AND moved renders both notices, moved first, counts last", () => {
    const body = renderPrComment(
      doc({ run_status: "partial", telemetry: PARTIAL_TELEMETRY }),
      undefined,
      undefined,
      [],
      MOVED_HEAD,
    );
    const moved = body.indexOf("The PR moved while this review ran");
    const incomplete = body.indexOf("This review is incomplete");
    const counts = body.indexOf("🔴 0 critical");
    expect(moved).toBeGreaterThan(-1);
    expect(moved).toBeLessThan(incomplete);
    expect(incomplete).toBeLessThan(counts);
    // Both bodies survive intact — neither notice swallows the other.
    expect(body).toContain(`the PR head is now \`${MOVED_HEAD}\``);
    expect(body).toContain("`resilience` (failed)");
  });

  // Absent means "unmoved, or the re-read could not be made", and the two are
  // deliberately indistinguishable: the headline names the reviewed sha and
  // never claims it is current, so silence adds nothing rather than lying.
  test("an unmoved head inserts nothing — the counts still follow the heading", () => {
    const lines = renderPrComment(
      doc(),
      undefined,
      undefined,
      [],
      undefined,
    ).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      prCommentMarker("b".repeat(40)),
      "## pr-hero review",
      "",
      "🔴 0 critical · 🟡 0 warning — `bbbbbbbb`, diff from `aaaaaaaa`",
    ]);
  });

  test("the footer is the sub line with run status and engine", () => {
    const body = renderPrComment(doc(), undefined, undefined, [], undefined);
    expect(body).toContain(
      "<sub>run complete · pr-hero 1.0.0 · Assistant report, not a merge " +
        "gate: every line above is a claim to verify.</sub>",
    );
  });

  test("a document without engine info degrades honestly", () => {
    const body = renderPrComment(
      doc({ engine: undefined }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).toContain("pr-hero (version not recorded)");
  });

  // The no-economics contract: the fixture telemetry carries cost_usd_est
  // 12.9 and token counts, and none of it may reach a public comment — a
  // "$" anywhere in the body means the contract broke.
  test("no cost and no token counts anywhere", () => {
    const bodies = [
      renderPrComment(doc(), undefined, undefined, [], undefined),
      renderPrComment(
        doc({ findings: [finding({ id: "F001" })] }),
        WEB_URL,
        undefined,
        [],
        undefined,
      ),
    ];
    for (const body of bodies) {
      expect(body).not.toContain("$");
      expect(body).not.toContain("token");
    }
  });

  test("the summary head sha links to the commit only with a url", () => {
    const linked = renderPrComment(doc(), WEB_URL, undefined, [], undefined);
    expect(linked).toContain(`[\`bbbbbbbb\`](${WEB_URL}/commit/${HEAD})`);
    expect(
      renderPrComment(doc(), undefined, undefined, [], undefined),
    ).not.toContain("/commit/");
  });

  test("a trailing slash on the url is normalized away", () => {
    const d = doc({ findings: [finding({ id: "F001" })] });
    const withSlash = renderPrComment(
      d,
      `${WEB_URL}/`,
      undefined,
      [],
      undefined,
    );
    expect(withSlash).toBe(
      renderPrComment(d, WEB_URL, undefined, [], undefined),
    );
    expect(withSlash).not.toContain("musive//");
  });

  test("an absent url renders byte-identical to the plain shape", () => {
    const d = doc({ findings: [finding({ id: "F001" })] });
    expect(renderPrComment(d, undefined, undefined, [], undefined)).toBe(
      renderPrComment(d, undefined, undefined, [], undefined),
    );
  });

  // The delta line (design D5) is omitted entirely when the caller passes
  // no delta at all — every test above exercises exactly that path, so this
  // is the one asserting the negative explicitly.
  test("no delta argument renders no delta line", () => {
    const body = renderPrComment(doc(), undefined, undefined, [], undefined);
    expect(body).not.toContain("Δ");
  });

  // Spec "First-ever run": the delta STILL renders on the very first post
  // (0 resolved · K new · 0 persist), just without a "since <sha>" clause —
  // there is no previous head to name yet.
  test("a first run renders the delta without a since-sha clause", () => {
    const body = renderPrComment(
      doc({ findings: [finding({ id: "F001" })] }),
      undefined,
      {
        resolved: 0,
        new: 1,
        persist: 0,
      },
      [],
      undefined,
    );
    expect(body).toContain("Δ: 0 resolved · 1 new · 0 persist");
    expect(body).not.toContain("since");
  });

  test("O-1a — absence-only cannot print resolved; refuted and deletion can", () => {
    const absence = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 2,
        new: 0,
        persist: 0,
        rereview: {
          verifiedGone: 0,
          unconfirmed: 0,
          carried: 2,
          deferred: 0,
          new: 0,
          suppressed: 0,
          returned: 0,
          reTiered: 0,
        },
      },
      [],
      undefined,
    );
    expect(absence).not.toContain("resolved");
    expect(absence).toContain(
      "Δ: 0 unconfirmed · 2 carried · 0 deferred · 0 new",
    );

    const refuted = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 99,
        new: 0,
        persist: 0,
        rereview: {
          verifiedGone: 1,
          unconfirmed: 0,
          carried: 0,
          deferred: 0,
          new: 0,
          suppressed: 0,
          returned: 0,
          reTiered: 0,
        },
      },
      [],
      undefined,
    );
    expect(refuted).toContain("1 resolved (verified)");
    expect(refuted).toContain("✅");
  });

  test("C7-clean — zero new + carried is not a clean bill", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 1,
        new: 0,
        persist: 1,
        rereview: {
          verifiedGone: 0,
          unconfirmed: 0,
          carried: 1,
          deferred: 0,
          new: 0,
          suppressed: 0,
          returned: 0,
          reTiered: 0,
        },
      },
      [],
      undefined,
    );
    expect(body).not.toContain("✅");
    expect(body).toContain("Live: 1 carried");
  });

  // A triage-driven prior is persisted as carried, so the delta counts it once.
  // Built through assembleLive and rereviewDeltaFromProvenance, the same path
  // fillRereviewProvenance takes, so the test proves what the renderer reads.
  // The trailing period pins the list: any extra bucket would sit before it.
  test.each([
    [
      "a misclassified prior",
      { tag: "misclassified", verdict: null, createdAt: null },
      "re-tiered",
    ],
    [
      "a rejected dismissal",
      { tag: "dismissed", verdict: "rejected", createdAt: null },
      "returned",
    ],
  ] as const)(
    "%s renders as one carried finding, with no re-tiered or returned segment",
    (_label, triage, status) => {
      const prior: PriorRecord = {
        id: "R001",
        sev: "CRITICAL",
        tier: "blocking",
        channel: "inline",
        locs: ["src/app.ts:10"],
        claim: "a live defect",
        triage,
        newThreadReply: false,
      };
      const assembled = assembleLive({
        settled: [
          { id: "R001", status, locs: ["src/app.ts:10"], renamed: false },
        ],
        priors: [prior],
        verifyVerdicts: new Map(),
      });
      const body = renderPrComment(
        doc(),
        undefined,
        {
          resolved: 0,
          new: 0,
          persist: 1,
          rereview: rereviewDeltaFromProvenance(
            {
              live: assembled.live,
              returned: assembled.returned,
              re_tiered: assembled.reTiered,
            },
            0,
          ),
        },
        [],
        undefined,
      );
      expect(body).toContain("No new findings this delta. Live: 1 carried.");
    },
  );

  // GitHub #166: a same-head re-review (case B) or a restricted delta that
  // touches none of the PR's own files (case C) runs ZERO discovery hunters.
  // The old behavior let a zero-findings result fall through to the ordinary
  // clean-bill branches, which both read as "we looked and found nothing" —
  // exactly backwards when nothing looked at all. `discoverySkippedEmptyDelta`
  // (mirroring `RereviewProvenance.discovery_skipped_empty_delta`,
  // rereview/prepare.ts) is the signal `cleanBillLine` must check FIRST,
  // ahead of both the generic ✅ and the ordinary "No new findings this
  // delta" wording.
  //
  // pr-hero review #286 then found the fix's OWN wording asserted facts the
  // flag does not carry (5 findings, all pinned below): "no changes" is false
  // when the delta was real but entirely excluded by ignore rules; "no
  // hunter ran... not re-verified" is false whenever a verifier IS queued in
  // the same pass; and the "clean" check ignored `verifiedGone`, so a run
  // that resolved every prior claimed the last review "reported nothing".
  const NO_DELTA = {
    verifiedGone: 0,
    unconfirmed: 0,
    carried: 0,
    deferred: 0,
    new: 0,
    suppressed: 0,
    returned: 0,
    reTiered: 0,
    discoverySkippedEmptyDelta: true,
  };

  test("#166a — no-delta clean: no live priors, no resolution, reason absent (no_delta)", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: { ...NO_DELTA },
      },
      [],
      undefined,
    );
    expect(body).not.toContain("found nothing to report");
    expect(body).toContain("No changes since the last review of this head.");
    expect(body).toContain("No discovery hunter ran this pass.");
    expect(body).toContain(
      "No live findings are carried from the previous review.",
    );
    // Never a bare "no hunter ran" — it must always say DISCOVERY hunter,
    // since a verifier is a different kind of run this same wording must
    // not rule out.
    expect(body).not.toContain(" no hunter ran");
  });

  // #286 finding 1 (report.ts:846 exclusion wording / discovery.ts:216
  // exclusion): `discoverySkipReason: "all_excluded"` is a REAL, non-empty
  // delta that ignore rules stripped to nothing — "no changes" is false
  // here, and the PR comment must name what was excluded (previously only
  // the local report.md did, report.ts's `excludedPaths` rendering).
  test("#286b — all-excluded: names the dropped paths, never claims nothing changed", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: {
          ...NO_DELTA,
          discoverySkipReason: "all_excluded",
          discoveryExcludedPaths: ["dist/bundle.js", "vendor/lib.min.js"],
        },
      },
      [],
      undefined,
    );
    expect(body).not.toContain("No changes since the last review");
    expect(body).not.toContain("nothing changed");
    expect(body).toContain(
      "Every changed file was excluded from review " +
        "(dist/bundle.js, vendor/lib.min.js), so the effective diff is empty.",
    );
    expect(body).toContain("No discovery hunter ran this pass.");
  });

  // #286 finding 3 (report.ts:817 rereviewIsClean ignoring verifiedGone):
  // a case-B run whose queued verifier resolved a prior this pass is not
  // "the last review reported nothing" — it is a resolution, and the old
  // wording erased it.
  test("#286 — case B where verification resolved every prior: wording reflects resolved, not clean", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: { ...NO_DELTA, verifiedGone: 2 },
      },
      [],
      undefined,
    );
    expect(body).not.toContain(
      "No live findings are carried from the previous review",
    );
    expect(body).not.toContain("reported nothing");
    expect(body).toContain("2 prior findings resolved (verified) this pass.");
  });

  test("#286 — case B with BOTH a resolution and still-live carried findings, both named", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: {
          ...NO_DELTA,
          verifiedGone: 1,
          carried: 1,
          live: [
            {
              id: "R001",
              sev: "WARNING",
              status: "carried",
              locs: ["src/app.ts:10"],
              claim: "still live one",
            },
          ],
        },
      },
      [],
      undefined,
    );
    expect(body).toContain("1 prior finding resolved (verified) this pass.");
    expect(body).toContain("Still live: 1 carried.");
    expect(body).toContain("(R001)");
  });

  test("#166 — an ordinary re-review (discovery ran) keeps its unqualified wording", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 1,
        rereview: {
          verifiedGone: 0,
          unconfirmed: 0,
          carried: 1,
          deferred: 0,
          new: 0,
          suppressed: 0,
          returned: 0,
          reTiered: 0,
        },
      },
      [],
      undefined,
    );
    expect(body).toContain("No new findings this delta. Live: 1 carried.");
    expect(body).not.toContain("No discovery hunter ran");
  });

  test("C7-unconfirmed — a cap hit is not a clean bill", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: {
          verifiedGone: 0,
          unconfirmed: 2,
          carried: 0,
          deferred: 0,
          new: 0,
          suppressed: 0,
          returned: 0,
          reTiered: 0,
        },
      },
      [],
      undefined,
    );
    expect(body).not.toContain("✅");
    expect(body).toContain("Live: 2 unconfirmed");
  });

  test("O-2b — every non-suppressed live finding is listed with status", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: {
          verifiedGone: 0,
          unconfirmed: 0,
          carried: 1,
          deferred: 1,
          new: 0,
          suppressed: 1,
          returned: 0,
          reTiered: 0,
          live: [
            {
              id: "R001",
              sev: "CRITICAL",
              status: "carried",
              locs: ["src/app.ts:10"],
              claim: "still live",
            },
            {
              id: "R002",
              sev: "WARNING",
              status: "deferred",
              locs: ["src/b.ts:1"],
              claim: "later",
            },
            {
              id: "R003",
              sev: "WARNING",
              status: "suppressed",
              locs: ["src/c.ts:1"],
              claim: "hidden",
            },
          ],
        },
      },
      [],
      undefined,
    );
    expect(body).toContain("`carried`");
    expect(body).toContain("(R001)");
    expect(body).toContain("`deferred`");
    expect(body).toContain("(R002)");
    expect(body).not.toContain("(R003)");
    expect(body).toContain("1 finding suppressed");
    expect(body).toContain("🔴 1 critical · 🟡 1 warning");
  });

  // The three below pin the WHOLE rendered row, not a substring. O-2b's
  // `toContain` assertions cannot see a gap INSIDE the line, and that is
  // exactly what PR #179's second review posted:
  //   - `carried` 🟡 `src/wizard.ts:721` —  (R002)
  // a separator with nothing after it. A live row rebuilt from a posted
  // `<!-- pr-hero-finding -->` marker has no claim BY DESIGN — the marker
  // never carried one and `priorsFromPostedMarkers` sets `claim: ""` so that
  // `claimFingerprint("")`, the one constant every claim-less prior shares,
  // can never act as a tie-break (rereview/prepare.ts's WHY at :534 and
  // :570-578). So the data stays as it is and the RENDER has to say so.
  const liveRowBody = (row: RereviewLiveRow): string =>
    renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: {
          verifiedGone: 0,
          unconfirmed: 0,
          carried: 1,
          deferred: 0,
          new: 0,
          suppressed: 0,
          returned: 0,
          reTiered: 0,
          live: [row],
        },
      },
      [],
      undefined,
    );

  const liveRowLine = (body: string, id: string): string | undefined =>
    body.split("\n").find((line) => line.includes(`(${id})`));

  test("O-2c — a live row with a claim renders it verbatim after the separator", () => {
    const body = liveRowBody({
      id: "R001",
      sev: "WARNING",
      status: "carried",
      locs: ["src/wizard.ts:721"],
      claim: "the wizard writes before it validates",
    });
    expect(liveRowLine(body, "R001")).toBe(
      "- `carried` 🟡 `src/wizard.ts:721` — the wizard writes before it validates (R001)",
    );
    expect(body).not.toContain("\x1b");
  });

  test("O-2d — a live row with no claim says so, never a bare separator", () => {
    const body = liveRowBody({
      id: "R002",
      sev: "WARNING",
      status: "carried",
      locs: ["src/wizard.ts:721"],
      claim: "",
    });
    const line = liveRowLine(body, "R002");
    expect(line).toBe(
      "- `carried` 🟡 `src/wizard.ts:721` — _claim text unavailable; " +
        "see this finding's own comment on the PR_ (R002)",
    );
    expect(line).not.toContain("—  ");
    expect(body).not.toContain("\x1b");
  });

  test("O-2e — a whitespace-only claim is the same case as an empty one", () => {
    const body = liveRowBody({
      id: "R003",
      sev: "CRITICAL",
      status: "deferred",
      locs: ["src/pr.ts:42"],
      claim: "  \n\t ",
    });
    const line = liveRowLine(body, "R003");
    expect(line).toBe(
      "- `deferred` 🔴 `src/pr.ts:42` — _claim text unavailable; " +
        "see this finding's own comment on the PR_ (R003)",
    );
    expect(line).not.toContain("—  ");
  });

  test("#206 — an unrecoverable severity renders its own glyph, never a real-severity one", () => {
    const body = liveRowBody({
      id: "R004",
      sev: SEVERITY_UNRECOVERABLE,
      status: "carried",
      locs: ["src/watch.ts:614"],
      claim: "",
    });
    const line = liveRowLine(body, "R004");
    expect(line).toBe(
      "- `carried` ⚠️ severity unavailable `src/watch.ts:614` — " +
        "_claim text unavailable; see this finding's own comment on the " +
        "PR_ (R004)",
    );
    // Never one of the three real-severity glyphs — reusing 🟡 by accident
    // IS the bug (a live BLOCKER rendering as a warning).
    expect(line).not.toContain("🔴");
    expect(line).not.toContain("🟡");
    expect(line).not.toContain("🔵");
  });

  test("#206 — the headline gives an unrecoverable severity its own bucket, never warning", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: {
          verifiedGone: 0,
          unconfirmed: 0,
          carried: 1,
          deferred: 0,
          new: 0,
          suppressed: 0,
          returned: 0,
          reTiered: 0,
          live: [
            {
              id: "R001",
              sev: SEVERITY_UNRECOVERABLE,
              status: "carried",
              locs: ["src/watch.ts:614"],
              claim: "",
            },
          ],
        },
      },
      [],
      undefined,
    );
    expect(body).toContain(
      "🔴 0 critical · 🟡 0 warning · ⚠️ 1 severity unavailable",
    );
  });

  test("#206 — a recovered BLOCKER live row counts as critical, headline never says 0 critical", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: {
          verifiedGone: 0,
          unconfirmed: 0,
          carried: 1,
          deferred: 0,
          new: 0,
          suppressed: 0,
          returned: 0,
          reTiered: 0,
          live: [
            {
              id: "R001",
              sev: "BLOCKER",
              status: "carried",
              locs: ["src/watch.ts:614"],
              claim: "a live blocker recovered from its own comment",
            },
          ],
        },
      },
      [],
      undefined,
    );
    expect(body).toContain("🔴 1 critical · 🟡 0 warning");
    expect(body).not.toContain("🔴 0 critical");
  });

  test("D4 — force-push case banners the full-range review", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: {
          verifiedGone: 0,
          unconfirmed: 0,
          carried: 0,
          deferred: 0,
          new: 0,
          suppressed: 0,
          returned: 0,
          reTiered: 0,
          case: "D",
        },
      },
      [],
      undefined,
    );
    expect(body).toContain("not an ancestor of this head");
  });

  test("W-cap — over-cap is loud in the body", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 0,
        rereview: {
          verifiedGone: 0,
          unconfirmed: 2,
          carried: 0,
          deferred: 0,
          new: 0,
          suppressed: 0,
          returned: 0,
          reTiered: 0,
          capped: 2,
        },
      },
      [],
      undefined,
    );
    expect(body).toContain("verification cap");
    expect(body).toContain("--yes");
  });

  // Spec "Mixed run": a since-sha clause appears once a previous head is
  // known (the prior summary marker's own head=, per design D5).
  test("a second run renders the delta with a since-sha clause", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 1,
        new: 1,
        persist: 2,
        previousHeadSha: "c".repeat(40),
      },
      [],
      undefined,
    );
    expect(body).toContain(
      "Δ since `cccccccc`: 1 resolved · 1 new · 2 persist",
    );
  });

  // Juanma's PR #2 feedback: "Δ since f933fda8" printed on head f933fda8 is
  // noise — a re-run on an UNCHANGED head, not a genuinely absent prior
  // state, which the "first run" test above already covers separately.
  test("the since-sha clause is omitted when the previous head equals the current head", () => {
    const body = renderPrComment(
      doc(),
      undefined,
      {
        resolved: 0,
        new: 0,
        persist: 2,
        previousHeadSha: "b".repeat(40), // same as doc().head_sha
      },
      [],
      undefined,
    );
    expect(body).toContain("Δ: 0 resolved · 0 new · 2 persist");
    expect(body).not.toContain("since");
  });

  test("renders the artifact summary before the finding index", () => {
    const body = renderPrComment(
      doc({
        findings: [finding({ id: "F001" })],
        summary: SUMMARY,
      }),
      undefined,
      undefined,
      [],
      undefined,
    );
    const block =
      "### Summary\n\n" +
      `${SUMMARY.prose}\n\n` +
      `**Confidence: ${SUMMARY.score}/5** — ${SUMMARY.score_reason}`;
    expect(body).toContain(block);
    expect(body.indexOf(block)).toBeLessThan(
      body.indexOf("🔴 `src/app.ts:42`"),
    );
    expect(body).not.toContain("$12.90");
    expect(body).not.toContain("120 tokens");
  });

  test("an absent summary preserves the comment output byte-for-byte", () => {
    const body = renderPrComment(doc(), undefined, undefined, [], undefined);
    expect(body).toBe(
      "<!-- pr-hero-report head=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->\n" +
        "## pr-hero review\n\n" +
        "🔴 0 critical · 🟡 0 warning — `bbbbbbbb`, diff from `aaaaaaaa`\n\n" +
        "✅ pr-hero reviewed this PR and found nothing to report.\n\n" +
        "---\n\n" +
        "<sub>run complete · pr-hero 1.0.0 · Assistant report, not a merge " +
        "gate: every line above is a claim to verify.</sub>\n",
    );
  });

  // W2 (issues #16/#17): un-anchorable findings live in a Greptile-shaped
  // Comments Outside Diff section inside THIS summary. Empty/absent (the
  // caller must still pass `[]` — WARN-3) means no section at all.
  test("an empty outside-diff list renders no Comments Outside Diff section", () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const body = renderPrComment(
      doc({ findings }),
      undefined,
      undefined,
      [],
      undefined,
    );
    expect(body).not.toContain("Comments Outside Diff");
  });

  test("two outside-diff findings render one section with both full bodies", () => {
    const a = finding({
      id: "F001",
      path: "src/never-a.ts",
      line: 1,
      claim: "first un-anchorable claim",
    });
    const b = finding({
      id: "F002",
      path: "src/never-b.ts",
      line: 2,
      claim: "second un-anchorable claim",
    });
    const body = renderPrComment(
      doc({ findings: [a, b] }),
      WEB_URL,
      undefined,
      [a, b],
      undefined,
    );
    expect(body).toContain("### Comments Outside Diff (2)");
    expect(body).toContain("first un-anchorable claim");
    expect(body).toContain("second un-anchorable claim");
    expect(body).toContain(
      `[\`src/never-a.ts:1\`](${WEB_URL}/blob/${HEAD}/src/never-a.ts#L1)`,
    );
    expect(body).toContain(
      `[\`src/never-b.ts:2\`](${WEB_URL}/blob/${HEAD}/src/never-b.ts#L2)`,
    );
    expect(body).toContain("Prompt to fix with AI");
    expect(body).not.toContain("Posted as a standalone comment");
    expect(body).not.toContain("$");
    expect(body).not.toContain("token");
    // Index stays one-liners (lead-in); the bucket has the full body. Both
    // may mention the claim — Greptile does similar — but the index line is
    // not the full finding block.
    const indexLine = body
      .split("\n")
      .find((l) => l.startsWith("🔴 `src/never-a.ts:1`"));
    expect(indexLine).toBeDefined();
    expect(indexLine).not.toContain("Prompt to fix");
  });

  test("outside-diff findings without a url map stay unlinked in the index", () => {
    const f = finding({
      id: "F001",
      path: "src/never.ts",
      line: 1,
      claim: "could not anchor this finding",
    });
    const body = renderPrComment(
      doc({ findings: [f] }),
      WEB_URL,
      undefined,
      [f],
      undefined,
    );
    expect(body).toContain(
      "🔴 `src/never.ts:1` — could not anchor this finding",
    );
    expect(body).not.toContain("#discussion_r");
    expect(body).not.toContain("#issuecomment-");
    expect(body).toContain("### Comments Outside Diff (1)");
    expect(body).toContain(
      `[\`src/never.ts:1\`](${WEB_URL}/blob/${HEAD}/src/never.ts#L1)`,
    );
  });
});

// #206: parseFindingCommentBadge is renderInlineComment/findingBodyLines'
// exact structural inverse — the recovery path a carried prior falls back to
// when the re-review's state block cannot supply sev/tier/claim.
describe("parseFindingCommentBadge — round trip with the renderer that wrote it", () => {
  const HEAD = "b".repeat(40);

  test("recovers sev/tier/claim from a rendered inline comment, byte for byte", () => {
    const f = finding({
      id: "F001",
      severity: "BLOCKER",
      tier: "blocking",
      claim: "the retry never clears the prior timer",
    });
    const body = renderInlineComment(f, HEAD);
    expect(parseFindingCommentBadge(body)).toEqual({
      sev: "BLOCKER",
      tier: "blocking",
      claim: f.claim,
    });
  });

  test("recovers a WARNING/advisory finding too, not just the BLOCKER shape", () => {
    const f = finding({
      id: "F002",
      severity: "WARNING",
      tier: "advisory",
      refuter_verdict: "downgraded-latent",
      claim: "a minor inconsistency",
    });
    const body = renderInlineComment(f, HEAD);
    expect(parseFindingCommentBadge(body)).toEqual({
      sev: "WARNING",
      tier: "advisory",
      claim: "a minor inconsistency",
    });
  });

  test("recovers from the standalone (Outside Diff) renderer too", () => {
    const f = finding({ id: "F003", claim: "an un-anchorable finding" });
    const body = renderIssueFindingComment(f, HEAD);
    expect(parseFindingCommentBadge(body)).toEqual({
      sev: f.severity,
      tier: f.tier,
      claim: f.claim,
    });
  });

  test("a body with no pr-hero-finding marker at all returns null", () => {
    expect(
      parseFindingCommentBadge("just a human reply, no marker here"),
    ).toBeNull();
    expect(parseFindingCommentBadge("")).toBeNull();
  });

  test("a marker with no readable header returns null rather than a guess", () => {
    const body =
      `<!-- pr-hero-finding path=a.ts line=1 head=${HEAD} c=aaaaaaaaaaaa -->\n` +
      "\n" +
      "not a badge line at all\n";
    expect(parseFindingCommentBadge(body)).toBeNull();
  });
});

describe("renderInlineComment", () => {
  const WEB_URL = "https://github.com/musivetech/musive";
  const HEAD = "b".repeat(40);

  // The identity marker (pr/preflight.ts) is the FIRST line of every
  // per-finding comment, mirroring prCommentMarker's own contract — this is
  // what lets a second run tell "already posted" from "new" without
  // touching dedupe_key/root_cause_id.
  test("the first line is the finding marker for this path/line/head", () => {
    const f = finding({ id: "F001", path: "src/a.ts", line: 10 });
    const body = renderInlineComment(f, HEAD);
    expect(body.split("\n")[0]).toBe(
      findingMarker({
        path: "src/a.ts",
        line: 10,
        headSha: HEAD,
        claim: f.claim,
      }),
    );
  });

  // Header line (GitHub #19 W0 + PR #2 items 3/4): the scan aid is tier
  // (emoji + word), then hunter severity, causal disposition, and hunter.
  // Leading with severity made an advisory CRITICAL scream 🔴 CRITICAL.
  test("the header line leads with tier, then severity, causal disposition, and hunter", () => {
    const body = renderInlineComment(
      finding({
        id: "F001",
        causal_disposition: "introduced",
        hunter: "lifecycle",
      }),
      HEAD,
    );
    expect(body).toContain(
      `${scanAidEmoji({ severity: "BLOCKER", tier: "blocking" })} blocking · BLOCKER · introduced · lifecycle`,
    );
  });

  test("an advisory CRITICAL header scans as advisory, and still names CRITICAL", () => {
    const body = renderInlineComment(
      finding({
        id: "F001",
        severity: "CRITICAL",
        refuter_verdict: "downgraded-latent",
        tier: "advisory",
        hunter: "lifecycle",
      }),
      HEAD,
    );
    expect(body).toContain(
      `${scanAidEmoji({ severity: "CRITICAL", tier: "advisory" })} advisory · CRITICAL · introduced · lifecycle`,
    );
    expect(body).not.toContain("🔴 CRITICAL");
    expect(body).not.toContain("🔴 blocking");
  });

  test("the location line carries path:line and the symbol when present", () => {
    const withSymbol = renderInlineComment(
      finding({
        id: "F001",
        path: "src/inline.ts",
        line: 72,
        symbol: "anchorLinesForRecord()",
      }),
      HEAD,
    );
    expect(withSymbol).toContain("`src/inline.ts:72` — anchorLinesForRecord()");
    const withoutSymbol = renderInlineComment(
      finding({ id: "F001", path: "src/inline.ts", line: 72 }),
      HEAD,
    );
    expect(withoutSymbol).toContain("`src/inline.ts:72`\n");
    expect(withoutSymbol).not.toContain("`src/inline.ts:72` —");
  });

  // No link on the inline variant: GitHub already anchors this comment to
  // the diff line, so a self-link would be redundant.
  test("the inline location line is never a link, even with a repo url", () => {
    const body = renderInlineComment(
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      HEAD,
      WEB_URL,
    );
    expect(body).not.toContain("[`src/a.ts:10`]");
  });

  test("carries the claim as a paragraph", () => {
    const body = renderInlineComment(finding({ id: "F001" }), HEAD);
    expect(body).toContain(
      "the value is stored in seconds and read as milliseconds",
    );
    // No finding id: engine internals stay in report.md.
    expect(body).not.toContain("F001");
  });

  // Item 3/4: the tier-explanation line appears ONLY when severity and tier
  // disagree — never a tautology when they already agree.
  test("no tier-explanation line when severity and tier agree", () => {
    const body = renderInlineComment(finding({ id: "F001" }), HEAD);
    expect(body).not.toContain("Downgraded to advisory");
  });

  test("a downgraded-latent CRITICAL names the refuter verdict and its gloss", () => {
    const body = renderInlineComment(
      finding({
        id: "F001",
        severity: "CRITICAL",
        refuter_verdict: "downgraded-latent",
        tier: "advisory",
      }),
      HEAD,
    );
    expect(body).toContain(
      "⚖️ Downgraded to advisory — the refuter returned `downgraded-latent`",
    );
    expect(body).toContain("(real, but no live trigger today)");
  });

  test("a demoted CRITICAL with a different verdict names it without a gloss", () => {
    const body = renderInlineComment(
      finding({
        id: "F001",
        severity: "CRITICAL",
        evidence_class: "inferential",
        refuter_verdict: "inconclusive",
        tier: "advisory",
      }),
      HEAD,
    );
    expect(body).toContain(
      "⚖️ Downgraded to advisory — the refuter returned `inconclusive`",
    );
    expect(body).not.toContain("real, but no live trigger");
  });

  test("evidence folds into details with the blank-line discipline, count in the label", () => {
    const body = renderInlineComment(finding({ id: "F001" }), HEAD);
    expect(body).toContain(
      "<details><summary>Evidence (1)</summary>\n\n" +
        "- `src/duration.ts:19-20 (fromSeconds stores raw seconds)`\n\n" +
        "</details>",
    );
  });

  test("a finding without proof refs has no evidence block, but keeps the prompt block", () => {
    const body = renderInlineComment(
      finding({ id: "F001", proof_refs: [] }),
      HEAD,
    );
    expect(body).not.toContain("Evidence");
    expect(body).toContain("Prompt to fix with AI");
  });

  // Item "Prompt to fix with AI": a copy-pasteable prompt naming the path,
  // line, and claim — never a deep link to a hosted service this project
  // does not have.
  test("the prompt-to-fix block is copy-pasteable, never a deep link", () => {
    const body = renderInlineComment(
      finding({ id: "F001", path: "src/inline.ts", line: 72 }),
      HEAD,
    );
    expect(body).toContain("<details><summary>Prompt to fix with AI</summary>");
    expect(body).toContain("Fix this issue in src/inline.ts at line 72:");
    expect(body).toContain(
      "the value is stored in seconds and read as milliseconds",
    );
    expect(body).not.toContain("http");
  });

  test("a repo web url turns an evidence ref into a blob link", () => {
    const body = renderInlineComment(
      finding({
        id: "F001",
        proof_refs: ["src/duration.ts:19-20 (stores raw seconds)"],
      }),
      HEAD,
      WEB_URL,
    );
    expect(body).toContain(
      `- [\`src/duration.ts:19-20\`](${WEB_URL}/blob/${HEAD}/src/duration.ts#L19-L20) (stores raw seconds)`,
    );
  });

  test("a ref with no parseable anchor falls back to a code span", () => {
    const body = renderInlineComment(
      finding({ id: "F001", proof_refs: ["see the config handling"] }),
      HEAD,
      WEB_URL,
    );
    expect(body).toContain("- `see the config handling`");
    expect(body).not.toContain("- [`see");
  });

  test("hunter prose that could break markdown is neutralised", () => {
    const body = renderInlineComment(
      finding({
        id: "F001",
        claim: "line one\nline two",
        proof_refs: ["src/`x`.ts:1 (a\nmultiline ref)"],
      }),
      HEAD,
    );
    expect(body).toContain("line one line two");
    expect(body).toContain("- `src/'x'.ts:1 (a multiline ref)`");
  });

  test("no cost or token figures anywhere", () => {
    const body = renderInlineComment(finding({ id: "F001" }), HEAD, WEB_URL);
    expect(body).not.toContain("$");
    expect(body).not.toContain("token");
  });
});

describe("renderIssueFindingComment", () => {
  const WEB_URL = "https://github.com/musivetech/musive";
  const HEAD = "b".repeat(40);

  test("the first line is the finding marker, same contract as inline", () => {
    const f = finding({ id: "F001", path: "src/a.ts", line: 10 });
    const body = renderIssueFindingComment(f, HEAD);
    expect(body.split("\n")[0]).toBe(
      findingMarker({
        path: "src/a.ts",
        line: 10,
        headSha: HEAD,
        claim: f.claim,
      }),
    );
  });

  // Unlike the inline comment (already attached to a line by GitHub), the
  // issue comment's location line links to the blob — otherwise a reader has
  // no way to reach the code at all.
  test("carries a header, location line, and states it is standalone", () => {
    const body = renderIssueFindingComment(
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      HEAD,
    );
    expect(body).toContain(
      `${scanAidEmoji({ severity: "BLOCKER", tier: "blocking" })} blocking · BLOCKER · introduced · reliability`,
    );
    expect(body).toContain("`src/a.ts:10`");
    expect(body).toContain("could not anchor this");
  });

  test("the location line becomes a blob link with a repo url", () => {
    const body = renderIssueFindingComment(
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      HEAD,
      WEB_URL,
    );
    expect(body).toContain(
      `[\`src/a.ts:10\`](${WEB_URL}/blob/${HEAD}/src/a.ts#L10)`,
    );
  });

  test("carries the prompt-to-fix block too", () => {
    const body = renderIssueFindingComment(
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      HEAD,
    );
    expect(body).toContain("Prompt to fix with AI");
    expect(body).toContain("Fix this issue in src/a.ts at line 10:");
  });

  test("no cost or token figures anywhere", () => {
    const body = renderIssueFindingComment(
      finding({ id: "F001" }),
      HEAD,
      WEB_URL,
    );
    expect(body).not.toContain("$");
    expect(body).not.toContain("token");
  });

  // Defence in depth for the PR #50 crash. The boundary now normalises this
  // away, so a null symbol should be unreachable here — but the guard was
  // `=== undefined`, `null` slipped past it into oneLine(), and the TypeError
  // took down a POST the pipeline had already billed $3.77 for. A renderer
  // that throws loses paid work; one that renders loses a symbol. The cast is
  // deliberate: it reproduces what the type system says cannot happen.
  test("renders a runtime-null symbol instead of throwing", () => {
    const f = {
      ...finding({ id: "F001", path: "src/a.ts", line: 10 }),
      symbol: null,
    } as unknown as Finding;
    const body = renderIssueFindingComment(f, HEAD);
    expect(body).toContain("`src/a.ts:10`");
    expect(body).not.toContain("null");
  });

  test("renders a runtime-null symbol as a blob link too", () => {
    const f = {
      ...finding({ id: "F001", path: "src/a.ts", line: 10 }),
      symbol: null,
    } as unknown as Finding;
    const body = renderIssueFindingComment(f, HEAD, WEB_URL);
    expect(body).toContain(
      `[\`src/a.ts:10\`](${WEB_URL}/blob/${HEAD}/src/a.ts#L10)`,
    );
  });
});

describe("estimateCost", () => {
  const SMALL = { files: 3, insertions: 120, deletions: 45 };
  const LARGE = { files: 45, insertions: 2775, deletions: 1237 };

  test("returns a band, never a point", () => {
    const estimate = estimateCost(SMALL, 4);
    expect(estimate.low).toBeLessThan(estimate.high);
    expect(estimate.basis).toContain("band");
  });

  // The two measured calibration points must land inside the band they were
  // fitted from, or the fit is decoration.
  test("brackets the measured 45-file run", () => {
    const estimate = estimateCost(LARGE, 5);
    expect(estimate.low).toBeLessThanOrEqual(11);
    expect(estimate.high).toBeGreaterThanOrEqual(14.78);
  });

  // PR 1682's tree, run twice (2026-08-10/11): $4.74 and $3.92. The band
  // must bracket BOTH — this is the per-agent-floor evidence that retired
  // the legacy ~$2.61 point (two same-engine runs of a comparable tree both
  // landed far above it; a point the instrument contradicts is decoration).
  test("brackets both measured runs of the 1682 tree", () => {
    const estimate = estimateCost(
      { files: 7, insertions: 21, deletions: 8 },
      3,
    );
    expect(estimate.low).toBeLessThanOrEqual(3.92);
    expect(estimate.high).toBeGreaterThanOrEqual(4.74);
  });

  test("brackets the first B0 local run", () => {
    const estimate = estimateCost(
      { files: 5, insertions: 484, deletions: 0 },
      4,
    );
    expect(estimate.low).toBeLessThanOrEqual(3.68);
    expect(estimate.high).toBeGreaterThanOrEqual(3.68);
  });

  test("grows with diff size", () => {
    expect(estimateCost(LARGE, 4).high).toBeGreaterThan(
      estimateCost(SMALL, 4).high,
    );
    expect(estimateCost(LARGE, 4).low).toBeGreaterThan(
      estimateCost(SMALL, 4).low,
    );
  });

  test("grows with hunter count", () => {
    expect(estimateCost(SMALL, 5).high).toBeGreaterThan(
      estimateCost(SMALL, 3).high,
    );
  });

  test("accounts for the optional summarizer without changing legacy callers", () => {
    const without = estimateCost(SMALL, 4);
    const withSummary = estimateCost(SMALL, 4, true);
    expect(withSummary.high).toBeGreaterThan(without.high);
    expect(withSummary.low).toBeGreaterThan(without.low);
    expect(withSummary.basis).toContain("summarizer");
  });

  // §3.12 obligation 6. The scout's own seat, and the reason it needs one:
  // `agents` is the multiplier for the WHOLE band, so a scout run priced
  // without it under-quotes every single time.
  test("accounts for the optional scout without changing legacy callers", () => {
    const without = estimateCost(SMALL, 4);
    const withScout = estimateCost(SMALL, 4, false, true);
    expect(withScout.high).toBeGreaterThan(without.high);
    expect(withScout.low).toBeGreaterThan(without.low);
    expect(withScout.basis).toContain("scout");
    // The default keeps every pre-M5 caller byte-identical.
    expect(estimateCost(SMALL, 4, false)).toEqual(without);
  });

  test("the scout and the summarizer are independent terms", () => {
    const neither = estimateCost(SMALL, 4);
    const both = estimateCost(SMALL, 4, true, true);
    const summaryOnly = estimateCost(SMALL, 4, true, false);
    const scoutOnly = estimateCost(SMALL, 4, false, true);
    expect(both.high).toBeGreaterThan(summaryOnly.high);
    expect(both.high).toBeGreaterThan(scoutOnly.high);
    // Same seat size, so turning either on alone moves the band identically —
    // the honest statement of "the scout is priced as one more agent".
    expect(scoutOnly.high).toBeCloseTo(summaryOnly.high);
    expect(neither.basis).not.toContain("scout");
    expect(both.basis).toContain("summarizer");
    expect(both.basis).toContain("scout");
  });

  test("O-5a — verification-step count is its own term: 2 vs 40 moves the band", () => {
    const two = estimateCost(SMALL, 4, false, false, 2);
    const forty = estimateCost(SMALL, 4, false, false, 40);
    expect(forty.high).toBeGreaterThan(two.high);
    expect(forty.low).toBeGreaterThan(two.low);
    expect(two.basis).toContain("2 verification step");
    expect(forty.basis).toContain("40 verification step");
    expect(estimateCost(SMALL, 4)).toEqual(
      estimateCost(SMALL, 4, false, false, 0),
    );
  });

  test("a zero diff is non-negative and still a band", () => {
    const estimate = estimateCost({ files: 0, insertions: 0, deletions: 0 }, 4);
    expect(estimate.low).toBeGreaterThanOrEqual(0);
    expect(estimate.low).toBeLessThan(estimate.high);
  });

  test("negative inputs and a zero hunter count cannot produce a bad band", () => {
    const estimate = estimateCost(
      { files: -5, insertions: -10, deletions: -10 },
      0,
    );
    expect(estimate.low).toBeGreaterThanOrEqual(0);
    expect(estimate.low).toBeLessThan(estimate.high);
  });
});

describe("formatElapsed", () => {
  test("seconds only under a minute, floored never rounded", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(59_000)).toBe("59s");
    // 59.9s must not tick the minute early.
    expect(formatElapsed(59_999)).toBe("59s");
  });

  test("minutes with zero-padded seconds from 60s up", () => {
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(192_000)).toBe("3m12s");
    expect(formatElapsed(302_000)).toBe("5m02s");
  });

  test("minutes never roll into hours", () => {
    expect(formatElapsed(61 * 60_000)).toBe("61m00s");
  });

  test("negative input clamps to zero", () => {
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("renderReport exclusions", () => {
  // An exclusion MUTATES the diff the hunters read, so the report has to say
  // so: "3 files, +120 −45" beside a review that never saw the lockfile is
  // only honest if the dropped files are named.
  test("dropped files are named, with the raw diff pointed at", () => {
    const markdown = renderReport(doc({}), {
      ...META,
      excludedPaths: ["bun.lock", "dist/app.min.js"],
    });
    expect(markdown).toContain("2 files were excluded");
    expect(markdown).toContain("bun.lock, dist/app.min.js");
    expect(markdown).toContain("diff.raw.patch");
  });

  test("one dropped file reads in the singular", () => {
    expect(
      renderReport(doc({}), { ...META, excludedPaths: ["bun.lock"] }),
    ).toContain("1 file was excluded");
  });

  // No exclusions must add no noise at all — the common case stays silent.
  test("no exclusions say nothing", () => {
    expect(renderReport(doc({}), META)).not.toContain("excluded from the");
    expect(renderReport(doc({}), { ...META, excludedPaths: [] })).not.toContain(
      "excluded from the",
    );
  });
});

// S4: the report's own footer and closing note follow the gate mode. Advisory
// (and every local run, which resolves to advisory) keeps today's text
// byte-identical; gate says the report backs the required commit status.
describe("the report footers follow the gate mode (S4)", () => {
  const ADVISORY_CLOSING =
    'Generated by pr-hero 1.0.0. This is an assistant report, not a merge gate: every line above is a claim to verify, and `blocking` means "a human should look before this ships", never "the merge is blocked".';
  const GATE_CLOSING =
    "Generated by pr-hero 1.0.0. This report backs the pr-hero commit status, the required check in gate mode: every line above is a claim to verify. A blocking finding sets that status to failure. Whether it blocks the merge is up to branch protection.";
  const ADVISORY_COMMENT_FOOTER =
    "Assistant report, not a merge gate: every line above is a claim to verify.</sub>";
  const GATE_COMMENT_FOOTER =
    "Assistant report backing the pr-hero commit status, the required check in gate mode: every line above is a claim to verify.</sub>";

  test("advisory: the closing note is byte-identical to today's, and omitting the mode is advisory", () => {
    const advisory = renderReport(doc(), { ...META, ciMode: "advisory" });
    expect(advisory).toContain(`${ADVISORY_CLOSING}\n`);
    expect(renderReport(doc(), META)).toBe(advisory);
  });

  test("gate: the closing note says the report backs the required status, and never disclaims a merge gate", () => {
    const gate = renderReport(doc(), { ...META, ciMode: "gate" });
    expect(gate).toContain(`${GATE_CLOSING}\n`);
    expect(gate).not.toContain("not a merge gate");
    expect(gate).not.toContain("the merge is blocked");
  });

  test("advisory: the PR comment footer is byte-identical to today's, and omitting the mode is advisory", () => {
    const advisory = renderPrComment(
      doc(),
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      "advisory",
    );
    expect(advisory.trimEnd().endsWith(ADVISORY_COMMENT_FOOTER)).toBe(true);
    expect(renderPrComment(doc(), undefined, undefined, [], undefined)).toBe(
      advisory,
    );
  });

  test("gate: the PR comment footer says the report backs the required status", () => {
    const gate = renderPrComment(
      doc(),
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      "gate",
    );
    expect(gate.trimEnd().endsWith(GATE_COMMENT_FOOTER)).toBe(true);
    expect(gate).not.toContain("not a merge gate");
  });
});

describe("renderPrComment — compact Outside Diff entries (S1b)", () => {
  const WEB_URL = "https://github.com/musivetech/musive";
  const a = finding({
    id: "F001",
    path: "src/never-a.ts",
    line: 1,
    claim: "first long claim body",
  });
  const b = finding({
    id: "F002",
    path: "src/never-b.ts",
    line: 2,
    claim: "second long claim body",
  });
  // The claims also render in the findings list above the section, which
  // compaction never touches, so the assertions read the section alone.
  const outsideSection = (body: string) =>
    body.slice(body.indexOf("### Comments Outside Diff"));

  test("compacting from index 1 keeps entry 0 whole and reduces entry 1 to its linked location", () => {
    const body = renderPrComment(
      doc({ findings: [a, b] }),
      WEB_URL,
      undefined,
      [a, b],
      undefined,
      undefined,
      undefined,
      1,
    );
    const section = outsideSection(body);
    expect(section).toContain("### Comments Outside Diff (2)");
    expect(section).toContain("first long claim body");
    expect(section).not.toContain("second long claim body");
    expect(section).toContain(
      `[\`src/never-b.ts:2\`](${WEB_URL}/blob/${"b".repeat(40)}/src/never-b.ts#L2)`,
    );
    expect(section.split("Prompt to fix with AI").length - 1).toBe(1);
  });

  test("compacting from index 0 leaves only linked locations in the section", () => {
    const body = renderPrComment(
      doc({ findings: [a, b] }),
      WEB_URL,
      undefined,
      [a, b],
      undefined,
      undefined,
      undefined,
      0,
    );
    const section = outsideSection(body);
    expect(section).not.toContain("first long claim body");
    expect(section).not.toContain("second long claim body");
    expect(section).not.toContain("Prompt to fix with AI");
    expect(section).toContain(
      `[\`src/never-a.ts:1\`](${WEB_URL}/blob/${"b".repeat(40)}/src/never-a.ts#L1)`,
    );
  });

  test("an omitted or out-of-range compactFrom renders byte-identically to today", () => {
    const omitted = renderPrComment(
      doc({ findings: [a, b] }),
      WEB_URL,
      undefined,
      [a, b],
      undefined,
    );
    const outOfRange = renderPrComment(
      doc({ findings: [a, b] }),
      WEB_URL,
      undefined,
      [a, b],
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(outOfRange).toBe(omitted);
  });
});

describe("renderPrComment — a compact Outside Diff entry keeps its tier", () => {
  const WEB_URL = "https://github.com/musivetech/musive";
  const blocking = finding({
    id: "F001",
    path: "src/never-a.ts",
    line: 1,
    tier: "blocking",
    claim: "a long claim body",
  });

  test("the compact line opens with the tier, and the sandbox parser reads it as a blocking entry at its path", () => {
    const body = renderPrComment(
      doc({ findings: [blocking] }),
      WEB_URL,
      undefined,
      [blocking],
      undefined,
      undefined,
      undefined,
      0,
    );
    const section = body.slice(body.indexOf("### Comments Outside Diff"));
    expect(section).toContain(
      `🔴 blocking · [\`src/never-a.ts:1\`](${WEB_URL}/blob/${"b".repeat(40)}/src/never-a.ts#L1)`,
    );
    expect(outsideDiffBlockingCount(body)).toBe(1);
    expect(outsideDiffBlockingPaths(body)).toEqual(["src/never-a.ts"]);
  });
});
