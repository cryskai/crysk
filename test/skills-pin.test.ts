import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SHIPPED_SKILLS = ["crysk", "crysk-loop", "crysk-pr", "crysk-ci-setup"];
const NPX_CRYSK_RE = /npx\s+(?:-y\s+|--yes\s+)?crysk(@[^\s`'")]*)?/g;

// triage-without-skill S4: a skills scanner flags `npx -y crysk` as critical, because an unpinned npx runs
// whatever version is published next. Every npx call across all shipped skill files (SKILL.md stubs,
// playbook.md, and references/) pins package.json's exact version (which also keeps npx on its 0.7s fast path;
// `skills load` handles auto-updating via the 1h upgrade-check TTL cache), and the release bumps them all
// together (skills/crysk-release/SKILL.md step 4).
describe("shipped skills pin the crysk version they call through npx", () => {
  test("every shipped SKILL.md stub calls npx -y crysk@<version> skills load <skill>", () => {
    const root = join(import.meta.dir, "..");
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      .version as string;
    const offenders: string[] = [];
    for (const skill of SHIPPED_SKILLS) {
      const rel = join("skills", skill, "SKILL.md");
      const content = readFileSync(join(root, rel), "utf8");
      const expected = `npx -y crysk@${version} skills load ${skill}`;
      if (!content.includes(expected)) {
        offenders.push(`${rel}: missing \`${expected}\``);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every npx crysk call in shipped skills names package.json's version", () => {
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
    for (const skill of SHIPPED_SKILLS) walk(join(root, "skills", skill));
    const offenders: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(NPX_CRYSK_RE)) {
        if (match[1] !== `@${version}`)
          offenders.push(`${file.slice(root.length + 1)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
