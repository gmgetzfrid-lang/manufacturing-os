# 90 · Gap register — build specs

**7 capabilities the notification system needs and does not have.**

Numbered from **201** so they never collide with `roles-and-permissions`
(`GAP-1`…`GAP-15`) or `drafting-flow` (`GAP-101`…`GAP-114`).

> Build work. Each carries a verdict, scope, design direction, dependencies,
> acceptance criteria and a `Do not` list naming the specific wrong turn an
> implementing agent would otherwise take. Held to the evidence bar in
> [`../README.md`](../README.md) and `DEC-29`. Build order is in
> [`99-fix-sequencing.md`](./99-fix-sequencing.md).

---

## Verdicts at a glance

| Gap | Capability | Verdict | Effort | Blocked on |
|---|---|---|---|---|
| [GAP-201](#gap-201) | Exhaustive kind → section mapping, enforced at build time | **BUILD_NARROW** | S | — |
| [GAP-202](#gap-202) | The badge trail — per-container roll-up | **BUILD** | L | `GAP-201` |
| [GAP-203](#gap-203) | Preferences that can actually be saved | **BUILD_NARROW** | S | — |
| [GAP-204](#gap-204) | The login nudge | **BUILD** | M | `GAP-203`, `NEDGE-5` |
| [GAP-205](#gap-205) | Web Push — connect the two built ends | **BUILD** | M | `GAP-203` |
| [GAP-206](#gap-206) | The person-to-person nudge | **BUILD** | M | `OS-1`, `GAP-201` |
| [GAP-207](#gap-207) | One kind taxonomy | **BUILD_NARROW** | M | `GAP-201` |

---

## The signal ladder

Every notification decision reduces to one question: **which channel does this
event deserve?** Getting it wrong in either direction is a defect, and this area
has both kinds.

| Channel | Survives you not looking? | Costs the user | Use when |
|---|---|---|---|
| **Toast** | no | a glance | Confirming something *they just did* |
| **Corner dock item** | no (per session) | a glance, dismissible | A job they started is running or finished |
| **Bell row** | **yes** | nothing until they look | Something happened that they may want to know |
| **Sidebar badge** | **yes** | nothing until they look | Something in *that section* needs them |
| **Container/item marker** | **yes** | nothing | The trail down to the actual thing (`GAP-202`) |
| **Email** | **yes**, leaves the app | an interruption | They may not open the app today |
| **OS push** | **yes**, leaves the app | a real interruption | It cannot wait for them to open the app |
| **Blocking modal** | n/a | stops them | Almost never |

**Two rules that follow, and most of this area's defects break one of them:**

1. **A durable obligation must never live only in an ephemeral channel.** A
   compliance event that appears only as a toast is not delivered. This is what
   `TAX-3` and `TAX-4` are: real events fired into channels that evaporate.
2. **An ephemeral confirmation must never become a durable row.** A "saved!" that
   writes to the bell is work someone has to clear later.

**Corollary for every spec below:** the fix for a missing notification is almost
never a new toast, and the fix for a noisy one is almost never a louder channel.

### What is already built

Six things, and they are why five of these seven specs are `S` or `M`:

| Thing | Where | What it gives you |
|---|---|---|
| Service worker with a live `push` handler and click routing | `public/sw.js:226-256` | The entire receiving half of Web Push |
| `push_subscriptions` table, own-row RLS | `20260804_push_subscriptions.sql` | Where a subscription goes |
| `notification_preferences` + a settings page + server-side honouring | `settings/notifications/page.tsx`, read at 3 server call sites | The opt-out spine |
| Generic `subscriptions` table, one row per (user, resource), `resource_type` already includes `'library'` | `20260622_subscriptions.sql:13-24` | Standing visibility with no new table |
| Container-chain resolution, document → folder → library | `lib/docClass.ts:49-58` | The walk a roll-up needs |
| A working rate-limit pattern (count rows in a window, **fail open**) | `app/api/auth/signup/route.ts:19-33` | The shape `GAP-206` copies |

---

<a id="gap-201"></a>
## GAP-201 · Exhaustive kind → section mapping, enforced at build time

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: — · Findings: `PROD-1`, `TRAIL-2`, `DELIV-3`, `TAX-2`, `NEDGE-1`

### Why this is first

**Five lenses found this independently**, and it is the mechanical root of the
cold trail. 48 kinds in the union, 22 mapped by `sectionForKind`, **26 fall to
`default: 'other'`** — and `Sidebar.tsx` badges only `documents`, `projects` and
`requests`. `scratchpad` and `other` are tallied by `emptySectionCounts()` and
read by nothing.

The unmapped set is disproportionately the compliance vocabulary: the whole
`review_*` family, the whole `ack_*` family, `legal_hold_placed`,
`legal_hold_released`, `retention_eligible`, `effective_now`,
`access_recert_due`, `review_due`, `owner_*`, `deletion_requested`,
`library_doc_*`, `security_export`.

**Nothing else in this area works until this is fixed.** Build the roll-up first
and you will roll up 22 of 48 kinds and conclude the trail works.

### Scope

**In:** every union member maps to a section a sidebar entry actually renders;
a compile-time exhaustiveness guard; and `emptySectionCounts()` stops allocating
buckets nobody reads (or the sidebar starts reading them — pick one and be
consistent).

**Out:** the roll-up itself. That is `GAP-202`.

### Design

The guard is the point, not the mapping:

```ts
default: {
  const _exhaustive: never = kind;   // a new kind is a BUILD ERROR until mapped
  return 'other';
}
```

Without it this regresses on the next feature — which is demonstrably how it got
here, since several of the 26 are from features shipped after `sectionForKind`
was written.

For each of the 26, decide deliberately: does it badge `documents`, does it
badge a section that does not exist yet, or is it genuinely bell-only? **Write
the answer down per kind.** "It went to `other`" is not a decision anyone made.

Note the `storage_*` kinds, which bypass the union entirely — one of them via a
template literal (`PROD-10`). The guard cannot see those; fold them into the
union in the same change or they stay invisible to it forever.

### Do not

- **Do not delete the unmapped kinds to make the switch exhaustive.** Several are
  emitted and legally significant. Absence of a badge is the bug, not the kind.
- **Do not map everything to `documents` to be done with it.** A badge that
  counts things the user cannot act on is `TRAIL-5` and `UI-3` in the other area —
  it teaches people to ignore the badge, which is worse than no badge.
- **Do not fix this without the `never` guard.** The mapping is a day's work; the
  guard is what makes it permanent.

### Acceptance

1. `sectionForKind` handles every `NotificationKind` member; adding a kind
   without mapping it fails `npx tsc --noEmit`.
2. Every section `emptySectionCounts()` allocates is rendered by some surface, or
   is no longer allocated.
3. A test enumerates the union and asserts no member resolves to an unrendered
   section.
4. The per-kind decisions are recorded in a comment or table, not implied.

---

<a id="gap-202"></a>
## GAP-202 · The badge trail — per-container roll-up

**Verdict: BUILD** · Effort: **L** · Depends on: `GAP-201` · Findings: `TRAIL-1`, `TRAIL-3`, `TRAIL-4`, `TAX-1`

### The requirement it implements

> *"The user is avoiding looking at his alerts and sees the documents library has
> an alert bubble. Once you open documents the trail ends — the notification
> bubble doesn't continue down the chain until you find it. What ends up
> happening is you open it and you have no idea what you're looking for because
> the trail goes cold."*

### The chain has exactly one link

`TRAIL-1`: **no page below the sidebar consumes notification state at all** —
not `/documents`, not a library, not a folder, not `/projects`. The sidebar row
is the entire trail.

And the one link is itself lossy. `Sidebar.tsx:533-543` describes the badge as
*"a DOORWAY, not a scoreboard: clicking it opens the Notification Center showing
exactly the items it counts"*. **The comment says that; the code does not do
it.** `AttnFilter` is `"all" | "action" | "unread"`
(`NotificationCenter.tsx:36,81-84`) — there is no section member, so the "3" on
Documents opens a workspace-wide tone filter (`TAX-1`, `TRAIL-3`).

### Scope

**In, in this order — each is independently useful, so ship them one at a time:**

| Step | What | Effort |
|---|---|---|
| 1 | Add a section member to `AttnFilter` so the badge honours its own comment | `S` |
| 2 | Mark read on arrival — visiting the document clears its notification, as `/requests` already does (`TRAIL-4`) | `S` |
| 3 | Container roll-up: a count on a library row, a folder row, a document row | `M` |
| 4 | `actionRequired` for notification-sourced items (`tally(section, false)` hardcodes it to zero today, so a red badge can never come from a notification — `TRAIL-5`) | `S` |

**Out:** a new notifications-per-container table. See `Do not`.

### Design

Notification rows already carry `resource_type` and `resource_id` — that is used
today by `notifByTicket` (`hooks/useTicketNotifications.ts:241-244`) and by the
link fallback. So **per-item targeting already works.** The missing piece is the
chain from an item up to its containers.

`lib/docClass.ts:49-58` already walks document → folder → library, and
`review_control` mirrors it. **Reuse that walk.** Resolve each document-scoped
notification to its `(library_id, collection_id)` once, and roll up.

Two properties worth copying from `docClass` beyond its shape:

- **Fail visibly, not quietly.** `docClass` throws on a transient error rather
  than returning null, because *"we couldn't check" must never silently read as
  "nothing here"*. A roll-up that silently returns zero on a failed query is a
  badge that says "all clear" when it does not know.
- **Never guess.** No inferring a container from a title or a path string.

**The permission trap.** A badge must never count something the viewer cannot
see. Rolling up server-side under the service role and returning counts to a
client whose ACL forbids the underlying documents leaks the *existence* of
restricted work — and produces a badge that opens onto nothing, which is `UI-3`
in the drafting-flow area: the app pointing people at work that does not exist
for them. Roll up **through the same ACL the document list uses**.

### Do not

- **Do not create a notifications-per-container table.** It is a derived count.
  A second store drifts and then two surfaces disagree about the same number.
- **Do not write a third container-chain walk.** Two exist (`docClass`,
  `review_control`). A third will diverge from both.
- **Do not build this before `GAP-201`.** You would roll up 22 of 48 kinds.
- **Do not roll up with the service role and hand the number to the client.**
  Permission mismatch turns a cold trail into a false one.
- **Do not put a number on every row in a long list.** A folder tree with a count
  on all forty rows is not a trail, it is wallpaper. Mark the path to the thing;
  leave the rest quiet.

### Acceptance

1. Clicking the "3" on Documents shows those exact three items.
2. A notification about a document rolls up to its folder and its library, and
   both markers clear when the underlying items are read.
3. Visiting a document marks its notifications read without a separate action.
4. A viewer without ACL read on a document never sees a count that includes it —
   verified in a test, both directions.
5. A notification can produce an action-required (red) badge, not only a blue one.
6. A failed roll-up query renders as unknown, never as zero.

---

<a id="gap-203"></a>
## GAP-203 · Preferences that can actually be saved

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: — · Findings: `NEDGE-2`, `EDGE-1`, `NEDGE-9`, `EDGE-14`

### Why a one-word bug gets its own spec

`NEDGE-2`: the page writes `digest_frequency: 'immediate'`; the CHECK constraint
permits only `('instant','hourly','daily','never')`. **Verified by hand** — the
token `'immediate'` appears in no SQL file in the repository. Every save from a
user without an existing row is rejected, and because `save()` spreads the whole
prefs object, it rides along on every save regardless of which toggle was
touched.

It gets a spec rather than a line because **it is the escape hatch for
`GAP-204`, `GAP-205` and `GAP-206`.** Every one of those makes the app more
insistent. Ship any of them on a preferences page that cannot save and the first
person they annoy has no recourse — which is precisely the outcome to avoid.

### Scope

**In:** one vocabulary for cadence across UI and DB; the three surrounding
defects that make preferences ineffective even when a row exists.

The three:

- **`EDGE-1`** — `queueEmail` runs client-side, and `notif_prefs_own` is
  `USING (user_id = auth.uid())`. Reading *another* user's preferences returns
  nothing, `prefs` is `null`, and `shouldSendForEvent(null, …)` returns `true`.
  **Every opt-out is bypassed on every client-initiated email.** Fixing the CHECK
  constraint without this means preferences save and still do nothing.
- **`NEDGE-9`** — the compliance digest ignores `digest_frequency = 'never'` and
  the per-category toggles.
- **`EDGE-14`** — `inapp_enabled` and `push_enabled` were added for *"the unified
  dispatcher to honour"* and **no code reads either**. `GAP-205` depends on
  `push_enabled` meaning something.

### Do not

- **Do not fix the constraint and stop.** Preferences that save and are then
  ignored is a worse bug than preferences that fail loudly.
- **Do not migrate the constraint to accept both tokens.** Two spellings of one
  value is how this happened. Pick one and map legacy rows at load.
- **Do not move email queueing to the server as part of this.** That is the
  `DELIV-1` / `OS-1` work in Phase 1 of the sequencing, and it is the real fix for
  `EDGE-1`. Here, make the preference read authoritative wherever it runs.

### Acceptance

1. A user with no row saves the DEFAULTS object successfully. A test round-trips
   it.
2. A user who sets `email_enabled = false` receives no email from **any** path,
   client-initiated included.
3. `digest_frequency = 'never'` suppresses the digest.
4. `inapp_enabled` and `push_enabled` are read by something, or are removed.
5. A check-violation surfaces distinctly rather than dumping `err.message`, so
   the next vocabulary drift is diagnosable.

---

<a id="gap-204"></a>
## GAP-204 · The login nudge

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-203`, `NEDGE-5` · Findings: `NEDGE-5`

### The requirement it implements

> *"Nudges — like the user logs in and they haven't checked their notifications,
> so a modal or small notification banner at bottom right like other alerts do,
> that's easy to click away in case it causes frustration. Or maybe the
> notification bell does a spin and the notification bubble pulses while it
> counts the total, like 1, 2, 3 — that could draw attention and be subtle and
> not annoying. Or do both."*

### Both are right, and they are different tools

- **The banner** is for *"you have unread things"* — a state that persists.
- **The spin and count-up** is for *"something arrived just now"* — an event.

Firing the animation for a backlog is the annoying version: it draws the eye
every navigation for something the user already declined to act on. Firing the
banner for a single new arrival is the useless version.

### What exists and what does not

`Sidebar.tsx:510` already applies `animate-pulse` to a red badge. `CornerDock`
exists and is the right host for the banner. **What does not exist is any
per-user "last opened the bell" timestamp** — searched three shapes
(`last_seen`, `last_opened`, `notifications_seen_at`); the `last_seen_at` columns
in the repo belong to checkouts and projects, not notifications.

So the state to decide *whether* to nudge has to be added. One column on
`notification_preferences` (which already has own-row RLS) is enough; no new
table.

### Design

Three constraints, all of them about not becoming hated:

1. **Frequency-capped, not event-driven.** At most once per session, and not
   again within N hours of a dismissal. The dismissal must be **remembered
   server-side** — a `localStorage` dismissal that resets on another device is
   how a nudge becomes a nag.
2. **Dismissible without acting.** Closing it counts as "seen" for the cap and
   **not** as "read" for the notifications. Conflating those means the user must
   choose between clearing the nudge and keeping their unread list.
3. **Never when there is nothing to do.** Zero unread, zero nudge. And per
   `GAP-201`, "unread" must count kinds that actually matter — nudging about 26
   kinds that badge nothing is the current state made louder.

**Accessibility is a prerequisite, not a follow-up.** `NEDGE-5`: there is no
`aria-live` region and no accessible name on the bell count — confirmed, zero
matches for `aria-live|aria-label|role=` in `NotificationBell.tsx` and
`ToastProvider.tsx`. A spinning bell and a pulsing badge are invisible to a
screen reader and actively hostile to anyone with `prefers-reduced-motion` set.
Both go in this change.

### Do not

- **Do not use a blocking modal.** The owner said "easy to click away". A modal
  that must be dismissed before working is the opposite, and it will be the first
  thing anyone complains about.
- **Do not animate on every render.** Tie the animation to a count *increase*,
  not to a non-zero count.
- **Do not store the dismissal only in `localStorage`.**
- **Do not ship before `GAP-203`.** No working opt-out, no nudge.
- **Do not skip `prefers-reduced-motion`.** For some people the pulse is not
  subtle, it is a symptom trigger.

### Acceptance

1. A user with unread notifications sees the nudge once per session, dismissible
   in one click, and the dismissal survives a reload and another device.
2. Dismissing does not mark anything read.
3. Zero unread produces no nudge.
4. `prefers-reduced-motion: reduce` disables the spin and the pulse; the count
   still updates.
5. The bell has an accessible name including the count, and new arrivals are
   announced via a polite live region.
6. The animation fires on an increase, not on a non-zero value.

---

<a id="gap-205"></a>
## GAP-205 · Web Push — connect the two built ends

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-203` · Findings: `OS-2`

### The requirement it implements

> *"The notification bell is OK but I'm looking to give this app more
> notification attention. Like real OS notification official stuff, not just a
> bell."*

### This is a decapitated stack, not a greenfield build

| Piece | State |
|---|---|
| Service worker `push` handler → `showNotification` | **built** — `public/sw.js:226-239` |
| `notificationclick` → focus existing window or open one | **built** — `public/sw.js:241-256` |
| PWA manifest + SW registration | **built** — `app/manifest.ts`, `components/pwa/ServiceWorkerManager.tsx` |
| `push_subscriptions` table, own-row RLS, service-role read | **built** — `20260804_push_subscriptions.sql` |
| `notification_preferences.push_enabled` | **built**, read by nothing (`EDGE-14`) |
| Client `pushManager.subscribe()` | **absent** |
| VAPID keys / a push library | **absent** |
| Anything reading or writing `push_subscriptions` | **absent** |

The table's own comment says *"The reminder cron (service role) reads every
row."* It does not. **Nothing creates a subscription and nothing sends.**

### Scope

**In:** the client subscribe flow, VAPID configuration, the sender, and honouring
`push_enabled`.

**Out:** a new notification kind. Push is a *channel* for kinds that already
exist. Adding `push_*` kinds would be a seventh taxonomy (`TAX-5`).

**Out:** pushing everything. Decide per kind which ones are worth interrupting
someone for — and default that set to **small**. Push is the loudest channel on
the ladder; the ones that earn it are the ones that cannot wait for the user to
open the app.

### Design

**The permission prompt is the whole UX risk.** A browser permission prompt on
first load is refused by most people, and a refusal is close to permanent — the
browser remembers it and the app cannot re-ask. So: prompt **only** after a
deliberate opt-in gesture in settings, with the value stated before the browser
dialog appears.

The sender extends the existing maintenance cron. ⚠ **No new `vercel.json`
entry** — `app/api/cron/maintenance/route.ts:286-291` records that a third entry
fails every deployment on this hosting plan and once froze production for a day.

Subscriptions expire and endpoints go stale (410 Gone). Prune on that response;
`last_reminded_at` already exists on the table for exactly this kind of
bookkeeping.

### Do not

- **Do not prompt for permission on load.** One refusal and that device is done.
- **Do not add a cron entry.** See above.
- **Do not send without checking `push_enabled`** — which means `GAP-203` first,
  or the flag can never be set to false.
- **Do not put document titles, hold reasons or requester names in the push
  body** by default. `NEDGE-6` is the same problem one channel down, and an OS
  notification renders on a lock screen in a control room where anyone can read
  it. Title it by kind; put the detail behind the click.
- **Do not treat a delivered push as a delivery record.** Push is best-effort by
  design. `GAP-113` in the drafting-flow area is explicit that a consent window
  needs a record push cannot provide.

### Acceptance

1. A user opts in from settings; the browser prompt appears only after that
   gesture; a row lands in `push_subscriptions`.
2. Setting `push_enabled = false` stops delivery without unsubscribing the device.
3. A 410 from the push service prunes the row.
4. Clicking a push focuses an existing tab and navigates it, rather than opening
   a duplicate — the SW already does this; a test pins it.
5. No new entry in `vercel.json`.
6. The push body carries no restricted content.

---

<a id="gap-206"></a>
## GAP-206 · The person-to-person nudge

**Verdict: BUILD** · Effort: **M** · Depends on: `OS-1`, `GAP-201` · Findings: `OS-1`

### The requirement it implements

> *"What if I'm in a drafting request that needs an engineer's approval and I
> want to send them a nudge?"*

### Build it as a recorded event, not a message

The instinct behind this is the same one the drafting-flow audit exists to serve:
a person is waiting on someone and has no lever except walking over. Giving them
a button is right.

**But a poke that leaves no trace is the shoulder-tap, just moved inside the
app.** The value of putting it in the system is that the system can then answer
*"how often is this ticket being chased, and by whom?"* — which is the number
that tells you whether the flow has a queueing problem or a person problem. So
the nudge writes to the ticket's history, not only to the recipient's bell.

### Substrate

`@`-mentions already exist (`components/requests/MentionableTextarea.tsx`),
`ticket_mention` is a live kind with a real producer, and the ticket comment API
already fans out. The rate-limit shape to copy is
`app/api/auth/signup/route.ts:19-33` — count rows in a window, **fail open** on
a query error. There is no reusable helper; this is the second caller, so
extracting one is reasonable scope.

### Scope

**In:** a nudge action on a ticket that is waiting on a named party; a durable
record on the ticket; a rate limit; and suppression when the ticket is not
actually waiting on anyone.

**Out:** free-text. A nudge is *"this is waiting on you"* — the ticket already
carries the context, and a text box invites the tone the owner's own phrasing
suggests. If someone needs to say something, that is a comment, which exists.

**Out:** nudging a role pool. Nudging "the engineers" is spam; nudging the person
the ticket is assigned to is a signal.

### The abuse surface

Nothing in the codebase currently stops ten pokes a minute, and `OS-1` means any
member can already insert unlimited notification rows for anyone with arbitrary
content. **`OS-1` is a prerequisite**: a nudge button on top of an unconstrained
insert path is a harassment vector with a UI.

Three limits, all cheap:

1. **Per (ticket, sender, recipient) window** — one nudge per N hours.
2. **Only when the ticket is genuinely waiting on that person** — derived from
   the state machine, not from who the sender picks. If `getActions` offers the
   recipient nothing, the nudge is unavailable and says why.
3. **Visible count on the ticket.** "Nudged twice" is self-limiting in a way a
   silent counter is not.

### Do not

- **Do not ship before `OS-1`.**
- **Do not let the sender choose the recipient freely.** Derive it from the
  ticket state. A free recipient picker is a workspace-wide poke button.
- **Do not make it free-text.**
- **Do not send it only to the bell.** Record it on the ticket — that is the
  point.
- **Do not escalate the channel on repeat.** A second nudge going to email and a
  third to push is an escalation ladder with no human judgement in it.

### Acceptance

1. The nudge is offered only when the ticket is waiting on a specific person, and
   only to people involved in that ticket.
2. A second nudge within the window is refused with a legible reason.
3. Every nudge appears in ticket history, attributed and timestamped.
4. The recipient's notification names the ticket and what is being asked, and
   deep-links to the action.
5. A report can count nudges per ticket and per period.
6. Rate-limit query failure fails **open** — never block a legitimate nudge on a
   transient error, matching the signup limiter's stated behaviour.

---

<a id="gap-207"></a>
## GAP-207 · One kind taxonomy

**Verdict: BUILD_NARROW** · Effort: **M** · Depends on: `GAP-201` · Findings: `TAX-5`, `PROD-13`, `PROD-10`

### The problem

`TAX-5`: **six independent hand-maintained classifications of the same
`notifications.kind` string**, and they do not agree. A kind can be
compliance-critical in one and unclassified in another. `PROD-10` adds kinds that
bypass the union entirely, one via a template literal — so they are invisible to
every classification at once.

Every spec above adds a seventh unless this lands: `GAP-201` adds a section
decision, `GAP-205` adds a push-worthiness decision, `GAP-204` adds a
nudge-worthiness decision.

### Scope

**In:** one table — literally one `Record<NotificationKind, KindMeta>` — carrying
every per-kind property the app needs: section, icon, whether it is
action-required, whether it is compliance-relevant, whether it is push-worthy,
which email template it uses. Every existing map derives from it.

**Out:** changing any kind's behaviour. This is a pure consolidation with no
user-visible change, which is exactly why it goes **after** the visible fixes and
**before** the new features.

**Out:** collapsing overloaded kinds. `PROD-13` — `doc_superseded` covering eight
semantically distinct events — is real, but splitting a kind changes behaviour and
belongs in its own change with its own migration for existing rows.

### Do not

- **Do not do this first.** It is invisible to users, and this area has visible
  problems.
- **Do not do it after `GAP-204`/`GAP-205`.** Each adds a per-kind property, and
  consolidating three maps is cheaper than consolidating eight.
- **Do not fold the `storage_*` kinds in without first getting them into the
  union** (`PROD-10`). A template-literal kind cannot be a key.
- **Do not split overloaded kinds here.**

### Acceptance

1. One exported table is the sole source of per-kind metadata; every previous map
   is derived from it or deleted.
2. Adding a kind without full metadata fails the type check.
3. No behaviour changes — a test asserts each derived map produces what its
   hand-maintained predecessor did.
4. Kinds that bypass the union are either in it or explicitly documented as
   out of scope with a reason.

---

## Already built — do not build these twice

| Looks missing | Actually |
|---|---|
| **A push receiver and click router** | **Built** — `public/sw.js:226-256`. `GAP-205` is the sender and the subscribe flow, not the service worker. |
| **Somewhere to store push subscriptions** | **Built** — `push_subscriptions` with correct own-row RLS. |
| **Per-user notification preferences** | **Built** — table, settings page, and three server call sites that honour it. `GAP-203` is about it being unsavable, not absent. |
| **A watch/follow store** | **Built** — `subscriptions`, one row per (user, resource), `'library'` already a valid `resource_type`. |
| **Container-chain resolution** | **Built twice** — `docClass` and `review_control`. `GAP-202` reuses it. |
| **A rate-limit pattern** | **Built** — `signup/route.ts:19-33`, including the fail-open behaviour. `GAP-206` is its second caller. |
| **A pulsing badge** | **Built** — `animate-pulse` on the red badge, `Sidebar.tsx:510`. `GAP-204` adds the count-up and the reduced-motion guard. |
| **A corner stack for dismissible items** | **Built** — `components/ui/CornerDock.tsx`. `GAP-204`'s banner belongs in it. |
