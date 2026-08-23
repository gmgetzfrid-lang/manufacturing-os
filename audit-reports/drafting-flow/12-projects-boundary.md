# 12 · The Projects ↔ requests boundary

**13 findings** — 3 HIGH · 10 MEDIUM.

Direct answer to the bidirectional-portal question, from the schema up.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded here. Severities marked by that pass override the original.


---


<a id="proj-1"></a>

## PROJ-1 · A request's approved deliverable never becomes a controlled document — the drafting flow writes no documents or document_versions rows at all

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/storage.ts:452`, `lib/storage.ts:462`, `app/(protected)/requests/[id]/page.tsx:1078`, `app/(protected)/requests/[id]/page.tsx:1360`, `types/schema.ts:1038`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The absence claim holds under repo-wide search: no drafting-flow path writes documents or document_versions, so the approved Final PDF gets no document number, revision chain, supersession or hold coverage — while requests/[id]/page.tsx:647 stamps that very download 'CONTROLLED COPY'. Slight overstatement in the summary: the portal does keep an autonomous deliverable rev chain (20260827_ticket_deliverable_rev.sql), a /verify-ticket QR (:636-651) and download_audits rows (:675-683), so 'no distribution record' is too strong; the controlled-document gap itself is real.

**Mechanism.** Ticket files are uploaded by `uploadTicketAttachment`, which writes to `orgs/{orgId}/tickets/{ticketId}/{ts}_{filename}` where `ticketId` is the human request number, not a UUID — a namespace disjoint from the library namespace `orgs/{orgId}/libraries/{libraryId}/...` produced by `makeLibraryStoragePath`. The file is then recorded as an element of the `tickets.attachments` JSONB array with type Final/Draft/Source/Reference. Nothing in the request flow ever inserts into `documents` or `document_versions`.

**Failure scenario.** A drafting request for a revised isometric closes with an approved Final attachment. That PDF is the deliverable the field will build from, and it has no document number, no revision chain, no supersession record, no review-gate history, no hold coverage, no effective-date control and no distribution acknowledgement — none of the controls the rest of this system exists to enforce. Because it is also not a project document, it cannot be pushed into a project's register; the ask "push a request's files into the project's documents" has no code path to extend.

**Evidence.**

```
lib/storage.ts:452-460 — `export function makeTicketAttachmentPath(params: { orgId: string; ticketId: string; filename: string; }) { const ts = Date.now(); ... return joinPath("orgs", orgId, "tickets", ticketId, `${ts}_${sanitizeFilename(filename)}`); }`
lib/storage.ts:205-216 — `export function makeLibraryStoragePath(...) { ... const base = joinPath("orgs", orgId, "libraries", libraryId); ... }`
app/(protected)/requests/[id]/page.tsx:1360 — `const finalFiles = ticket.attachments?.filter(a => a.type === 'Final') || [];`
Searches proving absence: `grep -rn "from('documents')|from(\"documents\")|document_versions" app/(protected)/requests/` → no hits; `grep -n "document" lib/ticketTransitions.ts` → no hits; `grep -rln "tickets" app/api/` then `grep -n "documents" app/api/tickets/workflow-action/route.ts` → one hit at line 241, a read of `current_version_id, library_id` to populate a `document_intents` row, never a write to documents.
```

**Chain reaction.** The exact machinery needed already exists one module over: `/api/intake/upload` turns an externally-submitted file into a real `document_versions` row in a project collection, and `lib/transitionIn.ts::adoptDocument` moves it into the controlled register and upserts `project_documents`. The request→document promotion is a missing caller, not missing infrastructure.

> **Verifier correction.** One qualifier the finding omits: the ticket deliverable is not entirely uncontrolled. A parallel control surface exists — the deliverable rev ladder (1A->1->2A->2, lib/ticketTransitions.ts:84+) and the public /verify-ticket QR path (app/api/verify-ticket/route.ts) that tells a field holder whether a printed copy is still the latest issued rev. The accurate statement is that the deliverable is governed by a ticket-local scheme and never enters the documents/document_versions register, so it is outside library search, distribution/acknowledgement, supersession lineage and the review-control gate.

**Done when.**

- [ ] An approved Final attachment can be promoted into the controlled register through the same path intake submissions use (a real document_versions row, review gate, supersession of the prior rev)
- [ ] the promotion upserts a `project_documents` row when the request carries a project
- [ ] the promoted document's version records which request produced it

---

<a id="proj-2"></a>

## PROJ-2 · The Projects <-> drafting-request boundary does not exist in the schema: tickets carry no project reference of any kind

- **Severity:** HIGH
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:397`, `supabase/schema.sql:444`, `supabase/migrations/20260721_tickets_metadata.sql:16`, `supabase/migrations/20260827_ticket_deliverable_rev.sql:25`
- **Independently verified:** ⛔ **REFUTED** by a second independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). The claim that 'the boundary does not exist in the schema' and that there is 'no field, no join row, and no query that can associate the two' is false — projects.linked_ticket_id (and project_milestones.linked_ticket_id) is a first-class association, written by the ticket→project conversion flow and rendered as a live link from the project to the request. Only the narrower reverse-direction gap is true (the request detail page never renders its linked project, and nothing queries projects by linked_ticket_id), which does not support the stated finding or its HIGH severity.

