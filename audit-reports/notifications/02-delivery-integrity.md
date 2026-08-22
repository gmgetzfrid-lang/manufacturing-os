# 02 · Delivery integrity

**14 findings** — 5 HIGH · 9 MEDIUM.

What gets dropped between an event happening and a person being told — and whether anything notices.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded. A severity set by that pass overrides the original.


### Already there — reusable substrate

| Thing | Where | Why it matters |
|---|---|---|
| emit() — a real unified dispatcher with recipient resolution across every follow system (subscriptions table, tickets.watchers, role pools, project membership), actor removal and per-channel gating | `lib/notify/dispatch.ts:82-132 and lib/notify/recipients.ts:23-72` | The fan-out spine already exists and is correct. Adding a 'push' channel, a preference gate that actually works, or an outbox is a change inside one function rather than a rewrite of 20 producers. resolveRecipients() is exported specifically so a caller can preview who would be notified — that is the hook a 'who did this reach?' diagnostic needs. |
| A correct optimistic-claim + orphan-reclaim + bounded-retry state machine in the email drain | `app/api/notifications/send-queued/route.ts:99-131, 160-181` | The claim (`update status='sending' ... .in('status',['queued','failed']).select()`) is genuinely race-safe, the 15-minute orphan reclaim is sound, and attempt_count/MAX_ATTEMPTS gives real bounded retry. This is the pattern the in-app notification path lacks entirely — an in-app outbox can reuse this machine rather than invent one. |
| publicOrigin() — a documented, environment-aware absolute-URL helper built precisely for links that leave the app | `lib/publicOrigin.ts:18-22` | Fixing the relative-link-in-email defect is a one-line import at each of the two producers; the helper's comment already explains why window.location.origin is the wrong answer on preview deploys. |
| sectionForKind() + SectionCounts — the per-section badge routing layer the sidebar chain needs, already wired end to end for three sections | `hooks/useTicketNotifications.ts:71-103, 121-132, 246-250` | The 'trail goes cold' fix does not need new plumbing: the mapping function, the per-section tally and the badge renderer all exist. It needs the switch made exhaustive and the discarded 'other'/'scratchpad' buckets given destinations, plus the same badgeOf() pattern applied to library/folder/document rows. |
| Stale-alert reconciliation — workflow notifications carrying metadata.action/metadata.status are auto-retired when the underlying ticket moves on, on both the read and write side | `hooks/useTicketNotifications.ts:188-210 and app/api/tickets/workflow-action/route.ts:324-331` | A working precedent for 'an obligation that is no longer true should stop badging'. The same metadata-driven pattern extends naturally to ack/review/recert kinds, which currently linger until manually read. |
| Service-worker push receiver, push_subscriptions table with per-user RLS, and a push_enabled preference column | `public/sw.js:223-250, supabase/migrations/20260804_push_subscriptions.sql:7-35, supabase/migrations/20260723_notifications_unify.sql:87` | Roughly half of an OS-level notification channel is already built and correct — the receiving end and the storage. What is missing is pushManager.subscribe on the client, VAPID config, and a sender. Complaint #2 is a smaller job than it looks. |
| NotificationCenter — a single slide-over consuming the exact same hook every badge consumes, openable from any count in the app | `components/notifications/NotificationCenter.tsx:34-45, 87-157` | The 'click a number, see the items behind it' contract is already implemented and provider-wrapped. Once the feed paginates, this is the natural home for the older-than-50 backlog, and for a login-time nudge banner (complaint #3) that opens straight into it. |
| queueExternalEmail — a separate, deliberate path for mail to non-members with address validation and an `external: true` metadata stamp | `lib/notifications.ts:124-147` | The internal/external distinction is already modelled. Locking down direct client INSERT on email_notifications (finding 4) has a ready-made replacement shape: this function moved behind a server route. |
| Deliberate DEFER-rather-than-destroy semantics when RESEND_API_KEY is absent, with an in-code post-mortem of the version that got it wrong | `app/api/notifications/send-queued/route.ts:65-83` | The hardest judgement call in the queue — what to do with mail you cannot send — has already been made correctly and documented. The remaining gap is purely that the caller discards the `configured:false`/`deferred` signal it returns. |
| Per-scan, per-org loud error reporting in the compliance cron | `app/api/cron/maintenance/route.ts:168-179` | The 'a permanently failing scan must be distinguishable from a clean one' principle is already stated and implemented for the seven compliance scans. Applying the same standard to the drain step and the two notification inserts in the same file is consistency work, not new design. |


---


<a id="deliv-1"></a>

## DELIV-1 · Any active org member can insert an arbitrary outbound email — free-text to_email, subject and body — that the drain sends from the org's verified Resend sender

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260605_rls_policies_new_tables.sql:121-124`, `app/api/notifications/send-queued/route.ts:140-153`, `lib/notifications.ts:124-147`

**Mechanism.** The only INSERT constraint on email_notifications is org membership. Nothing binds `to_email` to a member's address, nothing constrains `body_html`, nothing checks that `to_user_id` matches the actor. The drain runs with the service-role key and posts whatever it finds straight to Resend using `RESEND_FROM_EMAIL` as the From. The app-layer guards that DO exist — the address shape check in queueExternalEmail (notifications.ts:127-129) and the `external: true` metadata stamp — are pure client-side convention; a direct PostgREST insert with the user's own anon token bypasses them entirely.

**Failure scenario.** A Viewer-role contractor with a valid session posts one PostgREST insert to email_notifications with to_email set to a customer's address, a subject like "Revised P&ID issued for construction", and body_html containing a link to a site they control. The maintenance cron picks it up and Resend delivers it from the refinery's verified notifications@ domain, complete with SPF/DKIM alignment. There is no record distinguishing it from a system-generated transmittal.

**Evidence.**

```
-- the ONLY write constraint (20260605:121-124)
CREATE POLICY "email_notif_insert" ON email_notifications
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = email_notifications.org_id AND uid = auth.uid() AND status = 'active'));

// send-queued/route.ts:140-153 — sent verbatim, service role, org's From address
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { ..., "Authorization": `Bearer ${resendKey}` },
        body: JSON.stringify({
          from: fromEmail,
          to: row.to_email,
          subject: row.subject,
          text: row.body_text,
          html: row.body_html || undefined,
        }),
      });
