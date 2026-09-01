# 05 · Distribution, acknowledgment & recall

**14 findings** — 3 CRITICAL · 6 HIGH · 5 MEDIUM.

Who was told, who acknowledged, and whether either is provable.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| document_acknowledgments roster model — one row per (document, version, assignee), completion always recomputed from rows rather than cached, prior-revision rows excluded from the live pill via current_version_id | `supabase/migrations/20260817_read_understood.sql:26-78; lib/acknowledgments.ts:142-214` | This is the correct shape for proof-of-training: it survives a rev without silently transferring (recomputeDocumentAck voids stale-revision pending rows and opens a fresh roster), and getAckSummaries cannot drift because nothing is cached. Any fix to distribution_acks should copy this model, not the reverse. |
| The empty/unsatisfiable-roster contingency: an enabled ack policy that resolves to nobody notifies the effective owner plus org controllers instead of silently counting as done | `lib/acknowledgments.ts:392-405` | This is the exact 'what happens when the roster resolves to nobody' safeguard the lens asks for, and it exists and is wired. It is undermined only by the headline-only role expansion feeding it (finding 8) — the mechanism itself is sound and worth preserving. |
| Server-side stamping on the public share path: bytes are pulled bucket→server and watermarked with applyStampToPdfDoc before any response, with no raw-presigned-URL fallback | `app/api/share/file/route.ts:1-16, 105-125` | This closed a real leak (client-side stamping was CORS-blocked and the fallback served the raw file). The stamped-vs-unstamped distinction is even carried into the audit payload. Do not reintroduce a client-side stamp or a direct bucket URL while fixing the audit-row bug in finding 5. |
| The transmittal portal: the recipient acknowledges receipt themselves under their own name, with acknowledged_via ('portal' vs 'manual') and server-observed IP/user-agent recorded, and the RLS split that replaced the any-member FOR ALL policy | `supabase/migrations/20260910_transmittal_portal.sql:1-60; app/api/transmittal/route.ts:107-160` | This is the reference fix for 'one person acknowledging for another' — its header states the prior behaviour explicitly ('previously an org member typed the recipient's name on their behalf'). distribution_acks (finding 1) needs the same treatment; this migration is the template. |
| The QR verify endpoint's deliberate minimal-exposure contract: unauthenticated by design, UUID-validated, version-must-belong-to-document check, revision-status facts only — no URLs, no content, no people; plus the not-yet-effective amber state | `app/api/verify/route.ts:1-13, 58-66, 90-93` | This is the only recall channel that reaches paper and its trust model is carefully reasoned. The Void gap (finding 3) is a one-line omission in an otherwise well-built surface — fix the status set, do not redesign the endpoint. |
| scanDistributionAcks's notification-watermark cooldown: the recently-sent notifications themselves are the dedupe key, so a controller's manual nudge suppresses the robot's follow-up | `lib/distributionAcks.ts:218-240` | Nag cadence is the usual place these compliance scans become noise and get muted. This one is designed correctly (per recipient+document, per requester+document, best-effort so a dedupe failure costs one extra nudge, not a dropped obligation). Preserve it when adding the version scoping from finding 2. |
| assertAckGate's fail-open discipline and its policy memo — a hard acknowledgment gate blocks the download, but any lookup error lets the pull through rather than bricking downloads | `lib/downloads.ts:153-215` | This is the enforcement the 'blocked' pill promised, and its failure mode was chosen deliberately ('enforcement must not outlive its data'). It is the one place an acknowledgment has real teeth; changes to document_acknowledgments RLS (finding 7) must not break it. |
| The maintenance cron's single-entry constraint and its per-scan, per-org error reporting | `app/api/cron/maintenance/route.ts:155-186, 286-291` | All seven compliance scans (including both ack scans) ride this one lambda because a third vercel.json cron entry fails every deployment on this plan. Any recall-sweep or share-expiry job proposed by these findings must be added inside this route's scan list, never as a new cron entry. |


---


<a id="dist-1"></a>

## DIST-1 · Retiring a document performs no distribution recall of any kind — and simultaneously silences the holder's own stale-copy list

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 7c).** Confirmed, including the inert escape hatch (retirement leaves `current_version_id` alone, so `hasCurrent` reads true for everyone and even the manual nudge button reached zero people). Fixed on all three limbs:
- **Automatic retirement recall** — new `recallRetiredDocument` in `lib/staleCopies.ts`: on supersede, EVERY distinct download-audit holder in the 60-day window is told the document is dead paper (the `hasCurrent` split is meaningless when nothing is current), with the replacement documents named. `supersedeDocument` fires it alongside `notifyPackagesOfRetirement` — a controller finding the inspector button is no longer the only channel.
- **Rev-up recall** — `runPostPublishSideEffects` now also nudges the download-audit population (via `getDocumentRecall` + `nudgeStaleHolders`) on every publish; `notifySuperseded` reached intent holders and followers, but the people who provably HOLD a copy were never in that fan-out (the verifier's gap (a)).
- **The stale-copy list tells the truth** — `listMyStaleCopies` no longer filters retired documents out (the line-76 skip): a retired doc's copies are flagged with `retiredStatus` and sorted FIRST — including the final revision, which the "still current" check used to skip. My Desk renders them red: "SUPERSEDED — destroy your Rev 3 copy" instead of silence.
- **Shares stop serving** — `supersedeDocument` revokes outstanding `document_shares` (sets `revoked_at`/`revoked_by`; the share endpoint already 410s revoked links). RLS may leave another creator's rows beyond a non-controller actor's reach, so the revoked COUNT is recorded on the SUPERSEDE_DOC audit event rather than claimed silently.
- Done-when: (1) supersede + rev-up recall automatically ✓ — **scope note:** there is no `voidDocument` lifecycle function to hook; Void is set today by a raw metadata write (MetadataEditor), a gap that belongs to the metadata-editing findings — the recall helper is ready for it; (2) retired docs are the TOP of listMyStaleCopies, never filtered ✓; (3) retirement revokes/flags document_shares with honest accounting ✓.
- Files: `lib/staleCopies.ts`, `lib/revisions.ts`, `lib/postPublish.ts`, `components/cockpit/MyDeskPanel.tsx`.
- Tests: `lib/__tests__/staleCopiesRecall.test.ts` — a final-revision copy of a Superseded doc is flagged with `retiredStatus` (the exact pre-fix double-skip); a current copy of a living doc stays unflagged; a stale copy of a living doc flags with `retiredStatus` null; retirement recall reaches each distinct holder once, excludes the actor, names replacements; empty holder set emits nothing.
- **What this brought to light:** recipients of a rev-up nudge who ALSO hold a live intent may now receive two notifications for one publish (notifySuperseded + the recall). Accepted: both are true statements to people provably holding stale paper; the notify-dispatch dedupe cluster (notifications area) is where cross-channel coalescing belongs. DIST-4 (acks never closed on rev-up) and DIST-10 (recall leaves no record) remain open and are the natural next cluster here.

- **Verification:** CONFIRMED
- **Locations:** `lib/revisions.ts:1414-1537`, `lib/staleCopies.ts:76`, `lib/staleCopies.ts:182-209`, `components/documents/DistributionRecall.tsx:48-59`, `lib/postPublish.ts:100-145`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed, and the manual escape hatch is inert too: getDocumentRecall (lib/staleCopies.ts:143-160) computes `hasCurrent: r.version_id === currentVersionId`, and supersedeDocument never changes current_version_id — so after retirement everyone who pulled the final rev reads hasCurrent=true and nudgeStaleHolders' `holders.filter((h) => !h.hasCurrent)` returns an empty set (0 nudged). The only rationale I can construct for the line-76 filter is that 'go re-download the current rev' is meaningless for a retired doc, but the effect is that the most dangerous copy in circulation is the one the system stops mentioning.

**Mechanism.** supersedeDocument does six things after flipping status to 'Superseded': writes supersession metadata, inserts document_supersessions join rows, logRevisionEvent, an episode message + notify to the checkout holder, and `notifyPackagesOfRetirement`. It does not call nudgeStaleHolders, does not revoke document_shares, does not close distribution_acks, and does not recompute document_acknowledgments (recomputeDocumentAck returns early at lib/acknowledgments.ts:342 `if (doc.status !== "Issued" || !versionId) return;`). The same holds for the rev-up path: lib/postPublish.ts:100-145 fans out to work packages, revision impact and link proposals, but never to the people who downloaded the thing. The only recall trigger in the product is a human opening the inspector and clicking a button (DistributionRecall.tsx:48-59 → nudgeStaleHolders). And in the retirement case the holder's own safety net is explicitly disabled: `if (d.status === "Archived" || d.status === "Superseded" || d.status === "Void") continue;` (lib/staleCopies.ts:76) removes retired documents from listMyStaleCopies.

**Failure scenario.** P-101 is superseded by P-101A/P-101B after a loop split. Nine people downloaded P-101 in the last month; several printed it. Nobody is told. The work-package owners hear about it (notifyPackagesOfRetirement) and the one person holding the checkout hears about it — everyone actually holding a copy hears nothing. When one of those nine opens their own "my outdated copies" view to self-check, P-101 has been filtered out because it is Superseded, so the view reports clean. Retirement — the single loudest recall event in document control — is the one event that reaches no copy holder.

**Evidence.**

```
lib/revisions.ts:1414-1537 read end to end; grep for `nudgeStaleHolders|staleCopies` across lib/postPublish.ts, lib/revisions.ts, lib/archive.ts returns nothing (exit 1), and the repo-wide grep shows nudgeStaleHolders imported only by components/documents/DistributionRecall.tsx:10 — a manual UI click is its sole caller; lib/staleCopies.ts:76 quoted above.
```

**Chain reaction.** Combined with the verify-endpoint Void gap above, a voided or superseded drawing in a worker's hands is reachable by no channel: no push, no bell, no email, no entry in their outdated-copies list, and a QR that answers green (Void) or is never scanned.

> **Verifier correction.** One sub-claim is too absolute: the REV-UP path is not silent. runPostPublishSideEffects calls notifySuperseded first (lib/postPublish.ts:92-100), which emits to live intent holders and library followers with body text 'If you are holding an older copy (downloaded or checked out), it is now superseded' (:36-61). The genuine gap is (a) that fan-out is keyed to intents/followers, never to the download_audits population, and (b) the RETIREMENT path has no equivalent at all beyond notifyPackagesOfRetirement (work-package owners only, lib/postPublish.ts:150-187).

**Done when.**

- [ ] supersedeDocument / voidDocument / revUp invoke the stale-holder recall automatically (or queue it), rather than depending on a controller finding the inspector panel
- [ ] listMyStaleCopies treats a retired document as MORE urgent, not filtered — a copy of a superseded or void drawing is the case the feature exists for
- [ ] retirement revokes or flags outstanding document_shares on that document so the public link stops serving a retired drawing

---

<a id="dist-2"></a>

## DIST-2 · The QR verify endpoint — the only recall channel that reaches a printed copy — reports a VOIDED drawing as current

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 2 — the field-verdict cluster).** Confirmed: `/api/verify` derived `docRetired` from the inline literal `"Superseded" || "Archived"`, so Void and Draft verified green. Rewritten to derive retirement from the shared `NOT_CURRENT_STATUSES` set (`lib/aiBoundary.ts` — Superseded/Void/Archived), handle Draft as not-in-force, and additionally check for an **active hold** (legal_hold flag OR an unreleased `document_holds` row) — a stop-work signal that must beat even a current version. The route now returns a typed `verdict` (`current` / `not_yet_effective` / `held` / `void` / `archived` / `superseded` / `draft` / `superseded_version`); `isCurrent` stays for back-compat but is true only for the plain in-force case. A hold-lookup error fails **safe to `held`**, never green. The verify page renders a distinct full-screen verdict per case (red "VOID — DO NOT USE", red "ON HOLD — STOP WORK", etc.) instead of the old green/red boolean.
- Done-when: (1) `docRetired` from the shared set + Draft handled ✓; (2) the page renders a distinct verdict for retired/void/held ✓; (3) a test pins the verdict for every `DocumentStatus` and for holds so a new status can't default to green ✓.
- Files: `app/api/verify/route.ts`, `app/verify/[docId]/page.tsx`
- Tests: `lib/__tests__/verifyRouteVerdict.test.ts` — Issued→current, Void→void, Superseded, Archived, Draft, active hold→held (overrides current), legal_hold→held, hold-error→held-fail-safe.
- **What this brought to light:** this endpoint is shared with the REV-1 QR half and with the public-surfaces field-verdict findings (`VFY-1`, `PHYS-1`); the hold-awareness added here also closes the "held document verifies green" limb of that cluster at the shared endpoint. `lib/staleCopies.ts:76` skipping Void docs (the in-app recall half) is noted there as a separate follow-up.

- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:89-90`, `app/verify/[docId]/page.tsx:62-65`, `lib/aiBoundary.ts:25`, `lib/staleCopies.ts:76`, `lib/downloads.ts:60-65`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. "Void" is a first-class status set from MetadataEditor.tsx:9 without minting a new version, so current_version_id still equals the QR's `v` (stamped as `?v=${doc.currentVersionId}` at lib/downloads.ts:100, lib/docPack.ts:105, app/api/share/file/route.ts:115). isCurrent evaluates true and app/verify/[docId]/page.tsx:64 paints `bg-emerald-600` with the headline "CURRENT". No guard elsewhere in the route or page compensates; the page trusts the API's isCurrent verbatim.

**Mechanism.** `const docRetired = d.status === "Superseded" || d.status === "Archived"; const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);` — "Void" is absent. Voiding a document does not clear current_version_id, so a print taken from the last published version of a now-Void drawing satisfies `versionId === d.current_version_id`, docRetired is false, and the response carries isCurrent: true. The verify page paints the whole screen from that one boolean: `loading || error ? "bg-slate-900" : result?.notYetEffective ? "bg-amber-500" : result?.isCurrent ? "bg-emerald-600" : "bg-red-600"` — full-screen green, "green means work, red means stop and get the current revision" per the file's own header. The canonical retired set exists in this repo and includes Void: `export const NOT_CURRENT_STATUSES: ReadonlySet<string> = new Set(["Superseded", "Void", "Archived"])` (lib/aiBoundary.ts:25), and lib/staleCopies.ts:76 uses the same three. Only the verify endpoint disagrees. ("Draft" is likewise absent, so a print pulled from a Draft-status document also verifies green — lib/downloads.ts:58-59 labels that state "Draft — not issued".)

**Failure scenario.** A P&ID is voided after an MOC determines the loop it shows was never built as drawn. Every uncontrolled copy already in the plant carries a QR footer reading "scan the QR to confirm it is still current". A pipefitter with a print on the scaffold scans it, gets the full-screen emerald verdict, and works the job from a drawing Document Control has formally voided. The paper stamp, the QR, and the verify page — the entire paper-facing half of document control — all actively confirm the wrong answer.

**Evidence.**

```
app/api/verify/route.ts:89 quoted verbatim; app/verify/[docId]/page.tsx:64 the colour ternary keyed on result?.isCurrent; lib/aiBoundary.ts:25 and lib/staleCopies.ts:76 both including "Void" in the retired set; types/schema.ts:613 `export type DocumentStatus = "Draft" | "Issued" | "Superseded" | "Void" | "Archived" | "Locked"` confirming Void is a live status, and components/documents/MetadataEditor.tsx:9 / RevUpModal.tsx:76 confirming users can set it.
```

**Chain reaction.** lib/staleCopies.ts:76 skips Void documents entirely when computing "my outdated copies", so the in-app half of recall also goes silent on a voided drawing. Void is therefore the one lifecycle state where no recall channel — paper QR, personal stale-copy list, or notification — tells a holder anything.

**Done when.**

- [ ] app/api/verify/route.ts derives docRetired from the shared NOT_CURRENT_STATUSES set (lib/aiBoundary.ts:25) rather than an inline two-status literal, and Draft is handled as not-in-force
- [ ] the verify page renders a distinct verdict for a retired/void document rather than falling through the isCurrent boolean
- [ ] a test pins verify's verdict for each value of DocumentStatus so a new status cannot silently default to green

---

<a id="dist-3"></a>

## DIST-3 · distribution_acks UPDATE is any-active-member with no recipient predicate — one person can acknowledge for another; the 20260828 fix hardened the sibling table and skipped this one

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 7).** Confirmed exactly as written, including the false comment in 20260825 ("the app only ever writes acknowledged_at to rows where they are the recipient" — `acknowledge()` filtered by id alone). One person could stamp another's acknowledgment and the "prove the field knew" register became a forgery with no mark. Fixed on both halves, migration `20261032`:
- **DB.** New column `acknowledged_by UUID`. INSERT policy re-created with `AND acknowledged_at IS NULL` — a row can no longer be born acknowledged (the requester's roster upsert never sets it, so nothing legitimate breaks). The permissive UPDATE policy **stays** — deliberately: the requester's re-nudge upsert refreshes `requested_at`/`requested_by` on RECIPIENTS' rows, a legitimate cross-user write that a recipient-only policy would kill (the done-when's "separate controller-scoped policy for requested_at refresh" can't be expressed column-wise in RLS grammar). The transition that matters is owned by trigger `trg_distribution_ack_guard` (BEFORE UPDATE, service-role pass-through, same design as Phases 3/4): row identity (`recipient_user_id`/`version_id`/`document_id`/`org_id`) is immutable, and any change to `acknowledged_at` requires `OLD.recipient_user_id = auth.uid()` and stamps `NEW.acknowledged_by := auth.uid()` — a proxy acknowledgment is impossible for other users and *visible* even for privileged/service writes (done-when 3).
- **App.** `acknowledge(ackId, recipientUserId)` now takes the recipient uid, adds `.eq("recipient_user_id", uid)` and `.is("acknowledged_at", null)`, and **checks the write**: `.select("id")` with a zero-rows throw ("This acknowledgment isn't yours to sign (or it was already recorded).") — the pre-existing silent-zero-rows shape from RG-1 was here too. Caller `components/documents/DistributionAcks.tsx` passes `currentUserId`.
- Done-when: (1) acknowledged_at transitions require the recipient — enforced by trigger rather than policy-split, with the reasoning above ✓; (2) acknowledge() takes the uid and pins the client write ✓; (3) `acknowledged_by` records who stamped ✓.
- Files: `supabase/migrations/20261032_dc_phase7_ack_and_pin_integrity.sql`, `lib/distributionAcks.ts`, `components/documents/DistributionAcks.tsx`.
- Tests: `lib/__tests__/distributionAckPin.test.ts` (update pinned to own still-pending row; zero rows throws; DB error surfaces); `lib/__tests__/phase7AckPinMigration.test.ts` (INSERT forbids born-acknowledged rows, identity immutability, recipient-only stamp, acknowledged_by recording, search_path pin, service-role pass).
- **Applied & verified live 2026-08-24:** `20261032` — 4-point probe all true (ack guard installed; ack INSERT forbids rows born acknowledged; pack-pin INSERT org-bound; pack-pin guard installed). The forgery door is closed at the database.
- **Self-audit addendum (2026-08-24, Phase 7b).** The adversarial audit of this fix confirmed two gaps, both closed:
  1. **`acknowledged_by` was itself forgeable** — the deliberately-retained permissive UPDATE policy admits any member's PATCH, and the guard only touched the column inside the acknowledged_at-transition branch, so a write that left `acknowledged_at` alone could rewrite WHO stamped it. Migration `20261033` makes the column trigger-owned: every user-path write starts from `OLD.acknowledged_by`; only the recipient's own transition sets it. **Applied & verified live 2026-08-24** (4-point probe all true). (Scope note, correcting this record's earlier wording: service-role writes pass the guard untouched by design — restore needs to write the column — so "visible after the fact" holds for **user-path** writes; a privileged service write can still set it, as it must.)
  2. **The recipient's confirm button swallowed the new zero-rows throw** — `handleAcknowledge` had `try/finally` with no catch, so a benign race (already stamped in a second tab) produced an unhandled rejection, a reset spinner, and a stale bar. `components/documents/DistributionAcks.tsx` now catches with a "Confirmation not recorded" toast and reloads in `finally`, so the race self-heals visibly.

- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260825_work_packages_acks.sql:131-139`, `lib/distributionAcks.ts:186-193`, `supabase/migrations/20260828_integrity_hardening.sql:248-281`, `lib/distributionAcks.ts:57-73`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide search confirms the absence claim: `grep -rn distribution_acks supabase/ | grep -i policy` returns only the three 20260825 policies; supabase/schema.sql:1294-1309 defines the table and indexes but no policy, and no later migration hardens it. The sibling tables were hardened in 20260828_integrity_hardening.sql (doc_review_signoff_update at :229-241 and doc_ack_update at :264-277 both carry `reviewer_user_id = auth.uid()` / `assignee_user_id = auth.uid()`); distribution_acks was skipped, exactly as claimed.

