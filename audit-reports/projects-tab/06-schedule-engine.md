# 06 · Schedule engine

Import, dependencies, date arithmetic and baselines — the layer everything else
computes from. A wrong date here becomes a wrong earned value, a wrong forecast,
and a wrong health score.

**18 findings** — 7 CRITICAL, 7 HIGH, 4 MEDIUM.

> Figures marked **measured** are program output: the date and reflow logic was
> executed under Node across UTC, America/Los_Angeles, Asia/Tokyo and
> Pacific/Auckland, at both DST boundaries. Line numbers drift — **match on the
> quoted code.** See [`../README.md`](../README.md) for the protocol.

---

## SCH-1 · Day/month dates are silently rewritten as month/day, and the comment claims a guard the code lacks

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** data-integrity
- **Locations:** `lib/scheduleParsers.ts:918-925` — `coerceIso`
- **Re-verified:** hardening pass — **SURVIVES** — the strongest of the schedule findings. The docblock at `scheduleParsers.ts:910` promises *"we treat as M/D/Y **if first part ≤ 12**"*; the code at `:923` is `const month = a; const day = b;` with no such test. `15/08/2026` yields `2026-15-08T00:00:00Z`, which is not a date at all — the value is destroyed rather than merely swapped.

**Mechanism.** The comment above the function reads:

```
//   15/08/2026 (ambiguous — we treat as M/D/Y if first part ≤ 12)
```

The code has no such test:

```ts
const a = Number(m2[1]); const b = Number(m2[2]);
const month = a; const day = b; // M/D first
```

**Measured:**

| Input | Result |
|---|---|
| `05/08/2026` (5 Aug, EU) | `2026-05-08T00:00:00Z` → **8 May**, silent corruption |
| `15/08/2026` | `2026-15-08T00:00:00Z` → month 15, rejected by Postgres |
| `31/12/2026` | `2026-31-12T00:00:00Z` → rejected |

**Failure scenario.** A planner outside the United States imports a P6 XER or an
MS Project CSV with `dd/mm/yyyy` dates. Rows dated 1–12 of the month land on a
wrong but entirely plausible date. Rows dated 13–31 fail with a raw Postgres
error. The modal reports "Inserted: 140 / 12 errors" and there is no way to
discover that the 140 are wrong.

**Remediation.** Ambiguity cannot be resolved from one row — resolve it from the
file. Scan all date values first: if any has a first part > 12, the file is
D/M/Y and every row must be parsed that way. If none does, the file is genuinely
ambiguous — ask the user in the import modal (a single radio, defaulted from
their locale) and apply the answer to the whole file. Never guess per row.

**Done when.**
- A file containing `15/08/2026` parses every row as D/M/Y.
- A genuinely ambiguous file prompts the user once.
- The chosen interpretation is shown in the import result.
- A test covers a D/M/Y file whose values are all ≤ 12.

---

## SCH-2 · Re-importing the weekly schedule wipes progress the crew logged in the app

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `lib/milestones.ts:958-969` — `baseFields` includes `status`, `percent_complete`, `actual_at`, `actual_start_at`
  - `lib/milestones.ts:1005-1019` — `update({...baseFields, ...})` on the matched `external_ref`
  - `components/projects/ScheduleImportModal.tsx` — the tip strip, which is the only warning
- **Re-verified:** hardening pass — **SURVIVES**. `baseFields` writes `status`, `percent_complete`, `actual_at` and `actual_start_at` unconditionally from the imported file (`milestones.ts:962-967`), so a re-import overwrites progress the crew logged in the app.

**Mechanism.** The upsert's field set is derived purely from the file and
applied to every row matched by external reference.

**Failure scenario.** The crew marks forty tasks 60–100% complete over a shift.
The scheduler re-imports the weekly refresh from P6, where those tasks still
read zero. All forty reset to `percent_complete = 0`, `status = 'planned'`,
`actual_at = null`. Earned value, CPI, SPI, the S-curve and the health score all
snap backwards. The only warning is "Re-importing the same file upserts rows
with stable IDs." No diff, no confirmation, no undo.

