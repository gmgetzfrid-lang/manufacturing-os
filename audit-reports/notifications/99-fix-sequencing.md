# 99 · Execution order

**Binding, not advisory.** No findings of its own — this is the plan the 105
findings and 7 gap specs are worked against. The specs live in
[`90-gap-register.md`](./90-gap-register.md); this file says what order they go
in and what must not ship before what. Judgment calls shared with the other areas are
settled in [`../DECISIONS.md`](../DECISIONS.md).

---

## The one that goes first

> **`NEDGE-2` — the notification preferences page can never save.**

The UI writes `digest_frequency: 'immediate'`. The CHECK constraint permits only
`'instant'`. Every insert from a user who has not already saved is rejected.

It is a **one-word fix** and it comes before everything else in this area for a
reason that has nothing to do with its severity: **it is the escape hatch for
every other change here.** Login nudges, a spinning bell, a pulsing badge, OS
push — all of it is attention-grabbing behaviour, and all of it needs a working
"turn this off" before it ships. Ship the attention first and the first person it
annoys has no recourse, which produces exactly the reaction the owner asked to
avoid.

**Verified.** This was originally flagged as needing reproduction because it sits
in the critic's report. It has since been checked by hand against the source and
confirmed verbatim — every quoted line matches, `digest_frequency` has exactly one
CHECK definition with no later `ALTER`, and `grep -rn "'immediate'" supabase/`
returns **nothing**: the token the UI writes appears in no SQL file in the
repository. The record is at the top of
[`08-edges-and-invariants.md`](./08-edges-and-invariants.md).

Still reproduce before fixing, per `DEC-29` — but expect it to reproduce.

---

## The governing idea for this area

**Durable and ephemeral are different jobs, and most defects here are an event
using only the ephemeral channel.**

- **Durable** — a row that survives you not looking: the bell feed, email, an
  acknowledgment. This is evidence, and in a PSM-regulated system some of it is
  legally required.
- **Ephemeral** — a toast, an indicator, a progress chip. It confirms something
  you just did.

Before adding any signal, decide which one it is. A compliance obligation that
appears only as a toast is not delivered. A "saved!" confirmation that writes a
durable row is noise that someone has to clear.

**Corollary:** the fix for a missing notification is almost never a new toast.

---

## Phase 0 — Free, independent, immediately felt

| Item | Why now |
|---|---|
| **`NEDGE-2`** | Above. One word. |
| **`PROD-1` / `TRAIL-2` / `DELIV-3` / `TAX-2` / ~~`NEDGE-1`~~** | Map the 26 unmapped kinds in `sectionForKind`, and add a `const _never: never = kind` in the default arm so a new kind is a **build error** until mapped. Still the highest-value change in the area — but **do the work for the four surviving findings, not for `NEDGE-1`, which is refuted.** `NEDGE-1` claimed an unmapped kind never badges anything; it does — `legal_hold_placed` reaches `items`, the header bell count, the bell list and `/inbox`. The real gap is the per-section badge, which is what the other four describe. Read the sizing here as cosmetic-plus-maintainability, not as a missed-notification defect. |
| **`TAX-1` / `TRAIL-3`** | Make the badge's own comment true. `AttnFilter` has no section member; add one so the "3" on Documents opens Documents' three. Small, and it is the difference between a doorway and a decoration. |
| **`DELIV-4`** | The admin "No failed deliveries" panel cannot report a failure. A green light wired to nothing is worse than no light. |
| **`DELIV-5`** / `NEDGE-4` | Notification emails carry root-relative links, dead in every mail client. Every "you were mentioned" email currently has a broken call to action. |

None of these constrain any later decision, and users notice all of them.

---

## Phase 1 — Close the two write holes

Both come from the same root: `notifications` and `email_notifications` accept
client-side inserts.

1. **`DELIV-1`** — any active org member can insert an arbitrary outbound email,
   free-text recipient and subject, from your sending domain.
2. **`OS-1`** — any active org member can insert unlimited notification rows for
   any other member, with arbitrary title, body and link.

Same shape as the `tickets` policy in the drafting-flow area, and the same fix
shape: keep permissive `SELECT`, restrict `INSERT`/`UPDATE` to the service role,
and route the legitimate client-side writers through a server route.

