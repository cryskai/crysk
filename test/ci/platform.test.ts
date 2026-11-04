import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendGithubOutput,
  exchangePlatformToken,
  PLATFORM_API_URL,
  runPlatformConnect,
} from "../../src/ci/platform";

const OIDC_URL = "https://token.actions.example/id?api-version=2.0";
const OIDC_REQUEST_TOKEN = "request-bearer-secret";
const OIDC_JWT = "oidc.jwt.secret";
const GITHUB_TOKEN = "ghs_installation_secret";
const RUN_TOKEN = "run_token_secret";
const BASE = "https://platform.test";

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN,
  CRYSK_DISPATCH_ID: "dispatch-123",
};

interface Call {
  url: string;
  init: RequestInit;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SUCCESS = {
  github_token: GITHUB_TOKEN,
  github_token_expires_at: "2026-11-04T12:00:00Z",
  run_token: RUN_TOKEN,
  run_token_expires_at: "2026-11-04T12:30:00Z",
};

// A fake fetch that answers the OIDC endpoint and the platform separately.
function fakeFetch(
  platform: () => Response | Promise<Response>,
  oidc: () => Response = () => json(200, { value: OIDC_JWT }),
) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init: init ?? {} });
    return href.startsWith(OIDC_URL) ? oidc() : platform();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function headerOf(call: Call, name: string): string | undefined {
  return new Headers(call.init.headers).get(name) ?? undefined;
}

