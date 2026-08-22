# 99 · Execution order

**Binding, not advisory.** This area has one ordering constraint that outweighs
everything else, and getting it wrong produces a workflow people abandon.

No findings of their own — this is the plan the 139 findings and 14 gap specs are
worked against. Judgment calls shared with the roles model are settled in
[`../DECISIONS.md`](../DECISIONS.md).

---

## Phase −1 — Before any of this means anything

> **Every gate described in this area is currently advisory.**

`supabase/schema.sql:1079-1080` is the only policy on the `tickets` table:

```sql
CREATE POLICY "tickets_org_access" ON tickets FOR ALL
  USING (org_id IN (SELECT my_org_ids()));
```

`FOR ALL` with **only** a `USING` clause and no `WITH CHECK`: Postgres reuses
`USING` as the check for `INSERT` and `UPDATE`. There is no `RESTRICTIVE` policy
and no later migration tightening it — one policy, confirmed by searching every
`.sql` file in `supabase/`.

So any authenticated member of the org can `UPDATE` any ticket row directly:
`status`, `assigned_engineer_id`, `engineer_approved_at`, and every column
`GAP-110` and `GAP-111` are about to add. **The state machine, the capability
policy, the compare-and-set and the audit log are all client-side conventions
against a row anyone can write.**

Four separate lenses found this independently — `SM-2`, `PERS-1`, `AUTHZ-2`,
`EVID-1`. One migration closes all four.

This does not make the rest of the area pointless — most people use the UI, and
the UI is where friction and mistakes live. But it does fix the order:

1. **`PERS-1` / `SM-2` / `AUTHZ-2` / `EVID-1`** — constrain `tickets` writes at
   the database. Permissive `SELECT` stays; `UPDATE` is restricted to the service
   role (the workflow route already uses `supabaseAdmin`) or column-guarded by a
   trigger. **Ship this before `GAP-110`/`GAP-111`**, or the like-in-kind
   declaration and the engineering flag are advisory too — anyone in the org
   could clear either from a browser console.
2. **`SM-1` / `AUTHZ-1` / `TIER-7`** — "Approve with Minor Correction" goes
   straight to `PENDING_IFC` (`lib/ticketTransitions.ts:230-235`) and is offered
   to **every** requester at `PENDING_REVIEW`, including the exact branch where
   the code has just decided they are not qualified to approve
   (`lib/workflow.ts:222-228`). A one-click bypass of engineering sign-off, in
   the UI, today. **This is the single finding most directly opposed to the
   stated policy that unapproved packages must not reach the field.**
3. **`PERS-8`** — `my_org_ids()` is `SECURITY DEFINER` with no `SET search_path`,
   and it is the sole gate on every ticket RLS decision. One line.
4. **`PERS-7` / `EVID-6`** — `logAuditAction` cannot detect a failed audit write:
   `supabase-js` resolves with `{error}` rather than throwing. Every audit row in
   the system is silently best-effort. Fix before relying on the audit log to
   prove anything, which `GAP-113` does.
5. **`EVID-13`** — workflow transitions mass-stamp `read_at` on **other users'**
   unread notifications (`app/api/tickets/workflow-action/route.ts:324-332`).
   This destroys the only "did they see it" signal in the system.
   **Hard prerequisite of `GAP-113`**, which is itself a hard prerequisite of
   `GAP-109`.

⚠ **Do not read this as "fix the database and the rest can wait."** The
friction work in Phase 0 is what stops people leaving the app, and someone who
has left the app is not constrained by RLS either.

⚠ **No new cron entry, ever.** `app/api/cron/maintenance/route.ts:286-291`
records that a third scheduled entry fails every deployment on this hosting plan
and once froze production for a day. Every clock this area needs — consent
windows, SLA escalation, warnings — extends the existing maintenance cron.

---

## Where the deep-read findings go

`06`–`13` were produced after the sequencing below was written. They do not
reorder it; they populate it.

