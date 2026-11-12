import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ModelsConfig, routingNeedsOpenCode } from "#model/model-name";
import {
  FALLBACK_PROFILE,
  type ModelProfile,
  resolveProfile,
} from "#model/profiles";
import {
  exactBindingCapabilityIssues,
  type ProviderCapabilityReport,
} from "#model/provider-capabilities";
import { buildResolvedRoutePlan, planRoutes } from "#model/routing";
import {
  agentFilePath,
  GOTCHAS_PLACEHOLDER_MARKER,
  gotchasUnusableReason,
  localReviewSpec,
  resolveAgentsDirSetting,
} from "#review/preflight";
import {
  REVIEW_MD_FILE_NAME,
  resolveReviewInstructions,
  shadowedGotchasNotice,
} from "#review/run";
import {
  detectAgentEnvironments,
  inspectMcpRegistration,
  inspectSkillsSync,
} from "./agent-env";
import {
  type EngineAssets,
  isNpxCacheInvocation,
  NPX_REGISTRATION_REFUSED,
  resolveEngineAssets,
  selfInvocation,
} from "./assets";
import { REPO_DIR_NAME, resolveHomeDir, resolveRepoDir } from "./brand-paths";
import {
  gitIsTracked,
  type IsTracked,
  migrationChecks,
} from "./doctor-migration";
import type { ExactBindingCapabilityReport } from "./execution/contracts";
import {
  type CheckSystemToolsOptions,
  checkCiConfiguration,
  checkSystemTools,
} from "./system-tools";
import { SUPPORTED_OPENCODE_SDK_VERSION } from "./transport-registry";
import {
  OpenCodeSdkUnavailableError,
  openCodeSdkUnavailableMessage,
} from "./transports/opencode-admission";

export type DoctorSeverity = "healthy" | "degraded" | "blocking";

export interface DoctorCheckItem {
  name: string;
  severity: DoctorSeverity;
  message: string;
  hint?: string;
}

export interface DoctorReport {
  overall: DoctorSeverity;
  checks: DoctorCheckItem[];
  exitCode: 0 | 1;
}

export interface RunDoctorOptions {
  // Whether git tracks <repoDir>/<rel>: picks `git mv` over `mv` in the
  // migration hint. Injectable so tests need no repository.
  isTracked?: IsTracked;
  platform?: string;
  cwd?: string;
  repoRoot?: string;
  home?: string;
  checkToolsOptions?: CheckSystemToolsOptions;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string | undefined;
  // Exact-binding facts from the binding that would execute the route.
  // When present, these win over produceCapabilityReport (stale caller
  // readiness booleans must not determine doctor verdict).
  probeExactBindings?: () => Promise<readonly ExactBindingCapabilityReport[]>;
  // The engine's own packaged assets. Injectable for the same reason
  // preflight.ts's resolveAgentsDirSetting takes them: the real
  // detectAssetMode() reads import.meta.dir, which under `bun test` always
  // answers "dev", so the COMPILED bundle — the one that shipped broken — is
  // unreachable from an offline test without this seam.
  assets?: EngineAssets;
  // §11/D1-09: doctor consumes the SAME ProviderCapabilityReport execution
  // gates on. Injectable so offline tests stay deterministic; the CLI's
  // doctor command passes the real producer. Opt-in rather than default-on
  // because the report always carries non-blocking gaps (no pricing table,
  // no bounded event sink), which would flip every existing "healthy"
  // fixture to "degraded" for reasons unrelated to what those tests probe.
  // Legacy injectable ProviderCapabilityReport. Ignored when
  // probeExactBindings is provided.
  produceCapabilityReport?: () => Promise<ProviderCapabilityReport>;
  // Whether any step the configuration resolves runs on the Claude CLI
  // (reviewNeedsClaude). Absent: required, as every caller that does not
  // resolve the configuration (the updater, the menu) has always had it.
  claudeRequired?: boolean;
}

