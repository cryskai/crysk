---
name: crysk-ci-setup
description: "Trigger: setup CI, add Crysk to CI, GitHub Actions review, CRYSK_* secrets, crysk-secrets, CRYSK_MODELS, models per role in CI, OpenCode, DeepSeek, CRYSK-INPUT-REMOVED, old OPENCODE_AUTH_JSON / CRYSK_ROUTING workflows, admission policy, configure CI workflow, retrigger, force review, skipped review, /crysk review, /crysk override, pr-hero-force, too many findings, noisy review, post_min_severity, materiality_gate. Scaffolds the one workflow, secrets, models variables, admission config, and the posting and noise settings."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "4.0"
---

## Step 0 — Load the Live Playbook (Mandatory)

This skill is a loader: its CI workflow templates, admission rules, and CLI version always match the Crysk version this repository's CI runs (the newest release when no version is set).

Before taking any action, run:

```bash
npx -y crysk@0.9.0 skills load crysk-ci-setup
```

Follow the instructions printed to stdout verbatim. Load any referenced companion file (`references/opencode-ci.md`, `references/ci-admission.md`, `assets/workflow.yml`, `assets/admission-config.example.json`) on demand with `npx -y crysk@0.9.0 skills load crysk-ci-setup <file>`.
