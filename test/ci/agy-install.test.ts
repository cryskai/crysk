// odd/tasks/antigravity-oauth.md T5 (S7, L22): the Install Antigravity CLI step.
// Offline: the download is an injected fetch and the pinned release an injected
// table, and the archives are tar headers written here byte by byte, so the
// refused shapes (traversal, two entries, a link) are exact and need no host tar.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as agy from "#ci/agy-install";
import {
  agyPlatformKey,
  installAgy,
  runAgyInstall,
  sha512Hex,
} from "#ci/agy-install";

type Release = NonNullable<Parameters<typeof installAgy>[0]["release"]>;

const BINARY = new TextEncoder().encode(
  "#!/bin/sh\necho 'agy 9.9.9-fixture'\n",
);
const DOWNLOAD_URL = "https://downloads.example.test/agy/cli_linux_x64.tar.gz";

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

// One tar entry: a 512-byte header (GNU magic, as the real release uses) and
// its data padded to a block.
function tarEntry(
  name: string,
  data: Uint8Array,
  options: { typeflag?: string; linkname?: string } = {},
): Uint8Array {
  const header = new Uint8Array(512);
  const put = (text: string, offset: number) =>
    header.set(new TextEncoder().encode(text), offset);
  put(name, 0);
  put(octal(0o755, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(data.length, 12), 124);
  put(octal(1_700_000_000, 12), 136);
  put(options.typeflag ?? "0", 156);
  if (options.linkname !== undefined) put(options.linkname, 157);
  put("ustar  \0", 257);
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  const out = new Uint8Array(512 + padded.length);
  out.set(header);
  out.set(padded, 512);
  return out;
}

function tarGz(...entries: Uint8Array[]): Uint8Array {
  const end = new Uint8Array(1024 * 10);
  const total = entries.reduce((n, e) => n + e.length, 0) + end.length;
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    tar.set(entry, offset);
    offset += entry.length;
  }
  return gzipSync(tar);
}

const GOOD = tarGz(tarEntry("antigravity", BINARY));

// A pinned release for the tests: every platform names the same build.
function releaseFor(
  archive: Uint8Array,
  build: { url?: string; sha512?: string } = {},
  version = "9.9.9",
): Release {
  const entry = {
    url: build.url ?? DOWNLOAD_URL,
    sha512: build.sha512 ?? sha512Hex(archive),
  };
  return {
    version,
    builds: {
      linux_amd64: entry,
      linux_arm64: entry,
      darwin_arm64: entry,
      darwin_amd64: entry,
    },
  };
}

interface Served {
  readonly download?: { status?: number; body?: Uint8Array };
}

