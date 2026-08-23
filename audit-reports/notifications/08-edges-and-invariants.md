# 08 · Edges, egress & load-bearing invariants

**13 findings** — 2 CRITICAL · 7 HIGH · 4 MEDIUM.

What the seven lenses did not look at — notification content as an egress surface, lifecycle edges, accessibility — plus what is sound and must not break.

> ### Verification record — this file has now been checked
>
> This report was the completeness critic's output and originally shipped with a
> banner saying its findings had **not** been through the adversarial refutation
> pass the other reports had. That pass has now been run by hand against the
> source. The banner is replaced by this record.
>
> **Method.** Every `CRITICAL` and every `HIGH` was re-read against the cited
> code, including at least one negative search per absence claim. `MEDIUM`
> findings were not individually re-verified and are marked below — treat those
> as `SUSPECTED` and reproduce first, exactly as `DEC-29` requires.
>
> | ID | Result |
> |---|---|
> | `NEDGE-1` | **CONFIRMED.** The 26/48 split was recomputed by diffing the `NotificationKind` union against `sectionForKind`'s `case` labels programmatically. Exact. |
> | `NEDGE-2` | **CONFIRMED verbatim.** Every quoted line matches. `grep -rn "'immediate'" supabase/` returns **nothing** — the token appears in no SQL file — and `digest_frequency` has exactly one definition with no later `ALTER`. |
> | `NEDGE-3` | **HALF CONFIRMED — see the correction on the finding.** The role path already filters on active membership *and* already reads the additive `roles` array. The follower path does not filter at all. |
> | `NEDGE-4` | **CONFIRMED verbatim.** `const link = \`/requests/${ticketId}\`` at `comment/route.ts:263` and `workflow-action/route.ts:313`, interpolated straight into `<a href>`, and `send-queued` passes `body_html` to Resend unmodified. |
> | `NEDGE-5` | **CONFIRMED.** `grep -c "aria-live\|aria-label\|role="` returns **0** for both `NotificationBell.tsx` and `ToastProvider.tsx`. |
> | `NEDGE-6` | Not individually re-verified. Treat as `SUSPECTED`. |
> | `NEDGE-7` | **CONFIRMED.** `notifications_own_select` is `USING (user_id = auth.uid())` with **no org predicate** (`20260723_notifications_unify.sql:37`). A removed member's auth account still matches their old rows. |
> | `NEDGE-8` | Not individually re-verified. Treat as `SUSPECTED`. |
> | `NEDGE-9` | Not individually re-verified. Treat as `SUSPECTED`. |
> | `NEDGE-10`–`NEDGE-13` | `MEDIUM`, not individually re-verified — **except** the `push_enabled` / `inapp_enabled` claim inside `NEDGE-13`, which is **CONFIRMED**: a repo-wide search finds no reader outside `exportTables.ts`. |
>
> One finding from the same pass is worth naming here because it corroborates
> `OS-1`: the insert policy's own migration comment reads *"Any active org member
> may insert a notification for any recipient in the org (so a client action can
> fan out to others). **Validated at the app layer.**"*
> (`20260723_notifications_unify.sql:42-45`). The hole is deliberate and
> documented; what is missing is the validation it defers to.


### Already there — reusable substrate

| Thing | Where | Why it matters |
|---|---|---|
| Atomic compare-and-swap claim in the email drain — a concurrent second drain provably cannot double-send a queued email | `app/api/notifications/send-queued/route.ts:121-130` | The claim updates status to 'sending' filtered on `.in("status", ["queued", "failed"])` and `.select("*")` back only the rows THIS invocation won; a racing drain's guard matches nothing and it exits with `if (queued.length === 0) return NextResponse.json({ processed: 0 });`. Two callers exist by design — the browser kick from kickEmailDrain() and the daily cron — so the race is real and constant, not theoretical. Any refactor that reads-then-writes, batches differently, or moves the status flip after the Resend call reintroduces duplicate delivery of hold and supersede notices. The 15-minute orphan reclaim at lines 100-104 is the matching half: it only re-queues rows stranded in 'sending' past a window far longer than any real send, so it can never steal a row from a live run. |
| Missing-API-key path DEFERS the email backlog instead of destroying it, with an explicit recovery for the older code that destroyed it | `app/api/notifications/send-queued/route.ts:69-92` | When RESEND_API_KEY is absent the route returns a count and leaves every row untouched at 'queued', and the comment records that an earlier version flipped them to a terminal 'suppressed' state which 'permanently destroyed every email queued before configuration'. Lines 86-92 then recover those historical rows (bounded to 7 days so configuring a key does not blast a stale backlog). This is a hard-won invariant: a notification system for a regulated app must never silently terminalise undelivered mail. Any future 'clean up the queue' work must preserve both halves — the deferral and the 7-day recovery bound. |
| 60-second per-(recipient, event, resource) burst dedupe on the email queue | `lib/notifications.ts:63-75` | One workflow action commonly resolves the same person through several audience sources at once — involved[], followers, a role pool and project membership all union in resolveRecipients. The dedupe query on (to_user_id, event_type, resource_id, created_at >= 60s ago) is what stops a single rev-up from mailing one engineer four times. It is the only burst protection in the system and it lives on the queueEmail path only — note that the compliance digest and the two ticket routes insert into email_notifications directly and therefore do not have it, so any consolidation must move this guard down to the insert, not delete it. |
| notifyMany drops the actor and dedupes recipients before fan-out | `lib/inAppNotifications.ts:117-120` | `input.userIds.filter((u) => u && u !== input.actorUserId)` wrapped in a Set, plus the early return on an empty list, is the single reason nobody is notified about their own action and nobody gets two bell rows from one event. emit() relies on this defensively even though resolveRecipients already deletes the actor at dispatch.ts:77 — the belt-and-braces is deliberate because raw notifyMany callers exist that never go through emit(). Both layers must survive. |
| Bell reads, unread count and mark-all-read are all scoped to the active workspace | `lib/inAppNotifications.ts:169, lib/inAppNotifications.ts:181, lib/inAppNotifications.ts:203` | RLS restricts notifications to the user but not to an org (the SELECT policy is `user_id = auth.uid()` with no org predicate), so without these app-layer `.eq("org_id", orgId)` filters a multi-workspace user's badge would count items the current workspace's portal can never list, and a single 'mark all read' would silently clear another workspace's queue. The comments at lines 165-168 and 198-200 record exactly why. Any change to the badge or the notification centre must keep passing orgId through — and note this is a convenience, not a boundary, so tightening the RLS policy (see the removed-member finding) is additive to it, not a replacement. |
| All user-supplied text in the two HTML email templates is escaped, and the escaper is shared | `app/api/tickets/comment/route.ts:310-312, app/api/tickets/workflow-action/route.ts:390-394, lib/ticketTransitions.ts:378` | Actor email, ticket label, status, action label and the comment/note body all pass through escapeHtml before interpolation into the HTML body, so a comment containing markup cannot inject into a colleague's mail client. This is correct today and the one thing about these templates that must not regress while the relative-href defect is fixed — a rewrite that switches to a template literal builder or a component-based renderer needs to carry the escaping forward for every interpolation, including any new ones. |
| The transmittal portal is correctly scoped: item allowlist, as-sent revision pinning, void check, short-lived signed URLs, and an audit row per download | `app/api/transmittal/route.ts:60-84, app/api/transmittal/route.ts:37-56` | Token possession is the whole credential, so the containment is what makes it safe: the token regex bounds the input, a voided transmittal answers 410, `items.find((i) => i.documentId === fileDoc)` refuses any document not on this transmittal with a 403, fileKeyForItem resolves the pinned versionId or matches the as-sent revision label — 'never silently the newest' — the signed URL expires in 300 seconds, and every download writes a TRANSMITTAL_PORTAL_DOWNLOAD audit row with the doc number and rev. This is the highest-risk surface in the notification system (unauthenticated, external, hands out controlled documents) and it is the best-built one. Any work on transmittal emails must not touch these five guarantees. |
| Global prefers-reduced-motion rule that neutralises every animation utility, including infinite loops | `app/globals.css:385-392` | `.animate-in, [class*="animate-"] { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }` covers utilities that do not exist yet, which means the owner's requested spinning bell and pulsing counting-up badge will be automatically safe for reduced-motion users on the day they are built — provided they are implemented as animation utilities and the underlying count stays readable as static text. A hand-rolled requestAnimationFrame counter or a CSS transition (transitions are NOT covered by this rule) would escape it. Keep the animation-class route. |
| Global mention regex resets lastIndex before every scan | `lib/notifications.ts:178, lib/notifications.ts:194` | MENTION_RE is a module-level /gi regex shared by extractMentionUids and tokenizeMentions. Both set `MENTION_RE.lastIndex = 0;` before their exec loop, which is the only thing preventing the classic stateful-regex bug where the second call on the same tick silently skips the first mention. Since extractMentionUids decides who gets a mention notification at all, that bug would drop notifications nondeterministically. Anyone refactoring mention parsing must either keep the reset or stop sharing the regex instance. |
| Notification side effects are isolated from the transaction that caused them — a failed signal can never roll back a publish | `lib/postPublish.ts:11-13, lib/postPublish.ts:62-64, lib/holds.ts:253, lib/inAppNotifications.ts:94-97, lib/notify/dispatch.ts:107` | notifySuperseded wraps its two emit() calls in a try/catch that only warns ('the publish already committed; signals must never roll it back'), notifyHold swallows entirely, and notify() logs rather than re-raising. This is the invariant that keeps a Resend outage or an RLS hiccup from failing a revision publish in a document-control system. It is also the reason silent notification failures are hard to see — so improvements should add observability (a counter, an audit row) rather than converting these to throwing paths. |
| Per-(org, user, day) digest dedupe keyed in the notification metadata | `app/api/cron/maintenance/route.ts:410-419` | Before composing, the digest queries email_notifications for an existing row with the same org, recipient, event_type 'compliance_digest' and `.contains("metadata", { day: dayKey })`. Because /api/cron/maintenance is reachable by both GET and POST and can be invoked manually as well as on schedule, this is the only thing stopping a re-run from mailing everyone their compliance list twice. Fixing the digest's preference and read_at defects must preserve this guard (and ideally move the dayKey off the server's UTC day, per the timezone finding, without losing the dedupe itself). |


