# 05 · Realtime, listeners & the tab lifecycle

**12 findings** — 3 HIGH · 9 MEDIUM.

Channels, teardown, multi-tab drift, and what happens to events that fire while nobody is looking.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded. A severity set by that pass overrides the original.


### Already there — reusable substrate

| Thing | Where | Why it matters |
|---|---|---|
| Every one of the 16 realtime channels in the app is correctly torn down on unmount. There are NO leaked subscriptions and no duplicate-on-remount bugs. | `lib/presence.ts:76-80, lib/libraryCollections.ts:432-435, lib/tableViews.ts:266-269, components/providers/NotificationListener.tsx:102-105, components/documents/ActivityThread.tsx:115, components/documents/CheckoutStatusCell.tsx:134, components/documents/CheckoutFlowModal.tsx:206 and :262, components/projects/ScheduleTab.tsx:116-119, app/(protected)/documents/[libraryId]/page.tsx:1497, :1538, :1993, app/(protected)/requests/page.tsx:320, app/(protected)/requests/[id]/page.tsx:941, hooks/useTicketNotifications.ts:229` | The obvious realtime bug class is already solved — every cleanup calls `supabase.removeChannel`, every async fetch is guarded by an `alive` flag, and every `setInterval`/`setTimeout` companion is cleared. Do not spend remediation effort hunting leaks; the problems are all about what happens when the socket is DOWN, and about how many correctly-managed channels there are. |
| Multi-tab read-state sync already works for notification rows. Tab A marking read produces an UPDATE on `notifications`; the table is in the publication with REPLICA IDENTITY FULL, and every attention channel subscribes with `event: '*'` filtered on `user_id`, so Tab B refetches and its badge drops. | `hooks/useTicketNotifications.ts:225-226 + supabase/migrations/20260727_checkout_activity_fix.sql:53-60` | The 'two tabs, one marks read, does the other update?' question has a working answer as long as the socket is alive — so the multi-tab fix is a subset of the reconnect-reconcile fix, not separate work. The same is true for `tickets` (published in schema.sql:1139), so `unread_by` clears cross-tab too. |
| A working, tested reconcile-on-return pattern already exists in this codebase: focus + visibilitychange + 60s interval, all cleaned up, with a `background` flag so the refresh does not trigger a full-page spinner. | `app/(protected)/inbox/page.tsx:117-127 (and a near-identical one at app/(protected)/coordination/page.tsx:127)` | The single highest-value fix — reconciling the attention feed on tab return — is a copy of code the team already wrote and already shipped. It just was never applied to the hook that feeds every badge in the app. |
| The publication-membership pattern is already idempotent and safe to re-run: an `IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename=...)` guard wrapped in a DO block, plus the matching `REPLICA IDENTITY FULL` statement. | `supabase/migrations/20260727_checkout_activity_fix.sql:48-60` | Adding `milestones`, `table_views` and any missing REPLICA IDENTITY is a ten-line migration copied from this file — no new pattern to invent, and it re-runs safely against a database where someone already fixed it by hand in the dashboard. |
| The unfiltered-DELETE companion listener, with a comment that correctly diagnoses the PK-only-old-record problem. | `lib/libraryCollections.ts:419-427` | The fix for the DELETE-filter blindness on `documents`, `tickets` and `checkout_sessions` is already written and proven for `collections`. It just needs to be generalised. |
| `sectionForKind` and `SectionCounts` already exist as the spine of a per-section badge trail, with an `AttentionItem.section` field on every item and per-section action-required tallies. | `hooks/useTicketNotifications.ts:65-132, :246-302` | The owner's complaint #1 ('the badge does not continue down the chain library → folder → document') is one level deeper than the machinery already built. `AttentionItem` carries `resourceId`/`link` for every item, so a `libraryId`/`folderId`/`documentId` breakdown can be derived from data already in the feed rather than requiring a new query path. |
| The service worker's `push` and `notificationclick` handlers are complete and correct — including window-focus-or-open, tag/renotify, and icon/badge assets. | `public/sw.js:222-256` | Complaint #2 (real OS-level notification presence) is roughly 60% built. What is missing is only the client subscribe call, a VAPID keypair, and a server sender — the receive-and-display half is done and the `push_subscriptions` table already exists (migration 20260804). |
| `CornerDock` / `CornerPortal` is a single shared bottom-right stack with graceful fallback when the dock is not mounted, and toasts, upload, backup and knowledge-index indicators all already portal into it. | `components/ui/CornerDock.tsx:21-48; consumers at components/providers/ToastProvider.tsx:57, KnowledgeIndexIndicator.tsx:135` | Complaint #5 (background job messages should stack gracefully bottom-right) is architecturally done. The gap is only a stack cap, a coalescing rule, and a max-height/overflow on the dock — not a new surface. |
| `notifyMany` and `emit`/`resolveRecipients` both already drop the actor from the recipient set, and the checkout-message toast handler already checks `data.user_id === uid`. | `lib/inAppNotifications.ts:117-119, lib/notify/dispatch.ts:76, components/providers/NotificationListener.tsx:61-63` | The self-notification guard exists in three places. The notifications toast channel is the one place it was omitted — a one-line fix using an existing convention, not a policy decision. |
| `ScheduleTab` demonstrates the debounced-refetch pattern for a chatty realtime channel: a 600ms trailing timer, cleared both on the next event and on unmount. | `components/projects/ScheduleTab.tsx:105-120` | The thundering-herd fix for `useTicketNotifications` has a working in-repo template; it is the only subscription in the app that debounces, and it should be the default. |


---


<a id="rt-1"></a>

