# 07 · OS notifications, login nudges & person-to-person pokes

**12 findings** — 2 HIGH · 10 MEDIUM.

What exists for real OS-level presence, and what a nudge would attach to.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded. A severity set by that pass overrides the original.


### Already there — reusable substrate

| Thing | Where | Why it matters |
|---|---|---|
| Complete, correct Web Push RECEIVER in the service worker — push handler with title/body/icon/badge/tag/renotify, plus a notificationclick handler that focuses an existing window and navigates it, falling back to openWindow | `public/sw.js:225-260` | The half of Web Push that is easiest to get wrong is already written and commented. A build needs only the subscribe side and the sender; the delivery/click-through UX needs no new code. Note it already reads data.url for the deep link, so any sender must include {title, body, url, tag}. |
| Installable PWA manifest with real raster icons (192/512 + maskable) and standalone display | `app/manifest.ts:9-33, public/icon-192.png, public/icon-512.png` | Web Push on iOS requires the app to be installed to the Home Screen. This is already satisfied. The push handler's icon:'/icon-192.png' and badge:'/icon-192.png' both resolve to files that exist. |
| push_subscriptions table with per-user RLS (select/insert/delete own) and a service-role-bypass sender model, plus endpoint UNIQUE and a user_id index | `supabase/migrations/20260804_push_subscriptions.sql:7-35` | The storage layer for (A) is written and its security model is already correct: users manage only their own device rows, the sender uses the service role. It also carries last_reminded_at, a per-device throttle column a nudge-cooldown could reuse. |
| emit() — the documented single fan-out point, with recipient resolution across followers/roles/project-members, actor exclusion, dedupe, and per-channel preference gating | `lib/notify/dispatch.ts:78-124, resolveRecipients at :64-77` | This is where a push channel attaches. Eight call sites already route through it (holds, postPublish x2, branches x2, projects, staleCopies, distributionAcks, orchestrator/tools), so one change there reaches every one of them. resolveRecipients() is exported specifically so a caller can preview 'who would this notify' without sending — directly reusable for a nudge's confirmation UI. |
| useTicketNotifications — the single unified attention feed powering the sidebar badge, the header bell, the Notification Center and /inbox, with realtime subscriptions on both tickets and notifications, plus stale-workflow-alert reconciliation | `hooks/useTicketNotifications.ts:126-325` | The unread-count hook for (B) already exists and is already the one source of truth. A login nudge should consume `count` from here rather than adding a second count. It also already exposes markRead/markAllRead(orgId) and per-section counts. |
| CornerDock + CornerPortal — one shared bottom-right stacking column that widgets portal into, with a graceful fixed-position fallback when the dock is absent | `components/ui/CornerDock.tsx:20-46, mounted at app/(protected)/layout.tsx:66` | Answers the owner's complaint #5 (background job messages stacking gracefully bottom-right) — the mechanism is built and already used by ToastProvider, UploadIndicator, BackupIndicator and KnowledgeIndexIndicator. What it lacks is a cap/max-height, not a stacking model. |
| Two working, differently-shaped server-side rate limits | `app/api/auth/signup/route.ts:19-33 (count rows in signup_attempts by IP within the last hour, fail-open on error) and app/api/data-export/run/route.ts:78-91 (count export_runs by org within the last hour, return 429 with a human message)` | The (C) abuse surface has a house pattern to copy verbatim: count recent rows in a table keyed by actor+window, refuse with 429 and an explanatory message. The data-export variant is the closer fit (authenticated, org-scoped). |
| Cooldown-by-querying-notifications watermark — reads back recent notification rows of specific kinds, keyed on (user_id, resource_id) with a metadata flag, to suppress repeat nagging | `lib/distributionAcks.ts:207-240` | A persisted, refresh-proof replacement for the checkouts nudge's component-local `nudged` flag, using the table the nudge already writes to — no new table needed. It also demonstrates the metadata-marker convention (meta.ackRequest / meta.ackEscalation) that a nudge marker should follow. |
| Server-side notification fan-out done right: auth + active-membership check, atomic RPC write, bell rows + preference-aware email queue, deep-link with ?c=<commentId>, and an after() hook that kicks the email drain immediately | `app/api/tickets/comment/route.ts:26-146, fanOut at :250-330` | The template for the (C) nudge route. It already resolves the exact audience a drafting-request poke needs — requester + assignedDrafterId + assignedEngineerId + watchers + mentions, minus the actor (lines 88-96) — and it already writes both channels honoring notification_preferences. |
| @-mention infrastructure: MentionableTextarea inserting canonical @[Name](uid) tokens, extractMentionUids(), and the comment route turning a mention into kind:'ticket_mention' with its own email subject and the mention preference toggle | `components/requests/MentionableTextarea.tsx:32-100, app/api/tickets/comment/route.ts:79 and :262` | A direct poke already half-exists: @-mentioning the assigned engineer in a comment on the drafting request delivers a bell row AND a preference-gated email, deep-linked to that comment. The smallest honest build for (C) is a button that pre-fills this composer with the engineer's mention token — reusing an audited server route instead of opening a new client-side write path. |
| Precedent for a one-click person-to-person nudge with recipient resolution, actor exclusion, an empty-recipient guard, a confirming toast, and a settled button state | `app/(protected)/checkouts/page.tsx:242-269 (handler) and :476-518 (OverlapCard button)` | The whole interaction pattern for (C) — including the 'Nobody to notify / You're the only person on this overlap' guard and the 'Heads-up sent' settled state — is designed and shipped. What it needs is the persistence and rate-limit fixes, not a redesign. |
| ticketAttention.isActionRequired() + attentionLabel() — the single rule for 'is this ticket waiting on a specific person', including assignedEngineerId on PENDING_ENG_TEAM / PENDING_FINAL_APPROVAL | `lib/ticketAttention.ts:63-110, labels at :113-126` | Answers 'is this request actually awaiting the engineer's approval, and who exactly' without new logic — the precondition for showing a poke button at all. attentionLabel('PENDING_FINAL_APPROVAL') already returns 'Needs engineer sign-off', which is the nudge's body copy. |
| Engineer-reviewer status already rendered on the request detail page, with a pulsing blue dot while unapproved and an emerald 'approved' state | `app/(protected)/requests/[id]/page.tsx:1741-1749` | The exact pixel where the (C) poke button belongs is already built and already knows the engineer's name, email and approval state — `ticket.engineerApprovedAt ? 'bg-emerald-500' : 'bg-blue-500 animate-pulse'`. Adding a button beside it requires no new data fetch. |
| Auth entry point with an explicit, well-documented SIGNED_IN branch that already distinguishes a genuine user switch from the re-emits that fire on tab return and token refresh | `components/providers/RoleContext.tsx:257-320, uidRef sync at :76` | The mount/trigger point for (B). The comment at :300-306 is the warning a login-nudge build most needs: 'SIGNED_IN re-fires on tab return, on token refresh, and any time Supabase re-detects an existing session — not only on a fresh password login.' The isSameUser check at :307 is the existing guard to hang a once-per-session nudge on. |
| Root providers tree with a clear insertion point inside the auth gate: ToastProvider > RoleProvider > OrgBrandingProvider > SubscriptionProvider > NotificationCenterProvider > ProtectedContent, with NotificationListener/CornerDock/indicators mounted inside <main> | `app/(protected)/layout.tsx:56-77 and :146-160` | A login-nudge banner mounts alongside NotificationListener at line 62 — inside the auth gate, below RoleProvider (so uid/activeOrgId are resolved) and inside NotificationCenterProvider (so 'See all' can call openCenter()). TrialBanner at :59 is the existing precedent for a dismissible full-width banner above the shell. |
| NotificationCenterProvider's global open(filter) plus the 'mfgos:open-notifications' window event the bell already listens for | `components/notifications/NotificationCenter.tsx:34-45, components/notifications/NotificationBell.tsx:60-64` | A login nudge's primary action ('show me the N things') needs no new navigation — openCenter('action') opens the same slide-over the badges open, guaranteeing the nudge's number and the panel's contents cannot disagree. |
| Service worker registration + update-pill lifecycle, with SKIP_WAITING messaging and an offline pill | `components/pwa/ServiceWorkerManager.tsx:18-92, offline route at app/offline` | The registration handle a push build needs (`.register('/sw.js').then((reg) => ...)`) is already obtained here; pushManager lives on that same registration object. Note the placement caveat in the permission-prompt finding — reuse the registration, not the mount point, for prompting. |


---


<a id="os-1"></a>

## OS-1 · Any active org member can insert unlimited notification rows for any other member, with arbitrary kind/title/body, and no rate limit exists on that path

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260621_in_app_notifications.sql:52-60`, `lib/inAppNotifications.ts:78-97`, `app/(protected)/checkouts/page.tsx:256-269`, `components/documents/EditOverlapBanner.tsx:84`, `components/documents/CheckoutFlowModal.tsx:403`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Claim holds in full: any active member can insert unbounded rows for any co-member with attacker-chosen kind/title/body. HIGH is defensible rather than inflated because `link` is also attacker-chosen and is rendered as a live `<Link href={item.link}>` in NotificationBell.tsx:170, making this an internal phishing primitive, not just spam.

**Mechanism.** The notifications INSERT policy checks only that auth.uid() is an active member of the target org — not that the caller has any relationship to the recipient, and not how many rows they have written. notify()/notifyMany() are called directly from CLIENT components using the anon-key supabase client, so the write happens under this policy with no server route in between. The policy comment explicitly defers validation to 'the app layer', and the app layer performs none: notify() inserts whatever kind/title/body it is handed. This is precisely the path a person-to-person nudge (C) would reuse, so the abuse surface is inherited on day one.

**Failure scenario.** A requester impatient about an engineer's approval clicks a future 'Nudge engineer' button ten times in a minute; ten notification rows land, the engineer's bell counts to ten, and NotificationListener fires ten toasts (see the toast-storm finding). Worse, because kind is unvalidated, a client can insert kind:"checkout_conflict" — which useTicketNotifications treats as actionRequired — turning any org member into someone who can paint a red, pulsing, action-required badge on a colleague's sidebar. Nothing in the database or the app stops either.

**Evidence.**

```
supabase/migrations/20260621_in_app_notifications.sql:52 —
  DROP POLICY IF EXISTS notifications_org_insert ON notifications;
  CREATE POLICY notifications_org_insert ON notifications FOR INSERT
    WITH CHECK (
      EXISTS (
        SELECT 1 FROM org_members
        WHERE org_members.org_id = notifications.org_id
          AND org_members.uid = auth.uid()
          AND org_members.status = 'active'
      )
    );

