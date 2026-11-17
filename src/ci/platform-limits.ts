// The limits the Crysk platform sends with a run (platform-owned-cost L55). The
// connect step declares the `limits` capability in `X-Crysk-Capabilities`; only
// then does the `/runs/token` response carry `limits`, and the step hands it to
// the run step as `CRYSK_PLATFORM_LIMITS`, where the CI limits gate reads it
// (gates.ts, `evaluatePlatformLimits`).
//
// The platform owns the settings, the defaults and the month's spend; the
// engine only compares, because only it knows whether the run bills an API key.
// The field is absent when the dispatch was forced (`/crysk review`, `recheck`),
// and a forced run is therefore never skipped for cost.
//
// The platform already checked the numbers and the engine checks again: a field
// that is not a usable number is dropped, and with nothing left the run is
// treated as having no limits. Limits are advice for a skip, never a reason to
// fail the exchange.
//
// This module imports nothing, so the connect step (which runs before
// `bun install`) can load it.

export interface PlatformLimits {
  // The per-review limit in effect: repository override, else organization
  // setting, else the platform's default. Always above 0 when present.
  readonly reviewUsd?: number;
  // What the organization's month limit leaves after this calendar month's API
  // spend (UTC), floored at 0. Absent when no month limit is set.
  readonly monthLeftUsd?: number;
  // The platform's estimate for this review, its high side. Absent when the
  // platform cannot price the run.
  readonly estimateUsd?: number;
}

// Which limit a skip names (gates.ts, `evaluatePlatformLimits`): the month's
// limit is used up, the estimate is over the per-review limit, or the estimate
// is over what is left of the month.
export type PlatformLimitHit = "month-used-up" | "review-limit" | "month-left";

export const PLATFORM_LIMITS_CAPABILITY = "limits";

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// The `/runs/token` field, `{ review_usd?, month_left_usd?, estimate_usd? }`,
// or undefined when it is absent or holds no usable number. `review_usd` must be
// above 0 (the platform omits it when there is no limit); the other two may be 0.
export function parsePlatformLimits(
  value: unknown,
): PlatformLimits | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const {
    review_usd: review,
    month_left_usd: monthLeft,
    estimate_usd: estimate,
  } = value as Record<string, unknown>;
  const limits: {
    reviewUsd?: number;
    monthLeftUsd?: number;
    estimateUsd?: number;
  } = {
    ...(finite(review) && review > 0 ? { reviewUsd: review } : {}),
    ...(finite(monthLeft) && monthLeft >= 0 ? { monthLeftUsd: monthLeft } : {}),
    ...(finite(estimate) && estimate >= 0 ? { estimateUsd: estimate } : {}),
  };
  return Object.keys(limits).length === 0 ? undefined : limits;
}

// What the connect step writes to its `limits` output: one line of JSON in the
// response's own field names, numbers only.
export function serializePlatformLimits(limits: PlatformLimits): string {
  return JSON.stringify({
    ...(limits.reviewUsd === undefined ? {} : { review_usd: limits.reviewUsd }),
    ...(limits.monthLeftUsd === undefined
      ? {}
      : { month_left_usd: limits.monthLeftUsd }),
    ...(limits.estimateUsd === undefined
      ? {}
      : { estimate_usd: limits.estimateUsd }),
  });
}

// The run step's read of `CRYSK_PLATFORM_LIMITS`. Empty (a standalone run, a
// forced run, an older platform) or malformed reads as no limits.
export function readPlatformLimits(
  env: Readonly<Record<string, string | undefined>>,
): PlatformLimits | undefined {
  const text = env.CRYSK_PLATFORM_LIMITS;
  if (text === undefined || text === "") return undefined;
  try {
    return parsePlatformLimits(JSON.parse(text));
  } catch {
    return undefined;
  }
}
