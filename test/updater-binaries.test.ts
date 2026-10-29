// The standalone upgrade during the pr-hero -> Crysk rename: a new binary
// downloads `crysk-<target>` (falling back to `pr-hero-<target>` on a release
// made before the rename) and leaves BOTH `crysk` and `pr-hero` runnable in
// the bin dir. Real files in a temp dir, a fake fetch, real spawned binaries.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectShadowInstalls,
  downloadReleaseBinary,
  installStandaloneBinary,
  planUpgrade,
  type UpgradePlan,
} from "../src/updater";

const script = (tag: string) => `#!/bin/sh\necho ${tag}\n`;
const sha = (text: string) =>
  crypto.createHash("sha256").update(text).digest("hex");

// A fake release: `assets` maps an asset name to its bytes; SHA256SUMS lists
// whatever `sums` names (default: every asset) in sha256sum's own format.
function fakeRelease(
  assets: Record<string, string>,
  sums: Record<string, string> = assets,
) {
  const requested: string[] = [];
  const fetchFn = async (url: string): Promise<Response> => {
    requested.push(path.basename(url));
    const name = path.basename(url);
    if (name === "SHA256SUMS") {
      const body = Object.entries(sums)
        .map(([n, text]) => `${sha(text)}  ${n}\n`)
        .join("");
      return new Response(body);
    }
    const body = assets[name];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body);
  };
  return { fetchFn, requested };
}

