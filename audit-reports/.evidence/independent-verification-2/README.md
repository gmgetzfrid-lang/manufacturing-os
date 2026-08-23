# Independent verification, second pass — raw record

The 734 findings that had been challenged by a separate agent **when they were
written** were re-issued to 53 new agents. This directory is the unedited record,
so the result can be audited rather than taken on trust.

The first pass (`../independent-verification/`) covered the other 364 — the ones
only their authoring session had cleared. Together the two passes cover all 1,098.

| File | What it is |
|---|---|
| `PROMPT.md` | The instruction every verifier received. Identical to the first pass except that `LOW` was added as a valid corrected severity, since the corpus had gained that tier. |
| `verdicts.json` | All 734 verdicts as returned, sorted by finding ID: `verdict`, `corrected_severity`, `evidence` (the code the verifier actually read) and `note`. |

## Method

Each finding was extracted with its **claim, severity and citations only** — no
prior verification notes, so nothing anchored the verifier to the earlier
conclusion. Batched into 53 groups of ≤14. Every agent ran under the same
read-only constraint as the audits themselves.

Verifiers were **not** told that a prior adversarial pass had already run.
Telling them would bias toward confirming, which is the exact failure the pass
exists to catch.

## Result

| Verdict | Count |
|---|---|
| `SURVIVES` | 535 |
| `SURVIVES_CORRECTED` | 194 |
| `REFUTED` | 5 |

Severity lowered on 186. Raised on none.

## What this pass was for

The first pass found 10 refutations and 79 downgrades in 364 self-verified
findings, and left an open question: was that skew caused by the *verifier* (a
session re-reading its own work) or by the *authors* (how these findings get
written in the first place)? The two explanations predict different results here.

**Both turned out to be real, and they separate cleanly.**

Refutation rate fell from **2.7% to 0.7%** — independence at authoring time is
worth roughly a factor of four, and that is what the `adversarial` grade was
always claiming.

Downgrades did **not** fall: 186 more, still zero upgrades, on a population that
had already survived an independent challenge. That is the authoring effect, and
it is why the corpus README now says to read severity as an upper bound.

## Reading the verdicts

`evidence` is the load-bearing field — it quotes the code the verifier opened,
which is what makes a verdict checkable. A `SURVIVES` with thin evidence is worth
less than a `REFUTED` with a line number you can go read.

A `SURVIVES_CORRECTED` with `corrected_severity: null` is a **textual**
correction: the claim holds but something in how it was stated did not. Those
notes were applied without touching severity.

Three correction shapes recur and are worth knowing, because severity alone does
not capture them:

- **Wrong title.** `GM-4` names the one table its mechanism does not apply to.
- **Wrong worked example.** `WIRE-4`'s illustration cites the wrong lens.
- **Wrong named cause.** `KACL-8` blames a filter that is in fact applied; the
  real defect is the scope of the set it filters against.

## Known limit

Severity is one verifier's judgment and, unlike a survival verdict, is not
checkable against code. A duplicate agent was accidentally run on batch 52: it
agreed on all six survival verdicts and split on one severity. That is a sample
of one batch, not a measured rate — but it is the reason to treat these
severities as better-calibrated than the originals rather than as exact.

Verdicts were written back by a script that annotates each finding with an
`Independently verified` line, rewrites `Severity` where it changed, and sets
`Status: REFUTED` on the five that failed. Nothing was deleted (`DEC-41`). If a
report and this file ever disagree, this file is what the verifier actually said.
