# Checkout & Document Control — Redesign Proposal (v2)

> Follow-up to `CHECKOUT_SYSTEM_REVIEW.md`. The first proposal's fixes were
> individually sound but collectively risked recreating the disease: noise,
> click-through fatigue, surveillance culture, zombie locks, and a false
> sense of safety. This design resolves those cons structurally. Each
> mechanism below names the pitfall it neutralizes.

## Design principles (derived from the self-critique)

1. **Structural over behavioral.** Anything that matters is enforced by the
   database or captured automatically — never by nagging humans into
   compliance.
2. **Interruption budget.** A hard contract on what may interrupt whom.
   Interruptions are spent only on rare, personal, actionable events; the
   moment an alert class becomes frequent, it is demoted by design.
3. **Annotate the record, not the person.** Provenance is a property of a
   revision, reviewed like QA. There are no per-user scoreboards.
4. **Overrides create debt, not silence.** Every escape hatch produces a
   visible, persistent artifact that someone must explicitly resolve.
5. **Instrument everything, keep what earns its noise.** Every new signal
   ships with counters (shown / dismissed / acted-on) and a feature flag.

---

## 1. The Intent Layer — replace "checked out: yes/no" with "who intends what, based on which revision"

**Pitfalls resolved:** can't-force-people-to-use-the-system; co-download
false positives; two-tier checkout degrading purpose data; ticket
auto-checkout zombie locks.

The binary lock is too coarse to drive signaling. Introduce one new table:

```
document_intents
  id, org_id, document_id
  user_id, user_name
  kind        'view' | 'reference' | 'edit'
  source      'viewer' | 'download' | 'checkout' | 'ticket' | 'declared'
  base_version_id     -- the revision this intent is anchored to (KEY FIELD)
  ticket_id, session_id (nullable back-links)
  created_at, refreshed_at, expires_at
```

Intent is captured **implicitly at every touchpoint** — no user action:

| Touchpoint | Intent created | Decay |
|---|---|---|
| Open in viewer (view mode) | `view` | 4 h |
| Open in markup/edit mode | `edit` | 24 h, refreshed on activity |
| Download / print | `reference` (or `edit` if user has markup mode or an active checkout) | 72 h |
| Checkout (full flow) | `edit`, pinned to the session | until check-in |
| Ticket enters DRAFTING | `edit` on target docs, tagged `ticket` | refreshed by ticket activity; decays 7 days after last ticket touch |

Why this works:

- **Nobody can be invisible.** You cannot get content out of the system
  without leaving an intent record with a base revision. The "Sarah works
  from her desktop folder" problem no longer depends on Sarah declaring
  anything — her download already recorded `edit intent, base rev 3`.
- **View vs edit is distinguishable**, so overlap signals fire on
  *edit×edit* only. Tom glancing at a drawing never pings anyone. This
  kills the false-positive noise that would have burned the co-download
  nudge.
- **Intent decays; locks don't linger.** Tickets register intent, not
  locks — visible on the board ("Dave drafting D-1401 via ticket #482"),
  collision-detectable, but self-expiring. No force-release queue, no
  zombie-lock factory. The explicit checkout remains a deliberate human
  act, exactly as today, so the ISO purpose/reason data stays clean.
- The formal checkout becomes what it should be: a *communication
  artifact* (episode, thread, purpose). The intent layer is the *safety
  net* underneath it. Skipping the checkout no longer skips the safety.

Implementation notes: writes are fire-and-forget from existing call sites
(`downloads.ts`, viewer open, `CheckoutFlowModal`, ticket transition) —
one insert each, never blocking the user path. A partial index on
`(document_id) WHERE kind='edit' AND expires_at > now()` makes the hot
read cheap. Expired rows are pruned by the existing maintenance cron.

---

## 2. Publish Contract — the only hard gate, enforced in one transaction

**Pitfalls resolved:** lost update; false conflicts from non-content ops;
escape hatch silently restoring the bug; critical-path rewrite risk.

One Postgres RPC, `publish_revision`, wrapping today's three client calls
in a single transaction:

