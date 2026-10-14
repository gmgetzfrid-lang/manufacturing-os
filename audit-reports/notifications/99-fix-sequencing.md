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

*Hand-off (2026-10-07, notifications Round G, N6 EMAIL-PIPELINE-AND-CRON →
N9, N14 and the integrator):*
- *Email goes through one render layer, `lib/emailRender.ts` (`DEC-93`):
  a producer that composes an email body calls `renderNotificationEmail` or
  `wrapEmailBody` and marks the row `metadata.rendered`; a link is joined to
  the public origin or left out, never a bare path. A row left unrendered gets
  the footer and the mention rule from the drain at send time. The two emails
  `app/api/transmittal/route.ts` composes (N9's file) are covered by that
  backstop; N9 also changes that file's `new Date(now).toLocaleString()` to
  `lib/recordTime.ts` `formatRecordTime` (`NEDGE-12` done-when 1).*
- *`notify()` now answers whether its row landed (`Promise<boolean>`),
  `notifyMany` returns `{ sent, failed }`, and `emit()` returns
  `{ recipients, inapp? }` (warning on an empty audience). N14 RAW-INSERT TAIL
  owns `DELIV-7`'s remainder: the raw inserts in `app/api/transmittal/route.ts`
  (`ack_complete`), `lib/projects.ts` and `app/api/ai/usage/route.ts`; the
  maintenance cron's own stale-checkout escalation (`checkout_released`,
  `escalateStaleCheckouts` in `app/api/cron/maintenance/route.ts` — a raw insert
  whose failures N6 reports, still N14's to route through `notify()`, TAX-11's
  tail); and the regulatory callers that should surface the answer, among them
  the cron's step-6 compliance scans, which ignore it inside their own files
  (`notify()` in `lib/reviewCycles.ts`, `lib/acknowledgments.ts`,
  `lib/reviewControl.ts`, `lib/effectiveDate.ts`, `lib/retention.ts`,
  `lib/accessRecert.ts`, `lib/distributionAcks.ts`; `emit()` in
  `lib/distributionAcks.ts` and `lib/holds.ts`). The cron's own two `emit()`
  calls already read their result (N6 fix pass 2).*
- *The compliance digest keeps its state in `platform_settings` (key
  `compliance_digest`: the window still owed, per org where an org is owed
  more, a resume cursor per org whose visit did not finish, and the first org
  a run cut short did not visit; `20260920`, service role only). Nothing else
  writes that key; a package that edits `app/api/cron/maintenance/route.ts`
  later keeps the run clock (`runEnd`, `digestDeadlineAt`, `noTimeFor`, the
  per-org share in `queueComplianceDigests`, and the drain's bounded wait for
  a send batch): a new background step takes what the run has left, never a
  reservation ahead of the digest, and no digest read spans orgs
  (`DEC-93` §4, `NEDGE-17`). The integrator's fix pass adds the clock
  margin (`DIGEST_CLOCK_OVERLAP_MS`, five minutes: every window that starts
  where an earlier one stopped starts that much before it, and the digest's
  `metadata.tail` keeps what the last one counted there out of the next) and
  an entry for every org a run served while it left others unvisited.
  Optional follow-up, unassigned (it needs a migration): a partial index on
  `notifications (org_id, user_id, created_at) WHERE read_at IS NULL` would
  make each page of an org's recipient search an index walk (`NEDGE-17`'s
  residual).*
- *New, unassigned: `DELIV-16` (a compliance bell row has no retry or outbox)
  and `NEDGE-19` (an org-level timezone setting; `lib/recordTime.ts`
  `orgTimeZone` already reads `org_configurations` key `timezone`).*
- *Paste `20261183` (`email_notifications.queued_by`) any time; no code
  depends on it.*
- *Pointer for N9 (from the N6 review, `NEDGE-10`): the two service-role
  inserts in `app/api/transmittal/route.ts` — :418 (`transmittal_unstamped` /
  `transmittal_refused`, to the issuer) and :798 (the acknowledgment receipt,
  `watcher_activity`) — consult no preference, so the master switch the
  one-click unsubscribe sets does not stop them. Either gate them on the
  recipient's row (`emailAllowedByPrefs`, read as the service role) or record
  them as preference-exempt with `DEC-74` §9. Until then the drain leaves the
  unsubscribe header off the first two and off any mail to a member whose
  switch is already off, and `/api/notifications/unsubscribe` names them as
  still arriving. The integrator's fix pass (2026-10-07): the drain does not
  leave the header off the acknowledgment receipt while the issuer's switch is
  on — it is `watcher_activity`, a type the switch stops, and no column marks
  it — so the receipt carries a one-click link the switch does not honour
  (`NEDGE-10` done-when 1, ◐). Hand-off: the transmittal acknowledgment receipt
  (`app/api/transmittal/route.ts`, `watcher_activity`) must read the
  recipient's master switch before queueing (`DEC-90` A10: preference-gated);
  once it does, `NEDGE-10` done-when 1 holds for it.*

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

