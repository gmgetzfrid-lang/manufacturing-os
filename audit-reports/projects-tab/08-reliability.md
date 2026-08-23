# 08 · Reliability & failure modes

What the user sees when something breaks, what nothing is testing, and the
states that are declared but unreachable.

**11 findings** — 0 CRITICAL, 7 HIGH, 4 MEDIUM.

> Line numbers drift — **match on the quoted code.** See
> [`../README.md`](../README.md) for the protocol.

---

## The failure-mode matrix

Read this before working any individual finding — it is the shape of the whole
report.

| Condition | Costs tab | Quality tab | Coach / closeout gates | `/companies` | `/submit/<token>` |
|---|---|---|---|---|---|
| **Migration 20261013 not applied** | degrades quietly | **blank panel**, then **raw** `relation … does not exist` on first write | silently all-zeros | **raw** error in a red banner | quote branch unreachable — correct |
| **No AI key / unsigned / over cap** | clean, dismissible | clean, dismissible | n/a | **whole page blanked** (`UX-9`) | n/a |
| **R2 unavailable** | **raw** AWS SDK message | same | n/a | **misattributed** as "file may be corrupt" | "File storage failed — try again." — correct |
| **Policy denies a write** | **raw** RLS message | **raw** | gates read "No turnover requirements set" | **raw** + blanked | n/a |
| **Offline mid-action** | **wedged row** (`MON-1`) + raw `TypeError` | **blank** | silently zeros | raw + blanked | error shown — correct |
| **Malformed AI JSON** | 502, plain copy — correct | correct | n/a | correct | n/a |
| **Unrenderable PDF** | 415 pre-check + honest 502 — correct | no pre-check: burns the round trip first | n/a | same | n/a |
| **Supabase 500** | **raw** | **blank** on reads, **raw** on writes | silent zeros | **raw** + blanked | "Something went wrong" — correct |

---

## REL-1 · The companies registry spins forever if the org never resolves, with no error boundary to catch it

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability
- **Locations:**
  - `app/(protected)/companies/page.tsx:46` — `if (!activeOrgId) return;` with `loading` starting `true`
  - `components/providers/RoleContext.tsx:58` — `activeOrgId` starts null
  - `components/providers/RoleContext.tsx:315-325` — 15s timeout logs "role resolve timed out — proceeding" and continues **with the id still null**
  - `app/(protected)/companies/` — **no `error.tsx`, no `loading.tsx`** (14 other routes have one)
  - `app/(protected)/projects/page.tsx:64` — the same pattern, but documented