```
publish_revision(doc_id, expected_base_version_id, payload…, op_class)
```

- **CAS core:** promotion runs `UPDATE documents SET current_version_id=…
  WHERE id=:doc AND current_version_id=:expected_base`. Zero rows → raise
  `stale_base` with the interloper's version id, name, and change log.
  Plus: unique index on `(record_id, revision_label)` among
  non-superseded rows.
- **`op_class` kills false conflicts.** `content` (rev-up, revert) requires
  base match. `metadata` / `backfill` / `renumber` declare themselves and
  skip the base check — they can't lose drawing content, so they must
  never train users that the conflict screen cries wolf. The conflict
  modal fires **only** on a genuine content race, which is rare by
  construction. Rare = it stays believed.
- **`expected_base` resolution order:** the caller's checkout session's
  `base_version_id` → their freshest edit-intent's base → an explicit
  "based on rev __" picker in the RevUp form (defaulted to current, one
  click). The picker converts the email/USB hole into a declaration
  instead of a blind spot; if the declared base is current but the file
  hash matches an older version or the PDF's internal date predates the
  current rev's, the revision gets a provenance flag (§4) — soft, never
  blocking.
- **Migration safety:** ship the RPC alongside the existing path behind a
  flag; run dual-write comparison for a week; flip; keep the legacy path
  as the documented rollback. The DB trigger guard stays as belt-and-
  suspenders.

### The conflict screen (the one allowed modal)

> **D-1401 changed while you were working.**
> Sarah published rev 4 Wednesday — "rerouted E-204 bypass."
> Your file is based on rev 3.
> [ View diff ] [ Message Sarah ] [ Publish as branch → ] [ Cancel ]

**"Publish anyway" becomes "publish as branch," and branches are debt:**

```
revision_branches
  id, document_id, branch_version_id, diverged_from_version_id,
  reason (required), created_by, resolved_at, resolved_by, resolution_note
```

