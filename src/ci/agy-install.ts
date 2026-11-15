// The action's Install Antigravity CLI step (odd/tasks/antigravity-oauth.md T5,
// S7): installs Google's `agy` CLI when the run's models name an `agy:` model.
//
// The order is the guarantee, and nothing runs out of it:
//   1. GET the auto-updater's manifest for this runner's platform, and check its
//      fields: `version`, an https `url`, and `sha512` as 128 hex characters.
//   2. Download `url` into memory, with a size cap.
//   3. sha512 over the downloaded bytes, compared with the manifest's. A
//      mismatch stops here: nothing is extracted, written or executed.
//   4. gunzip and read the tar in process. It must hold exactly ONE entry, a
//      regular file named `antigravity`. Any other entry (a second file, a
//      directory, a link, a path, a pax or GNU long-name header) refuses the
//      archive. The entry name is never used as a path: the destination is
//      always `<install dir>/agy`, so no entry can write anywhere else.
//   5. Write it 0755 through a temp file and a rename, add the install dir to
//      GITHUB_PATH, and run `<install dir>/agy --version` by its absolute path.
//
// WHY the manifest URL is a constant and not an input or env value: whoever
// controls the manifest chooses the binary and its checksum, and the binary then
// receives the Antigravity login. The same rule as the platform URL
// (src/ci/platform.ts). Tests inject `fetch` at function level only.
//
// Builtins only, like the other scripts the action runs before its steps need
// the engine's dependencies.

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const AGY_MANIFEST_BASE_URL =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

// The single file every release tarball holds (L3, L5; measured on 1.5.9).
export const AGY_ARCHIVE_ENTRY = "antigravity";
export const AGY_EXECUTABLE = "agy";

// The release tarball is about 100 MB and its binary about 265 MB (1.5.9).
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const SHA512_HEX_RE = /^[0-9a-f]{128}$/i;

export class AgyInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgyInstallError";
  }
}

export interface AgyManifest {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
}

// The manifest names the auto-updater publishes (all four answered 200 on
// 2026-11-15). Any other runner is refused before a request is made.
export function agyPlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): string {
  const os =
    platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : "";
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : "";
  if (os === "" || cpu === "") {
    throw new AgyInstallError(
      `the Antigravity CLI has no build for this runner (${platform}/${arch}); agy: models run on Linux or macOS runners, x64 or arm64`,
    );
  }
  return `${os}_${cpu}`;
}

export function agyManifestUrl(platformKey: string): string {
  return `${AGY_MANIFEST_BASE_URL}/${platformKey}.json`;
}

export function parseAgyManifest(text: string): AgyManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgyInstallError("the Antigravity CLI manifest is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AgyInstallError(
      "the Antigravity CLI manifest is not a JSON object",
    );
  }
  const record = parsed as Record<string, unknown>;
  const { version, url, sha512 } = record;
  if (typeof version !== "string" || version.trim() === "") {
    throw new AgyInstallError("the Antigravity CLI manifest has no version");
  }
  if (typeof url !== "string") {
    throw new AgyInstallError("the Antigravity CLI manifest has no url");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AgyInstallError(
      "the Antigravity CLI manifest's url is not a URL",
    );
  }
  if (parsedUrl.protocol !== "https:") {
    throw new AgyInstallError(
      "the Antigravity CLI manifest's url is not https",
    );
  }
  if (typeof sha512 !== "string" || !SHA512_HEX_RE.test(sha512)) {
    throw new AgyInstallError(
      "the Antigravity CLI manifest has no sha512 (128 hex characters)",
    );
  }
  return { version, url, sha512: sha512.toLowerCase() };
}

export function sha512Hex(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// tar, read in process. Only what a release needs: ustar or GNU headers, one
// regular file. Every header's checksum is checked; after the first zero block
// the rest of the archive must be zero too, so nothing hides past the end.
// ---------------------------------------------------------------------------

const BLOCK = 512;

function headerString(header: Uint8Array, start: number, length: number) {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}

function headerOctal(
  header: Uint8Array,
  start: number,
  length: number,
): number {
  const text = headerString(header, start, length).trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new AgyInstallError(
      "the Antigravity CLI archive has a malformed tar header",
    );
  }
  return Number.parseInt(text, 8);
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function checksumOk(header: Uint8Array): boolean {
  const stored = headerOctal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number);
  }
  return sum === stored;
}

// The one file's bytes, or an AgyInstallError naming why the archive is refused.
export function extractSingleAgyEntry(tar: Uint8Array): Uint8Array {
  let offset = 0;
  let file: Uint8Array | undefined;
  let entries = 0;
  while (offset + BLOCK <= tar.length) {
    if (isZeroBlock(tar, offset)) {
      for (let i = offset; i < tar.length; i++) {
        if (tar[i] !== 0) {
          throw new AgyInstallError(
            "the Antigravity CLI archive has data after its end marker",
          );
        }
      }
      break;
    }
    const header = tar.subarray(offset, offset + BLOCK);
    if (!checksumOk(header)) {
      throw new AgyInstallError(
        "the Antigravity CLI archive has a tar header with a bad checksum",
      );
    }
    entries += 1;
    if (entries > 1) {
      throw new AgyInstallError(
        `the Antigravity CLI archive holds more than one entry; only ${AGY_ARCHIVE_ENTRY} is expected`,
      );
    }
    const name = headerString(header, 0, 100);
    const prefix = headerString(header, 345, 155);
    const magic = headerString(header, 257, 6);
    const typeflag = String.fromCharCode(header[156] as number);
    const size = headerOctal(header, 124, 12);
    // The GNU header keeps other fields where ustar has the prefix.
    const fullName =
      magic === "ustar" && prefix !== "" ? `${prefix}/${name}` : name;
    if (fullName !== AGY_ARCHIVE_ENTRY) {
      throw new AgyInstallError(
        `the Antigravity CLI archive holds an unexpected entry (${JSON.stringify(fullName.slice(0, 120))}); only ${AGY_ARCHIVE_ENTRY} is expected`,
      );
    }
    if (typeflag !== "0" && typeflag !== "\0") {
      throw new AgyInstallError(
        `the Antigravity CLI archive's ${AGY_ARCHIVE_ENTRY} is not a regular file`,
      );
    }
    if (size > MAX_EXTRACTED_BYTES) {
      throw new AgyInstallError(
        "the Antigravity CLI archive's file is larger than the install allows",
      );
    }
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) {
      throw new AgyInstallError("the Antigravity CLI archive is truncated");
    }
    file = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (file === undefined) {
    throw new AgyInstallError(
      `the Antigravity CLI archive does not hold ${AGY_ARCHIVE_ENTRY}`,
    );
  }
  return file;
}

