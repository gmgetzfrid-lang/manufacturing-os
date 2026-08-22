# 01 · The producer census

**14 findings** — 3 HIGH · 11 MEDIUM.

Which parts of the app notify, which are silent, and which vocabulary is dead. The completeness question, answered kind by kind.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded. A severity set by that pass overrides the original.


### Already there — reusable substrate

| Thing | Where | Why it matters |
|---|---|---|
| emit() — a complete unified dispatcher that already resolves four audience sources and fans out to bell + email with per-category preference gating | `/home/user/manufacturing-os/lib/notify/dispatch.ts:82-132` | Every silent subsystem can be wired with a single emit() call. The dispatcher already dedupes, drops the actor, honours notification_preferences via queueEmail, and maps categories to eventTypes. Nothing new needs building — the gaps are all missing callers, not missing infrastructure. |
| resolveFollowers / resolveRoleRecipients / resolveProjectMembers — the follow-system unifier | `/home/user/manufacturing-os/lib/notify/recipients.ts:23-72` | Folds the subscriptions table and the legacy tickets.watchers array into one lookup. resolveProjectMembers is fully implemented and has zero callers — turning the 13 hardcoded-audience emit sites into follower-aware ones is a one-line change per site. |
| effectiveOwnerForDocument + getOrgControllers — document ownership resolution with folder/library inheritance | `/home/user/manufacturing-os/lib/ownership.ts:36-82` | Already used by retention, reviewControl, effectiveDate, acknowledgments, CheckInPanel and InspectorPanel. Holds is the only compliance surface that skips it, so fixing the hold audience is an import plus one resolve call. |
| sectionForKind + SectionCounts — per-section badge machinery that already computes more than the UI renders | `/home/user/manufacturing-os/hooks/useTicketNotifications.ts:71-132` | The infrastructure for the owner's 'trail goes cold' complaint half-exists: notifications are already bucketed per sidebar section. Extending it downward (library -> folder -> document) means grouping the same rows by resource_id — the rows already carry resource_type and resource_id from every producer. |
| COMPLIANCE_KINDS digest — a curated list of the regulated obligation kinds | `/home/user/manufacturing-os/app/api/cron/maintenance/route.ts:361-371` | Someone already enumerated which kinds represent obligations vs. FYI. That list is the natural seed for a corrected `actionKinds` set in useTicketNotifications.ts:279 (currently only 4 kinds) and for an 'alerts vs notifications' vocabulary split. |
| NotificationListener — realtime bridge from notification INSERTs to toasts, already scoped per-recipient | `/home/user/manufacturing-os/components/providers/NotificationListener.tsx:76-98` | The postgres_changes subscription filtered to user_id=eq.uid is exactly the hook an OS-level Notification API call would attach to (owner complaint #2), and the per-kind tone switch at lines 89-91 is where an alert/notification distinction would be expressed. |
| Stale-workflow reconciler — auto-clears notifications whose underlying ticket has moved on | `/home/user/manufacturing-os/hooks/useTicketNotifications.ts:188-210` | A working pattern for self-clearing alerts, keyed on metadata.status + metadata.action. Extending the same idea to metadata.branchId would fix the permanent branch_open rows; extending it to holds/acks would keep the badge honest without user action. |
| WatchButton + subscriptions table — a working opt-in follow UI for document/project/asset/library | `/home/user/manufacturing-os/components/ui/WatchButton.tsx:10, /home/user/manufacturing-os/lib/subscriptions.ts:35-61` | The user-facing half of the follow system is shipped and reachable; only 4 of 17 emit sites honour it. Every fix in the hardcoded-audience finding is additive to something users can already do. |
| The /checkouts overlap 'Nudge to coordinate' button — the app's only working person-to-person poke | `/home/user/manufacturing-os/app/(protected)/checkouts/page.tsx:242-260, 488-517` | A shipped pattern (button -> notifyMany with kind checkout_conflict, with 'Heads-up sent' confirmation state) that owner complaint #6 can copy verbatim into the drafting-request page to poke a stalled engineer. |
| notifications.kind is unconstrained TEXT with no CHECK | `/home/user/manufacturing-os/supabase/migrations/20260621_in_app_notifications.sql:17` | Cuts both ways: it is why the off-union storage_* rows land successfully rather than erroring, and it means adding new kinds needs no migration — but also that nothing catches a typo'd or unmapped kind at any layer. |


---


<a id="prod-1"></a>

## PROD-1 · 26 of 48 NotificationKinds badge nothing: sectionForKind drops the entire compliance vocabulary into an unrendered 'other' bucket

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:71-103`, `hooks/useTicketNotifications.ts:124-132`, `components/navigation/Sidebar.tsx:229-235`

**Mechanism.** sectionForKind() switches on only 22 of the 48 union members plus 'ticket'; everything else hits `default: return 'other'`. emptySectionCounts() allocates five buckets, but Sidebar.tsx consumes exactly three — sectionCounts.documents, sectionCounts.projects, sectionCounts.requests. 'scratchpad' and 'other' are tallied and thrown away. The 26 unmapped kinds are: revision_published_over_checkout, library_doc_added, library_doc_revised, project_comment, task_reminder, review_due, owner_assigned, owner_behind, deletion_requested, ack_requested, ack_complete, ack_overdue, ack_unsatisfiable, review_requested, review_signed, review_invalidated, review_complete, review_overdue, review_alternate_activated, effective_now, retention_eligible, legal_hold_placed, legal_hold_released, access_recert_due, orchestrator_message, security_export — plus the off-union storage_* kinds. This is the mechanical root of the owner's complaint #1: the badge cannot continue down the chain because for the PSM-critical kinds it never appeared on a section at all.

**Failure scenario.** A controlled document is issued and lib/acknowledgments.ts:501 emits ack_requested to every assignee. sectionForKind('ack_requested') returns 'other'. sectionCounts.other is incremented and then never read by any component. The Documents sidebar item shows no badge. The user's legal obligation to read-and-acknowledge an issued revision is visible only if they happen to open the bell dropdown, whose global count did include it. Same for review_requested (a sign-off gate that blocks publishing), review_overdue, legal_hold_placed, and retention_eligible.

**Evidence.**

```
hooks/useTicketNotifications.ts:100-102 —
    default:
      return 'other';

hooks/useTicketNotifications.ts:124-132 —
function emptySectionCounts(): SectionCounts {
  return {
    requests: { total: 0, actionRequired: 0 },
    scratchpad: { total: 0, actionRequired: 0 },
    documents: { total: 0, actionRequired: 0 },
    projects: { total: 0, actionRequired: 0 },
    other: { total: 0, actionRequired: 0 },
  };
}

components/navigation/Sidebar.tsx:229 —
      { label: 'Documents',   hint: 'Libraries · board · locks · packages · blocked', href: '/documents',    icon: FileStack, tone: 'blue', ...badgeOf(sectionCounts.documents)   },
```

**Chain reaction.** Because ack_* and review_* are also the kinds the maintenance cron digests (COMPLIANCE_KINDS at app/api/cron/maintenance/route.ts:361-371), the daily email digest becomes the ONLY reliable delivery path for the regulated obligations, and it fires at most once per 25h.

> **Verifier correction.** CRITICAL is overstated: the unmapped kinds are NOT invisible. useTicketNotifications returns `count: items.length` over ALL items (line 312), so every one of the 26 kinds still increments the header bell badge (NotificationBell.tsx:107-111) and renders in the bell drawer and the NotificationCenter (which filters only on actionRequired, NotificationCenter.tsx:81-84). Sidebar.tsx:125-127 states this as the intended split: 'The header bell owns the org-wide total; the rail doesn't duplicate it.' The real defect is narrower than the title: per-section rail badging is missing for 26 kinds, several of which (ack_requested, review_requested, library_doc_added/revised, revision_published_over_checkout, effective_now, legal_hold_*) plainly belong under Documents. That is a genuine root cause for complaint #1, but it is a rail-badge gap, not a 'badges nothing' gap.

**Done when.**

- [ ] sectionForKind maps every member of the NotificationKind union to a rendered section (or the union is narrowed to what is renderable)
- [ ] A compile-time exhaustiveness check (`const _never: never = kind`) in sectionForKind's default arm makes a new kind a build error until it is mapped
- [ ] Sidebar renders a badge for every section sectionCounts allocates, or emptySectionCounts stops allocating buckets nobody reads

---

<a id="prod-2"></a>

## PROD-2 · Access requests notify nobody — a locked-out user's request lands in a table with no producer

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/auth/request-access/route.ts:44-57`

**Mechanism.** POST /api/auth/request-access inserts an access_requests row and returns { ok: true }. There is no notify(), no emit(), no email_notifications insert, and no notifications insert anywhere in the file. No org Admin or DocCtrl is told a person is waiting at the door. Two shapes searched: grep -rln 'access_request|accessRequest' across app/lib/components/supabase returned only this route, lib/schemaExpectations.ts, lib/exportTables.ts, lib/dataRestore.ts and one migration — i.e. no other file writes or reacts to the table; and the subsystem sweep for producers (notifyMany|inAppNotifications|notify/dispatch|from("notifications")|queueEmail) over every file mentioning access_requests returned an empty producer set.

**Failure scenario.** A new engineer submits a join request for the workspace. The row is written. The response tells them 'Please wait for an admin to respond.' No admin receives a bell row, an email, or a badge. The request is discovered only if an admin proactively navigates to the members/access screen. In a regulated environment this is the on-ramp to the whole document-control system.

**Evidence.**

```
app/api/auth/request-access/route.ts:44-57 —
    const { error: insertError } = await supabaseAdmin.from("access_requests").insert({
      org_id: orgId,
      org_name: orgRealName,
      display_name: displayName,
      email,
      status: "pending",
      created_at: new Date().toISOString(),
    });

    if (insertError) {
      return NextResponse.json({ error: `Failed to submit request: ${insertError.message}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, orgName: orgRealName });
