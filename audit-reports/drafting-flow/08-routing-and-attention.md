# 08 · Routing, notification & attention

**11 findings** — 11 MEDIUM.

Who is told what, and what goes silent. Overlaps `04-flow-leaks.md` deliberately — that report owns the leak framing, this one owns the mechanism.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded here. Severities marked by that pass override the original.


---


<a id="route-1"></a>

## ROUTE-1 · A request returned from engineering review with no drafter assigned lands in REVISION_REQ, where nobody's attention rule matches — it disappears from every queue

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="route-2"></a>

## ROUTE-2 · Attention badges tell DraftingSupervisors and DocCtrl to act on statuses where the workflow engine gives them no action at all

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/ticketAttention.ts:84`, `lib/ticketAttention.ts:106`, `lib/ticketAttention.ts:124`, `lib/workflow.ts:301`, `lib/workflow.ts:319`, `lib/capabilityPolicy.ts:70`, `hooks/useTicketNotifications.ts:265`
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

---

<a id="route-3"></a>

## ROUTE-3 · Dead notification plumbing that the code documents as live: the ticket-follower resolver, the engineer-initial routing branch, and the entire web-push channel

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="route-4"></a>

## ROUTE-4 · Drafting requests raised from a document check-in notify in-app only — no email — unlike identical requests raised from the portal

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="route-5"></a>

## ROUTE-5 · Role routing runs only at ticket creation — no state transition ever consults it, so a request re-entering the assignment queue is announced to nobody in that queue

- **Severity:** LOW
- **Status:** OPEN
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

---

<a id="route-6"></a>

## ROUTE-6 · The Watch button on a ticket is silently defeated whenever the acting user is the only personal stakeholder — self-assignment is a completely silent transition

- **Severity:** LOW
- **Status:** OPEN
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

---

<a id="route-7"></a>

## ROUTE-7 · The attention feed caps at 500 open tickets sorted newest-modified-first, so the longest-neglected requests are exactly the ones it drops

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="route-9"></a>

## ROUTE-9 · The drafting-request SLA clock has no server-side reader — nothing ever fires an SLA warning, while the settings page promises one

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/notifications.ts:257`, `lib/notifications.ts:265`, `lib/notifications.ts:286`, `lib/notify/dispatch.ts:56`, `app/(protected)/settings/notifications/page.tsx:143`, `app/api/cron/maintenance/route.ts:159`, `vercel.json:4`
- **Same root cause as** `EDGE-7` — `GAP-106` is the build. Depends on `LEAK-1` landing first so escalations reach someone who does not already know. Fix once; close the rest citing this one.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence search: the SLA clock has no server-side reader, the breach columns are dead, and the only 'sla_warning' plumbing is a preference toggle plus an unreachable dispatch branch.

**Mechanism.** Every new ticket gets a due date: `target_completion_at: targetCompletion` (app/(protected)/requests/new/page.tsx:315) from `defaultSlaTargetDate(requestType)` (lib/notifications.ts:286), and check-in-created tickets get one too (components/documents/CheckInPanel.tsx:246). The field is indexed for scanning (`tickets_target_completion_idx ... WHERE target_completion_at IS NOT NULL`, supabase/migrations/20260529_phase_b_notifications.sql:22). But the only readers of that value anywhere are client render code: app/(protected)/requests/page.tsx:1067-1076 (a Past Due / Due Soon chip in the table) and app/(protected)/requests/[id]/page.tsx:1756-1761. `isPastDue` / `isNearingDue` have exactly two non-test callers, both in the ticket detail page's JSX. The notification side is fully built but has no producer: the `sla_warning` event type exists (lib/notifications.ts:163), the `"sla"` NotifCategory maps to it (lib/notify/dispatch.ts:56), the `email_on_sla_warning` preference is stored and rendered as a toggle, and an `sla_defaults` table exists — yet `grep -rn "category: *['\"]sla['\"]"` across the repo returns zero hits, `sla_defaults` is never queried (only listed in export/restore/schema-expectation manifests), and the daily maintenance cron's scan list contains seven scans, all document-control, none touching `tickets`.

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
- [ ] Either `sla_defaults` is read to seed per-org SLA windows, or the table and the `DEFAULT_SLA_DAYS` comment referencing it (lib/notifications.ts:276) are reconciled so the code does not describe a configuration surface that does not exist.

---

<a id="route-10"></a>

## ROUTE-10 · Ticket routing matches only the headline role column, so a person who holds DraftingSupervisor in their additive roles[] is never routed to — and the fallback then spams every Admin

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="route-11"></a>

## ROUTE-11 · Ticket-creation notifications carry no metadata.action/status, so neither the server supersede nor the client reconcile ever retires them

- **Severity:** MEDIUM
- **Status:** OPEN
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

---
