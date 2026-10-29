import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectAgentEnvironments,
  registerMcpServer,
  syncSkills,
} from "./agent-env";
import { type AssetMode, resolveEngineAssets, selfInvocation } from "./assets";
import { BIN_NAME, LEGACY_BIN_NAME } from "./brand";
import { LEGACY_HOME_DIR_NAME, resolveHomeDir } from "./brand-paths";
import { loadGlobalConfigLayer } from "./config/config";
import { runDoctor } from "./doctor";
import { prheroLayout } from "./home-preflight";
import { type RoutingConfig, routingNeedsOpenCodeSdk } from "./model/routing";
import {
  readInstalledOpenCodeSdkVersion,
  SUPPORTED_OPENCODE_SDK_VERSION,
} from "./transport-registry";

export const PRHERO_GITHUB_REPO = "juanmaagd/pr-hero";

export type InstallMethodKind = "standalone" | "package_manager" | "source";

export type InstallMethod =
  | { kind: "standalone"; binaryPath: string }
  | { kind: "package_manager"; manager: "npm" | "bun" }
  | { kind: "source" };

export interface DetectInstallMethodOptions {
  execPath?: string;
  home?: string;
  version?: string;
  isDev?: boolean;
  exists?: (p: string) => boolean;
}

export function detectInstallMethod(
  options: DetectInstallMethodOptions = {},
): InstallMethod {
  const home = options.home ?? os.homedir();
  const execPath = options.execPath ?? process.execPath;
  const version = options.version ?? "0.2.6";
  const exists = options.exists ?? existsSync;

  const isSource =
    options.isDev !== undefined
      ? options.isDev
      : version === "dev" ||
        (exists("./src/cli.ts") &&
          !execPath.includes(".crysk/bin") &&
          !execPath.includes(".prhero/bin"));

  if (isSource) {
    return { kind: "source" };
  }

  // Either home name: a binary installed before the rename lives under
  // ~/.prhero/bin even when a ~/.crysk now exists beside it.
  const standaloneBinDirs = [
    path.join(resolveHomeDir(home, exists), "bin"),
    path.join(home, LEGACY_HOME_DIR_NAME, "bin"),
  ];
  if (
    standaloneBinDirs.some(
      (dir) =>
        execPath.startsWith(dir) ||
        path.resolve(execPath).startsWith(path.resolve(dir)),
    )
  ) {
    return { kind: "standalone", binaryPath: execPath };
  }

  return {
    kind: "package_manager",
    manager: execPath.includes("bun") ? "bun" : "npm",
  };
}

export interface DetectShadowInstallsOptions {
  currentBinary: string;
  which?: (bin: string) => Promise<string[]> | string[];
}

export async function detectShadowInstalls(
  options: DetectShadowInstallsOptions,
): Promise<string[]> {
  const which =
    options.which ??
    (async (bin: string) => {
      const found = Bun.which(bin);
      return found ? [found] : [];
    });

  // Both names: a crysk upgrade is shadowed by an old pr-hero earlier on PATH
  // just as surely as by another crysk.
  const found = [
    ...(await which(BIN_NAME)),
    ...(await which(LEGACY_BIN_NAME)),
  ].map((p) => path.resolve(p));

  // The install's own pair (crysk and its pr-hero link, side by side) is one
  // install, not two.
  const currentDir = path.dirname(path.resolve(options.currentBinary));
  const own = new Set([
    path.resolve(options.currentBinary),
    path.join(currentDir, BIN_NAME),
    path.join(currentDir, LEGACY_BIN_NAME),
  ]);

  return [...new Set(found)].filter((p) => !own.has(p));
}

export interface UpgradeCheckCache {
  checked_at: string;
  current_version: string;
  latest_version: string;
  reconciled_version?: string;
  release_url?: string;
  changelog?: string;
}

export function isCheckCacheFresh(
  cache?: UpgradeCheckCache,
  nowMs = Date.now(),
  ttlMs = 24 * 3600 * 1000,
): boolean {
  if (!cache?.checked_at) return false;
  const checkedAtMs = Date.parse(cache.checked_at);
  if (Number.isNaN(checkedAtMs)) return false;
  return nowMs - checkedAtMs < ttlMs;
}

