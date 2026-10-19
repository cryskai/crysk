// Phase 1 (Pillar 3, GitHub Actions CI): the CI reporter's pure Markdown/
// workflow-command formatting plus its two documented impure file-append
// edges. Mirrors report.test.ts's style — a local `finding()` factory, no
// mocks, no network, tmpdir-backed fixtures for the append functions.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendCiOutputs,
  appendStepSummary,
  type CiOutputs,
  type CiSummaryData,
  formatCiOutputs,
  formatWorkflowCommand,
  renderStepSummary,
} from "#ci/reporter";
import type { Finding } from "#review/findings";

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
    proof_refs: [],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 0,
    hop_trail: [],
    dedupe_key: `${overrides.path ?? "src/app.ts"}::12`,
    ...overrides,
  };
}

describe("formatWorkflowCommand", () => {
  test("group emits a bare ::group::<title> with no properties", () => {
    expect(formatWorkflowCommand("group", "Running pr-hero review")).toBe(
      "::group::Running pr-hero review",
    );
  });

  test("endgroup ignores any message and emits the bare command", () => {
    expect(formatWorkflowCommand("endgroup")).toBe("::endgroup::");
  });

  test("notice with file and line renders ordered properties", () => {
    expect(
      formatWorkflowCommand("notice", "Review complete", {
        file: "src/app.ts",
        line: 42,
      }),
    ).toBe("::notice file=src/app.ts,line=42::Review complete");
  });

  test("warning with title and no location omits absent properties", () => {
    expect(
      formatWorkflowCommand("warning", "Estimated cost is high", {
        title: "Budget",
      }),
    ).toBe("::warning title=Budget::Estimated cost is high");
  });

  test("error with no options and no message emits a bare command prefix", () => {
    expect(formatWorkflowCommand("error")).toBe("::error::");
  });

  test("error with a full property set orders file,line,endLine,col,endColumn,title", () => {
    expect(
      formatWorkflowCommand("error", "Authentication failed", {
        file: "src/pr.ts",
        line: 10,
        endLine: 12,
        col: 3,
        endColumn: 8,
        title: "Auth",
      }),
    ).toBe(
      "::error file=src/pr.ts,line=10,endLine=12,col=3,endColumn=8," +
        "title=Auth::Authentication failed",
    );
  });

  test("escapes %, CR and LF in the message body", () => {
    expect(formatWorkflowCommand("notice", "100%\r\ndone")).toBe(
      "::notice::100%25%0D%0Adone",
    );
  });

  test("escapes %, CR, LF, colon and comma in property values", () => {
    expect(
      formatWorkflowCommand("warning", "msg", {
        title: "a:b,c\r\n%",
      }),
    ).toBe("::warning title=a%3Ab%2Cc%0D%0A%25::msg");
  });

  test("group title is escaped the same as a notice message", () => {
    expect(formatWorkflowCommand("group", "100% done\nnext")).toBe(
      "::group::100%25 done%0Anext",
    );
  });
});

const HEAD_SHA = "b".repeat(40);

