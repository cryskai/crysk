// T2a (odd/tasks/agent-first-ci.md, S2): the pure error contract in
// src/ci/outcome.ts. Covers the class -> code -> owner tables over every member
// of the real unions, the catalog and its docs parity, the renderer contract
// (one annotation line, owner lead first, escaping, neutral words for missing
// params, every fix command present), the builtins-only guard, and the drift
// guard that keeps the escape rule equal to src/ci/trigger.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  actionsRunUrl,
  type CatalogEntry,
  type CliRecord,
  codeOf,
  ERROR_CATALOG,
  ERROR_CODES,
  type ErrorClass,
  type ErrorCode,
  type ErrorParams,
  OUTCOME_MARKER_PREFIX,
  type OutcomeContext,
  type Owner,
  ownerLead,
  ownerOf,
  parseCliRecord,
  parseOutcomeCode,
  parseTriggerRecord,
  renderCode,
  renderError,
  type TriggerRecord,
  type UnsettledStatus,
} from "#ci/outcome";
import type { TransportFailureCause } from "../../src/execution/contracts";
import type { CredentialProjectionFailureClass } from "../../src/security/credential-broker";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const OUTCOME_SRC = path.join(REPO_ROOT, "src/ci/outcome.ts");
const TRIGGER_SRC = path.join(REPO_ROOT, "src/ci/trigger.ts");
const DOCS = path.join(REPO_ROOT, "docs/github-actions.md");
const DOCS_URL_PREFIX =
  "https://github.com/juanmaagd/pr-hero/blob/v0/docs/github-actions.md#";
const CONTEXTS: OutcomeContext[] = ["action", "local"];

// Exhaustive expectations. Typing them as Record over the real unions makes
// `bun run typecheck` the gate when contracts.ts or credential-broker.ts grows.
const CREDENTIAL_EXPECTED: Record<
  CredentialProjectionFailureClass | "env-absent",
  { code: ErrorCode; owner: Owner }
> = {
  unsupported_kind: { code: "PRH-ENGINE-DEFECT", owner: "pr-hero" },
  projection_layout_invalid: { code: "PRH-ENGINE-DEFECT", owner: "pr-hero" },
  source_read_failed: { code: "PRH-CRED-UNUSABLE", owner: "config" },
  malformed_payload: { code: "PRH-CRED-UNUSABLE", owner: "config" },
  missing_subscription_record: { code: "PRH-CRED-UNUSABLE", owner: "config" },
  missing_provider_record: { code: "PRH-CRED-UNUSABLE", owner: "config" },
  "env-absent": { code: "PRH-CRED-UNUSABLE", owner: "config" },
};

const TRANSPORT_EXPECTED: Record<
  TransportFailureCause | "legacy_terminal",
  { code: ErrorCode; owner: Owner }
> = {
  auth_invalid: { code: "PRH-CRED-REJECTED", owner: "config" },
  quota_exhausted: { code: "PRH-PROVIDER-LIMITED", owner: "provider" },
  rate_limit: { code: "PRH-PROVIDER-LIMITED", owner: "provider" },
  network_transient: { code: "PRH-PROVIDER-UNAVAILABLE", owner: "provider" },
  remote_abort_unconfirmed: {
    code: "PRH-PROVIDER-UNAVAILABLE",
    owner: "provider",
  },
  safety_refusal: { code: "PRH-PROVIDER-REFUSED", owner: "provider" },
  provider_configuration_invalid: {
    code: "PRH-MODEL-UNAVAILABLE",
    owner: "config",
  },
  model_unavailable: { code: "PRH-MODEL-UNAVAILABLE", owner: "provider" },
  missing_provider_record: { code: "PRH-CRED-UNUSABLE", owner: "config" },
  protocol_truncation: { code: "PRH-ENGINE-DEFECT", owner: "pr-hero" },
  protocol_mismatch: { code: "PRH-ENGINE-DEFECT", owner: "pr-hero" },
  protocol_overflow: { code: "PRH-ENGINE-DEFECT", owner: "pr-hero" },
  output_limit_exceeded: { code: "PRH-ENGINE-DEFECT", owner: "pr-hero" },
  context_window_exceeded: { code: "PRH-ENGINE-DEFECT", owner: "pr-hero" },
  runtime_unavailable: { code: "PRH-UNCLASSIFIED", owner: "unclassified" },
  legacy_terminal: { code: "PRH-UNCLASSIFIED", owner: "unclassified" },
};

const CAPABILITY_ISSUES = [
  "binary_unresolved",
  "sdk_unavailable",
  "version_unsupported",
] as const;

// Codes no class produces: the caller requests them explicitly.
const EXPLICIT_ONLY_CODES: ErrorCode[] = [
  "PRH-STATUS-WRITE-FAILED",
  "PRH-HUNTERS-FAILED",
  "PRH-CANCELLED",
];

interface Sample {
  name: string;
  cls: ErrorClass;
  code: ErrorCode;
  owner: Owner;
}

const SAMPLES: Sample[] = [
  {
    name: "trigger no-credential",
    cls: { kind: "trigger", check: "no-credential" },
    code: "PRH-CRED-MISSING",
    owner: "config",
  },
  {
    name: "trigger routing-missing",
    cls: { kind: "trigger", check: "routing-missing" },
    code: "PRH-ROUTING-MISSING",
    owner: "config",
  },
  {
    name: "trigger pr-unresolved",
    cls: { kind: "trigger", check: "pr-unresolved" },
    code: "PRH-PR-UNRESOLVED",
    owner: "config",
  },
  {
    name: "config-parse routing",
    cls: { kind: "config-parse", source: "routing" },
    code: "PRH-ROUTING-INVALID",
    owner: "config",
  },
  {
    name: "config-parse repo-config",
    cls: { kind: "config-parse", source: "repo-config" },
    code: "PRH-CONFIG-INVALID",
    owner: "config",
  },
  {
    name: "config-parse person-config",
    cls: { kind: "config-parse", source: "person-config" },
    code: "PRH-CONFIG-INVALID",
    owner: "config",
  },
  {
    name: "config-parse extra-hunters",
    cls: { kind: "config-parse", source: "extra-hunters" },
    code: "PRH-PROMPTSET-INVALID",
    owner: "config",
  },
  {
    name: "prompt-set",
    cls: { kind: "prompt-set" },
    code: "PRH-PROMPTSET-INVALID",
    owner: "config",
  },
  {
    name: "gotchas empty",
    cls: { kind: "gotchas", reason: "empty" },
    code: "PRH-GOTCHAS-MISSING",
    owner: "config",
  },
  {
    name: "gotchas placeholder",
    cls: { kind: "gotchas", reason: "placeholder" },
    code: "PRH-GOTCHAS-MISSING",
    owner: "config",
  },
  {
    name: "route unmapped",
    cls: { kind: "route", reason: "unmapped" },
    code: "PRH-ROUTE-UNRESOLVABLE",
    owner: "config",
  },
  {
    name: "route ambiguous",
    cls: { kind: "route", reason: "ambiguous" },
    code: "PRH-ROUTE-UNRESOLVABLE",
    owner: "config",
  },
  {
    name: "route spend-disabled",
    cls: { kind: "route", reason: "spend-disabled" },
    code: "PRH-ROUTE-UNRESOLVABLE",
    owner: "config",
  },
  {
    name: "route multiple-opencode-providers",
    cls: { kind: "route", reason: "multiple-opencode-providers" },
    code: "PRH-ROUTE-UNRESOLVABLE",
    owner: "config",
  },
  {
    name: "github 403",
    cls: { kind: "github", status: 403 },
    code: "PRH-TOKEN-PERMISSION",
    owner: "config",
  },
  {
    name: "github 401",
    cls: { kind: "github", status: 401 },
    code: "PRH-GITHUB-TOKEN-INVALID",
    owner: "config",
  },
  {
    name: "github 403 rate limited",
    cls: { kind: "github", status: 403, rateLimited: true },
    code: "PRH-GITHUB-UNAVAILABLE",
    owner: "provider",
  },
  {
    name: "github 404",
    cls: { kind: "github", status: 404 },
    code: "PRH-UNCLASSIFIED",
    owner: "unclassified",
  },
  {
    name: "github 422",
    cls: { kind: "github", status: 422 },
    code: "PRH-UNCLASSIFIED",
    owner: "unclassified",
  },
  {
    name: "github 500",
    cls: { kind: "github", status: 500 },
    code: "PRH-GITHUB-UNAVAILABLE",
    owner: "provider",
  },
  {
    name: "github 429",
    cls: { kind: "github", status: 429 },
    code: "PRH-GITHUB-UNAVAILABLE",
    owner: "provider",
  },
  {
    name: "install",
    cls: { kind: "install", step: "install bun" },
    code: "PRH-INSTALL-FAILED",
    owner: "unclassified",
  },
  {
    name: "invariant",
    cls: { kind: "invariant" },
    code: "PRH-ENGINE-DEFECT",
    owner: "pr-hero",
  },
  {
    name: "unknown",
    cls: { kind: "unknown" },
    code: "PRH-UNCLASSIFIED",
    owner: "unclassified",
  },
  ...(
    Object.keys(CREDENTIAL_EXPECTED) as Array<keyof typeof CREDENTIAL_EXPECTED>
  ).map((failureClass): Sample => {
    const cls: ErrorClass = { kind: "credential", failureClass };
    return {
      name: `credential ${failureClass}`,
      cls,
      code: CREDENTIAL_EXPECTED[failureClass].code,
      owner: CREDENTIAL_EXPECTED[failureClass].owner,
    };
  }),
  ...(
    Object.keys(TRANSPORT_EXPECTED) as Array<keyof typeof TRANSPORT_EXPECTED>
  ).map((cause): Sample => {
    const cls: ErrorClass = { kind: "transport", cause };
    return {
      name: `transport ${cause}`,
      cls,
      code: TRANSPORT_EXPECTED[cause].code,
      owner: TRANSPORT_EXPECTED[cause].owner,
    };
  }),
];

// Every placeholder value is a distinct sentinel, so a substituted command can
// be checked for exact presence in the rendered summary.
const FULL: ErrorParams = {
  backend: "BACKEND",
  provider: "PROVIDER",
  step: "STEP",
  secret: "SECRET_NAME",
  scope: "SCOPE",
  pr: 42,
  runId: "RUN",
  runUrl: "URL",
  detail: "DETAIL",
};

