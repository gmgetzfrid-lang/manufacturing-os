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
- **Status:** RESOLVED
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

**Resolution (2026-10-02, notifications Round G).** Package N3 SURFACES; the plan's default (`DEC-44 (N3)` item 2): **remove** the channel. **Reproduced first** on `7c27b0c`, driving the base listener with the real `postActivity` against an in-memory realtime bus (`lib/__tests__/notificationListener.test.ts`'s double): one post by Alice in a thread with a participant (Pat) and a watcher (Wes), and an uninvolved member (Una) signed in — Pat got two toasts ("warning | New Message from Alice" and "info | Alice posted to P-1204-03"), Wes two, Una one. The base listener subscribed to `checkout_messages` filtered only `org_id=eq.<org>` (`components/providers/NotificationListener.tsx:38-73`) besides its `notifications` channel (`:80-100`).

What landed (`components/providers/NotificationListener.tsx`): one channel — `notifications` INSERTs filtered `user_id=eq.<uid>` (:289). The `checkout_messages` channel, its first-run seed and its id set are gone. The post's durable row — `notifyCheckoutActivity`'s `checkout_message` (or `checkout_handoff` / `markup_request`) to each participant, session holder and watcher (`lib/activityThread.ts`) — is what toasts, once, to exactly those people. A system line in the thread toasts nobody: `postEpisodeSystemMessage` (`lib/checkoutEpisodes.ts:421`) writes no notification row, and `postActivity` skips the notify for kind `system` (`lib/activityThread.ts`). For the force release the holder's own `checkout_released` row toasts instead (TAX-3), and a revision published over a checkout notifies the holder (`lib/revisions.ts`); the other system lines have no targeted row (below).

Tests: `lib/__tests__/notificationListener.test.ts` — "TAX-4 dw4: postActivity → exactly one toast for each participant and watcher, zero for the author and for an uninvolved member" (the real `postActivity` → the real `notifyMany`; nothing subscribes to `checkout_messages`), "a system line in the thread (a forced release) toasts nobody…", "the listener's source subscribes to one table, filtered to the member…". Verified: loop on `fleet/N3-surfaces` at `bac49dc`: `npx tsc --noEmit` exit 0; `npx eslint` on the 16 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 406 files, 8496 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ The `checkout_messages` toast channel is removed entirely; the org-wide filter is deleted.
- ✓ A single event produces at most one toast: the `notifications` channel owns it.
- ✓ A regression test asserts that one checkout message produces exactly one toast for a participant (and for a watcher) and zero for an uninvolved member.

**Scope / residual.** Who receives the durable row (participants, session holders, watchers) is `notifyCheckoutActivity`'s, unchanged; whether a producer may address a row to someone who lost access is `NEDGE-6` (cross-noted there with `lib/activityThread.ts`). **What the removed channel also carried** (corrected at the N3 review fix, 2026-10-02 — the first record named only other people's posts and the force-release line): it was the only real-time signal for every system thread line — a check-in (checkout closed, kept open, a collaborator left), **the lock passing to an heir** (`${userName} checked in — lock passed to ${heir}`, `lib/checkoutEpisodes.ts:647-652`), a quick hold, a checkout started (`:1071`) and an auto-release or reconcile close. Those now toast nobody and write no bell row; the thread and the document's lock badge still show them. An heir who is on another page is not told the lock is now theirs: a targeted row to the heir on a lock handover is handed to notifications N9 DC-OWNED-PRODUCERS (`99-fix-sequencing.md`). No migration.

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
- **Status:** RESOLVED
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

**Resolution (2026-10-02, notifications Round G).** Package N3 SURFACES. **Reproduced** on `7c27b0c` by reading: `isFirstRun` set true (`components/providers/NotificationListener.tsx:17`), an unawaited `seed()` (`:20-36`) and the handler's `if (isFirstRun.current) return;` (`:49`) — an INSERT inside the seed window was dropped unremembered; `processedIds` (`:12`) only ever grew. Both belonged to the org-wide `checkout_messages` channel, which is **removed** (`RT-2`, `DEC-44 (N3)` item 2): the seed, `isFirstRun` and `processedIds` went with it. The one channel left (the member's own `notifications`, :289) has no seed — Postgres CDC sends no backfill, so there is nothing to suppress — and its duplicate guard is bounded: the newest `SEEN_IDS_MAX` (500, :82) row ids (`createNotificationToaster`, :137).

Tests: `lib/__tests__/notificationListener.test.ts` "the listener's source subscribes to one table … its seed and its id set are gone", "the remembered ids are bounded (RT-5 dw2)", "each row addressed to the member toasts once…; a duplicate delivery of the same row does not toast twice". Verified: loop on `fleet/N3-surfaces` at `bac49dc`: `npx tsc --noEmit` exit 0; `npx eslint` on the 16 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 406 files, 8496 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ No event is dropped during a seed: there is no seed (the channel it served is gone, and the remaining channel never had one).
- ✓ The dedupe set is bounded (the newest 500 ids).

**Scope / residual.** None. No migration.

---

<a id="rt-6"></a>

## RT-6 · Roughly half of all notification kinds map to sidebar sections that no nav item renders — the bell counts them, nothing badges them, and the trail never starts

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** the user (ratify `DEC-81` §3, as `OS-12`) — by the integrator, 2026-10-01 (N2 merge; fleet plan `userHeld`).
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

**Partial (2026-10-01, notifications Round G; status set back to OPEN by the N2 final review).** What holds: every `NotificationKind` maps — to a row the Sidebar badges, or to the explicit bell-only list — and a kind added without a `KIND_META` entry does not compile; and seven of the nine bell-only kinds (`orchestrator_message`, `security_export`, `member_revoked`, `library_unowned`, `storage_alert`, `storage_platform_r2`, `storage_platform_db`) are the fleet plan's default list. What does not hold yet: the bell-only arm rests on `DEC-81` §3, which the user has not ratified, and §3 places two kinds beyond the plan's default there (`ai_cap_changed`, `transmittal_unstampable`). The finding closes — record it RESOLVED — when the user ratifies §3, or when those two kinds are placed on a badged row.

