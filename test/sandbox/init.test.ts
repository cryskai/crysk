// init is idempotent: a second run with the same ref writes nothing, a run with
// another ref commits only the workflow pin, and a missing secret or variable
// is set while a present one is left alone (a secret's value cannot be read
// back, so presence is all init can check).

import { describe, expect, test } from "bun:test";
import { runInit } from "../../scripts/sandbox/init";
import {
  RailViolation,
  SANDBOX_REMOTE_URL,
  SANDBOX_REPO,
} from "../../scripts/sandbox/rails";
import {
  OPENCODE_AUTH_SECRET,
  OPENCODE_AUTH_VALUE,
  REPO_DESCRIPTION,
  ROUTING_VALUE,
  ROUTING_VARIABLE,
  sandboxFiles,
  WORKFLOW_PATH,
} from "../../scripts/sandbox/seed";
import { fail, gitFail, gitOk, harness, ok } from "./fakes";

interface World {
  exists: boolean;
  hasCommits: boolean;
  remoteUrl: string;
  remoteFiles: Map<string, string>;
  secretNames: string[];
  variable: string | undefined;
  secretsSet: string[][];
  variablesSet: string[][];
  reposCreated: string[][];
}

function world(overrides: Partial<World> = {}): World {
  return {
    exists: true,
    hasCommits: true,
    remoteUrl: SANDBOX_REMOTE_URL,
    remoteFiles: new Map(),
    secretNames: [OPENCODE_AUTH_SECRET],
    variable: ROUTING_VALUE,
    secretsSet: [],
    variablesSet: [],
    reposCreated: [],
    ...overrides,
  };
}

function scriptFor(w: World) {
  return {
    gh: (
      args: readonly string[],
      h: {
        workspace: {
          seed: (d: string, f: ReadonlyMap<string, string>) => void;
        };
      },
    ) => {
      if (args[0] === "repo" && args[1] === "view") {
        return w.exists
          ? ok('{"name":"pr-hero-sandbox"}')
          : fail(
              `GraphQL: Could not resolve to a Repository with the name '${SANDBOX_REPO}'. (repository)`,
            );
      }
      if (args[0] === "repo" && args[1] === "create") {
        w.reposCreated.push([...args]);
        return ok();
      }
      if (args[0] === "repo" && args[1] === "clone") {
        h.workspace.seed(args[3] ?? "", w.remoteFiles);
        return ok();
      }
      if (args[0] === "secret" && args[1] === "list") {
        return ok(JSON.stringify(w.secretNames.map((name) => ({ name }))));
      }
      if (args[0] === "secret" && args[1] === "set") {
        w.secretsSet.push([...args]);
        return ok();
      }
      if (args[0] === "variable" && args[1] === "get") {
        return w.variable === undefined
          ? fail(
              "HTTP 404: Not Found (https://api.github.com/repos/x/actions/variables/PRHERO_ROUTING)",
            )
          : ok(`${w.variable}\n`);
      }
      if (args[0] === "variable" && args[1] === "set") {
        w.variablesSet.push([...args]);
        w.variable = args.at(-1);
        return ok();
      }
      return ok();
    },
    git: (args: readonly string[]) => {
      if (args[0] === "rev-parse") {
        return w.hasCommits
          ? gitOk(`${"b".repeat(40)}\n`)
          : gitFail("fatal: Needed a single revision", 128);
      }
      if (args[0] === "remote") return gitOk(`${w.remoteUrl}\n`);
      return gitOk();
    },
  };
}

const REF = "v0.2.0";