---


<a id="nedge-1"></a>

## NEDGE-1 · 26 of 48 notification kinds — the entire compliance and governance family — tally into a sidebar bucket no sidebar entry ever reads, so a legal hold, an overdue acknowledgment or a due periodic review never badges anything

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:68`, `hooks/useTicketNotifications.ts:100-102`, `hooks/useTicketNotifications.ts:246-250`, `components/navigation/Sidebar.tsx:229`, `components/navigation/Sidebar.tsx:231`, `components/navigation/Sidebar.tsx:235`, `lib/inAppNotifications.ts:38-58`
- **Re-verified:** hardening pass — **SURVIVES**. `sectionForKind` ends `default: return 'other'` (`useTicketNotifications.ts:100-102`), and `AttentionSection` is `'requests' | 'scratchpad' | 'documents' | 'projects' | 'other'` (`:68`) — `'other'` is a real bucket with no sidebar entry reading it.

**Mechanism.** sectionForKind() maps a NotificationKind onto one of five AttentionSection values and ends with `default: return 'other';`. The hook tallies every item into sectionCounts[section] (line 248). The Sidebar reads exactly three of the five buckets — sectionCounts.documents, sectionCounts.projects, sectionCounts.requests. A full census of `sectionCounts|SectionCounts` across the repo returns only those three call sites plus the hook's own definition and tally; nothing anywhere reads sectionCounts.other or sectionCounts.scratchpad. A set-difference of the declared union (lib/inAppNotifications.ts:10-58, 48 kinds) against the switch's case labels shows 26 kinds fall through to 'other': revision_published_over_checkout, library_doc_added, library_doc_revised, project_comment, task_reminder, review_due, owner_assigned, owner_behind, deletion_requested, ack_requested, ack_complete, ack_overdue, ack_unsatisfiable, review_requested, review_signed, review_invalidated, review_complete, review_overdue, review_alternate_activated, effective_now, retention_eligible, legal_hold_placed, legal_hold_released, access_recert_due, orchestrator_message, security_export. A 27th kind, storage_alert, is inserted by lib/storageAlerts.ts:61 via a raw table insert and is not even in the typed union.

**Failure scenario.** Document control places a legal hold on a P&ID. lib/retention.ts fans out `legal_hold_placed` to the owner and every Admin/DocCtrl. Each recipient gets a bell row and an email. sectionForKind('legal_hold_placed') hits the default branch and returns 'other'; sectionCounts.other is incremented; nothing renders it. The Documents sidebar entry shows no badge, the Projects entry shows no badge, the Requests entry shows no badge. Identically for ack_overdue (an assignee long past due to acknowledge an issued revision), review_overdue, access_recert_due and retention_eligible. The owner's complaint is that the trail goes cold after the section badge — for the entire PSM/OSHA compliance family the trail never starts, because the top-level badge is silently discarded one line before it would be rendered.

**Evidence.**

```
useTicketNotifications.ts:68  `export type AttentionSection = 'requests' | 'scratchpad' | 'documents' | 'projects' | 'other';`
useTicketNotifications.ts:100-102  `    default:\n      return 'other';\n  }`
useTicketNotifications.ts:247-250  `const tally = (section: AttentionSection, actionReq: boolean) => {\n      sectionCounts[section].total++;\n      if (actionReq) sectionCounts[section].actionRequired++;\n    };`
Sidebar.tsx:229  `{ label: 'Documents', ... ...badgeOf(sectionCounts.documents)   },`
Sidebar.tsx:231  `{ label: 'Projects',  ... ...badgeOf(sectionCounts.projects) },`
Sidebar.tsx:235  `        ...badgeOf(sectionCounts.requests),`
```

**Chain reaction.** The bell count (`count` from the same hook) DOES include these items, so the bell shows 7 while every sidebar section shows nothing. That mismatch is exactly the symptom the owner describes as 'the trail goes cold' and it will be misdiagnosed as a propagation problem in the Documents tree, when the defect is a missing case label in a switch. Any fix that pushes badges further down the library→folder→document chain will still show zero for all 26 kinds.

**Done when.**

- [ ] Every member of the NotificationKind union has an explicit case in sectionForKind — enforce it with an exhaustiveness check (`const _never: never = kind`) in the default branch so a newly declared kind fails the typecheck instead of silently bucketing to 'other'
- [ ] storage_alert is added to the NotificationKind union and lib/storageAlerts.ts routes through notify() rather than a raw insert, so the type system sees it
- [ ] Either sectionCounts.other is surfaced on a real sidebar destination, or the compliance kinds are mapped onto 'documents' — and a test asserts sectionCounts.other stays empty for the kinds the app actually emits

---

<a id="nedge-2"></a>

## NEDGE-2 · The notification preferences page can never save for any user who has not already saved: the UI writes digest_frequency='immediate', the CHECK constraint only permits 'instant'

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/settings/notifications/page.tsx:30`, `app/(protected)/settings/notifications/page.tsx:40`, `app/(protected)/settings/notifications/page.tsx:69`, `app/(protected)/settings/notifications/page.tsx:86`, `app/(protected)/settings/notifications/page.tsx:151`, `supabase/migrations/20260529_phase_b_notifications.sql:77`, `supabase/schema.sql:660`
- **Re-verified:** hardening pass — **SURVIVES**, and the mismatch is exact. The page's type and `DEFAULTS` both use `digest_frequency: "immediate"` (`:30, :40`); the column is `CHECK (digest_frequency IN ('instant','hourly','daily','never'))` with default `'instant'` — `20260529_phase_b_notifications.sql:77-78`, mirrored at `schema.sql:660`. `'immediate'` is not in the set, so the first save for any user without an existing row violates the constraint.

