# 04 · Leaks — where work, state and attention escape the flow

A leak is anywhere the process loses something without saying so: a ticket
nobody is told about, a state nobody is waiting on, work that leaves the app and
does not come back.

**9 findings** — 2 CRITICAL, 4 HIGH, 3 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.**

---

## LEAK-1 · Queue routing runs once, at ticket creation, and never again

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** friction / adoption
- **Locations:**
  - `lib/ticketRouting.ts:70-117` — `resolveTicketRecipients`, the module written specifically to answer "who owns this queue state"
  - its **only three callers** are creation paths: `app/(protected)/requests/new/page.tsx:340`, `lib/transitionIn.ts:337`, `components/documents/CheckInPanel.tsx:274`
  - `app/api/tickets/workflow-action/route.ts` — **does not import it** (verified: zero occurrences of `resolveTicketRecipients` or `ticketRouting`)
  - `lib/ticketTransitions.ts:140-142` — the recipient set for every transition: `[ticket.requesterId, ticket.assignedDrafterId]`
  - `app/api/tickets/workflow-action/route.ts:309` — `if (recipients.length === 0) return;`
- **Related:** `FRIC-1`, `WF-19` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**. `resolveTicketRecipients` has exactly one production import in the entire codebase — `app/(protected)/requests/new/page.tsx:11`. Every other reference is a test. Routing is computed at creation and never recomputed.

**Mechanism.** At creation, the right people are notified. After that, every
transition notifies only the requester and the assigned drafter — regardless of
which queue the ticket just entered.

So when an engineer completes a scope review and the ticket lands back in
`PENDING_ASSIGNMENT`, the drafting supervisor is notified **only if they happen
to be the requester or the assigned drafter.** Otherwise the ticket enters a
queue and nobody is told.

**Failure scenario.** A ticket goes out for engineering review, comes back
approved, and sits in the assignment queue. The requester sees "engineering
review complete" and assumes it is moving. The supervisor never hears. Three days
later the requester walks over to ask. **The app has now taught someone that the
app does not work.**

**Chain reaction.** This compounds badly with `FRIC-1` (nothing escalates on a
stalled ticket) and `LEAK-2` (routing matches the wrong role field). Between
them: a ticket can enter a queue nobody was told about, and sit past a due date
nobody is watching, with no mechanism anywhere that notices.

`resolveTicketRecipients` also handles only three statuses —
`PENDING_ENG_INITIAL` (which is unreachable, per `WF-17`), `PENDING_ASSIGNMENT`
and `PENDING_IFC` — with `default: pool = []` for everything else. So even wired
in, it covers two live states of twelve.

**Done when.**
1. A transition into a queue state notifies whoever owns that queue, not just
   the requester and drafter.
2. The routing policy covers every state that has a waiting party.
3. A transition whose notification resolves to nobody is visible somewhere, not
   silently dropped.

---

## LEAK-2 · Routing matches the headline role, so a multi-role supervisor is never notified

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** friction
- **Locations:**
  - `lib/ticketRouting.ts:79` — `const byRole = (r: Role) => members.filter((m) => m.role === r);`
  - `lib/ticketRouting.ts:91-95` — `supervisorTargeted()`: if `byRole("DraftingSupervisor")` is empty, **fall back to Admins**
  - `lib/ticketRouting.ts:99` — `engineerRoles.includes(m.role)`, same singular read
  - `lib/roleCapabilities.ts:74-94` — `ROLE_RANK`: `Manager: 90` outranks `DraftingSupervisor: 75`
- **Related:** `LEAK-1`, `CHAIN-2`, `DB-7` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**. `const byRole = (r: Role) => members.filter((m) => m.role === r)` (`ticketRouting.ts:79`) reads the headline column only, and `byRole("DraftingSupervisor")` at `:91` is what decides the routing target. Same class as `EDGE-6` and `roles-and-permissions/ADD-1`.

**Mechanism.** A member with `roles = ['Manager','DraftingSupervisor']` has
`org_members.role = 'Manager'`, because `primaryRole` picks by rank. So
`byRole("DraftingSupervisor")` returns **empty**, the branch silently falls back
to Admins, and the actual drafting supervisor is never notified about their own
queue.

The failure is invisible: the fallback is a legitimate code path, so it looks
like a correctly-routed notification to an Admin.

**Failure scenario.** The drafting supervisor is also a manager — which is
common. Every new request notifies the Admins instead of them. The Admins learn
to ignore it. The supervisor works from memory and from people asking.

