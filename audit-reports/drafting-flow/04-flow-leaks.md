# 04 · Leaks — where work, state and attention escape the flow

A leak is anywhere the process loses something without saying so: a ticket
nobody is told about, a state nobody is waiting on, work that leaves the app and
does not come back.

**9 findings** — 2 CRITICAL, 4 HIGH, 3 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.**

---

## LEAK-1 · Queue routing runs once, at ticket creation, and never again

- **Severity:** HIGH
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
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The structural claim is exactly right — the queue-owner pool is never recomputed on a transition. But the specific failure scenario is largely covered by a guard the finding missed: ticketTransitions.ts:296 makes every actor a watcher, and :300-304 unions `ticket.watchers` into unread_by whenever unread_by is non-empty. The person who fires `request_eng_review` from PENDING_ASSIGNMENT is by definition the assignment-queue owner, so on the engineer's `approve_team` they ARE notified as a watcher. The leak is real for queue owners who never touched the ticket (and for PENDING_IFC), which is narrower than CRITICAL. Also note the report's own re-verification line ('exactly one production import') contradicts its Locations list ('only three callers'); the list is correct.

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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** friction
- **Locations:**
  - `lib/ticketRouting.ts:79` — `const byRole = (r: Role) => members.filter((m) => m.role === r);`
  - `lib/ticketRouting.ts:91-95` — `supervisorTargeted()`: if `byRole("DraftingSupervisor")` is empty, **fall back to Admins**
  - `lib/ticketRouting.ts:99` — `engineerRoles.includes(m.role)`, same singular read
  - `lib/roleCapabilities.ts:74-94` — `ROLE_RANK`: `Manager: 90` outranks `DraftingSupervisor: 75`
- **Related:** `LEAK-1`, `CHAIN-2`, `DB-7` (roles-and-permissions area)
- **Re-verified:** hardening pass — **SURVIVES**. `const byRole = (r: Role) => members.filter((m) => m.role === r)` (`ticketRouting.ts:79`) reads the headline column only, and `byRole("DraftingSupervisor")` at `:91` is what decides the routing target. Same class as `EDGE-6` and `roles-and-permissions/ADD-1`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed with no mitigation found: a member with roles ['Manager','DraftingSupervisor'] has role='Manager', byRole('DraftingSupervisor') is empty, and the Admin fallback fires silently. The second-order actor-drop claim also checks out (ticketRouting.ts:111-114 filters the actor, and both callers early-return on an empty list).

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

**Resolution (2026-10-02, drafting-flow Round G).** Record-only close by pointer to roles-and-permissions [`ADD-1`](../roles-and-permissions/04-additive-roles.md) (Round C1b, `bcb959d`, 2026-09-03; pinned again by `WF-19`, Round E), re-verified against `f1ac550`. Routing reads the held collection: `listActiveMembers` selects `"uid, role, roles, display_name, email"` and maps `roles: heldRoles(m)` (`lib/ticketRouting.ts:50-59`); `const byRole = (r: Role) => members.filter((m) => m.roles.includes(r));` (`:99`). A `['Manager','DraftingSupervisor']` member is in the supervisor pool, so `supervisorTargeted()` (`:106-110`) no longer falls back to Admins while a supervisor exists. Test: `lib/__tests__/ticketRouting.test.ts:96` ("WF-19 done-when 2: the supervisor pool matches the FULL role collection, not the headline").

**Done-when.** ✓ A member holding `DraftingSupervisor` as any of their roles receives the queue notifications for it (creation-time routing, and since WF-19 every re-entry into `PENDING_ASSIGNMENT` — `app/api/tickets/workflow-action/route.ts:318-331`).

