// Maintainer script (odd/tasks/antigravity-oauth.md T5, S7, L22): prints the
// pinned Antigravity CLI release to paste over AGY_PINNED_RELEASE in
// src/ci/agy-install.ts.
//
//   bun run scripts/pin-agy.ts
//
// It reads Google's auto-updater manifest for each runner platform
// (`{version, url, sha512}`), checks that all four name one version, and prints
// the table. It edits no file and downloads no archive: the bump is a reviewed
// source change, and the installer checks each archive against the pinned
// sha512 when a run installs it. The CI installer never reads these manifests.

import {
  AGY_PLATFORM_KEYS,
  type AgyBuild,
  AgyInstallError,
  type AgyPlatformKey,
  type AgyRelease,
  checkAgyBuild,
} from "../src/ci/agy-install";

export const AGY_MANIFEST_BASE_URL =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

const MANIFEST_TIMEOUT_MS = 60_000;

export function agyManifestUrl(platformKey: AgyPlatformKey): string {
  return `${AGY_MANIFEST_BASE_URL}/${platformKey}.json`;
}

export interface AgyManifest extends AgyBuild {
  readonly version: string;
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
  const { version, url, sha512 } = parsed as Record<string, unknown>;
  if (typeof version !== "string" || version.trim() === "") {
    throw new AgyInstallError("the Antigravity CLI manifest has no version");
  }
  if (typeof url !== "string") {
    throw new AgyInstallError("the Antigravity CLI manifest has no url");
  }
  const build = checkAgyBuild(
    { url, sha512: typeof sha512 === "string" ? sha512 : "" },
    "manifest",
  );
  return { version, ...build };
}

// The AGY_PINNED_RELEASE literal, formatted as the installer's source holds it.
export function renderAgyRelease(release: AgyRelease): string {
  const lines = [
    "export const AGY_PINNED_RELEASE: AgyRelease = {",
    `  version: ${JSON.stringify(release.version)},`,
    "  builds: {",
  ];
  for (const key of AGY_PLATFORM_KEYS) {
    const build = release.builds[key];
    lines.push(
      `    ${key}: {`,
      `      url: ${JSON.stringify(build.url)},`,
      "      sha512:",
      `        ${JSON.stringify(build.sha512)},`,
      "    },",
    );
  }
  lines.push("  },", "};");
  return lines.join("\n");
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

export async function readAgyManifests(
  fetchFn: FetchLike,
): Promise<AgyRelease> {
  const manifests = {} as Record<AgyPlatformKey, AgyManifest>;
  for (const key of AGY_PLATFORM_KEYS) {
    const url = agyManifestUrl(key);
    let response: Response;
    try {
      response = await fetchFn(url, {
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AgyInstallError(
        `the Antigravity CLI manifest could not be fetched (${url}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new AgyInstallError(
        `the Antigravity CLI manifest answered HTTP ${response.status} (${url})`,
      );
    }
    manifests[key] = parseAgyManifest(await response.text());
  }
  const versions = new Set(AGY_PLATFORM_KEYS.map((k) => manifests[k].version));
  if (versions.size !== 1) {
    throw new AgyInstallError(
      `the manifests disagree on the version (${AGY_PLATFORM_KEYS.map((k) => `${k} ${manifests[k].version}`).join(", ")}); run again once Google has published one version for every platform`,
    );
  }
  const builds = {} as Record<AgyPlatformKey, AgyBuild>;
  for (const key of AGY_PLATFORM_KEYS) {
    builds[key] = { url: manifests[key].url, sha512: manifests[key].sha512 };
  }
  return { version: manifests.linux_amd64.version, builds };
}

export async function runPinAgy(deps: {
  readonly fetch: FetchLike;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}): Promise<number> {
  try {
    const release = await readAgyManifests(deps.fetch);
    deps.stdout(
      `// Paste over AGY_PINNED_RELEASE in src/ci/agy-install.ts, and update the pinned table in test/ci/agy-install.test.ts.\n${renderAgyRelease(release)}\n`,
    );
    return 0;
  } catch (error) {
    deps.stderr(
      `pin-agy: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(
    await runPinAgy({
      fetch: (url, init) => fetch(url, init),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    }),
  );
}
