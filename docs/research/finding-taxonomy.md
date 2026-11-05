# How AI reviewers classify findings (research for #395, feeds #394)

Date: 2026-11-04. Read-only research. Every claim cites a URL, a file in
[withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark) (commit
`e616e84`), or a stored comment in its `offline/results/benchmark_data.json`, written
`<pr> → <tool> #n` (0-based index in `review_comments`; `<pr>` is
`keycloak/keycloak#37429` unless noted).

## 1. Martian's taxonomy is a list, not a rubric

- Severity `Low / Medium / High / Critical` and the ten categories `bug, security, concurrency, data,
  api, perf, test_gap, doc_defect, style, speculative` are **listed with no definitions**
  (`README.md:45`, `offline/README.md:33,288`, `offline/analysis/score_profiles.py:19-24`). The goldens
  inherit their labels from the Augment/Greptile dataset (`methodology/full.md:150`).
- Profiles filter **goldens by category only**: Strict = bug/security/concurrency/data/api (139), Core =
  Strict + perf/test_gap/doc_defect (158), All = + style/speculative (173). Severity never enters the
  score (`offline/README.md:47-53`, `step3_judge_comments.py:261-353`).
- Golden distribution (173): Critical 12 (7%), High 54 (31%), Medium 61 (35%), Low 46 (27%). `bug` is 94
  of 173 and appears at every level; style and perf appear only at Low.

So Martian **High is an ordinary bucket** (a third of real bugs), and Critical is rare. Today about two
thirds of pr-hero findings are BLOCKER or CRITICAL (ROADMAP Stage 2 item 2), so a 1:1 mapping would
show far more Critical+High than the goldens contain. §5 measures this pair by pair.

## 2. What the vendors do

