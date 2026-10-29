// Decision tests for the global ~/.crysk/ product home (W3 / #24):
// origin canonicalization, the layout, registry upsert, and the leftover
// sibling-path hint. All offline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliUsageError } from "../src/errors";
import {
  canonicalRemoteId,
  decidePidLock,
  decideRegistryUpsert,
  defaultRunRoot,
  legacyMigrationHint,
  legacyRunRoot,
  legacyWorktreePath,
  missingOriginMessage,
  parseRepoRegistry,
  prheroLayout,
  prWorktreePath,
  repoHomePaths,
  serializeRepoRegistry,
  touchWorktreeStamp,
  worktreeLockPath,
} from "../src/home-preflight";

const HOME = "/Users/x";
const REPO_ID = "github.com/juanmaagd/musive";

describe("prheroLayout", () => {
  test("repos hang off the same home as the watcher files", () => {
    expect(prheroLayout(HOME)).toEqual({
      dir: "/Users/x/.crysk",
      nodeModulesDir: "/Users/x/.crysk/node_modules",
      reposDir: "/Users/x/.crysk/repos",
      watchConfigPath: "/Users/x/.crysk/watch.json",
      reviewConfigPath: "/Users/x/.crysk/config.json",
      logPath: "/Users/x/.crysk/watch.log",
      lockPath: "/Users/x/.crysk/watch.lock",
      launchdLogPath: "/Users/x/.crysk/launchd.log",
      metricsDbPath: "/Users/x/.crysk/metrics.db",
      prheroDbPath: "/Users/x/.crysk/prhero.db",
      storeSocketPath: "/Users/x/.crysk/store.sock",
      upgradeCheckPath: "/Users/x/.crysk/upgrade-check.json",
      bucketKeyPath: "/Users/x/.crysk/bucket-key",
    });
  });

  test("the metrics db and prhero db are siblings of the repos tree, not nested under it", () => {
    expect(prheroLayout(HOME).metricsDbPath).toBe("/Users/x/.crysk/metrics.db");
    expect(prheroLayout(HOME).prheroDbPath).toBe("/Users/x/.crysk/prhero.db");
  });

  // C5 / O-13. The compile-time half of this is the retirement itself: with
  // no `configPath` on PrheroLayout, an un-migrated `paths.configPath` is a
  // tsc failure rather than a wrong-file read. This is the runtime witness
  // for the half tsc cannot state — that the name is GONE (not merely
  // re-pointed), and that the two survivors name the two different files.
  test("the layout exposes watchConfigPath and reviewConfigPath and no configPath", () => {
    const layout = prheroLayout(HOME);
    expect(Object.keys(layout)).not.toContain("configPath");
    expect(layout.watchConfigPath).toBe("/Users/x/.crysk/watch.json");
    expect(layout.reviewConfigPath).toBe("/Users/x/.crysk/config.json");
    expect(layout.watchConfigPath).not.toBe(layout.reviewConfigPath);
  });
});

describe("prheroLayout home resolution", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "crysk-layout-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("a legacy-only ~/.prhero keeps being used, for every path in the layout", () => {
    mkdirSync(path.join(home, ".prhero"));
    const layout = prheroLayout(home);
    expect(layout.dir).toBe(path.join(home, ".prhero"));
    expect(layout.reviewConfigPath).toBe(
      path.join(home, ".prhero", "config.json"),
    );
    expect(repoHomePaths(home, REPO_ID).root).toBe(
      path.join(home, ".prhero", "repos", REPO_ID),
    );
  });

  test("a fresh home resolves to ~/.crysk", () => {
    expect(prheroLayout(home).dir).toBe(path.join(home, ".crysk"));
  });

  test("when both exist and ~/.crysk holds state, ~/.crysk wins", () => {
    mkdirSync(path.join(home, ".prhero"));
    mkdirSync(path.join(home, ".crysk"));
    writeFileSync(path.join(home, ".crysk", "config.json"), "{}");
    expect(prheroLayout(home).dir).toBe(path.join(home, ".crysk"));
  });

  test("an empty ~/.crysk does not hide a ~/.prhero in use", () => {
    mkdirSync(path.join(home, ".prhero"));
    mkdirSync(path.join(home, ".crysk"));
    expect(prheroLayout(home).dir).toBe(path.join(home, ".prhero"));
  });
});