```

**Chain reaction.** Because there is no SELECT policy (finding 1), no admin surface can enumerate what was queued — the same RLS gap that hides delivery failures also hides abuse of this vector.

> **Verifier correction.** Only refinement: exploitation requires an authenticated active member of the org (insider), and to_user_id is NOT NULL so it must be populated with some uuid — neither of which blocks the abuse, but it is not an unauthenticated vector.

**Done when.**

- [ ] Client INSERT on email_notifications is revoked; all queueing goes through a server route that fixes org_id/to_user_id/to_email from the authenticated session
- [ ] Or the WITH CHECK additionally requires `to_user_id = auth.uid()` for internal mail and routes external sends through a role-gated server path
- [ ] Outbound rows record the authenticated actor uid separately from to_user_id so a send can be attributed

---

<a id="deliv-2"></a>

## DELIV-2 · Every client-initiated email ignores the recipient's opt-out — queueEmail reads notification_preferences under the ACTOR's RLS, which only exposes the actor's own row

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/notifications.ts:52-61`, `supabase/migrations/20260605_rls_policies_new_tables.sql:110-115`, `lib/supabase.ts:110`, `app/(protected)/settings/notifications/page.tsx:126-135`

**Mechanism.** `notif_prefs_own` is `FOR ALL ... USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())`. queueEmail queries `.eq("user_id", input.toUserId)` — the RECIPIENT, not the actor — through the shared `supabase` client, which in the browser is the anon/user client. RLS filters the row out, `.maybeSingle()` returns `{data: null}` with no error, so `prefs` is null. All three gates (`prefs?.email_enabled === false`, `prefs?.digest_frequency === "never"`, `shouldSendForEvent(prefs, ...)` which returns `true` when prefs is null at line 153) fall through to send. The only paths where the check works are the ones that use a service-role client: the two ticket API routes (comment/route.ts:354, workflow-action/route.ts:354) and the cron after `__setServerSupabaseClient(sb)`.

**Failure scenario.** An engineer turns the master "Email notifications" switch off at /settings/notifications. Every notification routed through lib/notify/dispatch.ts `emit()` (holds, packages, intake, revisions, work packages) is produced client-side and calls queueEmail with the engineer's uid. The prefs lookup returns null, the opt-out is never seen, and they keep receiving email. The settings page's own copy — "Master switch. Off here means no email regardless of the per-event toggles below" — is false for every producer that isn't one of the three server routes.

**Evidence.**

```
// lib/notifications.ts:52-61
    const { data: prefs } = await supabase
      .from("notification_preferences")
      .select("*")
      .eq("user_id", input.toUserId)   // <- the RECIPIENT, not auth.uid()
      .maybeSingle();

    if (prefs?.email_enabled === false) return;
    if (prefs?.digest_frequency === "never") return;
    if (!shouldSendForEvent(prefs, input.eventType)) return;

-- 20260605_rls_policies_new_tables.sql:111-115
CREATE POLICY "notif_prefs_own" ON notification_preferences
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

// lib/notifications.ts:153 — null prefs means "send everything"
  if (!prefs) return true;
```

**Chain reaction.** lib/notify/dispatch.ts:105-106 documents the opposite as an invariant — "queueEmail already checks notification_preferences + dedupes within a 60s window, so per-user opt-outs are honored automatically" — so every future producer wired through emit() inherits the bug believing it is handled.

> **Verifier correction.** Severity lowered from CRITICAL to HIGH (unwanted mail to opted-out users, not lost mail or a safety failure). Two citation corrections: (a) the ticket API routes do NOT call queueEmail at all — app/api/tickets/comment/route.ts:282-299 and app/api/tickets/workflow-action/route.ts:350-379 do their own `supabaseAdmin.from("notification_preferences")` lookup plus a local `wantsEmail()`, so they honor prefs for a different reason than the finding states; the comment-route prefs line is 285, not 354. (b) There is a second, larger mitigation the finding misses: because the settings page can never write a prefs row while the default cadence is selected (see finding 14), in practice almost no notification_preferences rows exist at all, so the null-prefs default would apply even with correct RLS. Conditional on migration 20260605 having been applied.

**Done when.**

- [ ] Preference resolution for OTHER users happens server-side (a route or RPC with service-role/SECURITY DEFINER), or a read policy exposes the boolean columns to fellow active org members
- [ ] queueEmail distinguishes "no prefs row exists" from "prefs row hidden by RLS" — a null result from a client context must not silently mean all-on
- [ ] lib/notify/dispatch.ts's comment at 105 is corrected or the guarantee is made real
- [ ] A test asserts that queueEmail called from a non-service-role client for a user with email_enabled=false does not insert

---

<a id="deliv-3"></a>

## DELIV-3 · Every compliance notification kind falls into sectionCounts.other, which the sidebar computes and throws away — this is the mechanical cause of "the trail goes cold"

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:71-103`, `hooks/useTicketNotifications.ts:246-250`, `components/navigation/Sidebar.tsx:229-235`, `lib/inAppNotifications.ts:37-58`, `lib/storageAlerts.ts:60-62`

**Mechanism.** `sectionForKind()` enumerates ~20 kinds across requests/scratchpad/documents/projects and returns `'other'` for everything else. The `NotificationKind` union declares ~50 kinds. Every one added for the regulated workflows — ack_requested, ack_overdue, ack_complete, ack_unsatisfiable, review_due, review_requested, review_signed, review_invalidated, review_complete, review_overdue, review_alternate_activated, effective_now, retention_eligible, legal_hold_placed, legal_hold_released, access_recert_due, owner_assigned, owner_behind, deletion_requested, request_pending_approval (…which IS mapped), library_doc_added, library_doc_revised, revision_published_over_checkout, security_export, orchestrator_message, task_reminder — lands in 'other'. Sidebar.tsx is the only consumer of sectionCounts (grep across all .ts/.tsx returns exactly Sidebar.tsx:124/229/231/235 plus the hook itself) and it badges only `.documents`, `.projects` and `.requests`. `.other` and `.scratchpad` are tallied at line 248 and never read. On top of that, lib/storageAlerts.ts:61 and lib/storageUsage.ts:256 insert kinds (`storage_alert`, `storage_${key}`) that are not even in the NotificationKind union.

**Failure scenario.** An `ack_requested` arrives for an issued revision. The header bell total goes up by one. The Documents sidebar badge does NOT — ack_requested is 'other'. The user clicks Documents looking for the source of the alert, finds no badge on the library, none on the folder, none on the document, and gives up. That is complaint #1 verbatim, and the reason is not a missing library→folder→document cascade; it is that the item was never assigned to the Documents section at all. Even the kinds that ARE mapped to 'documents' stop at the top-level nav item — there is no per-library or per-document badge anywhere in the tree.

**Evidence.**

```
// hooks/useTicketNotifications.ts:100-102 — everything unlisted becomes 'other'
    default:
      return 'other';

// hooks/useTicketNotifications.ts:247-250 — 'other' and 'scratchpad' are tallied…
    const tally = (section: AttentionSection, actionReq: boolean) => {
      sectionCounts[section].total++;
      if (actionReq) sectionCounts[section].actionRequired++;
    };

