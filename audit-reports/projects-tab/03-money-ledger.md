# 03 · Money & the ledger

Where a wrong number gets signed, and where a failure leaves the books
inconsistent with no way to detect or repair it.

**12 findings** — 2 CRITICAL, 6 HIGH, 4 MEDIUM.

> Line numbers are from commit `6a14d7d` and drift with edits. **Match on the
> quoted code, not the number.** See [`../README.md`](../README.md) for the
> resolution protocol.

---

## MON-1 · A failed award leaves the document permanently awarded with no commitment, and nothing can repair it

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / financial
- **Locations:**
  - `lib/costDocs.ts:196-201` — `revertDocTransition`, fire-and-forget
  - `lib/changeOrders.ts:178-180` — same shape
  - `lib/costDocs.ts:170-192` — `claimDocTransition`, which is otherwise correct
  - `app/api/projects/cost-docs/route.ts:87-92` — the 409 that then blocks recovery
- **Related:** `MON-11` (`posted_entry_id` unread — the field that would detect this)
- **Re-verified:** hardening pass — **SURVIVES**. `claimDocTransition` moves the document to `awarded` before the money is posted; the unreadable-total branch reverts (`costDocs.ts:240`), but the `addEntry` failure branch at `:245` returns `{ok: false}` **without** calling `revertDocTransition`. The document stays awarded with no commitment. `revertDocTransition` itself ends in `.then(() => undefined, () => undefined)`, so even the paths that do revert cannot report a failed revert.

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

---

## MON-2 · The cost S-curve's planned line starts on the day the first task finishes

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness / decision-quality
- **Locations:** `components/projects/CostsTab.tsx:76-79`
- **Related:** `MON-6` (span definitions), `SCH-6`
- **Re-verified:** hardening pass — **SURVIVES**. `const dates = rows.map((m) => m.planned_at)…sort()` then `start: dates[0]` (`CostsTab.tsx:76-79`). `planned_at` is the milestone **finish**, so the planned curve begins on the earliest completion date.

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

---

## MON-3 · Void and manual-total have no compare-and-swap, in the one file that preaches the discipline

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / financial
- **Locations:**
  - `lib/costDocs.ts:310-319` — `voidCostDoc`
  - `lib/costDocs.ts:323-334` — `setManualTotal`
  - `lib/costDocs.ts:170-192` — `claimDocTransition`, the pattern they should use
- **Re-verified:** hardening pass — **SURVIVES**, and the discipline it breaks is in the same file. `voidCostDoc` (`costDocs.ts:315`) and `setManualTotal` (`:330`) both issue a bare `.update(…).eq("id", …)` with no status precondition in the predicate, while `awardQuote` in the same module goes through `claimDocTransition` — a real compare-and-swap.

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

---

## MON-4 · Remaining budget ignores commitments, and the false figure is written into the permanent record

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** decision-quality / financial
- **Locations:**
  - `lib/costs.ts:330` — `remaining: sum(budget) - sum(spent)`
  - `components/projects/CostsTab.tsx:133-142` — the headline tile
  - `components/projects/CostsTab.tsx:145-156` — the burn bar, which *does* draw the committed band
  - `lib/projectReport.ts` — `draftLessonsLearned` writes the figure into the record
- **Re-verified:** hardening pass — **SURVIVES**. `remaining: sum((r) => r.account.budget) - sum((r) => r.spent)` (`costs.ts:330`) omits commitments entirely, and the figure is rendered as the headline "Remaining" stat (`CostsTab.tsx:133-136`).

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

---

## MON-5 · The printed report's cost performance index is unconditionally null, so paper and screen disagree

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness
- **Locations:**
  - `lib/projectReport.ts:53-59` — the discarded index
  - `lib/costs.ts:305-313` — where a missing index makes earned value null
  - `components/projects/CostsTab.tsx:137-141` — the screen, which shows a real CPI
- **Re-verified:** hardening pass — **SURVIVES**, and the cause is one argument. `lib/projectReport.ts:59` calls `computeCostRollup(accounts, entries, new Map())` — the third parameter is the milestone-percent index, and an empty map makes `evActual` zero, so `cpi: evActual > 0 ? evTotal / evActual : null` (`costs.ts:332`) is **always null on paper** while the screen passes a real index.

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

---

## MON-6 · Imported schedules are invisible to health, the coach and the report — but visible to the Costs tab

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness
- **Locations:**
  - `lib/projectSnapshot.ts:49` — the filter
  - `lib/projectReport.ts:54` — the same filter
  - `supabase/migrations/20260614_phase7_milestones.sql:61` — `CHECK (source IN ('manual','p6','msproject','csv'))`
  - `types/schema.ts:429` — `MilestoneSource`
