# Evidence & regeneration inputs

Raw inputs behind the generated audit reports. Not reading material — the
reports in `../<area>/` are the deliverable. This folder exists so a report can
be **repaired or regenerated** without re-running the agents that produced it.

## Why this exists

The session container is ephemeral. It was reclaimed once mid-engagement, which
destroyed the scratchpad and the workflow journals for five of the nine audit
areas. Two reports have since needed repair from their journal — one shipped as a
duplicate of another lens's output, one shipped with an incorrect verification
banner. Both were fixable **only** because that run's journal still existed.

For the five areas whose journals were lost, the committed markdown is now the
only record. That is survivable — the reports are the deliverable and they are
complete — but a defect of the kind found in the four-area run could not be
repaired the same way. Hence this folder.

## Contents

| File | What it is |
|---|---|
| `wf_ab0ad337-e2f.journal.jsonl.gz` | Workflow journal for the 47-agent four-area run — document control, projects & cost, admin & org, public surfaces. One JSON object per line; `type: "result"` lines carry each agent's structured return value. |
| `generate-four-areas.py` | The script that turned that journal into the four areas' markdown. Matches verdict batches to audit lenses, drops refuted findings, applies verifier severity corrections, emits the reports with substrate tables and dedup cross-links. |

## Regenerating

`generate-four-areas.py` reads the journal from the session path it was written
against. To run it from this folder, point `WF` at the decompressed journal:

```sh
gunzip -c audit-reports/.evidence/wf_ab0ad337-e2f.journal.jsonl.gz > /tmp/journal.jsonl
# edit WF at the top of the script to /tmp/journal.jsonl, then:
python3 audit-reports/.evidence/generate-four-areas.py
node audit-reports/build-index.mjs
```

It rewrites the four areas' report markdown in place and prints per-area counts.
It touches nothing outside `audit-reports/`.

**Two defects in this script have been fixed and are worth knowing about**, because
both produced plausible, wrong output that shipped:

1. **Lens selection was a substring match.** The completeness critic's fragment
   `"critic"` matched the *scheduling* lens first, because that lens's name
   contains `"critical path"`. The critic's report shipped as a duplicate of the
   scheduling report under different ids, with fabricated cross-links, and the
   critic's real findings never shipped. Fixed by preferring an exact name match
   before falling back to substring.
2. **The verdict-batch fuzzy-match threshold was too strict** at `0.5`. One
   verifier reworded finding titles more aggressively than the others and its
   batch scored `0.47`, so its corrections were never applied and its report
   carried an "unverified" banner it had not earned. Lowered to `0.40` after
   checking that batch by hand.

If you regenerate and a report suddenly carries an unverified banner or looks
like a copy of a different report, it is one of these two failure modes
returning. Check the lens match before believing the output.

## Not here

Per-agent transcripts (`agent-*.jsonl`, ~27 MB for this run) are not committed.
The journal carries every agent's *return value*, which is what regeneration
needs; the transcripts carry their reasoning, which nothing reads.
