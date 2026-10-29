import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEffectiveConfig } from "#config/config";
import {
  DEFAULT_BASE_REF,
  headContainedInBaseMessage,
  isFullCommitId,
  listPaths,
  parseRemoteHead,
  repoWebUrlFromRemote,
  resolveBaseRef,
} from "#git/refs";
import { aliasCanonical } from "#model/catalog";
import type { RoutingConfig } from "#model/routing";
import {
  type AgentsDirConfigSeat,
  agentsDirProblems,
  agentsDirSeat,
  allExcludedMessage,
  assertBasenameOnly,
  assertOutsideRepo,
  CONFIG_DIRECTION,
  type ConfigLayer,
  DEFAULT_HOP_BUDGET,
  DEFAULT_MAX_VERIFICATION_STEPS,
  DEFAULT_SUMMARY_MODEL,
  EMPTY_LOCAL_CONFIG,
  emptyDiffMessage,
  GOTCHAS_PLACEHOLDER_MARKER,
  GOTCHAS_TEMPLATE,
  gotchasErrorMessage,
  gotchasUnusableReason,
  HELP_TEXT,
  initConfigTemplate,
  initGotchasInstructions,
  initTemplateOmissions,
  type LocalConfig,
  localReviewSpec,
  mergeConfig,
  parseArgs,
  parseGlobalConfig,
  parseLocalConfig,
  parseNumstat,
  parseNumstatFiles,
  parseRoutingConfig,
  preflightAgentsDir,
  resolveAgentsDir,
  resolveAgentsDirSetting,
  resolveMaxConcurrentSteps,
  resolveMaxVerificationSteps,
  resolvePost,
  resolveScout,
  resolveSharedPrefix,
  resolveSummary,
  runDirCandidate,
  SETUP_GOTCHAS_FALLBACK,
  SUMMARY_DIRECTION,
  type SummaryConfig,
} from "#review/preflight";
import { validateReviewSpec } from "#review/spec";
import { CliError, CliUsageError } from "../../src/errors";

