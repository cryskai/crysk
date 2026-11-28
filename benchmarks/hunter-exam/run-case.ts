// The hunter exam's impure half: build a case's repository, run ONE hunter on
// it with the request the local CLI sends, and hand its draft to the grader
// (src/compare/hunter-exam.ts).
//
// What "the request the local CLI sends" means here, and why each line is set:
//   - spec with one hunter and no refuter: one model call per run. No
//     summarizer, consolidation or materiality input is given, so none
//     of those stages spends anything.
//   - sharedPrefix true: the layout the CLI uses by default (patch and output
//     contract in the system prompt, the hunter's role file as the user
//     message). A lone hunter gets that layout without the warmup call.
//   - bundledAgents + the fallback profile when the prompt set is the bundled
//     one, so model and effort come from the profile as they do in a review; a
//     custom --agents directory routes by its own frontmatter, as it does there.
//   - no review instructions and no suspicion priors: either would tell the
//     hunter where to look, and the exam measures what it finds unaided.
//
// The answer key never enters the repository the hunter reads: the case
// directory holds `base/`, `head/` and `message.txt`; the key lives in
// bank.json, beside the cases, and the repository is rebuilt in a temp dir.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  type ExamBank,
  type ExamCase,
  type ExamFinding,
  type ExamReplicate,
  gradeRun,
  parseExamBank,
} from "#compare/hunter-exam";
import { resolveProfile } from "#model/profiles";
import { type PipelineInput, runPipeline } from "#review/pipeline";
import { localReviewSpec } from "#review/preflight";
import type { AgentSpec } from "#review/spec";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import { buildPipelineHarnessPlan } from "../../src/harness/pipeline-plan";
import { prepareHarnessRunner } from "../../src/harness/route-runner";
import { resolveRunClaudeCredential } from "../../src/security/claude-credential";

const ROOT = path.resolve(import.meta.dir, "..", "..");
export const EXAM_DIR = path.join(ROOT, "benchmarks", "hunter-exam");
export const BUNDLED_AGENTS_DIR = path.join(ROOT, "prompts", "default");
// The CLI's default (preflight.ts), stated here because a direct runPipeline
// caller has to give one.
const HOP_BUDGET = 12;
// Fixed so two renders of the same request hash the same. A live run leaves
// the nonce to the pipeline, as a review does.
const RENDER_NONCE = "0".repeat(32);

// Fixed identity and dates: the same case must build the same commits on any
// machine and on every run, or the request (which names both shas) would hash
// differently each time and nothing could be reused.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "exam",
  GIT_AUTHOR_EMAIL: "exam@example.invalid",
  GIT_COMMITTER_NAME: "exam",
  GIT_COMMITTER_EMAIL: "exam@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  // No background housekeeping. Committing a real project's tree writes
  // thousands of loose objects, which makes git start a detached `gc --auto`;
  // it keeps rewriting .git after the command returned, and removing the
  // checkout then races it ("Directory not empty", or a remove that stops
  // half-way).
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
};

export async function git(repoDir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoDir, ...args], {
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return stdout;
}

export interface MaterializedCase {
  // Everything but the repository is a sibling of it, so nothing the exam
  // writes can turn up in the hunter's own searches.
  tmp: string;
  repoDir: string;
  baseSha: string;
  headSha: string;
  diffPath: string;
}

// Where cases are looked for, in order:
//   1. this repository's `cases/`: one self-contained sample, enough for the
//      tests and for trying the exam out;
//   2. `<the exam's folder>/bank`, when it exists: a directory or a link to
//      wherever the real bank is kept;
//   3. CRYSK_CASEBANK_CASES (several paths, `:`-separated) or `--bank`.
// The bank itself is kept out of this repository on purpose. It is public,
// and a bank published with its answer keys ends up in training data; the
// cases worth having come from the pipeline's own misses, some of them on
// private repositories.
export function caseRoots(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const linked = path.join(examHome(env), "bank");
  return [
    path.join(EXAM_DIR, "cases"),
    ...(existsSync(linked) ? [linked] : []),
    ...(env.CRYSK_CASEBANK_CASES ?? "")
      .split(":")
      .filter((root) => root !== "")
      .map((root) => path.resolve(root)),
  ];
}

