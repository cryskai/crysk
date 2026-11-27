// S8 (odd/tasks/model-profiles.md): phase 1 changes no behavior, proven. Each
// fixture under test/fixtures/model-profiles/baseline was captured with
// model-profiles-harness.ts on 4898e1b4, before profiles existed, and every
// slice must reproduce it exactly: the same backend, model, effort, effort
// applied, rendered prompts and Claude argv for every step, and the same route
// plan fingerprints.
//
// Re-captured on 2026-11-15 after the bundled hunter bodies changed (see
// prompts/default/PROVENANCE.md): only the system prompt hashes of the edited
// hunters moved. Backend, model, effort, argv and route fingerprints are still
// those of 4898e1b4.
//
// Re-captured on 2026-11-16 after the scout stage was removed: only the scout
// step's entries and the plan's route fingerprint (a plan with one step fewer)
// moved; every other step's request and route are byte-identical.
//
// Re-captured on 2026-11-25 after lever D edited the four hunter prompts and
// the refuter's eligibility sentence: only the system prompt hashes of those
// five steps moved; the harness finding became inferential so the refuter
// step it pins still runs, and its request is byte-identical.
//
// To re-capture (only on purpose, and only on a commit whose behavior is the
// intended baseline): CRYSK_WRITE_PROFILES_BASELINE=1 bun test <this file>,
// then `./node_modules/.bin/biome format --write` over the fixture directory.
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import {
  BASELINE_CASES,
  baselinePath,
  captureBaseline,
} from "./model-profiles-harness";

const WRITE = process.env.CRYSK_WRITE_PROFILES_BASELINE === "1";

describe("model profiles: phase 1 matches the 4898e1b4 baseline", () => {
  for (const c of BASELINE_CASES) {
    test(c.name, async () => {
      const actual = await captureBaseline(c);
      if (WRITE) {
        await writeFile(
          baselinePath(c.name),
          `${JSON.stringify(actual, null, 2)}\n`,
        );
      }
      const expected = JSON.parse(await readFile(baselinePath(c.name), "utf8"));
      expect(actual).toEqual(expected);
    });
  }
});

// The same inputs with the agents marked as the bundled set, so their routing
// comes from the `claude` profile instead of their frontmatter (S3). It must
// land on the very same fixtures: the profile IS today's defaults (S2). The
// custom agents_dir case is a user set by definition and is left out.
describe("model profiles: the bundled set routed by the claude profile matches too", () => {
  for (const c of BASELINE_CASES) {
    if (c.customFrontmatter !== undefined) continue;
    test(c.name, async () => {
      const actual = await captureBaseline(c, { bundledAgents: true });
      const expected = JSON.parse(await readFile(baselinePath(c.name), "utf8"));
      expect(actual).toEqual(expected);
    });
  }
});
