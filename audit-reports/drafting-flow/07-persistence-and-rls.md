# 07 · Persistence, schema & row-level security

**8 findings** — 1 CRITICAL · 2 HIGH · 5 MEDIUM.

What the database actually permits, and which writes fail without telling anyone.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded here. Severities marked by that pass override the original.


---


<a id="pers-1"></a>

## PERS-1 · tickets has ONE permissive FOR ALL policy with only USING — every active org member can rewrite any ticket column, including status and approval stamps, straight through PostgREST

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1079-1081`, `supabase/schema.sql:1020`, `app/api/tickets/workflow-action/route.ts:91-103`, `app/(protected)/requests/page.tsx:639`
- **Same root cause as** `SM-2`, `AUTHZ-2`, `EVID-1` — One `CREATE POLICY ... FOR ALL USING (...)` with no `WITH CHECK` (`supabase/schema.sql:1079-1081`). Four lenses found it independently. **One migration closes all four.** Fix once; close the rest citing this one.

**Mechanism.** `tickets` has row level security enabled (schema.sql:1020) and exactly one policy, defined once in the whole repo (grep for `tickets_org_access` returns a single hit at schema.sql:1080; grep for `CREATE TABLE ... tickets` returns a single hit at schema.sql:397; `grep -rni 'restrictive' supabase/` returns 40 hits, none on `tickets`; `grep -rni revoke supabase/` shows REVOKEs on archive_settings, archives, ai_connections, platform_settings and others but none on `tickets`). That single policy is PERMISSIVE, `FOR ALL`, and carries only a USING clause. Postgres reuses USING as the WITH CHECK for the INSERT/UPDATE halves, so the only thing constrained on ANY verb is `org_id ∈ my_org_ids()`. Nothing constrains status, requester_id, assigned_drafter_id, assigned_engineer_id, engineer_approved_at, deliverable_rev, draft_iteration, archived_at, closed_at, attachments, history, or comments; nothing constrains the caller's role; and there is no RESTRICTIVE DELETE overlay of the kind `documents` received (supabase/migrations/20260814_documents_delete_controllers.sql:42-45 adds `AS RESTRICTIVE FOR DELETE USING (is_org_controller(org_id))`). All workflow authority lives in the server route: app/api/tickets/workflow-action/route.ts:95-103 loads the capability policy and refuses any action `WorkflowEngine.getActions` does not offer. That route is optional — the browser holds an anon-key session against the same table, and the app itself already writes to `tickets` directly from the client (app/(protected)/requests/page.tsx:639, app/(protected)/requests/[id]/page.tsx:978/1010/1328), proving the direct write path is open and unrevoked.

**Failure scenario.** A Viewer- or Requester-role member of the workspace opens devtools on any page of the app and issues `supabase.from('tickets').update({ status: 'CLOSED', deliverable_rev: '2', engineer_approved_at: new Date().toISOString(), assigned_engineer_name: 'J. Doe, PE' }).eq('id', <ticketId>)`. RLS accepts it: the row is in their org. The ticket now reads as engineer-approved and issued at Rev 2. No row lands in `audit_logs` (the server route at line 214 is the only writer of TICKET_* audit rows), so the PSM audit trail shows the ticket's last legitimate transition and nothing after. /api/verify-ticket (app/api/verify-ticket/route.ts:62-89) reads `deliverable_rev` from this same unconstrained column, so a field contractor scanning the QR on the printout gets verdict `current` for a package no engineer ever signed. The same member can also `DELETE` the ticket outright.

**Evidence.**

```
supabase/schema.sql:1079-1081 —
-- Tickets
CREATE POLICY "tickets_org_access" ON tickets FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

contrast, supabase/migrations/20260814_documents_delete_controllers.sql:42-45 —
CREATE POLICY documents_delete_controllers ON documents
  AS RESTRICTIVE FOR DELETE
  USING (is_org_controller(org_id));
