// The pr-hero → Crysk rename keeps reading the old paths for one version and
// tells the user how to move. These drive runDoctor through its injected
// filesystem, so no real HOME or repo is touched.

import { describe, expect, test } from "bun:test";
import { runDoctor } from "../src/doctor";

const GOTCHAS = "## Gotchas\nDo not mutate state.";

async function doctorWith(present: string[]) {
  const files = new Set(present);
  return await runDoctor({
    cwd: "/repo",
    home: "/home/user",
    exists: (p) => files.has(p),
    readFile: (p) => (p.endsWith("gotchas.md") ? GOTCHAS : undefined),
    checkToolsOptions: {
      which: (bin) => `/bin/${bin}`,
      exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
      env: { ANTHROPIC_API_KEY: "sk-test" },
    },
  });
}

describe("doctor suggests migrating off the legacy paths", () => {
  test("a legacy-only home is degraded and names the mv command", async () => {
    const report = await doctorWith(["/home/user/.prhero"]);
    const check = report.checks.find((c) => c.name === "migrate:home");
    expect(check?.severity).toBe("degraded");
    expect(check?.hint).toContain("mv ~/.prhero ~/.crysk");
  });

  test("a legacy-only repo dir and ignore file get git mv commands", async () => {
    const report = await doctorWith([
      "/repo/.prhero",
      "/repo/.prhero/gotchas.md",
      "/repo/.prheroignore",
    ]);
    expect(
      report.checks.find((c) => c.name === "migrate:repo")?.hint,
    ).toContain("git mv .prhero .crysk");
    expect(
      report.checks.find((c) => c.name === "migrate:ignore")?.hint,
    ).toContain("git mv .prheroignore .cryskignore");
    // The legacy gotchas file is still the one read, so it is not reported missing.
    expect(report.checks.find((c) => c.name === "gotchas")?.severity).toBe(
      "healthy",
    );
  });

  test("when both exist the old one is reported as ignored, with no mv suggestion", async () => {
    const report = await doctorWith([
      "/home/user/.crysk",
      "/home/user/.prhero",
      "/repo/.crysk",
      "/repo/.prhero",
      "/repo/.crysk/gotchas.md",
    ]);
    const home = report.checks.find((c) => c.name === "migrate:home");
    expect(home?.severity).toBe("degraded");
    expect(home?.message).toContain("ignored");
    expect(home?.hint ?? "").not.toContain("mv ~/.prhero");
    const repo = report.checks.find((c) => c.name === "migrate:repo");
    expect(repo?.message).toContain("ignored");
  });

  test("a fully migrated setup reports nothing to migrate", async () => {
    const report = await doctorWith([
      "/home/user/.crysk",
      "/repo/.crysk",
      "/repo/.crysk/gotchas.md",
      "/repo/.cryskignore",
    ]);
    expect(report.checks.filter((c) => c.name.startsWith("migrate:"))).toEqual(
      [],
    );
  });
});
