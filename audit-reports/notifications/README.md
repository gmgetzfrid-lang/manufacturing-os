# Notifications & alerts — audit area

Read-only audit of every way this app tells a person something: the bell, the
sidebar badges, toasts, the corner dock, progress indicators, email, and the
service worker. Producers, delivery, taxonomy, the badge trail, realtime,
stacking, and what a real OS notification would attach to.

**No application code, test, or migration was modified at any point.**

---

## ⚠ Before you touch anything

1. **Read [`../README.md`](../README.md)** — the resolution protocol — and
   [`../DECISIONS.md`](../DECISIONS.md).
2. **Read [`99-fix-sequencing.md`](./99-fix-sequencing.md).** One fix here is
   worth more than the other hundred and has to go first.
3. **The four things the owner asked for are specs, not findings** —
   [`90-gap-register.md`](./90-gap-register.md) holds `GAP-201`…`GAP-207`,
   including the badge roll-up, the login nudge, Web Push and the
   person-to-person poke. Read **the signal ladder** at the top of it before
   adding any signal anywhere.
4. **This area overlaps `drafting-flow` deliberately.** That area owns the
   ticket-shaped notification defects (`LEAK-1`, `ROUTE-*`, `EVID-13`); this one
   owns the notification *system*. Where a defect belongs to both it is recorded
   in full once and cross-referenced — never duplicated.

---

## Findings

**105 findings** — 2 CRITICAL, 15 HIGH, 72 MEDIUM, 16 LOW — plus **7 gap specs**, all buildable.

> **One finding here carries `Status: REFUTED`** — `NEDGE-1`. An independent pass disproved it; the reason is on the finding. Kept rather than deleted (`DEC-41`). **Do not queue it as work.**

| # | Report | Findings | Focus |
|---|---|---|---|
| 01 | [Producer census](./01-producer-census.md) | 14 | Which subsystems notify, which are silent, which vocabulary is dead |
| 02 | [Delivery integrity](./02-delivery-integrity.md) | 14 | What gets dropped between an event and a person, and whether anything notices |
| 03 | [Taxonomy](./03-taxonomy.md) | 14 | Alerts vs notifications — every signalling surface, and where they contradict |
| 04 | [**The cold trail**](./04-cold-trail.md) | 13 | Badge propagation. The central complaint |
| 05 | [Realtime & lifecycle](./05-realtime-and-lifecycle.md) | 12 | Channels, teardown, multi-tab drift, events fired while nobody is looking |
| 06 | [Stacking & progress](./06-stacking-and-progress.md) | 13 | The bottom-right corner: how many things live there and whether failures are seen |
| 07 | [OS notifications & nudges](./07-os-notifications-and-nudges.md) | 12 | Web Push, login nudges, person-to-person pokes |
| 08 | [Edges & invariants](./08-edges-and-invariants.md) | 13 | Egress, lifecycle edges, accessibility, and what is sound. **Verified by hand** — record at the top of the file |
| 90 | [**Gap register**](./90-gap-register.md) | 7 specs | What has to be built. `GAP-201`+ so they never collide with the other areas |
| 99 | [**Execution order**](./99-fix-sequencing.md) | — | Binding. Read before claiming a file |

**`01`–`07` were adversarially verified** — a second agent read the cited code
and tried to refute each finding. Refuted findings were dropped. Several
severities were **lowered** by that pass and the lowered value is what is
recorded.

**`08` has since been verified by hand.** Every `CRITICAL` and `HIGH` was re-read
against the source; the per-finding record is at the top of that file. `NEDGE-2`
— the one the sequencing leads with — was confirmed verbatim, including the
negative search that matters: the token `'immediate'` appears in **no** SQL file
in the repository. One finding was corrected (`NEDGE-3`, half refuted). Its
`MEDIUM`s remain unverified and are marked as such.

Each report opens with a **reusable substrate table** — what already exists and
works. That is deliberately as prominent as the defects, because most of what
you want here is half-built rather than absent.

---

## Direct answers

### "The trail goes cold — I open Documents and there's nothing to follow"

**Worse than that. The trail has exactly one link, and for most alerts it never
starts.**

Three separate mechanical facts, each independently confirmed:

**1. The badge counts *kinds*, not *places*.** `sectionForKind()`
(`hooks/useTicketNotifications.ts:71-103`) maps a notification kind to one of
five sections. That is the entire resolution of "where does this belong". A hold
on a document in Library A and one in Library B are indistinguishable — so the
Documents badge has no place information in it to narrow with. The trail cannot
continue because nothing downstream was ever computed.