describe("renderStepSummary — completed review with findings", () => {
  const data: CiSummaryData = {
    kind: "reviewed",
    prNumber: 123,
    headSha: HEAD_SHA,
    findings: [
      finding({
        id: "F001",
        path: "src/app.ts",
        line: 42,
        severity: "BLOCKER",
        tier: "blocking",
        claim: "resource leak on early return",
      }),
      finding({
        id: "F002",
        path: "src/other.ts",
        line: 10,
        severity: "WARNING",
        tier: "advisory",
        claim: "unused import left behind",
      }),
    ],
    costUsdEst: 12.9,
    wallMs: 754_000,
    model: "haiku+sonnet",
    repoWebUrl: "https://github.com/juanmaagd/pr-hero",
    delta: { resolved: 1, new: 2, persist: 0, previousHeadSha: "a".repeat(40) },
  };
  const out = renderStepSummary(data);

  test("renders the review status header with the PR number", () => {
    expect(out).toContain("### 🔍 pr-hero Review — PR #123");
  });

  test("renders the metrics table with findings/cost/duration/model chips", () => {
    expect(out).toContain("| Findings | 2 (1 blocking · 1 advisory) |");
    expect(out).toContain("| Estimated cost | $12.90 |");
    expect(out).toContain("| Duration | 12m34s |");
    expect(out).toContain("| Model | haiku+sonnet |");
  });

  test("groups findings by file with a Markdown link to the blob", () => {
    expect(out).toContain("**`src/app.ts`**");
    expect(out).toContain("**`src/other.ts`**");
    expect(out).toContain(
      "[`src/app.ts:42`](https://github.com/juanmaagd/pr-hero/blob/" +
        `${HEAD_SHA}/src/app.ts#L42)`,
    );
  });

  test("includes the severity emoji and claim text per finding", () => {
    expect(out).toContain("resource leak on early return");
    expect(out).toContain("unused import left behind");
    expect(out).toContain("🔴");
    expect(out).toContain("🟡");
  });

  test("renders the re-review delta line since the previous head", () => {
    expect(out).toContain(
      `Δ since \`${"a".repeat(8)}\`: 1 resolved · 2 new · 0 persist`,
    );
  });

  test("renders the assistant-posture footer", () => {
    expect(out).toContain("Assistant report, not a merge gate");
  });

  test("ends with exactly one trailing newline", () => {
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});

describe("renderStepSummary — clean review (no findings)", () => {
  const data: CiSummaryData = {
    kind: "reviewed",
    prNumber: 7,
    headSha: HEAD_SHA,
    findings: [],
    costUsdEst: 3.68,
    wallMs: 45_000,
    model: "haiku+sonnet",
  };
  const out = renderStepSummary(data);

  test("renders zero counts in the metrics table", () => {
    expect(out).toContain("| Findings | 0 (0 blocking · 0 advisory) |");
  });

  test("renders the clean-bill notice instead of a findings section", () => {
    expect(out).toContain("✅ No findings detected.");
    expect(out).not.toContain("#### Findings");
  });

  test("still renders the assistant-posture footer", () => {
    expect(out).toContain("Assistant report, not a merge gate");
  });
});

// The footer must not contradict the gate: in gate mode the report backs the
// commit status that is the required check. Advisory, and any caller that does
// not pass a mode (every caller today), keeps the footer byte-identical.
describe("renderStepSummary — the footer follows the gate mode (S4)", () => {
  const data: CiSummaryData = {
    kind: "reviewed",
    prNumber: 7,
    headSha: HEAD_SHA,
    findings: [],
    costUsdEst: 3.68,
    wallMs: 45_000,
    model: "haiku+sonnet",
  };
  const ADVISORY_FOOTER =
    "<sub>pr-hero — AI code review assistant. Assistant report, not a merge gate.</sub>";
  const GATE_FOOTER =
    "<sub>pr-hero — AI code review assistant. Assistant report backing the pr-hero commit status, the required check in gate mode.</sub>";

  test("advisory: the footer is byte-identical to today's, and the default call is advisory", () => {
    const advisory = renderStepSummary(data, "advisory");
    expect(advisory.trimEnd().endsWith(ADVISORY_FOOTER)).toBe(true);
    expect(renderStepSummary(data)).toBe(advisory);
  });

  test("gate: the footer says the report backs the required status, and never disclaims a merge gate", () => {
    const gate = renderStepSummary(data, "gate");
    expect(gate.trimEnd().endsWith(GATE_FOOTER)).toBe(true);
    expect(gate).not.toContain("not a merge gate");
  });

  test("gate: the body is the same as advisory, only the footer moves", () => {
    const advisory = renderStepSummary(data, "advisory");
    const gate = renderStepSummary(data, "gate");
    expect(gate.replace(GATE_FOOTER, ADVISORY_FOOTER)).toBe(advisory);
  });
});

describe("renderStepSummary — skipped, size gate limit exceeded", () => {
  const data: CiSummaryData = {
    kind: "skipped-size",
    prNumber: 55,
    changedLines: 1200,
    changedFiles: 60,
    maxChangedLines: 1000,
    maxChangedFiles: 50,
  };
  const out = renderStepSummary(data);

  test("renders the skipped-review header with the PR number", () => {
    expect(out).toContain("### ⚠️ pr-hero Review Skipped — PR #55");
  });

  test("states the size gate reason", () => {
    expect(out).toContain("the diff exceeds the configured size gate limits");
  });

  test("reports changed lines and files against their configured limits", () => {
    expect(out).toContain("| Changed lines | 1200 (limit 1000) |");
    expect(out).toContain("| Changed files | 60 (limit 50) |");
  });

  test("does not mention budget, keeping the two skip reasons distinct", () => {
    expect(out).not.toContain("budget");
  });
});

describe("renderStepSummary — skipped, budget ceiling exceeded", () => {
  const data: CiSummaryData = {
    kind: "skipped-budget",
    prNumber: 56,
    estimatedCostUsd: 12.5,
    budgetUsd: 10,
  };
  const out = renderStepSummary(data);

  test("renders the skipped-review header with the PR number", () => {
    expect(out).toContain("### ⚠️ pr-hero Review Skipped — PR #56");
  });

  test("states the budget gate reason", () => {
    expect(out).toContain(
      "the estimated cost exceeds the configured budget ceiling",
    );
  });

  test("reports estimated cost against the configured budget", () => {
    expect(out).toContain("| Estimated cost | $12.50 (budget $10.00) |");
  });

  test("does not mention the size gate, keeping the two skip reasons distinct", () => {
    expect(out).not.toContain("Changed lines");
    expect(out).not.toContain("Changed files");
  });
});

describe("formatCiOutputs", () => {
  test("formats every key-value pair on its own line, cost fixed to 2 decimals", () => {
    const outputs: CiOutputs = {
      status: "reviewed",
      findings_count: 2,
      blocking_count: 1,
      advisory_count: 1,
      cost_usd_est: 12.9,
      run_dir: ".pr-hero/runs/2026-08-24T12-00-00Z",
    };
    expect(formatCiOutputs(outputs)).toBe(
      `${[
        "status=reviewed",
        "findings_count=2",
        "blocking_count=1",
        "advisory_count=1",
        "cost_usd_est=12.90",
        "run_dir=.pr-hero/runs/2026-08-24T12-00-00Z",
      ].join("\n")}\n`,
    );
  });

  test("triangulates with a skipped status and zero counts", () => {
    const outputs: CiOutputs = {
      status: "skipped-budget",
      findings_count: 0,
      blocking_count: 0,
      advisory_count: 0,
      cost_usd_est: 0,
      run_dir: "",
    };
    expect(formatCiOutputs(outputs)).toBe(
      `${[
        "status=skipped-budget",
        "findings_count=0",
        "blocking_count=0",
        "advisory_count=0",
        "cost_usd_est=0.00",
        "run_dir=",
      ].join("\n")}\n`,
    );
  });
});

describe("appendStepSummary (impure edge)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("appends Markdown to the file referenced by $GITHUB_STEP_SUMMARY", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-summary-"));
    const summaryFile = path.join(dir, "step-summary.md");
    await Bun.write(summaryFile, "# existing content\n");

    await appendStepSummary(summaryFile, "## pr-hero appended section");

    const content = await readFile(summaryFile, "utf8");
    expect(content).toBe("# existing content\n## pr-hero appended section\n");
  });

  test("adds exactly one trailing newline when the markdown omits it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-summary-"));
    const summaryFile = path.join(dir, "step-summary.md");
    await Bun.write(summaryFile, "");

    await appendStepSummary(summaryFile, "no trailing newline here");

    const content = await readFile(summaryFile, "utf8");
    expect(content).toBe("no trailing newline here\n");
  });
});

