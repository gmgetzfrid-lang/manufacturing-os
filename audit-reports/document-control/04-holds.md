# 04 · Holds & stop-work

**14 findings** — 6 HIGH · 8 MEDIUM.

Whether a hold blocks every path or only the ones somebody remembered.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The two-layer publish guard: a pure, exhaustively unit-tested decision function plus a Postgres trigger that re-checks it | `lib/documentGuards.ts:109-151, lib/__tests__/documentGuards.test.ts:128-167, supabase/migrations/20260822_review_completion_guard.sql:77-86` | This is the one place holds are genuinely hard-enforced, and the split it encodes is correct and deliberate: `canForceLock` admits a per-library publisher's override-with-reason, `canForceHold = forcing && isController` does not — "an override-with-reason must never jump a safety hold". The DB trigger backstops it for direct PostgREST writes. Every fix above should extend this model, not replace it. |
| publish_revision's transactional re-check of the hold under a row lock, with p_force and p_override_lock deliberately unconflated | `supabase/migrations/20260828_integrity_hardening.sql:93-110` | The RPC serialises on `SELECT * FROM documents WHERE id = p_doc FOR UPDATE` and re-evaluates the hold inside that lock, closing the check-then-act race the app layer alone would leave open. The migration header documents why p_override_lock was split out — it exists precisely because the old conflation let a checkout override bypass a hold. Do not re-merge those parameters. |
| The three public verify surfaces and the printed artifacts that feed them | `app/verify/[docId]/page.tsx, app/verify-hold/[holdId]/page.tsx, app/verify-package/…, lib/physicalBridge.ts` | The pattern — unauthenticated, UUID-keyed, minimal-facts, one unmissable colour — is the right answer for a plant floor and the /verify-hold page in particular gets the failure mode right ("Treat the hold as ACTIVE until Document Control confirms otherwise" on error, app/verify-hold/[holdId]/page.tsx:67-69). The fix for the hold-blindness is to teach /api/verify and /api/verify-package about holds, not to change this architecture. |
| Multiple simultaneous holds per document, enforced by a partial unique index on the open ones | `supabase/migrations/20260612_phase5_holds.sql:60-62, lib/holds.ts:129-137` | `document_holds_open_reason_uniq ON document_holds(document_id, reason) WHERE released_at IS NULL` lets "Awaiting Engineering" and "Missing Vendor Data" coexist while preventing a duplicate of either, and openHold translates the 23505 into a readable message. The log-not-flag shape is what makes duration metrics and history possible; keep it. |
| releaseHold's double-release guard | `lib/holds.ts:180-193` | `.eq("id", input.holdId).is("released_at", null).select("*").single()` makes a concurrent second release fail loudly rather than silently overwrite the first releaser's identity and timestamp. This is the correct compare-and-swap shape and should be preserved by any trigger added on top of it. |
| The legal-hold DELETE triggers, which apply to service-role and cascades alike | `supabase/migrations/20260826_legal_hold_delete_guard.sql:11-13, 29-56` | "Applies to EVERYONE (including service-role scripts) … Note this also blocks cascading deletes that would remove a held document (e.g. deleting its org) — intentionally." Guarding document_versions as well as documents closes the app's delete-versions-first path. The only thing missing is that nothing verifies the legal_hold flag was actually set (see the retention finding). |
| Capability policy read by Postgres, so hold authority is enforced at the database rather than only in the client | `supabase/migrations/20260901_db_hard_enforcement.sql:28-105` | org_capability_allows() reads role tokens, additive roles[] and per-person grants with expiry, and the holds INSERT/UPDATE policies call it — this is the correct enforcement location and it pins search_path. The defect is not the mechanism but the shipped default and the unconstrained column surface it gates. |


---


<a id="hld-1"></a>

## HLD-1 · A hold is a hard block only on "advance" transitions; download, transmittal, distribution-ack, share link, checkout, revision-label correction, renumber and disposal all proceed unguarded

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260822_review_completion_guard.sql:36-40`, `supabase/migrations/20260822_review_completion_guard.sql:77-86`, `lib/documentGuards.ts:138-148`, `lib/revisions.ts:1051-1118`, `lib/retention.ts:151-158`, `lib/downloads.ts`, `lib/transmittals.ts`, `lib/distributionAcks.ts`, `lib/documentShares.ts`, `lib/documentLifecycle/renumber.ts`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The absence claim checks out repo-wide: a case-insensitive grep for 'hold' across lib/transmittals.ts, lib/distributionAcks.ts, lib/documentShares.ts and lib/documentLifecycle/renumber.ts returns ZERO hits, and lib/downloads.ts's only hits are about the checkout holder, not document_holds. Worse than stated: even on an advancing update the DB trigger returns NEW for Admin/DocCtrl (lines 60-63) before reaching the hold check, so controllers are unblocked there too.

**Mechanism.** Both enforcement layers scope the hold check to publishing a new canonical revision. The DB trigger computes `v_advancing := (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id) OR (NEW.status = 'Superseded' AND COALESCE(OLD.status,'') <> 'Superseded'); IF NOT v_advancing THEN RETURN NEW; END IF;` (20260822:36-40) and only then reaches the `document_holds … released_at IS NULL` test. `evaluatePublishGuard` is only ever reached from `authorizePublish` in the rev-up / revert / supersede paths. Everything else that puts a held drawing in front of a human is untouched: `grep -rn "document_holds" --include='*.ts' --include='*.tsx'` returns zero hits in lib/downloads.ts, lib/docPack.ts, lib/transmittals.ts, lib/acknowledgments.ts, lib/distributionAcks.ts, lib/documentShares.ts, lib/checkoutEpisodes.ts and lib/documentLifecycle/renumber.ts; a second per-file `grep -n "hold|Hold"` over those files returns only unrelated words ("holder", "holding"). Two concrete state-changing paths are worth naming: `correctRevisionLabel` rewrites `document_versions.revision_label` and then `documents.rev`/`documents.revision` (revisions.ts:1099-1111) with an authority check but no hold check, and it slips the DB trigger because it never touches `current_version_id`; `disposeDocument` checks `isLegalHold` and nothing else before setting `status: "Archived", disposition_state: "disposed"` (retention.ts:153-156), and status→Archived is not an "advance" transition either.

**Failure scenario.** An MOC-driven "Client Review" hold sits on a piping isometric. During the hold: a contractor is sent a transmittal containing it, twelve people are assigned a read-and-understood acknowledgment against it and all sign, a public share link is issued, its revision label is corrected from 3 to 3A (changing what the register, the inspector and every hold card display), and — once the retention clock expires — it is disposed and archived. The /admin/holds queue still shows the hold open the entire time, pointing at a document that is now Archived. Nothing in any of those flows mentioned the hold.

**Evidence.**

```
supabase/migrations/20260822_review_completion_guard.sql:36-40 — `v_advancing := (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id) OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded'); IF NOT v_advancing THEN RETURN NEW; END IF;`  •  lib/revisions.ts:1099-1103 — `const { error: upErr } = await supabase.from("document_versions").update({ revision_label: check.label }).eq("id", versionId);`  •  lib/retention.ts:153 — `if (await isLegalHold(input.documentId)) return { ok: false, reason: "legal_hold" };` (no document_holds check)  •  lib/documentGuards.ts:6-7 comment — "historically locks and holds were advisory … This module turns those invariants into enforced rules."
```

**Done when.**

- [ ] A single `assertNotOnHold(documentId)` helper exists and is called by correctRevisionLabel, renumberDocument, disposeDocument, transmittal issue, distribution-ack assignment and share-link creation
- [ ] Download and doc-pack paths either refuse or stamp a HOLD banner rather than proceeding silently
- [ ] The DB trigger's advance test is widened, or a second trigger added, so that status→Archived and revision_label rewrites on a held document are refused for non-controllers

**Partial (2026-09-23, Round F).** P5 HOLDS. Reproduced on `ba7bfcb`: `grep -n "document_holds\|holdGate" lib/distributionAcks.ts lib/transmittals.ts lib/documentShares.ts lib/documentLifecycle/renumber.ts lib/retention.ts` returned nothing, and `correctRevisionLabel` (lib/revisions.ts:1101-1121) rewrote `document_versions.revision_label` and then `documents.rev` / `documents.revision` with `current_version_id` untouched, so the publish guard's advance test never saw it. Landed here — the shared helper, this package's own call site, and the database half:
- **`lib/holdGate.ts` (new) — THE gate every other door calls.** `assertNotOnHold(documentId, { client?, action? })` reads the unreleased holds once (any `.from()` client: a route's service-role client, the shared browser client by default), decides through the pure `decideHoldGate`, and throws `HoldBlockedError` (`code: "on_hold"`, `.holds`, `.unreadable`) with one refusal sentence ("Document has an active hold (Client Review); release the hold before <action>."). **Fails closed:** an errored hold read is a hold — the `/verify-hold` and PKG-4 stance. `readActiveHolds` + `decideHoldGate` are exported for the download / doc-pack limbs that stamp a banner instead of refusing. No override parameter: the publish path's controller `canForceHold` stays the one deliberate rail.
- **Distribution-ack assignment** (`lib/distributionAcks.ts` `requestAcks`): refused on a held document before any row is written. The DIST-10 recall close-out (`notify: false`) proceeds — it is the record of a recall already sent to holders of an OUTDATED copy, not an assignment against the held revision.
- **Database half — migration `20261074_dc_roundF_held_document_label_rails.sql`.** status→Archived on a held document was already refused for a non-controller by 20261060 (→ Archived is advancing there; verified in the live body). The bare label rewrite was not: two small rails, `trg_document_hold_label_guard` (BEFORE UPDATE OF rev, revision ON documents — exempt when `current_version_id` moves, i.e. a publish-shaped write the publish guard governs) and `trg_version_hold_label_guard` (BEFORE UPDATE OF revision_label ON document_versions, keyed on the parent's hold), both controller- (`is_org_controller`) and service-role-exempt exactly as the publish guard is. Deliberately NOT a re-creation of `enforce_document_publish_guard` — P4 REVIEW extends that body this wave. Not a widening; inventory before apply: documents under an active hold.
- Tests: `lib/__tests__/holds.test.ts` — "HLD-1 — lib/holdGate.ts" (decide pass / block / unreadable-blocks; `assertNotOnHold` throws on a held document and on a read error, passes a clean one, takes an injected client, scopes the read to unreleased holds of the document; `requestAcks` refuses before any `distribution_acks` write, fails closed, the recall close-out proceeds, an un-held assignment is unchanged) and "20261074 — held-document label rails" (both rails' shape, the publish guard NOT re-created — its live probe is an ownership probe (the guard exists and neither rail's trigger is wired to it), never a text probe of a body P4's 20261070–72 re-create ahead of it in the paste — one-paste shape, the `correctRevisionLabel` path pinned). `lib/__tests__/requestAcksClock.test.ts` mock made table-aware (its world has no holds).

**Done-when.** (This package's limbs.) (1) the helper exists ✓ and is called by distribution-ack assignment ✓; `correctRevisionLabel` / `renumberDocument` → P3 LIFECYCLE (wave 2), `disposeDocument` → P9 RECORDS (this wave, dispose-gate limb), transmittal issue → P7 TRANSMITTALS (wave 2), share-link creation → P1 SHARE (wave 2) — each cross-references here; (2) download / doc-pack banner-or-refuse → P8 FIELD (wave 2, via `readActiveHolds` + `decideHoldGate`) — not done here; (3) status→Archived ✓ (20261060, live), revision-label rewrites ✓ (20261074, pending apply) — refused for non-controllers.
- **Pending migration:** `supabase/migrations/20261074_dc_roundF_held_document_label_rails.sql` (DEC-30 — the label rails do not exist until pasted).

**Scope / residual.** Stays OPEN until the wave-2 limbs land; the finding closes when P1 / P3 / P7 / P8 record their call sites against `lib/holdGate.ts`. A hold placed by a lifecycle copy (`copyActiveHoldsToDoc`) is HLD-2 / P3.

**Partial (2026-09-23, Round F — P9 RECORDS owns the dispose-gate limb only).** Reproduced: `disposeDocument` checked `isLegalHold` and nothing else (`lib/retention.ts:217`), and the 20261043 retention guard's `status → 'Archived'` refusal fired only under a LEGAL hold — a plain archive or disposal of a document with an open `document_holds` row reached the database unguarded. Landed: `disposeDocument` reads `listActiveHoldsForDocument` (the EXISTING `lib/holds.ts` helper — wave rule: `P5 HOLDS` owns the shared `assertNotOnHold`; wave 2 unifies this call onto `lib/holdGate.ts`) and returns `{ ok:false, reason:"active_hold" }` for EVERYONE without writing; the hold read fails closed (throws). `RetentionSection` says "This document has an open hold — release the hold first, then dispose." At the database, `supabase/migrations/20261077_dc_roundF_records_rails.sql` §1 extends the live `enforce_document_retention_guard` (20261043 body, lineDiff-pinned): the early return is widened so a plain `status → 'Archived'` reaches the check, and `disposition_state → 'disposed'` or `status → 'Archived'` on a document with an unreleased `document_holds` row is refused for a non-controller (`This document has an open hold and cannot be disposed or archived until it is released.`).
- Tests: `lib/__tests__/dcRoundFRecords.test.ts` — "refuses under an open hold — nothing written, nothing logged", "fails CLOSED when the hold read errors"; `lib/__tests__/dcRoundFMigration.test.ts` — "§1 … adds exactly the widened early return and the open-hold dispose gate".
- Files: `lib/retention.ts`, `components/documents/RetentionSection.tsx`; migration §1.
- Pending migration: `supabase/migrations/20261077_dc_roundF_records_rails.sql` (§1).

**Done-when (this limb).**
- ✓ `disposeDocument` refuses under an open hold. The single shared `assertNotOnHold` helper and its other call sites (`correctRevisionLabel`, `renumberDocument`, transmittal issue, distribution-ack assignment, share-link creation) are `P5`'s / the owning packages' — not done here.
- ✗ download and doc-pack paths — `P8 FIELD` / `P2 EGRESS`.
- ✓ / ✗ the DB trigger: `status → 'Archived'` on a held document is refused for non-controllers (20261077 §1, pending apply); the `revision_label` rewrite is `document_versions` territory — not done here.

**Scope / residual.** Stays OPEN for the remaining limbs. The app refuses controllers too (a hold is a hard block; release it first — the hold queue names it), the database refuses non-controllers as the done-when states.

*Integration note (2026-09-29): P5 and P9 landed in the same wave, so the dispose gate carries its own hold read; wave 2 (or the first package to touch `lib/retention.ts` next) re-points it at `lib/holdGate.ts assertNotOnHold` — recorded here so the helper stays THE gate.*

**Partial (2026-09-30, document-control Round F wave 2).** P3 LIFECYCLE — the two call sites in this package's scope (the plan's dependency note: "P5 HOLDS assertNotOnHold for correctRevisionLabel / renumber (HLD-1 call sites here)"). Reproduced on `a11e1e4`: `grep -n "holdGate\|assertNotOnHold" lib/revisions.ts lib/documentLifecycle/renumber.ts` returned nothing.
- `correctRevisionLabel` (`lib/revisions.ts`) calls `assertNotOnHold(doc.id, { action: "correcting its revision label" })` after its authority check and before any read or write; `renumberDocument` (`lib/documentLifecycle/renumber.ts` — outside this package's listed files, touched only for this one call, as the plan's dependency note directs) calls it with "renumbering it". Both fail closed on an unreadable hold set (the helper's rule) and refuse controllers too (a hold is released, not jumped — the app's stance; 20261074 refuses non-controllers at the database for the label).
- Split / merge over a held source run the full publish gate instead (`HLD-2`).
- **Archive** (`archiveDocument`, review fix for `REV-6`): its pre-gate calls `assertNotOnHold(doc.id, { action: "archiving it" })` for a non-controller before anything is written — mirroring the database's tiers (20261060 / 20261077 refuse a non-controller's archive under an open hold and let a controller through), so the app no longer voids an in-flight review on the way to a refused archive. Unlike the label / number doors, a controller is not refused here: the archive's database gate admits them, and refusing them in the app would remove a capability the review fix was not asked to remove.
- Tests: `lib/__tests__/dcRoundFLifecycle.test.ts` "HLD-1 — correctRevisionLabel and renumberDocument call the shared hold gate" (a held document's label and number are unchanged and the error is the helper's `HoldBlockedError`); "REV-6 — …" (a non-controller's archive under an open hold is a `HoldBlockedError` with nothing written; a controller's passes).

**Done-when (these limbs).** (1) `correctRevisionLabel` ✓, `renumberDocument` ✓ call the shared helper; transmittal issue (P7), share-link creation (P1 — landed in its wave-2 pass), the download / doc-pack banner (P8) and the dispose gate's re-point at `lib/holdGate.ts` (`lib/retention.ts`, P9's file) are the other owners'. (2), (3) unchanged by this pass.

**Scope / residual.** Stays OPEN until the remaining owners record their limbs.

---

<a id="hld-2"></a>

## HLD-2 · Split and merge supersede a held source without any hold check, then copy the holds to the new sheets on a best-effort, error-swallowing path that is outside the compensation register

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/documentLifecycle/split.ts:137-170`, `lib/documentLifecycle/merge.ts:191-224`, `lib/documentLifecycle/common.ts:253-280`, `lib/documentLifecycle/common.ts:319-377`, `lib/revisions.ts:1425-1428`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified: markSupersededAndLink (common.ts:253-280) only checks `updErr` on the status flip, never document_holds. One caveat worth recording — the DB trigger DOES catch this path for non-controllers (v_advancing is true when status becomes 'Superseded'), so the unguarded supersession is specific to Admin/DocCtrl actors, which is precisely the role the finding's scenario names and the normal actor for a split.