// Lowercase values an operator would really see. The capitalization rule must
// hold for them, not only for the uppercase sentinels in FULL.
const REALISTIC: ErrorParams = {
  backend: "claude",
  provider: "openai",
  step: "review",
  secret: "OPENAI_API_KEY",
  scope: "statuses",
  pr: 42,
  runId: "123456",
  runUrl: "https://github.com/juanmaagd/pr-hero/actions/runs/123456",
  detail: "HTTP 503",
};

function sentinelFill(text: string): string {
  return text.replace(/\{(\w+)\}/g, (_match, key: string) =>
    String(FULL[key as keyof ErrorParams]),
  );
}

type CatalogFixes = CatalogEntry["variants"][string]["fixes"];

// Every fix list a variant can render: its own list, or one per backend when a
// function fix picks the steps by backend (missing_subscription_record).
function fixListsOf(fixes: CatalogFixes): (readonly string[])[] {
  return typeof fixes === "function"
    ? ["claude-code", "opencode"].map((backend) => fixes({ backend }))
    : [fixes];
}

function entryOf(code: ErrorCode): CatalogEntry {
  const entry = ERROR_CATALOG[code];
  expect(entry, `catalog entry for ${code}`).toBeDefined();
  return entry;
}

function ownerAt(rule: CatalogEntry["owner"], ctx: OutcomeContext): Owner {
  return typeof rule === "string" ? rule : rule[ctx];
}

function ownerIn(entry: CatalogEntry, ctx: OutcomeContext): Owner {
  return ownerAt(entry.owner, ctx);
}

const OWNER_WORD: Record<Owner, string> = {
  config: "your configuration",
  provider: "provider",
  "pr-hero": "pr-hero",
  unclassified: "unclassified",
};

function ownerDocLine(entry: CatalogEntry): string {
  if (typeof entry.owner === "string") return OWNER_WORD[entry.owner];
  return `${OWNER_WORD[entry.owner.action]} in the action, ${OWNER_WORD[entry.owner.local]} locally`;
}

function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}

function contentLine(summary: string[]): string {
  const line = summary.find(
    (entry) => entry.trim() !== "" && !entry.startsWith("#"),
  );
  return line ?? "";
}

// The builtins-only guard. Comments are stripped first so prose in a header
// cannot trip it; a statement is allowed only when it is type-only or names a
// node:/bun builtin.
function isBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier === "bun" ||
    specifier.startsWith("bun:")
  );
}

