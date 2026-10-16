// The pure error contract for the agent-first CI (odd/tasks/agent-first-ci.md,
// T2a / S2). Every failure pr-hero reports in action mode is classified into
// one ErrorClass, named by one stable ErrorCode, given an owner that says whose
// fix it is (your configuration, a provider, pr-hero itself, or unclassified:
// never a guess), and rendered as one workflow-command annotation plus a
// Markdown summary block.
//
// Consumers: test/ci/outcome.test.ts (now); the publisher and status mapping
// (T2b) and classify-error / CliError.cls (T2c) later. Every export is one of
// those. ERROR_CODES and ERROR_CATALOG are exported so the tests can walk every
// code and check the docs section against the catalog text.
//
// WHY ONLY BUILTINS: the action step that prints these errors runs BEFORE
// `bun install` (the same rule as src/ci/trigger.ts), so this module may import
// nothing but `node:` / `bun` builtins at runtime. Repository modules are
// imported with `import type` only: those are erased at transpile time and need
// no node_modules. test/ci/outcome.test.ts fails if a runtime import of a repo
// module appears here.
//
// The escape rule in escapeCommandData is a COPY of the one in
// src/ci/trigger.ts. That copy is private there, so it cannot be imported
// without widening trigger.ts; the drift test compares the two source texts.

import type { TransportFailureCause } from "../execution/contracts";
import type { CredentialProjectionFailureClass } from "../security/credential-broker";

export type Owner = "config" | "provider" | "pr-hero" | "unclassified";
export type OutcomeContext = "action" | "local";

export type ErrorClass =
  | {
      kind: "trigger";
      check: "no-credential" | "routing-missing" | "pr-unresolved";
    }
  | {
      kind: "config-parse";
      source: "routing" | "repo-config" | "person-config" | "extra-hunters";
    }
  | { kind: "prompt-set" }
  | { kind: "gotchas"; reason: "empty" | "placeholder" }
  | {
      kind: "route";
      reason:
        | "unmapped"
        | "ambiguous"
        | "spend-disabled"
        | "multiple-opencode-providers";
    }
  | {
      kind: "credential";
      failureClass: CredentialProjectionFailureClass | "env-absent";
    }
  | {
      kind: "capability";
      issue: "binary_unresolved" | "sdk_unavailable" | "version_unsupported";
    }
  | { kind: "transport"; cause: TransportFailureCause | "legacy_terminal" }
  | { kind: "github"; status: number }
  | { kind: "install"; step: string }
  | { kind: "invariant" }
  | { kind: "unknown" };

export const ERROR_CODES = [
  "PRH-CRED-MISSING",
  "PRH-CRED-UNUSABLE",
  "PRH-CRED-REJECTED",
  "PRH-ROUTING-MISSING",
  "PRH-ROUTING-INVALID",
  "PRH-ROUTE-UNRESOLVABLE",
  "PRH-MODEL-UNAVAILABLE",
  "PRH-PROMPTSET-INVALID",
  "PRH-GOTCHAS-MISSING",
  "PRH-CONFIG-INVALID",
  "PRH-TOKEN-PERMISSION",
  "PRH-GITHUB-TOKEN-INVALID",
  "PRH-GITHUB-UNAVAILABLE",
  "PRH-PR-UNRESOLVED",
  "PRH-STATUS-WRITE-FAILED",
  "PRH-RUNTIME-UNAVAILABLE",
  "PRH-INSTALL-FAILED",
  "PRH-PROVIDER-LIMITED",
  "PRH-PROVIDER-UNAVAILABLE",
  "PRH-PROVIDER-REFUSED",
  "PRH-ENGINE-DEFECT",
  "PRH-HUNTERS-FAILED",
  "PRH-UNCLASSIFIED",
  "PRH-CANCELLED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface CatalogVariant {
  readonly why: string;
  readonly fixes: readonly string[];
}

// A fix line starting with "$ " is a command; any other line is prose. Each
// placeholder {name} is one ErrorParams key (see NEUTRAL below for the words
// used when a value is missing).
export interface CatalogEntry {
  readonly level: "error" | "notice";
  readonly owner: Owner | Readonly<Record<OutcomeContext, Owner>>;
  readonly headline?: string;
  readonly lead?: string;
  readonly providerName?: string;
  readonly what: string;
  // "default" is always present. Keys "action" / "local" select by context
  // (PRH-RUNTIME-UNAVAILABLE); other keys are the failure's sub-class
  // (credential failureClass, route reason), chosen by renderError.
  readonly variants: Readonly<Record<string, CatalogVariant>>;
}