export function readUpgradeCache(
  cachePath: string,
  options: {
    readFile?: (p: string) => string | undefined;
    exists?: (p: string) => boolean;
  } = {},
): UpgradeCheckCache | undefined {
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });
  const exists =
    options.exists ??
    (options.readFile ? (p: string) => readFile(p) !== undefined : existsSync);

  if (!exists(cachePath)) return undefined;
  try {
    const raw = readFile(cachePath);
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writeUpgradeCache(
  cachePath: string,
  cache: UpgradeCheckCache,
  options: {
    writeFile?: (p: string, content: string) => void;
    mkdir?: (p: string, opts?: { recursive?: boolean }) => void;
  } = {},
): void {
  const writeFile =
    options.writeFile ??
    ((p: string, c: string) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, c, "utf-8");
    });

  writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
}

export interface UpgradePlan {
  action:
    | "upgrade_standalone"
    | "upgrade_package_manager"
    | "noop_source"
    | "up_to_date";
  currentVersion: string;
  targetVersion: string;
  targetBinary?: string;
  // The pr-hero name, kept beside targetBinary as a link for one version.
  aliasBinary?: string;
  tempBinary?: string;
  bakBinary?: string;
  downloadUrl?: string;
  // The same bytes under the pre-rename asset name, for a release made before
  // the rename (it has no crysk-<target> asset).
  legacyDownloadUrl?: string;
  checksumsUrl?: string;
  steps: string[];
  message?: string;
}

export interface PlanUpgradeOptions {
  installMethod: InstallMethod;
  currentVersion: string;
  targetVersion: string;
  home?: string;
  platform?: string;
  arch?: string;
}

export async function planUpgrade(
  options: PlanUpgradeOptions,
): Promise<UpgradePlan> {
  const { installMethod, currentVersion, targetVersion } = options;

  if (installMethod.kind === "source") {
    return {
      action: "noop_source",
      currentVersion,
      targetVersion,
      steps: [],
      message:
        "Running from source checkout / development mode. Use git pull to update.",
    };
  }

  if (currentVersion === targetVersion) {
    return {
      action: "up_to_date",
      currentVersion,
      targetVersion,
      steps: ["reconcile"],
      message: `pr-hero is already up to date (v${currentVersion}).`,
    };
  }

  if (installMethod.kind === "standalone") {
    // Always installed as `crysk` beside whichever name is running: a legacy
    // install (running as pr-hero) gains crysk, and pr-hero becomes its link.
    const binDir = path.dirname(installMethod.binaryPath);
    const targetBinary = path.join(binDir, BIN_NAME);
    const aliasBinary = path.join(binDir, LEGACY_BIN_NAME);
    const rand = crypto.randomBytes(4).toString("hex");
    const tempBinary = path.join(binDir, `${BIN_NAME}.tmp.${rand}`);
    const bakBinary = `${targetBinary}.bak`;

    const osName =
      (options.platform ?? os.platform()) === "darwin" ? "darwin" : "linux";
    const rawArch = options.arch ?? os.arch();
    const archName =
      rawArch === "arm64" || rawArch === "aarch64" ? "arm64" : "x64";
    const target = `${osName}-${archName}`;

    const releaseBase = `https://github.com/${PRHERO_GITHUB_REPO}/releases/download/v${targetVersion}`;
    const downloadUrl = `${releaseBase}/${BIN_NAME}-${target}`;
    const legacyDownloadUrl = `${releaseBase}/${LEGACY_BIN_NAME}-${target}`;
    const checksumsUrl = `${releaseBase}/SHA256SUMS`;

    return {
      action: "upgrade_standalone",
      currentVersion,
      targetVersion,
      targetBinary,
      aliasBinary,
      tempBinary,
      bakBinary,
      downloadUrl,
      legacyDownloadUrl,
      checksumsUrl,
      steps: [
        `Download ${downloadUrl} (or ${legacyDownloadUrl} for a release made before the rename) to ${tempBinary}`,
        `Verify SHA256 against ${checksumsUrl}`,
        `Preserve previous binary as ${bakBinary}`,
        `Atomically replace ${targetBinary}`,
        `Keep ${aliasBinary} working as a link to ${targetBinary}`,
        "Reconcile agent skills, MCP registrations, and SQLite migrations",
      ],
    };
  }

  return {
    action: "upgrade_package_manager",
    currentVersion,
    targetVersion,
    steps: [
      `Run ${installMethod.manager} install -g pr-hero@latest`,
      "Reconcile agent skills, MCP registrations, and SQLite migrations",
    ],
  };
}