function fakeFetch(served: Served) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (url === DOWNLOAD_URL) {
      const body = served.download?.body ?? GOOD;
      return new Response(body.slice().buffer as ArrayBuffer, {
        status: served.download?.status ?? 200,
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchFn, calls };
}

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crysk-agy-install-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function install(
  served: Served & { release?: Release; reported?: string },
) {
  const root = await scratch();
  const installDir = path.join(root, "bin");
  const { fetchFn, calls } = fakeFetch(served);
  const versions: string[] = [];
  let error: unknown;
  let result: Awaited<ReturnType<typeof installAgy>> | undefined;
  try {
    result = await installAgy({
      fetch: fetchFn,
      installDir,
      platformKey: "linux_amd64",
      release: served.release ?? releaseFor(GOOD),
      runVersion: async (binary) => {
        versions.push(binary);
        return served.reported ?? "agy 9.9.9\n";
      },
    });
  } catch (caught) {
    error = caught;
  }
  const files = existsSync(installDir) ? readdirSync(installDir) : [];
  return { root, installDir, calls, versions, error, result, files };
}

// L22: the version measured and pinned, and its four builds, as fetched from the
// auto-updater's manifests on 2026-11-15. Bumping the pin changes this test on
// purpose (scripts/pin-agy.ts prints the new table).
const PINNED_VERSION = "1.5.9";
const PINNED_BASE =
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472";
const PINNED_BUILDS = {
  linux_amd64: {
    url: `${PINNED_BASE}/linux-x64/cli_linux_x64.tar.gz`,
    sha512:
      "d01eb13ba7750eed18907f1ae8860864371e0ad9064415e8d033d22b4bd7b9b4e4c7f962058520b452d67db1c33163d9a889d55a7dffa159596ec6cd91a87b79",
  },
  linux_arm64: {
    url: `${PINNED_BASE}/linux-arm/cli_linux_arm64.tar.gz`,
    sha512:
      "16c632a09b81f598f7652bc11180861f9d2ee4408ffa161dadc83b2010de7a9cd055e97b4b46cd01903e35c0e8bf21d8262462ba7c5f168cc6dada9ac3d522c0",
  },
  darwin_arm64: {
    url: `${PINNED_BASE}/darwin-arm/cli_mac_arm64.tar.gz`,
    sha512:
      "690cd6a5a5fdb23564fb1b14f7f6ae368fa3636b7630f56c574a6dfc0e2791a0e5b93d6515be1650c8a268cfb28440e1b9cbaa1c5b85aa762ab25b51c1fccda5",
  },
  darwin_amd64: {
    url: `${PINNED_BASE}/darwin-x64/cli_mac_x64.tar.gz`,
    sha512:
      "5f3fd16127de1229bd978509649b0d77b602796292f465ab0e001edd141e902b4b9759991f744cde3264b892f7299eafca6fbae619eca8db24b985d7db40f25e",
  },
};

describe("the pinned Antigravity CLI release", () => {
  test("is the version measured in the Log (1.5.9), one build per platform", () => {
    expect(agy.AGY_PINNED_RELEASE).toEqual({
      version: PINNED_VERSION,
      builds: PINNED_BUILDS,
    });
  });

  test("the installer source names no manifest host: nothing is asked at run time", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "../../src/ci/agy-install.ts"),
      "utf8",
    );
    expect(source).not.toContain("auto-updater");
    expect(source).not.toContain("run.app");
    expect(source).not.toContain("manifests/");
  });

  for (const [key, build] of Object.entries(PINNED_BUILDS)) {
    test(`${key} downloads only its pinned url and checks its pinned sha512`, async () => {
      const root = await scratch();
      const calls: string[] = [];
      const error = await installAgy({
        fetch: async (url) => {
          calls.push(url);
          return new Response(GOOD.slice().buffer as ArrayBuffer);
        },
        installDir: path.join(root, "bin"),
        platformKey: key as keyof typeof PINNED_BUILDS,
        runVersion: async () => "",
      }).catch((caught: unknown) => caught);
      expect(calls).toEqual([build.url]);
      // The fixture archive is not the release: the pinned sha512 refuses it.
      expect(String(error)).toContain(
        `does not match the pinned sha512 (expected ${build.sha512}`,
      );
      expect(existsSync(path.join(root, "bin", "agy"))).toBe(false);
    });
  }
});

describe("agyPlatformKey", () => {
  test("maps the four builds the release publishes", () => {
    expect(agyPlatformKey("linux", "x64")).toBe("linux_amd64");
    expect(agyPlatformKey("linux", "arm64")).toBe("linux_arm64");
    expect(agyPlatformKey("darwin", "arm64")).toBe("darwin_arm64");
    expect(agyPlatformKey("darwin", "x64")).toBe("darwin_amd64");
  });

  test("refuses any other runner by name", () => {
    expect(() => agyPlatformKey("win32", "x64")).toThrow(
      /no build for this runner \(win32\/x64\)/,
    );
    expect(() => agyPlatformKey("linux", "ia32")).toThrow(/linux\/ia32/);
  });
});

