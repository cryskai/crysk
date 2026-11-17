// S7 of odd/tasks/platform-owned-cost.md: the dollar ceiling left the engine,
// and nothing a user already has stops working. Each surface that used to set
// it (the `--budget-usd` flag, the `budget-usd` action input, and `--billing`,
// which only chose whether setup wrote one) is still accepted, has no effect,
// and warns exactly once. The `cost-usd-est` action output stays declared and
// is always empty, so a workflow that reads it does not break.
//
// The engine has no budget config key to retire: the dollar ceiling was only
// ever the flag and the action input.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HELP_TEXT, parseArgs } from "#review/preflight";
import { main } from "../src/cli";

const BUDGET_TAIL =
  "is ignored: dollar limits moved to the Crysk platform (Review > Limits in the dashboard)";
const BILLING_TAIL =
  "is ignored: dollar limits moved to the Crysk platform, so setup no longer asks how the review is paid";

describe("the flags", () => {
  let dir: string;
  let notARepo: string;
  let savedWrite: typeof process.stderr.write;
  let savedOutput: string | undefined;
  let written: string[];

  beforeEach(() => {
    // `main()` writes `status=error` to $GITHUB_OUTPUT on a fatal exit when it
    // is set (a CI job step); this file must leave a CI runner's file alone.
    savedOutput = process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_OUTPUT;
    dir = mkdtempSync(path.join(tmpdir(), "retired-flags-"));
    notARepo = path.join(dir, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    written = [];
    savedWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = savedWrite;
    if (savedOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = savedOutput;
    rmSync(dir, { recursive: true, force: true });
  });

  // `--repo` points at a directory git does not know, so the run stops at its
  // first statement with a CliError (exit 1) and spends nothing. A usage error
  // would be exit 2 and means the parser refused the flag.
  async function run(
    ...flags: string[]
  ): Promise<{ code: number; warnings: string[] }> {
    const code = await main(["review", ...flags, "--repo", notARepo]);
    const warnings = written
      .join("")
      .split("\n")
      .filter((line) => /budget|billing/i.test(line));
    return { code, warnings };
  }

  test.each([
    ["a float", "7.5"],
    ["zero", "0"],
    ["a negative number", "-1"],
    ["a non-number", "lots"],
  ])("--budget-usd with %s is accepted and warns once", async (_, value) => {
    const { code, warnings } = await run(
      "--pr",
      "5",
      "--ci",
      "--budget-usd",
      value,
    );
    expect(code).toBe(1);
    expect(warnings).toEqual([`warning: --budget-usd ${BUDGET_TAIL}`]);
  });

  test("--budget-usd is accepted without --ci, which used to be a usage error", async () => {
    const { code, warnings } = await run("--budget-usd", "5");
    expect(code).toBe(1);
    expect(warnings).toEqual([`warning: --budget-usd ${BUDGET_TAIL}`]);
  });

  test("--billing is accepted and warns once, whatever its value", async () => {
    const { code, warnings } = await run("--billing", "api", "--billing", "x");
    expect(code).toBe(1);
    expect(warnings).toEqual([`warning: --billing ${BILLING_TAIL}`]);
  });

  test("each ignored flag warns once however often it is repeated", async () => {
    const { code, warnings } = await run(
      "--budget-usd",
      "5",
      "--billing",
      "api",
      "--budget-usd",
      "6",
    );
    expect(code).toBe(1);
    expect(warnings).toEqual([
      `warning: --budget-usd ${BUDGET_TAIL}`,
      `warning: --billing ${BILLING_TAIL}`,
    ]);
  });

  test("a run without the flags prints no budget warning", async () => {
    const { code, warnings } = await run();
    expect(code).toBe(1);
    expect(warnings).toEqual([]);
  });

  test("the parsed options carry no budget setting", () => {
    const { options } = parseArgs(["review", "--budget-usd", "5"]);
    expect("budgetUsd" in options).toBe(false);
  });

  test("the help text no longer advertises the flags", () => {
    expect(HELP_TEXT).not.toContain("--budget-usd");
    expect(HELP_TEXT).not.toContain("--billing");
  });
});

describe("action.yml", () => {
  const actionPath = path.join(import.meta.dir, "..", "action.yml");
  const source = readFileSync(actionPath, "utf8");
  const action = Bun.YAML.parse(source) as {
    inputs: Record<string, { description: string; default?: string }>;
    outputs: Record<string, { description: string; value: string }>;
    runs: { steps: Array<{ env?: Record<string, string>; run?: string }> };
  };

  test("keeps the budget-usd input declared, described as retired and ignored", () => {
    const input = action.inputs["budget-usd"];
    expect(input).toBeDefined();
    expect(input?.description).toMatch(/retired/i);
    expect(input?.description).toMatch(/ignored/i);
    expect(input?.description).toContain("Review > Limits");
  });

  test("never passes --budget-usd to the CLI", () => {
    expect(source).not.toContain("--budget-usd");
  });

  test("warns once when the input is set, and not otherwise", () => {
    const step = action.runs.steps.find(
      (s) => s.env?.BUDGET_USD_INPUT !== undefined,
    );
    expect(step?.run).toBeDefined();
    const lines = (step?.run ?? "")
      .split("\n")
      .filter((line) => line.includes("BUDGET_USD_INPUT"));
    expect(lines).toHaveLength(1);
    const snippet = lines[0] as string;
    const runWith = (value: string) =>
      spawnSync("bash", ["-c", snippet], {
        env: { PATH: process.env.PATH ?? "", BUDGET_USD_INPUT: value },
        encoding: "utf8",
      });
    for (const value of ["12", "0", "-1", "lots"]) {
      const result = runWith(value);
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        `::warning::the budget-usd input ${BUDGET_TAIL}`,
      ]);
    }
    expect(runWith("").stdout).toBe("");
  });

  test("keeps the cost-usd-est output declared, documented as retired, and always empty", () => {
    const output = action.outputs["cost-usd-est"];
    expect(output).toBeDefined();
    expect(output?.description).toMatch(/retired/i);
    expect(output?.description).toMatch(/empty/i);
    // A literal empty value, not a reference to a step output nobody writes.
    expect(output?.value).toBe("");
  });

  test("no longer hands the retired estimate or usage-facts values to any step", () => {
    expect(source).not.toContain("CRYSK_PLATFORM_ESTIMATE");
    expect(source).not.toContain("CRYSK_PLATFORM_USAGE_FACTS");
    expect(source).not.toContain("steps.platform.outputs.estimate");
    expect(source).not.toContain("steps.platform.outputs.usage-facts");
  });

  test("hands the connect step's limits to the run step as CRYSK_PLATFORM_LIMITS", () => {
    const runStep = action.runs.steps.find(
      (s) => s.env?.CRYSK_PLATFORM_LIMITS !== undefined,
    );
    expect(runStep?.env?.CRYSK_PLATFORM_LIMITS).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template literal
      "${{ steps.platform.outputs.limits }}",
    );
  });
});
