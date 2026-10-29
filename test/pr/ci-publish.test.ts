// Offline behavior tests for pr/ci-publish.ts's publishCiReviewIfEligible —
// zero direct tests existed before this file (rg over test/ for the name
// returned nothing).
//
// No injection seam needed: appendStepSummary/appendCiOutputs are plain
// `fs.appendFile` against whatever path $GITHUB_STEP_SUMMARY/$GITHUB_OUTPUT
// name, so a real temp file IS the observable — no gh, no process, nothing
// to fake.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishCiReviewIfEligible } from "#pr/ci-publish";
import type { Finding } from "#review/findings";

const HEAD = "a".repeat(40);
const PR = 42;

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    category: 1,
    path: "src/app.ts",
    line: 10,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "example claim",
    proof_refs: [],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "src/app.ts::10",
    ...overrides,
  };
}

async function tmpCiFiles(): Promise<{
  summaryPath: string;
  outputPath: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-publish-"));
  return {
    summaryPath: path.join(dir, "step-summary.md"),
    outputPath: path.join(dir, "outputs.txt"),
  };
}

async function withCiEnv<T>(
  summaryPath: string | undefined,
  outputPath: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const prevSummary = process.env.GITHUB_STEP_SUMMARY;
  const prevOutput = process.env.GITHUB_OUTPUT;
  if (summaryPath === undefined) delete process.env.GITHUB_STEP_SUMMARY;
  else process.env.GITHUB_STEP_SUMMARY = summaryPath;
  if (outputPath === undefined) delete process.env.GITHUB_OUTPUT;
  else process.env.GITHUB_OUTPUT = outputPath;
  try {
    return await fn();
  } finally {
    if (prevSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = prevSummary;
    if (prevOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prevOutput;
  }
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

describe("publishCiReviewIfEligible — eligibility guard", () => {
  test.each([
    ["outside CI", false, false],
    ["a failed session, even in CI", true, true],
  ])("writes nothing when %s", async (_name, isCi, sessionFailed) => {
    const { summaryPath, outputPath } = await tmpCiFiles();
    await withCiEnv(summaryPath, outputPath, () =>
      publishCiReviewIfEligible({
        ciMode: "advisory",
        isCi,
        sessionFailed,
        prNumber: PR,
        headSha: HEAD,
        findings: [finding({ id: "F001" })],
        costUsdEst: 1.23,
        wallMs: 5000,
        model: "sonnet",
        webUrl: undefined,
        delta: undefined,
        runDir: "/runs/1",
        stepSummaryFlag: undefined,
      }),
    );
    expect(await readIfExists(summaryPath)).toBeNull();
    expect(await readIfExists(outputPath)).toBeNull();
  });
});

describe("publishCiReviewIfEligible — a real eligible run", () => {
  test("writes the reviewed step summary and the exact CI outputs", async () => {
    const { summaryPath, outputPath } = await tmpCiFiles();
    await withCiEnv(summaryPath, outputPath, () =>
      publishCiReviewIfEligible({
        ciMode: "advisory",
        isCi: true,
        sessionFailed: false,
        prNumber: PR,
        headSha: HEAD,
        findings: [
          finding({ id: "F001", tier: "blocking" }),
          finding({ id: "F002", tier: "advisory" }),
        ],
        costUsdEst: 1.23,
        wallMs: 5000,
        model: "sonnet",
        webUrl: undefined,
        delta: undefined,
        runDir: "/runs/1",
        stepSummaryFlag: undefined,
      }),
    );
    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain(`### 🔍 Crysk Review — PR #${PR}`);
    expect(summary).toContain("| Findings | 2 (1 blocking · 1 advisory) |");
    expect(summary).toContain("| Model | sonnet |");
    const outputs = await readFile(outputPath, "utf8");
    expect(outputs).toBe(
      "status=reviewed\n" +
        "findings_count=2\n" +
        "blocking_count=1\n" +
        "advisory_count=1\n" +
        "cost_usd_est=1.23\n" +
        "run_dir=/runs/1\n",
    );
  });

  test("a clean run (no findings) says so instead of an empty findings section", async () => {
    const { summaryPath, outputPath } = await tmpCiFiles();
    await withCiEnv(summaryPath, outputPath, () =>
      publishCiReviewIfEligible({
        ciMode: "advisory",
        isCi: true,
        sessionFailed: false,
        prNumber: PR,
        headSha: HEAD,
        findings: [],
        costUsdEst: 0,
        wallMs: 1000,
        model: "sonnet",
        webUrl: undefined,
        delta: undefined,
        runDir: "/runs/1",
        stepSummaryFlag: undefined,
      }),
    );
    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("✅ No findings detected.");
    const outputs = await readFile(outputPath, "utf8");
    expect(outputs).toBe(
      "status=reviewed\n" +
        "findings_count=0\n" +
        "blocking_count=0\n" +
        "advisory_count=0\n" +
        "cost_usd_est=0.00\n" +
        "run_dir=/runs/1\n",
    );
  });

  test("--no-step-summary skips the summary but still writes the outputs", async () => {
    const { summaryPath, outputPath } = await tmpCiFiles();
    await withCiEnv(summaryPath, outputPath, () =>
      publishCiReviewIfEligible({
        ciMode: "advisory",
        isCi: true,
        sessionFailed: false,
        prNumber: PR,
        headSha: HEAD,
        findings: [],
        costUsdEst: 0,
        wallMs: 1000,
        model: "sonnet",
        webUrl: undefined,
        delta: undefined,
        runDir: "/runs/1",
        stepSummaryFlag: false,
      }),
    );
    expect(await readIfExists(summaryPath)).toBeNull();
    expect(await readIfExists(outputPath)).not.toBeNull();
  });

  test("appends after whatever the step summary already holds, rather than overwriting it", async () => {
    const { summaryPath, outputPath } = await tmpCiFiles();
    await writeFile(summaryPath, "## Earlier step\n");
    await withCiEnv(summaryPath, outputPath, () =>
      publishCiReviewIfEligible({
        ciMode: "advisory",
        isCi: true,
        sessionFailed: false,
        prNumber: PR,
        headSha: HEAD,
        findings: [],
        costUsdEst: 0,
        wallMs: 1000,
        model: "sonnet",
        webUrl: undefined,
        delta: undefined,
        runDir: "/runs/1",
        stepSummaryFlag: undefined,
      }),
    );
    const summary = await readFile(summaryPath, "utf8");
    expect(summary.startsWith("## Earlier step\n")).toBe(true);
    expect(summary).toContain(`### 🔍 Crysk Review — PR #${PR}`);
  });

  test.each([
    ["GITHUB_STEP_SUMMARY unset", false, true, false, true],
    ["GITHUB_OUTPUT unset", true, false, true, false],
  ] as const)(
    "%s writes only where the env var points, without throwing",
    async (_name, summaryEnvSet, outputEnvSet, expectSummaryWritten, expectOutputWritten) => {
      const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-publish-"));
      const summaryPath = path.join(dir, "step-summary.md");
      const outputPath = path.join(dir, "outputs.txt");
      await expect(
        withCiEnv(
          summaryEnvSet ? summaryPath : undefined,
          outputEnvSet ? outputPath : undefined,
          () =>
            publishCiReviewIfEligible({
              ciMode: "advisory",
              isCi: true,
              sessionFailed: false,
              prNumber: PR,
              headSha: HEAD,
              findings: [],
              costUsdEst: 0,
              wallMs: 1000,
              model: "sonnet",
              webUrl: undefined,
              delta: undefined,
              runDir: "/runs/1",
              stepSummaryFlag: undefined,
            }),
        ),
      ).resolves.toBeUndefined();
      expect((await readIfExists(summaryPath)) !== null).toBe(
        expectSummaryWritten,
      );
      expect((await readIfExists(outputPath)) !== null).toBe(
        expectOutputWritten,
      );
    },
  );
});