**Mechanism.** The only UPDATE policy on distribution_acks is `CREATE POLICY distribution_acks_org_update ON distribution_acks FOR UPDATE USING (EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = distribution_acks.org_id AND org_members.uid = auth.uid() AND org_members.status = 'active'))` — org membership only, no recipient_user_id predicate, no WITH CHECK (so USING is reused as the post-image check, which is equally permissive). The migration's own comment concedes it: "Keep it simple: any active member may update (the app only ever writes acknowledged_at to rows where they are the recipient…)". That app-side claim is false: `export async function acknowledge(ackId: string): Promise<void> { const { error } = await supabase.from("distribution_acks").update({ acknowledged_at: new Date().toISOString() }).eq("id", ackId).is("acknowledged_at", null); ... }` filters on id alone — no `.eq("recipient_user_id", uid)`. Every row id is readable by every active member via distribution_acks_org_select. Three days after this table shipped, 20260828_integrity_hardening.sql fixed exactly this shape on document_acknowledgments ("same hole, same fix — an assignee can only sign their OWN read-&-understood row", doc_ack_update USING … AND (assignee_user_id = auth.uid() OR controller OR effective owner)) and on document_review_signoffs. distribution_acks — created 20260825, structurally identical — was never revisited.

**Failure scenario.** Doc Control sends P-101 Rev 5 to 12 field personnel and the register/inspector must show "8 of 12 confirmed". Any active org member (a Viewer, a contractor account, the person who wants the count to look clean) SELECTs distribution_acks for that version_id, then issues PATCH /rest/v1/distribution_acks?id=eq.<row> with {"acknowledged_at":"…"} for the four outstanding recipients. The panel reads "12 of 12 confirmed", the cron stops nagging, the escalation to the requester never fires — and four welders never saw Rev 5. The PSM audit answer "prove the field knew about the change" is now a forgery with no distinguishing mark: the row records only acknowledged_at, not who set it.

**Evidence.**

```
20260825_work_packages_acks.sql:135-139 quoted above; lib/distributionAcks.ts:186-193 `.eq("id", ackId).is("acknowledged_at", null)` with no recipient filter; 20260828_integrity_hardening.sql:23-24 header comment "3. document_acknowledgments RLS: same hole, same fix" and :264-273 the applied predicate — proving the pattern was recognised and this table was omitted.
```

**Chain reaction.** The forged count feeds InspectorPanel.tsx:196-204 (the "N/M confirmed" pill), lib/docControlRegister.ts:117 (register "unconfirmed" badge / CSV handed to auditors), and lib/impact.ts:186-194 (pendingDistributionAcks in revision impact). All four surfaces report the same fabricated number.

**Done when.**

- [ ] distribution_acks_org_update is replaced with a policy whose USING and WITH CHECK both require `recipient_user_id = auth.uid()` for any write that sets acknowledged_at, with a separate controller/requester-scoped policy for requested_at refresh
- [ ] lib/distributionAcks.ts acknowledge() takes the recipient uid and adds `.eq("recipient_user_id", uid)` so the client write matches the policy
- [ ] the row records who stamped the acknowledgment (acknowledged_by) so a proxy acknowledgment is at least visible after the fact

---

<a id="dist-4"></a>

