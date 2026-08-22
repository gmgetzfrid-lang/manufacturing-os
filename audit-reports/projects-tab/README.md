# Project Controls Audit — 2026-08-21

Read-only audit of the Projects tabs and everything the Project Controls
program touches: the money ledger, the PSSR / turnover / closeout surfaces, the
schedule engine, the contractor intake door, the bid tabulation, and the Known
Companies registry.

**No code was modified during this audit.** The working tree was verified clean
before and after.

---

## Scope

| | |
|---|---|
| **Commit** | `6a14d7d` (PR #181, squash-merged to master) |
| **Migration** | `supabase/migrations/20261013_project_controls_program.sql` — may not be applied in production; several findings turn on that |
| **Method** | 12 independent parallel review passes, then first-hand verification of every `CRITICAL` and `HIGH` claim by re-reading the cited code |
| **Surface** | `app/(protected)/projects/**`, `app/(protected)/companies/**`, `components/projects/**`, `app/api/{projects,companies,intake}/**`, `app/submit/[token]/**`, 15 new libraries, migration `20261013` |

## Totals

| Severity | Count |
|---|---|
| CRITICAL | 29 |
| HIGH | 72 |
| MEDIUM | 32 |
| **Total** | **133** |

Counts are generated from the reports by
[`../build-index.mjs`](../build-index.mjs) — see
[`findings.json`](./findings.json) for this area's machine-readable index (it
covers **this area only** — audit areas are never mixed).

---

## Reports

Work these in order. The numbering reflects priority, not just grouping —
`01` and `02` contain the findings that can hurt someone.

| # | Report | Findings | CRIT | Progress |
|---|---|---|---|---|
| 01 | [Security & access](./01-security-access.md) | 17 | 4 | 0 / 17 |
| 02 | [Safety, compliance & the record](./02-safety-compliance.md) | 17 | 6 | 0 / 17 |
| 03 | [Money & the ledger](./03-money-ledger.md) | 12 | 2 | 0 / 12 |
| 04 | [Bid tabulation & the award decision](./04-bid-tabulation.md) | 12 | 4 | 0 / 12 |
| 05 | [Charts & the printed RFQ](./05-charts-and-rfq.md) | 7 | 0 | 0 / 7 |
| 06 | [Schedule engine](./06-schedule-engine.md) | 18 | 7 | 0 / 18 |
| 07 | [Truth in the interface](./07-interface-truth.md) | 15 | 1 | 0 / 15 |
| 08 | [Reliability & failure modes](./08-reliability.md) | 11 | 0 | 0 / 11 |
| 09 | [Performance & scale](./09-performance-scale.md) | 11 | 2 | 0 / 11 |
| 10 | [Accessibility, mobile & dark mode](./10-accessibility-mobile.md) | 13 | 3 | 0 / 13 |
| — | [Upload door — recommended controls](./11-upload-door-controls.md) | design note | — | — |

Report `11` is not a findings list. It is the control set requested for the
unauthenticated upload door, written as a design to be decided on and
implemented. It supports `SEC-1`, `SEC-5`, `SEC-6`, `SEC-7`, and `SEC-8`.
**[`90-gap-register.md`](./90-gap-register.md) supersedes it as a buildable spec**
(`GAP-401`); the note stays as the reasoning behind it.

---

## Gap register

[`90-gap-register.md`](./90-gap-register.md) — **10 build specs, `GAP-401`+.**

⚠ **It differs from the other areas' registers and says so at the top.** Those
came from dedicated design agents. This area was audited before that pattern
existed, so its register was **derived from the findings** — the cases where
fixing a finding means building something that does not exist, rather than
repairing something that does. Each spec names its source findings and inherits
their verification status, which was first-hand at commit `6a14d7d` and is now
several sessions old. **Re-read the cited code before building** (`DEC-29`).

A closing table records what deliberately did **not** become a gap, so nobody
hunts for a spec that should not exist.

---

## The five that matter most

Each is confirmed by reading the code path end to end.

1. **`SEC-1` — An unauthenticated upload link can put executing JavaScript on
   the app's own origin.** The link never expires, nothing checks the file type,
   and the viewer renders whatever arrives in an un-sandboxed iframe with access
   to the logged-in session token.

2. **`SEC-2` — Private projects are not private for money or quality data.** The
   helper that enforces project visibility is referenced by exactly one policy
   in the entire schema.

3. **`SAF-1` / `SAF-4` — A contractor's self-typed filename can green a PSSR
   item, and every route to a green closeout gate accepts a blank reason on one
   keypress.** One of them writes the fake reason `"decided by reviewer"` into
   the audit log.

