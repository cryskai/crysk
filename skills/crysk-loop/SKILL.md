---
name: crysk-loop
description: "Run the autonomous Crysk PR review loop end-to-end (review -> judge -> fix/reply -> wait -> recheck until done): triage Crysk findings posted as PR comments in their own thread with applied, dismissed, deferred, or misclassified plus reasoning, push verified fixes, and subscribe to re-reviews with `crysk status --pr <n> --wait --json` without stopping to ask the user. Trigger: Crysk (formerly pr-hero) finding comments on a PR you authored, crysk-loop, pr-hero-loop, closing the PR review loop, responding to automated code review, `<!-- crysk-finding` or legacy `<!-- pr-hero-finding` markers in a PR."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "1.8"
---

## Step 0 — Load the Live Playbook (Mandatory)

This skill is a loader: its triage rules and CLI flags always match the Crysk version that reviewed the pull request (the newest release when no version is set).

Before taking any action, run:

```bash
npx -y crysk@0.9.0 skills load crysk-loop
```

Follow the instructions printed to stdout verbatim. When those instructions need the isolated adjudicator prompt (`adjudicator.md`), load it via the `skills load crysk-loop adjudicator.md` command shown in the playbook.
