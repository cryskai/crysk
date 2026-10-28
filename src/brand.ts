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

// Reads CRYSK_<suffix>, then PRHERO_<suffix>. The first non-empty value
// wins, so a CRYSK_ variable left empty during migration (a workflow `env:`
// entry wired to an unset repo variable) cannot hide the old install's value.
// When neither has a value but one is set, that one is returned as "", so a
// caller that only checks presence (NO_TUI) still sees it.
export function readBrandEnv(
  env: Record<string, string | undefined>,
  suffix: string,
): BrandEnvValue | undefined {
  let present: BrandEnvValue | undefined;
  for (const prefix of [ENV_PREFIX, LEGACY_ENV_PREFIX]) {
    const name = `${prefix}${suffix}`;
    const value = env[name];
    if (value === undefined) continue;
    if (value !== "") return { value, name };
    present ??= { value, name };
  }
  return present;
}