// components/navigation/Sidebar.tsx:229-235 — …and only three of five are ever rendered
      { label: 'Documents', ..., ...badgeOf(sectionCounts.documents)   },
      { label: 'Projects',  ..., ...badgeOf(sectionCounts.projects) },
        ...badgeOf(sectionCounts.requests),
```

**Chain reaction.** components/notifications/NotificationBell.tsx:19-44's KIND_ICON map covers the same short list, so every compliance kind also renders with the generic fallback `Bell` icon — visually flattening exactly the items that carry regulatory weight.

> **Verifier correction.** Worth stating for whoever acts on this: the items are not invisible app-wide — the bell and /inbox render every item regardless of section (NotificationCenter → AttentionFeed over the unfiltered `items`). What is lost is specifically the sidebar breadcrumb, which is exactly owner complaint #1 ("the trail goes cold"), so HIGH/CONFIRMED stands.

**Done when.**

- [ ] sectionForKind maps every kind in the NotificationKind union (an exhaustive switch that fails typecheck when a kind is added)
- [ ] storage_alert / storage_* are added to the union so the compiler catches them
- [ ] The badge chain continues past the nav item: library, folder and document rows carry their own counts derived from resource_type/resource_id
- [ ] 'other' has a rendered home (or is eliminated), so no computed count is silently discarded

---

<a id="deliv-4"></a>

## DELIV-4 · The admin "No failed deliveries" panel is structurally incapable of ever reporting a failure — email_notifications has RLS on with an INSERT-only policy

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260605_rls_policies_new_tables.sql:120-124`, `app/(protected)/admin/settings/page.tsx:66-73`, `app/(protected)/admin/settings/page.tsx:87-100`, `app/(protected)/admin/settings/page.tsx:274-276`, `app/api/notifications/send-queued/route.ts:175`

**Mechanism.** 20260605 does `ALTER TABLE email_notifications ENABLE ROW LEVEL SECURITY` and then creates exactly ONE policy — `email_notif_insert ... FOR INSERT`. There is no SELECT and no UPDATE policy (grep for `email_notifications` across supabase/ returns only lines 117-124 of that file; schema.sql defines the table at 628 with no policies at all). The admin settings page queries the dead-letter count and runs the requeue with `supabase` — which is the browser anon/user client (lib/supabase.ts:110 `createClient(url, anon, ...)`). Under RLS with no SELECT policy the count comes back 0 with no error; under no UPDATE policy the requeue matches 0 rows and PostgREST returns success. Neither call checks `error`. So `failedEmails` is always 0, the page renders the green all-clear branch, and the Requeue button is a no-op.

**Failure scenario.** RESEND_API_KEY is briefly wrong (rotated key, wrong sender domain). Every queued email burns its 5 attempts and lands at `status:'failed'` (send-queued/route.ts:175). Those rows are now terminal — the drain's candidate query is `.in("status",["queued","failed"]).lt("attempt_count", 5)`, so nothing will ever retry them. The one recovery path shipped for this is the admin Requeue button. An admin opens /admin/settings, sees "No failed deliveries" in green, and closes the tab. Every ack_requested, review_overdue and effective_now escalation queued during that window is permanently undelivered, and the system's own dashboard asserts the opposite.

**Evidence.**

```
-- 20260605_rls_policies_new_tables.sql:120-124 (the ONLY policies on this table)
ALTER TABLE email_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "email_notif_insert" ON email_notifications;
CREATE POLICY "email_notif_insert" ON email_notifications
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = email_notifications.org_id AND uid = auth.uid() AND status = 'active'));

// admin/settings/page.tsx:66-73 — browser anon client, no error check
        const { count: dead } = await supabase
          .from("email_notifications")
          .select("id", { count: "exact", head: true })
          .eq("org_id", activeOrgId)
          .eq("status", "failed")
          .gte("attempt_count", 5);
        setFailedEmails(dead ?? 0);

// admin/settings/page.tsx:92-94 — update matches 0 rows, result discarded
      await supabase.from("email_notifications")
        .update({ status: "queued", attempt_count: 0 })
        .eq("org_id", activeOrgId).eq("status", "failed").gte("attempt_count", 5);

// admin/settings/page.tsx:274-276 — the false all-clear
          {failedEmails === 0 && (
            <div className="mt-3 text-[11px] text-emerald-700 ..."> No failed deliveries.</div>
```

**Chain reaction.** Because this surface is inert, nothing else in the app ever reads the `failed` bucket. app/api/admin/purge/route.ts:70 deliberately spares `failed` rows from purge, so they accumulate forever as invisible dead weight — counted against storage by lib/storageClassify.ts but never actionable.

> **Verifier correction.** Severity lowered from CRITICAL to HIGH: this is a false all-clear on a diagnostic panel, not a break in delivery itself (the cron drain runs with the service-role key and is unaffected). Also, the Requeue button is not a clickable no-op — it is inside `{failedEmails !== null && failedEmails > 0 && (...)}` at line 259, so with failedEmails permanently 0 it never renders at all. One caveat the finding does not state: migrations here are pasted by hand (see the SchemaHealthCard comment at the bottom of the same page), so on a database where 20260605 was never applied, RLS is off on this table and the panel works.

**Done when.**

- [ ] A SELECT policy on email_notifications restricted to org Admin/DocCtrl (or the count is moved behind a service-role API route)
- [ ] An UPDATE policy (or service-role route) that makes Requeue actually flip rows, with the affected-row count read back and displayed
- [ ] Both the count read and the requeue write destructure and surface `error` instead of `?? 0`
- [ ] The green "No failed deliveries" state is only rendered when a read demonstrably succeeded, not when it returned null/0

---

<a id="deliv-5"></a>

## DELIV-5 · Ticket notification emails carry root-relative links that are dead in any mail client — publicOrigin() exists and is not used; ticketUrl() is referenced only by its own test

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/comment/route.ts:264`, `app/api/tickets/comment/route.ts:310-317`, `app/api/tickets/workflow-action/route.ts:313`, `app/api/tickets/workflow-action/route.ts:387-393`, `lib/publicOrigin.ts:18-22`, `lib/notifications.ts:248-253`

**Mechanism.** Both server fan-outs build `const link = \`/requests/${ticketId}\`` and drop that string straight into `body_text` and into `<a href="${link}">Open ticket</a>` in `body_html`. There is no base URL. The codebase already solved this: `publicOrigin()` (lib/publicOrigin.ts:18) resolves NEXT_PUBLIC_SITE_URL with a documented rationale about links that leave the app, and `ticketUrl()` (notifications.ts:248) prefixes window.location.origin — but ticketUrl is server-unsafe (falls back to the same relative string at line 252) and two greps show its only consumer is lib/__tests__/notificationsLib.test.ts:16/95, whose assertion actually encodes the bug: `expect(ticketUrl("abc-123")).toBe("/requests/abc-123")`.

