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

**Resolution (2026-10-02, notifications Round G).** Package N5 DISPATCH-AND-WRITE-HOLES, commit `018caac`, migration `supabase/migrations/20261160_notif_roundG_write_rails.sql`. **Reproduced first** on a throwaway PostgreSQL 16 carrying `20260723`'s insert policy verbatim: an ordinary active Engineer inserted, from their own session, 100 `checkout_conflict` rows (an action kind — a red badge) into a colleague's bell in one statement, a row of a kind nobody declared, a row linking to `https://evil.example/login`, and a row naming the Admin as its actor with `actor_name` 'System' — all accepted. **Fix:** a database rail, so the ~30 browser producers keep writing exactly as before and nothing moves to a server route (DEC-31; the plan's trigger approach). `enforce_notification_insert()` — a BEFORE INSERT trigger, SECURITY DEFINER, `search_path` pinned, EXECUTE revoked from PUBLIC, anon and authenticated (nobody calls it directly; PostgreSQL does not check EXECUTE when a trigger fires — exercised):
- its FIRST statement returns NEW untouched when `auth.uid()` IS NULL — the service role and the cron — so every server producer (the ticket routes, the transmittal route, the intake door, the cron, `notify_personnel`, the data-export and AI-cap notices) writes exactly as before;
- for a signed-in writer: the actor is stamped when absent and refused when it is someone else (`DELIV-6`); the kind must be one `notification_kinds()` declares (22023); the link must be app-relative (22023); a recipient who is not an active member of the row's org is SKIPPED (`NEDGE-3`); then the caps (P0001);
- `notifications_org_insert` is kept unchanged: RLS's WITH CHECK runs after the trigger, so the caller must still be an active member of the org.
- `notification_kinds()` — an IMMUTABLE set-returning reference relation of the 51 kinds of `lib/notificationKinds.ts` `KIND_META` and their compliance flags (15 compliance) — the database's allowlist (`DEC-44 (N5)`).
- **The rate cap — the plan's default "60 inserts/actor/minute", applied per actor AND recipient:** 60 rows of the same kind about the same resource to one person in a minute (a poke button pressed 60 times), and 600 rows of anything to one person in a minute. A per-actor ceiling would refuse legitimate single fan-outs, each of which writes one row per recipient: the browser's checkout sweep writes every expired holder's release notice in ONE statement (`lib/projects.ts` `autoReleaseExpiredAdHoc`); an acknowledgment roster writes one request per assignee (`lib/acknowledgments.ts`); a bulk upload under an ack policy writes one request per document per assignee (`startIssuedDocumentClocks`). The inventory counts the minute buckets of the last 30 days that would have met either cap (an over-count: server rows, to which the caps never apply, are counted too). Index `notifications_actor_recipient_idx (actor_user_id, user_id, created_at DESC)` makes the count a range scan.

**Exercised on PostgreSQL 16.** As an active member: impersonating the Admin is refused (42501); a minted kind, an `https:` link, `//evil`, `/\evil`, a tab-smuggled `/\t/evil` and `javascript:` are refused (22023); an app link with no actor lands with the actor stamped; empty and NULL links land; a row to a suspended member, to another org's member, and the suspended and removed rows of a three-row batch are skipped while the active recipient's row lands; a row into another org is still refused by RLS, as are anon and a suspended caller; 60 of one notice land and the 61st is refused, 600 to one person land and the 601st is refused, and the same actor's row to someone else still lands. The service role's rows — another actor, an undeclared kind, an off-site link, a suspended recipient, over the cap — all land untouched. All 12 probes true, again on a second paste. The scratch cluster was deleted afterwards.
- Files: `supabase/migrations/20261160_notif_roundG_write_rails.sql` (new); `lib/notificationKinds.ts` (a header comment: a kind added there needs the function re-created).
- Tests: `lib/__tests__/notificationWriteRails.test.ts` — the trigger's shape (definer, pinned, revoked, the NULL-uid return as its first statement, the rules in order, the caps and their index, bound BEFORE INSERT FOR EACH ROW), `notification_kinds()` against `KIND_META` (newest definition in the sequence, kind for kind and flag for flag), the paste's one-result-set shape and counts-only inventory, and a census of every `link:` a notification producer writes (TypeScript AST: each literal starts with one '/'). `dcHotfixAnonExecute`, `searchPathPin`, `migrationSourceOfTruth`, `exportCoverage` and `notificationKinds` (no retired kind in any SQL file) pass.
- Verified: loop on `fleet/N5-dispatch-rails` at `018caac`: `npx tsc --noEmit` exit 0; `npx eslint` on the six changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7914 passed, 4 expected-fail. `next build` is the integrator's.
- **Pending migration:** `supabase/migrations/20261160_notif_roundG_write_rails.sql` — applied by hand (DEC-30), one paste, expect `ok = true` × 12; before `20261161`. Until it is applied the insert path is as open as before. The app reads nothing it adds, so either deploy order is safe; afterwards a refused browser row is logged by `notify()`, never thrown into a user flow.

**Done-when.**
- Not done here — a person-to-person nudge going through a server route that verifies the caller's relationship to the resource. No such nudge exists yet; it is N12's (GAP-206), which must build it as a server route. The plan makes this finding's database rail the nudge's prerequisite, and the rail is the backstop for every browser write, a future nudge included.
- Not done here — the route-level 429 modelled on `app/api/data-export/run/route.ts`, per (actor, recipient, resource): the nudge route's, N12's. The database caps the same key at 60 a minute (kind and resource included) and any (actor, recipient) at 600.
- ✓ Caller-supplied kinds outside the allowlist are rejected — at the database, for every browser write (`notification_kinds()`).
- ✓ A database trigger caps inserts per actor per interval — per actor and recipient, above.

**Scope / residual.**
- Of the eleven raw inserts in files other packages own (`DEC-81` §5's ratchet), ten run on the service role and pass the rail untouched by design. The eleventh, `lib/projects.ts` `autoReleaseExpiredAdHoc`, also runs in the browser (the page sweep) and meets the rail there: its rows carry a declared kind and an app-relative link, the trigger stamps the sweeping member as their actor, and a holder who is no longer an active member is skipped while the rest of the batch lands (exercised).
- `actor_name` stays the producer's text: the browser's checkout sweep writes 'System' rows legitimately, and those rows now carry the member whose browser ran the sweep. The mark a member cannot forge is `actor_user_id IS NULL` — a server row.
- The bell's off-origin-link rendering guard (for rows written before the paste; the inventory counts them) is the bell's owner's (N3).

---

<a id="os-2"></a>

## OS-2 · Web Push is a decapitated stack: the service-worker receiver, the DB table, and the preference column all survive, but every subscriber and sender was deleted

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="os-3"></a>

## OS-3 · No permission prompt exists anywhere, and ServiceWorkerManager — the natural mount point — deliberately never touches the Notification API

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="os-4"></a>

## OS-4 · NotificationListener toasts on every incoming notification row with no batching or cap — a nudge burst becomes a toast burst

- **Severity:** MEDIUM
- **Status:** OPEN
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
- **Status:** OPEN
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
- **Status:** OPEN
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

---

<a id="os-10"></a>

## OS-10 · notification_preferences.push_enabled exists, defaults TRUE, and is read by nothing — the settings page does not even show it

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="os-11"></a>

## OS-11 · schemaExpectations asserts push_subscriptions must exist — a health check demanding the table of a fully-deleted feature

- **Severity:** LOW
- **Status:** OPEN
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

---

<a id="os-12"></a>

## OS-12 · sectionCounts.other is computed but rendered nowhere — roughly thirty notification kinds badge no sidebar section at all

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** the user (ratify `DEC-81` §3, the bell-only list including `ai_cap_changed` and `transmittal_unstampable`, or place those kinds on a badged row) — by the integrator, 2026-10-01 (N2 merge; fleet plan `userHeld`).
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

---