// The directory of a case: where it is, or, for a case that does not exist
// yet, where a new one belongs: the last root, so a new case goes to the
// bank that was pointed at and not into this repository.
export function caseDir(id: string): string {
  const roots = caseRoots();
  const found = roots.find((root) => existsSync(path.join(root, id)));
  return path.join(found ?? (roots.at(-1) as string), id);
}

// The bank is the threshold in bank.json plus one key.json per case
// directory. A key sits beside its case, so cases can be written in parallel
// without a shared file; it stays outside `base/` and `head/`, which are the
// only parts of a case directory copied into the repository a hunter reads.
export async function loadBank(): Promise<ExamBank> {
  const { threshold } = JSON.parse(
    await readFile(path.join(EXAM_DIR, "bank.json"), "utf8"),
  ) as { threshold: unknown };
  const cases = [];
  const seen = new Map<string, string>();
  for (const root of caseRoots()) {
    for (const id of (await readdir(root)).sort()) {
      const raw = await readFile(path.join(root, id, "key.json"), "utf8").catch(
        () => undefined,
      );
      // A directory without a key is a case still being written.
      if (raw === undefined) continue;
      const key = JSON.parse(raw) as { id?: unknown };
      if (key.id !== id) {
        throw new Error(`${root}/${id}/key.json names the case "${key.id}"`);
      }
      const earlier = seen.get(id);
      if (earlier !== undefined) {
        throw new Error(`case ${id} is in both ${earlier} and ${root}`);
      }
      seen.set(id, root);
      cases.push(key);
    }
  }
  return parseExamBank(JSON.stringify({ threshold, cases }));
}

// Everything the exam downloads, installs or writes on this machine lives
// under ONE folder, so it can be looked at and deleted in one place:
//   runs/     stored runs (paid for; reused while the request is unchanged)
//   reports/  one folder per invocation: report.json and each run's artifacts
//   repos/    mirrors of the real repositories some cases are built on
//   deps/     dependencies installed to run a case's proof
//   work/     checkouts in use; each is removed when its run ends
// The folder's name is deliberately plain: a hunter sees the path of the
// checkout it works in, and a path that says "exam" or "test" tells it that
// it is being examined.
export function examHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.resolve(
    env.CRYSK_CASEBANK_HOME ?? path.join(homedir(), ".crysk", "casebank"),
  );
}

// Removes a checkout. Through the system's rm, not the runtime's: racing
// git's background housekeeping (now switched off in GIT_ENV), the runtime's
// recursive remove stopped part-way with ENOENT, and with `force` it did so
// silently, leaving half a checkout behind for every case of one repository.
export async function removeTree(dir: string): Promise<void> {
  // A few tries: a git process that has just exited can still be finishing a
  // write under .git, and rm then reports "Directory not empty".
  let failure = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const proc = Bun.spawn(["rm", "-rf", dir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await proc.exited) === 0) return;
    failure = await new Response(proc.stderr).text();
    await Bun.sleep(250);
  }
  throw new Error(`could not remove ${dir}: ${failure}`);
}

// A checkout is removed when its run ends, but a run that is killed (a closed
// pipe, a timeout, Ctrl-C) cannot clean up after itself. Anything in work/
// older than this is such a leftover; younger ones may belong to a run in
// flight, so they are left alone.
const STALE_CHECKOUT_MS = 2 * 60 * 60 * 1000;