**Chain reaction.** Same root cause as `CHAIN-2`/`DB-7` in the
roles-and-permissions area, and `DEC-1` and `DEC-2` settle the direction:
`role` becomes a trigger-maintained projection, and role checks read the
collection. This finding is one of the cheapest beneficiaries of that work.

**Note the second-order effect:** `resolveTicketRecipients` drops the actor
(`:113`). If the drafting supervisor is the only supervisor **and** files the
request themselves, the pool is `[them]` minus `[them]` = empty, and the caller's
`if (recipients.length === 0) return;` makes it a silent no-op. A supervisor's
own request notifies nobody at all.

**Done when.** A member holding `DraftingSupervisor` as any of their roles
receives the queue notifications for it.

---

## LEAK-3 · Any RFI-typed ticket can be closed from `DRAFTING` in one click, skipping every gate

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / data-integrity
- **Locations:**
  - `lib/workflow.ts:185-192` — `if (ticket.requestType === 'RFI') { … close_rfi … }`, inside the `canActAsDrafter` branch at `DRAFTING` / `REVISION_REQ`
  - `lib/ticketTransitions.ts:285-287` — `close_rfi` sets `CLOSED`
  - `types/schema.ts:1019` — `RequestType = string`, unvalidated at insert
  - `lib/capabilityPolicy.ts:70-71` — `ticket.draft_work` defaults to `["Drafter"]`, and per `WF-8` it is **org-wide, not ticket-scoped**
- **Related:** `WF-15`, `WF-8`, `TIER-2`
- **Re-verified:** hardening pass — **SURVIVES**. The `Answer & Close RFI` action is pushed on `requestType === 'RFI'` (`workflow.ts:185-192`) and `close_rfi` sets `status = "CLOSED"` outright (`ticketTransitions.ts:285-287`). Compounded by `TIER-2`: `RequestType` is an unconstrained `string`, so the value that unlocks the one-click close is client-set.

**Mechanism.** `close_rfi` is the only `DRAFTING → CLOSED` edge in the machine.
It is gated on a **free-text string** that nothing validates, offered to anyone
holding `ticket.draft_work` — which by default is every Drafter in the org, on
every ticket.

**Failure scenario.** A ticket is created with `request_type: "RFI"` — by
mistake, by a misconfigured org dropdown, or deliberately. It routes normally to
`PENDING_ASSIGNMENT`, gets assigned, reaches `DRAFTING`. Any drafter in the org
now sees **"Answer & Close RFI"** and can move it straight to `CLOSED` — skipping
`PENDING_REVIEW`, `PENDING_FINAL_APPROVAL`, `PENDING_IFC`, `FINAL_DRAFT`, every
approval, and every deliverable-rev assignment.

A drawing revision closes as if it were a question. `closed_at` is stamped and
the archive eligibility clock starts.

**Chain reaction.** This is the single largest leak in the flow: an entire
approval chain bypassed by one field value and one button. It gets worse under
`TIER-2`'s remediation — the moment work class becomes an authority input, an
unvalidated type string becomes an authority-bearing string. **`WF-15`
(validate `request_type` server-side) is therefore a prerequisite for both.**

**Done when.**
1. A ticket cannot be created or updated with a `request_type` outside the org's
   configured list.
2. The close-without-review behaviour is a declared property of a configured
   type, not a hardcoded comparison to the literal `'RFI'`.
3. It is not available to every drafter on every ticket (`WF-8`).

---

## LEAK-4 · Attachments and history are written straight to the table, outside the workflow route

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / audit
- **Locations:**
  - `app/(protected)/requests/[id]/page.tsx:1010-1014` — a direct `supabase.from('tickets').update({ attachments, last_modified, history })`, no capability check, no compare-and-set
  - `app/(protected)/requests/[id]/page.tsx:1546` — the only gate: a hardcoded role list
  - `app/(protected)/requests/page.tsx:620,638` — bulk "mark urgent", same shape
- **Related:** `WF-9`, `WF-2` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**. `await supabase.from('tickets').update({ attachments, last_modified, history }).eq('id', ticketId)` (`requests/[id]/page.tsx:1010-1014`) writes the table directly, bypassing `workflow-action/route.ts` and therefore the capability check at `:91-102`. Reachable because `tickets` RLS is `FOR ALL USING (org membership)` (`roles-and-permissions/WF-2`).

**Mechanism.** The workflow route is the enforcement point, with
compare-and-set on `(status, last_modified)` and a server-written audit row.
Attachment uploads and history entries bypass it entirely, writing whole arrays
from possibly-stale React state.