## RT-1 · Every realtime event that fires while the tab is asleep, backgrounded or disconnected is permanently lost from the live UI — nothing reconciles on reconnect, refocus, or visibility change

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:219-230`, `components/providers/NotificationListener.tsx:73`, `components/providers/NotificationListener.tsx:100`, `components/providers/RoleContext.tsx:343-354`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The underlying gap is real — nothing re-reads on reconnect/refocus for the persistent bell and sidebar (RoleContext.tsx:343-354 only calls `supabase.auth.getSession()`, and the TOKEN_REFRESHED branch at :288-294 re-sets uid to the same value so the hook's deps never change) — but two words of the title are wrong. 'Permanently lost' is false: because every realtime callback runs a complete fetchAll rather than applying a delta, the FIRST event to arrive after the socket rejoins reconciles the entire feed, so the stale window ends at the next org ticket/notification event. 'Nothing reconciles on refocus or visibility change' is also false for /inbox, which polls loadInbox on focus, visibilitychange and a 60s timer. Downgrade to MEDIUM: bounded staleness on the badge surfaces, not permanent data loss.

**Mechanism.** `useTicketNotifications` fetches once (`void fetchAll();` line 219) and then relies entirely on push. Its `.subscribe()` (line 227) is called with NO status callback, so `CHANNEL_ERROR`, `TIMED_OUT` and `CLOSED` are invisible to the app. `postgres_changes` has no replay/backfill: when the phoenix socket drops (laptop sleep, wifi handoff, a proxy idle-timeout) and later rejoins, the rows that changed during the gap are never re-delivered. The effect's deps are `[roles, activeOrgId, uid, channelId]` — none of which change on navigation, because Sidebar/TopBar-bell/NotificationCenterProvider live in the persistent protected layout — so `fetchAll` never runs again for the life of the tab. There is no visibilitychange, no focus handler, and no polling fallback on this hook. Two differently-shaped searches confirm the absence: `grep -rn "visibilitychange|\"focus\"|'focus'"` across lib/app/components/hooks returns only app/(protected)/admin/storage/page.tsx, app/(protected)/inbox/page.tsx, components/providers/RoleContext.tsx and components/system/UpdatePill.tsx — never the hook or its consumers; and `grep -rn "subscribe((status|subscribe(async (status|CHANNEL_ERROR|TIMED_OUT"` returns no realtime status handling anywhere except lib/presence.ts:69 which handles only the `SUBSCRIBED` case. RoleContext DOES install a `visibilitychange` handler (line 354) but `handleVisibility` only calls `supabase.auth.getSession()` to check for a dead token — it refetches no data. The rows DO still exist in the `notifications` and `tickets` tables (nothing deletes them); they are simply invisible until a hard reload or a new tab.

**Failure scenario.** An engineer leaves the app open on a second monitor over lunch. The laptop sleeps; the websocket dies. While asleep, a drafting request is routed to them (tickets UPDATE) and a `checkout_conflict` notification row is inserted. They wake the laptop at 13:00. The socket rejoins silently, but no event is replayed and no refetch is triggered. The bell reads the same number it read at 11:45. The badge stays wrong until they hard-reload — which they have no reason to do, because the app looks alive. In a PSM/OSHA context this is exactly the 'I never got the alert' failure the owner is describing as 'the trail goes cold'.

**Evidence.**

```
void fetchAll();

    const channel = supabase
      .channel(`attention-${activeOrgId}-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `org_id=eq.${activeOrgId}` },
        () => { if (alive) void fetchAll(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` },
        () => { if (alive) void fetchAll(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [roles, activeOrgId, uid, channelId]);
```

> **Verifier correction.** Two overstatements. (1) NOT 'permanently lost until a hard reload': a client-side navigation to /dashboard mounts AttentionBody (widgets.tsx:666-669) and CommandDeckBody (widgets.tsx:1221-1223) — both in the default layout (lib/dashboard/config.ts:76,80) — and /inbox mounts a fresh instance at page.tsx:35-38; each runs fetchAll on mount. Only the three persistent instances (sidebar badge, header bell, notification center) stay stale for the tab's life. (2) 'never the hook or its consumers' is imprecise — app/(protected)/inbox/page.tsx:119-125 IS a consumer and does install focus + visibilitychange + a 60s interval, but they call `refresh({background:true})` → `loadInbox(...)`, the page's own snapshot, not the hook's state. Downgraded CRITICAL→HIGH: rows are durable, and several in-app paths do reconcile on mount.

**Done when.**

- [ ] `.subscribe((status) => ...)` in useTicketNotifications re-runs `fetchAll()` on every transition into `SUBSCRIBED` after the first, so a rejoin always reconciles
- [ ] a `visibilitychange` + `window.focus` listener triggers a background `fetchAll()` when the tab becomes visible (the pattern already written at app/(protected)/inbox/page.tsx:118-127)
- [ ] a low-frequency safety-net interval (e.g. 60s while `document.visibilityState === 'visible'`) refetches, cleared on unmount
- [ ] `CHANNEL_ERROR` / `TIMED_OUT` set a visible 'reconnecting — counts may be stale' state rather than failing silently

---

<a id="rt-2"></a>

## RT-2 · NotificationListener toasts every checkout message in the entire workspace to every signed-in member, and fires a second toast for the same event from the notifications channel

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/NotificationListener.tsx:38-73`, `components/providers/NotificationListener.tsx:80-100`, `lib/activityThread.ts:153-164`, `supabase/migrations/20260727_checkout_activity_fix.sql:26-30`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both counts: any active org member receives (and is toasted for) every checkout message in the workspace, and thread participants/watchers additionally get a second toast from the notifications channel for the same post. One arithmetic correction to the scenario: line 62-63 (`isMe`) suppresses the author's own message, so each of the two draftsmen gets ~12 toasts (6 incoming x 2 channels), not 24; the org's other 38 members get 12 each from the checkout-messages leg.

**Mechanism.** Channel one subscribes to INSERTs on `checkout_messages` filtered ONLY by `org_id` (line 46). There is no filter on 'documents I am involved with'. The RLS SELECT policy for that table (20260727_checkout_activity_fix.sql:27-30) grants read to any active `org_members` row, so realtime delivers the change to every member's socket and the handler toasts it (lines 65-70) unless the actor is the viewer. Independently, `postCheckoutMessage` also fans a `notifications` row out to participants/subscribers via `notifyMany` with `kind: "checkout_message"` (lib/activityThread.ts:153-164). Channel two (line 80-100) subscribes to INSERTs on `notifications` filtered by `user_id=eq.${uid}` and toasts THAT row too. A participant therefore receives two toasts for one message: 'New Message from <name>' with the raw text, and '<name> posted to <doc>' with a 137-char snippet. The two `Set`s that guard duplicates (`processedIds` line 12, `seenNotifIds` line 79) are per-channel and cannot see each other, so they cannot suppress the cross-channel duplicate.

**Failure scenario.** Two draftsmen hold a working conversation in the activity thread of one P&ID — twelve messages over ten minutes. Every one of the plant's 40 signed-in members gets 12 toast pop-ups about a document they have never opened, and the two people actually on the thread get 24 (12 from `checkout-messages-*`, 12 more from `notifs-listener-*`). The corner dock fills with duplicated cards; the one toast that mattered — a `checkout_conflict` — is indistinguishable in the pile.

**Evidence.**

```
.channel(`checkout-messages-${activeOrgId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "checkout_messages",
          filter: `org_id=eq.${activeOrgId}`,
        },
```

**Done when.**

- [ ] the `checkout_messages` toast channel is removed entirely, or narrowed to documents the viewer has a live session/intent/subscription on — the org-wide filter is deleted
- [ ] a single event produces at most one toast: either the raw-table channel or the `notifications` channel owns the toast, never both
- [ ] a regression test asserts that posting one checkout message produces exactly one toast for a participant and zero for an uninvolved member

---

<a id="rt-3"></a>

## RT-3 · Three-to-six concurrent copies of useTicketNotifications each open their own channel and each run a full 500-ticket refetch on every ticket change in the org

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:141`, `hooks/useTicketNotifications.ts:151-217`, `hooks/useTicketNotifications.ts:221-227`, `components/notifications/NotificationCenter.tsx:42`, `components/notifications/NotificationCenter.tsx:55`, `components/navigation/Sidebar.tsx:124`, `components/navigation/TopBar.tsx:230`, `components/dashboard/widgets.tsx:669`, `components/dashboard/widgets.tsx:1223`, `app/(protected)/inbox/page.tsx:38`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Claim is accurate as stated. I looked specifically for a shared channel, a memoized/deduped fetch, or a debounce and found none — useId() deliberately makes the channels distinct, and each org-wide tickets event fans out to every mounted instance's unthrottled fetchAll.

**Mechanism.** The hook deliberately gives each instance a unique channel name via `useId()` (line 141, comment: 'so multiple consumers (sidebar/bell/inbox) don't collide on the same realtime channel name'). That avoids a name collision but institutionalises N independent subscriptions and N independent fetches. On every protected page at least three instances are mounted: `NotificationCenterProvider` renders `<CenterPanel>` unconditionally at NotificationCenter.tsx:42 (it is NOT gated on `isOpen`) and CenterPanel calls the hook at line 55; `Sidebar` calls it at line 124; `TopBar` renders `<NotificationBell variant="header" />` at line 230 which calls it at NotificationBell.tsx:54. On the dashboard, `AttentionBody` (widgets.tsx:669) and `CommandDeckBody` (widgets.tsx:1223) add two more; `/inbox` adds a sixth. Each instance subscribes to `event: '*'` on `tickets` filtered only by `org_id` — i.e. every ticket change made by anyone in the workspace — and each handler calls the same unbounded, un-debounced `fetchAll()`, which issues `supabase.from('tickets').select('*')` for up to `OPEN_TICKET_CAP = 500` rows (line 31/156). `select('*')` pulls the full row including the `comments`, `history` and `attachments` JSONB columns (mapped at lines 53-56).

**Failure scenario.** A supervisor bulk-advances 20 drafting requests. Each UPDATE is one realtime event. With the three always-mounted instances that is 60 invocations of `fetchAll`, each pulling up to 500 full ticket rows with their embedded comment and history JSON, plus 60 `listMyNotifications` queries and 60 stale-alert reconcile queries — from a single user's browser tab, in a few seconds. On the dashboard route it is 120. The tab stalls, Supabase rate-limits, and the badge the user is watching updates last.

**Evidence.**

```
// Unique per hook instance so multiple consumers (sidebar/bell/inbox) don't
  // collide on the same realtime channel name.
  const channelId = useId().replace(/[^a-z0-9]/gi, '');
```

> **Verifier correction.** The count is off at the top end. Three instances are always mounted (sidebar, header bell, notification center). On the default /dashboard that becomes FIVE (+AttentionBody, +CommandDeckBody). On /inbox it is FOUR (dashboard widgets are unmounted there). Six requires a user who has added a second `attention` widget. So 'three-to-five', not 'three-to-six'.

**Done when.**

- [ ] exactly one subscription and one fetch exist per tab — the hook's state is hoisted into a provider (or a module-level store) and the sidebar/bell/center/inbox all read the same snapshot
- [ ] `fetchAll` is debounced (e.g. 300-600ms trailing, the pattern already used at components/projects/ScheduleTab.tsx:112-115) so a burst of ticket updates collapses into one refetch
- [ ] the ticket refetch stops using `select('*')` and selects only the columns the attention rule reads (`id, ticket_id, title, status, requester_id, assigned_drafter_id, assigned_engineer_id, unread_by, last_modified, created_at`)

---

<a id="rt-4"></a>

## RT-4 · DELETE events cannot match any of the app's realtime filters except on `collections`, because only three tables have REPLICA IDENTITY FULL — the team fixed this once and never generalised it

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260727_checkout_activity_fix.sql:58-60`, `supabase/migrations/20260729_checkout_episodes.sql:102`, `lib/libraryCollections.ts:419-427`, `app/(protected)/documents/[libraryId]/page.tsx:1532-1535`, `app/(protected)/requests/page.tsx:315-318`, `hooks/useTicketNotifications.ts:223-224`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the fix was applied once (collections) and never generalised, and a hard-delete path for documents genuinely exists. Small overstatement worth noting: a filter keyed on the PK itself (e.g. `id=eq.`) would still match a DELETE under REPLICA IDENTITY DEFAULT — but the app's only such filters are UPDATE-only (requests/[id]/page.tsx:937, documents/[libraryId]/page.tsx:1491) or on an unpublished table (tableViews.ts:261), so the practical claim holds.

**Mechanism.** Only `checkout_messages`, `notifications` (20260727:59-60) and `checkout_episodes` (20260729:102) are set to `REPLICA IDENTITY FULL`. Every other published table keeps the default (primary key only), so a DELETE's old record carries nothing but the PK and cannot satisfy a filter on `org_id`, `library_id`, `document_id` or `project_id`. The codebase already knows this — lib/libraryCollections.ts:419-426 carries an explicit comment ('DELETE events carry ONLY the old row's primary key — never library_id — so the filtered listener above can not match them and a deleted folder sat on screen until reload') and adds an unfiltered DELETE listener as a workaround. That workaround exists for `collections` and nowhere else. `documents` (page.tsx:1533, filter `library_id=eq.`), `tickets` (requests/page.tsx:316 and useTicketNotifications.ts:223, filter `org_id=eq.`) and `checkout_sessions` (four separate sites, filter `document_id=eq.`) all use `event: '*'` and will silently never receive their DELETEs.

**Failure scenario.** A document is hard-deleted from a library while another controller has that library open. The `documents` DELETE is published, the filter `library_id=eq.<id>` cannot be evaluated against a PK-only old record, no event is delivered, and the deleted row stays on screen and in the sort/filter set until a manual reload — the exact bug that was diagnosed and fixed for folders and left in place for documents.

**Evidence.**

```
// DELETE events carry ONLY the old row's primary key — never
      // library_id — so the filtered listener above can not match them and
      // a deleted folder sat on screen until reload. Deletes are rare;
      // refetching this library's list on ANY collections delete is cheap
      // and keeps every viewer's tree honest, not just the deleter's.
      { event: "DELETE", schema: "public", table: TABLE },
```

**Done when.**

- [ ] a migration sets `REPLICA IDENTITY FULL` on every table that has a filtered `event: '*'` or `event: 'DELETE'` subscription (`tickets`, `documents`, `checkout_sessions`, `libraries`, `collections`), or
- [ ] each such subscription gains the unfiltered-DELETE companion listener already modelled at lib/libraryCollections.ts:419-426, or
- [ ] the app documents that deletes are soft-deletes only (the `deleted_at` filter at lib/libraryCollections.ts:405 suggests this is the intended direction) and the DELETE listeners are removed as dead code

---

<a id="rt-5"></a>

## RT-5 · NotificationListener drops any checkout message that arrives during its async seed, and its dedupe Set grows without bound for the life of the tab

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/NotificationListener.tsx:11-12`, `components/providers/NotificationListener.tsx:17-36`, `components/providers/NotificationListener.tsx:48-59`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Both mechanics are real, but the impact is much smaller than MEDIUM implies. (a) The seed exists to suppress backfill that Postgres CDC never sends — INSERT events are live-only — so it drops toasts without buying anything. (b) The specific scenario in the summary is self-mitigating: a handoff note also writes a notifications row (activityThread.ts:153-164) which the SECOND channel (line 80-100) toasts with no seed guard, so a participant still gets the toast. (c) The 'unbounded' Set grows by one UUID string per org checkout message — a week of heavy use is kilobytes, not a leak worth MEDIUM.

**Mechanism.** `isFirstRun.current = true` is set synchronously (line 17), then `seed()` is kicked off as an unawaited async call (line 36) which sets it false only after a network round-trip (line 33). `.subscribe()` is called immediately after (line 73). The handler's first statement is `if (isFirstRun.current) return;` (line 49), so any INSERT delivered between socket-join and seed-completion is discarded without being added to `processedIds` — it is neither toasted nor remembered. Separately, `processedIds` (line 12) is a `useRef<Set<string>>` that is only ever added to (lines 30, 59) and never pruned or reset; on a long-lived tab in a busy workspace with an org-wide subscription it accumulates one string per checkout message in the workspace, indefinitely.

**Failure scenario.** A user navigates into the protected shell at the moment a colleague posts a handoff note. The socket joins in ~200ms, the seed query takes ~400ms, and the message lands in that window — the toast is suppressed as if it were backfill. Separately, a control-room browser left open for a week accumulates every checkout message id in the workspace in memory.

**Evidence.**

```
const isFirstRun = useRef(true);
  const processedIds = useRef<Set<string>>(new Set());
```

> **Verifier correction.** Both consequences are narrower than stated. A message dropped in the seed window is not lost to the recipient: lib/activityThread.ts:153-165 writes a durable `notifications` row for participants/session-holders/subscribers, and the SECOND channel (lines 80-100) has no first-run guard, so an involved user still gets a toast plus a persistent bell row. The drop therefore only silences the org-wide toast for uninvolved members — the very toast finding 3 argues should not fire at all. The Set holds one UUID string per org checkout message; it is a slow leak, not a practical memory hazard.

**Done when.**

- [ ] the seed completes before `.subscribe()` is called (await it), or events arriving during the seed are buffered and replayed against `processedIds` once the seed resolves, rather than dropped
- [ ] `processedIds` is bounded — a fixed-size LRU or a periodic prune — so a long-lived tab's memory does not grow with workspace traffic

---

<a id="rt-6"></a>

## RT-6 · Roughly half of all notification kinds map to sidebar sections that no nav item renders — the bell counts them, nothing badges them, and the trail never starts

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:71-103`, `hooks/useTicketNotifications.ts:100-102`, `hooks/useTicketNotifications.ts:284`, `components/navigation/Sidebar.tsx:229`, `components/navigation/Sidebar.tsx:231`, `components/navigation/Sidebar.tsx:235`, `lib/inAppNotifications.ts:10-58`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Accurate, and if anything understated: 32 of ~52 kinds land in 'other' and 3 more in the unrendered 'scratchpad', so roughly two-thirds — not half — of kinds inflate the bell while badging nothing in the rail. ack_requested, every review_*/ack_* kind, library_doc_added/revised and effective_now are all in that unbadged set.

**Mechanism.** `sectionForKind` (line 71) has an explicit `default: return 'other';` (line 101). `lib/inAppNotifications.ts` declares 50+ `NotificationKind` values; `sectionForKind`'s switch names only 24 of them. Everything else — `ack_requested`, `ack_overdue`, `ack_unsatisfiable`, `review_requested`, `review_signed`, `review_invalidated`, `review_complete`, `review_overdue`, `review_due`, `effective_now`, `retention_eligible`, `legal_hold_placed`, `legal_hold_released`, `access_recert_due`, `owner_assigned`, `owner_behind`, `deletion_requested`, `library_doc_added`, `library_doc_revised`, `revision_published_over_checkout`, `project_comment`, `orchestrator_message`, `security_export`, `task_reminder` — lands in `'other'`. Sidebar consumes `sectionCounts` at only three call sites: `documents` (line 229), `projects` (line 231) and `requests` (line 235). Two searches confirm nothing else reads the rest: `grep -rn "sectionCounts"` across the repo returns only Sidebar's four lines and the hook's own five; a second, differently-shaped search for `.scratchpad` / `['scratchpad']` / `"scratchpad"` returns ZERO hits outside the hook itself — the scratchpad surface was removed but its section bucket was left behind. So `sectionCounts.other` and `sectionCounts.scratchpad` are computed on every render and thrown away. Note `revision_published_over_checkout` and `project_comment` fall to `'other'` even though `documents` and `projects` sections exist for them.

**Failure scenario.** A controlled P&ID is issued and `ack_requested` rows are written to fourteen operators (lib/acknowledgments.ts:375). Each operator's bell count goes up by one and a 6-second toast appears. The toast expires. Nothing in the sidebar changes — Documents, Projects and Drafting Requests all still read zero, because `ack_requested` tallies into `other`. The operator remembers 'something popped up' and has no badge to follow. This is the owner's complaint #1, and it is worse than described: for these kinds the trail does not go cold partway down, it never lights up at all.

**Evidence.**

```
default:
      return 'other';
  }
}
```

> **Verifier correction.** Three inaccuracies, none fatal. (1) lib/inAppNotifications.ts:10-58 declares 48 kinds, not '50+', and the switch names 22 real kinds plus the 'ticket' pseudo-kind — not 24. (2) The claim that a search for scratchpad 'returns ZERO hits outside the hook itself' is false: components/navigation/TopBar.tsx:34 has `scratchpad: "Scratchpad"` and app/(protected)/scratchpad/page.tsx still exists as a redirect stub to /inbox. The narrow true claim is that nothing reads `sectionCounts.scratchpad`. (3) 'the trail never starts' overstates the user impact — those items ARE rendered with working deep links in the bell dropdown (NotificationBell.tsx:164-188) and the notification center (NotificationCenter.tsx:136-144). Only the sidebar badge chain is missing, so MEDIUM rather than HIGH.

**Done when.**

- [ ] every kind in `NotificationKind` maps to a section that some surface actually renders — either by extending the switch or by making the default provably unreachable with an exhaustive `never` check at compile time
- [ ] the `'scratchpad'` section is deleted (its surface no longer exists) or a nav destination is restored for it
- [ ] `sectionCounts.other` is either rendered somewhere (e.g. on the bell or an 'Everything else' nav row) or the type no longer permits producing an unrendered bucket
- [ ] a test asserts: for each `NotificationKind`, `sectionForKind(kind)` returns a section that Sidebar badges

---

<a id="rt-7"></a>

## RT-7 · The OS-level notification path is fully built on the service-worker side and completely unwired on the client side — no subscribe, no VAPID key, no sender

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:222-238`, `public/sw.js:240-256`, `supabase/migrations/20260804_push_subscriptions.sql`, `lib/schemaExpectations.ts:99`, `components/pwa/ServiceWorkerManager.tsx:30-50`, `app/layout.tsx:93`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide absence search. The SW handler and the push_subscriptions table exist; there is no subscribe call, no VAPID key, and no sender, so no push can ever be delivered.