export async function sweepWork(
  workDir: string,
  now: number = Date.now(),
): Promise<number> {
  let removed = 0;
  for (const name of await readdir(workDir).catch(() => [] as string[])) {
    const entry = path.join(workDir, name);
    // Another invocation may remove its checkout between the listing and
    // this look: a vanished entry is simply not a leftover.
    const info = await stat(entry).catch(() => undefined);
    if (info === undefined) continue;
    const age = now - info.mtimeMs;
    if (age > STALE_CHECKOUT_MS) {
      await removeTree(entry);
      removed += 1;
    }
  }
  return removed;
}

export function examDirs(home: string = examHome()) {
  return {
    runs: path.join(home, "runs"),
    reports: path.join(home, "reports"),
    repos: path.join(home, "repos"),
    deps: path.join(home, "deps"),
    work: path.join(home, "work"),
  };
}

export interface CaseSource {
  // A git URL (or a local path) and the commit the case is built on.
  repo: string;
  commit: string;
  // Paths removed from the pinned tree before the base commit. A project's
  // changelog describes its fixes in words, so it goes: a hunter that reads
  // "no longer strips tags under --nowrite" there has been told the answer.
  drop?: string[];
}

// One clone per repository, however many cases use it and however many of
// them build at once.
const mirrors = new Map<string, Promise<string>>();

export async function mirrorOf(
  source: CaseSource,
  reposDir: string,
): Promise<string> {
  const name = createHash("sha256")
    .update(source.repo)
    .digest("hex")
    .slice(0, 16);
  const dir = path.join(reposDir, `${name}.git`);
  const has = () =>
    git(dir, ["cat-file", "-e", `${source.commit}^{commit}`]).then(
      () => true,
      () => false,
    );
  let ready = mirrors.get(dir);
  if (ready === undefined) {
    ready = (async () => {
      await mkdir(reposDir, { recursive: true });
      if (!(await Bun.file(path.join(dir, "HEAD")).exists())) {
        await git(reposDir, ["clone", "--quiet", "--bare", source.repo, dir]);
      }
      return dir;
    })();
    mirrors.set(dir, ready);
  }
  await ready;
  if (!(await has())) {
    // The mirror may predate the pinned commit: one fetch, then decide.
    await git(dir, [
      "fetch",
      "--quiet",
      "origin",
      "+refs/heads/*:refs/heads/*",
    ]).catch(() => undefined);
  }
  if (!(await has())) {
    throw new Error(`commit ${source.commit} is not in ${source.repo}`);
  }
  return dir;
}

// A case is one of two shapes.
//   Small and self-contained: `base/` is the whole tree before the change.
//   On a real repository: `source.json` pins a commit; its tree is exported
//   from a local mirror, WITHOUT its history, so no commit message of the
//   upstream project can tell a hunter what was fixed where. `base.patch`,
//   when present, is applied before the base commit: it removes what would
//   give the answer away, such as the test a fix came with.
// Then, for both: `head.patch` and the files under `head/` make the change
// under review; `deleted.txt` lists one removed path per line; `message.txt`
// is the head commit's message.
export async function materializeCase(
  dir: string,
  options: { reposDir?: string; workDir?: string } = {},
): Promise<MaterializedCase> {
  const workDir = options.workDir ?? examDirs().work;
  await mkdir(workDir, { recursive: true });
  const tmp = await mkdtemp(path.join(workDir, "c-"));
  try {
    return await buildCase(dir, tmp, options.reposDir ?? examDirs().repos);
  } catch (error) {
    // A case that cannot be built leaves nothing behind.
    await removeTree(tmp);
    throw error;
  }
}

