import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

// §6.3, shared by every CLI transport that spawns a child on a system prompt
// file (the Claude CLI and agy, odd/tasks/antigravity-oauth.md E4): the prompt
// is a 0600, non-symlink file whose sha256 is checked immediately before spawn.
// Extracted from ClaudeCodeCliTransport unchanged, so both transports refuse
// exactly the same files with exactly the same words.

export interface PromptFileStatus {
  readonly mode: number;
  readonly isSymbolicLink: boolean;
}

export function systemPromptStatus(
  promptPath: string,
): PromptFileStatus | undefined {
  try {
    const stats = lstatSync(promptPath);
    return { mode: stats.mode, isSymbolicLink: stats.isSymbolicLink() };
  } catch {
    return undefined;
  }
}

export function hashPromptFile(promptPath: string): string {
  return createHash("sha256").update(readFileSync(promptPath)).digest("hex");
}

export interface PromptIntegrityDeps {
  readonly lstat: (
    path: string,
  ) => PromptFileStatus | undefined | Promise<PromptFileStatus | undefined>;
  readonly hash: (path: string) => string | Promise<string>;
}

// Returns the denial reason, or undefined when verification holds.
export async function verifyPromptIntegrity(
  request: {
    readonly systemPromptPath: string;
    readonly systemPromptSha256: string;
  },
  deps: PromptIntegrityDeps,
): Promise<string | undefined> {
  const status = await deps.lstat(request.systemPromptPath);
  if (status === undefined) {
    return `system prompt unreadable: ${request.systemPromptPath}`;
  }
  if (status.isSymbolicLink) {
    return `system prompt is a symlink: ${request.systemPromptPath}`;
  }
  // Raw lstat mode carries file-type bits; only the permission bits must be
  // exactly 0600.
  if ((status.mode & 0o777) !== 0o600) {
    return `system prompt mode is ${(status.mode & 0o777).toString(8)}, expected 600`;
  }
  const actualSha256 = await deps.hash(request.systemPromptPath);
  if (actualSha256 !== request.systemPromptSha256) {
    return "system prompt hash mismatch against request.systemPromptSha256";
  }
  return undefined;
}