**Mechanism.** `public/sw.js` has a complete `push` listener that calls `self.registration.showNotification(...)` (line 238) and a `notificationclick` handler that focuses or opens the target URL (lines 240-256). Its comment claims 'Shows the OS notification the reminder cron sends (fires whether the app is open or closed)'. The `push_subscriptions` table exists (migration 20260804, registered in lib/schemaExpectations.ts:99). But nothing ever creates a subscription. Two differently-shaped searches confirm it: `grep -rn "pushManager|requestPermission|new Notification\(|Notification\.permission"` across all .ts/.tsx/.js outside node_modules returns ZERO hits; a second search for `sendNotification|webpush|push_sub|'push'|"push"` across lib/ and app/api/ returns only lib/schemaExpectations.ts:99, lib/exportTables.ts:167 and lib/dataRestore.ts:92 — three pieces of bookkeeping metadata, no producer and no consumer. `package.json` lists no `web-push` dependency and no VAPID key appears anywhere. `ServiceWorkerManager` (mounted at app/layout.tsx:93) registers the worker and handles offline/update pills, but never touches `reg.pushManager`. Related: the `task_reminder` kind is declared at lib/inAppNotifications.ts:36 and has no producer either — grep for `task_reminder` returns only that declaration line.

**Failure scenario.** The owner's complaint #2 — 'the app needs real OS-level notification presence' — is one client-side wiring step and one server-side sender away, not a from-scratch build. But as shipped, a user who grants the site notification permission in browser settings will still never receive a push, because the browser has no subscription to deliver to, and the app never asks.