interface DownloadedBinary {
  bytes: ArrayBuffer;
  // The release asset the bytes came from: the name its SHA256SUMS line carries.
  assetName: string;
}

// Downloads the binary a standalone plan names and verifies it against the
// SHA256SUMS line of the asset actually fetched. crysk-<target> first; only a
// 404 falls back to pr-hero-<target> (a release made before the rename). Any
// other failure is a real failure, not a reason to try another name.
export async function downloadReleaseBinary(
  plan: UpgradePlan,
  fetchFn: (url: string) => Promise<Response> = fetch,
): Promise<DownloadedBinary> {
  const { downloadUrl, legacyDownloadUrl, checksumsUrl } = plan;
  if (!downloadUrl || !legacyDownloadUrl || !checksumsUrl) {
    throw new Error("Incomplete standalone upgrade plan.");
  }

  let assetUrl = downloadUrl;
  let resp = await fetchFn(assetUrl);
  if (resp.status === 404) {
    assetUrl = legacyDownloadUrl;
    resp = await fetchFn(assetUrl);
    if (resp.status === 404) {
      throw new Error(
        `Failed to download the ${BIN_NAME} binary: neither ${path.basename(downloadUrl)} nor ${path.basename(legacyDownloadUrl)} is on this release.`,
      );
    }
  }
  if (!resp.ok) {
    throw new Error(`Failed to download ${BIN_NAME} binary from ${assetUrl}`);
  }
  const bytes = await resp.arrayBuffer();

  const sumsResp = await fetchFn(checksumsUrl);
  if (!sumsResp.ok) {
    throw new Error(`Failed to download SHA256SUMS from ${checksumsUrl}`);
  }
  const assetName = path.basename(assetUrl);
  const actualHash = crypto
    .createHash("sha256")
    .update(Buffer.from(bytes))
    .digest("hex");
  // sha256sum's own format: `<hash>  <name>`, `*` before the name in binary
  // mode. Matched on the name exactly so one asset's line never vouches for
  // another's bytes.
  const verified = (await sumsResp.text()).split("\n").some((line) => {
    const [hash, name] = line.trim().split(/\s+/);
    return name?.replace(/^\*/, "") === assetName && hash === actualHash;
  });
  if (!verified) {
    throw new Error(`SHA256 checksum verification failed for ${assetName}!`);
  }
  return { bytes, assetName };
}

// A binary that does not answer --help within the limit fails its smoke and is
// killed: an upgrade must never hang on the binary it is about to install.
const SMOKE_TIMEOUT_MS = 30_000;

