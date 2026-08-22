# 90 · GAP REGISTER — requirements with no implementation

> # ⛔ NOTHING IN THIS FILE IS A WORK ORDER
>
> **A `GAP-` entry describes a feature that does not exist.** It is not a bug, it
> is not a defect, and it is **not authorization to build anything.**
>
> **If you are an agent working this directory: do not implement a `GAP-`
> entry.** Read it, understand it, and if it blocks a finding you were fixing,
> **stop and say so.**
>
> Building any of these is a design decision with a schema, a UI, a migration and
> a cost. It needs a human to scope it and approve it. These are recorded here so
> the requirement is not lost, and so that a resolving agent who trips over one
> knows why the code looks incomplete.
>
> Every entry names **what exists nearest**, so nobody re-derives it from
> scratch. That is the entry's whole purpose.

---

## Where these came from

Entries `GAP-1` through `GAP-6` are requirements the system's owner stated
directly. The rest were found during the audit — capabilities the code reaches
for and does not have.

---

## GAP-1 · Only certain people can approve certain types of requests

**The requirement.** *"The issue mostly is that in the drafting work flow only
certain people can approve certain types of requests."*

**What exists nearest.** The capability policy —
`policyAllows(policy, cap, role, extraRoles, uid)`. It is a genuinely good
design: 17 capabilities, org-configurable role tokens, per-person grants with
expiry, server-enforced, fully audited.

**Why it cannot express this.** **`policyAllows` takes no resource argument.**
The policy is a flat `capability → role-token[]` map. `RequestType` is
`export type RequestType = string` (`types/schema.ts:1019`), open and
org-configurable, and it reaches an authority decision in exactly **one** place
in the entire codebase — the `close_rfi` branch at `lib/workflow.ts:185`.

Anyone holding `ticket.direct_approve` can approve **every** type of request.

**What building it would touch.** Adding a resource dimension to `policyAllows`
is a signature change reaching `lib/workflow.ts:65`, `lib/holds.ts:100`,
`components/permissions/ViewAsSimulator.tsx:128`, and the SQL
`org_capability_allows` — **all four must move together**, or the role-resolution
divergence in `WF-7` gets worse. It also needs `WF-15` (request types are not
validated anywhere) resolved first, or the new authority dimension keys off an
unvalidated free-text string.

**Related findings:** `DRAFT-1`, `WF-13`, `WF-15`, `WF-8`.

---

## GAP-2 · Nobody approves their own work (separation of duties)

**The requirement.** Implied by the drafting-triage requirement, and independently
required by PSM practice.

**What exists nearest.** Nothing. Four complete single-person loops exist and are
documented in `WF-4`. `lib/workflow.ts:47-53` sends every request straight to
`PENDING_ASSIGNMENT` with no initial gate, and `assign` does not exclude
self-assignment.

**The catch that makes this a gap rather than a bug.** The single-operator loop
appears to be **intentionally supported** — a small shop where one person does
everything. So this cannot be a hard rule; it has to be an org-level toggle with
sensible defaults, or every single-operator customer breaks on upgrade.

The same gap exists independently on the **document** side: an owner can be the
sole reviewer of their own revision (`DEL-5`), because the review-completion gate
counts signed primaries without checking who they are.

**Related findings:** `WF-4`, `WF-14`, `DEL-5`.

---

## GAP-3 · A library owner delegates a specific file to a person, without transferring ownership

**The requirement.** *"I need to be able to assign library owners and library
owners need to be able to assign people from their team or just a profile if not
using teams to delegate a specific file."*

**What exists nearest — and it is closer than it looks.** Two mechanisms exist
and both are the right shape:

- **The ACL user-subject.** `PermissionSubjectType = "user" | "team" | "role" | "org"`
  (`types/schema.ts:96`), per node, per action, with `AccessRule.expiresAt`
  (`types/schema.ts:107`). The database honours user and team grants identically
  (`20260812:65-85`), and `can_manage_node` already honours a `managePermissions`
  grant (`20260816:72-76`). **This is exactly the carrier the requirement needs,
  and it handles both the "team member" and "named individual" cases
  symmetrically.**
- **`capabilityPolicy.UserGrant`** — per person, expiring, additive, audited. But
  its `CapabilityId` union contains **no document or library capability and no
  node scope**; it covers tickets, holds, checkout force-release and two admin
  pages. It structurally cannot say "this person, this file."

**Why the requirement is unmet.** Two separate blockers:

1. **The owner cannot reach the ACL editor.** All three permission-drawer
   instantiations pass `canEdit={isController}` (`DEL-1`). The database would
   accept the write; the client never offers it.
2. **The only delegation primitive an owner *can* reach is ownership
   reassignment, which is a transfer, not a delegation.**
   `user_is_effective_owner` returns `p_doc_owner = p_uid` and stops — an
   explicit document owner **replaces** the library owner. The moment an owner
   delegates a file this way, they lose their own authority over it.

**What building it would touch.** `DEL-1` is the finding that unblocks the client
half. Beyond that, the *bounding* is the design work: an owner should be able to
grant only actions they hold, never `admin`, and owner-issued rules should
require an expiry — otherwise the fix creates a new escalation path. Folder-level
delegation additionally needs a database change, since
`collections_update_controllers` is controller-only.

**Related findings:** `DEL-1`, `OWN-19`, `DOCACL-*`.

---

## GAP-4 · Ownership means being the approver of revision and supersession

**The requirement.** *"Setting ownership means they are the approval of revision
and superseding — they control the library along with admin."*

**What exists nearest.** Ownership today grants **execution** authority (you may
press publish) but not **approval** authority (you are not a required signer).
`ReviewControl` has `reviewerIds` / `reviewerRoles` / `reviewerTeamIds` and **no
owner slot** (`types/schema.ts:191-210`). The owner is *notified* on roster gaps
but never rostered.

**What building it would touch.** Adding an owner slot to `ReviewControl` and to
`openReviewRoster` changes `reviewCompletionForDraft`'s `requiredPrimaries` count
**and** the database completion gate (`20260822:46-58`, which counts
`slot = 'primary'` rows). **Existing in-flight drafts would gain a new required
signer mid-review** — so it needs a policy flag and an effective date, applying
only to rosters opened after the change.

Note the adjacent *bug*, which is in scope for a resolving agent: whether an
approved draft auto-publishes currently depends on **which reviewer happens to
sign last**. That is `OWN-11`, and it should be fixed regardless of whether this
gap is ever built.

**Related findings:** `OWN-11`, `DEL-5`.

---

## GAP-5 · Owner succession, and a real "no owner" state

**The requirement.** Implied by "a different person for each library" — per-library
ownership only works if ownership survives staff changes.

**What exists nearest.** Nothing. Ownership is a dangling uuid: the owner columns
are bare `UUID` with **no foreign key** (`20260630_document_ownership.sql:9-14`),
`user_is_effective_owner` performs **no membership or status check**, and member
removal does nothing about owned libraries, folders or documents.

There is also no "no owner" state that is distinguishable from "owner is a uuid
that no longer resolves" — and the notification routers key on the owner
*existing*, not on the owner being *reachable*, so a stale owner actively
**suppresses** the controller fallback.

**Related findings:** `OWN-12`, `DEL-3`, `SURF-1`.

---

## GAP-6 · The drafting loop's return path — "then send the file to a drafting request to be added"

**The requirement.** *"If someone checks out a P&ID and marks it up it needs to
be as-built then sent the file to drafting request to be added."*

**What exists.** The outbound half is built and built well. A field engineer can
check out with purpose "As-Built Verification", report a discrepancy, get an MOC
gate, and land a real `ASBUILT` ticket with the source document linked and a PSM
escalation.

**What does not exist.** *"To be added."* `close_ticket` is three lines:
`updates.status = "CLOSED"`. Nothing writes `document_versions`, nothing touches
`documents.rev`, nothing tells anyone a revision is publishable. The corrected
drawing exists only as an attachment on a closed ticket.

**⚠ The trap.** `related_ticket_id` exists on `document_versions` and **waives
the document review gate** (`lib/reviewControl.ts:60`). No code path writes it —
the column is NULL in every row that has ever existed. **An agent building this
gap will naturally set it for provenance and thereby silently disable required
reviewer sign-off on every ticket-originated revision, including P&ID
as-builts.** That is `LIFE-2`, and it should be resolved **before** anyone
touches this gap.

**What building it would touch.** The publish guard, the MOC gate, the review
gate, and `runPostPublishSideEffects` — which fans out supersede notices,
work-package pin-drift alerts, revision-impact warnings, review-cycle resets, a
fresh acknowledgment roster and retention recomputation. **A ticket-originated
publish that does not run that pipeline is a revision nobody has to
acknowledge.** And emphatically: not "auto-publish on close," which bypasses both
the publish guard and the MOC gate in one move.