(the migration's own comment above it: "Org members can insert notifications for anyone in the org. ... The kind/body are validated at the app layer.")

hooks/useTicketNotifications.ts:277 —
  const actionKinds = new Set(['checkout_conflict', 'checkout_released', 'overlap_advisory', 'branch_open']);
```

**Chain reaction.** Because notifications is also the table the distributionAcks cooldown watermark reads (lib/distributionAcks.ts:224-238), a flood of client-inserted rows carrying the wrong kind can also suppress or trigger the automated ack nagging, which is a PSM-relevant compliance clock.

> **Verifier correction.** One evidence anchor is irrelevant to the claim: the quoted hooks/useTicketNotifications.ts:277 `actionKinds` line (it is actually at :279) is about feed rendering and has nothing to do with the INSERT policy. It should be dropped; the migration quote carries the finding on its own.

**Done when.**

- [ ] A person-to-person nudge goes through a server route (like app/api/tickets/comment/route.ts) that verifies the caller's relationship to the resource, not through client-side notifyMany()
- [ ] A rate limit modeled on app/api/data-export/run/route.ts:78-91 caps nudges per (actor, recipient, resource) per window and returns 429
- [ ] The notify path rejects or ignores caller-supplied `kind` values outside an allowlist for that route
- [ ] Either the RLS INSERT policy is narrowed to service-role, or a DB-level trigger caps inserts per actor per interval

**Resolution (2026-10-02, notifications Round G).** Package N5 DISPATCH-AND-WRITE-HOLES, commit `018caac`, the review fix `4762ad2` (the caps) and the second review fix `b97e17c` (the caller checked first, the caps serialised per actor, the server's watermarks refused — below), and the third review fix `05b1559` (the actor's lock only near a cap; a census of every browser producer's actor), and fix pass 4 `8fbb2a4` (the lock claim corrected: a publish's repeat notice takes it), migration `supabase/migrations/20261160_notif_roundG_write_rails.sql`. **Reproduced first** on a throwaway PostgreSQL 16 carrying `20260723`'s insert policy verbatim: an ordinary active Engineer inserted, from their own session, 100 `checkout_conflict` rows (an action kind — a red badge) into a colleague's bell in one statement, a row of a kind nobody declared, a row linking to `https://evil.example/login`, and a row naming the Admin as its actor with `actor_name` 'System' — all accepted. **Fix:** a database rail, so the ~30 browser producers keep writing exactly as before and nothing moves to a server route (DEC-31; the plan's trigger approach). `enforce_notification_insert()` — a BEFORE INSERT trigger, SECURITY DEFINER, `search_path` pinned, EXECUTE revoked from PUBLIC, anon and authenticated (nobody calls it directly; PostgreSQL does not check EXECUTE when a trigger fires — exercised):
- its FIRST statement returns NEW untouched when `auth.uid()` IS NULL — the service role and the cron — so every server producer (the ticket routes, the transmittal route, the intake door, the cron, `notify_personnel`, the data-export and AI-cap notices) writes exactly as before;
- for a signed-in writer, its first check is that the CALLER is an active member of the row's org (42501) — before the trigger reads anything else of that org with its definer rights (second review fix: without it the recipient and resource checks ran for any org id a caller named, and their outcome was a cross-tenant oracle);
- for a signed-in writer: the actor is stamped when absent and refused when it is someone else (`DELIV-6`), and the row is dated when it is written (`created_at := now()` — a back-dated row would slip every cap's window, a future-dated one would sit at the top of a bell for good); the kind must be one `notification_kinds()` declares (22023) and not one only the server writes (22023, second review fix — `DELIV-13`); the link must be app-relative (22023); the metadata must carry none of the server's dedupe watermark keys (22023, second review fix — `DELIV-13`); a recipient who is not an active member of the row's org is SKIPPED (`NEDGE-3`); then the caps (P0001);
- `notifications_org_insert` is kept unchanged: RLS's WITH CHECK still runs after the trigger and checks the caller's membership again.
- `notification_kinds()` — an IMMUTABLE set-returning reference relation of the 51 kinds of `lib/notificationKinds.ts` `KIND_META` and their compliance flags (15 compliance) — the database's allowlist (`DEC-86`).
- **The rate caps** (the plan's default was "60 inserts/actor/minute"; the review fix `4762ad2` replaced the first pass's per-recipient-only caps, whose 60 keyed on a caller-written `resource_id` and which had no ceiling across recipients):
  - **per actor and recipient, the last minute:** 60 rows of the same kind about the same resource (a poke pressed 60 times) — and `resource_id` counts only when it names a row of `resource_type` (`document`, `ticket`, `project`, `library` — `emit()`'s resource types but `asset`, which has no table) in the row's org; any other `resource_id` is caller-written text and the cap then counts the kind alone, so a loop that mints a fresh `resource_id` per row lands 60 a minute; and 600 rows of anything;
  - **per actor and recipient, the last hour:** 1,200 rows of anything — twice the minute cap, so a sustained loop reaches one person 1,200 times an hour, not 36,000;
  - **per actor across every recipient, the last minute:** 3,000 rows — ten times an org-wide audience. The plan's 60-per-actor would refuse legitimate single fan-outs, each one row per recipient: the browser's checkout sweep writes every expired holder's release notice in ONE statement (`lib/projects.ts` `autoReleaseExpiredAdHoc`), an acknowledgment roster writes one request per assignee (`lib/acknowledgments.ts`), a role broadcast one row per controller. At 3,000 none of those meets it and no member can flood the whole org.
  - **How the counts meet concurrency** (second review fix, revised by the third). The counts see committed rows only, so N parallel requests from one member (a `Promise.all` of `notify()` calls) each see the same baseline. The second review fix took a transaction-scoped advisory lock keyed on the actor (`pg_advisory_xact_lock(hashtextextended('notif-cap:' || uid, 0))`) before every count. That made the caps exact, but through the API it serialised every insert of one member: each queued request holds one of PostgREST's pooled connections (10–20 on small tiers), so one member's bulk fan-out ran one insert at a time and could occupy the whole pool, leaving every other member's requests waiting for a connection. ("Another actor never waits" held only in a direct database session.) Since the third review fix (`05b1559`) the counts are taken first **without** the lock. A count already at its cap is refused there, so a refusal never queues. A row far from every cap is judged as it stands. A row **near** a cap (the same notice already sent to that person this minute, since the 60 cap is smaller than the margin, or a count within 64 of its cap) and **every later row of one transaction** (a transaction-local setting marks the first) are counted again under the lock, one after another. One key per transaction, so no lock-order deadlock; a skipped row takes no lock. What it costs: requests that arrive one after another, and every later row of a multi-row statement, are counted exactly. A burst counted at one instant can pass a cap only by rows judged without the lock, each at least 64 below every cap, that are still uncommitted when later rows reach the cap. That is at most one per request of that member in flight, fewer than the pool's width, and none for a burst of up to 60 that commits as it lands.
  - The inventory counts the minute and hour buckets of the last 30 days that would have met each cap, and reports the busiest minute and hour any actor actually wrote — the numbers the caps are sized against (rows that name an actor: server rows that name one are counted too; browser rows that named none before the paste are not). Indexes `notifications_actor_recipient_idx (actor_user_id, user_id, created_at DESC)` and `notifications_actor_created_idx (actor_user_id, created_at DESC)` make each count a range scan; the per-actor count is LIMITed at the cap.

**Exercised on PostgreSQL 16.** As an active member: impersonating the Admin is refused (42501); a minted kind, an `https:` link, `//evil`, `/\evil`, a tab-smuggled `/\t/evil` and `javascript:` are refused (22023); an app link with no actor lands with the actor stamped; empty and NULL links land; a row to a suspended member, to another org's member, and the suspended and removed rows of a three-row batch are skipped while the active recipient's row lands; anon and a suspended caller are refused. *(Corrected by the second review fix: this run also recorded "a row into another org is still refused by RLS". That held only when the row's recipient was an active member of that org — the trigger read the foreign org's membership and resources first and SKIPPED the row otherwise, so the two outcomes told a caller who belonged to another tenant. Since `b97e17c` the trigger refuses a caller who is not an active member of the row's org before it reads anything of that org — below.)* 60 of one notice land and the 61st is refused, 600 to one person land and the 601st is refused, and the same actor's row to someone else still lands. The service role's rows — another actor, an undeclared kind, an off-site link, a suspended recipient, over the cap — all land untouched. All 12 probes true, again on a second paste. The scratch cluster was deleted afterwards.

**Review fix, exercised on PostgreSQL 16 (`4762ad2`).** Reproduced first against the first pass's trigger: an active member's loop with a fresh random `resource_id` per row landed 600 rows in one victim's bell in a minute; one row to each of 4,000 members landed all 4,000; 700 copies of one notice dated `2001-01-01` all landed. After the fix, on a fresh database: the fresh-`resource_id` loop lands 60 and the 61st is refused; cycling all 51 kinds lands 600 and the 601st is refused; 1,100 rows from one actor earlier in the hour leave room for 100 more and the next is refused (the hourly cap), while the same actor's row to someone else lands; one row to each of 4,000 members lands 3,000 and the 3,001st is refused (the per-actor cap); back-dated and future-dated rows are stored dated now, and 70 back-dated copies of one notice land 60. Legitimate shapes land: `ack_requested` about 300 real documents to one assignee (300 of 300); 59 rows each about a real ticket, project and library; a one-statement sweep to 500 members plus a suspended and another org's member lands the 500 (0.1 s). Another org's document id and a non-UUID `resource_id` are not keys (60 land). The earlier rails still refuse (42501 / 22023 / RLS), and 3,500 service-role rows naming an over-cap actor, with an undeclared kind, an off-site link and a 2020 date, land untouched. 14 probes true; true again on a second paste, on an upgrade over the first pass's trigger, and after `20261161` (its 10 probes true). The 4,000-row loop with 1,000 refusals took about 7 s in all. The scratch cluster was deleted afterwards.
**Second review fix, exercised on PostgreSQL 16 (`b97e17c`).** On a throwaway cluster carrying `20260723`'s notifications SQL, with the first review fix's trigger (`1dece54`) in one database and the new one in another. **Reproduced first** on `1dece54`: (1) Alice, active only in org A, inserted a row into org B for Dave, who is active there — `new row violates row-level security policy`; the same insert naming a uid that is not in B returned without error (skipped); naming a document of B as the resource — RLS's refusal again. So the outcome told her who is an active member of another tenant. (2) Bob, an active member, inserted into his own bell a `checkout_released` row with `{"staleSessionId": …}`, and into a controller's bell rows with `{"staleHoldId": …, "staleFor": "age"}`, `{"reviewHealthDay": …}`, `{"ackEscalation": true}`, a `transmittal_unstampable` row with the transmittal and document the route's dedupe keys on, and a `storage_alert` row — all six landed, each one the row a server dedupe matches (`DELIV-13`). (3) 90 concurrent single-row inserts of one `checkout_message` about one document from one actor to one recipient, each transaction held open 300 ms: 90 landed against the 60 cap. **After the fix:** (1) all three of Alice's inserts are refused with `not a member of this workspace` (42501), whatever the recipient or resource; a suspended caller is refused the same way. (2) Each forged watermark row is refused (22023): "the metadata carries a dedupe watermark only the server writes" or "kind … is written only by the server". Browser rows that legitimately carry `ackRequest` (a re-nudge) and `autoReleasedSessionId` (the sweep) land, and the sweep's batch still skips its suspended holder. The service role's rows with each key and kind land untouched. (3) The same 90 concurrent inserts land 60 and refuse 30. While one actor's transaction held its lock, another actor's insert took 0.05 s, and the same actor's next insert waited for the first to commit. A one-statement sweep to 501 active members, with a suspended one in the same statement skipped, landed in 0.14 s. All 17 probes are true, again on a second paste; `20261161` pasted after it gives 10 of 10 true. The scratch cluster was deleted afterwards.
**Third review fix, exercised on PostgreSQL 16 (`05b1559`).** On a throwaway cluster carrying `20260723`'s notifications SQL, with the second review fix's trigger (`b97e17c`) in one database and the new one in another, through pgbench clients standing in for PostgREST's pooled connections. **Reproduced first** on `b97e17c`: a 600-recipient fan-out of single-row requests over 20 connections took 0.88 s, with 18 of the 20 connections waiting on the actor's lock; with the lock held by one of the actor's open transactions, a 100-recipient fan-out took 3.93 s, because every request waited for that transaction to commit; and a single far-from-cap row of the same actor waited 1.35 s behind it. **After the fix:** the 600-recipient fan-out takes 0.35 s with no connection waiting on the lock, and the 100-recipient fan-out completes in 0.13 s while the lock is held. A single far row holds no advisory lock (none in `pg_locks`). A two-row statement holds it; so does a row with 540 rows already sent to that person this minute; so does the same notice a second time; so do 1,140 rows this hour and 2,940 rows this minute from the actor. At the cap (1,200 this hour, 3,000 this minute, 600 this minute to one person) the row is refused in 0.05 s even while another of the actor's transactions holds the lock; another member's row lands meanwhile. The transaction-local mark persists past the definer function for the rest of the transaction and reverts after COMMIT and after ROLLBACK. Concurrency: one notice pressed 100 times over 20 connections lands 60, as before; 90 sessions at once, each holding its transaction open 0.3 s, land 90 (the second review fix's trigger landed 60). This is the stated trade-off: the burst is wider than the margin and no request saw another's uncommitted row. Through PostgREST a request commits in milliseconds and the pool is narrower than the margin. Twenty concurrent 40-row statements to one person, each row about its own document, land 600 of 800; with the later-row mark removed (a variant built for the comparison) they landed 800. Legitimate shapes still land: a bulk upload of 2,500 single-row requests over 20 connections (100 documents × 25 assignees) in 1.05 s (3.51 s on `b97e17c`), and a one-statement sweep to 500 members plus a suspended one lands the 500 (0.15 s). The earlier rails still refuse: an impersonated actor, an undeclared kind, an off-site link, a watermark key, a server-only kind, and a caller from another org. 3,500 service-role rows naming the actor, with a server-only kind, an off-site link and a 2020 date, land untouched. All 17 probes are true on a fresh paste, on a second paste, and on a paste over `b97e17c`'s trigger. The scratch cluster was deleted afterwards.
**N5 fix pass 4 (2026-10-02) — the lock claim corrected (`8fbb2a4`; DEC-29).** The final review found that `DEC-86`'s Risk line said "an ordinary fan-out never queues", and the migration's header said "ordinary traffic never takes it". Both were false. The lock is taken for a repeat notice: the same kind about the same resource (the kind alone when the resource is not a verified row), already sent to that person this minute. Every browser publish sends one to some recipients. `lib/postPublish.ts` `runPostPublishSideEffects` emits `doc_superseded` about the document to its live intent holders and followers (`notifySuperseded`). Its recall block then emits `doc_superseded` about the same document to every member holding an older downloaded copy (`lib/staleCopies.ts` `nudgeStaleHolders`). For a follower who holds an old copy, the second row is a repeat. Once the first row has committed — the usual order, since the recall's emit starts after three reads and `notifySuperseded`'s after one — that second row is counted again under the publisher's advisory lock. `notifyPackagesOfRevUp` and `notifyConnectedWork` (both `doc_superseded`, keyed on the document) do the same for a package owner or a connected drafter who also follows the document. **Exercised on PostgreSQL 16** (a throwaway cluster carrying `20260723`'s notifications SQL and `20261160` as on the branch; pgbench clients standing in for 20 pooled connections; a sampler reading `pg_stat_activity` for advisory-lock waits about every millisecond):
- **First notices.** `notifySuperseded`'s notice to 300 followers landed in 0.26 s, and no connection ever waited on the lock.
- **The publish's second notice.** The holders' notice to 60 people, 40 of them followers who already had the first, landed whole in 0.28 s. Up to 19 connections waited on the lock at once. Median latency was 55.7 ms and the worst 117 ms. The same 60 people receiving a first notice about another document took 0.16 s, at a median of 14.1 ms and a worst of 56 ms, and never waited.
- **Every holder a follower.** 300 repeat notices took 1.46 s, with the whole pool of 20 waiting; 300 first notices took 0.30 s. That is about 5 ms per locked insert, one after another.
- **Behind another lock holder.** While another of the actor's transactions held the lock for 3 s, a repeat notice waited 2.5 s for its commit. A first notice to a non-follower took 0.04 s, and so did another member's notice to the same follower.

So the wait is the actor's locked inserts ahead in the queue: about k × 5 ms for the last of k recipients who get both notices, with up to the pool's width of connections held meanwhile. Other members' requests wait for a connection, not for the lock. Nothing is refused: a repeat counts 1 toward that person's same-notice cap of 60. **Changed:** `DEC-86`'s Risk line now states this (`audit-reports/DECISIONS.md`). The migration header's sentence is corrected (comments only; all 17 probes are true on a re-paste over the branch's trigger). A model test pins which of a publish's rows take the lock. The two test titles that said an ordinary fan-out never queues are corrected. The scratch cluster was deleted afterwards.
- Files: `supabase/migrations/20261160_notif_roundG_write_rails.sql` (new); `lib/notificationKinds.ts` (a header comment: a kind added there needs the function re-created, from its newest definition, pasted before the deploy that writes the kind).
- Tests: `lib/__tests__/notificationWriteRails.test.ts` — the trigger's shape (definer, pinned, revoked, the NULL-uid return as its first statement, the rules in order, the caps and their index, bound BEFORE INSERT FOR EACH ROW), `notification_kinds()` against `KIND_META` (newest definition in the sequence, kind for kind and flag for flag), the paste's one-result-set shape and counts-only inventory, and a census of every `link:` a notification producer writes (TypeScript AST: each literal starts with one '/'). Review fix: the date stamp and the resource key in rule order, the four caps and their indexes, the verified resource types against `emit()`'s `ResourceType`, a model of the caps pinned to the SQL's numbers and keys (the review's fresh-`resource_id` loop → 60, every kind → 600, an hour-long loop → 1,200, 4,000 members → 3,000; an ack roster, a role broadcast, the sweep and a 2,500-row bulk upload land whole), and a census that no app insert into `notifications` sets `created_at` (TypeScript AST, insert arguments resolved). Second review fix: the caller's membership is checked first, before every other definer read (rule order, and the trigger body's first `FROM` after the service role's return); the advisory lock (one, transaction-scoped, after the skip and before both counts); the server-only kinds and watermark keys (see `DELIV-13`); and the `link` census now judges the shorthand `{ link }` through its declaration in scope and flags any initialiser it cannot resolve (8 shorthand producer sites judged; probe cases for both shapes). Third review fix: the lock test now pins the conditional shape (the transaction-local mark read before it is set, one lock call inside the loop, all four refusals before the loop's exit, the exit's margins); a model pinned to the SQL's exit condition shows an ack roster, a role broadcast and a 2,500-row bulk upload never take the lock, a later row of a statement, a repeat notice and a count within 64 of a cap do, and a count at its cap is refused without it; the same model reproduces the PostgreSQL 16 bounds below (60 of 100 through a pool of 20; 90 of 90 for 90 requests counted at one instant; a burst of 60, or of 65 from 535, stays within the cap; 20 concurrent 40-row statements land 600). Rule 1 now has a producer census, like the link and date rules: every browser `notify` / `notifyMany` / `notifyChecked` / `emit` call passes as `actorUserId` nothing, the signed-in member by name, or a parameter of its enclosing named function (31 pass-throughs, pinned), and every call of those functions one hop up passes nothing, the signed-in member or a pinned forward of its own caller's value (24 forwards, pinned) — never a stored uid. Mutation-checked: a caller handing `requestDeletion` the document's owner, `releaseHold` handing `notifyHoldChange` the hold's opener, a producer naming a stored uid, the lock taken for every row, the mark removed and the margin changed each fail it. `dcHotfixAnonExecute`, `searchPathPin`, `migrationSourceOfTruth`, `exportCoverage` and `notificationKinds` (no retired kind in any SQL file) pass. Fix pass 4: "fix pass 4: a browser publish takes the lock for each person who gets both supersede notices" (the model: 300 followers' first notices take none; the holders' notice to 60, 40 of them followers, takes it for the 40; the library notice, another kind, takes none); the lock-shape test's title and the pool-starvation regression's title no longer claim that an ordinary fan-out never queues; rule 1's census now resolves the signed-in member by its declaration (`DELIV-6`).
- Verified: loop on `fleet/N5-dispatch-rails` at `018caac`: `npx tsc --noEmit` exit 0; `npx eslint` on the six changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7914 passed, 4 expected-fail. Review fix at `4762ad2`: `npx tsc --noEmit` exit 0; `npx eslint lib/__tests__/notificationWriteRails.test.ts lib/notificationKinds.ts --max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7930 passed, 4 expected-fail. Second review fix at `b97e17c`: `npx tsc --noEmit` exit 0; `npx eslint lib/notify/dispatch.ts lib/__tests__/notificationWriteRails.test.ts lib/__tests__/notificationDispatchMembership.test.ts --max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7940 passed, 4 expected-fail. Third review fix at `05b1559`: `npx tsc --noEmit` exit 0; `npx eslint lib/__tests__/notificationWriteRails.test.ts lib/notificationKinds.ts --max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7948 passed, 4 expected-fail. Fix pass 4 at `8fbb2a4`: `npx tsc --noEmit` exit 0; `npx eslint lib/__tests__/notificationWriteRails.test.ts --max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7953 passed, 4 expected-fail. `next build` is the integrator's.
- **Pending migration:** `supabase/migrations/20261160_notif_roundG_write_rails.sql` — applied by hand (DEC-30), one paste, expect `ok = true` × 17; before `20261161`. Until it is applied the insert path is as open as before. The app reads nothing it adds, so either deploy order is safe; afterwards a refused browser row is logged by `notify()`, never thrown into a user flow.

**Done-when.**
- Not done here — a person-to-person nudge going through a server route that verifies the caller's relationship to the resource. No such nudge exists yet; it is N12's (GAP-206), which must build it as a server route. The plan makes this finding's database rail the nudge's prerequisite, and the rail is the backstop for every browser write, a future nudge included.
- Not done here — the route-level 429 modelled on `app/api/data-export/run/route.ts`, per (actor, recipient, resource): the nudge route's, N12's. Beneath it the database caps an (actor, recipient) pair at 60 of one notice (the resource counted only when it names a real row of its type in the org) and 600 of anything a minute and 1,200 an hour, and an actor at 3,000 a minute across everyone.
- ✓ Caller-supplied kinds outside the allowlist are rejected — at the database, for every browser write (`notification_kinds()`).
- ✓ A database trigger caps inserts per actor per interval — per actor across every recipient at 3,000 a minute, and per actor and recipient at 60 / 600 a minute and 1,200 an hour, every window counted on rows the trigger dates itself, without a lock far from a cap and one insert at a time per actor near one. (Corrected by the review fix: the first pass ticked this item with caps per actor and recipient only, a 60 keyed on a caller-written `resource_id`, and no ceiling across recipients. Corrected again by the second review fix: the caps held only for requests that arrived one after another — concurrent requests from one actor each counted the same committed baseline, 90 landing against the 60 on PostgreSQL 16 — until the actor-keyed advisory lock. Revised by the third review fix: taken for every row, that lock ran one member's fan-out one insert at a time and could hold the API's whole connection pool. It is now taken only near a cap or for a later row of one transaction. Through a pool of 20 connections one notice still lands 60 of 100, but a burst counted at one instant can pass a cap by what it holds beyond the margin: 90 direct sessions held open landed 90.)

**Scope / residual.**
- Of the eleven raw inserts in files other packages own (`DEC-81` §5's ratchet), ten run on the service role and pass the rail untouched by design. The eleventh, `lib/projects.ts` `autoReleaseExpiredAdHoc`, also runs in the browser (the page sweep) and meets the rail there: its rows carry a declared kind and an app-relative link, the trigger stamps the sweeping member as their actor, and a holder who is no longer an active member is skipped while the rest of the batch lands (exercised).
- `actor_name` stays the producer's text: the browser's checkout sweep writes 'System' rows legitimately, and those rows now carry the member whose browser ran the sweep. The mark a member cannot forge is `actor_user_id IS NULL` — a server row.
- The bell's off-origin-link rendering guard (for rows written before the paste; the inventory counts them) is the bell's owner's (N3).
- What the caps still allow: one member can reach any one colleague 1,200 times an hour (60 of one notice a minute) and the org 3,000 times a minute. The harassment ceiling per victim is now an hour's 1,200 rows from one sender, not 36,000; a lower one is the nudge route's (N12), which owns the person-to-person poke.
- A multi-document operation under a wide acknowledgment policy — a bulk upload, a library-wide policy change (`setAckPolicy` recomputes every Issued document) — can meet the hourly or the per-actor cap. And a burst of publishes in ONE library can meet the same-notice cap (second review): each browser publish (`lib/revisions.ts` → `runPostPublishSideEffects` → `lib/postPublish.ts`) writes a `library_doc_revised` row to every library follower keyed on the LIBRARY — a verified resource — so the 61st revision published in one library within a minute from one browser reaches no follower's bell (refused, logged); the `doc_superseded` notice to the intent holders and followers is keyed on the document and is unaffected. Past it the bell copies are refused and logged by `notify()`; the obligation is not: the roster row stands, the inbox lists it (`lib/inbox.ts` `listMyPendingAcks`), and the cron re-nudges after its cooldown. Each cap is one number (`DEC-86` Reversal), to be weighed against the paste's inventory (the busiest minute and hour any actor wrote).
- Resource types other than the four never key the same-notice cap; a producer of one (an asset, a transmittal, a work package) that legitimately sent more than 60 of one kind to one person a minute would meet it — none does today.
- Under concurrency (third review fix): requests from one member that arrive one after another are counted exactly, and so is every later row of a multi-row statement. A burst of single-row requests counted at the same instant can pass a cap by at most one row per request still in flight. That is fewer than the API pool's width, and nothing for a burst of up to 60 that commits as it lands. This is the price of not queueing every insert of one member on a pooled connection. A member who keeps a cap within its margin can still hold up to a pool's width of connections on the lock for a few milliseconds each; a refusal never waits. *(Corrected at fix pass 4: ordinary traffic takes the lock too. Every browser publish takes it for each person who gets both supersede notices (`notifySuperseded`'s and `nudgeStaleHolders`'), one after another: about 5 ms each on PostgreSQL 16, up to the pool's width of connections waiting. See the fix pass 4 block above.)*
- Within the caller's OWN org the resource key's verification still answers one bit: whether a UUID the caller already holds names a row of that type there — observable only by first spending 60 same-kind rows on one recipient in the minute. Existence only, never content; UUIDs are not guessable.

---

<a id="os-2"></a>

## OS-2 · Web Push is a decapitated stack: the service-worker receiver, the DB table, and the preference column all survive, but every subscriber and sender was deleted

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:225-260`, `supabase/migrations/20260804_push_subscriptions.sql:7-35`, `supabase/schema.sql:659`, `commit 0bb13ed (Remove fake AI stack, scratchpad system, MPP machinery, and dead code (#97))`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The factual core is verified. Two corrections: (a) 'every subscriber and sender was deleted' is unverifiable — the repo is a single squashed commit (`git log -- public/sw.js` returns one commit, abdee9b), so the evidence supports 'never present in this tree', not 'deleted'; (b) this is the same defect as DELIV-14, which the same audit set rates MEDIUM — a wholly-absent feature with a misleading skeleton is a discoverability/wasted-work cost, not a HIGH-severity failure, so MEDIUM is the consistent grade.

**Mechanism.** Commit 1200498 shipped Web Push end-to-end: app/api/push/subscribe/route.ts, app/api/push/unsubscribe/route.ts, app/api/reminders/run/route.ts, components/pwa/PushReminders.tsx, lib/push.ts, lib/reminders.ts, the push_subscriptions migration, and the sw.js push+notificationclick handlers. Commit 0bb13ed then deleted every TypeScript file in that set (and lib/notify/push.ts) as part of the scratchpad removal, plus the web-push dependency and the reminders cron entry in vercel.json. What was NOT deleted: the service worker's push handler, the migration, and notification_preferences.push_enabled. The result is a receiver with no transmitter — the browser would render an OS notification correctly if one ever arrived, but nothing in the codebase can create a PushSubscription and nothing can send to one.

**Failure scenario.** The owner asks 'why don't I get phone notifications, the service worker has a push handler?' — a developer greps public/sw.js, finds a complete and well-commented push implementation plus a push_subscriptions table with RLS, and reasonably concludes push works and is merely misconfigured. They hunt for missing VAPID env vars that were never referenced by any surviving file. No amount of configuration will produce a notification, because no code path ever calls registration.pushManager.subscribe() and no code path ever POSTs to a push service.

**Evidence.**

```
public/sw.js:225 —
  self.addEventListener("push", (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
    const title = data.title || "Manufacturing OS";
    ...
    event.waitUntil(self.registration.showNotification(title, options));
  });

But `grep -rniE "applicationserverkey|urlbase64|getsubscription|vapid|pushManager" --include=*.ts --include=*.tsx --include=*.js --include=*.json --include=*.example .` (excluding node_modules/.next) returns ZERO matches, and `grep -rni "requestPermission|Notification.permission|PushManager"` over **/*.{ts,tsx,js} returns exactly one line — public/sw.js:238's showNotification. package.json has no web-push dependency; .env.example has no VAPID entries.
```

> **Verifier correction.** Severity CRITICAL is overstated. This is dead residue of a DELIBERATE removal, not an accident or an active defect — 0bb13ed's own commit message says the push stack was removed on purpose because "a push toggle with no sender is a fake feature." Nothing malfunctions, no data is at risk, no user-visible surface breaks; a browser that never receives a push simply never fires the handler. The real content is that a Web Push build starts from a receiver plus a table plus a column and must rebuild the entire transmitter — that is HIGH-value planning information, not a CRITICAL defect.

**Done when.**

- [ ] A client surface calls navigator.serviceWorker.ready → registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey}) and POSTs the endpoint/p256dh/auth to a route that inserts into push_subscriptions
- [ ] A server module signs and sends VAPID-authenticated payloads (web-push re-added, VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT documented in .env.example)
- [ ] lib/notify/dispatch.ts's emit() fans out to that sender as a third channel
- [ ] 410/404 responses from the push service delete the dead subscription row
- [ ] If push is NOT being rebuilt: public/sw.js's push+notificationclick handlers, supabase/migrations/20260804_push_subscriptions.sql, the schemaExpectations entry, and notification_preferences.push_enabled are all removed together

**Resolution (2026-10-14, notifications Round G).** Package N10 PUSH, branch `fleet/N10-push` (base `ce5a053`), commits `3f53779` (`web-push` 3.6.7), `b3358d9` (the channel) and `669afad` (no push for a registration older than the opt-in control). The BUILD arm of the fork (the owner asked for OS presence — the plan's `dependsOn`). The integrator's three rulings under `DEC-90` are built as ruled (recorded in `DEC-90` and `DEC-44 (N10-push)`).
**Reproduced first** on `ce5a053`: the receiver was `public/sw.js:657-690`; `lib/notify/dispatch.ts:24` typed `NotifChannel = "inapp" | "email"` and `emit()` defaulted to those two (`:329`); a repo-wide search of `app/`, `lib/`, `components/` and `hooks/` for `pushManager`, `requestPermission`, `applicationServerKey`, `sendNotification`, `web-push` and `VAPID` found nothing; `package.json` had no `web-push`; `.env.example` had no VAPID entry; `push_subscriptions` was named only by `lib/schemaExpectations.ts:161`, `lib/exportTables.ts:319` and `lib/dataRestore.ts:160`.

**What landed.**
- Subscribe: `components/settings/PushOptIn.tsx` (mounted on `/settings/notifications`) waits for `navigator.serviceWorker.ready`, then calls `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` (`:258`). It does this only after the person's click and the browser's permission. It POSTs the endpoint, p256dh and auth to `app/api/push/subscribe/route.ts`, which stores the caller's own `push_subscriptions` row. Only an active member of the workspace may store one, and only an endpoint on a browser push service's host (fix pass, below). An endpoint belongs to one browser, so a previous person's row for it is handed over — only when the caller presents the same keys (fix pass). Before `20260804` is applied the route answers 503 and names the migration. `app/api/push/unsubscribe/route.ts` removes the caller's own row.
- Sender: `lib/push/sendPush.ts` `sendPushSafe` (`:235`), on `web-push` 3.6.7 (an exact version; `package-lock.json` regenerated by `npm install`). `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are documented in `.env.example` beside `CRON_SECRET`, whose stale `reminders/run` line is corrected. Without the keys the channel is OFF and logs it once (`pushConfig`, `:148`): every deployment that works today works the same.
- `emit()`'s third channel: see `OS-9`. `app/api/push/notify/route.ts` is the browser half of that leg, because most producers run `emit()` in the browser.
- 404 / 410: the subscription row is deleted (`sendPush.ts:398`, a checked write). The maintenance cron's step 7c removes the rows of people with no active membership left, and (fix pass) rows naming no push service (`app/api/cron/maintenance/route.ts:568`, `prunePushSubscriptions` `:728`). No cron entry is added.
- Tests: `lib/__tests__/pushChannel.test.ts`, `lib/__tests__/pushOptIn.test.ts`, `lib/__tests__/sw.test.ts` (the push / notificationclick block — comment-only change, no `SW_SCHEMA` bump) and `lib/__tests__/maintenanceDrain.test.ts` (step 7c).
- Verified (loop on `fleet/N10-push` at `669afad`, 2026-10-14): `npx tsc --noEmit` exit 0; `npx eslint` on the changed files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` in four shards (`--shard=N/4`), each exit 0 — 568 files, 12532 passed, 8 expected fail. `next build` is the integrator's.

**Done-when.**
- ✓ A client surface calls `navigator.serviceWorker.ready` → `registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey})` and POSTs endpoint/p256dh/auth to a route that inserts into `push_subscriptions` (`PushOptIn.tsx`, `/api/push/subscribe`; `pushOptIn.test.ts` "acceptance 1", `pushChannel.test.ts` "POST stores the caller's device").
- ✓ A server module signs and sends VAPID-authenticated payloads (`lib/push/sendPush.ts`; `web-push` 3.6.7 in `package.json`; the three variables in `.env.example`).
- ✓ `lib/notify/dispatch.ts`'s `emit()` fans out to that sender as a third channel (`dispatch.ts:498-507`; `OS-9`).
- ✓ 410/404 responses from the push service delete the dead subscription row (`pushChannel.test.ts` "acceptance 3 / OS-2 done-when 4").
- Not applicable: the removal arm ("If push is NOT being rebuilt …") — push was rebuilt.

**Scope / residual.**
- Push reaches only producers that write through `emit()`: a force-released checkout, a hold placed, an acknowledgment request from the distribution panel, and a change proposed at check-in (`review_requested` to the owner). These are not pushed, because their bell rows are written outside `emit()`: the ticket routes' mentions and assignments, and the read-&-understood and sign-off rosters' own requests. New finding `OS-14` (below).
- After its person signs out, a shared browser stays subscribed for them. New finding `OS-15` (below).
- The `20260804` migration's header still says "The reminder cron (service role) reads every row". A migration is never edited. The sender's header and the service worker's comment name the real sender.
- ~~No migration. Deploy only; set the three VAPID variables to switch the channel on.~~ Fix pass: one migration, `20261211` (below). Set the three VAPID variables to switch the channel on.

**Fix pass (2026-10-14, notifications Round G — the review of N10).** The review found that the server would POST to any stored endpoint. `web-push` calls `https.request` on whatever host, port and path the URL names. The subscribe route checked only `https:`, and `20260804`'s `push_sub_insert_own` let any member insert their own rows through PostgREST, with any endpoint text and no cap on how many. That made a blind SSRF and amplification path, and an oracle: the notify route awaited every send, and a member could read their own rows afterwards. Landed:
- `lib/push/endpoints.ts` (new) `pushEndpointAllowed` (`:62`). It accepts only an https URL on a browser push service's host: `fcm.googleapis.com`, `updates.push.services.mozilla.com` / `*.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com` / `*.push.apple.com`. The port must be the default and the URL must carry no user-info. `PUSH_DEVICE_CAP` = 10. *(Corrected at fix pass 2, below: as written here, the check read the host with the WHATWG parser only, while `web-push` connects by Node's legacy `url.parse`. The two read some strings differently — `https://10.0.3.7;.push.apple.com/x` passed the check and `web-push` addressed `10.0.3.7`. "Only a push service's host" did not hold until fix pass 2.)*
- Checked at subscribe: `app/api/push/subscribe/route.ts:82` answers 400 "That is not a browser push subscription."
- Checked again just before every send: `lib/push/sendPush.ts:346`. A row that fails the check is never sent to, and it is deleted.
- The cron's step 7c removes any such row (`app/api/cron/maintenance/route.ts:748`).
- The sender reads at most the 10 newest devices per person (`:314-349`). The subscribe route removes a person's oldest registration once they pass 10 (`keepNewestDevices`, `:142`). *(Corrected at fix pass 2: the cap was applied after a 50-person read limited to 1,000 rows, so one person holding 1,000 rows left the other 49 in the read unpushed; fixed below.)*
- `POST /api/push/notify` answers once the caller is known to be a member. The sends run after the response (`next/server` `after()`, `app/api/push/notify/route.ts:68`), so the answer's timing says nothing about the push services.
- `supabase/migrations/20261211_notif_roundG_push_subscriptions_writer.sql` drops `push_sub_insert_own`, so the service-role route is the table's only writer. It follows the DEC-30 one-paste shape: a counts-only TEMP inventory before BEGIN, a single DROP POLICY, COMMIT, and one final (check, ok, n) SELECT returning 4 probes and 5 counts. It was exercised on PostgreSQL 16. Before the paste, a member's own-row insert naming `https://10.0.3.7:8443/…` landed. After it, the insert is refused (42501), the member still reads and deletes only their own rows, and the service role still inserts and hands a row over. The re-run answers the same.
- The app never inserts a device row as a signed-in member, so it works the same before and after the paste.
- Tests: `pushChannel.test.ts` "blocker: …" (off-service rows never sent and deleted; `pushEndpointAllowed`; the device cap at send and at subscribe; subscribe refuses off-service endpoints; the notify route answers before the sends); `maintenanceDrain.test.ts` (step 7c prunes off-service rows); `lib/__tests__/notifRoundGPushWriterMigration.test.ts` (new: the migration's shape, the newest definer found by scanning, the inventory's host list equal to the app's).
- **Pending migration:** `20261211_notif_roundG_push_subscriptions_writer.sql` (DEC-30). Until it is pasted, a member can still insert their own row by hand. The deployed sender refuses and deletes any such row that names no push service, and it reads no more than 10 per person, so the row can no longer make the server call an address of the member's choosing. *(That last clause holds from fix pass 2 on, which closed the parser gap; as first written it overstated.)*
- Verified (loop on `fleet/N10-push` after the fix pass, 2026-10-14): see `OS-9`'s fix-pass block.

**Fix pass 2 (2026-10-14, notifications Round G — the second review of N10).** The second review found the fix pass's allow-list could be bypassed. `pushEndpointAllowed` read the host with the WHATWG parser (`new URL`), but `web-push` 3.6.7 picks the host it connects to, and the VAPID audience, with Node's legacy `url.parse` (`node_modules/web-push/src/web-push-lib.js:348-350` and `:274`). For a host holding a character that WHATWG accepts and `url.parse` stops at (`;`, `{`, `}`, `'`, backtick, `"`), the two disagree. `https://10.0.3.7;.push.apple.com/x` ends in an allowed suffix to WHATWG and is the host `10.0.3.7` to `url.parse`. Such a row was stored, sent to and never pruned, and the row-state oracle came back. Reproduced on the branch at `cc6a4ac` with Node 22 and the installed `web-push`: the review's probe, and the new real-`web-push` test below, which fails against the old check. Landed:
- `lib/push/endpoints.ts` `pushEndpointAllowed` (`:112`) accepts only a string that both parsers must read the same way:
  - printable ASCII only;
  - the raw text, lower-cased, is exactly `https://` + host + `/` or `?`. No user-info, no port (not even `:443`), and no percent-encoded or backslashed host;
  - the host is plain LDH labels and a push service's host (`pushHostAllowed`, `:101`);
  - `new URL(v)` and `url.parse(v)` both give that host, with no port and no user-info.

  The same function still guards the subscribe route (`route.ts:85`), the check before each send (`sendPush.ts:380`) and the cron prune (`maintenance/route.ts:760`).
- Defence in depth at the send. The sender passes `web-push` `agent: pushServiceAgent()` (`sendPush.ts:407`; `endpoints.ts` `PushServiceAgent`, `:192`).
  - The agent's `createConnection` refuses any host that is not a push service's, and any port but 443. It checks the host the request was actually addressed to, whatever parser produced it, and an IP literal never passes.
  - Its `lookup` (`pushPublicLookup`, `:175`; `pushAddressPublic`, `:165`) refuses a DNS answer that holds any loopback, private, link-local, CGNAT, multicast, documentation, IPv4-mapped or other reserved address.
- `lib/push/endpoints.ts` now imports Node built-ins, so it is server-only. `PUSH_KEYS_MISMATCH` moved to `lib/notify/dispatch.ts` (`:556`), which the card, a browser module, already imports. A census pins that no browser module imports `lib/push/endpoints` or `lib/push/sendPush`.
- The review's minor: one member's rows could starve a read. When the sender's device read comes back at PostgREST's 1,000-row limit, the sender reads that part again person by person, `PUSH_DEVICE_CAP` rows each (`sendPush.ts:346`, `:364`). A row dated later than now plus `PUSH_FUTURE_SKEW_MS` (5 min, `endpoints.ts:91`) is not read.
- The cron's step 7c removes those future-dated rows, and each person's rows past their newest 10 (`trimDevicesPastCap`, `maintenance/route.ts:792`). The trim orders newest first by `created_at` then `id`, and deletes only rows no newer than the cap's boundary row, so it never takes a row the route re-stamps in the meantime.
- Tests. Each new test failed against the code before this pass.
  - `pushChannel.test.ts`:
    - "pushEndpointAllowed: …": each of the eight characters, in five host shapes, expected false; `:443`; no path; whitespace, tab, percent and backslash hosts.
    - "fix pass 2: every endpoint pushEndpointAllowed accepts is one the REAL web-push (https.request stubbed) addresses to a push service's host …": over a thousand candidate strings, and the review's three are refused.
    - "fix pass 2 (defence in depth): every send goes through pushServiceAgent() …" and "… the agent's lookup refuses …".
    - "fix pass 2: one person holding 1,200 registrations never costs a neighbour …" and "fix pass 2: a registration dated in the future is not read …".
    - The server-only census.
  - `maintenanceDrain.test.ts`: "fix pass 2: a registration dated in the future is removed …" and "fix pass 2: a person keeps only their newest PUSH_DEVICE_CAP (10) registrations …".
- `20261211` is unchanged. Its row-2 inventory pattern is slightly looser than the app's check: it allows `#` or the end of the string after the host, and runs of dots in a label. The app is the authority, as the row's label says.
- Verified (loop on `fleet/N10-push` after fix pass 2, 2026-10-14): `npx tsc --noEmit` exit 0; `npx eslint` on the 10 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` in four shards (`--shard=N/4`), each exit 0 — 569 files, 12566 passed, 8 expected fail (12574). `next build` is the integrator's.

---

<a id="os-3"></a>

## OS-3 · No permission prompt exists anywhere, and ServiceWorkerManager — the natural mount point — deliberately never touches the Notification API

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/pwa/ServiceWorkerManager.tsx:30-52`, `app/layout.tsx:93`, `app/(protected)/layout.tsx:60-73`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified, including the load-bearing part — the mount point really is the unauthenticated root layout, so the naive build would prompt anonymous visitors. Only editorial quibble: 'deliberately' is unsupported by any comment in the file; the API is simply absent, not documented as excluded.

**Mechanism.** ServiceWorkerManager registers /sw.js on window load and tracks the waiting worker for the update pill. It never reads Notification.permission and never calls requestPermission(). It is mounted in the ROOT layout (app/layout.tsx:93), outside the auth gate — so it runs on public pages including the login page at app/page.tsx. That placement is correct for SW registration and exactly wrong for a permission prompt: prompting from there would fire on first load for an anonymous visitor, which browsers penalize (Chrome's abusive-permission-request heuristics can permanently block the origin's prompt, and Firefox requires a user gesture outright).

**Failure scenario.** The obvious build — 'add requestPermission() where the service worker is already registered' — prompts every anonymous visitor on the marketing/login page before they have any reason to say yes. Most click Block. A blocked origin cannot re-prompt; the only recovery is the user manually editing site settings, which no plant worker will do. One shipped line permanently forecloses OS notifications for the majority of the workforce.

**Evidence.**

```
components/pwa/ServiceWorkerManager.tsx:30 (registration only — no Notification API) —
    if ("serviceWorker" in navigator) {
      const onLoad = () => {
        navigator.serviceWorker
          .register("/sw.js")

app/layout.tsx:93 (mounted OUTSIDE the auth gate, in the root layout) —
        <ThemeProvider>{children}</ThemeProvider>
        <ServiceWorkerManager />

Repo-wide, `grep -rni "requestPermission|Notification.permission|showNotification|PushManager|pushManager"` over **/*.{ts,tsx,js} returns ONE line: public/sw.js:238.
```

> **Verifier correction.** Downgrade the reasoning, not the facts. The clause about Chrome's abusive-permission heuristics and Firefox's gesture requirement is external browser knowledge, not readable from this repo, and no permission prompt exists to be mis-placed — nothing currently misbehaves. What is CONFIRMED is the absence (no Notification API call anywhere) and the mount point (root layout, outside the auth gate); the "exactly wrong place to prompt" conclusion is forward-looking design advice.

**Done when.**

- [ ] The permission prompt is triggered only by an explicit user gesture on an authenticated surface — a 'Turn on notifications for this device' control on /settings/notifications, or a one-time in-app pre-prompt card the user opts into
- [ ] No requestPermission() call sits in app/layout.tsx's subtree above the auth gate
- [ ] The pre-prompt explains what will be sent BEFORE the browser dialog appears, and a decline is recorded so the app stops asking
- [ ] Notification.permission === 'denied' renders an explanatory state rather than a dead toggle

**Resolution (2026-10-14, notifications Round G).** Package N10 PUSH, branch `fleet/N10-push` (base `ce5a053`), commits `3f53779` (`web-push` 3.6.7), `b3358d9` (the channel) and `669afad` (no push for a registration older than the opt-in control).
**Reproduced first** on `ce5a053`: `components/pwa/ServiceWorkerManager.tsx` registers `/sw.js` and never touches the Notification API. It is mounted in the root layout (`app/layout.tsx`), outside the auth gate. No `requestPermission` existed in `app/`, `lib/`, `components/` or `hooks/`.

**What landed.** `components/settings/PushOptIn.tsx` holds the only `Notification.requestPermission()` call in the tree (`:229`). The call runs inside the "Allow notifications" click, and that button appears only after the person clicks "Turn on notifications for this device". That first click opens a panel listing what will be sent (`PUSH_WHAT_IS_SENT`). The panel also says that the notification names nothing (`PUSH_PRIVACY_NOTE`) and that the browser will ask next.
- Fix pass (the review's major 3): the first pass listed one line per push-worthy kind, including "A mention on a request" and "A request assigned to you". No producer pushes those two (`OS-14`), and the acknowledgment and sign-off lines were broader than what is pushed. The list is now `PUSH_SENT_TODAY` (`:71`): one line per push-worthy kind whose producer reaches `emit()`'s push leg, worded for exactly that producer.
  - "A hold placed on a document you work on or follow".
  - "Your checkout released by someone else".
  - "A request, from a document's distribution list, to confirm you have its current revision".
  - "A change proposed at check-in to a document you own, waiting for your review".
- Under the list, `PUSH_NOT_YET_NOTE` (`:83`) says what is not sent to devices yet: mentions and assignments on requests, read-and-understood requests, and sign-off requests from a review roster. It adds that the bell and email still bring them.
- A test splits the push-worthy set exactly into `PUSH_SENT_TODAY` and `PUSH_NOT_SENT_YET`. It checks from source that every listed kind has an `emit()` producer and that every "not yet" kind has none, so when `OS-14` lands the test fails until the line moves.
- Fix pass 2 (the second review's minor): "has an `emit()` producer" was not enough, because only a browser emit pushes. A server emit pushes only with `serverPush`, and no server caller passes it; `hold_opened` is also emitted by the cron's `scanStaleHolds`, which never pushes. A second test now pins each listed kind to its producer, to the function its `emit()` sits in, and to the browser (`"use client"`) modules that import and call it:
  - `hold_opened`: `lib/holds.ts` `notifyHoldChange`, reached from `openHold`, which `HoldStrip` and `CheckInPanel` call;
  - `checkout_force_released`: `lib/checkoutEpisodes.ts` `forceReleaseDocument`, called from `CheckoutStatusCell` and the library page;
  - `ack_requested`: `lib/distributionAcks.ts` `requestAcks`, called from `DistributionAcks` and `DistributionRecall`;
  - `review_requested`: `CheckInPanel` itself.

  A producer moved behind a server route fails it (`pushOptIn.test.ts` "fix pass 2: each kind the card says is pushed today is emitted by a producer that browser modules call …").
- "Not now", or a dismissed browser dialog, is recorded with `hooks/useDismissed` (`PUSH_DECLINE_KEY`, scope `<uid>:<orgId>`). That is the house "dismissal that sticks": already in `components/providers/RoleContext.tsx`'s storage inventory and swept on sign-out. The card then says "The app will not ask again". The button stays, for a deliberate change of mind.
- When `Notification.permission === 'denied'`, the card shows `PUSH_DENIED_TEXT` (how to unblock the site in the browser's settings) and no button.
- A browser without push shows a sentence instead of a dead control, and names the iPhone / iPad Home Screen step.
- The card is mounted only on `/settings/notifications`, which is protected. `ServiceWorkerManager` is unchanged.
- Verified (loop on `fleet/N10-push` at `669afad`, 2026-10-14): `npx tsc --noEmit` exit 0; `npx eslint` on the changed files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` in four shards (`--shard=N/4`), each exit 0 — 568 files, 12532 passed, 8 expected fail. `next build` is the integrator's.

**Done-when.**
- ✓ The permission prompt is triggered only by an explicit user gesture on an authenticated surface: the "Turn on notifications for this device" control on `/settings/notifications` (`pushOptIn.test.ts` "on load nothing asks").
- ✓ No `requestPermission()` call sits in `app/layout.tsx`'s subtree above the auth gate (`pushChannel.test.ts`: a census over `app/`, `components/`, `lib/`, `hooks/` finds one caller, `PushOptIn.tsx`; `app/layout.tsx` and `ServiceWorkerManager.tsx` have none).
- ✓ The pre-prompt explains what will be sent BEFORE the browser dialog appears, and a decline is recorded so the app stops asking (`pushOptIn.test.ts` "the first click explains …", "major 3: the card's two lists split the push-worthy set exactly …", "fix pass 2: each kind the card says is pushed today is emitted by a producer that browser modules call …", "'Not now' is recorded …", "the browser's dialog answered Block …"). The fix pass corrected the first pass, which overstated this: its list promised request mentions and assignments, which are never pushed. The list now names only what is pushed today, and says what is not. Pushing the `OS-14` producers, and moving their lines onto the list, is `OS-14`'s.
- ✓ `Notification.permission === 'denied'` renders an explanatory state rather than a dead toggle (`pushOptIn.test.ts` "dw4").

**Scope / residual.** The decline is recorded per account, per workspace and per browser (useDismissed's scope), and sign-out clears it, as it clears every dismissal. Nothing in the app asks unprompted, so the record governs only the card's invitation. A later in-app invitation (the login nudge, notifications N12) reads `PUSH_DECLINE_KEY`. Fix pass (a review minor): when registration fails, the card takes back only a subscription its own click made (`made`, `:257`), never one that was already in the browser, which on a shared PC may be another person's working registration. A `409 keys_mismatch` from the server (the endpoint is stored under other keys) starts one fresh subscription (`:273`).

---

<a id="os-4"></a>

## OS-4 · NotificationListener toasts on every incoming notification row with no batching or cap — a nudge burst becomes a toast burst

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/providers/NotificationListener.tsx:78-96`, `components/providers/ToastProvider.tsx:39-49`, `components/ui/CornerDock.tsx:22-27`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed with no mitigating guard anywhere: N inserts within 6s produce N simultaneously-mounted toast cards. The 6-second figure in the claim is exact (duration: 6000 at NotificationListener.tsx:96).

**Mechanism.** NotificationListener subscribes to postgres_changes INSERT on notifications filtered to the recipient's uid and calls showToast() for each row with duration 6000. ToastProvider appends unconditionally to a toasts array with no cap. The array renders into CornerPortal, which stacks into the fixed bottom-right dock — the dock is `flex flex-col items-end gap-2` with no max-height and no overflow handling. Ten notifications inserted in a minute produce ten simultaneously-visible stacked toasts, since 6s duration exceeds the arrival interval.

**Failure scenario.** Combined with the unlimited-insert RLS policy and the refresh-defeated nudge guard above, one impatient colleague clicking a poke button repeatedly fills the recipient's screen bottom-to-top with stacked toast cards that outrun the 6-second expiry, obscuring the page they are working on. The same happens innocently when a bulk operation (a publish fan-out, a distribution ack request to many docs) lands.

**Evidence.**

```
components/providers/NotificationListener.tsx:84 —
          const row = payload.new as { id: string; kind: string; title: string; body: string | null };
          if (seenNotifIds.has(row.id)) return;
          seenNotifIds.add(row.id);
          ...
          showToast({
            type: isError ? "warning" : isMention ? "info" : "info",
            title: row.title,
            message: row.body ?? "",
            duration: 6000,
          });

components/providers/ToastProvider.tsx:41 (no cap) —
    setToasts((prev) => [...prev, { id, type, title, message, duration }]);

components/ui/CornerDock.tsx:24 (no max-height / overflow) —
      className="fixed bottom-4 right-4 z-[300] flex flex-col items-end gap-2 pointer-events-none max-w-[calc(100vw-2rem)]"
```

> **Verifier correction.** "Ten simultaneously-visible stacked toasts" is an inference from duration versus arrival rate, not something anyone observed — nobody ran this app. The code-level claims (per-row toast, no cap, no batching, no dock overflow handling) are what is CONFIRMED.

**Done when.**

- [ ] ToastProvider caps concurrent toasts (oldest evicted, or collapsed into an 'N more' summary card)
- [ ] Bursts from the same actor/resource within a short window coalesce into one toast
- [ ] The CornerDock has a max-height and does not grow past the viewport

**Partial (2026-10-01, notifications Round G).** Reproduced: Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase). Ten identical nudges rendered ten simultaneous cards on the base tree, in a dock with no height bound (see STACK-9). Now ToastProvider caps the visible toasts within the dock's shared cap of 4, collapsing the rest into the dock's "+N more" card. The card carries the notification center's doorway at rest. While the dock is raised over a modal that started an upload, the doorway is withheld, because the center would open under that modal (`RT-11`; qualified 2026-10-02). A burst of the same message within 10 seconds coalesces into one card with a count (the "×10" card in Chromium and in jsdom). The dock is height-bounded and scrolls (details under RT-11 and STACK-9). Tests: `lib/__tests__/cornerDock.test.ts` "ten identical toasts within the window are one card with a count", "40 upload events…", "hidden messages offer the notification center…".

**Done-when.**
- ✓ ToastProvider caps concurrent toasts: the excess collapses into a "+N more" summary card, raised or at rest. This item asks for the collapse, not the doorway, so the raised dock's withheld doorway (`RT-11` done-when 1) leaves it met (re-checked 2026-10-02).
- Partial, NOT met as written. A burst of the same message (same type, title and body) within 10 seconds coalesces into one card with a count; a burst from the same actor and resource worded differently does not yet, because `components/providers/NotificationListener.tsx` (N3's file this round) passes no `coalesceKey`. Remaining step: N3 passes `` coalesceKey: `${row.kind}:${row.resource_id}` `` (hand-off in `99-fix-sequencing.md`).
- ✓ The CornerDock has a max-height and does not grow past the viewport.

**Scope / residual.** Stays OPEN on dw2 until N3's one line lands. The rate of nudges itself (OS-1 / GAP-206) is not this finding's. No migration.

**Resolution (2026-10-02, notifications Round G).** Done-when 2 — the remainder N7 handed to N3 — landed in package N3 SURFACES: `components/providers/NotificationListener.tsx` `toastForRow` passes `` coalesceKey: `${row.kind}:${row.resource_id}:${row.actor_user_id ?? ""}` `` for every notification row with a resource, so rows about one event coalesce into N7's one-card-with-a-count even when worded differently (the card keeps the first row's words — a trade-off recorded in `DEC-94` item 4 and handed to `ToastProvider`'s next holder) — *superseded at the third review fix (below): the key is now kind + resource + words (`notificationCoalesceKey`, `NotificationListener.tsx:94`), and differently worded rows are no longer merged;* and a burst of rows is capped at two cards plus one "N more notifications" summary per 6 s window (`TAX-9`). *Second review fix (2026-10-02):* the actor joined the key — under kind + resource alone, two people's acts on one resource merged into a card naming only the first ("Bob signed off on P-1 ×2" for Bob's and Carol's sign-offs) — and a repeat of an event already on screen in the window now joins its card instead of being held for the summary (`route` :223), so a nudge burst about one thing from one person is one card ×N. Before this, the first record's "coalesce into one toast" was overstated: rows 3 and on of one event were held and came back as a separate "N more notifications" card. Reproduced on `7c27b0c`: no key was passed (`NotificationListener.tsx:92-97`). Tests: `lib/__tests__/notificationListenerToasts.test.ts` "the same row twice (same kind, resource and words) is one card with a count" (it replaced "two rows about one event…, worded differently, are one card" at the third review fix), "a nudge burst about one thing from one person is one card with a count — no summary card after the window", "two people on one resource are two cards…"; `lib/__tests__/notificationListener.test.ts` "40 rows in a burst…", "a burst of one statement (same kind, resource and words) is one card…". Verified after the second review fix: `npx tsc --noEmit` exit 0; `npx eslint` on the 19 changed code and test files of the branch `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 407 files, 8516 passed, 7 expected-fail (an earlier full run under machine load timed out two unrelated fuzz tests at the 5 s default and one first-frame timing test of N7's; each passed alone and the rerun was clean). Verified: loop on `fleet/N3-surfaces` at `bac49dc`: `npx tsc --noEmit` exit 0; `npx eslint` on the 16 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 406 files, 8496 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ ToastProvider caps concurrent toasts, collapsing the rest into "+N more" (N7, above).
- **Partial, NOT met as written — the reading is pending ratification.** Bursts from the same actor/resource within a short window coalesce into one toast **only as a burst of repeats**: the same row again and again (the finding's failure scenario: a colleague clicking a poke button repeatedly, two identical "Coordinate — overlapping checkout" rows) is one card ×N, whoever sends it. Rows about one resource that say different things — a newer status, a second message, another person's sign-off — are separate cards, each in its own words, because the merge keeps the first card's words and would hide the newer ones (*third review fix*; the second review's per-actor key merged one person's differently worded rows into "Approve · DR-12 ×2" / "hey ×2"); past two cards in six seconds the window's remainder is one summary card (`TAX-9`). So a burst from one actor and resource worded differently — the gap this record's N7 Partial block names ("a burst from the same actor and resource worded differently does not yet") — still shows as two cards plus an "N more notifications" summary per 6 s window, and the landed key closes none of it: N7's content key (type, title, message) already merged word-identical toasts. Reading done-when 2 as "a burst of repeats" is `DEC-94` item 4's, **for the integrator to ratify**. *Overstated: ticked ✓ at the third review fix; by the standard that sent `TAX-9` and `TAX-15` back to OPEN, it is not met (N3 fourth review, 2026-10-02).*
- ✓ The CornerDock has a max-height and does not grow past the viewport (N7, above).

*Third review fix (2026-10-02, N3): the key is now `notificationCoalesceKey` (`components/providers/NotificationListener.tsx:94`) — kind, resource, title and body — and the actor left it: keyed by actor, two status changes or two thread posts by one person within 10 s merged into one card in the first row's words, so the newer status or the substantive message never reached a toast (on `7c27b0c` each was its own card). A repeat of the same row still joins its card in the burst window (`route` :223). Tests: `lib/__tests__/notificationListenerToasts.test.ts` "a nudge burst about one thing from one person is one card with a count…" (unchanged, green), "the same row twice (same kind, resource and words) is one card with a count", "one person's two thread posts are two cards…", "Approve then Release on DR-12…: two cards, the newer status shown…"; `lib/__tests__/notificationListener.test.ts` "rows that say different things about one resource never share a key, whoever sent them…". Verified after the third review fix: `npx tsc --noEmit` exit 0; `npx eslint` on the 19 changed code and test files of the branch `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 407 files, 8522 passed, 7 expected-fail. `next build` is the integrator's.*

**Scope / residual.** The rate of nudges itself (`OS-1` / GAP-206) is not this finding's. No migration.

**Partial (2026-10-02, notifications Round G — N3 fourth review fix).** Status corrected from RESOLVED to OPEN. Done-when 1 and 3 stand (N7, verified above). Done-when 2 is not met as written: the listener's key (`notificationCoalesceKey`, kind + resource + title + body, `components/providers/NotificationListener.tsx:94`) coalesces a burst of repeats — which N7's content key already did — and not a burst from the same actor and resource worded differently, the gap this record's N7 Partial block names. The assigned `` `${row.kind}:${row.resource_id}` `` key would close it, but N7's merge keeps the first row's words, so today it would hide the newer rows (`RT-11`'s Partial block). Remaining step and owner as in `RT-11`'s Partial block: the integrator ratifies `DEC-94` item 4's reading, or whoever next holds `components/providers/ToastProvider.tsx` makes a merge show the newest row's words (or "N updates on <resource>") and the listener then passes the assigned key (hand-off in `99-fix-sequencing.md`). Records only; no code changed for this finding in the fourth review fix.

**Done-when.**
- ✓ ToastProvider caps concurrent toasts, collapsing the rest into "+N more" (N7).
- Partial, NOT met as written (pending ratification): a burst of repeats is one card ×N; a burst from one actor/resource worded differently is not coalesced.
- ✓ The CornerDock has a max-height and does not grow past the viewport (N7).

**Scope / residual.** Stays OPEN on done-when 2 (owner as in `RT-11`). The rate of nudges itself (`OS-1` / GAP-206) is not this finding's. No migration.

**Resolution (2026-10-08, notifications Round G — integrator ratification at the N3 SURFACES merge).** `DEC-94` item 4's reading is **ratified** by the integrator under the user's delegation (`DEC-90`): done-when 2 ("bursts from the same actor/resource … coalesce into one toast") is read as a burst of repeats — the finding's own failure scenario, a poke button clicked repeatedly, is one card ×N (`notificationCoalesceKey`, `components/providers/NotificationListener.tsx:94`); differently worded rows about one resource are separate cards, bounded by the burst summary (`DEC-94` item 5), because merging them under the first row's words hid a newer status or a second message (the second review's per-actor key). The newest-words merge in `ToastProvider` stays a hand-off → notifications N13 LAYERS SWEEP.

**Done-when.** 1 ✓ and 3 ✓ (N7, above); 2 ✓ on the ratified reading.

**Scope / residual.** As `RT-11`. No migration.

---

<a id="os-5"></a>

## OS-5 · The bell has no animation of any kind — the owner's 'bell spinning while the badge pulses and counts up' has nothing to build on there

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/notifications/NotificationBell.tsx:108-118`, `components/notifications/NotificationBell.tsx:160`, `components/navigation/Sidebar.tsx:508-511`, `components/notifications/NotificationCenter.tsx:132`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Every factual assertion checks out, including the actionRequired-not-unread coupling of the one existing pulse. Downgrading to LOW because the finding is, by its own admission, an inventory of an absent enhancement rather than a defect — nothing is broken, mis-delivered or misleading today.

**Mechanism.** Reading NotificationBell.tsx end to end: the header <Bell className="w-4 h-4" /> and the sidebar <Bell className="w-5 h-5 ..." /> carry no animation class, and both badge spans are static (bg-orange-500, with a ring-2 ring-white on the header variant). The only animate-* in the file is a Loader2 spinner in the empty/loading state and the dropdown's one-shot animate-in fade-in zoom-in-95. A repo-scoped search for animate-pulse/spin/bounce/ping across components/notifications, components/navigation, components/providers and CornerDock finds animate-pulse in exactly two places: the sidebar's RED badge tone, and a skeleton placeholder in NotificationCenter. There is no count-up: `{unread > 99 ? "99+" : unread}` renders the number directly with no transition, and the count comes from useTicketNotifications, which refetches wholesale on realtime events.

**Failure scenario.** Not a defect so much as a truthful inventory: a build for complaint #3 must add the bell icon animation, the badge pulse and the count-up interpolation from scratch. The one thing already present — the sidebar red-badge pulse — is tied to actionRequired > 0, not to unread-ness, so reusing it for a login nudge would make FYI notifications look like action-required ones.

**Evidence.**

```
components/notifications/NotificationBell.tsx:114 (header variant, no animation on icon or badge) —
  <Bell className="w-4 h-4" />
  {unread > 0 && (
    <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-orange-500 text-white text-[10px] font-black ring-2 ring-white">
      {unread > 99 ? "99+" : unread}
    </span>
  )}

components/navigation/Sidebar.tsx:508 (the ONLY meaningful pulse, and it means action-required) —
  const badgeTone =
    leaf.badgeTone === 'red'  ? 'bg-red-600 animate-pulse shadow-red-900/50' :
    leaf.badgeTone === 'blue' ? 'bg-blue-500 shadow-blue-900/50' :
```

> **Verifier correction.** One factual trim: the finding says users see both a header bell and a sidebar bell. NotificationBell is rendered in exactly one place — TopBar.tsx:230, `{uid && <NotificationBell variant="header" />}` — verified with a repo-wide component-name grep. The `variant="sidebar"` branch (the `w-5 h-5` Bell at :103-116) is the default prop value but is never mounted; it is dead code. The conclusion is unaffected.

**Done when.**

- [ ] Any added bell animation is time-boxed (fires once on login / on arrival, then stops) rather than a permanent animate-pulse that never resolves
- [ ] The animation distinguishes action-required from FYI, so it does not collide with the sidebar red-badge semantics at Sidebar.tsx:508
- [ ] A prefers-reduced-motion guard exists for the spin/pulse/count-up

---

<a id="os-6"></a>

## OS-6 · The one working person-to-person nudge guards against repeats with component-local React state that a page refresh erases

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/checkouts/page.tsx:483-492`, `app/(protected)/checkouts/page.tsx:508-518`, `app/(protected)/checkouts/page.tsx:242-269`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. The title claim is true — `nudged` is component-local and a refresh erases it, and repeat inserts are unbounded (see OS-1). But the summary's specific mechanism is FALSE: `overlaps` is independent state set from findCheckoutOverlaps (page.tsx:113 `setOverlaps(ov)`), not derived from `filtered` (page.tsx:128-139), and the key is a stable index, so changing the user filter does NOT remount OverlapCard or reset `nudged`. The real cheap reset paths are a page refresh, collapsing/reopening the 'Coordination signals' panel (`{isOpen && ...}` unmounts the cards), and the index-keying itself, which mis-carries a `nudged=true` onto a different overlap if refresh() reorders the list.

**Mechanism.** OverlapCard holds `const [nudged, setNudged] = React.useState(false)` and doNudge() early-returns `if (nudging || nudged) return;`. That is the entire anti-repeat mechanism. It lives in a component that unmounts on filter change, on view toggle between grouped/flat, and on every navigation or refresh. The write itself is a direct client-side notifyMany() to the notifications table under the permissive INSERT policy, so there is no server-side record that a nudge was sent — nothing to check a cooldown against.

**Failure scenario.** A supervisor nudges an overlap, the button goes green, they change the user filter to double-check who was notified, the card remounts with nudged=false, and they nudge again. Two identical 'Coordinate — overlapping checkout' rows land in each recipient's bell and NotificationListener fires two toasts. Nothing anywhere records that this is a duplicate. Scale that to a person-to-person poke button on a drafting request and the ten-nudges-per-minute scenario is a page refresh away.

**Evidence.**

```
app/(protected)/checkouts/page.tsx:483 —
  const [nudging, setNudging] = React.useState(false);
  const [nudged, setNudged] = React.useState(false);
  ...
  const doNudge = async () => {
    if (nudging || nudged) return;

app/(protected)/checkouts/page.tsx:256 (the write, client-side, no server route) —
              await notifyMany({
                orgId: activeOrgId,
                userIds: recipients,
                actorUserId: uid ?? undefined,
                kind: "checkout_conflict",
```

> **Verifier correction.** Two of the three named reset triggers are wrong. `overlaps` is independent load state (page.tsx:49, populated at :109) and the panel renders ABOVE the filter/view controls, so changing a filter or toggling grouped/flat does NOT unmount OverlapCard — React keeps that subtree. The verified resets are: collapsing the panel (the `{isOpen && ...}` guard), navigating away, and refreshing.

**Done when.**

- [ ] The nudge's cooldown is derived from persisted state, not component state — the pattern at lib/distributionAcks.ts:224-238 (query notifications for recent rows of this kind carrying a metadata marker, within a cooldown window) already exists and is reusable verbatim
- [ ] The button's disabled/'already sent' state survives a refresh because it is computed from that query
- [ ] A second nudge inside the window is refused by the writer, not merely hidden by the UI


**Resolution (2026-10-07, notifications Round G).** Package N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT, branch `fleet/N9-dc-producers-kind-split`, commits `d48617c` (the read) and `9f9443d` (the writer and the page). **Reproduced first** on `b154823`: `app/(protected)/checkouts/page.tsx` held `nudged` in the overlap card's React state (:499) and disabled the button on it (:526); the write (`notifyMany`, :266) checked nothing, and a refresh offered the nudge again.

**What landed.** The cooldown is 24 hours per (sender, recipient, document) — the integrator's ruling under the user's delegation (2026-10-07).
- `lib/checkoutNudge.ts` (new): a nudge is a `checkout_conflict` row carrying `metadata.nudge`, about the document the person holds in the overlap (it named the bare "checkout" type before). `recentNudges` (:62) reads the sender's own nudge rows of the window through `notifications_i_sent` (`20261191`, `lib/sentNotices.ts` — the read `OS-6`'s cited distributionAcks pattern cannot do from a browser, because `notifications_own_select` hides sent rows); `nudgeState` (:79) says whether every person in the overlap was nudged and when the next nudge is possible; `sendCheckoutNudge` (:104) nudges only the people not nudged about their document in the window and REFUSES when nobody is left, with the sentence "You already nudged <names> about this in the last 24 hours — you can nudge again after <time>." Before the paste the read is unavailable and today's path holds (the card's own state; the write goes out). A read that FAILS for any other reason is not "never sent": the writer refuses with "Couldn't check whether you already nudged them — try again in a moment.", writes nothing, and the page keeps the button (integrator fix pass, 2026-10-08 — the first cut re-nudged everyone on that path). `20261160`'s caps stay the backstop for a writer that skips the module.
- The page loads the member's nudges once overlaps are found, shows "Heads-up sent" from them on every device (`nudgeState`), toasts the writer's refusal ("Already nudged …"), and keys each card by its overlap's identity.
- Tests: `lib/__tests__/checkoutNudgeCooldown.test.ts` (12 — the read's arguments and its unavailable answers, with the reason; targets, state and the next-nudge time; a partial nudge naming each recipient's document; the refusal's sentence with no write; an expired nudge not holding; the pre-paste path; a failed read refusing with nothing written; the page's wiring). On PostgreSQL 16 the read answered the sender's one nudge in the window and nothing else.
- Verified (loop on `fleet/N9-dc-producers-kind-split` after the review fix, 2026-10-08): `npx tsc --noEmit` exit 0; `npx eslint` on the changed `.ts` files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 460 files, 10039 passed, 8 expected fail (10047; the eighth is the compliance-digest tripwire). `next build` is the integrator's.

**Done-when.**
- ✓ The cooldown is derived from persisted state — the notification rows the sender wrote, read back through `notifications_i_sent`.
- ✓ The button's "already sent" state survives a refresh, computed from that read.
- ✓ A second nudge inside the window is refused by the writer (`sendCheckoutNudge`), with the reason, not merely hidden by the UI.

**Scope / residual.** Takes effect once `20261191` is pasted (the page keeps today's per-card state until then). The writer is the browser module; a client that bypasses it (a tab loaded before the N9 deploy, a script calling `notifyMany`) is bounded by `20261160`'s per-recipient caps, not by the 24-hour rule — raised to a finding with an owner, `OS-13` (a rule in `enforce_notification_insert`, notifications N12 / N14).

---

<a id="os-7"></a>

## OS-7 · The task_nudge notification kind is declared and routed to a sidebar section that no longer exists, and nothing ever emits it

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/inAppNotifications.ts:35`, `hooks/useTicketNotifications.ts:80-83`, `hooks/useTicketNotifications.ts:130-137`, `components/navigation/Sidebar.tsx:229-235`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every leg confirmed, including the generic-Bell fallback: the kind is declared, routed to a section with no sidebar item, emitted by nobody, and iconless.

**Mechanism.** task_nudge is the one NotificationKind whose name matches the owner's request for a person-to-person poke, so a build will reach for it. But it was a scratchpad feature: sectionForKind() routes it (with task_overdue_digest and morning_digest) to the 'scratchpad' section, the scratchpad surface was removed in commit 0bb13ed, and the Sidebar's sections array only spreads badgeOf() for sectionCounts.documents, sectionCounts.projects and sectionCounts.requests. sectionCounts.scratchpad is computed on every render and rendered nowhere. Two differently-shaped searches confirm nothing emits it: `grep -rn "task_nudge" --include=*.ts --include=*.tsx --include=*.sql .` returns exactly two lines (the type declaration and the switch case), and a case-insensitive `grep -rni "nudge"` across app/components/lib/hooks/types/supabase/docs returns only knowledge-index nudges, the checkouts coordination nudge, computeNudges (derived advice), and distribution re-nudges — no producer of this kind.

**Failure scenario.** A build for (C) reuses kind:"task_nudge" because the name fits. The row inserts fine, the bell shows it (the bell falls back to a generic Bell icon since KIND_ICON has no task_nudge entry), and NotificationCenter shows it — but the sidebar badge silently swallows it into sectionCounts.scratchpad, which no nav item renders. The engineer being poked sees a bell count that no sidebar section explains. That is the owner's complaint #1 reproduced exactly, in new code.

**Evidence.**

```
lib/inAppNotifications.ts:35 —
  | "task_nudge"              // someone sent you a scratchpad task as a heads-up

hooks/useTicketNotifications.ts:80 —
    case 'task_nudge':
    case 'task_overdue_digest':
    case 'morning_digest':
      return 'scratchpad';

components/navigation/Sidebar.tsx:229-235 — the only badgeOf() spreads:
  { label: 'Documents', ... ...badgeOf(sectionCounts.documents)   },
  { label: 'Projects',  ... ...badgeOf(sectionCounts.projects) },
  { label: 'Drafting Requests', ... ...badgeOf(sectionCounts.requests),

app/(protected)/scratchpad/page.tsx:3 —
  // The standalone Scratchpad was removed (2026-08 cleanup) — notes now live on
```

**Done when.**

- [ ] A person-to-person nudge uses a kind that sectionForKind() routes to a section the Sidebar actually badges (e.g. 'requests' for a drafting-request poke)
- [ ] task_nudge / task_overdue_digest / morning_digest and the 'scratchpad' AttentionSection are removed, or the section is remapped to a live destination
- [ ] KIND_ICON in NotificationBell.tsx has an entry for whatever kind the nudge uses, so it does not render the generic fallback bell

**Partial (2026-10-01, notifications Round G).** **Reproduced first** on `b9cdfdc`: `task_nudge` had two references (the union and the `'scratchpad'` case), no producer, no icon, and a section no row renders.

**Fix (commit `95dbe50`).** `task_nudge`, `task_overdue_digest`, `morning_digest` (and `task_reminder`) are removed with the `'scratchpad'` section (`PROD-8`). Any kind the person-to-person nudge uses (GAP-206, N12) is now bound by the registry: it cannot compile without a `KIND_META` entry, its section must be one the Sidebar badges or a deliberate bell-only listing the test pins, and every entry carries an icon. A test (review fix `42d5df8`) also requires the bell's `KIND_ICON` to draw that icon for every kind outside a named gap list — the 26 kinds the bell draws with the fallback today — so a new kind without a bell entry fails unless it is listed there on purpose.

- Files: `lib/inAppNotifications.ts`, `lib/notificationKinds.ts`, `hooks/useTicketNotifications.ts`.
- Tests: `lib/__tests__/notificationKinds.test.ts` (the type-check probe; "the sections are exactly the rows the Sidebar badges"; "icon: every kind has one"; "OS-7 dw3 as a ratchet: a kind outside the named gap list draws its KIND_META icon in the bell").
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's.

**Done-when.**
- **Not done (N12):** a nudge's kind routing to a badged section cannot be verified while no nudge exists. The registry forces the choice to be made and recorded (no kind compiles unclassified; its section is a row the Sidebar badges or a deliberate, tested bell-only listing); GAP-206 (N12) makes it — `requests` for a drafting-request poke.
- ✓ `task_nudge` / `task_overdue_digest` / `morning_digest` and the `'scratchpad'` section are removed.
- **Partly (N12 / N3):** every `KIND_META` entry has an icon key, and the ratchet test fails for a new kind whose bell entry is missing or differs — but the bell's `KIND_ICON` is still hand-kept and 26 existing kinds draw the fallback there. Met for the nudge when N12 adds its kind with a bell entry (the test requires one unless the kind is listed as a gap on purpose); met for every kind when N3 derives `KIND_ICON` from `KIND_META` (`TAX-5`) and empties the gap list.

**Scope / residual.** Stays OPEN for done-when 1 and 3: record RESOLVED when N12's nudge kind lands with a badged (or ratified bell-only) section and its bell icon.

---

<a id="os-8"></a>

## OS-8 · There is no per-user last-seen/last-read timestamp anywhere, so a login nudge has nothing to decide 'new since your last visit' against

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:9-16`, `supabase/schema.sql:680`, `lib/eSignatures.ts:67`, `components/providers/RoleContext.tsx:306-320`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The substantive point holds: a 'new since your last visit' comparison has no server-side watermark, and because read_at only clears on an explicit row click or Mark-all-read, an unread-count-driven banner would indeed re-fire forever. Correction: 'nowhere anywhere' overstates it — lib/eSignatures.ts:67 `const last = user.last_sign_in_at ? ...` shows Supabase's auth.users.last_sign_in_at IS readable; it is unusable for this purpose only because it is stamped with the CURRENT sign-in, not the previous one. Downgraded to LOW: this is a missing capability for an unbuilt feature, not a defect in shipped behavior.

**Mechanism.** The users table has id/email/display_name/default_org_id/created_at/updated_at and nothing else. The only per-notification time state is notifications.read_at (null = unread), which answers 'did you open this row', not 'when were you last here'. Two differently-shaped searches (`grep -rn "last_login|lastLogin|last_active|last_sign_in|lastSeenAt"` across ts/tsx/sql, and a SQL-only search for last_seen/last_read/seen_at) turn up only checkout-session last_seen_at and project_documents.last_seen_at — both about documents, not users. lib/eSignatures.ts does read Supabase auth's user.last_sign_in_at, proving the field is reachable, but that value is the CURRENT session's sign-in time, so it cannot answer 'what arrived while I was away'.

**Failure scenario.** A login nudge is built on 'unread count > 0'. Because read_at only clears when the user clicks the specific row or hits Mark all read, a user with three old, never-clicked but already-seen notifications gets the same dismissible banner on every single login, forever. The nudge becomes wallpaper within a week and the one login where something genuinely new arrived is indistinguishable from the other thirty.

**Evidence.**

```
supabase/schema.sql:9 —
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    display_name TEXT,
    default_org_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

lib/eSignatures.ts:67 (proves last_sign_in_at is reachable, and what it actually means) —
  const last = user.last_sign_in_at ? new Date(user.last_sign_in_at).getTime() : 0;
  return { method: "sso", email: user.email, fresh: Date.now() - last < SSO_REAUTH_WINDOW_MS };
```

**Done when.**

- [ ] A users.notifications_last_seen_at (or per-org equivalent) column exists and is stamped when the user opens the bell or the Notification Center
- [ ] The login nudge fires only when max(notifications.created_at) > that timestamp, not merely when unread > 0
- [ ] Dismissing the nudge stamps the timestamp so the same nudge cannot reappear on the next login
- [ ] The nudge does not fire on RoleContext's SIGNED_IN re-emits (tab return, token refresh) — see components/providers/RoleContext.tsx:300-306, which documents that SIGNED_IN fires on all of those

---

<a id="os-9"></a>

## OS-9 · emit() — the single declared fan-out point — has only two channels, and the deliberate push seam that used to sit there was deleted

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/notify/dispatch.ts:20`, `lib/notify/dispatch.ts:2-8`, `lib/notify/dispatch.ts:78-124`, `commit 0bb13ed deleted lib/notify/push.ts`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified: emit() is the declared single fan-out point and carries only bell + email. The 'all three' comment surviving against a two-member NotifChannel union is direct corroboration that a third (push) channel once occupied that seam; the deletion itself cannot be shown from history because the repo is one squashed commit.

**Mechanism.** dispatch.ts documents itself as 'THE single entry point every producer should call' and fans out to in-app + email. A prior commit had lib/notify/push.ts exporting sendPushSafe(payload) — a deliberate fail-safe no-op whose stated contract was 'so the dispatcher can list push as a channel today with zero risk'. That file was deleted in 0bb13ed. So today NotifChannel is a two-member union and emit()'s body has exactly two `if (channels.includes(...))` blocks. Any Web Push build must re-open this seam rather than bolting a third emitter alongside emit(), or the eight existing emit() call sites (distributionAcks, staleCopies, orchestrator/tools, holds, postPublish x2, projects, branches x2) will silently not reach push.

**Failure scenario.** A push build is added at one call site (say, the ticket comment route) instead of inside emit(). Holds, publishes, branch conflicts, stale-copy recalls and distribution acks — every event that already routes through emit() — keep reaching only the bell and email. The owner concludes 'push works sometimes' and cannot predict which events reach their phone.

**Evidence.**

```
lib/notify/dispatch.ts:20 —
  export type NotifChannel = "inapp" | "email";

lib/notify/dispatch.ts:78 —
  export async function emit(input: EmitInput): Promise<void> {
    const recipients = await resolveRecipients(input);
    if (recipients.length === 0) return;
    const channels = input.channels ?? ["inapp", "email"];

Deleted seam (git show 0bb13ed^:lib/notify/push.ts) —
  export async function sendPushSafe(payload: PushPayload): Promise<void> {
    // Intentionally a no-op until Phase 5.
    void payload;
    return;
  }

`grep -rn '"push"' --include=*.ts --include=*.tsx lib app components` returns nothing.
```

> **Verifier correction.** Two corrections. (1) The call-site count is wrong and undercounts: `grep -rn "await emit({"` returns 15 calls across 12 files — the nine the finding names plus app/(protected)/requests/new/page.tsx:342, lib/revisionImpact.ts:135, lib/transitionIn.ts:339, lib/checkoutEpisodes.ts:666, components/documents/CheckInPanel.tsx:400, and lib/workPackages.ts (dispatch import at :15). (2) Severity HIGH is overstated: nothing is broken today. This is an architectural note about where a future feature belongs, not a defect with a present consequence, and it shares one root cause with finding 1.

**Done when.**

- [ ] NotifChannel includes "push" and emit() has a third fan-out block guarded by channels.includes("push")
- [ ] The push block honors notification_preferences.push_enabled the same way the email block honors email_enabled/digest_frequency
- [ ] The push block cannot throw into emit()'s caller (the deleted sendPushSafe contract: never throws, never blocks inapp/email)
- [ ] A test asserts emit() with channels:["inapp"] does not attempt push

**Resolution (2026-10-14, notifications Round G).** Package N10 PUSH, branch `fleet/N10-push` (base `ce5a053`), commits `3f53779` (`web-push` 3.6.7), `b3358d9` (the channel) and `669afad` (no push for a registration older than the opt-in control).
**Reproduced first** on `ce5a053`: `lib/notify/dispatch.ts:24` `export type NotifChannel = "inapp" | "email";`, the default `["inapp", "email"]` (`:329`), and two `channels.includes(…)` blocks.

**What landed** (`lib/notify/dispatch.ts`).
- `NotifChannel` is `"inapp" | "email" | "push"` (`:41`), and the default channels are in-app, email and push (`DEFAULT_CHANNELS`, `:515`).
- The third block (`:498-507`) runs only after the bell and email legs have finished. It needs all of these: `channels.includes("push")`, the in-app leg (push follows a bell row), and a `KIND_META.pushWorthy` kind (the six the integrator ruled — `lib/notificationKinds.ts`).
- It sends only for the recipients told in full: `emit()` calls `deliver(input, full, { push: true })` (`:336`) and the redacted notice with `{ push: false }` (`:341`, `DEC-106` item 2). Where the in-app leg answers per recipient, only those whose bell row landed are pushed.
- In the browser the leg is a fire-and-forget POST to `/api/push/notify` (`keepalive`; an audience past 500 goes in parts), and `emit()`'s caller never waits on it.
- On the server the leg calls the sender THE CALLER passes, `EmitInput.serverPush` (`:82`; `lib/push/sendPush.ts` `pushFromServer`, `:424`). It is bounded by `PUSH_LEG_TIMEOUT_MS` and caught (`pushLeg`, `:555`). `dispatch.ts` is bundled for the browser and never imports `web-push` or the service role.
  - ~~registered when that module is loaded (`__registerServerPushSender`)~~: withdrawn at the fix pass, below.
- A server emit whose caller passes no `serverPush` sends no push and says so once. That holds whichever modules the process has loaded. The maintenance cron passes none, because the cron only prunes (`DEC-90` ruling 3).
- `emit()`'s answer (`EmitResult`) is unchanged by the push leg.
- Verified (loop on `fleet/N10-push` at `669afad`, 2026-10-14): `npx tsc --noEmit` exit 0; `npx eslint` on the changed files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` in four shards (`--shard=N/4`), each exit 0 — 568 files, 12532 passed, 8 expected fail. `next build` is the integrator's.

**Done-when.**
- ✓ `NotifChannel` includes `"push"`, and `emit()` has a third fan-out block guarded by `channels.includes("push")` (`pushChannel.test.ts` "NotifChannel includes \"push\" …").
- ✓ The push block honours `notification_preferences.push_enabled`. The sender reads it per recipient at send time (service role), the way the email leg's gate (`email_gate()` / `queueEmail`) reads `email_enabled` / `digest_frequency`. `false` stops delivery and leaves the device registered; an unreadable preference sends nothing (`sendPush.ts:303`; `pushChannel.test.ts` "acceptance 2", "an unreadable preference sends nothing").
- ✓ The push block cannot throw into `emit()`'s caller, and never blocks the in-app or email legs (`pushChannel.test.ts` "a sender that throws …", "a sender that hangs is abandoned …", "no server sender in this context …", "the browser path posts … fire-and-forget").
- ✓ A test asserts `emit()` with `channels: ["inapp"]` does not attempt push (`pushChannel.test.ts` "done-when 4").

**Scope / residual.** Every browser `emit()` call site reaches the push leg; only the push-worthy kinds send. A server `emit()` pushes only when its caller passes `serverPush`. No server caller does yet; the only server emit of a push-worthy kind is the cron's stale-hold nudge, which by ruling does not push. The push-worthy producers that write their bell rows outside `emit()` are `OS-14` (new).

**Fix pass (2026-10-14, notifications Round G — the review of N10).**

*Review major 2 (load-order push).* The first pass registered the server sender in module-global state: `sendPush.ts` called `__registerServerPushSender` at load. In a long-lived Node process (`next start`, self-hosted, `next dev`) the module cache is shared across route handlers. After any request loaded `lib/push/sendPush` (every visit to `/settings/notifications` does, through `GET /api/push/subscribe`), every later server emit of a push-worthy kind pushed. That included the maintenance cron's `scanStaleHolds` nudge (`hold_opened`, `lib/holds.ts:752`), with up to 8 s spent on each hold, on some days and not others. The records' claim "the maintenance cron loads none" did not make that impossible. Landed:
- The global is gone. `EmitInput.serverPush?: PushSender` (`lib/notify/dispatch.ts:82`) is passed per call, only by a server caller allowed to push.
- `pushLeg` (`:555`) without it is a no-op, logged once.
- `lib/push/sendPush.ts` registers nothing and exports `pushFromServer` (`:424`).
- The cron passes none.
- Pinned by `pushChannel.test.ts`:
  - "major 2: loading lib/push/sendPush registers no global sender …". The sender is loaded, VAPID is on, and a device and a landed bell row exist, yet a server emit sends nothing. The same emit with `pushFromServer` does.
  - "major 2: the maintenance cron's stale-hold nudge (scanStaleHolds → hold_opened) runs through the REAL emit and attempts no push". Its bell row lands, no device is read, nothing is sent.
  - "major 2: no module-level push sender anywhere …".

*Review minor (check-then-act).* A device is now CLAIMED for a bell row before the send. The claim is a conditional update that lands only while `last_reminded_at` is null or older than the row (`sendPush.ts:377`, `.or("last_reminded_at.is.null,last_reminded_at.lt.\"<row created_at>\"")`), so two requests at once send once. A send that fails other than with 404 / 410 puts the claim back, so a later request about the row may retry. A claim the database refuses with an error sends nothing. Pinned by `pushChannel.test.ts` "two requests about the same row at once send ONE push per device …", "the claim comes before the send; a failed send … puts it back …", "a claim the database refuses with an error sends nothing …". The PostgreSQL 16 run of `20261211` exercised the same condition: claim 1 landed, claim 2 on the same row matched 0, and a newer row's claim landed.

*Review blocker* (`OS-2`'s fix-pass block): the sender posts only to a push service's host, reads at most `PUSH_DEVICE_CAP` devices per person, and the notify route answers before the sends. *(Corrected at fix pass 2: "only to a push service's host" held from fix pass 2 on, when the check began reading the host the way `web-push` connects by, and every send began going through a push-service-only agent. One person's rows no longer cost another their push. See `OS-2`'s fix-pass-2 block.)*

Verified (loop on `fleet/N10-push` after the fix pass, 2026-10-14): `npx tsc --noEmit` exit 0; `npx eslint` on the changed files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` in four shards (`--shard=N/4`), each exit 0 — 569 files, 12557 passed, 8 expected fail. `next build` is the integrator's.

---

<a id="os-10"></a>

## OS-10 · notification_preferences.push_enabled exists, defaults TRUE, and is read by nothing — the settings page does not even show it

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:659`, `supabase/migrations/20260723_notifications_unify.sql:87`, `app/(protected)/settings/notifications/page.tsx:24-40`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed exactly: column exists, defaults TRUE, has zero readers in application code, and the settings UI has no field for it. The silent-org-wide-opt-in consequence follows directly from DEFAULT TRUE plus the absent control.

**Mechanism.** The unify migration adds push_enabled (and inapp_enabled) with DEFAULT TRUE, and its own header comment contemplates dropping them. The settings page's Prefs interface enumerates six email toggles plus digest_frequency and omits push_enabled entirely; its DEFAULTS object likewise. Two differently-shaped searches (`grep -rn "push_enabled|pushEnabled"` across all ts/tsx/sql, and inspection of the settings page's full Prefs shape) confirm no TypeScript file reads the column.

**Failure scenario.** A push build ships and consults push_enabled for the opt-out. Because the column defaults TRUE and no user has ever seen a control for it, every existing member is opted IN to OS notifications the moment the sender goes live — a silent org-wide opt-in for a PSM workforce that never consented. Worse, the natural fix (surface the toggle) still leaves the pre-existing rows at TRUE.

**Evidence.**

```
supabase/schema.sql:659 —
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,

app/(protected)/settings/notifications/page.tsx:24 —
  interface Prefs {
    email_enabled: boolean;
    email_on_mention: boolean;
    email_on_assignment: boolean;
    email_on_status_change: boolean;
    email_on_watched_activity: boolean;
    email_on_sla_warning: boolean;
    digest_frequency: "immediate" | "hourly" | "daily" | "never";
  }

(the page's own header comment: "In-app bell notifications are always on ... the email side is the opt-in noise layer" — push is not mentioned at all)
```

> **Verifier correction.** One nuance worth carrying: the page loads prefs with `.select("*")` (page.tsx:57), so push_enabled IS fetched over the wire — it is simply never read out of the row, never rendered, and never written back. "Read by nothing" is true of the application logic, not of the query.

**Done when.**

- [ ] OS-notification delivery is gated on an EXPLICIT per-device opt-in (the existence of a push_subscriptions row), never on push_enabled's default
- [ ] push_enabled is surfaced on /settings/notifications as a real control, or dropped as the unify migration's comment anticipates
- [ ] No user receives an OS notification without having clicked a control that triggered Notification.requestPermission()

**Resolution (2026-10-14, notifications Round G).** Package N10 PUSH, branch `fleet/N10-push` (base `ce5a053`), commits `3f53779` (`web-push` 3.6.7), `b3358d9` (the channel) and `669afad` (no push for a registration older than the opt-in control).
**Reproduced first** on `ce5a053`: `push_enabled` had no reader. `lib/notificationPrefs.ts` `NotificationPrefs` has no field for it (its `:49` comment names it the push channel's), and the settings page offered no control.

**What landed.**
- Delivery is gated on the per-device row: `lib/push/sendPush.ts` pushes only to the `push_subscriptions` rows of a person whose `push_enabled` is not false. With no row, nothing is sent, whatever the column's default.
- `push_enabled` is a real control: the "Device notifications" switch in `components/settings/PushOptIn.tsx`, saved the moment it is flipped. The save writes only `{ user_id, push_enabled }` with `onConflict: "user_id"` (`:211`), so an existing row keeps every other preference, and a new row takes the column defaults. The page's own Save never writes it (pinned).
- A row made before the opt-in control existed — `PUSH_OPT_IN_SINCE`, `lib/notify/dispatch.ts:544` — belongs to the push stack deleted in `0bb13ed` (its reminders). The sender never pushes such a row, the card does not count it as on, and the cron's step 7c removes it.
- `push_enabled` stays DEFAULT TRUE as stored, as the integrator ruled (`DEC-90`, ruling 2): every existing member stays off until they turn a device on.
- Verified (loop on `fleet/N10-push` at `669afad`, 2026-10-14): `npx tsc --noEmit` exit 0; `npx eslint` on the changed files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` in four shards (`--shard=N/4`), each exit 0 — 568 files, 12532 passed, 8 expected fail. `next build` is the integrator's.

**Done-when.**
- ✓ OS-notification delivery is gated on an EXPLICIT per-device opt-in (the existence of a `push_subscriptions` row), never on `push_enabled`'s default (`pushChannel.test.ts` "OS-10 done-when 1").
- ✓ `push_enabled` is surfaced on `/settings/notifications` as a real control (`pushOptIn.test.ts` "OS-10 done-when 2 …"; `pushChannel.test.ts` "the settings page's own Save never writes push_enabled").
- ✓ No user receives an OS notification without having clicked a control that triggered `Notification.requestPermission()`. This holds in full once `20261211` is pasted; the record is corrected at the fix pass.
  - The only `requestPermission()` caller is that control.
  - A row older than the control is never pushed.
  - A device row is written by `/api/push/subscribe` from a live browser subscription, which the browser grants only after its own permission.
  - The first pass also said "a device row is written ONLY by `/api/push/subscribe`". That was false while `20260804`'s `push_sub_insert_own` let a member insert their own row through PostgREST, with any endpoint and `created_at`, and without the control.
  - `20261211_notif_roundG_push_subscriptions_writer.sql` drops that policy, so the service-role route becomes the table's only writer. No INSERT, UPDATE or ALL policy is left. The shape is pinned by `lib/__tests__/notifRoundGPushWriterMigration.test.ts`, and the file was exercised on PostgreSQL 16: after the paste the member's insert is refused with 42501.
  - Until the paste, a row a member inserts by hand is still sent to only if it names a push service's host (`lib/push/endpoints.ts`, checked before each send), and only for that member's own bell rows. A member would have to run `pushManager.subscribe` themselves for that, which needs the browser's own permission.
  - Tests: `pushChannel.test.ts` "OS-3 done-when 1 / 2 …", "OS-10 done-when 3 …", "blocker: …"; `pushOptIn.test.ts` "a row from before the opt-in control …"; `maintenanceDrain.test.ts` step 7c.
- **Pending migration:** `20261211_notif_roundG_push_subscriptions_writer.sql` (DEC-30; paste in either order with the deploy). Expect `ok = true` × 4, then 5 counts (rows; rows naming no push service; people over 10 registrations; rows from before the opt-in control; `push_sub_insert_own` present 1 / gone 0).

**Scope / residual.** None in this finding beyond the pending paste.

---

<a id="os-11"></a>

## OS-11 · schemaExpectations asserts push_subscriptions must exist — a health check demanding the table of a fully-deleted feature

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/schemaExpectations.ts:99`, `lib/exportTables.ts:167`, `lib/dataRestore.ts:92`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct — the health check does demand the table of a feature with no subscriber and no sender, and export/restore carry matching dead entries. Downgraded to LOW: the consequence is a misleading admin readout and one no-op migration, with no data loss, no security exposure and no user-facing breakage.

**Mechanism.** Three separate registries still treat push_subscriptions as a live table: the schema verification list, the org export's user-scoped table list, and the restore documentation map. Meanwhile no application code reads or writes the table. A workspace that never applied migration 20260804 will report a schema gap for a feature that does not exist, and every org export carries an always-empty table.

**Failure scenario.** An admin opens the schema verification surface, sees 'push_subscriptions missing — apply 20260804_push_subscriptions.sql', applies the migration, and gets exactly nothing: no new capability, no setting, no UI. The verification check has trained them that a reported gap may be meaningless, which is corrosive for every other (real) gap the check reports.

**Evidence.**

```
lib/schemaExpectations.ts:99 —
  { table: "push_subscriptions", migration: "20260804_push_subscriptions.sql" },

lib/exportTables.ts:167 —
  export const USER_SCOPED_FOR_ORG_TABLES = ["notification_preferences", "push_subscriptions"] as const;

lib/dataRestore.ts:92 —
  push_subscriptions: "device push registrations are machine-specific — re-established per device",

`grep -rn "push_subscriptions" --include=*.ts --include=*.tsx app lib` returns ONLY these three lines — no query, no insert, no delete anywhere.
```

> **Verifier correction.** Add supabase/REMEDIATION_APPLY_ALL.sql:16-35 as a fourth registry that still provisions the table (its comment even names the deleted consumers: "reminders cron + push subscribe/unsubscribe"). Severity MEDIUM is the floor of the scale but this is cosmetic — an always-empty export column and one false line in an admin panel.

**Done when.**

- [ ] Either a push build lands and these three registrations become truthful, or all three entries are removed alongside the migration and the sw.js push handlers
- [ ] The schema verification surface reports zero gaps on a fully-migrated workspace

**Resolution (2026-10-14, notifications Round G).** Closed by record, with no edit to the three files (they are PS-VERIFY's, document-control P10's and admin-and-org P2's). Package N10 PUSH, branch `fleet/N10-push`, built the feature they register (`OS-2`). Verified on the branch:
- `lib/schemaExpectations.ts:161` (`push_subscriptions`, `20260804_push_subscriptions.sql`).
- `lib/exportTables.ts:319` ("per-device Web Push credentials … each device re-subscribes" — excluded whole from the export).
- `lib/dataRestore.ts:160` ("device push registrations are machine-specific — re-established per device").

All three now name a table the app reads and writes:
- `lib/push/sendPush.ts` reads a person's devices, records the last push and deletes a row the push service answered 404 / 410 for.
- `app/api/push/subscribe/route.ts` and `app/api/push/unsubscribe/route.ts` are the per-device opt-in and opt-out.
- The maintenance cron's step 7c prunes.
- `components/settings/PushOptIn.tsx` reads its own row.

`supabase/REMEDIATION_APPLY_ALL.sql:5`'s mention of "push subscribe/unsubscribe" consumers is true again. Pinned by `lib/__tests__/pushChannel.test.ts` "OS-11 by record".

**Done-when.**
- ✓ A push build lands and these three registrations become truthful.
- ✓ For this entry: on a fully-migrated workspace (`20260804` applied) the schema verification reports no gap for `push_subscriptions`, and the table it demands is the one the feature uses. Whether every other expectation is met is not this finding's.

**Scope / residual.** None.

---

<a id="os-12"></a>

## OS-12 · sectionCounts.other is computed but rendered nowhere — roughly thirty notification kinds badge no sidebar section at all

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** the user (ratify `DEC-81` §3, the bell-only list including `ai_cap_changed` and `transmittal_unstampable`, or place those kinds on a badged row) — by the integrator, 2026-10-01 (N2 merge; fleet plan `userHeld`). *Ratified by the integrator under the user's delegation, 2026-10-07 (DEC-90), with one change: `transmittal_unstampable` badges Documents, because it reports a controlled copy released without its UNCONTROLLED marking, a document-control integrity event the issuer may need to act on (ISO 9001 §7.5.3); the other eight kinds stay bell-only, and notifications N9 makes the one-line move.*
- **Assigned:** notifications N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT — by the integrator, 2026-10-07 (DEC-90; fleet plan `audit-reports/fleet-plans/notifications.json`, N9).
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:71-95`, `hooks/useTicketNotifications.ts:246-250`, `hooks/useTicketNotifications.ts:284-303`, `components/navigation/Sidebar.tsx:229-235`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and if anything understated — 29 of 48 kinds badge no sidebar item, not 'roughly thirty' by coincidence but because scratchpad is unrendered too. The named compliance kinds (legal_hold_placed, retention_eligible, access_recert_due) all land in 'other' as claimed.

**Mechanism.** sectionForKind()'s switch enumerates about twenty kinds across requests/scratchpad/documents/projects and falls through to 'other' for everything else. NotificationKind declares roughly fifty members. The unmapped remainder — library_doc_added, library_doc_revised, project_comment, review_requested, review_signed, review_invalidated, review_complete, review_overdue, review_due, review_alternate_activated, ack_requested, ack_complete, ack_overdue, ack_unsatisfiable, owner_assigned, owner_behind, deletion_requested, effective_now, retention_eligible, legal_hold_placed, legal_hold_released, access_recert_due, orchestrator_message, security_export, revision_published_over_checkout, task_reminder — all land in 'other'. tally('other', false) increments a counter that no component reads. This is the structural root of 'the trail goes cold': for these kinds there is no sidebar badge to begin with, so the chain never starts.

**Failure scenario.** An engineer is asked to sign off a draft (review_requested). The bell count goes up. Every sidebar item stays clean. The engineer scans the rail, sees nothing lit, and assumes the bell is stale. In a PSM/OSHA context the un-badged set includes legal_hold_placed, retention_eligible, access_recert_due and ack_overdue — the compliance-clock notifications, which are exactly the ones that must not be missed.

**Evidence.**

```
hooks/useTicketNotifications.ts:92 —
      default:
        return 'other';

hooks/useTicketNotifications.ts:246 —
    const sectionCounts = emptySectionCounts();
    const tally = (section: AttentionSection, actionReq: boolean) => {
      sectionCounts[section].total++;
      if (actionReq) sectionCounts[section].actionRequired++;
    };

hooks/useTicketNotifications.ts:302 —
      tally(section, false);

`grep -rn "sectionCounts" --include=*.tsx --include=*.ts app components hooks` shows the ONLY consumer is Sidebar.tsx, reading .documents, .projects and .requests. Nothing reads .other or .scratchpad.
```

**Chain reaction.** Because the bell and the Notification Center consume the same hook but render items rather than section counts, the bell and the sidebar disagree by construction for this whole class — the exact disagreement the hook's header comment claims to have eliminated ('so they always show the same count').

> **Verifier correction.** Two numeric corrections and one scoping note. (1) NotificationKind has 48 members, not "roughly fifty" (counted off the union in lib/inAppNotifications.ts), and 26 fall through to 'other', not "roughly thirty" — the finding's own enumerated list is 26 names and is accurate. (2) 'other' kinds are NOT invisible everywhere: NotificationBell (mounted only from TopBar.tsx:230) and /inbox both render `items`, which includes every kind regardless of section. The defect is precisely and only that the SIDEBAR carries no badge for them — so the finding's framing as "the structural root of the trail goes cold" is right for the sidebar chain but should not be read as "these notifications are unreachable."

**Done when.**

- [ ] Every NotificationKind maps to a section whose sidebar item renders a badge, or 'other' is surfaced on a nav item (Home/Inbox) that owns the remainder
- [ ] A test enumerates NotificationKind and asserts sectionForKind() never returns a section that no surface renders
- [ ] The compliance kinds (legal_hold_*, retention_eligible, access_recert_due, ack_*, review_*) badge a nav destination that leads to them

**Partial (2026-10-01, notifications Round G; status set back to OPEN by the N2 final review).** What holds: every `NotificationKind` maps — to a row the Sidebar badges, or to the explicit bell-only list — and a kind added without a `KIND_META` entry does not compile; and seven of the nine bell-only kinds (`orchestrator_message`, `security_export`, `member_revoked`, `library_unowned`, `storage_alert`, `storage_platform_r2`, `storage_platform_db`) are the fleet plan's default list. What does not hold yet: the bell-only arm rests on `DEC-81` §3, which the user has not ratified, and §3 places two kinds beyond the plan's default there (`ai_cap_changed`, `transmittal_unstampable`). The finding closes — record it RESOLVED — when the user ratifies §3, or when those two kinds are placed on a badged row.

**Reproduced first** on `b9cdfdc`: `lib/__tests__/notificationKinds.test.ts` was committed BEFORE any change (`e595cf5`) with the TODAY tables read from the source — `sectionForKind` returned `'other'` for 28 of the 50 union members (the audit's 26 plus `member_revoked` and `library_unowned`, added by R&P) and `'scratchpad'` for 3; `emptySectionCounts()` allocated five buckets; `components/navigation/Sidebar.tsx` badges three (`badgeOf(sectionCounts.documents|projects|requests)`); and the rendered hook, given one row of every kind written on `b9cdfdc`, tallied 33 rows into `other` and 3 into `scratchpad`, which no row reads. All seven assertions passed on the base, i.e. the defect reproduced as recorded.

**Fix (package N2 KIND-REGISTRY, commit `95dbe50`; review fix `42d5df8`; final-review fix `9950e29`, whose line numbers these are).** New `lib/notificationKinds.ts` `KIND_META` (:88) classifies every `NotificationKind` in one literal — `section`, `actionRequired`, `compliance`, `icon`, `tone`, `group` — with `as const satisfies Record<NotificationKind, KindMeta>` (:192), and each kind's section decision written next to it (:89 requests, :97 documents — the moved kinds under :116, :157 projects — `project_comment` at :161, :164 bell-only). `NOTIFICATION_SECTIONS` (:38) is exactly `requests | documents | projects`. `hooks/useTicketNotifications.ts` `sectionForKind` (:96) reads it, with a `never` guard over the registry's own keys (:102), so a kind added to the union without an entry fails `tsc` twice (here and at the `satisfies`); `emptySectionCounts` (:138) allocates one bucket per rendered section and no other. `'scratchpad'` and `'other'` are gone from `AttentionSection`; a kind with `section: null` is bell-only — counted by the header bell, listed by the Center and `/inbox`, counted by no rail row, which is exactly where `'other'` left it. A legacy row whose kind is in no union (a retired `task_nudge`) resolves to null at runtime. Decision recorded as `DEC-81` in `DECISIONS.md` (provisional number; the integrator renumbers).

**Where each kind went** (`DEC-81` §3; the plan's default): every kind that badged a row on `b9cdfdc` badges the same row; the document-scoped kinds that fell to `'other'` — `ack_requested`, `ack_complete`, `ack_overdue`, `ack_unsatisfiable`, `review_due`, `review_requested`, `review_signed`, `review_invalidated`, `review_complete`, `review_overdue`, `review_alternate_activated`, `library_doc_added`, `library_doc_revised`, `effective_now`, `owner_assigned`, `owner_behind`, `deletion_requested`, `retention_eligible`, `legal_hold_placed`, `legal_hold_released`, `access_recert_due`, `revision_published_over_checkout` — badge **Documents**; `project_comment` badges **Projects**; `orchestrator_message`, `security_export`, `member_revoked`, `library_unowned`, the three storage kinds, `ai_cap_changed` and `transmittal_unstampable` are bell-only, each with its reason in the registry. Nothing was mapped to Documents wholesale, and no emitted kind was deleted. For ratification with §3: `ai_cap_changed` and `transmittal_unstampable` are bell-only beyond the plan's default list (the census found them written outside the union); and `review_requested` is overloaded — besides a document's sign-off request, the contractor-intake path writes it for three notices that open a project: every contractor quote (`app/api/intake/upload/route.ts:899-906` `notifyTeam`, "Quote received: …", `resource_type` 'project', `/projects/<id>?tab=costs`), every intake submission awaiting review (`app/api/intake/upload/route.ts:1533-1544`, the same `notifyTeam`, "Intake submission awaiting review: …", a `/projects/<id>` link), and the folded digest when nothing was published (`lib/intakeRateLimit.ts` `foldedDigestKind`, `resource_type` 'project', a `/projects/<id>` link). So a project-scoped quote or intake notice now raises the **Documents** badge (none of the three badged a row on `b9cdfdc`, where `review_requested` fell to `'other'`). The overload is written next to the kind (`lib/notificationKinds.ts:132-144`); kinds of their own for these notices — for `notifyTeam`'s quote and submission notices and for the digest (e.g. `intake_quote` / `intake_submission`, section `projects`) — are the intake path's owner's (projects).

- Files: `lib/notificationKinds.ts` (new), `lib/inAppNotifications.ts` (the union), `hooks/useTicketNotifications.ts`.
- Tests: `lib/__tests__/notificationKinds.test.ts` — "sectionForKind and KIND_META agree with TODAY + the departures, kind by kind"; "every kind that badged a row on b9cdfdc badges the same row now"; "the sections are exactly the rows the Sidebar badges" (parses `Sidebar.tsx`); "'other' is gone: the bell-only kinds are exactly the deliberate list"; "GAP-201 acceptance 1: a kind added without a KIND_META entry fails the type check" (type-checks the hook in memory with a probe kind appended: the `never` guard and the `satisfies` both fail; clean without it); and the rendered hook over one row of every kind written on `b9cdfdc` — every row still renders (55 items, as before), requests 5 (unchanged), documents 12 → 34, projects 2 → 3, and `sectionCounts` has exactly the three rendered keys.
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's. After the final-review fix (`9950e29`, comments only, and the record commits after it): `npx tsc --noEmit` exit 0; `npx eslint . --max-warnings=0` exit 0; `npx vitest run lib/__tests__/notificationKinds.test.ts lib/__tests__/notificationKindStorageProducers.test.ts lib/__tests__/notificationKindThreadProducer.test.ts` exit 0 — 3 files, 43 passed; `npx vitest run` (full suite) exit 0 — 349 files, 7302 passed, 5 expected-fail; `node audit-reports/build-index.mjs` ✓ corpus integrity.

**Done-when.**
- **Partly — awaits ratification:** every kind maps to a row the Sidebar badges, or is bell-only: owned by the header bell, which the Sidebar's own contract makes the owner of the remainder (`Sidebar.tsx`: "The header bell owns the org-wide total; rows badge only their own section's count"). The remainder is nine kinds, each placed deliberately, not a bucket nobody renders — this arm is the plan's, and the list awaits the user's ratification of `DEC-81` §3, including the two kinds beyond the plan's default (`ai_cap_changed`, `transmittal_unstampable`).
- ✓ A test enumerates the union and asserts `sectionForKind` never returns a section no surface renders (the Sidebar's badged sections, parsed from it, or null for the explicit bell-only list).
- ✓ The compliance kinds (`legal_hold_*`, `retention_eligible`, `access_recert_due`, `ack_*`, `review_*`) badge Documents, whose badge opens the Notification Center listing them (scoping that list to the section is `TAX-1`, N3).

**Scope / residual.** The bell and the rail now disagree only by the bell-only kinds, by design and on the record. Stays OPEN for done-when 1 until the user ratifies `DEC-81` §3 (or `ai_cap_changed` and `transmittal_unstampable` are placed on a badged row); then record RESOLVED.

**Integrator note (2026-10-07, DEC-90 A12, A13).** *Ratified by the integrator under the user's delegation, 2026-10-07 (DEC-90), with one change: `transmittal_unstampable` badges Documents, because it reports a controlled copy released without its UNCONTROLLED marking, a document-control integrity event the issuer may need to act on (ISO 9001 §7.5.3); the other eight kinds stay bell-only, and notifications N9 makes the one-line move.* Status stays OPEN until N9 makes the move: `lib/notificationKinds.ts` gives `transmittal_unstampable` `section: "documents"` (one line), and the bell-only list in `lib/__tests__/notificationKinds.test.ts` drops it. Then done-when 1 holds — every kind maps to a row the Sidebar badges or to the ratified bell-only list of eight, owned by the header bell — and this finding RESOLVES, as its record directs ("record it RESOLVED — when the user ratifies §3, or when those two kinds are placed on a badged row"). The `review_requested` overload, recorded with §3: *Ratified as an interim only by the integrator under the user's delegation, 2026-10-07 (DEC-90), and the split ordered: one name per concept — a project notice must not light the Documents badge or ride the PSM sign-off kind that A11 will make action-required; notifications N9 gives the contractor-quote, intake-submission and folded-digest notices kinds of their own in section `projects`, with a migration re-creating `notification_kinds()` from its newest body, coordinated with projects-joint J16.* No status here depends on it. `userHeld.OS-12` is removed.


**Resolution (2026-10-07, notifications Round G).** Package N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT, branch `fleet/N9-dc-producers-kind-split`, commit `d48617c` — the move the integrator's note names: `transmittal_unstampable` badges Documents (`lib/notificationKinds.ts`, `section: "documents"`), and the bell-only list in `lib/__tests__/notificationKinds.test.ts` is the ratified eight (`DEC-90` A12). The `review_requested` overload is split as `DEC-90` A13 ordered: the contractor quote, the intake submission and the folded digest write `intake_quote` / `intake_submission`, section Projects (`TAX-13`).
- Verified (loop on `fleet/N9-dc-producers-kind-split` after the review fix, 2026-10-08): `npx tsc --noEmit` exit 0; `npx eslint` on the changed `.ts` files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 460 files, 10039 passed, 8 expected fail (10047; the eighth is the compliance-digest tripwire). `next build` is the integrator's.

**Done-when.**
- ✓ Every `NotificationKind` maps to a section whose sidebar row badges it, or to the ratified bell-only list owned by the header bell.
- ✓ A test enumerates the union and asserts `sectionForKind` never returns a section no surface renders (N2).
- ✓ The compliance kinds badge Documents (N2); the intake notices that rode `review_requested` badge Projects.

**Scope / residual.** None in this finding.

---

<a id="os-13"></a>

## OS-13 · The /checkouts nudge cooldown is enforced only by the browser module; the database still accepts a repeat nudge from any client that calls notifyMany directly

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** notifications N12 NUDGES — by the integrator, 2026-10-13 (N9 merge, DEC-31; fleet plans `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `lib/checkoutNudge.ts:104-160`, `supabase/migrations/20261160_notif_roundG_write_rails.sql` (`enforce_notification_insert`), `supabase/migrations/20261191_notif_roundG_kind_split.sql` (`notifications_i_sent`)
- **Opened:** 2026-10-08, notifications Round G, package N9's review fix — the residual `OS-6`'s Scope line recorded, raised to a finding with an owner.

**Mechanism.** `sendCheckoutNudge` refuses a repeat per (sender, recipient, document) inside 24 hours by reading the sender's own `checkout_conflict` rows through `notifications_i_sent`; the write it guards is an ordinary `notifyMany` insert. `20261160`'s insert rail (`enforce_notification_insert`) knows nothing of `metadata.nudge` or the window: it checks the actor, the recipient's membership, the kind, the link and the generic per-actor rate cap. So a script, a tab built before N9, or any caller of `notifyMany` can re-nudge the same person every minute up to the generic caps (60 same-notice rows a minute).

**Failure scenario.** A member opens /checkouts in a tab loaded before the N9 deploy and clicks Nudge repeatedly after a refresh: each click writes a fresh `checkout_conflict` row to the same colleague; the N9 tab's "Already nudged" refusal never applies.

**Done when.**

- [ ] `enforce_notification_insert`, re-created from its NEWEST body (`20261160`; lineDiff-pinned by a shape test), refuses (22023, a legible message) a browser-written `checkout_conflict` row carrying `metadata ? 'nudge'` when the same `actor_user_id` wrote one to the same `user_id` and `resource_id` within 24 hours; service-role writes pass as before.
- [ ] The browser module's refusal sentence and the rail's message agree, and a test drives a second insert inside the window against the rail's text.

**Closer:** notifications N12 NUDGES or N14 (the integrator names one).

---

<a id="os-14"></a>

## OS-14 · Four push-worthy kinds are written outside emit() at their main producers, so they never reach the push channel

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED (read from the code on `fleet/N10-push`)
- **Locations:** `app/api/tickets/comment/route.ts:359` (`ticket_mention`), `app/api/tickets/workflow-action/route.ts:1226-1230` (`ticket_assigned`), `lib/acknowledgments.ts:409`, `:546`, `:691` (`ack_requested`), `lib/reviewControl.ts:574`, `:1225` (`review_requested`), `lib/notify/dispatch.ts` (the push leg)
- **Opened:** 2026-10-14, notifications Round G, package N10 PUSH — the remainder of `OS-2` / `OS-9` / `TAX-12` the plan's file list could not reach (`DEC-31`).

**Mechanism.** The integrator ruled that the push sender runs inside `emit()` at event time (`DEC-90`; `OS-9`). Four of the six push-worthy kinds have a main producer that writes its bell rows without `emit()`:
- The ticket routes' own service-role fan-out (`notifyBatchWithReason`) writes every request mention (`ticket_mention`) and assignment (`ticket_assigned`).
- The read-&-understood roster writes its acknowledgment requests and nags with `notify()` (`lib/acknowledgments.ts`).
- The pre-publish sign-off roster writes its sign-off requests and reminders with `notify()` (`lib/reviewControl.ts`).

Through `emit()` the push channel reaches a force-released checkout, a hold placed, the distribution panel's acknowledgment request (`lib/distributionAcks.ts`) and the change proposed at check-in, sent to the document's owner (`review_requested`, `components/documents/CheckInPanel.tsx`). The maintenance cron's scan reminders are not pushed by design: the cron passes no `serverPush` (N10 fix pass — there is no module-level sender to pick up).

**Failure scenario.** An engineer turns on device notifications. A drafter @-mentions them on a request and assigns them as the reviewer. Neither reaches their phone. (Fix pass: the card no longer lists these. It names them under "Not sent to devices yet" — `components/settings/PushOptIn.tsx` `PUSH_NOT_SENT_YET` / `PUSH_NOT_YET_NOTE` — so nobody is told to expect them. The channel still does not carry them.)

**Done when.**

- [ ] The two ticket routes push the rows their fan-out landed. The route imports `lib/push/sendPush.ts` and calls `sendPushSafe({ orgId, kind, resourceId: ticketId, recipients })` after its bell insert (server path, no `writerUid`; never throws). A server `emit()` would instead pass `serverPush: pushFromServer`; there is no module-level sender (N10 fix pass).
- [ ] The roster requests in `lib/acknowledgments.ts` and `lib/reviewControl.ts` reach the push leg. Either they write through `emit()`, or, after their rows land, a browser writer posts `/api/push/notify` the way `lib/notify/dispatch.ts` `browserPushRequest` does and a server writer calls `sendPushSafe`.
- [ ] A test per producer asserts the push request after the bell row, and none for a redacted or refused row.
- [ ] The settings card's lists follow. Each kind that now reaches the push leg moves from `PUSH_NOT_SENT_YET` to `PUSH_SENT_TODAY`, with a line worded for its producer, and `PUSH_NOT_YET_NOTE` drops it. `lib/__tests__/pushOptIn.test.ts` "major 3: the card's two lists split the push-worthy set exactly …" fails until this is done.

**Closer:** the integrator routes it — the ticket routes are drafting-flow's; `lib/acknowledgments.ts` and `lib/reviewControl.ts` are document-control's.

---

<a id="os-15"></a>

## OS-15 · A shared browser stays subscribed for the person who turned device notifications on after they sign out

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED (read from the code on `fleet/N10-push`)
- **Locations:** `app/api/push/subscribe/route.ts` (the endpoint takeover), `lib/swSession.ts` (`SIGN_OUT`) and the sign-out sites that post it
- **Opened:** 2026-10-14, notifications Round G, package N10 PUSH (`DEC-31`).

**Mechanism.** A push subscription belongs to the browser profile, not to the session. When person A turns on device notifications and later signs out on a shared workstation, A's `push_subscriptions` row stays. The browser keeps showing A's pushes until one of these happens:
- someone turns notifications off for that device;
- another person turns them on there (`/api/push/subscribe` replaces A's row for the endpoint);
- A stops being an active member (the cron's step 7c).

The sign-out sites post `SIGN_OUT` to the service worker (`lib/swSession.ts`, `DEC-44` §3) but do not unsubscribe the device.

**Failure scenario.** On a control-room PC, A signs out at the end of a shift. During the next shift the PC shows "You're asked to sign off a document" for A. The push names no document, reason or person (`DEC-44 (N10-push)`), and opening it lands on the sign-in page. But the next user sees that the departed shift's engineer has a pending sign-off.

**Done when.**

- [ ] An explicit sign-out (not an expiry) removes the signed-out person's row for this browser's endpoint, best-effort and never blocking the sign-out. For example: read `registration.pushManager.getSubscription()`, POST `/api/push/unsubscribe` with the still-valid token, then post `SIGN_OUT`.
- [ ] A test drives the sign-out path and asserts the unsubscribe request precedes the session's end.

**Closer:** the integrator routes it (the sign-out sites are identity-and-session's; the worker's `SIGN_OUT` contract is `DEC-44` §3).

---
