// The review cost the Crysk platform estimated for this run (cryskai/platform#12).
// The connect step asks for it with `X-Crysk-Capabilities: estimate` and hands it
// to the run step as `CRYSK_PLATFORM_ESTIMATE`, where the CI budget gate reads it
// instead of the engine's own band (cryskai/crysk#138): the platform knows the
// setup's models, their catalog prices and what its recent reviews cost; the
// band only knows the diff's size and prices every model as Claude.
//
// The platform already checked it, and the engine checks again: a value that is
// not a usable range is dropped, and the band decides, as without a platform.

export type PlatformEstimateBasis = "history" | "catalog";

export interface PlatformEstimate {
  readonly usdLow: number;
  readonly usdHigh: number;
  // `history`: the setup's recent reviews scaled to this pull request.
  // `catalog`: the catalog prices of the setup's models.
  readonly basis: PlatformEstimateBasis;
}

export const PLATFORM_ESTIMATE_CAPABILITY = "estimate";

const usable = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

// The `/runs/token` field, `{ usd_low, usd_high, basis }`, or undefined when it
// is absent or not a usable range.
export function parsePlatformEstimate(
  value: unknown,
): PlatformEstimate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const {
    usd_low: low,
    usd_high: high,
    basis,
  } = value as Record<string, unknown>;
  if (!usable(low) || !usable(high) || low > high) return undefined;
  if (basis !== "history" && basis !== "catalog") return undefined;
  return { usdLow: low, usdHigh: high, basis };
}

// What the connect step writes to its `estimate` output: one line of JSON in the
// response's own field names, numbers and an enum only.
export function serializePlatformEstimate(estimate: PlatformEstimate): string {
  return JSON.stringify({
    usd_low: estimate.usdLow,
    usd_high: estimate.usdHigh,
    basis: estimate.basis,
  });
}

// The run step's read of `CRYSK_PLATFORM_ESTIMATE`. Empty (a standalone run, an
// older platform, nothing priceable) or malformed reads as no estimate.
export function readPlatformEstimate(
  env: Readonly<Record<string, string | undefined>>,
): PlatformEstimate | undefined {
  const text = env.CRYSK_PLATFORM_ESTIMATE;
  if (text === undefined || text === "") return undefined;
  try {
    return parsePlatformEstimate(JSON.parse(text));
  } catch {
    return undefined;
  }
}

// The estimate as the plan and the CI budget gate read a cost band (report.ts's
// CostEstimate, structurally: this module imports nothing).
export function platformCostEstimate(estimate: PlatformEstimate): {
  low: number;
  high: number;
  basis: string;
  platform: PlatformEstimateBasis;
} {
  return {
    low: estimate.usdLow,
    high: estimate.usdHigh,
    basis:
      estimate.basis === "history"
        ? "The Crysk platform's estimate, from this setup's recent reviews scaled to this pull request."
        : "The Crysk platform's estimate, from the catalog prices of this setup's models.",
    platform: estimate.basis,
  };
}