describe("parseArgs", () => {
  // `base` is deliberately ABSENT here: resolving the repo's real default
  // branch needs git, parseArgs is pure, so an unset base is the honest
  // answer and cli.ts finishes the job. A literal "main" baked in here is a
  // wrong ref nothing downstream can tell apart from one the user chose.
  test("defaults are the documented ones, and base is left unset", () => {
    const { command, options } = parseArgs(["review"]);
    expect(command).toBe("review");
    expect(options).toEqual({
      repo: ".",
      head: "HEAD",
      hopBudget: DEFAULT_HOP_BUDGET,
      full: false,
      dryRun: false,
      yes: false,
      twoDot: false,
      onPush: false,
      force: false,
      all: false,
      fixes: false,
      incidents: false,
      issues: false,
      proximity: false,
      threads: false,
    });
    expect(options.base).toBeUndefined();
    // Unset, never 0: 0 DISABLES a size limit, so it cannot double as
    // "not asked for".
    expect(options.maxChangedLines).toBeUndefined();
    expect(options.maxChangedFiles).toBeUndefined();
  });

  test("init is a command, and unknown commands still fail", () => {
    expect(parseArgs(["init"]).command).toBe("init");
    expect(parseArgs(["init", "--repo", "/tmp/x"]).options.repo).toBe("/tmp/x");
    expect(() => parseArgs(["initialise"])).toThrow(CliUsageError);
  });

  // C5 O-12. `config` takes the same --repo/--config seats a review does,
  // because it resolves the two layers through the same loadEffectiveConfig —
  // pointing it at another checkout, or at another repo file, has to answer
  // for THAT one or the command cannot be used to debug the setup it is about.
  test("config is a command and takes --repo and --config", () => {
    expect(parseArgs(["config"]).command).toBe("config");
    expect(parseArgs(["config", "--repo", "/tmp/x"]).options.repo).toBe(
      "/tmp/x",
    );
    expect(
      parseArgs(["config", "--config", "/tmp/c.json"]).options.config,
    ).toBe("/tmp/c.json");
    expect(() => parseArgs(["configure"])).toThrow(CliUsageError);
  });

  test("doctor is a command and takes --repo", () => {
    expect(parseArgs(["doctor"]).command).toBe("doctor");
    expect(parseArgs(["doctor", "--repo", "/tmp/x"]).options.repo).toBe(
      "/tmp/x",
    );
    expect(() => parseArgs(["doc"])).toThrow(CliUsageError);
  });

  test("gc is a command, and --dry-run applies", () => {
    expect(parseArgs(["gc"]).command).toBe("gc");
    expect(parseArgs(["gc", "--dry-run"]).options.dryRun).toBe(true);
    expect(parseArgs(["gc", "--repo", "/tmp/x"]).options.repo).toBe("/tmp/x");
  });

  test("gc install, uninstall and status parse; --interval is install-only", () => {
    expect(parseArgs(["gc", "install"]).options.gc).toBe("install");
    expect(
      parseArgs(["gc", "install", "--interval", "60"]).options.interval,
    ).toBe(60);
    expect(parseArgs(["gc", "uninstall"]).options.gc).toBe("uninstall");
    expect(parseArgs(["gc", "status"]).options.gc).toBe("status");
    expect(() => parseArgs(["gc", "--interval", "60"])).toThrow(CliUsageError);
    expect(() => parseArgs(["gc", "install", "--dry-run"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["install"])).toThrow(CliUsageError);
  });

  // W4 / #23: usage is origin-scoped by default (spec "Origin-Scoped Usage
  // By Default"); --all is the operator-wide escape hatch and is valid on
  // NO other command (spec "--all misused on another command").
  test("usage is a command; --all applies only to usage", () => {
    expect(parseArgs(["usage"]).command).toBe("usage");
    expect(parseArgs(["usage"]).options.all).toBe(false);
    expect(parseArgs(["usage", "--all"]).options.all).toBe(true);
    expect(() => parseArgs(["gc", "--all"])).toThrow(CliUsageError);
    expect(() => parseArgs(["review", "--all"])).toThrow(CliUsageError);
  });

  // Both exist so a tree you cannot add a file to is still reviewable: an
  // in-tree-only gotchas file dirties the checkout (which the clean-tree gate
  // then rightly refuses), and an in-tree-only config silently disables the
  // conditional parity hunter, which looks exactly like parity finding nothing.
  test("gotchas and config can be supplied from outside the repo", () => {
    const { options } = parseArgs([
      "review",
      "--gotchas",
      "/elsewhere/gotchas.md",
      "--config",
      "/elsewhere/config.json",
    ]);
    expect(options.gotchas).toBe("/elsewhere/gotchas.md");
    expect(options.config).toBe("/elsewhere/config.json");
  });

  test("neither is set by default, so the in-repo paths win", () => {
    const { options } = parseArgs(["review"]);
    expect(options.gotchas).toBeUndefined();
    expect(options.config).toBeUndefined();
  });

  test("reads every option", () => {
    const { options } = parseArgs([
      "review",
      "--repo",
      "/tmp/repo",
      "--base",
      "release",
      "--head",
      "feature",
      "--agents",
      "/tmp/agents",
      "--out",
      "/tmp/runs",
      "--model",
      "opus",
      "--hop-budget",
      "4",
      "--two-dot",
      "--dry-run",
      "--summary",
      "--yes",
    ]);
    expect(options.twoDot).toBe(true);
    expect(options.repo).toBe("/tmp/repo");
    expect(options.base).toBe("release");
    expect(options.head).toBe("feature");
    expect(options.agents).toBe("/tmp/agents");
    expect(options.out).toBe("/tmp/runs");
    expect(options.model).toBe("opus");
    expect(options.hopBudget).toBe(4);
    expect(options.dryRun).toBe(true);
    expect(options.summary).toBe(true);
    expect(options.yes).toBe(true);
  });

  test("summary flags are explicit and last flag wins", () => {
    expect(parseArgs(["review", "--summary"]).options.summary).toBe(true);
    expect(parseArgs(["review", "--no-summary"]).options.summary).toBe(false);
    expect(
      parseArgs(["review", "--no-summary", "--summary"]).options.summary,
    ).toBe(true);
  });

  test("--shared-prefix is tri-state: undefined by default, true with it, false with --no-shared-prefix", () => {
    expect(parseArgs(["review", "--shared-prefix"]).options.sharedPrefix).toBe(
      true,
    );
    expect(
      parseArgs(["review", "--no-shared-prefix"]).options.sharedPrefix,
    ).toBe(false);
    expect(parseArgs(["review"]).options.sharedPrefix).toBeUndefined();
  });

  // On by default since the 2026-10-22 Claude bench (−28% $/review, −27% wall,
  // no recall loss): an unset flag resolves ON, only --no-shared-prefix is off.
  test("the shared prefix resolves on unless --no-shared-prefix", () => {
    expect(resolveSharedPrefix({})).toBe(true);
    expect(resolveSharedPrefix({ sharedPrefix: true })).toBe(true);
    expect(resolveSharedPrefix({ sharedPrefix: false })).toBe(false);
  });

  test("the scout is tri-state: undefined by default, true with --scout, false with --no-scout", () => {
    expect(parseArgs(["review"]).options.scout).toBeUndefined();
    expect(parseArgs(["review", "--scout"]).options.scout).toBe(true);
    expect(parseArgs(["review", "--no-scout"]).options.scout).toBe(false);
    expect(parseArgs(["review", "--scout"]).options.scoutModel).toBeUndefined();
    expect(
      parseArgs(["review", "--scout", "--scout-model", "haiku"]).options
        .scoutModel,
    ).toBe("haiku");
  });

  test("post is tri-state: undefined by default, true with --post, false with --no-post", () => {
    expect(parseArgs(["review"]).options.post).toBeUndefined();
    expect(parseArgs(["review", "--pr", "42", "--post"]).options.post).toBe(
      true,
    );
    expect(parseArgs(["review", "--pr", "42", "--no-post"]).options.post).toBe(
      false,
    );
    expect(() => parseArgs(["review", "--post"])).toThrow(
      "--post publishes the review as a PR comment, so it requires --pr",
    );
  });

  test("W-cli — --full is OFF unless asked for, and review-only", () => {
    expect(parseArgs(["review"]).options.full).toBe(false);
    expect(parseArgs(["review", "--full"]).options.full).toBe(true);
    expect(() => parseArgs(["watch", "--once", "--full"])).toThrow(
      "only applies to the review command",
    );
    expect(() => parseArgs(["status", "--full"])).toThrow(
      "only applies to the review command",
    );
  });

  test("the bare triage verb is retired: only `triage reply` parses", () => {
    expect(() =>
      parseArgs(["triage", "--pr", "42", "--from", "/tmp/run"]),
    ).toThrow("triage reply");
    expect(
      parseArgs([
        "triage",
        "reply",
        "--pr",
        "42",
        "--from",
        "/tmp/run",
        "--finding",
        "F001",
        "--tag",
        "applied",
        "--body-file",
        "/tmp/body.md",
      ]).options.triage,
    ).toBe("reply");
  });

  test("--adjudicate is OFF unless asked for, and needs --pr", () => {
    expect(parseArgs(["review", "--pr", "7"]).options.adjudicate).toBeFalsy();
    expect(
      parseArgs(["review", "--pr", "7", "--ci", "--adjudicate"]).options
        .adjudicate,
    ).toBe(true);
    expect(() => parseArgs(["review", "--adjudicate"])).toThrow(
      "--adjudicate runs the CI adjudicator against a PR, so it requires --pr",
    );
  });

  test("--adjudicate requires review --ci, not just --pr", () => {
    expect(() => parseArgs(["review", "--pr", "1", "--adjudicate"])).toThrow(
      "--adjudicate only applies with review --ci",
    );
    expect(
      parseArgs(["review", "--pr", "1", "--ci", "--adjudicate"]).options
        .adjudicate,
    ).toBe(true);
  });

  test("--adjudicate is documented in the help text next to --full", () => {
    expect(HELP_TEXT).toContain("--adjudicate        with --pr --ci:");
  });

  test("--scout-model without --scout is a loud no-op, not a quiet one", () => {
    expect(() => parseArgs(["review", "--scout-model", "haiku"])).toThrow(
      "requires --scout",
    );
  });

  test("the scout flags belong to review and nothing else", () => {
    // The watcher spawns `review --pr <n> --yes` and never learns these
    // exist; a scout flag on any other verb is an operator believing they
    // changed a run they did not.
    expect(() => parseArgs(["watch", "--once", "--scout"])).toThrow(
      "only apply to the review command",
    );
    expect(() =>
      parseArgs(["status", "--scout", "--scout-model", "haiku"]),
    ).toThrow("only apply to the review command");
  });

  test("the config file admits scout and post boolean keys", () => {
    expect(parseLocalConfig('{"scout": true, "post": false}')).toEqual({
      scout: true,
      post: false,
    });
    expect(() => parseLocalConfig('{"scout":{"enabled":true}}')).toThrow(
      "scout must be a boolean",
    );
  });

  test("--scout-model never swallows the following flag", () => {
    expect(() =>
      parseArgs(["review", "--scout", "--scout-model", "--yes"]),
    ).toThrow("--scout-model needs a value");
  });

  test("--help wins wherever it appears", () => {
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["review", "--repo", "/tmp", "--help"]).command).toBe(
      "help",
    );
  });

  // A value flag that swallows the next FLAG is how you end up reviewing the
  // wrong tree while the plan output looks plausible.
  test("a value flag never swallows the following flag", () => {
    expect(() => parseArgs(["review", "--base", "--head", "x"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--agents"])).toThrow(CliUsageError);
  });

  test("rejects unknown options, unknown commands and no command", () => {
    expect(() => parseArgs(["review", "--nope"])).toThrow(CliUsageError);
    expect(() => parseArgs(["audit"])).toThrow(CliUsageError);
    expect(() => parseArgs([])).toThrow(CliUsageError);
    expect(() => parseArgs(["review", "extra"])).toThrow(CliUsageError);
  });

  test("--hop-budget must be a positive integer", () => {
    expect(() => parseArgs(["review", "--hop-budget", "0"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--hop-budget", "2.5"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--hop-budget", "many"])).toThrow(
      CliUsageError,
    );
  });

  // --force answers "is this diff too big to be worth its cost"; --yes
  // answers "do you want to spend this". One flag must never skip two
  // gates, so this is asserted rather than left to reading.
  test("--force does NOT imply --yes", () => {
    const { options } = parseArgs(["review", "--force"]);
    expect(options.force).toBe(true);
    expect(options.yes).toBe(false);
  });

  test("--yes does not imply --force either", () => {
    const { options } = parseArgs(["review", "--yes"]);
    expect(options.yes).toBe(true);
    expect(options.force).toBe(false);
  });

  test("the size-gate limits parse, and 0 survives as 0", () => {
    const { options } = parseArgs([
      "review",
      "--max-changed-lines",
      "800",
      "--max-changed-files",
      "0",
    ]);
    expect(options.maxChangedLines).toBe(800);
    // 0 DISABLES the limit — it must not be confused with "unset".
    expect(options.maxChangedFiles).toBe(0);
  });

  test("the size-gate limits reject negatives and non-integers", () => {
    for (const value of ["-1", "2.5", "many"]) {
      expect(() => parseArgs(["review", "--max-changed-lines", value])).toThrow(
        CliUsageError,
      );
      expect(() => parseArgs(["review", "--max-changed-files", value])).toThrow(
        CliUsageError,
      );
    }
  });

  test("the size-gate limits need a value and never swallow a flag", () => {
    expect(() => parseArgs(["review", "--max-changed-lines"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--max-changed-lines", "--yes"])).toThrow(
      CliUsageError,
    );
  });
});

describe("parseRemoteHead", () => {
  test("strips the remote prefix", () => {
    expect(parseRemoteHead("refs/remotes/origin/dev\n")).toBe("dev");
    expect(parseRemoteHead("refs/remotes/origin/release/2026-08")).toBe(
      "release/2026-08",
    );
  });

  // A repo whose origin/HEAD was never set answers with nothing, and
  // `symbolic-ref --quiet` exits 1. That is a normal local-only clone, not an
  // error — so it must come back as "no remote head", never as a ref.
  test("anything that is not that shape is no remote head", () => {
    expect(parseRemoteHead("")).toBeUndefined();
    expect(parseRemoteHead("refs/remotes/origin/")).toBeUndefined();
    expect(parseRemoteHead("refs/heads/dev")).toBeUndefined();
    expect(parseRemoteHead("refs/remotes/upstream/main")).toBeUndefined();
  });
});

// The terminal's clickable links stand or fall on this parser, and the whole
// point of deriving the url from the remote (instead of a `gh` call) is that it
// costs nothing on a run without --post. A silent miss here is a run with no
// links at all, so every shape a real github remote takes is pinned.
describe("repoWebUrlFromRemote", () => {
  test("ssh, https and ssh:// all normalise to the same canonical url", () => {
    const canonical = "https://github.com/musive/pr-hero";
    for (const remote of [
      "git@github.com:musive/pr-hero.git",
      "git@github.com:musive/pr-hero",
      "https://github.com/musive/pr-hero.git",
      "https://github.com/musive/pr-hero",
      "https://github.com/musive/pr-hero/",
      "ssh://git@github.com/musive/pr-hero.git",
      "  https://github.com/musive/pr-hero.git\n",
    ]) {
      expect(repoWebUrlFromRemote(remote)).toBe(canonical);
    }
  });

  // A guessed url is strictly worse than none: one 404 teaches the reader to
  // stop trusting every link in the block.
  test("anything not a github repo remote yields NO url, never a guess", () => {
    for (const remote of [
      "",
      "   ",
      "git@gitlab.com:musive/pr-hero.git",
      "https://gitlab.com/musive/pr-hero.git",
      "git@github.example.com:musive/pr-hero.git",
      "https://github.com/musive",
      "https://github.com/",
      "/srv/git/pr-hero.git",
      "not a url at all",
    ]) {
      expect(repoWebUrlFromRemote(remote)).toBeUndefined();
    }
  });

  test("the host check is case-insensitive, the slug is left alone", () => {
    expect(repoWebUrlFromRemote("git@GitHub.com:Musive/PR-Hero.git")).toBe(
      "https://github.com/Musive/PR-Hero",
    );
  });
});

describe("resolveBaseRef", () => {
  test("the flag wins over everything", () => {
    expect(
      resolveBaseRef({
        flag: "release",
        configDefaultBase: "dev",
        remoteHead: "trunk",
      }),
    ).toEqual({ ref: "release", source: "flag" });
  });

  test("then the config, then the remote head", () => {
    expect(
      resolveBaseRef({ configDefaultBase: "dev", remoteHead: "trunk" }),
    ).toEqual({ ref: "dev", source: "config" });
    expect(resolveBaseRef({ remoteHead: "trunk" })).toEqual({
      ref: "trunk",
      source: "remote",
    });
  });

  // "main" is the LAST resort, and it is reported as such: a hardcoded default
  // branch silently reviews the wrong range on any repo that does not use it.
  test("main is the last resort and says so", () => {
    expect(resolveBaseRef({})).toEqual({
      ref: DEFAULT_BASE_REF,
      source: "fallback",
    });
  });

  test("an empty string is not a choice", () => {
    expect(resolveBaseRef({ flag: "", configDefaultBase: "dev" }).ref).toBe(
      "dev",
    );
  });
});

describe("resolveAgentsDirSetting", () => {
  const seat = (
    value: string,
    dir: string,
    layer: "repo" | "global" = "repo",
  ): AgentsDirConfigSeat => ({ value, layer, dir });

  test("the flag wins, resolved against cwd", () => {
    expect(
      resolveAgentsDirSetting({
        flag: "agents",
        config: seat("/from/config", "/repo/.crysk"),
        env: "/from/env",
        cwd: "/work",
      }),
    ).toEqual({ dir: "/work/agents", source: "flag", kind: "dir" });
  });

  // THE point of the key: the config names a prompt set in a sibling repo, so
  // a relative path travels with the CONFIG FILE. Reading it against cwd would
  // make one config mean different prompt sets depending on which
  // subdirectory the developer happened to be standing in.
  test("a relative config path resolves against the config file's dir", () => {
    expect(
      resolveAgentsDirSetting({
        // Two levels up: the config lives in <repo>/.crysk/, so a sibling
        // repo is `../../` from there, not `../`.
        config: seat(
          "../../deep-review/agents/clean",
          "/Users/x/Desktop/musive/.crysk",
        ),
        env: "/from/env",
        cwd: "/somewhere/else",
      }),
    ).toEqual({
      dir: "/Users/x/Desktop/deep-review/agents/clean",
      source: "repo",
      kind: "dir",
    });
  });

  // C5 §3.6: `"config"` is gone, and the two layers report themselves by
  // name — the plan card has to be able to say WHICH file supplied the
  // biggest spend lever in the config.
  test("the source names the layer, not the word config", () => {
    expect(
      resolveAgentsDirSetting({
        config: seat("./prompts", "/Users/x/.crysk", "global"),
        cwd: "/work",
      }),
    ).toEqual({
      dir: "/Users/x/.crysk/prompts",
      source: "global",
      kind: "dir",
    });
  });

  test("an absolute config path is taken as is", () => {
    expect(
      resolveAgentsDirSetting({
        config: seat("/abs/agents", "/repo/.crysk"),
        cwd: "/work",
      }).dir,
    ).toBe("/abs/agents");
  });

  test("the env var is the fallback before the bundled default", () => {
    expect(resolveAgentsDirSetting({ env: "/from/env", cwd: "/work" })).toEqual(
      { dir: "/from/env", source: "env", kind: "dir" },
    );
    expect(resolveAgentsDirSetting({ cwd: "/work" }).source).toBe("default");
  });
});

// Judgment ledger JD-14, confirmed by both judges and left untested by the
// design: the ONE place mergeConfig's source record is load-bearing at
// runtime. A relative `agents_dir` resolves against the directory of the file
// that NAMED it, so the same string in the two layers means two different
// prompt sets — and picking the wrong one either runs hunters nobody chose or
// throws "agents dir does not exist" naming a path in neither file.
describe("agentsDirSeat", () => {
  const paths = {
    repoConfigPath: "/Users/x/Desktop/musive/.crysk/config.json",
    globalConfigPath: "/Users/x/.crysk/config.json",
  };

  test("a global value carries the GLOBAL dir, not the repo's", () => {
    const seat = agentsDirSeat({
      config: { agents_dir: "./prompts" },
      sources: { agents_dir: "global" },
      ...paths,
    });
    expect(seat).toEqual({
      value: "./prompts",
      layer: "global",
      dir: "/Users/x/.crysk",
    });
    // The end-to-end fact the seat exists to protect: resolved, it lands
    // under the operator's home and NOT under the repo's .crysk/.
    expect(resolveAgentsDirSetting({ config: seat, cwd: "/work" })).toEqual({
      dir: "/Users/x/.crysk/prompts",
      source: "global",
      kind: "dir",
    });
  });

  test("a repo value keeps the repo dir", () => {
    const seat = agentsDirSeat({
      config: { agents_dir: "./prompts" },
      sources: { agents_dir: "repo" },
      ...paths,
    });
    expect(seat?.layer).toBe("repo");
    expect(resolveAgentsDirSetting({ config: seat, cwd: "/work" }).dir).toBe(
      "/Users/x/Desktop/musive/.crysk/prompts",
    );
  });

  // Absent means no seat at all, which is what lets the env var and the hard
  // error keep their places at the end of the chain.
  test("no configured value produces no seat", () => {
    expect(
      agentsDirSeat({
        config: {},
        sources: { agents_dir: "default" },
        ...paths,
      }),
    ).toBeUndefined();
  });

  // The whole chain, through the real merge rather than a hand-built record:
  // a quiet repo inherits the person's set, and the moment the team commits
  // one the team wins — with each relative path read against its own file.
  test("the merge decides which dir wins", () => {
    const quiet = mergeConfig({ agents_dir: "./prompts" }, {});
    expect(
      agentsDirSeat({
        config: quiet.effective,
        sources: quiet.sources,
        ...paths,
      })?.dir,
    ).toBe("/Users/x/.crysk");

    const team = mergeConfig(
      { agents_dir: "./prompts" },
      { agents_dir: "./prompts" },
    );
    expect(
      agentsDirSeat({
        config: team.effective,
        sources: team.sources,
        ...paths,
      })?.dir,
    ).toBe("/Users/x/Desktop/musive/.crysk");
  });
});

describe("range messages", () => {
  // The already-merged branch is the case the merge-base default was written
  // for, so its message must name that cause rather than leave a human
  // wondering whether the tool broke.
  test("the contained-in-base message names the cause", () => {
    const message = headContainedInBaseMessage("dev", "feature");
    expect(message).toContain("already contained in base");
    expect(message).toContain("--two-dot");
  });

  test("the empty-diff message reflects which range was used", () => {
    expect(emptyDiffMessage("dev", "HEAD", false)).toContain("dev...HEAD");
    expect(emptyDiffMessage("dev", "HEAD", true)).toContain("dev..HEAD");
  });
});

describe("isFullCommitId", () => {
  test("only a full 40-hex id passes", () => {
    expect(isFullCommitId("a".repeat(40))).toBe(true);
    expect(isFullCommitId(`${"a".repeat(40)}\n`)).toBe(true);
    expect(isFullCommitId("a50594a")).toBe(false);
    expect(isFullCommitId("A".repeat(40))).toBe(false);
    expect(isFullCommitId("main")).toBe(false);
    expect(isFullCommitId("")).toBe(false);
  });
});

describe("parseNumstat", () => {
  test("sums insertions and deletions per file", () => {
    const stat = parseNumstat("10\t2\tsrc/a.ts\n0\t7\tsrc/b.ts\n");
    expect(stat).toEqual({ files: 2, insertions: 10, deletions: 9 });
  });

  // A binary file counts as a changed file but contributes no lines; reading
  // its `-` counters as NaN would poison the cost estimate.
  test("a binary file counts as a file with zero lines", () => {
    const stat = parseNumstat("-\t-\tassets/logo.png\n3\t1\tsrc/a.ts\n");
    expect(stat).toEqual({ files: 2, insertions: 3, deletions: 1 });
  });

  test("empty and malformed lines are ignored", () => {
    expect(parseNumstat("")).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
    });
    expect(parseNumstat("\n\ngarbage\n")).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
    });
  });
});

