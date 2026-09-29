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
- **Status:** RESOLVED
- **Verification:** CONFIRMED (measured)
- **Blast radius:** data-integrity
- **Locations:** `lib/scheduleParsers.ts:918-925` — `coerceIso`
- **Re-verified:** hardening pass — **SURVIVES** — the strongest of the schedule findings. The docblock at `scheduleParsers.ts:910` promises *"we treat as M/D/Y **if first part ≤ 12**"*; the code at `:923` is `const month = a; const day = b;` with no such test. `15/08/2026` yields `2026-15-08T00:00:00Z`, which is not a date at all — the value is destroyed rather than merely swapped.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed exactly as claimed: the comment promises a conditional the code does not contain. Day values 1-12 are silently transposed into a valid-looking wrong date; 13-31 produce month=13..31 and surface only as a raw per-row Postgres message in `result.errors` (milestones.ts:1052-1054), with no way to tell the silently-wrong rows apart.

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

**Resolution (2026-09-23, projects Round G).** Day-first vs month-first is now a property of the FILE, decided once. `lib/scheduleParsers.ts` `detectDateConvention(text)` scans every slash date in the whole file: any first part > 12 proves D/M/Y, any second part > 12 proves M/D/Y; neither is genuinely ambiguous, both is a self-contradicting file. `runParser` applies the file's verdict to every row; an ambiguous (or contradicting) file withholds its rows (`needsDateConvention: true`, `rows: []`) until the caller supplies `ParseOptions.dateConvention`, and a file that fixed its own convention ignores the user's answer. `coerceIso(value, convention)` is a pure function of the pair: it validates month 1–12 / day 1–31 and returns `""` (the row is skipped and counted as "date could not be read as day/month/year") instead of emitting a month 15 for Postgres to reject. The result carries `dates: { convention, decidedBy: "file" | "user" | "none", sample }`; the comment that promised a guard now describes the code. `components/projects/ScheduleImportModal.tsx` keeps the dropped bytes, asks once with a two-way radio (no default — never guess), re-parses on the answer, and prints the applied reading and its evidence (`fixed by the file: 15/08/2026` or `your choice`) above the preview and again in the import result. Tests: `lib/__tests__/scheduleParsers.test.ts` "SCH-1 ·" — a D/M/Y file parses every row (including the ≤ 12 rows) as D/M/Y; an M/D/Y file likewise; an all-≤-12 file asks once, the answer applies to every row and is reported, and the two answers give the two readings; the user cannot override a file that decided; a contradicting file asks and skips the impossible rows under the chosen reading; ISO dates never ask.

**Done-when.** 1 ✓ (`15/08/2026` anywhere → every row D/M/Y). 2 ✓ (one radio, rows withheld until answered). 3 ✓ (convention + sample in the modal and the result panel). 4 ✓ (the all-≤-12 fixture, both answers).

**Scope / residual.** The scan is over the whole text, task names included, so a slash date inside a name counts as evidence for the file — accepted (it is the same document, and it errs toward asking, not guessing). The MS Project / P6 XML paths carry ISO dates and never reach the question; `coerceIso`'s `Z`-attachment for offset-less datetimes is `PC SCHED-9`'s half of the same function.

---

## SCH-2 · Re-importing the weekly schedule wipes progress the crew logged in the app

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `lib/milestones.ts:958-969` — `baseFields` includes `status`, `percent_complete`, `actual_at`, `actual_start_at`
  - `lib/milestones.ts:1005-1019` — `update({...baseFields, ...})` on the matched `external_ref`
  - `components/projects/ScheduleImportModal.tsx` — the tip strip, which is the only warning
- **Re-verified:** hardening pass — **SURVIVES**. `baseFields` writes `status`, `percent_complete`, `actual_at` and `actual_start_at` unconditionally from the imported file (`milestones.ts:962-967`), so a re-import overwrites progress the crew logged in the app.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and worse than stated: a source file with no %-complete column at all yields importPct = 0 for every row (the `: 0` fallback), so it zeroes progress even when the source never claimed 0. No mitigation exists — ScheduleImportModal has no merge/preserve option (grep for 'progress|overwrite|existing' in the modal returns only comments and the result counters), and nothing pre-deletes or diffs before the update.

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