**Failure scenario.** An engineer is @-mentioned on an RFI. The email arrives; "Open ticket" resolves against mail.google.com or the Outlook client and 404s or does nothing. The recipient cannot reach the ticket from the notification. Because the in-app bell is separately capped (finding 8) and push does not exist (finding 7), the email was the escalation path — and it lands with an unusable call to action.

**Evidence.**

```
// app/api/tickets/comment/route.ts:264 and workflow-action/route.ts:313
  const link = `/requests/${ticketId}?c=${comment.id}`;

// app/api/tickets/comment/route.ts:315-317 — relative href inside outbound HTML
        <p><b>${escapeHtml(actorEmail)}</b> commented on <a href="${link}">${escapeHtml(ticketLabel)}</a>:</p>
        ...
        <p><a href="${link}">Open ticket</a></p>`,

// lib/publicOrigin.ts:18-22 — the correct helper, unused by any email producer
export function publicOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;

// lib/__tests__/notificationsLib.test.ts:97 — the test locks in the broken shape
    expect(ticketUrl("abc-123")).toBe("/requests/abc-123");
```

**Chain reaction.** Every other email producer inherits the same risk surface — the compliance digest (maintenance/route.ts:428-432) sidesteps it only by including no link at all, which trades a broken link for no link.

> **Verifier correction.** The test framing is unfair: lib/__tests__/notificationsLib.test.ts:95-98 is titled "falls back to an app-relative path with no window (server/test)" and vitest.config.ts sets `environment: "node"`, so the assertion documents the deliberate server fallback rather than "locking in the bug". Severity HIGH/CONFIRMED otherwise stands — a bare `/requests/...` href in an HTML email has no resolvable base.

**Done when.**

- [ ] Every email body composed server-side prefixes publicOrigin() (or an explicit absolute base) on links
- [ ] ticketUrl() is made absolute via publicOrigin() and its test updated, or it is deleted as dead
- [ ] A test asserts outbound body_html contains no href starting with a bare '/'

---

<a id="deliv-6"></a>

## DELIV-6 · Any active org member can plant a notification in anyone's bell with arbitrary title, body, link and actor_name — including actor_name 'System'

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260621_in_app_notifications.sql:52-61`, `supabase/migrations/20260723_notifications_unify.sql:44-52`, `hooks/useTicketNotifications.ts:293-297`, `components/providers/NotificationListener.tsx:84-98`

**Mechanism.** `notifications_org_insert` WITH CHECK validates only that the inserting user is an active member of `notifications.org_id`. It does not constrain `user_id` (the recipient), `actor_user_id`, `actor_name`, `kind`, `title`, `body`, or `link`. The migration's own comment concedes this — "The kind/body are validated at the app layer" — but the app layer is client code the attacker is replacing. The bell renders `n.title` / `n.body` / `n.link` directly, and NotificationListener pops a toast for every INSERT matching `user_id=eq.${uid}` with no provenance check.

**Failure scenario.** A user inserts rows for every Admin and DocCtrl in the org with `kind:'ack_requested'`, `actor_name:'System'`, `title:'Read & acknowledge: Rev C of PSM-0142'`, and `link:'https://evil.example/login'`. Each target sees a real-time toast (NotificationListener:92-97) and a bell row indistinguishable from a genuine compliance obligation. In a PSM/OSHA workflow where acks are the audit trail, a forged ack request is a forged control record.

**Evidence.**

```
-- 20260723_notifications_unify.sql:44-52 (identical in 20260621:52-61)
CREATE POLICY notifications_org_insert ON notifications FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM org_members
    WHERE org_members.org_id = notifications.org_id
      AND org_members.uid = auth.uid()
      AND org_members.status = 'active'
  )
);

// hooks/useTicketNotifications.ts:293 — attacker-supplied link rendered as the destination
        link: n.link || (n.resourceId ...
```

**Chain reaction.** lib/inAppNotifications.ts:79-98 `notify()` swallows insert errors by design, so the app has no notion of an insert being rejected — meaning nobody would notice if a policy were tightened either. There is no audit_logs row written for notification inserts, so a forged obligation leaves no counter-evidence.

> **Verifier correction.** Severity lowered from HIGH to MEDIUM. This is an insider-only in-app spoofing/phishing surface, and the permissive INSERT is the deliberate architecture for client-side fan-out (both migrations say so in comments) — it is not an accidental hole, and it does not affect delivery integrity of legitimate notifications. Note also there is no `actor_name = 'System'` special-casing in the renderers I read, so the 'System' angle carries no extra privilege beyond the string itself.

**Done when.**

- [ ] WITH CHECK additionally requires `actor_user_id = auth.uid()` and that the recipient is an active member of the same org
- [ ] `kind` is constrained to the known enum (CHECK constraint or a lookup table) so a caller cannot mint a compliance kind
- [ ] Either `link` is constrained to app-relative paths, or the bell refuses to render off-origin hrefs
- [ ] System-generated notifications are distinguishable from member-generated ones by something a member cannot set

---

<a id="deliv-7"></a>

## DELIV-7 · Fire-and-forget by design: no notification insert anywhere is retried, and most swallow their error — including four inside the cron that count successes they never verified

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/inAppNotifications.ts:79-98`, `lib/notify/dispatch.ts:83-84`, `app/api/cron/maintenance/route.ts:355-356`, `app/api/cron/maintenance/route.ts:423-437`, `app/api/tickets/comment/route.ts:268-281`, `lib/projects.ts:1116-1118`, `lib/postPublish.ts:171-183`

**Mechanism.** `notify()` catches the PostgREST error, `console.warn`s it, and resolves void — the doc comment states this is intentional ("Errors are logged but never re-raised"). `notifyMany()` Promise.all's those void-returning calls, so a partial fan-out failure is indistinguishable from success. A case-insensitive grep for retry/retries/backoff across lib/inAppNotifications.ts, lib/notifications.ts, lib/notify/ and hooks/useTicketNotifications.ts returns only three console.warn strings about the email cron — there is NO retry for in-app inserts anywhere. Server-side inserts are worse: comment/route.ts:268, workflow-action/route.ts:325 and :335, intake/upload/route.ts:104/197/349, transmittal/route.ts:149, data-export/run/route.ts:54 and projects.ts:1116 all `await ...insert(...)` without destructuring `error` at all. maintenance/route.ts:355 does capture the error but only to gate a counter (`if (!insErr) escalated += 1`) and never pushes to `result.errors`; queueComplianceDigests at 423 does not check at all yet increments `queued`. `emit()` returns silently whenever recipients resolve empty (dispatch.ts:84), so an RLS-filtered follower lookup notifies nobody with no trace.

**Failure scenario.** A `notifications` insert is rejected — a transient connection error, a future NOT NULL/CHECK constraint, or an RLS tightening. `notify()` logs to a browser console nobody is reading and the calling flow reports success. The recipient is never told. Nothing retries, nothing queues, nothing alerts. For the cron path, `escalateStaleCheckouts` returns a number the operator reads as "3 stale checkouts escalated" while three inserts failed, and `queueComplianceDigests` returns a count of digests it never confirmed were written.

**Evidence.**

```
// lib/inAppNotifications.ts:74-98
/**
 * Insert one notification row. Fire-and-forget by design — callers
 * shouldn't block their main flow on the bell-icon write. Errors are
 * logged but never re-raised.
 */
