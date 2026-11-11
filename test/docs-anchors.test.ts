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

// The same check for the two docs other files link into most. Renaming a section
// (`## Routing` became `## Models`) broke `configuration.md#routing` in a skill
// with nothing to say so. Explicit `<a id="...">` anchors count, and fenced code
// is skipped, since a `#` comment there is not a heading. A heading that repeats
// gets GitHub's `-1`, `-2` suffix.
function docAnchors(file: string): Set<string> {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const s = slug(m[1] ?? "");
    const n = seen.get(s) ?? 0;
    out.add(n === 0 ? s : `${s}-${n}`);
    seen.set(s, n + 1);
  }
  for (const m of text.matchAll(/<a id="([^"]+)"/g)) out.add(m[1] ?? "");
  return out;
}

describe("configuration.md and github-actions.md anchors", () => {
  const docs = ["configuration.md", "github-actions.md"];
  const anchorsOf = new Map(
    docs.map((name) => [name, docAnchors(path.join(root, "docs", name))]),
  );

  test("the slug rule reproduces the secrets section's anchor", () => {
    expect(anchorsOf.get("github-actions.md")?.has("crysk_-secrets")).toBe(
      true,
    );
  });

  test("every link into them from skills/, docs/, README.md and CHANGELOG.md resolves", () => {
    const broken: string[] = [];
    const files = [
      ...markdownFiles(path.join(root, "skills")),
      ...markdownFiles(path.join(root, "docs")).filter(
        (f) => !f.includes(`${path.sep}history${path.sep}`),
      ),
      path.join(root, "README.md"),
      path.join(root, "CHANGELOG.md"),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const self = path.basename(file);
      const ownDoc =
        path.dirname(file) === path.join(root, "docs") && docs.includes(self);
      for (const m of text.matchAll(
        /(configuration|github-actions)\.md#([A-Za-z0-9_-]+)/g,
      )) {
        if (!anchorsOf.get(`${m[1]}.md`)?.has(m[2] ?? "")) {
          broken.push(`${path.relative(root, file)} -> ${m[1]}.md#${m[2]}`);
        }
      }
      if (!ownDoc) continue;
      for (const m of text.matchAll(/\]\(#([A-Za-z0-9_-]+)\)/g)) {
        if (!anchorsOf.get(self)?.has(m[1] ?? "")) {
          broken.push(`${path.relative(root, file)} -> #${m[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
