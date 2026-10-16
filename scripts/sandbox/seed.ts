// What the sandbox's main contains and what its secrets and variables hold. Pure:
// no I/O, so the exact bytes are testable. Every value that the product reads is
// built from the product's own renderer or the product's own documented shape,
// and test/sandbox/seed.test.ts parses each one back through the real parser.

import { generateCiWorkflowTemplate } from "#ci/setup";
import {
  FORMAT,
  GOTCHAS,
  INDEX,
  PLAYER,
  README,
  VOLUME_BUGGY,
  VOLUME_CORRECT,
} from "../../fixtures/setup";

export const WORKFLOW_PATH = ".github/workflows/pr-hero.yml";
export const REPO_CONFIG_PATH = ".prhero/config.json";
export const GOTCHAS_PATH = ".prhero/gotchas.md";
export const VOLUME_PATH = "src/volume.ts";

// The secret the scaffold wires to the action's `opencode-auth` input
// (src/ci/setup.ts, the `opencode-auth:` line of the Run pr-hero step), and the
// variable it wires to `routing` (the `routing:` line of the same step).
export const OPENCODE_AUTH_SECRET = "OPENCODE_AUTH_JSON";
// An empty OpenCode auth store. The free broker projects an empty tree, so `{}`
// is the minimum that passes the trigger's credential check (src/ci/trigger.ts).
export const OPENCODE_AUTH_VALUE = "{}";
export const ROUTING_VARIABLE = "PRHERO_ROUTING";

// The routing object, not the whole config (docs/github-actions.md, the
// PRHERO_ROUTING row). A `default` route covers every role: the sonnet hunters,
// the opus refuter and the haiku summarizer. `big-pickle` is the model the
// 2026-10-16 `opencode models opencode --verbose` catalog lists at cost 0.
// `modelSnapshot` is required here: big-pickle is not a catalog alias, and a
// route without one on an OpenCode backend throws UnmappedRouteError.
export const ROUTING_VALUE = JSON.stringify({
  default: {
    backend: "opencode",
    provider: "opencode",
    gateway: "configured",
    modelSnapshot: "big-pickle",
  },
});

// The repo config, read from the checkout (not the person layer). every_push
// admits every push and never skips for risk; ci_max_attempts is high enough
// that the attempt cap never fires on a re-run of the same scenario PR. The
// observe-only flag stays off, so skip reasons still appear and can be read.
export const REPO_CONFIG_JSON = `${JSON.stringify(
  { ci_review_policy: "every_push", ci_max_attempts: 100 },
  null,
  2,
)}\n`;

export const REPO_DESCRIPTION =
  "pr-hero's CI test bed: a scratch repo for scenario runs of the pr-hero review action";

export const PLANTED_COMMIT_MESSAGE = "refactor: simplify volume scaling";

const ACTION_REPO = "juanmaagd/pr-hero";
const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export function validateRef(ref: string): void {
  if (!REF_SHAPE.test(ref) || ref.includes("..")) {
    throw new Error(
      `--ref ${JSON.stringify(ref)} is not a tag or branch name (letters, digits, . _ / -)`,
    );
  }
}

export function actionRefFor(ref: string): string {
  return `${ACTION_REPO}@${ref}`;
}

// The product's own scaffold renderer, with the published action ref. Only the
// two options a consumer sets: the forceEngineFromPr path is `uses: ./`-only and
// would be wrong for a published tag.
export function workflowFor(ref: string): string {
  return generateCiWorkflowTemplate({
    actionRef: actionRefFor(ref),
    budgetUsd: "0",
  });
}

// The whole main, keyed by repo-relative path. The fixture's correct volume
// pipeline plus the scaffolded workflow, repo config and gotchas.
export function sandboxFiles(ref: string): Map<string, string> {
  return new Map<string, string>([
    ["README.md", README],
    [VOLUME_PATH, VOLUME_CORRECT],
    ["src/player.ts", PLAYER],
    ["src/format.ts", FORMAT],
    ["src/index.ts", INDEX],
    [WORKFLOW_PATH, workflowFor(ref)],
    [REPO_CONFIG_PATH, REPO_CONFIG_JSON],
    [GOTCHAS_PATH, GOTCHAS],
  ]);
}

// The planted bug is the fixture's buggy volume file, committed on a scenario
// branch. It is the only change a smoke PR makes against main.
export function plantedVolume(): string {
  return VOLUME_BUGGY;
}
