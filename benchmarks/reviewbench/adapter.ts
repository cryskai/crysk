// The ReviewBench agent contract around Crysk's local review: one pull request
// in, one findings file out. See README.md and
// https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md
//
// Exit codes are part of the contract. Non-zero means the pull request failed,
// and the benchmark retries it and then fails the whole run. Zero with no
// findings means "reviewed, found nothing", so it must never stand in for a
// review that did not happen.

import { mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FindingsDocument } from "#review/findings";
import { BUILTIN_IGNORE_RULES } from "../../src/ignore-file";
import { filterDiffByIgnoreRules } from "../../src/review/size-gate";

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface Contract {
  nwo: string;
  prNumber: number;
  base: string;
  head: string;
  agent: string;
  diff: string;
  out: string;
  repo: string;
  // Keeps the engine's run directory for the ledger. Only the local runner sets it.
  runDir?: string;
  model?: string;
}

export function readContract(
  env: Record<string, string | undefined>,
): Contract {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const sha = (name: string): string => {
    const value = required(name);
    if (!FULL_SHA.test(value)) throw new Error(`${name} is not a full SHA`);
    return value;
  };
  const prNumber = Number(required("RB_PR_NUMBER"));
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error("RB_PR_NUMBER is not a positive integer");
  }
  const model = env.RB_CONFIG_MODEL?.trim();
  const runDir = env.RB_RUN_DIR?.trim();
  return {
    nwo: required("RB_NWO"),
    prNumber,
    base: sha("RB_BASE"),
    head: sha("RB_HEAD"),
    agent: required("RB_AGENT"),
    diff: required("RB_DIFF"),
    out: required("RB_OUT"),
    repo: env.RB_REPO?.trim() || "/work/repo",
    ...(runDir ? { runDir } : {}),
    ...(model ? { model } : {}),
  };
}

export function reviewArgv(input: {
  bun: string;
  cli: string;
  repo: string;
  contract: Contract;
  gotchas: string;
  runDir: string;
}): string[] {
  const { contract } = input;
  return [
    input.bun,
    input.cli,
    "review",
    "--repo",
    input.repo,
    "--base",
    contract.base,
    "--head",
    contract.head,
    "--yes",
    // The benchmark scores every pull request, and one the size gate skips
    // scores nothing. So this measures more than the product reviews by default.
    "--force",
    // The summary costs a step and adds no findings.
    "--no-summary",
    "--gotchas",
    input.gotchas,
    "--out",
    input.runDir,
    ...(contract.model === undefined ? [] : ["--model", contract.model]),
  ];
}

interface OutputFinding {
  file: string;
  start_line: number;
  end_line: number;
  message: string;
  producer: string;
}

export interface FindingsFile {
  pr: { repo: string; pr_number: number; base: string; head: string };
  agent: string;
  findings: OutputFinding[];
}

type ReviewedDocument = Pick<FindingsDocument, "head_sha"> & {
  findings: readonly { path: string; line: number; claim: string }[];
};

// Repository-relative with forward slashes, or undefined when it is not a path
// inside the repository. Nothing checks a finding's path before this.
function repositoryPath(raw: string): string | undefined {
  const file = path.posix.normalize(raw.replaceAll("\\", "/"));
  if (file === "." || file.startsWith("/") || file.startsWith("../")) {
    return undefined;
  }
  return file;
}

export function toFindingsFile(
  doc: ReviewedDocument,
  contract: Contract,
): FindingsFile {
  if (doc.head_sha !== contract.head) {
    throw new Error(
      `the review read head ${doc.head_sha}, not ${contract.head}`,
    );
  }
  const findings: OutputFinding[] = [];
  for (const finding of doc.findings) {
    const file = repositoryPath(finding.path);
    const message = finding.claim.replace(/\s+/g, " ").trim();
    if (
      file === undefined ||
      message === "" ||
      !Number.isInteger(finding.line) ||
      finding.line < 1
    ) {
      console.error(
        `adapter: dropped a finding at ${finding.path}:${finding.line}`,
      );
      continue;
    }
    findings.push({
      file,
      start_line: finding.line,
      end_line: finding.line,
      message,
      producer: contract.agent,
    });
  }
  return {
    pr: {
      repo: `https://github.com/${contract.nwo}`,
      pr_number: contract.prNumber,
      base: contract.base,
      head: contract.head,
    },
    agent: contract.agent,
    findings,
  };
}

// The engine refuses a diff with nothing left after its default exclusions, and
// that is an answer here, not a failure.
export function isReviewable(diff: string): boolean {
  return (
    filterDiffByIgnoreRules(diff, BUILTIN_IGNORE_RULES).patch.trim().length > 0
  );
}

// Zero findings from no hunters would score as a clean review. A partial review
// still counts: a hunter that fails every time must not fail the whole run.
export function assertHuntersRan(pipeline: {
  steps?: readonly { name?: string; status?: string }[];
}): void {
  const hunters = (pipeline.steps ?? []).filter((step) =>
    step.name?.startsWith("hunter-"),
  );
  const ok = hunters.filter((step) => step.status === "ok").length;
  if (ok === 0) throw new Error("no hunter completed its review");
  if (ok < hunters.length) {
    console.error(`adapter: partial review, ${ok}/${hunters.length} hunters`);
  }
}

async function writeOutput(out: string, file: FindingsFile): Promise<void> {
  const temp = `${out}.tmp`;
  await Bun.write(temp, `${JSON.stringify(file, null, 2)}\n`);
  await rename(temp, out);
}

async function main(): Promise<number> {
  const contract = readContract(process.env);
  // The benchmark checks that each configured label reaches the agent's output.
  console.log(`model=${contract.model ?? "default"}`);
  const engine = path.resolve(import.meta.dir, "../..");
  if (!isReviewable(await Bun.file(contract.diff).text())) {
    console.log("adapter: nothing to review after the default exclusions");
    await writeOutput(
      contract.out,
      toFindingsFile({ head_sha: contract.head, findings: [] }, contract),
    );
    return 0;
  }
  const runDir =
    contract.runDir ??
    path.join(await mkdtemp(path.join(tmpdir(), "crysk-")), "run");
  const review = Bun.spawn(
    reviewArgv({
      bun: process.execPath,
      cli: path.join(engine, "src/cli.ts"),
      repo: contract.repo,
      contract,
      gotchas: path.join(import.meta.dir, "gotchas.md"),
      runDir,
    }),
    { cwd: engine, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const code = await review.exited;
  if (code !== 0) {
    console.error(`adapter: the review exited ${code}`);
    return code;
  }
  assertHuntersRan(await Bun.file(path.join(runDir, "pipeline.json")).json());
  const doc = (await Bun.file(
    path.join(runDir, "findings.json"),
  ).json()) as ReviewedDocument;
  const file = toFindingsFile(doc, contract);
  await writeOutput(contract.out, file);
  console.log(`adapter: wrote ${file.findings.length} finding(s)`);
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`adapter: ${String(error)}`);
      process.exit(1);
    },
  );
}
