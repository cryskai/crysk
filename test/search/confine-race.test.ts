// odd/tasks/antigravity-oauth.md T4b (L17 A1): a directory or file swapped for
// a symlink to the outside between two walk steps is never listed or read.
// The swap is deterministic: walkFiles is a generator, so the test changes the
// tree between one yielded file and the next, exactly where a concurrent
// writer would.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  openRoot,
  readConfinedFile,
  resolveInside,
  WalkBudget,
  walkFiles,
} from "../../src/search/confine";

let scratch = "";
let repo = "";
let outside = "";

beforeEach(async () => {
  scratch = await realpath(
    await mkdtemp(path.join(tmpdir(), "crysk-search-race-")),
  );
  repo = path.join(scratch, "repo");
  outside = path.join(scratch, "outside");
  mkdirSync(path.join(outside, "c"), { recursive: true });
  writeFileSync(path.join(outside, "secret.txt"), "SECRET\n");
  writeFileSync(path.join(outside, "c", "f.txt"), "SECRET deep\n");
  mkdirSync(path.join(repo, "a"), { recursive: true });
  mkdirSync(path.join(repo, "b", "c"), { recursive: true });
  writeFileSync(path.join(repo, "a", "1.txt"), "one\n");
  writeFileSync(path.join(repo, "b", "2.txt"), "two\n");
  writeFileSync(path.join(repo, "b", "c", "f.txt"), "inside\n");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function walk() {
  const root = openRoot(repo);
  return {
    root,
    files: walkFiles(
      root,
      resolveInside(root, undefined),
      new WalkBudget(1000, performance.now() + 10_000),
    ),
  };
}

test("a directory swapped for an outside symlink after the walk saw it is not listed", () => {
  const { files } = walk();
  const seen: string[] = [];
  for (const file of files) {
    seen.push(file.rel);
    if (file.rel === "a/1.txt") {
      // b was listed as a real directory; it is now a link to the outside.
      renameSync(path.join(repo, "b"), path.join(scratch, "b-old"));
      symlinkSync(outside, path.join(repo, "b"));
    }
  }
  expect(seen).toEqual(["a/1.txt"]);
});

test("a file swapped for an outside symlink before it is read is refused", () => {
  const { root, files } = walk();
  const read: string[] = [];
  for (const file of files) {
    if (file.rel === "a/1.txt") {
      rmSync(path.join(repo, "a", "1.txt"));
      symlinkSync(
        path.join(outside, "secret.txt"),
        path.join(repo, "a", "1.txt"),
      );
    }
    const bytes = readConfinedFile(root, file.abs, 1024 * 1024);
    if (bytes !== undefined && bytes !== "too-large") {
      read.push(bytes.toString("utf8"));
    }
  }
  expect(read.join("")).not.toContain("SECRET");
  expect(read).toContain("two\n");
});

test("a parent directory swapped for an outside symlink before a read is refused", () => {
  const { root, files } = walk();
  const read: string[] = [];
  for (const file of files) {
    if (file.rel === "b/c/f.txt") {
      // Same name under the link target, so only the parent changed.
      renameSync(path.join(repo, "b"), path.join(scratch, "b-old"));
      symlinkSync(outside, path.join(repo, "b"));
    }
    const bytes = readConfinedFile(root, file.abs, 1024 * 1024);
    if (bytes !== undefined && bytes !== "too-large") {
      read.push(bytes.toString("utf8"));
    }
  }
  expect(read.join("")).not.toContain("SECRET");
});