async function buildCase(
  dir: string,
  tmp: string,
  reposDir: string,
): Promise<MaterializedCase> {
  const repoDir = path.join(tmp, "repo");
  await mkdir(repoDir);
  const exists = (name: string) => Bun.file(path.join(dir, name)).exists();
  const hasDir = (name: string) =>
    readdir(path.join(dir, name)).then(
      () => true,
      () => false,
    );
  const apply = async (name: string) => {
    if (await exists(name)) {
      await git(repoDir, [
        "apply",
        "--whitespace=nowarn",
        path.join(dir, name),
      ]);
    }
  };

  let drop: string[] = [];
  if (await exists("source.json")) {
    const source = JSON.parse(
      await readFile(path.join(dir, "source.json"), "utf8"),
    ) as CaseSource;
    drop = source.drop ?? [];
    const mirror = await mirrorOf(source, reposDir);
    const tar = path.join(tmp, "tree.tar");
    await git(mirror, ["archive", "--format=tar", "-o", tar, source.commit]);
    const untar = Bun.spawn(["tar", "-xf", tar, "-C", repoDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await untar.exited) !== 0) {
      throw new Error(`tar failed: ${await new Response(untar.stderr).text()}`);
    }
    await rm(tar);
  } else {
    await cp(path.join(dir, "base"), repoDir, { recursive: true });
  }
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await apply("base.patch");
  for (const dropped of drop) await removeTree(path.join(repoDir, dropped));
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "initial"]);
  const baseSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  await apply("head.patch");
  if (await hasDir("head")) {
    await cp(path.join(dir, "head"), repoDir, { recursive: true });
  }
  const deleted = await readFile(path.join(dir, "deleted.txt"), "utf8").catch(
    () => "",
  );
  for (const line of deleted.split("\n")) {
    if (line.trim() !== "") await rm(path.join(repoDir, line.trim()));
  }
  const message = await readFile(path.join(dir, "message.txt"), "utf8").catch(
    () => "update\n",
  );
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", message.trim()]);
  const headSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  const diffPath = path.join(tmp, "diff.patch");
  await writeFile(diffPath, await git(repoDir, ["diff", baseSha, headSha]));
  return { tmp, repoDir, baseSha, headSha, diffPath };
}

// Whether a source line is only a comment, by the file's language. Narrow on
// purpose: `#` opens a comment in Python and Ruby and a private field in
// TypeScript, and `*` continues a block comment in C-like files and unpacks
// arguments in Python.
function isCommentLine(file: string, line: string): boolean {
  const text = line.trim();
  if (/\.(py|rb|sh|ya?ml|toml)$/.test(file)) return text.startsWith("#");
  return /^(\/\/|\/\*|\*\/|\*(\s|$))/.test(text);
}

// Lines of a file as an editor numbers them: a final newline ends the last
// line, it does not start another.
function lineCount(text: string): number {
  if (text === "") return 0;
  const parts = text.split("\n").length;
  return text.endsWith("\n") ? parts - 1 : parts;
}

// The comment lines a diff removes, as `file` and the line's number in the
// old side. A comment that explains a defect, removed by the change under
// review, hands the answer to whoever reads the diff.
export function removedCommentLines(
  diff: string,
): Array<{ file: string; line: number }> {
  const found: Array<{ file: string; line: number }> = [];
  let file = "";
  let old = 0;
  // Lines still owed by the current hunk, from its header. Inside a hunk a
  // line is told apart by its first character alone: a removed `--count;`
  // reads `---count;` and a removed `-- a/x` reads `--- a/x`, and neither is
  // a file header.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) {
        if (isCommentLine(file, line.slice(1))) found.push({ file, line: old });
        old += 1;
        oldLeft -= 1;
      } else if (line.startsWith("+")) {
        newLeft -= 1;
      } else if (line.startsWith(" ") || line === "") {
        old += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      // "\ No newline at end of file" belongs to neither side.
      continue;
    }
    if (line.startsWith("--- a/")) file = line.slice(6);
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (hunk) {
      old = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return found;
}

