// openai-profile S6 leftover: `crysk update`, the menu and the wizard run the
// doctor too, so they read the person's profile like `crysk doctor` does, and
// a profile with no Claude step never demands the Claude CLI there.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProfile } from "#model/profiles";
import { loadDoctorRouting } from "../src/doctor";

async function withHome(
  person: string | undefined,
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "crysk-doctor-routing-"));
  try {
    if (person !== undefined) {
      await mkdir(path.join(home, ".crysk"), { recursive: true });
      await writeFile(path.join(home, ".crysk", "config.json"), person);
    }
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("loadDoctorRouting", () => {
  test("profile openai alone needs no Claude and carries the profile", async () => {
    await withHome(JSON.stringify({ profile: "openai" }), async (home) => {
      const routing = await loadDoctorRouting({ home, env: {} });
      expect(routing.claudeRequired).toBe(false);
      expect(routing.profile).toBe(resolveProfile("openai"));
      expect(routing.models).toBeUndefined();
    });
  });

  test("no config keeps Claude required on the fallback profile", async () => {
    await withHome(undefined, async (home) => {
      const routing = await loadDoctorRouting({ home, env: {} });
      expect(routing.claudeRequired).toBe(true);
      expect(routing.profile).toBe(resolveProfile(undefined));
    });
  });

  test("a config that fails to load keeps Claude required and reports why", async () => {
    await withHome("{not json", async (home) => {
      const routing = await loadDoctorRouting({ home, env: {} });
      expect(routing.claudeRequired).toBe(true);
      expect(routing.profile).toBe(resolveProfile(undefined));
      expect(routing.error).toContain("is not valid JSON");
    });
  });

  // PR #521 R003: a custom agents_dir's frontmatter outranks the profile.
  test("openai with a custom agents_dir keeps Claude required", async () => {
    await withHome(
      JSON.stringify({ profile: "openai", agents_dir: "/tmp/agents" }),
      async (home) => {
        expect(
          (await loadDoctorRouting({ home, env: {} })).claudeRequired,
        ).toBe(true);
      },
    );
  });

  test("an AGENTS_DIR override keeps Claude required under openai", async () => {
    await withHome(JSON.stringify({ profile: "openai" }), async (home) => {
      for (const name of ["CRYSK_AGENTS_DIR", "PRHERO_AGENTS_DIR"]) {
        const routing = await loadDoctorRouting({
          home,
          env: { [name]: "/tmp/agents" },
        });
        expect(routing.claudeRequired).toBe(true);
      }
      const empty = await loadDoctorRouting({
        home,
        env: { CRYSK_AGENTS_DIR: "" },
      });
      expect(empty.claudeRequired).toBe(false);
    });
  });

  test("openai with a Claude summary still needs Claude", async () => {
    await withHome(
      JSON.stringify({
        profile: "openai",
        models: { summary: ["claude:haiku-latest"] },
      }),
      async (home) => {
        expect(
          (await loadDoctorRouting({ home, env: {} })).claudeRequired,
        ).toBe(true);
      },
    );
  });
});
