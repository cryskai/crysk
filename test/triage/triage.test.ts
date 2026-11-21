// Pure-decision tests for the triage reply marker (ROADMAP B6b). All
// offline, literal in → literal out — same discipline as
// pr/preflight.test.ts's marker suites.

import { describe, expect, test } from "bun:test";
import {
  PR_COMMENT_MARKER_PREFIX,
  PR_FINDING_MARKER_PREFIX,
} from "#pr/preflight";
import {
  parseTriageMarker,
  renderTriageReplyBody,
  TRIAGE_MARKER_PREFIX,
  triageBadge,
  triageMarker,
} from "#triage/triage";

const HEAD = "e3ab386a63020c6f5c21d814d176ff33849eef8d";

describe("marker prefix disjointness", () => {
  // Extends the pr/preflight.test.ts discipline to the third marker family:
  // none of the three may be a prefix of another, or a matcher scanning the
  // shared comment stream could misfile one as another.
  test("triage prefix is disjoint from both existing marker prefixes", () => {
    expect(TRIAGE_MARKER_PREFIX.startsWith(PR_COMMENT_MARKER_PREFIX)).toBe(
      false,
    );
    expect(PR_COMMENT_MARKER_PREFIX.startsWith(TRIAGE_MARKER_PREFIX)).toBe(
      false,
    );
    expect(TRIAGE_MARKER_PREFIX.startsWith(PR_FINDING_MARKER_PREFIX)).toBe(
      false,
    );
    expect(PR_FINDING_MARKER_PREFIX.startsWith(TRIAGE_MARKER_PREFIX)).toBe(
      false,
    );
  });
});

