import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  exchangePlatformToken,
  PLATFORM_CAPABILITIES,
  runPlatformConnect,
} from "../../src/ci/platform";
import {
  parsePlatformLimits,
  readPlatformLimits,
} from "../../src/ci/platform-limits";

const SRC_CI = path.resolve(import.meta.dir, "../../src/ci");
const OIDC_URL = "https://token.actions.example/id?api-version=2.0";
const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-bearer-secret",
  CRYSK_DISPATCH_ID: "dispatch-123",
};
const SUCCESS = { github_token: "ghs_installation", run_token: "run_token" };
const LIMITS = { review_usd: 12, month_left_usd: 3.5, estimate_usd: 0.87 };

function fakeFetch(body: unknown) {
  const platformCalls: RequestInit[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(OIDC_URL)) {
      return Response.json({ value: "oidc.jwt" });
    }
    platformCalls.push(init ?? {});
    return Response.json(body);
  }) as unknown as typeof fetch;
  return { fn, platformCalls };
}

const capability = (init: RequestInit | undefined) =>
  new Headers(init?.headers).get("x-crysk-capabilities");

const exchange = (body: unknown, extra: { ignoreConfig?: boolean } = {}) => {
  const { fn, platformCalls } = fakeFetch(body);
  return exchangePlatformToken({
    fetch: fn,
    env: ENV,
    baseUrl: "https://platform.test",
    mask: () => {},
    ...extra,
  }).then((result) => ({ result, platformCalls }));
};

async function connect(body: unknown) {
  const outputs: string[] = [];
  const { fn } = fakeFetch(body);
  const code = await runPlatformConnect({
    fetch: fn,
    env: ENV,
    baseUrl: "https://platform.test",
    stdout: () => {},
    appendOutput: (text) => outputs.push(text),
    configDir: path.join(
      mkdtempSync(path.join(tmpdir(), "crysk-limits-")),
      "platform",
    ),
  });
  return { code, outputs };
}

// platform-owned-cost T7 (L55): the first connect step declares `limits`, and
// only then does the token response carry the platform's limits.
describe("the limits at the token exchange", () => {
  test("the first connect step declares the limits capability and returns the platform's limits", async () => {
    const { result, platformCalls } = await exchange({
      ...SUCCESS,
      limits: LIMITS,
    });
    expect(capability(platformCalls[0])?.split(",")).toEqual([
      "profile",
      "limits",
    ]);
    expect(PLATFORM_CAPABILITIES).toBe("profile,limits");
    expect(result).toMatchObject({
      ok: true,
      limits: { reviewUsd: 12, monthLeftUsd: 3.5, estimateUsd: 0.87 },
    });
  });

  test("a refresh step neither asks for limits nor keeps ones sent anyway", async () => {
    const { result, platformCalls } = await exchange(
      { ...SUCCESS, limits: LIMITS },
      { ignoreConfig: true },
    );
    expect(capability(platformCalls[0])).toBeNull();
    expect(result.ok).toBe(true);
    expect("limits" in result).toBe(false);
  });

  test("a response without limits (a forced run, an older platform) leaves them unset and the exchange succeeds", async () => {
    const { result } = await exchange(SUCCESS);
    expect(result.ok).toBe(true);
    expect("limits" in result).toBe(false);
  });

  test("malformed limits are dropped and the exchange still succeeds", async () => {
    for (const limits of ["12", 12, [1, 2], { review_usd: "12" }, {}]) {
      const { result } = await exchange({ ...SUCCESS, limits });
      expect(result.ok).toBe(true);
      expect("limits" in result).toBe(false);
    }
  });

  test("the retired estimate field and usage-facts echo are no longer read", async () => {
    const { result } = await exchange({
      ...SUCCESS,
      estimate: { usd_low: 0.4, usd_high: 0.9, basis: "history" },
      capabilities: ["usage-facts"],
    });
    expect(result.ok).toBe(true);
    expect("estimate" in result).toBe(false);
    expect("usageFacts" in result).toBe(false);
  });
});

describe("the connect step's limits output", () => {
  test("valid limits become one line of JSON in the response's own field names", async () => {
    const { code, outputs } = await connect({ ...SUCCESS, limits: LIMITS });
    expect(code).toBe(0);
    const line = outputs.find((o) => o.startsWith("limits="));
    expect(line).toBe(
      'limits={"review_usd":12,"month_left_usd":3.5,"estimate_usd":0.87}\n',
    );
    // What the run step reads back is the same limits.
    expect(
      readPlatformLimits({
        CRYSK_PLATFORM_LIMITS: line?.slice("limits=".length).trim(),
      }),
    ).toEqual({ reviewUsd: 12, monthLeftUsd: 3.5, estimateUsd: 0.87 });
  });

  test("only the validated fields are written", async () => {
    const { outputs } = await connect({
      ...SUCCESS,
      limits: { review_usd: 5, month_left_usd: "lots", estimate_usd: -1 },
    });
    expect(outputs).toContain('limits={"review_usd":5}\n');
  });

  test("absent or malformed limits write no output at all", async () => {
    for (const limits of [undefined, "x", null, { review_usd: 0 }]) {
      const { code, outputs } = await connect({ ...SUCCESS, limits });
      expect(code).toBe(0);
      expect(outputs.some((o) => o.startsWith("limits="))).toBe(false);
    }
  });

  test("the retired outputs are no longer written", async () => {
    const { outputs } = await connect({
      ...SUCCESS,
      estimate: { usd_low: 0.4, usd_high: 0.9, basis: "history" },
      capabilities: ["usage-facts"],
    });
    expect(outputs.some((o) => o.startsWith("estimate="))).toBe(false);
    expect(outputs.some((o) => o.startsWith("usage-facts="))).toBe(false);
  });

  test("the outputs the step always wrote are unchanged", async () => {
    const { outputs } = await connect({ ...SUCCESS, limits: LIMITS });
    expect(outputs).toContain("github-token=ghs_installation\n");
    expect(outputs).toContain("run-token=run_token\n");
    expect(outputs).toContain("data-mode=metadata_only\n");
  });
});