describe("canonicalRemoteId", () => {
  test("ssh, https, and a trailing .git collide", () => {
    expect(canonicalRemoteId("git@github.com:juanmaagd/musive.git")).toBe(
      REPO_ID,
    );
    expect(canonicalRemoteId("https://github.com/juanmaagd/musive.git")).toBe(
      REPO_ID,
    );
    expect(canonicalRemoteId("https://github.com/juanmaagd/musive")).toBe(
      REPO_ID,
    );
    expect(canonicalRemoteId("https://github.com/juanmaagd/musive/")).toBe(
      REPO_ID,
    );
    expect(canonicalRemoteId("ssh://git@github.com/juanmaagd/musive.git")).toBe(
      REPO_ID,
    );
  });

  test("host and path are lowercased so case cannot split a GitHub repo", () => {
    expect(canonicalRemoteId("git@GitHub.com:Juanmaagd/Musive.git")).toBe(
      REPO_ID,
    );
    expect(canonicalRemoteId("https://GitHub.com/Juanmaagd/Musive")).toBe(
      REPO_ID,
    );
  });

  test("a non-GitHub host keeps path case so distinct remotes cannot collide", () => {
    expect(canonicalRemoteId("https://gitlab.example/Org/Repo.git")).toBe(
      "gitlab.example/Org/Repo",
    );
    expect(canonicalRemoteId("https://gitlab.example/org/repo.git")).toBe(
      "gitlab.example/org/repo",
    );
  });

  test("an empty origin, a parent segment, and garbage all fail loud", () => {
    expect(() => canonicalRemoteId("")).toThrow(CliUsageError);
    expect(() => canonicalRemoteId("   ")).toThrow(CliUsageError);
    expect(() => canonicalRemoteId("not a remote")).toThrow(CliUsageError);
    expect(() => canonicalRemoteId("https://github.com/../etc/passwd")).toThrow(
      CliUsageError,
    );
    expect(() => canonicalRemoteId("git@github.com:../musive")).toThrow(
      CliUsageError,
    );
  });
});

describe("repo home paths", () => {
  test("two checkouts of the same remote share one worktree path", () => {
    const fromS1 = prWorktreePath(HOME, REPO_ID, 1724);
    const fromS3 = prWorktreePath(HOME, REPO_ID, 1724);
    expect(fromS1).toBe(
      "/Users/x/.crysk/repos/github.com/juanmaagd/musive/worktrees/pr-1724",
    );
    expect(fromS3).toBe(fromS1);
  });

  test("the default runs root hangs off the same repo id", () => {
    expect(defaultRunRoot(HOME, REPO_ID)).toBe(
      "/Users/x/.crysk/repos/github.com/juanmaagd/musive/runs",
    );
    expect(repoHomePaths(HOME, REPO_ID).registry).toBe(
      "/Users/x/.crysk/repos/github.com/juanmaagd/musive/registry.json",
    );
  });

  test("the in-flight lock sits beside the worktree, never inside it", () => {
    expect(worktreeLockPath(HOME, REPO_ID, 1724)).toBe(
      `${prWorktreePath(HOME, REPO_ID, 1724)}.lock`,
    );
  });

  test("a live pid holds the lock; a dead or missing one is stealable", () => {
    expect(
      decidePidLock({
        fileExists: false,
        existingPid: null,
        holderAlive: false,
      }),
    ).toEqual({ action: "create" });
    expect(
      decidePidLock({
        fileExists: true,
        existingPid: 4242,
        holderAlive: true,
      }),
    ).toEqual({ action: "held", pid: 4242 });
    expect(
      decidePidLock({
        fileExists: true,
        existingPid: 4242,
        holderAlive: false,
      }),
    ).toEqual({ action: "steal", deadPid: 4242 });
    expect(
      decidePidLock({
        fileExists: true,
        existingPid: null,
        holderAlive: false,
      }),
    ).toEqual({ action: "steal", deadPid: null });
  });

  test("legacy sibling formulas are unchanged, for detection only", () => {
    expect(legacyWorktreePath("/Users/x/Desktop/musive", 1682)).toBe(
      "/Users/x/Desktop/musive-worktrees/pr-1682",
    );
    expect(legacyRunRoot("/Users/x/Desktop/musive")).toBe(
      "/Users/x/Desktop/musive-prhero-runs",
    );
  });
});