**Evidence.**

```
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || "Manufacturing OS";
```

**Done when.**

- [ ] a VAPID keypair exists in env (public key exposed as NEXT_PUBLIC_, private key server-only) and is documented in .env.example alongside the existing entries
- [ ] a client surface calls `Notification.requestPermission()` at a deliberate moment (not on load) and on grant calls `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, persisting the result to `push_subscriptions` keyed by user + endpoint
- [ ] a server sender (in the existing maintenance cron, or alongside `emit()`'s inapp branch) posts to the stored endpoints, with 404/410 responses pruning dead subscriptions
- [ ] either `task_reminder` gains a producer or the kind is deleted from the union

---

<a id="rt-8"></a>

## RT-8 · The attention hook WRITES to the notifications table inside its own fetch, and that write is echoed back through the same channel it is subscribed to — with N instances racing to issue the identical write

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:188-210`, `hooks/useTicketNotifications.ts:225-226`, `lib/inAppNotifications.ts:193-196`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The write-inside-the-subscribed-read and the N-way race are real, but this is bounded, not a feedback loop: listMyNotifications is called with `onlyUnread: true` (:176) and applies `q.is("read_at", null)` (inAppNotifications.ts:170), so the rows just marked read cannot come back on the echo pass, workflowRows is empty, and no second write is issued. The concurrent writes are also idempotent (same UPDATE, same rows). Net effect is one extra round of fetches per instance — a sub-case of RT-3's amplification rather than a MEDIUM defect of its own.

