# 04 · Cost, change orders & bid tabulation

**14 findings** — 2 HIGH · 12 MEDIUM.

The money. Where a number can be wrong, and where an authoritative figure is AI-derived.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| Compare-and-swap claim-before-money discipline | `lib/costDocs.ts:170-192 (claimDocTransition), lib/changeOrders.ts:151-161` | The status claim runs as a conditional UPDATE with `.in("status", fromStatuses)` / `.eq("status","proposed")` and treats a zero-row match as the real signal, not PostgREST's success. This is the correct shape for concurrent approvers and must survive any refactor of the award/approve paths. |
| validateParsedQuote hardens model output before it is rendered or scored | `lib/bidTab.ts:190-226` | Rejects non-numeric totals, zero/negative totals, and junk line items; regression-pinned at lib/__tests__/projectControls.test.ts:312-329. Any relaxation re-opens the Infinity/best-value bug it fixed. |
| user_owns_project() requires ACTIVE org membership, not just ownership | `supabase/migrations/20261013_project_controls_program.sql:57-65` | Offboarding a member (status != 'active') revokes their cost-write access immediately on projects that still name them owner. It also correctly pins `SET search_path = public`, unlike is_org_controller (supabase/migrations/20260814_documents_delete_controllers.sql:31-40, which belongs to the already-audited roles-and-permissions area). |
| Honest-null discipline in the pure engines | `lib/companyScore.ts:100-102,125-133,160-164; lib/costSeries.ts:109-111,138` | A dimension with no evidence scores null and is excluded from the composite; a forecast with nothing to project from returns null rather than a fabricated number. This is the difference between an unrated vendor and a vendor scored 100. |
| Void-not-delete convention in the application layer | `lib/costs.ts:246-257 (voidEntry), lib/costDocs.ts:308-318` | Financial rows are struck through, not removed, and voided entries are excluded from every total (lib/costs.ts:295). The convention is correct in code; only the database is missing the matching guard (see the DELETE finding). |
| Whole-word scope matching in the bid tab | `lib/bidTab.ts:75-99` | hasWord() prevents "under" from counting as a mention of "NDE" and hiding missing radiography scope; regression-pinned at lib/__tests__/projectControls.test.ts:337-358. Reverting to substring matching would silently hide NDE gaps on a B31.3 job. |
| Pure rollup / series / scoring split with unit tests | `lib/costs.ts:288-350, lib/costSeries.ts, lib/bidTab.ts, lib/__tests__/costs.test.ts, lib/__tests__/projectControls.test.ts` | All the arithmetic is testable without a database, and the test files already pin several confirmed fixes. Every finding below is fixable in these pure functions plus their callers. |


---


<a id="cost-1"></a>

## COST-1 · CPI is measured over milestone-pinned accounts only but applied to the whole-project budget; the close-out report silently reports no CPI at all

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/costs.ts:303-332`, `lib/costSeries.ts:112-120`, `components/projects/cost/CostCharts.tsx:53-56`, `lib/projectReport.ts:53-66`, `lib/projectReport.ts:139`, `lib/__tests__/costs.test.ts:53-69`

**Mechanism.** computeCostRollup accumulates `evTotal` and `evActual` only for accounts with a wbsMilestoneId (lib/costs.ts:307-309) and returns `cpi: evActual > 0 ? evTotal / evActual : null` (lib/costs.ts:332) — a ratio over a subset. CostCharts then hands that subset ratio to computeForecast together with PROJECT-WIDE totals: `budget: rollup.budget, spent: rollup.spent, cpi: rollup.cpi` (components/projects/cost/CostCharts.tsx:54). computeForecast's CPI branch computes `eac = budget / cpi` (lib/costSeries.ts:113), dividing the whole budget by a performance index derived from possibly one small account. The project report has the mirror-image defect: it builds a milestone index keyed by array position rather than milestone id (`id: String(i)`, lib/projectReport.ts:54), discards it (`void pctIdx;`, lib/projectReport.ts:57), and calls `computeCostRollup(accounts, entries, new Map())` (lib/projectReport.ts:58) — an empty map guarantees earnedValue null for every account and cpi null, so the report's "Cost performance (CPI)" row (lib/projectReport.ts:139) is unreachable and its forecast always falls back to run-rate or none.

**Failure scenario.** Using the shape already pinned in lib/__tests__/costs.test.ts:53-69: account a1 has budget 1000 pinned at 60% (EV 600) with 400 of actuals; account a2 has budget 500 with 500 of actuals and no pin. rollup.cpi = 600/400 = 1.5, rollup.budget = 1500, rollup.spent = 900. computeForecast returns eac = 1500/1.5 = 1000 and vac = -500, and the Costs tab renders "At this performance you'll finish around $1,000 — $500 under budget" in emerald — on a project that has already spent 900 of 1500 with a whole unpinned account running at 100% of budget. The printed close-out report for the same project shows no CPI at all and a different (run-rate) forecast, so the screen and the paper disagree about the same money.

**Evidence.**

```
components/projects/cost/CostCharts.tsx:53-56 — `computeForecast({ budget: rollup.budget, spent: rollup.spent, cpi: rollup.cpi, ... })`. lib/costSeries.ts:113 — `const eac = budget / cpi;`. lib/projectReport.ts:57-58 — `void pctIdx; // EV pinning uses milestone ids; report uses account-level rollup below` followed by `const rollup = computeCostRollup(accounts, entries, new Map());`.
```

> **Verifier correction.** One nuance: the subset scope of CPI is itself deliberate and unit-tested (lib/__tests__/costs.test.ts:53-69, 'computes earned value + CPI only from milestone-pinned accounts', and the field comment at costs.ts:283 'EV / actual-cost over the pinned accounts'). The defect is not that CPI is a subset ratio but that computeForecast applies it to the project-wide BAC without scoping the budget to the pinned accounts.

**Done when.**

- [ ] ProjectCostRollup exposes the pinned-account budget and spend alongside cpi, and computeForecast's CPI branch is applied only to the pinned subset (with the unpinned remainder forecast by run-rate or excluded and labelled)
- [ ] The Costs tab states which portion of the budget the CPI-based EAC covers rather than presenting it as a whole-project number
- [ ] lib/projectReport.ts selects milestone `id` and passes a real milestonePctIndex keyed by milestone id, so the report's CPI row and the Costs tab agree
- [ ] A test pins that a project with one pinned and one unpinned account does not report an EAC below its already-spent total

---

<a id="cost-2"></a>

## COST-2 · Committed money is invisible to Remaining, to the over-budget flag, and to project health — a fully committed budget reads as fully available

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/costs.ts:316`, `lib/costs.ts:317`, `lib/costs.ts:330`, `components/projects/CostsTab.tsx:133-142`, `lib/projectHealth.ts:25`, `lib/projectHealth.ts:70-86`, `lib/projectSnapshot.ts:101`