**Related findings:** `LIFE-1`, `LIFE-2`, `LIFE-5`, `LIFE-6`, `LIFE-11`.

---

## GAP-7 · Markup as a durable, addressable artifact

**What exists nearest.** An unnamed `Blob` in IndexedDB (`lib/draftHandoff.ts`),
a `type: "Source"` attachment on a ticket with no provenance beyond its filename,
and a permanently-NULL `shared_markup_url` column.

**Why it matters.** The question *"can a drafter later find the redline that
caused this request?"* has the answer **no**. They can find a file called
`P-200-301_Rev3_markup.pdf` attached to a ticket. They cannot determine who drew
it, during which checkout, against which version, or whether it is the latest.
**For a PSM record that must survive an audit years later, the redline that
justified a change is the evidence** — and it is currently indistinguishable from
any other uploaded PDF.

`FullScreenViewer` already offers three persistence hooks
(`initialPageStates` / `onPageStatesChange` / `onCommit`) and the only render
site passes none of them.

**Related findings:** `LIFE-3`, `LIFE-8`.

---

## GAP-8 · A drafting request can reference more than one source document

**What exists nearest.** `metadata.source_document` is a **single object**. The
book viewer degrades a real set of marked-up sheets into a prose bullet list in
the description.

**Why it matters.** P&ID changes are almost never single-sheet — a bypass line
touches the sheet, its continuation, and often an isometric. `lib/impact.ts` and
the intent bridge both key on the single id, so a multi-sheet request is
invisible to every sheet but (at most) one.

**Related findings:** `LIFE-4`, `LIFE-13`.

---

## GAP-9 · Field verification has currency and expiry

**What exists nearest.** `checkout_sessions.outcome = 'field_verified'`, a
`FIELD_VERIFIED` audit row, and a **purpose-built partial index** whose migration
comment states the question it was created to answer: *"who last verified this
P&ID against the field?"* Nothing asks it. There is no screen, no query, no
report and no API.

The machinery to model currency already exists twice in this codebase:
`lib/reviewCycles.ts` (periodic review) and `lib/acknowledgments.ts:217`
(`ackStatusFor`, with grace windows).

**Why it matters.** PSM requires process safety information to be accurate.
Recording that a P&ID was verified and never surfacing whether that was last
month or four years ago records the fact without delivering the assurance.

**Related findings:** `LIFE-10`.

---

## GAP-10 · A first-class hand-off record

**What exists nearest.** Three unrelated conventions for the same concept:
`tickets.metadata.source_document` (a JSON path, one-way),
`document_intents.ticket_id` (ephemeral, TTL-decaying), and
`checkout_sessions.outcome_ref` (write-only).

**Why it matters.** Each of the three existing hand-offs re-invents linkage,
audit and notification independently — which is why they have three different
field contracts (`LIFE-9`), three different audit behaviours, and only one of
them is bidirectional. **A fourth seam built the same way inherits all of it** —
which is directly relevant to `GAP-6`.

**Related findings:** `LIFE-9`, `LIFE-13`, `LIFE-14`.

---

## GAP-11 · A document event declares what approval its downstream work requires

**The requirement.** When a check-in originates a drafting request, the approval
requirements of the **document** — its reviewer roster, its MOC obligation, its
document class, its holds — should travel with the request and bind the resulting
deliverable.

**What exists nearest.** `metadata.moc` and `metadata.checkin` on the ticket:
descriptive strings, read by nothing. `lib/reviewControl.ts:60` gestures at the
reverse direction and is dead (`LIFE-2`).

**Why it matters.** Today the ticket workflow applies its own role rules with
**zero knowledge** that the source is a PSM-classified drawing under a
required-review library. A P&ID as-built and a memo revision get identical
treatment.

**Related findings:** `LIFE-5`, `LIFE-12`, `GAP-1`.

---

## GAP-12 · Library ownership has an admin surface, and libraries cannot be born unowned

**What exists nearest.** Library ownership is settable from exactly one place: a
menu item labelled **"Review cycle"**, tooltipped *"Set a periodic-review cycle
for every document in this library."* `LibraryWizard` never asks who owns the
library, so **libraries are born unowned.** There is no screen or export listing
the owner of every library and folder.

**Related findings:** `DEL-7`, `DEL-8`.

---

## GAP-13 · Triage has a first-class "we don't do that" outcome

**The requirement.** *"Route requests to the current drafting manager first for
assignment and approval so people don't ask for stupid nonsense we don't or can
do."*