**Remediation.** Separate *plan* fields from *actuals*. On re-import, update
planned dates, names, structure and dependencies; **never** overwrite
`percent_complete`, `status`, `actual_at` or `actual_start_at` on a row that has
local progress, unless the user explicitly opts in. Show a pre-import diff
("40 rows have local progress that this file would reset") with a per-row or
all-or-nothing choice.

**Done when.**
- A re-import preserves locally-recorded progress by default.
- The import modal shows what would be overwritten before it writes.
- A test asserts a progressed row survives a zero-progress re-import.

---

## SCH-3 · CSV re-import matches rows by position, so inserting one row scrambles every row after it

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:** `lib/scheduleParsers.ts:710` — `externalRef: id ? \`${refTag}:${id}\` : \`${refTag}-row:${rowIndex}\``
- **Re-verified:** hardening pass — **SURVIVES**. `externalRef: id ? `${refTag}:${id}` : `${refTag}-row:${rowIndex}`` (`scheduleParsers.ts:710`) — with no id column the identity **is** the row index, so inserting a row re-points every ref after it.

**Mechanism.** Rows without an id column get `csv-row:{index}` as their "stable"
reference — stable only if nobody ever edits the spreadsheet.

**Failure scenario A.** A 200-row punch list imports cleanly. The user adds one
task at the top and re-imports. `csv-row:5` now points at what was row 4 — every
row's name, dates and progress are overwritten with its neighbour's. Reported as
"Updated: 200," zero errors.

**Failure scenario B.** Two *different* CSVs imported into the same project both
claim `csv-row:0…`, so the second overwrites the first instead of adding to it.

**Also affects MS Project CSV** (`refTag: "msp"`), because the `ID` column it
keys on is the outline position, which renumbers on every insert — only
`Unique ID` is stable.

**Remediation.**
1. When no stable id column exists, derive the reference from content (a hash of
   name plus planned dates) rather than position — imperfect, but it fails safe
   by creating a new row rather than overwriting a different one.
2. Namespace the reference by an import-session or file identity so two files
   cannot collide.
3. For MS Project CSV, prefer `Unique ID` and warn when only `ID` is present.
4. Tell the user in the modal which column is being used as the key.

**Done when.**
- Adding a row to a keyless CSV and re-importing does not overwrite unrelated rows.
- Two different CSVs into one project do not collide.
- MS Project CSV prefers `Unique ID`, and warns when it falls back.

---

## SCH-4 · A dependency cycle launches tasks years into the future, and the move is persisted

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (measured against a verbatim port)
- **Blast radius:** data-integrity
- **Locations:**
  - `lib/scheduleReflow.ts:338-365` — `cascadeDependents`, `guard = nodes.length * 4 + 32`
  - `components/projects/ExecutionView.tsx:449-461` — `withCascade`, which merges the cascade into the write
  - `components/projects/MovePreviewSheet.tsx` — fed `pendingMove.ids`, not the computed change set
- **Related:** `SCH-8` (import creates the cycles), `SCH-14` (the guard is bypassable)
- **Re-verified:** hardening pass — **SURVIVES**. The `guard = nodes.length * 4 + 32` bounds the iteration count but not the dates: each pass through a cycle pushes the successor out again. `ExecutionView.tsx:449-461` merges the cascade into the primary change set specifically so *"it persists + undoes as one set"*, so the far-future dates are written.

**Mechanism.** The cascade is "cycle-safe" only in the sense that it
*terminates*. Inside a cycle each pass pushes the successor forward and
re-queues it, so the guard becomes a multiplier on the runaway.

**Measured:**

```
2-node cycle:                    A  2026-06-01 → 2027-01-27   (~240 days)
same cycle in a 200-row project: A  2026-06-01 → 2040-01-31   (~13.7 YEARS, guard = 832)
```

**Failure scenario.** This is not a preview. `withCascade` merges the cascade
into the primary change set, and `commitMove` / `resizeEdge` /
`resizeSummaryEdge` / `sequencePhase` persist the whole set through the
batch-move RPC. The preview sheet is fed the originally-dragged ids, so it says
*"Move 1 task 1 day later"*, the user confirms, and two tasks jump fourteen
years. Undo exists but the toast lives 7 seconds and its snapshot covers only
rows in `all`.

**Remediation.**
1. Detect the cycle rather than absorbing it: if the cascade revisits a node,
   abort the whole operation and tell the user which edges form the loop.