describe("parsePlatformLimits", () => {
  test("keeps every valid field", () => {
    expect(parsePlatformLimits(LIMITS)).toEqual({
      reviewUsd: 12,
      monthLeftUsd: 3.5,
      estimateUsd: 0.87,
    });
  });

  test("a month with nothing left is a valid 0, and an estimate of 0 is valid", () => {
    expect(parsePlatformLimits({ month_left_usd: 0, estimate_usd: 0 })).toEqual(
      { monthLeftUsd: 0, estimateUsd: 0 },
    );
  });

  test.each([
    ["not an object", "0.4"],
    ["an array", [1]],
    ["null", null],
    ["no usable field", { review_usd: "1", month_left_usd: null }],
    ["a review limit of 0 (no limit is sent as absent)", { review_usd: 0 }],
    ["a negative month", { month_left_usd: -1 }],
    ["a non-finite estimate", { estimate_usd: Number.POSITIVE_INFINITY }],
  ])("%s reads as no limits", (_, value) => {
    expect(parsePlatformLimits(value)).toBeUndefined();
  });

  test("a bad field is dropped without dropping the good ones", () => {
    expect(parsePlatformLimits({ review_usd: 7, estimate_usd: "n/a" })).toEqual(
      { reviewUsd: 7 },
    );
  });

  // platform-owned-cost S17 (T14): the estimate split per model role.
  test("keeps the estimate split per role beside the estimate", () => {
    const split = { "hunter.logic": 0.9, refuter: 0.2, summary: 0 };
    expect(
      parsePlatformLimits({
        review_usd: 1,
        estimate_usd: 1.1,
        estimate_by_role_usd: split,
      }),
    ).toEqual({ reviewUsd: 1, estimateUsd: 1.1, estimateByRoleUsd: split });
  });

  test.each([
    ["not an object", "refuter"],
    ["an array", [0.2]],
    ["empty", {}],
    ["a negative value", { refuter: -0.1, summary: 0.1 }],
    ["a non-finite value", { refuter: Number.POSITIVE_INFINITY }],
    ["a non-number value", { refuter: "0.2" }],
    ["an over-long key", { [`hunter.${"x".repeat(80)}`]: 0.2 }],
    ["an empty key", { "": 0.2 }],
  ])("a split that is %s is dropped and the rest is kept", (_, split) => {
    expect(
      parsePlatformLimits({
        review_usd: 1,
        estimate_usd: 2,
        estimate_by_role_usd: split,
      }),
    ).toEqual({ reviewUsd: 1, estimateUsd: 2 });
  });

  test("one bad entry drops the whole split, so a missing role is never read as free", () => {
    expect(
      parsePlatformLimits({
        estimate_usd: 2,
        estimate_by_role_usd: { "hunter.logic": 0.9, refuter: -1 },
      }),
    ).toEqual({ estimateUsd: 2 });
  });

  test("the split survives the connect step and the run step's read", async () => {
    const split = { "hunter.logic": 0.9, refuter: 0.2 };
    const { outputs } = await connect({
      ...SUCCESS,
      limits: { review_usd: 1, estimate_usd: 1.1, estimate_by_role_usd: split },
    });
    const line = outputs.find((o) => o.startsWith("limits="));
    expect(
      readPlatformLimits({
        CRYSK_PLATFORM_LIMITS: line?.slice("limits=".length).trim(),
      }),
    ).toEqual({ reviewUsd: 1, estimateUsd: 1.1, estimateByRoleUsd: split });
  });

  test("empty or unparseable CRYSK_PLATFORM_LIMITS reads as no limits", () => {
    expect(readPlatformLimits({})).toBeUndefined();
    expect(readPlatformLimits({ CRYSK_PLATFORM_LIMITS: "" })).toBeUndefined();
    expect(readPlatformLimits({ CRYSK_PLATFORM_LIMITS: "{" })).toBeUndefined();
    expect(readPlatformLimits({ CRYSK_PLATFORM_LIMITS: "[]" })).toBeUndefined();
  });
});

describe("platform.ts runs before `bun install`", () => {
  // ./platform-limits is the one non-builtin: it imports nothing itself, so the
  // connect step still loads before `bun install` (as trigger.ts does ../brand).
  test("it imports only runtime builtins, plus the import-free ./platform-limits and profile registry", () => {
    const source = readFileSync(path.join(SRC_CI, "platform.ts"), "utf-8");
    const specifiers = [
      ...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms),
    ].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).toMatch(
        /^(node:|bun$|bun:|\.\/platform-limits$|\.\.\/model\/profiles$|\.\.\/brand$)/,
      );
    }
    expect(
      readFileSync(path.join(SRC_CI, "platform-limits.ts"), "utf-8"),
    ).not.toMatch(/^\s*import\b/m);
    // The profile registry's only value imports are its own profile modules,
    // which import types alone (profile-registry.test.ts).
    const registry = readFileSync(
      path.join(SRC_CI, "..", "model", "profiles.ts"),
      "utf-8",
    );
    const valueImports = [
      ...registry.matchAll(/^import\s(?!type\s)[^;]*?from\s+"([^"]+)"/gms),
    ].map((match) => match[1]);
    for (const specifier of valueImports) {
      expect(specifier).toMatch(/^\.\/profiles\/[a-z-]+$/);
    }
  });
});
