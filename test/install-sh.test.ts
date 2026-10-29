// install.sh must pick the same home as resolveHomeDir (src/brand-paths.ts),
// put the binary in <home>/bin and write a PATH line for that same dir.
// Run for real under a fake HOME with a fake `curl`, so nothing is downloaded
// and the real ~ is never touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveHomeDir } from "../src/brand-paths";

const SCRIPT = path.join(import.meta.dir, "../install.sh");

// The fake curl: a SHA256SUMS URL gets a matching sums file for every asset the
// fake release has, a binary URL gets a tiny executable that prints its own
// asset name. FAKE_RELEASE=legacy models a release made before the rename (no
// crysk-<target> asset: curl --fail exits 22 on the 404); FAKE_RELEASE=tampered
// serves bytes that do not match the sums. Both are verified by the script's
// real sha256 step.
const FAKE_CURL = `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
name="$(basename "$url")"
case "$name" in
  SHA256SUMS)
    for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
      for a in crysk pr-hero; do
        if [ "$a" = crysk ] && [ "\${FAKE_RELEASE:-}" = legacy ]; then continue; fi
        sum="$(printf '#!/bin/sh\\necho fake-%s\\n' "$a-$t" | shasum -a 256 | cut -d' ' -f1)"
        echo "$sum  $a-$t"
      done
    done > "$out"
    ;;
  *)
    if [ "$name" != "\${name#crysk-}" ] && [ "\${FAKE_RELEASE:-}" = legacy ]; then exit 22; fi
    if [ "\${FAKE_RELEASE:-}" = tampered ]; then
      printf '#!/bin/sh\\necho tampered\\n' > "$out"
    else
      printf '#!/bin/sh\\necho fake-%s\\n' "$name" > "$out"
    fi
    ;;
esac
`;

let root: string;
let home: string;
let fakeBin: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "crysk-install-"));
  home = path.join(root, "home");
  fakeBin = path.join(root, "bin");
  mkdirSync(home);
  mkdirSync(fakeBin);
  writeFileSync(path.join(fakeBin, "curl"), FAKE_CURL);
  chmodSync(path.join(fakeBin, "curl"), 0o755);
  writeFileSync(path.join(home, ".zshrc"), "# my zshrc\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function install(extraEnv: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", SCRIPT], {
    cwd: root,
    env: {
      ...extraEnv,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      PRHERO_VERSION: "9.9.9",
      SHELL: "/bin/zsh",
    },
  });
  return { code: r.exitCode, out: `${r.stdout}${r.stderr}` };
}

const zshrc = () => readFileSync(path.join(home, ".zshrc"), "utf8");
const state = (dir: string) => {
  mkdirSync(path.join(home, dir), { recursive: true });
  writeFileSync(path.join(home, dir, "config.json"), "{}");
};

describe("install.sh picks the home resolveHomeDir would", () => {
  test("a fresh machine installs into ~/.crysk/bin and adds that PATH line", () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(existsSync(path.join(home, ".crysk", "bin", "crysk"))).toBe(true);
    expect(existsSync(path.join(home, ".prhero"))).toBe(false);
    expect(zshrc()).toContain(".crysk/bin");
    expect(zshrc()).not.toContain(".prhero/bin");
    expect(r.out).toContain('export PATH="$HOME/.crysk/bin:$PATH"');
    expect(r.out).not.toContain("scaffolds .prhero/");
  });

  test("a legacy-only ~/.prhero keeps its binary in ~/.prhero/bin and no ~/.crysk is created", () => {
    state(".prhero");
    const r = install();
    expect(r.code).toBe(0);
    expect(existsSync(path.join(home, ".prhero", "bin", "crysk"))).toBe(true);
    expect(existsSync(path.join(home, ".crysk"))).toBe(false);
    expect(zshrc()).toContain(".prhero/bin");
    expect(zshrc()).not.toContain(".crysk/bin");
    expect(r.out).toContain('export PATH="$HOME/.prhero/bin:$PATH"');
  });

  test("an empty ~/.crysk beside a stateful ~/.prhero does not move the install", () => {
    state(".prhero");
    mkdirSync(path.join(home, ".crysk"));
    install();
    expect(existsSync(path.join(home, ".prhero", "bin", "crysk"))).toBe(true);
    expect(existsSync(path.join(home, ".crysk", "bin"))).toBe(false);
  });

  test("a stateful ~/.crysk wins over ~/.prhero", () => {
    state(".prhero");
    state(".crysk");
    install();
    expect(existsSync(path.join(home, ".crysk", "bin", "crysk"))).toBe(true);
    expect(zshrc()).toContain(".crysk/bin");
  });

  test("running it twice adds the PATH line once", () => {
    install();
    install();
    expect(zshrc().match(/\.crysk\/bin/g)?.length).toBe(1);
  });

  test("the shell rule and resolveHomeDir agree on every layout", () => {
    // Guards drift between install.sh and the TypeScript resolver.
    const layouts: Array<[string, string[], string[]]> = [
      ["fresh", [], []],
      ["legacy state", [], [".prhero"]],
      ["crysk state", [".crysk"], []],
      ["both state", [".crysk"], [".prhero"]],
    ];
    for (const [, crysk, prhero] of layouts) {
      rmSync(path.join(home, ".crysk"), { recursive: true, force: true });
      rmSync(path.join(home, ".prhero"), { recursive: true, force: true });
      for (const d of [...crysk, ...prhero]) state(d);
      install();
      const dir = resolveHomeDir(home);
      expect(existsSync(path.join(dir, "bin", "crysk"))).toBe(true);
    }
  });
});

// (f) The binary is `crysk`; `pr-hero` stays as a link for one version so every
// existing PATH line, alias and CI script keeps working.
describe("install.sh installs crysk and keeps pr-hero answering", () => {
  const bin = () => path.join(home, ".crysk", "bin");
  const out = (name: string) =>
    `${Bun.spawnSync([path.join(bin(), name)]).stdout}`.trim();

  test("a current release gives crysk-<target> under both names", () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(lstatSync(path.join(bin(), "pr-hero")).isSymbolicLink()).toBe(true);
    expect(out("crysk")).toMatch(/^fake-crysk-/);
    expect(out("pr-hero")).toBe(out("crysk"));
  });

  test("a release without a crysk asset falls back to pr-hero-<target>, verified against its own sums line", () => {
    const r = install({ FAKE_RELEASE: "legacy" });
    expect(r.code).toBe(0);
    expect(out("crysk")).toMatch(/^fake-pr-hero-/);
    expect(out("pr-hero")).toBe(out("crysk"));
  });

  test("re-running over a legacy regular-file pr-hero replaces it with the link", () => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(path.join(home, ".crysk", "config.json"), "{}");
    writeFileSync(path.join(bin(), "pr-hero"), "#!/bin/sh\necho old\n");
    chmodSync(path.join(bin(), "pr-hero"), 0o755);
    install();
    expect(lstatSync(path.join(bin(), "pr-hero")).isSymbolicLink()).toBe(true);
    expect(out("pr-hero")).toMatch(/^fake-crysk-/);
  });

  test("bytes that do not match the SHA256SUMS line abort the install and leave nothing behind", () => {
    const r = install({ FAKE_RELEASE: "tampered" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("SHA256 checksum verification failed");
    expect(existsSync(path.join(bin(), "crysk"))).toBe(false);
    expect(existsSync(path.join(bin(), "pr-hero"))).toBe(false);
  });
});