```

**Done when.**

- [ ] The route emits to resolveRoleRecipients(orgId, ['Admin','DocCtrl']) on insert
- [ ] The approve/deny action notifies the requester by email at the address they supplied

---

<a id="prod-3"></a>

## PROD-3 · branch_resolved goes only to the brancher, never to the DocCtrl pool that was alerted to branch_open

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/branches.ts:148`, `lib/branches.ts:204-215`

**Mechanism.** announceBranch emits branch_open to `audience: { involved, roles: ["DocCtrl"] }` — every DocCtrl in the org gets an action-required alert (branch_open is in actionKinds at useTicketNotifications.ts:279). resolveBranch emits branch_resolved to `audience: { involved: [branch.createdBy] }` — the DocCtrl role pool is not in the audience. The opening and closing halves of the same workflow have asymmetric audiences.

**Failure scenario.** A drafter publishes off a stale base. Every DocCtrl receives 'Unreconciled branch opened on P-101', flagged Action needed, badged on the Documents section. The drafter later merges the branch. resolveBranch notifies only branch.createdBy — the drafter, who already knows. Every DocCtrl's alert stays unread and action-required. The stale-workflow reconciler at useTicketNotifications.ts:188-210 cannot clear it either: that reconciler only retires rows where `metadata.status` is a string and `metadata.action != null`, and branches.ts:149 writes `metadata: { branchId: input.branchId }` — neither key is present. The alert is permanent until manually dismissed.