export interface ErrorParams {
  backend?: string;
  provider?: string;
  step?: string;
  secret?: string;
  scope?: string;
  pr?: number;
  runId?: string;
  runUrl?: string;
  detail?: string;
}

export interface RenderedError {
  code: ErrorCode;
  owner: Owner;
  annotation: string;
  summary: string[];
}

// A switch over a closed union ends in `unmapped(value, fallback)`. A new
// member fails to compile at that call (the `never` argument), and a value
// outside the union at runtime still gets the honest fallback, never a
// guessed owner.
function unmapped<T>(_value: never, fallback: T): T {
  return fallback;
}

export function codeOf(cls: ErrorClass): ErrorCode {
  switch (cls.kind) {
    case "trigger":
      switch (cls.check) {
        case "no-credential":
          return "PRH-CRED-MISSING";
        case "routing-missing":
          return "PRH-ROUTING-MISSING";
        case "pr-unresolved":
          return "PRH-PR-UNRESOLVED";
        default:
          return unmapped(cls.check, "PRH-UNCLASSIFIED");
      }
    case "config-parse":
      switch (cls.source) {
        case "routing":
          return "PRH-ROUTING-INVALID";
        case "repo-config":
        case "person-config":
          return "PRH-CONFIG-INVALID";
        case "extra-hunters":
          return "PRH-PROMPTSET-INVALID";
        default:
          return unmapped(cls.source, "PRH-UNCLASSIFIED");
      }
    case "prompt-set":
      return "PRH-PROMPTSET-INVALID";
    // `reason` is captured in a local: it is a discriminant shared by the
    // gotchas and route members, so narrowing on `cls.reason` in the inner
    // default would collapse `cls` itself to never.
    case "gotchas": {
      const reason = cls.reason;
      switch (reason) {
        case "empty":
        case "placeholder":
          return "PRH-GOTCHAS-MISSING";
        default:
          return unmapped(reason, "PRH-UNCLASSIFIED");
      }
    }
    case "route": {
      const reason = cls.reason;
      switch (reason) {
        case "unmapped":
        case "ambiguous":
        case "spend-disabled":
        case "multiple-opencode-providers":
          return "PRH-ROUTE-UNRESOLVABLE";
        default:
          return unmapped(reason, "PRH-UNCLASSIFIED");
      }
    }
    case "credential":
      switch (cls.failureClass) {
        case "missing_provider_record":
        case "missing_subscription_record":
        case "malformed_payload":
        case "source_read_failed":
        case "env-absent":
          return "PRH-CRED-UNUSABLE";
        case "unsupported_kind":
        case "projection_layout_invalid":
          return "PRH-ENGINE-DEFECT";
        default:
          return unmapped(cls.failureClass, "PRH-UNCLASSIFIED");
      }
    case "capability":
      switch (cls.issue) {
        case "binary_unresolved":
        case "sdk_unavailable":
        case "version_unsupported":
          return "PRH-RUNTIME-UNAVAILABLE";
        default:
          return unmapped(cls.issue, "PRH-UNCLASSIFIED");
      }
    case "transport":
      return transportCode(cls.cause);
    case "github":
      if (cls.status === 403) return "PRH-TOKEN-PERMISSION";
      if (cls.status === 401) return "PRH-GITHUB-TOKEN-INVALID";
      return "PRH-GITHUB-UNAVAILABLE";
    case "install":
      return "PRH-INSTALL-FAILED";
    case "invariant":
      return "PRH-ENGINE-DEFECT";
    case "unknown":
      return "PRH-UNCLASSIFIED";
    default:
      return unmapped(cls, "PRH-UNCLASSIFIED");
  }
}