## DIST-4 · A superseding revision never closes outstanding distribution acks, and the recipient is structurally unable to discharge them

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 7e).** Confirmed — the confirm bar was version-scoped while every obligation reader was not, so a Rev-4 row after Rev 5 issued was immortal and un-dischargeable. Fixed on both sides of the ledger:
- **Close-out on the write paths.** New `closeStaleAcksForDocument(documentId, currentVersionId | null)` in `lib/distributionAcks.ts` stamps `superseded_at` (migration `20261035`) on PENDING rows that stopped binding: publish closes every other version's pending rows (`runPostPublishSideEffects`), retirement closes them all (`supersedeDocument`, alongside the DIST-1 recall). Acknowledged rows are completed history and are never touched. The permissive UPDATE policy + the 20261032/33 trigger let any member stamp this column while identity, `acknowledged_at` and `acknowledged_by` stay guarded.
- **Currency scope on every reader** (belt over the stamp, so a pre-migration database is correct too): `listMyPendingDistributionAcks` (inbox/My Desk), `scanDistributionAcks` (the cron — no more 3-day nags and 10-day escalations for a revision that no longer exists), `loadDocControlRegister` (the auditor-facing "unconfirmed" pill no longer permanently inflated), and `getDocumentImpact` all skip rows whose version is not the document's current version or whose document is retired — the shared `ackStillBinds` rule.
- **Backfill.** `20261035` also closes every EXISTING orphan in one pass, with the verification query proving zero remain.
- Done-when: (1) revUp/supersede close prior-version acks with a superseded mark ✓ (Void note: no `voidDocument` lifecycle function exists — same scope note as DIST-1; the readers' currency scope covers voided docs regardless); (2) inbox, cron, register and impact all scope to `current_version_id` ✓; (3) a stale-revision ack is closed FOR the recipient — nothing to clear ✓.
- Files: `lib/distributionAcks.ts`, `lib/postPublish.ts`, `lib/revisions.ts`, `lib/docControlRegister.ts`, `lib/impact.ts`, `supabase/migrations/20261035_dc_phase7e_ack_currency.sql`.
- Tests: `lib/__tests__/distAckCurrency.test.ts` — non-current-version ack dropped from the inbox while the current one stays; retired-doc ack dropped even at its final version; close-out filters pinned (pending-only, un-closed-only, `neq` current on publish, no `neq` on retirement); pre-migration no-op.
- ⚠ **Migration `20261035` awaiting hand-apply** — the readers are already correct without it; the paste adds the durable close-out mark and clears the existing orphans.

- **Verification:** CONFIRMED
- **Locations:** `lib/distributionAcks.ts:152-183`, `lib/distributionAcks.ts:76-97`, `lib/distributionAcks.ts:202-304`, `lib/revisions.ts:1414-1537`, `lib/docControlRegister.ts:117`, `components/documents/InspectorPanel.tsx:194-204`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed and the loop is genuinely closed against the recipient: app/(protected)/inbox/page.tsx:422 renders only a Link to `/documents/${a.libraryId}?doc=${a.documentId}` (no inline confirm button), which opens the doc at Rev 5, where getMyPendingAck(Rev5) returns null so the confirm bar never renders. lib/docControlRegister.ts:117 counts every unacknowledged row regardless of version, so the register's "N unconfirmed" pill is permanently inflated, and scanDistributionAcks (lib/distributionAcks.ts:202-216) has no currency filter either, so the cron nags the orphan rows forever.

**Mechanism.** distribution_acks rows are keyed to a version_id. Nothing anywhere voids, closes or re-points them when the document revs forward: supersedeDocument (lib/revisions.ts:1414-1537) updates documents, writes document_supersessions, logs the event, messages the checkout holder and calls notifyPackagesOfRetirement — it never touches distribution_acks. postPublish/revUp likewise. Meanwhile the read paths split: the recipient's confirm bar is scoped to the CURRENT version — `getMyPendingAck(versionId, userId)` does `.eq("version_id", versionId).eq("recipient_user_id", userId).is("acknowledged_at", null)` and the inspector passes selectedDoc.currentVersionId — but the obligation queues are NOT: `listMyPendingDistributionAcks` filters only `.eq("org_id", orgId).eq("recipient_user_id", uid).is("acknowledged_at", null)`, and `scanDistributionAcks` filters only `.eq("org_id", orgId).is("acknowledged_at", null).lt("requested_at", nagCutoff)`. So a Rev-4 row survives forever, keeps appearing in the inbox and keeps being nagged, while the button that would clear it can never render.

**Failure scenario.** P-101 Rev 4 is distributed to 12 people; 4 confirm. Rev 5 issues the next week. Those 8 Rev-4 rows are now immortal: the inbox card "Confirm you have these revisions" lists P-101 forever, its link opens the document at Rev 5 where DistributionAcks queries version_id = Rev5 and finds nothing, so no "I have this revision" bar appears. The daily maintenance cron re-nags each of the 8 every 3 days indefinitely and escalates to the requester every 10 days: "8 unconfirmed after 10+ days: P-101" — about a revision that no longer exists. Operators learn the confirmation prompt is broken and stop reading it, which is the failure mode acknowledged distribution exists to prevent.

**Evidence.**

```
lib/distributionAcks.ts:157-164 (no version filter) vs :82-88 (`.eq("version_id", versionId)`); :211-216 scan with no version filter; lib/revisions.ts:1414-1537 read end-to-end with no distribution_acks reference; repo-wide grep for `distribution_acks` returns writers only in lib/distributionAcks.ts and lib/docControlRegister.ts / lib/impact.ts / InspectorPanel.tsx as readers — no supersede-time cleanup exists anywhere.
```

**Chain reaction.** Two document-control surfaces now contradict each other on the same document: InspectorPanel.tsx:196-199 counts with `.eq("version_id", selectedDoc.currentVersionId)` and shows "0 of 0 · none requested for Rev 5", while lib/docControlRegister.ts:117 counts every unacknowledged row org-wide and stamps "8 unconfirmed" on the register row — the artifact handed to an auditor. Neither number is retractable by any user action.

> **Verifier correction.** Severity overstated at CRITICAL: no unapproved or superseded drawing reaches a worker through this. The consequence is a permanently undischargeable obligation — perpetual nags from scanDistributionAcks and a stuck 'N unconfirmed' badge on the register (lib/docControlRegister.ts:117, app/(protected)/register/page.tsx:166) — i.e. a false compliance signal and noise, not a distribution of the wrong revision.

**Done when.**

- [ ] revUp / supersede / void close out prior-version distribution_acks (a closed_at or superseded status), the way recomputeDocumentAck voids stale read-&-understood rows
- [ ] listMyPendingDistributionAcks, scanDistributionAcks, docControlRegister and impact all scope to the document's current_version_id so the inbox, the cron, the register and the inspector agree
- [ ] a recipient holding a stale-revision ack has some path to clear it, or it is closed for them

---

<a id="dist-5"></a>

## DIST-5 · Acknowledgment rosters resolve roles against the headline role only, silently omitting everyone whose matching role is additive — and produce no warning when they do

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/acknowledgments.ts:77-87`, `lib/notify/recipients.ts:47-62`, `supabase/migrations/20260722_member_roles_collection.sql:12-23`, `lib/ownership.ts:92-95`, `lib/acknowledgments.ts:393-405`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the no-warning half. lib/acknowledgments.ts:85 `for (const role of roles) if (!covered.has(role)) warnings.push(...)` fires only when a role has ZERO headline holders; a role held additively by six people and headline by two produces `covered.has(role) === true`, so the ack_unsatisfiable notice at :392-405 never fires and the partial roster is silent.

**Mechanism.** expandAssignees resolves a policy's assigneeRoles with `supabase.from("org_members").select("uid, display_name, email, role").eq("org_id", orgId).eq("status","active").in("role", roles)`. Since 20260722 a member holds a COLLECTION of roles: `ALTER TABLE org_members ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}'` with the column comment "Additive role collection. Effective permissions = union across these roles. org_members.role mirrors the highest-ranked role here (the headline)". Matching on `role` therefore matches only each person's HIGHEST-ranked role. The repo already contains the correct implementation for exactly this: lib/notify/recipients.ts:47-62, "Active org members whose role — headline OR additive collection — is in `roles`", which selects `uid, role, roles` and tests `const held = m.roles && m.roles.length > 0 ? m.roles : m.role ? [m.role] : []`. Worse than the omission is its invisibility: the gap warning is `for (const role of roles) if (!covered.has(role)) warnings.push(\`Role "${role}" has no active members\`)` — `covered` is built from the rows that DID match, so as long as one person carries the role as their headline, a roster missing five others reports zero warnings and the contingency alarm at :393-405 never fires.