**Mechanism.** The `tickets` CREATE TABLE enumerates every column and none is a project reference; the five `ALTER TABLE tickets` statements across all migrations add closed_at, deliverable_rev, draft_iteration, search_tsv, phase-A engineer fields, phase-B notification fields and metadata — never a project_id. Enumerating every `project_id UUID` column declaration in supabase/ yields checkout_sessions, milestones, notes, transmittals, project_intake_links, cost_accounts, change_orders, project_checklists, turnover_items, punch_items, markup_requests, project_documents, project_members, project_activity — `tickets` is absent. There is also no ticket-side join table: `project_documents` joins projects to documents only.

**Failure scenario.** A turnaround PM has an active project and a drafting request open against one of its P&IDs. There is no field, no join row, and no query that can associate the two, so the request is invisible on the project and the project is invisible on the request. When the PM marks the project complete and hands the package to the field, the open request — which may be an as-built discrepancy raised from a check-in on that very project — is not surfaced anywhere in the completion flow.

**Evidence.**

```
supabase/schema.sql:397-445 — `CREATE TABLE IF NOT EXISTS tickets ( id UUID PRIMARY KEY ... org_id ... ticket_id TEXT NOT NULL, title, description, unit TEXT, request_type TEXT NOT NULL, status, priority, requester_id, ... attachments JSONB DEFAULT '[]', comments JSONB DEFAULT '[]', history JSONB DEFAULT '[]', metadata JSONB, unread_by UUID[], revision_count INT, search_keywords TEXT[], watchers UUID[], target_completion_at, sla_breach_warned_at, sla_breached_at, archived_at, archive_id TEXT, closed_at, created_at, last_modified, updated_at, UNIQUE(org_id, ticket_id) );`
```

**Chain reaction.** Because the column does not exist, every consumer that would need it (project snapshot, project report, project export, project timeline, the requests list filter bar) was written without it, so adding the column later is not sufficient — six read paths must change with it.

> **Verifier correction.** The mechanism says "the five ALTER TABLE tickets statements"; there are 8 in supabase/migrations plus 3 more in schema.sql. The miscount does not affect the conclusion — none of them adds a project reference.

**Done when.**

- [ ] `tickets` carries an explicit project reference (nullable FK to projects(id) ON DELETE SET NULL) or a `project_tickets` join table exists with its own RLS
- [ ] the reference is populated by every ticket-creation path that has a project in hand (requests/new, CheckInPanel, flagCollisionToDrafting)
- [ ] at least one read path (project page tab or project snapshot) consumes it

---

<a id="proj-3"></a>

## PROJ-3 · project_documents RLS grants every active org member full ALL access — any member can silently delete a private project's document-register rows, bypassing the client-side canManage gate

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260609_phase1_normalization.sql:192`, `supabase/migrations/20260609_phase1_normalization.sql:194`, `components/projects/ProjectDocumentsCard.tsx:138`, `app/(protected)/projects/[id]/page.tsx:134`, `supabase/migrations/20260906_projects_hardening.sql:122`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: no later migration, RESTRICTIVE policy, or trigger constrains project_documents (the only trigger on it is checkouts_resync_project_documents, an INSERT/UPDATE resync), so any active org member — including a Viewer and a non-member of a private project — can SELECT, INSERT and DELETE its rows. Partial mitigation worth recording: rows with source='checkout' are re-created the next time a checkout row for that project/document is inserted or updated, so only manual attachments are permanently lost.

**Mechanism.** `project_documents_member_all` is `FOR ALL TO authenticated` gated only on active org membership — it does not consult project visibility, project membership, ownership, or controller status. The 20260906 hardening migration explicitly re-scoped project_members, project_activity, markup_requests, the cost tables and project_intake_links, and left project_documents untouched; project_activity DELETE was narrowed to controller-or-owner in that same migration while project_documents DELETE stayed open to any member. The only guard on attach/detach is the client prop `canManage={!!canManage}` where `canManage = isOwner || isAdmin`, which a direct PostgREST call ignores. The client also writes the doc_added/doc_removed `project_activity` row itself, so a direct call leaves no trace at all — and no `audit_logs` row is written on either path.

**Failure scenario.** A member of the org who is not on a private capital project enumerates project ids (they are returned by any `project_documents` select, which is unrestricted) and issues `DELETE FROM project_documents WHERE id = ...`. The drawing disappears from that project's Documents card, from `getProjectTimeline` (which resolves linked doc ids from this table), from `searchDocuments({projectId})`, from the CSV export handed to the contractor, and from `getDocumentImpact`'s "projects actively using this document" list — with no activity entry and no audit row to show it happened.

**Evidence.**

```
supabase/migrations/20260609_phase1_normalization.sql:192-198 — `ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "project_documents_member_all" ON project_documents; CREATE POLICY "project_documents_member_all" ON project_documents FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_documents.org_id AND uid = auth.uid() AND status = 'active')) WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_documents.org_id AND uid = auth.uid() AND status = 'active'));`
supabase/migrations/20260906_projects_hardening.sql:122-127 — `CREATE POLICY project_activity_delete ON project_activity FOR DELETE USING ( is_org_controller(org_id) OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_activity.project_id AND p.owner_user_id::text = auth.uid()::text) );`
app/(protected)/projects/[id]/page.tsx:134 — `const canManage = isOwner || isAdmin;`
components/projects/ProjectDocumentsCard.tsx:138 — `const { error } = await supabase.from("project_documents").delete().eq("id", r.linkId);`
Searches for a later override: `grep -rn "ON project_documents" supabase/` (indexes + the one policy) and `grep -rn "project_documents" supabase/migrations/*.sql | grep -v 20260609 -e CATCHUP` (only DIAGNOSE_* read-only scripts).
```

**Chain reaction.** Because the deletion is invisible on every downstream surface, the loss is discovered only when someone notices a drawing missing from a closeout package — by which time the project timeline offers no explanation.

**Done when.**

- [ ] project_documents SELECT honors project visibility (reuse `project_visible_to_me(uuid)` from 20260913) and INSERT/DELETE narrow to controllers, the project owner, or project members — matching the treatment project_activity already received
- [ ] attach/detach writes an `audit_logs` row server-side, not only a client-written project_activity row
- [ ] the checkout trigger's inserts still succeed under the narrowed policy (it runs as the checking-out user)

---

<a id="proj-4"></a>

## PROJ-4 · CheckInPanel discards the project id it is already holding when it creates a drafting request from a project checkout

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/CheckInPanel.tsx:56`, `components/documents/CheckInPanel.tsx:261`, `components/documents/CheckInPanel.tsx:263`, `types/schema.ts:929`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — the panel holds the project id and drops it, and tickets have no project_id column at all (the only project link any ticket carries is transitionIn.ts:323 metadata.intake_collision.projectId). One indirect route the finding does not mention: the ticket does carry metadata.source_document.id, and lib/impact.ts:117 `.eq("metadata->source_document->>id", documentId)` surfaces it on the document's Impact panel, which is reachable from the project's Documents card — but nothing on the project page itself shows it.

