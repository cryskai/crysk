# ReviewBench

[ReviewBench](https://review-bench.ai) ([repo](https://github.com/review-bench/ReviewBench)) measures code reviewers on real pull requests: 25 in its test set, 219 in its full set. It answers how Crysk compares with Copilot, Greptile, Cursor, Codex, Qodo and others on the same pull requests.

This folder holds the image its [agent contract](https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md) asks for: one container reviews one pull request and writes `findings.json`.

## Reading the results

The golden set is mostly LLM-sourced, about half of it is Low severity, and top ranks post many comments per pull request. Read grounded recall, F1 by severity and comments per pull request, not the rank. The benchmark's own methodology says augmented recall should not be the only basis for ranking.

## What this measures

The engine's defaults, with two differences from a review on a pull request:

| Setting | Here | Why |
|---|---|---|
| Size gate | Off (`--force`) | A pull request the gate skips scores nothing. The product skips past 4000 lines or 150 files by default |
| Summary | Off (`--no-summary`) | It costs a step and adds no findings |

The container starts as root and drops to the `bun` user, because Claude CLI refuses `bypassPermissions` as root.

`materiality_gate` and `post_min_severity` are unset, as they are in the engine by default. Repositories that `crysk setup` configures get a posting floor, which this does not apply. CodeGraph is not in the image.

`RB_CONFIG_MODEL` overrides the model. Otherwise the engine's default routes run.

## Running it

From the repository root:

```bash
docker build --platform linux/amd64 -f benchmarks/reviewbench/Dockerfile -t crysk-reviewbench .
```

Then, from a clone of ReviewBench, with `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY` in the environment:

```bash
scripts/try-agent.sh crysk-reviewbench --pr 0 -e CLAUDE_CODE_OAUTH_TOKEN   # one pull request
scripts/try-agent.sh crysk-reviewbench -e CLAUDE_CODE_OAUTH_TOKEN          # the test set
npm run judge -- --candidate findings --provider <provider> --model <id> --output scoring/results.json
```

On your Claude subscription, with no token, run it natively instead. This is for private scoring: a leaderboard row needs the image and a final through their portal.

```bash
bun benchmarks/reviewbench/run-local.ts --reviewbench <clone> --out <dir outside this repo> --pr 0
bun benchmarks/reviewbench/run-local.ts --reviewbench <clone> --out <dir outside this repo> --all
```

It removes credentials from the environment, so a key left in your shell cannot bill per token. Your personal `~/.crysk/config.json` still applies, so check that it sets no routing, `materiality_gate` or size limits you did not mean to measure. The plan the engine prints shows them.

To score privately on another subscription, without touching this machine's login, use the image with that account's token. It stops at the first failure, which is usually the plan's quota, and running it again skips the pull requests already done:

```bash
CLAUDE_CODE_OAUTH_TOKEN=... benchmarks/reviewbench/run-image.sh <clone> <dir outside this repo> [index]
```

The token has to go through the image: natively on macOS the engine uses the Keychain's login and removes a token from the environment.

Both private runners set `RB_STRICT=1`, which fails a partial review instead of scoring it. Use a new output directory for each configuration: they skip a finished pull request by name, whatever configuration produced it.

Every review is a live run. The engine prints its estimate before it starts.

## Failures

A non-zero exit fails the pull request, and the benchmark retries it and then fails the whole run. So the adapter exits non-zero when no hunter completed, and exits zero with no findings only when a review ran or the diff has nothing left after the default exclusions. A partial review is accepted with a warning, because one hunter that always fails must not fail the run. With `RB_STRICT=1` it fails instead.

## Results

Run output goes to the lab, never here. See [`../README.md`](../README.md).