**Reproduced first** on `b9cdfdc`: `lib/__tests__/notificationKinds.test.ts` was committed BEFORE any change (`e595cf5`) with the TODAY tables read from the source — `sectionForKind` returned `'other'` for 28 of the 50 union members (the audit's 26 plus `member_revoked` and `library_unowned`, added by R&P) and `'scratchpad'` for 3; `emptySectionCounts()` allocated five buckets; `components/navigation/Sidebar.tsx` badges three (`badgeOf(sectionCounts.documents|projects|requests)`); and the rendered hook, given one row of every kind written on `b9cdfdc`, tallied 33 rows into `other` and 3 into `scratchpad`, which no row reads. All seven assertions passed on the base, i.e. the defect reproduced as recorded.

**Fix (package N2 KIND-REGISTRY, commit `95dbe50`; review fix `42d5df8`; final-review fix `9950e29`, whose line numbers these are).** New `lib/notificationKinds.ts` `KIND_META` (:88) classifies every `NotificationKind` in one literal — `section`, `actionRequired`, `compliance`, `icon`, `tone`, `group` — with `as const satisfies Record<NotificationKind, KindMeta>` (:192), and each kind's section decision written next to it (:89 requests, :97 documents — the moved kinds under :116, :157 projects — `project_comment` at :161, :164 bell-only). `NOTIFICATION_SECTIONS` (:38) is exactly `requests | documents | projects`. `hooks/useTicketNotifications.ts` `sectionForKind` (:96) reads it, with a `never` guard over the registry's own keys (:102), so a kind added to the union without an entry fails `tsc` twice (here and at the `satisfies`); `emptySectionCounts` (:138) allocates one bucket per rendered section and no other. `'scratchpad'` and `'other'` are gone from `AttentionSection`; a kind with `section: null` is bell-only — counted by the header bell, listed by the Center and `/inbox`, counted by no rail row, which is exactly where `'other'` left it. A legacy row whose kind is in no union (a retired `task_nudge`) resolves to null at runtime. Decision recorded as `DEC-81` in `DECISIONS.md` (provisional number; the integrator renumbers).

**Where each kind went** (`DEC-81` §3; the plan's default): every kind that badged a row on `b9cdfdc` badges the same row; the document-scoped kinds that fell to `'other'` — `ack_requested`, `ack_complete`, `ack_overdue`, `ack_unsatisfiable`, `review_due`, `review_requested`, `review_signed`, `review_invalidated`, `review_complete`, `review_overdue`, `review_alternate_activated`, `library_doc_added`, `library_doc_revised`, `effective_now`, `owner_assigned`, `owner_behind`, `deletion_requested`, `retention_eligible`, `legal_hold_placed`, `legal_hold_released`, `access_recert_due`, `revision_published_over_checkout` — badge **Documents**; `project_comment` badges **Projects**; `orchestrator_message`, `security_export`, `member_revoked`, `library_unowned`, the three storage kinds, `ai_cap_changed` and `transmittal_unstampable` are bell-only, each with its reason in the registry. Nothing was mapped to Documents wholesale, and no emitted kind was deleted. For ratification with §3: `ai_cap_changed` and `transmittal_unstampable` are bell-only beyond the plan's default list (the census found them written outside the union); and `review_requested` is overloaded — besides a document's sign-off request, the contractor-intake path writes it for three notices that open a project: every contractor quote (`app/api/intake/upload/route.ts:899-906` `notifyTeam`, "Quote received: …", `resource_type` 'project', `/projects/<id>?tab=costs`), every intake submission awaiting review (`app/api/intake/upload/route.ts:1533-1544`, the same `notifyTeam`, "Intake submission awaiting review: …", a `/projects/<id>` link), and the folded digest when nothing was published (`lib/intakeRateLimit.ts` `foldedDigestKind`, `resource_type` 'project', a `/projects/<id>` link). So a project-scoped quote or intake notice now raises the **Documents** badge (none of the three badged a row on `b9cdfdc`, where `review_requested` fell to `'other'`). The overload is written next to the kind (`lib/notificationKinds.ts:132-144`); kinds of their own for these notices — for `notifyTeam`'s quote and submission notices and for the digest (e.g. `intake_quote` / `intake_submission`, section `projects`) — are the intake path's owner's (projects).

- Files: `lib/notificationKinds.ts` (new), `lib/inAppNotifications.ts` (the union), `hooks/useTicketNotifications.ts`.
- Tests: `lib/__tests__/notificationKinds.test.ts` — "sectionForKind and KIND_META agree with TODAY + the departures, kind by kind"; "every kind that badged a row on b9cdfdc badges the same row now"; "the sections are exactly the rows the Sidebar badges" (parses `Sidebar.tsx`); "'other' is gone: the bell-only kinds are exactly the deliberate list"; "GAP-201 acceptance 1: a kind added without a KIND_META entry fails the type check" (type-checks the hook in memory with a probe kind appended: the `never` guard and the `satisfies` both fail; clean without it); and the rendered hook over one row of every kind written on `b9cdfdc` — every row still renders (55 items, as before), requests 5 (unchanged), documents 12 → 34, projects 2 → 3, and `sectionCounts` has exactly the three rendered keys.
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's. After the final-review fix (`9950e29`, comments only, and the record commits after it): `npx tsc --noEmit` exit 0; `npx eslint . --max-warnings=0` exit 0; `npx vitest run lib/__tests__/notificationKinds.test.ts lib/__tests__/notificationKindStorageProducers.test.ts lib/__tests__/notificationKindThreadProducer.test.ts` exit 0 — 3 files, 43 passed; `npx vitest run` (full suite) exit 0 — 349 files, 7302 passed, 5 expected-fail; `node audit-reports/build-index.mjs` ✓ corpus integrity.

**Done-when.**
- ✓ Every kind maps to a section a surface renders, and the default is provably unreachable: the `never` guard at compile time (the type-check test proves it bites).
- ✓ `'scratchpad'` is deleted (its surface is a redirect stub); its three kinds left the union with it (`PROD-8`).
- ✓ The type no longer permits an unrendered bucket: `AttentionSection` is the three rendered rows, and `sectionCounts` has exactly those keys (rendered-hook test).
- **Partly — awaits ratification:** a test asserts, for each kind, that `sectionForKind` returns a section the Sidebar badges (parsed from `Sidebar.tsx`) — or null, for the explicit bell-only list. The bell-only arm is the plan's (the header bell owns the remainder); the list of nine awaits the user's ratification of `DEC-81` §3, including the two kinds beyond the plan's default (`ai_cap_changed`, `transmittal_unstampable`).

**Scope / residual.** Stays OPEN for done-when 4's bell-only arm until the user ratifies `DEC-81` §3 (or `ai_cap_changed` and `transmittal_unstampable` are placed on a badged row); then record RESOLVED. Nothing else remains in this finding.

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
- **Status:** RESOLVED
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

**Resolution (2026-10-02, notifications Round G).** Package N3 SURFACES. **Reproduced first** on `7c27b0c`: the bell rendered one number, `const unread = count` (`components/notifications/NotificationBell.tsx:62`), labelled "N need attention" (`:139`), beside a "Mark all read" (`:147`) that clears notification rows only (`lib/inAppNotifications.ts` `markAllRead`) — an action-required request in the feed left the badge at a number no button there could clear, and nothing said so.

What landed (`components/notifications/NotificationBell.tsx`):
- **Two counts, two words.** The drawer's header reads "8 need attention · 2 need action" (:149-152): the total (everything in the feed, the bell's badge) and `actionRequiredCount` (= `counts.action`, tickets and notifications alike — TRAIL-13).
- **The button says what it clears.** "Mark notifications read" (:167); its title counts the rows it marks and the requests it leaves ("… 1 request stays until …" / "… 2 requests stay until …" — the singular fixed at the N3 review fix, its test with it).
- **The residue is explained in place** (:185): "1 request in this list clears when the work is done or the request is opened — marking notifications read leaves it." — shown whenever the feed holds requests (`counts.all - counts.notifications`).
- **The same two words everywhere.** "Action" / "Activity" are the feed's filter chips on the Center, `/inbox` and the dashboard widget (`AttentionFeed`, TAX-7); the Command Deck's stat is "Action"; the sidebar badge is now named "Documents: 3 items need attention, some need action"; the bell says "need attention" / "need action"; the live region says the same. The written definition is the hook's VOCABULARY note (`hooks/useTicketNotifications.ts`, TAX-7 / DEC-81 §6: an action is something you must DO; activity is everything else; DB-unread and ticket-unread are named apart).

Tests: `lib/__tests__/notificationCenterScope.test.ts` "RT-9: 'N need action' beside the total; 'Mark notifications read'; what it leaves behind is said in place" (a feed of seven notification rows and one request an Admin must pick up: "8 need attention", "2 need action", the residue line, no "Mark all read"). Verified: loop on `fleet/N3-surfaces` at `bac49dc`: `npx tsc --noEmit` exit 0; `npx eslint` on the 16 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 406 files, 8496 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ The bell renders the total plus an "N need action" sub-count from the hook's `actionRequiredCount`.
- ✓ "Mark all read" is now "Mark notifications read", and what it cannot clear (requests, which clear when the work is done or the request is opened) is said in place.
- ✓ One written definition (the hook's VOCABULARY note, DEC-81 §6) and the same two words — "action" for what needs doing, "activity" / "attention" for the rest — on the bell, the sidebar badge's name, `/inbox` and the center.

**Scope / residual.** The header bell's badge still shows the total (it is the bell's count of everything in the feed); the red, action-only signal is the rail badge (TRAIL-5) and the "need action" line. No migration.

---

<a id="rt-10"></a>

## RT-10 · There is no user preference that can turn off in-app toasts or bell rows — /settings/notifications governs email only

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** notifications N3 SURFACES (the listener reads `toast_enabled` and flips `TOAST_PREFERENCE_HONOURED`; per-category toggles after N2's kind registry) — by the integrator, 2026-10-01 (N1 merge: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
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

**Partial (2026-10-01, notifications Round G).** Package N1 PREFS-GATE, commit `31b3eb7`; tripwire widened by the fix pass, commit `e07b919`. **Reproduced** on `cd8a93a`. `notification_preferences` had no toast column (`20260529` + `20260723` add only email toggles plus `inapp_enabled` / `push_enabled`), and a repo-wide search found no reader of `inapp_enabled`. The settings page's `Prefs` was email-only, and `NotificationListener` toasted every row.

**What landed:**
- **The column.** `20261148_notif_roundG_prefs_gate.sql` adds `notification_preferences.toast_enabled BOOLEAN NOT NULL DEFAULT TRUE`. Existing rows read TRUE, so nothing changes.
- **`inapp_enabled`.** It is marked `DEPRECATED` with `COMMENT ON COLUMN` and **kept, not dropped**. This is the integrator's override of the plan's default: a dropped column cannot be restored, and older backup envelopes carry it. Bell rows stay always on — a durable obligation is never suppressible (`DEC-74`).
- **The reader.** `lib/notificationPrefs.ts` `readToastPreference(uid)` (:178) is for the toast listener. It fails OPEN: no row, a column the database does not have yet, or any read error all mean "show toasts".
- **The page.** The settings page has an In-app card stating that bell notifications are always on. The "Pop-up toasts" switch row is built and renders once `TOAST_PREFERENCE_HONOURED` (`lib/notificationPrefs.ts:75`) is true. It saves `toast_enabled` and retries without it before the paste.
- **Why the switch is gated.** The flag is false today because the listener does not read the preference yet. A switch that saves and does nothing is the defect this page had (GAP-203). `lib/__tests__/notificationPrefs.test.ts` pins the flag to whether `components/providers/NotificationListener.tsx` mentions `readToastPreference` or `toast_enabled`. Whichever side changes first, the test fails until the other side does. *(Widened by the fix pass. N3 runs in parallel from a base without `lib/notificationPrefs.ts` and may read the column directly. A tripwire that looked only for `readToastPreference` would then have stayed green with the flag false, and the switch would never show.)* The hand-off is recorded in `99-fix-sequencing.md` Phase 2.

- Files: `supabase/migrations/20261148_notif_roundG_prefs_gate.sql`, `lib/notificationPrefs.ts`, `app/(protected)/settings/notifications/page.tsx`.
- Tests: `lib/__tests__/notificationPrefs.test.ts` "RT-10 — readToastPreference fails open" and "the toast switch is offered exactly when the listener honours it"; `lib/__tests__/notificationSettingsPage.test.ts` "RT-10 — the in-app card" (4 cases); `lib/__tests__/notifRoundGPrefsGateMigration.test.ts` "the columns".
- **Pending migration:** `supabase/migrations/20261148_notif_roundG_prefs_gate.sql` (DEC-30).

**Done-when.**
- ✓ (master switch) `toast_enabled` is added by a checked-in migration. **Not done: per-category toast toggles.** A category for a toast needs the kind → category mapping that the kind registry (N2, GAP-207 / TAX-5) is building. Adding a seventh hand-maintained classification here is what TAX-5 forbids.
- **Not done (N3):** `NotificationListener` does not yet read the preference before `showToast`, or re-read it when it changes. That file is N3's (TAX-9 dw1 / RT-10 consumer). N3 reads the preference, through `readToastPreference` (which fails open when the column is absent) or `toast_enabled` directly, and flips `TOAST_PREFERENCE_HONOURED` to `true` in `lib/notificationPrefs.ts`. The tripwire test fails until both are done.
- ✓ (copy) The settings page now states that bell rows are always on: "Bell notifications are always on — they are the record of what needs your attention, and nothing here turns them off". The page subtitle already said so, so the copy is true and stated. The configurable toast column renders with N3.

**Scope / residual.** RT-2's org-wide checkout-message toasts, which are the real source of the noise, belong to N3.

**Partial (2026-10-02, notifications Round G).** Package N3 SURFACES — the consumer half N1 handed over. **Reproduced** on `7c27b0c`: `components/providers/NotificationListener.tsx` toasted every row with no preference read (`:80-100`), and `TOAST_PREFERENCE_HONOURED` was `false` (`lib/notificationPrefs.ts:76`), so the settings page withheld the switch.

What landed:
- **The listener reads the switch before it toasts** (`createNotificationToaster`, `NotificationListener.tsx:137`, wired with `readPreference: () => readToastPreference(uid)` at :273): on mount, whenever the tab comes back (`visibilitychange` / `focus`), and again before any toast once the last read is older than `PREF_FRESH_MS` (5 s) — so a switch flipped on the settings page governs the next toast within seconds, in the same tab. `readToastPreference` fails open (no row, a database before 20261148, any read error → toasts show). *Second review fix (2026-10-02):* so does a read that never answers — it was fail-open on an error but not on a hang: one stalled `notification_preferences` read (supabase-js sets no request timeout) held every later toast in the tab, and a tab return re-awaited the same stalled promise. Now a read not answered within `PREF_READ_TIMEOUT_MS` (3 s, `readOnce` :165) resolves to the last value a read actually returned, or "on" when none has (*third review fix:* it resolved "on" outright, discarding a known "off"; a read that rejects is treated the same, and a refresh forgets only the cached value's freshness), a refresh (`refreshPreference` :247) always starts a new read, and a generation count keeps a late answer from overwriting a newer one. Off means no toast of any kind; the bell row, the badge and the Center are untouched (DEC-74 §7).
- **The flag is flipped** (`lib/notificationPrefs.ts:78`, `TOAST_PREFERENCE_HONOURED = true` — the one line N1 handed to N3), so the settings page offers "Pop-up toasts"; N1's tripwire (`lib/__tests__/notificationPrefs.test.ts` "the toast switch is offered exactly when the listener honours it") passes on its other side.

Tests: `lib/__tests__/notificationListener.test.ts` "toast_enabled off: no toast at all (the bell row is untouched — the row still landed)", "switched back on in settings: the next toast follows once the tab comes back", "a stale read is refreshed before the next toast (PREF_FRESH_MS); an unreadable re-read keeps the known value; with nothing known, an unreadable preference shows toasts", "the settings page offers the switch now that the listener reads it"; second review fix: "with nothing read yet, a read that never answers fails open after PREF_READ_TIMEOUT_MS…", "a refresh never re-awaits a stalled read, and a late answer from an older read never overwrites a newer one", "through the mounted listener: with every read stalled, a row still toasts once the timeout passes, and a tab return asks again…". Verified after the second review fix: `npx tsc --noEmit` exit 0; `npx eslint` on the 19 changed code and test files of the branch `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 407 files, 8516 passed, 7 expected-fail (an earlier full run under machine load timed out two unrelated fuzz tests at the 5 s default and one first-frame timing test of N7's; each passed alone and the rerun was clean). Verified: loop on `fleet/N3-surfaces` at `bac49dc`: `npx tsc --noEmit` exit 0; `npx eslint` on the 16 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 406 files, 8496 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- Partial, NOT met as written. ✓ the master `toast_enabled` (N1, 20261148). **Not done: per-category toast toggles mirroring the email set.** A toggle per category needs each kind's category, and the only home for that without a seventh classification (TAX-5, DEC-81 §1) is a column in `lib/notificationKinds.ts` `KIND_META` — notifications N5's file this round, read-only here — plus `toast_on_*` columns (a migration) and the settings rows. Not this package's to add.
- ✓ `NotificationListener` reads the preference before calling `showToast`, and re-reads it when it may have changed (tab return, and any read older than 5 s).
- ✓ The settings page renders the in-app column (N1's card, now with its "Pop-up toasts" switch live) beside the email column; "Bell notifications are always on" is true and stated.

**Scope / residual.** Stays OPEN for per-category toast toggles only: a `category` column on `KIND_META` (mirroring `email_on_*`: mention, assignment, status change, watched activity, SLA warning), `toast_on_*` columns by a checked-in migration, the settings rows, and the listener's per-kind read. Owner: unassigned — for the integrator (it needs `lib/notificationKinds.ts`, N5's this round). No migration here.

*Third review fix (2026-10-02, N3): a read that rejects or stalls kept nothing — `refreshPreference` cleared the cache and a read not answered within 3 s resolved "on" — so a member who switched pop-ups off got them back after any tab return on Wi-Fi with no route out. Now `createNotificationToaster` keeps the last value a read actually returned (`lastRead`, `NotificationListener.tsx:147`, written only by an answered read of the current generation), a rejected or stalled read resolves to it (`readOnce` :165), and fails open only when nothing has been read yet; a refresh forgets only the cached value's freshness. Tests: `lib/__tests__/notificationListener.test.ts` "a known 'off' survives a re-read that stalls: a tab return on Wi-Fi with no route out does not bring the pop-ups back" and "a stale read is refreshed before the next toast (PREF_FRESH_MS); an unreadable re-read keeps the known value; with nothing known, an unreadable preference shows toasts" (both fail with the fix reverted). Residual: `readToastPreference` (`lib/notificationPrefs.ts:181`, N1's file) folds a read error that answers into `true`, so a fast-failing read (an error rather than a stall) still reads as on — the toaster cannot tell it from a real "on". Handed to that file's holder (return `null` for "unknown", or throw, and let the caller keep the last value). Done-when 2 stays ✓. Verified after the third review fix: `npx tsc --noEmit` exit 0; `npx eslint` on the 19 changed code and test files of the branch `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 407 files, 8522 passed, 7 expected-fail. `next build` is the integrator's.*

---

<a id="rt-11"></a>

## RT-11 · Toasts are an unbounded, uncapped stack in a fixed corner with no max-height — a realtime burst pushes cards off the top of the viewport

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** notifications N3 SURFACES (done-when 1 — the doorway while the dock is raised; done-when 2 — `coalesceKey` from `NotificationListener.tsx`) — by the integrator, 2026-10-02, at the N7 merge (the hand-off in `99-fix-sequencing.md`; fleet plan `audit-reports/fleet-plans/notifications.json`).
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

**Partial (2026-10-01, notifications Round G).** Reproduced: Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase). A 24-toast burst plus 40 uploads put the base dock's top at −3,839px in an 800px viewport, with 86 cards entirely above it and no scrolling (see STACK-9). Now:
- **The cap.** `components/providers/ToastProvider.tsx` shows the newest toasts within the dock's shared cap of 4 (`useDockAllowance`, `visibleToasts`). The rest are counted in the dock's single "+N more" card, which expands the stack and, while messages are hidden and the dock is at rest, offers "Notifications" — it opens the notification center (the layout passes `useNotificationCenter().open` to `CornerDock`). While the dock is raised over a modal that started an upload (`STACK-10`), the toasts wait behind "+N more" with no doorway (N7 fourth review). The center opens at 240 / 241 (`components/notifications/NotificationCenter.tsx`), under that modal (300 and up), so the button would open a panel nobody can see.
- **Coalescing.** Identical toasts within `COALESCE_WINDOW_MS` (10 s) are one card with a "×N" count, moved to the newest place with its time restarted. The key is the toast's content (type, title, message) unless the producer passes the new optional `coalesceKey`, such as kind:resource_id.
- **Height.** The dock has `max-height: calc(100dvh − --dock-bottom)` and `overflow-y-auto`, so nothing can render above the viewport.
- **Timers.** A toast's timer runs only while its card is within the visible stack: it starts on entering, is cleared on leaving, and restarts for the full duration on re-entering. On a phone the folded summary pill stands for the stack: the cards it would show (the newest four) run their time, so a toast still expires there as it always did; cards past the cap wait, as behind "+N more" (review fix — the first version stopped every clock while the pill was folded, and no toast ever expired on a phone). A visible toast keeps its clock when another arrives (second review fix). A widget registers its count in a layout effect, so the render after an arrival asked the dock's store with the old count: n places for n+1 toasts. The oldest visible card dropped for one commit and came back as a new node, its slide-in replayed and its time restarted. In Chromium, a 5 s toast with a second one 3 s later was still up at 5.5 s and gone at about 8 s; on base it was gone at 5 s. Now the allowance is computed with the widget's live count (`allowanceFor`). The same probe, rebuilt against this branch, keeps the same node and the toast is gone at 5.5 s.
- **Accessibility.** The list is `role="status"`, an error toast is `role="alert"`, and the X has `aria-label="Dismiss"`. The dock itself is `role="region"`, `aria-live="polite"`, `aria-relevant="additions"` (NEDGE-5 dw2's part, for N3 to verify).

Tests: `lib/__tests__/cornerDock.test.ts` "toasts: cap, coalesce, timers…" (a single toast appears, is announced, is dismissible and expires; ten identical toasts are one ×10 card; a collapsed toast keeps its full time and expires only after it showed; a toast on a page with no dock still shows), "hidden messages offer the notification center…" (opened with no argument — the click event is never passed as the center's filter), the phone clock tests under STACK-7, and "a new toast never costs a visible one its card or its clock: two toasts 3s apart, the first goes at 5s, same node throughout" (fails against the stale allowance).

**Done-when.**
- Partial, NOT met as written in one reachable state. At rest, `showToast`'s visible stack is capped (the newest 4) and the remainder collapses into a single "+N more" card that opens the notification center. While the dock is raised over a modal that started an upload, the remainder is in "+N more" but the card does not open the notification center. Since the N7 fourth review fix the doorway renders only at rest (`components/ui/CornerDock.tsx`, the `!raised` guard on the "Notifications" button): the center would open under the modal, invisible. Showing the doorway while raised was checked and rejected for that reason (2026-10-02). *Overstated: the tick stood unqualified after the N7 fourth review fix made the doorway rest-only. It is withdrawn 2026-10-02 (N7 final review).* Remaining step — **owner: N3 SURFACES**, which owns `components/notifications/NotificationCenter.tsx`. The center must open above an open upload modal when it is opened from the dock; then the dock offers the doorway while raised (drop the `!raised` guard; the test "raised, the '+N more' offers no 'Notifications' doorway…" changes with it).
- Partial, NOT met as written. Toasts with the same type, title and message within 10 seconds coalesce into one card with a count, and `showToast` takes a `coalesceKey` so a producer can key by kind + resourceId. The only realtime producer, `components/providers/NotificationListener.tsx` (N3's file this round), passes none yet, so two differently worded rows about one event stay two cards. Remaining step: N3 passes `` coalesceKey: `${row.kind}:${row.resource_id}` `` (hand-off in `99-fix-sequencing.md`).
- ✓ The dock gets a max-height and overflow-y-auto.
- ✓ The auto-dismiss timer does not start until the card is within the visible stack (on a phone, within the four places the folded pill stands for), and a card that stays within it keeps its clock when newer toasts arrive.

**Scope / residual.** Stays OPEN on dw1 until N3 lets the center open above a raising modal, and the dock offers its doorway while raised. Stays OPEN on dw2 until N3 passes `coalesceKey: kind:resource_id` from `components/providers/NotificationListener.tsx` (one line). Both are in the hand-off in `99-fix-sequencing.md`. No migration.

**Resolution (2026-10-02, notifications Round G).** Package N3 SURFACES closes the two remainders N7 handed over (`99-fix-sequencing.md` Phase 2 hand-off). **Reproduced first** on `7c27b0c`: the doorway rendered only at rest (`components/ui/CornerDock.tsx:805`, `!expanded && !raised && …`), because the center sat at 240 / 241 (`components/notifications/NotificationCenter.tsx:89`, `:98`), under every upload-starting modal (300 / 400 / 510); and `NotificationListener` passed no `coalesceKey` (`components/providers/NotificationListener.tsx:92-97`).

What landed:
- **The center opens above a raising modal** (done-when 1). `NotificationCenter.tsx` `open()` reads `isDockRaised()` (a read the dock now exports, `CornerDock.tsx:473`) when it opens (:81); opened while the dock is raised, both its backdrop and its panel take `Z.dialog` (700 — a layer `lib/zLayers.ts` already lists and names: above every upload modal, below the raised dock at 750; no new literal), and keep it until the center closes (:331). The panel declares itself a rail **above the raise** (`useOccupyRightRail(panelRef, isOpen && aboveModal, true)`, :204 — the hook's new third argument, `CornerDock.tsx:602`), and the raised dock, which ignores every other rail, moves left of that one (`railSnapshot`, :651) — over the center's backdrop, never onto its rows.
- **The dock offers its doorway while raised** — the `!raised` guard is gone (`CornerDock.tsx:825`), as the hand-off asked; nothing else in the dock changed (`raisedRails`, `isDockRaised`, the hook's argument, two comments).
- **`coalesceKey: notificationCoalesceKey(row)` — kind, resource and the row's words** (done-when 2; since the third review fix) — `notificationCoalesceKey` (`NotificationListener.tsx:94`), passed by `toastForRow` (:112); a row about no resource keeps N7's content key, so two unrelated messages never merge. *Second review fix (2026-10-02):* the key first was kind + resource alone, and N7's merge keeps the first card's words, so Carol's sign-off on P-1 within 10 s of Bob's read "Bob signed off on P-1 ×2" (two authors on one document, a status burst showing the older status — the same). The actor is now part of the event: one person's repeat is one card with a count; two people's acts on one resource are two cards, each naming its own person. A repeat by the same actor still shows the first row's words (Alice posting twice shows her first snippet ×2) — the remainder of `DEC-44 (N3)` item 4, handed to `ToastProvider`'s next holder. And within the listener's burst window a repeat of an event already on screen now joins its card rather than being held for the summary (`TAX-9`), so a burst of one event is one card ×N. *Third review fix (2026-10-02):* keyed on kind + resource + actor, one person's differently worded rows still merged into a card showing the first row's words — one engineer's Approve then Release on DR-12 within 10 s read "Approve · DR-12 — Status: APPROVED ×2" while the request was already released, and "hey" followed by "PSV sizing on sheet 3 is wrong" read "hey ×2", the real message never reaching a toast (on `7c27b0c` each was its own card). The key is now the row's **statement** — kind, resource, title and body — and the actor left it: only rows that say the same thing merge, so every merged card shows exactly what each of its rows said, and a row that says something new is a card of its own. *Fourth review fix (2026-10-02): that keeps every card truthful, but it does not make differently worded rows about one event coalesce, which is what the assigned step was for — done-when 2 is Partial (the Partial block below).*

Tests: `lib/__tests__/notificationCenterScope.test.ts` "the doorway is offered raised; the center opens at Z.dialog (above every upload modal), and the raised dock moves left of it" (the dock at `Z.dockRaised`, a click on "Notifications", the panel and backdrop at 700, the dock's right offset 480 px, back to the edge when the center closes) and "opened at rest, the center keeps its resting layer"; `lib/__tests__/cornerDock.test.ts` "raised, the '+N more' offers the 'Notifications' doorway (RT-11, N3)…" (N7's test, changed with it as the hand-off said: the doorway is offered and opens with no argument; the layout's resting rail still does not move the raised dock); `lib/__tests__/notificationListenerToasts.test.ts` "the same row twice (same kind, resource and words) is one card with a count" (it replaced "two rows about one event…, worded differently, are one card" at the third review fix), "two people on one resource are two cards, each naming its own person…", "a nudge burst about one thing from one person is one card with a count…" (second review fix); `lib/__tests__/notificationListener.test.ts` "RT-11 dw2 / OS-4 dw2: the coalesce key is the statement — kind, resource and words…", "rows that say different things about one resource never share a key, whoever sent them…" (second review fix). Every other N7 test is unchanged and green. Verified: loop on `fleet/N3-surfaces` at `bac49dc`: `npx tsc --noEmit` exit 0; `npx eslint` on the 16 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 406 files, 8496 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ `showToast` caps the visible stack at 4 and collapses the remainder into one "+N more" card that opens the notification center — at rest and now raised (the center opens above the raising modal).
- **Partial, NOT met as the hand-off meant it — the reading is pending ratification.** Rows with the same kind, resource and words (`notificationCoalesceKey`) within the window coalesce into one card with a count (a nudge clicked five times is one card ×5); rows that differ in what they say stay separate cards, because the merge keeps the first card's words and would hide the newer ones. The step N7 assigned was `` coalesceKey: `${row.kind}:${row.resource_id}` ``, "so that differently worded rows about one event coalesce too" (`99-fix-sequencing.md`, the N7 → N3 hand-off), and that purpose is **not met**: N7's content key (type, title, message) already merged word-identical toasts, so the landed key coalesces nothing N7's default did not (it only keeps apart same-worded rows about different kinds or resources), and differently worded rows about one event — a burst of status rows on DR-12, "hey" then "PSV sizing on sheet 3 is wrong" on P-1 — are still separate cards. Reading "identical (kind + resourceId)" as identical words about one kind and resource is `DEC-44 (N3)` item 4's, for the integrator to ratify. *Third review fix:* the second review's key (kind + resource + actor, on the reviewer's reading "identical = the same event") merged one actor's differently worded rows into a card in the first row's words; that reading is withdrawn and the actor left the key. *Overstated: this bullet was ticked ✓ "read as written" at the third review fix; by the standard that sent `TAX-9` (a done-when resting on an unratified reading) and `TAX-15` (a limb not met) back to OPEN, it is not met (N3 fourth review, 2026-10-02).*
- ✓ The dock has a max-height and overflow-y-auto (N7).
- ✓ The auto-dismiss timer starts only when the card is within the visible stack (N7).

*Review fix (2026-10-02, N3): opened above an upload modal, every row of the center and its "Open the full inbox cockpit" link navigate client-side away from the page that owns the running upload — and a client-side navigation meets no leave-page prompt (`lib/uploadActivity`'s guard is `beforeunload` only), so the modal unmounted mid-batch. Now `NotificationCenter.tsx` checks such a click in the capture phase (`guardLeave`): while the center is above a modal and `hasUploadsInFlight()`, it asks first — `confirmLeaveDuringUploads`, "An upload is still running … Leave anyway / Stay", the reload prompt's words — and replays the link's own click only on yes (a new-tab click and a row's own "mark read" control never ask). Tests: `lib/__tests__/notificationCenterScope.test.ts` "an upload in flight: a row asks first, inside the panel; 'Stay' keeps the page…, 'Leave anyway' follows the row", "the inbox link asks too; a row's own 'mark read' control never asks", "no upload in flight, or opened at rest: a link is followed at once, as before", "the question reuses the reload prompt's words". Verified: loop on `fleet/N3-surfaces` after the review fix — `npx tsc --noEmit` exit 0; `npx eslint` on the 19 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0, 407 files, 8506 passed, 7 expected-fail; `next build` is the integrator's.*

*Second review fix (2026-10-02, N3): with the leave-confirm open over the center, Escape closed the center behind it — the center's Escape handler is a window capture listener that stopped the key before DialogHost's `document` listener saw it — so a second Escape was needed to answer the question, and "Leave anyway" then replayed a click inside the closed, inert panel. Now an Escape whose target (or the focused element) is inside another dialog is left to that dialog (`NotificationCenter.tsx:215-240` since the third review fix), and a replay is skipped once the panel is inert (:312). Test: `lib/__tests__/notificationCenterScope.test.ts` "Escape inside the leave-confirm answers it ('Stay') — the center stays open behind it; 'Leave anyway' then follows the row" (rewritten at the third review fix, below) (the real DialogHost; fails with the fix reverted). Verified after the second review fix: `npx tsc --noEmit` exit 0; `npx eslint` on the 19 changed code and test files of the branch `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 407 files, 8516 passed, 7 expected-fail (an earlier full run under machine load timed out two unrelated fuzz tests at the 5 s default and one first-frame timing test of N7's; each passed alone and the rerun was clean).*

*Third review fix (2026-10-02, N3): the second review note above was overstated. Escape on the leave-confirm did answer "Stay" and leave the center open — and then went on: DialogHost's Modal cancels on `document` without stopping the key, the center let it through, and `MetadataStagingModal`'s `window` bubble listener (`components/documents/MetadataStagingModal.tsx`, `onKey` → `requestClose()`) aborted the in-flight transfers and closed the wizard — the outcome the person had just declined (reproduced by the reviewer with the real ToastProvider, CornerDock, center and DialogHost). Now the question is the panel's own: `confirmLeaveDuringUploads({ ask })` (`NotificationCenter.tsx:140`) takes the panel's inline question (`askLeave` :181 / `answerLeave` :188; rendered as an `alertdialog` over the rows at :432, the rest of the panel inert, "Stay" focused, the wording `LEAVE_QUESTION` :126), and the center's capture handler answers an Escape while it is up — "Stay", `stopPropagation`, the center stays open (:219-223) — so nothing under the center hears it. An Escape answered by an app dialog opened over the center (on `document`, Modal's convention) now stops right after that dialog's handler (:227-234), before any `window` listener. "Stay" returns focus to the row that asked; closing the center with the question up answers "Stay". Tests: `lib/__tests__/notificationCenterScope.test.ts` "Escape on the leave question answers it ('Stay') and goes no further: the raising modal's window Escape listener never fires, the upload keeps running, the center stays open…" (a `window` bubble listener copied from the staging modal; it fails with the `stopPropagation` removed), "an app dialog opened over the center answers its own Escape, and the key stops there…" (fails with the stop removed), "closed with the question up (the backdrop), the answer is 'Stay'…", "the premise: MetadataStagingModal's Escape is a window bubble listener that aborts the upload" (a source pin, so the copy stays honest), and the three earlier leave-question cases rewritten for the inline question. Coalescing (done-when 2, above): `lib/__tests__/notificationListenerToasts.test.ts` "one person's two thread posts are two cards — the second message reaches a toast…", "Approve then Release on DR-12 by one engineer within 10 s: two cards, the newer status shown…", "the same row twice (same kind, resource and words) is one card with a count"; `lib/__tests__/notificationListener.test.ts` "rows that say different things about one resource never share a key…" (each fails with the second review's key restored). Verified after the third review fix: `npx tsc --noEmit` exit 0; `npx eslint` on the 19 changed code and test files of the branch `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 407 files, 8522 passed, 7 expected-fail. `next build` is the integrator's.*

*Fourth review fix (2026-10-02, N3): the second and third review fixes let an Escape whose target (or the focused element) sat in **any** other `role="dialog"` go to that dialog, and the stop-after-dialog listener then stopped it at `document`. The center declares `aria-modal` but does not trap Tab (as on `7c27b0c`), so Shift+Tab from its first control can land in a dialog **under** it — `InspectorDrawer` (z-60, `components/documents/InspectorDrawer.tsx`, Escape on a `window` bubble listener) or `HistoryDrawer` (z-70) — and Escape there closed neither the center (it deferred) nor the drawer (the key was stopped before `window`); on `7c27b0c` Escape always closed the center. Now the center defers only to a dialog that paints **above** it: `dialogPaintsAbovePanel` (`NotificationCenter.tsx:474`, called at :227) compares the dialog's layer — the outermost numeric z-index on it or an ancestor — with the panel's (`Z.dialog` when opened above a raising modal, `CENTER_PANEL_Z_AT_REST` = 241 at rest, :461), an equal layer going to the later element in the document (the dialog host at `Z.dialog` over a raised center). Any other Escape closes the center and stops at `window` capture, as on base, so a drawer under it (or the upload modal under a raised center) does not also act on it; the next Escape is the drawer's. No Tab trap was added: the raised dock's upload cards, above the center, stay reachable by keyboard. Tests: `lib/__tests__/notificationCenterScope.test.ts` "focus in a dialog UNDER the center (the real InspectorDrawer, z-60, its Escape a window listener): Escape closes the center and stops there; the next Escape closes the drawer — as on base", "raised over an upload modal, the same: focus in a role="dialog" at z-60 — Escape closes the center and stops there; neither the drawer's nor the staging modal's window listener hears it" (both fail with the comparison removed), "dialogPaintsAbovePanel: a higher layer is above, a lower one under, an equal one by document order…" (pure); "an app dialog opened over the center answers its own Escape…" is unchanged and green (it fails if the comparison calls the dialog host "under"). Verified after the fourth review fix: `npx tsc --noEmit` exit 0; `npx eslint` on the 19 changed code and test files of the branch `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 1 on every full run of this pass, each failure a timing one under a machine load average of 35–61 (other packages' suites running alongside) in a file this pass does not touch: the first run (load about 35) — 407 files, 8521 passed, 7 expected-fail, 4 failed, each a 5 s "Test timed out" (`dcRoundFOwnerStamp`, `dcRoundFShareInventory`, `dependencies`, `searchPathPin`; the four exit 0 alone with `--testTimeout=60000`); a full run with `--testTimeout=60000` (load about 56–61) — 8519 passed, 7 expected-fail, 6 failed, each an in-test elapsed-time budget or a 30 s timeout (`aiUsageRoute`, `askRouteHonesty`, `customSkillRunner`, `drawingText`, `intelRoundGDrawingRoutes`, `scheduleImportWriters`; all six exit 0 when re-run, and `customSkillRunner` missed a time budget on the unchanged `d5739db` under the same load). The N3 suites passed in both runs. Two default-timeout runs at load 50+ cascaded from 5 s timeouts (`cornerDock` among them, which times out the same way with the previous center restored). `next build` is the integrator's.*

**Scope / residual.** Observed in jsdom with the real dock, toast provider, dialog host and center; not re-observed in a browser. Raised, the center covers the raising modal (it is a modal over it); closing it returns to the modal with the upload cards still reporting. Opened there, a link asks before it leaves while the upload runs (review fix above), inside the panel (third review fix); browser Back is not guarded, as before. A merged card now only ever stands for rows with the same words (third review fix); coalescing differently worded rows about one event — done-when 2's purpose — needs `ToastProvider`'s merge to show the newest row's words first (*corrected at the fourth review fix: this line said nothing was left for `ToastProvider`'s next holder; see the Partial block below*). No migration.

**Partial (2026-10-02, notifications Round G — N3 fourth review fix).** Status corrected from RESOLVED to OPEN. Done-when 1 is met by N3 (the doorway, at rest and raised; the center opens above a raising modal), done-when 3 and 4 by N7, as recorded above. Done-when 2 is **not met as the hand-off meant it**. The landed key (`notificationCoalesceKey`, `components/providers/NotificationListener.tsx:94`, passed by `toastForRow` at :112) is kind + resource + title + body: it coalesces only rows that are already word-identical, which N7's content key (type, title, message — `components/providers/ToastProvider.tsx` `toastCoalesceKey`) merged before it. The assigned key, `` `${row.kind}:${row.resource_id}` ``, was assigned "so that differently worded rows about one event coalesce too" (`99-fix-sequencing.md`, the N7 → N3 hand-off), and such rows still show as separate cards — two cards plus an "N more notifications" summary per 6 s window (`TAX-9`). The assigned key was not passed because N7's merge keeps the **first** row's words: keyed on kind + resource, Carol's sign-off on P-1 within 10 s of Bob's read "Bob signed off on P-1 ×2", and a newer status on DR-12 read as the older one (second and third review fixes). The statement key stays — it is safe: no card shows words a later row contradicts. Reading done-when 2's "identical (kind + resourceId)" as identical words is `DEC-44 (N3)` item 4's, **pending the integrator's ratification**; ratified, this item is met.

Remaining step (either closes it): (a) the integrator ratifies `DEC-44 (N3)` item 4's reading; or (b) **whoever next holds `components/providers/ToastProvider.tsx`** makes a coalesce merge show the newest row's title and message (or a neutral "N updates on <resource>") instead of the first's; then `NotificationListener` (N3's file this round; its next holder) passes the assigned `` `${row.kind}:${row.resource_id}` `` and the tests that pin two cards for differently worded rows (`lib/__tests__/notificationListenerToasts.test.ts`, `lib/__tests__/notificationListener.test.ts`) change with it. **Owner:** the integrator assigns (b); hand-off in `99-fix-sequencing.md` (restored at this fix — the third review fix had withdrawn it). No code changed for done-when 2 in the fourth review fix; records only.

**Done-when.**
- ✓ `showToast` caps the visible stack at 4 and collapses the remainder into one "+N more" card that opens the notification center, at rest and raised (N3; the cap and the card are N7's).
- Partial, NOT met as the hand-off meant it (pending ratification): word-identical rows about one kind and resource are one card ×N; differently worded rows about one event are not coalesced (above).
- ✓ The dock has a max-height and overflow-y-auto (N7).
- ✓ The auto-dismiss timer starts only when the card is within the visible stack (N7).

**Scope / residual.** Stays OPEN on done-when 2 until (a) or (b) above. The Escape fix of this pass (the fourth review note above) does not change this finding's status. Browser Back is not guarded. Observed in jsdom only. No migration.

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

**Cross-reference (2026-09-30, projects Round G).** The milestones half is addressed by `supabase/migrations/20261106_prj_roundG_milestones_realtime.sql` (J6b SCHEDULE-ENGINE, projects-tab PT SCH-7): it adds `milestones` to `supabase_realtime` idempotently with the 20260727 `IF NOT EXISTS (SELECT 1 FROM pg_publication_tables …)` pattern, and a DEC-30 inventory row records whether it had already been added by hand in the dashboard (done-when 1 for this table is that row). `components/projects/ScheduleTab.tsx` now listens to INSERT / UPDATE only, because Supabase delivers DELETE events without an RLS check. Pinned by `lib/__tests__/scheduleEngineMigration.test.ts`. Not done here: `table_views` (`lib/tableViews.ts`) and the repo-wide tripwire (done-when 3). RT-12 stays OPEN for its owner.

---
