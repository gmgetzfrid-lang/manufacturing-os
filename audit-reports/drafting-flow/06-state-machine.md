# 06 · State machine & transition integrity

**16 findings** — 2 CRITICAL · 2 HIGH · 5 MEDIUM · 7 LOW. *(Corrected at the DF-P16 integrator fix pass, 2026-10-20: this line read "13 findings — 2 CRITICAL · 3 HIGH · 8 MEDIUM", stale against the findings below — their own Severity lines, `SM-14`, `SM-15` and `SM-16` included.)*

Whether the flow's own rules can be enforced at all: reachable transitions, concurrency, partial failure, and the actions that skip the gates.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded here. Severities marked by that pass override the original.


---


<a id="sm-1"></a>

## SM-1 · "Approve with Minor Correction" is a complete bypass of the engineer sign-off gate — the very requester the gate blocks can issue for construction with it

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/workflow.ts:198-234`, `lib/workflow.ts:222-228`, `lib/ticketTransitions.ts:221-235`, `lib/__tests__/workflow.test.ts:163-175`, `app/api/tickets/workflow-action/route.ts:96-103`
- **Same root cause as** `AUTHZ-1` — Also owned as `TIER-7` in [`01-review-tiering.md`](./01-review-tiering.md), which frames the fix. `GAP-111` requires it inside the delivery gate. Fix once; close the rest citing this one.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed and frozen by test: lib/__tests__/workflow.test.ts:163-171 asserts `expect(actionsOf(t, "Viewer", "u-1")).toContain("approve_minor_correction")` for a Viewer-role requester whose own ticket shows 'Send for Engineer Final Approval'. The same actor the gate blocks reaches PENDING_IFC with an issued integer rev and no engineer sign-off stamp. CRITICAL sustained.

**Mechanism.** At PENDING_REVIEW, getActions splits on `needsEngineerApproval && !isEng`. A viewer-tier requester is deliberately denied `approve_draft_ifc` and given only `request_final_engineer_approval` ("Engineering policy: drawings must be signed off by a qualified engineer before IFC"). But `approve_minor_correction` is pushed UNCONDITIONALLY after that if/else, for every requester tier. In computeTransition the two actions are byte-for-byte equivalent in outcome: `approve_draft_ifc` sets `updates.status = "PENDING_IFC"; updates.deliverable_rev = issuedRevLabel(...)`, and `approve_minor_correction` sets exactly the same two fields. The only differences are the history string and that the drafter is put in unread_by. The server route is not a second gate — it re-derives the same `getActions` list, so it offers the same escape hatch.

**Failure scenario.** An operations coordinator (Viewer role) raises a request for a P&ID revision. The drafter submits Rev 1A. The UI correctly refuses to let her approve it and shows "Send for Engineer Final Approval". She instead clicks the button directly beneath it, "Approve with Minor Correction", types "fix the tag on V-101", and the ticket jumps to PENDING_IFC with deliverable_rev "1". No engineer ever opened it. The drafter issues the IFC package, /api/verify-ticket reports the field print as verdict "current", and an unreviewed construction package is in the field with a QR badge asserting it is the latest issue.

**Evidence.**

lib/workflow.ts:199-234 —
```
if (canActAsRequester) {
  if (needsEngineerApproval && !isEng) {
    // Viewer-tier requesters can't sign off on engineering work.
    actions.push({ label: 'Send for Engineer Final Approval', action: 'request_final_engineer_approval', ... });
  } else {
    actions.push({ label: 'Approve (Issue for Construction)', action: 'approve_draft_ifc', ... });
  }
  // The "fix this typo and it's approved" fast path ...
  // Available to every requester tier by design.
  actions.push({ label: 'Approve with Minor Correction', action: 'approve_minor_correction', ... });
```
lib/ticketTransitions.ts:221-235 —
```
case "approve_draft_ifc":
  updates.status = "PENDING_IFC";
  updates.deliverable_rev = issuedRevLabel(ticket.revisionCount);
  ...
case "approve_minor_correction":
  updates.status = "PENDING_IFC";
  updates.deliverable_rev = issuedRevLabel(ticket.revisionCount);
```
And the behaviour is frozen as intended in lib/__tests__/workflow.test.ts:166-168 —
```
// Viewer-tier requester: normally can't self-approve, but CAN fast-approve
expect(actionsOf(t, "Viewer", "u-1")).toContain("approve_minor_correction");
```

**Chain reaction.** Because the bypass lands in PENDING_IFC with an issued (letterless) deliverable_rev, every downstream consumer treats it as engineer-approved: submit_final produces the FINAL_DRAFT package, the QR stamp carries the issued rev, and /api/verify-ticket (app/api/verify-ticket/route.ts:82-83) returns verdict "current" purely from `deliverable_rev` — it never checks `engineer_approved_at`. The audit_logs row records TICKET_APPROVE_MINOR_CORRECTION, so a PSM auditor reconstructing the approval chain finds an approval by a Viewer and no engineer record at all.

**Done when.**

- [ ] `approve_minor_correction` is gated by the same `needsEngineerApproval && !isEng` test as `approve_draft_ifc`: when an engineer is required, a viewer-tier requester's minor-correction path routes to PENDING_FINAL_APPROVAL (carrying the note), not PENDING_IFC
- [ ] lib/__tests__/workflow.test.ts asserts that a Viewer requester on a Viewer-raised ticket at PENDING_REVIEW gets NO action whose computeTransition result is `status === 'PENDING_IFC'`
- [ ] a computeTransition test asserts that no transition can set status to PENDING_IFC unless the acting role satisfies the engineer requirement for that ticket's requesterRole

**Resolution (2026-10-02, drafting-flow Round G).** Record-only close by pointer to roles-and-permissions [`WF-3`](../roles-and-permissions/06-request-workflow.md) (`087a39c`, 2026-09-01), with the evidence recorded on [`AUTHZ-1`](./09-authority-surfaces.md#authz-1) — same root, re-verified against `f1ac550`, no application code changed. The test this finding names as frozen vulnerability is flipped: `lib/__tests__/workflow.test.ts:203` reads `expect(actionsOf(t, "Viewer", "u-1")).not.toContain("approve_minor_correction");` and `:204` `…toContain("request_final_engineer_approval")`. `lib/workflow.ts:376-389` gives the gated requester only `request_final_engineer_approval`; `approve_minor_correction` is pushed only beside `approve_draft_ifc` (`:390-410`). Mutation-checked (see AUTHZ-1).

**Done-when.**
- ✓ `approve_minor_correction` is gated by the same `needsEngineerApproval && !isEng` test as `approve_draft_ifc` (`lib/workflow.ts:376`); when an engineer is required the Viewer-tier requester's path is `request_final_engineer_approval`, which lands on `PENDING_FINAL_APPROVAL` carrying the note as `engineer_review_reason` (`lib/ticketTransitions.ts:301-311`; asserted at `lib/__tests__/dfRoundG_P0.test.ts:145`). The note is carried when sent, but required only by the browser (review fix pass): `EngineerPickerModal`'s `requireComment` default enforces it (`components/requests/EngineerPickerModal.tsx:64`, `:155`), the engine action has no `requiresComment` (`lib/workflow.ts:382-388`), so a direct POST without one reaches `PENDING_FINAL_APPROVAL` with a `null` reason — the engineer gate holds; the missing server-side requirement is requested as a new id (proposed `AUTHZ-14`, DF-P1; see `AUTHZ-1`).
- ✓ A Viewer requester on a Viewer-raised ticket at `PENDING_REVIEW` gets no action whose `computeTransition` result is `PENDING_IFC` — asserted for Viewer and every other gated role at `lib/__tests__/dfRoundG_P0.test.ts:145`. The assertion lives in the new `lib/__tests__/dfRoundG_P0.test.ts` rather than in `lib/__tests__/workflow.test.ts` (which keeps the action-level pin) so this records package does not edit a test file the DF-P1 → DF-P8 chain rewrites.
- ✓ No transition reaches `PENDING_IFC` unless the actor satisfies the engineer requirement: `computeTransition` is role-blind by design (the engine is the gate), so the guarantee is proved on the pair — `lib/__tests__/dfRoundG_P0.test.ts:166` walks every role × identity (requester, assigned drafter, assigned engineer, stranger) × collection (headline, headline + Engineer-2) at `PENDING_REVIEW` and `PENDING_FINAL_APPROVAL` on tickets raised under every gated role, and every `PENDING_IFC` outcome belongs to a gate-exempt collection or to the assigned engineer (whose pick the route requires to hold an Engineer role, `app/api/tickets/workflow-action/route.ts:241-246`, and to be independent at 3+ members, `:265-275`).

**Scope / residual.** None on the minor-correction bypass this finding is about. `/api/verify-ticket` still derives "current" from the label, not from `engineer_approved_at` — that verdict is DF-P10's (`EDGE-2`). With the bypass closed, an issued label implies an approval the gate admitted **on the row as it stood when the approval was taken** — and two of the columns the gate reads, `request_type` and `unit`, are client-writable until DF-P1: wherever an org scopes the engineer gate or direct approval by type or unit, a member who re-types or re-units the row reaches the same outcome as this finding's bypass, an issue for construction with no engineer. That path is not this finding's and is not covered by this close: it is [`LEAK-10`](./04-flow-leaks.md#leak-10) (HIGH, OPEN, DF-P1). *(Records fix, 2026-10-02: this line read "None here … an issued label implies an approval the gate admitted" with no qualification.)*

---

<a id="sm-2"></a>

## SM-2 · RLS on `tickets` is a blanket FOR ALL grant — any active org member can rewrite `status` directly and skip the state machine, the capability policy, the CAS and the audit log entirely

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1080-1081`, `supabase/schema.sql:405`, `app/api/tickets/workflow-action/route.ts:15-26`, `app/(protected)/requests/page.tsx:620`, `app/(protected)/requests/[id]/page.tsx:1328`
- **Same root cause as** `PERS-1`, `AUTHZ-2`, `EVID-1` — One `CREATE POLICY ... FOR ALL USING (...)` with no `WITH CHECK` (`supabase/schema.sql:1079-1081`). Four lenses found it independently. **One migration closes all four.** Fix once; close the rest citing this one.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence search: no second policy, no REVOKE/column grant, no status-transition trigger. The app itself proves the write path is open to the anon key — app/(protected)/requests/[id]/page.tsx:1327 `await supabase.from("tickets").update({ watchers: next }).eq("id", ticketId);` runs client-side under exactly this policy. The server enforcement in /api/tickets/workflow-action (route.ts:15-26, 96-103) is therefore bypassable, and with it the CAS, the audit_logs insert and the fan-out.

**Mechanism.** `tickets` has exactly one policy, `FOR ALL USING (org_id IN (SELECT my_org_ids()))`, with no WITH CHECK and no column-level GRANT restrictions. Postgres reuses the USING expression as the WITH CHECK for UPDATE, so the only constraint on an update is that the row stays inside one of the caller's orgs. Every authenticated member of the workspace — Viewer, Contractor, Auditor included — holds UPDATE on every column of every ticket in their org through the anon-key REST endpoint. The workflow-action route's careful chain (auth → active membership → `WorkflowEngine.getActions` with the org's capability policy → compare-and-set → audit row → fan-out) is entirely optional: it is one door into a room with no walls. The app's own client code demonstrates the direct-write path works (`supabase.from('tickets').update({ priority: 1, last_modified: now })` at requests/page.tsx:620, `.update({ watchers: next })` at requests/[id]/page.tsx:1328).

**Failure scenario.** A contractor with a Viewer seat opens devtools on the requests page, copies the Supabase URL and anon key already present in the bundle, and issues `PATCH /rest/v1/tickets?id=eq.<uuid>` with `{"status":"PENDING_IFC","deliverable_rev":"2"}`. The ticket now shows as approved for construction. No audit_logs row exists (that insert only happens inside the route), no notification fires, and the ticket page renders the drafter's "ISSUE FINAL IFC PACKAGE" button because getActions is driven purely off `ticket.status`. The drafter, seeing a normal-looking approved ticket, issues the package.

**Evidence.**

supabase/schema.sql:1079-1081 —
```
-- Tickets
CREATE POLICY "tickets_org_access" ON tickets FOR ALL
  USING (org_id IN (SELECT my_org_ids()));
```
Contrast the route's own stated contract, app/api/tickets/workflow-action/route.ts:17-26 —
```
// SERVER-SIDE workflow enforcement. The client sends only its inputs ...
//   3. validates the action against WorkflowEngine.getActions — the same
//      state machine the UI renders, now enforced where the client can't lie
```

**Chain reaction.** Because the direct write bypasses `computeTransition`, none of the invariants it maintains hold: `history` gets no entry, `revision_count`/`draft_iteration` desynchronise from `deliverable_rev`, `closed_at` is never stamped (so lib/ticketShed.ts's archive-eligibility clock reads the wrong date), and `unread_by`/`watchers` fan-out never happens so nobody is told. The `audit_logs` table — the artifact an OSHA PSM audit actually reads — silently under-reports every transition performed this way.

**Done when.**

- [ ] The `tickets_org_access` policy is split: SELECT stays org-wide; INSERT is constrained to the creating user; UPDATE is either revoked from `authenticated` entirely (all writes through service-role routes) or restricted so that `status`, `deliverable_rev`, `revision_count`, `assigned_*`, `engineer_approved_at`, `archived_at` and `archive_id` cannot be changed by a client (e.g. a BEFORE UPDATE trigger that raises unless `current_setting('role') = 'service_role'`)
- [ ] Every remaining client-side `supabase.from('tickets').update(...)` call site is moved behind an API route or is provably limited to columns the DB permits
- [ ] A test (or a SQL assertion in the migration) proves a plain `authenticated` role cannot change `tickets.status`

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. Half closed by roles-and-permissions [`WF-2`](../roles-and-permissions/06-request-workflow.md) / migration `20261038` (landed `087a39c`; **applied & verified live 2026-09-01** — MIGRATION-PASTE-ORDER row 40 LIVE, with the `20261039` column repair, row 41 LIVE); stays OPEN on the residual the fleet plan hands to **DF-P1** (under `SM-9`).
- Holds: `trg_ticket_update_guard` (`supabase/migrations/20261038_rp_phase4_ticket_workflow_rails.sql:176-225`) raises on any client (`auth.uid() IS NOT NULL`) change to 22 workflow-owned columns, including every one this finding names — `status` (`:186`), `assigned_drafter_id`/`_name` and the engineer trio (`:191-195`), `engineer_approved_at` (`:197`), `deliverable_rev` (`:199`), `revision_count` (`:201`), `archived_at` (`:203`), `archive_id` (`:204`) — and refuses a shrinking `history` (`:213-216`); `ticket_insert_integrity` (`:110-168`) forces `requester_id := auth.uid()` and `status := 'PENDING_ASSIGNMENT'` on client inserts; `tickets_delete_controllers` (`:228-231`) is RESTRICTIVE.
- Does not: `tickets_org_access` is still `CREATE POLICY "tickets_org_access" ON tickets FOR ALL USING (org_id IN (SELECT my_org_ids()));` (`supabase/schema.sql:1118-1119`; no migration replaces it). A member can still rewrite existing `history` entries in place at equal-or-greater length, and write directly — outside the route's compare-and-set and audit row — **every column the guard does not list** (its 22 are `org_id` … `created_at`, `20261038:184-205`). Against the `tickets` definition (`supabase/schema.sql:435-483`) plus the columns migrations add, that is: `id`, `title`, `description`, `unit`, `request_type`, `priority`, `attachments`, `comments`, `history` (in place), `metadata`, `unread_by`, `watchers`, `search_keywords`, `search_tsv` (its refresh trigger fires only on updates of its source columns, `supabase/migrations/20260610_phase2_search_completion.sql:90-93`), `target_completion_at`, `sla_breach_warned_at`, `sla_breached_at`, `last_modified` and `updated_at` — 19 columns, which with the guard's 22 are all 41 (the 38 of `supabase/schema.sql:435-483` plus `deliverable_rev`, `draft_iteration` and `search_tsv` from migrations) (review fix pass: the first census named eight; records fix: this one omitted `id`). `id` is the primary key: a client UPDATE of it is refused only while a row references the ticket through a foreign key (`ticket_comments.ticket_id`, `checkout_sessions.linked_ticket_id`, `milestones.linked_ticket_id`, `document_holds.origin_ticket_id` — all the default `NO ACTION` on update); otherwise a member can re-key a ticket and strand every reference that carries no foreign key (`document_intents.ticket_id`, the `audit_logs` rows, notification metadata). Three matter most: `request_type` and `unit` are the whole `DEC-13` resource every scoped capability rule reads (`ticketResource()`, `lib/workflow.ts:60-61`; [`LEAK-10`](./04-flow-leaks.md#leak-10), and `LEAK-3` for the close-without-review edge); `last_modified` is the compare-and-set token itself (`EDGE-11`, proposed `EDGE-15`); and `title` / `description` are the request's approved scope, rewritable after issue with no history line (`EVID-1`). The SLA clocks are client-writable too, so a member can silence an SLA warning or breach.

**Done-when.**
- ✓ (in part) SELECT stays org-wide; INSERT is constrained to the creating user (by trigger); a client UPDATE of `status`, `deliverable_rev`, `revision_count`, `assigned_*`, `engineer_approved_at`, `archived_at`, `archive_id` raises (by trigger). The policy itself is not split — that is `PERS-1` done-when 3, residual below.
- ✓ Every remaining client `tickets.update(...)` touches only unguarded columns: `app/(protected)/requests/page.tsx:655` and `:674` (`priority`, `last_modified`), `app/(protected)/requests/[id]/page.tsx:977` (`unread_by`), and `lib/projects.ts:1599` (`history` append inside `convertTicketToProject`, which has no caller in `app/` or `components/`).
- ✓ (shape, not live) `lib/__tests__/rpPhase4Migration.test.ts:153` pins the guarded column list (with `status`), `:160` the shrink block, `:174` that `priority`/`comments`/`attachments`/`watchers`/`unread_by`/`last_modified`/`metadata` are *not* guarded; the migration's own probe proved the trigger installed live. There is no database in CI, so no live refusal test — recorded as the evidence form, as WF-2 did.

**Scope / residual.** Handed on, binding (fleet plan): existing `history` entries are rewritable in place and `attachments` / `comments` / `metadata` stay client-writable → **DF-P1** (`ticket_update_guard` re-created from its newest body with append-only history and service-role-only arrays, lineDiff-pinned). Found on HEAD and not named in the plan: `request_type` and `unit` are also unguarded on UPDATE, which keeps `LEAK-3` open and is `LEAK-10` (opened at the DF-P0 merge with the `DEC-13` consequences, same owner); a member can null `last_modified`, which drops the CAS's second leg (`EDGE-11`; a new id is requested, proposed `EDGE-15`, same owner); and the rest of the census above. DF-P1 decides each unguarded column — workflow-owned, service-only, or deliberately client-writable — at minimum `title` / `description` once the request is approved, the SLA clocks and `last_modified` (`99-fix-sequencing.md`, "Hand-offs from DF-P0", the `SM-2` column-census row; DF-P1's brief names history and the arrays only). No migration was needed or written here.

**Resolution (2026-10-02, drafting-flow Round G).** DF-P1 RAILS — the residual above, closed in the code that decides it; **Pending migration:** `supabase/migrations/20261166_df_roundG_ticket_rails.sql` (`DEC-30`: one paste, not a widening, after `20261038` / `20261039`, and after the DF-P1 app deploy, never before it: `AUTHZ-13`, "Paste order") — the database half is not closed in any database until it is pasted. `ticket_update_guard` re-created from its newest body (`20261038`, found by scanning the numbered migrations; every base line kept byte for byte, the added lines exactly DF-P1's — lineDiff and byte-cut pinned, `lib/__tests__/dfRoundG_P1_rails.test.ts:85`, `:118`) now decides every one of the 41 `tickets` columns for a client caller (`auth.uid() IS NOT NULL`; the service role passes as before):
- **Refused (37).** The 22 `20261038` already owned, unchanged, plus 15 added at `supabase/migrations/20261166_df_roundG_ticket_rails.sql:264-287` — `id`, `title`, `description`, `request_type`, `unit` (the whole `DEC-13` resource: `LEAK-10`, `LEAK-3`, `AUTHZ-6`), `attachments`, `comments`, `metadata` (`DCW-4` / `HAND-3`'s deliverable state, `SM-14`'s source document), `watchers`, `search_keywords`, `search_tsv`, `target_completion_at`, `sla_breach_warned_at`, `sla_breached_at`, `updated_at`.
- **Client-writable in the shape the app still uses (4).** `priority` (the queue's mark-urgent, free); `last_modified` (stamped, never cleared — `:333-338`, `EDGE-15`); `unread_by` (any client write lands as the stored array minus the caller, so only the caller's own marker leaves and nobody joins; never an error, so the page's stale-array mark-read still clears the caller's marker — `:323-331`; *DF-P1 fix pass, 2026-10-02: the first draft raised when the written array held a reader no longer in the stored one, which left a stale page's own marker in place*); `history` (append-only: the entries already there are immutable, and an appended entry must name the caller by member email or uid — `:293-321`).
- **The policy** is split per verb with its WITH CHECKs written down (`PERS-1` done-when 3, `:354-377`).
- Census: `lib/__tests__/dfRoundG_P1_rails.test.ts:130` (every column decided, none twice, 37 + 4 = 41), `:389` (every browser `UPDATE` of `tickets` in `app/`, `lib/`, `components/`, `hooks/` touches only the four client-shaped columns; the three inserts are the creators). Exercised on a throwaway PostgreSQL 16 built from the real function bodies, in both foreign-key worlds (orphan intents present / absent), the script applied four times in each (idempotent; 13 of 13 probes true every time): a member's change to each of the 15 added columns and to `status` / `deliverable_rev` is refused (cases C11 — e.g. "tickets: column(s) status, search_tsv are workflow-owned — use the request workflow actions"; `search_tsv` is listed beside a source column because the search trigger recomputes it first, same refusal); mark-urgent, the page's mark-read and an own-name history append pass (C01, C02, C06); the service role writes every column (C12). Re-run after the fix pass (same two worlds, four applies each, 13 of 13 every time): a stale mark-read array clears only the caller's marker (C03); an array that adds a reader lands as the stored array minus the caller, not an error (C04); the reviewer's interleaving, where another reader marks it read first and the caller then writes the array it loaded, still clears the caller's marker and re-adds nobody (C04b); a member not in the array changes nothing (C04c).

**Done-when.**
- ✓ SELECT stays org-wide (`AUTHZ-13` narrows only a Contractor-only collection — `DEC-89`); INSERT is constrained to the creating user (the `20261038` trigger, and now `tickets_org_insert`'s WITH CHECK `requester_id = auth.uid()`); a client UPDATE of `status`, `deliverable_rev`, `revision_count`, `assigned_*`, `engineer_approved_at`, `archived_at`, `archive_id` — and of every other column but the four above — raises; the FOR ALL policy is gone.
- ✓ Every remaining client `tickets.update(...)` is provably limited to columns the database permits: `app/(protected)/requests/page.tsx:655`, `:674` (`priority`, `last_modified`), `app/(protected)/requests/[id]/page.tsx:977` (`unread_by`, own marker), `lib/projects.ts:1599` (an own-name `history` append, dormant) — pinned by the census test, and anything else raises.
- ✓ (shape + scratch database; there is no database in CI) The migration's probes assert the 15 added refusals and the 22 kept (``supabase/migrations/20261166_df_roundG_ticket_rails.sql`` final SELECT, rows 1-2); the scratch run shows a plain `authenticated` member's `status` change refused.

**Scope / residual.** None for this finding. ⚠ For the integrator: DF-P3 / P4 / P6 / P7 / P8 each re-create `ticket_update_guard` from **this** body; `20261038` must never be re-pasted after `20261166` (it would drop every rail above — the migration header says so). The dormant `lib/projects.ts` history push is `EVID-1`'s project-link limb (DF-P8).

---

<a id="sm-3"></a>

## SM-3 · A Manager or Supervisor with no engineering role can perform the engineer sign-off and have `engineer_approved_at` stamped in their name

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/workflow.ts:263-298`, `lib/workflow.ts:65-66`, `lib/ticketTransitions.ts:247-253`, `app/api/tickets/workflow-action/route.ts:113-132`, `lib/capabilityPolicy.ts:55-60`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the misattribution is visible in the UI: app/(protected)/requests/[id]/page.tsx:1744-1748 renders `ticket.assignedEngineerName` with an 'approved' badge keyed off `ticket.engineerApprovedAt`, so a Supervisor's click displays as the assigned engineer having signed off. HIGH sustained.

**Mechanism.** At PENDING_FINAL_APPROVAL, `canActHere = ticket.assignedEngineerId ? isAssignedEngineerIdentity || isManagement : allows('ticket.final_approve') || isManagement`, where `isManagement = allows('ticket.manage')` and `ticket.manage` defaults to `["Admin", "Manager", "Supervisor"]`. So any Manager or Supervisor can fire `engineer_approve_final`, whose button reads "Approve as Engineer (Issue for Construction)" and whose transition writes `updates.engineer_approved_at = now`. There is no check anywhere that the ACTOR holds an Engineer role. The asymmetry is stark: the route does check that a *picked* reviewer holds an Engineer role (lines 124-131, "The selected reviewer does not hold an Engineer role"), but never applies the same test to the person actually signing off.

**Failure scenario.** A viewer-tier requester correctly routes a drawing to Engineer-2 for final approval. Engineer-2 is on shift change. The area Supervisor, wanting the job to start, opens the ticket, sees "Approve as Engineer (Issue for Construction)" and clicks it. `engineer_approved_at` is stamped, the ticket goes to PENDING_IFC with an issued rev, and the record now asserts an engineering sign-off that no engineer performed. The stamped/QR-verified print in the field carries that authority.

**Evidence.**

lib/workflow.ts:264-273 —
```
const canActHere = ticket.assignedEngineerId
  ? isAssignedEngineerIdentity || isManagement
  : allows('ticket.final_approve') || isManagement;
if (canActHere) {
  actions.push({
    label: 'Approve as Engineer (Issue for Construction)',
    action: 'engineer_approve_final',
```
lib/ticketTransitions.ts:247-249 —
```
case "engineer_approve_final":
  updates.status = "PENDING_IFC";
  updates.engineer_approved_at = now;
```
vs. the guard that DOES exist, app/api/tickets/workflow-action/route.ts:128-130 —
```
if (!held.some((r) => r.includes("Engineer"))) {
  return NextResponse.json({ error: "The selected reviewer does not hold an Engineer role" }, { status: 400 });
}
```

**Chain reaction.** `engineer_approved_at` is the only machine-readable evidence in the schema that an engineer signed off. Once a non-engineer can set it, no downstream consumer can distinguish a genuine sign-off from a management override — including any future report or export built on that column. The management override is also not recorded as an override: the audit_logs `details` records only `{from, to, label}`, not that the actor lacked the engineering role.

> **Verifier correction.** engineer_approved_at is a timestamp, not a name. The misattribution is in the UI: requests/[id]/page.tsx:1743-1747 shows `assignedEngineerName` + "APPROVED" once engineerApprovedAt is set, so a manager's click renders as the assigned engineer's sign-off. The actor's true role is still recorded in audit_logs (route.ts:214-223) and in the history entry.

**Done when.**

- [ ] `engineer_approve_final` requires `isEngineerRole(userRole)` (or an explicit, separately-named `ticket.engineer_override` capability) in addition to the identity/management check
- [ ] When a non-engineer uses a management override at PENDING_FINAL_APPROVAL, the action is a distinctly-labelled one that does NOT write `engineer_approved_at`, and the audit row records the override explicitly
- [ ] lib/__tests__/workflow.test.ts asserts a Supervisor at PENDING_FINAL_APPROVAL does not receive `engineer_approve_final`

**Resolution (2026-10-21, drafting-flow Round G).** DF-P6 REVIEW-MODEL, under the integrator's ruling for this package (DEC-90 ruling (3): management may still override; recorded as an override in history and in the audit row as `authority.override`; `engineer_approved_at` is stamped only for a signer who holds an Engineer role or occupies the engineering slot; the seed stays today's serial path). Reproduced on the base: `lib/workflow.ts` `PENDING_FINAL_APPROVAL` offered `engineer_approve_final` to the assigned engineer OR any `ticket.final_approve` / management holder, and `lib/ticketTransitions.ts` stamped `engineer_approved_at` for all of them.

Landed:
- `lib/workflow.ts` (`:859`): the engineer's sign-off (`engineer_approve_final`) is offered only to the assigned engineer, a holder of an Engineer role, or — with no engineer assigned — a `ticket.final_approve` holder (the occupant of the engineering slot). Any other management actor gets **`override_engineer_final`** — "Override: Issue Without Engineer Sign-off", warning variant, `engineeringOverride: true`.
- `lib/ticketTransitions.ts` (`:672`): the override issues exactly as the sign-off does (`PENDING_IFC`, the issued Rev) but never writes `engineer_approved_at`, and its history line says "Management override — issued without the engineer's sign-off". A management minor correction at final approval is the same override (no stamp).
- `app/api/tickets/workflow-action/route.ts`: an action marked `engineeringOverride` writes `authority.override = { of: "engineering_sign_off", reason }` in its audit row (beside `authority.via`, the grants, the identity and the roles — `authority` stays an object) *(corrected at fix pass 3, DEC-29: first recorded as `authority: "override"`)*; the override is an approving action for the routing, notification and roster rules (`classifyTransitionNotification`).

Tests: `lib/__tests__/reviewModel.test.ts` "SM-3 — only an engineer signs as the engineer …" (a Supervisor and a Manager at `PENDING_FINAL_APPROVAL` are not offered `engineer_approve_final`; the assigned engineer and an Engineer-holding manager are); `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "SM-3 — …" (refused at the route; the override's audit row names the override; the assigned engineer still stamps — REGRESSION); `capabilityPolicy.test.ts` re-pinned (Manager → `override_engineer_final`).

**Done-when.**
- ✓ `engineer_approve_final` requires an Engineer role, the assigned engineer's identity, or occupancy of the unassigned engineering slot (`ticket.final_approve`) — the separately named path for everyone else is `override_engineer_final`.
- ✓ The non-engineer management path is distinctly labelled, does not write `engineer_approved_at`, and the audit row records the override (`authority.override.of = "engineering_sign_off"`, with its reason — corrected at fix pass 3, DEC-29: first written `authority: "override"`, a shape the route never wrote).
- ✓ A test asserts a Supervisor at `PENDING_FINAL_APPROVAL` does not receive `engineer_approve_final` (`lib/__tests__/reviewModel.test.ts`; the named file `workflow.test.ts` is unchanged — the assertion lives with the review model's tests).

**Scope / residual.** The only difference an unconfigured workspace sees is the renamed management button at `PENDING_FINAL_APPROVAL` (same effect, no engineer stamp). No new capability was added (a `ticket.engineer_override` token was not needed: management keeps the override through `ticket.manage`).

**Fix pass (2026-10-21, drafting-flow Round G — DF-P6 review).** (a) The override is never the requester's own in a workspace of 3+ while an engineer can be picked, on a request the column says requires engineering: `override_engineer_final` and the management minor correction render disabled with `SELF_OVERRIDE_REASON` and the route refuses them (403) — another manager's stands (`TIER-1` fix pass). (b) An override is shown as one: the transition writes `metadata.engineering_override` (`{ by, uid, at, action }`), and `lib/reviewModel.ts` `engineeringOverrideOf` (the marker, else the override's history line for overrides recorded before it; an engineer's later sign-off wins) drives the request page's Engineer Reviewer card ("Issued by management override — no engineer sign-off" instead of a pulsing "pending") and the seeded roster (`lib/routingControl.ts` `seededSlotsFor` state `overridden` on an issued or closed request). Tests: `lib/__tests__/reviewModel.test.ts` "fix pass (review, issue 7) …" and "fix pass (review, issues 1 and 2) …"; `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "fix pass (review) — the requester's own override, at the route".

**Fix pass 2 (2026-10-21, drafting-flow Round G — DF-P6 second review).** *Correction (DEC-29) of the Scope line above, "the only difference an unconfigured workspace sees is the renamed management button": after `20261250` is pasted an unconfigured workspace also sees (i) an override shown as one — the Engineer Reviewer card and the seeded roster say "issued by management override — no engineer sign-off" / `overridden`, and the evidence pack shows no engineer approval for it; and (ii) on a request FILED under the review model (`tickets.review_model_filed`, new in this pass) whose column requires engineering, the requester's own override disabled in orgs of 3+ while an engineer can be picked. A request filed before the paste keeps its requester's paths whatever the backfill wrote (`TIER-1` fix pass 2 — pinned against the base engine). (iii) A later issue that is not an override clears the marker (`metadata.engineering_override: null`, written by `lib/ticketTransitions.ts` on any non-override move to `PENDING_IFC`; `engineeringOverrideOf` reads a cleared marker as "no override" and no longer falls back to the old history line) — review minor 6.* Tests: `lib/__tests__/reviewModel.test.ts` "fix pass 2 (review, issue 1) …", "fix pass 2 (review, minor 6) …"; `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "fix pass 2 (review, issue 1) — at the route …".

**Fix pass 3 (2026-10-21, drafting-flow Round G — DF-P6 third review).** (a) The `PENDING_REVIEW` co-review override (DEC-90 ruling (3): a co-reviewer holding no Engineer role who approves a request that requires engineering) is now SAID before the click, as the `PENDING_FINAL_APPROVAL` override is: `lib/workflow.ts` labels it "Override: Approve Without Engineer Sign-off" (warning variant) and "Override: Approve with Minor Correction", each described as a management override recorded in the history and the audit trail with the engineering sign-off unrecorded (`CO_REVIEW_OVERRIDE_NOTE`). Before, the button read "Approve (Issue for Construction)" while the transition wrote the override note, the marker and `authority.override` — on pre-paste tickets too. Actions, disabled reasons and optional flags are unchanged (the golden snapshot compares those). (b) Records corrected (DEC-29): the audit field is `authority.override` (`{ of: "engineering_sign_off", reason }`), not `authority: "override"` — the two Landed / Done-when lines above are corrected in place. Tests: `lib/__tests__/reviewModel.test.ts` "fix pass 3 (review, minors) — an override and a binding flag are SAID before the click" (the wording pinned; an Engineer co-reviewer keeps today's label).

**Fix pass 4 (2026-10-21, drafting-flow Round G — DF-P6 fourth review).** *Correction (DEC-29) of the fix pass's (a) above: the requester's own override is no longer disabled. It removed an override a legitimate manager uses today, against DEC-90 ruling (3) as given; DEC-90's proposed R1 is applied as its default.* (a) On a request filed under the review model that requires engineering, the requester holding `ticket.manage` takes `override_engineer_final` and the management minor correction at `PENDING_FINAL_APPROVAL` in every workspace size, with a required comment (`SELF_OVERRIDE_NOTE`), recorded as the override (history note, `metadata.engineering_override`, `authority.override`, whose reason names the self-override). (b) **An override only where engineering is required** (review minor 5): `lib/workflow.ts` marks the `PENDING_FINAL_APPROVAL` issue by someone who does not sign as the engineer an override only when the request requires engineering review. A request sent there without requiring it (a type-scoped `ticket.direct_approve` rule kept its exempt requester from approving) is issued by a manager NEUTRALLY: "Approve (Issue for Construction)", `withoutEngineerSignOff` (`lib/ticketTransitions.ts` `TransitionInput.withoutEngineerSignOff`, passed by the route), no `engineer_approved_at` (the minor correction included), no history note, no `metadata.engineering_override`, no `authority.override`. Tests: `lib/__tests__/reviewModel.test.ts` "fix pass 4 (review, major 2 …)" and "fix pass 4 (review, minor 5) …"; `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "fix pass 4 (review, major 2 …)". Done-when unchanged: ✓ all three (the non-engineer path where engineering is required is still `override_engineer_final`, recorded; where it is not required, nothing is overridden, so nothing is recorded as one).

**Fix pass 5 (2026-10-21, drafting-flow Round G — DF-P6 fifth review).** (a) The file viewer's green "Approve" (`app/(protected)/requests/[id]/page.tsx` FileViewerModal `onApprove`) takes only an `approve_draft_ifc` NOT marked `engineeringOverride` — a co-reviewer's override at `PENDING_REVIEW` (which needs no comment) can no longer run behind a plain label. (b) The neutral issue of (b) above now records why no sign-off is shown: `metadata.engineering_sign_off = { notRequired: true, … }` (`lib/ticketTransitions.ts`), read by `lib/reviewModel.ts` `engineeringSignOffNotRequiredOf`; the Engineer Reviewer card reads "not required — issued by …" in grey instead of a sign-off pending forever; an override, an engineer's sign-off or a later plain issue clears it. Tests: `lib/__tests__/reviewModel.test.ts` "fix pass 5 (review, major) …" and "fix pass 5 (review, minor) — a neutral final issue …". Done-when unchanged: ✓ all three.

---

<a id="sm-4"></a>

## SM-4 · Archive commit never re-checks status: a closed ticket that is reopened after "produce" has its entire comment thread, history and attachment binaries destroyed while it is live and in review

- **Severity:** HIGH
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P8 PROJECTS — done-whens 2 and 3 (in `app/api/tickets/**`: clear `archive_id` in the reopen / cancel-undo transitions; refuse an action on a row with a non-null `archive_id`) — assigned by the integrator at the DF-P11 merge, 2026-10-21, DEC-31 (DF-P8 is the next drafting-flow package that holds the workflow route; the integrator adds it to DF-P8's plan). Ruled by the integrator at the DF-P11 merge, 2026-10-21 (DEC-90).
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/ticket-shed/route.ts:131-146`, `app/api/admin/ticket-shed/commit/route.ts:125-172`, `lib/ticketTransitions.ts:288-290`, `app/api/tickets/workflow-action/route.ts:69-74`, `app/(protected)/admin/storage/page.tsx:520-585`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence search: nothing in the reopen path clears archive_id — the only writers of `archive_id: null` are /api/admin/archive-cancel and /api/admin/ticket-shed/restore. lib/ticketTransitions.ts:288-290 `case "reopen_ticket": updates.status = "PENDING_REVIEW";` leaves the claim intact, so a ticket reopened between produce and commit is live, in review, and still gets shredded.

**Mechanism.** `produce` claims eligible CLOSED tickets by stamping `archive_id` while leaving `archived_at` NULL — the ticket stays fully live. `commit` is a SEPARATE admin action taken later (the UI tells the admin to save the zip offline first, then click "Reclaim space"). commit then re-selects rows by `.eq("archive_id", archiveId)` ONLY — no status filter, no re-check that the ticket is still terminal — and for each unstamped row writes `{ comments: [], history: [], archived_at: now }` and deletes its `ticket_comments` rows and its R2 attachment objects. Meanwhile `reopen_ticket` in computeTransition sets only `updates.status = "PENDING_REVIEW"` (and clears `closed_at`); it does not clear `archive_id`, and the workflow route's archive guard at line 69 tests `archived_at` only, so reopening a claimed ticket is permitted. Nothing anywhere clears `archive_id` on reopen — the only writers of `archive_id: null` are archive-cancel, the produce un-claim loop, and restore.

**Failure scenario.** Friday: an admin runs the closed-ticket archive, which claims 400 tickets including KE-DDRT-26-0117 (a completed line-relocation package). Monday: the requester notices the as-built didn't match, opens KE-DDRT-26-0117 and clicks "Reopen Ticket"; it goes to PENDING_REVIEW, the drafter is re-engaged, a revision comment thread starts. Tuesday: the admin, having saved the zip, clicks "Reclaim space". commit sees archive_id still set, stamps archived_at, sets `comments: []` and `history: []`, deletes the ticket_comments rows, and issues DeleteObject on every attachment key — including the draft and IFC PDFs of the revision in flight. The ticket is now an archived stub with no history, and the only copy of the deliverable is inside a zip that was produced BEFORE the reopen, so it does not contain the new work at all.

**Evidence.**

app/api/admin/ticket-shed/commit/route.ts:125-129 (selection — no status predicate) —
```
const { data: rows } = await sb
  .from("tickets")
  .select("id, attachments, comments, history, metadata, archived_at")
  .eq("org_id", orgId)
  .eq("archive_id", archiveId);
```
and :157-166 (the destructive write, guarded only on archived_at) —
```
.update(
  { comments: [], history: [], metadata: { ...metadata, archive_summary: tombstone }, archived_at: now, archive_id: archiveId },
  { count: "exact" },
)
.eq("id", t.id).eq("org_id", orgId).is("archived_at", null);
```
lib/ticketTransitions.ts:288-290 —
```
case "reopen_ticket":
  updates.status = "PENDING_REVIEW";
  break;
```
app/api/tickets/workflow-action/route.ts:69 (guard reads archived_at, not archive_id) —
```
if ((row as { archived_at?: string | null }).archived_at) {
```

**Chain reaction.** commit's own comments call the loop "self-healing after a crash" and explicitly re-process rows already stamped, so re-running it re-deletes. The R2 deletes are unconditional on the reopened ticket's CURRENT attachment list (`keysFor(t)` reads the row as loaded at commit time), so files uploaded AFTER produce — the new revision's drafts — are deleted even though they were never bundled. `restore` cannot help: it only writes back keys the live stub records and requires the bytes to be present in the zip (route.ts:139-160), so the post-produce files come back as `filesMissing` and the ticket is left `partial`.

**Done when.**

- [ ] `ticket-shed/commit` filters its selection to `.in("status", TERMINAL_TICKET_STATUSES)` and re-verifies terminality immediately before each stamp, skipping (and reporting) any ticket that left terminal state since produce
- [ ] `reopen_ticket` (and any transition out of CLOSED/CANCELED) clears `archive_id` as part of the same atomic update in computeTransition
- [ ] The workflow-action archive guard rejects, or the transition clears, actions on a ticket with a non-null `archive_id`, so the two subsystems cannot both own the row
- [ ] A test covers produce → reopen → commit and asserts the ticket's comments/history/attachments survive

**Partial (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC — the shed's commit (the half this package owns). Reproduced on `29d92ac`: commit stamped and freed every captured ticket with no status read. Now (`app/api/admin/ticket-shed/commit/route.ts`):
- the captured tickets are re-read (`status`, `last_modified`, `:150`); any that left a terminal status, or was written after the archive was produced (`changedSinceCapture`, `lib/ticketShed.ts:158`, with a five-minute clock margin), is released from the shed (its `archive_id` cleared on a compare-and-set) and the call answers **409 `changed_since_capture`** naming the tickets — nothing is stamped or freed in that call; a re-run frees the rest;
- each stamp compare-and-sets on a terminal status (`.in("status", TERMINAL)`, `:236`) and the `last_modified` it read (the null its own leg, `:237`), so a reopen between the re-read and the stamp makes the stamp miss and frees nothing for that ticket.

**Done-when.**
- ✓ (in a stricter form) the commit filters to terminal tickets and re-verifies immediately before each stamp. A ticket that left terminal is reported by name — with the whole call refused rather than the rest committed, so an operator sees it before anything is freed (fail-safe).
- ✗ not done here: `reopen_ticket` clearing `archive_id`, and the workflow-action guard refusing a ticket with a non-null `archive_id`, are in `app/api/tickets/workflow-action/route.ts` / `lib/workflow.ts` — files this package may not edit this round. The commit-side refusal makes the destruction impossible on its own (a reopened ticket is never stamped or freed), but a reopened ticket keeps a stale `archive_id` until the next commit attempt releases it.
- ✓ `lib/__tests__/ticketShedCommit.test.ts` "SM-4 — produce → reopen → commit: the live ticket survives".
- (review fix pass 2, ALOG-8) the 409 `changed_since_capture` refusal is itself recorded: each un-link (`archive_id → null`) selects the row it matched and counts a ticket as returned only when it matched one (a raced or already-gone row is reported as not returned); one `TICKET_ARCHIVE_RECLAIM` row (`partial: true`, `stoppedAt: "changed_since_capture"`, the released and unreleased ticket ids, each changed ticket's reason) is written before the 409, and a refused audit insert is carried in the answer (`auditError`). Tests: `ticketShedCommit.test.ts` "DF-P11 fix pass 2 (ALOG-8) — the changed-since-capture refusal is audited and counts only rows it returned".

**Scope / residual.** Done-when 2 and 3 → the workflow route's owner (drafting-flow DF-P15, which holds `app/api/tickets/**` this round): clear `archive_id` in the reopen / cancel-undo transitions and refuse an action on a row with a non-null `archive_id`. *(DF-P15 has merged without them; owner now drafting-flow DF-P8 PROJECTS — assigned by the integrator at the DF-P11 merge, 2026-10-21, DEC-31.)*

**Resolution (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. Done-whens 2-3. `lib/ticketTransitions.ts` `computeTransition` (`:1052`): a transition that leaves a claimed row non-terminal (a reopen or cancel-undo, or any later transition on a row a reopen left claimed) clears `archive_id` in the SAME compare-and-set update, so the shed and the workflow never both own a live row. A row with no claim gets exactly the updates it got before; a terminal transition never clears one; an archived stub is refused by the route before this runs.

**Done-when.**
- ✓ (1) the shed's commit re-check (DF-P11, as recorded).
- ✓ (2) `reopen_ticket` and every transition out of CLOSED / CANCELED clear `archive_id` in the same atomic update.
- ✓ (3) by its second form — the transition clears the claim (rather than refusing the action), so a reopened request is never stamped or freed and carries no stale claim. Tests: `dfRoundG_P15_routes.test.ts` "SM-4 done-whens 2-3 (DF-P8) …" (route, with REGRESSION: an unclaimed reopen writes no `archive_id`); `dfRoundG_P8_projects.test.ts` "SM-4: a reopen clears the archive's claim …".
- ✓ (4) produce → reopen → commit (DF-P11, as recorded).

**Scope / residual.** None.

**Pending migration:** none for this limb (it works before and after `20261256`).

---

<a id="sm-5"></a>

## SM-5 · Reopen re-issues the SAME deliverable revision number, so two different documents both verify as "current" Rev N via the public QR endpoint

- **Severity:** MEDIUM
- **Status:** RESOLVED (2026-10-14, DF-P12 — PASTE pending: `20261221` after `20261208` (the guard limbs and the trust index); `20261222` any time (the (a) counters). Until `20261221` is pasted no issue line is proven — every ticket keeps DF-P10's trust boundary, with the two DF-P12 demotions that need no index (each fail-safe, neither driven by member-written history — ruling R2 at the DF-P12 merge, 2026-10-20, `DEC-90`) — and a member can still append an "issued Rev" line)
- **Assigned:** drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS (the `ticket_update_guard` limb refusing client-appended "issued Rev N" history entries; attachment identity on the QR, done-when 3; the `LEAK-7` (a)-row data repair) — by the integrator, 2026-10-13 (DF-P10 review fix pass 6, DEC-31); done-when 2's amendment (re-cycle instead of refuse) ratified by the integrator.
- **Verification:** CONFIRMED
- **Locations:** `lib/ticketTransitions.ts:288-290`, `lib/ticketTransitions.ts:106-108`, `lib/ticketTransitions.ts:221-225`, `lib/workflow.ts:331-341`, `app/api/verify-ticket/route.ts:62-89`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is real, but the narrated path is not the one that produces the collision: from the reopened PENDING_REVIEW state the only way back to the drafter is 'Request Revision', which increments revision_count (lib/ticketTransitions.ts:277) and yields Rev 2. The collision needs the approve-without-revision route — reopen, approve straight to PENDING_IFC (rev re-written as the same N), then the drafter issues a different final package via submit_final. Real but narrower than described; MEDIUM.

**Mechanism.** `reopen_ticket` sets status to PENDING_REVIEW and touches nothing else — not `revision_count`, not `draft_iteration`, not `deliverable_rev`. A ticket that was approved and issued as Rev 1 (revision_count 0) and then closed comes back to PENDING_REVIEW with revision_count still 0. `approve_draft_ifc` (or the minor-correction path) then computes `issuedRevLabel(ticket.revisionCount)` = `String(0 + 1)` = "1" — the exact label already issued. `submit_final` appends a second, different Final file. The org now has two distinct construction packages both stamped Rev 1 on the same ticket, and `/api/verify-ticket` derives its verdict solely from `deliverable_rev`, so both prints scan as verdict "current".

**Failure scenario.** KE-DDRT-26-0088 is issued as Rev 1 and closed; prints go to the field. A week later the requester reopens it ("we missed a nozzle"), the drafter uploads a corrected drawing, the requester approves. deliverable_rev is written as "1" again. A pipefitter holding the ORIGINAL Rev 1 print scans its QR: `verdict: "current"`, "this is the latest issue". A second fitter holding the corrected Rev 1 scans his: also "current". The verification system that exists precisely to catch "is the paper in my hand superseded?" reports both as good, and the missed nozzle is built from the stale sheet.

**Evidence.**

lib/ticketTransitions.ts:288-290 —
```
case "reopen_ticket":
  updates.status = "PENDING_REVIEW";
  break;
```
lib/ticketTransitions.ts:106-108 —
```
export function issuedRevLabel(revisionCount: number | undefined): string {
  return String((revisionCount ?? 0) + 1);
}
```
app/api/verify-ticket/route.ts:82-83 (verdict from deliverable_rev alone) —
```
} else if (latestIssued && printedRev === latestIssued) {
  verdict = "current";
```

**Chain reaction.** Reopen also lands the ticket at PENDING_REVIEW regardless of whether a draft was ever submitted: a ticket force-closed at PENDING_ASSIGNMENT and then reopened reaches PENDING_REVIEW with an empty attachment list, and approve_draft_ifc will mint deliverable_rev "1" for a ticket that has no drawing on it. Combined with finding #6 (submit_final needs no file), a complete, closed, "Rev 1 issued" ticket can exist with zero engineering content. The reopen action itself is also widely available: it is offered to `allows('ticket.reopen') || canActAsRequester`, and `ticket.requester_review` defaults to the role token `"Requester"` — so any user holding the Requester role can reopen ANY closed ticket in the org, not just their own.

**Done when.**

- [ ] `reopen_ticket` bumps `revision_count` (and resets `draft_iteration`) so the next issue is a new cycle, or routes to REVISION_REQ/DRAFTING rather than straight back to PENDING_REVIEW
- [ ] `deliverable_rev` is enforced monotonic — a transition that would write a label already present in the ticket's history is rejected
- [ ] /api/verify-ticket distinguishes re-issues (e.g. by matching the printed rev against the issued attachment's identity, not just the label string)
- [ ] A test walks issue Rev 1 → close → reopen → approve and asserts the second issue is Rev 2, not Rev 1

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. `DEC-15` landed with roles-and-permissions [`WF-21`](../roles-and-permissions/06-request-workflow.md) (Round E, `e5a203b`) and closes the shape this finding narrates for every reopen performed since; two of its four done-whens ask for more than that.
- `lib/ticketTransitions.ts:354-363` — `case "reopen_ticket": updates.status = "PENDING_REVIEW"; updates.revision_count = (ticket.revisionCount || 0) + 1; updates.draft_iteration = 0; updates.deliverable_rev = null;`.
- `app/api/verify-ticket/route.ts:117-147` — reopen-aware: with no label on the row, a live status and an `issued Rev N` history line (`:59-69`), a print of the last issue reads `revision_in_progress`, an older one `superseded`, never `current`. PS-VERIFY (public-surfaces, merged) changed the headers, scan log and rate limit and left this ladder as WF-21 wrote it.
- Tests: `lib/__tests__/sweepRoundE_A.test.ts:713` (issue 2 → reopen → 3A → 3) and the verify-route cases after it.

**Done-when.**
- ✓ `reopen_ticket` bumps `revision_count` and resets `draft_iteration` (and nulls the label).
- ✗ No transition checks the label it writes against the history. Distinct labels hold by construction for post-Round-E reopens — every path from an issued state back to an issuing action increments `revision_count` (`lib/ticketTransitions.ts:320-324`, `:340-345`, `:354-363`) and the column is workflow-owned (`20261038:201`) — but a ticket reopened **before** Round E (2026-09-17) under the old three-line `reopen_ticket` kept its `revision_count` and its issued `deliverable_rev`; its next approval re-issues the same label, and it verifies `current` while back under review. The explicit history check is what would catch it. The population is unobservable from here (`DEC-30`); the read-only inventory is [`LEAK-7`](./04-flow-leaks.md)'s Blocker query, one result set of three aggregate rows (fix pass: the first version counted (a) only, and could return 0 while a duplicate already stood): (a) tickets at `PENDING_REVIEW` / `PENDING_FINAL_APPROVAL` still carrying a digits-only label — since Round E such a label can sit there only through a pre-Round-E reopen (`submit_draft` writes a letter rev; `reopen_ticket` nulls it); (b) tickets whose `history` issues the same `Rev N` twice, at any status — a re-issue that has already happened, whether the second approval came before Round E or after it, now at `PENDING_IFC`, `FINAL_DRAFT` or `CLOSED` where (a)'s status filter cannot see it; (c) archived tickets carrying an issued label, whose history the shed moved to the archive bundle (`app/api/admin/ticket-shed/commit/route.ts:173`), so (b) cannot see a repeat in them.
- ✗ (in part) `/api/verify-ticket` distinguishes re-issues only by label — sufficient once labels are distinct, not for the legacy rows above; matching the printed rev to the issued attachment's identity is not built (`TicketAttachment` carries no rev — `PHYS-2`).
- ✓ A test walks issue → close → reopen → approve and asserts the second issue is a new number (`lib/__tests__/sweepRoundE_A.test.ts:713`).

**Scope / residual.** → **DF-P10** (owns the issue cases of `lib/ticketTransitions.ts` and the verify-ticket verdict): an explicit refusal (or re-cycle) when an issuing action would write a label already in the ticket's history, and the attachment-identity verdict (`PHYS-2`'s per-attachment rev). Not in the handed-on list — found on re-verification. DF-P10 also owns the data repair of any row the inventory's (a) finds (bump `revision_count`, null `deliverable_rev`, reset `draft_iteration`, with a history line — a `DEC-30` migration); rows in (b) and (c) cannot be repaired by counters — both prints read Rev N — and wait on the attachment-identity verdict above. [`LEAK-7`](./04-flow-leaks.md) is `BLOCKED` on the same inventory query (its Blocker block carries it in the paste-ready `check, ok, n` shape) and closes only when all three rows return 0, or when the (a) rows are repaired and (b) and (c) are 0.

**Partial (2026-10-13, drafting-flow Round G).** DF-P10 DELIVERABLE-PRINT — re-verified. The binding `99-fix-sequencing.md` hand-off table assigns "`SM-5`, `LEAK-7` — DF-P10: an explicit history check against re-issuing a label"; the first pass recorded that check as unassigned, and the review fix pass built it (no migration needed).
- Per-file revision (public-surfaces `PHYS-2`): every Draft and Final now carries its own `rev`, stamped server-side in `lib/ticketTransitions.ts` (`joiningFileRev`, `stampIssuedFinals`, `submit_draft`), and the print / download QR names the FILE's revision (`lib/ticketDeliverableCopy.ts`). A Rev 1 package printed after Rev 2 issues now scans `superseded`, not `current`.
- The history check (done-when 2): `lib/ticketTransitions.ts` `issueLabelFor(ticket)` — the three issuing cases (`approve_draft_ifc`, `approve_minor_correction`, `engineer_approve_final`) call it through `issueRev()` in `computeTransition`. When the cycle's label (`issuedRevLabel(revision_count)`) was ALREADY issued — an `issued Rev N` line naming exactly that label in the ticket's history (`lastIssuedFromHistory`, `lib/verifyTicketVerdict.ts`, capped at `revision_count + 1`) — the issue is RE-CYCLED to that label + 1, `revision_count` is written to match (so cycle and label agree from then on), and the issue's history line carries the note "Rev N was already issued on this ticket — issued as Rev N+1 instead, so no two packages share a label." The issue is never refused: refusing would block a legitimate approval on a legacy row. The package awaiting the issue takes the re-cycled label (`stampIssuedFinals`); the old package keeps its own. A label the history never issued is written exactly as before (no `revision_count` write, no note).
- **Trust boundary (review fix pass 3).** Any org member may append a history entry in their own name (`20261166`'s `ticket_update_guard` admits a client append that names the caller), so a history line is not proof an approval wrote it. The second pass re-cycled from the HIGHEST issued number: a member who cannot write the guarded `deliverable_rev` / `revision_count` could append "note — issued Rev 9" and make the service-role route write Rev 10 / `revision_count` 9 at the next approval. Now only an exact collision re-cycles, and a line above `revision_count + 1` is ignored: a real issue N happens at `revision_count` N − 1 and `revision_count` never goes down, so no approval can have written it. What remains: a forged line naming the cycle's OWN label still skips one number (Rev N+1 issued instead of Rev N) — never a re-issue, never a jump. Closing it needs `ticket_update_guard` to refuse a client-appended entry whose `action` matches `issued Rev` — a `DEC-30` migration, the guard limb owned by drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS (migration number allocated at its launch); `lib/ticketDeliverableCopy.ts` and the verify verdict apply the same cap, and — review fix pass 4 — also the bound the row's label proves (`issueOnRecord`: N − 1 under a review label N<letters>, N under an issued label N; `EDGE-2`). *Overstated* in pass 3 for the verdict and the copy: within `revision_count + 1` a forged line still changed the public answer (`2A` + an appended "issued Rev 2" scanned the real Rev 1 `superseded`; `CLOSED 1A` + an appended "issued Rev 1" scanned `draft_copy` instead of `withdrawn`); both now read correctly. The re-cycle keeps reading without the label bound — it must see a legacy collision AT the label (`1B` after a real Rev 1). Review fix pass 5: on a row with NO label the read bound is `revision_count` itself (only `reopen_ticket` nulls a label, and it bumps the count after the issue), so a `CLOSED` RFI with an appended "issued Rev 1" scans `unknown` again (fix pass 4 had let it scan green `current`) and a ticket reopened after a real Rev 1 with an appended "issued Rev 2" keeps the real Rev 1 `revision_in_progress` (`EDGE-2`). *Overstated* in pass 4: the guard-limb residual below said those variants needed the migration; a code-only bound closes them. Review fix pass 6 (the integrator's rulings, DEC-90 fail-safe): fix pass 5 had let a `CLOSED` row with no label read the ladder on its history (a reopened-then-closed ticket's last issue `current`); since a member can append a line at or below `revision_count` wherever cycles were bumped without an issue, a `CLOSED` row with no issued label now answers `unknown` ("cannot confirm") whatever its history says, as base did. And a `CLOSED` review label whose history carries an issue line the label sets aside — `CLOSED 1A` + an appended "issued Rev 1", which pass 4 called `withdrawn`, or a real legacy Rev 1 force-closed on `1B` — answers `unknown`: the row cannot tell the two apart, so it is neither red nor green; `withdrawn` stays for a request with no issue anywhere. *Overstated* in passes 4 and 5: "both now read correctly" held for the `2A` case only. Under a review label a forged line at or below the label's bound still changes the public answer — see the guard-limb remainder below.
- **The (a) row's verdict (review fix pass 3).** An issued label at `PENDING_REVIEW` / `PENDING_FINAL_APPROVAL` exists only on an (a) row (the workflow never leaves one at a review status), and the verify verdict now reads it `revision_in_progress`, never `current` (`EDGE-2`); the print / download footer says a newer revision is in progress. Review fix pass 4: once such a row has submitted a new draft it carries a review label of the SAME cycle as its real issue (`1A` / `1B` after a real Rev 1), which the label bound reads as "no issue yet": its real Rev 1 then scans `unknown` ("cannot confirm") while live, and — review fix pass 6 — `unknown` too if force-closed on that label (pass 4 to 5 answered a red `withdrawn` there, which told a field user a real issue never existed) — never green; the repair below restores the counters and with them the ordinary reading. The data repair below is no longer needed for the scan to be honest — only to restore the counters.
- Tests: `lib/__tests__/ticketTransitions.test.ts` "SM-5 — an issued label is never written twice: re-cycled from the history" — a legacy row (`PENDING_REVIEW`, `revision_count` 0, `deliverable_rev` "1", history "issued Rev 1") approved by each of the three issuing actions → Rev 2, `revision_count` 1, the note, the old Final still Rev 1 and the waiting one Rev 2; a reviewer comment kept beside the note; the trust boundary (a forged higher line moves neither the label nor `revision_count`, through `computeTransition` too; the legacy collision still re-cycles by exactly one); the ordinary path untouched. `lib/__tests__/verifyTicketVerdict.test.ts` "LEAK-7 (a) …" and "trust boundary …".

**Done-when.**
- ✓ Unchanged.
- ✓ as amended — the amendment is RATIFIED by the integrator (fix pass 6 brief, 2026-10-13): a transition that would write a label already present in the ticket's history writes the next number instead, with a history note (only history lines at or below `revision_count + 1` count — the trust boundary above). Not "rejected" as the criterion's wording says. The amendment ("an explicit refusal (or re-cycle)") came from this area's own Scope line above and an earlier review; the integrator's ratification is what lets it stand as ✓ (`DEC-29`). It also brings an effect base did not have: a member-forged line naming the cycle's OWN label makes the service-role route skip one number and write `revision_count` (documented below; owner drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS, closed by the guard limb).
- ✗ (in part) The verify route compares the printed FILE's revision (per-file `rev`), not the ticket's live label, and no NEW re-issue of a label can happen (done-when 2). Two prints of one label that ALREADY exist (`LEAK-7` (b): a re-issue made before this round) are still told apart by label only — attachment identity on the QR is not built.
- ✓ Unchanged.

**Scope / residual.** Two remainders, each owned:
- Attachment identity on the QR (`?a=<attachment id>`, checked by `/api/verify-ticket` against the ticket's attachments and recorded as the scan's `printed_ref`) — owner **drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS** (with `LEAK-7` (b)); it settles `LEAK-7` (b) rows. No migration needed for the QR and the verdict; the scan column, if one is wanted, needs a number.
- `LEAK-7` (a)-row data repair (bump `revision_count`, null `deliverable_rev`, reset `draft_iteration`, with a history line — a `DEC-30` migration preceded by the inventory) — owner **drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS**, its migration number allocated at that package's launch. Until it lands, such a row reads `revision_in_progress` for its stale issue while it is under review on the kept issued label (review fix pass 3 — no longer `current`), or `unknown` once a new draft put a same-cycle review label on it (pass 4) — also once force-closed on that label (pass 6) — and its NEXT approval is re-cycled (above), so no second package shares the label.
- The guard limb of the trust boundary (`ticket_update_guard` refusing a client-appended `issued Rev` entry) — owner **drafting-flow DF-P12 DELIVERABLE FOLLOW-UPS**, its migration number allocated at that package's launch; until then a forged line naming the cycle's own label can skip one number at the next approval, and a forged line within both read bounds changes the public answer as `EDGE-2`'s Scope line states exactly. Stated plainly (`DEC-29`): under a REVIEW label, a member-forged line at or below the label's bound can supersede a REAL issue — Rev 1 issued at `revision_count` 0; `reject_final` → 1; `2A` submitted and rejected → 2; `3A` submitted; a member appends "issued Rev 2" → the real Rev 1 scans `superseded` and its copy is stamped "SUPERSEDED by Rev 2" (no code-only bound can tell that line from a real one; pinned as today's behaviour in `verifyTicketVerdict.test.ts`); a ticket that never issued reads the ladder on the forged number under a review label N ≥ 2. With no label on a LIVE row, only where `revision_count` is above the real last issue (cycles bumped without an issue), a forged line makes the ticket read as reopened on it, a real earlier issue `superseded`, and the copy can stamp a real Final SUPERSEDED. A `CLOSED` row with no label answers `unknown` whatever its history says (fix pass 6, the integrator's ruling), and a row with no label at `revision_count` 0 or reopened straight after its real last issue ignores the forged line (fix pass 5). When the guard limb lands, the `CLOSED` no-label rule can be revisited.

**Resolution (2026-10-14, drafting-flow Round G).** DF-P12 DELIVERABLE FOLLOW-UPS — the two remainders DF-P10's review fix pass 6 handed here (the `ticket_update_guard` limb; attachment identity on the QR) and the (a)-row repair. Reproduced on `6f89d39`: `20261208`'s guard (the newest body, found by scanning) admits any client-appended history entry that names the caller, whatever its `action` — a member's `{"action":"note — issued Rev 2","user":"<self>"}` lands (`supabase/migrations/20261208_df_roundG_ticket_library.sql:242-254`); and the print QR carried only `?r=` (`lib/verifyTicketVerdict.ts:336-340` on the base), so two prints of one label were told apart by label alone.
- **The guard limb.** `supabase/migrations/20261221_df_roundG_issue_lines_server_only.sql` re-creates `ticket_update_guard` from `20261208`'s body — lineDiff-pinned: nothing removed, the added code lines are exactly the trust index and the limb (`lib/__tests__/dfRoundG_P12_deliverable.test.ts`, "20261221 — …"). A client-appended entry whose `action` matches `'issued Rev <digit>'` (any case, any JSON shape — never narrower than the readers' `/\bissued Rev (\d+)\b/`) is refused: only the workflow route, as the service role, writes an issue line. No browser path writes one today (the one browser history writer, `lib/projects.ts` `convertTicketToProject`, appends "Converted to Project"), so nothing that works is refused — pinned at runtime: a member's own plain append, the mark-read and the mark-urgent writes still land (`lib/__tests__/rls/dfP12DeliverableRails.test.ts`, "REGRESSION …").
- **Trust after the paste** (the integrator's ruling for this package under DEC-90: a ticket deliverable whose history the server did not write is never trusted; before the paste the verdict keeps today's behaviour). The same migration adds `tickets.history_guarded_from` — the index from which every issue line on the row is the workflow's — stamped once by the guard at a live row's first write after the paste, cleared by the archive shed (live → archived), and re-stamped at EVERY restore (archived → live) past everything the restore writes, whatever the stub carried — `app/api/admin/ticket-shed/restore/route.ts` writes `history` from an admin-uploaded bundle and checks only the attachment bytes against its manifest, so nothing restored is proven; workflow-owned (a client write is refused), and cleared on every INSERT (`ticket_history_guard_reset`, SECURITY INVOKER: a re-inserted row proves nothing). *Corrected at DF-P12's second review fix pass (same day): the first stamp ran only while the index was NULL and a shed kept it, so a ticket stamped after the paste, then shed, kept its old index through the restore, and whatever a doctored bundle placed at or after it — an extra "issued Rev" line, a dropped `revisionRound` — read as proven (a rejected package's Rev 1 green; a real Rev 1 red under a forged Rev 2). The records said the opposite ("an archived stub's at its restore, over everything restored").* `lib/verifyTicketVerdict.ts` `provenIssueFromHistory` (`:255`) reads an issue line at or after the index as PROVEN; every real issue is a higher number than every earlier one (the SM-5 re-cycle), so a proven issue IS the last issue and an earlier line claiming a higher number is provably not an approval's. For such a ticket `ticketVerdict` (`:363`) lifts the fail-safe rules that exist only because a line might be forged: a `CLOSED` row with no label reads the ladder on its proven last issue N (`:436`; the "revisit" EDGE-2 allowed) — and its print of Rev N is green only when `revision_count` is N, i.e. the reopen that nulled the label was the one cycle bump since the issue (review fix, same day: above N the package was sent back, a revision was asked of the reopened request or it was reopened again, and the print answers "cannot confirm", older prints superseded — `DEC-110` item 2; the first pass read any such row green, against base's "cannot confirm"), a set-aside line is no ambiguity, and an earlier forged line can no longer supersede it (DF-P10's "issue 3": `3A` + an earlier forged "issued Rev 2" now reads the real Rev 1 `revision_in_progress`, and its copy carries no SUPERSEDED stamp). A ticket with no proven issue — every ticket until the paste, one whose issues all predate it, and one restored from the archive — keeps DF-P10's trust boundary (pinned: "REGRESSION — …", and DF-P10's `verifyTicketVerdict.test.ts` unchanged but for the two pins named below). Two DF-P12 rules need no index and act on every row from the deploy, each only turning a green or amber answer into "cannot confirm", and neither can be driven by member-written history: the `CLOSED` issued-label rule (`DEC-110` item 2 (a); it reads the server-written `revision_count` and the label, never a history line) and the printed file's identity (`?a=`, below; checked against the row's files) — pinned: "review fix 2, as ruled at the DF-P12 merge (R2, DEC-90) — the two DF-P12 demotions that act with NO index …". The label-issued-twice rule (below) counts only PROVEN issue lines, so it never acts before the paste or on a row not yet stamped. *Corrected at the integrator's DF-P12 merge fix pass (2026-10-20, ruling R2): the records said three rules act with no index, the third counting every line, proven or not.* *Corrected at the second review fix pass: the records said such a row "reads exactly as before" / "as DF-P10 left it".* `/api/verify-ticket` selects the column and, before the paste (42703 / PGRST204 naming it), reads again without it — no line proven (DF-P10's trust boundary, the two demotions above aside); any other read failure stays a 503. `ticketCopyStanding` takes it as `historyGuardedFrom` (`lib/ticketDeliverableCopy.ts:121`; the server copy route passes it, the page does not yet — `EVID-16`).
- **Identity on the QR (done-when 3).** `ticketVerifyUrl(origin, id, rev, attachmentId)` (`:572`) adds `?a=<file id>` (only an id of the shape `TICKET_ATTACHMENT_ID_RE` accepts), and `ticketCopyPlan` passes the file's id — so every print and download the page makes carries it with no page change. `/api/verify-ticket` reads `a` (malformed → 400 "invalid", logged), selects `attachments` only for such a QR, and `ticketVerdict(row, r, a)` confirms the file is this ticket's, once, carrying the printed revision; otherwise a green or amber answer becomes "cannot confirm" — never a red one. The scan row records the file as its `printed_ref` (`verify_scans`, when a UUID). A label the workflow provably issued TWICE — two issue lines at or after the row's index — cannot be told apart by label: a print of it without a confirmed identity answers "cannot confirm" (`issuedMoreThanOnce`, `:299`). With no index (before the paste, or on a row not yet stamped) the rule never fires, so a member-appended duplicate line can never grey out a current deliverable (ruling R2 at the DF-P12 merge, 2026-10-20, `DEC-90`; pinned: "R2 (the integrator's ruling at the DF-P12 merge, DEC-90) — …" (i) no index + a forged duplicate → exactly DF-P10's answer, (ii) two proven lines + no confirmed identity → "cannot confirm", (iii) one proven + one pre-index duplicate → not demoted). *Corrected at that fix pass: the rule counted every line within `revision_count + 1`, proven or not, and did not act on a ticket with a proven issue.* *Corrected at the review fix pass (same day):* the first pass called these "ids the app mints". The app mints an id for every file it uploads, but `app/api/tickets/workflow-action/route.ts` `vetTicketAttachment` keeps an `id` the client sends with a file, so a participant who may attach a file can give it the id of the current Final; the identity then reads "named twice" and every `?a=` print of that Final answers "cannot confirm" (fail-safe, never green), and `POST /api/tickets/copy` refuses the file (404). Opened as [`SM-15`](#sm-15) (the route is outside this package).
- **A package sent back after its proven issue** (review fix, same day; `DEC-110` item 2 as amended). `reject_final` returns an issued package and opens revision round N for an issue N; `computeTransition` records it as `revisionRound` on the round's history entry, and `20261221`'s guard now refuses a client-appended entry carrying that key too (a second limb, beside the issue-line limb; nothing a browser writes carries it). `provenSentBackAfterIssue` (`:327`) reads round N after a proven issue N's line; `ticketVerdict`'s rule after the ladder (`:515`) answers "cannot confirm" for that print on a `CLOSED` ticket — on its issued label with `revision_count` ≥ N (any row), with no label and `revision_count` above N, or on a review label with round N recorded after the proven issue. Pinned through `computeTransition`: `reject_final` → Force Close → reopen → Force Close, and `reject_final` → `2A` → Force Close, both "cannot confirm" with the index; a normal close, a reopen closed again, and a reopen whose new draft was rejected and force-closed stay green.
- **The (a)-row repair:** `supabase/migrations/20261222_df_roundG_leak7_reopened_label_repair.sql` — see [`LEAK-7`](./04-flow-leaks.md).
- Tests: `lib/__tests__/dfRoundG_P12_deliverable.test.ts` (the three migration shapes; "FOLDER SCAN: the NEWEST ticket_update_guard …" — whichever file is newest must keep both limbs and the index stamp; "REGRESSION — a legitimately issued, current deliverable …"; "SM-5 guard limb — …"; "SM-5 done-when 3 / LEAK-7 (b) — …"; "DEC-110 item 2 after 20261221 — …"; the `/api/verify-ticket` block); `lib/__tests__/rls/dfP12DeliverableRails.test.ts` on PostgreSQL 16 (the replay of every migration; the limb refuses five shapes of a member's issue line and admits a near miss; a member's entry carrying `revisionRound` is refused and the service role writes one; the service role appends one; the index is stamped once, is no member's to write, is cleared on INSERT, waits out an archived stub, is cleared by a shed and re-stamped at every restore's full length whatever the stub carried — "review fix 2 — a restore proves nothing it wrote": Rev 1 issued after the paste (proven), `reject_final`, `2A`, Force Close ("cannot confirm"), shed, restored from a bundle with the round marker dropped and an extra issue line → the index is the restored length, `provenIssueFromHistory` finds nothing, and the scan answers exactly as an unproven ticket; each DF-P12 file re-pastes with every probe true, the guard's probe now checking the shed and restore branches). Pins re-pinned deliberately: `verifyTicketVerdict.test.ts`'s select string (now with `history_guarded_from`) and `recordTicketCopy`'s column set (`PHYS-17`); public-surfaces' `verifyDoor.test.ts` VFY-14 select pin (the column list is now the `BASE_COLUMNS` constant, `attachments` is added only for `?a=`, and neither it nor the index is ever returned) and its read-error pin (the read retries once without the index column, and only for that column's absence).

**Done-when.**
- ✓ Unchanged (DF-P10).
- ✓ as amended (ratified at DF-P10's fix pass 6). The amendment's own residual — a member-forged line naming the cycle's label makes the next approval skip one number — is closed for every line written after `20261221` is pasted: no client can write one. Lines a restore puts back are not counted as written under the guard (the restore re-stamps the index past them). A line a member appended BEFORE the paste is indistinguishable from an approval's and keeps DF-P10's handling (bounded: at worst one skipped number at that ticket's next approval, never a re-issue); its population is unobservable (`DEC-30`), and the paste's inventory counts the tickets carrying any issue line and those carrying one above `revision_count + 1` (which every reader already ignores).
- ✓ The verify route tells two prints of one label apart by the printed file's identity (`?a=`), checked against the ticket's attachments; a print of a label the workflow provably issued twice (two issue lines at or after the index) that carries no confirmed identity answers "cannot confirm", never "current" (R2, 2026-10-20). Identity confirms only a file that joined since DF-P10's per-file revisions: a pre-DF-P10 twice-issued package's files carry no revision, so every print of them made since DF-P10 carries no `?r=` and answers "cannot confirm" by DF-P10's no-rev rule, without identity telling them apart (`LEAK-7` (b); second review fix pass; ruling R1 at the DF-P12 merge, 2026-10-20, `DEC-90`). Paper printed before DF-P10 carried the ticket's live label on its QR; since R2 it reads as DF-P10 reads it (stated on `LEAK-7`). The identity is unique only as far as the app's own uploads go — a client-supplied id kept by the workflow route can make a file's id ambiguous, which reads "cannot confirm", never green ([`SM-15`](#sm-15)).
- ✓ Unchanged (DF-P10).

**Pending migration:** `supabase/migrations/20261221_df_roundG_issue_lines_server_only.sql` (the guard limb and the trust index — the database half holds only once it is pasted; until then every ticket reads as before) and `supabase/migrations/20261222_df_roundG_leak7_reopened_label_repair.sql` (the (a) counters). Paste `20261221` after `20261208`; either order with the DF-P12 deploy; `20261222` any time.

**Scope / residual.** Nothing left in this package's code. Server-minted attachment ids → [`SM-15`](#sm-15) (owner: drafting-flow DF-P15 DELIVERABLE PAGE WIRING (allocated by the integrator at the DF-P12 merge); fail-safe meanwhile). A package sent back after an issue that is NOT proven (every ticket until the paste, one whose issues all predate it, and one restored from the archive) and then force-closed on a NEW review label still scans its issue green — base behaviour, kept: such a row cannot tell a reject cycle from a reopen cycle without trusting a history line a member could have written (`DEC-29`; `DEC-110` item 2). What the paste cannot do, stated (`DEC-29`): it proves nothing about a line written before it — on a ticket with no proven issue a pre-paste forged line still reads as DF-P10 recorded (under a review label it can supersede a real earlier issue; on a live row with no label it can be read as the last issue) until that ticket issues again after the paste. That bounded reading is DEC-90's ruling at DF-P10's fix pass 6; this package records it as accepted (`DEC-110` item 1). The ticket page's own copy standing reads without the index until the page passes it or moves to the server copy route (`EVID-16` done-when 2). *Added at the second review fix pass:* (i) a ticket shed and restored proves nothing from before its restore — it reads as a ticket with no proven issue (DF-P10's trust boundary, including the still-green path above) until it issues again; (ii) the label-issued-twice demotion counts every history line within `revision_count + 1`, proven or not, so a duplicate "issued Rev N" a member appended BEFORE the paste (the guard admitted it then; it stays in the history for good) greys out every print of a legitimately current Rev N that names no confirmed file — all paper printed before DF-P12 — until the ticket issues again after the paste. Fail-safe (grey, never green), and not narrowable without trusting a line a member could have written: counting only proven lines would turn a real pre-paste twice-issued label (`LEAK-7` (b)) green (`DEC-110` item 4). *Superseded at the integrator's DF-P12 merge fix pass (2026-10-20, ruling R2, `DEC-90`): (ii) no longer holds — the rule counts only proven lines, so no pre-paste duplicate greys out a current deliverable; a real pre-paste twice-issued label is answered by DF-P10's no-rev rule for every print made since DF-P10 (ruling R1), and paper printed before DF-P10 of such a label reads as DF-P10 reads it (`LEAK-7`'s stated residual).*

**Ruled by the integrator at the DF-P12 merge, 2026-10-20 (DEC-90).** (R2) `issuedMoreThanOnce` counts only PROVEN issue lines — those at or after `tickets.history_guarded_from`; with no index (before `20261221` is pasted, or on a row not yet stamped) it never fires, so a member-appended duplicate line can never grey out a current deliverable. Safe for `LEAK-7` (b) because ruling R1 (`LEAK-7`) already answers those rows by DF-P10's no-rev rule. The other two pre-paste demotions are RATIFIED as fail-safe and kept: the `CLOSED` issued-label rule (it reads the server-written `revision_count`) and the `?a=` identity check (it only demotes). So before the paste exactly two DF-P12 demotions act, and none can be driven by member-written history. Code: `lib/verifyTicketVerdict.ts` `issuedMoreThanOnce(history, revisionCount, rev, guardedFrom)` and its call in `ticketVerdict` (the `!proven` condition dropped: two proven lines for one label demote whatever else is proven). Tests: `lib/__tests__/dfRoundG_P12_deliverable.test.ts` "R2 (the integrator's ruling at the DF-P12 merge, DEC-90) — …" (i)–(iii), and the review-fix-2 and identity pins re-pinned to the ruling. Server-minted attachment ids (`SM-15`) are allocated to drafting-flow DF-P15 DELIVERABLE PAGE WIRING (allocated by the integrator at the DF-P12 merge).

*Cross-note (2026-10-20, drafting-flow Round G, DF-P15 — `SM-15` done-when 3):* the file's identity on the QR (`?a=`, done-when 3 above) is now unique on a ticket for every file appended since DF-P15: the workflow route mints every new attachment's id on the server and never keeps a client's (`SM-15`, RESOLVED). An id a hostile client duplicated before that deploy stays duplicated and keeps answering "cannot confirm" (fail-safe), as before.

---

<a id="sm-6"></a>

## SM-6 · "Reject / Return to Requester" and "Return with Questions" both dump the ticket into REVISION_REQ, where a ticket with no assigned drafter has zero legal actions and appears on nobody's attention list

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/ticketTransitions.ts:273-279`, `lib/workflow.ts:102-108`, `lib/workflow.ts:126-131`, `lib/workflow.ts:166-194`, `lib/ticketAttention.ts:62-110`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The dead-end is real for the requester and REVISION_REQ is genuinely absent from every role-based attention rule, but two parts of the claim are wrong: 'zero legal actions' ignores that any member holding the Drafter role satisfies allows('ticket.draft_work') and gets Save Progress / Submit Draft there (plus Admin force-close, workflow.ts:345-349), and 'appears on nobody's attention list' ignores that the reject transition puts the requester in unread_by (ticketTransitions.ts:140), which produces a bell row, an email, and an unread item in the attention feed (useTicketNotifications.ts:254-255). LOW.

**Mechanism.** `reject` (offered at NEW/PENDING_ENG_INITIAL as "Reject / Return to Requester" and at PENDING_ENG_TEAM as "Return with Questions") maps in computeTransition to `updates.status = "REVISION_REQ"`. But PENDING_ENG_TEAM is reached from PENDING_ASSIGNMENT via `request_eng_review`, which sets only `assigned_engineer_id` — `assigned_drafter_id` is still NULL. At REVISION_REQ, getActions offers actions only `if (canActAsDrafter)`, i.e. `isDrafterIdentity || allows('ticket.draft_work')` (default `["Drafter"]`). With no drafter assigned, the requester sees nothing, the engineer sees nothing, the DraftingSupervisor sees nothing (there is no `assign` action at REVISION_REQ), and management gets only the global Force Close. Separately, `isActionRequired` surfaces REVISION_REQ ONLY when `ticket.assignedDrafterId === uid` — management's list at ticketAttention.ts:84-94 omits REVISION_REQ and DRAFTING entirely — so the ticket also stops appearing in every bell, badge and inbox.

**Failure scenario.** A maintenance planner submits a request. The DraftingSupervisor flags it for engineering review and picks Engineer-1. Engineer-1 reads the scope, has a question, and clicks "Return with Questions" with a comment. The ticket moves to REVISION_REQ with no drafter. The planner opens it: no buttons. The supervisor's queue: gone (REVISION_REQ isn't an assignment state and isn't in the attention list). Engineer-1: gone. The request silently dies; the field waits on a drawing that is not being worked and that no dashboard reports as stalled. The only recovery is an Admin noticing and force-closing it.

**Evidence.**

lib/ticketTransitions.ts:273-279 —
```
case "request_revision":
case "reject":
case "reject_final":
  updates.status = "REVISION_REQ";
  updates.revision_count = (ticket.revisionCount || 0) + 1;
  updates.draft_iteration = 0;
```
lib/workflow.ts:126-131 (the label promising a return to the asker) —
```
actions.push({
  label: 'Return with Questions',
  action: 'reject',
  variant: 'destructive',
  requiresComment: true
});
```
lib/workflow.ts:166-168 (the only gate at REVISION_REQ) —
```
case 'DRAFTING':
case 'REVISION_REQ':
  if (canActAsDrafter) {
```
lib/ticketAttention.ts:68-70 (attention only via drafter identity) —
```
if (ticket.assignedDrafterId === uid) {
  if (status === "DRAFTING" || status === "REVISION_REQ" || status === "PENDING_IFC") return true;
}
```

**Chain reaction.** The same shape recurs anywhere REVISION_REQ is entered with no drafter: `reject` from NEW/PENDING_ENG_INITIAL, and `reject_final` from FINAL_DRAFT on a ticket whose drafter was never set (reachable via the reopen path). Each also increments `revision_count`, so the deliverable revision scheme advances a cycle for a review round that never happened — the next real submission is labelled 2A instead of 1A, permanently misdescribing the drawing's revision history.

> **Verifier correction.** Not "zero legal actions": any user whose role is Drafter satisfies `allows('ticket.draft_work')` (workflow.ts:75, capabilityPolicy.ts:70-71) and gets save_progress/close_rfi at REVISION_REQ without being assigned; management keeps Force Close (workflow.ts:345-349). The real defect is that no attention surface routes the ticket to them (ticketAttention.ts:68-70, 84-94) and that the "Return with Questions" label promises the requester while the transition targets a drafter state.

**Done when.**

- [ ] `reject` from a pre-assignment status (NEW, PENDING_ENG_INITIAL, PENDING_ENG_TEAM) routes back to a state where the requester or the assigner has an action — e.g. PENDING_ASSIGNMENT with the reason recorded — rather than REVISION_REQ
- [ ] REVISION_REQ (and DRAFTING) with `assignedDrafterId == null` offers `assign` to `ticket.assign` holders, so the ticket can always be re-owned
- [ ] `isActionRequired` returns true for management on a REVISION_REQ/DRAFTING ticket with no assigned drafter
- [ ] A test enumerates every TicketStatus × (drafter assigned / not) and asserts at least one non-force-close action exists for someone

**Resolution (2026-10-13, drafting-flow Round G).** DF-P3 ROUTING, base `5378ccb` (with `ROUTE-1`). `lib/ticketTransitions.ts:173`, `:346`, `:367`: a revision with no drafter returns to `PENDING_ASSIGNMENT` (a scope review from `PENDING_ENG_TEAM` does not advance the revision cycle — the chain reaction's mislabelled `2A`); `lib/workflow.ts:356`: a drafterless `REVISION_REQ` / `DRAFTING` offers `assign` to `ticket.assign` holders; `lib/ticketTransitions.ts:275`: assigning a drafter to a drafterless revision keeps it `REVISION_REQ`. The reason rides the required comment and the history line, as before. `supabase/migrations/20261195_df_roundG_outcome_and_departure.sql` moves the stragglers (pending paste).

**Done-when.**
1. ✓ `reject` from `PENDING_ENG_TEAM` (the only pre-assignment status left — DEC-14 retired `NEW` / `PENDING_ENG_INITIAL`) lands in `PENDING_ASSIGNMENT` with the reason recorded (`dfRoundG_P3_routing.test.ts`, route test "Return with Questions → PENDING_ASSIGNMENT").
2. ✓ `REVISION_REQ` and `DRAFTING` with no drafter offer `assign` to `ticket.assign` holders.
3. ✓ `isActionRequired` is true for management on both.
4. ✓ A test enumerates every `TicketStatus` × (drafter / none) and asserts someone has a non-force-close action — `CANCELED` excepted: it is terminal by decision (DEC-14, and DEC-84: a canceled request is not reopened).

**Scope / residual.** `ROUTE-1` done-when 2 (the attention label) → DF-P9. Pending migration: `supabase/migrations/20261195_df_roundG_outcome_and_departure.sql` (stragglers).

---

<a id="sm-7"></a>

## SM-7 · A transition performs four sequential writes with no transaction and no error check on the audit insert — the audit row can be lost while the status change stands

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/workflow-action/route.ts:155-223`, `app/api/tickets/workflow-action/route.ts:197-211`, `app/api/tickets/workflow-action/route.ts:214-223`, `app/api/tickets/workflow-action/route.ts:279-294`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanical claim is exactly right — four unsynchronised writes, and the audit insert's error is discarded. Severity is too high: the ticket's own `history` JSONB records who acted, with what label, in what role, and when, atomically with the status change, so what a lost audit row costs is the from→to mirror in audit_logs, not the compliance record itself.
- **Assigned:** drafting-flow DF-P11 AFTER-DC (the drain or the one-RPC form, the record's proposed owner) — by the integrator, 2026-10-07 (at the DF-P1 merge, DEC-31: the package that left this remainder has merged; fleet plans `audit-reports/fleet-plans/drafting-flow.json`, `admin-and-org.json`).
- **Assigned:** drafting-flow DF-P8 PROJECTS (the drain or the one-RPC form for DF-P1's logged-only failures) — assigned by the integrator at the DF-P11 merge, 2026-10-21, DEC-31 (DF-P8 is the next drafting-flow package that holds the workflow route; the integrator adds it to DF-P8's plan). Ruled by the integrator at the DF-P11 merge, 2026-10-21 (DEC-90).

**Mechanism.** The route does: (1) the CAS UPDATE on `tickets`; (2) the `ticket_comments` mirror insert, explicitly swallowed by `.then(() => {}, () => {})`; (3) the `audit_logs` insert, awaited but with its `{ error }` result discarded — supabase-js does not throw on a failed insert, so a rejected write (RLS, missing column, constraint) is indistinguishable from success here; (4) the notification/email fan-out, wrapped in try/catch. There is no `rpc(`, no `BEGIN`, no transaction anywhere in the file. Write 1 is the only durable one. This is the same class of bug the file's own comment at requests/new/page.tsx:322-324 warns about ("supabase-js does NOT throw on a failed insert — it returns { error }. Check it explicitly.").

**Failure scenario.** An approval to IFC commits: `tickets.status` becomes PENDING_IFC. The `audit_logs` insert fails — a transient connection reset, or the row is rejected. The route returns `{ok: true}`. The transition is real and visible to everyone; the compliance record of who approved it, from what state, and when, does not exist. An OSHA PSM audit later reconstructs approvals from `audit_logs` and finds a package issued with no recorded approver. Nothing in the system flags the gap: the route logged nothing, and the comment above the insert asserts "Audit — server-written, cannot be skipped by the client."

**Evidence.**

app/api/tickets/workflow-action/route.ts:213-223 —
```
// Audit — server-written, cannot be skipped by the client.
await supabaseAdmin.from("audit_logs").insert({
  action: `TICKET_${action.action.toUpperCase()}`,
  ...
  details: { from: ticket.status, to: newStatus, label: action.label },
});
```
(no destructuring of `{ error }`, no check)
app/api/tickets/workflow-action/route.ts:197-210 — the comment mirror, silenced on both branches —
```
if (newComment) {
  await supabaseAdmin.from("ticket_comments").insert({ ... }).then(() => {}, () => {});
}
```

**Chain reaction.** The comment mirror's silence is the same divergence `post_ticket_comment` was built to eliminate: a workflow comment that fails to reach `ticket_comments` exists only in the JSONB, so the archive bundler (ticket-shed/route.ts:157-166 reads `ticket_comments`) captures a thread missing that entry, and after commit wipes the JSONB the comment is gone from both stores. Because both writes are best-effort, a single transient DB blip during an approval permanently loses both the audit record and a review comment while the status change persists.

> **Verifier correction.** The ticket_comments mirror's swallowed error is documented best-effort by design (route.ts:193-196); the genuine defect is the unchecked audit_logs insert at :214-223. RLS denial is not a plausible failure mode there — supabaseAdmin is the service-role client and bypasses RLS — leaving missing-column/constraint failures as the realistic silent-loss path.

**Done when.**

- [ ] The status update, comment mirror and audit insert happen in one server-side transaction (a `SECURITY DEFINER` RPC, in the shape of `post_ticket_comment`), or the audit insert's `{ error }` is checked and a failure is loudly recorded to a retryable queue
- [ ] The `ticket_comments` mirror failure is logged (and retried or reconciled), not swallowed by `.then(() => {}, () => {})`
- [ ] A test asserts that a failing audit insert does not produce a `{ok: true}` response

**Partial (2026-10-02, drafting-flow Round G).** DF-P1 RAILS — the audit write is checked and written **before** the transition, so a transition never lands without its row; it is not one transaction and there is no retryable queue, so this stays OPEN with an owner. The failure handling is `DEC-89` item 2, the fleet plan's default for its decision `EVID-12/SM-7`: the transition is refused (500) when its audit row cannot be written. *(Corrected twice by DF-P1's fix passes. As first built, the committed transition stood when its row could not be written: the route marked the ticket's history and answered 500 `audit_unrecorded`, `applied: true`, and the request page — which treats any non-OK answer as a failure — left its modal open, so a retried `attach_file` or `save_progress` was applied twice. The second fix pass replaced that with the plan's default.)*
- `app/api/tickets/workflow-action/route.ts:618-669` — the audit row is written after every check and read and before the first write, the compare-and-set (`:742-785`). The hold release or keep waits until the compare-and-set has landed (`:787-858`). supabase-js resolves a refused insert with `{ error }` (the old bare `await` reported success either way), so `insertAuditRowOnce` (`:103-118`) inspects it, retries once with the same id, and counts `23505` as landed. If the row still cannot be written: the error is logged with the action, ticket, transition and actor (`console.error("[workflow-action] AUDIT ROW NOT WRITTEN … nothing applied")`) and the caller gets **500** `{ code: "audit_unwritable", applied: false }` (`:661-669`) with nothing applied — never `{ ok: true }` with a missing row, and never a 500 for a transition that was applied.
- `:670-689` — when the row landed but the transition did not (lost compare-and-set → 409, refused update → 500, `:775-785`), a `TICKET_<ACTION>_NOT_APPLIED` row names the attempt, so the trail never reads a lost transition as applied; if that row cannot be written, both ids are logged. A close or cancel that loses its race has released no hold and written no hold row, so its `_NOT_APPLIED` row is the whole truth. *(DF-P1's third fix pass, 2026-10-07. Before it, the hold release ran between the audit row and the compare-and-set. A close that released a hold and then lost its race left the hold released, while its `_NOT_APPLIED` row said the close had not happened.)*
- `:787-858` — the closer's hold resolution, applied only after the compare-and-set has landed. A release that fails is retried once. A second failure cannot un-close the ticket. The hold stays active, the conservative state: the document stays blocked and can be released from its hold panel. The route records a `TICKET_<ACTION>_HOLDS_NOT_RELEASED` row naming the attempt row and the hold ids, logs the failure, and answers 200 with `warning` and `holdsNotReleased`. The request page does not show `warning` yet; that is a hand-off to DF-P9 (`99-fix-sequencing.md`, "Hand-offs from DF-P1").
- `:860-894` — the `ticket_comments` mirror is checked, retried once (a `23505` on the retry counts as landed), then logged with the comment and ticket ids ("reconcile from tickets.comments") instead of `.then(() => {}, () => {})`.
- Tests: `lib/__tests__/dfRoundG_P1_rails.test.ts:641`, the EVID-12 / SM-7 block — `:649` (a transient failure is retried with the same id — one row, 200), `:663` (`23505` on the retry is landed), `:674` (a row that cannot be written → 500 `audit_unwritable`, `applied: false`, no ticket write, no mirror, no notification; the retry applies once), `:701` (the row precedes the compare-and-set, and the hold release follows it), `:720` (a close or keep that loses its race releases no hold and writes no hold row; a refused update the same), `:746` (a release that fails after the close landed: retried once, then the hold stays active, `_HOLDS_NOT_RELEASED` names the attempt and the hold, 200 with `warning`), `:774` / `:795` (the `_NOT_APPLIED` row, and its logged failure), `:806` (the mirror retried, then logged with both ids; the transition stands). `:701`, `:720` and `:746` fail on the code before the third fix pass; the others fail on the code before the second; the mirror test fails on the base code.

**Done-when.**
- ✗ (in part) Not one transaction (no RPC: the audit row, the update and the mirror are still separate writes). The audit insert's error **is** checked, and a failure refuses the transition before anything is applied, which is the fleet plan's stated alternative to the RPC — but nothing writes "to a retryable queue": a mirror that fails twice, or a `_NOT_APPLIED` row that fails twice, is logged and not re-attempted later.
- ✓ The `ticket_comments` mirror failure is retried and logged, not swallowed.
- ✓ A failing audit insert does not produce `{ ok: true }` — it produces a 500 with nothing applied (`lib/__tests__/dfRoundG_P1_rails.test.ts:674`).

**Scope / residual.** A drain for what is only logged — a `ticket_comments` mirror that failed twice (reconcile from `tickets.comments`), and a `_NOT_APPLIED` row that failed twice (reconcile from the ticket's history) — or the transition + audit as one RPC: **unowned in the fleet plan**; proposed owner DF-P11 (AFTER-DC, the maintenance-cron residuals), or admin-and-org P7 with `ALOG-8`'s dead-letter work. The request page needs no change for this finding: a refused transition is a plain failure and a retry applies once (the hand-off to DF-P9 for `applied: true` is withdrawn — `99-fix-sequencing.md`, "Hand-offs from DF-P1"). Two hand-offs from the third fix pass, 2026-10-07, are in the same table. Admin-and-org P7's audit viewers must pair each attempt row with the `_NOT_APPLIED` or `_HOLDS_NOT_RELEASED` row naming it (`EVID-12`, "Reading the trail"). DF-P9's request page should show the 200's `warning` when a close's hold could not be released.

**Partial (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC. Not built. Both forms the plan names need a file this package may not edit this round: the one-RPC form is the workflow route (`app/api/tickets/workflow-action/route.ts`, DF-P15's this round), and the drain belongs in the maintenance cron (`app/api/cron/maintenance/**`, admin-and-org's). A drain with no caller would be dead code (`DEC-31`).

**Done-when.** ✗ (in part) done-when 1 unchanged (no retry queue); 2 and 3 ✓ as recorded above.

**Scope / residual.** → the next holder of `app/api/cron/maintenance/route.ts` (admin-and-org P5) for the drain (reconcile a twice-failed `ticket_comments` mirror from `tickets.comments`; write the `_NOT_APPLIED` row for an attempt row whose transition never landed, read from the ticket's history), or DF-P15 for the one-RPC form. Re-assignment is the integrator's. *(Re-assigned: drafting-flow DF-P8 PROJECTS — assigned by the integrator at the DF-P11 merge, 2026-10-21, DEC-31.)*

**Resolution (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. The drain (DEC-90 ruling (6) for DF-P8; the RPC form is `EVID-12`'s remainder). `lib/ticketAuditDrain.ts` `runTicketAuditDrain`, run as one step of the maintenance cron (`app/api/cron/maintenance/route.ts:535`, step 5d, 10 s budget; no new cron entry, no new table): (a) a workflow comment in `tickets.comments` (every live ticket modified in the last 7 days, keyset-paged — see the fix pass below) with no `ticket_comments` row of its id is inserted in the route's own mirror shape — a row that exists, even soft-deleted, is never touched; (b) an attempt row marked `details.historyAttempt` (the transition's history line now names it, stamped in the same compare-and-set — `app/api/tickets/workflow-action/route.ts:1510-1523`, `:1608`), settled 15 minutes, with no follow-up naming it, on a live ticket whose history has no line naming it, gets its `_NOT_APPLIED` row (`reason: "reconciled"`, `reconciledBy: "maintenance"`); a history line naming it means it landed and nothing is written. A failed read writes nothing and says so; never throws.

**Done-when.**
- ✓ (1) by its second form: the audit insert's error is checked and refuses the transition (DF-P1, as recorded), and what the route can only log — a `_NOT_APPLIED` row that failed twice — is reconciled by the drain from the ticket's history.
- ✓ (2) the mirror failure is logged (as recorded) and now reconciled.
- ✓ (3) as recorded. Tests: `dfRoundG_P8_projects.test.ts` "SM-7 / EVID-12 (DEC-90 ruling (6)): the drain …" (5 cases: pure shapes, mirror reconcile, attempt reconcile with landed / follow-up / archived / pre-DF-P8 rows, a failed read, the cron step); `dfRoundG_P15_routes.test.ts` "SM-7 (DF-P8): the transition's own history line names its audit row …".

**Scope / residual.** The one-transaction RPC → `EVID-12`'s remainder (proposed owner: a NEW drafting-flow package, provisionally **DF-P23** (DF-P21 and DF-P22 are taken — the integrator assigns, and renumbers if DF-P23 is taken at the merge) — the next holder of `app/api/tickets/workflow-action/route.ts` and `lib/ticketTransitions.ts`; corrected at DF-P8 fix pass 3 — this line first named DF-P21, which is the renumbered-files package). An attempt row written before this deploy is never decided by the drain.

**Fix pass (2026-10-21, drafting-flow Round G — the independent review).** The first version read only the newest 300 tickets (leg a) and the newest 300 attempt rows (leg b) per run, across every workspace, with no cursor, and the follow-up read had no paging: on a deployment with more than ~300 transitions a day, already-decided rows filled those slots every night and an older lost attempt left the window unread. Corrected: both legs keyset-page the WHOLE 7-day window, oldest first, on (timestamp, id) (`lib/ticketAuditDrain.ts` `keysetAfter`), and the follow-up read is keyset-paged on id, so no fixed slice of already-decided rows and no PostgREST row cap can starve an older row or hide a follow-up; a run stops only at its deadline (the step's 10 s; leg (a) at most half of it) and a run that stops before the end of the window says so as an ERROR line in the cron's result (and `truncated`). Because the oldest rows are read first, every attempt row in the window is decided before it leaves the window as long as one daily run can read about one day's attempt rows; when it cannot, every run reports it. The `/api/tickets/project-link` attempt rows now carry `details.historyAttempt` and their history line names them (`attempt`), so a link whose `_NOT_APPLIED` write failed twice is reconciled too. The report gains `ticketsRead` / `attemptsRead`. Tests: `dfRoundG_P8_projects.test.ts` "fix pass (major 2)" — a lost attempt 6 days old behind 700 newer landed ones is reached and paired once (a second run writes nothing); 1,500 follow-ups past a 1,000-row cap still settle the attempt they name; a lost mirror on the 650th ticket is reconciled; a run out of time writes nothing undecided and reports two error lines — against a stand-in that honours order, limit, the keyset `or()` and a row cap. Done-when 1 stays ✓ on that basis; the bound (one daily run's 10 s must cover about a day's rows) is said by the run itself whenever it does not hold.

**Fix pass 2 (2026-10-21, drafting-flow Round G — the second independent review).** Leg (a) sent every recent comment id in one `.in('id', …)` on the uuid column `ticket_comments.id`. A single legacy non-UUID id therefore made PostgREST refuse the whole read (22P02), on every run. The window was also compared as strings, so a non-ISO date such as "Tue Oct …" sorted as recent, and the mirror dropped the comment's mentions. Now only a comment whose id is a UUID and whose date parses (`Date.parse`) is decided. The window is compared on parsed times. Every other comment is counted in the report's `commentsUndecidable` and is never read or written. The mirror carries `mentionedUserIds` (UUIDs only) as `mentioned_uids`, which `lib/ticketReadScope.ts` reads (`lib/ticketAuditDrain.ts` `commentTime`, `mirrorRowFor`). Tests: `dfRoundG_P8_projects.test.ts` "fix pass 2 (minor 5): a legacy comment whose id is not a UUID, or whose date is not ISO, is counted and skipped …" (its stand-in refuses a non-UUID `in()` with 22P02, as the column does), plus the extended pure-shape test.

**Pending migration:** none for this limb (it works before and after `20261256`).

---

<a id="sm-8"></a>

## SM-8 · CANCELED is documented to users as a workflow state, is treated as terminal by the archiver, and is reachable by no code path — while a ticket that somehow reaches it has no legal action for anyone but an admin

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/requests/WorkflowDiagramModal.tsx:36`, `types/schema.ts:1032`, `lib/ticketShed.ts:11`, `lib/ticketTransitions.ts:311`, `lib/workflow.ts:80-342`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Both halves confirmed: nothing writes CANCELED, and workflow.ts has no case for it (only the global `ticket.force_close` override at :345 would offer anything). Severity overstated — because the state is genuinely unreachable, no ticket is ever actually stranded in it; the live defect is a workflow-diagram modal advertising an exit the product does not implement, which is a docs/feature gap, not a MEDIUM data or integrity risk.

**Mechanism.** `CANCELED` appears in the TicketStatus union, in `TERMINAL_TICKET_STATUSES`, in computeTransition's `TERMINAL` array (so it would stamp `closed_at`), in the archive eligibility filter, and — visibly to end users — in the workflow diagram modal as "Withdrawn or returned to the requester. A terminal exit off the main flow." No transition in computeTransition's switch produces it. Three differently-shaped searches confirm the absence: `grep -rn "status.*CANCELED\|CANCELED.*status"` filtered to writes returns only comments and a test; `grep -rin canceled` filtered to `update|insert|= 'CANCELED'` returns only Stripe subscription statuses and read-side `!==` comparisons; and `grep -rn "cancel_ticket\|'cancel'\|\"cancel\""` returns nothing. Conversely, `WorkflowEngine.getActions` has no `case 'CANCELED'`, so a ticket in that state offers only the global Force Close, and only to `ticket.force_close` holders (default Admin/Manager/Supervisor).

**Failure scenario.** A requester wants to withdraw a request that is no longer needed. The workflow diagram modal — the app's own explanation of the lifecycle — tells them Canceled is where withdrawn requests go. There is no button anywhere that produces it. They either abandon the ticket in place (where it keeps generating SLA/attention noise, since lib/notifications.ts:218 only suppresses CLOSED and CANCELED) or an admin force-closes it, mislabelling a withdrawal as a completed-and-acknowledged package. If a row ever does reach CANCELED — a data import, a direct write via the wide-open RLS policy of finding #2 — its requester and drafter have no action at all.

**Evidence.**

components/requests/WorkflowDiagramModal.tsx:36 — shown to users —
```
{ status: "CANCELED", label: "Canceled", blurb: "Withdrawn or returned to the requester. A terminal exit off the main flow." },
```
lib/ticketTransitions.ts:311-314 — treated as a real terminal state —
```
const TERMINAL = ["CLOSED", "CANCELED"];
const wasTerminal = TERMINAL.includes(ticket.status);
const nowTerminal = TERMINAL.includes(newStatus);
if (nowTerminal && !wasTerminal) updates.closed_at = new Date().toISOString();
```
lib/workflow.ts:80-342 — the switch handles NEW, PENDING_ENG_INITIAL, PENDING_ENG_TEAM, PENDING_ASSIGNMENT, DRAFTING, REVISION_REQ, PENDING_REVIEW, PENDING_FINAL_APPROVAL, PENDING_IFC, FINAL_DRAFT, CLOSED — and no CANCELED case.

**Chain reaction.** The archiver's own admin copy repeats the promise: app/(protected)/admin/storage/page.tsx:1236 tells admins "Only CLOSED/CANCELED tickets are eligible", implying a cancel path exists. And because `reopen_ticket` is offered only under `case 'CLOSED'`, a CANCELED ticket cannot be reopened even by an admin — the resurrection escape hatch that makes CLOSED safe does not cover the other terminal state.

> **Verifier correction.** Accurate but impact is documentation-only: because nothing can write the status, the "no legal action for anyone but an admin" consequence is unreachable. The live defect is that the user-facing workflow diagram (WorkflowDiagramModal.tsx:36) advertises a terminal cancel/withdraw exit that no transition implements.

**Done when.**

- [ ] Either a `cancel_ticket` action exists (available to the requester and to `ticket.force_close` holders across the open statuses, mapping to status CANCELED in computeTransition), or CANCELED is removed from the TicketStatus union, the workflow diagram, the shed's terminal set and the TERMINAL array
- [ ] If CANCELED stays, `getActions` has a `case 'CANCELED'` offering `reopen_ticket` on the same terms as CLOSED
- [ ] A test enumerates every value of TicketStatus and asserts each is both reachable by some transition and offers at least one action to someone

**Resolution (2026-10-02, drafting-flow Round G).** Record-only close by pointer to roles-and-permissions [`WF-17`](../roles-and-permissions/06-request-workflow.md) / `DEC-14` and, for done-whens 2 and 3, [`DEC-84`](../DECISIONS.md#dec-84) (provisional label — the integrator renumbers it at merge) (Round E, `e5a203b`; migration `20261053`, `a93f7ff`, **applied & verified live 2026-09-17** — MIGRATION-PASTE-ORDER row 55), re-verified against `f1ac550`. `CANCELED` is now produced: `cancel_request` (`lib/workflow.ts:252-263`, requester identity or the `ticket.manage` tier, comment required, offered at `PENDING_ASSIGNMENT` `:333` and `DRAFTING` `:339`) → `case "cancel_request": … updates.status = "CANCELED";` (`lib/ticketTransitions.ts:224-227`), `closed_at` stamped by the terminal rule (`:384-389`), audited `TICKET_CANCEL_REQUEST` by the route; the hold gate keys on the terminal status, so a cancel over an open originating hold is a 409 like a close. It is terminal: `case 'CANCELED': break;` (`lib/workflow.ts:554-555`) and `isTerminal` (`:246`) withholds force close, reassignment and attaching. The diagram now tells the truth: `components/requests/WorkflowDiagramModal.tsx:36` — "Withdrawn by the requester (or management) with a reason … it is not reopened; file a new request instead."
- Tests: `lib/__tests__/sweepRoundE_A.test.ts:338` ("WF-17 / DEC-14": cancel matrix, transition, route, hold gate, intent bridge, terminal census); `lib/__tests__/dfRoundG_P0.test.ts:295` (new — breadth-first walk of the engine from `getInitialStatus()` reaches every value of the `TicketStatus` union, parsed from `types/schema.ts`); `lib/__tests__/dfRoundG_P0.test.ts:308` (new — every status but `CANCELED` offers someone an action, `CLOSED` offers `reopen_ticket`, `CANCELED` offers nobody anything). Mutation-checked: removing the `cancel_request` transition fails the walk.

**Done-when.**
- ✓ A cancel action exists and maps to `CANCELED` — in `DEC-14`'s shape (requester identity + `ticket.manage`, from `PENDING_ASSIGNMENT` and `DRAFTING`), which binds over this finding's illustrative "requester and force_close holders across the open statuses"; `ticket.force_close` holders still close from any open status (`lib/workflow.ts:559-564`).
- Not done, by decision — overruled by `DEC-84` (fix pass; provisional label, renumbered at merge): `case 'CANCELED'` offers nothing, not `reopen_ticket` on `CLOSED`'s terms. `DEC-14`'s own text does not address reopening, so DF-P0 first closed this on a "binding reading" written into `DEC-14`'s landed note; the review fix pass records the call as a decision of its own instead. A canceled request issued no deliverable to recover (a cancel is offered only at `PENDING_ASSIGNMENT` and `DRAFTING`), and a withdrawn request is refiled, not resurrected — the fail-safe choice for the record, reasoned in full under [`DEC-84`](../DECISIONS.md#dec-84).
- ✓ in part, the rest overruled by `DEC-84`: a test enumerates every `TicketStatus` and asserts each is reachable (`lib/__tests__/dfRoundG_P0.test.ts:295`) and offers at least one action to someone — every status except `CANCELED`, which under `DEC-84` offers nobody anything, and the test asserts exactly that (`lib/__tests__/dfRoundG_P0.test.ts:308`).

**Scope / residual.** What a scanned print of a canceled ticket's deliverable should say (`withdrawn`, never `current`) was `EDGE-2`'s remainder, DF-P10 — built (`withdrawn`; `EDGE-2` RESOLVED). The admin storage copy "Only CLOSED/CANCELED tickets are eligible" is now true.

---

<a id="sm-9"></a>

## SM-9 · Four writers to the ticket row bypass the compare-and-set entirely and clobber whole JSONB arrays — including the split-brain the comment API was specifically hardened against

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:978`, `app/(protected)/requests/[id]/page.tsx:1010-1014`, `app/(protected)/requests/[id]/page.tsx:1328`, `app/(protected)/requests/[id]/page.tsx:920`, `app/api/intake/upload/route.ts:182-190`, `app/api/tickets/comment/route.ts:205-216`, `app/api/tickets/workflow-action/route.ts:155-191`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Accurate; if anything undercounted (five writers, not four — the intake route is a fifth). The whole-array clobber is real for comments, attachments+history and watchers, and the guard the finding says they bypass demonstrably exists on the two hardened paths.
- **Assigned:** drafting-flow DF-P11 AFTER-DC (the ticket shed's commit and restore) — by the integrator, 2026-10-07 (at the DF-P1 merge, DEC-31: the package that left this remainder has merged; fleet plans `audit-reports/fleet-plans/drafting-flow.json`, `admin-and-org.json`).

**Mechanism.** The workflow route CASes on `(id, status, last_modified)` and the comment PATCH/DELETE handlers CAS on `last_modified` — but five other writers do an unguarded read-modify-write of the same whole arrays. `handleUpdateCategory` writes `{ comments: updatedComments }` with no CAS and without even bumping `last_modified` (so it is invisible to every other CAS). `handleFileUpload` writes `{ attachments, history, last_modified }` with no CAS. `toggleWatch` writes `{ watchers }` with no CAS. The intake portal's redline branch writes `{ attachments, history, last_modified }` with no CAS. All read their base state from a React snapshot or an earlier SELECT.

**Failure scenario.** A reviewer clicks "Approve (Issue for Construction)". The route reads the row, computes `attachments` with the staged→submitted flips plus the redline, and writes it. Two seconds earlier the drafter had started a file upload; the upload's R2 put finishes just after, and `handleFileUpload` writes `attachments: [...snapshot, newFile]` and `history: [...snapshot, uploadEntry]` from state captured BEFORE the approval. The status stays PENDING_IFC (that column isn't in the update), but the approval's history entry — "Approve (Issue for Construction) — issued Rev 1" — is erased from `tickets.history`, and every draft attachment reverts to `status: "staged"`. The audit_logs row still says the approval happened. The ticket's own history, which is what a PSM auditor reads on the page, no longer contains the approval.

**Evidence.**

app/(protected)/requests/[id]/page.tsx:978 — no CAS, no last_modified —
```
await supabase.from('tickets').update({ comments: updatedComments }).eq('id', ticketId);
```
app/(protected)/requests/[id]/page.tsx:1010-1014 —
```
await supabase.from('tickets').update({
  attachments: [...currentAttachments, newAttachment],
  last_modified: now,
  history: [...currentHistory, historyEntry],
}).eq('id', ticketId);
```
app/api/intake/upload/route.ts:182-190 —
```
const { error: updErr } = await supabaseAdmin.from("tickets").update({
  attachments: [...((ticket.attachments as unknown[] | null) ?? []), attachment],
  history: [...((ticket.history as unknown[] | null) ?? []), { ... }],
  last_modified: nowIso,
}).eq("id", ticketId);
```
versus the protection the codebase already knows it needs, app/api/tickets/comment/route.ts:202-211 —
```
// CAS on the ticket's last_modified as read: a concurrent workflow action
// rewriting the comments array must not be clobbered by this whole-array
// write (the exact split-brain post_ticket_comment was built to prevent).
casQuery = auth.readLastModified ? casQuery.eq("last_modified", auth.readLastModified) : ...
```

**Chain reaction.** `handleUpdateCategory` additionally never mirrors into `ticket_comments`, so the root-cause category diverges permanently between the JSONB thread (which the UI renders) and the table (which exports, the archive bundler at ticket-shed/route.ts:157-166, and any reporting read). In the other direction, `handleFileUpload`/intake bumping `last_modified` churns the CAS token that the workflow route depends on, so a reviewer mid-approval gets a spurious 409 whenever anyone uploads a file or marks the ticket urgent (`requests/page.tsx:620,639` also write `last_modified`).

> **Verifier correction.** Count is inconsistent (title "four", body "five"): the unguarded ticket-row writers are requests/[id]/page.tsx:978, :1010-1014, :1328 and app/api/intake/upload/route.ts:182-190. None of them writes `status`, so the state machine cannot be corrupted this way — the exposure is lost history entries, attachment records, watchers and comment-category edits under concurrency, which is a real but conditional consequence.

**Done when.**

- [ ] `handleUpdateCategory`, `handleFileUpload` and `toggleWatch` are moved behind server routes that CAS on `last_modified` and mirror into `ticket_comments` where relevant
- [ ] The intake redline write uses an append-only server-side operation (a `||` JSONB append RPC, like `post_ticket_comment`) rather than a client-computed whole-array replace
- [ ] No code path writes `tickets.attachments`, `tickets.comments` or `tickets.history` as a whole array without a compare-and-set on the value it read
- [ ] A test simulates interleaved workflow-action + file-upload writes and asserts neither loses the other's array entry

**Partial (2026-10-02, drafting-flow Round G).** DF-P1 RAILS. *(This block was first written as a Resolution and the status set to RESOLVED. The DF-P1 fix pass, 2026-10-02, reopened it: done-when 3 does not hold for the ticket-shed commit route, which DF-P1 does not own; see done-when 3 and the residual.)* Done-when 1 was closed by roles-and-permissions [`WF-9`](../roles-and-permissions/06-request-workflow.md) (Round E, `e5a203b`, re-verified here): the page no longer writes `comments`, `attachments` or `watchers` — the category edit is the comment route's PATCH (`app/api/tickets/comment/route.ts:237-290`, compare-and-set, mirrored into `ticket_comments`), the upload is the workflow route's `attach_file` action, the follow toggle is `/api/tickets/watch` (`app/api/tickets/watch/route.ts:53-108`, compare-and-set with one re-read). DF-P1 closes the rest; **Pending migration:** `supabase/migrations/20261166_df_roundG_ticket_rails.sql` (`DEC-30`: one paste, not a widening, after `20261038` / `20261039`, and after the DF-P1 app deploy, never before it: `AUTHZ-13`, "Paste order") — the database half is not closed in any database until it is pasted.
- **The intake redline is an append.** `append_ticket_redline(p_ticket_id, p_org_id, p_attachment, p_history)` (new, `supabase/migrations/20261166_df_roundG_ticket_rails.sql:565-594`): one `UPDATE … SET attachments = COALESCE(attachments, '[]'::jsonb) || jsonb_build_array(p_attachment), history = … || jsonb_build_array(p_history), last_modified = NOW() WHERE id = … AND org_id = … AND archived_at IS NULL`, `SECURITY DEFINER`, `search_path` pinned, refused to a signed-in caller inside and EXECUTE granted to `service_role` only. The intake route calls it (`app/api/intake/upload/route.ts:977-1001`); a ticket that took no append attaches nothing and its stored object is removed — 404 when the ticket is gone, 409 when it was archived after the route read it (the route re-reads `archived_at` to tell which); any other error → 500 and the object removed. Until the paste the function is absent (PGRST202) and the route falls back to a compare-and-set on the `last_modified` it read (`:1002-1028`: the null token its own leg, `archived_at IS NULL` on the write so an archived stub takes nothing (the `20260810` invariant), one re-read and retry, a ticket archived meanwhile → 409, a second loss → 409 "send the redline again", object removed in each case). An archived ticket is refused before anything is stored, on both paths: 409 "This request is archived, so it can't take a redline. Ask the requester to restore it, then send the redline again." (`:942-948`, the ticket read selecting `archived_at`). *(DF-P1 fix pass 2, 2026-10-02: the first version told the sender of a redline on an archived ticket that no redline request on the link matched, and the pre-paste fallback could write onto an archived stub.)*
- **The comment route's legacy write** (the `post_ticket_comment`-absent fallback — a whole-array replace) now compare-and-sets on the token it read and answers 409 on a lost race (`app/api/tickets/comment/route.ts:130-150`).
- **Browser writers** can no longer write `attachments` / `comments` / `watchers` at all, and `history` only as an append in their own name (the `SM-2` guard, `20261166:273-321`): a stale whole-array history write that would drop a concurrent entry is refused by the prefix check, not applied.
- Exercised on a throwaway PostgreSQL 16 built from the real function bodies, in both foreign-key worlds (orphan intents present / absent), the script applied four times in each (idempotent; 13 of 13 probes true every time): the service role's append adds exactly one attachment and one history entry and leaves the first entry byte-identical (C28); the wrong org and an archived stub take nothing (C29, C30); a signed-in member and anon cannot execute it (C31, C32, "permission denied for function append_ticket_redline"); a non-object payload is refused (C33).

**Done-when.**
- ✓ `handleUpdateCategory`, `handleFileUpload` and `toggleWatch` are behind server routes that compare-and-set on `last_modified`, the category edit mirrored into `ticket_comments` (WF-9; re-verified).
- ✓ The intake redline write is an append-only server-side operation — a `||` JSONB append function like `post_ticket_comment` — rather than a client-computed whole-array replace (after the paste; before it, the route's compare-and-set fallback never overwrites a newer array).
- ✗ (in part) No code path writes `tickets.attachments`, `tickets.comments` or `tickets.history` as a whole array without a compare-and-set on the value it read. **Not met by the ticket shed.** `app/api/admin/ticket-shed/commit/route.ts:170-178` sets `comments: [], history: []` on a closed ticket, conditioned only on `archived_at IS NULL`, with no `last_modified` leg. A comment posted on the closed ticket between the shed's capture (produce) and the commit is wiped and is not in the archive bundle. `app/api/admin/ticket-shed/restore/route.ts:217-232` writes the bundle's arrays back, conditioned on `archived_at IS NOT NULL`. Every other writer refuses an archived stub (the workflow, comment and watch routes, and `append_ticket_redline`), so no concurrent entry can be lost there, but that write carries no compare-and-set either. Met everywhere DF-P1 owns: the workflow route (`(id, status, last_modified)`, the null token its own leg since `EDGE-15`), the comment route (RPC append; PATCH / DELETE and now the legacy fallback compare-and-set), the hand-back route (`app/api/tickets/handback/route.ts:84-85`), the intake redline (append / fallback compare-and-set); browser writers are held to an append by the guard.
- ✓ Interleaving tests: `lib/__tests__/intakeUploadRoute.test.ts:1051` (the append keeps a workflow file and an approval history entry already on the row — neither side loses its entry; a ticket gone in between is 404, one archived in between is 409, the object removed either way), `:1078` (an archived ticket is refused with 409 before anything is stored; the fallback's write carries `archived_at IS NULL`, and a ticket archived after the read is refused with the object removed), `:1107` / `:1120` (fallback: the compare-and-set legs; a row that changes under every attempt is refused with nothing attached over the newer arrays), `:1032` (a refused append / update removes the stored object); `lib/__tests__/dfRoundG_P1_rails.test.ts:1252` (the comment fallback's legs, and a workflow write landing between read and write → 409, no clobber), `:887` (two concurrent workflow writes on a null-token row: one 200, one 409).

**Scope / residual.** The ticket shed's commit (and, for symmetry, its restore) → **DF-P11**, which already owns `app/api/admin/ticket-shed/*` (its `SM-4` row re-reads status at commit). The commit should carry a `last_modified` leg captured at produce time, or re-capture the arrays and refuse when they changed, so a comment posted after capture is never wiped unarchived (`99-fix-sequencing.md`, "Hand-offs from DF-P1"). The hand-back route's compare-and-set has no null-token leg (`app/api/tickets/handback/route.ts:85` adds `last_modified` only when present) — the `EDGE-15` class on a file DF-P1 does not own; noted for the hand-back's owner (DF-P2 / DF-P4), not fixed here.

**Partial (2026-10-13, drafting-flow Round G).** DF-P4 LIBRARY — the hand-back route's null-token leg (the `EDGE-15` class, handed to DF-P4 at the DF-P2 merge). `app/api/tickets/handback/route.ts:89` now compare-and-sets a ticket with no `last_modified` on the null itself (`q.is("last_modified", null)`), as the workflow route does since DF-P1: the first writer stamps it and a concurrent second matches no row (409) — never a write with no leg at all. Test: `lib/__tests__/dfRoundG_P4_library.test.ts` ("SM-9 / EDGE-15 class (DF-P4)": the legs after the update are `eq id` and `is last_modified null`; with a token, the token).

**Done-when.** ✗ (in part) done-when 3: every writer DF-P4 owns now compare-and-sets (the hand-back's null leg closed); the ticket shed's commit is still unguarded (DF-P11), as recorded above.

**Scope / residual.** The ticket shed's commit / restore → **DF-P11** (unchanged).

**Resolution (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC — done-when 3's remainder (the ticket shed). `app/api/admin/ticket-shed/commit/route.ts`: the stamp that precedes `comments: [], history: []` now compare-and-sets on the terminal status and the `last_modified` the commit read (`:225-237`, the null its own leg), after a re-read that refuses (409) any ticket written since the archive was produced (`changedSinceCapture`, `lib/ticketShed.ts:158`) — so a comment or attachment written between produce and commit is never wiped unarchived. `app/api/admin/ticket-shed/restore/route.ts`: a snapshot restores only into the stub reclaimed into THAT archive (`:170-173`, an older archive's copy is skipped and counted `staleSnapshot`), and the write compare-and-sets on the stub's `archive_id` and `last_modified` (`:237-247`, each null its own leg).

**Done-when.**
- ✓ 1, 2 and 4 as recorded above (WF-9; DF-P1; DF-P4).
- ✓ 3 — no code path writes `tickets.attachments`, `comments` or `history` as a whole array without a compare-and-set on the value it read: the shed's commit and restore now do. (The database half — the `SM-2` guard and `append_ticket_redline` — remains `20261166`'s, pending its paste as already recorded.)
- Tests: `lib/__tests__/ticketShedCommit.test.ts` "SM-9 — a comment posted after capture is never wiped unarchived" and "SM-9 (restore) — only from the archive the stub was reclaimed into, compare-and-set on the stub"; `aoRoundGP13ShedAudit.test.ts` re-seeded with a terminal status.

**Scope / residual.** None beyond `20261166`'s pending paste.

---

<a id="sm-10"></a>

## SM-10 · The ticket page rewrites `approve_initial` into `assign` before sending, which the server refuses — every ticket at NEW or PENDING_ENG_INITIAL is a hard dead end for its only forward action

- **Severity:** LOW
- **Status:** INVALID
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:1065-1075`, `lib/workflow.ts:82-109`, `lib/workflow.ts:137-155`, `app/api/tickets/workflow-action/route.ts:96-103`, `supabase/schema.sql:405`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The rewrite→403 is real, but two facts cut the severity hard. (1) The states are unreachable: every ticket-insert site hardcodes the status — requests/new/page.tsx:255 `const initialStatus: TicketStatus = 'PENDING_ASSIGNMENT'`, CheckInPanel.tsx and lib/transitionIn.ts:304 both insert `status: "PENDING_ASSIGNMENT"` — and workflow.ts:47-52 getInitialStatus always returns PENDING_ASSIGNMENT; nothing in the codebase ever writes NEW or PENDING_ENG_INITIAL. (2) Even at NEW it is not a dead end: `request_eng_review` (requiresEngineerPick) and `reject` (requiresComment) take earlier branches at :1051-1064, are not rewritten, and are accepted — request_eng_review routes NEW→PENDING_ENG_TEAM→approve_team→PENDING_ASSIGNMENT, a working forward path.

**Mechanism.** `initiateWorkflowAction` intercepts `approve_initial` and substitutes `{...action, action: 'assign', label: 'Approve & Assign'}` before calling the route. But `assign` is offered by getActions ONLY at PENDING_ASSIGNMENT; the NEW / PENDING_ENG_INITIAL branch offers `approve_initial`, `request_eng_review`, `reject` and nothing else. The route validates `body.actionType` against `getActions(ticket, ...)` for the ticket's CURRENT status, so a ticket at NEW receives 403 `Action "assign" is not available to you at status NEW`. At PENDING_ASSIGNMENT the swap is a no-op (assign is legal there), which is why the bug is invisible in normal use — every current creation path hard-codes PENDING_ASSIGNMENT.

**Failure scenario.** A ticket exists at NEW — the table default is `status TEXT NOT NULL DEFAULT 'NEW'`, so any insert that omits status (an external tool, a data restore, a future code path, or a row predating the assignment-first routing) lands there. Its owner opens it, sees the full and correct set of buttons the state machine renders, clicks "Approve Request (To Assignment)", and gets a 403 error toast. The other two buttons (`request_eng_review`, `reject`) work but both lead away from the intended path — and `reject` leads to the orphaned REVISION_REQ of finding #5. The ticket cannot be moved forward at all through the UI.

**Evidence.**

app/(protected)/requests/[id]/page.tsx:1066-1075 —
```
else if (action.action === 'assign' || action.action === 'approve_initial') { 
  // If approving, we swap the action to 'assign' so the backend logic moves it straight to DRAFTING
  const effectiveAction = action.action === 'approve_initial' 
    ? { ...action, action: 'assign', label: 'Approve & Assign' } 
    : action;
```
lib/workflow.ts:82-101 (no `assign` at these statuses) —
```
case 'NEW':
case 'PENDING_ENG_INITIAL':
  if (isManagement || allows('ticket.initial_review')) {
     actions.push({ label: 'Approve Request (To Assignment)', action: 'approve_initial', ... });
     actions.push({ label: 'Flag for Engineering Review', action: 'request_eng_review', ... });
     actions.push({ label: 'Reject / Return to Requester', action: 'reject', ... });
```
app/api/tickets/workflow-action/route.ts:97-103 —
```
const action = allowed.find((a) => a.action === body.actionType);
if (!action) {
  return NextResponse.json({ error: `Action "${body.actionType}" is not available to you at status ${ticket.status}` }, { status: 403 });
}
```

**Chain reaction.** The swap also silently substitutes the history label: the recorded action becomes 'Approve & Assign' with the server recomputing from `action.label` — but since the server rejects the request the label never lands. More broadly the client is the only place computing an "effective action", which means the state machine's own vocabulary and the wire vocabulary have diverged in exactly one place; lib/__tests__/workflow.test.ts has no case at all for NEW or PENDING_ENG_INITIAL, so nothing catches it.

> **Verifier correction.** Dormant, not active: no current creation path or transition produces NEW or PENDING_ENG_INITIAL (requests/new/page.tsx:255, CheckInPanel.tsx:242, transitionIn.ts:309 all set PENDING_ASSIGNMENT; getInitialStatus returns it unconditionally). The dead end can only be hit by legacy/restored rows or an insert that omits status and takes the `DEFAULT 'NEW'` at schema.sql:405.

**Done when.**

- [ ] The client sends the action name the state machine produced; if approve-then-assign in one step is wanted, it is a named action in WorkflowEngine + computeTransition, not a client-side rename
- [ ] `tickets.status` has no permissive default (or defaults to 'PENDING_ASSIGNMENT'), so a row cannot arrive at NEW by omission
- [ ] lib/__tests__/workflow.test.ts covers NEW and PENDING_ENG_INITIAL, and an API test asserts each action the engine offers at each status is accepted by the route

**Resolution (2026-10-02, drafting-flow Round G) — INVALID against current code (`DEC-28`).** The mechanism no longer exists on `f1ac550`; it was removed by roles-and-permissions [`WF-17`](../roles-and-permissions/06-request-workflow.md) / `DEC-14` (Round E, `e5a203b` + migration `20261053`, `a93f7ff`, **applied & verified live 2026-09-17**). Contradicting code:
- No rewrite: `app/(protected)/requests/[id]/page.tsx:1274-1276` — `// Assignment opens the drafter picker. (The former approve_initial → assign rewrite is gone with the NEW stage — DEC-14 / WF-17.)` followed by `else if (action.action === 'assign') {`. The only remaining `approve_initial` strings in `app/`, `components/`, `lib/` are comments (`lib/workflow.ts:266`, `lib/ticketTransitions.ts:20`, `:199`).
- No such statuses: the union is `PENDING_ENG_TEAM | PENDING_ASSIGNMENT | DRAFTING | REVISION_REQ | PENDING_REVIEW | PENDING_IFC | FINAL_DRAFT | PENDING_FINAL_APPROVAL | CLOSED | CANCELED` (`types/schema.ts:1086-1096`); the engine's initial-review case is deleted (`lib/workflow.ts:265-267`); `approve_initial`'s transition branch is deleted (`lib/ticketTransitions.ts:199-200`).
- No permissive default: `ALTER TABLE tickets ALTER COLUMN status SET DEFAULT 'PENDING_ASSIGNMENT';` (`supabase/migrations/20261053_rp_roundE_dead_statuses.sql:53`, live), which also moved any rows in the two statuses (its inventory rode the paste).
- Pinned: `lib/__tests__/dfRoundG_P0.test.ts:286` (the union excludes `NEW` / `PENDING_ENG_INITIAL`; `getInitialStatus()` is `PENDING_ASSIGNMENT`; the default flip is in `20261053`).

**Done-when.** (1) ✓ the client sends the engine's action name — no rewrite exists. (2) ✓ the live default is `PENDING_ASSIGNMENT`. (3) Moot: there is no `NEW` / `PENDING_ENG_INITIAL` left for `workflow.test.ts` to cover; the route validates every posted action against the engine at the ticket's current status (`app/api/tickets/workflow-action/route.ts:160-170`, `EDGE-11` invariant 1).

**Scope / residual.** `supabase/schema.sql:443` still reads `status TEXT NOT NULL DEFAULT 'NEW'` as the pre-migration baseline of record (WF-17 explains why it is not edited); a restore of a pre-Round-E backup could re-insert such a row through the service role, and re-running `20261053`'s idempotent `UPDATE` moves it.

---

<a id="sm-11"></a>

## SM-11 · The ticket⇄document intent bridge is dead code: `rowToTicket` never maps `metadata`, so `ticket.metadata` is always undefined in the workflow route

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/ticketTransitions.ts:51-82`, `app/api/tickets/workflow-action/route.ts:230-274`, `lib/intents.ts:58`, `lib/intents.ts:68`
- **Same root cause as** `PERS-5` — `ticket.metadata` is always `undefined` server-side. This is why `GAP-110`'s declaration cannot live in `metadata`, and why the intent bridge is dead. Fix once; close the rest citing this one.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed dead code, and the contrast with the page's own mapper — which maps metadata correctly — settles that this is an omission, not a design choice. route.ts:245/265 are the only writers/deleters of ticket-sourced `document_intents` in the repo, so no other path compensates.

**Mechanism.** The route's intent bridge opens with `const srcDoc = (ticket.metadata as Record<string, unknown> | undefined)?.source_document` and does nothing unless `srcDoc?.id` is truthy. `ticket` is `rowToTicket(row)`, whose returned object literal has 28 keys and `metadata` is not among them — the literal is cast `as Ticket` and `metadata?` is optional, so TypeScript accepts it. At runtime `ticket.metadata` is `undefined` for every ticket, `?.source_document` is undefined, and the whole `if (srcDoc?.id)` body — both the DRAFTING/REVISION_REQ upsert and the CLOSED/FINAL_DRAFT cleanup — never executes. Two independent searches confirm this is the only writer of a ticket-sourced intent: `grep -rn document_intents` returns four write/read sites (this route, lib/intents.ts, the maintenance prune, and table registries), and `grep -rn TICKET_INTENT_TTL_MS` shows the constant is imported only here and in lib/intents.ts/its test.

**Failure scenario.** A drafter is assigned a revision ticket raised from P&ID D-3021 via the check-in flow (which does populate `metadata.source_document`). The coordination surfaces are supposed to show "someone is drafting a revision to this document right now." They never do. A second engineer, checking the document's overlap advisories before starting his own change, sees no in-progress work, checks it out, and revises the same drawing in parallel. Two divergent revisions of one PSM-controlled P&ID are produced with no advisory ever raised — which is precisely the collision the intent layer was built to prevent.

**Evidence.**

lib/ticketTransitions.ts:51-82 — the full returned literal, `metadata` absent —
```
export function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    id: ..., orgId: ..., ticketId: ..., title: ..., description: ..., unit: ...,
    requestType: ..., status: ..., priority: ..., requesterId: ..., requesterName: ...,
    requesterEmail: ..., requesterRole: ..., assignedDrafterId: ..., assignedDrafterName: ...,
    assignedEngineerId: ..., assignedEngineerName: ..., assignedEngineerEmail: ...,
    attachments: ..., comments: ..., history: ..., unreadBy: ..., watchers: ...,
    revisionCount: ..., deliverableRev: ..., draftIteration: ..., createdAt: ..., lastModified: ...,
  } as Ticket;
}
```
app/api/tickets/workflow-action/route.ts:230-234 —
```
try {
  const srcDoc = (ticket.metadata as Record<string, unknown> | undefined)
    ?.source_document as { id?: string } | undefined;
  if (srcDoc?.id) {
```
(The ticket detail page's own row mapper DOES map it — app/(protected)/requests/[id]/page.tsx:904: `metadata: (r.metadata as Record<string, unknown> | null) ?? undefined,` — which is why the field looks populated everywhere else.)

**Chain reaction.** The cleanup half is dead too, so even if the upsert is fixed, closing a ticket must also clear its intent or the 7-day TICKET_INTENT_TTL_MS row lingers as a phantom "in progress" marker. The `try/catch` around the block logs "intent bridge failed (non-blocking)" — it never fires, so the silence reads as success in the logs.

**Done when.**

- [ ] `rowToTicket` maps `metadata: (row.metadata as Record<string, unknown> | null) ?? undefined`
- [ ] lib/__tests__/ticketTransitions.test.ts's rowToTicket case asserts `metadata` round-trips
- [ ] An integration test (or a route test with a stubbed client) asserts that a transition into DRAFTING on a ticket carrying `metadata.source_document` upserts a `document_intents` row with `source: 'ticket'`, and that closing it deletes that row

**Resolution (2026-10-02, drafting-flow Round G).** Record-only close by pointer to roles-and-permissions [`LIFE-1`](../roles-and-permissions/07-document-lifecycle.md) (Round C2, `a84f712`, "found and fixed on the way"), re-verified against `f1ac550`. `rowToTicket` maps the bag: `metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,` (`lib/ticketTransitions.ts:86`), so the route's bridge — `const srcDoc = (ticket.metadata as Record<string, unknown> | undefined)?.source_document …` (`app/api/tickets/workflow-action/route.ts:513-514`) — now runs: entering `DRAFTING` / `REVISION_REQ` upserts the drafter's `source: "ticket"` edit intent, and `CLOSED` / `CANCELED` / `FINAL_DRAFT` (`const clearsAll = …`, `:522`) delete it.
- Tests: `lib/__tests__/dfRoundG_P0.test.ts:441` (new — `rowToTicket` round-trips the metadata object; null and absent stay `undefined`); `lib/__tests__/dfRoundG_P0.test.ts:448` (new — through the route, `assign` on a ticket with `metadata.source_document` upserts `{ document_id, user_id, kind: "edit", source: "ticket", ticket_id }` after the CAS write, and `close_ticket` from `FINAL_DRAFT` deletes on `document_id`, `ticket_id`, `source = 'ticket'` with no upsert); `lib/__tests__/sweepRoundE_A.test.ts:421` (cancel clears it) and `:587-631` (reassignment). Mutation-checked: removing the metadata mapping fails both new tests.

**Done-when.**
- ✓ `rowToTicket` maps `metadata`.
- ✓ A `rowToTicket` test asserts `metadata` round-trips — in `lib/__tests__/dfRoundG_P0.test.ts:441` rather than `lib/__tests__/ticketTransitions.test.ts` (kept out of a test file the DF-P3/DF-P4 chain edits); `lib/__tests__/sweepRoundC2.test.ts:184` also pins the mapping line.
- ✓ A route test asserts the DRAFTING upsert with `source: 'ticket'` and the delete on close (`lib/__tests__/dfRoundG_P0.test.ts:448`).

**Scope / residual.** None of this finding's done-whens is left; its sibling [`PERS-5`](./07-persistence-and-rls.md) asks for more (remove the `as Ticket` cast) and stays OPEN. Making the bridge live exposed a defect of its own, found in the DF-P0 review and **not** folded in here: the bridge trusts client-writable input and reads across tenants. It takes `srcDoc.id` from `ticket.metadata.source_document` (`app/api/tickets/workflow-action/route.ts:513-514`; `metadata` is client-writable, `SM-2`), reads `documents.current_version_id, library_id` with the service role and no `org_id` filter (`:549-553`), and upserts `document_intents` with the ticket's `org_id`, the read `library_id` and `base_version_id`, on a conflict key with no org (`:554-569`) — while the `CLOSED` hand-back path does scope its document read by org (`:401-402`). A member who points their ticket's metadata at another workspace's document makes the drafter assignment write an intent row in their org carrying that document's library and version ids, and, for a drafter in both orgs, can overwrite that org's own intent row. The integrator opens it as a new id at merge (proposed `SM-14`, MEDIUM, `99-fix-sequencing.md`, "New ids DF-P0 asks the integrator to open") → **DF-P1**: scope the read `.eq("org_id", ticket.orgId)` and skip the upsert when the document is not in the org; `metadata` service-only is already `SM-2`'s binding residual.

---

<a id="sm-12"></a>

## SM-12 · `assign` accepts any active org member as the drafter — no Drafter-role check — while the engineer pick on the same request is role-checked

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/workflow-action/route.ts:113-132`, `lib/ticketTransitions.ts:193-200`, `lib/workflow.ts:69-75`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The asymmetry is real and correctly described. But the finding's stated scenario — "an assigner picking from a list mis-clicks and assigns to an Accounting or Contractor seat" — is refuted by page.tsx:240-250, where AssignmentModal populates its list with `.from('org_members').select('uid, email, role').eq('org_id', activeOrgId).eq('role', 'Drafter').eq('status','active')`; only Drafters are offered, so the mis-click cannot produce a non-drafter. Exploitation requires a hand-crafted POST by someone who already holds `ticket.assign` authority, which makes this a defense-in-depth gap rather than a MEDIUM.

**Mechanism.** The route loops over `[body.engineer?.id, body.assignment?.id]` and validates both are active org members, then applies a role test only inside `if (ref === body.engineer?.id)`. `body.assignment.id` is written straight to `assigned_drafter_id`. Because `canActAsDrafter = isDrafterIdentity || allows('ticket.draft_work')` grants identity-based rights unconditionally, that person immediately gains `save_progress`, `submit_draft`, `close_rfi` and `submit_final` ("ISSUE FINAL IFC PACKAGE") on the ticket, regardless of role.

**Failure scenario.** An assigner picking from a list mis-clicks and assigns the drafting ticket to an Accounting or Contractor seat. The server accepts it. That person now holds the drafter's authority on a construction package: they can submit the draft that goes for approval and, after approval, click "ISSUE FINAL IFC PACKAGE". Nothing in the flow ever questions whether they are qualified to produce drawings, and the assignment notification tells them it's their job.

**Evidence.**

app/api/tickets/workflow-action/route.ts:113-131 —
```
for (const ref of [body.engineer?.id, body.assignment?.id].filter(Boolean) as string[]) {
  const { data: refMember } = await supabaseAdmin.from("org_members").select("uid, role, roles") ... ;
  if (!refMember) { return ... 400 }
  if (ref === body.engineer?.id) {
    const held: string[] = ...;
    if (!held.some((r) => r.includes("Engineer"))) {
      return NextResponse.json({ error: "The selected reviewer does not hold an Engineer role" }, { status: 400 });
    }
  }
}
```
lib/ticketTransitions.ts:193-199 —
```
case "assign":
  if (input.assignment) {
    updates.assigned_drafter_id = input.assignment.id;
    ...
    updates.status = "DRAFTING";
```

**Chain reaction.** `self_assign` has the same shape from the other side: it takes `actorUid` unconditionally and derives the drafter name from the email local part (`input.actor.email.split("@")[0]`), so the recorded `assigned_drafter_name` need not match the org member's display name that appears everywhere else.

**Done when.**

- [ ] The route validates that `body.assignment.id` holds a drafting role (Drafter / DraftingSupervisor, or an explicit `ticket.draft_work` grant) using the same headline-or-additive `roles` check applied to engineers
- [ ] `assigned_drafter_name` is read from `org_members.display_name` server-side rather than derived from an email string
- [ ] An API-route test asserts assigning a Viewer as drafter returns 400

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. The role check landed with roles-and-permissions [`WF-14`](../roles-and-permissions/06-request-workflow.md) done-when 3 (`087a39c`); the name half did not.
- `app/api/tickets/workflow-action/route.ts:228-237` — every referenced member must be active in the ticket's org; `:278-285` — the assignee must hold drafting authority under the org's policy, headline or additive, grants honoured: `const mayDraft = policyAllows(capPolicy, "ticket.draft_work", (held[0] ?? "Viewer") as Role, held as Role[], ref, resource);` → 400 `"The selected drafter does not hold drafting authority (ticket.draft_work)"`; `:287-289` — at 3+ members the requester cannot be assigned their own request.
- Test (new): `lib/__tests__/dfRoundG_P0.test.ts:361` — assigning a Viewer is a 400 with no tickets write and no audit row; a Drafter, and a Viewer holding Drafter additively, are accepted. Mutation-checked: forcing `mayDraft` true fails it.

**Done-when.**
- ✓ The route validates that the assignee holds drafting authority, with the same headline-or-additive collection the engineer pick uses (the token list is `ticket.draft_work` — `Drafter` by default, org-configurable).
- ✗ `assigned_drafter_name` is not read from `org_members.display_name`: `assign` and `reassign_drafter` store the client-supplied `input.assignment.name` (`lib/ticketTransitions.ts:249`, `:266`; the page sends `drafter.email.split('@')[0]`, `app/(protected)/requests/[id]/page.tsx:314`), and `self_assign` still derives it from the email local part — `updates.assigned_drafter_name = input.actor.email.split("@")[0];` (`lib/ticketTransitions.ts:257`).
- ✓ An API-route test asserts assigning a Viewer as drafter returns 400 (`lib/__tests__/dfRoundG_P0.test.ts:361`).

**Scope / residual.** Server-stamped `assigned_drafter_name` (and the self-assign name) from `org_members.display_name` → **DF-P1**, the first package on the workflow-action route's input rails. Not in the fleet plan's handed-on list — found on re-verification. `EDGE-11`'s denormalised-name invariant is kept: the name stays on the row; only its source changes.

**Resolution (2026-10-02, drafting-flow Round G).** DF-P1 RAILS — the name half. `app/api/tickets/workflow-action/route.ts:418-489` — the referenced-member read now selects `display_name, email`; for an assignment the drafter's name is `memberName(refMember)` (`:70-77`: the member's display name, else the local part of their membership email) and the transition input carries it instead of the client's string. A member row with neither field falls back to the local part of the account's sign-in email (`accountName`, `supabaseAdmin.auth.admin.getUserById`), else the neutral label "Unnamed member". It is never `body.assignment.name`. *(DF-P1 fix pass, 2026-10-02: the first version fell back to the client's string for such a row.)* `self_assign` names the caller from their own membership row (`:515-519`). The name stays denormalised on the row (`EDGE-11`'s invariant); only its source changed. Test: `lib/__tests__/dfRoundG_P1_rails.test.ts:905` — `assign` and `reassign_drafter` with a client name "Somebody Else" store the member's display name; a member with no display name stores the email's local part; `self_assign` stores the caller's display name (fails on the base code). Fix pass: `:1174`, "SM-12 — a member row with neither a display name nor an email never takes the client's string" (the account email's local part; an unreadable or email-less account gives "Unnamed member"; the client's "the CEO" appears nowhere in the write).

**Done-when.**
- ✓ The route validates drafting authority with the headline-or-additive collection (WF-14, re-verified; `dfRoundG_P0.test.ts:361`).
- ✓ `assigned_drafter_name` is read from `org_members.display_name` server-side (assign, reassign, self-assign), never the client's string.
- ✓ An API-route test asserts assigning a Viewer as drafter returns 400 (`dfRoundG_P0.test.ts:361`).

**Scope / residual.** None. The page still sends a name (`app/(protected)/requests/[id]/page.tsx:314`); the route ignores it in every case.

---

<a id="sm-13"></a>

## SM-13 · `requiresFile` is never enforced server-side, so "ISSUE FINAL IFC PACKAGE" completes with no Final attachment at all

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/workflow-action/route.ts:104-109`, `lib/workflow.ts:309-314`, `lib/ticketTransitions.ts:280-283`, `app/(protected)/requests/[id]/page.tsx:1028-1034`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the asymmetry inside workflow.ts strengthens it: `submit_draft` at :176-182 is only offered when `ticket.attachments?.some(a => a.type === 'Draft')`, so the server enforces its file requirement structurally, while `submit_final` at :309-314 carries `requiresFile: true` with no such state guard and no server check — the one compliance-critical issue step is the unguarded one.

**Mechanism.** `WorkflowAction` carries three UI guards: `requiresComment`, `requiresEngineerPick`, `requiresFile`. The route re-checks the first two and never the third — `grep -rin 'requiresfile'` across the repo returns exactly four hits: the interface declaration, the two `requiresFile: true` uses in lib/workflow.ts, and one client check. `submit_final` at PENDING_IFC is declared `requiresFile: true`, and computeTransition only appends a final attachment `if (input.finalAttachment)`, so a request with `finalAttachment: null` moves the ticket to FINAL_DRAFT with nothing issued. The client-side guard is itself weak: it tests `ticket.attachments.length > 0`, satisfied by any Reference or Source file uploaded when the request was created — it never checks for a `type === 'Final'` attachment.

**Failure scenario.** A drafter (or anything replaying the endpoint) POSTs `{actionType:"submit_final", finalAttachment:null}`. The ticket lands in FINAL_DRAFT — "The issued package awaiting the requester's acknowledgement" per the workflow diagram — with no Final file. The requester clicks "Acknowledge & Close". The ticket is CLOSED, recorded as an issued IFC package, `closed_at` is stamped, and it becomes archive-eligible. The construction package that the record says was issued does not exist. Even without tampering: the client uploads the IFC to R2 and then calls the route; if that call 409s on the CAS and the user retries via a stale tab, the same weak client guard passes on a request carrying no attachment.

**Evidence.**

app/api/tickets/workflow-action/route.ts:104-109 — the complete server-side guard set —
```
if (action.requiresComment && !body.comment?.trim()) {
  return NextResponse.json({ error: "This action requires a comment" }, { status: 400 });
}
if (action.requiresEngineerPick && !body.engineer?.id) {
  return NextResponse.json({ error: "This action requires picking an engineer" }, { status: 400 });
}
```
lib/ticketTransitions.ts:280-283 —
```
case "submit_final":
  updates.status = "FINAL_DRAFT";
  if (input.finalAttachment) currentAttachments = [...currentAttachments, input.finalAttachment];
  break;
```
app/(protected)/requests/[id]/page.tsx:1029-1033 (the only check, and it accepts any attachment type) —
```
if (action.requiresFile) {
  const hasFiles = ticket.attachments && ticket.attachments.length > 0;
  if (!hasFiles) { await appAlert({ message: "Compliance Check Failed: You must upload at least one file before proceeding.", tone: "danger" }); return; }
}
```

**Chain reaction.** The route comment at lines 17-26 claims the state machine is "now enforced where the client can't lie" — a reader auditing this system will believe file custody is enforced. Downstream, /api/verify-ticket reports on `deliverable_rev` alone and will happily call a printed rev "current" for a ticket that never carried a Final file; the ticket-shed archiver bundles the ticket with zero attachment bytes and reports success.

> **Verifier correction.** The missing server-side requiresFile check is real, but the UI path cannot trigger it: handleIFCUpload (requests/[id]/page.tsx:1073-1088) only calls executeWorkflowAction after a successful upload, always with a type:'Final' attachment. Exploitation requires a crafted request from an already-authorized drafter. submit_draft, the other requiresFile action, is separately gated by the `attachments.some(a => a.type === 'Draft')` condition at workflow.ts:176.

**Done when.**

- [ ] The route enforces `action.requiresFile`, and enforces it against the right thing: `submit_final` requires a `finalAttachment` of type 'Final' in the request (or an existing Final attachment on the row), `submit_draft` requires a Draft attachment
- [ ] The client-side check tests for the specific attachment TYPE the action needs, not `attachments.length > 0`
- [ ] An API-route test posts `submit_final` with `finalAttachment: null` and asserts 400, with the ticket still at PENDING_IFC

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. The server half landed with roles-and-permissions [`WF-6`](../roles-and-permissions/06-request-workflow.md) (`087a39c`) and now has the route test this finding asks for; the type-specific checks did not land.
- `app/api/tickets/workflow-action/route.ts:203-205` — `if (action.requiresFile && action.action === "submit_final" && !body.finalAttachment?.url) { return … { error: "Issuing the final IFC package requires the deliverable file" }, { status: 400 } … }`, before `computeTransition`. `submit_draft` stays gated by state: `if (ticket.attachments?.some(a => a.type === 'Draft')) {` (`lib/workflow.ts:348`).
- Test (new): `lib/__tests__/dfRoundG_P0.test.ts:381` — `submit_final` with no `finalAttachment`, with `null`, and with a URL-less record: each 400, with no write of any kind reaching the `tickets` table (the no-write assertion is the pin; a status read-back would be vacuous in this harness) and no audit row; with the Final file → 200 `FINAL_DRAFT`. Mutation-checked.

**Done-when.**
- ✗ (in part) The route enforces the file precondition for `submit_final` but tests a URL's presence, not `type === 'Final'` — a `finalAttachment` typed `Reference` passes; `submit_draft`'s Draft requirement holds structurally (✓).
- ✗ The client check still tests any attachment: `const hasFiles = ticket.attachments && ticket.attachments.length > 0;` (`app/(protected)/requests/[id]/page.tsx:1245-1247`). (The real `submit_final` path goes through the IFC upload modal, which always builds `type: 'Final'` — `:1290-1295` — so the weak check matters for a crafted call and for `submit_draft`.)
- ✓ An API-route test posts `submit_final` with `finalAttachment: null` and asserts 400 with the ticket still at `PENDING_IFC` (`lib/__tests__/dfRoundG_P0.test.ts:381`).

**Scope / residual.** The route's `Final`-type check → **DF-P1** (the same hunk as `AUTHZ-11`'s attachment-shape and storage-key validation). The type-specific client check at `app/(protected)/requests/[id]/page.tsx:1245` → **DF-P9** (owns the page outside the viewer region). Not in the handed-on list — found on re-verification. `LEAK-8` (whose contract is WF-6's) closes on the server half.

**Partial (2026-10-02, drafting-flow Round G).** DF-P1 RAILS — the server half is closed; the client half is DF-P9's, so this stays OPEN. `app/api/tickets/workflow-action/route.ts:127-194`, `:395-416` — every file record the route appends is vetted (`AUTHZ-11`'s hunk): for `submit_final` the `finalAttachment` must be typed `Final` ("Issuing the final IFC package requires a file typed Final", 400), lie under this ticket's own storage prefix, and be in storage; a `redlineAttachment` must be a `Reference`. Test: `lib/__tests__/dfRoundG_P1_rails.test.ts:583` — a `finalAttachment` typed `Reference`, `Draft` or `Source` is a 400 with no write of any kind to `tickets` and no audit row (fails on the base code); `dfRoundG_P0.test.ts:381` (no / null / URL-less file) still holds.

**Done-when.**
- ✓ The route enforces `requiresFile` against the right thing: `submit_final` requires a `finalAttachment` typed `Final` (and stored under the ticket); `submit_draft`'s Draft requirement holds structurally (`lib/workflow.ts:348`).
- ✗ The client check still tests any attachment: `const hasFiles = ticket.attachments && ticket.attachments.length > 0;` (`app/(protected)/requests/[id]/page.tsx:1245-1247`, unchanged — the page is not DF-P1's).
- ✓ An API-route test posts `submit_final` with `finalAttachment: null` and asserts 400 with the ticket still at `PENDING_IFC` (`dfRoundG_P0.test.ts:381`), and now one typed wrongly (`dfRoundG_P1_rails.test.ts:583`).

**Scope / residual.** The type-specific client check → **DF-P9** (fleet plan: DF-P9 TICKET-PAGE lists `SM-13`).

**Resolution (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE — the client half. `lib/ticketPage.ts` `requiredFileType` / `missingRequiredFile` (:120, :130): **Submit Draft** needs a `Draft` on the ticket (a Reference or Source no longer satisfies it); **Issue Final** needs the file the IFC upload supplies, typed `Final` — checked when the action is chosen (`app/(protected)/requests/[id]/page.tsx`:1471) and again before it is sent (`app/(protected)/requests/[id]/page.tsx`:1558), so the client refuses exactly what the route refuses (DF-P1's server half, unchanged).

**Done-when.**
- ✓ The route enforces `requiresFile` against the right type (DF-P1).
- ✓ The client check tests the specific attachment TYPE — `lib/__tests__/dfRoundG_P9_ticketPage.test.ts` "SM-13 — the file an action needs, by TYPE".
- ✓ The API-route test for `submit_final` with no Final (DF-P0 / DF-P1, unchanged).

**Scope / residual.** None.

---

## SM-14 · The ticket ⇄ intent bridge reads the source document with no org filter, keyed on client-writable metadata

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P1 RAILS (the bridge's read scoped to the ticket's org; `metadata` service-only is `SM-2`'s binding residual, also DF-P1's) — by the integrator, 2026-10-02 (opened at the DF-P0 merge from DF-P0's proposal in `99-fix-sequencing.md`, "New ids DF-P0 asks the integrator to open at merge"; fleet plan `audit-reports/fleet-plans/drafting-flow.json`).
- **Verification:** CONFIRMED (by reading; not exercised against a live database)
- **Blast radius:** cross-workspace integrity
- **Locations:**
  - `app/api/tickets/workflow-action/route.ts:513-514` — `srcDoc` taken from `ticket.metadata.source_document` (client-writable, `SM-2`)
  - `app/api/tickets/workflow-action/route.ts:549-553` — `supabaseAdmin.from("documents")…eq("id", srcDoc.id)` with no org filter
  - `app/api/tickets/workflow-action/route.ts:554-569` — `document_intents` upsert with the ticket's `org_id`, the read `library_id` and `base_version_id`, `onConflict: "document_id,user_id,kind,source"` (no org in the key)
  - `app/api/tickets/workflow-action/route.ts:401-402` — the `CLOSED` hand-back path does filter by org
- **Related:** `SM-11` (where it was found), `SM-2`
- **Independently verified:** — (`author`: opened by the integrator on 2026-10-02 at the drafting-flow DF-P0 merge, from DF-P0's proposal; the integrator re-read the cited lines on HEAD; not yet challenged)

**Mechanism.** On drafter assignment the route registers a document intent for the ticket's source document. It reads that document with the service role by id alone, and the id comes from ticket metadata a member can write. The upsert then writes an intent row in the member's org that carries the foreign document's library and current version.

**Failure scenario.** A member PATCHes their ticket's `metadata.source_document.id` to a document id from another workspace. Assigning a drafter makes the service role write an intent row in the member's org carrying the foreign document's `library_id` and `current_version_id`. For a drafter who belongs to both workspaces, the upsert can also overwrite that workspace's own ticket-sourced intent row on the document.

**Remediation.** Scope the read with `.eq("org_id", ticket.orgId)`, as the `CLOSED` path does, and skip the upsert when the document is not in the ticket's org.

**Done when.**
- The bridge's document read is scoped to the ticket's org and the upsert is skipped when the document is not in that org.
- A route test: a foreign document id in `metadata` registers no intent.
- `metadata` becomes service-only (`SM-2`'s binding residual, DF-P1), which removes the forged input.

**Resolution (2026-10-02, drafting-flow Round G).** DF-P1 RAILS. `app/api/tickets/workflow-action/route.ts:930-967` — entering `DRAFTING` / `REVISION_REQ` (or a reassignment at `PENDING_IFC`) reads the source document with `.eq("id", srcDoc.id).eq("org_id", ticket.orgId)`, as the `CLOSED` path does, and upserts the drafter's intent only when that read returns a row; a document id from another workspace registers nothing. **Pending migration:** `supabase/migrations/20261166_df_roundG_ticket_rails.sql` (`DEC-30`: one paste, not a widening, after `20261038` / `20261039`, and after the DF-P1 app deploy, never before it: `AUTHZ-13`, "Paste order") — the database half is not closed in any database until it is pasted. It makes `tickets.metadata` service-only (`20261166:280`), so the source-document id can no longer be written from a browser at all. Test: `lib/__tests__/dfRoundG_P1_rails.test.ts:926` — a foreign document id in `metadata` registers no intent; one in the ticket's org does, with its library and current version (fails on the base code). Scratch run: a member's `metadata` write is refused (C11).

**Done-when.**
- ✓ The bridge's document read is scoped to the ticket's org and the upsert is skipped when the document is not in that org.
- ✓ A route test: a foreign document id in `metadata` registers no intent.
- ✓ `metadata` becomes service-only — after the paste (pending migration above).

**Scope / residual.** None. Intents registered from a foreign id before this deploy decay on their own TTL.

---

<a id="sm-15"></a>

## SM-15 · A ticket file's `id` is the client's when it sends one, so a participant can make the printed file's identity ambiguous and grey out every scan of the current deliverable

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P15 DELIVERABLE PAGE WIRING (allocated by the integrator at the DF-P12 merge) — the workflow route mints a ticket file's id on the server (`crypto.randomUUID()`) for any new attachment, and never keeps a client id already on the ticket. Ruled by the integrator at the DF-P12 merge, 2026-10-20 (DEC-90); opened by drafting-flow Round G DF-P12's review fix pass, 2026-10-14 (DEC-31).
- **Verification:** CONFIRMED by reading on DF-P12's branch (not exercised against a live database).
- **Locations:** `app/api/tickets/workflow-action/route.ts:208` (`vetTicketAttachment`: `id: typeof a.id === "string" && a.id ? a.id : crypto.randomUUID()`), `lib/verifyTicketVerdict.ts:324` (`printedFileConfirmed`: `named.length !== 1` → not confirmed), `app/api/tickets/copy/route.ts:184` (`named.length !== 1` → 404)
- **Related:** `SM-5` done-when 3 (the identity on the QR, DF-P12), `LEAK-7` (b), drafting-flow `EVID-16`
- **Independently verified:** — opened 2026-10-14 by DF-P12's review fix pass from the package reviewer's finding; not yet challenged by a second party.

**Mechanism.** Since DF-P12 a print's QR carries the file's id (`?a=`), and the verify verdict confirms a print only when exactly one attachment on the ticket carries that id at the printed revision; the server copy route issues a file only when exactly one attachment carries the id it is asked for. The workflow route vets every file a client attaches (key under the ticket's prefix, present in storage, type) and stamps its revision server-side, but keeps the `id` the client sent with it and mints one only when none is sent.

**Failure scenario.** A participant who may `attach_file` posts an attachment whose `id` equals the current Final's id (with a different key under the ticket's prefix). Every `?a=` print of the real current deliverable now scans "cannot confirm" (the id is named twice), and `POST /api/tickets/copy` for that file answers 404 "That file is not on this request". The failure is fail-safe — grey, never green, and the copy is refused rather than mis-issued — but any participant can trigger it against the field verdict and the server copy path.

**Done when.**
- [ ] `vetTicketAttachment` mints the id on the server (`crypto.randomUUID()`) for every file that is not already listed on the ticket by its key, or refuses an id that is already on the ticket or outside `TICKET_ATTACHMENT_ID_RE` (`lib/verifyTicketVerdict.ts`)
- [ ] A route test: an attachment posted with the id of a file already on the ticket does not produce a second attachment carrying that id
- [ ] `SM-5`'s Resolution and `DEC-110` rationale 4 then say the identity is unique on a ticket

**Resolution (2026-10-20, drafting-flow Round G).** DF-P15 DELIVERABLE PAGE WIRING, as ruled (`DEC-90` ruling (4)). Reproduced on `0041bd8`: `vetTicketAttachment` kept the client's `id` (`id: typeof a.id === "string" && a.id ? a.id : crypto.randomUUID()`, `app/api/tickets/workflow-action/route.ts:216` on the base) — an `attach_file` carrying the current Final's id appended a second attachment with that id.
- `app/api/tickets/workflow-action/route.ts` `vetTicketAttachment` (:224) mints the id of every entry the route appends (`attach_file`'s `attachment`, `submit_final`'s `finalAttachment`, a `redlineAttachment`) with `crypto.randomUUID()`, always — never the client's, whether or not it is already on the ticket. Every attachment already on the ticket is untouched (its id included): the route only appends. The audit row names the file by the id it was stored under. No caller depended on its own id: the page mints one per upload and never reads it back (`app/(protected)/requests/[id]/page.tsx` `handleFileUpload`, `handleIFCUpload`, the redline), and no other caller posts files to this route.
- Tests: `lib/__tests__/dfRoundG_P15_routes.test.ts` "SM-15 — …" (an attachment posted with the current Final's id: the Final keeps its id, the new entry gets a server UUID, exactly one attachment carries "f-1", the audit row names the new id — fails on the base; a client id new to the ticket is not kept either, and a file with no id gets one as before; REGRESSION: the vetting is unchanged). Four existing pins that asserted the client's id was kept were updated to the server-minted one (`dfRoundG_P0.test.ts` LEAK-8 / SM-13, `dfRoundG_P1_rails.test.ts` AUTHZ-11 ×2, `sweepRoundE_A.test.ts` WF-9 — now found by key).

**Done-when.**
- ✓ `vetTicketAttachment` mints the id on the server for every file it appends (stronger than "not already listed by its key": a re-sent listed key is a new entry and gets a new id too, so no appended entry can share an id).
- ✓ A route test: an attachment posted with the id of a file already on the ticket does not produce a second attachment carrying that id.
- ✓ `SM-5`'s record and `DEC-110` rationale 4 now say the identity is unique on a ticket for every file appended since DF-P15 (cross-note on `SM-5` below its ruling; `DEC-110` Landed line).

**Scope / residual.** An id a hostile client already duplicated BEFORE this deploy stays duplicated (no data repair: rewriting a file's id would break the `?a=` of every print already made of it); such a file scans "cannot confirm" and the page keeps its browser copy path, said (`EVID-16`'s `unaddressable`) — fail-safe, never green, never mis-issued. No owner needed.

---

<a id="sm-16"></a>
## SM-16 · A reopen clears a request's outcome but keeps the reason recorded with it, so the old reason rides along to however the request ends next

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P15 DELIVERABLE PAGE WIRING — by the integrator at the DF-P16 merge, 2026-10-20 (it holds the workflow route next). *Was:* proposed — drafting-flow, the next package that holds `app/api/tickets/workflow-action/route.ts` and `lib/ticketTransitions.ts` (the integrator assigns, `DEC-31`: a remainder is a new id with an owner). Opened by drafting-flow Round G DF-P16's review fix pass, 2026-10-20, from the package reviewer's finding; both files are other packages' in this round, so it is recorded here, not fixed.
- **Verification:** CONFIRMED by reading (not exercised against a live database).
- **Independently verified:** — opened 2026-10-20 by DF-P16's review fix pass from the package reviewer's finding; not yet challenged by a second party.
- **Blast radius:** reporting integrity (the per-reason counts on `/admin/analytics`, the reason shown in the queue's Closed history and in `metadata`)
- **Locations:**
  - `lib/ticketTransitions.ts:532-543` — `reopen_ticket`: `updates.outcome = null` ("A reopened request has not ended"), `metadata` untouched
  - `app/api/tickets/workflow-action/route.ts:975-979` — an accepted reason is merged into `metadata.outcome_reason` only when the action records an outcome; nothing removes it
  - `lib/ticketOutcome.ts:56-63` — `outcomesFor('close_ticket')` is `TICKET_OUTCOMES`, so a direct caller may close with `withdrawn` (and a configured reason) and then reopen
- **Related:** drafting-flow `LEAK-9` / `GAP-107`, roles-and-permissions `GAP-13` (acceptance 2's breakdown — guarded, see below), `DEC-103` item 3

**Mechanism.** The reason a request ended for is stored beside the outcome, in `metadata.outcome_reason` {id, label, category}. A reopen starts a new cycle and nulls `tickets.outcome`, but leaves `metadata.outcome_reason` in place. When the request ends again with an outcome that takes no reason (an acknowledged close records `completed`), the row carries the new outcome and the old reason.

**Failure scenario.** An API caller sends `close_ticket` with outcome `withdrawn` and a configured reason ("Requester left the site"); then `reopen_ticket`; the request is acknowledged and closed as `completed`. The row reads outcome `completed`, `metadata.outcome_reason` "Requester left the site" (category `withdrawn`). Anything that reads the reason without checking its category credits a completed request with a withdrawal reason. The UI cannot reach the path today (a cancel ends CANCELED, which cannot be reopened, and the close actions offer no outcome picker). **Guarded at DF-P16's review fix pass:** `components/requests/RequestOutcomes.tsx` `reasonForOutcome` counts a reason only under the outcome it was recorded with, and the analytics breakdown and the queue's Closed history row both use it — so the stale value is no longer credited to a different outcome, but it is still stored, and any future reader sees it. One case remains visible: a reopened request re-ended with no outcome recorded (a force close naming none) is "Not recorded", where the breakdown keeps a stored reason by design (the pre-`20261195` world) — the old reason is listed there as "recorded as Withdrawn".

**Remediation.** On `reopen_ticket`, clear `metadata.outcome_reason` on the same compare-and-set write (keep the old reason in the reopen's history line if it is wanted for the record).

**Done when.**
- [ ] `reopen_ticket` removes `metadata.outcome_reason` on the same write that nulls `tickets.outcome`, with a route test (close with a reason → reopen → the row carries no `outcome_reason`)
- [ ] Existing rows: a counts-only inventory of ended or open requests whose `metadata.outcome_reason.category` differs from `tickets.outcome` (no rewrite needed to stop a wrong credit — every reader in the app credits a reason only to the outcome it was recorded with; see the residual below)

**Resolution (2026-10-20, drafting-flow Round G).** DF-P15 DELIVERABLE PAGE WIRING, as ruled (`DEC-90` ruling (5)). Reproduced on `0041bd8`: `reopen_ticket` nulled `tickets.outcome` (`lib/ticketTransitions.ts:532-543`) and the route wrote no `metadata`, so `metadata.outcome_reason` survived the reopen.
- `app/api/tickets/workflow-action/route.ts` (:736–754): on `reopen_ticket`, when the row's `metadata` carries `outcome_reason`, the route removes it from `metadata` and writes the result on the SAME compare-and-set update that nulls `tickets.outcome` (one write); the reopen's history line keeps the old reason ("[The reason it had ended, cleared by the reopen: Withdrawn — Requester left the site]"). A reopen of a request with no recorded reason writes no `metadata` at all, as before. `lib/ticketTransitions.ts` is not edited (the route already merges the reason on the ending write; the clearing sits beside it).
- Tests: `lib/__tests__/dfRoundG_P15_routes.test.ts` "SM-16 — …" (close with a reason → reopen → the row carries no `outcome_reason`, the rest of `metadata` stays, the history line keeps the reason, one write — fails on the base; REGRESSION: no reason → no `metadata` key on the update).
- **Existing rows — counts-only inventory** (read-only; no row content; needs `tickets.outcome`, `20261195` — before that paste it refuses with 42703 and there is nothing to compare against):

```sql
SELECT check_name AS "check", NULL::boolean AS ok, n::text AS n FROM (
  SELECT 1 AS ord, 'ended (CLOSED / CANCELED) with a reason whose category is not the outcome' AS check_name, count(*) AS n
    FROM tickets
   WHERE status IN ('CLOSED', 'CANCELED')
     AND jsonb_typeof(metadata -> 'outcome_reason') = 'object'
     AND (metadata -> 'outcome_reason' ->> 'category') IS DISTINCT FROM outcome
  UNION ALL
  SELECT 2, 'open (reopened) and still carrying a reason', count(*)
    FROM tickets
   WHERE status NOT IN ('CLOSED', 'CANCELED')
     AND jsonb_typeof(metadata -> 'outcome_reason') = 'object'
  UNION ALL
  SELECT 3, 'ended with a reason that matches the outcome (fine)', count(*)
    FROM tickets
   WHERE status IN ('CLOSED', 'CANCELED')
     AND jsonb_typeof(metadata -> 'outcome_reason') = 'object'
     AND (metadata -> 'outcome_reason' ->> 'category') = outcome
) q ORDER BY ord;
```

Exercised on a throwaway PostgreSQL 16.13 (deleted afterwards) against eight synthetic rows — a stale reason under `completed`, a reason under a NULL outcome (a force close naming none), a matching `duplicate`, a reopened row still carrying a reason, an empty `{}`, a NULL `metadata`, a non-object `outcome_reason`, a row with no reason: answered 2 / 1 / 1 as constructed; on a table without `outcome` it refused with 42703 (`column "outcome" does not exist`). Rows (1) and (2) need no rewrite to stop a wrong credit — every reader credits a reason only to the outcome it was recorded with (`components/requests/RequestOutcomes.tsx` `reasonForOutcome`, DF-P16) — and a row in (2) (reopened before DF-P15) keeps its stale reason until it ends again: an ending that names a reason overwrites it; one that names none leaves it, uncredited. For the integrator: run it at any time for the count; no paste follows from it.

**Done-when.**
- ✓ `reopen_ticket` removes `metadata.outcome_reason` on the same write that nulls `tickets.outcome`, with a route test (close with a reason → reopen → the row carries no `outcome_reason`).
- ✓ Existing rows: the counts-only inventory above (ended rows whose reason's category differs from the outcome, and open rows still carrying a reason), exercised on PostgreSQL 16.

**Scope / residual.** A row already in inventory (1) or (2) keeps its stored reason (the readers never credit it to another outcome); a cleanup rewrite is not needed for correctness and is not built. No owner needed.

---

> Line citations into `lib/notifications.ts` re-pointed 2026-09-02 after the roles-and-permissions sweep removed the browser external-mail path (`SURF-17`); the cited symbols are unchanged.
