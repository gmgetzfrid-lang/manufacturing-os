# 06 · Request workflow & the capability policy layer

The 12-status drafting state machine, who may drive each transition, and the
capability policy that is supposed to make it configurable.

**24 findings** — 5 CRITICAL, 9 HIGH, 10 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.** Line
> numbers drift — **match on the quoted code.**

> **Read `WF-1` first.** The entire capability policy layer is currently inert
> because it reads a column that does not exist. Several findings below are
> *masked* by that and become live the moment it is fixed. Fixing `WF-1` in
> isolation, without reading `WF-10`, `WF-11` and `WF-23`, will activate three
> latent problems at once.

---

## WF-1 · The capability policy reads and writes a column that does not exist

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control / availability
- **Locations:**
  - `lib/capabilityPolicy.ts:172-177` (read), `lib/capabilityPolicy.ts:228-234` (write) — `.select("value")`
  - `supabase/schema.sql:52-59` — the table has `data JSONB NOT NULL DEFAULT '{}'`. **There is no `value` column, and no migration adds one.**
  - `supabase/migrations/20260901_db_hard_enforcement.sql:44` — the SQL side reads the same phantom column
  - `supabase/migrations/20260701_perf_indexes.sql:21` — documents the real shape as `select('data')`
- **Related:** `WF-10`, `WF-11`, `WF-23`, `DB-1`
- **Re-verified:** hardening pass — **SURVIVES**. Same root as `DB-1` — fix both in one migration. `capabilityPolicy.ts:174` does `.select("value")` and discards the error, so the read fails silently and every policy falls back to `DEFAULTS`; the upsert at `:231` sends `value:` and *does* check its error, so writes fail loudly while reads fail quietly.

**Mechanism.**

```ts
const { data } = await (client ?? supabase)
  .from("org_configurations")
  .select("value")           // ← the column is `data`
  .eq("org_id", orgId).eq("key", "capability_policy").maybeSingle();
const raw = (data?.value as Record<string, unknown> | null) ?? {};
```

The read destructures only `{ data }` — the PostgREST `42703` error is
discarded, `raw` becomes `{}`, and the empty policy is **cached for 60 seconds**.
On the SQL side, `org_capability_allows()` executes
`SELECT value INTO v_val FROM org_configurations` at runtime and raises `42703`.

**Failure scenario.** An admin opens Admin → Permissions, sees the shipped
defaults (because the load silently returned nothing), unchecks `Engineer` from
`ticket.direct_approve`, confirms the impact preview, and gets an error toast
from `saveCapabilityPolicy`'s `throw`. Nothing is ever persisted. Every
per-person `UserGrant` fails the same way. **The entire 17-capability
org-configurable layer, the delegation UI, and the "enforced server-side"
promise are inert** — the app runs permanently on hardcoded `DEFAULTS`.

**Chain reaction.** `org_capability_allows()` is the `WITH CHECK` of
`document_holds_insert` and `document_holds_update`, and the body of
`enforce_checkout_release_guard`. So **placing a hold, releasing a hold, and any
non-owner checkout close all throw a database error**, not a permission error —
and `lib/holds.ts:104-107` swallows it as a *"policy lookup hiccup: fail open"*.
Fixing the column name immediately **activates** `WF-10`, `WF-11` and `WF-23`,
which are currently masked. Read those three before shipping this.

**Done when.**
1. The capability policy loads and saves against the real column.
2. A read error fails **closed** (returns `{}` *without caching*) rather than
   silently caching a defaults-only policy.
3. Placing and releasing a hold no longer raises a SQL error.
4. `org_configurations` is covered by `lib/schemaExpectations.ts` so
   `/api/admin/schema-health` catches this class of drift.

---

## WF-2 · `tickets` RLS is `FOR ALL USING (org membership)` — any member can PATCH any ticket's status

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security / data-integrity / safety
- **Locations:**
  - `supabase/schema.sql:1080` — `CREATE POLICY "tickets_org_access" ON tickets FOR ALL USING (org_id IN (SELECT my_org_ids()))` — **the only policy on the table**
  - `supabase/schema.sql:1031-1034` — `my_org_ids()`
  - live browser writers: `app/(protected)/requests/[id]/page.tsx:1010-1014,978,1328`; `app/(protected)/requests/page.tsx:620,638`; `app/(protected)/requests/new/page.tsx:328`
- **Related:** `WF-5`, `WF-9`, `WF-15`, `WF-20`
- **Re-verified:** hardening pass — **SURVIVES**. `tickets_org_access FOR ALL USING (org_id IN my_org_ids())` — no `WITH CHECK`, so `USING` governs INSERT and UPDATE too. Same shape as `notifications`, `email_notifications` and `project_documents`; read `document-control/DRLS-1` before patching any of them.

**Mechanism.** `FOR ALL` with `USING` and no `WITH CHECK` means Postgres reuses
`USING` as the check for INSERT and UPDATE. The only qualification is active
membership. No trigger constrains `status`, `requester_role`,
`assigned_drafter_id`, `deliverable_rev`, `attachments` or `history` — the only
trigger on the table is `tickets_search_tsv_trg`.

**Failure scenario.** A Viewer with a valid session runs:

```
PATCH /rest/v1/tickets?id=eq.<uuid>
{"status":"PENDING_IFC","deliverable_rev":"3","assigned_drafter_id":"<self>"}
```

The ticket is now approved-for-construction. `/api/tickets/workflow-action` —
the "single enforcement point" per the route's own header comment — was never
invoked, so there is **no audit row, no history entry, no notification and no
compare-and-set**. The same PATCH can rewrite `history` to fabricate an approval
by someone else, or set `requester_role: 'Admin'` to unlock `WF-5`.

**Chain reaction.** ⚠ Tightening this policy **will break three legitimate
client writers** listed above (`priority`, `comments`, `watchers`, `unread_by`,
attachments). Those must move behind routes, or the policy must be narrowed by
column grant rather than replaced. Everything downstream trusts
`tickets.status`/`deliverable_rev` as authoritative: `/api/verify-ticket` (the
public QR "is this still current?"), `lib/impact.ts`, `lib/inbox.ts`,
`hooks/useTicketNotifications.ts`, `/admin/analytics`, the archive eligibility
clock, and the document-intent bridge.

**Done when.**
1. A member cannot change a ticket's `status`, `requester_role`,
   `assigned_drafter_id`, `assigned_engineer_id`, `deliverable_rev`, `history`
   or `attachments` other than through `/api/tickets/workflow-action`.
2. Every legitimate client write that exists today still succeeds.
3. A test attempts the raw PATCH above and asserts refusal.

---

## WF-3 · "Approve with Minor Correction" is a complete bypass of the engineer sign-off gate

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED — traced end to end, and **frozen by a passing test**
- **Blast radius:** safety
- **Locations:**
  - `lib/workflow.ts:198-234` — the offer; specifically `:200-218` versus `:219-228`
  - `lib/ticketTransitions.ts:221-237` — the effect
  - `lib/__tests__/workflow.test.ts:163-174` — **the test asserts the vulnerability**
- **Related:** `WF-4`, `WF-14`
- **Re-verified:** hardening pass — **SURVIVES**. `approve_minor_correction` is pushed unconditionally inside `if (canActAsRequester)` (`workflow.ts:219-226`), as a sibling of the `needsEngineerApproval && !isEng` fork that is supposed to force the engineer route. The code comments it as intentional — *"Available to every requester tier by design"* — which makes it a policy decision to revisit rather than a coding slip, but the stated effect is exact.

**Mechanism.** The engineer fork and its bypass are pushed into the same button
row:

```ts
if (canActAsRequester) {
  if (needsEngineerApproval && !isEng) {
    actions.push({ action: 'request_final_engineer_approval', /* …routes to an engineer… */ });
  } else {
    actions.push({ action: 'approve_draft_ifc', /* …straight to IFC… */ });
  }
  // "Available to every requester tier by design."
  actions.push({ label: 'Approve with Minor Correction', action: 'approve_minor_correction', requiresComment: true });
```