- **Re-verified:** hardening pass — **SURVIVES**. `refresh` returns early when `activeOrgId` is null (`companies/page.tsx:46-48`) and `setLoading(false)` sits inside the try that follows, so an org that never resolves leaves the page on its spinner. Directly downstream of `identity-and-session/SESS-1`, which is one way `activeOrgId` stays null.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Both halves check out — the terminal spinner and the full-app flash on cold navigation to /companies (the app/(protected)/projects/page.tsx:64 guard `if (!activeOrgId || !uid) return;` is the same pattern, but that route does have its own loading.tsx). One correction to the wording: an error boundary does exist and covers this route (app/(protected)/error.tsx), it just cannot catch a hang. Downgraded to MEDIUM because the hang requires the org to never resolve (RoleContext's watchdog at :83-90 and its 15s resolveOrgAndRole race make that an edge case), leaving the loading-shell flash as the routinely-hit half.

**Mechanism.** The refresh returns early when the org id is null and never
clears `loading`. The role resolver's timeout does not supply a fallback id.

**Failure scenario.** "Loading the registry…" forever — no error, no retry, no
timeout. And because the route has no `loading.tsx`, the nearest ancestor is
`app/loading.tsx`, which renders **outside** the protected shell — so a cold
navigation flashes the entire application away, sidebar included.

**Remediation.** Give the page a resolved/failed/loading tri-state rather than a
boolean; when the role resolver times out, render an explicit "couldn't
determine your organization — retry" state. Add `error.tsx` and `loading.tsx`
to `app/(protected)/companies/`, modelled on the projects route's.

**Done when.**
- A null org id produces an actionable error, not an infinite spinner.
- `/companies` has its own in-shell loading skeleton and error boundary.

---

## REL-2 · A broken Costs tab is pixel-identical to a brand-new one

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** diagnosability / trust
- **Locations:**
  - `lib/costs.ts:159-161, 204-208, 122-124` and `lib/costDocs.ts:86-91` — `{ data }` only, cannot throw
  - `components/projects/CostsTab.tsx:60-82` — the try/catch that therefore never fires
  - `components/projects/CostsTab.tsx:65` — the `.catch(() => [])` labelled "pre-migration tolerance", which is dead code
  - `lib/costDocs.ts:106-128` — `uploadCostDoc` uploads to R2 *before* inserting
- **Related:** `UX-10`, `REL-10`
- **Re-verified:** hardening pass — **SURVIVES**. `const { data } = await supabase…` with the error discarded, returning `[]` — `costs.ts:159-161`, `costDocs.ts:86-91`, and **8** such sites across the four projects libraries. A failed read is pixel-identical to an empty project.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Right as written, and the line that settles it is the missing `error` in each destructure. An RLS denial or a pre-migration schema returns `{ data: null, error: {...} }`, which becomes `[]`, which makes rollup.budget 0 and entries empty — pixel-identical to a fresh project, and (via CostCharts.tsx:45) it also flips the charts into watermarked EXAMPLE mode. HIGH is correct: the user is shown confidently wrong financial state with no error anywhere.

**Mechanism.** Because the list functions swallow errors one layer down, the
tab's own error handling is unreachable and the "tolerance" catch is dead.

**Failure scenario.** A project with 8 accounts, 40 entries and 3 awarded quotes
renders four `$0` tiles, no burn bar, every empty state — **and, because the
rollup is zero and there are no entries, watermarked EXAMPLE charts showing a
healthy $305,000 job** (`REL-10`). The user's only feedback is an invitation to
start over. If they take it, the upload posts the file to R2 (orphaning it) and
then surfaces a raw Postgres string.

**Remediation.** Fix at the source (`UX-10`): return errors from the list
functions. Then the tab's existing try/catch works, and the dead "tolerance"
catch can be removed or made real. Separately, insert the row before uploading
the bytes, or clean up the orphan on insert failure.

**Done when.**
- A failed read renders a failure state, not an empty state.
- A failed insert does not leave an orphaned R2 object.

---

## REL-3 · Raw Postgres error strings reach plant users at roughly twenty-two sites

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `lib/checklists.ts:127, 138, 204, 226`
  - `lib/turnover.ts:158, 179, 207, 275`
  - `lib/costDocs.ts:109, 128, 187, 316, 331`
  - `lib/changeOrders.ts:69, 111, 158`
  - `lib/companies.ts:85, 92, 124, 137, 183, 212`
  - Good precedents: `lib/companies.ts:134-136` (23505 → human copy), `components/projects/cost/QuotesPanel.tsx:545` (migration hint)
- **Re-verified:** hardening pass — **SURVIVES**, with the count made exact: **56** references to `error.message` / `error?.message` across the projects libraries — more than the ~22 claimed, though not every one reaches a user-facing surface. `checklists.ts:127` is representative.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The claim and its count hold — the cited lines total 22 and every one of them forwards a Postgres message straight to a plant user, with the single 23505 case at companies.ts:134-136 proving the codebase knows how to do better. Downgraded to MEDIUM: the impact is confusing UX plus minor schema disclosure (table and policy names), not lost or wrong data, and no privileged information beyond object names escapes.

**Mechanism.** Every write path returns `error.message` verbatim.

**Failure scenario.** What a superintendent sees when a policy denies a write,
or when a migration has not been applied, is a sentence about relations and
row-level security policies.

**Remediation.** Add a small `humanizeDbError(error)` helper mapping the common
codes — `42P01` (missing table → "needs migration N"), `42703` (missing
column, same), `23505` (duplicate), `23503` (foreign key), and the RLS message
(→ "you don't have permission to do that here") — and route all twenty-two
sites through it, falling back to a generic message plus a logged detail.

**Done when.**
- No raw Postgres string reaches a user in the Projects or Companies area.
- The underlying detail is still logged for diagnosis.

---

## REL-4 · Every database row enters the application as an unchecked cast

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness / availability
- **Locations:**
  - 178 type assertions across the 15 new libraries (companies 46, costDocs 23, changeOrders 22, checklists 21, projectSnapshot 18, turnover 17)
  - The dangerous shape — union cast on a raw string, 12 sites: `lib/costDocs.ts:69`, `lib/checklists.ts:63`, `lib/turnover.ts:97`, and others
  - `supabase/migrations/20260819_orphan_tables_backfill.sql:184, 193` — `cost_documents.status` and `kind` are plain `text NOT NULL`, no CHECK
  - `lib/changeOrders.ts:54`, `lib/costDocs.ts:68` — `Number(...)` with no finite guard
  - `lib/checklists.ts:80` — `Array.isArray(r.evidence)` checks array-ness, not element shape
  - `lib/companies.ts:75` — `qualityManualGaps` cast with no check at all
- **Related:** `MON-8`
- **Re-verified:** hardening pass — **SURVIVES**. `(r.status as CostDocStatus) ?? "draft"` (`costDocs.ts:69`) — `as` performs no validation and `??` catches only null, so any unexpected string enters the domain model intact. This is the input that makes `MON-8` throw.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The absence claim holds up on a repo-wide search: nothing validates a DB row anywhere — the `validate*` helpers that do exist (validateParsedQuote, validateSegmentedItems, validateRubricFindings) guard AI output, not database reads. There is even a concrete crash path: lib/costDocs.ts:181 does `COST_DOC_STATUS_LABEL[fresh.status].toLowerCase()`, which throws on any status outside the union. MEDIUM rather than HIGH, though: reaching it requires a row written outside these code paths, since the app's own writers only emit union values.

**Mechanism.** Rows are mapped field-by-field from `Record<string, unknown>`
with no runtime validation. `?? "default"` catches null and nothing else.

**Where an unmapped value lands.** One path **throws and hangs a button**
(`MON-8`). Five render as **blank chips** — turnover status, checklist kind,
cost-doc status, company kind, CO reason (only `StatusDot` defends with
`?? map.open`). Two produce **NaN**, which flows into `summarizeChangeOrders`,
`computeCostRollup`, the Donut, and `fmtMoney(NaN)` — which `Intl` renders as
the literal string **"$NaN"** with no throw and no guard.

**Remediation.** Three layers, cheapest first:
1. Add `CHECK` constraints to `cost_documents.status` and `.kind` so unmapped
   values cannot exist.
2. Make every label lookup total: `LABEL[x] ?? x`.
3. Guard every `Number(...)` with `Number.isFinite`, defaulting to 0, and have
   `fmtMoney` render an em-dash rather than "$NaN" for a non-finite input.

A schema-validation layer (zod at the row-mapping boundary) is the durable fix,
but the three above remove the user-visible damage for far less work.

**Done when.**
- No label lookup can return `undefined`.
- `fmtMoney(NaN)` never renders "$NaN".
- The database rejects an unmapped status or kind.

---

## REL-5 · One tab crashing unmounts the entire project page

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability
- **Locations:**
  - `app/(protected)/projects/[id]/page.tsx` — no per-tab boundary
  - `app/(protected)/error.tsx` — the only boundary, at segment level (well written; keeps the sidebar)
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The project page defines no error boundary, so a throw in any tab unmounts the whole route rather than the panel that failed.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The structural claim is right: no per-tab boundary, so one tab's crash takes the entire project page, and 'Try again' rebuilds the same crashing tab because the tab lives in the URL. The summary overstates the consequence: app/(protected)/error.tsx renders inside app/(protected)/layout.tsx — its own header comment says 'lands here — INSIDE the layout — so the sidebar and navigation stay alive' — so Sidebar and TopBar survive and Schedule is reachable by navigating back with ?tab=schedule. MEDIUM: this is missing defense-in-depth, and it only bites once some other bug throws.

**Mechanism.** An unhandled render exception anywhere in `CostsTab`,
`QualityTab` or `ScheduleTab` takes the header, the tab bar, the coach and the
status controls with it.

**Failure scenario.** The user is left with "Try again", which re-renders the
same crashing tree, and "Dashboard". There is no way to escape to a working tab
— so a bug in Costs makes Schedule unreachable too.

**Remediation.** Wrap each tab's content in a small error boundary that renders
"this tab couldn't load — [retry]" while leaving the rest of the page intact.
About fifteen lines.

**Done when.**
- A thrown error in one tab leaves the other six usable.

---

## REL-6 · Nothing tests any data layer, any new route's authorization, or any policy

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** regression risk
- **Locations:**
  - `lib/__tests__/projectControls.test.ts` — 17 tests, all pure functions
  - Untested: `costDocs`, `changeOrders`, `checklists`, `turnover`, `companies`, `projectSnapshot`, `projectReport`, `docFileServer` — none imported by any test
  - `app/api/projects/cost-docs/route.ts:68-72` (controller **or** project owner), `app/api/projects/checklist/route.ts:67` (any active member), `app/api/companies/quality-manual/route.ts:46` (Admin/DocCtrl only) — three different authority models, none pinned
  - `lib/__tests__/apiRouteAuth.test.ts` — **the harness already exists**
  - `vitest.config.ts` — `include: ["lib/__tests__/**/*.test.ts"]`, `environment: "node"`
- **Re-verified:** hardening pass — **SURVIVES**, by census. `lib/__tests__/projectControls.test.ts` covers pure computation; no test exercises a data-layer function, a route's authorization, or an RLS policy in this area.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Every part of the absence claim survives a repo-wide search: no data-layer module is imported by any test, the three new AI routes are absent from the only route-auth suite, and no policy or migration is exercised anywhere. HIGH is fair — the untested surface is exactly where REL-2 (dropped errors) and REL-3 (raw messages) live, which is why those defects could ship green.

**Mechanism.** The 17 new tests are good and cover the pure engines thoroughly,
including seven well-chosen regression pins. They do not touch anything that
talks to the database, and there are no policy tests of any kind in the
repository — so the new `SECURITY DEFINER` helper and twelve new policies ship
unverified.

`apiRouteAuth.test.ts` is precisely the missing pattern — a hoisted mock state,
a chainable Proxy mock of `@/lib/supabaseAdmin`, `POST(new NextRequest(...))`,
asserting 401/403/400/200. Its header states the motive: *"CI previously ran
zero tests above lib/, so a broken auth check on a route shipped green."*

**Remediation, in priority order.**
1. **The four routes' authorization**, in the existing harness — no config
   change needed. No token → 401; non-member → 403; member-not-owner-not-
   controller on cost-docs → 403; non-Admin on quality-manual → 403; plain
   member on checklist → 200. **Cheapest large win in the audit.**
2. `awardQuote` where the post fails *and* the revert fails (`MON-1`).
3. `voidCostDoc` against an awarded doc (`MON-3`).
4. `gatherCompanyProfile` with a fully-populated fixture — would have caught
   `MON-7` in one assertion.
5. `gatherProjectSnapshot` with one query erroring — assert it is
   distinguishable from an empty project, so the closeout gates cannot lie.
6. `computeChecklistProgress` / `computeTurnoverProgress` / `seedsForJobKind` —
   pure, ~20 lines of tests, and they feed the gates and the report.
7. `applyAssessment` never overwrites a manual note — the product's central
   promise, currently unpinned.

**Done when.**
- All four routes have authorization tests.
- The money paths have failure-mode tests.
- `gatherProjectSnapshot`'s error case is distinguishable from empty, and tested.

---

## REL-7 · The schema-health panel reports green when this feature's migration is missing

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** diagnosability
- **Locations:**
  - `lib/schemaExpectations.ts:29+` — `EXPECTED_TABLES` / `EXPECTED_COLUMNS`
  - Its own header: *"When a new migration creates a table, add it here — the health panel is only as honest as this list."*
- **Re-verified:** hardening pass — **SURVIVES**. `EXPECTED_TABLES` is a hand-maintained literal (`schemaExpectations.ts:29`), so a table this feature's migration adds is absent from the expectation set and its absence reads as green.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence and by a repo-wide search: nothing else feeds the health probe, so a database missing 20261013 reports healthy:true. The silent-empty half is also real — lib/checklists.ts:96 `const { data } = await supabase.from("project_checklists")...` discards the error and returns [], and lib/companies.ts:246-252 wraps every 20261013 table in `safe(...)`.

**Mechanism.** Migration `20261013` creates `change_orders`, `companies`,
`company_events`, `project_checklists`, `checklist_items`, `turnover_items`,
`punch_items`, and adds `cost_documents.rfq_group`,
`cost_documents.intake_link_id`, `project_intake_links.purpose`,
`project_intake_links.rfq_group`, `cost_entries.created_by_name`. **None of them
appear in the expectations list** (verified by grep: `change_orders: 0`,
`companies: 0`, `company_events: 0`).

**Failure scenario.** Migrations are applied by hand. `20261013` is skipped,
`/api/admin/schema-health` reports green, and the Costs and Quality tabs render
as empty, cheerful, apparently-working screens (`REL-2`).

**Remediation.** Add the seven tables and five columns. Then consider a tripwire
test — the export-coverage test already diffs table lists against
`CREATE TABLE` statements in `supabase/`; an equivalent for
`schemaExpectations.ts` would make this class of omission impossible.

**Done when.**
- Schema health reports red when `20261013` is unapplied.
- A tripwire prevents the next migration from being forgotten.

---

## REL-8 · A retried intake submission double-creates the record, the notification and the counter

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `app/api/intake/upload/route.ts:104, 121` — no dedupe key
  - `lib/companies.ts:304` — `submissionCount`, which the inflated counter feeds
- **Re-verified:** hardening pass — **SURVIVES**. The intake path inserts notifications (`intake/upload/route.ts:104`) and increments `submission_count` (`companies.ts:304`) with no idempotency key, so a client retry after a partial failure doubles both.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. No idempotency and no DB-level dedupe on the quote path or the new-document path, so a retried POST duplicates row + notification + counter. One partial mitigation the finding does not mention: a retried REVISION submission is caught by the pending-review guard at :257 (`if (d.pending_version_id && !(link.allow_auto_supersede && linkAuthored)) return bad(... 409)`), so only quotes and brand-new documents actually double-create. MEDIUM stands.

**Mechanism.** No idempotency key. A retried POST creates a second
`cost_documents` row and a second notification, and double-increments
`bump_intake_use`.

**Remediation.** Accept a client-generated idempotency key (or hash the file
bytes plus link plus filename) and return the original result on a repeat within
a window.

**Done when.**
- A retried upload of the same file returns the original record rather than creating a second.

---

## REL-9 · Six states are declared, accepted by the data layer, and reachable from no interface

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (each by grep)
- **Blast radius:** dead-end / feature-gap
- **Locations:**
  - `lib/checklists.ts:216` — `status: 'void'` accepted; only caller passes `"complete"` (`QualityTab.tsx:337`); `QualityTab.tsx:124, 135` filter `!== "void"` — also dead
  - `lib/changeOrders.ts:192` — `status: 'void'` accepted; `ChangeOrdersPanel.tsx:178-186` renders only Approve/Reject, so `CHANGE_ORDER_VOIDED` can never be emitted
  - `lib/costDocs.ts:20` — `kind: "po"`, no creator; and `cost_documents.kind` has no CHECK
  - `lib/companies.ts:24` — `status: 'inactive'` changes nothing anywhere
  - `lib/changeOrders.ts:186` — `posted_entry_id` written, read by nothing
  - `components/projects/ProjectWizard.tsx:147` — `setup_state` written, read by nothing
  - `lib/checklists.ts:188` — `addEvidence` has no callers; `documentId`/`href` never populated, and `QualityTab.tsx:458` renders evidence as a `<span>`, so even a populated href would be inert
  - `lib/checklists.ts:284, 292` — `equipmentTags` gathered by a 1000-row query on every sweep, read by no rule
  - `app/(protected)/companies/[id]/page.tsx:405` — `HistoryPanels` takes `scorecard` then `void scorecard;`
  - `lib/projectHealth.ts:57, 145` — `trend` is the literal type `"steady"` and is never rendered
- **Re-verified:** hardening pass — **SURVIVES**. `status: "open" | "complete" | "void"` is accepted by the data layer (`checklists.ts:216`) and `CHANGE_ORDER_VOIDED` is a declared outcome (`changeOrders.ts:192`) — states the API honours and no interface can reach.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The two load-bearing claims are correct, each confirmed by repo-wide grep: no interface can void a checklist (the only project_checklists delete is the createChecklist rollback at checklists.ts:137) and no interface can unwind an approved CO. One bullet is loose: company `status: 'inactive'` IS reachable — app/(protected)/companies/[id]/page.tsx:524 `<option value="inactive">` and it renders as a badge at companies/page.tsx:189 — so it is a state with no behavioral effect, not an unreachable one. Doesn't change the severity.

**Mechanism.** Each is a capability that exists in the data layer and cannot be
reached.

**Failure scenario.** The two that bite users: **a checklist created by mistake
can never be voided or deleted**, and **approving a change order is
irreversible from the interface** — to unwind it you must hunt the entry down
in the accounts panel and void it, after which the change-order row still reads
`approved` while its money is gone. That last one is worse because
`posted_entry_id` exists specifically to make the unwind exact, with a comment
saying so, and nothing reads it.

**Remediation.** Decide per item: wire it up or delete it. Priorities — add a
void action for checklists; add a void action for change orders that reads
`posted_entry_id` and voids exactly that entry; drop `kind: "po"`,
`status: 'inactive'`, `trend`, and the unused `equipmentTags` query (which is
also pure cost, per report `09`).

**Done when.**
- A mistaken checklist can be voided.
- An approved change order can be unwound in one action that voids exactly its entry.
- The remaining dead declarations are removed.

---

## REL-10 · Example charts can appear on a project that has real data, and the watermark is effectively invisible

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** trust
- **Locations:**
  - `components/projects/cost/CostCharts.tsx:45` — `hasRealData = rollup.budget > 0 || entries.some(e => e.status !== "void")`
  - `components/projects/CostsTab.tsx:484` — a blank budget is stored as 0
  - `components/ui/ChartKit.tsx:280-284` — the watermark, `opacity-[0.07]`, `aria-hidden`
  - `components/ui/ChartKit.tsx:285-288` — the amber chip, the only durable signal
  - `components/projects/cost/CostCharts.tsx:86` — `ForecastSentence`, unmarked
- **Related:** `REL-2`
- **Re-verified:** hardening pass — **SURVIVES**. `hasRealData = rollup.budget > 0 || entries.some((e) => e.status !== "void")` (`CostCharts.tsx:45`) is an OR, so a project with a budget and no entries — or entries and no budget — can satisfy one branch while other panels still render example series.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed. A 7%-opacity rotated word is below the threshold of a screenshot or a print, and every real signal ('Example data' chip, dashed border) is at the frame's top edge, so cropping to the forecast box or the S-curve yields something visually identical to live numbers. The 'project that has real data' path is real but indirect: it needs rollup.budget to compute to 0 with every entry voided — or, more plausibly, the silent-failure path in REL-2, which turns accounts/entries into empty arrays.

**Mechanism.** Two live routes back into example mode: voiding every entry on
budget-less accounts, and — more likely — **creating a chart of accounts before
setting budgets**, which is the natural order. It does not persist past the
first real entry, which is correct.

The watermark is the page's text colour at 7% opacity (≈1.08:1 contrast) and is
`aria-hidden`. Everything below the chip is unmarked, including the most
quotable element on the screen: a full-width green panel reading *"At this
performance you'll finish around $287,736 — $17,264 under budget."* The S-curve
legend prints bold real-looking figures. The bar list prints
`01-100 Piping subcontract $121,300 · of $190,000 budget`.

**Failure scenario.** A superintendent screenshots the region below the chip —
by cropping, or by capturing just the forecast box — and sends it to a VP. It is
indistinguishable from a real forecast.

**Remediation.**
1. Mark every figure inside `ExampleFrame`, not just the frame: prefix the
   forecast sentence with "Example — ", and add the word to the legend and the
   bar sublabels.
2. Make `hasRealData` count accounts as well as budget, so a chart of accounts
   with zero budgets does not read as an empty project.
3. Raise the watermark's contrast and repeat it, or replace it with a
   diagonal banner that survives a crop.

**Done when.**
- No dollar figure inside the example frame is unmarked.
- A project with accounts but no budgets does not show example data.

---

## REL-11 · The example promises four charts; the real interface can draw at most two

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / expectation
- **Locations:**
  - `components/projects/cost/CostCharts.tsx:89-99` — the example branch, containing `BarList`
  - `components/ui/ChartKit.tsx:134` — `BarList`'s **only** call site in the entire app
  - `components/projects/cost/CostCharts.tsx:123-129` — the real branch
  - `components/projects/cost/CostCharts.tsx:84, 95` — example hardcodes `"USD"`
  - `components/projects/cost/CostCharts.tsx:107` — `return null` when there is a budget but no schedule and no entries
  - `components/projects/cost/CostCharts.tsx:115-119` — the missing-planned-line hint, gated on the wrong condition
- **Re-verified:** hardening pass — **SURVIVES**. The example block renders four labelled panels (`CostCharts.tsx:89-94`), while the live path can produce at most two — the crew curve needs awarded labor hours and the burn-by-line needs entries.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — 'Burn by budget line' (ChartKit.tsx:134 BarList) is drawn only for stand-in data and can never appear for a project's own numbers, so the preview advertises a view the product does not have. The arithmetic in the title is loose (the example frame renders three charts plus the forecast sentence; the real path renders two charts plus the sentence), but the substantive defect is exactly as stated. MEDIUM stands.

**Mechanism.** "Burn by budget line" — arguably the most decision-useful cost
view — appears only inside the example branch. The crew curve additionally
requires an awarded quote **with parsed labour hours** *and* both schedule
endpoints.

Two adjacent defects in the same component:
- **The most common early state renders literally nothing.** With a budget but
  no schedule and no entries, `buildCostSeries` returns `[]` and the forecast
  returns null, so line 107 returns null — the chart region becomes a silent gap
  where four example visuals were a moment ago. The wizard's canonical first act
  is "add a budget", so this is the state right after onboarding.
- **The hint uses the wrong condition.** It renders on `!scheduleStart`, but the
  planned line is omitted when `hasPlan` is false — i.e.
  `budget <= 0 || !planStart || !planEnd`. **Measured:** budget 0 with a full
  schedule → planned line omitted, **no hint**.

**Remediation.** Render `BarList` for real data — it needs only accounts and
entries, both of which exist. Give the empty-chart state real copy ("add
milestones to see the spend curve") instead of returning null. Fix the hint's
condition to match `hasPlan`. Use the project currency in the example.

**Done when.**
- Burn-by-budget-line renders for real projects.
- A budget-only project sees an explanation rather than a blank region.
- The missing-planned-line hint fires whenever the line is missing.

---

## Verified sound — do not "fix" these

- **Idempotency on the money paths is genuinely good.** `awardQuote` /
  `postInvoice` compare-and-swap before money moves and re-read for fresh
  totals; `decideChangeOrder` checks the row count and explicitly notes that
  PostgREST reports a zero-match update as success; `seedTurnoverItems`
  name-dedupes; `saveCompany` maps 23505 to human copy. Double-clicking Award,
  Post or Approve cannot double-post.
- **AI failure copy is well written at the route layer** — 412/428/402 with
  actionable messages, 502 for malformed JSON, 415 with "ask the vendor for a
  PDF", "the file may be corrupt or password-protected". The honesty is written;
  it is the plumbing that loses it (`UX-8`, `UX-9`).
- **Export/restore parity is enforced by a tripwire test** and all seven new
  tables were added to both lists in FK-safe order. *Caveat: the tripwire matches
  `CREATE TABLE`, so the eight new `ALTER TABLE … ADD COLUMN` statements are
  outside its reach — which is how `REL-7` happened.*

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| REL-1 | HIGH | OPEN |
| REL-2 | HIGH | OPEN |
| REL-3 | HIGH | OPEN |
| REL-4 | HIGH | OPEN |
| REL-5 | HIGH | OPEN |
| REL-6 | HIGH | OPEN |
| REL-7 | HIGH | OPEN |
| REL-8 | MEDIUM | OPEN |
| REL-9 | MEDIUM | OPEN |
| REL-10 | MEDIUM | OPEN |
| REL-11 | MEDIUM | OPEN |
