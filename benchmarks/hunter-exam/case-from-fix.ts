// Turns a real fix commit into the files of an exam case: the fix, reverted.
//
//   bun run benchmarks/hunter-exam/case-from-fix.ts --id <case-id> \
//     --repo <git url> --pin <commit> --fix <commit> \
//     --src <path,path>  --drop <path,path>
//
//   --pin   the commit the case is built on (the fix must already be in it).
//   --carrier <commit>  instead of --pin: a real, larger commit of the same
//           repository to hide the reverted fix in. The case is pinned to the
//           carrier's parent, and the change under review becomes the
//           carrier's whole change with the fix's source change reverted
//           inside it. A reverted fix alone is a diff of a few lines that
//           consists of the defect; inside a carrier a reviewer has a real
//           change to read. The carrier's subject becomes message.txt.
//   --intro <commit>  instead of --pin and --carrier: the commit that
//           INTRODUCED the defect the fix later repaired. The case is pinned
//           to its parent and the change under review is that commit as it
//           was, nothing reverted: the defect is part of the change's own
//           logic. --src and --drop are not used; --fix is recorded.
//   --omit  paths removed from the tree altogether (the changelog): written
//           to source.json as `drop`, and left out of the carrier's change.
//   --src   the source files of the fix. Their change is reverted: head.patch.
//   --drop  what would give the answer away: the tests the fix came with, the
//           changelog line that describes it. Their change is reverted before
//           the base commit: base.patch.
//
// Writes cases/<id>/source.json, head.patch and base.patch, and prints the
// lines head.patch touches in the head tree, to place the answer key's sites.
// It does not write the key, the commit message or the proof: those are the
// case author's judgement. Everything it downloads goes under the exam's one
// folder (the mirror), and its scratch checkout is removed when it ends.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  caseDir,
  examDirs,
  git,
  materializeCase,
  mirrorOf,
  removedCommentLines,
  removeTree,
  sweepWork,
} from "./run-case";

const argv = Bun.argv.slice(2);
// --bank <dir>: where the case is written (and looked for). Without it a new
// case goes to the bank linked in the exam's folder, or into this repository
// when there is none.
if (argv.includes("--bank")) {
  const bank = argv[argv.indexOf("--bank") + 1];
  // No operand would resolve to the current directory, and a case's patches
  // would be written wherever the command happened to run.
  if (bank === undefined || bank.startsWith("--")) {
    console.error("--bank needs a directory");
    process.exit(64);
  }
  process.env.CRYSK_CASEBANK_CASES = path.resolve(bank);
}
function value(name: string): string {
  const index = argv.indexOf(name);
  const found = index === -1 ? undefined : argv[index + 1];
  if (found === undefined) {
    console.error(`missing ${name}`);
    process.exit(64);
  }
  return found;
}
const paths = (name: string) =>
  argv.includes(name)
    ? value(name)
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "")
    : [];

const id = value("--id");