Both actions have the **identical terminal effect**:

```ts
case "approve_draft_ifc":        updates.status = "PENDING_IFC"; updates.deliverable_rev = issuedRevLabel(...);
case "approve_minor_correction": updates.status = "PENDING_IFC"; updates.deliverable_rev = issuedRevLabel(...);
```

Both are "issue this drawing for construction." One is gated on engineering
qualification; the other is offered to everyone, side by side.

**Failure scenario.** A Safety officer raises a P&ID revision. The draft comes
back. The UI offers "Send for Engineer Final Approval" *and* "Approve with Minor
Correction". They click the second, type "fix the typo in the title block", and
the drawing is issued for construction with **zero engineering review**.
`PENDING_FINAL_APPROVAL` and the whole `requiresEngineerApproval` fork are
optional decoration. The server re-derivation permits it faithfully — it is
enforcing the same broken rule.

**Chain reaction.** `requiresEngineerApproval`, the `PENDING_FINAL_APPROVAL`
status, `ticket.final_approve`, `ticket.reassign_engineer`,
`EngineerPickerModal` and the `engineer_approved_at` stamp all exist to serve a
gate this one button voids. **Closing it makes `PENDING_FINAL_APPROVAL`
load-bearing for the first time and immediately surfaces `WF-14` (self-picked
engineer) as the next hole — fix them together or the remediation is a no-op.**
`lib/__tests__/workflow.test.ts:163-174` must be updated; it currently pins the
bypass as correct behaviour.

**Done when.**
1. A requester who is not engineering-qualified cannot reach `PENDING_IFC` in
   one action when `requiresEngineerApproval` is true for their ticket.
2. The minor-correction path still exists for actors who legitimately hold
   direct-approve authority at that state.
3. The test file asserts the *closed* behaviour.

---

## WF-4 · Complete single-person end-to-end loops — no second human anywhere

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / process
- **Locations:**
  - `lib/workflow.ts:47-53` — `getInitialStatus` ignores both parameters
  - `lib/workflow.ts:69-75` — identity rights
  - `lib/workflow.ts:140-162`, `:166-193`, `:198-256`, `:301-323`
  - `app/api/tickets/workflow-action/route.ts:113-132` — `assign` validates the assignee only as "an active member"
- **Related:** `WF-3`, `WF-8`, `WF-14`, `GAP-2`
- **Re-verified:** hardening pass — **SURVIVES**, with a scope note: this is a **synthesis** over the engine rather than a claim about the three cited line ranges, so it is not point-checkable the way its siblings are. It is well supported by them — `getInitialStatus` returns `PENDING_ASSIGNMENT` with engineering optional, `WF-3` supplies a requester-side bypass, and `WF-5` lets the one gating input be client-set.

**Mechanism.** `getInitialStatus` sends *every* request straight to
`PENDING_ASSIGNMENT` — there is no initial-review gate at all. Identity rights
are deliberately non-configurable, and `assign` does not exclude
self-assignment or check that the assignee can draft.

**Loop A — Manager, default policy, five clicks, no capability edits:**
1. File request → `requesterRole: "Manager"`, status `PENDING_ASSIGNMENT`.
2. `assign` — `ticket.assign` includes Manager; assign **themselves** as drafter.
3. `save_progress` + `submit_draft` — via `isDrafterIdentity`.
4. `approve_draft_ifc` — `isRequesterIdentity`, and
   `requiresEngineerApproval("Manager") === false` → `PENDING_IFC`.
5. `submit_final` → `close_ticket`. **Drawing issued for construction, approved
   by its own author.**

**Loop B — a plain Drafter with no management rights:** file → `self_assign` →
`submit_draft` → as requester click `approve_minor_correction` (`WF-3`) →
`PENDING_IFC` → `submit_final` → `close_ticket`. Identical outcome.

**Loop C — org-wide role authority on someone else's ticket:** see `WF-8`.

**Chain reaction.** ⚠ These loops are partly *intentional* — the codebase
supports a "small shop where one person does everything" mode. **Separation of
duties must not be a hard rule**, or every single-operator customer breaks on
upgrade. It changes the `DRAFTING` and `PENDING_REVIEW` cells of the transition
matrix.

**`DEC-12` settles the shape: derive it from active member count, not a toggle.**
Enforce all three predicates when the org has three or more active members; allow
the loop below that. A toggle defaulting off is a control nobody sets; one
defaulting on is a control people switch off. Member count means the protection
appears exactly when it becomes possible to honour. Build spec: `GAP-2`.

**Done when.**
1. An org can require that the assigned drafter is not the requester, that the
   approver is not the assigned drafter, and that the assigned engineer is not
   the requester.
2. Each predicate is evaluated in `getActions` **and** re-checked in the route.
3. Orgs that have not enabled it behave exactly as they do today.

---

## WF-5 · `requester_role` is stamped by the client at INSERT and is the sole input to the engineer gate

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security / safety
- **Locations:**
  - `app/(protected)/requests/new/page.tsx:309` — `requester_role: activeRole`
  - `lib/transitionIn.ts:315` — `requester_role: input.actorRole`
  - `components/documents/CheckInPanel.tsx:250` — `requester_role: currentUser.role`
  - consumed at `lib/workflow.ts:78` → `lib/workflow.ts:37-43`
  - read straight off the row at `lib/ticketTransitions.ts:65`; **never compared to `org_members.role`**