describe("triageMarker + parseTriageMarker", () => {
  test("round-trips tag, head, and actor for applied", () => {
    const marker = triageMarker({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
    });
    expect(marker.startsWith(TRIAGE_MARKER_PREFIX)).toBe(true);
    expect(parseTriageMarker(marker)).toEqual({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
    });
  });

  test("round-trips tag, head, and actor for dismissed", () => {
    const marker = triageMarker({
      tag: "dismissed",
      headSha: HEAD,
      actor: "agent",
      verdict: "upheld",
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "dismissed",
      headSha: HEAD,
      actor: "agent",
      verdict: "upheld",
    });
  });

  test("round-trips tag, head, and actor for misclassified", () => {
    const marker = triageMarker({
      tag: "misclassified",
      headSha: HEAD,
      actor: "human",
      verdict: "upheld",
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "misclassified",
      headSha: HEAD,
      actor: "human",
      verdict: "upheld",
    });
  });

  test("round-trips deferred with its issue number and verdict", () => {
    const marker = triageMarker({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      issue: 482,
      verdict: "upheld",
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      issue: 482,
      verdict: "upheld",
    });
  });

  // The adjudicator's full vocabulary round-trips, not just `upheld` —
  // `rejected` and `inconclusive` are the other two verdicts 6c depends on
  // to distinguish "settled against the author" from "still unsettled".
  test("round-trips rejected and inconclusive verdicts", () => {
    const rejected = triageMarker({
      tag: "dismissed",
      headSha: HEAD,
      actor: "agent",
      verdict: "rejected",
    });
    expect(parseTriageMarker(rejected)?.verdict).toBe("rejected");

    const inconclusive = triageMarker({
      tag: "misclassified",
      headSha: HEAD,
      actor: "agent",
      verdict: "inconclusive",
    });
    expect(parseTriageMarker(inconclusive)?.verdict).toBe("inconclusive");
  });

  test("round-trips deferred without an issue number", () => {
    const marker = triageMarker({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      verdict: "upheld",
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      verdict: "upheld",
    });
    expect(marker).not.toContain("issue=");
  });

  test("triageMarker throws for deferred with a non-positive issue", () => {
    expect(() =>
      triageMarker({
        tag: "deferred",
        headSha: HEAD,
        actor: "agent",
        issue: 0,
        verdict: "upheld",
      }),
    ).toThrow(/positive integer/);
  });

  // The same two-way guard, now for `verdict`: only an upheld dismissal
  // clears the gate, so a dismissed marker missing its verdict must fail to
  // BUILD. deferred and misclassified never clear it, and on an advisory
  // finding they are written without one.
  test("triageMarker throws for dismissed with no verdict; deferred and misclassified build without one", () => {
    expect(() =>
      triageMarker({ tag: "dismissed", headSha: HEAD, actor: "agent" }),
    ).toThrow(/dismissed requires a verdict/);
    expect(
      triageMarker({ tag: "deferred", headSha: HEAD, actor: "agent" }),
    ).toBe(`${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent -->`);
    expect(
      triageMarker({ tag: "misclassified", headSha: HEAD, actor: "agent" }),
    ).toBe(
      `${TRIAGE_MARKER_PREFIX}tag=misclassified head=${HEAD} actor=agent -->`,
    );
  });

  // ...and must fail to PARSE, for the same reason a missing `issue` on a
  // deferred marker must fail to parse: a hand-written or corrupted marker
  // with no `verdict=` field must never be accepted, or 6c would read an
  // un-adjudicated finding as settled.
  test("a dismissed marker with no verdict does not parse; deferred and misclassified do", () => {
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=dismissed head=${HEAD} actor=agent -->`,
      ),
    ).toBeNull();
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent issue=482 -->`,
      ),
    ).toEqual({ tag: "deferred", headSha: HEAD, actor: "agent", issue: 482 });
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=misclassified head=${HEAD} actor=agent -->`,
      ),
    ).toEqual({ tag: "misclassified", headSha: HEAD, actor: "agent" });
  });

  test("a marker with an unknown verdict word does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=dismissed head=${HEAD} actor=agent verdict=maybe -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  // Stricter than `issue` (which is merely ignored on non-deferred tags):
  // `applied` never spawns an adjudicator, so a verdict on an `applied`
  // marker is a false claim, not harmless noise. The builder refuses to
  // emit one...
  test("triageMarker throws for applied with a verdict", () => {
    expect(() =>
      triageMarker({
        tag: "applied",
        headSha: HEAD,
        actor: "agent",
        verdict: "upheld",
      }),
    ).toThrow(/applied must not carry a verdict/);
  });

  // ...and the parser rejects one it finds, rather than silently ignore it.
  test("an applied marker with a verdict field does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=applied head=${HEAD} actor=agent verdict=upheld -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("a deferred marker with no issue field parses as reasoning-only", () => {
    const marker = `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent verdict=upheld -->`;
    expect(parseTriageMarker(marker)).toEqual({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      verdict: "upheld",
    });
  });

  test("a deferred marker with a non-numeric issue does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent verdict=upheld issue=NaN -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("a deferred marker with a zero or negative issue does not parse", () => {
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent verdict=upheld issue=0 -->`,
      ),
    ).toBeNull();
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent verdict=upheld issue=-3 -->`,
      ),
    ).toBeNull();
  });

  test("an unknown tag does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=wontfix head=${HEAD} actor=agent -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("an unknown actor does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=applied head=${HEAD} actor=robot -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("a non-40-hex head does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=applied head=abc123 actor=agent -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("missing a required field does not parse", () => {
    expect(
      parseTriageMarker(`${TRIAGE_MARKER_PREFIX}tag=applied head=${HEAD} -->`),
    ).toBeNull();
    expect(
      parseTriageMarker(`${TRIAGE_MARKER_PREFIX}head=${HEAD} actor=agent -->`),
    ).toBeNull();
  });

  test("a body with no marker prefix returns null", () => {
    expect(parseTriageMarker("just a reply, no marker")).toBeNull();
  });

  test("a body missing the closing --> returns null", () => {
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=applied head=${HEAD} actor=agent`,
      ),
    ).toBeNull();
  });

  // Only a body that STARTS with the marker is ours: a triage marker quoted
  // mid-reply (someone pasting a prior triage into a new comment) must
  // never be treated as a fresh one.
  test("a marker quoted mid-body is not a match", () => {
    const marker = triageMarker({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
    });
    expect(parseTriageMarker(`see above:\n${marker}`)).toBeNull();
    expect(parseTriageMarker(` ${marker} leading space`)).toBeNull();
  });

  // A finding GitHub could not anchor has no thread, only a summary row, so
  // its reply names the row instead; the token is written last.
  test("a row token round-trips, written last", () => {
    const marker = triageMarker({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
      row: "R003",
    });
    expect(marker.endsWith(" actor=agent row=R003 -->")).toBe(true);
    expect(parseTriageMarker(marker)).toEqual({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
      row: "R003",
    });
  });

  test("a row token round-trips on a dismissal, after the verdict", () => {
    const marker = triageMarker({
      tag: "dismissed",
      headSha: HEAD,
      actor: "agent",
      verdict: "upheld",
      row: "R012",
    });
    expect(marker.endsWith(" verdict=upheld row=R012 -->")).toBe(true);
    expect(parseTriageMarker(marker)).toEqual({
      tag: "dismissed",
      headSha: HEAD,
      actor: "agent",
      verdict: "upheld",
      row: "R012",
    });
  });

  test("a deferred reply with an issue keeps its row", () => {
    const marker = triageMarker({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      issue: 7,
      verdict: "upheld",
      row: "R001",
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      issue: 7,
      verdict: "upheld",
      row: "R001",
    });
  });

  test("a marker without a row parses with no row key", () => {
    const parsed = parseTriageMarker(
      triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" }),
    );
    expect(parsed).not.toBeNull();
    expect("row" in (parsed ?? {})).toBe(false);
  });

  test("triageMarker throws for a malformed row", () => {
    for (const row of ["R1", "r001", "F001", "R001 x"]) {
      expect(() =>
        triageMarker({ tag: "applied", headSha: HEAD, actor: "agent", row }),
      ).toThrow(/summary row id/);
    }
  });

  test("a marker with a malformed row does not parse", () => {
    const valid = triageMarker({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
    });
    expect(parseTriageMarker(valid.replace(" -->", " row=R1 -->"))).toBeNull();
    expect(
      parseTriageMarker(valid.replace(" -->", " row=F001 -->")),
    ).toBeNull();
  });
});

