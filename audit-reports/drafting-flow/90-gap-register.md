# 90 · Gap register — build specs

**9 capabilities the drafting flow needs and does not have.**

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
| [GAP-109](#gap-109) | Engineering review without a stop | **BUILD** | M | `GAP-101` |

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
## GAP-102 · QA/QC assurance with **zero added stops**

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

<a id="gap-109"></a>
## GAP-109 · Engineering review without a stop

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-101`

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
