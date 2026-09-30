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

**Resolution (2026-09-30, projects Round G).** Reproduced: `exportAllProjectsToCsv` awaited `loadProjectBundle` per project (three serial waves each), the button had no busy state. `lib/projectExport.ts` now reads in bulk per batch of `EXPORT_PROJECT_BATCH` = 100 projects (the decided default, `DEC-44`): one `checkout_sessions` read and one `project_documents` read (in parallel), then the referenced documents in chunks of 200, grouped in memory; progress is reported per batch; an `AbortSignal` stops it between batches (`ExportCancelledError`, nothing downloaded); a refused read fails the export instead of shipping an empty section. The Export All button (`app/(protected)/projects/page.tsx`) is disabled while a run is in flight (a second click is a no-op), shows "Exporting n/N…" and offers Cancel. Cells go through `lib/csvSafe` (`PM-10`).
- Commit: `f4c65a9`
- Tests: `lib/__tests__/projectExport.test.ts` "3 projects and 99 projects cost the same number of reads; 150 costs one more batch", "progress is reported and a cancel stops the export", "a refused read fails the export", "the Export All button cannot start a second run and shows progress with a cancel".

**Done-when.**
- The export cannot be started twice concurrently — ✓.
- Progress is visible — ✓.
- The round-trip count is independent of the project count — ✓ within a batch of 100 (1 + 3 reads per batch — 7 for 150 projects, against 450 before).

**Scope / residual.** The CSV is still built in memory (streaming is the remediation's "very large orgs" note; not needed at the counts this area measured).

---

## PERF-3 · The coach re-gathers on every Costs and Quality mount, throwing away thirteen queries every time

- **Severity:** MEDIUM
- **Status:** OPEN
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

**Scope / residual.** The rest of the first done-when is `PERF-4`'s (P2 / P3). Once `onDataChanged?.()` is called only from mutation handlers, those handlers call `invalidateProjectSnapshot`, and `SNAPSHOT_REUSE_MS` can be 0. The J8 suggestion recorded on 2026-09-29, passing `{ fresh: true }` at `page.tsx:196`, is withdrawn: the default is now unshared. `listAccounts` / `listEntries` (`lib/costs.ts`, P3's) do not take a signal and are not aborted.

*Read failures.* The coach names every read the gather could not make (`readFailures`, an amber `role="status"` line) and every table or field the database has not been migrated for (`notMigrated`, a muted line). Since 2026-09-30 the engine acts on both. `computeProjectHealth` scores null every part that depends on a named read, with the detail "Could not read <label>" or "Needs migration 20261013 (…)", and excludes it from the composite: Cost ← cost accounts, cost entries, and milestones once an account is pinned; Schedule ← milestones; Change control ← cost accounts, change orders; Quality ← checklists, checklist items, turnover, punch. `buildCoachItems` drops every suggestion that an absence would raise from a zero it did not read: budget, schedule, pin-ev, baseline, sow, purpose, checklist, parties, links, members. The map is `SNAPSHOT_READS` in `lib/projectHealth.ts`. The banner therefore says "…are left out, not counted as empty" and that is now true. The 2026-09-29 banner said the score treated failed reads as unknown while the engine never read `readFailures`. Tests: `projectSnapshot.test.ts` "a refused checklist_items read scores Quality unknown — never 'Checklists clear' at 100" and "a refused read drops the part and every suggestion its zero would raise"; `projectControls.test.ts` "a read the snapshot could not make is left out of the score…" and "a suggestion raised by an absence is dropped…".

One gap is not closed here. `listAccounts` / `listEntries` still return `[]` on a refused read (`lib/costs.ts:159-161, 204-208`; projects-tab `REL-2` / `UX-10`, P3's), so a refused cost read reaches the gather as an empty ledger. Until REL-2 makes them throw, "Add a budget" can still show for a refused `cost_accounts` read. The engine side is in place and tested with the failure injected; the gather names the failure as soon as the list functions surface it.

---

## PERF-4 · An unbounded query loop is held back only by an eslint-disable comment

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## PERF-5 · The execution board renders eight hundred components into a viewport showing fifteen

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## PERF-6 · PDF rendering plus inference can exceed the function's own time limit, and the user gets "HTTP 504"

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## PERF-7 · Applying an AI assessment issues one update per item, sequentially

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## PERF-8 · The full timeline loads on every project open, for a tab most users never click

- **Severity:** MEDIUM
- **Status:** OPEN
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

**Scope / residual.** The remaining limb is one prop through `ProjectCoach` and an optional pre-read argument to `gatherProjectSnapshot`.

---

## PERF-9 · A 571 KB chunk containing a zip library ships to everyone who opens any project

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

## PERF-10 · Money formatting constructs a new formatter on every call

- **Severity:** LOW
- **Status:** OPEN
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
| PERF-7 | HIGH | OPEN |
| PERF-8 | HIGH | OPEN |
| PERF-9 | MEDIUM | OPEN |
| PERF-10 | MEDIUM | OPEN |
| PERF-11 | MEDIUM | RESOLVED |