| Phase | Add |
|---|---|
| **−1** | the five items above |
| **1 — stop the leaks** | `SM-13` (`requiresFile` unenforced server-side), `SM-9` (four writers bypass the CAS), `SM-4` (archive commit destroys a live reopened ticket), `SM-5` (reopen re-issues the same rev, so two documents verify as current), `AUTHZ-4`, `AUTHZ-5`, `AUTHZ-12` |
| **2 — wiring** | `PERS-5`/`SM-11` (map `metadata`) **before** anything reads a declaration; `PERS-6` (`unit` unset on two of three creation paths) |
| **3 — the keystone** | unchanged: `GAP-103`, and `HAND-1`/`HAND-4`/`HAND-6` are the review-gate defects it will inherit |
| **4 — the review model** | `GAP-110` → `GAP-111` → `GAP-109` (after `GAP-113`, after `EVID-13`) |
| **5 — the rest** | `ROUTE-*`, `PROJ-*`, remaining `EVID-*` in severity order |

`11-document-handoff.md` has no phase of its own because it is not this area's
to own: `DEC-22` and `GAP-6` in `roles-and-permissions` already commit to the
hand-back design. Read `HAND-3` before starting that work — it is the clearest
statement of why the two systems share no write path today.

---

## The governing principle

> **A wait on a specific person is where backlog comes from. Treat every one as a
> defect until its consequence justifies it.**

This is not a preference about polish. It is queue mechanics: a stage that
requires a *named human* forms a backlog the moment that person's availability
drops below the arrival rate — and their availability is not something the system
controls. A stage that advances on a **clock** cannot form a backlog. It can only
produce objections, which are rare, self-limiting, and carry information.

So the design default inverts. The question is not *"who should approve this?"*
It is **"what happens if nobody does anything?"** — and for most work the right
answer is *it advances, and the record says nobody objected.*

Blocking signatures still exist. They should be **countable**: an org should be
able to say "we have N blocking approvals a month and they are all new design in
code-governed service." If that number is not small and not explainable, the flow
has a defect, not a policy.

**Corollary for anyone working this area:** if a fix adds a stage where the ticket
waits on a person, it is the wrong fix. Check the friction ladder in the gap
register first.

---

## The keystone rule

> **Do not implement the review model before the review mechanism.**

`TIER-1` through `TIER-4` describe the review tiering that should exist:
like-in-kind gets a design review, new design adds engineering, QA/QC reviews
everything, code-governed work adds a code reviewer.

On the **current serial state machine**, that model produces:

```
triage → drafter → requester review → engineering review → QA/QC review
       → code review → IFC → acknowledge
```

**Eight hops. Six people. Seven waits.** For a package that today takes five.

People will route around it, and the shoulder-tapping this audit exists to
prevent gets *worse*, not better — while the audit's own report says the review
model was implemented correctly.

**`GAP-103` (the parallel roster) comes first.** With it, the same model costs
**one** wait state regardless of reviewer count.

There is a second-order version of the same trap: **`GAP-102` (QA/QC) is the most
tempting thing in this audit to build early**, because the requirement is
concrete and the stated need is urgent. Built as a status it adds a hop to every
ticket in the plant — including the like-in-kind work it is meant to cover
cheaply. Built as a *roster slot* it is better but still a touch.

**Read the friction ladder in the gap register before building any assurance
mechanism.** Waits and touches are different currencies. A parallel roster fixes
waits and not touches, and most requirements that present as reviews turn out to
be data completeness or visibility — both of which cost nothing. `GAP-102` and
`GAP-109` are the worked examples.

---

## Phase 0 — Free, independent, immediately felt

No dependencies. Every one is small, and users notice all of them.

| Item | Why it is free |
|---|---|
| **`UI-5`** | A blocked submit currently does *nothing*. Name the missing field, move focus. First contact, least experienced user, no recovery path today. |
| **`UI-2`** | Give the workflow map a visible affordance and put it on the request form. The content already exists and is good. |
| **`UI-1`** / `GAP-108` | Render `attentionLabel` plus the current holder on the ticket. The function exists and is tested; it renders only in the bell today. |
| **`UI-7`** | Stop showing raw status enums as the primary label. **Do not rename the enum values** — display layer only. |
| **`FRIC-9`** | Default the queue list to the action-required set. `myActionItems` is already computed and already on screen. |
| **`FRIC-7`** / `UI-3` | Derive attention from `getActions` so Doc Control stops being sent to tickets that offer them nothing. |
| **`LIFE-5` (partial)** | Relabel the RevUpModal MOC input, which calls a mandatory field "optional". |