**Mechanism.** computeCostRollup aggregates commitments (`if (e.entryType === "commitment") agg.committed += e.amount`, lib/costs.ts:297) and reports them, but every exposure figure is derived from `spent` alone: `remaining: a.budget - spent` (lib/costs.ts:316), `overBudget: a.budget > 0 && spent > a.budget` (lib/costs.ts:317), and project `remaining: sum((r) => r.account.budget) - sum((r) => r.spent)` (lib/costs.ts:330). `spent = agg.actual + agg.adjustments` (lib/costs.ts:306) — commitments are excluded by construction. The Remaining tile renders that figure with a green tone and a TrendingUp icon whenever it is >= 0 (components/projects/CostsTab.tsx:133-136). The same blindness repeats in health scoring: ProjectStateSnapshot declares `committed: number` (lib/projectHealth.ts:25) and gatherProjectSnapshot populates it (lib/projectSnapshot.ts:101), but computeProjectHealth's Cost part reads only `s.cpi` and `s.spent / s.budget` (lib/projectHealth.ts:70-86). Two differently-shaped greps (`grep -n committed lib/projectHealth.ts` → only line 25; `grep -rn '\.committed\b'` across lib/components/app) confirm `s.committed` is never read anywhere.

**Failure scenario.** A $500,000 piping account has a $480,000 subcontract awarded (awardQuote posts a $480,000 commitment) and no invoices yet. computeCostRollup returns committed 480,000, spent 0, remaining 500,000, overBudget false. The Costs tab shows "Remaining $500,000" in emerald with an upward-trend icon; the project health Cost part scores 100 ("0% of budget spent"). The owner then approves a $60,000 change order and awards a $40,000 scaffolding quote against the same line, because the screen says half a million is free. Nothing flags over-commitment until the first invoices land months later, at which point the account is $80,000 overspent with the work already performed in the field.

**Evidence.**

```
lib/costs.ts:316-317 — `remaining: a.budget - spent,` / `overBudget: a.budget > 0 && spent > a.budget,`. lib/costs.ts:330 — `remaining: sum((r) => r.account.budget) - sum((r) => r.spent),`. lib/projectHealth.ts:25 declares `committed: number;` and it appears nowhere else in that file.
```

> **Verifier correction.** The headline overstates. Committed money is NOT invisible to the user: CostsTab.tsx:128-130 renders a dedicated 'Committed' StatCard with '% of budget', :145-157 draws a burn bar with the committed ghost bar plus a text line 'X spent · Y committed · Z budget', :356 shows Committed per account row, the S-curve plots it (ChartKit.tsx:72,107) and the close-out report prints 'Committed (promised)' (projectReport.ts:136). So a fully committed budget does not read as 'fully available' on screen — the Committed tile would read 100% of budget beside it. The accurate defect is narrower: the three DERIVED figures (account remaining, overBudget flag, project remaining) and the health Cost score are computed from spent alone, so no automatic warning ever fires on commitment-driven exposure. Severity reduced from CRITICAL to HIGH on that basis.

**Done when.**

- [ ] AccountRollup and ProjectCostRollup expose an exposure figure that includes open commitments (e.g. `exposure = committed + spent` net of actuals already invoiced against a commitment, and `remaining = budget - exposure`), and `overBudget` trips on exposure, not on spent alone
- [ ] The Remaining tile and the per-account row in components/projects/CostsTab.tsx render the commitment-inclusive figure, with the actuals-only figure available as a secondary number rather than the headline
- [ ] computeProjectHealth's Cost part reads s.committed, or ProjectStateSnapshot.committed is removed so the unused field stops implying the health engine considers it
- [ ] lib/__tests__/costs.test.ts gains a case pinning that an account with budget 1000, committed 900, spent 0 is flagged as at-risk and does not report 1000 remaining

---

<a id="cost-3"></a>

## COST-3 · A vendor's do-not-use flag and quality-manual score are advisory only, depend on exact string equality with an AI-read letterhead, and the score is derived from at most 10 pages

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/projects/cost/QuotesPanel.tsx:275`, `components/projects/cost/QuotesPanel.tsx:286-291`, `lib/costDocs.ts:211-263`, `app/api/companies/quality-manual/route.ts:27`, `app/api/companies/quality-manual/route.ts:56`, `lib/checklistEngine.ts:200-206`, `app/(protected)/companies/[id]/page.tsx:216-232`

**Mechanism.** The registry match in the bid tab is exact case-folded equality against the vendor name the model read from the letterhead: `companies.find((c) => c.name.toLowerCase() === e.vendorName.toLowerCase())` (components/projects/cost/QuotesPanel.tsx:275). A miss silently yields no badge. Even on a hit, `known?.status === "do_not_use"` only renders a chip (lines 289-291) — a repo-wide grep for `do_not_use` shows the value is referenced in exactly three UI files and the CHECK constraint, and never in awardQuote, decideChangeOrder, saveParty, or intake-link creation, so nothing blocks awarding a barred contractor. The QM percentage shown next to the price (line 286) comes from rubricCoverageScore, which divides confirmed-covered areas by the FULL eight-area rubric (lib/checklistEngine.ts:203-205) while the route renders only the first 10 pages of the manual (app/api/companies/quality-manual/route.ts:27,56) and instructs the model to judge only what it can see. The confirm action stores the model's number verbatim with no field to adjust it: `score: proposal.score` (app/(protected)/companies/[id]/page.tsx:221-224).

**Failure scenario.** A contractor is barred in the registry after a stop-work. Their quote PDF's letterhead reads "Apex Industrial Services, LLC" and the model extracts that name; the registry row says "Apex Industrial". No match, no badge, no warning — the bid tab flags them best value and the award posts. Separately, a 62-page quality manual is evaluated on its first 10 pages; five of eight rubric areas appear later in the document, so the model reports them uncovered, rubricCoverageScore returns 38%, and "QM 38%" is stamped on their permanent record and shown beside every future price with no note that 52 pages were never read.

**Evidence.**

```
components/projects/cost/QuotesPanel.tsx:275 — `const known = companies.find((c) => c.name.toLowerCase() === e.vendorName.toLowerCase()) ?? null;`. app/api/companies/quality-manual/route.ts:27 — `const MAX_PAGES = 10;`. lib/checklistEngine.ts:204-205 — `const covered = QUALITY_MANUAL_RUBRIC.filter((a) => byArea.get(a.key) === true).length; return Math.round((covered / QUALITY_MANUAL_RUBRIC.length) * 100);`.
```

**Done when.**

- [ ] awardQuote (and ideally proposeChangeOrder against that party) refuses or requires an explicit override when the matched company's status is 'do_not_use', with the override recorded in audit_logs
- [ ] Company matching uses a normalized comparison with an explicit link stored on the cost_documents/party row rather than re-deriving equality from an AI-read name on every render
- [ ] The quality-manual evaluation records how many pages of the manual were read and the UI qualifies the percentage accordingly; a truncated read does not land as a bare coverage number
- [ ] The confirm step lets the human adjust the proposed score, or the stored value is explicitly labelled as the model's proposal that a human accepted

---

<a id="cost-4"></a>

## COST-4 · An approved change order never revises the budget, so approved scope growth permanently reads as over-budget and collapses earned value and CPI

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/changeOrders.ts:163-189`, `lib/costs.ts:308`, `lib/costs.ts:316-317`, `lib/costs.ts:332`, `lib/projectHealth.ts:104-113`