**Mechanism.** CheckInPanel receives `mySession: CheckoutSession` as a prop. `CheckoutSession` carries `projectId?: string` (populated from `checkout_sessions.project_id`, which CheckoutFlowModal writes at line 322 and bulkCheckoutToProject writes for every bulk checkout). At the moment the panel builds the new ticket's metadata it reaches into that same object for `mySession.purpose`, but records only `episodeId`, `checkoutNumber`, `purpose` and `outcome` — `mySession.projectId` is never read. The one available, already-in-memory project id at the exact moment a request is born from project work is dropped.

**Failure scenario.** A drafter checks out P&ID 12-D-401 under project "U2 Reformer Turnaround", finds the field differs from the drawing, and checks in with an as-built discrepancy. A Revision request is created and routed to the assignment queue. Nobody on the project page ever sees it: the request has no project id, the project has no request list, and the only durable trace of the project connection — the checkout session row — is released when the project completes.

**Evidence.**

```
components/documents/CheckInPanel.tsx:261-267 — `metadata: { source_document: { id: doc.id, document_number: doc.documentNumber ?? null, title: doc.title ?? null, rev: doc.rev ?? null, path: null }, checkin: { episodeId: episode?.id ?? null, checkoutNumber: episode?.seq ?? null, purpose: mySession.purpose ?? null, outcome: card.outcome }, ... }`
components/documents/CheckInPanel.tsx:55-56 — `episode: CheckoutEpisode | null;` / `mySession: CheckoutSession;`
types/schema.ts:929 — `projectId?: string;                // nullable: ad-hoc checkouts have none`
components/documents/CheckoutFlowModal.tsx:322 — `project_id: projectId,`
```

**Chain reaction.** This is the highest-value single write in the whole boundary: it is the one code path where a request provably originates from project work, and it is one property away from being recorded.

> **Verifier correction.** Severity lowered to MEDIUM. Recording the id would currently be inert: tickets have no project column (finding 1), and the one project id that IS written into ticket metadata today (transitionIn.ts:324) is never read by anything (finding 11, verified). So this is a missed opportunity to lay groundwork, not a live loss of a link any consumer would use. HIGH overstates the consequence.

**Done when.**

- [ ] The check-in ticket records the originating project (as a real column once one exists, or at minimum `metadata.checkin.projectId` alongside episodeId)
- [ ] the same is done for the `metadata.source_document` sibling path so a project→requests query has a single shape to match

---

<a id="proj-5"></a>

## PROJ-5 · Intake-uploaded documents never get a project_documents row, so the project has two disjoint definitions of "its documents"

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:225`, `app/api/intake/upload/route.ts:239`, `lib/transitionIn.ts:221`, `lib/timeline.ts:423`, `lib/projectExport.ts:42`, `components/projects/ProjectDocumentsCard.tsx:52`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The title's "never" is false: adoptDocument() does create the project_documents row when an intake sheet is transitioned into the controlled register. Also, submissions are not invisible on the project page — components/projects/IntakePanel.tsx renders a "Submissions awaiting review" queue for them. The real, narrower defect (an un-adopted intake document is absent from project_documents, hence from ProjectDocumentsCard, getProjectTimeline's linked-doc pull at timeline.ts:423-426, and loadProjectBundle at projectExport.ts:41) stands, but it is a register/export completeness gap, not a lost document — LOW.

**Mechanism.** `/api/intake/upload` resolves the project's `intake_library_id` / `intake_collection_id`, creates the collection if needed, and inserts `documents` rows into it — but never inserts into `project_documents`. The join row is only created later by `adoptDocument`, when a controller runs transition-in. Meanwhile every project-side document surface keys off `project_documents`: ProjectDocumentsCard selects from it, getProjectTimeline resolves `linkedDocIds` from it, projectExport's bundle unions checkout_sessions and project_documents, and searchDocuments({projectId}) resolves the id set from it and returns [] when empty.

**Failure scenario.** A contractor submits four revised isometrics through the project's tokenized portal. They land in the project's own intake folder as real documents. The PM opens the project's Documents tab and sees none of them; the project timeline shows no version events for them; "Export CSV" hands a reviewer a document list that omits them. Only the Intake tab knows they exist, and only until someone adopts them.

