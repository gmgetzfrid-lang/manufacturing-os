# 08 · Routing, notification & attention

**14 findings** — 10 MEDIUM, 4 LOW. *(Corrected at the DF-P14 integrator fix pass, 2026-10-20: this line read "11 findings — 11 MEDIUM", stale since the verification pass lowered `ROUTE-5` / `ROUTE-6` and since `ROUTE-12`, `ROUTE-13` and `ROUTE-14` were opened.)*

Who is told what, and what goes silent. Overlaps `04-flow-leaks.md` deliberately — that report owns the leak framing, this one owns the mechanism.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded here. Severities marked by that pass override the original.


---


<a id="route-1"></a>

## ROUTE-1 · A request returned from engineering review with no drafter assigned lands in REVISION_REQ, where nobody's attention rule matches — it disappears from every queue

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P9 TICKET-PAGE (done-when 2: `attentionLabel` tells a revision with a drafter from one without) — by the integrator, 2026-10-13 (at the DF-P3 merge, DEC-31; DF-P3 named these in drafting-flow `99-fix-sequencing.md`, "Hand-offs from DF-P3"; fleet plans updated).
- **Verification:** CONFIRMED
- **Locations:** `lib/workflow.ts:126`, `lib/ticketTransitions.ts:273`, `lib/ticketAttention.ts:68`, `lib/ticketAttention.ts:79`, `lib/workflow.ts:166`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The attention/notification hole is real and reachable — no red dot for anyone AND no notification is sent at all on this transition. Two overstatements in the framing, worth recording but not enough to refute: it does not vanish from every queue (requests/page.tsx:347 gives management a 'Revision Status' card counting exactly `t.status === 'REVISION_REQ'`, :427 styles such rows as urgent, and :873 offers a 'Revisions Required' status filter), and it is not unactionable — workflow.ts:77 `canActAsDrafter = isDrafterIdentity || allows('ticket.draft_work')` lets any Drafter act on it at :167.

**Mechanism.** At PENDING_ENG_TEAM the reviewing engineer is offered "Return with Questions" whose action is `reject` (lib/workflow.ts:126-131). `computeTransition` maps `reject` to `updates.status = "REVISION_REQ"` (lib/ticketTransitions.ts:273-279) with no drafter assignment — and PENDING_ENG_TEAM is reached from PENDING_ASSIGNMENT via `request_eng_review`, i.e. BEFORE any drafter has been assigned, so `assignedDrafterId` is null. In `isActionRequired`, REVISION_REQ appears in exactly one clause: `if (ticket.assignedDrafterId === uid)` (lib/ticketAttention.ts:68-70). It is absent from the requester clause, absent from the Drafter claim-pool clause (which covers only PENDING_ASSIGNMENT, line 79), absent from the management list (lines 85-91), absent from the engineer clauses (lines 99-104) and absent from the DocCtrl clause (line 106). With a null drafter, no clause can match: the ticket is action-required for zero people. The fan-out is equally thin — `unread_by` is `[requesterId]` — and the requester is not flagged for REVISION_REQ either.

