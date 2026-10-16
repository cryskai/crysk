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
  type CatalogEntry,
  codeOf,
  ERROR_CATALOG,
  ERROR_CODES,
  type ErrorClass,
  type ErrorCode,
  type ErrorParams,
  type OutcomeContext,
  type Owner,
  ownerLead,
  ownerOf,
  renderCode,
  renderError,
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

function runtimeImportViolations(source: string): string[] {
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
    if (!isBuiltin(specifier))
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
        expect(ownerOf(cls, ctx), `${JSON.stringify(cls)} ${ctx}`).toBe(
          ownerIn(entry, ctx),
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
        expect(variant.fixes.length, `${code} ${key} fixes`).toBeGreaterThan(0);
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
        for (const fix of variant.fixes) {
          const text = fix.startsWith("$ ") ? fix.slice(2) : fix;
          expect(body.includes(text), `${code} ${key} fix: ${text}`).toBe(true);
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
      'gh pr comment 7 --body "/pr-hero review"',
    );
  });

  test("explicitly requested codes take the owner the caller passes", () => {
    const hunters = renderCode(
      "PRH-HUNTERS-FAILED",
      { detail: "dedupe: pr-hero" },
      "action",
    );
    expect(
      hunters.annotation.startsWith(
        "::error title=pr-hero PRH-HUNTERS-FAILED::Unclassified: ",
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
        "wait for the limit to reset or raise the quota, then comment /pr-hero review on the PR",
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
      "add the missing scope under the job's `permissions:` (see docs)",
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
        for (const fix of selected.fixes) {
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
      'gh pr comment <pr> --body "/pr-hero review"',
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
  test("outcome.ts has no runtime import of a repo module", () => {
    expect(runtimeImportViolations(readFileSync(OUTCOME_SRC, "utf8"))).toEqual(
      [],
    );
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