export async function notify(input: NotificationInput): Promise<void> {
  try {
    const { error } = await supabase.from("notifications").insert({ ... });
    if (error) console.warn("[notify] insert failed", error.message);
  } catch (e) {
    console.warn("[notify] insert threw", e);
  }
}

// app/api/cron/maintenance/route.ts:355-356 — error captured, never reported
    const { error: insErr } = await sb.from("notifications").insert(inserts);
    if (!insErr) escalated += 1;

// app/api/cron/maintenance/route.ts:423,437 — not checked, counted anyway
    await sb.from("email_notifications").insert({ ... });
    queued += 1;

// lib/notify/dispatch.ts:83-84 — nobody resolved, silently
  const recipients = await resolveRecipients(input);
  if (recipients.length === 0) return;
```

**Chain reaction.** Because in-app inserts have no durable queue (unlike email_notifications), a swallowed failure is unrecoverable — there is no row to find later, no attempt_count, no dead-letter. The email path at least has a queue table; the bell, which the app treats as the primary channel, has none.

> **Verifier correction.** One sub-claim is speculative: "an RLS-filtered follower lookup notifies nobody with no trace" — subscriptions carries `subscriptions_org_select` (20260723:71-78) granting org-wide SELECT to active members, so follower resolution is not RLS-blinded for the normal in-org case. The silent empty-recipient return is real; the RLS scenario given for it is not demonstrated.

**Done when.**

- [ ] notify() reports failure to its caller (return boolean or throw) and callers that carry a regulatory obligation surface it
- [ ] Compliance-critical kinds (ack_*, review_*, effective_now, legal_hold_*) are inserted transactionally with the action they attest to, or land in a retryable outbox like email_notifications
- [ ] Every server-side notifications/email_notifications insert destructures `error`; the cron pushes failures into result.errors instead of gating counters on them
- [ ] emit() logs/returns when the audience resolves empty so a silent zero-recipient fan-out is observable

---

<a id="deliv-8"></a>

## DELIV-8 · Suppressed email rows older than 7 days are unrecoverable by design and then purge-eligible — a permanent, silent loss with no record of what was dropped

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `app/api/notifications/send-queued/route.ts:85-94`, `app/api/admin/purge/route.ts:70`, `app/api/admin/purge/route.ts:161`, `supabase/migrations/20260529_phase_b_notifications.sql:47-48`

**Mechanism.** The recovery pass resurrects `status='suppressed'` rows only where `created_at >= now() - 7 days`. Anything older stays suppressed forever: it is excluded from the drain's candidate query (`.in("status",["queued","failed"])`) and there is no other writer or reader of that status — greps for `suppressed` across the repo hit only send-queued:93 and the two purge branches. The purge route then treats `suppressed` as a delivered byproduct alongside `sent` and deletes it after ≥7 days, with the stated rationale "Outbound emails already sent or suppressed. The delivery is done." For suppressed rows the delivery was never attempted.

**Failure scenario.** An operator stands up the app, runs it for three weeks without RESEND_API_KEY under the older code path that flipped rows to `suppressed`, then configures the key. The first drain recovers the last 7 days. The prior two weeks of ack requests, review nudges and transmittal notices are silently abandoned. An admin later runs the storage purge, and those rows — the only evidence anything was owed — are deleted, categorised in the UI as "delivered".

**Evidence.**

```
// send-queued/route.ts:85-94 — recovery deliberately bounded to 7 days
  // Recover rows the pre-deferral code destroyed ... Only the last 7 days —
  // older notifications are stale enough that a surprise blast hurts more
  // than the silence did.
  await supabase
    .from("email_notifications")
    .update({ status: "queued", attempt_count: 0, error_message: null })
    .eq("status", "suppressed")
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

// app/api/admin/purge/route.ts:42 — and then classified as delivered
    reason: "Outbound emails already sent or suppressed. The delivery is done; the queue row is a disposable byproduct.",

// app/api/admin/purge/route.ts:161
          t.table === "email_notifications" ? base.in("status", ["sent", "suppressed"]) :
```

**Chain reaction.** The same purge deletes `notifications WHERE read_at IS NOT NULL` older than the cutoff (min 7 days). Those rows are the dedupe watermark for lib/distributionAcks.ts:227-233, lib/storageAlerts.ts:56-59, lib/storageUsage.ts:250-254 and maintenance/route.ts:322-329 — purging them silently re-arms nags the system believes it already sent.

> **Verifier correction.** Downgraded to SUSPECTED because the consequence is not observable from this repo. My grep for `suppressed` across all .ts/.tsx/.sql (11 hits) shows NO current code path that ever writes that status — it exists only in the CHECK constraints (schema.sql:640, 20260529:48), the type union (types/schema.ts:1071), the recovery update, the purge branches, and a test comment (lib/__tests__/apiRouteAuth.test.ts:221). Whether any suppressed rows exist at all depends entirely on whether a given deployment ran the pre-deferral code, which cannot be read here. Also "permanent silent loss with no record of what was dropped" is overstated: until an admin runs the purge the rows are still in the table with their full subject/body, and for events that dual-write, the in-app notification row remains. The legitimate residual finding is the purge's misclassification of 'suppressed' as delivered.

**Done when.**

- [ ] Aging out a suppressed row is an explicit, audited decision (an admin-visible list of what will be abandoned) rather than a silent time cutoff
- [ ] Suppressed rows are excluded from purge, or purged only after being reported
- [ ] Dedupe watermarks used by the compliance scans are stored somewhere purge does not reach

---

<a id="deliv-9"></a>

## DELIV-9 · The 60-second burst dedupe in queueEmail never fires from the browser — same RLS blindness — so a single workflow event mails each person once per producer

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/notifications.ts:64-75`, `supabase/migrations/20260605_rls_policies_new_tables.sql:120-124`, `lib/notify/dispatch.ts:107-129`

**Mechanism.** The dedupe probe SELECTs from `email_notifications`, which (see finding 1) has no SELECT policy for `authenticated`. From the browser the query returns `data: []` with no error, so `dupes && dupes.length > 0` is never true and the guard is permanently open. The comment above it claims it "prevents burst-spam when a workflow action triggers multiple watchers + assignments simultaneously" — exactly the case it cannot handle. It only works from the cron, where `__setServerSupabaseClient(sb)` (maintenance/route.ts:156) has swapped in the service-role client.

