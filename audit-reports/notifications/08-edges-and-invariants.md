# 08 · Edges, egress & load-bearing invariants

**19 findings** — 2 CRITICAL · 9 HIGH · 6 MEDIUM · 2 LOW. `NEDGE-14`, `NEDGE-15` and `NEDGE-16` opened by notifications Round G (N5's second review fix), `NEDGE-17` by its third review fix, 2026-10-02; `NEDGE-18` (LOW) at the drafting-flow DF-P1 merge and `NEDGE-19` (LOW) by notifications Round G (N6), 2026-10-07.

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
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:68`, `hooks/useTicketNotifications.ts:100-102`, `hooks/useTicketNotifications.ts:246-250`, `components/navigation/Sidebar.tsx:229`, `components/navigation/Sidebar.tsx:231`, `components/navigation/Sidebar.tsx:235`, `lib/inAppNotifications.ts:38-58`
- **Re-verified:** hardening pass — **SURVIVES**. `sectionForKind` ends `default: return 'other'` (`useTicketNotifications.ts:100-102`), and `AttentionSection` is `'requests' | 'scratchpad' | 'documents' | 'projects' | 'other'` (`:68`) — `'other'` is a real bucket with no sidebar entry reading it.
- **Independently verified:** ⛔ **REFUTED** by an independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). The mechanics are accurately described — sectionForKind's default returns 'other' (:246-250) and Sidebar reads only sectionCounts.documents/.projects/.requests (:229,:231,:235), so 'other' and 'scratchpad' are dead buckets, and the 48-kind/26-unmapped arithmetic checks out against lib/inAppNotifications.ts:10-58. But the claim that a legal hold or overdue acknowledgment 'never badges anything' is false: legal_hold_placed lands in `items`, badges the header bell count, and appears in the bell list and /inbox. The residue is a cosmetic per-section badge gap (e.g. legal_hold_placed could reasonably tally to 'documents' like hold_opened does), not a CRITICAL missed-notification defect.

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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/settings/notifications/page.tsx:30`, `app/(protected)/settings/notifications/page.tsx:40`, `app/(protected)/settings/notifications/page.tsx:69`, `app/(protected)/settings/notifications/page.tsx:86`, `app/(protected)/settings/notifications/page.tsx:151`, `supabase/migrations/20260529_phase_b_notifications.sql:77`, `supabase/schema.sql:660`
- **Re-verified:** hardening pass — **SURVIVES**, and the mismatch is exact. The page's type and `DEFAULTS` both use `digest_frequency: "immediate"` (`:30, :40`); the column is `CHECK (digest_frequency IN ('instant','hourly','daily','never'))` with default `'instant'` — `20260529_phase_b_notifications.sql:77-78`, mirrored at `schema.sql:660`. `'immediate'` is not in the set, so the first save for any user without an existing row violates the constraint.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and I could not find any escape hatch: grep across supabase/ shows no later migration altering the constraint (the only other 'immediate' hits are prose in unrelated migrations), and nothing anywhere creates a notification_preferences row — no trigger, no signup path, no server route (the only writers are this page's upsert). So every user hits DEFAULTS/'immediate' on first save and the CHECK rejects it; only a user with a pre-existing row (which nothing creates) round-trips a legal value.

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

**Resolution (2026-10-01, notifications Round G).** Package N1 PREFS-GATE, commit `31b3eb7`. **Reproduced first** on `cd8a93a`: the page still carried the token at `page.tsx:30`, `:40`, `:69` and `:151`; `grep -rn "'immediate'" supabase/migrations` found it in no SQL; and the rendered-page test `lib/__tests__/notificationSettingsPage.test.ts` "the first save carries a digest_frequency the CHECK admits, and says Saved" failed on the old page — a member with no row upserted `digest_frequency: 'immediate'`, outside the CHECK parsed from `20260529_phase_b_notifications.sql:77-78`. **'instant' wins** (the stored and CHECK spelling: no migration, no data change; the button reads "Immediately"); the CHECK is NOT widened (GAP-203 "Do not"). New `lib/notificationPrefs.ts` is the one vocabulary: `DIGEST_FREQUENCIES` (:25, the CHECK list), `PREF_DEFAULTS` (:57, the column defaults), `OFFERED_DIGEST_FREQUENCIES` (:32, Immediately / Never — Hourly and Daily are no longer offered; the CHECK still admits them, so a stored row keeps validating), `normalizeDigestFrequency` / `prefsFromRow` (:80, :88 — the load mapping). The page (`app/(protected)/settings/notifications/page.tsx`) takes its type, defaults and buttons from it (:50, :181); shows a stored Hourly / Daily as Immediately with a note saying it was never implemented (:177 — every reader treated it as 'instant'); no longer falls back to the defaults when the read fails — the error is shown and Save is refused, so a row that exists but could not be read is never overwritten (:71, :211); and words a 23514 distinctly (`saveFailure`, :41). Decision recorded as `DEC-74` in `DECISIONS.md`.
- Files: `lib/notificationPrefs.ts` (new), `app/(protected)/settings/notifications/page.tsx`.
- Tests: `lib/__tests__/notificationSettingsPage.test.ts` (rendered page: the defaults save inside the CHECK; exactly the column defaults; Immediately / Never only; 23514 worded distinctly; a legacy row loads and saves; a failed load refuses Save); `lib/__tests__/notificationPrefs.test.ts` "NEDGE-2 / DELIV-12 — the vocabulary is the CHECK's" (the list equals the CHECK in `20260529` and `schema.sql`; the CHECK is defined once, never altered; no numbered migration spells 'immediate'; every `PREF_DEFAULTS` value equals its SQL column default).
- Verified: Loop on `fleet/N1-prefs-gate` after the second fix pass (`17a2a75`): `npx tsc --noEmit` exit 0; `npx eslint` on the 8 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 298 files, 6315 passed, 5 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ One shared vocabulary: the UI writes 'instant' from `DIGEST_FREQUENCIES` / `OFFERED_DIGEST_FREQUENCIES`. The load fallback maps the legacy 'immediate' (no row holds it — the CHECK refused every write of it) and any value outside the CHECK to 'instant'; a stored 'hourly' / 'daily' displays as Immediately with a note, and saving stores 'instant' (its real behaviour).
- ✓ A test asserts that saving the DEFAULTS round-trips: the rendered page's first save carries `PREF_DEFAULTS` with a `digest_frequency` inside the CHECK read from the migration that defines it, and every default equals the SQL column default. There is no live database here (DEC-30), so this is proven against the constraint's text, not by an INSERT.
- ✓ save() surfaces a check violation distinctly — "The server refused a preference value (check constraint): …" with the constraint's own message, nothing claimed saved — while any other refusal is shown as itself.

**Scope / residual.** This finding needs no migration: the page saves before and after `20261148` (a `toast_enabled` the database does not know yet — PGRST204 — is retried without that column). Hourly / Daily batching stays unbuilt; the only digest is the compliance digest (`NEDGE-9`, N6), which is given `emailAllowedByPrefs` to honour 'never'. The ticket routes' own preference reads (`comment/route.ts`, `workflow-action/route.ts`) are N6's and unchanged.

---

<a id="nedge-3"></a>

