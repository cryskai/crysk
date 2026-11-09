// init is idempotent: a second run with the same ref writes nothing, a run with
// another ref commits only the workflow pin, and the route decides the models
// variable. The default claude route deletes a present CRYSK_MODELS; the opencode
// route sets it to its snapshot. Every route refuses when the subscription token
// CRYSK_CLAUDE_OAUTH_TOKEN is missing, or when CRYSK_CLAUDE_API_KEY is present. init
// sets no secret: a secret's value is the owner's, and presence is all it can check.

import { describe, expect, test } from "bun:test";
import { runInit } from "../../scripts/sandbox/init";
import {
  RailViolation,
  SANDBOX_REMOTE_URL,
  SANDBOX_REPO,
} from "../../scripts/sandbox/rails";
import {
  API_KEY_SECRET,
  CLAUDE_TOKEN_SECRET,
  MODELS_VARIABLE,
  modelsValueFor,
  REPO_DESCRIPTION,
  sandboxFiles,
  WORKFLOW_PATH,
} from "../../scripts/sandbox/seed";
import { fail, gitFail, gitOk, harness, ok } from "./fakes";

interface World {
  exists: boolean;
  hasCommits: boolean;
  remoteUrl: string;
  // The push URL, when it differs from the fetch URL; `git push` uses this one.
  pushUrl?: string;
  remoteFiles: Map<string, string>;
  secretNames: string[];
  variable: string | undefined;
  secretsSet: string[][];
  variablesSet: string[][];
  variablesDeleted: string[][];
  reposCreated: string[][];
}

function world(overrides: Partial<World> = {}): World {
  return {
    exists: true,
    hasCommits: true,
    remoteUrl: SANDBOX_REMOTE_URL,
    remoteFiles: new Map(),
    secretNames: [CLAUDE_TOKEN_SECRET],
    variable: undefined,
    secretsSet: [],
    variablesSet: [],
    variablesDeleted: [],
    reposCreated: [],
    ...overrides,
  };
}

const OPENCODE_ROUTE = {
  kind: "opencode" as const,
  modelSnapshot: "deepseek-v4.1-flash-free",
};

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
              "HTTP 404: Not Found (https://api.github.com/repos/x/actions/variables/CRYSK_MODELS)",
            )
          : ok(`${w.variable}\n`);
      }
      if (args[0] === "variable" && args[1] === "set") {
        w.variablesSet.push([...args]);
        w.variable = args.at(-1);
        return ok();
      }
      if (args[0] === "variable" && args[1] === "delete") {
        w.variablesDeleted.push([...args]);
        w.variable = undefined;
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
      if (args[0] === "remote") {
        const pushing = args.includes("--push");
        return gitOk(`${pushing ? (w.pushUrl ?? w.remoteUrl) : w.remoteUrl}\n`);
      }
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
    expect(
      h.ghCalls.some((c) => c[0] === "variable" && c[1] === "delete"),
    ).toBe(false);
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
    const w = world({ remoteUrl: "https://github.com/cryskai/crysk.git" });
    const h = harness(scriptFor(w));
    await expect(runInit(h.deps, REF)).rejects.toThrow(RailViolation);
    expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
  });

  // git push uses the push URL, which can differ from the fetch URL that a bare
  // get-url reads. A clone whose fetch URL is the sandbox but whose push URL is not
  // must be refused before anything is pushed.
  test("refuses a clone whose push URL is not the sandbox, even when its fetch URL is", async () => {
    const w = world({
      pushUrl: "https://github.com/cryskai/crysk.git",
    });
    const h = harness(scriptFor(w));
    await expect(runInit(h.deps, REF)).rejects.toThrow(RailViolation);
    expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
  });
});