**Mechanism.** decideChangeOrder's approval path posts the CO amount as a signed COMMITMENT entry (lib/changeOrders.ts:167-172, `entryType: "commitment"`) and nothing else. cost_accounts.budget is never touched, and there is no revised-budget concept anywhere in lib/costs.ts. Consequences compound: (a) `remaining = a.budget - spent` (lib/costs.ts:316) measures actuals against the ORIGINAL budget, so once the CO work is invoiced the account is flagged overBudget even though the growth was formally approved; (b) earned value is `a.budget * pct/100` (lib/costs.ts:308) — the pinned account earns only its original budget while its actual cost includes the CO work, so `cpi = evTotal / evActual` (lib/costs.ts:332) drops mechanically with every approved CO; (c) computeForecast then returns `eac = budget / cpi` (lib/costSeries.ts:113), inflating the forecast by exactly the ratio the CO depressed CPI. projectHealth compounds it again by scoring change control as `s.approvedCoAmount / s.budget` against the same un-revised budget (lib/projectHealth.ts:105-110).

**Failure scenario.** A $200,000 piping account is pinned to a milestone that is 50% complete (EV $100,000) with $100,000 of actuals — CPI 1.00, forecast on budget. A legitimate $100,000 field-condition CO is proposed, approved, and executed. The commitment rises to $300,000, the budget stays $200,000. When the CO work is invoiced, actuals are $200,000 against EV of $100,000 (still budget x 50%), CPI falls to 0.50, and the forecast sentence reads "At this performance you'll finish around $400,000 — $200,000 over budget." The project shows red on a job that is executing exactly the scope its owner approved, while a project whose CO was rejected shows green.

**Evidence.**

```
lib/changeOrders.ts:167-172 — the entire financial effect of approval is `entryType: "commitment", amount: co.amount`. lib/costs.ts:308 — `const earnedValue = pct !== undefined ? a.budget * (Math.max(0, Math.min(100, pct)) / 100) : null;`. No code path writes cost_accounts.budget from a change order (grep for `change_orders` in lib/costs.ts returns nothing).
```

> **Verifier correction.** Consequence (d) is wrong and should be dropped: scoring change-order growth against the ORIGINAL budget in projectHealth.ts:104-110 is explicitly the intended behaviour — the part is labelled 'Change control' with detail `${Math.round(growth*100)}% budget growth via change orders`, i.e. growth-vs-baseline is the metric, not a bug. Holding budget as an un-revised baseline is also a defensible convention on its own; the genuine defect is that EV is computed as `a.budget * pct/100` from that same un-revised baseline while actual cost includes CO work, so CPI/EAC degrade with every approved CO, and the account's overBudget flag fires on formally approved growth with no way to mark it approved. Severity reduced to MEDIUM: this is a missing revised-budget feature that distorts derived indices, not a wrong number posted to the ledger.

**Done when.**

- [ ] CostAccount carries an approved-change total (or the rollup joins approved change_orders by cost_account_id) and exposes a revisedBudget = budget + approvedChanges
- [ ] earnedValue, remaining, overBudget and cpi are computed against revisedBudget, while the original budget stays visible as the baseline
- [ ] lib/projectHealth.ts:105-110 scores change-order growth against the original baseline explicitly labelled as such, not against a figure that other tiles now treat as revised
- [ ] A test pins that a 200k account with an approved 100k CO and 200k of actuals at 50% complete reports CPI 1.0, not 0.5

---

<a id="cost-5"></a>

## COST-5 · Bid scoring is scaled to the worst bid in the field, so one honest exclusion can cost the full coverage weight, and the manpower dimension rewards higher self-reported hours

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/bidTab.ts:159`, `lib/bidTab.ts:165-171`, `lib/bidTab.ts:139`, `lib/bidTab.ts:118-124`

**Mechanism.** Coverage is `const maxGaps = Math.max(...econ.map((e) => e.missingScope.length + e.exclusionCount), 1);` then `const coverage = (1 - gaps / maxGaps) * 100;` (lib/bidTab.ts:159,169). The denominator is the field's worst bid, so the penalty per gap is not a fixed quantity — in a field where exactly one bidder declares one exclusion, maxGaps is 1 and that bidder's coverage is 0 while everyone else scores 100, costing the full 20% weight for a single honest disclosure; in a field with ten total gaps the same exclusion costs 2 points. Coverage also weights a declared exclusion exactly as heavily as a silent gap, penalising the disclosure the module header calls the most important signal. Manpower is `(minDph / e.dollarsPerHour) * 100` where `dollarsPerHour = q.total / hours` (lib/bidTab.ts:165-166,139) and `hours` is summed from the vendor's own line items as the model read them (lib/bidTab.ts:118-122) — so at equal price, the bid claiming MORE labour hours scores higher, and nothing verifies the claim.

**Failure scenario.** Two bids at $200,000 each. Bidder A states 2,000 hours ($100/hr); Bidder B pads its quote to 4,000 hours ($50/hr). minDph = 50, so A's manpower part is 50 and B's is 100 — a 15-point swing at the default 0.3 weight, enough to flip "best value" onto a bid whose only distinguishing claim is a self-reported, AI-extracted number. Separately, in a three-bid field where only the most thorough bidder writes "Excludes: insulation reinstatement", maxGaps = 1 and that bidder's coverage part is 0 while two bidders who said nothing about insulation at all score 100 — the disclosure is punished and the silence is rewarded, which is the exact inversion of what the module set out to do.

**Evidence.**

```
lib/bidTab.ts:159 — `const maxGaps = Math.max(...econ.map((e) => e.missingScope.length + e.exclusionCount), 1);`. lib/bidTab.ts:169 — `const coverage = (1 - gaps / maxGaps) * 100;`. lib/bidTab.ts:139 — `dollarsPerHour: hours > 0 ? q.total / hours : null`.
```

**Done when.**

- [ ] Coverage is scored on an absolute scale (gaps against the size of the scope union, or a fixed per-gap deduction) so the penalty for one exclusion does not vary tenfold with who else bid
- [ ] A declared exclusion and a silent gap carry different weights, matching the module's stated premise that surfacing exclusions is the point
- [ ] The manpower part is bounded or paired with a plausibility check so an inflated hours claim cannot buy the best-value flag, and the tabulation labels labour hours as vendor-stated and AI-extracted
- [ ] A test pins the single-exclusion three-bid field and asserts the disclosing bidder is not driven to a coverage part of 0

---

<a id="cost-6"></a>

## COST-6 · Change-order approval has no authority model: the proposer can approve their own change order, for any amount, with nothing enforced server-side beyond project ownership

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/changeOrders.ts:132-197`, `components/projects/cost/ChangeOrdersPanel.tsx:46-78`, `components/projects/cost/ChangeOrdersPanel.tsx:98-108`, `supabase/migrations/20261013_project_controls_program.sql:262-266`, `app/(protected)/projects/[id]/page.tsx:134`