| Tool | Severity levels | Categories | Severity drives a gate? | Confidence | Rendering |
|---|---|---|---|---|---|
| CodeRabbit | critical > major > minor > trivial (+ info) ([findings](https://docs.coderabbit.ai/change-stack/findings.md)) | 6: functional correctness, security & privacy, data integrity & integration, performance & scalability, stability & availability, maintainability ([findings](https://docs.coderabbit.ai/change-stack/findings.md)) | Only the "CodeRabbit Security" check, threshold configurable, **default Critical** ([check](https://docs.coderabbit.ai/security/pull-request-check.md)) | PR-level merge-readiness high/medium/low | `_⚠️ Potential issue_ \| _🟠 Major_` (`→ coderabbit #0`) |
| Greptile | P0 Critical, P1 High, P2 Medium ([first review](https://www.greptile.com/docs/code-review/first-pr-review.md)) | logic, syntax, style | No; `strictness` 1–3 filters what posts ([nitpickiness](https://www.greptile.com/docs/code-review/controlling-nitpickiness.md)) | PR-level Confidence Score 0–5 | `<img alt="P1">` badge + bold title (`→ greptile-v4-1 #0`) |
| Cursor Bugbot | High / Medium / Low (`→ bugbot #0`; [docs](https://cursor.com/docs/bugbot.md) show high/medium) | none | No; check is `neutral` unless "fail on unresolved" is on, then **all** severities block ([docs](https://cursor.com/docs/bugbot.md)) | PR-level risk | `### title` + `**High Severity**` |
| Copilot review | High / Medium / Low, since 2026-05-12 ([changelog](https://github.blog/changelog/2026-05-12-copilot-code-review-comment-experience-improvements)) | none | Never; posts a "Comment" review only ([docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review)) | none | label in comment corner |
| Qodo v2 | High / Medium / Low, renameable (critical/warning/informational, p0–p2) ([anatomy](https://docs.qodo.ai/code-review/get-started/use-qodo-in-prs/comment-anatomy.md)) | types (Bug, Rule violation, Requirement gap…) + impact (Correctness, Security, Reliability, Performance, Observability) | Routes comments inline/summary/drop by severity ([thresholds](https://docs.qodo.ai/code-review/get-started/use-qodo-in-prs/code-review/severity-thresholds.md)); no merge block found | none | `alt="Action required"` banner + `🐞 Bug` `✓ Correctness` chips (`→ qodo-extended #0`) |
| Qodo PR-Agent (OSS) | none in `/review` ([pr-agent](https://github.com/qodo-ai/pr-agent) `pr_reviewer_prompts.toml`) | `/improve` labels: security, possible bug, performance… | optional `merge_recommendation`, off by default | `/improve` score 0–10 | `Possible Issue` headers |
| Claude Code Review | Important / Nit / Pre-existing ([docs](https://code.claude.com/docs/en/code-review-pull-requests#severity-levels)) | none fixed | Check run **never fails**; teams parse `bughunter-severity` themselves | multi-agent vote, not exposed | 🔴 / 🟡 / 🟣 |
| Devin Review | Bugs Severe/Non-severe, Flags, Security Critical/Warning ([docs](https://docs.devin.ai/work-with-devin/devin-review.md)) | Bugs, Flags, Security; **security cites CWE** | Commit status passes on completion by default; configurable to threads-resolved or no-findings | "labelled by confidence" | `🔴 **title**` (`→ devin #0`) |
| Sourcery | none on PR comments ([anatomy](https://docs.sourcery.ai/reviews/anatomy-of-a-review)) | `issue (bug_risk)`, `suggestion (testing)`, `nitpick (typo)`… | Check fails only on blocking **security** findings | none | `**issue (bug_risk):**` (`→ sourcery #0`) |
| Augment | per-guideline high/medium/low ([guidelines](https://docs.augmentcode.com/codereview/review-guidelines.md)) | focus areas only | none documented | none | plain prose (`→ augment #0`) |
| Graphite Agent | none found ([comments](https://graphite.com/docs/ai-review-comments.md)) | logic bugs, edge cases, security, performance, accidentally committed code | none found | none | problem / why / fix |

Other tools in `benchmark_data.json`, labels as rendered: Gemini critical/high/medium (`→ gemini #0`),
cubic P0–P3 with a per-finding `confidence` 5–10 in an HTML comment (`→ cubic-dev #0`), macroscope
🔴 Critical / 🟠 High / 🟡 Medium / 🟢 Low (`→ macroscope #0`), propel Critical/Important/Recommended
with `[**Logic**]`-style categories (`→ propel-v2 #0`), baz `Finding type: Logical Bugs | Severity: 🔴
High` (`→ baz #0`), Kilo CRITICAL/WARNING/SUGGESTION, the same top names as pr-hero (`→ kg #0`).

## 3. Formal standards

| Standard | Levels | Who uses it among reviewers |
|---|---|---|
| CVSS v4 qualitative bands ([FIRST](https://www.first.org/cvss/v4.0/specification-document)) | None / Low / Medium / High / Critical over a 0–10 score | GitHub code scanning security severity ([docs](https://docs.github.com/en/code-security/concepts/code-scanning/code-scanning-alerts)); no AI reviewer |
| CWE ([MITRE](https://cwe.mitre.org/documents/cwe_usage/guidance.html)) | weakness ids, no severity | Devin security findings; pr-hero's logic hunter already cites CWE ids in its checklist (`prompts/default/deep-review-logic.md`) |
| IBM ODC v5.2 ([PDF](https://s3.us.cloud-object-storage.appdomain.cloud/res-files/70-ODC-5-2.pdf)) | defect *types* by fix (Assignment, Checking, Algorithm, Timing/Serialization, Interface…); severity is out of scope | none found |
| SonarQube ([rules](https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/managing-rules/rules.md)) | Blocker / High / Medium / Low / Info (legacy Blocker / Critical / Major / Minor / Info); Blocker = high impact **and** high likelihood, High = high impact only | none found |

## 4. Common practice vs vendor-specific

**Common practice**
- A per-finding severity of **three or four levels**, with words from Critical / High / Medium / Low.
  Three levels is the mode (Greptile, Bugbot, Copilot, Qodo, Gemini, baz); four appears in CodeRabbit,
  macroscope, cubic and Martian. Most four-level scales put a rare top tier above a common "fix it" tier.
- **Severity is a label, not the merge gate.** No reviewer studied blocks a merge on "High" by default.
  Where gating exists it is a **separate, configurable threshold** (CodeRabbit Security, default
  Critical; GitHub code scanning: Critical / High+ / Medium+ / All, admin's choice
  ([docs](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/set-merge-protection))),
  or it ignores severity entirely (Bugbot "fail on unresolved", Claude conversation resolution).
- Header shape: **colour emoji or badge + level word**, then an optional category chip, then the title.
- Confidence, when shown, is **PR-level** (Greptile 0–5, CodeRabbit merge readiness). Only cubic shows a
  per-finding number.

**Vendor-specific**
- Category sets: every vendor has its own (3 to 11 labels). **None emits Martian's ten categories**, and
  only Devin emits CWE. Martian's set is therefore a benchmark vocabulary, not an industry one.
- P0–P3 priority naming (Greptile, cubic); Important/Nit (Claude); conventional-comment prefixes (Sourcery).

## 5. Empirical check: our labels against Martian's goldens ($0)

Data: the judged Martian 50 `dev-default` arm (`benchmarks/martian/README.md:485`; lab
`bench/experiments/2026-10-25-martian-50-dev-default/`). Each of the **111 true positives** pairs one
golden (Martian severity and category) with one of our matched candidates. Each candidate was linked back
to its posted comment, which gives the badge severity and tier, and from there to the run's
`findings.json`, which gives the internal category. Most links (103) were made by word overlap with the
comment body, the rest (8) by `path:line`. In 4 pairs the two best-scoring comments carry different
severities, so up to 4 cells are uncertain. Limits: one run, n=111, and only 8 Critical goldens. The
golden labels have no rubric (§1) and come from five open-source repos, not from our domain.

**Severity**

| ours \ golden | Critical | High | Medium | Low | total |
|---|---|---|---|---|---|
| BLOCKER | 0 | 8 | 6 | 0 | 14 |
| CRITICAL | 4 | 25 | 14 | 4 | 47 |
| WARNING | 4 | 11 | 19 | 10 | 44 |
| SUGGESTION | 0 | 0 | 2 | 4 | 6 |
| golden total | 8 | 44 | 41 | 18 | 111 |

| Mapping | Exact | Within one level | Ours higher / lower | Mean distance |
|---|---|---|---|---|
| 1:1 (BLOCKER→Critical, CRITICAL→High, WARNING→Medium, SUGGESTION→Low) | 48 (43%) | 97 | 42 / 21 | 0.69 |
| BLOCKER and CRITICAL → High, no Critical | 56 (50%) | 103 | 34 / 21 | 0.57 |
| shifted down one level | 36 (32%) | 92 | 10 / 65 | 0.88 |

- **BLOCKER→Critical does not hold.** None of the 14 BLOCKER TPs matched a Critical golden: 8 were
  High and 6 Medium. The 8 Critical goldens we caught were labelled CRITICAL (4) and WARNING (4).
- **CRITICAL→High holds roughly:** 25 of 47 are High.
- **WARNING→Medium and SUGGESTION→Low hold best,** but WARNING spreads across all four golden levels.
- We rate higher than the goldens twice as often as lower (42 vs 21). This agrees with the roadmap's "two
  thirds critical" observation, measured here against an outside label.
- **Tier against golden severity:** 34 of the 52 High+Critical TPs were posted blocking and 18 advisory.
  Of the 59 Medium+Low TPs, 22 were posted blocking.

**Category**

| ours \ golden | bug | api | concurrency | data | security | doc_defect | other | total |
|---|---|---|---|---|---|---|---|---|
| 1 stale state | 4 | 0 | 1 | 0 | 0 | 0 | 0 | 5 |
| 2 async race | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |
| 3 fail-open | 11 | 0 | 1 | 2 | 2 | 0 | 0 | 16 |
| 5 non-unique key | 5 | 0 | 0 | 1 | 0 | 1 | 0 | 7 |
| 6 retry / lock | 11 | 3 | 3 | 1 | 0 | 0 | 2 | 20 |
| 7 CI guard | 3 | 1 | 0 | 0 | 0 | 0 | 0 | 4 |
| 10 lifecycle | 2 | 1 | 1 | 0 | 0 | 0 | 2 | 6 |
| 11 test isolation | 2 | 0 | 1 | 0 | 0 | 2 | 3 | 8 |
| 12 contract mismatch | 8 | 4 | 1 | 1 | 0 | 2 | 1 | 17 |
| 15 local logic | 19 | 2 | 2 | 0 | 2 | 0 | 2 | 27 |

- **A fixed 15→10 table agrees with the golden on 50 of 111 (45%). Labelling every finding `bug` agrees
  on 65 (59%).** The table does worse than having no table at all.
- The cause is that the internal category records **which hunter's lens found the defect, not what kind
  of defect it is**. Hunters file into the categories they own. For example, category 6 (retry/lock,
  resilience hunter) is a plain `bug` for 11 of its 20 TPs.
- Of the three lossy rows guessed in the first draft:
  - Row 3 does split (bug 11, security 2, data 2).
  - Row 1 is mostly `bug`.
  - Row 13 never occurred.
  - Categories 4, 8, 9, 13 and 14 produced no TP at all, so their table rows are untested.

## 6. Recommendation for #394

> **Outcome (2026-11-04):** #394 was closed as not planned. The refactor carries cost and risk (a
> coordinated schema bump with the lab, dual-read of posted comments, and changes to the store, MCP and
> triage) and gains no score. The labels stay `BLOCKER / CRITICAL / WARNING / SUGGESTION`. What follows
> is the analysis as it stood before the decision, kept for reference. It is not live guidance.

**Severity: do not adopt the 1:1 mapping as is.**

- Of the three mappings tried, BLOCKER and CRITICAL → High with no Critical is closest to the goldens
  (50% exact, mean distance 0.57). It also matches the common three-level practice (§4).
- Its cost: Critical exists in Martian's scale and pr-hero would never emit it. With 8 Critical goldens,
  the data cannot say which of our findings deserve Critical.
- So any static mapping is weak (43–50% exact). The real fix is in the prompts: a rubric written against
  the standard levels (stage 2), measured as its own arm.
- If stage 1 ships a mapping, label it as derived and disclose the agreement figure.

The gate question from the first draft still stands. No vendor blocks on High by default (§4), and
pr-hero's gate reads **tier**, not the label:
- `deriveTier` (`src/review/findings.ts:621`) derives the tier from severity plus evidence class, causal
  disposition and refuter verdict.
- The badge already shows `blocking|advisory` next to the severity (`src/review/report.ts:1386`).
- How strict the gate is belongs to configurable strictness (Stage 2 item 5), not to #394.

**Category: do not derive it from the internal category.** Stage 1 should not ship a 15→10 table:
the data shows it is worse than a constant. The options are:
- skip categories in stage 1 and go straight to stage 2 (hunters emit the standard category, measured as
  a Martian arm), or
- classify each finding's claim directly at render time. That is an extra model call per finding.

`perf` and `speculative` still have no internal source. The taxonomy came from one repository's history,
the same blind spot that category 15 filled (`docs/research/local-logic-misses.md`).

**Validation for whatever ships:** rerun this cross-tab on the new arm's judged TPs. The bar is to beat
the numbers above: 50% exact for severity, and the 59% always-`bug` baseline for category.

**Constraints to carry into the design**
- The findings schema is shared with the lab (AGENTS.md rule 5). A new field (`standard_severity`,
  `standard_category`, or a pure render-time derivation with no stored field) is a coordinated decision.
- Posted comments are parsed back (`src/review/report.ts:1386` matches `BLOCKER|CRITICAL|WARNING|SUGGESTION`
  literally), so a rendering change needs dual-read of old comments.
- `post_min_severity` values (`blocking`, `warning`, `suggestion`) are a published config contract and do
  not need to change in stage 1.

## 7. Not found

- Any Martian rubric defining a severity level or a category.
- Greptile's status-check pass/fail semantics; Bugbot's full documented severity enum; a live Copilot
  inline comment; any Qodo v2 merge-block feature; Augment's and Graphite's rendered severity.