⚠ **`OS-1` is a prerequisite of any nudge feature.** A person-to-person poke on
top of an unconstrained insert path is a harassment vector, not a feature.

*Hand-off (2026-10-02, notifications Round G, N5 DISPATCH-AND-WRITE-HOLES →
N8, N9, N12): the database's kind allowlist is a FUNCTION,
`notification_kinds()` (`20261160`), not the planned reference table. A
package that adds a kind to `lib/notificationKinds.ts` `KIND_META` also
re-creates `notification_kinds()` in a migration of its own — from the NEWEST
definition in `supabase/migrations` plus its new rows — and that migration is
pasted BEFORE the deploy that writes the kind: once `20261160` is live, a
browser's row of a kind the live function does not list is refused (22023)
and only logged by `notify()`, so the notice is silently lost. N8
(`milestone_*`, `access_request_*`) therefore needs one migration; N9's
"INSERT the new kinds into notification_kinds" becomes that re-create; N12's
nudge kind is added the same way. Two packages re-creating it in parallel:
`lib/__tests__/notificationWriteRails.test.ts` pins the NEWEST definition to
`KIND_META`, so the later-numbered one fails CI at merge until it carries both
packages' kinds — and they are pasted in number order.*

*Hand-off (2026-10-02, notifications Round G, N5 → N6) — **`NEDGE-14`**:
`NEDGE-3`'s invariant — a suspended or inactive member gets neither bell row
nor email — holds for every `emit()` producer but not for the two ticket
routes' own service-role `fanOut` (`app/api/tickets/comment/route.ts`,
`app/api/tickets/workflow-action/route.ts`; drafting-flow's files, whose
`fanOut` builders N6 edits by plan). N6: both `fanOut` email lookups
(`comment/route.ts:325`, `workflow-action/route.ts:692`) add
`.eq("status", "active")`, and `fanOut`'s recipients are filtered to active
members of the ticket's org before the bell insert (`activeMembersOf`,
`lib/notify/recipients.ts`). Until then a suspended ticket watcher keeps
getting comment and workflow emails; the bell rows are hidden from them once
`20261161` is pasted. The integrator mirrors this in N6's `dependsOn` /
`findings` in `audit-reports/fleet-plans/notifications.json` (N5 does not
edit the plan).*

*Hand-off (2026-10-02, notifications Round G, N5 third review fix → N6) —
**`NEDGE-17`** (HIGH): the compliance digest's read
(`app/api/cron/maintenance/route.ts` `queueComplianceDigests`) is cross-org,
unordered and cut at `.limit(2000)`. Three compliance kinds stay
browser-legal after `20261160` (`ack_requested`, `doc_superseded`,
`review_requested`), so one member, within the caps, can fill the window in
a minute and push other users' and other tenants' lines out of their digest.
Reproduced on PostgreSQL 16. `DELIV-13`'s record said the opposite until
this review. N6, which owns the route and already orders and pages this scan
for `NEDGE-9` done-when 3: ordering with a global cap is not enough. Scope the
read per (org, recipient), or page the whole window with no global cap, or —
better — compose the digest from the obligation tables (`listMyPendingAcks`,
pending reviews, due recertifications) instead of user-writable notification
rows. The integrator adds `NEDGE-17` to N6's `findings` in
`audit-reports/fleet-plans/notifications.json`.*