// Whether a review under this configuration sends any step to the Claude CLI
// (model-profiles S6): the route plan a review would build, every hunter of
// the bundled spec, the refuter, consolidate, scout, summarizer and, with the
// gate on, the materiality judge, resolved through `models` and the active
// profile. True whenever the answer is not proven: neither `models` nor a
// `profile`, a plan that fails to build, or a bad CRYSK_EXTRA_HUNTERS. So zero-config and
// every configuration naming a Claude model keep the CLI required.
export function reviewNeedsClaude(input: {
  models: ModelsConfig | undefined;
  // The config's `profile` (openai-profile S6). Absent: the fallback profile.
  profile?: string;
  materialityGate?: boolean;
  env?: Record<string, string | undefined>;
}): boolean {
  if (input.models === undefined && input.profile === undefined) return true;
  try {
    const plan = buildResolvedRoutePlan({
      agents: localReviewSpec(input.env ?? process.env).agents,
      models: input.models,
      profile: resolveProfile(input.profile),
      bundledAgents: true,
      summarizer: { bundled: true },
      scout: { bundled: true },
      consolidate: { bundled: true },
      // Unknown counts as on: the judge then joins only when it shares a
      // backend with another step or `models.judge` names it.
      ...(input.materialityGate === false
        ? {}
        : { materiality: true as const }),
    });
    // Fallbacks included: a step that falls back to Claude can start the CLI.
    return planRoutes(plan).some(
      (step) => step.route.backend === "claude-code",
    );
  } catch {
    return true;
  }
}

// Remediation hints for the report's known non-blocking codes; blocking
// issues carry their own actionable message from the producer. Exported
// for a reachability test (pushProviderIssues only attaches a hint when
// `!issue.blocking`, so a hint keyed to an always-blocking code can never
// render).
export const PROVIDER_HINTS: Record<string, string> = {
  credential_projection_unavailable:
    "Credential projection requires macOS with /usr/bin/security; on other platforms the child runs with enumerated-passthrough env.",
  codegraph_policy_unenforced:
    "Await the dedicated codegraph sensitive-file policy (D1-05 residual); isolation currently relies on --strict-mcp-config with a codegraph-only mcp.json.",
  bounded_events_sink_missing:
    "Usage arrives as a final snapshot until the bounded event sink is wired (D1-08 residual).",
  pricing_table_missing:
    "Nothing is priced at this level: the report is produced before any route resolves. An attempt's cash cost is whatever its transport reports, and a metered route whose transport reports none is refused at admission.",
};

// fix/opencode-sdk-absent-degraded: OpenCodeSdkUnavailableError means
// "@opencode-ai/sdk is not resolvable here" (a compiled binary run without
// its node_modules), not "the environment is broken". Only OpenCode-backed
// steps cannot execute, so this stays `degraded`; every other
// capability-probe failure keeps today's `blocking` treatment unchanged.
//
// The hint must not claim the rest of the plan was verified. resolveFrozenBindings
// (production-runtime.ts) awaits the OpenCode identity observation inside the
// same loop that resolves every other route, with no per-step isolation, so
// the rejection escapes before gateBindingsCapabilities ever runs: the probe
// produces ZERO capability reports, Claude-backed steps included. Degraded
// here means "unverified", not "verified fine".
const OPENCODE_SDK_UNAVAILABLE_HINT =
  "Run crysk upgrade --reconcile to install @opencode-ai/sdk where this binary can resolve it, or route the affected steps through Claude instead. The probe stops at the first OpenCode step, so this run verified no capabilities for ANY route in the plan — Claude-backed steps are unverified here, not confirmed healthy.";

function pushCapabilityProbeFailure(
  checks: DoctorCheckItem[],
  error: unknown,
): void {
  if (error instanceof OpenCodeSdkUnavailableError) {
    checks.push({
      name: "provider",
      severity: "degraded",
      message: `capability report production degraded: ${error.message}`,
      hint: OPENCODE_SDK_UNAVAILABLE_HINT,
    });
    return;
  }
  checks.push({
    name: "provider",
    severity: "blocking",
    message: `capability report production failed: ${(error as Error).message}`,
  });
}

function pushProviderIssues(
  checks: DoctorCheckItem[],
  issues: readonly { code: string; message: string; blocking: boolean }[],
): void {
  for (const issue of issues) {
    checks.push({
      name: `provider:${issue.code}`,
      severity: issue.blocking ? "blocking" : "degraded",
      message: issue.message,
      ...(issue.blocking ? {} : { hint: PROVIDER_HINTS[issue.code] }),
    });
  }
}