**Failure scenario — the audit leak.** A drafter uploads while the requester
approves. The upload writes `{attachments, history, last_modified}` from state
read before the approval landed. **The approval's history entry is gone** — not
flagged, not conflicted, silently overwritten. The ticket's own audit surface,
which is what the ticket page renders as the record of what happened, has a hole
in it that nothing reports.

**Chain reaction.** Recorded as `WF-9` in the roles-and-permissions area for the
authority consequence (two unprivileged calls can take someone else's ticket from
`DRAFTING` to `PENDING_REVIEW`). The leak framing here is the *record* loss,
which is the part that matters for a PSM audit trail.

**Done when.** Attachment and history writes go through the same
compare-and-set and audit path as every other ticket mutation.

---

## LEAK-5 · Field markup is destroyed by a page refresh

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-loss / adoption
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `FullScreenViewer` exposes `initialPageStates`, `onPageStatesChange` and `onCommit` (`:138-143`), and the document page passes **none of them** — a grep for all three at the call site (`documents/[libraryId]/page.tsx:3025-3036`) returns nothing. Markup lives in component state only.

> **Recorded in full as `LIFE-3`** in the roles-and-permissions area, and
> specified as `GAP-7`. Repeated here because it is the most likely single cause
> of someone abandoning the app mid-task.

`FullScreenViewer` offers three persistence hooks
(`initialPageStates` / `onPageStatesChange` / `onCommit`,
`components/viewers/FullScreenViewer.tsx:138-143`) and the only render site
passes **none of them** (`app/(protected)/documents/[libraryId]/page.tsx:3025-3039`).
`handleClose` computes the merged page state, finds no listener, and drops it.
The escape hatch, `takeDraft` (`lib/draftHandoff.ts:53-66`), **deletes the
IndexedDB entry inside the `get` success handler before returning.**

So: twenty minutes of redlines on a live P&ID, one accidental refresh on
`/requests/new`, and it is gone — from the viewer, from IndexedDB, and from the
document. No error, no trace in any audit table.

**The tell that this is already known:** `lib/checkinOutcomes.ts:169-170` tells
the user to work around it — *"use Download w/ Markup in the viewer, then attach
that file below."* The check-in flow cannot reach the markup programmatically, so
it asks the human to launder it through their filesystem.

**Done when.** See `LIFE-3` / `GAP-7`.

---

## LEAK-6 · A check-in interrupted mid-commit orphans the ticket it already created

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Re-verified:** hardening pass — **SURVIVES**. `doneRef` is a `useRef` (`CheckInPanel.tsx:155`) — in-memory, per-mount. An interruption between creating the ticket and completing the commit loses the only record that the ticket exists.

> **Recorded in full as `LIFE-14`** in the roles-and-permissions area.

`doneRef` (`components/documents/CheckInPanel.tsx:155-159`) is a `useRef` — it
survives re-renders, **not unmount**. If the session-close write fails after the
ticket, the uploads, the hold and the PSM escalation have all committed, the user
sees "check-in failed", closes the modal, and retries. The retry starts a fresh
`doneRef` and creates a **second** ticket, a second upload set and a second
priority-1 alert.

Meanwhile the stale checkout blocks other publishers until the expiry sweep
records `auto_released` — which **overwrites the outcome slot**, erasing the
evidence that a discrepancy was reported through that session at all.

**Done when.** See `LIFE-14`.

---

## LEAK-7 · A reopened ticket re-issues the same revision number, and the public QR says it is current

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / field-truth
- **Re-verified:** hardening pass — **SURVIVES**. `deliverable_rev = issuedRevLabel(ticket.revisionCount)` at three transition sites (`ticketTransitions.ts:223, 232, 250`), so a reopen that does not advance `revisionCount` re-issues the same label — and `EDGE-2` shows the public verify endpoint computes its verdict from `deliverable_rev` with no status term.

> **Recorded in full as `WF-21`** in the roles-and-permissions area; `DEC-15`
> settles the direction (a reopen starts a new cycle).

The leak framing: `deliverable_rev` is stamped onto **printed travelers**
(`physicalBridge.printTicketTraveler`), the viewer header and the QR payload.
A reopened, re-approved ticket re-issues the same label, so two materially
different construction packages carry the same revision — and while the ticket is
back under review, `/api/verify-ticket` still reports the field copy as
**current**, which is the one question that endpoint exists to answer.

