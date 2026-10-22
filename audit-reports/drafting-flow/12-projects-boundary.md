# 12 · The Projects ↔ requests boundary

**14 findings** — 3 HIGH · 10 MEDIUM · 1 LOW.

Direct answer to the bidirectional-portal question, from the schema up.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded here. Severities marked by that pass override the original.


---


<a id="proj-1"></a>

## PROJ-1 · A request's approved deliverable never becomes a controlled document — the drafting flow writes no documents or document_versions rows at all

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. For a request raised against a controlled document, the approved Final can now be promoted through the existing publish path — roles-and-permissions [`LIFE-1`](../roles-and-permissions/07-document-lifecycle.md) / `GAP-6` (`a84f712`; migration `20261049` **applied & verified live 2026-09-02**): "Publish as revision of …" (`app/(protected)/requests/[id]/page.tsx:2165-2175`) pre-seeds `RevUpModal` with the Final file and runs `revUpDocument` — a real `document_versions` row, the review gate (`effectiveModeForRevUp`, no ticket waiver), supersession of the prior revision and the post-publish pipeline — and `publish_revision` writes `related_ticket_id` (`20261049`). For a request with no source document there is still no path, and requests carry no project.

**Done-when.**
- ✗ (in part) An approved Final *of a request with a source document* can be promoted through the publish contract (✓; not literally the intake route, but the same `publish_revision` contract and review gate). A request with no source document still ends at an attachment (✗).
- ✗ The promotion cannot upsert a `project_documents` row: `Ticket` has no `projectId` (`types/schema.ts` `Ticket`), so there is no project to reference.
- ✓ The promoted version records the request that produced it (`document_versions.related_ticket_id`, written by `20261049`'s `publish_revision`, verified by `/api/tickets/handback`).

**Scope / residual.** Promotion of a source-less deliverable ("publish as a new document in library X") → **DF-P4** (`GAP-105`, the ticket gets a library). The project reference on promotion → **DF-P8** (`GAP-114`; `DEC-40`: reference, never copy). The fleet plan named only DF-P4; the project half is DF-P8's by its own brief.

**Partial (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. The project half. `supabase/migrations/20261256_df_roundG_ticket_project.sql` adds `tickets.project_id` (nullable UUID → `projects(id)` ON DELETE SET NULL, partial index), an org-equality rail for every caller (23514) and a client limb (a signed-in member neither inserts nor changes it, 42501; the FK's own SET NULL passes), set only by the service role through `/api/tickets/create` and `/api/tickets/project-link` (`DEC-40`: one reference, no copy). `/api/tickets/handback` (`:230`) calls `lib/ticketProject.ts` `referenceDeliverableInProject` when a request that belongs to a project records a publication outside document review: an `ignoreDuplicates` upsert of a `project_documents` row (the shape "attach to project" writes — a reference to the controlled document, no bytes moved) and a `doc_added` feed row; a document already on the register is left as it is; a refusal is the answer's `warning`, the hand-back stands. `/api/tickets/project-link` does the same when a request with an already-published deliverable is linked later. *Corrected by fix pass 2 (below):* both routes write that row as the service role only when the register's own policy (`project_documents_insert`, `20261102`) would admit it. The project page lists the deliverable as a live reference (`components/projects/ProjectRequestsCard.tsx`, `lib/ticketProject.ts` `deliverableReference`).

**Done-when.**
- ✓ (in part, as recorded) Promotion through the register's own publish contract holds for every request shape since DF-P4 / DF-P15 (source document, target library, or neither — `DCW-4`). It is not literally the intake route; whether `publish_revision` satisfies the wording "the same path intake submissions use" is the integrator's ruling, so this finding is not flipped here.
- ✓ (in part — see fix pass 2) The promotion puts a `project_documents` reference on the request's project when the register's policy admits the person behind it: on the hand-back, when the request was put on the project with that authority (recorded) or the publisher holds it; on a later link, when the linker holds it. Otherwise no reference is written and the answer says a project manager attaches it from the project's Documents card.
- ✓ The promoted version records its request (`document_versions.related_ticket_id`, as recorded).

**Scope / residual.** (1) Done-when 1's wording → the integrator (ruling only; no code owed). (2) A deliverable published INTO document review is not put on the register when the review later completes — the completion runs in `lib/reviewControl.ts`, which this package may not edit; the project page still lists it ("In document review.") and a re-link writes the reference once it is published. Owner: the next holder of `lib/reviewControl.ts` (proposed: projects-joint).

**Fix pass 2 (2026-10-21, drafting-flow Round G — the second independent review).** The register reference was written as the service role for anyone who could reach the route, which goes around `project_documents_insert` (`20261102`: `is_org_controller(org_id) OR can_manage_project(project_id)`, in a visible project; `PM-8` / `SEC-17`). A requester who could only SEE a project could link their request to it and put its published deliverable on that project's register (and its CSV export, turnover and timeline) with a `doc_added` feed row. The same happened on the hand-back of a request filed "into" such a project. Now:
- `lib/ticketProject.ts` `callerHoldsRegisterAuthority` asks the policy's own functions (`is_org_controller`, `can_manage_project`) AS THE CALLER. A failed check is never read as a yes.
- `recordedRegisterAuthority` reads `metadata.project_link.registerAuthority`, which is workflow-owned (only the service role writes `metadata`; `20261250`'s `ticket_update_guard`). It counts only for the project it was recorded for.
- `/api/tickets/project-link` records `authority` and `registerAuthority` on the link and writes the reference only when the caller holds that authority.
- `/api/tickets/create` records the same. The project of a check-in or an intake collision is the server's own record, so it counts as held; a project named on the request form counts only when the caller manages it.
- `/api/tickets/handback` writes the reference when the recorded authority holds for the request's project or the publisher holds it.
- Otherwise nothing is written, and the answer says "a project manager can attach it from the project's Documents card".

Tests: `dfRoundG_P8_projects.test.ts` "REGRESSION (fix pass 2, PM-8 / SEC-17): a requester who can SEE a project but does not manage it …" (no `project_documents` call, no `doc_added`), "… who DOES manage the project (or a controller) …", and the hand-back describe "fix pass 2 (PM-8 / SEC-17) — /api/tickets/handback …" (three cases). `ticketCreateRoute.test.ts` "fix pass 2 (PM-8 / SEC-17): the link is recorded with whether the project register's policy admits who made it …". Still OPEN for the reasons above.

**Fix pass 3 (2026-10-21, drafting-flow Round G — the third independent review; corrects fix pass 2 where it overstated).** Fix pass 2's create-route bullet ("the project of a check-in or an intake collision is the server's own record, so it counts as held") broke its own rule: `/api/tickets/create` recorded `registerAuthority: true` for every intake collision and for every check-in whose checkout session named a project, without asking anything of the caller. A member who was neither a controller nor a manager of the project, but could read one of its intake sheets, could call the route directly with `origin: intake_collision`, and the hand-back would then write the register reference (and a `doc_added` row) as the service role — a write `project_documents_insert` refuses that member. Now:
- `resolveRequestProject` (`app/api/tickets/create/route.ts`) records the CALLER's own answer for every origin: the project is read AS THE CALLER (`project_visible_to_me`, as the policy requires) and `callerHoldsRegisterAuthority` is asked as the caller (`authorityAsCaller`). A check-in's or a collision's project is still the request's project (`PROJ-4`, `PROJ-12`); it is never authority over the register by itself.
- A server-derived project the caller cannot see keeps its reference on the request but records no authority, and the create route writes no `request_linked` feed row into it as the service role (`visibleToCaller`).
- The feed row that accompanies a landed reference is `doc_added` only when `project_activity_insert` would admit the actor for `doc_added` (`is_org_controller` or `is_project_owner`, asked as the caller — `lib/ticketProject.ts` `callerMayStampDocAdded`); a manager who is not the owner gets a `request_deliverable_referenced` row (`REQUEST_DELIVERABLE_REFERENCED`), in both the link route and the hand-back.
With this, done-when 2's sentence holds for every path: the service role writes the reference only when `project_documents_insert` would admit the linker (as recorded) or the publisher. Tests: `ticketCreateRoute.test.ts` "fix pass 3 (review, major): REGRESSION — a member who is neither a controller nor a manager … records registerAuthority false, so the hand-back writes nothing on the register" (asked as the caller; `recordedRegisterAuthority` answers false), "… a collision or a check-in on a project the caller cannot see …" (no authority, no feed row, the policy functions not even asked), "… a check-in by a caller who manages the checkout's project records registerAuthority true"; the fix-pass-2 case now expects `false` for a non-manager collision / check-in and `true` for a controller. `dfRoundG_P8_projects.test.ts` "fix pass 3 (review, minor): the feed row is doc_added only for an actor … (controller / owner)" plus the link and hand-back cases asserting `is_project_owner` is asked as the caller. Still OPEN for the reasons above.

**Pending migration:** `20261256` (DEC-30 one paste; deploy first, then paste — either order is safe: before the paste the app takes today's path — a request with no project, and no checkout session stamped with its request (the stamp waits for the paste: DEC-90 fix pass at the DF-P8 merge, `PROJ-10`); independent of every other migration).

*Assigned (2026-10-21, the integrator at the DF-P8 merge, DEC-31):* what remains (the deliverable referenced when its review completes, and the reading of done-when 1) → projects-joint **J21 DRAFTING-REQUEST PROJECT REMAINDERS** (after document-control P39, which holds `lib/reviewControl.ts`).

**Resolution (2026-10-22, projects-joint Round G).** J21 DRAFTING-REQUEST PROJECT REMAINDERS, under DEC-90's rulings (1) and (6) for J21. Reproduced on `693239d` first: `lib/reviewControl.ts` `finalizeReviewedRevision` promoted a request's reviewed deliverable and never touched the request's project (no `project_documents` write, no call into `lib/ticketProject.ts`), and the project's requests card read such a deliverable as "Superseded — the register is now at Rev …" while it was in review and "In document review." once its review had promoted it (`lib/ticketProject.ts` `deliverableReference`, the in-review flag read before the pointer). What landed:
- **The review completion references it.** `finalizeReviewedRevision` (`lib/reviewControl.ts:1197`), after the publish's own audit row, STARTS — never awaits — `referenceReviewedRequestDeliverable` (new `lib/reviewDeliverableReference.ts`). It reads the promoted version's `related_ticket_id` as the finalizer; no request, no call. Otherwise it asks the new `POST /api/projects/deliverable-reference` (`app/api/projects/deliverable-reference/route.ts`), which trusts only the ids. The route checks: the caller is an active member of the version's workspace; the version carries a request; the review COMPLETED (`documents.current_version_id` is this version); the caller is the one who completed it, just now — the promote names the caller (`documents.updated_by`, which `finalize_reviewed_promote` writes as `auth.uid()` and the three-step path as the actor; *the merge-time fix below removed the second qualifier, the caller's own `REVISION_PUBLISHED_AFTER_REVIEW` row*), else `not_finalizer`, AND the promote's own release stamp (`document_versions.released_at`) is at most `FINALIZER_WINDOW_MS` (10 minutes) old — outside it the miss is recorded and said, nothing written (*merge-time fix*) (*added by the fix pass below*); the request names a project (`tickets.project_id`; a 42703 / PGRST204 is "not pasted", nothing owed); no detach of this document from this project since the promote (`detached_since`, *fix pass*); and DF-P8's register policy answers yes — the authority recorded on the link (`recordedRegisterAuthority`), else the finalizer's own (`callerHoldsRegisterAuthority`, asked as the caller). Then it calls DF-P8's `referenceDeliverableInProject` as the service role: an `ignoreDuplicates` upsert, so a document already on the register is left as it is, plus the feed row (`doc_added` only for a controller / owner, else `request_deliverable_referenced`).
- **Fail-safe (ruling (1)).** The publish's answer and every write before it are unchanged. A transport failure or a 5xx is retried once. A reference not written for want of authority, an unconfirmable check or a refused write is RECORDED on the request's audit trail (`TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN`, checked; the `TICKET_` family; for a finalizer who can read the request) and SAID — to the new optional `onProjectReferenceNote` of `finalizeReviewedRevision`, else the console. *Fix pass:* no live caller passed `onProjectReferenceNote`, so on screen the miss was not said — `PROJ-14`. *Merge-time fix:* the review panel now passes it and shows the note, and the miss also lands as one line on the request's own history (its Audit Log tab) for a request not archived — `PROJ-14` RESOLVED. A request with no project, or a document no request produced, completes exactly as today (pinned).
- **The project's requests card reads it truthfully** (`lib/ticketProject.ts` `deliverableReference`; `components/projects/ProjectRequestsCard.tsx` reads `pending_version_id`). While the deliverable is the document's pending draft it reads "In document review — the register stays at Rev X until the review completes" (not current). Once promoted it reads "Current revision". Neither pending nor current reads "Not current — … (its document review closed without publishing it, or a later revision superseded it)". A deliverable published outside review reads exactly as before.
- **Done-when 1's wording — the integrator's reading, recorded (ruling (1)):** "the same path intake submissions use" means the same `project_documents` reference and the same register policy, NOT the intake upload route itself. Under that reading the promotion runs through the register's own publish contract for every request shape: `publish_revision`, the review gate and the supersession of the prior revision (DF-P4 / DF-P15, `DCW-4`). The project reference is the one row "attach to project" writes, by DF-P8's policy, on every path: the hand-back outside review, a later link, and now the review's completion.

Tests: `lib/__tests__/prjRoundGJ21ReviewControl.test.ts` covers the REGRESSION pins: a version no request produced publishes as before and never calls the route; the publish answers before a never-answering route, which is then asked with the document and promoted version; a warning is said to `onProjectReferenceNote`; the call is `void`, after the publish's audit row; and the helper's retry, unreachable-twice and no-session cases. `lib/__tests__/prjRoundGJ21DeliverableReferenceRoute.test.ts` covers 401 / 403 / 400 / 404; nothing owed for not_from_request, not_current, no_project and not_migrated; the recorded authority, the finalizer's authority with `doc_added`, no authority (recorded and said), an unconfirmable check, a document already on the register, and a refused write (503, recorded). `lib/__tests__/prjRoundGJ21ProjectRegister.test.ts` covers the card's three readings and the REGRESSION of the outside-review readings.

**Done-when.**
- ✓ An approved Final can be promoted into the controlled register: through the publish contract, the review gate and supersession for every request shape (DF-P4 / DF-P15), and "the same path intake submissions use" read as the same `project_documents` reference and register policy (the integrator's ruling, DEC-90 ruling (1) for J21).
- ✓ The promotion puts a `project_documents` reference on the request's project when the request carries one: on the hand-back, on a later link, and now when a review completes. Each is written only where the register's own policy admits the person behind it (DF-P8 fix passes 2 / 3, the ruled behaviour) — at the review's completion only for the finalizer the promote names, within minutes of the promote, and never over a detach since (fix pass; merge-time fix); otherwise nothing is written, and — unless the document is already on the register (read first; review round) — the miss is recorded on the request's audit trail and, for a request not archived, its history (the Audit Log tab), and said on screen to the finalizer (merge-time fix; `PROJ-14` resolved).
- ✓ The promoted version records its request (`document_versions.related_ticket_id`, as recorded).

**Fix pass (2026-10-22, projects-joint Round G — the package review).** (1) *Major — the route was a standing, replayable door.* It admitted any active member and its only check of the review was that `current_version_id` equals the posted version, which stays true for the life of the revision; with the link's recorded authority, any member who could read the document could make the service role write the register row at any time — including after the project owner deliberately detached it, a write `project_documents_insert` (`20261102:386-390`) refuses that member — and could write miss rows on requests they cannot read, learning from `no_project` / `referenced` whether such a request is on a project. Now the route is tied to the ACT: (a) only the finalizer, within `FINALIZER_WINDOW_MS` of the promote's `released_at` (the stamp both promote paths write; a browser clock off by minutes is absorbed by the window), named by the promote (`documents.updated_by`) or by their own `REVISION_PUBLISHED_AFTER_REVIEW` row for this version — else `not_finalizer`, nothing written, nothing recorded, no authority asked; a failed read of that row is 503, never a yes; (b) a detach of this document from this project dated after the promote — the register record's `PROJECT_DOCUMENT_DETACHED` row (`20261262`) or the Documents card's `doc_removed` feed row (before that paste) — answers `detached_since`, so a deliberate detach is never undone; (c) AUTHZ-13's `ticketReadScope` is asked as `/api/tickets/project-link` asks it: a caller outside the request's read scope gets `{ ok: true }` with no detail and nothing is recorded on the request (a server log line only). What still holds open: a member who can write `documents` could re-stamp `updated_by`, or any member could forge a `REVISION_PUBLISHED_AFTER_REVIEW` row, within the 10-minute window of a real promote — bounded by the window, by the recorded authority and by the detach check, and the forged row is itself on the audit trail. (2) *Minor:* the miss row's `user_role` is NULL (DEC-91: the route admits by membership, so no role is the one acted under — it was the headline `org_members.role`). (3) *Minor:* the register re-reads now read their error: a failed read before the write is "unknown" (the answer leaves `referenced` out — never a false `referenced: true`); a failed re-read after a refused write is said and NOT recorded as `write_refused`, and not retried. (4) *Minor (records):* the on-screen note is a remainder with a new id and an owner (`PROJ-14`, below), and the recovery sentence is corrected — the request page's "re-link" to the same project writes nothing (`/api/tickets/project-link` answers `unchanged: true`, `route.ts:132-133`). Tests: `lib/__tests__/prjRoundGJ21DeliverableReferenceRoute.test.ts` "J21 fix pass (review major 1): …" (a non-finalizer, a publish row for another version, a stale replay and a missing release stamp → `not_finalizer`; a failed read → 503; a post-detach replay by either record → `detached_since`; an older detach does not block; a Contractor-only finalizer outside the request's scope → no detail, no record; the same Contractor as requester → the full answer), "… user_role NULL …", "J21 fix pass (review minor): a failed register read is unknown …" (two cases).

**Merge-time fix (2026-10-22, the integrator's final review, DEC-90 rulings 1 / 2 / 5 — fail-safe).** (1) *The window refused a legitimate finalizer silently.* `released_at` comes from the finalizer's BROWSER clock on the three-step path (until `20261151` is pasted), so a finalizer with a skewed clock got `not_finalizer` and nothing anywhere. Now, when the promote names the caller (`documents.updated_by === caller`) but `released_at` is outside `FINALIZER_WINDOW_MS` (either direction) or missing, the route writes nothing to the register, records `TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN` with reason `outside_window` (caller in the request's read scope; AUTHZ-13 unchanged) and answers 200 with `warning` (`OUTSIDE_FINALIZER_WINDOW`, `route.ts:144`; the branch `:314`). A request with no project is still nothing owed. (2) *The second qualifier was forgeable.* `audit_logs_insert` admits a member's own row, so the caller's own `REVISION_PUBLISHED_AFTER_REVIEW` row proved nothing; the limb is removed — only `documents.updated_by === caller.id` qualifies (`route.ts:194`; both promote paths write it inside the promote: `20261151:261` / `:974`, `lib/reviewControl.ts:1413`), and no audit row is read to qualify anyone. (5) *"Said" on screen.* `components/documents/ReviewGateSection.tsx` passes `onProjectReferenceNote` to both `finalizeReviewedRevision` calls (`:260-261`) and shows the note as a status line when it settles (`data-testid="review-project-reference-note"`, `:331`; a note for a document the panel no longer shows is dropped); every miss the route records is ALSO one line on the request's own history — its Audit Log tab reads `tickets.history`, not `audit_logs` — but only for a request that is NOT archived and only when that write succeeds (*review round below*); one line per revision and reason (the page's retry adds none); its visible text names no project and no document number (ticket history is read by every reader of the request, DF-P8 fix pass 2), while the stored entry carries `projectId` / `documentId` / `versionId` (ids the same readers can already read on the request); it carries its audit row's id as `attempt` only when that row was written (`referenceMissHistoryEntry`, `route.ts:114`; `recordNotWritten`, `:238`); a history write that fails is logged and never changes the answer. Tests: `lib/__tests__/prjRoundGJ21DeliverableReferenceRoute.test.ts` "merge-time fix (ruling 2): a FORGED REVISION_PUBLISHED_AFTER_REVIEW row … does not qualify … the real finalizer … still does", "… no audit row is read to qualify the caller …", "merge-time fix (ruling 1): the finalizer the promote names, asking outside FINALIZER_WINDOW_MS … RECORDED (outside_window) and SAID …" (behind, ahead, missing stamp), "… outside the window, a request with no project is still nothing owed; a finalizer who cannot read the request … nothing is recorded", and the "merge-time fix (ruling 5) …" block (six cases: the line and its wording, each reason, outside-window / refused-write lines with no duplicate on the retry, the conflict retry, a failed history write, REGRESSION — no line when the reference lands or nothing is owed); `lib/__tests__/prjRoundGJ21ReviewGateProjectNote.test.ts` (rendered, five cases: the handler is passed and the call is otherwise unchanged; a miss settling after the publish shows as a status line without holding the publish up; nothing missed says nothing; shown beside the contractor notice; a note for another document is not shown). Pins updated for the added handler only: `sweepRoundD2.test.ts`, `dcRoundFReviewHoldForce.test.ts` (two `toEqual`s gain `onProjectReferenceNote: expect.any(Function)`).

**Review round (2026-10-22, the independent review of `fd0749b`, DEC-90 — fail-safe; all in the new history writer).** (1) *Major — archived requests.* The line was written onto archived requests, which every other `history` / `last_modified` writer refuses (`20260810_archive_invariants`: an archived stub is immutable; a restore would lose the line and its compare-and-set could fail). The route now reads `archived_at` and, when set, writes NO history line (the audit row is still written, without `historyAttempt`); the append itself is guarded on `archived_at IS NULL`, and a request archived meanwhile is left alone. (2) *Major (DEC-29) — a miss recorded for a document already on the register.* The outside-window and no-authority branches recorded a miss before asking whether the document was ALREADY on the request's project register (common: a later revision of a drawing already there). The register is now read for (project, document) BEFORE anything is recorded (`route.ts:222`, step 5b): present → `already_referenced`, nothing recorded, no warning, no authority asked; the read fails → `REGISTER_PRESENCE_UNCONFIRMED` is said ("could not be confirmed") and NO miss is recorded (the write path still goes on, as before, and leaves `referenced` out). (3) *Minor:* the line's action is the shared `DELIVERABLE_REFERENCE_MISS_HISTORY_ACTION` (`lib/ticketAttention.ts`), listed in `NON_STEP_HISTORY_ACTIONS`, so the request's "waiting since" clock is not reset by it. (4) *Minor — ruling, DEC-90 ruling (4)'s precedent (`lib/consentWindowScan.ts`):* the append is bookkeeping and does NOT change `last_modified` (compare-and-set on the value read, read again and tried once more on a conflict), so nobody's concurrent action turns into a 409. **Residual, accepted:** a concurrent whole-array `history` write by another route (one that read the array before this append) may drop the line; the `TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN` audit row stays the durable record. (5) *Minor (DEC-29):* when the audit insert fails the line carries no `attempt` (it never names a row that does not exist); a retry whose line is already there writes its audit row without `historyAttempt`. (6) *Nit:* an outside-window replay writes no second audit row — the miss already recorded is named (and its line written if it is missing). Tests: `prjRoundGJ21DeliverableReferenceRoute.test.ts` "J21 review round (DEC-90): the history writer — …" (ten cases: archived; archived meanwhile; already on the register outside the window; already on it without / with unconfirmed authority; the register unreadable on each branch; no `attempt` when the audit row failed; no `historyAttempt` on a deduplicated retry; no second outside-window row; a replay naming the prior row; the NON_STEP line and the clock), and the ruling-5 case now pins `last_modified` unchanged and `history` as the only column written.

What still holds open after the merge-time fix: a member who can write `documents.updated_by` (if any path lets them stamp it to themselves) could, within 10 minutes of a real promote, make the route act for them — bounded by the window, the recorded authority and the detach check; outside the window it only records a miss.

**Scope / residual.** (1) ~~The on-screen half of "said"~~ — closed by the merge-time fix (`PROJ-14` RESOLVED). (2) If the call is lost entirely — the route unreachable on both tries, or the page closed before the POST went out (it is sent `keepalive`, so a page closed after it went out still has the miss recorded on the request; only the on-screen note is lost) — that one reference is lost: nothing on the server can record a request it never received. A finalizer whose stamp is outside the window is no longer in this residual: that miss is recorded and said (merge-time fix). A project manager recovers it by attaching the document from the project's Documents card, or by unlinking the request from the project and linking it again (the link writes the reference for a linker who holds the register authority); re-linking to the same project writes nothing. This is the P39 precedent for a lost browser post (DEC-90 ruling (d) at the P39 merge). (3) The request's `metadata.deliverable.in_review` flag is the hand-back's record and is not rewritten at the review's completion (the card reads the pointers instead; the ticket is workflow-owned).

**Pending migration:** `20261256` only (a request has no project before it — then nothing is owed, today's path). J21's `20261262` is not needed for this limb. `20261151` pending is why `released_at` can come from the browser (the three-step path); the window miss is recorded and said either way.

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
- **Status:** RESOLVED
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS; corrected by fix pass 2 (the first version of this block wrongly said the org-wide policy was still in place). Re-verified on `db3a1f3`: the policy and trigger limbs were closed by projects-and-cost `PM-8` / projects-tab `SEC-17` (both RESOLVED; they name this finding as closing by pointer) in `supabase/migrations/20261102_prj_roundG_project_rails.sql` section 4 (`:377` on). That section drops `project_documents_member_all` (`:378`). It scopes SELECT to `project_visible_to_me(project_id)` (`:380-383`). INSERT and UPDATE are narrowed to `is_org_controller(org_id) OR can_manage_project(project_id)`, with `org_id = project_org(project_id)` and visibility (`:385-398`). DELETE is narrowed to the controller or the active owner (`:420-423`). A link never moves (`enforce_project_document_link_fixed`, `:400-418`). `checkouts_resync_project_documents` is re-created SECURITY DEFINER with `search_path` pinned (`:425-430` and on): a collaborator's checkout still links its document, and a signed-in caller links only their own session into a project they can see. DF-P8's own register write (`lib/ticketProject.ts` `referenceDeliverableInProject`, run as the service role) now goes only where that policy would admit the person behind it (`PROJ-1`'s fix pass 2).

**Done-when.**
- ✓ SELECT honours project visibility; INSERT / DELETE narrowed to controllers, the project owner or the project's managers (`20261102:378-423`, by pointer to `PM-8` / `SEC-17`; the INSERT follows the fleet plan's `can_manage_project`, `DEC-54` item 6).
- ✗ An `audit_logs` row written server-side for an attach / detach. `PM-8` accepted, as its own done-when 4, a `doc_added` / `doc_removed` feed row that the actor cannot forge: the author is stamped by the database and the types are gated to the register's authority (`20261102:317-324`, `project_activity_insert`). But that row is written by the client (`ProjectDocumentsCard` `writeActivity`), and no `audit_logs` row is written on either path. So an attach or detach that the policy admits, made by direct API call, leaves no record. Not done. Owner: projects-and-cost (proposed: the next projects-joint package), with an AFTER INSERT / DELETE trigger on `project_documents` or a server route for the card.
- ✓ The checkout trigger's inserts still succeed under the narrowed policy (SECURITY DEFINER, pinned; `20261102:425-430` and on, by pointer to `PM-8` dw3 / `SEC-17`).

**Scope / residual.** Only done-when 2, the server-side attach / detach audit row, remains → projects-and-cost (proposed projects-joint). Stays OPEN for that limb alone.

**Pending migration:** none for this limb (it works before and after `20261256`).

*Assigned (2026-10-21, the integrator at the DF-P8 merge, DEC-31):* done-when 2 (a server-side audit row for every attach / detach) → projects-joint **J21 DRAFTING-REQUEST PROJECT REMAINDERS**.

**Resolution (2026-10-22, projects-joint Round G).** J21, DEC-90 ruling (2). Reproduced on `693239d`: no `audit_logs` row on any attach or detach. The Documents card (`components/projects/ProjectDocumentsCard.tsx`) writes only the `doc_added` / `doc_removed` feed row. The checkout resync, the intake door, adoption and DF-P8's routes write none, and a direct API call writes nothing at all. What landed: `supabase/migrations/20261262_prj_roundG_project_register_record.sql` §(1) adds a NEW AFTER INSERT OR DELETE trigger `trg_project_documents_record_link` → `project_documents_record_link_change()` (SECURITY DEFINER, `search_path` pinned, EXECUTE revoked from PUBLIC / anon / authenticated — DRLS-16; a `trigger-only` row in `lib/__tests__/rls/definerDecisions.ts`):
- Every attach writes `PROJECT_DOCUMENT_ATTACHED`, and every detach `PROJECT_DOCUMENT_DETACHED`, whichever door made it. The row is `resource_type 'project'`, `resource_id` the project, so it is read under 20261142's project rule. `details` holds `projectId`, `documentId`, `documentNumber`, `linkId`, `source` and `recordedBy: 'database'`.
- The actor is the signed-in caller when they are an active member of the row's workspace (20261201's stamp names them). Otherwise `user_id` is NULL: the service role is `system`, and a non-member caller's uid (the intake door's link identity) goes in `details.actorUid`.
- The row is written in the attach / detach's OWN transaction (checked: no attach without its row). Every attach and detach that lands today still lands, and what the policy refused is still refused, with nothing written.
- A repeat that changes nothing (ON CONFLICT DO NOTHING / DO UPDATE) writes nothing. A cascade from the workspace's, project's or document's own deletion writes nothing, and the deletion still succeeds.
- `lib/timeline.ts` classifies both actions `mirrored` (the card's feed row already shows the fact on the project timeline) and gives them readable summaries; both fall in `lib/auditActions.ts`'s `PROJECT_` family.

Exercised on PostgreSQL 16 (`lib/__tests__/rls/j21ProjectRegisterRecord.test.ts`, the full replay plus the file pasted again): the owner's attach / detach through the card, one row each, naming the owner as `member`. A viewer's refused insert (42501) records nothing. The service role's row is `system`; a DO NOTHING repeat adds none. A checkout under the project links as before, with one row naming the member and `source checkout`, and a re-checkout adds none. Deleting a document, the project or a whole workspace cascades as before with no detach row. The definer census and the fresh replay are green.

**Done-when.**
- ✓ SELECT honours project visibility; INSERT / DELETE narrowed (`20261102:378-423`, by pointer to `PM-8` / `SEC-17`, as recorded).
- ✓ Attach / detach writes an `audit_logs` row server-side — by the database, for every door, a direct API call included, and a service-role move of a link as a detach plus an attach (merge-time fix) — not only a client-written feed row (`20261262` §(1); pending paste).
- ✓ The checkout trigger's inserts still succeed under the narrowed policy (as recorded; re-proved with the new trigger in place).

**Merge-time fix (2026-10-22, the integrator's final review, DEC-90 ruling 3).** As first landed the trigger fired AFTER INSERT OR DELETE only, so a service-role UPDATE moving a link's `project_id` / `document_id` (admitted by `20261102`'s `enforce_project_document_link_fixed` when `auth.uid() IS NULL`) wrote nothing. Now `trg_project_documents_record_link` fires AFTER INSERT OR DELETE OR UPDATE OF project_id, document_id (`20261262:320-321`): an UPDATE whose ids changed writes `PROJECT_DOCUMENT_DETACHED` for the OLD pair and `PROJECT_DOCUMENT_ATTACHED` for the NEW (both carry `details.moved: true`), in that order, in the move's own transaction; an UPDATE changing neither id (a `last_seen_at` touch, a SET of the same ids) writes nothing; the cascade guard is applied per side. Probes 2·1 and 2·2 reworded and extended. PostgreSQL 16 (`j21ProjectRegisterRecord.test.ts`): "PROJ-3 dw2 (merge-time fix, ruling 3): a service-role UPDATE moving a link to another project writes DETACHED on the old project and ATTACHED on the new; moving its document likewise; an UPDATE changing neither id writes nothing", and "REGRESSION (ruling 3): a member's move of a link is still refused by 20261102 … and records nothing".

**Scope / residual.** None in this finding. A restore that re-inserts register rows writes attach rows dated at the restore (truthful — the rows were re-created then).

**Pending migration:** `20261262` (DEC-30 one paste; after `20261104` — it refuses to run, changing nothing, without `documents.authored_by_link_id`; deploy the J21 app first, then paste — either order is safe for every flow: before the paste nothing is recorded, today's path).

---

<a id="proj-4"></a>

## PROJ-4 · CheckInPanel discards the project id it is already holding when it creates a drafting request from a project checkout

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. `supabase/migrations/20261256_df_roundG_ticket_project.sql` adds `tickets.project_id` (nullable UUID → `projects(id)` ON DELETE SET NULL, partial index), an org-equality rail for every caller (23514) and a client limb (a signed-in member neither inserts nor changes it, 42501; the FK's own SET NULL passes), set only by the service role through `/api/tickets/create` and `/api/tickets/project-link` (`DEC-40`: one reference, no copy). `components/documents/CheckInPanel.tsx:338` sends `projectId: mySession.projectId ?? null`; `/api/tickets/create` `resolveRequestProject` (`:1022`, called at `:518`) does not trust it: for a check-in it reads the caller's OWN checkout session and takes that session's project (and id); for a portal request the project is read through the caller's client (visible, same org, not closed — otherwise dropped with a warning); for an intake collision the origin's project. The row carries `project_id` (`insertTicketRow`, `:809`, retried without the column before the paste with a warning), a `request_linked` feed row follows, and the session is stamped (`PROJ-10`; once `20261256` is applied — before it nothing is stamped, DEC-90 fix pass at the merge).

**Done-when.**
- ✓ The check-in ticket records the originating project as a real column (`tickets.project_id`). Tests: `lib/__tests__/ticketCreateRoute.test.ts` "DF-P8 — a request filed into a project names it BY REFERENCE" (6 cases: the request form's visible project written with one feed row (REGRESSION: none → none); an unknown / malformed / foreign / closed project dropped with a warning; "PROJ-4 / PROJ-10: a check-in takes the project of the requester's OWN checkout session (whatever the body says) and stamps that session"; the ad-hoc check-in REGRESSION; the collision's verified project; before 20261256).
- ✓ The `metadata.source_document` sibling path has the same single shape: every creation path writes `tickets.project_id`; a project→requests query is one `eq("project_id", …)` (`lib/projectSnapshot.ts`, `ProjectRequestsCard`).

**Scope / residual.** None. A request with no project is filed exactly as before (DEC-90 ruling (1) for DF-P8).

**Pending migration:** `20261256` (DEC-30 one paste; deploy first, then paste — either order is safe: before the paste the app takes today's path — a request with no project, and no checkout session stamped with its request (the stamp waits for the paste: DEC-90 fix pass at the DF-P8 merge, `PROJ-10`); independent of every other migration).


**Fix pass (2026-10-21, drafting-flow Round G — the independent review).** `lib/ticketProject.ts` `isMissingProjectColumn` matched a 42703 / PGRST204 with an EMPTY message, so in `insertTicketRow` a different missing column answered without a message (the library, a declaration column) dropped a project already confirmed and blamed `20261256`. It now matches only an answer naming `project_id`, as `missingLibraryColumn` / `isMissingReviewModelColumn` do (test: `dfRoundG_P8_projects.test.ts` "isMissingProjectColumn …"). DEC-90 ruling (1) is now pinned across every status: `lib/__tests__/helpers/noProjectTransitionMatrix.ts` walks every TicketStatus × role × identity × offered action for a row with `project_id` null and no archive claim, and its digests equal `lib/__tests__/fixtures/dfP8NoProjectBaseline.json`, generated by the same helper at the base commit `db3a1f3` (1,158 transitions; no update writes `project_id` or `archive_id`); the workflow route's SM-7 `attempt` stamp is added after `computeTransition` and is not in those updates.
---

<a id="proj-5"></a>

## PROJ-5 · Intake-uploaded documents never get a project_documents row, so the project has two disjoint definitions of "its documents"

- **Severity:** LOW
- **Status:** RESOLVED
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. Re-verified on `db3a1f3`: the intake door already references what it creates (`app/api/intake/upload/route.ts:2082-2097`, `project_documents` upsert, J1 / SEC-22) — so the two definitions now meet — but it writes `source: "manual"` (the column's CHECK admits only `checkout` / `manual`, `20260609`). `lib/projects.ts` `listProjectDocuments` marks a register row whose document still sits in the project's intake folder (`inIntakeFolder`, `:956`), and `components/projects/ProjectDocumentsCard.tsx:239-242` badges it "in intake — not adopted".

**Done-when.**
- ✓ (in part) the door upserts a `project_documents` row at creation (J1); ✗ a source value distinguishing intake — needs a CHECK widening on a projects-model table this fleet does not own.
- ✓ the Documents card badges intake rows distinctly (by folder, not by source).
- ✓ (in part) the CSV export lists them (they are `project_documents` rows); ✗ the project timeline is not checked or changed here.

**Scope / residual.** A `source = 'intake'` value (CHECK widening + the door's write) and the timeline → owner: projects-joint (projects-and-cost / intake area, no fleet plan yet). Stays OPEN.

**Pending migration:** none for this limb (it works before and after `20261256`).

*Assigned (2026-10-21, the integrator at the DF-P8 merge, DEC-31):* the source='intake' value and the timeline → projects-joint **J21 DRAFTING-REQUEST PROJECT REMAINDERS**.

**Resolution (2026-10-22, projects-joint Round G).** J21, DEC-90 ruling (3). Reproduced on `693239d`: the intake door's reference is written `source 'manual'` on both of its paths (`intake_door_housekeep` 'reference', `20261214:639`, and the service-role fallback, `app/api/intake/upload/route.ts:2099`), because the column's CHECK admits only `checkout` / `manual` (`20260609:73`). What landed:
- `supabase/migrations/20261262_prj_roundG_project_register_record.sql` §(2) widens the CHECK to `('checkout', 'manual', 'intake')` — inventory first, counts only; existing values kept, no row rewritten. A NEW BEFORE INSERT OR UPDATE OF source trigger `trg_project_documents_intake_source` → `project_documents_intake_source()` (SECURITY DEFINER, pinned, revoked) writes `'intake'` for a `'manual'` reference written BY THE DOOR — no active member of the workspace behind the write (the door's link identity, or the service role of its fallback) — to a document THE DOOR CREATED (`documents.authored_by_link_id` set: the stored intake-born fact, `20261104`, which no signed-in session can stamp once `20261141` is in) that sits in THE PROJECT'S OWN intake folder (`projects.intake_collection_id`). That covers the door's reference at the moment it creates the document, on both of its paths — with no edit to the door's files. A member's attach — a sheet filed by hand into the intake folder, or even the door's own sheet attached from the card — stays `'manual'`, so the badge and the attach row never say the intake link did what a member did (*narrowed by the fix pass below*). An `'intake'` row keeps `'intake'` when the adoption's later `'manual'` upsert (or a re-attach) would rewrite it; the trigger never writes `'checkout'` or turns one into anything (a card re-attach over a checkout row turns it `'manual'`, exactly as today).
- `lib/projects.ts` `listProjectDocuments` reads a linked `'intake'` row as `source: "intake"` with its link (it would have read "checkout"). `components/projects/ProjectDocumentsCard.tsx` (`sourceBadgeKey`) badges it "from intake", beside the existing "in intake — not adopted" folder badge; an unlinked approved intake document keeps "approved intake".
- The project timeline: an intake document's version events reach it through its register reference (J1). Its adoption — the `TRANSITION_IN` row `adoptDocument` / `adopt_intake_document` write on the document — now reads "Adopted from the project's intake into the controlled register as <number>" (`lib/timeline.ts` `summarizeAudit`; it read "transition in").

Exercised on PostgreSQL 16 (`lib/__tests__/rls/j21ProjectRegisterRecord.test.ts`): the door-shaped write (service role, a door-created sheet) reads `intake`; the adoption's upsert after the move keeps `intake`, with no second attach row; a document outside the folder stays `manual`; `checkout` stays `checkout` until the card re-attaches it, which turns it `manual` exactly as today, a hand-filed sheet in the intake folder included; a member's attach of a hand-filed sheet or of the door's own sheet stays `manual` and its attach row says `manual`; a service-role write of a hand-filed sheet stays `manual`; an unknown value is refused (23514). Unit: `lib/__tests__/prjRoundGJ21ProjectRegister.test.ts` (the narrowed limb, the prerequisite guard).

**Fix pass (2026-10-22, projects-joint Round G — the package review).** *Major:* as first landed, the trigger's only test was the folder, so every `'manual'` reference to a document sitting in the project's intake folder became `'intake'` — including Document Control's hand-filed vendor sheet attached from the Documents card by the owner — and the card then said "from intake — put on the register by the project's contractor intake link, which created the document" while the attach row read "(by the intake link)" with the owner as actor: both false, on an evidence record. Now the INSERT limb also requires `d.authored_by_link_id IS NOT NULL` and that no active member of the workspace is writing (`20261262` §(2); probe 4 and inventory row 5 reworded; the file refuses to run without `documents.authored_by_link_id`, i.e. before `20261104`). *Minor:* the PostgreSQL 16 case that claimed "a checkout row stays checkout when the card re-attaches it as manual (today's behaviour)" while proving it became `intake` is retitled and now proves today's behaviour (checkout → manual) for a hand-filed sheet in the intake folder.

**Merge-time fix (2026-10-22, the integrator's final review, DEC-90 ruling 4).** The fix pass's INSERT limb treated ANY write with no active member behind it as the door, so a restore, or DF-P8's server-side `referenceDeliverableInProject` (service role) of a door-created sheet still in the intake folder, turned `'manual'` into `'intake'`. Now `'intake'` is written only when the writer IS the door (`20261262` §(2), `:168` on): (a) its bound identity — `auth.uid()` names a `project_intake_links` row OF THIS PROJECT (`intake_door_housekeep` 'reference', which binds the link's id as the session's uid; `:197`); or (b) the intake upload route's service-role fallback naming itself — the request header `x-mos-intake-door-reference: on`, which PostgREST sets transaction-locally in `request.headers`, honoured only for the service role with no signed-in uid (`:206`); AND the document is one THAT link created (`authored_by_link_id` names a link of this project) in the project's own intake folder. The one app change: `app/api/intake/upload/route.ts:2107` sends the header on its fallback upsert (`.setHeader`, the `withIssueDoor` precedent); no other app / lib / component file names it (pinned). Before `20261262` nothing reads the header. Every other writer keeps the value it sends. (The ruling's example was a `set_config('app.…', 'on', true)` setting; a supabase-js REST write cannot set an arbitrary setting in its own transaction, so the transaction-local setting used is PostgREST's own `request.headers` — the same mechanism `20261205` reads for `x-mos-issue-door`.) Probe 1·4 reworded. PostgreSQL 16 (`j21ProjectRegisterRecord.test.ts`): the door's own reference through `intake_door_housekeep` 'reference' reads `intake`; "PROJ-5 (merge-time fix, ruling 4): the upload route's service-role fallback naming itself … writes 'intake'; the SAME write without the header — DF-P8's server-side referenceDeliverableInProject … — stays 'manual'" (also: another header value, and the header from a member, stay `manual`); "… the door's header for a sheet ANOTHER project's link created, or a sheet no link of this project created, stays 'manual'; a link identity writing for another project is not this project's door"; "… a restore reproduces the backed-up value — an 'intake' row comes back 'intake', a 'manual' row of the door's own sheet comes back 'manual'" (service role and a superuser SQL restore). Unit: `prjRoundGJ21ProjectRegister.test.ts` (the limb's text; the header's single sender).

**Done-when.**
- ✓ The door upserts a `project_documents` row at creation (J1), and it now reads `source = 'intake'`, distinct from checkout / manual (`20261262` §(2); pending paste) — written `'intake'` only by the door itself (merge-time fix).
- ✓ The Documents card badges intake rows distinctly: "from intake" by source, and "in intake — not adopted" by folder, so a PM tells adopted from not-yet-adopted.
- ✓ The project timeline and the CSV export include them: CSV as register rows (as recorded); the timeline through the reference — version events plus the adoption entry.

**Scope / residual.** Rows written before the paste keep `'manual'` (the inventory counts the door-created ones still in an intake folder); no later write turns a `'manual'` row into `'intake'`, and a backfill was not ruled. A door reference written by the upload route's fallback through a client without per-request headers would read `'manual'` (supabase-js 2.x carries `setHeader`; pinned at the source). Before the paste, the J21 app reads exactly as today. Deploy first: an app older than J21 would read an `'intake'` row as "via checkout".

**Pending migration:** `20261262` (DEC-30 one paste; after `20261104`, which it refuses to run without; deploy the J21 app first, then paste).

---

<a id="proj-6"></a>

## PROJ-6 · Project completion has no open-drafting-request gate and structurally cannot have one — the closeout snapshot never queries tickets

- **Severity:** LOW
- **Status:** RESOLVED
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

**Resolution (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. `lib/projectSnapshot.ts` counts the project's open drafting requests by reference (`:281-321`: `tickets` `project_id = …`, not archived, status not in `TERMINAL_TICKET_STATUSES`; counted, never listed, as the viewer reads them; `undefined` before the paste, `null` on a failed read) into `ProjectStateSnapshot.openDraftingRequests` (`lib/projectHealth.ts`). `lib/projects.ts` `closeoutGateLines` (`:408-420`) adds a `draftingRequests` line — a warning like every other gate (warnings, not walls); unknown when the read failed, never clear; not shown before the paste (today's dialog).

**Done-when.**
- ✓ The snapshot counts open drafting requests and a closeout gate reports them. Test: `dfRoundG_P8_projects.test.ts` "PROJ-6: the closeout gates gain an 'open drafting requests' WARNING line".
- ✓ The count reaches the generated closeout report: the gates recorded at completion (`lib/projects.ts:514`) are what `lib/projectReport.ts:212` renders.
- ✓ Completing with open requests writes the line, with its `openCount`, into the `PROJECT_COMPLETED` audit details (the same `gates` array).

**Scope / residual.** None.

**Pending migration:** `20261256` (DEC-30 one paste; deploy first, then paste — either order is safe: before the paste the app takes today's path — a request with no project, and no checkout session stamped with its request (the stamp waits for the paste: DEC-90 fix pass at the DF-P8 merge, `PROJ-10`); independent of every other migration).


**Fix pass (2026-10-21, drafting-flow Round G — the independent review).** The count is read as the viewer, so a completer under AUTHZ-13's narrower ticket scope (Contractor-only, `20261166`) counted only the requests they could see and the gate recorded "No open drafting requests" (`ok: true`) in the `PROJECT_COMPLETED` gates and the report when it did not know that. Now `lib/projectSnapshot.ts` asks whether the viewer reads every request of the workspace (`viewerReadsEveryRequest`: their own `org_members` row, `isContractorOnly` from `lib/ticketReadScope.ts`; a refused read or no session answers no) and marks a partial count `openDraftingRequestsVisibleOnly` (`lib/projectHealth.ts`); `closeoutGateLines` then never says clear — none visible is unknown (`ok: null`, "Drafting requests — only those visible to you counted (none of them open)"), some visible is "At least N … still open — only those visible to you counted" (`ok: false`, `openCount: null`). A completer who reads every request gets the whole count exactly as before. Tests: `dfRoundG_P8_projects.test.ts` "PROJ-6 fix pass (minor 3)"; `dfRoundG_P8_projectsFixPass.test.ts` "PROJ-6 fix pass …" (whole count; Contractor-only; unconfirmed scope; no scope read before the paste or after a failed count). Residual: a restricted completer still cannot learn the whole count (no SECURITY DEFINER count was added — a migration change this pass did not take); the line says so instead.

**Fix pass 4 (2026-10-21, drafting-flow Round G — the fourth independent review).** `lib/projectSnapshot.ts` read ANY 42703 / PGRST204 on the open-requests count as "20261256 not pasted" (`MISSING_COLUMN.has(code)` → `undefined`), so a different missing column made the gate line vanish instead of reading "could not be read". It now uses `isMissingProjectColumn` (`lib/ticketProject.ts`): only an answer naming `project_id` drops the line; any other refusal is `openDraftingRequests: null` ("Drafting requests — could not be read"). Test: `dfRoundG_P8_projectsFixPass.test.ts` "before 20261256 (42703) no line …" (now also: a 42703 naming another column and a bare PGRST204 read "could not be read"; a PGRST204 naming `project_id` still drops the line).
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. Not edited: `lib/orgGraph.ts` belongs to intelligence (fleet plan: "PROJ-7 closes by pointer to intelligence WIRE-4 / WIRE-7"). What changed under it: the project reference done-when 2 waited for now exists (`tickets.project_id`, `20261256`), so a project↔ticket edge can be drawn from real rows.

**Done-when.**
- ✗ ticket node type and document↔ticket edge — owner: intelligence `WIRE-4` / `WIRE-7`.
- ✗ project↔ticket edge from `tickets.project_id` — owner: intelligence (now unblocked).
- ✗ caps and truncation — owner: intelligence.

**Scope / residual.** All three → intelligence (`lib/orgGraph.ts`; no fleet plan yet). Stays OPEN.

**Pending migration:** none for this limb (it works before and after `20261256`).

*Assigned (2026-10-21, the integrator at the DF-P8 merge, DEC-31):* the request ↔ project edge in `lib/orgGraph.ts` (unblocked by `tickets.project_id`) → drafting-flow **DF-P23 TRANSITION RECORD AND RECONCILE** (intelligence's file, declared).

**Partial (2026-10-22, drafting-flow Round G).** DF-P23 TRANSITION RECORD AND RECONCILE — the request ↔ project edge assigned at the DF-P8 merge (`lib/orgGraph.ts`, intelligence's file, declared under the package's files outside its plan). Reproduced on `87f415e`: no read of `tickets` anywhere in `lib/orgGraph.ts`.

Landed (`lib/orgGraph.ts`):
- `readProjectRequests` (`:851`) reads the requests that belong to a project (`tickets.project_id`, `20261256`), keyset-paged to `EDGE_CAP` like every link table, archived requests left out, a cap said (`cappedNote("Project request links", …)`), a read that fails said as a note, and — before `20261256` (42703 / PGRST204) — nothing drawn, silently, as for any pre-migration table. It is read as the reader (RLS: a request they cannot read is not drawn) and only by the client entry (`:780`, `gate === null`): the server entry's gate speaks for documents, never for a request's read scope.
- A request is folded into the PROJECT class (`req:<uuid>`, label "<number> · <title>", sub "Drafting request · <status>", link `/requests/<id>`, `:1178`) — no new node type, the same decision that folds a system into the unit class (DEC-67, provisional; intelligence `WIRE-4` is WONTFIX on new node types) — with a `project` edge from its project (`:1295`, note "Drafting request on this project"). A request whose project is not on the map draws no edge (`addEdge` counts it as a link that leaves the map) and its lone node is pruned like any unlinked project-class node.

Tests: `lib/__tests__/dfRoundG_P23_followUps.test.ts` ("PROJ-7 — …": node, edge and link; the off-map request; REGRESSION — a map with no project requests is byte-identical; the read's shape pinned); the graph suites (`orgGraph.test.ts`, `graph*.test.ts`, `intelRoundGGraph*.test.ts`) unchanged and passing.

**Done-when.**
- ✗ (1) a ticket node TYPE and a document ↔ ticket edge from the source_document link — not done: DEC-67's plan default (no node type beyond the seven; `WIRE-4` WONTFIX) keeps the type closed, so DF-P23 folds requests into the project class, which is not a type of their own; and the document ↔ request link lives in `tickets.metadata.source_document` (JSON, not a relationship row — the module's header draws only rows).
- ✓ (2) once a project reference exists (`tickets.project_id`), a project ↔ request edge is drawn from those real rows.
- ✓ (3) for that edge source: capped at `EDGE_CAP`, the cap reported like every other edge source.

**Scope / residual.** Done-when 1 → intelligence / the integrator (DEC-31): a ruling under DEC-67 on whether requests become a node type (or stay folded) and whether the document ↔ request link (a JSON reference, not a row) may be drawn; proposed: keep the fold and draw the document ↔ request edge from `metadata.source_document.id` once a requests-on-documents relation exists as rows (none today). **Pending migration:** none for this limb (it works before and after `20261256`). Stays OPEN on done-when 1.

---

<a id="proj-8"></a>

## PROJ-8 · The project document register accepts Superseded and Archived documents with no guard and no warning

- **Severity:** LOW
- **Status:** RESOLVED
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

**Resolution (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. `components/projects/ProjectDocumentsCard.tsx`: the attach picker selects `status` and `archived_at`, hides a Superseded / Void / Archived match by default (`NOT_CURRENT_STATUSES`, `:198`) behind a "Show N superseded / void / archived matches (not current)" checkbox, and labels one shown "<status> — not current" before the click (`:206`). `lib/projectExport.ts` adds a `Current` column (`NOT CURRENT` / `yes`, `archived_at` now selected).

**Done-when.**
- ✓ The picker selects status and excludes non-current matches by default, labelling them when shown.
- ✓ An attached row in a non-current status renders as an amber "Not current" warning with a struck-through label (`:229-237`, present since DEC-40's tab work; re-verified).
- ✓ The CSV export marks non-current documents. Test: `dfRoundG_P8_projects.test.ts` "PROJ-8: the attach picker hides superseded / void / archived matches by default …".

**Scope / residual.** None. The picker still allows a deliberate attach of a non-current document (it is shown, labelled) — a warning, not a wall.

**Pending migration:** none for this limb (it works before and after `20261256`).

---

<a id="proj-9"></a>

## PROJ-9 · The request detail page renders none of the metadata that carries its links — source document, custom categories and the intake-collision project are all write-only

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE. The source document already renders as a card with "Open in register" (LIFE-13, re-verified). What the form collected and the project link now render after the Scope of Work (`app/(protected)/requests/[id]/page.tsx`:2447, :2457): `lib/ticketPage.ts` `customCategorySections` (:199) turns `metadata.custom_categories[categoryId][fieldKey]` into labelled sections — the workspace's configured category and field labels (read with the drafting configuration the page already loads), option values shown as their labels, booleans as Yes / No, and an answer whose question was renamed or removed still shown under its key in words, never hidden. `projectRefOf` (:224) reads the project a request is linked to (`metadata.intake_collision.projectId` — the only project reference a ticket carries until DF-P8 writes `tickets.project_id`), rendered as a link to `/projects/<id>`, by name when the viewer can read the project (an RLS read), else "Open the linked project".

**Done-when.**
- ✓ `metadata.source_document` renders as a link (existing card) and `metadata.custom_categories` as labelled fields — `lib/__tests__/dfRoundG_P9_ticketPage.test.ts` "PROJ-9 — the request's write-only metadata is rendered"; `lib/__tests__/dfRoundG_P9_ticketDetail.test.ts` "PROJ-9 / FRIC-3 — what the form collected, the project, the unit" (rendered).
- ✓ A project reference renders as a link to the project (same tests).

**Scope / residual.** When DF-P8 adds `tickets.project_id`, `projectRefOf` reads that column first (one line).

---

<a id="proj-10"></a>

## PROJ-10 · checkout_sessions.linked_ticket_id is a live FK to tickets that no code path ever writes, leaving the one transitive project->request route empty

- **Severity:** LOW
- **Status:** RESOLVED
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

**Partial (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. `/api/tickets/create` stamps `checkout_sessions.linked_ticket_id` on the originating session of a check-in request (`:938`: the caller's own session, only where it is still null, checked — a refusal is logged server-side, the request stands; since the merge-time fix pass, only once `20261256` is applied — see below). The one transitive project→request route now has a writer, beside the direct `tickets.project_id`.

**Done-when.**
- ✓ A checkout raised to service a drafting request stamps `linked_ticket_id` — once `20261256` is applied (before it, nothing is stamped: the merge-time fix pass below). Tests: `ticketCreateRoute.test.ts` DF-P8 "PROJ-4 / PROJ-10: a check-in takes the project of the requester's OWN checkout session … and stamps that session with the request" and its ad-hoc REGRESSION (a session with no project is still stamped), both in the world with the column; the world without it is pinned by the merge-time tests below.
- ✗ `milestones.linked_ticket_id` — not decided here (a milestone is the projects model's; no writer added, none removed).

**Scope / residual.** `milestones.linked_ticket_id` (wire or drop) → owner: projects-joint (projects-and-cost). Stays OPEN on done-when 2.

**Fix pass 4 (2026-10-21, drafting-flow Round G — the fourth independent review).** Stamping the session coupled it to the request: the baseline declares `checkout_sessions.linked_ticket_id UUID REFERENCES tickets(id)` with no delete action (`supabase/schema.sql`), so once a check-in session named its request, deleting that request (e.g. under `tickets_delete_controllers`, `20261166`) would fail with 23503 where it succeeded before DF-P8. `20261256` section (4) now re-creates the key ON DELETE SET NULL — `milestones.linked_ticket_id`'s shape (`20260614`): every key on that column to `tickets` that is not already SET NULL is dropped by catalog (whatever its name), the SET NULL key is added once (re-runnable), and probe 7 checks there is exactly a SET NULL key. Deleting the request clears the session's pointer; the session stays (no guard on `checkout_sessions` covers `linked_ticket_id`: `enforce_checkout_session_guard` watches `user_id` / `outcome*`, the release rail `status`, and the project-documents resync fires only on `project_id` / `document_id`). Tests: `dfRoundG_P8_projects.test.ts` "fix pass 4 (review, minor): checkout_sessions.linked_ticket_id is re-created ON DELETE SET NULL …" (shape); PG16 `rls/dfP8TicketProject.test.ts` "fix pass 4: a request a check-in session names … can still be deleted" (the service role stamps the session, deletes the request, the session stays with its pointer cleared; exactly one key, `confdeltype = 'n'`) and the re-paste case now expects 7 probes, all true.

**Fix pass at the merge (2026-10-21, DEC-90 — the final review round; corrects fix pass 4 where it overstated, DEC-29).** Fix pass 4 recommended "deploy first, then paste" and called either order safe, but the create route stamped the session from the deploy onward — and until `20261256` section (4) is pasted the key is still the baseline one with no delete action, so in the recommended window a request a stamped session named could not be deleted (23503). Now the route writes the stamp only once `20261256` is applied (`app/api/tickets/create/route.ts:935`): known for certain when the ticket insert that landed carried `tickets.project_id` with no `isMissingProjectColumn` fallback, otherwise asked with a zero-row read of `tickets.project_id` (`lib/ticketProject.ts` `ticketProjectColumnPresent`; the paste is one transaction, so the column is there exactly when section (4) is). A read that fails any other way stamps nothing. Before the paste no session is stamped — exactly as before DF-P8 — so "either order is safe" now holds as written. The restore follows the live key: `lib/dataRestore.ts` `RESTORE_PARENT_RULES.checkout_sessions` reads `linked_ticket_id>tickets?` (`:312`), so a session whose request is not a row of the target workspace lands with the pointer cleared and reported, instead of the whole session being refused. Tests: `ticketCreateRoute.test.ts` "PROJ-10, before 20261256 (tickets.project_id absent): an ad-hoc check-in … stamps NO checkout session", "PROJ-10, before 20261256: a check-in under a project checkout … stamps NO checkout session", "PROJ-10: a probe of tickets.project_id that fails some other way … no stamp", "PROJ-10, after 20261256: … stamped … a project check-in needs no probe" (the harness now models a database without the column: `missingColumns`); `dataRestore.test.ts` "DF-P8 — a checkout session whose request is not here restores with linked_ticket_id cleared" (and the clearable-pointer pin now lists `checkout_sessions.linked_ticket_id`).

**Pending migration:** `20261256` (DEC-30 one paste; deploy first, then paste — either order is safe: before the paste the app takes today's path — a request with no project, and no checkout session stamped with its request (the stamp waits for the paste: DEC-90 fix pass at the DF-P8 merge, `PROJ-10`); independent of every other migration).

*Assigned (2026-10-21, the integrator at the DF-P8 merge, DEC-31):* done-when 2 (wire or drop `milestones.linked_ticket_id`) → projects-joint **J21 DRAFTING-REQUEST PROJECT REMAINDERS**.

**Resolution (2026-10-22, projects-joint Round G).** J21, DEC-90 ruling (4): `milestones.linked_ticket_id` is **DROP-AS-UNUSED by record**, not wired. Re-verified on `693239d`: no screen shows it — `components/projects/ScheduleTab.tsx`, `TaskDetailPanel.tsx` and every other caller render no milestone→request link, and `createMilestone`'s only caller passes none (`lib/milestones.ts:339` maps it). Wiring it would need a new picker and a new display, a second stored request↔project link beside `tickets.project_id` — which GAP-114 forbids ("Do not add the reverse link as a second source of truth. One foreign key on the ticket."). The ruling prefers WIRE only when a screen will show it; none does. No destructive DDL: the column, its key (`ON DELETE SET NULL`, `20260614`) and its mappings stay. `20261262` §(3) only marks the column `COMMENT … 'UNUSED (drafting-flow PROJ-10 …)'`, so the schema stops advertising it as live. PostgreSQL 16 case: the column is still there, with the comment.

**Done-when.**
- ✓ A checkout raised to service a drafting request stamps `linked_ticket_id` — once `20261256` is applied (as recorded).
- ✓ The same decision is made for `milestones.linked_ticket_id`: drop-as-unused, kept and marked unused (`20261262` §(3)); the request's project is `tickets.project_id`, one reference.

**Scope / residual.** None. Removing the column and its mappings later is a destructive change for its own package and paste, if ever wanted.

**Pending migration:** `20261256` (done-when 1, as recorded); `20261262` (the column comment only).

---

<a id="proj-11"></a>

## PROJ-11 · document_versions.related_ticket_id is never written but IS honoured as a review-gate bypass — wiring the ticket<->document link naively will silently disable required review

- **Severity:** LOW
- **Status:** RESOLVED
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

**Resolution (2026-10-02, drafting-flow Round G).** Record-only close by pointer to roles-and-permissions [`LIFE-2`](../roles-and-permissions/07-document-lifecycle.md) / `DEC-23` (`2af2ebe`, Phase 0, 2026-08-24), re-verified against `f1ac550` after document-control P13 added the first-issue rule to the same function. The waiver branch is deleted and the parameter is gone: `export function effectiveModeForRevUp(input: { control: ReviewControl; changeType?: string | null; firstIssueMustReview?: boolean; asBranch?: boolean; }): ReviewControlMode` (`lib/reviewControl.ts:98-111`) — the docblock states "Ticket origin NEVER waives review (DEC-23)" (`:77-80`). `related_ticket_id` is now written for provenance (`20261049`, `lib/revisions.ts:1245`, `:1534`) and read by nothing that gates. Test: `lib/__tests__/reviewControl.test.ts:41-46` feeds the exact pre-DEC-23 input `{ control: require, changeType: "Major", relatedTicketId: "t1" }` and pins `"require"`.

**Done-when.** ✓ The branch is removed (the finding's second option); ✓ "if the branch is kept, the write path lands with it" — moot, the branch is gone, and the write path that later landed (`20261049`) cannot reach the gate (no parameter); ✓ the test asserts the surviving rule.

**Scope / residual.** None. Intelligence `WIRE-9` is recorded `INVALID` on the same decision.

---

<a id="proj-12"></a>

## PROJ-12 · flagCollisionToDrafting writes a project id onto the ticket that nothing reads, and reports the result as a disposable toast with no link

- **Severity:** LOW
- **Status:** RESOLVED
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

**Resolution (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. `lib/transitionIn.ts` `flagCollisionToDrafting` files the request with the project as `project_id` (through `/api/tickets/create`'s collision path), returns its id, and writes a second, checked `INTAKE_COLLISION_FLAGGED` audit row filed against the project (`resource_type: "project"`, `resource_id`, `:805`). `components/projects/IntakePanel.tsx` keeps the notice with an "Open the request" link to `/requests/<id>`. The project page lists the request persistently (`ProjectRequestsCard`, mounted at `app/(protected)/projects/[id]/page.tsx:669`). `20261256` backfills `project_id` from `metadata.intake_collision.projectId` (inventory first; only a UUID naming a project of the same org; never a request whose link was recorded; `last_modified` untouched — DEC-90 ruling (2)).

**Done-when.**
- ✓ The collision request is reachable from the project (the requests card) and the notice links to it. Test: `dfRoundG_P8_projects.test.ts` "PROJ-4 … PROJ-12: the collision notice links to the request"; `lib/__tests__/transitionInCollisionCreate.test.ts` (ticket id, two audit rows).
- ✓ The audit row is retrievable by project (filed against it).
- ✓ `metadata.intake_collision.projectId` is replaced by the real reference: backfilled, and `lib/ticketPage.ts` `projectRefOf` reads the column first (the metadata only before the paste). Tests: `lib/__tests__/rls/dfP8TicketProject.test.ts` "DEC-90 ruling (2): the backfill …" (PostgreSQL 16).

**Scope / residual.** None.

**Pending migration:** `20261256` (DEC-30 one paste; deploy first, then paste — either order is safe: before the paste the app takes today's path — a request with no project, and no checkout session stamped with its request (the stamp waits for the paste: DEC-90 fix pass at the DF-P8 merge, `PROJ-10`); independent of every other migration).

---

<a id="proj-13"></a>

## PROJ-13 · projects.linked_ticket_id is a dead column — its only writer's only caller has zero call sites, so the project page's "Linked ticket" chip can never render

- **Severity:** LOW
- **Status:** RESOLVED
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

**Resolution (2026-10-21, drafting-flow Round G).** DF-P8 PROJECTS. Decision taken as the plan's default (DEC-90 ruling (3) for DF-P8): wired, column kept. `components/requests/TicketProjectActions.tsx` on the request page (`app/(protected)/requests/[id]/page.tsx:3040`; the requester or a member with `ticket.manage`) offers "Create project from this request": `lib/projects.ts` `convertTicketToProject` (`:1586`) creates the project naming the request in `projects.linked_ticket_id`, then links the request through `/api/tickets/project-link` (`converted: true`), which writes the reference and the one "Converted to Project" history line server-side. A project whose link fails is returned with `linked: false` and the reason — never thrown, so a retry does not create a second one.

**Done-when.**
- ✓ `convertTicketToProject` is reachable from a UI affordance and the project header chip renders (the column has a writer).
- ✓ A mislink is correctable: `updateProjectMeta` accepts `linkedTicketId` (set / clear), and unlinking the request clears `projects.linked_ticket_id` where it names that request. Test: `dfRoundG_P8_projects.test.ts` "unlink: … PROJ-13 — a project created from this request stops naming it".

**Scope / residual.** None.

**Pending migration:** `20261256` (DEC-30 one paste; deploy first, then paste — either order is safe: before the paste the app takes today's path — a request with no project, and no checkout session stamped with its request (the stamp waits for the paste: DEC-90 fix pass at the DF-P8 merge, `PROJ-10`); independent of every other migration).


**Fix pass (2026-10-21, drafting-flow Round G — the independent review).** (1) The "management or the requester" limit was enforced only in the browser (`TicketProjectActions` `canAct`): `/api/tickets/project-link` accepted `converted: true` from any manager of the target project and, on a move, asked only about the target. Now the route (a) asks `can_manage_project` about EVERY project a change touches (`lib/ticketProject.ts` `projectsTouched`: both the current and the target project on a move, so the manager of one project cannot take a request off a project another team manages, clear its origin chip or write its feed); (b) allows `converted` only to the requester or `ticket.manage` (`projectLinkAllowed({ converted })`) and only for a project whose `linked_ticket_id` names this request (else 400) — so no forged "Converted to Project" line. (2) When the project was created but the link failed, the Create button stayed: now the component remembers the created project and offers "Link to <project>" instead, which retries `postProjectLink({ …, converted: true })`; a second project is never made by a second click. (3) The link's history line names its audit row (`attempt`) and the row carries `details.historyAttempt`, so the SM-7 drain reconciles a link whose `_NOT_APPLIED` write failed twice. Tests: `dfRoundG_P8_projects.test.ts` "fix pass (major 1a)", "(major 1b)", "(minor 7)"; `dfRoundG_P8_projectsFixPass.test.ts` "PROJ-13 fix pass …" (rendered: the retry replaces Create, a failed retry keeps it, a landed one says so).

**Fix pass 2 (2026-10-21, drafting-flow Round G — the second independent review).**
- (1) `convertTicketToProject` no longer throws once `createProject` has made the project. Previously a refused requester-membership row (`addMember` throws on any insert error) escaped before the result was returned, so the page never recorded the project, showed "Create project" again, and a second click made a second project naming the same request. The member step is now wrapped: a refusal becomes `linkWarning`. The link call is wrapped as well, and the result always carries the project, so the page offers "Link to <project>". Tests: `lib/__tests__/dfRoundG_P8_projectsConvert.test.ts` (rendered, real `convertTicketToProject`: member row refused and link failed → retry button, no second project insert; member row refused and link landed → a warning; regression).
- (2) The link route's history line names no project. Ticket history is read by every reader of the request, and a private project's name is not theirs to read (`PROJ-9`). On an unlink the old name had been read as the service role, past project visibility; it is no longer read at all. The line carries the project's id (`projectId`) and shows no name. The request page's project chip names the current project only through the viewer's own RLS read, as before (`PROJ-9`). Test: "fix pass 2 (minor 3): the history line names NO project …".

**Fix pass 3 (2026-10-21, drafting-flow Round G — the third independent review).**
- (1) Done-when 1's "never a second project" depended on the page's realtime refresh: after a link or a create that landed, `TicketProjectActions` kept no state of its own, so with realtime down "Create project from this request" stayed clickable and a second click made a second project (and the converted link moved the request onto it). The component now holds what its own successful change left the request linked to (`landed`, with the page's value it was made against): Create and Link give way to Unlink the moment the link lands, an unlink that lands shows Link / Create again, and the page's value takes over as soon as it changes. Tests: `dfRoundG_P8_projectsConvert.test.ts` "fix pass 3 (review, minor): a Create that links at once replaces Create and Link with Unlink before any realtime refresh …", "fix pass 3: a link from the picker that lands shows Unlink at once; a refused link leaves the controls as they were", and the retry case now also asserts Unlink.
- (2) The project page's requests card (`components/projects/ProjectRequestsCard.tsx`) said "with <drafter>" in every status, so a request in engineering review or sign-off named the drafter. It now names who the request waits on by role, from its status (`lib/ticketProject.ts` `requestHolderLabel`: "Engineer: …" in `PENDING_ENG_TEAM` / `PENDING_FINAL_APPROVAL`, "Drafter: …" in `DRAFTING` / `REVISION_REQ` / `PENDING_IFC`, the requester in `PENDING_REVIEW` and `FINAL_DRAFT` — or, in a routed review, the roster's open slots — and the drafting queue in `PENDING_ASSIGNMENT`), reading `assigned_engineer_name` too. Test: `dfRoundG_P8_projects.test.ts` "fix pass 3 (review, minor): requestHolderLabel …". *Corrected by fix pass 4: as first landed, fix pass 3 mapped `PENDING_REVIEW` to the engineer ("Engineer: …" / "Awaiting an engineer"), which was wrong — see below.*

**Fix pass 4 (2026-10-21, drafting-flow Round G — the fourth independent review; corrects fix pass 3 where it overstated).**
- (1) Fix pass 3's `requestHolderLabel` said a `PENDING_REVIEW` request waits on the engineer. In this workflow it waits on the REQUESTER's review (`lib/workflow.ts` WF-24 "the ticket waits on the REQUESTER's review"; `lib/ticketSla.ts` `waitingParty` maps `PENDING_REVIEW` to the requester), or, on a routed request, on the roster's open blocking slots. `requestHolderLabel(status, names, metadata)` now answers "Awaiting review from: <requester>" (or "Awaiting the requester's review"), and when the row carries a current review roster (`lib/workflow.ts` `currentRoster`: `PENDING_REVIEW`, `metadata.review_roster` v1, not closed) "Awaiting routed review: <slot labels>" — the `lib/ticketRoster.ts` `waitingSlotLabels` rule (open and not notify-only, via `slotBlocks`) — or "Reviewers (routed review)" when none is still open. `PENDING_ENG_TEAM` / `PENDING_FINAL_APPROVAL` still name the engineer. The card passes each row's `metadata`. Tests: `dfRoundG_P8_projects.test.ts` "fix pass 3 (review, minor): requestHolderLabel …" (now expects "Awaiting review from: Rita") and "fix pass 4 (review, major): a ROUTED review …" (open slots named; notify-only and satisfied slots never wait; a closed roster or a roster outside review is not current); `dfRoundG_P8_projectsCard.test.ts` (rendered card: requester, no-requester, routed, drafter; the engineer is never named in review).
- (2) The card's header said "{open} open · {closed} closed" over only the newest `PROJECT_REQUESTS_LIMIT` (200) rows. It now reads the project's totals: the list query carries `count: "exact"` and the open requests are counted by their own head query (same `org_id` / `project_id` / `archived_at` filters, `status not in TERMINAL_TICKET_STATUSES`); a truncated list adds "newest 200 shown". When a total cannot be read the figures are labelled "newest 200 shown — N open · M closed of those shown", never presented as the project's totals. Test: `dfRoundG_P8_projectsCard.test.ts` "260 linked requests, 30 of the oldest still open …", "a total that cannot be read …", "a short list …".
- (3) The card hid itself on ANY 42703 / PGRST204. It now hides only when the answer names `project_id` (`isMissingProjectColumn`, as the routes do since the first fix pass); any other refusal shows the card's read-failure line. Test: `dfRoundG_P8_projectsCard.test.ts` "the card hides itself only when project_id itself is missing".
- (4) `/api/tickets/project-link` wrote the `request_unlinked` feed row into the PREVIOUS project as the service role without asking whether the caller can see it (a requester unlinking or moving a request off a private project). The route now reads the previous project AS THE CALLER (`callerClient.from("projects").select("id")`) and writes the feed row only when it is visible; otherwise (or when that read fails) it writes none and logs a server-side warning, telling the caller nothing about a project they cannot see. The `linked_ticket_id` clear stays a service-role write (it only removes this request's own id). Test: `dfRoundG_P8_projects.test.ts` "fix pass 4 (review, minor): an unlink or a move off a project the CALLER cannot see …" (fails against fix pass 3's route).

**Fix pass at the merge (2026-10-21, DEC-90 — the final review round; narrows the "never a second project" claims above to what holds, DEC-29).** Fix passes 1–3 kept "never a second project" only within ONE page load: the created project was remembered in component state, so after a Create whose link failed, a reload offered "Create project from this request" again. Now, before Create is offered — on mount, and again inside "Create project" right before `convertTicketToProject` runs — `components/requests/TicketProjectActions.tsx` `findProjectNamingRequest` (`:234`) reads, through the viewer's own client, the projects of this workspace whose `linked_ticket_id` names this request, newest first; the newest one that is not closed is offered as "Link to <its name>" (`postProjectLink({ …, converted: true })`) in place of Create, beside "Link to a project" as today. What holds now: a second click, a reload or another tab does not create a second project while a project that names this request is one the viewer can read and is not closed, and that read succeeds. What does not: if the read fails, Create stays (today's behaviour) and the page says it could not check ("check the Projects list before creating one"); a project naming the request that is closed (the link route refuses a closed project) or that the viewer cannot read does not take Create away; and two Creates that both pass the check at the same instant are not serialized — there is no database constraint on `projects.linked_ticket_id`. Tests: `dfRoundG_P8_projectsFixPass.test.ts` "REMOUNT: a project an earlier load created from this request (link never landed) is offered as 'Link to <project>' …" (rendered: create, link fails, unmount, fresh mount → no Create, the converted link, no second `convertTicketToProject`), "the check is asked again inside Create …", "REGRESSION: a closed project naming the request, or another request's project, does not take Create away …", "a failed read never removes Create …".
---

<a id="proj-14"></a>

## PROJ-14 · A request deliverable's project reference that is not written when its review completes is never said on screen — the review panel does not pass the note handler

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** projects-joint J21 at its merge (the integrator's ruling 5, DEC-90: nobody else held `components/documents/ReviewGateSection.tsx`, minimal change). Opened by projects-joint Round G J21's review fix pass, 2026-10-22, from the package reviewer's finding, as `PROJ-1`'s remainder (DEC-90 ruling (1) for J21: record / retry, *said*).
- **Verification:** CONFIRMED by reading.
- **Independently verified:** — opened 2026-10-22 by J21's review fix pass from the package reviewer's finding; not yet challenged by a second party.
- **Locations:**
  - `components/documents/ReviewGateSection.tsx:248-249` — both `finalizeReviewedRevision({ … })` calls pass no `onProjectReferenceNote`
  - `lib/reviewControl.ts` `finalizeReviewedRevision` — `void referenceReviewedRequestDeliverable({ …, onNote: input.onProjectReferenceNote })`
  - `lib/reviewDeliverableReference.ts` `referenceReviewedRequestDeliverable` — `say()`: `onNote` when given, else `console.warn`
- **Related:** `PROJ-1` (resolved; this is its on-screen remainder), `GAP-114`, `DEC-90` ruling (1) for J21

**Mechanism.** When a review completes on a request's deliverable, the background reference call answers a warning when the reference was not written (the finalizer lacks the register authority, the check could not be asked, the write was refused). `finalizeReviewedRevision` hands that warning to the optional `onProjectReferenceNote`, else the console. The review panel — the only live caller whose versions can carry a request (`IntakePanel`'s finalizes are intake drafts, which carry none) — passes no handler.

**Failure scenario.** A reviewer who is not a project manager completes the review of a request deliverable whose request was linked by a requester without register authority. The route records `no_register_authority` on the request's audit trail and answers the warning; the reviewer sees "published" and nothing else, and the project manager is not told. The reference is recoverable (the Documents card; or unlink and relink the request), but nobody on screen learns it is owed.

**Remediation.** In `ReviewGateSection.tsx`, pass `onProjectReferenceNote: (note) => …` to both `finalizeReviewedRevision` calls and show the note beside the publish result (it arrives after the publish answered — the call is never awaited), e.g. as a dismissible notice.

**Resolution (2026-10-22, J21 merge-time fix, DEC-90 ruling 5).** Both `finalizeReviewedRevision` calls in `components/documents/ReviewGateSection.tsx` (`:260-261`) pass `onProjectReferenceNote`; a note that settles after the publish shows as a `role="status"` line (`data-testid="review-project-reference-note"`, `:331`) under the contractor notice, cleared on the next publish and on a document change, and dropped if it arrives for a document the panel no longer shows. The miss also stays on the request's own audit trail where its readers see it: the route appends one line to `tickets.history` (the request's Audit Log tab) besides the `TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN` row — for a request not archived, without changing `last_modified`, and only when that write succeeds (`PROJ-1` merge-time fix and review round; a concurrent whole-array history write may drop the line, the audit row remains). Tests: `lib/__tests__/prjRoundGJ21ReviewGateProjectNote.test.ts` (rendered, five cases), `lib/__tests__/prjRoundGJ21DeliverableReferenceRoute.test.ts` "merge-time fix (ruling 5) …" (six cases).

**Done when.**
- [x] Both `finalizeReviewedRevision` calls in `ReviewGateSection.tsx` pass `onProjectReferenceNote`, and a note that arrives after the publish is shown on screen (rendered test: a warning answered by the route appears; a publish with no request shows nothing new) — `prjRoundGJ21ReviewGateProjectNote.test.ts`.

**Residual (stated, the P39 ruling (d) precedent).** If the call is lost entirely — the route unreachable on both tries, or the page closed before the POST went out — that one reference is lost and nothing is recorded; it is recovered by attaching the document from the project's Documents card, or by unlinking the request and linking it again (a linker with the register authority). A page closed after the POST went out (it is sent `keepalive`) loses only the on-screen note: the miss is still recorded on the request.

---