describe("installAgy", () => {
  test("a good archive installs agy 0755, then runs its --version by absolute path", async () => {
    const run = await install({});
    expect(run.error).toBeUndefined();
    // One request, the pinned url: no manifest.
    expect(run.calls).toEqual([DOWNLOAD_URL]);
    const binary = path.join(run.installDir, "agy");
    expect(run.files).toEqual(["agy"]);
    expect(readFileSync(binary)).toEqual(Buffer.from(BINARY));
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(run.versions).toEqual([binary]);
    expect(run.result).toEqual({
      binary,
      version: "9.9.9",
      reported: "agy 9.9.9",
    });
  });

  test("an uppercase pinned sha512 is the same hex string", async () => {
    const run = await install({
      release: releaseFor(GOOD, { sha512: sha512Hex(GOOD).toUpperCase() }),
    });
    expect(run.error).toBeUndefined();
  });

  test("a sha512 mismatch installs nothing and executes nothing", async () => {
    const run = await install({
      release: releaseFor(GOOD, { sha512: "a".repeat(128) }),
    });
    expect(String(run.error)).toContain("does not match the pinned sha512");
    expect(run.files).toEqual([]);
    expect(run.versions).toEqual([]);
  });

  test("a tampered download (the pinned sha512 of another archive) is refused", async () => {
    const other = tarGz(tarEntry("antigravity", new Uint8Array([1, 2, 3])));
    const run = await install({ download: { body: other } });
    expect(String(run.error)).toContain("does not match");
    expect(run.files).toEqual([]);
    expect(run.versions).toEqual([]);
  });

  test("a binary whose --version does not report the pinned version is removed", async () => {
    const run = await install({ reported: "agy 1.6.0\n" });
    expect(String(run.error)).toContain(
      'agy --version reported "agy 1.6.0", not the pinned 9.9.9',
    );
    expect(run.versions).toHaveLength(1);
    expect(run.files).toEqual([]);
  });

  test("a version that only starts with the pinned one is not it", async () => {
    const run = await install({ reported: "agy 9.9.90\n" });
    expect(String(run.error)).toContain("not the pinned 9.9.9");
    expect(run.files).toEqual([]);
  });

  test("the pinned version with a build suffix is accepted", async () => {
    const run = await install({
      reported: "antigravity 9.9.9-4515810895593472\n",
    });
    expect(run.error).toBeUndefined();
    expect(run.files).toEqual(["agy"]);
  });

  test("a failing --version leaves no binary behind", async () => {
    const root = await scratch();
    const installDir = path.join(root, "bin");
    const { fetchFn } = fakeFetch({});
    const error = await installAgy({
      fetch: fetchFn,
      installDir,
      platformKey: "linux_amd64",
      release: releaseFor(GOOD),
      runVersion: async () => {
        throw new Error("agy --version exited 1");
      },
    }).catch((caught: unknown) => caught);
    expect(String(error)).toContain("exited 1");
    expect(readdirSync(installDir)).toEqual([]);
  });

  const refused: [string, Uint8Array, RegExp][] = [
    [
      "a path traversal entry",
      tarGz(tarEntry("../antigravity", BINARY)),
      /unexpected entry \("\.\.\/antigravity"\)/,
    ],
    [
      "an absolute path entry",
      tarGz(tarEntry("/tmp/antigravity", BINARY)),
      /unexpected entry/,
    ],
    [
      "a ./-prefixed name",
      tarGz(tarEntry("./antigravity", BINARY)),
      /unexpected entry/,
    ],
    [
      "two entries",
      tarGz(tarEntry("antigravity", BINARY), tarEntry("antigravity", BINARY)),
      /more than one entry/,
    ],
    [
      "a second, differently named entry",
      tarGz(tarEntry("antigravity", BINARY), tarEntry("evil", BINARY)),
      /more than one entry/,
    ],
    [
      "a symlink entry",
      tarGz(
        tarEntry("antigravity", new Uint8Array(0), {
          typeflag: "2",
          linkname: "/bin/sh",
        }),
      ),
      /not a regular file/,
    ],
    [
      "a hardlink entry",
      tarGz(
        tarEntry("antigravity", new Uint8Array(0), {
          typeflag: "1",
          linkname: "/etc/passwd",
        }),
      ),
      /not a regular file/,
    ],
    [
      "a directory entry",
      tarGz(tarEntry("antigravity", new Uint8Array(0), { typeflag: "5" })),
      /not a regular file/,
    ],
    [
      "a pax header before the file",
      tarGz(
        tarEntry("PaxHeader/antigravity", new Uint8Array(30), {
          typeflag: "x",
        }),
        tarEntry("antigravity", BINARY),
      ),
      /unexpected entry/,
    ],
    ["an empty archive", tarGz(), /does not hold antigravity/],
    [
      "data hidden after the end marker",
      (() => {
        const tar = new Uint8Array(512 * 6);
        tar.set(tarEntry("antigravity", BINARY));
        tar.set(tarEntry("evil", BINARY), 512 * 4);
        return gzipSync(tar);
      })(),
      /data after its end marker/,
    ],
    [
      "a corrupted header checksum",
      (() => {
        const entry = tarEntry("antigravity", BINARY);
        entry[100] = "1".charCodeAt(0);
        return gzipSync(entry);
      })(),
      /bad checksum/,
    ],
    [
      "a truncated file",
      (() => {
        const entry = tarEntry("antigravity", BINARY);
        return gzipSync(entry.subarray(0, 520));
      })(),
      /truncated/,
    ],
    [
      "bytes that are not gzip",
      new TextEncoder().encode("plain"),
      /not a gzip/,
    ],
  ];
  for (const [label, archive, message] of refused) {
    test(`${label} is refused, with nothing written or executed`, async () => {
      const run = await install({
        release: releaseFor(archive),
        download: { body: archive },
      });
      expect(String(run.error)).toMatch(message);
      expect(run.files).toEqual([]);
      expect(run.versions).toEqual([]);
    });
  }

  const badPins: [string, Release, RegExp][] = [
    [
      "an http url",
      releaseFor(GOOD, { url: "http://downloads.example.test/a.tgz" }),
      /not https/,
    ],
    ["a url that is not a URL", releaseFor(GOOD, { url: "nope" }), /not a URL/],
    [
      "a short sha512",
      releaseFor(GOOD, { sha512: "abc" }),
      /no sha512 \(128 hex characters\)/,
    ],
  ];
  for (const [label, release, message] of badPins) {
    test(`a pinned build with ${label} is refused before any download`, async () => {
      const run = await install({ release });
      expect(String(run.error)).toMatch(message);
      expect(run.calls).toEqual([]);
      expect(run.files).toEqual([]);
    });
  }

  test("an HTTP error on the download installs nothing", async () => {
    const run = await install({ download: { status: 404 } });
    expect(String(run.error)).toContain("download answered HTTP 404");
    expect(run.files).toEqual([]);
  });

  test("a network failure is named, not thrown raw", async () => {
    const root = await scratch();
    const error = await installAgy({
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
      installDir: path.join(root, "bin"),
      platformKey: "linux_amd64",
      release: releaseFor(GOOD),
      runVersion: async () => "",
    }).catch((caught: unknown) => caught);
    expect(String(error)).toContain("9.9.9 could not be downloaded");
    expect(String(error)).toContain("ECONNRESET");
  });
});

