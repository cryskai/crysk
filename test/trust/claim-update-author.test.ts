// A pull request can switch from the workflow token to the Crysk App partway
// through, so a claim update from the other bot is still the review's own: it
// is the claim the thread shows, and it is not a new reply that would queue a
// paid verification. One typed by a person stays a reply like any other.
import { describe, expect, test } from "bun:test";
import { claimFingerprint, threadShownClaim } from "#pr/preflight";
import { enrichPriorsFromThreads } from "#rereview/prepare";

const HEAD = "a".repeat(40);
const OLD = "the original claim";
const NEW = "a different defect";

const root = {
  id: 22,
  user: "github-actions[bot]",
  in_reply_to_id: null,
  body: `<!-- crysk-finding path=src%2Fa.ts line=10 head=${HEAD} c=${claimFingerprint(OLD)} -->\nclaim`,
  created_at: "2026-08-19T12:00:00Z",
};
const update = (user: string) => ({
  id: 23,
  user,
  in_reply_to_id: 22,
  body: `<!-- crysk-claim-update head=${HEAD} c=${claimFingerprint(NEW)} -->\n🔄`,
  created_at: "2026-08-21T12:00:00Z",
});

describe("a claim update from the other bot", () => {
  test("is the claim the thread shows", () => {
    expect(
      threadShownClaim(22, { fingerprint: claimFingerprint(OLD), head: HEAD }, [
        root,
        update("crysk-ai[bot]"),
      ]).fingerprint,
    ).toBe(claimFingerprint(NEW));
  });

  test("one typed by a person is not", () => {
    expect(
      threadShownClaim(22, { fingerprint: claimFingerprint(OLD), head: HEAD }, [
        root,
        update("mallory"),
      ]).fingerprint,
    ).toBe(claimFingerprint(OLD));
  });

  const enrich = (user: string) =>
    enrichPriorsFromThreads({
      priors: [
        {
          id: "R001",
          sev: "CRITICAL" as const,
          tier: "blocking" as const,
          channel: "inline" as const,
          locs: ["src/a.ts:10"],
          claim: NEW,
          triage: null,
          newThreadReply: false,
        },
      ],
      posted: [
        {
          id: 22,
          channel: "review" as const,
          marker: { path: "src/a.ts", line: 10, c: claimFingerprint(OLD) },
        },
      ],
      replies: [root, update(user)],
      summaryUpdatedAt: "2026-08-20T12:00:00Z",
    })[0]?.newThreadReply;

  test("is not a new thread reply", () => {
    expect(enrich("crysk-ai[bot]")).toBe(false);
  });

  test("one typed by a person is a new thread reply", () => {
    expect(enrich("mallory")).toBe(true);
  });
});