**Evidence.**

```
lib/branches.ts:148 —
      audience: { involved, roles: ["DocCtrl"] },

lib/branches.ts:204-215 —
    await emit({
      orgId: input.orgId,
      category: "status",
      kind: "branch_resolved",
      title: `Branch ${input.resolution === "merged" ? "merged" : "withdrawn"}`,
      body: `${input.actorName} resolved the open branch: "${input.note.trim()}"`,
      resource: { type: "document", id: branch.documentId },
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      audience: { involved: [branch.createdBy] },
      metadata: { branchId: branch.id },
    });
```

> **Verifier correction.** Trivial naming: the function is `announceBranchOpened`, not `announceBranch`.

**Done when.**

- [ ] resolveBranch's audience mirrors announceBranch's: { involved: [branch.createdBy], roles: ['DocCtrl'] }
- [ ] Resolving a branch marks the matching unread branch_open rows read (match on metadata.branchId), so the queue self-clears

---

<a id="prod-4"></a>

## PROD-4 · 13 of 17 emit() call sites hardcode their audience; the follower/watcher machinery is bypassed and audience.projectId is never used at all

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/notify/dispatch.ts:36-41`, `lib/distributionAcks.ts:145`, `lib/staleCopies.ts:205`, `lib/revisionImpact.ts:148`, `lib/workPackages.ts:286`, `lib/checkoutEpisodes.ts:676`, `lib/projects.ts:706`, `lib/notify/recipients.ts:65-72`, `lib/ticketTransitions.ts:130-132`

**Mechanism.** The dispatcher offers four audience sources: involved, followers, roles, projectId. Enumerating every `audience: {` block in the codebase yields 17 call sites. Only four pass `followers: true` (holds.ts:252, postPublish.ts:46, postPublish.ts:60, documents/[libraryId]/page.tsx:2313). Only two pass `roles` (holds.ts:252, branches.ts:148). ZERO pass `projectId` — resolveProjectMembers() at recipients.ts:65 is reachable only through a branch no caller takes. The remaining 13 sites pass a hand-built `involved` array, so a user who pressed the WatchButton on that document receives nothing. `channels` is likewise never passed by any caller (grep for `channels: [` returns nothing), so every emit always sends both in-app and email. The same hardcoding appears on the ticket side: computeTransition's default audience is `[ticket.requesterId, ticket.assignedDrafterId]` — assignedEngineerId is absent, even though app/api/tickets/comment/route.ts:92 correctly does `if (ticket.assignedEngineerId) involved.add(ticket.assignedEngineerId)`. The two ticket audiences disagree.

**Failure scenario.** A DocCtrl uses WatchButton (components/ui/WatchButton.tsx) to subscribe to a critical P&ID, writing a subscriptions row. Someone force-releases a checkout on it: lib/checkoutEpisodes.ts:676 emits to `{ involved: victims }` only. Someone's downloaded copy goes stale: lib/staleCopies.ts:205 emits to `{ involved: outdated.map(h => h.userId) }` only. A work package pinning it goes stale: lib/workPackages.ts:286 emits to `{ involved: [p.owner_user_id] }` only. The watcher hears about rev-ups and holds and nothing else. Separately, an engineer assigned via request_review is notified once (line 187 overwrites unread_by to [engineer.id]) and then falls out of every subsequent transition's audience until they act — line 296 only makes an ACTOR a watcher — so the person the ticket is blocked on stops hearing about it.

**Evidence.**

```
lib/notify/dispatch.ts:36-41 —
  audience: {
    involved?: string[];   // explicit stakeholders (requester/assignee/mentions)
    followers?: boolean;   // walk resolveFollowers(resource)
    roles?: string[];      // a role pool in the org
    projectId?: string;    // members of a project
  };

lib/notify/recipients.ts:65-72 (reachable, never reached) —
export async function resolveProjectMembers(projectId: string): Promise<string[]> {
  if (!projectId) return [];
  const { data } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId);
  return ((data as Array<{ user_id: string }> | null) ?? []).map((r) => r.user_id);
}

lib/ticketTransitions.ts:130-132 —
  const newUnreadBy = [ticket.requesterId, ticket.assignedDrafterId].filter(
    (id): id is string => !!id && id !== actorUid,
  );
```

> **Verifier correction.** The ticket half of this finding is substantially wrong and should be dropped. `newUnreadBy` at lib/ticketTransitions.ts:130-132 is only the DEFAULT; the switch overrides `updates.unread_by` to `[input.engineer.id]` for every engineer-routing action (lines 187, 244, 270) and to `[ticket.assignedDrafterId]` / `[ticket.requesterId]` elsewhere (234, 252, 258, 262). Lines 300-303 then merge `ticket.watchers` into unread_by, and line 296 auto-adds the actor as a watcher. Line 317 derives `recipients` from that merged array, and app/api/tickets/workflow-action/route.ts:337-350 notifies exactly those. So the ticket path does NOT bypass the watcher machinery and DOES reach the assigned engineer on engineer transitions — 'the two ticket audiences disagree' is only true for a residual case (a generic status change with an engineer who has never touched the ticket). Also note the doc bug the finding quotes without flagging: dispatch.ts:42 says 'Defaults to all three' while NotifChannel has only two members. Downgrade to MEDIUM: the 13 hardcoded sites are mostly targeted personal alerts (specific stale-copy holders, specific ack recipients) where a broadcast to watchers would be wrong.

**Done when.**

- [ ] Every document-scoped emit adds followers: true alongside its involved list
- [ ] Project-scoped emits pass audience.projectId instead of pre-resolving members by hand (lib/projects.ts:686-706 already resolves members ∪ watchers manually — that logic belongs in the dispatcher)
- [ ] computeTransition's newUnreadBy includes ticket.assignedEngineerId, matching the comment route
- [ ] A test asserts that a subscriptions row on a document causes that user to appear in resolveRecipients for every document-scoped kind

---

<a id="prod-5"></a>

## PROD-5 · CSV document import creates library documents without notifying subscribers, while the staged-upload path does

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/CsvImportModal.tsx:166`, `app/(protected)/documents/[libraryId]/page.tsx:2300-2314`, `app/(protected)/documents/[libraryId]/page.tsx:2508`

**Mechanism.** There are exactly two client paths that insert into the documents table (grep for `from("documents")` combined with insert returns two hits). The staged-upload path defines notifyLibrarySubscribers() at page.tsx:2300 and calls it once at page.tsx:2508 with kind 'library_doc_added' and audience { followers: true }. CsvImportModal.tsx:166 inserts documents with no notification at all — grep of the file for 'notify|emit|dispatch|notifications' returns nothing. So library_doc_added, already the least-covered kind (a single emitter), is skipped entirely by the bulk-import route.

**Failure scenario.** A DocCtrl bulk-imports 200 drawings into a library via CSV. Every user who pressed Watch on that library — the exact mechanism task #92 ('Library subscriptions — watch button + notify on new/revised docs') was built for — receives nothing. Uploading the same 200 files through the staging modal would have notified all of them.

**Evidence.**

```
app/(protected)/documents/[libraryId]/page.tsx:2300-2313 (the path that notifies) —
    const notifyLibrarySubscribers = (count: number, firstName: string) => {
      if (!activeOrgId || !uid || count === 0) return;
      void import("@/lib/notify/dispatch").then((m) =>
        m.emit({
          ...
          kind: "library_doc_added",
          ...
          audience: { followers: true },
        })).catch(() => undefined);
    };

components/documents/CsvImportModal.tsx:166 (the path that does not) —
        const { error: insertErr } = await supabase.from("documents").insert({
```

**Done when.**

- [ ] CsvImportModal emits library_doc_added with audience { followers: true } after a successful batch
- [ ] The notify call is extracted to a shared helper both insert paths use, so a third insert path cannot silently skip it

---

<a id="prod-6"></a>

## PROD-6 · Cost control, change orders, checklists, turnover, punch, equipment registry and companies are all completely silent

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/changeOrders.ts`, `lib/costs.ts`, `lib/checklists.ts`, `lib/turnover.ts`, `lib/companies.ts`, `lib/equipmentBridgeServer.ts`, `lib/documentShares.ts`

**Mechanism.** Two-shape verification. Shape 1: grep -c 'notify|queueEmail|emit(|notifications' over each file — all return 0. Shape 2: a subsystem sweep that collected every file mentioning change_orders/changeOrders, checklists, turnover, punch_items, equipment_registry, cost_items, lib/companies and document_shares, then grepped that whole file set for any producer pattern (notifyMany|inAppNotifications|notify/dispatch|from("notifications")|queueEmail) — every one returned an empty producer set. These are the modules shipped by tasks #189-#195 (the CV project-controls program); none of them were wired to the notification spine.

**Failure scenario.** A change order is raised against a project budget, a PSSR checklist item is signed off, a punch item is assigned, or a turnover package is marked complete. No stakeholder is notified through any channel. The information is available only by navigating to the relevant project tab. A change order awaiting approval can sit indefinitely with no escalation clock, unlike drafting requests (request_pending_approval) or reviews (review_overdue).

**Evidence.**

```
Producer sweep result (each subsystem's full file set grepped for any notification producer):
  changeOrders             producers:[]
  checklists               producers:[]
  turnover                 producers:[]
  punch                    producers:[]
  equipment                producers:[]
  costs                    producers:[]
  companies                producers:[]
  documentShares           producers:[]
```

**Done when.**

- [ ] Change-order submit/approve/reject emits to the project's members and the cost owner
- [ ] Punch/checklist assignment emits to the assignee
- [ ] A decision is recorded (in the union's comments or a doc) for each subsystem deliberately left silent, so 'silent' is a choice rather than an omission

---

<a id="prod-7"></a>

## PROD-7 · Exported notification API that no caller uses: countUnread, resolveRecipients, and the dispatcher's channels option

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/inAppNotifications.ts:176-185`, `lib/notify/dispatch.ts:65-79`, `lib/notify/dispatch.ts:42-43`

**Mechanism.** countUnread(orgId) is exported and has zero call sites — verified with two shapes: bare `countUnread` across app/lib/components/hooks/scripts/types (1 hit, the definition) and case-insensitive `countunread` across the whole tree excluding node_modules/.next/.git (1 hit, the same definition). Every surface instead calls useTicketNotifications, which does its own listMyNotifications({ onlyUnread: true, limit: 50 }) and reports `count: items.length`. resolveRecipients is exported with the comment "so callers can preview/whom-would-this-notify without sending" — its only caller is emit() eight lines below it. The `channels?: NotifChannel[]` option documented as "Pass a subset to force-limit a noisy event" is passed by no call site (grep for `channels: [` returns nothing), so `input.channels ?? ["inapp","email"]` always takes the default and every notification is dual-channel.

**Failure scenario.** Two consequences. First, because countUnread is unused, the only unread count in the app is derived from a page of 50 (`listMyNotifications({ onlyUnread: true, limit: 50, orgId })` at useTicketNotifications.ts:176) unioned with open tickets — a user with more than 50 unread rows sees a count that silently understates reality and loses the oldest items from the feed entirely. Second, because channels is never used, a high-volume kind such as checkout_message (which fans out to every thread participant, every active session holder and every document subscriber on every chat post — activityThread.ts:126-139) sends an email for each one; there is no way to mark a kind in-app-only.

**Evidence.**

```
lib/inAppNotifications.ts:176-177 —
export async function countUnread(orgId?: string | null): Promise<number> {
  let q = supabase

lib/notify/dispatch.ts:42-43 —
  /** Defaults to all three. Pass a subset to force-limit a noisy event. */
  channels?: NotifChannel[];

hooks/useTicketNotifications.ts:176 —
        let n = await listMyNotifications({ onlyUnread: true, limit: 50, orgId: activeOrgId })
```

> **Verifier correction.** Note for whoever acts on this: impact is dead-code/API-hygiene only — no user-visible defect, no wrong behaviour. It belongs at the bottom of the queue, and the `limit: 50` cap in the path that replaced countUnread (useTicketNotifications.ts:176) is the more interesting consequence of the duplication: the bell badge silently saturates at 50 unread notification rows.

**Done when.**

- [ ] countUnread is either deleted or used as the badge source so the count is not capped at a 50-row page
- [ ] resolveRecipients gains its intended caller (a 'who will this notify' preview) or the comment is corrected
- [ ] Chatty kinds (checkout_message, library_doc_added) pass channels: ['inapp'] so email volume is proportionate; the doc comment says 'all three' but only two channels exist

---

<a id="prod-8"></a>

## PROD-8 · Five NotificationKinds have zero emitters anywhere in the repository — scratchpad leftovers plus checkout_handoff

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/inAppNotifications.ts:33-36`, `lib/inAppNotifications.ts:16`, `hooks/useTicketNotifications.ts:80-87`, `components/notifications/NotificationBell.tsx:26`

**Mechanism.** task_reminder has ZERO references outside its own union declaration — searched bare identifier across app/lib/components/hooks/scripts/types (0 hits) and case-insensitively across the whole tree excluding node_modules/.next/.git (0 hits). task_nudge, morning_digest, and task_overdue_digest appear only in the consumer maps (sectionForKind cases and KIND_ICON), never in a producer — these are residue from task #76 'CLEAN-2: Remove scratchpad surface', which deleted the producer but left the vocabulary and the now-unrenderable 'scratchpad' section. checkout_handoff is separately dead because lib/activityThread.ts:158 hardcodes kind: "checkout_message" for ALL six activity kinds — the handoff distinction survives only inside the title string built at lines 145-152.

**Failure scenario.** A drafter uses CheckInPanel's postHandoff (components/documents/CheckInPanel.tsx:424) to leave a formal handoff note for the next person. The recipient's bell shows a generic MessageSquare 'checkout_message' icon reading 'Alice left a handoff on P-101' — indistinguishable in tone, icon, and section-routing from ordinary checkout chat. The Lock icon registered for checkout_handoff at NotificationBell.tsx:26 is never reachable.

**Evidence.**

```
lib/activityThread.ts:145-158 —
    const kindWord =
      input.kind === "question" ? "asked about" :
      input.kind === "proposal" ? "proposed on" :
      input.kind === "handoff" ? "left a handoff on" :
      ...
    await notifyMany({
      orgId: input.orgId,
      userIds,
      actorUserId: actor,
      actorName: input.userName,
      kind: "checkout_message",

lib/inAppNotifications.ts:33-36 —
  | "task_overdue_digest"     // legacy digest — your scratchpad has overdue tasks
  | "morning_digest"          // composed daily digest: overdue + today + aging dateless
  | "task_nudge"              // someone sent you a scratchpad task as a heads-up
  | "task_reminder"           // a precise scratchpad alarm ("remind me at 3pm") just elapsed
```

> **Verifier correction.** HIGH is overstated. This is dead vocabulary with no user-visible failure — nothing is silently dropped, because nothing is ever produced. Impact is type-surface and maintenance debt (plus the unrenderable 'scratchpad' bucket from finding 1), so MEDIUM.

**Done when.**

- [ ] task_reminder, task_nudge, morning_digest, task_overdue_digest removed from the union, from KIND_ICON, and from sectionForKind; the 'scratchpad' member of AttentionSection deleted
- [ ] notifyCheckoutActivity maps input.kind === 'handoff' to kind 'checkout_handoff' (and 'markup_ref' to 'markup_request') rather than collapsing all six to checkout_message

---

<a id="prod-9"></a>

## PROD-9 · Holds never notify the document owner, contradicting the union's own contract comment

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/holds.ts:238-253`, `lib/inAppNotifications.ts:24`, `lib/ownership.ts:79`

**Mechanism.** The union documents hold_opened as "a hold was opened on a doc the user owns / is on the project for". The emit at holds.ts:252 uses `audience: { followers: true, roles: ["Admin", "DocCtrl"] }` — neither the effective owner nor project members. grep of lib/holds.ts for 'owner' and 'project' returns zero hits. The resolver exists and is used by five other subsystems: effectiveOwnerForDocument() at lib/ownership.ts:79 is imported by retention.ts:15, reviewControl.ts:19, effectiveDate.ts:12, acknowledgments.ts:19, CheckInPanel.tsx:39 and InspectorPanel.tsx:37. Holds is the one compliance surface that skips it.

**Failure scenario.** A DocCtrl places a STOP-WORK hold on a P&ID whose owner is a process engineer who has not pressed Watch on it (ownership is assigned by lib/ownership.ts:130, watching is a separate opt-in). The hold fires to every Admin/DocCtrl and to subscribers. The document's accountable owner — the person answerable for it in the PSM record — is never told work on their document has been stopped, unless they coincidentally hold one of those roles or subscribed.

**Evidence.**

```
lib/holds.ts:252 —
      audience: { followers: true, roles: ["Admin", "DocCtrl"] },

lib/inAppNotifications.ts:24 —
  | "hold_opened"             // a hold was opened on a doc the user owns / is on the project for

lib/ownership.ts:79 (the unused-here resolver) —
  const { data } = await supabase.from("documents").select("owner_user_id, owner_name, collection_id, library_id").eq("id", documentId).maybeSingle();
```

> **Verifier correction.** Two adjustments. (1) The citation is off: `effectiveOwnerForDocument` is defined at lib/ownership.ts:35; line 79 is the documents SELECT inside `isEffectiveOwnerOfDocument`. The quoted text does appear at 79, but it is not the resolver's signature. (2) Partial mitigation: Admin and DocCtrl — who are the fallback owners per getOrgControllers (ownership.ts:92-95) and who run the hold queue at /admin/holds — do receive it. What is missed is a delegated non-controller owner and the project team. MEDIUM.

**Done when.**

- [ ] holds.ts resolves effectiveOwnerForDocument and adds the owner uid to the hold_opened/hold_released audience
- [ ] If the document is linked to a project, audience.projectId is passed so project members hear it too

---

<a id="prod-10"></a>

## PROD-10 · Storage alerts bypass the NotificationKind union entirely, one of them via a template literal

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/storageAlerts.ts:60-66`, `lib/storageUsage.ts:255-258`, `supabase/migrations/20260621_in_app_notifications.sql:17`

**Mechanism.** Both files insert into the notifications table directly with the service-role client rather than going through notify(), so TypeScript never checks the kind. storageAlerts writes the literal 'storage_alert'; storageUsage writes a computed `storage_${alert.key}` whose value set cannot be enumerated statically. Neither is a member of NotificationKind. The DB does not catch it: the migration declares `kind TEXT NOT NULL` with no CHECK constraint (verified by grepping every CHECK (kind IN ...) in supabase/ — the notifications table has none, unlike site_codebook, checkout_messages, document_intents etc. which all do). The rows therefore land and render — NotificationBell.tsx:166 falls back with `KIND_ICON[item.kind] ?? Bell` — but sectionForKind returns 'other', so they badge nothing (see finding 1), and any future exhaustive switch over NotificationKind will silently miss them.

**Failure scenario.** The workspace crosses its storage quota. lib/storageAlerts.ts:60 writes a storage_alert row to every Admin/DocCtrl. It appears in the bell drawer with a generic Bell icon and no section badge. The 7-day dedupe at storageAlerts.ts:56-59 means if it is missed in the drawer, the next reminder is a week away. Meanwhile a developer adding an exhaustiveness check over NotificationKind would get a clean compile while these rows keep arriving.

**Evidence.**

```
lib/storageUsage.ts:255-257 —
        const { error } = await sb.from("notifications").insert({
          org_id: org.id, user_id: a.uid, kind: `storage_${alert.key}`,
          title: alert.title, body: alert.body, link: "/admin/storage",
        });

supabase/migrations/20260621_in_app_notifications.sql:17 —
  kind TEXT NOT NULL,                          -- ticket_comment | ticket_mention | ticket_status | checkout_conflict | project_member | hold_opened | …
```

> **Verifier correction.** One factual error: 'a computed `storage_${alert.key}` whose value set cannot be enumerated statically' is false. `hot` is declared at lib/storageUsage.ts:216 as a local array and receives exactly two literal pushes — `key: "platform_r2"` at :219 and `key: "platform_db"` at :231. The kind set is therefore statically known and finite: storage_alert, storage_platform_r2, storage_platform_db. That makes the fix trivial (three union members) rather than open-ended.

**Done when.**

- [ ] storage_alert (and each storage_${key} variant) is added to NotificationKind, or the storage alerts are folded into an existing kind
- [ ] Both call sites route through notify()/emit() so the kind is type-checked
- [ ] Optionally: a CHECK constraint or a trigger on notifications.kind so an unknown kind fails loudly instead of rendering as a generic bell

---

<a id="prod-11"></a>

## PROD-11 · The entire milestones/schedule subsystem is silent — 20+ mutators, zero notifications

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/milestones.ts:155`, `lib/milestones.ts:233`, `lib/milestones.ts:293`, `lib/milestones.ts:346`, `lib/milestones.ts:456`, `lib/milestones.ts:565`

**Mechanism.** lib/milestones.ts contains createMilestone, updateMilestone, applyMilestoneMoves, setMilestoneStatus, setMilestoneProgress, addMilestoneNote, deleteMilestone and importGhostMilestones. grep -c 'notify|queueEmail|emit(|notifications' over the file returns 0. A second-shape check — the producer sweep over every file matching 'milestones' — returned only lib/inbox.ts, components/dashboard/widgets.tsx and lib/projects.ts, all of which are notification READERS or notify about project membership/status, not milestones (lib/projects.ts's only milestone reference is a cascade delete at line 606-607). Assigning a milestone, slipping a date, rebaselining a schedule, or deleting a milestone reaches nobody.

**Failure scenario.** A project manager rebaselines the schedule via applyMilestoneMoves, pushing eight milestones two weeks right. Nobody on the project — not the owner, not project_members, not assignees — receives a bell row or an email. The slip is detectable only by opening the project's Schedule tab, or later via lib/nudges.ts:53-62, which derives an 'N milestones are overdue' string from the already-loaded inbox snapshot on the /inbox page — a passive pull, not a notification.

**Evidence.**

```
lib/nudges.ts:53-62 (the only 'milestone alerting' that exists — a pure derivation, not a producer) —
  const overdue = snap.milestonesOverdue ?? [];
  if (overdue.length > 0) {
    const oldest = overdue[0];
    nudges.push({
      id: "overdue-milestones",
      severity: "high",
      message: `${overdue.length} milestone${overdue.length === 1 ? " is" : "s are"} overdue...`,
```

> **Verifier correction.** Two overstatements. (a) '20+ mutators' is wrong — there are 14 exported mutators (create/update/applyMoves/setStatus/setProgress/addNote/delete/importGhost/importFromParsed/rebase/groupTasks/setTaskDuration/setBaseline/clearBaseline). (b) 'reaches nobody' applies only to push. lib/inbox.ts:156-159 pulls open milestones from -180d through +7d, splits them into `milestonesUpcoming`/`milestonesOverdue` (:241-245, :300-301) scoped to the user's projects, and lib/nudges.ts:53-62 raises a high-severity 'overdue-milestones' nudge from that snapshot. So a slipped date does surface on the Inbox/dashboard next time the user looks; what is absent is an event-time bell row or email. MEDIUM.

**Done when.**

- [ ] setMilestoneStatus and applyMilestoneMoves emit to audience { projectId } (the dispatcher branch that already exists and is unused)
- [ ] Milestone assignment notifies the assignee with a distinct kind
- [ ] A schedule slip past a baseline notifies the project owner

---

<a id="prod-12"></a>

## PROD-12 · Transmittal issue writes no internal notification; manual acknowledgment is silent while the portal path emits ack_complete

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:558-590`, `lib/transmittals.ts:593-620`, `app/api/transmittal/route.ts:148-158`

**Mechanism.** issueTransmittal() calls sendTransmittalEmail() (which uses queueExternalEmail at transmittals.ts:281 — the EXTERNAL recipient) and logAuditAction(). No bell row for anyone internal: no library watcher, no document owner, no project team learns a controlled document left the building. acknowledgeTransmittal() — the in-app manual path — writes only an audit log. The portal path in app/api/transmittal/route.ts:148-158 DOES insert an ack_complete notification plus an email_notifications row for the issuer. The same business event produces a notification through one door and nothing through the other. lib/transmittals.ts's only notification import is queueExternalEmail (line 19); it does not import inAppNotifications or notify/dispatch.

**Failure scenario.** A DocCtrl phones the contractor, confirms receipt, and records it via acknowledgeTransmittal in the app. The transmittal flips to acknowledged and an audit row is written; the issuer (if different from the recorder) gets nothing. The same contractor clicking the portal link instead would have produced a bell row and an email to the issuer. Two paths, two different notification outcomes for one recorded fact.

**Evidence.**

```
lib/transmittals.ts:576-590 —
  if (data) {
    await sendTransmittalEmail(rowToTransmittal(data as Record<string, unknown>), actor);
  }
  await logAuditAction({
    action: "TRANSMITTAL_ISSUED",
    ...
  });
}

app/api/transmittal/route.ts:148-157 (the path that DOES notify) —
  if (t.created_by) {
    await supabaseAdmin.from("notifications").insert({
      org_id: t.org_id, user_id: t.created_by,
      kind: "ack_complete",
      title: `Transmittal ${t.number} acknowledged`,
```

> **Verifier correction.** One mitigating surface worth noting: the issuer is not blind to un-acknowledged transmittals — lib/nudges.ts:66-78 raises a 'transmittals-unacknowledged' nudge off `snap.transmittalsAwaitingAck` for anything older than 7 days. That covers the issue leg partially; it does not cover the manual-ack leg.

**Done when.**

- [ ] acknowledgeTransmittal emits the same ack_complete row the portal route does, so both paths converge
- [ ] issueTransmittal emits an internal notification to the document owner / library followers that a controlled copy was distributed externally

---

<a id="prod-13"></a>

## PROD-13 · doc_superseded is overloaded across eight semantically distinct events — the kind carries no information

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/postPublish.ts:39`, `lib/postPublish.ts:177`, `lib/distributionAcks.ts:138`, `lib/distributionAcks.ts:322`, `lib/staleCopies.ts:198`, `lib/revisionImpact.ts:138`, `lib/workPackages.ts:279`, `app/api/intake/upload/route.ts:351`

**Mechanism.** Eight call sites emit kind 'doc_superseded' for eight different things: a rev-up announcement (postPublish:39), a second rev-up fan-out (postPublish:177), a NEW distribution-acknowledgment REQUEST (distributionAcks:138 — the recipient must act), an ack REMINDER (distributionAcks:322), a stale-copy RECALL (staleCopies:198), an upstream-impact advisory (revisionImpact:138), a work-package-went-stale alert (workPackages:279), and an intake auto-publish (intake/upload:351). Every one renders with the same GitBranch icon (NotificationBell.tsx:35), the same 'documents' section, and the same non-action-required tone — actionKinds at useTicketNotifications.ts:279 is `new Set(['checkout_conflict','checkout_released','overlap_advisory','branch_open'])`, which excludes doc_superseded. The distinction survives only in the free-text title. This is the mechanical answer to the owner's complaint #4: the vocabulary is unclear because one token means eight things.

**Failure scenario.** A distribution acknowledgment is requested — a PSM record obligation where the recipient must tap 'I have this revision'. It arrives in the bell as kind doc_superseded with a branch icon and no 'Action needed' flag, visually identical to the purely informational 'Doc X advanced to Rev 3' notice sitting next to it. The recipient reads it as FYI and does not act. lib/distributionAcks.ts:229-232 then has to search notifications by `.in("kind", ["ack_requested","ack_overdue","doc_superseded"])` to find its own rows again — the code itself cannot tell them apart.

**Evidence.**

```
lib/distributionAcks.ts:135-146 —
  await emit({
    orgId: input.orgId,
    category: "assignment",
    kind: "doc_superseded",
    title: `Please confirm: ${input.docLabel} Rev ${input.revLabel ?? "?"}`,
    body: `${input.actorName} needs your confirmation that you have the current revision...`,

lib/distributionAcks.ts:229-232 (the read-back that proves the ambiguity) —
      .from("notifications")
      ...
      .in("kind", ["ack_requested", "ack_overdue", "doc_superseded"])

hooks/useTicketNotifications.ts:279 —
    const actionKinds = new Set(['checkout_conflict', 'checkout_released', 'overlap_advisory', 'branch_open']);
```

> **Verifier correction.** Two factual corrections. (1) postPublish.ts:177 is not 'a second rev-up fan-out' — it is a document-RETIREMENT notice to work-package owners ('was ${input.newStatus.toLowerCase()} — it's in your pack', metadata `{ packageId, retirement: true }`), which if anything makes it a ninth distinct meaning. (2) 'the kind carries no information' / 'the distinction survives only in the free-text title' is wrong: five of the eight sites stamp a discriminator in metadata (`ackRequest` at distributionAcks:145 and :331, `recall` at staleCopies:206, `workPackageId` at workPackages:288, `retirement` at postPublish:180, `intake` at intake/upload:357), and distributionAcks.ts:228-240 reads those discriminators back to dedupe nudges. The design smell is real; the informational vacuum is not. MEDIUM.

**Done when.**

- [ ] distributionAcks uses ack_requested / ack_overdue (kinds that already exist) instead of doc_superseded
- [ ] staleCopies uses a distinct recall kind; revisionImpact and workPackages use distinct advisory kinds
- [ ] actionKinds includes every kind that demands a user action, so 'Action needed' is truthful

---

<a id="prod-14"></a>

## PROD-14 · markup_request is fully-wired dead vocabulary — createMarkupRequest never notifies the person being asked

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/markupRequests.ts:46-95`, `components/notifications/NotificationBell.tsx:34`, `hooks/useTicketNotifications.ts:85`

**Mechanism.** createMarkupRequest() inserts the markup_requests row, conditionally calls writeActivity() (only `if (input.projectId)`), and calls logAuditAction(). It never calls notify(), notifyMany(), emit(), or inserts into the notifications table. The kind 'markup_request' exists in the union with the comment "someone asked the user for markups", has an icon in KIND_ICON, and has a case in sectionForKind — the whole consumer side is built for a producer that does not exist. Searched three shapes: bare `markup_request` across app/lib/components/hooks (17 hits, all table names, resourceType strings, export/restore table lists, or the two UI maps); quoted `"markup_request"`/`'markup_request'` (only NotificationBell.tsx:34 and the union); and grep of lib/markupRequests.ts for notify|emit|dispatch|notifications (zero).

**Failure scenario.** An engineer opens MarkupRequestModal and asks a specific colleague to mark up a P&ID. The row is written with requested_from_user_id set. The colleague gets no bell row, no email, no badge. If the document has no projectId, not even a project-feed entry is written. The request sits in the markup_requests table until someone opens /inbox, which reads it at lib/inbox.ts:152 — the only surface where it is ever visible.

**Evidence.**

```
lib/markupRequests.ts:46-82 —
export async function createMarkupRequest(input: CreateMarkupRequestInput): Promise<MarkupRequest> {
  if (!input.message.trim()) throw new Error("Message is required");
  const { data, error } = await supabase
    .from("markup_requests")
    .insert({ ... requested_from_user_id: input.requestedFromUserId, ... })
    .select("*").single();
  if (error || !data) throw new Error(error?.message || "Failed to create markup request");

  // Post to project feed if applicable so the request is visible publicly.
  if (input.projectId) {
    await writeActivity({ ... type: "markup_requested", ... });
  }

  await logAuditAction({ action: "MARKUP_REQUESTED", ... });

lib/inAppNotifications.ts:26 —
  | "markup_request"          // someone asked the user for markups
```

> **Verifier correction.** CRITICAL and 'notifies nobody' are both wrong. The recipient IS told, through a pull surface rather than the bell: lib/inbox.ts:151-153 queries `markup_requests ... .eq("requested_from_user_id", userId).eq("status","open")` into `markupRequestsToMe`, which is rendered as a 'Markup requests for you' card at app/(protected)/inbox/page.tsx:266-269 and components/dashboard/widgets.tsx:823-826, headlined in components/cockpit/DailyBrief.tsx:49-50 and CommandDeck.tsx:326, and raised as a nudge at lib/nudges.ts:81-88. What is missing is the bell row and email, not the alert itself.

**Done when.**

- [ ] createMarkupRequest emits kind 'markup_request' to input.requestedFromUserId (via emit with category 'assignment')
- [ ] The notification fires regardless of whether projectId is set
- [ ] Resolving/sharing the markup (updateMarkupRequest at lib/markupRequests.ts:119-148) notifies the original requester

---
