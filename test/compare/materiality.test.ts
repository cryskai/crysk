// The materiality judge's pure half: prompt, parser, anchors and exam score.

import { describe, expect, test } from "bun:test";
import type { MartianGoldenPr } from "#compare/martian-adapter";
import {
  type Anchor,
  CLAIM_CHAR_CAP,
  goldenAnchors,
  type JudgeRun,
  judgeSystemSha256,
  normalizeClaim,
  parseJudgeVerdict,
  plantedAnchors,
  renderJudgePrompt,
  scoreExam,
  stabilitySubset,
} from "#compare/materiality";

describe("normalizeClaim", () => {
  test("flattens whitespace to one paragraph", () => {
    expect(normalizeClaim("  a\n\n b\tc  ")).toBe("a b c");
  });

  test("caps long claims with an ellipsis", () => {
    const out = normalizeClaim("x".repeat(CLAIM_CHAR_CAP + 50));
    expect(out.length).toBe(CLAIM_CHAR_CAP);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("renderJudgePrompt", () => {
  test("carries the PR title and the claim, and nothing about its rating", () => {
    const prompt = renderJudgePrompt(
      "Add retry\n to sync",
      "The loop\nnever ends",
    );
    expect(prompt).toBe(
      "Pull request: Add retry to sync\n\nReview comment:\nThe loop never ends",
    );
  });
});

describe("judgeSystemSha256", () => {
  test("is a stable sha256 hex digest", () => {
    expect(judgeSystemSha256()).toMatch(/^[0-9a-f]{64}$/);
    expect(judgeSystemSha256()).toBe(judgeSystemSha256());
  });
});

describe("parseJudgeVerdict", () => {
  test("reads the JSON object out of surrounding text", () => {
    expect(
      parseJudgeVerdict('Sure.\n{"label": "immaterial", "reason": " nit "}\n'),
    ).toEqual({ label: "immaterial", reason: "nit" });
  });

  test("rejects a label outside the vocabulary", () => {
    expect(() =>
      parseJudgeVerdict('{"label": "wrong", "reason": "x"}'),
    ).toThrow("material|immaterial");
  });

  test("rejects a missing reason", () => {
    expect(() => parseJudgeVerdict('{"label": "material"}')).toThrow(
      "reason is missing",
    );
  });

  test("rejects text with no JSON", () => {
    expect(() => parseJudgeVerdict("material")).toThrow("no JSON object");
  });
});

const goldens: MartianGoldenPr[] = [
  {
    pr_title: "PR one",
    url: "https://github.com/o/r/pull/1",
    comments: [
      { comment: "crash", severity: "Critical", category: "bug" },
      { comment: "wrong total", severity: "High", category: "bug" },
      { comment: "medium thing", severity: "Medium", category: "bug" },
      { comment: "rename var", severity: "Low", category: "style" },
      { comment: "import crashes", severity: "Low", category: "bug" },
    ],
  },
];

describe("goldenAnchors", () => {
  test("High/Critical gate as material, Low style is secondary, the rest is left out", () => {
    const anchors = goldenAnchors("cal", goldens);
    expect(anchors.map((a) => [a.id, a.role, a.expected])).toEqual([
      ["cal-0-0", "gating", "material"],
      ["cal-0-1", "gating", "material"],
      ["cal-0-3", "secondary", "immaterial"],
    ]);
    expect(anchors[0]?.prTitle).toBe("PR one");
    expect(anchors[0]?.source).toBe("martian-golden");
  });
});

describe("plantedAnchors", () => {
  test("are gating immaterial anchors with a prefixed id", () => {
    expect(plantedAnchors([{ id: "p1", prTitle: "T", claim: "C" }])).toEqual([
      {
        id: "planted-p1",
        source: "planted",
        role: "gating",
        expected: "immaterial",
        prTitle: "T",
        claim: "C",
      },
    ]);
  });
});

function anchor(
  id: string,
  expected: Anchor["expected"],
  role: Anchor["role"] = "gating",
): Anchor {
  return { id, source: "planted", role, expected, prTitle: "t", claim: "c" };
}

describe("stabilitySubset", () => {
  test("takes the first n gating anchors of each label, in order", () => {
    const anchors = [
      anchor("m1", "material"),
      anchor("s1", "immaterial", "secondary"),
      anchor("i1", "immaterial"),
      anchor("m2", "material"),
      anchor("m3", "material"),
      anchor("i2", "immaterial"),
    ];
    expect(stabilitySubset(anchors, 2)).toEqual(["m1", "m2", "i1", "i2"]);
  });
});

describe("scoreExam", () => {
  const anchors = [
    anchor("m1", "material"),
    anchor("m2", "material"),
    anchor("i1", "immaterial"),
    anchor("i2", "immaterial"),
    anchor("s1", "immaterial", "secondary"),
  ];
  const run = (
    anchorId: string,
    label: JudgeRun["label"],
    replicate = 0,
  ): JudgeRun => ({ anchorId, replicate, label });

  test("passes when every bar is met", () => {
    const score = scoreExam(anchors, [
      run("m1", "material"),
      run("m2", "material"),
      run("i1", "immaterial"),
      run("i2", "immaterial"),
      run("s1", "material"),
      run("m1", "material", 1),
      run("m1", "material", 2),
    ]);
    expect(score.passed).toBe(true);
    expect(score.reasons).toEqual([]);
    expect(score.material).toEqual({ hits: 2, judged: 2, failed: 0, rate: 1 });
    expect(score.secondaryImmaterial).toEqual({
      hits: 0,
      judged: 1,
      failed: 0,
      rate: 0,
    });
    expect(score.stability).toEqual({ hits: 1, judged: 1, failed: 0, rate: 1 });
  });

  test("fails a bar and names it", () => {
    const score = scoreExam(anchors, [
      run("m1", "material"),
      run("m2", "material"),
      run("i1", "immaterial"),
      run("i2", "material"),
      run("m1", "material", 1),
    ]);
    expect(score.passed).toBe(false);
    expect(score.reasons).toEqual(["immaterial: 50.0% < 80%"]);
  });

  test("a failed spawn is a miss, and replicates beyond 0 do not weigh twice", () => {
    const score = scoreExam(anchors, [
      run("m1", null),
      run("m2", "material"),
      run("m2", "immaterial", 1),
      run("i1", "immaterial"),
      run("i2", "immaterial"),
    ]);
    expect(score.material).toEqual({
      hits: 1,
      judged: 2,
      failed: 1,
      rate: 0.5,
    });
    expect(score.stability).toEqual({ hits: 0, judged: 1, failed: 0, rate: 0 });
    expect(score.passed).toBe(false);
  });

  test("a bar with nothing judged fails", () => {
    const score = scoreExam(anchors, [run("m1", "material")]);
    expect(score.reasons).toContain("immaterial: nothing judged");
    expect(score.reasons).toContain("stability: nothing judged");
  });
});
