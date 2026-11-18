---
name: crysk-pr
description: "Open or update a GitHub pull request with a structured title and reviewer-focused description, then automatically subscribe to the Crysk review via `crysk status --pr <n> --wait --json` and hand off to `crysk-loop` if findings are reported. Trigger: open a PR, create a PR, gh pr create, submit PR, push branch and open PR, ship PR, crear PR, abrir PR."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "1.0"
---

## Step 0 — Load the Live Playbook (Mandatory)

This skill is a dynamic loader so its instructions and CLI version always match the latest published Crysk release.

Before taking any action, run:

```bash
npx -y crysk@0.9.0 skills load crysk-pr
```

Follow the instructions printed to stdout verbatim.
