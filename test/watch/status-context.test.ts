// T3 S7, the watcher side: the watcher is a local actor. Its child run and its
// orphan settle must never write the `pr-hero` context, the gate the CI run
// owns. These tests read the watcher's real argv builder and its real settle
// request, so a regression in either is caught without a live `gh` or child.

import { describe, expect, test } from "bun:test";
import {
  COMMIT_STATUS_CONTEXT,
  LOCAL_COMMIT_STATUS_CONTEXT,
  resolveCiPosture,
} from "#pr/preflight";
import { parseArgs } from "#review/preflight";
import { localReviewArgv, orphanPendingSettleRequest } from "#watch/watch";

describe("the watcher's child review is a local run", () => {
  test("its argv carries no --ci, so it resolves advisory on pr-hero/local", () => {
    const argv = localReviewArgv({ pr: 7, post: true, sizeArgs: [] });
    expect(argv).not.toContain("--ci");
    const parsed = parseArgs(argv);
    expect(parsed.command).toBe("review");
    expect(resolveCiPosture(parsed.options)).toEqual({
      ciMode: "advisory",
      statusContext: LOCAL_COMMIT_STATUS_CONTEXT,
    });
  });

  test("the size flags and the no-post form still carry no --ci", () => {
    const argv = localReviewArgv({
      pr: 9,
      post: false,
      sizeArgs: ["--max-changed-lines", "400"],
    });
    expect(argv).not.toContain("--ci");
    expect(argv).not.toContain("--post");
    expect(argv).toContain("--yes");
    const parsed = parseArgs(argv);
    expect(parsed.options.ci).toBeUndefined();
    expect(resolveCiPosture(parsed.options).statusContext).toBe(
      LOCAL_COMMIT_STATUS_CONTEXT,
    );
  });
});

describe("the watcher's orphan settle never writes pr-hero", () => {
  test("it settles a leftover pending on pr-hero/local as success", () => {
    const request = orphanPendingSettleRequest(
      "https://github.com/org/repo/pull/7",
    );
    expect(request.context).toBe(LOCAL_COMMIT_STATUS_CONTEXT);
    expect(request.context).not.toBe(COMMIT_STATUS_CONTEXT);
    expect(request.state).toBe("success");
    expect(request.targetUrl).toBe("https://github.com/org/repo/pull/7");
  });
});