**Mechanism.** Three defects compound. (1) `splitDocument` and `mergeDocuments` call `markSupersededAndLink` directly (split.ts:137, merge.ts:191), which issues a bare `.update({ status: "Superseded", … })` (common.ts:269-280) with no `authorizePublish` and therefore no hold evaluation — unlike `supersedeDocument`, which does call it (revisions.ts:1425-1428, "same per-library publish authority + lock/hold guard"). Only the DB trigger stands in the way, and it short-circuits for Admin/DocCtrl before reaching the hold test (20260822:62-66), so a controller splits a held drawing with no force flag, no confirmation and no audit that a hold was overridden. (2) The hold carry-over runs *after* the source is already Superseded and the new sheets already exist (split.ts:162-170 is step 3; markSupersededAndLink is step 2), and it is deliberately excluded from the rollback register — the comment says "A transient copy failure here is reported via honest counts rather than rolling back the whole split" (split.ts:155-159). (3) `copyActiveHoldsToDoc` swallows the insert error entirely: `const { data: insertedHold, error } = await supabase.from("document_holds").insert({…}); if (!error && insertedHold) { copied++; … }` (common.ts:351-364) — a row that fails to insert is silently not copied and not reported as a failure, only as a smaller number.

**Failure scenario.** A cluttered P&ID under an "Awaiting Engineering" hold is split into three sheets by a DocCtrl. The supersession succeeds with no hold prompt. RLS or a transient error rejects the three hold inserts (or the caller passed copyHolds:false). The result object reports holdsCopied:0 and the split "succeeded." The source is now Superseded and its hold is stranded on a retired document; the three new live sheets carry no hold at all and publish, download, transmit and pack freely. The engineering blocker that stopped work has been laundered away by a structural edit.

**Evidence.**

```
lib/documentLifecycle/common.ts:351-364 — `const { data: insertedHold, error } = await supabase.from("document_holds").insert({ … }).select("id").single();` / `if (!error && insertedHold) { copied++;`  •  lib/documentLifecycle/split.ts:155-159 — "These are SECONDARY effects: the split itself (new docs + supersession) is already durable and correct above. A transient copy failure here is reported via honest counts rather than rolling back the whole split"  •  lib/revisions.ts:1423-1428 — `// Retiring a document is a canonical-state change too: same per-library publish` / `// authority + lock/hold guard …` / `const preState = await authorizePublish({ documentId: doc.id, libraryId, orgId, actorUserId, actorRole, … });` (the call split/merge omit)
```

> **Verifier correction.** Two scoping corrections, both of which shift where the risk actually lives. (a) Sub-defect (1) is CONTROLLER-ONLY: status→Superseded IS an advancing transition under 20260822:35-40, so for a non-controller the trigger reaches the hold test at :77-86 and aborts the split. Admins/DocCtrl short-circuit at :63-66 — and they could force past a hold via the sanctioned path anyway, so the incremental loss is the missing force flag/confirmation/override audit, not a new capability. (b) Sub-defect (3) is WORSE than stated: the "honest counts" mitigation is never surfaced. `grep -rn holdsCopied` over all .ts/.tsx returns only lib/documentLifecycle/{split,merge}.ts, and a second search for the callers shows components/documents/lifecycle/SplitWizard.tsx:114 and MergeWizard.tsx:123 both `await` the function and discard the result object entirely. A hold that fails to carry over to a new sheet is reported to nobody.

**Done when.**

- [ ] splitDocument and mergeDocuments run the same authorizePublish (lock + hold) gate as supersedeDocument before markSupersededAndLink, requiring an explicit controller force to proceed over a hold
- [ ] Hold carry-over happens before the source is superseded, and a failed carry-over rolls the operation back via the existing compensation register rather than reporting a smaller count
- [ ] copyActiveHoldsToDoc surfaces insert errors to the caller instead of `if (!error && insertedHold)`, and copyHolds:false is refused when the source has active holds

**Resolution (2026-09-30, document-control Round F wave 2).** P3 LIFECYCLE. Reproduced on `a11e1e4`: `splitDocument` / `mergeDocuments` called `markSupersededAndLink` with no `authorizePublish` (`lib/documentLifecycle/split.ts:137`, `merge.ts:191`); holds were copied AFTER the supersession, outside the compensation register (`split.ts:155-170`, `merge.ts:215-227`); `copyActiveHoldsToDoc` counted only successful inserts and swallowed the rest (`common.ts:384`, `if (!error && insertedHold)`); both wizards discarded the result object, so even the smaller count reached nobody.
- **The supersede gate.** `authorizePublish` (exported from `lib/revisions.ts`) runs on the split source and on EVERY merge source before anything is written: per-library publish authority or the source's effective owner, the lock (a foreign checkout takes a reason — the operation's reason by default, the supersede modal's rule — and the holder is told on their thread and in-app, `notifyHolderOfRetirement`, shared with supersede), and the hold — only a controller's explicit `force` passes one (the `canForceHold` rule; an override reason never jumps a hold). `copyHolds: false` is refused while a source has an active hold.
- **Holds carry BEFORE the supersession, inside the register.** New sheets are created, the source's holds are copied onto each (split) / onto the target (merge), and only then is the source superseded; each carry registers `releaseCarriedHolds` (releases exactly the holds it placed, with a reason; the 20261073 guard writes the `HOLD_RELEASED` record), so a hold that fails to carry rolls the whole operation back — the new sheets archived, their carried holds released, the source never superseded.
- **`copyActiveHoldsToDoc` surfaces every refusal:** the source read, the target read and each insert are checked and throw; it returns the placed hold ids. **A carry that fails part-way cleans up its own target** (review fix): the caller registers `releaseCarriedHolds` only after a successful return, so a throw on the second of two holds used to leave the first open on a target the rollback then archived — an orphan stop-work item. The insert loop now releases the holds it already placed on that target (through the same checked `releaseCarriedHolds`) before rethrowing, and says so; a release that is itself refused is named in the error for the hold queue.
- Tests: `lib/__tests__/dcRoundFLifecycle.test.ts` "HLD-2 — …": a held source is refused for a non-controller with nothing written; a controller's force proceeds and every new sheet carries the hold, all hold inserts ordered before the supersession; `copyHolds: false` over a hold is refused; a failed second carry rolls back (source Issued, sheets Archived, carried holds released); a refused insert throws; a source with two holds whose second insert fails leaves the first released on the target (and a refused release is named); a merge with a held second source creates nothing; a forced merge carries the hold. `lib/__tests__/holds.test.ts` (P5's pin on the copy's open-hold shape) still holds.

**Done-when.**
1. ✓ `splitDocument` and `mergeDocuments` run the same `authorizePublish` (lock + hold) gate as `supersedeDocument` before `markSupersededAndLink`; proceeding over a hold takes a controller's explicit force.
2. ✓ Hold carry-over happens before the source is superseded, and a failed carry-over rolls back through the compensation register.
3. ✓ `copyActiveHoldsToDoc` surfaces insert (and read) errors; `copyHolds: false` is refused when the source has active holds.

**Scope / residual.** The Split / Merge wizards (not this package's files) pass no `force`, so from the UI a held drawing is split only after its hold is released — the fail-safe direction; the API takes `force` for a controller. HLD-1's remaining limbs are P7 / P8 (see `HLD-1`).

---

<a id="hld-3"></a>

## HLD-3 · The field-verification QR surfaces are hold-blind: /api/verify flashes green "CURRENT" and /api/verify-package flashes "all fresh" for a document under an active stop-work hold

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:34-39`, `app/api/verify/route.ts:89-108`, `app/verify/[docId]/page.tsx:65`, `app/verify/[docId]/page.tsx:99`, `app/api/verify-package/route.ts:47-74`, `lib/docPack.ts:100-105`, `lib/physicalBridge.ts:275-281`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both public field-verification surfaces are hold-blind, confirmed by full-file inspection rather than inference. The QR that lands on the hold-blind page is stamped by lib/docPack.ts:100-105 (`verifyUrl: ${publicOrigin()}/verify/${d.id}?v=${versionId}`) and lib/physicalBridge.ts:275-281, so the print that a held drawing produces actively points the field at the green answer.

**Mechanism.** `/api/verify` is the endpoint behind the QR stamped on every uncontrolled copy and every doc-pack sheet. Its verdict is computed from status and version identity alone: `const docRetired = d.status === "Superseded" || d.status === "Archived"; const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);` (route.ts:89-90). It selects `id, document_number, title, name, rev, status, current_version_id, superseded_at` (route.ts:36) and never touches `document_holds`. `/api/verify-package` does the same for a whole pack: `fresh: !retired && !!r.pinned_version_id && r.pinned_version_id === (d?.current_version_id ?? null)` and `allFresh: sheets.length > 0 && staleCount === 0` (route.ts:56-73), again with no hold query. The public pages render that verdict as an unqualified green: `result?.isCurrent ? "bg-emerald-600" : "bg-red-600"` and the word `"CURRENT"` (app/verify/[docId]/page.tsx:65,99). The only surface in the product that knows about holds is `/api/verify-hold`, and it is keyed on a HOLD uuid that exists only on a card someone chose to print (app/api/verify-hold/route.ts:21-31). Confirmed by two differently-shaped searches: a `grep -rn "document_holds"` over all .ts/.tsx (none of the three verify routes appear except verify-hold), and a per-file `grep -n "hold|Hold"` of app/api/verify/route.ts and app/api/verify-package/route.ts (zero hits).

**Failure scenario.** DocCtrl places a "Field Verification Needed" hold on P&ID PID-2201 Rev 4 after a walkdown finds the line routing does not match. Nobody prints a red hold card. A pipefitter holding a stamped print from last week scans the footer QR — the page turns emerald and says CURRENT, "this print matches the current revision." He welds to a drawing that document control has formally stopped work on. The same scan on the work-package cover sheet, printed under the words "SCAN BEFORE STARTING WORK" (lib/physicalBridge.ts:278), returns allFresh:true for a pack containing that sheet.

**Evidence.**

```
app/api/verify/route.ts:89-90 — `const docRetired = d.status === "Superseded" || d.status === "Archived";` / `const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);`  •  app/api/verify/route.ts:8-10 comment — "The response contains ONLY revision-status facts … Answers exactly one question: 'is the paper in my hand still current?'"  •  app/verify/[docId]/page.tsx:99 — `{result.notYetEffective ? "NOT YET IN EFFECT" : result.isCurrent ? "CURRENT" : "DO NOT USE"}`  •  app/api/verify-package/route.ts:73 — `allFresh: sheets.length > 0 && staleCount === 0,`
```

