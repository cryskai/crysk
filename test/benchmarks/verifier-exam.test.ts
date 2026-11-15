// The verifier exam's grading and case validation (benchmarks/verifier-exam).
// The costly error of the stage is closing a finding whose defect is still
// there, so the grader must never call that a pass or an "unsure".

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  caseProblems,
  gradeVerdict,
  unmatchedCases,
} from "../../benchmarks/verifier-exam/exam";

describe("gradeVerdict", () => {
  test("a defect that is gone passes only on refuted", () => {
    expect(gradeVerdict("gone", "refuted")).toBe("pass");
    expect(gradeVerdict("gone", "corroborated")).toBe("kept-open");
    expect(gradeVerdict("gone", "inconclusive")).toBe("kept-open");
  });

  test("a defect that is present: refuted is the costly error, never softened", () => {
    expect(gradeVerdict("present", "refuted")).toBe("closed-live-defect");
    expect(gradeVerdict("present", "corroborated")).toBe("pass");
    expect(gradeVerdict("present", "downgraded-latent")).toBe("pass");
    expect(gradeVerdict("present", "inconclusive")).toBe("unsure");
  });

  test("no verdict is an infrastructure error, not an answer", () => {
    expect(gradeVerdict("present", undefined)).toBe("infra-error");
    expect(gradeVerdict("gone", undefined)).toBe("infra-error");
  });
});

describe("caseProblems", () => {
  function caseDir(): string {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "vexam-")), "c1");
    mkdirSync(path.join(dir, "head", "src"), { recursive: true });
    writeFileSync(path.join(dir, "head", "src", "a.ts"), "export {};\n");
    return dir;
  }
  const good = {
    id: "c1",
    expect: "present",
    finding: {
      claim: "a claim",
      locs: ["src/a.ts:3"],
      sev: "CRITICAL",
      triage_tag: "",
    },
  };

  test("a well-formed case has none", () => {
    const dir = caseDir();
    try {
      expect(caseProblems(good, dir)).toEqual([]);
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });

  test("a location outside head/, an empty claim and a bad answer are each named", () => {
    const dir = caseDir();
    try {
      const problems = caseProblems(
        {
          ...good,
          expect: "fixed",
          finding: { ...good.finding, claim: "", locs: ["src/gone.ts:1"] },
        },
        dir,
      );
      expect(problems.join("\n")).toContain("expect must be");
      expect(problems.join("\n")).toContain("finding.claim");
      expect(problems.join("\n")).toContain("src/gone.ts");
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });

  // JSON can spell a missing object as null. A null or non-object `finding`
  // must be named as a problem; throwing would abort the check of every case
  // after it.
  test("a null or non-object finding is a named problem, not a crash", () => {
    const dir = caseDir();
    try {
      for (const finding of [null, "text", 7]) {
        const problems = caseProblems({ ...good, finding }, dir);
        expect(problems.join("\n")).toContain("finding.claim");
        expect(problems.join("\n")).toContain("finding.locs");
        expect(problems.join("\n")).toContain("finding.triage_tag");
      }
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });
});

describe("unmatchedCases", () => {
  test("names every requested id no case answers to, also among ids that match", () => {
    expect(unmatchedCases(["a", "typo"], ["a", "b"])).toEqual(["typo"]);
    expect(unmatchedCases(["typo"], [])).toEqual(["typo"]);
  });

  test("is empty when every requested id matched, or none was requested", () => {
    expect(unmatchedCases(["a", "b"], ["a", "b", "c"])).toEqual([]);
    expect(unmatchedCases([], ["a"])).toEqual([]);
  });
});
