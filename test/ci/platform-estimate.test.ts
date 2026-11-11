import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  exchangePlatformToken,
  runPlatformConnect,
} from "../../src/ci/platform";
import {
  parsePlatformEstimate,
  platformCostEstimate,
  readPlatformEstimate,
  runCostEstimate,
} from "../../src/ci/platform-estimate";
import { planEstimateLine } from "../../src/ui/plan";

const SRC_CI = path.resolve(import.meta.dir, "../../src/ci");
const OIDC_URL = "https://token.actions.example/id?api-version=2.0";
const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-bearer-secret",
  CRYSK_DISPATCH_ID: "dispatch-123",
};
const SUCCESS = { github_token: "ghs_installation", run_token: "run_token" };
const ESTIMATE = { usd_low: 0.41, usd_high: 0.87, basis: "history" };

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

describe("the estimate at the token exchange", () => {
  test("the first connect step asks for it and returns the platform's range", async () => {
    const { fn, platformCalls } = fakeFetch({ ...SUCCESS, estimate: ESTIMATE });
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: "https://platform.test",
      mask: () => {},
    });
    expect(capability(platformCalls[0])).toBe("estimate");
    expect(result).toMatchObject({
      ok: true,
      estimate: { usdLow: 0.41, usdHigh: 0.87, basis: "history" },
    });
  });

  test("a refresh step neither asks for one nor keeps one sent anyway", async () => {
    const { fn, platformCalls } = fakeFetch({ ...SUCCESS, estimate: ESTIMATE });
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: "https://platform.test",
      mask: () => {},
      ignoreConfig: true,
    });
    expect(capability(platformCalls[0])).toBeNull();
    expect(result.ok).toBe(true);
    expect("estimate" in result).toBe(false);
  });

  test("a malformed estimate is dropped and the exchange still succeeds", async () => {
    const { fn } = fakeFetch({
      ...SUCCESS,
      estimate: { usd_low: 3, usd_high: 1, basis: "history" },
    });
    const result = await exchangePlatformToken({
      fetch: fn,
      env: ENV,
      baseUrl: "https://platform.test",
      mask: () => {},
    });
    expect(result.ok).toBe(true);
    expect("estimate" in result).toBe(false);
  });

  test("the connect step hands it to the run step as the estimate output", async () => {
    const outputs: string[] = [];
    const { fn } = fakeFetch({ ...SUCCESS, estimate: ESTIMATE });
    const code = await runPlatformConnect({
      fetch: fn,
      env: ENV,
      baseUrl: "https://platform.test",
      stdout: () => {},
      appendOutput: (text) => outputs.push(text),
      configDir: path.join(
        mkdtempSync(path.join(tmpdir(), "crysk-estimate-")),
        "platform",
      ),
    });
    expect(code).toBe(0);
    const line = outputs.find((o) => o.startsWith("estimate="));
    expect(line).toBe(
      'estimate={"usd_low":0.41,"usd_high":0.87,"basis":"history"}\n',
    );
    // What the run step reads back is the same range.
    expect(
      readPlatformEstimate({
        CRYSK_PLATFORM_ESTIMATE: line?.slice("estimate=".length).trim(),
      }),
    ).toEqual({ usdLow: 0.41, usdHigh: 0.87, basis: "history" });
  });
});

describe("parsePlatformEstimate", () => {
  test.each([
    ["not an object", "0.4"],
    ["low above high", { usd_low: 2, usd_high: 1, basis: "catalog" }],
    ["a negative figure", { usd_low: -1, usd_high: 1, basis: "catalog" }],
    ["a string figure", { usd_low: "1", usd_high: 2, basis: "catalog" }],
    ["an unknown basis", { usd_low: 1, usd_high: 2, basis: "guess" }],
  ])("%s reads as no estimate", (_, value) => {
    expect(parsePlatformEstimate(value)).toBeUndefined();
  });

  test("empty or unparseable CRYSK_PLATFORM_ESTIMATE reads as no estimate", () => {
    expect(readPlatformEstimate({})).toBeUndefined();
    expect(
      readPlatformEstimate({ CRYSK_PLATFORM_ESTIMATE: "" }),
    ).toBeUndefined();
    expect(
      readPlatformEstimate({ CRYSK_PLATFORM_ESTIMATE: "{" }),
    ).toBeUndefined();
  });
});

describe("the plan's estimate line", () => {
  test("a platform estimate names its basis instead of the band's agents", () => {
    const estimate = platformCostEstimate({
      usdLow: 5.13,
      usdHigh: 11.06,
      basis: "catalog",
    });
    expect(
      planEstimateLine({ estimate, hunterCount: 3, summarizer: true }),
    ).toBe("estimate $5.13 – $11.06 (platform: catalog)");
  });

  test("without one the band's line is unchanged", () => {
    expect(
      planEstimateLine({
        estimate: { low: 5.13, high: 11.06 },
        hunterCount: 3,
        summarizer: true,
      }),
    ).toBe("estimate $5.13 – $11.06 (3 hunter(s) + refuter + summarizer)");
  });
});

describe("platform.ts runs before `bun install`", () => {
  // ./platform-estimate is the one non-builtin: it imports nothing itself, so the
  // connect step still loads before `bun install` (as trigger.ts does ../brand).
  test("it imports only runtime builtins, plus the import-free ./platform-estimate", () => {
    const source = readFileSync(path.join(SRC_CI, "platform.ts"), "utf-8");
    const specifiers = [
      ...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms),
    ].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^(node:|bun$|bun:|\.\/platform-estimate$)/);
    }
    expect(
      readFileSync(path.join(SRC_CI, "platform-estimate.ts"), "utf-8"),
    ).not.toMatch(/^\s*import\b/m);
  });
});

// The platform prices the whole pull request before the engine knows how much
// of it this run reviews, so a narrowed run (a re-review of the new commits, or
// one that only verifies) scales the platform's figure by the share of a full
// review it does. The band measures that share and never supplies the price.
describe("runCostEstimate", () => {
  const platform = { usdLow: 4, usdHigh: 6, basis: "history" as const };
  const band = { low: 0.5, high: 1.5, basis: "band" };

  test("a full review uses the platform's estimate", () => {
    const estimate = runCostEstimate(platform, band, undefined);
    expect([estimate.low, estimate.high]).toEqual([4, 6]);
  });

  test("a narrowed run scales the platform's figure by the share it reviews", () => {
    // A quarter of a full review: $1.50 of a $6.00 band.
    const estimate = runCostEstimate(platform, band, { high: 6 });
    expect([estimate.low, estimate.high]).toEqual([1, 1.5]);
    expect(estimate.basis).toContain("25% of a full review");
  });

  test("models dearer than Claude keep their price on a narrowed run", () => {
    // The band (Claude prices) is far below the platform's $60, yet the share
    // decides, not the band's number: half the work is half of $60.
    const dear = { usdLow: 40, usdHigh: 60, basis: "catalog" as const };
    expect(runCostEstimate(dear, band, { high: 3 }).high).toBe(30);
  });

  test("the share never exceeds a full review", () => {
    expect(
      runCostEstimate(platform, { low: 5, high: 9, basis: "band" }, { high: 6 })
        .high,
    ).toBe(6);
  });

  test("without a platform estimate the band decides", () => {
    expect(runCostEstimate(undefined, band, { high: 6 })).toEqual(band);
  });
});
