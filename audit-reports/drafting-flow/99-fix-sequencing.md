# 99 · Execution order

**Binding, not advisory.** This area has one ordering constraint that outweighs
everything else, and getting it wrong produces a workflow people abandon.

No findings of their own — this is the plan the 140 findings and 14 gap specs are
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
| ~~**`UI-5`**~~ | **REFUTED — skip.** Browser constraint validation already fires before `onSubmit`, so a blank required field gets a native bubble *and* focus, which was this item's whole acceptance criterion. Required fields already carry red asterisks. The only residue worth doing: the submit button is disabled on `isSubmitting` alone. |
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
   intake** (`FRIC-3`; `UI-5` used to be cited here too, but it is refuted).
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
`FRIC-5` (the second drafter interrupt),
~~`FRIC-6` (closure with no fallback)~~ — **refuted; a fallback exists, and the
missing piece is the same clock `FRIC-1` already claims, so do it there** —
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
| Put work class on the intake form as required | The requester often cannot answer it, and a required field they cannot answer just moves the dead end upstream. Triage sets it. |
| Rename the `TicketStatus` enum values | They ripple into the state machine, the archive and the shed. Fix the display layer. `UI-7`. |
| Auto-close a stalled ticket | A stalled review is information, not a decision. `GAP-106`. |
| Build a drawing-type taxonomy | The library is the better routing proxy and already inherits. `DCW-3`. |
| Delete the "Approve with Minor Correction" fast path | The instinct behind it is right. Convert it to a declared class. `TIER-7`. |

---

## Verified sound — the EDGE-11 diff-check (every package)

`EDGE-11` (`13-edges-and-invariants.md`) is this area's do-not-break list, and it
is the `DEC-29` item-5 diff-check **every** drafting-flow package cites by name.
Re-verified on `f1ac550` (drafting-flow Round G, DF-P0), each with a behavioural test or a source pin on code (never on a comment):

| Invariant | Where it lives | Pinned by |
|---|---|---|
| Server-side action validation against `WorkflowEngine.getActions` under the org's own policy; archived stubs refused; referenced members active and qualified | `app/api/tickets/workflow-action/route.ts` | `lib/__tests__/sweepRoundE_A.test.ts`, `lib/__tests__/dfRoundG_P0.test.ts` |
| `(status, last_modified)` compare-and-set; `computeTransition` always stamps `last_modified`. **Caveat:** the `last_modified` leg is applied only when the row carries a token (`ticket.lastModified ? … .eq("last_modified", …) : baseQuery`), and the column is nullable and not guarded — a member can null it and reduce the CAS to status-only. So the invariant holds only for rows that carry a token; the null leg is a defect of its own (proposed `EDGE-15`, below; DF-P1) — close it, never widen it | the same route; `lib/ticketTransitions.ts` | `lib/__tests__/dfRoundG_P0.test.ts` (two concurrent `save_progress` → one 409, on a row whose token is set) |
| `post_ticket_comment` falls back only on PGRST202 / "could not find the function" | `app/api/tickets/comment/route.ts` | `lib/__tests__/dfRoundG_P0.test.ts` (an in-function error is a 500, nothing written) |
| Recipient preferences read under the service role in both ticket routes | both routes' fan-out | `lib/__tests__/dfRoundG_P0.test.ts` (source pin on code: `supabaseAdmin.from("notification_preferences")…` in both routes) |
| One attention rule — `isActionRequired`, derived from the engine | `lib/ticketAttention.ts` | `lib/__tests__/ticketAttention.test.ts`, `lib/__tests__/dfRoundG_P0.test.ts` |
| Ticket numbers from `next_ticket_number` (definer, pinned, row lock) | `supabase/migrations/20260724_ticket_numbering.sql` | `lib/__tests__/dfRoundG_P0.test.ts` (source pin) |
| All-or-nothing ticket-shed capture; commit re-verifies before deleting | `app/api/admin/ticket-shed/route.ts`, `commit/route.ts` | `lib/__tests__/dfRoundG_P0_shed.test.ts` (route harness: one unreadable binary skips the whole ticket, un-claimed and counted; nothing readable → 502, catalog row removed) and `lib/__tests__/dfRoundG_P0.test.ts` (source pin on the skip, ordered before the zip write) |