// ---------------------------------------------------------------------------

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

export interface InstallAgyDeps {
  readonly fetch: FetchLike;
  // The directory `agy` is written to; created when missing.
  readonly installDir: string;
  readonly platformKey: string;
  // Runs the installed binary's `--version`. Injectable so tests need no agy.
  readonly runVersion?: (binary: string) => Promise<string>;
}

export interface InstalledAgy {
  readonly binary: string;
  readonly version: string;
  // What `agy --version` printed, trimmed.
  readonly reported: string;
}

// Reads the body chunk by chunk and stops as soon as it passes the cap, so a
// response with no content-length (chunked) is never buffered past it.
export async function readCapped(
  response: Response,
  cap: number,
): Promise<Uint8Array> {
  const tooLarge = () =>
    new AgyInstallError(
      "the Antigravity CLI download is larger than the install allows",
    );
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) throw tooLarge();
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function defaultRunVersion(binary: string): Promise<string> {
  const proc = Bun.spawn([binary, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new AgyInstallError(
      `agy --version exited ${exitCode}: ${stderr.trim().slice(0, 300)}`,
    );
  }
  return stdout;
}

export async function installAgy(deps: InstallAgyDeps): Promise<InstalledAgy> {
  const manifestUrl = agyManifestUrl(deps.platformKey);
  let manifestResponse: Response;
  try {
    manifestResponse = await deps.fetch(manifestUrl, {
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AgyInstallError(
      `the Antigravity CLI manifest could not be fetched (${manifestUrl}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!manifestResponse.ok) {
    throw new AgyInstallError(
      `the Antigravity CLI manifest answered HTTP ${manifestResponse.status} (${manifestUrl})`,
    );
  }
  const manifest = parseAgyManifest(await manifestResponse.text());

  let download: Response;
  try {
    download = await deps.fetch(manifest.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AgyInstallError(
      `the Antigravity CLI ${manifest.version} could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!download.ok) {
    throw new AgyInstallError(
      `the Antigravity CLI ${manifest.version} download answered HTTP ${download.status}`,
    );
  }
  const archive = await readCapped(download, MAX_DOWNLOAD_BYTES);
  const actual = sha512Hex(archive);
  if (actual !== manifest.sha512) {
    throw new AgyInstallError(
      `the Antigravity CLI ${manifest.version} download does not match the manifest's sha512 (expected ${manifest.sha512}, got ${actual}); nothing was installed`,
    );
  }

  let tar: Uint8Array;
  try {
    tar = gunzipSync(archive, {
      maxOutputLength: MAX_EXTRACTED_BYTES + 64 * 1024,
    });
  } catch {
    throw new AgyInstallError(
      "the Antigravity CLI archive is not a gzip file, or is larger than the install allows",
    );
  }
  const file = extractSingleAgyEntry(tar);

  await mkdir(deps.installDir, { recursive: true });
  const binary = path.join(deps.installDir, AGY_EXECUTABLE);
  const temp = path.join(
    deps.installDir,
    `.${AGY_EXECUTABLE}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temp, file, { mode: 0o755, flag: "wx" });
    await chmod(temp, 0o755);
    await rename(temp, binary);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  const reported = (
    await (deps.runVersion ?? defaultRunVersion)(binary)
  ).trim();
  return { binary, version: manifest.version, reported };
}

// The install directory the step passes in AGY_INSTALL_DIR: under the runner's
// temp dir, never the workspace (the reviewed checkout).
const INSTALL_DIR_ENV = "AGY_INSTALL_DIR";

export async function runAgyInstall(deps: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: FetchLike;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly runVersion?: (binary: string) => Promise<string>;
}): Promise<number> {
  try {
    const installDir = deps.env[INSTALL_DIR_ENV] ?? "";
    if (installDir === "" || !path.isAbsolute(installDir)) {
      throw new AgyInstallError(
        `${INSTALL_DIR_ENV} must be an absolute directory`,
      );
    }
    const githubPath = deps.env.GITHUB_PATH ?? "";
    if (githubPath === "") {
      throw new AgyInstallError("GITHUB_PATH is not set");
    }
    const installed = await installAgy({
      fetch: deps.fetch,
      installDir,
      platformKey: agyPlatformKey(deps.platform, deps.arch),
      ...(deps.runVersion === undefined ? {} : { runVersion: deps.runVersion }),
    });
    appendFileSync(githubPath, `${installDir}\n`);
    deps.stdout(
      `crysk: installed the Antigravity CLI ${installed.version} (sha512 verified) as ${installed.binary}: ${installed.reported}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.stderr(
      `::error::Crysk could not install the Antigravity CLI: ${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(
    await runAgyInstall({
      env: process.env,
      fetch: (url, init) => fetch(url, init),
      platform: process.platform,
      arch: process.arch,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    }),
  );
}
