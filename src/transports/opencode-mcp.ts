// #141: the MCP half of the OpenCode transport. PURE — the impure halves are
// the launcher (which carries the config into the child's environment) and the
// client (which reads the file and verifies the readback).
//
// pr-hero writes ONE mcp registry per run, in Claude Code's shape
// (src/cli.ts's CODEGRAPH_ONLY_MCP_CONFIG), and `binding-policy.ts` gates that
// exact file: not a symlink, `mcpServers` empty or exactly ["codegraph"], and
// an optional sha256 pin. This module TRANSLATES that file rather than letting
// the OpenCode route write its own. A second config would be a registry the
// integrity gate never sees — which is the same thing as no gate at all, since
// the agent cannot tell which registry granted it a tool.
//
// The two shapes are not compatible and never were:
//
//   Claude   { "mcpServers": { codegraph: { type: "stdio",
//                                           command: "codegraph",
//                                           args: ["serve", "--mcp"] } } }
//   OpenCode { "mcp":        { codegraph: { type: "local",
//                                           command: ["<abs>", "serve", …] } } }
//
// (McpLocalConfig, @opencode-ai/sdk types.gen.d.ts:946-969.)

// What `OPENCODE_CONFIG_CONTENT` carries under `mcp`. Narrow on purpose: the
// SDK's own `McpLocalConfig` also admits `environment` and `timeout`, and this
// transport delivers neither — an environment map here would be a second,
// ungated channel into a child that already inherits the projected one.
interface OpenCodeMcpLocalConfig {
  readonly type: "local";
  readonly command: readonly string[];
  readonly enabled: true;
}

export type OpenCodeMcpConfig = Readonly<
  Record<string, OpenCodeMcpLocalConfig>
>;

// The ONE server pr-hero can express, and the same name binding-policy.ts
// admits. Anything else reaching the translation is a registry this route
// cannot honour, not a server to drop quietly.
const CODEGRAPH_SERVER = "codegraph";

// OpenCode normalises an MCP tool to `<server>_<tool>`, and
// `codegraph serve --mcp` exposes exactly one tool, `codegraph_explore` — so
// the id is the doubled-looking `codegraph_codegraph_explore`. MEASURED live
// (#141 fact 4), not derived from the docs: with an empty tools map the model
// called it and named it back; with this key written false alongside every
// built-in, the model answered REFUSED and no tool call appeared in the event
// stream. The map key genuinely gates it.
const MCP_SERVER_TOOL_IDS: Readonly<Record<string, readonly string[]>> = {
  [CODEGRAPH_SERVER]: ["codegraph_codegraph_explore"],
};

interface ClaudeMcpServer {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface TranslateMcpConfigInput {
  // The mcp.json bytes, already read by the caller. Read BEFORE the server is
  // spawned (the F005 ordering rule): a config that cannot be translated must
  // cost nothing to unwind.
  readonly json: string;
  // Carried only so a failure names the file the operator has to look at.
  readonly configPath: string;
  // The REVIEW TARGET, which is not the launcher's cwd.
  readonly cwd: string;
  // Absolute, resolved by the caller (transport-registry.ts), never looked up
  // here: a PATH lookup inside a pure translation would be unreachable from a
  // test and invisible in an artifact.
  readonly codegraphBinaryPath?: string;
}

export function translateMcpConfig(
  input: TranslateMcpConfigInput,
): OpenCodeMcpConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.json);
  } catch (error) {
    throw new Error(
      `mcp registry at ${input.configPath} is not valid JSON: ${(error as Error).message}`,
    );
  }

  const servers = asRecord(asRecord(parsed)?.mcpServers) ?? {};
  const out: Record<string, OpenCodeMcpLocalConfig> = {};

  for (const [name, raw] of Object.entries(servers)) {
    // Not a filter — a REFUSAL. This translation knows how to build exactly
    // one command, and a server it silently dropped would be a tool the
    // prompt was promised and the model never receives: the absent-key hazard
    // resolveToolMap was written to kill, re-entering through the config.
    // binding-policy.ts already refuses such a registry; this is the same
    // ruling at the point where the command is actually built.
    if (name !== CODEGRAPH_SERVER) {
      throw new Error(
        `mcp registry at ${input.configPath} registers "${name}", which the ` +
          "opencode route cannot express; only the codegraph server is supported",
      );
    }
    const server = (asRecord(raw) ?? {}) as ClaudeMcpServer;
    // A remote transport has no command to translate at all, and inventing
    // one would produce a server that connects to nothing.
    if (server.type !== undefined && server.type !== "stdio") {
      throw new Error(
        `mcp registry at ${input.configPath} declares "${name}" as ` +
          `"${String(server.type)}"; only stdio servers can be translated`,
      );
    }
    if (typeof server.command !== "string" || server.command.length === 0) {
      throw new Error(
        `mcp registry at ${input.configPath} declares "${name}" with no command`,
      );
    }
    const args = server.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error(
        `mcp registry at ${input.configPath} declares non-string args for "${name}"`,
      );
    }

    out[name] = {
      type: "local",
      command: [
        resolveCommand(server.command, input),
        ...(args as string[]),
        // REQUIRED, not decorative. The OpenCode server process inherits
        // pr-hero's process cwd, NOT the review target — in PR mode the
        // target is a worktree — so a codegraph left to resolve its project
        // from cwd would index the operator's checkout and answer every
        // hunter about the wrong tree. It would ANSWER, which is what makes
        // this the expensive kind of wrong.
        "-p",
        input.cwd,
      ],
      enabled: true,
    };
  }

  return out;
}

