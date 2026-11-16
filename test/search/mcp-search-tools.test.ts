// odd/tasks/antigravity-oauth.md T4b (S5, L15): the search MCP is the only gate
// between an agy step and the host's files (agy's `mcp(...)` grants do not
// bind), so its confinement and caps are tested through the real server over
// stdio, against a repository full of escape attempts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SearchClient } from "./client";

let root = "";
let repo = "";
let outside = "";
let client: SearchClient;

const LONG_LINE = `NEEDLE ${"x".repeat(10_000)}`;

beforeAll(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "crysk-search-tools-")),
  );
  repo = path.join(root, "repo");
  outside = path.join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "secret.txt"), "NEEDLE outside\n");

  mkdirSync(path.join(repo, "src", "nested"), { recursive: true });
  writeFileSync(
    path.join(repo, "src", "a.ts"),
    "const NEEDLE = 1;\nconst needle = 2;\n",
  );
  writeFileSync(path.join(repo, "src", "nested", "b.ts"), "// NEEDLE b\n");
  writeFileSync(path.join(repo, "README.md"), "# NEEDLE readme\n");
  // .git, in every spelling a walk or a path could reach.
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeFileSync(path.join(repo, ".git", "config"), "NEEDLE in git\n");
  mkdirSync(path.join(repo, "sub", ".git"), { recursive: true });
  writeFileSync(path.join(repo, "sub", ".git", "HEAD"), "NEEDLE nested git\n");
  // Symlinks: out of the repo (dir and file), a loop, a broken link, and one
  // that stays inside.
  symlinkSync("/etc", path.join(repo, "link-etc"));
  symlinkSync(
    path.join(outside, "secret.txt"),
    path.join(repo, "link-secret.txt"),
  );
  symlinkSync(".", path.join(repo, "loop"));
  symlinkSync(path.join(repo, "missing"), path.join(repo, "broken"));
  symlinkSync(path.join(repo, "src", "a.ts"), path.join(repo, "link-in.ts"));
  symlinkSync(path.join(repo, ".git"), path.join(repo, "git-alias"));
  // A committed file symlink into .git: the realistic way to read git config.
  symlinkSync(path.join(repo, ".git", "config"), path.join(repo, "leak.txt"));
  // The same, to a .git file that does not exist (A3: no existence oracle).
  symlinkSync(
    path.join(repo, ".git", "nope"),
    path.join(repo, "leak-missing.txt"),
  );
  // A sibling whose name starts with the root's: `root + sep`, not a prefix.
  mkdirSync(`${repo}-evil`, { recursive: true });
  writeFileSync(path.join(`${repo}-evil`, "x.txt"), "NEEDLE sibling\n");
  // Binary, oversized, many-match and long-line files.
  writeFileSync(
    path.join(repo, "bin.dat"),
    Buffer.concat([Buffer.from("NEEDLE"), Buffer.from([0]), Buffer.from("x")]),
  );
  writeFileSync(
    path.join(repo, "big.txt"),
    `NEEDLE big\n${"y".repeat(1024 * 1024 + 10)}\n`,
  );
  mkdirSync(path.join(repo, "many"), { recursive: true });
  writeFileSync(
    path.join(repo, "many", "lines.txt"),
    Array.from({ length: 700 }, (_, i) => `MANY ${i} ${"z".repeat(600)}`).join(
      "\n",
    ),
  );
  writeFileSync(path.join(repo, "long.txt"), `${LONG_LINE}\n`);
  // A5: a line longer than the old 4096-character scan cut.
  writeFileSync(path.join(repo, "tail.txt"), `${"x".repeat(5000)}END\n`);
  // A4: lines that make a backtracking regex give up only after ~250 ms each
  // (JavaScriptCore's own per-match limit on Bun 1.4.4, macOS arm64), far
  // past the call's budget in sum on any machine; the worker dies at 10 s.
  mkdirSync(path.join(repo, "slow"), { recursive: true });
  writeFileSync(
    path.join(repo, "slow", "aaa.txt"),
    Array.from({ length: 3000 }, () => `${"a".repeat(30)}!`).join("\n"),
  );
  mkdirSync(path.join(repo, "wide"), { recursive: true });
  for (let i = 0; i < 2100; i++) {
    writeFileSync(path.join(repo, "wide", `f${i}.txt`), "");
  }
  // A FIFO would block a reader forever; it must never be opened.
  spawnSync("mkfifo", [path.join(repo, "pipe")]);

  client = new SearchClient(repo);
});

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

function noHostPaths(text: string): void {
  expect(text).not.toContain(outside);
  expect(text).not.toContain("/etc/");
  expect(text).not.toContain(root);
}

