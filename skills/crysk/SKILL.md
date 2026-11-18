---
name: crysk
description: "Trigger: use or configure Crysk locally — change the review model or backend per role (models, fallback models, OpenCode, DeepSeek, custom model), effort, credentials order, config.json keys, REVIEW.md / gotchas.md, .cryskignore, size gate, run a review, `crysk watch/gc`, `crysk doctor/config`. Not CI (crysk-ci-setup) and not answering findings (crysk-loop)."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "1.0"
---

## Step 0 — Load the Live Playbook (Mandatory)

This skill is a loader: its instructions and CLI version always match the Crysk version this repository's CI runs (the newest release when no version is set).

Before taking any action, run:

```bash
npx -y crysk@0.9.0 skills load crysk
```

Follow the instructions printed to stdout verbatim.