describe("parseNumstatFiles", () => {
  test("keeps the path beside the per-file counters", () => {
    expect(parseNumstatFiles("10\t2\tsrc/a.ts\n0\t7\tsrc/b.ts\n")).toEqual([
      { path: "src/a.ts", insertions: 10, deletions: 2, binary: false },
      { path: "src/b.ts", insertions: 0, deletions: 7, binary: false },
    ]);
  });

  test("a binary file is flagged, counted as a file, and worth zero lines", () => {
    expect(parseNumstatFiles("-\t-\tassets/logo.png\n")).toEqual([
      {
        path: "assets/logo.png",
        insertions: 0,
        deletions: 0,
        binary: true,
      },
    ]);
  });

  // Renames arrive in two shapes, and BOTH must resolve to the destination:
  // the path is matched against exclusion globs, so `src/{a => b}/x.min.js`
  // matching nothing would silently un-exclude a generated file.
  test("a whole-path rename resolves to the destination", () => {
    expect(
      parseNumstatFiles("4\t4\told/dir/name.ts => new/dir/name.ts\n")[0]?.path,
    ).toBe("new/dir/name.ts");
  });

  test("a braced rename resolves to the destination", () => {
    expect(parseNumstatFiles("4\t4\tsrc/{old => new}/file.ts\n")[0]?.path).toBe(
      "src/new/file.ts",
    );
  });

  // The one-sided braced forms leave an empty segment behind; the doubled
  // separator must be collapsed or no glob will ever match.
  test("one-sided braced renames collapse the empty segment", () => {
    expect(parseNumstatFiles("1\t1\tsrc/{ => sub}/file.ts\n")[0]?.path).toBe(
      "src/sub/file.ts",
    );
    expect(parseNumstatFiles("1\t1\tsrc/{old => }/file.ts\n")[0]?.path).toBe(
      "src/file.ts",
    );
  });

  test("a renamed lockfile is still recognisable as a lockfile", () => {
    expect(parseNumstatFiles("9\t9\t{ => web}/bun.lock\n")[0]?.path).toBe(
      "web/bun.lock",
    );
  });

  // git C-quotes any non-ASCII path by default (`core.quotepath`), and the
  // quotes alone make every exclusion glob miss. Unquoting must happen AFTER
  // rename resolution, because git quotes only the side that needs it.
  test("a C-quoted path is unquoted to its real name", () => {
    expect(
      parseNumstatFiles('1\t0\t"canci\\303\\263n.min.js"\n')[0]?.path,
    ).toBe("canción.min.js");
  });

  test("a whole-path rename unquotes its quoted destination", () => {
    expect(
      parseNumstatFiles('4\t4\ta.min.js => "canci\\303\\263n.min.js"\n')[0]
        ?.path,
    ).toBe("canción.min.js");
  });

  // git abandons the brace form entirely when either side needs quoting, so
  // this branch is never quoted and the unquote is a harmless no-op.
  test("a braced rename is unaffected by the unquoting", () => {
    expect(
      parseNumstatFiles("4\t4\tsrc/{old => nueva}/f.min.js\n")[0]?.path,
    ).toBe("src/nueva/f.min.js");
  });

  test("an ordinary ASCII path is left exactly as it is", () => {
    expect(parseNumstatFiles("3\t1\tsrc/a.min.js\n")[0]?.path).toBe(
      "src/a.min.js",
    );
  });

  test("blank and malformed lines are ignored", () => {
    expect(parseNumstatFiles("")).toEqual([]);
    expect(parseNumstatFiles("\n\ngarbage\n")).toEqual([]);
  });

  // The aggregate is a pure sum over this, so the two can never disagree.
  test("parseNumstat is the sum of parseNumstatFiles", () => {
    const raw = "10\t2\tsrc/a.ts\n-\t-\tlogo.png\n0\t7\tsrc/{a => b}/c.ts\n";
    const files = parseNumstatFiles(raw);
    expect(parseNumstat(raw)).toEqual({
      files: files.length,
      insertions: files.reduce((n, f) => n + f.insertions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    });
  });
});

describe("run dir naming", () => {
  test("candidates are numbered from the short sha", () => {
    const root = "/Users/x/Desktop/musive-prhero-runs";
    expect(runDirCandidate(root, "a".repeat(40), 1)).toBe(`${root}/aaaaaaaa-1`);
    expect(runDirCandidate(root, "a".repeat(40), 2)).toBe(`${root}/aaaaaaaa-2`);
  });

  // Artifacts inside the reviewed tree show up in the hunters' own Grep
  // results — a review that reads its own prompts is contaminated.
  test("a run dir inside the repo is rejected", () => {
    expect(() => assertOutsideRepo("/repo/runs", "/repo")).toThrow(
      CliUsageError,
    );
    expect(() => assertOutsideRepo("/repo", "/repo")).toThrow(CliUsageError);
    expect(() => assertOutsideRepo("/repo/.crysk/x", "/repo")).toThrow(
      CliUsageError,
    );
  });

  test("a sibling run dir is accepted", () => {
    expect(() =>
      assertOutsideRepo("/repo-prhero-runs/x", "/repo"),
    ).not.toThrow();
    expect(() => assertOutsideRepo("/tmp/runs", "/repo")).not.toThrow();
  });
});

describe("assertBasenameOnly", () => {
  test("plain basenames pass", () => {
    expect(() =>
      assertBasenameOnly("deep-review-reliability.md", 0),
    ).not.toThrow();
  });

  test("anything that could escape agentsDir throws", () => {
    for (const file of [
      "../evil.md",
      "nested/agent.md",
      "/etc/passwd",
      "a\\b.md",
    ]) {
      expect(() => assertBasenameOnly(file, 0)).toThrow(CliUsageError);
    }
  });
});

describe("agentsDirProblems", () => {
  const CLEAN_SET = [
    "deep-review-lifecycle.md",
    "deep-review-logic.md",
    "deep-review-parity.md",
    "deep-review-reliability.md",
    "deep-review-resilience.md",
    "review-refuter.md",
  ];

  test("a matching set has no problems", () => {
    expect(agentsDirProblems(CLEAN_SET, CLEAN_SET)).toEqual([]);
  });

  test("a file the spec names but the dir lacks is reported", () => {
    const problems = agentsDirProblems(
      CLEAN_SET,
      CLEAN_SET.filter((f) => f !== "deep-review-parity.md"),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("deep-review-parity.md");
  });

  // THE check: the default 4-agent spec against the 5-file clean set silently
  // drops the lifecycle hunter, and nothing downstream notices.
  test("an unreferenced agent file in the dir is reported", () => {
    const fourAgentSpec = CLEAN_SET.filter(
      (f) => f !== "deep-review-lifecycle.md",
    );
    const problems = agentsDirProblems(fourAgentSpec, CLEAN_SET);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("deep-review-lifecycle.md");
    expect(problems[0]).toContain("would never run");
  });

  test("problems are sorted, so the message is deterministic", () => {
    const problems = agentsDirProblems(["b.md", "a.md"], ["c.md"]);
    expect(problems).toEqual([...problems].sort());
    expect(problems).toHaveLength(3);
  });
});

describe("localReviewSpec", () => {
  test("is valid and carries the lifecycle and logic hunters the default spec omits", () => {
    const spec = validateReviewSpec(localReviewSpec());
    const keys = spec.agents.map((a) => a.key);
    expect(keys).toEqual([
      "reliability",
      "resilience",
      "lifecycle",
      "logic",
      "parity",
      "refuter",
    ]);
    expect(spec.agents.find((a) => a.key === "parity")?.trigger).toBe("input");
    expect(spec.agents.filter((a) => a.role === "refuter")).toHaveLength(1);
  });

  test("every agent file is a plain basename", () => {
    for (const [i, agent] of localReviewSpec().agents.entries()) {
      expect(() => assertBasenameOnly(agent.file, i)).not.toThrow();
    }
  });

  // T3 (odd/tasks/logic-hunter.md): PRHERO_EXTRA_HUNTERS is a benchmark-only
  // experiment modifier, inert when unset. Byte-identical to the literal
  // production wiring above is the invariant that keeps every other caller
  // (run.ts, doctor.ts, the scripts) unaffected by this task.
  test("is byte-identical to today's wiring when PRHERO_EXTRA_HUNTERS is unset", () => {
    expect(localReviewSpec({})).toEqual({
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
        },
        {
          key: "resilience",
          file: "deep-review-resilience.md",
          role: "hunter",
        },
        { key: "lifecycle", file: "deep-review-lifecycle.md", role: "hunter" },
        { key: "logic", file: "deep-review-logic.md", role: "hunter" },
        {
          key: "parity",
          file: "deep-review-parity.md",
          role: "hunter",
          trigger: "input",
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
  });

  test("is byte-identical to today's wiring when PRHERO_EXTRA_HUNTERS is empty", () => {
    expect(localReviewSpec({ PRHERO_EXTRA_HUNTERS: "" })).toEqual(
      localReviewSpec({}),
    );
  });

  test("appends one extra hunter before the refuter when PRHERO_EXTRA_HUNTERS names one", () => {
    const spec = localReviewSpec({
      PRHERO_EXTRA_HUNTERS: "reliability-b:deep-review-reliability.md",
    });
    const keys = spec.agents.map((a) => a.key);
    expect(keys).toEqual([
      "reliability",
      "resilience",
      "lifecycle",
      "logic",
      "parity",
      "reliability-b",
      "refuter",
    ]);
    expect(spec.agents.find((a) => a.key === "reliability-b")).toEqual({
      key: "reliability-b",
      file: "deep-review-reliability.md",
      role: "hunter",
    });
    expect(() => validateReviewSpec(spec)).not.toThrow();
  });

  test("appends every extra hunter in order for a comma-separated list", () => {
    const spec = localReviewSpec({
      PRHERO_EXTRA_HUNTERS:
        "reliability-b:deep-review-reliability.md,resilience-b:deep-review-resilience.md",
    });
    const keys = spec.agents.map((a) => a.key);
    expect(keys).toEqual([
      "reliability",
      "resilience",
      "lifecycle",
      "logic",
      "parity",
      "reliability-b",
      "resilience-b",
      "refuter",
    ]);
    expect(spec.agents.find((a) => a.key === "reliability-b")).toEqual({
      key: "reliability-b",
      file: "deep-review-reliability.md",
      role: "hunter",
    });
    expect(() => validateReviewSpec(spec)).not.toThrow();
  });

  test("tolerates surrounding whitespace in the env value", () => {
    const spec = localReviewSpec({
      PRHERO_EXTRA_HUNTERS: " reliability-b : deep-review-reliability.md ",
    });
    expect(spec.agents.find((a) => a.key === "reliability-b")).toEqual({
      key: "reliability-b",
      file: "deep-review-reliability.md",
      role: "hunter",
    });
  });

  test("reads CRYSK_EXTRA_HUNTERS before the legacy name", () => {
    const spec = localReviewSpec({
      CRYSK_EXTRA_HUNTERS: "reliability-b:deep-review-reliability.md",
      PRHERO_EXTRA_HUNTERS: "logic-b:deep-review-logic.md",
    });
    const keys = spec.agents.map((agent) => agent.key);
    expect(keys).toContain("reliability-b");
    expect(keys).not.toContain("logic-b");
  });

  test("names the variable it actually read in a parse error", () => {
    expect(() => localReviewSpec({ CRYSK_EXTRA_HUNTERS: "logic" })).toThrow(
      'CRYSK_EXTRA_HUNTERS[0] must be "key:file.md"',
    );
    expect(() => localReviewSpec({ PRHERO_EXTRA_HUNTERS: "logic" })).toThrow(
      'PRHERO_EXTRA_HUNTERS[0] must be "key:file.md"',
    );
  });

  test("rejects a trailing comma (fail loud, never silently ignore)", () => {
    expect(() =>
      localReviewSpec({
        PRHERO_EXTRA_HUNTERS: "logic:deep-review-logic.md,",
      }),
    ).toThrow(CliUsageError);
  });

  test("rejects a malformed entry with no colon", () => {
    expect(() => localReviewSpec({ PRHERO_EXTRA_HUNTERS: "logic" })).toThrow(
      CliUsageError,
    );
  });

  test("rejects an entry with an unsafe key", () => {
    expect(() =>
      localReviewSpec({ PRHERO_EXTRA_HUNTERS: "Logic:deep-review-logic.md" }),
    ).toThrow(CliUsageError);
  });

  test("rejects an entry whose file is not a .md basename", () => {
    expect(() =>
      localReviewSpec({ PRHERO_EXTRA_HUNTERS: "logic:deep-review-logic.txt" }),
    ).toThrow(CliUsageError);
  });

  test("rejects an entry whose file escapes the agents dir", () => {
    expect(() =>
      localReviewSpec({
        PRHERO_EXTRA_HUNTERS: "logic:../deep-review-logic.md",
      }),
    ).toThrow(CliUsageError);
  });

  test("rejects an entry with an empty key", () => {
    expect(() =>
      localReviewSpec({ PRHERO_EXTRA_HUNTERS: ":deep-review-logic.md" }),
    ).toThrow(CliUsageError);
  });
});

describe("parseLocalConfig", () => {
  // Re-pointed for C5, and the change of contract is the whole point: this
  // used to assert `{ parity_trigger_paths: [], suspicion_priors: [] }`. A
  // materialised `[]` cannot be told apart from a file that really said `[]`,
  // so the merge downstream reported `repo` for a key no repo ever named. An
  // absent key is now ABSENT, and `[]` is materialised once, by mergeConfig.
  test("an absent key is absent, not empty", () => {
    expect(parseLocalConfig("{}")).toEqual({});
    expect(parseLocalConfig('{"default_base":"dev"}')).toEqual({
      default_base: "dev",
    });
    expect(parseLocalConfig('{"parity_trigger_paths":[]}')).toEqual({
      parity_trigger_paths: [],
    });
  });

  test("reads a full config", () => {
    const config = parseLocalConfig(
      JSON.stringify({
        parity_trigger_paths: ["**/Auth*"],
        suspicion_priors: [
          { path: "src/a.ts", weight: "high", reason: "touched" },
          { path: "src/b.ts", weight: 3, reason: "hot" },
        ],
      }),
    );
    expect(config.parity_trigger_paths).toEqual(["**/Auth*"]);
    expect(config.suspicion_priors).toHaveLength(2);
  });

  test("agents_dir and default_base are read when present", () => {
    const config = parseLocalConfig(
      JSON.stringify({
        agents_dir: "../deep-review/agents/clean",
        default_base: "dev",
      }),
    );
    expect(config.agents_dir).toBe("../deep-review/agents/clean");
    expect(config.default_base).toBe("dev");
  });

  test("both new keys are optional", () => {
    const config = parseLocalConfig("{}");
    expect(config.agents_dir).toBeUndefined();
    expect(config.default_base).toBeUndefined();
  });

  // Same discipline as the array keys: a wrong-typed or blank value read as
  // "absent" is how a config silently stops configuring anything.
  test("a malformed agents_dir or default_base throws", () => {
    expect(() => parseLocalConfig('{"agents_dir": 3}')).toThrow(CliUsageError);
    expect(() => parseLocalConfig('{"agents_dir": "  "}')).toThrow(
      CliUsageError,
    );
    expect(() => parseLocalConfig('{"default_base": ""}')).toThrow(
      CliUsageError,
    );
  });

  // A typo'd key read as "no triggers" is exactly how the parity hunter stops
  // firing without anyone noticing.
  test("malformed shapes throw instead of degrading silently", () => {
    expect(() => parseLocalConfig("not json")).toThrow(CliUsageError);
    expect(() => parseLocalConfig("[]")).toThrow(CliUsageError);
    expect(() =>
      parseLocalConfig('{"parity_trigger_paths": "**/Auth*"}'),
    ).toThrow(CliUsageError);
    expect(() => parseLocalConfig('{"parity_trigger_paths": [""]}')).toThrow(
      CliUsageError,
    );
    expect(() => parseLocalConfig('{"suspicion_priors": [{}]}')).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseLocalConfig('{"suspicion_priors": [{"path":"a","weight":1}]}'),
    ).toThrow(CliUsageError);
  });

  test("summary settings are optional and preserve supplied values", () => {
    expect(parseLocalConfig('{"summary": {}}').summary).toEqual({});
    expect(
      parseLocalConfig(
        JSON.stringify({ summary: { enabled: false, model: "opus" } }),
      ).summary,
    ).toEqual({ enabled: false, model: "opus" });
  });

  test("summary validation is strict, including typos", () => {
    for (const raw of [
      '{"summary": null}',
      '{"summary": []}',
      '{"summary": {"enabled": "false"}}',
      '{"summary": {"model": "  "}}',
      '{"summry": {"enabled": false}}',
      '{"summary": {"enabeld": false}}',
    ]) {
      expect(() => parseLocalConfig(raw)).toThrow(CliUsageError);
    }
  });

  test("summary activation resolves flag over config over default-on", () => {
    const config = parseLocalConfig(
      JSON.stringify({ summary: { enabled: false, model: "opus" } }),
    );
    expect(resolveSummary({}, parseLocalConfig("{}")).enabled).toBe(true);
    expect(resolveSummary({}, config)).toEqual({
      enabled: false,
      model: "opus",
    });
    expect(resolveSummary({ summary: true }, config)).toEqual({
      enabled: true,
      model: "opus",
    });
    expect(resolveSummary({ summary: false }, config)).toEqual({
      enabled: false,
      model: "opus",
    });
    expect(resolveSummary({ model: "sonnet" }, config)).toEqual({
      enabled: false,
      model: "sonnet",
    });
  });

  test("max_verification_steps is optional; absent resolves to the default", () => {
    expect(parseLocalConfig("{}").max_verification_steps).toBeUndefined();
    expect(resolveMaxVerificationSteps(parseLocalConfig("{}"))).toBe(
      DEFAULT_MAX_VERIFICATION_STEPS,
    );
    expect(
      parseLocalConfig('{"max_verification_steps": 3}').max_verification_steps,
    ).toBe(3);
    expect(
      resolveMaxVerificationSteps(
        parseLocalConfig('{"max_verification_steps": 0}'),
      ),
    ).toBe(0);
    expect(() => parseLocalConfig('{"max_verification_steps": -1}')).toThrow(
      CliUsageError,
    );
    expect(() => parseLocalConfig('{"max_verification_steps": 1.5}')).toThrow(
      CliUsageError,
    );
  });

  test("max_concurrent_steps is optional; absent means unlimited, only positive integers are admitted", () => {
    expect(parseLocalConfig("{}").max_concurrent_steps).toBeUndefined();
    expect(resolveMaxConcurrentSteps(parseLocalConfig("{}"))).toBeUndefined();
    expect(
      resolveMaxConcurrentSteps(
        parseLocalConfig('{"max_concurrent_steps": 4}'),
      ),
    ).toBe(4);
    expect(() => parseLocalConfig('{"max_concurrent_steps": 0}')).toThrow(
      "max_concurrent_steps must be a positive integer",
    );
    expect(() => parseLocalConfig('{"max_concurrent_steps": 1.5}')).toThrow(
      CliUsageError,
    );
  });

  test("max_changed_lines and max_changed_files are optional in local and global configs", () => {
    expect(parseLocalConfig("{}").max_changed_lines).toBeUndefined();
    expect(parseLocalConfig("{}").max_changed_files).toBeUndefined();
    expect(parseGlobalConfig("{}").max_changed_lines).toBeUndefined();
    expect(parseGlobalConfig("{}").max_changed_files).toBeUndefined();

    const parsedLocal = parseLocalConfig(
      '{"max_changed_lines": 2000, "max_changed_files": 50}',
    );
    expect(parsedLocal.max_changed_lines).toBe(2000);
    expect(parsedLocal.max_changed_files).toBe(50);

    const parsedGlobal = parseGlobalConfig(
      '{"max_changed_lines": 3000, "max_changed_files": 100}',
    );
    expect(parsedGlobal.max_changed_lines).toBe(3000);
    expect(parsedGlobal.max_changed_files).toBe(100);

    expect(() => parseLocalConfig('{"max_changed_lines": -1}')).toThrow(
      CliUsageError,
    );
    expect(() => parseLocalConfig('{"max_changed_files": "50"}')).toThrow(
      CliUsageError,
    );
    expect(() => parseGlobalConfig('{"max_changed_lines": 1.5}')).toThrow(
      CliUsageError,
    );
  });
});

describe("resolveScout & resolvePost", () => {
  test("resolveScout precedence: CLI flag > Merged Config > Default false", () => {
    expect(resolveScout({ scout: true }, { scout: false })).toBe(true);
    expect(resolveScout({ scout: false }, { scout: true })).toBe(false);
    expect(resolveScout({}, { scout: true })).toBe(true);
    expect(resolveScout({}, { scout: false })).toBe(false);
    expect(resolveScout({}, {})).toBe(false);
  });

  test("resolvePost precedence: CLI flag > Merged Config > Default false", () => {
    expect(resolvePost({ post: true }, { post: false })).toBe(true);
    expect(resolvePost({ post: false }, { post: true })).toBe(false);
    expect(resolvePost({}, { post: true })).toBe(true);
    expect(resolvePost({}, { post: false })).toBe(false);
    expect(resolvePost({}, {})).toBe(false);
  });
});

// The exact message a rejection produced. `toThrow(string)` matches a
// SUBSTRING, and `.crysk/config.json …` is a substring of
// `~/.crysk/config.json …` — so substring matching cannot tell the two files
// apart, which is precisely the confusion these tests exist to catch.
function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a rejection, got none");
}

// The six keys the parser admitted before C5, written out rather than derived,
// so a future narrowing of the team file's surface has to be deliberate.
const PRE_C5_LOCAL_KEYS = [
  "agents_dir",
  "ci_admission_observe_only",
  "ci_advisory_weight",
  "ci_blocking_weight",
  "ci_max_attempts",
  "ci_max_reviews",
  "ci_rereview_min_score",
  "ci_review_policy",
  "ci_trusted_actors",
  "default_base",
  "max_changed_files",
  "max_changed_lines",
  "max_concurrent_steps",
  "max_verification_steps",
  "parity_trigger_paths",
  "post",
  "scout",
  "summary",
  "suspicion_priors",
];

describe("CONFIG_DIRECTION", () => {
  // The type-level guard is the `Record` — an undeclared key does not compile.
  // This is its runtime witness, and it is only a witness at all because the
  // fixture is typed `Required<LocalConfig>`: tsc forces it to name every
  // member, so it cannot quietly omit the one key the table also forgot.
  test("covers every LocalConfig key, and every SummaryConfig field", () => {
    const populated: Required<LocalConfig> = {
      agents_dir: "/tmp/agents",
      default_base: "dev",
      parity_trigger_paths: ["**/Auth*"],
      suspicion_priors: [{ path: "a.ts", weight: "high", reason: "hot" }],
      summary: { enabled: false, model: "opus" },
      routing: { mappings: [] },
      max_verification_steps: 3,
      max_concurrent_steps: 4,
      max_changed_lines: 1500,
      max_changed_files: 150,
      scout: false,
      post: false,
      ci_review_policy: "risk_aware",
      ci_max_attempts: 2,
      ci_max_reviews: 2,
      ci_rereview_min_score: 4,
      ci_blocking_weight: 2,
      ci_advisory_weight: 1,
      ci_trusted_actors: ["pr-hero[bot]"],
      ci_admission_observe_only: false,
    };
    expect(Object.keys(CONFIG_DIRECTION).sort()).toEqual(
      Object.keys(populated).sort(),
    );
    for (const key of Object.keys(populated)) {
      expect(CONFIG_DIRECTION[key as keyof LocalConfig]).toBeString();
    }

    const summary: Required<SummaryConfig> = { enabled: true, model: "opus" };
    expect(Object.keys(SUMMARY_DIRECTION).sort()).toEqual(
      Object.keys(summary).sort(),
    );
  });

  // The directions themselves are the decision, not an implementation detail:
  // getting `default_base` wrong reviews the wrong commit range, and getting a
  // `capped` row wrong lets a committed file raise the operator's bill.
  test("declares the ratified direction for each key", () => {
    expect(CONFIG_DIRECTION).toEqual({
      agents_dir: "person",
      default_base: "repo",
      parity_trigger_paths: "repo",
      suspicion_priors: "repo",
      summary: "capped",
      routing: "person",
      max_verification_steps: "capped",
      max_concurrent_steps: "capped",
      max_changed_lines: "capped",
      max_changed_files: "capped",
      scout: "capped",
      post: "capped",
      ci_review_policy: "repo",
      ci_max_attempts: "repo",
      ci_max_reviews: "repo",
      ci_rereview_min_score: "repo",
      ci_blocking_weight: "repo",
      ci_advisory_weight: "repo",
      ci_trusted_actors: "repo",
      ci_admission_observe_only: "repo",
    });
    expect(SUMMARY_DIRECTION).toEqual({ enabled: "capped", model: "person" });
  });
});

describe("parseGlobalConfig", () => {
  // One case per `repo` key, so the table covers all three. The message is
  // templated over the OFFENDING key: a fixed example would send two operators
  // out of three looking for the wrong line.
  test("rejects a repo key and names the repo file", () => {
    const cases: [string, unknown][] = [
      ["default_base", "dev"],
      ["parity_trigger_paths", ["**/Auth*"]],
      ["suspicion_priors", []],
    ];
    for (const [key, value] of cases) {
      const raw = JSON.stringify({ [key]: value });
      expect(() => parseGlobalConfig(raw)).toThrow(CliUsageError);
      expect(messageOf(() => parseGlobalConfig(raw))).toBe(
        `~/.crysk/config.json: ${key} is a per-repo key — ` +
          "put it in the repo config (<repo>/.crysk/config.json, or " +
          "<repo>/.prhero/config.json in a repo set up before the rename)",
      );
    }
  });

  test("admits every person and capped key", () => {
    const admitted = {
      agents_dir: "/tmp/agents",
      summary: { enabled: false, model: "opus" },
      max_verification_steps: 2,
      scout: false,
      post: true,
    };
    expect(parseGlobalConfig(JSON.stringify(admitted))).toEqual(admitted);
    expect(parseGlobalConfig("{}")).toEqual({});
  });

  test("an unknown key is fatal there too", () => {
    expect(messageOf(() => parseGlobalConfig('{"unknown_key": {}}'))).toBe(
      "~/.crysk/config.json unknown key: unknown_key",
    );
  });

  // Judgment ledger JD-6: the validators are SHARED, and they used to hardcode
  // the repo file's name — so a malformed global file sent the operator to
  // edit a file that was fine. Every reachable rejection now names the file it
  // is actually in.
  test("every rejection names the file it is actually in", () => {
    expect(
      messageOf(() => parseGlobalConfig("nope")).startsWith(
        "~/.crysk/config.json is not valid JSON:",
      ),
    ).toBe(true);
    const cases: [string, string][] = [
      ["[]", "must be a JSON object"],
      ['{"agents_dir": 3}', "agents_dir must be a non-empty string"],
      ['{"summary": []}', "summary must be an object"],
      ['{"summary": {"enabeld": false}}', "summary unknown key: enabeld"],
      ['{"summary": {"enabled": "no"}}', "summary.enabled must be a boolean"],
      [
        '{"summary": {"model": "  "}}',
        "summary.model must be a non-empty string",
      ],
      [
        '{"max_verification_steps": -1}',
        "max_verification_steps must be a non-negative integer",
      ],
      ['{"scout": "yes"}', "scout must be a boolean"],
      ['{"post": 1}', "post must be a boolean"],
    ];
    for (const [raw, tail] of cases) {
      expect(messageOf(() => parseGlobalConfig(raw))).toBe(
        `~/.crysk/config.json ${tail}`,
      );
      // The repo file's own text is byte-identical to what it was before C5 —
      // exact equality, because substring matching cannot tell `~/x` from `x`.
      expect(messageOf(() => parseLocalConfig(raw))).toBe(
        `.crysk/config.json ${tail}`,
      );
    }
  });
});

describe("parseLocalConfig admits the same keys it does today", () => {
  test("the admitted key set is unchanged, summary.model included", () => {
    expect(
      Object.keys(CONFIG_DIRECTION)
        .filter((k) => k !== "routing")
        .sort(),
    ).toEqual(PRE_C5_LOCAL_KEYS);
    const full = {
      agents_dir: "/tmp/agents",
      default_base: "dev",
      parity_trigger_paths: ["**/Auth*"],
      suspicion_priors: [{ path: "a.ts", weight: 3, reason: "hot" }],
      summary: { enabled: false, model: "opus" },
      max_verification_steps: 3,
      scout: true,
      post: false,
    };
    expect(parseLocalConfig(JSON.stringify(full))).toEqual(full);
    for (const key of PRE_C5_LOCAL_KEYS) {
      const one = { [key]: (full as Record<string, unknown>)[key] };
      expect(() => parseLocalConfig(JSON.stringify(one))).not.toThrow();
    }
  });

  test("rejects routing key in repo config as a per-person key", () => {
    const raw = JSON.stringify({ routing: { mappings: [] } });
    expect(() => parseLocalConfig(raw)).toThrow(CliUsageError);
    expect(messageOf(() => parseLocalConfig(raw))).toBe(
      ".crysk/config.json: routing is a per-person key — put it in your person config (~/.crysk/config.json, or ~/.prhero/config.json on an install set up before the rename; do not create ~/.crysk while ~/.prhero is in use)",
    );
  });
});

describe("Task 1.3: D2 Routing in preflight and credential rejection", () => {
  test("parseGlobalConfig admits valid routing object", () => {
    const routingConfig: RoutingConfig = {
      mappings: [
        {
          logical: aliasCanonical("sonnet"),
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "sonnet",
          modelSnapshot: "sonnet",
        },
      ],
      default: {
        backend: "opencode",
        provider: "openrouter",
        gateway: "openrouter",
        modelFamily: "auto",
        modelSnapshot: "auto",
      },
    };
    const parsed = parseGlobalConfig(
      JSON.stringify({ routing: routingConfig }),
    );
    expect(parsed.routing).toEqual(routingConfig);
  });

  test("parseGlobalConfig rejects non-object routing", () => {
    expect(() => parseGlobalConfig('{"routing": "invalid"}')).toThrow(
      CliUsageError,
    );
    expect(messageOf(() => parseGlobalConfig('{"routing": "invalid"}'))).toBe(
      "~/.crysk/config.json routing must be an object",
    );
  });

  test("parseGlobalConfig rejects invalid mapping backend or gateway", () => {
    const badBackend = JSON.stringify({
      routing: {
        mappings: [
          {
            logical: "openai/gpt-4o",
            backend: "bad-backend",
            provider: "openai",
          },
        ],
      },
    });
    expect(() => parseGlobalConfig(badBackend)).toThrow(CliUsageError);
    expect(messageOf(() => parseGlobalConfig(badBackend))).toContain(
      "backend must be claude-code|opencode",
    );

    const badGateway = JSON.stringify({
      routing: {
        mappings: [
          {
            logical: "openai/gpt-4o",
            backend: "opencode",
            provider: "openai",
            gateway: "bad-gateway",
          },
        ],
      },
    });
    expect(() => parseGlobalConfig(badGateway)).toThrow(CliUsageError);
    expect(messageOf(() => parseGlobalConfig(badGateway))).toContain(
      "gateway must be configured|direct|openrouter",
    );
  });

  test("parseGlobalConfig rejects credential keys embedded in routing config", () => {
    const credKeys = [
      "apiKey",
      "api_key",
      "token",
      "secret",
      "password",
      "bearer",
    ];
    for (const key of credKeys) {
      const payload = JSON.stringify({
        routing: {
          mappings: [
            {
              logical: "openai/gpt-4o",
              backend: "opencode",
              provider: "openai",
              [key]: "sk-secret12345678",
            },
          ],
        },
      });
      expect(() => parseGlobalConfig(payload)).toThrow(CliUsageError);
      expect(messageOf(() => parseGlobalConfig(payload))).toContain(
        "credentials are not permitted in routing config",
      );
    }
  });

  test("redacts secrets in error messages from preflight config parsing", () => {
    const secret = "sk-ant-api03-abcdef123456789012345678";
    const raw = JSON.stringify({
      routing: {
        unknown_key_with_secret: secret,
      },
    });
    expect(() => parseGlobalConfig(raw)).toThrow(CliUsageError);
    const msg = messageOf(() => parseGlobalConfig(raw));
    expect(msg).not.toContain(secret);
  });
});

describe("mergeConfig", () => {
  const layer = (value: ConfigLayer): ConfigLayer => value;

  // O-4. `capped` is the spend rule made computable: the team may narrow the
  // operator's ceiling, never widen it. Both orders, either side absent.
  test("narrows capped keys in both directions", () => {
    const steps = (global: number | undefined, repo: number | undefined) =>
      mergeConfig(
        global === undefined
          ? undefined
          : layer({ max_verification_steps: global }),
        repo === undefined ? {} : layer({ max_verification_steps: repo }),
      );

    // The repo narrows itself: min is the repo's own value, so no cap bound.
    expect(steps(8, 3).effective.max_verification_steps).toBe(3);
    expect(steps(8, 3).sources.max_verification_steps).toBe("repo");
    // Repo 0 beats global 8 — 0 is legal and is the pause switch.
    expect(steps(8, 0).effective.max_verification_steps).toBe(0);
    expect(steps(8, 0).sources.max_verification_steps).toBe("repo");
    // The cap BINDS: the repo asked for more than the ceiling allows.
    expect(steps(3, 8).effective.max_verification_steps).toBe(3);
    expect(steps(3, 8).sources.max_verification_steps).toBe("capped");
    expect(steps(0, 8).effective.max_verification_steps).toBe(0);
    expect(steps(0, 8).sources.max_verification_steps).toBe("capped");
    // Either side absent.
    expect(steps(5, undefined).effective.max_verification_steps).toBe(5);
    expect(steps(5, undefined).sources.max_verification_steps).toBe("global");
    expect(steps(undefined, 5).effective.max_verification_steps).toBe(5);
    expect(steps(undefined, 5).sources.max_verification_steps).toBe("repo");
    // Neither: absent from the effective config, so the resolver's own default
    // decides — which is byte-for-byte today's behaviour.
    expect(
      steps(undefined, undefined).effective.max_verification_steps,
    ).toBeUndefined();
    expect(steps(undefined, undefined).sources.max_verification_steps).toBe(
      "default",
    );
    expect(
      resolveMaxVerificationSteps(steps(undefined, undefined).effective),
    ).toBe(DEFAULT_MAX_VERIFICATION_STEPS);
  });

  test("narrows max_changed_lines and max_changed_files with Math.min (capped)", () => {
    const linesMerge = (global?: number, repo?: number) =>
      mergeConfig(
        global === undefined ? undefined : layer({ max_changed_lines: global }),
        repo === undefined ? {} : layer({ max_changed_lines: repo }),
      );

    expect(linesMerge(1500, 1000).effective.max_changed_lines).toBe(1000);
    expect(linesMerge(1500, 1000).sources.max_changed_lines).toBe("repo");
    expect(linesMerge(1000, 2000).effective.max_changed_lines).toBe(1000);
    expect(linesMerge(1000, 2000).sources.max_changed_lines).toBe("capped");
    // Sentinel 0 means 'disabled/infinite' — personal ceiling binds over repo 0
    expect(linesMerge(500, 0).effective.max_changed_lines).toBe(500);
    expect(linesMerge(500, 0).sources.max_changed_lines).toBe("capped");
    expect(linesMerge(0, 500).effective.max_changed_lines).toBe(500);
    expect(linesMerge(0, 500).sources.max_changed_lines).toBe("repo");
    expect(linesMerge(1500, undefined).sources.max_changed_lines).toBe(
      "global",
    );
    expect(linesMerge(undefined, 1500).sources.max_changed_lines).toBe("repo");
    expect(linesMerge(undefined, undefined).sources.max_changed_lines).toBe(
      "default",
    );

    const filesMerge = (global?: number, repo?: number) =>
      mergeConfig(
        global === undefined ? undefined : layer({ max_changed_files: global }),
        repo === undefined ? {} : layer({ max_changed_files: repo }),
      );

    expect(filesMerge(150, 50).effective.max_changed_files).toBe(50);
    expect(filesMerge(150, 50).sources.max_changed_files).toBe("repo");
    expect(filesMerge(50, 200).effective.max_changed_files).toBe(50);
    expect(filesMerge(50, 200).sources.max_changed_files).toBe("capped");
  });

  test("summary.enabled is a boolean AND, all four combinations", () => {
    const enabled = (global?: boolean, repo?: boolean) =>
      mergeConfig(
        global === undefined
          ? undefined
          : layer({ summary: { enabled: global } }),
        repo === undefined ? {} : layer({ summary: { enabled: repo } }),
      );

    expect(enabled(true, true).effective.summary?.enabled).toBe(true);
    expect(enabled(true, true).sources.summary.enabled).toBe("repo");
    // A team turning the roll-up OFF is a narrowing, and it stays legal — it
    // is what every config on disk does today.
    expect(enabled(true, false).effective.summary?.enabled).toBe(false);
    expect(enabled(true, false).sources.summary.enabled).toBe("repo");
    // A team turning it ON over my global `false` is the widening the cap
    // exists to refuse: it would make a normal review's bill differ from the
    // plan without me ever seeing the file that did it.
    expect(enabled(false, true).effective.summary?.enabled).toBe(false);
    expect(enabled(false, true).sources.summary.enabled).toBe("capped");
    expect(enabled(false, false).effective.summary?.enabled).toBe(false);
    expect(enabled(false, false).sources.summary.enabled).toBe("repo");
    // Either side absent.
    expect(enabled(false, undefined).sources.summary.enabled).toBe("global");
    expect(enabled(undefined, false).sources.summary.enabled).toBe("repo");
    expect(enabled(undefined, undefined).sources.summary.enabled).toBe(
      "default",
    );
    expect(enabled(undefined, undefined).effective.summary).toBeUndefined();
  });

  test("scout and post are folded with boolean AND (capped)", () => {
    const mergeBool = (
      key: "scout" | "post",
      global?: boolean,
      repo?: boolean,
    ) =>
      mergeConfig(
        global === undefined ? undefined : layer({ [key]: global }),
        repo === undefined ? {} : layer({ [key]: repo }),
      );

    for (const key of ["scout", "post"] as const) {
      // Both true -> repo true
      const tt = mergeBool(key, true, true);
      expect(tt.effective[key]).toBe(true);
      expect(tt.sources[key]).toBe("repo");

      // Global true, repo false -> repo false
      const tf = mergeBool(key, true, false);
      expect(tf.effective[key]).toBe(false);
      expect(tf.sources[key]).toBe("repo");

      // Global false, repo true -> capped false
      const ft = mergeBool(key, false, true);
      expect(ft.effective[key]).toBe(false);
      expect(ft.sources[key]).toBe("capped");

      // Both false -> repo false
      const ff = mergeBool(key, false, false);
      expect(ff.effective[key]).toBe(false);
      expect(ff.sources[key]).toBe("repo");

      // Global only
      const gTrue = mergeBool(key, true, undefined);
      expect(gTrue.effective[key]).toBe(true);
      expect(gTrue.sources[key]).toBe("global");
      const gFalse = mergeBool(key, false, undefined);
      expect(gFalse.effective[key]).toBe(false);
      expect(gFalse.sources[key]).toBe("global");

      // Repo only
      const rTrue = mergeBool(key, undefined, true);
      expect(rTrue.effective[key]).toBe(true);
      expect(rTrue.sources[key]).toBe("repo");
      const rFalse = mergeBool(key, undefined, false);
      expect(rFalse.effective[key]).toBe(false);
      expect(rFalse.sources[key]).toBe("repo");

      // Unset
      const unset = mergeBool(key, undefined, undefined);
      expect(unset.effective[key]).toBeUndefined();
      expect(unset.sources[key]).toBe("default");
    }
  });

  // Judgment ledger JD-20: two rounds of judgment left the tie case without a
  // defined label. It is `repo` — `capped` has to mean the ceiling actually
  // BOUND, and deleting the global file would change nothing about a value
  // both layers already agree on.
  test("a tie is the more specific layer, not a cap", () => {
    const steps = mergeConfig(
      { max_verification_steps: 8 },
      { max_verification_steps: 8 },
    );
    expect(steps.effective.max_verification_steps).toBe(8);
    expect(steps.sources.max_verification_steps).toBe("repo");

    for (const value of [true, false]) {
      const merged = mergeConfig(
        { summary: { enabled: value } },
        { summary: { enabled: value } },
      );
      expect(merged.effective.summary?.enabled).toBe(value);
      expect(merged.sources.summary.enabled).toBe("repo");
    }
  });

  test("a person key is pure specificity — the team wins", () => {
    const both = mergeConfig(
      { agents_dir: "/global/agents", summary: { model: "haiku" } },
      { agents_dir: "/repo/agents", summary: { model: "opus" } },
    );
    expect(both.effective.agents_dir).toBe("/repo/agents");
    expect(both.sources.agents_dir).toBe("repo");
    expect(both.effective.summary?.model).toBe("opus");
    expect(both.sources.summary.model).toBe("repo");

    const quiet = mergeConfig(
      { agents_dir: "/global/agents", summary: { model: "haiku" } },
      {},
    );
    expect(quiet.effective.agents_dir).toBe("/global/agents");
    expect(quiet.sources.agents_dir).toBe("global");
    expect(quiet.sources.summary.model).toBe("global");
  });

  // The parser rejects a `repo` key in the global file, but the fold does not
  // lean on that: a per-repo key folds only from repo-scoped layers, so the
  // day that guarantee slips the merge still refuses to answer `global` for a
  // value that could never apply anywhere else.
  test("a repo key is never taken from a global layer", () => {
    const merged = mergeConfig(
      { default_base: "main", parity_trigger_paths: ["**/Global*"] },
      { default_base: "dev" },
    );
    expect(merged.effective.default_base).toBe("dev");
    expect(merged.sources.default_base).toBe("repo");
    expect(merged.effective.parity_trigger_paths).toEqual([]);
    expect(merged.sources.parity_trigger_paths).toBe("default");
  });

  test("arrays and the summary block are replaced, never deep-merged", () => {
    const merged = mergeConfig(
      { summary: { enabled: true, model: "haiku" } },
      {
        parity_trigger_paths: ["**/Auth*"],
        suspicion_priors: [{ path: "a.ts", weight: "high", reason: "hot" }],
        summary: { model: "opus" },
      },
    );
    expect(merged.effective.parity_trigger_paths).toEqual(["**/Auth*"]);
    expect(merged.sources.parity_trigger_paths).toBe("repo");
    expect(merged.effective.suspicion_priors).toHaveLength(1);
    // The block is descended into per field, so the global's `enabled`
    // survives a repo block that only names `model`.
    expect(merged.effective.summary).toEqual({ enabled: true, model: "opus" });
    expect(merged.sources.summary).toEqual({
      enabled: "global",
      model: "repo",
    });
  });

  // O-14, and it takes two cases because only the second can detect the
  // residue that killed the first attempt at this change. Case (a) never
  // reaches the parser at all — a missing file is an ABSENT layer — so it
  // passes even against a parser that still materialises the arrays.
  test("absence survives the parsers and reports default", () => {
    const nothing = mergeConfig(undefined, {});
    expect(nothing.sources).toEqual({
      agents_dir: "default",
      default_base: "default",
      parity_trigger_paths: "default",
      suspicion_priors: "default",
      summary: { enabled: "default", model: "default" },
      routing: "default",
      max_verification_steps: "default",
      max_concurrent_steps: "default",
      max_changed_lines: "default",
      max_changed_files: "default",
      scout: "default",
      post: "default",
      ci_review_policy: "default",
      ci_max_attempts: "default",
      ci_max_reviews: "default",
      ci_rereview_min_score: "default",
      ci_blocking_weight: "default",
      ci_advisory_weight: "default",
      ci_trusted_actors: "default",
      ci_admission_observe_only: "default",
    });
    // The resolvers still receive the shape they always received.
    expect(nothing.effective).toEqual(EMPTY_LOCAL_CONFIG);

    // (b) The case that proves the parser stopped materialising: a repo file
    // that EXISTS and omits one array key. Routed through the real parser on
    // purpose — a hand-built `{}` layer would pass either way.
    const present = mergeConfig(
      undefined,
      parseLocalConfig(
        JSON.stringify({ default_base: "dev", suspicion_priors: [] }),
      ),
    );
    expect(present.sources.parity_trigger_paths).toBe("default");
    expect(present.sources.suspicion_priors).toBe("repo");
    expect(present.sources.default_base).toBe("repo");
    expect(present.effective.parity_trigger_paths).toEqual([]);
  });

  // O-5's pure half: with no global layer the effective config is exactly what
  // the repo file said, so every resolver downstream sees today's input.
  test("with no global layer the repo file stands alone", () => {
    const raw = JSON.stringify({
      agents_dir: "/Users/juanma/Desktop/deep-review/agents/clean",
      default_base: "dev",
      parity_trigger_paths: [],
      suspicion_priors: [],
      summary: { enabled: false },
    });
    const { effective, sources } = mergeConfig(
      undefined,
      parseLocalConfig(raw),
    );
    expect(effective).toEqual({
      agents_dir: "/Users/juanma/Desktop/deep-review/agents/clean",
      default_base: "dev",
      parity_trigger_paths: [],
      suspicion_priors: [],
      summary: { enabled: false },
    });
    expect(sources.summary.enabled).toBe("repo");
    expect(sources.summary.model).toBe("default");
    expect(resolveSummary({}, effective)).toEqual({ enabled: false });
    expect(resolveMaxVerificationSteps(effective)).toBe(
      DEFAULT_MAX_VERIFICATION_STEPS,
    );
  });
});

describe("initConfigTemplate", () => {
  // A scaffold its own parser rejects is a bug that only shows up on someone
  // else's machine, on their first ever command.
  test("what init writes round-trips through parseLocalConfig", () => {
    const raw = initConfigTemplate({
      agentsDir: "/Users/x/Desktop/deep-review/agents/clean",
      defaultBase: "dev",
    });
    const config = parseLocalConfig(raw);
    expect(config).toEqual({
      agents_dir: "/Users/x/Desktop/deep-review/agents/clean",
      default_base: "dev",
      summary: { enabled: true, model: DEFAULT_SUMMARY_MODEL },
      parity_trigger_paths: [],
      suspicion_priors: [],
    });
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("the written values are what a review would then resolve", () => {
    const config = parseLocalConfig(
      initConfigTemplate({ agentsDir: "/abs/agents", defaultBase: "trunk" }),
    );
    expect(
      resolveAgentsDirSetting({
        config: {
          value: config.agents_dir as string,
          layer: "repo",
          dir: "/repo/.crysk",
        },
        cwd: "/work",
      }).dir,
    ).toBe("/abs/agents");
    expect(resolveBaseRef({ configDefaultBase: config.default_base })).toEqual({
      ref: "trunk",
      source: "config",
    });
  });

  // C5 O-9 / judgment ledger JD-17. The obligation names `agents_dir`, but the
  // template also seeds `default_base`, `summary.model` and a hardcoded
  // `summary.enabled: true` — and that last one is the value `capped` forbids
  // the team file from raising over a global `false`. The full set is handled,
  // not the key the obligation happens to name.
  test("omits every person/capped key the global layer already supplies", () => {
    const raw = initConfigTemplate({
      agentsDir: "/seed/agents",
      defaultBase: "dev",
      global: {
        agents_dir: "/home/me/agents/clean",
        summary: { enabled: false, model: "haiku" },
      },
    });
    expect(parseLocalConfig(raw)).toEqual({
      // `default_base` SURVIVES: it is a `repo` key (D4), parseGlobalConfig
      // rejects it by name, and a scaffold without it would leave the repo
      // with no base ref at all. The two array keys are `repo` for the same
      // reason.
      default_base: "dev",
      parity_trigger_paths: [],
      suspicion_priors: [],
    });
    // Not `"summary": {}` — an empty block parses fine and configures
    // nothing, which is a line whose only effect is to puzzle the next reader.
    expect(raw).not.toContain("summary");
    expect(raw).not.toContain("agents_dir");
  });

  test("omits only the fields the global actually named", () => {
    // A global that sets the model and nothing else leaves the cap seat to the
    // repo file, so `summary.enabled` still has to be seeded.
    const config = parseLocalConfig(
      initConfigTemplate({
        agentsDir: "/seed/agents",
        defaultBase: "dev",
        global: { summary: { model: "haiku" } },
      }),
    );
    expect(config.summary).toEqual({ enabled: true });
    expect(config.agents_dir).toBe("/seed/agents");
  });

  // The regression boundary: with no global file the bytes are byte-for-byte
  // the pre-C5 template. C5 introduces nothing for the operator who never
  // writes a global config (D6).
  test("with no global layer the template is unchanged", () => {
    const seeds = { agentsDir: "/seed/agents", defaultBase: "dev" };
    expect(initConfigTemplate(seeds)).toBe(
      `${JSON.stringify(
        {
          agents_dir: "/seed/agents",
          default_base: "dev",
          summary: { enabled: true, model: DEFAULT_SUMMARY_MODEL },
          parity_trigger_paths: [],
          suspicion_priors: [],
        },
        null,
        2,
      )}\n`,
    );
    // And an EMPTY global file changes nothing either: a file that exists and
    // says `{}` supplies no key, so there is nothing to leave out.
    expect(initConfigTemplate({ ...seeds, global: {} })).toBe(
      initConfigTemplate(seeds),
    );
  });

  // D5's reasoning one command earlier: a flag is the operator typing an
  // intent. `--agents` at init time is them naming this repo's prompt set, and
  // a flag that parses and then writes nothing is the silently-dropped
  // intention this codebase rejects everywhere else. A deliberate narrowing of
  // O-9's letter, which names no flag exception.
  test("--agents beats the global; PRHERO_AGENTS_DIR does not", () => {
    const global = { agents_dir: "/home/me/agents/clean" };
    const withFlag = parseLocalConfig(
      initConfigTemplate({
        agentsDir: "/flagged/agents",
        defaultBase: "dev",
        global,
        agentsDirFromFlag: true,
      }),
    );
    expect(withFlag.agents_dir).toBe("/flagged/agents");
    // The env var gets no exception: the merged config already beats
    // PRHERO_AGENTS_DIR at review time (judgment ledger JD-9), so writing the
    // env value into the repo file would CHANGE which prompt set runs, not
    // preserve it.
    const withEnvSeed = parseLocalConfig(
      initConfigTemplate({
        agentsDir: "/from/env",
        defaultBase: "dev",
        global,
        agentsDirFromFlag: false,
      }),
    );
    expect(withEnvSeed.agents_dir).toBeUndefined();
  });
});

describe("initTemplateOmissions", () => {
  // The log and the template read the SAME decision. A scaffold that omits a
  // key while the terminal still reports it sends the reader looking for a
  // line that is not in the file they were just told was written.
  test("names the omitted keys as they appear in the config file", () => {
    expect(
      initTemplateOmissions({
        agentsDir: "/seed",
        defaultBase: "dev",
        global: {
          agents_dir: "/home/me/agents",
          summary: { enabled: false, model: "haiku" },
        },
      }).keys,
    ).toEqual(["agents_dir", "summary.enabled", "summary.model"]);
  });

  test("no global file omits nothing", () => {
    expect(
      initTemplateOmissions({ agentsDir: "/seed", defaultBase: "dev" }),
    ).toEqual({
      agentsDir: false,
      summaryEnabled: false,
      summaryModel: false,
      keys: [],
    });
  });
});

describe("allExcludedMessage", () => {
  // The all-excluded case is a "nothing to review" exit, not a review of an
  // empty patch — the message has to make it obvious no money moved.
  test("names the excluded paths and that nothing was spent", () => {
    const message = allExcludedMessage(["bun.lock", "go.sum"]);
    expect(message).toContain("bun.lock, go.sum");
    expect(message).toContain("nothing to review");
    expect(message).toContain("nothing was spent");
  });

  // A `.cryskignore` user rule can exclude anything, not only generated
  // content (lockfiles, minified bundles) — the wording must not claim a
  // reason it cannot know.
  test("does not claim every exclusion is generated content", () => {
    const message = allExcludedMessage(["vendor/thing.ts"]);
    expect(message).not.toContain("generated content");
  });

  test("a long list is truncated rather than dumped", () => {
    const message = allExcludedMessage(
      Array.from({ length: 9 }, (_, i) => `pkg/${i}/bun.lock`),
    );
    expect(message).toContain("+4 more");
    expect(message).not.toContain("pkg/8/bun.lock");
  });
});

// The default exclusions are generated content, but a `.cryskignore` rule
// can drop anything the operator names — the help text must say so, or a
// user who defines their own rules never learns the flag interacts with
// them at all.
describe("HELP_TEXT — --max-changed-lines names .cryskignore", () => {
  test("mentions .cryskignore beside the generated-file examples", () => {
    expect(HELP_TEXT).toContain(".cryskignore");
  });
});

describe("listPaths", () => {
  test("short lists are printed whole", () => {
    expect(listPaths(["a", "b"])).toBe("a, b");
  });

  test("the limit is exact", () => {
    expect(listPaths(["a", "b", "c"], 3)).toBe("a, b, c");
    expect(listPaths(["a", "b", "c", "d"], 3)).toBe("a, b, c, +1 more");
  });
});

// ---------------------------------------------------------------------------
// The gotchas gate — "required and non-empty" was true, and worthless.
//
// Both scaffolds (`pr-hero init`'s GOTCHAS_TEMPLATE and the wizard's fallback)
// write NON-EMPTY placeholder text, so the old `trim().length === 0` gate
// passed them and a review straight after onboarding injected
// `- <subsystem>: <the thing that looks like a bug...>` into every hunter's
// system prompt — a blind review that costs real money and returns a
// clean-looking result. The marker is how a scaffold declares itself
// unfinished; the predicate is the single place that reads it.
// ---------------------------------------------------------------------------

describe("gotchasUnusableReason", () => {
  test("an absent or blank file is 'empty'", () => {
    expect(gotchasUnusableReason("")).toBe("empty");
    expect(gotchasUnusableReason("   \n\t\n  ")).toBe("empty");
  });

  test("the init scaffold is rejected as a placeholder", () => {
    expect(gotchasUnusableReason(GOTCHAS_TEMPLATE)).toBe("placeholder");
  });

  test("the wizard's zero-invariant fallback is rejected as a placeholder", () => {
    // The literal string src/wizard.ts writes when onboarding collected no
    // invariants — which, since runWizard dispatches no reducer actions, is
    // every single `pr-hero setup` run.
    const wizardFallback =
      "<!-- human-attention-required: zero invariants defined during onboarding -->\n\n" +
      "# Repository Gotchas & Invariants\n\n" +
      "(No invariants defined during onboarding. Edit this file with project failure modes.)\n";
    expect(gotchasUnusableReason(wizardFallback)).toBe("placeholder");
  });

  test("a real hand-written gotchas file passes", () => {
    const real = [
      "# Repo gotchas",
      "",
      "- billing: a subscription run files a notional figure, never cash.",
      "- isolation: a credential projection owns the credential, not the home.",
      "",
    ].join("\n");
    expect(gotchasUnusableReason(real)).toBeUndefined();
  });

  test("the pre-marker template a repo may already have committed is a placeholder too", () => {
    // This used to pin the marker's honest limit: a repo that committed the
    // OLD raw template, before the marker existed, kept reviewing blind.
    // musive did exactly that, and its three `<subsystem>` lines reached
    // every hunter. The exact-line rule closes it — every line below is one
    // the shipped scaffold writes.
    const preMarkerTemplate = [
      "# Repo gotchas",
      "",
      "Facts a reviewer cannot infer from the diff alone. Each line is injected",
      "verbatim into every hunter's system prompt, so keep them short and true.",
      "",
      "- <subsystem>: <the thing that looks like a bug but is deliberate, and why>",
      "",
    ].join("\n");
    expect(gotchasUnusableReason(preMarkerTemplate)).toBe("placeholder");
  });

  test("the template with only its marker line deleted is still a placeholder", () => {
    const text = GOTCHAS_TEMPLATE.split("\n")
      .filter((l) => !l.includes(GOTCHAS_PLACEHOLDER_MARKER))
      .join("\n");
    expect(gotchasUnusableReason(text)).toBe("placeholder");
  });

  test("the same scaffold re-indented and with extra blank lines is still a placeholder", () => {
    const text = GOTCHAS_TEMPLATE.split("\n")
      .filter((l) => !l.includes(GOTCHAS_PLACEHOLDER_MARKER))
      .map((l) => `  ${l}`)
      .join("\n\n");
    expect(gotchasUnusableReason(text)).toBe("placeholder");
  });

  test("the setup fallback with its marker line deleted is still a placeholder", () => {
    const text = SETUP_GOTCHAS_FALLBACK.split("\n")
      .filter((l) => !l.includes(GOTCHAS_PLACEHOLDER_MARKER))
      .join("\n");
    expect(gotchasUnusableReason(text)).toBe("placeholder");
  });

  test("an earlier release's setup fallback with its marker line deleted is still a placeholder", () => {
    // The exact bytes `pr-hero setup` wrote before 60c28c6, minus the marker.
    const retired =
      "# Repository Gotchas & Invariants\n\n(No invariants defined during onboarding. Edit this file with project failure modes.)\n";
    expect(gotchasUnusableReason(retired)).toBe("placeholder");
  });

  test("real gotchas that keep one stray template line still pass", () => {
    const text =
      "# Repo gotchas\n\n- billing: amounts are integer cents everywhere\n- <subsystem>: <the naming/ownership rule a newcomer would violate>\n";
    expect(gotchasUnusableReason(text)).toBeUndefined();
  });

  test("a file of real gotchas passes", () => {
    const text = "- billing: amounts are integer cents everywhere\n";
    expect(gotchasUnusableReason(text)).toBeUndefined();
  });
});

describe("GOTCHAS_TEMPLATE carries the marker it is judged by", () => {
  test("the scaffold init writes is rejected by the gate init warns about", () => {
    expect(GOTCHAS_TEMPLATE).toContain(GOTCHAS_PLACEHOLDER_MARKER);
    expect(gotchasUnusableReason(GOTCHAS_TEMPLATE)).toBe("placeholder");
  });

  test("the marker line tells the reader to delete it", () => {
    const markerLine = GOTCHAS_TEMPLATE.split("\n").find((l) =>
      l.includes(GOTCHAS_PLACEHOLDER_MARKER),
    );
    expect(markerLine).toBeDefined();
    expect(markerLine?.toLowerCase()).toContain("delete");
  });
});

describe("gotchasErrorMessage distinguishes the two reasons", () => {
  test("'empty' offers the template AND says to delete its marker line", () => {
    // The trap this test exists for: the message embeds GOTCHAS_TEMPLATE
    // verbatim under "Create it with something like:", and that template now
    // carries a marker whose presence is itself a refusal. A reader who
    // copies it and stops has produced a file pr-hero still rejects, so the
    // message has to say the last step out loud.
    const message = gotchasErrorMessage("/repo/.crysk/gotchas.md", "empty");
    expect(message).toContain("/repo/.crysk/gotchas.md");
    expect(message).toContain("Create it with something like:");
    expect(message).toContain(GOTCHAS_TEMPLATE);
    expect(message).toContain(GOTCHAS_PLACEHOLDER_MARKER);
    expect(message.toLowerCase()).toContain("delete");
  });

  test("'placeholder' does not tell you to create a file that already exists", () => {
    const message = gotchasErrorMessage(
      "/repo/.crysk/gotchas.md",
      "placeholder",
    );
    expect(message).toContain("/repo/.crysk/gotchas.md");
    expect(message).toContain(GOTCHAS_PLACEHOLDER_MARKER);
    expect(message).not.toContain("Create it with something like:");
    expect(message.toLowerCase()).toContain("replace");
  });

  test("the two reasons do not render the same message", () => {
    expect(gotchasErrorMessage("/p/g.md", "empty")).not.toBe(
      gotchasErrorMessage("/p/g.md", "placeholder"),
    );
  });
});

// ---------------------------------------------------------------------------
// `pr-hero init`'s closing instruction block.
//
// It used to be printed unconditionally, while the write above it is skipped
// whenever the file already exists. So a repo with real, marker-free gotchas
// re-ran `init` and was told to delete a marker line that is not in its file
// and to replace `<subsystem>` placeholders it does not have. README.md now
// tells readers that re-running `init` after `setup` is harmless and
// expected, which routes people straight into that message.
//
// The rule this block encodes: the message may only assert what this run
// actually did. When the file was KEPT, the only thing `init` knows about it
// is what the gate itself says — so the gate is what it reports.
// ---------------------------------------------------------------------------

describe("initGotchasInstructions — only claims what the run did", () => {
  const wrote = initGotchasInstructions({ written: true }).join("\n");

  test("a file this run WROTE gets the two-step scaffold instruction", () => {
    // Safe here and only here: `init` wrote GOTCHAS_TEMPLATE, so the
    // `<subsystem>` lines and the marker line are both genuinely in the file.
    expect(wrote).toContain("<subsystem>");
    expect(wrote).toContain(GOTCHAS_PLACEHOLDER_MARKER);
    expect(wrote.toLowerCase()).toContain("delete");
    // The claim has to be true of the bytes actually written.
    expect(GOTCHAS_TEMPLATE).toContain("<subsystem>");
    expect(gotchasUnusableReason(GOTCHAS_TEMPLATE)).toBe("placeholder");
  });

  test("a KEPT file that passes the gate is not accused of anything", () => {
    const contents =
      "# Repo gotchas\n\n- billing: a subscription run files notional, not cash.\n";
    expect(gotchasUnusableReason(contents)).toBeUndefined();
    const lines = initGotchasInstructions({ written: false, contents });
    const text = lines.join("\n");

    // Nothing about placeholders, nothing about a marker to delete, and no
    // `<subsystem>` lines to replace: none of that is true of this file.
    expect(text).not.toContain(GOTCHAS_PLACEHOLDER_MARKER);
    expect(text).not.toContain("<subsystem>");
    expect(text.toLowerCase()).not.toContain("placeholder");
    expect(text.toLowerCase()).not.toContain("refuses");
    // It says something useful and checkable instead: the gate is satisfied.
    expect(text).toContain(".crysk/gotchas.md");
    expect(lines.length).toBeGreaterThan(0);
  });

  test("a KEPT file that still carries the marker says so — without inventing <subsystem> lines", () => {
    // The kept scaffold may be `pr-hero setup`'s fallback, which carries the
    // marker but has no `<subsystem>` lines at all. Naming them would be the
    // same defect one layer down.
    const contents = `<!-- ${GOTCHAS_PLACEHOLDER_MARKER}: zero invariants defined during onboarding -->\n\n# Repository Gotchas & Invariants\n`;
    expect(gotchasUnusableReason(contents)).toBe("placeholder");
    const text = initGotchasInstructions({ written: false, contents }).join(
      "\n",
    );

    expect(text).toContain(GOTCHAS_PLACEHOLDER_MARKER);
    expect(text.toLowerCase()).toContain("delete");
    expect(text).not.toContain("<subsystem>");
    // It must not claim this run created the file.
    expect(text.toLowerCase()).not.toContain("just wrote");
    expect(text.toLowerCase()).not.toContain("just scaffolded");
  });

  test("a KEPT file that is empty is told it is empty — there is no marker to delete", () => {
    const contents = "   \n\t\n";
    expect(gotchasUnusableReason(contents)).toBe("empty");
    const text = initGotchasInstructions({ written: false, contents }).join(
      "\n",
    );

    expect(text.toLowerCase()).toContain("empty");
    expect(text).not.toContain(GOTCHAS_PLACEHOLDER_MARKER);
    expect(text).not.toContain("<subsystem>");
  });

  test("the four outcomes do not render the same block", () => {
    const rendered = [
      wrote,
      initGotchasInstructions({
        written: false,
        contents: "- a real one\n",
      }).join("\n"),
      initGotchasInstructions({
        written: false,
        contents: `<!-- ${GOTCHAS_PLACEHOLDER_MARKER} -->\n`,
      }).join("\n"),
      initGotchasInstructions({ written: false, contents: "" }).join("\n"),
    ];
    expect(new Set(rendered).size).toBe(4);
  });

  test("every line is plain text — this block is printed, not styled", () => {
    for (const outcome of [
      { written: true } as const,
      { written: false as const, contents: "- real\n" },
      { written: false as const, contents: "" },
    ]) {
      for (const line of initGotchasInstructions(outcome)) {
        expect(line).not.toContain("\x1b");
      }
    }
  });
});

// T2d-1 (S2): each classified config, extra-hunter and prompt-set throw carries its
// record class. The message is the one the parser always printed, so the class is the
// only change. The person layer is deliberately NOT classified: its catalog text names
// the repo file (see the note below).
describe("parse errors carry their record class (T2d-1)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function thrownBy(thrower: () => unknown): CliUsageError | CliError {
    try {
      thrower();
    } catch (error) {
      return error as CliUsageError | CliError;
    }
    throw new Error("expected the parser to throw");
  }

  test("the repo config's invalid JSON is repo-config, same message", () => {
    const error = thrownBy(() => parseLocalConfig("not json"));
    expect(error).toBeInstanceOf(CliUsageError);
    expect(error.cls).toEqual({ kind: "config-parse", source: "repo-config" });
    expect(
      error.message.startsWith(".crysk/config.json is not valid JSON: "),
    ).toBe(true);
  });

  test("a per-person key in the repo config is repo-config, same message", () => {
    const error = thrownBy(() => parseLocalConfig('{"routing": {}}'));
    expect(error.cls).toEqual({ kind: "config-parse", source: "repo-config" });
    expect(error.message).toBe(
      ".crysk/config.json: routing is a per-person key — put it in your person config (~/.crysk/config.json, or ~/.prhero/config.json on an install set up before the rename; do not create ~/.crysk while ~/.prhero is in use)",
    );
  });

  test("the person layer's own parse errors stay unclassified, because its text names the repo file", () => {
    const error = thrownBy(() => parseGlobalConfig('{"default_base": "dev"}'));
    expect(error).toBeInstanceOf(CliUsageError);
    expect(error.cls).toBeUndefined();
    expect(error.message).toBe(
      "~/.crysk/config.json: default_base is a per-repo key — put it in the repo config (<repo>/.crysk/config.json, or <repo>/.prhero/config.json in a repo set up before the rename)",
    );
  });

  test("routing that the person layer rejects stays unclassified, same message", () => {
    // WHY: the routing class renders PRH-ROUTING-INVALID, whose text names CRYSK_ROUTING
    // and `gh variable set`. Neither is the fix for a personal file, so the person
    // layer's routing error carries no class, like the rest of that file's errors.
    const error = thrownBy(() => parseGlobalConfig('{"routing": "invalid"}'));
    expect(error).toBeInstanceOf(CliUsageError);
    expect(error.cls).toBeUndefined();
    expect(error.message).toBe(
      "~/.crysk/config.json routing must be an object",
    );
  });

  test("parseRoutingConfig names routing for any file it is given", () => {
    const error = thrownBy(() =>
      parseRoutingConfig("invalid", "~/.crysk/config.json"),
    );
    expect(error.cls).toEqual({ kind: "config-parse", source: "routing" });
    expect(error.message).toBe(
      "~/.crysk/config.json routing must be an object",
    );
  });

  test("a malformed PRHERO_EXTRA_HUNTERS entry is extra-hunters, same message", () => {
    const error = thrownBy(() =>
      localReviewSpec({ PRHERO_EXTRA_HUNTERS: "nokey" }),
    );
    expect(error).toBeInstanceOf(CliUsageError);
    expect(error.cls).toEqual({
      kind: "config-parse",
      source: "extra-hunters",
    });
    expect(error.message).toBe(
      'PRHERO_EXTRA_HUNTERS[0] must be "key:file.md", got: "nokey"',
    );
  });

  test("the basename check on an extra hunter file is extra-hunters too", () => {
    // The fourth throw of parseExtraHunters: assertBasenameOnly, which the
    // three key/file checks above do not reach.
    const error = thrownBy(() =>
      localReviewSpec({ PRHERO_EXTRA_HUNTERS: "logic:../escape.md" }),
    );
    expect(error.cls).toEqual({
      kind: "config-parse",
      source: "extra-hunters",
    });
    expect(
      error.message.startsWith("spec.agents[0].file must be a plain basename"),
    ).toBe(true);
  });

  test("a missing agents dir is prompt-set, same message", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-preflight-agents-"));
    const loaded = await loadEffectiveConfig({ root: dir, home: dir });
    const missing = path.join(dir, "no-such-agents");
    const error = thrownBy(() => resolveAgentsDir({ agents: missing }, loaded));
    expect(error).toBeInstanceOf(CliError);
    expect(error.cls).toEqual({ kind: "prompt-set" });
    expect(error.message).toBe(`agents dir does not exist: ${missing}`);
  });

  test("a prompt set that does not match the review spec is prompt-set", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-preflight-agents-"));
    await mkdir(path.join(dir, "agents"));
    const agents = { kind: "dir" as const, dir: path.join(dir, "agents") };
    const error = await preflightAgentsDir(agents, [
      "deep-review-reliability.md",
    ]).then(
      () => {
        throw new Error("expected preflightAgentsDir to throw");
      },
      (e: CliError) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect(error.cls).toEqual({ kind: "prompt-set" });
    expect(
      error.message.startsWith(`prompt set ${agents.dir} does not match`),
    ).toBe(true);
  });
});

// `pr-hero status` (ROADMAP S9): a read-only command with one numeric --pr and one --json.
// Everything else is refused rather than ignored, because a flag that parses and then does
// nothing is an operator believing they changed a read they did not.
describe("parseArgs status", () => {
  test("reads the command, its PR and --json", () => {
    const { command, options } = parseArgs(["status", "--pr", "12", "--json"]);
    expect(command).toBe("status");
    expect(options.pr).toBe(12);
    expect(options.json).toBe(true);
  });

  test("--json is optional", () => {
    const { command, options } = parseArgs(["status", "--pr", "12"]);
    expect(command).toBe("status");
    expect(options.json).toBeUndefined();
  });

  test("--pr is required", () => {
    expect(() => parseArgs(["status"])).toThrow(CliUsageError);
    expect(() => parseArgs(["status", "--json"])).toThrow(
      /status requires --pr/,
    );
  });

  test("--pr must be numeric: a bare flag, or a non-number, is refused", () => {
    expect(() => parseArgs(["status", "--pr"])).toThrow(/status requires --pr/);
    expect(() => parseArgs(["status", "--pr", "12abc"])).toThrow(CliUsageError);
  });

  test("an unknown flag throws", () => {
    expect(() => parseArgs(["status", "--pr", "12", "--bogus"])).toThrow(
      /unknown option: --bogus/,
    );
  });

  test("a flag that another command owns throws on status, rather than being ignored", () => {
    expect(() => parseArgs(["status", "--pr", "12", "--post"])).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseArgs(["status", "--pr", "12", "--from", "/tmp/run"]),
    ).toThrow(CliUsageError);
  });

  test("--json is refused on every other command", () => {
    expect(() => parseArgs(["review", "--pr", "12", "--json"])).toThrow(
      /--json only applies to the status command/,
    );
  });

  test("reads --wait on status and refuses it on every other command", () => {
    const { command, options } = parseArgs([
      "status",
      "--pr",
      "12",
      "--wait",
      "--json",
    ]);
    expect(command).toBe("status");
    expect(options.wait).toBe(true);
    expect(options.json).toBe(true);
    expect(() => parseArgs(["review", "--pr", "12", "--wait"])).toThrow(
      /--wait only applies to the status command/,
    );
  });

  test("a second word after status is an unexpected argument", () => {
    expect(() => parseArgs(["status", "status", "--pr", "12"])).toThrow(
      /unexpected argument/,
    );
  });

  test("watch status and gc status still parse as their own sub-words", () => {
    expect(parseArgs(["watch", "status"]).options.watch).toBe("status");
    expect(parseArgs(["gc", "status"]).options.gc).toBe("status");
    expect(parseArgs(["watch", "status"]).command).toBe("watch");
    expect(parseArgs(["gc", "status"]).command).toBe("gc");
  });

  test("status is in the command list the unknown-command error names", () => {
    expect(() => parseArgs(["statu"])).toThrow(/"status"/);
  });
});