describe("runAgyInstall (the step's entry)", () => {
  async function runStep(
    env: Record<string, string>,
    options: { platform?: NodeJS.Platform; reported?: string } = {},
  ) {
    const root = await scratch();
    const githubPath = path.join(root, "github-path");
    await writeFile(githubPath, "");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const { fetchFn, calls } = fakeFetch({});
    const exitCode = await runAgyInstall({
      env: { GITHUB_PATH: githubPath, ...env },
      fetch: fetchFn,
      platform: options.platform ?? "linux",
      arch: "x64",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      release: releaseFor(GOOD),
      runVersion: async () => options.reported ?? "agy 9.9.9\n",
    });
    return {
      root,
      exitCode,
      calls,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      githubPath: readFileSync(githubPath, "utf8"),
    };
  }

  test("installs into AGY_INSTALL_DIR and adds it to GITHUB_PATH", async () => {
    const root = await scratch();
    const dir = path.join(root, "agy-bin");
    const run = await runStep({ AGY_INSTALL_DIR: dir });
    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([DOWNLOAD_URL]);
    expect(run.githubPath).toBe(`${dir}\n`);
    expect(run.stdout).toContain(
      "installed the Antigravity CLI 9.9.9 (pinned, sha512 verified)",
    );
    expect(statSync(path.join(dir, "agy")).mode & 0o777).toBe(0o755);
  });

  test("a version mismatch fails the step and leaves nothing on PATH", async () => {
    const root = await scratch();
    const dir = path.join(root, "agy-bin");
    const run = await runStep(
      { AGY_INSTALL_DIR: dir },
      { reported: "agy 1.6.0\n" },
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("::error::");
    expect(run.stderr).toContain("not the pinned 9.9.9");
    expect(run.githubPath).toBe("");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a relative or missing AGY_INSTALL_DIR fails the step", async () => {
    for (const value of ["", "bin"]) {
      const run = await runStep({ AGY_INSTALL_DIR: value });
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("::error::");
      expect(run.githubPath).toBe("");
    }
  });

  test("an unsupported runner fails the step with its name and changes no PATH", async () => {
    const root = await scratch();
    const run = await runStep(
      { AGY_INSTALL_DIR: path.join(root, "b") },
      { platform: "win32" },
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("no build for this runner (win32/x64)");
    expect(run.githubPath).toBe("");
    expect(run.calls).toEqual([]);
  });
});

// The real --version runner: a fixture script stands in for agy.
describe("installAgy runs the installed binary's --version", () => {
  test("the default runner executes <dir>/agy --version", async () => {
    const root = await scratch();
    const { fetchFn } = fakeFetch({});
    const result = await installAgy({
      fetch: fetchFn,
      installDir: path.join(root, "bin"),
      platformKey: "linux_amd64",
      release: releaseFor(GOOD),
    });
    expect(result.reported).toBe("agy 9.9.9-fixture");
  });
});

describe("readCapped streams a download without a declared length", () => {
  test("a chunked body over the cap is refused before it is fully buffered", async () => {
    const { readCapped } = await import("../../src/ci/agy-install");
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1000) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = new Response(body);
    expect(response.headers.get("content-length")).toBeNull();
    await expect(readCapped(response, 4096)).rejects.toThrow(
      "larger than the install allows",
    );
    // It stopped reading soon after the cap, not after the whole body.
    expect(pulled).toBeLessThan(20);
  });

  test("a chunked body within the cap is returned whole", async () => {
    const { readCapped } = await import("../../src/ci/agy-install");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    );
    expect(Array.from(await readCapped(response, 10))).toEqual([1, 2, 3]);
  });
});