function transportCode(
  cause: TransportFailureCause | "legacy_terminal",
): ErrorCode {
  switch (cause) {
    case "auth_invalid":
      return "PRH-CRED-REJECTED";
    case "quota_exhausted":
    case "rate_limit":
      return "PRH-PROVIDER-LIMITED";
    case "network_transient":
    case "remote_abort_unconfirmed":
      return "PRH-PROVIDER-UNAVAILABLE";
    case "safety_refusal":
      return "PRH-PROVIDER-REFUSED";
    case "provider_configuration_invalid":
      return "PRH-MODEL-UNAVAILABLE";
    case "protocol_truncation":
    case "protocol_mismatch":
    case "protocol_overflow":
    case "output_limit_exceeded":
    case "context_window_exceeded":
    case "runtime_unavailable":
      return "PRH-ENGINE-DEFECT";
    case "legacy_terminal":
      return "PRH-UNCLASSIFIED";
    default:
      return unmapped(cause, "PRH-UNCLASSIFIED");
  }
}

export function ownerOf(cls: ErrorClass, ctx: OutcomeContext): Owner {
  switch (cls.kind) {
    case "trigger":
      switch (cls.check) {
        case "no-credential":
        case "routing-missing":
        case "pr-unresolved":
          return "config";
        default:
          return unmapped(cls.check, "unclassified");
      }
    case "config-parse":
      switch (cls.source) {
        case "routing":
        case "repo-config":
        case "person-config":
        case "extra-hunters":
          return "config";
        default:
          return unmapped(cls.source, "unclassified");
      }
    case "prompt-set":
    case "gotchas":
    case "route":
      return "config";
    case "credential":
      switch (cls.failureClass) {
        case "missing_provider_record":
        case "missing_subscription_record":
        case "malformed_payload":
        case "source_read_failed":
        case "env-absent":
          return "config";
        case "unsupported_kind":
        case "projection_layout_invalid":
          return "pr-hero";
        default:
          return unmapped(cls.failureClass, "unclassified");
      }
    case "capability":
      switch (cls.issue) {
        case "binary_unresolved":
        case "sdk_unavailable":
        case "version_unsupported":
          // pr-hero installs these runtimes in the action; locally a tool is
          // missing from the user's own environment.
          return ctx === "action" ? "pr-hero" : "config";
        default:
          return unmapped(cls.issue, "unclassified");
      }
    case "transport":
      return transportOwner(cls.cause);
    case "github":
      return cls.status === 403 || cls.status === 401 ? "config" : "provider";
    case "install":
      return "unclassified";
    case "invariant":
      return "pr-hero";
    case "unknown":
      return "unclassified";
    default:
      return unmapped(cls, "unclassified");
  }
}

function transportOwner(
  cause: TransportFailureCause | "legacy_terminal",
): Owner {
  switch (cause) {
    case "auth_invalid":
    case "quota_exhausted":
    case "rate_limit":
    case "network_transient":
    case "remote_abort_unconfirmed":
    case "safety_refusal":
      return "provider";
    case "provider_configuration_invalid":
      return "config";
    case "protocol_truncation":
    case "protocol_mismatch":
    case "protocol_overflow":
    case "output_limit_exceeded":
    case "context_window_exceeded":
    case "runtime_unavailable":
      return "pr-hero";
    case "legacy_terminal":
      return "unclassified";
    default:
      return unmapped(cause, "unclassified");
  }
}

export function ownerLead(owner: Owner, provider?: string): string {
  switch (owner) {
    case "config":
      return "Your configuration:";
    case "provider": {
      const name = provider?.trim();
      return name ? `Provider ${name}:` : "Provider:";
    }
    case "pr-hero":
      return "pr-hero defect:";
    case "unclassified":
      return "Unclassified:";
    default:
      return unmapped(owner, "Unclassified:");
  }
}

// The words a missing value renders as. Identifiers use angle placeholders so a
// command that cannot be filled is visibly unfinished; prose uses plain words.
const NEUTRAL: Record<keyof ErrorParams, string> = {
  backend: "<backend>",
  provider: "<provider>",
  step: "this step",
  secret: "<secret-name>",
  scope: "<scope>",
  pr: "<pr>",
  runId: "<run-id>",
  runUrl: "<run-url>",
  detail: "no further detail",
};

const DOCS_BASE =
  "https://github.com/juanmaagd/pr-hero/blob/v0/docs/github-actions.md#";

const ENGINE_DEFECT_ISSUE =
  'gh issue create -R juanmaagd/pr-hero --title "PRH-ENGINE-DEFECT {detail}" --body "{runUrl}"';