- **Related:** `WF-2`, `WF-12`
- **Also surfaced independently as** [`AUTHZ-3`](../drafting-flow/09-authority-surfaces.md#authz-3) — two areas found this separately. Fix once.
- **Re-verified:** hardening pass — **SURVIVES**. `requester_role: activeRole` (`requests/new/page.tsx:309`), `input.actorRole` (`transitionIn.ts:315`), read back unchecked at `ticketTransitions.ts:65`; combined with `WF-2` it is also directly PATCHable. **New interaction found during this pass:** `activeRole` is the `RoleContext` value, which `identity-and-session/SESS-1` shows can be the placeholder `"Viewer"` while membership is still resolving — so a request filed during that window is stamped `Viewer` permanently, which is precisely the input that decides whether engineering review is required.

**Mechanism.** The role that decides whether engineering sign-off is required is
asserted by the browser at insert time and never re-derived:

```ts
requiresEngineerApproval(requesterRole?: Role | string): boolean {
  if (!requesterRole) return true;
  if (isEngineerRole(requesterRole)) return false;   // substring "Engineer"
  if (isManagementRole(requesterRole)) return false; // Admin|Manager|Supervisor
  if (isDocCtrlRole(requesterRole)) return false;
  return true;
}
```

Combined with `WF-2`'s open INSERT policy, a Viewer can create a ticket carrying
`requester_role: "Manager"`.

**Failure scenario.** A Contractor posts a ticket with
`"requester_role":"Engineer-4"`. At `PENDING_REVIEW`, `needsEngineerApproval` is
false, so their requester-identity branch yields `approve_draft_ifc` — a direct,
fully audited, apparently legitimate approval to IFC. The audit row records
`user_role: Contractor`, so it *is* detectable after the fact, but nothing
prevents it.

**Chain reaction.** `requesterRole` also drives `/admin/analytics` role
breakdowns and the ticket header badge. Re-deriving it server-side breaks the
three client insert paths above, which must move behind an API route or an
insert-time trigger.

**Done when.**
1. `requester_role` and `requester_id` on a new ticket reflect the authenticated
   caller's actual membership, not client-supplied values.
2. A new ticket cannot be created in any status other than
   `PENDING_ASSIGNMENT` by a client.
3. Service-role creation paths still work.

---

## WF-6 · Server re-derivation is incomplete — `requiresFile` is never enforced

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / compliance
- **Locations:**
  - `app/api/tickets/workflow-action/route.ts:104-109` — checks `requiresComment` and `requiresEngineerPick`; **`action.requiresFile` is never read**
  - the flag is set at `lib/workflow.ts:181`, `:313`
  - the only check is client-side at `app/(protected)/requests/[id]/page.tsx:1028-1031`
- **Related:** `WF-2`, `WF-22`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `requiresFile: true` is declared at `workflow.ts:181`, and the route validates only `requiresComment` and `requiresEngineerPick` (`workflow-action/route.ts:104-109`). Same evidence as `drafting-flow/LEAK-8`.

**Mechanism.** Two of three input preconditions are re-checked server-side. The
third — "you must attach the issued package" — is enforced only in the browser
(*"Compliance Check Failed: You must upload at least one file before
proceeding."*).

**Failure scenario.** `POST /api/tickets/workflow-action
{"ticketId":…,"actionType":"submit_final"}` with no `finalAttachment`.
`computeTransition` sets `status = FINAL_DRAFT` and appends nothing. The ticket
now presents as "Final package issued" with **no Final attachment**; the
requester acknowledges and closes it, and the closed record is archived by
`ticket-shed` with an empty deliverable. (`submit_draft` is safe only by
accident — its gate is derived from ticket *state* rather than request input.)

**Chain reaction.** `/api/verify-ticket` reports the ticket as issued at rev N;
`lib/archive.ts` snapshots the empty state permanently. While fixing this, note
that `redlineAttachment` / `finalAttachment` are inserted verbatim
(`lib/ticketTransitions.ts:172,282`) with no shape validation.

**Done when.** `submit_final` is refused server-side when no deliverable
attachment exists, and a test covers the direct-POST case.

---

## WF-7 · Three incompatible role resolutions; the "View as" simulator reports authority the app does not grant

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control / ux
- **Locations:**
  - workflow (**headline only**): `lib/workflow.ts:65` — `policyAllows(policy, cap, userRole, null, userId)`
  - route (**headline only**): `app/api/tickets/workflow-action/route.ts:88` — `const callerRole = (member.role as Role) ?? "Viewer"`
  - simulator (**additive**): `components/permissions/ViewAsSimulator.tsx:128` — passes `who.roles`
  - holds (**additive**): `lib/holds.ts:98-100`
  - database (**additive**): `supabase/migrations/20260901_db_hard_enforcement.sql:38`
  - attention feed (**additive**): `lib/ticketAttention.ts:30-37`
- **Related:** `ADD-1`, `ADD-2`, `WF-8`, `CHAIN-*`
- **Re-verified:** hardening pass — **SURVIVES**. Three resolutions, each verifiable in one line: `workflow.ts:65` (`extraRoles: null`), `workflow-action/route.ts:88` (`member.role`), `ViewAsSimulator.tsx:128` (`who.roles`).

**Mechanism.** `policyAllows` has an `extraRoles` parameter that the workflow
deliberately starves with `null`. Because `primaryRole` is *max-rank*, the
additive model **subtracts** authority in the workflow: `["DocCtrl","Drafter"]`
resolves to headline `DocCtrl` (rank 70 > 50), so `ticket.self_assign` —
defaulting to `["Drafter"]` — is denied.

**Failure scenario.** An admin adds `Drafter` to a DocCtrl so they can pick up
overflow work. The role picker says the role adds `draft_work`;
`ViewAsSimulator` renders a green check next to "Self-assign drafting work" — in
the component that advertises itself as *"computed with the SAME evaluators the
app enforces with."* The user opens the queue and sees no "Pick Up Ticket"
button. Meanwhile `isActionRequired` *does* read the collection, so their sidebar
badge counts the ticket as needing action while the ticket page prints
"**View Only — No Actions Available**."

**Chain reaction.** ⚠ **Do `WF-8` first.** Switching the workflow to additive
roles widens authority for every multi-role member simultaneously — anyone
holding `Drafter` alongside a senior role instantly gains org-wide
`ticket.draft_work`. Applied in the wrong order this fix is a privilege
expansion. Also align the three different definitions of "management"
(`WF-24`).

**Done when.** A member's ticket authority is identical whether a role is their
headline or an additive one, and the simulator agrees with the ticket page and
the attention badge for the same person.

---

## WF-8 · Role-based capabilities are org-wide — they are never scoped to the ticket

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control / safety
- **Locations:**
  - `lib/workflow.ts:74-75` — `const canActAsRequester = isRequesterIdentity || allows('ticket.requester_review');`
  - `lib/workflow.ts:156`, `:168`, `:199`, `:302`, `:320`, `:332`
  - defaults at `lib/capabilityPolicy.ts:68-73`; evaluator at `:141-155`
- **Related:** `WF-3`, `WF-4`, `WF-13`, `WF-15`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `allows('ticket.requester_review')`, `allows('ticket.draft_work')` (`workflow.ts:74-75`) and `allows('ticket.self_assign')` (`:156`) all evaluate org-wide; `policyAllows` has no ticket, library or project parameter.

**Mechanism.** `policyAllows` takes **no ticket argument**.
`ticket.requester_review` defaults to `["Requester"]` and `ticket.draft_work` to
`["Drafter"]`, so the `||` grants a blanket, org-wide *substitute identity* to
every holder of those roles on **every ticket in the org**.

**Failure scenario.** A 40-person plant has 25 people with role `Requester`. Any
one of them can open a colleague's ticket at `PENDING_REVIEW` and click "Approve
with Minor Correction" — issuing the drawing (`WF-3`). Any one of them can
`reopen_ticket` on any closed ticket in the org's history. Any of the six
`Drafter`s can `submit_final` on a ticket assigned to a different drafter,
replacing the IFC package.

**Chain reaction.** This is what makes `ViewAsSimulator`'s per-person view
misleading (a flat yes/no with no scope) and what makes the capability model
unable to express "reviewers of *my* discipline" (`WF-13`). **Scoping these two
capabilities is the single highest-value narrowing available in this report and
touches only `lib/workflow.ts:74-75`.** It is also the prerequisite for `WF-7`.

**Done when.**
1. Holding `ticket.requester_review` does not let a member approve an arbitrary
   colleague's ticket at `PENDING_REVIEW`.
2. Holding `ticket.draft_work` does not let a member submit a deliverable on a
   ticket assigned to someone else.
3. The queue-claim behaviour for unassigned tickets is unchanged.

---

## WF-9 · Attachment and comment writes bypass the workflow route entirely

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / access-control
- **Locations:**
  - `app/(protected)/requests/[id]/page.tsx:991-1026` — `handleFileUpload`
  - `app/(protected)/requests/[id]/page.tsx:966-988` — `handleUpdateCategory`
  - `app/(protected)/requests/[id]/page.tsx:1322-1330` — `toggleWatch`
  - `app/(protected)/requests/[id]/page.tsx:1546` — the only gate: a hardcoded role list
- **Related:** `WF-2`, `WF-7`, `WF-8`
- **Re-verified:** hardening pass — **SURVIVES**. `handleFileUpload` and `handleUpdateCategory` write `tickets` directly (`requests/[id]/page.tsx:991-1014, 966-977`), bypassing the capability check at `workflow-action/route.ts:91-102`. Reachable because `tickets` RLS is `FOR ALL USING (org membership)` — see `WF-2`.

**Mechanism.** The gate is a literal role list, and the write is a direct table
update with no capability check, no server route, and **no compare-and-set** —
with `currentAttachments` / `currentHistory` read from possibly-stale React
state:

```ts
await supabase.from('tickets').update({
  attachments: [...currentAttachments, newAttachment],
  last_modified: now,
  history: [...currentHistory, historyEntry],
}).eq('id', ticketId);
```

**Failure scenario.** Three distinct failures from one defect:

1. **Authority.** Any `Drafter` in the org attaches a file typed `Draft` to any
   ticket. That single write flips
   `ticket.attachments?.some(a => a.type === 'Draft')` → `submit_draft` becomes
   available to them via org-wide `ticket.draft_work` (`WF-8`). **Two
   unprivileged HTTP calls take someone else's ticket from `DRAFTING` to
   `PENDING_REVIEW` with a foreign file as the deliverable.**
2. **Race.** The drafter uploads while the requester approves. The upload writes
   `{attachments, history, last_modified}` with no CAS; the workflow route's CAS
   then 409s — or lands first and is silently clobbered by the upload's stale
   arrays, losing the approval's history entry.
3. **Denial.** The assigned drafter whose headline role is `Engineer-2` or
   `DocCtrl` (`WF-7`) sees **no upload button at all** on their own assigned
   ticket.

**Chain reaction.** `history` is the audit surface the ticket page renders;
`attachments` is what `submit_final` / `ticket-shed` / `verify-ticket` treat as
the deliverable. The `last_modified` clobbering also comes from the bulk "mark
urgent" action at `app/(protected)/requests/page.tsx:620,638`, producing
intermittent unexplained 409s during approval.

**Done when.**
1. Adding or removing an attachment goes through the same authority evaluation
   and compare-and-set as every other ticket transition.
2. The upload affordance is derived from available actions, not a hardcoded role
   list.
3. A concurrent upload and approval cannot lose either party's history entry.

---

## WF-10 · The 60-second policy cache is never invalidated on the server — a revoked person keeps acting

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED (currently masked by `WF-1`)
- **Blast radius:** security
- **Locations:**
  - `lib/capabilityPolicy.ts:159-196` — module-level `cache`, `CACHE_TTL_MS = 60_000`
  - `lib/capabilityPolicy.ts:235` — `cache.delete(input.orgId)`, inside `saveCapabilityPolicy`
  - `app/api/tickets/workflow-action/route.ts:95` — the server reader
  - `components/permissions/CapabilityPolicyEditor.tsx:85`, `components/permissions/ViewAsSimulator.tsx:77`
- **Related:** `WF-1`, `WF-11`, `WF-16`
- **Re-verified:** hardening pass — **SURVIVES**. `CACHE_TTL_MS = 60_000` over a module-level `Map` (`capabilityPolicy.ts:159-160`); `cache.delete(input.orgId)` (`:235`) clears only the instance that made the change. Every other serverless instance keeps the stale policy until its own TTL expires.

**Mechanism.** `saveCapabilityPolicy` / `addUserGrant` / `revokeUserGrant` are
called exclusively from `"use client"` components. `cache.delete` therefore
clears the **browser bundle's** Map. The Node/serverless module instance that
`/api/tickets/workflow-action` imports has its **own** `cache` and receives no
invalidation signal at all — it expires only by TTL, per instance.

**Failure scenario.** An engineer is walked out. The admin revokes their standing
`ticket.direct_approve` grant at 09:00:00 and the UI confirms instantly. The
revoked user's session posts `approve_draft_ifc` at 09:00:20; the route's warm
instance still holds the pre-revocation policy and **approves the drawing**.
With N warm serverless instances the window is up to 60 seconds *each*,
staggered — and an instance that goes cold and warm re-reads fresh, so the
behaviour is nondeterministic and unreproducible from the audit log.

**Cache-poisoning variant (SUSPECTED — guard it anyway).**
`loadCapabilityPolicy(orgId)` with no `client` argument uses the shared browser
`supabase` singleton. If any server-executed path ever calls it without
`supabaseAdmin`, it runs sessionless → RLS returns nothing → `{caps:{},
grants:[]}` is **cached in the server process for 60 seconds**, silently
disabling every per-person grant org-wide. Today every server caller passes the
admin client, so this is latent — but nothing in the signature prevents it.

**Chain reaction.** Once `WF-1` is fixed and orgs actually edit their policy,
this becomes the difference between "revoked" and "revoked, mostly." It also
negates `CapabilityPolicyEditor`'s promise: *"Saved — enforced server-side on
the next action."*

**Done when.**
1. A revocation takes effect on the next server-side authority decision.
2. `loadCapabilityPolicy` never caches a result whose read errored.
3. A sessionless read cannot poison the server cache with an empty policy.

---

## WF-11 · Policy guardrails are client-side only — a DocCtrl can rewrite the policy and self-grant `ticket.manage`

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security
- **Locations:**
  - `lib/capabilityPolicy.ts:201-217` — `validateCapabilityPolicy`, called at `:225`, **in the browser**
  - `lib/capabilityPolicy.ts:254-276` — `addUserGrant`
  - `supabase/migrations/20260831_capability_policy_and_rails.sql:31` — the DB policy gates the **key**, never the **content**
  - `app/(protected)/admin/permissions/page.tsx:35,58` — the UI gate
- **Related:** `WF-1`, `WF-10`, `WF-16`, `ADD-1`
- **Re-verified:** hardening pass — **SURVIVES**. `validateCapabilityPolicy` is a pure TypeScript function (`capabilityPolicy.ts:201-212`) and `addUserGrant` reads-modifies-writes with no server-side re-validation (`:254-265`). Note the interaction with `WF-1`/`DB-1`: while the policy column name is wrong the whole layer is inert, so this becomes live the moment that is fixed — sequence accordingly.

**Mechanism.** The database restricts *which key* may be written:

```sql
CREATE POLICY org_config_cap_policy_update ON org_configurations
  AS RESTRICTIVE FOR UPDATE
  USING (key <> 'capability_policy' OR is_org_controller(org_id)) …
```

The "Admin can never lose a critical capability" rail runs only in
`saveCapabilityPolicy`, in the browser. A direct
`PATCH /rest/v1/org_configurations?…&key=eq.capability_policy` satisfies the DB
policy and skips validation **and** the `audit_logs` insert. Separately,
`validateCapabilityPolicy` checks `critical` only for `policy.caps` — it never
inspects `policy.grants`.

**Failure scenario.** Three variants, all reachable:

- A DocCtrl PATCHes
  `{"caps":{"ticket.reassign_engineer":["DocCtrl"],"ticket.force_close":["DocCtrl"],"ticket.manage":["DocCtrl"]}}`.
  Admin is removed from three critical capabilities, with no audit row and no
  impact preview.
- **Entirely through the supported UI:** the same DocCtrl opens
  `/admin/permissions`, selects themselves in "View as…", and grants themselves
  **`ticket.manage`** with no expiry. `validateCapabilityPolicy` permits it. They
  hold management override on every ticket in the org — permanently, additively,
  from a screen labelled "Personal permissions."
- **Inverse UI/DB drift:** a member with `roles = ["Manager","DocCtrl"]` has
  headline `Manager`, so `canEdit` is false and the UI is read-only — but
  `is_org_controller` is additive-aware and lets them PATCH the row directly.

**Chain reaction.** Grants ride the same evaluator as roles, so a self-granted
`ticket.manage` unlocks `isManagement` at `lib/workflow.ts:67` — co-approve at
every review stage, override assigned reviewers, force-close — plus `holds.*`
and, once `WF-1` is fixed, `checkout.force_release` at the database.

**Done when.**
1. `validateCapabilityPolicy` runs server-side with the service-role client on
   every policy and grant write.
2. Critical capabilities require Admin, not merely controller.
3. A self-grant of a critical capability is refused.
4. Every policy change writes an audit row that a direct PATCH cannot skip.

---

## WF-12 · `requiresEngineerApproval` reads an undocumented role SNAPSHOT that survives demotion

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety
- **Locations:**
  - `lib/workflow.ts:78` — `const needsEngineerApproval = requiresEngineerApproval(ticket.requesterRole);`
  - `lib/workflow.ts:30-43` — the doc comment describes the rule but never the word "snapshot"
  - stamped at `app/(protected)/requests/new/page.tsx:309`; read at `lib/ticketTransitions.ts:65`
  - `types/schema.ts:1120` — documented only as `requesterRole?: Role`
- **Related:** `WF-5`
- **Re-verified:** hardening pass — **SURVIVES**. `requiresEngineerApproval(ticket.requesterRole)` (`workflow.ts:78`) reads the value stamped at INSERT (`WF-5`), so a demotion never reaches a ticket already in flight.

**Mechanism.** The value is frozen at INSERT time, never refreshed, and never
compared to `org_members.role`. The *current* role is consulted too, but only in
one direction: `if (needsEngineerApproval && !isEng)`. **So a stale-high snapshot
short-circuits before the current role is ever examined.**

**Failure scenario.** A Manager files 30 requests. Three months later they move
to Operations and are demoted to `Requester`. Every one of those 30 open tickets
still carries `requester_role = 'Manager'` → `needsEngineerApproval` is false →
they reach `PENDING_REVIEW` and are offered **"Approve (Issue for
Construction)"** as a plain Requester. Conversely a promoted engineer's old
tickets still say `Requester`, but the `!isEng` clause rescues them — the
asymmetry means **the snapshot only ever fails open.**

**Chain reaction.** Switching to a live lookup changes behaviour on every
in-flight ticket at once — some will suddenly demand an engineer. That needs a
migration window plus a one-time reconciliation report. The cheaper, safer
change is to make the asymmetry fail *closed* rather than open.

**Done when.**
1. A demoted requester's in-flight tickets no longer bypass the engineer gate.
2. Whichever rule is chosen is documented at `types/schema.ts:1120` and in the
   `lib/workflow.ts:30-36` comment block, which today reads as if the value were
   live.

---

## WF-13 · What the capability policy structurally cannot express

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** model-complexity / scaling
- **Locations:**
  - `lib/capabilityPolicy.ts:26-96` — the id list and defaults
  - `lib/capabilityPolicy.ts:112-117` — the `CapabilityPolicy` shape
  - `lib/capabilityPolicy.ts:141-155` — `policyAllows(policy, cap, role, extraRoles, uid)` — **no resource argument**
- **Related:** `WF-8`, `DRAFT-1`, `GAP-1`
- **Re-verified:** hardening pass — **SURVIVES**, by type definition. `CapabilityPolicy` is `{ caps?: Partial<Record<CapabilityId, string[]>>; grants?: UserGrant[] }` (`capabilityPolicy.ts:112-117`) — no ticket, library, project or document dimension exists in the shape, so per-scope authority is unrepresentable rather than merely unimplemented.

**Mechanism.** The policy is a flat `capability → role-token[]` map plus
per-person grants, with no resource dimension. Consequently none of these are
representable:

| Requirement | Why it cannot be expressed | What the workflow actually does today |
|---|---|---|
| **The engineer-approval gate itself** | `requiresEngineerApproval` is hardcoded and consults **no** capability | An org that removes `Manager` from `ticket.manage` *still* lets Manager requesters self-approve |
| Per-request-type authority ("ASBUILT needs DocCtrl") | no `RequestType` dimension | `requestType` gates exactly one action, `close_rfi` (`WF-15`) |
| Per-discipline reviewers | `roleTokenMatches` is a string compare; `"Engineer"` matches every tier, and the tiers are explicitly "a labeling convention" | any Engineer can approve anything |
| Per-library / per-unit scoping | the capability layer is disjoint from the ACL layer | `ticket.direct_approve` is global |
| Quorum / two-person rule | boolean evaluator, no counting, no state | `WF-4` |
| Delegation **chains** | `UserGrant` has `grantedBy` but no transitivity; only Admin/DocCtrl can write grants | grants are flat, admin-issued |
| Time-boxed *role* changes | `expiresAt` exists on grants but not on `caps` | role edits are permanent until edited back |
| Negative grants / suspension | "ADDITIVE ONLY … never reduce" | you cannot revoke below a role's floor |
| Ticket-scoped authority | no resource parameter | `WF-8` |

**Failure scenario.** A plant wants "instrumentation drawings must be signed by
an I&C engineer, and never by the person who drew them." **There is no way to
say either half.** The nearest approximation — narrowing `ticket.direct_approve`
to `Engineer` — is already the default and blocks nothing, because `WF-3` and
`WF-4` route around it.

**Chain reaction.** ⚠ Adding a resource dimension to `policyAllows` is a
signature change touching `lib/workflow.ts:65`, `lib/holds.ts:100`,
`components/permissions/ViewAsSimulator.tsx:128`, and the SQL
`org_capability_allows` — **all four must move together or `WF-7`'s divergence
gets worse.** This is architecture, not a bug fix. See `GAP-1`. What *is* in
scope as a finding: the gate at `lib/workflow.ts:37-43` being hardcoded while the
UI presents the capability grid as the place authority is configured.

**`DEC-13` settles it: build the resource dimension, staged.** Stage 1 is
`WF-15` (validate `request_type` — authority keyed to unvalidated free text is a
hole, not a feature). Stage 2 widens the signature to
`policyAllows(policy, cap, subject, resource?)` with `caps` entries gaining an
optional `when` clause, so an absent `when` behaves exactly as today. Stage 3
makes the hardcoded engineer gate a real capability. Full spec: `GAP-1`.

**Done when.**
1. An org can express "ASBUILT may only be approved by DocCtrl" and it is
   enforced in `getActions`, re-enforced in the route, and honoured by
   `org_capability_allows`.
2. An org that has configured no `when` clause behaves byte-identically to today.
3. All four call sites move together, and the simulator agrees with the route.

---

## WF-14 · No separation of duties on engineer picks — the requester can nominate themselves as their own reviewer

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety
- **Locations:**
  - `app/api/tickets/workflow-action/route.ts:113-132` — the only constraint on a picked engineer
  - `components/requests/EngineerPickerModal.tsx:74-99` — lists every active engineer **including the current user**
  - `lib/workflow.ts:265-267` — `isAssignedEngineerIdentity`
- **Related:** `WF-3`, `WF-4`, `WF-7`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. The route confirms the nominated engineer is an active member of the org (`workflow-action/route.ts:113-121`) and applies **no test that they differ from the requester or the drafter**.

**Mechanism.** The route checks that the nominee holds *an* Engineer role. It
does **not** check that they are not `ticket.requesterId`, not
`ticket.assignedDrafterId`, and not the caller. `assignment.id` gets no role
check at all.

**Failure scenario.** A DraftingSupervisor holding
`roles = ["DraftingSupervisor","Engineer-3"]` has headline `DraftingSupervisor`
(rank 75 > 64). `requiresEngineerApproval("DraftingSupervisor")` → **true**
(because `isManagementRole` omits DraftingSupervisor), and `isEng` is false
because only the headline is consulted (`WF-7`). So they are forced down the
"Send for Engineer Final Approval" path — and the picker offers them
**themselves**, which the server accepts because `roles` contains `Engineer-3`.
They approve their own ticket via `isAssignedEngineerIdentity`. **The audit trail
shows a textbook two-stage engineering sign-off performed by one person.**

**Chain reaction.** This is the fallback hole that opens the moment `WF-3` is
closed. **Fix them together or the `WF-3` remediation is a no-op.**

**Done when.**
1. A picked engineer cannot be the ticket's requester, its assigned drafter, or
   the caller.
2. `EngineerPickerModal` excludes those uids with an explanatory empty state.
3. The mirror rule applies to `assignment.id`, and the assignee must satisfy
   `ticket.draft_work`.

---

## WF-15 · `RequestType` is an open `string`, unvalidated, and gates a terminal transition

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / process
- **Locations:**
  - `types/schema.ts:1019` — `export type RequestType = string;`
  - `lib/workflow.ts:185` — `if (ticket.requestType === 'RFI') { … close_rfi … }` — **the one authority use in the entire codebase**
  - `lib/ticketTransitions.ts:285-287`
  - config source `app/(protected)/admin/requests/page.tsx:179-195` — a **UI dropdown only**, no server or DB validation
  - the three programmatic creators bypass it entirely with hardcoded `"Revision"` / `"ASBUILT"`
- **Related:** `DRAFT-1`, `WF-8`, `WF-13`
- **Re-verified:** hardening pass — **SURVIVES**. `RequestType` is an unconstrained `string` (`types/schema.ts:1019`) and gates the one-click `close_rfi` terminal transition (`workflow.ts:185-192`). Same substrate as `drafting-flow/TIER-2` and `LEAK-3`.

**Mechanism.** Every other use of `requestType` is cosmetic or advisory: SLA
default days, a badge, an "urgent" heuristic, a filter dropdown. The single
gating use is the RFI branch — and `close_rfi` is the **only `DRAFTING → CLOSED`
edge in the machine.**

**Failure scenario.** Any member creates (or PATCHes, per `WF-2`) a ticket with
`request_type: "RFI"`. It routes normally to `PENDING_ASSIGNMENT` → `DRAFTING`.
Now **any** `Drafter` in the org (`WF-8`) sees "Answer & Close RFI" and moves it
`DRAFTING → CLOSED` in one click — skipping `PENDING_REVIEW`, `PENDING_IFC`,
`FINAL_DRAFT`, every approval, and every deliverable-rev assignment. A drawing
revision closes as if it were a question, with `closed_at` stamped and archive
eligibility running.

**Chain reaction.** Making `RequestType` a union breaks the free-text
`"ASBUILT"` / `"Revision"` writers and any org that renamed the option values.
The narrower fix is to validate against the org's configured list at insert and
re-derive the RFI branch from a per-type config flag rather than a magic
constant.

**Done when.** A ticket cannot be created with a `request_type` outside the
org's configured list, and the close-without-review behaviour is a property of
the configured type rather than a hardcoded string comparison.

---

## WF-16 · `UserGrant`s — no audit of grant *use*, no cleanup of expired grants, no scoping

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** compliance / access-control
- **Locations:**
  - `lib/capabilityPolicy.ts:98-110`, `:134-137`, `:151-153`, `:254-276`, `:296-299`
  - UI at `components/permissions/ViewAsSimulator.tsx:192-227`
  - audit write at `app/api/tickets/workflow-action/route.ts:214-223`
- **Related:** `WF-10`, `WF-11`
- **Re-verified:** hardening pass — **SURVIVES**, by census. **0** audit rows record a grant being *used*, and **0** code paths prune an expired grant — `grantActive` filters at read time only, so expired grants accumulate in the stored policy forever.

**Mechanism.** Point by point:

- **Expiry enforced on read?** Yes, correctly and **fail-closed** — an
  unparseable date yields `NaN > n` → `false`, and the SQL mirror matches. This
  part is good.
- **Expired grants cleaned up?** **No.** `addUserGrant` filters only the same
  `(uid, cap)` pair; `grantsForUser` deliberately returns expired ones. The
  `grants` array grows without bound inside a single JSONB blob that is
  read-modify-written on every change — and since `loadCapabilityPolicy` is
  cached 60 s (`WF-10`), **two concurrent grants lose one of the two.**
- **Audit of grant *use*?** **No.** The audit row records `user_role` but never
  *why* the action was permitted. There is no way to tell from the log whether an
  approval came from a role or from a temporary delegation.
- **Scoping?** None — a grant of `ticket.direct_approve` applies to every ticket
  in the org, forever if `expiresAt` is null.

**Failure scenario.** An engineer goes on leave; their `ticket.final_approve` is
delegated to a colleague "until the 14th." On the 15th the grant is dead but
still in the array. Six months and forty delegations later, the blob holds 40
dead entries, the UI list is unreadable, and an auditor asking *"who was
authorised to approve DWG-4471 on March 3rd?"* must diff every
`CAPABILITY_POLICY_CHANGED` row by hand — and the ticket's own audit row will not
say a delegation was used.

**Done when.**
1. `audit_logs` records *why* an action was permitted (role versus grant).
2. Two concurrent grant writes cannot lose one another.
3. Expired grants are prunable and the pruning is itself audited.

---

## WF-17 · Dead statuses, dead capabilities, dead code paths

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** model-complexity
- **Re-verified:** hardening pass — **SURVIVES**. Confirmed alongside the other census findings in this area: dead capabilities (`admin.analytics_view`, `admin.archive_view` — `WF-20`), dead code (`canBlindDrillAccess` — `OWN-21`), dead columns (`outcome_ref` — `LIFE-10`, `inapp_enabled`/`push_enabled` — `drafting-flow/EDGE-14`) and dead SLA machinery (`drafting-flow/EDGE-7`).

> **Dispositions are settled in `DEC-14` and `DEC-11`.** `CANCELED` gets
> implemented — it is documented to users as a real state and no action produces
> it. `NEW` and `PENDING_ENG_INITIAL` get removed. The three dormant capabilities
> are kept and visibly marked.

| Dead thing | Location | Why it is unreachable |
|---|---|---|
| `NEW`, `PENDING_ENG_INITIAL` | `lib/workflow.ts:82-109` | `getInitialStatus` always returns `PENDING_ASSIGNMENT`; all three creators set status explicitly |
| `CANCELED` | `types/schema.ts:1032`, `lib/ticketTransitions.ts:305` | **No action anywhere produces it** — yet `components/requests/WorkflowDiagramModal.tsx:36` documents it to users as a real state |
| `ticket.initial_review` | `lib/capabilityPolicy.ts:61-62` | its two statuses are unreachable |
| `ticket.eng_review` | `lib/capabilityPolicy.ts:63-65` | only consulted when `assignedEngineerId` is null; `request_eng_review` always sets one |
| `ticket.final_approve` | `lib/capabilityPolicy.ts:76-78` | same — `request_final_engineer_approval` always assigns |
| `resolveTicketRecipients` PENDING_ENG_INITIAL branch | `lib/ticketRouting.ts:98-100` | status unreachable |
| `approve_initial` client path | `app/(protected)/requests/[id]/page.tsx:1099-1105` | the client rewrites the action to `'assign'`, which `getActions` never offers at `NEW` → guaranteed 403 |
| `metadata.minor_correction` | `components/documents/CheckInPanel.tsx:266` | written, never read |

**Failure scenario.** An admin unchecks every token on `ticket.eng_review`
believing they have locked down engineering review, and **nothing changes** —
the real gate at `PENDING_ENG_TEAM` is `isAssignedEngineerIdentity ||
isManagement`. **Three of the twelve ticket capabilities in the editor grid are
decorative** — precisely the failure mode that
`app/(protected)/admin/permissions/page.tsx:12-16` says was removed for being
"worse than none."

**Done when.** Per `DEC-14` and `DEC-11`:

1. A requester can cancel their own open request with a reason, from
   `PENDING_ASSIGNMENT` or `DRAFTING`; the cancellation is audited.
2. `NEW` and `PENDING_ENG_INITIAL` are gone from `types/schema.ts`,
   `WorkflowDiagramModal`, `lib/ticketRouting.ts:98-100` and
   `lib/ticketAttention.ts:100-102`. Any existing rows in those statuses were
   found and migrated to `PENDING_ASSIGNMENT`, and the count is recorded.
3. `ticket.initial_review`, `ticket.eng_review` and `ticket.final_approve` carry
   `dormant: true` and render greyed with a tooltip — not as live controls.
4. `approve_initial`'s dead client path and `metadata.minor_correction` have
   their recorded dispositions.

---

## WF-18 · The "Reassign" button always 403s

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability / ux
- **Locations:**
  - `app/(protected)/requests/[id]/page.tsx:843-847` — the handler
  - `app/(protected)/requests/[id]/page.tsx:1596-1602` — the render condition
  - `lib/workflow.ts:137-163` — `assign` is offered **only** at `PENDING_ASSIGNMENT`
- **Related:** `WF-2`, `WF-22`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. No `reassign` action exists anywhere in `lib/` — the workflow engine never emits one — so a post of that action type falls through to the "not available to you" rejection at `workflow-action/route.ts:98-101`, while the UI renders a full Reassign modal (`requests/[id]/page.tsx:231, 265-271`).

**Mechanism.** The render condition requires `assignedDrafterId` to be set —
which only happens *after* the ticket has left `PENDING_ASSIGNMENT`, the one
status where `assign` is offered. The route's `allowed.find(...)` therefore never
matches: *`Action "assign" is not available to you at status DRAFTING`* → 403.

**Failure scenario.** A drafter quits mid-job. The admin opens the ticket, clicks
Reassign, picks a replacement, and gets a red toast. **There is no supported way
to move a ticket to a different drafter once assigned** — the workaround is a raw
PATCH (`WF-2`), which produces no audit row and no notification to the new
assignee. A DocCtrl gets the button too but `ticket.assign` defaults to
management + DraftingSupervisor, so they would fail twice over.

**Done when.** An authorized user can reassign a ticket's drafter after
assignment, the new assignee is notified, and the change is audited.

---

## WF-19 · Notification dead ends — nobody is told when a ticket (re-)enters the assignment queue

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability / process
- **Locations:**
  - `lib/ticketTransitions.ts:140-142` — the default recipient set for **every** action
  - `lib/ticketTransitions.ts:176`, `:190` — the two transitions targeting `PENDING_ASSIGNMENT` leave `unread_by` untouched
  - `lib/ticketRouting.ts:70-117` — `resolveTicketRecipients`, **never imported by the workflow route**
  - `app/api/tickets/workflow-action/route.ts:283-291` — the drain call
- **Related:** `ADD-*`, `LIFE-7`
- **Re-verified:** hardening pass — **SURVIVES**. Routing is resolved once at creation (`LEAK-1`), so a ticket returning to `PENDING_ASSIGNMENT` notifies nobody.

**Mechanism.** `fanOut` notifies exactly
`[ticket.requesterId, ticket.assignedDrafterId]`. The module that exists
*specifically* to answer "PENDING_ASSIGNMENT → DraftingSupervisor, falling back
to Admins" is called only on initial creation.

**Failure scenario.** An engineer completes scope review and clicks "Engineering
Review Complete." The ticket lands in `PENDING_ASSIGNMENT`. The
DraftingSupervisor is notified only if they happened to be the requester or a
prior watcher. **Tickets stall silently after every engineering-review
round-trip.**

**Two secondary dead paths, both worth fixing with it:**

- `resolveTicketRecipients` matches on the **headline** role
  (`lib/ticketRouting.ts:79,91,99`): a member with
  `roles = ["Manager","DraftingSupervisor"]` has headline `Manager`, so
  `byRole("DraftingSupervisor")` is empty → the branch silently falls back to
  Admins and **the actual supervisor is never notified.**
- The post-action drain sends
  `Authorization: 'Bearer ' + (process.env.CRON_SECRET || "")`. With
  `CRON_SECRET` unset — **it ships blank** (`.env.example:18`) — the token is
  `""`, `authorized` stays false, and the drain returns **401**. Every workflow
  email waits for the daily cron instead of arriving in seconds.

**Chain reaction.** `unread_by` is simultaneously the notification recipient
list, the unread badge, and (unioned with `watchers`) the follow list — one field
with three jobs, so widening recipients also changes the unread UI.

**Done when.**
1. A ticket entering a queue state notifies whoever the routing policy names.
2. Routing matches against the full role collection, not the headline.
3. The post-action email drain succeeds in a default deployment.

---

## WF-20 · `admin.analytics_view` / `admin.archive_view` are UI-only, fail open, and ignore per-person grants

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `app/(protected)/admin/analytics/page.tsx:88-98`, `:113-125`
  - `app/(protected)/admin/archive-view/page.tsx:22-26`
  - defaults at `lib/capabilityPolicy.ts:92-95`
- **Related:** `WF-2`, `SURF-1`
- **Re-verified:** hardening pass — **SURVIVES**, by census. `admin.analytics_view` appears **0** times anywhere under `app/api/` — the capability is checked in the page component and nowhere on the server.

**Mechanism.** Three problems in four lines:

```ts
void import("@/lib/capabilityPolicy").then(async ({ loadCapabilityPolicy, policyAllows }) => {
  const p = await loadCapabilityPolicy(activeOrgId);
  if (alive) setAllowed(policyAllows(p, "admin.analytics_view", activeRole));
}).catch(() => { if (alive) setAllowed(true); });   // ← fails OPEN
```

1. The check is client state — the data fetch runs
   `supabase.from('tickets').select('*')` against the user's own session, which
   `tickets_org_access` (`WF-2`) permits for **every** member regardless of the
   flag.
2. `policyAllows` is called **without `uid`**, so the grants branch can never
   fire — delegating `admin.analytics_view` to a person is silently a no-op.
3. The `.catch` grants access on failure.

**Failure scenario.** An admin narrows `admin.analytics_view` to `["Admin"]` to
keep drafter-performance metrics private. A Contractor opens `/admin/analytics`,
sees the gate, and simply reads the same data from
`/rest/v1/tickets?org_id=eq.…&select=*` — every ticket, every comment, every
history entry, every requester.

**Chain reaction.** The page header comment explicitly says *"nav hiding is not
a permission model"* — the fix introduced the same class of problem one layer up.
Both capabilities become meaningful only once `WF-2` narrows the `tickets` SELECT
policy or the data moves behind a service-role route.

**Done when.** Narrowing the capability actually restricts the data, the
`.catch` fails closed, and a per-person grant of the capability works.

---

## WF-21 · `reopen_ticket` re-issues a duplicate deliverable revision, and `/verify-ticket` reports it as current

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** safety / data-integrity
- **Locations:**
  - `lib/ticketTransitions.ts:288-290` — `reopen_ticket` resets nothing
  - `lib/ticketTransitions.ts:86-107` — `draftRevLabel` / `issuedRevLabel`
  - `lib/workflow.ts:331-341` — who may reopen
  - `app/api/verify-ticket/route.ts:59-85`
- **Related:** `WF-8`
- **Re-verified:** hardening pass — **SURVIVES**. `deliverable_rev = issuedRevLabel(ticket.revisionCount)` at three sites (`ticketTransitions.ts:223, 232, 250`), and `/api/verify-ticket` computes its verdict with no status term at all (`drafting-flow/EDGE-2`). Same defect from two directions.

**Mechanism.** `reopen_ticket` sets `status = "PENDING_REVIEW"` and nothing else.
`issuedRevLabel` is a pure function of `revision_count`, which reopen does not
touch.

**Failure scenario.** DWG-1180 is approved and issued at **Rev 2**, closed, and
the package is distributed. A month later the requester reopens it (allowed to
any `Requester`, per `WF-8`) to attach a missed detail. Status →
`PENDING_REVIEW` with `deliverable_rev` still `"2"` and `revision_count`
unchanged. They approve again → `issuedRevLabel` returns `"2"` a second time.
**Two materially different construction packages now both carry "Rev 2."**

Meanwhile the public QR endpoint reads the reopened ticket:
`deliverable_rev = "2"`, `isIssued("2")` → true → `latestIssued = "2"` — so a
field copy printed "2" verifies as **"current"** *while the drawing is actively
back under review*. That endpoint's entire purpose is "is this still the latest
issue?"

**Related, same file:** `approve_minor_correction` at
`PENDING_FINAL_APPROVAL` sets `PENDING_IFC` and the issued rev but — unlike
`engineer_approve_final` — never writes `engineer_approved_at`. The ticket page's
engineering-sign-off dot stays "pending" forever on a ticket the engineer *did*
approve.

**Chain reaction.** `deliverable_rev` is stamped onto printed travelers, the file
viewer header, and the QR payload.

**`DEC-15` settles it: a reopen starts a new cycle.** Increment
`revision_count`, reset `draft_iteration` to 0, null `deliverable_rev`, so the
next submission is `3A` and the next approval `3`. Barring reopen after issue is
cleaner in theory and worse in practice — it pushes people to a raw PATCH
(`WF-2`), which produces no audit row at all. Renumbering is the honest outcome.

Ship with it: `approve_minor_correction` at `PENDING_FINAL_APPROVAL` must also
write `engineer_approved_at`, or the sign-off indicator stays "pending" forever
on a ticket the engineer did approve.

**Done when.** Two approvals of the same ticket cannot produce the same issued
revision label, and a ticket back under review does not verify as current.

---

## WF-22 · `assign` with a missing assignment is a silent no-op that still writes an audit row

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity / compliance
- **Locations:**
  - `lib/ticketTransitions.ts:192-200` — `if (input.assignment) { … }` with **no else**
  - `app/api/tickets/workflow-action/route.ts:104-109` — no `assignment` precondition check
  - `app/api/tickets/workflow-action/route.ts:214-223` — the audit write
- **Related:** `WF-6`, `WF-18`
- **Re-verified:** hardening pass — **SURVIVES**. The assign path writes the audit row on the same unchecked-update pattern counted in `OWN-14` — a refused write leaves the audit claiming the assignment happened.

**Mechanism.** With `assignment` omitted, `newStatus` falls back to
`ticket.status`, the compare-and-set succeeds (because `last_modified` did
change), and the route writes `TICKET_ASSIGN` to `audit_logs` with
`details: {from: "PENDING_ASSIGNMENT", to: "PENDING_ASSIGNMENT"}` and returns
`{ok: true}`.

**Failure scenario.** A retry, a race, or a crafted request produces a green
"success" and an `audit_logs` row named `TICKET_ASSIGN` for a ticket nobody was
assigned to. **An auditor reconstructing custody from `audit_logs` sees an
assignment event with no assignee.** `self_assign` has the same shape.

**Done when.** A transition that requires an input is refused when the input is
missing, rather than producing an empty transition and a success audit row.

---

## WF-23 · SQL and TypeScript disagree on capability defaults — every `ticket.*` capability defaults to DENY in Postgres

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** availability
- **Locations:**
  - `supabase/migrations/20260901_db_hard_enforcement.sql:50-57` — the DB fallback table
  - `lib/capabilityPolicy.ts:57-96`, `:119-125` — the TypeScript `DEFAULTS`
- **Related:** `WF-1`, `WF-2`, `DB-1`
- **Re-verified:** hardening pass — **SURVIVES**, by absence, which is the strongest form of it: **no `ticket.*` capability default exists in SQL at all**. `DEFAULTS` lives only in `lib/capabilityPolicy.ts`, so the database and the application cannot agree — the database has no opinion to compare.

**Mechanism.** The database's fallback knows only three capabilities:

```sql
v_tokens := CASE p_cap
  WHEN 'holds.open'             THEN '["*"]'::jsonb
  WHEN 'holds.release'          THEN '["*"]'::jsonb
  WHEN 'checkout.force_release' THEN '["Admin","DocCtrl"]'::jsonb
  ELSE '[]'::jsonb            -- ← all 12 ticket.* caps + both admin.* caps
END;
```

TypeScript's `DEFAULTS` is generated from all 17 `CAPABILITY_DEFS`. The two
tables are maintained independently, with no shared source and no test comparing
them.

**Failure scenario.** Latent today. **The moment `WF-2` is remediated**, the
obvious fix is a `tickets` UPDATE policy calling
`org_capability_allows(org_id, 'ticket.assign', auth.uid())` — which, for every
org that has never opened the permissions editor (i.e. the common case, and
*every* org while `WF-1` stands), evaluates `'[]'` and **denies everyone
including Admins.** The app would appear to lock itself out with no error anyone
can trace to this `CASE`.

**Chain reaction.** `WF-1` and this compound: with the column missing, `v_val` is
never even reached, and the `ELSE '[]'` branch is the only outcome for anything
but the three named capabilities. **Read this before implementing `WF-2`.**

**Done when.** The SQL fallback and the TypeScript `DEFAULTS` agree for every id
in `CapabilityId`, verified by a test rather than by inspection.

---

## WF-24 · Attention feed and workflow engine disagree about who must act

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `lib/ticketAttention.ts:22` — `["Admin","Manager","Supervisor","DraftingSupervisor"]` — **includes** DraftingSupervisor
  - `lib/workflow.ts:23` — `Admin || Manager || Supervisor` — **excludes** it
  - `lib/capabilityPolicy.ts:55` — `const MGMT = ["Admin","Manager","Supervisor"]` — **excludes** it
- **Related:** `WF-7`, `WF-14`
- **Re-verified:** hardening pass — **SURVIVES**. Same evidence as `drafting-flow/FRIC-7` and `UI-3` — `ticketAttention.ts:106-108` against `workflow.ts:301-312`.

**Mechanism.** Three definitions of "management." `isActionRequired` returns true
for a DraftingSupervisor at `PENDING_REVIEW` and `PENDING_FINAL_APPROVAL`, but
`getActions` offers them nothing at either state.

**Failure scenario.** A DraftingSupervisor's sidebar badge shows 14 items. They
open each one and see "**View Only — No Actions Available**." The badge never
clears because it is derived from role + status, not from `getActions`. **Users
learn to ignore the badge — which then hides the real work.**

**Chain reaction.** `useTicketNotifications` feeds the sidebar badge, the header
bell and `/inbox`. Aligning the definitions changes all three counts at once.

**Done when.** The attention badge and the ticket page agree for every
role/status combination — ideally because attention is derived from the engine
rather than from a parallel table.

---

## Verified sound — do not break

1. **Compare-and-set on `(status, last_modified)`** —
   `app/api/tickets/workflow-action/route.ts:155-191`. The comment at `:151-154`
   documents exactly why status alone was insufficient. The 409 is surfaced with
   a real recovery message. **Keep the `last_modified` leg.**
2. **Archived-ticket guard before any action** — prevents resurrecting shed
   content into an inconsistent state.
3. **Engineer picks are validated against `roles` OR `role`, and must be active
   members of the ticket's org** — `route.ts:113-132`. This is the one place the
   additive model is honoured correctly on the server, and it is cross-org safe.
   It needs the *additional* self/drafter exclusion from `WF-14` — **do not
   remove what is there.**
4. **Identity rights are non-configurable** — `lib/workflow.ts:69-75`. A ticket's
   requester, drafter or engineer can never be locked out of their own ticket by
   a policy edit. Correct call, frozen by a test.
5. **Server-written audit on every transition** — unskippable by a closed tab or
   a tampered client. Add the authority-reason field from `WF-16`; **do not move
   it back to the client.**
6. **Atomic comment posting via the `post_ticket_comment` RPC with a
   correctly-narrow fallback** — the `PGRST202`-only fallback condition is
   exactly right: a real exception inside the function surfaces instead of being
   swallowed into the legacy path.
7. **Stale workflow-notification supersession** — retires unread rows carrying
   `metadata.action` while deliberately leaving comment and mention rows alone.
   Subtle and correct.
8. **Grant expiry is fail-closed** — `NaN` comparison yields `false`; a malformed
   expiry disables the grant rather than making it eternal. The SQL mirror
   matches.
9. **`loadCapabilityPolicy` tolerates both stored shapes and hard-filters unknown
   ids** — legacy flat and canonical shapes both parse; unknown capability ids
   and grants without a `uid` are dropped before evaluation.
10. **Pre-migration tolerance for the deliverable-rev columns** —
    `route.ts:169-184` retries without `deliverable_rev` / `draft_iteration` on
    `PGRST204` / `42703`, so the workflow never hard-blocks on an unapplied
    migration. **This is precisely the defensive pattern `loadCapabilityPolicy`
    lacks — see `WF-1`.**
11. **`escapeHtml` on every interpolation in the notification email body** —
    `lib/ticketTransitions.ts:378-385`.
12. **Deliverable-rev arithmetic itself** — `lib/ticketTransitions.ts:88-107`. The
    `1A → 1B → 1 → 2A → 2` scheme is correct and correctly reset. Only the reopen
    path breaks the invariant (`WF-21`); the pure functions are sound and
    unit-frozen.