// What a case must satisfy before a hunter is run on it. Returns the problems
// found, in words; an empty list means the case is fit to run.
export async function checkCase(examCase: ExamCase): Promise<string[]> {
  const dir = caseDir(examCase.id);
  const problems: string[] = [];
  const read = (name: string) =>
    readFile(path.join(dir, name), "utf8").catch(() => undefined);

  const message = await read("message.txt");
  if (message === undefined) {
    problems.push("no message.txt");
  } else if (
    // An introducing commit keeps its own subject, whatever it says: it was
    // written before anyone knew of the defect.
    examCase.origin !== "real-intro" &&
    /\b(fix|bug|revert|regress|issue|broken)|#\d/i.test(message)
  ) {
    problems.push(`message.txt hints at a defect: ${message.trim()}`);
  }
  if (examCase.origin !== "synthetic") {
    const proof = await read("proof.json");
    if (proof === undefined) {
      problems.push("no proof.json");
    } else {
      const parsed = JSON.parse(proof) as Record<string, unknown>;
      // Two kinds of evidence. A reverted fix is proven by its own test:
      // passes with the fix, fails without. An introducing commit is proven
      // by history: the lines a later fix changed were added by this commit.
      const byTest =
        parsed.at_pin === "pass" && parsed.with_head_patch === "fail";
      const byHistory =
        parsed.kind === "blame" &&
        typeof parsed.fix === "string" &&
        typeof parsed.intro === "string";
      if (examCase.origin === "real-fix" ? !byTest : !byHistory) {
        problems.push(
          examCase.origin === "real-fix"
            ? "proof.json does not record pass at the pin and fail with the change"
            : "proof.json does not record the fix and the introducing commit",
        );
      }
    }
  }
  // Nothing that describes one machine belongs in a public case.
  for (const name of await readdir(dir)) {
    const text = (await read(name)) ?? "";
    if (/\/Users\/|\/home\/[a-z]/.test(text)) {
      problems.push(`${name} carries an absolute path of this machine`);
    }
  }

  let built: MaterializedCase;
  try {
    built = await materializeCase(dir);
  } catch (error) {
    return [...problems, `does not build: ${(error as Error).message}`];
  }
  try {
    const diff = await readFile(built.diffPath, "utf8");
    if (diff.trim() === "") problems.push("the change under review is empty");
    const changed = new Set(
      diff
        .split("\n")
        .filter((line) => line.startsWith("+++ b/"))
        .map((line) => line.slice(6)),
    );
    for (const entry of [...examCase.must_find, ...examCase.must_not]) {
      for (const site of entry.sites) {
        const text = await readFile(
          path.join(built.repoDir, site.path),
          "utf8",
        ).catch(() => undefined);
        if (text === undefined) {
          problems.push(`${entry.id}: ${site.path} is not in the head tree`);
        } else if (site.end_line > lineCount(text)) {
          problems.push(
            `${entry.id}: ${site.path}:${site.end_line} is past the end of the file`,
          );
        }
      }
      // A planted defect nobody could reach from the change is a miss by
      // construction: at least one of its sites has to be in a changed file.
      if (
        examCase.must_find.includes(entry as never) &&
        !entry.sites.some((site) => changed.has(site.path))
      ) {
        problems.push(`${entry.id}: no site is in a file the change touches`);
      }
    }
    const removed = removedCommentLines(diff);
    if (removed.length > 0) {
      problems.push(
        `the change removes ${removed.length} comment line(s); move them to the base (case-from-fix.ts --move-comments)`,
      );
    }
  } finally {
    await removeTree(built.tmp);
  }
  return problems;
}

// `general` names a hunter of the local review spec; `key:file.md` names one
// that is not in the spec yet (a candidate under --agents). Either way the
// returned hunter carries no trigger: an exam run asked for this hunter, so it
// runs.
export function resolveHunter(arg: string): AgentSpec {
  const [key, file] = arg.split(":");
  if (file !== undefined) return { key: key ?? "", file, role: "hunter" };
  const known = localReviewSpec({}).agents.find(
    (a) => a.role === "hunter" && a.key === arg,
  );
  if (known === undefined) {
    throw new Error(
      `unknown hunter "${arg}": not in the local review spec; name a new one as key:file.md`,
    );
  }
  return { key: known.key, file: known.file, role: "hunter" };
}