4. **`SAF-6` — The project Activity tab cannot see the controls program at
   all.** Awards, approved change orders, PSSR rulings and turnover acceptance
   are written as project-scoped audit rows that the timeline reader never
   queries for.

5. **`BID-1` — The bid table shows one number and the Award button posts a
   different one**, and the quote PDF is unreachable from the screen that asks
   you to award it.

---

## Suggested resolution sequence

Ordered by blast radius, not by effort.

1. **Close the door.** `SEC-1`, `SEC-5`, `SEC-6`, `SEC-7`, `SEC-8` — see report `11`.
2. **Stop the lying.** `SAF-1`, `SAF-2`, `SAF-3`, `SAF-4`.
3. **Make the record complete.** `SAF-6` — one added query recovers the entire missing trail.
4. **Fix the private-project policies.** `SEC-2`.
5. **Make the award screen trustworthy.** `BID-1`, `BID-2`, `BID-3`, `MON-1`, `MON-3`.
6. **Repair the schedule importer.** `SCH-1`, `SCH-2`, `SCH-3`.

Everything after that is quality-of-life. It matters, but none of it will
produce a wrong number on a document someone signs.

---

## The systemic pattern

Underneath the specific defects there is one habit worth naming, because
fixing it as a habit prevents most of what is in these reports:

> **A silent fallback wherever an honest gap belongs.**

Destructuring `{ data }` without `error`. Catching to an empty array. Clamping
the top of a scale but not the bottom. Crowning a best value with no
cardinality check. Formatting money with no currency. Standing an empty array
in for "still loading."

Each is individually small. Together they mean the failure mode of this feature
is not an error message — it is a confident, plausible, wrong screen. For a
tool whose output is an award decision, a posted commitment, and a signed
safety review, that is the single property most worth changing.

---

## What is genuinely solid

Stated plainly, because an audit that lists only defects gives a false picture,
and because these are patterns worth preserving rather than refactoring away.

- **Compare-and-swap on the money paths.** Award, post-invoice and
  change-order-decide all claim the state transition before money moves, and
  correctly treat a zero-match update as the loss signal — subtle, because
  PostgREST reports a filtered-out update as success. Double-clicking Award
  cannot double-post.
- **Concurrent intake approval is safe.** The finalize path compare-and-swaps on
  `pending_version_id`; the loser writes nothing and re-fires no notices.
- **Null means unknown.** Company dimensions with no evidence score `null` and
  are excluded from the composite rather than scoring zero or a free hundred.
  The forecast returns null rather than inventing a number.
- **Unreadable scans degrade honestly.** The type-the-total fallback, the
  "price only — not scored on manpower" marker, and the specific parse error
  messages are a well-designed failure path. It is the model the rest of the
  error handling should copy.
- **The S-curve chart is exemplary for accessibility** — a real `role="img"`
  with a value-bearing label, a text legend restating every series, and a dashed
  planned line so identity survives grayscale.
- **Complete-with-open-items is the right override pattern**: gates shown
  plainly, override allowed, reason recorded.
- **Export and restore parity is enforced by a tripwire test**, and all seven
  new tables were registered in dependency order.

The recurring shape of the *problems*, by contrast, is re-implementation: a
hand-rolled modal instead of the app's `Modal`, a lookalike `Field` that breaks
label association, `hidden` instead of `sr-only` on file inputs, hardcoded
padding instead of the shell's responsive padding. Most of those fixes are
substitutions, not new engineering.

---

## Limits of this audit

Weigh the findings accordingly.

- **No live database.** Every row-level-security finding is read from policy
  definitions and trigger bodies. They are unambiguous reads, but a staging
  repro would nail them — particularly `SEC-15` and `SAF-13`, which both predict
  a specific raw Postgres error reaching the user.
- **No browser.** The cross-site-scripting chain in `SEC-1` is confirmed link by
  link in the code but no payload was executed. Treat it as
  confirmed-by-construction.
- **No production instance.** Scale figures in report `09` are derived from
  query counts and row shapes, not measured. `SCH-7`'s realtime claim is read
  from the migration set; if `milestones` was added to the publication by hand
  in the Supabase dashboard, that half of the finding is void.
- **Where a finding says "measured"** — the bid-scoring numbers, the chart scale
  overflows, the contrast ratios, the document validation — that pass executed
  the pure logic under Node with adversarial inputs, or generated real document
  bytes and validated them with a strict parser. Those figures are program
  output, not estimates. The one thing that could not be done was opening the
  generated `.docx` in Word, so `RFQ-1`'s clean-file behaviour is structural
  review rather than an observed result.