**Mechanism.** decideChangeOrder checks exactly two things before money moves: that the CO is still `proposed` and that a cost account is selected (lib/changeOrders.ts:144-147). It never compares `input.actorId` to the CO's created_by, and it never consults a monetary threshold — two independently-shaped searches for approval limits and separation-of-duties concepts (`approval(limit|threshold|authority)|signing_?authority|approval_limit` and `countersign|second approver|dual approval|separation of duties|self-approv|maxAmount|amountLimit`) return no cost-side hit anywhere in the repo; the only self-approval logic that exists is in the already-audited ticket workflow. The UI gates Propose and Approve on the same single boolean (`canManage` guards the Propose button at components/projects/cost/ChangeOrdersPanel.tsx:98 and the Approve button at line 179), and canManage is `isOwner || isAdmin` (app/(protected)/projects/[id]/page.tsx:134). RLS is equally flat: `change_orders_write ... USING (is_org_controller(org_id) OR user_owns_project(project_id)) WITH CHECK (same)` (supabase/migrations/20261013_project_controls_program.sql:262-266) — one predicate for insert, update, and delete, so the same identity that inserts a proposed CO can flip it to approved. Note the policy does carry WITH CHECK, so this is not the USING-only recurrence; the FOR ALL grant is what makes propose and approve indistinguishable at the database.

**Failure scenario.** A project owner proposes CO-004 for $340,000 coded field_condition against a contractor they also manage, then clicks Approve in the same session. decideChangeOrder claims the row and posts a $340,000 commitment. audit_logs records CHANGE_ORDER_PROPOSED and CHANGE_ORDER_APPROVED with the same user_id minutes apart, but nothing prevented it, nothing routed it to a second signer, and no dollar threshold escalated it. On a PSM-regulated capital job this is the control an auditor asks for by name, and the answer the system gives is that one person's click both created and approved the commitment.

**Evidence.**

```
lib/changeOrders.ts:144-147 — the only pre-approval checks are `if (co.status !== "proposed") throw ...` and `if (input.decision === "approved" && !co.costAccountId) throw ...`. components/projects/cost/ChangeOrdersPanel.tsx:98 and :179 — the same `canManage` boolean gates Propose and Approve. supabase/migrations/20261013_project_controls_program.sql:263 — `CREATE POLICY change_orders_write ON change_orders FOR ALL`.
```

> **Verifier correction.** Overstated framing: this is not an open door. Both propose and approve are already restricted, in the UI and in RLS, to the project owner or an org controller (Admin/DocCtrl) — an ordinary active org member can only SELECT (the *_member_read policy at 20261013:253-259). So the real finding is the absence of separation of duties and of any monetary approval limit AMONG already-privileged users, not that anyone can approve. Severity reduced to MEDIUM accordingly.

**Done when.**

- [ ] decideChangeOrder rejects a decision whose actorId equals the CO's created_by, or the product explicitly documents self-approval as accepted with a visible marker on the CO row
- [ ] An org-level approval threshold exists (amount above which a controller, not merely the project owner, must decide) and is enforced in decideChangeOrder AND in a database policy or trigger, not only in the UI
- [ ] change_orders gains split policies so INSERT of a proposed CO and UPDATE to status='approved' are separately grantable, instead of one FOR ALL grant
- [ ] The CO row and the report show proposer and decider side by side and visibly flag when they are the same person

---

<a id="cost-7"></a>

## COST-7 · Cost-discipline scoring blames the contractor for owner-request and design-error change orders, contradicting the reason-code contract the CO module states

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/companyScore.ts:107-121`, `lib/companies.ts:285`, `lib/companies.ts:299-301`, `lib/changeOrders.ts:5-8`, `components/projects/cost/ChangeOrdersPanel.tsx:159-161`

**Mechanism.** lib/changeOrders.ts:7-8 states the contract: "the reason codes score both sides: scope_gap lands on the contractor's record, design_error and owner_request land on ours", and the CO row's tooltip repeats it to the user verbatim (components/projects/cost/ChangeOrdersPanel.tsx:160). The scorecard does not honour it. gatherCompanyProfile sums ALL approved COs regardless of reason — `const approvedCoTotal = cos.filter((c) => c.status === "approved").reduce((s, c) => s + c.amount, 0);` (lib/companies.ts:285) — and feeds `finalCostTotal: awardsTotal + approvedCoTotal` (line 299) plus `changeOrderCount` counting every approved CO (line 300). computeCompanyScorecard then derives `const growth = Math.max(0, (e.finalCostTotal - e.awardsTotal) / e.awardsTotal)` and `score = clamp(100 - growth * 250 - gapShare * growth * 250)` (lib/companyScore.ts:111-113). reasonCode is used only to compute gapShare, which is a multiplier on top of a penalty that has already been applied in full. The detail string then tells the reader "N% cost growth over bid" (line 117) with no indication that the growth was owner-driven.

**Failure scenario.** A contractor bids $500,000 and executes it exactly. The plant then issues two owner_request COs totalling $125,000 for scope the plant itself added, both approved. growth = 0.25, gapShare = 0 (no scope_gap COs), score = clamp(100 - 0.25*250) = 37.5, banded "Concern" (lib/companyScore.ts:173), with the detail "25% cost growth over bid · 2 change orders". That number sits in the composite and appears beside their price the next time they bid. The contractor is marked down 62 points for work the owner asked for, and the CO panel's own tooltip promised them it would not be.

**Evidence.**

```
lib/companies.ts:285 — `const approvedCoTotal = cos.filter((c) => c.status === "approved").reduce((s, c) => s + c.amount, 0);` with no reasonCode filter. lib/companyScore.ts:111-113 — growth is computed from finalCostTotal with reasonCode entering only via `gapShare`. lib/changeOrders.ts:7-8 — "design_error and owner_request land on ours".
```

> **Verifier correction.** Downgraded to SUSPECTED and MEDIUM because the consequence is not currently reachable, and the finding does not acknowledge this. The penalty lives inside `else { ... }` guarded by `if (e.awardsTotal <= 0) { score: null }` (companyScore.ts:107-109), and finding 9 — which I confirmed independently — establishes that awardsTotal is always 0 for any company the registry can resolve, because company_id and contract_value have mutually exclusive writers and saveParty's UPDATE branch has no caller. Today the cost dimension therefore always renders 'No awarded work yet' and no contractor is ever blamed for an owner-request CO. The finding is a latent defect that fires the moment the party-linking gap in finding 9 is fixed, and should be reported that way rather than as an observed misattribution.

**Done when.**

- [ ] finalCostTotal counts only COs whose reason attributes to the contractor (scope_gap, and a documented decision on field_condition), with owner_request and design_error excluded from the growth numerator
- [ ] The cost-discipline detail string distinguishes contractor-driven growth from owner-driven growth so the number can show its work as the module header promises
- [ ] A test pins that a contractor with 25% growth entirely from owner_request COs scores the same as one that finished on bid
- [ ] The corresponding owner-side counter (design_error / owner_request volume) is surfaced somewhere, since the reason-code contract claims those land on us and nothing currently consumes them

---

<a id="cost-8"></a>

## COST-8 · Currency is discarded at every point where money moves or is compared — a foreign-currency quote posts into a USD budget line at face value

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/costDocs.ts:232-242`, `lib/costDocs.ts:286-296`, `lib/bidTab.ts:39-55`, `lib/bidTab.ts:149-186`, `components/projects/cost/QuotesPanel.tsx:218`, `components/projects/cost/QuotesPanel.tsx:298-300`, `components/projects/CostsTab.tsx:489`, `app/api/projects/cost-docs/route.ts:129`

