# 09 · Performance & scale

Measured against a realistic customer: **120 projects**; one project with 400
milestones, 60 cost accounts, 900 cost entries, 40 quotes, 25 change orders, 300
checklist items, 80 turnover items, 200 documents; a **150-company** registry.

Query counts are exact (counted from `supabase.from(...)` call sites along each
path). Byte and timing figures are estimates derived from row shapes, not
measured against a live instance.

**11 findings** — 2 CRITICAL, 6 HIGH, 3 MEDIUM.

> Line numbers drift — **match on the quoted code.** See
> [`../README.md`](../README.md) for the protocol.

---

## The query budget

**Cold open of `/projects/[id]`, by tab:**

| Source | docs | costs | quality | schedule | intake | activity | members |
|---|---|---|---|---|---|---|---|
| `page.refresh()` | 12 | 12 | 12 | 12 | 12 | 12 | 12 |
| `WatchButton` | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| `ProjectCoach` gather #1 | 13 | 13 | 13 | **0** | 13 | 13 | 13 |
| Tab's own loader | 3 | 7 | 3 | 1 | 6 | 0 | 0 |
| `ProjectCoach` gather #2 *(forced)* | 0 | **13** | **13** | 0 | 0 | 0 | 0 |
| **TOTAL** | **29** | **46** | **42** | **14** | **32** | **26** | **26** |
| Serial round trips | ~7 | ~8 | ~8 | ~6 | ~9 | ~7 | ~7 |
| Est. JSON down | ~1.1 MB | **~2.8 MB** | ~1.6 MB | ~0.6 MB | ~1.2 MB | ~1.0 MB | ~1.0 MB |

**Tab switch (page already loaded):** docs 3 · **costs 20** · **quality 16** ·
schedule 1 · intake 6 · activity 0 · members 0.

**Common actions:** change one account's budget or pin **21** · void or post one
cost entry **20** · award a quote **24** · mark one checklist item satisfied
**19** · post a comment **27** · apply an AI assessment to a 300-item checklist
**304** (300 sequential) · open Report **19** (10 sequential) · **export all
projects 361 (360 sequential)**.

**Duplicate work inside one Costs-tab open:** `cost_entries` fetched **3×**
(2,700 rows, ~1.05 MB), `cost_documents` with `parsed` jsonb **3×** (~540 KB),
`milestones` **3×**, the `projects` row **4×**, `project_activity` **2×**,
`project_members` **3×**. There is no cache anywhere: bouncing
costs→quality→costs costs 56 queries and re-downloads all 900 cost entries three
more times.

---

## PERF-1 · The companies registry fires over eleven hundred queries per page view, with no cache, pagination or abort

- **Severity:** HIGH
- **Status:** OPEN
- **Assigned:** the user — rule on 'Back does not re-run it'; no code is owed until then — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED (query counts exact; timing estimated)
- **Blast radius:** performance / availability
- **Locations:**
  - `app/(protected)/companies/page.tsx:46-72` — the sweep, 4 workers, no `cancelled` flag, no `AbortController`
  - `lib/companies.ts:82-87` — `listCompanies`, `select("*")` with **no limit**
  - `lib/companies.ts:233-323` — `gatherCompanyProfile`, 9 queries in 3 waves
  - `app/(protected)/companies/page.tsx:74-79` — the kind and text filters, client-side only
  - `app/(protected)/companies/[id]/page.tsx:54-71` — runs the gather a **second** time for the clicked company
- **Re-verified:** hardening pass — **SURVIVES** as a mechanism, with the count restated. `listCompanies` is a single query; the N+1 is the block beneath it — `gatherCompanyProfile(c)` per company, four workers deep (`companies/page.tsx:55-65`) — and that function issues **8** queries. Total is `1 + 8N`, so the headline "over eleven hundred" corresponds to roughly 137 companies rather than being a fixed number. The defect, the absence of caching and the severity are unchanged; only the figure is conditional.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. Everything about the fan-out, the missing pagination and the missing abort is confirmed. Two corrections pull the severity down from CRITICAL: the page is not blocked — `setLoading(false)` fires at line 52 immediately after the list, so cards paint and the scores stream in; and the per-company cost is 9 only for companies with linked parties — `partyIds.length ? … : Promise.resolve([])` (companies.ts:249-254) collapses a company with no linked party to 2 queries, which per MON-7 is the common case. HIGH.

**Mechanism.** Each profile costs nine queries. Across 150 companies:
**1 + (150 × 9) = 1,351** ceiling; realistically ≈**1,141** (companies with no
party history short-circuit to 2).

**Four of those queries hit unindexed columns.** `change_orders`,
`turnover_items` and `punch_items` are indexed on `(project_id, status)` and
filtered by `party_id` → sequential scan. `cost_documents` is indexed on
`(project_id)` and `(intake_link_id)`, filtered by `party_id` → scan. And
`milestones` is queried with `.ilike("responsible_party", name)` with `pg_trgm`
installed but **no trigram index on that column** — at 400 milestones × 120
projects that is a scan of ~48,000 rows, run 150 times.

**Failure scenario.** Fifteen to forty seconds of background querying. Navigate
away mid-sweep and the four workers drain the queue to completion — and because
supabase-js multiplexes over one HTTP/2 connection, **the page you left slows
down the page you went to**. Press Back and all 1,141 run again. Adding one
company restarts the whole sweep.

**Remediation.**
1. **Paginate** — 20 companies per page, and gather profiles only for the
   visible page. 1,141 → ~180.
2. **Abort** — a `cancelled` flag in the worker loop, checked before each
   gather.
3. **Move the filters server-side** so filtering to "vendor" does not gather all
   150.
4. **Cache** the gathered profiles for the session so Back is free, and pass the
   clicked company's profile into the detail page instead of re-gathering.
5. Add the four `party_id` indexes and the two trigram indexes (`PERF-11`).

**Done when.**
- A `/companies` visit issues under 200 queries.
- Navigating away stops the sweep.
- Back does not re-run it.