**Mechanism.** Inside `fetchAll`, stale workflow alerts are detected and `await markManyRead(staleIds)` is called (line 207), which issues an UPDATE on `notifications` (lib/inAppNotifications.ts:195). The very same effect subscribes to `event: '*'` on `notifications` filtered by `user_id=eq.${uid}` (line 225), so that UPDATE is published back to every instance's socket and re-invokes `fetchAll` in all of them. The loop does terminate — the second pass re-queries with `onlyUnread: true`, the rows are now read, `workflowRows` is empty, no further write — but the amplification is real: with the three always-mounted instances all detecting the same stale IDs concurrently (there is no coordination between them), up to three identical `markManyRead` calls fire, each producing its own realtime broadcast, each triggering three more `fetchAll` passes. Compounding this, opening a ticket at app/(protected)/requests/[id]/page.tsx:919-931 performs two writes — a `tickets.unread_by` UPDATE and a `notifications.read_at` UPDATE — each of which is picked up by both legs of every attention channel.

**Failure scenario.** A user clicks a request in the bell. Opening it writes `unread_by` and `read_at`. Those two UPDATEs fan out to the three mounted attention channels via both the tickets leg and the notifications leg, producing roughly six `fetchAll` passes, each pulling up to 500 full ticket rows. If any of those passes also finds stale workflow alerts, three more writes go out and the cycle repeats once more. A single click becomes a dozen 500-row queries.