**Failure scenario.** A publish fans out through emit(): the same user is in `audience.involved`, is a subscriber of the document, AND is a member of the project. resolveRecipients() dedupes them to one uid, so dispatch.ts is safe — but the same publish also triggers postPublish's separate notifySuperseded and notifyPackagesOfRetirement paths, each calling queueEmail independently within the same second. The DB-level guard that was supposed to collapse those is inert, and the user gets three near-identical emails. Recipients learn to filter the sender, which is the failure mode that actually loses the ack_requested mail.

**Evidence.**

```
// lib/notifications.ts:64-75
    // Dedupe: if the same recipient got the same event for the same resource
    // within the last 60 seconds, suppress this one (prevents burst-spam ...
    const sixtySecAgo = new Date(Date.now() - 60_000).toISOString();
    const { data: dupes } = await supabase
      .from("email_notifications")
      .select("id")
      .eq("to_user_id", input.toUserId)
      .eq("event_type", input.eventType)
      .eq("resource_id", input.resourceId || "")
      .gte("created_at", sixtySecAgo)
      .limit(1);
    if (dupes && dupes.length > 0) return;   // <- data is always [] under RLS
```

**Chain reaction.** An index was built specifically to serve this query — `email_notifications_dedupe_idx ON email_notifications(to_user_id, resource_id, event_type, created_at DESC)` (20260529:63-64) — so the storage cost is paid for a guard that never runs.

> **Verifier correction.** Severity lowered from HIGH to MEDIUM. The consequence is duplicate/near-duplicate emails, not dropped or misrouted ones, and it is narrower than "once per producer": inside a single emit() each recipient gets exactly one queueEmail call (dispatch.ts:107-129 maps over a deduped recipient set), so duplicates require two producers firing for the same user action within 60s. The server fan-outs that do the bulk of ticket mail (comment/workflow-action) build their rows directly and never use this guard anyway.

**Done when.**

- [ ] Dedupe is enforced where it can see the rows: a partial unique index / ON CONFLICT on (to_user_id, event_type, resource_id, time-bucket), or a service-role route
- [ ] Or a SELECT policy scoped to `to_user_id = auth.uid()` plus a server-side path for cross-user checks
- [ ] The `?? []`-style silent-empty result is distinguished from a real empty queue

---

<a id="deliv-10"></a>

## DELIV-10 · The bell shows at most 50 unread rows and counts only what it fetched — older unread obligations are permanently invisible, and countUnread() is dead code

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:176-177`, `hooks/useTicketNotifications.ts:312`, `lib/inAppNotifications.ts:157-174`, `lib/inAppNotifications.ts:176-185`, `lib/inbox.ts:163-165`, `components/notifications/NotificationCenter.tsx:76-80`

**Mechanism.** `listMyNotifications({ onlyUnread: true, limit: 50, orgId })` orders `created_at DESC` and truncates at 50. The hook then returns `count: items.length` — the badge is literally the length of the truncated array. There is no cursor, no "load more", and no total. `countUnread()` (inAppNotifications.ts:176-185), which would give the true number, is called from nowhere — two differently-shaped greps (bare `countUnread` across all .ts/.tsx excluding node_modules/.next, and the same case-insensitively) return only its own definition. Meanwhile lib/inbox.ts:163-165 computes a SECOND unread count that is uncapped AND not org-scoped (`.eq("user_id", userId).is("read_at", null)` with no `org_id` filter), surfaced as `unreadNotificationCount`.

**Failure scenario.** A DocCtrl in a busy workspace accrues 120 unread rows over a quarter. The oldest 70 — which by `created_at DESC` ordering are exactly the longest-outstanding obligations, the `ack_overdue` and `review_overdue` ones — fall off the end of the query. They are not in the bell, not in the NotificationCenter (which filters the same `items` array, NotificationCenter.tsx:76-85), and not in the count. The badge reads a plausible number and the user has no signal that anything was elided. Simultaneously /inbox shows a different, larger number spanning every workspace they belong to, so the two surfaces visibly disagree — the exact thing NotificationCenter.tsx:6-9 claims is impossible ("the list can never disagree with the number that opened it").

**Evidence.**

```
// hooks/useTicketNotifications.ts:176-177
        let n = await listMyNotifications({ onlyUnread: true, limit: 50, orgId: activeOrgId })
          .catch(() => [] as NotificationRow[]);

// hooks/useTicketNotifications.ts:311-312 — the badge IS the truncated array length
    /** The single count every surface badges (the header bell + Home). */
    count: items.length,

// lib/inbox.ts:163-165 — a second, uncapped, NOT org-scoped unread count
    // Unread notification count
    supabase.from("notifications").select("*", { count: "exact", head: true })
      .eq("user_id", userId).is("read_at", null),
```

**Chain reaction.** The `.catch(() => [])` on line 177 means an RLS error, a network blip, or a Postgres timeout on that query yields an EMPTY notification list and a badge of just the ticket count — a transient fetch failure renders as "all caught up" rather than as an error.

> **Verifier correction.** Two overstatements. (1) "Permanently invisible" is wrong: the query is onlyUnread + created_at DESC, so as newer rows are marked read the window slides and older unread rows surface on the next fetch (the hook refetches on every realtime notifications event, lines 222-226). The real defect is an understated badge and no load-more, not permanent loss. (2) The second count is not "surfaced": `unreadNotificationCount` appears only at lib/inbox.ts:110/249/309 and in lib/__tests__/nudges.test.ts:12 — two greps found no component reading it, so no user ever sees the org-unscoped number. Severity lowered to MEDIUM accordingly.

**Done when.**

- [ ] The badge uses a real count (countUnread, or a `count:'exact'` on the same query) independent of the page size
- [ ] The feed paginates — a cursor on created_at with a "N more" affordance — so nothing is silently below the fold
- [ ] Oldest-unread items are reachable (e.g. action-required kinds sorted or filtered ahead of the cap)
- [ ] lib/inbox.ts's unread count is org-scoped so it agrees with the bell
- [ ] The `.catch(() => [])` distinguishes "no unread" from "the query failed"

---

<a id="deliv-11"></a>

## DELIV-11 · The maintenance cron reports a clean run when email is unconfigured or when every send in the batch fails — `sent ?? processed` short-circuits on a legitimate zero

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/cron/maintenance/route.ts:103-117`, `app/api/cron/maintenance/route.ts:204-214`, `app/api/notifications/send-queued/route.ts:70-83`, `app/api/notifications/send-queued/route.ts:186`