**Mechanism.** cost_documents carries a currency column populated verbatim from the model (`if (quote.currency) patch.currency = quote.currency;`, app/api/projects/cost-docs/route.ts:129, with no ISO-4217 validation), and cost_accounts carries its own currency. Neither awardQuote (lib/costDocs.ts:232-242) nor postInvoice (lib/costDocs.ts:286-296) reads either one: they pass `amount: total` into addEntry with no comparison and no conversion. The bid tab is currency-blind by type — BidEconomics has no currency field (lib/bidTab.ts:39-55) and scoreBids compares raw totals (`const price = e.total > 0 && minTotal > 0 ? (minTotal / e.total) * 100 : 0;`, lib/bidTab.ts:162) — even though ParsedQuote.currency exists (lib/bidTab.ts:32). The UI compounds it: the bid-tab price and $/hr cells call `fmtMoney(e.total)` and `fmtMoney(e.dollarsPerHour)` with no currency argument (components/projects/cost/QuotesPanel.tsx:298,300), and the award confirm dialog says `fmtMoney(total)` (line 218) — all defaulting to USD (lib/costs.ts:352). Meanwhile the only account-creation form hardcodes `currency: "USD"` with no picker (components/projects/CostsTab.tsx:489), so the mixed-currency warning banner (components/projects/CostsTab.tsx:159-164) is unreachable through the UI while the real cross-currency exposure is invisible.

**Failure scenario.** Two bids arrive for the same RFQ group: a US fabricator at USD 195,000 and a European vendor at EUR 168,000. The model correctly extracts currency "EUR" for the second. The bid tab prints "$168,000" and "$195,000", scores the EUR bid 100 on price and flags it best value; the confirm dialog reads "Award ... for $168,000". awardQuote posts a 168,000 commitment to a USD budget line. At roughly 1.09 USD/EUR the real commitment is about USD 183,000 — the tabulation was decided on a comparison that was never valid, and the budget line understates its exposure. Nothing in the rollup, the S-curve, or the report ever surfaces the mismatch because rollup.currencies only reads cost_accounts.currency, which the UI always sets to USD.

**Evidence.**

```
lib/costDocs.ts:232-242 — the addEntry call passes orgId, projectId, costAccountId, partyId, entryType, amount, entryDate, description, reference, actor; `fresh.currency` appears nowhere. components/projects/cost/QuotesPanel.tsx:298 — `{fmtMoney(e.total)}` with no currency argument. components/projects/CostsTab.tsx:489 — `patch: { ..., currency: "USD" }`.
```

> **Verifier correction.** 'Discarded at every point' is overstated on the display side: QuotesPanel.tsx:154 renders invoice totals as `fmtMoney(doc.totalAmount, doc.currency ?? "USD")`, and CostsTab.tsx:235/243/244 pass `r.account.currency ?? cur`, so a non-USD invoice does show its symbol in the list a reviewer reads before clicking Post. Severity reduced to MEDIUM: the app is single-currency by construction (no writer can create a non-USD account), so the exposure requires a foreign-currency vendor document and is a missing-validation/missing-feature gap rather than a routine wrong-number path.

**Done when.**

- [ ] awardQuote and postInvoice refuse to post when the document's currency differs from the target cost account's currency (or record an explicit rate and the converted amount on the entry)
- [ ] The parse route validates the model's currency against a known ISO-4217 set and stores null rather than free text when it does not match
- [ ] BidEconomics carries currency, and scoreBids either refuses to score a mixed-currency field or scores it only after an explicit stated conversion
- [ ] Every fmtMoney call on a document or bid figure passes that record's currency (components/projects/cost/QuotesPanel.tsx:218,298,300,351), and the account form offers a currency picker instead of hardcoding USD

---

<a id="cost-9"></a>