**Evidence.**

```
if (staleIds.length > 0) {
            const staleSet = new Set(staleIds);
            await markManyRead(staleIds).catch(() => { /* best-effort cleanup */ });
            n = n.filter((r) => !staleSet.has(r.id));
          }
```

**Done when.**

- [ ] the stale-alert reconcile runs in exactly one place per tab (a consequence of collapsing to a single hook instance), not once per mounted consumer
- [ ] writes made by the reconcile pass are self-suppressed — e.g. record the ids just written and ignore the echoed realtime event for them, the pattern already used for `processedIds` in NotificationListener.tsx:58-59
- [ ] the reconcile is separated from the read path so a fetch is never also a write

---

<a id="rt-9"></a>

## RT-9 · The badge number conflates 'work assigned to you' with 'unread notifications', so Mark-all-read cannot clear it and the vocabulary has no fixed point

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:308-324`, `hooks/useTicketNotifications.ts:252-274`, `components/notifications/NotificationBell.tsx:54-57`, `components/notifications/NotificationBell.tsx:85-87`, `components/notifications/NotificationBell.tsx:137-143`, `lib/inAppNotifications.ts:201-205`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct — Mark-all-read provably cannot drive the badge to zero while an action-required ticket exists. But the 'vocabulary has no fixed point' half is weaker than stated: every label around the number already says attention, not unread (NotificationBell.tsx:104 `${unread} need${...} attention`, :137 same, :139 'All caught up'), and the Mark-all-read button is gated on `hasNotifRows` (:87) so it disappears once the notification rows are cleared. This is a documented design union (hook header comment :12-26), not a miscount — LOW.

**Mechanism.** `count` is `items.length` (line 311), where `items` is the union of action-required tickets, tickets with unread activity, and unread notification rows (lines 252-302). The bell renders `const unread = count;` (NotificationBell.tsx:57) and labels it '<n> need attention'. But `markAllRead` (line 323) delegates to `lib/inAppNotifications.ts:201-205`, which only sets `read_at` on `notifications` rows — it cannot touch the ticket-derived half of the count, because those items are live derivations of ticket state, not read-state rows. The bell partially acknowledges this (`hasNotifRows`, line 87, hides the button when there are no notification rows) but the count itself does not distinguish. The hook also exports `actionRequiredCount` and `unreadCount` as separate numbers (line 312-313) yet the bell displays neither.

**Failure scenario.** A drafter's bell reads 7. Six are notification rows, one is a request sitting in DRAFTING assigned to them. They click 'Mark all read'. The `notifications` UPDATE fires, the realtime echo triggers refetches, and the badge settles on 1 — a number they cannot clear by any action in the notification UI, because the only way to clear it is to finish the drafting work. This is the owner's complaint #4: 'alert' (something you must do) and 'notification' (something you should know) are one number with one verb that only works on half of it.

**Evidence.**

```
/** The single count every surface badges (the header bell + Home). */
    count: items.length,
    actionRequiredCount,
    unreadCount,
    totalNotifications: items.length,
