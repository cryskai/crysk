// The product's names during the pr-hero → Crysk rename. Every contract
// writes the new name and, for one version, still reads the old one, so an
// install set up under pr-hero keeps working. Each legacy fallback lives here
// so the version that drops them deletes one module, not a hunt across src/.

const ENV_PREFIX = "CRYSK_";
const LEGACY_ENV_PREFIX = "PRHERO_";

export interface BrandEnvValue {
  value: string;
  // The variable that was read, so a message can name what the user set.
  name: string;
}

// Reads CRYSK_<suffix>, then PRHERO_<suffix>. Presence decides, not
// non-emptiness: a CRYSK_ variable set to "" still wins, and each caller keeps
// its own rule for what an empty value means.
export function readBrandEnv(
  env: Record<string, string | undefined>,
  suffix: string,
): BrandEnvValue | undefined {
  for (const prefix of [ENV_PREFIX, LEGACY_ENV_PREFIX]) {
    const name = `${prefix}${suffix}`;
    const value = env[name];
    if (value !== undefined) return { value, name };
  }
  return undefined;
}