**Mechanism.** The drain loop reads `const batch = body?.sent ?? body?.processed ?? 0`. `??` only falls through on null/undefined, and the route ALWAYS returns a numeric `sent`. So `sent: 0` is taken as the batch size regardless of `processed`. Two consequences: (a) when RESEND_API_KEY is unset the route returns `{processed:0, sent:0, failed:0, deferred: <backlog>, configured:false, note:"..."}` — the loop sees batch 0, breaks, discards `deferred` and `configured`, and sets `notificationsDrained = 0` with `errors: []`; (b) when a full batch of 100 is attempted and every send throws, the route returns `{processed:100, sent:0, failed:100}` — again batch 0, again break, again `notificationsDrained: 0` and no error. The second drain pass (204-214) is worse still: `if (!res.ok) break;` with no error push, wrapped in `catch { /* the daily drain will catch up */ }`.

**Failure scenario.** The Resend sender domain's DNS lapses. Every night the cron attempts 100 sends, all 502, all fail, and the JSON response reads `notificationsDrained: 0, errors: []` — byte-identical to a night with an empty queue. Five nights later every one of those rows has burned MAX_ATTEMPTS and is terminal `failed` (send-queued:175), which is precisely the bucket the admin panel cannot see (finding 1). The system detected the outage at every layer and reported success at every layer.

**Evidence.**

```
// app/api/cron/maintenance/route.ts:108-112
      if (!res.ok) { result.errors.push(`notifications: HTTP ${res.status}`); break; }
      const body = (await res.json().catch(() => null)) as { sent?: number; processed?: number } | null;
      const batch = body?.sent ?? body?.processed ?? 0;   // sent:0 is NOT nullish
      drained += batch;
      if (batch === 0) break; // queue empty

// send-queued/route.ts:75-82 — the deferred/configured signal the loop discards
    return NextResponse.json({
      processed: 0, sent: 0, failed: 0,
      deferred: count ?? 0,
      configured: false,
      note: "RESEND_API_KEY is not set — emails left queued ...",
    });

// app/api/cron/maintenance/route.ts:210-214 — second pass swallows everything
      if (!res.ok) break;
      ...
    } catch { /* the daily drain will catch up */ }
```

**Chain reaction.** maintenance/route.ts:170-178 goes to real trouble to make compliance-scan failures loud and per-org ("a permanently failing scan must be distinguishable from a clean one") — the drain step, which is the last mile for every one of those notices, is the one step that violates that principle.

