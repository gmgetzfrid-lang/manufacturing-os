# Checkout & Document Control — System Review

> Deep review of the checkout/episode system, the revision flow, and the
> alerting layer, conducted 2026-07-23. Covers: how well the "signal, don't
> lock" design works today, every failure mode found (with file:line
> references), and a ranked recommendation list. No code was changed.

## Verdict in one paragraph

The core design decision — advisory checkouts that signal instead of lock,
with join-not-block semantics — is the right one for a refinery, and the
lock/episode layer underneath it is genuinely well engineered (race-safe
episode creation, CAS lock claims, self-healing reconcile). But the system
fails at both ends of that good core: **the signal never reaches the
surfaces where work actually happens** (viewer, download, revision publish),
and **the revision flow has a real, reproducible lost-update bug** — the
exact "drafter B pushes under drafter A's nose" scenario. Meanwhile the
alerting layer that should make the advisory model safe is mostly plumbing
with nothing flowing through it.

---

## Part 1 — What works (keep this)

| Strength | Where |
|---|---|
| One-active-episode-per-document enforced by the DB, not the client; concurrent first-checkouts race safely (loser joins) | `20260729_checkout_episodes.sql:51`, `lib/checkoutEpisodes.ts:252-260` |
| Atomic conditional lock claim (`.or(checked_out_by.is.null, eq.me)`) — no read-then-write double-lock race | `CheckoutFlowModal.tsx:316-329` |
| Lock transfer on check-in so a doc never reads "free" while collaborators remain | `lib/checkoutEpisodes.ts:508-544` |
| Pure, unit-tested state machine for check-in transitions | `computeCheckInTransition`, `lib/__tests__/checkoutEpisodes.test.ts` |
| Self-healing `reconcileDocumentCheckoutState` rebuilds doc columns from session rows | `lib/checkoutEpisodes.ts:635-720` |
| Forced purpose (6 ISO categories) + ≥5-char reason at checkout | `CheckoutFlowModal.tsx:217-228` |
| Episode-scoped chat thread with join/leave system messages — sealed history per checkout | `20260729_checkout_episodes.sql` |
| Cross-checkout coordination signals (same asset / same system overlap detection) | `lib/consolidation.ts`, `/checkouts` page |
| Publish guard blocks rev-up while *someone else* holds the lock, mirrored app-side and DB-side | `lib/documentGuards.ts:99-132`, `20260713_document_publish_guard.sql` |

The "checkout as a ticket with a thread" model is better than AutoCAD
Vault's hard lock for this environment. The problem is not the model —
it's that the model is only half wired in.

---

## Part 2 — Failure modes found

### F1. The lost update is real (CRITICAL — data integrity)

Traced scenario: drafter A and drafter B both start from rev 3.
B publishes rev 4. Then A publishes.

1. **No base revision is recorded anywhere.** Not at download
   (`download_audits` stores what was fetched but nothing reads it), not at
   checkout (`checkout_sessions`/`checkout_episodes` have no
   `base_version_id` column), not in the RevUp form.
2. **The guard doesn't check staleness.** `assertCanPublishRevision`
   re-fetches lock + holds only (`lib/documentGuards.ts:148-165`). A's base
   being outdated is invisible to it. If nobody holds the lock, A's publish
   sails through.
3. **The promotion is last-writer-wins.** `revUpDocument` is three separate
   non-transactional client calls (insert version → stamp `superseded_at` →
   promote `documents.current_version_id`, `lib/revisions.ts:126-181`). The
   final update is a plain `.eq("id", doc.id)` with no optimistic predicate.
4. **Result:** A's row claims `supersedes_version_id = rev3` (same as B's),
   B's rev 4 is silently orphaned off the current chain, and because A's
   client auto-suggested the next label from stale `doc.rev`, **both
   versions can literally be labeled "4"** — there is no unique constraint
   on `(record_id, revision_label)` (`schema.sql:319-357`).
5. **Nobody is told.** `lib/revisions.ts` contains zero notify calls. B's
   work shows in the history panel as a generic "Superseded" row,
   indistinguishable from an intentional supersession.

The CAS/unique-index discipline that protects episodes was never applied to
`document_versions` or the promotion step. The DB publish-guard trigger
checks lock + hold only — it does not catch this either.

### F2. The signal doesn't reach the work surfaces (HIGH)

The checkout badge lives in the document list (`CheckoutStatusCell`) and
the checkout modal. But:

- **`FullScreenViewer` and `SecureDocViewer` show no lock indicator at
  all.** No holder name, no banner. A second user can open, mark up, and
  export a drawing someone else is actively editing with zero cue. The only
  badge is Controlled/Uncontrolled, which reflects the *current user's*
  holder status, not that anyone else has it out
  (`FullScreenViewer.tsx:1123-1127`).