export function openCodeRoutingSdkCheck(input: {
  models: ModelsConfig | undefined;
  // The configuration's profile (openai-profile S6). Absent: the fallback.
  profile?: ModelProfile;
  sdkVersion: string | undefined;
}): DoctorCheckItem | undefined {
  if (!routingNeedsOpenCode(input.models, input.profile ?? FALLBACK_PROFILE)) {
    return undefined;
  }
  const version =
    typeof input.sdkVersion === "string" ? input.sdkVersion.trim() : "";
  if (version === SUPPORTED_OPENCODE_SDK_VERSION) return undefined;
  if (version === "") {
    return {
      name: "opencode-sdk",
      severity: "blocking",
      message: openCodeSdkUnavailableMessage(),
    };
  }
  return {
    name: "opencode-sdk",
    severity: "blocking",
    message:
      `Unsupported OpenCode SDK version "${version}". ` +
      `Expected exact version "${SUPPORTED_OPENCODE_SDK_VERSION}". ` +
      "Run crysk upgrade --reconcile.",
  };
}

export function evaluateDoctorReport(checks: DoctorCheckItem[]): DoctorReport {
  let overall: DoctorSeverity = "healthy";
  if (checks.some((c) => c.severity === "blocking")) {
    overall = "blocking";
  } else if (checks.some((c) => c.severity === "degraded")) {
    overall = "degraded";
  }

  return {
    overall,
    checks,
    exitCode: overall === "blocking" ? 1 : 0,
  };
}