## COST-9 · Dead and write-only FK columns on the cost tables: cost_entries.source_document_id is never written, change_orders.posted_entry_id is never read, and the unwind path both were meant to support does not exist

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260908_cost_control.sql:54-59`, `supabase/migrations/20260819_orphan_tables_backfill.sql:213`, `lib/costs.ts:226-238`, `lib/changeOrders.ts:184-188`, `supabase/migrations/20261013_project_controls_program.sql:130`, `lib/costDocs.ts:6-9`

**Mechanism.** This is the dead-FK-column pattern the earlier audits confirmed on checkout_sessions.linked_ticket_id, projects.linked_ticket_id and document_versions.related_ticket_id, recurring twice on the money tables. A repo-wide grep for `source_document_id|sourceDocumentId` shows cost_entries.source_document_id appearing only in the two migrations that declare it (supabase/migrations/20260819_orphan_tables_backfill.sql:213) and add its foreign key (supabase/migrations/20260908_cost_control.sql:55-59, whose comment reads "dangling reference fixed: entries → cost_documents"); no application code writes or reads it, and addEntry's insert (lib/costs.ts:226-238) omits it entirely. A grep for `posted_entry_id|postedEntryId` shows exactly two hits: the column declaration (supabase/migrations/20261013_project_controls_program.sql:130) and one write (lib/changeOrders.ts:186) — nothing ever reads it, ChangeOrder does not map it (lib/changeOrders.ts:44-63), and no unwind action exists in ChangeOrdersPanel. Together this is also the never-implemented-comment pattern: lib/costDocs.ts:6-9 promises "every number in the rollup can show the paper it came from" and lib/changeOrders.ts:184-185 promises "an approval made in error can be unwound by voiding exactly the entry it created".

**Failure scenario.** A controller discovers that CO-007 was approved against the wrong contractor and needs the $84,000 commitment removed. The CO row offers no unwind, posted_entry_id is not exposed anywhere in the UI or the type, and the cost entry it created carries no back-reference to the CO or to the awarded quote. The only handle is the entry's description text (`${co.coNumber} — ${co.title}`, lib/changeOrders.ts:172) and its reference field, so the controller hunts the entry list by eye and voids what looks right. In an account with several COs and awards against the same vendor, voiding the wrong row is a plain typo away, and nothing in the schema would notice.

**Evidence.**

```
supabase/migrations/20260908_cost_control.sql:56-57 — `ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_source_document_fk FOREIGN KEY (source_document_id) REFERENCES cost_documents(id)`; the column appears in no .ts or .tsx file. lib/changeOrders.ts:186 — `await supabase.from("change_orders").update({ posted_entry_id: posted.entryId })` is the sole reference outside the column declaration.
```

**Done when.**

- [ ] addEntry accepts and writes source_document_id, and awardQuote/postInvoice pass the cost document's id so every commitment and actual points at the paper it came from
- [ ] ChangeOrder maps posted_entry_id and the CO row offers an unwind that voids exactly that entry, or the column and its promise in the comment are removed
- [ ] The entry list in the Costs tab links each entry to its source document or change order instead of relying on a description string
- [ ] A test or query pins that no posted cost entry created by awardQuote/postInvoice/decideChangeOrder has a null source link

---

<a id="cost-10"></a>

## COST-10 · Financial rows are deletable: no DELETE guard on cost_entries, change_orders, or cost_documents, contradicting the code's stated never-delete invariant

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260906_projects_hardening.sql:158-175`, `supabase/migrations/20261013_project_controls_program.sql:262-266`, `supabase/migrations/20261013_project_controls_program.sql:304-314`, `lib/costs.ts:246-257`, `lib/costDocs.ts:308-309`

**Mechanism.** lib/costs.ts:246-247 states the invariant: "Financial records are never deleted — voiding keeps the row with a strikethrough and removes it from every total", and the UI tooltip repeats it (components/projects/CostsTab.tsx:394). The database does not enforce it. Every cost-table write policy is `FOR ALL`, which grants DELETE alongside INSERT and UPDATE: the controller policy loop at supabase/migrations/20260906_projects_hardening.sql:169-172, the owner ungating loop at supabase/migrations/20261013_project_controls_program.sql:307-313, and change_orders_write at 20261013:262-266. Two searches confirm nothing compensates: grepping the migrations for the cost table names outside the four known files returns nothing, and grepping for `FOR DELETE|BEFORE DELETE|prevent_delete` lists 19 migrations, none of which reference a cost table (contrast supabase/migrations/20260826_legal_hold_delete_guard.sql, which does exactly this for documents). Deletes also leave no audit_logs trace, because the COST_* audit calls live only in the application's void paths.

**Failure scenario.** A project owner whose account is compromised, or who simply wants an uncomfortable number gone, issues a DELETE against cost_entries through PostgREST with their own JWT — the same anon key and session the app already uses for direct client writes to change_orders (components/projects/cost/ChangeOrdersPanel.tsx:59). The rows vanish from the rollup, the S-curve, and the close-out report, with no strikethrough, no void status, and no audit_logs entry. On a PSM-regulated capital job the cost ledger is part of the record an auditor reconstructs after an incident, and there is nothing to reconstruct it from.

**Evidence.**

```
supabase/migrations/20261013_project_controls_program.sql:310 — `'CREATE POLICY %I_owner_write ON %I FOR ALL USING (user_owns_project(project_id)) WITH CHECK (user_owns_project(project_id))'` applied to project_parties, cost_accounts, cost_documents and cost_entries. lib/costs.ts:246 — `/** Financial records are never deleted — voiding keeps the row ... */`.
```

**Done when.**

- [ ] cost_entries, change_orders and cost_documents carry a BEFORE DELETE trigger (or the FOR ALL policies are split so no DELETE grant exists) that refuses deletion, following the shape of supabase/migrations/20260826_legal_hold_delete_guard.sql
- [ ] Any deletion that is genuinely required (org teardown, data-retention purge) runs through an explicit service-role path that writes an audit_logs entry first
- [ ] The stated invariant in lib/costs.ts:246 names the database guard that enforces it rather than describing a convention the schema does not hold

---

<a id="cost-11"></a>

## COST-11 · Money-path writes whose errors are swallowed: a failed rival-decline still reports a successful award, leaving every losing bid awardable

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/costDocs.ts:250-257`, `lib/costDocs.ts:196-201`, `lib/changeOrders.ts:176-188`, `lib/costs.ts:111-117`

**Mechanism.** This is the supabase-js pattern the earlier audits confirmed in the audit logger and six ticket writes, recurring on the cost paths. awardQuote marks the losing bids declined with `await supabase.from("cost_documents").update({ status: "declined" }).in("id", ...).in("status", ["draft","parsed"]).then(() => undefined, () => undefined)` (lib/costDocs.ts:253-256) — the `{error}` result is discarded and the function returns `{ ok: true }` unconditionally (line 263). revertDocTransition, the compensating action when money fails to post, uses the same swallow (lib/costDocs.ts:196-201), as does decideChangeOrder's revert of a failed approval (lib/changeOrders.ts:178-180) and the posted_entry_id link write (lib/changeOrders.ts:186-188). lib/costs.ts:111-117's audit helper does the same for every COST_* action.

**Failure scenario.** Three bids are grouped under one RFQ group. A controller awards the first; the commitment posts; the rival-decline UPDATE fails (a transient network error, or an RLS evaluation the client cannot see). awardQuote returns ok and the panel refreshes. The other two still read 'parsed', so the Award button stays live on both. A second controller — or the same one on a different day — awards a second bid as well, and a second commitment posts for the same scope. Two contractors now hold awards for one scope, and the budget line carries both. The same swallow means a failed revert in decideChangeOrder leaves a change order marked 'approved' with no cost entry behind it and no error shown to anyone.

**Evidence.**

```
lib/costDocs.ts:256 — `.then(() => undefined, () => undefined);` on the rival-decline update, followed at line 263 by `return { ok: true };`. lib/changeOrders.ts:180 — the same `.then(() => undefined, () => undefined)` on the compensating revert that the surrounding comment describes as "put the CO back so the retry is clean".
```

> **Verifier correction.** The headline consequence is REFUTED by the UI. QuotesPanel.tsx:205 computes `const awarded = groupDocs.find((d) => d.status === "awarded");` and every Award control in the group is gated on `!awarded` (:266, :309, :356), so a rival left in 'parsed' because the decline write silently failed is NOT awardable — the group renders 'Awarded to X' with no Award button on any row. The observable consequences are narrower: rivals keep showing 'Read — awaiting your review' instead of 'Not selected', and (the more serious case) a silently failed revertDocTransition leaves a document stuck in 'awarded'/'posted' after the money failed to post, so the retry the code promises returns 'This document is already awarded'. Severity reduced to MEDIUM on the corrected consequence.

**Done when.**

- [ ] The rival-decline update checks its {error} and its matched-row count, and awardQuote reports a partial outcome ("awarded, but the other bids could not be marked not-selected — refresh") rather than unconditional success
- [ ] revertDocTransition and decideChangeOrder's revert surface their failure to the caller so a claimed-but-unposted row is visibly stuck rather than silently stuck
- [ ] A reconciliation exists for the two orphan states the claim-then-post design can produce: cost_documents in 'awarded'/'posted' with no matching entry, and change_orders in 'approved' with posted_entry_id null
- [ ] The audit helpers in lib/costs.ts:111-117 and lib/costDocs.ts:78-84 at minimum log their failure rather than discarding it (cite the audit-logger finding in audit-reports/roles-and-permissions)

---

<a id="cost-12"></a>

## COST-12 · The Known Companies scorecard is structurally unable to score: three of the four party_id columns it queries are never written, and company_id and contract_value are written by mutually exclusive code paths

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/companies.ts:240`, `lib/companies.ts:246-253`, `lib/companies.ts:284`, `lib/companies.ts:299-301`, `lib/costs.ts:127-154`, `components/projects/ProjectWizard.tsx:177-186`, `components/projects/cost/QuotesPanel.tsx:461-466`, `lib/turnover.ts:152`, `lib/turnover.ts:174`, `lib/turnover.ts:253`

