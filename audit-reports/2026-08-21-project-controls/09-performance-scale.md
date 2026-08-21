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

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (query counts exact; timing estimated)
- **Blast radius:** performance / availability
- **Locations:**
  - `app/(protected)/companies/page.tsx:46-72` — the sweep, 4 workers, no `cancelled` flag, no `AbortController`
  - `lib/companies.ts:82-87` — `listCompanies`, `select("*")` with **no limit**
  - `lib/companies.ts:233-323` — `gatherCompanyProfile`, 9 queries in 3 waves
  - `app/(protected)/companies/page.tsx:74-79` — the kind and text filters, client-side only
  - `app/(protected)/companies/[id]/page.tsx:54-71` — runs the gather a **second** time for the clicked company

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

---

## PERF-2 · Exporting all projects is 360 sequential round trips behind a button that gives no feedback

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (round-trip count exact; timing estimated)
- **Blast radius:** availability / ux
- **Locations:**
  - `lib/projectExport.ts:114-129` — `exportAllProjectsToCsv`, serial `for` loop
  - `lib/projectExport.ts:34-61` — `loadProjectBundle`, itself 3 serial waves
  - `lib/projectExport.ts:40-42` — unbounded `checkout_sessions` and `project_documents` per project
  - `app/(protected)/projects/page.tsx:103-114` — the button, no busy state, not disabled while running

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

---

## PERF-3 · The coach re-gathers on every Costs and Quality mount, throwing away thirteen queries every time

- **Severity:** HIGH
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

---

## PERF-4 · An unbounded query loop is held back only by an eslint-disable comment

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (latent — does not fire today)
- **Blast radius:** availability
- **Locations:**
  - `components/projects/CostsTab.tsx:84` — `// eslint-disable-next-line react-hooks/exhaustive-deps`
  - `components/projects/QualityTab.tsx:73` — the same
  - `app/(protected)/projects/[id]/page.tsx:494` — `onDataChanged={() => setCoachKey(k => k + 1)}`, an inline arrow
- **Related:** `PERF-3` (same root)

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

---

## PERF-5 · The execution board renders eight hundred components into a viewport showing fifteen

- **Severity:** HIGH
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

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (arithmetic); SUSPECTED (hosting plan cap)
- **Blast radius:** availability / cost
- **Locations:**
  - `lib/knowledgePageRender.ts:25-56` — whole-PDF download into one array, then a **serial** render loop at 1400px
  - `app/api/projects/cost-docs/route.ts:24` — `maxDuration = 120`, `timeoutMs: 90_000`
  - `app/api/projects/checklist/route.ts:32`, `app/api/companies/quality-manual/route.ts:27` — same shape
  - `lib/ai/providerCall.ts:128-129` — retries share one 90s `AbortSignal`, which is correct
  - Client call sites with no timeout and no abort: `QuotesPanel.tsx:61-70`, `QualityTab.tsx:178-189`, `QualityTab.tsx:296-305`

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

---

## PERF-7 · Applying an AI assessment issues one update per item, sequentially

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability / data-integrity
- **Locations:**
  - `lib/checklists.ts:150-176` — `applyAssessment`, N+1 updates, per-row errors swallowed with a bare `continue`
  - `lib/checklists.ts:298-322` — `runAutoEvidence`, same shape plus a snapshot-based array append
- **Related:** `SAF-2`

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

- **Severity:** HIGH
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

---

## PERF-10 · Money formatting constructs a new formatter on every call

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** performance
- **Locations:**
  - `lib/costs.ts:352-360` — `fmtMoney`, a fresh `Intl.NumberFormat` per call, no cache
  - `lib/costSeries.ts:36-44` — `cumulativeAt`, O(points × entries) with `Date.parse` inside
  - `lib/costSeries.ts:69-70` — two `.sort()` calls on every rebuild
  - Per-render `new Date(...).toLocaleString()`: `TimelineFeed.tsx:201-206` (×200), `projects/[id]/page.tsx:1012`, `CostsTab.tsx:377`, `QualityTab.tsx:589, 690`, `ChartKit.tsx:56-57` (×40)
  - The right pattern, already in the codebase: `QualityTab.tsx:639` — `const [now] = useState(() => Date.now())` with the comment "Captured once at mount — render stays pure."

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
- **Status:** OPEN
- **Verification:** CONFIRMED (from the migration set)
- **Blast radius:** performance
- **Locations:**
  - `change_orders`, `turnover_items`, `punch_items` — indexed on `(project_id, status)`, queried by `party_id`
  - `cost_documents` — indexed on `(project_id)` and `(intake_link_id)`, queried by `party_id`
  - `milestones.responsible_party` and `project_intake_links.company_name` — queried with leading wildcards, no trigram index despite `pg_trgm` being installed (`20260724_ticket_numbering.sql:61` is the only trigram index in the schema)
  - `documents.title` / `name` / `document_number` — the type-ahead searches at `QualityTab.tsx:158-172` and `ProjectDocumentsCard.tsx:85-100`
- **Related:** `PERF-1`

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
| PERF-2 | CRITICAL | OPEN |
| PERF-3 | HIGH | OPEN |
| PERF-4 | HIGH | OPEN |
| PERF-5 | HIGH | OPEN |
| PERF-6 | HIGH | OPEN |
| PERF-7 | HIGH | OPEN |
| PERF-8 | HIGH | OPEN |
| PERF-9 | MEDIUM | OPEN |
| PERF-10 | MEDIUM | OPEN |
| PERF-11 | MEDIUM | OPEN |