```

**Chain reaction.** Because the column is unconstrained, every downstream consumer that trusts it is compromised at once: /api/verify-ticket's public QR verdict, lib/ticketShed.ts's `closed_at`/status archive-eligibility clock (a forged CLOSED + backdated closed_at makes a live ticket eligible for content shedding), the coordination and inbox queues that filter on (org_id, status), and lib/impact.ts:117 which joins documents to tickets through `metadata->source_document->>id`.

**Done when.**

- [ ] A RESTRICTIVE UPDATE policy on `tickets` pins status/approval/assignment/deliverable_rev columns so only the service role can change them (e.g. a trigger or a policy that requires the row's status and engineer_approved_at to be unchanged for non-service-role writers), and the client stops writing those columns directly
- [ ] A RESTRICTIVE DELETE policy on `tickets` mirroring documents_delete_controllers (Admin/DocCtrl only)
- [ ] The FOR ALL policy is split into explicit SELECT / INSERT / UPDATE / DELETE policies with an explicit WITH CHECK on the write halves, so the INSERT contract is written down rather than inherited from USING
- [ ] An INSERT constraint (policy or trigger) requiring requester_id = auth.uid() and status ∈ the set the intake flow is allowed to open with

---

<a id="pers-2"></a>

## PERS-2 · Client-side whole-array read-modify-write of tickets.comments, .history, .attachments and .watchers with no compare-and-set — the exact split-brain the server routes were built to prevent

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:967-978`, `app/(protected)/requests/[id]/page.tsx:1005-1014`, `app/(protected)/requests/[id]/page.tsx:1322-1328`, `app/api/tickets/comment/route.ts:202-216`, `supabase/migrations/20260726_ticket_comments.sql:1-18`

**Mechanism.** `handleUpdateCategory` reads `ticket.comments` from React state, maps a new array, and writes the whole array back (line 978) with only `.eq('id', ticketId)` — no `.eq('last_modified', ...)` guard, and no mirror into the `ticket_comments` table. `handleFileUpload` does the same for `attachments` and `history` (lines 1005-1014). `toggleWatch` does the same for `watchers` (lines 1322-1328). Every server path that touches these arrays guards against precisely this: the comment PATCH route CASes on last_modified with the comment 'a concurrent workflow action rewriting the comments array must not be clobbered by this whole-array write (the exact split-brain post_ticket_comment was built to prevent)' (comment/route.ts:202-216); the workflow route CASes on status AND last_modified (workflow-action/route.ts:150-162); and migration 20260726 exists specifically because 'comments live only as a JSONB array on the tickets row, written read-modify-write from the client. Two people commenting at the same moment last-write-wins the whole array — a lost comment.' These three client handlers were never migrated to that discipline.

**Failure scenario.** A supervisor is classifying the root cause of a revision comment (Revision → 'Client Scope Change') at the moment the assigned engineer clicks Request Revision. The server route posts the engineer's revision comment atomically via post_ticket_comment (`comments || jsonb_build_array($1)`, schema.sql:553-556) and moves the ticket to REVISION_REQ. Half a second later the supervisor's write lands, replacing the whole `comments` array with the version their tab loaded before the engineer's comment existed. The engineer's revision instruction — the text telling the drafter what is wrong with the construction drawing — disappears from the ticket thread. It survives only in the `ticket_comments` shadow table, which no UI reads (grep for `ticket_comments` in app/components returns only the shed/restore admin routes and the server writers). The drafter re-issues without the correction.

**Evidence.**

```
app/(protected)/requests/[id]/page.tsx:976-978 —
    try {
      await supabase.from('tickets').update({ comments: updatedComments }).eq('id', ticketId);

app/api/tickets/comment/route.ts:202-211 —
  // CAS on the ticket's last_modified as read: a concurrent workflow action
  // rewriting the comments array must not be clobbered by this whole-array
  // write (the exact split-brain post_ticket_comment was built to prevent).
  let casQuery = supabaseAdmin
    .from("tickets")
    .update({ comments: next, last_modified: editedAt })
    .eq("id", body.ticketId!);
  casQuery = auth.readLastModified
    ? casQuery.eq("last_modified", auth.readLastModified)
    : casQuery.is("last_modified", null);
```