**Mechanism.** The page's Prefs type, DEFAULTS, load-fallback and cadence button list all use the string "immediate". The table constrains the column to ('instant','hourly','daily','never') — 'immediate' is not a member. save() spreads the whole prefs object into one upsert (`.upsert({ user_id: uid, ...prefs })`), so digest_frequency rides along on EVERY save regardless of which toggle the user actually touched. Postgres rejects the row with a check_violation; the catch block at line 91 renders the raw error and none of the toggles persist. The condition is self-perpetuating: a user with no row loads DEFAULTS ("immediate"), and any save attempt fails, so they can never reach a state where a valid value is stored. Only a user who deliberately clicks Hourly/Daily/Never before saving can ever persist anything. Two independent searches over supabase/ (literal 'instant', and the digest_frequency column across all migrations) found no later ALTER relaxing or widening the CHECK.

**Failure scenario.** An engineer is drowning in watcher-activity email. They open /settings/notifications (linked from the bell at NotificationBell.tsx:153, from /profile, from /admin/settings, and from the `g n` command-palette shortcut), toggle "Watched activity" off, and click Save preferences. The upsert carries digest_frequency='immediate'. Postgres raises `new row for relation "notification_preferences" violates check constraint`. The red error box appears, no preference is stored, and the email keeps coming. Every subsequent attempt fails identically. The entire per-user preference system — the only opt-out mechanism in the product — is inert for every user who has never saved.

**Evidence.**