**Evidence.**

```
app/api/intake/upload/route.ts:225-240 — `const { data: project } = await supabaseAdmin.from("projects").select("id, name, owner_user_id, intake_library_id, intake_collection_id") ... await supabaseAdmin.from("projects").update({ intake_collection_id: collectionId }).eq("id", projectId);` — and `grep -n "project_documents" app/api/intake/upload/route.ts` returns nothing.
lib/transitionIn.ts:221-226 — `await supabase.from("project_documents").upsert({ org_id: input.orgId, project_id: input.projectId, document_id: input.docId, source: "manual", last_seen_at: nowIso }, { onConflict: "project_id,document_id", ignoreDuplicates: false })` with the comment `// Keep the project tracking the document after it leaves the intake folder.`
lib/timeline.ts:423-427 — `supabase.from("project_documents").select("document_id").eq("project_id", projectId)`
lib/projectExport.ts:42 — `supabase.from("project_documents").select("*").eq("project_id", projectId),`
```

**Chain reaction.** ProjectDocumentsCard's own header comment says the audit already found that intake-adopted documents were missing and fixed the read side; the un-adopted intake documents are the remaining half of the same split, and they are the ones most likely to be mid-flight when a package ships.

**Done when.**

- [ ] `/api/intake/upload` upserts a `project_documents` row (source distinguishing intake from checkout/manual) at the moment the document is created
- [ ] the Documents card badges intake-sourced rows distinctly so a PM can tell adopted from not-yet-adopted
- [ ] project timeline and CSV export include them

---

<a id="proj-6"></a>

## PROJ-6 · Project completion has no open-drafting-request gate and structurally cannot have one — the closeout snapshot never queries tickets

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/projects/[id]/page.tsx:627`, `app/(protected)/projects/[id]/page.tsx:646`, `lib/projectSnapshot.ts:22`, `lib/projects.ts:259`, `lib/projects.ts:300`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually confirmed — no ticket gate exists and the snapshot never queries tickets (nor could it usefully, since no ticket carries a project id). Severity is too high, though: every existing gate is advisory, not blocking (page.tsx:646 explicitly says the owner can complete anyway), so the missing gate would only add one more warning line — it removes no enforcement that exists today.

**Mechanism.** `transitionProjectStatus` sets status='completed' after only `assertCanManageProject`; it queries no other table for readiness. The UI's "Closeout gates" list is built from `ProjectStateSnapshot` and enumerates exactly four checks: punchOpen, turnoverRequired/Accepted, checklistOpenItems+checklistNeedsEvidence, openChangeOrders. `gatherProjectSnapshot` issues ten parallel reads — projects, cost_documents, project_parties, change_orders, milestones, project_checklists, turnover_items, punch_items, project_intake_links, project_members — and `tickets` is not among them. The gates are also explicitly advisory: the Confirm button is disabled only on `transitionBusy`.

**Failure scenario.** A drafting request created by CheckInPanel for an undocumented field change (priority 1, escalated to controllers as a PSM alert) is still in DRAFTING. The PM opens Complete, sees four green gates, confirms, and the project is marked completed. Every active checkout on the project is released (lib/projects.ts:300-306), the closeout report is generated from the snapshot that never saw the ticket, and the field package is treated as final while the drawing that documents the change is still being drafted.

**Evidence.**

```
app/(protected)/projects/[id]/page.tsx:628-633 — `const gateLines: Array<{ ok: boolean; text: string }> = [ { ok: gates.punchOpen === 0, ... }, { ok: gates.turnoverRequired === 0 || gates.turnoverAccepted >= gates.turnoverRequired, ... }, { ok: gates.checklistOpenItems + gates.checklistNeedsEvidence === 0, ... }, { ok: gates.openChangeOrders === 0, ... } ];`
app/(protected)/projects/[id]/page.tsx:648 — `You can complete anyway — the open items stay on the record and in the report.`
lib/projectSnapshot.ts:22-42 — the ten `supabase.from(...)` reads; no `from("tickets")`.
Searches: `grep -n 'from("' lib/projectSnapshot.ts lib/projectReport.ts lib/projectHealth.ts` (no tickets), and `grep -rni "ticket" components/projects/` (3 hits, all comments/toast text about flagCollisionToDrafting).
```

**Chain reaction.** The closeout report (lib/projectReport.ts) is generated from the same snapshot, so the permanent record of the project's completion also omits the open request — the gap is preserved into the audit artifact.

