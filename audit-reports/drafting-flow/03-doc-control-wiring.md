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

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / architecture
- **Locations:**
  - `types/schema.ts` — the `Ticket` interface. **There is no `libraryId`, no `collectionId` and no target-container field of any kind.** (`libraryId` appears six times in `types/schema.ts`, on documents, collections, versions, packages and knowledge sources — never on `Ticket`.)
  - `app/(protected)/requests/new/page.tsx:286-330` — the insert row: `org_id, ticket_id, title, description, unit, request_type, priority, status, requester_*, attachments, history, comments, unread_by, watchers, target_completion_at`. No library.
  - `app/(protected)/requests/new/page.tsx:290-298` — the only document linkage is `metadata.source_document`, written **only when `sourceDocId` is present**
- **Related:** `DCW-2`, `DCW-3`, `TIER-2`, `GAP-104`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The `Ticket` type carries **zero** fields naming a library or collection, so there is no value for a library-scoped rule to key on.

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

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / friction
- **Locations:**
  - `lib/docClass.ts:28` — `DocClass = "drawing" | "procedure"` — two values, and it lives on the document, not the ticket
  - `types/schema.ts:1019` — `RequestType = string`, unvalidated
  - `types/schema.ts:760` — `issueType?: "Internal Review" | "Issued for Construction" | "As-Built" | "Void"` — on the document version
  - `lib/filenameParser.ts:36` — infers As-Built from filenames, evidence the concept is load-bearing
- **Related:** `DCW-1`, `TIER-2`, `LIFE-11`
- **Re-verified:** hardening pass — **SURVIVES**. `RequestType` is an unconstrained `string` (`types/schema.ts:1019`) and no drawing-type field exists anywhere. Same substrate as `TIER-2`.

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

---

## DCW-5 · A request cannot be filed against a document the requester cannot see

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** SUSPECTED — the mechanism is confirmed; the frequency in practice was not observed
- **Blast radius:** friction / adoption
- **Locations:**
  - `app/(protected)/requests/new/page.tsx:290-298` — `metadata.source_document` written from `sourceDocId`, which arrives as a query parameter from the document viewer
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:85-91` — `documents_acl_select` filters the document row entirely when `node_visible` is false
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:42-82` — `node_visible` has no ownership branch (`DEL-2`) and reads the singular role (`DB-7`)
- **Related:** `DCW-1`, `DEL-2` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**. `documents_acl_select` is `AS RESTRICTIVE FOR SELECT USING (node_visible(...))` (`20260708_acl_rls_enforcement.sql:86-87`), so a document the requester cannot read cannot appear in the picker that populates `metadata.source_document` (`requests/new/page.tsx:290-298`). The person who spots the error on a printed sheet is the one who cannot file about it.

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
- **Verification:** CONFIRMED
- **Blast radius:** data quality
- **Locations:**
  - `app/(protected)/requests/new/page.tsx:466-469` — free-text `unit` input, force-uppercased, when no org unit list is configured
  - `app/(protected)/requests/new/page.tsx:139-153` — the Site Codebook provides options when configured, and the first option is auto-selected
  - `components/documents/CheckInPanel.tsx:236-267`, `lib/transitionIn.ts:304-331` — both omit `unit`
- **Related:** `FRIC-3`, `FRIC-8`, `DCW-1`
- **Re-verified:** hardening pass — **SURVIVES**. `unit` is a `required` free-text input upper-cased on change (`requests/new/page.tsx:466-469`); the codebook only *optionally* supplies options, and the catch comment says so outright — *"codebook optional — free-text unit input remains"* (`:149`).

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
