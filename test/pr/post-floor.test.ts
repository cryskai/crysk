// post_min_severity's one rule: which findings a PR review leaves unposted.

import { describe, expect, test } from "bun:test";
import { isBelowPostFloor } from "#pr/post-floor";
import type { Severity, Tier } from "#review/findings";

const SEVERITIES: Severity[] = ["BLOCKER", "CRITICAL", "WARNING", "SUGGESTION"];

function hidden(
  floor: "suggestion" | "warning" | "blocking" | undefined,
): string[] {
  const out: string[] = [];
  for (const tier of ["blocking", "advisory"] as Tier[]) {
    for (const severity of SEVERITIES) {
      if (isBelowPostFloor({ tier, severity }, floor)) {
        out.push(`${tier}:${severity}`);
      }
    }
  }
  return out;
}

describe("isBelowPostFloor", () => {
  test("unset and suggestion post everything", () => {
    expect(hidden(undefined)).toEqual([]);
    expect(hidden("suggestion")).toEqual([]);
  });

  test("warning hides advisory suggestions only", () => {
    expect(hidden("warning")).toEqual(["advisory:SUGGESTION"]);
  });

  test("blocking hides every advisory finding, demoted criticals included", () => {
    expect(hidden("blocking")).toEqual([
      "advisory:BLOCKER",
      "advisory:CRITICAL",
      "advisory:WARNING",
      "advisory:SUGGESTION",
    ]);
  });
});