2. Feed `MovePreviewSheet` the **computed change set**, not the dragged ids, so
   the preview cannot understate the blast radius.
3. Bound the cascade by a sane displacement (e.g. refuse a move that shifts any
   task more than the project span) as a backstop.

**Done when.**
- A move that would traverse a cycle is refused with the offending edges named.
- The preview sheet's count matches what will actually be written.
- A test asserts the 2-node cycle produces a refusal, not a 240-day shift.

---

## SCH-5 · Three contradictory overdue rules, one of which marks every task overdue on its own due date

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** correctness
- **Locations:**
  - `components/projects/ScheduleTab.tsx:518`, `lib/executionReport.ts:136`, `lib/scheduleFilter.ts:101`, `lib/projectSnapshot.ts:115-119`, `lib/projectReport.ts:88-91` — `planned < Date.now()`
  - `components/projects/ScheduleProgress.tsx:41, 49-53` — `planned < local midnight`
  - `components/projects/ExecutionView.tsx:949` — `planned < startOfDayUTC(now)`
- **Re-verified:** hardening pass — **SURVIVES**. Two of the three verified directly and they disagree: `ScheduleTab.tsx:518` is `!actual && planned < now && effStatus !== "completed"`, `executionReport.ts:136` is `m.status !== "completed" && finishMs(m) < now` — different inputs, different answers for the same row. `planned` is midnight-anchored, so a task due today reads overdue from 00:00.

**Mechanism.** Planned dates are stored wall-clock-as-UTC
(`2026-08-21T00:00:00Z` means "due 21 Aug"). Overdue is computed three different
ways across six call sites.

**Measured**, now = `2026-08-21T16:00Z` (9am Pacific), task due
`2026-08-21T00:00Z`:

| timezone | `Date.now()` | local-midnight | `startOfDayUTC` |
|---|---|---|---|
| UTC | **overdue** | ok | ok |
| America/Los_Angeles | **overdue** | **overdue** | ok |
| Asia/Tokyo | **overdue** | **overdue** | ok |

**Failure scenario.** The `Date.now()` rule marks a task overdue from 00:01 UTC
on its own due date — for a US user, from five or eight in the evening the day
*before*. Simultaneously visible: `SchedulePulse` says "5 overdue tasks"
directly above `SummaryStrip` saying "Overdue 0", two inches apart, from the
same data. And `projectSnapshot.overdueMilestones` feeds the health penalty, so
the score is docked for tasks that are not late, by an amount that varies with
the viewer's timezone.

**Remediation.** Write one helper — `isOverdue(plannedAt, now)` using
`startOfDayUTC`, which matches the storage convention — put it in
`lib/scheduleProgress.ts` or a shared date module, and route all six call sites
through it. Delete the other two rules.

**Done when.**
- All six call sites use one shared predicate.
- The pulse strip and the summary strip cannot disagree.
- A test pins the due-today case across three timezones.

---

## SCH-6 · Hiding imported rows changes almost every number, and the tooltip says it doesn't

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness
- **Locations:**
  - `components/projects/ScheduleTab.tsx:259` and `:397` — the two claims
  - `components/projects/ScheduleTab.tsx:317` — `visible`, the ghost-filtered list
  - `components/projects/ScheduleTab.tsx:233` — `ScheduleProgress`, the one component fed the full list
- **Related:** `MON-6`
- **Re-verified:** hardening pass — **SURVIVES**, and the tooltip is quotable. `ScheduleTab.tsx:259` reads *"Hide the read-only rows imported from your scheduling tool (they still count in the metrics)"* — while `:317` passes the filtered `visible` set into `ExecutionView`, so they do not.

**Mechanism.** The interface states twice that imported rows "still count in the
metrics" and "still count toward the earned-value rollup." That is true of
`ScheduleProgress` only. `ExecutionView` is fed `visible`, and everything inside
it derives from that:

| Consumer | line | changes when imported rows are hidden |
|---|---|---|
| `SchedulePulse` — overdue / blocked / pace / drift | 702 | yes |
| `SummaryStrip` — %, done/total, overdue, schedule day | 708 | yes |
| `overallPercent(items)` | 951 | yes |
| `computeCriticalPathLite(items)` | 225 | yes |
| `domain` — project span, TODAY line | 275-287 | yes |
| `buildProgressIndex` — all rollups | 249, 178 | yes |
| Calendar, Report, Dependency arrows | 764-780, 842 | yes |