```

> **Verifier correction.** Minor quote drift: the '<n> need attention' string is the SIDEBAR variant (NotificationBell.tsx:116). The header variant the app actually mounts uses `${unread} need${unread === 1 ? "s" : ""} attention` at lines 101 and 134.

**Done when.**

- [ ] the bell renders two visually distinct counts (or one count plus an 'N need action' sub-line) using the `actionRequiredCount` / `unreadCount` the hook already exports
- [ ] 'Mark all read' is labelled and scoped so it is obvious it clears notifications and not assigned work, and the residual action-required count is explained in place rather than left as an unclearable number
- [ ] one written definition of alert vs notification exists and the bell, sidebar, inbox and center all use the same two words for the same two things

---

<a id="rt-10"></a>

## RT-10 · There is no user preference that can turn off in-app toasts or bell rows — /settings/notifications governs email only

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/settings/notifications/page.tsx:1-9`, `app/(protected)/settings/notifications/page.tsx:23-41`, `lib/notify/dispatch.ts:87-102`, `lib/notify/dispatch.ts:104-106`, `components/providers/NotificationListener.tsx:92-97`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The absence is real and I confirmed it repo-wide — no in-app or toast preference column, and the inapp dispatch leg is unguarded. Correcting severity because this is an explicitly documented product decision rather than a defect; its actual pain comes from RT-2 (org-wide toast fan-out), where the fix belongs.

**Mechanism.** The entire `Prefs` interface (page.tsx:23-30) is email-only: `email_enabled`, `email_on_mention`, `email_on_assignment`, `email_on_status_change`, `email_on_watched_activity`, `email_on_sla_warning`, `digest_frequency`. The page's own header comment states the policy: 'In-app bell notifications are always on'. `emit()` reflects that — the `inapp` branch (dispatch.ts:87-102) calls `notifyMany` with no preference lookup at all, while the comment on the email branch (line 104-105) notes 'queueEmail already checks notification_preferences'. `NotificationListener` then toasts every one of those rows unconditionally (lines 92-97). Combined with the org-wide checkout-message firehose (see the NotificationListener finding), a user being toasted about documents they have no involvement with has no available remedy short of closing the tab.

**Failure scenario.** A plant manager who is a follower on eight libraries and a member of every project is toasted continuously all day. They open Settings → Notifications looking for the off switch, find six toggles that all say 'email', turn them all off, and the toasts keep coming. The rational next step is to stop using the app's live surface entirely — which defeats every other notification feature.

**Evidence.**

```
// Backed by the notification_preferences table. Users can toggle email
// for each category independently (mentions, assignments, status
// changes, watcher activity, SLA warnings) and pick a digest frequency.
// In-app bell notifications are always on — they're the persistent
// inbox; the email side is the opt-in noise layer.
```

**Done when.**

- [ ] `notification_preferences` gains in-app/toast columns (at minimum a master `toast_enabled` plus per-category toggles mirroring the email set), added by a checked-in migration
- [ ] `NotificationListener` reads those preferences before calling `showToast`, and re-reads them when they change
- [ ] the settings page renders the in-app column alongside the email column so the copy 'always on' is either true and stated, or false and configurable — not silently contradicted

---

<a id="rt-11"></a>

