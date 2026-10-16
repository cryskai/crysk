// The serialization check lists the open scenario PRs. A scenario PR that is older
// than a page of newer, unrelated PRs must still be found: GitHub applies --search and
// --limit before the runner sees anything, so the query has to narrow to sandbox/
// heads, and a fork PR with a sandbox/ head must still not count.

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

// What `gh pr list` answers: the open PRs, newest first, narrowed by --search (the
// head prefix, GitHub's `head:` qualifier) and then cut to --limit.
function githubPrList(all: Row[]): (args: readonly string[]) => string {
  return (args) => {
    const flagValue = (name: string) => {
      const at = args.indexOf(name);
      return at === -1 ? undefined : args[at + 1];
    };
    const search = flagValue("--search") ?? "";
    const limit = Number(flagValue("--limit") ?? "30");
    const prefix = search.startsWith("head:")
      ? search.slice("head:".length)
      : "";
    const matched = all.filter((p) => p.headRefName.startsWith(prefix));
    return JSON.stringify(matched.slice(0, limit));
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

  test("the query names the sandbox head prefix and a page larger than the default", async () => {
    const h = listing([]);
    await listScenarioPrs(h.deps);
    const call = h.ghCalls.find((c) => c[0] === "pr" && c[1] === "list");
    expect(call).toBeDefined();
    expect(call?.[call.indexOf("--search") + 1]).toBe("head:sandbox/");
    expect(Number(call?.[call.indexOf("--limit") + 1])).toBeGreaterThan(100);
  });
});
