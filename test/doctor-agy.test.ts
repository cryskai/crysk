// odd/tasks/antigravity-oauth.md T5 (S7): the doctor checks the Antigravity CLI
// and the login its steps would read, only when the configuration names an
// `agy:` model, and never prints the token.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProfile } from "#model/profiles";
import {
  antigravityDoctorChecks,
  loadDoctorRouting,
  routingNeedsAntigravity,
  runDoctor,
} from "../src/doctor";
import type { CheckSystemToolsOptions } from "../src/system-tools";

const TOKEN_FILE = JSON.stringify({
  token: {
    access_token: "SENTINEL-AGY-ACCESS-31",
    token_type: "Bearer",
    refresh_token: "SENTINEL-AGY-REFRESH-31",
    expiry: "2026-11-15T10:00:00Z",
  },
  auth_method: "consumer",
});
const CI_RECORD = JSON.stringify({
  type: "oauth",
  access: "SENTINEL-AGY-ACCESS-31",
  refresh: "SENTINEL-AGY-REFRESH-31",
  expires: 1_700_000_000_000,
});

function tools(input: {
  agy?: boolean;
  files?: Record<string, string>;
  env?: Record<string, string | undefined>;
}): CheckSystemToolsOptions & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    which: (bin) =>
      bin === "agy"
        ? input.agy === false
          ? null
          : "/opt/agy/agy"
        : `/bin/${bin}`,
    exec: async (cmd) =>
      cmd[0] === "/opt/agy/agy"
        ? { exitCode: 0, stdout: "1.5.9\n", stderr: "" }
        : { exitCode: 0, stdout: "1.0.0", stderr: "" },
    env: input.env ?? {},
    home: "/home/dev",
    readText: async (file) => {
      reads.push(file);
      const text = input.files?.[file];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  };
}

const LOCAL_TOKEN = "/home/dev/.gemini/antigravity-cli/antigravity-oauth-token";
const CI_RECORD_PATH = "/home/dev/.local/share/crysk/antigravity-auth.json";

describe("routingNeedsAntigravity", () => {
  const profile = resolveProfile(undefined);
  test("an agy: model in any role or fallback needs it", () => {
    expect(
      routingNeedsAntigravity(
        { "hunter.logic": ["agy:gemini-4-argon-high"] },
        profile,
      ),
    ).toBe(true);
    expect(
      routingNeedsAntigravity(
        { default: ["claude:sonnet-latest", "agy:gemini-4-argon-high"] },
        profile,
      ),
    ).toBe(true);
  });

  test("Claude or OpenCode models, or none, do not", () => {
    expect(routingNeedsAntigravity(undefined, profile)).toBe(false);
    expect(
      routingNeedsAntigravity(
        { default: ["claude:sonnet-latest", "opencode:openai/gpt-5.5"] },
        resolveProfile("openai"),
      ),
    ).toBe(false);
  });
});

describe("loadDoctorRouting reads antigravityRequired from the config", () => {
  async function routingFor(person: unknown) {
    const home = await mkdtemp(path.join(tmpdir(), "crysk-doctor-agy-"));
    try {
      await mkdir(path.join(home, ".crysk"), { recursive: true });
      await writeFile(
        path.join(home, ".crysk", "config.json"),
        JSON.stringify(person),
      );
      return await loadDoctorRouting({ home, env: {} });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  test("an agy: model sets it", async () => {
    const routing = await routingFor({
      models: { default: ["agy:gemini-4-argon-high"] },
    });
    expect(routing.error).toBeUndefined();
    expect(routing.antigravityRequired).toBe(true);
  });

  test("a Claude-only config leaves it false", async () => {
    const routing = await routingFor({
      models: { default: ["claude:sonnet-latest"] },
    });
    expect(routing.antigravityRequired).toBe(false);
  });
});

describe("antigravityDoctorChecks", () => {
  test("installed, with agy's own token file locally: healthy, and no token in any line", async () => {
    const options = tools({ files: { [LOCAL_TOKEN]: TOKEN_FILE } });
    const checks = await antigravityDoctorChecks(options);
    expect(checks.map((c) => [c.name, c.severity])).toEqual([
      ["agy", "healthy"],
      ["agy-login", "healthy"],
    ]);
    expect(checks[0]?.message).toContain("1.5.9");
    expect(checks[1]?.message).toContain(LOCAL_TOKEN);
    expect(options.reads).toEqual([LOCAL_TOKEN]);
    expect(JSON.stringify(checks)).not.toContain("SENTINEL");
  });

  test("in CI it reads the record the setup step wrote, not a token file on the runner", async () => {
    const options = tools({
      env: { GITHUB_ACTIONS: "true" },
      files: { [CI_RECORD_PATH]: CI_RECORD, [LOCAL_TOKEN]: TOKEN_FILE },
    });
    const checks = await antigravityDoctorChecks(options);
    expect(checks[1]?.severity).toBe("healthy");
    expect(options.reads).toEqual([CI_RECORD_PATH]);
    expect(JSON.stringify(checks)).not.toContain("SENTINEL");
  });

  test("agy missing is blocking, with how to get it", async () => {
    const checks = await antigravityDoctorChecks(
      tools({ agy: false, files: { [LOCAL_TOKEN]: TOKEN_FILE } }),
    );
    expect(checks[0]).toMatchObject({ name: "agy", severity: "blocking" });
    expect(checks[0]?.hint).toContain("agy");
  });

  test("no login is blocking, and in CI names the secret", async () => {
    const local = await antigravityDoctorChecks(tools({}));
    expect(local[1]).toMatchObject({ name: "agy-login", severity: "blocking" });
    expect(local[1]?.message).toContain(
      `no Antigravity login at ${LOCAL_TOKEN}`,
    );
    const ci = await antigravityDoctorChecks(
      tools({ agy: false, env: { GITHUB_ACTIONS: "true" } }),
    );
    expect(ci[1]?.severity).toBe("blocking");
    expect(ci[1]?.hint).toContain("CRYSK_ANTIGRAVITY_OAUTH");
  });

  test("a login with no refresh token is blocking, and its content is not printed", async () => {
    const checks = await antigravityDoctorChecks(
      tools({
        files: {
          [LOCAL_TOKEN]: JSON.stringify({
            token: {
              access_token: "SENTINEL-AGY-ACCESS-31",
              refresh_token: "",
              expiry: "2026-11-15T10:00:00Z",
            },
          }),
        },
      }),
    );
    expect(checks[1]?.severity).toBe("blocking");
    expect(checks[1]?.message).toContain("not one agy can renew");
    expect(JSON.stringify(checks)).not.toContain("SENTINEL");
  });
});

describe("runDoctor adds the agy checks only when asked", () => {
  const base = {
    cwd: "/repo",
    home: "/home/dev",
    exists: () => false,
    readFile: () => undefined,
  };

  test("antigravityRequired: true adds agy and agy-login", async () => {
    const report = await runDoctor({
      ...base,
      antigravityRequired: true,
      checkToolsOptions: tools({ files: { [LOCAL_TOKEN]: TOKEN_FILE } }),
    });
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("agy");
    expect(names).toContain("agy-login");
  });

  test("absent, no agy check runs and agy is never probed", async () => {
    const options = tools({});
    const probed: string[] = [];
    const report = await runDoctor({
      ...base,
      checkToolsOptions: {
        ...options,
        which: (bin) => {
          probed.push(bin);
          return options.which?.(bin) ?? null;
        },
      },
    });
    expect(report.checks.map((c) => c.name)).not.toContain("agy");
    expect(probed).not.toContain("agy");
    expect(options.reads).toEqual([]);
  });
});