**Done when.** See `WF-21` / `DEC-15`.

---

## LEAK-8 · `submit_final` is not required to carry a deliverable

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / compliance
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The route validates exactly two preconditions — `requiresComment` and `requiresEngineerPick` (`workflow-action/route.ts:104-109`). `finalAttachment` is an optional body field passed straight through as `body.finalAttachment ?? undefined` (`:38, :145`). Nothing requires `submit_final` to carry anything.

> **Recorded in full as `WF-6`** in the roles-and-permissions area.

`app/api/tickets/workflow-action/route.ts:104-109` re-checks `requiresComment`
and `requiresEngineerPick` server-side and **never reads `action.requiresFile`**.
The "you must attach the issued package" precondition is enforced only in the
browser.

A direct POST advances the ticket to `FINAL_DRAFT` — "Final package issued" —
with no Final attachment. The requester acknowledges, the ticket closes, and
`ticket-shed` archives the empty state permanently.

**Done when.** See `WF-6`.

---

## LEAK-9 · There is no record of work that left the app

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** process visibility
- **Locations:**
  - `lib/workflow.ts:80-342` — twelve statuses, none of which represents "handled outside the system"
  - `types/schema.ts` — the `TicketStatus` union; `CANCELED` exists and **no action produces it** (`WF-17`, `DEC-14`)
  - `lib/ticketTransitions.ts:284-287` — `close_ticket` records no reason
- **Related:** `FRIC-1`, `GAP-13` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**. `close_ticket` sets `CLOSED` and nothing else (`ticketTransitions.ts:284-287`); no field, table or transition records that the deliverable was produced outside the app.

**Mechanism.** When someone shoulder-taps and the work happens outside the app,
the ticket has three possible fates: it is force-closed with no reason, it is
acknowledged as though the flow completed, or it sits open forever. **None of
them is distinguishable afterwards from a normal outcome.**

There is no "handled out of band", no "duplicate", no "withdrawn", and — because
`CANCELED` is documented to users but unreachable — not even a cancel.

**Failure scenario.** The thing this whole audit is about — people bypassing the
app — is **structurally invisible**. You cannot count it, cannot find which
request types or which queues leak most, and cannot tell an abandoned ticket from
a completed one. The metric that would tell you whether the friction fixes are
working does not exist.

**Chain reaction.** This pairs with `GAP-13` (the triage rejection taxonomy) and
with `DEC-14` (implement `CANCELED`): both are about making a non-standard
outcome a first-class, reportable fact instead of a silence. Closing this leak is
what makes every other finding in this area **measurable** — which is why it is
worth doing early despite being MEDIUM.

**Done when.**
1. A ticket can be closed as withdrawn, duplicate, or handled out of band, with a
   reason.
2. Those outcomes are reportable — a queue's leak rate is a number someone can
   look at.
3. `CANCELED` is reachable, per `DEC-14`.

---

## Verified sound — do not break

1. **The workflow route is genuinely server-authoritative.** The client sends
   inputs only; the server re-authenticates, verifies active org membership,
   re-validates the action against `WorkflowEngine.getActions` with the org's own
   capability policy, verifies a picked engineer actually holds an Engineer role,
   applies compare-and-set on both status and `last_modified`, and writes the
   audit row and notification fan-out server-side so a closed tab cannot skip
   them. **`LEAK-4` is about the writes that go around this — not about this.**
2. **The archived-ticket guard** (`app/api/tickets/workflow-action/route.ts:69-74`)
   prevents resurrecting shed content into an inconsistent state.
3. **Stale-notification supersession** (`:324-332`) retires unread rows carrying
   `metadata.action` while deliberately leaving comment and mention rows alone.
   Subtle and correct.
4. **`escapeHtml` on every interpolation in the notification email body**
   (`lib/ticketTransitions.ts:378-385`).
5. **The intake redline round-trip** — `flagCollisionToDrafting` stamps the link
   id, `/api/intake/resolve` surfaces open collision tickets to the contractor
   portal, and `/api/intake/upload` **verifies the link owns the ticket before
   attaching**, stores to a scoped key, notifies both sides, and writes an
   `INTAKE_REDLINE` audit row. **The only hand-off in the codebase with no leak in
   it. It is the template.**
6. **The ticket-internal redline loop** — a reviewer's redline uploads as a
   `REDLINE_`-prefixed attachment with a `TICKET_REDLINE_CREATED` audit row, and
   the drafter finds it surfaced in the revision banner rather than buried in the
   file list. Complete and closed.
