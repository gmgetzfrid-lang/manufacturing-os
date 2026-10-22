# 90 · Gap register — build specs

**14 capabilities the drafting flow needs and does not have.**

`GAP-110`–`GAP-114` were added after the review-model decisions
(`DEC-33`…`DEC-40`) and carry the facility's stated policy. **`GAP-110` and
`GAP-111` are the two that implement it**, and between them they are the
cheapest high-value work in this area — most of `GAP-111` is already built.

Numbered from **101** so they never collide with the `roles-and-permissions`
area's `GAP-1`…`GAP-15`.

> Build work. Each carries a verdict, scope, design direction, dependencies,
> acceptance criteria and a `Do not` list. Held to the evidence bar in
> [`../README.md`](../README.md) and `DEC-29`. Build order is in
> [`99-fix-sequencing.md`](./99-fix-sequencing.md).

---

## Verdicts at a glance

| Gap | Capability | Verdict | Effort | Blocked on |
|---|---|---|---|---|
| [GAP-101](#gap-101) | Work class on the ticket | **BUILD** | M | `WF-15` |
| [GAP-102](#gap-102) | QA/QC assurance with zero added stops | **BUILD_NARROW** | S | — |
| [GAP-103](#gap-103) | Parallel reviewer roster on the ticket | **BUILD** | L | `GAP-105` |
| [GAP-104](#gap-104) | Doc-control release routing per library | **BUILD** | M | `GAP-105`, `GAP-103` |
| [GAP-105](#gap-105) | Ticket → library binding | **BUILD** | S | — |
| [GAP-106](#gap-106) | SLA escalation that actually fires | **BUILD** | M | `LEAK-1` |
| [GAP-107](#gap-107) | Leak accounting — non-standard outcomes | **BUILD_NARROW** | S | `DEC-14` |
| [GAP-108](#gap-108) | "Where is my request" | **BUILD_NARROW** | S | — |
| [GAP-109](#gap-109) | Engineering review without a stop | **BUILD** | M | `GAP-101`, **`GAP-113`** |
| [GAP-110](#gap-110) | **The like-in-kind declaration** — the stated policy | **BUILD** | S | — |
| [GAP-111](#gap-111) | **The assigner's flag becomes binding** — 80% built | **BUILD_NARROW** | S | `GAP-110` |
| [GAP-112](#gap-112) | The routing table — no facility vocabulary in code | **BUILD** | M | `GAP-105` |
| [GAP-113](#gap-113) | The availability record — proving it was asked | **BUILD** | M | `LEAK-1` |
| [GAP-114](#gap-114) | Projects ↔ requests, by reference | **BUILD** | M | `GAP-105` |

---

## The friction ladder

**Every assurance mechanism has a cost measured in two currencies: waits and
touches.** They are not the same, and conflating them is how a review model that
looks cheap on paper becomes the thing people route around.

- A **wait** is elapsed time before the ticket can advance.
- A **touch** is a human being who has to stop what they are doing and act.

A parallel roster fixes waits and not touches. That distinction drove the
rewrite of `GAP-102`.

| Mechanism | Waits added | Touches added | Use when |
|---|---|---|---|
| Serial status per reviewer | **N** | **N** | Never. This is what the flow does today. |
| Parallel roster | 1 | **N** | The signature is genuinely the point — a code-governed new design |
| Silence-is-consent window | 1, **bounded by a clock, not a person** | **0** in the happy path | The reviewer needs the chance to object, not the obligation to bless |
| Standing pre-authorization | **0** | **0** | Recurring known work an engineer has already ruled on |
| Completeness gate on a field | **0** | **0** (whoever is already in the flow fills it) | The need is *data present*, not *judgement rendered* |
| Notify + stop-work authority | **0** | **0** unless exercised | The need is *visibility* and *a veto* |

**Read the ladder downward before adding anything.** The question is never "who
should review this?" — it is **"what is the cheapest mechanism that delivers the
assurance?"** Most requirements that present as reviews turn out to be data
completeness or visibility, and both of those are free.

Two mechanisms at the bottom of the ladder **already exist and are already
universal**, which is why `GAP-102` and `GAP-109` are `S` and `M` rather than
`L`:

- `holds.open` / `holds.release` default to `["*"]` (`lib/capabilityPolicy.ts:85-88`)
  and a hold is a hard block enforced in three layers
  (`lib/documentGuards.ts:109-125`). **Stop-work authority for everyone, costing
  nothing when unused.**
- `lib/subscriptions.ts` supports watching a `"library"` with follower fan-out.
  **Standing visibility, costing nothing.**

### What the work class is actually for

`GAP-101` reads like it exists to *add* review tiers. It does not.

**It exists to let you remove them.** Silence-is-consent is safe for a
like-in-kind swap and unsafe for a new tie-in in a hazardous service. Standing
pre-authorization is safe for a standard detail and unsafe for a novel one. You
cannot skip a review you cannot classify — so the classification is the thing
that makes *most* work cheap, not the thing that makes *all* work expensive.

---

<a id="gap-101"></a>
## GAP-101 · Work class on the ticket

**Verdict: BUILD** · Effort: **M** · Depends on: `WF-15`

> ### ⚠ Revised by `DEC-33`. Read this before the spec below.
>
> An earlier version of this spec said the class is set **at triage, not at
> intake**, and listed *"requiring the requester to classify"* as deliberately
> out of scope. **That is now wrong**, and an agent following it would build
> something that violates the facility's stated policy.
>
> The policy, verbatim: *"only use engineered packages unless the requester has
> declared on request this is like-in-kind."*
>
> The reasoning that produced the old version was not wrong, it was answering a
> different question. Asking a requester to **pick a work class from a taxonomy**
> is expensive and they often cannot do it. Asking a requester to **declare one
> exception, with a safe default if they say nothing**, is one question whose
> unanswered state is both cheap and correct. See "Why this does not reintroduce
> `UI-5`" below.

### Scope

**In:** a persisted classification on the ticket that review requirements key
off, established as follows:

| Set by | When | What it does |
|---|---|---|
| **Requester** | Intake, optional | Declares like-in-kind. Removes the engineering requirement. Requires a typed statement (`DEC-34`). |
| **Nobody** | — | **Default: engineered.** No declaration means the rigorous lane. |
| **Assigner** | `PENDING_ASSIGNMENT`, optional | May add engineering back (`GAP-111`). **May never remove it.** |

**Out (deliberately):** a drawing-type taxonomy (P&ID vs isometric vs loop
sheet). `DCW-3` establishes that the **library** is the better routing proxy and
already has an inheritance mechanism. A second taxonomy would have to be kept in
sync with the first.

**Out:** a required intake field. The declaration is optional *because* its
absence is the safe answer.

### Design

**The default is the whole design.** A ticket with no declaration is engineered
work. That single fact means:

- The requester who does not understand the question is not blocked, not
  confused, and not routed into a lane they should not be in — they simply get
  the rigorous one.
- The form cannot be gamed by clicking through, because clicking through *is*
  the conservative outcome.
- No triage step is required for correctness. `GAP-111`'s assigner check is a
  safety valve on the declaration, not the thing that establishes the class.

Beyond the declaration, finer classes (`minor_correction`, and whatever a
facility adds) remain org-configurable and settable at assignment — but they
modulate routing **within** the two lanes the declaration establishes. They never
override it.

Prefill where hard evidence exists — a request carrying
`metadata.source_document` whose `docClass` is `drawing`, raised from a check-in
whose outcome was already `correction_requested` — and mark the prefill visibly
as a suggestion. `lib/docClass.ts` establishes this principle in this codebase
and it applies identically: **a suggestion is never enforcement**, and guessing
from filenames is explicitly rejected there as a way to misroute safety-critical
documents.

### Why this does not reintroduce `UI-5`

`UI-5` is the finding that submitting an incomplete request does nothing at all —
a bare `return` with no message and no field highlight. It is about **required
fields the user cannot satisfy and is not told about**.

The declaration is not that. It is optional, its unanswered state is valid, and
the consequence of leaving it blank is stated on the form in one line: *"Leave
this blank and the request goes to engineering."* Nobody is ever blocked by it.

**The one way to get this wrong** is to make the declaration required *or* to
make the finer work class required at intake. Both turn a safe default into a
wall. Do neither.

### Do not

- **Do not make the declaration required.** Its optionality is what makes it
  safe.
- **Do not let the assigner, an admin, or anyone else clear a declaration or
  lower the lane.** Only the requester's own declaration lowers rigor, and only
  at creation. See `DEC-33`.
- **Do not store it in `metadata`.** `CheckInPanel` already writes
  `metadata.moc`, `metadata.minor_correction` and `metadata.undocumented_change`
  (`components/documents/CheckInPanel.tsx:263-266`) and **nothing reads any of
  them for any decision.** Untyped JSON nothing enforces is a record, not a
  control (`DEC-34`).
- **Do not derive it from `changeType`.** That lives on `DocumentVersion` and is
  chosen at publish — weeks after the review decision needs to be made.
- **Do not build it before `WF-15`.** An authority-bearing classification keyed
  to unvalidated free text is a hole (`LEAK-3` shows what that already costs).
- **Do not reuse `request_type` for this.** They are different questions: *what
  kind of ask* versus *how much change*. Collapsing them is why `request_type`
  is currently overloaded and unvalidated.

### Acceptance

1. A ticket created with no declaration has `engineering_required = true`, and
   cannot reach IFC without the engineering slot satisfied — **including when the
   requester is a Manager, Admin or DocCtrl**. This is the `TIER-1` inversion.
2. A ticket created with a declaration reaches IFC with no engineer involved and
   **no additional wait state versus today**.
3. The declaration is immutable after creation and renders attributed on the
   ticket, the deliverable and the audit trail.
4. Leaving the declaration blank never blocks submission and never produces a
   silent no-op.
5. A report can count, for any period: tickets by lane, and every declaration
   with its author and text. This is the number that tells you whether the
   like-in-kind lane is being used honestly.

**Related findings:** `TIER-1`, `TIER-2`, `TIER-7`, `LEAK-3`, `UI-5`.
**Related gaps:** `GAP-110` (the declaration UI and storage), `GAP-111` (the
assigner's flag).
**Decisions:** `DEC-33`, `DEC-34`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P6 REVIEW-MODEL): `tickets.engineering_required` (`20261250`, pending paste — deploy the app first), the declaration (`GAP-110`), the workspace's own `workClasses` / `codeClasses` (seeded empty, set at triage, an engineering class raises the requirement). Acceptance 1 ✓ (Manager, Admin, Supervisor and DocCtrl pinned, engine and route); 2 ✓ (a declared request reaches IFC through its requester — no engineer, no added state); 3 ✓ in part — immutable for every caller (the guard, PostgreSQL 16) and rendered attributed on the request (`DeclarationCard`), in its history ("Declared like-in-kind (signed)") and in each transition's audit row (`likeInKindDeclared`); NOT on the issued deliverable's stamp (the stamp is public-surfaces' / DF-P15's file — proposed hand-off); 4 ✓ (blank never blocks; the form says blank goes to engineering); 5 ✗ — the columns make the report a query (lanes by `engineering_required` and declaration; every declaration with author and text), but no report surface is built — proposed for drafting-flow DF-P16's analytics page. See `TIER-1`, `TIER-2`, `TIER-7`.*

*Corrected at the DF-P6 review fix pass (2026-10-21, DEC-29): the classes are accepted by the route at triage, but no screen sets one yet (the assign modal's select → DF-P9, 99-fix-sequencing "Hand-offs from DF-P6"), so the class half of the lanes does not act in production; the declaration half does. Acceptance 1 now also binds the requester: in a workspace of 3+ with an engineer to pick, the requester cannot override the engineering sign-off on their own request (`TIER-1` fix pass).*

*Corrected at the DF-P6 fifth review fix pass (2026-10-21, DEC-29): the last sentence above has not held since the fourth review fix pass. Acceptance 1 binds the requester's ISSUE, not their override: the requester holding `ticket.manage` may override the engineering sign-off on their own request in every workspace size, with a required comment, recorded as an override (history note, `metadata.engineering_override`, the audit row's `authority.override` naming the self-override) — DEC-90 ruling (3) as given (R1's default; DEC-33's fourth-pass line). The requester is never offered a PLAIN approval of an undeclared request. Since the fifth pass the same holds on a pre-paste request whose requirement was raised after the paste (`flag_engineering`, an engineering class): `lib/workflow.ts` `requesterBindingApplies`.*

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31; DF-P9, the package first named, merged on 2026-10-14):* the class at triage → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS**.

*Landed 2026-10-21 (drafting-flow Round G, DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS): the class at triage — the assign dialog and the scope-review engineer picker offer one select per configured list (`components/requests/TriageClassSelects.tsx`; `lib/requestPageReview.ts` `triageClassSelects`), "No change" by default, sending `workClass` / `codeClass` with `assign` / `request_eng_review` at `PENDING_ASSIGNMENT` (the route validates, as DF-P6 built it); no select for an empty list, outside triage or before `20261250` (DEC-90 ruling (1) for DF-P18). A work class may also be flagged "Minor correction" (named on the minor-correction approval and in its audit row — `TIER-7`) and "Needs MOC" (the hand-back asks for the MOC number — `TIER-6`); neither changes anything for a request with no class or an unflagged class (ruling (3)). Finer classes "modulate routing within the two lanes" now act: the notify-only routing slot limited to classes is edited in the routing table (`TIER-3`). Acceptance 1–4 unchanged (as recorded); 5 unchanged (the report surface — proposed for DF-P16, as recorded). See `TIER-2`, `TIER-3`, `TIER-6`, `TIER-7`.*

*Assigned (2026-10-22, the integrator at the DF-P18 merge, DEC-31):* acceptance 5 (the report counting tickets by lane and every declaration) → drafting-flow **DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION** (the earlier proposed owner, DF-P16, has merged).

*Landed 2026-10-22 (drafting-flow Round G, DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION; the integrator's ruling (4) under DEC-90): acceptance 5 ✓ — "Review Lanes" on `/admin/analytics`, beside "How Requests Ended" (where the request reports live): for any period of filing dates (inclusive, UTC; either end open), the requests by lane — engineered, declared like-in-kind, filed before the review model (role-based gate), lane not recorded (the 20261250 columns absent) — whose counts add up to the period's total, and every declaration with its author (the declaring uid, named as the requester where it is theirs), its text, its date and the request's work / code class (named as the workspace's list names them now), with an Export CSV of the same report (every cell through `lib/csvSafe`). Read-only, from what the ticket already records: `lib/reviewLaneReport.ts` (`reviewLaneOf`, `summarizeReviewLanes`, `reviewLaneReportCsv`), `components/requests/ReviewLaneReport.tsx`, the analytics page's mapper spreading `reviewModelFieldsFromRow`; the rows are the ones `/api/admin/analytics` already returns as the caller (RLS decides, the gate is `admin.analytics_view`); no new write path, table or route. The page says the declaration's e-signature is checked at approval, not here, and that the page loads at most the server's row limit (as "How Requests Ended" does). Tests: `lib/__tests__/dfRoundG_P19_ticketResource.test.ts` ("GAP-101 acceptance 5"), `csvProducersCensus.test.ts` (the new producer through its builder).*

---

<a id="gap-102"></a>
## GAP-102 · QA/QC assurance with **zero added stops**

> ### ⚠ Build the mechanism as `GAP-112`, not as a bespoke feature
>
> Everything below about *what assurance is needed and what it must cost* still
> stands and is the reasoning to follow. But per `DEC-35` the word "QA/QC" must
> not appear in application code — it is one facility's vocabulary. Express this
> as a **slot in the routing table** (`GAP-112`) with `mode: "notify_only"`, and
> the facility names it whatever it names it.

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: nothing

> **This spec was rewritten.** The first version made QA/QC a reviewer slot on
> the parallel roster. That was wrong: a parallel roster fixes *latency* (three
> reviewers cost one wait instead of three) but not *touches* — someone still has
> to sign. The objection was to the touch.
>
> It also had the authority backwards. **QA/QC does not review the engineer's
> design.** If an engineer specifies a method, that is an engineering decision.
> QA/QC's legitimate interests here are *what examination applies* and *is the
> code data present* — both of which are **outputs** of the design, not
> judgements on it.

### The reframe

Look at what QA/QC actually needs from a drawing package:

| Need | Is it a judgement on the design? | What it actually is |
|---|---|---|
| NDE / radiography scope | No | **Data that must be present** |
| Governing code + service class | No | **Data that must be present** |
| Design factors per that code | **Yes — and it is the engineer's** | Engineering, already reviewed |
| "This looks wrong to me" | Sometimes | **Stop-work authority** |

Three of the four are not reviews at all. The fourth is a *veto*, and a veto
costs nothing when it is not exercised.

**So QA/QC gets visibility and a stop, not a signature.**

### Scope

**In:** three things, none of which is a status, a role, or a signature.

1. **A completeness gate on the deliverable** — the issued package must carry its
   examination scope, governing code and service class. Enforced as *fields on
   the record*, not as a person's approval.
2. **Standing visibility** — QA/QC watches the libraries they are responsible
   for and is notified on every issue, with that data attached.
3. **Stop-work authority** — already exists, see below.

**Out (deliberately):** a QA/QC approval step, a QA/QC reviewer slot, a
`PENDING_QAQC` status, a QAQC role. All four add a touch.

### Design — all three parts already exist

**Stop-work authority is already built and already universal.**
`lib/capabilityPolicy.ts:85-88` defines `holds.open` and `holds.release` with
`defaultRoles: ["*"]` — **every member can already place a do-not-advance hold.**
And `lib/documentGuards.ts:109-125` makes a hold a hard block that only the
controller tier can force past, enforced in the pure function, in the trigger and
in the RPC.

That is precisely how a QA/QC function works in a real plant: they do not
countersign every drawing, they hold stop-work authority. **The mechanism is
built, correct, and costs exactly nothing when unused.**

**Visibility is already built.** `lib/subscriptions.ts` supports watching a
`"library"` with `listFollowerIds` fan-out. A QA/QC inspector watches the piping
library and is notified on every issue. Zero stops.

**The completeness gate is the only new work**, and it is a field-presence check,
not a review. Where the engineer already specified the NDE scope — which is the
normal case, and the case the objection is about — the field is already populated
and **the gate is invisible**. It only bites when the data is genuinely missing,
and the person who fills it is the drafter or engineer already in the flow.

Attach the required fields to the **work class** (`GAP-101`) and the **library**,
so a like-in-kind swap in a non-code service requires nothing and a B31.3 spool
requires its examination scope.

### Do not

- **Do not add a QA/QC approval step in any form** — status, roster slot, or
  sign-off. Even parallel, it is a touch, and the touch is the objection.
- **Do not let QA/QC gate on design method.** If an engineer specified it, that
  is settled. QA/QC's recourse is the hold, which is deliberate, visible and
  audited — not a silent veto in a review queue.
- **Do not build a new stop-work mechanism.** Holds exist, default to everyone,
  and are enforced at three layers.
- **Do not make the completeness gate a free-text box.** A field nobody can
  validate is a field everyone types "N/A" into. Constrain it to the org's
  configured examination and code vocabulary.

### Acceptance

1. A like-in-kind package with its examination data already specified by the
   engineer issues with **zero additional touches by anyone**.
2. QA/QC is notified of every issue in a library they watch, with the examination
   scope and code attached.
3. QA/QC can stop a package at any point via a hold, and that hold is audited.
4. A package missing required examination data for its class cannot issue — and
   the person prompted is someone already in the flow.
5. No new role and no new status exists.

**Related findings:** `TIER-3`, `TIER-4`, `TIER-5`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P6 REVIEW-MODEL), by the integrator's ruling for this package (no QA/QC role, status or signature slot): a routing slot may be limited to work classes when it is notify-only (`RoutingSlot.work_classes`); a blocking slot never is. Acceptance 2 ✓ in that form (a library's assurance reviewer is told of every issue of the classes they watch; the code class is on the approval); 3 ✓ (the existing document hold); 5 ✓ (no new role, no new status); 1 and 4 ✗ — examination data has no model yet; proposed for the integrator to assign. See `TIER-3`.* *Owner named at the DF-P6 fifth review fix pass (DEC-31): acceptance 1 and 4 → **the integrator**, who assigns the examination-data model to a package (no package in the fleet plan holds it); recorded in 99-fix-sequencing "Hand-offs from DF-P6".*

*Corrected at the DF-P6 second review fix pass (2026-10-21, DEC-29): acceptance 2 does not act in production yet — no screen edits a slot's `work_classes` (`RoutingControlSection` only carries stored values) and no screen sets a request's work class (DF-P9), so `TIER-3` is re-recorded OPEN / Partial; owners in 99-fix-sequencing "Hand-offs from DF-P6".*

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31):* acceptance 1 and 4 (what an assurance reviewer examined, the record behind the veto) → drafting-flow **DF-P20 ASSURANCE EXAMINATION RECORD**.

---

<a id="gap-103"></a>
## GAP-103 · Parallel reviewer roster on the ticket

**Verdict: BUILD** · Effort: **L** · Depends on: `GAP-105`

> **This is the keystone.** `GAP-101`, `GAP-102` and `GAP-104` all become cheap
> once it exists and all become friction disasters without it.

### Scope

**In:** the ticket's review stage runs on a roster of required reviewers who sign
in any order, with the ticket advancing automatically when the last required
signature lands.

**Out (deliberately):** replacing the whole ticket state machine. The roster
replaces the review *stage* — `PENDING_REVIEW` and `PENDING_FINAL_APPROVAL` —
not `PENDING_ASSIGNMENT`, `DRAFTING` or `PENDING_IFC`.

**Out:** quorum rules (N-of-M). The evaluator is boolean; adding counting is a
separate project with no stated requirement.

### Design

**Do not design this from scratch — it already exists on the document side.**
`lib/reviewControl.ts` has: required primaries plus alternates expanded from
people, roles and teams; signatures bound to the draft's `content_hash`;
invalidation when the draft changes, with the earlier signers told why;
timeout-driven alternate activation; and auto-finalize when the last required
signature lands, with the database re-checking completion transactionally.

Every property the ticket flow needs, already built and already tested.

The work is to make it reachable from the ticket: `getActions`
(`lib/workflow.ts:61-65`) currently receives `ticket`, `userRole`, `userId` and
`policy` — **no library and no review control**, which is why `DCW-6` exists.
Once `GAP-105` gives the ticket a library, the library's `review_control`
resolves through the chain already in place.

This also collapses `TIER-8` entirely: if the ticket's review *is* the document's
review roster, an engineer is not asked to review the same drawing twice.

### Do not

- **Do not implement the review model from `GAP-101` / `GAP-102` on the current
  serial machine.** A new-design B31.3 package would become eight hops and six
  people, and people will route around it. **That failure mode is the reason this
  audit exists.**
- **Do not build a second roster mechanism.** One review system, not two
  (`TIER-8`).
- **Do not let a ticket approval satisfy a document sign-off without an
  e-signature bound to the content hash.** See `DEC-23` — and note the dead
  `related_ticket_id` waiver is exactly the shortcut that looks like this and is
  not.
- **Do not remove the identity rights** at `lib/workflow.ts:69-75`. A ticket's
  requester, drafter and engineer can never be locked out of their own ticket by
  a policy edit; whatever replaces the review stage must keep that.

### Acceptance

1. Two required reviewers on the same ticket can sign in either order, or
   simultaneously, with neither waiting on the other.
2. The ticket advances automatically when the last required signature lands.
3. Adding a reviewer to a requirement adds no status.
4. A reviewer who signed on the ticket is not asked to sign again at publish for
   the same artifact.
5. Identity rights still hold.

**Related findings:** `TIER-5`, `TIER-8`, `DCW-6`, `FRIC-1`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P5 ROSTER): the parallel roster exists on the ticket and its mechanics are the document side's, called — `lib/ticketRoster.ts` (`openRoster`, `rosterContentHash`, `applySignPlan`, `rosterCompletion` → `lib/reviewControl.ts` `evaluateSlotCompletion`), the engine's roster mode (`lib/workflow.ts` `currentRoster` / `slotSignPlan`), the workflow route (opens on submission into a routed library, e-signature-bound sign-offs, the last one issues), the ledger `20261242` (pending paste) and `components/requests/TicketRosterPanel.tsx`. Acceptance 1–3 ✓ and 5 ✓ (identity rights untouched: the requester always keeps Request Revision; the drafter's own actions are unchanged) on every request whose library routes its reviews; an unconfigured workspace keeps today's serial machine (DEC-90 ruling (2)). A routing table adds reviewers and never drops the org-wide engineering gate: where `engineerApprovalRequired` (or an engineering-first type) holds and the table carries no blocking engineering-capability slot, the seed's engineering slot is appended and said (`lib/ticketRoster.ts` `withEngineeringGate`, DF-P5 fix pass 2). Acceptance 4 (a ticket sign-off satisfying the publish roster for the same bytes) is NOT met — R&P `LIFE-12`'s, under `DEC-23`; the ticket side records the signature and content hash that bridge needs. See `TIER-5`, `TIER-8`, `DCW-6`.*

---

<a id="gap-104"></a>
## GAP-104 · Document-control release routing, per library

> ### ⚠ Build the mechanism as `GAP-112`
>
> The need below is real and the per-library reasoning is right. The mechanism is
> a routing slot filled by `{ owner_of: "library" }` (`GAP-112`), not a
> doc-control-specific code path. `DEC-35`, `DEC-36`.

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-105`, `GAP-103`

### Scope

**In:** a library can require document-control review before its drawings are
released, satisfied on the parallel roster.

**Out (deliberately):** a `PENDING_DOC_CTRL` status, and a global "all drawings
go through doc control" switch. Both add serial cost to every ticket
(`DCW-2`).

**Out:** routing by drawing type. Per `DCW-3`, the library is the better proxy
and already inherits.

### Design

The rule lives on the library and resolves through the container chain —
document → folder → library, most specific defined level wins — exactly as
`docClass` and `review_control` already do. An org that keeps P&IDs in a P&ID
library gets the routing for free.

The document controller becomes a **reviewer slot on the `GAP-103` roster**, so
release review runs alongside technical review rather than after it. Where a
library does not require it, no ticket ever sees it.

This finally makes `ticketAttention.ts:106` true. Whoever wrote that line
believed document control belongs at issue and release — **they were right about
the model and the flow never implemented it** (`FRIC-7`, `DCW-2`).

### Do not

- **Do not add a status.** `DCW-2`'s chain-reaction note is explicit: a serial
  doc-control hop on every ticket is exactly the friction the stated requirement
  forbids.
- **Do not route on a drawing-type enum.** `DCW-3`.
- **Do not give DocCtrl blanket `ticket.manage`.** That would make them a
  management-tier approver on every ticket, which is not the function. A scoped
  reviewer slot is.
- **Do not confuse release review with the hand-back.** This gap is *doc control
  reviews before release*; `GAP-6` (roles-and-permissions area) is *the
  deliverable reaches the register at all*. Both are needed and they are
  different — a controller reviewing a deliverable they then cannot register is
  no better than the reverse.

### Acceptance

1. A library can require document-control review before release; libraries that
   do not are unaffected.
2. Satisfying it adds no serial status hop.
3. A document controller's attention badge reflects work they can actually do
   (`FRIC-7`).

**Related findings:** `DCW-2`, `DCW-3`, `DCW-6`, `FRIC-7`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P6 REVIEW-MODEL — record and test on DF-P5's roster): a library's routing table can carry a blocking slot filled by document control; acceptance 1 ✓ (libraries without one are unaffected), 2 ✓ (parallel roster, no status), 3 ✓ (FRIC-7, and pinned for the slot). See `DCW-2`.*

---

<a id="gap-105"></a>
## GAP-105 · Ticket → library binding

**Verdict: BUILD** · Effort: **S** · **Prerequisite for `GAP-103` and `GAP-104`**

### Scope

**In:** a `library_id` on the ticket, set at intake where derivable and confirmed
at triage otherwise.

**Out:** a full container path (folder-level targeting). Library granularity is
enough for every routing rule in this audit, and the chain resolver handles the
rest.

### Design

Small, and it unblocks the two largest builds. Derive from
`metadata.source_document.id` where a source document exists. For a new-document
request, offer the libraries the requester can see — and where they can see none,
defer to triage, which is a step that already exists.

**Note the `DCW-5` interaction:** a requester who cannot *read* a restricted
library may still legitimately need to request work in it. The ACL already
supports `discover` without read; the request form does not use it.

### Do not

- **Do not make it required at intake.** A requester who cannot pick a library
  must still be able to file (`UI-5`, `FRIC-3`). Triage resolves it.
- **Do not infer it from `unit`.** `unit` is free text (`DCW-7`) and units do not
  map to libraries.

### Acceptance

1. A ticket created from a document viewer carries the source document's library
   automatically.
2. A ticket without one can still be filed, and triage must resolve it before
   assignment completes.
   *Note (DF-P4 fourth fix pass, ruled under `DEC-90`): the second half of
   this acceptance is superseded — a library is **never required, at intake
   or at assignment**: [`DEC-107`](../DECISIONS.md#dec-107) item 2
   and `DCW-1`'s ruling (`03-doc-control-wiring.md`, DCW-1 Partial: "Never
   required"). Triage MAY set or correct it; a ticket with no library is
   assigned, issued and closed as before.*
3. Library-scoped rules can be evaluated against any ticket past triage.

**Related findings:** `DCW-1`, `DCW-5`, `DCW-6`.

*DF-P6 REVIEW-MODEL (2026-10-21), corrected at its review fix pass (DEC-29): acceptance 3 is NOT met. DF-P6 first added `libraryId` to `ticketResource`, but the attention badge's mappers (the requests list's `fromRow`, `lib/inbox.ts` `rowToTicket`) do not carry `library_id`, so the badge and the buttons would disagree; the resource is back to request type and unit. `20261250`'s inventory still counts stored library-scoped ticket rules (expected 0). Hand-off: 99-fix-sequencing "Hand-offs from DF-P6". See `DCW-6`.*

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31):* acceptance 3 (the library in the ticket's capability resource) → drafting-flow **DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION**.

*Landed 2026-10-22 (drafting-flow Round G, DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION; the integrator's rulings (1)–(3) and (5) under DEC-90): acceptance 3 ✓ — a library-scoped rule is evaluated against every ticket that carries a library (set at intake or at triage, DF-P4): `lib/workflow.ts` `ticketResource` presents `libraryId` (with `workClass` / `codeClass`), and every mapper that builds a ticket for the engine — the workflow route's and the cron's `rowToTicket`, the request page's and the requests list's `fromRow`, `lib/inbox.ts` `rowToTicket`, the attention badge's `fromDbTicket` — spreads `lib/reviewModel.ts` `reviewModelFieldsFromRow`, so the page, the list, the inbox, the badge and the route decide alike (`lib/__tests__/dfRoundG_P19_ticketResource.test.ts` runs one row through all five over every status × role × identity). A ticket with no library presents null and decides exactly as before (ruling (3), pinned the same way). A library-scoped `ticket.*` rule stored before DF-P19 only adds until an Admin confirms it (ruling (2): `lib/capabilityPolicy.ts` `ruleInForce` / `effectiveTokens`; the console's Confirm; `DEC-44 (DF-P19-ticket-resource-dimensions)`); one saved through the policy route since is confirmed by that save. The stored rules are inventoried, counts only, per workspace, NARROW / GRANT / SAME, by `20261263` (read-only; paste before the deploy). The DF-P4 hand-off's third item (`lib/dataRestore.ts` `RESTORE_PARENT_RULES.tickets`) was revisited and is kept: a restored ticket whose library is not in the target workspace has its pointer cleared, as the live `ON DELETE SET NULL` does — no rule of the target workspace can name that library, so clearing changes no answer; the rule's comment there ("the pointer confers no access … whoever adds it there revisits this rule") is now stale and is admin-and-org's file to reword (not edited here — fleet rule). See `TIER-4`, `DCW-6`.*

---

<a id="gap-106"></a>
## GAP-106 · SLA escalation that actually fires

**Verdict: BUILD** · Effort: **M** · Depends on: `LEAK-1`

### Scope

**In:** a server-side scan that notices a ticket sitting past a threshold in a
wait state and tells the party that owns it, escalating if it stays.

**Out:** auto-advancing the ticket. Escalation notifies; it does not decide.

### Design

The data model already exists — `target_completion_at` is set at creation with
per-request-type defaults (`lib/notifications.ts:237-243`), and `isPastDue` /
`isNearingDue` are written and tested. **Nothing reads them server-side.** A
repo-wide search finds no consumer outside the UI and the test file.

The maintenance cron already runs six comparable scans — stale checkouts,
review nudges, effective dates, acknowledgments, retention. This is a seventh, in
an established pattern.

Escalate to the **queue owner**, not the watcher list — which requires `LEAK-1`
fixed first, since `resolveTicketRecipients` is currently never consulted after
creation.

### Do not

- **Do not escalate to `[requesterId, assignedDrafterId]`.** That is the current
  fan-out and it is precisely who does not need telling — they already know.
- **Do not auto-close or auto-advance on timeout.** A stalled review is
  information, not a decision.
- **Do not use `notifyMany`.** It is in-app only. Use `emit`, so escalations
  reach email — the same asymmetry `LIFE-7` found on the PSM alert.

### Acceptance

1. A ticket past due in a wait state produces a notification to whoever owns that
   state.
2. Continued inaction escalates above them.
3. Escalations reach email, not only the in-app bell.
4. A collision ticket — which today has no due date at all (`LIFE-9`) — gets one.

**Related findings:** `FRIC-1`, `LEAK-1`, `LEAK-2`, `LIFE-9`.

*Landed 2026-10-13 (drafting-flow Round G, DF-P3): acceptance 1 and 3 — `lib/ticketSla.ts` + step 5b of the maintenance cron warn the owner of the current status at 75 % of the window and escalate a breach to them, the assignment queue and the requester, once each, through `emit()` (bell + email). Acceptance 2 holds in that form (the breach reaches the queue that can reassign). Acceptance 4 (a collision ticket gets a due date) → DF-P2's create route. The clock starts at the first paste of `20261195`, which records the backlog already past its target without a notice each (fix pass 2). See [`DEC-103`](../DECISIONS.md#dec-103), `EDGE-7`, `ROUTE-9`.*
*Amended 2026-10-13 (DF-P3 fix pass 3): the workflow route no longer retires the clock's notices on a transition that leaves the request open (the bell's client-side reconcile still does on a status change — DF-P9, on `EDGE-7`), and a client-created ticket is born with no SLA stamp (`ticket_insert_integrity`, `20261195` §2b), so no insert keeps a request off the clock. See `EDGE-7`.*

*Assigned (2026-10-21, the integrator at the DF-P7 merge, DEC-31):* the remainder (the escalation tier above the queue owners, with FRIC-1) → drafting-flow **DF-P22 CONSENT AND ESCALATION FOLLOW-UPS**.

---

<a id="gap-107"></a>
## GAP-107 · Leak accounting — non-standard outcomes

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `DEC-14`

### Scope

**In:** closing a ticket as withdrawn, duplicate, or handled out of band, with a
reason, reportable per queue.

**Out:** an approval workflow for the outcome. Recording it is the whole feature.

### Design

`CANCELED` already exists in the `TicketStatus` union and is documented to users
in `WorkflowDiagramModal` — and **no action produces it** (`WF-17`). `DEC-14`
already commits to implementing it. This gap extends that: the outcome carries a
reason from an org-configurable list, and the list includes *handled outside the
system*.

**This is the measurement instrument for the entire area.** Every other finding
here is about reducing friction so people stop bypassing the app. Without this,
whether the fixes worked is unknowable — a bypassed ticket is currently
indistinguishable from a completed one (`LEAK-9`).

Pairs naturally with `GAP-13` (the triage rejection taxonomy, in the
roles-and-permissions area): same shape, same config mechanism, opposite end of
the flow.

### Do not

- **Do not force-close as the recording mechanism.** `ticket.force_close` records
  no reason and is Admin-tier; the person who knows the work went out of band is
  usually the requester.
- **Do not make it a status per reason.** One terminal status, a reason field.

### Acceptance

1. A ticket can be closed as withdrawn, duplicate or handled out of band, with a
   reason from the org's list.
2. A queue's leak rate is a number someone can look at.
3. `CANCELED` is reachable (`DEC-14`).

**Related findings:** `LEAK-9`, `WF-17`.

*Landed 2026-10-13 (drafting-flow Round G, DF-P3): acceptance 2 and 3 — `tickets.outcome` (`20261195`, pending paste) and "How Requests Ended" on `/admin/analytics`. Acceptance 1 holds at the route; the request page's picker is DF-P9's (until then a cancel without a category records none — never a guessed `withdrawn` — so the leak rate counts only outcomes someone named). The list is the ratified five, in code and a CHECK; org-configurable later. See [`DEC-103`](../DECISIONS.md#dec-103), `LEAK-9`.*
*Amended 2026-10-13 (DF-P3 fix pass 3): acceptance 2 is an instrument, not yet a number — until DF-P9's picker ships, a UI cancel names no category, so wherever no cancel named one the block shows the leak rate as "—" ("not measured yet: N cancels named no category") rather than a 0 % made of closes; once some cancels carry a category the rate is shown with the uncategorized ones counted beside it. See `LEAK-9` done-when 2.*

*Assigned (2026-10-14, the integrator at the drafting-flow DF-P9 merge, DEC-31):* acceptance 1's org-configured reason list → drafting-flow **DF-P14** (with roles-and-permissions `GAP-13`); acceptances 2 and 3 landed (DF-P3, DF-P9's Cancel Request picker).

*Landed 2026-10-14 (drafting-flow Round G, DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS): acceptance 1's org-configured list, under the integrator's ruling (`DEC-90`: optional; none configured → the Cancel Request picker and the workflow route behave exactly as before, the categories; with a list → the picker offers the org's reasons grouped by category and the route accepts only a configured reason or a bare category — read fail-safe at the review fix pass: a bare category only where the workspace keeps no reason under it, the picker's own rule). The list lives in the request-form configuration (`org_configurations` key `'drafting'`, `outcomeReasons`: `{ id, label, category }`, `lib/ticketOutcomeReasons.ts`) — no schema change, the `tickets.outcome` CHECK keeps the five; it is edited on Admin → Request forms ("Reasons for ending a request", under the four ways a cancel can end a request) by the drafting-form editor set (`DEC-107` item 1, the same page gate and the same `20261209` write rule); the Cancel Request dialog (`app/(protected)/requests/[id]/page.tsx`) groups the reasons under their categories (a category with none offered bare) and sends `outcomeReason` beside `outcome`; `/api/tickets/workflow-action` refuses (400, nothing written) a reason that is not configured, not of the category sent, or sent without one, answers 503 when the list cannot be read, and records an accepted one as `metadata.outcome_reason` (the words as they read then), in the history line and in the audit row; review fix pass: with no reason named it also refuses (400 `outcome_reason_required`, nothing written) a bare category the workspace keeps reasons under, or a cancel naming no category while it keeps reasons — so the list binds every caller, not only the dialog (if the list cannot be read then, the request ends as before and its audit row says `outcomeReasonUnchecked`). Acceptance 1: ✓ except while the reason list cannot be read: the route then accepts a bare category, audited as outcomeReasonUnchecked — otherwise a request can be closed as withdrawn, duplicate or handled out of band with a reason from the org's list (the five categories when none is configured). *(Ruled by the integrator at the DF-P14 merge, 2026-10-20 (DEC-90): the exception is kept in the code — refusing a cancel because the configuration could not be read would regress a flow that works today — and the acceptance is worded to say it; ruling (2)'s server reading is ratified as built: the route accepts a configured reason of the category, or a bare category (only where the workspace keeps no reason under it); recording the accepted reason — the history line, the audit row's fields, the `metadata` merge on the compare-and-set write — is part of the reason validation. *Was:* "Acceptance 1 now holds as written". See roles-and-permissions `GAP-13`.)* Tests: `lib/__tests__/dfRoundG_P14_outcomeReasons.test.ts`, `dfRoundG_P14_outcomeReasonsEditor.test.ts`, `dfRoundG_P14_routeLabelsReasons.test.ts`. See roles-and-permissions `GAP-13`, [`DEC-103`](../DECISIONS.md#dec-103).*

---

<a id="gap-108"></a>

*Assigned by the integrator, 2026-10-13, at the DF-P3 merge (DEC-31):* the measured leak rate waits only on the cancel-category picker → drafting-flow **DF-P9 TICKET-PAGE** (`LEAK-9` done-whens 1–2); the instrument (`outcome`, `/admin/analytics`) landed with DF-P3 and `20261195`.

## GAP-108 · "Where is my request"

**Verdict: BUILD_NARROW** · Effort: **S**

### Scope

**In:** the ticket states, in plain language, what stage it is at, who it is
waiting on, and how long it has been there.

**Out:** a redesign of the ticket page. This is a band, above the fold, in the
pattern the page already uses twice.

### Design

**Almost all of the content already exists.** `attentionLabel`
(`lib/ticketAttention.ts:95-107` (re-pointed: roles-and-permissions Round E rewrote the file, `WF-24`)) has the plain-English phrase for every status
and is currently rendered only in the notification bell. The current holder is
derivable from `assignedDrafterId` / `assignedEngineerId` / `requesterId` and the
status. Elapsed time is `last_modified`.

The **rendering pattern also already exists and is good**: the
revision-requested banner (`app/(protected)/requests/[id]/page.tsx:1661`) — *"Revision
requested — here's what to fix"* — states the situation in plain language at the
top with the required action attached. Generalize that.

Fold in `UI-2` while there: give the workflow map a visible affordance instead of
hiding it behind a status pill, and put it on the request form too, so a
first-time requester can see the process before committing to it.

### Do not

- **Do not rename the status enum values.** They are database identifiers that
  ripple into the state machine, the archive and the shed. Fix the display layer
  (`UI-7`).
- **Do not write a third set of plain-English labels.** Two already exist
  (`attentionLabel` and `WorkflowDiagramModal`'s blurbs). Route one of them.

### Acceptance

1. A ticket states its stage in plain language, names who it is waiting on, and
   shows how long it has waited.
2. The requester can tell at a glance whether the ball is in their court.
3. The workflow map has a visible affordance and is reachable before a request is
   filed.
4. No user-facing surface shows a raw status identifier as the primary label.

**Related findings:** `UI-1`, `UI-2`, `UI-4`, `UI-7`.

*Landed 2026-10-14 (drafting-flow Round G, DF-P9 TICKET-PAGE): acceptance 1–3 — the ticket's waiting line states the stage in words, who it waits on by name and part, and for how long, with "Your turn" when the engine offers the viewer a live action (`UI-1`); "View Only" is explained (`UI-4`); the workflow map has a visible affordance on the ticket and opens from the queue and from the request form before anything is filed (`UI-2`). The labels are one list (`lib/ticketStatusLabels.ts`), which the map's stage names read too. **Acceptance 4 is NOT met:** the request surfaces read that list, but six sites outside DF-P9's files still show the raw status or keep a third label set — `app/(protected)/admin/analytics/page.tsx:516`, the workflow route's bell body (`app/api/tickets/workflow-action/route.ts:1407`), email (`:1455`, `:1458`) and refusal text (`:360`), the SLA clock's bell / email bodies (`lib/ticketSla.ts:192`, `:196`, `:197`), and `components/dashboard/widgets.tsx:283-296`. The remainder and its owners are recorded under `UI-7` (OPEN, Partial); each fix is a call to `ticketStatusLabel`, never a new list ("Do not write a third set"). *(List completed at the DF-P9 integrator fix pass, which also fixed three more request sites with the shared list — a document's impact panel, the archived-ticket viewer and the printed traveler — and the queue board's lane chips; see `UI-7`.)*

*Assigned (2026-10-14, the integrator at the drafting-flow DF-P9 merge, DEC-31):* acceptance 4 (no raw status identifier as a primary label anywhere) → drafting-flow **DF-P14** (the `UI-7` remaining sites); acceptances 1–3 landed with DF-P9.

*Landed 2026-10-14 (drafting-flow Round G, DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS): acceptance 4 — the six remaining sites read the one list (`ticketStatusLabel`): `/admin/analytics`'s member ticket-list chip, the workflow route's refusal text, bell body and email (text and HTML; `metadata.status` keeps the stored value, which the bell's reconcile machine-reads), the SLA clock's "Due soon" / "Overdue" bodies, and the dashboard's Drafting Requests widget (its own label set removed, its classes kept). No third label set remains. *(Corrected at the DF-P14 review fix pass 2: the first search's patterns missed three sites, now fixed the same way — the Inbox's request lists chip (`app/(protected)/inbox/page.tsx:546`), a request hit's badge in ⌘K and on `/search` (`lib/globalSearch.ts:136`), and the admin help prose in `components/permissions/RoleModelTree.tsx:54`. The re-derivation, with the patterns used, is in `UI-7`'s Resolution; it finds no other ticket status shown as a primary label.)* All four acceptances now hold. See `UI-7` (RESOLVED).*

---

<a id="gap-109"></a>
## GAP-109 · Engineering review without a stop

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-110`, `GAP-111`, **`GAP-113`**

> ### ⚠ Hard precondition: `GAP-113`
>
> A consent window may not advance a ticket unless the system can prove it asked
> (`DEC-38`). `notify()` is documented fire-and-forget and swallows its error
> (`lib/inAppNotifications.ts:74-97`), and the workflow route does not resolve
> recipients at all (`LEAK-1`) — so today a window would advance on silence that
> nobody was ever given the chance to break.
>
> **Build `GAP-113` first. This spec is not safe without it.**
>
> Note also that `GAP-110`/`GAP-111` now supply the lane this keys off — the
> requester's declaration and the assigner's flag — rather than `GAP-101`'s
> triage-set class.

> The objection driving this spec: *"I'm complaining even over the engineer
> review."* That is a fair complaint and the audit under-served it. `TIER-1`
> establishes the engineering gate is pointed the wrong way; this spec is about
> making it cost less even when it points the right way.

### Scope

**In:** three mechanisms that let an engineering requirement be satisfied without
an engineer stopping their day, applied by work class.

1. **Silence-is-consent windows** — the reviewer gets a bounded period to object;
   no objection advances the ticket.
2. **Standing pre-authorization** — an engineer pre-approves a *class* of work,
   and tickets in that class carry their authority without touching them.
3. **Exception-only review** — where a standard detail was used, there is nothing
   to review; review the deviation.

**Out (deliberately):** removing engineering review from new design in a
code-governed service. That one genuinely needs a signature, and `GAP-103`'s
roster is where it belongs.

**Out:** silence-is-consent on the highest class. See `Do not`.

### Design

**Silence-is-consent is the highest-leverage of the three**, because it inverts
who must act. Today an engineer must act to say *yes*. Under a consent window
they act only to say *no* — and the happy path, which is most paths, costs zero
touches.

The document side already has the shape: `lib/reviewControl.ts` has
timeout-driven alternate activation, so the concept of "a reviewer had their
window and did not use it" is already modelled and already tested. This extends
that from *escalate to an alternate* to *advance on no objection*, per class.

**Standing pre-authorization** is how plants already work — approved standard
details, pre-approved repair procedures. An engineer records "any like-in-kind
gasket replacement in Unit 200, standing until I revoke it", and matching tickets
carry that authority with an audit reference to the standing approval. Zero
touches, and the engineer's prior instruction *is* the approval — which is
exactly the intent behind *"if an engineer says to do it a certain way."*

The per-person grant mechanism with expiry already exists
(`lib/capabilityPolicy.ts:98-110`) and is the right storage shape; what it lacks
is the resource dimension (`DEC-13`, `GAP-1`) to say *which* work a standing
approval covers.

**Exception-only review** depends on knowing a standard detail was used, which
means the detail must be a linked artifact rather than a copied block. That is
the largest of the three and the most deferrable.

### Do not

- **Do not apply silence-is-consent to the highest work class.** A new tie-in in
  a hazardous service auto-advancing because an engineer was on leave is exactly
  the PSM failure this system exists to prevent. Classify first (`GAP-101`), then
  choose the mechanism per class — that is what the classification is *for*.
- **Do not make the consent window silent.** The reviewer must be told the clock
  started, told again before it expires, and the advance must be audited as
  *advanced on no objection*, naming who did not object. A consent window that
  nobody knew about is not consent.
- **Do not let a standing pre-authorization be open-ended.** It expires, it is
  revocable, and every ticket that used it names it.
- **Do not build this before `GAP-101`.** Applied without a class, a consent
  window is either useless (set long enough for the riskiest work) or dangerous
  (set short enough for the routine).

### Acceptance

1. A like-in-kind ticket whose reviewer does not respond within the configured
   window advances, with an audit entry naming the reviewer and the window.
2. The reviewer was notified at window start and before expiry.
3. An engineer can record a standing pre-authorization scoped to a work class and
   an area, with an expiry, and matching tickets cite it instead of waiting.
4. Revoking a standing approval stops future tickets citing it, and the ones that
   already did remain traceable.
5. The highest work class is **not** eligible for either mechanism, and a test
   pins that.

**Related findings:** `TIER-1`, `TIER-5`, `FRIC-1`, `FRIC-4`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P7 CONSENT): mechanism 1 only — the silence-is-consent window. A window exists ONLY on a routing slot explicitly configured `consent_window` (DF-P5's `routing_control`; DEC-90 ruling (1)): the seed and every unconfigured workspace keep today's blocking roster, and before `20261255` is pasted a configured consent slot is still a sign-off, said on the answer. The highest work class is the engineered lane (`engineeringGateRequired`, DF-P6 and the legacy seed): an engineered request never gets a window (its consent slot waits as a sign-off, the reason named on the roster's history line), and a consent slot filled by an engineering capability (`ticket.final_approve`, `ticket.eng_review`) is refused in the editor with a visible reason (`lib/routingControl.ts` `validateRoutingDraft`). One window per review, on the slot's own occupants frozen at open; 3 working days by default, warned at 2/3 (`window_days` / `warn_fraction` per slot, 1–30 days, 0.1–0.9); an occupant may object with a reason (`object_consent_window`), which stops the advance and leaves the slot waiting for a sign-off; on close the slot is recorded satisfied via `consent` (no signer, no signature — `ticket_review_slots` widened in `20261255`), and when it was the last sign-off the request issues through the same issue limb as a sign-off (status, revision label, stamped finals, issue-as-is); *corrected at the DF-P7 fix pass 2:* it is not fully route-parity — it now also tells the `PENDING_IFC` routed pool (`LEAK-1`) and clears the request's document intents at `FINAL_DRAFT`, as the route does, but the `PHYS-18` copy recall and the requester / drafter email are not run (DEC-44 (DF-P7-consent) item 12, owners in `99-fix-sequencing.md`). Files: `lib/consentWindow.ts`, `lib/consentWindowScan.ts`, `lib/workflow.ts`, `lib/ticketTransitions.ts`, `lib/ticketRoster.ts`, `app/api/tickets/workflow-action/route.ts`, `app/api/cron/maintenance/route.ts` (step 5c; no new cron entry), `components/requests/ConsentWindowCard.tsx`. Acceptance 1 ✓ for any request outside the engineered lane whose library routing configures a consent slot ("like-in-kind" is that lane under DF-P6) — audit row `TICKET_CONSENT_WINDOW_ADVANCE` first, naming each person asked and the window (`consentWindowScan.test.ts`). Acceptance 2 ✓ (`GAP-113`, below). Acceptance 3 and 4 ✗ — standing pre-authorization is not built (no resource dimension on grants, `DEC-13` / `GAP-1`). Acceptance 5 ✓ for the consent window (route test "NEVER on the highest work class", `consentWindow.test.ts` `planConsentWindow`, the editor refusal); vacuous for pre-authorization until it exists. Mechanism 3 (exception-only review) not built. Not built here: the `window_days` / `warn_fraction` inputs in `components/documents/RoutingControlSection.tsx` (DF-P5's file — the values are read when present; see the DF-P7 hand-offs in `99-fix-sequencing.md`). Fix pass (review): DEC-12 / DEC-37 hold whatever the table declares — the people asked are never the drafter nor a party the slot is independent of (`lib/consentWindow.ts` `consentRecipients`; `open_consent_window` refuses them), a slot left with nobody else is BLOCKED and escalated, and a close where nobody but the drafter was asked is held; an issuing close runs the route's source-revision check first (a moved or unreadable source holds it for a person) and requires the roster ledger to agree; `open_consent_window` and the cron read the service-written ledger, never metadata alone. Acceptance 1 is therefore met only outside the engineered lane — "engineering review without a stop" is delivered for non-engineered sign-offs; the engineered lane always waits (DEC-44 (DF-P7-consent) item 1, a departure for the integrator to confirm). Fix pass 2 (review): DEC-37 slot-to-slot independence holds for silence too — nobody who signed, or can still sign, a slot the consent slot must be independent of (or that must be independent of it) is asked (`consentConflictedPeople`; `open_consent_window` refuses them from the ledger), and a close with nobody independent told is held (`independence`); the close is also held while another open slot can be signed only by the drafter, so a silent close never leaves the producer floor refusing the drafter for good (`drafterOnlyOpenSlot`; both sign orders pinned); the `consent` ledger shape is accepted only on a `consent_window` slot. Fix pass 3 (review): *corrected —* the "issue-as-is" above is honoured only when the window's opening notice named the drafter's mark (`lib/consentWindow.ts` `issueAsIsNamedAtOpen`; the notice, its email, the history line and the reminder carry `ISSUE_AS_IS_NOTE`), and the engine does not offer the mark while a window runs; otherwise the close takes the `PENDING_IFC` hop and withdraws the mark, said (FRIC-5 — DEC-44 (DF-P7-consent) items 7 and 19). The close counts only people still active members (a recipient suspended or removed during the window is not counted; with nobody independent left it is held, `no_longer_member`, and the assignment queue told — item 20), re-checks the engineered lane with the requester's current roles, the current policy and engineering-first types (held, `engineered` — item 1), and a consent slot saved before DF-P7 (when the editor said it "waits like a sign-off") opens no window until a controller re-saves the table (`consent_confirmed`, stamped by `setRoutingControl` — item 18). A planned window `open_consent_window` refuses for good (22023 / 55000 / 23505) is blocked once, not retried (item 21). Tests: `consentWindow.test.ts`, `consentWindowScan.test.ts`, `dfRoundG_P7_consentRoute.test.ts` ("fix pass 3").*

*Assigned (2026-10-21, the integrator at the DF-P7 merge, DEC-31):* mechanisms 2 and 3 (standing pre-authorization, exception-only review) → drafting-flow **DF-P22 CONSENT AND ESCALATION FOLLOW-UPS**.

---

<a id="gap-110"></a>
## GAP-110 · The like-in-kind declaration

**Verdict: BUILD** · Effort: **S** · Depends on: — · Decisions: `DEC-33`, `DEC-34`

### The requirement it implements

Verbatim from the system's owner, and the most important sentence in this audit:

> *"Unapproved construction packages can not be pushed into the field. One of our
> policies is only use engineered packages unless the requester has declared it
> on request this is like-in-kind — meaning it is inferred this was already
> engineered at some point, we are putting back exactly the same, we just need to
> replace something."*

### Scope

**In:** one optional question on every intake path, a typed statement when
answered, three immutable columns, and one boolean that the state machine reads.

**Out:** any change to who reviews what. That is `GAP-101` + `GAP-111` consuming
this. Build the declaration first; it is independently correct and independently
useful even if nothing else ships.

### The half that already exists — and the door it is missing from

`lib/checkinOutcomes.ts` already models this policy correctly. Read its header
before writing a line:

```
//   * every claim-creating branch requires a TYPED note (no canned text,
//     no get-out-of-jail-free cards — same bar as approve_minor_correction),
//   * a real change to a DRAWING-class document demands an MOC position
//     (OSHA 1910.119(l)) …
//   * minor corrections are replacement-in-kind: no MOC, mirroring the
//     existing Minor/Correction review-gate exemption.
```

It is pure, unit-tested, derives an MOC requirement from the declared doc class,
and requires a typed note for every claim. **The vocabulary and the standard both
already exist in this repository.**

They exist on the **check-in door only.**

There are **three** ways a ticket gets created. Enumerated by searching for
`.insert` against the `tickets` table across `app/`, `lib/` and `components/`,
excluding tests — several other files call `.from("tickets")` and are reads:

| Door | File | Declaration asked for? |
|---|---|---|
| Intake form | `app/(protected)/requests/new/page.tsx:328` | **No** |
| Check-in outcome | `components/documents/CheckInPanel.tsx:236` | Yes — MOC position + typed note |
| Transition-in collision scan | `lib/transitionIn.ts:304` | **No** |

Two of three doors reach the same outcome — a revised controlled drawing — with
no declaration at all, and one of them is the **main** door. **That is the leak
this gap closes**, and it is a policy leak rather than a code defect, which is
why no existing finding names it.

There is a fourth writer worth knowing about and **not** treating as a door:
`app/api/admin/ticket-shed/restore/route.ts:191` UPDATEs archived stubs back to
life. It is guarded — `.not("archived_at", "is", null)`, described in its own
comment as *"defence-in-depth against a TOCTOU flip"* — and it restores a
declaration that already existed rather than creating one. **Leave it alone.**

### The half that is worse than missing

The one door that *does* ask writes the answer to `metadata`:

```ts
// components/documents/CheckInPanel.tsx:263-266
...(card.moc === "required" ? { moc: { status: mocStatus, number: … } } : {}),
...(card.ticketKind === "minor" ? { minor_correction: true } : {}),
...(undocumented ? { undocumented_change: true } : {}),
```

A repo-wide search across `app/`, `lib/`, `components/` and `types/` finds **no
reader of `metadata.moc`, `metadata.minor_correction` or
`metadata.undocumented_change` for any authority decision.** `getActions` never
reads `ticket.metadata` at all.

So today: a person can declare at check-in that they are making an **undocumented
change to a drawing with no MOC**, and the resulting ticket flows through the
identical path as any other. The declaration is captured and inert.

That is arguably the most defensible thing in this audit to fix first. It is
already being asked. Nothing listens.

### Design

**Storage — columns, never JSON:**

| Column | Set by | Mutable |
|---|---|---|
| `like_in_kind_statement` | requester, at creation | **never** |
| `like_in_kind_declared_by` | server, from the session | never |
| `like_in_kind_declared_at` | server | never |
| `engineering_required` | server: `true` unless a statement exists | **true-ward only** |

The typed statement carries a minimum length. No canned options, no dropdown. The
same bar `checkinOutcomes` sets: *no get-out-of-jail-free cards.*

**Every door asks the same question.** One shared component, one shared
server-side validator. A door that cannot show UI (the external portal) defaults
to no declaration, which is the safe lane — and says so in the portal's
confirmation text.

**Backfill:** existing tickets get `engineering_required = false` — not `true`.
Retroactively blocking every open ticket in production on a gate that did not
exist when they were filed would strand live work, which is how a safety feature
teaches people to bypass the app. New tickets get the new default from day one,
and the report in `GAP-101` acceptance #5 is what tells you the lane is being
used honestly.

### Do not

- **Do not make it required.** Its optionality is what makes it safe: an
  unanswered question yields the rigorous lane. A required field the requester
  cannot answer is `UI-5` again.
- **Do not offer canned text or a picker.** A checkbox is clicked without
  reading. A sentence is a statement someone can be held to, and it is the
  artifact a regulator asks for.
- **Do not let it be edited, by anyone, including an admin.** A wrong declaration
  is corrected by the assigner flagging engineering (`GAP-111`) — recorded as an
  override on top, never as a rewrite underneath.
- **Do not store it in `metadata`.** See above. That is the exact mistake already
  present.
- **Do not skip the four silent doors.** A policy enforced at one of five
  entrances is not enforced.

### Acceptance

1. All three creation paths either capture a declaration or record its absence,
   and a test enumerates all three so a fourth door cannot be added silently.
2. A statement shorter than the minimum is rejected server-side, not only in the
   form.
3. No code path anywhere sets `engineering_required` from `true` to `false`. A
   test pins this.
4. The declaration renders attributed on the ticket, on the issued deliverable,
   and in ticket history.
5. `metadata.moc` / `metadata.minor_correction` / `metadata.undocumented_change`
   are either promoted to columns that something reads, or explicitly documented
   as informational. **Not left as-is.**

**Related findings:** `TIER-1`, `TIER-2`, `LEAK-3`, `UI-5`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P6 REVIEW-MODEL): the declaration is one optional sentence on the request form (no checkbox, no picker, no canned text), signed through the existing e-signature ceremony (intent `Acknowledged`, statement "Like-in-kind declaration: <the sentence>", resource the ticket id it will be filed under) and checked by `/api/tickets/create` before a number is spent (the requester's, this workspace, this id, this statement, within 30 minutes, the id not already filed — else 400 / 409 `declaration_used`; and, since the review fix pass, the id carries no other history — no other person's signature and no audit row but this declaration's capture, else 409 `declaration_key_used`); stored in four columns (`20261250`), not metadata, immutable for every caller. Acceptance 1 ✓ (every ticket INSERT in the app is the create route's — the three doors post there; enumerated by `lib/__tests__/reviewModel.test.ts` "GAP-110 acceptance 1 …", so a fourth door fails it); 2 ✓ (the contract and a CHECK, 20–2000 characters); 3 ✓ (no transition writes `false`, every action × every status pinned; the guard refuses true → false for every caller); 4 ✓ in part (the request page, its history and the audit trail; not the issued deliverable — see `GAP-101`); 5 ✓ documented: `metadata.minor_correction` / `undocumented_change` are informational records of the check-in (nothing reads them for authority; counted by the inventory, row 43); `metadata.moc` is the hand-back's (LIFE-5). 'Do not' kept.*

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31):* a declaration restored from a backup (no `e_signatures` row is ever restored) → admin-and-org **P18 RESTORE REVIEW-MODEL ROWS**.

**Resolution (2026-10-21, admin-and-org Round G P18).** P18 RESTORE REVIEW-MODEL ROWS — the restore remainder of the declaration (`DEC-34`; DEC-90 ruling (2) as given in the brief, with (3)–(5)). The page remainder — the restore page drawing each request's words, and its headline not counting these as pointers — was owned by admin-and-org **`BKP-17`**, resolved by P18's final fix pass (the integrator put the panel in its scope, DEC-90). *(Corrected by the P18 second fix pass, DEC-29: this block first read "Resolution", with the notes limb ✓ although it was not done on the page; it then read "Partial" until the final fix pass drew the lines on the page.)* Reproduced on the base (`b96299d`): `lib/dataRestore.ts` `applyRestoreChunk` wrote a backup's `like_in_kind_*` and `engineering_required = false` as they were (the service role passes the insert guard), while `e_signatures` is never restored (`IMMUTABLE_TABLES`) — so the stored row said "declared, not required" (`engineering_required = false` beside a declaration whose signature is not on record). The workflow route (fix pass minor 11), the request page (`ticketAsDeclarationChecked` — `app/(protected)/requests/[id]/page.tsx:1551`, `:2315`, and the roster panel it mounts, `:2849`) and `components/requests/DeclarationCard.tsx` (`declarationSignatureStands`, `:100`) already treated it as undeclared; every other reader of the raw columns — the requests list, the inbox, exports — read it as declared and not required. P18 makes the stored row agree. *(Corrected by the P18 fix pass, DEC-29: this sentence first said the request page's seed and the roster read it as declared, and that only the workflow route treated it as undeclared.)*

Landed (no migration), in `lib/dataRestore.ts`:
- **`restoreReviewModelFacts`** (`:1982`): for the `tickets` rows that carry a declaration (any of the four columns set — `carriesDeclaration`), one read of `e_signatures` by id (≤200 a call; a malformed id is not read) and the workflow route's own test, `lib/reviewModel.ts` `declarationSignatureStands` (this workspace, `resource_type` ticket, this request's id, signed by the declarer). Only when the target has `20261250`'s columns (the same read-once check as `TIER-1`'s block); a signature read that fails stops the chunk before any write.
- **A declaration whose signature does not stand** is written with its four `like_in_kind_*` columns cleared together (the all-or-none CHECK) and `engineering_required = true` (`DECLARATION_NOT_RESTORED_VALUES`) — `review_model_filed` as the backup carries it (or `false` by `TIER-1`'s rule). It rides the pre-write rules as a cleared pointer does (`sets`, `:2309`; located with them, `:2335`), so its note is emitted only for a row the write takes: one per request in the chunk's `cleared` notes, code `DECLARATION_NOT_RESTORED` (`declarationNotRestoredMessage`, `:1939`: "like_in_kind_* cleared on request <number>: its requester declared the work like-in-kind and signed that declaration electronically, but the signature is not on record in this workspace (a backup carries no signatures), so the request was restored as undeclared — it now needs an engineer's sign-off (or a recorded management override) before it issues …", with the statement quoted; *P18 fix pass:* when the request is also renumbered on restore (EDGE-5 — the renumbering runs after the note is built), the note names the number it is restored under: "like_in_kind_* cleared on request <new number> (restored under this fresh number; "<backup number>", the number it carried in the backup, names another request in this workspace): …" — `declarationNoteRenumbered`, `:1952`, applied at `:2617`; it first named the backup number, which in the workspace is the other request's), `restoreRefusalLabel` names the code (`:1413`). The `RESTORE_CHUNK` audit row carries each note. *P18 final fix pass:* the note carries the number it names as a structured field, `ticketNumber` (additive; rewritten with the note on a renumbering), and the restore page lists each request from it in its own block, in the note's words, counting these apart in the headline ("N declaration(s) not restored (those requests now need an engineer's sign-off)") — admin-and-org `BKP-17`. A request whose declaration is cleared is written REQUIRED, so `TIER-1`'s filed-before line no longer counts it (the integrator's ruling, DEC-90); and a request already here that ruling (2) flags no longer changes how EDGE-5 names the holder of a number another backup request carries (`TIER-1`'s block, ruling (5)).
- **A signature that stands** (the request restored into the workspace that still holds it) keeps the declaration exactly as it is. **A request with no declaration** is unchanged. **A request already here** is never touched (ON CONFLICT DO NOTHING — `ticket_update_guard`'s every-caller limb never fires; counted existing, no note).

Tests: `lib/__tests__/aoRoundGP18RestoreReviewModel.test.ts` — the declaration cleared, all four columns, `engineering_required` true, `review_model_filed` kept, one note in a plant admin's words (and in the `RESTORE_CHUNK` row), a plain request in the same chunk byte-identical; every reader then agrees (`reviewModelFieldsFromRow` → `isDeclaredLikeInKind` false, `engineeringGateRequired` true for a Manager requester); a signature of the same id held by ANOTHER workspace, given for another request, signed by another person, or a malformed id → cleared; one on record here for this request by its declarer → kept as it is; a hand-made row with a declaration and no `review_model_filed` → filed before the model, undeclared and REQUIRED (the cleared declaration wins over the seed); an existing request (same id) with a declaration → no UPDATE, kept, counted existing, no note; a renumbered request (EDGE-5) carries both notes, the declaration's naming the fresh number and never "cleared on request <backup number>:" (pinned in the message and the `RESTORE_CHUNK` row; fix pass), and `declarationNoteRenumbered` leaves every other note as it is; a signature read error → 500, nothing written; without `20261250` no signature is read and the row goes out as the backup carries it (the database answers as it always has). Mutation-checked: without the `flagged` inclusion, the existing-request case reports a note for a row never written; without the renumber rewrite, the EDGE-5 case fails (fix pass).

**Done-when.** *(The brief's criteria for the restore remainder.)*
- ✓ A restored declaration with no `e_signatures` row standing in the target is cleared together (all four columns) and `engineering_required` is set true.
- ✓ Reported per request in the restore notes, in words a plant admin understands — the `cleared` notes and the `RESTORE_CHUNK` audit row carry one message per request, naming the number it is restored under; **and on the page** — each request listed by number in its own block in the note's words, counted apart from the pointers in the headline (`RestoreResultPanel.tsx` `DeclarationLines`; admin-and-org **`BKP-17`**, RESOLVED by the P18 final fix pass; pinned by rendered tests). *(Corrected by the P18 fix passes: first a plain ✓, then "✓ (notes / audit)" under a Resolution heading, then ◐ until the final fix pass.)*
- ✓ A ticket with no declaration is unchanged (pinned); every other table unchanged (pinned).
- ✓ Only when the target has the columns; a target without `20261250` restores as before (pinned).

**Scope / residual.** The page remainder (the headline counting these among "pointer(s) cleared", the table line showing the label, not each request's message) is resolved: admin-and-org **`BKP-17`**, RESOLVED by the P18 final fix pass. Acceptance 1–5 above are DF-P6's and unchanged.

---

<a id="gap-111"></a>
## GAP-111 · The assigner's flag becomes binding

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `GAP-110` · Decisions: `DEC-33`

### The requirement it implements

> *"Being that there is always a drafting manager that is assigning these, part
> of his responsibility can be to flag engineering — then it becomes required.
> Otherwise it's opportunistic and can close and be considered approved by the
> drafting manager."*

### This is 80% built. The missing 20% is one boolean.

The action already exists, at two statuses, with the right ergonomics:

```ts
// lib/workflow.ts:93-101 (NEW) and :146-153 (PENDING_ASSIGNMENT)
actions.push({
  label: 'Flag for Engineering Review',
  action: 'request_eng_review',
  requiresComment: true,
  requiresEngineerPick: true,
  description: 'Route to a specific engineer for scope review before assigning a drafter.'
});
```

It already persists a real record:

```ts
// lib/ticketTransitions.ts:179-189
case "request_eng_review":
  updates.status = "PENDING_ENG_TEAM";
  if (input.engineer) {
    updates.assigned_engineer_id = input.engineer.id;
    updates.engineer_review_requested_at = now;
    updates.engineer_review_reason = finalComment || null;
    …
```

And the flow's own author already intended exactly the model the owner described:

```ts
// lib/workflow.ts:46-50 — getInitialStatus
// Every new request lands in the assignment queue … Engineering review is
// an OPTIONAL branch the assigner triggers via "Flag for Engineering
// Review", never an automatic gate.
```

**What it does not do is bind the approval end.** `approve_team` sets status back
to `PENDING_ASSIGNMENT` and carries nothing forward
(`lib/ticketTransitions.ts:190-192`). At `PENDING_REVIEW` the only thing consulted
is:

```ts
// lib/workflow.ts:78
const needsEngineerApproval = requiresEngineerApproval(ticket.requesterRole);
```

**Consequence, confirmed by reading the state machine:** a drafting manager flags
a ticket for engineering, an engineer reviews the scope, and then — if the
requester happened to be a Manager, Admin or DocCtrl — the requester self-approves
straight to IFC with no engineering sign-off on the deliverable. The flag bought a
conversation and no gate.

### What the flag actually means

Stated by the owner in the clearest form yet:

> *"The drafting manager can be the gate and say: hey wait, this requires
> engineering — no deliverable without official approval. And it goes through the
> ringer to get official approvals from routed people."*

Three things in that sentence, and each one changes the build:

#### 1. The flag gates **delivery**, not drafting

*"No deliverable without official approval"* is a constraint on the **issue
point**, not on when work may start. That distinction is worth a whole wait
state:

| | Sequence | Waits |
|---|---|---|
| **Today** | flag → `PENDING_ENG_TEAM` → engineer reviews scope → back to `PENDING_ASSIGNMENT` → assign → draft → review | drafting waits on engineering |
| **What the owner described** | flag → **drafting starts now**, approval roster opens **in parallel** → deliverable cannot be **issued** until the roster is complete | only the issue point waits |

Drafting a package that later needs a change is cheap — that is what revisions
are for. **Making a drafter sit idle while an engineer reads a scope note is
not.** Gating the issue point instead of the start point gets the identical
safety outcome and gives the drafting time back.

So `engineering_required` must gate the **issue transitions** —
`approve_draft_ifc`, `engineer_approve_final`, `submit_final` and
`approve_minor_correction` — not merely insert a status early on. Today
`PENDING_ENG_TEAM` sits *before* assignment, which is the expensive placement.

⚠ **`approve_minor_correction` is the one that matters most here.** It routes
straight to `PENDING_IFC` (`lib/ticketTransitions.ts:230-235`) and is offered to
every requester at `PENDING_REVIEW` — including the branch the engineer gate
blocks. A delivery gate that does not cover it is not a gate.

#### 2. "Routed people" is plural, and derived — not picked

The flag currently carries `requiresEngineerPick: true`: the assigner must
personally choose **one** engineer from a list. Two problems.

- It is `FRIC-4` — making someone hand-pick a reviewer is a routing question that
  demands more domain knowledge than the review itself.
- It caps official approval at one person, when *"routed people"* plainly means
  whoever that library and that class of work require — which may be several.

Under `GAP-112` the assigner **flags, and the router resolves who**. The assigner
does not need to know, and on a parallel roster (`GAP-103`) N approvers still cost
**one** wait state.

Keep `requiresEngineerPick` as the fallback for an org with no routing configured.
Do not keep it as the only path.

#### 3. The flag must be available later than assignment

A drafting manager who realises at review time that something needs engineering
must be able to say so. Today the action exists only at `NEW` and
`PENDING_ASSIGNMENT` (`lib/workflow.ts:93-101`, `:146-153`).

Offer it wherever `ticket.manage` / `ticket.assign` holds and the ticket has not
yet issued. Because the gate is now on delivery rather than on starting, a late
flag does not restart anything — it just adds the requirement the deliverable
must satisfy before it can be issued.

### Scope

**In:**

1. `request_eng_review` sets `engineering_required = true`, permanently.
2. `engineering_required` gates **every issue transition**, including
   `approve_minor_correction`.
3. Drafting is **not** blocked by the flag; the approval roster runs alongside it.
4. The flag is available at any pre-issue status to whoever can assign.
5. Where a router exists, the flag resolves approvers through it rather than
   requiring a hand-pick.

**Out:** removing `PENDING_ENG_TEAM`. A pre-drafting scope review is genuinely
useful when the assigner wants one *before* spending drafting hours — it just
must not be the only way to require engineering, and must not be mandatory.

### Why a blocking signature is correct here

`99-fix-sequencing.md` says a wait on a specific person is a defect *until its
consequence justifies it*. **This is the case where it does.** An unapproved
construction package reaching the field is the consequence the whole system
exists to prevent, and there is no clock-based substitute for a signature that
says a qualified person accepted the design.

That is precisely why the flag matters: it makes blocking signatures
**countable**. A facility should be able to say *"we had N official approvals last
month, all of them flagged, and here is who flagged each one and why."* If that
number is not small and not explainable, the problem is the flagging policy — not
the flow.

**Everything not flagged advances without a person in the way.** That is the
trade: a small, deliberate, named set of real gates, in exchange for no ceremony
anywhere else.

### Why the *checking* costs zero waits

The gate above is deliberate. The **decision to apply it** costs nothing.

The drafting manager is **already in the loop on every ticket** —
`PENDING_ASSIGNMENT` is the initial status for every request from every door
(`lib/workflow.ts:44-51`). They already open the ticket, already read it, already
act on it.

Reading a one-line declaration while doing that is not a new stop. **That is the
entire reason this model satisfies the governing principle** — the checking party
was already there. Compare a QA/QC status, which inserts a person who was not.

### Do not

- **Do not let the flag be cleared.** True-ward only. If an assigner flags in
  error, the engineer's review resolves it — that costs one review, and the
  alternative is a clearable safety gate.
- **Do not let the assigner clear a like-in-kind declaration**, or set
  `engineering_required = false`. `DEC-33`'s ratchet only turns one way.
- **Do not delete `requiresEngineerApproval` in this change.** Leave it in place
  as the seeded fallback for tickets predating `GAP-110`'s columns, and remove it
  in a later, separate change once no rows depend on it.
- **Do not add a new status.** The delivery gate is a *condition on existing
  transitions*, not a stage. `PENDING_ENG_TEAM` stays available as the optional
  pre-drafting scope review.
- **Do not block drafting on the flag.** The constraint is *"no deliverable
  without official approval"* — not *"no drafting without official approval"*.
  Blocking the start is the expensive misreading and buys nothing.
- **Do not leave `approve_minor_correction` outside the gate.** It routes
  straight to `PENDING_IFC` and is offered to every requester. A delivery gate
  that misses it is not a gate.
- **Do not force the assigner to hand-pick the approver** once a router exists.
  Flagging is a judgement about the work; choosing who reviews is a routing
  question they should not have to answer (`FRIC-4`).

### Acceptance

1. A flagged ticket cannot **issue** without official approval, whoever the
   requester is — Manager, Admin and DocCtrl included. A test pins each.
2. **Every** issue transition is gated, `approve_minor_correction` included. A
   test pins that one by name.
3. A flagged ticket can still be drafted and submitted while approval is pending
   — the roster runs alongside drafting, not in front of it.
4. The flag can be raised at any pre-issue status by whoever can assign, and a
   late flag does not reset the ticket or discard drafting work.
5. Where routing is configured, flagging resolves approvers through it; N
   approvers cost one wait state on the roster.
6. `approve_team` leaves `engineering_required = true`.
7. No path sets it false.
4. The ticket shows *why* engineering is required — declaration absent, or
   flagged by a named person on a date with their stated reason. "Because of your
   job title" disappears as an answer.
5. An unflagged, declared like-in-kind ticket closes through the assigner with
   the assigner recorded as the approver of record — which is what the owner
   described, made explicit rather than implicit.

**Related findings:** `TIER-1`, `TIER-5`, `LEAK-3`, `UI-1`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P6 REVIEW-MODEL): `request_eng_review` and the new `flag_engineering` (the assignment queue, at `PENDING_ASSIGNMENT`, `DRAFTING`, `REVISION_REQ`, `PENDING_REVIEW`, a reason required, no status change) write `engineering_required = true`; nothing writes false. Acceptance 1 ✓ and 2 ✓ (every issue transition by name, `approve_minor_correction` included); 3 ✓ (drafting continues); 4 ✓ (any pre-issue status the queue can assign at; no reset); 5 ✓ on routed libraries (the engineering slot is appended where the gate applies — DF-P5 `withEngineeringGate`); 6 ✓ (`approve_team` writes nothing for it); 7 ✓; "the ticket shows why" ✓ (`DeclarationCard`: declared by whom and when / required — flagged or no declaration / the earlier rule for a pre-paste request); the declared like-in-kind request closes through the assigner and requester, the requester's approval recorded as the approval of record.*

*DF-P6 third review fix pass (2026-10-21, DEC-29): `request_eng_review` sets `engineering_required` only on a request FILED under the review model (`tickets.review_model_filed`, `20261250`) — never on a pre-paste row (DEC-90 ruling (2): an in-flight request does not change lane because a triager asked a scope question), and not as a declared request's engineering-first loop (fix pass 2). On those rows `flag_engineering` is the explicit binding flag. Proposal note 1 above ("`request_eng_review` sets `engineering_required = true`, permanently") holds for every request filed after the paste. Where it binds, "Flag for Engineering Review" now says so before the click (`lib/workflow.ts` `FLAG_ENG_REVIEW_BINDS_DESCRIPTION`). Tests: `lib/__tests__/reviewModel.test.ts` "fix pass 3 (review, major) …", `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "fix pass 3 (review, major) …".*

---

<a id="gap-112"></a>
## GAP-112 · The routing table — no facility vocabulary in code

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-105` · Decisions: `DEC-35`, `DEC-36`, `DEC-37`

### The requirement it implements

> *"I don't want to bake in anything that says QA/QC — I'd rather have a dynamic
> router, a router configuration. Having it baked into roles boxes the app into
> names and conventions other people don't subscribe to at their facility."*
>
> *"This assign should exist in the doc ctrl so we could use it here."*
>
> *"Where I work I'm the drafting manager and the QA/QC, so I can approve a
> drawing. But that might not be true elsewhere."*

All three sentences describe one thing: **routing is data, resolved through
document control, and one person may fill several slots.**

### This replaces the reviewer-shaped parts of GAP-102 and GAP-104

`GAP-102` and `GAP-104` each describe a specific routing need — quality
assurance, and per-library release review. Both were written before the router
existed as a concept. **Neither should be built as a bespoke mechanism.** Build
the router; express both as configuration in it. Their `Do not` lists still
apply — especially "no new status, no new role."

### Where it lives — corrected

> An earlier version of this spec put the routing table in `org_configurations`
> under a new key. **`DEC-36` has been revised: it belongs as a
> `routing_control JSONB` column on `libraries`, `collections` and `documents`**,
> exactly where `review_control` and `doc_class` already sit.
>
> The reason is that routing must resolve **per container** — which is the whole
> requirement, "route this drawing type to the doc control of that library". A
> per-org blob needs its own library→rule index maintained by hand, in parallel
> with a chain walk that already exists. Two mechanisms for one question is how
> they drift apart.
>
> The migration mirrors `20261012` (doc_class) line for line: additive,
> idempotent, and inheriting the existing per-table RLS on `libraries` and
> `collections` — no new policies.
>
> Two further traps found while checking this:
> - `org_configurations`'s JSON column is **`data`**, not `value`
>   (`supabase/schema.sql:52-59`). Writing `value` is a runtime error, not a type
>   error.
> - **Do not model routing stops as `CapabilityId`s.** `lib/capabilityPolicy.ts`
>   is a fixed 17-member union with `defaultRoles` baked per entry. A facility's
>   stop is data; a capability is code.
> - **Do not add a facility's role to the `Role` union.** `types/schema.ts` is a
>   closed union of 19 literals and `ROLE_CAPABILITIES` is
>   `Record<Role, Capability[]>` — adding one is a code change, which is exactly
>   what `DEC-35` forbids.
> - **Do not key the router on `ticket.status`.** That is what
>   `lib/ticketRouting.ts:97-107` does today, and it is why routing cannot vary
>   by library or work class.
> - **Do not let the router resolve to nobody.** `lib/ticketRouting.ts:83-92`
>   currently guarantees a non-empty pool via `fallbackToAdmins`. Keep that
>   property — an empty stop is a silently dropped request.

### The substrate is already there

Nothing here needs a new table.

| Piece | Where | What it gives you |
|---|---|---|
| Per-org config JSON + admin editor | `org_configurations` (`org_id`, `key`, `data`); editor at `app/(protected)/admin/requests/page.tsx:72-101` | The drafting form's request types, units and priorities are **already** org-configured exactly this way. A router is one more `key`. |
| Container-chain resolution | `resolveEffectiveDocClass` — `lib/docClass.ts:49-58` | Six lines. Document → folder → library, most specific **defined** level wins. Already mirrored by `review_control`. |
| Roster mechanics | `lib/reviewControl.ts` | Required primaries, alternates, content-hash-bound signatures, invalidation on change, timeout-driven alternates, auto-finalize. Done. |
| Named-person grants with expiry | `lib/capabilityPolicy.ts:98-110` | Fills a slot with a person rather than a role. |
| Standing visibility | `lib/subscriptions.ts` | A slot can be *notified* rather than *blocking*. |
| Stop-work authority | `holds` — defaults `["*"]`, `lib/capabilityPolicy.ts:85-88`; enforced `lib/documentGuards.ts:109-125` | A slot's recourse when it has no signature. |

### Design

A **slot** is the unit. Code knows slot *properties*; it never knows slot
*names*.

```
slot := {
  key:            <facility's own string — "qa", "insp", "process-safety", anything>
  label:          <what the facility calls it, shown in the UI>
  fill:           { roles: [...] } | { users: [...] } | { owner_of: "library" }
  mode:           "blocking" | "consent_window" | "notify_only"
  applies_when:   { lane: "engineered" | "like_in_kind" | "any", … }
  independent_of: [<slot keys>]        // DEC-37
  window_hours:   <number>             // mode = consent_window only
}
```

**`mode` is the friction ladder made configurable.** The same facility can put
its quality function on `notify_only` (zero waits, zero touches, keeps its hold
authority) and its process-safety function on `blocking` for the engineered lane
only. Neither choice is in the code.

`applies_when.lane` keys off `GAP-110`'s declaration, which is why that ships
first.

**Resolution** copies `resolveEffectiveDocClass` exactly — document → folder →
library, most specific defined level wins — and copies two of its properties that
are not merely stylistic:

1. **Declared, never guessed.** *"guessing from filenames would misroute
   safety-critical documents."* A router must never infer a slot from a title or
   a filename.
2. **Fail closed on transient error.** *"'we couldn't check' must never silently
   read as 'no class declared' — that's how a PSM gate quietly turns itself
   off."* A router that cannot load its config **blocks with a legible message**.
   It does not default to permissive.

**Seeding.** An org with no configuration gets a seed that reproduces today's
behaviour exactly, built from the existing helpers — `isEngineerRole`,
`isManagementRole`, `isDocCtrlRole`. Those functions become *seed data*, not dead
code and not deleted code.

### One person, many slots

Per `DEC-37`, a person satisfies every slot they can fill, in one action, and the
record shows each slot satisfied and by whom. The only constraint is
`independent_of`, seeded so that the approval slot cannot be filled by the
drafter — which is about **one deliverable's producer versus its checker**, not
about how many hats someone wears.

This is the concrete answer to *"I'm the drafting manager and the QA/QC."* Both
slots resolve to the same person, both are satisfied, and the audit trail says so
explicitly rather than pretending one of them did not apply.

### A defect to fix before storing anything here

The admin editor's access guard is **client-side only**:

```tsx
// app/(protected)/admin/requests/page.tsx:63-67
useEffect(() => {
  if (activeRole && !['Admin', 'DocCtrl'].includes(activeRole)) {
    router.push('/dashboard');
  }
}, [activeRole, router]);
```

The write goes straight to the table via `supabase.upsert` — so whether a
non-admin can edit org configuration depends entirely on `org_configurations`
RLS, which must be read and confirmed **before** the routing table is stored
there. **A routing table with a weaker guard than the roles it routes is worse
than no router**, because it looks like a control.

### Do not

- **Do not create a new table.** `org_configurations` already exists with an
  editor and a proven pattern.
- **Do not write a second chain-walk.** One resolver. Two will drift and then
  disagree about which library governs a document.
- **Do not delete the role helpers in the same change.** They become the seed. An
  org that has configured nothing must behave byte-for-byte as it does today.
- **Do not put any facility's vocabulary in code.** Not `QAQC`, not `B31.3`, not
  `NDE`. If you find yourself typing one, it belongs in seed data or the org's
  configuration.
- **Do not default an unconfigured slot to blocking.** Unconfigured means absent,
  not maximal.
- **Do not build this before `GAP-105`.** With no `library_id` on the ticket
  there is no chain to walk (`DCW-1`).

### Acceptance

1. `grep -rn 'QAQC\|B31\|NDE\|radiograph' app lib components` returns nothing
   outside seed data, test fixtures and user-visible copy.
2. An org defines a slot named anything, filled from any role or named person,
   in any mode, and the drafting flow honours it with no code change.
3. An org with no configuration behaves exactly as today — pinned by a test that
   runs the current state machine's expectations against the seeded router.
4. One person filling three slots satisfies all three in one action, and the
   record names all three.
5. A config load failure blocks and says so. A test forces the failure.
6. The resolver passes the same chain-resolution cases as
   `resolveEffectiveDocClass`.

**Related findings:** `TIER-3`, `TIER-4`, `TIER-8`, `DCW-2`, `DCW-6`.
**Supersedes the mechanism (not the reasoning) of:** `GAP-102`, `GAP-104`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P5 ROSTER): `routing_control` on libraries / collections / documents (`20261241`, pending paste; `20261012`'s lines; guarded — a document controller ONLY may change a library's, a folder's or a document's (DF-P5 fix pass: folder and document, so a document's effective owner — often its drafter — cannot swap the gate; DF-P5 fix pass 2: library too — the library owner / node-manager limb let a drafting lead who owns a library drop the engineering gate one level up), and a row INSERTED carrying a table needs a controller on every level — and audited from the database as `ROUTING_CONTROL_CHANGED`, inserts included; no new policy), one resolver on `lib/containerChain.ts` (`lib/routingControl.ts`: declared, never guessed; a transient read failure, an unusable table, a slot nobody can fill, storage that cannot be read or a file that is not in storage refuse the submission with the reason; a file too large or too slow to fingerprint is bound by identity and named on every sign-off, not refused — DF-P5 fix pass 2; a 42703 / PGRST204 is "not pasted" only when it names `routing_control`), the editor beside the review-policy editor (`components/documents/RoutingControlSection.tsx`, library and folder levels — DEC-90 ruling (3)). Acceptance 2 ✓ for `blocking` and `notify_only` (any slot name, any role / person / capability / the requester, independence per slot); a `consent_window` slot is honoured as a sign-off until `GAP-109` lands (fail-safe, DEC-38 — said in the editor), so "in any mode" holds only in that sense. Acceptance 3 ✓ (the seed is today's behaviour, pinned against the engine — `dfRoundG_P5_routing.test.ts`). Acceptance 4 ✓ (one person, three slots, one sign-off; every slot names its signer). Acceptance 5 ✓ (route test: an unreadable chain refuses, 503). Acceptance 6 ✓ (the resolver passes `resolveEffectiveDocClass`'s cases). Acceptance 1: DF-P5 adds no `QAQC` / `B31` / `NDE` / `radiograph` anywhere; the literal case-sensitive grep over `app lib components` was not empty before this package (substrings of unrelated identifiers and prose — `INDEPENDENT`, `MEANING_INDEX_…`, `VISION_RENDER_…`, a companies-page tooltip), so it is not empty after it either. Not built: the document-level editor (the setter supports it; the Inspector is not this package's file) — see the DF-P5 hand-off notes in `99-fix-sequencing.md`.*

---

<a id="gap-113"></a>
## GAP-113 · The availability record — proving it was asked

**Verdict: BUILD** · Effort: **M** · Depends on: `LEAK-1`, **`EVID-13`** · Decisions: `DEC-38`, `DEC-39`
**`GAP-109` MUST NOT SHIP WITHOUT THIS.**

> ### ⚠ `read_at` is already destroyed — `EVID-13` is a prerequisite, not a relative
>
> The three-state record below rests on `notifications.read_at` meaning "this
> person opened it". It does not mean that today.
> `app/api/tickets/workflow-action/route.ts:324-332` **mass-stamps `read_at` on
> other users' unread rows** for the ticket on every transition. So the moment
> anything else happens on the ticket, everyone reads as having seen it.
>
> Fix `EVID-13` first or the middle state — *delivered, never opened*, the most
> useful signal about whether the window length is right — is unrecoverable.

> ### ⚠ Do not add a cron entry
>
> `app/api/cron/maintenance/route.ts:286-291` records that a third scheduled
> entry **fails every deployment on this hosting plan** and once froze production
> for a day. Window expiry, warnings and escalation extend the existing
> maintenance cron. Nothing goes into `vercel.json`.

### The requirement it implements

> *"There needs to be warnings. The system has to log it was available to them
> and it didn't get taken care of."*

This is the condition that makes silence-is-consent defensible instead of
reckless. *"Nobody objected"* is only a record if *"everybody was asked"* is a
fact on disk.

### The substrate exists and is currently unsafe for this purpose

The `notifications` table already stores **one row per (recipient, event)** with
a `read_at` column (`lib/inAppNotifications.ts:79-97`, `:188`). That is precisely
the "it was available to them, and whether they looked" record.

But the writer is fire-and-forget with the error swallowed:

```ts
// lib/inAppNotifications.ts:74-97
/**
 * Insert one notification row. Fire-and-forget by design — callers
 * shouldn't block their main flow on the bell-icon write. Errors are
 * logged but never re-raised.
 */
    if (error) console.warn("[notify] insert failed", error.message);
```

For a bell icon that is the correct engineering call. For a consent window it is
disqualifying: **the insert can fail, nobody is told, and the clock runs anyway.**
The ticket then advances with an audit trail that says nobody objected, when the
truth is nobody was asked.

There is a second, independent hole feeding the same failure: `LEAK-1` — the
workflow route never calls `resolveTicketRecipients`. Confirmed by reading the
route's imports (`app/api/tickets/workflow-action/route.ts:1-13`): it imports
`WorkflowEngine` and `loadCapabilityPolicy` and not the router. So after
creation, transitions notify the requester and drafter and nobody else. **A
consent window opened by a transition would today notify the wrong people, or
none.**

### The pattern to copy is already in this codebase

The acknowledged-distribution feature is the same shape with the polarity
flipped — it *blocks* on silence where a consent window *advances* on it — and it
is already built with durable rows rather than bell entries. Its notification
vocabulary is instructive:

```
| "ack_requested"      // you must read & acknowledge an issued revision
| "ack_complete"       // (to owner) every assignee has acknowledged
| "ack_overdue"        // (to owner/Admin/DocCtrl) an assignee is long overdue
| "ack_unsatisfiable"  // (to owner/Admin/DocCtrl) an ack policy resolved to
                       //   nobody / has gaps
```

**`ack_unsatisfiable` is the one to internalise.** A consent window has the
identical failure mode: a slot that resolves to **zero people**. A window with an
empty recipient set must never advance on silence — nobody was asked, so nobody
declined to object. Whoever built acknowledgments already found this; do not
rediscover it the expensive way.

### Design

**Three guarantees, in order:**

1. **Delivery is a precondition, not a side effect.** Consent-window
   notifications take a different path from bell notifications: awaited,
   error-checked, retried. The window's start timestamp is written **in the same
   transaction as** the delivery rows. No rows, no timestamp, no clock — the
   ticket stays put and says why.
2. **The record lives on the ticket.** `consent_window_opened_at`,
   `consent_window_recipients` (uids **frozen at open time**, not recomputed at
   expiry — people move roles), `consent_window_warned_at`,
   `consent_window_expired_at`, plus an explicit ticket-history entry:
   *"Advanced without objection — asked N people on <date>, warned <date>, window
   closed <date>"*, naming them. Evidence cannot live in a feed that gets marked
   read, archived or pruned.
3. **At least one warning before expiry**, to the same recipients plus the
   assigner, itself recorded.

**What "it didn't get taken care of" means, precisely.** Three distinguishable
states, and the record must tell them apart:

| State | Evidence | Reading |
|---|---|---|
| Never delivered | no notification row | **Blocks.** Not consent. |
| Delivered, unopened | row, `read_at` null | Advances. Recorded as *not opened*. |
| Opened, no action | row, `read_at` set | Advances. Recorded as *seen, no objection*. |

Collapsing the last two into "nobody objected" throws away the most useful signal
you have about whether the window length is right.

### Do not

- **Do not reuse `notify()` unchanged and assume the record exists.** It is
  documented as fire-and-forget. That is a correct design for its purpose and the
  wrong one for this.
- **Do not start the clock at the transition.** Start it at confirmed delivery.
- **Do not recompute the recipient set at expiry.** Freeze it at open. Otherwise
  a role change mid-window silently rewrites who was asked.
- **Do not advance on an empty recipient set.** Escalate to the assigner.
- **Do not build this after `GAP-109`.** It is the safety condition on it, not a
  follow-up.
- **Do not rely on the bell alone for the record.** Notifications get pruned;
  evidence must not.

### Acceptance

1. Forcing the notification insert to fail leaves the ticket un-advanced, with a
   visible reason. A test forces it.
2. Every auto-advanced ticket answers, from its own history with no reference to
   the notifications table: who was asked, when, whether they opened it, when
   they were warned, when it expired.
3. A window resolving to zero recipients blocks and escalates.
4. A recipient who changes role mid-window is still shown as asked.
5. The warning fires at the configured fraction and is recorded.
6. `LEAK-1` is fixed first, and a test asserts the workflow route resolves
   recipients through `resolveTicketRecipients`.

**Related findings:** `LEAK-1`, `FRIC-1`, `UI-1`.

*Landed 2026-10-21 (drafting-flow Round G, DF-P7 CONSENT): `20261255` (pending paste; DEC-30 one file). Ten workflow-owned `consent_window_*` columns on `tickets` (a client neither writes nor inserts one — `trg_ticket_consent_window_guard`; `ticket_update_guard` untouched), the append-only `ticket_notice_events`, and two SECURITY DEFINER functions granted to the service role only (`open_consent_window`, `record_consent_window_warning`; search_path pinned, a session refused — DRLS-16). Guarantee 1 (DEC-38): `open_consent_window` inserts the bell rows and their `delivered` events and stamps `consent_window_opened_at` in ONE transaction, after a count check; no rows, no stamp, no clock. The route awaits it and, when it fails, the submission stands, the slot waits as a sign-off, and the answer says why; the cron retries the open with the frozen recipients. Guarantee 2: the recipients are frozen at open in `consent_window_recipients`, and the ticket's own history carries asked / reminded / closed and each person's notice state in words. Guarantee 3 (DEC-39): one reminder at the configured fraction to the people asked plus the assignment queue (`ticket.assign` holders), recorded as `warned` events and `consent_window_warned_at`; a window closes only once its reminder has been out 24 h. The three states are kept apart (`noticeStates`): never delivered HOLDS the close (not consent), delivered-unopened and opened advance, recorded as "told, not opened" and "seen, no objection" (`read_at` is the recipient's own act since `EVID-13`). Acceptance 1 ✓ for "un-advanced" (PG16: a forced notification-insert failure leaves no rows, no events and no stamp — `rls/dfP7ConsentWindow.test.ts`); the visible reason is said on the response (`consentWarning`) and recorded as a `blocked` notice event (`reason: window_not_opened`, fix pass) — it is NOT on the ticket page or in the ticket's history (DEC-29: the response and the notice record only). Acceptance 2 ✓ (`advancedHistoryDetails`; the scan test asserts the history line names who, when, opened, reminded and closed with no mention of notifications). Acceptance 3 ✓ (an empty set is BLOCKED: no window, a `blocked` event, the assignment queue told — route test; the function also refuses an empty set — PG16). Acceptance 4 ✓ (frozen at open; scan test "changed role mid-window"). Acceptance 5 ✓ (scan test and PG16: the reminder reaches everyone asked, stamped with its rows, once). Acceptance 6 ✓ before this package (`LEAK-1`: the route resolves its fan-out through `resolveTicketRecipients`, `app/api/tickets/workflow-action/route.ts:1316`, pinned by `dfRoundG_P3_routing.test.ts`); the window's own recipients are the consent slot's occupants, resolved by the routing resolver at open, less the drafter and any party the slot is independent of (fix pass), and checked against the service-written roster ledger by `open_consent_window`. The copy recall (`PHYS-18`) is not run on an issue that the consent advance completes — recorded under DEC-44 (DF-P7-consent) with an owner. Fix pass 2 (review): the open and the reminder were bell-only; each person they reach is now also emailed when their preferences allow it (an `assignment` email with an absolute link, queued once the function lands), the history line names each person's channel ("in the app only: … (why)"), and a person not emailed gets a `not_emailed` notice event (by their choice, or for want of an address, a readable preference row or a working queue) — DEC-44 (DF-P7-consent) item 15. The cron's retry asks only active members and, with nobody left, records the block once, tells the assignment queue once and stops (item 16). The reminder's "assigner" is resolved for the ticket's own request type and unit (`ticketResource`), as the route's block escalation resolves it.*

*Assigned (2026-10-21, the integrator at the DF-P7 merge, DEC-31):* acceptance 1's page half (the failed open's reason on the request page and in its history) → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS**.

*Landed 2026-10-21 (drafting-flow Round G, DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS): acceptance 1's page half — a consent window that was NOT opened is said on the request page and in its history, read from what DF-P7 already records (the `blocked` rows of `ticket_notice_events`: the route's `window_not_opened` with its error, the maintenance run's `window_never_opened` with why, and `no_longer_member`). `components/requests/ConsentBlockNotice.tsx` (mounted only when the request's roster carries a consent plan or slot — DEC-90 ruling (1) for DF-P18: no extra read and no change for any other request; nothing said before `20261255`) says each in words (`lib/requestPageReview.ts` `consentBlockReason`), and the Audit Log tab shows each as an entry labelled by its reason, merged by date with the request's own history (`consentBlockHistoryEntries` — read-only; nothing is written to the ticket). Acceptance 1 ✓ now as written for the visible reason (the response, the notice record, the page and the history). *Corrected at the DF-P18 fix pass (review major, DEC-29):* the notice used to read every `blocked` row for the ticket, oldest first. It now reads only the current roster's rows (`roster_id`), newest first before the cap (`currentConsentBlockRows`). A `window_not_opened` row no longer stands once the window opened (`consentWindowOpenedFor`: the plan is marked `opened` by the maintenance run's retry, or the roster carries its window mark), so the page never shows "could not be opened" beside a running window. The Audit Log tab keeps the row, marked "Consent window not opened (opened later)". *Corrected at the DF-P18 fix pass 2 (review major and minor, DEC-29):* that fix pass handled only the opened-later case — a block on a slot since signed, or on a roster that had closed with the request moved on, still said "it waits for a sign-off". Now no block stands once its consent slot is `satisfied` or once the review is over (the roster's `closedAt`, or the request no longer `PENDING_REVIEW` — the page passes `ticketStatus`), by one rule (`consentBlockSupersededBy`); the Audit Log tab keeps each, marked "signed later" / "review closed", and labels each entry by its reason (`consentBlockActionLabel`: a `no_longer_member` row, a window that was opened and ran to its close, is "Consent window closed — nobody left who could object", not "not opened"). So the page states no block that no longer holds — opened later, signed, or closed. Also landed (the DF-P7 editor residual): the routing editor (`components/documents/RoutingControlSection.tsx`) edits a consent slot's `window_days` (1–30) and `warn_fraction` (as a percent, 10–90; blank = the defaults), validated by `lib/routingControl.ts` as before. Tests: `lib/__tests__/dfRoundG_P18_reviewModelPage.test.ts`, `lib/__tests__/dfRoundG_P18_reviewModelPageRender.test.ts`. *Fix pass 3 (review minors):* when the roster changes, the notice clears the rows it handed the page before anything else (a new roster with no consent slot keeps none, so the Audit Log never carries an earlier roster's block judged against the new one); and each window field sets only its own setting (`windowFieldPatch`), so editing the days keeps a stored `warn_fraction` that is not a whole percent (0.333) exactly as stored.*

*Built (2026-10-22, the integrator at the DF-P18 merge):* acceptances 2–6 landed with DF-P7 (20261255, PASTE row 197) and acceptance 1's page half with DF-P18; every acceptance holds in code, live once 20261255 is pasted. The two consent mechanisms not yet built and the escalation tier stay with DF-P22 (their own findings).

---

<a id="gap-114"></a>
## GAP-114 · Projects ↔ requests, by reference

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-105`, **`PROJ-1`/`HAND-3`** · Decisions: `DEC-40`

> ### ⚠ There is nothing to link yet
>
> `project_documents.document_id` is `UUID NOT NULL REFERENCES documents(id)`.
> A ticket's `type: 'Final'` attachment is **not** a document — it is a JSONB
> entry on the ticket with an R2 key.
>
> `PROJ-1` and `HAND-3` are the same fact from two directions: **a request's
> approved deliverable never becomes a controlled document.** Until that is
> built, "push the deliverable to the project's documents" has no row to
> reference, and the only way to satisfy it would be the byte copy `DEC-40`
> forbids.
>
> So the order is: deliverable → controlled document (`DEC-22`, `GAP-6` in the
> roles area), *then* the project reference. Linking the **request** to a project
> is independent and can ship first — that is one nullable FK.

### The requirement it implements

> *"What about projects — what if a bidirectional portal for situations like a
> project manager wants to link or push the request and its files to a project's
> documents."*

### The project side is built. The ticket is the one object it cannot see.

Every other work object in the system already carries a project reference:

| Type | Field | Location |
|---|---|---|
| `CheckoutSession` | `projectId?` — *"nullable: ad-hoc checkouts have none"* | `types/schema.ts:929` |
| `Milestone` | `projectId?`, `documentId?` | `types/schema.ts:456-457` |
| `MarkupRequest` | `projectId?`, `documentId` | `types/schema.ts:1002-1004` |
| **`Ticket`** | **none** | `types/schema.ts:1113-1157` |

And the project activity feed already has a typed vocabulary with the right
events in it:

```ts
// types/schema.ts:980-983
export type ProjectActivityType =
  | "comment" | "checkout_added" | "checkout_released"
  | "member_joined" | "member_left" | "status_changed"
  | "markup_requested" | "markup_shared"
  | "doc_added" | "doc_removed" | "ownership_transferred";
```

**A ticket has no `projectId`, no `libraryId`, no `collectionId` — no container
reference of any kind** (`DCW-1`). It is the only work object a project cannot
see, and it is the one that produces drawings. That is the entire gap. The
attachment point on the project side exists and is in use.

### The trap inside the word "push"

The requirement says *"push the request and its files to a project's
documents."* The requirement is right and the word hides a document-control
violation.

Copying a controlled drawing into project storage creates an uncontrolled copy
that:

- does not supersede when the source is revised,
- does not carry a hold,
- does not appear in distribution recall,
- and does not visibly go stale.

**That is precisely the failure the entire system exists to prevent**, and it is
what the most natural implementation of "push the files" produces. `DEC-40`
settles it: **reference, never copy.**

A reference gets the right behaviour for free — it shows the current revision,
goes visibly stale when superseded, and a hold on the document is a hold
everywhere it appears.

### Scope

**In, both directions:**

- **Project → request.** From a project, raise a drafting request already bound
  to it. The existing intake form with `project_id` pre-set.
- **Request → project.** From a ticket, link it to a project the actor is a
  member of. One foreign key, one `ProjectActivity` row.
- **Deliverable → project documents.** When a linked ticket issues, the issued
  revision appears in the project's document list **as a reference**, and the
  project activity feed gets a `doc_added` event.

**Out (deliberately):**

- **Any file copy.** `DEC-40`.
- **A project-local document record.** It would duplicate a controlled one and
  the two would diverge on the first revision.
- **Cross-permission-model reach-through.** A project member who cannot read the
  library must see that a deliverable exists and be unable to open it — not have
  the reference silently vanish (which reads as "the drafting team did nothing")
  and not have it silently open (which is an egress hole). This is the same
  discover-without-read distinction as `DCW-5`, and it is the single most likely
  thing to be got wrong here.

### Do not

- **Do not copy bytes.** Ever. Not "just for the bid package" — that is the
  existing export/snapshot path, which already watermarks, and is a different,
  already-solved problem.
- **Do not show a revision without showing whether it is current.** A project
  view of a superseded drawing that does not say so is worse than no project
  view, because it is trusted.
- **Do not grant read through the project link.** Project membership is not
  library access. Show existence; gate content on the library ACL.
- **Do not add the reverse link as a second source of truth.** One foreign key on
  the ticket. The project's list is a query, not a stored set.
- **Do not build before `GAP-105`.** `library_id` and `project_id` are the same
  shape of problem and the same migration; doing them together avoids two
  backfills over the same table.

### Acceptance

1. Linking writes exactly one foreign key and one activity row. No bytes move.
2. A project's document list shows the live current revision of every referenced
   deliverable and marks superseded ones as superseded.
3. A hold on a referenced document is visible from the project.
4. A project member without library read sees that a deliverable exists, sees its
   status, and cannot open it — verified in a test, both directions.
5. A request raised from a project arrives with `project_id` set and appears in
   the project's activity feed.
6. Unlinking removes the reference and leaves the ticket and the document
   untouched.

**Related findings:** `DCW-1`, `DCW-5`, `LEAK-9`.
**Related gaps:** `GAP-105` (ticket → library binding — same migration).

**Built (2026-10-21, drafting-flow DF-P8 PROJECTS).** The request ↔ project link by reference (DEC-40): `tickets.project_id` with an org-equality rail (20261256, PASTE row 200), settable only through `/api/tickets/project-link` and the create route; the check-in and collision paths carry it; the project page lists its requests and warns at closeout about open ones; the published deliverable is referenced on the project register by the hand-back and the link route. *Remaining:* the reference when a deliverable's document review completes (`PROJ-1`) → projects-joint **J21** (the integrator at the DF-P8 merge, DEC-31); this gap closes with it.

---

## Already built — do not build these twice

| Looks missing | Actually |
|---|---|
| **A parallel review roster with signatures, alternates and auto-finalize** | **Built** — `lib/reviewControl.ts`, on the document side. `GAP-103` is about reaching it from the ticket, not writing it. |
| **Plain-English status explanations** | **Built twice** — `attentionLabel` and `WorkflowDiagramModal`. `GAP-108` routes them to the right surfaces. |
| **Per-request-type SLA defaults** | **Built** — `lib/notifications.ts:237-243`. `GAP-106` is about nothing reading them. |
| **Queue routing by role pool with fallback** | **Built** — `lib/ticketRouting.ts`. `LEAK-1` is about the workflow route never calling it. |
| **A per-person delegation with expiry** | **Built** — `capabilityPolicy.UserGrant`. `GAP-102` uses it rather than adding a role. |
| **Container-chain rule inheritance** | **Built** — `docClass` and `review_control` both resolve document → folder → library. `GAP-101` and `GAP-104` reuse the pattern. |
| **Triage-first routing to the drafting supervisor** | **Built and working.** `GAP-101` adds one field to a step that already exists. |

> Line citations into `lib/notifications.ts` re-pointed 2026-09-02 after the roles-and-permissions sweep removed the browser external-mail path (`SURF-17`); the cited symbols are unchanged.