**Failure scenario.** A safety procedure is set to require acknowledgment from role "Operator". Six of the eight operators are also Supervisors or Leads, so their headline role is the higher-ranked one and "Operator" lives only in their `roles` array. The roster opens with two people. Both sign. getAckSummaries reports required=2, done=2; the pill reads "complete"; maybeNotifyComplete tells the owner "Everyone assigned has read & understood this revision"; renderAckReport prints "2 of 2 acknowledged" as the proof-of-training sheet for an OSHA PSM audit. Six operators were never asked and no warning was ever raised, because "Operator" was covered by two headline holders.

**Evidence.**

```
lib/acknowledgments.ts:79 quoted verbatim; 20260722_member_roles_collection.sql:12-23 establishing roles[] and the headline semantics; lib/notify/recipients.ts:47-62 the correct in-repo implementation; lib/acknowledgments.ts:86 the `covered` set built only from matched rows.
```

**Chain reaction.** The escalation that is supposed to catch a bad roster shares the defect: `getOrgControllers` (lib/ownership.ts:93) is `.in("role", ["Admin", "DocCtrl"])` — headline-only and hardcoded facility vocabulary (the pattern the roles-and-permissions audit flagged). When a roster does resolve to nobody, lib/acknowledgments.ts:397-404 notifies `[owner, ...getOrgControllers()]`; a DocCtrl whose headline role is Manager is not on that list, so the "resolved to no one" alarm can itself reach no one.

**Done when.**

- [ ] expandAssignees uses resolveRoleRecipients (or the same headline-OR-collection test) instead of `.in("role", roles)`
- [ ] the coverage warning is computed per-role against the full expected membership, so a partially-resolved role still warns
- [ ] getOrgControllers matches the additive roles array and takes its role list from org configuration rather than a literal ["Admin","DocCtrl"]

---

<a id="dist-6"></a>

## DIST-6 · Any active org member — including a Viewer — can mint a never-expiring public link to any document, bypassing the document ACL, with no role gate and no audit record

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260623_document_shares.sql:36-54`, `components/documents/InspectorPanel.tsx:574-581`, `components/documents/ShareLinkModal.tsx:27-33`, `lib/documentShares.ts:33-57`, `app/api/share/resolve/route.ts:30-48`, `supabase/migrations/20260708_acl_rls_enforcement.sql:1-17`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every limb. lib/documentShares.ts:33-56 createShareLink writes the row and returns — no logAuditAction, no logRevisionEvent, no notify; grep for document_shares finds no cron/sweeper and no org-wide listing (listShareLinks at :58-65 is `.eq("document_id", ...)` only, i.e. per-document). The ACL-bypass limb is real but narrower than stated: 20260708_acl_rls_enforcement.sql:11-14 leaves visibility 'normal'/NULL visible to all org members, so the bypass bites only private/hidden docs and requires the attacker to already know the document UUID.

**Mechanism.** document_shares carries a single `FOR ALL` policy whose USING and WITH CHECK are both just active-org-membership — no check that the caller can actually read the target document, and no controller restriction. The UI matches: the Share button at InspectorPanel.tsx:576 `onClick={() => setShareOpen(true)}` sits inside the Distribution section with no `isController`/`canManage` guard (contrast the Delete button at :961 gated on isController), and DURATION_OPTIONS offers `{ label: "Never expires", days: 0 }`, which lib/documentShares.ts:41-45 maps to `expires_at = null`. Resolution then runs with the service role — `createClient(supabaseUrl, serviceRoleKey, …)` in both /api/share/resolve and /api/share/file — which bypasses the RESTRICTIVE ACL SELECT policies that 20260708_acl_rls_enforcement.sql added precisely so that "a direct API/DB call" could not read a private document. Neither route checks documents.visibility, acl_index, status, or holds. lib/documentShares.ts imports no audit helper; no audit_logs row is written on create or revoke.

**Failure scenario.** A member with a Viewer role opens any drawing and clicks Share → "Never expires" → copy link. That URL now serves the document's current published revision, forever, to anyone on the internet who has the string, with no expiry sweep (no cron touches document_shares) and no org-wide review surface (listShareLinks is per-document and called only from ShareLinkModal.tsx:51, so nobody can enumerate live public links). Worse, the INSERT check never consults document visibility: a member who cannot SELECT a 'private' document under the ACL policy can still insert a document_shares row naming its UUID — and org-wide-readable tables hand out document UUIDs freely (distribution_acks_org_select exposes document_id to every active member; download_audits_org_access likewise) — then read the file through /share/<token>, which runs as service role.

**Evidence.**

```
20260623_document_shares.sql:38-54 the single FOR ALL policy quoted; InspectorPanel.tsx:575-581 the ungated Share button; ShareLinkModal.tsx:32 `{ label: "Never expires", days: 0 }` and lib/documentShares.ts:43-44 `: input.expiresInDays === 0 ? null`; app/api/share/resolve/route.ts:30 and app/api/share/file/route.ts:40 both constructing a service-role client; 20260708_acl_rls_enforcement.sql:4-6 stating the ACL exists to stop exactly this; lib/documentShares.ts read in full — no logAuditAction/audit_logs reference (grep returned exit 1).
```

**Chain reaction.** /api/share/resolve also applies no status filter (route.ts:43-48 selects the document by id only), so the same permanent link keeps serving after the document is Voided, Superseded or Archived — the retired-drawing recall gap again, this time pointed at an outside party.

> **Verifier correction.** The ACL-bypass half is weaker than CONFIRMED: the RLS policy permits a Viewer to INSERT a share row naming any document_id, but nothing in the repo shows a Viewer obtaining the UUID of a document the RESTRICTIVE SELECT policies hide from them — that step needs a direct API call with an id learned elsewhere. Treat 'any active member incl. Viewer can mint a never-expiring, unaudited public link to any document they can see' as CONFIRMED and 'bypasses the ACL for documents they cannot see' as SUSPECTED.

**Done when.**

- [ ] document_shares INSERT is restricted to principals who can actually read the document (an ACL/visibility check in the policy, plus a role gate on the Share button) and "Never expires" is controller-only or removed
- [ ] /api/share/resolve and /api/share/file refuse to serve a document whose status is in NOT_CURRENT_STATUSES, and honour visibility/acl_index despite running as service role
- [ ] creating and revoking a share writes an audit_logs row, and an org-level surface lists every live public link

---

<a id="dist-7"></a>

## DIST-7 · Share-link downloads are never written to download_audits: the insert names a `source` column that does not exist, and the error is discarded
- **Also surfaced independently as** [`SHR-5`](../public-surfaces/02-share-links.md#shr-5) — two areas found this separately. Fix once.

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/share/file/route.ts:129-141`, `supabase/schema.sql:788-799`, `app/share/[token]/page.tsx:140-142`, `app/api/share/file/route.ts:14-16`, `lib/staleCopies.ts:125-140`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. PostgREST rejects the unknown column, and the call is `await sb.from(...).insert(...)` inside `try { } catch { /* pre-migration column drift — never block the share */ }` — supabase-js returns the error rather than throwing, so the catch never even runs and the discarded `{ error }` is never inspected. Every share download therefore writes zero rows, and lib/staleCopies.ts:132-140 getDocumentRecall reads download_audits exclusively, so outside holders are invisible to recall.

**Mechanism.** The route inserts `{ org_id, document_id, version_id, user_id, user_email, created_at, expires_at, watermark_policy_id, source: stamped ? "share_link" : "share_link_unstamped" }`. The download_audits table is `CREATE TABLE IF NOT EXISTS download_audits (id, org_id, document_id, version_id, user_id, user_email, created_at, expires_at, watermark_policy_id)` — there is no `source` column, and no migration adds one (grep for `download_audits` across supabase/ returns only schema.sql:789/1022/1090; grep for `ALTER TABLE download_audits` returns only the ENABLE ROW LEVEL SECURITY line). PostgREST rejects the whole insert with PGRST204 ("Could not find the 'source' column … in the schema cache"). supabase-js resolves with `{ error }` instead of throwing, so the wrapping `try { await sb.from("download_audits").insert({…}); } catch { /* pre-migration column drift — never block the share */ }` never runs its catch and the result is discarded unread. Every external download fails to record, silently.

