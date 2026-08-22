# 90 · Gap register — build specs

**8 capabilities the drafting flow needs and does not have.**

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
| [GAP-102](#gap-102) | QA/QC as a reviewer slot, not a role | **BUILD_NARROW** | M | `GAP-103` |
| [GAP-103](#gap-103) | Parallel reviewer roster on the ticket | **BUILD** | L | `GAP-105` |
| [GAP-104](#gap-104) | Doc-control release routing per library | **BUILD** | M | `GAP-105`, `GAP-103` |
| [GAP-105](#gap-105) | Ticket → library binding | **BUILD** | S | — |
| [GAP-106](#gap-106) | SLA escalation that actually fires | **BUILD** | M | `LEAK-1` |
| [GAP-107](#gap-107) | Leak accounting — non-standard outcomes | **BUILD_NARROW** | S | `DEC-14` |
| [GAP-108](#gap-108) | "Where is my request" | **BUILD_NARROW** | S | — |

---

<a id="gap-101"></a>
## GAP-101 · Work class on the ticket

**Verdict: BUILD** · Effort: **M** · Depends on: `WF-15`

### Scope

**In:** a declared work class on the ticket — at minimum
`minor_correction` / `like_in_kind` / `new_design` — that review requirements key
off.

**Out (deliberately):** a drawing-type taxonomy (P&ID vs isometric vs loop
sheet). `DCW-3` establishes that the **library** is the better routing proxy and
already has an inheritance mechanism. A second taxonomy would have to be kept in
sync with the first.

**Out:** requiring the requester to classify. See the design note — this is the
whole point.

### Design

The class is set **at triage**, not at intake. `PENDING_ASSIGNMENT` already
exists, already has the right person in it (the drafting supervisor), and already
requires them to open the ticket and act. Adding a class selector to the
assignment step costs **zero additional hops** (`FRIC-3` explains why asking the
requester costs several).

Prefill it where evidence exists: a request carrying
`metadata.source_document` whose `docClass` is `drawing`, with a `request_type`
the org has marked as like-in-kind, defaults accordingly. A **suggestion is never
enforcement** — `lib/docClass.ts` already establishes that principle for document
class and it applies identically here.

Make the class org-extensible rather than a closed union. Different orgs will
need different tiers, and `DCW-3`'s lesson is that hardcoding a taxonomy creates
a maintenance burden — but validate against the org's configured list
server-side, which is exactly what `WF-15` builds for `request_type`.

### Do not

- **Do not put the class on the intake form as a required field.** The requester
  frequently cannot answer it, and a required field they cannot answer is `UI-5`
  all over again. Optional-with-prefill at intake, confirmed at triage.
- **Do not derive it from `changeType`.** That lives on `DocumentVersion` and is
  chosen at publish — weeks after the review decision needs to be made.
- **Do not build it before `WF-15`.** An authority-bearing classification keyed
  to unvalidated free text is a hole (`LEAK-3` shows what that already costs).
- **Do not reuse `request_type` for this.** They are different questions: *what
  kind of ask* versus *how much change*. Collapsing them is why `request_type`
  is currently overloaded and unvalidated.

### Acceptance

1. Every ticket has a work class by the time it leaves `PENDING_ASSIGNMENT`.
2. The class is prefilled from the source document where one exists, and the
   prefill is visibly a suggestion.
3. It is validated server-side against the org's configured list.
4. A report can count tickets by class.

**Related findings:** `TIER-1`, `TIER-2`, `TIER-7`, `LEAK-3`.

---

<a id="gap-102"></a>
## GAP-102 · QA/QC as a reviewer slot, not a role

**Verdict: BUILD_NARROW** · Effort: **M** · Depends on: `GAP-103`

### Scope

**In:** a QA/QC review requirement, expressible per library and per work class,
satisfied by a person holding a QA/QC capability.

**Out (deliberately):** a `QAQC` role, and a `PENDING_QAQC` status. Both were
considered and both are rejected — see `Do not`.

**Out:** an NDE scope calculator, a radiography-extent engine, or code
compliance checking. Those are engineering tools, not workflow. What is in scope
is that the **right person is required to look**, and that the requirement is
recorded.

### Design

QA/QC becomes a **capability** (`review.qaqc`) in the existing
`CAPABILITY_DEFS` list, plus a **reviewer slot** on the roster from `GAP-103`.

That combination satisfies the stated constraint — *"I'm not boxing myself into a
new role or extra friction"* — on both counts:

- **No new role.** The capability layer already supports per-person grants with
  an expiry (`lib/capabilityPolicy.ts:98-110`). The person who does QA/QC is
  usually an engineer or an inspector who already exists; they get the
  capability, not a new identity.
- **No new friction.** Because the roster is parallel (`GAP-103`), adding QA/QC
  to a like-in-kind review adds **zero wait states**. The QA/QC reviewer signs
  concurrently with the design reviewer.

That is what makes "QA/QC reviews everything, even like-in-kind" affordable. On
the current serial machine the same rule would add a hop to every ticket in the
plant.

### Do not

- **Do not add a `PENDING_QAQC` status.** It is a serial hop on every ticket —
  precisely the friction the requirement says to avoid, and `TIER-5` explains why
  the serial machine makes every requirement expensive.
- **Do not create a QAQC role.** Nineteen roles already exist, six of them
  gate nothing (`ROLE-1`), and role identity is unversioned customer JSON
  (`CHAIN-5`, `DEC-5`). Capabilities are the mechanism that exists for exactly
  this.
- **Do not gate QA/QC on work class.** The requirement is explicitly *all work,
  including like-in-kind*. Class scopes the **engineering** review, not this one.
- **Do not conflate it with the document-side review roster's existing
  reviewers.** A QA/QC signature answers a different question than a design
  signature, and the roster must record which was which.

### Acceptance

1. A library can require QA/QC review, and it applies to every work class
   including like-in-kind.
2. The requirement is satisfied by a person holding `review.qaqc`, granted
   through the existing per-person mechanism — no new role exists.
3. Adding it to a ticket that already requires a design review adds no status and
   no additional wait.
4. The resulting record distinguishes a QA/QC sign-off from a design sign-off.

**Related findings:** `TIER-3`, `TIER-4`, `TIER-5`.

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

---

<a id="gap-104"></a>
## GAP-104 · Document-control release routing, per library

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
3. Library-scoped rules can be evaluated against any ticket past triage.

**Related findings:** `DCW-1`, `DCW-5`, `DCW-6`.

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
per-request-type defaults (`lib/notifications.ts:283-287`), and `isPastDue` /
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

---

<a id="gap-108"></a>
## GAP-108 · "Where is my request"

**Verdict: BUILD_NARROW** · Effort: **S**

### Scope

**In:** the ticket states, in plain language, what stage it is at, who it is
waiting on, and how long it has been there.

**Out:** a redesign of the ticket page. This is a band, above the fold, in the
pattern the page already uses twice.

### Design

**Almost all of the content already exists.** `attentionLabel`
(`lib/ticketAttention.ts:115-128`) has the plain-English phrase for every status
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

---

## Already built — do not build these twice

| Looks missing | Actually |
|---|---|
| **A parallel review roster with signatures, alternates and auto-finalize** | **Built** — `lib/reviewControl.ts`, on the document side. `GAP-103` is about reaching it from the ticket, not writing it. |
| **Plain-English status explanations** | **Built twice** — `attentionLabel` and `WorkflowDiagramModal`. `GAP-108` routes them to the right surfaces. |
| **Per-request-type SLA defaults** | **Built** — `lib/notifications.ts:283-287`. `GAP-106` is about nothing reading them. |
| **Queue routing by role pool with fallback** | **Built** — `lib/ticketRouting.ts`. `LEAK-1` is about the workflow route never calling it. |
| **A per-person delegation with expiry** | **Built** — `capabilityPolicy.UserGrant`. `GAP-102` uses it rather than adding a role. |
| **Container-chain rule inheritance** | **Built** — `docClass` and `review_control` both resolve document → folder → library. `GAP-101` and `GAP-104` reuse the pattern. |
| **Triage-first routing to the drafting supervisor** | **Built and working.** `GAP-101` adds one field to a step that already exists. |