**Resolution (2026-09-23, projects Round G — the engine half of GAP-403; the modal's review step lands here too because the modal is this package's).** `lib/milestones.ts` `importMilestonesFromParsed` separates PLAN fields (name, dates, structure, links, description, rich columns) from ACTUALS (`status`, `percent_complete`, `actual_at`, `actual_start_at`). A row with local progress (`hasLocalProgress`: percent > 0, status ≠ planned, or an actual date) keeps its actuals unless the caller passes `overwriteProgress: true`; a file that carries no progress column at all claims nothing and never touches them, opt-in or not. Before any write the importer reads the existing rows once and computes an `ImportPlan` — `added / changed / unchanged / notInFile (+ names) / localProgressAtRisk[{ id, name, localPercent, localStatus, filePercent }]` — and `dryRun: true` returns it with nothing written. Rows the file does not mention are counted, named and left alone: an import never deletes (GAP-403 "do not treat a row missing from the new file as deleted"). `ScheduleImportModal.tsx` runs a dry run first ("Review changes"), shows the plan with the at-risk rows and a checkbox "Overwrite the progress recorded here with the file's values" (off; ticking it re-plans), and only then offers "Import N changes"; the old tip strip that promised "upserts rows with stable IDs" now says what happens. Tests: `lib/__tests__/scheduleImportWriters.test.ts` "SCH-2 ·" — a progressed row (60 % / in_progress, 100 % / completed) survives a zero-progress re-import with NO write issued; a file with no % column never touches progress even on opt-in; opt-in replaces the values and the plan said so; dry run writes nothing.

**Done-when.** 1 ✓ (preserved by default; a re-import that changes nothing issues no write at all). 2 ✓ (plan panel before the write, with the rows named). 3 ✓ (`first import lands the file's progress; a zero-progress re-import leaves the crew's 60% and in_progress alone`).

**Scope / residual.** The choice is all-or-nothing per import, as the finding allowed ("a per-row or all-or-nothing choice"); per-row picking is a modal refinement for the PT surface packages. `importGhostMilestones` (the legacy CSV-paste path) is untouched and keeps its old semantics — it has no UI caller in the projects tab.

---

## SCH-3 · CSV re-import matches rows by position, so inserting one row scrambles every row after it

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:** `lib/scheduleParsers.ts:710` — `externalRef: id ? \`${refTag}:${id}\` : \`${refTag}-row:${rowIndex}\``
- **Re-verified:** hardening pass — **SURVIVES**. `externalRef: id ? `${refTag}:${id}` : `${refTag}-row:${rowIndex}`` (`scheduleParsers.ts:710`) — with no id column the identity **is** the row index, so inserting a row re-points every ref after it.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Survives, with one scoping caveat the title omits: the positional fallback only fires when the CSV carries no id column — findCol looks for 'unique id|uid|id|task id' (msproject-csv, l.584) or 'external_ref|id|ref' (generic-csv, l.600). For the very common headerless-id export it does fire, and then inserting or dropping a single row silently rewrites the name, dates and progress of every subsequent row. Note the second-order bug: a blank/undated row shifts rowIndex too, so even an unchanged file can re-align differently.

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

