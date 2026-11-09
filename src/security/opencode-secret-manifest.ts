// The manifest the CI setup step leaves beside the OpenCode auth file it builds
// from CRYSK_OPENCODE_* secrets (odd/tasks/role-model-routing.md S8/S9, L12
// "Building auth.json", unit U3).
//
// WHY a file: the secrets reach the setup step only (L13), and the run step
// never sees them or the setup step's outputs, yet the run must bind each
// OpenCode route to the kind of credential the auth file actually holds. An
// openai record built from `CRYSK_OPENCODE_OPENAI_API_KEY` is a metered API
// token, not the ChatGPT subscription the provider literal assumes. The setup
// step writes, next to auth.json, WHICH secret built each provider's record;
// the run reads the names back and hands them to credentialKindForRoute
// (runner-authority.ts), which applies the same chooseOpenCodeSecret rule the
// setup step used. Names and kinds only, never a value.
//
// No manifest (the old `opencode-auth` input, a local `opencode auth login`
// store) means the provider literal decides, exactly as before U3. A manifest
// that does not parse is treated as absent: the literal then stands and a
// mismatched record is refused loudly at projection, never billed silently.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveOpenCodeAuthPath } from "./credential-broker";

export const OPENCODE_SECRET_MANIFEST_FILE = "crysk-credentials.json";

const SOURCE = "crysk-secrets";
const SECRET_NAME_RE =
  /^CRYSK_OPENCODE_[A-Z0-9]+(?:_[A-Z0-9]+)*_(?:API_KEY|OAUTH)$/;

export interface OpenCodeSecretManifestEntry {
  // The provider id as the model name writes it, which keys auth.json.
  readonly provider: string;
  // The secret whose value built the record.
  readonly secret: string;
  readonly kind: "oauth" | "api_key";
  // The provider's other secret, set but not used (the subscription came first).
  readonly unused?: string;
}

export function openCodeSecretManifestPath(authPath: string): string {
  return path.join(path.dirname(authPath), OPENCODE_SECRET_MANIFEST_FILE);
}

export function serializeOpenCodeSecretManifest(
  entries: readonly OpenCodeSecretManifestEntry[],
): string {
  const providers: Record<string, Record<string, string>> = {};
  for (const entry of [...entries].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  )) {
    providers[entry.provider] = {
      secret: entry.secret,
      kind: entry.kind,
      ...(entry.unused === undefined ? {} : { unused: entry.unused }),
    };
  }
  return `${JSON.stringify({ v: 1, source: SOURCE, providers }, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every secret name the manifest records, sorted, or undefined when the text is
// not a manifest this version wrote.
export function openCodeSecretNamesFromManifest(
  text: string,
): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.source !== SOURCE) {
    return undefined;
  }
  if (!isRecord(parsed.providers)) return undefined;
  const names = new Set<string>();
  for (const entry of Object.values(parsed.providers)) {
    if (!isRecord(entry)) return undefined;
    if (entry.kind !== "oauth" && entry.kind !== "api_key") return undefined;
    const recorded =
      entry.unused === undefined
        ? [entry.secret]
        : [entry.secret, entry.unused];
    for (const name of recorded) {
      if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
        return undefined;
      }
      names.add(name);
    }
  }
  return [...names].sort();
}

// The names the manifest beside the auth file this env resolves to records, or
// undefined when there is none. Read once per run, at admission.
export function readOpenCodeSecretNames(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = homedir(),
): readonly string[] | undefined {
  let text: string;
  try {
    text = readFileSync(
      openCodeSecretManifestPath(resolveOpenCodeAuthPath(env, homeDir)),
      "utf8",
    );
  } catch {
    return undefined;
  }
  return openCodeSecretNamesFromManifest(text);
}