> **Verifier correction.** Downgraded CRITICAL→HIGH. The endpoint's documented contract (route.ts:8-12) is narrower than the finding implies — it answers "is the paper in my hand still the current revision?", and a hold does not change which revision is current, so the endpoint is not returning a wrong revision answer. The real defect is a product-level inconsistency: lib/holds.ts:249 broadcasts "Work from this document should stop until it's released" while the field QR on the same sheet says CURRENT in green. Severe, but it is a missing signal rather than a false revision verdict.

**Done when.**

- [ ] /api/verify queries document_holds for the doc and returns an `onHold` flag plus the hold reasons; the verdict page renders a distinct HOLD state (red, "DO NOT USE — WORK STOPPED") that outranks isCurrent
- [ ] /api/verify-package does the same per sheet and forces allFresh:false when any member document carries an active hold
- [ ] A test asserts that a document whose version matches current but which has an unreleased document_holds row returns a non-green verdict from both routes

---

<a id="hld-4"></a>

## HLD-4 · buildAndDownloadDocPack assembles held drawings into the field pack with no hold marking and reports "all current, all stamped"

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/docPack.ts:50-53`, `lib/docPack.ts:90-105`, `app/(protected)/assets/[tag]/page.tsx:129-142`, `app/(protected)/assets/[tag]/page.tsx:215`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every element of the claim verified verbatim, including the banner text. The page does render a hold badge per row (page.tsx:215 `{(holdsByDoc.get(d.id) ?? 0) > 0 && <span ...> hold</span>}`) — but that is display-only: it feeds neither the Doc Pack button's disabled state nor buildAndDownloadDocPack's input, which is `docs.map((d) => d.id)` unfiltered (page.tsx:133).

**Mechanism.** The pack builder selects only `id, org_id, document_number, title, name, rev, library_id, current_version_id, checked_out_by, checked_out_by_name, checkout_note` (docPack.ts:51-52) and never reads document_holds. It knows how to warn on a soft signal — a foreign CHECKOUT produces `" ACTIVE CHANGE IN PROGRESS: checked out by …"` appended to the footer (docPack.ts:92-94) — but the hard signal, a hold, produces nothing: no footer text, no skip, no entry in `skipped`. The calling screen makes this stark: the equipment page renders a per-document hold badge, `{(holdsByDoc.get(d.id) ?? 0) > 0 && <span …>hold</span>}` (assets/[tag]/page.tsx:215), directly beside a "Doc Pack" button whose success message reads `Pack ready — ${result.included} drawing${…}, all current, all stamped.` (assets/[tag]/page.tsx:140). The app has the hold state loaded in local component state at the moment it builds the pack and does not pass it in.

**Failure scenario.** A planner opens /assets/E-204, sees one of the six drawings badged "hold", clicks Doc Pack anyway (or does not notice the badge among six rows), and gets a single merged PDF whose banner says "Pack ready — 6 drawings, all current, all stamped." Each page's footer says "verify current revision before use" and carries a QR that (per the previous finding) answers CURRENT. The held drawing goes to the field inside a document that asserts it is current.

**Evidence.**

```
lib/docPack.ts:92-94 — `const holderWarning = d.checked_out_by && (` `  \` ACTIVE CHANGE IN PROGRESS: checked out by ${(d.checked_out_by_name as string) || "another user"} at time of issue.\`` `);`  •  lib/docPack.ts:99-102 — `footerNotice: \`${label} Rev ${(d.rev as string) ?? "?"} at time of issue — verify current revision before use.\` + (holderWarning || ""),`  •  app/(protected)/assets/[tag]/page.tsx:140 — `? \`Pack ready — ${result.included} drawing${result.included === 1 ? "" : "s"}, all current, all stamped.\``
```

> **Verifier correction.** Minor: the same defect applies to the second caller, app/(protected)/packages/page.tsx:159-169 (work-package pack), which the finding does not name.

**Done when.**

- [ ] buildAndDownloadDocPack loads active holds for the requested documentIds and either skips held documents with reason "on hold" or stamps an unmissable HOLD banner on every page of a held sheet
- [ ] The "all current, all stamped" success copy is suppressed whenever any packed document carried a hold
- [ ] The assets page passes its already-loaded holdsByDoc map into the pack call rather than re-deriving nothing

---

<a id="hld-5"></a>

## HLD-5 · document_holds rows are wholly mutable by anyone holding holds.release, with no column restriction, no trigger and an audit trail written only by the client — a hold can be released, re-dated, re-attributed or un-released leaving no record

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260901_db_hard_enforcement.sql:96-102`, `supabase/migrations/20260612_phase5_holds.sql:35-38`, `supabase/migrations/20260901_db_hard_enforcement.sql:103-105`, `lib/holds.ts:173-218`, `lib/audit.ts:129-150`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The absence of a trigger is confirmed by repo-wide search: the only `ON document_holds` statements in supabase/ are policies and indexes — no CREATE TRIGGER exists on that table. Because the default capability is '*', any active member (Viewer included) can PATCH released_at, released_by_name, opened_at, or set released_at back to NULL, and lib/holds.ts's own `assertHoldCapability` (lines 86-108) is app-side only and explicitly fails open on a policy-lookup error.

**Mechanism.** The UPDATE policy gates the *capability* and nothing else: `CREATE POLICY document_holds_update ON document_holds FOR UPDATE USING (org_capability_allows(org_id, 'holds.release', auth.uid())) WITH CHECK (org_capability_allows(org_id, 'holds.release', auth.uid()));` (20260901:98-102). Its own comment concedes the assumption — "the capability gates every update (the row has no other mutable purpose)" — but nothing restricts which columns move. A raw PostgREST PATCH may set `released_at`, `released_by`, `released_by_name`, `released_reason`, `reason`, `notes`, `opened_by`, `opened_by_name` or `opened_at` to anything, or set `released_at` back to NULL to resurrect a hold. There is no trigger on the table at all (`grep -rn "TRIGGER" supabase/migrations/*.sql supabase/schema.sql | grep -i hold` returns only the two legal-hold DELETE triggers on documents/document_versions; a second search, `grep -rn "document_holds" supabase/migrations/*.sql`, shows only CREATE TABLE, indexes and policies). The migration states the design explicitly: "Audit row is written by the application (lib/holds.ts) using the existing audit_logs flow, not by a trigger" (20260612:35-38). So a release performed outside `releaseHold()` produces no HOLD_RELEASED audit row and no notification, and the document immediately publishes clean. Delete is controller-only (20260901:103-105) — but a controller deleting the row removes the hold from the timeline entirely (see the timeline finding). Note the `holds.release` default of `["*"]` itself is already reported in audit-reports/drafting-flow/11-document-handoff.md:69 and 90-gap-register.md:71,270; this finding is about the unconstrained column surface and the client-only audit on top of that default.

**Failure scenario.** A drafter blocked by a controller's hold opens devtools, copies the session bearer token, and issues `PATCH /rest/v1/document_holds?id=eq.<uuid>` with `{"released_at":"<now>","released_by_name":"Document Control"}`. RLS allows it (holds.release defaults to "*"). No HOLD_RELEASED row is written, no bell fires, and the document's timeline — which prefers the hold row over the audit rows — renders a tidy "Hold released — Client Review (3d)" attributed to Document Control. The next rev-up passes both the app guard and the DB trigger. The PSM record shows a hold that Document Control released.

**Evidence.**

```
supabase/migrations/20260901_db_hard_enforcement.sql:96-102 — `-- Releasing = the UPDATE that sets released_at; the capability gates every` / `-- update (the row has no other mutable purpose).` / `CREATE POLICY document_holds_update ON document_holds FOR UPDATE USING (org_capability_allows(org_id, 'holds.release', auth.uid())) WITH CHECK (org_capability_allows(org_id, 'holds.release', auth.uid()));`  •  supabase/migrations/20260612_phase5_holds.sql:35-38 — "Audit row is written by the application (lib/holds.ts) … not by a trigger. That keeps the audit actor accurate (we know who pressed the button) instead of fabricating it from session_user."
```

**Done when.**

- [ ] A BEFORE UPDATE trigger on document_holds rejects any change to opened_by / opened_by_name / opened_at / reason / org_id / document_id, refuses released_at → NULL, and forces released_by = auth.uid() and released_at = now()
- [ ] The same trigger (or an AFTER trigger) writes the HOLD_RELEASED audit_logs row server-side so the trail cannot be skipped by writing outside lib/holds.ts
- [ ] A test performs a direct PostgREST release and asserts both that it is refused for the forged columns and that an audit row exists for the legitimate one