**Resolution (2026-09-23, projects Round G).** Identity is content, never position. `lib/scheduleParsers.ts`: a keyless CSV row is keyed `<tag>-key:<fnv1a(name | planned finish | planned start)>` (`contentKey`), so a row inserted above cannot re-point any other row and two different files cannot collide on an index; rows identical in content within one file get a `#n` suffix and a warning instead of overwriting each other. MS Project CSV splits the old synonym race into `id: ["unique id","uid"]` (the key) and `seq: ["id","task id"]` (the outline position): Unique ID is preferred, and a file that carries only ID is keyed on it with the warning `Rows are keyed on the "ID" column, which MS Project renumbers when rows are inserted — add "Unique ID" to the export …`. Every result names its `keyColumn` (`Unique ID` / `ID` / `content (name + dates)` / `UID` / `ObjectId` / `task_id`), and the modal shows it ("Re-imports match rows on …") above the preview and in the result. Migration `20261097_prj_roundG_import_identity.sql` adds `milestones.import_batch_id` (SCH-14) and the DEC-30 inventory of rows still keyed by position (`csv-row:` / `msp-row:`) — they are NOT rewritten (a position cannot be mapped to content after the fact); the next re-import of that file adds content-keyed rows beside them and reports the old ones as "not in file". Tests: `scheduleParsers.test.ts` "SCH-3 ·" (content keys; top insert leaves every other ref intact and no `csv-row:` survives; two files do not collide; duplicate suffixing; Unique ID preferred / ID warned) and `scheduleImportWriters.test.ts` "SCH-3 ·" (after a top insert: 1 added, 3 unchanged, every id and the crew's progress intact; a filtered export reports 2 not-in-file and deletes nothing).

**Done-when.** 1 ✓. 2 ✓. 3 ✓.

**Scope / residual.** The plan's `milestones.source_key` column was not added: the 20260704 project-scoped unique index on `external_ref` already IS the identity rail, and a second identity column nothing else reads would be a second source of truth (the DB-8 shape). Namespacing by file name was deliberately not used either — a renamed file would duplicate the whole schedule; two files whose rows are identical in name and dates share a key because they describe the same task. Pending migration: `supabase/migrations/20261097_prj_roundG_import_identity.sql` (the importer degrades without it: `import_batch_id` is dropped from the write and the hierarchy fields are kept).

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
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed exactly as described, including the preview mismatch — MovePreviewSheet receives pendingMove.ids (the drag target) while commitMove persists the merged cascade set. resizeEdge (l.528), resizeSummaryEdge (l.~550) and sequencePhase (l.~570) all call withCascade and persist without any sheet at all. The 'years' figure is guard-bounded, not unbounded, but scales with schedule size.

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

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** correctness
- **Locations:**
  - `components/projects/ScheduleTab.tsx:518`, `lib/executionReport.ts:136`, `lib/scheduleFilter.ts:101`, `lib/projectSnapshot.ts:115-119`, `lib/projectReport.ts:88-91` — `planned < Date.now()`
  - `components/projects/ScheduleProgress.tsx:41, 49-53` — `planned < local midnight`
  - `components/projects/ExecutionView.tsx:949` — `planned < startOfDayUTC(now)`
- **Re-verified:** hardening pass — **SURVIVES**. Two of the three verified directly and they disagree: `ScheduleTab.tsx:518` is `!actual && planned < now && effStatus !== "completed"`, `executionReport.ts:136` is `m.status !== "completed" && finishMs(m) < now` — different inputs, different answers for the same row. `planned` is midnight-anchored, so a task due today reads overdue from 00:00.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. Every factual element checks out, including the side-by-side contradiction and the fourth/fifth variants in projectSnapshot.ts:115-118 and projectReport.ts:88-91 (both Date.now()) that feed projectHealth's overduePenalty. Downgrading to HIGH: it is a read-path/display and scoring defect — nothing is persisted or destroyed, and the discrepancy is at most one day wide.

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

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** correctness
- **Locations:**
  - `components/projects/ScheduleTab.tsx:259` and `:397` — the two claims
  - `components/projects/ScheduleTab.tsx:317` — `visible`, the ghost-filtered list
  - `components/projects/ScheduleTab.tsx:233` — `ScheduleProgress`, the one component fed the full list
- **Related:** `MON-6`
- **Re-verified:** hardening pass — **SURVIVES**, and the tooltip is quotable. `ScheduleTab.tsx:259` reads *"Hide the read-only rows imported from your scheduling tool (they still count in the metrics)"* — while `:317` passes the filtered `visible` set into `ExecutionView`, so they do not.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → MEDIUM** by this pass. The underlying inconsistency is real — the toggle silently rebases every Execution-view number — but the finding overstates it: the tooltip's literal claim is TRUE, since both the metrics object and ScheduleProgress take the unfiltered `milestones`. So it is not 'almost every number' and the tooltip is not lying; it is a scope mismatch between two views. Display-only and instantly reversible, hence MEDIUM rather than CRITICAL.

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
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both halves confirmed by repo-wide search. The channel is `.subscribe()`d in code but the table is not in supabase_realtime and has no REPLICA IDENTITY FULL, so no event is ever delivered — last-writer-wins with no detection and no refresh.

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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `lib/scheduleParsers.ts:372-379` — `TASKPRED`, `pred_type` not read
  - `lib/scheduleParsers.ts:508-523` — `<Relationship>`, `Type` not read
- **Related:** `SCH-4`, `SCH-9`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The P6 relationship loop reads only `SuccessorActivityObjectId` and `PredecessorActivityObjectId` (`scheduleParsers.ts:372-379`) — **neither `Type` nor `Lag` is read at all**, so FF/SS/SF collapse to FS and every lag becomes zero.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Primary claim fully confirmed for both P6 paths (and the MSP path at l.269-272 likewise ignores Type/LinkLag). One overstatement: the SS+FF 'ladder' is normally authored in a single direction (A→B SS plus A→B FF), which dedupes to one FS edge, not a cycle — reciprocal-direction pairs are needed for the SCH-4 input, and those are less common than the finding implies. Silent lag loss and FS flattening alone justify HIGH.

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

**Resolution (2026-09-23, projects Round G — parser half; the reflow's use of lag is P6b's / PC-4's).** Every relationship is captured with its type and lag and only finish-to-start becomes a `depends_on` edge. `lib/scheduleParsers.ts`: `ParsedLink { predecessorExternalRef, type: FS | SS | FF | SF, lagHours }` on each row (`links`), read from MS Project XML `<PredecessorLink><Type>` (0 = FF, 1 = FS, 2 = SF, 3 = SS) and `<LinkLag>` (tenths of a minute), P6 XML `<Relationship><Type>` ("Start to Start" …) and `<Lag>` (hours), XER `TASKPRED.pred_type` (`PR_FS` …) and `lag_hr_cnt`, and CSV tokens (`2SS+1d`, `3FF`, `2FS+2h`). `splitLinks` puts FS into `dependsOnExternalRefs`, counts the rest as not enforced, and serialises everything the engine does not carry onto the task as `attributes.source_links` (`"SS msp-uid:1 +8h; FF msp-uid:3"`) so it is stored and visible. The result's `links` census (`fs / notEnforced / withLag / unresolved`) drives two warnings: `N start-to-start / finish-to-finish / start-to-finish links captured but not enforced — the schedule engine honours finish-to-start only …` and `N finish-to-start links carry lag; the lag is recorded on the task but not applied by the reflow.` Tests: `scheduleParsers.test.ts` "SCH-8 ·" (CSV tokens; XER `PR_SS` + `PR_FF` pair between two activities creates no edge) and `scheduleParsersXml.test.ts` "SCH-8 ·" / "P6 XML ·" (MSPDI Type + LinkLag; a P6 SS + FF ladder creates NO edge in either direction — no cycle — and is recorded with its lag).

**Done-when.** 1 ✓ (recorded, reported with a count, never flattened). 2 ✓ (the SS + FF fixture yields no `dependsOn` on either activity).

**Scope / residual.** Option (b) of the remediation, made honest: non-FS links are stored on the task rather than dropped, so the engine half (PC-4 / P6b honouring lag and, after its own test, SS/FF) can read them back without a re-import. FS lag is recorded but not applied until that lands.

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
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: with imported rows hidden, a chain A→B→C whose middle node B is an imported row is invisible to the guard, so adding A dependsOn C returns false from wouldCreateCycle and persists a genuine cycle (TaskDetailPanel.tsx:699 saves it unconditionally). Partial mitigation: the candidate list is also drawn from the filtered set, so only the intermediate hops can be hidden ones — it narrows the path, it does not close it.

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
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and the UTC-rendering half of the claim — the part that would have refuted it — checks out: every schedule surface formats with `timeZone: "UTC"` while the rebase modal builds its instant from a local parse, so a US user with a midnight-UTC anchor lands one calendar day late on the board.

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
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: absolute-epoch rounding to a DAY_MS multiple is UTC midnight, so any leaf stored at ≥12:00 UTC (MS Project's usual 17:00 finishes) rounds forward a calendar day, and the rescale factor compounds it further out from the anchor. Only leaves with a non-midnight time-of-day are affected, but the code writes those moved dates back, so the data-integrity framing is right.

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

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (measured)
- **Blast radius:** correctness
- **Locations:** `lib/milestones.ts:1410` — `const start = new Date(finish); start.setDate(finish.getDate() - (input.days - 1));`
- **Re-verified:** hardening pass — **SURVIVES**. `const start = new Date(finish); start.setDate(finish.getDate() - (input.days - 1))` (`milestones.ts:1410`) — `getDate`/`setDate` are local-calendar operations applied to a value parsed from a UTC instant, so a span crossing a DST boundary lands a day out.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is real and I reproduced the report's fall-back case by hand: finish 2026-11-02T00:00:00Z in America/Los_Angeles is Nov 1 16:00 PST, `setDate(-1)` lands Oct 30 16:00 PDT = 2026-10-30T23:00:00Z, one UTC day earlier than the correct 2026-10-31T00:00Z. Downgrading to MEDIUM because it is wrong only when the span crosses a DST transition in a DST-observing zone — outside that window the constant offset cancels and the result is exact, as the report itself concedes.

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

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (grep for `source` in the three views returns nothing)
- **Blast radius:** ux / data-integrity
- **Locations:**
  - `components/projects/ExecutionView.tsx`, `TaskDetailPanel.tsx`, `ScheduleCalendarTileView.tsx` — no source handling anywhere
  - `components/projects/ScheduleTab.tsx:607` — delete, available on imported rows
  - The HelpTooltip claiming "Imported rows are read-only milestones"
- **Related:** `SCH-2`
- **Re-verified:** hardening pass — **SURVIVES**. Nothing in `ScheduleTab.tsx` gates its edit controls on the row's `source`, so rows the UI calls "read-only imported" accept edits — which `SCH-2` then overwrites on the next import.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The claim of absence holds — `source` exists on the milestone (lib/milestones.ts:65, types/schema.ts:516) but no view consults it before allowing edit, status change, or delete, so the tooltip is false. On its own this is a misleading label plus unguarded edits; the actual data loss lives in the separately-filed re-import overwrite (SCH-2), so MEDIUM.

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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** availability / ux
- **Locations:**
  - `components/projects/ScheduleImportModal.tsx:108-124` — whole-file decode and parse, synchronous, no byte limit
  - `lib/milestones.ts:938-1064` — one SELECT + one INSERT/UPDATE per row, sequentially
  - `lib/milestones.ts:1072-1107` — passes 2 and 3 fire every update at once
- **Re-verified:** hardening pass — **SURVIVES**, all three parts. `handleFile` calls `file.arrayBuffer()` with no size check (`ScheduleImportModal.tsx:113-116`), and `importMilestones` loops row-by-row (`milestones.ts:938-949`) with per-row work inside.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on all three counts. The passes at milestones.ts:1072-1107 do at least batch with `Promise.all`, so the unbounded sequential cost is in pass 1 only; there is still no size cap, no row cap, and no transaction, so an interrupted large import leaves a partial schedule behind.

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

**Resolution (2026-09-23, projects Round G).** Caps: `SCHEDULE_IMPORT_LIMITS = { maxBytes: 5 MB, maxRows: 5,000 }` (`lib/scheduleParsers.ts`). The modal refuses a larger file BEFORE decoding it, naming the size and the limit; the importer refuses more rows than the cap with the count and the limit named and writes nothing (the modal disables the buttons and says so too). Round trips: `importMilestonesFromParsed` reads the existing rows ONCE (paged at PostgREST's 1,000), inserts new rows in chunks of 200, updates changed rows in chunks of 200 as an upsert by primary key (the existing row's provenance travels with it), never writes an unchanged row, and wires structure in batches of 25 concurrent updates only for rows whose parent / predecessors changed. A schema error on a chunk steps down a tier (`import_batch_id` first, then the 20260703 hierarchy fields) and retries; any other chunk error isolates the bad rows one at a time so one unreadable row does not sink two hundred. Progress + cancel: `onProgress({ done, total, phase })` and an `AbortSignal`; the modal shows a bar with a Cancel button; a cancelled import stops between chunks, returns `cancelled: true` and `Import cancelled after N of M rows. Rows written so far are tagged with batch <id>.` Every row an import inserts or updates carries `import_batch_id` (migration `20261097`), so the partial state is visible and reversible, and re-importing the same file completes it (the merge is idempotent). Tests: `scheduleImportWriters.test.ts` "SCH-14 ·" — 5,001 rows refused with the limit named and nothing written; 1,000 new rows land in exactly 5 inserts with progress `[0, 200, …, 1000]` and every row tagged; cancel at 200 of 450 stops with 200 rows written and the message naming the batch; a bad row inside a chunk is isolated per row; a database without `20261097` drops `import_batch_id` alone and keeps the hierarchy fields.

**Done-when.** 1 ✓ (5,000 rows = 25 chunked requests plus structure; more is refused with the limit named). 2 ✓ (bar + Cancel). 3 ✓ as "recoverable": PostgREST has no client transaction, so a closed tab still leaves rows behind — but they are tagged with the batch id and the next import of the same file finishes the merge; nothing is half-written within a row.

**Scope / residual.** The structure pass is chunked but still per-row (25 in flight); folding parent / predecessor ids into the chunked upsert would need a second full write of every row, which costs more than it saves. Passes 2 and 3 are one pass now.

---

## SCH-15 · The critical path ignores the real dependency edges

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** decision-quality
- **Locations:** `lib/criticalPath.ts` — `computeCriticalPathLite` never reads `dependsOn`
- **Re-verified:** hardening pass — **SURVIVES**, by absence — the critical-path computation does not consult the stored dependency edges.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence: the highlighted chain is pure date-contiguity while cascadeDependents reschedules off the stored FS edges, so the two disagree. Partial mitigation the finding does not mention: ExecutionReportView.tsx:88 does print 'heuristic — based on schedule shape, not dependency links', but the timeline surface does not (ExecutionView.tsx:729 button reads just 'Critical path', legend tooltip l.1503 'On the critical path — drives the finish date'). MEDIUM is right.

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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:** `lib/milestones.ts:1072-1107` — passes 2 and 3
- **Re-verified:** hardening pass — **SURVIVES**. The re-import builds a `parent_id` update list (`milestones.ts:1072-1083`) and has no path that clears an existing parent, so structure accumulates and never retracts.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed. There is no delete-then-insert either: ScheduleImportModal.tsx:155-190 calls importMilestonesFromParsed directly with no prior purge, and the existing-row branch (l.1005) is an UPDATE of baseFields only, which contains neither parent_id nor depends_on. Structure accumulates monotonically across re-imports.

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

**Resolution (2026-09-23, projects Round G).** For every row the file carries, the importer sets `parent_id` and `depends_on` to exactly what the file says — `NULL` / `[]` when it says none — and skips the write when nothing changed; rows the file does not mention are not touched (`lib/milestones.ts` `importMilestonesFromParsed`, structure pass; a database without `20260715` keeps the hierarchy write and drops the links). Test: `scheduleImportWriters.test.ts` "SCH-16 ·" — a predecessor removed upstream is cleared locally (`depends_on: []`), an un-parented task gets `parent_id: null`, the untouched sibling keeps its parent, and exactly one structure write is issued.

**Done-when.** 1 ✓. 2 ✓.

**Scope / residual.** None beyond the finding: removal of rows stays a separate explicit action (GAP-403), so a task that disappears from the file keeps its structure.

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
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on both cited locations. Blast radius is bounded (rows survive as new top-level roots, nothing is destroyed), which is consistent with MEDIUM.

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
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Claim survives, but the report's stated mechanism is wrong on one point: runUndo does NOT swallow throws — l.66-69 pushes a 'Couldn't undo: …' toast, and dismissing first is irrelevant because a new toast is created. The defect is real for a different reason: onMoveMany/onSetStatus/onSetProgress catch internally and return false, so a failed undo is indistinguishable from a successful one. Mitigation: the failure still paints the red error banner via setError, so it is not fully silent.

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