- **No download-time interruption.** `lib/downloads.ts:28-33` silently
  hands a non-holder an "uncontrolled" stamped copy. The moment someone
  pulls a file to their desk is exactly the moment to say "Jim has this out
  for drafting" — and nothing does.
- **Publish buttons aren't gated visually.** "Publish New Revision" is
  enabled regardless of a foreign lock; the guard only throws *after* the
  user fills the entire RevUpModal (`InspectorPanel.tsx:353-367`,
  `RevUpModal.tsx:125-128`).

### F3. Working outside the system is undetectable (HIGH — your second concern)

- **A checkout is not required to publish a revision.** `revUpDocument`
  only blocks *foreign* locks. A user who never checks out can rev-up
  freely — the entire checkout system is skippable end-to-end.
- The `20260728_checkout_compliance.sql` migration, despite the name, is a
  data backfill only. **No detection of off-system work exists** — no flag
  for "revision published with no session," no use of download history to
  infer someone is working offline.
- `download_audits` faithfully records who pulled which version when —
  and has **zero readers**. The raw material for off-system-work detection
  is already being collected and thrown away.

### F4. The alert layer is plumbing without water (HIGH)

- A full multi-channel dispatcher (`lib/notify/dispatch.ts:emit` → in-app +
  email queue + push) exists and is **never called by any producer**. The
  cron drains an email queue nothing enqueues into.
- **Force-release sends the victim nothing durable.** An admin can kill your
  checkout with one click (no confirm dialog, `CheckoutStatusCell.tsx:239`)
  and you learn about it only if you happen to be online for the ephemeral
  toast — system thread messages are excluded from durable notifications
  (`lib/activityThread.ts:97`).
- **24h ad-hoc auto-release: same silence.** Your checkout evaporates and
  no notification is written.
- **`doc_superseded` is defined, iconed, and never emitted** — grep finds
  no producer. Rev-ups and supersedes notify no one: not the holder, not
  watchers, not prior downloaders.
- All feed items from notifications are hardcoded `actionRequired: false`
  (`hooks/useTicketNotifications.ts:278`) — even a checkout conflict renders
  as passive activity, never the orange action treatment.
- Stale checkouts nudge **only the holder** (the person least motivated to
  act), only in-app, with no escalation to the doc controller or the people
  blocked behind the lock.

### F5. Drafting tickets and checkouts are two disconnected worlds (MEDIUM-HIGH)

`lib/workflow.ts` (the NEW → DRAFTING → … → CLOSED ticket machine) has
**zero references to checkouts**. A drafter can work an entire ticket —
the primary drafting workflow — without ever appearing in the checkout
system. Your CAD-folder collision scenario lives exactly in this gap: the
work happens through tickets, the collision protection lives in checkouts,
and they never meet.

### F6. Smaller defects

| Issue | Where |
|---|---|
| Check-in "Submit Changes" creates a ticket with text only — viewer markups are not attached; drawn redlines silently lost unless separately exported | `CheckoutFlowModal.tsx:504-521` |
| Active-session list hardcodes "Checked out just now" for every session | `CheckoutFlowModal.tsx:620-622` |
| Admin force-release has no confirmation dialog | `CheckoutStatusCell.tsx:239-246` |
| `CheckoutPanel.tsx` is dead code that permits purpose-less checkouts with a mode the real flow doesn't offer — a trap if ever re-wired | `components/documents/CheckoutPanel.tsx` |
| Maintenance cron header says "hourly," actual schedule is daily 03:00 UTC | `app/api/cron/maintenance/route.ts:1-4` vs `vercel.json:7-10` |
| Stale-checkout banner shows only the current user's own rows — a colleague can't see or clear an absent user's expired lock | `lib/projects.ts:642-651` |
| Non-fatal `superseded_at` stamp failure leaves two "live" versions | `lib/revisions.ts:160-168` |

---

## Part 3 — Recommendations, ranked

### Tier 1 — Close the lost update (do this first; it's data integrity)

1. **Record the base version everywhere work starts.** Add
   `base_version_id` to `checkout_sessions` (stamp `current_version_id` at
   checkout time) and carry it through downloads and the RevUp form.
2. **Make the promotion compare-and-swap.** Move insert + supersede +
   promote into a single Postgres RPC in one transaction, with the promote
   as `UPDATE documents SET current_version_id = :new WHERE id = :doc AND
   current_version_id = :expected_base`. Zero rows updated ⇒ stale base ⇒
   the publish is rejected *before* it corrupts the chain.
3. **Turn rejection into forced communication, not a wall.** The conflict
   screen should say: *"Rev 4 was published by B on Tuesday while you were
   working ('rerouted exchanger inlet'). Your upload is based on rev 3."*
   — then offer: view the diff (the `PdfRevisionDiff` component already
   exists — reuse it here), message B in the episode thread, or (DocCtrl
   only) publish anyway as a deliberate branch with a reason. That is the
   red-flag-and-talk model you described, applied at the exact moment it
   matters.
