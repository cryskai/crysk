// Offline behavior tests for pr/comparison.ts's computeComparison.
//
// writeComparison (#pr/pr) is pure I/O now: it writes comparison.json and
// nothing else, so these tests can run it for real against a temp runDir.
// The `write` seam stays for the failure cases, where the writer must throw
// or report an artifact that was never written.

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrHeroFindingRef } from "#compare/compare";
import { computeComparison } from "#pr/comparison";
import { type ComparisonOutcome, writeComparison } from "#pr/pr";
import { buildComparisonJson } from "#pr/preflight";

const PR = 42;
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);

const FINDING: PrHeroFindingRef = {
  id: "F001",
  path: "src/a.ts",
  line: 7,
  claim: "The cache is never invalidated.",
  tier: "blocking",
};

async function tmpRunDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pr-hero-comparison-"));
}

describe("computeComparison — sessionFailed guard", () => {
  test("a failed session compares nothing and never calls the writer", async () => {
    let writeCalls = 0;
    const result = await computeComparison({
      sessionFailed: true,
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir: "/runs/1",
      runStatus: "complete",
      findings: [],
      write: async () => {
        writeCalls++;
        throw new Error("should never be called");
      },
    });
    expect(result).toEqual({ comparison: null, storedComparison: null });
    expect(writeCalls).toBe(0);
  });
});

describe("computeComparison — a successful comparison", () => {
  test("reads the just-written comparison.json back into storedComparison", async () => {
    const runDir = await tmpRunDir();
    const result = await computeComparison({
      sessionFailed: false,
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir,
      runStatus: "complete",
      findings: [FINDING],
    });
    expect(result.comparison).not.toBeNull();
    expect(result.comparison?.prheroOnly).toBe(1);
    expect(result.storedComparison).not.toBeNull();
    expect(result.storedComparison?.pr).toBe(PR);
    expect(result.storedComparison?.head_sha).toBe(HEAD);
    expect(result.storedComparison?.diff_from_sha).toBe(BASE);
    expect(result.storedComparison?.run_status).toBe("complete");
    expect(result.storedComparison?.greptile).toEqual({ found: false });
    expect(result.storedComparison?.rows.map((row) => row.bucket)).toEqual([
      "prhero_only",
    ]);
  });

  test("writes comparison.json and no comparison.md", async () => {
    const runDir = await tmpRunDir();
    await computeComparison({
      sessionFailed: false,
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir,
      runStatus: "complete",
      findings: [FINDING],
    });
    expect(await Bun.file(path.join(runDir, "comparison.json")).exists()).toBe(
      true,
    );
    expect(await Bun.file(path.join(runDir, "comparison.md")).exists()).toBe(
      false,
    );
  });
});

describe("writeComparison — the only artifact is comparison.json", () => {
  test("writes the record and returns the prhero_only count, touching nothing else", async () => {
    const runDir = await tmpRunDir();
    const outcome = await writeComparison({
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir,
      generatedAt: "2026-10-28T10:00:00.000Z",
      runStatus: "complete",
      findings: [FINDING],
    });
    expect(outcome).toEqual({
      prheroOnly: 1,
      jsonPath: path.join(runDir, "comparison.json"),
    });
    const written = JSON.parse(await Bun.file(outcome.jsonPath).text());
    expect(written).toEqual(
      buildComparisonJson({
        pr: PR,
        headSha: HEAD,
        diffFromSha: BASE,
        runDir,
        generatedAt: "2026-10-28T10:00:00.000Z",
        runStatus: "complete",
        findings: [FINDING],
      }),
    );
    expect(await Bun.file(path.join(runDir, "comparison.md")).exists()).toBe(
      false,
    );
  });
});

describe("computeComparison — the writer fails", () => {
  test("degrades to no comparison at all, without throwing", async () => {
    const result = await computeComparison({
      sessionFailed: false,
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir: "/runs/1",
      runStatus: "complete",
      findings: [],
      write: async () => {
        throw new Error("disk full");
      },
    });
    expect(result).toEqual({ comparison: null, storedComparison: null });
  });
});

describe("computeComparison — the read-back fails", () => {
  test("keeps the comparison outcome even when its json cannot be read back", async () => {
    const runDir = await tmpRunDir();
    // The writer reports a jsonPath that was never actually written.
    const missingPath = path.join(runDir, "never-written.json");
    const result = await computeComparison({
      sessionFailed: false,
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir,
      runStatus: "complete",
      findings: [],
      write: async (): Promise<ComparisonOutcome> => ({
        prheroOnly: 0,
        jsonPath: missingPath,
      }),
    });
    expect(result.comparison).not.toBeNull();
    expect(result.comparison?.jsonPath).toBe(missingPath);
    expect(result.storedComparison).toBeNull();
  });

  test("keeps the comparison outcome even when its json is malformed", async () => {
    const runDir = await tmpRunDir();
    const jsonPath = path.join(runDir, "comparison.json");
    await writeFile(jsonPath, "not json");
    const result = await computeComparison({
      sessionFailed: false,
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir,
      runStatus: "complete",
      findings: [],
      write: async (): Promise<ComparisonOutcome> => ({
        prheroOnly: 0,
        jsonPath,
      }),
    });
    expect(result.comparison).not.toBeNull();
    expect(result.storedComparison).toBeNull();
  });
});
