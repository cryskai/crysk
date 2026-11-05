# Crysk as a ReviewBench reviewer: one fresh container per pull request.
# Build from the repository root:
#   docker build --platform linux/amd64 -f benchmarks/reviewbench/Dockerfile -t crysk-reviewbench .
#
# Credential, handed over at run time and never baked in:
#   CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)
# Egress: api.anthropic.com
# Configuration: RB_CONFIG_MODEL, a logical model such as sonnet or opus.
FROM oven/bun:1.4.4-debian

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates nodejs npm procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.318 \
    && npm cache clean --force \
    && git config --system --add safe.directory '*'

ENV RB_SESSIONS_DIR=/home/bun/.claude/projects
WORKDIR /engine
COPY package.json bun.lock tsconfig.json ./
COPY bin ./bin
COPY config ./config
COPY prompts ./prompts
COPY skills ./skills
COPY src ./src
COPY benchmarks/reviewbench ./benchmarks/reviewbench
RUN bun install --frozen-lockfile --production

ENTRYPOINT ["/engine/benchmarks/reviewbench/entrypoint.sh"]