describe("init: repo", () => {
  test("creates a public repo with the test-bed description only when it is missing", async () => {
    const w = world({
      exists: false,
      hasCommits: false,
      remoteFiles: new Map(),
    });
    const h = harness(scriptFor(w));
    await runInit(h.deps, REF);
    expect(w.reposCreated).toEqual([
      [
        "repo",
        "create",
        SANDBOX_REPO,
        "--public",
        "--description",
        REPO_DESCRIPTION,
      ],
    ]);
    expect(REPO_DESCRIPTION).toContain("CI test bed");
  });

  test("does not create a repo that exists", async () => {
    const w = world({ exists: true });
    const h = harness(scriptFor(w));
    await runInit(h.deps, REF);
    expect(w.reposCreated).toEqual([]);
  });

  test("stops without creating when the lookup fails for a reason other than not-found", async () => {
    const h = harness({
      gh: (args) => {
        if (args[0] === "repo" && args[1] === "view")
          return fail("HTTP 500: Internal Server Error");
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });
    await expect(runInit(h.deps, REF)).rejects.toThrow("HTTP 500");
    expect(h.ghCalls.some((c) => c[1] === "create")).toBe(false);
  });
});

describe("init: main", () => {
  test("seeds an empty repo with the fixture, the pinned workflow, and the repo config", async () => {
    const w = world({ hasCommits: false, remoteFiles: new Map() });
    const h = harness(scriptFor(w));
    await runInit(h.deps, REF);
    expect(h.gitCalls.map((c) => c.args)).toContainEqual([
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    expect(h.gitCalls.map((c) => c.args)).toContainEqual([
      "commit",
      "-m",
      "sandbox: seed main",
    ]);
    expect(h.gitCalls.map((c) => c.args)).toContainEqual([
      "push",
      "origin",
      "main",
    ]);
  });

  test("a second run with the same ref writes nothing at all", async () => {
    const w = world({ remoteFiles: sandboxFiles(REF) });
    const h = harness(scriptFor(w));
    await runInit(h.deps, REF);
    expect(
      h.gitCalls.some((c) => c.args[0] === "commit" || c.args[0] === "push"),
    ).toBe(false);
    expect(h.ghCalls.some((c) => c[0] === "secret" && c[1] === "set")).toBe(
      false,
    );
    expect(h.ghCalls.some((c) => c[0] === "variable" && c[1] === "set")).toBe(
      false,
    );
    expect(h.logs.some((l) => l.includes("nothing to push"))).toBe(true);
  });

  test("a run with another ref commits only the workflow pin", async () => {
    const w = world({ remoteFiles: sandboxFiles("v0.1.0") });
    const h = harness(scriptFor(w));
    await runInit(h.deps, REF);
    expect(h.gitCalls.map((c) => c.args)).toContainEqual([
      "commit",
      "-m",
      "sandbox: pin action to v0.2.0",
    ]);
    expect(h.gitCalls.map((c) => c.args)).toContainEqual([
      "add",
      "--",
      WORKFLOW_PATH,
    ]);
    expect(h.gitCalls.map((c) => c.args)).toContainEqual([
      "push",
      "origin",
      "main",
    ]);
  });

  test("refuses a clone whose origin is not the sandbox", async () => {
    const w = world({ remoteUrl: "https://github.com/juanmaagd/pr-hero.git" });
    const h = harness(scriptFor(w));
    await expect(runInit(h.deps, REF)).rejects.toThrow(RailViolation);
    expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
  });
});

describe("init: secret and variable", () => {
  test("sets a missing OpenCode secret to {} and a missing routing variable", async () => {
    const w = world({
      secretNames: [],
      variable: undefined,
      remoteFiles: sandboxFiles(REF),
    });
    const h = harness(scriptFor(w));
    await runInit(h.deps, REF);
    expect(w.secretsSet).toEqual([
      [
        "secret",
        "set",
        OPENCODE_AUTH_SECRET,
        "-R",
        SANDBOX_REPO,
        "--body",
        OPENCODE_AUTH_VALUE,
      ],
    ]);
    expect(w.variablesSet).toEqual([
      [
        "variable",
        "set",
        ROUTING_VARIABLE,
        "-R",
        SANDBOX_REPO,
        "--body",
        ROUTING_VALUE,
      ],
    ]);
  });

  test("replaces a routing variable whose value differs, and leaves a matching one alone", async () => {
    const differs = world({ variable: "{}", remoteFiles: sandboxFiles(REF) });
    await runInit(harness(scriptFor(differs)).deps, REF);
    expect(differs.variablesSet.length).toBe(1);

    const matches = world({
      variable: ROUTING_VALUE,
      remoteFiles: sandboxFiles(REF),
    });
    await runInit(harness(scriptFor(matches)).deps, REF);
    expect(matches.variablesSet).toEqual([]);
  });

  test("never rewrites a secret that is already present, since its value cannot be read", async () => {
    const w = world({
      secretNames: [OPENCODE_AUTH_SECRET],
      remoteFiles: sandboxFiles(REF),
    });
    await runInit(harness(scriptFor(w)).deps, REF);
    expect(w.secretsSet).toEqual([]);
  });
});