const RERUN_FAILED = "$ gh run rerun {runId} --failed";
const REVIEW_AGAIN = '$ gh pr comment {pr} --body "/pr-hero review"';
const OPENCODE_STORE =
  "$ gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json";
const CRED_STORE_WHY =
  "the credential store does not hold what this route needs";
const ROUTE_WHY = "every agent needs exactly one backend, provider and model";
const PROVIDER_REFUSED_WHY = "the provider's safety system declined this input";
// The GitHub Actions expression is spliced in from two literals so the source
// never holds a `${` pair that reads as a template placeholder here.
const GITHUB_TOKEN_INPUT = "github-token: $" + "{{ secrets.GITHUB_TOKEN }}";

function single(
  why: string,
  fixes: readonly string[],
): Readonly<Record<string, CatalogVariant>> {
  return { default: { why, fixes } };
}

const CREDENTIAL_UNUSABLE_ENV: CatalogVariant = {
  why: CRED_STORE_WHY,
  fixes: ["Set the secret again:", "$ gh secret set {secret}"],
};

const ROUTE_UNMAPPED: CatalogVariant = {
  why: ROUTE_WHY,
  fixes: ["Add a `modelSnapshot` for this route to PRHERO_ROUTING."],
};

const RUNTIME_LOCAL: CatalogVariant = {
  why: "a required tool is missing from your environment",
  fixes: ["Reconcile the pr-hero install:", "$ pr-hero upgrade --reconcile"],
};

