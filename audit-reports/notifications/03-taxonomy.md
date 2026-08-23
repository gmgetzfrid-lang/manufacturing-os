# 03 · Alerts vs notifications — the taxonomy

**14 findings** — 6 HIGH · 8 MEDIUM.

Every distinct way this app tells a person something, what each is for, and where they duplicate or contradict each other.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded. A severity set by that pass overrides the original.


### Already there — reusable substrate

| Thing | Where | Why it matters |
|---|---|---|
| `CornerDock` + `CornerPortal` - a working shared bottom-right dock with a graceful fallback when the dock isn't mounted | `components/ui/CornerDock.tsx:21-48` | The 'stack background-job messages gracefully bottom-right' request (complaint #5) is 80% built. Toasts, UploadIndicator and KnowledgeIndexIndicator already portal into it and stack with a gap. Only BackupIndicator and ServiceWorkerManager escaped; adding a `max-h`/`overflow-y-auto` and a visible-count cap finishes it. |
| Service-worker `push` + `notificationclick` handlers - the complete receive side of OS notifications, including click-to-focus-or-open with target URL routing | `public/sw.js:226-259` | Complaint #2 ('real OS-level notification presence') needs only the subscribe side and a sender. The banner rendering, icon, badge, tag/renotify and click routing already exist and are correct. |
| `push_subscriptions` table with endpoint/p256dh/auth/last_reminded_at, unique endpoint index and per-user RLS (service role bypasses for the sender) | `supabase/migrations/20260804_push_subscriptions.sql:7-36` | Storage and security for web push are already migrated and already registered in schemaExpectations/exportTables/dataRestore. No new migration is needed to ship push. |
| `notification_preferences.inapp_enabled` and `.push_enabled` columns, defaulted TRUE | `supabase/migrations/20260723_notifications_unify.sql:85-87` | Per-channel opt-outs are already stored; `emit()` just needs to read them, and /settings/notifications needs to render two more toggles using the existing `PrefRow`/`Toggle` components on that page. |
| `emit()` - the single-entry dispatcher with unified recipient resolution across subscriptions, ticket watchers, role pools and project membership, plus an exported `resolveRecipients` for preview | `lib/notify/dispatch.ts:67-132 and lib/notify/recipients.ts:23-72` | The correct fan-out spine already exists and honors email preferences. Only 13 call sites use it; migrating the remaining direct `notify`/`notifyMany`/raw-insert producers onto it is mechanical and is the prerequisite for any per-channel or per-kind policy. |
| `FirstRunHint` - the only surface in the app that persists a dismissal, hydration-safe via `useSyncExternalStore` with a documented storage-key namespace | `components/ui/FirstRunHint.tsx:26-50` | It is the ready-made pattern for 'dismissible corner banner whose dismissal is remembered' (complaint #3) and for fixing the EditOverlapBanner / KnowledgeIndexIndicator amnesia. The hydration-error footgun is already solved here. |
| `DialogProvider` / `appAlert`/`appConfirm`/`appPrompt` - a queued, themed replacement for native dialogs with a native fallback if the host isn't mounted | `components/providers/DialogProvider.tsx:46-151` | A clean, already-correct modal layer at z-[700]. It owns 'alert' as a *modal blocking question* - a genuinely distinct concept from a notification, and worth naming explicitly when splitting the vocabulary. |
| `NotificationCenter` slide-over that already accepts a filter parameter and reuses `AttentionFeed` verbatim | `components/notifications/NotificationCenter.tsx:34-45` | Making section badges honest (finding 5) is a small change: widen `AttnFilter` (or add a section param to `open()`) and filter `items` by `item.section` - the panel, portal, escape handling and mark-read plumbing are done. |
| `lib/ticketAttention.ts` - one pure, documented, unit-testable rule for 'does this need MY action', explicitly created to kill a prior two-copy drift | `lib/ticketAttention.ts:1-128` | Proof that the consolidation pattern works in this codebase, and the exact model to copy for the notification-kind registry: one exported pure module, a header comment explaining the drift it eliminated, and every surface importing it. |
| `AttentionItem.section` already exists on every feed item alongside `resourceId` and `link`, and is already tallied per-section by `sectionCounts` | `hooks/useTicketNotifications.ts:105-132 and 246-302` | The data needed to badge a library/folder/document row is already computed. Propagating badges down the chain (complaint #1) is a selector + consumer problem, not a data-model problem. |
| `countUnread(orgId)` - an exact head-count query already written but never called by the hook | `lib/inAppNotifications.ts:176-185` | Fixes the 50-row badge cap (finding 6) with no new query code. |
| Compliance email digest - one email per user per day summarizing new obligations, with per-user opt-out and 60s burst dedupe already honored | `app/api/cron/maintenance/route.ts:361-430 and lib/notifications.ts:50-100` | The escalation rung above the bell already exists for compliance kinds. `COMPLIANCE_KINDS` is also the best existing definition of 'this is an alert, not a notification' - the natural seed for the severity axis in a unified kind registry. |
| `lib/nudges.ts` `computeNudges` - a pure, unit-tested derivation of 'what should you DO' from the inbox snapshot, with severity and a jump target per nudge | `lib/nudges.ts:24-114 (tested in lib/__tests__/nudges.test.ts)` | A seventh signalling vocabulary today (rendered only on /inbox, never persisted), but it is the cleanest 'proactive prompt' engine in the codebase and the right place to host a login-time nudge banner (complaint #3) once it is given a durable surface. |


---


<a id="tax-1"></a>

## TAX-1 · Clicking a section badge opens the Notification Center UNFILTERED, so the panel that promises "click a 10, see the 10" shows a different number than the badge

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/navigation/Sidebar.tsx:532-545`, `components/notifications/NotificationCenter.tsx:76-85`, `components/notifications/NotificationCenter.tsx:112-117`, `components/cockpit/AttentionFeed.tsx:22`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Factually exact — I found no section-aware open() path anywhere (all five openCenter call sites pass only 'all' or 'action'), and even the 'red' branch maps a per-section actionRequired badge onto an app-wide action count. Severity is one notch high, though: nothing is lost or blocked — every item is present, navigable and additionally narrowable by AttentionFeed's KIND_GROUPS second axis (lines 64-69); the harm is a misleading count, not an unreachable item.

**Mechanism.** `SidebarLeaf` renders the per-section count from `sectionCounts[section]`, but its click handler calls `openCenter('action' | 'all')` - an `AttnFilter` with no section axis at all. `AttnFilter` is only `"all" | "action" | "unread"`. The Center then renders `items` (the whole org-wide feed) and its header states `${counts.all} items - every badge in the app counts these`, which is false for every section badge.

**Failure scenario.** Documents shows a blue 3 (three document-section items). The user clicks the 3. The panel opens headed "Needs your attention - 11 items - every badge in the app counts these" and lists 11 rows spanning requests, projects and documents. The user cannot tell which 3 the badge meant. This is the owner's complaint #1 restated: the number is a doorway that opens onto a different room.

**Evidence.**

```
components/navigation/Sidebar.tsx:537-541 -- `<button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openCenter(leaf.badgeTone === 'red' ? 'action' : 'all'); }} title="See these notifications"`

components/notifications/NotificationCenter.tsx:116 -- `: `${counts.all} item${counts.all === 1 ? "" : "s"} - every badge in the app counts these.`}`

components/cockpit/AttentionFeed.tsx:22 -- `export type AttnFilter = "all" | "action" | "unread";`
```

> **Verifier correction.** The evidence quotes NotificationCenter.tsx:116 with an ASCII hyphen; the file uses an em dash ("— every badge in the app counts these."). Same for Sidebar's title text. Cosmetic transcription only.

**Done when.**

- [ ] `open()` accepts a section (or arbitrary predicate) and the Center filters `items` by `item.section`
- [ ] The Center header count equals the badge count that opened it, for every badge in the app
- [ ] The header copy is only claimed when true, or is scoped ("3 items in Documents")

---

<a id="tax-2"></a>

## TAX-2 · Every PSM/OSHA compliance notification kind falls through `sectionForKind` to section 'other', which no sidebar row renders - the badge trail dies before it starts

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:71-103`, `hooks/useTicketNotifications.ts:100-102`, `components/navigation/Sidebar.tsx:229-235`, `app/api/cron/maintenance/route.ts:361-374`
- **Also surfaced independently as** [`DELIV-3`](./02-delivery-integrity.md#deliv-3) — two lenses found this separately. Fix once.
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is real and the review_due walkthrough is correct. Two corrections: the title's "Every" is false — `doc_superseded` is in COMPLIANCE_KINDS and DOES map to 'documents' (line 82) — and the trail does not fully die, since these items still appear in the bell/Notification Center/`/inbox` (NotificationCenter.tsx:77 counts all items) and group under AttentionFeed's "Documents & revisions" matcher (line 66 matches `review`/`ack`/`effective`/`retention`). That is a routing/discoverability gap, not a dropped obligation.

**Mechanism.** `sectionForKind` enumerates 23 kinds and returns `'other'` for everything else. Of the 48 declared kinds, 25 hit that default - including every kind the maintenance cron itself lists as compliance-critical: `review_due`, `review_requested`, `review_overdue`, `review_complete`, `review_invalidated`, `review_alternate_activated`, `ack_requested`, `ack_overdue`, `ack_unsatisfiable`, `retention_eligible`, `access_recert_due`, `effective_now`, `owner_behind`, `deletion_requested`, plus `library_doc_added`, `library_doc_revised`, `revision_published_over_checkout`, `legal_hold_placed`, `legal_hold_released`, `owner_assigned`, `security_export`, `project_comment`, `orchestrator_message`. The Sidebar reads only `sectionCounts.documents`, `.projects` and `.requests` - `.other` and `.scratchpad` are computed and thrown away. All of these kinds have live producers (lib/reviewControl.ts, lib/acknowledgments.ts, lib/retention.ts, lib/effectiveDate.ts, lib/accessRecert.ts, lib/postPublish.ts, lib/ownership.ts). `'scratchpad'` is itself dead: app/(protected)/scratchpad/page.tsx is a bare `redirect("/inbox")` stub.

**Failure scenario.** A controlled P&ID hits its periodic-review date. `lib/reviewCycles.ts` writes a `review_due` row and the cron emails a digest. The bell's total count goes up by one, but `sectionCounts.documents` does not move, so the Documents nav row shows no badge. The engineer sees the bell number rise, opens Documents looking for what changed, and finds nothing highlighted anywhere - exactly the owner's "the trail goes cold". Same for an `ack_requested` read-and-understand obligation, the strongest compliance signal in the product.

**Evidence.**

```
hooks/useTicketNotifications.ts:100-102 -- `    default:\n      return 'other';\n  }` (no case for review_*, ack_*, retention_eligible, effective_now, legal_hold_*, access_recert_due, library_doc_*)

components/navigation/Sidebar.tsx:229-235 -- `{ label: 'Documents', ... ...badgeOf(sectionCounts.documents) }, ... { label: 'Projects', ... ...badgeOf(sectionCounts.projects) }, { label: 'Drafting Requests', ... ...badgeOf(sectionCounts.requests), }` -- `.other` and `.scratchpad` are never read

app/api/cron/maintenance/route.ts:361-368 -- `const COMPLIANCE_KINDS = [\n  "review_due", "owner_behind",\n  "ack_requested", "ack_overdue", "ack_unsatisfiable",\n  "retention_eligible", "access_recert_due", "effective_now",\n  "review_requested", "review_overdue", "review_complete",\n  "review_alternate_activated", "deletion_requested",`
```

> **Verifier correction.** Two numeric/scope errors. (1) 26 of the 48 kinds fall through to 'other', not 25 — the finding's enumerated list of 23 omits ack_complete, review_signed and task_reminder. (2) 'every kind the maintenance cron lists as compliance-critical' is 14 of 15: `doc_superseded` is in COMPLIANCE_KINDS (route.ts:369) and IS mapped, to 'documents' (useTicketNotifications.ts:84). Severity lowered CRITICAL->HIGH: these rows are not invisible. They are counted by the header bell (NotificationBell.tsx:57 `const unread = count`, where hook :312 `count: items.length` includes every notification row regardless of section), listed by NotificationCenter, the /inbox feed and the dashboard widget, and app/api/cron/maintenance/route.ts:372+ emails a per-user compliance digest built from COMPLIANCE_KINDS. What is genuinely lost is the per-section sidebar badge — the owner's 'trail goes cold' complaint — not all surfacing.

**Done when.**

- [ ] Every kind in `COMPLIANCE_KINDS` resolves to a section whose sidebar row actually renders a badge
- [ ] `sectionCounts.other` is either rendered somewhere or provably always zero (a test asserts no producible kind maps to 'other')
- [ ] The dead `'scratchpad'` section is removed (its page is a redirect stub; no producer writes `task_nudge`/`task_overdue_digest`/`morning_digest`)
- [ ] Opening the badged section shows the badged items - the count is reproducible one level down

---

<a id="tax-3"></a>

## TAX-3 · Force-releasing a checkout emits five signals under two different names, and the tone of every one of them disagrees with the feed's own severity

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/checkoutEpisodes.ts:651-681`, `components/providers/NotificationListener.tsx:61-70`, `components/providers/NotificationListener.tsx:90`, `hooks/useTicketNotifications.ts:279`, `lib/notify/dispatch.ts:82-131`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Every element checks out — the system message toast, the notification-row toast, the durable bell row, the email (lib/notify/dispatch.ts:83 `const channels = input.channels ?? ["inapp", "email"]` with no override at the call site), and the info tone on an item the feed itself flags action-required. HIGH is a notch too far because no signal is lost: the victim gets a durable action-required feed row plus email; the defect is duplicate, mis-toned, mis-named noise.

**Mechanism.** `forceRelease` writes a `checkout_messages` system row whose text literally begins "SYSTEM ALERT:", then calls `emit()` which writes a `checkout_released` notification AND queues an email. The system row toasts to the whole org as title **"System Alert"** with `type: "info"` (blue Info icon). The notification row toasts a second time as **"Your checkout was force-released"**, also `type: "info"` - because `isError` only covers `checkout_conflict` and `hold_opened`. Yet the same `checkout_released` kind IS in the feed's `actionKinds`, so the bell renders it orange with "ACTION NEEDED". One event: two names, two blue toasts, an orange bell row, a sidebar badge and an email.

**Failure scenario.** Bob's checkout is force-released while he is on the Projects page. He sees a blue informational card saying "System Alert" (which he has learned to ignore, since every org member gets those) and a second blue card saying "Your checkout was force-released". Both auto-dismiss in 5-6s. If he was away from the keyboard, the only durable trace is a bell row he must notice is orange. The most consequential personal interrupt in the document-control model is delivered in the same visual tone as an FYI.

**Evidence.**

```
lib/checkoutEpisodes.ts:655 -- `text: `SYSTEM ALERT: checkout force-released by ${input.actorName}. All sessions ended.`,`

lib/checkoutEpisodes.ts:670-671 -- `kind: "checkout_released",\n        title: "Your checkout was force-released",`

components/providers/NotificationListener.tsx:90 -- `const isError = row.kind === "checkout_conflict" || row.kind === "hold_opened";`

hooks/useTicketNotifications.ts:279 -- `const actionKinds = new Set(['checkout_conflict', 'checkout_released', 'overlap_advisory', 'branch_open']);`
```

**Done when.**

- [ ] Toast tone is derived from the same action-required classification the feed uses - an action-required kind never renders as a blue `info` toast
- [ ] The "SYSTEM ALERT:" thread line and the notification title use one agreed wording for the event
- [ ] An action-required toast does not auto-dismiss, or leaves a persistent trace the user can reach after it vanishes
- [ ] No org-wide toast is emitted for an event that already has targeted recipients

---

<a id="tax-4"></a>

## TAX-4 · One checkout-thread post fires two toasts with two different wordings, and broadcasts a third to every org member regardless of document access

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/NotificationListener.tsx:38-73`, `components/providers/NotificationListener.tsx:80-100`, `lib/activityThread.ts:97-99`, `lib/activityThread.ts:153-164`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. I specifically hunted for the guard that would refute the broadcast — a document-level RLS predicate or a client-side access check before showToast — and there is none in either place. Recipients of the durable notification get two cards with different wordings (amber warning + blue info), and every other active org member gets the raw message text regardless of library or document permission, which is the confidentiality angle that keeps this at HIGH.

**Mechanism.** `postActivity` inserts into `checkout_messages`, then fire-and-forgets `notifyCheckoutActivity` which inserts a `checkout_message` row into `notifications`. `NotificationListener` subscribes to BOTH tables at once: channel 1 is filtered `org_id=eq.${activeOrgId}` (the whole workspace, no ACL check on the document), channel 2 is filtered `user_id=eq.${uid}`. A participant therefore matches both and gets two toast cards for the same post - one titled `New Message from ${data.user_name}` with the raw text, one titled `${userName} posted to ${label}` with a 140-char snippet. Everyone else in the org gets the first toast even if they cannot open the document.

**Failure scenario.** Alice posts "pressure relief sizing looks wrong on sheet 3" in a checkout thread Bob is watching. Bob sees two stacked cards in the corner: an amber "New Message from Alice" and a blue "Alice posted to P-1204-03". He assumes two things happened. Meanwhile every other signed-in member of the workspace - contractors and viewers included - sees "New Message from Alice / pressure relief sizing looks wrong on sheet 3" for a document they have no rights to.

**Evidence.**

```
components/providers/NotificationListener.tsx:65-70 -- `showToast({ type: isSystem ? "info" : "warning", title: isSystem ? "System Alert" : `New Message from ${data.user_name}`, message: data.text || "New activity in document.", duration: 5000, });`

components/providers/NotificationListener.tsx:92-97 -- `showToast({ type: isError ? "warning" : isMention ? "info" : "info", title: row.title, message: row.body ?? "", duration: 6000, });`

lib/activityThread.ts:159-160 -- `title: `${input.userName} ${kindWord} ${label}`,\n      body: snippet,`

components/providers/NotificationListener.tsx:46 -- `filter: `org_id=eq.${activeOrgId}`,`
```

**Done when.**

- [ ] A single post produces at most one toast per recipient
- [ ] The `checkout_messages` realtime channel is either removed (the durable `checkout_message` notification already covers recipients) or scoped to documents the viewer can read
- [ ] No toast is shown for a resource the viewer lacks ACL on
- [ ] A test drives one `postActivity` and asserts exactly one `showToast` call per recipient

---

<a id="tax-5"></a>

## TAX-5 · Six independent hand-maintained taxonomies classify the same `notifications.kind` string; none derive from a shared registry, and they contradict each other

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/inAppNotifications.ts:10-58`, `hooks/useTicketNotifications.ts:71-103`, `hooks/useTicketNotifications.ts:279`, `components/notifications/NotificationBell.tsx:19-44`, `components/cockpit/AttentionFeed.tsx:36-53`, `components/cockpit/AttentionFeed.tsx:64-75`, `components/providers/NotificationListener.tsx:90`, `app/api/cron/maintenance/route.ts:361-374`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Factually airtight — eight, not six, hand-maintained kind classifiers exist and none derives from a registry; 'review_requested' likewise hits KIND_GROUPS 'documents' (k.includes("review")) while sectionForKind falls through to 'other'. Downgraded to MEDIUM because the demonstrated user-visible consequence is which filter chip a row files under (cosmetic/maintainability); no data is lost and no obligation is hidden by this finding on its own.

**Mechanism.** `NotificationKind` (lib/inAppNotifications.ts:10-58) declares 48 kinds. Six separate places then re-classify that same string, each with its own hand-written list and its own matching strategy (exact switch vs Record lookup vs substring `includes`): (1) `sectionForKind` -> which sidebar row badges; (2) `actionKinds` -> whether the feed says "Action needed"; (3) `KIND_ICON` -> the bell's icon; (4) `attentionVisual` -> the feed's icon+tone; (5) `isError` -> the toast's colour; (6) `COMPLIANCE_KINDS` -> whether it earns an escalation email. No table, constant, or type ties them together, so adding a kind silently gets six different default treatments. This IS the answer to "are alerts and notifications the same thing": the code has one storage concept (`notifications`) and six competing meanings layered on top of it.

**Failure scenario.** A `markup_request` row: `sectionForKind` returns `'documents'` so it badges the Documents nav row, but `groupOf('markup_request')` hits `KIND_GROUPS` "requests" (`k.includes("markup")`) so inside the Notification Center it files under "Requests" - the badge points one way, the feed files it the other. A `review_requested` row: `KIND_ICON` has no entry so the bell draws a generic `Bell`; `attentionVisual` matches `k.includes("rev")` so the feed draws `GitBranch` blue. Same row, two icons, two homes. Only 23 of 48 kinds have a `KIND_ICON` entry at all.

**Evidence.**

```
hooks/useTicketNotifications.ts:71-96 -- `export function sectionForKind(kind: NotificationRow['kind'] | 'ticket'): AttentionSection { switch (kind) { ... case 'markup_request': ... return 'documents';`

components/cockpit/AttentionFeed.tsx:67 -- `{ key: "requests", label: "Requests", match: (k) => k.includes("ticket") || k.includes("assign") || k.includes("approval") || k.includes("engineer") || k.includes("markup") },`

components/notifications/NotificationBell.tsx:166 -- `const Icon = KIND_ICON[item.kind] ?? Bell;`

components/cockpit/AttentionFeed.tsx:44 -- `if (k.includes("rev") || k.includes("revision") || k.includes("version")) return { Icon: GitBranch, tone: "blue" };`
```

> **Verifier correction.** Two evidence line numbers are off by one to two lines: the `{ key: "requests", ... }` KIND_GROUPS entry is at AttentionFeed.tsx:66 (not :67), and the `k.includes("rev")` line is at :46 (not :44); attentionVisual spans :35-51 (not :36-53) and KIND_GROUPS spans :63-68 (not :64-75). The quoted code text is verbatim-correct in every case. Severity lowered to HIGH: this is the shared root cause, but its concrete user-visible harms are reported separately as findings 2, 4, 11 and 12 — on its own it is an architecture/maintainability defect, not an independent failure.

**Done when.**

- [ ] A single exported registry (e.g. `lib/notificationKinds.ts`) maps every `NotificationKind` to `{ section, group, icon, tone, actionRequired, compliance }` in one literal
- [ ] `sectionForKind`, `KIND_ICON`, `attentionVisual`, `KIND_GROUPS`, `actionKinds`, `isError` and `COMPLIANCE_KINDS` all read from that registry instead of their own lists
- [ ] A type-level exhaustiveness check (`Record<NotificationKind, KindMeta>`) makes adding a kind without classifying it a compile error
- [ ] A test asserts the bell icon and the feed icon for every kind are the same component

---

<a id="tax-6"></a>

## TAX-6 · The bell badge and the Notification Center are hard-capped at 50 unread notification rows, so a busy controller's true backlog is unreachable and unknowable

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:176`, `lib/inAppNotifications.ts:157-174`, `lib/inAppNotifications.ts:176-185`, `hooks/useTicketNotifications.ts:311-312`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The 50-row ceiling and the 'mark read → older rows page in → badge does not move' behavior are both real and confirmed. Downgraded to MEDIUM because the compliance backlog is NOT unknowable: lib/inbox.ts:249/309 computes an uncapped exact unread count, and /inbox renders dedicated, independently-sourced obligation lists — `data.reviewCyclesDueOnMe` (inbox/page.tsx:400), `data.distributionAcksPendingOnMe` (:416), `data.accessRecertsDue` (:430), plus listMyPendingAcks/listMyPendingReviews — so the actual PSM work items remain reachable outside the truncated bell feed.

**Mechanism.** `listMyNotifications({ onlyUnread: true, limit: 50, orgId })` applies `.limit(50)` server-side. `count` is then `items.length`, i.e. tickets + at most 50 notification rows. There is no pagination and no "N more" indicator - `AttentionFeed`'s "Show 30 more" only paginates within the 50 already fetched. `countUnread()` exists in lib/inAppNotifications.ts:176-185 and would give the true number, but the hook never calls it.

**Failure scenario.** After a bulk publish fans `ack_requested` out to 30 people and the nightly compliance scan adds `review_due` rows, a DocCtrl accumulates 180 unread rows. The bell shows 50-ish and stops moving. Marking items read makes the badge stay at the same number (older rows page in), which reads as a broken counter; more importantly the user has no way to see, or even learn the existence of, rows 51-180.

**Evidence.**

```
hooks/useTicketNotifications.ts:176 -- `let n = await listMyNotifications({ onlyUnread: true, limit: 50, orgId: activeOrgId })`

lib/inAppNotifications.ts:164 -- `.limit(opts?.limit ?? 50);`

hooks/useTicketNotifications.ts:311-312 -- `/** The single count every surface badges (the header bell + Home). */\n    count: items.length,`
```

> **Verifier correction.** One addition that strengthens rather than weakens it: lib/inbox.ts:164 DOES compute a true `unreadNotificationCount` via `select("*", { count: "exact", head: true })`, exposed at :110/:309 — but `grep -rn unreadNotificationCount` shows it is consumed by nothing except a test fixture (lib/__tests__/nudges.test.ts:12). So there are two dead true-count paths, not one, and the real backlog is indeed never displayed.

**Done when.**

- [ ] The badge shows the true unread count (via `countUnread`) even when the list is paged
- [ ] The feed can page past 50 rows, or explicitly says "showing the newest 50 of N"
- [ ] Marking rows read monotonically decreases the badge

---

<a id="tax-7"></a>

## TAX-7 · "Unread" names three different quantities and one of them is a dead export; the same panel labels the same filter "unread" in code and "Activity" in the UI

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:252-256`, `hooks/useTicketNotifications.ts:305`, `hooks/useTicketNotifications.ts:313-315`, `components/cockpit/AttentionFeed.tsx:85-89`, `components/notifications/NotificationCenter.tsx:76-80`, `app/(protected)/inbox/page.tsx:72-77`, `components/dashboard/widgets.tsx:673-677`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every leg. `unreadCount` is dead — repo-wide grep for `unreadCount` returns only its own definition and return in the hook, no consumer; the same is true of `countUnread` and of lib/inbox.ts's `unreadNotificationCount` (declared :110, computed :249, returned :309, referenced only by a test fixture), so there is in fact a fourth orphaned 'unread' quantity the finding did not name.

**Mechanism.** Three distinct "unread" concepts share the word. (1) `notifications.read_at IS NULL` - the DB truth, driving `listMyNotifications({onlyUnread:true})`. (2) `tickets.unread_by` - a per-ticket array feeding the hook's `unreadCount` (only tickets that are unread AND not action-required). (3) `counts.unread` - computed independently in three separate files as `items.filter(i => !i.actionRequired).length`, i.e. "everything that isn't an action item", which includes notification rows regardless of read state. The `AttnFilter` key is literally `"unread"` but its user-facing label is `"Activity"`. The hook's own `unreadCount` and `totalNotifications` exports are consumed by nothing - verified with two search shapes (`rg -i unreadcount` and `grep -rn unreadCount --include=*.ts --include=*.tsx`), both returning only the three definition lines inside the hook itself.

**Failure scenario.** An engineer reads the Center header "11 items", the Activity chip "7", and the sidebar Documents badge "3", and cannot reconcile them because "unread" silently changes definition between them. A developer adding a surface picks `unreadCount` off the hook (it reads like the right thing), gets a ticket-only number that disagrees with every visible badge, and ships a fourth count.

**Evidence.**

```
hooks/useTicketNotifications.ts:254-256 -- `const unread = !!uid && !!t.unreadBy?.includes(uid);\n      if (!actionReq && !unread) continue;\n      if (actionReq) ar++; else ur++;`

hooks/useTicketNotifications.ts:313-315 -- `    actionRequiredCount,\n    unreadCount,\n    totalNotifications: items.length,`

components/cockpit/AttentionFeed.tsx:85-89 -- `const FILTERS: Array<{ key: AttnFilter; label: string; n: number }> = [ { key: "all", label: "All", n: counts.all }, { key: "action", label: "Action", n: counts.action }, { key: "unread", label: "Activity", n: counts.unread }, ];`

components/notifications/NotificationCenter.tsx:76-80 -- `const counts = { all: items.length, action: items.filter((i) => i.actionRequired).length, unread: items.filter((i) => !i.actionRequired).length, };`
```

**Done when.**

- [ ] The `AttnFilter` key is renamed to match its label (`"activity"`), or the label to match the key
- [ ] `counts` is computed once in the hook and consumed identically by AttentionFeed, NotificationCenter, the inbox page and the dashboard widget (currently duplicated in three files)
- [ ] The unused `unreadCount` and `totalNotifications` exports are removed or given a single documented meaning
- [ ] A vocabulary note in the hook states the difference between DB-unread, ticket-unread and non-action "activity"

---

<a id="tax-8"></a>

## TAX-8 · Dismissals are not remembered, and one indicator actively un-dismisses itself when new work arrives - contradicting its own comment

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/KnowledgeIndexIndicator.tsx:50-55`, `components/providers/KnowledgeIndexIndicator.tsx:91`, `components/documents/EditOverlapBanner.tsx:41-42`, `components/documents/EditOverlapBanner.tsx:133-137`, `components/ui/FirstRunHint.tsx:26-50`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Substance holds: both dismissals are ephemeral React state and the indexing card genuinely un-hides itself whenever the poll finds queued work. One imprecision worth recording — the comment at :50-55 ('new work must NOT re-expand a card the user deliberately tucked away') governs `minimized`, not `hidden`, and `minimized` is in fact never reset by the drain, so the code does not literally contradict that comment; it fails to extend the same stickiness to the Dismiss affordance.

**Mechanism.** `KnowledgeIndexIndicator` documents `minimized` as "Sticky across drain passes - new work must NOT re-expand a card the user deliberately tucked away", but the sibling `hidden` state is reset to `false` inside the drain loop the moment a new document is picked up, and neither flag is persisted. `EditOverlapBanner`'s `dismissed` and `nudged` are plain component `Set`s - cleared by any remount or navigation. Contrast `FirstRunHint`, the only surface in the app that persists a dismissal (localStorage, `first_run_hint:` prefix, hydration-safe via `useSyncExternalStore`).

**Failure scenario.** A DocCtrl dismisses the "Knowledge indexing caught up" card. The 2-minute poll finds one more queued PDF, `setHidden(false)` fires, and the card is back - for the rest of the day, on every page. Likewise a user dismisses the amber overlap banner on a document, navigates away and back, and the banner returns with the same "Send heads-up" button they already used, since `nudged` is also component state - so they can re-nudge the same colleagues repeatedly with no record that they already did.

**Evidence.**

```
components/providers/KnowledgeIndexIndicator.tsx:52-55 -- `// Sticky across drain passes - new work must NOT re-expand a card the\n  // user deliberately tucked away.\n  const [minimized, setMinimized] = useState(false);`

components/providers/KnowledgeIndexIndicator.tsx:91 -- `          setHidden(false);`

components/documents/EditOverlapBanner.tsx:41-42 -- `const [dismissed, setDismissed] = useState<Set<string>>(new Set());\n  const [nudged, setNudged] = useState<Set<string>>(new Set());`
```

> **Verifier correction.** The 'contradicting its own comment' framing is wrong. The comment at :52-55 ('Sticky across drain passes — new work must NOT re-expand a card the user deliberately tucked away') governs `minimized`, declared at :55, and `minimized` is in fact never reset in the loop — that contract is honored. The flag the loop resets at :91 is the sibling `hidden` (the X-dismiss), which has no such comment. So the defect is real (dismiss is undone by new work; nothing persists across reload) but it does not contradict the stated comment.

**Done when.**

- [ ] Every dismissible signalling surface persists its dismissal on the same substrate `FirstRunHint` uses (or a shared `useDismissed(key)` hook)
- [ ] `setHidden(false)` is removed from the drain loop, or the dismissal is scoped to the current run and documented as such
- [ ] "Heads-up sent" survives a remount (derived from the notification rows, not local state)

---

<a id="tax-9"></a>

## TAX-9 · In-app notifications have no preference gate, no throttle and no cap - `inapp_enabled` is stored but read by nothing, and a cron burst produces an unbounded toast stack

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260723_notifications_unify.sql:86`, `lib/notify/dispatch.ts:89-103`, `lib/inAppNotifications.ts:79-98`, `components/providers/ToastProvider.tsx:40-49`, `components/ui/CornerDock.tsx:25`, `app/(protected)/settings/notifications/page.tsx:7-9`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every leg verified: no in-app preference gate, no throttle, no toast cap, and the dock cannot scroll or clip a tall stack. NotificationListener.tsx:80-100 fires one showToast per realtime INSERT with no coalescing, so an N-row cron burst does produce N stacked cards.

**Mechanism.** `emit()` gates the email channel through `queueEmail`, which reads `notification_preferences`. The in-app branch calls `notifyMany` unconditionally - `notify()` does a bare INSERT with no preference lookup. `inapp_enabled` (added by the unify migration "the unified dispatcher honors") is read nowhere (verified with `grep -rn inapp_enabled --include=*.ts --include=*.tsx` -> zero app hits; `rg` over all globs -> only the migration and schema.sql). `NotificationListener` then toasts EVERY inserted row for the user with no kind filter and no rate limit, and `ToastProvider.showToast` appends without a cap into a `CornerDock` that has no `max-height` and no `overflow`.

**Failure scenario.** The nightly maintenance cron inserts 40 compliance rows (`review_due`, `ack_overdue`, `retention_eligible`, ...) for a DocCtrl who happens to have the tab open. Supabase realtime delivers 40 INSERTs; `NotificationListener` calls `showToast` 40 times; `ToastProvider` renders 40 stacked cards in a fixed bottom-right column with no scroll. The stack runs off the top of the viewport, covers the page, and there is no bulk dismiss. No setting turns this off - the settings page says "In-app bell notifications are always on."

**Evidence.**

```
lib/notify/dispatch.ts:89-91 -- `if (channels.includes("inapp")) {\n    await notifyMany({` (no preference read)

lib/inAppNotifications.ts:80-93 -- `try {\n    const { error } = await supabase.from("notifications").insert({ ... });` (no preference read)

components/providers/ToastProvider.tsx:42 -- `setToasts((prev) => [...prev, { id, type, title, message, duration }]);`

components/ui/CornerDock.tsx:25 -- `className="fixed bottom-4 right-4 z-[300] flex flex-col items-end gap-2 pointer-events-none max-w-[calc(100vw-2rem)]"` (no max-height, no overflow)
```

> **Verifier correction.** Two overstatements. (1) The unify migration's actual comment is 'Per-channel preference switches for the unified dispatcher' — the finding presents 'the unified dispatcher honors' inside quotation marks, which is a paraphrase, not the file's text. (2) The cited settings page is a mitigation, not corroboration: app/(protected)/settings/notifications/page.tsx:7-9 states 'In-app bell notifications are always on — they're the persistent inbox; the email side is the opt-in noise layer', and its `Prefs` interface (:23-31) exposes only email_* toggles. So no user is ever promised an in-app toggle; `inapp_enabled` is a dead column, not a broken promise. Also, toasts self-remove after their duration (ToastProvider.tsx:44-48, 5-6s), so the stack is bounded by arrival rate within that window rather than truly unbounded. Severity lowered to MEDIUM accordingly; the substantive defect is the missing throttle/cap on a burst, which stands.

**Done when.**

- [ ] `emit()`'s in-app branch honors `inapp_enabled` (or the column is dropped)
- [ ] `ToastProvider` caps the visible stack (e.g. 3-4) and collapses the remainder into a "+N more" that opens the Notification Center
- [ ] `CornerDock` has a `max-h` with `overflow-y-auto` so the stack can never exceed the viewport
- [ ] `NotificationListener` does not toast bulk/system-generated kinds one-per-row; batched inserts produce one summary toast

---

<a id="tax-10"></a>

## TAX-10 · Nothing below the sidebar consumes the attention feed, so a badge can never propagate library -> folder -> document; and the one "poke a person" act has three names, none reachable from a drafting request

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:134`, `components/documents/EditOverlapBanner.tsx:79-97`, `components/documents/DistributionRecall.tsx:48-56`, `lib/staleCopies.ts:182-208`, `lib/orchestrator/tools.ts:505-515`, `app/(protected)/requests/[id]/page.tsx`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed. All four nudge paths require a document_id (the orchestrator tool at tools.ts:495 loads `d.document_number` / `d.library_id` before emitting), so none is reachable from a ticket stuck at PENDING_FINAL_APPROVAL.

**Mechanism.** `useTicketNotifications` is imported by exactly six files - Sidebar (:124), NotificationBell (:54), NotificationCenter (:55), dashboard widgets (:669 and :1223), and the inbox page (:38). Verified with two search shapes (`rg -n useTicketNotifications --glob '*.ts' --glob '*.tsx'` and `grep -rn useTicketNotifications --include=*.tsx`). No documents page, library page, folder tree, FileExplorer, request list or project page reads it, so no surface below the nav rail has the data to render a badge - the chain is not broken, it was never built. (As a side effect three to five copies of the hook mount simultaneously, each opening its own realtime channel and re-running the full up-to-500-row ticket fetch on every org-wide ticket or notification change.) Separately, three distinct implementations of "poke a specific colleague" exist under three names - `sendHeadsUp` (EditOverlapBanner, copy "Send heads-up"/"Heads-up sent", kind `overlap_advisory`), `nudgeStaleHolders` (copy "Recall sent to N people", kind `doc_superseded`), and the orchestrator's `notify_personnel` tool (title "About <docnum>", kind `orchestrator_message`). `rg -i 'nudge|remind|poke|heads.?up'` over app/(protected)/requests/[id]/page.tsx returns nothing.

**Failure scenario.** A user sees the red 3 on Drafting Requests, clicks through to /requests, and the list renders no per-row marker sourced from the feed - they must eyeball statuses to find which three. Inside a request stuck at PENDING_FINAL_APPROVAL there is no way to prod the assigned engineer, even though the app already has three working person-to-person notify paths elsewhere, each named differently.

**Evidence.**

```
hooks/useTicketNotifications.ts:134 -- `export function useTicketNotifications() {` (consumers: Sidebar.tsx:124, NotificationBell.tsx:54, NotificationCenter.tsx:55, widgets.tsx:669, widgets.tsx:1223, inbox/page.tsx:38)

components/documents/EditOverlapBanner.tsx:125-126 -- `<BellRing className="w-3 h-3" /> Send heads-up`

components/documents/DistributionRecall.tsx:105 -- `<CheckCircle2 className="w-3.5 h-3.5" /> Recall sent to {nudgedCount} {nudgedCount === 1 ? "person" : "people"}`

lib/orchestrator/tools.ts:509-511 -- `kind: "orchestrator_message",\n      title: `About ${d.document_number}`,`
```

> **Verifier correction.** The second half is materially overstated on two points and must not be acted on as written. (1) A person-to-person poke IS reachable from a drafting request: app/(protected)/requests/[id]/page.tsx:15 imports MentionableTextarea and renders it at :2052 in the comment composer; :1216 calls `extractMentionUids(text)` and :1235-1237 POSTs to /api/tickets/comment, which at route.ts:272 writes `kind: mentionSet.has(uid) ? "ticket_mention" : "ticket_comment"` — bell + email fan-out to the named engineer. So there are four poke implementations, not three, and the fourth lives exactly where the finding says none exists. The accurate complaint is that there is no *dedicated* nudge affordance on a request awaiting approval (the `rg -i 'nudge|remind|poke|heads.?up'` result of zero on that file is correct), only an @-mention buried in the comment box. (2) The hook's realtime subscription for notifications is filtered `user_id=eq.${uid}` (hook :225), not org-wide — only the tickets channel (:223) is org-wide, so 'every org-wide ticket or notification change' should read 'every org-wide ticket change, or any of my own notification changes'.

**Done when.**

- [ ] A `useAttentionFor(section | resourceId)` selector lets a library row, folder row and document row each render the count of feed items whose `resourceId` matches
- [ ] Opening a badged library shows the badged folder; opening that folder shows the badged document
- [ ] The feed is fetched once per page (context/provider) rather than once per mounted consumer
- [ ] One named person-to-person action ("Nudge") with one component and one kind replaces the three ad-hoc implementations, and is available from a drafting request's approval step targeting the assigned engineer

---

<a id="tax-11"></a>

## TAX-11 · Notification kinds are written that do not exist in the `NotificationKind` union - they get no icon, no section, and no classification anywhere

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/storageAlerts.ts:56-65`, `lib/storageUsage.ts:250-258`, `lib/inAppNotifications.ts:10-58`, `supabase/migrations/20260621_in_app_notifications.sql:17`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified end to end — these kinds miss KIND_ICON (NotificationBell.tsx:166 falls back to `Bell`), fall through sectionForKind's default to 'other' (which no sidebar row badges), and match no KIND_GROUPS predicate, so groupOf() returns 'other' and no chip is rendered for them (AttentionFeed.tsx:144-158 only maps KIND_GROUPS).

**Mechanism.** `notifications.kind` is untyped `TEXT` in SQL with no CHECK constraint. Two producers bypass `notify()`/`notifyMany()` entirely and insert raw rows with kinds absent from the TypeScript union: `storage_alert` (lib/storageAlerts.ts) and template-built `storage_platform_r2` / `storage_platform_db` (lib/storageUsage.ts, `kind: \`storage_${alert.key}\``). Because they are not in the union, they miss `KIND_ICON`, miss every `sectionForKind` case, miss `KIND_GROUPS` (no substring predicate matches "storage_"), miss `actionKinds`, and miss `COMPLIANCE_KINDS`. TypeScript cannot catch it because the insert is an untyped object literal against an untyped column.

**Failure scenario.** Storage crosses 90%. Every Admin gets a row titled "Storage critical - 96% full". In the bell it renders with a generic `Bell` icon; in the Notification Center's group chips it matches no group, so it lands in the hidden 'other' bucket with no chip and cannot be filtered to; no sidebar row badges. The most urgent infrastructure warning the product produces is the least visible one.

**Evidence.**

```
lib/storageAlerts.ts:60-63 -- `await sb.from("notifications").insert({\n        org_id: s.org_id, user_id: a.uid, kind: "storage_alert",\n        title: band === "crit" ? `Storage critical - ${pct}% full` : `Storage high - ${pct}% full`,`

lib/storageUsage.ts:255-257 -- `const { error } = await sb.from("notifications").insert({\n          org_id: org.id, user_id: a.uid, kind: `storage_${alert.key}`,`

supabase/migrations/20260621_in_app_notifications.sql:17 -- `  kind TEXT NOT NULL,                          -- ticket_comment | ticket_mention | ticket_status | checkout_conflict | project_member | hold_opened | ...` (no CHECK)
```

**Done when.**

- [ ] `storage_alert` / `storage_platform_*` are added to `NotificationKind` and classified in the shared registry
- [ ] Every insert into `notifications` goes through `notify()`/`notifyMany()` so the `NotificationKind` type is enforced at compile time
- [ ] A DB CHECK constraint (or a test scanning for raw `.from("notifications").insert`) prevents the next unclassified kind

---

<a id="tax-12"></a>

## TAX-12 · OS-level notification presence is a fully built shell with zero wiring: the service worker handles `push`, the `push_subscriptions` table and RLS exist, `push_enabled` is a stored preference - and nothing subscribes or sends

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:226-240`, `public/sw.js:241-259`, `supabase/migrations/20260804_push_subscriptions.sql:1-36`, `supabase/migrations/20260723_notifications_unify.sql:85-87`, `lib/notify/dispatch.ts:20`, `components/pwa/ServiceWorkerManager.tsx:30-51`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed with no mitigation found: nothing calls registration.pushManager.subscribe, no VAPID key exists anywhere, no sender writes to the Web Push endpoint, and settings/notifications/page.tsx's Prefs (:24-31) omits push_enabled entirely. lib/schemaExpectations.ts:99 additionally makes the health check demand a table for a feature that has no client or server half.

**Mechanism.** `public/sw.js` registers a `push` listener that calls `self.registration.showNotification(...)` and a `notificationclick` listener that focuses/opens the target URL - the entire receive side is done. `push_subscriptions` (endpoint, p256dh, auth, last_reminded_at) exists with per-user RLS and a comment saying "The reminder cron (service role) reads every row". But no code calls `pushManager.subscribe`, no code inserts into `push_subscriptions`, no VAPID key appears anywhere, and no code sends web-push. Verified with three search shapes (`rg -niE 'web-?push|pushManager|requestPermission|showNotification'` over ts/tsx; `grep -rn push_subscriptions --include=*.ts --include=*.tsx`; `grep -rniE 'vapid'` over ts/tsx/sql/json/mjs): the only ts/tsx hits for `push_subscriptions` are lib/schemaExpectations.ts:99, lib/exportTables.ts:167 and lib/dataRestore.ts:92 - schema bookkeeping, never a read or write. `NotifChannel` in the dispatcher is only `"inapp" | "email"`.

**Failure scenario.** A user closes the tab. Nothing can reach them - no OS banner, no badge, no sound. The `push_enabled` toggle they'd expect isn't even rendered on /settings/notifications. The one place the app claims otherwise is the sw.js comment "fires whether the app is open or closed", which is currently false.

**Evidence.**

```
public/sw.js:226-239 -- `self.addEventListener("push", (event) => { ... event.waitUntil(self.registration.showNotification(title, options)); });`

supabase/migrations/20260804_push_subscriptions.sql:4-5 -- `-- One row per browser/device the user opted in from. The reminder cron\n-- (service role) reads every row; users manage only their own via RLS.`

supabase/migrations/20260723_notifications_unify.sql:85-87 -- `ALTER TABLE notification_preferences\n  ADD COLUMN IF NOT EXISTS inapp_enabled BOOLEAN NOT NULL DEFAULT TRUE,\n  ADD COLUMN IF NOT EXISTS push_enabled  BOOLEAN NOT NULL DEFAULT TRUE;`

lib/notify/dispatch.ts:20 -- `export type NotifChannel = "inapp" | "email";`
```

> **Verifier correction.** Severity lowered HIGH->MEDIUM. Nothing is broken by this — it is an unbuilt feature plus scaffolding whose comments assert a sender that does not exist. The user-facing consequence is zero today; the real cost is the misleading migration comment and the unused `push_enabled` column. Worth noting for the owner's complaint #2 that the receive half genuinely is done, so the remaining work is subscribe + VAPID + a sender.

**Done when.**

- [ ] A client-side opt-in calls `Notification.requestPermission()` + `registration.pushManager.subscribe({applicationServerKey})` and POSTs the subscription into `push_subscriptions`
- [ ] A server sender (VAPID keys in env) reads `push_subscriptions` and delivers for a defined subset of kinds
- [ ] `NotifChannel` gains `"push"`, `emit()` honors `push_enabled`, and /settings/notifications renders the toggle
- [ ] Revoked/410 endpoints are pruned from `push_subscriptions`

---

<a id="tax-13"></a>

## TAX-13 · Single kinds carry contradictory meanings: `checkout_released` means both "yours was taken" and "someone else's is stale"; `doc_superseded` means three different things

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/checkoutEpisodes.ts:670-672`, `app/api/cron/maintenance/route.ts:344-353`, `lib/staleCopies.ts:195-207`, `app/api/intake/upload/route.ts:349-351`, `app/api/cron/maintenance/route.ts:370-373`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and understated if anything: doc_superseded has eight distinct producers carrying at least four unrelated meanings, and checkout_released has three (checkoutEpisodes force-release, the cron stale-checkout escalation, and lib/projects.ts:1107). Nothing downstream can tell them apart — kind is the only discriminator any icon, tone, section or future mute/push filter has.

**Mechanism.** `kind` is the only routing/classification key the six taxonomies have, so overloading it makes every downstream decision wrong for at least one of the meanings. `checkout_released` is written both by `forceRelease` (title "Your checkout was force-released", audience = the victim) and by `escalateStaleCheckouts` (title "Checkout held N days - review needed", audience = Admin/DocCtrl about someone else). Both are flagged `actionRequired` by `actionKinds` and drawn with the same `Lock` icon. `doc_superseded` is written by the real supersede path, by `nudgeStaleHolders` as a manual recall (`metadata: { recall: true }`), and by the intake auto-publish path - and the cron's own comment admits "Manual distribution-ack requests/re-nudges ride on doc_superseded".

**Failure scenario.** An Admin's bell shows two orange "Action needed" rows with a padlock icon. One means "your work was destroyed, coordinate before publishing"; the other means "go poke Bob about his old checkout". Nothing in the icon, the tone or the section distinguishes them. Any future filter, mute or push-channel rule keyed on `checkout_released` necessarily hits both.

**Evidence.**

```
lib/checkoutEpisodes.ts:670-671 -- `kind: "checkout_released",\n        title: "Your checkout was force-released",`

app/api/cron/maintenance/route.ts:346-347 -- `kind: "checkout_released",\n      title: `Checkout held ${days} days - review needed`,`

lib/staleCopies.ts:198-199 -- `kind: "doc_superseded",\n    title: `Your copy of ${input.docLabel} is out of date`,`

app/api/cron/maintenance/route.ts:370-372 -- `// Manual distribution-ack requests/re-nudges ride on doc_superseded (the\n  // daily scan's nags use ack_requested/ack_overdue); voided sign-offs are\n  // obligations too.`
```

> **Verifier correction.** If anything understated: doc_superseded has eight producer sites carrying at least five distinct meanings, not three.

**Done when.**

- [ ] Each distinct human meaning has its own kind (e.g. `checkout_force_released` vs `checkout_stale_escalation`; `doc_recalled` vs `doc_superseded`)
- [ ] No kind's meaning depends on inspecting `metadata` to disambiguate
- [ ] Each new kind is classified in the shared registry with its own icon, section and severity

---

<a id="tax-14"></a>

## TAX-14 · Three floating-signal corners and four z-layers; BackupIndicator (z-300) covers the offline/update pills (z-200) in the same bottom-left corner, and two separate surfaces both announce "a new version is available" in different words

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/ui/CornerDock.tsx:3-13`, `components/providers/BackupIndicator.tsx:27`, `components/pwa/ServiceWorkerManager.tsx:74-88`, `components/projects/UndoToastHost.tsx:21`, `components/system/UpdatePill.tsx:41-48`, `app/(protected)/layout.tsx`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed including simultaneous mounting: app/(protected)/layout.tsx:61-65 mounts UpdatePill, CornerDock, BackupIndicator and KnowledgeIndexIndicator; app/layout.tsx:93 mounts ServiceWorkerManager; UndoToastHost is mounted by components/projects/ExecutionView.tsx:926 — so the Projects → Execution scenario has all of them live at once, and the two different 'new version' wordings come from two independent detectors (a waiting service worker vs. a polled /api/version build id).

**Mechanism.** `CornerDock` declares itself "ONE bottom-right corner for every floating surface" at z-[300]; toasts, UploadIndicator and KnowledgeIndexIndicator portal into it. But `BackupIndicator` never imports `CornerPortal` - it pins `fixed bottom-5 left-5 z-[300] w-[340px]`. `ServiceWorkerManager` (mounted globally in app/layout.tsx) pins `fixed bottom-4 left-4 z-[200]` - the same corner, 1px offset, lower z, so the 340px backup card paints over it. `UndoToastHost` (mounted in components/projects/ExecutionView.tsx:926) pins `fixed bottom-4 left-1/2 -translate-x-1/2 z-[280]` - bottom-centre. Separately, `UpdatePill` (top-centre, z-[100], polls /api/version) and `ServiceWorkerManager` (bottom-left, watches the SW waiting worker) are two independent detectors of the same fact with two different wordings, mounted in two different layouts so both can be live at once.

**Failure scenario.** A DocCtrl on the Projects -> Execution tab starts a full backup after a deploy, on flaky site Wi-Fi. The backup card (z-300, bottom-left) covers the amber "Offline - showing cached data" pill and the "Update available - tap to refresh" button (both z-200, bottom-left); an undo toast appears bottom-centre (z-280); upload + index cards stack bottom-right (z-300); and five minutes later "This tab is running an old version" appears top-centre. Five signals, four corners, and two of them are invisible.

**Evidence.**

```
components/ui/CornerDock.tsx:3-4 -- `// CornerDock - ONE bottom-right corner for every floating surface.`

components/providers/BackupIndicator.tsx:27 -- `<div className="fixed bottom-5 left-5 z-[300] w-[340px] max-w-[calc(100vw-2.5rem)] rounded-2xl ...">`

components/pwa/ServiceWorkerManager.tsx:74 -- `<div className="fixed bottom-4 left-4 z-[200] flex flex-col gap-2 pointer-events-none">` and :87 -- `Update available - tap to refresh`

components/system/UpdatePill.tsx:41 -- `<div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] animate-pop">` and :47 -- `This tab is running an old version - tap to load the update`

components/projects/UndoToastHost.tsx:21 -- `<div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[280] flex flex-col items-center gap-2 pointer-events-none">`
```

> **Verifier correction.** Minor line drift: the ServiceWorkerManager container is at :73 (not :74) and its copy at :86 (not :87). Also worth noting the overlap only materializes while a backup is actually running — BackupIndicator.tsx:22 returns null when there is no progress object — so it is a conditional occlusion, which is consistent with the MEDIUM rating.

**Done when.**

- [ ] Exactly two docks exist and are documented: one for transient/action feedback, one for long-running background jobs; no two globally-mounted surfaces share a corner with different z-index values
- [ ] `BackupIndicator` and `ServiceWorkerManager` share one left dock as flex children, or move into `CornerPortal`
- [ ] One component owns "a newer build exists", fed by both the version poll and the SW waiting-worker signal - one wording, one placement, one prompt at a time
- [ ] A single `Z` constant module owns every overlay layer number

---