async function smokeBinary(
  bin: string,
  timeoutMs = SMOKE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const proc = Bun.spawn([bin, "--help"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([proc.exited, timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      proc.kill("SIGKILL");
      return false;
    }
    return outcome === 0;
  } catch {
    return false;
  }
}

type InstallStandaloneResult =
  | {
      status: "installed";
      alias: "symlink" | "copy" | "failed";
      aliasError?: string;
    }
  | { status: "rolled_back" };

// Smoke-tests the verified bytes where they were downloaded, and only then swaps
// them in as the plan's crysk binary and points pr-hero at it. A failed or hung
// smoke removes the download and touches nothing installed, so there is never a
// moment when an unverified binary sits at the installed path.
export async function installStandaloneBinary(
  plan: UpgradePlan,
  bytes: Uint8Array,
  options: {
    smoke?: (bin: string) => Promise<boolean>;
    smokeTimeoutMs?: number;
  } = {},
): Promise<InstallStandaloneResult> {
  const { targetBinary, aliasBinary, tempBinary, bakBinary } = plan;
  if (!targetBinary || !aliasBinary || !tempBinary || !bakBinary) {
    throw new Error("Incomplete standalone upgrade plan.");
  }
  const smoke =
    options.smoke ??
    ((bin: string) => smokeBinary(bin, options.smokeTimeoutMs));

  await Bun.write(tempBinary, bytes);
  chmodSync(tempBinary, 0o755);
  if (!(await smoke(tempBinary))) {
    rmSync(tempBinary, { force: true });
    return { status: "rolled_back" };
  }

  // A .bak left by an interrupted upgrade is the last good binary when the
  // target itself is gone; otherwise it is stale.
  if (!existsSync(targetBinary) && existsSync(bakBinary)) {
    renameSync(bakBinary, targetBinary);
  } else {
    rmSync(bakBinary, { force: true });
  }
  const hadPrevious = existsSync(targetBinary);
  if (hadPrevious) renameSync(targetBinary, bakBinary);
  renameSync(tempBinary, targetBinary);
  rmSync(bakBinary, { force: true });

  // crysk is installed and verified; the alias is a convenience on top, so a
  // failure there is reported, never thrown half-way through the upgrade.
  try {
    return { status: "installed", alias: linkAlias(targetBinary, aliasBinary) };
  } catch (err) {
    return {
      status: "installed",
      alias: "failed",
      aliasError: (err as Error).message,
    };
  }
}

// pr-hero -> crysk, replacing whatever pr-hero was (the old binary, on a legacy
// install). Built beside the alias and renamed over it, so the name never
// stops resolving mid-swap. A relative link keeps the pair movable together. A
// filesystem that refuses symlinks gets a copy instead; that copy goes stale on
// the next upgrade unless this runs again, which it does on every upgrade.
function linkAlias(target: string, alias: string): "symlink" | "copy" {
  const staged = `${alias}.new.${process.pid}`;
  rmSync(staged, { force: true });
  try {
    symlinkSync(path.basename(target), staged);
    renameSync(staged, alias);
    return "symlink";
  } catch {
    rmSync(staged, { force: true });
    copyFileSync(target, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, alias);
    return "copy";
  }
}

export interface OpenCodeSdkSpawnResult {
  code: number;
  stderr: string;
}

export interface ReconcileUpgradeOptions {
  home?: string;
  syncSkills?: () => Promise<{ synced: string[]; errors: string[] }>;
  verifyMcp?: () => Promise<{ ok: boolean }>;
  migrateStore?: () => Promise<{ ok: boolean; version?: number }>;
  reloadDaemons?: () => Promise<{ reloaded: string[] }>;
  // Injected so the default installer, which spawns npm or bun, never runs
  // in a test that only cares about the other reconcile steps.
  ensureOpenCodeSdk?: () => Promise<void>;
  runDoctorCheck?: () => Promise<{ overall: string }>;
  readSdkVersion?: () => Promise<string | undefined>;
  // Injected so `bun test` (always `dev`) can exercise the compiled reader.
  // Omitted mode is the only path that calls detectAssetMode().
  assetMode?: AssetMode;
  which?: (bin: string) => string | null;
  spawnInstaller?: (argv: readonly string[]) => Promise<OpenCodeSdkSpawnResult>;
}

// npm when it is on PATH; otherwise bun. Neither is an error, not a spawn.
// Bun's `add` accepts `--ignore-scripts` (dependency scripts are never run;
// project lifecycle scripts are skipped) and `--cwd`, so the spec lands in
// the product home rather than the caller's cwd.
export function selectOpenCodeSdkInstaller(input: {
  npmPath: string | null;
  bunPath: string | null;
  layoutDir: string;
}): readonly string[] {
  const spec = `@opencode-ai/sdk@${SUPPORTED_OPENCODE_SDK_VERSION}`;
  if (input.npmPath) {
    return [
      input.npmPath,
      "install",
      "--ignore-scripts",
      "--no-fund",
      "--no-audit",
      "--prefix",
      input.layoutDir,
      spec,
    ];
  }
  if (input.bunPath) {
    return [
      input.bunPath,
      "add",
      "--exact",
      "--ignore-scripts",
      "--cwd",
      input.layoutDir,
      spec,
    ];
  }
  throw new Error(
    "neither npm nor bun is on PATH. Run pr-hero upgrade --reconcile after installing npm or bun.",
  );
}

function commandOnPath(bin: string | null | undefined): string | null {
  if (typeof bin !== "string" || bin.trim() === "") return null;
  return bin;
}

// Not watch.lock. That file is held for a whole watcher review; this one
// only covers the install, so a second reconcile cannot npm-install the
// same prefix while the first is still writing it.
function openCodeSdkInstallLockPath(home: string): string {
  return path.join(prheroLayout(home).dir, "opencode-sdk.lock");
}

function liveLockPid(lockPath: string): number | null {
  if (!existsSync(lockPath)) return null;
  const pid = Number(readFileSync(lockPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
  }
}

async function withOpenCodeSdkInstallLock(
  home: string,
  work: () => Promise<void>,
): Promise<void> {
  const lockPath = openCodeSdkInstallLockPath(home);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = liveLockPid(lockPath);
      if (holder !== null) {
        throw new Error(
          `OpenCode SDK install is already running (pid ${holder}). ` +
            "Run pr-hero upgrade --reconcile after it finishes.",
        );
      }
      await rm(lockPath, { force: true });
      continue;
    }
    try {
      // Synchronous: an awaited write leaves the file empty, and liveLockPid
      // treats an empty file as a dead holder and deletes it.
      writeSync(handle.fd, `${process.pid}\n`);
      await work();
      return;
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(
    "OpenCode SDK install is already running. " +
      "Run pr-hero upgrade --reconcile after it finishes.",
  );
}

// Same bound as installSystemTool's npm install. A registry fetch can be
// slow; a child that never exits must not pin reconcile. The message omits
// argv: `--prefix` carries the product home.
export const OPENCODE_SDK_INSTALL_TIMEOUT_MS = 300_000;

export function spawnOpenCodeSdkInstaller(
  argv: readonly string[],
  timeoutMs = OPENCODE_SDK_INSTALL_TIMEOUT_MS,
): Promise<OpenCodeSdkSpawnResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          `OpenCode SDK install timed out after ${timeoutMs}ms. Run pr-hero upgrade --reconcile.`,
        ),
      );
    }, timeoutMs);
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (chunks.length >= 8) return;
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      finish(() => {
        const stderr = Buffer.concat(chunks)
          .toString("utf8")
          .replaceAll("/$bunfs", "")
          .trim()
          .slice(0, 240);
        resolve({ code: code ?? 1, stderr });
      });
    });
  });
}

