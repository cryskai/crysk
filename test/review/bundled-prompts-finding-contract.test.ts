// The five bundled hunters carry one finding contract: what a finding
// consists of, and what `severity`, `evidence_class` and `causal_disposition`
// mean. It decides which findings are verified and which can block, so it
// must say the same thing in every hunter. Until 2026-11-15 each prompt had
// its own wording, and the copies had drifted into contradicting the engine
// and each other.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DIR = path.join(import.meta.dir, "..", "..", "prompts", "default");
const HUNTERS = [
  "deep-review-logic.md",
  "deep-review-reliability.md",
  "deep-review-resilience.md",
  "deep-review-parity.md",
  "deep-review-security.md",
];

// The section's body: from its heading to the first line that is not part of
// the shared text (the next heading, or the hunter's own addendum).
async function contractOf(file: string): Promise<string> {
  const text = await readFile(path.join(DIR, file), "utf8");
  const start = text.search(/^## (?:\d+\. )?Finding contract$/m);
  if (start === -1) throw new Error(`${file} has no Finding contract section`);
  const body = text.slice(text.indexOf("\n", start) + 1);
  const end = body.indexOf("- `unknown` — you could not tell.\n");
  if (end === -1)
    throw new Error(`${file}: the contract does not end as expected`);
  return body.slice(0, end + "- `unknown` — you could not tell.\n".length);
}

describe("the bundled hunters' finding contract", () => {
  test("is the same text in all five hunters", async () => {
    const [first, ...rest] = await Promise.all(HUNTERS.map(contractOf));
    for (const other of rest) expect(other).toBe(first as string);
  });

  test("defines every value the engine's tier rule reads", async () => {
    const contract = await contractOf(HUNTERS[0] as string);
    // Each severity where the rule assigns it, not merely mentioned: the
    // closing sentence names three of them too, so a bare mention would stay
    // green with the two steps deleted.
    for (const assigned of [
      "it is `BLOCKER` whatever the",
      "- `CRITICAL` — ordinary operation reaches it",
      "- `WARNING` — it needs a condition the claim names",
      "`SUGGESTION` is for a finding with no wrong behaviour",
      "that corrupts data is `BLOCKER`, not `WARNING`",
    ]) {
      expect(contract).toContain(assigned);
    }
    for (const value of [
      "deterministic",
      "inferential",
      "insufficient",
      "introduced",
      "behavior-activated",
      "worsened",
      "pre-existing",
      "base-only",
      "unknown",
    ]) {
      expect(contract).toContain(`- \`${value}\` — `);
    }
    expect(contract).toContain("**Fact**");
    expect(contract).toContain("**Trigger**");
    expect(contract).toContain("**Consequence**");
  });

  // The first version said severity came "from the third link alone" and then
  // separated two levels by the trigger; the review caught it. The rule has
  // two steps, and nothing else in a hunter may give the claim another shape
  // or send a defect the change activated to `pre-existing`.
  test("no hunter contradicts the contract outside it", async () => {
    for (const file of HUNTERS) {
      const text = await readFile(path.join(DIR, file), "utf8");
      for (const gone of [
        "from the third link alone",
        "in one neutral sentence",
        "put that in `evidence_class`",
        "use `pre-existing` when the defect is",
        "down-weight the latter",
        "diff-introduced",
        "is the trigger link, and how much",
      ]) {
        expect(text).not.toContain(gone);
      }
    }
  });

  // The wording the contract replaced: a ladder written for a user interface,
  // a rule that made a defect "latent until triggered" a warning, and an
  // instruction the engine's own read requirement contradicts.
  test("the old wording is gone from every hunter", async () => {
    for (const file of HUNTERS) {
      const text = await readFile(path.join(DIR, file), "utf8");
      for (const gone of [
        "latent-until-triggered",
        "latent until some other",
        "stuck spinner",
        "emit the finding anyway",
        "No-Self-Filter Mandate",
      ]) {
        expect(text).not.toContain(gone);
      }
    }
  });
});
