import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A shipped prompt may only name what the model receives in the request. A
// gotcha cited by id ("gotcha G-05") points into a file of one repository: on
// every other repository the model is told to cross-check a fact it was never
// given. The ids are the one such reference a pattern can recognise; names of
// a repository's own files cannot be listed here without shipping them again.
const PROMPTS_DIR = path.join(import.meta.dir, "..", "..", "prompts");
const GOTCHA_ID = /\bG-\d{2}\b/g;

function promptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return promptFiles(full);
    // PROVENANCE.md is the set's history, not a prompt a model reads.
    if (!entry.name.endsWith(".md") || entry.name === "PROVENANCE.md") {
      return [];
    }
    return [full];
  });
}

describe("bundled prompts are self-contained", () => {
  test("no prompt cites a gotcha by id", () => {
    const files = promptFiles(PROMPTS_DIR);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) =>
      (readFileSync(file, "utf8").match(GOTCHA_ID) ?? []).map(
        (id) => `${path.relative(PROMPTS_DIR, file)}: ${id}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
