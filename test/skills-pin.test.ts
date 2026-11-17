import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// triage-without-skill S4: a skills scanner flags `npx -y crysk` as critical, because an unpinned npx runs
// whatever version is published next. Every npx call in a shipped skill names the package's own version, and
// the release bumps it with the rest (skills/crysk-release/SKILL.md step 4).
describe("shipped skills pin the crysk version they call through npx", () => {
  test("every npx crysk call names package.json's version", () => {
    const root = join(import.meta.dir, "..");
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      .version as string;
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".md")) files.push(full);
      }
    };
    for (const skill of ["crysk", "crysk-loop", "crysk-pr", "crysk-ci-setup"])
      walk(join(root, "skills", skill));
    const offenders: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /npx\s+(?:-y\s+|--yes\s+)?crysk(@[^\s`'")]*)?/g,
      )) {
        if (match[1] !== `@${version}`)
          offenders.push(`${file.slice(root.length + 1)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
