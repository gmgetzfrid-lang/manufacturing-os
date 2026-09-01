# 02 · Revisions, publish & supersession

**14 findings** — 2 CRITICAL · 4 HIGH · 8 MEDIUM.

Every path to a published revision, and which ones skip the guard.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| `publish_revision` v2 — the transactional, per-document-serialized publish. `SELECT * INTO v_doc FROM documents WHERE id = p_doc FOR UPDATE` serializes concurrent publishes; the `p_expected_base` check returns `stale_base` with the interloper's identity BEFORE anything is written; the promote (version insert + `superseded_at` stamp + pointer flip + label roll) is one transaction. The lock/hold split introduced in 20260828 is correct and deliberate: `p_override_lock` passes the lock and never a hold, `p_force` is controller-only. | `supabase/migrations/20260828_integrity_hardening.sql:39-204` | This is the single most important piece of document-control machinery in the repository and it is well built. Several findings above are about paths that go AROUND it (the legacy fallback, finalize-after-review, split/merge creation, direct PostgREST writes) — none are reasons to weaken the RPC itself. Any fix must route MORE traffic through it, never less. |
| The stale-base conflict experience end to end: the pre-flight check that avoids an orphaned upload (revisions.ts:453-477), the structured `StaleBaseError` carrying who moved it and their change narrative, the `REV_CONFLICT_BLOCKED` audit row written when the contract fires, and the conflict screen that offers diff / message-the-other-publisher / publish-as-branch instead of an error string. | `lib/revisions.ts:51-69,453-477,556-585; components/documents/RevUpModal.tsx:323-329,367-490` | The design intent — a lost update is a conversation, not an exception — is fully realised here. The branch escape hatch needs a review gate (finding 6) and the branch label needs to be unique (same finding), but the conflict flow itself should not be redesigned. |
| `runPostPublishSideEffects` as the single shared pipeline every current-revision change runs: stale-copy signal to live intent holders and watchers, work-package pin-drift alerts, one-hop revision-impact warnings, stale link-proposal retirement, and the compliance clocks (review cycle, ack roster, retention). Called by `revUpDocument`, `revertToVersion` and `finalizeReviewedRevision` alike. | `lib/postPublish.ts:91-145; lib/revisions.ts:711-716,1304-1309; lib/reviewControl.ts:499-509` | Its own header records that finalize and revert used to skip it — the divergence has been fixed and must not regress. When adding a new publish path (e.g. gating split/merge through review), wire it to this function rather than reimplementing the side effects. |
| `submitForReview`'s compare-and-set on the pending pointer: it reads `existingPendingId`, inserts the draft, then updates `documents` with `.eq("pending_version_id", existingPendingId)` (or `.is(..., null)`), and if zero rows matched it retires its own just-inserted draft and throws a human message. Correctly prevents two live drafts each with a full reviewer roster. | `lib/revisions.ts:902-924` | This is the CAS discipline the rest of the module needs and mostly lacks — `finalizeReviewedRevision` CASes only on `pending_version_id` and not on `current_version_id` (finding 4). Use this as the template rather than inventing a new one. |
| `/api/verify` — the unauthenticated QR endpoint. It validates both UUIDs before touching the database, refuses a version id that does not belong to the named document (`vr.record_id !== docId` → clean 404), returns only revision-status facts and no URLs or people, treats `Superseded`/`Archived` as not-current, and has a distinct `notYetEffective` state so a future effective date never flashes an unqualified green. | `app/api/verify/route.ts:20-108` | This is the last line of defence for a paper print and it is correct. Findings 2 and 14 are about callers feeding it the wrong version id or not reaching it at all — the endpoint's own logic should be left alone (except for adopting whichever single timezone definition wins in finding 8). |
| `setLevelRevUp`'s per-sheet review-gate resolution: it calls `effectiveReviewControlForDocument` + `effectiveModeForRevUp` for every sheet and routes to `submitForReview` or `revUpDocument` accordingly, defaulting `publisher_choice` to the safe side because a batch has no per-sheet checkbox — with an in-code note that this was a previously-found bypass. | `lib/documentLifecycle/setRevUp.ts:71-92` | It is the worked example of how split, merge and `createDocumentWithFile` should resolve the review gate (finding 10). Copy this shape; do not invent a second policy resolver. |
| `withCompensation` — the saga/compensating-rollback harness used by split and merge, with `archiveRolledBackDoc` and `restoreSupersededSource` as the registered compensations, and the deliberate choice to Archive rather than hard-delete so the creation audit row stays consistent and the partial UNIQUE on `document_number` frees the number for a retry. | `lib/documentLifecycle/common.ts:20-119; lib/documentLifecycle/split.ts:96-153; lib/documentLifecycle/merge.ts:82-213` | A genuinely thoughtful answer to "supabase-js cannot open a transaction and R2 cannot join one anyway." `restoreSupersededSource` already takes and honours a `priorStatus` argument — which is exactly what `reverseSplit`/`reverseMerge` should be doing (finding 13). The harness is sound; only the reversal path bypasses it. |
| The server-side share pipeline: `/api/share/file` pulls bytes server-side (no CORS fallback that could leak the raw file), applies the UNCONTROLLED watermark + rev footer + verify QR with the REAL `versionId` before any byte leaves, and both share routes exclude in-review drafts on their fallback branch via `.or("review_state.is.null,review_state.eq.approved")`. | `app/api/share/file/route.ts:61-116; app/api/share/resolve/route.ts:52-70` | The draft-exclusion and the correct per-version QR are precisely what the in-app viewer download path gets wrong (finding 2). This route is the reference implementation; the missing status check (finding 14) is an addition to it, not a rewrite. |
| `checkRevLabelCorrection` — pure, unit-testable label validation with no database dependency: blank check, 24-character cap, refusal on in-review drafts (their labels belong to the review workflow), no-op detection, and case-insensitive uniqueness against every sibling label in the chain. | `lib/revisions.ts:1006-1029` | The right factoring for revision-label rules, and the in-review exclusion is the check the revert button is missing (finding 3). Reuse this predicate rather than adding a fourth place where label rules live. |


---


<a id="rev-1"></a>

