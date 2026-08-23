# Independent verification — raw record

The 364 findings that had been challenged only by the session that wrote them
were re-issued to 26 separate agents. This directory is the unedited record of
that pass, so the result can be audited rather than taken on trust.

| File | What it is |
|---|---|
| `PROMPT.md` | The instruction every verifier received. It tells them to **refute**, to default to skepticism, and to answer in a fixed JSON shape. Read this first — the result is only as good as the prompt that produced it. |
| `verdicts.json` | All 364 verdicts as returned, sorted by finding ID. Each carries `verdict`, `corrected_severity`, `evidence` (the code the verifier actually read) and `note`. |

## Method

Each finding was extracted **without its `Re-verified` note**, so a verifier saw
only the original claim and its citations and could not be anchored by the
earlier conclusion. Batches of ≤14, `identity-and-session` first because it was
the weakest area. Every agent ran under the same read-only constraint as the
audits themselves: no file in the repository may be modified.

## Result

| Verdict | Count |
|---|---|
| `SURVIVES` | 265 |
| `SURVIVES_CORRECTED` | 89 |
| `REFUTED` | 10 |

Severity lowered on 79. Raised on none.

## Reading the verdicts

`evidence` is the load-bearing field. It quotes the code the verifier opened,
which is what makes a verdict checkable — a `SURVIVES` with thin evidence is
worth less than a `REFUTED` with a line number you can go read.

A `SURVIVES_CORRECTED` with `corrected_severity: null` is a **textual**
correction: the claim holds but something in how it was stated did not. Those
notes were applied to the finding without touching its severity.

Verdicts were written back into the reports by a script that annotates each
finding with an `Independently verified` line, rewrites `Severity` where it
changed, and sets `Status: REFUTED` on the ten that failed. Nothing was deleted
(`DEC-41`). If a report and this file ever disagree, this file is the record of
what the verifier actually said.
