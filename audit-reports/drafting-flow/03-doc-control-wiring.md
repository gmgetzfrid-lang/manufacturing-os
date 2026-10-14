# 03 · Document control wiring — the flow never reaches the library

The question: **can specific drawing types be pushed to the document controller
of that library for review and release?**

No — and the blocker is one field earlier than expected. **A drafting request
does not know which library it belongs to.**

**7 findings** — 2 CRITICAL, 3 HIGH, 2 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.**

---

## DCW-1 · A ticket has no target library, so no library-scoped rule can ever apply to it

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / architecture
- **Locations:**
  - `types/schema.ts` — the `Ticket` interface. **There is no `libraryId`, no `collectionId` and no target-container field of any kind.** (`libraryId` appears six times in `types/schema.ts`, on documents, collections, versions, packages and knowledge sources — never on `Ticket`.)
  - `app/(protected)/requests/new/page.tsx:286-330` — the insert row: `org_id, ticket_id, title, description, unit, request_type, priority, status, requester_*, attachments, history, comments, unread_by, watchers, target_completion_at`. No library.
  - `app/(protected)/requests/new/page.tsx:290-298` — the only document linkage is `metadata.source_document`, written **only when `sourceDocId` is present**
- **Related:** `DCW-2`, `DCW-3`, `TIER-2`, `GAP-104`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The `Ticket` type carries **zero** fields naming a library or collection, so there is no value for a library-scoped rule to key on.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The absence of a declared target-library field is real and confirmed on the type, the table and the form. The absolute claim is overstated: for any ticket raised from a document, metadata.source_document.id joins to documents.library_id, and the workflow-action route already performs exactly that join — so a library-scoped rule CAN be written for that subset today. The gap is genuine only for tickets with no source document (a brand-new drawing) and for tickets whose target library differs from the source's; CRITICAL overstates it.

**Mechanism.** Every document-control rule in this system resolves through the
container chain — document → folder → library, most specific defined level wins.
That is how `review_control` works, how `docClass` works, how the ACL works, and
how ownership works. It is a good pattern, applied consistently.

**The ticket sits outside it entirely.** It has an `org_id` and a free-text
`unit`, and nothing else that locates it in the document tree. So there is no
join on which a library-scoped rule could be evaluated.

A request that originates from a document carries `metadata.source_document.id`
— from which a library *could* be derived. A request for a **new** drawing —
exactly the case that most needs doc-control release — has no source document and
therefore no derivable library at all.

**Failure scenario.** A drafting supervisor wants P&IDs to route to the P&ID
library's document controller for release, while sketches route straight back to
the requester. There is no field to hang that rule on. The rule cannot be written
regardless of how the reviewer model is designed.

**Chain reaction.** This is the **prerequisite for `DCW-2`, `DCW-3` and
`GAP-104`**, and it is also what makes `GAP-6` (the ticket → document hand-back,
in the roles-and-permissions area) harder than it looks: the hand-back has to
decide *where* the revision lands, and for a new document that information does
not exist on the ticket.

**Done when.**
1. A ticket carries a target library, set at intake or confirmed at triage.
2. It is derived automatically when a source document is attached.
3. For a new-document request it is chosen from the libraries the requester can
   see — or deferred to triage, which is a step that already exists.