## NEDGE-3 · Deactivated members keep receiving both bell rows and email: the follower and email-lookup queries have no status filter, while the role-pool query does

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/notify/recipients.ts:23-45`, `lib/notify/dispatch.ts:135-147`, `lib/notify/recipients.ts:48-62`, `app/api/admin/restore/begin/route.ts:68`, `app/api/admin/restore/apply/route.ts:64 (deleted by admin-and-org P3, ILIFE-4)`, `supabase/schema.sql:42`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `lib/notify/recipients.ts:23-45` contains no `status` predicate of any kind — a grep for `status`/`active` across that range returns nothing — so a deactivated member stays on the fan-out.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — the asymmetry is exactly as described, and the same unfiltered org_members email lookup is duplicated in the ticket paths (tickets/comment/route.ts:283, workflow-action/route.ts:353). Non-active members are demonstrably real rows: restore/begin/route.ts:66-68 and restore/apply/route.ts:62-64 both insert members with `status: "inactive"`.

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

*Cross-note (2026-10-01, admin-and-org Round G, P3).* One location above is gone: `app/api/admin/restore/apply/route.ts:64`. The single-shot restore route had no caller, and admin-and-org P3 deleted it under intelligence `ILIFE-4`. The one restore door is `/api/admin/restore/begin` plus `/api/admin/restore/apply-table` (`lib/dataRestore.ts applyRestoreChunk`). `/begin` (`app/api/admin/restore/begin/route.ts`) is the only place left that inserts placeholder members as `status: "inactive"`, so this finding's restore chain reaction runs through it alone. P3 did not change the finding itself; it was OPEN when P3 landed. *(Integrator, at merge 2026-10-02: N5's Resolution below has since closed it, and its post-restore remainder is `NEDGE-16`, whose restore path is now `/begin` alone.)*

**Resolution (2026-10-02, notifications Round G).** Package N5 DISPATCH-AND-WRITE-HOLES, commit `5ed25b9` (the dispatcher) and `018caac` (the database rail). **Reproduced first** on `f1ac550` with `lib/__tests__/notificationDispatchMembership.test.ts`, which drives the real `lib/notify/dispatch.ts`, `lib/notify/recipients.ts` and `lib/inAppNotifications.ts` over the in-memory PostgREST stand-in (`helpers/memoryDb`): a hold to the follow list wrote bell rows for the suspended, the inactive (a restore's placeholder) and the removed subscriber beside the active one, and queued email to the suspended and inactive ones (`emailsFor` read their addresses); the same through `tickets.watchers`, `involved[]` (another org's member included) and the project roster. 11 of the file's 20 cases failed on the base; the role-pool case passed, as the correction above says. **Fix:**
- `lib/notify/recipients.ts:40` `activeMembersOf(orgId, uids)` — the uids that are ACTIVE members of the org (`status = 'active'`), read in chunks of 150, in input order. A read that FAILS keeps the input unchanged and logs `[notify] active-membership read failed`: a transient error must never silently drop a compliance notice, and the database rail below is the backstop.
- `lib/notify/dispatch.ts:118` `resolveRecipients` filters the FINAL set once, centrally, after the union and the actor removal (`:129`) — `involved[]` included, which nothing checked before.
- `resolveFollowers(resource, orgId)` (`recipients.ts:62`) applies the same filter itself (`:83`), a defence in depth for any direct caller; its one caller passes the org (`dispatch.ts:123`).
- `emailsFor` (`dispatch.ts:195`) adds `.eq("status", "active")` (`:202`) — the second layer: a suspended member's address is never read, even when the recipient filter could not run.
- `resolveRoleRecipients` is unchanged; it already filtered status and read `roles[]`.
- In the database (see `OS-1`, `NEDGE-7`): `20261160`'s insert trigger SKIPS a browser's row whose recipient is not an active member of the row's org (`RETURN NULL`, so one suspended watcher never sinks a batch insert for everyone else), and `20261161`'s read policy hides every row from a member who is not active in the row's org.

**Regression pin.** With every member active, five audiences — involved, followers, roles, project, and all four together with the actor named — reach exactly the recipients the `f1ac550` resolver reached (reimplemented in the test over the same tables), on both channels; each bell row keeps its title, body, link, kind, actor and resource; an involved-only email is queued field for field as before; channel subsets are unchanged; the actor is never a recipient; a failed membership read keeps today's delivery. `DEC-43`: a role broadcast to Admin / DocCtrl reaches every active controller, an additively-held DocCtrl included.
- Files: `lib/notify/dispatch.ts`, `lib/notify/recipients.ts`; `lib/__tests__/orchestratorExecute.test.ts` (one expectation: the dispatcher on the unbound client now stops at its membership read, before any insert — it still delivers nothing).
- Tests: `lib/__tests__/notificationDispatchMembership.test.ts` (20 cases); `lib/__tests__/notificationWriteRails.test.ts` (the trigger's skip rule, the policy model).
- Verified: loop on `fleet/N5-dispatch-rails` at `018caac`: `npx tsc --noEmit` exit 0; `npx eslint` on the six changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7914 passed, 4 expected-fail. `next build` is the integrator's.
- **Pending migration:** the database half only — `supabase/migrations/20261160_notif_roundG_write_rails.sql`, then `20261161_notif_roundG_read_scope.sql` (DEC-30, applied by hand). The dispatcher half needs neither.

**Done-when.**
- ✓ `resolveRecipients` filters the final recipient set against active org membership once, centrally, including `involved[]`.
- ✓ `emailsFor` adds `.eq("status", "active")`.
- ✓ in part — a test covers a suspended watcher getting neither bell nor email and an active watcher getting both, through `subscriptions` and through `tickets.watchers`. **Not done here:** the post-restore all-inactive org assertion. The plan routes it to admin-and-org P1 (restore / apply) as a pointer. Since this change the asymmetry is gone — after a restore every member is `inactive`, so role broadcasts, follower fan-out and email all reach nobody until a member is reactivated, and after `20261161` an inactive member cannot read their bell either — but nothing yet asserts or repairs the all-inactive state — the remainder opened as **`NEDGE-16`** (DEC-31). **Not covered either (review):** the invariant "a suspended watcher gets neither bell nor email" holds for every `emit()` producer, not for the two ticket routes' own service-role fan-out (`fanOut` in `app/api/tickets/comment/route.ts` and `app/api/tickets/workflow-action/route.ts`): its bell rows still reach a suspended watcher (hidden from them once `20261161` is pasted) and its email lookups (`comment/route.ts:325`, `workflow-action/route.ts:692`) have no status filter, so a suspended ticket watcher keeps getting comment and workflow emails — the remainder opened as **`NEDGE-14`**, handed to N6.

**Scope / residual.**
- **`NEDGE-14`, handed to N6 EMAIL-PIPELINE-AND-CRON** (recorded in `99-fix-sequencing.md`, Phase 1): the ticket comment and workflow-action routes write bell rows and queue email as the service role outside `emit()`, and the insert trigger passes the service role untouched by design. N6, which edits those routes' `fanOut` builders by plan (the routes are drafting-flow's files), adds `.eq("status", "active")` to both `fanOut` email lookups (`app/api/tickets/comment/route.ts:325`, `app/api/tickets/workflow-action/route.ts:692`) and filters `fanOut`'s recipients to active members of the ticket's org before the bell insert (`activeMembersOf`, `lib/notify/recipients.ts`). Until it lands, a suspended ticket watcher keeps getting those emails; the bell rows are unreadable to them once `20261161` is pasted.
- `app/api/tickets/handback/route.ts` calls `emit()` on the unbound shared client (no `runWithServerClient`), so its "deliverable submitted / published" notice was refused by RLS before this change and now stops at the membership read: it has never been delivered. Not this finding's — opened as **`NEDGE-15`** (drafting-flow owns the route).
- The post-restore all-inactive org: **`NEDGE-16`** (the plan's pointer was admin-and-org P1, which has merged without it).

---

<a id="nedge-4"></a>

## NEDGE-4 · Every internal notification email carries a relative href, so the one call-to-action link in the message is dead in every mail client; emails sent through emit() carry no link at all

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/comment/route.ts:263`, `app/api/tickets/comment/route.ts:309-313`, `app/api/tickets/workflow-action/route.ts:313`, `app/api/tickets/workflow-action/route.ts:389-394`, `lib/notify/dispatch.ts:116-127`, `lib/notifications.ts:16-27`, `app/api/cron/maintenance/route.ts:425-431`
- **Re-verified:** hardening pass — **SURVIVES**. `const link = `/requests/${ticketId}?c=${comment.id}`` (`:263`) is a bare path, embedded directly as `<a href="${link}">` in `body_html` and appended to `body_text` (`:309-313`). Nothing resolves a relative href in a mail client.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and nothing downstream repairs it: send-queued/route.ts posts `text: row.body_text, html: row.body_html` verbatim to Resend with no origin rewriting. The repo even has the right helper — lib/publicOrigin.ts:17 `publicOrigin()` — but grep shows it is used only for QR/print/verify URLs, never on any email path.

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