**Partial (2026-09-29, projects Round G).** Three parts. (1) `lib/companies.ts` `gatherCompanyProfiles(companies)` is ONE batched gather: per evidence table, one `.in()` read per chunk of 200 ids (company ids or party ids), results bucketed client-side by company — never one query per company; `gatherCompanyProfile(c)` is the one-company wrapper. Fix pass, correctness at scale: every batched read now pages to exhaustion in 1000-row windows ORDERED BY id (`GATHER_PAGE_ROWS`, PostgREST's max-rows cap) — the first landing's `.limit(n × k)` reads were unordered and still capped at 1000 rows per response, so on a busy page (50 companies × 3 parties × 50 turnover items = 7,500 rows) most cards silently lost their Quality / Cost evidence; milestones are filtered by the companies' names IN THE DATABASE again (`responsible_party ILIKE`, per bounded name slice — `orFilterChunks`, names double-quoted so "Gulf Mechanical, Inc." stays one value, 80-id project chunks so the request line stays bounded) and matched exactly client-side, instead of every activity of every project being fetched; a source that errors contributes no rows rather than a partial set; before 20261096 the party-keyed quote read retries without `company_id` (the bid history no longer empties). Query count: 11 for one company and for a full page of 50, 13 for 150 (two more name-filter slices), 18 when 150 companies' parties span two id chunks. (2) `listCompaniesPage(orgId, { search, kind, page })` pages server-side (`COMPANY_PAGE_SIZE` 50, sorted by name, `count: "exact"`, kind `eq`, search as `name.ilike / trade.ilike` — second fix pass: the term travels as ONE double-quoted or() value (the gather's `orValue`), because stripping only `,()` left a typed `"` or `\` to break the filter into a parse error and the failed-load state; commas are now searchable too), on the trigram indexes 20261095 adds; `listCompanies` keeps its signature with a hard cap (`COMPANY_LIST_CAP`). (3) `app/(protected)/companies/page.tsx` loads one page, gathers evidence for that page only, and its effect cleanup flips a cancel token so a result arriving after navigation is dropped; no client cache (GAP-409). Tests: `lib/__tests__/companiesRegistry.test.ts` — its PostgREST double now enforces the 1000-row cap on every response, `range()`, `ORDER BY` and `or(ilike)`: query counts (11 / 11 / 13 / 18, always < 200; no per-company `eq("company_id")`), 7,500 turnover rows → every card keeps 120/150, a 2,500-activity schedule keeps all 1,200 of the company's milestones through the server-side name filter, the pre-migration quote read, the page/range/order/or calls.

**Done-when.**
- A `/companies` visit issues under 200 queries — ✓ (1 list + 11–13 gather for a page, pinned) — and now returns every row, not the first thousand.
- Navigating away stops the sweep — ✓ (there is no queue to drain: one batched gather whose result is discarded on cancel; the in-flight HTTP requests of that single round complete).
- Back does not re-run it — **not done, by decision**: GAP-409 says "do not fix this with a client-side cache; stale company data drives award decisions", and the brief pins "one server-side batched gather per page, no cache". Back re-runs one ~11-query gather for the visible page. The finding stays open on this item until the user rules on it.

**Scope / residual.** The detail page re-gathers its one company through the same function (a single-id batch). The RPC alternative (`company_profiles(org_id)`) was not needed: the census stays under 20. Migrations: `20261095_prj_roundG_registry_indexes.sql`, `20261096_prj_roundG_cost_doc_links_and_extent.sql` (DEC-30: applied by hand; the gather runs without them — the party-keyed reads degrade to the pre-migration shape, missing columns read as unknown).

---

## PERF-2 · Exporting all projects is 360 sequential round trips behind a button that gives no feedback

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED (round-trip count exact; timing estimated)
- **Blast radius:** availability / ux
- **Locations:**
  - `lib/projectExport.ts:114-129` — `exportAllProjectsToCsv`, serial `for` loop
  - `lib/projectExport.ts:34-61` — `loadProjectBundle`, itself 3 serial waves
  - `lib/projectExport.ts:40-42` — unbounded `checkout_sessions` and `project_documents` per project
  - `app/(protected)/projects/page.tsx:103-114` — the button, no busy state, not disabled while running
- **Re-verified:** hardening pass — **SURVIVES** as a mechanism, with the same caveat as `PERF-1`. `for (const p of projects) { const bundle = await loadProjectBundle(p.id, orgId); }` (`projectExport.ts:121-122`) is a strictly sequential await with no concurrency and no progress feedback; the round-trip total scales with project count rather than being fixed at 360.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. Both halves confirmed, including the re-click hazard: nothing debounces or guards the handler, so each impatient click starts another full sweep. But the work is async and non-blocking, produces a download, and corrupts nothing, so CRITICAL is too high; HIGH.

**Mechanism.** 120 projects × 3 serial round trips = **360 sequential**. At 80ms
that is ≈29 s; at 150ms (mobile or a distant region) ≈54 s. Everything
accumulates into one in-memory array, joined at the end.

**Failure scenario.** The button gives no feedback and stays clickable, so an
impatient user fires a second and third 360-round-trip sweep on top of the
first.

**Remediation.** Disable the button and show progress while running. Then
replace the per-project loop with a small number of bulk queries filtered by
`.in("project_id", ids)` and group in memory — three queries total instead of
360. For very large orgs, stream or chunk the CSV rather than building it all in
memory.

**Done when.**
- The export cannot be started twice concurrently.
- Progress is visible.
- The round-trip count is independent of the project count.

**Resolution (2026-09-30, projects Round G).** Reproduced: `exportAllProjectsToCsv` awaited `loadProjectBundle` per project (three serial waves each), the button had no busy state. `lib/projectExport.ts` now reads in bulk per batch of `EXPORT_PROJECT_BATCH` = 100 projects (the decided default, `DEC-54`): one `checkout_sessions` read and one `project_documents` read (in parallel), each — like the org's projects read — paged to exhaustion in `EXPORT_PAGE_ROWS` = 1,000-row windows ordered by id (PostgREST's max-rows cap: a full page is followed by the next, never taken as the whole set — the `lib/companies.ts` gather's rule), then the referenced documents in chunks of 200, grouped in memory; progress is reported per batch; an `AbortSignal` stops it between batches (`ExportCancelledError`, nothing downloaded); a refused read fails the export instead of shipping an empty section. The Export All button (`app/(protected)/projects/page.tsx`) is disabled while a run is in flight (a second click is a no-op), shows "Exporting n/N…" and offers Cancel. Cells go through `lib/csvSafe` (`PM-10`).
- Commit: `f4c65a9`
- Tests: `lib/__tests__/projectExport.test.ts` "3 projects and 99 projects cost the same number of reads; 150 costs one more batch", "progress is reported and a cancel stops the export", "a refused read fails the export", "the Export All button cannot start a second run and shows progress with a cancel", "a batch carrying more rows than PostgREST's 1000-row cap is read page by page — no project's checkouts are cut off" (the mock enforces the cap: 100 projects × 12 sessions ask for a second window and every section carries all 12), "an org with more than 1000 projects is read page by page too".

**Done-when.**
- The export cannot be started twice concurrently — ✓.
- Progress is visible — ✓.
- The round-trip count is independent of the project count — ✓ within a batch of 100 (1 + 3 reads per batch — 7 for 150 projects, against 450 before — when each read fits one 1,000-row page; a batch carrying more rows adds one read per extra 1,000 rows, never a silently short section).

**Scope / residual.** The CSV is still built in memory (streaming is the remediation's "very large orgs" note; not needed at the counts this area measured). *Fix pass (2026-09-30):* the first cut's bulk reads were unpaged — 1,000 rows per 100 projects under PostgREST's max-rows, where the per-project reads it replaced had 1,000 per project — so an org whose batch carried more checkout sessions (released ones accumulate forever) exported CHECKOUTS (0) for some projects and short DOCUMENTS sections with no warning. Paged as above.

---

## PERF-3 · The coach re-gathers on every Costs and Quality mount, throwing away thirteen queries every time

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects-joint J10b UI REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** performance
- **Locations:**
  - `components/projects/CostsTab.tsx:83` — `onDataChanged?.()` called from inside `refresh`, **outside** the try/finally
  - `components/projects/CostsTab.tsx:86` — `useEffect(() => { void refresh(); }, [refresh])`
  - `components/projects/QualityTab.tsx:72, 75` — identical
  - `app/(protected)/projects/[id]/page.tsx:183, 494, 505` — the three `coachKey` bump sites
  - `components/projects/ProjectCoach.tsx:33, 41` — cleanup sets `cancelled = true` but does **not** abort the requests
  - `lib/projectSnapshot.ts:25-26` — `cost_documents.select("*")`, pulling every `parsed` blob to read five scalar fields
- **Re-verified:** hardening pass — **SURVIVES**. `onDataChanged?.()` fires from the mount effect (`CostsTab.tsx:83`), so the coach's gather re-runs on every tab mount rather than on an actual data change.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The redundant mount-time gather is real, as is the fat select(*). But the finding double-counts: the gathers triggered by a budget-line edit or a posted comment are not thrown away — the coach's health scores and suggestions are derived from that snapshot, so refreshing them after a mutation is the intended behaviour, not waste. The genuine defect is the duplicated gather on mount plus the missing select-list narrowing, which is MEDIUM.

**Mechanism.** Both tabs call the data-changed callback from inside their
refresh, so it fires on mount as well as on mutation. The coach's cleanup only
suppresses the state update — there is no `AbortController` — so all 26 queries
execute and 13 results are parsed and discarded.

**Failure scenario.** Opening the Costs tab costs **46 queries** and ~2.8 MB.
Switching to it costs 20. Changing one budget line costs 21. Posting a comment
costs 27. The user sees a second spinner pass and the scores flicker.

**Remediation.** Move `onDataChanged?.()` out of `refresh` and call it only from
actual mutations. That single change takes the Costs open to 33 and the tab
switch to 7. Then give `gatherProjectSnapshot` an explicit column list instead
of `select("*")` on `cost_documents` and `projects` (~360 KB saved per open),
and add an `AbortController` to the coach.

**Done when.**
- Opening Costs gathers the snapshot once.
- The snapshot query selects only the columns it reads.
- An unmounted coach's in-flight requests are aborted.

**Partial (2026-09-29, projects Round G; amended 2026-09-29 and 2026-09-30 after review).** Two of the three limbs landed in full inside `lib/projectSnapshot.ts` + `components/projects/ProjectCoach.tsx`, not by lifting state into `page.tsx` or the tabs. The first limb is met with one bound.

*How the coach's gathers actually arrive (corrected 2026-09-30).* The page's own `refresh()` never re-keys a mounted coach. It sets `loading`, so `page.tsx:247` renders a spinner and the coach unmounts; the `coachKey` bump at `page.tsx:183` lands while it is unmounted, and the coach remounts afterwards. That happens on the page's initial load and after every write that calls `refresh()`: a comment, a status transition, `MembersTab` `onAdded`, `EditProjectModal` `onSaved`. The coach mounts together with the active tab. Its **first** re-key is therefore a Costs or Quality tab's mount-time `refresh()` bump (`CostsTab.tsx:83` / `QualityTab.tsx:72`), with no write behind it. Every later re-key follows a mutation inside that tab.

*Sharing is opt-in (2026-09-30).* `gatherProjectSnapshot(orgId, projectId, { signal, share })` starts its own round unless the caller passes `share: true`. Every round is recorded, so a later sharing request can join it while it is in flight or within `SNAPSHOT_REUSE_MS` (1.5 s) of it settling. The coach passes `share` only on that first re-key (`snapshotRekeyMayShare(initial, prev, key)`, exported and tested). The mount run gathers its own round, because it is a remount after a write. Every later re-key also gathers its own round. `page.tsx:196` (the closeout-gates dialog, J8's) passes nothing, so it keeps its pre-package semantics — always its own round — with no edit on J8's side. `fresh: true` is still accepted and never shares. `invalidateProjectSnapshot(orgId, projectId)` drops the recorded round so no later sharing request is served from before a write; `EditProjectModal` calls it.

*Deferred abort (2026-09-30).* When the last waiter aborts a round in flight, the abort now runs one macrotask later and re-checks the waiters. React runs the coach's effect cleanup and then its next effect in the same tick, so the first re-key's sharing run joins the mount round instead of the cleanup cancelling it first. The 2026-09-29 version aborted synchronously, so that join never happened.

*Column lists.* `projects` selects `purpose, goals, sow_document_id, job_kind`; `cost_documents` selects `kind, status, rfq_group, vendor_name, file_name`. No `select("*")`, no `parsed` blobs. All four `projects` columns arrive with migration 20261013, so no pre-migration column list exists to fall back to. On `42703` / `PGRST204` the gather names `PROJECT_FIELDS_NOT_MIGRATED` in `notMigrated` and reads nothing further. `cost_documents` re-reads without `rfq_group`, and every other column in that list predates 20261013. A `42P01` / `PGRST205` on a table 20261013 creates (`change_orders`, `project_checklists`, `checklist_items`, `turnover_items`, `punch_items`) is also named in `notMigrated` rather than `readFailures`. The 2026-09-29 note said `projects` fell back to a `purpose, goals` list. That list is itself 20261013, so the fallback could never succeed, and the test answered it in a state no database can be in.

*Abort.* The coach creates an `AbortController` per effect run and passes `signal`. Every direct query carries `.abortSignal(signal)`. When the last interested caller releases the round, the round's controller aborts the requests. A caller that shares a round another caller still wants does not cancel it.

Tests (`lib/__tests__/projectSnapshot.test.ts`): "a sharing request joins the round in flight; a default request is its own round", "a default request right after a write is never answered from the round before it", "abort-then-resubscribe in one tick (a coach re-key) keeps the round: the re-key's run joins it", "aborting the last interested caller cancels the round (one macrotask later)…", "one waiter aborting does not cancel a round another caller still wants", "a caller that arrives already aborted is refused without a query", "the sharing window is opt-in…", "the coach's re-key rule…", "invalidateProjectSnapshot…", "invalidating while a round is in flight…", "purpose, goals, job_kind and sow_document_id all arrive with 20261013…" (the mock answers `42703` to any select naming a missing column, as Postgres does), "re-reads cost_documents without rfq_group…", "a table 20261013 creates answering 42P01 is 'not migrated'…", "selects only the columns it reads" (source pin). Reproduced: `ProjectCoach.tsx:30-41` at `8276cad` set `cancelled = true` only, and `projectSnapshot.ts:22,25` selected `*`. The review's scratch test (mount run aborted, then a sharing run in the same tick) gave 2 milestone reads on the 2026-09-29 code and gives 1 now.

**Done-when.**
- Opening Costs gathers the snapshot once — met with one bound. On a page opened on Costs or Quality, the coach's mount round and the tab's mount bump share one round, pinned by the abort-then-resubscribe test. Switching to the tab later costs one gather: the bump. The bound is that a tab whose load lands more than `SNAPSHOT_REUSE_MS` after the coach's round settled costs a second round. The window, and the bump behind it, go with `PERF-4`, and the finding stays OPEN until then.
- The snapshot query selects only the columns it reads — ✓.
- An unmounted coach's in-flight requests are aborted — ✓ (one macrotask after the last waiter releases).

**Scope / residual.** The rest of the first done-when is `PERF-4`'s (P2 / P3). Once `onDataChanged?.()` is called only from mutation handlers, those handlers call `invalidateProjectSnapshot`, and `SNAPSHOT_REUSE_MS` can be 0. The J8 suggestion recorded on 2026-09-29, passing `{ fresh: true }` at `page.tsx:196`, is withdrawn: the default is now unshared. `listAccounts` / `listEntries` (`lib/costs.ts`, P3's) do not take a signal and are not aborted; nor, since the 2026-09-30 verification fix below, does `listChangeOrders` (`lib/changeOrders.ts`, J3's).

*Read failures.* The coach names every read the gather could not make (`readFailures`, an amber `role="status"` line) and every table or field the database has not been migrated for (`notMigrated`, a muted line). Since 2026-09-30 the engine acts on both. `computeProjectHealth` scores null every part that depends on a named read, with the detail "Could not read <label>" or "Needs migration 20261013 (…)", and excludes it from the composite: Cost ← cost accounts, cost entries, and milestones once an account is pinned; Schedule ← milestones; Change control ← cost accounts, change orders; Quality ← checklists, checklist items, turnover, punch. `buildCoachItems` drops every suggestion that an absence would raise from a zero it did not read: budget, schedule, pin-ev, baseline, sow, purpose, checklist, parties, links, members. The map is `SNAPSHOT_READS` in `lib/projectHealth.ts`. The banner therefore says "…are left out, not counted as empty" and that is now true. The 2026-09-29 banner said the score treated failed reads as unknown while the engine never read `readFailures`. Tests: `projectSnapshot.test.ts` "a refused checklist_items read scores Quality unknown — never 'Checklists clear' at 100" and "a refused read drops the part and every suggestion its zero would raise"; `projectControls.test.ts` "a read the snapshot could not make is left out of the score…" and "a suggestion raised by an absence is dropped…".

**Verification fix (2026-09-30, projects Round G).** The paragraph that stood here said `listAccounts` / `listEntries` still return `[]` on a refused read, so a refused cost read reached the gather as an empty ledger and "Add a budget" could still show. That stopped being true when J3 merged: `REL-2` made them throw, and the gather's `call` (`lib/projectSnapshot.ts:188`) names the read. The code comment saying otherwise is corrected. Test: `projectSnapshot.test.ts` "refused cost accounts: named in readFailures, no 'Add a budget' at the top, Cost and Change control unknown". The failure is injected at the table (the earlier test injected `readFailures` into the snapshot); `readFailures` is `['cost accounts']` and Cost scores null. The same fix made two more changes here. (1) Change orders are read through `listChangeOrders`, the Costs tab's reader (see `MON-5`). That read is `select("*")` plus, when an approved change order has a linked entry, one `cost_entries` read by id. It is no longer one of the column-listed direct queries above, and like the other list functions it takes no abort signal. A `42P01` / `PGRST205` on it is still named in `notMigrated`, because the thrown error now carries its code (`lib/changeOrders.ts:167`). (2) `"RFQ groups"` in `notMigrated` is now acted on. Before 20261013 every quote tabulates alone, so the award suggestion, raised from the unawarded-group count, is left out (`RFQ_GROUPS_NOT_MIGRATED`, `lib/projectHealth.ts:104,320`). That makes the coach's not-migrated line (`ProjectCoach.tsx:104`, "the suggestions that need it are left out") true for every entry the snapshot can name. Tests: `projectSnapshot.test.ts` "before 20261013 every quote tabulates alone… the award item is left out" (fails on `9b4c5f4`) and "after it, one unawarded RFQ group raises the award item".

**Resolution (2026-10-01, projects Round G).** Package J10b UI REMAINDERS removed the tab-mount bump that the 2026-09-29 bound depended on (see `PERF-4`). `components/projects/CostsTab.tsx` and `components/projects/QualityTab.tsx` no longer call `onDataChanged?.()` from `refresh`. A tab's load tells the page nothing, so opening Costs or Quality, or switching to it, never re-keys the coach. Every write goes through one `afterWrite` callback in that order: the tab's re-read lands, then `invalidateProjectSnapshot(orgId, projectId)` drops the recorded round, then `onDataChanged?.()` re-keys the coach, so the coach's re-gather is its own round, issued after the write. A read retry (Costs "Try again", a Quality section's Retry) re-reads and tells nobody. A project opened on Costs or Quality now costs exactly the coach's mount round, and switching to the tab later costs nothing.
- Tests: `lib/__tests__/j10bTabsDataChanged.test.ts` "PERF-3 — opening Costs or Quality under the coach gathers the snapshot ONCE" covers both tabs. The real `ProjectCoach` is mounted beside the tab as the page mounts it, and `gatherProjectSnapshot` calls are counted. Opening makes 1 call; the base made 2, and the second shared the round only inside the window. After a write the order is gather, invalidate, told, gather. The tests fail on the base code: the code was stashed and the tests run.

**Done-when.**
- ✓ Opening Costs gathers the snapshot once. The bound recorded on 2026-09-29 is gone: no tab mount re-keys the coach. *Corrected in review (2026-10-01):* this line said there was then no second round for the window to catch, whatever the timing. The page's own first-load `refresh()` still re-keys the mounted coach once, and the first-re-key share and the window absorb that run (see the residual).
- ✓ The snapshot query selects only the columns it reads (2026-09-29).
- ✓ An unmounted coach's in-flight requests are aborted (2026-09-29).

**Scope / residual.** `SNAPSHOT_REUSE_MS` (1.5 s) and the coach's first-re-key `share` (`snapshotRekeyMayShare`) are load-bearing. *Corrected in review (2026-10-01):* this paragraph first said they were vestigial and that retiring them would change no behaviour. That was false. `refresh()` in `app/(protected)/projects/[id]/page.tsx` calls `setLoading(false)` as soon as the project row lands (`:197`, `PERF-8`), so on the first load the coach mounts and starts its mount round with key 0. The same `refresh()` then awaits members and checkouts and bumps `coachKey` (`:232`) while the coach is mounted. That bump is the coach's first re-key, and no write precedes it. The share joins it to the mount round while that round is in flight; the window joins it when the round settled less than 1.5 s before. The 2026-09-30 paragraph above ("the page's own `refresh()` never re-keys a mounted coach") stopped being true when `PERF-8` landed. A later `refresh()` shows no spinner either, so its bump re-keys the mounted coach as a later re-key, which follows a write and gathers its own round. The bound: when members and checkouts land more than `SNAPSHOT_REUSE_MS` after the coach's round settled, the first load costs a second round. The Costs and Quality `onDataChanged` re-keys (`page.tsx:660`, `:671`) follow a write whose `afterWrite` has already invalidated the round, so they gather their own round.
- Test: `lib/__tests__/j10bTabsDataChanged.test.ts` "PERF-3 — the page's first-load refresh() bumps the key of a MOUNTED coach: the first-re-key share absorbs it". The real `gatherProjectSnapshot` runs under the real `ProjectCoach`. The harness mounts the coach when loading ends, lets its round settle, then bumps the key once, as `refresh()` does. Result: two coach runs, one round. Negative controls, each a scratch edit that was restored: `SNAPSHOT_REUSE_MS = 0` gives 2 rounds; `snapshotRekeyMayShare` returning false fails (the bump does not ask to share); a bump landing 1.5 s after the round settled gives 2 rounds.
- *For J12:* keep the first-re-key share (or drop the bump on the first load), and only then consider setting the window to 0. The share and the window are in `lib/projectSnapshot.ts` and `components/projects/ProjectCoach.tsx`, J12's files this round; the bump is `page.tsx:232`. The comments there that say `refresh()` remounts the coach after every write (`ProjectCoach.tsx` header, `snapshotRekeyMayShare`'s doc) carry the same stale premise. *Review note:* the window is safe today only because every `onDataChanged` caller invalidates first. A future caller that told the page about a write without calling `invalidateProjectSnapshot` would let the coach's first re-key reuse a snapshot gathered before the write, inside the 1.5 s window. Retiring the window would remove that hazard, but only once the first-load bump no longer depends on it.

---

## PERF-4 · An unbounded query loop is held back only by an eslint-disable comment

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects-joint J10b UI REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED (latent — does not fire today)
- **Blast radius:** availability
- **Locations:**
  - `components/projects/CostsTab.tsx:84` — `// eslint-disable-next-line react-hooks/exhaustive-deps`
  - `components/projects/QualityTab.tsx:73` — the same
  - `app/(protected)/projects/[id]/page.tsx:494` — `onDataChanged={() => setCoachKey(k => k + 1)}`, an inline arrow
- **Related:** `PERF-3` (same root)
- **Re-verified:** hardening pass — **SURVIVES**. `// eslint-disable-next-line react-hooks/exhaustive-deps` sits directly above the query effects in both `CostsTab.tsx:84` and `QualityTab.tsx:73` — the loop is prevented by a suppressed lint rule rather than by the dependency array being correct.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The loop mechanism is real: adding onDataChanged to the deps gives refresh a new identity each render, the effect refires, refresh calls onDataChanged, setCoachKey re-renders, repeat forever. Two inaccuracies: it is ~5 queries per iteration in CostsTab and ~3 in QualityTab, not 'roughly twenty', and only one tab is mounted at a time; and the shipped code is correct today, so this is a latent maintenance trap rather than a live outage — MEDIUM.

**Mechanism.** The callback is an inline arrow, so it gets a new identity on
every page render. `setCoachKey` re-renders the page → new callback → but
`refresh`'s `useCallback` deps are `[orgId, projectId]` only, held there by the
suppression comment. So `refresh`'s identity stays stable, the effect does not
re-fire, and the loop breaks.

**Failure scenario.** **Remove that comment and let the lint rule "fix" the
dependencies — which is exactly what `react-hooks/exhaustive-deps` demands — and
you get an unbounded loop at roughly twenty queries per iteration.** A latent
outage sitting behind a suppression comment, with no test and no note saying
what it holds back.

**Remediation.** Fixing `PERF-3` removes the feedback edge entirely, at which
point the suppression can be removed safely. If it must stay in the interim,
wrap the callback in `useCallback` at the page level and add a comment naming
the loop the suppression prevents.

**Done when.**
- The suppression is gone, or it carries a comment explaining exactly what it holds back.
- Removing it cannot produce a loop.

**Partial (2026-09-29, projects Round G).** The half this package owns landed: `gatherProjectSnapshot` records each round per project (`PERF-3`), and the coach's first `coachKey` bump (a tab mounting) opts in to sharing the round in flight, so it costs no queries inside the reuse window. Later bumps gather their own round, because they follow a write (amended 2026-09-30). But the loop this finding describes is in the *tabs'* own effects — `CostsTab.tsx:84` and `QualityTab.tsx:73` (`// eslint-disable-next-line react-hooks/exhaustive-deps` over a `refresh` that calls `onDataChanged` from inside itself) — and those are P3's and P2's files. Removing the suppression there requires moving `onDataChanged?.()` out of `refresh` into the mutation handlers (then the honest dependency list is `[orgId, projectId]` with no warning) and, optionally, `useCallback` on the inline arrow at `page.tsx:494` (J8's). When they do, each mutation handler should also call `invalidateProjectSnapshot(orgId, projectId)` (`lib/projectSnapshot.ts`) before `onDataChanged?.()`, so the coach's re-gather can never be served from a round issued before the write; with the mount-time bump gone, `SNAPSHOT_REUSE_MS` can be set to 0 (only in-flight sharing kept) and `PERF-3`'s first done-when closes with this one. Left OPEN for those packages; listed under this package's `filesOutsidePlan`. Done-when not met here: the suppression is still present at both sites; the loop remains latent (the shipped code is correct today, as the pass noted).

**Resolution (2026-10-01, projects Round G).** Package J10b UI REMAINDERS took the remediation's first branch. The feedback edge is gone, and the suppression went with it.
- `components/projects/CostsTab.tsx`: `refresh` (`useCallback`, deps `[orgId, projectId]`) loads and does nothing else. The `// eslint-disable-next-line react-hooks/exhaustive-deps` above it is removed, and its dependency list is the honest one. `afterWrite` (`useCallback`, deps `[refresh, orgId, projectId, onDataChanged]`) re-reads, invalidates the snapshot round (`PERF-3`) and then calls `onDataChanged?.()`. Every writer is handed it: `LedgerHealth` `onChanged` / `onCoRepaired`, `QuotesPanel` `onChanged`, `ChangeOrdersPanel` `onMoneyMoved`, `AccountForm` `onDone`, `AccountDetail` `onChanged` and `PartiesPanel` `onChanged`. "Try again" stays on `refresh`.
- `components/projects/QualityTab.tsx`: the same split. `refresh` and `loadAuthority` set state only inside promise callbacks, so the React compiler's `set-state-in-effect` rule holds with no suppression. Every section's `onChanged` is `afterWrite`, and every `onRetry` is the read-only retry.
- `onDataChanged` is now a dependency of `afterWrite` only, never of the load or its effect. The page's fresh inline arrow (`page.tsx`, the Costs and Quality `onDataChanged`, unchanged) therefore changes `afterWrite`'s identity and nothing else, and no effect re-fires on it.
- Tests: `lib/__tests__/j10bTabsDataChanged.test.ts` renders each tab inside a page harness that passes a fresh inline `onDataChanged` on every render, bumping the page's own state, as `page.tsx` does.
  - Costs: "mount re-reads once and tells the page nothing; a write re-reads, invalidates the snapshot round, THEN tells the page — once".
  - Costs: "no loop: the page's fresh inline callback on every render never re-fires the load". Five forced page re-renders come before and after a write; the result is 1 load, then 2, and one tell.
  - Costs: "a read retry … tells the page nothing".
  - The Quality twins, with a turnover Assign as the write.
  - A source pin: "no react-hooks eslint-disable, onDataChanged only inside afterWrite".
  - A Costs-tab writer census. *Review fix:* the rendered tests drive one Costs writer, because the quotes panel stands in for all of them. The census pins the rest at the source. Each of `<QuotesPanel>` `onChanged`, `<ChangeOrdersPanel>` `onMoneyMoved`, `<LedgerHealth>` `onChanged` and `onCoRepaired`, `<AccountForm>` `onDone`, `<AccountDetail>` `onChanged` and `<PartiesPanel>` `onChanged` is rendered once and handed `afterWrite`. `<EntryForm>`'s `onDone` is `AccountDetail`'s `onChanged`. `refresh()` is called in exactly three places: the mount load, inside `afterWrite`, and the "Try again" read retry. Reverting any writer to a bare `refresh` fails the test. This was checked by reverting `onMoneyMoved` and running it. The Quality tab's equivalent is `qualitySignoff.test.ts`'s `onChanged={afterWrite}` count.
  - These fail on the base code: the code was stashed and the tests run. `lib/__tests__/qualitySignoff.test.ts`'s loader pins were moved to the new shape.

**Done-when.**
- ✓ The suppression is gone at both sites. The source pin checks that neither file has a `react-hooks` eslint-disable, and `npx eslint` exits 0 on both files without one.
- ✓ Removing it cannot produce a loop. The load's dependencies hold no callback from the page, and the rendered no-loop tests drive the page's inline-arrow shape through writes and re-renders.

**Scope / residual.** None for this finding. *Corrected in review (2026-10-01):* this line first said `PERF-3`'s reuse window was now vestigial. It is not. The window and the coach's first-re-key share absorb the page's first-load `coachKey` bump (`page.tsx:232`), which lands while the coach is mounted (see `PERF-3`'s residual).

---

## PERF-5 · The execution board renders eight hundred components into a viewport showing fifteen

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** projects-joint J12 SERVER REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Assigned:** projects-joint J14 PROJECTS FOLLOW-UPS — the remainder (done-when 1 on a slow CPU: the drag's per-day-offset re-render in `components/projects/ExecutionView.tsx`; remediation 4, the dependency picker) — by the integrator, 2026-10-07, at the J12 merge (DEC-31).
- **Assigned:** projects-joint, the remainder: done-when 1 at 4× CPU throttle, a measurement only, with no code owed. Re-run J14's harness (`scratchpad/j14perf5/runab.sh`) on a quiet host, or time a deployed build. Proposed by projects-joint J14 PROJECTS FOLLOW-UPS, 2026-10-07, in its review's fix pass (DEC-31). The integrator names the package, or takes the run itself, at the J14 merge.
- **Verification:** CONFIRMED (structure); node counts estimated
- **Blast radius:** performance
- **Locations:**
  - `components/projects/ExecutionView.tsx:816, 849` — `rows.map` twice: 400 `OutlineRow` + 400 `Bar`
  - `components/projects/ExecutionView.tsx:808` — the `maxHeight: 70vh` scroller
  - `components/projects/ExecutionView.tsx:945` — `SummaryStrip`'s `items.filter(m => !items.some(c => c.parentId === m.id))` — **O(n²)**, not memoized, not `React.memo`'d
  - `lib/criticalPath.ts:43, 45` — the same shape
  - `components/projects/ScheduleTab.tsx:139-147` — `planLeafStats`, O(n²), run twice
  - `components/projects/TaskDetailPanel.tsx:690-693` — `wouldCreateCycle` per candidate, each rebuilding a Map and running a DFS
  - `components/projects/ExecutionView.tsx:842, 1395` — `DependencyArrows`, plain component, 4 `new Date` per edge per render
  - Grep for `react-window|react-virtual|virtuoso|IntersectionObserver` across the Projects surface → **zero hits**
- **Re-verified:** hardening pass — **SURVIVES**. `rows.map(…)` (`ExecutionView.tsx:816`) inside a `maxHeight: "70vh"` container (`:808`) with no virtualization or windowing anywhere in the file.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Non-virtualized rendering, the O(n²) leaf scans, the unbounded dependency dropdown (TaskDetailPanel.tsx:690-693 maps every task through wouldCreateCycle), and the MIN_PX_PER_DAY floor are all confirmed. The '~250,000 comparisons per drag frame' figure is wrong: ExecutionView.tsx:225 `const critical = useMemo(() => computeCriticalPathLite(items), [items]);` and drag state never touches `items`, so the O(n²) pass runs once per data change, not per pointermove. What does re-run per frame is the un-memoized `rows.map` over Bar (declared at :1172 as a plain `function Bar(`), which is a rendering cost, not a comparison cost.

**Mechanism.** No virtualization anywhere. Worse, the summary strip's quadratic
leaf computation recomputes on **every pointermove frame during a drag**,
because `setDrag` re-renders the parent.

**Failure scenario.** At 400 milestones: ~8,000–15,000 DOM nodes for ~15 visible
rows, and ~250,000 comparisons per drag frame — visible stutter. At 5,000: ~100k
nodes, 25M comparisons per frame, and the dependency dropdown becomes a
5,000-option list that blocks the main thread. `MIN_PX_PER_DAY = 30` also means
"Fit" cannot fit a long schedule (a two-year project is ~22,000 px wide).

**Remediation, in order of return.**
1. Memoize the leaf set — one `useMemo` keyed on `items` removes the per-frame
   quadratic work. Cheapest fix, biggest immediate effect.
2. `React.memo` `SummaryStrip`, `Bar`, `OutlineRow` and `DependencyArrows`.
3. Virtualize the outline and bar lists.
4. Replace the dependency `<select>` with a searchable picker that does not
   render every task.

The calendar view is the one safe surface — it caps at 4 chips per day with
"+N more".

**Done when.**
- Dragging a task on a 400-row schedule does not drop frames.
- The board's DOM node count is proportional to what is visible.

**Partial (2026-09-30, projects Round G).** Remediation 1–3 landed; 4 did not, and done-when 1 cannot be measured here. (1) The leaf set is computed once per data change in `ExecutionView` (`useMemo` over the full list) and handed to `SummaryStrip`, which is `React.memo`'d with a memoised `overallPercent` — the O(n²) `items.some(…)` scan no longer runs per render or per drag frame; `ScheduleTab`'s `planLeafStats` is one pass over a parent set; `criticalPath.ts` builds its children map once. (3) The outline and the bars are WINDOWED: `lib/rowWindow.ts` (`rowWindow`, `scrollTopToReveal` — fixed-height rows, no dependency) picks the rows in view plus an overscan of 8; spacers of the same height keep every row and bar where it was; keyboard navigation scrolls by index (a row that is not rendered cannot `scrollIntoView`). (2) `DependencyArrows` keeps its memoised props, so a drag (which touches none of them) does not rebuild it; `Bar` / `OutlineRow` are not memo'd — windowing bounds them to the window. The dependency picker's cycle filter is one O(n + e) closure instead of a DFS per candidate (`SCH-9`). Tests: `scheduleEngineUi.test.ts` "PERF-5 ·" — a 400-leaf board renders at most 40 outline rows and 40 bars while still counting 0 / 400 tasks; `rowWindow` / `scrollTopToReveal` arithmetic; a source pin that the strip no longer scans items × items and both lists render `windowRows`.

**Done-when (so far).** 2 ✓ (DOM rows proportional to the viewport, not the schedule). 1 not verified: no browser here to measure frames; per-frame work is now bounded to the window and a memoised strip, but "does not drop frames" is unmeasured.

**Scope / residual.** Remediation 4 (a searchable dependency picker in place of a `<select>` of every task) is not built; `MIN_PX_PER_DAY = 30` still keeps "Fit" from fitting a two-year schedule.

**Partial (2026-10-01, projects Round G).** Package projects-joint J12 SERVER REMAINDERS measured done-when 1 in a browser, found what still cost a drag frame, and removed most of it. Done-when 1 holds at normal CPU speed and not on a 4× slower CPU, so the record stays OPEN (its review: the first landing ticked done-when 1 from three runs whose drag still showed more long frames than the no-drag control).
- **The measurement.** The pre-installed Chromium (`/opt/pw-browsers`, Chromium 141, driven by the machine's existing Playwright 1.56; nothing installed) loaded `components/projects/ExecutionView.tsx` bundled standalone (Vite, the data and `next/*` modules stubbed, the app's built Tailwind CSS linked) on a 400-row board (20 phases × 19 tasks over a year, a third of the tasks linked), 1440×900. A script pressed a bar and dragged it 360 px in 120 pointer moves ~16 ms apart, recording every animation frame and every long task (`PerformanceObserver('longtask')`), with a no-drag control (the same mouse moves, no press) at 1× and 4× CPU throttle, three runs each. DOM: 1,578 nodes, 22 bars and 24 outline rows drawn for 400 tasks (done-when 2's window, unchanged).
- **What it found.** At 1× the board kept up (0–1 long task per drag). At 4× — a slower laptop — each change of the drag's day offset cost ~90 ms: 9–11 long tasks per drag (776–1,011 ms), 11–13 frames over 25 ms, the worst frame 100–233 ms. A CPU profile put most of it in `fmtDayUTC` / `fmtDateUTC` and `Axis`: `toLocaleDateString(…, options)` builds a new Intl formatter on every call, and every drag frame re-rendered the axis (one label per tick across a year) and every bar's tooltip.
- **The fix.** The board's three date shapes are formatted by one `Intl.DateTimeFormat` each, built on first use (same output — pinned); `Axis` and `Gridlines` are `React.memo`'d (they depend on the domain and the zoom only, which a drag does not touch).
- **After (the first landing's three runs, host load average ~25).** At 4×: no long task; 2–4 frames over 25 ms per drag against 0–2 in the no-drag control; the worst frame 33–67 ms. At 1×: no long task; 0–3 frames over 25 ms (control 0–6).
- **Re-measured in the review fix pass** — the same harness and build, ten runs, host load average 4.2–7.0. At **1×**: no long task in any drag; 1 frame over 25 ms across the ten drags (the control: 2); the worst drag frame 33 ms — the drag is indistinguishable from the control. At **4×**: a long task in 5 of the 10 drags (1–3 per drag, 61–195 ms in all; the control: none in any run); 0–6 frames over 25 ms per drag (32 across the ten; the control 0–4, 7 across the ten); frames over 50 ms in 3 drags (5 in all; the control: none); the worst drag frame 117 ms (control 33 ms). The 95th-percentile frame is 16.8 ms in every run, drag or not: most of a drag is smooth, but on a slow CPU some day-offset changes still cost more than a frame. DOM unchanged: 22 bars, 24 outline rows for 400 tasks.
- Commit: `329ba59`.
- Tests: `lib/__tests__/prjRoundGJ12.test.ts` "PERF-5 — a drag does not rebuild the axis or construct a date formatter per label" (no per-call `toLocaleDateString` left in the board; the three cached formatters; the memo'd axis and gridlines; the cached formatters print what `toLocaleDateString` printed). The measurement harness is not in the repository (it needs a browser and is a one-off).

**Done-when.**
- ◐ Dragging a task on a 400-row schedule does not drop frames — ✓ at normal CPU speed (ten drags, no long task, frame times matching the no-drag control); **✗ at 4× CPU throttle** (a slower laptop): half the drags still show a long task and up to six frames over 25 ms (worst 117 ms) that the control does not.
- ✓ The board's DOM node count is proportional to what is visible (above; re-observed: 24 rows and 22 bars for 400 tasks).

**Scope / residual.** Owed for done-when 1 on a slow CPU: what is left of the per-day-offset re-render while dragging — each change of the drag's day offset still re-renders the board's windowed bars and outline rows and the dependency arrows' geometry (`Bar` / `OutlineRow` are not memo'd; windowing only bounds them). Not built here; the board (`components/projects/ExecutionView.tsx`) is projects-tab P6b's schedule file, edited here only for the formatter and the axis memo. Owner: none yet. Remediation 4 (a searchable dependency picker) and the `MIN_PX_PER_DAY = 30` floor that keeps "Fit" from fitting a two-year schedule are not done-whens and stay as recorded above. Measured headless on a standalone bundle of the board with stubbed data and stubbed `next/*` modules (the harness is in the package's scratch space, not the repository), not on a deployed build against live data.

**Partial (2026-10-07, projects Round G).** Package projects-joint J14 PROJECTS FOLLOW-UPS took the drag's per-day-offset re-render out of the board and built remediation 4. *Corrected (J14 fix pass):* this block was first headed "Resolution" and the finding marked RESOLVED. Its review held that done-when 1 at 4× is not shown, on the same pattern J12's review kept OPEN: the drag still had more frames over 25 ms than its no-drag control. The finding is OPEN again (below).
- **A drag frame re-renders the dragged bar only** (`components/projects/ExecutionView.tsx`).
  - `Bar`, `OutlineRow` and `DependencyArrows` are `React.memo`'d.
  - Every windowed row gets ONE stable handler object per task id: toggle, select, status, progress, duration, open, sequence, the pointer handlers, nudge and resize. Each handler calls the board's LATEST callbacks through a ref that `useLayoutEffect` updates after every render. A row's props therefore change only when its own data or its own drag state changes, and a change of the drag's day offset re-renders the dragged bar and nothing else.
  - Before the change, `Bar` and `OutlineRow` were plain components handed fresh inline closures, so all were re-rendered. `DependencyArrows`, also a plain component, rebuilt its geometry over every task and link on any parent render.
- **Remediation 4, a searchable dependency picker** (`components/projects/TaskDetailPanel.tsx` `PredecessorPicker`). The `<select>` of every task is now a search box: "Add a predecessor — type to search the project's tasks".
  - It opens on focus and draws at most `PREDECESSOR_PICKER_LIMIT` (20) matches, saying "Showing 20 of 399 — type to narrow."
  - A query matches when every word of it is in the name, case aside (`matchPredecessors`).
  - Enter takes the first match, Escape closes, and a hidden-by-filter task says so.
  - *J14 fix pass (accessibility):* the first cut replaced the native `<select>` with a search input and a list of buttons, with no combobox semantics and no arrow keys, a step back for a keyboard or screen-reader user. It now follows the ARIA 1.2 combobox pattern. The input is a `combobox` (`aria-expanded`, `aria-controls` naming the list, `aria-autocomplete="list"`, `aria-activedescendant`). The matches are a `listbox` of `option`s with no buttons inside, and the active one is `aria-selected`. ArrowDown / ArrowUp (Home / End) move the active option, opening the list when it is closed. Enter picks the active option (the first match when none is active), and Escape closes. Typing resets the active option, focus never leaves the input, and a press on an option does not blur it.
  - The candidates are the same: no cycle, not already a predecessor, never the task itself (SCH-9's test pins them, now through the search box).
- **Counted, not timed:** `lib/__tests__/j14ExecutionDragMemo.test.ts`, on the 400-task board.
  - The work a render does is observed through two pure helpers it calls on every render. `Bar` and `OutlineRow` ask `isImportedMilestone`; the arrows ask `resolveVisibleDepIndex` for every task and link.
  - One drag frame now calls the first at most once (the dragged bar) and the second never. Run against the board before the change, the same frame called the first 80 times (40 windowed outline rows + 40 bars), so the assertion fails there.
  - The dragged bar still moves, the move still goes to the confirmation sheet, and a renamed task still re-renders its row (the memo never holds a stale row).
  - Picker cases: no `<option>` per task; closed until asked; 20 drawn of 399 and counted; a word narrows it; a click saves the link; Enter takes the first match; a word matching nothing says so; the matcher's rule. *J14 fix pass:* "the ARIA 1.2 combobox" (roles and wiring, collapsed / expanded, ArrowDown / ArrowUp / Home / End clamped at the ends, Enter picks the ACTIVE option, typing resets it, Escape closes, ArrowDown opens it) and "a press on an option keeps the input focused". Both fail against the first cut. The 400-task drag case has an explicit 30 s timeout: it passed alone and timed out at the 5 s default under a host load average of 30. Its assertions are counts, not times.
  - `scheduleEngineUi.test.ts`'s SCH-9 case reads the candidates through the search box, and its PERF-5 source pin follows the windowed maps.
- **Timed, at 4× CPU throttle** (done-when 1 on a slow CPU, the J12 record's open limb).
  - J12's harness, reused: a standalone bundle of the board with stubbed data (400 tasks) and stubbed `next/*`, in headless Chromium 141 with CDP's `Emulation.setCPUThrottlingRate`. A 120-step drag of a bar (360 px) was timed against a no-drag control over the same window.
  - Six runs alternated the board before and after the change. The host was busy (load average 7–15), so the numbers are noisy.
  - Before: the drag showed 6 long tasks in six runs (355 ms in all; one run had a 250 ms frame), and 36 frames over 25 ms against the control's 24.
  - After: the drag showed 1 long task in six runs (52 ms), and 14 frames over 25 ms against the control's 12. Its worst frame was 50 ms, and no frame was over 50 ms.
  - At 1×, after: no long task and no frame over 25 ms in six drag runs. Before, the same runs had 6 frames over 25 ms.
  - Honestly: at 4× the drag is now within this host's noise of its own no-drag control (the control shows a long task too). It is not proven free of every dropped frame on every slow machine. The deterministic evidence is the counted test above. The harness is in the package's scratch space (`scratchpad/j14perf5/`, its runs in `runs/`), not in the repository.

**Done-when.**
- ◐ Dragging a task on a 400-row schedule does not drop frames. At normal CPU speed: ✓ (no long task and no frame over 25 ms in six runs). At 4× throttle: NOT shown. After the change the drag still had more frames over 25 ms than its no-drag control (14 against 12 in six runs; worst frame 50 ms; one 52 ms long task). That was on a host at load average 7 to 15, and J12's review kept this finding OPEN on the same pattern. *Corrected (J14 fix pass):* this line first read "✓ … at 4× throttle within the control's own noise", which claimed more than the runs show (`DEC-29`). The fix pass did not re-run it, because the host was at load average 30. Per frame, the drag re-renders one bar where it re-rendered 80 components and the arrow geometry (counted, above).
- ✓ The board's DOM node count is proportional to what is visible (unchanged: 24 rows and 22 bars for 400 tasks in the harness).

**Scope / residual.** OPEN for done-when 1 at 4× only: a measurement, with no code owed (the remainder's Assigned line, above). Re-run `scratchpad/j14perf5/runab.sh` (six or more alternating runs, before and after, against the no-drag control) on a quiet host, or time a deployed build. If the drag's frames over 25 ms are not above the control's, done-when 1 holds and PERF-5 closes. If they still are, the record names what the profile shows. The `MIN_PX_PER_DAY = 30` floor that keeps "Fit" from fitting a two-year schedule is not a done-when and stays as recorded above. It is named for the integrator; this package did not verify it as a defect, so it opens no finding (`DEC-29`).

---

## PERF-6 · PDF rendering plus inference can exceed the function's own time limit, and the user gets "HTTP 504"

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** intelligence I-09 (the renderer) and projects-joint J12 (the cost-docs route deadline) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Assigned:** the user — by the integrator, 2026-10-07, at the J12 merge (DEC-31: I-09 and J12 have both merged). The one remainder is done-when 1's measurement: time one real ten-page scanned PDF through `/api/projects/cost-docs` on the deployed app. If it finishes inside the limit, PERF-6 closes; if it does not, the finding names the stage that overran.
- **Verification:** CONFIRMED (arithmetic); SUSPECTED (hosting plan cap)
- **Blast radius:** availability / cost
- **Locations:**
  - `lib/knowledgePageRender.ts:25-56` — whole-PDF download into one array, then a **serial** render loop at 1400px
  - `app/api/projects/cost-docs/route.ts:24` — `maxDuration = 120`, `timeoutMs: 90_000`
  - `app/api/projects/checklist/route.ts:32`, `app/api/companies/quality-manual/route.ts:27` — same shape
  - `lib/ai/providerCall.ts:128-129` — retries share one 90s `AbortSignal`, which is correct
  - Client call sites with no timeout and no abort: `QuotesPanel.tsx:61-70`, `QualityTab.tsx:178-189`, `QualityTab.tsx:296-305`
- **Re-verified:** hardening pass — **SURVIVES**. `renderKnowledgePages` does an R2 fetch, a PDF rasterize and an inference call (`knowledgePageRender.ts:25-36`) behind a route declaring `export const maxDuration = 120` (`cost-docs/route.ts:24`), with no client-side timeout handling to turn the platform 504 into a message.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The gap is real — 90s of model budget plus up to 8-10 serially rendered PDF pages is not bounded below the 120s function limit, and the client's fallback string is literally the status code. Downgraded to MEDIUM because the outcome is a bad error message plus a wasted (billed) call rather than data loss or corruption, and the render step would have to consume >30s for the overrun to actually trigger.

**Mechanism.** For a ten-page **scanned** vendor quote — exactly the document
this route exists to read:

| Step | Time |
|---|---|
| Cold start + native binding load | 0.5–2 s |
| R2 download (20 MB scan) | 1–4 s |
| 10 × render at 1400px, **serial** | 10–30 s |
| **Pre-AI total** | **12–36 s** |
| AI budget | up to **90 s** |
| **Worst case** | **≈126 s vs. a 120 s limit** |

**Failure scenario.** All three clients do
`await res.json().catch(() => null)` then throw `body?.error || \`HTTP ${res.status}\``.
A platform timeout returns a non-JSON 504, so `body` is null and the user sees a
red banner reading literally **"HTTP 504"** after two minutes of spinner. The
document is unchanged, and the model call the customer's own key was charged for
is lost.

**Memory:** peak ≈95 MB above baseline for one ten-page read (raw PDF + PNG
buffers + base64 array + the JSON body + fetch's copy). Two concurrent reads on
one warm instance push toward an out-of-memory kill, which surfaces as a bare
500 the user cannot distinguish from "the AI failed".

**Token cost:** ≈2,530 image tokens per page → ≈20,000 input tokens for an
8-page cost-doc read, ≈25,000 for a 10-page checklist read. Billed to the
customer's own key, and a 504 burns it entirely.

**Remediation.**
1. Render pages **in parallel** with a small concurrency cap, and lower
   `RENDER_WIDTH` — 1400px is well above what the models need.
2. Budget the AI timeout from the time remaining after rendering, rather than a
   fixed 90 s.
3. Free each page buffer after base64 encoding; stream rather than holding both.
4. Give the clients an `AbortController` and a timeout, and render a real
   message for a non-JSON response instead of "HTTP 504".
5. Confirm the hosting plan actually permits `maxDuration = 120`; if it is
   clamped to 60, every scanned read fails today.

**Done when.**
- A ten-page scanned PDF completes well inside the function limit.
- A timeout produces a readable message, not "HTTP 504".
- Two concurrent reads do not exhaust memory.

**Partial (2026-09-30, projects Round G).** The route half, package default taken (a deadline of `maxDuration` − 15 s; a readable 504 naming the page cap; no queueing built). New `lib/routeDeadline.ts`: `routeDeadline(maxDuration)`, `beforeDeadline(work, deadline)` (the route stops waiting at the deadline — the renderer takes no signal, so it is abandoned, not cancelled), `aiBudgetMs(deadline, 90_000)` (what is left, capped; `null` under 10 s — refuse before spending the caller's key on a call that cannot land) and `tooLargeToReadMessage(cap)` — *"The document was too large to read in time — try fewer pages (this reader reads at most the first 10)."* `app/api/projects/checklist/route.ts` (segment and assess) and `app/api/companies/quality-manual/route.ts` take the deadline at the top of `POST`, race the render against it, budget the governed call from what is left instead of a fixed 90 s, and map a model timeout (`isTimeoutError`) to the same readable JSON 504 (assess, which renders nothing: *"The assessment did not finish in time — try again."*). The clients already print `body.error`, so the user reads the sentence, not "HTTP 504". The page cap is in the API RESPONSE: both answers carry `pageCap`, and a quality manual read to the cap carries the note *"Only the first 10 pages were read; a longer manual may cover more than this shows."* The Quality tab and the company page do not show it yet — `components/projects/QualityTab.tsx:183` reads only `items` / `sourceLabel` / `error`, and `app/(protected)/companies/[id]/page.tsx:210` only `score` / `findings` / `error` — so a user whose 40-page manual was judged on 10 pages is not told on screen (see the residual). `lib/knowledgePageRender.ts` is not edited (intelligence `FLOW-11` / `FLOW-13`). Tests: `lib/__tests__/routeDeadline.test.ts` (the arithmetic, the race and its timer hygiene, an abandoned rejection swallowed, a census that both routes are on the deadline with no fixed 90 s left); `apiRouteAuth.test.ts` "PERF-6 — running out of time is a readable 504…": the model budgeted from the time left (a 40 s render leaves 65 s), too little time left → 504 with the readable message and no model call, a render that never finishes abandoned at 105 s, a model timeout → the readable 504 on both routes; and "PERF-6: the page cap is in the response…". Reproduced first: against `3ae0b06` these cases failed (fixed `timeoutMs: 90_000`, no deadline, a model timeout surfaced as a 502 with the raw error).

**Done-when.**
- A ten-page scanned PDF completes well inside the function limit — not done: the render cost (serial pages at 1400 px, the whole PDF held in one buffer) lives in `lib/knowledgePageRender.ts`, which intelligence `FLOW-11` / `FLOW-13` own. What landed guarantees an ANSWER inside the limit, not a completed read.
- A timeout produces a readable message, not "HTTP 504" — ✓ for the checklist and quality-manual routes (render and model phases); not for `/api/projects/cost-docs`, which is P3's file (tests only here) — it adopts the same three calls from `lib/routeDeadline.ts`.
- Two concurrent reads do not exhaust memory — not done: renderer memory, the same owner as the first item.

**Scope / residual.** Stays OPEN for the renderer items (intelligence) and the cost-docs route (P3). Showing the cap on screen is the UI owners': the company page's quality-manual confirm is projects J4's region (`COST-3`, "shows pages read / total" — J4's branch reads `pagesRead` and its own `pagesTotal` there; it can show `note` as it stands), and the Quality tab's checklist reader is J2's file (it can show `pageCap` beside the proposed items). Remediation item 5 (does the hosting plan permit `maxDuration = 120`?) is an operator fact this environment cannot see.

**Partial (2026-10-01, intelligence Round G, I-09 — the renderer limb).** `lib/knowledgePageRender.ts`:
- **Parallel under a cap shared by every read in the process.** Pages render in parallel lanes, and every render in the process shares `RENDER_SLOTS` (2). Two concurrent reads hold at most two page canvases between them, not one per page per read. A released slot passes straight to the next waiter, so a newcomer can never overfill.
- **The document is released.** The parsed PDF is destroyed when the read ends. The PDF engine is loaded once per process (`onceUnlessRejected`). Fix pass: a failed load is not kept. The first version cached the import promise with `??=`, so one rejected `import("unpdf")` on a cold start failed every later render in the warm process, the ask route's deep read included. The base code had retried the import on every call. Now the next caller loads it again (test: "the engine is loaded once per process — and a failed load is not cached").
- **A deadline.** A caller passes `deadlineAt`; no page STARTS after it, and the pages not started are reported, not absorbed.
- **The slots are always given back** (third fix pass). Before, a render that never returned held its slot forever, and every later read in the process waited on it with no bound. Now each page render races `PAGE_RENDER_TIMEOUT_MS` (45 s); a render past it is abandoned, its page counted failed, its slot released. A read still waiting for a slot when its `deadlineAt` passes stops waiting, removes its waiter, and counts its pages not started. `renderKnowledgePages` gives a caller that names no deadline `DEFAULT_RENDER_BUDGET_MS` (60 s); in the normal case the ask route's deep read, quality-manual, checklist and cost-docs render as before. The cost: an abandoned render keeps its canvas until it ends (the engine has no cancel), so while one hangs a page canvas can be in flight beyond `RENDER_SLOTS`.
- **The width is a parameter** (`FLOW-13`); the default stays 1,400 px.
- `renderKnowledgePages` keeps its old contract for the routes that use it: the images only, fewer on failure.

Tests: `lib/__tests__/knowledgePageRender.test.ts` ("one read renders in parallel, never more than RENDER_SLOTS at once …"; "two concurrent ten-page reads share the cap …"; "a deadline stops new pages from starting …"; third fix pass: "a hung render releases its slot …", "a read waiting for a slot stops waiting at its deadline …", "renderKnowledgePages gives a caller that names no deadline the default budget …", "a deadline beyond setTimeout's range waits …", and the regression pins "a normal render through renderKnowledgePages … is unchanged" and "a caller with no deadline still waits for a busy slot and renders every page, as before").

**Done-when.**
- A ten-page scanned PDF completes well inside the function limit — partly. The serial loop is gone (two pages at a time), and a reader that passes `deadlineAt` ends with the pages that fit instead of a platform timeout. No render was timed against a real ten-page scan here. The checklist, quality-manual and cost-docs routes still race the whole render with `beforeDeadline` and do not pass `deadlineAt`; that edit is their owners' (the projects packages).
- A timeout produces a readable message — not this limb (the cost-docs route is projects-joint J12's).
- Two concurrent reads do not exhaust memory — ✓ for the renderer: at most `RENDER_SLOTS` page canvases are in flight per process, and each read's document is destroyed. Each read's own PDF bytes are still held whole while it reads. Exception (third fix pass): a render abandoned at `PAGE_RENDER_TIMEOUT_MS` keeps its canvas until it ends, past the cap.

**Scope / residual.** Stays OPEN for the cost-docs route (J12) and for the timing check against a real scan.

**Partial (2026-10-01, projects Round G).** Package projects-joint J12 SERVER REMAINDERS put `/api/projects/cost-docs` on the deadline (the route limb of done-when 2 above). The route takes `routeDeadline(maxDuration)` at the top of `POST`; the render races it (`beforeDeadline`) — past it, 504 with `tooLargeToReadMessage(8)` and the model is never called; the page count gets its own 10 s budget inside the deadline and is UNKNOWN (null) after it, never a refusal and never the model's time; the governed call's `timeoutMs` is `aiBudgetMs(deadline, 90_000)` — what is left, capped at 90 s, refused under 10 s before the caller's key is spent; a model timeout (`isTimeoutError`) is the same readable 504. The route joins the deadline census.
- Commit: `7e3999c`.
- Tests: `lib/__tests__/costDocsRoute.test.ts` "PERF-6 — the read answers inside the function's own limit, with a readable 504" (the budget is what is left, capped; a render past the deadline → 504 naming the cap, no model call, nothing written; too little time after the render → 504 before the key; a model timeout → the same 504; a page count that never answers is null after its budget and the model keeps its 90 s); `lib/__tests__/routeDeadline.test.ts` census now names the route.

**Done-when.**
- A ten-page scanned PDF completes well inside the function limit — **not done**: the render's cost lives in `lib/knowledgePageRender.ts` (intelligence `FLOW-11` / `FLOW-13`), as above.
- ✓ A timeout produces a readable message, not "HTTP 504" — now for all three page-reading routes (checklist, quality manual, cost documents).
- Two concurrent reads do not exhaust memory — **not done**: renderer memory, same owner.

**Scope / residual.** OPEN for the two renderer items (intelligence). The cost-docs read caps at 8 pages (`MAX_PAGES`), and the cap is named in the 504.

**Integrator, at the projects-joint J12 merge (2026-10-07).** With I-09 (the renderer) and J12 (the route) both merged, done-whens 2 and 3 are met:
- **Done-when 2 ✓.** A timeout gives a readable message on all three page-reading routes.
- **Done-when 3 ✓ for the renderer.** At most `RENDER_SLOTS` page canvases are in flight per process, each read's document is destroyed, and the abandoned-render exception above still holds.
- **Done-when 1 is met only in part.** The serial loop is gone and there is a deadline, but no render has been timed against a real ten-page scan.

The finding stays OPEN for that measurement only. It cannot run in CI, because there is no real scan to time.


---

## PERF-7 · Applying an AI assessment issues one update per item, sequentially

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects-joint J12 SERVER REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** availability / data-integrity
- **Locations:**
  - `lib/checklists.ts:150-176` — `applyAssessment`, N+1 updates, per-row errors swallowed with a bare `continue`
  - `lib/checklists.ts:298-322` — `runAutoEvidence`, same shape plus a snapshot-based array append
- **Related:** `SAF-2`
- **Re-verified:** hardening pass — **SURVIVES**. `for (const p of input.proposals)` with a per-item write inside (`checklists.ts:158-161`) — the batch is a loop, not a batch.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Confirmed at both cited sites — sequential awaited updates from the browser, no batching/upsert, plus an O(n²) `items.find` inside the runAutoEvidence loop. MEDIUM rather than HIGH: for a realistically sized checklist (50-150 items segmented from a 10-page PDF) this is a 5-20s spinner, not a broken feature. Worth noting the loops also swallow per-row errors (`if (!error) applied += 1` / `if (error) continue`), so a partially applied assessment reports a lower count with no error surfaced.

**Mechanism.** A 300-item checklist means **300 sequential updates** — roughly
18–36 seconds with the tab frozen and no progress indicator. Per-row errors are
swallowed, so the announced tallies can silently undercount. Closing the tab
leaves the assessment partially applied.

`runAutoEvidence` additionally appends to `item.evidence` from a snapshot read
*before* the update loop, so two concurrent sweeps duplicate or lose evidence
chips.

**Remediation.** Build the changed rows in memory and write them in one `upsert`
(or a small number of chunked upserts). Report per-row failures rather than
swallowing them. Re-read evidence inside the loop, or compute the append
server-side.

**Done when.**
- Applying a 300-item assessment is one round trip, or a small handful.
- Failures are reported, not swallowed.
- Two concurrent sweeps cannot lose evidence.

**Partial (2026-09-29, projects Round G).** `writeItemPatches` (`lib/checklists.ts`) writes both the assessment's and the sweep's patches as n checked single-row UPDATE requests, at most `WRITE_BATCH = 50` in flight (`Promise.all` per wave) — a 300-item assessment is still 300 requests, but in six concurrent waves (≈ the wall-clock of six round trips) instead of 300 sequential ones; the `items.find` inside the sweep loop is a `Map`. Every write is a checked write guarded on the row's `updated_at` as read (`.eq("updated_at", …)` or `.is("updated_at", null)`): a row someone else changed between the read and the write matches zero rows and is reported as `refused` ("N items changed while the sweep ran and were left alone — run it again") — two concurrent sweeps cannot lose a chip, and the sweep's evidence append is never applied to a stale row. Per-row failures are no longer swallowed: `failed` / `refused` counts and the first error come back and the card shows them in the error tone; the audit row carries only the ids that landed. Tests: `lib/__tests__/checklists.test.ts` `"writes are guarded on updated_at as read (a concurrent change refuses) and run in parallel batches (PERF-7)"` (120 items, every write carries the guard, one audit row with 120 ids), `"a concurrent change between read and write is a refusal, not a lost chip"`, `"a refused write (RLS zero rows) reports an error…"`.

**Done-when.**
- ✗ NOT done: "one round trip, or a small handful". Applying a 300-item assessment is still 300 requests — n checked single-row updates, ≤ 50 concurrent, each guarded on `updated_at`, so the wall-clock is ≈ ceil(n/50) waves (6 for 300) instead of 300 sequential round trips, and an assessment can still be partly applied if the tab closes between waves. Meeting the item as written needs a single-statement server-side apply (an RPC) that keeps the per-row `updated_at` guard — the follow-on recorded in DEC-52; this record stays OPEN for it. *Review fixes (projects Round G):* the first wording ("a small handful of round trips") and then a ✓ "in wall-clock" re-read the criterion instead of meeting it.
- ✓ Failures are reported, not swallowed.
- ✓ Two concurrent sweeps cannot lose evidence (optimistic guard on `updated_at`).

**Scope / residual.** Remaining for this record: the single-statement server-side apply (an RPC keeping the per-row `updated_at` guard), not added here because it would make both the assessment and the sweep depend on a migration being applied (DEC-30) — recorded in DEC-52 as the follow-on that closes done-when 1. Done-when 2 and 3 hold now.

**Resolution (2026-10-01, projects Round G).** Package projects-joint J12 SERVER REMAINDERS built the follow-on DEC-52 item 10 names. `supabase/migrations/20261157_prj_roundG_server_remainders.sql` §4: `apply_checklist_item_writes(p_checklist, p_writes)` (SECURITY INVOKER — every row is the caller's own write under the same RLS and the `20261091` rails; a NULL `auth.uid()` refused; EXECUTE revoked from PUBLIC and anon) applies up to 2,000 machine writes of ONE checklist in one call (more is refused, 22023) — review fix pass 2: in ONE guarded statement, one sub-transaction for the whole call; only when a rail refuses that statement is the call judged row by row, each row in its own sub-transaction, and only for a call of at most 50 writes (a larger refused call applies nothing and answers `{split: 50}`; the first landing gave EVERY row its own sub-transaction, so a 600-item call held ~600 transaction ids and pushed every other session past PostgreSQL's 64-entry subtransaction cache) — each row guarded on its `updated_at` AS READ (`IS NOT DISTINCT FROM` the expected value — the single-row path's optimistic guard) and on the checklist; it writes only the machine actor's columns (status, applicability, rationale, evidence), stamps `updated_at` and `updated_by` NULL itself, accepts only the two machine names `lib/checklistEngine.ts` uses, and returns `{landed, refused, failed[{id, code, message}]}`. `lib/checklists.ts` `writeItemPatches` sends the assessment's and the sweep's writes through it when they share a checklist (they always do) — in calls of at most `APPLY_CHUNK` (1,000) writes, their outcomes merged (review fix pass: the first landing sent every write in one call, so a checklist past 2,000 items failed every write once the migration was applied); a call answering `split` is re-sent first, in order, in calls of at most `PER_ROW_CHUNK` (50, always smaller than the call that asked — review fix pass 2); a call that answers "not here" (or a one-write call still asking to be split) hands that call and what is left to the single-row writes — maps the outcome (a rail's refusal is a failure with its sentence through `describeWriteError`), and falls back to the guarded single-row writes on 42883 / PGRST202 (before the migration) or an answer without the function's shape; any other database error fails every write and does NOT fall back. Pending migration: `20261157` (DEC-30).
- Commits: `6f89983` (the function), `5ace9cf` (the lib), `8a26824` (review fix pass: the chunks), `ac6941a` (review fix pass 2: one statement first; row by row only for a call of at most 50).
- Tests: `lib/__tests__/checklists.test.ts` "the machine's writes in ONE request (20261157 apply_checklist_item_writes)" (one call carries every write with the `updated_at` it was read at, no single-row UPDATE, the audit names only what landed; a changed row refused and a rail's refusal failed while the rest land; a database error fails all with no fallback, a missing function or a shapeless answer falls back; the sweep goes through the same request; review fix pass: "more writes than one call may carry … go in calls of APPLY_CHUNK, outcomes merged" — 2,300 writes against a stand-in that refuses more than 2,000 land in calls of 1,000 / 1,000 / 300 — and "a later call answering without the function's shape hands only what is left to the single-row writes"; review fix pass 2: "a call whose one statement a rail refuses is re-sent in calls of PER_ROW_CHUNK" — 300 writes, one refused by the rail, go as calls of 300 / 50 ×6, 299 land, the refused one fails, each write sent once after the split — and "a one-write call still answering split is handed … to the single-row writes — never a loop"); `lib/__tests__/prjRoundGJ12Migration.test.ts` "PERF-7 — the machine's writes in one request, the per-row updated_at guard kept" (the guarded statement before the row loop; the cap of `PER_ROW_CHUNK` before the loop and the `split` answer; the per-row guard kept; the machine columns in both paths).
- Scratch: a private PostgreSQL 16 with the real `20261091` checklist rail: one call carrying five writes — two landed, one was refused (its `updated_at` had moved), one failed (a person-decided item, refused by the real rail) and one failed the machine-name check (a write under a person's name); a member without write access had every row refused; a NULL `auth.uid()` → 42501; anon → permission denied. Review fix pass 2, same harness, counting the session's subtransactions with `pg_stat_get_backend_subxact` inside the caller's transaction: 119 machine writes that all landed held ONE sub-transaction (the first landing's per-row path, replayed on the same 119 rows, held 64 and OVERFLOWED); 120 writes with one rail-refused row applied nothing, answered `{"split": 50}` and held none; the 50-write call holding the refused row landed 49, failed the one with the rail's sentence, and held 49 (cached); a malformed `expected_updated_at` failed only its row (22007) and the other two landed; two writes to one item went row by row (the first landed, the second was refused); a malformed id (22P02) and a person's name (23514) failed before anything was written.

**Done-when.**
- ✓ Applying a 300-item assessment is one round trip (with `20261157` applied; before it, ⌈n/50⌉ waves as above); a list past 1,000 writes is ⌈n/1,000⌉ round trips.
- ✓ Failures are reported, not swallowed.
- ✓ Two concurrent sweeps cannot lose evidence (the per-row guard, kept in the function).

**Scope / residual.** None. A call is one statement — all of it lands, or (a rail refused a row) none of it does and it is judged row by row in calls of at most 50, so a refused row never undoes a landed one: the single-row path's semantics, with at most 50 sub-transactions held per call. A refused 1,000-write call costs one wasted statement and 20 calls of 50. `DEC-52` item 10 carries a *Landed* line. A `schemaExpectations` entry for the function is the A&O owner's file (named for the integrator).

---

## PERF-8 · The full timeline loads on every project open, for a tab most users never click

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** projects-joint J12 SERVER REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** performance
- **Locations:**
  - `lib/timeline.ts:411-478` — 5 queries, ~700 KB of jsonb
  - `lib/timeline.ts:441` — `audit_logs.select("*")`, 200 rows with `details` + `metadata`
  - `app/(protected)/projects/[id]/page.tsx:145-150` — called unconditionally in `refresh`
  - `app/(protected)/projects/[id]/page.tsx:246-250` — the whole page blocks on a 5-deep serial chain
  - `app/(protected)/projects/[id]/page.tsx:180` — a 5th round trip to re-read `job_kind`, one column of a row already fetched
  - Duplicates: `lib/timeline.ts:417` vs `lib/projects.ts:419` (`project_activity` ×2); `lib/projectSnapshot.ts:22, 42` vs `page.tsx:141, 180` (`projects` ×3–4, `project_members` ×2)
- **Re-verified:** hardening pass — **SURVIVES**. `getProjectTimeline` runs at project open (`timeline.ts:411-422`) and additionally queries `audit_logs` (`:441`), regardless of whether the Timeline tab is ever selected.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Eager loading confirmed: the timeline is fetched on every project open regardless of tab, and it duplicates work — lib/projects.ts:419-425 listActivity queries the same `project_activity` table for the same project with the same limit in the same Promise.all. The uncapped project_documents fetch at :441 is the sharper problem the title understates. Downgraded to MEDIUM: the effect is wasted latency and duplicated queries on page load, not incorrect or lost data.

**Mechanism.** The timeline sits on the blocking path of every project page load
regardless of which tab is opened, and first paint waits for the whole chain
even though the header needs only the first query.

**Remediation.** Move `getProjectTimeline` behind the Activity tab. Fold the
`job_kind` re-read into the initial project select. Deduplicate the
`project_activity` and `project_members` fetches. Render the header as soon as
the project row lands rather than blocking on everything.

**Done when.**
- Opening the Documents tab does not fetch the timeline.
- The header paints before the tab data arrives.
- No query runs twice in one load.

**Partial (2026-09-30, projects Round G).** Two of three done-whens landed. `app/(protected)/projects/[id]/page.tsx`: `refresh()` no longer fetches the timeline — an effect loads `getProjectTimeline` when the Activity tab is shown (and again after a write marks it stale; a newer request supersedes an older one); `job_kind` comes from the SAME project row (`lib/projects.ts` `getProjectForPage`) instead of a fifth round trip; the duplicate `project_activity` read (`listActivity` beside the timeline) is gone (the Activity badge is the timeline's length); the header paints as soon as the project row lands (members and checkouts load after), and later refreshes update in place instead of blanking the page.
- Commit: `9363ebb`
- Tests: `projectPageRoundG.test.ts` "refresh() does not fetch the timeline or re-read job_kind; the Activity tab's effect does".

**Done-when.**
- Opening the Documents tab does not fetch the timeline — ✓.
- The header paints before the tab data arrives — ✓.
- No query runs twice in one load — **not done**: the coach (`components/projects/ProjectCoach.tsx` → `lib/projectSnapshot.ts`, J7's files) still reads `projects` and `project_members` beside the page's own reads. Removing that needs the page to hand its rows to the coach — a change in J7's component and gather, not in this package's files.

**Scope / residual.** The remaining limb is one prop through `ProjectCoach` and an optional pre-read argument to `gatherProjectSnapshot`. *Second fix pass (2026-09-30):* the lazily loaded timeline read put every cost-document and linked-document id in one `.in()` filter. A project with a few hundred quotes exceeded the gateway's URL limit, and the Activity tab failed as a whole. Every id list is now read 100 ids per request (`SAF-6`).

**Resolution (2026-10-01, projects Round G).** Package projects-joint J12 SERVER REMAINDERS closed done-when 3 as the residual above describes. `lib/projectSnapshot.ts`: `gatherProjectSnapshot(…, { pre })` takes a `SnapshotPreRead` — the project row (`select *`) and the roster the caller already read — and reads neither `projects` nor `project_members` itself (a pre-read row without the 20261013 columns reads as not migrated, exactly what the read would have said). `lib/projects.ts` `getProjectForPage` returns the row it read; `app/(protected)/projects/[id]/page.tsx` keeps it with the roster from the same load (`coachPre`, set as soon as the roster is read — right after `setMembers(m)`) and mounts `ProjectCoach` only once it has them, so the coach's first gather is the one that uses them and runs beside the page's checkout hydration (review fix pass: the first landing set it after that hydration, inside the lines projects-joint J10b holds, so the coach waited for it); the refresh key's bump after the hydration lets the re-keyed gather share the round in flight. `components/projects/ProjectCoach.tsx` passes `preRead` through to the gather. The page edit is local (a state, one line in `refresh` outside J10b's lines, the coach's mount).
- Commits: `87a8436` (the snapshot), `329ba59` (the page, the coach, `getProjectForPage`), `8a26824` (review fix pass: the pre-read set right after the roster).
- Tests: `lib/__tests__/projectSnapshot.test.ts` "gatherProjectSnapshot — the page's pre-read (PERF-8)" (neither table read with a pre-read, and the figures come from it; the control reads both; an unmigrated row reads as not migrated; a shared round is served as it was); `lib/__tests__/prjRoundGJ12.test.ts` "PERF-8 — the coach takes the project row and roster the page already read" (source pins on the page and the coach).

**Done-when.**
- ✓ Opening the Documents tab does not fetch the timeline (above).
- ✓ The header paints before the tab data arrives (above).
- ✓ No query runs twice in one load — the project row and the roster are read once, by the page, and handed to the coach.

**Scope / residual.** Opening the Costs or Quality tab loads that tab's ledger itself, beside the coach's snapshot of the same tables — a second load (the tab's), not a second read in one load; sharing them is a cache, not this record. The pre-read is the page load's: a change made without the page's `refresh()` (none of the page's own actions) would be seen by the coach on the next page refresh.

---

## PERF-9 · A 571 KB chunk containing a zip library ships to everyone who opens any project

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** projects-joint J12 SERVER REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Assigned:** the user — a ruling — by the integrator, 2026-10-07, at the J12 merge (DEC-31; `userHeld` in `audit-reports/fleet-plans/projects-joint.json`). Done-when 2 measures either the route's own JavaScript, in which case the 474,342 bytes recorded below close it, or the whole route including the app-wide shell (~618 KB, loaded on every route). In the second case it needs an owner to slim the shell, and the integrator assigns one after the ruling.
- **Verification:** CONFIRMED (verified against the built output)
- **Blast radius:** performance
- **Locations:**
  - `lib/rfqDocx.ts:17` — `import PizZip from "pizzip"` (static, top level)
  - `components/projects/cost/QuotesPanel.tsx:30` → `components/projects/CostsTab.tsx:27` → `app/(protected)/projects/[id]/page.tsx:25` — the static chain
  - Grep for `next/dynamic|React.lazy|await import(` across the Projects tree → **zero hits**
  - Built output: `.next/static/chunks/046b04fbfdf1b49e.js` — **571 KB**, referenced only by the project detail route's client manifest
- **Re-verified:** hardening pass — **SURVIVES**. `lib/rfqDocx.ts:17` statically imports `pizzip`, and `QuotesPanel.tsx:30` statically imports `downloadStarterRfq` from it — so the zip library is in the project route's bundle for every visitor, not behind a dynamic import.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The import graph makes PizZip unconditionally part of the project-detail page bundle even for users who never open Costs, let alone click Download RFQ — the claim holds on mechanism. Caveat: the cited artifact `.next/static/chunks/046b04fbfdf1b49e.js` does not exist in the tree (there is no `.next` build at all), so the specific 571 KB figure could not be reproduced. MEDIUM is right.

**Mechanism.** No lazy boundary anywhere in the Projects tree, and the page is
itself a client component, so the whole subtree is one client entry. Total
client JavaScript for the route: **17 chunks, 1.22 MB minified.**

PizZip's own minified dist is ~80 KB (~25 KB gzipped) and is dead weight for the
overwhelming majority of sessions that never download a starter RFQ.
`ExecutionView.tsx` (92 KB source), `ScheduleCalendarTileView.tsx` (44 KB),
`TaskDetailPanel.tsx` (45 KB) and `ScheduleImportModal.tsx` (35 KB) are also
statically imported and ship to users who only look at Documents.

`xlsx`, `three`, `fabric`, `docxtemplater` and `jszip` are **not** in this
route's chunks — PizZip is the only heavy library that leaked in.

**Remediation.** One line for the biggest win:
`const { downloadStarterRfq } = await import("@/lib/rfqDocx")` inside the click
handler. Then wrap `ExecutionView`, `ScheduleImportModal` and `TaskDetailPanel`
in `next/dynamic`.

**Done when.**
- PizZip is not in the project route's initial chunks.
- Route JS is under 700 KB.

**Partial (2026-09-29, projects Round G).** `QuotesPanel.tsx` no longer imports `lib/rfqDocx` statically; `makeRfq` does `const { downloadStarterRfq } = await import("@/lib/rfqDocx")` at the click, so PizZip is a separate chunk loaded only when a starter RFQ is downloaded. No bundle-analyzer gate was added (plan default).

**Done-when.**
- PizZip is not in the project route's initial chunks — ✓ by import graph (no static path from the project page to `pizzip` remains: `grep -rn "rfqDocx" components app` shows only the dynamic import).
- Route JS is under 700 KB — **not verified here**: no `next build` was run in this package (the integrator builds); the finding stays open until the built manifest shows it.

**Scope / residual.** The other heavy statics named (ExecutionView, ScheduleImportModal, TaskDetailPanel) are P6a/P6b files — not touched.

**Partial (2026-10-01, projects Round G).** Package projects-joint J12 SERVER REMAINDERS made the heavy statics lazy in the files that import them, and measured the route from a built manifest. Done-when 2 is NOT met as this record measures route JS, so the record stays OPEN (its review: the first landing ticked done-when 2 by reading "route JS" as the route's own chunks only — a narrower measure than the Mechanism's "total client JavaScript for the route: 17 chunks, 1.22 MB" that the done-when was written against).
- `app/(protected)/projects/[id]/page.tsx` (its import block only): `IntakePanel`, `CostsTab`, `QualityTab` and `ScheduleTab` load through `next/dynamic` (ssr off, a spinner while loading; each still renders inside its `TabErrorBoundary`, which also catches a failed chunk load). `components/projects/ScheduleTab.tsx`: `ExecutionView` and `ScheduleImportModal` load on use. `components/projects/ExecutionView.tsx`: `TaskDetailPanel` and `ScheduleCalendarTileView` load on use. (`QuotesPanel` already loads `lib/rfqDocx` at the click — above.)
- **Measured.** `next build` with placeholder env (`NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`; a temporary `turbopack.root` because this worktree's `node_modules` is a symlink outside it — reverted, not committed), then `.next/server/app/(protected)/projects/[id]/page_client-reference-manifest.js` `entryJSFiles`. **Total client JavaScript of the route — the measure the Mechanism and done-when 2 use:** 1,659,239 bytes before (a build of `2af813b`) → **1,092,416 bytes after** — still above 700 KB. Of that, the app-wide shell every route loads (the root and `(protected)` layouts, the error and loading boundaries, `rootMainFiles`) is ~618 KB; the route's OWN chunks fell 1,051,421 → 474,342 bytes (gzip 291,772 → 144,895; largest chunk 603,888 → 99,707) — recorded as progress, not as the done-when. Neither `PizZip` nor the bid tab's code is in any initial chunk of the route (searched in the built chunks).
- Commit: `329ba59`.
- Tests: `lib/__tests__/prjRoundGJ12.test.ts` "PERF-9 — the project page loads its heavy tabs when they are opened" (the four page tabs are `next/dynamic`, never static; the board, import modal, task panel and calendar are lazy where they are imported; a census: no file under `app/` or `components/` statically imports one of the eight lazy components — a type import is fine).

**Done-when.**
- ✓ PizZip is not in the project route's initial chunks (by import graph above; now also by the built chunks).
- ✗ Route JS is under 700 KB — **not met**: 1,092,416 bytes of client JavaScript for `/projects/[id]` (from 1,659,239). The Projects tree's own share is now 474,342 bytes; the remaining ~618 KB is the app-wide shell.

**Scope / residual.** What is left is the app-wide shell (~618 KB, loaded on every route: the root and `(protected)` layouts and what they import). Slimming it is outside the Projects tree and no package owns it — owner: none yet. Or the owner rules that done-when 2 measures the route's own JavaScript, in which case the 474,342 bytes above close it; until one of the two, the record stays OPEN. Opening a heavy tab now fetches its chunk on first open (a spinner shows).

---

## PERF-10 · Money formatting constructs a new formatter on every call

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** projects-joint J10b UI REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Blast radius:** performance
- **Locations:**
  - `lib/costs.ts:352-360` — `fmtMoney`, a fresh `Intl.NumberFormat` per call, no cache
  - `lib/costSeries.ts:36-44` — `cumulativeAt`, O(points × entries) with `Date.parse` inside
  - `lib/costSeries.ts:69-70` — two `.sort()` calls on every rebuild
  - Per-render `new Date(...).toLocaleString()`: `TimelineFeed.tsx:201-206` (×200), `projects/[id]/page.tsx:1012`, `CostsTab.tsx:377`, `QualityTab.tsx:589, 690`, `ChartKit.tsx:56-57` (×40)
  - The right pattern, already in the codebase: `QualityTab.tsx:639` — `const [now] = useState(() => Date.now())` with the comment "Captured once at mount — render stays pure."
- **Re-verified:** hardening pass — **SURVIVES**. `new Intl.NumberFormat(…)` is constructed **inside** `fmtMoney` on every invocation (`costs.ts:352-356`), and the function is called once per rendered figure.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Only one of the four cited locations supports the title. lib/costSeries.ts:37-44 is `cumulativeAt` and 67-68 are the two `.sort()` calls — neither constructs a formatter (they are a different, unstated O(points x entries) concern), and app/(protected)/projects/[id]/page.tsx:1012 is `formatRelative`, which does pure arithmetic; the nearest formatter is `formatDate` at line 1010. With only a genuine micro-allocation left, on render volumes of tens-to-hundreds of cells, MEDIUM overstates it; LOW.

**Mechanism.** A Costs tab with 60 accounts and an open account detail
constructs roughly **370–570 formatters per render** — ten to twenty-five
milliseconds of pure construction on every state change, and `openAccount`,
`busy` and `err` all re-render the whole tab.

The S-curve builder is separately quadratic: 40 points × ~450 entries × 2 ≈
**36,000 `Date.parse` calls (~20–40 ms)**, recomputed after every one of the
twenty-query refreshes above.

**Remediation.** Cache formatters in a module-level `Map` keyed by currency.
Pre-parse entry dates once into epoch numbers before the sampling loop, and sort
once. Hoist the `toLocaleString` formatters out of the row components.

**Done when.**
- `fmtMoney` reuses formatters.
- `buildCostSeries` parses each entry date once.
- List rows do not construct a formatter per render.

**Partial (2026-09-29, projects Round G — `fmtMoney` and the list rows; the `costSeries` parse-once is P5/J5's limb).** Joint J3 MONEY-LEDGER. `lib/costs.ts` `fmtMoney` reuses one `Intl.NumberFormat` per (currency, precision) from a module-level `Map` (`moneyFormatter`). `components/projects/CostsTab.tsx` hoists one `Intl.DateTimeFormat` (`entryDateFmt`) for the entry rows in place of `new Date(…).toLocaleDateString()` per row per render.
- Tests: `lib/__tests__/costs.test.ts` "reuses one formatter per currency and precision" (counts constructions through a stand-in `Intl.NumberFormat`).

**Done-when.**
1. ✓ `fmtMoney` reuses formatters.
2. ✗ NOT DONE HERE — `buildCostSeries` parse-once (`lib/costSeries.ts` `cumulativeAt` / the two sorts) is J5 CHARTS' limb.
3. ✓ for the Costs tab's entry rows; `TimelineFeed` / `QualityTab` / `ChartKit` rows are other packages' files.

**Scope / residual.** OPEN until J5 lands the series parse-once.

**Partial (2026-09-30, projects Round G — the `costSeries` limb and the chart kit's per-point formatter).** Joint J5 CHARTS. `lib/costSeries.ts` `buildCostSeries` parses each entry date once (`parsedSorted`), sorts once, and walks the sorted arrays with a cursor. `cumulativeAt` re-parsed every entry at every sample and is gone, as is the second pass for the entries' extremes. The totals are the same sums in the same order. `components/ui/ChartKit.tsx` formats every S-curve date label and tooltip through one lazily created `Intl.DateTimeFormat` (`fmtDay`) instead of `toLocaleDateString` per point (the finding's `ChartKit.tsx:56-57` ×40).
- Tests: `lib/__tests__/projectControls.test.ts` "PERF-10: buildCostSeries parses each entry date once, not once per sample". 500 entries at 40 samples call `Date.parse` at most 502 times; the base made about 36,000 calls, and the test failed there. "PERF-10: the cursor walk returns the same cumulative totals as a full re-scan, at every sample" covers unsorted input, an unparseable date and duplicate dates. It rebuilds each sample's time exactly and asserts equality with a re-scan at every sample, interior ones included, so a cursor that stalls, or catches up only on the last sample, fails. The review fix pass tightened it: the first version checked only ≤ at interior samples.

**Done-when.**
1. ✓ `fmtMoney` reuses formatters (J3).
2. ✓ `buildCostSeries` parses each entry date once.
3. Partly. ✓ for the Costs tab's entry rows (J3) and the S-curve's per-point labels (here). ✗ for `TimelineFeed.tsx` and `QualityTab.tsx`, which are other packages' files.

**Scope / residual.** OPEN only for the `TimelineFeed` / `QualityTab` per-row formatters.

**Resolution (2026-10-01, projects Round G).** Package J10b UI REMAINDERS hoisted the two per-row formatters that were left.
- `components/documents/TimelineFeed.tsx` `formatTime` uses one module-level `Intl.DateTimeFormat` for every row. Its fields are year / month / day / hour / minute / second, numeric, which are `toLocaleString()`'s default fields. It is created on first use. An unreadable timestamp still reads "—".
- `components/projects/QualityTab.tsx` `fmtDay` uses one lazily created `Intl.DateTimeFormat` (year / month / day, numeric: `toLocaleDateString()`'s defaults). It replaces six per-row `toLocaleDateString()` calls: the signed-off checklist, the machine-verified item, turnover reviewed, turnover history, punch due and punch closed. An invalid date falls back to `toLocaleDateString()`, so it reads as before.
- Tests: `lib/__tests__/j10bLabelsFormattersLinks.test.ts`:
  - "200 rows rendered twice construct ONE date-time formatter, and each row reads exactly as toLocaleString() did"
  - "an unreadable timestamp still reads '—'"
  - "a signed-off checklist, reviewed turnover, its history and dated / closed punch items render through one day formatter, reading as toLocaleDateString()"

  They count `Intl.DateTimeFormat` constructions and spy on `Date.prototype.toLocaleString` / `toLocaleDateString` to show there is no per-row call. They fail on the base code.

**Done-when.**
1. ✓ `fmtMoney` reuses formatters (J3, 2026-09-29).
2. ✓ `buildCostSeries` parses each entry date once (J5, 2026-09-30).
3. ✓ for the finding's locations. The rows it named no longer construct a formatter per render: the Costs tab's entry rows (J3), the S-curve's points (J5), and now the timeline feed and the Quality tab's rows. The finding's `projects/[id]/page.tsx:1012` site is `formatRelative`, which the independent pass showed is arithmetic. Its `toLocaleDateString()` fallback runs only for a checkout older than seven days, on a short list, and it is not changed. *Review correction:* this ✓ does not cover every list row in the tree. Short lists outside the finding's locations still call the default-locale `toLocaleDateString()` per row, including in files this package edited for other findings: `IntakePanel.tsx:542, :582`, `cost/ChangeOrdersPanel.tsx:264`, `cost/QuotesPanel.tsx:1585` and `companies/[id]/page.tsx:461`. V8 caches the default-locale formatter behind that call, so none of them is the measured hot path this finding is about. They are left unchanged (DEC-31).

**Scope / residual.** None in the finding's locations. The short-list `toLocaleDateString()` calls named in done-when 3 are not part of this finding.

---

## PERF-11 · Four join columns and two search columns have no index

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED (from the migration set)
- **Blast radius:** performance
- **Locations:**
  - `change_orders`, `turnover_items`, `punch_items` — indexed on `(project_id, status)`, queried by `party_id`
  - `cost_documents` — indexed on `(project_id)` and `(intake_link_id)`, queried by `party_id`
  - `milestones.responsible_party` and `project_intake_links.company_name` — queried with leading wildcards, no trigram index despite `pg_trgm` being installed (`20260724_ticket_numbering.sql:61` is the only trigram index in the schema)
  - `documents.title` / `name` / `document_number` — the type-ahead searches at `QualityTab.tsx:158-172` and `ProjectDocumentsCard.tsx:85-100`
- **Related:** `PERF-1`
- **Re-verified:** hardening pass — **SURVIVES**, by absence in the migration set — the named join and search columns carry no index, so every filter is a sequential scan.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The count is exact — four party_id joins and two ILIKE columns, all unindexed — and these are precisely the queries PERF-1 fans out. MEDIUM is right: the tables are small today, so this is latent rather than acute.

**Mechanism.** ~600 sequential scans plus 150 scans of a 48,000-row table on
every `/companies` visit, and one leading-wildcard scan per 250 ms of typing in
each document search.

**Remediation.** Add `party_id` indexes on the four tables, and trigram indexes
on the two `ilike` columns plus the document search columns. Note these indexes
only matter once `MON-7` makes `party_id` non-null — but they should land before
that, not after.

**Done when.**
- The company-profile gather uses index scans.
- Document type-ahead does not degrade with library size.

**Resolution (2026-09-29, projects Round G).** Migration `20261095_prj_roundG_registry_indexes.sql`: partial btree indexes on `party_id` for `change_orders`, `turnover_items`, `punch_items`, `cost_documents` and `cost_entries` (the batched gather now reads posted commitments by party too); `pg_trgm` GIN on `milestones.responsible_party`, `project_intake_links.company_name`, `documents.title` / `name` / `document_number`, and `companies.name` / `companies.trade` (the registry's server-side search); a guarded `companies_status_check` for a table that predates 20261013's inline CHECK. Verification probes for every index in the final SELECT. Shape pinned by `lib/__tests__/prjRoundGMigrations.test.ts`.

**Done-when.**
- The company-profile gather uses index scans — ✓ once 20261095 is applied (the gather's filters are exactly `party_id IN (…)` / `company_id IN (…)` / `project_id IN (…)`, all now indexed). **Pending migration:** `20261095_prj_roundG_registry_indexes.sql` (DEC-30).
- Document type-ahead does not degrade with library size — ✓ once applied (trigram GIN on the three `ilike` columns). Pending the same migration.

**Scope / residual.** Fix pass: the batched gather filters `milestones.responsible_party` in the database again (ILIKE on this trigram index, per bounded name slice), so the index serves the gather as well as the other readers of that column. Locking: `documents` (the core document table) and `milestones` are COUNTED before the transaction (DEC-30 inventory rows in the result) and their trigram indexes are built in it only at or below 50,000 rows; above that the build is skipped with a notice, their probes read false, and the file's foot carries the four `CREATE INDEX CONCURRENTLY` statements to paste one per run (they never block writes). Verified on a local PostgreSQL 16 both ways (small tables: every probe true; 50,011 documents: the three documents probes false, the concurrent build then succeeds). It lands before P11's MON-7 as the plan requires. Second fix pass (review of 2026-09-30): the operator path above 50,000 rows works as written — the file's instruction to "re-run the verification SELECT" failed in a fresh session (it reads the temp inventory table); the foot now carries a stand-alone probe SELECT (no temp table; it also checks that no interrupted CONCURRENTLY build left an invalid index), and the temp table is dropped before it is created, so a same-session re-run of the file no longer errors (both verified on PostgreSQL 16).

---

## Query limits — inconsistent across four readers of the same table

Worth fixing as one piece of work rather than four findings.

| reader | limit | order |
|---|---|---|
| `lib/milestones.ts:598` (Schedule tab) | **none** | `planned_at` |
| `components/projects/CostsTab.tsx:66-67` | **none** | `planned_at` |
| `lib/projectSnapshot.ts:31-32` (health/coach) | 1000 | **none** ← non-deterministic subset above 1,000 rows |
| `lib/projectReport.ts:43` | 500 | `planned_at` |
| `lib/evidencePack.ts:150` | 2000 | `planned_at` |

Past ~500 tasks — which `ScheduleFilterBar`'s own header comment calls typical
("*A real turnaround is 500+ tasks*") — the health score, the PDF report and the
Schedule tab read **different subsets of the same schedule**.
`projectSnapshot`'s unordered `limit(1000)` is the worst: **the health score
would change between reloads**.

Other unbounded or oversized reads: `lib/projects.ts:199-207` (`listProjects`,
run **twice** on `/projects`, ~0.5–1.2 MB), `lib/projects.ts:322-329`
(`listProjectCheckouts`, unbounded **and** never time-filtered, so it grows
forever with project age), `lib/companies.ts:82-86` (`listCompanies`, pulled on
the Costs tab just to name-match bidders), `lib/checklists.ts:285` (every org
asset tag, `limit(1000)`, read by no rule — see `REL-9`).

**Remediation.** Pick one limit and one ordering per table and apply it
everywhere; add an explicit `order` to the snapshot query at minimum. Time-bound
`listProjectCheckouts`. Give `listProjects` a column list and a limit.

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| PERF-1 | CRITICAL | OPEN |
| PERF-2 | CRITICAL | RESOLVED |
| PERF-3 | HIGH | OPEN |
| PERF-4 | HIGH | OPEN |
| PERF-5 | HIGH | OPEN |
| PERF-6 | HIGH | OPEN |
| PERF-7 | HIGH | RESOLVED |
| PERF-8 | HIGH | RESOLVED |
| PERF-9 | MEDIUM | OPEN |
| PERF-10 | LOW | OPEN |
| PERF-11 | MEDIUM | RESOLVED |