// WHY no class maps to PRH-STATUS-WRITE-FAILED, PRH-HUNTERS-FAILED or
// PRH-CANCELLED: each is a condition the caller observes directly (a status
// write, the hunter set, a superseded run), so the caller requests the code
// through renderCode. The class-to-code table cannot see those conditions.
export const ERROR_CATALOG: Readonly<Record<ErrorCode, CatalogEntry>> = {
  "PRH-CRED-MISSING": {
    level: "error",
    owner: "config",
    what: "No credential for the {backend} route reached the action",
    variants: single(
      "pr-hero cannot authenticate, so it cannot review this PR",
      [
        "Set one credential for the route you use:",
        "$ claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN",
        "$ gh secret set ANTHROPIC_API_KEY",
        "$ opencode auth login && gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json",
        "Dependabot PRs read Dependabot secrets, so set this one too:",
        "$ gh secret set --app dependabot CLAUDE_CODE_OAUTH_TOKEN",
        "Then re-run the workflow:",
        "$ gh run rerun {runId}",
      ],
    ),
  },
  "PRH-CRED-UNUSABLE": {
    level: "error",
    owner: "config",
    what: "The {backend}/{provider} route for {step} has no usable credential ({detail})",
    variants: {
      missing_provider_record: {
        why: CRED_STORE_WHY,
        fixes: [
          "Add {provider} to the OpenCode store, then re-set the secret:",
          "$ opencode auth login",
          OPENCODE_STORE,
        ],
      },
      missing_subscription_record: {
        why: CRED_STORE_WHY,
        fixes: [
          "Provider `openai` means ChatGPT OAuth: log in that way, or rename the provider in PRHERO_ROUTING.",
        ],
      },
      malformed_payload: {
        why: CRED_STORE_WHY,
        fixes: [
          "Check that the store is a JSON object:",
          "$ jq -e 'type==\"object\"' ~/.local/share/opencode/auth.json",
          "Then re-set the secret:",
          OPENCODE_STORE,
        ],
      },
      source_read_failed: CREDENTIAL_UNUSABLE_ENV,
      "env-absent": CREDENTIAL_UNUSABLE_ENV,
      default: CREDENTIAL_UNUSABLE_ENV,
    },
  },
  "PRH-CRED-REJECTED": {
    level: "error",
    owner: "provider",
    what: "the credential in {secret} was rejected",
    variants: single(
      "it is expired, revoked, or a short-lived /login session token",
      [
        "$ claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN",
        "Or, for OpenCode, re-export the auth store and re-set the secret:",
        OPENCODE_STORE,
        "Then ask for a new review:",
        REVIEW_AGAIN,
      ],
    ),
  },
  "PRH-ROUTING-MISSING": {
    level: "error",
    owner: "config",
    what: "OpenCode auth is set but PRHERO_ROUTING is empty, so the default Claude route is used",
    variants: single(
      "the run would fail later at the Claude credential check",
      [
        '$ gh variable set PRHERO_ROUTING --body "$(jq -c .routing ~/.prhero/config.json)"',
      ],
    ),
  },
  "PRH-ROUTING-INVALID": {
    level: "error",
    owner: "config",
    what: "PRHERO_ROUTING is invalid: {detail}",
    variants: single(
      "pr-hero cannot tell which backend and model each agent should use",
      [
        "Edit the JSON, then set it again:",
        '$ gh variable set PRHERO_ROUTING --body "$(jq -c . routing.json)"',
      ],
    ),
  },
  "PRH-ROUTE-UNRESOLVABLE": {
    level: "error",
    owner: "config",
    what: "Model routing for {step} has no usable route: {detail}",
    variants: {
      unmapped: ROUTE_UNMAPPED,
      ambiguous: {
        why: ROUTE_WHY,
        fixes: [
          "Remove the duplicate mapping for this route from PRHERO_ROUTING.",
        ],
      },
      "spend-disabled": {
        why: ROUTE_WHY,
        fixes: ["Enable spend for this route in PRHERO_ROUTING."],
      },
      "multiple-opencode-providers": {
        why: ROUTE_WHY,
        fixes: ["Keep one OpenCode provider per review in PRHERO_ROUTING."],
      },
      default: ROUTE_UNMAPPED,
    },
  },
  "PRH-MODEL-UNAVAILABLE": {
    level: "error",
    owner: "config",
    what: "Provider {provider} does not serve the model configured for {step}",
    variants: single("the routing names a model this provider does not offer", [
      "Fix the `modelSnapshot` for this step in PRHERO_ROUTING.",
      "List the models this provider serves:",
      "$ opencode models {provider}",
    ]),
  },
  "PRH-PROMPTSET-INVALID": {
    level: "error",
    owner: "config",
    what: "The prompt set is invalid: {detail}",
    variants: single(
      "an agent file or PRHERO_EXTRA_HUNTERS entry cannot be loaded",
      [
        "Fix the file or `agents_dir`, then check for free:",
        "$ pr-hero review --pr {pr} --dry-run",
      ],
    ),
  },
  "PRH-GOTCHAS-MISSING": {
    level: "error",
    owner: "config",
    what: ".prhero/gotchas.md is missing or still the scaffold",
    variants: single("reviews need real repository facts to be accurate", [
      "Write real facts about this repository, delete the scaffold marker line, and commit the file to the base branch (comment-triggered runs read the base branch).",
    ]),
  },
  "PRH-CONFIG-INVALID": {
    level: "error",
    owner: "config",
    what: ".prhero/config.json is invalid: {detail}",
    variants: single("pr-hero refuses to guess repository settings", [
      "Fix the file, then check it:",
      "$ pr-hero review --pr {pr} --dry-run",
    ]),
  },
  "PRH-TOKEN-PERMISSION": {
    level: "error",
    owner: "config",
    what: "The workflow token lacks `{scope}: write`",
    variants: single("pr-hero cannot post its result on the PR", [
      "Add `{scope}: write` to the job's `permissions:`, or re-scaffold the workflow:",
      "$ pr-hero ci init --force",
    ]),
  },
  "PRH-GITHUB-TOKEN-INVALID": {
    level: "error",
    owner: "config",
    what: "The github-token input is invalid",
    variants: single("every GitHub API call is rejected", [
      `Set \`${GITHUB_TOKEN_INPUT}\` on the action step.`,
    ]),
  },
  "PRH-GITHUB-UNAVAILABLE": {
    level: "error",
    owner: "provider",
    providerName: "GitHub",
    what: "The GitHub API failed ({detail})",
    variants: single("this is an outage or rate limit outside pr-hero", [
      "Re-run the workflow:",
      "$ gh run rerun {runId}",
    ]),
  },
  "PRH-PR-UNRESOLVED": {
    level: "error",
    owner: "config",
    what: "pr-hero could not determine the pull request number or head",
    variants: single("nothing can be posted on a PR it cannot identify", [
      "Run from a pull_request or issue_comment event, or pass the `pr-number` input.",
    ]),
  },
  "PRH-STATUS-WRITE-FAILED": {
    level: "error",
    owner: "config",
    what: "pr-hero could not write its commit status ({detail})",
    variants: single(
      "the required check has no result for this head without it",
      ["see PRH-TOKEN-PERMISSION"],
    ),
  },
  "PRH-RUNTIME-UNAVAILABLE": {
    level: "error",
    owner: { action: "pr-hero", local: "config" },
    what: "{detail} is unavailable or the wrong version",
    variants: {
      action: {
        why: "the action installs this runtime itself, so this is a pr-hero defect",
        fixes: [
          "Report it with this run:",
          '$ gh issue create -R juanmaagd/pr-hero --title "PRH-RUNTIME-UNAVAILABLE" --body "{runUrl}"',
        ],
      },
      local: RUNTIME_LOCAL,
      default: RUNTIME_LOCAL,
    },
  },
  "PRH-INSTALL-FAILED": {
    level: "error",
    owner: "unclassified",
    what: "The {step} step failed",
    variants: single("an external download failed; pr-hero cannot tell why", [
      "Re-run only the failed jobs:",
      RERUN_FAILED,
      "If it repeats, report it.",
    ]),
  },
  "PRH-PROVIDER-LIMITED": {
    level: "error",
    owner: "provider",
    what: "rate limit or quota reached",
    variants: single(
      "the provider has throttled this account or key, so an immediate retry would fail the same way",
      ["Wait, or raise the quota, then ask for a new review:", REVIEW_AGAIN],
    ),
  },
  "PRH-PROVIDER-UNAVAILABLE": {
    level: "error",
    owner: "provider",
    what: "unreachable",
    variants: single(
      "the request did not complete, and the provider's outcome cannot be confirmed from here",
      ["Re-run the workflow:", "$ gh run rerun {runId}"],
    ),
  },
  "PRH-PROVIDER-REFUSED": {
    level: "error",
    owner: "provider",
    what: "the request was refused",
    variants: single(PROVIDER_REFUSED_WHY, [
      "Ask for a new review once:",
      REVIEW_AGAIN,
      "If it repeats, report it.",
    ]),
  },
  "PRH-ENGINE-DEFECT": {
    level: "error",
    owner: "pr-hero",
    what: "pr-hero hit an internal error ({detail}) in {step}",
    variants: single("this is a defect in pr-hero, not in your configuration", [
      "Report it, with this run:",
      `$ ${ENGINE_DEFECT_ISSUE}`,
    ]),
  },
  "PRH-HUNTERS-FAILED": {
    level: "error",
    owner: "unclassified",
    what: "Every review hunter failed in {step}: {detail}",
    variants: single(
      "no hunter returned a result, so there is no finding to report",
      ["Re-run the failed jobs:", RERUN_FAILED, "If it repeats, report it."],
    ),
  },
  "PRH-UNCLASSIFIED": {
    level: "error",
    owner: "unclassified",
    what: "pr-hero stopped at {step} and could not tell why",
    variants: single("rather than guess, it reports this honestly", [
      "Re-run the failed jobs:",
      RERUN_FAILED,
      "If it repeats, read the log and report it:",
      "$ gh run view {runId} --log-failed",
    ]),
  },
  "PRH-CANCELLED": {
    level: "notice",
    owner: "unclassified",
    lead: "Not reviewed:",
    headline: "PRH-CANCELLED: not reviewed",
    what: "The review was cancelled or superseded by a newer push",
    variants: single(
      "a newer run replaces this one, so this result would describe an outdated head",
      ["Ask for a review of the current head:", REVIEW_AGAIN],
    ),
  },
};

