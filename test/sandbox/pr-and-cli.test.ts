// list and clean act only on open sandbox/ PRs, and the CLI parses its arguments
// without touching gh. --help must work offline: the entry is run as a real
// subprocess here, which proves the module graph loads with no network.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { parseCliArgs, runCli, USAGE } from "../../scripts/sandbox/cli";
import { runClean, runList } from "../../scripts/sandbox/pr";
import { SANDBOX_REPO } from "../../scripts/sandbox/rails";
import { realDeps } from "../../scripts/sandbox/real";
// Side-effect import: it type-checks the thin entry for tsc, which does not
// otherwise reach scripts/. The entry only runs under `bun scripts/sandbox.ts`
// (import.meta.main), so importing it here starts nothing.
import "../../scripts/sandbox";
import { fail, harness, ok } from "./fakes";

const OPEN = [
  {
    number: 3,
    headRefName: "sandbox/smoke-20261015T100000Z",
    url: "https://x/3",
  },
  { number: 4, headRefName: "feat/unrelated", url: "https://x/4" },
];

describe("list", () => {
  test("prints only sandbox/ PRs", async () => {
    const h = harness({
      gh: (args) => (args[1] === "list" ? ok(JSON.stringify(OPEN)) : ok()),
    });
    expect(await runList(h.deps)).toBe(0);
    expect(h.logs.some((l) => l.includes("https://x/3"))).toBe(true);
    expect(h.logs.some((l) => l.includes("https://x/4"))).toBe(false);
  });
});

describe("clean", () => {
  test("closes and deletes the branch of sandbox/ PRs only", async () => {
    const h = harness({
      gh: (args) => (args[1] === "list" ? ok(JSON.stringify(OPEN)) : ok()),
    });
    expect(await runClean(h.deps)).toBe(0);
    const closes = h.ghCalls.filter((c) => c[0] === "pr" && c[1] === "close");
    expect(closes).toEqual([
      ["pr", "close", "3", "-R", SANDBOX_REPO, "--delete-branch"],
    ]);
  });

  test("exits 1 when a close fails", async () => {
    const h = harness({
      gh: (args) =>
        args[1] === "list" ? ok(JSON.stringify(OPEN)) : fail("boom"),
    });
    expect(await runClean(h.deps)).toBe(1);
  });
});

describe("cli arguments", () => {
  test("parses each command and rejects a missing or malformed ref", () => {
    expect(parseCliArgs(["init", "--ref", "v0.2.0"])).toEqual({
      command: "init",
      ref: "v0.2.0",
    });
    expect(parseCliArgs(["smoke", "--ref", "v0.2.0", "--keep"])).toEqual({
      command: "smoke",
      ref: "v0.2.0",
      keep: true,
    });
    expect(parseCliArgs(["list"])).toEqual({ command: "list" });
    expect(parseCliArgs(["clean"])).toEqual({ command: "clean" });
    expect(parseCliArgs(["--help"])).toEqual({ command: "help" });
    expect("error" in parseCliArgs(["smoke"])).toBe(true);
    expect("error" in parseCliArgs(["init", "--ref"])).toBe(true);
    expect("error" in parseCliArgs(["frobnicate"])).toBe(true);
  });

  test("help prints the usage and touches nothing", async () => {
    const h = harness({ gh: () => fail("should not be called") });
    expect(await runCli(["--help"], h.deps)).toBe(0);
    expect(h.logs.join("\n")).toBe(USAGE);
    expect(h.ghCalls).toEqual([]);
    expect(h.gitCalls).toEqual([]);
  });

  test("a usage error exits 2 and names the problem", async () => {
    const h = harness({ gh: () => ok() });
    expect(await runCli(["smoke"], h.deps)).toBe(2);
    expect(h.logs.some((l) => l.includes("--ref"))).toBe(true);
    expect(h.ghCalls).toEqual([]);
  });

  test("bun scripts/sandbox.ts --help works offline as a real subprocess", async () => {
    const entry = path.resolve(import.meta.dir, "../../scripts/sandbox.ts");
    const proc = Bun.spawn([process.execPath, entry, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("usage: bun scripts/sandbox.ts");
  });

  test("the real wiring is built without starting a process or a request", () => {
    const deps = realDeps();
    expect(typeof deps.gh).toBe("function");
    expect(typeof deps.git).toBe("function");
    expect(typeof deps.clock.sleep).toBe("function");
    expect(typeof deps.workspace.mkdtemp).toBe("function");
    expect(typeof deps.log).toBe("function");
  });
});