let root: string;
let binDir: string;
beforeEach(() => {
  root = mkdtempSync(path.join(realpathSync(tmpdir()), "crysk-upgrade-"));
  binDir = path.join(root, ".crysk", "bin");
  mkdirSync(binDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function plan(binaryName: string): Promise<UpgradePlan> {
  return planUpgrade({
    installMethod: {
      kind: "standalone",
      binaryPath: path.join(binDir, binaryName),
    },
    currentVersion: "0.2.6",
    targetVersion: "0.3.0",
    home: root,
    platform: "darwin",
    arch: "arm64",
  });
}

const run = (bin: string) => {
  const r = Bun.spawnSync([path.join(binDir, bin)]);
  return `${r.stdout}`.trim();
};

describe("planUpgrade names both assets and installs as crysk", () => {
  test("downloads crysk-<target>, keeps pr-hero-<target> as the fallback, installs into the same dir as crysk", async () => {
    const p = await plan("pr-hero");
    expect(p.downloadUrl).toEndWith("/v0.3.0/crysk-darwin-arm64");
    expect(p.legacyDownloadUrl).toEndWith("/v0.3.0/pr-hero-darwin-arm64");
    expect(p.targetBinary).toBe(path.join(binDir, "crysk"));
    expect(p.aliasBinary).toBe(path.join(binDir, "pr-hero"));
    expect(path.dirname(p.tempBinary ?? "")).toBe(binDir);
    expect(p.bakBinary).toBe(`${path.join(binDir, "crysk")}.bak`);
  });
});

describe("downloadReleaseBinary", () => {
  test("(b) downloads crysk-<target> and verifies it against its own SHA256SUMS line", async () => {
    const p = await plan("crysk");
    const { fetchFn, requested } = fakeRelease({
      "crysk-darwin-arm64": script("new"),
      "pr-hero-darwin-arm64": script("new-legacy-copy"),
    });
    const got = await downloadReleaseBinary(p, fetchFn);
    expect(got.assetName).toBe("crysk-darwin-arm64");
    expect(Buffer.from(got.bytes).toString()).toBe(script("new"));
    expect(requested).not.toContain("pr-hero-darwin-arm64");
  });

  test("(b) a crysk asset whose bytes do not match ITS sums line is rejected, even when the legacy line would match", async () => {
    const p = await plan("crysk");
    const { fetchFn } = fakeRelease(
      { "crysk-darwin-arm64": script("tampered") },
      { "crysk-darwin-arm64": script("expected") },
    );
    await expect(downloadReleaseBinary(p, fetchFn)).rejects.toThrow(
      /checksum verification failed for crysk-darwin-arm64/,
    );
  });

  test("(c) falls back to pr-hero-<target> when the release has no crysk asset, verified against the pr-hero line", async () => {
    const p = await plan("pr-hero");
    const { fetchFn, requested } = fakeRelease({
      "pr-hero-darwin-arm64": script("legacy-release"),
    });
    const got = await downloadReleaseBinary(p, fetchFn);
    expect(got.assetName).toBe("pr-hero-darwin-arm64");
    expect(Buffer.from(got.bytes).toString()).toBe(script("legacy-release"));
    expect(requested).toEqual([
      "crysk-darwin-arm64",
      "pr-hero-darwin-arm64",
      "SHA256SUMS",
    ]);
  });

  test("(c) a non-404 failure on the crysk asset does not silently fall back", async () => {
    const p = await plan("pr-hero");
    const fetchFn = async () => new Response("boom", { status: 500 });
    await expect(downloadReleaseBinary(p, fetchFn)).rejects.toThrow(
      /Failed to download/,
    );
  });

  test("neither asset on the release is an error naming both", async () => {
    const p = await plan("pr-hero");
    const { fetchFn } = fakeRelease({});
    await expect(downloadReleaseBinary(p, fetchFn)).rejects.toThrow(
      /crysk-darwin-arm64.*pr-hero-darwin-arm64/s,
    );
  });
});

describe("installStandaloneBinary", () => {
  test("(d) a legacy-only install ends with crysk AND pr-hero both runnable, pr-hero kept as a link to crysk", async () => {
    writeFileSync(path.join(binDir, "pr-hero"), script("old"), { mode: 0o755 });
    const p = await plan("pr-hero");
    const r = await installStandaloneBinary(p, Buffer.from(script("new")));
    expect(r.status).toBe("installed");
    expect(run("crysk")).toBe("new");
    expect(run("pr-hero")).toBe("new");
    expect(lstatSync(path.join(binDir, "pr-hero")).isSymbolicLink()).toBe(true);
    // No temp or backup debris.
    expect(existsSync(`${path.join(binDir, "crysk")}.bak`)).toBe(false);
    expect(existsSync(p.tempBinary ?? "")).toBe(false);
  });

  test("an install that already has crysk and the pr-hero link upgrades in place", async () => {
    const crysk = path.join(binDir, "crysk");
    writeFileSync(crysk, script("old"), { mode: 0o755 });
    // The state the installer leaves: crysk plus a pr-hero link to it.
    symlinkSync("crysk", path.join(binDir, "pr-hero"));
    const p = await plan("crysk");
    await installStandaloneBinary(p, Buffer.from(script("new")));
    expect(run("crysk")).toBe("new");
    expect(lstatSync(path.join(binDir, "pr-hero")).isSymbolicLink()).toBe(true);
    expect(run("pr-hero")).toBe("new");
  });

  // The smoke runs on the downloaded file before it replaces anything, with a time
  // limit: a binary that hangs on --help never ends up installed (#425 review).
  test("a binary that hangs on its smoke is never installed, and the old one keeps running", async () => {
    const crysk = path.join(binDir, "crysk");
    writeFileSync(crysk, script("old"), { mode: 0o755 });
    const p = await plan("crysk");
    const started = Date.now();
    const result = await installStandaloneBinary(
      p,
      Buffer.from("#!/bin/sh\nsleep 30\n"),
      { smokeTimeoutMs: 300 },
    );
    expect(result.status).toBe("rolled_back");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run("crysk")).toBe("old");
    expect(existsSync(`${crysk}.bak`)).toBe(false);
    expect(existsSync(p.tempBinary ?? "")).toBe(false);
  });

  // The alias is the last step; if it fails, crysk is installed and working and
  // the failure is reported, never thrown half-way (#425 review).
  test("a failed pr-hero alias leaves crysk installed and reports it", async () => {
    const p = await plan("crysk");
    // A directory at the alias path cannot be replaced by a link or a copy.
    mkdirSync(path.join(binDir, "pr-hero", "busy"), { recursive: true });
    const result = await installStandaloneBinary(p, Buffer.from(script("new")));
    expect(result.status).toBe("installed");
    expect(result.status === "installed" && result.alias).toBe("failed");
    expect(run("crysk")).toBe("new");
  });

  test("a binary that fails its smoke is rolled back: the old crysk is restored, pr-hero untouched", async () => {
    const crysk = path.join(binDir, "crysk");
    writeFileSync(crysk, script("old"), { mode: 0o755 });
    writeFileSync(path.join(binDir, "pr-hero"), script("old-alias"), {
      mode: 0o755,
    });
    const p = await plan("crysk");
    const r = await installStandaloneBinary(p, Buffer.from(script("bad")), {
      smoke: async () => false,
    });
    expect(r.status).toBe("rolled_back");
    expect(readFileSync(crysk, "utf8")).toBe(script("old"));
    expect(readFileSync(path.join(binDir, "pr-hero"), "utf8")).toBe(
      script("old-alias"),
    );
  });

  test("a failed smoke on a legacy-only install removes the crysk it never had before and keeps pr-hero", async () => {
    writeFileSync(path.join(binDir, "pr-hero"), script("old"), { mode: 0o755 });
    const p = await plan("pr-hero");
    const r = await installStandaloneBinary(p, Buffer.from(script("bad")), {
      smoke: async () => false,
    });
    expect(r.status).toBe("rolled_back");
    expect(existsSync(path.join(binDir, "crysk"))).toBe(false);
    expect(run("pr-hero")).toBe("old");
  });
});

describe("detectShadowInstalls covers both names", () => {
  const current = "/home/u/.crysk/bin/crysk";

  test("(e) a crysk elsewhere on PATH is a shadow", async () => {
    const shadows = await detectShadowInstalls({
      currentBinary: current,
      which: async (bin) => (bin === "crysk" ? ["/usr/local/bin/crysk"] : []),
    });
    expect(shadows).toEqual(["/usr/local/bin/crysk"]);
  });

  test("(e) a pr-hero elsewhere on PATH is a shadow", async () => {
    const shadows = await detectShadowInstalls({
      currentBinary: current,
      which: async (bin) =>
        bin === "pr-hero" ? ["/opt/homebrew/bin/pr-hero"] : [],
    });
    expect(shadows).toEqual(["/opt/homebrew/bin/pr-hero"]);
  });

  test("(e) the install's own pr-hero link and crysk are not shadows of themselves", async () => {
    const shadows = await detectShadowInstalls({
      currentBinary: current,
      which: async (bin) =>
        bin === "pr-hero"
          ? ["/home/u/.crysk/bin/pr-hero"]
          : ["/home/u/.crysk/bin/crysk"],
    });
    expect(shadows).toEqual([]);
  });

  test("the same shadow found under both names is reported once", async () => {
    const shadows = await detectShadowInstalls({
      currentBinary: current,
      which: async () => ["/usr/local/bin/x"],
    });
    expect(shadows).toEqual(["/usr/local/bin/x"]);
  });
});
