// Skills and docs link into README.md by heading anchor. A heading rename
// (`.prheroignore` → `.cryskignore`) silently breaks those links: GitHub then
// lands on the top of the page. This checks every such link against the
// README's real headings.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");

// GitHub's slug: lowercase, drop everything but letters, digits, space, `-`
// and `_`, then spaces become hyphens.
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

describe("README anchors linked from skills and docs", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const anchors = new Set(
    [...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1] ?? "")),
  );

  test("the slug rule reproduces the renamed heading's anchor", () => {
    expect(anchors.has("cryskignore--repo-defined-exclusions")).toBe(true);
  });

  test("every link to README.md#anchor in skills/ and docs/ resolves", () => {
    const broken: string[] = [];
    const files = [
      ...markdownFiles(path.join(root, "skills")),
      ...markdownFiles(path.join(root, "docs")).filter(
        (f) => !f.includes(`${path.sep}history${path.sep}`),
      ),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/README\.md#([A-Za-z0-9_-]+)/g)) {
        if (!anchors.has(m[1] ?? "")) {
          broken.push(`${path.relative(root, file)} -> #${m[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
