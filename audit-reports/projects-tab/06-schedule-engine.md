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

**Resolution (2026-09-29, projects Round G).** Day-first vs month-first is now a property of the FILE, decided once. `lib/scheduleParsers.ts` `detectDateConvention` scans every slash date in the file's DATE VALUES: any first part > 12 proves D/M/Y, any second part > 12 proves M/D/Y; neither is genuinely ambiguous, both is a self-contradicting file. The evidence (`dateEvidence`) is a CSV's start and finish columns only — a dash-separated code such as `1-13-100` or a date typed into a note is never evidence — and MS Project / P6 XML and XER, whose dates are ISO, are not scanned at all, so they never reach the question. `runParser` applies the file's verdict to every row; an ambiguous (or contradicting) file withholds its rows (`needsDateConvention: true`, `rows: []`) until the caller supplies `ParseOptions.dateConvention`, and a file that fixed its own convention ignores the user's answer. `coerceIso(value, convention)` is a pure function of the pair: it validates month 1–12 / day 1–31 and returns `""` (the row is skipped and counted as "date could not be read as day/month/year") instead of emitting a month 15 for Postgres to reject. MS Project's default display — a day name before the date (`Mon 6/1/26`, `Tue. 15/08/2026 5:30 PM`) — is read the same way: the day name is dropped before the numeric match. A value holding a d/m/y triple is never handed to `new Date()` (which reads month-first in the browser's zone whatever the file decided); if the numeric match fails it is unreadable and counted. A year-first value (`2026/06/01 8:00`, `2026.6.1`, `2026-6-1` — what ja / zh / ko MS Project exports write) is always year / month / day, validated, and never asks the question; a written-out month (`June 1, 2026`) is the only form left to `new Date()`, and its wall clock is re-emitted as UTC, so it no longer lands a day early east of UTC (a value that names its own zone — `GMT`, `+02:00` — keeps its instant). The result carries `dates: { convention, decidedBy: "file" | "user" | "none", sample }`; the comment that promised a guard now describes the code. `components/projects/ScheduleImportModal.tsx` keeps the dropped bytes, asks once with a two-way radio (no default — never guess), re-parses on the answer, and prints the applied reading and its evidence (`fixed by the file: 15/08/2026` or `your choice`) above the preview and again in the import result. Tests: `lib/__tests__/scheduleParsers.test.ts` "SCH-1 ·" — a D/M/Y file parses every row (including the ≤ 12 rows) as D/M/Y; an M/D/Y file likewise; an all-≤-12 file asks once, the answer applies to every row and is reported, and the two answers give the two readings; the user cannot override a file that decided; a contradicting file asks and skips the impossible rows under the chosen reading; ISO dates never ask. "SCH-1 · weekday-prefixed dates and the evidence the file decides from" — under America/Los_Angeles `Mon 6/1/26` reads `2026-01-06` (D/M) and `2026-06-01` (M/D) and a triple with trailing text is `""`; a CSV of weekday dates asks and the day/month answer is what the rows get; a file with `Mon 13/1/26` decides D/M/Y for every row; a `1-13-100` code decides nothing and a note's `13/4/2026` does not ask; an XER task name with a slash date does not ask. `scheduleParsersXml.test.ts` "SCH-1 ·" — an MS Project XML whose `<Notes>` holds `3/4/2026` imports without the question. `scheduleParsers.test.ts` "SCHED-9 ·" — under Asia/Kolkata `2026/06/01 8:00` reads `2026-06-01T08:00:00Z` (Date() would give `…05-31T18:30Z`), a year-first CSV is not asked about, `2026/13/01` is `""`; `June 1, 2026` / `Mon June 1, 2026 8:00 AM` / `1-Jun-2026` read the same wall clock under Asia/Kolkata, America/Los_Angeles, Pacific/Auckland and UTC.

**Done-when.** 1 ✓ (`15/08/2026` anywhere → every row D/M/Y). 2 ✓ (one radio, rows withheld until answered). 3 ✓ (convention + sample in the modal and the result panel). 4 ✓ (the all-≤-12 fixture, both answers).

**Scope / residual.** Only a CSV's start and finish values are evidence. A written-out month (`June 1, 2026`) has no day/month order to decide; it still goes through `new Date()` for the month name, but only its wall clock is kept (re-emitted as UTC), so the reading does not depend on the importer's zone. `coerceIso`'s `Z`-attachment for offset-less datetimes is `PC SCHED-9`'s half of the same function.

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