export function renderError(
  cls: ErrorClass,
  params: ErrorParams,
  ctx: OutcomeContext,
): RenderedError {
  const detail = isBlank(params.detail) ? classDetail(cls) : params.detail;
  const merged = detail === undefined ? params : { ...params, detail };
  return renderCode(
    codeOf(cls),
    ownerOf(cls, ctx),
    merged,
    ctx,
    variantOf(cls),
  );
}

// For a code the caller requests directly. `variant` picks a sub-class fix; it
// is only needed for codes with sub-class variants, and renderError supplies it.
export function renderCode(
  code: ErrorCode,
  owner: Owner,
  params: ErrorParams,
  ctx: OutcomeContext,
  variant?: string,
): RenderedError {
  const entry = ERROR_CATALOG[code];
  const picked = pickVariant(entry, ctx, variant);
  const providerName = entry.providerName ?? cleanName(params.provider);
  const lead = entry.lead ?? ownerLead(owner, providerName);
  const link = `${DOCS_BASE}${code.toLowerCase()}`;
  const message =
    `${lead} ${fill(entry.what, params, false)}. ` +
    `Why: ${fill(picked.why, params, false)}. ` +
    `Fix: ${annotationFix(picked.fixes, params)}. ` +
    `Docs: ${link}`;
  return {
    code,
    owner,
    annotation: `::${entry.level} title=pr-hero ${code}::${escapeCommandData(message)}`,
    summary: summaryLines(code, entry, lead, picked, params, link),
  };
}

