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

// The estimate the run gates and plans on. The platform prices the whole pull
// request from the setup's own models, before the engine knows how much of it
// this run reviews. A narrowed run (a re-review whose discovery reads only what
// changed since the last review, or one that only verifies earlier findings)
// passes `fullBand`, the band for a full review of the pull request: the
// platform's figure is scaled by the share of that work the run does
// (band / fullBand, at most 1). The band measures the share only; its prices,
// which treat every model as Claude, never replace the platform's. A full review
// uses the platform's figure; without one the band decides, as before.
export function runCostEstimate<Band extends { high: number }>(
  platform: PlatformEstimate | undefined,
  band: Band,
  fullBand: { high: number } | undefined,
): Band | ReturnType<typeof platformCostEstimate> {
  if (platform === undefined) return band;
  const estimate = platformCostEstimate(platform);
  if (fullBand === undefined || !(fullBand.high > 0)) return estimate;
  const share = Math.min(1, Math.max(0, band.high / fullBand.high));
  return {
    ...estimate,
    low: estimate.low * share,
    high: estimate.high * share,
    basis: `${estimate.basis} Scaled to the ${Math.round(share * 100)}% of a full review this run does.`,
  };
}
