import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CI_SETUP_SKILL_FILES,
  GENERAL_SKILL_FILES,
  PR_SKILL_FILES,
  TRIAGE_SKILL_FILES,
} from "../src/asset-manifest";
import { PR_STATUS_REASON_CODES, type PrNextAction } from "../src/pr/pr-status";
import { parseArgs } from "../src/review/preflight";

// What an agent reads in a shipped skill has to exist in the code it drives. A skill naming a flag
// the parser refuses, a reason code status never returns or a file the loader cannot serve fails
// only when an agent follows it, on someone else's pull request. Each check is a pure function over
// text, so the negative cases below prove it can fail.

const ROOT = join(import.meta.dir, "..");
const MANIFESTS: Record<string, Record<string, string>> = {
  crysk: GENERAL_SKILL_FILES,
  "crysk-loop": TRIAGE_SKILL_FILES,
  "crysk-pr": PR_SKILL_FILES,
  "crysk-ci-setup": CI_SETUP_SKILL_FILES,
};
const SHIPPED_SKILLS = Object.keys(MANIFESTS);

// Closes the union: a new next_action fails tsc here until the table below can name it.
const NEXT_ACTIONS: Record<PrNextAction, true> = {
  wait: true,
  review: true,
  triage: true,
  fix: true,
  "override-or-fix": true,
  recheck: true,
  done: true,
};

function shippedMarkdown(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md")) {
        out.push({
          file: relative(ROOT, full),
          text: readFileSync(full, "utf8"),
        });
      }
    }
  };
  for (const skill of SHIPPED_SKILLS) {
    walk(join(ROOT, "skills", skill));
    walk(join(ROOT, "skill-content", skill));
  }
  return out;
}

// Every code span, and every line of a fenced block.
function codeSnippets(text: string): string[] {
  const snippets: string[] = [];
  const prose = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body: string) => {
    snippets.push(...body.split("\n"));
    return "";
  });
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) {
    if (match[1] !== undefined) snippets.push(match[1]);
  }
  return snippets.map((snippet) => snippet.trim());
}

// The arguments of each snippet that starts as a crysk invocation. Only those: `gh`, `git` and
// `opencode` have flags of their own, and `/crysk review` is a comment, not this CLI.
function cryskInvocations(text: string): string[] {
  const out: string[] = [];
  for (const snippet of codeSnippets(text)) {
    const match = /^(?:npx\s+-y\s+crysk@\S+|crysk)\s+(.+)$/.exec(snippet);
    if (match?.[1] !== undefined) out.push(match[1]);
  }
  return out;
}