> **Verifier correction.** Severity lowered to MEDIUM. The source comment at page.tsx:625-626 states the design explicitly — "Closeout gates ... Warnings, not walls: the owner can complete anyway, on the record." Every existing gate is advisory, so a drafting-request gate added here would be advisory too. This is a missing advisory line in a deliberately non-blocking panel (and downstream of finding 1's root cause), not a bypassed control.

**Done when.**

- [ ] `gatherProjectSnapshot` counts open drafting requests for the project (once a project<->ticket reference exists) and a fifth closeout gate reports them
- [ ] the count appears in the generated closeout report so the record shows what was open at completion
- [ ] completing with open requests still writes the count into the PROJECT_COMPLETED audit details

---

<a id="proj-7"></a>

## PROJ-7 · The org-wide graph — the surface built to show every persisted relationship — has no ticket node type, so drafting work is absent from the system's own map

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:23`, `lib/orgGraph.ts:25`, `lib/orgGraph.ts:121`, `lib/orgGraph.ts:12`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The absence is confirmed. But the header's "every persisted relationship" is immediately followed (lines 5-15) by an explicit enumeration of the eight relationship tables it draws, and there is in fact no persisted ticket↔document or ticket↔project relationship row anywhere to draw — every ticket link lives in a metadata JSON blob (metadata.source_document, metadata.intake_collision). A missing node type in a visualization with no underlying edge rows is a LOW-severity coverage gap, not a MEDIUM correctness defect.

**Mechanism.** `GraphNodeType` is a closed union of document | asset | unit | library | project | plant | plot, and `GraphEdgeType` of tag | unit | library | project | related | supersession | proposed | mention | flow | plot. The module's own header enumerates every edge it draws and each is a row in a table; `project ↔ document project_documents (checkout + manual)` is there, tickets are not. A grep for "ticket" in the whole file returns nothing.

**Failure scenario.** An engineer opens the graph to answer "what is happening around this P&ID" — the page whose premise is that nothing is inferred and every relationship is a real row — and sees its documents, assets, units and projects, but not the open revision request against it. The absence reads as "no drafting work", which is exactly the wrong conclusion before a rev-up decision.

**Evidence.**

```
lib/orgGraph.ts:23 — `export type GraphNodeType = "document" | "asset" | "unit" | "library" | "project" | "plant" | "plot";`
lib/orgGraph.ts:25-35 — `export type GraphEdgeType = | "tag" | "unit" | "library" | "project" | "related" | "supersession" | "proposed" | "mention" | "flow" | "plot";`
lib/orgGraph.ts:12 — `//   project  ↔ document   project_documents (checkout + manual)`
lib/orgGraph.ts:121 — `"project_documents", "project_id, document_id", orgId, EDGE_CAP),`
Search: `grep -n "ticket" lib/orgGraph.ts` → no output.
```

**Chain reaction.** Because the graph is the designated place to see cross-entity relationships, its silence on tickets removes the last surface where a project<->request link would have become visible once it existed.

**Done when.**

- [ ] A ticket node type and a document↔ticket edge (from the source_document link) exist in the graph
- [ ] once a project reference exists, a project↔ticket edge is drawn from the same real rows
- [ ] the edges are capped and the truncation reported like every other edge source in the module

---

<a id="proj-8"></a>

## PROJ-8 · The project document register accepts Superseded and Archived documents with no guard and no warning

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/projects/ProjectDocumentsCard.tsx:95`, `components/projects/ProjectDocumentsCard.tsx:123`, `components/projects/ProjectDocumentsCard.tsx:211`, `lib/impact.ts:96`, `lib/transitionIn.ts:167`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The guard genuinely is missing at pick time (compare lib/impact.ts:96 and lib/transitionIn.ts:167, which both `.filter((d) => d.status !== "Superseded" && d.status !== "Archived")`). But "no warning" is only true of the picker: the attached row carries a SUPERSEDED badge and the export carries a Status column, so a reviewer is not handed an unlabelled superseded drawing. LOW.

**Mechanism.** The attach picker's search selects only `id, document_number, title, name` — `status` is not even fetched, so no filter is possible and none is applied. The upsert writes the join row unconditionally with `source: "manual"`. The rendered row displays whatever `status` the document carries as a neutral grey pill alongside the rev, with no visual distinction for Superseded or Archived. Sibling code in the same codebase does filter: `getDocumentImpact` drops `Superseded`/`Archived` from its sibling list, and `scanTransitionImpact` drops them from overlap candidates.

**Failure scenario.** A PM attaching drawings to a turnaround project searches "12-D-401", gets several hits including the superseded Rev C alongside the current Rev D, and picks the wrong one. The register now lists a superseded drawing as a project document; it flows into `exportProjectToCsv`'s DOCUMENTS block (which prints doc number, title, rev, status) and into the project timeline, and the only signal that anything is wrong is a status word rendered in the same muted style as every other status.

**Evidence.**

```
components/projects/ProjectDocumentsCard.tsx:95-100 — `const { data } = await supabase.from("documents").select("id, document_number, title, name").eq("org_id", orgId).or(`document_number.ilike.%${term}%,title.ilike.%${term}%,name.ilike.%${term}%`).limit(8);`
components/projects/ProjectDocumentsCard.tsx:123-127 — `const { error } = await supabase.from("project_documents").upsert({ org_id: orgId, project_id: projectId, document_id: doc.id, source: "manual", last_seen_at: nowIso }, { onConflict: "project_id,document_id", ignoreDuplicates: false });`
components/projects/ProjectDocumentsCard.tsx:211 — `{r.status && <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{r.status}</span>}`
lib/impact.ts:95-96 — `.filter((d) => d.status !== "Superseded" && d.status !== "Archived")`
```

**Chain reaction.** The CSV export is the artifact most likely to leave the system and reach a contractor, and it reproduces the register verbatim.

**Done when.**

- [ ] The attach picker selects `status` and either excludes Superseded/Archived or labels them unmistakably before the click
- [ ] already-attached rows in a non-current status render as a warning, not a neutral pill
- [ ] the CSV export marks non-current documents

---

<a id="proj-9"></a>

## PROJ-9 · The request detail page renders none of the metadata that carries its links — source document, custom categories and the intake-collision project are all write-only

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:904`, `app/(protected)/requests/[id]/page.tsx:1691`, `app/(protected)/requests/[id]/page.tsx:1735`, `app/(protected)/requests/new/page.tsx:289`, `app/(protected)/requests/new/page.tsx:536`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. A repo-wide grep for custom_categories finds exactly two hits: the writer (requests/new:289) and a comment in admin/requests/page.tsx:361 describing where the values are stored — no reader anywhere, so admin-defined required fields are collected on every request and never displayed. metadata.source_document is at least read server-side (lib/impact.ts:117, workflow-action route:231), but not on the request page itself.

**Mechanism.** The detail page loads `metadata` into ticket state and reads exactly one key from it, `archive_summary`. `metadata.source_document` — written by requests/new, by CheckInPanel and by flagCollisionToDrafting, and queried by lib/impact.ts — is never displayed. `metadata.custom_categories`, the admin-configurable per-request fields defined in Admin -> Requests and collected in the new-request form, are never rendered back either. The page contains no `href=` at all and its only navigation is `router.push('/requests')`. The section headed "Project Specifications" shows Unit, Requester, Assigned Lead, Engineer Reviewer, Initiated, Target Completion and Watching — the word "Project" is decoration.

**Failure scenario.** An org admin defines a custom category field "Project / Job" to work around the missing link (the only free-text avenue available, since tickets have no MOC field either — MOC is merely one of the request-type options). Requesters dutifully fill it in on every request. Nobody ever sees it again: it is stored in metadata.custom_categories and rendered nowhere, so the workaround silently fails and the drafter still cannot tell which job the request belongs to.

**Evidence.**

```
app/(protected)/requests/[id]/page.tsx:904 — `metadata: (r.metadata as Record<string, unknown> | null) ?? undefined,`; the only later use is line 1691 `const sum = (ticket.metadata?.archive_summary ?? {}) as {`.
app/(protected)/requests/[id]/page.tsx:1735 — `... <FileText className="w-4 h-4 mr-2 text-orange-500" /> Project Specifications</h2><span ...>ID: {ticket.id}</span>`
app/(protected)/requests/new/page.tsx:289-297 — `if (Object.keys(customValues).length > 0) metadata.custom_categories = customValues; if (sourceDocId) { metadata.source_document = { id: sourceDocId, document_number: sourceDocNum, title: sourceDocTitle, rev: sourceDocRev, path: sourceFileUrl, }; }`
Searches: `grep -rn "href=" 'app/(protected)/requests/[id]/page.tsx'` → no hits; `grep -rn "source_document|sourceDoc" 'app/(protected)/requests/[id]/page.tsx'` → no hits; `grep -rn "custom_categories|customCategories"` across the repo → 9 hits, none in the request detail page.
```

**Chain reaction.** Because the ticket page shows no outbound link of any kind, even the ticket<->document relationship that genuinely exists in data is invisible to the person working the ticket — the drafter cannot click through to the drawing the request was raised from.

> **Verifier correction.** Minor count correction: the repo-wide custom_categories|customCategories search returns 11 lines (types/schema.ts:1154,1222,1223; admin/requests/page.tsx:110,228,229,230,361,363; requests/new/page.tsx:273,289,536), not 9. The material point stands — none is in the request detail page.

**Done when.**

- [ ] The request detail page renders `metadata.source_document` as a link to the document and `metadata.custom_categories` as labelled fields
- [ ] when a project reference exists it renders as a link to the project, mirroring the project page's chip

---

<a id="proj-10"></a>

## PROJ-10 · checkout_sessions.linked_ticket_id is a live FK to tickets that no code path ever writes, leaving the one transitive project->request route empty

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:840`, `lib/projects.ts:354`, `components/documents/CheckoutFlowModal.tsx:318`, `lib/projects.ts:965`, `lib/checkoutEpisodes.ts:715`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Both halves check out: nothing writes checkout_sessions.linked_ticket_id, and milestones.linked_ticket_id has a writer (milestones.ts:171) whose only caller, components/projects/ScheduleTab.tsx, never passes linkedTicketId (grep finds no such property anywhere under components/). Severity lowered: this is an unwired column with no incorrect behavior — no data is lost or corrupted, a query simply returns nothing.

**Mechanism.** `checkout_sessions` carries both `project_id` and `linked_ticket_id UUID REFERENCES tickets(id)`. `rowToCheckoutSession` maps the latter into the CheckoutSession type. But all three insert sites build their `sessionRow` object explicitly and none includes `linked_ticket_id`: CheckoutFlowModal's single checkout, bulkCheckoutToProject's per-doc row, and checkoutEpisodes' quick-hold row. A search for the identifier across lib/, app/ and components/ returns only the projects.ts and milestones.ts mappings — no assignment. The same is true of `milestones.linked_ticket_id`: the ScheduleTab create form collects `linkedRevisionLabel` free text and never `linkedTicketId`.

**Failure scenario.** An engineer looking for "which requests came out of this project's work" has, in principle, a two-hop path — project -> checkout_sessions -> tickets — and it returns nothing, on every project, forever. The same is true of the project -> milestones -> tickets path. Both FKs make the schema read as though the boundary is wired.

**Evidence.**

```
supabase/schema.sql:840 — `linked_ticket_id UUID REFERENCES tickets(id),`
lib/projects.ts:354 — `linkedTicketId: r.linked_ticket_id as string | undefined,`
components/documents/CheckoutFlowModal.tsx:318-326 — `const sessionRow: Record<string, unknown> = { org_id: document.orgId, document_id: document.id, library_id: document.libraryId, user_id: currentUser.uid, user_name: userName, mode, note: note.trim() || null, status: "active", lock_id: lockId, project_id: projectId, purpose: purposeCategory, expected_release_at: expectedReleaseAt || null, auto_expires_at: autoExpiresAt, };`
components/projects/ScheduleTab.tsx:705-714 — `await createMilestone({ orgId, projectId, name, description, weight: ..., plannedAt: ..., linkedRevisionLabel: linkedRev || undefined, createdBy: userId, ... });`
Searches: `grep -rn "linked_ticket_id" lib/ app/ components/` (7 hits, all mappings/inputs, zero writes outside createProject) and `grep -rni "linkedticketid"` over .ts/.tsx (14 hits, same picture).
```

**Chain reaction.** Three separate FK columns pointing at tickets (projects, checkout_sessions, milestones) are all unwritten. A reviewer sampling any one of them concludes the link exists.

**Done when.**

- [ ] A checkout raised to service a drafting request stamps `linked_ticket_id`, or the unused column and its mapping are removed
- [ ] the same decision is made for milestones.linked_ticket_id so the schema stops advertising three dead links

---

<a id="proj-11"></a>

## PROJ-11 · document_versions.related_ticket_id is never written but IS honoured as a review-gate bypass — wiring the ticket<->document link naively will silently disable required review

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:55`, `lib/reviewControl.ts:60`, `supabase/schema.sql:334`, `lib/revisions.ts:958`, `components/documents/RevUpModal.tsx:210`, `lib/documentLifecycle/setRevUp.ts:83`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The dead column and the bypass branch both exist, so the design smell is real. But the stated mechanism is overstated: because both call sites omit relatedTicketId, stamping the column on a version would change nothing — a second, separate change (threading the version's relatedTicketId into effectiveModeForRevUp) would be required before any review gate could be skipped. Latent hazard, not a live or one-commit-away bypass — LOW.

**Mechanism.** `effectiveModeForRevUp` returns "none" — i.e. no review required before publish — whenever `relatedTicketId` is truthy, on the stated rationale that a rev that came from a drafting ticket "already had review". The column exists on document_versions and is mapped into the Revision type in two places, but no code anywhere writes it: searching for the snake_case identifier across .ts/.tsx yields only the two read mappings, and searching for any assignment form (`related_ticket_id` followed by `:` or `=`) across .ts/.tsx/.sql yields nothing. Both production callers construct the argument without the property, so today the branch is dead and the gate always applies.

**Failure scenario.** The next engineer building the Projects<->request boundary does the obvious thing and starts stamping `related_ticket_id` on versions produced from a drafting request. From that commit forward, every such rev-up skips the review gate on every library configured with mode 'require' — including P&IDs — because the bypass is keyed on the mere presence of a ticket id, not on evidence that the ticket's own engineer review actually completed. An unreviewed construction drawing publishes as current.

**Evidence.**

```
lib/reviewControl.ts:55-62 — `export function effectiveModeForRevUp(input: { control: ReviewControl; changeType?: string | null; relatedTicketId?: string | null; }): ReviewControlMode { if (input.control.mode === "none") return "none"; if (input.changeType === "Minor" || input.changeType === "Correction") return "none"; if (input.relatedTicketId) return "none"; return input.control.mode; }`
components/documents/RevUpModal.tsx:210 — `const effMode = effectiveModeForRevUp({ control: reviewControl ?? { mode: "none" }, changeType });`
lib/documentLifecycle/setRevUp.ts:83 — `willReview = effectiveModeForRevUp({ control, changeType }) !== "none";`
supabase/schema.sql:334 — `related_ticket_id UUID,`
lib/__tests__/reviewControl.test.ts:42 asserts the bypass: `expect(effectiveModeForRevUp({ control: C({ mode: "require" }), changeType: "Major", relatedTicketId: "t1" })).toBe("none");`
```

**Chain reaction.** The bypass is covered by a passing unit test, so a reviewer checking "is this behaviour intended?" will find a green test asserting it and conclude yes.

> **Verifier correction.** Severity lowered to MEDIUM. The finding itself establishes the branch is unreachable today, so there is no live gate bypass — this is a latent trap that fires only if someone later populates the column. Real and worth a guard, but HIGH implies a currently-exploitable hole in required review, which the code refutes.

**Done when.**

- [ ] The bypass keys on evidence of completed review (e.g. the ticket's engineerApprovedAt) rather than the bare presence of a ticket id, or the branch is removed
- [ ] if the branch is kept, the `related_ticket_id` write path lands in the same change as the gate condition so the two are never out of step
- [ ] the test asserts the stricter condition

---

<a id="proj-12"></a>

## PROJ-12 · flagCollisionToDrafting writes a project id onto the ticket that nothing reads, and reports the result as a disposable toast with no link

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transitionIn.ts:321`, `lib/transitionIn.ts:356`, `components/projects/IntakePanel.tsx:283`, `app/api/intake/upload/route.ts:154`, `app/(protected)/admin/audit/page.tsx:137`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Both specifics are accurate (projectId is written and read by nothing; the toast carries a ticket number but no link). Severity lowered because the association is not actually lost — it is persisted on the ticket row (metadata.intake_collision.projectId) and duplicated into audit_logs details (transitionIn.ts:362), so a future surface can recover it; the ticket itself is also routed and linked for its recipients via emit(link: `/requests/${row.id}`, :344). That is strictly less harmful than PROJ-4, where the id is discarded outright.

**Mechanism.** This is the only place in the codebase that ever writes a project id onto a ticket, as `metadata.intake_collision.projectId`. Searching for readers of `intake_collision` finds three sites, and all three use only `intakeLinkId` — the `projectId` sibling is never read (a case-insensitive search for the camelCase `intakeCollision` finds nothing at all). The audit row is filed under `resource_type: "document"` with `resource_id: candidate.docId` and the project id buried in `details`, and the admin audit page filters only on `resource_type` — audit_logs has no index or filter on `details`. The user-facing result is a `setMsg` string containing the ticket number as plain text with no href.

**Failure scenario.** A PM reviewing intake flags a number collision on a contractor-submitted sheet, sees the toast "...flagged to drafting — ticket DR-2026-0417 is in the assignment queue", and navigates away. There is now no surface anywhere that connects that request back to the project: the project page has no requests tab, the ticket page shows no project, the audit trail files it under the document, and the one persisted project id is unread. If the collision is not resolved, the project can still be completed with the conflicting sheet in its intake folder.

**Evidence.**

```
lib/transitionIn.ts:321-330 — `metadata: { source_document: { id: candidate.docId, number: candidate.number, title: candidate.title }, intake_collision: { projectId, intakeLinkId, numberCollisionDocId: impact.numberCollision?.id ?? null, overlaps: ..., flaggedAt: nowIso, }, },`
lib/transitionIn.ts:356-359 — `await supabase.from("audit_logs").insert({ action: "INTAKE_COLLISION_FLAGGED", resource_type: "document", resource_id: candidate.docId, ... })`
components/projects/IntakePanel.tsx:283-285 — `setMsg(res.ok ? `${candidate.label} flagged to drafting — ticket ${res.ticketNumber} is in the assignment queue.` : (res.error ?? "Couldn't flag the collision."));`
app/api/intake/upload/route.ts:154-155 — `const meta = (ticket.metadata ?? {}) as { intake_collision?: { intakeLinkId?: string | null } }; if (String(meta.intake_collision?.intakeLinkId ?? "") !== String(link.id)) {` — the sole shape of the read, projectId absent.
```

**Chain reaction.** This is the closest thing in the repo to a working project→request bridge; it is one read away from being the seed of the whole boundary, and its already-persisted projectId is the natural key for a project requests tab.

**Done when.**

- [ ] The collision ticket is reachable from the project (a persistent entry on the project surface, not a toast) and the toast carries a link to /requests/<id>
- [ ] the audit row is retrievable by project — either filed against the project or with the project id in an indexed position
- [ ] `metadata.intake_collision.projectId` is either read or replaced by the real project reference

---

<a id="proj-13"></a>

## PROJ-13 · projects.linked_ticket_id is a dead column — its only writer's only caller has zero call sites, so the project page's "Linked ticket" chip can never render

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/projects.ts:112`, `lib/projects.ts:781`, `lib/projects.ts:807`, `app/(protected)/projects/[id]/page.tsx:308`, `supabase/schema.sql:906`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Confirmed — zero call sites, so the column is always NULL. Severity lowered: this is a never-invoked feature plus a conditional that never fires (no wrong data, no wrong behavior), the same class as PROJ-10.

**Mechanism.** `createProject` is the only writer of `linked_ticket_id`. Of its four call sites (ProjectWizard.tsx:128, CheckoutFlowModal.tsx:288, lib/projects.ts:803 inside convertTicketToProject, lib/projects.ts:893 inside bulkCheckoutToProject), only convertTicketToProject passes `linkedTicketId`. `convertTicketToProject` has no callers anywhere. `updateProjectMeta` cannot set it either — its patch type is limited to name/description/mocReference/targetCompletionDate/visibility. Therefore `projects.linked_ticket_id` is NULL for every row ever created by the application, and the conditional render at projects/[id]/page.tsx:308 is unreachable.

**Failure scenario.** A PM reads the project header looking for the request this project came from, sees no chip, and concludes no request exists — when in fact the system simply has no way to record one. Worse, the column's presence in schema.sql and in the Project type makes reviewers believe the link is implemented.

**Evidence.**

```
lib/projects.ts:112 — `linked_ticket_id: input.linkedTicketId || null,`
lib/projects.ts:803-811 — `const project = await createProject({ orgId: input.orgId, name: ticketTitle, description: ticketDescription, linkedTicketId: ticket.id as string, ... });`
app/(protected)/projects/[id]/page.tsx:308-312 — `{project.linkedTicketId && (<Link href={`/requests/${project.linkedTicketId}`} ...><Hash className="w-3 h-3" /> Linked ticket</Link>)}`
Searches for callers: `grep -rn "convertTicketToProject"` over .ts/.tsx (1 hit: the declaration), `git grep -n "convertTicketToProject"` (1 hit), and case-insensitive `grep -rni "convert.*to.*project|converttoproject|Convert to Project"` (3 hits, all inside lib/projects.ts itself).
```

**Chain reaction.** Anyone told "projects already link to tickets" will wire a project→requests view onto this NULL column and ship a view that is always empty.

> **Verifier correction.** Severity lowered to MEDIUM: this is a dead column and an unreachable UI chip. Nothing incorrect is displayed and no document-control decision depends on it — a missing feature, not a safety defect. HIGH overstates it.

**Done when.**

- [ ] Either `convertTicketToProject` is reachable from a UI affordance (e.g. a "Convert to project" action on the request detail page) and the project header chip renders, or the dead function and the unreachable chip are removed so the schema stops advertising a link that cannot be made
- [ ] if kept, `updateProjectMeta` (or an equivalent) can set/clear `linked_ticket_id` so a mislink is correctable

---
