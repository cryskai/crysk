#!/bin/sh
# Claude CLI refuses --permission-mode bypassPermissions as root, and the engine
# runs it that way. So a root container drops to the image's own user.
#
# Permissions are opened instead of changing owners, and files are created open,
# because the benchmark's host still has to read and remove what is mounted.
set -eu

adapter=/engine/benchmarks/reviewbench/adapter.ts

if [ "$(id -u)" != 0 ]; then
  exec bun run "$adapter"
fi

chmod -R a+rwX /work/out
# The review only reads the repository. Git's object files can refuse this on a
# shared mount, and they are readable already.
chmod -R a+rX /work/repo 2>/dev/null || true
umask 000
export HOME=/home/bun
exec setpriv --reuid=bun --regid=bun --init-groups bun run "$adapter"