function parserError(argv: string[]): string | null {
  try {
    parseArgs(argv);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// `--help` returns as soon as it is read, so the words before it are checked and nothing after them
// is required. A flag is probed alone: any answer but "unknown option" means the parser knows it.
export function cliProblems(text: string): string[] {
  const problems: string[] = [];
  for (const invocation of cryskInvocations(text)) {
    const tokens = invocation.split(/\s+/);
    const firstOther = tokens.findIndex((t) => !/^[a-z][a-z0-9-]*$/.test(t));
    const words = firstOther === -1 ? tokens : tokens.slice(0, firstOther);
    const error = parserError([...words, "--help"]);
    if (error !== null && /^(unknown command|unexpected argument)/.test(error))
      problems.push(`crysk ${invocation}: ${error}`);
    const flags = tokens
      .flatMap((token) => token.split(/[[\]|=,]/))
      .filter((token) => /^--[a-z]/.test(token));
    for (const flag of flags) {
      const flagError = parserError([flag, "1"]);
      if (flagError?.startsWith("unknown option")) {
        problems.push(`crysk ${invocation}: ${flagError}`);
      }
    }
  }
  // A flag named on its own in prose: `--force`, `--issue <n>`. Not in a fence, where a line starting
  // with a flag continues the command above it, which may be another tool's.
  for (const snippet of codeSnippets(text.replace(/```[\s\S]*?```/g, ""))) {
    const flag = /^--[a-z][a-z0-9-]*/.exec(snippet)?.[0];
    if (flag === undefined) continue;
    const flagError = parserError([flag, "1"]);
    if (flagError?.startsWith("unknown option")) {
      problems.push(`${snippet}: ${flagError}`);
    }
  }
  return problems;
}

export function companionProblems(
  text: string,
  manifests: Record<string, Record<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const invocation of cryskInvocations(text)) {
    const match = /^skills\s+load\s+(\S+)(?:\s+(\S+))?/.exec(invocation);
    if (match?.[1] === undefined || match[1].startsWith("<")) continue;
    const files = manifests[match[1]];
    if (files === undefined) {
      problems.push(`unknown skill: ${match[1]}`);
      continue;
    }
    const file = match[2];
    if (file === undefined || file.startsWith("<")) continue;
    if (!Object.hasOwn(files, file)) {
      problems.push(`${match[1]} has no file ${file}`);
    }
  }
  return problems;
}

// A path into this repository resolves nowhere for an agent: docs/ is not in the npm package.
export function docsPathProblems(text: string): string[] {
  return [...text.matchAll(/(?<![\w./:-])docs\/[\w./-]*/g)].map(
    (match) => match[0],
  );
}

// `next_action=x` and `reason_code=x` are how skill text names a value outside the routing table.
export function namedValueProblems(text: string): string[] {
  const problems: string[] = [];
  for (const match of text.matchAll(/\breason_code=([a-z_-]+)/g)) {
    const code = match[1] ?? "";
    if (!(PR_STATUS_REASON_CODES as readonly string[]).includes(code)) {
      problems.push(`unknown reason_code: ${code}`);
    }
  }
  for (const match of text.matchAll(/\bnext_action=([a-z_-]+)/g)) {
    const action = match[1] ?? "";
    if (!Object.hasOwn(NEXT_ACTIONS, action)) {
      problems.push(`unknown next_action: ${action}`);
    }
  }
  return problems;
}

// The rows of the playbook's routing table: `next_action` | `reason_code` | what to do.
function routingRows(playbook: string): { action: string; code: string }[] {
  const rows: { action: string; code: string }[] = [];
  for (const line of playbook.split("\n")) {
    const match = /^\| `([a-z-]+)` \| `([a-z_]+)` \|/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      rows.push({ action: match[1], code: match[2] });
    }
  }
  return rows;
}

// Each decision in pr-status.ts, as code states it: the reason code and the action beside it.
function decisionsInCode(): Map<string, string> {
  const source = readFileSync(join(ROOT, "src/pr/pr-status.ts"), "utf8");
  const decisions = new Map<string, string>();
  for (const match of source.matchAll(
    /reason_code: "([a-z_]+)",\s+next_action: "([a-z-]+)"/g,
  )) {
    if (match[1] !== undefined && match[2] !== undefined) {
      decisions.set(match[1], match[2]);
    }
  }
  return decisions;
}

export function routingProblems(
  playbook: string,
  decisions: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  const rows = routingRows(playbook);
  const seen = new Set<string>();
  for (const { action, code } of rows) {
    if (seen.has(code)) problems.push(`${code} is routed twice`);
    seen.add(code);
    const expected = decisions.get(code);
    if (expected === undefined) problems.push(`unknown reason_code: ${code}`);
    else if (expected !== action) {
      problems.push(`${code} comes with ${expected}, the table says ${action}`);
    }
  }
  for (const code of decisions.keys()) {
    if (!seen.has(code)) problems.push(`${code} has no row`);
  }
  return problems;
}

function step0(stub: string, skill: string): string | null {
  const match = /## Step 0[\s\S]*?It never overrides these rules:/.exec(stub);
  return match === null
    ? null
    : match[0].replaceAll(`skills load ${skill}`, "skills load <skill>");
}

export function stubProblems(stubs: Record<string, string>): string[] {
  const problems: string[] = [];
  const shared = new Set<string>();
  for (const [skill, stub] of Object.entries(stubs)) {
    const step = step0(stub, skill);
    if (step === null) problems.push(`${skill}: no Step 0`);
    else shared.add(step);
    if (!stub.includes(`name: ${skill}\n`)) {
      problems.push(`${skill}: the frontmatter name changed`);
    }
    const body = stub.replace(/^---\n[\s\S]*?\n---\n/, "");
    for (const match of body.matchAll(
      /[\w/-]+\.(?:md|json|ya?ml)\b|references\/|assets\//g,
    )) {
      problems.push(`${skill}: names a file: ${match[0]}`);
    }
  }
  if (shared.size > 1) problems.push("the stubs' Step 0 texts differ");
  return problems;
}