## REV-1 · Downloading or printing an old revision stamps, names, QR-links and audits it as the CURRENT revision — and the checkout holder gets it raw, unstamped

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 2 — the field-verdict cluster).** Confirmed against current code. `lib/downloads.ts` was rebuilt to describe the SERVED version rather than the document's current rev, correct-by-construction:
- `DownloadContext` gained `versionRev` (the served bytes' label) and `versionIsCurrent`. `defaultFilename`, `buildFooterNotice`, `buildVerifyUrl` and the audit/intent writes all take the served version; an old-revision copy is stamped "SUPERSEDED REVISION — Rev N … do not use for construction", filed as `_RevN`, QR-linked with `?v=<that version>`, and audited against it.
- `determineControlState(doc, userId, versionIsCurrent)` now returns **uncontrolled for any non-current version even for the checkout holder** — so a superseded drawing can never walk to the field unstamped (Done-when 2).
- The chain reaction is closed: a non-current pull records a `reference` intent, never an `edit` base, so a draft on superseded bytes no longer passes the stale-base contract.
- All three callers pass the served version: `FullScreenViewer` gained a `viewingVersionId` prop (wired from `selectedVersion.id` in `documents/[libraryId]/page.tsx`); `VersionHistoryPanel.handleDownload` passes `versionRev`/`versionIsCurrent`; `MultiDocViewer` only ever shows current docs (verifier-confirmed) so needs none.
- Done-when: (1) stamp/filename/QR/audit all describe the served version ✓; (2) a non-current version never takes the controlled branch ✓; (3) the QR on an old-revision print returns `isCurrent: false` — the served version id flows into `/api/verify`, which now also reports Void/Superseded/hold honestly (see `DIST-2`) ✓.
- Files: `lib/downloads.ts`, `components/viewers/FullScreenViewer.tsx`, `components/documents/VersionHistoryPanel.tsx`, `app/(protected)/documents/[libraryId]/page.tsx`
- Tests: `lib/__tests__/downloadsRevLabel.test.ts` — holder gets controlled current / uncontrolled old; footer names the served rev and says SUPERSEDED; QR encodes the served version id.

- **Verification:** CONFIRMED
- **Locations:** `components/viewers/FullScreenViewer.tsx:833-845`, `components/viewers/FullScreenViewer.tsx:1036`, `components/viewers/MultiDocViewer.tsx:689-691`, `lib/downloads.ts:30-37`, `lib/downloads.ts:71-76`, `lib/downloads.ts:80-88`, `lib/downloads.ts:95-102`, `lib/downloads.ts:245-252`, `app/api/verify/route.ts:90`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every limb holds: the viewer renders old bytes against the current DocumentRecord, so filename, footer, QR ?v= and the download_audits row all say Rev 5, and a checkout holder takes the Rev 2 bytes completely unstamped. Partial mitigation the finding did not credit: VersionHistoryPanel's OWN download button (lines 129-165) clones the doc with `checkedOutBy: undefined` to force the uncontrolled stamp and passes the correct `versionId: v.id` — but it still stamps `doc.rev`, so even that path labels Rev 2 bytes as Rev 5.

**Mechanism.** `FullScreenViewer.runDocAction` builds its download context as `const ctx = { doc: docRecord, fileUrl: resolvedUrl ?? url, userId: currentUserId, …, versionId: docRecord.currentVersionId ?? undefined }` (FullScreenViewer.tsx:841-843). `fileUrl` is the OLD revision's file (page.tsx:3028 passes `url={selectedVersion.fileUrl}`); `versionId` is hardcoded to the document's CURRENT version. Everything downstream in lib/downloads.ts then describes the wrong revision: `defaultFilename` builds `${stem}_Rev${doc.rev}` (downloads.ts:71-76); `buildFooterNotice` stamps `Rev ${doc.rev ?? "?"} at time of issue — verify current revision before use.` (downloads.ts:82); `buildVerifyUrl` encodes `?v=${ctx.versionId ?? ctx.doc.currentVersionId}` (downloads.ts:99-101), and `/api/verify` computes `isCurrent = !docRetired && (!versionId || versionId === d.current_version_id)` (route.ts:90) → the QR on a print of Rev 2 answers **"this is current"**; `logDownloadAudit` records `versionId: ctx.versionId ?? ctx.doc.currentVersionId` (downloads.ts:247), so `download_audits` says the current rev was pulled. Worse, `determineControlState(doc, userId)` returns `"controlled"` — the raw, UNSTAMPED pass-through at downloads.ts:222-226 — whenever `doc.checkedOutBy === userId`, and FullScreenViewer honors that unconditionally (FullScreenViewer.tsx:833-834, `isControlled` → `runDocAction` with no confirm). `MultiDocViewer.tsx:689` has the identical `versionId: activeEntry.doc.currentVersionId` shape.

**Failure scenario.** A pipefitter holds the checkout on P-200-301 (current Rev 5). He opens Rev 2 from Version History to compare, then clicks Download. `determineControlState` sees his checkout, takes the controlled branch, and hands him the Rev 2 bytes with **no UNCONTROLLED watermark at all**, saved as `P-200-301_Rev5.pdf`. He prints it, walks it to the field, and the paper carries no mark saying it is superseded. If he had not held the checkout he would have gotten a stamped copy whose footer reads "Rev 5 at time of issue" over Rev 2 geometry, with a QR that, when scanned, returns green "still current". Either way the custody row in `download_audits` says he pulled Rev 5.

**Evidence.**

```
FullScreenViewer.tsx:841-843 — `const ctx = { doc: docRecord, fileUrl: resolvedUrl ?? url, … versionId: docRecord.currentVersionId ?? undefined };`; lib/downloads.ts:82 — `parts.push(\`Rev ${doc.rev ?? "?"} at time of issue — verify current revision before use.\`);`; lib/downloads.ts:35 — `if (doc.checkedOutBy && doc.checkedOutBy === userId) return "controlled";`; lib/downloads.ts:74 — `const rev = doc.rev ? \`_Rev${doc.rev}\` : "";`.
```

**Chain reaction.** `captureDownloadIntent` (downloads.ts:106-121) also records `baseVersionId: ctx.versionId ?? ctx.doc.currentVersionId` — so pulling an OLD revision writes an edit/reference intent anchored to the CURRENT one. `revUpDocument` resolves its expected base from exactly that intent (`getMyEditBase`, revisions.ts:443-450) and classifies the publish as `"declared"`. A revision drafted on top of the Rev 2 bytes therefore passes the stale-base contract cleanly and is not flagged unverified. Note that `VersionHistoryPanel.handleDownload` already solved half of this — it clones the doc with `checkedOutBy: undefined` to force the stamp (VersionHistoryPanel.tsx:150-152) — but does not correct `doc.rev`, so its stamps are wrong too. Fix `buildFooterNotice`/`defaultFilename`/`buildVerifyUrl`/`logDownloadAudit` to take the version being downloaded, not the document.

> **Verifier correction.** Two adjustments, one of which strengthens rather than weakens it. (1) A correct sibling path exists and should be cited as the fix template: VersionHistoryPanel.tsx:129-159 `handleDownload(v)` passes `versionId: v.id` AND clones the doc with `checkedOutBy: undefined` (line 152) to force the uncontrolled stamp — so the per-row download button gets the QR and the audit row right. (2) However, that path is ALSO mis-stamped: `defaultFilename` and `buildFooterNotice` both read `ctx.doc.rev`, never the version label, so even the intended "download this revision" button writes `_Rev<current>` into the filename and watermarks "Rev <current> at time of issue" onto pages that are an older revision's content. The rev-mislabeling half of this finding is broader than the FullScreenViewer, and fixing it requires downloads.ts to take a revision label, not just a versionId. (3) The MultiDocViewer.tsx:689 citation is inert — `stagedDocs` are always current documents there.

**Done when.**

- [ ] The stamp footer, filename, verify QR and `download_audits.version_id` all describe the version whose bytes were served.
- [ ] A non-current version can never take the `controlled` (unstamped) branch, regardless of who holds the checkout.
- [ ] Scanning the QR on a print of an old revision returns `isCurrent: false`.

---

<a id="rev-2"></a>

## REV-2 · Revert accepts an in-review draft or an unreconciled branch as its target — unreviewed bytes become the controlled copy, and the DB review gate cannot see it

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 7c).** Confirmed end to end, including the verifier's corrections (any per-library publisher could do it, not just Admin/DocCtrl; the gap is precisely the missing target filter). Fixed at all three layers:
- **Pure rule** — `assertRevertableTarget` in `lib/documentGuards.ts`: refuses a branch, and refuses any target whose `review_state` is neither null (pre-review-flow issued rows) nor `approved` — so `in_review`, `rejected`, and any FUTURE draft state are all refused, not an enumerated two. `revertToVersion` calls it before `authorizePublish`.
- **DB** — migration `20261034` re-creates `publish_revision` (byte-carrying the 20261031 MOC gate) with the revert-target gate: a payload naming `reverted_from_version_id` requires the target to be a revision of THIS document (a cross-document target was also possible before) and not in-review/rejected/branch; the state check no-ops on a pre-review schema (`undefined_column`). The RPC being directly reachable is why the app-side check alone was insufficient.
- **Panel** — `VersionHistoryPanel` no longer offers revert on drafts or branches, and an in-review draft is no longer falsely badged **"Superseded"** (the chain-reaction finding): it now shows a blue "In review" / "Draft (not issued)" badge. The stale comment claiming "superseded versions only, admin/DocCtrl only" is corrected to what the code does.
- Done-when: (1) server-side refusal (RPC gate) ✓; (2) panel neither offers revert on those rows nor labels an in-review draft "Superseded" ✓; (3) test asserts reverting to an in-review draft fails ✓ (pure-guard tests + migration pins; `current_version_id` untouched because the refusal throws before any write).
- Files: `lib/documentGuards.ts`, `lib/revisions.ts`, `components/documents/VersionHistoryPanel.tsx`, `supabase/migrations/20261034_dc_phase7c_revert_target_gate.sql`.
- Tests: `lib/__tests__/revertTargetGuard.test.ts` (in_review/rejected/future-state/branch refused with reasons; issued and approved pass); `lib/__tests__/revertTargetMigration.test.ts` (belongs-to-document check, draft/branch refusal, undefined_column tolerance, MOC gate + stale-base check carried forward, search_path pin).
- **Applied & verified live 2026-08-24:** `20261034` — 3-point probe all true (revert-target gate present; MOC gate survived the re-create; search_path pinned). A direct RPC call can no longer restore a draft or a branch.
- **What this brought to light:** `resolveBranch` only writes a resolution note — revert was the ONLY promotion path for branch content and is now gated, so branch content currently has NO path to current. That is the safe direction, but the branches area should decide what a real merge/promotion flow looks like. REV-3 (the `-revert-<epoch>` label reaching every footer) remains open and untouched by this fix.

- **Verification:** CONFIRMED
- **Locations:** `components/documents/VersionHistoryPanel.tsx:72`, `components/documents/VersionHistoryPanel.tsx:272-283`, `components/documents/VersionHistoryPanel.tsx:370-378`, `components/documents/RevertConfirmModal.tsx:36-53`, `lib/revisions.ts:1146-1234`, `lib/revisions.ts:1171-1184`, `supabase/migrations/20260822_review_completion_guard.sql:46-58`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed end to end: nothing between the button and the DB inspects the target's review_state or is_branch, and the review-completion trigger structurally cannot see it because it only ever examines the incoming current version. The in-review draft is additionally rendered with the amber "Superseded" badge (:280-283), since that branch is the fall-through for any non-current, non-branch row.

**Mechanism.** `listVersions` is `select("*").eq("record_id", documentId)` (revisions.ts:988-993) — it returns every row, including `review_state='in_review'` drafts created by `submitForReview` and `is_branch=true` rows created by a branch publish. VersionHistoryPanel renders the revert button on any non-current row: `{canRevert && !isCurrent && onRevertVersion && (<button onClick={() => onRevertVersion(v)} …>)}` (line 370-372). There is no `reviewState` or `isBranch` filter — contrast line 360, where the *label-correction* button explicitly excludes drafts with `&& v.reviewState !== "in_review"`. `RevertConfirmModal` passes the target straight through, and `revertToVersion` (revisions.ts:1146-1234) inspects only `targetVersion.id`, `.revisionLabel`, `.fileUrl`, `.fileType`, `.size`, `.issueType`, `.fileHash` — never `reviewState` or `isBranch`. It builds `revertPayload` reusing the target's `file_url` verbatim (revisions.ts:1175, comment: "we do NOT copy the file in storage — the new row points to the same bytes") and publishes it through `publish_revision` with `p_op_class: "content"`. The DB review-completion gate cannot help: it reads `document_review_signoffs WHERE document_version_id = NEW.current_version_id` (20260822:48-52), and `NEW.current_version_id` is the brand-new revert row, which has no roster — so `v_primary_reqs` is 0 and the gate short-circuits.

**Failure scenario.** A `require`-mode drawings library. An engineer submits Rev 3 for review; `submitForReview` creates draft "3A" with `review_state='in_review'` and no `released_at`. Two reviewers have open sign-offs. A Doc Control manager opens Version History and sees three rows: Rev 2 (Current), Rev 3A, Rev 1. Rev 3A is badged **"Superseded"** in amber (line 279-283 — the panel's only non-current, non-branch label) and carries a revert button. He clicks it, types a reason, and confirms. The unreviewed, unsigned 3A bytes become `documents.current_version_id` under the label `3A-revert-1755…`, `runPostPublishSideEffects` fires the full "advanced to Rev" broadcast, and a fresh read-&-understood roster opens against a drawing that no reviewer ever approved. The two open sign-offs on 3A are still pending; `documents.pending_version_id` still points at 3A.

**Evidence.**

```
VersionHistoryPanel.tsx:370 — `{canRevert && !isCurrent && onRevertVersion && (`; VersionHistoryPanel.tsx:360 — the label-correction button next to it DOES filter: `… && v.reviewState !== "in_review" && (`; VersionHistoryPanel.tsx:279-283 — the else branch renders `<ShieldAlert /> Superseded` for every non-current, non-branch row; lib/revisions.ts:1175 — `file_url: targetVersion.fileUrl,`; 20260822_review_completion_guard.sql:52 — `WHERE document_version_id = NEW.current_version_id;`.
```

**Chain reaction.** The same panel labels an in-review draft "Superseded", which is a false document-control statement independent of the revert path — a draft that was never issued cannot be superseded. A branch version is at least badged "Branch" (line 272-278) but is still revertable, which is the one route by which an explicitly-unreconciled branch becomes the controlled copy without ever being merged: `resolveBranch` (lib/branches.ts:344-404) only writes a resolution note and never promotes anything, so revert is the *only* promotion path for branch content — and it is ungated. Filtering the button is not sufficient; `revertToVersion` must refuse a target whose `review_state` is `in_review`/`rejected` or whose `is_branch` is true, because the RPC is reachable directly.

> **Verifier correction.** Two factual corrections that change who can do this and how it is framed. (1) The in-code comment at VersionHistoryPanel.tsx:369 claims "superseded versions only, admin/DocCtrl only" — BOTH halves are false: the guard is only `!isCurrent`, and `canRevert={canPublishEff}` (InspectorPanel.tsx:832), i.e. any per-library publisher, not only Admin/DocCtrl. That comment/behaviour mismatch is itself worth citing. (2) revertToVersion is not unauthorized — it runs `authorizePublish` (revisions.ts:1155-1158) and the RPC's transactional stale-base check (`p_expected_base: previousVersionId`, revisions.ts:1194). The gap is precisely and only the missing reviewState/isBranch filter on the TARGET, so scope the fix there.

**Done when.**

- [ ] `revertToVersion` refuses a target that is an in-review draft, a rejected draft, or an unreconciled branch, server-side.
- [ ] Version History does not offer revert on those rows and does not label an in-review draft "Superseded".
- [ ] A test asserts that reverting to an in-review draft fails and leaves `current_version_id` unchanged.

---

<a id="rev-3"></a>

## REV-3 · Revert writes `<label>-revert-<epoch-millis>` into `documents.rev` — the controlled revision identifier becomes a machine string that reaches every print footer, filename, register row and title block

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/revisions.ts:1169`, `lib/revisions.ts:1171-1184`, `lib/revisions.ts:1265-1272`, `supabase/migrations/20260828_integrity_hardening.sql:186-193`, `lib/downloads.ts:71-76,80-88`, `lib/docControlRegister.ts:96`, `components/documents/VersionHistoryPanel.tsx:263`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Grep for "revert-" across all .ts/.tsx/.sql returns exactly one hit — the construction site. No formatter, no display strip, no migration normalizes it, so the epoch-millis string is the controlled revision identifier everywhere. The only remedy is the manual, audited label-correct button, which is after-the-fact.

**Mechanism.** `revertToVersion` builds `const revertedLabel = \`${targetVersion.revisionLabel}-revert-${Date.now()}\`;` (revisions.ts:1169) and passes it as `revision_label` in `revertPayload` (line 1172). `publish_revision`'s promote then writes it to the parent document: `UPDATE documents SET current_version_id = v_new_id, rev = btrim(v_label), revision = btrim(v_label), …` (20260828:186-190); the legacy fallback does the same (revisions.ts:1268-1270). A repo-wide grep for `revert-` returns exactly one hit — line 1169 — so nothing anywhere strips, prettifies or hides the suffix. `documents.rev` is the string every downstream surface prints: `defaultFilename` → `P-200-301_Rev3-revert-1755823041992.pdf` (downloads.ts:74), `buildFooterNotice` → "Rev 3-revert-1755823041992 at time of issue" watermarked onto every page (downloads.ts:82), the document-control register selects `rev` directly (docControlRegister.ts:96), and Version History renders `Rev {v.revisionLabel}` (VersionHistoryPanel.tsx:263).

**Failure scenario.** Rev 4 of a P&ID is found to have a wrong line class. Doc Control reverts to Rev 3. The document's controlled revision is now `3-revert-1755823041992`. A field print of it carries a watermark footer reading "Rev 3-revert-1755823041992 at time of issue — verify current revision before use." The drawing's own title block says Rev 3. A contractor comparing his paper against the title block cannot tell which revision he holds, the transmittal register shows a 24-character revision, and the `document_versions_active_label_uniq` label is unique but meaningless. Nothing in ASME/ISO revision practice accommodates a millisecond timestamp as a revision identifier.

**Evidence.**

```
lib/revisions.ts:1169 — `const revertedLabel = \`${targetVersion.revisionLabel}-revert-${Date.now()}\`;`; 20260828_integrity_hardening.sql:187-188 — `rev = btrim(v_label), revision = btrim(v_label),`; lib/downloads.ts:82 — `parts.push(\`Rev ${doc.rev ?? "?"} at time of issue — verify current revision before use.\`);`; grep for `revert-` across `lib app components` returns only revisions.ts:1169.
```

**Chain reaction.** `checkRevLabelCorrection` caps labels at 24 characters (revisions.ts:1019) — `3-revert-1755823041992` is 22, so it squeaks past, but a two-character base label like `R3` produces 23 and `Rev3` produces 25, which then cannot be corrected at all through the label-correction path. The right shape is the normal forward one the rest of the module uses: `suggestRevLabel(doc.rev)` with the revert recorded in `change_log`, `change_type: "Correction"` and `reverted_from_version_id` — all three of which the payload already sets (revisions.ts:1177-1181). The uniqueness the timestamp was buying is already provided by the partial unique index.

> **Verifier correction.** Minor: version history does mark such a row with a purple "Revert" pill (VersionHistoryPanel.tsx:290-292, keyed on `v.revertedFromVersionId`), so the string is at least explained inside the app. That does not touch the printed footer, the filename, the register export or the notification text, which is where the harm is.

**Done when.**

- [ ] A revert produces a forward revision label that a drafter would recognise, with the revert recorded in `reverted_from_version_id` and the narrative.
- [ ] `documents.rev` after a revert is a valid revision identifier for a title block and a transmittal.
- [ ] A test asserts the reverted label matches the library's revision scheme.

---

<a id="rev-4"></a>

## REV-4 · The viewer shows a green "Controlled · Rev N" badge while displaying an old/superseded revision — the parameter that exists to prevent this is never passed by either caller

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/downloads.ts:41-53`, `components/viewers/FullScreenViewer.tsx:1184`, `components/viewers/MultiDocViewer.tsx:668`, `components/documents/VersionHistoryPanel.tsx:336`, `app/(protected)/documents/[libraryId]/page.tsx:3024-3032,4238-4241`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The purpose-built guard parameter is dead code — confirmed by repo-wide search, not inference. Mitigation worth noting but not disqualifying: the header two lines above (:1176) simultaneously prints the true `Rev {rev}` of the version being viewed, so the screen contradicts itself rather than being uniformly wrong.

**Mechanism.** `viewerStatusBadge` takes a second parameter with an explicit contract in its own doc comment: `Pass viewingCurrentVersion=false when showing an older/superseded revision (e.g. from version history).` Its signature is `export function viewerStatusBadge(doc: {...}, viewingCurrentVersion = true)` and the very first line of the body is `if (!viewingCurrentVersion) return { label: "Old revision — not current", tone: "caution" };`. A repo-wide grep for `viewerStatusBadge(` returns exactly three hits: the definition, `MultiDocViewer.tsx:668` — `viewerStatusBadge(activeEntry.doc)` — and `FullScreenViewer.tsx:1184` — `viewerStatusBadge({ status: docRecord.status, rev: docRecord.rev ?? rev })`. Neither passes the second argument, so the default `true` always wins and the badge is computed purely from `documents.status`. Meanwhile the very flow the comment names is wired: `VersionHistoryPanel.tsx:336` calls `onOpenVersion(v)` for any row, and `app/(protected)/documents/[libraryId]/page.tsx:4238` sets `selectedVersion` then opens `<FullScreenViewer url={selectedVersion.fileUrl} … document={selectedDoc} />` (page.tsx:3028-3032). The pages rendered are the OLD version's bytes; `docRecord.status` is still `'Issued'`, so the badge resolves to the `case "Issued"` branch and reads `Controlled · Rev <documents.rev>` in emerald.

**Failure scenario.** An operator opens P-200-301 and clicks the eye icon on Rev 2 in Version History to check what a line looked like before the tie-in. The viewer fills with the Rev 2 drawing and the badge in the corner reads, in green, "Controlled · Rev 5". Rev 5 added an isolation valve that Rev 2 does not show. The operator writes the line-break permit from what is on screen, having been told by the application that it is the controlled copy at the current revision.

**Evidence.**

```
lib/downloads.ts:47 — "Pass viewingCurrentVersion=false when showing an older/superseded revision (e.g. from version history)."; lib/downloads.ts:53 — `if (!viewingCurrentVersion) return { label: "Old revision — not current", tone: "caution" };`; FullScreenViewer.tsx:1184 — `const vb = viewerStatusBadge({ status: docRecord.status, rev: docRecord.rev ?? rev });` (one argument); MultiDocViewer.tsx:668 — `viewerStatusBadge(activeEntry.doc)` (one argument).
```

**Chain reaction.** This is the established "a comment describing behaviour that was never implemented" pattern. The fix is one boolean at two call sites, but FullScreenViewer must first learn which version it is showing — today it receives `url` and `rev` as loose props (page.tsx:3028-3031) and `document={selectedDoc}` separately, so `docRecord.currentVersionId` is the only version identity inside the component and it is always the current one. That same missing identity is the root of the download finding below; fix them together.

> **Verifier correction.** Two corrections. (1) Severity lowered to HIGH: the same header block renders `{docNumber} • Rev {rev || "—"}` at FullScreenViewer.tsx:833, and `rev` is the prop passed as `rev={selectedVersion.revisionLabel}` (page.tsx:3031) — i.e. the OLD label is on screen immediately left of the badge, so the screen is self-contradictory rather than uniformly asserting currency. The badge is also `hidden md:inline-flex` (line 1192), so it does not render on phone widths at all. (2) The MultiDocViewer.tsx:668 call site is not a defect: `docs={stagedDocs}` (page.tsx:4393) are DocumentRecords, never version rows, so that viewer only ever shows current versions and the default `true` is correct there. The finding rests entirely on FullScreenViewer.

**Done when.**

- [ ] `viewerStatusBadge` receives `false` whenever the bytes on screen are not `documents.current_version_id`, in both FullScreenViewer and MultiDocViewer.
- [ ] FullScreenViewer knows the id of the version it is rendering, not just the document's current one.
- [ ] A test opens a non-current version and asserts the badge tone is `caution`, not `controlled`.

---

<a id="rev-5"></a>

## REV-5 · `finalizeReviewedRevision` has no expected-base check and unconditionally writes `status: "Issued"` — a review sign-off resurrects a retired document and can clobber a newer revision

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:402-439`, `lib/reviewControl.ts:429-433`, `lib/reviewControl.ts:444-455`, `lib/reviewControl.ts:316-332`, `lib/revisions.ts:1414-1468`, `lib/revisions.ts:1325-1355`, `lib/documentLifecycle/common.ts:266-281`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both consequences hold. The DB review gate cannot stop it either: 20260822:46-58 checks sign-offs on NEW.current_version_id, which is the fully-signed draft. One caveat that does not refute it — the same trigger's authority check still applies, so an auto-finalize by a reviewer without publish rights raises and is swallowed by the `catch` at reviewControl.ts:330; the finding's scenario (Doc Control / Admin, who short-circuit at `IF v_role IN ('Admin','DocCtrl') THEN RETURN NEW`) is squarely reachable.

**Mechanism.** The promote is `update({ current_version_id: pendingId, rev: baseRev, revision: baseRev, status: "Issued", pending_version_id: null, … }).eq("id", documentId).eq("pending_version_id", pendingId)`. The compare-and-set is on `pending_version_id` **only**. Nothing compares `current_version_id` to the value the draft was built on (`document_versions.supersedes_version_id`, set at submit time from `liveVersionId`, revisions.ts:882,892) — the exact check the whole publish contract exists to enforce (`p_expected_base`, 20260828:116-129). And `status` is written as the literal `"Issued"` with no read of the document's current status. This promote does not go through `publish_revision` at all; it is a direct PostgREST update, so the only server-side check is the `enforce_document_publish_guard` trigger, which guards authority, holds and roster completion — none of which notice that the document was retired or has moved on. Every write after the promote is unchecked supabase-js: the relabel `2A → 2` (line 444-446), the previous version's `superseded_at` stamp (line 447-449), and the provenance backfill (line 461-465) all discard `{error}`. This is auto-triggered: `recordReviewSignoff` calls `finalizeReviewedRevision` the instant the last required signature lands (line 324-332), with no human in the loop.

**Failure scenario.** A procedure is submitted for review as draft 4A. Two days later an incident review retires it: Doc Control runs Supersede, and `supersedeDocument` sets `status='Superseded'`, `superseded_at`, `supersession_reason` (revisions.ts:1455-1466) — it does not touch `pending_version_id`. A week later the second reviewer, working her inbox, signs off on 4A. `recordReviewSignoff` sees `complete` and auto-finalizes. The retired procedure flips back to `status: "Issued"` at Rev 4, `runPostPublishSideEffects` announces it as the new controlled copy, `onDocumentIssuedAck` opens a read-&-understood roster on it, and the retirement notice that went out has no counterpart. `document_supersessions` still says it was replaced. The same shape applies to `archiveDocument` (status `Archived`, revisions.ts:1333-1340) and to `markSupersededAndLink` on a split/merge source (common.ts:271-279).

**Evidence.**

```
lib/reviewControl.ts:430 — `.update({ current_version_id: pendingId, rev: baseRev, revision: baseRev, status: "Issued", pending_version_id: null, updated_at: nowIso, updated_by: input.actorId })`; line 432 — `.eq("pending_version_id", pendingId)` (the only CAS); lib/reviewControl.ts:444-446 — `await supabase.from("document_versions").update({ review_state: "approved", revision_label: baseRev, … })` with no error capture; lib/reviewControl.ts:326-331 — the auto-finalize call inside `recordReviewSignoff`.
```

**Chain reaction.** Because the post-promote writes are unchecked, a half-succeeded finalize is silent and durable: `documents.rev` says "4" while `document_versions.revision_label` still says "4A", the previous revision's `superseded_at` is still NULL so Version History renders it as live, and `released_at` was never set on the revision now being served. The `document_versions_active_label_uniq` partial index (20260823:63-65) covers `(record_id, revision_label) WHERE superseded_at IS NULL AND is_branch = FALSE` — if the relabel to "4" collides, the update is refused and the mismatch is permanent with no user-visible error. Add the base check and the status guard together; they are the same read.

> **Verifier correction.** Severity lowered to HIGH because the finding is not independently exploitable: the promote can only land on a moved-on or retired document when the pending pointer survived, and the direct-publish path deliberately clears it (revisions.ts:627-648). So finding 4 and finding 5 are the two ends of ONE defect — the reachable preconditions are exactly the paths finding 5 enumerates (revert / supersede / archive / split / merge). Fix them together: adding an expected-base + status guard here, or clearing the pointer in those mutators, closes both. Also note the promote itself IS server-side-guarded for authority and holds by trg_document_publish_guard; the missing checks are base and status only.

**Done when.**

- [ ] Finalize refuses to promote when `documents.current_version_id` has moved past the draft's `supersedes_version_id`, returning a conflict rather than clobbering.
- [ ] Finalize refuses (or requires an explicit un-retire) when the document's status is `Superseded`, `Archived` or `Void`, instead of writing `"Issued"`.
- [ ] The relabel, `superseded_at` stamp and provenance writes check `{error}` and surface a partial-publish failure.

---

<a id="rev-6"></a>

## REV-6 · `pending_version_id` is never cleared by revert, supersede, archive, split or merge — an in-flight review draft survives every retirement path and can publish itself later

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/revisions.ts:627-648`, `lib/revisions.ts:1146-1312`, `lib/revisions.ts:1414-1539`, `lib/revisions.ts:1325-1355`, `lib/documentLifecycle/common.ts:253-313`, `lib/documentLifecycle/reverse.ts:104-126`, `lib/reviewControl.ts:402-439`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Claim of absence confirmed by exhaustive search. The retirement paths deliberately mirror publish for status and lineage but omit the one line publish added for exactly this hazard, so a draft surviving a split/supersede/archive/revert can still be promoted later by finalizeReviewedRevision, which (per REV-5) writes status 'Issued' unconditionally.

**Mechanism.** Exactly one mutator retires a stale draft: `revUpDocument` step 3c (revisions.ts:627-648) reads `pending_version_id`, nulls it, stamps the draft's `superseded_at`, and voids its sign-offs — with the explicit rationale "so a stale draft can never be finalized OVER this newer revision". A repo-wide grep for `pending_version_id` finds writers only in `revisions.ts:633,907`, `reviewControl.ts:430`, `app/api/intake/upload/route.ts:325,332` and `components/projects/IntakePanel.tsx:258`. `revertToVersion` (revisions.ts:1146-1312), `supersedeDocument` (1414-1539), `archiveDocument` (1325-1355), `markSupersededAndLink` (common.ts:253-313, used by split and merge) and `reverseSplit`/`reverseMerge` (reverse.ts) contain no reference to it. So every path that changes or retires the controlled copy *except* a direct rev-up leaves the pending pointer live, aimed at a draft whose reviewers are still signing.

**Failure scenario.** Draft 3A is in review on P-101. Doc Control splits P-101 into P-101A and P-101B; `markSupersededAndLink` sets P-101 to `Superseded` and writes the lineage rows. P-101 is now retired and its replacements are the controlled sheets. Its `pending_version_id` still points at 3A. The last reviewer signs 3A from her inbox; auto-finalize promotes it and sets P-101 back to `Issued` at Rev 3. The plant now has three live sheets covering the same equipment: P-101 Rev 3, P-101A and P-101B — and `document_supersessions` still asserts that P-101 was replaced by the other two.

**Evidence.**

```
lib/revisions.ts:623-626 — the comment stating the invariant: "A direct (non-branch) publish supersedes any in-review draft: clear the pending pointer and void the draft's roster, so a stale draft can never be finalized OVER this newer revision."; lib/revisions.ts:633 — `await supabase.from("documents").update({ pending_version_id: null }).eq("id", doc.id);` — the only such write outside finalize/intake; grep over `lib app components supabase` for `pending_version_id` returns no hit inside `revertToVersion`, `supersedeDocument`, `archiveDocument`, `markSupersededAndLink` or `reverse.ts`.
```

**Chain reaction.** Step 3c itself is wrapped in `try { … } catch { /* best-effort */ }` (revisions.ts:628,640) and every write inside it discards `{error}` — so even the one path that honours the invariant fails open. Combined with the finalize finding above (no base check, unconditional `status: "Issued"`), a surviving pending pointer is a loaded gun on every retired document. The durable fix is to make retirement void the draft in the same operation, and to make finalize refuse a document whose status is no longer publishable.

> **Verifier correction.** One scoping note: the finalize-side consequence is finding 4, so treat them as one defect with one fix. Also worth adding to the location list — the `if (!branched)` wrapper at revisions.ts:627 means a BRANCH publish is a sixth path that leaves the pointer live, which the finding does not mention.

**Done when.**

- [ ] Revert, supersede, archive, split and merge all void the in-flight draft (null the pointer, stamp `superseded_at`, void the roster) or refuse to run while one is open.
- [ ] The voiding writes check `{error}` instead of swallowing it.
- [ ] A test retires a document with an open review and asserts a subsequent last-signature cannot publish.

---

<a id="rev-7"></a>

## REV-7 · A branch publish bypasses the review gate entirely, and the active-label unique index excludes branches — an unreviewed version lands in the chain carrying the SAME revision label as the controlled copy

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/RevUpModal.tsx:279`, `components/documents/RevUpModal.tsx:292-308`, `components/documents/RevUpModal.tsx:322-332`, `supabase/migrations/20260823_publish_contract.sql:57-68`, `supabase/migrations/20260828_integrity_hardening.sql:140-178`, `lib/revisions.ts:407-409,657-667`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves verified: the partial index's own predicate excludes is_branch = TRUE, so the RPC's `EXCEPTION WHEN unique_violation` duplicate-label backstop cannot fire for a branch, and a branch row can carry the identical active label '3'. MEDIUM is right — the branch is never promoted to current, it opens a revision_branches debt row, and RevUpModal:305-308 raises a loud modal saying it is NOT the current revision.

**Mechanism.** `RevUpModal.doPublish(asBranch)` routes with `if (willReview && !asBranch)` (line 279). When `asBranch` is true the review branch is skipped and `revUpDocument` is called directly (line 293) — in a library whose `review_control.mode` is `'require'`. The DB review-completion gate cannot catch it either: `p_as_branch: true` never runs `UPDATE documents` (20260828:170-178 inserts the version row and the `revision_branches` row, then falls straight to the return), so `enforce_document_publish_guard` never fires — the point OWN-5 already makes about authority applies identically to the review gate. Separately, the duplicate-label backstop is `CREATE UNIQUE INDEX document_versions_active_label_uniq ON document_versions(record_id, revision_label) WHERE (superseded_at IS NULL AND is_branch = FALSE)` (20260823:63-65) — branches are excluded from the predicate — and the RPC detects duplicates *only* via `EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('status', 'duplicate_label', …)` (20260828:166-167). A branch insert therefore can never raise `DuplicateLabelError`. The conflict screen is reached from `StaleBaseError`, and the catch block resets the label only for `DuplicateLabelError` (RevUpModal.tsx:330-332) — on a stale base the user's typed label is preserved verbatim into the branch publish.

**Failure scenario.** Two drafters both start from Rev 2 of a P&ID in a `require`-review library and both type "3". The first publishes; the second hits the stale-base conflict screen, types a branch reason, and clicks "publish anyway". Her version row is written with `revision_label = '3'`, `is_branch = true`, `provenance`, `file_hash`, `approved_by_name` — all of it — with **no reviewer roster and no sign-offs**, in a library configured to require review. The document now has two active version rows labelled "Rev 3": the reviewed controlled one and an unreviewed branch. Version History shows both as "Rev 3"; both are downloadable from the panel (line 351-358); the branch's PDF stamp will read whatever the current `documents.rev` says.

**Evidence.**

```
components/documents/RevUpModal.tsx:279 — `if (willReview && !asBranch) {`; RevUpModal.tsx:293-299 — the else branch calls `revUpDocument({ ...common, expectedBaseVersionId: …, asBranch, branchReason: … })`; 20260823_publish_contract.sql:64-65 — `ON document_versions(record_id, revision_label) WHERE (superseded_at IS NULL AND is_branch = FALSE);`; 20260828_integrity_hardening.sql:166-167 — `EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('status', 'duplicate_label', …)`.
```

**Chain reaction.** `resolveBranch` (lib/branches.ts:344-404) only writes `resolution` and a note — it never promotes, never merges content, never voids the branch version. So the branch row stays in the chain forever labelled "Rev 3", and per the previous finding it is revertable, which makes it promotable to controlled without ever passing review. Requiring review on the branch path means the stale-base conflict screen can start refusing, so that screen needs a real error state (the same coupling OWN-5 flags). Note also the `DO $$ … EXCEPTION WHEN unique_violation OR others THEN RAISE NOTICE` wrapper at 20260823:61-68: if any pre-existing duplicate labels were present when the migration ran, the index was never created and the RPC's duplicate detection is inert for all rows, not just branches.

> **Verifier correction.** The headline — "bypasses the review gate" in a require-mode library — is REFUTED as unreachable, and this is the load-bearing half of the finding. `doPublish(true)` has exactly one call site, RevUpModal.tsx:484, which renders only inside the `if (conflict)` screen (line 368). `setConflict(e.info)` has exactly one call site, line 327, inside `catch (e) { if (e instanceof StaleBaseError) … }`. StaleBaseError is thrown only by revUpDocument (revisions.ts:468, 577, and 1213 for revert) — and in a require-mode library `doPublish(false)` routes to `submitForReview`, which never throws it. So the conflict screen, and therefore the branch button, is unreachable whenever review is actually required; when `effectiveModeForRevUp` returns "none" (reviewControl.ts:58-61: mode none, or changeType Minor/Correction) no review was owed in the first place. Grep for `asBranch` confirms RevUpModal.tsx:296 is the only place it is ever passed true. What survives is the narrower defect: after a stale-base conflict, a branch can be published carrying the same active revision_label as the controlled copy with no duplicate-label error — mitigated in the UI by the purple `<ShieldAlert /> Branch` badge (VersionHistoryPanel.tsx:272-278) and by branches never becoming current. Downgraded to MEDIUM accordingly. (Separately noted, not part of this finding: `reviewControl` initialises to null and resolves in an async effect (RevUpModal.tsx:105, 189-205), so `willReview` is false during the load window — that is a distinct race worth its own entry.)

**Done when.**

- [ ] A branch publish in a `require`-review library either opens a review roster or is refused.
- [ ] Two active rows on one document cannot carry the same `revision_label`, branch or not.
- [ ] A deployment check asserts `document_versions_active_label_uniq` actually exists.

---

<a id="rev-8"></a>

## REV-8 · A transient PostgREST schema-cache miss drops every publish to the unguarded legacy three-step path for 60 seconds — no base check, no row lock, no transaction

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/revisions.ts:80-87`, `lib/revisions.ts:110-120`, `lib/revisions.ts:533-551`, `lib/revisions.ts:613-619`, `lib/revisions.ts:756-835`, `lib/revisions.ts:1191-1207`, `supabase/migrations/20260823_publish_contract.sql:1-31`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanism is real — a transient PGRST202 sets a 60s flag that routes publishes to legacyRevUpAfterUpload (revisions.ts:758-835), which genuinely has no row lock and no transaction. But two of the title's claims are wrong: there IS a base check on the legacy path (the step-1b pre-flight at 453-478 runs regardless of which path follows), and it is not 'every publish' — publishRpcMissingUntil is a module-level variable in a browser-side module (lib/supabase.ts is the anon browser client; revUpDocument is only called from RevUpModal/merge.ts/setRevUp.ts), so the flag is per-tab, not per-deployment. The stated outcome ('both version rows are written') additionally requires the two drafters to pick DIFFERENT labels, since the partial unique index rejects a second active row with the same (record_id, revision_label). Residual risk is a genuine but narrow TOCTOU: the pre-flight fires before the file hash+upload, so a true concurrent race inside the upload window can still slip through.

**Mechanism.** `isMissingPublishRpc` returns true for `err.code === "PGRST202"`. The comment directly above `publishRpcMissingUntil` states the hazard: "The RPC can look 'missing' transiently — PostgREST returns PGRST202 while its schema cache reloads (which happens right after applying the very migration that adds the function)." On any such error, `markPublishRpcMissing()` sets a 60-second module-level window (line 118) during which `publishRpcUnavailable()` short-circuits the contract entirely — `if (!publishRpcUnavailable())` guards the RPC call in both `revUpDocument` (line 533) and `revertToVersion` (line 1191), and `if (!result)` falls through to `legacyRevUpAfterUpload` (line 614-619). That legacy path is exactly the shape the publish-contract migration was written to eliminate: insert the version row, stamp `superseded_at` on the previous one, update `documents` — three separate PostgREST calls, no transaction, no `SELECT … FOR UPDATE`, and **no `p_expected_base` check of any kind** (its own comment at revisions.ts:756-757 says so: "No base check — kept only so environments that haven't applied the migration keep working").

**Failure scenario.** Two drafters both start from Rev 4 of a P&ID. One publishes during a PostgREST schema reload; the RPC returns PGRST202, the v1 retry also fails, the 60-second flag is set, and her publish goes through the legacy path. Within that window the second drafter publishes too. Both version rows are written with `supersedes_version_id = <Rev 4>`, both `documents` updates run, the second wins, and the first drafter's revision is orphaned off the current chain with nobody told — the precise lost update the migration header describes: "the second silently clobbered the first … and NOBODY was told." The `document_versions_active_label_uniq` index would catch the case where both typed the same label, but not the common case where the second typed the next one.

**Evidence.**

```
lib/revisions.ts:83 — `if (err.code === "PGRST202" || err.code === "42883") return true;`; lib/revisions.ts:110-112 — "The RPC can look 'missing' transiently — PostgREST returns PGRST202 while its schema cache reloads"; lib/revisions.ts:118 — `function markPublishRpcMissing(): void { publishRpcMissingUntil = Date.now() + 60_000; }`; lib/revisions.ts:803-809 — the legacy `superseded_at` stamp, whose only failure handling is `console.error("revUp: failed to stamp superseded_at:", supErr.message)`.
```

**Chain reaction.** The only reset is `resetPublishRpcFlag()`, described as a "Test hook / manual reset" (line 119-120) and called from no production path. The related `callPublishRevisionRpc` v1 fallback (lines 95-107) folds `p_override_lock` into `p_force` — OWN-5's chain-reaction note already flags that this silently upgrades a polite lock-override into a controller force that also clears an active hold. Both issues live in the same block and should be retired together: once the 20260823/20260828 migrations are known-applied, the legacy path and the v1 fallback are pure liability. If a fallback must remain, it should refuse rather than publish unguarded.

> **Verifier correction.** "No base check of any kind" is overstated for the rev-up path. revisions.ts:453-476 runs a pre-flight base check BEFORE the upload — it re-reads `documents.current_version_id` and throws StaleBaseError if it differs from `expectedBase` — and that check runs on every call regardless of which publish path follows, so the legacy fallback still has a (racy, TOCTOU) base comparison in front of it. The legacy `UPDATE documents` also still trips trg_document_publish_guard, which enforces authority, active holds and review completion. What is genuinely lost is atomicity and the per-document row lock, plus the TOCTOU window between the pre-flight read and the write. Note the truly unchecked case is revertToVersion: it has NO equivalent pre-flight (revisions.ts:1146-1234 goes straight to the RPC), so its legacy fallback at :1234-1272 performs no base comparison at all — that is the sharpest instance and the one to cite. Downgraded to MEDIUM.

**Done when.**

- [ ] A transient RPC error is retried against the RPC rather than downgrading to the unguarded path.
- [ ] `legacyRevUpAfterUpload` and the legacy revert branch are removed, or gated behind an explicit deployment flag that is off in any environment where the migration is applied.
- [ ] A publish attempted while the contract is unavailable fails loudly instead of succeeding without a base check.

---

<a id="rev-9"></a>

## REV-9 · Effective dates are decided in local time in the UI and in UTC everywhere else — the "now in effect" announcement is silently suppressed for any publisher west of UTC publishing in the evening

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/effectiveDate.ts:16`, `lib/effectiveDate.ts:23-24`, `lib/effectiveDate.ts:33-34`, `lib/effectiveDate.ts:45`, `lib/effectiveDate.ts:49`, `lib/effectiveDate.ts:62-63`, `app/api/verify/route.ts:93-94`, `lib/__tests__/effectiveDate.test.ts:5`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Claim verified exactly: for a UTC-5 publisher at 20:30 on 21 Aug choosing effective date 2026-08-22, todayISO() is already '2026-08-22', so suppress is true, effective_notified_at is stamped at publish, and scanEffectiveDates (:62-63) can never pick the doc up — while effectiveStatusFor() (local) still renders the 'pending' badge. lib/__tests__/effectiveDate.test.ts:5 bakes the same UTC assumption into the fixtures, so the suite would not catch it. Downgraded to LOW: the bug only bites on the exact one-day boundary (effective date == UTC-today but local-tomorrow), and the only lost artifact is one in-app 'now in effect' notification — the revision itself is served correctly and the badge/register still show it.

**Mechanism.** Two different "today" definitions coexist. The badge path is LOCAL: `effectiveStatusFor` does `const today = new Date(); today.setHours(0, 0, 0, 0);` and parses the stored date as `new Date(\`${effectiveDate.slice(0,10)}T00:00:00\`)` — a bare datetime string, which JS parses in the **local** zone — then compares (lines 97-102). `daysUntilEffective` is identical (106-112). The persistence and notification paths are UTC: `const todayISO = () => new Date().toISOString().slice(0, 10);` (line 91), used by `applyEffectiveDate` as `const suppress = !eff || eff <= todayISO();` (line 120) and by `scanEffectiveDates` as `.lte("effective_date", todayISO())` (line 137). `/api/verify` uses the UTC form too (route.ts:94). When `suppress` is true, `applyEffectiveDate` pre-stamps `effective_notified_at: new Date().toISOString()` (line 124) — the watermark that permanently prevents `scanEffectiveDates` from ever announcing that revision, since the scan filters `.is("effective_notified_at", null)` (line 138).

**Failure scenario.** A Doc Control manager in Houston (UTC-5) publishes a revised operating procedure at 8:30 pm on 21 August with an effective date of 22 August — the day after the crew's training session. UTC is already 01:30 on 22 August, so `todayISO()` returns `"2026-08-22"`, `suppress` evaluates `"2026-08-22" <= "2026-08-22"` → true, and `effective_notified_at` is stamped immediately. Her screen still shows the amber "Effective 22 Aug" pending badge, because `effectiveStatusFor` compares against local midnight and correctly says pending. The next day the badge flips and **nobody is told**: the owner never gets the "now in force" notice and neither does anyone on the read-&-understood roster, because the watermark says the announcement already happened.

**Evidence.**

```
lib/effectiveDate.ts:91 — `const todayISO = () => new Date().toISOString().slice(0, 10);`; lib/effectiveDate.ts:98-99 — `const today = new Date(); today.setHours(0, 0, 0, 0); const eff = new Date(\`${effectiveDate.slice(0, 10)}T00:00:00\`);`; lib/effectiveDate.ts:120 — `const suppress = !eff || eff <= todayISO();`; lib/effectiveDate.ts:124 — `effective_notified_at: suppress ? new Date().toISOString() : null,`.
```

**Chain reaction.** The mirror case fires spurious notices: a publisher east of UTC setting an effective date of "today" gets `suppress = false`, and the next cron run announces "Now in effect" for a revision that was already in force at publish. The existing test is itself written on the UTC form — `const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);` (effectiveDate.test.ts:5) — so `expect(effectiveStatusFor(iso(0))).toBe("effective")` fails for any CI runner in a negative-offset zone during local evening. The test is a latent flake and evidence of the same confusion. Both `applyEffectiveDate` writes also discard `{error}` (lines 121,122-125), so a refused write is invisible.

> **Verifier correction.** Every cited line number is wrong — lib/effectiveDate.ts is 94 lines long, so :91, :96-103, :106-112, :118-126 and :131-138 do not exist. The real anchors are :16 (todayISO), :23-24 and :33-34 (the two local-time comparisons), :45 (suppress), :49 (the watermark), :62-63 (the scan filter). Severity lowered to MEDIUM: nothing about which revision is served or which rev is stamped changes, and the on-screen "Effective <date>" badge remains correct — the only loss is the one-time "now in effect" notification. Also note lib/__tests__/effectiveDate.test.ts:5 builds its fixtures with `new Date(...).toISOString().slice(0,10)` and feeds them to the local-time comparators, so the test suite itself would flake west of UTC in the evening; it is evidence of the split, not a mitigation.

**Done when.**

- [ ] One definition of "today" governs the badge, the suppression watermark, the daily scan and `/api/verify` — ideally the facility's configured zone, not the browser's and not UTC.
- [ ] A future effective date always produces exactly one "now in effect" announcement, on the day the badge flips.
- [ ] The effective-date tests pass under a non-UTC `TZ`.

---

<a id="rev-10"></a>

## REV-10 · Live share tokens keep serving a Superseded, Archived or split-away document to an unauthenticated external party — neither share route checks `documents.status` and no retirement path revokes a share

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/share/file/route.ts:42-58`, `app/api/share/file/route.ts:103-116`, `app/api/share/resolve/route.ts:32-47`, `lib/documentShares.ts:46,61,69`, `lib/revisions.ts:1414-1539`, `lib/revisions.ts:1325-1355`, `lib/documentLifecycle/common.ts:266-281`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves: no status check in either share route, and no retirement path revokes a share. supersedeDocument (revisions.ts:1454-1467) and markSupersededAndLink (documentLifecycle/common.ts:266-281) set status='Superseded' and never look at document_shares. Partial mitigation the finding does not mention: the delivered PDF is stamped 'UNCONTROLLED — SHARED COPY' with a /verify QR, and app/api/verify/route.ts:88 `const docRetired = d.status === 'Superseded' || d.status === 'Archived'` does return docStatus/isCurrent=false — but the share landing page never surfaces status, so the outsider only learns it by scanning the QR. MEDIUM stands.

**Mechanism.** Both public share routes validate the token, then check exactly three things: `share.revoked_at`, `share.expires_at`, and that the document exists. Their `documents` select is `"id, document_number, title, name, rev, current_version_id"` — `status` is not selected and never consulted (share/file/route.ts:53-58, share/resolve/route.ts:43-47). Both correctly exclude in-review drafts on the fallback branch (`.or("review_state.is.null,review_state.eq.approved")`) but neither excludes a retired document. On the retirement side, a grep for `document_shares` across `lib app components supabase` finds writers only in `lib/documentShares.ts` (create at :46, list at :61, manual revoke at :69) and the `bump_share_access` RPC (20260818_followups_rls.sql:97-102). `supersedeDocument`, `archiveDocument` and `markSupersededAndLink` contain no reference to it, so retiring a drawing leaves every outstanding share token live and serving.

**Failure scenario.** A fabricator is sent a share link to P-101 for a bid. Six weeks later P-101 is split into P-101A and P-101B; the source goes `Superseded`. The fabricator's link still works. `/api/share/file` fetches the retired document's current version, stamps it "UNCONTROLLED — SHARED COPY" with the footer `P-101 Rev 4 at time of download — scan the QR to confirm it is still current.` (route.ts:110) and serves it. Nothing on the page or the paper says the drawing was retired. The mitigating control is the QR — `/api/verify` does compute `docRetired = d.status === "Superseded" || d.status === "Archived"` and returns `isCurrent: false` (route.ts:89-90) — but that requires the recipient to scan it, and the footer's own wording ("Rev 4 at time of download") frames the question as a revision question, not a retirement one.

**Evidence.**

```
app/api/share/file/route.ts:54-56 — `.select("id, document_number, title, name, rev, current_version_id")` — no `status`; app/api/share/file/route.ts:47-51 — the only gates are `share.revoked_at` and `share.expires_at`; app/api/share/file/route.ts:110 — `footerNotice: \`${label} Rev ${rev ?? "?"} at time of download — scan the QR to confirm it is still current.\``; grep for `document_shares` returns no hit in `lib/revisions.ts` or `lib/documentLifecycle/`.
```

**Chain reaction.** The version-resolution logic in both routes is genuinely careful — it prefers `current_version_id`, falls back only to approved-or-null `review_state`, pulls bytes server-side to avoid the old CORS leak, and encodes the real `versionId` in the verify QR. It is worth preserving exactly as-is; the missing piece is one status check plus a retirement-time revoke. Doing the revoke at retirement is the stronger half, because it also covers the transmittal and package surfaces that hold their own pinned references (`notifyPackagesOfRetirement`, postPublish.ts:150-187, already exists as the pattern for exactly this — packages get told, share recipients do not).

> **Verifier correction.** One real partial mitigation belongs in the write-up. The downloaded copy is not naked: share/file stamps it server-side with `watermarkText: "UNCONTROLLED — SHARED COPY"`, the footer at :110 ("…scan the QR to confirm it is still current."), and `verifyUrl: ${publicOrigin()}/verify/${doc.id}?v=${versionId}` — and /api/verify DOES compute `docRetired` from status and returns `isCurrent: false` plus `docStatus` (route.ts:89-90, 104). So a printed share copy self-identifies as retired when scanned. No such signal exists on the on-screen share page, which is where the gap is sharpest. MEDIUM is right.

**Done when.**

- [ ] `/api/share/resolve` and `/api/share/file` refuse, or clearly label, a document whose status is `Superseded`, `Archived` or `Void`.
- [ ] Superseding, archiving, splitting or merging a document revokes or flags its outstanding share tokens.
- [ ] The shared-copy stamp on a retired document says it was retired, not just which revision it was.

---

<a id="rev-11"></a>

## REV-11 · Split, merge and the "link a drawing" upload create documents at status `Issued` with no publish-authority check and no review-control resolution, then start the compliance clocks on them

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/documentLifecycle/common.ts:133-249`, `lib/documentLifecycle/common.ts:178`, `lib/revisions.ts:309-393`, `lib/revisions.ts:344`, `lib/revisions.ts:386-391`, `components/documents/DocumentLinkPicker.tsx:101-115`, `lib/documentLifecycle/split.ts:96-134`, `lib/documentLifecycle/merge.ts:107-142`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. The core claim is correct — split (split.ts:96-134), merge (merge.ts:107-142) and DocumentLinkPicker.tsx:101-115 all materialize status='Issued' Rev-0 controlled documents with released_at set, with no publish-authority check and no review-control resolution, so a require-review library is bypassed. Two factual corrections, which is why this is CORRECTED rather than clean: (1) split/merge do NOT start the compliance clocks — onDocumentIssued/onDocumentIssuedAck/recomputeRetention appear only at revisions.ts:386-391 (createDocumentWithFile) and postPublish.ts:138-143, never in createNewDocWithFirstVersion, so the cited clock behaviour applies only to the link-a-drawing path; (2) the Split/Merge entry point is UI-gated (InspectorPanel.tsx:283 `const canManage = isController || isOwner;` at :888), so the actor is a controller or the doc's owner, not an arbitrary drafter. Severity left at MEDIUM: an owner who is not a controller can still bypass a mandatory review gate this way.

**Mechanism.** `createNewDocWithFirstVersion` — the building block split and merge use to materialize every new sheet — inserts `status: "Issued"` as a hardcoded literal (common.ts:178), uploads the file, inserts the first `document_versions` row with `released_at: now` (common.ts:213), and promotes it. It never resolves `effectiveReviewControlForDocument`, never calls `effectiveModeForRevUp`, and never calls `authorizePublish`. Neither does `splitDocument` (split.ts:74-198) nor `mergeDocuments` (merge.ts:82-244) — their only authority check is whatever the wizard rendered. `createDocumentWithFile` is explicit about it in its own header: "this is a creation, gated by library write access at the UI/RLS layer, so it does NOT run the publish guard" (revisions.ts:313-315) — and defaults `status: input.status ?? "Issued"` (line 344). `outputTemplates.fileDocumentsToLibrary` passes `status: "Draft"` deliberately (outputTemplates.ts:227); `DocumentLinkPicker.createAndLink` passes no status at all (DocumentLinkPicker.tsx:107-113) and therefore files an uploaded PDF straight to `Issued`. Both then run `onDocumentIssued` and `onDocumentIssuedAck` (revisions.ts:386-388), starting the review clock and opening a read-&-understood roster.

**Failure scenario.** A `require`-review drawings library. A drafter splits a cluttered P&ID into two sheets through the Split wizard. Two brand-new controlled drawings appear at `status: Issued`, Rev 0, `released_at` set, with the source's active holds and project memberships copied onto them — and no reviewer ever saw either sheet. The library's review policy applied to the rev-up that would have produced the same content and does not apply here. `onDocumentIssuedAck` immediately opens a read-&-understood roster instructing operators to acknowledge that they have read a drawing nobody approved. The same door is open through "Link a drawing → upload a new one" in the assets, related-resources and admin-assets panels.

**Evidence.**

```
lib/documentLifecycle/common.ts:178 — `status: "Issued",`; lib/revisions.ts:344 — `status: input.status ?? "Issued",`; lib/revisions.ts:313-315 — "Distinct from revUpDocument … this is a creation, gated by library write access at the UI/RLS layer, so it does NOT run the publish guard."; components/documents/DocumentLinkPicker.tsx:107-113 — `await createDocumentWithFile({ orgId, libraryId: upLibraryId, collectionId: folderId || null, …, documentNumber: docNum.trim(), title: …, file, actorUserId: userId });` — no `status`.
```

**Chain reaction.** `setLevelRevUp` shows the intended shape and the precedent: it explicitly resolves the review policy per sheet and defaults `publisher_choice` to the safe side, with a comment recording that this was a previously-found bypass (setRevUp.ts:71-84). Split, merge and creation were not given the same treatment. Contrast also `createNewDocWithFirstVersion`'s promote at common.ts:227 — it *does* pass through the `enforce_document_publish_guard` trigger, but that trigger's review gate keys on a roster attached to `NEW.current_version_id`, and a freshly created version has none, so it cannot bite. The authority half of this overlaps OWN-19 ("a granted publisher … cannot supersede, archive, split or merge — the database allows all of it"); the review-gate half does not.

> **Verifier correction.** Two of the three claims are wrong and must not be acted on. (1) "No publish-authority check" is REFUTED at the server: trg_document_publish_guard is `BEFORE UPDATE ON documents` (20260822_review_completion_guard.sql:93-96), and BOTH creation paths promote via an UPDATE — common.ts:222-226 and revisions.ts:385 set `current_version_id`, moving it from NULL, which satisfies `v_advancing` at 20260822:37 and runs the role / `user_can_publish_on_library` / `user_is_effective_owner` / holds checks. The app layer skips authorizePublish, but the database does not. (2) "Then start the compliance clocks on them" is true ONLY for createDocumentWithFile: `onDocumentIssued` and `onDocumentIssuedAck` appear at revisions.ts:386-388 and nowhere in lib/documentLifecycle (verified by grep across that directory), so split and merge sheets get NO review clock and NO ack roster — arguably the opposite defect, and worth filing separately. What survives is the hardcoded `status: "Issued"` with no review-control resolution on document creation; downgraded to MEDIUM since creation-vs-publish is an explicitly documented boundary and RLS plus the DB trigger both apply.

**Done when.**

- [ ] Split and merge resolve the effective review control for the target library/folder and either route the new sheets through review or record why they did not.
- [ ] A newly created document's initial status is a deliberate choice, not a hardcoded `"Issued"`, and the "link a drawing" upload does not default to controlled-and-issued.
- [ ] Split, merge and creation carry the same publish-authority check as `revUpDocument`.

---

<a id="rev-12"></a>

## REV-12 · `reverseSplit` / `reverseMerge` restore documents to `Issued` regardless of what they were before, and reconstruct state from an audit field (`auditAt`) that is never written

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/documentLifecycle/reverse.ts:99-100`, `lib/documentLifecycle/reverse.ts:116-126`, `lib/documentLifecycle/reverse.ts:205-206`, `lib/documentLifecycle/reverse.ts:212-223`, `lib/documentLifecycle/split.ts:93,150-153`, `lib/documentLifecycle/common.ts:93-119`, `lib/audit.ts:16-31`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed. split.ts:93 captures `priorSourceStatus` and restoreSupersededSource (common.ts:93-119) restores it correctly — but only on the in-transaction compensation path; the user-facing reverse* functions ignore it entirely and hard-code 'Issued', so a Void or Draft source comes back as a live controlled document. auditAt is never written by logRevisionEvent/logAuditAction (lib/audit.ts:16-31 writes action/resource/details only), so summarizeDerivativeWork always scans from epoch — over-inclusive rather than dangerous, but it means the 'since the split' warning text is false.

**Mechanism.** Two defects in the same functions. (1) `reverseSplit` writes `status: "Issued"` as a literal when un-superseding the source (reverse.ts:118-126), and `reverseMerge` does the same for every source (reverse.ts:212-221), under the comment "Restore status to 'Issued' as the safest default — the source's history says where it was before." The prior status is not read anywhere in reverse.ts. The forward path proves it was available: `splitDocument` captures `const priorSourceStatus = source.status ?? "Issued"` and hands it to `restoreSupersededSource(sourceId, priorSourceStatus, …)` for its compensation (split.ts:93,152; common.ts:93-97). The reversal path throws that away. (2) `summarizeDerivativeWork` — the "has work happened since?" warning shown in the reversal confirmation — is called as `const auditAt = (ev.details?.auditAt as string) ?? "1970-01-01T00:00:00Z";` (reverse.ts:99 and 205). A repo-wide grep for `auditAt` across `.ts/.tsx/.sql/.mjs` returns those two read sites and nothing else: no writer exists. `logRevisionEvent` → `logAuditAction` writes `details: { ...params.details, versionId }` (audit.ts:175) and never adds it.

**Failure scenario.** A drawing sits at `status: "Void"` — withdrawn after a design error. It is merged into a replacement sheet, which sets it `Superseded`. The merge is later reversed. `reverseMerge` writes `status: "Issued"` on it. A voided drawing is now a live controlled document in the register, in search, in `/api/verify` (which reports `isCurrent` for anything not `Superseded`/`Archived`, route.ts:89-90) and in work-package retirement checks. Meanwhile the operator confirming the reversal is shown "12 download events happened on the new docs since the merge" — a count taken from the epoch across the target's entire lifetime, because `auditAt` was NULL — so the one warning that could have stopped them reads as noise on every reversal and is learned to be ignored.

**Evidence.**

```
lib/documentLifecycle/reverse.ts:117-118 — "// Un-supersede the source. Restore status to 'Issued' as the // safest default — the source's history says where it was before." followed by `status: "Issued",`; lib/documentLifecycle/split.ts:93 — `const priorSourceStatus = source.status ?? "Issued";` (the value the reversal needed and did not use); lib/documentLifecycle/reverse.ts:99 — `const auditAt = (ev.details?.auditAt as string) ?? "1970-01-01T00:00:00Z";`; repo-wide grep for `auditAt` returns only reverse.ts:99,100,205,206.
```

**Chain reaction.** OWN-15 already covers the fact that these un-supersede writes pass every policy and trigger — `v_advancing` only fires on a `current_version_id` change or a transition **into** `'Superseded'` (20260822:36-38), never out of one. This finding is the orthogonal half: even for an authorized controller, the restored status is wrong, and the safety warning attached to the action is inert. Both `auditAt` (never written) and the "the source's history says where it was before" comment (never read) are instances of the established "a comment describing behaviour that was never implemented" pattern. Recording the prior status in the forward operation's audit `details` fixes both: it is the same write.

> **Verifier correction.** The failure DIRECTION of the auditAt half is backwards in the finding. `summarizeDerivativeWork(docIds, sinceIso)` filters `.gt("timestamp", sinceIso)` (reverse.ts:65), so a 1970 epoch fallback matches EVERY audit row on those documents — including the split's own creation events — meaning the warning always fires and always over-reports, rather than being silently suppressed. It is a warning rendered meaningless by noise, not a missing warning. The fix is the same (write auditAt, or use the audit row's own `timestamp`, which loadAuditEvent at :46-49 does not even select), but do not describe it as a silent-failure gap. MEDIUM stands.

**Done when.**

- [ ] `DOC_SPLIT` / `DOC_MERGED` audit details carry the source's prior status and the event timestamp, and the reversal reads both.
- [ ] A reversal restores a document to the status it actually held, never a hardcoded `Issued`.
- [ ] The derivative-work warning counts only events after the operation being reversed.

---

<a id="rev-13"></a>

## REV-13 · `revertToVersion` never calls `applyEffectiveDate` — the document keeps the superseded revision's effective date, and the cron announces it coming into force

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/revisions.ts:1146-1312`, `lib/revisions.ts:642-647`, `lib/reviewControl.ts:482-484`, `lib/effectiveDate.ts:45`, `lib/effectiveDate.ts:62-63`, `lib/docControlRegister.ts:186-187`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. After a revert, documents.effective_date still holds the withdrawn revision's future date with effective_notified_at NULL, so scanEffectiveDates (effectiveDate.ts:56-63, `.lte("effective_date", todayISO()).is("effective_notified_at", null)`) fires 'Now in effect: <doc> Rev <revert-label>' on that date, and docControlRegister.ts:186-187 keeps flagging the reverted doc effectivePending. The new revert version row itself carries no effective_date (revertPayload, :1172-1185), so the version and the document disagree.

**Mechanism.** `documents.effective_date` and `documents.effective_notified_at` are denormalized copies kept in step by exactly one function, `applyEffectiveDate`. A repo-wide grep for `applyEffectiveDate` finds two call sites: `revisions.ts:646` (direct rev-up, non-branch only) and `reviewControl.ts:484` (finalize after review). `revertToVersion` — which changes the controlled revision exactly as those two do, and even runs the identical `runPostPublishSideEffects` pipeline afterwards (revisions.ts:1304-1309) — contains no such call, and its `revertPayload` (revisions.ts:1171-1184) has no `effective_date` field, so the new version row's effective date is NULL while the document's stays whatever the retired revision set.

**Failure scenario.** A procedure is issued at Rev 4 with an effective date of 1 December (after a training window); `documents.effective_date = '2026-12-01'` and `effective_notified_at = NULL`. On 10 November the revision is found to be defective and Doc Control reverts to Rev 3. Rev 3 is effective immediately and has no future date — but `documents.effective_date` is untouched. The register keeps rendering the "Effective 1 Dec (pending)" pill against the reverted document (docControlRegister.ts:187, `effectivePending: effectiveStatusFor(...) === "pending"`), telling every reader that the copy in force today is not the one they should be working to. On 1 December `scanEffectiveDates` picks the row up, fires "Now in effect: <doc> Rev 3-revert-…" to the owner and the whole acknowledgment roster, and stamps the watermark — announcing the coming-into-force of a date that belonged to a revision that was pulled three weeks earlier.

**Evidence.**

```
lib/revisions.ts:646 — `await applyEffectiveDate({ documentId: doc.id, versionId: newVersion.id ?? "", effectiveDate: input.effectiveDate ?? null });` inside `if (!branched) { … }`; lib/reviewControl.ts:484 — `try { await applyEffectiveDate({ documentId: input.documentId, versionId: pendingId, effectiveDate }); }`; grep for `applyEffectiveDate` across `lib app components` returns only those two call sites plus the definition and the two imports; `RevertInput` (lib/revisions.ts:1130-1144) has no `effectiveDate` field at all.
```

**Chain reaction.** `recomputeRetention` reads `effective_date` as a retention basis (`lib/retention.ts:86`, `basis === "effective" ? (doc.effective_date || …)`), and `runPostPublishSideEffects` calls it on the revert path (postPublish.ts:143) — so a stale effective date also mis-computes the retention clock for the reverted document. The same omission exists on the external-intake auto-supersede path (`app/api/intake/upload/route.ts:325`), which writes `current_version_id` directly and never touches `effective_date`; that path's authority story is OWN-4, but its effective-date story is not covered there.

> **Verifier correction.** Severity lowered to MEDIUM. The announcement is the tail consequence and requires the retired revision to have carried an as-yet-unreached future effective date; the primary, always-present defect is simply that `documents.effective_date` is left describing a revision that is no longer current, which the register then reports (docControlRegister.ts:186-187). Note also that the same omission exists on the branch path of revUpDocument, since the applyEffectiveDate call sits inside `if (!branched)` at revisions.ts:626-648.

**Done when.**

- [ ] Every path that changes `current_version_id` reconciles `documents.effective_date` / `effective_notified_at` with the version now in force.
- [ ] A revert to a revision with no effective date clears the document's pending date and its badge.
- [ ] `scanEffectiveDates` cannot announce a date belonging to a version that is no longer current.

---

<a id="rev-14"></a>

## REV-14 · `supersedeDocument` writes its lineage rows as one unchecked batch INSERT with no conflict handling, despite a comment claiming duplicate-key tolerance — a single existing pair silently drops the whole supersession record

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/revisions.ts:1470-1482`, `lib/documentLifecycle/common.ts:283-294`, `supabase/migrations/20260526_supersede_archive.sql:28-37`, `components/documents/SupersedeModal.tsx:52-77`, `lib/revisions.ts:1432-1452`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed exactly as claimed, including the false comment. A multi-row INSERT is atomic in Postgres, so one pre-existing pair rejects the whole statement; the return value is discarded, so SupersedeModal.tsx:52-77 reaches `onSuccess(...)` and `onClose()` with no error. The sibling function in the same codebase does it correctly, which settles that this is an oversight rather than intent. Mild mitigation: logRevisionEvent at revisions.ts:1483-1497 still records resolvedReplacementIds, so the audit log retains the lineage even when the join table does not.

**Mechanism.** The comment at revisions.ts:1470-1471 reads "Idempotent via UNIQUE constraint — we ignore duplicate-key errors so re-running the action is safe." The code is `await supabase.from("document_supersessions").insert(rows);` (line 1481) — a multi-row INSERT with no `onConflict`, no `upsert`, and no `{ error }` capture. `document_supersessions` carries `UNIQUE (superseded_doc_id, replacement_doc_id)` (20260526:36). PostgREST executes a multi-row insert as a single statement, so one conflicting pair aborts the whole statement — none of the rows land — and the discarded error means the caller reports success. The sibling function `markSupersededAndLink` gets this right: `.upsert(rows, { onConflict: "superseded_doc_id,replacement_doc_id" })` (common.ts:293). Separately, the status write at line 1455-1466 runs regardless of whether any replacement resolved: `resolveReplacementIds` looks up doc numbers scoped to `.eq("library_id", libraryId)` (line 1440) and quietly bins anything it cannot find into `unresolvedDocNumbers`.

**Failure scenario.** P-101 was superseded by P-101A. A week later Doc Control realises P-101B also replaces it and re-runs Supersede with both numbers. The `(P-101, P-101A)` pair already exists; the two-row insert is rejected in full; the error is discarded; the modal reports success and closes. `document_supersessions` still contains only the P-101A link — the P-101B relationship exists nowhere except the `SUPERSEDE_DOC` audit row's `details.resolvedReplacementIds`, and `logAuditAction` swallows `{error}` too (lib/audit.ts:16-31), so even that is not guaranteed. Anyone asking "what replaced P-101?" gets a half-answer.

**Evidence.**

```
lib/revisions.ts:1470-1471 — "// Record the (old → new) join rows. Idempotent via UNIQUE constraint — // we ignore duplicate-key errors so re-running the action is safe."; lib/revisions.ts:1481 — `await supabase.from("document_supersessions").insert(rows);`; supabase/migrations/20260526_supersede_archive.sql:36 — `UNIQUE (superseded_doc_id, replacement_doc_id)`; lib/documentLifecycle/common.ts:293 — the correct form: `.upsert(rows, { onConflict: "superseded_doc_id,replacement_doc_id" });`.
```

**Chain reaction.** This is the established "supabase-js resolves with {error} rather than throwing" pattern applied to the lineage table, and lineage is the only machine-readable record of what replaced what. `document_supersessions_member_all` is `FOR ALL` with both `USING` and `WITH CHECK` for any active member (20260615_fix_missing_rls_policies.sql:73-76), so the rows are also freely deletable — and `reverseSplit`/`reverseMerge` do hard-delete them (reverse.ts:130-134, 226-230) on the stated basis that "the audit log retains the relationship", which is only true if the audit insert succeeded. The one-line fix is to mirror `markSupersededAndLink`'s upsert and check the error.

> **Verifier correction.** One softening for accuracy: the supersession is not entirely unrecorded when the insert aborts — logRevisionEvent at :1483-1497 still writes `resolvedReplacementIds` and `unresolvedDocNumbers` into the audit row, and `documents.status` is already 'Superseded'. What is lost is the queryable join table that the UI and lineage reads use. MEDIUM is the right severity.

**Done when.**

- [ ] `supersedeDocument` upserts on the unique pair and surfaces a failure instead of discarding it.
- [ ] Re-running a supersede with an added replacement records the new pair.
- [ ] A document cannot be left in `Superseded` with zero lineage rows and no visible warning.

---