> **Verifier correction.** Severity lowered from HIGH to MEDIUM. The queue itself is not damaged in either scenario — unconfigured rows are deliberately left queued (the route's own comment at 64-69), and failed rows are re-queued with attempt_count incremented (send-queued 172-179) until MAX_ATTEMPTS. The defect is reporting-only plus a premature loop exit, and for the all-fail case breaking out of the loop is arguably correct behavior; the genuine bug is the silent discard of `configured:false`/`deferred` and the empty `errors` array.

**Done when.**

- [ ] The loop reads `processed` for continuation and surfaces `configured:false`/`deferred` as an explicit result field plus an error entry
- [ ] A batch where `failed > 0` pushes an error naming the count and a sample error_message
- [ ] The second drain pass reports rather than swallowing
- [ ] A run where the queue was non-empty and nothing sent is textually distinguishable from an empty-queue run

---

<a id="deliv-12"></a>

## DELIV-12 · The notification preferences page cannot save in its default state — it writes digest_frequency:'immediate' against a CHECK constraint that only accepts 'instant'

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/settings/notifications/page.tsx:29-40`, `app/(protected)/settings/notifications/page.tsx:80-90`, `app/(protected)/settings/notifications/page.tsx:152`, `supabase/schema.sql:660`, `supabase/migrations/20260529_phase_b_notifications.sql:77-78`

**Mechanism.** The table constrains `digest_frequency TEXT NOT NULL DEFAULT 'instant' CHECK (digest_frequency IN ('instant','hourly','daily','never'))`. The page's `Prefs` type declares `"immediate" | "hourly" | "daily" | "never"`, `DEFAULTS` sets `digest_frequency: "immediate"`, the cadence buttons render the literal list `["immediate","hourly","daily","never"]`, and `save()` upserts the whole `prefs` object. Any save with the default (or explicitly chosen) "immediate" violates the CHECK; the upsert error is thrown and shown in the red banner.

**Failure scenario.** A user decides the email volume is too much (a volume that findings 2 and 3 guarantee is inflated) and goes to /settings/notifications to turn the master switch off. They have never saved before, so digest_frequency is "immediate". Save fails with a raw Postgres constraint message. The only way through is to first click "Hourly", "Daily" or "Never" — and Hourly/Daily are labelled in the page's own copy as not implemented. The opt-out is unreachable by the obvious path, which compounds finding 2: users who cannot opt out and whose opt-out would be ignored anyway.

**Evidence.**

```
-- supabase/schema.sql:660 (and 20260529:77-78)
  digest_frequency TEXT NOT NULL DEFAULT 'instant' CHECK (digest_frequency IN ('instant','hourly','daily','never')),

// settings/notifications/page.tsx:30 and :39
  digest_frequency: "immediate" | "hourly" | "daily" | "never";
...
  digest_frequency: "immediate",

// settings/notifications/page.tsx:152
            {(["immediate", "hourly", "daily", "never"] as const).map((opt) => (

// settings/notifications/page.tsx:82-85 — whole object upserted, error surfaced raw
      const { error: upsertErr } = await supabase
        .from("notification_preferences")
        .upsert({ user_id: uid, ...prefs }, { onConflict: "user_id" });
      if (upsertErr) throw upsertErr;
```

**Chain reaction.** lib/notifications.ts:60 and both ticket routes test `digest_frequency === "never"`, and no code anywhere reads "instant" or "immediate" — so the column's only functional value is 'never'. The mismatch has been invisible because almost nobody successfully writes the row.

> **Verifier correction.** Impact is larger than MEDIUM suggests, and it compounds findings 2 and 3: `grep -rn "notification_preferences"` shows this upsert is the ONLY writer of the table anywhere in the codebase (the cron and the two ticket routes only read it). Since a first-time user has no row and therefore always carries the default "immediate", the first save always violates the CHECK — so a user can only ever persist preferences by first clicking hourly/daily/never, and the value 'immediate' can never be stored at all. In practice that means the table is near-empty, which is why the null-prefs "send everything" default at lib/notifications.ts:153 governs almost every send.

**Done when.**

- [ ] The UI value is 'instant' (or the CHECK is widened and the constraint/UI agree), verified by a test that upserts DEFAULTS against the real constraint
- [ ] The Prefs type is derived from a single shared constant so UI and schema cannot drift again
- [ ] Hourly/Daily are either implemented or removed rather than offered with a disclaimer

---

<a id="deliv-13"></a>

## DELIV-13 · Users can rewrite and delete their own compliance notifications — the UPDATE policy has only USING, so the whole row is editable, not just read_at

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260723_notifications_unify.sql:38-41`, `supabase/migrations/20260621_in_app_notifications.sql:44-46`, `supabase/migrations/20260621_in_app_notifications.sql:65-67`, `lib/inAppNotifications.ts:187-205`

**Mechanism.** `notifications_own_update ... FOR UPDATE USING (user_id = auth.uid())` supplies no WITH CHECK. Per the composition rule, Postgres reuses USING as the check — which correctly stops re-assigning the row to another user, but places no constraint whatsoever on `title`, `body`, `link`, `kind`, `metadata`, or `created_at`. The app only ever writes `read_at` (inAppNotifications.ts:188/195/202), but the policy grants far more. `notifications_own_delete` grants an unconditional hard delete of one's own rows.

**Failure scenario.** An engineer receives `kind:'review_overdue'` — "Your sign-off on Rev B is 21 days late". Rather than acting, they issue one PostgREST DELETE on that row id, or UPDATE its title/created_at. It is gone from their bell, from the /inbox cockpit, and from the maintenance cron's 25-hour compliance-digest window (maintenance/route.ts:375-381 selects from `notifications`). The scans in lib/reviewControl.ts will re-notify on the next run, but the record that they were told on day 21 no longer exists — and for the dedupe-by-notification-row scans (lib/distributionAcks.ts:227-233, lib/storageAlerts.ts:56-59) deletion actively resets the cooldown.

**Evidence.**

```
-- 20260723_notifications_unify.sql:38-41 — USING only, plus unconditional delete
DROP POLICY IF EXISTS notifications_own_update ON notifications;
CREATE POLICY notifications_own_update ON notifications FOR UPDATE USING (user_id = auth.uid());
DROP POLICY IF EXISTS notifications_own_delete ON notifications;
CREATE POLICY notifications_own_delete ON notifications FOR DELETE USING (user_id = auth.uid());

-- 20260621_in_app_notifications.sql:63-64 openly frames delete as a convenience
-- Optional: let users hard-delete their own notifications. Useful for a
-- "clear all" UI action.

// lib/inAppNotifications.ts:188 — the app only ever needs this one column
  await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
```

**Chain reaction.** lib/distributionAcks.ts:227-233 and app/api/cron/maintenance/route.ts:322-329 both treat existing notification rows as the dedupe watermark for "we already nagged/escalated this". A recipient deleting their own row silently re-arms those nags; a recipient editing metadata can suppress them.

> **Verifier correction.** Severity lowered from HIGH to MEDIUM and the compliance framing is overstated. These rows are the user's own bell copies, not the record of record — the lasting record is audit_logs (app/api/admin/purge/route.ts:36 says exactly that), and hard-delete is an explicitly designed product feature. The realistic abuse is self-tampering (hiding your own obligation), and even that is limited: server-side compliance scans re-derive obligations from source tables on each cron run rather than from the notifications table, so deleted rows are regenerated rather than permanently suppressing the obligation.

**Done when.**

- [ ] The UPDATE policy carries a WITH CHECK that pins every column except read_at to its prior value (or updates go through a `mark_notification_read(id)` SECURITY DEFINER RPC and the broad policy is dropped)
- [ ] The DELETE policy is dropped in favour of a soft dismiss, or restricted to already-read non-compliance kinds
- [ ] Dedupe watermarks for the cron scans move off user-mutable notification rows onto a table users cannot write

---

<a id="deliv-14"></a>

## DELIV-14 · Web push is a phantom channel: table, preference column and service-worker handler all ship, but nothing subscribes a device and nothing sends — 100% of that channel is dropped

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:223-238`, `supabase/migrations/20260804_push_subscriptions.sql:7-35`, `supabase/migrations/20260723_notifications_unify.sql:85-87`, `lib/notify/dispatch.ts:20`

**Mechanism.** `push_subscriptions` exists with full RLS, `notification_preferences.push_enabled BOOLEAN NOT NULL DEFAULT TRUE` exists, and public/sw.js has a complete `push` + `notificationclick` implementation whose comment says "the reminder cron sends" it. But: (a) three differently-shaped greps for `pushManager`, `applicationServerKey`, `vapid`/`VAPID` and `web-push` across all .ts/.tsx/.js/.json outside node_modules return zero hits; (b) `push_subscriptions` appears in .ts only inside lib/schemaExpectations.ts:99, lib/exportTables.ts:167 and lib/dataRestore.ts:92 — metadata lists, never a read or write; (c) `push_enabled`/`pushEnabled` has zero references in any .ts/.tsx; (d) `NotifChannel` in the dispatcher is typed `"inapp" | "email"` only; (e) .env.example has no VAPID keys and package.json has no web-push dependency. No device is ever registered and no sender exists, so `self.addEventListener("push", ...)` can never fire.

**Failure scenario.** This is the owner's complaint #2 with a receipt: outside an open browser tab there is no delivery presence at all. The only in-session signal is the NotificationListener toast (NotificationListener.tsx:92-97), which requires the app to be open and focused; the only out-of-session signal is email, which is separately compromised by findings 1-3. A `hold_opened` on a live P&ID at 02:00 reaches nobody until someone happens to open the app.

**Evidence.**

```
/* public/sw.js:223-238 — a receiver with no transmitter */
self.addEventListener("push", (event) => {
  ...
  event.waitUntil(self.registration.showNotification(title, options));
});

-- 20260723_notifications_unify.sql:85-87 — a preference with no reader
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS inapp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS push_enabled  BOOLEAN NOT NULL DEFAULT TRUE;

// lib/notify/dispatch.ts:20 — the dispatcher does not model push at all
export type NotifChannel = "inapp" | "email";
```

**Chain reaction.** lib/schemaExpectations.ts:99 lists push_subscriptions as an expected table, so the /admin/settings Schema Health card will nag operators to apply a migration for a subsystem that has no code. `.env.example`'s CRON_SECRET comment also references a `reminders/run` route that does not exist in app/api — the same removed subsystem left two more vestiges.

> **Verifier correction.** Severity lowered from HIGH to MEDIUM. Nothing is dropped, because nothing is ever produced for this channel and no user-facing surface offers or promises push — push_enabled has no UI (the settings page at app/(protected)/settings/notifications/page.tsx never references it). This is dead scaffolding plus a false code comment, i.e. the gap behind owner complaint #2, not a delivery failure.

**Done when.**

- [ ] Either the push channel is built end-to-end (VAPID env, pushManager.subscribe writing push_subscriptions, a sender in the drain/cron, `"push"` added to NotifChannel and honored against push_enabled)
- [ ] Or the dead scaffolding is removed: the sw.js push handlers, the push_subscriptions expectation, and push_enabled — so the schema stops promising a channel that drops everything
- [ ] Whichever path, the notifications settings page states honestly what channels exist

---
