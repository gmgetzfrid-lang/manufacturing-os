# 06 · State machine & transition integrity

**13 findings** — 2 CRITICAL · 3 HIGH · 8 MEDIUM.

Whether the flow's own rules can be enforced at all: reachable transitions, concurrency, partial failure, and the actions that skip the gates.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded here. Severities marked by that pass override the original.


---


<a id="sm-1"></a>

## SM-1 · "Approve with Minor Correction" is a complete bypass of the engineer sign-off gate — the very requester the gate blocks can issue for construction with it

- **Severity:** CRITICAL
- **Status:** OPEN
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

---

<a id="sm-2"></a>

## SM-2 · RLS on `tickets` is a blanket FOR ALL grant — any active org member can rewrite `status` directly and skip the state machine, the capability policy, the CAS and the audit log entirely

- **Severity:** CRITICAL
- **Status:** OPEN
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

---

<a id="sm-3"></a>

## SM-3 · A Manager or Supervisor with no engineering role can perform the engineer sign-off and have `engineer_approved_at` stamped in their name

- **Severity:** HIGH
- **Status:** OPEN
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

---

<a id="sm-4"></a>

## SM-4 · Archive commit never re-checks status: a closed ticket that is reopened after "produce" has its entire comment thread, history and attachment binaries destroyed while it is live and in review

- **Severity:** HIGH
- **Status:** OPEN
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

---

<a id="sm-5"></a>

## SM-5 · Reopen re-issues the SAME deliverable revision number, so two different documents both verify as "current" Rev N via the public QR endpoint

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="sm-6"></a>

## SM-6 · "Reject / Return to Requester" and "Return with Questions" both dump the ticket into REVISION_REQ, where a ticket with no assigned drafter has zero legal actions and appears on nobody's attention list

- **Severity:** LOW
- **Status:** OPEN
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

---

<a id="sm-7"></a>

## SM-7 · A transition performs four sequential writes with no transaction and no error check on the audit insert — the audit row can be lost while the status change stands

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/workflow-action/route.ts:155-223`, `app/api/tickets/workflow-action/route.ts:197-211`, `app/api/tickets/workflow-action/route.ts:214-223`, `app/api/tickets/workflow-action/route.ts:279-294`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanical claim is exactly right — four unsynchronised writes, and the audit insert's error is discarded. Severity is too high: the ticket's own `history` JSONB records who acted, with what label, in what role, and when, atomically with the status change, so what a lost audit row costs is the from→to mirror in audit_logs, not the compliance record itself.

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

---

<a id="sm-8"></a>

## SM-8 · CANCELED is documented to users as a workflow state, is treated as terminal by the archiver, and is reachable by no code path — while a ticket that somehow reaches it has no legal action for anyone but an admin

- **Severity:** LOW
- **Status:** OPEN
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

---

<a id="sm-9"></a>

## SM-9 · Four writers to the ticket row bypass the compare-and-set entirely and clobber whole JSONB arrays — including the split-brain the comment API was specifically hardened against

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:978`, `app/(protected)/requests/[id]/page.tsx:1010-1014`, `app/(protected)/requests/[id]/page.tsx:1328`, `app/(protected)/requests/[id]/page.tsx:920`, `app/api/intake/upload/route.ts:182-190`, `app/api/tickets/comment/route.ts:205-216`, `app/api/tickets/workflow-action/route.ts:155-191`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Accurate; if anything undercounted (five writers, not four — the intake route is a fifth). The whole-array clobber is real for comments, attachments+history and watchers, and the guard the finding says they bypass demonstrably exists on the two hardened paths.

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

---

<a id="sm-10"></a>

## SM-10 · The ticket page rewrites `approve_initial` into `assign` before sending, which the server refuses — every ticket at NEW or PENDING_ENG_INITIAL is a hard dead end for its only forward action

- **Severity:** LOW
- **Status:** OPEN
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

---

<a id="sm-11"></a>

## SM-11 · The ticket⇄document intent bridge is dead code: `rowToTicket` never maps `metadata`, so `ticket.metadata` is always undefined in the workflow route

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="sm-12"></a>

## SM-12 · `assign` accepts any active org member as the drafter — no Drafter-role check — while the engineer pick on the same request is role-checked

- **Severity:** LOW
- **Status:** OPEN
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

---

<a id="sm-13"></a>

## SM-13 · `requiresFile` is never enforced server-side, so "ISSUE FINAL IFC PACKAGE" completes with no Final attachment at all

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

> Line citations into `lib/notifications.ts` re-pointed 2026-09-02 after the roles-and-permissions sweep removed the browser external-mail path (`SURF-17`); the cited symbols are unchanged.