**Mechanism.** gatherCompanyProfile resolves a company to its project_parties rows by `eq("company_id", company.id)` (lib/companies.ts:240), then queries change_orders, turnover_items, punch_items and cost_documents by `.in("party_id", partyIds)` (lib/companies.ts:248-251). Two differently-shaped greps (`grep -rn 'party_id' ... | grep -v '.select('` and a per-caller check of QuotesPanel and QualityTab) show that three of those four party_id columns are never populated: uploadCostDoc accepts partyId (lib/costDocs.ts:114) but its only caller passes none (components/projects/cost/QuotesPanel.tsx:461-466), the intake quote branch inserts with no party_id (app/api/intake/upload/route.ts:83-92), and seedTurnoverItems/addTurnoverItem/addPunchItem accept partyId (lib/turnover.ts:152,174,253) but no UI caller supplies it. Separately, `company_id` is written only by ProjectWizard, and only on an exact lowercased name match (components/projects/ProjectWizard.tsx:181), while `contract_value` is written only by saveParty via the Costs tab's PartiesPanel (lib/costs.ts:137; components/projects/CostsTab.tsx:546) — and saveParty's patch type has no companyId field at all (lib/costs.ts:129). The two writers are disjoint, so `awardsTotal = parties.reduce(... p.contract_value ...)` (lib/companies.ts:284) is zero for every party the registry can actually see. awardQuote never writes contract_value either.

**Failure scenario.** A controller opens a contractor's company profile expecting the record the bid tab promises to show beside every price. Quality shows "No quality evidence yet" because turnover_items.party_id is null for every item. Cost discipline shows "No awarded work yet" because the wizard-created party that carries company_id has contract_value null. Bids is empty because cost_documents.party_id is null. Schedule depends on a case-insensitive name match on milestones.responsible_party. The composite therefore reduces to safety events plus a manually confirmed quality-manual percentage — and computeCompanyScorecard correctly averages only the known dimensions (lib/companyScore.ts:161), so a contractor with one commendation and no other data displays a composite of 100, banded "Excellent" (lib/companyScore.ts:170), on the screen where the plant chooses who welds its piping.

**Evidence.**

```
lib/companies.ts:284 — `const awardsTotal = parties.reduce((s, p) => s + (p.contract_value ? Number(p.contract_value) : 0), 0);` where `parties` came from the company_id filter at line 240. components/projects/ProjectWizard.tsx:178-183 inserts `{ org_id, project_id, name, kind, trade, company_id, created_by }` — no contract_value. lib/costs.ts:129 — saveParty's patch is `Partial<Pick<CostParty, "name" | "kind" | "trade" | "defaultRate" | "contractValue" | "contactName" | "contactEmail" | "status">>` — companyId is absent from CostParty entirely.
```

> **Verifier correction.** Severity reduced to MEDIUM: the failure mode is honest-null, not a wrong number. computeCompanyScore's cost dimension returns `{ score: null, detail: "No awarded work yet" }` when awardsTotal <= 0 (companyScore.ts:107-109) and null dimensions are excluded from the composite, so the scorecard shows blanks rather than a misleading rating. The defect is a dead feature and a set of write-only/never-written columns, not a scorecard that misinforms.

**Done when.**

- [ ] saveParty and the Costs tab's PartiesPanel let a party be linked to a Known Company, and CostParty/mapParty carry companyId
- [ ] awardQuote writes the awarded total to the party's contract_value (or gatherCompanyProfile derives awardsTotal from posted commitment entries rather than a hand-typed field)
- [ ] uploadCostDoc's caller and the intake quote branch resolve and set party_id (the intake link already names the company), and turnover/punch creation carries the responsible party
- [ ] gatherCompanyProfile reports honestly when a dimension is empty because the link is missing versus because no work happened — an unlinked company must not present as an unrated-but-clean one
- [ ] A composite built from a single commendation does not render as "Excellent": evidenceCount gates the band shown on the profile and in the bid tab

---

<a id="cost-13"></a>