*Opened by N5's second review fix (2026-10-02), not this area's to sequence
alone: **`NEDGE-15`** — `app/api/tickets/handback/route.ts`'s `emit()` runs
on the unbound shared client and has never delivered (drafting-flow's route);
**`NEDGE-16`** — after a restore every member is `inactive` and nothing
asserts or repairs it (the remainder of `NEDGE-3` done-when 3 that the plan
pointed at admin-and-org P1, which merged without it).*

---

## Phase 2 — Stop the drops

`RT-1` (events fired while the tab sleeps are lost from the live UI — a
reconcile-on-focus fixes it), `TAX-6` (the 50-row cap silently truncates a busy
week), `RT-3` (three-to-six concurrent copies of `useTicketNotifications` each
opening their own channel), `RT-2` (every checkout message in the workspace
toasted to every signed-in user).

*Hand-off (2026-10-01, notifications Round G, N1 PREFS-GATE → N3): the change
that makes `components/providers/NotificationListener.tsx` read the pop-up
preference, whether through `lib/notificationPrefs.ts` `readToastPreference` or
`toast_enabled` directly, must also flip `TOAST_PREFERENCE_HONOURED` to `true`
in `lib/notificationPrefs.ts`. That is one line in N1's file. Until it is
flipped, the settings page does not offer the "Pop-up toasts" switch.
`lib/__tests__/notificationPrefs.test.ts` fails whenever the listener mentions
either name while the flag is false, and the reverse (`RT-10`).*

*Hand-off (2026-10-01, notifications Round G, N7 CORNER → N3 / N4 / N12, under
`DEC-85`):*
- *`showToast` takes an optional `coalesceKey`. Identical toasts within 10 seconds
  are already one card with a count, by type, title and message.
  `components/providers/NotificationListener.tsx` (N3's) should pass
  `` coalesceKey: `${row.kind}:${row.resource_id}` `` for a notification row, so
  that differently worded rows about one event coalesce too. `RT-11` and `OS-4`
  stay OPEN (Partial) on done-when 2 until that line lands; N3 closes them.*
- *`RT-11` done-when 1 (2026-10-02, N7 final review): while the corner dock is
  raised over a modal that started an upload, its "+N more" card offers no
  "Notifications" doorway. The center (`NotificationCenter.tsx`, 240 / 241, N3's)
  would open under that modal, invisible. N3 lets the center open above an open
  upload modal when it is opened from the dock; then the `!raised` guard on the
  doorway in `components/ui/CornerDock.tsx` comes off. `RT-11` stays OPEN on that
  too; N3 closes it.*
- *The corner dock rests under every overlay (`Z.dock` = 290, the old dock's
  place). It rises above every modal (`Z.dockRaised` = 750) only while a modal
  that has started an upload is open and the dock reports an upload. The modal
  calls `useDockRaise(open && <an upload was started here>)` from
  `components/ui/CornerDock.tsx`; a scan test refuses `useDockRaise(open)`. The
  dock also needs a `raisable` card: `UploadIndicator`'s. Raised, only the upload
  cards hold places; the backup, indexing and toast cards wait behind "+N more",
  which offers no "Notifications" doorway; every upload failure that arrives
  while raised runs its clock from its event (one that was waiting behind the cap
  at rest still waits until it shows); and the dock ignores right rails (N7
  fourth review, final review).
  Such a modal must also declare its action row with `useDockAvoid(ref, open)`;
  a scan test refuses one that does not. The three upload-starting modals do
  both. The shared `ModalFooter` declares its row for any dialog opened over
  them (N7 edited `components/ui/Modal.tsx`'s `ModalFooter`, outside its plan).
  A package that adds a modal that starts an upload raises the dock that way and
  declares its row. Other overlays declare nothing, because at rest the dock is
  under them. While raised, the upload cards still cover the right end of the
  raising modal's body above its row until the run's cards clear. The integrator
  ratified `DEC-85` item 4 on 2026-10-02 as meeting `STACK-10` done-when 1
  (confirmed by the integrator under the user's delegation, 2026-10-07 — DEC-90).
  `STACK-14` stays OPEN (Partial) on that, and on its done-when as written, which
  the ratification does not meet. Its owner is notifications N13 LAYERS SWEEP (new, added
  by the integrator at the N7 merge, 2026-10-02 — with `TAX-14` done-when 4),
  which runs last, after every fleet that edits overlay files.*
- *The corner dock is `role="region"` / `aria-live="polite"` /
  `aria-relevant="additions"`. The toast list is `role="status"`, an error toast
  is `role="alert"`, and every toast's X has `aria-label="Dismiss"`. That is
  NEDGE-5's done-when 2 limb, for N3 to verify and close.*
- *The notification center is passed to the dock as a right rail by the layout
  (`occupiedRightPx`, 480 = `NotificationCenter.tsx`'s `w-[480px]`, pinned by a
  test). If N2 / N3 change the panel's width, update
  `NOTIFICATION_CENTER_RAIL_PX`, or have the panel call `useOccupyRightRail`
  itself and drop the prop.*
- *`lib/intents.ts` (its owner; not N7's file): reset `created_at` when
  `recordIntent` re-declares an expired edit intent, for example by deleting the
  expired row before the upsert. Until then an overlap that re-forms before the
  daily prune keeps its old formed time, and the overlap banner can show a false
  "Heads-up sent ✓". `TAX-8` stays OPEN (Partial) on done-when 3 until it lands;
  the pin in `lib/__tests__/cornerJobs.test.ts` "TAX-8 (N7 third review)" then
  changes with it.*
- *`app/(protected)/layout.tsx`: N7 changed the `<main>` mount block (the docks
  first) and the hook preamble of `ProtectedContent` (one line,
  `useNotificationCenter`). N4 (:239 provider) and N12 (:72) rebase on it.*

Then the census holes in severity order: `PROD-2` (access requests notify
nobody), `PROD-14` (`markup_request` never notifies the person asked), `PROD-9`
(holds never notify the owner), `PROD-3`, `PROD-5`.

`PROD-6` and `PROD-11` — the silent subsystems — are **deliberately last** in
this phase. They are the largest and the least urgent: nobody is currently
relying on a notification that does not exist. Do not start here because the
list is long.

*Hand-off (2026-10-07, notifications Round G, N8 PRODUCERS-FREE → N3, N6,
N9, N10, N14, the integrator):*
- *Paste `20261181` (four kinds on `notification_kinds()`, and
  `clear_resolved_branch_alerts`) after `20261160` / `20261161` and BEFORE
  the deploy: `change_order_status`, `milestone_assigned` and
  `milestone_slipped` are written from the browser. A later re-create of
  `notification_kinds()` (N9, N12) starts from `20261181`'s body.*
- *N3: the four kinds are in `BELL_ICON_GAPS` (the bell has no entry);
  deriving the bell's icons from `KIND_META` needs a component for the new
  `KindIcon` name `Flag` (the feed's milestone icon), and empties that list.*
- *N9: swap the library page's `notifyLibrarySubscribers` closure onto
  `lib/libraryNotify.ts` `notifyLibraryDocsAdded` (in-app only) and pass
  `actorName` to `CsvImportModal` — `PROD-5` done-when 2 and `PROD-7`
  done-when 3 close with it. (Fix pass 3: the helper now names an actor
  passed without a name by their email in the org, as the staged-upload
  path does. Passing `actorName` is optional, and a passed name is used
  verbatim.)*
- *N14: `TAX-11`'s six remaining raw calls, in your five assigned files;
  none of N8's is left (fix pass 2 moved the export alert and the folded
  intake digest itself, so `RAW_RESOLVED` keeps no raw site by reason).
  `notifyChecked` takes an optional client, which is how a service-role
  writer moves onto the typed sink. For many rows in ONE statement, use
  `notifyBatchWithReason(rows, client?)`. It answers `{ landed, error? }`:
  the count is the database's, from `count: "exact"`, not the rows sent (the
  insert rail skips a non-member's browser row), plus the refusal's text.
  `notifyBatchChecked` is its count alone. Do not add a `.select()`
  read-back: from a browser it is a RETURNING that the own-rows read policy
  refuses for another person's row.*
- *N14 (fix pass 3): **`PROD-16`** (LOW, `01-producer-census.md`). Two
  access requests past the per-org cap that land at once can give a pool
  member two burst rows: `notifyAccessRequestBurst`'s open-row read and its
  insert are not serialised. The fix is a migration: one SECURITY DEFINER
  function, service role only, that checks and inserts under an advisory
  lock keyed on the org. The integrator adds `PROD-16` to N14's `findings`
  in `audit-reports/fleet-plans/notifications.json`.*
- *Integrator: ratify `DEC-92` item 1's per-org burst limit as the
  narrowing of `PROD-2` done-when 1. As written ("emits … on insert") it
  holds only for the first five requests to an org in an hour. `PROD-2` is
  RESOLVED only as narrowed, and is OPEN on done-when 1 if the narrowing is
  not ratified (its Pending ratification line). Ratify item 2's reading of
  `PROD-6` done-when 2 (punch / checklist items have no person-assignee).
  Route `PROD-15` (assigned: admin-and-org P5 — the pending list and
  `access_requests_admin_select`) and `PROD-16` (assigned: N14).*
  *Done by the integrator at the N8 merge (2026-10-07), under the user's
  delegation: `DEC-92` items 1–6 ratified as written (item 2 supersedes
  `PROD-6` done-when 2 — `PROD-6` RESOLVED); `PROD-15` is in admin-and-org
  P5's findings and `PROD-16` in N14's (N14 now expects one migration).*
- *N6 / N10 (`lib/notify/dispatch.ts`, N5's merged file; fix pass 3):
  `EmitInput` gained an optional `inappOneStatement`. When it is set, the
  in-app leg is ONE `notifyBatchWithReason` statement instead of
  `notifyMany`. Only `lib/milestones.ts` `notifyScheduleChange` sets it; no
  other `emit()` caller changes. `lib/notify/recipients.ts` gained
  `projectVisibleAmong`, the app-side reading of `project_visible_to_me`
  for recipients a producer names by hand (SEC-2). Rebase on both; they are
  additive.*
- *N3 / N9 (`lib/activityThread.ts`, merged N2 file): `PostInput` gained
  `notifyExclude` (N8's review fix: a markup share's requester is told by
  `resolveMarkupRequest`, not by the thread's notice). The thread's
  "… requested markup on …" wording for a share is still TAX-3 / TAX-4's.*
- *projects-tab (FYI, N8 fix pass 2): `lib/milestones.ts`'s two reschedule
  notes (`updateMilestone`, `applyMilestoneMoves`) wrote the finish date in
  the writer's local zone and locale. That is the same mistake as `SCH-10`.
  They now use `scheduleDateLabel`, the board's day written "7 Oct 2026",
  so no new finding was raised. The schedule's notices now run behind the
  write (`inBackground`), so the board no longer waits on them. A change
  order's notice now also reaches its budget line's `cam_user_id` when set.
  Nothing writes that column yet; a feature that sets it changes who hears.
  (Fix pass 3: on a private project the CAM, a change order's proposer, a
  turnover item's creator and a task's new assignee are told only while
  they can see the project — its owner, its roster, or an Admin / DocCtrl.
  Removing someone from a private project's roster now also stops these
  notices to them.)*
- *admin-and-org P5 (`request-access` rebases on this): the door's per-org
  cap (`ACCESS_REQUEST_NOTICES_PER_ORG_HOUR`) gates the bell leg as well as
  the email leg. Past the cap, the pool holds one "more access requests are
  waiting" row each (`resource_type 'org'`, no actor), which no decision
  clears. When the count cannot be read, that row says "access requests are
  waiting" and gives no number (fix pass 3). If the pending list moves or
  becomes DocCtrl-readable (`PROD-15`), keep that row's link pointing at
  it.*

---

## Phase 3 — The trail

Only after Phase 0's `sectionForKind` fix, which is what makes any of this
possible.

**`TRAIL-1` is the build**: no page below the sidebar consumes notification state
at all. The work is a per-container roll-up — notification rows already carry
`resource_type` / `resource_id`, so the missing piece is the container chain from
a document up to its folder and library.

**Do not invent a second chain walk.** `resolveEffectiveDocClass`
(`lib/docClass.ts:49-58`) already does document → folder → library, and
`review_control` mirrors it. A third implementation drifts from the other two.

Then `TRAIL-4` (nothing marks a document notification read when you visit the
document — only `/requests` does) and `TRAIL-5` (`tally(section, false)`
hardcodes `actionRequired` to zero for every notification-sourced item, so a red
badge can never come from a notification).

---

## Phase 4 — The taxonomy

`TAX-5` — six independent hand-maintained classifications of the same
`notifications.kind` string, which do not agree. Collapse to one table that the
others derive from. This is a refactor with no user-visible change, which is
exactly why it goes after the visible fixes and before the new features: every
feature below adds a seventh classification otherwise.

Then `TAX-3` and `TAX-4`, the duplicate-signal defects.

---

## Phase 5 — The new capability

**Every item below is a spec in [`90-gap-register.md`](./90-gap-register.md).**
Build from the spec, not from the finding — each carries a `Do not` list naming
the specific wrong turn.

| Order | Spec | Gate |
|---|---|---|
| 1 | `GAP-203` — preferences that can be saved | nothing below ships without it |
| 2 | `GAP-201` — kind → section, build-error enforced | already Phase 0; restated because `GAP-202` and `GAP-206` both depend on it |
| 3 | `GAP-204` — the login nudge | needs `GAP-203` **and** `NEDGE-5` |
| 4 | `GAP-202` — the badge trail | the largest, and the one the owner asked for first |
| 5 | `GAP-207` — one kind taxonomy | before the next two, or they add an eighth |
| 6 | `GAP-205` — Web Push | needs `GAP-203` for `push_enabled` |
| 7 | `GAP-206` — the person-to-person nudge | needs `OS-1` closed first |

In this order, and not before the phases above.

1. **Accessibility first — `NEDGE-5`.** No `aria-live`, no accessible name on the
   bell count. Everything below makes that worse. `prefers-reduced-motion` has to
   be honoured by the same change.
2. **The login nudge.** Needs a per-user "last opened the bell" timestamp, which
   does not exist. Dismissible, and the dismissal remembered.
3. **The bell/badge animation.** `animate-pulse` is already applied to a red badge
   (`Sidebar.tsx:510`); the count-up and the spin are additive. Cheapest item in
   this list — do it only after (1).
4. **Web Push.** The receiver, the storage and the preference flag all exist; the
   client subscription and the sender do not. Honour
   `notification_preferences.push_enabled` — which means `NEDGE-2` must be fixed
   or the flag can never be set.
5. **The person-to-person nudge.** After `OS-1`. Rate-limited, and **recorded on
   the ticket** rather than only delivered — a poke that leaves no trace is the
   shoulder-tap the drafting-flow audit exists to replace, just moved inside the
   app.

⚠ **No new cron entry, ever.** `app/api/cron/maintenance/route.ts:286-291`
records that a third entry in `vercel.json` fails every deployment on this
hosting plan and once froze production for a day. Push sending, digests and nudge
scheduling extend the existing maintenance cron.

---

## Do not do these

| Tempting | Why not |
|---|---|
| Add a toast for a missing notification | The defect is almost always that an event has *only* an ephemeral channel. Another ephemeral channel is not a fix. |
| Delete the unmapped kinds instead of mapping them | Several are emitted and legally significant — `ack_overdue`, `legal_hold_placed`, `review_overdue`. Absence of a badge is the bug, not the kind. |
| Delete the dead kinds without checking | `task_reminder` has zero references anywhere. `task_nudge` / `morning_digest` / `task_overdue_digest` are scratchpad residue. But `markup_request` and `checkout_handoff` look dead and are **wanted** — their producers are missing, not their purpose. `PROD-8`, `PROD-14`. |
| Build the badge roll-up before mapping the kinds | You would roll up 22 of 48 kinds and conclude the trail works. |
| Ship the nudge before `NEDGE-2` | Attention-grabbing behaviour on a preferences page that cannot save. |
| Ship the poke before `OS-1` | Unconstrained inserts plus a poke button is a harassment vector. |
| Write a second container-chain walk | Two exist. `lib/docClass.ts:49-58` is the one to reuse. |
| Add a seventh kind taxonomy | `TAX-5`. Collapse first. |
| Raise the 50-row cap and call it fixed | Pagination is the fix; a bigger number is a bigger silent truncation. |

---

## Verification you cannot skip

**No live database, no browser, no running app.** Producer/consumer maps and the
kind diff are read from code and are exact — the 26-of-48 number was computed by
diffing the union against the switch's case labels, not by eye.

Everything about *what a user sees* is read from JSX and CSS classes and was
**not observed**. Per `DEC-29`, reproduce before fixing. Two specifically:

- **`NEDGE-2`** has been verified by hand and is the first thing this file asks
  you to do. Reproduce it anyway — `DEC-29` does not exempt confirmed findings —
  but the constraint and the write have both been read.
- **Every animation and layout claim in `06`** — the corner-stack overlap, the
  z-index conflicts, the mobile coverage — is inferred from positioning classes.
  These are cheap to confirm in a browser and should be.
