# 99 · Execution order

**Binding, not advisory.** This area has one ordering constraint that outweighs
everything else, and getting it wrong produces a workflow people abandon.

No findings of their own — this is the plan the 40 findings and 8 gap specs are
worked against. Judgment calls shared with the roles model are settled in
[`../DECISIONS.md`](../DECISIONS.md).

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
concrete and the stated need is urgent. Built as a status, it adds a hop to every
ticket in the plant — including the like-in-kind work it is meant to cover
cheaply.

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
3. **`GAP-102`** — QA/QC as a capability plus a roster slot. Safe now, because
   the roster is parallel.
4. **`TIER-4`** / `DEC-13` — the code-governed dimension, as part of the
   resource-dimension work already committed in the roles area.
5. **`GAP-104`** — document-control release routing, per library, on the roster.
6. **`TIER-7`** — convert "Approve with Minor Correction" from an unconditional
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