**Resolution (2026-10-07, notifications Round G).** Package N6 EMAIL-PIPELINE-AND-CRON. Reproduced on `2de62f1` first (DEC-29): (b) `lib/notify/dispatch.ts` passed no link to `queueEmail` (`dispatch.ts:216-227` on the base), so every `emit()` email was a bare sentence with no URL; (c) no `emit()` caller passes an email override; (d) the digest ended "Open your Inbox to act on them." with no URL (`maintenance/route.ts:630` on the base); `lib/__tests__/maintenanceDrain.test.ts` "every href is absolute…" fails on the base route. Limb (a) — the two ticket templates' relative href — had already been fixed by drafting-flow `EDGE-9` (DF-P1: `publicOrigin() || new URL(req.url).origin`, `comment/route.ts`, `workflow-action/route.ts`), which this package keeps.
- `lib/emailRender.ts` (new): the render layer. `renderNotificationEmail({ subject, body, link, linkLabel, orgName, origin })` and `wrapEmailBody(...)`. A link leaves the app absolute: an app-relative path is joined to the public origin (`lib/publicOrigin.ts`), an absolute http(s) link is kept, anything else is dropped (`absoluteEmailLink`). With no origin the renderer THROWS `EmailOriginMissingError` (the XEDGE-5 lesson) instead of mailing a bare path; its callers catch it, log it and queue the email in its pre-render form, so no notice is dropped.
- `lib/notify/dispatch.ts` `emit()` (:240-262): every recipient's email is rendered (the event's `link`, absolute, plus the footer) unless the producer passed its own HTML; the absolute link rides `queueEmail`'s `link` (N1's field → `metadata.link`). `lib/notifications.ts` `queueEmail`: a new optional `rendered` body is what is gated (email_gate()'s repeat check compares the stored body), stored and sent, and the row is marked `metadata.rendered`.
- `app/api/cron/maintenance/route.ts` `queueComplianceDigests` (:782): the digest links `${origin}/inbox` (origin: `publicOrigin()`, else the cron request's own origin), absolute; `metadata.link` carries it.
- Tests: `lib/__tests__/emailRender.test.ts` ("no href in any rendered body starts with a bare '/'", the refusal with no origin, `queueEmail` with a rendered body); `lib/__tests__/n6TicketFanout.test.ts` (the handback's `emit()` email carries `${origin}/requests/t1`, through the REAL dispatcher); `lib/__tests__/maintenanceDrain.test.ts` (the digest's hrefs); `lib/__tests__/dfRoundG_P1_rails.test.ts` EDGE-9 (the ticket links, plus the footer's settings link).

**Done-when.**
1. ✓ `QueueEmailInput` has `link` (N1), `dispatch.ts` forwards the event's link and every `emit()` email body renders it absolute on `publicOrigin()`. Where no public origin exists (a server with neither `NEXT_PUBLIC_SITE_URL` nor Vercel's production domain), the renderer refuses and the email is queued as before, with no link — never a bare path.
2. ✓ The two HTML templates build `${origin}/requests/<id>` (EDGE-9, kept) and tests assert no queued `body_html` href begins with '/' (`dfRoundG_P1_rails.test.ts` EDGE-9, `emailRender.test.ts`, `n6TicketFanout.test.ts`).
3. ✓ The compliance digest body carries an absolute `/inbox` URL.

**Scope / residual.** Two internal emails are composed outside the render layer, in `app/api/transmittal/route.ts` (document-control P7 / notifications N9): neither carries a link; the drain's backstop adds the footer (`NEDGE-10`).

---

<a id="nedge-5"></a>

## NEDGE-5 · Every notification surface is invisible to assistive technology: no aria-live region, no accessible name on the bell, no role on toasts, unnamed dismiss controls

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/notifications/NotificationBell.tsx:99-112`, `components/notifications/NotificationBell.tsx:114-127`, `components/notifications/NotificationBell.tsx:129-130`, `components/providers/ToastProvider.tsx:57-58`, `components/providers/ToastProvider.tsx:90-95`, `components/ui/CornerDock.tsx:23-27`
- **Re-verified:** hardening pass — **SURVIVES**, by census. `grep -c 'aria-live\|role="status"\|aria-label'` on `NotificationBell.tsx` returns **0**.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: toasts appear and vanish with no announcement, the dismiss button has no accessible name, and the dropdown is a plain div with no role/aria-expanded wiring. One nuance on the bell: both branches carry `title={unread > 0 ? … : "Notifications"}` (NotificationBell.tsx:101,116), which IS an accessible-name fallback — but only when the button has no content name, and the unread badge span supplies the text "7", which wins name-from-content, so the reported '7, button' announcement is exactly right whenever there is anything to announce.

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

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** notifications N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT (done-when 3: a server-side discover check for a document and a list of uids) — by the integrator, 2026-10-02, at the N5 merge (DEC-31; fleet plan `audit-reports/fleet-plans/notifications.json`).
- **Verification:** CONFIRMED
- **Locations:** `lib/holds.ts:238-252`, `lib/branches.ts:141-148`, `lib/notify/dispatch.ts:120`, `lib/notify/recipients.ts:48-62`, `types/schema.ts:81`, `lib/acl.ts:207`, `app/api/cron/maintenance/route.ts:421-426`
- **Re-verified:** hardening pass — **SURVIVES**. `title: `HOLD placed on ${label} — ${input.reason}`` (`holds.ts:243`) puts the document label and the free-text reason into the notification title, which is the field surfaced to every recipient regardless of their document access.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The factual claim is right — no ACL consultation exists anywhere on the notify path, and admin roles get no automatic ACL grant. But the severity assumes the notification discloses something new to that audience, and it does not: lib/holds.ts:283-290 `listActiveHoldsForOrg` selects every active hold row for the org (reason included) with no ACL filter, and app/(protected)/admin/holds/page.tsx:32 gates that page to `new Set(["Admin","Manager","Supervisor","DocCtrl"])` — a superset of the notified role pool. The incremental leak is the egress to Resend and the follower path, not the in-app disclosure, which puts this at MEDIUM.

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

**Partial (2026-10-02, notifications Round G).** Package N5 DISPATCH-AND-WRITE-HOLES, commit `5ed25b9`. **Reproduced first** on `f1ac550` (`lib/__tests__/notificationDispatchMembership.test.ts` "NEDGE-6 (egress)"): a hold to the follow list was mailed with the subject `HOLD placed on PID-4412-R3 — litigation hold, Baytown incident, do not distribute`. **Landed — the egress half (done-when 2):**
- `lib/notify/dispatch.ts` `broadcastSubject(category, resourceType)`: a subject that names only the category and the kind of resource ("Status change on a document"), never the title, whatever free text the title carries. The title then leads the email body, so the recipient still learns what it is about once the mail is opened.
- **Decided per recipient** (second review fix `b97e17c`, `titleIsSubjectFor` / `emailSubjectFor`; the first pass decided it per EVENT, so in any event that also reached followers the named stakeholders lost their identifying subject too — e.g. the intent holders of `lib/postPublish.ts` `notifySuperseded` got "New activity on a document" instead of "PID-4412 advanced to Rev C"). Someone the producer names in `involved` keeps the title as the subject — the document number they triage and search by. Someone reached only through a role pool (`audience.roles`) or the follow list (`audience.followers`) gets `broadcastSubject`. An event that reaches neither (named people and project members) keeps the title for everyone, as before.
- **Except a kind whose title carries a free-text reason** — `REASON_IN_TITLE` (`hold_opened`: notifyHoldChange's "HOLD placed on … — <reason>" and `scanStaleHolds`'s "Hold past its expected release — <label> (<reason>)"): `broadcastSubject` for EVERY recipient, the named ones too. A hold's release pool is resolved from the policy's roles but passed as `involved` (`lib/holds.ts` is DC-owned), so per-recipient naming alone would have put the reason in the pool's subject line — the headline case of this finding. A census test pins every `emit()` title that interpolates a `reason` to a listed kind, and every listed kind to such a producer.
- An explicit `email.subject` is the producer's choice and is sent as given to everyone (no producer passes one today).
- Every category × resource type has a fixed, distinct subject (pinned).
- Done-when 1, the in-app title of a role broadcast: per `DEC-43` controllers are unscoped, so an Admin or DocCtrl reading a hold's title in the bell is consistent with policy, and the bell row is unchanged — the plan's narrowing.

**Not done — done-when 3** (narrowed by the plan to non-controller followers, through the node-visibility check rather than a new ACL walk): a follower who is not a controller and can no longer discover a hidden or private document still receives its title in the bell, and in the email body. The check needs a discover decision for ANOTHER principal over the library → folder → document chain. The database's `node_visible` / `doc_is_visible` answer only for `auth.uid()`; the one evaluator for another principal (`lib/docFileServer.ts` `discoverableDocuments` with `loadContainerAclChain` and `loadReaderPrincipal`) runs on the service role and cannot run in the browser, where most `emit()` calls happen. A client-side chain walk is the new ACL walk the plan forbids. Next step: a server-side discover check the dispatcher can call for a document and a list of uids (an RPC or a route), then drop the non-discovering, non-controller followers of document-scoped events.

**Residual.** `REASON_IN_TITLE` is the dispatcher's stand-in for the producer: if the hold producers (`lib/holds.ts`, DC-owned — N9, after DC P5) pass `email.subject`, or pass the release pool as `roles`, the kind can leave the set. *(The first pass recorded here that the stale-hold nudge kept its reason in the subject; since the second review fix it does not.)* A title that names a document (a revision, a branch, a superseded copy) still reaches the people the producer named as their subject line, by design; to a controller reached by a role pool that is `DEC-43`'s unscoped posture, and its subject is the category's.
- Tests: `lib/__tests__/notificationDispatchMembership.test.ts` "NEDGE-6 (egress)" (4 cases at the first pass; 8 since the second review fix, which adds a mixed audience — named stakeholder vs follower; a role pool beside named people; a reason-bearing kind for every recipient, with the aging nudge's shape and an explicit subject; and the `REASON_IN_TITLE` producer census). Second review fix verified: `npx tsc --noEmit` exit 0; `npx eslint` `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7940 passed, 4 expected-fail.
- Verified: loop on `fleet/N5-dispatch-rails` at `018caac`: `npx tsc --noEmit` exit 0; `npx eslint` on the six changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7914 passed, 4 expected-fail. `next build` is the integrator's.

---

<a id="nedge-7"></a>

## NEDGE-7 · Removing a member deletes only the org_members row; the notifications RLS SELECT policy has no org-membership predicate, so a removed member keeps permanent read access to the full archive of alerts about documents they can no longer open

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/users/page.tsx:176-181`, `supabase/migrations/20260723_notifications_unify.sql:36-37`, `supabase/migrations/20260621_in_app_notifications.sql:40-41`, `lib/inAppNotifications.ts:157-174`, `app/api/admin/purge/route.ts:70`
- **Re-verified:** hardening pass — **SURVIVES**. `notifications_own_select` is `FOR SELECT USING (user_id = auth.uid())` (`20260723_notifications_unify.sql:37`) — keyed on the user, with no org-membership term — so removing the `org_members` row leaves every existing notification readable. (Compounded by `roles-and-permissions/SURF-1`: the removal does not take effect at all.)
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — grep over supabase/ finds only these two definitions of notifications_own_select and both are membership-blind, so a removed member with a live auth session keeps SELECT on their whole historical notification archive. Purge (admin/purge/route.ts) only trims read rows past a cutoff and is unrelated to offboarding.

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

**Resolution (2026-10-02, notifications Round G).** Package N5 DISPATCH-AND-WRITE-HOLES, commit `018caac` (fix pass 4 `8fbb2a4`: the tombstone's tripwire, below), migration `supabase/migrations/20261161_notif_roundG_read_scope.sql`. **Reproduced first** on a throwaway PostgreSQL 16 shaped like Supabase (the `anon` / `authenticated` / `service_role` roles, `auth.uid()` from the request claims, `org_members` with its read policy) carrying `20260723`'s notifications SQL verbatim and `20261043`'s `revoke_member`: after an Admin's `revoke_member(…, 'remove')`, the removed member's token read 2 of their rows, marked them read and deleted one. **Fix (`20261161`):**
- `notifications.org_tombstoned_at TIMESTAMPTZ` — NULL is live.
- `notifications_own_select`, `_update` and `_delete` are now `user_id = auth.uid() AND org_tombstoned_at IS NULL AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = notifications.org_id AND m.uid = auth.uid() AND m.status = 'active')`. UPDATE has it in USING and in WITH CHECK; DELETE adds `DELIV-13`'s terms.
- `revoke_member(uuid, text)` is re-created from its NEWEST definition — `20261043` §0, found by scanning the sequence, never `20261042` — with one statement added on the REMOVE path, after the roster deletes and before the membership delete, inside the same call (one transaction): `UPDATE notifications SET org_tombstoned_at = NOW() WHERE org_id = v_member.org_id AND user_id = v_member.uid AND org_tombstoned_at IS NULL`. EXECUTE is restated: REVOKEd from PUBLIC and anon, GRANTed to authenticated (the body refuses a NULL uid regardless). *(Corrected at fix pass 4: `20261043` §0 was the newest definition when N5 was written. From `20261161` on, `revoke_member`'s NEWEST definition is `20261161`'s, and a later re-creation starts from that, never from `20261043`.)*
- Tombstone, not delete — the plan's default: the archive stays for investigators. The purge route (service role) is unchanged.
- The pre-apply inventory (DEC-30, counts only): rows whose recipient is suspended, inactive, invited, or has no membership row in the row's org; the distinct recipients affected; unread rows; read compliance and read non-compliance rows; off-origin links; tombstoned rows.

**Exercised on PostgreSQL 16.** Both pastes in order, then each pasted a second time (idempotent); on a fresh database `20261161` alone stops at its first statement with "paste 20261160 first" and changes nothing. Every probe was true: 12 for `20261160` (the first pass; 14 after the first review fix and 17 after the second, each re-verified true on PostgreSQL 16 with `20261161`'s 10 true after it), 10 for `20261161`. Then:
- an active member reads only their own live rows, marks one, several and all read, and clears a read FYI row;
- a suspended member reads 0 rows and marks none; after `revoke_member(…, 'restore')` they read their 3 rows again;
- after `revoke_member(…, 'remove')` the removed member's token returns **0 rows for that org** — their 2 rows kept, tombstoned — and marks and deletes nothing, while their row in another org where they are still active stays readable;
- re-added to the org, they see only the notice written after the re-add;
- a member removed before the paste (no tombstone) reads 0;
- an Admin and an additively-held DocCtrl read their own rows (`DEC-43`);
- the service role still rewrites and deletes anything.
The scratch cluster was deleted afterwards.
- Files: `supabase/migrations/20261161_notif_roundG_read_scope.sql` (new).
- Tests: `lib/__tests__/notificationWriteRails.test.ts` — the policies' text, the paste's one-result-set shape and inventory, `revoke_member`'s line diff against its newest earlier definition (no line removed; exactly the comment and the statement added; placed after the roster sweep and before the membership delete), and "the model of 20261161's policies": the removed, suspended, restored, re-added and multi-org cases over predicates each pinned to the SQL text. `lib/__tests__/dcHotfixAnonExecute.test.ts`, `searchPathPin.test.ts`, `migrationSourceOfTruth.test.ts` and `rpPhase6Migration.test.ts` pass with the new definition.
- Verified: loop on `fleet/N5-dispatch-rails` at `018caac`: `npx tsc --noEmit` exit 0; `npx eslint` on the six changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7914 passed, 4 expected-fail. `next build` is the integrator's.
- **Pending migration:** `supabase/migrations/20261161_notif_roundG_read_scope.sql` — applied by hand (DEC-30), one paste, expect `ok = true` × 10; paste `20261160` first. Until it is applied, a removed member's token still reads their archive. The app reads nothing this file adds and writes only `read_at`, so either deploy order is safe.
**N5 fix pass 4 (2026-10-02) — the tombstone's tripwire (`8fbb2a4`).** The final review found a gap. Nothing checked that the NEWEST `revoke_member` in the sequence still carries the tombstone, and the records told the next re-creator to start from `20261043`. Admin-and-org P8 re-creates `revoke_member` for `ORG-7` / `ALOG-15`, and its records say "starting from `20261043`, its newest definition". A P8 migration built that way would drop the tombstone without failing anything: the lineDiff test only diffs `20261161` against what came before it. A removed member's archive would then stay unsealed, so a re-added member would see it again. **Fix (test and records):**
- `lib/__tests__/notificationWriteRails.test.ts`, "TRIPWIRE (fix pass 4)", reads every numbered migration, any file after `20261161` included. It takes the newest `revoke_member` definition by file name and fails unless its code, comments stripped, carries `UPDATE notifications SET org_tombstoned_at = now() WHERE org_id = v_member.org_id AND user_id = v_member.uid AND org_tombstoned_at IS NULL;` (case-insensitive; `now()` or `current_timestamp`). Its message names the file and says to re-create from the NEWEST definition, never from `20261043`.
- The body is now read to the dollar quote that opened it, whatever its tag, so a re-creation quoted `$fn$` is still read whole.
- **Negative controls.** In the test, a later re-creation from `20261043`'s body fails, under `$$` and under `$fn$`. So does `20261161`'s body with the statement commented out. `20261161`'s body with a line added and quoted `$body$` passes, and below `20261161` the newest, `20261043`'s, fails. On the tree, a temporary `supabase/migrations/20261200_tmp_revoke_from_43.sql` carrying `20261043`'s `revoke_member` failed the tripwire, first as it is and then re-quoted `$fn$`. The failure read "20261200_tmp_revoke_from_43.sql re-creates revoke_member without 20261161's tombstone (NEDGE-7): re-create it from its NEWEST definition, never from 20261043". The file was then deleted.
- **Records corrected in place.** `DEC-20`'s N5 landed note and `DEC-86`'s Implementation line (`audit-reports/DECISIONS.md`), this block, and the fleet plan's general rule and N5 dependency (`audit-reports/fleet-plans/notifications.json`) now say: re-create `revoke_member` from its NEWEST definition (`20261161` after N5). The admin-and-org records that point P8 at `20261043` exist only on the integration branch. They are handed to the integrator to correct at the N5 merge: `DECISIONS.md` `DEC-20`'s A&O P0 note; `admin-and-org/01-org-lifecycle.md` `ORG-2`; `admin-and-org/03-audit-log.md` `ALOG-12` / `ALOG-15`; `fleet-plans/admin-and-org.json` P8's migration B line; and `MIGRATION-PASTE-ORDER.md` row 45 (`20261043`), which gains "`revoke_member` → 20261161; never re-paste 20261043 after it". This branch's copy of `admin-and-org.json` P8 line ("VERBATIM from 20261042") is the pre-merge text the integration branch already replaced, so it is left for the merge rather than edited into a conflict.
- Verified: fix pass 4 at `8fbb2a4`: `npx tsc --noEmit` exit 0; `npx eslint lib/__tests__/notificationWriteRails.test.ts --max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 388 files, 7953 passed, 4 expected-fail.

**Done-when.**
- ✓ `notifications_own_select` gains the org-membership predicate (active, in the row's org), and so do UPDATE and DELETE — plus the tombstone. Takes effect once `20261161` is pasted.
- ✓ Member removal (`admin/users/page.tsx` → `lib/members.ts` `revokeMember` → the `revoke_member` RPC, since `SURF-1`) deletes the member's subscriptions rows for that org — already true, by record: `20261042` / `20261043` (`SURF-1` / `DEC-20`), re-verified at `20261043:173` — and now tombstones their notifications, inside the same function call as the `org_members` delete.
- ✓ The removed-member case is exercised: on PostgreSQL 16 (above), and in the suite by the policy model in `notificationWriteRails.test.ts`.

**Scope / residual.**
- Rows of members removed before the paste are not tombstoned (the inventory counts them). They stay hidden while the person is not an active member and would reappear if the same person were re-added. To tombstone them as well, run once: `UPDATE notifications n SET org_tombstoned_at = now() WHERE org_tombstoned_at IS NULL AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = n.org_id AND m.uid = n.user_id);` — the paste does not (DEC-31).
- Suspend does not tombstone: it is reversible by design, and a suspended member's rows return on restore.
- A removed member's `email_notifications` and `notification_preferences` rows are untouched; this finding's done-when does not name them.

---

<a id="nedge-8"></a>

## NEDGE-8 · Restoring an org silently destroys every watch/follow relationship, because the restore skip-list mistakes the watch table for Stripe billing state

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:85-93`, `lib/subscriptions.ts:1-5`, `lib/subscription.ts:3-5`, `supabase/migrations/20260622_subscriptions.sql:13`, `supabase/migrations/20260723_notifications_unify.sql:55`, `lib/exportTables.ts:159`
- **Re-verified:** hardening pass — **SURVIVES**, and it is a name collision. `SKIP_TABLES.subscriptions` is justified as *"billing state is owned by the payment provider — re-subscribe, never copy"* (`dataRestore.ts:90`), but `lib/subscriptions.ts:1-5` declares that table to be the *"Generic watch/follow API… used by the notification fan-out helpers to find who to notify"*. The skip is reasoned about billing and lands on every watch relationship in the workspace.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The misidentification and the resulting skip are exactly as claimed. Two corrections pull the severity down: it is not silent — planRestore surfaces `willImport:false` plus that (wrong) reason string in the plan UI; and 'every watch/follow relationship' is overstated because ticket watchers live in tickets.watchers (read by recipients.ts:36-41) and `tickets` IS in the restore order list at dataRestore.ts:308, so ticket follows do come back. Only document/project/asset/library follows are lost, and only on a restore.

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

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/cron/maintenance/route.ts:376-381`, `app/api/cron/maintenance/route.ts:399-403`, `app/api/cron/maintenance/route.ts:408`, `app/api/cron/maintenance/route.ts:421-436`, `lib/notifications.ts:59-61`
- **Re-verified:** hardening pass — **SURVIVES**. The digest reads exactly one preference — `.select("user_id, email_enabled")` (`maintenance/route.ts:400-401`). `digest_frequency` is never consulted, so `'never'` has no effect, and no per-category preference is read at all.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. All three mechanics confirmed. Severity is inflated on two counts: the master `email_enabled` opt-out IS honored (route.ts:409), so a user can still achieve silence; and the 'per-category toggle' half is vacuous — `event_type: "compliance_digest"` matches no case in shouldSendForEvent() (lib/notifications.ts:154-165) and would fall to `default: return true` even if routed through queueEmail, and no compliance category exists in the settings UI. What remains is one deduped daily email that ignores a documented 'Never' choice and repeats handled items — MEDIUM.

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

**Resolution (2026-10-07, notifications Round G).** Package N6 EMAIL-PIPELINE-AND-CRON, together with `NEDGE-17` (the same read). Reproduced on `2de62f1`: the digest selected `user_id, email_enabled` only (`maintenance/route.ts:598-601` on the base), had no `read_at` filter and read `.limit(2000)` with no order; `lib/__tests__/maintenanceDrain.test.ts` "digest_frequency 'never' and the master switch silence it…" fails on the base route.
- `queueComplianceDigests` (`app/api/cron/maintenance/route.ts` :688): each ACTIVE member with an address is gated by the app's one email rule, `lib/notificationPrefs.ts` `emailAllowedByPrefs(row, "compliance_digest")` (:741) — the master switch, then `'never'`; the digest has no per-event toggle (DEC-74 §3). The preference rows are read as the service role (chunked `.in()`), so a missing row really is the defaults; a read that fails sends the digest stamped `metadata.pref_gate = 'unverified'` with an error line (DEC-74 §4).
- The row read adds `.is("read_at", null)` (:748): an item already read in the bell is not re-mailed.
- The read is per (org, recipient), ordered `created_at DESC, id DESC`, at most 200 rows per recipient; the subject's count is exact (`count: "exact"`), the body lists 12 distinct titles and "…and N more" (`NEDGE-17`).
- The per-(org, user, day) dedupe is unchanged; a check that fails sends anyway (a duplicate beats none) and says so.
- Tests: `lib/__tests__/maintenanceDrain.test.ts` — 'never' and the master switch silence it, a read item is not listed, a suspended member gets none; REGRESSION: no preferences row = the defaults, the digest as before; the unverified stamp; the dedupe preserved.

**Done-when.**
1. ✓ The digest calls the same preference rule as `queueEmail` (`emailAllowedByPrefs`, N1's exported helper) and honours `digest_frequency = 'never'`.
2. ✓ The scan filters `read_at IS NULL`.
3. ✓ The scan is ordered (`created_at DESC`, `id DESC`) and the cap is enforced per user (200 rows read per recipient), so which items are dropped is deterministic.

**Scope / residual.** A member who reads their own rows can still receive a digest listing items written in the last 25 hours that they have not opened — the intended behaviour. Cost: one read per active member with an address per day (members with nothing pending cost one indexed read); the step has a 90 s budget, reports a cut-short run, and rotates its starting member daily.

---

<a id="nedge-10"></a>

## NEDGE-10 · No email the system sends carries an unsubscribe affordance, and mention markup leaks raw into email bodies

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/notifications/send-queued/route.ts:145-153`, `lib/notify/dispatch.ts:116-127`, `app/api/tickets/comment/route.ts:308-311`, `lib/notifications.ts:168-183`
- **Re-verified:** hardening pass — **SURVIVES**, by census. `grep -c 'unsubscribe\|List-Unsubscribe'` returns **0** in both `lib/notify/dispatch.ts` and `app/api/notifications/send-queued/route.ts`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both halves confirmed by repo-wide grep: the only 'unsubscribe' hits in the codebase are Supabase realtime `subscription.unsubscribe()` calls, and tokenizeMentions is imported by exactly one consumer — components/requests/CommentBody.tsx, the in-app view — never by any email path, so the `@[Name](uuid)` markup with the internal user UUID ships verbatim in both text and HTML bodies. Partial mitigation: per-user opt-outs exist in notification_preferences and are honoured before queueing (route.ts:295-299, lib/notify/dispatch.ts:106-107) — the missing piece is an affordance in the message itself.

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

**Resolution (2026-10-07, notifications Round G).** Package N6 EMAIL-PIPELINE-AND-CRON. Reproduced on `2de62f1`: `grep -ci "unsubscribe"` over `app/api/notifications/send-queued/route.ts` and `lib/notify/dispatch.ts` returned 0; the Resend payload had no `headers`; the comment route copied `comment.text` verbatim into both bodies (`comment/route.ts:382-385` on the base). `lib/__tests__/n6TicketFanout.test.ts` "a mention renders as the name…" fails on the base route.
- One render layer, `lib/emailRender.ts`: `renderNotificationEmail` (every `emit()` email and the compliance digest) and `wrapEmailBody` (the two ticket templates). Each email carries the workspace's name (org branding) and a footer linking `${origin}/settings/notifications`; mention markup renders as `@Name` (`plainMentions`, built on `tokenizeMentions`, a fresh scan per call). The drain wraps any member row nothing rendered at queue time (no `metadata.rendered` — a row queued before this layer, or by `app/api/transmittal/route.ts`) with the same footer and mention rule at send time, without rewriting the stored row (`send-queued/route.ts` `outgoing`).
- `app/api/notifications/send-queued/route.ts` (`outgoing`, :59-75): every MEMBER email (not `metadata.external` — external mail is the transmittal's own template and its `to_user_id` is the sender) gets `List-Unsubscribe: <origin/api/notifications/unsubscribe?u=<to_user_id>&t=<hmac>>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). External mail is sent exactly as stored, as before.
- `lib/unsubscribeToken.ts` (new, server-only): the token is an HMAC-SHA256 of the uid under a fixed label, keyed by `EMAIL_UNSUBSCRIBE_SECRET` or else the service-role key; no key, no header (never an unsigned link).
- `app/api/notifications/unsubscribe/route.ts` (new): GET shows the choice and changes nothing (mail scanners fetch GET); POST — the mail client's one-click or the page's button — upserts `notification_preferences { user_id, email_enabled: false }` for the signed uid only. The plan's default scope: the master switch. The page says drawing recalls and safety alerts are still emailed (DEC-74 §9).
- `app/api/tickets/comment/route.ts` / `workflow-action/route.ts` fan-out email region only: `plainMentions` on the comment / note before it enters `body_text` / `body_html`; the composed bodies go through `wrapEmailBody`; `metadata.rendered`. Every interpolation still passes `escapeHtml` (report 08's invariant).
- Tests: `lib/__tests__/emailRender.test.ts` (mentions as names in text and HTML, the footer, escaping, the token), `lib/__tests__/maintenanceDrain.test.ts` ("member mail carries List-Unsubscribe…", the unsubscribe route's GET / POST / forged / refused cases), `lib/__tests__/n6TicketFanout.test.ts` (the comment email names the mentioned member, never the uuid).

**Done-when.**
1. ✓ A single render layer wraps every queued member email (queue-time for `emit()`, the digest and the ticket routes; the drain's backstop for every other member row), with the workspace's name, an absolute action link where the event has one, and a footer linking `/settings/notifications`; the drain attaches a List-Unsubscribe header pointing at a one-click opt-out.
2. ✓ Mention markup renders as plain names in `body_text` and `body_html`; internal uuids never leave the system (also at the drain, for rows queued before this layer).
3. ✓ The unsubscribe target works: it saves a row the `digest_frequency` CHECK accepts (N1's `NEDGE-2` fix; the upsert writes `email_enabled` and `updated_at` only, every other column at its default).

**Scope / residual.** The key: a deployment may set `EMAIL_UNSUBSCRIBE_SECRET`; until then the service-role key signs (rotating it voids old links, which then answer "not valid" and change nothing). Mail clients show the one-click control only for authenticated senders; that is the deployment's DKIM/SPF, not code.

---

<a id="nedge-11"></a>

## NEDGE-11 · The transmittal portal link mailed to external recipients is built from window.location.origin, the exact anti-pattern lib/publicOrigin.ts exists to prevent

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:389-392`, `lib/transmittals.ts:278`, `lib/transmittals.ts:316`, `lib/transmittals.ts:495`, `lib/transmittals.ts:579`, `lib/publicOrigin.ts:5-15`
- **Re-verified:** hardening pass — **SURVIVES**. `transmittalPortalUrl` is `const origin = typeof window !== "undefined" ? window.location.origin : ""` (`transmittals.ts:390`) — on the server that is the empty string, so the external recipient is mailed `/transmittal/<token>`. Same root as `document-control/XEDGE-5`; the fix must fail loudly rather than default to `""`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed as an unused-helper defect: transmittalPortalUrl never imports or calls publicOrigin(), and it feeds both the emailed link (:278 `const portalUrl = transmittalPortalUrl(t.portalToken)` → renderTransmittalEmail) and the printed QR (:316), on both issue paths (:495, :579). The `: ""` server fallback is not the live case — this is browser-side code — so a preview-deploy issuance mails an external recipient a Vercel-gated URL, which is also permanently baked into the acknowledgment record's QR.

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
- **Re-verified:** hardening pass — **SURVIVES**. `new Date(now).toLocaleString()` (`transmittal/route.ts:169`) and `new Date(row.started_at).toLocaleDateString()` (`maintenance/route.ts:348`) both execute server-side, so every recipient reads the server's locale and timezone rather than their own.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The two body-text sites are real: server-side toLocaleString/toLocaleDateString resolve to the runtime's default (UTC/en-US on Vercel) and carry no zone label. Two corrections to the finding: (a) the third citation, maintenance/route.ts:411 `const dayKey = new Date().toISOString().slice(0, 10)`, is an internal per-day dedupe key, not a timestamp rendered into any body, so it does not support the claim; (b) the authoritative record is unaffected — transmittal/route.ts:120,129 store `acknowledged_at: now` as an ISO-8601 UTC string and the audit_logs row at :140-145 is written from the same value — so the defect is confined to human-facing courtesy copy, which argues for the low end of MEDIUM.

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

**Partial (2026-10-07, notifications Round G).** Package N6 EMAIL-PIPELINE-AND-CRON. Reproduced on `2de62f1`: `new Date(row.started_at).toLocaleDateString()` in the stale-checkout escalation (`maintenance/route.ts:546` on the base); `lib/__tests__/maintenanceDrain.test.ts` "the notice's body names the day with its zone" fails on the base route.
- `lib/recordTime.ts` (new): the one helper. `formatRecordTime(iso, tz?)` → ISO-8601 with its offset and the zone named (`2026-03-20T23:15:15+00:00 (UTC)`, or `…-05:00 (America/Chicago)`); `formatRecordDate` → `2026-03-20 (UTC)`; an unparseable input is returned as given, never "Invalid Date". `orgTimeZone(client, orgId)` reads `org_configurations` key `timezone` (`data.timeZone`, a valid IANA name) and is null otherwise — nothing writes that key yet, so every body reads UTC, labelled.
- `app/api/cron/maintenance/route.ts`: the escalation body is "…checked out since 2026-03-20 (UTC)…" (`formatRecordDate`, :622); the digest names itself for when it was composed — "This digest lists your unread compliance notices from the 25 hours to `<time>` (`<zone>`)." The per-(org, user, day) dedupe on `metadata.day` (the UTC day) is kept exactly — the plan's default: keep the 03:00 UTC cron, no new `vercel.json` entry.
- Tests: `lib/__tests__/emailRender.test.ts` (the formats, a bad zone, `orgTimeZone`, and a pin that the cron calls no bare `toLocale*String()`), `lib/__tests__/maintenanceDrain.test.ts` (the escalation's body; the digest's UTC name; an org with a configured zone named in it).

**Done-when.**
1. ◐ The shared helper exists and the maintenance cron's two server-composed bodies use it. Not done: `app/api/transmittal/route.ts`'s acknowledgment email still prints `new Date(now).toLocaleString()` — document-control P7's file; the plan gives that one line to notifications N9 after P7 merges (fleet plan, N6 `dependsOn`).
2. ✓ The digest is explicitly named for when it arrives (the window's end, zone-labelled); its dedupe key stays the UTC day, unchanged, so a re-run never mails twice.
3. ✗ No org-level timezone setting exists. Opened as `NEDGE-19` (the plan's decision: recorded as a new finding, not built here). `orgTimeZone` already reads the key such a setting would write.

**Scope / residual.** Owners: done-when 1's transmittal line → notifications N9; done-when 3 → `NEDGE-19` (unassigned; the integrator assigns it).

---

<a id="nedge-13"></a>

## NEDGE-13 · Two declared digest kinds have full consumer support and no producer anywhere, while a live producer emits a kind that is not in the union at all

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/inAppNotifications.ts:33-36`, `components/notifications/NotificationBell.tsx:41`, `hooks/useTicketNotifications.ts:80-83`, `lib/storageAlerts.ts:60-61`, `app/api/data-export/run/route.ts:54-58`
- **Re-verified:** hardening pass — **SURVIVES**, by census. `kind: "task_overdue_digest"` and `kind: "morning_digest"` are each written **0** times anywhere in `app/` or `lib/`; the kinds exist only in the type union and in the consumer that renders them.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: both digest kinds are producer-less and `storage_alert` is a live producer outside the union. Two caveats that do not overturn it — `morning_digest` is NOT in NotificationBell's ICONS map (only `task_overdue_digest` is), so 'full consumer support' is slightly overstated; and `kind` is plain `TEXT NOT NULL` (20260723_notifications_unify.sql:18) with `sectionForKind`'s `default: return 'other'` (useTicketNotifications.ts:100), so the out-of-union kind still renders — the harm is maintainer confusion, not a runtime failure, which is what MEDIUM already implies.

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

**Partial (2026-10-01, notifications Round G).** **Reproduced first** on `b9cdfdc`: `task_overdue_digest` and `morning_digest` (and `task_nudge`, `task_reminder`) appear only in the union, `sectionForKind` and `KIND_ICON` — no producer in `app/`, `lib/`, `components/`, `hooks/`, `scripts/`, `types/`, `public/` or any SQL (the census test's comment-stripped search); `storage_alert` was a raw insert outside the union (`lib/storageAlerts.ts:60`).

**Fix (commit `95dbe50`).** The four producer-less kinds are deleted from the union (`lib/inAppNotifications.ts`, with a note saying why and what to grep before removing a kind), from `sectionForKind` (now registry-driven) and from `KIND_ICON` (the `task_overdue_digest: ListChecks` entry). `storage_alert` joins the union and `lib/storageAlerts.ts` writes through `notify()`'s typed insert (`PROD-10`). The census test is a ratchet on the raw inserts that remain (done-when 3).

- Files: `lib/inAppNotifications.ts`, `lib/notificationKinds.ts`, `hooks/useTicketNotifications.ts`, `components/notifications/NotificationBell.tsx`, `lib/storageAlerts.ts`, `lib/storageUsage.ts`.
- Tests: `lib/__tests__/notificationKinds.test.ts` "a retired kind has no producer anywhere", "a legacy row of a retired kind is bell-only and FYI", "the bell's icon map: the dead task_overdue_digest entry gone", "the producer census", "the census counts an insert call whose rows it cannot see" (review fix `42d5df8`); `lib/__tests__/notificationKindStorageProducers.test.ts`.
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ `morning_digest` and `task_overdue_digest` are deleted from the union, the icon map and `sectionForKind` — no declared kind without a producer (a census test asserts every declared kind is written somewhere).
- ✓ `storage_alert` joins the union and `lib/storageAlerts.ts` routes through `notify()`.
- **Not done — partly:** "raw inserts migrated onto `notify()` / `notifyMany()`, or a lint rule bans the direct insert outside `lib/inAppNotifications.ts`". Eleven raw insert calls remain in nine files other packages own (listed under `TAX-11`, which records the same state OPEN), so neither arm is met. What holds is a ratchet (`lib/__tests__/notificationKinds.test.ts`, the census; corrected in review fix `42d5df8`, which found it counted payload literals rather than calls): it counts every `.from("notifications").insert(` call per file, whatever its rows, and fails on a new one; fails on a pinned call whose rows it cannot evaluate (rows from a parameter or another file); fails on a notifications builder that leaves its chain; and checks that each remaining call's kind is a union member. It does not see an insert through a table name held in a variable. Met when the eleven move to `notify()` with their owners (`RAW_SITES` then empties), or if the integrator ratifies the census as the lint arm (`DEC-81` §5).

**Scope / residual.** Stays OPEN for done-when 3 only (as `TAX-11` done-when 2); record RESOLVED when the eleven raw inserts route through `notify()`, or on the integrator's ratification of the census as the ban. A legacy row of a retired kind still renders, bell-only and FYI — where its unrendered bucket left it. The only digest remains the cron's compliance email (N6).

*Cross-note (integrator, at the admin-and-org P3 merge, 2026-10-02).* The location `app/api/data-export/run/route.ts:54-58` no longer holds the insert. Admin-and-org P3 moved the `security_export` bell rows into `lib/exportAlerts.ts` (`alertControllers`): still one raw service-role insert, now with a kind declared in the registry and links inside the app. The raw-insert census (`lib/__tests__/notificationKinds.test.ts` `RAW_SITES`) pins it there, and the link census (`notificationWriteRails.test.ts`) judges its two links. The finding itself is unchanged.

---

<a id="nedge-14"></a>

## NEDGE-14 · The ticket comment and workflow-action routes still mail and bell suspended and inactive watchers: their own service-role fan-out has no membership filter

- **Severity:** HIGH
- **Status:** RESOLVED
- **Assigned:** unassigned. Opened 2026-10-02 by notifications Round G (N5 DISPATCH-AND-WRITE-HOLES, second review fix) from the package review. It is the remainder of `NEDGE-3` done-when 3 on a path N5 does not own (DEC-31). The plan's natural owner is N6 EMAIL-PIPELINE-AND-CRON, which edits both routes' `fanOut` builders by plan; the integrator assigns it and mirrors the N6 dependency in `audit-reports/fleet-plans/notifications.json`.
- **Assigned:** notifications N6 EMAIL-PIPELINE-AND-CRON (after drafting-flow DF-P1 merges, which edits both ticket routes) — by the integrator, 2026-10-02, at the N5 merge (DEC-31; fleet plan `audit-reports/fleet-plans/notifications.json`).
- **Verification:** CONFIRMED (read from the two routes at `f1ac550` / `b97e17c`: neither `fanOut` filters its recipients by membership, and neither email lookup has a status predicate)
- **Locations:** `app/api/tickets/comment/route.ts` (`fanOut` :291 — bell insert :309, email lookup :325, `email_notifications` insert :362; called at :131 with `recipients: newUnreadBy`), `app/api/tickets/workflow-action/route.ts` (`fanOut` :614 — bell inserts :636 / :674, email lookup :692, `email_notifications` insert :741; recipients from `computeTransition` and the assignment-queue pool, :308-327)
- **Independently verified:** opened 2026-10-02 by N5's second review fix; not yet challenged by a second party.

**Mechanism.** `NEDGE-3` filtered every `emit()` recipient to the event org's ACTIVE members (`lib/notify/dispatch.ts` `resolveRecipients` → `activeMembersOf`) and gave `emailsFor` a `.eq("status", "active")`. The two ticket routes do not go through `emit()`. Each builds its own recipient list (the ticket's watchers, requester, drafter, mentions and, for a workflow move into the assignment queue, the supervisor pool), inserts the bell rows, and looks up addresses as the service role:

```
comment/route.ts:325          supabaseAdmin.from("org_members").select("uid, email").eq("org_id", ticket.orgId).in("uid", recipients),
workflow-action/route.ts:692  supabaseAdmin.from("org_members").select("uid, email").eq("org_id", ticket.orgId).in("uid", recipients),
```

There is no status predicate and no membership filter on `recipients`. `20261160`'s insert trigger passes the service role untouched, by design.

**Failure scenario.** An engineer who watches REQ-118 is suspended. A colleague comments on the ticket. The engineer's inbox receives the comment email, with the ticket label in the subject and the whole comment in the body. A bell row carrying the first 140 characters is also written for them. Once `20261161` is pasted they can no longer read that row. Until then, and in their email regardless, they keep receiving ticket traffic they should not see. The same applies to a restore's `inactive` placeholders, and to every workflow move.

**Done when.**

- [ ] Both `fanOut` email lookups add `.eq("status", "active")` (`comment/route.ts:325`, `workflow-action/route.ts:692`).
- [ ] `fanOut`'s recipients are filtered to ACTIVE members of the ticket's org before the bell insert. Use `activeMembersOf` (`lib/notify/recipients.ts`), or the same predicate on the service role.
- [ ] A route test covers both routes: a suspended watcher gets neither a bell row nor an email, and an active watcher gets both.

**Closer:** unassigned (the integrator; plan owner N6, `99-fix-sequencing.md` Phase 1 hand-off).

**Resolution (2026-10-07, notifications Round G).** Package N6 EMAIL-PIPELINE-AND-CRON, after drafting-flow DF-P1 merged. Reproduced on `2de62f1`: neither route's `fanOut` filtered its recipients, and both email lookups lacked a status predicate (`comment/route.ts:357`, `workflow-action/route.ts:1110` on the base); the three NEDGE-14 cases in `lib/__tests__/n6TicketFanout.test.ts` fail on the base routes.
- `app/api/tickets/comment/route.ts` (:342-356) and `app/api/tickets/workflow-action/route.ts` (:1041-1053), fan-out region only: one service-role read, `org_members.select("uid, email").eq("org_id", ticket.orgId).eq("status", "active").in("uid", recipients)` — the predicate `lib/notify/recipients.ts` `activeMembersOf` applies for `emit()` ("the same predicate on the service role"; the routes do not bind the shared client) — gives both the active audience and the addresses. Bell rows go to the active audience only; emails only to active members with an address. A read that FAILS keeps today's bell audience (as `activeMembersOf` fails open) and mails no one (no address was read), logged. In the workflow route the stale-alert supersede still runs before the audience is checked, so an all-suspended audience still retires old alerts. DF-P1's audit-first order, read scope and hold release after the compare-and-set are untouched (their tests in `dfRoundG_P1_rails.test.ts` pass unchanged; its `EDGE-11` pin on the preference read still holds).
- Tests: `lib/__tests__/n6TicketFanout.test.ts` — comment: a suspended and an inactive watcher get neither, the active watcher and the drafter get both, the lookup asks for active members; workflow `submit_draft`: the requester and the active watcher get both, the suspended and inactive watchers neither; REGRESSION: the fail-open read; the supersede with an all-suspended audience.

**Done-when.**
1. ✓ Both email lookups filter `status = 'active'`.
2. ✓ The recipients are filtered to ACTIVE members of the ticket's org before the bell insert (the service-role predicate of `activeMembersOf`).
3. ✓ A route test covers both routes: a suspended watcher gets neither a bell row nor an email; an active watcher gets both.

**Scope / residual.** None.

---

<a id="nedge-15"></a>

## NEDGE-15 · The drafting handback route's "deliverable submitted / published" notice has never been delivered: it calls emit() on the unbound shared client

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** unassigned. Opened 2026-10-02 by notifications Round G (N5's second review fix), from a defect spotted while closing `NEDGE-3` (README Rules: a new defect gets a new ID). The route is drafting-flow's file (`GAP-6` / `DEC-22`), so the integrator assigns it there.
- **Assigned:** notifications N6 EMAIL-PIPELINE-AND-CRON (after drafting-flow DF-P1 merges) — by the integrator, 2026-10-02, at the N5 merge (DEC-31; fleet plan `audit-reports/fleet-plans/notifications.json`).
- **Verification:** CONFIRMED by reading `app/api/tickets/handback/route.ts`. The route imports only `supabaseAdmin` and never wraps the `emit()` call in `runWithServerClient`. The same unbound-client path is driven for another `emit()` caller in `lib/__tests__/orchestratorExecute.test.ts`, which shows the dispatcher stopping at its membership read before any insert.
- **Locations:** `app/api/tickets/handback/route.ts:103-117` (`emit()` after the audit row; `catch { /* best-effort */ }`), `lib/supabase.ts` (the shared client's server-side binding, `runWithServerClient`), `lib/notify/dispatch.ts` (`resolveRecipients` → `activeMembersOf`)
- **Independently verified:** opened 2026-10-02 by N5's second review fix; not yet challenged by a second party.

**Mechanism.** In a route handler, `lib/notify/dispatch.ts` runs on the shared `supabase` client. A route with no `runWithServerClient(supabaseAdmin, …)` leaves that client on the anon key with no session, so `auth.uid()` is NULL in every query it makes. Before `NEDGE-3`, `notifyMany`'s insert was refused by `notifications_org_insert`, which requires an active caller, and `emailsFor`'s `org_members` read returned no rows under RLS. Since `NEDGE-3`, `activeMembersOf`'s read returns no rows under RLS. That read succeeds, so its fail-open does not apply. `emit()` then returns before any insert. Both failures are swallowed by the route's `catch {}`.

**Failure scenario.** A drafter publishes the Final deliverable of REQ-204 as Rev C and the handback records it. The requester, the engineer and the ticket's watchers are never told: no bell row and no email. The route answers `ok: true`. The ticket's history shows the handback, but nobody is notified that the loop closed.

**Done when.**

- [ ] The route's `emit()` runs under `runWithServerClient(supabaseAdmin, …)`, as `app/api/cron/maintenance/route.ts`, `app/api/intake/upload/route.ts` and `lib/orchestrator/tools.ts` already do. Or the route writes its notice as the service role directly.
- [ ] A route test asserts that the requester gets the bell row and the email after a successful handback, and that a suspended watcher gets neither.

**Closer:** unassigned (drafting-flow owns the route; the integrator assigns it).

**Resolution (2026-10-07, notifications Round G).** Package N6 EMAIL-PIPELINE-AND-CRON, after drafting-flow DF-P1 merged. Reproduced on `2de62f1`: `app/api/tickets/handback/route.ts:103-117` called `emit()` with no binding and swallowed everything; `lib/__tests__/n6TicketFanout.test.ts` "the requester … get the bell row and the email…" fails on the base route, and "the reproduction: the same emit() on the UNBOUND shared client reaches nobody" shows why.
- `app/api/tickets/handback/route.ts` (:104-127): the notice runs as `runWithServerClient(supabaseAdmin, () => emit(...))` (`lib/serverClientScope.ts`, imported dynamically like the dispatcher, as the cron and the intake door do), so the dispatcher's membership read, bell rows and email gate run as the service role for this request only. A failure is logged and never fails the recorded handback.
- Tests: `lib/__tests__/n6TicketFanout.test.ts` — through the REAL dispatcher: the requester, the drafter and the active watcher get the bell row and the email row (with the absolute link and the footer); the suspended watcher gets neither; nothing went through the unbound client; the unbound `emit()` reaches nobody and now says so (`{ recipients: 0 }` and the warning), bound it delivers. `lib/__tests__/sweepRoundC2.test.ts`'s handback cases pass unchanged.

**Done-when.**
1. ✓ The route's `emit()` runs under `runWithServerClient(supabaseAdmin, …)`.
2. ✓ A route test asserts the requester gets the bell row and the email after a successful handback, and a suspended watcher gets neither.

**Scope / residual.** The route does not kick the email drain (the comment and workflow routes do): the email row is sent by the next drain — any member's browser kick in the org, or the daily cron. Not changed here (DEC-31).

---

<a id="nedge-16"></a>

## NEDGE-16 · After a restore every member is inactive, and nothing asserts or repairs it: notifications reach nobody and, after 20261161, nobody can read their bell

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** unassigned. Opened 2026-10-02 by notifications Round G (N5's second review fix). It is the remainder of `NEDGE-3` done-when 3 ("a post-restore all-inactive org is caught by an explicit assertion or a restore-completion step that reactivates members"). The fleet plan pointed it at admin-and-org P1 (restore / apply), and that package merged without it (DEC-31). The integrator assigns it, most likely to admin-and-org.
- **Assigned:** admin-and-org P8 (membership integrity: a post-restore check that refuses or repairs an org left with no active Admin) — by the integrator, 2026-10-02, at the N5 merge (DEC-31; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED by reading `app/api/admin/restore/begin/route.ts:100` and `app/api/admin/restore/apply/route.ts:110 (deleted by admin-and-org P3, ILIFE-4)`: a restore's members are created with `status: "inactive"`. *(Integrator, at the admin-and-org P3 merge, 2026-10-02: P3 deleted the single-shot `/apply` route, which had no caller; `/begin` is now the only place that inserts placeholder members as `inactive`, so this finding runs through it alone.)* Combined with `NEDGE-3`'s active-member filter and `20261161`'s read policy.
- **Locations:** `app/api/admin/restore/begin/route.ts:100`, `app/api/admin/restore/apply/route.ts:110 (deleted by admin-and-org P3, ILIFE-4)`, `lib/notify/dispatch.ts` (`resolveRecipients` → `activeMembersOf`), `supabase/migrations/20261161_notif_roundG_read_scope.sql` (`notifications_own_select`)
- **Independently verified:** opened 2026-10-02 by N5's second review fix; not yet challenged by a second party.

**Mechanism.** A restore links each backup person to a live member by email, or creates a placeholder with `status: "inactive"`. In a fresh workspace, that is everyone but the Admin who ran it. Since `NEDGE-3`, every `emit()` recipient must be an ACTIVE member. Role broadcasts already required that. Since `20261161`, a member reads their bell only while active in the row's org. So until an Admin reactivates members one by one, every notification of a restored workspace reaches nobody, and every member's bell reads empty. That is consistent, and better than the old asymmetry where followers were reached and role pools were not. But no assertion, banner or restore-completion step says so.

**Failure scenario.** An Admin restores the plant's backup into a new workspace and invites the team. Holds are placed, revisions published and acknowledgments requested, and nobody hears about any of it, because every restored member is still `inactive`. No error appears anywhere.

**Done when.**

- [ ] The restore's completion step either reactivates the members the Admin confirms, or ends with an explicit, visible assertion that the workspace has N inactive members who will receive no notifications until reactivated (on the restore page and in its audit row).
- [ ] A test drives a restore to completion and asserts one of the two.

**Closer:** unassigned (admin-and-org; the integrator assigns it).

---

<a id="nedge-17"></a>

## NEDGE-17 · The compliance digest reads one 2,000-row window across every org, unordered: a member's browser-legal compliance rows can push other tenants' overdue items out of their digest

- **Severity:** HIGH
- **Status:** RESOLVED
- **Assigned:** unassigned. Opened 2026-10-02 by notifications Round G (N5 DISPATCH-AND-WRITE-HOLES, third review fix), from the package review, which found that `DELIV-13`'s record claimed the opposite. The plan's natural owner is N6 EMAIL-PIPELINE-AND-CRON, which owns `app/api/cron/maintenance/route.ts` and already plans to order and page this scan for `NEDGE-9` done-when 3. The integrator assigns it and mirrors it in N6's `findings` in `audit-reports/fleet-plans/notifications.json`.
- **Assigned:** notifications N6 EMAIL-PIPELINE-AND-CRON (the compliance digest is its cron's) — by the integrator, 2026-10-02, at the N5 merge (DEC-31; fleet plan `audit-reports/fleet-plans/notifications.json`).
- **Verification:** CONFIRMED. Reproduced on PostgreSQL 16 against `20261160` as it stands on `fleet/N5-dispatch-rails` (below).
- **Locations:** `app/api/cron/maintenance/route.ts:569-577` (`queueComplianceDigests`: `.from("notifications").select("org_id, user_id, kind, title, link").in("kind", COMPLIANCE_KINDS).gt("created_at", since).limit(2000)`), `:342-352` (the daily scans, which write tonight's obligations), `:382` (the digest, which reads after them), `:556-566` (`COMPLIANCE_KINDS`), `supabase/migrations/20261160_notif_roundG_write_rails.sql` (`enforce_notification_insert()`: which kinds a browser may write, and the caps)
- **Independently verified:** opened 2026-10-02 by N5's third review fix; not yet challenged by a second party.

**Mechanism.** The digest builds each recipient's email from notification rows of the 15 compliance kinds written in the last 25 hours. Its read has no org filter, no recipient filter and no ORDER BY, and it stops at 2,000 rows. The daily scans write tonight's obligations (`review_due`, `ack_overdue`, `review_overdue` and the rest) as the service role a moment before the digest reads, so on a plain scan they are the last rows reached. Three compliance kinds are still browser-legal after `20261160`: `ack_requested`, `doc_superseded` and `review_requested` are declared and not server-only, because browsers write them for legitimate reasons (a manual acknowledgment request or re-nudge, a supersede notice, a review roster). The caps allow one member 600 rows a minute to each recipient, 1,200 an hour, and 3,000 a minute across all recipients. So in one minute, writing to four colleagues, one member can put 2,000 such rows into the window, and the window then holds little else.

**Failure scenario.** At 14:00 a member of org A writes 2,400 `ack_requested` rows: 600 to each of four colleagues, each row about one of the org's real documents. Every row lands within every cap. At 03:00 the cron runs. The scans write the two overdue items of org B's Document Controller, then the digest reads 2,000 rows, 1,999 of them org A's. Org B's two lines are not in the read. That Document Controller's digest lists only an older item. Had they had nothing earlier in the window, no digest would be queued for them at all. Nothing errors. The digest is the only email that lists overdue compliance obligations (`NEDGE-9`).

**Evidence (PostgreSQL 16, third review fix).** Scratch cluster with `20260723`'s notifications SQL and `20261160` as on the branch:
- Org B's Document Controller has one `review_due` row from an hour earlier.
- Org A's member writes 4 × 600 `ack_requested` rows, each about its own document. All 2,400 land in one minute.
- The scans then write org B's `ack_overdue` and `review_overdue` rows as the service role.
- The digest's exact read returns 2,000 rows: 1,999 of them org A's, and 1 org B's (the earlier `review_due`). Neither of tonight's two lines is among them.
- Its plan is a sequential scan with a filter and a limit.

**Chain reaction.** `NEDGE-9` done-when 3 asks for the scan to be ordered and paginated, "or the cap enforced per-user". Ordering alone does not close this finding: an ordered scan with a global cap is displaced by rows written at whichever end of the window it reads first. A writer can also add lines to a colleague's digest, up to the same caps. Until this review, `DELIV-13`'s record said "a forged row adds a line to someone's digest, never removes one". Its residual now points here.

**Done when.**

- [ ] The digest no longer shares one capped read across orgs and recipients. Any of these closes it: each (org, recipient) list is composed from a read scoped to that pair; or the whole window is paged (ORDER BY created_at, id) with no global cap; or, preferably, the digest is composed from the obligation tables (`listMyPendingAcks`, the pending reviews and the due recertifications that `lib/inbox.ts` lists), not from user-writable notification rows.
- [ ] A test floods the window with one org's browser-legal compliance rows and shows that another org's recipient still gets every one of their lines.

**Closer:** unassigned (the integrator; plan owner N6, `99-fix-sequencing.md` Phase 1 hand-off).

**Resolution (2026-10-07, notifications Round G).** Package N6 EMAIL-PIPELINE-AND-CRON. Reproduced on `2de62f1` through the real route: `lib/__tests__/maintenanceDrain.test.ts` "2,400 browser-legal ack_requested rows in org A…" fails on the base route (the shared, unordered 2,000-row read returns org B's earlier `review_due` and none of tonight's two lines).
- `queueComplianceDigests` (`app/api/cron/maintenance/route.ts` :688): the digest no longer shares one capped read. It pages the ACTIVE members (ordered `org_id, uid`, 1,000 a page) and composes each (org, recipient) list from a read scoped to that pair — `.in("kind", COMPLIANCE_KINDS).eq("org_id", …).eq("user_id", …).is("read_at", null).gt("created_at", since)`, ordered `created_at DESC, id DESC`, at most 200 rows, with an exact count. One member's rows reach only the people they were written to.
- `COMPLIANCE_KINDS` derives from `lib/notificationKinds.ts` `KIND_META`'s `compliance` column (:654) — the same set as the hand list it replaces (pinned by `notificationKinds.test.ts`).
- A failed per-recipient read, a failed insert and a cut-short run are each a line in `errors` (also logged).
- Tests: `lib/__tests__/maintenanceDrain.test.ts` — the flood (2,400 `ack_requested` rows to four org-A colleagues within the window, org B's Document Controller's three lines all present, the flooded colleagues' own counts exact); the read is scoped by org and uid. `lib/__tests__/notificationWriteRails.test.ts`'s census entry for this read now records it as per-recipient.

**Done-when.**
1. ✓ Each (org, recipient) list is composed from a read scoped to that pair (the first of the three options).
2. ✓ A test floods the window with one org's browser-legal compliance rows and shows another org's recipient still gets every one of their lines.

**Scope / residual.** A member can still ADD lines to a colleague's digest by writing browser-legal compliance rows to them, within DEC-86's caps — the done-when does not ask otherwise. Composing the digest from the obligation tables (the finding's "preferably") would remove that too; it is not built here (DEC-31) and `DELIV-13`'s residual keeps pointing at it.

---

<a id="nedge-18"></a>

## NEDGE-18 · Once 20261161 is pasted, the attention feed's browser-side mark on a stale workflow alert is refused, so an alert the workflow route missed stays in the unread window

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** notifications N4 FEED-PROVIDER-AND-REALTIME (it owns `hooks/useTicketNotifications.ts` and its reconcile pass; TRAIL-9's retirements meet the same rail) — opened and assigned by the integrator, 2026-10-07, at the drafting-flow DF-P1 merge (DEC-31; fleet plan `audit-reports/fleet-plans/notifications.json`).
- **Verification:** CONFIRMED by reading the two merged changes together: `20261161`'s `enforce_notification_update()` (`trg_notifications_read_at_only`) refuses a recipient's change to any column but `read_at` on their own row, and DF-P1's reconcile in `hooks/useTicketNotifications.ts` writes `metadata.superseded_at` on the recipient's own rows from the browser. The census in `lib/__tests__/notificationWriteRails.test.ts` ("every UPDATE writes read_at and nothing else … but the two classified metadata marks") names both writes.
- **Locations:** `hooks/useTicketNotifications.ts:234-283` (the reconcile: stale workflow rows filtered from the feed, then `.update({ metadata: { …, superseded_at } })` on each, best-effort), `supabase/migrations/20261161_notif_roundG_read_scope.sql` (`enforce_notification_update`, the read_at-only trigger; the service role passes), `app/api/tickets/workflow-action/route.ts:1072-1088` (the route's own supersede, on the service role, unaffected), `lib/inAppNotifications.ts` (the unread list leaves superseded rows out)
- **Independently verified:** — opened 2026-10-07 by the integrator at the DF-P1 merge; not yet challenged by a second party.

**Mechanism.** Two merged packages meet here. notifications N5 (`DEC-86`, `20261161`) holds a recipient to changing only `read_at` on their own notification rows. drafting-flow DF-P1 (`EVID-13`) retires a moot workflow alert by marking `metadata.superseded_at`, never `read_at`. The route does this on the service role. The attention hook does it in the recipient's browser for any alert the route missed: a ticket the shed archived, or a status reached by a path that does not fan out. Before `20261161` is pasted the hook's mark lands. After it, the trigger refuses it. The hook swallows the refusal, and the feed still hides the row in that session, so nothing breaks on screen. But the row stays unread and unsuperseded in the database, so it keeps its place in the 50-row unread window that `listMyNotifications` reads, and enough of them push live alerts off the bell. The hook's comment names that exact harm as the reason for the mark.

**Failure scenario.** After `20261161` is pasted, a drafter has 60 workflow alerts for tickets the shed archived. The route never superseded them, because the shed does not fan out. Each page load hides them and tries to mark them, and every mark is refused. The bell's unread read returns the newest 50 rows, all of them moot, so a live "issue the IFC" alert below them is not shown.

**Done when.**
- [ ] The reconcile's supersede mark is made where `20261161` lets it land: a server path (a route on the service role, or a SECURITY DEFINER function that sets only `metadata.superseded_at` on the CALLER's own unread workflow rows whose ticket status no longer matches, refusing anything else), never a browser write of `metadata`.
- [ ] The same holds for any other browser-side retirement N4 adds (TRAIL-9's `hold_released` → `hold_opened`, `branch_resolved` → `branch_open`).
- [ ] The census in `lib/__tests__/notificationWriteRails.test.ts` drops the hook from its `METADATA_UPDATES` list, and every browser UPDATE of notifications writes `read_at` only.
- [ ] Regression: an alert the route supersedes is unchanged, and the feed shows exactly what it shows today.

---

<a id="nedge-19"></a>

## NEDGE-19 · No org-level timezone exists: every server-composed time and the compliance digest are in UTC, labelled, never the plant's own zone

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** unassigned. Opened 2026-10-07 by notifications Round G (N6 EMAIL-PIPELINE-AND-CRON) as `NEDGE-12` done-when 3, per the fleet plan's decision ("an org-level timezone setting is recorded as a new finding, not built here", DEC-31); the integrator assigns it.
- **Verification:** CONFIRMED by search at `2de62f1` + N6: no `timezone` / `time_zone` column or `org_configurations` key is written anywhere in `app/`, `lib/`, `components/` or `supabase/`.
- **Locations:** `lib/recordTime.ts` (`orgTimeZone` reads `org_configurations` key `timezone`, `data.timeZone`; nothing writes it), `app/api/cron/maintenance/route.ts` (the digest's name and the escalation's date use it), `vercel.json` (`0 3 * * *`)
- **Independently verified:** opened 2026-10-07 by N6; not yet challenged by a second party.

**Mechanism.** Since N6, server-composed notification bodies render through `lib/recordTime.ts`: ISO-8601 with the offset and the zone named. The zone is the org's when `org_configurations` key `timezone` carries a valid IANA name, else UTC — and no surface writes that key, so every body reads UTC. The compliance digest runs at 03:00 UTC (evening in the Americas) and is named for the window it covers ("the 25 hours to `<time>` (UTC)"); its per-day dedupe key is the UTC day.

**Failure scenario.** A plant in Houston receives its "compliance items need you" digest at 22:00 the evening before, labelled in UTC. Correct and unambiguous, but not the plant's morning and not its clock.

**Done when.**

- [ ] An Admin can set the workspace's IANA timezone (a validated `org_configurations` row, key `timezone`, `data.timeZone` — the shape `orgTimeZone` already reads).
- [ ] Server-composed bodies then show that zone (no code change in `lib/recordTime.ts` callers).
- [ ] Whether the digest's send time follows the zone is decided: it cannot without a cron entry per zone (`99-fix-sequencing.md`: no new cron entry), so either the daily run composes per-zone windows, or the digest stays one daily run named for its window.

**Closer:** unassigned (the integrator; notifications or admin-and-org).