**2. Twenty-six of forty-eight kinds badge nothing at all.** Diffing the
`NotificationKind` union against that switch's `case` labels: 48 kinds, 22
mapped, **26 fall to `default: 'other'`** — and `Sidebar.tsx` badges only three
sections (documents, projects, requests). `scratchpad` and `other` are tallied
and thrown away.

What is in the 26: the **entire review-control family** (`review_requested`,
`review_signed`, `review_invalidated`, `review_complete`, `review_overdue`,
`review_alternate_activated`), the **entire acknowledgment family** (`ack_*`),
`legal_hold_placed`, `legal_hold_released`, `retention_eligible`,
`effective_now`, `access_recert_due`, `review_due`, `owner_assigned`,
`owner_behind`, `deletion_requested`, `library_doc_added`, `library_doc_revised`,
`security_export`.

Disproportionately the compliance-critical ones. They reach the bell and nothing
else. `PROD-1`, `TRAIL-2`, `DELIV-3`, `TAX-2`, `NEDGE-1` — five lenses found it.

**3. No page below the sidebar reads notification state.** `TRAIL-1`: not
`/documents`, not a library, not a folder, not `/projects`. There is exactly one
link in the chain — the sidebar row — and then nothing.

> ### ⚠ A correction to something I said earlier
>
> I described the badge as "a doorway, not a scoreboard — clicking it opens the
> Notification Center pre-filtered to exactly what it counts", quoting the
> Sidebar's own comment at `components/navigation/Sidebar.tsx:533-543`.
>
> **The comment says that. The code does not do it.** `AttnFilter` is
> `"all" | "action" | "unread"` (`components/notifications/NotificationCenter.tsx:36,81-84`)
> — there is **no section filter**. Clicking the "3" on Documents opens a panel
> filtered by *tone* across the whole workspace, not scoped to Documents. So the
> one link that exists is itself lossy. `TAX-1`, `TRAIL-3`.

**What you already have to build the fix on:** notification rows carry
`resource_type` / `resource_id`, so per-item targeting works today. What is
missing is the container chain — a document notification does not know its folder
or library, so "Library A: 3" needs a join that does not exist.
`resolveEffectiveDocClass` (`lib/docClass.ts:49-58`) already walks
document → folder → library; that is the same walk a roll-up needs.

### "Are alerts and notifications the same thing?"

**No, and the app currently behaves as if the question had never been asked.**
[`03-taxonomy.md`](./03-taxonomy.md) enumerates every surface. The finding that
matters most is `TAX-5`: **six independent hand-maintained taxonomies classify
the same `notifications.kind` string**, and they do not agree. A kind can be
compliance-critical in one and unclassified in another.

The distinction worth keeping is not *alert vs notification*, it is
**durable vs ephemeral**:

- A **durable** signal is a row that survives you not looking — the bell feed,
  email, an acknowledgment. It is evidence.
- An **ephemeral** signal is a toast or an indicator. It exists to confirm
  something you just did.

The defects cluster exactly where an event uses only the ephemeral channel, so a
user who was not looking never learns of it — and where one event fires several
signals under different names (`TAX-3`: a force-released checkout emits **five**
signals under two names; `TAX-4`: one thread post fires two toasts with two
different wordings).

### "Are there leaks, dropped alerts?"

Yes. The census is [`01`](./01-producer-census.md); the delivery path is
[`02`](./02-delivery-integrity.md). The ones to know:

- **Access requests notify nobody.** A locked-out person asks for access and the
  row lands in a table with no producer (`PROD-2`).
- **Cost control, change orders, checklists, turnover, punch, equipment registry
  and companies are completely silent** — no notification of any kind (`PROD-6`).
- **The entire milestones/schedule subsystem is silent** — 20+ mutators, zero
  notifications (`PROD-11`).
- **`markup_request` is fully-wired dead vocabulary**: the kind exists, has an
  icon, has a section mapping — and `createMarkupRequest` never notifies the
  person being asked (`PROD-14`).
- **Holds never notify the document owner**, contradicting the union's own
  comment (`PROD-9`).
- **The admin "No failed deliveries" panel is structurally incapable of ever
  reporting a failure** (`DELIV-4`). That is worse than no panel: it is a green
  light wired to nothing.
- **The bell and the Center are hard-capped at 50 unread rows** (`TAX-6`), so a
  busy week silently truncates.