// The Claude-side file carries a bare "codegraph" because the claude CLI child
// inherits a real PATH. The OpenCode child does not: the production env
// projection is EXACTLY {HOME, TMPDIR, XDG_DATA_HOME, XDG_CONFIG_HOME}
// (credential-broker.ts:449-457), so a bare name resolves to nothing. Fail
// loud rather than degrade: a command that cannot resolve produces a server
// that never connects, and the readback would then abort the attempt with a
// diagnosis pointing at the wrong thing.
function resolveCommand(
  declared: string,
  input: TranslateMcpConfigInput,
): string {
  if (declared.startsWith("/")) return declared;
  const override = input.codegraphBinaryPath;
  if (override === undefined) {
    throw new Error(
      `mcp registry at ${input.configPath} names the codegraph binary as ` +
        `"${declared}", and no absolute codegraph path could be resolved; ` +
        "the opencode child is spawned with no PATH, so a bare name cannot " +
        "start. Install codegraph or pass an absolute override.",
    );
  }
  if (!override.startsWith("/")) {
    throw new Error(`codegraph binary must be an absolute path: ${override}`);
  }
  return override;
}

export function mcpConfigIsEmpty(config: OpenCodeMcpConfig): boolean {
  return Object.keys(config).length === 0;
}

// Every tool id any deliverable MCP server contributes. Written into the allow
// map unconditionally — true only for a server actually delivered — because an
// absent key asks for the provider's default and the provider's default is not
// ours to inherit.
export const ALL_MCP_TOOL_IDS: readonly string[] =
  Object.values(MCP_SERVER_TOOL_IDS).flat();

export function mcpToolIdsFor(config: OpenCodeMcpConfig): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const name of Object.keys(config)) {
    for (const id of MCP_SERVER_TOOL_IDS[name] ?? []) ids.add(id);
  }
  return ids;
}

// §E: the readback, and the reason it exists rather than a declaration.
// claude-code gets `--strict-mcp-config` — a FLAG, believed. Here the
// connected set is read back from the provider and compared, which is strictly
// stronger: it is verified, not declared.
//
// The concrete threat it closes is measured (#141 fact 7): `--pure` suppresses
// neither config-delivered nor config-FILE MCP servers. A server launched with
// the operator's real HOME loads ~/.config/opencode/opencode.jsonc and
// connects whatever the operator configured, and production is shielded only
// INCIDENTALLY — by the synthetic XDG_CONFIG_HOME the credential projection
// happens to set. An extra server is an undeclared tool channel inside a
// process holding a projected credential, and nothing else in this transport
// would ever notice it: a connected MCP server contributes nothing to
// `tool.ids()`, so the allow-map enumeration cannot see it either.
export function assertMcpConnected(
  status: unknown,
  expected: readonly string[],
): void {
  const record = asRecord(status);
  // An unreadable response proves nothing, and "nothing extra is connected" is
  // precisely the claim that cannot be made from it.
  if (record === undefined) {
    throw new Error(
      "opencode reported an unreadable MCP status, so the connected server " +
        "set cannot be verified; refusing to prompt a session whose tool " +
        "channels are unknown",
    );
  }

  const declared = new Set(expected);
  const connected = Object.keys(record).sort();
  const extra = connected.filter((name) => !declared.has(name));
  if (extra.length > 0) {
    throw new Error(
      `opencode connected MCP servers Crysk did not declare: ${extra.join(", ")}` +
        ` (declared: ${expected.length === 0 ? "none" : [...declared].sort().join(", ")})`,
    );
  }

  for (const name of [...declared].sort()) {
    const entry = asRecord(record[name]);
    if (entry === undefined) {
      throw new Error(
        `opencode did not connect the declared MCP server "${name}"`,
      );
    }
    if (entry.status !== "connected") {
      throw new Error(
        `opencode MCP server "${name}" is ${String(entry.status)}, not connected`,
      );
    }
  }
}