describe("triageBadge + renderTriageReplyBody", () => {
  test("applied badge has no adjudicator clause", () => {
    expect(triageBadge({ tag: "applied", headSha: HEAD, actor: "agent" })).toBe(
      "✅ **APPLIED** · agent",
    );
  });

  test("dismissed badge names the adjudicator verdict", () => {
    expect(
      triageBadge({
        tag: "dismissed",
        headSha: HEAD,
        actor: "agent",
        verdict: "upheld",
      }),
    ).toBe("❌ **DISMISSED** · agent · adjudicator: upheld");
  });

  test("deferred badge omits the issue when none was supplied", () => {
    expect(
      triageBadge({
        tag: "deferred",
        headSha: HEAD,
        actor: "agent",
        verdict: "upheld",
      }),
    ).toBe("📋 **DEFERRED** · agent · adjudicator: upheld");
  });

  test("deferred badge appends the issue when supplied", () => {
    expect(
      triageBadge({
        tag: "deferred",
        headSha: HEAD,
        actor: "agent",
        issue: 482,
        verdict: "upheld",
      }),
    ).toBe("📋 **DEFERRED** · agent · adjudicator: upheld · #482");
  });

  test("renderTriageReplyBody puts marker, badge, then reasoning", () => {
    const body = renderTriageReplyBody(
      { tag: "applied", headSha: HEAD, actor: "agent" },
      "Fixed in 3f9a2c1.",
    );
    const marker = triageMarker({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
    });
    expect(body.startsWith(`${marker}\n`)).toBe(true);
    expect(body).toContain("✅ **APPLIED** · agent");
    expect(body).toContain("Fixed in 3f9a2c1.");
    expect(parseTriageMarker(body)?.tag).toBe("applied");
  });

  test("blank reasoning still emits marker and badge", () => {
    const body = renderTriageReplyBody(
      { tag: "applied", headSha: HEAD, actor: "agent" },
      "   \n",
    );
    expect(body).toContain("✅ **APPLIED** · agent");
    expect(body.endsWith("\n")).toBe(true);
  });

  test("renderTriageReplyBody without a subject is unchanged by the optional parameter", () => {
    const fields = {
      tag: "applied" as const,
      headSha: HEAD,
      actor: "agent" as const,
    };
    expect(renderTriageReplyBody(fields, "Fixed in 3f9a2c1.")).toBe(
      renderTriageReplyBody(fields, "Fixed in 3f9a2c1.", undefined),
    );
  });

  test("renderTriageReplyBody places the subject between badge and prose", () => {
    const fields = {
      tag: "applied" as const,
      headSha: HEAD,
      actor: "agent" as const,
    };
    const marker = triageMarker(fields);
    const badge = triageBadge(fields);
    expect(
      renderTriageReplyBody(fields, "Fixed in 3f9a2c1.", "SUBJECT LINE"),
    ).toBe(`${marker}\n\n${badge}\n\nSUBJECT LINE\n\nFixed in 3f9a2c1.\n`);
  });

  test("renderTriageReplyBody with a subject and empty prose ends after the subject", () => {
    const fields = {
      tag: "applied" as const,
      headSha: HEAD,
      actor: "agent" as const,
    };
    const marker = triageMarker(fields);
    const badge = triageBadge(fields);
    expect(renderTriageReplyBody(fields, "  \n", "SUBJECT LINE")).toBe(
      `${marker}\n\n${badge}\n\nSUBJECT LINE\n`,
    );
  });
});

describe("renderTriageReplyBody publishes safe reasoning", () => {
  test("a token, mention and image in the reasoning do not reach the reply", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const body = renderTriageReplyBody(
      { tag: "applied", headSha: "b".repeat(40), actor: "agent" },
      `cc @octocat ![x](https://evil.example/p.png) ${token}`,
    );
    expect(body).not.toContain("@octocat");
    expect(body).not.toContain("![x]");
    expect(body).not.toContain(token);
    expect(body.split("\n")[0]).toContain("crysk-triage tag=applied");
  });
});