describe("init: route", () => {
  test("the default route is claude: a present models variable is deleted, and no models value is written", async () => {
    const w = world({
      variable: modelsValueFor("big-pickle"),
      remoteFiles: sandboxFiles(REF),
    });
    await runInit(harness(scriptFor(w)).deps, REF);
    expect(w.variablesDeleted).toEqual([
      ["variable", "delete", MODELS_VARIABLE, "--repo", SANDBOX_REPO],
    ]);
    expect(w.variablesSet).toEqual([]);
  });

  for (const route of [undefined, OPENCODE_ROUTE]) {
    const name = route === undefined ? "claude" : "opencode";
    test(`the ${name} route refuses, before the models variable changes, when the subscription token is missing, and names the command`, async () => {
      const w = world({
        secretNames: ["CLAUDE_CODE_OAUTH_TOKEN", "OPENCODE_AUTH_JSON"],
        variable: "{}",
        remoteFiles: sandboxFiles(REF),
      });
      const run = runInit(harness(scriptFor(w)).deps, REF, route);
      await expect(run).rejects.toThrow(
        `gh secret set ${CLAUDE_TOKEN_SECRET} --repo ${SANDBOX_REPO}`,
      );
      expect(w.variablesDeleted).toEqual([]);
      expect(w.variablesSet).toEqual([]);
    });

    test(`the ${name} route refuses before any write when ${API_KEY_SECRET} is set on the sandbox, and names the removal command`, async () => {
      const w = world({
        exists: true,
        hasCommits: false,
        secretNames: [CLAUDE_TOKEN_SECRET, API_KEY_SECRET],
        remoteFiles: new Map(),
      });
      const h = harness(scriptFor(w));
      await expect(runInit(h.deps, REF, route)).rejects.toThrow(
        `${API_KEY_SECRET} is set on the sandbox; its reviews run Claude on the subscription and must not be able to bill per token. Remove it: gh secret delete ${API_KEY_SECRET} --repo ${SANDBOX_REPO}`,
      );
      // Nothing was written: no repo, no push, no secret, no variable.
      expect(w.reposCreated).toEqual([]);
      expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
      expect(w.secretsSet).toEqual([]);
      expect(w.variablesSet).toEqual([]);
      expect(w.variablesDeleted).toEqual([]);
    });
  }

  test("the old ANTHROPIC_API_KEY is not refused: the scaffold no longer passes it, so it cannot bill", async () => {
    const w = world({
      secretNames: [CLAUDE_TOKEN_SECRET, "ANTHROPIC_API_KEY"],
      remoteFiles: sandboxFiles(REF),
    });
    await expect(
      runInit(harness(scriptFor(w)).deps, REF),
    ).resolves.toBeUndefined();
  });

  test("the opencode route writes the models value with the given snapshot", async () => {
    const w = world({ variable: undefined, remoteFiles: sandboxFiles(REF) });
    await runInit(harness(scriptFor(w)).deps, REF, OPENCODE_ROUTE);
    expect(w.variablesSet).toEqual([
      [
        "variable",
        "set",
        MODELS_VARIABLE,
        "-R",
        SANDBOX_REPO,
        "--body",
        '{"default":["opencode:opencode/deepseek-v4.1-flash-free"]}',
      ],
    ]);
    expect(w.variablesDeleted).toEqual([]);
  });

  test("the opencode route leaves a models variable alone when it already holds the snapshot", async () => {
    const w = world({
      variable: modelsValueFor("deepseek-v4.1-flash-free"),
      remoteFiles: sandboxFiles(REF),
    });
    await runInit(harness(scriptFor(w)).deps, REF, OPENCODE_ROUTE);
    expect(w.variablesSet).toEqual([]);
  });

  test("an invalid snapshot is refused before anything is written", async () => {
    const w = world({ remoteFiles: sandboxFiles(REF) });
    const h = harness(scriptFor(w));
    await expect(
      runInit(h.deps, REF, { kind: "opencode", modelSnapshot: "bad snapshot" }),
    ).rejects.toThrow(/not valid/);
    expect(h.gitCalls).toEqual([]);
    expect(w.variablesSet).toEqual([]);
    expect(w.secretsSet).toEqual([]);
    expect(w.reposCreated).toEqual([]);
  });
});

describe("init: secrets and variable", () => {
  test("sets no secret on either route, the old OpenCode auth secret included", async () => {
    for (const route of [undefined, OPENCODE_ROUTE]) {
      const w = world({ remoteFiles: sandboxFiles(REF) });
      const h = harness(scriptFor(w));
      await runInit(h.deps, REF, route);
      expect(w.secretsSet).toEqual([]);
      expect(h.ghCalls.some((c) => c[0] === "secret" && c[1] === "set")).toBe(
        false,
      );
    }
  });

  test("on the opencode route, replaces a models variable whose value differs, and leaves a matching one alone", async () => {
    const differs = world({ variable: "{}", remoteFiles: sandboxFiles(REF) });
    await runInit(harness(scriptFor(differs)).deps, REF, OPENCODE_ROUTE);
    expect(differs.variablesSet.length).toBe(1);

    const matches = world({
      variable: modelsValueFor("deepseek-v4.1-flash-free"),
      remoteFiles: sandboxFiles(REF),
    });
    await runInit(harness(scriptFor(matches)).deps, REF, OPENCODE_ROUTE);
    expect(matches.variablesSet).toEqual([]);
  });

  test("touches no other variable: the old routing one, the credentials and the providers stay as they are", async () => {
    for (const route of [undefined, OPENCODE_ROUTE]) {
      const w = world({ variable: "{}", remoteFiles: sandboxFiles(REF) });
      const h = harness(scriptFor(w));
      await runInit(h.deps, REF, route);
      const named = h.ghCalls
        .filter((c) => c[0] === "variable")
        .map((c) => c[2]);
      expect(new Set(named)).toEqual(new Set([MODELS_VARIABLE]));
    }
  });
});
