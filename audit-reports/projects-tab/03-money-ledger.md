# 03 · Money & the ledger

Where a wrong number gets signed, and where a failure leaves the books
inconsistent with no way to detect or repair it.

**12 findings** — 0 CRITICAL, 5 HIGH, 6 MEDIUM, 1 LOW (severities as recorded after verification; as filed, 2 CRITICAL, 6 HIGH, 4 MEDIUM).

> Line numbers are from commit `6a14d7d` and drift with edits. **Match on the
> quoted code, not the number.** See [`../README.md`](../README.md) for the
> resolution protocol.

---

## MON-1 · A failed award leaves the document permanently awarded with no commitment, and nothing can repair it

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / financial
- **Locations:**
  - `lib/costDocs.ts:196-201` — `revertDocTransition`, fire-and-forget
  - `lib/changeOrders.ts:178-180` — same shape
  - `lib/costDocs.ts:170-192` — `claimDocTransition`, which is otherwise correct
  - `app/api/projects/cost-docs/route.ts:87-92` — the 409 that then blocks recovery
- **Related:** `MON-11` (`posted_entry_id` unread — the field that would detect this)
- **Re-verified:** hardening pass — **SURVIVES**. `claimDocTransition` moves the document to `awarded` before the money is posted; the unreadable-total branch reverts (`costDocs.ts:240`), but the `addEntry` failure branch at `:245` returns `{ok: false}` **without** calling `revertDocTransition`. The document stays awarded with no commitment. `revertDocTransition` itself ends in `.then(() => undefined, () => undefined)`, so even the paths that do revert cannot report a failed revert.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The stuck-document half is fully confirmed, and the window is wider than the finding says — closing the tab after the claim UPDATE returns but before addEntry resolves leaves the row awarded with no revert attempt at all. But 'nothing can repair it' is too strong for the money: CostsTab.tsx:361 renders `<EntryForm …>` per account, which calls `addEntry` with `entryType: "commitment"` (CostsTab.tsx:424-426), so the missing commitment can be posted by hand and the rollup made whole. What stays unrepairable is the document/rival state (rivals are never declined — costDocs.ts:250-257 runs only after a successful post). HIGH rather than CRITICAL.

**Mechanism.** The compare-and-swap discipline is right: claim the transition,
then move the money, and revert if the money fails. But the revert is
fire-and-forget:

```ts
async function revertDocTransition(docId: string, backTo: CostDocStatus): Promise<void> {
  await supabase.from("cost_documents")
    .update({ status: backTo, posted_at: null, posted_by: null })
    .eq("id", docId)
    .then(() => undefined, () => undefined);
}
```

**Failure scenario.** The user clicks Award. The claim succeeds, so the
document is now `awarded`. The network drops, `addEntry` fails, *and the revert
also fails and is swallowed.* The quote is awarded with no commitment in the
rollup. It cannot be re-read (the route returns 409 "already moved money — its
extraction is locked") and cannot be re-awarded (the claim requires
`draft`|`parsed`). There is no interface, no reconciliation job, and no repair
path. The same shape leaves a change order stuck `proposed` that already posted
money.

**Remediation.**
1. Make the revert observable: check its result, and if it fails, return an
   error naming the inconsistent state and the document id.
2. Read `posted_entry_id` (and add the equivalent to `cost_documents`) so an
   awarded document with no posted entry is *detectable*. Surface it as a
   data-health warning on the Costs tab.
3. Add a repair path: an admin-visible "this award did not post — retry or
   revert" action.
4. Consider making claim-and-post a single database function so it is atomic
   and the whole class disappears.

**Done when.**
- A failed post surfaces an explicit error rather than silence.
- An awarded document with no cost entry is detectable by a query and visible in the UI.
- There is a supported way to repair one.
- A test simulates post-failure-plus-revert-failure and asserts the state is reported.

