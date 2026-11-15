// odd/tasks/antigravity-oauth.md T4b (S5): `crysk mcp-search --root <dir>`,
// the read-only search MCP an agy step's mcp_config.json starts (agy-cli.ts).
// Not in the help text: it is an internal command, documented in
// docs/mcp-search.md.
//
// main() routes here before parseArgs, so this module owns its arguments. It
// never throws: runCli()'s catch would write a fatal CLI record, and this
// server must never write anything. stdout carries JSON-RPC only; problems go
// to stderr.
import { openRoot, SearchError } from "../search/confine";
import { runSearchServer } from "../search/server";

export const MCP_SEARCH_COMMAND = "mcp-search";

const USAGE = "usage: crysk mcp-search --root <dir>";

function parseRoot(argv: readonly string[]): string | undefined {
  if (argv.length === 2 && argv[0] === "--root" && argv[1] !== "") {
    return argv[1];
  }
  if (argv.length === 1 && argv[0]?.startsWith("--root=")) {
    const value = argv[0].slice("--root=".length);
    return value === "" ? undefined : value;
  }
  return undefined;
}

export async function mcpSearchCommand(
  argv: readonly string[],
): Promise<number> {
  const requested = parseRoot(argv);
  if (requested === undefined) {
    process.stderr.write(
      `crysk mcp-search: --root <dir> is required\n${USAGE}\n`,
    );
    return 2;
  }
  let root: string;
  try {
    root = openRoot(requested);
  } catch (error) {
    const reason =
      error instanceof SearchError ? error.message : "--root is unusable";
    process.stderr.write(`crysk mcp-search: ${reason}\n`);
    return 2;
  }
  try {
    await runSearchServer(root, {
      input: process.stdin as AsyncIterable<Uint8Array>,
      write: (text) => {
        process.stdout.write(text);
      },
    });
    return 0;
  } catch {
    process.stderr.write("crysk mcp-search: stopped on an internal error\n");
    return 1;
  }
}