## RT-11 · Toasts are an unbounded, uncapped stack in a fixed corner with no max-height — a realtime burst pushes cards off the top of the viewport

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/ToastProvider.tsx:40-49`, `components/providers/ToastProvider.tsx:57-59`, `components/ui/CornerDock.tsx:22-27`, `lib/postPublish.ts:36-60`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. Bottom-anchored with no height bound means the stack grows upward past the viewport top with no way to scroll to it, and a user who is both an intent-holder and a library follower does receive 2 notification rows per document in a bulk rev-up.

**Mechanism.** `showToast` appends without a cap (`setToasts((prev) => [...prev, {...}])`, line 42) and without deduping by title/kind. The dock is `fixed bottom-4 right-4 ... flex flex-col items-end gap-2` with `max-w-[calc(100vw-2rem)]` but NO `max-height` and NO `overflow` (CornerDock.tsx:25); the inner toast list is likewise `flex flex-col gap-2` with no cap (ToastProvider.tsx:58). Each card is `w-80` with `p-4`. Bursts are easy to produce: `notifySupersede` (lib/postPublish.ts) fires TWO `emit()` calls per rev-up — `doc_superseded` to everyone with a live intent plus `library_doc_revised` to every library follower — so a user who is both gets two notification rows, two realtime INSERTs, two toasts, from one publish. A bulk rev-up or a bulk ack fan-out multiplies that by the batch size.

**Failure scenario.** Twelve documents are rev'd up in one bulk operation. A library subscriber who also holds intents receives ~24 `notifications` INSERTs in a few seconds. Twenty-four `w-80` cards stack upward in a fixed-position column with no scroll container; on a 1080p screen roughly the top eighteen render above the viewport and are unreachable and unreadable. They each expire on their own 6s timer regardless of whether they were ever visible. This is exactly the owner's complaint #5 — background/bulk messages must stack gracefully bottom-right — and today they do not stack gracefully, they overflow.

**Evidence.**

```
const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, type, title, message, duration }]);
```

> **Verifier correction.** 'Unbounded' describes the code but not the runtime steady state: `duration = 5000` is the default at ToastProvider.tsx:40 and a repo-wide grep for `duration: 0` returns zero hits, so every toast self-removes via the setTimeout at lines 44-48. Depth is therefore bounded by arrival rate over a ~5-6s window; overflowing a typical viewport needs roughly eight or more toasts inside that window (bulk rev-up / bulk ack fan-out), not a two-toast publish.

**Done when.**

- [ ] `showToast` caps the visible stack (e.g. keep the newest 3-4) and collapses the remainder into a single '+N more' card that opens the notification center
- [ ] identical (kind + resourceId) toasts arriving within a short window coalesce into one card with a count instead of stacking
- [ ] CornerDock gets a `max-h-[calc(100dvh-2rem)]` and `overflow-y-auto` so nothing can ever render above the viewport
- [ ] the auto-dismiss timer does not start until the card is actually within the visible stack

---

<a id="rt-12"></a>

## RT-12 · Two subscribed tables are not in the supabase_realtime publication — the milestone board and the shared table-view sync listen to a channel that can never fire

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `components/projects/ScheduleTab.tsx:106-120`, `lib/tableViews.ts:259-264`, `supabase/schema.sql:1139-1147`, `supabase/migrations/20260727_checkout_activity_fix.sql:50-54`, `supabase/migrations/20260729_checkout_episodes.sql:97-98`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by exhaustive search of every ALTER PUBLICATION in the repo; there is no CREATE PUBLICATION ... FOR ALL TABLES anywhere either, so both channels subscribe successfully and can never receive an event. ScheduleTab's 600ms debounce (:112-116) and its 'edits stream in' comment are dead code as shipped.

**Mechanism.** The repo's complete publication membership is nine tables: `tickets, documents, checkout_sessions, checkout_messages, checkout_episodes, notifications, collections, org_members, libraries` (schema.sql:1139-1147), plus idempotent re-adds of `checkout_messages`/`notifications` (20260727) and `checkout_episodes` (20260729). `ScheduleTab.tsx:110` subscribes to `table: "milestones"` and `lib/tableViews.ts:261` subscribes to `table: TABLE` where `TABLE = "table_views"` (lib/tableViews.ts:7). Neither table appears in any `ALTER PUBLICATION` statement. I ran three differently-shaped searches: `grep -rn "ADD TABLE <name>"` per table (no hits), a case-insensitive `grep -rni "<name>"` filtered to lines containing publication/realtime/replica (no hits), and an exhaustive `grep -rniE "publication" --include=*.sql` which produced the complete nine-table list above and nothing else. What the repo CANNOT tell me: whether someone added these two tables to the publication by hand in the Supabase dashboard. If they did, this is a documentation gap; if they did not, both features are silently dead.

**Failure scenario.** Two planners work the same project schedule. ScheduleTab's comment promises 'another planner's edits stream in (debounced) so two people can work the same schedule without silently overwriting each other's view' — but if `milestones` is not published, planner B never sees planner A's changes and both keep editing a stale board, which is precisely the silent-overwrite the comment claims to prevent. Likewise an admin resizes/reorders columns via `table_views` and other viewers never see it.

**Evidence.**

```
const channel = supabase
      .channel(`milestones-${projectId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "milestones", filter: `project_id=eq.${projectId}` },
```

> **Verifier correction.** 'Both features are silently dead' is too strong. Both call sites load their data before subscribing — ScheduleTab.tsx:100 runs `void refresh()` in its own effect, and lib/tableViews.ts:257 calls `fetch()` before the channel is created — and both refetch after the local user's own mutations. What is dead is only cross-client live sync: another planner's milestone edit, or another tab's saved table view, will not stream in.

**Done when.**

- [ ] `SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime'` is run against production and its output is compared against every `table:` string passed to `.on('postgres_changes', ...)` in the repo
- [ ] any missing table is added by a checked-in migration using the idempotent `IF NOT EXISTS (SELECT 1 FROM pg_publication_tables ...)` pattern already at 20260727_checkout_activity_fix.sql:50-54
- [ ] a test (or the existing lib/schemaExpectations.ts tripwire) asserts that every realtime-subscribed table name in the codebase has a corresponding publication statement in supabase/

---
