// install.sh must pick the same home as resolveHomeDir (src/brand-paths.ts),
// put the binary in <home>/bin and write a PATH line for that same dir.
// Run for real under a fake HOME with a fake `curl`, so nothing is downloaded
// and the real ~ is never touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
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

// The fake curl: for a SHA256SUMS URL it writes a matching sums file for every
// target; for the binary URL it writes a tiny executable. Both are verified by
// the script's real sha256 step.
const FAKE_CURL = `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *SHA256SUMS)
    sum="$(printf '#!/bin/sh\\necho fake\\n' | shasum -a 256 | cut -d' ' -f1)"
    for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
      echo "$sum  pr-hero-$t"
    done > "$out"
    ;;
  *) printf '#!/bin/sh\\necho fake\\n' > "$out" ;;
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

function install() {
  const r = Bun.spawnSync(["bash", SCRIPT], {
    cwd: root,
    env: {
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
    expect(existsSync(path.join(home, ".crysk", "bin", "pr-hero"))).toBe(true);
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
    expect(existsSync(path.join(home, ".prhero", "bin", "pr-hero"))).toBe(true);
    expect(existsSync(path.join(home, ".crysk"))).toBe(false);
    expect(zshrc()).toContain(".prhero/bin");
    expect(zshrc()).not.toContain(".crysk/bin");
    expect(r.out).toContain('export PATH="$HOME/.prhero/bin:$PATH"');
  });

  test("an empty ~/.crysk beside a stateful ~/.prhero does not move the install", () => {
    state(".prhero");
    mkdirSync(path.join(home, ".crysk"));
    install();
    expect(existsSync(path.join(home, ".prhero", "bin", "pr-hero"))).toBe(true);
    expect(existsSync(path.join(home, ".crysk", "bin"))).toBe(false);
  });

  test("a stateful ~/.crysk wins over ~/.prhero", () => {
    state(".prhero");
    state(".crysk");
    install();
    expect(existsSync(path.join(home, ".crysk", "bin", "pr-hero"))).toBe(true);
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
      expect(existsSync(path.join(dir, "bin", "pr-hero"))).toBe(true);
    }
  });
});