A fix that needs one of these changed is a design error in the fix (`DEC-27`
halt condition 2). Extend them — the server create route (DF-P2) reuses the
numbering RPC and the service-role preference read; it does not replace them.

## Hand-offs from DF-P0 (Round G) that no package brief carries yet

DF-P0 re-verified 38 ids against `f1ac550`. The residuals the fleet plan already
handed on (`SM-2` / `PERS-1` / `AUTHZ-2` / `EVID-1` history + arrays → DF-P1,
`LEAK-4` priority / `unread_by` writes → DF-P9, `DCW-4` → DF-P4, `ROUTE-5`
re-entry routing → DF-P3, `TIER-7` → DF-P6) are in the plan. The rows below were
found on re-verification or in DF-P0's review, are recorded OPEN (or `BLOCKED`)
on the named finding with that owner — or, for three new defects, as proposed new
ids (next section); a fourth, `LEAK-10`, is opened in `04-flow-leaks.md` by the
DF-P0 records fix — and are **not** in the owner's brief in
`audit-reports/fleet-plans/drafting-flow.json`. The integrator appends each (id
plus the line below) to the owner's findings / files before that package starts,
or re-owns it in the plan's "remainder re-owned by the integrator" form.

| Finding | Owner | What the owner must add |
|---|---|---|
| `LEAK-10` (opened at the DF-P0 merge, HIGH — CRITICAL if its inventory query returns > 0) + `LEAK-3` (+ `AUTHZ-6` done-when 1, `SM-2`) | DF-P1 | Make **`request_type` and `unit`** workflow-owned in the re-created `ticket_update_guard` (brief item (a) names history and the arrays only), and add `LEAK-10` to DF-P1's findings. They are the whole `DEC-13` resource: `ticket.engineer_gate_exempt`, `ticket.direct_approve` scoping, the reviewer / drafter pick scoping, `engineeringFirst` and close-without-review all read them. Wherever an org has a type- or unit-scoped engineer-gate or direct-approve rule, rewriting either column issues for construction with no engineer — run `LEAK-10`'s read-only inventory query **before DF-P1 starts**: `n > 0` raises `LEAK-10` to CRITICAL (with the area README count). |
| `SM-2` (column census) | DF-P1 | Decide **every** column the re-created guard leaves client-writable, not only history and the arrays. On HEAD a member can UPDATE every `tickets` column outside the guard's 22 — 19 of the table's 41: `id` (the primary key, refused only while a foreign key references the row), `title`, `description`, `unit`, `request_type`, `priority`, `attachments`, `comments`, `history` (in place, at equal or greater length), `metadata`, `unread_by`, `watchers`, `search_keywords`, `search_tsv`, `target_completion_at`, `sla_breach_warned_at`, `sla_breached_at`, `last_modified`, `updated_at`. At minimum: `title` / `description` once approved (the scope an engineer signed off, rewritable after IFC with no history line — `EVID-1`), the SLA clocks, and `last_modified` (proposed `EDGE-15`). |
| `EDGE-11` invariant 2 (→ proposed `EDGE-15` below) | DF-P1 | A row whose `last_modified` is `NULL` gets a status-only CAS (the leg is conditional; the column is nullable and unguarded): treat a null token as its own leg (`.is("last_modified", null)`) or as a conflict, and/or refuse a client write that nulls it. |
| `SM-11` (→ proposed `SM-14` below) | DF-P1 | The intent bridge's document read (`app/api/tickets/workflow-action/route.ts:549-553`) is scoped `.eq("org_id", ticket.orgId)`, as the `CLOSED` path's is (`:401-402`), and the `document_intents` upsert (`:554-569`) is skipped when the document is not in the ticket's org. |
| `AUTHZ-1` / `SM-1` (→ proposed `AUTHZ-14` below) | DF-P1 | `request_final_engineer_approval` requires its note server-side — `requiresComment: true` on the engine action (`lib/workflow.ts:382-388`) so the route's comment gate (`app/api/tickets/workflow-action/route.ts:194`) fires; today only `EngineerPickerModal`'s `requireComment` default does (`components/requests/EngineerPickerModal.tsx:64`, `:155`). |
| `PERS-1` done-when 3 | DF-P1 | Split `tickets_org_access` (`FOR ALL`, `supabase/schema.sql:1118-1119`) into per-verb policies with written `WITH CHECK`s. |
| `DCW-4` / `HAND-3` done-when 1 (records fix) | DF-P1 | The close-time "not in the register" state and the recorded version live in client-writable `tickets.metadata`, and the close skips the note when `metadata.deliverable.state` already reads `published` (`app/api/tickets/workflow-action/route.ts:400`; `lib/ticketHandback.ts:101-102`). `metadata` service-only in the guard re-creation (brief item (a) — no browser path writes `metadata`), and the close-time check reads a `published` deliverable against the register (`document_versions.related_ticket_id`, or the recorded `version_id` in the ticket's org). Add `DCW-4` and `HAND-3` to DF-P1's findings so its close re-checks their done-when 1. |
| `SM-12` | DF-P1 | Stamp `assigned_drafter_name` (`assign`, `reassign_drafter`, `self_assign`) from `org_members.display_name` server-side. |
| `SM-13` (server half) | DF-P1 | Refuse a `finalAttachment` not typed `Final` (the same hunk as `AUTHZ-11`, which the brief does carry). |
| `AUTHZ-3` | DF-P2 | The create route stamps `requester_name` from `org_members.display_name` (the brief replicates requester id / role / status / type only). |
| `HAND-3` (base version) | DF-P2 | The canonical `metadata.source_document` shape captures the source's `current_version_id` at creation (it carries rev text only), so drift is flagged by version id, not by comparing rev labels (`revDrift`, `app/(protected)/requests/[id]/page.tsx:2134-2140`) — the same work as `HAND-7`. |
| `LEAK-6` (reopened by the DF-P0 records fix) | DF-P2 | Done-when (1) fails on HEAD: `CheckInPanel`'s resume lookup ignores its `{error}` and runs un-awaited (`components/documents/CheckInPanel.tsx:162-175`), so a remounted check-in whose lookup failed or has not returned creates a second ticket (`:402`). When `CheckInPanel` moves behind the create route, the create resumes by `metadata.checkin.episodeId` server-side (or the panel blocks on a successful lookup), with a test driving a failed and a pending lookup to no second insert. Add `LEAK-6` to DF-P2's findings. |
| `ROUTE-5` (comments) | DF-P3 | `lib/ticketAttention.ts:24-27` ("A supervisor is told about a PENDING_IFC package") becomes true only if LEAK-1's `PENDING_IFC` pool includes the supervisors; otherwise the comment must be corrected (DF-P9 owns that file). |
| `PERS-5` | DF-P4 | Remove the `} as Ticket` cast in `rowToTicket` (map the columns the server path reads, or narrow the return type); the brief maps `library_id` only. |
| `AUTHZ-6` | DF-P6 | Rewrite the `CAPABILITY_DEFS` descriptions of `ticket.requester_review`, `ticket.draft_work`, `ticket.direct_approve` (`lib/capabilityPolicy.ts:108-112`) to state their reach. |
| `TIER-6` | DF-P6 | MOC applicability through the work-class mechanism, after `GAP-101` (`TIER-6` is not among DF-P6's findings). |
| `LEAK-4` / `EVID-1` (project push) | DF-P8 | `lib/projects.ts:1588-1599` `convertTicketToProject`'s browser history push becomes part of the server-side project link, or is removed (dormant: no caller). |
| `PROJ-1` (project half) | DF-P8 | The project reference on promotion of a ticket deliverable (`DEC-40`: reference, never copy). |
| `HAND-8` | DF-P9 | `components/viewers/FullScreenViewer.tsx` `sendToDrafting` (`:912-990` only): **both** silent fallbacks surface (`appAlert` + confirm-or-abort) instead of filing the clean original — the `try` / `catch` around the bake and stash (`:951-957`) **and** the `if (bytes)` branch when `ensureBytes()` returns nothing (`:949-950`). Not PS-STAMP's `downloadWithMarkup` region, so the plan's conditional hand-off did not apply. Concurrency: the file is one document-control has touched, but its `HLD-1` limb (the markup export's hold stamp, `ce39cf6`) merged with DC P15 (`b9cdfdc`) before `f1ac550`, and no unmerged package in any fleet plan lists the file — so DF-P9's "runs now, no DC file" holds for this hunk; if a later DC package claims the file, this hunk lands first or rebases (disjoint from `downloadWithMarkup`, `:1000` onward). |
| `SM-13` (client half) | DF-P9 | `app/(protected)/requests/[id]/page.tsx:1245-1247` tests the attachment type the action needs, not `attachments.length > 0`. |
| `FRIC-7` (OPEN) | DF-P9 | An `AttentionContext.requesterRoles` input to `isActionRequired`, fed by the badge hook (`hooks/useTicketNotifications.ts`) from the requesters' current membership and passed to the engine as the route passes it, so a departed requester's co-review is counted by the badge, bell and inbox. Binding: `FRIC-7`'s done-when (every role/status combination) does not hold without it; WF-24's acceptance of the under-count does not bind it. |
| `SM-5`, `LEAK-7` (`BLOCKED`) | DF-P10 | An explicit history check against re-issuing a label. Run `LEAK-7`'s inventory query — one result set, three aggregate rows: (a) under review with an issued label, (b) a `history` that issues the same `Rev N` twice at any status, (c) archived with an issued label. `LEAK-7` closes only when all three are 0. (a) rows are repaired in a `DEC-30` migration; (b) rows (a re-issue already printed, whenever the second approval came) and (c) rows (history moved to the archive bundle) keep `LEAK-7` OPEN until per-attachment identity (`PHYS-2`, `SM-5` done-when 3) or a check of the bundles settles them. |
| `HAND-3` (stamp wording) | DF-P10 | A ticket-deliverable **download** says UNCONTROLLED / "not a controlled revision" until the deliverable is a register revision: the download path stamps a ticket Final `"CONTROLLED COPY"` (`app/(protected)/requests/[id]/page.tsx:661`, recorded at `:694`) while the print path says `"UNCONTROLLED COPY"` (`:589`) — in the FileViewerModal region DF-P10 owns, with `PHYS-9`'s `controlState`. |
| `EVID-2` | DF-P11 | Refuse un-acknowledging for non-service callers, bound `requested_at` writes, write an `ACK_*` audit row (substrate DC `DIST-3`, not `20261047`). |

## New ids DF-P0 asks the integrator to open at merge

*Integrator, 2026-10-02, at the DF-P0 merge: `EDGE-15`, `SM-14` and `AUTHZ-14` are opened as full records in their reports (owner DF-P1), with `LEAK-10` already opened by the records fix; the hand-off rows above are added to the owners' plan entries.*

Four defects found while re-verifying (three in DF-P0's review) are not folded into the records they were found on: the corpus rule is a new id, never a silent fold-in (`../README.md`, "Rules"). The first, `LEAK-10`, has since been opened as a full record in `04-flow-leaks.md` by the DF-P0 records fix (graded HIGH there, with the condition and inventory query that would raise it to CRITICAL), and the area README counts it; the three below remain proposals. DF-P0 may not edit an area README, and a new id changes the severity headline `build-index` checks, so each is written here paste-ready for the integrator to open at merge — the next free number in the named report at that time (the proposed number is the next free one on `f1ac550`), the area README's severity count updated in the same commit, and each id added to its owner's brief with the hand-off row above. Until then each is recorded on the finding in "Found on", so nothing depends on this table alone.

| Proposed id | Report | Severity | Found on | Owner |
|---|---|---|---|---|
| `EDGE-15` | `13-edges-and-invariants.md` | MEDIUM | `EDGE-11` invariant 2 | DF-P1 |
| `SM-14` | `06-state-machine.md` | MEDIUM | `SM-11` | DF-P1 |
| `AUTHZ-14` | `09-authority-surfaces.md` | LOW | `AUTHZ-1` / `SM-1` | DF-P1 |

**`LEAK-10`** — opened: see [`04-flow-leaks.md`](./04-flow-leaks.md#leak-10). (Its proposal here graded it CRITICAL; the opened record grades it HIGH, because the issue-without-engineer outcome needs an org-configured type- or unit-scoped rule — the shipped policy has none — and a hand-written PostgREST call by an active member of the same workspace, and says what raises it to CRITICAL.)

**`EDGE-15` · A ticket whose `last_modified` is `NULL` gets a status-only compare-and-set.** *Mechanism:* the route adds the `last_modified` leg only when the read row has one — `baseQuery = ticket.lastModified ? baseQuery.eq("last_modified", String(ticket.lastModified)) : baseQuery;` (`app/api/tickets/workflow-action/route.ts:432-434`, repeated in the tolerant retry); the column is nullable (`supabase/schema.sql:480`) and unguarded (`20261038:184-205`). *Failure:* a member PATCHes `{"last_modified": null}`; two concurrent `attach_file` calls (or `attach_file` + `save_progress`) on that ticket both land, and the second overwrites `attachments` / `watchers` / `unread_by` from a stale read. *Done when:* (1) the route treats a null token as its own leg (`.is("last_modified", null)`, so the first writer stamps it and the second 409s) or refuses it as a conflict; (2) the guard refuses a client write that nulls the column (or the column becomes `NOT NULL` once DF-P9 has moved the browser writers that stamp it); (3) a route test: two concurrent writes on a null-token row → one 409.

**`SM-14` · The ticket ⇄ intent bridge reads the source document with no org filter, keyed on client-writable metadata.** *Mechanism:* the bridge takes `srcDoc.id` from `ticket.metadata.source_document` (`app/api/tickets/workflow-action/route.ts:513-514`; `metadata` is client-writable, `SM-2`), reads `documents.current_version_id, library_id` with `supabaseAdmin` and `.eq("id", srcDoc.id)` only (`:549-553`), and upserts `document_intents` with `org_id` = the ticket's org, the read `library_id` and `base_version_id`, `onConflict: "document_id,user_id,kind,source"` — no org in the key (`:554-569`). The `CLOSED` hand-back path does filter by org (`:401-402`). *Failure:* a member PATCHes their ticket's `metadata.source_document.id` to a document UUID from another workspace; assigning a drafter makes the service role write an intent row in the member's org carrying the foreign document's `library_id` and `current_version_id`, and for a drafter who belongs to both orgs the upsert can overwrite that org's own ticket-sourced intent row on the document. *Done when:* (1) the read is scoped `.eq("org_id", ticket.orgId)` and the upsert skipped when the document is not in the org; (2) a route test: a foreign document id in `metadata` registers no intent; (3) `metadata` service-only is `SM-2`'s binding residual (DF-P1), which removes the forged input.

**`AUTHZ-14` · The gated requester's note to the engineer is required only by the browser.** *Mechanism:* the note is required by `EngineerPickerModal`'s `requireComment = true` default (`components/requests/EngineerPickerModal.tsx:64`, checked at `:155`); the engine's `request_final_engineer_approval` carries no `requiresComment` (`lib/workflow.ts:382-388`), so the route's comment gate (`app/api/tickets/workflow-action/route.ts:194`) never fires for it. *Failure:* a direct POST of `request_final_engineer_approval` with an engineer and no comment reaches `PENDING_FINAL_APPROVAL` with `engineer_review_reason` `null`; the engineer signs off without seeing the correction the requester wanted. *Why LOW:* the engineer gate itself holds (`AUTHZ-1` / `SM-1` stay `RESOLVED` on the bypass), and only the requester can omit their own note, by going around their own UI. *Done when:* (1) the action requires a comment server-side (`requiresComment: true`, or a route check) and a direct POST without one is a 400 with nothing written; (2) a route test pins it.

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
