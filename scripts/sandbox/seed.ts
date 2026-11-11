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
export const REPO_CONFIG_PATH = ".crysk/config.json";
export const GOTCHAS_PATH = ".crysk/gotchas.md";
export const VOLUME_PATH = "src/volume.ts";

// D3: the second planted bug, added by a later push of the rereview-fresh-finding
// scenario. `Boolean((volume = 0))` assigns instead of comparing, so isMuted is never
// true. It is a new file, so main does not define it.
export const MUTE_PATH = "src/mute.ts";
export const MUTE_BUGGY =
  "export function isMuted(volume: number): boolean {\n  // Muted means the volume is zero.\n  return Boolean((volume = 0));\n}\n";
export const MUTE_COMMIT_MESSAGE = "feat: add a mute check";

// The scaffold hands the action its credentials in the `crysk-secrets` input, one
// CRYSK_* secret per line (src/ci/setup.ts, the Run Crysk step), and its models in
// the `models` input from this variable. The sandbox reviews on the Claude
// subscription only: the action's credential check counts only a CRYSK_* secret, and
// the Claude steps of every route (the whole stack on claude, the materiality judge on
// opencode) run on it. init checks the token's presence only; it never sets a secret.
export const CLAUDE_TOKEN_SECRET = "CRYSK_CLAUDE_OAUTH_TOKEN";
// The pay-as-you-go key. The sandbox's "$0 cash" guarantee rests on it being absent:
// with it set, a credentials order that lists api_key bills per token.
export const API_KEY_SECRET = "CRYSK_CLAUDE_API_KEY";
// The variable the scaffold passes as the `models` input. It holds the models object
// alone, not the whole config (`crysk ci init` prints `jq -c .models`). The rails'
// write allow-list names it as a literal.
export const MODELS_VARIABLE = "CRYSK_MODELS";

// The route a sandbox runs its reviews on, chosen by `init --route`. `claude` (the
// default) leaves CRYSK_MODELS unset, so every role runs the engine's default Claude
// models on the CRYSK_CLAUDE_OAUTH_TOKEN subscription, which is the production stack.
// `opencode:<snapshot>` routes every role but the judge to one free OpenCode model.
export type Route =
  | { kind: "claude" }
  | { kind: "opencode"; modelSnapshot: string };
export const DEFAULT_ROUTE: Route = { kind: "claude" };

const MODEL_SNAPSHOT_SHAPE = /^[A-Za-z0-9.-]+$/;

// The models object for a free OpenCode model (docs/configuration.md, `models`). The
// `default` list covers every role a list does not name; the materiality judge never
// inherits it and stays on Claude (L6 item 5). The model is OpenCode's own free
// provider, `opencode`, which needs no CRYSK_OPENCODE_* secret. The snapshot is
// validated because it is written into the JSON the workflow reads.
export function modelsValueFor(modelSnapshot: string): string {
  if (!MODEL_SNAPSHOT_SHAPE.test(modelSnapshot)) {
    throw new Error(
      `model snapshot ${JSON.stringify(modelSnapshot)} is not valid (letters, digits, . and -)`,
    );
  }
  return JSON.stringify({ default: [`opencode:opencode/${modelSnapshot}`] });
}

// The value of `init --route`: `claude`, or `opencode:<snapshot>`.
export function parseRoute(
  value: string,
): { route: Route } | { error: string } {
  if (value === "claude") return { route: { kind: "claude" } };
  const prefix = "opencode:";
  if (value.startsWith(prefix)) {
    const modelSnapshot = value.slice(prefix.length);
    if (MODEL_SNAPSHOT_SHAPE.test(modelSnapshot)) {
      return { route: { kind: "opencode", modelSnapshot } };
    }
  }
  return {
    error: `--route ${value} is not claude or opencode:<modelSnapshot> (the snapshot uses letters, digits, . and -)`,
  };
}

// The repo config, read from the checkout (not the person layer). every_push
// admits every push and never skips for risk; ci_max_attempts is high enough
// that the attempt cap never fires on a re-run of the same scenario PR. The
// observe-only flag stays off, so skip reasons still appear and can be read.
export const REPO_CONFIG_JSON = `${JSON.stringify(
  { ci_review_policy: "every_push", ci_max_attempts: 100 },
  null,
  2,
)}\n`;

// The repo config the budget scenarios commit on their branch (budget-answered,
// budget-unanswered): the same policy, with a budget of one automatic review, so the
// first push is reviewed and the second meets the exhausted budget. A pull_request run
// checks out the PR's merge ref (the scaffold's checkout sets no `ref:`), and the CLI
// reads the repo config from that checkout, so the branch's file is the one admission reads.
export const BUDGET_ONE_CONFIG_JSON = `${JSON.stringify(
  { ci_review_policy: "every_push", ci_max_attempts: 1 },
  null,
  2,
)}\n`;

export const REPO_DESCRIPTION =
  "pr-hero's CI test bed: a scratch repo for scenario runs of the pr-hero review action";

export const PLANTED_COMMIT_MESSAGE = "refactor: simplify volume scaling";

const ACTION_REPO = "cryskai/crysk";
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

// Where the planted bug is, as the fixture's answer key puts it (fixtures/setup.ts):
// the whole buggy volume file, since every line of it is the planted contract change.
// A finding anchored anywhere in it is the planted bug. Defined once here, so review-free's
// check and its fixtures read the same site.
export const PLANTED_SITE = {
  path: VOLUME_PATH,
  lineMin: 1,
  lineMax: VOLUME_BUGGY.trimEnd().split("\n").length,
} as const;