**It also changes what you can write.** Removing imported children promotes
their manual parent to a *leaf* in `rows`/`planningRows`. `OutlineRow`
(`:1084`) and `MilestoneRow` (`:512`) then switch from the derived rollup to the
row's own stored status, and render the **Done button and status menu on a
summary row**. A user can mark a phase complete while its hidden work is open.

**Remediation.** Decide what the filter means and enforce it. Cleanest: make the
toggle purely a *display* filter — pass the full list to every calculation and
only filter at render. If some metrics genuinely should exclude imported rows,
say which, in the tooltip, and make the two agree. Separately, derive leaf-ness
from the unfiltered list so a summary can never present as a leaf.

**Done when.**
- Toggling imported rows does not change any displayed metric, or the tooltip states exactly which it changes.
- A parent with hidden children never renders a Done button.
- A test asserts leaf-ness is computed from the unfiltered set.

---

## SCH-7 · The batch-move RPC has no optimistic lock, and the live-sync meant to cover it was never switched on

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** (a) CONFIRMED. (b) CONFIRMED from the migration set — verify against the live publication before treating as final.
- **Blast radius:** data-integrity
- **Locations:**
  - `supabase/migrations/20260907_milestone_batch_move.sql:50-55` — `WHERE id = … AND org_id = … AND project_id = …`, no `updated_at` guard
  - `lib/milestones.ts:1221` — `rebaseSchedule`'s optimistic lock, for contrast
  - `components/projects/ScheduleTab.tsx:105-120` — the realtime subscription
  - `grep "ALTER PUBLICATION supabase_realtime" supabase/migrations/` → `checkout_messages`, `notifications`, `checkout_episodes` — **not `milestones`**
- **Re-verified:** hardening pass — **SURVIVES**. `20260907_milestone_batch_move.sql:50-55` updates `WHERE id = … AND org_id = p_org` with no `updated_at` predicate. Contrast `rebaseSchedule` (`milestones.ts:1209-1229`), which does hold an optimistic lock — the pattern exists in the same file and was not applied here.

**Mechanism.** Two defects that compound.

**(a)** The update has no `updated_at` guard, unlike `rebaseSchedule` three
hundred lines away in the same library. Two schedulers dragging the same task:
last write wins, silently, with both clients showing their own optimistic
result. (Also: `v_count := v_count + 1` fires per array element regardless of
whether the UPDATE matched, so the returned count is not a count of rows
changed. The client discards it.)

**(b)** `milestones` is not in the realtime publication, so no event ever
arrives — while the code comment claims edits "stream in (debounced) so two
people can work the same schedule without silently overwriting each other's
view."

**Remediation.**
1. Pass each row's expected `updated_at` into the RPC and add it to the `WHERE`.
   Return the ids that did not match, and have the client refresh and tell the
   user which moves were rejected.
2. Fix the row count to reflect actual matches.
3. Either add `milestones` to the realtime publication, or delete the
   subscription and the comment that describes it.

**Done when.**
- A stale move is rejected rather than silently winning.
- The RPC returns a true count of changed rows.
- The realtime claim in the comment matches reality either way.

---

## SCH-8 · Every P6 relationship type is imported as finish-to-start, and lag is discarded

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `lib/scheduleParsers.ts:372-379` — `TASKPRED`, `pred_type` not read
  - `lib/scheduleParsers.ts:508-523` — `<Relationship>`, `Type` not read
- **Related:** `SCH-4`, `SCH-9`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The P6 relationship loop reads only `SuccessorActivityObjectId` and `PredecessorActivityObjectId` (`scheduleParsers.ts:372-379`) — **neither `Type` nor `Lag` is read at all**, so FF/SS/SF collapse to FS and every lag becomes zero.

**Mechanism.** `TASKPRED` carries `pred_type` (`PR_FS` / `PR_SS` / `PR_FF` /
`PR_SF`) and the XML `<Relationship>` carries `Type`. Neither is read. Lag is
discarded too.

