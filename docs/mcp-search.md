# Crysk's read-only search MCP (`crysk mcp-search`)

Google Antigravity (`agy:` models) gives a review step no way to search a repository: its own search tools
are not exposed to a custom agent, and its way to search is the shell, which Crysk denies. So for an agy step
that asks for `Grep` or `Glob`, Crysk starts its own small MCP server and lets agy call it. Claude and
OpenCode steps never get this server; they use their own `Grep` and `Glob`.

You do not run it yourself. It is an internal command, so `crysk --help` does not list it.

## How a step gets it

For each agy step, Crysk writes `.gemini/config/mcp_config.json` into the step's own projected home (mode
0600), every attempt:

- the step's tools include `Grep` or `Glob`: one server, `crysk-search`, started as this same Crysk with
  `mcp-search --root <the step's working directory>`, and the step's agent gets `inheritMcp: true`;
- otherwise: `{"mcpServers": {}}` and `inheritMcp: false`.

A step with `Grep` or `Glob` also gets agy's `read_file`, even without `Read`. agy writes each MCP tool's
schema to `$HOME/.gemini/antigravity-cli/mcp/<server>/<tool>.json` and reads it with `read_file` before the
tool's first call, and agy's deny rules beat its allow rules, so `read_file` cannot be allowed for that
directory alone. It adds no reach: `grep` already returns file lines. Those schema reads are not counted as
the step's tool calls; the `call_mcp_tool` steps are.

agy starts the server in the reviewed repository. When Crysk runs as a Bun script, the command passes
`--no-env-file --config=/dev/null` so Bun loads neither that repository's `.env` nor its `bunfig.toml`
(a `preload` there would run code). The release binary is built without `.env` and `bunfig.toml` autoload.

agy's `mcp(...)` permission grants neither allow nor deny an MCP server, so what this file lists, and the
server's own limits below, are the whole gate.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `grep` | `pattern` (JavaScript regex, required, matched against whole lines), `path` (file or directory), `glob` (a glob with no `/` matches file names at any depth), `ignore_case`, `max_results` (default 200) | one `path:line:text` line per match |
| `glob` | `pattern` (required, relative to `path`), `path` (directory) | matching file paths, sorted |
| `list` | `path` (directory) | the directory's entries, directories ending in `/` |

Paths in arguments are relative to the repository root; an absolute path is accepted only inside it. Every
path in a result is relative to the root.

## `.gitignore`

All three tools skip what `.gitignore` ignores, as ripgrep does for Claude's `Grep`: the root `.gitignore`
and every nested one, each applying to paths under its own directory, a deeper file overriding a shallower
one, the last matching line winning within a file, `!` re-including, and a trailing `/` matching directories
only. An ignored directory is not entered. The syntax is the same gitignore dialect `.cryskignore` uses, and
matching is case-sensitive, like git on Linux.

- A path you name in `path` is searched even when it is ignored, with everything under it; ignore rules
  still apply below it. This is ripgrep's rule (`rg pattern build/` searches an ignored `build/`).
- Only `.gitignore` files inside the repository are read, through the same confinement as any file; a
  symlinked `.gitignore` is not followed (git does not follow one either). `.git/info/exclude` and the
  global excludes file are not read.
- A line the dialect refuses (a bare `!`, a bare `/`, a trailing backslash) is skipped; the rest of the
  file still applies.
- `.git` is never searched, whatever a `.gitignore` says.

## Limits

The server is read-only and in-process: no shell, no child process, no network, no file writes.

- **Confinement.** `--root` is resolved with `realpath` at startup. Every requested path is resolved and
  `realpath`'d and must stay inside the root: `..`, absolute paths outside it and symlinks whose target
  leaves it are refused. `.git` is refused as any path segment and never entered. Walks do not follow
  symlinked directories; a symlinked file is read only when its target is inside the root. Only regular
  files are read. A path outside the repository and a path that does not exist get the same error, so a
  refusal says nothing about what exists outside.
- **Swaps during a walk.** Each directory is opened without following links and must still be itself
  (`realpath`, inode) just before and after it is listed; each file is opened with `O_NOFOLLOW` and read
  from that descriptor only when the path still resolves to it (`realpath`, device and inode).
- **Files.** Files over 1 MiB and binary files (a NUL byte in the first 8 KiB) are skipped.
- **Results.** `grep` stops at 500 matches, `glob` at 2000 paths, `list` at 2000 entries; an output line is
  cut at 500 characters and a response at 256 KiB. A cut result ends with a `[truncated: ...]` note.
- **Work.** One call visits at most 200,000 entries and stops after 20 seconds, with a note.
- **Patterns.** A regex or glob longer than 1000 characters is refused and an invalid regex is a tool
  error. A regex runs on whole lines, in a worker thread: when one `grep` call has spent 10 seconds
  matching, the worker is stopped and the call returns an `isError` result, "pattern took too long". The
  server keeps serving.
- **Errors.** A refused path or bad argument is an MCP tool result with `isError: true` and a short reason
  in repository-relative terms. An unknown JSON-RPC method gets a JSON-RPC error; the server keeps serving.

## Residual risk

- Node has no `openat` or `fdopendir`, so a directory is listed by path. Swapping a directory for a symlink
  in the window between the checks and the listing, and back, is not prevented; it needs a concurrent
  writer with precise timing, and an agy step cannot write. Hardlinks to files outside the repository are
  read like any file (git cannot create one).
- JavaScriptCore gives up on a single catastrophic match after about 250 ms and reports no match, so such
  a pattern can miss lines rather than hang on one.

## Protocol

Newline-delimited JSON-RPC 2.0 over stdio. It answers `server/discover` (agy sends it first) with an empty
result, echoes the client's `protocolVersion` on `initialize` with capabilities `{"tools": {}}` and server
name `crysk-search`, and answers `ping`, `tools/list` and `tools/call`, one request at a time, in order.
Notifications get no reply.