The branch publishes (nothing is blocked, no work is lost) but the
document now carries an **"unreconciled branch"** badge, the branch
appears in DocCtrl's open-items queue, and both authors are notified. It
cannot be dismissed — only *resolved* ("merged into rev 5" / "branch
withdrawn"), with a note, on the record. An override no longer silently
recreates the lost update; it creates a tracked reconciliation task with
an owner. Routine abuse is self-defeating: the queue makes it visible.

---

## 3. Signal Ladder — a hard interruption contract

**Pitfalls resolved:** alert fatigue, click-through, notification flood,
public shaming, "acknowledgment as blame evidence."

Three rungs, enforced as a policy table in the emit layer — not per-call
judgment:

| Rung | Trigger | Surface | Frequency by construction |
|---|---|---|---|
| **Ambient** | any active edit intent / checkout by another | passive chip in viewer + list ("Dave is working on this — drafting, since Mon"), stamped onto downloads/prints | constant, but zero-click, zero-interruption |
| **Advisory** | fresh *edit×edit* overlap on the same doc (or same asset via existing consolidation) | amber banner for the two people involved + daily digest line; never email, never modal | rare-ish, personal, dismissible |
| **Interrupt** | `stale_base` conflict at publish; your checkout force-released; your published work branched/superseded; a branch you authored awaits resolution | modal (publish only) / durable notification + email-or-push | rare and always about *you* |

Hard rules baked into `emit()` policy:
- Nothing org-wide ever emails. Digest or control tower only.
- Only publish-time conflicts may modal. Download of a checked-out doc
  gets the ambient chip + stamp — **no interstitial** (the v1 interstitial
  is dropped: it would fire on every long checkout and die of fatigue).
- Acknowledgment logging is dropped with it — the stamp on the paper copy
  does the safety work without building a blame ledger.
- Every advisory/interrupt carries `shown/dismissed/acted` counters. A
  signal class whose acted-rate collapses gets demoted or killed —
  measured, not argued.

Stale-checkout escalation stays but goes *narrow*: 7 d → holder nudge;
14 d → DocCtrl queue item (not a broadcast); the control tower shows
"5 documents blocked > 14 d" as a system stat, not names on a wall.

---

## 4. Provenance, not surveillance

**Pitfalls resolved:** compliance-score culture damage, routing around the
system harder.

Delete the per-user compliance score from the plan. Replace with
**revision provenance**, a property of the record:

- Every published revision gets `provenance`: `session` (published from an
  active checkout), `declared` (base picked manually, checks pass), or
  `unverified` (no intent trail, or hash/date heusristics contradict the
  declared base).
- `unverified` revisions render a small badge in version history and land
  in DocCtrl's review queue — identical in spirit to QA receiving inspection.
  Verification is one click ("confirmed with author, base was rev 3").
- The published stat is system-level ("92 % of revisions this quarter had
  full provenance"), never a per-person ranking.

Behavior still changes — publishing from a session is zero extra work
while publishing cold creates a review task — but the pressure is
friction asymmetry on the *path*, not shame on the *person*. Drafters who
feel audited route around systems; drafters whose easiest path is the
safe path don't.

---

## 5. Source-file custody — attack the DWG proxy problem

**Pitfall resolved:** "the PDF is versioned but the real work lives in
desktop folders."

The system versions PDFs, but collisions are born in the DWGs. Without
becoming Vault:

- **Attach source at publish.** `document_versions` already carries
  `source_file_name`; add `source_file_key` and let RevUp accept the DWG
  (or zip of xrefs) alongside the PDF. Not required at first — its absence
  simply feeds provenance (`unverified` if a prior rev had source and this
  one doesn't).
- **"Get source" button** on the current revision, which records an
  `edit` intent with base pinned. The pitch to drafters is selfish, not
  compliance: *the vault always has the current DWG, so you never again
  discover mid-job that your desktop copy was two revs old.* Pull from
  the vault, return at publish — Vault's actual value, no locks.
- Storage cost is bounded by the existing dedup plan (`file_hash` is
  already stored; content-addressing is on the roadmap in
  `DATA_LIFECYCLE.md` §5).

This is the only mechanism that eventually *starves* the desktop-folder
workflow instead of merely detecting it.

---

## 6. Rollout — sequenced so each layer feeds the next

Every phase behind a feature flag with its own kill switch; each ships
with its counters.

| Phase | Ship | Why this order |
|---|---|---|
| 1 | Publish Contract RPC + unique label index + conflict modal + branch-debt table | Stops active data corruption. Interrupts only on true races — cannot fatigue. |
| 2 | Intent layer, **capture-only** (writes, no UI) | Silent. Builds the dataset every later signal needs; validates volume/decay assumptions against real usage before anything speaks. |
| 3 | Personal interrupts via existing `emit()` (force-release, auto-expiry, superseded, branch events) + digest scaffold | Rare, personal, always relevant — safe first use of email/push. |
| 4 | Ambient chips in viewers/lists + download stamps, driven by intent data | Zero-interruption signal, informed by two weeks of real intent data. |
| 5 | Advisory overlap banners (edit×edit) + ticket-intent bridge | Only now, with decay tuned from Phase 2 data, is overlap signal trustworthy. |
| 6 | Provenance badges + DocCtrl review queue; one-click lightweight checkout | Carrot (easy path) lands in the same phase as the soft stick. |
| 7 | Source custody (attach DWG, "Get source") | Structural endgame; benefits from all prior layers. |

Explicitly **dropped from v1**: download interstitials, acknowledgment
logging, per-user compliance scores, ticket auto-*checkout* (replaced by
ticket intent), and unconditional org-wide notifications.

---

## What this buys, restated against the original asks

- *"Red flag alert system, not locking"* → the Signal Ladder: ambient
  always, advisory when two edits genuinely overlap, a full stop only at
  the moment a lost update is about to happen.
- *"Forced communication, in your face"* → the conflict modal with diff +
  message + branch-with-debt. Communication is the cheapest exit from the
  screen, and silence is not an available option.
- *"Autonomous tracking that never lets us fuck things up"* → the intent
  layer records reality without asking anyone, and the publish contract
  makes the silent overwrite a database impossibility — the two guarantees
  hold even for people who never touch the checkout button.