**Failure scenario.** A routine start-to-start plus finish-to-finish pair
between two activities — legal and common in real P6 networks — lands as
`A depends_on B` **and** `B depends_on A`: a cycle, which is the input to
`SCH-4`. Beyond that, every reflow computes against the wrong relationship
semantics.

**Remediation.** Either (a) store the relationship type and lag and honour them
in `cascadeDependents`, or (b) if only finish-to-start will be supported, import
**only** FS relationships, skip the others, and report the count skipped in the
import result. (b) is far cheaper and is honest; silently flattening them is
neither.

**Done when.**
- Non-FS relationships are either honoured or explicitly skipped and reported.
- Importing a normal P6 network with SS/FF pairs does not create a cycle.

---

## SCH-9 · The cycle guard is defeated by the imported-rows toggle

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `components/projects/TaskDetailPanel.tsx:691` — `allTasks` derives from `visible`
  - `lib/scheduleReflow.ts:272` — `wouldCreateCycle`, whose only caller this is
  - `components/projects/TaskDetailPanel.tsx:727` — "(removed task)"
- **Related:** `SCH-4`, `SCH-6`
- **Re-verified:** hardening pass — **SURVIVES**. `wouldCreateCycle(reflowNodes, …)` (`TaskDetailPanel.tsx:691`) checks the **visible** node set, so hiding imported rows shrinks the graph the guard reasons over and a cycle through a hidden row passes.

**Mechanism.** The dependency picker's candidate list derives from the
ghost-filtered set. So `reflowNodes` omits hidden rows, a cycle routed through a
hidden row is invisible to `wouldCreateCycle`, and the offending predecessor is
offered in the dropdown. Existing dependencies pointing at hidden rows render as
"(removed task)" — the task is not removed at all.

**Remediation.** Run the cycle check against the **full** milestone set, always,
regardless of display filters. Render dependencies on hidden rows as "hidden by
filter", not "removed".

**Done when.**
- The cycle check sees every milestone regardless of the toggle.
- A dependency on a filtered-out task is labelled correctly.

---

## SCH-10 · Rebase lands the schedule on the wrong day for every negative-offset timezone

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** correctness
- **Locations:**
  - `components/projects/RebaseScheduleModal.tsx:51-57` — prefill from `d.getHours()` (local)
  - `components/projects/RebaseScheduleModal.tsx:76` — `new Date(\`${target}T${targetTime}:00\`).toISOString()` (local parse)
- **Re-verified:** hardening pass — **SURVIVES**. `d.getHours()` / `d.getMinutes()` (`RebaseScheduleModal.tsx:53-54`) read local-clock components from a value parsed out of a UTC ISO anchor.

**Mechanism.** The time is pre-filled from the anchor's *local* hours and the
submit parses the combined string in local time.

**Measured:** anchor `2026-06-01T00:00:00Z`, user in America/Los_Angeles, target
`2026-09-01`:

```
prefill time  = "17:00"   (= May 31 17:00 PDT, the local rendering of Jun 1 00:00Z)
newStartIso   = 2026-09-02T00:00:00.000Z   →  schedule starts 2026-09-02
```

The preview panel shows `9/1/2026, 5:00:00 PM` (local, looks right); the board
renders in UTC and shows **Sep 2**. Deterministic for any UTC-negative timezone
with a midnight-UTC anchor — every US user with a date-only import. Tokyo and
Auckland round-trip correctly, so it will read as "works for some people."

**Remediation.** Treat the target as a wall-clock date in the same convention
the column uses: build the ISO string directly (`${target}T00:00:00Z`) rather
than round-tripping through a local `Date`. If a time-of-day is genuinely needed,
keep it in UTC throughout and render it as UTC in the preview.

**Done when.**
- Rebasing to 1 September produces a schedule starting 1 September, in every timezone.
- The preview and the board show the same date.
- A test covers UTC-8, UTC, and UTC+9.

---

## SCH-11 · Resizing a summary snaps every child to UTC midnight, moving tasks by a day

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** data-integrity
- **Locations:** `lib/scheduleReflow.ts:531, 542` — `snap = (ms) => Math.round(ms / DAY_MS) * DAY_MS`
- **Re-verified:** hardening pass — **SURVIVES**. `const snap = (ms) => Math.round(ms / DAY_MS) * DAY_MS` (`scheduleReflow.ts:531`) rounds to UTC midnight, so a child whose stored instant sits after local midnight moves a day.