**Resolution (2026-09-29, projects Round G — the engine half of GAP-403; the modal's review step lands here too because the modal is this package's).** `lib/milestones.ts` `importMilestonesFromParsed` separates PLAN fields (name, dates, structure, links, description, rich columns) from ACTUALS (`status`, `percent_complete`, `actual_at`, `actual_start_at`). A row with local progress (`hasLocalProgress`: percent > 0, status ≠ planned, or an actual date) keeps its actuals unless the caller passes `overwriteProgress: true`; a file that carries no progress column at all claims nothing and never touches them, opt-in or not. Before any write the importer reads the existing rows once and computes an `ImportPlan` — `added / changed / unchanged / notInFile (+ names) / localProgressAtRisk[{ id, name, localPercent, localStatus, filePercent }]` — and `dryRun: true` returns it with nothing written. A row counts as changed only when a column the importer would write differs from the stored row — EVERY plan column (name, description, weight, both dates, outline level, WBS, summary flag, shift, work order, responsible party / kind / org, location, duration hours, attributes), with timestamps compared as instants (PostgREST returns `…+00:00`, the parser `…Z`), numbers as numbers and attributes as canonical JSON (`samePlanValue`) — so an identical re-import is "Unchanged N" and writes nothing against a real database, and a changed work value, extra column or level reaches rows imported earlier. The plan also carries `structure { rows, onlyStructure, parents, linksAdded, linksRemoved }`: the parents and links the structure pass will set, including removing a link added in the app to an imported row. Rows the file does not mention are counted, named and left alone: an import never deletes (GAP-403 "do not treat a row missing from the new file as deleted"). `ScheduleImportModal.tsx` runs a dry run first ("Review changes"), shows the plan — structure changes counted and named, and the at-risk rows worded by direction (`60% on the board → 80% in the file (higher)`; the board's value may have come from the crew or an earlier import) with a checkbox "Take the file's progress for these tasks" (off; ticking it re-plans) — and only then offers "Import N changes", N counting added, changed, structure-only and re-key-only rows (`planChangeCount`). The reviewed plan is the change set that is written: any change to the column review after "Review changes" — include, rename or map-to (`updateColumn`) — or "Choose another" discards the plan, so the user reviews again before anything can be written; the old tip strip that promised "upserts rows with stable IDs" now says what happens. Tests: `lib/__tests__/scheduleImportWriters.test.ts` "SCH-2 ·" — a progressed row (60 % / in_progress, 100 % / completed) survives a zero-progress re-import with NO write issued; a file with no % column never touches progress even on opt-in; opt-in replaces the values and the plan said so; dry run writes nothing. "SCH-2 · the plan compares what PostgREST really returns" — against a mock that renders timestamptz as `+00:00`, fills a bulk write's missing keys with NULL and refuses NULL in NOT NULL columns: an identical 400-row re-import is Unchanged 400 with zero writes; a change in work hours, an extra column or the start instant is Changed and lands; a hand-set shift is not re-derived; a dropped predecessor (and one added in the app) is counted as structure-only. "SCH-2 / SCH-16 · the review panel's numbers" pins the button count and the direction wording. `lib/__tests__/scheduleImportModalReview.test.ts` renders the modal (react-dom in jsdom, real parser, importer mocked): after "Review changes", unticking a column, renaming it or mapping it to a field removes "Import N changes" and brings back "Review changes", and the next review receives the rows as newly configured; "Choose another" drops the plan with the file (checked against the pre-fix handlers: the first two fail).

**Done-when.** 1 ✓ (preserved by default; a re-import that changes nothing issues no write at all — against PostgREST's `+00:00` rendering, not only a mock that echoes the written strings — once rows imported by position before this round have been re-keyed: the first re-import re-keys in place, progress kept, each position row whose name occurs once among the position rows and once in the file, and writes the file's planned dates to it; a position row whose name repeats on either side is never adopted — that re-import adds the file's rows of that name and keeps the old rows as not-in-file, and the plan names them — so for repeated names the first re-import is not "no change": SCH-3). 2 ✓ (plan panel before the write, with the rows named, progress worded by direction and structure changes counted; a column-review change after the review discards the plan, so what is written is what was reviewed). 3 ✓ (`first import lands the file's progress; a zero-progress re-import leaves the crew's 60% and in_progress alone`).

**Verification fix (2026-09-30, projects Round G).** The column review — include checkbox, rename field, map-to select — is disabled while "Review changes" runs its dry run (`planning`; the panel says "Locked while the review runs."), and every input change — the column review, "Choose another" or a new file, the date / project answer, the progress opt-in — retires a dry run still in flight (`planToken` / `invalidatePlan` in `ScheduleImportModal.tsx`), so an answer computed for inputs that no longer hold is dropped, never shown as the plan. Tests: `scheduleImportModalReview.test.ts` "SCH-2 · while the review's dry run is in flight …" — the three controls are disabled until the plan arrives, a click on the checkbox changes nothing, and the plan describes the rows as sent; "Choose another" and a new file while the old dry run is pending → the old answer is dropped and the new file offers "Review changes", not "Import N changes" (both fail against the previous component). Done-when 1's parenthetical now states what the first re-import does with position rows: adopted by a name unique on both sides, never by a repeated one (SCH-3's verification fix).

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

**Resolution (2026-09-29, projects Round G).** Identity is content, never position. `lib/scheduleParsers.ts`: a keyless CSV row is keyed `<tag>-key:<fnv1a(name | planned finish | planned start)>` (`contentKey`), so a row inserted above cannot re-point any other row and two different files cannot collide on an index; rows identical in content within one file get a `#n` suffix and a warning instead of overwriting each other. MS Project CSV splits the old synonym race into `id: ["unique id","uid"]` (the key) and `seq: ["id","task id"]` (the outline position): Unique ID is preferred, and a file that carries only ID is keyed on it with the warning `Rows are keyed on the "ID" column, which MS Project renumbers when rows are inserted — add "Unique ID" to the export …`. Every result names its `keyColumn` (`Unique ID` / `ID` / `content (name + dates)` / `UID` / `ObjectId` / `task_id`), and the modal shows it ("Re-imports match rows on …") above the preview and in the result. Migration `20261097_prj_roundG_import_identity.sql` adds `milestones.import_batch_id` (SCH-14) and the DEC-30 inventory of rows still keyed by position (`csv-row:` / `msp-row:`). Those rows are not rewritten by the migration; the importer ADOPTS them (`importMilestonesFromParsed`, adoption step): a keyless row whose content key matches no existing row is paired with an unclaimed existing row of the same tag keyed `<tag>-row:N` (or under an earlier `<tag>-key:`) — for an earlier content key, with the same name and the same planned finish and planned start compared as instants; for a position row, by name alone when that name (trimmed, inner spaces collapsed, case-folded) occurs once among the position rows of its tag and once in the file (verification fix below). The adopted row keeps its id, provenance and the crew's progress and is written with the new key (`external_ref` in the upsert); `ImportPlan.rekeyed` / `rekeyedOnly` count them, the review panel says so, and a re-key-only row counts toward "Import N changes". So the first re-import after deploy of a keyless file adds nothing for tasks whose names are unique — Unchanged, or Changed when the old parser read their dates in the importer's zone, re-keyed either way — instead of adding the whole schedule a second time; a task whose name repeats is added and its old row kept, and the plan names both groups (verification fix below); and the one after that matches on the content keys directly with nothing to write. Tests: `scheduleParsers.test.ts` "SCH-3 ·" (content keys; top insert leaves every other ref intact and no `csv-row:` survives; two files do not collide; duplicate suffixing; Unique ID preferred / ID warned) and `scheduleImportWriters.test.ts` "SCH-3 ·" (after a top insert: 1 added, 3 unchanged, every id and the crew's progress intact; a filtered export reports 2 not-in-file and deletes nothing) and "SCH-3 · rows imported by POSITION before content keys: a unique name is adopted …" (legacy `msp-row:` rows as the old importer stored them: an unchanged re-import plans Added 0 / Unchanged 3 / re-keyed 3 with the three names listed, updates the 3 rows in place (chunked upserts carrying the new key), keeping ids, provenance and 60 % progress, and the next re-import writes nothing; a unique row whose finish moved is adopted with the file's finish and its 60 % kept, shown at risk against the file's 0 %; two identical `csv-row:` rows are not adopted — both added, both old rows kept with their own progress; a name differing only in case or spacing still matches).

**Done-when.** 1 ✓. 2 ✓. 3 ✓.

**Scope / residual.** A keyless row's identity IS its name and dates: a keyless row whose name or dates change in the file becomes a NEW row, and the old one (with any progress the crew recorded on it) is reported as "not in this file" and left alone. The remediation accepted that as the fail-safe — the alternative is guessing which row an edited row used to be — and the review panel says it in words before anything is written; a file with a real id column (MS Project Unique ID, P6 ids, an `ID` / `external_ref` column) does not have this limit. A position row is adopted only by a name unique on both sides (the rule is in the verification fix below). The residual, plainly: a legacy task whose name repeats — among the position rows or in the file (walkdowns, line checks, QC checks, identical rows) — is DUPLICATED rather than matched: the file's rows of that name are added with no progress, the old rows are kept with theirs and listed as not in this file, and the review panel names them before anything is written ("N tasks repeat a name — their earlier rows are kept, not matched; review before importing"). Nothing moves a completion between tasks. A unique-named row is adopted whatever its dates — a real reschedule included — because the name identifies the task; the file's dates win and the crew's progress is kept as on any re-import (at risk when the file's % differs). An adopted row's actual dates are progress and are not re-read. The plan's `milestones.source_key` column was not added: the 20260704 project-scoped unique index on `external_ref` already IS the identity rail, and a second identity column nothing else reads would be a second source of truth (the DB-8 shape). Namespacing by file name was deliberately not used either — a renamed file would duplicate the whole schedule; two files whose rows are identical in name and dates share a key because they describe the same task. Pending migration: `supabase/migrations/20261097_prj_roundG_import_identity.sql` (the importer degrades without it: `import_batch_id` is dropped from the write and the hierarchy fields are kept).

**Verification fix (2026-09-30, projects Round G).** Three verifier passes. First: legacy `msp-row:` rows the old parser read in the importing browser's zone (timed M/D/Y, `Mon 6/1/26`, year-first and written-out values went through `new Date()`) were never adopted — an unchanged re-import added them all again. Second and third: each smarter pairing rule (an exact pass plus a per-row zone offset; then one offset voted for the whole import, with a DST twin checked against IANA zones) paired repeated same-named tasks with their neighbours or decided the offset wrongly — a 1 PM walkdown took the completed 8 AM walkdown's row, line checks every 8 h moved every completion one shift, a task legitimately moved by hours set the offset for the whole import, date-only milestones stored at 00:00Z inside a Chicago import pulled the reading to 0, Europe/London "justified" a DST twin for a UTC import, exact matches were dropped under a non-zero reading, and identical-row groups grew quadratically (4,990 identical rows threw `RangeError: Map maximum size exceeded`). The inference is gone (no offset, zone or DST logic): `lib/milestones.ts` `importMilestonesFromParsed`, adoption step — an earlier content key (`-key:`) is adopted only on an exact match of name and planned dates (a map keyed on them); a position row (`-row:`) is adopted only when its normalised name (trimmed, inner spaces collapsed, case-folded) occurs ONCE among the position rows of its source tag and ONCE among the file's rows, whatever its dates — the file's planned dates are written and the crew's progress is kept as on any re-import (the at-risk list shows it when the file's % differs). Every other position row is never adopted: the file's rows are added and the old rows kept as not-in-file. The plan lists the adopted names (`ImportPlan.positionAdopted` / `positionAdoptedNames`, first 20 then a count; `positionAdoptedSummary`) and the repeated ones (`positionRepeated` / `positionRepeatedNames`; `positionRepeatedSummary`: "N tasks repeat a name (…) — their earlier rows are kept, not matched; review before importing"). Every lookup is a map built once, so the step is linear. Tests: `scheduleImportWriters.test.ts` "SCH-3 · position rows the OLD importer stored (in any browser zone) …", legacy rows produced by the pre-Round-G reading under the zone — unique names from Chicago, Kolkata and UTC browsers all adopted with the file's dates and progress kept, the next re-import writing nothing; the panel's adopted-name line (20 names, then "and 3 more"); walkdowns at 8 AM (completed) and 1 PM: both added, the completion on its own old row, the panel's repeated-name line; line checks every 8 h from Los Angeles: none adopted, three completions in place; hourly QC checks in Berlin: none adopted, the completion in place; "Inspect" moved 8 AM → 6 PM (unique): adopted with the file's dates, completion kept and shown at risk against the file's 0 %; the verifier's A1 (Chicago legacy, one task moved +5 h), A2 (UTC legacy, three tasks moved +2 h: Demob adopted, not duplicated), A3 (date-only milestones beside timed tasks) and A5 (a +1 h reschedule and hourly checks after the UK change): no completion moves and every unique name is adopted even where its dates moved; an earlier content-keyed row 5 h off is not adopted; 5,000 rows with 4,990 sharing one name plan in under a second (asserted).

---

## SCH-4 · A dependency cycle launches tasks years into the future, and the move is persisted

- **Severity:** CRITICAL
- **Status:** RESOLVED
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

**Resolution (2026-09-30, projects Round G).** Reproduced first against `fdb51b1`: the 2-node cycle moved A from 2026-06-01 to 2026-07-11 in a two-row project (guard 40). `lib/scheduleReflow.ts`: `cascadeDependents` is now `planCascade(…).changes`; every push records its cause — the predecessor link, or the ancestor a sub-task was carried with — and a push whose cause chain already contains the task being pushed is a loop: `CascadeRefusedError("cycle", edges)` names every edge in order (`a → b, b → a`; a loop through a carried sub-task reads `X → P (link), P → p1 (contains), p1 → X`) and nothing is written. The displacement backstop refuses (`"runaway"`) any push further than an acyclic cascade could ever go — the schedule's span plus every task laid end to end, a day per link and every positive lag (its calendar span, `afterLagMs`) — so only a loop can reach it. Each task is settled ONCE, in topological order over the part of the network the move reaches (links, and a pushed task → the sub-tasks it carries): its predecessors and the parent that carries it are final before it is looked at, so an acyclic cascade takes one step per task. Only when that part holds a loop does the push-by-push relaxation run: it refuses the moment a push goes round the loop (a loop no push reaches is left alone), the displacement bound ends it, and a Bellman-Ford step count (`nodes × (nodes + links)`) stands behind that. A pushed task's own sub-tasks are cascaded too, so their successors follow (the old loop re-queued only the pushed node). *Corrected in the review fix pass:* the first version relaxed every cascade FIFO under a step guard of `(nodes + links) × 4 + 32` and this record said "neither can trigger on a legitimate move" — false: A plus X1 → … → X40 with every Xi also depending on A, listed in reverse (same-day rows come back from the database in no fixed order), took ~800 steps against 512 and was refused as "runaway" with nothing moved (reproduced against the branch head, then fixed). `components/projects/ExecutionView.tsx`: `withCascade` catches the refusal for every caller (drag / nudge / keyboard via the sheet, edge resize, summary resize, sequencing) and says it in task names — "These links go round in a loop: “A” → “B” → “A”. Nothing was moved — remove one of these links first." The preview: `changesFor(pendingMove, mode)` (each target's `computeTreeMove` plus the cascade) is the ONE computation both `MovePreviewSheet`'s new `planFor(mode)` and `commitMove` use, so the sheet's "Writes N tasks — K moved, M more follow (dependents and the phases around them)" and its button ("Shift N tasks") count exactly the rows the batch writes; a refusal replaces Confirm (disabled) with the loop named; locked dependents the move cannot push (done / imported) are listed by name. Tests: `dependencies.test.ts` "SCH-4 ·" (the 2-node cycle is a refusal naming both links, not a shift; the same cycle in a 200-row project; the carried-child loop with every edge; a diamond is not a loop; a pushed task's sub-task's successor follows; the reversed fan-in of 40 is WRITTEN — X40 on 07-20, one day per link — with exactly the writes of the forward order, and one of 400 settles; a stored loop downstream that no push reaches is left alone and refused once the move reaches it); `scheduleEngineUi.test.ts` "SCH-4 ·" (Writes 3 tasks — 1 moved, 2 more follow; "Shift 3 tasks"; a loop → an alert and a disabled Confirm; the sheet and the commit share `changesFor`).

**Done-when.** 1 ✓ (refused, edges named, nothing written). 2 ✓ (the sheet counts the computed write set). 3 ✓.

**Scope / residual.** Remediation 3 is a backstop only a loop can reach rather than "the project span": the span alone refused legitimate cascades in small schedules (a lag or a long chain pushes past today's envelope). A cycle already in stored data (an old import) is refused when a move pushes round it, not repaired; new ones can no longer be created (`SCH-9`), and a task inside an old loop can still have its other links edited.

---

## SCH-5 · Three contradictory overdue rules, one of which marks every task overdue on its own due date

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Partial (2026-09-29, projects Round G).** Consumer limb (two sites this package owns): `lib/projectSnapshot.ts:115-119` and `lib/projectReport.ts:88-91` no longer compute `planned < Date.now()`. Both call `isOverdueMilestone(row, now)` from the new `lib/milestoneLiveness.ts` — not completed AND the planned day (UTC) is before today's (UTC) day, matching the wall-clock-as-UTC storage convention — so a task due today is not overdue in any timezone and the health penalty is no longer docked a day early. Test: `lib/__tests__/projectSnapshot.test.ts` "overdue is by UTC day: due today is not overdue anywhere (SCH-5's measured case)" pins the finding's measured row (now `2026-08-21T16:00Z`, due `2026-08-21T00:00Z` → not overdue; `2026-08-20` → overdue; `23:59Z` on the due day → not; `00:00Z` next day → overdue); `projectReport.test.ts` "due today is not overdue on paper either". The remaining four sites — `ScheduleTab.tsx:518`, `executionReport.ts:136`, `scheduleFilter.ts:101`, `ScheduleProgress.tsx:49-53`, `ExecutionView.tsx:949` — are P6b's. **Ordering note for the integrator (2026-09-29):** these two consumer sites landed before P6b, contrary to the J7 brief's "P6b MERGED before" note, so the predicate lives in `lib/milestoneLiveness.ts` (`isOverdueMilestone`, UTC-day) rather than in `lib/scheduleProgress.ts` as this finding's remediation told P6b. P6b must **not** author a second `isOverdue` in `lib/scheduleProgress.ts` — it imports (or re-exports) `isOverdueMilestone` from `lib/milestoneLiveness.ts` for all four remaining sites, and its record closes this finding only once all six sites resolve to that one function (a source pin over the six files asserting no local `planned < now` rule remains is the proof). **Storage edge for P6b (recorded 2026-09-30 from the J7 review, not fixed here):** `isOverdueMilestone` assumes planned dates are stored wall-clock-as-UTC, but the wizard's milestones insert writes `new Date(date + "T12:00:00").toISOString()` — local noon (`lib/projectWizardWrites.ts`). For a creator at an offset above UTC+12 (UTC+12:45, +13, +14) that lands on the previous UTC day (overdue a day early); at UTC−12 on the next (a day late). At exactly UTC+12, local noon is 00:00Z the same day and does not shift. When P6b converges the six sites it should normalise that write to `${date}T00:00:00Z`, the convention `lib/milestones.ts` already applies (`:774`, `:899`).

**Verification fix (2026-09-30, projects Round G).** The storage-edge note above first said creators at "UTC+12…+14" land a day early. Local noon in UTC is 12:00 minus the offset, so only an offset above +12 crosses into the previous UTC day. At +12 it is 00:00Z on the same day. Corrected in place; the pointer to P6b is unchanged.

**Resolution (2026-09-30, projects Round G).** The remaining five schedule sites now call `isOverdueMilestone` (`lib/milestoneLiveness.ts`, by UTC day) — no second predicate was authored, per the ordering note above: `components/projects/ScheduleTab.tsx` `MilestoneRow` (was `planned < now`), `lib/executionReport.ts` (feeds `SchedulePulse`, the Report's "Overdue" and each group's "late"; was `finishMs(m) < now`), `lib/scheduleFilter.ts` `overdueOnly` (was `planned >= now`), `components/projects/ScheduleProgress.tsx` (was LOCAL midnight; now the UTC day, over leaves only — the population the pulse and the summary strip count — and its "Next 14 days" window is UTC days too), `components/projects/ExecutionView.tsx` `SummaryStrip` (was `startOfDayUTC` inline). Tests: `lib/__tests__/overdue.test.ts` — the finding's measured case (now `2026-08-21T16:00Z`, due `2026-08-21`) in America/Los_Angeles, UTC and Asia/Tokyo: not overdue; overdue from `2026-08-22T00:00Z`; the report (the pulse) and the filter give the same answer; a source pin over all seven files (the six sites plus `projectReport.ts`) asserts each imports `isOverdueMilestone` and that no `planned / finish < now | Date.now() | today`, `plannedAt >= now` or local `setHours(0,0,0,0)` rule remains (the pin matches all five retired rules at `fdb51b1`). `executionReport.test.ts` "flags overdue by UTC day" replaces a test that pinned the defect (a task due Mar 2 counted overdue at Mar 2 noon); `scheduleFilter.test.ts` "SCH-5 ·".

**Done-when.** 1 ✓ (every site resolves to `isOverdueMilestone`). 2 ✓ (the pulse and the strip call the same predicate over the same leaves). 3 ✓ (three zones).

**Scope / residual.** The storage edge recorded above — the wizard's milestones insert writes local noon (`lib/projectWizardWrites.ts`), which lands on the previous UTC day for a creator above UTC+12 — is NOT fixed here: that file is J7's (merged) and outside this package's list. The fix is one line (`${date}T00:00:00Z`, the convention `lib/milestones.ts` applies); left for its owner / the integrator.

---

## SCH-6 · Hiding imported rows changes almost every number, and the tooltip says it doesn't

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-30, projects Round G).** The toggle is a display filter. `components/projects/ScheduleTab.tsx` hands `ExecutionView` the FULL list with `hideImported={!showGhost}`; `ExecutionView` computes everything — `SchedulePulse`, `SummaryStrip`, `overallPercent`, the critical path, the date domain, the progress index, the Report, the cascade, the cycle check — over the full list and only leaves imported rows out of the rows drawn (a hidden row's visible children are drawn in its place) and the calendar tiles. The Planning list's progress index reads the full list too, so a manual parent whose imported children are hidden is still a phase ("rolls up", no Done button or status menu), and `planLeafStats` decides leaf-ness from the full list. The Planning search filter no longer leaks into the Execution board's figures either (the board used to receive `visible`). Tooltips rewritten: "Hide the rows imported from your scheduling tool from the list and the board. Every number, rollup, the critical path and the cycle check still count them." and the HelpTooltip (see `SCH-13`). Tests: `scheduleEngineUi.test.ts` "SCH-6 ·" — the summary strip reads identically with the toggle on and off (1 / 3 tasks complete: the hidden imported leaves still count), the imported rows are not drawn, and the manual phase over them keeps the read-only "Phase status — rolls up from sub-tasks" control; `scheduleEngineMigration.test.ts` pins the full list to the board and the full-list planning rollup.

**Done-when.** 1 ✓ (no metric changes; the tooltip says so). 2 ✓. 3 ✓ (the render test asserts the parent of hidden children stays a phase — leaf-ness from the unfiltered set).

**Scope / residual.** None.

---

## SCH-7 · The batch-move RPC has no optimistic lock, and the live-sync meant to cover it was never switched on

- **Severity:** CRITICAL
- **Status:** RESOLVED
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

**Partial (2026-09-29, projects Round G — J6a landed the RPC and library half; the finding is P6b's).** `supabase/migrations/20261098_prj_roundG_apply_milestone_moves.sql` re-creates `apply_milestone_moves` with the optimistic lock (`expected_updated_at` in the `WHERE`), a true `ROW_COUNT`, and `{ count, matched, unmatched }` returned (see PC `SCHED-4` / `SCHED-11`). `lib/milestones.ts` `applyMilestoneMoves` sends each move's expected `updated_at` (the caller's, else the row as read just before the call) and — because `components/projects/ScheduleTab.tsx`'s `onMoveMany` applies the dates optimistically and reads only success / failure — a rejected move THROWS `MoveConflictError` by default (after the moved rows' breadcrumbs and audit row are written): `N tasks were changed by someone else and were not moved (the other K moved). Reload the schedule and try again.` ScheduleTab's existing `catch` shows that message and calls `refresh()`, so the board no longer shows dates that were never saved. A caller that renders `unmatched` itself passes `onUnmatched: "return"`. Test: `scheduleImportWriters.test.ts` "by default a rejected move is an ERROR, never a silent success".

**Done-when (so far).** 1 partly: a move that loses the race between the pre-read and the write is rejected and reported, but `ScheduleTab.tsx` does not pass the loaded milestone's `updatedAt`, so a stale VIEW (a row another user edited minutes ago) still wins — P6b: pass `expectedUpdatedAt: m.updatedAt` per move, render `unmatched` by name, and switch to `onUnmatched: "return"`. 2 ✓ (the RPC's count is `ROW_COUNT`). 3 not done: the realtime publication / comment is P6b's.

**Scope / residual.** `ScheduleTab.tsx` and the realtime subscription are P6b surfaces; nothing in them was changed here.

**Resolution (2026-09-30, projects Round G — completes J6a's partial above).** Client: `components/projects/ScheduleTab.tsx` `onMoveMany` sends each row's `updated_at` as this view loaded it (a ref over the loaded rows) — or, for an Undo, the value the move being undone reported (`SCH-18`) — and passes `onUnmatched: "return"`: rejected moves are NAMED ("2 tasks were changed by someone else and were not moved: A, B (the other 3 moved). The schedule has been reloaded — check those dates and try again.") and the board reloads. After a move that saved, the rows' new `updated_at` (read back by `applyMilestoneMoves`, `result.updatedAt`) replace the loaded values, so the next drag of the same row is not falsely rejected; when the read-back fails the tab reloads instead. Realtime: migration `20261106_prj_roundG_milestones_realtime.sql` adds `milestones` to `supabase_realtime` — idempotent, a no-op when the publication is absent, with a DEC-30 inventory captured before the transaction recording whether the table was already published by hand (the finding's caveat) and whether the publication exists; no REPLICA IDENTITY change (INSERT / UPDATE carry the new row; under RLS a DELETE carries only the key whatever the identity). The subscription listens to INSERT and UPDATE filtered on `project_id` (DELETE is not subscribed — see the review fix below); the comment says the channel needs `20261106` and that the lock is what stops a silent overwrite either way. Checked on PostgreSQL 16 (a throwaway cluster, a stub `milestones` with RLS): with `supabase_realtime` present the script adds the table and every probe reads `t`; a second run is a no-op and its inventory reads 1 ("already published"); with no publication nothing changes and the probe reads `f`. Tests: `scheduleEngineMigration.test.ts` (the one-script shape, the idempotent add and nothing else, aggregate inventory, the RLS probe; ScheduleTab's lock value, `onUnmatched: "return"`, the named rejection, the `updated_at` refresh, the listeners); `scheduleEngineWriters.test.ts` "SCH-18 / SCH-7 ·" (the read-back).

*Review fix pass (2026-09-30).* (a) **No half-applied batch from a stale view.** Sending the loaded `updated_at` made the lock reject any row a colleague had edited — and `apply_milestone_moves` moves the matched rows and skips the rest, so a drag whose cascade touched one such row left the dragged task and part of its cascade moved and the rest in place, with no Undo (the board treated it as failed). `lib/milestones.ts` `applyMilestoneMoves` now compares each move's lock with the row as it reads it just before the write: a row already changed or gone refuses the WHOLE batch before the RPC — `refused`, `unmatched` naming them, nothing written (no breadcrumb, no audit row); by default it throws "N tasks were changed or removed by someone else since the schedule loaded — nothing was moved." The read now fails closed whenever it fails (it also feeds the imported-row check, `SCH-13`). A row changed in the instant between that read and the write is still skipped by the RPC's lock: `ScheduleTab` then hands back the rows that DID move with their read-back locks (`MoveOutcome.matched` / `updatedAt`), and `ExecutionView.persistBatch` announces "Only N of M tasks moved (the rest were changed by someone else) — Undo puts those back" with an Undo that restores exactly those rows under those locks. (b) **Realtime DELETE.** Supabase does not apply RLS to DELETE events, so the board's unfiltered DELETE listener would have received the id of every milestone deleted in every workspace, and `20261106`'s header ("RLS still gates delivery … NOT widening") was wrong. The board no longer subscribes to DELETE (a colleague's delete shows on the next reload — at once when the row had sub-tasks or dependents, because `deleteMilestone` updates them); the migration header and its RLS probe label now state the id-only widening publishing the table implies for any DELETE subscriber, accepted as naming nothing. Tests: `scheduleEngineWriters.test.ts` "SCH-7 ·" (a stale row refuses the batch whole, the RPC is never called and nothing is written; the default throw says nothing was moved; the same instant written differently is not stale, a row that is gone is); `scheduleImportWriters.test.ts` (J6a's fixtures: a caller's lock that matches the read; a failed read refuses with or without lock values); `scheduleEngineUi.test.ts` "SCH-7 / SCH-18 ·" (a partly written sequence: the toast names it and its Undo restores that row alone with its lock; a batch that moved nothing offers no Undo); `scheduleEngineMigration.test.ts` (no DELETE listener; the header states the widening; a partial outcome carries the moved ids, their locks and the reason). `20261106` re-applied twice on a throwaway PostgreSQL 16 cluster after the header / label change: added, then a no-op with inventory 1.

*Second review fix pass (2026-09-30) — corrected: the named rejection never reached the screen.* The records above said rejected moves "are NAMED … and the board reloads". They were named and then wiped: every `ScheduleTab` handler set its message and then reloaded, and `refresh()` began with `setError(null)` — synchronously, before its first await — so the "changed by someone else … not moved" message, the catch path's message, "Moved, but …" (when the new locks could not be read back), the re-baseline refusal and the Planning list's delete error (`SCH-17`) all vanished in the same tick, and once `20261106` is applied every realtime UPDATE would clear whatever was showing. A batch refused whole also got no toast on the board (`ExecutionView.persistBatch` announced only a success or a partial write), so the bar snapped back with no word at all. Fixed in `components/projects/ScheduleTab.tsx`: a reload never clears an ACTION's message — the next action (a move, a status or progress change, a delete, a baseline) or the banner's new Dismiss button does; a failed LOAD is its own message (`loadError`), cleared by the next load that works; the banner is `role="alert"` and shows both. `components/projects/ExecutionView.tsx` `persistBatch`: a batch refused whole says so on the board — "Not moved: Weld was changed by someone else — nothing was moved" (or "Nothing was moved." with no reason). Tests: `lib/__tests__/scheduleTabMessages.test.ts` (new, rendered ScheduleTab with the writers stubbed and the board's `onMoveMany` captured): a stale view refused whole — the board reloads AND the named message is in the DOM; a realtime reload does not clear it, Dismiss does, the next successful move leaves no banner; "Moved, but …" survives its reload; a failed load shows beside it and clears on the next good load without clearing the action's message; the Planning list's delete refusal is on screen after its reload — all five fail against the previous `ScheduleTab` and pass now. `scheduleEngineUi.test.ts` "SCH-7 / SCH-18 ·": a batch that moved nothing shows "Not moved: …" and no Undo; no reason reads "Nothing was moved."

**Done-when.** 1 ✓ (a move from a stale view is rejected by the lock and named — on screen, after the reload). 2 ✓ (J6a: `ROW_COUNT`). 3 ✓ (the table is published once `20261106` is applied; the comment says so).

**Scope / residual.** Pending migration: `supabase/migrations/20261106_prj_roundG_milestones_realtime.sql` (and J6a's `20261098` for the lock). Until `20261106` is applied no event arrives; the lock still refuses the stale write. Once applied, any DELETE subscriber receives deleted milestone ids across workspaces (id only — Supabase's DELETE semantics). The all-or-nothing check runs in the client just before the write; a colleague's save in the instant between it and the RPC still leaves a partial batch (with an Undo) — an all-or-nothing mode inside the RPC was not built (the reserved `20261107` went to `SCH-17`'s all-or-nothing delete).

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

**Resolution (2026-09-29, projects Round G — parser half; the reflow's use of lag is P6b's / PC-4's).** Every relationship is captured with its type and lag and only finish-to-start becomes a `depends_on` edge. `lib/scheduleParsers.ts`: `ParsedLink { predecessorExternalRef, type: FS | SS | FF | SF, lagHours }` on each row (`links`), read from MS Project XML `<PredecessorLink><Type>` (0 = FF, 1 = FS, 2 = SF, 3 = SS) and `<LinkLag>` (tenths of a minute), P6 XML `<Relationship><Type>` ("Start to Start" …) and `<Lag>` (hours), XER `TASKPRED.pred_type` (`PR_FS` …) and `lag_hr_cnt`, and CSV tokens (`2SS+1d`, `3FF`, `2FS+2h`). `splitLinks` puts FS into `dependsOnExternalRefs`, counts the rest as not enforced, and serialises everything the engine does not carry onto the task as `attributes.source_links` (`"SS msp-uid:1 +8h; FF msp-uid:3"`) so it is stored and visible. The result's `links` census (`fs / notEnforced / withLag / unresolved`) drives two warnings: `N start-to-start / finish-to-finish / start-to-finish links captured but not enforced — the schedule engine honours finish-to-start only …` and `N finish-to-start links carry lag; the lag is recorded on the task but not applied by the reflow.` A CSV token whose id and type read but whose lag unit does not (`1FS+3 mons`, `1SS+50%`) keeps the link — FS still becomes the edge — with `lagRaw` recorded on `source_links` (`FS msp:1 +3 mons (lag not understood)`) and counted in its own `lagUnread` bucket with its own warning, never as "pointed at a row that is not in this file"; `+2 weeks` reads as 80 h, and MS Project's estimated-duration marker (`1FS+1 day?`) reads as 8 h rather than as an unreadable lag (`scheduleParsers.test.ts` "an estimated lag …"). Tests: `scheduleParsers.test.ts` "SCH-8 ·" (CSV tokens; an unreadable lag keeps the link and is counted apart from unresolved rows; XER `PR_SS` + `PR_FF` pair between two activities creates no edge) and `scheduleParsersXml.test.ts` "SCH-8 ·" / "P6 XML ·" (MSPDI Type + LinkLag; a P6 SS + FF ladder creates NO edge in either direction — no cycle — and is recorded with its lag).

**Done-when.** 1 ✓ (recorded, reported with a count, never flattened). 2 ✓ (the SS + FF fixture yields no `dependsOn` on either activity).

**Scope / residual.** Option (b) of the remediation, made honest: non-FS links are stored on the task rather than dropped, so the engine half (PC-4 / P6b honouring lag and, after its own test, SS/FF) can read them back without a re-import. FS lag is recorded but not applied until that lands.

**Engine half landed (2026-09-30, projects Round G — J6b).** The reflow now applies each finish-to-start link's recorded lag: `lib/scheduleReflow.ts` `fsLagHours` reads `FS <ref> ±Nh` from `attributes.source_links`, `reflowNodesFromMilestones` maps it to the predecessor's id, and `cascadeDependents` / `computeCriticalPath` honour it (projects-and-cost `SCHED-13`). **Unit rule:** the stored hours are WORKING hours — the importer's unit (`durationTextToHours`: "1d" = 8 h, "1w" = 40 h; MS Project `LinkLag` / 600; P6 `lag_hr_cnt`) — and `afterLagMs` applies them as working days, Monday to Friday (8 h a day, hours under a day as clock hours), so "+5d" is five working days. The first version of this code added them as elapsed hours, cutting a "+5d" lag to 1⅔ calendar days with no warning (review fix pass). Residuals: no project calendar (holidays; a push may land on a weekend); an elapsed-unit lag ("+1ed", stored as +24 h) is stored in the same form and so read as working time — telling them apart needs the parser to record the unit (J6a's file). The parser's heads-up "the lag is recorded on the task but not applied by the reflow" (`lib/scheduleParsers.ts` `linkWarnings`) is therefore out of date; that file is J6a's and was not edited here — the one-string change is left for the integrator. SS / FF / SF links are still recorded and not enforced (`DEC-51` (5)).

---

## SCH-9 · The cycle guard is defeated by the imported-rows toggle

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-09-30, projects Round G).** The cycle check always reasons over every milestone. `ExecutionView` hands `TaskDetailPanel` the full list (the display filter only changes the rows drawn — `SCH-6`); the dependency picker drops every task in `dependentsClosure(fullNodes, task)` — one O(n + e) walk instead of a DFS per candidate (`PERF-5`). Below the UI, `updateMilestone` checks each link a new `depends_on` ADDS against EVERY row of the project read from the database (paged past PostgREST's 1,000-row cap) — a link already stored is not re-judged, so a task inside a loop an old import left can still have an unrelated link removed (review fix pass: re-validating every link refused exactly that) — and refuses with the loop named: `DependencyCycleError` — "That link would make a loop: Fit-up → Weld (imported) → NDE → Fit-up. …". A link to a row the display filter hides reads "Weld (hidden by filter)"; a link to an id that no longer exists reads "(deleted task)" — "(removed task)" is gone. Tests: `dependencies.test.ts` "SCH-9 ·" (`dependentsClosure` agrees with `wouldCreateCycle` for every candidate; `linkCyclePath` names the loop through the hidden middle row; the filtered node list IS the defect); `scheduleEngineUi.test.ts` "SCH-9 ·" (the labels; NDE is not offered as Fit-up's predecessor through the hidden Weld); `scheduleEngineWriters.test.ts` "SCH-9 ·" (the loop through an imported middle row refused from the database; on a 2,500-row project the loop through row 2,400 is still caught; with A ↔ B stored, removing A's link to C saves while adding a link that closes a new loop is still refused).

**Done-when.** 1 ✓. 2 ✓.

**Scope / residual.** None.

---

## SCH-10 · Rebase lands the schedule on the wrong day for every negative-offset timezone

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-09-30, projects Round G).** `components/projects/RebaseScheduleModal.tsx`: the target instant is built as wall-clock-as-UTC — `rebaseTargetIso(date, time)` → `fromWallClock` (`${date}T${time}:00.000Z`, an impossible date refused) — the time is pre-filled from the anchor's UTC clock (`rebasePrefill` → `toWallClock`; a midnight-UTC anchor pre-fills 00:00, not "17:00" in Los Angeles), and the preview renders both ends in UTC ("schedule time"), like the board. The same local-parse mistake in `TaskDetailPanel`'s edit form (a `datetime-local` filled from `getHours()` and saved through a local parse, so a US user saw and saved the wrong day) uses the same helpers, and a date is written only when the user changed it. The helpers live in `lib/scheduleReflow.ts` with `SCH-12`'s. Tests: `scheduleEngineUi.test.ts` "SCH-10 ·" in America/Los_Angeles, UTC and Asia/Tokyo — the midnight anchor pre-fills 00:00, 1 September at 00:00 is `2026-09-01T00:00:00.000Z` and at 08:00 `2026-09-01T08:00:00.000Z`, 30 February is refused — and a source pin that the modal no longer reads local hours or parses locally and renders its preview with `timeZone: "UTC"`.

**Done-when.** 1 ✓ (three zones). 2 ✓ (both render in UTC). 3 ✓.

**Scope / residual.** The default target DATE is still the viewer's calendar "today" (their intent); only the instant built from it changed. `rebaseSchedule` is unchanged (Verified sound).

---

## SCH-11 · Resizing a summary snaps every child to UTC midnight, moving tasks by a day

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-09-30, projects Round G).** Reproduced against `fdb51b1` exactly as measured. `lib/scheduleReflow.ts` `computeSummaryResize` rounds each leaf's MOVE to whole days (`orig + round((scaled − orig) / day) × day`) instead of rounding the instant to UTC midnight; a pair that rounding would cross keeps the leaf's own span. Tests: `scheduleReflow.test.ts` "SCH-11 ·" — the 08:00 / 17:00 fixture resized +1 day on the finish edge: the phase ends exactly one day later (`06-06T17:00`), L2's finish moves one day and stays 17:00, its start does not move, L1 does not move, every clock time is kept; the start-edge mirror; date-only children unchanged.

**Done-when.** 1 ✓, read as the resize the user made: the phase moves exactly one day and no child moves more than one day. The stretch is proportional from the fixed edge (the module's documented rule), so the child at the moving edge moves exactly one day and a child near the fixed edge may move none; nothing moves two (the measured defect). 2 ✓.

**Scope / residual.** None.

---

## SCH-12 · Setting a duration does local-calendar arithmetic on UTC dates, so a task gains a day across DST

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-30, projects Round G).** `lib/milestones.ts` `setTaskDuration` computes the start with `startForDuration(finish, days)` — `finish − (days − 1) × 24 h` in UTC — instead of `setDate(getDate() − …)` on a local calendar; `addUtcDays` / `startForDuration` in `lib/scheduleReflow.ts` are the shared helpers (`SCH-10` uses their wall-clock siblings). Tests: `scheduleReflow.test.ts` "SCH-12 ·" in America/Los_Angeles, UTC, Asia/Tokyo and Pacific/Auckland at both DST boundaries (a 3-day task ending 2 Nov starts 31 Oct; ending 10 Mar starts 8 Mar); `scheduleEngineWriters.test.ts` "SCH-12 ·" runs `setTaskDuration` itself in Los Angeles and Auckland (`2026-10-31T00:00:00.000Z`).

**Done-when.** 1 ✓. 2 ✓.

**Scope / residual.** None.

---

## SCH-13 · "Read-only imported rows" are fully editable

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-30, projects Round G — decision `DEC-44`, J6b's, renumbered at merge).** "Read-only imported rows" now means exactly: an imported row's dates, place in the outline, links and planned fields belong to the scheduling tool — the next import writes them back (`DEC-51`) — so they are locked; its status, % complete, actual dates and who actually did the work are recorded here and survive a re-import. Enforced below the UI in `lib/milestones.ts`: `updateMilestone` refuses a CHANGED import-owned field (name, description, weight, start, finish, shift, work order, planned responsible, location, work hours, source columns, links) on an imported row with `ImportedRowLockedError` ("“Hydrotest” comes from Primavera P6: its finish is set there and the next import writes it back — change it in the scheduling tool and re-import. …"), drops unchanged ones an edit form resends, and lets app-owned fields through; `applyMilestoneMoves` refuses a batch that touches an imported row (nothing is moved), and refuses any batch whose pre-read failed (the check needs it); `setTaskDuration` and `groupTasksUnderParent` refuse before any write. The engine treats imported rows as locked (`reflowNodesFromMilestones`), so a drag of a manual predecessor holds an imported successor in place and the sheet names it — and NO engine ever writes a locked row, parent or leaf: an imported summary (like a parent with an actual) keeps its stored dates in every re-envelope (`lib/scheduleReflow.ts` `reenvelopeParents`, `changesFrom`; `computeTreeMove`, `planCascade`, `sequenceSiblings`, `computeSummaryResize`, `computeEdgeResize`, `reflowAllAncestors`), and `setTaskDuration`'s ancestor pass maps `source` / `status` / `actual_at` so it never writes one either. *Review fix pass:* the first version locked imported LEAVES but still re-enveloped imported PARENTS — every parent in the tree on every drag — so a project holding an MS Project summary whose stored span differs from its children's (or a manual task under an imported phase moved past its finish, a row left "not in this file" under its old phase, or a >1,000-row project read short) had EVERY drag, resize and sequence refused whole ("1 of these tasks comes from MS Project … nothing was moved"), all of which worked at `fdb51b1`; `setTaskDuration` wrote imported summaries' dates directly; and the batch check failed open on a read error. Grouping tasks UNDER an imported phase is now refused too (and it is not offered in the picker): the phase keeps the tool's dates whatever its sub-tasks do, so it would not follow them. UI: no drag / nudge / resize handles on an imported bar (its tooltip says why), no "Set duration" on an imported row, the detail panel's Move section, dependency editor and plan fields are read-only with a note, and a drag or arrow key on one says why. Delete stays available (removal is its own explicit action, `DEC-51`); its confirm says the next import of a file that still carries the row adds it back. `rebaseSchedule` (Verified sound, unchanged) still shifts the whole schedule including imported rows; the tooltip says so. HelpTooltip rewritten to say exactly this. Tests: `scheduleEngineWriters.test.ts` "SCH-13 ·" (a changed date refused with nothing written; an unchanged resend plus a performer change saves only the performer; a manual row edits as before; a batch touching an imported row is refused before the RPC; duration and grouping refused before any write; end to end through the board's engine: an unrelated manual drag beside a mismatched MS Project summary, and a manual task under an imported phase moved past its finish, are both WRITTEN with only the manual row sent; `setTaskDuration` under an imported phase writes the task alone; grouping under an imported phase refused before any write); `scheduleReflowLocks.test.ts` "SCH-13 ·" (the reviewer's probe returns `[m]`, not `[IP, m]`; tree move, edge resize, cascade, sequence and summary resize never emit the imported parent; `reflowAllAncestors` keeps an imported parent and a parent with an actual while a manual one follows; a manual phase envelopes an imported child phase's stored dates); `scheduleImportWriters.test.ts` (a failed pre-read refuses the batch); `scheduleEngineUi.test.ts` "SCH-13 ·" (only the manual bar carries the grab handle; the imported bar's tooltip names the tool; an imported phase is not offered to group under).

**Done-when.** 1 ✓ (the tooltip states the rule the code enforces). 2 ✓ (`lib/milestones.ts`, below every UI path).

**Scope / residual.** The lock is in the library, not the database: a direct PostgREST write with a member's session can still change an imported row's plan (the importer's own writes are client upserts, so a trigger could not tell them apart). Rebase is the documented exception. A manual task already sitting under an imported phase (grouped before this) moves freely, but the phase bar keeps the tool's dates and does not follow it. A project past `listMilestones`' row cap still gives the board a short list — its manual parents may re-envelope over missing children (not this finding; the read bound belongs with `DEC-47`'s verification note).

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

**Resolution (2026-09-29, projects Round G).** Caps: `SCHEDULE_IMPORT_LIMITS = { maxBytes: 5 MB, maxRows: 5,000 }` (`lib/scheduleParsers.ts`). The modal refuses a larger file BEFORE decoding it, naming the size and the limit; the importer refuses more rows than the cap with the count and the limit named and writes nothing (the modal disables the buttons and says so too). Round trips: `importMilestonesFromParsed` reads the existing rows ONCE (paged at PostgREST's 1,000), inserts new rows in chunks of 200, updates changed rows in chunks of 200 as an upsert by primary key (the existing row's provenance travels with it), with ONE key set per request — rows that write status / percent / actual dates and rows whose progress is protected (or that carry no %) go in separate requests, because a bulk write sends the union of its rows' keys with NULL for a missing one and `status` is NOT NULL (a mixed chunk would fail and drop to per-row writes) — never writes an unchanged row (a row adopted from a position key is the one exception, written once to carry its new key — SCH-3), and wires structure in batches of 25 concurrent updates only for rows whose parent / predecessors changed. Older databases degrade instead of failing, one migration's columns at a time (`SCHEMA_SETS`: `20260703` hierarchy, `20260705` rich columns, `20260715` links, `20260731` percent, `20261097` batch tag): the existing-row read drops the set whose column a refusal names and restarts (`fetchExistingImportRows`), and the sets it finds missing decide the writes up front — without `20260715` the hierarchy is written and the links are not, without `20260705` the rich columns are dropped and the hierarchy kept, without `20260731` percent is dropped and status still carries progress, without `20260703` the hierarchy columns are not compared or written and the structure pass is skipped — each with a heads-up naming ITS migration when the file carried data for it; a schema error on a write chunk drops the set its column belongs to (`import_batch_id` alone for `20261097`) and retries (verification fix below); any other chunk error isolates the bad rows one at a time so one unreadable row does not sink two hundred. Progress + cancel: `onProgress({ done, total, phase })` and an `AbortSignal`; the modal shows a bar with a Cancel button; a cancelled import stops between chunks, returns `cancelled: true` and `Import cancelled after N of M rows. Rows written so far are tagged with batch <id>.` Every row an import inserts or updates carries `import_batch_id` (migration `20261097`), so the partial state is visible and reversible, and re-importing the same file completes it (the merge is idempotent). Tests: `scheduleImportWriters.test.ts` "SCH-14 ·" — 5,001 rows refused with the limit named and nothing written; 1,000 new rows land in exactly 5 inserts with progress `[0, 200, …, 1000]` and every row tagged; cancel at 200 of 450 stops with 200 rows written and the message naming the batch; a bad row inside a chunk is isolated per row; a database without `20261097` drops `import_batch_id` alone and keeps the hierarchy fields; a mid-job re-import mixing protected rows and rows taking the file's progress stays chunked (200 + 50 + 150, one key set per request, no per-row fallback) and new rows with and without a % value insert in separate requests — under the PostgREST-shaped mock (union-of-keys NULLs, NOT NULL). "SCH-14 / SCH-16 · an older database" — with the `depends_on` read refused the rows land, the parent is wired, no link is written, the heads-up names `20260715`, and a re-import counts no link it cannot write; on a pre-hierarchy database the rows land with the legacy columns only, the `20260731` and `20260703` heads-ups are shown, and an identical re-import writes nothing; without only `20260705` or only `20260731` the hierarchy is kept and the heads-up names that migration; any other read failure stops before a write.

**Done-when.** 1 ✓ (5,000 changed rows = at most 28 chunked requests — ⌈5,000 / 200⌉ = 25, plus up to 3 more because the rows can split into four key-set groups (inserts with and without a %, upserts with and without actuals), each ending in a partial chunk — plus the structure pass; unchanged rows are not written; more than 5,000 is refused with the limit named). 2 ✓ (bar + Cancel). 3 ✓ as "recoverable": PostgREST has no client transaction, so a closed tab still leaves rows behind — but they are tagged with the batch id and the next import of the same file finishes the merge; nothing is half-written within a row.

**Verification fix (2026-09-30, projects Round G).** A database missing only `20260705` or only `20260731` used to fall to the legacy tier — dropping the hierarchy it has — and the heads-up blamed `20260703`. The read tiers (full / no links / legacy) are replaced by one column set per migration (`SCHEMA_SETS` in `lib/milestones.ts`): a refusal names its column (`column milestones.x does not exist`, `column "x" of relation … does not exist`, or PostgREST's `Could not find the 'x' column`), only that migration's set is dropped from the read, the comparison and the writes, and the read restarts; a refusal that names no column steps down one set at a time, newest first, and one that names a column of no set drops nothing (the error surfaces). The write path does the same per chunk. Heads-ups: `20260705` (work orders, responsible parties, locations, work hours and extra columns dropped) and `20260731` (percentages not stored; status stored) are new and are shown only when the file carried such data; `20260703` and `20260715` keep their wording. Tests: `scheduleImportWriters.test.ts` "SCH-14 / SCH-16 · an older database …", against a mock that refuses the way PostgREST does (naming the first missing column, `lackColumns`): without only `20260705` — parent, outline level, start and shift land, no rich column is written, the one heads-up names `20260705`, an identical re-import is Unchanged 2 with no write; without only `20260731` — status `in_progress` lands without `percent_complete`, the hierarchy is kept, the one heads-up names `20260731`, and a re-import still reports the crew's status as at risk and writes nothing; a pre-hierarchy database shows the `20260731` and `20260703` heads-ups (all three fail against the previous importer).

**Scope / residual.** The structure pass is chunked but still per-row (25 in flight); folding parent / predecessor ids into the chunked upsert would need a second full write of every row, which costs more than it saves. Passes 2 and 3 are one pass now.

---

## SCH-15 · The critical path ignores the real dependency edges

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-30, projects Round G).** Closed with projects-and-cost `SCHED-10`, which subsumes it: `lib/criticalPath.ts` `computeCriticalPath` derives the path from the stored finish-to-start links (a backward pass giving each leaf's total float, lag honoured as working time — `afterLagMs`, `SCHED-13` — and the chain of driving links traced back from the finish); the date-contiguity heuristic is retired. The timeline's button and legend and the Report say what it is ("the chain of finish-to-start links that drives the finish date — calendar days, no working calendar"), and a schedule with no links says only the finishing tasks are shown. Tests: `criticalPath.test.ts`.

*Second review fix pass (2026-09-30).* The driving-link and float checks measured calendar days, so on a Monday-to-Friday schedule every Friday → Monday hand-off read as two days of float and broke the chain: a weekly FS chain W1 → W2 → W3 highlighted only W3 (the retired heuristic had given all three), and an MS Project order → install chain only its last week. Gaps and float are now measured in WORKING time (Monday to Friday, `workingTimeMs` / `workingGapMs` in `lib/scheduleReflow.ts`), the calendar lag already ran on; float is reported in working days; and a finished leaf (completed or with an actual) no longer sets the finish the path is traced from, so a completed task still carrying the latest planned date no longer empties the path and hides the button. The captions now read "working days Mon–Fri, no holidays". Details and tests under projects-and-cost `SCHED-10`.

**Done-when.** 1 ✓ (derived from the dependency graph).

**Scope / residual.** See `SCHED-10`: working days Monday to Friday, no project calendar (holidays).

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

**Resolution (2026-09-29, projects Round G).** For every row the file carries, the importer sets `parent_id` and `depends_on` to exactly what the file says — `NULL` / `[]` when it says none — and skips the write when nothing changed; the review plan counts what this pass will do (`ImportPlan.structure`: rows, parents changed, links added / removed — a link added in the app to an imported row is removed if the file does not carry it) and the modal shows it and counts structure-only rows in "Import N changes"; rows the file does not mention are not touched (`lib/milestones.ts` `importMilestonesFromParsed`, structure pass; a database without `20260715` — detected by the existing-row read (per-migration since SCH-14's verification fix) — keeps the hierarchy write, drops the links, does not count them in the plan, and says so with a heads-up naming the migration). Test: `scheduleImportWriters.test.ts` "SCH-16 ·" — a predecessor removed upstream is cleared locally (`depends_on: []`), an un-parented task gets `parent_id: null`, the untouched sibling keeps its parent, and exactly one structure write is issued; "SCH-14 / SCH-16 · an older database" covers the no-`depends_on` tier.

**Done-when.** 1 ✓. 2 ✓.

**Scope / residual.** None beyond the finding: removal of rows stays a separate explicit action (GAP-403), so a task that disappears from the file keeps its structure.

**Verification fix (2026-09-30, projects Round G).** Wording only: a missing `20260715` is now detected by the existing-row read's per-migration step-down (SCH-14's verification fix) rather than a read tier; this finding's behaviour is unchanged and "SCH-16 ·" and the no-`depends_on` test still pass.

---

## SCH-17 · Deleting a phase silently orphans its entire subtree

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-30, projects Round G).** `lib/milestones.ts` `deleteMilestone` no longer orphans: it reads the row's direct children and every row whose `depends_on` names it, moves the children up to the row's own parent (the top level when it has none) in one checked update, removes the id from each dependent's links (checked, per row), then deletes — a refused step stops the delete and says what already happened — and the `MILESTONE_DELETED` audit row records the prior structure: the prior parent, where the children went, each promoted child, each dependent's links before, and the row's own dates and links. Returns `{ reparented, unlinked }`. `planMilestoneDelete(list, id)` (pure) gives the confirm its numbers: `ScheduleTab` and `TaskDetailPanel` now say "Delete “Phase 1”? … Its 2 sub-tasks (3 tasks in all) will move up to “Unit 200” — none is deleted. 1 task that depends on it will lose that link." (and, for an imported row, that the next import adds it back). A database without the hierarchy or links columns deletes as before. Tests: `scheduleEngineWriters.test.ts` "SCH-17 ·" (the plan; children promoted to the phase's parent, grandchildren keep theirs, the link removed so no dangling id, the audit row's prior structure; a refused re-parent leaves the phase in place and deletes nothing).

*Second review fix pass (2026-09-30) — corrected: the delete was not checked.* The paragraph above said "each step a CHECKED write" and "the phase itself is never deleted with its children still pointing at it". The final `DELETE` was NOT checked: it destructured `error` only. `milestones` UPDATEs pass the permissive `milestones_member_all` (any active member) while DELETE sits behind the RESTRICTIVE `milestones_delete_guard` (20260818: Admin / Manager, the row's creator, or someone who can manage the project), and a DELETE that policy filters matches 0 rows with no error. So a Supervisor or DocCtrl who is not the creator and not on the project roster (the board offers them Delete — `ScheduleTab`'s `canEdit` is by headline role) moved the phase's children out, stripped every dependent's link, "deleted" nothing, and a `MILESTONE_DELETED` audit row was written for a row still there — worse than the `fdb51b1` silent no-op. Reproduced on a throwaway PostgreSQL 16 cluster with the real policies: `UPDATE 2`, `UPDATE 1`, `DELETE 0`, phase present and empty. Fixed: **`supabase/migrations/20261107_prj_roundG_milestone_delete.sql`** adds `delete_milestone_keep_subtree(p_id uuid)` — plpgsql, **SECURITY INVOKER** (row-level security still applies to every step, so the delete guard still decides), `search_path` pinned, EXECUTE revoked from PUBLIC / anon and granted to authenticated / service_role — which promotes the children, removes the link from every dependent in the project (the org for a row with no project), keeping the other links' order, and deletes the row in ONE transaction; `GET DIAGNOSTICS` on the DELETE must say 1, and 0 RAISEs 42501 "You cannot delete this task — nothing was changed", rolling the re-parent and the unlink back. It returns the children moved and each dependent's links before (the audit row's prior structure), or `{ deleted: false }` for a row the caller cannot see. One script: DEC-30 inventory TEMP table before BEGIN (was it already defined; dependency links naming a milestone that no longer exists; the delete-guard policy count), BEGIN … COMMIT, one final `(check, ok, n)` SELECT (exists, invoker, pinned, the checked delete in `prosrc`, anon refused, authenticated granted, the guard still RESTRICTIVE FOR DELETE). NOT widening. `lib/milestones.ts` `deleteMilestone` calls it first; any error other than "not deployed" (`PGRST202` / `42883` — a permission error naming the function is a refusal) means nothing changed, and a 42501 throws `MilestoneDeleteRefusedError` — "“Phase 1” was not deleted — you do not have the right to delete it (Admin or Manager, its creator, or someone who manages this project may), or it is already gone. Nothing was changed." Without `20261107` the same steps run client-side in the CHECKED order: the DELETE first with the deleted row read back (`.delete().eq("id", id).select("id")`; none back → the same refusal, nothing written), then — the foreign key's `ON DELETE SET NULL` having detached them — the children are moved under the parent by id list (read back and counted), then the links; a step that fails after the delete is named with what already happened ("“Phase 1” was deleted, but its 2 sub-tasks could not be moved up a level (…) — they are at the top level now"), and the audit row (written only once the row is gone) lists it under `incomplete`. Evidence on the throwaway PG16 cluster (fixture: the real `milestones_member_all`, `milestones_delete_guard`, `is_org_admin_or_manager`, newest `can_manage_project`, the 20261099 baseline rail): the migration applied (all probes t, inventory 0) and re-applied (inventory 1); as the Supervisor the function raised and every row, parent and link was unchanged — inside a transaction and as one autocommit call; as the creator it promoted Step 1 / Step 2 to Unit 200, kept Sub-step under Step 2, left Handover `[Step 1, Step 2]` (order kept); a second call returned `deleted: false`; anon was refused EXECUTE; the fallback's `DELETE … RETURNING id` as the Supervisor returned no row. Tests: `scheduleEngineWriters.test.ts` "SCH-17 ·" (through the RPC: called with `p_id`, the audit row from its report, no client write; a 42501 refusal — nothing written, no audit row; a permission error naming the function is a refusal, not a fallback; already gone; no answer is an error. Without it: the delete is the FIRST write; **a delete RLS filters to 0 rows leaves the children under the phase, the link in place, no UPDATE and no `MILESTONE_DELETED` row**; a top-level phase's children stay top-level with no re-parent write; a re-parent failing after the delete is named and recorded as incomplete); `scheduleEngineMigration.test.ts` "20261107 ·" (one-script shape, aggregate inventory, invoker / pinned / REVOKE–GRANT, promote → unlink → DELETE with the 0-row RAISE and no swallowing handler, the probes, the client's RPC-first and delete-first order); `scheduleTabMessages.test.ts` (rendered: the Planning list's delete refusal is on screen after the reload — it was wiped by it, `SCH-7`).

**Done-when.** 1 ✓. 2 ✓ (recorded only for a delete that happened — through the RPC's report, or the fallback's pre-write snapshot). 3 ✓ (the links go in the same transaction as the delete; on the fallback path only after the delete succeeded, and a link that could not be removed is named).

**Scope / residual.** The brief's default was taken: promote, not cascade-delete (no "delete the phase and its N tasks" choice was added). Pending migration `20261107`: until it is applied the fallback runs — a refused delete changes nothing, but a failure AFTER a successful delete (re-parent or a link) leaves that part undone and says so, where the RPC would have rolled it back. The Delete button is still offered by headline role (`ScheduleTab`'s `canEdit`, `ADMIN_ROLES`), wider than the delete guard; the refusal now says why and changes nothing — aligning the button with the guard is not done here (it would need the project roster on the client).

---

## SCH-18 · A failed Undo reports success

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-30, projects Round G).** The handlers still report a refusal as `false`; the undo closures in `ExecutionView` now inspect it and THROW (status, progress, bulk status — naming how many could not be set back — and every batch move, whose handler reloads the schedule on a refusal, replacing the optimistic dates). *Review fix pass:* a batch move's Undo now throws the handler's own reason (`MoveOutcome.error` — "Weld was changed by someone else …", "permission denied …", an imported-row refusal) instead of reading every failure as "the schedule changed since that move"; this record's earlier "which also clears the optimistic overlay" described the handler's reload, not the closure. A batch the lock only partly wrote gets an Undo for the rows that moved (`SCH-7`). `components/projects/useUndoableActions.ts` `runUndo` keeps the toast until the undo has actually worked: a throw turns the SAME toast into "Couldn't undo: … — <what it was>" with its Undo button kept as a retry (15 s), a retry that works dismisses it, and a second click while one runs is ignored. Version check (the remediation's `SCH-7a` item): an Undo of a batch move sends the `updated_at` values the move reported (`applyMilestoneMoves` reads them back), so it is refused — and says so — if someone changed those rows in between, instead of blindly writing the old dates over them. Timers: a toast dropped off the top of the three takes its timer with it, and every timer is cleared on unmount, so the map only ever holds the toasts on screen. Tests: `scheduleEngineUi.test.ts` "SCH-18 ·" (a throwing undo keeps its toast as "Couldn't undo: the schedule changed since that move — Moved “Weld”" with Undo still there; the retry succeeds and dismisses; ten toasts leave three on screen and three timers; source pins that the closures throw on `false`, the move undo sends the reported lock and throws the handler's reason) and "SCH-7 / SCH-18 ·" (rendered: a refused Undo reads "Couldn't undo: permission denied for table milestones — …").

**Done-when.** 1 ✓ (shows "Couldn't undo", leaves the toast, offers a retry). 2 ✓.

**Scope / residual.** None.

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
