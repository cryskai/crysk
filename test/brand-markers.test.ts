// The rename writes `<!-- crysk-…` markers and still reads the `<!-- pr-hero-…`
// ones already posted on open PRs. Each test feeds a legacy comment, built by
// renaming what the writer produces today, through the public reader.
import { describe, expect, test } from "bun:test";
import {
  MANUAL_REQUIRED_COMMENT_MARKER,
  SKIP_SIZE_COMMENT_MARKER,
} from "#ci/gates";
import {
  parseCiAdmissionBlock,
  renderCiAdmissionBlock,
} from "#ci/review-admission";
import { findMarkedCommentId } from "#pr/preflight";
import { parseStateBlock, renderStateBlock } from "#rereview/state";
import { parseTriageMarker, triageMarker } from "#triage/triage";

const HEAD = "e3ab386a63020c6f5c21d814d176ff33849eef8d";
const legacy = (text: string) =>
  text.replaceAll("<!-- crysk-", "<!-- pr-hero-");

describe("legacy pr-hero markers still read", () => {
  test("a triage reply", () => {
    const written = triageMarker({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
    });
    expect(written.startsWith("<!-- crysk-triage ")).toBe(true);
    expect(parseTriageMarker(legacy(written))).toEqual(
      parseTriageMarker(written),
    );
    expect(parseTriageMarker(legacy(written))).not.toBeNull();
  });

  test("the state block inside a summary", () => {
    const written = `summary\n${renderStateBlock(HEAD, [], 2)}`;
    expect(parseStateBlock(legacy(written))).toEqual(parseStateBlock(written));
    expect(parseStateBlock(legacy(written))?.headSha).toBe(HEAD);
  });

  test("the CI admission block inside a summary", () => {
    const written = `summary\n${renderCiAdmissionBlock(HEAD, { blocking: 1, advisory: 2 }, 1)}`;
    expect(parseCiAdmissionBlock(legacy(written))).toEqual(
      parseCiAdmissionBlock(written),
    );
    expect(parseCiAdmissionBlock(legacy(written))).not.toBeNull();
  });

  test("a gate notice is found again under its old marker", () => {
    for (const marker of [
      SKIP_SIZE_COMMENT_MARKER,
      MANUAL_REQUIRED_COMMENT_MARKER,
    ]) {
      expect(
        findMarkedCommentId(
          [{ id: 7, body: `${legacy(marker)}\nold` }],
          marker,
        ),
      ).toBe(7);
    }
  });
});