export async function runDoctor(
  options: RunDoctorOptions = {},
): Promise<DoctorReport> {
  const home = options.home ?? os.homedir();
  const exists =
    options.exists ?? options.checkToolsOptions?.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });

  const repoDir = options.repoRoot ?? options.cwd;
  // The directory the engine actually reads (.crysk/, or a legacy .prhero/), so
  // every message names a file that exists.
  const repoDirName = repoDir
    ? path.basename(resolveRepoDir(repoDir, exists))
    : REPO_DIR_NAME;

  const checks: DoctorCheckItem[] = [];

  // ONE resolution, shared by the bundled-prompt check below and the skills
  // sync check further down: two calls would let an injected bundle disagree
  // with the real one inside a single report.
  const assets = options.assets ?? resolveEngineAssets();

  // 1. System tools
  const tools = await checkSystemTools({
    cwd: repoDir ?? process.cwd(),
    home,
    exists,
    ...options.checkToolsOptions,
  });

  // Git (required)
  if (!tools.git.installed) {
    checks.push({
      name: "git",
      severity: "blocking",
      message: "git is not installed",
      hint: tools.git.hint,
    });
  } else {
    checks.push({
      name: "git",
      severity: "healthy",
      message: `git is installed (${tools.git.version ?? "version unknown"})`,
    });
  }

  // Claude (required + auth). Required unless the caller resolved the
  // configuration and found no step on the Claude CLI (model-profiles S6,
  // reviewNeedsClaude): then a missing or signed-out CLI is reported, but it
  // blocks nothing, because no review would start it.
  const claudeRequired = options.claudeRequired !== false;
  if (!claudeRequired && !(tools.claude.installed && tools.claude.authOk)) {
    checks.push({
      name: "claude",
      severity: "healthy",
      message: `${
        tools.claude.installed
          ? `Claude Code CLI is installed (${tools.claude.version ?? "unknown"}) but not authenticated`
          : "Claude Code CLI is not installed"
      }; not needed, since no configured step runs on it`,
    });
  } else if (!tools.claude.installed) {
    checks.push({
      name: "claude",
      severity: "blocking",
      message: "Claude Code CLI is not installed",
      hint: tools.claude.hint,
    });
  } else if (!tools.claude.authOk) {
    checks.push({
      name: "claude",
      severity: "blocking",
      message: `Claude Code CLI is installed (${tools.claude.version ?? "unknown"}) but not authenticated`,
      hint: tools.claude.hint,
    });
  } else {
    checks.push({
      name: "claude",
      severity: "healthy",
      message: `Claude Code CLI is installed and authenticated (${tools.claude.version ?? "unknown"})`,
    });
  }

  // GitHub CLI (optional, PR mode)
  if (!tools.gh.installed) {
    checks.push({
      name: "gh",
      severity: "degraded",
      message: "GitHub CLI is not installed (needed for PR review mode)",
      hint: tools.gh.hint,
    });
  } else if (!tools.gh.authOk) {
    checks.push({
      name: "gh",
      severity: "degraded",
      message: `GitHub CLI is installed (${tools.gh.version ?? "unknown"}) but not authenticated with GitHub`,
      hint: tools.gh.hint,
    });
  } else {
    checks.push({
      name: "gh",
      severity: "healthy",
      message: `GitHub CLI is installed and authenticated (${tools.gh.version ?? "unknown"})`,
    });
  }

  // CodeGraph (optional, code intelligence)
  if (!tools.codegraph.installed) {
    checks.push({
      name: "codegraph",
      severity: "degraded",
      message: "CodeGraph binary is not installed (optional code intelligence)",
      hint: tools.codegraph.hint,
    });
  } else if (!tools.codegraph.repoIndexed) {
    checks.push({
      name: "codegraph",
      severity: "degraded",
      message: `CodeGraph is installed (${tools.codegraph.version ?? "unknown"}) but repository is not indexed (.codegraph missing)`,
      hint: tools.codegraph.hint,
    });
  } else {
    checks.push({
      name: "codegraph",
      severity: "healthy",
      message: `CodeGraph is installed (${tools.codegraph.version ?? "unknown"}) and repository is indexed`,
    });
  }

  // 2. Config layer / agents_dir check
  const repoConfigPath = repoDir
    ? path.join(resolveRepoDir(repoDir, exists), "config.json")
    : undefined;
  const globalConfigPath = path.join(
    resolveHomeDir(home, exists),
    "config.json",
  );

  let parsedAgentsDir: string | undefined;
  if (repoConfigPath && exists(repoConfigPath)) {
    try {
      const raw = readFile(repoConfigPath);
      if (raw) {
        const json = JSON.parse(raw);
        if (json.agents_dir && typeof json.agents_dir === "string") {
          parsedAgentsDir = path.resolve(
            path.dirname(repoConfigPath),
            json.agents_dir,
          );
        }
      }
    } catch {
      // Ignored here, parsed elsewhere
    }
  } else if (exists(globalConfigPath)) {
    try {
      const raw = readFile(globalConfigPath);
      if (raw) {
        const json = JSON.parse(raw);
        if (json.agents_dir && typeof json.agents_dir === "string") {
          parsedAgentsDir = path.resolve(
            path.dirname(globalConfigPath),
            json.agents_dir,
          );
        }
      }
    } catch {
      // Ignored
    }
  }

  if (parsedAgentsDir !== undefined) {
    if (!exists(parsedAgentsDir)) {
      checks.push({
        name: "agents_dir",
        severity: "blocking",
        message: `Configured agents_dir not found: ${parsedAgentsDir}`,
        hint: `Delete "agents_dir" from ${repoDirName}/config.json to fall through to the bundled default prompt set.`,
      });
    } else {
      checks.push({
        name: "agents_dir",
        severity: "healthy",
        message: `Custom agents_dir configured and verified: ${parsedAgentsDir}`,
      });
    }
  } else {
    // This branch used to push "Using bundled prompt set (default)" and
    // healthy, unconditionally, having verified nothing at all — which is how
    // `doctor` printed a green agents_dir on the machine where the next
    // `review` died with `agents dir does not exist: /$bunfs/root`. A doctor
    // that reports health it never checked is worse than no doctor, because it
    // is the thing an operator trusts before spending money.
    //
    // Resolved through preflight's resolveAgentsDirSetting/agentFilePath, the
    // same pair the review itself reads prompts with: a second way to answer
    // "where is the bundled set" is a second way to be wrong, and only one of
    // the two would be the one the review uses.
    const bundled = resolveAgentsDirSetting({
      cwd: repoDir ?? process.cwd(),
      assets,
    });
    // READ, rather than exists() followed by a read. Reading is the operation
    // the review actually performs, so it is the one whose failure matters; an
    // existence probe in front of it only adds a second verdict on the same
    // file. An empty body counts as unreadable: a zero-byte prompt gives a
    // hunter an empty system prompt, which spends money and finds nothing.
    const unreadable: string[] = [];
    const bundledSpec = localReviewSpec();
    for (const agent of bundledSpec.agents) {
      try {
        const body = readFile(agentFilePath(bundled, agent.file));
        if (body === undefined || body.trim().length === 0) {
          unreadable.push(agent.file);
        }
      } catch {
        // agentFilePath throws when the spec names a prompt this build never
        // embedded — manifest/spec drift, and the report has to survive it as
        // a finding rather than take the whole doctor down with it.
        unreadable.push(agent.file);
      }
    }

    if (unreadable.length > 0) {
      checks.push({
        name: "agents_dir",
        severity: "blocking",
        // LOGICAL filenames only. The embedded path is
        // "/$bunfs/root/<name>-<hash>.md", which exists on no machine and
        // sends the reader hunting a filesystem bug instead of a build one.
        message: `Bundled prompt set is incomplete: cannot read ${unreadable.join(", ")}`,
        hint:
          "This build cannot review anything. Reinstall the engine with " +
          "'crysk upgrade', or set \"agents_dir\" in .crysk/config.json to " +
          "a checked-out prompt set.",
      });
    } else {
      checks.push({
        name: "agents_dir",
        severity: "healthy",
        message:
          `Using bundled prompt set (default): ${bundled.dir} — ` +
          `${bundledSpec.agents.length} prompts read`,
      });
    }
  }

  // 3. Review instructions check: REVIEW.md, else gotchas (only when repo root
  // is supplied or discovered). Same resolver and predicate the review gates
  // use, and that is the point: a doctor that answers this question its own
  // way eventually green-lights a file the very next command refuses, or
  // blocks on an absence the review accepts, and the user then hunts for the
  // problem somewhere it is not.
  if (repoDir) {
    const instructions = resolveReviewInstructions(undefined, repoDir, exists);
    if (instructions.path === undefined) {
      checks.push({
        name: "gotchas",
        severity: "degraded",
        message: `No review instructions (${REVIEW_MD_FILE_NAME} or ${repoDirName}/gotchas.md): reviews run with the default guidance only`,
        hint: `Add a ${REVIEW_MD_FILE_NAME} at the repository root with the facts the diff does not show: deliberate oddities, invariants enforced elsewhere, conventions a newcomer would break.`,
      });
    } else {
      const label = path.relative(repoDir, instructions.path);
      const unusable = gotchasUnusableReason(readFile(instructions.path) ?? "");
      if (unusable === "placeholder") {
        checks.push({
          name: "gotchas",
          severity: "blocking",
          message: `Repository review instructions (${label}) are still the untouched scaffold`,
          hint:
            `Replace the placeholder lines with real repository rules and invariants, and delete the \`${GOTCHAS_PLACEHOLDER_MARKER}\` ` +
            "marker line at the top if it is still there — Crysk refuses to review the scaffold.",
        });
      } else if (unusable !== undefined) {
        checks.push({
          name: "gotchas",
          severity: "blocking",
          message: `Repository review instructions (${label}) are empty`,
          hint: `Write repository-specific rules and invariants into ${label}, or delete it to review with the default guidance only.`,
        });
      } else if (instructions.shadowed !== undefined) {
        checks.push({
          name: "gotchas",
          severity: "degraded",
          message: shadowedGotchasNotice(instructions.shadowed),
          hint: `Move what ${path.relative(repoDir, instructions.shadowed)} says into ${REVIEW_MD_FILE_NAME}, then delete it.`,
        });
      } else {
        checks.push({
          name: "gotchas",
          severity: "healthy",
          message: `Repository review instructions present (${label})`,
        });
      }
    }
  }

  // 4. Setup state check (<home dir>/setup.json)
  const setupJsonPath = path.join(resolveHomeDir(home, exists), "setup.json");
  const homeDirName = path.basename(path.dirname(setupJsonPath));
  if (!exists(setupJsonPath)) {
    checks.push({
      name: "setup",
      severity: "degraded",
      message: `Global setup state not initialized (~/${homeDirName}/setup.json absent)`,
      hint: "Run 'crysk init' or complete onboarding to initialize.",
    });
  } else {
    checks.push({
      name: "setup",
      severity: "healthy",
      message: `Global setup state verified (~/${homeDirName}/setup.json)`,
    });
  }

  // 5. Agent Environments (S3)
  const envs = await detectAgentEnvironments({
    home,
    exists,
    which: options.checkToolsOptions?.which,
  });

  // The rename's migration hints need to know what is installed on this
  // machine (binary on PATH, launchd agents, MCP registrations), so they run
  // after the environment scan.
  checks.push(
    ...migrationChecks({
      home,
      repoDir,
      exists,
      readFile,
      envs,
      platform: options.platform ?? process.platform,
      isTracked: options.isTracked ?? gitIsTracked,
    }),
  );

  const self = selfInvocation();
  const mcpReg = {
    command: self.command,
    args: [...self.args, "mcp"],
  };

  if (envs.length === 0) {
    checks.push({
      name: "agent_environments",
      severity: "degraded",
      message:
        "No AI agent coding environments detected (Claude Code, Cursor, Windsurf, Codex, Antigravity, OpenCode)",
      hint: "Install or configure an AI agent environment to use crysk triage skills and MCP server.",
    });
  } else {
    for (const env of envs) {
      if (env.skillsDir) {
        const syncStatus = inspectSkillsSync(env, assets, { exists, readFile });
        if (syncStatus.synced) {
          checks.push({
            name: `skills:${env.id}`,
            severity: "healthy",
            message: `crysk skills (triage, ci-setup) synced for ${env.displayName} (${env.skillsDir})`,
          });
        } else if (syncStatus.drift) {
          checks.push({
            name: `skills:${env.id}`,
            severity: "degraded",
            message: `Local modifications detected in skills for ${env.displayName}`,
            hint: "Run 'crysk setup' or sync skills with force.",
          });
        } else {
          checks.push({
            name: `skills:${env.id}`,
            severity: "degraded",
            message: `crysk skills not synced to ${env.displayName}`,
            hint: "Run 'crysk setup' or 'crysk init' to sync skills.",
          });
        }
        // Sync removes the old-name copies it can prove untouched; one left
        // behind holds a file the user edited (or one sync never recorded).
        if (syncStatus.legacy.length > 0) {
          const dirs = syncStatus.legacy
            .map((name) => path.join(env.skillsDir as string, name))
            .join(", ");
          checks.push({
            name: `skills-legacy:${env.id}`,
            severity: "degraded",
            message: `Skills installed under their old names remain for ${env.displayName}: ${dirs}`,
            hint: "Run 'crysk setup' to remove the unedited ones, then delete the rest by hand once you have copied any edits you want to keep.",
          });
        }
      }

      if (env.mcpConfigFile && isNpxCacheInvocation(self)) {
        // Under npx the expected command is the temporary cache's path, which no
        // registration holds, so an equality check would always report missing.
        checks.push({
          name: `mcp:${env.id}`,
          severity: "degraded",
          message: `MCP registration for ${env.displayName} is not checked from npx's temporary cache`,
          hint: NPX_REGISTRATION_REFUSED,
        });
      } else if (env.mcpConfigFile) {
        const mcp = inspectMcpRegistration(env, mcpReg, { exists, readFile });
        if (mcp === "current") {
          checks.push({
            name: `mcp:${env.id}`,
            severity: "healthy",
            message: `crysk MCP server registered for ${env.displayName} (${env.mcpConfigFile})`,
          });
        } else if (mcp === "legacy") {
          // It still works; only the key predates the rename.
          checks.push({
            name: `mcp:${env.id}`,
            severity: "degraded",
            message: `crysk MCP server for ${env.displayName} is registered under its pre-rename key`,
            hint: "Run 'crysk setup' to migrate the registration.",
          });
        } else {
          checks.push({
            name: `mcp:${env.id}`,
            severity: "degraded",
            message: `crysk MCP server not registered for ${env.displayName}`,
            hint: "Run 'crysk setup' to register the MCP server.",
          });
        }
      }
    }
  }

  // 6. CI configuration (Pillar 3). Reuses checkToolsOptions.env rather than
  // adding a separate top-level env field — one injectable env source for
  // both "is claude authenticated" and "is this a GitHub Actions run",
  // matching how doctor.test.ts already threads env through today.
  const env = options.checkToolsOptions?.env ?? process.env;
  // GITHUB_ACTIONS, deliberately NOT isCiEnvironment(). That helper is
  // Boolean(GITHUB_ACTIONS || CI || --ci) and stays that way — its other
  // callers want exactly that generic meaning. This check does not: spec.md
  // §4.1 scopes it to "When run inside GitHub Actions", and everything it
  // looks for downstream (GITHUB_TOKEN, secrets passed through a workflow's
  // `with:` block) exists only there. `CI=true` alone is the near-universal
  // convention — GitLab, CircleCI, Jenkins, Travis, Buildkite, countless
  // container builds — so treating it as GitHub Actions meant asking a
  // GitLab runner for GitHub secrets, finding none, and reporting `blocking`.
  // That is not cosmetic: report.overall goes blocking, `pr-hero upgrade
  // --reconcile` pushes an error and exits 1, and a bare `pr-hero doctor`
  // exits 1, on a machine where nothing whatsoever is wrong.
  //
  // A non-GitHub CI therefore gets the SAME treatment as a local machine, in
  // both halves of this check: the answerable question ("do you have a
  // workflow file?") and `degraded` for "not configured, nothing broken".
  // Reserving `blocking` for a real Actions run keeps it meaning what it says
  // — a review that genuinely cannot authenticate.
  const isGithubActions = Boolean(env.GITHUB_ACTIONS);
  const ciStatus = checkCiConfiguration({
    cwd: repoDir ?? process.cwd(),
    isCi: isGithubActions,
    env,
    exists,
  });
  checks.push({
    name: "ci",
    severity: ciStatus.configured
      ? "healthy"
      : isGithubActions
        ? "blocking"
        : "degraded",
    message: ciStatus.message,
    hint: ciStatus.hint,
  });

  // 7. Provider capability report — exact-binding facts win; the legacy
  // ProviderCapabilityReport producer is only consulted when no exact probe
  // is supplied.
  if (options.probeExactBindings !== undefined) {
    try {
      const reports = await options.probeExactBindings();
      pushProviderIssues(
        checks,
        reports.flatMap((report) => exactBindingCapabilityIssues(report)),
      );
    } catch (error) {
      pushCapabilityProbeFailure(checks, error);
    }
  } else if (options.produceCapabilityReport !== undefined) {
    try {
      const capability = await options.produceCapabilityReport();
      pushProviderIssues(checks, capability.issues);
    } catch (error) {
      pushCapabilityProbeFailure(checks, error);
    }
  }

  return evaluateDoctorReport(checks);
}