Landing Phase 0 alone measurably reduces the reasons someone picks up the phone,
and none of it constrains any later decision.

---

## Phase 1 — Stop the leaks

Independent of the review model. Two are safety-relevant.

1. **`LEAK-3`** — any drafter can close an RFI-typed ticket from `DRAFTING`,
   skipping every approval. **Requires `WF-15`** (validate `request_type`
   server-side) — which is also a prerequisite for `GAP-101`, so it pays twice.
2. **`LEAK-1`** — wire `resolveTicketRecipients` into the workflow route. It is
   currently called by the three creation paths only, so after birth nobody is
   ever told a ticket entered their queue.
3. **`LEAK-2`** — routing matches the headline role, so a
   `['Manager','DraftingSupervisor']` supervisor is silently never notified.
   Benefits from `DEC-1`/`DEC-2` but does not have to wait for them.
4. **`LEAK-4`** — attachment and history writes bypass the workflow route's
   compare-and-set, silently overwriting audit entries (`WF-9`).
5. **`LEAK-8`** — `submit_final` is not required server-side to carry a
   deliverable (`WF-6`).
6. **`GAP-107`** — leak accounting. **Do this early despite being small**: it is
   the only instrument that can tell you whether any of the rest worked.

---

## Phase 2 — The wiring prerequisites

Small, and they unblock everything in Phase 3.

1. **`GAP-105`** — put a `library_id` on the ticket. Effort `S`, and it is the
   prerequisite for both `GAP-103` and `GAP-104`. Derive from the source document
   where one exists; defer to triage otherwise. **Do not make it required at
   intake** (`UI-5`, `FRIC-3`).
2. **`WF-15`** — validate `request_type` server-side, if not already done in
   Phase 1.
3. **`DCW-5`** — a requester who cannot read a library may still need to request
   work in it. The ACL's `discover`-without-read already supports this.
   ⚠ Marked `SUSPECTED` — **reproduce before fixing.**
4. **`GAP-106`** — SLA escalation. Depends on `LEAK-1` landing so escalations
   reach the queue owner rather than the people who already know.

---

## Phase 3 — The keystone

**`GAP-103` — the parallel reviewer roster.** Effort `L`. Nothing in Phase 4
ships before this.

Do not design it: `lib/reviewControl.ts` already has required primaries and
alternates, signatures bound to `content_hash`, invalidation on draft change,
timeout-driven alternate activation, and auto-finalize on the last signature. The
work is making it reachable from the ticket — `getActions` currently receives no
library and no review control, which is `DCW-6`.

⚠ **`DEC-23` must have landed** (delete the `related_ticket_id` review waiver)
before anything connects ticket approval to document review. It silently waives
the document review gate and no code path writes it — an agent wiring this will
naturally set it for provenance.