**Partial (2026-10-13, drafting-flow Round G).** DF-P4 LIBRARY (`GAP-105`), base `0a3150a`. Reproduced first: no ticket column, type field or route names a library (`types/schema.ts` `Ticket`, `app/api/tickets/create/route.ts` row, `supabase/migrations/*` — no `tickets.library_id`).
- **The column.** `tickets.library_id UUID REFERENCES libraries(id) ON DELETE SET NULL` + `tickets_library_idx` (`20261208:118-119`), backfilled from the singular source document **in the ticket's own org** (SM-14), only rows still NULL (`20261208:126-133`). Workflow-owned: `ticket_update_guard` re-created from its newest body (`20261195`, found by scanning, lineDiff-pinned) with the library rule (`20261208:215-219`) — the library's own deletion passes; `ticket_insert_integrity` re-created from `20261195` so a client insert is born with none (`20261208:335`). **Pending migration:** `supabase/migrations/20261208_df_roundG_ticket_library.sql` (`DEC-30`: one paste, not a widening; after `20261195` — its first statement refuses otherwise — and after the DF-P2 app deploy (the create route), never before it). The app works before and after the paste: without the column the create route retries the same number without `library_id` (`missingLibraryColumn`, 42703 / PGRST204) and the workflow route applies the triage action without it and says so (`warning`). The database half is not closed in any database until it is pasted.
- **Derived at intake, never asked for.** `app/api/tickets/create/route.ts:712-713` sets `library_id` to the primary source document's own library (`documents.library_id`, read as the requester — `readSourceDocuments`, `:232`, so a document they cannot see lends nothing; the library is the root of the one container chain, `lib/containerChain.ts` `loadContainerChain`'s `libraryId` — DEC-36, no second walk). With no source document the ticket files with no library, exactly as before.
- **Set or corrected at triage.** `assign` / `request_eng_review` at `PENDING_ASSIGNMENT` take `body.libraryId` (`app/api/tickets/workflow-action/route.ts:549-637`): a library of the ticket's org **that the caller may discover** (400 otherwise, nothing written; 503 when the library or the caller's teams cannot be read), applied by `computeTransition`'s triage step on the same compare-and-set with a "Triage details set" history line (`lib/ticketTransitions.ts:420-454`). Never required: `DEC-44 (DF-P4)` item 2 (a ticket with no library reaches every status as today). *(Corrected at the DF-P4 fix pass: the route first checked only that the library was in the org, so the picker's "a library the assigner cannot see is never offered" held in the browser alone — an assigner holding a private library's id could stamp it, and the history line carried its name to the requester and the watchers. Now the route builds the caller's principal on the server (the full additive role collection, `heldRoles`, and the caller's `team_members` read as the service role) and runs the picker's own rule, `lib/ticketLibrary.ts` `offerableLibraries` → `canDiscover`, on the library's `visibility`, `acl` and `owner_user_id`; a library it does not offer answers exactly as a foreign one. The history line names a library only when it is open to every member — a hidden / private one is "the target library" (`libraryLabelForTicket`).)* *(Corrected again at the DF-P4 second fix pass: (1) the check ran on ANY `libraryId`, including the ticket's current one sent back unchanged — so a non-controller assigner (a Supervisor, a DraftingSupervisor) who cannot discover a private library a requester's discover grant had set (`DCW-5` → `create/route.ts:712-713`) had the whole assignment refused with a 400, though nothing changed. Now an id equal to the ticket's own `library_id` (case-insensitive, trimmed) is no change: the route skips the read and the check and records no triage library (`libraryUnchanged`, `workflow-action/route.ts:557-563`), as `computeTransition` already did for an unchanged id; a DIFFERENT undiscoverable library is still refused. (2) "Open to every member" was read as `visibility = 'normal'`, but `canDiscover` still applies a normal library's ACL (`isDiscoverable()` — a deny on a role or a team hides it), so the name now appears only when the library is normal AND its ACL carries no rule and no restricted visibility of its own; any rule, or an ACL that cannot be read as one, is "the target library" — at both call sites, the close branch reading `acl` too.)*
- **The picker.** `components/requests/LibraryPicker.tsx` (new) offers only libraries the caller may discover (`lib/ticketLibrary.ts` `offerableLibraries` → `lib/permissions` `canDiscover`), with "No library — decide later" first and default. Mounted by DF-P9 in the assign modal (one line, in the component's header). A current value the caller is not offered (a library the assigner cannot discover) is shown as one extra option, "the target library (current)", selected — never by name and never as "No library" (*DF-P4 second fix pass*: the select first showed "No library — decide later" while its value still held the hidden id); sent back unchanged it is no change at the route (above). *(DF-P4 third fix pass: a library is never CLEARED at triage — the route reads a null / empty `libraryId` as no change and `computeTransition` can only set `library_id` — so on a ticket that has one, "No library — decide later" was a choice the server silently ignored (200, library kept), and once the selection moved off the hidden current option it could not be chosen again, the option being keyed on the live `value`. The picker now takes `currentLibraryId` (the ticket's stored library): when it is set there is no "No library" option, the current library stays selectable whatever `value` is (keyed on `currentLibraryId`), and a null `value` shows it selected. The component header and the DF-P9 hand-off row carry the mount with `currentLibraryId`.)*
- The restore bounds the new pointer (ORG-1's census): `lib/dataRestore.ts` `RESTORE_PARENT_RULES.tickets = library_id>libraries?` — a restored ticket naming a library that is not in the target workspace lands with **no library** (the pointer is cleared and counted in the restore report's cleared rows), exactly as the live database leaves a ticket whose library is deleted (`ON DELETE SET NULL`). File outside the plan (admin-and-org P1's module), one line; `lib/__tests__/dataRestore.test.ts`'s reviewed set of cleared pointers now names it. *(Corrected at the DF-P4 fix pass: the first version refused the whole ticket, with its history and comments, on the reasoning that a library-scoped rule could be narrower than the base list — but the library is not in the ticket's capability resource (next bullet), so a cleared pointer widens nothing.)*
- **The library is NOT in the capability resource yet.** `lib/workflow.ts` `ticketResource` still presents request type and unit only. *(Corrected at the DF-P4 fix pass: the first version added `libraryId` there, but only the server mapper (`rowToTicket`) supplies it — the request page's `fromRow` and the attention badge's mappers build their `Ticket` without it — so a stored `when.libraryId` rule on a `ticket.*` capability (which `validateCapabilityPolicy` accepts, and which can REPLACE the base list) would have started governing backfilled tickets at the route while the page and the badge still evaluated the base list: UI and authority disagreeing, and a widening no inventory counted.)* It joins the resource with DF-P5's routing, together with the page / attention mappers (DF-P9 / DF-P10) and a counts-only inventory of stored `when.libraryId` rules on `ticket.*` capabilities — drafting-flow `99-fix-sequencing.md`, "Hand-offs from DF-P4". So `20261208` remains not a widening: no rule anywhere reads `tickets.library_id`.
- Tests: `lib/__tests__/dfRoundG_P4_library.test.ts` (53 — the third fix pass added: the picker with `currentLibraryId` offering no "No library" choice and keeping the current option after the selection moves; the batched intent bridge (`GAP-8`, roles-and-permissions); the second fix pass added: the current library sent back unchanged by a DraftingSupervisor / Supervisor who cannot discover it → 200, assignment written, `library_id` untouched, the library never read, while a different undiscoverable library is still 400; a normal library with an ACL rule is "the target library" in the triage history and the close note; `libraryLabelForTicket`'s ACL cases; the picker rendering "the target library (current)"; the sidebar census for Request forms — and before it: triage on the route and in `computeTransition`, the pre-paste path, the server-side discover check (a private / hidden library the assigner cannot discover → 400, nothing written, no audit row; its owner, a controller, an additive DocCtrl and a team ACL grantee admitted, the history saying "the target library"; a failed team read → 503), `ticketResource` without the library, the restore's clearing rule, the 20261208 lineDiffs and shape), `lib/__tests__/ticketCreateRoute.test.ts` ("DF-P4 — GAP-105 / DCW-1", 4). Exercised on a throwaway PostgreSQL 16 (initdb in a scratch directory, deleted afterwards), the file sent as ONE string as the SQL editor sends it, over the real bodies of `20261195` (guard, insert integrity), `20261166` (the per-verb ticket policies), `20261045` / `20261046` / `20260818` (the role helpers) and `20261203` (the config policies): first paste 6 × true with the inventory 5 / 2 / 2 / 1 / 1 / 1 / 1; re-paste 6 × true (idempotent); an own-org source document backfilled (two tickets), a foreign-org source, a non-UUID id and a source-less ticket left NULL; a member's `UPDATE … SET library_id` refused ("library_id are workflow-owned"), a member setting it NULL while the library exists refused, a member's priority write passes; the service role sets it; a member deleting a library nulls `library_id` on its tickets through the guard (ON DELETE SET NULL inside the delete's trigger); a member's insert refused by RLS (no INSERT policy left); with `tickets_org_insert` put back by hand (a re-paste of `20261166` simulated) a member's insert carrying a library, a forged name, `sla_breached_at`, `outcome` and `CLOSED` lands with no library, the member's own name ("Dee" from the display name; the email's local part when the display name is blank), `PENDING_ASSIGNMENT`, no stamps and no outcome; a service-role insert keeps its library and name. On a database without `20261195`'s guard the file raised "20261208 needs 20261195 … nothing was changed" and left no `library_id` column and `tickets_org_insert` in place.

**Done-when.**
1. ✓ (after the paste) A ticket carries a target library, set at intake (derived) or at triage (the route — refusing a library the assigner cannot discover, by the same rule the picker offers by).
2. ✓ Derived automatically when a source document is attached (and visible to the requester).
3. ✗ in part (the documented mount — `value` initialised from the ticket, `currentLibraryId` the ticket's library (third fix pass) — no longer refuses a legitimate assignment: an unchanged library is no change, second fix pass) — deferred to triage: the triage action takes it (server ✓), but no screen sends it until DF-P9 mounts `LibraryPicker` in the assign modal and passes `libraryId` (one line; the brief's split). Requester-side choice at intake is deliberately not offered (99-fix-sequencing Phase 2 item 1).

**Scope / residual.** The picker's mount and the `libraryId` it sends → **DF-P9** (assign modal). Paste `20261208` (see the paste row in DF-P4's report). DF-P5 / DF-P6 read `tickets.library_id` for routing and the roster; `libraryId` joins `ticketResource` only with DF-P5, after the page / attention mappers carry it (hand-off row). The discover rule reads the library's own `owner_user_id` as its owner, as the picker does; a library owned by a team (`owner_team_id`) is offered to that team only through its ACL.

---

## DCW-2 · Document Control is not a party to the drafting flow at any state

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance
- **Locations:**
  - `lib/workflow.ts:80-342` — the full state machine. `DocCtrl` appears exactly once, at `:41`, inside `requiresEngineerApproval` — where it causes the engineering gate to be **skipped**.
  - `lib/capabilityPolicy.ts:57-96` — of 12 `ticket.*` capabilities, `DocCtrl` is a default holder of **none**
  - `lib/ticketRouting.ts:70-117` — routes to `DraftingSupervisor` → Admins, and to engineers. Never to document control.
  - `lib/ticketAttention.ts:106-108` — nonetheless tells DocCtrl they must act at `FINAL_DRAFT` and `PENDING_IFC`
- **Related:** `DCW-1`, `FRIC-7`, `GAP-104`
- **Re-verified:** hardening pass — **SURVIVES**. `DocCtrl` appears in `lib/workflow.ts` four times, all as a role-list membership test, never as an actor in a drafting state; in `capabilityPolicy.ts` its entries are `admin.*` capabilities (`:91, :93, :95`). Its only role in the flow is as an *exemption* — `isDocCtrlRole` short-circuits `requiresEngineerApproval` (`workflow.ts:41`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and the attention line makes it worse rather than better: DocCtrl is told a ticket "needs your action" at FINAL_DRAFT/PENDING_IFC while getActions returns zero buttons for that role at either status (PENDING_IFC requires canActAsDrafter; FINAL_DRAFT requires requester identity, ticket.direct_approve — default ["Engineer"] — or management). No gate, no notification, no capability.

**Mechanism.** The one appearance of `DocCtrl` in the workflow treats it as a
**senior approver who does not need engineering review** — grouped with
management for IFC sign-off. That is the opposite of a controlled-release
function.

Document control has:

- no state that waits on them
- no action offered to them at any state
- no routing that reaches them
- no capability that names them

…and an attention badge that says they must act on two states where the engine
gives them nothing (`FRIC-7`).

**Failure scenario.** The IFC package is issued and the requester acknowledges.
The ticket closes. **Document control never saw it.** Whether the deliverable is
numbered correctly, carries the right title block, supersedes the right revision,
or belongs in that library at all — none of it was checked by the function whose
job that is. The controlled register learns about the drawing only if somebody
separately uploads it (`DCW-4`).

**Chain reaction.** ⚠ **Do not fix this by adding a `PENDING_DOC_CTRL` status.**
That is a serial hop on every ticket (`TIER-5`, `FRIC-1`) and the stated
constraint is no new friction. `GAP-104` specifies release as a **per-library
rule evaluated on a parallel roster** — the libraries that need controlled
release get it; the rest never see it; and where it applies it runs alongside the
technical review rather than after it.

Note the intent was already there: whoever wrote `ticketAttention.ts:106`
believed document control belongs at issue and release. **They were right about
the model and the flow never implemented it.**

**Done when.**
1. A library can require document-control review before its drawings are
   released.
2. Satisfying that requirement adds no serial status hop.
3. A document controller's attention badge reflects work they can actually do.

---

## DCW-3 · No drawing-type dimension exists to route on

- **Severity:** MEDIUM
- **Status:** WONTFIX
- **Verification:** CONFIRMED
- **Blast radius:** compliance / friction
- **Locations:**
  - `lib/docClass.ts:28` — `DocClass = "drawing" | "procedure"` — two values, and it lives on the document, not the ticket
  - `types/schema.ts:1019` — `RequestType = string`, unvalidated
  - `types/schema.ts:760` — `issueType?: "Internal Review" | "Issued for Construction" | "As-Built" | "Void"` — on the document version
  - `lib/filenameParser.ts:36` — infers As-Built from filenames, evidence the concept is load-bearing
- **Related:** `DCW-1`, `TIER-2`, `LIFE-11`
- **Re-verified:** hardening pass — **SURVIVES**. `RequestType` is an unconstrained `string` (`types/schema.ts:1019`) and no drawing-type field exists anywhere. Same substrate as `TIER-2`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The claim of absence is refutable: an org can already record drawing type on a ticket today, either by redefining the request_type option list (it is free-form per-org config, not an enum) or by adding a required select field in an admin custom category. What genuinely does not exist is any *consumer* — resolveTicketRecipients switches on status only, so nothing can route on the dimension even once captured. Downgrading to MEDIUM since the missing piece is a routing rule, not a schema field.

**Mechanism.** "Specific types of drawings" needs a type taxonomy. The nearest
things that exist are `docClass` (two values, document-scoped) and `request_type`
(free text, ticket-scoped, unvalidated). Neither distinguishes a P&ID from an
isometric from a loop sheet from a sketch — which is the distinction the routing
rule needs.

**Failure scenario.** The rule the supervisor wants is *"P&IDs and process
datasheets go through doc control for release; field sketches and markups do
not."* There is no field that separates them. The closest available proxy is the
library the drawing lives in — which is itself unavailable on the ticket
(`DCW-1`).

**Chain reaction.** The library **is** the right proxy and it is better than a
type enum: an org that keeps P&IDs in a P&ID library gets the routing for free,
without maintaining a parallel taxonomy, and the resolution pattern already
exists (`docClass` and `review_control` both resolve document → folder →
library). Adding a per-drawing-type enum on top would be a second classification
to keep in sync with the first.

**`GAP-104` therefore routes on the library, with drawing type available as an
optional narrowing** — not the other way round.

**Done when.** A release-routing rule can be expressed once per library and
inherited, without maintaining a separate drawing-type taxonomy.

**WONTFIX (2026-10-13, drafting-flow Round G).** DF-P4 LIBRARY. Recorded by design once `tickets.library_id` exists (`DCW-1`, `20261208`), as the fleet plan's dependency and `99-fix-sequencing.md` "Do not do these" require: *"Build a drawing-type taxonomy — The library is the better routing proxy and already inherits. `DCW-3`."* The dimension the routing rule needs is now on the ticket — the library, derived from the source document or set at triage — and every library-scoped policy already resolves document → folder → library (`lib/containerChain.ts`, DEC-36).
- **Cost of building it:** a second classification (drawing type) to keep in sync with the library tree on every document and ticket, a new vocabulary per org, and a field the requester often cannot answer (the "required field they cannot answer" the sequencing file forbids).
- **Rejected alternative:** a per-drawing-type enum on the ticket (or validated `request_type` values per type). `request_type` stays the org's free list (WF-15 validates it against the configured options).
- **What would change the answer:** an org whose libraries do not separate the drawing types it routes differently (P&IDs and sketches in one library) and that cannot reorganise them — then `GAP-104`'s "drawing type as an optional narrowing" on top of the library rule is the shape, not a taxonomy replacing it.

**Done-when.** ✓ (by design) A release-routing rule can be expressed once per library and inherited: the ticket carries the library (`DCW-1`), and the rule itself is `GAP-104` (DF-P6).

**Scope / residual.** None for this finding.

---

## DCW-4 · The deliverable never enters a controlled library — the flow ends at an attachment

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / safety
- **Locations:**
  - `lib/ticketTransitions.ts:280-283` — `submit_final` appends the file to the ticket's `attachments` JSONB
  - `lib/ticketTransitions.ts:284-287` — `close_ticket` is three lines: `updates.status = "CLOSED"`
  - `app/api/tickets/workflow-action/route.ts:263-270` — the only document-side effect of closure **deletes** the drafter's `document_intents` row
- **Related:** `LIFE-1`, `GAP-6` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**. `submit_final` appends to `currentAttachments` (`ticketTransitions.ts:282`) and `close_ticket` sets `CLOSED` (`:286`). Nothing on the path creates a document version. Same root as `roles-and-permissions/LIFE-1`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed exactly as stated. The issued package is a JSONB attachment on the ticket row; the register learns nothing. `document_versions.related_ticket_id` exists in the schema (supabase/schema.sql:334) and is mapped on read, but no code ever populates it — the intended link is declared and unused.

**Mechanism.** The IFC package lives on the ticket as an attachment and stays
there. Nothing writes `document_versions`, nothing touches `documents.rev`,
nothing tells document control a drawing is ready to register.

**Failure scenario.** A drawing is issued for construction, the field builds to
it, and the controlled register never learns it exists. Six months later the
document control library still shows the superseded revision — or nothing at all,
for a new drawing — while the accurate copy sits on a closed ticket.

**Chain reaction.** Recorded in full as `LIFE-1` and specified as `GAP-6` in the
roles-and-permissions area. It appears here because **it is the same missing
seam as `DCW-2`, seen from the other end**: document control is absent from the
flow *and* the flow's output never reaches document control. Fixing one without
the other leaves a controller reviewing a deliverable they then cannot register,
or registering one they never reviewed.

⚠ `DEC-23` (delete the `related_ticket_id` review waiver) must land before any
work here.

**Done when.** See `LIFE-1` / `GAP-6`. Additionally: the register knows about
every issued deliverable, or visibly knows it does not.

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. `LIFE-1` / `GAP-6` landed (roles-and-permissions [`LIFE-1`](../roles-and-permissions/07-document-lifecycle.md), `a84f712`, migration `20261049` **applied & verified live 2026-09-02**), and `DEC-23` landed first (`lib/reviewControl.ts:98-111` takes no ticket id — `PROJ-11`). For a ticket with a source document the register either receives the deliverable ("Publish as revision of …", `app/(protected)/requests/[id]/page.tsx:2165-2175`, recorded by `/api/tickets/handback`) or visibly does not (`metadata.deliverable.state = "not_in_register"` on close, `app/api/tickets/workflow-action/route.ts:397-414`; amber chip at `page.tsx:2160-2164`).

**Done-when.**
- ✗ (in part) See `LIFE-1` / `GAP-6`. ✓ A ticket-originated publish goes through `assertCanPublishRevision` and fires `runPostPublishSideEffects` (it is a `revUpDocument` call). ✓ on an unwritten row, ✗ in general: closing leaves a queryable not-in-register state — but the state lives in `tickets.metadata`, which any member can write from the browser (`metadata` is not in `ticket_update_guard`, `supabase/migrations/20261038_rp_phase4_ticket_workflow_rails.sql:184-205`; the `SM-2` / `PERS-1` residual, **DF-P1**). (a) The close decides from it: the note runs only `if (src?.id && deliverableStateOf(ticket.metadata)?.state !== "published")` (`app/api/tickets/workflow-action/route.ts:400`), and `noteDeliverableNotInRegister` returns `null` over a `published` state (`lib/ticketHandback.ts:101-102`; `deliverableStateOf` accepts any string `version_id`, `:73-79`). So a member who writes `metadata.deliverable = { state: "published", version_id: "<any string>", revision_label: "9" }` before the close gets no not-in-register state, no history line and no note — and the page shows a green "Published as Rev 9" (`app/(protected)/requests/[id]/page.tsx:1636`, `:2155-2159`) with nothing in the register. (b) After the close, any member can erase or overwrite the state. `LIFE-1` done-when 1 says closing such a ticket *leaves* the state, "not silence", for every close; on path (a) the close leaves silence and a false "published", so it does not hold as written. *Overstated (records fix, 2026-10-02): this line read "✓ … closing leaves a queryable not-in-register state", with no caveat.*
- ✗ (in part) "The register knows about every issued deliverable, or visibly knows it does not" holds only for tickets with a source document: the not-in-register note runs only `if (src?.id && …)` (`route.ts:400-401`). A new drawing requested with no source document still ends at an attachment with no register-side trace. And where it holds, what is "known" is the forgeable `metadata.deliverable` above, not a register-side record (records fix).

**Scope / residual.** Handed on, binding (fleet plan): a ticket with no source document still ends at an attachment → **DF-P4** (`GAP-105` — the ticket gets a library, so "publish as a new document in library X" has a target). Added by the records fix (2026-10-02): the forgeable deliverable state → **DF-P1** — `metadata` service-only in its `ticket_update_guard` re-creation (brief item (a) already makes every column the app does not write from the browser service-role, and no browser path writes `metadata`), and the close-time check reading a `published` deliverable against the register (`document_versions.related_ticket_id`, written by `20261049`, or the recorded `version_id` in the ticket's org) rather than trusting `metadata` alone. DF-P1's brief does not name `DCW-4`; the integrator adds it, so DF-P1's close re-checks this done-when (`99-fix-sequencing.md`, "Hand-offs from DF-P0").

**Partial (2026-10-02, drafting-flow Round G).** DF-P1 RAILS — the forgeable not-in-register state (the records fix's DF-P1 limb) is closed; tickets with no source document are DF-P4's, so this stays OPEN.
- `tickets.metadata` is service-only in the re-created guard (`20261166:280`; a member's write is refused — C11 on a throwaway PostgreSQL 16 built from the real function bodies, in both foreign-key worlds (orphan intents present / absent), the script applied four times in each (idempotent; 13 of 13 probes true every time)). **Pending migration:** `supabase/migrations/20261166_df_roundG_ticket_rails.sql` (`DEC-30`: one paste, not a widening, after `20261038` / `20261039`, and after the DF-P1 app deploy, never before it: `AUTHZ-13`, "Paste order") — the database half is not closed in any database until it is pasted.
- `app/api/tickets/workflow-action/route.ts:544-578` — a close no longer believes a recorded `published` deliverable on its word: it looks for the `document_versions` row the record names, **in the ticket's org, of the source document, carrying this ticket as its provenance** (`related_ticket_id`, written by `20261049`; the proof `/api/tickets/handback` checks before recording one). If the read **succeeds and finds no such row**, the close records the deliverable as **not in the register**: the state, a `"Closed — deliverable not in the register"` history line, and the note that the recorded publication could not be matched. That replaces the false `published`. A read that **fails** (a timeout, a dropped connection) proves nothing. It is a 503 `register_unreadable` returned before the close writes anything (the hold release included), so a real publication is never rewritten as not in the register. A recorded id that is not a UUID cannot name a register row, so it counts as unbacked without a read. *(DF-P1 fix pass, 2026-10-02: the first version treated a failed read as proof the publication was unbacked, and so rewrote real publications whenever the read hiccupped.)* Tests: `lib/__tests__/dfRoundG_P1_rails.test.ts:960`, "DCW-4 / HAND-3 (DF-P1 limb)": a hand-written `published` with no backing version closes as not in the register (fails on the base code); a backed one closes clean; a failed register read is a 503 with no ticket, hold, audit or notification write, and the retry closes clean; a non-UUID id is unbacked with no read.
- Paste-time inventory: tickets with a source document already recording a `published` deliverable the register does not back, using the close's own predicate (the version must also be of that source document, `v.record_id`, fix pass). They are counted, not rewritten; a close now marks them.

**Done-when.**
- ✓ (for a ticket with a source document) `LIFE-1` done-when 1 now holds as written: closing leaves the queryable not-in-register state unless the register backs the publication, and after the paste no member can write or erase that state. The state is written only on a register read that succeeded; a failed read refuses the close instead of guessing.
- ✗ (in part) "The register knows about every issued deliverable, or visibly knows it does not" still holds only for tickets with a source document.

**Scope / residual.** Tickets with no source document → **DF-P4** (`GAP-105`, fleet plan).

**Partial (2026-10-13, drafting-flow Round G).** DF-P4 LIBRARY — the source-less limb handed on by DF-P0 / DF-P1.
- A request with **no source document but a target library** (`GAP-105`) that closes without a published deliverable now closes visibly not in the register: `metadata.deliverable = { state: "not_in_register", document_id: null, library_id, … }` (`lib/ticketHandback.ts` `noteDeliverableNotInLibrary`; `deliverableStateOf` reads the shape), a "Closed — deliverable not in the register" history line naming the library and the note in the close notice (`app/api/tickets/workflow-action/route.ts:884-904`). The line and the notice are read by the requester and every watcher, so a hidden / private library — or a normal one whose ACL carries any rule — is called "the target library", never by its name (`lib/ticketLibrary.ts` `libraryLabelForTicket`; *corrected at the DF-P4 fix pass* — the first version read the name as the service role and wrote it whatever the library's visibility; *and at the second fix pass* — a normal library with an ACL deny on a role or a team was still named, though `canDiscover` hides it from those members; the close branch now reads `acl` with `name, visibility`). A request with neither a source document nor a library closes exactly as before (no metadata written) — `lib/__tests__/dfRoundG_P4_library.test.ts`, "DCW-4 (DF-P4 limb)".
- **Not built: "Publish as a new document in <library>".** It cannot go through the same path (DEC-22): `RevUpModal` / `revUpDocument` revise an EXISTING document, and the new-document path (`lib/revisions.ts:820` `createDocumentWithFile`) takes no `relatedTicketId`, so no new document's first version can carry the ticket as its provenance — the proof `/api/tickets/handback` checks. `lib/revisions.ts` is document-control P23's file (do-not-edit for this package), and the offer itself sits on the ticket page (`app/(protected)/requests/[id]/page.tsx`, DF-P9 / DF-P10).

**Done-when.**
- ✗ (in part) See `LIFE-1` / `GAP-6` (unchanged).
- ✗ (in part) "The register knows about every issued deliverable, or visibly knows it does not" now holds for tickets with a source document (DF-P1) and for tickets with a library (this limb, after `20261208`); a ticket with neither still ends at an attachment with no register-side trace (it names no place in the register to be missing from).

**Scope / residual.** (a) `createDocumentWithFile` writes `related_ticket_id` (a `relatedTicketId` input, as `revUpDocument` has) → **document-control** (P23's successor on `lib/revisions.ts`); (b) the ticket page offers "Publish as a new document in <library>" through that path and `/api/tickets/handback` accepts a version of a NEW document in the ticket's library carrying the ticket → **DF-P9 / DF-P10** with (a); (c) a source-less, library-less request → triage sets a library (`DCW-1`).

---

## DCW-5 · A request cannot be filed against a document the requester cannot see

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED — the mechanism is confirmed; the frequency in practice was not observed
- **Blast radius:** friction / adoption
- **Locations:**
  - `app/(protected)/requests/new/page.tsx:290-298` — `metadata.source_document` written from `sourceDocId`, which arrives as a query parameter from the document viewer
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:85-91` — `documents_acl_select` filters the document row entirely when `node_visible` is false
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:42-82` — `node_visible` has no ownership branch (`DEL-2`) and reads the singular role (`DB-7`)
- **Related:** `DCW-1`, `DEL-2` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**. `documents_acl_select` is `AS RESTRICTIVE FOR SELECT USING (node_visible(...))` (`20260708_acl_rls_enforcement.sql:86-87`), so a document the requester cannot read cannot appear in the picker that populates `metadata.source_document` (`requests/new/page.tsx:290-298`). The person who spots the error on a printed sheet is the one who cannot file about it.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Factually correct: the only two ways to attach a source document both require the requester to have the document open, and RLS hides private/hidden documents from anyone without an explicit grant. But the consequence is degraded triage and a dark Impact panel, not incorrect data or an unsafe release — and the RLS behavior itself is the correct ACL outcome. MEDIUM, not HIGH.

**Mechanism.** The only way to attach a source document is to arrive from the
document viewer with `?sourceDocId=…`. A requester who cannot *see* a restricted
drawing cannot open it, so cannot reach the form with the linkage, so files a
request that names the drawing in prose only.

**Failure scenario.** An operations tech needs a change to a P&ID in a restricted
library. They can describe it and cannot link it. The ticket arrives with a
document number typed into the description. Triage has to find the drawing by
hand, and every downstream mechanism that keys on `metadata.source_document.id`
— the Impact panel, the intent bridge, overlap advisories — is blind to it
(`LIFE-4`).

**Verification note.** Marked `SUSPECTED` deliberately: the RLS filtering and the
query-parameter-only linkage are both confirmed by reading, but how often a
requester legitimately needs to reference a document they cannot open depends on
how restrictively libraries are configured in practice, which cannot be
determined from the repository. **Reproduce before fixing.**

**Chain reaction.** "Request a change to a document I cannot open" is a legitimate
and common need — it is arguably *the* case document control exists to mediate.
The clean shape is a **discover-but-not-read** grant, which the ACL already
supports (`visibility: hidden` plus an explicit `discover` action). The mechanism
exists; the request form does not use it.

**Done when.**
1. A requester can name a document they cannot open, and the resulting ticket
   carries a real `source_document.id`.
2. Doing so does not disclose the document's content.

**Resolution (2026-10-13, drafting-flow Round G).** DF-P4 LIBRARY. **Reproduced first, with a private library (by reading the live bodies):** `documents_acl_select` is `AS RESTRICTIVE FOR SELECT USING (node_visible(…))` (`20261037:110-111`), and `node_visible`'s newest body (`20261203`) lets a row through for controllers, the effective owner, and **any allow grant of any action** — "Any allow grant (any action) lets the row through; finer read-vs-discover distinctions stay in the app layer" (`20261203:243-249`). So the finding's mechanism holds only in part on HEAD: (a) a requester with **no** grant on a private library is not shown the document at all — the correct ACL outcome (they may not know it exists; the independent pass agreed), and the create route, which reads source documents as the requester (DEC-101 item 5, `app/api/tickets/create/route.ts:230`), drops such an id with a warning; (b) a requester holding a **discover-only** grant IS returned the row by the database and the route links it — but the request form offered no way to name a document except arriving from the viewer with `?sourceDocId`, and the viewer serves no content to a discover-only grant (`lib/permissions.ts` `canServeContent`). (b) is what reproduced.
- `app/(protected)/requests/new/page.tsx`: with no hand-off, "Document this request is about (optional)" — a number / title search through the requester's own session (`.from('documents').select('id, document_number, title, rev')`, `:138`; the text made safe for the PostgREST filter by `lib/ticketLibrary.ts` `linkableDocumentQuery` / `linkableDocumentFilter`). A pick is sent as the primary source document (`:365`), so the route re-reads it as the requester, captures its version, derives the request's library (`DCW-1`) and its unit. The card says "Linked by number only — no file is attached and none of the document's content is copied into the request".
- Tests: `lib/__tests__/dfRoundG_P4_library.test.ts` ("linkableDocumentQuery", the source pins on the form); the route's caller-scoped read of a document the requester cannot see is pinned by `ticketCreateRoute.test.ts` ("a source document the requester cannot see lends no library").

**Done-when.**
1. ✓ A requester can name a document they cannot open — any document the database lets them discover (a discover grant, ownership, a normal library) — and the ticket carries its real `source_document.id`. One they may not even discover stays unnameable by design.
2. ✓ No content is disclosed: the search selects number, title and revision only (what a discover grant shows in a listing), no file is attached, and the route reads nothing more than the hand-off always did.

**Scope / residual.** The ticket page's "restricted — triage can open it" label for a source the viewer cannot open is the page's (DF-P9). `DEC-44 (DF-P4)` item 4.

---

## DCW-6 · The library's own review policy is invisible to the drafting flow

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance
- **Locations:**
  - `types/schema.ts:191-210` — `ReviewControl` with `reviewerIds` / `reviewerRoles` / `reviewerTeamIds`
  - `lib/reviewControl.ts:527,575-579` — resolution: document → folder → library
  - `lib/workflow.ts:61-65` — `getActions` receives `ticket`, `userRole`, `userId`, `policy`. **No library, no review control, no document context.**
- **Related:** `DCW-1`, `TIER-5`, `TIER-8`
- **Re-verified:** hardening pass — **SURVIVES**. `ReviewControl` is a real, well-formed structure on libraries (`types/schema.ts:191-202`) that `reviewControl.ts:527` reads per library — and the ticket has no library to resolve it against (`DCW-1`). The policy exists and the flow cannot see it.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and the mechanism is worse than the summary suggests: the escape hatch built for exactly this case is dead code, so the ticket neither consults the library's ReviewControl (types/schema.ts:191-210 reviewerIds/reviewerRoles/reviewerTeamIds) during the flow nor marks its output as pre-reviewed — the named reviewers are asked at publish time, after close. The cited line numbers (reviewControl.ts:527, 575-579) point into scanReviews rather than the relevant code at :55-62, but the substance holds.

**Mechanism.** A library can already declare "revisions here need these two
reviewers." The drafting flow that produces those revisions cannot read it —
`getActions` has no parameter through which it could.

**Failure scenario.** The Process Safety library requires two named reviewers.
A drafting request produces a revision for it and routes through the ticket's
own role-based approval, which knows nothing about those two people. They are
asked to review at *publish* time instead — after the ticket closed — which is
`TIER-8`'s duplicate-review problem.

**Chain reaction.** Once `DCW-1` gives the ticket a library, this becomes small:
resolve the library's `review_control` and use it. That is also exactly the
mechanism `TIER-5` and `GAP-103` propose for the parallel roster, so the two
converge on one implementation.

**Done when.** A ticket targeting a library with a configured review policy
surfaces that policy's reviewers, before the deliverable is approved rather than
after.

---

## DCW-7 · `unit` is the only locator, and it is free text

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** drafting-flow DF-P4 LIBRARY (triage sets the unit: `assign` / `request_eng_review` at `PENDING_ASSIGNMENT` carry a `unit` validated against `unitOptionsFor`, clearing the unknown / unlisted / unchecked marks with a history line) — by the integrator, 2026-10-13 (at the DF-P2 merge, DEC-31: DF-P2 has merged and named these limbs in drafting-flow `99-fix-sequencing.md`, "Hand-offs from DF-P2"; fleet plan updated).
- **Verification:** CONFIRMED
- **Blast radius:** data quality
- **Locations:**
  - `app/(protected)/requests/new/page.tsx:466-469` — free-text `unit` input, force-uppercased, when no org unit list is configured
  - `app/(protected)/requests/new/page.tsx:139-153` — the Site Codebook provides options when configured, and the first option is auto-selected
  - `components/documents/CheckInPanel.tsx:236-267`, `lib/transitionIn.ts:304-331` — both omit `unit`
- **Related:** `FRIC-3`, `FRIC-8`, `DCW-1`
- **Re-verified:** hardening pass — **SURVIVES**. `unit` is a `required` free-text input upper-cased on change (`requests/new/page.tsx:466-469`); the codebook only *optionally* supplies options, and the catch comment says so outright — *"codebook optional — free-text unit input remains"* (`:149`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The 'free text' characterization is only true in the unconfigured fallback — the default and codebook-backed paths render a constrained Select. The finding's actual consequence survives on stronger grounds than it cites: two of the three ticket-creation paths write no unit whatsoever, so unit-filtered queue views and area reporting silently drop check-in and intake-collision tickets entirely. MEDIUM is right.

**Mechanism.** With the Site Codebook configured, `unit` is a clean enum. Without
it, it is whatever the requester types. The same physical area can arrive as
`20-CRUDE`, `UNIT 20`, `U20` and `20`.

**Failure scenario.** Unit-filtered queue views miss tickets. Reporting by area
is unreliable. And because `unit` is the *only* locator a ticket has, its
looseness is inherited by everything downstream that tries to group work
geographically.

**Chain reaction.** The Site Codebook is already the right answer and is already
wired as the option source. The gap is the unconfigured case falling back to free
text rather than to a prompt to configure it. This becomes much less load-bearing
once `DCW-1` gives tickets a real container reference.

**Done when.** `unit` resolves against the org's codebook where one exists, and
the unconfigured case is visibly a setup gap rather than a free-text field.

**Partial (2026-10-07, drafting-flow Round G).** DF-P2 CREATE, on `DEC-101` item 1.
- **Resolved against the list — one list for the form and the route.** `lib/ticketCreate.ts` `unitOptionsFor` takes the saved units, else the Site Codebook's (`codebook_entries`), else none; the request form and the create route both call it (`app/(protected)/requests/new/page.tsx:200`, `app/api/tickets/create/route.ts:406`), and the form's built-in settings carry no units, so the form never offers a unit the route refuses. `resolveUnit` matches a value or a label (case and spacing folded). A request-form unit that is not on the list is refused (400, field `unit`); a unit derived from a source document tries its metadata unit, then its `unit_code`, keeps the first on the list, and otherwise keeps the first given and marks `metadata.unit_unlisted` (`resolveDerivedUnit`). `lib/__tests__/ticketCreateRoute.test.ts`, "the request form's unit must be on the list…", "with no configured units the Site Codebook's are the list", "FRIC-3 / DCW-7 — one unit list for the form and the route; a derived unit tries each candidate"; `lib/__tests__/requestFormCreate.test.ts`, "DCW-7 — the form offers the route's unit list, never a built-in one" (a workspace with no saved settings and a codebook is offered the codebook's units). *(Corrected at DF-P2's review fix, 2026-10-07: the form first fell back to two built-in units whenever no settings row existed, which the route refused, and a derived `unit_code` was preferred over a metadata unit that matched the list.)*
- **A list that cannot be read fails visibly, the same way on both sides (third review fix, 2026-10-13).** Both sides class a failed `codebook_entries` read with `lib/ticketCreate.ts` `unitListReadFailure`. A codebook that is not there yet is "missing", which means no list. One that is there but did not answer is "unreadable". In that case the form shows "Couldn't load this workspace's unit list — retry, or file the request with no unit" with a retry, offers no free-text box, and sends no unit (`lib/ticketCreateClient.ts` `loadCodebookUnitList`; the page no longer uses `lib/codebook` `loadCodebook`, which answers an empty codebook for a failed read). The route files any unit it was given, typed or derived, as "Unit unknown". It keeps the unit as `metadata.unit_unchecked`, and its `warnings` say so (`app/api/tickets/create/route.ts:509-514`). `lib/__tests__/ticketCreateRoute.test.ts`, "DCW-7 / FRIC-3 — a unit list that cannot be read fails visibly, and the same way as the form"; `lib/__tests__/requestFormCreate.test.ts`, "DCW-7 / FRIC-3 — a unit list that cannot be read is said, and the form and the route agree". *(Corrected at DF-P2's third review fix: both sides first swallowed a failed codebook read into "no list". If the form's read failed and the route's did not, a typed unit was refused against a list the page never showed. If the route's read failed, a unit the list did not carry was stored unmarked.)*
- **The unconfigured case.** With no unit list the box is optional and says it is a setup gap ("This workspace has no unit list yet — an admin can add one in Admin → Site Codebook…"), and an empty answer files as the explicit "Unit unknown". The box still takes free text, so a requester who knows the unit can say it.

**Done-when.** ✓ `unit` resolves against the org's codebook (or configured list) where one exists. ✗ (in part) The unconfigured case is visibly a setup gap, but it is still a free-text field: removing it would discard what a requester knows with no list to pick from (`DEC-101` item 1 keeps it, reversible in one line). And the "triage assigns" half has no action yet: nothing at triage sets the unit on a "Unit unknown" ticket.

**Scope / residual.** A triage `unit` (on `assign` / `request_eng_review` at `PENDING_ASSIGNMENT`, validated against `unitOptionsFor`, clearing `unit_unknown` / `unit_unlisted`) → proposed **DF-P4**, whose brief already adds a `libraryId` to those actions; the free-text box is the user's to keep or remove. Both in `99-fix-sequencing.md`, "Hand-offs from DF-P2".

**Partial (2026-10-13, drafting-flow Round G).** DF-P4 LIBRARY — the "triage assigns" half (`DEC-101` item 1).
- `assign` / `request_eng_review` at `PENDING_ASSIGNMENT` take `body.unit` (`app/api/tickets/workflow-action/route.ts:615-637`), resolved against the SAME list the form offers and the create route checks (`lib/ticketCreate.ts` `unitOptionsFor` / `resolveUnit`: the saved units, else the Site Codebook's): not on the list → 400 `field: "unit"`, nothing written; no list → the free text kept (DEC-101 item 1); a codebook that is there but cannot be read → 503 (`unitListReadFailure`), never an unchecked unit. `computeTransition` writes it on the same compare-and-set, removes `metadata.unit_unknown` / `unit_unlisted` / `unit_unchecked`, and writes "Triage details set — Unit: X (was unknown)" (`lib/ticketTransitions.ts:420-454`). Tests: `lib/__tests__/dfRoundG_P4_library.test.ts` (the route: on the list, off the list, no list, unreadable; `computeTransition`: marks cleared, history line, REGRESSION with no input).

**Done-when.** ✓ `unit` resolves against the org's codebook (or configured list) where one exists — at intake (DF-P2) and now at triage. ✗ (in part) The unconfigured case is visibly a setup gap but still a free-text field (`DEC-101` item 1 keeps it); and no screen sends the triage `unit` until the assign modal does (DF-P9).

**Scope / residual.** The assign modal's unit field (beside `LibraryPicker`) → **DF-P9**; the free-text box stays by `DEC-101` item 1.

---

## Verified sound — do not break

1. **The container-chain resolution pattern.** `docClass`
   (`lib/docClass.ts:49-58`) and `review_control` (`lib/reviewControl.ts:527`)
   both resolve document → folder → library, most specific **defined** level
   wins, so a controller declares once per library and everything inherits.
   **This is the right pattern for work class, for release routing and for
   review policy — reuse it rather than inventing a parallel taxonomy.**
2. **The ACL's `discover` action and `hidden` visibility.** The primitive needed
   for `DCW-5` — name a document without disclosing it — already exists and is
   database-enforced.
3. **`generateTicketNumber`** — atomic and human-readable, so a ticket can be
   referenced in a title block or a transmittal.
4. **`metadata.source_document`'s shape** — `{ id, document_number, title, rev, path }`
   is the right structured backlink, written by all three creation paths. Its
   problems are that it is single-valued (`GAP-8`), sometimes dropped
   (`LIFE-4`) and never rendered (`LIFE-13`) — not that it is wrong.
5. **The intake redline round-trip** (`lib/transitionIn.ts:270-371`,
   `/api/intake/*`) — bidirectional, authorized, audited, and it **verifies the
   link owns the ticket before attaching**. It is the best-implemented hand-off
   in the codebase and the template the internal seams should follow.