## COST-13 · The number posted to the ledger is the model's reading of at most 8 pages, and the page-truncation signal is returned then thrown away

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/projects/cost-docs/route.ts:27`, `app/api/projects/cost-docs/route.ts:97`, `app/api/projects/cost-docs/route.ts:128`, `app/api/projects/cost-docs/route.ts:137`, `app/api/projects/cost-docs/route.ts:156`, `components/projects/cost/QuotesPanel.tsx:65-68`, `lib/costDocs.ts:226`, `lib/costDocs.ts:280`

**Mechanism.** The parse route caps rendering at `const MAX_PAGES = 8` and renders exactly pages 1..8 (app/api/projects/cost-docs/route.ts:27,97). Whatever total the model reports from those pages is written straight to the authoritative column: `patch.total_amount = quote.total` for quotes (line 128) and `patch.total_amount = total` for invoices (line 137). awardQuote and postInvoice then take that column as the money: `const total = fresh.totalAmount ?? parsedQuoteFrom(fresh)?.total;` (lib/costDocs.ts:226) and `const total = fresh.totalAmount ?? (fresh.parsed as { total?: number } | null)?.total ?? null;` (lib/costDocs.ts:280), and post it as a commitment or an actual. The route returns `pagesRead` (line 156) but readDoc parses the body only to extract an error and discards it: `const body = (await res.json().catch(() => null)) as { error?: string } | null; if (!res.ok) throw ...; onChanged();` (components/projects/cost/QuotesPanel.tsx:66-68). Nothing is stored on cost_documents recording how many pages the document actually has versus how many were read, and no UI surfaces it. The status label the reviewer sees is "Read — awaiting your review" (lib/costDocs.ts:26), with no indication the read was partial.

**Failure scenario.** A vendor submits a 14-page quote whose page 6 shows a base-scope subtotal of $182,000 and whose page 11 carries the bid summary of $431,000 including alternates and escalation. Pages 9-14 are never rendered. The model returns total 182000, total_amount is set to 182000, the bid tab shows the vendor at $182,000 against rivals near $430,000 and flags it "best value" on price. A controller clicks Award; the confirm dialog says "$182,000"; a $182,000 commitment posts. The contract the plant actually signed is $431,000, and the budget line under-reports its exposure by $249,000 with nothing on the record to show the read was truncated. The identical path exists for invoices, where the posted number is an ACTUAL.

**Evidence.**

```
app/api/projects/cost-docs/route.ts:27 — `const MAX_PAGES = 8;` and line 97 `renderKnowledgePages(doc.file_url, Array.from({ length: MAX_PAGES }, (_, i) => i + 1), MAX_PAGES)`. Line 128 — `patch.total_amount = quote.total;`. components/projects/cost/QuotesPanel.tsx:66-68 — the response body is read only for `error`; `pagesRead` is dropped.
```

> **Verifier correction.** Two corrections. (1) `pagesRead` is not a truncation signal — it lists the pages actually RENDERED (renderKnowledgePages skips pages > pdf.numPages, lib/knowledgePageRender.ts:41), and pdf.numPages is never returned or stored, so even a client that used pagesRead could not tell the reviewer the quote had 30 pages. The accurate statement is that no truncation signal exists at all; the dropped field is only a weak proxy (length === 8). (2) Mitigations exist and should be named: the extraction is human-reviewed before any money moves (status 'parsed' → an explicit Award/Post click), the reviewer sees the extracted total, line items and exclusions in the bid table, a human can override the number entirely via 'type total' → setManualTotal (QuotesPanel.tsx:73-86, costDocs.ts:320-333), and pagesRead IS recorded in audit_logs (route.ts:153). Severity reduced to MEDIUM on that basis.

**Done when.**

- [ ] The parse route records the document's true page count and the pages actually read on the cost_documents row, and returns both
- [ ] The review UI shows "read pages 1-8 of N" beside any partially-read document, and the award/post confirm dialog repeats it when the read was truncated
- [ ] awardQuote and postInvoice refuse to post, or require an explicit typed confirmation of the total, when the stored total came from a truncated read
- [ ] The audit_logs COST_DOC_PARSED and COST_DOC_AWARDED details carry the pages-read/pages-total pair so a later reconciliation can find truncated reads

---

<a id="cost-14"></a>

## COST-14 · voidCostDoc decides from a stale client snapshot, so an awarded or posted document can be voided while its cost entry stays on the budget

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/costDocs.ts:310-318`, `lib/costDocs.ts:170-192`, `components/projects/cost/QuotesPanel.tsx:172-174`, `components/projects/cost/QuotesPanel.tsx:360-362`

**Mechanism.** Every other state transition in this module routes through claimDocTransition, which re-reads the row and applies a compare-and-swap (`.eq("id", docId).in("status", fromStatuses)`, lib/costDocs.ts:183-190) precisely so two users on stale tabs cannot both move the same money. voidCostDoc does not: it tests the caller's in-memory `input.doc.status` (lib/costDocs.ts:312) and then issues an unguarded `update({ status: "void" }).eq("id", doc.id)` (lib/costDocs.ts:315) with no status predicate. The UI renders the Void button off the same stale snapshot (components/projects/cost/QuotesPanel.tsx:172, :360). The cost entry created by an award is not linked back to the document in any readable way, so voiding the paper leaves the commitment orphaned with no way to find it.

**Failure scenario.** Two controllers have the project's Costs tab open. Controller A awards a quote — status becomes 'awarded' and a $182,000 commitment posts. Controller B, whose tab still shows the quote as 'parsed', clicks Void on it. voidCostDoc reads the stale `parsed` status, passes its own guard, and unconditionally writes status='void'. The quote now shows "Void" and disappears from quoteGroups (lib/costDocs.ts:154 filters `d.status !== "void"`), while the $182,000 commitment remains in the rollup with no document behind it. The guard message that was supposed to prevent exactly this — "This document already moved money — void the cost entry itself if the amount is wrong" — never fires.

**Evidence.**

```
lib/costDocs.ts:312-315 — `if (doc.status === "awarded" || doc.status === "posted") { return { ok: false, ... }; }` followed by `const { error } = await supabase.from("cost_documents").update({ status: "void" }).eq("id", doc.id);` — `doc` is the caller's snapshot and the UPDATE carries no status predicate. Contrast lib/costDocs.ts:183-190, which re-reads and constrains the UPDATE by status.
```

> **Verifier correction.** Two corrections. (1) 'The cost entry ... is not linked back to the document in any readable way, so voiding the paper leaves the commitment orphaned with no way to find it' is wrong: awardQuote writes `description: \`Award — ${fresh.vendorName} (${fresh.rfqGroup})\`` and `reference: fresh.docNumber ?? fresh.fileName` (costDocs.ts:238-240), and postInvoice writes `Invoice — vendor` with the invoice number (:293-294), all of which the entry list renders. What is missing is a machine-readable FK (that is finding 14, cost_entries.source_document_id), not any trace at all. (2) Exploiting this requires a genuine concurrent race — one user holding a 'parsed' snapshot while another awards — so severity is MEDIUM, not HIGH. Worth noting the secondary effect the finding missed: because QuotesPanel gates the whole group's Award buttons on `groupDocs.find(d => d.status === "awarded")` (:205), voiding an awarded doc re-opens Award on its rivals, allowing a second commitment on the same scope.

**Done when.**

- [ ] voidCostDoc routes through claimDocTransition (from ['draft','parsed'] to 'void') so the guard runs against the database row, not the client snapshot
- [ ] The UPDATE carries `.in("status", ["draft","parsed"])` and a zero-row match is reported as "someone else just decided this document", matching the module's existing convention
- [ ] A test pins that voiding a document whose stored status is 'awarded' fails even when the caller passes a snapshot claiming 'parsed'

---