- **Every realtime event that fires while the tab is asleep or disconnected is
  permanently lost** from the live UI (`RT-1`). The rows survive; the awareness
  does not.

Two are security-shaped rather than reliability-shaped, and both come from the
same root — the `notifications` and `email_notifications` tables accept
client-side inserts:

- **Any active org member can insert an arbitrary outbound email** with free-text
  recipient and subject, sent from your domain (`DELIV-1`).
- **Any active org member can insert unlimited notification rows for any other
  member**, with arbitrary title, body and link (`OS-1`).

### "I want real OS notifications, not just a bell"

**You already built the hard half.** `OS-2` calls it a decapitated stack, which
is exactly right:

| Piece | State |
|---|---|
| Service worker with a `push` handler → `showNotification` | **built** — `public/sw.js:226-239` |
| `notificationclick` → focus existing window or open one | **built** — `public/sw.js:241-256` |
| PWA manifest + SW registration | **built** — `app/manifest.ts`, `components/pwa/ServiceWorkerManager.tsx` |
| `push_subscriptions` table with own-row RLS | **built** — `20260804_push_subscriptions.sql` |
| `notification_preferences.push_enabled` | **built** — and unread by anything |
| Client `pushManager.subscribe()` | **absent** |
| VAPID keys / a `web-push` dependency | **absent** |
| Any code reading or writing `push_subscriptions` | **absent** |

The table's own comment says *"The reminder cron (service role) reads every
row."* It does not. Nothing creates a subscription and nothing sends. **The
receiver and the storage exist; the middle does not.**

⚠ Whatever schedules it **must extend the existing maintenance cron**.
`app/api/cron/maintenance/route.ts:286-291` records that a third entry in
`vercel.json` fails every deployment on this plan and once froze production for a
day.

### "Nudge people who haven't checked — a banner, or a spinning bell"

Both are cheap and both are safe, **but fix `NEDGE-2` first.**

`NEDGE-2` (CRITICAL): **the notification preferences page can never save** for
any user who has not already saved. The UI writes
`digest_frequency: 'immediate'`; the CHECK constraint permits only `'instant'`.
Every insert is rejected.

That is the escape hatch for every nudge you are about to add. Ship attention-
grabbing behaviour on top of a preferences page that cannot save, and the first
person it annoys has no way to turn it off — which is precisely the outcome you
said you wanted to avoid.

The rest is genuinely small. `Sidebar.tsx:510` already applies `animate-pulse` to
a red badge, so the pulse exists. What does not exist is a per-user
"last opened the bell" timestamp to decide whether a nudge is warranted — see
[`07`](./07-os-notifications-and-nudges.md) for the exact attachment points.

⚠ `NEDGE-5`: **every notification surface is invisible to assistive technology**
— no `aria-live`, no accessible name on the bell count. A spinning bell and a
pulsing badge make that worse unless it is fixed alongside, and
`prefers-reduced-motion` has to be honoured.

### "Background messages should stack gracefully bottom-right"

[`06-stacking-and-progress.md`](./06-stacking-and-progress.md) — 13 findings, all
MEDIUM, which is the right severity: nothing here is dangerous, all of it is
irritating. `components/ui/CornerDock.tsx` exists and is the right idea; the
report is about what does not go through it and what happens when a job fails.

### "Nudge the engineer who owes me an approval"

Buildable and small. The substrate is real: `@`-mentions already exist
(`components/requests/MentionableTextarea.tsx`), the ticket comment API already
fans out, and `ticket_mention` is a live kind with a producer.

Two things to get right, both in [`07`](./07-os-notifications-and-nudges.md):
**rate limiting** (nothing stops ten pokes a minute today) and making the nudge
**recorded on the ticket**, not just delivered — a poke that leaves no trace is
the shoulder-tap you are trying to replace, just inside the app.

---

## Method & limits

- The `NotificationKind` union was diffed against `sectionForKind`'s `case`
  labels **programmatically**, not by eye. That is where the 26/48 number comes
  from and it is exact.
- Absence claims (`pushManager.subscribe`, VAPID, `web-push`, producers for dead
  kinds) are multi-shape repo-wide searches, stated as searches so they can be
  re-run.
- **No live database, no browser, no running app.** Every UI and animation claim
  is read from JSX and CSS classes, never observed. Where a finding depends on
  runtime behaviour it is marked `SUSPECTED`.
- One correction made during the audit and recorded above: the sidebar badge's
  "doorway" behaviour is documented in a comment and not implemented in the code.
