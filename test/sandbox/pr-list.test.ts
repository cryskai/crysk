// The serialization check lists the open scenario PRs. A scenario PR that is older
// than a page of newer, unrelated PRs must still be found, and a search cannot be
// trusted for it: GitHub's search index lags behind the PR list, so a PR opened
// moments ago may not be in a search yet. The list is read whole, under a page far
// larger than any repository's open PRs, and filtered here. A fork PR with a sandbox/
// head must still not count.

import { describe, expect, test } from "bun:test";
import { listScenarioPrs } from "../../scripts/sandbox/pr";
import { SANDBOX_REPO } from "../../scripts/sandbox/rails";
import { fail, type Harness, harness, ok } from "./fakes";

interface Row {
  number: number;
  headRefName: string;
  url: string;
  isCrossRepository: boolean;
  headRepositoryOwner: { login: string } | null;
}

function pr(number: number, headRefName: string, fork = false): Row {
  return {
    number,
    headRefName,
    url: `https://github.com/${SANDBOX_REPO}/pull/${number}`,
    isCrossRepository: fork,
    headRepositoryOwner: { login: fork ? "stranger" : "juanmaagd" },
  };
}

// What `gh pr list` answers: the open PRs, newest first, cut to --limit. A --search
// is answered from an index that has not caught up: it returns nothing, so a query
// that depends on one misses every PR the index has not seen.
function githubPrList(all: Row[]): (args: readonly string[]) => string {
  return (args) => {
    const flagValue = (name: string) => {
      const at = args.indexOf(name);
      return at === -1 ? undefined : args[at + 1];
    };
    if (args.includes("--search")) return "[]";
    const limit = Number(flagValue("--limit") ?? "30");
    return JSON.stringify(all.slice(0, limit));
  };
}

function listing(all: Row[]): Harness {
  const answer = githubPrList(all);
  return harness({
    gh: (args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(answer(args));
      return fail(`unexpected gh call: ${args.join(" ")}`);
    },
  });
}

describe("listScenarioPrs: the serialization check sees every scenario PR", () => {
  test("a scenario PR behind 150 newer unrelated PRs is still listed", async () => {
    const newer = Array.from({ length: 150 }, (_, i) =>
      pr(300 - i, `feature/unrelated-${i}`),
    );
    const scenario = pr(7, "sandbox/review-free-20261016T120000Z");
    const h = listing([...newer, scenario]);
    const found = await listScenarioPrs(h.deps);
    expect(found.map((p) => p.number)).toEqual([7]);
  });

  test("a fork PR with a sandbox/ head does not count, even when it is the newest", async () => {
    const fork = pr(99, "sandbox/review-free-forged", true);
    const scenario = pr(7, "sandbox/review-free-20261016T120000Z");
    const h = listing([fork, scenario]);
    const found = await listScenarioPrs(h.deps);
    expect(found.map((p) => p.number)).toEqual([7]);
  });

  test("the query has no --search, and reads a page far larger than the default", async () => {
    const h = listing([]);
    await listScenarioPrs(h.deps);
    const call = h.ghCalls.find((c) => c[0] === "pr" && c[1] === "list");
    expect(call).toBeDefined();
    expect(call?.includes("--search")).toBe(false);
    expect(Number(call?.[call.indexOf("--limit") + 1])).toBeGreaterThanOrEqual(
      1000,
    );
  });
});