**Mechanism.** The snap rounds to the nearest day boundary, so any planned time
at or after noon UTC rounds *forward* onto the next calendar day.

**Measured** — a phase whose tasks sit at MS Project's usual 08:00/17:00,
resized **+1 day**:

```
L1  06-01T08:00Z → 06-02T17:00Z    becomes  06-01T00:00Z → 06-03T00:00Z   (finish +1 day)
L2  06-03T08:00Z → 06-05T17:00Z    becomes  06-04T00:00Z → 06-07T00:00Z   (start +1, finish +2)
```

A "+1 day" phase stretch moved L2's finish **two** days and its start one.

**Remediation.** Preserve each row's time-of-day through the resize — apply the
delta and keep the original clock time — or normalize the whole schedule to
midnight UTC on import and never carry times at all. Do one or the other
consistently; the current half-way state is what produces the drift.

**Done when.**
- A +1 day summary resize moves every child exactly one day.
- A test pins the 08:00/17:00 fixture.

---

## SCH-12 · Setting a duration does local-calendar arithmetic on UTC dates, so a task gains a day across DST

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** correctness
- **Locations:** `lib/milestones.ts:1410` — `const start = new Date(finish); start.setDate(finish.getDate() - (input.days - 1));`
- **Re-verified:** hardening pass — **SURVIVES**. `const start = new Date(finish); start.setDate(finish.getDate() - (input.days - 1))` (`milestones.ts:1410`) — `getDate`/`setDate` are local-calendar operations applied to a value parsed from a UTC instant, so a span crossing a DST boundary lands a day out.

**Mechanism.** `setDate`/`getDate` operate in local time on a value stored as
UTC.

**Measured**, TZ=America/Los_Angeles, days=3:

| finish | produced start | correct start |
|---|---|---|
| `2026-11-02T00:00:00Z` | **`2026-10-30T23:00:00Z`** (UTC day **Oct 30**) | `2026-10-31T00:00:00Z` |
| `2026-03-10T00:00:00Z` | `2026-03-08T01:00:00Z` (day ok) | `2026-03-08T00:00:00Z` |

The fall-back case renders a 3-day task as a **4-day bar** on the UTC timeline,
and `reflowAllAncestors` propagates the extra day into the parent's envelope.
Only wrong across a DST boundary in a negative-offset zone — so it is
intermittent and location-dependent, which makes it easy to dismiss as a fluke.

**Remediation.** Do the arithmetic in UTC: `setUTCDate`/`getUTCDate`, or
subtract `(days - 1) * DAY_MS` from the epoch value directly.

**Done when.**
- A 3-day task ending 2 November starts 31 October, in every timezone.
- A test runs the duration helper at both DST boundaries in a negative-offset zone.

---

## SCH-13 · "Read-only imported rows" are fully editable

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (grep for `source` in the three views returns nothing)
- **Blast radius:** ux / data-integrity
- **Locations:**
  - `components/projects/ExecutionView.tsx`, `TaskDetailPanel.tsx`, `ScheduleCalendarTileView.tsx` — no source handling anywhere
  - `components/projects/ScheduleTab.tsx:607` — delete, available on imported rows
  - The HelpTooltip claiming "Imported rows are read-only milestones"
- **Related:** `SCH-2`
- **Re-verified:** hardening pass — **SURVIVES**. Nothing in `ScheduleTab.tsx` gates its edit controls on the row's `source`, so rows the UI calls "read-only imported" accept edits — which `SCH-2` then overwrites on the next import.

**Mechanism.** Imported rows can be dragged, resized, status-changed, %-set,
edited, re-parented, rebased and **deleted**. The only "read-only" treatment is
`opacity-90` and a source badge.

**Failure scenario.** A user edits an imported row believing it is protected,
and the next re-import silently destroys the edit (`SCH-2`). The tooltip is
flatly false.

**Remediation.** Pick one and make it true: either enforce read-only on imported
rows (blocking edits at the data layer, not just the UI), or drop the claim and
warn at edit time that the change will be overwritten on the next import.
Enforcing is cleaner once `SCH-2` separates plan from actuals — progress stays
editable, plan does not.

