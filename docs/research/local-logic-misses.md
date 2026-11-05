# Why we miss bugs, and the `logic` hunter that came out of it

2026-09-17. Attribution of every golden missed by two same-day Martian Cal.com arms, then the hunter designed
against what the attribution found and the arms that measured it. Ledger entry with the numbers:
`benchmarks/martian/README.md` § Cal.com 10 arms of 2026-09-17.

## 1. The method (worth reusing: it costs nothing)

Two arms had already run on the ten Cal.com PRs, so the material was on disk: the goldens, the judge's
per-PR `false_negatives`, each run's `findings.json` (including `debug.refuted` and `debug.deduped`), the raw
per-hunter `*.draft.json`, and the PR diffs. For every missed golden we asked four questions, in this order:

1. **Where does the bug actually live?** Golden comments carry no line numbers, so the identifiers in the
   comment (`git grep` at the PR's `headSha`, then read the file at that commit) locate it.
2. **Was it visible?** Inside an added line, inside the same hunk but unchanged, elsewhere in the file, or in
   another file entirely (a caller or an implementation — blast radius).
3. **At which stage was it lost?** Never drafted; drafted then merged away by dedupe; drafted then refuted;
   survived but the judge did not match it; or drafted at the right place with the wrong mechanism.
4. **Was it in anyone's job description?** Compare the shape against each hunter prompt's stated scope.

The fourth question is the one that changes decisions, and the third is the one that stops you fixing the
wrong component.

## 2. What it found

28 distinct goldens missed by at least one arm; 50 golden×arm pairs.

| | |
|---|---|
| Inside the diff (added lines) | **26 of 28** |
| Never drafted by any hunter | **48 of 50 pairs (96%)** |
| Lost to dedupe | 0 |
| Lost to the refuter | 0 |
| Survived but the judge did not match it | 1 |
| Local-logic shape (operator, condition, comparison, unit, normalisation, wrong variable) | **20 of 28** |
| Cross-file contract | 3 |
| Inside some hunter's stated scope | 54% — and **7 of 8** High/Critical |
| Parity hunter fired | **0 of 20 runs** |

Three consequences, each of which killed a plan we had:

- **Detection is the bottleneck, not filtering.** Zero goldens were destroyed by dedupe or by the refuter, so
  tuning refuter precision or the merge logic cannot move this benchmark's recall. (Prior sessions had been
  burned the other way — `debug.deduped` mattering — which is exactly why it was checked first.)
- **Scope is mostly not the constraint.** Most misses, and nearly every severe one, sit inside a hunter's own
  mandate. `deep-review-resilience.md` even instructs a local-logic Pass 1 *and* "finding one strong defect
  does NOT end the hunt". The instruction existed and the bugs were still walked past.
- **A pre-filter cannot help recall here**, and blast radius addresses ~2 of 28 on this corpus. Both were on
  the roadmap as the obvious next moves; the data retired them.

### The failure mode, stated precisely

Hunters converge on **one narrative per region**. Of the 12 cases where a scout lead was genuinely delivered
into a hunter's prompt, 7 had that hunter drafting a *different real bug* in the same hunk. Two of the
clearest: the top-ranked window of PR 8330 and of PR 11059 were both delivered, and in both a real but
different defect in the same function was written up instead of the golden. Attention was in the right place.
Enumeration was not exhaustive.

One structural gap worth keeping separate from that: the parity hunter, which owns cross-implementer contract
drift, never fired on this corpus (its trigger paths are configured for another repository), and the one
clear blast-radius golden — an interface signature change left unapplied in **13 of 14** implementers — is
exactly its category.

## 3. The hunter that came out of it

`logic` — key and specialty `logic`, category 15, tools `Read, Grep, Glob`, same model route as the other
hunters. Its distinguishing feature is not a new category of knowledge; it is **dedication and enumeration**:

- Work hunk by hunk through the whole diff. For each hunk, apply *every* item of a fixed checklist to the
  added lines and record *every* defect. Finding one does not end the hunk; a big find elsewhere does not end
  the sweep.
- No expansion phase and no hop budget, so nothing competes with coverage.
- Everything else is the house contract: no self-filtering, consequence-if-true severity, the standard JSON
  output, and then dedupe → refuter → tier like any other hunter.

The checklist is **46 language-agnostic questions derived from CWE base/variant entries** (comparison and
equality, calculation and numeric conversion, control flow and branching, sequencing, exception and error
handling, input and state validation, variable initialisation, resource lifecycle). Each question describes
what correct code does, so a "no" on an added line is a defect.

### Two contamination lessons

The first version of this checklist was written by someone who had read the goldens, and it showed: several
items were golden shapes in general clothing, and the only golden that version found exclusively was one of
them. The second version was produced by a worker given **no examples at all** (our examples had been the
leak channel the time before) and only the public CWE catalog. It scored the same. That is the useful result:
**the gain came from the method, not from knowing the answers.**

The rule that follows: a checklist, catalog, or prior that will be evaluated on a benchmark must be authored
by someone blind to that benchmark, from an external source, and frozen before the first run.

### What it measured (means of 2 runs, 10 PRs, luna, no codegraph)

| arm | gold TP /41 | FP | H+C /19 | tokens |
|---|---|---|---|---|
| control (3 hunters) | 14.0 | 16 | 11.5 | 1.78M |
| + reliability twice (equal-effort control) | 15.0 | 23 | 11.5 | 2.47M |
| + `logic` (CWE checklist) | **19.0** | 21.5 | **14.0** | 2.63M |

The equal-effort arm is the one that matters: the same tokens spent on a second pass of an existing hunter
bought +1 gold TP and +7 false positives, while the same tokens spent on exhaustive enumeration bought +5
gold TPs at comparable precision. H+C was also the most stable of any arm (14 in both runs, against 12/11 for
the control).

**Not yet established:** whether this holds outside Cal.com. The method was designed from the attribution of
these same PRs, so a corpus that played no part in the design still owes the confirmation.

## 4. Open items this produced

- **Parity never fires outside its configured repo.** Cheaper than building a blast-radius stage: make the
  trigger recognise a changed interface/contract file.
- **The judge is a measurement instrument with its own noise.** One golden in this set was drafted by both
  hunters in both arms, corroborated by the refuter, matched at 0.75 in one arm and left unmatched in the
  other. When a decision hinges on one or two goldens, a human has to read those pairs.
- **The 1–14 taxonomy has no local-logic slot**, which is why category 15 exists now. The taxonomy was derived
  from one repository's audited history; a category that repository's reviewers never filed simply was not
  there, and hunters inherited that blind spot.