export function renderDoctorReport(
  report: DoctorReport,
  options: { styles?: boolean; width?: number } = {},
): string[] {
  const styles = options.styles ?? false;
  const lines: string[] = [];

  const green = (s: string) => (styles ? `\x1b[32m${s}\x1b[0m` : s);
  const yellow = (s: string) => (styles ? `\x1b[33m${s}\x1b[0m` : s);
  const red = (s: string) => (styles ? `\x1b[31m${s}\x1b[0m` : s);
  const bold = (s: string) => (styles ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (styles ? `\x1b[2m${s}\x1b[0m` : s);

  lines.push(bold("crysk doctor"));
  lines.push("");

  for (const check of report.checks) {
    let symbol: string;
    if (check.severity === "healthy") {
      symbol = green("[✓]");
    } else if (check.severity === "degraded") {
      symbol = yellow("[!]");
    } else {
      symbol = red("[✗]");
    }

    lines.push(`  ${symbol} ${bold(check.name)}: ${check.message}`);
    if (check.hint) {
      lines.push(`      ${dim(`Hint: ${check.hint}`)}`);
    }
  }

  lines.push("");
  if (report.overall === "healthy") {
    lines.push(green("All checks passed. Environment is ready for reviews."));
  } else if (report.overall === "degraded") {
    lines.push(
      yellow(
        "Environment is operational, but some optional tools or configurations are degraded.",
      ),
    );
  } else {
    lines.push(
      red(
        "Environment has blocking issues. Reviews cannot run until resolved.",
      ),
    );
  }

  return lines;
}
