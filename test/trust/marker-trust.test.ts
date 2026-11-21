import { describe, expect, test } from "bun:test";
import {
  isTrustedMarkerAuthor,
  markerAuthoredComments,
  markerTrust,
} from "../../src/trust/marker-trust";
import { resetSelfLoginCache, resolveSelfLogin } from "../../src/trust/resolve";

describe("who may author a review marker", () => {
  const trust = markerTrust(["maintainer-bot-account", "local-dev"]);

  test("the Actions bot and any App bot are trusted", () => {
    expect(isTrustedMarkerAuthor("github-actions[bot]", trust)).toBe(true);
    expect(isTrustedMarkerAuthor("crysk-ai[bot]", trust)).toBe(true);
  });

  test("a configured login and the local poster's own login are trusted", () => {
    expect(isTrustedMarkerAuthor("maintainer-bot-account", trust)).toBe(true);
    expect(isTrustedMarkerAuthor("local-dev", trust)).toBe(true);
  });

  test("anyone else, and an unknown author, is not", () => {
    expect(isTrustedMarkerAuthor("mallory", trust)).toBe(false);
    expect(isTrustedMarkerAuthor(undefined, trust)).toBe(false);
    // A person's login can never end in [bot]; one that only looks like it is not a bot.
    expect(isTrustedMarkerAuthor("mallory[bot]x", trust)).toBe(false);
  });

  test("an empty trust reads bots only, never everyone", () => {
    const empty = markerTrust([]);
    expect(isTrustedMarkerAuthor("github-actions[bot]", empty)).toBe(true);
    expect(isTrustedMarkerAuthor("mallory", empty)).toBe(false);
  });

  test("undefined and blank logins add nothing", () => {
    expect([...markerTrust([undefined, "", "  "]).logins]).toEqual([]);
  });

  test("the filter keeps trusted comments in order and drops the rest", () => {
    const comments = [
      { id: 1, user: "github-actions[bot]" },
      { id: 2, user: "mallory" },
      { id: 3, user: "local-dev" },
      { id: 4 },
    ];
    expect(markerAuthoredComments(comments, trust).map((c) => c.id)).toEqual([
      1, 3,
    ]);
  });
});

describe("resolveSelfLogin", () => {
  function fakeGh(stdout: string, exitCode = 0) {
    const calls: string[][] = [];
    const spawnFn = ((argv: string[]) => {
      calls.push(argv);
      return {
        stdout: new Response(stdout).body,
        stderr: new Response("").body,
        exited: Promise.resolve(exitCode),
      };
    }) as unknown as typeof Bun.spawn;
    return { spawnFn, calls };
  }

  test("reads the signed-in login once per process", async () => {
    resetSelfLoginCache();
    const gh = fakeGh("local-dev\n");
    const env = { GITHUB_ACTIONS: undefined };
    expect(
      await resolveSelfLogin({
        operatorRoot: "/repo",
        env,
        spawnFn: gh.spawnFn,
      }),
    ).toBe("local-dev");
    expect(
      await resolveSelfLogin({
        operatorRoot: "/repo",
        env,
        spawnFn: gh.spawnFn,
      }),
    ).toBe("local-dev");
    expect(gh.calls).toEqual([["gh", "api", "user", "--jq", ".login"]]);
    resetSelfLoginCache();
  });

  test("in Actions it asks nothing and adds no login", async () => {
    resetSelfLoginCache();
    const gh = fakeGh("someone\n");
    expect(
      await resolveSelfLogin({
        operatorRoot: "/repo",
        env: { GITHUB_ACTIONS: "true" },
        spawnFn: gh.spawnFn,
      }),
    ).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });

  test("a failed lookup adds no login and is asked again next time", async () => {
    resetSelfLoginCache();
    const failing = fakeGh("", 1);
    expect(
      await resolveSelfLogin({
        operatorRoot: "/repo",
        env: {},
        spawnFn: failing.spawnFn,
      }),
    ).toBeUndefined();
    const working = fakeGh("local-dev\n");
    expect(
      await resolveSelfLogin({
        operatorRoot: "/repo",
        env: {},
        spawnFn: working.spawnFn,
      }),
    ).toBe("local-dev");
    resetSelfLoginCache();
  });
});