describe("appendCiOutputs (impure edge)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("appends formatCiOutputs' exact bytes to the file referenced by $GITHUB_OUTPUT", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-outputs-"));
    const outputFile = path.join(dir, "github-output.txt");
    await Bun.write(outputFile, "");
    const outputs: CiOutputs = {
      status: "reviewed",
      findings_count: 1,
      blocking_count: 1,
      advisory_count: 0,
      cost_usd_est: 4.5,
      run_dir: ".pr-hero/runs/latest",
    };

    await appendCiOutputs(outputFile, outputs);

    const content = await readFile(outputFile, "utf8");
    expect(content).toBe(formatCiOutputs(outputs));
  });

  test("a second call appends rather than overwriting the first", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-outputs-"));
    const outputFile = path.join(dir, "github-output.txt");
    await Bun.write(outputFile, "");
    const first: CiOutputs = {
      status: "reviewed",
      findings_count: 0,
      blocking_count: 0,
      advisory_count: 0,
      cost_usd_est: 0,
      run_dir: "run-1",
    };
    const second: CiOutputs = {
      status: "skipped-size",
      findings_count: 0,
      blocking_count: 0,
      advisory_count: 0,
      cost_usd_est: 0,
      run_dir: "run-2",
    };

    await appendCiOutputs(outputFile, first);
    await appendCiOutputs(outputFile, second);

    const content = await readFile(outputFile, "utf8");
    expect(content).toBe(formatCiOutputs(first) + formatCiOutputs(second));
  });
});
