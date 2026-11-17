// PR #549 review R001: dropping the /pr-hero commands changed the status builders' tails to `/crysk …`,
// while a status an earlier release wrote still ends in `/pr-hero …`. The carry walk recognises a verdict
// by rebuilding its text, so a legacy verdict must still read as one, or a red is skipped over and an
// older green is carried onto the new head.
import { describe, expect, test } from "bun:test";
import {
  carriedBlockingDescription,
  carriedPartialDescription,
  isReviewVerdictStatus,
} from "#pr/admission";
import {
  blockingCommitStatusRequest,
  COMMIT_STATUS_CONTEXT,
  heldVerdictSha,
  isManualReviewHold,
  manualReviewHoldDescription,
  partialReviewAgainDescription,
  partialReviewDescription,
} from "#pr/preflight";

const SHA = "a".repeat(40);

// The text an earlier release wrote for the same verdict: the legacy lead and the legacy command.
function legacy(text: string): string {
  return text
    .replace(/^crysk/, "pr-hero")
    .replace(/\/crysk (review|recheck|override|stop)/g, "/pr-hero $1");
}

describe("a verdict an earlier release wrote, with the /pr-hero command, is still a verdict", () => {
  const reds: [string, string][] = [
    [
      "blocking",
      blockingCommitStatusRequest({
        blockingCount: 2,
        targetUrl: undefined,
        context: COMMIT_STATUS_CONTEXT,
      }).description,
    ],
    ["carried blocking", carriedBlockingDescription(2, SHA)],
    ["partial", partialReviewDescription(1, 4, "abc123")],
    ["partial again", partialReviewAgainDescription(1, 4, "abc123")],
    ["carried partial", carriedPartialDescription(1, 4, SHA, "abc123")],
  ];

  test.each(reds)("%s", (_name, current) => {
    const old = legacy(current);
    expect(old).toContain("/pr-hero ");
    expect(isReviewVerdictStatus({ state: "failure", description: old })).toBe(
      true,
    );
    expect(
      isReviewVerdictStatus({ state: "failure", description: current }),
    ).toBe(true);
  });
});

// PR #549 review R004: a manual-review hold an earlier release wrote ends in `/pr-hero review or
// /pr-hero override`; the carry walk still has to read the verdict it names.
describe("a manual-review hold an earlier release wrote still names its carried verdict", () => {
  const current = manualReviewHoldDescription("budget used up", "abc1234");

  test.each([
    ["the /pr-hero command", current.replace(/\/crysk /g, "/pr-hero ")],
    [
      "the /pr-hero lead and command",
      current.replace(/^crysk/, "pr-hero").replace(/\/crysk /g, "/pr-hero "),
    ],
    ["the current text", current],
  ])("%s", (_name, description) => {
    const status = { state: "pending", description };
    expect(isManualReviewHold(status)).toBe(true);
    expect(heldVerdictSha(status)).toBe("abc1234");
  });
});