**Chain reaction.** The category field these writes clobber is the one `buildTombstone` harvests into `metadata.archive_summary.revisionCategories` at shed time (app/api/admin/ticket-shed/commit/route.ts:48-55), so a lost or clobbered classification also corrupts the permanent revision-cause analytics for the archived ticket. The same client writes also bump `last_modified` (line 1011), which is the CAS token the server routes depend on — so a client write racing a server action can turn a legitimate transition into a spurious 409.

**Done when.**

- [ ] handleUpdateCategory, handleFileUpload and toggleWatch route through server endpoints that CAS on last_modified and keep ticket_comments in lockstep, in the same shape as PATCH /api/tickets/comment
- [ ] No client code writes the comments / history / attachments / watchers JSONB arrays directly
- [ ] A test drives a concurrent workflow action and a category edit and asserts neither loses the other's write

---

<a id="pers-3"></a>

## PERS-3 · Six client-side writes to `tickets` never check the returned error, and the audit log is written as if they succeeded

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:978`, `app/(protected)/requests/[id]/page.tsx:1010-1014`, `app/(protected)/requests/[id]/page.tsx:1328`, `app/(protected)/requests/[id]/page.tsx:920`, `app/(protected)/requests/page.tsx:620`, `app/(protected)/requests/page.tsx:639`

**Mechanism.** Each of these is `await supabase.from('tickets').update({...}).eq('id', ...)` with no `{ error }` destructuring and no `.select()` to confirm a row matched. Because the builder resolves rather than rejects (lib/supabase.ts:110, no throwOnError), the enclosing try/catch is dead for database errors, and execution falls through to the success path. Concretely: [id]/page.tsx:978 (root-cause category) is followed at 979 by `logAuditAction({ action: 'TICKET_ROOT_CAUSE_UPDATE' ... })` and at 985 by `setEditingCommentId(null)`; [id]/page.tsx:1010 (attachments + history) is followed at 1016 by `logAuditAction({ action: 'TICKET_FILE_UPLOAD' ... })` and by clearing the spinner; page.tsx:620 (bulk urgent) is followed at 623 by `logAuditAction({ action: 'TICKET_BULK_URGENT' ... })` and `setSelectedTicketIds(new Set())`; page.tsx:639 (quick urgent) by `TICKET_MARK_URGENT` at 640. [id]/page.tsx:920 and 1328 discard the result entirely (`.then(() => {})` and a bare await). The single insert path in this flow is the counter-example that proves the pattern is known and deliberate elsewhere: app/(protected)/requests/new/page.tsx:322-329 carries a comment reading 'IMPORTANT: supabase-js does NOT throw on a failed insert — it returns { error }. Check it explicitly' and then does `if (insertError) throw insertError;`.

**Failure scenario.** A drafter uploads the final IFC PDF for a construction package. `uploadTicketAttachment` puts the bytes in R2 successfully. The ticket row update at line 1010 is rejected (RLS, a transient 5xx from PostgREST, or a payload that trips a constraint). The user sees the spinner clear and no error. `audit_logs` gains a TICKET_FILE_UPLOAD row claiming the file was attached. The ticket row has no attachment. When the drafter then clicks 'Submit Final', `initiateWorkflowAction` (line 1030-1033) checks `ticket.attachments && ticket.attachments.length > 0` and either blocks them with an inexplicable 'Compliance Check Failed' or — if the realtime refetch has not yet corrected local state — lets the transition through with the deliverable orphaned in R2 and unreferenced by the ticket. Either way the audit log and the ticket disagree about whether the construction drawing exists.

**Evidence.**

```
app/(protected)/requests/[id]/page.tsx:1008-1019 —
      await supabase.from('tickets').update({
        attachments: [...currentAttachments, newAttachment],
        last_modified: now,
        history: [...currentHistory, historyEntry],
      }).eq('id', ticketId);

      await logAuditAction({
        action: 'TICKET_FILE_UPLOAD', resourceId: ticketId, resourceType: 'ticket',

contrast, app/(protected)/requests/new/page.tsx:322-330 —
      // IMPORTANT: supabase-js does NOT throw on a failed insert — it returns
      // { error }. Check it explicitly. ...
      const { data: inserted, error: insertError } = await supabase
        .from('tickets')
        .insert(ticketRow)
        .select('id')
        .single();
      if (insertError) throw insertError;
```

**Chain reaction.** Combined with finding #3 (logAuditAction also swallows), a failed ticket write produces neither a DB change, nor an audit row, nor a user-visible error — three independent silences stacked on one action.

**Done when.**

- [ ] Every one of the six call sites destructures `{ error }` (and where it matters, `.select('id')` to confirm a row matched) and surfaces the failure to the user before any success-path side effect
- [ ] The audit call is moved after a confirmed write, never before or unconditionally
- [ ] A lint rule or test forbids an un-destructured supabase write in the /requests tree

---

<a id="pers-4"></a>

## PERS-4 · Deleting a ticket is permitted by RLS and orphans its R2 attachment binaries and its live document_intents rows — no FK, no restrictive DELETE policy, no application guard

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `supabase/schema.sql:1080-1081`, `supabase/schema.sql:1249`, `supabase/schema.sql:495`, `supabase/schema.sql:840`, `app/api/admin/ticket-shed/commit/route.ts:186-194`

**Mechanism.** `tickets_org_access FOR ALL` covers DELETE with the same org-only USING clause, and no RESTRICTIVE DELETE overlay exists on tickets (verified against the 40 RESTRICTIVE declarations in supabase/, none of which name tickets). On delete, `ticket_comments.ticket_id ... ON DELETE CASCADE` (schema.sql:495) cleans up the comment rows, and `checkout_sessions.linked_ticket_id UUID REFERENCES tickets(id)` (schema.sql:840, no ON DELETE clause → NO ACTION) would block the delete only when a checkout happens to reference it. But the ticket's attachment binaries live on R2, addressed only by the `attachments` JSONB on the row itself — the shed path is the only code that reads those keys before removing anything (`keysFor(t)` at commit/route.ts:136-139, deleted at line 193). And `document_intents.ticket_id UUID` (schema.sql:1249) has no foreign key at all, so an intent registered against a deleted ticket persists until its 7-day TICKET_INTENT_TTL_MS expiry. Three differently-shaped searches confirm no application code deletes ticket rows today: `grep -rn "tickets\").delete\|tickets').delete" app lib components hooks` → no matches; enumerating every `.delete(` in app/api/tickets, app/api/admin/ticket-shed and app/(protected)/requests → only archives, ticket_comments, document_intents and a JS Set; `grep -rni 'delete from tickets|delete on tickets' supabase/` → no matches. So the mechanism is real but not currently exercised by the product.

**Failure scenario.** A member with any role issues `supabase.from('tickets').delete().eq('id', <id>)` (or a future admin 'purge' feature is added assuming RLS would stop the wrong people). The row and its ticket_comments vanish. The construction drawings and source DWGs attached to that request stay in the R2 bucket forever with no row referencing them — invisible to the storage-orphan sweeper's ticket accounting and unrecoverable as evidence, while the `audit_logs` rows carrying `resource_id = <ticketId>` point at nothing. Any document_intents row still claiming 'drafter X is editing this P&ID for ticket <id>' keeps suppressing/emitting overlap advisories against a request that no longer exists.

**Evidence.**

```
supabase/schema.sql:1249 (no FK on the ticket reference) —
  ticket_id UUID,
  session_id UUID,

supabase/schema.sql:495 (the contrast — the child that IS protected) —
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,

app/api/admin/ticket-shed/commit/route.ts:136-139 (the only code that knows how to free the binaries) —
  const keysFor = (t: TombstoneSource): string[] =>
    (Array.isArray(t.attachments) ? t.attachments : [])
      .map((a) => (a?.url || "").toString())
      .filter(Boolean);
```

**Chain reaction.** This is the destructive corner of finding #1: the same missing RESTRICTIVE policy that lets a member forge an approval also lets them erase the record of the request entirely, and unlike the shed path there is no `archives` catalog row proving the content was preserved first.

> **Verifier correction.** Survives as stated, but note it is a facet of finding 1's single FOR ALL policy rather than an independent gap, and no code path exercises it today. The distinct actionable residue is the missing FK on document_intents.ticket_id (schema.sql:1249) and the absent RESTRICTIVE DELETE overlay.

**Done when.**

- [ ] A RESTRICTIVE FOR DELETE policy on tickets limits deletion to Admin/DocCtrl (or forbids it outright in favour of CANCELED + shed)
- [ ] document_intents.ticket_id gets `REFERENCES tickets(id) ON DELETE CASCADE` so intents cannot outlive their ticket
- [ ] If ticket deletion is ever exposed in the product, it goes through a server route that frees the R2 keys the way commit/route.ts does

---

<a id="pers-5"></a>

## PERS-5 · The ticket→document-intent bridge is permanently dead: rowToTicket never maps `metadata`, so the overlap advisory for a drafter working a source drawing is never registered or cleared

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/ticketTransitions.ts:50-81`, `app/api/tickets/workflow-action/route.ts:230-274`, `app/api/tickets/workflow-action/route.ts:245-261`, `components/documents/EditOverlapBanner.tsx:49-52`
- **Also surfaced independently as** [`SM-11`](./06-state-machine.md#sm-11) — two lenses found this separately, which raises confidence. Fix once.
- **Same root cause as** `SM-11` — `ticket.metadata` is always `undefined` server-side. This is why `GAP-110`'s declaration cannot live in `metadata`, and why the intent bridge is dead. Fix once; close the rest citing this one.

**Mechanism.** `rowToTicket` (lib/ticketTransitions.ts:50-81) builds the Ticket object field by field and ends with `} as Ticket;` — the cast suppresses the excess/missing-property check TypeScript would otherwise raise. `grep -n metadata lib/ticketTransitions.ts` returns zero hits: the function maps 28 columns (row.id … row.last_modified) and `row.metadata` is not among them. app/api/tickets/workflow-action/route.ts:231 then does `const srcDoc = (ticket.metadata as Record<string, unknown> | undefined)?.source_document`. `ticket.metadata` is always `undefined`, so `srcDoc` is always `undefined`, so the entire `if (srcDoc?.id)` block at lines 233-271 never executes — neither the `document_intents` upsert on entering DRAFTING/REVISION_REQ (lines 245-261) nor the intent delete on CLOSED/FINAL_DRAFT (lines 264-269). Two differently-shaped searches confirm this is the only writer: `grep -rn document_intents lib app | grep -E 'upsert|insert'` returns exactly one hit (workflow-action/route.ts:245), and `grep -rn '"ticket"' lib app components | grep -iE 'intent|source'` returns only that same route (lines 253, 269) plus the type union in lib/intents.ts:33 and its unit test.

**Failure scenario.** Drafter A is assigned a ticket raised from P&ID 12-D-4021 and the ticket moves to DRAFTING. No `document_intents` row is created. Drafter B opens the same drawing to check it out for an unrelated MOC. `EditOverlapBanner` (components/documents/EditOverlapBanner.tsx:49) calls `listOrgEditOverlaps(orgId)` and finds nothing, so no advisory renders — B sees a clean drawing and starts editing. Two people revise the same P&ID concurrently, and the feature explicitly built to stop that (the 'ambient intent, no zombie lock' design described in the route's own comment at lines 225-229) has never fired once since it shipped.

**Evidence.**

```
lib/ticketTransitions.ts:50-81 (last mapped fields and the cast) —
    createdAt: row.created_at as string,
    lastModified: row.last_modified as string | undefined,
  } as Ticket;

app/api/tickets/workflow-action/route.ts:231-233 —
    const srcDoc = (ticket.metadata as Record<string, unknown> | undefined)
      ?.source_document as { id?: string } | undefined;
    if (srcDoc?.id) {
```

**Chain reaction.** The same omission silently disables the CLOSED/FINAL_DRAFT cleanup at lines 264-269, so if the upsert is ever fixed without also fixing rowToTicket, intents would be created and never deleted, expiring only on the 7-day TICKET_INTENT_TTL_MS (lib/intents.ts:58). rowToTicket also drops target_completion_at, sla_breach_warned_at, sla_breached_at, engineer_review_requested_at, engineer_approved_at, engineer_review_reason, archived_at, archive_id, closed_at, search_keywords and updated_at — any future server logic reading those through rowToTicket will read undefined the same way.

> **Verifier correction.** The dead-code mechanism is exactly as described and fully confirmed. The blast radius is narrower than HIGH implies: per workflow-action/route.ts:226-229 the intent is explicitly advisory and lock-free, so the consequence is a missing overlap banner, not a bypassed control. MEDIUM.

**Done when.**

- [ ] `rowToTicket` maps `metadata: row.metadata as Record<string, unknown> | undefined` (and the other missing columns the server path needs)
- [ ] The `as Ticket` cast is removed so the compiler flags any future field that is added to the Ticket type but not mapped
- [ ] A test asserts that a row with metadata.source_document.id round-trips through rowToTicket and that computeTransition to DRAFTING produces a document_intents upsert

---

<a id="pers-6"></a>

## PERS-6 · Two of the three ticket-creation paths never write `unit` — and they are the safety-critical ones (as-built discrepancy / undocumented field change, intake number collision)

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/CheckInPanel.tsx:236-268`, `lib/transitionIn.ts:304-331`, `app/(protected)/requests/new/page.tsx:299-315`, `types/schema.ts:1112`, `supabase/schema.sql:402`

**Mechanism.** `tickets.unit TEXT` is nullable in the DB (schema.sql:402) while the TypeScript contract declares it required (`unit: string;` at types/schema.ts:1112). The portal path supplies it (requests/new/page.tsx:303, `title, description, unit,`). The check-in path does not: CheckInPanel.tsx:236-268 inserts org_id, ticket_id, title, description, request_type, status, priority, target_completion_at, requester_id/name/email/role, attachments, watchers, comments, unread_by, history, metadata — and no `unit`. The intake-collision path does not either: lib/transitionIn.ts:304-331 inserts org_id, ticket_id, title, description, request_type, status, priority, requester_id/name/email/role, history, metadata — no `unit`. Both then flow through `rowToTicket`/`fromRow`, which cast `row.unit as string` (lib/ticketTransitions.ts:56, requests/page.tsx:251, requests/[id]/page.tsx via the same shape), so the required-typed field is silently `undefined` at runtime.

**Failure scenario.** A field tech checks in a P&ID and reports an undocumented field change with no MOC on record — the highest-consequence ticket the system creates, escalated straight to controllers (CheckInPanel.tsx:288-297). The ticket lands with `unit = NULL`. On /requests the Unit column renders blank (requests/page.tsx:1046, `{ticket.unit}`), the free-text search that matches on `(ticket.unit || '').toLowerCase()` (line 400) can never surface it by area, and sorting by `unit` (SortField at line 52, sort key at line 545) drops it into an undefined bucket. A PSM coordinator pulling 'every open drafting request against Unit 40' before a turnaround gets a list that omits the undocumented-change ticket for Unit 40.

**Evidence.**

```
components/documents/CheckInPanel.tsx:236-243 —
    const { data: row, error } = await supabase.from("tickets").insert({
      org_id: doc.orgId,
      ticket_id: ticketNumber,
      title: `${kindTitle}: ${doc.title || doc.documentNumber || "Document"}`,
      description: [note.trim(), mocLine].filter(Boolean).join("\n\n"),
      request_type: requestType,
      status: "PENDING_ASSIGNMENT",

types/schema.ts:1112 —
  unit: string;

supabase/schema.sql:402 —
  unit TEXT,
```

**Chain reaction.** Because `rowToTicket` and the page-level `fromRow` both use `as string` casts rather than typed row mapping, the compiler cannot see the mismatch — the same class of silent hole that produced finding #2's missing `metadata`.

> **Verifier correction.** Accurate as written, except the runtime value is `null` (nullable column selected as-is), not `undefined` — it renders as an empty Unit chip rather than crashing. Search is guarded at requests/page.tsx:400; the display sites at [id]/page.tsx:1737 and page.tsx:984/1046/1151 are not.

**Done when.**

- [ ] CheckInPanel and transitionIn derive and write `unit` (from the source document's unit/asset tags, or an explicit picker) on every ticket they create
- [ ] Either `unit` is made NOT NULL in the DB or the TypeScript type is relaxed to `unit?: string | null` so the two agree
- [ ] Row mappers stop using `as string` for columns that can be null

---

<a id="pers-7"></a>

## PERS-7 · logAuditAction cannot detect a failed audit write — supabase-js resolves with {error} rather than throwing, so its try/catch is unreachable and every client-side ticket audit event is best-effort silence

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/audit.ts:16-32`, `supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:84-90`, `supabase/schema.sql:1084-1085`, `app/(protected)/requests/[id]/page.tsx:979-983`, `app/(protected)/requests/page.tsx:623-627`
- **Same root cause as** `EVID-6` — `supabase-js` resolves with `{error}` rather than throwing, so a swallowed audit insert reads as success. Same class of fix at every call site. Fix once; close the rest citing this one.

**Mechanism.** `logAuditAction` awaits `supabase.from("audit_logs").insert({...})` inside a try/catch and never destructures `{ error }`. The shared client is a plain `createClient(url, anon, { auth: authOptions })` (lib/supabase.ts:110) with no `.throwOnError()` anywhere, so a PostgrestBuilder resolves with `{ data: null, error }` on a database error — the catch block at line 29 only ever fires for a network/transport fault. There are two live rejection paths for this exact insert. (a) The INSERT policy requires `user_id = auth.uid()` (schema.sql:1085-1086, tightened at 20260813_acl_close_gaps_and_audit_scope.sql:86-90), and `audit_logs.user_id` is `UUID` (schema.sql:777) — but the ticket call sites pass `userId: uid || 'unknown'` (requests/[id]/page.tsx:981, 1017; requests/page.tsx:625, 641), so a null uid sends the literal string 'unknown' into a uuid column, producing 22P02 which is swallowed. (b) A genuine RLS denial for any reason produces 42501, also swallowed.

**Failure scenario.** A drafter's session token has just expired in the background (uid resolves null while the page still renders). They classify a revision comment's root cause and upload the IFC drawing. `handleUpdateCategory` and `handleFileUpload` both call logAuditAction; both inserts are rejected by Postgres; both are swallowed; both handlers proceed to `setEditingCommentId(null)` / clear the upload spinner, so the UI reports success. Months later, during an OSHA PSM records review, the ticket's audit trail has no TICKET_FILE_UPLOAD row for the drawing that went to the field and no TICKET_ROOT_CAUSE_UPDATE row for the classification that drove the revision-category analytics.

**Evidence.**

```
lib/audit.ts:16-32 —
export async function logAuditAction(entry: AuditEntry) {
  try {
    await supabase.from("audit_logs").insert({
      ...
      user_id: entry.userId,
      ...
    });
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}

supabase/schema.sql:777 —
  user_id UUID,

app/(protected)/requests/[id]/page.tsx:981 —
        orgId: activeOrgId || undefined, userId: uid || 'unknown', userRole: activeRole,
```

**Chain reaction.** A second, quieter leak rides the same function: `org_id: entry.orgId || null` (lib/audit.ts:22) is explicitly permitted by the INSERT policy (`org_id IS NULL OR org_id IN (SELECT my_org_ids())`, 20260813:88) but the SELECT policy is `USING (org_id IN (SELECT my_org_ids()))` (schema.sql:1084-1085) — `NULL IN (...)` is NULL, never true. Any ticket audit row written while activeOrgId was unset is accepted, is immutable (no UPDATE/DELETE policy exists), and is invisible to every non-service-role reader forever.

> **Verifier correction.** The unreachable-catch mechanism is confirmed. Scope is narrower than the title implies: the workflow state-machine audit trail is written server-side with the service role (workflow-action/route.ts:216-225) and is unaffected; only supplementary client-side events go silent. Cited lines 1017 and 641 are actually 1018 and 642. MEDIUM.

**Done when.**

- [ ] logAuditAction destructures `{ error }` and surfaces or re-throws it rather than relying on try/catch
- [ ] Call sites stop substituting the string 'unknown' for a uuid — a missing uid is a reason to refuse the action, not to write a malformed row
- [ ] Either the INSERT policy stops allowing org_id IS NULL, or the SELECT policy is widened to cover it, so no accepted audit row is permanently unreadable

---

<a id="pers-8"></a>

## PERS-8 · my_org_ids() is SECURITY DEFINER with no SET search_path, and it is the sole gate on every ticket RLS decision

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `supabase/schema.sql:1030-1034`, `supabase/schema.sql:1080-1081`

**Mechanism.** `my_org_ids()` is declared `LANGUAGE SQL SECURITY DEFINER` and stops there — no `SET search_path`. `grep -n search_path supabase/schema.sql` returns exactly two hits, lines 475 and 527, which are `next_ticket_number` and `post_ticket_comment`; `grep -n 'SECURITY DEFINER' supabase/schema.sql` returns three hits, 475, 527 and 1032 — so the one SECURITY DEFINER function in the file that lacks the guard is precisely the one every ticket policy calls. A second search across all 159 migrations (`grep -rn my_org_ids supabase/`) finds no redefinition anywhere: schema.sql:1031 is the only CREATE, and the function is referenced by 20260707_teams.sql:35/44, 20260813_acl_close_gaps_and_audit_scope.sql:89, REMEDIATION_APPLY_ALL.sql:88 and sixteen policies in schema.sql including tickets_org_access. Its body resolves the unqualified relation name `org_members` through whatever search_path the caller has set.

**Failure scenario.** Any role that can create objects in a schema that lands ahead of `public` on the session search_path (in a default Supabase project, `public` itself is world-creatable unless it has been locked down) can define `org_members(org_id, uid, status)` in that schema. `my_org_ids()` then executes with definer privileges against the attacker-controlled table, returns whatever org ids it likes, and `tickets_org_access` grants read AND write on another tenant's entire drafting queue — every request, every attachment reference, every engineering approval record.

**Evidence.**

```
supabase/schema.sql:1030-1034 —
-- Helper: active orgs for current user
CREATE OR REPLACE FUNCTION my_org_ids()
RETURNS SETOF UUID LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active';
$$;

compare supabase/migrations/20260724_ticket_numbering.sql:33-38 (the guard applied correctly) —
CREATE OR REPLACE FUNCTION next_ticket_number(p_org UUID, p_year INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
```

**Chain reaction.** Sixteen other policies in schema.sql call my_org_ids() (documents, document_versions, libraries, collections, audit_logs, download_audits, checkout_sessions/episodes/messages, table_views, metadata_templates, watermark_policies), so a successful hijack is a whole-tenant compromise, not a tickets-only one.

> **Verifier correction.** The missing `SET search_path = public` on my_org_ids() (schema.sql:1031-1033) is real and it is the last SECURITY DEFINER function in the schema without the guard. But exploitability is not observable from this repo: shadowing the unqualified `org_members` reference requires the ability to create a relation as the calling role, which the PostgREST/anon-key surface does not provide. Downgrade to MEDIUM/SUSPECTED — hardening debt, not a confirmed escalation.

**Done when.**

- [ ] `my_org_ids()` is redefined with `SET search_path = public, pg_temp` (a migration, so live databases pick it up — editing schema.sql alone changes nothing deployed)
- [ ] A CI check asserts every SECURITY DEFINER function in supabase/ carries an explicit SET search_path

---