**Failure scenario.** A drawing is shared to a vendor. They pull it four times over a month. download_audits gains zero rows. getDocumentRecall (lib/staleCopies.ts:125-180) — which is built entirely on download_audits — has no idea a copy left the building, so "Copies in circulation" shows only internal staff and a recall nudge reaches nobody outside. When the rev advances, the vendor holds a stale stamped PDF with no channel back to them. Two statements in the codebase become false at the same time: the route's own header "The download_audits row is written HERE (an actual download)" and the public landing page's "Access counted on the distribution record" (app/share/[token]/page.tsx:141).

**Evidence.**

```
app/api/share/file/route.ts:130-140 quoted (the `source:` key at :139); supabase/schema.sql:789-798 full column list quoted, no `source`; the only other `source` in schema.sql is at :1247 on an unrelated table (`CHECK (source IN ('viewer','download','print','checkout',…))`); the catch block at app/api/share/file/route.ts:141 cannot fire because supabase-js does not reject on a PostgREST error.
```

**Chain reaction.** Even once the column exists, the row is written with `user_id: (share.created_by as string | null)` — the outsider is recorded as the internal sharer. getDocumentRecall groups by user_id, so the vendor's pull would appear as the sharer holding a copy, and the actual external recipient would still be unrecallable. Fixing the column alone reintroduces the attribution bug.

**Done when.**

- [ ] either the `source` column is added to download_audits or the key is dropped from the insert payload — and the insert's `{ error }` is checked and logged rather than relying on an unreachable catch
- [ ] external share downloads are attributed to the share (share_id / token) rather than to created_by, so recall can distinguish an outside holder from the internal sharer
- [ ] the /share page's "Access counted on the distribution record" claim is either made true or removed

---

<a id="dist-8"></a>

## DIST-8 · The "nobody signs for anyone else" fix on document_acknowledgments is one-sided: its WITH CHECK lets an assignee self-waive or hand the obligation to someone else

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260828_integrity_hardening.sql:264-277`, `lib/acknowledgments.ts:478-490`, `components/documents/AckSection.tsx:98-104`, `lib/acknowledgments.ts:142-214`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the downstream consequences check out: lib/acknowledgments.ts:172 `else if (st === "waived") { s.waived++; }` increments neither required nor pending, so ackStatusFor (:216) returns "complete" once the last pending row self-waives; and lib/downloads.ts:203-206 assertAckGate matches only `.eq("status", "pending")`, so a waived row walks through the hard gate. The legitimate path (waiveAcknowledgment, lib/acknowledgments.ts:478-490) writes waived_by/waived_reason and logs ACK_WAIVED, none of which the WITH CHECK requires. Note DRLS-1 makes this moot in the deployed state — the surviving document_acknowledgments_member_all policy grants the write outright.

**Mechanism.** doc_ack_update restricts the PRE-image correctly — `USING (… active member … AND (assignee_user_id = auth.uid() OR … role IN ('Admin','DocCtrl') OR … user_is_effective_owner(…)))` — but its POST-image check is only `WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id AND uid = auth.uid() AND status = 'active'))`. In Postgres an UPDATE must satisfy USING on the old row and WITH CHECK on the new row; here the new row is unconstrained beyond org membership. An assignee therefore passes USING on their own row and may write any column: `status = 'waived'` (self-excusal), or `assignee_user_id = <someone else>` together with `status = 'acknowledged'`. The application half is gated only in the UI — waiveAcknowledgment (lib/acknowledgments.ts:478-490) issues a bare `.update({ status: "waived", waived_by, waived_reason }).eq("id", input.rosterId)` and the only thing stopping an assignee calling it is the `canManage` prop on the waive button (AckSection.tsx:221).

**Failure scenario.** An operator is on the roster for a hard-gated SOP revision and is blocked from downloading it (lib/downloads.ts:198-210 assertAckGate). Rather than read it, they PATCH their own document_acknowledgments row to status='waived'. getAckSummaries (lib/acknowledgments.ts:170-175) counts waived rows into `s.waived` and NOT into `s.required`, so the pill goes to "complete", maybeNotifyComplete fires "Fully acknowledged — Everyone assigned has read & understood this revision" to the owner, and the acknowledgment report handed to an ISO/PSM auditor prints them under "Waived" as though a controller had excused them. The download gate opens. Alternatively they set assignee_user_id to a colleague and status='acknowledged', transferring their training obligation onto a person who was never notified.

**Evidence.**

```
20260828_integrity_hardening.sql:264-277 quoted in full — USING carries the own-row predicate, WITH CHECK does not; lib/acknowledgments.ts:482-484 the update with no actor/role predicate; components/documents/AckSection.tsx:218-222 shows waive is UI-gated on canManage only; lib/acknowledgments.ts:173 `else if (st === "waived") { s.waived++; }` — waived never increments `required`, so ackStatusFor (:217-225) returns "complete".
```

**Chain reaction.** The same one-sided pattern appears on doc_review_signoff_update in the same migration; and because waiveAcknowledgment calls maybeNotifyComplete(orgId, documentId, null, …) with a NULL versionId (lib/acknowledgments.ts:489), the completeness count it triggers spans every revision of the document rather than the current one.

> **Verifier correction.** Cite supabase/migrations/20260830_publisher_row_management.sql:54-71, not 20260828_integrity_hardening.sql:264-277 — the later migration drops and recreates doc_ack_update, and the org-membership-only WITH CHECK is what is actually live.

**Done when.**

- [ ] doc_ack_update's WITH CHECK repeats the USING predicate (own row, or controller, or effective owner) so the post-image cannot escape the writer's authority
- [ ] status='waived' is writable only by a controller or effective owner, at the policy layer and not only in the UI
- [ ] assignee_user_id, document_version_id and org_id are immutable after insert (a trigger or a column-level check), so an obligation cannot be re-pointed

---

<a id="dist-9"></a>

## DIST-9 · download_audits — the sole evidence base for stale-copy recall — is fully mutable and deletable by any active org member

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1089-1091`, `supabase/schema.sql:1031-1034`, `lib/staleCopies.ts:33-113`, `lib/staleCopies.ts:125-180`, `lib/downloads.ts:123-146`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. Contrast the sibling three lines above it, supabase/schema.sql:1086-1087, where audit_logs gets a separate `audit_logs_insert ... WITH CHECK (user_id = auth.uid())`; download_audits got no such treatment. Since lib/staleCopies.ts:33-113 and :125-180 derive both the personal stale-copy list and the per-document recall roster entirely from this table, a self-targeted DELETE erases the holder from the recall evidence base with no trace.

**Mechanism.** `CREATE POLICY "download_audits_org_access" ON download_audits FOR ALL USING (org_id IN (SELECT my_org_ids()));` — a FOR ALL policy with USING and no WITH CHECK, exactly the shape the earlier audits found on tickets, notifications, email_notifications and project_documents. FOR ALL covers DELETE and UPDATE; the USING clause is nothing but active org membership (`my_org_ids()` = `SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'`), and with no WITH CHECK the same expression is reused for the INSERT/UPDATE post-image. There is no self-row restriction, no controller restriction, and no append-only trigger. Both recall reads — listMyStaleCopies and getDocumentRecall — are built entirely on this table.

**Failure scenario.** Someone downloads a drawing, works from it, and later wants no record that they held that revision. They issue DELETE /rest/v1/download_audits?document_id=eq.<doc>&user_id=eq.<self>. They vanish from "Copies in circulation" in the inspector, from the recall nudge list (nudgeStaleHolders filters `holders` derived from that table), and from their own "my outdated copies" view. More broadly, any member can delete the org's entire distribution history for a document before an audit, and the deletion itself leaves no trace: lib/downloads.ts:131-145 writes these rows with `await supabase.from("download_audits").insert({…})` inside a try/catch that supabase-js never triggers, so even write failures are invisible.

**Evidence.**