**Done when.**
- The tooltip's claim matches the behaviour.
- Whichever rule is chosen is enforced below the UI.

---

## SCH-14 · Import has no size cap, no row cap, and two sequential round trips per row

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability / ux
- **Locations:**
  - `components/projects/ScheduleImportModal.tsx:108-124` — whole-file decode and parse, synchronous, no byte limit
  - `lib/milestones.ts:938-1064` — one SELECT + one INSERT/UPDATE per row, sequentially
  - `lib/milestones.ts:1072-1107` — passes 2 and 3 fire every update at once
- **Re-verified:** hardening pass — **SURVIVES**, all three parts. `handleFile` calls `file.arrayBuffer()` with no size check (`ScheduleImportModal.tsx:113-116`), and `importMilestones` loops row-by-row (`milestones.ts:938-949`) with per-row work inside.

**Mechanism.** The file is decoded and `DOMParser`-parsed synchronously on the
main thread with no size limit. Every row gets a select plus a write,
sequentially: at ~60ms round trip, 1,000 rows ≈ 2 minutes, 5,000 rows ≈ 10
minutes — behind a bare spinner with no cancel and no progress. Then passes two
and three fire thousands of concurrent requests, past every browser connection
limit.

**Remediation.** Cap the file size and the row count with a clear message. Batch
the row writes into chunked upserts (a few hundred per request) instead of
per-row round trips. Show progress and offer cancel. Chunk passes two and three
rather than firing them all at once.

**Done when.**
- A 5,000-row import completes in seconds, not minutes, or is refused with a limit.
- Progress is visible and the operation is cancellable.
- Closing the tab mid-import does not leave a half-written schedule (or the partial state is recoverable).

---

## SCH-15 · The critical path ignores the real dependency edges

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** decision-quality
- **Locations:** `lib/criticalPath.ts` — `computeCriticalPathLite` never reads `dependsOn`
- **Re-verified:** hardening pass — **SURVIVES**, by absence — the critical-path computation does not consult the stored dependency edges.

**Mechanism.** The computation walks backward by date contiguity within a 1-day
slack / 14-day window. It is labelled a heuristic in the source. Now that
genuine finish-to-start links exist and drive `cascadeDependents`, the
highlighted "critical path" and the chain the reschedule engine actually honours
are **different graphs**.

**Remediation.** Either implement real CPM over the stored dependency graph
(forward pass, backward pass, float), or rename the control to what it is —
"Longest date chain" — so it does not claim to be the critical path. The first
is the right answer now that the edges exist.

**Done when.**
- The highlighted path is derived from the dependency graph, or the label no longer says "critical path".

---

## SCH-16 · Re-import can add structure but never remove it

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:** `lib/milestones.ts:1072-1107` — passes 2 and 3
- **Re-verified:** hardening pass — **SURVIVES**. The re-import builds a `parent_id` update list (`milestones.ts:1072-1083`) and has no path that clears an existing parent, so structure accumulates and never retracts.

**Mechanism.** Pass 2 writes `parent_id` only when both sides resolve; pass 3
writes `depends_on` only when `predIds.length > 0`. Un-parenting a task or
deleting a predecessor upstream and re-importing leaves the stale relationship
in place forever.

**Remediation.** For rows present in the file, set the relationship fields to
exactly what the file says — including clearing them when the file says none.
Leave rows absent from the file untouched.

**Done when.**
- Removing a predecessor upstream and re-importing clears it locally.
- Un-parenting upstream clears the local parent.

---

## SCH-17 · Deleting a phase silently orphans its entire subtree

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `lib/milestones.ts:565-584` — `deleteMilestone`
  - `supabase/migrations/20260703_milestones_hierarchy.sql` — `parent_id UUID REFERENCES milestones(id) ON DELETE SET NULL`
- **Re-verified:** hardening pass — **SURVIVES**. `deleteMilestone` reads the one row and deletes it (`milestones.ts:565-570`); no descendant is re-parented and no cascade exists, so the subtree survives pointing at a missing parent.

**Mechanism.** Deleting a summary re-parents all its children to top level. The
confirm says only "Delete this milestone? This action is audited" — no child
count, no warning, no undo, and the WBS structure is not recoverable from the
audit entry. Any `depends_on` entries pointing at it become dangling UUIDs
rendered as "(removed task)".