describe("registry upsert", () => {
  const s1 = "/Users/x/Desktop/musive/musive-s1";
  const s3 = "/Users/x/Desktop/musive/musive-s3";

  test("the first checkout becomes the git-dir owner", () => {
    const result = decideRegistryUpsert({
      existing: null,
      canonicalRemote: REPO_ID,
      originUrl: "https://github.com/juanmaagd/musive.git",
      checkoutPath: s1,
      ownerPresent: true,
    });
    expect(result.action).toBe("create");
    if (result.action !== "create") return;
    expect(result.registry.git_dir_owner).toBe(s1);
    expect(result.registry.operator_checkouts).toEqual([s1]);
  });

  test("a second clone of the same remote is appended and does not steal ownership", () => {
    const created = decideRegistryUpsert({
      existing: null,
      canonicalRemote: REPO_ID,
      originUrl: "https://github.com/juanmaagd/musive.git",
      checkoutPath: s1,
      ownerPresent: true,
    });
    if (created.action !== "create") throw new Error("expected create");
    const result = decideRegistryUpsert({
      existing: created.registry,
      canonicalRemote: REPO_ID,
      originUrl: "https://github.com/juanmaagd/musive.git",
      checkoutPath: s3,
      ownerPresent: true,
    });
    expect(result.action).toBe("append-checkout");
    if (result.action !== "append-checkout") return;
    expect(result.registry.git_dir_owner).toBe(s1);
    expect(result.registry.operator_checkouts).toEqual([s1, s3]);
    expect(prWorktreePath(HOME, REPO_ID, 1724)).toBe(
      prWorktreePath(HOME, REPO_ID, 1724),
    );
  });

  test("re-registering the same checkout is a no-op", () => {
    const created = decideRegistryUpsert({
      existing: null,
      canonicalRemote: REPO_ID,
      originUrl: "git@github.com:juanmaagd/musive.git",
      checkoutPath: s1,
      ownerPresent: true,
    });
    if (created.action !== "create") throw new Error("expected create");
    const result = decideRegistryUpsert({
      existing: created.registry,
      canonicalRemote: REPO_ID,
      originUrl: "git@github.com:juanmaagd/musive.git",
      checkoutPath: s1,
      ownerPresent: true,
    });
    expect(result.action).toBe("unchanged");
  });

  test("a gone owner fails loud and does not promote the cwd", () => {
    const created = decideRegistryUpsert({
      existing: null,
      canonicalRemote: REPO_ID,
      originUrl: "https://github.com/juanmaagd/musive.git",
      checkoutPath: s1,
      ownerPresent: true,
    });
    if (created.action !== "create") throw new Error("expected create");
    const result = decideRegistryUpsert({
      existing: created.registry,
      canonicalRemote: REPO_ID,
      originUrl: "https://github.com/juanmaagd/musive.git",
      checkoutPath: s3,
      ownerPresent: false,
    });
    expect(result.action).toBe("owner-gone");
    if (result.action !== "owner-gone") return;
    expect(result.registry.git_dir_owner).toBe(s1);
    expect(result.message).toContain("git-dir owner");
    expect(result.message).toContain("registry.json");
  });
});

describe("parseRepoRegistry", () => {
  test("round-trips a valid file, including worktree stamps", () => {
    const stamped = touchWorktreeStamp(
      {
        canonical_remote: REPO_ID,
        origin_url: "https://github.com/juanmaagd/musive.git",
        git_dir_owner: "/a/s1",
        operator_checkouts: ["/a/s1"],
        worktrees: {},
      },
      1724,
      "2026-08-15T10:00:00Z",
    );
    const raw = serializeRepoRegistry(stamped);
    expect(parseRepoRegistry(raw)).toEqual(stamped);
  });

  test("a missing owner or empty checkouts list fails loud", () => {
    expect(() => parseRepoRegistry("{}")).toThrow(CliUsageError);
    expect(() =>
      parseRepoRegistry(
        JSON.stringify({
          canonical_remote: REPO_ID,
          origin_url: "https://github.com/juanmaagd/musive.git",
          git_dir_owner: "/a/s1",
          operator_checkouts: [],
        }),
      ),
    ).toThrow(CliUsageError);
  });
});

describe("legacyMigrationHint", () => {
  test("names the leftover and hands over worktree remove, never rm -rf", () => {
    const lines = legacyMigrationHint({
      operatorRoot: "/Users/x/Desktop/musive/musive-s3",
      legacyWorktree: "/Users/x/Desktop/musive/musive-s3-worktrees/pr-1724",
      newWorktree: prWorktreePath(HOME, REPO_ID, 1724),
    });
    const text = lines.join("\n");
    expect(text).toContain("legacy worktree still at");
    expect(text).toContain(
      "git -C /Users/x/Desktop/musive/musive-s3 worktree remove --force",
    );
    expect(text).not.toContain("rm -rf");
  });
});

describe("missingOriginMessage", () => {
  test("names the checkout and points at --out", () => {
    expect(missingOriginMessage("/tmp/repo")).toContain("/tmp/repo");
    expect(missingOriginMessage("/tmp/repo")).toContain("--out");
  });
});
