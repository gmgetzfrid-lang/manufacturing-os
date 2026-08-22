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
| **`PROD-1` / `TRAIL-2` / `DELIV-3` / `TAX-2` / `NEDGE-1`** | Map the 26 unmapped kinds in `sectionForKind`, and add a `const _never: never = kind` in the default arm so a new kind is a **build error** until mapped. This is the single highest-value change in the area: five lenses found it, and it is the mechanical root of the cold trail. |
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

---

## Phase 2 — Stop the drops

`RT-1` (events fired while the tab sleeps are lost from the live UI — a
reconcile-on-focus fixes it), `TAX-6` (the 50-row cap silently truncates a busy
week), `RT-3` (three-to-six concurrent copies of `useTicketNotifications` each
opening their own channel), `RT-2` (every checkout message in the workspace
toasted to every signed-in user).

Then the census holes in severity order: `PROD-2` (access requests notify
nobody), `PROD-14` (`markup_request` never notifies the person asked), `PROD-9`
(holds never notify the owner), `PROD-3`, `PROD-5`.

`PROD-6` and `PROD-11` — the silent subsystems — are **deliberately last** in
this phase. They are the largest and the least urgent: nobody is currently
relying on a notification that does not exist. Do not start here because the
list is long.

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