**Scope / residual.** The second-order effect the finding notes — a sole supervisor filing their own request is filtered out as the actor (`lib/ticketRouting.ts:122-129`) and nobody else is told — is unchanged; it is a pool-size question for the creation route (DF-P2's single server-side creator, `ROUTE-11`/`ROUTE-4`), not a headline-role defect.

---

## LEAK-3 · Any RFI-typed ticket can be closed from `DRAFTING` in one click, skipping every gate

- **Severity:** HIGH
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
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The mechanism is exactly as described and no guard exists anywhere (the server route re-derives the same getActions, so it enforces the same hole). Severity should be HIGH, not CRITICAL: close_rfi publishes nothing to the document register, stamps no deliverable_rev, requires a comment, writes a TICKET_CLOSE_RFI audit row (route.ts:214-223), and is recoverable via `reopen_ticket` (workflow.ts:331-341). The harm is a prematurely terminated ticket, not an unreviewed drawing issued for construction.

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

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. The insert path and the engine half are closed by roles-and-permissions [`WF-15`](../roles-and-permissions/06-request-workflow.md) and [`WF-8`](../roles-and-permissions/06-request-workflow.md) (`087a39c`; migration `20261038` **applied & verified live 2026-09-01**), but the one-click close still reproduces through the UPDATE path, which the fleet plan did not anticipate — so this stays OPEN with an owner (`DEC-31`).
- Closed: `ticket_insert_integrity` refuses a client-created ticket whose `request_type` is outside the org's configured list ∪ {Revision, ASBUILT, RFI} (`supabase/migrations/20261038_rp_phase4_ticket_workflow_rails.sql:152-164`). Close-without-review is a property of the configured type: `const closeTypes = ctx?.closeWithoutReviewTypes ?? ['RFI']; if (closeTypes.includes(ticket.requestType)) { … action: 'close_rfi' … }` (`lib/workflow.ts:360-368`), the route reading the per-type flag from the org's drafting configuration (`app/api/tickets/workflow-action/route.ts:118-133`). `close_rfi` sits inside `if (canActAsDrafter) {` (`lib/workflow.ts:340`), which since WF-8 is the assigned drafter by identity, or the pool only while unassigned (`:210-211`).
- Reproduces: `request_type` is not among the columns `ticket_update_guard` refuses (`20261038:184-205` has no `request_type` line), and `tickets_org_access` is `FOR ALL USING (org_id IN (SELECT my_org_ids()))` (`supabase/schema.sql:1118-1119`). So the assigned drafter can `PATCH /rest/v1/tickets?id=eq.<their ticket>` with `{"request_type":"RFI"}` (or any configured close-without-review type), then post `close_rfi` with a comment: `DRAFTING → CLOSED`, no review, no issued revision. The route still writes `TICKET_CLOSE_RFI`, but the type change itself leaves no history line and no audit row.
- Wider than the RFI close (recorded in the DF-P0 fix pass; widened here rather than opened as a new id, `DEC-31`, because the root — a client-writable column the workflow treats as authority — is this finding's own). `request_type` and `unit` together are the whole `DEC-13` resource a ticket presents: `return { requestType: ticket.requestType || null, unit: ticket.unit || null };` (`ticketResource()`, `lib/workflow.ts:60-61`), the two ticket keys of `RESOURCE_KEYS` (`lib/capabilityPolicy.ts:219`). **Neither** is in `ticket_update_guard` (`20261038:184-205` — `org_id` … `created_at`; no `request_type`, no `unit` line). So every type- or unit-scoped rule reads a value any member can rewrite from the browser:
  - the engineer gate itself — `const needsEngineerApproval = engineerApprovalRequired(ticket.requesterRole, ctx?.requesterRoles, policy, ticket.requesterId, resource);` (`lib/workflow.ts:232`) evaluates the org's `ticket.engineer_gate_exempt` list (`DEC-13` stage 3) against the resource;
  - the requester's own direct approval — `const requesterScopedOut = scopedTokensFor(policy, 'ticket.direct_approve', resource) !== null` (`lib/workflow.ts:238`);
  - who may be picked as reviewer — `const scoped = scopedTokensFor(capPolicy, pickCap, resource);` (`app/api/tickets/workflow-action/route.ts:253`) — and as drafter (`:281-282`);
  - the engineering-first gate (`DRAFT-2`) — `(ctx?.engineeringFirstTypes ?? []).includes(ticket.requestType)` (`lib/workflow.ts:243`);
  - the close-without-review list above (`lib/workflow.ts:361`).
  Reproduction (`DEC-13` stage 3): an org scopes `ticket.engineer_gate_exempt` to `[]` when `requestType ∈ {NEW_DESIGN}`. A Manager's NEW_DESIGN request reaches `PENDING_REVIEW` and the engine offers the Manager only `request_final_engineer_approval`. The Manager PATCHes `{"request_type":"ISO"}`; the guard lets it through; the route re-reads the row, the base exempt list covers Manager, `approve_draft_ifc` is offered and accepted, and the ticket reaches `PENDING_IFC` with no engineer — the type change recorded nowhere. The same works with `unit` against any unit-scoped `ticket.direct_approve` rule. Pinned at engine level (the gate follows the column) and on the live guard body (owns neither column) by `lib/__tests__/dfRoundG_P0.test.ts:402` and `:420`. The public verify page also prints the row's `unit` (`app/api/verify-ticket/route.ts:155`).
  No app path writes `request_type` or `unit` after insert: the four browser writers (`app/(protected)/requests/page.tsx:655`, `:674`, `app/(protected)/requests/[id]/page.tsx:977`, `lib/projects.ts:1599`) write neither (census pinned at `lib/__tests__/dfRoundG_P0.test.ts:420`), and every service-role writer is exempt from the guard (`auth.uid() IS NULL`, `20261038:182`) — so making both workflow-owned breaks nothing.

**Done-when.**
- ✗ (in part) A ticket cannot be **created** with a type outside the configured list (✓, trigger); it can still be **updated** to one, or into a close-without-review type, or out of a type a scoped rule binds (✗) — and `unit`, the other half of the resource, is unguarded the same way.
- ✓ Close-without-review is a declared property of a configured type, not the literal `'RFI'` (the `['RFI']` default applies only when the org configured none).
- ✓ It is not available to every drafter on every ticket (WF-8).

**Scope / residual.** Make **both** `request_type` and `unit` workflow-owned in `ticket_update_guard` (a re-type or re-unit becomes a route action with a history line and an audit row, if the product needs one at all) → **DF-P1**, which re-creates the guard from its newest body (fleet plan, DF-P1 (a)); same root as the `SM-2` residual. Until then every `DEC-13` scoped rule on a ticket — `ticket.engineer_gate_exempt`, `ticket.direct_approve`, the reviewer / drafter pick scoping, `engineeringFirst`, close-without-review — is advisory against a member willing to PATCH the row. **DF-P1's brief item (a) names neither column; the integrator must add both before DF-P1 starts** (`99-fix-sequencing.md`, "Hand-offs from DF-P0"). No code changed here.

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
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, including the RLS premise the finding relies on. The lost-write scenario is real because the write replaces the whole `history` JSONB array from a stale snapshot and the workflow route's CAS on (status, last_modified) (route.ts:155-191) is not involved. Partial mitigation only: a TICKET_FILE_UPLOAD audit_logs row is still written (:1016-1020), so the upload itself is traceable even when the overwritten history entry is not.

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

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. The attachment and category / watcher writes are behind server routes with compare-and-set since roles-and-permissions [`WF-9`](../roles-and-permissions/06-request-workflow.md) (Round E, `e5a203b`): `attach_file` is an engine action (`lib/workflow.ts:604-612`) applied by the workflow route on the `(status, last_modified)` compare-and-set with a `TICKET_ATTACH_FILE` audit row (`app/api/tickets/workflow-action/route.ts:219-225`, `:427-462`); the page no longer writes `attachments`, `comments` or `watchers` (pinned by `lib/__tests__/sweepRoundE_A.test.ts:323`); a concurrent upload and approval cannot both land (`:187`, 409). Two client writers remain off the route.

**Done-when.**
- ✗ (in part) Attachment writes go through the route's CAS and audit path (✓). History writes do not, everywhere: `lib/projects.ts:1588-1599` still pushes a "Converted to Project" entry with a browser read-modify-write of the whole `history` array (dormant — `convertTicketToProject` has no caller in `app/` or `components/` — but present). And the queue's two priority writes still bump the CAS token from the browser without the route: `supabase.from('tickets').update({ priority: 1, last_modified: now })` (`app/(protected)/requests/page.tsx:655`, `:674`), as does the page's `unread_by` clear (`app/(protected)/requests/[id]/page.tsx:977`, unchecked).

**Scope / residual.** Handed on, binding (fleet plan): the `requests/page.tsx` priority writes and the page's `unread_by` write → **DF-P9** (under `PERS-3`: a `set_priority` action, or `{error}` + CAS). Found on HEAD and not named in the plan: the `lib/projects.ts` history push → **DF-P8** (the project link becomes a server action, `GAP-114`). The in-place history rewrite risk itself is `SM-2`'s residual (DF-P1).

---

## LEAK-5 · Field markup is destroyed by a page refresh

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-02, fixed under roles-and-permissions Round C4 as [`LIFE-3`](../roles-and-permissions/07-document-lifecycle.md) / [`GAP-7`](../roles-and-permissions/90-gap-register.md) — the owning records; this one points there).** The document page now passes all three viewer hooks: markup is seeded from the server-side store on open, autosaved on page switches and on close, and restored on reopen; a page refresh no longer destroys it. The drafting-flow area is unclaimed; its own pass re-verifies.

- **Verification:** CONFIRMED
- **Blast radius:** data-loss / adoption
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `FullScreenViewer` exposes `initialPageStates`, `onPageStatesChange` and `onCommit` (`:138-143`), and the document page passes **none of them** — a grep for all three at the call site (`documents/[libraryId]/page.tsx:3025-3036`) returns nothing. Markup lives in component state only.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence, verified with a repo-wide grep for the component (two references only: the dynamic import at page.tsx:64 and the single render at :3025). The handoff path is worse than described: requests/new/page.tsx:104-115 calls takeDraft in a useEffect whose IndexedDB row is destroyed on first read, so the baked markup lives only in React `files` state — one refresh and both copies are gone.

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

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Re-verified:** hardening pass — **SURVIVES**. `doneRef` is a `useRef` (`CheckInPanel.tsx:155`) — in-memory, per-mount. An interruption between creating the ticket and completing the commit loses the only record that the ticket exists.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The fact is right — doneRef does not survive unmount, so closing and reopening the panel after a failure creates a second ticket, upload set and PSM alert. But the finding overstates reachability: the catch at :435-439 only calls `showToast` and `setBusy(false)`, and `onDone()` (CheckoutFlowModal.tsx:658 → onClose) fires only on success, so the panel stays mounted and the natural in-place retry IS idempotent. A duplicate requires the user to actively dismiss the modal and reopen it, which makes this MEDIUM rather than HIGH.

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

**Resolution (2026-10-02, drafting-flow Round G).** Closed by pointer to roles-and-permissions [`LIFE-14`](../roles-and-permissions/07-document-lifecycle.md) (Round A2, `6f0c522`, 2026-09-03), whose done-when this finding adopts; re-verified against `f1ac550` after document-control P6 reworked the checkout sweep. The check-in ticket carries a durable key and the panel resumes it on remount: `components/documents/CheckInPanel.tsx:157-175` — "LIFE-14: a check-in interrupted AFTER its ticket was created … must resume that ticket, never create a second one" — looking up `.eq("metadata->checkin->>episodeId", episode.id)` over non-terminal tickets (`:168-170`) before any creation; the 24 h sweep writes `auto_released` only over an empty verdict — `.update({ ...basePayload, outcome: "auto_released" }) … .eq("status", "active") .is("outcome", null);` (`lib/projects.ts:1990-1997`, kept by DC P6 `DCK-7`). Test: `lib/__tests__/lifeSweep2.test.ts:99-108` ("LIFE-14 — resume, never re-create; the sweep never clobbers a verdict").

**Done-when.** ✓ See `LIFE-14`: (1) a check-in interrupted after ticket creation and resumed in a new component instance links to the existing ticket; (2) the sweep can no longer overwrite a human verdict, and the one remaining NULL-outcome path (a session close that never completes) shows as an open session until the sweep records `auto_released` — never a false verdict.

**Scope / residual.** `CheckInPanel` creates its ticket in the browser; DF-P2 moves it behind the server create route (its one deferred hunk) — the `episodeId` resume key must survive that move.

---

## LEAK-7 · A reopened ticket re-issues the same revision number, and the public QR says it is current

- **Severity:** MEDIUM
- **Status:** BLOCKED
- **Verification:** CONFIRMED
- **Blast radius:** safety / field-truth
- **Re-verified:** hardening pass — **SURVIVES**. `deliverable_rev = issuedRevLabel(ticket.revisionCount)` at three transition sites (`ticketTransitions.ts:223, 232, 250`), so a reopen that does not advance `revisionCount` re-issues the same label — and `EDGE-2` shows the public verify endpoint computes its verdict from `deliverable_rev` with no status term.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both halves confirmed. The reopen path is the only transition into a live status that does not advance revision_count (compare :254-259 and :273-279, which both do `updates.revision_count = (ticket.revisionCount || 0) + 1`), and the public endpoint's verdict ladder has no status term at all.

> **Recorded in full as `WF-21`** in the roles-and-permissions area; `DEC-15`
> settles the direction (a reopen starts a new cycle).

The leak framing: `deliverable_rev` is stamped onto **printed travelers**
(`physicalBridge.printTicketTraveler`), the viewer header and the QR payload.
A reopened, re-approved ticket re-issues the same label, so two materially
different construction packages carry the same revision — and while the ticket is
back under review, `/api/verify-ticket` still reports the field copy as
**current**, which is the one question that endpoint exists to answer.

**Done when.** See `WF-21` / `DEC-15`.

**Partial (2026-10-02, drafting-flow Round G).** The code half is closed by pointer to roles-and-permissions [`WF-21`](../roles-and-permissions/06-request-workflow.md) / `DEC-15` (Round E, `e5a203b`), whose contract this finding's done-when adopts. Re-verified against `f1ac550`: `reopen_ticket` starts a new cycle — `updates.revision_count = (ticket.revisionCount || 0) + 1; updates.draft_iteration = 0; updates.deliverable_rev = null;` (`lib/ticketTransitions.ts:354-363`) — so after an issue at Rev 2 the next submission is `3A` and the next approval `3`; and the public endpoint is reopen-aware — `const reopened = !currentRev && !!issuedBefore && !!t.status && !TERMINAL.has(t.status);` (`app/api/verify-ticket/route.ts:120`), the last issue read from the `issued Rev N` history line (`:59-69`), a reopened ticket's last-issue print reading `revision_in_progress` (`:139-140`), never `current`. PS-VERIFY (merged) kept this verdict ladder. Tests: `lib/__tests__/sweepRoundE_A.test.ts:710` ("WF-21 / DEC-15": lifecycle, minor-correction stamp, the verify route end to end).

The failure scenario still reproduces for one population this repository cannot observe. A ticket reopened **before** Round E (2026-09-17) under the old three-line `reopen_ticket` kept its `revision_count` and its issued, digits-only `deliverable_rev`. While it stays at `PENDING_REVIEW` / `PENDING_FINAL_APPROVAL`: (a) the verify route treats a row that still carries a label as not reopened — `reopened` requires `!currentRev` (`:120`), `inReview` is false for an issued label (`:121`), so a print of that label verifies `current` (`:142`) while the drawing is back under review; (b) its next approval writes `issuedRevLabel(ticket.revisionCount)` from the un-bumped count (`lib/ticketTransitions.ts:285`, `:294`, `:316`) and issues the same label a second time. A `request_revision` / `reject` from there bumps the cycle (`:339-344`) and ends the hazard for that row, which is why the at-risk set is exactly the rows still sitting in those two statuses with an issued label. (Since Round E no transition can put a digits-only label on a row in those statuses: `submit_draft` writes a letter rev, `reopen_ticket` nulls it.)

**Done-when.**
- ✓ (code) Two approvals of the same ticket cannot produce the same issued label for any reopen performed since Round E (WF-21 / DEC-15). ✗ (data) For a pre-Round-E reopen still under review they can — unknown whether any such row exists.
- ✓ (code) A ticket reopened since Round E does not verify as current while back under review. ✗ (data) A pre-Round-E reopened row still carrying its issued label does.

**Blocker (`DEC-27` #4 / `DEC-30`).** Whether the legacy population exists is production data this repository cannot observe. Unblocking step — paste into the Supabase SQL editor (read-only, one aggregate row, no customer data):

```sql
SELECT 'LEAK-7 / SM-5: tickets under review still carrying an issued label (reopened before Round E)' AS check,
       NULL::boolean AS ok,
       COUNT(*)::text AS n
FROM tickets
WHERE status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')
  AND deliverable_rev ~ '^[0-9]+$';
```

- `n = 0` → nothing to repair: flip this finding to `RESOLVED` on the code half above, recording the result here.
- `n > 0` → repair those rows through the service role before closing — bump `revision_count` by one, null `deliverable_rev` and reset `draft_iteration`, with a history line, exactly what today's `reopen_ticket` does — as a `DEC-30` migration (inventory temp table first, aggregate counts only) under **DF-P10**, then record the before/after counts here and close.

**Scope / residual.** The explicit history check that would catch any such row at the next approval is [`SM-5`](./06-state-machine.md#sm-5)'s done-when 2 — OPEN under **DF-P10**, which also owns the repair above. Two approvals that already issued the same label before Round E cannot be told apart by label alone; that is `SM-5` done-when 3 / `PHYS-2` (per-attachment identity), DF-P10. The `FINAL_DRAFT → reject_final` window (WF-21's recorded residual) and the canceled / archived verdicts are `EDGE-2` (DF-P10).

---

## LEAK-8 · `submit_final` is not required to carry a deliverable

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / compliance
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The route validates exactly two preconditions — `requiresComment` and `requiresEngineerPick` (`workflow-action/route.ts:104-109`). `finalAttachment` is an optional body field passed straight through as `body.finalAttachment ?? undefined` (`:38, :145`). Nothing requires `submit_final` to carry anything.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by absence and verified with a repo-wide grep. The client gate is weaker still than the finding says: page.tsx:1031 checks `ticket.attachments && ticket.attachments.length > 0` — ANY attachment, including the requester's original Source file — so even the browser does not require a Final deliverable.

> **Recorded in full as `WF-6`** in the roles-and-permissions area.

`app/api/tickets/workflow-action/route.ts:104-109` re-checks `requiresComment`
and `requiresEngineerPick` server-side and **never reads `action.requiresFile`**.
The "you must attach the issued package" precondition is enforced only in the
browser.

A direct POST advances the ticket to `FINAL_DRAFT` — "Final package issued" —
with no Final attachment. The requester acknowledges, the ticket closes, and
`ticket-shed` archives the empty state permanently.

**Done when.** See `WF-6`.

**Resolution (2026-10-02, drafting-flow Round G).** Closed by pointer to roles-and-permissions [`WF-6`](../roles-and-permissions/06-request-workflow.md) (`087a39c`, 2026-09-01), re-verified against `f1ac550`. The route now reads `action.requiresFile`: `app/api/tickets/workflow-action/route.ts:203-205` — `if (action.requiresFile && action.action === "submit_final" && !body.finalAttachment?.url) {` → 400 "Issuing the final IFC package requires the deliverable file", before `computeTransition`, so a direct POST can no longer mint a "Final package issued" ticket with no deliverable. WF-6 proved it with a source pin (`lib/__tests__/rpPhase4Migration.test.ts:200`); this round adds the route-harness test the done-when asks for: `lib/__tests__/dfRoundG_P0.test.ts:381` drives the real handler with no `finalAttachment`, with `null`, and with a URL-less record — each 400, no tickets write, no audit row, the ticket still `PENDING_IFC`; the Final file → 200 `FINAL_DRAFT`. Mutation-checked: disabling the guard fails it.

**Done-when.** ✓ `submit_final` is refused server-side when no deliverable attachment exists; ✓ a test covers the direct-POST case (`lib/__tests__/dfRoundG_P0.test.ts:381`).

**Scope / residual.** The stricter contract — the attachment must be typed `Final`, and the client check must test the type — is [`SM-13`](./06-state-machine.md#sm-13)'s, OPEN under DF-P1 / DF-P9. Storage-key validation of `finalAttachment` is `AUTHZ-11` (DF-P1).

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
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on every limb, including the sharpest one: components/requests/WorkflowDiagramModal.tsx:36 shows users a 'Canceled — Withdrawn or returned to the requester. A terminal exit off the main flow' state that no code path can ever produce.

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