```
supabase/schema.sql:1090-1091 quoted verbatim (FOR ALL, USING only); schema.sql:1031-1034 the my_org_ids() body; lib/staleCopies.ts:39-47 and :132-139 both querying download_audits as the only source; lib/downloads.ts:132-145 the unchecked insert whose `console.error` at :144 is unreachable because supabase-js resolves rather than rejects on a PostgREST error.
```

**Chain reaction.** Because the same table is the input to DistributionRecall's "all N current" green badge, a member who deletes their rows does not merely disappear — the panel actively asserts everyone is current.

**Done when.**

- [ ] download_audits carries separate policies: SELECT for org members, INSERT for the acting user's own rows, and no UPDATE or DELETE for anyone (or DELETE restricted to a retention job)
- [ ] lib/downloads.ts logDownloadAudit destructures and checks `{ error }` instead of relying on a catch that cannot fire
- [ ] a distribution record that cannot be produced is surfaced as a gap rather than as an empty, confident-looking recall list

---

<a id="dist-10"></a>

## DIST-10 · A recall leaves no record: no audit row, no recall entity, no acknowledgment — "Recall sent to N people" is component state that evaporates on reopen

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/staleCopies.ts:182-209`, `components/documents/DistributionRecall.tsx:28-43`, `components/documents/DistributionRecall.tsx:102-117`, `lib/distributionAcks.ts:306-333`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the count is pure component state and is cleared on every remount/document switch, and no persistent recall entity is created. One softening: emit() does leave rows in `notifications` carrying `metadata: { recall: true }` (lib/staleCopies.ts:206) plus resource id, so a forensic query against that table can partially reconstruct who was pinged and when — "the system can answer none of it" overstates slightly. There is still no acknowledgment of destruction and no recall record proper, so MEDIUM stands.

**Mechanism.** nudgeStaleHolders builds an emit() payload and returns `outdated.length`. It writes nothing durable: lib/staleCopies.ts imports only `supabase` and `emit` — grep for logAuditAction / audit_logs across staleCopies.ts, distributionAcks.ts and documentShares.ts returns nothing (exit 1). There is no recalls table, no recalled_at column, and no per-holder acknowledgment of the recall (distribution_acks is a separate, manually-driven flow that recall does not touch). The only feedback is `nudgedCount` in React state, and the panel's effect resets it on every document/version change: `setHolders([]); setNudgedCount(null); setOpen(false);` (DistributionRecall.tsx:36-38). Closing and reopening the inspector restores the un-nudged button as if the recall never happened.

**Failure scenario.** Doc Control recalls outdated copies of a P&ID after a Rev 5 that moved a relief valve. Three months later an incident investigation asks: when was the recall issued, who was on the list, who confirmed they destroyed their print? The system can answer none of it. The bell notifications may have been read and cleared; audit_logs has no entry; nothing distinguishes "we recalled it and eight people confirmed" from "nobody ever clicked the button". A second controller looking at the same document sees the un-nudged button and either re-sends (noise) or assumes it was handled (silence).

**Evidence.**

```
lib/staleCopies.ts:182-209 read in full — emit() then `return outdated.length`, no persistence; DistributionRecall.tsx:36-38 the reset; DistributionRecall.tsx:103-106 renders "Recall sent to {nudgedCount} people" purely from that state; grep for logAuditAction|audit_logs over the three lib files returned exit 1.
```

**Chain reaction.** Contrast the acknowledged-distribution flow immediately above it in the same inspector section, which does persist one row per (version, recipient) and can answer "8 of 12 confirmed". Recall — the more safety-critical of the two, since it targets copies already in the field — has no equivalent, so the two halves of the Distribution panel offer wildly different evidentiary weight while looking alike.

> **Verifier correction.** 'No record' is overstated. emit() drives the in-app channel through notifyMany → notify (lib/notify/dispatch.ts:89-103, lib/inAppNotifications.ts:104-129), so each recalled holder gets a durable notifications row carrying metadata {recall:true} (lib/staleCopies.ts:206). What is genuinely missing is an audit_logs entry, a recall entity/timestamp on the document, and any per-holder acknowledgment of the recall — plus the UI amnesia. Scope the finding to those.

**Done when.**

- [ ] issuing a recall writes an audit_logs row (actor, document, version, recipient list, timestamp) at minimum
- [ ] a recall creates per-holder rows that can be acknowledged ("old print destroyed"), so a recall can be closed out rather than only sent
- [ ] the panel renders recall state from the database, so a second controller sees that a recall is already outstanding

---

<a id="dist-11"></a>

## DIST-11 · Distribution recall silently truncates at 400 download rows / 60 days, in a component whose sibling pill honestly flags its own cap

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/staleCopies.ts:19-20`, `lib/staleCopies.ts:131-141`, `lib/staleCopies.ts:38-48`, `components/documents/InspectorPanel.tsx:186-190`, `components/documents/DistributionRecall.tsx:72-80`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — both caps are silent and the component has no way to know it was truncated. Precision note: because the query is `created_at DESC LIMIT 400`, the 70-day-old downloader in the scenario is dropped by the 60-day window (:130), not by the row cap; the row cap independently drops earlier holders once a doc exceeds 400 pulls in 60 days. Both truncations are real and neither is surfaced.

**Mechanism.** getDocumentRecall reads `.gt("created_at", since).order("created_at", { ascending: false }).limit(400)` with RECALL_WINDOW_DAYS = 60, no pagination and no truncation flag; listMyStaleCopies does the same with limit(300). Holders whose only pull falls outside the newest 400 rows, or outside 60 days, are absent from `holders` — and therefore absent from both the badge and from `nudgeStaleHolders`, which recalls only `input.holders.filter((h) => !h.hasCurrent)`. The same file that mounts this panel gets the honesty right one screen earlier: "listTransmittalsForDocument caps at 50 rows — an honest pill says so" (InspectorPanel.tsx:188), which sets `issuedCapped` and renders a trailing "+".

**Failure scenario.** A heavily used general-arrangement drawing is downloaded hundreds of times during a turnaround. The panel reads "3 of 12 outdated" — 12 being the distinct users inside the truncated 400-row slice — and the controller clicks recall, believing everyone is covered. Field personnel whose download was 70 days ago, or buried under the turnaround's download volume, are neither counted nor notified, and nothing in the UI hints that the list is partial. A 61-day-old print is exactly the print most likely to be stale.

**Evidence.**

```
lib/staleCopies.ts:20 `const RECALL_WINDOW_DAYS = 60;`, :139 `.limit(400)`, :47 `.limit(300)` — none returns a capped indicator; lib/staleCopies.ts:193 `const outdated = input.holders.filter((h) => !h.hasCurrent);` confirming the nudge inherits the truncation; InspectorPanel.tsx:188-190 the in-repo counterexample.
```

**Done when.**

- [ ] getDocumentRecall returns a `capped` flag and DistributionRecall renders it the way the transmittal pill does
- [ ] the recall nudge resolves its recipient set server-side over the full history rather than over whatever the UI managed to page in
- [ ] RECALL_WINDOW_DAYS is justified against how long a print actually lives in the plant, or removed for the per-document recall view

---

<a id="dist-12"></a>

