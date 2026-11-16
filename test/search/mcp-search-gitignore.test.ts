// odd/tasks/antigravity-oauth.md T4b (S5, L17): `grep`, `glob` and `list`
// respect `.gitignore` the way ripgrep does for Claude's Grep: the root file
// and nested ones, each scoped to its own directory, last match wins with
// negation, directory-only rules, and a path the model names explicitly is
// still searched. Tested through the real server over stdio.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SearchClient } from "./client";

let root = "";
let repo = "";
let client: SearchClient;

function put(rel: string, text = "NEEDLE\n"): void {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

beforeAll(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "crysk-search-gitignore-")),
  );
  repo = path.join(root, "repo");
  // `!.git` must never bring .git back.
  put(".gitignore", "build/\n*.log\n/dist\n!.git\ndir/*\n!dir/keep\n*.local\n");
  // `dir/*` with `!dir/keep`, an anchored rule in a nested file, and a
  // dotfile matched by `*.local`; expectations checked against
  // `git ls-files --others --exclude-standard` on the same tree.
  put("dir/keep");
  put("dir/drop");
  put(".env.local");
  put("n/.gitignore", "/x\n");
  put("n/x/i.txt");
  put("n/y.txt");
  put("x/top.txt");
  put("src/.gitignore", "!keep.log\ngen/\n");
  put("build/a.js");
  put("build/sub/b.js");
  put("x.log");
  put("src/keep.log");
  put("src/y.log");
  put("dist/d.js");
  // `/dist` is anchored to the root: a nested dist is kept.
  put("src/dist/d2.js");
  put("src/gen/g.ts");
  // `build/` is directory-only: a FILE named build is kept.
  put("other/build");
  put("src/app.ts");
  // Lines parseIgnoreFile refuses (bare `!`, a trailing backslash) are
  // skipped like git skips them; the valid line after them still applies.
  put("odd/.gitignore", "!\nbad\\\nzzz.txt\n");
  put("odd/zzz.txt");
  put("odd/ok.txt");
  // A symlinked .gitignore is not followed (git >= 2.32 does not either):
  // its target would ignore everything in this directory.
  put("../outside-ignore", "*\n");
  mkdirSync(path.join(repo, "linked"), { recursive: true });
  symlinkSync(
    path.join(root, "outside-ignore"),
    path.join(repo, "linked", ".gitignore"),
  );
  put("linked/w.txt");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeFileSync(path.join(repo, ".git", "config"), "NEEDLE in git\n");
  client = new SearchClient(repo);
});

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

function grepFiles(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .filter((line) => line.includes(":"))
        .map((line) => line.slice(0, line.indexOf(":"))),
    ),
  ].sort();
}

const KEPT = [
  "dir/keep",
  "linked/w.txt",
  "n/y.txt",
  "odd/ok.txt",
  "other/build",
  "src/app.ts",
  "src/dist/d2.js",
  "src/keep.log",
  "x/top.txt",
];

describe("ignored files are not searched", () => {
  test("grep skips ignored files and directories, root and nested rules", async () => {
    expect(grepFiles(await client.text("grep", { pattern: "NEEDLE" }))).toEqual(
      KEPT,
    );
  });

  test("glob skips them too", async () => {
    const text = await client.text("glob", { pattern: "**/*" });
    expect(
      text.split("\n").filter((line) => !line.endsWith(".gitignore")),
    ).toEqual(KEPT);
  });

  test("list leaves ignored entries out, nested rules included", async () => {
    const top = (await client.text("list", {})).split("\n");
    expect(top).not.toContain("build/");
    expect(top).not.toContain("x.log");
    expect(top).not.toContain("dist/");
    expect(top).not.toContain(".git/");
    expect(top).toContain("src/");
    expect(top).toContain("other/");
    expect(await client.text("list", { path: "src" })).toBe(
      [".gitignore", "app.ts", "dist/", "keep.log"].join("\n"),
    );
  });
});

describe("a path named explicitly is searched, like ripgrep", () => {
  test("an ignored file", async () => {
    expect(
      await client.text("grep", { pattern: "NEEDLE", path: "x.log" }),
    ).toBe("x.log:1:NEEDLE");
  });

  test("an ignored directory, with everything under it", async () => {
    expect(
      grepFiles(
        await client.text("grep", { pattern: "NEEDLE", path: "build" }),
      ),
    ).toEqual(["build/a.js", "build/sub/b.js"]);
    expect(
      await client.text("glob", { pattern: "**/*.js", path: "build" }),
    ).toBe(["build/a.js", "build/sub/b.js"].join("\n"));
    expect(await client.text("list", { path: "build" })).toBe(
      ["a.js", "sub/"].join("\n"),
    );
  });

  test("rules still apply below the named path", async () => {
    expect(
      grepFiles(await client.text("grep", { pattern: "NEEDLE", path: "src" })),
    ).toEqual(["src/app.ts", "src/dist/d2.js", "src/keep.log"]);
  });
});