*Landed (2026-10-02, notifications Round G, N3 SURFACES, under `DEC-94`):*
- *N1 → N3: `components/providers/NotificationListener.tsx` reads `readToastPreference` before it toasts (mount, tab return, any read older than 5 s) and `TOAST_PREFERENCE_HONOURED` is `true` — the settings page offers "Pop-up toasts" (`RT-10`, Partial only on per-category toggles).*
- *N7 → N3: the listener passes `coalesceKey: notificationCoalesceKey(row)` — **kind + resource + the row's words** (`components/providers/NotificationListener.tsx:94`, since the N3 third review fix; a row about no resource keeps the content key). Superseded, kept for the sequence: the key was `` `${row.kind}:${row.resource_id}:${row.actor_user_id ?? ""}` `` — the actor — from the N3 second review fix to the third, and kind + resource alone before that; neither is the key at HEAD (the actor key merged one person's differently worded rows into the first row's words — the third review fix, below). The center, opened while the dock is raised, opens above the raising modal at `Z.dialog` and declares its panel a rail above the raise (`useOccupyRightRail(ref, open, true)`), and the `!raised` guard on the dock's doorway is gone (N7's test changed with it); NEDGE-5 dw2's dock and toast limb verified. The panel keeps `w-[480px]`, so `NOTIFICATION_CENTER_RAIL_PX` is unchanged. `RT-11` and `OS-4` were recorded RESOLVED; since the N3 fourth review fix both are OPEN (Partial) on done-when 2 (below).*
- *Hand-offs out of N3: `TAX-3` done-when 2 → notifications N9 (the "SYSTEM ALERT:" line, `lib/checkoutEpisodes.ts:760`, one wording with "Your checkout was force-released"); `RT-10` per-category toast toggles → the integrator to assign (a category column on `KIND_META` — `lib/notificationKinds.ts`, N5's this round — plus `toast_on_*` columns by migration and the settings rows); a click-through on the burst summary card ("N more notifications") → whoever next holds `components/providers/ToastProvider.tsx` (it has no action slot).*
- *Hand-offs out of N3, added at its review fix (2026-10-02):*
  - *→ notifications N9 DC-OWNED-PRODUCERS: on a lock handover, emit a targeted row to the heir — "the lock on <doc> is now yours" — beside the thread line `${userName} checked in — lock passed to ${heir}` (`lib/checkoutEpisodes.ts:647-652`, `finishMySession`). Removing the org-wide `checkout_messages` channel (`RT-2`) took away the only real-time signal for every system thread line; the others (a check-in, a quick hold, a checkout started, an auto-release) are FYI, but the heir now holds the document's lock without being told.*
  - *→ whoever next holds `components/providers/ToastProvider.tsx`: on a coalesce merge, show the newest row's words (or a neutral "2 posts on <doc>"), not the first's — today two people posting on one document within 10 s read as the first author "×2" (`DEC-94` item 4). The pin in `lib/__tests__/notificationListenerToasts.test.ts` ("KNOWN TRADE-OFF") changes with it.* *Superseded (N3 integrator fix pass, 2026-10-02): the "today" clause and the pin are not true at HEAD — the statement key (`notificationCoalesceKey`, kind + resource + words, since the third review fix) keeps two people's posts apart, and the "KNOWN TRADE-OFF" pin was removed at the third review fix. The hand-off itself was withdrawn at the third review fix and restored, in its current words, at the fourth: the bullet in force is the fourth-review one ("Restored — → whoever next holds `components/providers/ToastProvider.tsx`", below), not this line.*
  - *→ whoever next holds `lib/inAppNotifications.ts` (N4 / N6 / N8 / N12 edit it this round): `markRead`, `markManyRead` and `markAllRead` await the update without reading `{ error }`, so the bell's "Mark notifications read", the center's unscoped "Mark all read" and a row's "mark read" report nothing when the update is refused. The center's scoped "Mark these read" no longer uses them: `NotificationCenter.tsx` `markTheseRead` is a checked write. N5's planned `notifications` UPDATE rail keeps `read_at` writable by the recipient, so the client call stays valid.*
  - *→ the owner of `public/sw.js` (public-surfaces; N10 holds only its push block): the header comment at `:70` still says the page offers "Update available"; the prompt is now UpdatePill's one wording ("A newer version of the app is available — tap to load it", `TAX-15`).*
  - *→ notifications N5 (`NEDGE-6`): `lib/activityThread.ts` `notifyCheckoutActivity` addresses thread posts to watchers and participants with no ACL check (cross-note in `08-edges-and-invariants.md`); `TAX-4` done-when 3 is met for the toast surface only.*
- *Hand-offs out of N3, changed at its second review fix (2026-10-02):*
  - *`TAX-4` stays **OPEN (Partial)** on done-when 3 — **owner: notifications N5 (`NEDGE-6`)**: filter `notifyCheckoutActivity`'s recipients (participants, session holders, watchers) by document visibility before the row is written; the toast echoes the row and cannot filter it. Record `TAX-4` RESOLVED with that check (it was marked RESOLVED with this done-when "met for the toast surface only").*
  - *`TAX-9` stays **OPEN (Partial)** — **owner: the integrator** for (a) ratifying `DEC-74` §7 as done-when 1's reading and (b) accepting or rejecting the burst's two-cards-plus-one-summary shape for done-when 4 ("batched inserts produce one summary toast"); **owner: whoever next holds `components/providers/ToastProvider.tsx`** for (c) a click-through on the summary card to the center (the plan's "one 'N new notifications' toast that opens the Center"; it needs an action slot on a toast).*
  - *The `ToastProvider` "newest words on a merge" hand-off above narrows: the listener's key now includes the actor, so two people's acts are two cards and only one person's repeat merges (still showing the first row's words). The pin in `lib/__tests__/notificationListenerToasts.test.ts` ("KNOWN TRADE-OFF, narrowed") changes with it.* *Superseded at the N3 third review fix (below): the actor left the key — at HEAD it is kind + resource + words (`NotificationListener.tsx:94`), so two people's posts and one person's differently worded posts are all separate cards, and the "KNOWN TRADE-OFF, narrowed" pin is gone from the test file.*
  - *For the integrator: `RT-11` / `OS-4` done-when 2 name kind + resource; the key is now kind + resource + actor on the reviewer's reading ("identical" = the same event), recorded in `DEC-94` item 4.* *Superseded at the N3 third review fix (below): that reading is withdrawn and the actor left the key; at HEAD the key is kind + resource + words, `RT-11` / `OS-4` done-when 2 are OPEN (Partial), and the reading pending ratification is `DEC-94` item 4's current one (word-identical rows only) — the fourth review fix, below.*
- *Hand-offs out of N3, changed at its third review fix (2026-10-02):*
  - *Withdrawn (restored at the N3 fourth review fix, below): the `ToastProvider` "newest words on a merge" hand-off above. The listener's key is now kind + resource + the row's words (`notificationCoalesceKey`), so a merge only ever joins rows with the same words and no card shows words a later row contradicts; the per-actor key had merged one person's differently worded rows (a newer status, a second message) into the first row's words. The "KNOWN TRADE-OFF" pin is gone from `lib/__tests__/notificationListenerToasts.test.ts`. For the integrator: `RT-11` done-when 2 was then read as identical toasts about one kind and resource, and `OS-4` done-when 2 as a burst of repeats — `DEC-94` item 4; that reading does not meet the hand-off's purpose (differently worded rows about one event coalescing) and is pending ratification (fourth review fix, below).*
  - *`TAX-15` is **OPEN (Partial)** on done-when 2's fallback limb — **owner: the integrator to assign**. `UpdatePromptFallback` (`components/pwa/ServiceWorkerManager.tsx`) reloads over an upload with only the browser's generic prompt. Step: move the upload counters `hasUploadsInFlight()` reads, and the guard release, out of `lib/uploadActivity.ts` (N7 CORNER's STACK-13 file) into a leaf module with no Supabase import that `lib/uploadActivity.ts` re-exports; then the fallback asks with `confirmReloadDuringUploads`' words (`window.confirm`) before `loadLatestBuildInThisTab` and releases the guard on yes (one handler in N3's `ServiceWorkerManager.tsx`).*
  - *→ whoever next holds `lib/notificationPrefs.ts` (N1's): `readToastPreference` folds a read error that answers into `true`, so the toast listener — which now keeps a known "off" over a read that rejects or stalls (`RT-10`) — still reads a fast-failing read as "on". Return `null` (unknown) or throw on an error so the caller keeps the last value read; `lib/__tests__/notificationPrefs.test.ts` "RT-10 — readToastPreference fails open" changes with it.*
  - *The leave question over an upload is now asked inside the center's panel (not through `DialogHost`), so its Escape never reaches a raising modal's `window` listener (`MetadataStagingModal`'s aborts the upload). Nothing for other packages; noted because `MetadataStagingModal`'s Escape is still a bare `window` bubble listener that does not check whether it is topmost — a dialog opened over it by anything other than the center (for instance `appConfirm` from the wizard itself) leaks Escape to it the same way. That is the wizard's own file, outside N3's, and not changed here.*
- *Hand-offs out of N3, changed at its fourth review fix (2026-10-02):*
  - *Restored — **→ whoever next holds `components/providers/ToastProvider.tsx`** (the integrator assigns): on a coalesce merge, show the newest row's title and message, or a neutral "N updates on <resource>", not the first row's. Then the listener (`components/providers/NotificationListener.tsx`, N3's this round; its next holder) passes the key N7 assigned, `` coalesceKey: `${row.kind}:${row.resource_id}` ``, in place of `notificationCoalesceKey` (kind + resource + words), and differently worded rows about one event coalesce without hiding content — the purpose of the N7 → N3 hand-off ("so that differently worded rows about one event coalesce too"), which the statement key does not meet: it coalesces only rows N7's content key already merged. `RT-11` and `OS-4` are **OPEN (Partial)** on done-when 2 until that lands or the integrator ratifies `DEC-94` item 4's reading (word-identical rows only). The tests that pin two cards for differently worded rows (`lib/__tests__/notificationListenerToasts.test.ts` "one person's two thread posts are two cards…", "Approve then Release on DR-12…"; the key tests in `lib/__tests__/notificationListener.test.ts`) change with it.*
  - *The center's Escape: with focus in a dialog under the center (a drawer reached by Tab), Escape now closes the center, as on base; the center defers only to a dialog that paints above it (`dialogPaintsAbovePanel`). Nothing for other packages. The center still does not trap Tab although it declares `aria-modal`; a trap would also cut keyboard access to the raised dock's upload cards above it, so none is added.*
- *Hand-offs out of N3, at the integrator fix pass (2026-10-02): nothing new is handed off. The lines above that still described the actor key, the first-author "×2" merge and a removed test pin as current are marked superseded inline; the `ToastProvider` bullet in force is the fourth-review one. For N7's next holder: `components/ui/CornerDock.tsx` changed once more beyond the RT-11 seam — `aboveRaiseRailSnapshot` keeps the dock at `Z.dockRaised` while a rail above the raise is declared (the center open above a raise, the raise over or not), so the dock never sinks under that center's backdrop when the raise ends first; the allocation is untouched (`RT-11`, `DEC-94` item 7). The bell's live region counts "items", as the sidebar badge does (`RT-9` dw3).*

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

*Hand-off (2026-10-07, notifications Round G, N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT
→ N3, N4, N6, N14, projects-joint J16, drafting-flow, the integrator):*
- *Paste `20261191` after `20261148` / `20261160` / `20261161` / `20261181`
  and BEFORE the deploy that writes the new kinds: `doc_recalled`,
  `doc_upstream_changed`, `package_doc_stale`, `package_doc_retired`,
  `checkout_force_released`, `checkout_auto_released` and
  `transmittal_issued` are written from the browser, and a browser's row of
  a kind the live allow-list does not name is refused (only logged). It
  stops with a message when `20261160` or `email_gate()` is missing. Never
  re-paste `20261160` / `20261181` after it (their lists are shorter). A
  later re-create of `notification_kinds()` (N12, N14's `TAX-17`) starts
  from `20261191`'s body; a later re-create of `email_gate()` from
  `20261191`'s (four exempt event types).*
- *BINDING ORDER (N9 review fix, 2026-10-08) — merge N6 BEFORE N9, or
  apply N6's one line in its file at the N9 merge: N6's cron derives
  `COMPLIANCE_KINDS` from `KIND_META`
  (`(Object.keys(KIND_META) as Array<keyof typeof KIND_META>).filter((k) => KIND_META[k].compliance)`).
  On N9's branch the cron's hand-kept list (N6's file this round, so N9
  does not edit it) lacks the six split compliance kinds, and `20261191`'s
  re-files move the already-written recall / package / intake rows OUT of
  that hand list — so a daily compliance digest that fires between the
  paste and the N9 deploy omits the rows the paste re-filed: every recall,
  package, upstream and intake line written in its 25 h window. Enforced
  on N9's branch by `notificationKinds.test.ts`:
  an `it.fails` TRIPWIRE ("the cron's COMPLIANCE_KINDS equals KIND_META's
  compliance set") that starts failing the moment the derivation is in the
  cron file (proved by swapping N6's line in), and a gap pin naming the
  six. At the merge: flip the tripwire to `it`, delete the gap pin, and
  resolve N6's own compliance case ("compliance is the cron's
  COMPLIANCE_KINDS, unchanged", which pins the flagged set to TODAY's) to
  TODAY ∪ `N9_COMPLIANCE_ADDED`; N9's `cronComplianceKinds` helper reads
  both the literal and the derived form, N6's only the derived. Paste
  `20261191` IMMEDIATELY BEFORE the N9 deploy — the one whose `KIND_META`
  carries the nine kinds and whose cron derives `COMPLIANCE_KINDS` from it
  (N6 merged first). An N6-only deploy does not close the gap: its
  derivation reads a `KIND_META` without the six, so the derived list
  equals today's hand list. A digest that fires between the paste and that
  deploy omits the rows the paste re-filed (25 h window) — schedule the
  paste outside the digest hour (`DEC-100` Risk; the migration's
  header says the same; integrator fix pass, 2026-10-08).*
- *N3: the nine new kinds are in `BELL_ICON_GAPS` (the bell has no entry);
  `transmittal_unstampable` badges Documents now. `lib/notificationPrefs.ts`
  (yours): N9 changed one list, `PREFERENCE_EXEMPT_EVENT_TYPES`, to add
  `transmittal_unstamped` / `transmittal_refused` (DEC-90 A10) — keep it
  equal to `email_gate()`'s (a test pins the two).*
- *N4: `PROD-13` done-when 3 (the PSM obligations as actions) is yours,
  by DEC-90 A11; the split kinds carry their parents' flags.*
- *N14 (after N6): `TAX-17` (rename the cron's `checkout_released`
  escalation to `checkout_stale_escalation`, a migration re-filing it);
  `NEDGE-6` — wire `lib/documentDiscoverers.ts` (server) /
  `POST /api/documents/discoverers` (browser) into `lib/notify/dispatch.ts`
  to drop the non-discovering, non-controller followers of a
  document-scoped event; `NEDGE-21` (rename `lib/subscription.ts` /
  `lib/subscriptions.ts` apart); `PROD-17` (a follower's notice for a
  force-release and a retirement) — the integrator adds the four to N14's
  `findings`, or routes them.*
- *N12 NUDGES or N14 (the integrator names one) — `OS-13` (opened by the
  N9 review fix, 2026-10-08): the `OS-6` 24-hour cooldown is enforced only
  by the browser module (`lib/checkoutNudge.ts`); the database accepts a
  repeat `checkout_conflict` nudge from any client that calls `notifyMany`
  directly (a tab loaded before the N9 deploy, a script), bounded only by
  `20261160`'s generic per-recipient caps. Extend
  `enforce_notification_insert` — re-created from its NEWEST body
  (`20261160`, lineDiff-pinned) — with one rule: a browser-written
  `checkout_conflict` row carrying `metadata ? 'nudge'` is refused (22023,
  a legible message) when the same actor wrote one to the same `user_id`
  and `resource_id` within 24 h.*
- *projects-joint J16 (`app/api/intake/upload/route.ts`): N9 changed only
  the kind strings of `notifyTeam` (`intake_quote` / `intake_submission`)
  and its parameter type; `lib/intakeRateLimit.ts` `foldedDigestKind`
  answers `intake_submission` when nothing was published. Rebase keeps both.*
- *drafting-flow (`lib/ticketTransitions.ts`): `PROD-4` done-when 3 —
  `computeTransition`'s default `newUnreadBy` omits `assignedEngineerId`
  (the comment action already carries it).*
- *Integrator: rule on `DEC-100` item 2 (a personal notice does not go
  to followers — narrows `PROD-4` done-when 1; `PROD-17` carries the
  follower's notice), and renumber `DEC-100`. The restore now writes
  `subscriptions` (`NEDGE-8`), bounded to the target workspace's resources.*

*Hand-off (2026-10-13, notifications Round G, N4 FEED-PROVIDER-AND-REALTIME →
the integrator, drafting-flow, document-control, N13, `lib/tableViews.ts`'s holder):*
- *Paste `20261200` (milestones re-asserted in `supabase_realtime`; five
  `notification_preferences.toast_on_*` columns; NO replica identity change —
  the review fix pass dropped the first draft's `REPLICA IDENTITY FULL`
  statements, which would not make a filtered DELETE listener hear anything
  under Supabase's documented behaviour) any time, after `20261148`.
  The app works before it: the settings page saves without the per-category
  switches and says so; the listener reads the master switch alone. Nothing
  in the reconcile route needs a migration.*
- *The attention feed is ONE per tab (`components/providers/AttentionProvider.tsx`,
  mounted around `NotificationCenterProvider` in `app/(protected)/layout.tsx`).
  A new surface reads `useTicketNotifications` (unchanged shape) and
  `useAttentionStatus` (stale / error / "N of M" / load older) — it adds no
  channel and no query. `GAP-202`'s in-page markers build on it.*
- *Notification rows whose condition is gone are retired by
  `POST /api/notifications/reconcile` (service role, the caller's own rows,
  `metadata.superseded_at` only). A new obligation kind made action-required
  lands with a discharge check in `lib/notificationReconcileServer.ts`
  (`DEC-81` §2, `DEC-105`). A kind is not proof of its
  producer: the sign-off check applies only to a row a roster provably wrote,
  and the cron's review-health nudge is never reconciled. `PROD-18` (opened by
  the review) lists the nine kinds that ask for an action and stay FYI until
  each has its discharge check — assigned to notifications N12 NUDGES by the
  integrator, 2026-10-13 (N12 already edits `lib/notificationKinds.ts` and
  the provider; it takes the reconcile files with them).*
- *drafting-flow (`components/documents/CheckInPanel.tsx`): the "notify
  owner" outcome writes `review_requested` ("Change proposed to …"), the PSM
  sign-off kind, with no roster behind it. Since N4 it turns red as an action
  (and the reconcile pass keeps it — no roster evidence), so it stays until
  read. Give it its own kind (a DEC-31 remainder of `PROD-13`; still
  `review_requested` on `fleet/DF-P2-ticket-create` and `fleet/DF-P3-routing`).*
- *drafting-flow DF-P9 TICKET-PAGE (the requests portal — assigned by the
  integrator, 2026-10-13) and document-control (the library
  page): `RT-4` stays OPEN for two lines — `app/(protected)/requests/page.tsx`'s
  tickets channel and `app/(protected)/documents/[libraryId]/page.tsx`'s
  documents channel each need an unfiltered `DELETE` companion, acting only on
  a row the page holds (Supabase sends every tenant's DELETEs to an unfiltered
  listener — the attention feed's tickets companion is the pattern).
  `lib/__tests__/realtimePublication.test.ts` `RT4_PENDING` names both; drop
  an entry when its companion lands.*
- *notifications N11 TRAIL (`lib/tableViews.ts`'s holder — assigned by the
  integrator, 2026-10-13: N11 holds its one consumer, the library page):
  `RT-12` stays OPEN for `table_views` —
  not published, because a DELETE event would carry its composite id
  (workspace, person, library) to every subscriber (`DEC-105`
  §5). Replace the `postgres_changes` sync with a Broadcast message from the
  saver, or give the table an opaque key; the tripwire's `NOT_PUBLISHED`
  entry goes with it.*
- *notifications N11 TRAIL (assigned by the integrator, 2026-10-13 — it owns
  the badge below the sidebar): `RT-1` is OPEN (Partial) for its done-when 4
  on `components/notifications/NotificationBell.tsx` /
  `components/navigation/Sidebar.tsx` — the "reconnecting — counts may be
  out of date" state shows in the feed surfaces (center, `/inbox`, the
  dashboard widget) only; the bell and the rail read
  `useAttentionStatus().stale` and show it.*
- *Integrator, at every merge that touches `lib/notificationKinds.ts` (N10,
  N12, N14 add kinds this round): `KindMeta.category` is required since N4,
  so a kind added in the old shape fails `tsc` at the `satisfies` check —
  give it the category its `emit()` passes for the email (never a guess;
  `lib/__tests__/toastCategories.test.ts` pins one of the five per kind). An
  action kind also needs its discharge check (`DEC-81` §2) — or reads FYI per
  row through `lib/notificationReconcile.ts` `isActionRow`.*
- *`lib/reviewControl.ts`'s holder: the reconcile pass infers which
  `review_requested` / `review_invalidated` rows a sign-off roster wrote
  from the notice's title, its actor and the roster row's stamps
  (`rosterWrote`; integrator fix pass, 2026-10-13: an actor-less row counts
  only under the title of the one server writer that sends it with no actor,
  and an actor-bearing one only under `openReviewRoster`'s — so the check-in
  notice by the roster's own opener no longer reads as the roster's, and a
  legacy intake notice never does). The titles are pinned against this file
  (`lib/notificationReconcile.ts` `REVIEW_NOTICE_TITLES`;
  `lib/__tests__/notificationReconcile.test.ts` "the actor-less titles are
  the producer's"): retitling one of these notices fails that test — move
  the constant with it. A metadata marker on the roster notices would
  replace the title inference.*
- *drafting-flow DF-P3's hand-off, landed here (integrator fix pass,
  2026-10-13; re-owned from DF-P9 to N4, which rebuilt the hook): the feed's
  client reconcile keeps an SLA notice (`metadata.action` in
  `lib/ticketSla.ts` `SLA_NOTICE_ACTIONS`) while its request is open — not
  hidden, not sent — and the server's check keeps it too; only CLOSED /
  CANCELED (or the ticket's absence) retires it
  (`lib/notificationReconcile.ts` `workflowAlertGone`; drafting-flow
  `EDGE-7`).*
- *Still open from N3's hand-off (not N4's to change): `markRead`,
  `markManyRead` and `markAllRead` in `lib/inAppNotifications.ts` do not read
  `{ error }` — several callers `void` them, so making them throw needs those
  callers to catch first.*

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

- *Integrator, at the N3 SURFACES merge (2026-10-08): `DEC-94` item 4's reading ratified (`RT-11`, `OS-4` RESOLVED), `DEC-74` §7 and the 2 + 1 burst shape ratified for `TAX-9` (OPEN on the summary click-through only), `TAX-5` RESOLVED (every map derives from `KIND_META` — N2 + N3 + N6). The two `ToastProvider` hand-offs above — the newest-words merge and the summary card's click-through — are owned by **notifications N13 LAYERS SWEEP** (plan entry updated).*

*Hand-off (2026-10-13, notifications Round G, N14 RAW-INSERT TAIL → N9, drafting-flow DF-P2, the intake door's owner, the integrator):*

*Integrator at the N14 merge, 2026-10-13: N9 and DF-P2 merged before N14. Every item below named for **N9** — `DELIV-7` dw1's last two scans, the `DELIV-16` producers in N9's files and `emit()`'s in-app leg, the browser retry read-back — is re-owned by **notifications N15** (fleet plan and the records' Assigned lines); the intake door's two notices go to N15 too; DF-P2's `CheckInPanel` `review_requested` went to drafting-flow **DF-P4** at the DF-P2 merge. The cron's step-6 line and `complianceBellNotices` field are kept in the merged `app/api/cron/maintenance/route.ts` (:403, :133, :162).*
- *`TAX-11`, `NEDGE-13`, `PROD-16` and `NEDGE-20` are RESOLVED. No raw `.from("notifications").insert(` remains outside `lib/inAppNotifications.ts`, and `RAW_SITES` is empty. A new server writer uses `notifyWithReason` / `notifyBatchWithReason` with the client it holds.*
- *Merge notes. N14's hunks in the files parallel packages also edit are minimal:*
  - *`app/api/cron/maintenance/route.ts`: the escalation's insert moved onto `notifyBatchWithReason(…, sb)`. N9 changes the kind string there, and DF-P3 adds an SLA step. N14 also changed the digest's last-digest read (`NEDGE-20`) and, as **an integrator merge item**, ONE line in step 6's scan loop: `result.complianceNotices += await runComplianceScan(`${name}@${org.id}`, () => fn(org.id), result.errors, runEnd - DIGEST_FLOOR_MS - AFTER_DIGEST_RESERVE_MS, result.complianceBellNotices);` plus its import, and (integrator fix pass) the `complianceBellNotices` field on the run's result (type and initial value). A merge that drops it silently removes `DELIV-7` dw1's surfacing and the retry deadline; `lib/__tests__/complianceNotify.test.ts` (the cron source pin) and `lib/__tests__/maintenanceDrain.test.ts` "DELIV-7 dw1 / DELIV-16 (notifications N14)" fail loudly if it does.*
  - *`app/api/tickets/workflow-action/route.ts`: the two fan-out inserts only. DF-P3 owns the outcome / cancel / SLA limbs.*
  - *`lib/orchestrator/tools.ts`: the `notify_personnel` insert only, imported inside the hunk. I-21 edits `loadLineGraph`.*
- *`DELIV-16` / `DELIV-7` (OPEN, Partial). A compliance notice that does not land is retried and dead-lettered by `lib/complianceNotify.ts` `notifyCompliance` (`DEC-102`). A producer adopts it with ONE import line: `import { notifyCompliance as notify } from "@/lib/complianceNotify"`.*
  - ***N9:** `lib/distributionAcks.ts` (and its `emit()` calls), `lib/postPublish.ts`, `lib/staleCopies.ts`, `lib/revisionImpact.ts`, `lib/workPackages.ts`, and `emit()`'s in-app leg for compliance kinds (`lib/notify/dispatch.ts`, for `lib/holds.ts` and `lib/distributionAcks.ts`).*
  - ***N9 — `DELIV-7` dw1's last two scans (integrator ruling, 2026-10-13):** `scanDistributionAcks` (`lib/distributionAcks.ts`) and `scanStaleHolds` (`lib/holds.ts`) read the answer as the six scans in N14's files now do: adopt `notifyCompliance`, do not mark a reminder sent for a recipient whose notice dead-lettered (the next run retries it), and count delivered apart from attempted (`result.complianceBellNotices`). The helpers are `loadScanRetryPlan` / the `{ retryKey }` option in `lib/complianceNotify.ts`; `lib/__tests__/complianceScanCooldown.test.ts` is the pattern.*
  - ***N9 (proposed by N14; the integrator confirms):** a browser compliance notice to ANOTHER member is no longer retried — the browser cannot read that row back, and a retry after a lost answer wrote a second copy (re-review minor 3). It is dead-lettered at once. Closing it needs the browser writer to learn whether its own write landed (a SECURITY DEFINER read of rows whose actor is `auth.uid()`, or a server writer). `DELIV-16` residual.*
  - ***DF-P2:** `components/documents/CheckInPanel.tsx` (`review_requested`).*
  - ***The intake door's owner (projects):** `app/api/intake/upload/route.ts` (`review_requested`, `doc_superseded`).*
  - *The cron already reports a step-6 scan's shortfall, so `scanDistributionAcks` / `scanStaleHolds` are reported as soon as they adopt it.*
- *Paste `20261197` (`claim_access_request_burst`, `email_notif_insert` + one line) at any time, in either order with the deploy and with `20261183`. Expect `ok = true` × 4, then one `AFTER:` count (information, ok NULL — read it beside BEFORE row 1; live traffic moves it), then 4 inventory counts. It changes no row. (Integrator fix pass: probe 4 now checks the EXACT policy set on `email_notifications` — a `false` names a stray permissive policy that re-opens NEDGE-20's door, to remove; the old "no row was changed" boolean, which live traffic could flip, is the `AFTER:` row.)*
- *For the integrator, `lib/schemaExpectations.ts` probes to add (N14 does not edit that file):*
  - *the function `claim_access_request_burst` (migration `20261197_notif_roundG_burst_claim_digest_rail.sql`).*

*Hand-off (2026-10-13, notifications Round G, N15 RECIPIENT VISIBILITY AND NAMES → document-control P23, drafting-flow DF-P4, intelligence I-01, admin-and-org P5, the integrator):*
- *Paste `20261206` (`notification_kinds()` + `checkout_stale_escalation` + `doc_retired` + `checkout_force_released_fyi`; `notification_i_wrote`; the escalation backlog of closed sessions re-filed) AFTER `20261160` / `20261161` / `20261191` (the guard stops without `20261191`'s kinds), and BEFORE the N15 deploy (fix pass 3 — the brief's order; the deploy-first order of the earlier passes is withdrawn). It re-files only escalation rows whose session is no longer active, so the old cron (active sessions, dedupe on `checkout_released`) still finds every row it reads; the new cron reads both kinds. ~~Optional~~ REQUIRED (fix pass 4, the integrator's ruling): paste it again after the next maintenance run following the N15 deploy, to re-file the rows of sessions active at the first paste that have closed since (a session still active then keeps its legacy-named row until it closes and the file is pasted again — `TAX-17` fix pass 4). Expect `ok = true` × 7, then 5 inventory counts (to re-file / kept, session active / `checkout_released` without `staleSessionId` / already `checkout_stale_escalation` / member-to-member in the last hour). If it is pasted late instead, nothing breaks, but until it is the watchers' `doc_retired` / `checkout_force_released_fyi` bell rows are refused and (`emailOnlyWithBell`) no email goes. Never re-paste `20261160` / `20261181` / `20261191` after it. A later re-create of `notification_kinds()` starts from `20261206`'s body (67 kinds, 21 compliance).*
- *For the integrator to RATIFY at the N15 merge (departures from the brief, `DEC-106` items 4–6): ~~(a) deploy-before-paste for `20261206` (the brief, and `lib/notificationKinds.ts`'s header, say paste first);~~ *(withdrawn at fix pass 3: paste first)* (b) `20261206`, reserved for `notification_kinds()` plus one kind, also creates the SECURITY DEFINER `notification_i_wrote` (`DELIV-16`) and (fix passes) two more kind rows, `doc_retired` (`PROD-17`: the watcher's retirement FYI may not ride the compliance kind `doc_recalled`) and `checkout_force_released_fyi` (`PROD-17`: the watchers' force-release FYI may not ride the thread's chat kind `checkout_message`).*
- *For the integrator, the `lib/schemaExpectations.ts` probe to add (fix pass 3: N15 does not edit that file — the fix-pass-2 entry is reverted): `EXPECTED_FUNCTIONS` `{ signature: "notification_i_wrote(uuid, uuid, text, text, text, timestamptz)", fn: "notification_i_wrote", probeArgs: { p_org: "schema-health-probe", p_user: "schema-health-probe", p_kind: "doc_recalled", p_title: "x", p_resource_id: null, p_since: "2026-01-01T00:00:00Z" }, migration: "20261206_notif_roundG_stale_escalation_kind.sql", feature: "A compliance notice a member sent to another member is confirmed before it is retried, never written twice (lib/complianceNotify.ts; DELIV-16)" }` — the uuid argument refuses the probe value (22P02), so the body never runs; while it is missing (42883 / PGRST202) `lib/complianceNotify.ts` does not retry a browser notice to another member. `notifStaleEscalationMigration.test.ts` checks the entry's shape once it exists. No new table, so no export decision.*
- *Document-control P23 (`lib/revisions.ts` `changeDocumentStatus`) and the integrator (split / merge in `lib/documentLifecycle/`): a retirement through those doors calls no recall and tells no watcher. One call each: `lib/staleCopies.ts` `recallRetiredDocument({ … newStatus })`, which now carries `PROD-17`'s follower notice (`PROD-17` stays OPEN on it).*
- *Drafting-flow DF-P4: `components/documents/CheckInPanel.tsx`'s `review_requested` is `DELIV-16`'s last producer: one import line, `notifyCompliance as notify`.*
- *A server entry that emits a DOCUMENT-scoped follower notice must load `lib/documentDiscoverers.ts` (`import "@/lib/documentDiscoverers"`), which registers the dispatcher's server discover check. Without it the dispatcher keeps today's unfiltered path and logs it. The intake door does.*
- *New: `NEDGE-22` (LOW): library-scoped follower notices name a document with no discover check. The integrator routes it.*
- *Renamed (`NEDGE-21`): `lib/subscription.ts` → `lib/billing.ts`, `lib/subscriptions.ts` → `lib/watches.ts`. Admin-and-org P5 rebases `SubscriptionGate.tsx` / `serverAuth.ts` on `@/lib/billing`. ~~Intelligence I-01's `lib/dataRestore.ts` comments still cite the old names in prose (no importer).~~ Fixed at the N15 fix pass 4 (comment-only).*
- *`components/notifications/**` (N4): `checkout_stale_escalation` is in `KIND_META` with `checkout_released`'s flags and icon, and (fix pass) `doc_retired` with `doc_recalled`'s section, icon, tone and group but `compliance: false`, and (fix pass 2) `checkout_force_released_fyi` with `checkout_handoff`'s flags (Locks, Lock). `lib/notificationKinds.ts` changed by those three entries and their comments.*
- *`lib/notify/dispatch.ts` (fix pass 2): a failed discover check sends the unsettled followers `redactedNotice()` (generic title and body, no label, no reason, no metadata) instead of dropping them; `EmitInput.emailOnlyWithBell` emails only the recipients whose bell row landed. `resolveRecipients` answers both lists; `resolveAudience` splits them.*
- *Document-control P23: `recallRetiredDocument` now reads the checkout holder and the open packages' owners itself to leave them out of the watchers' FYI (`personallyToldElsewhere`, both on by default — right for the supersede door). A Void / Archive door that does not send `notifyHolderOfRetirement` / `notifyPackagesOfRetirement` passes `personallyToldElsewhere: { checkoutHolder: false, packageOwners: false }`.*

*Hand-off (2026-10-14, notifications Round G, N10 PUSH → the integrator, drafting-flow, document-control, identity-and-session, N12):*
- *~~No migration. Deploy only.~~ (Fix pass: one migration.) **Paste `20261211_notif_roundG_push_subscriptions_writer.sql`**, in either order with the deploy. It drops `20260804`'s `push_sub_insert_own`, so the service-role route `/api/push/subscribe` is the table's only writer. The app never inserts a device row as a signed-in member, so it works the same before and after the paste. Expect `ok = true` × 4, then 5 counts: rows; rows naming no push service; people over 10 registrations; rows from before the opt-in control; `push_sub_insert_own` present 1 / gone 0. A re-run shows the last count as 0. Without `20260804` the paste stops at the inventory, before BEGIN, and nothing is changed. Exercised on PostgreSQL 16.*
- *The channel is OFF until `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are set (`npx web-push generate-vapid-keys`; `.env.example`). Without them every deployment behaves as before; a browser's push-worthy notice costs one 204 request. `push_subscriptions` is `20260804`'s table. Before it is applied, the subscribe route answers 503 and names the migration, the sender skips (logged once) and the cron's step 7c is silent.*
- *Fix pass 3 (the third review's major): `20261160` (row 123, Pending) is not a precondition of `20261211` or of the VAPID keys. But until it is pasted, the sender's own checks are the only defence against a browser's forged bell row: a row dated later than now plus five minutes earns nothing, and only an active member of the workspace is pushed (fail closed). ~~One margin stays until `20261160` is pasted: a forged row dated up to five minutes ahead can hold that person's next pushes back for at most five minutes.~~ *(Corrected at fix pass 4: that bound did not hold — re-forging every few minutes held pushes back for as long as it went on.)* Since fix pass 4, until `20261160` is pasted: a forged row dated up to five minutes ahead can be pushed to a device at most twice, and holds back no push for a row dated after it was pushed (a device's watermark is never later than the server's clock); only where the database's clock runs ahead of the app server's is a real row dated no later than the forged one held back, for at most five minutes. Pasting `20261160` before setting the VAPID keys closes the forged-date cases; preferred, not required (`DEC-44 (N10-push)` §2 and Risk, `OS-2` fix passes 3 and 4).*
- *For the integrator: no new table (no `exportCoverage` decision), no new function, and no `lib/schemaExpectations.ts` probe beyond its existing `push_subscriptions` entry (`:161`, now truthful — `OS-11`). `20261211` adds no paste-order entry beyond its own row: it depends only on `20260804`. `lib/notificationKinds.ts` changed by six `pushWorthy: true` fields only; no kind was added, so `notification_kinds()` is not re-created. The `DEC-44 (N10-push)` number is provisional. **Ratify** the three departures listed under `DEC-44 (N10-push)`, "For the integrator to ratify": the route-served public key (`RT-7` done-when 1, recorded as a deviation — `RT-7` stays OPEN with a Partial block until then; record it RESOLVED at merge on ratification), the cron's prune criterion, and `20261211`'s use. *(Fix pass 4: (a) is RATIFIED — `DEC-90`, 2026-10-14; `RT-7` is recorded RESOLVED with done-when 1 met as narrowed by the integrator. (b) and (c) remain to ratify, and (fix pass 4) (d): the watermark for a row dated ahead is `created_at − PUSH_FUTURE_SKEW_MS`, not the review's `min(created_at, now)`, which re-pushed on every replay of such a row.)*
- *Every `emit()` now defaults to channels in-app, email and push. Push sends only for a `KIND_META.pushWorthy` kind, beside the in-app leg, after the bell and email legs, for the recipients told in full. A producer that passes `channels` without `"push"` (e.g. `["inapp"]`) never pushes. A new push-worthy kind needs three things, and tests pin each:*
  - *one field in `KIND_META`;*
  - *a title in `lib/push/sendPush.ts` `PUSH_TITLES` (a test pins a title for every push-worthy kind);*
  - *a line in `components/settings/PushOptIn.tsx`: in `PUSH_SENT_TODAY`, worded for its producer, once a producer reaches the push leg; until then in `PUSH_NOT_SENT_YET` and `PUSH_NOT_YET_NOTE`. A test checks the two lists against the push-worthy set and the `emit()` producers.*
- *(Fix pass.) A SERVER `emit()` pushes only when its caller passes `serverPush: pushFromServer` (`lib/push/sendPush`). There is no module-level sender: loading `lib/push/sendPush` changes nothing, so whether a server emit pushes never depends on what else the process ran. The maintenance cron passes none, by ruling (the cron only prunes), so `scanStaleHolds`' `hold_opened` nudge never pushes. No server caller passes one yet. A server writer that bypasses `emit()` calls `sendPushSafe({ orgId, kind, resourceId, recipients })` after its bell rows land.*
- *(Fix pass.) A push goes only to a browser push service's host. The list is `lib/push/endpoints.ts` (FCM, Mozilla autopush, WNS, Apple), checked at subscribe and before every send; any other row is deleted unsent. A person keeps at most 10 registrations.*
- *(Fix pass 2.) The host check now reads an endpoint the way both URL parsers do: the WHATWG parser, and the legacy `url.parse` that `web-push` connects by. The first fix pass checked only the WHATWG reading, and a host such as `10.0.3.7;.push.apple.com` slipped through. Every send goes through `pushServiceAgent()`, which reaches only push-service hosts, only on port 443, and only at public addresses. One person's rows never cost a neighbour their push. The cron removes future-dated rows and trims each person to 10. `lib/push/endpoints.ts` is server-only; `PUSH_KEYS_MISMATCH` lives in `lib/notify/dispatch.ts`. `RT-7` stays OPEN with a Partial block until the integrator ratifies its done-when 1 deviation. *(Fix pass 4: ratified, `DEC-90`; `RT-7` RESOLVED.)*
- *(Fix pass 4.) A device's push watermark is never later than the server's clock (`pushWatermarkFor`): a row dated at or before now is claimed exactly as before; a row dated ahead stores its date less five minutes. The cron's step 7c has its own 20 s (`PUSH_PRUNE_MS`), never past the run's end, so the knowledge sync and the steps after it keep their time; no `vercel.json` change. `review_requested`'s lock-screen title is "You're asked to review a document". `20261211` is unchanged, and so are its paste facts above; no new table, function or `lib/schemaExpectations.ts` probe.*
- *→ drafting-flow and document-control, `OS-14` (new, MEDIUM; the integrator routes it): `ticket_mention` / `ticket_assigned` (the two ticket routes' fan-out) and the rosters' `ack_requested` / `review_requested` (`lib/acknowledgments.ts`, `lib/reviewControl.ts`) are written outside `emit()` and are not pushed.*
- *→ identity-and-session, `OS-15` (new, LOW; the integrator routes it): an explicit sign-out should unsubscribe this browser's push endpoint for the person signing out (`/api/push/unsubscribe`, best-effort, before `SIGN_OUT`).*
- *→ notifications N12 (the login nudge): if it invites device notifications, it reads `PUSH_DECLINE_KEY` through `hooks/useDismissed` (scope `<uid>:<orgId>`) and stays quiet for a member who declined.*