describe("exchangePlatformToken", () => {
  test("returns the installation token and sends the audience, bearer and dispatch id", async () => {
    const { fn, calls } = fakeFetch(() => json(200, SUCCESS));
    const masked: string[] = [];
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: BASE,
      mask: (value) => masked.push(value),
    });
    expect(result).toEqual({
      ok: true,
      githubToken: GITHUB_TOKEN,
      runToken: RUN_TOKEN,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${OIDC_URL}&audience=crysk`);
    expect(headerOf(calls[0] as Call, "authorization")).toBe(
      `bearer ${OIDC_REQUEST_TOKEN}`,
    );
    expect(calls[1]?.url).toBe(`${BASE}/runs/token`);
    expect(calls[1]?.init.method).toBe("POST");
    expect(headerOf(calls[1] as Call, "authorization")).toBe(
      `Bearer ${OIDC_JWT}`,
    );
    expect(headerOf(calls[1] as Call, "x-crysk-dispatch-id")).toBe(
      "dispatch-123",
    );
    // Every secret that crossed the wire is masked before it is returned.
    expect(masked).toEqual(
      expect.arrayContaining([OIDC_JWT, GITHUB_TOKEN, RUN_TOKEN]),
    );
  });

  test("the production base URL is the constant, not an input", () => {
    expect(PLATFORM_API_URL).toBe("https://api.crysk.dev");
  });

  for (const [status, message] of [
    [401, "token not issued for audience crysk"],
    [403, "repo not connected"],
    [409, "token already exchanged"],
    [429, "rate limited"],
  ] as const) {
    test(`HTTP ${status} becomes a failure naming the status and message`, async () => {
      const { fn } = fakeFetch(() => json(status, { message }));
      const result = await exchangePlatformToken({
        fetch: fn,
        env: ENV,
        baseUrl: BASE,
        mask: () => {},
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain(String(status));
      expect(result.message).toContain(message);
    });
  }

  test("a non-JSON error body still names the status", async () => {
    const { fn } = fakeFetch(
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: BASE,
      mask: () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("502");
  });

  test("missing OIDC env names id-token: write and calls nothing", async () => {
    const { fn, calls } = fakeFetch(() => json(200, SUCCESS));
    const result = await exchangePlatformToken({
      fetch: fn,
      env: { CRYSK_DISPATCH_ID: "d" },
      baseUrl: BASE,
      mask: () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("id-token: write");
    expect(calls).toHaveLength(0);
  });

  test("an OIDC endpoint that keeps failing is retried, then fails without reaching the platform", async () => {
    const { fn, calls } = fakeFetch(
      () => json(200, SUCCESS),
      () => json(500, { message: "boom" }),
    );
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: BASE,
      mask: () => {},
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("500");
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => !call.url.startsWith(BASE))).toBe(true);
  });

  test("a transient OIDC blip is retried and the exchange then succeeds, with one platform POST", async () => {
    let oidcCalls = 0;
    const { fn, calls } = fakeFetch(
      () => json(200, SUCCESS),
      () => {
        oidcCalls++;
        if (oidcCalls === 1) throw new Error("socket hang up");
        if (oidcCalls === 2) return json(503, {});
        return json(200, { value: OIDC_JWT });
      },
    );
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: BASE,
      mask: () => {},
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(oidcCalls).toBe(3);
    expect(calls.filter((call) => call.url.startsWith(BASE))).toHaveLength(1);
  });

  test("an OIDC client error is not retried", async () => {
    const { fn, calls } = fakeFetch(
      () => json(200, SUCCESS),
      () => json(403, {}),
    );
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: BASE,
      mask: () => {},
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("two exchanges in one run each request a NEW OIDC token from GitHub", async () => {
    const { fn, calls } = fakeFetch(() => json(200, SUCCESS));
    for (let i = 0; i < 2; i++) {
      const result = await exchangePlatformToken({
        fetch: fn,
        env: ENV,
        baseUrl: BASE,
        mask: () => {},
        sleep: async () => {},
      });
      expect(result.ok).toBe(true);
    }
    const oidcCalls = calls.filter((call) => call.url.startsWith(OIDC_URL));
    expect(oidcCalls).toHaveLength(2);
    expect(calls.filter((call) => call.url.startsWith(BASE))).toHaveLength(2);
  });

  test("a platform failure is never retried: the platform refuses a second exchange of one OIDC token", async () => {
    const { fn, calls } = fakeFetch(() =>
      json(502, { message: "bad gateway" }),
    );
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: BASE,
      mask: () => {},
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(calls.filter((call) => call.url.startsWith(BASE))).toHaveLength(1);
  });

  test("an OIDC response without a value fails", async () => {
    const { fn } = fakeFetch(
      () => json(200, SUCCESS),
      () => json(200, {}),
    );
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: BASE,
      mask: () => {},
    });
    expect(result.ok).toBe(false);
  });

  test("a thrown fetch error is a failure, and carries no token", async () => {
    const fn = (async () => {
      throw new Error(`connect refused ${OIDC_REQUEST_TOKEN}`);
    }) as unknown as typeof fetch;
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: BASE,
      mask: () => {},
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain(OIDC_REQUEST_TOKEN);
  });

  test("a 200 without a usable github_token fails", async () => {
    for (const body of [
      {},
      { ...SUCCESS, github_token: "" },
      { ...SUCCESS, github_token: "a\nb=c" },
      { ...SUCCESS, run_token: undefined },
    ]) {
      const { fn } = fakeFetch(() => json(200, body));
      const result = await exchangePlatformToken({
        fetch: fn,
        env: ENV,
        baseUrl: BASE,
        mask: () => {},
      });
      expect(result.ok).toBe(false);
    }
  });

  test("tokens never appear in any failure message, even one the API echoes", async () => {
    const secrets = [OIDC_JWT, OIDC_REQUEST_TOKEN, GITHUB_TOKEN, RUN_TOKEN];
    const scenarios = [
      fakeFetch(() => json(403, { message: `denied for ${OIDC_JWT}` })),
      fakeFetch(() =>
        json(200, { ...SUCCESS, github_token: `${GITHUB_TOKEN} x` }),
      ),
      fakeFetch(
        () => json(200, SUCCESS),
        () => json(401, { message: `bad ${OIDC_REQUEST_TOKEN}` }),
      ),
    ];
    for (const { fn } of scenarios) {
      const result = await exchangePlatformToken({
        fetch: fn,
        env: ENV,
        baseUrl: BASE,
        mask: () => {},
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      for (const secret of secrets)
        expect(result.message).not.toContain(secret);
    }
  });
});

describe("runPlatformConnect", () => {
  function harness(platform: () => Response) {
    const events: string[] = [];
    const { fn } = fakeFetch(platform);
    return {
      events,
      run: () =>
        runPlatformConnect({
          fetch: fn,
          env: ENV,
          baseUrl: BASE,
          stdout: (text) => events.push(`stdout:${text}`),
          appendOutput: (text) => events.push(`output:${text}`),
        }),
    };
  }

  test("a login the platform returned is written as github-actor, after the token", async () => {
    const h = harness(() =>
      json(200, { ...SUCCESS, github_actor: "crysk-dev[bot]" }),
    );
    expect(await h.run()).toBe(0);
    const outputs = h.events.filter((e) => e.startsWith("output:"));
    expect(outputs).toEqual([
      `output:github-token=${GITHUB_TOKEN}\n`,
      `output:run-token=${RUN_TOKEN}\n`,
      "output:github-actor=crysk-dev[bot]\n",
    ]);
  });

  test("no login, or one that is not a plausible login, writes no github-actor", async () => {
    for (const actor of [undefined, "", "a\nevil=1", "x y", 7]) {
      const h = harness(() => json(200, { ...SUCCESS, github_actor: actor }));
      expect(await h.run()).toBe(0);
      expect(h.events.join("")).not.toContain("github-actor");
    }
  });

  test("masks both tokens before writing the output, then exits 0", async () => {
    const h = harness(() => json(200, SUCCESS));
    expect(await h.run()).toBe(0);
    const firstOutput = h.events.findIndex((e) => e.startsWith("output:"));
    const maskGithub = h.events.findIndex((e) =>
      e.includes(`::add-mask::${GITHUB_TOKEN}`),
    );
    const maskRun = h.events.findIndex((e) =>
      e.includes(`::add-mask::${RUN_TOKEN}`),
    );
    expect(maskGithub).toBeGreaterThanOrEqual(0);
    expect(maskRun).toBeGreaterThanOrEqual(0);
    expect(firstOutput).toBeGreaterThan(Math.max(maskGithub, maskRun));
    expect(h.events).toContain(`output:github-token=${GITHUB_TOKEN}\n`);
    expect(h.events).toContain(`output:run-token=${RUN_TOKEN}\n`);
  });

  test("a failure prints an error, writes no output and exits 1", async () => {
    const h = harness(() => json(409, { message: "token already exchanged" }));
    expect(await h.run()).toBe(1);
    expect(h.events.some((e) => e.startsWith("output:"))).toBe(false);
    const text = h.events.join("");
    expect(text).toContain("::error");
    expect(text).toContain("409");
    expect(text).not.toContain(GITHUB_TOKEN);
  });

  test("a token that cannot be persisted is an error and exits 1, never a green step", async () => {
    const events: string[] = [];
    const { fn } = fakeFetch(() => json(200, SUCCESS));
    const code = await runPlatformConnect({
      fetch: fn,
      env: ENV,
      baseUrl: BASE,
      stdout: (text) => events.push(text),
      appendOutput: () => {
        throw new Error("GITHUB_OUTPUT is not set");
      },
    });
    expect(code).toBe(1);
    const text = events.join("");
    expect(text).toContain("::error");
    expect(text).toContain("GITHUB_OUTPUT is not set");
    expect(text.replace(`::add-mask::${GITHUB_TOKEN}`, "")).not.toContain(
      GITHUB_TOKEN,
    );
  });
});

describe("platform review configuration", () => {
  const CONFIG = {
    person: { max_changed_lines: 4000, scout: false },
    repo: { default_base: "release" },
  };

  function connect(
    body: unknown,
    options: { configDir?: string } = {},
  ): { events: string[]; run: () => Promise<number> } {
    const events: string[] = [];
    const { fn } = fakeFetch(() => json(200, { ...SUCCESS, config: body }));
    return {
      events,
      run: () =>
        runPlatformConnect({
          fetch: fn,
          env: ENV,
          baseUrl: BASE,
          stdout: (text) => events.push(`stdout:${text}`),
          appendOutput: (text) => events.push(`output:${text}`),
          ...options,
        }),
    };
  }

  async function exchange(body: unknown) {
    const { fn } = fakeFetch(() => json(200, { ...SUCCESS, config: body }));
    return await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: BASE,
      mask: () => {},
    });
  }

  test("a non-empty config is returned with the tokens", async () => {
    expect(await exchange(CONFIG)).toEqual({
      ok: true,
      githubToken: GITHUB_TOKEN,
      runToken: RUN_TOKEN,
      config: CONFIG,
    });
  });

  test("a layer left out is an empty layer", async () => {
    const result = await exchange({ repo: { default_base: "x" } });
    expect(result.ok && result.config).toEqual({
      person: {},
      repo: { default_base: "x" },
    });
  });

  test.each([
    ["absent", undefined],
    ["null", null],
    ["empty objects", { person: {}, repo: {} }],
    ["an empty config", {}],
  ])("%s means no configuration: the result carries none", async (_l, body) => {
    const result = await exchange(body);
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("config");
  });

  test.each([
    ["a string", "SENTINEL-CONFIG-1"],
    ["an array", []],
    ["a person that is not an object", { person: "SENTINEL-PERSON-2" }],
    ["a repo that is an array", { repo: [] }],
  ])("%s is a loud failure that leaks nothing", async (_l, body) => {
    const result = await exchange(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("config");
    expect(result.message).not.toContain("SENTINEL");
    expect(result.message).not.toContain(GITHUB_TOKEN);
  });

  test("the connect step leaves the config as a 0600 file and names it in an output after the tokens", async () => {
    const dir = path.join(
      mkdtempSync(path.join(tmpdir(), "platform-config-")),
      "crysk-platform",
    );
    const h = connect(CONFIG, { configDir: dir });
    expect(await h.run()).toBe(0);
    const file = path.join(dir, "platform-config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(CONFIG);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(h.events.filter((e) => e.startsWith("output:"))).toEqual([
      `output:github-token=${GITHUB_TOKEN}\n`,
      `output:run-token=${RUN_TOKEN}\n`,
      `output:config-file=${file}\n`,
    ]);
    // The token never lands in the config file.
    expect(readFileSync(file, "utf8")).not.toContain(GITHUB_TOKEN);
  });

  test("platform routing that names OpenCode is announced so the CLI gets installed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "platform-config-"));
    const h = connect(
      { person: { routing: { default: { backend: "opencode" } } }, repo: {} },
      { configDir: dir },
    );
    expect(await h.run()).toBe(0);
    expect(h.events).toContain("output:routing-opencode=true\n");
    const claude = connect(
      { person: { routing: { default: { backend: "claude-code" } } } },
      { configDir: dir },
    );
    expect(await claude.run()).toBe(0);
    expect(claude.events.join("")).not.toContain("routing-opencode");
  });

  test.each([
    ["absent", undefined],
    ["empty objects", { person: {}, repo: {} }],
  ])("%s config writes no file and no config output", async (_l, body) => {
    const dir = path.join(
      mkdtempSync(path.join(tmpdir(), "platform-config-")),
      "crysk-platform",
    );
    const h = connect(body, { configDir: dir });
    expect(await h.run()).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(h.events.join("")).not.toContain("config-file");
  });

  test("a refresh step (no config directory) ignores the config in its response", async () => {
    const h = connect(CONFIG);
    expect(await h.run()).toBe(0);
    expect(h.events.join("")).not.toContain("config-file");
  });

  test("a config that cannot be written is an error naming the file, writes no output and exits 1", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "platform-config-"));
    // A file where the directory must go makes every write beneath it fail.
    const blocker = path.join(parent, "blocker");
    writeFileSync(blocker, "x");
    const dir = path.join(blocker, "crysk-platform");
    const h = connect(CONFIG, { configDir: dir });
    expect(await h.run()).toBe(1);
    expect(h.events.some((e) => e.startsWith("output:"))).toBe(false);
    const text = h.events.join("");
    expect(text).toContain("::error");
    expect(text).toContain(path.join(dir, "platform-config.json"));
    expect(text.replace(`::add-mask::${GITHUB_TOKEN}`, "")).not.toContain(
      GITHUB_TOKEN,
    );
  });
});

describe("appendGithubOutput", () => {
  test.each([undefined, ""])(
    "refuses to run when GITHUB_OUTPUT is %p",
    (outputPath) => {
      expect(() => appendGithubOutput(outputPath, "github-token=x\n")).toThrow(
        /GITHUB_OUTPUT/,
      );
    },
  );

  test("appends to the file the runner named", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "platform-")), "o");
    appendGithubOutput(file, "github-token=x\n");
    appendGithubOutput(file, "other=y\n");
    expect(readFileSync(file, "utf8")).toBe("github-token=x\nother=y\n");
  });
});

describe("action.yml platform wiring", () => {
  type Step = {
    id?: string;
    name?: string;
    if?: string;
    env?: Record<string, string>;
    run?: string;
  };
  const action = Bun.YAML.parse(
    readFileSync(path.join(import.meta.dir, "../../action.yml"), "utf-8"),
  ) as { runs: { steps: Step[] } };
  const steps = action.runs.steps;
  const find = (id: string) => steps.find((s) => s.id === id) as Step;

  test("Connect to Crysk runs before Resolve trigger, gated on platform mode", () => {
    const connect = steps.findIndex((s) => s.id === "platform");
    const trigger = steps.findIndex((s) => s.id === "trigger");
    expect(connect).toBeGreaterThanOrEqual(0);
    expect(connect).toBeLessThan(trigger);
    const step = steps[connect] as Step;
    expect(step.name).toBe("Connect to Crysk");
    expect(step.if).toBe(
      "github.event_name == 'workflow_dispatch' && github.event.inputs['dispatch-id'] != ''",
    );
    expect(step.run).toContain("src/ci/platform.ts");
  });

  // Written as "$" + "{{" so the strings are not template-literal lookalikes.
  const expression = (body: string) => `$\{{ ${body} }}`;

  test("the platform step takes its values through env only", () => {
    const step = find("platform");
    // The only expression a script may hold is the action's own path.
    expect(
      step.run?.replace(expression("github.action_path"), ""),
    ).not.toContain("${{");
    expect(step.env?.CRYSK_DISPATCH_ID).toBe(
      expression("github.event.inputs['dispatch-id']"),
    );
    expect(JSON.stringify(step.env)).not.toMatch(/api\.crysk|https?:/);
  });

  test("the early token-consuming steps fall back to inputs.github-token", () => {
    const expr = expression(
      "steps.platform.outputs.github-token || inputs.github-token",
    );
    expect(find("trigger").env?.GH_TOKEN).toBe(expr);
    expect(find("run-crysk").env?.GITHUB_TOKEN).toBe(expr);
  });

  test("the late steps prefer a freshly exchanged token", () => {
    expect(find("publish").env?.GH_TOKEN).toBe(
      expression(
        "steps.platform-publish.outputs.github-token || steps.platform.outputs.github-token || inputs.github-token",
      ),
    );
    expect(find("cancel-settle").env?.GH_TOKEN).toBe(
      expression(
        "steps.platform-settle.outputs.github-token || steps.platform.outputs.github-token || inputs.github-token",
      ),
    );
    // No step reads the bare input.
    const bare = steps.filter((s) =>
      Object.values(s.env ?? {}).includes(expression("inputs.github-token")),
    );
    expect(bare).toEqual([]);
  });

  test("the refresh steps run the same exchange, after Run Crysk, only in platform mode", () => {
    const run = steps.findIndex((s) => s.id === "run-crysk");
    const platformMode =
      "github.event_name == 'workflow_dispatch' && github.event.inputs['dispatch-id'] != ''";
    for (const [id, consumer, gate] of [
      ["platform-publish", "publish", "!cancelled()"],
      ["platform-settle", "cancel-settle", "cancelled()"],
    ] as const) {
      const at = steps.findIndex((s) => s.id === id);
      const step = steps[at] as Step;
      expect(at).toBeGreaterThan(run);
      expect(at).toBeLessThan(steps.findIndex((s) => s.id === consumer));
      expect(step.run).toContain("src/ci/platform.ts");
      expect(step.if).toContain(platformMode);
      expect(step.if).toContain(gate);
      expect(step.env?.CRYSK_DISPATCH_ID).toBe(
        expression("github.event.inputs['dispatch-id']"),
      );
    }
    // The publish refresh follows the publish gate, so it never runs for a run
    // that publishes nothing.
    expect(find("platform-publish").if).toContain(
      "steps.trigger.outputs.publish == 'true'",
    );
    expect(find("platform-settle").if).toContain(
      "steps.trigger.outputs.run == 'true'",
    );
  });

  test("Run Crysk hands the platform's actor login to the gate, from the platform step only", () => {
    expect(find("run-crysk").env?.CRYSK_PLATFORM_ACTOR).toBe(
      expression("steps.platform.outputs.github-actor"),
    );
  });
});