async function examInput(
  built: MaterializedCase,
  hunter: AgentSpec,
  options: { agentsDir: string; runDir: string; boundaryNonce?: string },
): Promise<PipelineInput> {
  await mkdir(options.runDir, { recursive: true });
  // An empty registry: a case repository has no code index, and a review of an
  // unindexed repository gives its hunters Read, Grep and Glob only.
  const mcpConfigPath = path.join(options.runDir, "mcp.json");
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
  const bundled =
    path.resolve(options.agentsDir) === path.resolve(BUNDLED_AGENTS_DIR);
  return {
    pr: 0,
    baseSha: built.baseSha,
    headSha: built.headSha,
    worktree: built.repoDir,
    diffPath: built.diffPath,
    agentsDir: options.agentsDir,
    ...(bundled
      ? { bundledAgents: true, modelProfile: resolveProfile(undefined) }
      : {}),
    spec: { agents: [hunter] },
    runDir: options.runDir,
    outPath: path.join(options.runDir, "findings.json"),
    mcpConfigPath,
    hopBudget: HOP_BUDGET,
    parityTriggerPaths: [],
    suspicionPriors: [],
    sharedPrefix: true,
    ...(options.boundaryNonce !== undefined
      ? { boundaryNonce: options.boundaryNonce }
      : {}),
  };
}

const NO_USAGE = {
  wall_ms: 0,
  tokens_in: 0,
  tokens_out: 0,
  tokens_total: 0,
  cost_usd_est: 0,
};

// Records the one hunter step instead of spawning it: the request exactly as
// the pipeline assembled it, at no cost.
class RenderRunner implements StepRunner {
  recorded: StepSpec | undefined;
  system = "";

  async run(spec: StepSpec): Promise<StepResult> {
    this.recorded = spec;
    this.system = await readFile(spec.systemPromptPath, "utf8");
    return {
      name: spec.name,
      status: "ok",
      output: { findings: [] },
      usage: NO_USAGE,
      attempts: 1,
      stderrTail: "",
      resultText: "",
    };
  }
}

export interface RenderedRequest {
  // Identity of everything that decides a run's answer: the rendered system
  // prompt and user message, the tools, the model and effort, and the head
  // commit (the files the hunter can read beyond the patch). Two runs with the
  // same key asked the same question, so a stored answer can stand for both.
  key: string;
  model: string;
  effort: string;
  // Added plus removed lines of the change under review. A run's price
  // follows this far more than it follows the repository's size.
  changed_lines: number;
}

export async function renderRequest(
  dir: string,
  hunter: AgentSpec,
  agentsDir: string,
): Promise<RenderedRequest> {
  const built = await materializeCase(dir);
  try {
    const runDir = path.join(built.tmp, "run");
    const runner = new RenderRunner();
    await runPipeline(
      await examInput(built, hunter, {
        agentsDir,
        runDir,
        boundaryNonce: RENDER_NONCE,
      }),
      { runner },
    );
    const spec = runner.recorded;
    if (spec === undefined) {
      throw new Error(`hunter ${hunter.key} was never dispatched`);
    }
    const normalize = (text: string) =>
      text
        .split(built.tmp)
        .join("<TMP>")
        .split(path.resolve(agentsDir))
        .join("<AGENTS>");
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          normalize(runner.system),
          normalize(spec.prompt),
          spec.tools,
          spec.model,
          spec.effort,
          built.headSha,
        ]),
      )
      .digest("hex");
    const changed = (await readFile(built.diffPath, "utf8"))
      .split("\n")
      .filter((line) => /^[-+](?![-+]{2} )/.test(line)).length;
    return {
      key,
      model: spec.model,
      effort: spec.effort,
      changed_lines: changed,
    };
  } finally {
    await removeTree(built.tmp);
  }
}

