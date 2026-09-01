# Document control — audit area

Checkout and the lock, revisions and publish, the review gate and e-signatures, holds, distribution and acknowledgment, transmittals, packages, retention and archive, content egress, and the RLS underneath all of it.

**No application code, test, or migration was modified at any point.**

**This is the core of the product.** A defect here does not merely cause a bug — it can put a superseded or unapproved drawing in a worker's hands, or hide a controlled document from the person who needs it.

---

## ⚠ Before you touch anything

1. **Read [`../README.md`](../README.md)** — the resolution protocol — and
   [`../DECISIONS.md`](../DECISIONS.md).
2. **Read [`99-fix-sequencing.md`](./99-fix-sequencing.md)** before claiming a file.
3. **This area came from a 47-agent run covering four areas at once.** The
   completeness critic's report spans all four and lives in
   [`../document-control/11-edges-and-invariants.md`](../document-control/11-edges-and-invariants.md)
   — read it alongside this area's reports.

---

## Findings

**147 findings** — 18 CRITICAL, 53 HIGH, 64 MEDIUM, 12 LOW.

### Progress — session 2026-08-24

**Phase 1 of [`99-fix-sequencing.md`](./99-fix-sequencing.md) — the unguarded
doors — is complete.** Four CRITICALs resolved, each reproduced against current
code before fixing, with tests: `XEDGE-1` (templates/generate read of any bucket
object → key pinned to the caller's output-data prefixes), `PKG-1` (in-place
overwrite of an issued revision's bytes → upload-url refuses to re-sign a
version's key, 409), `EGR-1` (transmittal portal signs any tenant's version
bytes → read-path org scope + a write-time trigger rail + server-minted token +
fixed audit attribution), `DRLS-2` (PUBLIC unauthenticated delete RPC →
authorized to the caller's own orphan and revoked from PUBLIC). Ship loop green:
`tsc`, `eslint`, **1468 vitest** (10 new), full `next build`.

**Migration `20261027_dc_phase1_unguarded_doors.sql` applied & verified live
2026-08-24** (3-point probe all true) — it authorizes `revup_rollback_orphan`
and installs the transmittal write rail. `XEDGE-1` and `PKG-1` are pure app-side
and live on the branch.

**Phase 2 — the field-verdict cluster (the sequencing file's top priority) —
is complete.** The paper-facing half of document control was telling the field
the wrong answer; three CRITICALs closed, each reproduced first, with tests:
`REV-1` (an old revision downloaded/printed as CURRENT, and unstamped for the
checkout holder → downloads describe the served version and a non-current copy
is never a controlled master), `DIST-2` (the QR verify endpoint reported Void,
Draft and held drawings as green → verdict now derives from the shared
not-current set and checks active holds, fail-safe), `PKG-2` (the pack QR
verified the live pin so a desk refresh re-armed field paper to green → an
immutable print snapshot the QR verifies against). Ship loop green: `tsc`,
`eslint`, **1486 vitest**, full `next build`. Migration `20261028_work_package_prints.sql` (the print
snapshot table) **applied & verified live 2026-08-24** (2-point probe true).

**Phase 3 — the permissive-RLS cluster — is complete.** The sequencing file
warns that per-table RLS fixes are decorative until this lands: three CRITICALs
closed. `DRLS-1` (the own-row hardening on acknowledgments and review sign-offs
was VOID because a 20260819 loop-generated `*_member_all` policy was never
dropped → dropped it, leaving the 20260828 per-op set to govern). `DCK-2`
(checkout_sessions DELETE and outcome edits on another's session were unguarded
→ a BEFORE UPDATE OR DELETE trigger, controller-only). `DCK-3` (any member could
seize another's lock by PATCHing `documents.checked_out_by` → a BEFORE UPDATE
guard permitting only claim / holder-transfer / force-release). Fixed with
trigger guards, not policy tightening, so the app's legitimate cross-user writes
(shared-episode links, heir transfer) keep working. Ship loop green: `tsc`,
`eslint`, **1490 vitest**, full `next build`. Migration
`20261029_dc_phase3_permissive_rls.sql` **applied & verified live 2026-08-24**
(both guard probes true).

**Phase 4 — the review gate (the product's central safety claim) — is
complete.** Two CRITICALs closed, designed against a 3-agent recon map of every
legitimate write path so no rail breaks roster creation, publisher bulk work,
alternate activation, or the cron scan: `RG-1` (one INSERT of a pre-signed row
forged review completion → INSERT may not create approval, and both completion
counts require the reviewer's own bound e-signature) and `RG-2` (a publisher
could mark another reviewer's row signed → a BEFORE UPDATE trigger makes row
identity immutable and the →signed transition the reviewer's own act; the app
pins the write and surfaces zero-row refusals). Ship loop green: `tsc`,
`eslint`, **1498 vitest**, full `next build`. Migration
`20261030_dc_phase4_review_gate.sql` **applied & verified live 2026-08-24**
(3-point probe all true).

**Phase 5 — the PSM MOC gate (`DCK-1`) — is complete.** The MOC requirement
for drawing-class revisions lived only in browser JavaScript; it is now
enforced inside `publish_revision` (drawing-class content publishes require a
real `moc_reference`; the Minor/Correction exemption is decided server-side; a
REVERT is never minor-like — `revertToVersion` hardcodes 'Correction', which a
naive exemption would have waived), and `supersedeDocument` gets the app-side
equivalent. Only DECLARED drawings are gated (unclassified legacy data must
not hard-fail; the client still prompts), and the gate no-ops on a
pre-20261012 database. Ship loop green: `tsc`, `eslint`, **1503 vitest**,
full `next build`. Migration `20261031_dc_phase5_moc_gate.sql`
**applied & verified live 2026-08-24** (both probes true).

**Phase 6 — the destructive, irreversible deletes — is complete.** All
app-side, no migration: `RET-1` (the space-saver ignored legal holds — the
hold guarded row DELETEs while the shed deleted R2 bytes → candidates exclude
held parents and commit re-checks, both fail closed, so a hold placed between
produce and commit still protects the bytes), `RET-2` (marked resolved — the
cross-area `SURF-2` fix already closed every limb), `XEDGE-4` (a retention
policy with no prefix purged the customer's ENTIRE bucket by age → the purge
refuses an empty prefix, deletes only this app's `manufacturing-os-export-…zip`
archives, reports scanned/deleted into diagnostics, and both destination
routes refuse the retention-without-prefix pair), `XEDGE-13` (the orphan
sweep's unordered pagination could silently miss a reference and delete a
live file → stable `.order("id")` paging plus an exact-count cross-check that
aborts fail-closed). Ship loop green: `tsc`, `eslint`, **1513 vitest**, full
`next build`.

**Phase 7 — packs, pins & acknowledgment integrity — first block complete.**
One CRITICAL and two HIGH/CRITICAL closed: `PKG-4` (the field pack merged
Draft/Superseded/Void and on-hold sheets stamped like in-force revisions → a
pure gate, `filterPackDocs`, refuses non-Issued/Locked and actively-held
sheets with the reason recorded, fails CLOSED on an errored hold read, and
the "all current, all stamped" toast is now true by construction), `DIST-3`
(anyone could stamp another person's distribution acknowledgment → the
acknowledged_at transition is trigger-bound to the named recipient and
records `acknowledged_by`; rows can't be born acknowledged; the app pins the
write to the caller's own pending row and surfaces zero-row refusals), and
`PKG-5` (the pins behind the PUBLIC pack verdict were any-member-writable
with a cross-org INSERT hole → INSERT binds package+document to the row org,
UPDATE/DELETE need the package owner or Admin/DocCtrl, a pin must name a
version of its own document, and /api/verify-package filters everything by
the package's org). Ship loop green: `tsc`, `eslint`, **1536 vitest** (23
new), full `next build`. Migration
`20261032_dc_phase7_ack_and_pin_integrity.sql` **applied & verified live
2026-08-24** (4-point probe all true).

**Phase 7b — adversarial self-audit of 7a, everything confirmed fixed.** A
29-agent audit (5 dimension finders over the full 7a diff, two independent
skeptics per finding) confirmed 9 findings; every one was fixed the same
session: the tightened pin policy broke non-owner "Print pack" (refresh now
conditional on owner/DocCtrl; prints proceed from current revisions with
pins untouched and the toast says so); the print snapshot and cover listed
sheets the PKG-4 gate then refused (new `assessPackDocs` gate runs BEFORE
any side-effect, so snapshot = cover = paper; an all-refused pack aborts
recording nothing); `acknowledged_by` was rewritable outside a transition
and the pin guard skipped INSERTs (both patched in migration `20261033`);
the recipient's confirm button swallowed the new zero-rows throw (caught,
toasted, reconciled); the pack-progress denominator jumped mid-run (gated
count now authoritative); and the migration-shape tests were
mutation-defeated by unbounded regexes (re-scoped per statement and
re-proved by mutation — both audit mutations now fail the suite).
Migration `20261033_dc_phase7b_guard_patches.sql` **awaiting hand-apply**.
Remaining in Phase 7: `PKG-3`, `REV-2`, `DIST-1` remainder + XEDGE
extensions.

| # | Report | n | Note |
|---|---|---|---|
| 01 | [Checkout, check-in & the lock](./01-checkout.md) | 14 |  |
| 02 | [Revisions, publish & supersession](./02-revisions-publish.md) | 14 |  |
| 03 | [The review gate & e-signatures](./03-review-gate.md) | 13 |  |
| 04 | [Holds & stop-work](./04-holds.md) | 14 |  |
| 05 | [Distribution, acknowledgment & recall](./05-distribution.md) | 14 |  |
| 06 | [Transmittals & the external portal](./06-transmittals.md) | 14 |  |
| 07 | [Doc packs, work packages & the field bundle](./07-packages.md) | 14 |  |
| 08 | [Retention, legal hold, archive & restore](./08-retention.md) | 14 |  |
| 09 | [Content egress](./09-egress.md) | 8 |  |
| 10 | [RLS & persistence — table by table](./10-rls.md) | 14 |  |
| 11 | [Edges, modalities & load-bearing invariants](./11-edges-and-invariants.md) | 14 |  |

Every report except the critic was **adversarially verified** — a second agent
read the cited code and tried to refute each finding. Across the whole run, 333
raw findings were produced and **311 survived**; 22 were refuted and dropped, and
several severities were lowered by that pass. The lowered value is what is
recorded.

Each report opens with a **substrate table** — what already exists, works, or is
load-bearing. That is deliberately as prominent as the defects.

---

## Method & limits

- **No live database, no browser, no running app.** RLS policies, call graphs and
  deterministic logic are read from code and are exact. Anything about what a user
  *sees* is read from render conditions and is marked `SUSPECTED`.
- The run was seeded with the recurring defect shapes the five earlier audits
  found — the `FOR ALL` policy with only `USING`, the swallowed `supabase-js`
  error, dead FK columns, comments describing unbuilt behaviour, hardcoded
  facility vocabulary — so the lenses hunted those directly rather than
  rediscovering them.
- Per `DEC-29`, reproduce before fixing.