**Remediation.** Count the descendants and name the number in the confirm. Offer
"delete the phase and its N tasks" versus "delete the phase and promote its
tasks" as an explicit choice. Record the prior `parent_id` values in the audit
details so the structure is recoverable. Clean dangling dependency references on
delete.

**Done when.**
- The confirm states how many descendants are affected and what will happen to them.
- The prior structure is recorded in the audit row.
- No dangling dependency references remain after a delete.

---

## SCH-18 · A failed Undo reports success

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / ux
- **Locations:**
  - `components/projects/useUndoableActions.ts:58-71` — `runUndo`, which only surfaces a throw
  - `components/projects/ScheduleTab.tsx:326-376` — the handlers, which catch internally and `return false`
- **Re-verified:** hardening pass — **SURVIVES**. `runUndo` dismisses the toast **before** awaiting `t.undo()` (`useUndoableActions.ts:58-63`), so a throw inside the undo has no surface left to report on.

**Mechanism.** Every undo closure calls `onMoveMany(before)` or
`onSetStatus(id, prevStatus)`, and both handlers catch internally and return
false — they never throw. So a rejected undo dismisses its toast exactly like a
successful one, and the schedule stays moved. The "Couldn't undo" branch is
unreachable through the normal path.

**Related, minor:** the undo closure snapshots `before` at commit time and the
toast lives 7 seconds. Because nothing refreshes it (`SCH-7b`) and nothing
version-checks it (`SCH-7a`), clicking Undo blindly writes those old dates over
anything a colleague changed in the interim. Also `useUndoableActions.ts:40`
drops the oldest toast via `.slice(-2)` without clearing its timer, so the
timers map grows for the session.

**Remediation.** Have the handlers return a result the undo runner can inspect
(or throw), and surface the failure. Version-check the undo write once `SCH-7a`
lands. Clear the dropped toast's timer.

**Done when.**
- A failed undo shows "Couldn't undo" and leaves the toast, or offers a retry.
- The timers map does not grow unbounded.

---

## Verified sound — do not "fix" these

- **`rebaseSchedule` is the strongest code in this surface.** Actual dates are
  correctly not shifted, and it is the **only** writer with an optimistic lock
  (`lib/milestones.ts:1221`) that reports skipped rows to the user. Its flaw is
  at the modal boundary (`SCH-10`), not in the function.
- **Division by zero is not reachable.** `effectiveWeight` requires `w > 0` and
  falls back to 1, so `wsum` can never be zero for a non-empty leaf set; every
  consumer guards `> 0` anyway.
- **Percent is properly clamped** in `clampPercent`, `setMilestoneProgress`,
  `ProgressControl.clamp` and the importer, and constrained `0..100` in
  migration `20260731`. Values above 100 or below 0 are not reachable.
- **Optimistic-update rollback is handled well.** `setStatus`/`setProgress`
  delete their optimistic entries on failure; `bulkStatusIds` rolls back only
  the failures and reports the count; `onMoveMany` re-fetches on error.
- **`DependencyArrows` dedupes by edge and `resolveVisibleDepIndex` guards with
  a `seen` set**, so a cycle is harmless *on render*. The damage is at the next
  reschedule (`SCH-4`).

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| SCH-1 | CRITICAL | OPEN |
| SCH-2 | CRITICAL | OPEN |
| SCH-3 | CRITICAL | OPEN |
| SCH-4 | CRITICAL | OPEN |
| SCH-5 | CRITICAL | OPEN |
| SCH-6 | CRITICAL | OPEN |
| SCH-7 | CRITICAL | OPEN |
| SCH-8 | HIGH | OPEN |
| SCH-9 | HIGH | OPEN |
| SCH-10 | HIGH | OPEN |
| SCH-11 | HIGH | OPEN |
| SCH-12 | HIGH | OPEN |
| SCH-13 | HIGH | OPEN |
| SCH-14 | HIGH | OPEN |
| SCH-15 | MEDIUM | OPEN |
| SCH-16 | MEDIUM | OPEN |
| SCH-17 | MEDIUM | OPEN |
| SCH-18 | MEDIUM | OPEN |
