// A local --dry-run always returns 0, so its closing lines must not claim an
// exit code the run does not have. A real skipped review exits 1; a dry run
// that would be skipped only says so.

import { describe, expect, test } from "bun:test";
import { dryRunClosingLines } from "#review/review";

describe("dryRunClosingLines", () => {
  test("a diff the size gate would skip says so, without an exit code", () => {
    const lines = dryRunClosingLines({ sizeGateOk: false, force: false });
    expect(lines).toEqual([
      "dry run: this diff would be SKIPPED by the size gate.",
      "dry run: nothing was spawned and nothing was spent.",
    ]);
    expect(lines.join("\n")).not.toContain("exit");
  });

  test("--force reviews past the gate, so there is nothing to warn about", () => {
    expect(dryRunClosingLines({ sizeGateOk: false, force: true })).toEqual([
      "dry run: nothing was spawned and nothing was spent.",
    ]);
  });

  test("a diff inside the limits gets only the closing line", () => {
    expect(dryRunClosingLines({ sizeGateOk: true, force: false })).toEqual([
      "dry run: nothing was spawned and nothing was spent.",
    ]);
  });
});