async function readReconcileRouting(
  home: string,
): Promise<RoutingConfig | undefined> {
  const loaded = await loadGlobalConfigLayer(home);
  return loaded.layer?.routing;
}

async function ensureOpenCodeSdkInstalled(options: {
  home: string;
  assetMode?: AssetMode;
  readSdkVersion?: () => Promise<string | undefined>;
  which?: (bin: string) => string | null;
  spawnInstaller?: (argv: readonly string[]) => Promise<OpenCodeSdkSpawnResult>;
}): Promise<void> {
  const routing = await readReconcileRouting(options.home);
  if (!routingNeedsOpenCodeSdk(routing)) return;
  // Install and the version check share this home. The no-arg reader uses
  // os.homedir(), which is a different tree whenever reconcile was given one.
  const nodeModulesDir = prheroLayout(options.home).nodeModulesDir;
  const readSdkVersion =
    options.readSdkVersion ??
    (() =>
      readInstalledOpenCodeSdkVersion(
        options.assetMode === undefined
          ? { nodeModulesDir }
          : { mode: options.assetMode, nodeModulesDir },
      ));
  const installed = await readSdkVersion();
  if (installed === SUPPORTED_OPENCODE_SDK_VERSION) return;
  await withOpenCodeSdkInstallLock(options.home, async () => {
    const again = await readSdkVersion();
    if (again === SUPPORTED_OPENCODE_SDK_VERSION) return;
    const which = options.which ?? ((bin: string) => Bun.which(bin));
    const npmPath = commandOnPath(which("npm"));
    const bunPath = npmPath === null ? commandOnPath(which("bun")) : null;
    const argv = selectOpenCodeSdkInstaller({
      npmPath,
      bunPath,
      layoutDir: prheroLayout(options.home).dir,
    });
    const spawnInstaller = options.spawnInstaller ?? spawnOpenCodeSdkInstaller;
    const result = await spawnInstaller(argv);
    if (result.code !== 0) {
      throw new Error(
        `Failed to install @opencode-ai/sdk@${SUPPORTED_OPENCODE_SDK_VERSION} ` +
          `(exit ${result.code}). Run pr-hero upgrade --reconcile.`,
      );
    }
    const after = await readSdkVersion();
    if (after !== SUPPORTED_OPENCODE_SDK_VERSION) {
      const observed =
        typeof after === "string" && after.trim() !== ""
          ? after.trim()
          : "missing";
      throw new Error(
        `OpenCode SDK version "${observed}" after install; expected ` +
          `"${SUPPORTED_OPENCODE_SDK_VERSION}". Run pr-hero upgrade --reconcile.`,
      );
    }
  });
}