// --move-comments --id <id>: rewrite an existing case so that comment lines
// its change removes are already gone in the base. A fix often comes with a
// comment that explains the defect; reverted, that comment shows up in the
// diff as a removed line and gives the answer away. The head tree does not
// change, so the answer key's line numbers stay valid.
if (argv.includes("--move-comments")) {
  const dir = caseDir(id);
  const built = await materializeCase(dir);
  try {
    const repo = built.repoDir;
    const lines = removedCommentLines(await readFile(built.diffPath, "utf8"));
    if (lines.length === 0) throw new Error("no removed comment lines");
    // The new base: the old one without those comment lines, as a commit.
    await git(repo, ["checkout", "-q", built.baseSha]);
    for (const file of new Set(lines.map((l) => l.file))) {
      const drop = new Set(
        lines.filter((l) => l.file === file).map((l) => l.line),
      );
      const kept = (await readFile(path.join(repo, file), "utf8"))
        .split("\n")
        .filter((_, index) => !drop.has(index + 1));
      await writeFile(path.join(repo, file), kept.join("\n"));
    }
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "base without the comments"]);
    const newBase = (await git(repo, ["rev-parse", "HEAD"])).trim();
    // The head tree is untouched: the change under review is the difference
    // between the two commits, whatever files it spans. (The first version
    // rebuilt the head from the files that had comments only, and silently
    // dropped the rest of the change.)
    const newHead = await git(repo, [
      "diff",
      "--binary",
      newBase,
      built.headSha,
    ]);

    // base.patch is written against the pinned tree, which the built
    // repository no longer holds: export it again and diff from there.
    const sourceRaw = await readFile(
      path.join(dir, "source.json"),
      "utf8",
    ).catch(() => undefined);
    if (sourceRaw === undefined) {
      throw new Error(
        "only a case with source.json has a base.patch to rewrite",
      );
    }
    const pinned = JSON.parse(sourceRaw) as {
      repo: string;
      commit: string;
      drop?: string[];
    };
    const pinRepo = path.join(built.tmp, "pin");
    await mkdir(pinRepo);
    const tar = path.join(built.tmp, "pin.tar");
    await git(await mirrorOf(pinned, examDirs().repos), [
      "archive",
      "--format=tar",
      "-o",
      tar,
      pinned.commit,
    ]);
    const untar = Bun.spawn(["tar", "-xf", tar, "-C", pinRepo]);
    if ((await untar.exited) !== 0) throw new Error("tar failed");
    for (const dropped of pinned.drop ?? []) {
      await removeTree(path.join(pinRepo, dropped));
    }
    await git(pinRepo, ["init", "-q", "-b", "main"]);
    await git(pinRepo, ["add", "-A"]);
    await git(pinRepo, ["commit", "-q", "-m", "pinned"]);
    await git(repo, ["fetch", "-q", pinRepo, "main"]);
    // Dropped paths are absent on both sides, so the patch never names them.
    await git(repo, ["checkout", "-q", newBase]);
    for (const dropped of pinned.drop ?? []) {
      await removeTree(path.join(repo, dropped));
    }
    await writeFile(
      path.join(dir, "base.patch"),
      await git(repo, ["diff", "--binary", "FETCH_HEAD", newBase]),
    );
    await writeFile(path.join(dir, "head.patch"), newHead);
    console.log(`${id}: moved ${lines.length} comment line(s) to the base`);
  } catch (error) {
    console.error(`${id}: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    // Not process.exit() inside the try: it would skip this and leave the
    // checkout behind.
    await removeTree(built.tmp);
  }
  process.exit();
}

const intro = argv.includes("--intro") ? value("--intro") : undefined;
const carrier =
  intro ?? (argv.includes("--carrier") ? value("--carrier") : undefined);
const repo = value("--repo");
const fix = value("--fix");
const src = paths("--src");
const drop = paths("--drop");
const omit = paths("--omit");
if (src.length === 0 && intro === undefined) {
  console.error("--src needs at least one path");
  process.exit(64);
}

const dirs = examDirs();
await sweepWork(dirs.work);
const mirror = await mirrorOf(
  { repo, commit: carrier ?? value("--pin") },
  dirs.repos,
);
const source = {
  repo,
  commit:
    carrier === undefined
      ? value("--pin")
      : (await git(mirror, ["rev-parse", `${carrier}^`])).trim(),
};
await mkdir(dirs.work, { recursive: true });
const tmp = await mkdtemp(path.join(dirs.work, "c-"));
try {
  const tree = path.join(tmp, "repo");
  await mkdir(tree);
  const tar = path.join(tmp, "tree.tar");
  await git(mirror, ["archive", "--format=tar", "-o", tar, source.commit]);
  const untar = Bun.spawn(["tar", "-xf", tar, "-C", tree]);
  if ((await untar.exited) !== 0) throw new Error("tar failed");
  for (const omitted of omit) await removeTree(path.join(tree, omitted));
  await git(tree, ["init", "-q", "-b", "main"]);
  await git(tree, ["add", "-A"]);
  await git(tree, ["commit", "-q", "-m", "pinned"]);

  // git first, patch(1) second: git applies a patch only when its context
  // still matches exactly, patch(1) tolerates context that moved.
  const applyPatch = async (
    patchFile: string,
    reverse: boolean,
  ): Promise<boolean> => {
    try {
      await git(tree, [
        "apply",
        ...(reverse ? ["-R"] : []),
        "--whitespace=nowarn",
        patchFile,
      ]);
      return true;
    } catch {
      const loose = Bun.spawn(
        [
          "patch",
          ...(reverse ? ["-R"] : []),
          "-p1",
          "-s",
          "-F3",
          "-i",
          patchFile,
        ],
        { cwd: tree, stdout: "pipe", stderr: "pipe" },
      );
      if ((await loose.exited) !== 0) throw new Error("does not apply");
      return false;
    }
  };

  // Reverse the fix's change to `files` in the tree and return that as a
  // patch against the tree as it stands. One file at a time: git applies a
  // patch only when its context still matches exactly, and a changelog keeps
  // moving after a fix lands, so a file git refuses gets a second try with
  // patch(1), which tolerates shifted context.
  const revert = async (files: string[]): Promise<string> => {
    for (const file of files) {
      const forward = path.join(tmp, "forward.patch");
      await writeFile(
        forward,
        await git(mirror, ["show", "--format=", fix, "--", file]),
      );
      const exact = await applyPatch(forward, true).catch(() => {
        throw new Error(
          `the fix's change to ${file} cannot be reverted here; ` +
            "leave it out and edit the case's patch by hand",
        );
      });
      if (!exact) {
        console.log(`  ${file}: reverted with shifted context, check it`);
      }
    }
    // patch(1) leaves backups beside the files it touches.
    const strays = (await git(tree, ["status", "--porcelain"]))
      .split("\n")
      .filter((line) => /\.(orig|rej)$/.test(line))
      .map((line) => line.slice(3));
    for (const stray of strays) await rm(path.join(tree, stray));
    const patch = await git(tree, ["diff"]);
    await git(tree, ["add", "-A"]);
    await git(tree, ["commit", "-q", "-m", "step"]);
    return patch;
  };

  // Nothing is written until every step has worked: a revert that fails
  // half-way must not leave a new source.json beside the patches of the case
  // it was meant to replace.
  const basePatch = drop.length > 0 ? await revert(drop) : undefined;
  const baseSha = (await git(tree, ["rev-parse", "HEAD"])).trim();
  let message: string | undefined;
  if (carrier !== undefined) {
    const whole = path.join(tmp, "carrier.patch");
    await writeFile(
      whole,
      await git(mirror, [
        "show",
        "--format=",
        "--binary",
        carrier,
        "--",
        ".",
        ...omit.map((omitted) => `:(exclude)${omitted}`),
      ]),
    );
    const exact = await applyPatch(whole, false).catch(() => {
      throw new Error(
        "the carrier's change does not apply on the base; it probably " +
          "touches a test this case removes: choose another carrier",
      );
    });
    if (!exact) {
      // A carrier has to apply exactly: with shifted context patch(1) may put
      // a hunk in the wrong place, and it leaves backup files that would end
      // up in the change under review.
      throw new Error(
        "the carrier's change applies only with shifted context; choose " +
          "another carrier",
      );
    }
    await git(tree, ["add", "-A"]);
    await git(tree, ["commit", "-q", "-m", "carrier"]);
    const subject = (await git(mirror, ["show", "-s", "--format=%s", carrier]))
      .trim()
      .replace(/\s*\(#\d+\)$/, "");
    message = `${subject}\n`;
  }
  // The fix's own revert, as it lands in the head tree: where the key's
  // sites go. With a carrier, head.patch holds much more than this.
  const reverted = intro === undefined ? await revert(src) : "";
  const headPatch = await git(tree, ["diff", "--binary", baseSha, "HEAD"]);

  const out = caseDir(id);
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, "source.json"),
    `${JSON.stringify(
      {
        ...source,
        fix,
        ...(intro !== undefined
          ? { intro }
          : carrier !== undefined
            ? { carrier }
            : {}),
        ...(omit.length > 0 ? { drop: omit } : {}),
      },
      null,
      2,
    )}\n`,
  );
  // A base.patch this run did not produce is left alone and named: it may
  // be one the author wrote by hand, which this tool itself asks for when a
  // file cannot be reverted, and it cannot be regenerated.
  if (basePatch !== undefined) {
    await writeFile(path.join(out, "base.patch"), basePatch);
  } else if (await Bun.file(path.join(out, "base.patch")).exists()) {
    console.log(
      "  kept the existing base.patch (this run wrote none): check it still belongs to this case",
    );
  }
  if (message !== undefined) {
    await writeFile(path.join(out, "message.txt"), message);
  }
  await writeFile(path.join(out, "head.patch"), headPatch);
  console.log(`wrote ${out}`);
  console.log("the reverted fix, as line ranges in the head tree:");
  let file = "";
  for (const line of reverted.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunk) {
      const start = Number(hunk[1]);
      const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
      console.log(
        `  ${file}:${start}-${start + Math.max(length, 1) - 1}${hunk[3]}`,
      );
    }
  }
} finally {
  await removeTree(tmp);
}