- **Related:** `SCH-6`, `MON-2`
- **Re-verified:** hardening pass — **SURVIVES**. `projectSnapshot.ts:49` filters milestones to `source == null || "manual" || "app"`, the identical filter used by `projectReport.ts:54`. Imported rows are excluded from health, coach and report while the Costs tab reads them.

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

---

## MON-7 · The Known Companies scorecard is structurally empty for the normal workflow

- **Severity:** HIGH
- **Status:** OPEN
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

---

## MON-8 · An unmapped document status throws inside the award path, hanging the button forever

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability
- **Locations:**
  - `lib/costDocs.ts:181` — `COST_DOC_STATUS_LABEL[fresh.status].toLowerCase()`
  - `components/projects/cost/QuotesPanel.tsx:221` — awaits with no try/catch
  - `supabase/migrations/20260819_orphan_tables_backfill.sql:184` — `status` is plain `text NOT NULL`, no CHECK
- **Related:** `REL-4`
- **Re-verified:** hardening pass — **SURVIVES**. `COST_DOC_STATUS_LABEL[fresh.status].toLowerCase()` (`costDocs.ts:181`) — an unmapped status makes the lookup `undefined` and the method call throws inside the award path, after `setBusy` and before any `setBusy(null)`.

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

---

## MON-9 · Two simultaneous change-order proposals collide on the generated number

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `lib/changeOrders.ts:88-110` — read-max-then-insert, no retry
  - `lib/companies.ts:134-136` — `saveCompany`, which maps 23505 correctly
- **Re-verified:** hardening pass — **SURVIVES**. `co_number` is derived by reading the last 50 rows and taking the max (`changeOrders.ts:88-93`) with no unique constraint and no counter — two concurrent proposals read the same maximum.

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

---

## MON-10 · A losing bid reads "under review" forever unless it shares an RFQ group

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / vendor relations
- **Locations:**
  - `lib/costDocs.ts:250-251` — the rival-declining filter
  - `app/api/intake/upload/route.ts:127` — the portal's promise
  - `app/submit/[token]/page.tsx:195-199` — the status chip
- **Related:** `BID-10` (free-text group), `MON-11` (no notifications)
- **Re-verified:** hardening pass — **SURVIVES**. `const rivals = … && !!fresh.rfqGroup && d.rfqGroup === fresh.rfqGroup` (`costDocs.ts:250-251`) — an ungrouped quote has no rivals, so nothing is ever marked not-selected.

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

---

## MON-11 · Only one event in the entire controls program notifies anyone

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** process
- **Locations:**
  - `app/api/intake/upload/route.ts:104-113` — the one notifying event (quote received, in-app only)
  - `lib/changeOrders.ts`, `lib/turnover.ts`, `lib/checklists.ts`, `lib/costDocs.ts`, `lib/companies.ts` — no notification imports at all
  - `app/api/intake/upload/route.ts:349-385` — the document branch, which does the full job
- **Re-verified:** hardening pass — **SURVIVES**, by census. The only `notifications` insert anywhere in the controls program is the intake one (`intake/upload/route.ts:104-113`).

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

---

## MON-12 · A company flagged "do not use" can still be awarded work

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** process / governance
- **Locations:**
  - `lib/costDocs.ts:211` — `awardQuote` never checks company status
  - `components/projects/cost/QuotesPanel.tsx:289-291` — the red chip
  - `app/(protected)/companies/[id]/page.tsx:522` — the tooltip claiming it "flags the company across the app"
  - `lib/companies.ts:24` — `inactive`, which changes nothing at all
- **Related:** `BID-12` (the name match that often prevents the chip rendering at all)
- **Re-verified:** hardening pass — **SURVIVES**. `awardQuote` (`costDocs.ts:211`) takes no company status and applies no check, while the UI renders a `do_not_use` badge two lines from the Award button (`QuotesPanel.tsx:289-291`).

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

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| MON-1 | CRITICAL | OPEN |
| MON-2 | CRITICAL | OPEN |
| MON-3 | HIGH | OPEN |
| MON-4 | HIGH | OPEN |
| MON-5 | HIGH | OPEN |
| MON-6 | HIGH | OPEN |
| MON-7 | HIGH | OPEN |
| MON-8 | HIGH | OPEN |
| MON-9 | MEDIUM | OPEN |
| MON-10 | MEDIUM | OPEN |
| MON-11 | MEDIUM | OPEN |
| MON-12 | MEDIUM | OPEN |
