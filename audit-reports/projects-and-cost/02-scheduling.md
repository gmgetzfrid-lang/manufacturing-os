# 02 · Scheduling — dependencies, critical path, import

**14 findings** — 5 HIGH · 9 MEDIUM.

Read as an algorithm, not as code.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| computeTreeMove's locked-leaf handling and whole-tree re-enveloping — the one reflow engine that gets actuals right | `lib/scheduleReflow.ts:126-208 (`if (isLocked(byId.get(sid))) continue;` at :161; deepest-first re-envelope at :174-192)` | This is the correct implementation of the rule the module documents, and it is well tested (scheduleReflowLocks.test.ts:41-53). Findings 1 and 7 should be fixed by making cascadeDependents and sequenceSiblings match this function, not by changing it. |
| apply_milestone_moves as an atomic batch with SET search_path and a PGRST202 fallback | `supabase/migrations/20260907_milestone_batch_move.sql:14-20; lib/milestones.ts:303-320` | It fixes a real half-moved-schedule failure, pins search_path (the SECURITY DEFINER hazard the earlier audits found elsewhere), and degrades to per-row writes on a pre-migration database. Only its NULL-uid escape (finding 2) needs changing — the transaction shape is right. |
| rebaseSchedule's optimistic lock and its refusal to shift actual dates | `lib/milestones.ts:1209-1229 (`if (raw.updated_at) q = q.eq("updated_at", raw.updated_at);`, skipped-row reporting at :1227-1229)` | The only writer in the scheduling layer that detects a concurrent edit and tells the user which rows it left alone. The prior audit reached the same conclusion ("the strongest code in this surface"). It is the template every other batch writer should copy. |
| Project- and document-scoped uniqueness for imported external_refs | `supabase/migrations/20260704_milestones_project_scoped_unique.sql` | Fixes a real field failure (the same .mpp imported into a second project silently updating the first project's rows) with three correctly-partitioned indexes covering the project, document and unanchored cases. The import code at lib/milestones.ts:992-1000 mirrors the same scoping. |
| first_completed_at preservation across a reopen/re-complete cycle | `lib/milestones.ts:368-377 and :481-486 (`update.actual_at = existingFirstCompleted ?? now;`)` | Stops a re-completion from rewriting earned-value history with today's date. This is exactly the actuals-are-immutable discipline that finding 1 breaks elsewhere; keep it. |
| rollUpSummaryDates' cycle guard and fill-only-what's-missing rule | `lib/scheduleParsers.ts:758-805 (`if (inProgress.has(ref)) return null;` at :773; `if (!r.plannedStartAt) ... if (!r.plannedAt)` at :802-803)` | P6 WBS nodes carry no dates of their own; this derives them from descendants without ever shrinking a summary span the source did supply, and terminates on a malformed parent cycle. |
| resolveVisibleDepIndex — dependency links survive a collapsed phase | `lib/scheduleDeps.ts:21-35, consumed at components/projects/ExecutionView.tsx:1427-1431` | Snapping an endpoint to its nearest visible ancestor (with a `seen` cycle guard) is what stops arrows from vanishing when a supervisor collapses a phase on a 500-row board. Small, pure, and correct. |
| assignGroupColors' single-root anchoring | `lib/scheduleColors.ts:84-115` | Handles the common shape where everything hangs off one "Overall project" row by anchoring hue on its first-level children instead of painting the whole board one colour, with cycle guards on both ancestor walks. Note it correctly treats the single root as an ancestor — which is what finding 4 breaks at import time by never creating that root. |


---


<a id="sched-1"></a>

## SCHED-1 · MS Project's project-summary task (OutlineLevel 0) is coerced to level 1 and lands as a top-level LEAF spanning the whole job, double-counting in every rollup

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/scheduleParsers.ts:247`, `lib/scheduleParsers.ts:252-261`, `lib/scheduleParsers.ts:838-839`, `lib/executionReport.ts:121-124`, `lib/milestones.ts:657-659`, `lib/criticalPath.ts:43-49`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Holds, and the CSV path proves the coercion is the bug: scheduleParsers.ts:681 `const outlineLevel = outRaw ? Number(outRaw) : null` preserves 0, and reconstructHierarchyFromOutline (:847-852) walks `for (let l = lvl - 1; l >= 0; l--)` — level 0 works correctly there. Extra unclaimed harm: the summary row is an incomplete leaf finishing at the job finish and starting at the job start, so criticalPath.ts seeds it into the chain and the backward walk terminates in one step, collapsing the critical path.

**Mechanism.** `const outlineLevel = Number(outlineLevelRaw) || 1;` (:247). `Number("0")` is 0, which is falsy, so the project-summary row that MSPDI exports with `<UID>0</UID><OutlineLevel>0</OutlineLevel><Summary>1</Summary>` is relabelled level 1. It then registers as `recentByLevel[1]` (:256) and every genuine level-1 phase, also computing to 1, takes `recentByLevel.get(outlineLevel - 1)` = `get(0)` = undefined and gets `parentExternalRef = null` (:252-255). The summary row therefore has no children in the database, and every consumer derives leaf-ness structurally: `isLeaf = (m) => !m.id || (childrenByParent.get(m.id) ?? []).length === 0` (executionReport.ts:121), `const parentIds = new Set(); ... isLeaf = (m) => !(m.id && parentIds.has(m.id))` (milestones.ts:657-659), `const isLeaf = (m) => !milestones.some((c) => c.parentId === m.id)` (criticalPath.ts:43). The `is_summary` column is set true but nothing reads it for leaf-ness. The same map also mis-parents after a dropped row: a task at level 3 whose level-2 parent was skipped by `if (!name || !plannedRaw) { dropped++; continue; }` (:245) attaches to whatever level-2 row was last seen — a task in a previous phase — because dropped rows never update recentByLevel and deeper keys are only cleared when a shallower row appears (:259-261). The library already knows about this class of bug: reconstructHierarchyFromOutline's comment names "the MPXJ converter bug that orphans every top-level phase because their parent is the project-summary row (MS Project ID 0)" (:837-838), and that helper loops `for (let l = lvl - 1; l >= 0; l--)` (:849) — handling level 0 correctly — but the MS Project XML path never calls it.

**Failure scenario.** A planner exports Unit 200 Turnaround from MS Project. The file's first task is the project summary (UID 0, name = the project, Start = job start, Finish = job finish, PercentComplete = whole-job %). It imports as a top-level task with no children, so it is counted as a leaf everywhere: totalLeaves is one too many, its weight is added to the denominator of SPI and percent-complete, and because its finish equals the project finish and it is not complete, it is unconditionally seeded into the critical-path chain (criticalPath.ts:56). On the timeline it renders as a task bar spanning the entire outage, draggable — dragging it moves nothing else, because it has no descendants, but it does persist a new project-wide "task" date. Separately, if any row is dropped for a missing date, its children silently re-attach under the previous phase and appear in the wrong WBS branch.

**Evidence.**

```
lib/scheduleParsers.ts:247 verbatim: `const outlineLevel = Number(outlineLevelRaw) || 1;` — the `|| 1` fallback fires for "0" as well as for "". Contrast :849 in the helper this path does not use: `for (let l = lvl - 1; l >= 0; l--)`. The XML test fixture (lib/__tests__/scheduleParsersXml.test.ts:26-47) contains only OutlineLevel 1 tasks and no UID 0 row, so nothing in the suite exercises a real MSPDI export's first task.
```

> **Verifier correction.** The secondary mis-parenting claim is overstated. When a level-2 row is dropped by :245, a level-3 child does NOT usually attach to "a task in a previous phase": any intervening level-1 phase row clears every key > 1 at :259-261, so the stale key is normally gone and the orphan gets parentExternalRef = null (top-level) instead. The realistic mis-parent is narrower — a level-3 task adopting the previous level-2 SIBLING inside the same phase. The primary claim (project-summary row becomes a top-level leaf and double-counts) is unaffected.

**Done when.**

- [ ] Number(outlineLevelRaw) is parsed with an explicit NaN test so 0 survives as 0
- [ ] A level-0 row is either imported as the root parent of the level-1 phases or skipped with a warning, never as a sibling leaf
- [ ] Dropped rows clear their level from recentByLevel so a deeper row cannot inherit a stale parent
- [ ] A fixture containing <UID>0</UID><OutlineLevel>0</OutlineLevel> asserts the phases are its children (or that it was skipped)

---

<a id="sched-2"></a>

## SCHED-2 · No parser ever populates durationHours, so every "effort-weighted" number on an imported schedule is really a task count — and MS Project's Work value is captured as an unparsed string

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/scheduleParsers.ts:52`, `lib/scheduleParsers.ts:295-296`, `lib/scheduleParsers.ts:304-320`, `lib/scheduleParsers.ts:402-412`, `lib/scheduleParsers.ts:546-556`, `lib/milestones.ts:981`, `lib/scheduleProgress.ts:44-50`, `lib/executionReport.ts:106`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence with a repo-wide search. The user-visible end of it is real: ExecutionReportView.tsx:62-68 prints a 'Work hours' card whose big number is silently pctComplete over a `0 / 0 h` sub-line. Only a hand edit in TaskDetailPanel.tsx:467 can ever populate the column.

**Mechanism.** `durationHours?: number | null` is declared on ParsedMilestone (scheduleParsers.ts:52), threaded through the import modal (ScheduleImportModal.tsx:184) and written to the column (`baseFields.duration_hours = r.durationHours ?? null`, lib/milestones.ts:981) — but no parser assigns it. `grep -n "durationHours" lib/scheduleParsers.ts` returns exactly one line: the interface declaration. Every row-construction site sets `weight: 1` and nothing else (:308, :359, :406, :495, :550). The MS Project parser reads the field that carries the answer and throws away its meaning: `const workRaw = childText(t, "Work"); if (workRaw) attributes.work = workRaw;` (:295-296) — PT40H0M0S is stored as a display string in the attributes JSON, never parsed to hours. Consequently effectiveWeight's first branch is dead for imports (`const d = m.durationHours; if (d != null && ... d > 0) return d;` — scheduleProgress.ts:45-47) and every leaf falls through to weight 1.

**Failure scenario.** A turnaround is imported from P6 with 400 activities. `hoursOf` returns 0 for all of them (executionReport.ts:106), so plannedHours = 0 and the Report's "Work hours" card prints `0 / 0 h` with pctHours silently falling back to pctComplete (executionReport.ts:169). Every rollup — buildProgressIndex, overallPercent, computeScheduleMetrics' SPI and earned value, the per-group pctComplete — weights a 200-hour vessel entry identically to a 15-minute signature. The UI labels these "Earned weight" (ScheduleProgress.tsx:71), "effort-weighted" (executionReport.ts:31) and "duration-weighted" (scheduleProgress.ts:6), and the doc comment claims work hours are "the truest measure of effort" (:42-43). criticalPath's "Nh remaining on the chain" badge never renders for an imported schedule because remainingHours is always 0 (criticalPath.ts:83-84, ExecutionReportView.tsx:87).

**Evidence.**

```
`grep -n "durationHours" lib/scheduleParsers.ts` → `52:  durationHours?: number | null;` and nothing else. `grep -n "weight:" lib/scheduleParsers.ts` → 308, 359, 406, 495, 550 all `weight: 1`, plus the CSV path at 707. The only writer of duration_hours in the whole app is the manual per-task form (components/projects/TaskDetailPanel.tsx:520 "Work hours", saved at :495 through MilestonePatch.durationHours, lib/milestones.ts:205/229).
```

> **Verifier correction.** None substantive. Worth adding for the consumer: executionReport.ts:106 `hoursOf` returns 0 when durationHours is absent, so the Report's "Work hours" card renders 0/0 h on an imported schedule rather than silently substituting counts — the count-substitution happens in effectiveWeight, not in the hours card.

**Done when.**

- [ ] MS Project XML <Work> (PT#H#M#S) and <Duration> are parsed to hours and written to durationHours
- [ ] P6 XML (PlannedDuration / RemainingDuration) and XER (target_drtn_hr_cnt / target_work_qty) populate durationHours
- [ ] The Report's "Work hours" card is hidden or explicitly labelled "not supplied by this import" when plannedHours is 0, rather than printing 0 / 0 h
- [ ] A parser test asserts a non-null durationHours on a fixture that carries work

---

<a id="sched-3"></a>

## SCHED-3 · The approved baseline is writable and erasable by any active org member, can half-apply, is never shown on the timeline, and every batch move rewrites past it without a word

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/milestones.ts:1462-1502`, `lib/milestones.ts:1504-1514`, `supabase/migrations/20260614_phase7_milestones.sql (milestones_member_all policy)`, `supabase/migrations/20260706_milestones_baseline.sql:1-12`, `components/projects/TaskDetailPanel.tsx:480-483`, `components/projects/ScheduleTab.tsx:201-215`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All four sub-claims verified. Sharpest point the finding understates: setBaseline is audited but clearBaseline is not, so any active member can erase the approved plan silently. ScheduleTab.tsx:206 promises 'Every view will then show how far the schedule drifts from it' while the timeline draws no baseline bar; drift appears only in the execution report and the task detail panel.

**Mechanism.** Four gaps compound around the one artifact that represents the approved plan. (a) Authority: the RLS policy is `FOR ALL TO authenticated USING (active org member) WITH CHECK (active org member)` — both halves are present, but membership is the whole test, so any active member can write baseline_start_at / baseline_finish_at / baseline_set_at directly. The role gate lives only in the UI (`ADMIN_ROLES` at ScheduleTab.tsx:51) and only apply_milestone_moves has a data-layer role check. (b) Atomicity: setBaseline issues one UPDATE per row through `await Promise.all(rows.map(async (r) => {...}))` (:1480-1488) with no transaction; on partial failure it returns `ok: errors.length === 0` but leaves some rows baselined. `hasBaseline` is `milestones.some((m) => m.baselineFinishAt)` (ScheduleTab.tsx:201), so a half-applied baseline reads as "baselined", and executionReport computes drift over `leaves.filter((m) => m.baselineFinishAt)` (executionReport.ts:253) — a subset — while presenting it as the project envelope. (c) Audit: setBaseline logs SCHEDULE_BASELINED (:1490-1499); clearBaseline nulls all four columns for the whole project (:1509-1511) and logs nothing. It also has no caller — `grep -rn clearBaseline` over the repo returns only its definition, its doc comment and a prior audit's mutator census. (d) Re-baselining overwrites the previous snapshot in place; there is no baseline history table, so the prior approved plan is unrecoverable.

**Failure scenario.** A turnaround plan is baselined at kickoff. Two weeks in, a supervisor drags a phase and confirms the move; the drag path (computeTreeMove → withCascade → apply_milestone_moves) writes new planned dates for dozens of rows with no baseline comparison anywhere — the single-task edit form is the only surface that warns ("+7 days vs the approved plan", TaskDetailPanel.tsx:482), and `grep baselineFinishAt components/**/*.tsx` shows ExecutionView never reads the baseline at all, though the migration header promises "every view can show 'planned vs now'" (20260706:6-8). Later, "Re-baseline" is clicked (the same button, relabelled, behind one appConfirm at ScheduleTab.tsx:204-207) and the original approved plan is gone with a single audit row recording only a count.

**Evidence.**

```
lib/milestones.ts:1509-1511 verbatim — `const { error } = await supabase.from("milestones").update({ baseline_start_at: null, baseline_finish_at: null, baseline_set_at: null, baseline_set_by: null, }).eq("org_id", ...).eq("project_id", ...)` — followed directly by `if (error) return { ok: false, error: error.message }; return { ok: true };` with no logAuditAction, unlike setBaseline forty lines above. `grep -rn "baselineFinishAt|baselineStartAt" components/` returns four hits, all in TaskDetailPanel and ScheduleTab; ExecutionView, MovePreviewSheet and ScheduleCalendarTileView return none.
```

**Chain reaction.** Combined with finding 1 (cascade rewriting completed rows), a baselined project can drift in ways that the drift report attributes to the wrong tasks, and the snapshot that would have proved the original plan can be erased without trace.

> **Verifier correction.** Two clauses need trimming. (i) "never shown on the timeline" is true only of ExecutionView — baseline drift IS surfaced elsewhere: ScheduleTab.tsx:520-521 computes driftDays and renders a "+Nd vs plan" chip in the Planning list, and executionReport.ts:252-262 feeds a Baseline drift section of the Report. So the baseline is not invisible, it is absent from the Execution timeline/calendar specifically. (ii) clearBaseline's missing audit entry has no live consequence today: two searches (`grep -rn clearBaseline` over ts/tsx/md, and the setBaseline import census in ScheduleTab.tsx:27) show it is never called from any component or route — it is dead code, which is a defect of a different shape than the one described.

**Done when.**

- [ ] Setting or clearing a baseline requires the same role check apply_milestone_moves enforces, at the data layer
- [ ] clearBaseline writes an audit entry naming the project and row count, or is deleted along with its doc comment
- [ ] setBaseline applies as one statement (or RPC) so it cannot half-apply, and a partial baseline is reported to the user
- [ ] A batch move that pushes any row past its baseline finish says so in the move-confirmation sheet, the way the single-task form already does

---

<a id="sched-4"></a>

## SCHED-4 · apply_milestone_moves skips its entire authorization block whenever auth.uid() is NULL, and SECURITY DEFINER means RLS does not backstop it

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260907_milestone_batch_move.sql:20-47`, `supabase/migrations/20260907_milestone_batch_move.sql:49-59`, `lib/milestones.ts:303-307`, `supabase/migrations/20260614_phase7_milestones.sql (milestones_member_all)`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the claim of absence: the anon role's default PUBLIC EXECUTE is never revoked here, unlike every comparable RPC in the repo. The practical exploit is privilege escalation rather than pure anonymous access — milestones_member_all is `TO authenticated`, so ids must come from a signed-in session, but any member without schedule-editing rights can re-issue the call with a bare anon key and skip the role check entirely.

**Mechanism.** The function is declared `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public` (:20) — so it executes as the owner and RLS on `milestones` does not apply to its UPDATEs. Its own guard is the only authorization, and it opens with an unconditional escape: `IF v_uid IS NULL THEN /* service role: trusted server code */ NULL; ELSE ... END IF;` (:29-32). `auth.uid()` returns NULL for the anon role as well as for the service role — the anon key ships to the browser as NEXT_PUBLIC_*, and PostgREST exposes RPCs to anon by default. Nothing in this migration REVOKEs EXECUTE (the file is 63 lines and contains no GRANT/REVOKE), while sibling migrations that use the same shape at least test the role explicitly (20261011_collections_guard_and_trash.sql:47 — `IF auth.role() = 'service_role' OR auth.uid() IS NULL`). The role check that is skipped is the only place schedule-editing authority is enforced at the data layer: `v_roles && ARRAY['Admin','DocCtrl','Manager','Supervisor'] OR v_owner = v_uid::text` (:41-46).

**Failure scenario.** An unauthenticated request carrying the public anon key calls `rpc('apply_milestone_moves', {p_org, p_project, p_moves})`. v_uid is NULL, the membership lookup and the role check are both skipped, and the loop rewrites planned_start_at/planned_at on every id supplied, with `updated_by = NULL`. The caller needs the org, project and milestone UUIDs, which bounds the practical exposure — but a member who has legitimately seen those ids (any active org member, including a Viewer whose UI is read-only) can replay them with no session at all and move a baselined turnaround schedule. The role gate that exists in the UI (`ADMIN_ROLES` in components/projects/ScheduleTab.tsx:51) is a display gate only.

**Evidence.**

```
Migration text, verbatim: `IF v_uid IS NULL THEN\n    -- service role: trusted server code\n    NULL;\n  ELSE` (20260907_milestone_batch_move.sql:29-32), inside a function declared `SECURITY DEFINER` at :20. `grep -rn "REVOKE|GRANT EXECUTE" supabase/migrations/` lists ten migrations; 20260907_milestone_batch_move.sql is not among them. SCH-7 in audit-reports/projects-tab/06-schedule-engine.md examines this same function for concurrency (no optimistic lock, v_count counts attempted not affected rows) and does not raise the authorization escape; the roles-and-permissions report establishes the hardcoded ["Admin","DocCtrl",...] vocabulary pattern that :42 also repeats.
```

> **Verifier correction.** Downgraded to SUSPECTED on verification only. The final link — that the anon role actually holds EXECUTE on this function — is a database grant that cannot be read from the repo; it rests on Supabase's default privileges, inferred (strongly) from the fact that eight sibling functions bother to revoke from anon explicitly. Also note the `auth.uid() IS NULL` escape is a repo-wide idiom (20260901_db_hard_enforcement.sql:112/156/168, 20260831_capability_policy_and_rails.sql:49/84, 20261011_collections_guard_and_trash.sql:47), so this is a systemic pattern rather than a one-off oversight — but this function is the only one of that set that both skips the check AND is directly RPC-callable with attacker-controlled org/project/date arguments.

**Done when.**

- [ ] The NULL-uid branch tests auth.role() = 'service_role' explicitly rather than treating any absent uid as trusted
- [ ] EXECUTE on apply_milestone_moves is revoked from anon (and from public) and granted only to authenticated
- [ ] A test or manual probe with the anon key and no session receives 42501, not a successful move

---

<a id="sched-5"></a>

## SCHED-5 · cascadeDependents and sequenceSiblings rewrite the planned dates of COMPLETED work, contradicting the module's own "actuals never move" contract

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/scheduleReflow.ts:38-43`, `lib/scheduleReflow.ts:49-52`, `lib/scheduleReflow.ts:345-363`, `lib/scheduleReflow.ts:433-447`, `lib/scheduleReflow.ts:159-168`, `lib/__tests__/scheduleReflowLocks.test.ts:56-92`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Holds. The cited tests confirm the gap rather than close it: every case in scheduleReflowLocks.test.ts (:56-92) locks a DIRECT successor or a DIRECT sibling — none places a completed task beneath an unlocked parent that moves. Nor does the persistence path filter: ExecutionView.tsx:449-461 withCascade merges cascade output straight into the batch with no lock check.

**Mechanism.** The module header states the rule as absolute: "Locked tasks are never moved by reflow / cascade / sequencing — exactly like MS Project and Primavera, where actuals don't reschedule themselves" (lib/scheduleReflow.ts:39-43). computeTreeMove honours it per node — `for (const sid of subtree) { if (!isLeaf(sid)) continue; if (isLocked(byId.get(sid))) continue; ...}` (:160-161). The other two engines check the lock only on the node they are steering, then move its whole subtree unconditionally. cascadeDependents tests the successor — `if (isLocked(s)) continue;` (:349) — and then shifts every descendant with no lock test at all: `const delta = req - curStart; for (const t of subtreeOf(sid)) { start.set(t, start.get(t)! + delta); finish.set(t, finish.get(t)! + delta); }` (:357-361). sequenceSiblings tests the direct child — `if (isLocked(kid)) { cursor = Math.max(...); continue; }` (:436) — then shifts `subtreeOf(kid.id)` wholesale (:441-444). Any completed task that is a grandchild rather than a child of the steered node is moved.

**Failure scenario.** A phase "Weld spool 12" has three sub-steps; "Fit-up" was completed on 2 Jan and stamped with its actual. "Weld spool 12" depends on an upstream task that slips nine days. The cascade pushes the phase forward and drags the completed fit-up's planned window from 2–3 Jan to 11–12 Jan. The batch persists through apply_milestone_moves in one transaction. The task now reads: planned 11 Jan, actual_at 2 Jan — a completed inspection whose plan sits nine days after it was performed. Baseline drift, SPI, the pace card and the printable end-of-job report all recompute from the rewritten plan, and nothing in the UI marks the row as having been moved after completion. Sequencing a phase produces the same rewrite for any completed grandchild.

**Evidence.**

```
Executed against the real module (scratch copy, node --experimental-strip-types). Input: a→b (FS), b1 a COMPLETED child of b, b1 planned 2026-01-02→01-03.
cascadeDependents(nodes, ["a"]) returned:
  [{"id":"b","plannedStartAt":"2026-01-11...","plannedAt":"2026-01-12..."},
   {"id":"b1","plannedStartAt":"2026-01-11T00:00:00.000Z","plannedAt":"2026-01-12T00:00:00.000Z"}]
b1 is `status: "completed"` and moved nine days. sequenceSiblings with a completed grandchild b1 likewise emitted `{"id":"b1","plannedStartAt":"2026-03-03T00:00:00.000Z"}`. The lock test file covers only direct nodes: "a completed predecessor stays, and shields its successor" (scheduleReflowLocks.test.ts:70) and "sequences the open steps around the locked one" (:86) — both fixtures are flat, so the hole is invisible to the suite.
```

**Chain reaction.** The rewritten dates feed executionReport's baseline drift (lib/executionReport.ts:258-266), which counts the completed row as "slipped" and inflates finishDriftDays; that number is printed in the end-of-job report as the record of schedule performance.

> **Verifier correction.** None. Quoted code appears verbatim at the cited lines and the runtime behaviour reproduces.

**Done when.**

- [ ] cascadeDependents skips locked nodes inside a shifted subtree, not just the successor itself
- [ ] sequenceSiblings skips locked descendants, not just the direct child
- [ ] A test fixture places a completed task one level below the node being cascaded and below the node being sequenced, and asserts it does not appear in the change set
- [ ] A row whose actual_at is set can never receive a planned-date change from a batch engine

---

<a id="sched-6"></a>

## SCHED-6 · A multi-project P6 export merges every project's activities into the one target project — no proj_id filter exists on either P6 path

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/scheduleParsers.ts:349-365`, `lib/scheduleParsers.ts:383-413`, `lib/scheduleParsers.ts:479-502`, `lib/scheduleParsers.ts:527-557`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence. No filter, no warning, and no project picker — ScheduleImportModal contains no mention of proj_id or multiple projects. The proj_node_flag handling actively produces the described symptom: every project in the file contributes its own top-level phase to the one target project.

**Mechanism.** Both P6 parsers harvest globally. The XML path takes `Array.from(doc.getElementsByTagNameNS("*", "WBS"))` (:349) and `Array.from(doc.getElementsByTagNameNS("*", "Activity"))` (:383) across the whole document, which for an EPS-level or multi-project export contains several `<Project>` elements. The XER path reads the TASK and PROJWBS tables whole (:465-502, :535) and resolves columns by name — `const tId = col(task, ["task_id"]); ... const tWbs = col(task, ["wbs_id"])` (:527-532) — never touching `proj_id`, which every XER TASK row carries (the repo's own test fixture includes it: lib/__tests__/scheduleParsers.test.ts:120-122 has `proj_id` in the %F header and `100` in each %R row). `grep -n "proj_id" lib/scheduleParsers.ts` returns nothing but `proj_node_flag`. Each project's PROJWBS root is flagged `proj_node_flag='Y'` and is given a null parent (:489-497), so the merged result is several disconnected roots in one board with no indication they came from different projects.

**Failure scenario.** A scheduler exports from P6 at the EPS node — the usual way to get "the outage" when it spans two units — or simply exports a file that still contains a second project. Every activity from both projects imports into the one selected project. The board now shows another unit's work as top-level phases; overall percent complete, SPI, the critical path, the overdue count and the health score are all computed over a schedule that is partly someone else's. Nothing in the import preview says how many projects the file contained.

**Evidence.**

```
`grep -rn "proj_id" lib/scheduleParsers.ts` → no matches (only `proj_node_flag` at :485/:489). The document-wide selectors are verbatim at :349 and :383; the XER column resolution at :527-533 lists task_id, task_name, task_code, wbs_id, dates and percent — no project column.
```

> **Verifier correction.** None. Consequence severity depends on the user exporting an EPS-level or multi-project XER/XML, which is a user-controlled precondition, not a defect precondition — MEDIUM is the right level.

**Done when.**

- [ ] The parsers detect more than one project in the file (multiple PROJECT rows / <Project> elements) and either ask which to import or report the count
- [ ] Rows are filtered to the chosen project's proj_id / Project ObjectId
- [ ] A fixture with two projects asserts only one project's activities are returned

---

<a id="sched-7"></a>

## SCHED-7 · A phase whose tasks are all MISSED rolls up as "planned, 0%" — missed is the one exception state that never bubbles

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/scheduleProgress.ts:55-64`, `lib/scheduleProgress.ts:110-118`, `lib/scheduleProgress.ts:139-146`, `lib/__tests__/scheduleProgress.test.ts:46-50`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide search: buildProgressIndex is the only rollup used by the timeline, calendar and detail panel (ExecutionView.tsx:249, ScheduleTab.tsx:178, TaskDetailPanel.tsx:69) and none of them re-checks for missed descendants, so an all-missed phase renders 'planned, 0%'. The only escape is a missed task that had a non-zero percent_complete logged before it was missed, which flips the parent to in_progress — still not 'missed'.

**Mechanism.** deriveSummaryStatus tallies four things and returns in a fixed order: `if (t.total === 0) return "planned"; if (t.done === t.total) return "completed"; if (t.blocked > 0) return "blocked"; if (t.onHold > 0) return "on_hold"; if (t.started > 0) return "in_progress"; return "planned";` (:58-63). There is no `missed` counter — the Agg interface carries `done, blocked, onHold, started` only (:78-80) and the leaf branch only increments blocked/onHold (:116-117). A missed leaf contributes done 0, blocked 0, onHold 0, and started 0 (since `started: p > 0 ? 1 : 0` and leafPercent for a missed task with no logged progress is 0). The function's own comment claims the opposite intent: "anything blocked/on-hold bubbles up so it can't hide" (:53-54) — missed hides.

**Failure scenario.** A night-shift phase contains four hydrotest tasks; the shift is lost and all four are marked `missed`. The phase row on the timeline, the calendar tile and the planning list renders with the blue "Planned" dot at 0% — visually identical to work that has not started yet. Collapse the phase (the default for a 500-row turnaround) and the missed work is invisible: SchedulePulse surfaces overdue and blocked (components/projects/SchedulePulse.tsx:31-34) but the summary row itself claims nothing is wrong. The count is not lost everywhere — executionReport tallies `missed` separately (lib/executionReport.ts:150) — but the hierarchy the board is read through says "planned".

**Evidence.**

```
Executed against the real module: `deriveSummaryStatus({ total: 3, done: 0, blocked: 0, onHold: 0, started: 0 })` → `'planned'`. `buildProgressIndex([{id:'P'},{id:'k1',parentId:'P',status:'missed'},{id:'k2',parentId:'P',status:'missed'}]).get('P')` → `{ percent: 0, status: 'planned', isLeaf: false, leafDone: 0, leafTotal: 2 }`. The test suite pins the blocked/on-hold case ("blocked and on-hold bubble up; started = in progress", scheduleProgress.test.ts:50) and never constructs a missed leaf.
```

> **Verifier correction.** Severity lowered to MEDIUM. The missed state is not fully hidden: each missed LEAF still renders its own status (ScheduleTab.tsx:513 uses m.status for non-parents, and :522 gives missed rows a red tone), and computeScheduleMetrics counts them in byStatus.missed (milestones.ts:650/664). What is wrong is only the derived phase chip and the collapsed-phase reading — a real defect, but the underlying misses remain visible one level down. Also note the suite does pin the all-zero tally → 'planned' case at scheduleProgress.test.ts:55, it just never constructs a missed leaf, which is the finding's actual point.

**Done when.**

- [ ] Agg carries a missed counter and deriveSummaryStatus returns a state that surfaces it (ranked with blocked/on_hold)
- [ ] STATUS_META already has a rose 'Missed' treatment (ScheduleProgress.tsx:34) — the summary row uses it
- [ ] A test asserts an all-missed phase does not render as planned

---

<a id="sched-8"></a>

## SCHED-8 · MS Project CSV predecessors are matched against whichever id column won the synonym race, so a file with both Unique ID and ID wires dependencies to the wrong tasks

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/scheduleParsers.ts:579-590`, `lib/scheduleParsers.ts:634-648`, `lib/scheduleParsers.ts:686-701`, `lib/scheduleParsers.ts:710`, `lib/milestones.ts:1090-1099`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The only guard present is `if (iPred >= 0 && iId >= 0)` (line 686), which checks that SOME id column exists, not that it is the same numbering the Predecessors column uses — MS Project's Predecessors field displays sequential IDs, not Unique IDs. Mis-resolved refs silently produce a wrong `depends_on` edge (no error surfaces, since only unresolvable refs are dropped by the `.filter(Boolean)` at 1095).

**Mechanism.** The id column is resolved by first-match synonym order: `id: ["unique id", "uid", "id", "task id"]` (:585), and `findCol` returns the first candidate present (:634-637) — so in an export containing both columns, externalRef becomes `msp:<Unique ID>` (:710). The Predecessors column, however, contains MS Project's **ID** (the outline position), not Unique ID. The parser takes the leading digits of each token and emits refs in the same namespace regardless: `.map((tok) => tok.trim().match(/^\d+/)?.[0]) ... dependsOnExternalRefs = predIds.map((p) => \`${refTag}:${p}\`)` (:696-699). The comment directly above claims this case is handled: "Only resolvable when the file has an id column (so refs line up); otherwise they're left for the user to wire up manually rather than mis-linked" (:689-691) — the guard it describes (`iPred >= 0 && iId >= 0`, :692) tests only that *an* id column exists, not that it is the same numbering the Predecessors column uses. The importer's pass 3 then resolves whatever matches and silently drops the rest: `.map((ref) => refToId.get(ref)).filter((x): x is string => !!x && x !== id)` (milestones.ts:1095-1097).

**Failure scenario.** A planner exports a schedule from MS Project with both Unique ID and ID columns (the default when both are on the Gantt). Rows key on Unique ID; predecessor tokens are IDs. In a file that has been edited over time the two numberings diverge, so `msp:14` as a predecessor resolves to whatever task holds Unique ID 14 — a real, unrelated task. The board draws a confident FS arrow between them, cascadeDependents reschedules against it, and the wrongly-linked pair looks exactly like a correct one. Where no match exists the link is dropped with no warning, so the import result reports neither the mis-links nor the losses.

**Evidence.**

```
lib/scheduleParsers.ts:585 verbatim: `id:       ["unique id", "uid", "id", "task id"],` against :589 `pred:     ["predecessors", "predecessor", "preds"],`. The suite's fixture has only an `ID` column, so the two numberings coincide (lib/__tests__/scheduleParsers.test.ts:137-147). Adjacent to but distinct from SCH-3 in audit-reports/projects-tab/06-schedule-engine.md, which flags Unique ID vs ID as a row-matching/overwrite hazard; this is the dependency-edge consequence.
```

> **Verifier correction.** Add the trigger condition explicitly: MS Project's default CSV export map ships ID (not Unique ID), so the two numberings coincide and nothing goes wrong on a stock export — the mis-wire needs a customized export map that includes Unique ID, or one that includes Unique ID instead of ID. That makes the code path certain but the field occurrence conditional. The suite's single-ID fixture (scheduleParsers.test.ts:137-147) is as described.

**Done when.**

- [ ] When both Unique ID and ID are present, predecessors are resolved through the ID column (or the row key is switched to ID for dependency purposes only) — the two must agree
- [ ] Unresolvable predecessor tokens are counted and reported in the import warnings rather than dropped
- [ ] A CSV fixture with divergent Unique ID and ID columns asserts the links land on the right rows

---

<a id="sched-9"></a>

## SCHED-9 · Shift (day/night) is derived by parsing an offset-less imported datetime as browser-local, then frozen — so it is wrong by the importer's UTC offset and never follows the task

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/milestones.ts:902-910`, `lib/milestones.ts:975`, `lib/scheduleParsers.ts:911-914`, `lib/scheduleFilter.ts:104`, `lib/scheduleFilter.ts:26-27`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Import runs client-side (components/projects/ScheduleImportModal.tsx:154 calls importMilestonesFromParsed in a "use client" component), so the local zone really is the importer's browser zone. Repo-wide grep for `shift` in lib/milestones.ts confirms line 975 is the ONLY write of the column — neither updateMilestone/applyMilestoneMoves nor the RPC recompute it, so it never follows a moved task; the filter at lib/scheduleFilter.ts:104 (`!f.shifts.includes(m.shift)`) trusts the frozen value.

**Mechanism.** coerceIso normalizes a date-only value to UTC (`return \`${trimmed}T00:00:00Z\`;`, scheduleParsers.ts:914) but returns a datetime verbatim, offset and all: `if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed;` (:913). MS Project XML writes local wall-clock times with no offset (`<Start>2026-06-01T08:00:00</Start>` — the repo's own fixture, scheduleParsersXml.test.ts:29), so the string that reaches the importer has no zone. shiftFromStart then parses it with `const d = new Date(plannedStartIso); ... const h = d.getUTCHours(); return (h >= 6 && h < 18) ? "day" : "night";` (milestones.ts:905-909). Per ES semantics a date-time string without an offset is parsed as **local**, so getUTCHours returns the hour shifted by the importing browser's offset. The value is written once at insert (`baseFields.shift = shiftFromStart(plannedStartIso);` :975) and no reflow, cascade, resize or rebase ever recomputes it — none of the date-moving paths touch the shift column.

**Failure scenario.** A planner in UTC+5:30 imports a schedule whose night-shift tasks start at 19:00 plant time. `new Date("2026-06-01T19:00:00")` is 13:30Z for that browser, so getUTCHours is 13 and the tasks are labelled "day". The night supervisor filters the board by Shift = night (scheduleFilter.ts:104) and the shift's work is missing. Because the label is stored, not derived, re-importing from a different machine produces different labels for the same file, and moving a task from a day slot to a night slot leaves the old label in place forever.

**Evidence.**

```
lib/milestones.ts:905-909 verbatim: `const d = new Date(plannedStartIso); if (isNaN(d.getTime())) return null; const h = d.getUTCHours(); return (h >= 6 && h < 18) ? "day" : "night";`. lib/scheduleParsers.ts:913 verbatim: `if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed;` — the only branch that does not attach a zone. The wall-clock-as-UTC storage convention is stated in components/projects/ScheduleProgress.tsx:180-181. Distinct from SCH-1 (which covers coerceIso's M/D vs D/M branch) and SCH-5/SCH-10 (overdue and rebase timezone handling).
```

> **Verifier correction.** "Wrong by the importer's UTC offset" overstates the visible effect. The stored VALUE is a day/night label, not an hour, so the classification only flips when the offset carries the start hour across the 06:00 or 18:00 boundary — an 08:00 start viewed from UTC-5 becomes 13:00 UTC and still reads "day". The realistic breakages are afternoon starts in western zones (13:00 local at UTC-5 → 18:00 UTC → "night") and evening starts in eastern ones. Also, shift is user-correctable after the fact: it is a MilestonePatch field (milestones.ts:203/224) with a select control at TaskDetailPanel.tsx:538 saved at :498 — so the value can be fixed by hand, it just is never recomputed automatically when the task moves.

**Done when.**

- [ ] coerceIso attaches Z to offset-less datetimes so the parsed value matches the wall-clock-as-UTC storage convention
- [ ] shiftFromStart is computed from the same UTC reading the rest of the app uses, or shift becomes derived rather than stored
- [ ] Moving a task's planned start across the 06:00/18:00 boundary updates or invalidates its shift
- [ ] A test pins the shift assigned to an 08:00 and a 19:00 import under a non-UTC TZ

---

<a id="sched-10"></a>

## SCHED-10 · The "critical path" walk includes tasks that have float, merges parallel chains, truncates at any gap over 14 days, and its remaining-hours figure ignores progress

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/criticalPath.ts:56`, `lib/criticalPath.ts:63-79`, `lib/criticalPath.ts:81-85`, `components/projects/ExecutionReportView.tsx:86-87`, `components/projects/ExecutionView.tsx:1503-1504`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All four sub-claims verified verbatim. Mitigating context worth noting: ExecutionReportView.tsx:88 does print 'heuristic — based on schedule shape, not dependency links' next to the number, so the report surface is labelled; the timeline surface (ExecutionView.tsx:723-731, 1503-1504) is not.

**Mechanism.** Beyond ignoring the dependency graph (already reported as SCH-15), the walk itself is wrong on its own terms. The backward step takes a single global seam across the whole frontier — `const earliestStart = Math.min(...frontier.map(startMs));` (:64) — so two independent chains that happen to finish together are collapsed into one seam, and predecessors of chain A are pulled in as drivers of chain B. Candidate predecessors are anything finishing within the window `finishMs(m) <= earliestStart + slack && finishMs(m) >= earliestStart - 14 * 86400000` (:70), so a task with up to 14 days of float is labelled critical, while a genuine driver separated by more than 14 days — a long-lead material delivery, the most common true driver on a turnaround — fails the window and the walk stops (`if (preds.length === 0) break;` :74). Separately, remainingHours sums each chain task's full planned hours regardless of how much is already done: `if (m && typeof m.durationHours === "number") remainingHours += m.durationHours;` (:83-84), then renders as "{h}h remaining on the chain" (ExecutionReportView.tsx:87).

**Failure scenario.** A supervisor turns on Critical path to decide where to put the extra crew. On a schedule with two parallel finishing chains, the highlight covers both, including a task with three days of float — so the crew is moved onto work that cannot pull the finish in. On a schedule whose true driver is an 8-week vendor delivery, that item is not highlighted at all, because its finish is more than 14 days before the seam. If hours are present, the badge overstates the work left: a 100-hour task logged at 90% still contributes 100h.

**Evidence.**

```
Executed against the real module. (a) Long-lead: leaves `order` (Jan 1–5) and `install` (Mar 1–10) → chain = `['install']`; the driver is dropped. (b) Parallel chains A1(Mar 1–5)→A2(Mar 6–10) and B1(Mar 8–9)→B2(Mar 9–10) → chain = `['A2','B1','B2','A1']`; A1, which has three days of float before A2, is on the path. (c) A single in_progress task, percentComplete 90, durationHours 100 → `remainingHours` = `100`. Cite audit-reports/projects-tab/06-schedule-engine.md SCH-15 for the underlying "ignores dependency edges" defect; these are the errors that remain even inside the heuristic's own model.
```

> **Verifier correction.** Two calibrations. (i) The "up to 14 days of float" claim is weaker than stated: :76-77 narrows the 14-day candidate set to `preds.filter((m) => finishMs(m) >= latestPredFinish - slack)`, so only the latest-finishing candidates are added — float still gets in (scenario (b) demonstrates A1), but not arbitrarily up to 14 days. (ii) Substantial overlap with SCH-15, which already names "a 1-day slack / 14-day window" walk and prescribes either real CPM or a rename — a remediation that subsumes the seam and window complaints. The genuinely additive parts are the parallel-chain merge and the remainingHours-ignores-progress bug, neither of which SCH-15 mentions.

**Done when.**

- [ ] Either a real forward/backward CPM pass over dependsOn replaces the date walk, or the control is renamed to what it computes
- [ ] If the heuristic is kept, the backward step follows each frontier task's own seam rather than one global minimum, and the 14-day cutoff is removed or justified
- [ ] remainingHours multiplies each chain task's hours by (100 - leafPercent)/100, or the label stops saying "remaining"

---

<a id="sched-11"></a>

## SCHED-11 · The drag path — the primary way dates move — writes no per-task reschedule breadcrumb, and its one batch audit row is fire-and-forget

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/milestones.ts:247-270`, `lib/milestones.ts:293-327`, `lib/milestones.ts:321-326`, `supabase/migrations/20260907_milestone_batch_move.sql:49-59`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Claim confirmed on every point. listMilestoneNotes (lib/milestones.ts:557-563) reads milestone_notes, which the RPC never writes, so a dragged task's activity panel genuinely shows only status changes.

**Mechanism.** updateMilestone snapshots the prior finish and drops a note on the task's own activity trail — "Breadcrumb: record a reschedule on the task's own activity trail when the finish date actually moved (so 'what changed' shows moves, not just status flips)" (:258-260, note written at :264-268). applyMilestoneMoves does not: it calls the RPC, which updates rows directly in SQL (migration :50-57), and then writes a single audit row whose result is discarded on both branches — `.then(() => undefined, () => undefined)` (:326). So the path that moves dozens of rows per drag produces zero milestone_notes entries, and its only trace is an audit insert that reads as success whether or not it landed (the supabase-js `{error}`-not-throw pattern the audit-logger and ticket-write findings already established). The details payload also truncates: `ids: input.moves.map((m) => m.id).slice(0, 50)` (:325) — a cascade wider than 50 rows loses the rest. Note the fallback branch (:310-317) does go through updateMilestone and does write notes, so the trail exists only on databases where the RPC is missing.

**Failure scenario.** Someone asks why a hydrotest moved four days. The task's activity panel (listMilestoneNotes, :557-563) shows status changes only — no reschedule entries, because every move came through a drag. The project audit log holds one MILESTONES_RESCHEDULED row per drag with a count and up to 50 ids and no before/after dates, and if that insert was rejected by RLS or a transient error, nothing anywhere recorded the move. The prior notifications audit established that a slipped milestone date reaches no one at event time; this removes the after-the-fact trail as well.

**Evidence.**

```
lib/milestones.ts:326 verbatim: `}).then(() => undefined, () => undefined);`. lib/milestones.ts:261-268 shows the note path that exists only in updateMilestone: `if (priorFinish && input.patch.plannedAt && priorFinish !== input.patch.plannedAt) { ... addMilestoneNote({... kind: "reschedule" ...})`. The RPC's UPDATE (20260907:50-57) writes planned_start_at/planned_at/updated_at/updated_by and nothing else.
```

> **Verifier correction.** None. The audit row itself does still exist for a successful insert, so this is a trail-quality defect (no per-task breadcrumb, unverified insert, ids truncated at 50) rather than a total absence of record — which the finding states accurately.

**Done when.**

- [ ] A batch move records the before/after dates for each moved row (in the audit details or as milestone_notes), not just a count
- [ ] The audit insert's error is surfaced or retried rather than swallowed
- [ ] The 50-id truncation either goes away or is flagged in the row ("showing 50 of N")

---

<a id="sched-12"></a>

## SCHED-12 · Three schedule numbers are presented as record when they are estimates, including in the printable end-of-job report and in a refusal message that promises a "true 1:1 copy"

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/scheduleParsers.ts:144-152`, `components/projects/ExecutionReportView.tsx:70-78`, `components/projects/ExecutionView.tsx:723-731`, `components/projects/ExecutionView.tsx:1503-1504`, `lib/executionReport.ts:179-190`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The core observation — a heuristic forecast, an unlabelled timeline 'critical path', and an over-promising '1:1 copy' message — is real, but two of the three headline items are wrong as written: the end-of-job report is the one surface that IS labelled heuristic, and pctComplete is effort-weighted and partial-aware (its degeneracy on imported schedules is SCHED-2's point about durationHours never being populated, not 'a task count'). Presentational wording only; LOW.

**Mechanism.** (a) The MPP/MPX refusal message tells the user: "The XML import is a true 1:1 copy (every date, dependency, resource, and the full hierarchy)." (scheduleParsers.ts:151). It is not: relationship type and lag are discarded (SCH-8), durationHours is never populated (finding 3), the project-summary row is flattened (finding 4), calendars and working time are not modelled at all, and constraints/deadlines survive only as an attribute string (:290-293). (b) The Report's "Forecast finish" card prints a bare date in the largest type on the card (ExecutionReportView.tsx:72-77). Its basis is `const ratePerDay = tally.done / elapsedDays;` — completed *task count* over calendar days since the earliest planned start — with remaining also a task count (executionReport.ts:182-186). It ignores task size, dependencies and the critical path, and elapsedDays is measured from the plan, not from actual start; the module labels it "a naive forecast" internally (:14) and the card carries no qualifier. This is the surface described in its own header as "Print-friendly so it doubles as an end-of-job report". (c) The Report's critical-path panel does carry the caveat "heuristic — based on schedule shape, not dependency links" (ExecutionReportView.tsx:88); the Timeline surface, where the highlight is actually used to make crew decisions, carries none — the button reads "Critical path" with the tooltip "Highlight the unfinished tasks driving the finish date" (ExecutionView.tsx:727-729) and the legend asserts "On the critical path — drives the finish date" (:1503-1504).

**Failure scenario.** An end-of-job report is printed and filed as the schedule record for a PSM-regulated outage. It states a forecast finish derived from average tasks-per-day, a percent-complete that is really a task count (finding 3), and — on the timeline the crew worked from — an unqualified "critical path". Separately, a planner who is refused an .mpp upload is told the XML route loses nothing, exports the XML, and does not check that his start-to-start links and cure-time lags survived.

**Evidence.**

```
scheduleParsers.ts:151 verbatim: `... The XML import is a true 1:1 copy (every date, dependency, resource, and the full hierarchy).` executionReport.ts:182 verbatim: `const ratePerDay = tally.done / elapsedDays;             // leaves/day so far`. The asymmetry in caveats is visible in the two consumers of the same function: ExecutionReportView.tsx:88 carries the heuristic note, ExecutionView.tsx:723-731 and :1503-1504 do not.
```

> **Verifier correction.** None. Note (a) is an aggregation of defects reported separately (SCH-8, findings 3 and 4) — its distinct contribution is the overpromise in the user-facing refusal string itself, which is a real and separately fixable claim.

**Done when.**

- [ ] The refusal message states what the XML path does and does not carry, or the claim is removed
- [ ] The Forecast finish card names its basis ("at the current rate of N tasks/day") or is suppressed when fewer than a threshold of tasks are complete
- [ ] The Timeline critical-path control carries the same caveat the Report already carries

---

<a id="sched-13"></a>

## SCHED-13 · cascadeDependents hardcodes a full calendar day between finish and start, so every FS link inflates the chain and pins successors to the predecessor's clock time

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/scheduleReflow.ts:350-356`, `lib/scheduleReflow.ts:438`, `lib/__tests__/dependencies.test.ts:28-49`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. There is no lag/relationship-type field anywhere in ReflowNode (only `dependsOn: string[]`), and no calendar/working-hours awareness, so the hardcoded 24h is the only spacing rule; it is reached on every drag through ExecutionView.tsx:449-461 `withCascade`.

**Mechanism.** The finish-to-start constraint is expressed as `for (const pred of s.dependsOn ?? []) { if (finish.has(pred)) req = Math.max(req, finish.get(pred)! + DAY_MS); }` (:351-353) with `DAY_MS = 86_400_000` (:88). This is not finish-to-start; it is finish-to-start-plus-one-calendar-day, applied to the predecessor's finish *instant*. sequenceSiblings does the same (`const desiredStart = cursor === null ? curStart : cursor + DAY_MS;` :438). Two consequences follow. First, an imported schedule where dates already satisfy FS exactly (successor starts the same day the predecessor finishes — normal in a shift-based turnaround) is treated as violating the constraint and pushed. Second, with real clock times — MS Project's usual 08:00/17:00, which the parser preserves — a predecessor finishing 17:00 forces the successor's start to 17:00 the next day, and its finish to 17:00 + its span. Every downstream task in the chain inherits a 17:00 start.

**Failure scenario.** A 20-link weld/NDE/hydrotest chain is imported with 08:00–17:00 activity times and correct FS relationships. The first drag triggers withCascade (ExecutionView.tsx:449-461), which pushes every downstream task so that each starts exactly 24 hours after its predecessor's 17:00 finish. Twenty tasks now start at 17:00, their day/night shift labels (assigned once at import, never recomputed) are stale, and the chain has absorbed up to 20 extra days of gap that P6 never had. The move-confirmation sheet reports the dragged task's delta, not the cascade's.

**Evidence.**

```
lib/scheduleReflow.ts:352 verbatim: `if (finish.has(pred)) req = Math.max(req, finish.get(pred)! + DAY_MS);`. Every fixture in dependencies.test.ts uses midnight-only dates (`const d = (s: string) => ${s}T00:00:00.000Z`, :5), where +DAY_MS coincides with "the next day", so the suite cannot see the clock-time behaviour. Distinct from SCH-8 in audit-reports/projects-tab/06-schedule-engine.md, which covers relationship type and lag being discarded at parse time — this is the engine's own semantics for a plain zero-lag FS link.
```

> **Verifier correction.** One scoping nuance: cascadeDependents only runs on a move (it is seeded from changedIds at :338), not at import, so a same-day-FS imported schedule is not inflated on ingest — it inflates the first time anyone drags anything upstream of it. That makes the defect latent rather than immediate, which supports MEDIUM.

**Done when.**

- [ ] The constraint is expressed as successor.start >= predecessor.finish (plus any stored lag), not predecessor.finish + 1 day
- [ ] Cascaded successors keep their original time-of-day rather than inheriting the predecessor's finish time
- [ ] A dependency test fixture uses 08:00/17:00 times and asserts the successor's clock time is unchanged

---

<a id="sched-14"></a>

## SCHED-14 · effectiveWeight mixes work hours and unit weights in the same denominator, so tagging a few tasks with hours silently re-weights the whole project

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/scheduleProgress.ts:41-50`, `lib/scheduleProgress.ts:141`, `lib/scheduleProgress.ts:159-165`, `lib/executionReport.ts:158-159`, `lib/milestones.ts:663-669`, `components/projects/TaskDetailPanel.tsx:520`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Premise verified: no parser populates durationHours (grep of lib/scheduleParsers.ts shows only the type declaration at line 52 and `weight: 1` literals at 308/359/406/495/550), so the only source is the manual 'Work hours' field at components/projects/TaskDetailPanel.tsx:520 — exactly the 'tag a few tasks' scenario the finding describes, and nothing warns that doing so re-weights every other rollup.

**Mechanism.** effectiveWeight resolves per node, not per list: `const d = m.durationHours; if (d != null && Number.isFinite(d) && d > 0) return d; const w = m.weight; if (w != null && ... w > 0) return w; return 1;` (:45-49). The values it returns are in incompatible units — hours for rows that carry duration_hours, an abstract weight (import always writes 1, scheduleParsers.ts:308 etc.) for rows that do not — and every consumer sums them into one denominator: `wsum += w; wpct += w * lp` (executionReport.ts:159, scheduleProgress.ts:163, milestones.ts:663-669 for SPI and earned value). Because no parser populates durationHours (finding 3), the mixed state is exactly what a planner produces by filling in the "Work hours" field (TaskDetailPanel.tsx:520) on the tasks they care about.

**Failure scenario.** A planner tags the eight biggest jobs on a 400-task turnaround with their real hours (say 40h each) and leaves the rest untouched. Those eight now carry weight 40 against 392 rows carrying weight 1: 320 of 712 total weight, 45% of the project, sits on 2% of the tasks. Overall completion, every phase's pctComplete, SPI and earned value swing by tens of points the moment those eight tasks change state — and the number is presented as "Earned weight" (ScheduleProgress.tsx:71) with no indication that the weighting basis is inconsistent across rows. The prior audit's "verified sound" note (division by zero is unreachable) is about a different property and does not cover this.

**Evidence.**

```
lib/scheduleProgress.ts:44-50 verbatim, showing the per-node fallback chain; lib/executionReport.ts:158-159 verbatim: `const w = effectiveWeight(m);\n    wsum += w; wpct += w * lp;`. The tests pin only the homogeneous cases — "prefers work hours" (scheduleProgress.test.ts:35) and "falls back to weight then 1" (:38) — never a list containing both kinds.
```

> **Verifier correction.** Scope note: the Report's separate "Work hours" card is NOT affected — executionReport.ts:106 `hoursOf` returns 0 for a missing durationHours rather than falling back to weight, so plannedHours/earnedHours stay in pure hours. The unit-mixing is confined to effectiveWeight's consumers: the percent rollups, overallPercent, and the SPI/earned-value block.

**Done when.**

- [ ] The weighting basis is chosen once per list: use hours only if every leaf has them, otherwise use weight for all
- [ ] When the basis falls back, the UI says which basis is in use
- [ ] A test mixes an hours-bearing leaf with a weight-only leaf and asserts the chosen basis is uniform

---