function runtimeImportViolations(
  source: string,
  allowed: readonly string[] = [],
): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const violations: string[] = [];
  for (const match of code.matchAll(
    /\b(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g,
  )) {
    const clause = match[2] ?? "";
    const specifier = match[3] ?? "";
    if (/^\s*type\b/.test(clause)) continue;
    if (!isBuiltin(specifier) && !allowed.includes(specifier))
      violations.push(`${match[1]} from "${specifier}"`);
  }
  for (const match of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    const specifier = match[1] ?? "";
    if (!isBuiltin(specifier)) violations.push(`import "${specifier}"`);
  }
  for (const match of code.matchAll(
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    const specifier = match[1] ?? "";
    if (!isBuiltin(specifier)) violations.push(`dynamic "${specifier}"`);
  }
  return violations;
}

// Extracts the replaceAll pairs of escapeCommandData, in order.
function escapeRules(source: string): string[] {
  const fn = source.match(
    /function escapeCommandData\(text: string\): string \{([\s\S]*?)\n\}/,
  );
  if (fn === null) return [];
  const body = fn[1] ?? "";
  return [
    ...body.matchAll(
      /\.replaceAll\(("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*")\)/g,
    ),
  ].map((match) => `${match[1] ?? ""} -> ${match[2] ?? ""}`);
}

// The regex literal a module declares for a constant, as written. Both copies of the
// login pattern are compared as text: neither module may import the other at runtime.
function loginPatternLiteral(source: string, name: string): string | undefined {
  return source.match(new RegExp(`^const ${name} = (\\/.+\\/);$`, "m"))?.[1];
}

describe("codeOf and ownerOf: every class variant", () => {
  test("every sample maps to its expected code", () => {
    for (const sample of SAMPLES) {
      expect(codeOf(sample.cls), sample.name).toBe(sample.code);
    }
  });

  test("every sample maps to its expected owner in both contexts", () => {
    for (const sample of SAMPLES) {
      for (const ctx of CONTEXTS) {
        expect(ownerOf(sample.cls, ctx), `${sample.name} (${ctx})`).toBe(
          sample.owner,
        );
      }
    }
  });

  test("capability is the only class whose owner depends on the context", () => {
    for (const issue of CAPABILITY_ISSUES) {
      const cls: ErrorClass = { kind: "capability", issue };
      expect(codeOf(cls), issue).toBe("PRH-RUNTIME-UNAVAILABLE");
      expect(ownerOf(cls, "action"), `${issue} action`).toBe("pr-hero");
      expect(ownerOf(cls, "local"), `${issue} local`).toBe("config");
    }
  });

  test("only legacy_terminal and runtime_unavailable name PRH-UNCLASSIFIED among the transport causes", () => {
    const unclassified = (
      Object.keys(TRANSPORT_EXPECTED) as Array<keyof typeof TRANSPORT_EXPECTED>
    ).filter(
      (cause) => codeOf({ kind: "transport", cause }) === "PRH-UNCLASSIFIED",
    );
    expect([...unclassified].sort()).toEqual([
      "legacy_terminal",
      "runtime_unavailable",
    ]);
  });

  test("a value outside the union at runtime reports PRH-UNCLASSIFIED, never a guessed owner", () => {
    const unknownCause: ErrorClass = {
      kind: "transport",
      cause: "a_future_cause" as unknown as TransportFailureCause,
    };
    expect(codeOf(unknownCause)).toBe("PRH-UNCLASSIFIED");
    expect(ownerOf(unknownCause, "action")).toBe("unclassified");

    const unknownFailureClass: ErrorClass = {
      kind: "credential",
      failureClass:
        "a_future_class" as unknown as CredentialProjectionFailureClass,
    };
    expect(codeOf(unknownFailureClass)).toBe("PRH-UNCLASSIFIED");
    expect(ownerOf(unknownFailureClass, "local")).toBe("unclassified");

    const unknownKind = { kind: "novel" } as unknown as ErrorClass;
    expect(codeOf(unknownKind)).toBe("PRH-UNCLASSIFIED");
    expect(ownerOf(unknownKind, "action")).toBe("unclassified");
  });

  test("the catalog owner agrees with ownerOf for every class", () => {
    const classes: ErrorClass[] = [
      ...SAMPLES.map((sample) => sample.cls),
      ...CAPABILITY_ISSUES.map(
        (issue): ErrorClass => ({ kind: "capability", issue }),
      ),
    ];
    for (const cls of classes) {
      const entry = entryOf(codeOf(cls));
      for (const ctx of CONTEXTS) {
        // WHY an explicit exception: provider_configuration_invalid shares
        // PRH-MODEL-UNAVAILABLE with model_unavailable, whose owner is provider.
        // The shared code's catalog owner is the provider's; the cause keeps
        // config through the code's variant (see ERROR_CATALOG).
        const expected =
          cls.kind === "transport" &&
          cls.cause === "provider_configuration_invalid"
            ? "config"
            : ownerIn(entry, ctx);
        expect(ownerOf(cls, ctx), `${JSON.stringify(cls)} ${ctx}`).toBe(
          expected,
        );
      }
    }
  });

  test("the codes no class produces are exactly the explicit-only ones", () => {
    const produced = new Set(SAMPLES.map((sample) => codeOf(sample.cls)));
    for (const issue of CAPABILITY_ISSUES) {
      produced.add(codeOf({ kind: "capability", issue }));
    }
    expect(ERROR_CODES.filter((code) => !produced.has(code))).toEqual(
      ERROR_CODES.filter((code) => EXPLICIT_ONLY_CODES.includes(code)),
    );
  });
});

describe("the code list and its catalog", () => {
  test("ERROR_CODES holds the 24 distinct codes", () => {
    expect(ERROR_CODES).toHaveLength(24);
    expect(new Set(ERROR_CODES).size).toBe(24);
    for (const code of ERROR_CODES) expect(code.startsWith("PRH-")).toBe(true);
  });

  test("every code has a catalog entry with a default variant and clean text", () => {
    for (const code of ERROR_CODES) {
      const entry = entryOf(code);
      expect(entry.variants.default, `${code} default variant`).toBeDefined();
      expect(entry.what.length, `${code} what`).toBeGreaterThan(0);
      expect(
        entry.what.endsWith("."),
        `${code} what has no trailing period`,
      ).toBe(false);
      for (const [key, variant] of Object.entries(entry.variants)) {
        expect(variant.why.length, `${code} ${key} why`).toBeGreaterThan(0);
        expect(
          variant.why.endsWith("."),
          `${code} ${key} why has no trailing period`,
        ).toBe(false);
        for (const fixes of fixListsOf(variant.fixes)) {
          expect(fixes.length, `${code} ${key} fixes`).toBeGreaterThan(0);
        }
      }
    }
  });

  test("the cancelled code is a notice under the Not reviewed lead, not an error", () => {
    const entry = entryOf("PRH-CANCELLED");
    expect(entry.level).toBe("notice");
    expect(entry.lead).toBe("Not reviewed:");
    expect(entry.owner).toBe("unclassified");
    expect(entryOf("PRH-HUNTERS-FAILED").level).toBe("error");
  });
});

describe("wording: no invented scope, and the credential text names the route the run uses", () => {
  test("no rendered annotation or summary carries a <scope> placeholder, for any code, variant or context", () => {
    for (const code of ERROR_CODES) {
      const entry = entryOf(code);
      for (const variant of [undefined, ...Object.keys(entry.variants)]) {
        for (const ctx of CONTEXTS) {
          const rendered = renderCode(code, {}, ctx, variant);
          const label = `${code} ${ctx} ${variant ?? "default"}`;
          expect(rendered.annotation, label).not.toContain("<scope>");
          expect(rendered.summary.join("\n"), label).not.toContain("<scope>");
        }
      }
    }
  });

  test("the opencode route's fix leads with the OpenCode secret, and no Claude secret command is offered as its fix", () => {
    const rendered = renderCode(
      "PRH-CRED-MISSING",
      { ...FULL, backend: "opencode" },
      "action",
    );
    const commands: string[] = [];
    let inFence = false;
    for (const line of rendered.summary) {
      if (line === "```bash") {
        inFence = true;
        continue;
      }
      if (line === "```") {
        inFence = false;
        continue;
      }
      if (inFence) commands.push(line);
    }
    expect(commands[0]).toContain("OPENCODE_AUTH_JSON");
    for (const command of commands) {
      expect(command, command).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    }
  });

  test("the claude route's with: example names the API key as the alternative to the OAuth token", () => {
    const rendered = renderCode(
      "PRH-CRED-MISSING",
      { ...FULL, backend: "claude-code" },
      "action",
    );
    // The Actions expression is spliced, as in src/ci/outcome.ts, so the source
    // never holds a `${` pair that reads as a template placeholder.
    expect(rendered.summary.join("\n")).toContain(
      "anthropic-api-key: $" + "{{ secrets.ANTHROPIC_API_KEY }}",
    );
  });
});

describe("docs parity: ## Error codes in docs/github-actions.md", () => {
  const docs = readFileSync(DOCS, "utf8");
  const sectionStart = docs.indexOf("\n## Error codes\n");
  const sectionEnd = docs.indexOf("\n## Troubleshooting\n");
  const section =
    sectionStart === -1 ? "" : docs.slice(sectionStart, sectionEnd);

  function bodyOf(code: ErrorCode): string {
    const heading = `### ${code}\n`;
    const start = section.indexOf(heading);
    if (start === -1) return "";
    const rest = section.slice(start + heading.length);
    const next = rest.search(/\n### /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  // The text under one "#### `key`" sub-heading of a code's body.
  function variantBodyOf(body: string, key: string): string {
    const heading = `#### \`${key}\`\n`;
    const start = body.indexOf(heading);
    if (start === -1) return "";
    const rest = body.slice(start + heading.length);
    const next = rest.search(/\n#### /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  test("the section sits right before Troubleshooting, after Optional inputs", () => {
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    expect(docs.indexOf("\n## Optional inputs\n")).toBeLessThan(sectionStart);
    expect([...section.matchAll(/^## /gm)]).toHaveLength(1);
  });

  test("every PRH heading in the docs is one of the codes, in the section, once each", () => {
    const headings = [...docs.matchAll(/^### (PRH-[A-Z-]+)$/gm)];
    const names = headings.map((match) => match[1] ?? "");
    expect(names.sort()).toEqual([...ERROR_CODES].sort());
    for (const match of headings) {
      const at = match.index ?? -1;
      expect(at, `${match[1]} sits inside the section`).toBeGreaterThan(
        sectionStart,
      );
      expect(at, `${match[1]} sits inside the section`).toBeLessThan(
        sectionEnd,
      );
    }
  });

  test("every code's section states owner, what, why, variants and every fix line", () => {
    for (const code of ERROR_CODES) {
      const entry = entryOf(code);
      const body = bodyOf(code);
      expect(body, `${code} has a section`).not.toBe("");
      const ownerLine = body.match(/\*\*Owner:\*\* (.+)/)?.[1] ?? "";
      expect(ownerLine, `${code} owner line`).toBe(ownerDocLine(entry));
      expect(body.includes(entry.what), `${code} what`).toBe(true);
      for (const [key, variant] of Object.entries(entry.variants)) {
        expect(body.includes(variant.why), `${code} ${key} why`).toBe(true);
        for (const fixes of fixListsOf(variant.fixes)) {
          for (const fix of fixes) {
            const text = fix.startsWith("$ ") ? fix.slice(2) : fix;
            expect(body.includes(text), `${code} ${key} fix: ${text}`).toBe(
              true,
            );
          }
        }
        if (key !== "default") {
          expect(
            body.includes(`\`${key}\``),
            `${code} names variant ${key}`,
          ).toBe(true);
        }
        if (variant.what !== undefined) {
          expect(
            variantBodyOf(body, key).includes(variant.what),
            `${code} ${key} what`,
          ).toBe(true);
        }
        // A variant that changes the owner states its own owner under its heading.
        const base = entry.variants.default?.owner ?? entry.owner;
        const own = variant.owner ?? entry.owner;
        if (
          key !== "default" &&
          CONTEXTS.some((ctx) => ownerAt(own, ctx) !== ownerAt(base, ctx))
        ) {
          expect(
            variantBodyOf(body, key).includes(
              `**Owner:** ${OWNER_WORD[ownerAt(own, "local")]}`,
            ),
            `${code} ${key} owner`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("renderCode and renderError: the annotation", () => {
  test("every code renders one line under its level, with its owner lead first", () => {
    for (const code of ERROR_CODES) {
      const entry = entryOf(code);
      for (const ctx of CONTEXTS) {
        const owner = ownerIn(entry, ctx);
        const rendered = renderCode(code, FULL, ctx);
        expect(
          rendered.annotation.includes("\n"),
          `${code} ${ctx} one line`,
        ).toBe(false);
        expect(rendered.annotation.includes("\r"), `${code} ${ctx} no CR`).toBe(
          false,
        );
        const level = entry.level;
        const lead =
          entry.lead ?? ownerLead(owner, entry.providerName ?? FULL.provider);
        expect(
          rendered.annotation.startsWith(
            `::${level} title=pr-hero ${code}::${lead} `,
          ),
          `${code} ${ctx}: ${rendered.annotation}`,
        ).toBe(true);
        expect(rendered.annotation.includes(`Why: `), `${code} why`).toBe(true);
        expect(rendered.annotation.includes(`Fix: `), `${code} fix`).toBe(true);
        expect(
          rendered.annotation.endsWith(`#${githubSlug(code)}`),
          `${code} docs anchor`,
        ).toBe(true);
      }
    }
  });

  test("the annotation follows the contract format exactly for the default Claude code", () => {
    const rendered = renderError(
      { kind: "trigger", check: "no-credential" },
      { runId: "123", pr: 9 },
      "action",
    );
    expect(rendered.annotation).toBe(
      "::error title=pr-hero PRH-CRED-MISSING::Your configuration: No credential for the <backend> route reached the action. Why: pr-hero cannot authenticate, so it cannot review this PR. Fix: set a Claude credential: `claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN`. Docs: " +
        `${DOCS_URL_PREFIX}prh-cred-missing`,
    );
  });

  test("the owner lead is the first words of the annotation and of the first summary content line", () => {
    for (const sample of SAMPLES) {
      const entry = entryOf(sample.code);
      const lead =
        entry.lead ??
        ownerLead(sample.owner, entry.providerName ?? FULL.provider);
      const rendered = renderError(sample.cls, FULL, "action");
      const afterTitle = rendered.annotation.slice(
        rendered.annotation.indexOf("::", 2) + 2,
      );
      expect(afterTitle.startsWith(lead), sample.name).toBe(true);
      expect(contentLine(rendered.summary).startsWith(lead), sample.name).toBe(
        true,
      );
    }
  });

  test("the first character of the what after the owner lead is capitalized, for every code, variant and context", () => {
    for (const code of ERROR_CODES) {
      const entry = entryOf(code);
      for (const variant of [undefined, ...Object.keys(entry.variants)]) {
        for (const ctx of CONTEXTS) {
          const rendered = renderCode(code, REALISTIC, ctx, variant);
          const label = `${code} ${ctx} ${variant ?? "default"}`;
          // "Already in upper-case form" holds for a capital letter and for a
          // caseless character: a backtick, or the dot of a path such as
          // .prhero/gotchas.md. A lowercase letter fails it.
          const capitalized = (char: string | undefined): boolean =>
            char !== undefined &&
            char.length === 1 &&
            char === char.toUpperCase();
          const message = rendered.annotation.slice(
            rendered.annotation.indexOf("::", 2) + 2,
          );
          // The product name is always lowercase `pr-hero`, so a what that starts
          // with it is the one exception to the rule.
          const startsWithProductName = (text: string): boolean =>
            /^[^:]+: pr-hero/.test(text);
          const first = message.match(/^[^:]+: (.)/)?.[1];
          expect(
            startsWithProductName(message) || capitalized(first),
            `${label}: ${message}`,
          ).toBe(true);
          const line = contentLine(rendered.summary);
          const summaryFirst = line.match(/^[^:]+: (.)/)?.[1];
          expect(
            startsWithProductName(line) || capitalized(summaryFirst),
            `${label}: ${line}`,
          ).toBe(true);
        }
      }
    }
  });

  test("a what that starts with the product name keeps the lowercase pr-hero, never Pr-hero", () => {
    const codes: ErrorCode[] = [
      "PRH-PR-UNRESOLVED",
      "PRH-STATUS-WRITE-FAILED",
      "PRH-ENGINE-DEFECT",
      "PRH-UNCLASSIFIED",
    ];
    for (const code of codes) {
      for (const ctx of CONTEXTS) {
        const rendered = renderCode(code, REALISTIC, ctx);
        const label = `${code} ${ctx}`;
        const message = rendered.annotation.slice(
          rendered.annotation.indexOf("::", 2) + 2,
        );
        const line = contentLine(rendered.summary);
        for (const text of [message, line]) {
          const sentence = text.slice(text.indexOf(": ") + 2);
          expect(sentence.startsWith("pr-hero"), `${label}: ${text}`).toBe(
            true,
          );
          expect(text, `${label}: ${text}`).not.toContain("Pr-hero");
        }
      }
    }
  });

  test("percent, CR and LF in detail are escaped so the annotation stays one line", () => {
    const rendered = renderCode(
      "PRH-ENGINE-DEFECT",
      { detail: "50%\r\nsecond line", step: "review" },
      "action",
    );
    expect(rendered.annotation).toContain("50%25");
    expect(rendered.annotation).toContain("%0D%0Asecond line");
    expect(rendered.annotation.includes("\r")).toBe(false);
    expect(rendered.annotation.includes("\n")).toBe(false);
  });

  test("the escape rule is the one src/ci/trigger.ts uses (drift guard on source text)", () => {
    const ours = escapeRules(readFileSync(OUTCOME_SRC, "utf8"));
    const theirs = escapeRules(readFileSync(TRIGGER_SRC, "utf8"));
    expect(theirs).toHaveLength(3);
    expect(ours).toEqual(theirs);
  });

  test("the override login pattern is the one src/ci/trigger.ts uses (drift guard on source text)", () => {
    const ours = loginPatternLiteral(
      readFileSync(OUTCOME_SRC, "utf8"),
      "LOGIN_PATTERN",
    );
    const theirs = loginPatternLiteral(
      readFileSync(TRIGGER_SRC, "utf8"),
      "GITHUB_LOGIN",
    );
    expect(theirs, "trigger.ts declares GITHUB_LOGIN").toBeDefined();
    expect(ours, "outcome.ts declares LOGIN_PATTERN").toBeDefined();
    expect(ours).toBe(theirs);
    expect(ours).toContain("{0,90}");
  });

  test("the cancelled code renders as a notice under the Not reviewed lead, and its summary says so", () => {
    const rendered = renderCode("PRH-CANCELLED", { pr: 7 }, "action");
    expect(
      rendered.annotation.startsWith(
        "::notice title=pr-hero PRH-CANCELLED::Not reviewed: The review was cancelled or superseded by a newer push.",
      ),
      rendered.annotation,
    ).toBe(true);
    expect(rendered.summary[0]?.toLowerCase()).toContain("not reviewed");
    expect(rendered.summary.join("\n")).toContain(
      'gh pr comment 7 --body "/crysk review"',
    );
  });

  test("explicitly requested codes take the owner the caller passes", () => {
    const hunters = renderCode(
      "PRH-HUNTERS-FAILED",
      { detail: "dedupe: pr-hero" },
      "action",
    );
    // The owner (the caller's unclassified) is unchanged; only the lead names the condition.
    expect(hunters.owner).toBe("unclassified");
    expect(
      hunters.annotation.startsWith(
        "::error title=pr-hero PRH-HUNTERS-FAILED::Not reviewed: ",
      ),
    ).toBe(true);
  });

  test("PRH-STATUS-WRITE-FAILED takes its owner and fix from the variant", () => {
    const permission = renderCode(
      "PRH-STATUS-WRITE-FAILED",
      { detail: "403" },
      "action",
      "permission",
    );
    expect(permission.owner).toBe("config");
    expect(
      permission.annotation.startsWith(
        "::error title=pr-hero PRH-STATUS-WRITE-FAILED::Your configuration: ",
      ),
    ).toBe(true);
    expect(permission.annotation).toContain(
      "Fix: add `statuses: write` under the job's `permissions:` in the workflow. Docs: ",
    );
    const server = renderCode(
      "PRH-STATUS-WRITE-FAILED",
      { detail: "502" },
      "action",
      "server",
    );
    expect(server.owner).toBe("provider");
    expect(
      server.annotation.startsWith(
        "::error title=pr-hero PRH-STATUS-WRITE-FAILED::Provider GitHub: ",
      ),
    ).toBe(true);
  });

  test("renderError resolves each class to its code, and its owner from the catalog, in both contexts", () => {
    for (const sample of SAMPLES) {
      for (const ctx of CONTEXTS) {
        const rendered = renderError(sample.cls, FULL, ctx);
        expect(rendered.code, `${sample.name} ${ctx} code`).toBe(sample.code);
        expect(rendered.owner, `${sample.name} ${ctx} owner`).toBe(
          ownerOf(sample.cls, ctx),
        );
      }
    }
  });

  test("the GitHub code reads Provider GitHub without a provider param, for the server families", () => {
    for (const status of [500, 502]) {
      const rendered = renderError(
        { kind: "github", status },
        { runId: "77" },
        "action",
      );
      expect(
        rendered.annotation.startsWith(
          `::error title=pr-hero PRH-GITHUB-UNAVAILABLE::Provider GitHub: The GitHub API failed (HTTP ${status}). Why: the failure happened on GitHub's side, and a retry may succeed. Fix: re-run the workflow once GitHub is serving requests again. Docs: `,
        ),
        rendered.annotation,
      ).toBe(true);
    }
  });

  test("a GitHub failure names only the cause that applies, and an unmapped status is unclassified", () => {
    const rate = renderError(
      { kind: "github", status: 429 },
      { runId: "77" },
      "action",
    ).annotation;
    expect(rate).toContain("The GitHub API rate limit was reached");
    expect(rate).not.toContain("outage");
    const server = renderError(
      { kind: "github", status: 503 },
      { runId: "77" },
      "action",
    ).annotation;
    expect(server).toContain("The GitHub API failed (HTTP 503)");
    expect(server).not.toContain("rate limit");
    const notFound = renderError(
      { kind: "github", status: 404 },
      {},
      "action",
    ).annotation;
    expect(
      notFound.startsWith(
        "::error title=pr-hero PRH-UNCLASSIFIED::Unclassified: GitHub returned 404 at this step, and pr-hero cannot tell whose fix it is. Why: ",
      ),
      notFound,
    ).toBe(true);
    expect(notFound).not.toContain("outage");
  });

  test("a rejected credential is the user's to fix: owner config, and the what names the provider and secret", () => {
    const rendered = renderError(
      { kind: "transport", cause: "auth_invalid" },
      { provider: "openai", secret: "SECRET_NAME" },
      "action",
    );
    expect(
      rendered.annotation.startsWith(
        "::error title=pr-hero PRH-CRED-REJECTED::Your configuration: Provider openai rejected the credential in SECRET_NAME. Why: it is expired, revoked, or a short-lived /login session token. Fix: ",
      ),
      rendered.annotation,
    ).toBe(true);
  });

  test("provider leads use the provider name when given and fall back to Provider:", () => {
    expect(
      renderCode("PRH-PROVIDER-LIMITED", { provider: "openai" }, "action")
        .annotation,
    ).toContain(
      "::error title=pr-hero PRH-PROVIDER-LIMITED::Provider openai: ",
    );
    expect(
      renderCode("PRH-PROVIDER-LIMITED", {}, "action").annotation,
    ).toContain("::error title=pr-hero PRH-PROVIDER-LIMITED::Provider: ");
  });

  test("a provider-owned code names the provider once: the lead carries it, the what does not repeat it", () => {
    const codes = [
      "PRH-PROVIDER-LIMITED",
      "PRH-PROVIDER-UNAVAILABLE",
      "PRH-PROVIDER-REFUSED",
    ] as const;
    for (const code of codes) {
      const { annotation } = renderCode(code, { provider: "openai" }, "action");
      expect(annotation.split("openai").length - 1, code).toBe(1);
    }
  });

  test("runtime unavailable follows the context: owner, why and fix", () => {
    const issue = { kind: "capability", issue: "sdk_unavailable" } as const;
    const action = renderError(issue, { detail: "the OpenCode SDK" }, "action");
    expect(
      action.annotation.startsWith(
        "::error title=pr-hero PRH-RUNTIME-UNAVAILABLE::pr-hero defect: ",
      ),
    ).toBe(true);
    expect(action.annotation).toContain(
      "the action installs this runtime itself",
    );
    expect(action.summary.join("\n")).toContain(
      'gh issue create -R juanmaagd/pr-hero --title "PRH-RUNTIME-UNAVAILABLE" --body "<run-url>"',
    );
    const local = renderError(issue, { detail: "the OpenCode SDK" }, "local");
    expect(
      local.annotation.startsWith(
        "::error title=pr-hero PRH-RUNTIME-UNAVAILABLE::Your configuration: ",
      ),
    ).toBe(true);
    expect(local.summary.join("\n")).toContain("pr-hero upgrade --reconcile");
  });

  test("a credential failure class picks its own fix", () => {
    const missingProvider = renderError(
      { kind: "credential", failureClass: "missing_provider_record" },
      { provider: "deepseek", secret: "OPENCODE_AUTH_JSON" },
      "action",
    );
    expect(missingProvider.summary.join("\n")).toContain("opencode auth login");
    const malformed = renderError(
      { kind: "credential", failureClass: "malformed_payload" },
      {},
      "action",
    );
    expect(malformed.summary.join("\n")).toContain("jq -e 'type==\"object\"'");
    const readFailed = renderError(
      { kind: "credential", failureClass: "source_read_failed" },
      { secret: "CLAUDE_CODE_OAUTH_TOKEN" },
      "action",
    );
    expect(readFailed.summary.join("\n")).toContain(
      "gh secret set CLAUDE_CODE_OAUTH_TOKEN",
    );
  });

  test("the missing-credential summary names the with: input for every route, and CRYSK_ROUTING for OpenCode only", () => {
    const claude = renderError(
      { kind: "trigger", check: "no-credential" },
      { backend: "claude-code", runId: "123" },
      "action",
    );
    const opencode = renderError(
      { kind: "trigger", check: "no-credential" },
      { backend: "opencode", runId: "123" },
      "action",
    );
    expect(claude.summary.join("\n")).toContain("with:");
    expect(opencode.summary.join("\n")).toContain("with:");
    expect(claude.summary.join("\n")).not.toContain("CRYSK_ROUTING");
    expect(opencode.summary.join("\n")).toContain("CRYSK_ROUTING");
  });

  test("the missing-credential with: example follows the backend: opencode-auth on OpenCode, claude-token otherwise", () => {
    const claude = renderError(
      { kind: "trigger", check: "no-credential" },
      { backend: "claude-code", runId: "123" },
      "action",
    );
    const opencode = renderError(
      { kind: "trigger", check: "no-credential" },
      { backend: "opencode", runId: "123" },
      "action",
    );
    const missing = renderError(
      { kind: "trigger", check: "no-credential" },
      { runId: "123" },
      "action",
    );
    expect(opencode.summary.join("\n")).toContain("opencode-auth:");
    expect(opencode.summary.join("\n")).not.toContain("claude-token:");
    expect(claude.summary.join("\n")).toContain("claude-token:");
    expect(claude.summary.join("\n")).not.toContain("opencode-auth:");
    expect(missing.summary.join("\n")).toContain("claude-token:");
    expect(missing.summary.join("\n")).not.toContain("opencode-auth:");
  });

  test("a missing subscription record names the login its backend uses", () => {
    const claude = renderError(
      { kind: "credential", failureClass: "missing_subscription_record" },
      { backend: "claude-code", secret: "CLAUDE_CODE_OAUTH_TOKEN" },
      "action",
    );
    expect(claude.annotation).toContain("claude setup-token");
    expect(claude.annotation).not.toContain("ChatGPT");
    expect(claude.summary.join("\n")).toContain(
      "claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN",
    );
    expect(claude.summary.join("\n")).not.toContain("ChatGPT");

    const openai = renderError(
      { kind: "credential", failureClass: "missing_subscription_record" },
      { backend: "opencode", provider: "openai", secret: "OPENCODE_AUTH_JSON" },
      "action",
    );
    expect(openai.annotation).toContain("ChatGPT");
    expect(openai.annotation).toContain("opencode auth login");
    expect(openai.summary.join("\n")).toContain("ChatGPT");
    expect(openai.summary.join("\n")).toContain("opencode auth login");
  });

  test("a route reason picks its own fix", () => {
    const ambiguous = renderError(
      { kind: "route", reason: "ambiguous" },
      { step: "hunter" },
      "action",
    );
    expect(ambiguous.summary.join("\n")).toContain("duplicate mapping");
    const multiple = renderError(
      { kind: "route", reason: "multiple-opencode-providers" },
      {},
      "action",
    );
    expect(multiple.summary.join("\n")).toContain("one OpenCode provider");
  });

  test("the annotation Fix is the real fixing step, not the first command, for every code and variant", () => {
    const fixOf = (annotation: string): string => {
      const start = annotation.indexOf("Fix: ");
      const end = annotation.indexOf(". Docs: ");
      return start === -1 || end === -1
        ? ""
        : annotation.slice(start + "Fix: ".length, end);
    };
    for (const code of ERROR_CODES) {
      const entry = entryOf(code);
      for (const ctx of CONTEXTS) {
        for (const key of Object.keys(entry.variants)) {
          const variant = key === "action" || key === "local" ? undefined : key;
          const rendered = renderCode(code, FULL, ctx, variant);
          expect(fixOf(rendered.annotation), `${code} ${ctx} ${key}`).not.toBe(
            "",
          );
        }
      }
    }
    const expected: Array<[string, string]> = [
      [
        renderCode("PRH-PROVIDER-LIMITED", FULL, "action").annotation,
        "wait for the limit to reset or raise the quota, then comment /crysk review on the PR",
      ],
      [
        renderCode("PRH-TOKEN-PERMISSION", FULL, "action").annotation,
        "add `SCOPE: write` under the job's `permissions:` in the workflow",
      ],
      [
        renderCode("PRH-CONFIG-INVALID", FULL, "action").annotation,
        "fix `.prhero/config.json` (DETAIL), then check it with `pr-hero review --pr 42 --dry-run`",
      ],
      [
        renderCode("PRH-PROMPTSET-INVALID", FULL, "action").annotation,
        "fix the agent file or `agents_dir` (DETAIL), then check it with `pr-hero review --pr 42 --dry-run`",
      ],
      [
        renderCode(
          "PRH-CRED-MISSING",
          { ...FULL, backend: "opencode" },
          "action",
        ).annotation,
        "set the OPENCODE_AUTH_JSON secret: `gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json`",
      ],
      [
        renderCode("PRH-CRED-MISSING", FULL, "action").annotation,
        "set a Claude credential: `claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN`",
      ],
    ];
    for (const [annotation, fix] of expected) {
      expect(fixOf(annotation)).toBe(fix);
    }
    const scopeless = renderCode(
      "PRH-TOKEN-PERMISSION",
      { detail: "x" },
      "action",
    ).annotation;
    expect(fixOf(scopeless)).toBe(
      "check that the workflow passes `github-token: $" +
        "{{ secrets.GITHUB_TOKEN }}` and keeps the `permissions:` block that `pr-hero ci init` scaffolds",
    );
  });

  test("no rendered annotation or summary carries a raw credential, capability, route or transport token", () => {
    const routeReasons = [
      "unmapped",
      "ambiguous",
      "spend-disabled",
      "multiple-opencode-providers",
    ] as const;
    const credentialClasses = Object.keys(CREDENTIAL_EXPECTED) as Array<
      keyof typeof CREDENTIAL_EXPECTED
    >;
    const transportCauses = Object.keys(TRANSPORT_EXPECTED) as Array<
      keyof typeof TRANSPORT_EXPECTED
    >;
    const classes: ErrorClass[] = [
      ...credentialClasses.map(
        (failureClass): ErrorClass => ({ kind: "credential", failureClass }),
      ),
      ...CAPABILITY_ISSUES.map(
        (issue): ErrorClass => ({ kind: "capability", issue }),
      ),
      ...routeReasons.map((reason): ErrorClass => ({ kind: "route", reason })),
      ...transportCauses.map(
        (cause): ErrorClass => ({ kind: "transport", cause }),
      ),
    ];
    const tokens: string[] = [
      ...credentialClasses,
      ...CAPABILITY_ISSUES,
      ...routeReasons,
      ...transportCauses,
    ];
    for (const cls of classes) {
      for (const ctx of CONTEXTS) {
        const rendered = renderError(cls, {}, ctx);
        const text = [rendered.annotation, ...rendered.summary].join("\n");
        for (const token of tokens) {
          expect(
            new RegExp(`\\b${token}\\b`).test(text),
            `${JSON.stringify(cls)} ${ctx} leaks ${token}`,
          ).toBe(false);
        }
      }
    }
  });

  test("a detail written into a command keeps only shell-safe characters", () => {
    const rendered = renderCode(
      "PRH-ENGINE-DEFECT",
      { detail: 'x"; $(rm -rf ~) `id`;y', step: "review" },
      "action",
    );
    const command =
      rendered.summary.find((line) => line.startsWith("gh issue create")) ?? "";
    expect(command).toBe(
      'gh issue create -R juanmaagd/pr-hero --title "PRH-ENGINE-DEFECT x rm -rf  idy" --body "<run-url>"',
    );
  });

  test("an install failure says pr-hero cannot tell which external cause it was", () => {
    const rendered = renderError(
      { kind: "install", step: "install bun" },
      {},
      "action",
    );
    expect(rendered.summary.join("\n")).toContain(
      "Why: a download or install step failed, and pr-hero cannot tell which external cause it was",
    );
  });

  test("an install failure names the step its class carries, and an explicit step wins", () => {
    const named = renderError(
      { kind: "install", step: "Install OpenCode CLI" },
      {},
      "action",
    );
    expect(named.annotation).toContain("The Install OpenCode CLI step failed");
    expect(named.summary.join("\n")).toContain(
      "The Install OpenCode CLI step failed",
    );
    const explicit = renderError(
      { kind: "install", step: "Install OpenCode CLI" },
      { step: "install node" },
      "action",
    );
    expect(explicit.annotation).toContain("The install node step failed");
    for (const step of ["", "   "]) {
      const blank = renderError({ kind: "install", step }, {}, "action");
      expect(blank.annotation, JSON.stringify(step)).toContain(
        "An install step failed",
      );
      expect(blank.annotation, JSON.stringify(step)).not.toContain(
        "this step step",
      );
    }
  });

  test("an install failure with no step says an install step failed, never the placeholder", () => {
    for (const params of [{}, { step: "" }, { step: "   " }] as const) {
      const { annotation, summary } = renderCode(
        "PRH-INSTALL-FAILED",
        params,
        "action",
      );
      expect(annotation, JSON.stringify(params)).not.toContain(
        "this step step",
      );
      expect(annotation, JSON.stringify(params)).toContain(
        "An install step failed",
      );
      expect(summary.join("\n")).toContain("An install step failed");
    }
    const named = renderCode(
      "PRH-INSTALL-FAILED",
      { step: "install bun" },
      "action",
    );
    expect(named.annotation).toContain("The install bun step failed");
  });

  test("the summary carries every fix command and every fix line, with sentinel params", () => {
    for (const code of ERROR_CODES) {
      const entry = entryOf(code);
      for (const key of Object.keys(entry.variants)) {
        const ctx: OutcomeContext =
          key === "action" || key === "local" ? key : "local";
        const variant = key === "action" || key === "local" ? undefined : key;
        const rendered = renderCode(code, FULL, ctx, variant);
        const summary = rendered.summary.join("\n");
        const selected =
          entry.variants[ctx] ?? entry.variants[key] ?? entry.variants.default;
        expect(summary, `${code} ${key} why`).toContain(
          `Why: ${sentinelFill(selected.why)}`,
        );
        const fixes =
          typeof selected.fixes === "function"
            ? selected.fixes(FULL)
            : selected.fixes;
        for (const fix of fixes) {
          const text = fix.startsWith("$ ") ? fix.slice(2) : fix;
          expect(summary, `${code} ${key}: ${text}`).toContain(
            sentinelFill(text),
          );
        }
      }
    }
  });

  test("a missing param renders a neutral word, never undefined", () => {
    for (const code of ERROR_CODES) {
      const entry = entryOf(code);
      for (const ctx of CONTEXTS) {
        for (const key of Object.keys(entry.variants)) {
          const variant = key === "action" || key === "local" ? undefined : key;
          const rendered = renderCode(code, {}, ctx, variant);
          const text = [rendered.annotation, ...rendered.summary].join("\n");
          expect(text.includes("undefined"), `${code} ${ctx} ${key}`).toBe(
            false,
          );
          expect(text.includes("null"), `${code} ${ctx} ${key}`).toBe(false);
        }
      }
    }
    const providerLimited = renderCode("PRH-PROVIDER-LIMITED", {}, "action");
    expect(providerLimited.summary.join("\n")).toContain(
      'gh pr comment <pr> --body "/crysk review"',
    );
  });

  test("the renderer reads only the documented params, never an undocumented value", () => {
    const leaky = {
      secret: "CLAUDE_CODE_OAUTH_TOKEN",
      token: "sk-SUPER-SECRET-VALUE",
    } as unknown as ErrorParams;
    const rendered = renderError(
      { kind: "credential", failureClass: "source_read_failed" },
      leaky,
      "action",
    );
    const text = [rendered.annotation, ...rendered.summary].join("\n");
    expect(text.includes("sk-SUPER-SECRET-VALUE")).toBe(false);
    expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("every rendered docs link points at a heading the docs define", () => {
    const docs = readFileSync(DOCS, "utf8");
    const slugs = new Set(
      [...docs.matchAll(/^### (PRH-[A-Z-]+)$/gm)].map((match) =>
        githubSlug(match[1] ?? ""),
      ),
    );
    for (const code of ERROR_CODES) {
      const rendered = renderCode(code, {}, "action");
      const anchor = rendered.annotation.slice(
        rendered.annotation.lastIndexOf("#") + 1,
      );
      expect(anchor.length, `${code} anchor`).toBeGreaterThan(0);
      expect(slugs.has(anchor), `${code} anchor ${anchor} resolves`).toBe(true);
      expect(rendered.annotation).toContain(DOCS_URL_PREFIX);
    }
  });
});

describe("PRH-PR-UNRESOLVED: the malformed pr-number variant", () => {
  const DETAIL = "the pr-number input is not a positive integer";

  test("a malformed pr-number says to pass a positive integer, and names the cause", () => {
    for (const ctx of CONTEXTS) {
      const rendered = renderError(
        { kind: "trigger", check: "pr-unresolved" },
        { detail: DETAIL },
        ctx,
      );
      expect(rendered.annotation, ctx).toContain(
        "Fix: pass a positive integer as the `pr-number` input.",
      );
      expect(rendered.annotation, ctx).toContain(`(${DETAIL})`);
      expect(rendered.what, ctx).toContain(DETAIL);
    }
  });

  test("a missing pr-number keeps the default fix, which names no positive integer", () => {
    const rendered = renderError(
      { kind: "trigger", check: "pr-unresolved" },
      {},
      "action",
    );
    expect(rendered.annotation).toContain("or pass the `pr-number` input.");
    expect(rendered.annotation).not.toContain("positive integer");
  });
});

describe("ownerLead", () => {
  test("names each owner in the contract's words", () => {
    expect(ownerLead("config")).toBe("Your configuration:");
    expect(ownerLead("provider", "openai")).toBe("Provider openai:");
    expect(ownerLead("provider")).toBe("Provider:");
    expect(ownerLead("provider", "")).toBe("Provider:");
    expect(ownerLead("pr-hero")).toBe("pr-hero defect:");
    expect(ownerLead("unclassified")).toBe("Unclassified:");
  });
});

describe("builtins-only guard: src/ci/outcome.ts", () => {
  // ../brand is the one exception: it holds the marker names and has no
  // imports of its own, which the next test pins.
  test("outcome.ts has no runtime import of a repo module but ../brand", () => {
    expect(
      runtimeImportViolations(readFileSync(OUTCOME_SRC, "utf8"), ["../brand"]),
    ).toEqual([]);
  });

  test("src/brand.ts has no runtime import at all", () => {
    expect(
      runtimeImportViolations(
        readFileSync(path.join(REPO_ROOT, "src/brand.ts"), "utf8"),
      ),
    ).toEqual([]);
  });

  test("the guard itself fails on the violations it exists to catch", () => {
    expect(
      runtimeImportViolations(
        'import { a } from "../security/credential-broker";',
      ),
    ).toHaveLength(1);
    expect(
      runtimeImportViolations('import {\n  a,\n} from "#ci/x";'),
    ).toHaveLength(1);
    expect(runtimeImportViolations('export { z } from "./z";')).toHaveLength(1);
    expect(
      runtimeImportViolations('const m = await import("../x");'),
    ).toHaveLength(1);
    expect(runtimeImportViolations('import "./side-effect";')).toHaveLength(1);
  });

  test("the guard allows type-only imports, node and bun builtins, and comments", () => {
    expect(
      runtimeImportViolations(
        'import type { A } from "../security/credential-broker";',
      ),
    ).toEqual([]);
    expect(
      runtimeImportViolations(
        'import path from "node:path";\nimport { x } from "bun";',
      ),
    ).toEqual([]);
    expect(runtimeImportViolations('// import { y } from "../z";')).toEqual([]);
  });
});

// T2b (odd/tasks/agent-first-ci.md, S3): the record the trigger writes to
// trigger.json and the publisher reads back. The parser is the one place the
// shape is checked, so a malformed file is refused rather than half-read.
describe("parseTriggerRecord — the trigger.json contract", () => {
  const SHA = "d".repeat(40);
  const documented: TriggerRecord = {
    v: 1,
    decision: "review",
    params: {},
    pr: 7,
    head_sha: SHA,
    repository: "acme/widgets",
    run_id: "4242",
    run_attempt: 1,
    run_url: "https://github.com/acme/widgets/actions/runs/4242",
  };
  const text = (value: unknown) => JSON.stringify(value);

  test("accepts the documented shape, unchanged", () => {
    expect(parseTriggerRecord(text(documented))).toEqual(documented);
  });

  test("accepts the attempt of a re-run", () => {
    expect(
      parseTriggerRecord(text({ ...documented, run_attempt: 3 }))?.run_attempt,
    ).toBe(3);
  });

  test("a record without run_attempt, written before attempts were recorded, parses as attempt 1", () => {
    // WHY: undefined is dropped by JSON.stringify, so this is the absent key.
    expect(
      parseTriggerRecord(text({ ...documented, run_attempt: undefined }))
        ?.run_attempt,
    ).toBe(1);
  });

  test("accepts every decision, with and without the optional fields", () => {
    const decisions: TriggerRecord["decision"][] = [
      "review",
      "ignore",
      "denied",
      "unverifiable",
      "no-credentials",
    ];
    for (const decision of decisions) {
      const bare = {
        ...documented,
        decision,
        pr: undefined,
        head_sha: undefined,
      };
      expect(parseTriggerRecord(text(bare))?.decision).toBe(decision);
    }
  });

  test("accepts a class the trigger writes: a github status, a trigger check, and unknown", () => {
    const withClass = (cls: unknown) =>
      parseTriggerRecord(text({ ...documented, cls }));
    expect(withClass({ kind: "github", status: 503 })?.cls).toEqual({
      kind: "github",
      status: 503,
    });
    expect(
      withClass({ kind: "github", status: 403, rateLimited: true })?.cls,
    ).toEqual({ kind: "github", status: 403, rateLimited: true });
    expect(withClass({ kind: "trigger", check: "pr-unresolved" })?.cls).toEqual(
      { kind: "trigger", check: "pr-unresolved" },
    );
    expect(withClass({ kind: "unknown" })?.cls).toEqual({ kind: "unknown" });
  });

  test("accepts params with string values and a numeric pr", () => {
    const parsed = parseTriggerRecord(
      text({ ...documented, params: { backend: "opencode", detail: "x" } }),
    );
    expect(parsed?.params).toEqual({ backend: "opencode", detail: "x" });
  });

  test.each<[string, unknown]>([
    ["not JSON", "{ nope"],
    ["an array", []],
    ["a null", null],
    ["another version", { ...documented, v: 2 }],
    ["an unknown decision", { ...documented, decision: "maybe" }],
    ["a string pr", { ...documented, pr: "7" }],
    ["a zero pr", { ...documented, pr: 0 }],
    ["a fractional pr", { ...documented, pr: 1.5 }],
    ["a head that is not a sha", { ...documented, head_sha: "unknown" }],
    ["a head with a newline", { ...documented, head_sha: `${SHA}\nrun=true` }],
    ["params that is not an object", { ...documented, params: "x" }],
    ["a param that is not a string", { ...documented, params: { backend: 1 } }],
    ["an unknown param", { ...documented, params: { token: "x" } }],
    ["a missing repository", { ...documented, repository: undefined }],
    ["a missing run url", { ...documented, run_url: undefined }],
    ["a missing run id", { ...documented, run_id: undefined }],
    ["a zero run attempt", { ...documented, run_attempt: 0 }],
    ["a string run attempt", { ...documented, run_attempt: "2" }],
    ["a fractional run attempt", { ...documented, run_attempt: 1.5 }],
    ["an unknown class kind", { ...documented, cls: { kind: "magic" } }],
    // The trigger writes only pr-unresolved. A no-credential check on a review
    // would render PRH-CRED-MISSING for a record the trigger never wrote.
    [
      "a no-credential trigger class on a review",
      { ...documented, cls: { kind: "trigger", check: "no-credential" } },
    ],
    [
      "a routing-missing trigger class on a review",
      { ...documented, cls: { kind: "trigger", check: "routing-missing" } },
    ],
    [
      "a github class without a status",
      { ...documented, cls: { kind: "github" } },
    ],
  ])("refuses %s", (_label, value) => {
    expect(
      parseTriggerRecord(typeof value === "string" ? value : text(value)),
    ).toBeUndefined();
  });

  test("ignores a code key an older writer left in the record", () => {
    expect(
      parseTriggerRecord(text({ ...documented, code: "PRH-CRED-MISSING" })),
    ).toEqual(documented);
  });
});

// T6 (S8): an override record names WHO unlocked the gate. The reader refuses an
// override without a valid actor or without its PR, and refuses an actor on any
// other decision, because the writer produces neither.
describe("parseTriggerRecord — the override record (S8)", () => {
  const SHA = "d".repeat(40);
  const override: TriggerRecord = {
    v: 1,
    decision: "override",
    params: {},
    pr: 7,
    head_sha: SHA,
    actor: "maintainer",
    repository: "acme/widgets",
    run_id: "4242",
    run_attempt: 1,
    run_url: "https://github.com/acme/widgets/actions/runs/4242",
  };
  const text = (value: unknown) => JSON.stringify(value);

  test("an override carries its actor through", () => {
    expect(parseTriggerRecord(text(override))).toEqual(override);
  });

  // An Enterprise Managed User login (`handle_shortcode`) parses, up to the same 91
  // characters the trigger accepts, so the publisher can post what the trigger allowed.
  test.each([
    ["an underscore login", "octo_corp"],
    ["a 91-character login, the bound", "a".repeat(91)],
    ["a bot login of 91 characters in all", `${"a".repeat(86)}[bot]`],
  ])("an override with %s parses and keeps its actor", (_label, actor) => {
    expect(parseTriggerRecord(text({ ...override, actor }))).toEqual({
      ...override,
      actor,
    });
  });

  test("an override with no head still parses, because the comment posts without a status", () => {
    const { head_sha: _headSha, ...headless } = override;
    expect(parseTriggerRecord(text(headless))?.decision).toBe("override");
  });

  test.each([
    ["no actor", { actor: undefined }],
    ["an empty actor", { actor: "" }],
    ["a newline in the actor", { actor: "evil\n::warning::x" }],
    ["an actor that is not a string", { actor: 7 }],
    ["a 92-character actor", { actor: "a".repeat(92) }],
    ["a 96-character bot actor", { actor: `${"a".repeat(91)}[bot]` }],
    ["no PR", { pr: undefined }],
  ])("an override with %s is refused", (_label, change) => {
    expect(
      parseTriggerRecord(text({ ...override, ...change })),
    ).toBeUndefined();
  });

  test("an actor on a review, or on any other decision, is refused", () => {
    for (const decision of ["review", "denied", "unverifiable"]) {
      expect(
        parseTriggerRecord(text({ ...override, decision })),
      ).toBeUndefined();
    }
  });
});

describe("parseCliRecord — the cli.json contract", () => {
  const SHA = "c".repeat(40);
  const text = (value: unknown) => JSON.stringify(value);

  test.each([
    ["reviewed", { v: 1, outcome: "reviewed", head_sha: SHA }],
    ["hunters-failed", { v: 1, outcome: "hunters-failed", head_sha: SHA }],
    ["skipped for size", { v: 1, outcome: "skipped", skip: "size" }],
    [
      "skipped for budget, with its head",
      { v: 1, outcome: "skipped", skip: "budget", head_sha: SHA },
    ],
    ["skipped for coverage", { v: 1, outcome: "skipped", skip: "coverage" }],
    [
      "skipped for manual-required",
      { v: 1, outcome: "skipped", skip: "manual-required" },
    ],
    ["yielded", { v: 1, outcome: "yielded" }],
    // The progress record: the CLI took the pending lock and has no outcome yet.
    [
      "reviewing, with the head its pending status was posted on",
      { v: 1, outcome: "reviewing", head_sha: SHA },
    ],
    [
      "error, unclassified",
      { v: 1, outcome: "error", cls: { kind: "unknown" } },
    ],
    [
      "error, route unmapped",
      { v: 1, outcome: "error", cls: { kind: "route", reason: "unmapped" } },
    ],
    [
      "error, route ambiguous",
      { v: 1, outcome: "error", cls: { kind: "route", reason: "ambiguous" } },
    ],
    [
      "error, route spend-disabled",
      {
        v: 1,
        outcome: "error",
        cls: { kind: "route", reason: "spend-disabled" },
      },
    ],
    [
      "error, capability version_unsupported",
      {
        v: 1,
        outcome: "error",
        cls: { kind: "capability", issue: "version_unsupported" },
      },
    ],
    [
      "error, capability sdk_unavailable",
      {
        v: 1,
        outcome: "error",
        cls: { kind: "capability", issue: "sdk_unavailable" },
      },
    ],
    [
      "error with the params it knows",
      {
        v: 1,
        outcome: "error",
        cls: { kind: "unknown" },
        params: { backend: "opencode", pr: 7 },
      },
    ],
    // T2d-1: the classes the CLI writes for its classified config and engine errors.
    [
      "error, gotchas empty",
      { v: 1, outcome: "error", cls: { kind: "gotchas", reason: "empty" } },
    ],
    [
      "error, gotchas placeholder",
      {
        v: 1,
        outcome: "error",
        cls: { kind: "gotchas", reason: "placeholder" },
      },
    ],
    [
      "error, prompt-set",
      { v: 1, outcome: "error", cls: { kind: "prompt-set" } },
    ],
    [
      "error, config-parse for the repo config",
      {
        v: 1,
        outcome: "error",
        cls: { kind: "config-parse", source: "repo-config" },
      },
    ],
    [
      "error, config-parse for routing",
      {
        v: 1,
        outcome: "error",
        cls: { kind: "config-parse", source: "routing" },
      },
    ],
    [
      "error, config-parse for extra hunters",
      {
        v: 1,
        outcome: "error",
        cls: { kind: "config-parse", source: "extra-hunters" },
      },
    ],
    [
      "error, the engine invariant",
      { v: 1, outcome: "error", cls: { kind: "invariant" } },
    ],
  ])("accepts a %s record unchanged", (_label, value) => {
    expect(parseCliRecord(text(value))).toEqual(value as CliRecord);
  });

  test.each([
    ["malformed JSON", "{"],
    ["a wrong version", text({ v: 2, outcome: "yielded" })],
    ["no version", text({ outcome: "yielded" })],
    ["an unknown outcome", text({ v: 1, outcome: "crashed" })],
    [
      "skip on a non-skip outcome",
      text({ v: 1, outcome: "reviewed", skip: "size" }),
    ],
    ["skipped without a skip kind", text({ v: 1, outcome: "skipped" })],
    ["an unknown skip kind", text({ v: 1, outcome: "skipped", skip: "magic" })],
    [
      "cls on a non-error outcome",
      text({ v: 1, outcome: "reviewed", cls: { kind: "unknown" } }),
    ],
    ["error without a cls", text({ v: 1, outcome: "error" })],
    [
      "error with a class the CLI never writes",
      text({ v: 1, outcome: "error", cls: { kind: "github", status: 403 } }),
    ],
    [
      "error with a route reason outside the CLI's set",
      text({
        v: 1,
        outcome: "error",
        cls: { kind: "route", reason: "multiple-opencode-providers" },
      }),
    ],
    [
      "error with a capability issue outside the CLI's set",
      text({
        v: 1,
        outcome: "error",
        cls: { kind: "capability", issue: "binary_unresolved" },
      }),
    ],
    // A progress record names the lock's head and nothing else: the publisher
    // scopes its status read to that head, so a looser reader would read another.
    ["reviewing without a head", text({ v: 1, outcome: "reviewing" })],
    [
      "reviewing with a head that is not a SHA",
      text({ v: 1, outcome: "reviewing", head_sha: "C".repeat(40) }),
    ],
    [
      "reviewing that carries a class",
      text({
        v: 1,
        outcome: "reviewing",
        head_sha: SHA,
        cls: { kind: "unknown" },
      }),
    ],
    [
      "reviewing that carries params",
      text({ v: 1, outcome: "reviewing", head_sha: SHA, params: { pr: 7 } }),
    ],
    [
      "reviewing that names a skip",
      text({ v: 1, outcome: "reviewing", head_sha: SHA, skip: "size" }),
    ],
    [
      "a head that is uppercase",
      text({ v: 1, outcome: "yielded", head_sha: "C".repeat(40) }),
    ],
    [
      "a head that is too short",
      text({ v: 1, outcome: "yielded", head_sha: "c".repeat(12) }),
    ],
    [
      "a 64-character head",
      text({ v: 1, outcome: "yielded", head_sha: "c".repeat(64) }),
    ],
    [
      "a params key the record does not know",
      text({
        v: 1,
        outcome: "error",
        cls: { kind: "unknown" },
        params: { message: "raw error text" },
      }),
    ],
    [
      "a params value of the wrong type",
      text({
        v: 1,
        outcome: "error",
        cls: { kind: "unknown" },
        params: { pr: "7" },
      }),
    ],
    [
      "null params",
      text({
        v: 1,
        outcome: "error",
        cls: { kind: "unknown" },
        params: null,
      }),
    ],
    [
      "params on a non-error outcome, which carries no params",
      text({ v: 1, outcome: "reviewed", params: { pr: 7 } }),
    ],
    // T2d-1: a class the CLI never writes is refused, not read as a guess. The
    // person layer is one: its catalog text names the repo file, so it stays out.
    [
      "config-parse for the person layer",
      text({
        v: 1,
        outcome: "error",
        cls: { kind: "config-parse", source: "person-config" },
      }),
    ],
    [
      "config-parse with no source",
      text({ v: 1, outcome: "error", cls: { kind: "config-parse" } }),
    ],
    [
      "gotchas with a reason the gate never returns",
      text({
        v: 1,
        outcome: "error",
        cls: { kind: "gotchas", reason: "magic" },
      }),
    ],
    [
      "a trigger class, which only the trigger writes",
      text({
        v: 1,
        outcome: "error",
        cls: { kind: "trigger", check: "no-credential" },
      }),
    ],
  ])("refuses %s", (_label, value) => {
    expect(parseCliRecord(value)).toBeUndefined();
  });
});

// WHY this field: the CLI's final status write failed after its review was delivered,
// so the CLI records the status it could not write and the publisher posts it once
// more (recordUnsettledStatus, then decidePublication). The publisher posts exactly
// this state and description, so the reader hands them back unchanged.
describe("parseCliRecord — the unsettled_status field", () => {
  const SHA = "c".repeat(40);
  const text = (value: unknown) => JSON.stringify(value);
  const SUCCESS: UnsettledStatus = {
    state: "success",
    description: "review complete",
  };

  test("a reviewed record that carries a valid unsettled_status parses with it", () => {
    const value: CliRecord = {
      v: 1,
      outcome: "reviewed",
      head_sha: SHA,
      unsettled_status: SUCCESS,
    };
    expect(parseCliRecord(text(value))).toEqual(value);
  });

  test("a failure status whose description is exactly 140 characters parses", () => {
    const value: CliRecord = {
      v: 1,
      outcome: "reviewed",
      head_sha: SHA,
      unsettled_status: { state: "failure", description: "x".repeat(140) },
    };
    expect(parseCliRecord(text(value))).toEqual(value);
  });

  test("a reviewed record without the field still parses unchanged", () => {
    const value: CliRecord = { v: 1, outcome: "reviewed", head_sha: SHA };
    expect(parseCliRecord(text(value))).toEqual(value);
  });

  test.each([
    ["state pending", { state: "pending", description: "x" }],
    ["state error", { state: "error", description: "x" }],
    ["no state", { description: "x" }],
    ["an empty description", { state: "success", description: "" }],
    ["a blank description", { state: "success", description: "   " }],
    [
      "a description of 141 characters",
      { state: "failure", description: "x".repeat(141) },
    ],
    [
      "a description that is not a string",
      { state: "success", description: 7 },
    ],
    ["no description", { state: "success" }],
    ["null", null],
    ["a bare string", "success"],
  ])("refuses an unsettled_status with %s", (_label, unsettled) => {
    expect(
      parseCliRecord(
        text({
          v: 1,
          outcome: "reviewed",
          head_sha: SHA,
          unsettled_status: unsettled,
        }),
      ),
    ).toBeUndefined();
  });

  test.each([
    ["hunters-failed", { v: 1, outcome: "hunters-failed", head_sha: SHA }],
    ["skipped", { v: 1, outcome: "skipped", skip: "size" }],
    ["yielded", { v: 1, outcome: "yielded" }],
    ["reviewing", { v: 1, outcome: "reviewing", head_sha: SHA }],
    ["error", { v: 1, outcome: "error", cls: { kind: "unknown" } }],
  ])(
    "refuses the field on a %s record, which never delivered a review",
    (_label, base) => {
      expect(
        parseCliRecord(text({ ...base, unsettled_status: SUCCESS })),
      ).toBeUndefined();
    },
  );
});

// Fix 4: the override cutoff on a reviewed record, read by the publisher to tell an override
// posted during the run from one posted before it. Optional, so a record without it parses.
describe("parseCliRecord — the override_cutoff_ms field", () => {
  const SHA = "c".repeat(40);
  const text = (value: unknown) => JSON.stringify(value);
  const REVIEWED: CliRecord = {
    v: 1,
    outcome: "reviewed",
    head_sha: SHA,
    unsettled_status: { state: "success", description: "review complete" },
  };

  test("a reviewed record with a positive integer override_cutoff_ms parses with it", () => {
    const value: CliRecord = {
      ...REVIEWED,
      override_cutoff_ms: 1_792_238_395_000,
    };
    expect(parseCliRecord(text(value))).toEqual(value);
  });

  test("a reviewed record without override_cutoff_ms still parses unchanged", () => {
    expect(parseCliRecord(text(REVIEWED))).toEqual(REVIEWED);
  });

  test.each([
    ["zero", 0],
    ["a negative number", -5],
    ["a fraction", 1.5],
    ["a string", "1792238400000"],
    ["null", null],
    ["an integer beyond the safe range", 1e20],
  ])("refuses override_cutoff_ms of %s", (_label, value) => {
    expect(
      parseCliRecord(text({ ...REVIEWED, override_cutoff_ms: value })),
    ).toBeUndefined();
  });

  test("refuses the field on a record that did not deliver a review", () => {
    expect(
      parseCliRecord(
        text({
          v: 1,
          outcome: "yielded",
          override_cutoff_ms: 1_792_238_400_000,
        }),
      ),
    ).toBeUndefined();
  });
});

// `pr-hero status` reads the newest outcome comment's PRH-* code. The reader and the
// publisher share the marker prefix, so a comment the publisher writes reads back.
describe("parseOutcomeCode", () => {
  test("the marker prefix is the one the publisher writes", () => {
    const publisherSource = readFileSync(
      path.resolve(import.meta.dir, "../../src/ci/publish.ts"),
      "utf8",
    );
    expect(publisherSource).toContain("OUTCOME_MARKER_PREFIX");
    expect(OUTCOME_MARKER_PREFIX).toBe("<!-- crysk-outcome ");
  });

  test("reads the code from a rendered outcome comment, as the publisher writes it", () => {
    const rendered = renderCode("PRH-CRED-MISSING", {}, "action");
    const body = [
      `${OUTCOME_MARKER_PREFIX}v=1 head=${"a".repeat(40)} run=7 attempt=1 -->`,
      "",
      ...rendered.summary,
    ].join("\n");
    expect(parseOutcomeCode(body)).toBe("PRH-CRED-MISSING");
  });

  test("a headline that carries a colon still yields the bare code", () => {
    const body = `${OUTCOME_MARKER_PREFIX}v=1 head=unknown run=7 attempt=1 -->\n\n### PRH-CANCELLED: not reviewed\n\nbody`;
    expect(parseOutcomeCode(body)).toBe("PRH-CANCELLED");
  });

  test("null for a comment without the outcome marker, even when it quotes a code", () => {
    expect(parseOutcomeCode("### PRH-CRED-MISSING\n\nquoted")).toBeNull();
  });

  test("null for an outcome comment with no code heading, or an unknown one", () => {
    expect(
      parseOutcomeCode(
        `${OUTCOME_MARKER_PREFIX}v=1 head=unknown -->\n\nno heading`,
      ),
    ).toBeNull();
    expect(
      parseOutcomeCode(
        `${OUTCOME_MARKER_PREFIX}v=1 head=unknown -->\n\n### PRH-NOT-A-CODE`,
      ),
    ).toBeNull();
  });
});

describe("a model the provider does not serve", () => {
  const modelUnavailable: ErrorClass = {
    kind: "transport",
    cause: "model_unavailable",
  };

  test("renders PRH-MODEL-UNAVAILABLE, owned by the provider", () => {
    expect(codeOf(modelUnavailable)).toBe("PRH-MODEL-UNAVAILABLE");
    expect(ownerOf(modelUnavailable, "action")).toBe("provider");
  });

  test("leads with the provider's name, never Unclassified", () => {
    const rendered = renderError(
      modelUnavailable,
      { provider: "openai", step: "the hunter" },
      "action",
    );
    expect(rendered.code).toBe("PRH-MODEL-UNAVAILABLE");
    expect(rendered.owner).toBe("provider");
    expect(rendered.annotation).toContain("Provider openai: ");
    expect(rendered.annotation).not.toContain("Unclassified");
    expect(rendered.what).toStartWith("Provider openai does not serve");
  });

  test("provider_configuration_invalid keeps its own owner, config", () => {
    const rendered = renderError(
      { kind: "transport", cause: "provider_configuration_invalid" },
      { provider: "openai", step: "the hunter" },
      "action",
    );
    expect(rendered.code).toBe("PRH-MODEL-UNAVAILABLE");
    expect(rendered.owner).toBe("config");
    expect(rendered.annotation).toContain("Your configuration: ");
  });
});

describe("parseCliRecord — the hunter_failures field", () => {
  const HEAD = "a".repeat(40);
  const base = { v: 1, outcome: "hunters-failed", head_sha: HEAD };
  const text = (value: unknown) => JSON.stringify(value);

  test("round-trips each failed hunter's cause, provider and model", () => {
    const value = {
      ...base,
      hunter_failures: [
        { cause: "model_unavailable", provider: "opencode", model: "gpt-4o" },
        { cause: "network_transient" },
        {},
      ],
    };
    expect(parseCliRecord(text(value))).toEqual(value as CliRecord);
  });

  test("an old record without the field still parses, unchanged", () => {
    expect(parseCliRecord(text(base))).toEqual(base as CliRecord);
  });

  test("a cause outside the transport vocabulary is refused", () => {
    expect(
      parseCliRecord(
        text({ ...base, hunter_failures: [{ cause: "not_a_cause" }] }),
      ),
    ).toBeUndefined();
    expect(
      parseCliRecord(
        text({ ...base, hunter_failures: [{ cause: "format_violation" }] }),
      ),
    ).toBeUndefined();
  });

  test("a provider or model that is not a short safe string is refused", () => {
    for (const bad of [
      { provider: "open code" },
      { provider: "line\nbreak" },
      { provider: "x".repeat(65) },
      { provider: "" },
      { model: "gpt 4o\u0007" },
      { model: "m".repeat(97) },
      { provider: 3 },
    ]) {
      expect(
        parseCliRecord(text({ ...base, hunter_failures: [bad] })),
      ).toBeUndefined();
    }
  });

  test("an entry that is not an object, or a field that is not an array, is refused", () => {
    expect(
      parseCliRecord(text({ ...base, hunter_failures: ["model_unavailable"] })),
    ).toBeUndefined();
    expect(
      parseCliRecord(text({ ...base, hunter_failures: {} })),
    ).toBeUndefined();
  });

  test("an unknown key inside an entry is refused, so a wider writer shows up here", () => {
    expect(
      parseCliRecord(
        text({
          ...base,
          hunter_failures: [{ cause: "network_transient", step: "x" }],
        }),
      ),
    ).toBeUndefined();
  });

  test("the field belongs to hunters-failed only", () => {
    expect(
      parseCliRecord(
        text({
          v: 1,
          outcome: "reviewed",
          head_sha: HEAD,
          hunter_failures: [{ cause: "network_transient" }],
        }),
      ),
    ).toBeUndefined();
  });
});

// A first-time user reads only the Fix line; it must name the command that
// creates .prhero/gotchas.md, or the user writes the file by hand in the wrong
// place or never writes it at all.
describe("PRH-GOTCHAS-MISSING fix names the init command", () => {
  test("the fix starts by running `npx -y pr-hero init`, then the existing steps", () => {
    const [[fix]] = fixListsOf(
      entryOf("PRH-GOTCHAS-MISSING").variants.default.fixes,
    );
    expect(fix).toBe(
      "Run `npx -y pr-hero init` in a clone of the repository (it creates .prhero/config.json and .prhero/gotchas.md), then write real facts about this repository, delete the scaffold marker line if it is there, and commit the file to the base branch (comment-triggered runs read the base branch).",
    );
  });
});

describe("PRH-HUNTERS-FAILED lead", () => {
  // WHY: the caller requests this code for a condition it observes directly
  // (the hunter set), so "Unclassified:" would blame pr-hero for nothing
  // unknown. Other unclassified codes keep their lead.
  test("names the condition instead of Unclassified", () => {
    const rendered = renderCode("PRH-HUNTERS-FAILED", FULL, "action");
    expect(
      rendered.annotation.startsWith(
        "::error title=pr-hero PRH-HUNTERS-FAILED::Not reviewed: ",
      ),
    ).toBe(true);
    expect(rendered.annotation.includes("Unclassified:")).toBe(false);
    expect(rendered.summary.join("\n").includes("Unclassified:")).toBe(false);
  });

  test("other unclassified codes still lead with Unclassified", () => {
    const rendered = renderCode("PRH-UNCLASSIFIED", FULL, "action");
    expect(rendered.annotation.includes("::Unclassified: ")).toBe(true);
  });
});

// The run's own URL, the target_url of the pending the CLI posts in Actions (SB3 follow-up).
describe("actionsRunUrl — the run a pending belongs to", () => {
  const IN_ACTIONS = {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_RUN_ID: "4242",
  };

  test("names the run and its attempt, the first attempt when none is given", () => {
    expect(actionsRunUrl(IN_ACTIONS)).toBe(
      "https://github.com/acme/widgets/actions/runs/4242/attempts/1",
    );
  });

  test("names the attempt the runner reports", () => {
    expect(actionsRunUrl({ ...IN_ACTIONS, GITHUB_RUN_ATTEMPT: "3" })).toBe(
      "https://github.com/acme/widgets/actions/runs/4242/attempts/3",
    );
  });

  test("an attempt that is not a positive integer is the first attempt", () => {
    for (const attempt of ["0", "x", "-2"]) {
      expect(
        actionsRunUrl({ ...IN_ACTIONS, GITHUB_RUN_ATTEMPT: attempt }),
      ).toBe("https://github.com/acme/widgets/actions/runs/4242/attempts/1");
    }
  });

  test("outside GitHub Actions there is no run URL", () => {
    const { GITHUB_ACTIONS: _actions, ...outside } = IN_ACTIONS;
    expect(actionsRunUrl(outside)).toBeUndefined();
    expect(actionsRunUrl({ ...IN_ACTIONS, GITHUB_ACTIONS: "false" })).toBe(
      undefined,
    );
  });

  test("a run without its server, repository, or run id has no run URL", () => {
    for (const key of [
      "GITHUB_SERVER_URL",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ID",
    ] as const) {
      expect(actionsRunUrl({ ...IN_ACTIONS, [key]: "" })).toBeUndefined();
    }
  });
});

// A workflow scaffolded before the rename passes only vars.PRHERO_ROUTING to
// the action, so the routing fixes must name it, not only CRYSK_ROUTING.
describe("routing fixes name the pre-rename variable too", () => {
  test("PRH-ROUTING-MISSING points a pre-rename workflow at PRHERO_ROUTING", () => {
    const rendered = renderError(
      { kind: "trigger", check: "routing-missing" },
      {},
      "action",
    );
    expect(rendered.what).not.toContain("CRYSK_ROUTING is empty");
    expect(rendered.summary.join("\n")).toContain("reads PRHERO_ROUTING");
    expect(rendered.annotation).toContain("PRHERO_ROUTING");
  });
});