This also collapses `TIER-8` (two review systems, no shared vocabulary) and
`DCW-6` (the library's review policy invisible to the flow).

---

## Phase 4 — The review model

Only after Phase 3. In this order.

1. **`GAP-101`** — work class on the ticket, set at triage. Everything else keys
   off it.
2. **`TIER-1`** — repoint the engineering gate at the work class instead of
   `requiresEngineerApproval(requesterRole)`. **This is the inversion fix** and
   the single highest-value change in the area: it improves safety and reduces
   friction simultaneously.
3. **`GAP-109`** — consent windows and standing pre-authorization, per class.
   **This is where the backlog actually goes away**: it converts "wait for an
   engineer to say yes" into "an engineer may object", which is a clock rather
   than a person. Do it immediately after `TIER-1`, before anything else keys off
   the class.
4. **`GAP-102`** — QA/QC visibility plus stop-work authority. No signature, no
   slot, no status. Both mechanisms already exist.
5. **`TIER-4`** / `DEC-13` — the code-governed dimension, as part of the
   resource-dimension work already committed in the roles area.
6. **`GAP-104`** — document-control release routing, per library, on the roster.
7. **`TIER-7`** — convert "Approve with Minor Correction" from an unconditional
   bypass into a declared minor-correction class. Ships with `WF-3` + `WF-14`
   from the roles area, which must go together.

---

## Phase 5 — The remaining friction

`FRIC-2` (split "is this what you asked for?" from "is this correct?"),
`FRIC-4` (stop making requesters pick engineers — the roster derives them),
`FRIC-5` (the second drafter interrupt), `FRIC-6` (closure with no fallback),
`FRIC-3` / `FRIC-8` / `DCW-7` (the field contract and `unit`), `UI-4`, and the
remaining `LEAK-*` and `DCW-*` in severity order.

Several of these dissolve on their own once Phase 4 lands — `FRIC-4` in
particular, because a derived roster means nobody is choosing a reviewer by hand.
**Re-check each against the code before working it; a finding that no longer
reproduces is `INVALID`, and that is a real outcome** (`DEC-28`).

---

## Pairs that must ship together

| These two | Because |
|---|---|
| `GAP-103` → `GAP-101`, `GAP-102`, `GAP-104` | The model on a serial machine is a workflow people abandon |
| `WF-15` → `LEAK-3` **and** `GAP-101` | Authority keyed to unvalidated free text is a hole, not a feature |
| `GAP-105` → `GAP-103`, `GAP-104` | No library on the ticket means no library-scoped rule can be evaluated |
| `LEAK-1` → `GAP-106` | Escalating to the requester and drafter tells the people who already know |
| `DEC-23` → any ticket↔document review link | The waiver silently disables document review |
| `WF-3` + `WF-14` | `WF-14` is the hole `WF-3` opens; either alone is a no-op |

## Do not do these

| Tempting | Why not |
|---|---|
| Add a `PENDING_QAQC` status | A serial hop on every ticket, including the like-in-kind work it is meant to cover cheaply. `GAP-102`. |
| Add a QA/QC **roster slot** | Better than a status — fixes the wait, not the touch. QA/QC's real needs are data completeness and a veto, and both are free. `GAP-102`. |
| Let QA/QC gate on design method | If an engineer specified it, that is settled. QA/QC's recourse is the hold — deliberate, visible, audited. `GAP-102`. |
| Apply silence-is-consent to the highest work class | A new tie-in auto-advancing because an engineer was on leave is the PSM failure the system exists to prevent. `GAP-109`. |
| Add a `QAQC` role | Nineteen roles exist, six gate nothing, and role identity is unversioned customer JSON. Use a capability. `DEC-3`, `DEC-5`. |
| Add a `PENDING_DOC_CTRL` status | Same serial cost. `GAP-104` puts release review on the roster. |
| Put work class on the intake form as required | The requester often cannot answer it, and a required field they cannot answer is `UI-5` again. Triage sets it. |
| Rename the `TicketStatus` enum values | They ripple into the state machine, the archive and the shed. Fix the display layer. `UI-7`. |
| Auto-close a stalled ticket | A stalled review is information, not a decision. `GAP-106`. |
| Build a drawing-type taxonomy | The library is the better routing proxy and already inherits. `DCW-3`. |
| Delete the "Approve with Minor Correction" fast path | The instinct behind it is right. Convert it to a declared class. `TIER-7`. |

---

## Verification you cannot skip

**No live database and no browser.** The state machine, capability defaults and
hop counts are read from code and are unambiguous. The UI findings are read from
render conditions and copy — **not observed running.**

Per `DEC-29`, reproduce before fixing. Two specifically:

- **`DCW-5`** is marked `SUSPECTED` — how often a requester needs to reference a
  document they cannot open depends on how restrictively libraries are configured
  in practice, which the repository cannot show.
- **The hop counts in `02`** assume the shipped capability defaults. An org that
  has edited its capability policy will have different counts — though per `DB-1`
  no org's edits have ever persisted, which is itself worth confirming before
  relying on either reading.