**Resolution (2026-09-29, projects Round G).** Worked in the joint J3 MONEY-LEDGER package (projects-tab P3 + projects-and-cost PC-7; the projects-and-cost pair is `COST-11`). The revert is now a CHECKED write and the two orphan states have a query, a UI line and an audited repair — never a delete.
- `lib/costDocs.ts` `revertDocTransition(docId, backTo, from)` returns `{ ok, error }` (UPDATE carries the claimed status, `.select("id")`, zero rows = failure). `awardQuote` / `postInvoice` call it on the unreadable-total branch AND on the `addEntry` failure branch (the branch the hardening pass found missing); a failed revert returns `stuckMessage(...)` — "the money did not post (…) AND the document could not be put back (…) — it is stuck as awarded with no cost entry. Document <id>: use Repair on the Costs tab". `lib/changeOrders.ts` `revertDecision` is the same shape; a failed revert throws naming the CO as stuck.
- Detectable: `listLedgerOrphans(orgId, projectId)` (`lib/costDocs.ts`) lists awarded/posted documents with no `cost_entries.source_document_id` pointing at them — an entry in ANY status counts, because voiding the entry is the documented correction for a wrong amount (`MOVED_MONEY`: "void the cost entry itself"), so a deliberately voided entry is attended, never offered a re-post of the locked total — and approved change orders with `posted_entry_id` NULL; migration `20261093` adds the same question as the view `cost_ledger_orphans` (security_invoker) and a DEC-30 inventory of the population before apply. `components/projects/CostsTab.tsx` renders the result as the "Ledger needs attention" line above the stat strip.
- Repair: `repairCostDoc({ doc, action: "repost" | "revert", costAccountId?, actor })` — re-post writes the missing commitment/actual with the document as its source (`COST_DOC_REPAIRED`, `action: repost`, entry id); revert puts the row back to parsed/draft (`COST_DOC_REPAIRED`, `action: revert`). Both re-check the entry link server-side and refuse a document that has since been made whole; re-post also refuses a document whose linked entry was voided by hand ("that void was the correction"), while revert stays available for it (none of its money is on the ledger). Controller / owner writes only (the existing RLS). The Costs tab's second button reads "Revert award" on a quote and "Revert posting" on an invoice.
- Tests: `lib/__tests__/costDocs.test.ts` — "post failure + revert failure is reported as STUCK with the document id", "post failure with a clean revert…", "lists awarded/posted paper with no entry…", "a document whose linked entry was VOIDED by hand is attended — not listed, and never re-posted at its locked total", "re-post posts the missing commitment…", "revert puts a stuck award back to parsed"; `lib/__tests__/moneyRailsMigration.test.ts` pins the view (no status predicate on the linked entry) and the inventory.
- Reproduced at the base commit: `revertDocTransition` ended in `.then(() => undefined, () => undefined)` and `awardQuote`'s `addEntry` failure branch returned `{ ok: false }` with no revert.
- Pending migration: `supabase/migrations/20261093_prj_roundG_money_rails.sql` (the view, the COST-9 backfill and the inventory). The "Ledger needs attention" line is HIDDEN until it has run — `listLedgerOrphans` probes the view and returns `available: false` on relation-missing — so the line never renders against un-backfilled data. The repair's legacy guard (below) works without it.
- **Correction (review fix pass 2).** The first two cuts overstated done-when 2 and 3: attendance was judged ONLY by `cost_entries.source_document_id`, which the base never wrote, so every award / invoice posted before this branch would have been listed as an orphan — and its Re-post would have added a second commitment beside the real one, its Revert award would have reopened the paper while its commitment stayed (re-offering Award: a double commitment). The backfill also skipped hand-voided entries and the ambiguous `file_name` matches. Now: (a) `20261093`'s backfill links award/invoice-shaped entries in ANY status; (b) an UNLINKED entry of the document's award/invoice shape — same project, `source_document_id IS NULL`, `entry_type` matching the kind, reference = the document number or file name, description `Award — …` / `Invoice — …`, any status — attends the document in `listLedgerOrphans` AND in the view, and `repairCostDoc` refuses BOTH actions for such a document ("An unlinked entry that looks like this document's exists … Link it, don't re-post or revert"); (c) the line is gated on the migration (above); (d) the entry reads are bounded to the moved documents (`.in`, in chunks of 100 — no capped, unordered scan of the project's ledger that could mis-list a healthy award on a large project). Change-order orphans gained their own repair (`COST-11` dw3: `repairChangeOrder` link / reverse). Tests added: "an awarded quote whose POSTED legacy entry is unlinked is not listed, and both repairs are refused", "a legacy award entry VOIDED by hand … attends its document too", "a legacy posted INVOICE attends its document…", "two awarded quotes sharing a file name ('Quote.pdf') … neither is listed or re-posted", "the orphan line waits for 20261093…", "the linked-entry check reads only this project's moved documents, in chunks…".
- **Verification fix (2026-09-30, projects Round G).** An independent verification pass found `repairCostDoc` still allowed **Revert** on a document whose linked entry was voided by hand — the reopened paper could then be awarded / posted again, a second commitment beside the controller's corrected entry. `lib/costDocs.ts` `repairCostDoc` now refuses BOTH actions for such a document ("This document's cost entry was voided by hand — that void was the correction, so the document is not reopened …"); the Resolution's "revert stays available for it" above is withdrawn. Such a document was never listed (its linked entry attends it), so the Costs tab never offered the button — this closes the lib path. Test: "a document whose linked entry was VOIDED by hand is attended — not listed, and never re-posted at its locked total" now asserts the revert refusal, the document still `awarded`, no audit row, and that Award cannot post it a second time. The verifier's second point — a stuck document hidden by an ambiguous legacy entry — is recorded under Scope / residual, not built.

**Done-when.**
1. ✓ A failed post surfaces an explicit error — the post error, or the stuck message naming the state and the document id when the revert also failed.
2. ✓ (once `20261093` is applied — the line is hidden before it, deliberately) An awarded document whose money is on the ledger nowhere is detectable by a query (`listLedgerOrphans`, `cost_ledger_orphans`) and visible in the UI (the "Ledger needs attention" line); pre-Round-G paper attended by an unlinked entry of its shape is NOT listed.
3. ✓ There is a supported way to repair one (`repairCostDoc`, re-post or revert, audited), and it refuses both actions where an unlinked legacy entry shows the money already reached the ledger — it never double-posts.
4. ✓ A test simulates post-failure-plus-revert-failure and asserts the state is reported.

**Scope / residual.** Remediation item 4 (claim-and-post as one database function) is deliberately NOT shipped: the compare-and-swap in `claimDocTransition` is the load-bearing substrate report 03 verified sound, the money path stays `lib/costs.addEntry` only, and every done-when holds with the checked revert + reconciliation + repair. Rivals declined by an award that is later reverted stay declined (the repair line says so). The `409` at `app/api/projects/cost-docs/route.ts:87-92` is untouched — a repaired/reverted document is readable again because its status is. The legacy-shape match is deliberately broad (reference + kind + description prefix, no vendor): a genuinely orphaned document that shares its reference with another document's legacy entry is NOT listed — the conservative direction (never a double post); such a row, and the backfill's ambiguous residue, carry no machine link and are fixed by hand (`COST-9`).
**Residual recorded in the verification fix (2026-09-30).** The conservative direction has a cost that done-when 2 does not cover: a document that is TRULY stuck (awarded / posted, its own post failed) but whose reference matches an unlinked legacy entry of its shape — the backfill's ambiguous residue, e.g. two quotes both filed as "Quote.pdf" — is attended by that other document's entry, so it is neither listed by `listLedgerOrphans` / `cost_ledger_orphans` nor repairable in-app (`repairCostDoc` refuses both actions while the look-alike exists). No link UI is built. A controller repairs it in the SQL editor:
```sql
-- 1. the unlinked entries that share the document's reference (read-only)
SELECT e.id, e.entry_type, e.amount, e.status, e.description, e.entry_date, e.created_at
  FROM cost_entries e
 WHERE e.project_id = '<project id>' AND e.source_document_id IS NULL
   AND btrim(e.reference) = btrim('<doc_number, else file_name>');
-- 2a. one of them IS this document's money: link it (what the backfill does for an unambiguous match)
UPDATE cost_entries SET source_document_id = '<document id>'
 WHERE id = '<entry id>' AND source_document_id IS NULL;
-- 2b. none of them is: post the missing commitment (quote) / actual (invoice) by hand on the
--     Costs tab, then link THAT entry with 2a so the paper and the ledger agree.
-- 3. record the repair (the in-app repair writes the same action)
INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details)
VALUES ('COST_DOC_REPAIRED', 'cost', '<document id>', '<org id>', '<controller uid>',
        jsonb_build_object('action', 'link', 'entryId', '<entry id>', 'path', 'sql'));
```
The `20261093` final row "award/invoice-shaped entries still unlinked" counts the population these candidates come from.

---

## MON-2 · The cost S-curve's planned line starts on the day the first task finishes

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** correctness / decision-quality
- **Locations:** `components/projects/CostsTab.tsx:76-79`
- **Related:** `MON-6` (span definitions), `SCH-6`
- **Re-verified:** hardening pass — **SURVIVES**. `const dates = rows.map((m) => m.planned_at)…sort()` then `start: dates[0]` (`CostsTab.tsx:76-79`). `planned_at` is the milestone **finish**, so the planned curve begins on the earliest completion date.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The defect is real and the fix is one column, but the impact is a systematically compressed planned curve (the audit's own example is an 11-day / ~9% skew) plus a skewed run-rate EAC — a distorted decision aid, not a money-moving or data-destroying fault. CRITICAL is too high; HIGH.

**Mechanism.**

```ts
const dates = rows.map((m) => m.planned_at).filter(Boolean).sort();
setSchedSpan(dates.length >= 2 ? { start: dates[0].slice(0,10), end: dates.at(-1).slice(0,10) } : {…});
```

`planned_at` is the **finish** date. `planned_start_at` is never read.

**Failure scenario.** A schedule whose first activity runs 1–12 June and whose
last finishes 30 September has a real span of 122 days. The planned budget line
is drawn across 110 days, starting eleven days late and climbing eleven percent
steeper — so it reads above actuals for the whole first month and the
on-track comparison is wrong from day one. `plannedManpowerSeries` inherits the
same compression, inflating the crew curve. `computeForecast`'s run-rate basis
divides by the short span, inflating the estimate at completion.

This is systematic: any project with multi-day tasks is affected, which is
every imported schedule.

**Remediation.** Use `min(planned_start_at ?? planned_at)` for the span start
and `max(planned_at)` for the end. Then reconcile with the other four span
definitions (`MON-6`) so the whole app agrees.

**Done when.**
- The planned line begins at the earliest task start, not the earliest finish.
- The crew curve and the run-rate forecast use the same span.
- A test pins the span for a fixture with multi-day tasks.

**Resolution (2026-09-30, projects Round G).** Joint J5 CHARTS. `lib/costSeries.ts` `scheduleSpanFromMilestones()` (:53) is the one span every cost picture shares, on screen and on paper. It runs from the earliest task START (`planned_start_at`, or the finish for a row with no start) to the latest finish (`planned_at`). A single row with a real duration spans; otherwise two dated rows are needed, as before.
- The Costs tab. `components/projects/CostsTab.tsx` adds `planned_start_at` to its milestone select and to the row type, imports the helper, and replaces the sorted-`planned_at` span (the `dates` array and the four-line `dates[0]` / `dates[dates.length - 1]` ternary) with one `setSchedSpan(scheduleSpanFromMilestones(rows))` call and a comment: about eleven lines of diff. `CostCharts` passes that one span to `buildCostSeries` (the planned line), `computeForecast` (the run-rate basis) and `plannedCrewAverage` (the crew figure, `CHART-3`).
- The printed report (review fix pass). `lib/projectReport.ts` adds `planned_start_at` to its milestone select (:99) and takes its forecast span from `scheduleSpanFromMilestones` over the same live rows (:129-138). That replaces its own finish-only span (sorted `planned_at`, `dates[0]`). On the finding's fixture (tasks 1–12 June … 20–30 September, a $121,000 budget, $10,000 spent, no CPI, today 1 July), the tab said "At the current spend pace you'll finish around $40,333" (30 of 121 days elapsed) and the signed report said $57,895 (19 of 110). Both now say $40,333. `computeForecast` has no other caller, so the tab and the report are the app's only cost forecasts, and both take this span.
- **Both files are outside this package's plan**, recorded as such. `CostsTab.tsx` is P3/J3's and `projectReport.ts` is J7's. Both packages have merged, and no running package holds either file. The tab never read `planned_start_at`, so the span could not be derived inside `buildCostSeries` without it. The report is edited because the remediation asks for "the whole app" to agree, and a wrong planned span is a wrong forecast on a signed report. The column comes from `20260703_milestones_hierarchy.sql`, older than `20260731`'s `percent_complete`, which both selects already read.
- Tests: `lib/__tests__/projectControls.test.ts` — "MON-2: the schedule span runs from the earliest task START to the latest finish". The finding's own fixture: tasks 1–12 June … 20–30 September. The finish-only answer is shown to be 12 June; the helper gives 1 June → 30 September. It also covers a row with no start, a single task with a duration, a single zero-duration milestone, and two same-day milestones. "MON-2: the planned line begins at the first task's start and the run-rate forecast uses the same span": at one sample per day the planned line is 0 on 1 June and 11/121 of budget on 12 June; the run-rate EAC divides by 30/121 elapsed on 1 July; the crew figure spans the same 121 days. "MON-2: the Costs tab reads each milestone's start and derives its span through the shared helper" is a source pin over `CostsTab.tsx`. `lib/__tests__/projectReport.test.ts` — "multi-day tasks, $121,000 budget, $10,000 spent, no CPI, today 1 July: the report's EAC is the tab's": the report's forecast sentence equals `computeForecast` over the tab's span, $40,333 and not $57,895. "the report reads each milestone's start and takes its span from the shared helper (source pin)". All of these failed at the base: there was no helper, the tab computed `dates[0]` of sorted `planned_at`, and the report printed $57,895.

**Done-when.**
1. ✓ The planned line begins at the earliest task start, not the earliest finish.
2. ✓ The crew curve (now the planned-average-crew figure) and the run-rate forecast use the same span, on the tab and on the printed report.
3. ✓ A test pins the span for a fixture with multi-day tasks (the helper, the tab's series and forecast, and the report's forecast).

**Scope / residual.** One residual, shared by both surfaces. The milestone read is bounded and ordered by FINISH. The report reads the first `PROJECT_MILESTONE_READ_LIMIT` (1,000) rows by `planned_at`. The Costs tab reads the same rows once the J7b integration fix's bound merges; in this base it reads up to the API's max-rows. On a schedule larger than the bound, a row past it can hold the earliest START (a long early task that finishes late). The span's end is also the 1,000th finish, not the last. On such a schedule the span can start late and end early, on both surfaces alike, so they still agree with each other. Closing it needs a separate `min(planned_start_at)` / `max(planned_at)` read beside the bounded row read. That is not done here. `MON-6` itself (the source filter) is resolved.

---

## MON-3 · Void and manual-total have no compare-and-swap, in the one file that preaches the discipline

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / financial
- **Locations:**
  - `lib/costDocs.ts:310-319` — `voidCostDoc`
  - `lib/costDocs.ts:323-334` — `setManualTotal`
  - `lib/costDocs.ts:170-192` — `claimDocTransition`, the pattern they should use
- **Re-verified:** hardening pass — **SURVIVES**, and the discipline it breaks is in the same file. `voidCostDoc` (`costDocs.ts:315`) and `setManualTotal` (`:330`) both issue a bare `.update(…).eq("id", …)` with no status precondition in the predicate, while `awardQuote` in the same module goes through `claimDocTransition` — a real compare-and-swap.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both writers are genuinely unguarded, and I found no DB CHECK, trigger, or RLS predicate on cost_documents.status that would stop them (only the RLS membership/owner policies in 20260906/20261013). The downstream consequence is real too: app/api/intake/resolve/route.ts:86-88 maps `void` to "not_selected" for the vendor while the commitment posted by awardQuote stays on the budget.

**Mechanism.** `voidCostDoc` checks the *client's stale* status object, then
updates with `.eq("id", doc.id)` alone. `setManualTotal` has no status guard at
all.

**Failure scenario.** A document awarded in another tab gets voided anyway: the
paper says void, the commitment stays posted, and the contractor portal flips
their bid to "not selected" (`app/api/intake/resolve/route.ts:86`). Or a total is overwritten
on an already-awarded document, so the paper stops matching the posted cost
entry — which is also the input to `BID-1`.

**Remediation.** Add `.in("status", [...allowed])` to both updates and check the
returned row count, exactly as `claimDocTransition` does. Return the same
"someone else just decided this — refresh" message on zero match.

**Done when.**
- Voiding an awarded document is refused.
- Setting a manual total on an awarded document is refused.
- Both refusals are tested.

**Resolution (2026-09-29, projects Round G).** Joint J3 MONEY-LEDGER (projects-and-cost pair `COST-14`). Both writers decide against the DATABASE row, and the allowed set is every status that moved no money — `MOVED_NO_MONEY = ["draft", "parsed", "declined"]` (the base allowed `declined` too; a declined or junk document keeps a terminal and a correction path). `voidCostDoc` routes through `claimDocTransition(doc.id, MOVED_NO_MONEY, "void", uid, /* stampPosted */ false)` — re-read, status predicate on the UPDATE, `.select("id")`, zero rows = "Someone else just decided this document — refresh"; a row that is already awarded is refused with its real status ("This document is already awarded — refresh to see the latest"). `setManualTotal` issues status-predicated UPDATEs — draft/parsed → `total_amount` + `status: parsed` under `.in("status", ["draft", "parsed"])`; else declined → `total_amount` only under `.eq("status", "declined")` (a corrected bid-tab figure, NOT a reopen) — checks the row count, and on zero rows re-reads the row to name the status ("…already awarded — its total is locked"). The client-snapshot check stays as a fast refusal; it is no longer the decision.
- Tests: `lib/__tests__/costDocs.test.ts` — "voiding a document whose stored status is awarded is refused even when the snapshot says parsed", "a void that loses the race (zero rows matched) is reported…", "setting a manual total on an awarded document is refused with the row's real status…", "a DECLINED document moved no money: it can be voided, and a typed total corrects it WITHOUT reopening it", "a posted invoice still refuses both, whatever the snapshot says".
- Reproduced at the base commit: both UPDATEs were `.eq("id", …)` alone.

**Done-when.**
1. ✓ Voiding an awarded document is refused.
2. ✓ Setting a manual total on an awarded document is refused.
3. ✓ Both refusals are tested.

**Scope / residual.** No signature change (P4/J4's QuotesPanel calls are untouched). The portal's "not_selected" mapping of `void` (`app/api/intake/resolve/route.ts`) is P1's; with this fix an awarded document can no longer reach `void` through the app, so the mapping can no longer contradict a posted commitment.

---

## MON-4 · Remaining budget ignores commitments, and the false figure is written into the permanent record

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** decision-quality / financial
- **Locations:**
  - `lib/costs.ts:330` — `remaining: sum(budget) - sum(spent)`
  - `components/projects/CostsTab.tsx:133-142` — the headline tile
  - `components/projects/CostsTab.tsx:145-156` — the burn bar, which *does* draw the committed band
  - `lib/projectReport.ts` — `draftLessonsLearned` writes the figure into the record
- **Re-verified:** hardening pass — **SURVIVES**. `remaining: sum((r) => r.account.budget) - sum((r) => r.spent)` (`costs.ts:330`) omits commitments entirely, and the figure is rendered as the headline "Remaining" stat (`CostsTab.tsx:133-136`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. I looked for a mitigating reading and only found partial ones — the Committed tile and the hatched burn bar sit beside it (CostsTab.tsx:129-131, 148-156) — but nothing labels the figure as budget-minus-actuals, and the lessons-learned draft launders it into projects.lessons_learned as a closeout fact. HIGH stands.

**Mechanism.** `spent` is actuals plus adjustments. Awarded contract value is
posted as a commitment and never drawn down against available money. The tile
renders in emerald with a `TrendingUp` icon.

**Failure scenario.** $200,000 budget, $190,000 committed to an awarded
subcontractor, $10,000 invoiced. The headline tile reads **"Remaining
$190,000"**. The uncommitted balance is $10,000. This is the most-glanced
number on the screen and it points a manager nineteen times in the wrong
direction. The auto-drafted lessons-learned then writes it into the project's
closing record.

The burn bar one component over gets this right, which makes the tile's
omission a presentation choice rather than an oversight.

**Remediation.** Either rename the tile to "Uninvoiced budget" and add a second
"Uncommitted" figure, or — better — change it to
`budget - spent - openCommitments` and label it "Uncommitted." Add a glossary
entry either way (see `UX-15`). Fix the lessons-learned draft to use the same
definition.

**Done when.**
- The headline figure accounts for open commitments, or is labelled so it cannot be misread.
- "Remaining" (or its replacement) has a glossary entry.
- The lessons-learned draft and the tile agree.

**Partial (2026-09-29, projects Round G).** Report-label limb only (this package owns `lib/projectReport.ts`): the report's Money table no longer prints a bare "Remaining" — the row is labelled **"Budget less spent"** with *"— open commitments are not deducted"* beside the figure, so the paper cannot be misread as uncommitted balance. Test: `lib/__tests__/projectReport.test.ts` "the remaining figure is labelled as budget-less-spent with commitments not deducted (MON-4 report limb)". The headline tile (`CostsTab.tsx`), the `remaining` definition (`lib/costs.ts:330`), the glossary entry and the lessons-learned wording all close in P3 MONEY-LEDGER; the lessons-learned line still uses `rollup.remaining` and will follow whatever definition P3 lands.

**Partial (2026-09-29, projects Round G).** Joint J3 MONEY-LEDGER (projects-and-cost pair `COST-2`; decision default from the brief: the headline is Budget / Committed / Spent / **Available** = budget − spent − open commitments, "Remaining" retired). `lib/costs.ts` `computeCostRollup` now exposes per account and per project `openCommitments` (a commitment counts until the actuals invoiced against it, matched by party, reach its amount), `exposure = spent + openCommitments`, `remaining = revisedBudget − exposure` (uncommitted), `remainingActualsOnly = revisedBudget − spent` (secondary), and `overBudget` trips on exposure. `components/projects/CostsTab.tsx`: the headline tile is "Available" with the definition in its sub-line ("uncommitted (budget − spent − open commitments) · X unspent (actuals only)" — the secondary figure is budget − spent, NOT an uninvoiced figure, so it no longer shares the word with the Committed tile); the Committed tile shows the not-yet-invoiced part (open commitments); each account row shows "X uncommitted" beside "of <revised budget>". `lib/projectReport.ts` reads `d.rollup.remaining`, so the lessons-learned draft and the tile now use the same definition without an edit there.
- Tests: `lib/__tests__/costs.test.ts` — "budget 1000, committed 900, spent 0 is at risk — 100 uncommitted, not 1000 remaining", "a commitment is drawn down by actuals from the SAME party…", and the first case updated to the new semantics (800 committed / 300 invoiced → 500 open, 250 uncommitted, 750 unspent on actuals only).
- Reproduced at the base commit: `remaining: sum(budget) − sum(spent)`.

**Done-when.**
1. ✓ The headline figure accounts for open commitments (and its sub-line says how).
2. ✗ NOT DONE HERE — the glossary lives in `CostGlossary` (`components/projects/cost/CostCharts.tsx`), J5 CHARTS' file, where this package may touch only the forecast label. **Pointer to J5:** add `{ term: "Available (uncommitted)", plain: "Budget minus what you've spent minus what you've promised (open commitments, net of the invoices already posted against them). The number you can still award." }`.
3. Partly — the draft and the tile agree ONLY while no change order is approved. Both consume `rollup.remaining`, but `lib/projectSnapshot.ts:55` (`computeCostRollup(accounts, entries, pctIdx)`) and `lib/projectReport.ts:59` (`computeCostRollup(accounts, entries, new Map())`) build the rollup WITHOUT the approved-changes map, so there `revisedBudget = budget` and the health snapshot / lessons-learned draft read `budget − exposure` while the Costs tab reads `revised budget − exposure` — they differ by the approved-changes total (200k account + approved 100k CO + 150k spent: tab Available $150k, draft/health Remaining $50k). **Pointer to J7 (projects-tab `MON-5` / projects-and-cost PC-9 limb):** both files must pass `approvedChangesByAccount(await listChangeOrders(projectId))` as the fourth argument — only an approved CO whose linked entry is still POSTED revises the budget (review fix pass 2), and since the verification fix (2026-09-30, `COST-4`) `listChangeOrders` reads that status by id, so the call takes no entries argument. J7 has merged to the integration branch without it (there the calls are `lib/projectSnapshot.ts:253` / `lib/projectReport.ts:127`), so this is now a follow-on for the integrator or the next package on those files. The report's "Remaining" row label is also J7's one-line limb.

**Scope / residual.** Open until J5 adds the glossary line and J7 passes the approved-changes map in `lib/projectSnapshot.ts` / `lib/projectReport.ts`. The exposure matching rule (by party) is DEC-50's stated default; an invoice posted with no party against an award that carries one is counted as unmatched (conservative — exposure over-counts, never under-counts).

**Verification fix (2026-09-30, projects Round G).** Two corrections, from an independent verification of the integration tree after J3 merged. (1) The J3 paragraph above says `lib/projectReport.ts` "reads `d.rollup.remaining`, so the lessons-learned draft and the tile now use the same definition without an edit there". That was wrong. Once `remaining` became budget − spent − open commitments, the report's row labelled "Budget less spent — open commitments are not deducted" printed a figure that deducts them, and the draft wrote that figure as the finish. Probe: budget $50k, spent $10k, $20k still committed → the row printed $20,000 and the draft said "Finished $20,000 under the $50,000 budget". Fixed in `lib/projectReport.ts`. "Budget less spent" now prints `remainingActualsOnly` (revised budget − spent, `:276`). A separate "Available (uncommitted)" row prints `remaining` under its own label, naming the open commitments it deducts (`:277`). The Budget row prints the revised budget with the baseline and approved change orders beside it, as the Costs tab headlines it (`:273`). The draft's COST line is budget less spent against the revised budget, says "on actual spend", and names any open commitments not yet invoiced (`:373-386`): "COST: Finished $40,000 under the $50,000 budget on actual spend. $20,000 of open commitments was not yet invoiced when this was drafted." (2) Done-when 3's pointer to J7 is done: the snapshot and the report pass `approvedChangesByAccount(cos)` from `listChangeOrders` (see `MON-5`), so the draft, the health snapshot and the tile read the same revised budget when a change order is approved too. Tests (`lib/__tests__/projectReport.test.ts`): "$50k budget, $10k spent, $20k still committed: the row labelled 'open commitments are not deducted' prints $40,000 — not $20,000", "the lessons-learned draft says finished $40,000 under on actual spend and names the $20,000 still open", "with an approved change order the draft measures against the revised budget and says so". Reproduced on `9b4c5f4`: all three fail there. Done-when 3 is now ✓ in this sense: the draft and the tile are computed from the same rollup, and the draft states budget less spent and names the open commitments the tile's Available deducts, so neither contradicts the other. The finding stays OPEN for done-when 2 (J5's glossary line).

**Partial (2026-09-30, projects Round G).** Joint J5 CHARTS — done-when 2's glossary line only. `components/projects/cost/CostCharts.tsx` `COST_GLOSSARY_TERMS` carries J3's specified entry verbatim: "Available (uncommitted)" — "Budget minus what you've spent minus what you've promised (open commitments, net of the invoices already posted against them). The number you can still award." Test: `lib/__tests__/costChartsRender.test.ts` "carries the Available (uncommitted) entry the money-ledger package specified". With it, done-when 2 is ✓. Done-when 3, the approved-changes map in `lib/projectSnapshot.ts` / `lib/projectReport.ts`, is J7's. In this package's base those calls still omit the map. The J7b integration fix (`126d4d1`, merged on the integration branch after this base) passes `approvedChangesByAccount(cos)` in both files and prints "Available (uncommitted)" on the report. The Status flip is the integrator's call at merge.

**Integration (2026-09-30, projects Round G — J5 merged onto J3 and the J7 integration fix).** Every done-when is now met on the integration branch. (1) ✓ The headline tile is "Available" = revised budget − spent − open commitments, with the definition in its sub-line (J3, `components/projects/CostsTab.tsx`). (2) ✓ `CostGlossary` carries the "Available (uncommitted)" entry (J5, `components/projects/cost/CostCharts.tsx`, test in `lib/__tests__/costChartsRender.test.ts`). (3) ✓ The report and the health snapshot build the rollup with `approvedChangesByAccount(cos)` (J7 integration fix), so the lessons-learned draft, the report's "Budget less spent" / "Available (uncommitted)" rows and the tile read the same revised budget; the draft states budget less spent on actual spend and names the open commitments the tile deducts (tests in `lib/__tests__/projectReport.test.ts`). Status flipped to RESOLVED.

---

## MON-5 · The printed report's cost performance index is unconditionally null, so paper and screen disagree

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** correctness
- **Locations:**
  - `lib/projectReport.ts:53-59` — the discarded index
  - `lib/costs.ts:305-313` — where a missing index makes earned value null
  - `components/projects/CostsTab.tsx:137-141` — the screen, which shows a real CPI
- **Re-verified:** hardening pass — **SURVIVES**, and the cause is one argument. `lib/projectReport.ts:59` calls `computeCostRollup(accounts, entries, new Map())` — the third parameter is the milestone-percent index, and an empty map makes `evActual` zero, so `cpi: evActual > 0 ? evTotal / evActual : null` (`costs.ts:332`) is **always null on paper** while the screen passes a real index.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is exactly as claimed, but the summary's framing is wrong in one way that matters: the report never prints a mismatched CPI — projectReport.ts:139 is `${d.rollup.cpi != null ? row("Cost performance (CPI)", …) : ""}`, so the row is simply absent (and the lessons-learned CPI parenthetical too). The genuine paper-vs-screen contradiction is the Forecast line, which silently falls back to the run-rate basis (costSeries.ts:120-135) and prints a different EAC under the claim "Every figure above is drawn live". An omitted metric plus one divergent forecast sentence is MEDIUM, not HIGH.

**Mechanism.**

```ts
const pctIdx = milestonePctIndex(live.map((m, i) => ({
  id: String(i), percentComplete: …, status: …,
})));
void pctIdx; // EV pinning uses milestone ids; report uses account-level rollup below
const rollup = computeCostRollup(accounts, entries, new Map());
```

Two defects at once: the index is keyed by array position (`String(i)`), which
can never match a `wbs_milestone_id` UUID; and it is discarded anyway, with an
empty `Map` passed instead.

Every account's earned value therefore resolves to null, `cpi` is always null,
the report never prints the CPI row, and the forecast silently drops to the
run-rate basis.

**Failure scenario.** The number on the printed brief and the number in the
application are computed on different bases and do not match. The report's
closing sentence claims "Every figure above is drawn live from the platform's
records."

**Remediation.** Build the index keyed by the real milestone id and pass it to
`computeCostRollup`. `CostsTab.tsx:74` already does this correctly — copy it.
Fix `MON-6`'s source filter at the same time or the index will still be
missing imported rows.

**Done when.**
- The printed report shows the same CPI as the Costs tab for the same project.
- The forecast basis matches between the two.
- A test asserts the report's rollup receives a non-empty index for a fixture with pinned accounts.

**Resolution (2026-09-29, projects Round G).** `lib/projectReport.ts` `gatherReportData` now selects `id` on the milestone query, builds `milestonePctIndex` keyed by the real milestone id, and passes it to `computeCostRollup` — the `void pctIdx` line and the `new Map()` are gone. With `MON-6` landing in the same pass, the index carries imported rows too, so an account pinned to an imported milestone resolves. `gatherReportData` / `renderReportHtml` are exported for tests. Tests: `lib/__tests__/projectReport.test.ts` "a pinned account + a 50% milestone yields the same CPI the Costs tab computes" (report `rollup.cpi` ≡ `computeCostRollup(listAccounts, listEntries, milestonePctIndex(rows)).cpi`, the Costs tab's computation, = 1.25; the CPI row renders) and "the forecast is on the CPI basis and the lessons-learned draft carries the figure" (`At this performance…`; `(CPI 1.25)`). Reproduced against `8276cad` before editing: the new tests failed there (13 of 45 across `projectReport.test.ts` / `projectControls.test.ts`; `projectSnapshot.test.ts` could not even load — `lib/milestoneLiveness.ts` did not exist and the filter at `projectSnapshot.ts:49` was the manual-only one quoted above).

**Fix pass (2026-09-30, projects Round G review).** The report's milestone query still had `.limit(500)`. With imported rows now counting, that rowset feeds the EV index, the complete/total counts and overdue, so a P6 import over 500 activities was truncated without notice. An account pinned to an activity past row 500 dropped out of EV, and the printed CPI differed from the Costs tab's. The snapshot, meanwhile, read 1,000 rows in no order. All three readers now see the same rows. The new `PROJECT_MILESTONE_READ_LIMIT` (1,000, in `lib/milestoneLiveness.ts`) is the bound. The report and the snapshot both read `order("planned_at").order("id").limit(PROJECT_MILESTONE_READ_LIMIT)`. That is the subset the Costs tab's unbounded `order("planned_at")` read receives under the API's default 1,000-row response cap. The report selects with `{ count: "exact" }` and carries `milestoneTotal`. When a schedule is larger, the Schedule section says "(first N of M by planned date — every figure in this section counts those)", and the CPI row and the lessons-learned COST/SCHEDULE lines say the earned value and overdue count cover the first N of M activities. Tests (`lib/__tests__/projectReport.test.ts`, whose mock now honours `order` / `limit` / `count` as PostgREST does): "600 activities, an account pinned to row 550: the report CPI equals the Costs-tab computation" (CPI 2.00 on both, "100/600 milestones complete"; fails on the `limit(500)` code), "a schedule larger than the bound says 'first N of M'…", and "the report's bound is the snapshot's bound" (source pin over both files). `projectSnapshot.test.ts` "reads milestones ordered by planned date and bounded like the report…".

**Done-when.**
- The printed report shows the same CPI as the Costs tab for the same project — ✓ for any schedule up to 1,000 activities: every surface reads every row, and a 600-row fixture pinned at row 550 is tested. Above 1,000, the three surfaces read the same first 1,000 by planned date (the Costs tab through the API's default cap), and the report says so ("first N of M") instead of presenting a subset as the whole. Earned value for an account pinned past row 1,000 is missing on every surface alike. Paging all readers is the "Query limits" section's work in `09-performance-scale.md`: `CostsTab.tsx` is P3's and `lib/milestones.ts` is PC-3's.
- The forecast basis matches between the two — ✓ (both feed the same `cpi` into `computeForecast`, so both take the CPI basis when it exists).
- A test asserts the report's rollup receives a non-empty index for a fixture with pinned accounts — ✓.

**Scope / residual.** Closed by pointer from projects-and-cost `PM-12` and `COST-1` (report half). The Costs tab's own milestone read has no explicit bound (`CostsTab.tsx:66-67`, P3's). If the deployment raises the API's max-rows above 1,000, that tab reads more rows than the report, and the two agree again only for schedules up to 1,000 activities. Giving that read `.limit(PROJECT_MILESTONE_READ_LIMIT)` is a one-line change for P3.

**Verification fix (2026-09-30, projects Round G).** An independent verifier probed the integration tree after J3 (money ledger) merged and found the first done-when's ✓ no longer true. J3 made `computeCostRollup` take the approved change orders (`COST-4`), and the Costs tab passes `approvedChangesByAccount(cos)` (`CostsTab.tsx:128-129`). `lib/projectReport.ts:127` and `lib/projectSnapshot.ts:253` still called it without them. Probe: a $50k account pinned to a task 40% complete, $10k actual, and a +$10k change order approved with its entry posted → Costs tab CPI 2.40, report and coach 2.00. Fixed: both now read change orders through `listChangeOrders` and pass `approvedChangesByAccount(cos)` as the fourth argument, as the tab does (`lib/projectReport.ts:157,192`, `lib/projectSnapshot.ts:246,277`). The report's forecast now takes the Costs tab's inputs (`CostCharts.tsx`: the revised budget and `pinnedBudget` / `pinnedSpent`, `lib/projectReport.ts:197-203`) and prints the forecast's `scopeNote` beside the sentence (`:283`). The Costs tab's milestone read now carries `.order("id").limit(PROJECT_MILESTONE_READ_LIMIT)` (`CostsTab.tsx:95-96`), the one-line change the residual above names. The three surfaces now read the same first rows by construction, with `id` breaking planned-date ties, not through the API's default row cap. Tests (`lib/__tests__/projectReport.test.ts`): "an on-ledger approved CO: all three compute CPI 2.40 (the report and coach printed 2.00)" (report ≡ snapshot ≡ the Costs tab's computation, which the test performs with the tab's own four reads and the `approvedChangesByAccount(cos)` argument), "a CO approved but whose entry was voided by hand is NOT on the ledger — none of the three count it", "the forecast takes the Costs tab's inputs — revised budget and the pinned subset — and prints its scope note (COST-1)", and "the report's bound is the snapshot's bound — and the Costs tab's (source pin)". Reproduced on `9b4c5f4`: all four fail there. Done-when 1 is ✓ again, now with approved change orders included; done-when 2 is ✓ (the same inputs reach `computeForecast`, so the basis and the EAC match). The Scope / residual above changes: the Costs tab no longer depends on the API's max-rows. Above 1,000 activities it reads the same first 1,000 as the report, but unlike the report it does not say "first N of M". That wording is P3's, if wanted.

---

## MON-6 · Imported schedules are invisible to health, the coach and the report — but visible to the Costs tab

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** correctness
- **Locations:**
  - `lib/projectSnapshot.ts:49` — the filter
  - `lib/projectReport.ts:54` — the same filter
  - `supabase/migrations/20260614_phase7_milestones.sql:61` — `CHECK (source IN ('manual','p6','msproject','csv'))`
  - `types/schema.ts:429` — `MilestoneSource`
- **Related:** `SCH-6`, `MON-2`
- **Re-verified:** hardening pass — **SURVIVES**. `projectSnapshot.ts:49` filters milestones to `source == null || "manual" || "app"`, the identical filter used by `projectReport.ts:54`. Imported rows are excluded from health, coach and report while the Costs tab reads them.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The core asymmetry is confirmed on all four surfaces. One sub-claim in the summary is wrong: the baseline nag cannot fire forever, because projectHealth.ts:198 requires `s.milestoneCount > 0` (false when every row is imported) and setBaseline (lib/milestones.ts:1469-1489) selects by org+project with no source filter, so any manual row that makes milestoneCount > 0 also gets baseline_finish_at set. HIGH still stands on the visibility gap itself.

**Mechanism.**

```ts
const live = msRows.filter((m) =>
  (m.source as string | null) == null || m.source === "manual" || m.source === "app");
```

`'app'` is not a legal value — the column is `NOT NULL` with a `CHECK`
permitting only `manual`, `p6`, `msproject`, `csv`. So that branch is dead and
the filter collapses to manual-only.

**Failure scenario.** A project with a 400-line P6 import is told
*"Schedule: No schedule yet,"* is nagged to "Add a schedule," and is nagged to
set a baseline forever after one has been set (`setBaseline` writes to imported
rows; `hasBaseline` cannot see them). The printed report says "No schedule
loaded." Meanwhile the Costs tab applies no source filter at all, shows the
schedule, and computes against it. Two panels on one page contradicting each
other.

Also: a cost account pinned to an imported milestone returns `undefined` from
the report's index and is excluded from CPI entirely, while the Costs tab
includes it — a second route to `MON-5`.

**Remediation.** Decide what `live` is meant to mean. Almost certainly it should
include every source — imported rows are real schedule, and `ScheduleTab.tsx:397`
tells the user they "still count toward the earned-value rollup." Remove the
filter, or replace it with an explicit exclusion of whatever it was actually
trying to exclude, and delete the impossible `'app'` branch.

**Done when.**
- A fully-imported project reports a real milestone count, real overdue counts and a real baseline state.
- The coach stops nagging for a schedule that exists.
- The Costs tab and the snapshot use the same rule.
- A test pins an imported-only fixture.

**Resolution (2026-09-29, projects Round G).** Package default taken: imported rows COUNT everywhere, exactly as on the Costs tab. New `lib/milestoneLiveness.ts` holds the one rule — `isLiveMilestone` (every stored row counts; the dead `"app"` branch and the impossible `== null` clause are gone), `liveMilestones`, `isImportedMilestone` (for view toggles only) and `isOverdueMilestone` (UTC-day, see `SCH-5`). `lib/projectSnapshot.ts` and `lib/projectReport.ts` use it; `components/projects/ScheduleTab.tsx` imports `isImportedMilestone` for its hide-imported toggle so the tab, the snapshot and the report read the same helper. The snapshot also computes `spi` from `computeScheduleMetrics` over the same rows (null until something is due, never a fabricated 1.00) and `hasBaseline` over all rows, so the baseline nag stops once `setBaseline` has run. The report prints the milestone table for an imported-only project and notes "N imported from the schedule file". Tests: `lib/__tests__/projectSnapshot.test.ts` "a project whose only milestones are source='p6' has a real count, overdue and SPI" (count 3, overdue 1, SPI 0.5, `hasBaseline` true; Schedule part scored; no `schedule` coach nag), "every stored source counts…"; `projectReport.test.ts` "an imported-only project prints the milestone table, never 'No schedule loaded'". Reproduced against `8276cad` before editing: the new tests failed there (13 of 45 across `projectReport.test.ts` / `projectControls.test.ts`; `projectSnapshot.test.ts` could not even load — `lib/milestoneLiveness.ts` did not exist and the filter at `projectSnapshot.ts:49` was the manual-only one quoted above).

**Done-when.**
- A fully-imported project reports a real milestone count, real overdue counts and a real baseline state — ✓.
- The coach stops nagging for a schedule that exists — ✓.
- The Costs tab and the snapshot use the same rule — ✓ (no source filter on either; the snapshot's EV index is id-keyed over every row, as `CostsTab.tsx` does).
- A test pins an imported-only fixture — ✓.

**Scope / residual.** `DEC-47` records the rule. Closed by pointer from projects-and-cost `PM-3`. `types/schema.ts` and the migration were evidence only and are untouched.

---

## MON-7 · The Known Companies scorecard is structurally empty for the normal workflow

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** feature-dead
- **Locations:**
  - `lib/costs.ts:127-155` — `saveParty`'s patch omits `company_id`
  - `lib/costs.ts:20-30` — `CostParty` does not carry the field
  - `components/projects/ProjectWizard.tsx:179-183` — the only writer
  - `lib/turnover.ts:143, 168, 247` — `partyId` accepted, never passed
  - `components/projects/cost/QuotesPanel.tsx:461` — `party_id` never passed on upload
  - `lib/companies.ts:240-252` — the profile gather, which hangs everything off these keys
- **Related:** `UX-5`, `SAF-9`
- **Re-verified:** hardening pass — **SURVIVES**. `saveParty` writes `cost_parties` (`costs.ts:127-134`), a different table from `companies`, which is what the Known Companies scorecard reads — so the normal project workflow never populates the scorecard.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Both headline sub-claims hold: turnover/punch evidence is always NULL-keyed so it can never reach a scorecard, and `bids` is always empty so the bid-history panel and "N/M bids won" can never render. But "structurally empty" overstates it — the wizard does link parties by exact name, and via that link projects, contract value (awardsTotal), change orders, milestone on-time and safety events all populate; the Quality dimension also scores from qualityManualScore alone (lib/companyScore.ts:92-102), so it is not "permanently Unrated". Two dead evidence channels out of many: MEDIUM.

**Mechanism.** The company profile hangs everything off three join keys, and
none is written outside the wizard:

- **`project_parties.company_id`** — only writer is `ProjectWizard.tsx:183`.
  `saveParty`'s patch is
  `Partial<Pick<CostParty,"name"|"kind"|"trade"|"defaultRate"|"contractValue"|"contactName"|"contactEmail"|"status">>`
  — no `company_id`. Any contractor added from the Costs tab is permanently
  unlinked.
- **`turnover_items.party_id`** and **`punch_items.party_id`** — accepted as
  parameters by `seedTurnoverItems`, `addTurnoverItem` and `addPunchItem`;
  passed by no caller anywhere (`QualityTab.tsx:512,601,604,644`,
  `ProjectWizard.tsx:199`).
- **`cost_documents.party_id`** — accepted by `uploadCostDoc`, passed by neither
  the upload form nor the intake quote insert.

**Failure scenario.** Turnover acceptance never reaches any scorecard, so the
company **Quality dimension is permanently Unrated**. Bid history never appears,
so "N/M bids won" never renders and the Bid-history panel never shows. The
coach's promise that "their performance record starts building" is false as
wired, and so is `lib/turnover.ts:8`'s claim that "acceptance rates roll up to
the contractor's permanent scorecard."

**Remediation.**
1. Add `companyId` to `CostParty` and to `saveParty`'s patch, with a company
   picker in the Costs parties panel.
2. Add a party dropdown to the turnover and punch add-rows and pass `partyId`.
3. Pass `partyId` from the quote upload form and from the intake quote branch
   (match on the link's company, which is already known).
4. Backfill existing rows where a confident name match exists — as a one-off
   script with human review, not an automatic migration.

**Done when.**
- A contractor added from the Costs tab appears on their company profile.
- An accepted turnover item moves the company's Quality dimension off Unrated.
- An awarded quote appears in the company's bid history.
- A test with a fully-populated fixture asserts each dimension is non-null.

*Landed 2026-09-29 (projects Round G, J4 limb): reader half: `gatherCompanyProfiles` derives `awardsTotal` from posted commitment entries on the company's parties (the typed `contract_value` is a labelled fallback), reads quotes through `cost_documents.company_id` OR `party_id`, and reports "unlinked" distinctly from "no work"; the quote upload row passes `partyId`; 20261096 backfills `project_parties.company_id` where the normalised name matches exactly one registry row (second fix pass: every decision is recorded as a `PROJECT_PARTY_COMPANY_BACKFILLED` audit row that drives the UPDATE, listed by the review query at the file's foot and undone by its revert statement). The writer limbs (`saveParty` companyId, turnover/punch `partyId`, the intake quote branch) stay with P11 / PC-1 / PC-5 / PC-7. Fix pass: the derived award base excludes the commitments approved change orders post (`posted_entry_id`, or the CO number on the entry), and every batched read pages past PostgREST's 1000-row cap. Second fix pass: the base is resolved per party — posted commitments where a party has them, that party's `contract_value` otherwise ("mixed" when both contribute).*

**Resolution (2026-10-01, projects Round G — the writer limbs).** The scorecard's three join keys now have writers in the normal workflow (DEC-76 item 3):

- **`project_parties.company_id` from the Costs tab.** `CostParty` / `mapParty` carry `companyId` (J3). The Contractors panel (`CostsTab.tsx` `PartiesPanel`) reads the Known Companies list and offers a **Known company** picker on add — suggested from the typed name (`matchCompanyByName`), changeable to another or to none — and, on an **unlinked** contractor only, a **Link to a known company** action; a linked contractor shows its company (a link to its profile) and offers no relink. `lib/costs.ts` `linkPartyToCompany` writes only where `company_id IS NULL` (a concurrent link is never overwritten; an existing link is never re-pointed — `saveParty`'s edit path refuses a company change), because an award reads the company through the quote's contractor: a contractor whose name could be a do-not-use company, linked to any other company, needs a reason (`needsOverride` → the panel asks and retries), recorded on `COST_PARTY_CREATED` / `COST_PARTY_LINKED`. An unreadable registry never blocks adding (the contractor goes in unlinked, and the panel says so).
- **`turnover_items.party_id` and `punch_items.party_id`.** The Quality tab reads the project's contractors on its own (a failure only hides the picker) and the turnover and punch add rows offer "Contractor (optional)…", passing `partyId` to `addTurnoverItem` / `addPunchItem`; each row shows its contractor. An accepted turnover item and a closed punch item count for the company bound to the item's contractor; an unassigned item or an unlinked contractor's counts for nobody — the company's Quality stays Unrated (null), never 0.
- **`cost_documents.party_id`.** The quote upload passes it (J4); the intake quote branch resolves it from the link's company (J1).

Tests: `mon7Scorecard.test.ts` (7, through the real `gatherCompanyProfile` on an in-memory PostgREST double): a contractor added on the Costs tab appears on its company's profile; link once, never re-point, the update filtered on `company_id IS NULL`; a do-not-use name linked elsewhere needs a recorded reason; an accepted turnover item moves Quality off Unrated while the unassigned and unlinked ones are not counted; a punch item's close-out counts; the Quality add rows pass the contractor; **a fully-populated fixture scores every dimension** (safety, quality, cost, schedule, responsiveness) **and the awarded quote is in the bid history**. `costsContractorLink.test.ts` (4, rendered): the linked / unlinked rows, the link with its suggestion, the asked-for reason, the add form's kind list and suggested company, an unreadable registry.

**Review fix (2026-10-01, projects Round G).** (1) **The wizard meets the same rule.** The project wizard binds its contractor rows to Known Companies by exact name and wrote `company_id` with no check, so a contractor named like a do-not-use company ("Acme Piping Inc" beside a barred "Acme Piping LLC") was linked to the clean one with no reason asked, and its awards would read the clean company. `lib/projectWizardWrites.ts` now runs every name-bound link through a required `checkPartyLink` dependency — `lib/costs.ts` `checkPartyCompanyLink`, the same `partyLinkCheck` — and, since the wizard cannot ask for a reason, a link that would need one (or that the registry could not be read to check) is left off: the contractor is added unlinked and the wizard says so before it moves on ("… was added without a company link: the name could be …, flagged DO NOT USE … Link it on the project's Costs tab, where the link records a reason."). (2) **What the rule is.** "Set once, never re-pointed; a do-not-use name linked elsewhere needs a recorded reason" is an **app-level rule** — `lib/costs.ts` (`saveParty`, `linkPartyToCompany`, `checkPartyCompanyLink`) and the wizard — with **no database enforcement**; DEC-76 item 3 is reworded to say so. Tests: `projectWizard.test.ts` (the refused link goes in unlinked with its note; the clean one is written; an unlinked row is not checked), `mon7Scorecard.test.ts` (9, +2: `checkPartyCompanyLink` refuses the do-not-use look-alike, passes the clean name and the barred company itself, writes nothing; the wizard wiring is required).

**Second review fix (2026-10-01, projects Round G) — the normal workflow.** The review above ticked done-when 2 while the normal workflow still missed it: the standard turnover package comes from `seedTurnoverItems` (the wizard, and the Quality tab's **Seed required contents**), which wrote no `party_id`, and nothing on screen could assign a contractor to a seeded or existing item — so a PM who seeded the package, linked the contractor on the Costs tab and accepted every deliverable still saw the company's Quality as Unrated. Built now: (1) **an assignment control on every turnover and punch row** (`components/projects/QualityTab.tsx` — a compact contractor select on the row, shown to whoever may manage the tab while the item is unassigned or undecided), writing through `lib/turnover.ts` `assignTurnoverContractor` / `assignPunchContractor` (one `assignContractor`): the contractor must belong to the item's own project; an **unassigned** item may be assigned at any status — so a package seeded and accepted before anyone named its contractor reaches the company; an **assigned** item changes contractor (or is cleared) only while undecided (turnover not received / received; punch open), so a standing acceptance, a rejection's nonconformance or a close-out never moves from one company's record to another's ("This turnover item is accepted — its contractor stays as recorded. Reopen it to change who it counts for."). The UPDATE is guarded on the contractor and the status the caller saw (`.eq("status")` + `.eq/.is("party_id")` — a concurrent decision or reassignment is refused, never overwritten), checked (`checkedWrite`, GAP-402) and audited (`TURNOVER_CONTRACTOR_SET` / `PUNCH_CONTRACTOR_SET`, from / to / status). A `party_id`-only UPDATE passes the existing rails: `turnover_items_decision_rail` and `punch_items_void_rail` fire on other columns, `turnover_items_signoff_rail` keeps a standing sign-off untouched, the QUAL-12 org trigger checks the org, and a closed project's records stay read-only (20261103). (2) **A contractor picker beside Seed required contents**, passed to `seedTurnoverItems` (`partyId`, already a parameter) — a package can be seeded straight onto its contractor. The wizard still seeds without one (it has no single contractor to choose); its items are assigned on the row. Tests: `mon7Scorecard.test.ts` (14, +5, through the real `gatherCompanyProfile`): the package seeded with no contractor and accepted is Unrated; each seeded item assigned on the row moves Quality off Unrated ("turnover 3/3 accepted"), the update filtered on id / org / status / `party_id IS NULL` and audited; the seed carries the picked contractor; a decided item keeps its contractor (re-point and clear refused), a contractor from another project is refused, a refusal writes nothing, an undecided item moves and is audited from → to, a stale view (decided meanwhile) is refused by the guard; a closed punch item is assigned after the fact and its close-out counts, then keeps its contractor; the Quality tab's wiring (row controls, the seed picker).

**Third review fix (2026-10-01, projects Round G) — a decided item is never attributed by one keystroke, and a rejection never to a company nothing could correct.** The second fix's claim that "a standing decision never moves to another company's record" held only for items that already had a contractor. The row control wrote a decided item's contractor the moment its select changed — a keyboard arrow on a closed select fires `change` (Chrome on Windows, Firefox) — with no confirmation; once written, a decided item's contractor is never changed again; and a REJECTED item had no way back at all (Reopen is for accepted / waived; a rejected item can only become accepted), so one keystroke could put a nonconformance permanently on the wrong company's Quality score (`companyScore.ts`: accepted / (accepted + rejected)). Now, in `components/projects/QualityTab.tsx`: an **undecided** item's pick is still its write — it can be changed while undecided; a **decided, unassigned** item — accepted or waived turnover, closed or voided punch — shows the select beside an **Assign** button (`LateContractorAssign`): the pick writes nothing, and Assign asks first (`confirmLateContractor` → `appConfirm`), naming the item, the contractor and the Known Company it will count for (read with `getCompany`; an unreadable company is named by the contractor's link, an unlinked contractor is said to count for nobody until it is linked on the Costs tab), what that does to the Quality score (an acceptance or a close-out counts; a waived or voided item is not scored), and that the name is permanent ("can't be changed afterwards without reopening the signed acceptance / waiver and signing it again"; punch: "can't be changed afterwards" — the app has no punch reopen); a **rejected** item has no control and says "no contractor — name one once the resubmission is accepted". `lib/turnover.ts` `assignContractor` refuses that case as well (`lateNameable`: an unassigned rejected turnover item is refused with the reason, writing and auditing nothing; accepted / waived turnover and closed / voided punch pass) and says "Reopen it to change who it counts for" only where the app has a reopen (`reopenable`: turnover accepted / waived — not punch). **Inactive contractors** (minor): the tab kept only active contractors, so an item assigned to one later set inactive showed "No contractor" in its open-row select and nothing at all to a viewer. The tab now keeps every contractor (`contractorNames` marks an inactive one "(inactive)"); `ContractorPicker` offers the active ones plus the one already chosen (marked inactive, or named "a contractor not on this project's list" when it is missing); only the add, seed and Assign pickers leave inactive contractors out (`pickableContractors`). Tests: `qualityTabContractorAssign.test.ts` (8, the rendered tab — 7 fail on the previous tab): a decided item's pick calls neither `assignTurnoverContractor` nor `assignPunchContractor`; Assign asks with the exact sentence (item, contractor, company, permanence) and writes only on yes, a decline writes nothing; the unlinked, unreadable-company and waived wording; a rejected item has no control; an undecided item's pick still writes; an inactive contractor named on a decided row and selected (marked) on an open one, absent from the add / seed / Assign pickers. `mon7Scorecard.test.ts` (15, +1, and the wiring pin rewritten): an unassigned rejected item is refused, writes nothing, audits nothing and leaves Quality Unrated; a waived item and a voided punch item can be named once; a named voided punch item then keeps its contractor, with no "Reopen it".

**Done-when.**
- ✓ A contractor added from the Costs tab appears on their company profile.
- ✓ An accepted turnover item moves the company's Quality dimension off Unrated — for any item: added with its contractor, seeded onto one, or (seeded / existing, before or after its acceptance) assigned on its row (`mon7Scorecard.test.ts` "the normal workflow: …"); since the third fix a decided item is named only through Assign and a confirm that says it is permanent, and a rejected one only once its resubmission is accepted (`qualityTabContractorAssign.test.ts`).
- ✓ An awarded quote appears in the company's bid history (through the quote's contractor or its own company link).
- ✓ A test with a fully-populated fixture asserts each dimension is non-null.

**Scope / residual.** Remediation 4 (backfilling old rows by name) was 20261096's for `project_parties`. A rejection counts against a company only when its item was assigned before the decision; one rejected while unassigned counts for nobody (never a guessed company) until it is resubmitted, accepted and named. A closed punch item, once named, has no correction path in the app (no punch reopen) — the confirm says so before it writes. Both rules — a contractor's company link set once and never re-pointed (DEC-76 item 3), and an item's contractor fixed once it is decided (and never named on a rejected item) — are **app-level** (`lib/costs.ts`, the wizard, `lib/turnover.ts`): a member allowed to update `project_parties`, `turnover_items` or `punch_items` can still change them over PostgREST. Enforcing them needs a trigger migration; that is recorded as the new finding `MON-13` below — OPEN, with no owner yet: the integrator assigns a package and a migration number from its queue (J10's brief has no migration). No migration here.

*Integrator fix pass (final review minors, 2026-10-01):* (1) **An unreadable contractors list is said, not shown as data** (`components/projects/QualityTab.tsx`). A failed `listParties` read was only `console.warn`-ed, so every assigned turnover / punch row then read "a contractor not on this project's list" and the pickers vanished without a word. The tab now keeps `contractorsError` and shows an alert — "The project's contractors couldn't be loaded — <reason>. Each item keeps its contractor, but it can't be shown or changed until the list loads." — with a Retry that reads the list again; until the list has answered, an assigned item says "contractor not loaded" ("not on this project's list" is said only once the list loaded without it); the seed picker, both add rows and each unassigned row that could take a contractor (not a rejected one) say why there is no picker. (2) **An undecided item is no longer written by its select.** The third fix kept "an undecided item's pick is its write", so one arrow key on a closed select (which fires `change` in some browsers) assigned the first contractor to an open / received turnover item or an open punch item. The row now shows the select beside **Assign** (no contractor yet) or **Save** (change or clear) — `ContractorSave`: the select alone writes nothing; the button writes, with no confirm, since the item can still be changed while undecided; the item's own contractor stays on offer while another is picked. Decided items are unchanged (Assign and a confirm). (3) **The Costs-tab add says what its registry refusal did** (`lib/costs.ts`). With a Known company picked on add, a do-not-use check that cannot read the registry refuses the whole `saveParty` insert, but the message said "— nothing was linked", as if the contractor had gone in unlinked; it now says "— the contractor was not added; try again, or add it with no company link." `linkPartyToCompany` keeps "— nothing was linked." The Resolution's "an unreadable registry never blocks adding" holds only when the panel's Known Companies list cannot be read (no company is then picked and no check runs) — not in this case. Tests: `qualityTabContractorAssign.test.ts` (11: +3, one rewritten; rendered — the alert and its Retry, "contractor not loaded" and never "not on this project's list" while the list is unread and the reverse once it loaded, each picker's reason; a select change alone calls neither `assignTurnoverContractor` nor `assignPunchContractor`, Assign / Save does, clearing is a Save), `mon7Scorecard.test.ts` (16, +1: both registry messages, the refused add writes no row, the wizard's note unchanged). Not changed here: DEC-76 item 3 still says "while the item is undecided its pick is its write and can be changed" — now it is written by Assign / Save and can still be changed; `audit-reports/DECISIONS.md` is outside this pass's files, so the integrator rewords it at merge.

---

## MON-8 · An unmapped document status throws inside the award path, hanging the button forever

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects-joint J13 RECORDS RECONCILE (new; the remainder appears landed — independently verified before any flip) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** availability
- **Locations:**
  - `lib/costDocs.ts:181` — `COST_DOC_STATUS_LABEL[fresh.status].toLowerCase()`
  - `components/projects/cost/QuotesPanel.tsx:221` — awaits with no try/catch
  - `supabase/migrations/20260819_orphan_tables_backfill.sql:184` — `status` is plain `text NOT NULL`, no CHECK
- **Related:** `REL-4`
- **Re-verified:** hardening pass — **SURVIVES**. `COST_DOC_STATUS_LABEL[fresh.status].toLowerCase()` (`costDocs.ts:181`) — an unmapped status makes the lookup `undefined` and the method call throws inside the award path, after `setBusy` and before any `setBusy(null)`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism and the stuck-button consequence are real, but reachability is the weak link: every in-repo writer (costDocs insert/claim/decline/void, app/api/projects/cost-docs/route.ts:125 `status: "parsed"`, app/api/intake/upload/route.ts:90 `status: "draft"`) writes one of the six. Only an out-of-band write — lib/dataRestore.ts:320 restores cost_documents from an arbitrary export — can produce an unmapped value. A defensive gap behind an unreachable-in-normal-operation precondition is MEDIUM, not HIGH.

**Mechanism.** The lookup returns `undefined` for any status not in the map, and
`.toLowerCase()` throws. `cost_documents.status` carries no check constraint, so
an unmapped value is one restore or hotfix away. The call site awaits
`awardQuote` with no try/catch, so the rejection is unhandled, `setBusy(null)`
never runs, and the Award button spins indefinitely.

**Remediation.** Three independent fixes, all cheap:
1. `COST_DOC_STATUS_LABEL[fresh.status] ?? fresh.status` — the one-line fix.
2. Wrap the `award` call site in try/catch with a `finally { setBusy(null) }`.
3. Add a `CHECK` constraint on `cost_documents.status` and `kind` so an
   unmapped value cannot exist.

**Done when.**
- An unmapped status produces a readable error, not a hang.
- The Award button always clears its busy state.
- The database rejects an unmapped status.
- A test covers the unmapped-status path.

**Partial (2026-09-29, projects Round G).** Joint J3 MONEY-LEDGER. `lib/costDocs.ts` `costDocStatusLabel(status)` is the total lookup (`COST_DOC_STATUS_LABEL[status] ?? status`), used by `claimDocTransition`, `setManualTotal`, `repairCostDoc` and the Costs tab's data-health line; an unmapped status now yields "This document is already <status> — refresh to see the latest" instead of a throw inside the award path. Migration `20261093` adds `cost_documents_status_check` and `cost_documents_kind_check` (NOT VALID, duplicate-guarded — 20260908's shape) so an unmapped value cannot be written; the DEC-30 inventory counts rows outside either set before apply.
- Tests: `lib/__tests__/costDocs.test.ts` "costDocStatusLabel is total; the award path names the odd status instead of hanging"; `lib/__tests__/moneyRailsMigration.test.ts` pins both CHECKs.
- Pending migration: `20261093_prj_roundG_money_rails.sql`.

**Done-when.**
1. ✓ An unmapped status produces a readable error, not a hang.
2. ✗ NOT DONE HERE — the `try/catch` + `finally { setBusy(null) }` around the `award` call is in `components/projects/cost/QuotesPanel.tsx`, P4/J4 BIDTAB's file. With (1) the lib no longer throws on this path, so the button no longer hangs on THIS cause; the belt-and-braces wrap is J4's limb.
3. ✓ The database rejects an unmapped status or kind (once `20261093` is applied).
4. ✓ A test covers the unmapped-status path.

**Scope / residual.** Open until J4 lands the call-site wrap. `REL-4`'s money-table half rides here.

**Resolution (2026-10-01, projects Round G).** Record reconcile by package J13 RECORDS RECONCILE: no application code or migration changed here. The package's review fix pass added the render test that pins done-when 2, which no earlier package had committed. Done-whens 1, 3 and 4 landed with joint package J3 MONEY-LEDGER (commit `ff3c1a8`, migration `20261093`; merge `9b4c5f4`). The limb left open was the `try / catch / finally { setBusy(null) }` around the award call. It landed with J4 BIDTAB's fix pass (commit `5f8e114`, merge `0a8cc63`) and kept its shape through the J3 × J4 integration in `9b4c5f4`. The record was never flipped. Verified against HEAD `4dd0df7`.

**Done-when.**
1. ✓ An unmapped status produces a readable error, not a hang. `lib/costDocs.ts:113-115` `costDocStatusLabel` (`COST_DOC_STATUS_LABEL[status] ?? status`) is used on the award path by `claimDocTransition` (:235), and by `setManualTotal` (:738) and `repairCostDoc` (:853). Test: `costDocs.test.ts` "costDocStatusLabel is total; the award path names the odd status instead of hanging" (:241), exit 0 (63 passed).
2. ✓ The Award button always clears its busy state. In `components/projects/cost/QuotesPanel.tsx:665-689`, every await between `setBusy(doc.id)` (:665, :683) and the end runs inside `try { … } catch { failure = … } finally { setBusy(null); }`; an early `return` inside the `try` still runs the `finally`. The button is `disabled={busy || …}` and shows a spinner while busy (:1092-1094). Test: `lib/__tests__/quotesPanelAwardAndQuoteLinks.test.ts`, a jsdom render of the bid tab, exit 0 (4 passed). "awardQuote THROWS: the error is surfaced and Award is enabled again, with no spinner" (:124). "the lib asks for an override and the retry THROWS: busy still clears, and the recorded override is closed as abandoned" (:138) covers the `needsOverride` retry, which re-sets busy inside the `try`. With the `finally` removed (a mutation check, reverted), both cases fail.
3. ✓ The database rejects an unmapped status or kind: `supabase/migrations/20261093_prj_roundG_money_rails.sql:218-227` (`cost_documents_status_check`, `cost_documents_kind_check`, NOT VALID and duplicate-guarded; probed at :310). These are the only definitions. Test: `moneyRailsMigration.test.ts` "CHECK constraints on cost_documents.status and kind are NOT VALID and duplicate-guarded (20260908's shape)" (:151), exit 0 (24 passed).
4. ✓ A test covers the unmapped-status path: done-when 1's test.

**Scope / residual.** Pending migration: `20261093` (DEC-30). NOT VALID binds new writes at once, and the inventory counts the existing rows outside the sets. `StatusChip` (`QuotesPanel.tsx:962-972`) still indexes `COST_DOC_STATUS_LABEL[status]` directly, so an unmapped status renders a blank chip there: no throw and no hang, and impossible once the CHECK binds. `REL-4`'s money-table half is done-when 3 here; `REL-4` stays its own record.

---

## MON-9 · Two simultaneous change-order proposals collide on the generated number

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `lib/changeOrders.ts:88-110` — read-max-then-insert, no retry
  - `lib/companies.ts:134-136` — `saveCompany`, which maps 23505 correctly
- **Re-verified:** hardening pass — **SURVIVES**. `co_number` is derived by reading the last 50 rows and taking the max (`changeOrders.ts:88-93`) with no unique constraint and no counter — two concurrent proposals read the same maximum.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The race exists, but the stated harm (two COs colliding on a number) cannot land — the unique index rejects the loser. The residual defect is only that changeOrders.ts:111 `throw new Error(error.message)` surfaces a raw "duplicate key value violates unique constraint" with no retry, whereas the neighbouring file handles precisely this at lib/companies.ts:134-136 `if (code === "23505") throw new Error(\`"${row.name}" is already in the registry.\`)`. A cosmetic error message on a rare race is LOW.

**Mechanism.** Read the maximum number, add one, insert against a unique index,
with no retry. Both proposals compute `CO-004`; the loser gets the raw
constraint text in the form.

**Remediation.** Catch `23505` and retry with a recomputed number (bounded, say
three attempts), then fall back to a human message matching `saveCompany`'s
precedent. Or move numbering into a database function with a sequence per
project.

**Done when.**
- Two concurrent proposals both succeed with distinct numbers.
- A genuine collision produces a human message, never raw constraint text.

**Resolution (2026-09-29, projects Round G).** Joint J3 MONEY-LEDGER. `lib/changeOrders.ts` `proposeChangeOrder` retries a `23505` up to three times: each attempt re-reads the project's maximum and takes `max(maxN + 1, lastTried + 1)` — so a rival whose row is not yet visible is stepped past instead of collided with again, and a visible one is simply counted. After three collisions the user reads "Another change order was numbered at the same moment — try again and it will take the next number." (the `saveCompany` precedent), never the constraint text. Any other insert error surfaces as before.
- Tests: `lib/__tests__/costDocs.test.ts` — "two concurrent proposals both succeed with distinct numbers — the loser retries past the collision" (CO-001 live, CO-002 collides → CO-003), "three collisions produce a human sentence, never the constraint text".
- Reproduced at the base commit: read-max-then-insert with `if (error) throw new Error(error.message)`.

**Done-when.**
1. ✓ Two concurrent proposals both succeed with distinct numbers.
2. ✓ A genuine collision produces a human message, never raw constraint text.

**Scope / residual.** No per-project sequence at the database (the unique index `change_orders_project_number_key` remains the arbiter); a numbering gap after a stepped-past collision is possible and preferred over a second collision. No migration.

---

## MON-10 · A losing bid reads "under review" forever unless it shares an RFQ group

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** projects-joint J14 PROJECTS FOLLOW-UPS (done-when 2, the contractor's notice of an award or decline, through the contractor-notice path J12 builds for intake outcomes) — by the integrator, 2026-10-02 (at the J10b merge: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** ux / vendor relations
- **Locations:**
  - `lib/costDocs.ts:250-251` — the rival-declining filter
  - `app/api/intake/upload/route.ts:127` — the portal's promise
  - `app/submit/[token]/page.tsx:195-199` — the status chip
- **Related:** `BID-10` (free-text group), `MON-11` (no notifications)
- **Re-verified:** hardening pass — **SURVIVES**. `const rivals = … && !!fresh.rfqGroup && d.rfqGroup === fresh.rfqGroup` (`costDocs.ts:250-251`) — an ungrouped quote has no rivals, so nothing is ever marked not-selected.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and the ungrouped case is not exotic: the RFQ group on a quote link is optional ('RFQ group (optional)', QuotesPanel.tsx:605) and app/api/intake/upload/route.ts:57,88 copies whatever the link holds — null included — into cost_documents.rfq_group. There is also no manual escape for such a bid: a parsed quote with an extraction renders only in the econ table, which has no Void control (QuotesPanel.tsx:309-316), so its portal status is stuck at 'under review' indefinitely. MEDIUM is appropriate — it is a courtesy/communication defect, not a money defect.

**Mechanism.** Awarding marks rival bids declined only within the same non-null
`rfq_group`. An ungrouped quote is never marked. Combined with the portal's
promise — *"You'll be contacted about the award decision"* — and the fact that
no notification is ever sent on award or decline, the contractor's only signal
is a status chip that never changes.

**Remediation.** Fix `BID-10` (normalize the group) first. Then either require
an RFQ group on quote upload, or decline by project-and-account rather than by
group. Send the notification promised at `upload/route.ts:127`.

**Done when.**
- Every losing bid on an awarded scope reaches a terminal status.
- The contractor is notified of the outcome.

**Partial (2026-09-29, projects Round G).** Joint J3 MONEY-LEDGER (brief: "costDocs decline-all-rivals"). The award's rival rule stays the base's — a GROUPED award declines every still-open quote in its RFQ group; an UNGROUPED award declines nothing on its own. The first cut of this fix declined every other open ungrouped quote on the project, which the fix-pass review showed marks unrelated scopes "not selected" with no way back (ungrouped quotes tabulate alone — `quoteGroups` gives each its own "Ungrouped — <vendor>" heading — and the intake-link case, the common one, copies a null group); that rule was withdrawn. What landed in `lib/costDocs.ts`:
- `awardQuote`: the group decline is a checked write (`COST-11`) — `{ error }` and the matched count are read and a shortfall is returned as `{ ok: true, warning }` ("Awarded, but N of M competing bid(s) could not be marked not-selected — refresh and decline them by hand"); already-decided rivals are never touched (`.in("status", ["draft","parsed"])`). An ungrouped award returns `{ ok: true, warning }` naming the other ungrouped quotes that stay open ("Awarded. 2 other ungrouped quotes stay open (Bravo Plumbing, Cole Paint) — decline them if they competed for this scope."). The audit row records `rivalsConsidered`, `rivalsDeclined` and `ungroupedLeftOpen`.
- `declineQuote({ doc, actor, reason? })` (new): the explicit, audited decline — draft|parsed → declined through `claimDocTransition` (no `posted_at` stamp), `COST_DOC_DECLINED` with vendor, group and reason; refuses an invoice and an already-decided quote with its real status.
- `voidCostDoc` / `setManualTotal` admit `declined` (`MON-3`), so a wrongly declined document has a terminal (void) and a correction (typed total, stays declined) path.
- Tests: `lib/__tests__/costDocs.test.ts` — "posts the commitment…declines the group's open rivals…" (grouped: only the group's open rival flips; the ungrouped quote stays parsed), "an UNGROUPED award declines NOTHING — unrelated ungrouped bids stay awardable and the caller is told which stay open" (the Acme Electrical / Bravo Plumbing shape; Bravo is then awarded on its own), "declineQuote is the explicit, audited decline…", "a grouped award names no ungrouped quotes", "a failed rival-decline is a PARTIAL outcome", "a DECLINED document moved no money…".
- Review fix pass 2: the rival filter compares RFQ groups by KEY — case-folded, whitespace collapsed, the same key J4's bid tab tabulates by (`rfqGroupKey`) — so "Piping" and "piping " (an intake-link copy) are one scope and the award declines the rival the table shows beside it. Test: "the award compares RFQ groups by key — 'Piping' declines the open 'piping ' bid the table shows beside it".
- Decision (DEC-50 rule 8, amended): the RFQ group is the scope handle; an ungrouped competing bid is declined by hand; the portal renders whatever status this sets (P1).

**Done-when.**
1. Partly — every losing bid on a GROUPED awarded scope reaches `declined` automatically (checked write). An ungrouped losing bid reaches it only when someone declines it: `declineQuote` exists and `awardQuote`'s warning names the open ungrouped quotes, but both reach the user only through QuotesPanel, J4's file. **Pointer to J4 (BIDTAB):** `components/projects/cost/QuotesPanel.tsx:221-223` must render `res.warning` after an award (`if (res.warning) setErr(res.warning)`), and offer a "Decline" action calling `declineQuote` on open ungrouped quotes (and a Void on declined rows, now allowed); the award confirm at `:218` ("…marks the other bids not selected") should say "the other bids in this group" so an ungrouped award does not promise a decline it does not make.
2. ✗ NOT DONE HERE — the contractor is external and has no user id; `lib/notify` has no vendor-email kind and the notifications area keeps the taxonomy (PROD-6). The award notice this round (`MON-11`) reaches the project owner and followers; the vendor's signal is the portal status chip P1 renders from the status this sets.

**Scope / residual.** Open on the J4 panel wiring (warning + Decline control) and the contractor notification. `BID-10` (group normalisation) is J4's and would make the grouped rule catch more real competitors.

**Partial (2026-10-01, projects Round G).** Package J10b UI REMAINDERS wired J3's pointer into `components/projects/cost/QuotesPanel.tsx`.
- **The award's warning is shown.** `awardQuote` returns `{ ok: true, warning }` when rivals could not be marked not selected, or when ungrouped quotes stay open, and names them. The panel captures the warning and sets it on its notice after the re-read, so the refresh does not wipe it.
- **The award confirm no longer promises a decline it does not make.** A grouped quote's confirm says "… and marks the other open bids in this RFQ group not selected.". An ungrouped one's says "This quote has no RFQ group, so no other bid is marked not selected — decline any that competed for this scope.".
- **"Decline" on every open quote the award's warning can name** (`mayDecline` in `BidGroup`: `doc.kind === "quote"`, status `parsed` or `draft`, and either no RFQ group or a group that already holds an award). It is gated apart from the award gate (`rowActions`), and the open document's Void goes with it.
  - In the bid table: an open ungrouped quote, and any open quote in an awarded group. That covers a second quote from the same vendor, since `quoteGroups` keys every ungrouped quote as "Ungrouped — <vendor>" and `mergeQuoteGroups` case-folds the key, so an original and its revision tabulate as one field and awarding one leaves the other open in an awarded group. It also covers a grouped rival whose automatic decline failed, which the warning tells the user to "refresh and decline them by hand".
  - In the "not read yet" strip: an unread (`draft`) quote on the same rule, so a quote the warning names can be declined without reading it first.
  - *Second review fix:* the first passes nested Decline and the open Void inside `rowActions` (`!awarded`). In both cases above the warning told the user to decline a quote the table offered no control for, and the record wrongly marked done-when 1 as met.
  - It opens an `appPrompt` for an optional reason: "It is marked not selected — the contractor's portal shows that — and it can no longer be awarded …".
  - It then calls `declineQuote({ doc, actor, reason })`.
  - A cancelled prompt writes nothing. A refusal is said and nothing is re-read.
  - The button carries the decision floor (`A11Y-14`).
- **Void on a declined bid.** It goes through `lib/costDocs.voidCostDoc`, which admits `declined`, not through the panel's open-only void. It is offered on every declined row, including one in an RFQ group that has an award — the common case, since a grouped award declines its rivals. The bid table keeps its actions column (header, cells and the note row's `colSpan`) while an awarded group still has a table row with an action, either a declined bid or an open quote (`showActions` in `BidGroup`). Award and "correct total" stay gated on no award (`rowActions`). *Review fix:* the first pass rendered the actions column only in a group with no award, so the Void was reachable only on a hand-declined ungrouped quote alone in its group.
- **The status chip.** The bid table's status chip reads through `costDocStatusLabel` (`REL-4`).
- Tests: `lib/__tests__/j10bQuotesAwardDecline.test.ts` "MON-10 —" (11, rendered):
  - an ungrouped award's confirm, and its warning, which persists;
  - a grouped award's confirm, and no warning on a clean award;
  - Decline offered on an open ungrouped quote only, with its reason;
  - a cancelled Decline and a refused one;
  - a declined bid's Void through `voidCostDoc`;
  - an awarded bid and a declined bid in one RFQ group: the declined row offers Void (through `voidCostDoc`), the awarded row offers nothing, and the header and every row have 8 cells;
  - an awarded group with no declined bid has no actions column (7 cells);
  - (second review fix) two same-vendor ungrouped quotes, one awarded. The other row offers Decline and Void and never Award or "correct total", every row has 8 cells, and Decline calls `declineQuote` with the reason;
  - (second review fix) a grouped rival left open in an awarded group offers Decline, and its Void is the open document's guarded write, not `voidCostDoc`;
  - (second review fix) an unread ungrouped quote is declined from the "not read yet" strip, and an unread grouped one in an unawarded group is not;
  - (second review fix) an unread quote in an awarded group is declined from the strip, and the group, with no table row needing an action, draws no actions column.

  The four new tests fail against the panel as it was before this fix, which was checked by stashing the panel and running them.

**Done-when.**
1. ✓ Every losing bid on an awarded scope can reach a terminal status. A grouped rival gets there automatically (J3). Any quote still open after an award gets there through the hand decline, per DEC-50 rule 8. That covers an ungrouped quote, a same-vendor quote in the award's own field, a grouped rival whose automatic decline failed, and an unread quote. The award's warning names the quote and the bid table offers its Decline. The rendered tests above cover each case.
2. ✗ The contractor is notified of the outcome. Not done, and unchanged since 2026-09-29: the contractor has no user id, and `lib/notify` has no vendor-email kind (the notifications area keeps that taxonomy, PROD-6). The portal status chip renders the status the decline sets.

**Scope / residual.** OPEN for the contractor notification only (notifications area). `BID-10` group normalisation is J4's.

---

## MON-11 · Only one event in the entire controls program notifies anyone

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** notifications N8 PRODUCERS-FREE (the turnover-rejection emit in lib/turnover.ts) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** process
- **Locations:**
  - `app/api/intake/upload/route.ts:104-113` — the one notifying event (quote received, in-app only)
  - `lib/changeOrders.ts`, `lib/turnover.ts`, `lib/checklists.ts`, `lib/costDocs.ts`, `lib/companies.ts` — no notification imports at all
  - `app/api/intake/upload/route.ts:349-385` — the document branch, which does the full job
- **Re-verified:** hardening pass — **SURVIVES**, by census. The only `notifications` insert anywhere in the controls program is the intake one (`intake/upload/route.ts:104-113`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by repo-wide search. Award, decline, change-order approval, invoice posting, turnover and checklist events all move money or obligations and none of them touch the notifications table or lib/notify/dispatch, even though the plumbing exists and is used heavily elsewhere (lib/reviewControl.ts, lib/holds.ts, lib/retention.ts, lib/distributionAcks.ts). The other notification inserts in the same route (:197, :349) belong to the document-intake path, not the controls program, so 'only one event' stands.

**Mechanism.** No `notifications` insert, no `email_notifications` insert, no
`inAppNotifications` import in any of the five new data libraries or the three
new API routes.

**Silent:** award, decline, invoice posted, change order proposed / approved /
rejected, turnover received / accepted / rejected / waived, punch added or
closed, checklist created / assessed / completed, company event logged, quality
manual confirmed.

**Remediation.** Pick the events that genuinely need a human to act — award,
change-order approval, turnover rejection, checklist completion — and wire them
to the existing notification helper. Reuse the document branch's pattern
(in-app + queued email + drain kick). Do not notify on everything; the tab
already shows state.

**Done when.**
- Awarding notifies the affected party and the project owner.
- A change-order approval notifies the proposer.
- A turnover rejection notifies whoever is responsible for the item.

**Partial (2026-09-29, projects Round G).** Joint J3 MONEY-LEDGER — the two emits this package owns, through `lib/notify/dispatch.emit` with existing kinds only (no taxonomy change): `lib/costDocs.ts` `notifyAward` (after a successful award: category `status`, kind `project_status`, audience = the project owner + followers of the project, actor excluded; body names the vendor, the scope and the posted amount; link to the Costs tab) and `lib/changeOrders.ts` `notifyApproval` (after a successful approval: the proposer, `created_by`, unless they decided it themselves). Both are best-effort behind the money (a failed emit is logged, never fails the award/approval).
- Tests: `lib/__tests__/costDocs.test.ts` — the award test asserts one emit with `involved: ["u-owner"]`, `resource: { type: "project" }`; "an approval notifies the proposer (and not the decider)".
- Reproduced at the base commit: no notification import in either library.

**Done-when.**
1. ✓ Awarding notifies the project owner (and project followers); the "affected party" (the vendor) is external — see `MON-10`.
2. ✓ A change-order approval notifies the proposer.
3. ✗ NOT DONE HERE — the turnover-rejection emit is P2/J2 QUALITY's limb (`lib/turnover.ts`).

**Scope / residual.** Open until J2 lands the turnover emit. notifications `PROD-6` should point at these two call sites for the cost/CO half.

---

## MON-12 · A company flagged "do not use" can still be awarded work

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** projects-joint J12 SERVER REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** process / governance
- **Locations:**
  - `lib/costDocs.ts:211` — `awardQuote` never checks company status
  - `components/projects/cost/QuotesPanel.tsx:289-291` — the red chip
  - `app/(protected)/companies/[id]/page.tsx:522` — the tooltip claiming it "flags the company across the app"
  - `lib/companies.ts:24` — `inactive`, which changes nothing at all
- **Related:** `BID-12` (the name match that often prevents the chip rendering at all)
- **Re-verified:** hardening pass — **SURVIVES**. `awardQuote` (`costDocs.ts:211`) takes no company status and applies no check, while the UI renders a `do_not_use` badge two lines from the Award button (`QuotesPanel.tsx:289-291`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on every point: the chip is advisory-only, awardQuote has no company-status check and records no override in its audit payload (lib/costDocs.ts:256-259), the name match is exact-string, and a failed listCompanies silently blanks the flag for every bidder. MEDIUM is right — it is an advisory control, not a hard one.

**Mechanism.** The flag renders as a red chip on the bid tab and on the card,
and blocks nothing. `awardQuote` never reads company status. The sibling status
`inactive` is not filtered from `listCompanies`, not flagged in the bid tab, and
not blocked at selection — a grey word only.

**Failure scenario.** A blacklisted contractor is awarded work with no
resistance and no recorded override. Worse, per `BID-12`, the chip frequently
does not render at all because the name match is exact string equality — and
per report `01`'s note on the company-list fallback, a failed load removes the
flag from every bidder while the table still looks normal.

**Remediation.** Have `awardQuote` look up the company (by `company_id` once
`MON-7` is fixed, not by name) and refuse a `do_not_use` award without an
explicit override that captures a reason and writes an audit row. Decide what
`inactive` means and either implement it or remove it.

**Done when.**
- Awarding a `do_not_use` company requires an explicit, reasoned override.
- The override is audited.
- `inactive` either has behaviour or no longer exists.

*Landed 2026-09-29 (projects Round G, J4 limb): the bid-tab chip (`QuotesPanel.tsx`) renders from the bound registry company (`cost_documents.company_id`, 20261096) or the normalised name match, so realistic letterhead variants resolve (BID-12); a failed registry load is announced instead of blanking the flag; and the award flow refuses a do-not-use company unless a reason is typed and recorded (`COST_DOC_AWARD_OVERRIDE_DO_NOT_USE`, insert `{ error }`-checked — a failed record stops the award). The posting-side refusal in `awardQuote` and the meaning of `inactive` close in P3 / PC-7.*

*Fix pass 2026-09-30 (projects Round G, J4): the bid-tab gate no longer fails open — Award is withheld while the registry or the project's bidder-link read is loading or failed, the award re-reads the row's `company_id` and the registry at the click, the override row is written only after every confirmation (and closed with `COST_DOC_AWARD_OVERRIDE_ABANDONED` if the award then fails), and re-linking a bidder away from a do-not-use company needs a typed, audited reason. Companies-page limb (`app/(protected)/companies/[id]/page.tsx`, the status select's tooltip): it no longer promises the flag "across the app"; it states what is enforced — the bid-tab chip and the typed override on award and on re-linking, with the posting refusal pending in P3 / PC-7.*

*Second fix pass 2026-09-30 (projects Round G, J4 — review findings): the first fix pass regressed the chip and gate for two registry rows that normalise alike (the bid bound to neither and the flag vanished) and matched against the 1000-row name list. The flag and the award gate now read the org's barred rows in full (`lib/companies.listBarredCompanies`) and fire on ANY row the bidder's name could be (`lib/bidTab.barredCompanyFor`, DEC-48: binding refuses ambiguity, gating does not); an ambiguous bidder shows "ambiguous — link to registry" beside "do not use? · <name>". A decided bid's company link no longer moves from this screen.*

**Partial (2026-09-29, projects Round G; corrected in review fix pass 2).** Joint J3 MONEY-LEDGER — a LIB-LEVEL refusal in `lib/costDocs.awardQuote` (the QuotesPanel chip is P4/J4's; the companies page tooltip at `:522` is P9's). It runs in the caller's session — `lib/costDocs.ts` is imported by a client component — so it is NOT a server-side or database rail: RLS still lets the controller / project owner write `status = 'awarded'` directly through PostgREST (no DB rail is built here; that would be a trigger reading the registry on the award transition — recorded, not done). The earlier "server-side refusal" wording overstated it. `companyBehind(doc, raw)` resolves the company by the document's OWN registry link first (`cost_documents.company_id`, J4's `20261096` column, read from the re-read row so it is simply absent before that migration), then the party's (`project_parties.company_id`; `CostParty.companyId` and `saveParty`'s patch carry it), then an exact case-insensitive name with a single match. Review fix pass 2: every lookup read FAILS CLOSED — a failed read refuses the award ("Couldn't check the company registry (…) — try again; an award is not made without that check") instead of resolving to "no company" and passing. The check runs against the row as re-read inside `claimDocTransition`, before the claim's UPDATE. `awardQuote` refuses a `do_not_use` OR `inactive` company unless the caller passes `overrideReason`; the override is audited by THIS function as `COST_DOC_AWARD_OVERRIDE` (`companyId`, `companyName`, `companyStatus`, reason) after the post, and the award's own audit row carries the company id and the override. `inactive` therefore has behaviour: refused at award unless overridden, same path as `do_not_use` (decision default from the brief; DEC-50 rule 9).
- Tests: `lib/__tests__/costDocs.test.ts` — "a do-not-use company (by the party's registry link) needs a reasoned override, which is audited by company id", "an inactive company matched by exact name is refused the same way; an unknown vendor is not blocked", "a failed company lookup REFUSES the award instead of passing it", "the document's own registry link (cost_documents.company_id) outranks the party and the name".
- Reproduced at the base commit: `awardQuote` read no company status.

**Done-when.**
1. Partly — awarding a `do_not_use` company through the app's award path requires an explicit, reasoned override (lib refusal, fail-closed lookups). Two gaps: there is no database rail (a direct PostgREST status write is not checked), and the UI override cannot complete until J4 wires it. **Pointer to J4 (BIDTAB, `components/projects/cost/QuotesPanel.tsx` `award`, `fleet/J4-bidtab-registry` :374 / :409):** pass the typed reason as `awardQuote({ …, overrideReason: reason.trim() })`, DROP the panel's own pre-award `COST_DOC_AWARD_OVERRIDE_DO_NOT_USE` audit insert (the lib writes `COST_DOC_AWARD_OVERRIDE` after a successful post — a panel row written first records overrides for awards that may never happen), and prompt for `inactive` as well as `do_not_use` (the lib refuses both). Until then a flagged company cannot be awarded from the UI — the safe direction.
2. ✓ The override is audited (company id + reason), by the lib, only for an award that posted.
3. ✓ `inactive` has behaviour (refused at award without an override).

**Scope / residual.** OPEN for the J4 wiring (dw1) and the absent database rail. The exact-name fallback is `BID-12`'s known weakness; the registry links (`cost_documents.company_id`, then the party's) are the durable keys.


**Integration (2026-09-30, projects Round G — J3 merged onto J4).** The UI override now completes: the panel passes the typed reason to `awardQuote({ …, overrideReason })`, and when the lib finds a flag the table did not (an `inactive` company, or a registry link read differently) it returns `needsOverride`, the panel asks for the reason, records the intent and retries once (`QuotesPanel.tsx` `award`; `lib/costDocs.ts` `awardQuote`). J3's pointer asked to drop the panel's own pre-award row; it is kept instead, because it is written before money moves and is fail-closed. The trail now reads intent (`COST_DOC_AWARD_OVERRIDE_DO_NOT_USE`, the panel, before the post) → completed (`COST_DOC_AWARD_OVERRIDE`, the lib, after the post), or intent → abandoned (`COST_DOC_AWARD_OVERRIDE_ABANDONED`). The companies-page status tooltip no longer says the posting refusal is pending. Pinned by `quotesPanelRender.test.ts` "the override reason reaches the lib …", "a flag the lib finds and the table did not (an inactive company) …", "no reason for a lib-found flag …" and by `costDocs.test.ts`'s MON-12 cases asserting `needsOverride`. Still OPEN for the one remaining gap in Done-when 1: no database rail (a direct PostgREST status write to `awarded` is not checked against the registry).

---

## MON-13 · The contractor-link and item-contractor rules are enforced only in the browser

*Numbered MON-13 on this branch (opened by projects Round G J10's second review fix). If the number collides at merge the integrator renumbers.*

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** projects-joint J12 SERVER REMAINDERS (a trigger migration enforcing the contractor-link and item-contractor rules) — by the integrator, 2026-10-01 (at the J10 merge; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED (by reading; not exercised against a live database)
- **Blast radius:** process / governance
- **Locations:**
  - `lib/costs.ts` `saveParty` / `linkPartyToCompany` / `checkPartyCompanyLink` — the link is written only where `company_id IS NULL`, and a do-not-use look-alike needs a recorded reason (DEC-76 item 3)
  - `lib/turnover.ts` `assignContractor` — an item's `party_id` changes only while it is undecided, and an unassigned rejected turnover item is not named
  - `supabase/migrations/20261013_project_controls_program.sql` (`project_parties`, `turnover_items`, `punch_items`), `20261136_prj_roundG_quality_signoff.sql` (`turnover_items_write` / `punch_items_write`) — no trigger guards `company_id` or `party_id`
- **Related:** `MON-7`, `COST-12`, `MON-12`, DEC-76 item 3
- **Independently verified:** — (`author`: opened by projects Round G J10's second review fix from the reviewer's minor on DEC-76 item 3, per `DEC-31`; not yet challenged)

**Mechanism.** An award reads its company THROUGH the quote's contractor, and the scorecard counts a turnover or punch item for the company of the item's contractor. The rules that keep those links honest — a contractor's Known Company link is set once and never re-pointed (a do-not-use look-alike linked elsewhere needs a recorded reason), and a decided item's contractor stays as recorded — live in the browser libraries. The write policies let the same people update the columns directly.

**Failure scenario.** A project owner (or a quality.sign_off holder, for an item) updates `project_parties.company_id` — or a decided `turnover_items.party_id` — over PostgREST: a barred contractor's awards then read a clean company, or an accepted item's credit moves to another company's scorecard, with no reason and no audit row.

**Remediation.** One migration: a `BEFORE UPDATE OF company_id ON project_parties` trigger refusing a non-null OLD value changed to a different NEW one for a signed-in caller (the service pass and an `ON DELETE SET NULL` one trigger level down pass, as the 20261091 / 20261103 rails do); and a `BEFORE UPDATE OF party_id` trigger on `turnover_items` / `punch_items` refusing a change of a non-null OLD value unless the row is undecided (turnover `open` / `received`; punch `open`), and (J10's third review fix) refusing a NULL → contractor change on a `rejected` turnover item. The do-not-use reason stays an app-level confirmation unless the link moves server-side. A shape test per trigger (DEC-30; no widening).

**Done when.**
- A direct PostgREST update re-pointing a linked contractor's company is refused.
- A direct update moving a decided turnover or punch item to another contractor is refused, and so is naming the contractor of an unassigned rejected turnover item; assigning any other unassigned one still passes.

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| MON-1 | HIGH | RESOLVED |
| MON-2 | HIGH | RESOLVED |
| MON-3 | HIGH | RESOLVED |
| MON-4 | HIGH | RESOLVED |
| MON-5 | MEDIUM | RESOLVED |
| MON-6 | HIGH | RESOLVED |
| MON-7 | MEDIUM | OPEN |
| MON-8 | MEDIUM | RESOLVED |
| MON-9 | LOW | RESOLVED |
| MON-10 | MEDIUM | OPEN |
| MON-11 | MEDIUM | OPEN |
| MON-12 | MEDIUM | OPEN |
| MON-13 | LOW | OPEN |
