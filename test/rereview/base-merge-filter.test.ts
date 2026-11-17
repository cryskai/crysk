import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changeSitesByPath,
  keepPrOwnedHunks,
} from "#rereview/base-merge-filter";

const HUNK_A = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,4 @@",
  " a",
  "-b",
  "+B",
  " c",
  " d",
  "",
].join("\n");

// Two hunks far apart: right starts 3 and 40, each with three context lines.
function twoHunkRecord(file: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    "index 111..222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,6 +3,6 @@",
    " x1",
    " x2",
    "-x3",
    "+X3",
    " x4",
    " x5",
    "@@ -37,6 +40,6 @@",
    " y1",
    " y2",
    "-y3",
    "+Y3",
    " y4",
    " y5",
    "",
  ].join("\n");
}

const PR_TOUCHES_LINE_5 = [
  "diff --git a/f.ts b/f.ts",
  "index 111..222 100644",
  "--- a/f.ts",
  "+++ b/f.ts",
  "@@ -4,3 +4,3 @@",
  " p4",
  "-p5",
  "+P5",
  " p6",
  "",
].join("\n");

describe("changeSitesByPath", () => {
  test("returns added lines and removal sites on the head side", () => {
    const sites = changeSitesByPath(HUNK_A);
    expect(sites.get("src/a.ts")).toEqual(new Set([2]));
  });
});

describe("keepPrOwnedHunks", () => {
  test("keeps a hunk whose range contains a PR site and drops one that contains none", () => {
    const delta = twoHunkRecord("f.ts");
    const result = keepPrOwnedHunks(delta, PR_TOUCHES_LINE_5);
    expect(result.droppedHunks).toBe(1);
    expect(result.patch).toContain("+X3");
    expect(result.patch).not.toContain("+Y3");
    expect(result.patch).toContain("@@ -1,6 +3,6 @@");
    expect(result.patch).not.toContain("@@ -37,6 +40,6 @@");
  });

  test("returns the input byte for byte when every hunk is kept", () => {
    const delta = twoHunkRecord("f.ts");
    const prTouchesBoth = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -4,3 +4,3 @@",
      " p4",
      "-p5",
      "+P5",
      " p6",
      "@@ -42,3 +42,3 @@",
      " q4",
      "-q5",
      "+Q5",
      " q6",
      "",
    ].join("\n");
    const result = keepPrOwnedHunks(delta, prTouchesBoth);
    expect(result.droppedHunks).toBe(0);
    expect(result.patch).toBe(delta);
  });

  test("removes a record whose hunks are all dropped and keeps the other record", () => {
    const dropped = twoHunkRecord("gone.ts");
    const survivor = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -4,3 +4,3 @@",
      " p4",
      "-p5",
      "+P5",
      " p6",
      "",
    ].join("\n");
    const delta = `${dropped}${survivor}`;
    // The PR must know gone.ts (else it passes through), but changes it far
    // from both hunks, so every gone.ts hunk is dropped.
    const prGone = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ b/gone.ts",
      "@@ -100,3 +100,3 @@",
      " g99",
      "-g100",
      "+G100",
      " g101",
      "",
    ].join("\n");
    const result = keepPrOwnedHunks(delta, `${PR_TOUCHES_LINE_5}${prGone}`);
    expect(result.patch).not.toContain("gone.ts");
    expect(result.patch).not.toContain("diff --git a/gone.ts");
    expect(result.patch).toContain("diff --git a/f.ts b/f.ts");
    expect(result.droppedHunks).toBe(2);
  });

  test("passes a record without hunks through unchanged", () => {
    const binary = [
      "diff --git a/img.png b/img.png",
      "index 111..222 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    const result = keepPrOwnedHunks(binary, PR_TOUCHES_LINE_5);
    expect(result.patch).toBe(binary);
    expect(result.droppedHunks).toBe(0);
  });

  test("passes a record whose path has no entry in the PR patch through unchanged", () => {
    const delta = twoHunkRecord("other.ts");
    const result = keepPrOwnedHunks(delta, PR_TOUCHES_LINE_5);
    expect(result.patch).toBe(delta);
    expect(result.droppedHunks).toBe(0);
  });

  test("keeps a pure-removal hunk only when the PR has a removal site inside its range", () => {
    const delta = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -10,7 +10,6 @@",
      " r1",
      " r2",
      "-r3",
      " r4",
      " r5",
      " r6",
      " r7",
      "",
    ].join("\n");
    const prWithRemovalInRange = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -12,2 +11,1 @@",
      " s1",
      "-s2",
      " s3",
      "",
    ].join("\n");
    const prWithoutRemovalInRange = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -50,2 +50,2 @@",
      " t1",
      "-t2",
      "+T2",
      "",
    ].join("\n");

    const kept = keepPrOwnedHunks(delta, prWithRemovalInRange);
    expect(kept.patch).toBe(delta);
    expect(kept.droppedHunks).toBe(0);

    const dropped = keepPrOwnedHunks(delta, prWithoutRemovalInRange);
    expect(dropped.patch).toBe("");
    expect(dropped.droppedHunks).toBe(1);
  });
});

describe("keepPrOwnedHunks against real git", () => {
  test("drops a base-branch hunk merged into the PR branch and keeps the PR's own change", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "base-merge-"));
    try {
      const git = (...args: string[]): string => {
        const proc = Bun.spawnSync(
          [
            "git",
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: dir },
        );
        if (proc.exitCode !== 0) {
          throw new Error(
            `git ${args.join(" ")} failed: ${proc.stderr.toString()}`,
          );
        }
        return proc.stdout.toString();
      };
      const commitAll = (message: string): void => {
        git("add", "f.txt");
        git("commit", "-m", message);
      };
      const file = path.join(dir, "f.txt");
      const replaceLine = (lineNo: number, text: string): void => {
        const lines = readFileSync(file, "utf8").split("\n");
        lines[lineNo - 1] = text;
        writeFileSync(file, lines.join("\n"));
      };

      git("init", "-b", "main");
      const initial = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
      writeFileSync(file, `${initial.join("\n")}\n`);
      commitAll("initial");

      git("checkout", "-b", "feature");
      replaceLine(5, "feature 5");
      commitAll("feature change");
      const L = git("rev-parse", "HEAD").trim();

      git("checkout", "main");
      replaceLine(50, "main 50");
      commitAll("main change");

      git("checkout", "feature");
      git("merge", "main", "--no-edit");
      replaceLine(20, "feature 20");
      commitAll("feature change 20");
      const H = git("rev-parse", "HEAD").trim();

      const B = git("merge-base", "main", H).trim();
      const delta = git("diff", `${L}..${H}`, "--", "f.txt");
      const pr = git("diff", `${B}..${H}`, "--", "f.txt");

      expect(delta).toContain("+main 50");

      const result = keepPrOwnedHunks(delta, pr);
      expect(result.patch).toContain("+feature 20");
      expect(result.patch).not.toContain("main 50");
      expect(result.droppedHunks).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