```
page.tsx:30  `digest_frequency: "immediate" | "hourly" | "daily" | "never";`
page.tsx:40  `digest_frequency: "immediate",`
page.tsx:86  `.upsert({ user_id: uid, ...prefs }, { onConflict: "user_id" });`
page.tsx:151 `{(["immediate", "hourly", "daily", "never"] as const).map((opt) => (`
20260529_phase_b_notifications.sql:77-78  `digest_frequency TEXT NOT NULL DEFAULT 'instant'\n    CHECK (digest_frequency IN ('instant','hourly','daily','never')),`
```

**Chain reaction.** Because no preference row can be created, every consumer that reads prefs takes the missing-row branch and defaults to all-on: lib/notifications.ts:153 `if (!prefs) return true;`, tickets/comment/route.ts:296 `if (!p) return true;`, workflow-action/route.ts:365 `if (!p) return true;`. So the observable behaviour of the whole app is "opt-outs silently do nothing", which is indistinguishable from the dispatcher ignoring preferences — a maintainer chasing 'my mute doesn't work' will look in lib/notify/dispatch.ts and find the preference plumbing correct.

**Done when.**

- [ ] The page's cadence values and the DB CHECK use one shared vocabulary (either rename the UI value to 'instant' or migrate the constraint to accept 'immediate'), with the load-fallback at page.tsx:69 mapping legacy 'instant' rows onto whichever token wins
- [ ] A test asserts that saving the DEFAULTS object round-trips through notification_preferences without error
- [ ] save() surfaces a check-violation distinctly rather than dumping err.message, so a future vocabulary drift is diagnosable

---

<a id="nedge-3"></a>

## NEDGE-3 · Deactivated members keep receiving both bell rows and email: the follower and email-lookup queries have no status filter, while the role-pool query does

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/notify/recipients.ts:23-45`, `lib/notify/dispatch.ts:135-147`, `lib/notify/recipients.ts:48-62`, `app/api/admin/restore/begin/route.ts:68`, `app/api/admin/restore/apply/route.ts:64`, `supabase/schema.sql:42`

> **Half confirmed, half refuted — the surviving half is the follower path.**
>
> **Refuted:** the role path is already correct. `resolveRoleRecipients`
> (`lib/notify/recipients.ts:47-62`) filters `.eq("status", "active")` **and**
> already prefers the additive array:
> `const held = m.roles && m.roles.length > 0 ? m.roles : m.role ? [m.role] : []`.
> A deactivated member is not reachable through role routing, and this function
> is **not** an instance of the headline-role defect.
>
> **Confirmed:** `resolveFollowers` (`lib/notify/recipients.ts:22-45`) reads
> `subscriptions` rows and the ticket's `watchers` array and applies **no
> membership filter of any kind**. A deactivated member who watched a ticket or
> subscribed to a library keeps receiving notifications indefinitely.
>
> Rework this finding against the follower path only. An agent who reads the
> original title and "fixes" `resolveRoleRecipients` will be editing correct code.

**Mechanism.** org_members.status is constrained to ('active','invited','suspended','inactive') and non-active rows are genuinely created — both restore routes insert members with `status: "inactive"`. Three recipient-resolution paths treat status inconsistently. resolveRoleRecipients filters `.eq("status", "active")`. resolveFollowers does not touch org_members at all — it reads subscriptions by resource_type + resource_id only (and reads tickets.watchers), so a suspended member's watch rows keep resolving. emailsFor filters on org_id and uid but NOT on status, so a suspended member still has an org_members row with an email and receives mail. The result is a matrix nobody would predict: suspend a user and they stop being reached by role broadcasts but keep being reached by everything they ever watched, on both channels. Remove them entirely and the asymmetry inverts — emailsFor finds no row so email stops, but notifyMany still inserts a bell row for them because the notifications INSERT policy validates the ACTOR's membership, not the recipient's.

**Failure scenario.** An engineer is suspended pending an investigation (status → 'suspended'). They remain a watcher on 40 drawings and 6 tickets. Over the following weeks every rev-up, every hold, every branch on those documents resolves them through resolveFollowers, inserts a bell row, finds their still-present email in org_members, and mails them the document number and the hold reason at their personal-forwarded address. Their app access is revoked; their notification firehose is not. Meanwhile a role broadcast to Admin/DocCtrl correctly skips them, so a spot check of 'does a suspended user get notified?' against the role path returns a reassuring no.

**Evidence.**

```
recipients.ts:26-30  `  const { data: subs } = await supabase\n    .from("subscriptions")\n    .select("user_id")\n    .eq("resource_type", resource.type)\n    .eq("resource_id", resource.id);`
dispatch.ts:138-142  `  const { data } = await supabase\n    .from("org_members")\n    .select("uid, email")\n    .eq("org_id", orgId)\n    .in("uid", uids);`
recipients.ts:52-54  `    .select("uid, role, roles")\n    .eq("org_id", orgId)\n    .eq("status", "active");`
schema.sql:42  `  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended', 'inactive')),`
admin/restore/begin/route.ts:68  `      status: "inactive", display_name: u.displayName ?? null,`
```

**Chain reaction.** The restore path makes this reachable without any admin ever suspending anyone: /api/admin/restore inserts every reconciled user as status 'inactive'. After a restore, the whole membership is inactive — role broadcasts go to nobody (resolveRoleRecipients returns an empty set, so Admin/DocCtrl compliance alerts silently stop), while follower fan-out and email keep running for everyone. That is a silent, total loss of the compliance broadcast channel immediately after a disaster recovery, which is exactly when it matters.

**Done when.**

- [ ] resolveRecipients filters the final recipient set against active org membership once, centrally, rather than each source deciding — including the involved[] list, which today is never membership-checked
- [ ] emailsFor adds `.eq("status", "active")`
- [ ] A test covers: suspended watcher gets neither bell nor email; active watcher gets both; and a post-restore all-inactive org is caught by an explicit assertion or a restore-completion step that reactivates members

---

<a id="nedge-4"></a>

## NEDGE-4 · Every internal notification email carries a relative href, so the one call-to-action link in the message is dead in every mail client; emails sent through emit() carry no link at all

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/comment/route.ts:263`, `app/api/tickets/comment/route.ts:309-313`, `app/api/tickets/workflow-action/route.ts:313`, `app/api/tickets/workflow-action/route.ts:389-394`, `lib/notify/dispatch.ts:116-127`, `lib/notifications.ts:16-27`, `app/api/cron/maintenance/route.ts:425-431`

**Mechanism.** Three separate defects converge on the same outcome. (a) The two routes that do build HTML emails construct `const link = \`/requests/${ticketId}\`` — a root-relative path — and interpolate it straight into `<a href="${link}">Open ticket</a>` and into the tail of body_text. An email has no base URL, so a relative href resolves against nothing; Gmail/Outlook render it inert or strip it. (b) EmitInput carries a `link` field (dispatch.ts:31) used for the bell row, but the email branch at dispatch.ts:116-127 passes subject/bodyText/bodyHtml/resourceType/resourceId/eventType/metadata and never passes link — QueueEmailInput (lib/notifications.ts:16-27) has no link field to pass it to. (c) A census of `email: {` overrides across every emit() caller returns nothing, so all 17 emit() call sites take the defaults `subject: input.title`, `bodyText: input.body ?? input.title` — a bare sentence with no URL. (d) The compliance digest body ends 'Open your Inbox to act on them.' with no URL. ticketUrl() at lib/notifications.ts:248 does build an absolute URL but its only caller is its own unit test.

**Failure scenario.** A hold is placed on a drawing. lib/holds.ts emits; dispatch.ts queues an email whose entire body is `Jane Doe placed a "MOC pending" hold. Work from this document should stop until it's released.` There is no link. The recipient must go find the document by hand. Separately, an engineer is @-mentioned on a ticket; they receive an HTML email whose 'Open ticket' button points at href="/requests/8f3a…" — clicking it in Outlook does nothing, or in a webmail client resolves to mail.google.com/requests/8f3a… and 404s. In both cases the notification names an obligation and gives no route to it, which is the email-side mirror of the owner's trail-goes-cold complaint.

**Evidence.**

```
tickets/comment/route.ts:263  `const link = \`/requests/${ticketId}?c=${comment.id}\`;`
tickets/comment/route.ts:313  `        <p><a href="${link}">Open ticket</a></p>\`,`
tickets/workflow-action/route.ts:313  `const link = \`/requests/${ticketId}\`;`
dispatch.ts:120-124  `          subject: input.email?.subject ?? input.title,\n          bodyText: input.email?.bodyText ?? input.body ?? input.title,\n          bodyHtml: input.email?.bodyHtml,\n          resourceType,\n          resourceId: input.resource.id,`
maintenance/route.ts:430  `        "\\n\\nOpen your Inbox to act on them.",`
```

**Chain reaction.** lib/publicOrigin.ts already exists and documents precisely this class of bug ('those URLs get scanned by phones in the field… They must point at the PUBLIC production domain'), but nothing on the email path imports it — publicOrigin() has 9 callers and all of them are QR/print surfaces. The fix is available and unused, which means an author reading the email code has no signal that a helper exists.

**Done when.**

- [ ] QueueEmailInput gains a `link` field, dispatch.ts forwards input.link, and every email body renders it as an absolute URL built from publicOrigin()
- [ ] The two HTML templates build `const link = \`${publicOrigin()}/requests/${ticketId}\`` and a test asserts every queued body_html contains no href beginning with a bare '/'
- [ ] The compliance digest body carries an absolute /inbox URL

---

<a id="nedge-5"></a>

## NEDGE-5 · Every notification surface is invisible to assistive technology: no aria-live region, no accessible name on the bell, no role on toasts, unnamed dismiss controls

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/notifications/NotificationBell.tsx:99-112`, `components/notifications/NotificationBell.tsx:114-127`, `components/notifications/NotificationBell.tsx:129-130`, `components/providers/ToastProvider.tsx:57-58`, `components/providers/ToastProvider.tsx:90-95`, `components/ui/CornerDock.tsx:23-27`

**Mechanism.** A targeted search for aria-live, role="status", role="alert", aria-atomic, sr-only and aria-label across components/notifications/, components/providers/, CornerDock.tsx, UndoToastHost.tsx and Sidebar.tsx returns four hits total, none of them on a notification surface (they are 'Notification center', 'Dismiss' on UploadIndicator, and two sidebar collapse controls). Consequences, each read directly from the JSX: (1) The header bell button carries only `title=` and its rendered content is a lucide `<Bell>` svg plus a `<span>` containing the raw count — content wins over title for the accessible name, so the button announces as '7, button'. (2) There is no live region anywhere, so a realtime-inserted notification changes the badge from 6 to 7 with zero announcement. (3) The dropdown at line 130 is a plain `<div>` — no role="dialog"/"menu", no aria-modal, no aria-expanded/aria-haspopup on the trigger, and focus is neither moved in on open nor returned on close. (4) Toasts render into a plain `<div className="flex flex-col gap-2 pointer-events-none">` with no role and no aria-live, then auto-dismiss after 5000ms — a screen-reader user is never told a toast appeared and it is gone before they could find it. (5) The toast close button contains only an `<X>` icon and has no aria-label, so it announces as an unnamed button.

**Failure scenario.** A screen-reader user on the platform tabs through the header. The bell announces '7, button' — no indication it is notifications, no indication seven items need attention. They activate it; focus stays on the button while a list renders below, unannounced and unreachable by their reading order until they hunt for it. Meanwhile a background AI-ingestion toast fires bottom-right, is never announced, and disappears after five seconds. They dismiss the drawer with Escape (which does work, line 76) having learned nothing. For a PSM/OSHA-regulated system where the notification is the mechanism that tells someone a document they are working from has been superseded, the alert channel does not exist for them.

**Evidence.**

```
NotificationBell.tsx:99-112  `        <button\n          onClick={() => setOpen((v) => !v)}\n          title={unread > 0 ? \`${unread} need${unread === 1 ? "s" : ""} attention\` : "Notifications"}\n          className={…}\n        >\n          <Bell className="w-4 h-4" />\n          {unread > 0 && (\n            <span className="absolute -top-0.5 -right-0.5 …">\n              {unread > 99 ? "99+" : unread}\n            </span>\n          )}\n        </button>`
ToastProvider.tsx:58  `      <div className="flex flex-col gap-2 pointer-events-none">`
ToastProvider.tsx:90-95  `            <button \n              onClick={() => removeToast(toast.id)}\n              className="text-[var(--color-text-faint)] hover:text-[var(--color-text)] transition-colors"\n            >\n              <X className="w-4 h-4" />\n            </button>`
CornerDock.tsx:23-26  `    <div\n      id={DOCK_ID}\n      className="fixed bottom-4 right-4 z-[300] flex flex-col items-end gap-2 pointer-events-none"\n    />`
```

**Chain reaction.** Three of the owner's six requests make this worse rather than better if implemented as stated: a bell that spins while the badge pulses and counts up (request 3) is a purely visual channel; a dismissible corner login banner (request 3) and stacked bottom-right background-job cards (request 5) both land in the CornerDock, which is a bare unlabelled div. Every new signalling surface built on today's foundations inherits zero accessibility.

**Done when.**

- [ ] The bell button gets an explicit aria-label ('Notifications, 7 need attention'), aria-haspopup + aria-expanded, and the count span is aria-hidden with the number carried in the label
- [ ] A single polite live region (aria-live="polite" aria-atomic="true") announces unread-count changes, and the CornerDock gets role="region" aria-live="polite" so toasts and job cards announce on insert; errors use role="alert"
- [ ] The dropdown becomes a labelled dialog with focus moved in on open and restored on close (Escape handling at line 76 is already correct and must be preserved)
- [ ] Every icon-only control on these surfaces has an aria-label — starting with the toast dismiss at ToastProvider.tsx:90

---

<a id="nedge-6"></a>

## NEDGE-6 · Notification titles broadcast document numbers and free-text hold reasons to every Admin and DocCtrl and out through Resend, with no ACL consultation anywhere on the notify path — defeating the 'hidden' node visibility the ACL layer implements

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/holds.ts:238-252`, `lib/branches.ts:141-148`, `lib/notify/dispatch.ts:120`, `lib/notify/recipients.ts:48-62`, `types/schema.ts:81`, `lib/acl.ts:207`, `app/api/cron/maintenance/route.ts:421-426`

**Mechanism.** notifyHold() reads the document row, builds `label` from document_number/title/name, and puts BOTH the label and the caller-supplied free-text `reason` into the notification title, then sets `audience: { followers: true, roles: ["Admin", "DocCtrl"] }`. resolveRoleRecipients returns every active org member holding that role — it filters on org and status only. A targeted grep for `from "@/lib/acl"`, evaluateAcl, canBlindDrill and buildAclIndex across lib/notify/, lib/inAppNotifications.ts, lib/notifications.ts, lib/postPublish.ts, lib/holds.ts and lib/subscriptions.ts returns nothing: the notification path never evaluates an ACL. types/schema.ts:81 declares `NodeVisibility = "normal" | "hidden" | "private"` and lib/acl.ts implements hidden nodes with explicit discover grants (canBlindDrill at line 207), so a document CAN be concealed from a specific user who nevertheless holds DocCtrl. The bell row names it anyway. Worse, dispatch.ts:120 uses `subject: input.email?.subject ?? input.title`, so the same string — document number plus hold reason — becomes the SUBJECT LINE of an email that leaves the ACL boundary entirely and lands in the recipient's mail provider. The compliance digest then re-aggregates up to 12 such titles verbatim into a single plaintext email.

**Failure scenario.** Counsel places a hold with reason 'litigation hold — Baytown incident, do not distribute' on drawing PID-4412-R3, a document ACL-restricted to a three-person team. lib/holds.ts fans out to every Admin and DocCtrl in the org. A DocCtrl who cannot open PID-4412 receives a bell row titled `HOLD placed on PID-4412-R3 — litigation hold — Baytown incident, do not distribute` and an email with that exact subject line. The next morning the compliance digest re-lists the same title alongside eleven others in a plaintext email. The document remains unreadable to them; its identity, its restricted status and counsel's stated reason are not.

**Evidence.**

```
holds.ts:242-244  `      title: input.opened\n        ? \`HOLD placed on ${label} — ${input.reason}\`\n        : \`Hold released on ${label}\`,`
holds.ts:252  `      audience: { followers: true, roles: ["Admin", "DocCtrl"] },`
branches.ts:142-143  `      title: \`Unreconciled branch opened on ${input.documentLabel}\`,\n      body: \`${input.actorName} published a branch based on an older revision… : "${input.reason}". It must be merged or withdrawn…\`,`
dispatch.ts:120  `          subject: input.email?.subject ?? input.title,`
recipients.ts:51-54  `    .from("org_members")\n    .select("uid, role, roles")\n    .eq("org_id", orgId)\n    .eq("status", "active");`
types/schema.ts:81  `export type NodeVisibility = "normal" | "hidden" | "private";`
```

**Chain reaction.** Because there is no DELETE path on the notifications table anywhere in the app (a full census of `from("notifications")` returns only insert/select/update, and a second case-insensitive delete-shaped search returns nothing), the leaked title is permanent. The only removal is /api/admin/purge, which is manual, Admin-gated and restricted to `read_at IS NOT NULL` — an unread leaked title is unreachable by any cleanup.

**Done when.**

- [ ] emit() takes a redaction policy: role-broadcast audiences receive a generic title ('A document you administer was placed on hold') and the identifying label/reason only in the bell body for recipients who pass an ACL check, or behind the link
- [ ] Free-text reasons never enter an email subject line — dispatch.ts uses a category-derived subject for role-broadcast categories rather than falling back to input.title
- [ ] resolveRoleRecipients (or emit) filters role recipients against evaluateAcl for document-scoped resources, honouring NodeVisibility 'hidden'

---

<a id="nedge-7"></a>

## NEDGE-7 · Removing a member deletes only the org_members row; the notifications RLS SELECT policy has no org-membership predicate, so a removed member keeps permanent read access to the full archive of alerts about documents they can no longer open

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/users/page.tsx:176-181`, `supabase/migrations/20260723_notifications_unify.sql:36-37`, `supabase/migrations/20260621_in_app_notifications.sql:40-41`, `lib/inAppNotifications.ts:157-174`, `app/api/admin/purge/route.ts:70`

**Mechanism.** handleRemoveMember performs a single `supabase.from('org_members').delete().eq('id', member.id)` and nothing else — no cleanup of notifications, subscriptions, email_notifications or notification_preferences. The notifications SELECT policy, in both the original 20260621 migration and the authoritative 20260723 rewrite, is `USING (user_id = auth.uid())` with no join to org_members and no org predicate. The removal explicitly does not delete the login account ('This does not delete their login account, and you can re-add them later'), so the person retains a valid JWT identity. listMyNotifications applies an org filter only when the caller passes opts.orgId (line 169) — that is an app-layer convenience, not a boundary; a direct PostgREST call with their token returns every row where user_id = their uid, across every org, forever. There is no DELETE on the notifications table anywhere in the app (verified by a full census of `from("notifications")` and by a second, delete-shaped case-insensitive search), and /api/admin/purge only ever touches rows where read_at IS NOT NULL.

**Failure scenario.** A contract engineer is let go and removed from the workspace. Their org_members row is deleted; the app immediately denies them every document. Their Supabase auth account still exists. Using their still-valid session token they query the notifications table directly and receive every title and body ever addressed to them: `HOLD placed on PID-4412-R3 — litigation hold, Baytown incident`, `SPEC-220-A advanced to Rev 4`, `Unreconciled branch opened on PID-3301 … "vendor changed the nozzle schedule"`, complete with actor names and timestamps. Nothing in the removal flow, in RLS, or in the purge endpoint can take that away — the purge is org-scoped and skips unread rows, and the app has no delete path at all.

**Evidence.**

```
admin/users/page.tsx:178  `      const { error } = await supabase.from('org_members').delete().eq('id', member.id);`
20260723_notifications_unify.sql:36-37  `DROP POLICY IF EXISTS notifications_own_select ON notifications;\nCREATE POLICY notifications_own_select ON notifications FOR SELECT USING (user_id = auth.uid());`
inAppNotifications.ts:167-169  `  // user; this restricts to the workspace they're actually looking at.\n  if (opts?.orgId) q = q.eq("org_id", opts.orgId);`
admin/purge/route.ts:70  `    table === "email_notifications" ? base.in("status", ["sent", "suppressed"]) :`
```

**Chain reaction.** The same policy shape governs UPDATE and DELETE (lines 38-41), so a removed member can also mark rows read or delete them — meaning they can destroy their own notification history before an investigator looks at it, in a system whose whole premise is an auditable PSM/OSHA record. And because member removal leaves the subscriptions rows in place, a re-added member silently resumes every prior watch, while a never-re-added one keeps accruing new rows (see the deactivated-recipient finding).

**Done when.**

- [ ] notifications_own_select gains an org-membership predicate: `USING (user_id = auth.uid() AND EXISTS (SELECT 1 FROM org_members WHERE org_id = notifications.org_id AND uid = auth.uid() AND status = 'active'))`, and the same for UPDATE/DELETE
- [ ] handleRemoveMember (or a server route behind it) deletes the member's subscriptions rows for that org and either deletes or org-tombstones their notifications, inside a transaction with the org_members delete
- [ ] A test exercises the removed-member case: after deletion, a query with that user's token returns zero notifications for the org

---

<a id="nedge-8"></a>

## NEDGE-8 · Restoring an org silently destroys every watch/follow relationship, because the restore skip-list mistakes the watch table for Stripe billing state

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:85-93`, `lib/subscriptions.ts:1-5`, `lib/subscription.ts:3-5`, `supabase/migrations/20260622_subscriptions.sql:13`, `supabase/migrations/20260723_notifications_unify.sql:55`, `lib/exportTables.ts:159`

**Mechanism.** SKIP_TABLES lists `subscriptions` with the justification 'billing state is owned by the payment provider — re-subscribe, never copy'. There is exactly one table named subscriptions in the schema — a search for every `CREATE TABLE …subscription` across supabase/ returns 20260622_subscriptions.sql:13, its idempotent re-creation at 20260723_notifications_unify.sql:55, and schema.sql:689, all the same watch/follow table (org_id, user_id, resource_type, resource_id). Billing state is not in a table at all: lib/subscription.ts:3-5 states 'The data lives on the orgs table (subscription_status, trial_ends_at, current_period_end)'. So the skip entry is a pure name collision. The table IS exported (lib/exportTables.ts:159 includes 'subscriptions'), so the backup contains the follow graph — it is the restore that throws it away, and reports doing so on purpose.

**Failure scenario.** An org restores from backup after a data incident. Documents, tickets, holds, acknowledgments and notifications all come back (notifications and email_notifications are in the restore order list at dataRestore.ts:311). Every user's watch list does not. resolveFollowers now returns an empty set for every document, library, project and asset. Every emit() with `audience: { followers: true }` — doc_superseded, library_doc_revised, hold_opened, branch_open, work-package drift — resolves to zero recipients and returns early at dispatch.ts:84 (`if (recipients.length === 0) return;`). The follower channel goes completely dark and nothing logs it, because zero recipients is the normal early-return. The restore report tells the operator this was correct and intentional for billing reasons.

**Evidence.**

```
dataRestore.ts:91  `  subscriptions: "billing state is owned by the payment provider — re-subscribe, never copy",`
lib/subscriptions.ts:3-5  `// Generic watch/follow API. Backed by the \`subscriptions\` table\n// (20260622 migration). Used by WatchButton in the UI and by the\n// notification fan-out helpers to find who to notify on an event.`
lib/subscription.ts:3-5  `// Helpers for figuring out an org's current subscription state. The\n// data lives on the orgs table (subscription_status, trial_ends_at,\n// current_period_end) and is fetched by the SubscriptionProvider.`
exportTables.ts:159  `  "subscriptions",`
dispatch.ts:84  `  if (recipients.length === 0) return;`
```

**Chain reaction.** tickets.watchers is an array column ON the tickets row, and tickets ARE restored — so ticket watching survives while document/library/project/asset watching does not. resolveFollowers merges both stores 'so the two follow stores look like one to every caller' (recipients.ts:33-34), which means after a restore the merged view is half-populated and looks plausible: ticket notifications still arrive, so nobody suspects the follow graph is gone until someone asks why they stopped hearing about rev-ups.

**Done when.**

- [ ] The SKIP_TABLES entry for `subscriptions` is removed and the table joins the restore order list with uid remapping applied, or — if a deliberate policy keeps watches out of restores — the justification string is corrected to say what the table actually is
- [ ] lib/subscription.ts and lib/subscriptions.ts are renamed apart (e.g. billing.ts vs watches.ts) so the collision cannot recur
- [ ] A restore integration test asserts a non-zero subscriptions row count in the target org afterwards

---

<a id="nedge-9"></a>

## NEDGE-9 · The compliance digest ignores digest_frequency='never' and every per-category toggle, and re-lists items the recipient has already read

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/cron/maintenance/route.ts:376-381`, `app/api/cron/maintenance/route.ts:399-403`, `app/api/cron/maintenance/route.ts:408`, `app/api/cron/maintenance/route.ts:421-436`, `lib/notifications.ts:59-61`

**Mechanism.** The digest composer selects notification rows by kind and created_at only — there is no `.is("read_at", null)` filter — then groups their titles per (org, user) and inserts straight into email_notifications, bypassing queueEmail() entirely. Because it bypasses queueEmail it also bypasses queueEmail's preference gate: it fetches only `user_id, email_enabled` and checks only `if (emailEnabled.get(e.userId) === false) continue;`. queueEmail's own gate (lib/notifications.ts:59-61) rejects on email_enabled === false AND digest_frequency === 'never' AND the per-category toggle; the digest honours the first of those three and nothing else. Separately the row scan is `.limit(2000)` with no ORDER BY, so beyond 2000 compliance rows in 25 hours the composer silently drops a nondeterministic subset.

**Failure scenario.** A superintendent sets Delivery cadence to 'Never' on /settings/notifications, expecting silence. (Assume they got past finding #1 by clicking Never before saving — the only path that saves successfully.) queueEmail now correctly suppresses their per-event mail. But at 03:00 UTC the maintenance cron composes a compliance digest, sees email_enabled is still true, and mails them a list of every review_due / ack_overdue / legal_hold_placed title from the last 25 hours — including items they read and acted on in the bell yesterday afternoon, because read_at is never consulted. They opted out of email and receive a daily email that re-nags them about work they already finished.

**Evidence.**

```
maintenance/route.ts:377-381  `    .from("notifications")\n    .select("org_id, user_id, kind, title, link")\n    .in("kind", COMPLIANCE_KINDS)\n    .gt("created_at", since)\n    .limit(2000);`
maintenance/route.ts:400-401  `  const { data: prefs } = await sb\n    .from("notification_preferences").select("user_id, email_enabled").in("user_id", userIds);`
maintenance/route.ts:408  `    if (emailEnabled.get(e.userId) === false) continue;`
lib/notifications.ts:59-61  `    if (prefs?.email_enabled === false) return;\n    if (prefs?.digest_frequency === "never") return;\n    if (!shouldSendForEvent(prefs, input.eventType)) return;`
```

**Chain reaction.** This is the only digest that exists in the product. The two kinds the UI and the bell are built to render as digests — morning_digest and task_overdue_digest — have no producer at all (see the orphaned-digest finding), so 'the digest' a user experiences is this cron path, which is the one path that ignores their cadence setting. A user who complains 'I set it to Never and still get a daily email' is factually correct and the preference UI is telling them the truth about a code path that isn't the one mailing them.

**Done when.**

- [ ] The digest composer calls the same preference gate as queueEmail (extract shouldSendForEvent + the email_enabled/digest_frequency checks into one exported helper used by both) and honours digest_frequency='never'
- [ ] The row scan adds `.is("read_at", null)` so an item the recipient has already cleared in the bell is not re-mailed
- [ ] The 2000-row scan is ordered (created_at DESC) and paginated, or the cap is enforced per-user, so which items get dropped is deterministic

---

<a id="nedge-10"></a>

## NEDGE-10 · No email the system sends carries an unsubscribe affordance, and mention markup leaks raw into email bodies

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/notifications/send-queued/route.ts:145-153`, `lib/notify/dispatch.ts:116-127`, `app/api/tickets/comment/route.ts:308-311`, `lib/notifications.ts:168-183`

**Mechanism.** Two separate content defects on the outbound path. (a) A case-insensitive search for unsubscribe / list-unsubscribe / opt-out across all .ts/.tsx/.sql returns no email-related hit — the only matches are Supabase realtime channel teardown and two prose comments. The Resend payload at send-queued/route.ts:146-153 sets from/to/subject/text/html and no headers at all, so there is no List-Unsubscribe header and no footer link to /settings/notifications in any body. Combined with finding #1 (preferences cannot be saved), a recipient has no in-band and no out-of-band way to stop the mail. (b) Comment bodies are copied into email verbatim: `body_text: … ${comment.text}` and `escapeHtml(comment.text)`. Comment text stores mentions as `@[Display Name](uuid)` (documented at lib/notifications.ts:169-170), and tokenizeMentions — the function that renders that markup as a readable name — is never called on the email path.

**Failure scenario.** An engineer is mentioned in a ticket comment reading 'can you check this with @[Mike Leonard](3f2b8c14-9d7a-4e11-b0f3-5a6c9e2d4188) before Friday'. The email they receive contains that string literally, internal user UUID and all. There is no footer, no unsubscribe link, and no List-Unsubscribe header — so when they mark it as spam (the only control their mail client offers), the sending domain's reputation absorbs it, and every future notification for the whole org is more likely to land in junk. In a system whose safety story depends on supersede and hold alerts reaching people, spam-foldering the sending domain is a safety failure.

**Evidence.**

```
send-queued/route.ts:146-153  `        body: JSON.stringify({\n          from: fromEmail,\n          to: row.to_email,\n          subject: row.subject,\n          text: row.body_text,\n          html: row.body_html || undefined,\n        }),`
tickets/comment/route.ts:308-311  `      body_text: \`${actorEmail} commented on ${ticketLabel}:\\n\\n${comment.text}\\n\\n${link}\`,\n      body_html: \`\n        <p><b>${escapeHtml(actorEmail)}</b> commented on <a href="${link}">${escapeHtml(ticketLabel)}</a>:</p>\n        <blockquote …>${escapeHtml(comment.text)}</blockquote>`
notifications.ts:169-170  `// Mentions are stored in comment text as @[Display Name](uuid). This lets\n// the renderer click through to the user even if their display name changes.`
```

**Chain reaction.** There is no email template layer at all — a census of bodyHtml/body_html producers returns exactly three (the two ticket routes and the transmittal), and no emit() caller passes an email override, so the great majority of notification emails are a single unstyled plaintext sentence with no header, no org branding, no link and no footer. Adding an unsubscribe footer therefore has nowhere to go until a shared template exists, which makes this a structural gap rather than a one-line fix.

**Done when.**

- [ ] A single render layer wraps every queued email (org branding, absolute action link, footer linking /settings/notifications) and send-queued attaches a List-Unsubscribe header pointing at a one-click opt-out
- [ ] tokenizeMentions is applied to comment text before it enters body_text/body_html so mentions render as plain names and internal UUIDs never leave the system
- [ ] The unsubscribe target actually works — i.e. it depends on the digest_frequency CHECK fix from finding #1

---

<a id="nedge-11"></a>

## NEDGE-11 · The transmittal portal link mailed to external recipients is built from window.location.origin, the exact anti-pattern lib/publicOrigin.ts exists to prevent

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:389-392`, `lib/transmittals.ts:278`, `lib/transmittals.ts:316`, `lib/transmittals.ts:495`, `lib/transmittals.ts:579`, `lib/publicOrigin.ts:5-15`

**Mechanism.** transmittalPortalUrl derives its origin from `typeof window !== "undefined" ? window.location.origin : ""`. lib/publicOrigin.ts was written specifically for URLs that leave the app and documents why this is wrong: 'window.location.origin is wrong whenever the person generating the print is on a preview/branch deploy — Vercel gates those behind its own login, so the scan dead-ends on a Vercel auth screen'. Nine call sites across viewers, docPack, physicalBridge and share/file correctly use publicOrigin(); the transmittal path — the only email in the system that goes to an external party — does not. The server branch returns the empty string, so any server-side invocation would produce the relative path `/transmittal/<token>` in an external email.

**Failure scenario.** A document controller issues a transmittal from a Vercel preview deploy (a staging URL, a branch review link, a custom domain not matching NEXT_PUBLIC_SITE_URL). renderTransmittalEmail embeds `https://mfgos-git-feature-xyz.vercel.app/transmittal/<token>` as both the button href and the copy-paste fallback. The external contractor clicks it and hits Vercel's own SSO wall. They cannot download the as-issued revisions and cannot acknowledge receipt — so the transmittal has no recorded acknowledgment, which in a PSM document-control context is the whole point of issuing it. The issuer's nudge system then flags it at lib/nudges.ts:73 as 'still unacknowledged — chase the recipient', pointing the blame at the contractor.

**Evidence.**

```
transmittals.ts:389-392  `export function transmittalPortalUrl(token: string): string {\n  const origin = typeof window !== "undefined" ? window.location.origin : "";\n  return \`${origin}/transmittal/${token}\`;\n}`
publicOrigin.ts:17-21  `export function publicOrigin(): string {\n  const configured = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\\/+$/, "");\n  if (configured) return configured;\n  if (typeof window !== "undefined") return window.location.origin;\n  return "";\n}`
transmittals.ts:278  `  const portalUrl = transmittalPortalUrl(t.portalToken);`
```

**Chain reaction.** The same function backs the 'copy portal link' button at app/(protected)/transmittals/page.tsx:261, so a controller who copies the link out of the UI and pastes it into their own mail client propagates the same wrong origin by hand.

**Done when.**

- [ ] transmittalPortalUrl calls publicOrigin() instead of reading window.location.origin directly
- [ ] sendTransmittalEmail refuses to queue (or loudly warns) when publicOrigin() returns an empty string, rather than mailing a relative link
- [ ] A test asserts the rendered email HTML contains an absolute https:// href

---

<a id="nedge-12"></a>

## NEDGE-12 · Timestamps written into notification and email bodies are formatted server-side with no locale and no timeZone, so they render in the server's UTC/en-US and carry no zone label in a regulated record

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:169`, `app/api/cron/maintenance/route.ts:348`, `app/api/cron/maintenance/route.ts:411`, `vercel.json:8-11`

**Mechanism.** Both server-side notification producers call bare toLocale* with no options. `new Date(now).toLocaleString()` and `new Date(row.started_at).toLocaleDateString()` execute in the Vercel Node runtime, whose ICU default locale is en-US and whose TZ is UTC. Neither string carries a zone suffix, so the recipient cannot tell what zone it is in. A repo-wide search for timeZone shows the project already knows this hazard and handles it consistently elsewhere — twelve call sites in components/projects/* and app/api/ai/usage/route.ts:40 all pass `{ timeZone: "UTC" }` explicitly, precisely to stop dates drifting a day. The notification path is the gap. The maintenance cron also computes its digest dedupe key as `new Date().toISOString().slice(0, 10)` — a UTC calendar day — and vercel.json schedules the cron at `0 3 * * *`, i.e. 03:00 UTC, which is 22:00 or 23:00 the previous evening US Eastern and 19:00/20:00 Pacific. There is no per-user or per-org timezone column anywhere (the search for timezone/time_zone across all .ts/.tsx/.sql returns only formatting call sites, never a stored preference).

**Failure scenario.** A contractor acknowledges a transmittal at 6:15 pm Central on 20 March. The confirmation email to the issuer reads '…confirmed receipt of transmittal T-0412 through the recipient portal on 3/20/2026, 11:15:15 PM.' — UTC, unlabelled, and for an acknowledgment landing after 7pm Central it will read as the NEXT calendar day. That sentence is the human-readable record of when a controlled document was received. Separately, the 'compliance items need you' digest lands at 10 or 11 pm the night before the working day it describes, which is not a morning digest by any reading, and its per-day dedupe rolls over at 3am UTC — so two runs on either side of that boundary can double-send.

**Evidence.**

```
transmittal/route.ts:169  `        body_text: \`${name} confirmed receipt of transmittal ${t.number}${t.subject ? \` (${t.subject})\` : ""} through the recipient portal on ${new Date(now).toLocaleString()}.${meta.note ? \`\\n\\nTheir note: ${meta.note}\` : ""}\`,`
maintenance/route.ts:348  `      body: \`${row.user_name || "A user"} has had a document checked out since ${new Date(row.started_at).toLocaleDateString()}…`
maintenance/route.ts:411  `    const dayKey = new Date().toISOString().slice(0, 10);`
vercel.json:9-10  `      "path": "/api/cron/maintenance",\n      "schedule": "0 3 * * *"`
```

**Chain reaction.** The client-side formatter in the bell (NotificationBell.tsx:197-208) IS correct — it uses relative time and falls back to the viewer's own toLocaleDateString in the browser. So the same event shows a sensible local time in the bell and a shifted, unlabelled UTC time in the email about it, and the two disagree by up to a day. In an audit that is a contradiction between two copies of the same record.

**Done when.**

- [ ] Server-side timestamps in notification and email bodies render through one shared helper that emits an explicit, zone-labelled format (ISO-8601 with offset, or a chosen org timezone plus the abbreviation)
- [ ] The digest dedupe key and the cron schedule are anchored to a configured org timezone rather than the server's UTC day, or the digest is explicitly named for when it actually arrives
- [ ] An org-level timezone setting exists and the digest fires against it (this is a prerequisite for the owner's login-nudge and morning-digest ambitions)

---

<a id="nedge-13"></a>

## NEDGE-13 · Two declared digest kinds have full consumer support and no producer anywhere, while a live producer emits a kind that is not in the union at all

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/inAppNotifications.ts:33-36`, `components/notifications/NotificationBell.tsx:41`, `hooks/useTicketNotifications.ts:80-83`, `lib/storageAlerts.ts:60-61`, `app/api/data-export/run/route.ts:54-58`

**Mechanism.** morning_digest and task_overdue_digest are declared in the NotificationKind union, task_overdue_digest has an icon in the bell's KIND_ICON map, and both are routed by sectionForKind. Two differently-shaped searches — a bare-identifier grep across .ts/.tsx, and a case-insensitive regex covering morning.digest / task.overdue.digest / camelCase variants across .ts/.tsx/.sql — return only those consumer sites. Nothing inserts either kind. The only digest that exists is the compliance digest in the maintenance cron, which is an EMAIL row (event_type 'compliance_digest') and never a bell notification, so it produces no in-app digest at all. Mirroring this, lib/storageAlerts.ts:61 writes `kind: "storage_alert"` through a raw `sb.from("notifications").insert`, bypassing notify() and therefore bypassing the NotificationKind type entirely — storage_alert appears nowhere in the union, has no icon, and hits sectionForKind's default branch.

**Failure scenario.** A maintainer implementing the owner's request for login-time nudges reads lib/inAppNotifications.ts, sees `morning_digest — composed daily digest: overdue + today + aging dateless` with a comment describing exactly the feature they were asked to build, and concludes the composition already exists and just needs surfacing. It does not exist. Conversely, an operator whose workspace is 92% full receives a storage_alert bell row that the type system has never seen; if someone later adds an exhaustiveness check over NotificationKind it will compile clean while the live row still falls through, because the producer never goes through the typed function.

**Evidence.**

```
lib/inAppNotifications.ts:33-34  `  | "task_overdue_digest"     // legacy digest — your scratchpad has overdue tasks\n  | "morning_digest"          // composed daily digest: overdue + today + aging dateless`
NotificationBell.tsx:41  `  task_overdue_digest: ListChecks,`
useTicketNotifications.ts:81-83  `    case 'task_overdue_digest':\n    case 'morning_digest':\n      return 'scratchpad';`
storageAlerts.ts:60-61  `      await sb.from("notifications").insert({\n        org_id: s.org_id, user_id: a.uid, kind: "storage_alert",`
```

**Chain reaction.** The raw-insert pattern is widespread — a census of `from("notifications")` finds direct inserts in maintenance/route.ts:355, data-export/run/route.ts:54, transmittal/route.ts:149, workflow-action/route.ts:335, comment/route.ts:268, intake/upload/route.ts (three sites), distributionAcks.ts, projects.ts:1116, storageAlerts.ts:60 and storageUsage.ts:255. Each of those bypasses notify()'s typing AND its error logging, so the union is aspirational rather than enforced and any exhaustiveness guarantee added later will be false.

**Done when.**

- [ ] morning_digest and task_overdue_digest are either implemented (a composer that writes bell rows) or deleted from the union, the icon map and sectionForKind — no declared kind without a producer
- [ ] storage_alert joins the union and lib/storageAlerts.ts routes through notify()
- [ ] Raw `from("notifications").insert` call sites are migrated onto notify()/notifyMany() so kind is type-checked at every producer, or a lint rule bans the direct insert outside lib/inAppNotifications.ts

---