describe("skills install (non-interactive skill sync)", () => {
  test("skills install parses to command skills with the install subcommand", () => {
    const parsed = parseArgs(["skills", "install"]);
    expect(parsed.command).toBe("skills");
    expect(parsed.options.skills).toBe("install");
    expect(parsed.options.force).toBe(false);
  });

  test("skills install --force sets force", () => {
    const parsed = parseArgs(["skills", "install", "--force"]);
    expect(parsed.options.skills).toBe("install");
    expect(parsed.options.force).toBe(true);
  });

  test("skills without a subcommand, or with another one, is a usage error", () => {
    const text = "pr-hero skills needs a subcommand: install";
    expect(() => parseArgs(["skills"])).toThrow(CliUsageError);
    expect(() => parseArgs(["skills"])).toThrow(text);
    expect(() => parseArgs(["skills", "remove"])).toThrow(CliUsageError);
    expect(() => parseArgs(["skills", "remove"])).toThrow(text);
  });

  test("help lists skills install next to setup", () => {
    expect(HELP_TEXT).toContain("pr-hero skills install");
    expect(HELP_TEXT).toContain(
      "Install the crysk, crysk-pr, triage and CI-setup skills into every detected coding agent (no TTY, no MCP)",
    );
  });

  test("skills is in the command list the unknown-command error names", () => {
    expect(() => parseArgs(["skilz"])).toThrow(/"skills"/);
  });
});