// A run's price, read from the run's own pipeline.json. The notional cost
// comes first: under subscription auth the cash cost is zero, and a budget
// counted in cash would never stop anything.
export function stepCostUsd(pipeline: unknown, stepName: string): number {
  const steps = (pipeline as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return 0;
  const step = steps.find(
    (s) => (s as { name?: unknown })?.name === stepName,
  ) as { usage_v2?: { notionalCostUsd?: unknown; cashCostUsd?: unknown } };
  const usage = step?.usage_v2;
  for (const cost of [usage?.notionalCostUsd, usage?.cashCostUsd]) {
    if (typeof cost === "number" && cost > 0) return cost;
  }
  return 0;
}

// What one run leaves behind. `findings` is the hunter's whole draft, kept so
// a changed answer key can be re-graded without paying for the run again.
export interface RunRecord {
  status: "graded" | "infra_error";
  reason?: string;
  findings: Array<ExamFinding & Record<string, unknown>>;
  cost_usd: number;
  wall_ms: number;
  run_dir: string;
}

export function gradeRecord(
  examCase: ExamCase,
  record: RunRecord,
): ExamReplicate {
  return record.status === "graded"
    ? gradeRun(examCase, record.findings)
    : { status: "infra_error", reason: record.reason ?? "unknown" };
}

// One hunter, one case, one run. `runner` replaces the model for offline
// tests; without it the run is live and costs money. A run that delivered no
// draft is an infrastructure error with the transport's reason, never an
// empty draft: an empty draft is a hunter saying "nothing here".
export async function runHunterOnCase(
  dir: string,
  hunter: AgentSpec,
  options: { agentsDir: string; runDir: string; runner?: StepRunner },
): Promise<RunRecord> {
  const built = await materializeCase(dir);
  const started = performance.now();
  const infra = (reason: string, cost = 0): RunRecord => ({
    status: "infra_error",
    reason,
    findings: [],
    cost_usd: cost,
    wall_ms: Math.round(performance.now() - started),
    run_dir: options.runDir,
  });
  try {
    const input = await examInput(built, hunter, options);
    let result: Awaited<ReturnType<typeof runPipeline>>;
    try {
      if (options.runner !== undefined) {
        result = await runPipeline(input, { runner: options.runner });
      } else {
        const harness = await prepareHarnessRunner({
          workspaceRoot: built.repoDir,
          buildRoutePlan: () => buildPipelineHarnessPlan(input),
          claudeRun: resolveRunClaudeCredential({}),
        });
        try {
          result = await runPipeline(
            { ...input, routePlan: harness.plan },
            harness.deps,
          );
        } finally {
          await harness.dispose();
        }
      }
    } catch (error) {
      return infra(`pipeline threw: ${(error as Error).message}`);
    }
    const usage = result.perAgent[hunter.key];
    const cost = await readFile(
      path.join(options.runDir, "pipeline.json"),
      "utf8",
    )
      .then((raw) => stepCostUsd(JSON.parse(raw), `hunter-${hunter.key}`))
      .catch(() => 0);
    if (usage?.status !== "ok") {
      return infra(
        `hunter step ${usage?.status ?? "missing"}${usage?.detail ? `: ${usage.detail}` : ""}`,
        cost,
      );
    }
    const draftPath = path.join(
      options.runDir,
      "steps",
      `hunter-${hunter.key}.draft.json`,
    );
    const draft = await readFile(draftPath, "utf8")
      .then((raw) => JSON.parse(raw) as { findings?: unknown })
      .catch(() => undefined);
    if (draft === undefined || !Array.isArray(draft.findings)) {
      return infra(`no readable draft at ${draftPath}`, cost);
    }
    return {
      status: "graded",
      findings: draft.findings as RunRecord["findings"],
      cost_usd: cost,
      wall_ms: Math.round(performance.now() - started),
      run_dir: options.runDir,
    };
  } finally {
    await removeTree(built.tmp);
  }
}