// Skill evaluators read angle brackets in a description as XML, and agents match on its words.
export function frontmatterProblems(stubs: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [skill, stub] of Object.entries(stubs)) {
    const description = /^description: (.*)$/m.exec(stub)?.[1];
    if (description === undefined) problems.push(`${skill}: no description`);
    else if (/[<>]/.test(description)) {
      problems.push(`${skill}: angle bracket in the description`);
    }
    if (!/^ {2}tags: "[^"]+"$/m.test(stub)) {
      problems.push(`${skill}: no metadata.tags`);
    }
  }
  return problems;
}

describe("shipped skill text matches the code", () => {
  const files = shippedMarkdown();

  test("the walk reaches every skill's playbook", () => {
    for (const skill of SHIPPED_SKILLS) {
      expect(files.map((f) => f.file)).toContain(
        join("skill-content", skill, "playbook.md"),
      );
    }
  });

  test("every crysk subcommand and flag exists in the CLI parser", () => {
    expect(files.flatMap((f) => cliProblems(f.text))).toEqual([]);
  });

  test("every companion named by a skills load command is in the manifest", () => {
    expect(files.flatMap((f) => companionProblems(f.text, MANIFESTS))).toEqual(
      [],
    );
  });

  test("every file in a skill's manifest exists under that skill", () => {
    for (const [skill, manifest] of Object.entries(MANIFESTS)) {
      for (const file of Object.keys(manifest)) {
        const dir = file === "SKILL.md" ? "skills" : "skill-content";
        expect(statSync(join(ROOT, dir, skill, file)).isFile()).toBe(true);
      }
    }
  });

  test("no repository docs/ path remains", () => {
    expect(
      files.flatMap((f) =>
        docsPathProblems(f.text).map((hit) => `${f.file}: ${hit}`),
      ),
    ).toEqual([]);
  });

  test("every next_action and reason_code named exists in code", () => {
    expect(files.flatMap((f) => namedValueProblems(f.text))).toEqual([]);
  });

  test("the loop's routing table has one correct row per decision", () => {
    const decisions = decisionsInCode();
    // A drifted source format must not empty the check.
    expect([...decisions.keys()].sort()).toEqual(
      [...PR_STATUS_REASON_CODES].sort(),
    );
    const playbook = readFileSync(
      join(ROOT, "skill-content/crysk-loop/playbook.md"),
      "utf8",
    );
    expect(routingProblems(playbook, decisions)).toEqual([]);
  });

  test("every stub's description is free of angle brackets and it has tags", () => {
    const stubs = Object.fromEntries(
      SHIPPED_SKILLS.map((skill) => [
        skill,
        readFileSync(join(ROOT, "skills", skill, "SKILL.md"), "utf8"),
      ]),
    );
    expect(frontmatterProblems(stubs)).toEqual([]);
  });

  test("the stubs share one Step 0 and name no companion file", () => {
    const stubs = Object.fromEntries(
      SHIPPED_SKILLS.map((skill) => [
        skill,
        readFileSync(join(ROOT, "skills", skill, "SKILL.md"), "utf8"),
      ]),
    );
    expect(stubProblems(stubs)).toEqual([]);
  });
});