## DIST-12 · Re-requesting confirmations resets every recipient's overdue clock, and the request/acknowledge/remind handlers swallow their errors

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/distributionAcks.ts:112-133`, `lib/distributionAcks.ts:202-216`, `components/documents/DistributionAcks.tsx:83-124`, `components/documents/DistributionAcks.tsx:143,208,218`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. openPicker (:70-79) loads all active members minus self and does not exclude people who already have an outstanding row, so re-ticking the same names is the frictionless path; each `void handleX()` rejection becomes an unhandled promise rejection with no error state rendered anywhere in the component. Mild mitigation the finding does not mention: a separate "Remind the unconfirmed" button exists (:216-222) and calls renudgeUnacked, which does NOT touch requested_at — so the destructive path is reachable but not the only one.

**Mechanism.** requestAcks builds rows containing `requested_at: now` and upserts with `{ onConflict: "version_id,recipient_user_id", ignoreDuplicates: false }`, i.e. ON CONFLICT DO UPDATE across every supplied column — so an existing outstanding row has its requested_at rewritten to now. scanDistributionAcks measures both the nag cutoff and the escalation age from that same column (`.lt("requested_at", nagCutoff)` and `const ageDays = (Date.now() - Date.parse(r.requested_at as string)) / 86_400_000; if (ageDays >= escalateAfterDays …)`). Separately, the three UI handlers wrap their calls in `try { … } finally { … }` with no catch and are invoked as `onClick={() => void handleAcknowledge()}` / `void handleRequest()` / `void handleRemind()`; requestAcks and acknowledge both `throw new Error(error.message)` on failure, so a rejected write becomes an unhandled promise rejection — the spinner stops, the panel is unchanged, and the user is told nothing.

**Failure scenario.** Someone has ignored a Rev 5 confirmation for 25 days and is one scan away from escalating to the requester. A controller opens the picker, ticks the same names to "remind" them (the natural reading of "Request confirmations…"), and the upsert rewrites requested_at to today. The 10-day escalation clock restarts from zero; the requester is never told this person has gone quiet. Meanwhile, if the write itself is rejected — pre-migration schema, RLS, network — handleAcknowledge's `await acknowledge(myPending.id)` throws, `load()` never runs, the confirm bar stays exactly as it was, and the recipient reasonably concludes their tap registered.

**Evidence.**

```
lib/distributionAcks.ts:113-126 the row build with `requested_at: now` and the upsert options; :216 `.lt("requested_at", nagCutoff)`; :273-274 `const ageDays = (Date.now() - Date.parse(r.requested_at as string)) / 86_400_000; if (ageDays >= escalateAfterDays && r.requested_by)`; DistributionAcks.tsx:102-111 handleAcknowledge with try/finally and no catch; :143 `onClick={() => void handleAcknowledge()}`; lib/distributionAcks.ts:192 `if (error) throw new Error(error.message);`.
```

**Chain reaction.** renudgeUnacked (:306-333) is the correct primitive — it only emits and touches no rows — but the picker path is the more discoverable one in the UI, so the reminder a controller is most likely to click is the one that erases the overdue evidence.

> **Verifier correction.** 'Every recipient' is too broad. Rows are built only from input.recipients (lib/distributionAcks.ts:113), so only members the controller re-selects in the picker have requested_at rewritten; the 'Remind the unconfirmed' path goes through renudgeUnacked (:306-333), which emits a notification and never touches the column. Also note acknowledged_at is absent from the upsert payload, so an existing confirmation is not erased — the defect is confined to resetting the nag/escalation clock for re-selected recipients.

**Done when.**

- [ ] requestAcks does not overwrite requested_at for a row that already exists and is still outstanding (or the overdue clock reads from a separate first_requested_at)
- [ ] the DistributionAcks handlers catch and surface write failures instead of leaving a silent no-op behind a stopped spinner
- [ ] the picker distinguishes "add recipients" from "remind existing recipients"

---

<a id="dist-13"></a>

## DIST-13 · The stale-copy recall email is classified as a ticket status change and is dropped for anyone who turned those emails off

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/staleCopies.ts:195-207`, `lib/notify/dispatch.ts:49-58`, `lib/notifications.ts:149-166`, `lib/distributionAcks.ts:135-147`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed end to end: the stale-copy recall email is gated by the ticket-status-change preference, so anyone who muted ticket churn silently loses the recall email and is left with only a bell badge. The contrast cited is also accurate — lib/distributionAcks.ts:136 uses `category: "assignment"`, which maps to email_on_assignment, a toggle a field user is far less likely to have disabled.

**Mechanism.** nudgeStaleHolders emits with `category: "status"`. dispatch maps that to an eventType: `case "status": return "ticket_status_changed";` (lib/notify/dispatch.ts:53). queueEmail then gates on the recipient's preference row: `case "ticket_status_changed": case "ticket_approved": case "ticket_revision_requested": case "ticket_closed": return prefs.email_on_status_change !== false;` (lib/notifications.ts:158-161). A user who has turned off ticket-status emails — a plausible setting for a field operator who does not work tickets — silently receives no recall email. Only the in-app bell survives, and only if they open the app. (The acknowledged-distribution request, by contrast, uses `category: "assignment"` at lib/distributionAcks.ts:137, which maps to the assignment preference.)

**Failure scenario.** An operator disabled ticket-status emails months ago because ticket churn was noisy. A P&ID revs; a controller clicks "Recall outdated copies — notify 6 people". Five get the email; the operator gets only a bell badge they never open, because they primarily work from printed packs. The message they miss is "Your copy of P-101 is out of date… re-download before doing any work from it, and destroy old prints" — routed through the same preference toggle as "ticket moved to In Review".

**Evidence.**

```
lib/staleCopies.ts:197 `category: "status"`; lib/notify/dispatch.ts:53 the mapping; lib/notifications.ts:158-161 the preference test; lib/notify/dispatch.ts:106-127 shows email is the only other channel emit() drives.
```

**Done when.**

- [ ] a safety recall uses a category that is not user-suppressible under a ticket-noise preference (its own category, or 'sla'), or bypasses the preference check the way the external-party sender does
- [ ] the preference UI names what each toggle actually suppresses, so nobody unknowingly mutes drawing recalls

---

<a id="dist-14"></a>

## DIST-14 · bump_share_access and revup_rollback_orphan are SECURITY DEFINER with no SET search_path, against the documented house pattern

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260818_followups_rls.sql:95-102`, `supabase/migrations/20260818_followups_rls.sql:107-117`, `app/api/share/resolve/route.ts:83`, `supabase/migrations/20261013_project_controls_program.sql:56-58`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The code facts are exactly as stated, but the severity is inflated on two counts. (1) Exploitation needs a principal who can CREATE objects in a schema ahead of public on their own search_path; Supabase's `authenticated`/`anon` roles have no CREATE right on public and cannot create schemas, so there is no in-product attacker. (2) The 'against the documented house pattern' framing implies these two are outliers — `grep -rn 'SECURITY DEFINER' supabase/migrations/*.sql | grep -v search_path` returns 42 definitions, so unpinned is in fact the majority convention. Neither function makes an authorization decision from the unqualified table (one increments a counter, one deletes a version row), so a shadowed table yields no privilege escalation. Real hardening debt, LOW.

**Mechanism.** `CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE document_shares SET access_count = COALESCE(access_count, 0) + 1, access_last_at = now() WHERE id = p_share; $$;` — no `SET search_path`. The same migration's revup_rollback_orphan (which DELETEs from document_versions and clears superseded_at) has the same omission. The repo's convention is explicit elsewhere: 20261013_project_controls_program.sql:56-58 comments "search_path pinned per the house SECURITY DEFINER pattern" and writes `SECURITY DEFINER SET search_path = public`; the same pinning appears in 20260901_db_hard_enforcement.sql, 20260812_per_library_publish_authority.sql, 20260913_projects_rls_recursion_fix.sql and a dozen others. No later migration issues an ALTER FUNCTION to repair these two (grep for `ALTER FUNCTION` across supabase/ returns nothing).

**Failure scenario.** An unqualified reference inside a definer-rights function resolves against the caller's search_path. Any principal able to create objects in a schema that precedes public on their search_path can shadow `document_shares` (or, for revup_rollback_orphan, `document_versions`) and have the function operate on their object with the definer's privileges. bump_share_access is on the unauthenticated share path (`await sb.rpc("bump_share_access", { p_share: share.id })`), and revup_rollback_orphan exists specifically to bypass the controller-only delete policy on document_versions — so the second one is a definer-rights DELETE against the revision chain.

**Evidence.**

```
20260818_followups_rls.sql:95-96 and :107-108 quoted, neither carrying SET search_path; 20261013_project_controls_program.sql:56-58 establishing the convention in words and code; `grep -rn "ALTER FUNCTION" supabase/` returns no rows, so nothing repairs them post hoc.
```

**Chain reaction.** This is the same SECURITY-DEFINER-without-search_path pattern the earlier audits recorded; it recurs here on the two functions that sit closest to document control's external surface (public share access and revision-chain rollback).

**Done when.**

- [ ] both functions are recreated with `SECURITY DEFINER SET search_path = public` (or `public, pg_catalog`, matching the storage-stats functions)
- [ ] a check in CI or the schema-expectations module flags any SECURITY DEFINER function lacking a pinned search_path

---