**What exists.** The triage-first shape is **already built and already works this
way.** `getInitialStatus` returns `PENDING_ASSIGNMENT` for everything;
`lib/ticketRouting.ts` targets the `DraftingSupervisor` when one is set, falling
back to Admins, with an org setting for whether Admins keep receiving.

**What is missing is the teeth.** The assigner can approve or reject, but nothing
records **why** a request was rejected as out-of-scope, and there is no reason
taxonomy that makes "we don't do that" a first-class, reportable outcome rather
than free text.

Note two live defects on this path that *are* resolvable findings: the routing
matches on the headline role, so a `["Manager","DraftingSupervisor"]` supervisor
is never notified (`WF-19`), and nobody at all is notified when a ticket
re-enters the queue after engineering review.

**Related findings:** `DRAFT-4`, `WF-19`.

---

## GAP-14 · "Profiles" instead of stacking roles

**The requirement.** *"I'm thinking I can just assign profiles instead of using
multiple role additions."*

**What exists nearest — this one is largely already built.** Two mechanisms, and
between them they cover most of the intent:

- **Per-person capability grants** (`lib/capabilityPolicy.ts`) — additive-only,
  optional expiry, audited with full before/after, riding the same evaluator as
  roles so there is no parallel system to collide with. This is a better fit for
  "give this person this one power" than adding a role.
- **Teams** — a proper join table, a first-class ACL subject, and **correctly
  evaluated additively**: `node_visible` aggregates *all* of a user's teams, so
  unlike roles a team grant is never shadowed by a higher-ranked one.

**Why it is still a gap.** The pieces exist and do not compose into a "profile."
There is no object that bundles a set of capabilities under a name, and the
capability grant cannot reference a document or a library at all (see `GAP-3`).
The grant mechanism is also currently inert (`WF-1`).

**This entry is here mainly to say: the answer to "should I add more roles?" is
no, and the mechanism you would want mostly exists.** What it needs is to be
made to work (`WF-1`, `WF-10`, `WF-11`) and given a resource dimension (`GAP-1`,
`GAP-3`) — not to be replaced.

**Related findings:** `ADD-1`, `ADD-2`, `WF-1`, `WF-13`, `WF-16`.

---

## GAP-15 · Ownership carries read access

**What exists nearest.** Nothing. `node_visible` has **no ownership branch**, and
`user_is_effective_owner` appears in no SELECT policy. Migration
`20260630_document_ownership.sql:4-5` promises the owner *"is granted CRUD access
to their scope"*; Phase 2 shipped the write half and never shipped the read half.

**Why it is a gap and not purely a bug.** Closing it is a **widening** of read
access, and there are two materially different ways to do it — an implicit
ownership branch inside `node_visible`, or auto-granting an explicit ACL read rule
when ownership is assigned. The second is more auditable and visible in the
permissions drawer; the first is less code. That is a design decision.

The *symptom* — an owner being told they are not the owner because they cannot
SELECT the row — is a resolvable finding (`DEL-9`).

**Related findings:** `DEL-2`, `DEL-9`.

---

## What is genuinely already built

Recorded so nobody builds it twice.

| The owner asked about | Status |
|---|---|
| **Routing requests to the drafting manager first for triage** | **Built and working.** Missing only a rejection-reason taxonomy (`GAP-13`). |
| **Per-file / per-subfolder permissions instead of NTFS whole-directory grants** | **Built, and materially better than NTFS.** A document carries its own ACL, `inherit: false` breaks the chain at any node, `hidden`/`private` visibility supports blind-drilling to a single file via an explicit `discover` grant, rules carry expiry, and it is enforced at the **database** as a `RESTRICTIVE` policy — not just in the UI. Its defects are `DOCACL-1`, `DOCACL-2`, `DOCACL-3`, `OWN-7`, `DB-4`, `DB-5`. |
| **Assigning a library owner, a different person per library** | **Built.** Hidden, unvalidated and unprotected — `DEL-7`, `OWN-1`, `OWN-13` — but the mechanism is there. |
| **Teams being optional** | **Built and verified.** Every team lookup degrades correctly at zero teams. See report 08. |
| **Delegating one capability to one person with an expiry** | **Built** (`UserGrant`), currently inert (`WF-1`), and scoped to tickets/holds rather than documents (`GAP-3`). |
| **A capability layer that could carry the whole app** | **Built.** 17 capabilities, org-configurable, per-person grants, critical-capability guardrails, audited. It currently covers requests, holds, checkouts and two admin pages, and nothing else — that is `SCALE-1`, not a missing design. |