// Each check, handed the defect it exists to catch.
describe("the checks fail on a defect", () => {
  test("an unknown subcommand", () => {
    expect(cliProblems("Run `crysk explain CRYSK-X`.")).toHaveLength(1);
  });

  test("an unknown second word", () => {
    expect(cliProblems("Run `crysk ci check`.")).toHaveLength(1);
  });

  test("an unknown flag, pinned or bare, in a span or a fence", () => {
    expect(cliProblems("`crysk status --pr 1 --nope`")).toHaveLength(1);
    expect(
      cliProblems("```bash\nnpx -y crysk@1.2.3 ci init --questions\n```"),
    ).toHaveLength(1);
  });

  test("an unknown flag named on its own", () => {
    expect(cliProblems("Pass `--nope` to it.")).toHaveLength(1);
    expect(cliProblems("Pass `--force` or `--issue <n>`.")).toEqual([]);
  });

  test("a real invocation and other tools' flags pass", () => {
    expect(
      cliProblems(
        "`crysk status --pr <n> --wait --json`, `gh pr view --jq .x`, `/crysk review --nope`, `crysk triage reply --pr 1 --finding R001 [--verdict <v>]`",
      ),
    ).toEqual([]);
  });

  test("a companion missing from the manifest", () => {
    expect(
      companionProblems("`crysk skills load crysk-loop gone.md`", MANIFESTS),
    ).toEqual(["crysk-loop has no file gone.md"]);
  });

  test("an unknown skill", () => {
    expect(
      companionProblems("`crysk skills load crysk-nope`", MANIFESTS),
    ).toEqual(["unknown skill: crysk-nope"]);
  });

  test("a repository docs path, but not a site or GitHub URL", () => {
    expect(docsPathProblems("see docs/github-actions.md")).toEqual([
      "docs/github-actions.md",
    ]);
    expect(
      docsPathProblems(
        "https://crysk.dev/docs/quickstart/ and https://github.com/cryskai/crysk/blob/main/docs/configuration.md",
      ),
    ).toEqual([]);
  });

  test("an unknown named value", () => {
    expect(
      namedValueProblems("reason_code=review_skiped and next_action=stop"),
    ).toHaveLength(2);
  });

  test("a routing table with a wrong, a duplicate or a missing row", () => {
    const decisions = new Map([
      ["a_code", "review"],
      ["b_code", "done"],
    ]);
    const good = "| `review` | `a_code` | x |\n| `done` | `b_code` | y |";
    expect(routingProblems(good, decisions)).toEqual([]);
    expect(routingProblems("| `fix` | `a_code` | x |", decisions)).toEqual([
      "a_code comes with review, the table says fix",
      "b_code has no row",
    ]);
    expect(
      routingProblems(`${good}\n| \`done\` | \`b_code\` | y |`, decisions),
    ).toEqual(["b_code is routed twice"]);
    expect(
      routingProblems(`${good}\n| \`done\` | \`c_code\` | y |`, decisions),
    ).toEqual(["unknown reason_code: c_code"]);
  });

  test("a description with a tag-like form, or no tags", () => {
    expect(
      frontmatterProblems({
        a: 'description: "wait on --pr <n>"\n  tags: "x"\n',
        b: 'description: "fine"\n',
      }),
    ).toEqual(["a: angle bracket in the description", "b: no metadata.tags"]);
  });

  test("stubs that drift apart or name a companion", () => {
    const stub = (name: string, extra = "") =>
      `---\nname: ${name}\n---\n## Step 0\n${extra}skills load ${name}\nIt never overrides these rules:\n`;
    expect(stubProblems({ a: stub("a"), b: stub("b") })).toEqual([]);
    expect(stubProblems({ a: stub("a"), b: stub("b", "more ") })).toEqual([
      "the stubs' Step 0 texts differ",
    ]);
    expect(stubProblems({ a: `${stub("a")}Load adjudicator.md.\n` })).toEqual([
      "a: names a file: adjudicator.md",
    ]);
  });
});

describe("what the skills tell an agent to load or run", () => {
  const ciOperations = readFileSync(
    join(ROOT, "skill-content/crysk-ci-setup/references/ci-operations.md"),
    "utf8",
  );
  const playbook = readFileSync(
    join(ROOT, "skill-content/crysk-loop/playbook.md"),
    "utf8",
  );

  test("ci-operations names companion files by the path the loader serves", () => {
    const named = [...ciOperations.matchAll(/`([\w./-]*ci-[\w-]+\.md)`/g)].map(
      (match) => match[1] ?? "",
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((file) => !(file in CI_SETUP_SKILL_FILES))).toEqual([]);
  });

  test("the reload check accepts only the playbook's own pinned loader", () => {
    const pinned = /npx -y crysk@(\d+\.\d+\.\d+) status --pr/.exec(
      playbook,
    )?.[1];
    expect(pinned).toBeDefined();
    const step = playbook.slice(
      playbook.indexOf("**2. Check `skills_reload`.**"),
      playbook.indexOf("**3. Check the checkout.**"),
    );
    expect(step).toContain(`\`npx -y crysk@${pinned} skills load crysk-loop\``);
    expect(step).toContain("exactly");
    expect(step).toContain("once");
  });

  test("a limit skip stays a question, and the first review stays automatic", () => {
    const row = (code: string) =>
      playbook.split("\n").find((line) => line.includes(`| \`${code}\` |`)) ??
      "";
    expect(row("review_skipped")).toContain("**ask**");
    expect(row("no_gate_status")).toContain("| auto |");
    expect(row("carried_red_findings_open")).toContain("`override-or-fix`");
  });
});