describe("grep", () => {
  test("finds matches as path:line:text across the repository", async () => {
    const text = await client.text("grep", { pattern: "NEEDLE" });
    const lines = text.split("\n");
    expect(lines).toContain("src/a.ts:1:const NEEDLE = 1;");
    expect(lines).toContain("src/nested/b.ts:1:// NEEDLE b");
    expect(lines).toContain("README.md:1:# NEEDLE readme");
    expect(text).not.toContain("needle = 2");
  });

  test("never returns .git, escaping symlinks, binary or oversized files", async () => {
    const text = await client.text("grep", { pattern: "NEEDLE" });
    expect(text).not.toContain("in git");
    expect(text).not.toContain("nested git");
    expect(text).not.toContain("outside");
    expect(text).not.toContain("bin.dat");
    expect(text).not.toContain("big.txt:");
    expect(text).not.toContain("link-etc");
    expect(text).not.toContain("loop/");
    expect(text).not.toContain("git-alias");
    expect(text).not.toContain("leak.txt");
    expect(text).not.toContain("sibling");
    noHostPaths(text);
  });

  test("ignore_case, path, glob and max_results narrow the search", async () => {
    expect(
      await client.text("grep", {
        pattern: "needle",
        path: "src/a.ts",
        ignore_case: true,
      }),
    ).toBe("src/a.ts:1:const NEEDLE = 1;\nsrc/a.ts:2:const needle = 2;");
    expect(
      await client.text("grep", { pattern: "NEEDLE", path: "src/nested" }),
    ).toBe("src/nested/b.ts:1:// NEEDLE b");
    expect(await client.text("grep", { pattern: "NEEDLE", glob: "*.md" })).toBe(
      "README.md:1:# NEEDLE readme",
    );
    const limited = await client.text("grep", {
      pattern: "MANY",
      max_results: 3,
    });
    const limitedLines = limited.split("\n");
    expect(limitedLines.slice(0, 3)).toEqual([
      expect.stringMatching(/^many\/lines\.txt:1:MANY 0 z+/),
      expect.stringMatching(/^many\/lines\.txt:2:MANY 1 z+/),
      expect.stringMatching(/^many\/lines\.txt:3:MANY 2 z+/),
    ]);
    expect(limited).toContain("[truncated");
  });

  test("an absolute path inside the repository is accepted", async () => {
    expect(
      await client.text("grep", {
        pattern: "NEEDLE",
        path: path.join(repo, "src", "nested"),
      }),
    ).toBe("src/nested/b.ts:1:// NEEDLE b");
  });

  test("no match is a plain result, not an error", async () => {
    const result = await client.call("grep", { pattern: "NO_SUCH_TEXT_42" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text.startsWith("No matches found")).toBe(true);
  });

  test("results stop at 500 matches and the response at 256 KiB, with a note", async () => {
    const text = await client.text("grep", {
      pattern: "MANY",
      max_results: 100_000,
    });
    const matches = text.split("\n").filter((line) => line.startsWith("many/"));
    expect(matches.length).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024 + 512);
    expect(text).toContain("[truncated");
  });

  test("a long line is cut in the output", async () => {
    const text = await client.text("grep", {
      pattern: "NEEDLE",
      path: "long.txt",
    });
    expect(text.startsWith("long.txt:1:NEEDLE xxx")).toBe(true);
    expect(text.length).toBeLessThan(1000);
  });

  test("an invalid or oversized regex is a tool error", async () => {
    const invalid = await client.call("grep", { pattern: "(" });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toContain("invalid regular expression");
    const huge = await client.call("grep", { pattern: "a".repeat(1001) });
    expect(huge.isError).toBe(true);
  });

  test("a FIFO is never opened", async () => {
    const result = await client.call("grep", { pattern: "x", path: "pipe" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not a regular file");
  });
});

describe("escape attempts are refused", () => {
  const attempts: [string, string][] = [
    ["a parent path", "../outside"],
    ["a parent path through src", "src/../../outside/secret.txt"],
    ["an absolute path outside", "/etc"],
    ["an absolute file outside", "/etc/hosts"],
    ["a symlink to /etc", "link-etc"],
    ["a path through a symlink to /etc", "link-etc/hosts"],
    ["a symlink to a file outside", "link-secret.txt"],
    [".git", ".git"],
    [".git/config", ".git/config"],
    ["a nested .git", "sub/.git"],
    ["a .git reached through src/..", "src/../.git"],
    ["a symlink to .git", "git-alias"],
    ["a file symlink into .git", "leak.txt"],
    ["a file symlink to a missing .git file", "leak-missing.txt"],
    ["a sibling sharing the root's prefix", "../repo-evil"],
    ["a file in that sibling", "../repo-evil/x.txt"],
    ["a broken symlink", "broken"],
  ];
  for (const [label, target] of attempts) {
    test(`${label} (${target})`, async () => {
      for (const [tool, args] of [
        ["grep", { pattern: "NEEDLE", path: target }],
        ["glob", { pattern: "**/*", path: target }],
        ["list", { path: target }],
      ] as const) {
        const result = await client.call(tool, args);
        expect(result.isError).toBe(true);
        const text = result.content[0]?.text ?? "";
        expect(text).not.toContain("NEEDLE");
        noHostPaths(text);
      }
    });
  }
});

describe("refusals are no existence oracle (A3)", () => {
  async function refusal(tool: string, target: string): Promise<string> {
    const args =
      tool === "grep" ? { pattern: "NEEDLE", path: target } : { path: target };
    const result = await client.call(tool, args);
    expect(result.isError).toBe(true);
    return (result.content[0]?.text ?? "").replace(target, "<path>");
  }

  test("outside and missing read the same", async () => {
    for (const tool of ["grep", "list"]) {
      const expected = await refusal(tool, "../outside/secret.txt");
      for (const target of [
        "../outside/missing.txt",
        "../no-such-dir/x",
        "missing-inside.txt",
        "link-secret.txt",
        "broken",
        "leak.txt",
        "leak-missing.txt",
      ]) {
        expect(await refusal(tool, target)).toBe(expected);
      }
      // Absolute paths are never echoed; existing or not, the text is one.
      expect(await refusal(tool, "/etc/hosts")).toBe(
        await refusal(tool, "/no/such/file"),
      );
      expect(await refusal(tool, "/etc/hosts")).toBe(
        await refusal(tool, path.join(repo, "missing-inside.txt")),
      );
    }
  });

  test("an existing and a missing path under .git read the same", async () => {
    for (const tool of ["grep", "list"]) {
      expect(await refusal(tool, ".git/config")).toBe(
        await refusal(tool, ".git/no-such-file"),
      );
    }
  });
});

describe("long lines and slow patterns", () => {
  test("a line longer than 4096 characters is matched whole, not at a cut (A5)", async () => {
    // `x$` matched at the old cut; the line really ends in END.
    expect(await client.text("grep", { pattern: "x$", path: "tail.txt" })).toBe(
      "No matches found",
    );
    const end = await client.text("grep", {
      pattern: "END$",
      path: "tail.txt",
    });
    expect(end.startsWith("tail.txt:1:xxx")).toBe(true);
    expect(
      await client.text("grep", { pattern: "^x{5000}END$", path: "tail.txt" }),
    ).toStartWith("tail.txt:1:");
  });

  test("a catastrophic pattern stops at the call's budget and the server keeps serving (A4)", async () => {
    const started = performance.now();
    const result = await client.call(
      "grep",
      { pattern: "(a+)+$", path: "slow" },
      40_000,
    );
    const elapsed = performance.now() - started;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("pattern took too long");
    expect(elapsed).toBeLessThan(20_000);
    expect(
      await client.text("grep", { pattern: "NEEDLE", path: "src/a.ts" }),
    ).toBe("src/a.ts:1:const NEEDLE = 1;");
  }, 60_000);
});

describe("glob", () => {
  test("lists repository files matching the pattern, sorted", async () => {
    expect(await client.text("glob", { pattern: "**/*.ts" })).toBe(
      ["link-in.ts", "src/a.ts", "src/nested/b.ts"].join("\n"),
    );
    expect(await client.text("glob", { pattern: "*.ts", path: "src" })).toBe(
      "src/a.ts",
    );
  });

  test("never lists .git, escaping symlinks or a symlinked directory loop", async () => {
    const text = await client.text("glob", { pattern: "**/*" });
    for (const line of text.split("\n")) {
      expect(line.split("/").map((s) => s.toLowerCase())).not.toContain(".git");
      expect(line.startsWith("link-etc")).toBe(false);
      expect(line.startsWith("loop/")).toBe(false);
      expect(line.startsWith("git-alias")).toBe(false);
      expect(line).not.toBe("link-secret.txt");
      expect(line).not.toBe("leak.txt");
      expect(line).not.toBe("pipe");
    }
    noHostPaths(text);
  });

  test("stops at 2000 paths with a note", async () => {
    const text = await client.text("glob", { pattern: "wide/*.txt" });
    const paths = text.split("\n").filter((line) => line.startsWith("wide/"));
    expect(paths).toHaveLength(2000);
    expect(text).toContain("[truncated");
  });
});

describe("list", () => {
  test("lists one directory, directories suffixed with /", async () => {
    expect(await client.text("list", { path: "src" })).toBe(
      ["a.ts", "nested/"].join("\n"),
    );
    const top = (await client.text("list", {})).split("\n");
    expect(top).toContain("src/");
    expect(top).toContain("README.md");
    expect(top).toContain("link-in.ts");
    expect(top).not.toContain(".git/");
    expect(top).not.toContain("link-etc/");
    expect(top).not.toContain("link-etc");
    expect(top).not.toContain("link-secret.txt");
    expect(top).not.toContain("git-alias/");
    expect(top).not.toContain("broken");
    expect(top).not.toContain("leak.txt");
  });

  test("listing a file is a tool error", async () => {
    const result = await client.call("list", { path: "README.md" });
    expect(result.isError).toBe(true);
  });
});