**Resolution (2026-09-23, Round F).** P5 HOLDS. Reproduced on `ba7bfcb`: `grep -n "TRIGGER" supabase/migrations/*.sql | grep -i document_holds` → nothing; the UPDATE policy (20260901:98-102) gated `holds.release` (shipped default `*`) and no column; `releaseHold` was the only writer of HOLD_RELEASED. Migration `20261073_dc_roundF_document_holds_integrity.sql` — function `enforce_document_hold_guard` + trigger `trg_document_hold_guard` (BEFORE UPDATE ON document_holds, the 20261030 / 20261032 shape):
- **Identity immutable — for everyone, service role included** (the legal-hold delete guards' stance): `org_id`, `document_id`, `reason`, `opened_by`, `opened_by_name`, `opened_at`, `held_rev_label`, `held_version_id`. `origin_ticket_id` is NOT pinned (DEC-25 — the ticket route keeps it writable); `notes` / `expected_release_at` stay editable on an OPEN hold.
- **No resurrection, no rewrite:** `released_at` → NULL is refused ("A released hold cannot be reopened; place a new hold instead."); once released, `released_at` / `released_by` / `released_by_name` / `released_reason` / `release_recorded_at` are frozen; release attribution cannot appear without a release.
- **The release transition:** a non-blank `released_reason` is required (HLD-10's rule, held at the database). For a signed-in caller `released_by := auth.uid()`, `released_at := now()`, `released_by_name` from their membership (display name, else email) — attribution is the session, not the payload. The guard then INSERTs the HOLD_RELEASED `audit_logs` row itself (`user_role` = the role COLLECTION, DEC-2; details carry holdId, reason, releasedReason, durationMs and `source: "document_holds_guard"`) and stamps the new `release_recorded_at` column. A service-role write (`auth.uid()` NULL — the ticket close gate at `app/api/tickets/workflow-action/route.ts:339-378`, restores) must still name a releaser and a reason; it keeps its own attribution and writes its own audit row, as it does today (verified: `released_by: caller.id`, a reason always supplied).
- **App (`lib/holds.ts` `releaseHold`):** writes HOLD_RELEASED only when the returned row carries no `release_recorded_at` — a pre-migration database (no such column) keeps today's app-side row; a 20261073 database gets exactly one row, the guard's. Never two.
- **The INSERT side (fix pass):** the release rules above bind UPDATE, so a holder of `holds.open` (shipped default `*`) could have POSTed a row already carrying `released_at` / `released_by` (another person's uid) / `released_by_name` / `released_reason` NULL — a released-hold history entry under any name, with no reason and no audit row, which `lib/timeline.ts` would render as that person's HOLD_RELEASED. The BEFORE INSERT guard (`enforce_document_hold_org_guard`, same migration) now refuses any of the four release columns on a signed-in INSERT ("A hold is placed open; release it with a reason."); the service role (`auth.uid()` NULL — the admin restore replaying released rows through `actor.admin`, `ignoreDuplicates` upsert) keeps what it supplies. `openHold` and `copyActiveHoldsToDoc` never send a release column (pinned).

**Done-when.** (1) BEFORE UPDATE trigger rejects changes to opened_by / opened_by_name / opened_at / reason / org_id / document_id, refuses released_at → NULL, forces released_by = auth.uid() and released_at = now() ✓; (2) the trigger writes the HOLD_RELEASED row server-side ✓ (for signed-in writes; a service-role writer is server code that writes its own — stated, not skipped); (3) "a test performs a direct PostgREST release" — **no live database in this loop (DEC-30):** the forged-column refusals and the audit INSERT are pinned by shape in `lib/__tests__/holds.test.ts` "20261073 — document_holds integrity" (every identity column, the resurrection branch, the frozen release record, the reason rule, the session pin, the audit INSERT and its source marker, the service-role branch, the ticket route's contract), and the app-side dedupe is driven end-to-end against a mocked trigger that stamps `release_recorded_at` ("HLD-10 / HLD-5 — releaseHold"); the born-released INSERT refusal is pinned by shape too ("HLD-5 INSERT side" — the exact branch, its position before RETURN NEW, exactly one session read in the INSERT guard, the live probe text, and that no app INSERT supplies a release column). **Not met as written:** no test issues a real PostgREST release against a database; the migration's own final SELECT (6 probes; probe 3 now also pins the born-open branch) is the live proof on paste.
- Files: `supabase/migrations/20261073_dc_roundF_document_holds_integrity.sql`, `lib/holds.ts`. `searchPathPin` covers the pin; `authorityCensus` accepted the collection read.
- **Pending migration:** `20261073` (DEC-30). Until pasted the forgery door is open exactly as before and the app still writes its own row.

**Scope / residual.** On INSERT the release columns are refused for a signed-in caller (above); `opened_by` stays client-supplied on INSERT because `copyActiveHoldsToDoc` legitimately inserts another opener's hold on a split / merge (HLD-2 / P3), so the INSERT policy does not pin it — a forged HOLD_OPENED attribution is a residual for the HLD-2 record. A service-role INSERT may still carry a release record (a restore must); that path is server code, not a member. A controller DELETE (20260901) still removes a hold row from the timeline — HLD-11 / P6.

---

<a id="hld-6"></a>

## HLD-6 · placeLegalHold, releaseLegalHold and disposeDocument never inspect the write result — they log the retention event, fire the notification and report a success count derived from the input id list

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/retention.ts:120-131`, `lib/retention.ts:134-144`, `lib/retention.ts:151-158`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:17-33`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — supabase-js's PostgREST builder resolves with `{ data, error }` and never rejects, so a failed or RLS-denied UPDATE produces the identical return value and the identical retention event and notification as a successful one. No compensating control exists: 20260826_legal_hold_delete_guard.sql:17-33 only fires `IF OLD.legal_hold`, so if the placing UPDATE silently failed the column is still false and the delete guard stays inert on exactly the records it was meant to protect.

**Mechanism.** All three follow the established supabase-js shape the earlier audits flagged: the client resolves with `{ error }` rather than throwing, and the result is discarded. `placeLegalHold` does `for (let i = 0; i < ids.length; i += 50) { await supabase.from("documents").update(patch).in("id", ids.slice(i, i + 50)); }` then unconditionally `await logEvent(... action: "hold_placed" ...)`, `await notifyHold(... "legal_hold_placed" ...)` and `return ids.length;` (retention.ts:124-130). `releaseLegalHold` is identical (retention.ts:137-143). `disposeDocument` does `await supabase.from("documents").update({ disposition_state: "disposed", disposed_at: nowIso, status: "Archived", updated_at: nowIso }).eq("id", input.documentId);` and then `return { ok: true };` (retention.ts:156-158). The consequence is asymmetric and severe for placeLegalHold specifically, because the whole point of the 20260826 migration is that `enforce_legal_hold_delete_guard()` refuses a DELETE only when `OLD.legal_hold` is true — if the UPDATE silently failed, the flag is still false and the guard will not fire, while the app, the retention event log and everyone who got the notification believe the record is frozen for litigation.

**Failure scenario.** Counsel asks for a litigation hold across a folder of 380 incident drawings. A transient PostgREST error, an RLS denial on a subset, or a schema-cache miss makes every UPDATE fail. `placeLegalHold` returns 380, the UI reports "380 documents placed on legal hold," a `hold_placed` retention event is written, and everyone is notified. `legal_hold` is still false on all 380 rows. Six weeks later a controller runs a routine cleanup; the BEFORE DELETE trigger passes because legal_hold is false, and the evidentiary records are destroyed — with a retention log that says they were under hold at the time.

**Evidence.**

```
lib/retention.ts:124-130 — `const ids = await scopeDocumentIds(input.scope, input.id);` / `for (let i = 0; i < ids.length; i += 50) { await supabase.from("documents").update(patch).in("id", ids.slice(i, i + 50)); }` / `await logEvent(input.orgId, { … action: "hold_placed" … });` / `await notifyHold(input.orgId, ids, "legal_hold_placed", …);` / `return ids.length;`  •  supabase/migrations/20260826_legal_hold_delete_guard.sql:20-24 — `IF OLD.legal_hold THEN RAISE EXCEPTION 'This record is under a legal hold and cannot be deleted. Release the hold first.' USING ERRCODE = 'check_violation'; END IF;`  •  supabase/migrations/20260826_legal_hold_delete_guard.sql:6-9 — "spoliation prevention is exactly the invariant that must not depend on the client behaving."
```

> **Verifier correction.** Nit: the returned count comes from scopeDocumentIds' own SELECT, not literally "the input id list" — the substance (it is derived from a read, never from the write) is unchanged.

**Done when.**

- [ ] Each batched update destructures `{ error, count }` with `{ count: "exact" }`, aborts on error, and returns the count the database actually reports
- [ ] logEvent and notifyHold run only after a verified write, and a partial batch failure surfaces to the caller rather than being rounded up to ids.length
- [ ] disposeDocument returns { ok:false } when its update errors or matches zero rows

**Resolution (2026-09-23, Round F — record-only close).** Verified against current `lib/retention.ts` and closed by pointer to roles-and-permissions `SURF-3` / `OWN-14` (the checked-write round) and this area's `RET-5` (Round F, the remaining three writes): `placeLegalHold` and `releaseLegalHold` run each 50-id chunk as `update(patch).in("id", batch).select("id")`, abort on `error` naming how many held so far, accumulate `held` from the rows the database actually returned, and THROW when `held < ids.length` BEFORE `logEvent` or `notifyHold` run — so the event and the notification exist only when every scoped record is held, and the number they carry is the real one; `disposeDocument` is a checked `update … .select("id")` returning `{ ok:false, reason:"refused" }` on zero rows and throwing on error (and now also refuses under an open hold, `HLD-1`). `RET-5` closed `recomputeRetention`, `scanRetention`'s flag write and `logEvent` the same way. Pinned by `lib/__tests__/rpPhase6Additive.test.ts` ("disposal is a checked write"), `lib/__tests__/checkedWrites.test.ts` (placeLegalHold) and `lib/__tests__/dcRoundFRecords.test.ts`.

**Done-when.**
- ✓ / ✗ each batched update is checked and the count returned is what the database reported — via `.select('id')` row counts rather than the literal `{ count: "exact" }` shape (equivalent evidence: the rows the update touched); a chunk error aborts.
- ✓ `logEvent` and `notifyHold` run only after a verified, complete write; a partial batch throws instead of rounding up.
- ✓ `disposeDocument` returns `{ ok:false }` when its update matches zero rows (and throws on error).

**Scope / residual.** None beyond `RET-5`'s note that `logAuditAction` stays best-effort by design.

---

<a id="hld-7"></a>

## HLD-7 · /api/verify-hold publicly returns the hold's free-text `reason` — contradicting the route's own stated contract — and reports the document's live revision, because a hold is not bound to the revision it stopped

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-hold/route.ts:48-61`, `app/api/verify-hold/route.ts:37-46`, `components/documents/HoldStrip.tsx:191-206`, `supabase/migrations/20260612_phase5_holds.sql:44-58`, `lib/physicalBridge.ts:152-155`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The facts hold, but the disclosure severity is overstated: lib/physicalBridge.ts:155 prints `Reason: ${input.reason}` in 13pt bold RED on the very card that carries the QR (and the notes on the next line), so anyone positioned to photograph or scan the tag can already read the sentence — the endpoint adds essentially no exposure beyond the physical artifact. The route's top-of-file contract at line 6 also states plainly 'Exposure is minimal: hold status + reason + document label', so it is only the later inline comment that reads as contradicted. The live-rev half is a genuine correctness bug but a mild one. LOW.

**Mechanism.** The route's comment states the contract it believes it is honouring: "Minimal facts only … This endpoint is unauthenticated; a photographed hold card must not disclose staff names or free-text operator notes ('waiting on legal re: incident …') to whoever scans it. Status, category, dates, and the doc label suffice" (route.ts:48-52). It then returns `reason` (route.ts:55). `reason` is not a category: the schema has "NO check constraint" by design (20260612:29-33), and HoldStrip's "Other…" control accepts an arbitrary string — `<input value={otherDraft} onChange={…} placeholder="Custom hold reason" …>` feeding `onOpen(otherDraft)` (HoldStrip.tsx:191-206). The exact class of string the comment names is the class the endpoint publishes. Separately, `document_holds` has no version column (20260612:44-58), so the route resolves the label and rev from the document row live — `.select("document_number, title, name, rev")` (route.ts:39) — and returns `docRev` as whatever the document reads *now*. The printed card, meanwhile, freezes the rev at print time (physicalBridge.ts:152-155). Nothing records which revision the hold was placed against.

**Failure scenario.** Document control opens a hold with the free-text reason "Hold per legal — Aug 12 release incident, do not distribute." A red card is printed and hung on the compressor. Anyone who photographs or scans that QR — a contractor, a visitor, a passer-by — gets that sentence back from an unauthenticated endpoint. Separately: the card was printed showing "P-2201 · Rev 3." A controller later force-publishes Rev 5 over the hold. The card still hangs, the QR still says HOLD ACTIVE, but now displays "Rev 5" — and no one can determine from the system which revision the stop-work was actually placed against. (The unauthenticated, org-unscoped nature of this route is already reported in audit-reports/intelligence/06-document-acl-leaks.md:240-252; that entry credits the route with withholding free text, which the `reason` field contradicts.)

**Evidence.**

```
app/api/verify-hold/route.ts:48-56 — `// Minimal facts only — same contract as /api/verify. This endpoint is` / `// unauthenticated; a photographed hold card must not disclose staff names` / `// or free-text operator notes ("waiting on legal re: incident …") to` / `// whoever scans it.` … `return NextResponse.json({ active: !h.released_at, reason: (h.reason as string) ?? null,`  •  components/documents/HoldStrip.tsx:193-201 — `<input value={otherDraft} … placeholder="Custom hold reason" …/>` … `onClick={() => otherDraft && onOpen(otherDraft)}`  •  supabase/migrations/20260612_phase5_holds.sql:29-33 — "reason is TEXT with NO check constraint … orgs can also enter free-form reasons via 'Other'."
```

> **Verifier correction.** The disclosure half is largely self-mitigating and should not drive the severity. The printed card the QR sits on already draws, in large type, `Reason: ${input.reason}` (physicalBridge.ts:156), the notes verbatim (:157-159) and `Placed by ${openedByName}` (:160-163). Anyone who can photograph the card can already read all of that, so returning `reason` over the wire discloses nothing new — and the route does correctly withhold `notes` and `opened_by_name` from the JSON. The substance that survives is the second half: nothing binds a hold to the revision it stopped, so a scanned card can show a rev that differs from the printed one with no indication which one was actually held.

**Done when.**

- [ ] The public payload returns the reason only when it is one of PREDEFINED_HOLD_REASONS, and otherwise a generic "On hold" category — matching the contract the comment already claims
- [ ] document_holds gains a version_id (or held_rev_label) captured at open time; the card and the verify page both show the revision the hold was placed against, alongside the current one when they differ
- [ ] The intelligence-audit entry at 06-document-acl-leaks.md:252 is corrected to note that `reason` is operator free text

**Resolution (2026-09-23, Round F).** P5 HOLDS, holds half; the payload change satisfies the intent of public-surfaces `VFY-6` done-when 1 (a custom reason is reported as a generic category) with the fallback string "On hold" rather than the "Other" that record names — PS-VERIFY decides the wording when it takes `VFY-6` (the page prints the field under a "Reason" label, so "Other" may read better there; the constant is `PUBLIC_HOLD_REASON_FALLBACK`, one place). Reproduced: the route returned `reason: (h.reason as string) ?? null` verbatim and `docRev` from the live document row; `document_holds` had no revision column.
- **The revision a hold stopped** — migration `20261073` adds `held_rev_label TEXT` and `held_version_id UUID` (deliberately no FK: an ON DELETE SET NULL cascade would trip the identity pin; it is a recorded pointer), captured at INSERT by `enforce_document_hold_org_guard` from the document's `rev` / `current_version_id` when the client does not supply them (lifecycle copies and direct inserts get it too), then immutable. `lib/holds.ts` returns `HoldRecord` (DocumentHold + `heldRevLabel` / `heldVersionId`; null for holds placed before the migration — the rev they stopped is not knowable after the fact; the migration's after-apply inventory counts them).
- **The public payload** — `/api/verify-hold` returns `reason: publicHoldReason(reason)` (a predefined picker reason verbatim, otherwise "On hold"; `lib/holds.ts`) and `heldRev` beside `docRev`; the select no longer fetches notes / names at all; the route's contract comment says what is disclosed, including the title fallback. The verdict contract (`active`) is untouched — PS-VERIFY owns it.
- **The card and the inspector** — `HoldStrip` shows "at Rev N" on an active hold and prints the card with the held rev (`printHoldCard.docRev = heldRevLabel ?? current`); `/admin/holds` shows it in the row.

**Done-when.** (1) the reason only when predefined, else a generic category ✓; (2) `held_rev_label` (+ `held_version_id`) captured at open ✓ — the verify PAGE and the card LAYOUT showing held-vs-current "alongside when they differ" live in `app/verify-hold/[holdId]/page.tsx` and `lib/physicalBridge.ts`, PS-VERIFY's files (wave 2); the payload field `heldRev` is there for it; (3) the intelligence entry corrected ✓ (note appended to `DACL-8`, audit-reports/intelligence/06-document-acl-leaks.md).
- Files: `app/api/verify-hold/route.ts`, `lib/holds.ts`, `components/documents/HoldStrip.tsx`, `app/(protected)/admin/holds/page.tsx`, migration `20261073`. Tests: `lib/__tests__/holds.test.ts` "HLD-7" (publicHoldReason for all four predefined reasons and operator text; route: a custom reason → "On hold", heldRev "3" beside docRev "5", notes / names absent, the exact key set; a predefined reason passes through; a pre-migration row → heldRev null, never the current rev; bad id → 400).
- **Pending migration:** `20261073`.

**Scope / residual.** Page and card rendering → PS-VERIFY (`VFY-6` items 2–3, `VFY-10`); the reason column split (reason_code / reason_text) is `VFY-6`'s call, not taken here.

---

<a id="hld-8"></a>

## HLD-8 · Hold open/release UI is gated by hardcoded facility role lists that ignore the org's capability policy and make per-person delegations unusable; the hold queue's row links also drop ?doc= and land on the library instead of the held document

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/documents/InspectorPanel.tsx:132-133`, `components/documents/InspectorPanel.tsx:425`, `components/documents/InspectorPanel.tsx:864-871`, `app/(protected)/admin/holds/page.tsx:32`, `app/(protected)/admin/holds/page.tsx:42`, `app/(protected)/admin/holds/page.tsx:115`, `app/(protected)/admin/holds/page.tsx:181`, `lib/capabilityPolicy.ts:103-113`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed. The hardcoded lists are also NARROWER than the shipped policy default (`holds.open`/`holds.release` default to `["*"]` at lib/capabilityPolicy.ts:85-88), so the UI blocks people the policy already allows; a per-person grant added via addUserGrant can never light up either button, exactly as the error text at lib/holds.ts:102-103 invites the admin to try.

**Mechanism.** Two hardcoded vocabularies decide who sees the hold controls, and neither consults `loadCapabilityPolicy`/`policyAllows`. The inspector uses `const canManageAssets = activeRole === 'Admin' || activeRole === 'Manager' || activeRole === 'Supervisor' || (activeRole?.includes('Engineer') ?? false) || activeRole === 'Drafter' || activeRole === 'DocCtrl';` (InspectorPanel.tsx:132-133) and passes `canEdit={canManageAssets || isOwner}` to HoldStrip (:425), gating the place-first-hold section the same way (:871). The queue page uses `const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]); const canRelease = !!activeRole && ADMIN_ROLES.has(activeRole);` (admin/holds:32,42). The consequence cuts both ways against the policy layer: an admin who *widens* holds.open to a role outside those lists gets no button, and — more damagingly — `UserGrant` per-person delegations ("Grants are ADDITIVE ONLY: they can extend a person's authority beyond their role", capabilityPolicy.ts:103-106) are entirely invisible to the hold UI, so delegating holds.release to a named person grants an authority they can never exercise through the product. Separately, the queue's document link is `href={\`/documents/${meta.libraryId}\`}` (admin/holds:181) with no `?doc=` — even though the page's own subtitle says "Click a row to open the document" (:115), the deep-link param is supported (app/(protected)/documents/[libraryId]/page.tsx:1285, `const docId = searchParams.get("doc");`) and lib/holds.ts:248 builds it correctly for the notification.

**Failure scenario.** An admin, following the guidance in the hold error message ("An Admin can change this under Admin → Permissions → Action permissions"), delegates holds.release to the turnaround coordinator for the duration of the outage. The coordinator logs in, opens the held drawing, and sees the hold strip in read-only mode with no Release button — on both the inspector and the hold queue. The delegation is real at the database and unusable in the app. Meanwhile a controller working the 40-row hold queue clicks a row to go fix the document and lands on a library listing with hundreds of drawings and no selection.

**Evidence.**

```
components/documents/InspectorPanel.tsx:132-133 — `const canManageAssets = activeRole === 'Admin' || activeRole === 'Manager' || activeRole === 'Supervisor' || (activeRole?.includes('Engineer') ?? false) || activeRole === 'Drafter' || activeRole === 'DocCtrl';`  •  app/(protected)/admin/holds/page.tsx:32 — `const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);`  •  app/(protected)/admin/holds/page.tsx:181 — `<Link href={\`/documents/${meta.libraryId}\`} …>`  •  lib/holds.ts:248 — `link: doc?.library_id ? \`/documents/${doc.library_id}?doc=${input.documentId}\` : "/admin/holds",`  •  components/documents/InspectorPanel.tsx:864-867 — "Every hold-authorized role (Manager/Supervisor/Engineer/Drafter/controllers/owner) must be able to stop work from a document — a safety control, not an admin convenience"
```

**Done when.**

- [ ] Both hold surfaces derive canOpen/canRelease from loadCapabilityPolicy + policyAllows (role tokens, additive roles[], and live per-person grants) instead of a literal role list
- [ ] The hold queue link becomes /documents/{libraryId}?doc={documentId}, matching the notification link
- [ ] A test asserts that a user holding only a UserGrant for holds.release sees the Release control

**Resolution (2026-09-23, Round F — P5 HOLDS, the holds half).** Reproduced (`ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"])` at admin/holds:32; the queue link without `?doc=`).
- **`holdControlsFor(policy, role, extraRoles, uid)`** (`lib/holds.ts`, pure) — `canOpen` / `canRelease` through the SAME `policyAllows` the database and `assertHoldCapability` use: role tokens, the additive collection, live per-person grants. Both hold surfaces call it: `/admin/holds` (`loadCapabilityPolicy` + `useRole().roles`, nothing offered until the policy is read, a read error → shipped defaults as every policy consumer does — the database enforces) and `HoldStrip` (reads `useRole().roles` for the collection; the `canEdit` prop is now a caller-side hard OFF that can hide controls but never grant them). No literal role list remains on either surface. `lib/adminSurfaces.ts`: the holds entry drops its `writes` role list (release authority is the capability; the SURF-9 mirror test skips a surface with no `writes`).
- **The queue link** is `/documents/{libraryId}?doc={documentId}` — the notification's shape.
- **ROLE-5 subtraction (fix pass 2).** `holdControlsFor` now applies `holdsReadOnlyRole` (`lib/roleHeld.ts`) across the headline plus the collection before consulting the policy: a Viewer or Auditor anywhere in a member's held roles gets neither control — deny-if-any, no headline shortcut, no controller escape, no grant override — the same way the document edit gate and the assets overlay subtract. Under the shipped `*` default an Auditor doing a read-only review therefore no longer sees a live Release on `/admin/holds` (the reviewer's scenario); both surfaces inherit it because both go through the one function.

**Done-when.** (1) both hold surfaces derive from the policy ✓ for the queue; ✓ for `HoldStrip` itself — but `InspectorPanel.tsx:444` still passes `canEdit={canManageAssets || isOwner}` (and gates the "place first hold" section at :899 the same way), so a grant-holder who is neither manager nor owner still sees the strip read-only in the inspector until **P6 CHECKOUT (HLD-8 checkout half, `InspectorPanel.tsx`)** passes the policy-derived value or drops the gate — that line is P6's file; (2) `?doc=` ✓; (3) a test asserts a UserGrant-only user sees Release ✓ (`holdControlsFor` — "HLD-8 / HLD-10 — holdControlsFor and the policy-derived audience": grant-only → canRelease, narrowed list hides the un-granted, the collection counts, the wildcard admits, an expired grant is dead; the ROLE-5 case: Viewer-only, Auditor-only, `["Admin","Auditor"]`, `["Drafter","Viewer"]` and a granted Viewer all read `{ canOpen: false, canRelease: false }` while the same people without the read-only role are admitted, and the subtraction is the shared helper, not a literal; plus source pins that neither surface carries a literal and both fail closed until the policy loads).
- Files: `lib/holds.ts`, `components/documents/HoldStrip.tsx`, `app/(protected)/admin/holds/page.tsx`, `lib/adminSurfaces.ts` (one entry). No migration.

**Scope / residual.** Stays OPEN for the InspectorPanel line (P6). With the shipped `*` default the strip now offers Place hold / Release to every active member the caller lets in who holds no read-only role — the policy the database already enforces, minus the ROLE-5 subtraction (the UI was narrower than the policy, per the verifier). The database evaluator (`org_capability_allows_for`, 20261063: `'*'` → TRUE) does not itself subtract Viewer / Auditor for `holds.*`, so a raw PATCH by an Auditor under `*` is still admitted at the database — the UI is now the narrower side; adding the subtraction to the `document_holds` policies (the 20261045 assets-overlay shape) and narrowing the shipped `holds.*` defaults are the drafting-flow gap-register items, not this finding.

**Resolution (2026-09-23, Round F — P6 CHECKOUT, the checkout half: `InspectorPanel`).** Reproduced at `components/documents/InspectorPanel.tsx` (`canManageAssets` — a literal role list with an `includes('Engineer')` substring — gating `HoldStrip`'s `canEdit` and the place-first-hold section; `isController` gating Force Release). The Inspector now derives all three from the org's capability policy through the same evaluator `lib/holds.ts` uses: `holdAffordances(policy, role, roles, uid)` (`lib/checkoutAffordances.ts`, pure — `policyAllows` on `holds.open` / `holds.release`: role tokens, the additive `roles[]`, live per-person grants) feeds `canEdit={canOpenHold || canReleaseHold}` on the active-holds strip and `canOpenHold` on the place-first-hold section; `useForceReleaseAllowed` (DCK-13) feeds Force Release. A `UserGrant` for `holds.release` — the delegation the hold error text invites — now lights the Release control for that person; a role an admin widened `holds.open` to now sees the place-hold section; a narrowed policy hides what the database (`document_holds_update`, `assertHoldCapability`) would refuse. Ownership is deliberately no longer an input to the hold affordances: the DB policy and `assertHoldCapability` gate the write on the capability alone, so an owner outside the policy would be shown a control the write then refuses (with the shipped `"*"` default every member — owner included — still qualifies). Until the policy loads, the shipped defaults apply (identical to today for an unconfigured org).
- Files: `components/documents/InspectorPanel.tsx`, `lib/checkoutAffordances.ts` (new)
- Tests: `lib/__tests__/checkoutAffordances.test.ts` — a user holding ONLY a `UserGrant` for `holds.release` gets `canRelease: true` (and a stranger does not); a role outside the old literal lists but inside the policy is admitted; source pins that the Inspector's `HoldStrip` and place-hold section are gated on `canOpenHold` / `canReleaseHold` and no longer on `canManageAssets || isOwner`.
- Review fix (Round F review, minor): the Inspector first fed `HoldStrip` one merged flag (`canOpenHold || canReleaseHold`), and `HoldStrip` has a single `canEdit` that gates BOTH each active hold's Release button and the place-hold form — so under a narrowed `holds.release` every `holds.open` member (default `*`) was still drawn a Release the database then refused, the exact shape HLD-8 set out to remove. The strip that lists ACTIVE holds now takes `canEdit={canReleaseHold}` (`InspectorPanel.tsx`); the place-first-hold section is still `canOpenHold` alone. Cost until `HoldStrip` takes `canOpen` / `canRelease` separately (P5's file): a member with `holds.open` but not `holds.release` cannot place a FURTHER hold from the Inspector strip while one is active (the hold queue still can). Under the shipped defaults (both `*`) nothing changes.
- Left to P5 HOLDS (the holds half, per the Round F plan): `app/(protected)/admin/holds/page.tsx` (`ADMIN_ROLES` → policy; the `?doc=` deep link) and `components/documents/HoldStrip.tsx`. The status flips to RESOLVED when that half lands.

**Done-when (checkout half).**
- ◐ Both hold surfaces derive canOpen/canRelease from `loadCapabilityPolicy` + `policyAllows` — the Inspector does; the hold queue page is P5's.
- — The hold queue link (`/documents/{libraryId}?doc={documentId}`) — P5's file.
- ✓ A test asserts that a user holding only a `UserGrant` for `holds.release` sees the Release control — and, since the review fix, that a member WITHOUT it does not: `holdAffordances` → `canRelease: true` for the grant-only user, and the pinned source shows the active-holds strip's `canEdit={canReleaseHold}` (the merged `canOpenHold || canReleaseHold` is asserted absent). Residual: `HoldStrip`'s single flag still couples its place-hold form to the same verdict until P5 splits the prop.

*Integration note (2026-09-29): both halves merged — P5 delivered the queue page, `HoldStrip` and `holdControlsFor`; P6 delivered the Inspector line P5's residual named. The two "stays OPEN for the other half" notes above are superseded; every done-when item is met between them.*

---

<a id="hld-9"></a>

## HLD-9 · Nothing ties document_holds.org_id to the held document's org, while SELECT keys on the hold's org and every enforcement path keys on document_id — producing a hold that blocks a document its own org cannot see

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260612_phase5_holds.sql:44-58`, `supabase/migrations/20260901_db_hard_enforcement.sql:89-95`, `supabase/migrations/20260822_review_completion_guard.sql:77-81`, `lib/holds.ts:271-280`, `lib/documentLifecycle/common.ts:353-356`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and reachable: the INSERT policy (20260901:93-95) only checks `org_capability_allows(org_id, 'holds.open', auth.uid())` against the row's OWN org_id, so a member of org A can insert a hold carrying org A's id against any document UUID. Because the publish guard is SECURITY DEFINER and org-blind, org B's publish is blocked by a row org B's SELECT policy hides.

**Mechanism.** The table declares two independent FKs — `org_id UUID NOT NULL REFERENCES orgs(id)` and `document_id UUID NOT NULL REFERENCES documents(id)` (20260612:46-47) — with no composite constraint or trigger asserting they agree; two searches confirm no later migration adds one (`grep -rn "document_holds" supabase/migrations/*.sql` shows only indexes and policies after 20260612, and `grep -rn "TRIGGER" … | grep -i hold` finds none on the table). The RLS INSERT check is `org_capability_allows(org_id, 'holds.open', auth.uid())` (20260901:93-95) — it validates the *submitted* org_id against the submitter's membership, never against the document. But SELECT filters on `document_holds.org_id` (20260901:89-92) while the publish guard filters on document only: `SELECT EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = NEW.id AND h.released_at IS NULL)` (20260822:77-81), as do `listActiveHoldsForDocument` (`.eq("document_id", documentId).is("released_at", null)`, holds.ts:274-276) and the impact/inspector counters. A hold row carrying the wrong org_id is therefore fully load-bearing for blocking and invisible to the blocked org. `copyActiveHoldsToDoc` already stamps the ACTOR's org rather than the document's — `org_id: actor.orgId` (common.ts:354) — so this is one cross-org lifecycle operation away from happening without malice.

**Failure scenario.** A hold row lands with an org_id that does not match its document (a cross-org actor context in a lifecycle copy, a restore/import that remaps org ids, or a member of org A inserting against a document UUID from org B). Org B's inspector shows "No active holds," /admin/holds shows nothing, and every rev-up, revert and supersede on that drawing fails with "Document has an active hold; release the hold before publishing a new revision" — an error naming a hold nobody in the org can find, list or release. Only a controller forcing, or service-role SQL, gets past it.

**Evidence.**

```
supabase/migrations/20260612_phase5_holds.sql:46-47 — `org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,` / `document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,`  •  supabase/migrations/20260901_db_hard_enforcement.sql:93-95 — `CREATE POLICY document_holds_insert ON document_holds FOR INSERT WITH CHECK ( org_capability_allows(org_id, 'holds.open', auth.uid()) );`  •  supabase/migrations/20260822_review_completion_guard.sql:77-81 — `SELECT EXISTS ( SELECT 1 FROM document_holds h WHERE h.document_id = NEW.id AND h.released_at IS NULL ) INTO v_has_hold;`  •  lib/documentLifecycle/common.ts:353-356 — `.insert({ org_id: actor.orgId, document_id: targetDocId, …`
```

> **Verifier correction.** Verification corrected CONFIRMED→SUSPECTED. No code path in the repo actually produces a mismatched row. copyActiveHoldsToDoc's targetDocId is always a document created moments earlier in actor.orgId (split.ts:99-127 / common.ts createNewDocWithFirstVersion), and openHold's orgId comes from the UI's activeOrgId for a document already listed under that org. The mechanism (nothing enforces agreement) is confirmed; the consequence — an invisible-but-blocking hold — is not reachable from any path readable in this repo, so it is a latent constraint gap, not an observed defect.

**Done when.**

- [ ] A CHECK-equivalent trigger (or a composite FK to documents(id, org_id)) rejects any document_holds row whose org_id differs from the referenced document's org_id
- [ ] The INSERT policy derives org_id from the document rather than trusting the submitted value
- [ ] listActiveHoldsForDocument and the DB guard agree on scoping, or a backfill query is run to find existing mismatched rows

**Resolution (2026-09-23, Round F).** P5 HOLDS. Mechanism confirmed on `ba7bfcb` (no constraint, no trigger; the INSERT policy checks the submitted org only). Migration `20261073`: `enforce_document_hold_org_guard` / `trg_document_hold_org_guard` (BEFORE INSERT, applies to everyone — a constraint, not an authority check) refuses a row whose `org_id` differs from the document's ("A hold must carry the org of the document it holds."), refuses an unknown document (`IF NOT FOUND` — "A hold must name an existing document."), refuses — with its own message, not the not-found one — a document that exists but carries no org (`documents.org_id` is nullable in schema.sql; a hold's `org_id` is NOT NULL and could never agree: "This document carries no org; repair it before placing a hold."), and derives the HLD-7 columns; the INSERT policy is re-created as the live 20260901 body plus ONE conjunct binding `org_id` to the document's (the 20261032 PKG-5 shape — the subquery runs under the caller's documents RLS, so a document the caller cannot see resolves NULL and the row is refused: you cannot hold what you cannot see) and still calls the 3-argument `org_capability_allows` the 20261052 probe expects. On UPDATE the org / document identity is pinned by the HLD-5 guard, so agreement cannot drift. **Refuse rather than silently derive:** a wrong org is a caller bug worth surfacing; a rewritten value would hide it.

**Done-when.** (1) a trigger rejects a mismatched row ✓ (INSERT; UPDATE pinned); (2) the INSERT policy binds org to the document ✓ (bound, not rewritten — the same effect, louder); (3) scoping agreement ✓ — `listActiveHoldsForDocument` and the DB guard both key on `document_id`, and every new row carries the document's org, so the by-org SELECT sees what the guard sees; existing mismatched rows are counted by the before-apply inventory (`h.org_id IS DISTINCT FROM d.org_id`) — such a row cannot be edited in place once identity is pinned; repair = delete and re-place (stated in the migration header).
- Tests: `lib/__tests__/holds.test.ts` "20261073 — document_holds integrity" (policy lineDiff against 20260901: zero lines removed, exactly the one `AND` line added; the org guard's shape; the org/document agreement rule reads no session — one `auth.uid()` read remains in the guard, for the HLD-5 born-released refusal; the columns additive and idempotent), and "HLD-9 — /api/admin/restore/apply-table retries a refused document_holds chunk row by row" (below).
- **Restore consequence (fix pass 2).** The org-agreement and org-less-document refusals bind the service role, so a restore of `document_holds` from a backup taken BEFORE this paste that still carries an HLD-9-mismatched row (or a hold on a document that no longer exists) is refused for that row — and `app/api/admin/restore/apply-table` used to fail the whole 500-row chunk on it (upsert error → plain insert → 500, the good holds in the chunk dropped, no RESTORE_CHUNK audit row). The route now retries a `document_holds` chunk row by row when the chunk error is `23514` / `23503`, lands the good rows, and reports the refused ids (`refused: [{ id, code, message }]`) in both the response and the RESTORE_CHUNK audit details; any other error, and any other table, fail the chunk as before. The migration header says the same: delete a mismatched row BEFORE any restore of `document_holds` from a pre-paste backup.
- Files: migration `20261073`. **Pending migration:** `20261073` (DEC-30 — the inventory count says whether any repair is needed; the SUSPECTED consequence stays unobserved until then).

**Scope / residual.** `copyActiveHoldsToDoc` stamps `actor.orgId` (HLD-2 / P3) — now refused by the guard if it ever disagrees with the new document's org. A pre-paste backup that carries a mismatched hold restores everything but that row (reported, not silently dropped); the row itself is unrestorable by design — delete and re-place. `app/api/admin/restore/apply-table/route.ts` is outside this package's plan (XEDGE-3, sequencing item 7, is the route's own finding); the change is additive and confined to the chunk-error branch.

---

<a id="hld-10"></a>

## HLD-10 · Releasing a stop-work hold requires no reason, and the person who placed it is never told it was lifted — the release broadcast is fire-and-forget, swallows its own failure, and hardcodes ["Admin","DocCtrl"]

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/holds.ts:186`, `lib/holds.ts:208-215`, `lib/holds.ts:223-255`, `lib/holds.ts:252`, `components/documents/HoldStrip.tsx:320`, `app/(protected)/admin/holds/page.tsx:204`, `supabase/migrations/20260612_phase5_holds.sql:57`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All four sub-claims hold. The opener is only reached if they happen to be Admin/DocCtrl or have manually subscribed — lib/notify/recipients.ts:23-31 resolves followers purely from the `subscriptions` table, and the only writer is the manual WatchButton (lib/subscriptions.ts:41), so nothing auto-follows the person who placed the hold.

**Mechanism.** `released_reason` is nullable in the schema (20260612:57), optional in the API (`releasedReason?: string`), and coerced away by `input.releasedReason?.trim() || null` (holds.ts:186). Both UI surfaces label the field `placeholder="Resolution (optional)"` (HoldStrip.tsx:320, admin/holds:204) and neither disables the Release button when it is empty — contrast the deliberate asymmetry elsewhere in the codebase, where `revertToVersion` refuses without one (`if (!reason.trim()) throw new Error("Revert reason is required")`, revisions.ts) and the RPC refuses a branch publish without one. Separately, the release broadcast is `void notifyHoldChange({…})` (holds.ts:208) whose body is wrapped in `try { … } catch { /* best-effort */ }` (holds.ts:231-254), so a failed stop-work-lifted announcement is invisible to the releaser and to the caller. Its audience is `audience: { followers: true, roles: ["Admin", "DocCtrl"] }` (holds.ts:252) — hardcoded facility vocabulary, and notably it does not include the hold's opener: the dispatch layer supports an `involved` list (lib/notify/dispatch.ts:69) that holds.ts never uses, so the person who stopped work only hears about the release if they happen to follow the document or hold a controller role.

**Failure scenario.** An Engineer places "Awaiting Engineering" on an isometric because a support location is wrong. A drafter releases it with the resolution box left blank (the button is enabled), publishes Rev 5, and moves on. The audit row records HOLD_RELEASED with `releasedReason: null`; the timeline reads "Hold released — Awaiting Engineering (2d)" with no explanation. The Engineer who placed the hold is not on the notification list and is not a follower, so the first they know is when Rev 5 appears in a transmittal. During an incident review, the record cannot answer why the stop-work was lifted.

**Evidence.**

```
lib/holds.ts:186 — `released_reason: input.releasedReason?.trim() || null,`  •  components/documents/HoldStrip.tsx:320 — `placeholder="Resolution (optional)"`  •  lib/holds.ts:252 — `audience: { followers: true, roles: ["Admin", "DocCtrl"] },`  •  lib/holds.ts:220-222 — `/** A hold is a stop-work signal — the people working the document must hear it, not discover it.`
```

**Done when.**

- [ ] releaseHold rejects an empty releasedReason (mirroring revertToVersion), and both UIs disable Release until one is typed
- [ ] notifyHoldChange adds the hold's opened_by to `audience.involved` so the person who stopped work is always told it resumed
- [ ] The ["Admin","DocCtrl"] audience is read from the org's role model / capability policy rather than a literal array, and a failed emit is at least logged rather than silently swallowed

**Resolution (2026-09-23, Round F).** P5 HOLDS. Reproduced (`released_reason: input.releasedReason?.trim() || null`; "Resolution (optional)" on both surfaces with Release enabled on empty; `catch { /* best-effort */ }`; `roles: ["Admin", "DocCtrl"]`; no `involved`).
- **Reason required** — `releaseHold` refuses a blank `releasedReason` before any write (the input type is now required; mirrors `revertToVersion`); both UIs label the field required and keep Release disabled until typed; the 20261073 guard refuses a release without one at the database, so a write outside `lib/holds.ts` meets the same rule.
- **The opener is told** — `notifyHoldChange` takes `involved`; the release passes `[row.opened_by]`.
- **The audience is read from the policy, not a literal** — `holdPoolFromMembers(policy, members)` (pure) admits the members the org's `holds.release` entry names (role tokens expanded against the held collection, "Engineer" = every tier) plus live per-person grants; the shipped wildcard default (`*`) and an empty list fall back to the controller tier — `isControllerRole` from `lib/permissions.ts`, what `is_org_controller` means — because a stop-work broadcast to a whole org on every change is noise, and that pair is exactly the pool this module hard-coded before, so an unconfigured org's behaviour is unchanged. `emit` receives `involved` + `followers`, no `roles` key. Judgment recorded as a DEC-35 landed note: the escalation pool IS the policy's release pool; the wildcard means "no dedicated pool", not "tell everyone".
- **A failed emit is logged** — `console.warn("[holds] hold_released notification failed (non-blocking)", e)`; the hold write is never undone by it.

**Done-when.** (1) ✓; (2) ✓; (3) ✓.
- Tests: `lib/__tests__/holds.test.ts` "HLD-10 / HLD-5 — releaseHold" (a blank / undefined reason throws before any call; opener + pool in `involved`, followers true, `roles` undefined; a failed emit is logged), "HLD-8 / HLD-10 — holdControlsFor and the policy-derived audience" (wildcard → controllers including an additive DocCtrl; named tokens expanded; grants added, expired dropped; no `roles: ["Admin", "DocCtrl"]` literal left in `lib/holds.ts`), and the source pins on both surfaces (required placeholder, disabled-until-typed).
- Files: `lib/holds.ts`, `components/documents/HoldStrip.tsx`, `app/(protected)/admin/holds/page.tsx`, migration `20261073` (the database half of the reason rule).

**Scope / residual.** The service-role ticket-close release supplies its own reason ("Released on close of ticket …") and is unchanged.

---

<a id="hld-11"></a>

## HLD-11 · The document timeline discards the HOLD_OPENED / HOLD_RELEASED audit rows in favour of the mutable document_holds rows, so deleting or editing a hold row erases the hold from the document's visible history

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/timeline.ts:346-357`, `lib/timeline.ts:464-470`, `lib/timeline.ts:124-169`, `supabase/migrations/20260901_db_hard_enforcement.sql:103-105`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the timeline's only hold source is the mutable row, and the immutable audit twin is filtered out unconditionally. Partial mitigation the finding does not mention — the discarded HOLD_OPENED/HOLD_RELEASED audit rows still render in /admin/audit (page.tsx:69) and /activity (page.tsx:51), so the fact is recoverable org-wide, just not on the document's own timeline. MEDIUM still fits.

**Mechanism.** Both timeline builders filter the immutable audit rows out and render the mutable table instead: `.filter((r) => r.action !== "HOLD_OPENED" && r.action !== "HOLD_RELEASED")` (timeline.ts:351 and again at 467), with the stated reason "the hold rows themselves carry richer detail (duration, reason)" (timeline.ts:346-349). `holdRowsToEvents` then synthesises the two events purely from the row's current column values (timeline.ts:131-166). Combined with the previous finding — the row is freely UPDATE-able by anyone with holds.release and DELETE-able by any controller (`CREATE POLICY document_holds_delete ON document_holds FOR DELETE USING (is_org_controller(org_id));`, 20260901:103-105) — the document's own history becomes derived from an editable record while the true audit rows sit in audit_logs and are deliberately suppressed. Deleting the hold row makes the timeline show that the hold never existed. This also means `released_reason` never appears in a timeline summary line (it is only in `details`, timeline.ts:161-164), so the resolution text a releaser typed is invisible in the feed.

**Failure scenario.** An incident review pulls the drawing's timeline to reconstruct why a superseded sheet reached the field. A controller had, weeks earlier, deleted the awkward "Field Verification Needed" hold row rather than releasing it. The timeline shows a clean rev-up with no hold ever placed. The HOLD_OPENED audit_logs row is still in the database, and the reviewer never sees it because the timeline filters that action out by name.

**Evidence.**

```
lib/timeline.ts:346-352 — `// Holds and the matching HOLD_OPENED / HOLD_RELEASED audit rows` / `// describe the same fact pair. To avoid double-rendering, drop the` / `// audit rows whose action is one of the hold-event kinds …` / `const auditEvents = ((auditResult.data as AuditRow[]) ?? []).filter((r) => r.action !== "HOLD_OPENED" && r.action !== "HOLD_RELEASED").map(auditRowToEvent);`  •  lib/timeline.ts:126-129 — "Audit events with action HOLD_OPENED/HOLD_RELEASED also exist (fired by lib/holds.ts), but those carry the actor metadata; the version emitted here carries the duration and reason fields denormalized for the renderer."
```

> **Verifier correction.** Downgraded HIGH→MEDIUM because a mitigation the finding misses: the suppressed audit rows are NOT invisible product-wide. app/(protected)/admin/audit/page.tsx:69-70 and app/(protected)/activity/page.tsx:51-52,196 both render HOLD_OPENED / HOLD_RELEASED audit_logs rows (the audit page even resolves the document label, :141-149, and exports to CSV, :229). So deleting a document_holds row erases the hold from the DOCUMENT timeline only; the immutable trail survives in two other org-level views.

**Done when.**

- [ ] The dedup keys on holdId (audit details.holdId ↔ document_holds.id) rather than on action name, so an audit row with no surviving hold row is still rendered
- [ ] A HOLD_OPENED audit row whose hold row is gone renders as an explicit "hold record removed" event
- [ ] released_reason is surfaced in the release event's summary line, not only in details

**Resolution (2026-09-23, Round F).** Reproduced at `lib/timeline.ts` (both builders: `.filter((r) => r.action !== "HOLD_OPENED" && r.action !== "HOLD_RELEASED")`). Replaced with a pure `mergeHoldHistory(auditRows, holdRows)` used by `getDocumentTimeline` and the project timeline: the dedup keys on the HOLD ID (`audit.details.holdId` ↔ `document_holds.id`, which `logHoldEvent` has always written). An audit row whose hold row survives is dropped (the richer row renders it, as before); an audit row whose hold row is GONE renders — in the hold lane (`kind: "hold"`), as an explicit `HOLD_RECORD_REMOVED` event ("Hold opened — <reason> — hold record removed (the audit row is the only surviving evidence)" / "Hold released — <reason> — "<released reason>" — hold record removed"), keeping the audit twin's actor and carrying `originalAction` + `holdRecordRemoved: true` in details; an audit row with no `holdId` cannot be correlated and is kept as an ordinary audit event rather than dropped. `released_reason` is now in the release event's summary line (`Hold released — <reason> (Nd) — "<released reason>"`), not only in details. Deleting the mutable row can no longer make the document's own history show a hold never happened. **Review fix (Round F review, major):** "gone" was first inferred from the WINDOWED holds query — both builders page `document_holds` at `limit` by `opened_at desc` (the project builder pools the page across every linked document), so a long-lived hold released recently sat inside the audit window and outside the holds page and was rendered as "hold record removed" while its row existed. Now `holdIdsReferencedBy(auditRows)` collects the ids the window's hold audit rows point at, `lookupExistingHoldIds` fetches `document_holds.select("id").in("id", …)` UNPAGED for the ids the page lacks, and `mergeHoldHistory(auditRows, holdRows, existingHoldIds)` declares a record removed only when that targeted lookup returned nothing; a hold that exists but is outside the page is kept as an ordinary audit event, and a `null` lookup (none run) never declares removal. Absence from a page is no longer read as deletion.
- Files: `lib/timeline.ts` (`mergeHoldHistory`, `holdIdsReferencedBy`, `lookupExistingHoldIds`, `holdRowsToEvents`, `HOLD_RECORD_REMOVED`; `AuditRow` / `HoldRow` exported for the test)
- Tests: `lib/__tests__/timelineHolds.test.ts` — surviving hold → audit dropped; deleted hold (lookup empty) → explicit removed event in the hold lane with actor and reason; dedup by id not name (another surviving hold does not hide the deleted one); a hold outside the page but confirmed by the lookup → plain audit event, never "record removed"; `null` lookup → nothing removed; `holdIdsReferencedBy`; no-holdId row kept; non-hold rows pass through; released_reason in the summary; both builders route through the merge and the by-name filter is gone. Builder-level through a paging supabase mock: `getDocumentTimeline` with `limit: 1` keeps a surviving off-page hold as a plain `HOLD_RELEASED` and looks up exactly the missing id; the same row with the hold deleted renders `HOLD_RECORD_REMOVED`; nothing missing → no lookup issued; `getProjectTimeline`'s pooled page on a two-document project does not turn a surviving hold into "record removed".

**Done-when.**
- ✓ The dedup keys on `holdId` rather than on action name, so an audit row with no surviving hold row is still rendered.
- ✓ A `HOLD_OPENED` (and `HOLD_RELEASED`) audit row whose hold row is gone renders as an explicit "hold record removed" event — "gone" confirmed by a targeted unpaged lookup of the referenced ids, so a hold outside the 100-row page is never mislabelled.
- ✓ `released_reason` is surfaced in the release event's summary line.

**Scope / residual.** Rendering only — the row's mutability and controller-deletability are HLD-5's (P5, `20261073`). `TimelineFeed` draws `kind: "hold"` events with the existing hold icons, so the removed-record event needs no new renderer case. The existence check is one extra round trip per timeline build, issued only when the audit window references a hold id the holds page lacks. No migration.

---

<a id="hld-12"></a>

## HLD-12 · The hold-enforcement and legal-hold-guard functions are SECURITY DEFINER with no SET search_path, and supabase/schema.sql creates document_holds with no RLS enabled and no policy

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260822_review_completion_guard.sql:21-22`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:17-18`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:37-38`, `supabase/migrations/20260828_integrity_hardening.sql:39-54`, `supabase/schema.sql:564-588`, `supabase/schema.sql:1011-1028`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every cited fact checks out. Two caveats on impact, not accuracy: the search_path vector needs a role able to CREATE a schema on the search_path, which `authenticated` normally lacks in Supabase; and any database that ran 20260612_phase5_holds.sql:79-85 has RLS + policy on document_holds, so the schema.sql gap bites only a bootstrap-from-schema.sql deployment. MEDIUM is still fair given the repo's own DIAGNOSE_sync_check.sql exists precisely because migration drift happens here.

**Mechanism.** Four functions on the hold-enforcement path declare SECURITY DEFINER without pinning the schema: `CREATE OR REPLACE FUNCTION enforce_document_publish_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$` (20260822:21-22 — the current definition, which is the one carrying the `document_holds … released_at IS NULL` check), `enforce_legal_hold_delete_guard()` (20260826:17-18), `enforce_legal_hold_version_delete_guard()` (20260826:37-38), and `publish_revision(...) LANGUAGE plpgsql SECURITY DEFINER` (20260828:53-54). The sibling functions written in the same period do pin it — `org_capability_allows(...) STABLE SECURITY DEFINER SET search_path = public` (20260901:29), `acl_index_denies(...) SET search_path = public` (20260901:128), `user_can_publish_on_library(...) SET search_path = public` (20260812:37) — so this is an inconsistency, not a house style. Separately, `supabase/schema.sql` — headed "Run this in the Supabase SQL editor to set up your database" — creates document_holds and its five indexes (schema.sql:564-588) but its ROW LEVEL SECURITY block (schema.sql:1011-1028) omits `ALTER TABLE document_holds ENABLE ROW LEVEL SECURITY` and defines no policy for it; RLS on the table exists only in 20260612 / CATCHUP / 20260901.

**Failure scenario.** search_path: an unpinned SECURITY DEFINER function resolves `document_holds`, `org_members` and `documents` against the caller's search_path. Any path that lets a role prepend a schema turns the hold check into a lookup against attacker-controlled objects, and the trigger that refuses to publish over a hold silently returns clean. RLS: an environment bootstrapped from schema.sql alone (a demo, a staging rebuild, a self-hosted install following the file's own instruction) has document_holds with RLS disabled — every hold in every org readable and writable by any authenticated user — until the 20260612/20260901 migrations are also applied. I cannot observe deployment order from the repo, hence SUSPECTED for the consequence; the omissions themselves are confirmed in the files.

**Evidence.**

```
supabase/migrations/20260822_review_completion_guard.sql:21-22 — `CREATE OR REPLACE FUNCTION enforce_document_publish_guard()` / `RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$` (compare 20260901:29 — `RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$`)  •  supabase/schema.sql:564 — `CREATE TABLE IF NOT EXISTS document_holds (` with no matching entry in the `ALTER TABLE … ENABLE ROW LEVEL SECURITY` block at schema.sql:1017-1028  •  supabase/schema.sql:2 — `-- Run this in the Supabase SQL editor to set up your database.`
```

> **Verifier correction.** SUSPECTED is the right label and should be kept for both halves. Exploiting an unpinned search_path requires an attacker able to set search_path for the session and create shadowing objects in a schema on that path — not demonstrable from the repo. The schema.sql omission is likewise conditional on someone bootstrapping from schema.sql alone; note also that schema.sql's RLS block covers only ~18 core tables and omits many later ones (milestones and others), so this is a general property of a partial bootstrap file rather than a document_holds-specific mistake.

**Done when.**

- [ ] enforce_document_publish_guard, enforce_legal_hold_delete_guard, enforce_legal_hold_version_delete_guard and publish_revision are re-created with SET search_path = public
- [ ] schema.sql enables RLS on document_holds and carries the capability-gated policies, or its header states unambiguously that the migrations are mandatory and schema.sql alone is not a complete install
- [ ] A check exists (script or test) that every SECURITY DEFINER function in supabase/ pins search_path

**Resolution (2026-09-23, Round F).** Verified against current code first, limb by limb. (1) search_path: `enforce_document_publish_guard` is re-created by `20261060` with `SECURITY DEFINER SET search_path = public` at creation; `publish_revision`'s current 11-argument definition (`20261049`, from `20261019`) is pinned at creation — `lib/__tests__/searchPathPin.test.ts` asserts exactly this; `enforce_legal_hold_delete_guard()` and `enforce_legal_hold_version_delete_guard()` (last defined in `20260826` without the pin) are pinned after the fact by `20261020_pin_search_path.sql` (`ALTER FUNCTION … SET search_path = public`, lines 52-53), which the roles-and-permissions rounds recorded as applied live. So done-when 1 was already closed by DB-6 / `20261020` — record-only here, no re-creation (re-creating a live function only to restate a pin it already has would be the DB-8 fork risk for nothing). (2) schema.sql: fixed under `PKG-14` (the same defect on 24 tables) — `document_holds` now has `ENABLE ROW LEVEL SECURITY` in schema.sql's BOOTSTRAP RLS block (its capability-gated policies stay in `20260612` / `20260901`, the source of truth), and the header states unambiguously that the migrations are mandatory and schema.sql alone is not a complete install. (3) The check: `lib/__tests__/searchPathPin.test.ts` (DB-6) replays the whole migration set and fails when any live SECURITY DEFINER function's final definition is unpinned and not covered by `20261020`; `lib/__tests__/schemaBootstrapCensus.test.ts` (PKG-14) covers the RLS half.
- Files: `supabase/schema.sql` (shared with PKG-14). Tests: `lib/__tests__/schemaBootstrapCensus.test.ts` (asserts `document_holds` is in the block); `lib/__tests__/searchPathPin.test.ts` (existing, unchanged — the standing check).

**Done-when.**
- [x] enforce_document_publish_guard, enforce_legal_hold_delete_guard, enforce_legal_hold_version_delete_guard and publish_revision are re-created with SET search_path = public ✓ — already true live: two at creation (`20261060`, `20261049`), two via `20261020`'s ALTER (equivalent — `pg_proc.proconfig` carries the pin either way); verified, not re-created.
- [x] schema.sql enables RLS on document_holds and carries the capability-gated policies, or its header states unambiguously that the migrations are mandatory and schema.sql alone is not a complete install ✓ (RLS enabled; header statement; the policies deliberately stay in the migrations per DB-8).
- [x] a check exists (script or test) that every SECURITY DEFINER function in supabase/ pins search_path ✓ (`searchPathPin.test.ts`).

**Scope / residual.** None. Verification stays SUSPECTED as the record's verifier asked (the consequence needs a role able to create schemas on the search_path).

---

<a id="hld-13"></a>

## HLD-13 · The printed equipment QR label promises "SCAN: drawings · holds · report a problem" but targets the login-walled /assets/[tag] route — the one printed artifact that advertises hold visibility in the field is the one that cannot be scanned by field staff

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/physicalBridge.ts:84`, `lib/physicalBridge.ts:99`, `app/(protected)/assets/[tag]/page.tsx:1`, `app/(protected)/layout.tsx:27-45`, `lib/physicalBridge.ts:219-221`, `lib/physicalBridge.ts:272-275`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the two other printed artifacts were explicitly repointed to unauthenticated /verify-* pages and the equipment label was not. One detail is imprecise — there is no middleware and no explicit redirect, so an anonymous scanner gets the app shell with an empty asset page rather than a literal sign-in screen; the outcome (no drawings, no hold badge for field staff) is the same.

**Mechanism.** `printEquipmentLabels` builds the sticker's QR as `const url = \`${origin()}/assets/${encodeURIComponent(asset.tag)}\`;` (physicalBridge.ts:84) and prints the promise `page.drawText("SCAN: drawings · holds · report a problem", …)` (physicalBridge.ts:99). That route lives at `app/(protected)/assets/[tag]/page.tsx`, inside the `(protected)` group whose layout renders an "Authenticating…" gate and requires a resolved membership (app/(protected)/layout.tsx:27-45). There is no public /assets route — `find app -maxdepth 3 -type d -name assets` returns only `app/(protected)/assets` and `app/(protected)/admin/assets`. The file's own history shows the team already learned this lesson twice for the other artifacts: the traveler comment says "the person holding the folder in the field has no account; sending them to the protected app was a login wall" (physicalBridge.ts:219-221) and the package cover says "the old /packages target was a login wall under the words 'SCAN BEFORE STARTING WORK'" (physicalBridge.ts:272-275). The equipment label was never migrated, and it is the only artifact that names holds.

**Failure scenario.** Every pump and exchanger in the unit carries a sticker that says scanning it shows drawings and holds. An operator who notices something wrong scans the label on E-204, lands on a sign-in screen, has no account, and gives up. The hold badge that the /assets/[tag] page renders (line 215) — the one place in the product where a hold is visible next to an equipment tag — is unreachable by exactly the audience the sticker was printed for.

**Evidence.**

```
lib/physicalBridge.ts:84 — `const url = \`${origin()}/assets/${encodeURIComponent(asset.tag)}\`;`  •  lib/physicalBridge.ts:99 — `page.drawText("SCAN: drawings · holds · report a problem", { x: tx, y: y + pad + 2, size: 7, font: bold, color: MUTED });`  •  lib/physicalBridge.ts:272-275 — `// PUBLIC verify page — the crew member scanning in the field has no` / `// account; the old /packages target was a login wall under the words` / `// "SCAN BEFORE STARTING WORK".`
```

> **Verifier correction.** Downgraded HIGH→MEDIUM on consequence (a field scan hits a login wall — a dead-end, not a wrong document-control answer), and one claim is wrong: this is NOT "the only artifact that names holds". printHoldCard (physicalBridge.ts:141-166) is an entire artifact about a hold and correctly targets the PUBLIC `${origin()}/verify-hold/${holdId}` (:164). The accurate statement is that the equipment label is the only artifact promising hold visibility that was never migrated off the protected route.

**Done when.**

- [ ] The equipment label QR points at a public tag page (mirroring /verify, /verify-hold, /verify-package) that shows current revisions and any active holds for the tag's documents, or the label text stops promising hold visibility
- [ ] The public tag surface follows the same minimal-facts contract as the other verify routes
- [ ] A test asserts the printed QR target is not under the (protected) route group

---

<a id="hld-14"></a>

## HLD-14 · expected_release_at is never written by any caller, so the "+Nd late" stale-hold indicator can never fire — and no cron or escalation exists for a hold that has been open for months

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/documents/HoldStrip.tsx:14-17`, `components/documents/HoldStrip.tsx:268-270`, `components/documents/HoldStrip.tsx:284`, `app/(protected)/admin/holds/page.tsx:173-174`, `app/(protected)/admin/holds/page.tsx:194`, `lib/holds.ts:75`, `lib/holds.ts:122`, `vercel.json:3-13`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct — the '+Nd late' badge is unreachable dead UI and no escalation exists. Severity is too high: nothing is corrupted or wrongly permitted, and the same need is served by the surface the finding itself points at — /admin/holds sorts oldest-first (lib/holds.ts:289 'oldest first — biggest blockers up top') and shows a 'Longest open' KPI. That is a missing proactive nudge plus a dead optional field, i.e. LOW.

**Mechanism.** `openHold` accepts `expectedReleaseAt?: string` and writes `expected_release_at: input.expectedReleaseAt ?? null` (holds.ts:75,122), but neither of the two callers passes it: `HoldStrip.onOpen` sends `{ orgId, documentId, reason, openedBy, openedByName, openedByEmail, openedByRole }` (HoldStrip.tsx:86-93) and `CheckInPanel` sends `{ orgId, documentId, reason: "Field Verification Needed", notes, openedBy, openedByName, openedByEmail, openedByRole }` (CheckInPanel.tsx:366-371). Two differently-shaped searches confirm: `grep -rn "expectedReleaseAt|expected_release_at"` over all .ts/.tsx shows every other hit belongs to checkout_sessions, not holds; and `grep -rn "openHold"` returns exactly those two call sites plus lib/holds.ts. The only other writer is `copyActiveHoldsToDoc`, which propagates whatever the source held — always null. Both consumers therefore evaluate dead branches: `const expectedMs = hold.expectedReleaseAt ? … : null; const isLate = expectedMs !== null && nowMs > expectedMs;` (HoldStrip.tsx:268-269) and the same at admin/holds:173-174. The HoldStrip header describes it as shipped behaviour: "Stale indicator: when an active hold has gone past its expected_release_at, the duration label switches to red … the directive's 'schedule variance visibility' in its lightest form" (HoldStrip.tsx:14-17). There is no compensating escalation: `grep -n "hold|Hold" app/api/cron/maintenance/route.ts` returns only two unrelated comment lines, and vercel.json declares only the data-export and maintenance crons.

**Failure scenario.** A "Missing Vendor Data" hold is opened in March. The vendor never responds. Nothing ever turns red, nothing renudges, no digest names it. The only signal is the /admin/holds "Longest open" KPI, which someone has to go look at. In September the drawing is still stopped and the only people who know are the ones who remember. Note also that adding a cron here is constrained — a third vercel.json entry fails deployment on this plan (app/api/cron/maintenance/route.ts:286-291) — so the aging sweep must ride inside the existing maintenance route.

**Evidence.**

```
components/documents/HoldStrip.tsx:14-17 — `//   - Stale indicator: when an active hold has gone past its` / `//     expected_release_at, the duration label switches to red and` / `//     prefixes with "+Nd late" — the directive's "schedule` / `//     variance visibility" in its lightest form.`  •  components/documents/HoldStrip.tsx:86-93 — the openHold call, with no expectedReleaseAt key  •  components/documents/HoldStrip.tsx:284 — `{isLate && <span className="ml-1 font-bold text-red-700">(+{lateDays}d late)</span>}`  •  lib/holds.ts:122 — `expected_release_at: input.expectedReleaseAt ?? null,`
```

**Done when.**

- [ ] The hold picker offers an expected-release date (optional but prompted for the four predefined reasons) and passes it through openHold
- [ ] An aging sweep inside the EXISTING /api/cron/maintenance route nudges the opener and the doc-control pool on holds past expected_release_at, and on holds older than a configured age when no date was set — no new vercel.json cron entry
- [ ] The HoldStrip header comment matches what actually ships

**Resolution (2026-09-23, Round F).** P5 HOLDS. Reproduced: no caller passed `expectedReleaseAt`; `grep -n "hold" app/api/cron/maintenance/route.ts` → two unrelated lines.
- **The picker prompts** — a predefined reason now opens an inline confirm row with an optional "Expected release" date (min today) and places the hold on the second click; "Other…" carries the same optional date. `expectedReleaseIso(date)` (pure, `lib/holds.ts`) stores the END of that local day, so a hold expected "by Friday" is not late at 00:01 Friday; blank / malformed / impossible dates store nothing. The `CheckInPanel` offer (P6's file) is unchanged — a check-in's hold has no date and is nudged by age.
- **The aging sweep** — `scanStaleHolds(orgId, now)` in `lib/holds.ts`, registered as the `hold-aging` compliance scan in the EXISTING `/api/cron/maintenance` route (one line; no third `vercel.json` entry — the route's own step-10 note says a third entry fails deployment). Per org, every open hold past `expected_release_at`, or with no date and older than `HOLD_AGING_DAYS` (30; env-overridable), tells the opener and the policy-derived release pool ONCE PER MISSED EXPECTATION (deduped by `metadata.staleHoldId` + `metadata.staleFor` — the `expected_release_at` it missed, or `"age"` for an undated hold — the `escalateStaleCheckouts` shape widened by the expectation, because the nudge asks the opener to set a new date and `expected_release_at` stays writable on an open hold; when the new date passes too, the hold is nudged again instead of aging silently; kind `hold_opened`, category `sla`, link to the document). Failures surface as `hold-aging@<org>: …` in the cron result like every other scan.
- **The header comment** now describes what ships: the indicator fires only for holds given a date; the cron nudges the rest by age.
- **The nudge's remedy exists (fix pass 2).** The nudge bodies say "set a new expected date" / "record when it is expected to clear"; before this pass no surface could write `expected_release_at` on an existing hold (only the two INSERT sites), so a hold was nudged exactly once per expectation and then aged silently. `updateHoldExpectedRelease(holdId, iso | null)` (`lib/holds.ts`) writes that one column under the `released_at IS NULL` predicate (a released hold is closed history; null clears the date and the hold falls back to the age nudge), gated on `holds.release` — the capability the `document_holds` UPDATE policy (20260901) gates every update on, and exactly the column the 20261073 guard admits on an open row (DEC-25). Both surfaces carry an inline "Re-date" control beside Release, shown by the same `canRelease` that lights Release (the strip: `canRedate={showRelease}`; the queue: `canRelease && …`): a date input seeded from the stored date (`expectedReleaseDate`, the local-day inverse of `expectedReleaseIso`), "Save date" / "Clear date". The re-dated hold is nudged again when the new date passes (the `staleFor` key).

**Done-when.** (1) ✓ (optional, prompted for the four predefined reasons, offered on "Other…" too); (2) ✓ inside the existing route; (3) ✓.
- Tests: `lib/__tests__/holds.test.ts` "HLD-14" (`expectedReleaseIso` end-of-day / blank / malformed / Feb 31; `updateHoldExpectedRelease` writes only `expected_release_at` under the `released_at IS NULL` predicate, null clears, a released hold is refused and untouched, no HOLD_* audit row and no notification, `expectedReleaseDate` round-trips the picker's instant to the same local day; both surfaces carry the Re-date control gated on the release authority and write through `updateHoldExpectedRelease`, seeded from the stored date, blank clears; the nudge bodies still ask for a new date; the scan nudges late + aged once with opener and pool, skips young / future / released / other-org / already-nudged, nudges a re-dated hold and an aged-then-dated hold a second time, writes the key it reads (`staleFor`), an id-only key no longer suppresses, correct titles and link, idempotent second run; the route registers the scan and `vercel.json` still has two crons; `HoldStrip` passes `expectedReleaseIso` through and its header names the sweep).
- Files: `components/documents/HoldStrip.tsx`, `lib/holds.ts`, `app/api/cron/maintenance/route.ts`. No migration.

**Scope / residual.** The "configured age" is a deployment constant with an env override, not per-org configuration — a follow-up if a facility wants it per org. The 20261073 before-apply inventory counts the open holds with no date (the age-nudge population). A re-date writes no audit row (`logHoldEvent`'s type union is HOLD_OPENED / HOLD_RELEASED and the timeline is HLD-11 / P6's; the guard pins everything else on the row, so the only thing a re-date can change is the date) and sends no notification. `CheckInPanel`'s hold offer (P6's file) has no date at open time; it can be dated afterwards from the inspector strip. A notification written before the dedupe-key fix (id-only key) does not suppress: each previously-nudged hold gets one more nudge, then dedupes.

---
