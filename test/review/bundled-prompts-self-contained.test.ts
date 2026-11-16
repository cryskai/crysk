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

// The CI adjudicator's system prompt ships with the triage skill, outside
// prompts/. The pipeline renders it for a request that carries a finding, the
// author's reply and a JSON contract; the skill renders the same file for a
// sub-agent the author's agent spawns. Neither request carries the skill's
// own document, so the body can name neither it nor a caller.
const ADJUDICATOR_PROMPT = path.join(
  import.meta.dir,
  "..",
  "..",
  "skills",
  "crysk-loop",
  "adjudicator.md",
);
// "this project has made both", "this very design found": the engine's own
// history, told to a model that reviews somebody else's repository.
const OWN_HISTORY = /\bthis (?:very )?(?:project|design)\b/gi;

function modelReadFiles(): string[] {
  return [...promptFiles(PROMPTS_DIR), ADJUDICATOR_PROMPT];
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

  test("no prompt offers the engine's own history as a reason", () => {
    const offenders = modelReadFiles().flatMap((file) =>
      (readFileSync(file, "utf8").match(OWN_HISTORY) ?? []).map(
        (hit) => `${path.basename(file)}: ${hit}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  test("the adjudicator's prompt names no caller and no other document", () => {
    const body = readFileSync(ADJUDICATOR_PROMPT, "utf8");
    expect(body).not.toContain("crysk-loop");
    expect(body).not.toContain("SKILL.md");
  });

  test("the adjudicator's prompt leaves the answer's format to the request", () => {
    // The CI request ends with "exactly one JSON object and nothing else"; a
    // body that also demands prose puts two output contracts in one request.
    const body = readFileSync(ADJUDICATOR_PROMPT, "utf8");
    expect(body).toContain("in the format the request asks for");
  });

  test("the consolidator's ban on judging says what it decides about an aside", () => {
    // It is told to delete an aside that names no distinct defect, so a flat
    // "never judge whether a claim is important" contradicts its own step 2.
    const body = readFileSync(path.join(PROMPTS_DIR, "consolidate.md"), "utf8");
    expect(body).not.toContain("Never judge whether a claim is");
    expect(body).toContain("only when it does not name a distinct defect");
  });
});