function pickVariant(
  entry: CatalogEntry,
  ctx: OutcomeContext,
  variant: string | undefined,
): CatalogVariant {
  const table: Partial<Record<string, CatalogVariant>> = entry.variants;
  return (
    table[ctx] ??
    (variant === undefined ? undefined : table[variant]) ??
    entry.variants.default
  );
}

function variantOf(cls: ErrorClass): string | undefined {
  if (cls.kind === "credential") return cls.failureClass;
  if (cls.kind === "route") return cls.reason;
  return undefined;
}

function classDetail(cls: ErrorClass): string | undefined {
  switch (cls.kind) {
    case "capability":
      return cls.issue;
    case "credential":
      return cls.failureClass;
    case "transport":
      return cls.cause;
    case "route":
      return cls.reason;
    case "github":
      return `HTTP ${cls.status}`;
    default:
      return undefined;
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function cleanName(value: string | undefined): string | undefined {
  return isBlank(value) ? undefined : value?.trim();
}

function paramText(params: ErrorParams, key: keyof ErrorParams): string {
  const raw = params[key];
  const text = raw === undefined || raw === null ? "" : String(raw);
  return text.trim() === "" ? NEUTRAL[key] : text;
}

// Fills {name} placeholders. The annotation keeps raw values (escaped below);
// the Markdown summary flattens line breaks so a value cannot break its block.
function fill(template: string, params: ErrorParams, flatten: boolean): string {
  return template.replace(/\{(\w+)\}/g, (placeholder: string, name: string) => {
    const key = name as keyof ErrorParams;
    if (!(key in NEUTRAL)) return placeholder;
    const text = paramText(params, key);
    return flatten ? text.replace(/\r\n|\r|\n/g, " ") : text;
  });
}

function annotationFix(fixes: readonly string[], params: ErrorParams): string {
  const command = fixes.find((line) => line.startsWith("$ "));
  const chosen = command !== undefined ? command.slice(2) : (fixes[0] ?? "");
  return fill(chosen, params, false).replace(/[:.]+$/, "");
}

function summaryLines(
  code: ErrorCode,
  entry: CatalogEntry,
  lead: string,
  picked: CatalogVariant,
  params: ErrorParams,
  link: string,
): string[] {
  const flat = (text: string): string => fill(text, params, true);
  return [
    `### ${entry.headline ?? code}`,
    "",
    `${lead} ${flat(entry.what)}`,
    "",
    `Why: ${flat(picked.why)}`,
    "",
    "Fix:",
    "",
    ...fixBlocks(picked.fixes, flat),
    `Docs: ${link}`,
  ];
}

// Consecutive "$ " lines share one bash fence; prose lines stand alone.
function fixBlocks(
  fixes: readonly string[],
  flat: (text: string) => string,
): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of fixes) {
    const command = line.startsWith("$ ");
    if (command && !inBlock) {
      out.push("```bash");
      inBlock = true;
    }
    if (!command && inBlock) {
      out.push("```", "");
      inBlock = false;
    }
    out.push(command ? flat(line.slice(2)) : flat(line));
    if (!command) out.push("");
  }
  if (inBlock) out.push("```", "");
  return out;
}

// Workflow-command message escaping, copied from src/ci/trigger.ts
// (escapeCommandData). The drift test in test/ci/outcome.test.ts compares the
// two source texts; keep them identical.
function escapeCommandData(text: string): string {
  return text
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}
