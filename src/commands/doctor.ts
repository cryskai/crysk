import os from "node:os";
import { loadEffectiveConfig, resolveOptionalRepoRoot } from "#config/config";
import { type ModelsConfig, routingNeedsOpenCode } from "#model/model-name";
import { resolveProfile } from "#model/profiles";
import { type CliOptions, resolveMaterialityGate } from "#review/preflight";
import { styleEnabled, terminalWidth } from "#ui/primitives";
import {
  type DoctorCheckItem,
  type DoctorReport,
  evaluateDoctorReport,
  openCodeRoutingSdkCheck,
  renderDoctorReport,
  reviewNeedsClaude,
  runDoctor,
} from "../doctor";
import { prheroLayout } from "../home-preflight";
import { collectDoctorExactBindingReports } from "../production-runtime";
import { readInstalledOpenCodeSdkVersion } from "../transport-registry";

// W3 remediation (opencode-production-runtime PR3 verify #4997): doctor
// exists to diagnose a broken setup, so it must not die on the very
// misconfiguration it is asked to report. loadEffectiveConfig throws a
// CliError on a missing --config file, and delegates to parseLocalConfig,
// which throws on malformed repo config.json — either used to abort
// doctorCommand before a single check ran. A config-load failure is now one
// blocking DoctorCheckItem prepended to the report; every other diagnostic
// still runs and still renders, and the exit code stays nonzero.
export async function runDoctorCommand(input: {
  repoRoot?: string | undefined;
  workspaceRoot: string;
  home: string;
  configFlag?: string | undefined;
  styles: boolean;
  width: number;
  // Injectable for tests: production always uses the real runDoctor, which
  // shells out to git/claude/gh/codegraph. Tests stub this to prove the
  // config-failure wiring without depending on host tool availability.
  runDoctorFn?: typeof runDoctor;
  // Same seam for the SDK reader: production reads the install doctor and
  // the loader share. Tests pass a version without resolving a package.
  readSdkVersion?: () => Promise<string | undefined>;
}): Promise<{ report: DoctorReport; lines: string[] }> {
  let models: ModelsConfig | undefined;
  let profileId: string | undefined;
  // Required unless the configuration loads and proves otherwise: a config
  // that fails to load must not quietly excuse a missing Claude CLI.
  let claudeRequired = true;
  let configCheck: DoctorCheckItem | undefined;
  try {
    const loaded = await loadEffectiveConfig({
      root: input.repoRoot,
      home: input.home,
      configFlag: input.configFlag,
    });
    models = loaded.effective.models;
    profileId = loaded.effective.profile;
    claudeRequired = reviewNeedsClaude({
      models,
      ...(profileId === undefined ? {} : { profile: profileId }),
      materialityGate: resolveMaterialityGate(loaded.effective),
    });
    // A config that loads with warnings works today and will not after the
    // key it uses is removed: degraded, with the warning as its message.
    if (loaded.warnings.length > 0) {
      configCheck = {
        name: "config",
        severity: "degraded",
        message: loaded.warnings.join("\n"),
      };
    }
  } catch (error) {
    configCheck = {
      name: "config",
      severity: "blocking",
      message: `configuration failed to load: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const runDoctorFn = input.runDoctorFn ?? runDoctor;
  const doctorReport = await runDoctorFn({
    repoRoot: input.repoRoot,
    cwd: input.repoRoot,
    claudeRequired,
    probeExactBindings: () =>
      collectDoctorExactBindingReports({
        workspaceRoot: input.workspaceRoot,
        models,
        claudeRequired,
        profile: resolveProfile(profileId),
      }),
  });
  // Same home the command was given. The no-arg reader uses os.homedir().
  const readSdkVersion =
    input.readSdkVersion ??
    (() =>
      readInstalledOpenCodeSdkVersion({
        nodeModulesDir: prheroLayout(input.home).nodeModulesDir,
      }));
  const profile = resolveProfile(profileId);
  const sdkCheck = routingNeedsOpenCode(models, profile)
    ? openCodeRoutingSdkCheck({
        models,
        profile,
        sdkVersion: await readSdkVersion(),
      })
    : undefined;
  const prefix: DoctorCheckItem[] = [];
  if (configCheck !== undefined) prefix.push(configCheck);
  if (sdkCheck !== undefined) prefix.push(sdkCheck);
  const report =
    prefix.length === 0
      ? doctorReport
      : evaluateDoctorReport([...prefix, ...doctorReport.checks]);
  const lines = renderDoctorReport(report, {
    styles: input.styles,
    width: input.width,
  });
  return { report, lines };
}

export async function doctorCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveOptionalRepoRoot(options);
  const { report, lines } = await runDoctorCommand({
    repoRoot: repoRoot ?? undefined,
    workspaceRoot: repoRoot ?? process.cwd(),
    home: os.homedir(),
    configFlag: options.config,
    styles: styleEnabled(process.stdout),
    width: terminalWidth(),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return report.exitCode;
}