4. **Unique index on `(record_id, revision_label)`** (excluding
   superseded/reverted rows as needed) so duplicate "Rev 4" labels are
   impossible even if everything else fails.

### Tier 2 — Put the signal where the work happens

5. **Lock banner in both viewers**: holder name, purpose, how long, one
   click into the episode chat.
6. **Download interstitial when someone else has it out**: "Jim checked
   this out Monday for drafting — 'Unit 3 exchanger reroute'. [Join
   checkout] [Download anyway] [Message Jim]." Record the acknowledgment in
   `download_audits`. This converts every silent parallel-work start into a
   logged, eyes-open decision.
7. **Stamp uncontrolled copies harder**: rev label + date + "verify current
   revision before use" + active-checkout warning baked into the watermark,
   so a stale print on a desk announces itself.
8. **Gate publish buttons visually** when a foreign lock exists (disabled
   state + holder name), instead of letting users fill a whole form to hit
   a guard error.

### Tier 3 — Detect off-system work (you can't prevent it; make it visible)

You're right that nothing can stop someone editing a file on their own
machine. The realistic goal is: **every re-entry point detects it, and the
system's paved path is cheaper than going around it.**

9. **"Unheralded revision" red flag.** On rev-up, check whether the actor
   has (or recently had) a session on that document. If not: allow the
   publish, but flag the version row, post a system alert to the thread,
   and notify DocCtrl. Surface a per-user / per-library compliance rate on
   the control tower. Nothing blocks — but going around the system now
   leaves a visible mark every time, which is what changes behavior.
10. **Use `download_audits` — it's write-only today.** Two inferences it
    already supports: (a) *collision risk* — two users downloaded the same
    revision in overlapping windows and neither has a checkout → nudge
    both before either uploads; (b) *silent work* — user downloaded a doc
    N days ago, no checkout/ticket/revision since → gentle "still working
    on X-101? Check it out so others can see."
11. **Hash-based re-entry detection.** `file_hash` already exists per
    version. On upload, flag byte-identical re-uploads, and (via PDF
    metadata dates) uploads whose source predates the current revision —
    both are signatures of offline round-trips.
12. **Make checkout one click.** The 6-purpose + reason + project form is
    right for formal work, but friction is why people skip systems. A
    lightweight "I'm looking at this / quick markup" tier (one click,
    auto-expires same day, upgradeable to full checkout) makes the honest
    path cheaper than the workaround.

### Tier 4 — Wire the alert layer (the pipes exist; connect them)

13. **Start calling `emit()`.** Minimum producer set: force-release →
    victim; auto-expiry → former holder; rev-up/supersede → holder,
    watchers, and recent downloaders of the old rev (`doc_superseded` —
    already defined, never sent); handoff note → next person to check out.
14. **Escalation ladder for stale checkouts**: 7d → nudge holder (exists);
    14d → notify DocCtrl + project lead; 21d → red flag on the control
    tower visible to everyone blocked by it. Stale locks stop being the
    holder's private secret.
15. **`actionRequired: true`** for `checkout_conflict` and conflict-class
    notifications so they get the action treatment in the feed.
16. **Fix auto-release reliability**: the daily cron covers it, but
    document that (and fix the "hourly" comment); consider hourly cadence
    since a 24h cap enforced daily can run 23h late.

### Tier 5 — Bridge drafting tickets and checkouts

17. When a ticket enters **DRAFTING**, auto-open/join a checkout episode on
    its target documents in the drafter's name; ticket close/submit checks
    them in. The drafter gets collision protection without any extra
    steps, and the checkout board finally shows drafting work — which is
    most of the real work.
18. Attach viewer markups to the check-in ticket instead of dropping them.

### Quick hygiene (cheap, do anytime)

- Confirmation dialog on admin force-release.
- Fix the hardcoded "Checked out just now".
- Delete dead `CheckoutPanel.tsx`.
- Make the `superseded_at` stamp failure loud (it currently only
  console.errors, leaving two live versions).

---

## On AutoCAD Vault / hard locking

Vault-style pessimistic locking prevents F1 by construction but at the cost
you already identified: it blocks legitimate parallel work and pushes people
*out* of the system (which recreates F3, worse). The advisory model here is
the right call — what it's missing is **optimistic concurrency at the
publish moment** (Tier 1). That single change gives you the data-safety of
locking with none of the blocking: everyone can work in parallel, but a
stale-base publish physically cannot overwrite someone else's revision
without a human seeing the conflict and saying so on the record. Combined
with Tier 2 (signal at the work surfaces) and Tier 3 (off-system detection),
you get exactly what you asked for: a red-flag, forced-communication,
in-your-face system with an autonomous tracking layer underneath that makes
the silent failure modes impossible — not a lock.