**Failure scenario.** A supervisor routes an as-built request to an engineer for scope review. The engineer returns it with questions. The ticket is now REVISION_REQ with no drafter. It shows no red dot for anyone: not the supervisor (management list omits REVISION_REQ), not the drafter pool (they only see PENDING_ASSIGNMENT), not the requester, not the engineer. The requester gets one unread flag and a bell row whose subtitle, if they ever look, reads "Drafting in progress" (attentionLabel line 122-123) — describing work that has not started and has no owner. With no SLA scan (#1) nothing ever pulls it back. The request is functionally lost while its status string still looks like active work.

**Evidence.**

lib/workflow.ts:126-131 —
```
            actions.push({
              label: 'Return with Questions',
              action: 'reject',
              variant: 'destructive',
              requiresComment: true
            });
```
lib/ticketTransitions.ts:273-279 —
```
    case "request_revision":
    case "reject":
    case "reject_final":
      updates.status = "REVISION_REQ";
      updates.revision_count = (ticket.revisionCount || 0) + 1;
      updates.draft_iteration = 0; // next submission starts the new cycle at A
      break;
```
lib/ticketAttention.ts:67-70 (the only REVISION_REQ clause) —
```
  // Personal assignments — independent of role.
  if (ticket.assignedDrafterId === uid) {
    if (status === "DRAFTING" || status === "REVISION_REQ" || status === "PENDING_IFC") return true;
  }
```

**Chain reaction.** lib/workflow.ts's REVISION_REQ case (line 166-193) is gated on `canActAsDrafter`, so any Drafter CAN act — the authority exists, only the attention rule fails to surface the ticket to them. This is a pure discoverability hole, cheap to close.

> **Verifier correction.** The attention gap is real; "disappears from every queue" is not. Three surfaces still carry it: (1) the requester is notified — unread_by = [requesterId], so fanOut runs (recipients non-empty), inserting a bell row and a queued email (app/api/tickets/workflow-action/route.ts:334-347, 375-390), and the requester's own feed query (hooks/useTicketNotifications.ts:170, `.eq('requester_id', uid)`) surfaces it as unread activity; (2) the portal gives management a REVISION_REQ count tile — app/(protected)/requests/page.tsx:347 `slot4Count = activeTickets.filter(t => t.status === 'REVISION_REQ').length` for Manager/Admin/Supervisor/DraftingSupervisor; (3) any Drafter still has live buttons on it — lib/workflow.ts:159-161 `case 'DRAFTING': case 'REVISION_REQ': if (canActAsDrafter)` where canActAsDrafter includes anyone with ticket.draft_work. So the defect is "no one is flagged action-required, and no drafter is prompted to pick it up", not invisibility.

**Done when.**

- [ ] `isActionRequired` treats REVISION_REQ with a null `assignedDrafterId` the same way it treats PENDING_ASSIGNMENT — action-required for the Drafter claim pool and for management.
- [ ] `attentionLabel` distinguishes "Drafting in progress" (has an owner) from "Revision requested — needs a drafter" (no owner).
- [ ] Either "Return with Questions" from PENDING_ENG_TEAM routes to PENDING_ASSIGNMENT rather than REVISION_REQ, or the REVISION_REQ transition fans out to the assignment role pool.
- [ ] A test asserts a REVISION_REQ ticket with `assignedDrafterId: null` is action-required for at least one role under every default-policy role.

**Partial (2026-10-13, drafting-flow Round G).** DF-P3 ROUTING, base `5378ccb`. Reproduced: `reject` from `PENDING_ENG_TEAM` (no drafter yet) set `REVISION_REQ` (`lib/ticketTransitions.ts:339-345` on the base).
- `lib/ticketTransitions.ts:173` / `:346` / `:367` — a revision with NO drafter (`reject`, `request_revision`, `reject_final`, `engineer_request_revision`) returns to `PENDING_ASSIGNMENT`; an engineering scope review is not a deliverable round, so it does not advance `revision_count`. With a drafter every revision lands in `REVISION_REQ` exactly as before.
- `lib/workflow.ts:356` — a `REVISION_REQ` or `DRAFTING` ticket with no drafter offers `assign` (not optional) to `ticket.assign` holders; assigning keeps a revision a revision (`lib/ticketTransitions.ts:275`).
- The route routes the queue on that entry (`LEAK-1`). `supabase/migrations/20261195_df_roundG_outcome_and_departure.sql` §4(b) moves the drafterless `REVISION_REQ` stragglers to `PENDING_ASSIGNMENT` with a history line and a bell row to the queue (pending paste).
- Tests: `lib/__tests__/dfRoundG_P3_routing.test.ts` ("ROUTE-1 / SM-6").

**Done-when.**
1. ✓ A drafterless `REVISION_REQ` is action-required for management (the engine's `assign`) and for the Drafter claim pool (`canActAsDrafter`) — `isActionRequired` asserted for Admin, DraftingSupervisor, Manager and a pool Drafter.
2. ✗ `attentionLabel(status)` still reads "Drafting in progress" for every `REVISION_REQ` — it takes no drafter. After this package no transition produces an ownerless `REVISION_REQ` and 20261195 moves those that exist, so the label describes an owned ticket in every path the app takes; the distinction itself is a one-line change in `lib/ticketAttention.ts`, which DF-P9 owns. **Owner: DF-P9** (`attentionLabel(status, hasDrafter)`, with GAP-108's "who it waits on").
3. ✓ "Return with Questions" from `PENDING_ENG_TEAM` routes to `PENDING_ASSIGNMENT`, and that entry fans out to the assignment pool.
4. ✓ A test asserts a drafterless `REVISION_REQ` is action-required for at least one role under the default policy (above).

**Scope / residual.** Done-when 2 → DF-P9. Pending migration: `supabase/migrations/20261195_df_roundG_outcome_and_departure.sql` (the stragglers; until it is pasted they are action-required for the queue and the drafting pool through the engine, and the paste moves them).

**Resolution (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE — done-when 2, the last open limb. `lib/ticketAttention.ts` `attentionLabel(status, { hasDrafter })` (:133): a `REVISION_REQ` known to have no drafter reads **"Revision requested — needs a drafter"** (and an ownerless `DRAFTING` / `PENDING_IFC` says it needs a drafter); with a drafter, or called without the option, the label is exactly what it was. The badge hook passes `hasDrafter` (`hooks/useTicketNotifications.ts:938`) and the ticket page's waiting line uses the same label.

**Done-when.**
1. ✓ Unchanged (DF-P3).
2. ✓ `attentionLabel` distinguishes an owned revision from one with no owner — `lib/__tests__/dfRoundG_P9_ticketPage.test.ts` "ROUTE-1 done-when 2 — a revision nobody owns is not 'in progress'"; `lib/__tests__/attentionProvider.test.ts` ("drafting-flow Round G (DF-P9) — the badge counts what the page offers") "ROUTE-1 done-when 2: a revision nobody owns says it needs a drafter, in the feed's row".
3. ✓ Unchanged (DF-P3).
4. ✓ Unchanged (DF-P3).

**Scope / residual.** None here. Pending migration (unchanged, DF-P3's): `supabase/migrations/20261195_df_roundG_outcome_and_departure.sql` moves the stragglers.

---

<a id="route-2"></a>

## ROUTE-2 · Attention badges tell DraftingSupervisors and DocCtrl to act on statuses where the workflow engine gives them no action at all

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/ticketAttention.ts:84`, `lib/ticketAttention.ts:106`, `lib/ticketAttention.ts:103` (re-pointed: roles-and-permissions Round E rewrote the file, `WF-24`), `lib/workflow.ts:301`, `lib/workflow.ts:319`, `lib/capabilityPolicy.ts:70`, `hooks/useTicketNotifications.ts:265`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the mismatch is wider than stated: DraftingSupervisor is in MANAGEMENT_ROLES for attention purposes but is NOT in ticket.manage's default roles, so it also gets action-required badges at PENDING_ENG_INITIAL, PENDING_REVIEW and PENDING_FINAL_APPROVAL with no matching action. The rows are recomputed from isActionRequired on every render (useTicketNotifications.ts:253-273) with no dismissal path, so the badge persists until someone else moves the ticket.

**Mechanism.** `isActionRequired` returns true for anyone holding a MANAGEMENT_ROLE — a list that includes `DraftingSupervisor` (lib/ticketAttention.ts:22-27) — at PENDING_ASSIGNMENT, PENDING_ENG_INITIAL, PENDING_REVIEW, PENDING_FINAL_APPROVAL and PENDING_IFC, and true for DocCtrl at FINAL_DRAFT and PENDING_IFC. The rendered reason comes from `attentionLabel` ("Issue the IFC package", "Needs review", "Acknowledge & close") and is shown as the subtitle of an orange "Action needed" row in the bell, the sidebar badge and the /inbox feed (hooks/useTicketNotifications.ts:265, components/notifications/NotificationBell.tsx:179). But `WorkflowEngine.getActions` gates PENDING_IFC solely on `canActAsDrafter` = `isDrafterIdentity || allows('ticket.draft_work')`, whose default role list is `["Drafter"]` (lib/capabilityPolicy.ts:70-71); FINAL_DRAFT is gated on `canActAsRequester || allows('ticket.direct_approve') || isManagement` where direct_approve defaults to `["Engineer"]` and `ticket.manage` defaults to `["Admin","Manager","Supervisor"]` — DraftingSupervisor is in none of those, and appears only in `ticket.assign`. So a DraftingSupervisor is flagged action-required on five statuses and has actual buttons on exactly one (PENDING_ASSIGNMENT); a DocCtrl is flagged on two and has buttons on neither.

**Failure scenario.** A drafting supervisor opens their bell to a red 'Action needed' row reading "Issue the IFC package" on an approved construction package. They click through to the ticket and the action rail is empty — the only person the state machine will accept is the assigned drafter. They cannot dismiss it (the row is derived from ticket state, not a notification they can mark read), so it persists across every session, on every such ticket. The predictable adaptation is to stop trusting the red dot, at which point the badge stops working for the cases where it IS actionable — in a PSM workflow whose whole point is that an unapproved package cannot quietly reach the field.

**Evidence.**

lib/ticketAttention.ts:84-94 —
```
  if (isManagementRole(roles)) {
    if (
      status === "PENDING_ASSIGNMENT" ||
      status === "PENDING_ENG_INITIAL" ||
      status === "PENDING_REVIEW" ||
      status === "PENDING_FINAL_APPROVAL" ||
      status === "PENDING_IFC"
    ) {
      return true;
    }
  }
```
lib/workflow.ts:300-316 —
```
      // --- IFC STAGE ---
      case 'PENDING_IFC':
        if (canActAsDrafter) {
             actions.push({ label: 'Save Progress', ... });
             actions.push({ label: 'ISSUE FINAL IFC PACKAGE', ... });
        }
        break;
```
lib/capabilityPolicy.ts:70-71 —
```
  { id: "ticket.draft_work", area: "Requests", label: "Do drafting work",
    description: "Save progress, submit drafts, issue IFC (the assigned drafter always can).", defaultRoles: ["Drafter"] },
```

**Chain reaction.** lib/ticketAttention.ts:8-15 justifies including PENDING_IFC on the grounds that ticketRouting "ROUTES the 'issue the IFC' alert to exactly that role" — but per finding #3 that routing never executes, so the badge was aligned to a phantom.

> **Verifier correction.** Correct on the default policy, with two caveats worth stating: (a) the capability lists are org-configurable (lib/capabilityPolicy.ts loadCapabilityPolicy reads org_configurations key 'capability_policy'), so an org that adds DraftingSupervisor/DocCtrl to ticket.draft_work or ticket.direct_approve closes the mismatch without a code change; (b) the same mismatch hits Admin/Manager/Supervisor at PENDING_IFC, since that case is gated solely on canActAsDrafter — so it is a general badge-vs-buttons drift, not specific to the two roles named. Consequence is misleading UI copy, not an authority hole (the server re-validates at app/api/tickets/workflow-action/route.ts:96).

**Done when.**

- [ ] `isActionRequired` is derived from, or cross-checked against, `WorkflowEngine.getActions(ticket, role, uid, policy).length > 0` — a role is flagged action-required for a status only if the state machine will actually offer it an action there.
- [ ] A test enumerates every (Role × TicketStatus) pair and asserts `isActionRequired === true` implies `getActions(...).length > 0` under the default capability policy.
- [ ] DocCtrl's FINAL_DRAFT / PENDING_IFC flags are either backed by real actions in lib/workflow.ts or removed from lib/ticketAttention.ts:106-108.

**Resolution (2026-10-02, drafting-flow Round G).** Record-only close by pointer to roles-and-permissions [`WF-24`](../roles-and-permissions/06-request-workflow.md) (Round E, `e5a203b`), re-verified against `f1ac550`; evidence as on [`FRIC-7`](./02-friction-latency.md). `lib/ticketAttention.ts` holds no `MANAGEMENT_ROLES` table any more (`isActionRequired` at `:79-91` is the engine); DraftingSupervisor is not management (`lib/managementRoles.ts:25`) and is flagged only where the engine offers it an action — the assignment queue. The verifier's wider mismatch (management at `PENDING_IFC`) is gone for the same reason.

**Done-when.**
- ✓ `isActionRequired` is derived from `WorkflowEngine.getActions(...)` (`lib/ticketAttention.ts:84-90`), not cross-checked against it.
- ✓ A test enumerates every (Role × TicketStatus) pair under the default policy and asserts the badge equals the engine's live-action set — `lib/__tests__/dfRoundG_P0.test.ts:325` (every role in `ALL_ROLES`, every value of the `TicketStatus` union parsed from `types/schema.ts`, four identities; equality is stronger than the implication asked for). Same inputs on both sides: the one input the badge cannot take, a departed requester's empty collection, is documented separately at `lib/__tests__/dfRoundG_P0.test.ts:344` — an under-count, which keeps `FRIC-7` OPEN (DF-P9). The implication this done-when asks for (flagged ⇒ an action is offered) holds for that input too: the badge is false there.
- ✓ DocCtrl's `FINAL_DRAFT` / `PENDING_IFC` flags are removed — no role table remains (`lib/ticketAttention.ts:1-27` records why).

**Scope / residual.** `attentionLabel` (`lib/ticketAttention.ts:95-107`) still renders "Issue the IFC package" — but only on rows the engine-derived rule flags, i.e. for the drafter. `PENDING_IFC` routing to the supervisor pool ("told", not "must act") is `ROUTE-5`'s residual (DF-P3).

---

<a id="route-3"></a>

## ROUTE-3 · Dead notification plumbing that the code documents as live: the ticket-follower resolver, the engineer-initial routing branch, and the entire web-push channel

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** notifications N10 PUSH (limb (c), through `TAX-12`) — restated by the integrator at the N15 merge, 2026-10-14 (DEC-31). Limb (a) was N15's and is done.
- **Assigned:** notifications N15 RECIPIENT VISIBILITY AND NAMES (limb (a): `lib/notify/recipients.ts` `resolveFollowers`' ticket branch removed, or its header says the two ticket routes fold `tickets.watchers` themselves) — by the integrator, 2026-10-13 (at the DF-P3 merge, DEC-31; DF-P3 named these in drafting-flow `99-fix-sequencing.md`, "Hand-offs from DF-P3"; fleet plans updated).
- **Verification:** CONFIRMED
- **Locations:** `lib/notify/recipients.ts:35`, `lib/ticketRouting.ts:98`, `lib/workflow.ts:83`, `public/sw.js:226`, `supabase/migrations/20260804_push_subscriptions.sql:1`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All three dead paths confirmed, and the migration/comment overclaims are real. One qualification on (a): ticket followers are not actually unnotified — computeTransition folds `ticket.watchers` into unread_by (ticketTransitions.ts:300-304) and returns them as recipients (:317), and lib/subscriptions.ts:9 `WatchResourceType = "document" | "project" | "asset" | "library"` has no ticket variant, so there is no way to create a ticket subscription row in the first place. That branch is redundant dead code rather than a delivery gap; (b) and (c) are unambiguous.

**Mechanism.** Three separately-verified dead paths. (a) `resolveFollowers` special-cases tickets to read `tickets.watchers` "so the two follow stores look like one to every caller" — but `audience.followers` is only ever set true at four sites (app/(protected)/documents/[libraryId]/page.tsx:2313, lib/holds.ts:252, lib/postPublish.ts:46 and :60), none of which pass a ticket resource; every ticket `emit` passes `audience: { involved: [...] }` only, so the ticket branch never executes. (b) `resolveTicketRecipients`'s `case "PENDING_ENG_INITIAL"` (routing to engineers) is unreachable: `getInitialStatus` returns `'PENDING_ASSIGNMENT'` unconditionally (lib/workflow.ts:47-53), requests/new hardcodes `const initialStatus: TicketStatus = 'PENDING_ASSIGNMENT'` (line 255), and three differently-shaped searches (identifier, quoted-write-shape, case-insensitive) find no code path that ever writes `PENDING_ENG_INITIAL` or `NEW` to `tickets.status` — so `case 'NEW': case 'PENDING_ENG_INITIAL':` in lib/workflow.ts:82-109 and the `approve_initial` transition are dead too. (c) The service worker has a full `push` handler that calls `self.registration.showNotification`, and a `push_subscriptions` table with RLS exists, but three searches (`push_subscriptions` / `webpush|web-push|VAPID` / `pushManager|Notification.requestPermission`) find no subscriber registration and no sender anywhere — the table is referenced only in export/restore/schema manifests.

**Failure scenario.** An operator reading lib/notify/recipients.ts:5-12 ("folding together EVERY follow/subscribe mechanism in the app") or the push migration header ("reminders that reach you even when the app is closed") reasonably concludes that watching a ticket routes through the unified resolver and that urgent alerts reach a phone. Neither is true. A maintainer later 'fixing' ticket notifications by adding `audience: { followers: true }` will double-notify, because watchers already arrive via `unread_by` — and the two paths dedupe differently. Nobody ever receives a push for an overdue IFC package.

**Evidence.**

lib/notify/recipients.ts:33-42 —
```
  // Tickets carry their own watchers array; read it through the same resolver
  // so the two follow stores look like one to every caller.
  if (resource.type === "ticket") {
    const { data: t } = await supabase
      .from("tickets")
      .select("watchers")
```
lib/workflow.ts:47-53 —
```
  getInitialStatus: (_type: RequestType, _requesterRole: Role): TicketStatus => {
    // Every new request lands in the assignment queue ...
    return 'PENDING_ASSIGNMENT';
  },
```
public/sw.js:226,238 —
```
self.addEventListener("push", (event) => {
  ...
  event.waitUntil(self.registration.showNotification(title, options));
```

**Chain reaction.** (b) also means the `attentionLabel` and `isActionRequired` PENDING_ENG_INITIAL branches (lib/ticketAttention.ts:87, :100, :118) and the ticketRouting test at lib/__tests__/ticketRouting.test.ts:96-105 all cover a state the product cannot reach — green tests over dead code, which is how #2 and #3 survived.

> **Verifier correction.** All three sub-claims hold; soften (a) only. resolveFollowers' ticket branch is unused rather than broken, and ticket watchers are not ignored globally — computeTransition folds tickets.watchers into the fan-out at lib/ticketTransitions.ts:298-304 — so the dead code is a maintenance/comment-accuracy issue, not a lost follower channel. Also note getInitialStatus (lib/workflow.ts:47) has no caller at all, which reinforces (b).

**Done when.**

- [ ] Either a ticket `emit` passes `audience: { followers: true }` (with `unread_by` no longer double-supplying watchers), or the ticket branch in resolveFollowers and the 'EVERY follow/subscribe mechanism' claim in its header are removed.
- [ ] Either a code path writes PENDING_ENG_INITIAL, or that status, its routing case, its workflow case, its attention clauses and its tests are deleted together so no future reader mistakes them for live policy.
- [ ] Either push subscription + a VAPID sender are implemented, or public/sw.js's push handler and the push_subscriptions migration's 'reach you even when the app is closed' claim are removed.

**Partial (2026-10-13, drafting-flow Round G).** DF-P3 ROUTING, base `5378ccb`. Re-verified the three limbs.
- (b) ✓ The engineer-initial branch is gone (DEC-14, Round E); `lib/ticketRouting.ts`'s header no longer describes it and names the routed statuses and their callers as they run.
- (a) ✗ No ticket notice walks `lib/notify/recipients.ts` `resolveFollowers` — the two ticket routes fold `tickets.watchers` into their own fan-out (the transition's `unread_by`, now unconditional — `ROUTE-6`; the comment route's merge). `lib/ticketRouting.ts`'s header now says so. But the follower resolver's ticket branch and its "EVERY follow/subscribe mechanism" header (`lib/notify/recipients.ts:1-12`, `:72-80`) are unchanged: that file is not in this package's brief. **Owner: notifications** (the package that next edits `lib/notify/recipients.ts` — N14 or a later one; the integrator confirms): remove the ticket branch or say the ticket routes are its only consumers.
- (c) ✗ Web push → notifications `TAX-12` (`03-taxonomy.md`, OPEN; package N10 PUSH builds the channel). Pointer only.

**Done-when.**
1. ✗ (above, owner notifications).
2. ✓ No code path writes `PENDING_ENG_INITIAL`, and its routing case, workflow case, attention clauses and tests are gone (DEC-14; `lib/__tests__/ticketRouting.test.ts` "the retired PENDING_ENG_INITIAL entry stage has no routing branch").
3. ✗ → notifications `TAX-12` (N10).

**Scope / residual.** Stays OPEN on (a) and (c), each with the owner named above.

**Partial (2026-10-13, notifications Round G).** Package N15 RECIPIENT VISIBILITY AND NAMES, branch `fleet/N15-recipient-visibility` (base `89c9aaa`) — limb (a).

**Re-verified** on `89c9aaa`: the two ticket routes fold `tickets.watchers` themselves. But `resolveFollowers`' ticket branch is NOT dead: the intake door's redline notice (`app/api/intake/upload/route.ts`, `resource: { type: "ticket" }`, `audience: { involved, followers: true }`) walks it. Removing the branch would drop that notice's watchers, so the done-when's other arm was taken.

**What landed.**
- `lib/notify/recipients.ts`: the header's "folding together EVERY follow/subscribe mechanism" claim is gone. It now says the two ticket routes (`comment`, `workflow-action`) do NOT walk the resolver — they fold `tickets.watchers` into their own fan-out — and that the branch's only consumer is the intake door's redline notice. A ticket emit adding `followers: true` beside them would double-supply the watchers.
- The comment on the branch says the same.

**Tests.** `lib/__tests__/recipientDiscovery.test.ts` "ROUTE-3 (a)": the header's words; the redline notice is the branch's consumer; neither ticket route passes `followers: true` or calls `resolveFollowers`; the redline notice still reaches a ticket watcher (REGRESSION).

**Done-when.**
- ✓ 1: the "EVERY follow/subscribe mechanism" claim is removed and the header names the ticket routes as folding watchers themselves. The branch stays, for its one real consumer.
- ✓ 2 (DF-P3).
- Done-when 3 is not met: `TAX-12`, notifications N10.

**Scope / residual.** Stays OPEN on (c) only (`TAX-12`, N10).

**Resolution (2026-10-14, notifications Round G).** Package N10 PUSH, branch `fleet/N10-push` (base `ce5a053`), commits `3f53779` (`web-push` 3.6.7), `b3358d9` (the channel) and `669afad` (no push for a registration older than the opt-in control) — limb (c), through notifications `TAX-12`.

**Re-verified** on `ce5a053`: limb (a) is N15's (✓ above); limb (b) is DF-P3's (✓ above); limb (c) held: the push handler in `public/sw.js`, the `push_subscriptions` table, and no subscriber or sender.

**What landed (limb (c)).** Push subscription and a VAPID sender are implemented:
- `components/settings/PushOptIn.tsx` subscribes a device after the person's click and the browser's permission;
- `app/api/push/subscribe/route.ts` stores it;
- `lib/push/sendPush.ts` sends with VAPID keys from `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`, called from `lib/notify/dispatch.ts` `emit()`'s third leg.
The record is `TAX-12` / `OS-2` (notifications `03-taxonomy.md`, `07-os-notifications-and-nudges.md`). The migration header's "reach you even when the app is closed" is now true of the channel. Its "reminder cron reads every row" is not, and a migration is never edited; the sender's own header says who reads the table.
- Verified (loop on `fleet/N10-push` at `669afad`, 2026-10-14): `npx tsc --noEmit` exit 0; `npx eslint` on the changed files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` in four shards (`--shard=N/4`), each exit 0 — 568 files, 12532 passed, 8 expected fail. `next build` is the integrator's.

**Done-when.**
- ✓ 1 (N15, above).
- ✓ 2 (DF-P3, above).
- ✓ 3: push subscription and a VAPID sender are implemented (notifications `TAX-12`).

**Scope / residual.** None in this finding. A request's mention or assignment is not yet pushed, because the two ticket routes write their bell rows outside `emit()`. That is notifications `OS-14` (new; the integrator routes it — the ticket routes are drafting-flow's).

---

<a id="route-4"></a>

## ROUTE-4 · Drafting requests raised from a document check-in notify in-app only — no email — unlike identical requests raised from the portal

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/documents/CheckInPanel.tsx:45`, `components/documents/CheckInPanel.tsx:276`, `components/documents/CheckInPanel.tsx:296`, `app/(protected)/requests/new/page.tsx:342`, `lib/transitionIn.ts:339`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the check-in path fans out through notifyMany (bell rows only) while the portal path and the intake-collision path (lib/transitionIn.ts:339) both use emit(), which defaults to inapp+email. Same recipient pool (resolveTicketRecipients(..., 'PENDING_ASSIGNMENT')), two different channel sets.

**Mechanism.** Two of the three ticket-creation routing paths call `emit()` (app/(protected)/requests/new/page.tsx:342, lib/transitionIn.ts:339), which fans out to BOTH the in-app bell and the preference-gated email queue (lib/notify/dispatch.ts:89-130). The third — the check-in path in components/documents/CheckInPanel.tsx — imports and calls `notifyMany` directly (line 45, used at 276 and again at 296 for the PSM undocumented-change escalation), which only inserts `notifications` rows (lib/inAppNotifications.ts:104-138). No `queueEmail` call accompanies it; the same file uses `emit` correctly for a different outcome at line 401, showing the helper was available. So a request created from a check-in reaches recipients only if and when they open the app.

**Failure scenario.** A field engineer checks a P&ID back in and reports an as-built discrepancy, raising a drafting request. The routing notification goes to the drafting supervisor's bell — and nowhere else. If the supervisor is out of the app that day (or that week), nothing lands in their inbox. The second call at line 296 is the PSM escalation for an UNDOCUMENTED FIELD CHANGE, described in the surrounding comment as going "straight to the controllers, loudly" — it too is bell-only, so the loudest alert in the file is the one least likely to be seen off-screen.

**Evidence.**

components/documents/CheckInPanel.tsx:45 —
```
import { notifyMany } from "@/lib/inAppNotifications";
```
components/documents/CheckInPanel.tsx:274-283 —
```
        const recipients = await resolveTicketRecipients(doc.orgId!, "PENDING_ASSIGNMENT", currentUser.uid);
        if (recipients.length > 0) {
          await notifyMany({
            orgId: doc.orgId!, userIds: recipients.map((m) => m.uid),
            ...
            kind: "request_pending_approval",
```
contrast app/(protected)/requests/new/page.tsx:342-353 —
```
          await emit({
            orgId: activeOrgId,
            category: 'assignment',
            kind: 'request_pending_approval',
            ...
            audience: { involved: recipients.map((m) => m.uid) },
```

**Chain reaction.** The maintenance cron's own comment states the principle this violates: "the bell alone is not an escalation channel: an obligation that never leaves the app dies with an unread badge" (app/api/cron/maintenance/route.ts:189-191).

**Done when.**

- [ ] Both CheckInPanel notification sites go through `emit()` with an appropriate `category`, so the email channel and per-user preferences apply identically to portal-created and check-in-created requests.
- [ ] A test (or a single shared `notifyNewDraftingRequest` helper used by all three creation paths) makes it structurally impossible for one creation path to skip a channel the others use.

**Resolution (2026-10-07, drafting-flow Round G).** DF-P2 CREATE. A request raised from a check-in is announced exactly as a portal request is: the check-in posts the shared contract (`origin: { kind: "checkin", … }`) to `app/api/tickets/create/route.ts`, which sends the one creation notice through `emit()` — bell and preference-aware email, category `assignment` — for every door. `CheckInPanel` no longer imports `notifyMany`; its second site, the PSM escalation for an undocumented field change, went through `emit()` on the `safety` category (`LIFE-7`) and is now the route's as well (`escalatePsm`, second review fix: sent once per ticket, stamped `metadata.psm_escalated_at`).

**Done-when.**
- ✓ Both `CheckInPanel` notification sites go through `emit()`, both from the route: the creation notice (`announce`) and the PSM escalation (`escalatePsm`, `category: "safety"`, which no preference mutes); the panel holds no escalation of its own (`lib/__tests__/checkInPanelCreate.test.ts`, "the panel holds no escalation of its own (source)").
- ✓ Structurally impossible for one creation path to skip a channel: the route is the single notifier for every origin, and a census pins it (`lib/__tests__/ticketCreateClient.test.ts`, "the creation notice is written only by the route (one channel set for every door — ROUTE-4)"); `lib/__tests__/ticketCreateRoute.test.ts` drives a check-in and a collision through the same announce.

**Scope / residual.** None.

---

<a id="route-5"></a>

## ROUTE-5 · Role routing runs only at ticket creation — no state transition ever consults it, so a request re-entering the assignment queue is announced to nobody in that queue

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/ticketTransitions.ts:140`, `lib/ticketTransitions.ts:190`, `lib/ticketTransitions.ts:317`, `app/api/tickets/workflow-action/route.ts:148`, `app/api/tickets/workflow-action/route.ts:310`, `lib/ticketRouting.ts:64`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanical claim is right — no transition ever consults lib/ticketRouting, so the DraftingSupervisor pool gets no bell row and no email when a ticket re-enters PENDING_ASSIGNMENT. But 'announced to nobody in that queue' overstates it: lib/ticketAttention.ts:84-93 makes PENDING_ASSIGNMENT action-required for every management/DraftingSupervisor role and :79 for every Drafter, so the ticket does appear in their sidebar badge and /inbox feed. Missing push, not missing visibility — LOW.

**Mechanism.** There are exactly three callers of `resolveTicketRecipients` (app/(protected)/requests/new/page.tsx:340, components/documents/CheckInPanel.tsx:274, lib/transitionIn.ts:337) and all three are ticket-CREATION paths passing the literal `"PENDING_ASSIGNMENT"`. After creation, the only fan-out is app/api/tickets/workflow-action/route.ts's `fanOut`, whose recipient list is `recipients` from `computeTransition` — which is just `updates.unread_by` (lib/ticketTransitions.ts:317), seeded from `[ticket.requesterId, ticket.assignedDrafterId]` (line 140) and overridden per-action only with named individuals. No branch of `computeTransition` ever consults a role pool. Concretely, `case "approve_team": updates.status = "PENDING_ASSIGNMENT"` (lines 190-192) leaves `unread_by` at the default, so the ticket lands back in the assignment queue announced only to the requester and pre-existing watchers. The same holds for the routing module's own documented `PENDING_IFC → DraftingSupervisor` policy (lib/ticketRouting.ts:64, restated at lib/ticketAttention.ts:8-12 as a live behaviour) — that status is never passed to `resolveTicketRecipients` by any caller, so that routing rule has never executed in production.

**Failure scenario.** A supervisor flags an MOC request for engineering scope review. The engineer clicks "Engineering Review Complete" (approve_team). The ticket returns to PENDING_ASSIGNMENT — the state that exists precisely because it is waiting on the drafting supervisor's pool — and the pool is told nothing. Any supervisor who was not the original flagger, and the entire Admin fallback pool in an org with no supervisor set, get zero signal. The scope-cleared request idles in a queue whose owners believe it is still with engineering.

**Evidence.**

lib/ticketTransitions.ts:140-148 —
```
  const newUnreadBy = [ticket.requesterId, ticket.assignedDrafterId].filter(
    (id): id is string => !!id && id !== actorUid,
  );
  const updates: Record<string, unknown> = {
    last_modified: now,
    history: newHistory,
    unread_by: newUnreadBy,
  };
```
lib/ticketTransitions.ts:190-192 —
```
    case "approve_team":
      updates.status = "PENDING_ASSIGNMENT";
      break;
```
lib/ticketTransitions.ts:317 —
```
  const recipients = (updates.unread_by as string[]).filter((u) => u && u !== actorUid);
```
lib/ticketRouting.ts:64 (the policy that never runs) —
```
 *  PENDING_IFC         → DraftingSupervisor + originating engineer
```

**Chain reaction.** Combined with #1 (no aging clock) and #5 (supervisors are told they must act but given no buttons), a ticket can enter PENDING_ASSIGNMENT with no notification, no due-date escalation, and an attention badge whose owner has nothing to click.

> **Verifier correction.** "Announced to nobody in that queue" overstates it twice. (1) The watcher union carries the person who sent it to engineering: computeTransition adds every actor to watchers (lib/ticketTransitions.ts:296 `if (actorUid) updates.watchers = Array.from(new Set([...(ticket.watchers ?? []), actorUid]));`), so the assigner who ran request_eng_review is a watcher, and on approve_team unread_by = [requesterId] is non-empty, which satisfies the line-300 guard and folds the watchers (including that assigner) back in. (2) The assignment queue itself is role-aware through a different module: lib/ticketAttention.ts:84-93 + hooks/useTicketNotifications.ts:155-157/253 flag PENDING_ASSIGNMENT for every management-role and Drafter holder, so the ticket reappears in their badge/bell/portal without any notification. The accurate residue: no transition re-runs resolveTicketRecipients, so no fresh email/bell row reaches role-pool members who never touched the ticket, and the PENDING_IFC routing branch is unreachable.

**Done when.**

- [ ] Every transition whose NEW status has a role pool in `resolveTicketRecipients` (at minimum PENDING_ASSIGNMENT, and PENDING_IFC once its actor set is decided) unions that pool into the fan-out recipients server-side in app/api/tickets/workflow-action/route.ts.
- [ ] A test drives `approve_team` on a ticket with no assigned drafter and asserts the DraftingSupervisor pool appears in the fan-out recipient list.
- [ ] Either the `PENDING_IFC → DraftingSupervisor` rule in lib/ticketRouting.ts:64 is actually wired, or it and the claim in lib/ticketAttention.ts:8-12 that routing "ROUTES the 'issue the IFC' alert to exactly that role" are deleted, so the two files stop documenting behaviour that does not exist.

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. Re-entry into the assignment queue now routes (roles-and-permissions [`WF-19`](../roles-and-permissions/06-request-workflow.md), Round E, `e5a203b`): `if (newStatus === "PENDING_ASSIGNMENT" && ticket.status !== "PENDING_ASSIGNMENT") { const pool = (await resolveTicketRecipients(ticket.orgId, "PENDING_ASSIGNMENT", caller.id, supabaseAdmin)).map((m) => m.uid); … }` (`app/api/tickets/workflow-action/route.ts:318-331`), unioned into `unread_by` and the fan-out. `PENDING_IFC` re-entry still never routes.

**Done-when.**
- ✗ (in part) `PENDING_ASSIGNMENT` ✓ (above). `PENDING_IFC` ✗: `resolveTicketRecipients` has a pool for it (`case "PENDING_ASSIGNMENT": case "PENDING_IFC": pool = supervisorTargeted();`, `lib/ticketRouting.ts:114-117`) but the route only calls it for `PENDING_ASSIGNMENT`.
- ✓ A test drives `approve_team` on a ticket with no drafter and asserts the DraftingSupervisor pool is in the fan-out (`lib/__tests__/sweepRoundE_A.test.ts:659`, "WF-19").
- ✗ The two files still document behaviour that does not run: `lib/ticketRouting.ts:82` — ` *  PENDING_IFC         → DraftingSupervisor + originating engineer` (the code returns the supervisor pool only, and no caller passes `PENDING_IFC`), and `lib/ticketAttention.ts:24-27` — "A supervisor is told about a PENDING_IFC package (so they can chase the drafter)".

**Scope / residual.** Handed on, binding (fleet plan): `PENDING_IFC` re-entry never routes → **DF-P3** (under `LEAK-1`: route on every entry into a routed status, add the originating engineer, correct the two comments).

**Resolution (2026-10-13, drafting-flow Round G).** Closed with `LEAK-1` (DF-P3 ROUTING, base `5378ccb`): the route routes every entry into a routed status, `PENDING_IFC` included (`app/api/tickets/workflow-action/route.ts:563`; `lib/ticketRouting.ts` `routedPool()` `:149` — the queue's owners plus the originating engineer).

**Done-when.**
1. ✓ `PENDING_ASSIGNMENT` (since `WF-19`) and `PENDING_IFC` (now) union their pool into `unread_by` and the fan-out server-side — `lib/__tests__/dfRoundG_P3_routing.test.ts` ("approve → PENDING_IFC tells the supervisor pool and the originating engineer").
2. ✓ Unchanged: `lib/__tests__/sweepRoundE_A.test.ts` "WF-19" drives `approve_team` with no drafter.
3. ✓ The rule is wired, so both documents describe behaviour that runs: `lib/ticketRouting.ts`'s header and `resolveTicketRecipients` doc name the `PENDING_IFC` pool, and `lib/ticketAttention.ts:24-27` ("A supervisor is told about a PENDING_IFC package") is now true — no edit to that file (DF-P9's) was needed.

**Scope / residual.** None.

---

<a id="route-6"></a>

## ROUTE-6 · The Watch button on a ticket is silently defeated whenever the acting user is the only personal stakeholder — self-assignment is a completely silent transition

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/ticketTransitions.ts:296`, `lib/ticketTransitions.ts:300`, `lib/ticketTransitions.ts:317`, `app/api/tickets/workflow-action/route.ts:310`, `app/(protected)/requests/[id]/page.tsx:1774`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The general guard bug is real (a transition whose only stakeholder is the actor drops every watcher), but the headline scenario is false: on 'Pick Up Ticket' the drafter is not the requester, so unread_by = [requesterId], line 300 fires, and the watching supervisor is notified. The silent case is the narrow one where the actor is both requester and (non-)drafter — hence LOW.

**Mechanism.** Watchers are folded into the fan-out only inside a guard that requires `unread_by` to already be non-empty (lib/ticketTransitions.ts:300). `unread_by` starts as `[requesterId, assignedDrafterId]` MINUS the actor (line 140-142). So whenever the actor is the only person in that pair, `unread_by` is `[]`, the watcher union at line 300 is skipped entirely, `recipients` is `[]` (line 317), and `fanOut` returns at its first line (`if (recipients.length === 0) return;`, route.ts:310) — which also skips the stale-alert supersede step at route.ts:324. The canonical instance is `self_assign`: `computeTransition` reads the PRE-update `ticket.assignedDrafterId` (still null) and the requester is the actor when a Drafter picks up their own request, so `unread_by = []`. Users are explicitly invited to subscribe: the ticket page renders a "Watch"/"Watching" toggle with an `N subscribers` count (app/(protected)/requests/[id]/page.tsx:1774-1781) that writes `tickets.watchers`.

**Failure scenario.** A drafting supervisor clicks Watch on a hot MOC request so they can track it without owning it; the counter says "2 subscribers". A drafter then hits "Pick Up Ticket". The ticket moves PENDING_ASSIGNMENT → DRAFTING with zero notifications: the watcher gets nothing, the assignment queue is never told the ticket left it, and any earlier "needs a drafter assigned" bell rows are not superseded because fanOut returned before reaching that step. The supervisor's explicit, deliberate subscription produced silence at the one moment the ticket changed hands.

**Evidence.**

lib/ticketTransitions.ts:298-304 —
```
  // For meaningful transitions (ones that already notify someone), also notify
  // everyone following the ticket — minus the actor.
  if (Array.isArray(updates.unread_by) && (updates.unread_by as string[]).length > 0 && (ticket.watchers ?? []).length > 0) {
    updates.unread_by = Array.from(
      new Set([...(updates.unread_by as string[]), ...(ticket.watchers ?? [])]),
    ).filter((u) => u !== actorUid);
  }
```
lib/ticketTransitions.ts:201-207 (`self_assign` sets no unread_by override) —
```
    case "self_assign":
      if (actorUid && input.actor.email) {
        updates.assigned_drafter_id = actorUid;
        updates.assigned_drafter_name = input.actor.email.split("@")[0];
        updates.status = "DRAFTING";
      }
      break;
```
app/api/tickets/workflow-action/route.ts:309-310 —
```
  const { ticket, ticketId, action, newStatus, recipients, actorUid, actorEmail, comment } = params;
  if (recipients.length === 0) return;
```

**Chain reaction.** Because the early return also skips the supersede block (route.ts:324-332), the previous status's "act on this" bell rows survive a silent transition; only the client-side reconcile in hooks/useTicketNotifications.ts:188-210 clears them, and only for users who happen to load a surface that runs the hook.

> **Verifier correction.** The mechanism is exactly as described but the blast radius is narrower than "self-assignment is silent": it only bites when the actor is the sole personal stakeholder — i.e. a Drafter self-assigning a request they themselves raised. In the ordinary case (requester ≠ actor) unread_by = [requesterId] is non-empty, so the line-300 watcher union runs and watchers are notified. Watchers also retain a non-notification path to the ticket: lib/inbox.ts:139-142 fetches "tickets I'm watching" for My Desk / the inbox snapshot. Severity is UX/awareness, not workflow integrity.

**Done when.**

- [ ] The watcher union in lib/ticketTransitions.ts is unconditional — watchers are added regardless of whether `unread_by` is non-empty — with the actor still excluded.
- [ ] `self_assign` (and any other status-changing action) always produces a non-empty recipient set when watchers or a responsible role pool exist.
- [ ] The stale-notification supersede in app/api/tickets/workflow-action/route.ts runs on every committed transition, not only when `recipients.length > 0` — move it above the early return.
- [ ] A test asserts that a transition where the actor is the sole personal stakeholder still fans out to `ticket.watchers`.

**Resolution (2026-10-13, drafting-flow Round G).** DF-P3 ROUTING, base `5378ccb`. Reproduced first: `computeTransition` folded watchers only when `unread_by` was already non-empty, and `fanOut` returned on an empty recipient list before the supersede step.
- `lib/ticketTransitions.ts:405` — the watcher union is unconditional; the actor is still excluded.
- `app/api/tickets/workflow-action/route.ts:1096` — only thread ACTIVITY (`attach_file`) with nobody to tell returns early; a transition always reaches the supersede step, even when it tells nobody, and then stops before the bell rows (`if (audience.length === 0) return;`, N6's line, unchanged).
- Tests: `lib/__tests__/dfRoundG_P3_routing.test.ts` ("ROUTE-6"): a Drafter picking up their own request tells the people following it; the actor is never told; a self-assignment that tells nobody still retires the queue's "needs a drafter" alert (`metadata.superseded_by: "self_assign"`) and records `notified: 0`; an attachment with nobody to tell retires nothing (WF-9's rule kept).
- *Fix pass 3 (2026-10-13):* running the supersede on every transition also retired the SLA clock's "Overdue" / "Due soon" rows (`metadata.action` `sla_breach` / `sla_warning`, `lib/ticketSla.ts`) on a transition that left the request as late as it was (save progress, a reassignment). Those rows are now kept unless the transition is an exit (`CLOSED` / `CANCELED`); every other workflow alert is retired exactly as before. (The bell's client-side reconcile still retires them on a status change — remainder owned by DF-P9, on `EDGE-7`.) Reproduced first and pinned in `dfRoundG_P3_routing.test.ts` ("ROUTE-6": "an open-to-open transition … KEEPS the SLA rows", "an exit … retires the SLA rows too"). See `EDGE-7`.

**Done-when.**
1. ✓ The union is unconditional, actor excluded (`:405`).
2. ✓ `self_assign` produces a non-empty recipient set whenever watchers exist, and every entry into a status with a responsible pool adds the pool (`LEAK-1`).
3. ✓ The supersede runs on every committed transition, not only when `recipients.length > 0` (route `:1096`).
4. ✓ Test: a transition where the actor is the sole personal stakeholder fans out to `ticket.watchers` (above).

**Scope / residual.** None.

---

<a id="route-7"></a>

## ROUTE-7 · The attention feed caps at 500 open tickets sorted newest-modified-first, so the longest-neglected requests are exactly the ones it drops

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:31`, `hooks/useTicketNotifications.ts:156`, `hooks/useTicketNotifications.ts:160`, `hooks/useTicketNotifications.ts:170`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed exactly as claimed: newest-modified-first with a hard 500 cap means the least-recently-touched open tickets are the first excluded, and lib/ticketAttention.isActionRequired only ever runs over the rows that survived the cap. No compensating query exists — the feed is the only source for the badge, bell and /inbox.

**Mechanism.** Every management/engineer/DocCtrl user's attention feed is one query: `.neq('status','CLOSED').order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP)` with `OPEN_TICKET_CAP = 500`. `isActionRequired` and the sidebar/bell/inbox counts are then computed over that truncated list only (lines 252-274). Sorting descending by `last_modified` means the retained 500 are the most recently touched; the tickets that fall off the end are those nobody has touched in the longest time. The code comment asserts the opposite rationale.

**Failure scenario.** A workspace that has run for a couple of years accumulates more than 500 open drafting requests (a realistic figure for a multi-unit plant with RFIs and as-builts). A PENDING_ASSIGNMENT request from eight months ago is now the 520th most-recently-modified open ticket. It is silently excluded from the supervisor's badge count, from the bell list and from the /inbox AttentionFeed — permanently, because being ignored is precisely what keeps it out. Combined with finding #1 (no SLA scan), nothing in the system will ever raise it again.

**Evidence.**

hooks/useTicketNotifications.ts:28-31 —
```
// Cap open-ticket fetches so the attention feed can't pull an unbounded set
// (and re-pull it on every realtime change). Newest-first, so the most
// recently active tickets — the ones likely to need attention — are kept.
const OPEN_TICKET_CAP = 500;
```
hooks/useTicketNotifications.ts:156 —
```
          const { data } = await supabase.from('tickets').select('*').eq('org_id', activeOrgId).neq('status', 'CLOSED').order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP);
```

**Chain reaction.** The same cap is applied to the Drafter branch's two queries (lines 160-161), including the PENDING_ASSIGNMENT claim pool.

> **Verifier correction.** Mechanism confirmed as written; add the precondition, since it is unobservable from the repo: nothing is dropped until an org exceeds 500 non-CLOSED tickets, and the same cap is applied to the Drafter branch's two queries (lines 160-161) and the requester branch (line 170), not just the management branch.

**Done when.**

- [ ] The attention query either filters server-side to action-required candidates (so the cap bounds a relevant set) or sorts oldest-first / by due date, so truncation drops the least urgent rather than the most.
- [ ] The UI states honestly when the feed is truncated (e.g. "showing 500 of N open requests") rather than presenting a silently partial count as the count.
- [ ] A test with more than OPEN_TICKET_CAP open tickets asserts that an aged, untouched action-required ticket still appears in the feed.

**Resolution (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE, on notifications N4's paging (`DEC-105` item 3). Same change as `EDGE-3`: every scope is paged 500 at a time with an exact count up to 5000 (N4); past that ceiling it is re-read **oldest-modified first** (`hooks/useTicketNotifications.ts` `loadTicketScope`, :322-358), so truncation drops the most recently touched requests, never the longest-neglected; and the feed says "the N longest-waiting of M open requests are checked" (`components/cockpit/AttentionFeed.tsx:251`).

**Done-when.**
- ✓ The query sorts oldest-first when it must truncate, so truncation drops the least urgent (a server-side action-required filter is not possible — the rule is the engine's, client-side).
- ✓ The UI states when the feed is truncated, and which end it kept ("longest-waiting of M").
- ✓ A test with more than the cap asserts an aged, untouched action-required ticket appears: `lib/__tests__/attentionProvider.test.ts` ("drafting-flow Round G (DF-P9) — the badge counts what the page offers") "ROUTE-7 / EDGE-3: past the scan ceiling…" (6000 open: the oldest page is read, the aged `t0` is evaluated, the newest is not, the feed text says so) and "EDGE-3: the 501st open request is evaluated and counted".

**Scope / residual.** As `EDGE-3`'s.

---

<a id="route-8"></a>

## ROUTE-8 · The drafter assignment picker queries the headline role only, so a member who holds Drafter additively can never be assigned drafting work

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:244`, `app/(protected)/requests/[id]/page.tsx:246`, `components/requests/EngineerPickerModal.tsx:77`, `app/api/tickets/workflow-action/route.ts:113`
- **Same root cause as** `ROUTE-10`, `EDGE-6` — Also owned as `LEAK-2` in [`04-flow-leaks.md`](./04-flow-leaks.md). Settled by `DEC-1` — do that first and these collapse. Fix once; close the rest citing this one.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and lib/roleCapabilities.ts:74-94 makes the scenario exact: Engineer-3 ranks 63 vs Drafter 50, so primaryRole(['Engineer-3','Drafter']) = 'Engineer-3' and the `.eq('role','Drafter')` filter excludes her. The self-assign fallback is also closed to her: lib/workflow.ts:65 calls policyAllows with `extraRoles = null`, so ticket.self_assign is evaluated against the headline role only. The server (route.ts:113-123) would have accepted her as an assignee — only the picker blocks it.

**Mechanism.** The Assign Ticket modal builds its list with `.select('uid, email, role').eq('org_id', activeOrgId).eq('role', 'Drafter').eq('status','active')` — a headline-column equality filter. `grep -rn "eq('role'" app lib components` finds this as the only such ticket-flow query. The additive collection is ignored, so anyone whose `roles` array contains 'Drafter' but whose headline outranks it (Supervisor 80, DocCtrl 70, Engineer-N 61-64 all outrank Drafter 50 in ROLE_RANK, lib/roleCapabilities.ts:74-94) is invisible to the picker. This is the same defect that was already recognised and fixed one component over: EngineerPickerModal explicitly comments "headline role OR the additive roles array (the server validates against both, so an Admin who also holds Engineer-2 must appear here too)" and selects `"uid, email, role, roles"`. The server side is not the constraint either — app/api/tickets/workflow-action/route.ts:113-132 role-checks only the `engineer` pick, never the `assignment` pick, so this is a UI-only blockage of a legitimate assignment.

**Failure scenario.** An org gives its senior Engineer-3 a second hat as a drafter (roles: ['Engineer-3','Drafter']) so she can produce isometrics during a turnaround. The supervisor opens Assign Ticket and she is not in the list — or, in a small org where she is the only drafter, the modal renders "No drafters found in the system." and the assignment queue is a dead end. The supervisor's only route forward is to strip her Engineer role, which silently changes her authority everywhere else in the app including engineering sign-off.

**Evidence.**

app/(protected)/requests/[id]/page.tsx:242-249 —
```
            const { data } = await supabase
              .from('org_members')
              .select('uid, email, role')
              .eq('org_id', activeOrgId)
              .eq('role', 'Drafter')
              .eq('status', 'active');
            setDrafters((data || []).map(r => ({ uid: r.uid, email: r.email, role: r.role })));
```
contrast components/requests/EngineerPickerModal.tsx:77-89 —
```
        // Pull every active engineer in the org — headline role OR the
        // additive roles array (the server validates against both, so an
        // Admin who also holds Engineer-2 must appear here too).
          .select("uid, email, role, roles")
        ...
          const held: string[] = Array.isArray(m.roles) && (m.roles as string[]).length > 0
            ? (m.roles as string[])
            : [String(m.role ?? "")];
          return held.some((r) => r.includes("Engineer"));
```

**Chain reaction.** Same root cause as #2. Fixing both together (a shared `membersHoldingRole(orgId, token)` helper) removes the whole class rather than the two instances found here.

> **Verifier correction.** Correct and cleanly demonstrated by the sibling contrast, but it is a UI-only blockage with a trivial workaround (assign a pure Drafter, or have an admin reorder the collection), not a workflow break — so MEDIUM rather than HIGH. Note the related consequence the finding omits: the same person also loses 'Pick Up Ticket', because getActions is called with the single headline role (app/(protected)/requests/[id]/page.tsx:1350) and ticket.self_assign defaults to ["Drafter"] (lib/capabilityPolicy.ts:67-68).

**Done when.**

- [ ] The drafter picker selects `roles` and matches headline ∪ additive, mirroring EngineerPickerModal.
- [ ] A shared helper resolves "active members holding role token X" and is used by the drafter picker, the engineer picker and lib/ticketRouting.ts, so the three cannot drift again.
- [ ] The server's `assignment` reference check in app/api/tickets/workflow-action/route.ts validates the picked assignee holds a drafting role (headline or additive), matching the check already applied to `engineer` — so widening the picker does not widen who can be assigned.

**Partial (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE — the drafter picker (the same change as [`EDGE-6`](./13-edges-and-invariants.md#edge-6)).

**Done-when.**
- ✓ The drafter picker selects `roles` and matches headline ∪ additive — by the route's own rule under the org's policy (`lib/ticketPage.ts` `drafterCandidates`, `pickRoles`); `lib/__tests__/dfRoundG_P9_ticketPage.test.ts` and `lib/__tests__/dfRoundG_P9_ticketDetail.test.ts` as recorded on `EDGE-6`. *DF-P9 integrator fix pass (`DEC-90`):* that widening read every active member in one unpaged request, which PostgREST's max-rows cuts (1000 by default) — a Drafter past the cut was missing though the route accepts them. The read is now keyset-paged on `uid` (`lib/ticketPickerMembers.ts` `loadPickerMembers`), so the picker never hides someone the route accepts whatever max-rows is; a normal workspace's result and order are unchanged — tests as recorded on `EDGE-6`.
- ✗ in part — one shared helper for all three: the drafter picker's rule lives in `lib/ticketPage.ts` and `lib/ticketRouting.ts` reads `heldRoles`, but `components/requests/EngineerPickerModal.tsx` still carries its own filter. **Owner:** drafting-flow **DF-P5** (its package lists `EngineerPickerModal.tsx`): move the engineer picker onto a shared "active members holding capability X" helper (`drafterCandidates`' shape with `ticket.eng_review` / the engineer tokens).
- ✓ The route validates the `assignment` pick: `policyAllows(capPolicy, "ticket.draft_work", held[0], held, ref, resource)` (`app/api/tickets/workflow-action/route.ts`, WF-14 — landed in an earlier round, re-verified), so widening the picker widened nothing. *DF-P9 review fix pass:* the picker also follows the route's two per-ticket refusals — the current drafter is not offered on a reassignment, and the requester is shown disabled with the reason in a workspace of 3+ — as recorded on `EDGE-6`.

**Scope / residual.** Done-when 2's engineer picker → DF-P5 (its member read, `components/requests/EngineerPickerModal.tsx:87-91`, is also unpaged — the shared helper should read through `loadPickerMembers`).

*Assigned (2026-10-14, the integrator at the DF-P9 merge):* the remainder (`components/requests/EngineerPickerModal.tsx`: one shared rule and keyset-paged members) → drafting-flow **DF-P5 ROSTER**.

---

<a id="route-9"></a>

## ROUTE-9 · The drafting-request SLA clock has no server-side reader — nothing ever fires an SLA warning, while the settings page promises one

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P4 LIBRARY (done-when 4: the create route stamps `target_completion_at` — re-owned from the merged DF-P2) — by the integrator, 2026-10-13 (at the DF-P3 merge, DEC-31; DF-P3 named these in drafting-flow `99-fix-sequencing.md`, "Hand-offs from DF-P3"; fleet plans updated).
- **Verification:** CONFIRMED
- **Locations:** `lib/notifications.ts:216`, `lib/notifications.ts:224`, `lib/notifications.ts:245`, `lib/notify/dispatch.ts:56`, `app/(protected)/settings/notifications/page.tsx:143`, `app/api/cron/maintenance/route.ts:159`, `vercel.json:4`
- **Same root cause as** `EDGE-7` — `GAP-106` is the build. Depends on `LEAK-1` landing first so escalations reach someone who does not already know. Fix once; close the rest citing this one.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence search: the SLA clock has no server-side reader, the breach columns are dead, and the only 'sla_warning' plumbing is a preference toggle plus an unreachable dispatch branch.

**Mechanism.** Every new ticket gets a due date: `target_completion_at: targetCompletion` (app/(protected)/requests/new/page.tsx:315) from `defaultSlaTargetDate(requestType)` (lib/notifications.ts:245), and check-in-created tickets get one too (components/documents/CheckInPanel.tsx:246). The field is indexed for scanning (`tickets_target_completion_idx ... WHERE target_completion_at IS NOT NULL`, supabase/migrations/20260529_phase_b_notifications.sql:22). But the only readers of that value anywhere are client render code: app/(protected)/requests/page.tsx:1067-1076 (a Past Due / Due Soon chip in the table) and app/(protected)/requests/[id]/page.tsx:1756-1761. `isPastDue` / `isNearingDue` have exactly two non-test callers, both in the ticket detail page's JSX. The notification side is fully built but has no producer: the `sla_warning` event type exists (lib/notifications.ts:122), the `"sla"` NotifCategory maps to it (lib/notify/dispatch.ts:56), the `email_on_sla_warning` preference is stored and rendered as a toggle, and an `sla_defaults` table exists — yet `grep -rn "category: *['\"]sla['\"]"` across the repo returns zero hits, `sla_defaults` is never queried (only listed in export/restore/schema-expectation manifests), and the daily maintenance cron's scan list contains seven scans, all document-control, none touching `tickets`.

**Failure scenario.** An ISO/MOC drafting request is created with a 7-day SLA. The assigned drafter goes on leave. Day 8, day 15, day 30 pass. No email, no bell row, no digest line is ever generated — because the only thing that knows the ticket is late is a red chip that renders if and only if a human opens /requests and scrolls to that row. Meanwhile the user's notification settings page told them, in their own words, that they had opted into "SLA warnings — A ticket you're responsible for is at risk of breaching its target completion date." The breach is invisible until someone in the field asks where the drawing is.

**Evidence.**

lib/notify/dispatch.ts:50-58 —
```
function categoryToEventType(c: NotifCategory): string {
  switch (c) {
    ...
    case "sla": return "sla_warning";
```
(no caller ever passes category "sla")

app/(protected)/settings/notifications/page.tsx:143 —
```
<PrefRow icon={AlertOctagon} title="SLA warnings" hint="A ticket you're responsible for is at risk of breaching its target completion date." on={prefs.email_on_sla_warning} ... />
```

app/api/cron/maintenance/route.ts:159-167 —
```
const scans: Array<[string, (orgId: string) => Promise<number>]> = [
  ["review-cycles", scanAndNotifyReviews],
  ["read-understood", scanAndNotifyAcks],
  ["pre-publish-review", scanReviews],
  ["effective-dates", scanEffectiveDates],
  ["retention", scanRetention],
  ["access-recert", scanAccessRecerts],
  ["distribution-acks", scanDistributionAcks],
];
```

**Chain reaction.** Because there is also no ticket-aging scan, findings #3 (routing never re-runs) and #6 (orphaned REVISION_REQ) have no backstop: a request that falls out of everyone's attention feed has no clock that will ever pull it back in.

> **Verifier correction.** Accurate as an absence, but the SLA clock is not invisible to users, so this is a missing-feature/false-promise defect rather than a critical safety gap. The portal renders due state in three places, not two: app/(protected)/requests/page.tsx:1067-1076 (Past Due / Due Soon chip), :970 (mobile card due date) and :508 (`overdue: count(g.tickets, (t) => !!t.targetCompletionAt && new Date(...) < new Date())` — a per-group overdue tally), plus app/(protected)/requests/[id]/page.tsx:1756-1761. What is genuinely absent is any push producer.

**Done when.**

- [ ] A server-side scan over `tickets` (in app/api/cron/maintenance/route.ts's scan array, or its own cron) selects open tickets where `target_completion_at` is past or within the warn window and emits with `category: "sla"`, so `email_on_sla_warning` finally gates something real.
- [ ] The SLA recipient set is the role pool responsible for the ticket's CURRENT status (via a fixed resolveTicketRecipients), not just requester/drafter — an overdue PENDING_ASSIGNMENT ticket has no drafter to nag.
- [ ] A test asserts that a ticket with `target_completion_at` in the past and status not in (CLOSED, CANCELED) produces exactly one notification per scan run per recipient (i.e. the scan is idempotent across daily runs).
- [ ] Either `sla_defaults` is read to seed per-org SLA windows, or the table and the `DEFAULT_SLA_DAYS` comment referencing it (lib/notifications.ts:235) are reconciled so the code does not describe a configuration surface that does not exist.

**Partial (2026-10-13, drafting-flow Round G).** DF-P3 ROUTING, base `5378ccb` — the build is `GAP-106`, recorded in full on `EDGE-7` (same root cause): `lib/ticketSla.ts` + step 5b of `app/api/cron/maintenance/route.ts:351`.

**Done-when.**
1. ✓ A server-side scan in the maintenance cron selects open tickets whose target is past or within the warn window (75 %) — soonest-due first, so the cap on what one run reads never starves a breach (fix pass; the first version restarted from the lowest id each run and never reached a due ticket past its 2000-row cap; see `EDGE-7`) — and emits with `category: "sla"`, so `email_on_sla_warning` gates something real (`lib/notify/dispatch.ts` maps `sla` → `sla_warning`; `lib/notificationPrefs.ts` honours it).
2. ✓ The recipients are the party the CURRENT status waits on plus its routed pool (`LEAK-1`'s resolver), the queue when nobody is named — an overdue `PENDING_ASSIGNMENT` ticket goes to the queue, not a drafter (`lib/__tests__/ticketSla.test.ts`).
3. ✓ A ticket past its target produces exactly one notice per recipient per stage across runs (stamped compare-and-set; `ticketSla.test.ts` "a second run the same day sends nothing", "later runs read nothing"; bell rows that fail while the email is queued keep the claim, so the email is not re-sent daily).
4. ✗ in part — the scan reads `sla_defaults` for a ticket with no target, but creation does not seed from it and `lib/notifications.ts:321`'s "first fallback when an org hasn't configured sla_defaults rows" comment still describes a lookup creation never makes. **Owner: DF-P2** (the create route stamps from `sla_defaults` first, and corrects the comment).

**Scope / residual.** Done-when 4 → DF-P2 (see `EDGE-7`). *Fix pass 2:* the clock starts at the first paste of `20261195`, which records the backlog already past its target without a notice each (one summary to each queue); before the paste the scan sends nothing and counts that backlog; step 5b stops 120 s before the run's end; a request waiting on its requester is worded as such (see `EDGE-7`).

**Resolution (2026-10-13, drafting-flow Round G).** DF-P4 LIBRARY — done-when 4 (re-owned from the merged DF-P2). The create route seeds the due date from the org's `sla_defaults` row for the type before `DEFAULT_SLA_DAYS` (`app/api/tickets/create/route.ts:607-632`, recorded in full on `EDGE-7`), and the comment above `DEFAULT_SLA_DAYS` (`lib/notifications.ts`) now says the create route reads `sla_defaults` first and the clock never applies the built-in window retroactively. Tests: `lib/__tests__/ticketCreateRoute.test.ts` ("DF-P4 — EDGE-7 done-when 2 / ROUTE-9 done-when 4"). *DF-P4 fix pass:* `sla_defaults` is writable by every active member (`20260605` `sla_defaults_member_all`, FOR ALL) and `default_days` has no CHECK, so the value is bounded where the create route reads it — `lib/notifications.ts` `boundedSlaDays` admits a whole number of days from 1 to `SLA_DEFAULT_DAYS_MAX` (3650), and anything else (2e9 — which threw a `RangeError` and failed every request of the type with a 500 — 0, negative, fractional, text) is the built-in window, the computation itself wrapped the same way (`app/api/tickets/create/route.ts:607-632`; tests: "a member-written default_days outside 1..3650 …", "boundedSlaDays"). Who may write the table is the new [`EDGE-16`](./13-edges-and-invariants.md#edge-16) (owner admin-and-org).

**Done-when.**
1. ✓ Unchanged (DF-P3) — the clock starts at the first paste of `20261195` (pending), as recorded.
2. ✓ Unchanged.
3. ✓ Unchanged.
4. ✓ `sla_defaults` is read to seed per-org SLA windows — at creation (this package) and by the scan (DF-P3) — and the comment no longer describes a lookup the code does not make.

**Scope / residual.** An admin editor for `sla_defaults` is `EDGE-7` done-when 2's remainder (admin-and-org); it is not a done-when of this finding.

---

<a id="route-10"></a>

## ROUTE-10 · Ticket routing matches only the headline role column, so a person who holds DraftingSupervisor in their additive roles[] is never routed to — and the fallback then spams every Admin

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/ticketRouting.ts:33`, `lib/ticketRouting.ts:79`, `lib/ticketRouting.ts:90`, `lib/notify/recipients.ts:48`, `supabase/migrations/20260722_member_roles_collection.sql:12`, `app/(protected)/admin/users/page.tsx:136`
- **Same root cause as** `ROUTE-8`, `EDGE-6` — Also owned as `LEAK-2` in [`04-flow-leaks.md`](./04-flow-leaks.md). Settled by `DEC-1` — do that first and these collapse. Fix once; close the rest citing this one.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the scenario is exact: supabase/migrations/20260722_member_roles_collection.sql:12-13 adds the additive `roles` column, app/(protected)/admin/users/page.tsx:130-137 writes `{ roles: cleaned, role: primaryRole(cleaned) }`, and ROLE_RANK (lib/roleCapabilities.ts:76,78) puts Manager 90 above DraftingSupervisor 75 — so ['Manager','DraftingSupervisor'] stores headline 'Manager', byRole('DraftingSupervisor') returns [], and every drafting request falls back to the whole Admin pool.

**Mechanism.** `org_members` carries an additive `roles TEXT[]` collection alongside the headline `role` column, and `role` is mirrored to the HIGHEST-RANKED role in the collection (lib/roleCapabilities.ts:120-123, persisted at app/(protected)/admin/users/page.tsx:136-137). `lib/ticketRouting.ts` — the module whose own header calls itself "the single seam" for "who needs to know?" — never reads that array: `listActiveMembers` selects `"uid, role, display_name, email"` (line 34) and `byRole` compares `m.role === r` (line 79). `grep -n roles lib/ticketRouting.ts` returns zero hits; the file is structurally incapable of seeing the collection. The sibling resolver `resolveRoleRecipients` in lib/notify/recipients.ts:48-62 DOES fold both (`const held = m.roles && m.roles.length > 0 ? m.roles : m.role ? [m.role] : []`), but it is only ever called by lib/holds.ts:252 and lib/branches.ts:148 — never by the drafting flow. Because ROLE_RANK puts Admin(100)/Manager(90)/Supervisor(80) above DraftingSupervisor(75), any member who holds DraftingSupervisor *plus* one of those has headline `role` = the higher one, so `byRole("DraftingSupervisor")` returns [] and `supervisorTargeted()` takes the `supervisors.length === 0` branch.

**Failure scenario.** A workspace names its Maintenance Manager as the drafting supervisor by stacking roles: roles = ['Manager','DraftingSupervisor'], headline role = 'Manager'. From then on every new drafting request — portal, check-in, and intake-collision — resolves `byRole("DraftingSupervisor") = []`, falls through to `return admins`, and blasts the whole Admin list while the person who actually runs the assignment queue receives nothing at all. That is precisely the failure the file's header says it exists to prevent ("instead of being broadcast to every Admin in the workspace"). The requests then sit in PENDING_ASSIGNMENT with the responsible human uninformed and the informed humans assuming it isn't theirs.

**Evidence.**

lib/ticketRouting.ts:33-40 —
```
  const { data, error } = await supabase
    .from("org_members")
    .select("uid, role, display_name, email")
```
lib/ticketRouting.ts:79 —
```
  const byRole = (r: Role) => members.filter((m) => m.role === r);
```
lib/ticketRouting.ts:90-94 —
```
  const supervisorTargeted = (): MemberLite[] => {
    const supervisors = byRole("DraftingSupervisor");
    if (supervisors.length === 0) return admins;
```
contrast lib/notify/recipients.ts:57-60 —
```
    const held = m.roles && m.roles.length > 0 ? m.roles : m.role ? [m.role] : [];
    if (held.some((r) => want.has(r))) out.add(m.uid);
```

**Chain reaction.** Same root cause as finding #7 (drafter picker). The engineer picker was already fixed for this exact bug (components/requests/EngineerPickerModal.tsx:77-89 has the additive comment and logic), so this is a half-completed migration, not an unknown.

> **Verifier correction.** The routing defect is real, but the affected supervisor is not blind to the work: the attention layer IS additive-role-aware, so a stacked-role DraftingSupervisor still sees the ticket. hooks/useTicketNotifications.ts:135 pulls `roles` (the additive collection) from RoleContext and passes it to isActionRequired at line 253; lib/ticketAttention.ts:84-93 flags PENDING_ASSIGNMENT for any MANAGEMENT_ROLES holder (which includes DraftingSupervisor, lines 22-27) — so the sidebar badge, bell and /inbox all surface it, and app/(protected)/requests/page.tsx:344-347 gives Manager/Admin/Supervisor/DraftingSupervisor a PENDING_ASSIGNMENT queue tile. Also, when the stacked role is Admin, the admin fallback still reaches them. The real harm is mis-targeted email/bell fan-out plus admin noise, not a lost queue.

**Done when.**

- [ ] `listActiveMembers` selects `roles` and exposes the effective collection; `byRole` matches against the union of headline + additive roles (or resolveTicketRecipients delegates to `resolveRoleRecipients`, which already does this correctly).
- [ ] `resolveTicketRecipients` distinguishes "no DraftingSupervisor is configured in this org" from "a DraftingSupervisor exists but their headline role outranks the token" — only the former should fall back to Admins.
- [ ] A test seeds a member with `role: 'Manager', roles: ['Manager','DraftingSupervisor']` and asserts resolveTicketRecipients(org, 'PENDING_ASSIGNMENT') returns that member and NOT the Admin fallback list.

**Resolution (2026-10-02, drafting-flow Round G).** Record-only close by pointer to roles-and-permissions [`ADD-1`](../roles-and-permissions/04-additive-roles.md) (`bcb959d`) with the evidence on [`LEAK-2`](./04-flow-leaks.md), re-verified against `f1ac550`: `lib/ticketRouting.ts:53` selects `roles`, `:58` maps `roles: heldRoles(m)`, `:99` matches the held collection.

**Done-when.**
- ✓ `listActiveMembers` selects `roles` and exposes the effective collection; `byRole` matches headline ∪ additive (`heldRoles`, `lib/roleHeld.ts`).
- ✓ "No DraftingSupervisor configured" and "one exists under a higher headline" are now distinct by construction — the second is found by the collection match, so only the first reaches the Admin fallback (`lib/ticketRouting.ts:106-110`).
- ✓ A test seeds `role: 'Manager', roles: ['Manager','DraftingSupervisor']` and asserts `resolveTicketRecipients(org, 'PENDING_ASSIGNMENT')` returns that member, not the Admin list (`lib/__tests__/ticketRouting.test.ts:96`).

**Scope / residual.** The drafter *picker* on the ticket page still filters `.eq('role','Drafter')` — that is `ROUTE-8` / `EDGE-6`, DF-P9.

---

<a id="route-11"></a>

## ROUTE-11 · Ticket-creation notifications carry no metadata.action/status, so neither the server supersede nor the client reconcile ever retires them

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/new/page.tsx:352`, `app/api/tickets/workflow-action/route.ts:329`, `hooks/useTicketNotifications.ts:188`, `app/api/tickets/workflow-action/route.ts:347`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves. Creation rows carry neither metadata.action nor metadata.status, so they are excluded from the supersede UPDATE and from the staleness reconcile, and once the ticket closes it also drops out of the ticket feed (line 156 `.neq('status','CLOSED')`) so the row can no longer even be folded into a live ticket item at line 283. Only a manual click or mark-all-read retires them.

**Mechanism.** Two independent mechanisms retire stale "act on this ticket" alerts, and both key on the same marker. Server-side, `fanOut` supersedes rows with `.not("metadata->>action", "is", null)` (route.ts:325-329). Client-side, the attention hook selects workflow rows requiring `typeof r.metadata.status === 'string' && r.metadata.action != null` (hooks/useTicketNotifications.ts:188-193) before marking them read. Transition notifications satisfy both because fanOut writes `metadata: { action: action.type, status: newStatus }` (route.ts:347). But the CREATION notification writes `metadata: { request_type: requestType, priority, unit }` (requests/new/page.tsx:352) — no `action`, no `status` — and the transitionIn and CheckInPanel creation paths pass no metadata at all. Those rows therefore match neither retirement mechanism.

**Failure scenario.** A drafting supervisor accumulates 'New drafting request: … Ready for a drafter to be assigned.' bell rows. Each ticket is assigned within the hour, drafted, approved and closed — and every one of those creation rows stays unread and un-superseded forever, inflating the badge with items whose stated ask ('Ready for a drafter to be assigned') has been false for months. The only way to clear them is manual mark-all-read, which also discards live alerts.

**Evidence.**

app/(protected)/requests/new/page.tsx:344-353 —
```
            kind: 'request_pending_approval',
            title: `New drafting request: ${title}`,
            body: 'Ready for a drafter to be assigned.',
            ...
            metadata: { request_type: requestType, priority, unit },
```
app/api/tickets/workflow-action/route.ts:325-329 —
```
    await supabaseAdmin.from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("resource_id", ticketId)
      .is("read_at", null)
      .not("metadata->>action", "is", null);
```
hooks/useTicketNotifications.ts:188-193 —
```
        const workflowRows = n.filter(
          (r) => r.resourceId
            && r.metadata
            && typeof r.metadata.status === 'string'
            && r.metadata.action != null,
        );
```

**Chain reaction.** Secondary: the same emit hard-codes the body 'Ready for a drafter to be assigned.' regardless of `initialStatus`, so the copy would also be wrong if the PENDING_ENG_INITIAL creation branch in lib/ticketRouting.ts:98 ever became reachable.

> **Verifier correction.** One citation is off by one: the creation metadata line is app/(protected)/requests/new/page.tsx:353 (`metadata: { request_type: requestType, priority, unit }`); line 352 is `audience: { involved: ... }`. The quoted code itself is present and the reasoning is unaffected. Worth adding that the row is not entirely un-retirable — a recipient opening the bell/inbox can mark it read (hooks/useTicketNotifications.ts markRead/markAllRead) — so this is lingering-noise, not a permanently stuck badge.

**Done when.**

- [ ] All three ticket-creation notification paths stamp `metadata: { action: 'created', status: <initialStatus> }` (plus any extras) so both retirement mechanisms recognise them.
- [ ] A test asserts that after a ticket transitions out of its creation status, no unread creation notification for that ticket remains.

**Resolution (2026-10-07, drafting-flow Round G).** DF-P2 CREATE. The three doors now write one creation notice, from the route, and it carries the marker both retirement mechanisms key on: `app/api/tickets/create/route.ts` `announce()` emits with `metadata: { action: "created", status: "PENDING_ASSIGNMENT", request_type, priority, unit }` (`:1021-1027`). The title and body come from `lib/ticketCreate.ts` `creationNotice`, the only producer of the notice text (census), worded per door — "Ready for a drafter to be assigned." for the form and a check-in, the collision's own sentence for an intake collision — so the body says what the creation status asks.

**Done-when.**
- ✓ All three creation paths stamp `metadata.action` and the creation status — one notice, one producer (`lib/__tests__/ticketCreateClient.test.ts`, "the creation notice is written only by the route"; `lib/__tests__/ticketCreateRoute.test.ts`, "bell rows carry metadata.action and a string status").
- ✓ `lib/__tests__/ticketCreateRoute.test.ts`, "once the ticket leaves PENDING_ASSIGNMENT (a supervisor assigns it, through the real workflow route), no creation alert is left live in any bell": the route drives `POST /api/tickets/workflow-action` `assign`, and every creation row is superseded (`superseded_by: "assign"`), none unread and live.

**Scope / residual.** None for creation. Re-entry into `PENDING_ASSIGNMENT` is `ROUTE-5`'s (DF-P3).

---

<a id="route-12"></a>

## ROUTE-12 · The request queue reads its scope in one unpaged request, so above PostgREST's max-rows the oldest-modified requests — the stalled ones — vanish from the queue, its Needs-me lens and its counts without a word

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS — by the integrator at the DF-P9 merge, 2026-10-14. *Was:* proposed — drafting-flow, the next package that holds `app/(protected)/requests/page.tsx` (the integrator assigns, `DEC-31`: a remainder is a new id with an owner) — opened by drafting-flow DF-P9's integrator fix pass, 2026-10-14, while correcting `EDGE-3`'s scope line (which had pointed at this read as the place the badge's unevaluated requests can still be found).
- **Verification:** CONFIRMED (by reading; not exercised against a live database)
- **Independently verified:** — (`author`: opened at the DF-P9 integrator fix pass; the cited lines re-read there; not yet challenged by a second party).
- **Blast radius:** attention / visibility
- **Locations:**
  - `app/(protected)/requests/page.tsx:386-388` — the management / engineer / DocCtrl scope: `supabase.from('tickets').select('*').eq('org_id', activeOrgId)` (the terminal filter only when closed rows are excluded) `.order('last_modified', { ascending: false })` — no `range`, no paging, and the read's `error` is not read
  - `app/(protected)/requests/page.tsx:340` — `includeClosed` is true in the default view (the status filter starts at "Any", `ALL`), so the default scope is every request the workspace has ever had
  - `app/(protected)/requests/page.tsx:391-394` — the Drafter scope: two unpaged, unordered reads (assigned; the pool)
  - `app/(protected)/requests/page.tsx:402-404` — the requester scope: one unpaged read
- **Related:** `ROUTE-7` / `EDGE-3` (the badge's own scope, paged since N4 / DF-P9), `EDGE-6` (the drafter picker's member read, keyset-paged at the same fix pass)

**Mechanism.** PostgREST answers every request with at most the project's max-rows (Supabase's default is 1000). The queue asks for its whole scope in one request and treats what comes back as the scope: the response stops at the cap with no error and nothing marks it short. Ordered newest-modified first, the rows past the cap are the least recently touched — a request that has stalled for months. Because the default view includes closed and canceled requests, a workspace crosses the cap once it has about 1000 requests in its whole history, not 1000 open ones.

**Failure scenario.** A plant workspace has 1,400 requests since go-live, 120 of them open. A `PENDING_REVIEW` request untouched since spring is the 1,150th most recently modified row. The supervisor's queue — the table and cards, the by-drafter board, "All N", "Needs me", the Action Required tile, the header's "N Total Records" — never shows it, and nothing says the list was cut. The attention badge does count it (`ROUTE-7` / `EDGE-3`), so the bell leads to a request the queue cannot find.

**Chain reaction.** The same read ignores its `error`: a refused or failed read shows an empty queue ("No matching tickets found") rather than saying the list could not be loaded. The Drafter scope's two reads have no order, so even below the cap their order is the database's.

**Remediation.** Read each scope in pages that carry on from the last row received — keyset on (`last_modified`, `id`), or range pages continued until a page adds nobody — never assuming the server returned the page size asked for (the drafter picker's reader, `lib/ticketPickerMembers.ts`, is the pattern); read each page's `error` and say a failed read; keep the Needs-me lens computing over the full scope. If the full history is too large to hold, bound the default view to open requests and page closed ones on demand, and say how many of how many the list shows.

**Done when.**

- [ ] The queue's list holds every row of its scope whatever PostgREST's max-rows is, or says plainly that it shows N of M.
- [ ] A failed read is said, never an empty queue.
- [ ] A rendered test with more rows than one page asserts an old, untouched request appears in the list and, when it needs the viewer, in Needs me.


**Resolution (2026-10-14, drafting-flow Round G).** DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS, under the integrator's ruling (`DEC-90`: the queue's scope reads page until a short page, ordered, and a failed page fails the read visibly — never a short or empty queue shown as complete), with its review fix pass. **Reproduced first on `9b52f56`** with the rendered tests below against a PostgREST stand-in that serves at most 1,000 rows per request: the supervisor's queue over 1,400 requests showed "Needs me 0" and "All 1000", the April request absent; a requester's 1,200 showed "All 1000"; a Drafter's two scopes showed 1001 of 1201; a refused read said nothing.
- **`lib/ticketQueueRead.ts` (new) `readQueueScope(build)`** — the drafter picker's keyset pattern (`lib/ticketPickerMembers.ts`): ordered `last_modified` DESC (NULLs first, as PostgreSQL already put them for this order) with `id` DESC breaking ties; every page after the first asks, through one `or` logic tree, only for the rows strictly after the last row received, so a page the server shortened to its own max-rows skips nobody; the first page carries an exact count; the read stops at the count or at a page that adds nobody — **never at a short page on its own** (review fix pass: with no count — an old server, a proxy that drops `Content-Range` — and a max-rows below the page size, every page is short, and the first draft stopped after it and called the read complete; it now reads on until a page adds nobody, one request more than the rows need); each request is kept once, and a page that came back with rows yet added nobody (a server that ignored the keyset) ends the read as NOT complete (`:127`). **A failed page fails the whole read** (`{ ok: false, error }`). Bounded at `QUEUE_READ_CEILING` (10,000 rows): a read stopped there, or one that ends with fewer rows than its count (requests changed while it was read), answers `complete: false` with the count.
- **`app/(protected)/requests/page.tsx`** (the scope reads, `fetchTickets`): each scope — management / engineer / DocCtrl, the Drafter's two (assigned; the pool), the requester's — is read through `readQueueScope` with the same select, filters and terminal-status rule as before (the count on the first page, the `id` tie-break added); the Drafter merge and its client-side terminal filter are unchanged. **At the ceiling the open requests are read on their own** (review fix pass, `readScope` `:428`): a scope that holds closed requests and stops at 10,000 rows (newest-modified first — recently touched closed requests push old open ones past the cap) is read a second time with the terminal filter, and the two are merged, each request once — so every open request, Needs me, the Action Required tile and every count of open work stay whole whatever the history holds; only closed history is bounded, and the banner says exactly that ("Every open request in this view is listed, with the N most recently active closed or canceled ones — M requests in all … Older closed and canceled requests are not listed here", `:1346`); were the open scope itself past the ceiling, the banner says N of M and to choose an open status. **Only the latest read is applied** (review fix pass, `readSeqRef` `:369`): every read is numbered and its answer — rows, fault, short notice, scope, time — lands only if no later read has started, so a realtime event during a multi-page read can never put a stale "could not be refreshed" over a fresh list, nor let a stale list clear a real failure. A failed read replaces nothing: with no successful read **for this scope** (workspace, member, roles, closed toggle — `listScopeKey`) the list's place shows "The request list could not be read" with the reason, **Try again** and **New Request** (`data-testid="requests-read-failed"`, `role="alert"`, `:1470`) and no count derived from rows (the tiles, the urgent banner and bulk actions are held back; Needs me / All read "—"; the header says "Total records unknown") — and, review fix pass, **the page shell stays** (`listUnread` `:1166`): the header, the filter bar, the status filter, Show Closed and the view switcher, so a failure confined to the default whole-history scope never locks the user out of a narrower one; the notice says to choose an open status, which reads only open requests (`requests-read-failed-narrow`). After a successful read for the same scope the list stays, with an alert that it "could not be refreshed — … What is shown is the list as last read at HH:MM, and may be out of date" and **Try again** (`:1332`). A read that ended short says so (`data-testid="requests-read-short"`, `:1342`: N of M when requests changed mid-read; "the total could not be counted, so more may exist" when no count came back and the read could not finish). The exception path also sets the notice. **The header's "Refresh Data" re-reads the list** (review fix pass, `handleRefresh` `:888`; it only spun before, so a dropped realtime channel left the list stale behind a button that seemed to refresh it).
- **The same defect on the dashboard, fixed here** (review fix pass; `components/dashboard/widgets.tsx` is in DF-P14's file list): the Drafting Requests widget counted open requests from one `.limit(2000)` read whose error went unread, so above 2,000 open requests its "N open requests" and pipeline bar undercounted in silence. `DraftingRequestsBody` now reads the open scope through `readQueueScope` (`:450`) with its exact count; a failed count shows "—" and says it could not be counted (`drafting-open-count-fault`), never 0; a bar that counts fewer than the count says so (`drafting-open-count-partial`).
- **Review fix pass 2** (line numbers above re-pointed to this pass's file). (a) **Realtime re-reads are coalesced** (`fetchTickets`'s effect, `coalescedRead` / `onTicketsEvent` `:514-523`): the org-filtered tickets listener no longer starts a full scope read per event (a bulk close of 20 requests was 20 overlapping multi-page reads per open tab); while a read it started is in flight, further events only mark the list dirty, and when the read settles ONE trailing read runs if anything arrived meanwhile — a burst costs at most two reads. Explicit reads (Try again, Refresh Data, the stale-row re-read after a mark urgent or bulk action) still go straight to `fetchTickets`, and `readSeqRef` still applies only the latest answer. (b) **Export CSV never writes an unread list as the queue** (`handleExportCSV` `:852`, the header button `:1193-1198`, `requests-export-csv`): while the list could not be read for this scope (`listUnread`) both Export buttons are disabled, the header one says why, and the handler refuses; when the list is short (`listShort`) the file's name says so, `drafting_export_<time>_partial_<N>_of_<M or uncounted>.csv`, as the banner does. A whole list's file is named exactly as before.
- **Tests:** `lib/__tests__/dfRoundG_P14_queueRead.test.ts` — the pager (1,400 rows behind a 1,000-row cap: every row once, in order, in two pages; a server whose max-rows is 250: still every row; ties on `last_modified` and NULL `last_modified` rows across 3-row pages; a failed second page fails the read; **no count and max-rows 250 → every row, ended by a page that adds nobody; no count and a server that ignores the keyset → not complete**; the ceiling says N of M; a server that ignores the keyset cannot loop it) and the page AS RENDERED (1,400 requests: the spring request in the list, in Needs me, the Action Required tile, "All 1400", "1400 Total Records"; a failed page is said with Try again and no empty-state text, and Try again reads the full list; a refresh that fails keeps the last list and says so; a failure after switching workspace shows the full notice and none of the previous workspace's rows; the requester's 1,200 and the Drafter's 1,201 read whole, ordered; a short read says N of M; **the default scope failing on every attempt keeps the filter bar, and choosing an open status reads the open list; at a test-sized ceiling the old open request is listed and in Needs me with the closed-history banner, and an open scope past the ceiling says N of M; two overlapping reads resolving out of order apply only the latest, both ways; Refresh Data re-reads**; **REGRESSION:** a normal workspace is read in ONE request with the same scope filters and lists exactly the same rows). `lib/__tests__/dfRoundG_P14_labels.test.ts` — the widget AS RENDERED: 2,400 open requests counted over keyset pages (the old read stopped at 2,000), a max-rows of 250, a failed count said. Every review-fix-pass test above was run against the pre-fix code first and failed there. **Review fix pass 2:** a burst of five tickets events during a gated read makes exactly two reads (the gated one and one trailing read, which lands the latest list), then one event one read; an unread list's Export CSV is disabled and saves nothing; a short list's file is named `…_partial_2_of_3.csv`; a whole list's name is unchanged — each failed on the pre-pass page. The two overlapping-read tests now start their second read with Refresh Data (an explicit read, not coalesced), since a second realtime event during a read no longer starts one. The widget test's PostgREST stand-in honours `.limit()` on the recent-requests read (it returned all 2,400 rows, which jsdom rendered as links, and the test ran past vitest's 5 s default on a loaded machine and failed the two tests after it); that test also carries an explicit 30 s timeout. `lib/__tests__/dfRoundG_P9_requestsQueue.test.ts` (every DF-P9 queue test) green; its PostgREST stand-in now answers the exact count the list read asks for, as PostgREST does (without one the reader correctly reads on for a page that adds nobody, which that stand-in, having no keyset, could not serve), and `lib/__tests__/sweepRoundE_A.test.ts`'s source census counts the terminal filter in the queue page three times (the open-scope read).

**Done-when.**
- ✓ The queue's list holds every row of its scope whatever PostgREST's max-rows is — with or without a count (pager tests at caps of 1,000 and 250, and at 250 with no count; rendered at 1,400 / 1,200 / 1,201) — **or** says plainly that it shows N of M (a read that fell short of its count, or one that could not finish — rendered); past the 10,000-row ceiling every open request is still held and the banner says only older closed history is not listed (rendered at a test-sized ceiling).
- ✓ A failed read is said, never an empty queue (rendered: the first read failing at its second page; a later refresh failing; a stale failure never covering a fresh list), and the filter bar stays so a narrower scope can be read.
- ✓ A rendered test with more rows than one page asserts an old, untouched request appears in the list and, when it needs the viewer, in Needs me (the supervisor's assignment; the requester's review; the Drafter's pool request found by search; at the ceiling, the oldest open request behind 50 newer closed ones).

**Ruled by the integrator at the DF-P14 merge, 2026-10-20 (DEC-90)** — two of the final review's minors, built at the integrator fix pass (`app/(protected)/requests/page.tsx`; `lib/__tests__/dfRoundG_P14_queueRead.test.ts`, "DF-P14 integrator rulings (3) and (4)", each failing on the pre-pass page). **(3) The export's file name says only what the file holds:** the `_partial_N_of_M` suffix's N is the rows written (`filteredTickets.length`, the filtered list the file holds), not the rows read; and no suffix is added when the file cannot be missing a row — every open request was read (`listShort.openComplete`, now exact: each scope read whole, or stopped at the ceiling with its open requests read whole on their own — a read short for any other reason no longer counts) and the status filter is one open status with Show Closed off (`exportWhole`, `handleExportCSV` `:921`). Rendered: a 3-of-4 list exports `_partial_3_of_4`, its Drafting-only view `_partial_2_of_4`; a Drafter's capped list filtered to Drafting exports with no suffix, and the same list at Any status keeps it. **(4) The Drafter's short-read banner never sums overlapping counts:** the Drafter's list is two scope reads (assigned; the pool) whose counts overlap (a request assigned to them and back at Awaiting drafter is in both), so the list's `total` is one scope's exact count or none (`total` / `merged` `:489-495`), and the Drafter's banners name no M — "This list shows the N most recent requests in this view — the list is longer than one read" when a scope stopped at the ceiling, "… the list may be longer than what was read" when it fell short otherwise (`:1391`); every other role's banner is unchanged (REGRESSION test: "shows 2 of the 3 requests"). **The dashboard widget's count** (the bullet above) is re-built at the same pass as exact HEAD counts and recorded as its own finding, `ROUTE-14` (LOW, RESOLVED) — the keyset read above was correct but held up to 10,000 rows for a number.

**Scope / residual.** Recorded as a new finding, `ROUTE-13` (LOW, OPEN, owner proposed — `DEC-31`): closed and canceled requests past the 10,000-row ceiling cannot be reached in the page (choosing Closed or Canceled reads the same most recent ones), and (as first recorded) every tickets event re-read the whole scope — met here at review fix pass 2: a burst now costs at most two reads per tab (above), recorded under `ROUTE-13`'s second done-when. Remediation's second sentence (bound the default view to open requests and page closed history on demand) is that finding's. Nothing else remains of this finding: the header's Refresh Data and the dashboard widget's capped count, listed here as residual in the first draft, are fixed above.


---

<a id="route-13"></a>

## ROUTE-13 · The request queue's default view holds the workspace's whole history: closed requests past the 10,000-row ceiling cannot be reached in the page, and every tickets event re-reads the whole scope

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P16 QUEUE HISTORY AND OUTCOME BREAKDOWN — by the integrator at the DF-P14 merge, 2026-10-20. *Was:* the integrator assigns at the DF-P14 merge (done-when 1, closed history on demand; no package holds it yet — listed in the DF-P14 integrator fix pass report, 2026-10-20). *Was:* proposed — drafting-flow, the next package that holds `app/(protected)/requests/page.tsx` (the integrator assigns, `DEC-31`: a remainder is a new id with an owner) — opened by drafting-flow DF-P14's review fix pass, 2026-10-14, as `ROUTE-12`'s remainder.
- **Verification:** CONFIRMED (by reading and by the rendered tests in `lib/__tests__/dfRoundG_P14_queueRead.test.ts`; not exercised against a live database)
- **Independently verified:** — (`author`: opened at the DF-P14 review fix pass from the reviewer's finding; not yet challenged by a second party).
- **Blast radius:** visibility / performance
- **Locations:**
  - `app/(protected)/requests/page.tsx:356` — `includeClosed` is true in the default view (the status filter starts at "Any", `ALL`) and for Closed / Canceled, so those scopes read every request of the workspace's history, newest-modified first
  - `lib/ticketQueueRead.ts:44` — `QUEUE_READ_CEILING` (10,000 rows): past it a scope read stops; `app/(protected)/requests/page.tsx:428` (`readScope`) then reads the open requests on their own, so only closed history is bounded
  - `app/(protected)/requests/page.tsx` — the realtime listener (`postgres_changes` on `tickets`, org-filtered) called `fetchTickets()` for every change in the workspace: a full keyset re-read of the scope with an exact count, per open tab. *Coalesced at DF-P14's review fix pass 2* (`coalescedRead` / `onTicketsEvent` `:514-523`): at most one read in flight plus one trailing read per burst — see the Partial below.
- **Related:** `ROUTE-12` (RESOLVED — this is its remainder), `ROUTE-7` (the attention feed's oldest-first reading)

**Mechanism.** The default view and the Closed / Canceled filters read the whole history of the workspace. Above 10,000 requests in such a view the reader stops at the 10,000 most recently modified; DF-P14's fix pass reads the open requests on their own, so open work is whole, but the older closed and canceled requests are simply not in the page — choosing Closed or Canceled reads the same newest-first slice, and search filters only what the page holds. Separately, every change to any request of the workspace starts a fresh read of the whole scope; below 1,000 rows that is one request, as before, but near the ceiling it is up to ten pages plus an exact count over the full history, per open tab, per event (overlapping reads are safe since the fix pass — only the latest is applied — but they are not coalesced).

**Failure scenario.** A workspace with 14,000 requests in its history: someone looking for a request closed eighteen months ago to pull its old drafts or reopen it (the reason the Show Closed toggle exists) cannot find it in the queue — the banner says older closed requests are not listed, and nothing in the page reaches them. During a busy shift with several supervisors' tabs open, a burst of ticket changes starts several ten-page reads in each tab.

**Remediation.** Bound the default view to open requests and read closed history on demand — a "closed requests" view paged oldest-first or by range with its own N-of-M, or a server-side search over closed requests; coalesce realtime re-reads (debounce a burst, or apply the changed row instead of re-reading the scope).

**Done when.**

- [ ] Any closed or canceled request of the workspace can be reached from the queue, whatever the history holds.
- [ ] A burst of ticket changes starts at most one re-read per tab (or re-reads nothing and applies the changed rows), with a test.

**Partial (2026-10-14, drafting-flow Round G).** DF-P14's review fix pass 2 coalesced the realtime re-reads (`app/(protected)/requests/page.tsx` `coalescedRead` / `onTicketsEvent` `:514-523`): while a read the listener started is in flight, further tickets events only mark the list dirty, and when it settles one trailing read runs if anything arrived — so a burst of any size costs at most two reads per tab (the read already running and one trailing read), where it was one full read per event. Explicit reads (Try again, Refresh Data, a stale-row re-read) are not coalesced; `readSeqRef` still applies only the latest answer. Test: `lib/__tests__/dfRoundG_P14_queueRead.test.ts`, "a burst of tickets events during a read is coalesced — five events cost at most two reads" (failed on the pre-pass page).

**Done-when (status at this Partial).**
- [ ] Any closed or canceled request can be reached from the queue — not done; the default view still reads whole history and stops at the ceiling for closed history (owner as above).
- ✓ in substance — a burst of ticket changes starts at most one re-read per tab *after the read already in flight* (one trailing read for the whole burst), with a rendered test. Applying changed rows instead of re-reading, which would remove even that read, is not built.

**Ruled by the integrator at the DF-P14 merge, 2026-10-20 (DEC-90)** — done-when 2 is implemented as written, not "in substance": the realtime listener is now a **trailing debounce** of 500 ms (`REALTIME_SETTLE_MS`, `app/(protected)/requests/page.tsx:106`; `onTicketsEvent` / `onSettled` `:548-561`) on top of the in-flight coalescing above — an event only (re)arms the timer, so a burst of events starts ONE read after it settles; an event during an in-flight read still costs one trailing read when that read settles; a stream that never settles cannot starve the list (a read starts at most 5 s, `REALTIME_MAX_WAIT_MS`, after the first unread event — fail-safe, beyond the ruling's letter); the timer is cleared when the page goes away. The first read on mount, Try again and Refresh Data stay immediate (`fetchTickets`; `readSeqRef` applies only the latest answer). Tests (rendered, fake timers; `lib/__tests__/dfRoundG_P14_queueRead.test.ts`, "ROUTE-13 done-when 2 …"): a burst of 5 events 100 ms apart makes no read for 499 ms after the last and exactly ONE read at 500 ms, which lands the latest list, then nothing for 10 s; an event during a gated in-flight read makes exactly one trailing read; Refresh Data and Try again read with no time passed; events every 400 ms for 5.2 s make one read; a pending re-read is dropped on unmount. The burst, max-wait and unmount tests fail on the pre-pass page (it read once per settled in-flight read, so a burst cost two). The four existing realtime tests (a failing refresh; the two overlapping-read tests) now let the 500 ms pass before asserting.

**Done-when (status at the DF-P14 integrator fix pass, 2026-10-20).**
- [ ] Any closed or canceled request can be reached from the queue — not done (owner: drafting-flow DF-P16, assigned at the DF-P14 merge).
- ✓ A burst of ticket changes starts at most one re-read per tab — one read after the burst settles, or one trailing read after a read already in flight — with rendered fake-timer tests (above).

**Scope / residual.** Stays OPEN for the first done-when (closed history on demand) — **Assigned:** drafting-flow DF-P16 QUEUE HISTORY AND OUTCOME BREAKDOWN (the integrator at the DF-P14 merge, 2026-10-20). Each re-read still carries the full scope (`select('*')` up to the ceiling), not measured.

**Resolution (2026-10-20, drafting-flow Round G).** DF-P16 QUEUE HISTORY AND OUTCOME BREAKDOWN, done-when 1, under the integrator's ruling (`DEC-90`, ruling (1): closed and canceled requests are reachable from the queue ON DEMAND — the open queue's read, counts, Needs-me lens, realtime debounce and exports stay exactly as today; the closed history is read only when asked, with the same keyset reader, the same failure and short-read wording, and the same Contractor scope). **Reproduced first on `d26c2d1`**: a workspace whose history passes the ceiling (test-sized: 450 closed / canceled requests touched recently, 3 open ones, and one closed eighteen months ago) lists only the 50 most recent closed requests, the banner says older ones are not listed, and nothing in the page reaches the old one (`lib/__tests__/dfRoundG_P16_queueHistory.test.ts`, "REPRODUCED …" — passes on both, by design; every other test in the file fails on the `d26c2d1` sources: 28 of 28 rendered and lib tests across the two new files).
- **The panel** — `app/(protected)/requests/page.tsx` `ClosedHistory` (`:207-350`), opened from the filter bar's **Closed history** toggle (`closed-history-toggle`, `:1646-1655`, beside Show Closed, so it stays reachable when the queue's own read failed) or from the ceiling banner's "Open Closed history" (`closed-history-from-banner`, `:1561`); rendered at the top of the content area (`:1697-1700`), keyed to the workspace, member and roles. It reads `CLOSED` and `CANCELED` (`TERMINAL_TICKET_STATUSES`, `.in('status', …)`) only while open, `HISTORY_CHUNK` (200) at a time, newest-modified first; **Show older** carries on from the last row shown, so nothing bounds how far back it reaches. A search over the request number and title (`historySearchFilter` — `ticket_id` / `title` `ilike`, quoted, `%` and `_` literal, at most 100 characters) and a "last active on or before" date (`historyBeforeCursor` — the keyset starts at the end of that calendar day) narrow it on the server. Each row links to the request and says its number, title, status in the shared words, how it ended (and the recorded reason) and when it was last active. It holds its own rows and subscribes to nothing: the queue's `tickets` state, counts, Needs me, the realtime listener and Export CSV never see them.
- **The same reader** — `lib/ticketQueueRead.ts` `readQueueScope` gains an optional `after` cursor (`:96`; a read that starts after a row asks for no count) and answers `cursor`, where it stopped (`QueueCursor`, `:53`; `stoppedAt`, `:155`); a read without `after` is exactly as before (the P14 tests are unchanged and green). `foldHistoryChunk` (`:225`) folds chunks — each request once, the first chunk's exact count, `next` while more may exist, `short` when it ended short of the count or the server ignored the keyset. A failed chunk is said ("The closed history could not be read — … Nothing is shown rather than a list that may be missing requests", or for a later chunk "The older closed requests could not be read — … What is listed is as read so far"), with Try again; a short read says "This list shows N of the M requests in this view — requests changed while it was being read. Refresh to read it again." (the queue's own wording).
- **The same scope** — the queue's role rule is now one helper, `readsWholeWorkspace` (`:189`), used by the open read (`:617`, the condition byte for byte as before) and the history: the workspace for Admin / Manager / Supervisor / DraftingSupervisor / DocCtrl / any Engineer, a Drafter's assigned requests, otherwise the member's own requests (a Contractor-only member falls there, as in the queue); and it reads as the signed-in member, so RLS — `20261166`'s Contractor-only read included — decides exactly as it does for the queue.
- **Tests:** `lib/__tests__/dfRoundG_P16_queueHistory.test.ts` (17): the reader (a read from the start as before and its cursor; `after` reaching the oldest row past any ceiling with no count asked; the fold; the search filter's quoting and escaping; the date cursor); rendered: nothing reads the history until it is opened; the old closed request reached through 200 → Show older → Show older (451, each once, no open request); **REGRESSION** — with the history open and paged, the queue's reads, Needs me, All, the total and the banner are unchanged, a tickets event re-reads the queue after the 500 ms debounce and never the history, and a normal workspace's queue is one read with no status filter; a failed first chunk and a failed Show older said, Try again recovering; a short read said; search by title and by number, nothing matching said; the date start; the scope for Requester, Contractor, Drafter, Manager and Engineer equal to the queue's own read; the toggle reachable when the queue's read failed.

**Done-when.**
- ✓ Any closed or canceled request of the workspace can be reached from the queue, whatever the history holds — on demand (ruling (1)): Closed history pages back without bound (Show older from the last row shown), with a server-side search and date start; rendered test above. *Not exercised against a live PostgREST:* the search sends a second `or` filter beside the keyset's; PostgREST ANDs repeated logic parameters (as the stand-in does), which a live check should confirm.
- ✓ A burst of ticket changes starts at most one re-read per tab — as at the DF-P14 integrator fix pass (unchanged here; the debounce tests in `dfRoundG_P14_queueRead.test.ts` are green, and the history adds no listener).

*Review fix pass (2026-10-20):* a Closed history row names the reason beside its outcome only when the reason was recorded with that outcome (`reasonForOutcome`, `components/requests/RequestOutcomes.tsx`; used at `app/(protected)/requests/page.tsx:313`) — a reopen leaves the old `metadata.outcome_reason` behind (drafting-flow [`SM-16`](06-state-machine.md#sm-16)), and a reopened-then-completed request no longer reads "Completed — <the old withdrawal reason>". Test: `dfRoundG_P16_queueHistory.test.ts` (now 18), "a row names its reason only when it was recorded with the outcome it has now".

**Scope / residual.** The default view still reads whole history up to the ceiling (ruling (1) keeps it exactly as today — bounding it was the remediation's first option, not the ruling's); the closed-history panel is a separate on-demand read and does not change the queue's counts, the Show Closed toggle or the Closed / Canceled status filters, which still read the most recent ones as before (the banner now points at Closed history). NULL `last_modified` rows are read first from the start, but a read started from a date skips them (they have no date to compare). No migration; no new table, column, capability or notification kind. Nothing remains of this finding.

---

<a id="route-14"></a>

## ROUTE-14 · The dashboard's Drafting Requests widget counted open requests from one read capped at 2,000 rows, so above that its count and pipeline bar undercounted without a word

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS — the integrator fix pass at the DF-P14 merge, 2026-10-20 (`components/dashboard/widgets.tsx` is in DF-P14's plan).
- **Verification:** CONFIRMED (by reading `9b52f56` and by the rendered tests in `lib/__tests__/dfRoundG_P14_labels.test.ts`; not exercised against a live database)
- **Independently verified:** — (`author`: observed by the DF-P14 final review and recorded by the integrator at the DF-P14 merge, 2026-10-20; not yet challenged by a second party).
- **Blast radius:** attention / visibility
- **Locations:**
  - `components/dashboard/widgets.tsx:466-545` — `DraftingRequestsBody`. On `9b52f56` (`:434-484` there) the open count was the number of rows of ONE read, `select("status")…not("status","in",'("CLOSED","CANCELED")').limit(2000)`, its `error` unread; the pipeline bar counted the same rows. DF-P14's review fix pass replaced that read with the queue's keyset reader (`ROUTE-12`'s Resolution); this pass replaces it with exact counts.
- **Related:** `ROUTE-12` (the same defect in the queue — RESOLVED), `ROUTE-7` (the attention feed's own cap)

**Mechanism.** The widget asked for at most 2,000 rows and counted what came back (PostgREST's own max-rows, 1,000 by default, could cap it lower still). Nothing marked the answer short and a failed read was not read, so above the cap "N open requests" and the bar stopped at the cap, and a refused read showed "0 open requests" and "No open requests".

**Failure scenario.** A large site with 2,400 open drafting requests: the dashboard says 2,000 (or 1,000), the bar's parts are short in proportion to which rows the read happened to return, and a supervisor sizing the backlog from the dashboard under-reads it by a sixth with nothing on screen to say so. A statement timeout on that read says the backlog is zero.

**Remediation.** Count, do not read rows: an exact count of the open requests and one per pipeline part (`{ count: 'exact', head: true }`), the same scope as before; a failed count said, never a 0.

**Done when.**

- ✓ 1, 2,000 and 2,400 open requests render the open count and each pipeline part as the rows imply, with no row read for the numbers.
- ✓ A failed count read is said, never shown as zero.

**Resolution (2026-10-20, drafting-flow Round G — the integrator fix pass at the DF-P14 merge, DEC-90).** `DraftingRequestsBody` (`components/dashboard/widgets.tsx:466`) now reads **exact HEAD counts** (`exactCount` `:455`): one of every open request (`select("id", { count: "exact", head: true })`, the workspace, status not `CLOSED` / `CANCELED` — the scope the widget read before) and one per pipeline part (`DRAFTING_PIPELINE` `:443`, the same parts in the same fixed order, each `.in("status", …)`) — six requests that return no rows, whatever the number. Below 2,000 the widget shows exactly what it showed before: the same count (a status outside the pipeline is counted in the total and in no part, as before), the same bar and legend, the same recent list (30 rows). A count read that is refused, throws, or comes back with no number is a fault with its reason: the open count shows "—" with "Open requests could not be counted — …" (`drafting-open-count-fault`); a pipeline part that cannot be counted leaves the bar out and says "Where the open requests sit could not be counted — …" (`drafting-pipeline-fault`), the total standing — never a short bar or a 0. The keyset read DF-P14's review fix pass put here (up to 10,000 rows for a number, with a partial-bar note) is removed. Tests (`lib/__tests__/dfRoundG_P14_labels.test.ts`, the widget AS RENDERED, its PostgREST stand-in answering HEAD counts with the filters applied and honouring `.limit()` on every other read; the big-count tests carry an explicit 30 s timeout): 1 / 2,000 / 2,400 open requests (plus 50 closed) render the count and each part's legend as the rows imply, from six HEAD reads with the scope's filters and no `limit`, the recent list at most 30; REGRESSION: an unknown status in the total and no part; none open → 0, no bar, "No open requests."; a refused count and a count with no number each show "—" and say so; one part's failed count leaves the total, drops the bar and says so.

---

> Line citations into `lib/notifications.ts` re-pointed 2026-09-02 after the roles-and-permissions sweep removed the browser external-mail path (`SURF-17`); the cited symbols are unchanged.