export async function reconcileUpgrade(
  options: ReconcileUpgradeOptions = {},
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const home = options.home ?? os.homedir();
  const assets = resolveEngineAssets();
  const envs = await detectAgentEnvironments({ home });
  const self = selfInvocation();

  // 1. Sync skills for all active environments
  if (options.syncSkills) {
    const res = await options.syncSkills();
    if (res.errors.length > 0) errors.push(...res.errors);
  } else {
    for (const env of envs) {
      if (env.skillsDir && (env.status === "active" || env.binaryFound)) {
        const res = await syncSkills(env, assets, { force: true });
        if (res.errors.length > 0) errors.push(...res.errors);
      }
    }
  }

  // 2. Verify MCP registration
  if (options.verifyMcp) {
    try {
      const res = await options.verifyMcp();
      if (!res.ok) {
        errors.push("MCP verification failed");
      }
    } catch (err) {
      errors.push(`MCP verification failed: ${(err as Error).message}`);
    }
  } else {
    for (const env of envs) {
      if (env.mcpConfigFile && (env.status === "active" || env.binaryFound)) {
        try {
          const res = await registerMcpServer(env, {
            command: self.command,
            args: [...self.args, "mcp"],
          });
          if (!res.registered && res.error) {
            errors.push(`${env.displayName} MCP: ${res.error}`);
          }
        } catch (err) {
          errors.push(`${env.displayName} MCP: ${(err as Error).message}`);
        }
      }
    }
  }

  // 3. Store migrations
  if (options.migrateStore) {
    try {
      const res = await options.migrateStore();
      if (!res.ok) {
        errors.push("Store migration failed");
      }
    } catch (err) {
      errors.push(`Store migration failed: ${(err as Error).message}`);
    }
  }

  // 4. Reload daemons on macOS
  if (options.reloadDaemons) {
    try {
      await options.reloadDaemons();
    } catch (err) {
      errors.push(`Daemon reload failed: ${(err as Error).message}`);
    }
  }

  // 5. OpenCode SDK, after the daemon reload and before doctor, so the
  // doctor step sees the install. A failure is reported and doctor still runs.
  try {
    if (options.ensureOpenCodeSdk) {
      await options.ensureOpenCodeSdk();
    } else {
      await ensureOpenCodeSdkInstalled({
        home,
        assetMode: options.assetMode,
        readSdkVersion: options.readSdkVersion,
        which: options.which,
        spawnInstaller: options.spawnInstaller,
      });
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  // 6. Doctor check
  if (options.runDoctorCheck) {
    try {
      const doc = await options.runDoctorCheck();
      if (doc.overall === "blocking") {
        errors.push("Doctor check found blocking issues");
      }
    } catch (err) {
      errors.push(`Doctor check failed: ${(err as Error).message}`);
    }
  } else {
    try {
      const doc = await runDoctor({ home });
      if (doc.overall === "blocking") {
        errors.push("Doctor check found blocking issues");
      }
    } catch (err) {
      errors.push(`Doctor check error: ${(err as Error).message}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
