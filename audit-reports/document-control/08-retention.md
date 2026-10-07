# 08 · Retention, legal hold, archive & restore

**14 findings** — 1 CRITICAL · 7 HIGH · 6 MEDIUM.

The destructive paths, and what re-checks state before destroying.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The two BEFORE DELETE legal-hold triggers on documents and document_versions genuinely close every row-DELETE path, including cascades and service-role scripts | `supabase/migrations/20260826_legal_hold_delete_guard.sql:29-56` | This is the only enforcement of the hold that does not depend on a client behaving. Any fix must extend it, not replace it. |
| lib/retentionPolicy.ts is a genuinely pure, I/O-free module shared by the browser client and the server move/folder-delete routes, so retention arithmetic cannot drift between them | `lib/retentionPolicy.ts:12-38, lib/serverRetention.ts:10-14` | The single-source-of-truth for the clock is correct and worth preserving; the defects are all around it, not in it. |
| The ticket-shed commit re-verifies rows are STILL archived between the stamp and the destructive free, and only a provable stamp (count===1) proceeds | `app/api/admin/ticket-shed/commit/route.ts:158-186` | This is the correct pattern the document shed commit is missing; it is the template for fixing it. |
| Ticket capture is all-or-nothing: a ticket with any unreadable attachment is skipped entirely and un-claimed, so commit can never free a file that is not in the saved zip | `app/api/admin/ticket-shed/route.ts:190-225` | The strongest safety invariant in the shed. The document shed's per-file capture is weaker but still un-claims what it could not read. |
| ticket-shed/restore gates every write on the LIVE stub row and only writes keys the stub itself owns under the orgs/<orgId>/ prefix | `app/api/admin/ticket-shed/restore/route.ts:113-144` | Proves the codebase already knows attacker-controlled attachment keys are a threat — the commit path simply does not apply the same rule. |
| collectReferencedKeys aborts the whole orphan scan if any reference query errors, and deleteOrphans re-scans server-side rather than trusting the client list | `lib/storageOrphans.ts:33-104,152-177` | The fail-closed reference model is sound; only its org scoping is wrong. |
| archive-cancel gives the operator a real recovery handle for a produce that stranded rows with archive_id set, and never touches committed stubs | `app/api/admin/archive-cancel/route.ts:33-62` | Without it, an abandoned produce would permanently hide revisions from future shed runs. |
| BackupViewer verifies dropped-archive bytes against files-manifest.json sha256 (falling back to the DB hash) before showing them | `components/archive/BackupViewer.tsx:88-110,148-160` | The read-only viewer already does the integrity check that the write-back restore path skips. |
| post_ticket_comment is SECURITY DEFINER *with* SET search_path = public and refuses to write an archived stub | `supabase/migrations/20260810_archive_invariants.sql:12-32` | Shows the correct hardened form; the legal-hold guard functions written six days later regressed on search_path. |


---


<a id="ret-1"></a>

## RET-1 · A legal hold does not stop the space-saver: the shed permanently deletes the R2 binaries of held records

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 6 — the destructive deletes).** Confirmed: the hold was enforced only against row DELETEs (BEFORE DELETE triggers), which the shed never performs — it deletes R2 bytes. The hold is now honored at both shed steps:
- **Candidates (done-when 1):** `fetchCandidates` reads the org's `legal_hold = true` documents and excludes every version whose parent is held, before eligibility/selection. **Fail closed:** if the hold read errors, no candidates are offered (503) rather than shedding possibly-held evidence.
- **Commit (done-when 2):** the destructive step re-reads the linked versions' parent documents — a hold placed BETWEEN produce and commit still protects the bytes. Held versions are left linked, unstamped and undeleted; the response reports `heldSkipped` and says why the reclaim came up short. Fail closed on the hold read (503, nothing freed).
- Done-when 3: `lib/__tests__/shedLegalHold.test.ts` — candidates exclude a held document's revisions (an unheld sibling still offered); candidates fail closed on a hold-read error; commit skips a version held after produce (no stamp, no R2 delete) while freeing the unheld one; commit frees nothing when everything is held; commit fails closed on a hold-read error.
- Files: `app/api/admin/shed/route.ts`, `app/api/admin/shed/commit/route.ts`
- **What this brought to light:** the verifier's HIGH framing stands — produce still captures held bytes into the offline zip (that is its job, and the zip predates the hold check at commit); what is closed is the DESTRUCTION path. The version rows, checksums and the archive catalog survive throughout.

- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/shed/route.ts:47-64`, `lib/shed.ts:56-67`, `app/api/admin/shed/commit/route.ts:58-110`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:29-56`, `lib/retention.ts:9-10`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The claim is right on every mechanical point — the hold is invisible to the shed. I propose HIGH rather than CRITICAL: the two-step design captures the bytes into a produced ZIP before commit (commit refuses when the catalog note is still "producing…", route.ts:41-51), only superseded revisions beyond keep-N are eligible, and the version rows plus checksums survive. So this is a hold bypass that moves held evidence out of live storage into an admin's offline file, not unconditional destruction of it. The report's own 'Verifier correction' note already concedes this framing while leaving the severity at CRITICAL.

**Mechanism.** The hold is enforced only against row DELETEs — two BEFORE DELETE triggers (documents, document_versions) and two app checks. The shed never deletes a row: it stamps `archived_at` and calls `DeleteObjectsCommand` on the R2 keys. `fetchCandidates` queries `document_versions` alone — `.from("document_versions").select("id, file_url, size, superseded_at, archive_id, created_at, revision_label, record_id, file_hash").eq("org_id", orgId).is("archived_at", null)` — with no join to `documents` and no reference to `legal_hold`. `isEligible` checks only file_url / archived_at / archive_id / size / superseded_at. Two differently-shaped searches (`grep -rn 'legal_hold' app/api/` and `grep -rln 'isLegalHold|legalHold' app/api/`) both return empty: no API route in the codebase consults the hold flag at all.

**Failure scenario.** Counsel places a litigation hold on P-101 Rev A–F (lib/retention.ts:120-132 sets legal_hold=true on every revision's parent document; the UI shows the red 'This record can't be deleted or disposed' banner). An admin runs the routine keep-last-5 space saver. Revisions A and B are superseded and beyond keep-5, so they are bundled and, on commit, `DeleteObjectsCommand` removes their bytes from R2 permanently. The DB rows survive with archived_at set, so the register still shows the record as held — but the evidentiary PDFs of the two revisions under hold now exist only in whatever zip the admin saved to a local folder. For a PSM/OSHA record set that is spoliation, and the app reports the hold as intact throughout.

**Evidence.**

```
app/api/admin/shed/route.ts:52-54 `.from("document_versions").select("id, file_url, size, superseded_at, archive_id, created_at, revision_label, record_id, file_hash").eq("org_id", orgId).is("archived_at", null)`; lib/shed.ts:56-67 `export function isEligible(row, cutoff) { if (!row.file_url) return false; if (row.archived_at) return false; if (row.archive_id) return false; if (!(Number(row.size) > 0)) return false; if (!row.superseded_at) return false; ... }`; commit/route.ts:103 `const res = await r2.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: batch } }));`; contrast the trigger's own scope, 20260826:30-33 `CREATE TRIGGER trg_documents_legal_hold_delete BEFORE DELETE ON documents`.
```

> **Verifier correction.** One framing nuance worth carrying forward: the shed captures the bytes into the produced offline zip before commit deletes them, and the metadata/version rows survive, so this is a hold BYPASS (evidentiary content leaves live storage and its availability now depends on an admin's offline zip) rather than unconditional destruction. It is still the hold being ignored by a destructive path.

**Done when.**

- [ ] fetchCandidates joins documents (or filters record_id against a held-document id set) and excludes every version whose parent has legal_hold = true
- [ ] shed/commit re-reads the parent documents for the linked versions and refuses to delete any key belonging to a now-held record, mirroring ticket-shed/commit's stillArchived re-check
- [ ] a regression test asserts selectShedCandidates/commit produce zero deletions for a held document, including a hold placed between produce and commit

---

<a id="ret-2"></a>

## RET-2 · /api/storage/delete lets any active member destroy any object in their org — no role check, no safe-key gate, no records-management check, and zero callers

- **Severity:** HIGH
- **Status:** RESOLVED
- **Assigned:** document-control P14 RECORDS & REVIEW REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).

**Resolution (2026-08-24 — cross-area closure, fixed as roles-and-permissions `SURF-2` and hardened again in that area's adversarial-review round).** Every limb of this finding is closed in `app/api/storage/delete/route.ts`: the caller must be an Admin/DocCtrl of the key's org (read additively); `assertSafeStorageKey` runs before any prefix reasoning and non-org-prefixed keys are refused; the key resolves to its document and a legal hold or unreleased `document_holds` row refuses with 423, **fail closed** (503) on any lookup error; and a `STORAGE_OBJECT_DELETE` audit row is written BEFORE destruction, with the route refusing when the custody record cannot be written. Tests: `lib/__tests__/storageDeleteRoute.test.ts` (9 cases). See `../roles-and-permissions/09-non-document-surfaces.md` (`SURF-2`) for the full record.

- **Verification:** CONFIRMED
- **Locations:** `app/api/storage/delete/route.ts:6-45`, `lib/storage.ts:442-450`, `lib/storageKey.ts:1-16`, `lib/storageKey.ts:40-52`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on all four sub-claims including the absence ones. Note the storage-key gate matters here more than anywhere: lib/storageKey.ts:6-12 documents precisely this authorize-the-first-orgs-prefix-then-act-verbatim pattern as the reason the validator exists, and this is the one route that skips it. HIGH is appropriate — an unused surface that lets a Viewer permanently destroy the bytes of a legal-hold-protected current revision while the DB row keeps reporting the document as Issued.

**Mechanism.** The route authenticates the bearer token, parses `orgs/<uuid>/` from the caller-supplied path, requires only active membership of that org — no role, no ACL, no document lookup — and then deletes the key verbatim. It is the only storage route that does NOT run `assertSafeStorageKey`; upload-url, resolve, download-url and multipart all do, and storageKey.ts's own header describes precisely this route's authorize-the-first-prefix-then-sign-verbatim pattern as the reason the gate exists. It also never checks legal_hold, archived_at, or whether the key is the current revision of a controlled document. Two searches (`grep -rn 'api/storage/delete'` and `grep -rn 'deleteFile'`) show the endpoint has exactly one wrapper, `lib/storage.ts:deleteFile`, which itself has no callers anywhere in app/, lib/ or components/.

**Failure scenario.** Any authenticated member — a Viewer, a departed contractor whose membership was not deactivated — sends `DELETE /api/storage/delete {"path":"orgs/<myOrg>/libraries/<lib>/P-101-RevD.pdf"}`. The current, issued, legal-hold-protected revision of a B31.3 piping drawing is removed from R2. The DB row is untouched, so the register still shows the document as Issued with a valid checksum; the next person to open it gets a broken viewer. No audit row is written by this route at all. The whole surface exists to serve a helper nothing calls.

**Evidence.**

```
app/api/storage/delete/route.ts:42 `await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path }));` with the only gate at :28-40 `const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//); if (orgMatch) { ...select uid from org_members... if (!member) return 403; }`; lib/storageKey.ts:6-12 'the org-membership gate in every route authorizes the caller against the FIRST "orgs/<uuid>/" segment it can parse, then signs the key verbatim'; lib/storage.ts:442-450 `export async function deleteFile(path: string)` — no call sites.
```

> **Verifier correction.** Drop the traversal sub-claim as impact. lib/storageKey.ts:4-13 says itself that R2 treats keys as opaque byte strings and does not collapse '../', so the missing assertSafeStorageKey here is defence-in-depth/consistency, not an exploitable cross-tenant path. The load-bearing defect is the rest: an authenticated member of the org can permanently delete the current revision of any controlled document by naming its key, with no role, ACL, legal-hold or retention check, on an endpoint the app itself never calls.

**Done when.**

- [ ] the route is deleted along with lib/storage.ts:deleteFile, or
- [ ] it is gated to Admin/DocCtrl via authorizeOrgRole, runs assertSafeStorageKey, refuses any key referenced by a document_versions row whose parent is under legal hold or whose row is the current revision, and writes an audit_logs entry

*Cross-area note (2026-09-30, intelligence Round G; corrected by its fix pass 3): re-verifying intelligence `DACL-2` against `app/api/storage/delete/route.ts` found its refusals are a documents-row legal hold and an unreleased `document_holds` row only (`:76-104`), and only for a key matching a version's `file_url` — the lookup is `.eq("file_url", path)` alone (`:79-84`), so a revision's native source file (`document_versions.source_file_key`, `lib/revisions.ts:504-510`) resolves to no document and is destroyed with a 200 even when its document is held. This finding's second Done-when ("refuses any key referenced by a document_versions row whose parent is under legal hold or whose row is the current revision") therefore does not hold for source keys, nor for a current revision's key (the route has no such refusal), and there is no retention check; this record's RESOLVED over-claims both limbs — the status is left to document-control and both limbs are on the integrator's list for it. DACL-2 stays OPEN on retention AND the source-key hold bypass (the fix resolves the key against both columns, as `app/api/storage/upload-url/route.ts:60` already does). The bypass is reproduced by two `it.fails` in `lib/__tests__/intelRoundGRecords.test.ts` ("DACL-2 criterion 1 …": a held document's rendered file `423`, its native source `200` and deleted); the package that lands the two-column lookup flips them to `it`.*

**Partial (2026-10-01, document-control Round F wave 2).** Package **P11 STORAGE-DELETE** changed this record's status from RESOLVED back to OPEN. The 2026-08-24 cross-area closure above over-claims Done-when 2: the route has never had the "or whose row is the current revision" refusal (the intelligence Round G cross-note above says so too). P11 closed the other limbs that cross-note named, in `app/api/storage/delete/route.ts`, and intelligence `DACL-2` is RESOLVED on them (see `../intelligence/06-document-acl-leaks.md`):
- The key is resolved against BOTH `document_versions.file_url` and `source_file_key` (`:126-136`). These are two exact-equality lookups, upload-url's pattern, with no `.or()` string. Every document naming the key in either column is checked (`:137-141`), and either lookup's error refuses `503`.
- A held document's native source now answers `423` like its rendered file (`:149-154`).
- A retention refusal now exists (`:155-242`, `423`). The route refuses when the materialized `retention_until` / `disposition_state` is in force (read through `retentionStatusFor`), OR when the EFFECTIVE retention resolved at request time is. The effective retention comes from the document → folder → library policy through P9's own pure resolver (`resolveEffectiveRetentionPolicy` + `retentionBasisISO` + `computeRetentionUntil`), so a row never clocked, or left stale by a refused or capped re-clock, is still refused. A computed date past year 9999 (an extended-year string P9's re-clock cannot store) reads as uncomputable and refuses. A `disposed` record is not exempt, because `disposeDocument` checks no eligibility: it is refused while its stored `retention_until` has not run; while its effective date is in force when its basis is one disposal cannot move (`created`, or `effective` with a date); and, under a basis that clocks from the `updated_at` disposal rewrites (`issued`, `superseded`, `effective` without a date), while a lower bound — the later of `created_at` and the current revision's `created_at` less a day (tightened at integration, 2026-10-01) — is ahead or cannot be computed. A policy in force with no computable end refuses without quoting any date.
- The folder and library policy reads are checked, and they fail closed `503`, as do the documents and `document_holds` reads (`:52-60`, `:244-246`).

Tests: `lib/__tests__/storageDeleteRoute.test.ts` now has 55 cases on a filter-aware stand-in that also projects `.select()` columns, 46 of them new (59 and 50 after the integration fix, 2026-10-01). The two DACL-2 `it.fails` in `lib/__tests__/intelRoundGRecords.test.ts` are flipped to `it`.

*Ownership note for P9 RECORDS:* `retentionStatusFor` and its `RetentionStatus` type moved verbatim from `lib/retention.ts` into the pure `lib/retentionPolicy.ts` (`:29-47`), and `lib/retention.ts` re-exports both (`:28-33`). Both are P9 files (recorded in P11's file list at merge). The move lets the route share the register's and the pill's verdict without importing the browser client. Every existing import site (`RetentionPill.tsx`, `docControlRegister.ts`, `retention.test.ts`) is unchanged. The identity test in `storageDeleteRoute.test.ts` ("… the ONE shared verdict and P9's ONE resolver …") asserts `lib/retention` and `lib/retentionPolicy` export the same `retentionStatusFor`, `resolveEffectiveRetentionPolicy` and `computeRetentionUntil` objects, that the route imports those and `retentionBasisISO` from `lib/retentionPolicy`, and that the route carries no copy of the date arithmetic. It is the tripwire against a second definition drifting; it does not catch a semantic change to the shared verdict, so a later edit to `retentionStatusFor` or the resolver in `lib/retentionPolicy.ts` should be checked against this route. At merge (2026-10-01) the integrator added both files to P11's `files` in `audit-reports/fleet-plans/document-control.json`, noting the verbatim move from P9; no code change was needed.

**Done-when.**
- The first alternative (delete the route along with `lib/storage.ts:deleteFile`) is not taken: `deleteFile` now has a caller, `lib/costDocs.ts:165`, which cleans up a cost document's fresh key after a failed insert.
- ◐ The second alternative:
  - ✓ Gated to Admin/DocCtrl of the key's org, read additively from `role` and `roles` (`:92-110`).
  - ✓ `assertSafeStorageKey` runs before the org-prefix parse (`:81`, `:86-89`).
  - ✓ A key referenced by a `document_versions` row whose parent is under legal hold is refused, in either column (`:149-154`). An unreleased `document_holds` row is refused too, and so is retention in force.
  - ✓ An `audit_logs` custody row is written before destruction, and the route fails closed if it cannot be written (`:248-271`).
  - **Not done: "or whose row is the current revision".** The route has no current-revision refusal. A controller can still destroy, with a `200`, the bytes of the current issued revision of a document that is neither held nor inside its stored or effective retention. That is this finding's failure scenario minus the hold.

**Remaining / owner.** One limb: refuse a key that a document's CURRENT revision names. The fix site is the same per-owner loop. Collect every version id naming the key (in either column) for each owner, not only the first. Select `documents.current_version_id` with the hold and retention columns. Refuse `423` when the current version is among them, fail-closed like the rest. Add tests in `storageDeleteRoute.test.ts`. The refusal blocks no current write path: the route's only caller deletes `project-costs` keys, which no `document_versions` row names. Owner: document-control. No fleet-plan package lists this limb today, and it was outside P11's brief (DACL-2 criterion 1's two limbs; DEC-31). The integrator either schedules it as a follow-up to P11 at the same fix site, or closes it with a recorded decision that the controller gate plus the hold and retention refusals supersede it. Until then, this record stays OPEN. *For P9 RECORDS (noted on the package's second fix pass and narrowed on its third; no code here):* `disposeDocument` (`lib/retention.ts:216-256`) has no eligibility check (only the Dispose button gates on `eligible`), and `computeRetentionUntil` / the policy editor accept an unbounded `years`. The route guards against both (see `DACL-2`'s residual (v)). For a disposed record under an `updated_at`-based policy it now judges a lower bound clocked from the later of `created_at` and the current revision's `created_at` less a day, so what stays deletable is narrower: such a record whose pre-disposal `updated_at` came from a write after its current revision was made current, whose bound plus years has run but whose true `updated_at` plus years has not, with a stale run-out stored date (intelligence `DACL-2` residual (v)). The route cannot recover the `updated_at` disposal overwrote; that case closes only when `disposeDocument` gates on the effective date or stops rewriting `updated_at`.

**Resolution (2026-10-01, document-control Round F wave 3).** Package **P14 RECORDS & REVIEW REMAINDERS** — the one remaining limb, "or whose row is the current revision". Reproduced on `4dd0df7`: the per-owner loop kept only the FIRST version naming the key (`owners.set(v.record_id, v.id)` only when absent) and nothing compared it with `documents.current_version_id`, although `OWNER_DOC_COLUMNS` already selected that column for P11's disposal bound. Five new tests failed against the base route (a clear document's current rendered file and native source deleted with a `200`; a roles-collection DocCtrl the same; a reverted revision re-using an old key; two documents sharing a key).
- `app/api/storage/delete/route.ts` — the owner map now collects EVERY version id naming the key, in either column (`file_url`, `source_file_key`), per document, in lookup order (the first is still the custody row's `versionId`). After the legal-hold and `document_holds` refusals, and before retention, the route refuses `423` when the document's `current_version_id` is among them: "This file belongs to the document's current revision; it cannot be deleted while that revision is current." For every caller (the controller gate is the only one that reaches it), whatever the hold or retention state — **except a DISPOSED record** (`disposition_state = 'disposed'`; P14 review fix): disposition is the record's end of life and a "destroy" schedule has no other route to the current file, so a disposed record skips this refusal and is judged by the retention block alone, which still refuses it while its period has not run (stored or effective). The first version refused a disposed record's current file forever after its retention ran, re-seeding P11's tests around it instead of pinning that outcome; corrected before merge. Fail closed as the rest: the documents read is the same checked read (`503` on error). A version row whose document no longer exists has no current revision to protect. `OwnerDoc` gains the `current_version_id` it was already selecting.
- Tests (`lib/__tests__/storageDeleteRoute.test.ts`, describe "RET-2 (remainder): a key the document's CURRENT revision names is refused", 9 cases): the current revision's rendered file and native source are refused on a clear document with nothing deleted and no custody row; a roles-collection DocCtrl is refused too; **regression** — an older revision's file and source on the same document are still deleted, the custody row naming that revision; every version naming the key is collected (a revert re-using an old key, RET-8's shape, through either column); every document naming the key is checked; a documents read error is `503`; a hold still answers as a hold; **regression** — the route's only caller, `lib/costDocs.ts`, deletes a `project-costs` key no revision names (`200`); and, at the review fix, both sides of the disposed exemption: a disposed record whose retention has RUN has its current revision's file and source destroyed (`200`, custody row naming the current revision), a disposed record whose retention has NOT run is still refused as retention, and an undisposed record past its retention (no disposition state, eligible, pending) keeps its current revision's bytes. P11's disposed-record tests run exactly as P11 wrote them (`current_version_id: "v1"`, the revision whose key they delete) — unchanged from the base file — and pass again; three of them fail against the first version of this pass.

**Done-when.**
- The first alternative (delete the route along with `deleteFile`) is still not taken: `lib/costDocs.ts:165` calls it.
- ✓ The second alternative, every limb:
  - ✓ Gated to Admin/DocCtrl of the key's org, read additively (P11; unchanged).
  - ✓ `assertSafeStorageKey` before the prefix parse (unchanged).
  - ✓ A key referenced by a `document_versions` row whose parent is under legal hold (or an unreleased hold, or retention) is refused, in either column (P11).
  - ✓ **A key referenced by the document's CURRENT revision is refused** (this pass), in either column, whichever of the key's versions is current — unless the record is disposed, where retention alone decides (the review fix's call: otherwise a disposed record's current bytes could never be destroyed by any route).
  - ✓ An `audit_logs` custody row before destruction, fail closed (unchanged).

**Scope / residual.** A disposed record is exempt from the current-revision refusal whatever its recorded action (archive or destroy): the route never read the action, and deleting a disposed record's bytes after its retention has run is the same controller act P11 already allowed; the retention judgement (and P11's lower bound for an `updated_at` basis) still binds it. Only `current_version_id` is protected, as the done-when reads; a pending review draft's bytes (`pending_version_id`) and a branch's are not — an in-flight draft is not a controlled copy, and the controller deleting them is the same act as voiding the draft. The disposed-record residual P11 recorded for P9 (`disposeDocument` gates on no effective date; intelligence `DACL-2` residual (v)) is unchanged. No migration.

---

<a id="ret-3"></a>

## RET-3 · Access recertification attests the wrong access list — it reads libraries.acl while enforcement uses visibility + acl_index

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/accessRecert.ts:59-76`, `lib/accessRecert.ts:97-114`, `supabase/migrations/20260708_acl_rls_enforcement.sql:44-80`, `supabase/schema.sql (libraries: visibility, acl, acl_index, read_access, write_access, admin_access, visible_to)`, `supabase/migrations/20260821_access_recert.sql:22-35`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is real: for a default-visibility library the effective reader set is every active org member plus all Admin/DocCtrl, and none of them appear in the attested snapshot, so the compliance record is signed against a list that is not the access list. I propose MEDIUM rather than HIGH because there is a mitigation the finding's scenario omits — components/documents/AccessRecertModal.tsx:118 renders, for an empty list, 'No explicit grants on this library (inherited / default access only).', so the reviewer is not silently told nobody has access. The defect is the accuracy of the stored attestation, with no direct data exposure.

**Mechanism.** `listAccessGrants` reads only `libraries.acl` and keeps rules where `effect === 'allow'`. Enforcement is `node_visible(p_visibility, p_acl_index, p_org)`, which (a) returns TRUE unconditionally when visibility IS NULL or 'normal' — the schema default — so every active org member can read the library, and (b) returns TRUE for every Admin/DocCtrl regardless of ACL, and (c) evaluates the chain-merged `acl_index`, a different column from `acl`. listAccessGrants also ignores `expiresAt` entirely: it copies the field into the snapshot but never filters on it, so a grant that expired last year is presented and attested as current access. Role- and team-scoped rules are recorded as the raw role/team id, never expanded to the people they actually admit.

**Failure scenario.** A default-visibility 'Piping Drawings' library has no explicit ACL rules. The recertification modal shows an empty access list; the reviewer sees nothing to prune and clicks Recertify. `access_recertification_events` records `grant_count: 0` with an empty `grants_snapshot`, `last_recertified_at` is stamped and the clock resets six months. The attested record says nobody has access to the library, while in truth every active member of the org — including a contractor who left the project — can read every controlled drawing in it. That snapshot is precisely the artefact an ISO 27001 / SOC 2 auditor is handed, and it is false.

**Evidence.**

```
lib/accessRecert.ts:60-62 `const { data } = await supabase.from("libraries").select("acl").eq("id", libraryId).maybeSingle(); const acl = (data?.acl as AccessControl | null) ?? null; const allows = (acl?.rules ?? []).filter((r) => (r as AccessRule).effect === "allow")`; :74 `expiresAt: r.expiresAt ? String(r.expiresAt) : null,` (recorded, never filtered); 20260708:52-62 `IF p_visibility IS NULL OR p_visibility = 'normal' THEN RETURN true; END IF; ... IF v_role IN ('Admin','DocCtrl') THEN RETURN true; END IF;`.
```

> **Verifier correction.** No correction needed — all three sub-claims (wrong column, no expiry filter, unexpanded role/team subjects) were each traced in the source and the enforcement contrast in 20260708 matches the quote exactly.

**Done when.**

- [ ] listAccessGrants resolves the EFFECTIVE population: when visibility is null/'normal' it enumerates active org members, always includes Admin/DocCtrl, expands role and team rules to uids, and reads acl_index (the column RLS uses) rather than acl
- [ ] expired grants are excluded from the live list and reported separately as 'expired, still listed'
- [ ] recertifyAccess refuses to attest, or marks the snapshot 'incomplete', when the effective population could not be resolved

**Resolution (2026-09-23, Round F).** Reproduced: `listAccessGrants` read `libraries.acl` allow-rules only (`:63-80`), never filtered `expiresAt`, and enforcement is `node_visible` (20261041) over `acl_index`. `lib/accessRecert.ts` now resolves the EFFECTIVE population by the same rules: `listAccessGrantsDetailed(orgId, libraryId)` reads `libraries.visibility, acl, acl_index, owner_user_id, owner_team_id`, the org's active members, team rows and `teams.supervisor_user_id`, then — visibility null/'normal' admits every active member (source `default`); every Admin/DocCtrl by role collection (`controller`) and the EFFECTIVE owner (`owner`) always — resolved as `user_is_effective_owner` (20261042) does: `owner_user_id` when that person is an active member, otherwise the supervisor of `owner_team_id` (via "team supervisor (effective owner)"); a departed owner admits nobody; `acl_index` allow buckets expanded to PEOPLE through exactly the three arms `acl_subject_in_bucket` (20260708) has — a user rule its user, a role rule the members holding that role additively, a team rule its members (source `explicit` when a live rule backs it, `inherited` otherwise). An `orgs` bucket is NOT expanded: the client index builder writes it (`lib/acl.ts`) but `acl_subject_in_bucket` has no org arm, so the database admits nobody by it and attesting every member under it would be the over-attestation twin of the finding. An explicit deny of read/discover removes a member unless controller/owner (DEC-7). Rules whose `expiresAt` has passed are split into `expired` (status `expired`, via "expired rule — still listed in the access index until the nightly rebuild") and never counted as current; `complete:false` + `issues` when any read fails. `listAccessGrants` returns `.live` (the modal keeps working unchanged); `recertifyAccess` attests `effective.live` and THROWS `Recertification refused: the library's effective access list could not be resolved (…)` when `complete` is false — nothing is written.
- Tests: `lib/__tests__/dcRoundFRecords.test.ts` — "default visibility: every active member is attested…", "private library: controllers, the owner, and the acl_index grants expanded to people; a deny removes a member" (expired rule split out, absent from the plain list), "team-owned library: the team's supervisor is the effective owner and is attested", "a departed owner admits nobody; resolution falls through to the team supervisor", "an `orgs` allow bucket admits nobody — acl_subject_in_bucket has no org arm", "a failed team-supervisor read refuses to attest", "an unresolvable population refuses to attest".
- Files: `lib/accessRecert.ts` (`listAccessGrantsDetailed`, `listAccessGrants`, `recertifyAccess` head).

**Done-when.**
- ✓ effective population resolved: null/'normal' → active org members; Admin/DocCtrl always; the EFFECTIVE owner (owner_user_id if active, else the owner team's supervisor); role and team rules expanded to uids; `acl_index` read (the column RLS uses) through the users/roles/teams arms only, `acl` only for expiry.
- ✓ expired grants excluded from the live list and reported separately (`expired[]`, status `expired`, "still listed" note); `grant_count` / `grants_snapshot` carry the live list only.
- ✓ `recertifyAccess` refuses to attest when the population could not be resolved.

**Scope / residual.** `components/documents/AccessRecertModal.tsx` (admin-and-org P9 / `ALOG-2` owns it) still renders the plain list; the `expired` entries are available to it from `listAccessGrantsDetailed` (the "expired, still listed" rendering is theirs). `ALOG-2` extends `recertifyAccess` (performed_by binding, error surfacing in the modal) — the head of the function was kept to the one refusal so it can. `acl_index` carries no expiry, so an expired subject is genuinely "still listed" in the index until the nightly rebuild (DEC-10); it is flagged, never attested.

---

<a id="ret-4"></a>

## RET-4 · Any active org member can clear a legal hold, wipe a retention clock, or self-attest an access recertification via PostgREST

- **Severity:** HIGH
- **Status:** RESOLVED
- **Assigned:** admin-and-org P9 (ALOG-2: access_recertification_events split; then close by pointer) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1060-1070`, `supabase/migrations/20260901_db_hard_enforcement.sql:152-162`, `supabase/migrations/20260820_retention.sql:59-64`, `supabase/migrations/20260821_access_recert.sql:39-44`, `lib/retention.ts:113-116`, `components/documents/RetentionSection.tsx:29-33`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — the app-side gate is only components/documents/RetentionSection.tsx's `canManage` prop, which is client-side. Note the interaction that makes this worse than a lone integrity bug: clearing legal_hold via PostgREST also disarms the 20260826 BEFORE DELETE triggers, which are described as the enforcement that must not depend on the client.

**Mechanism.** The authority columns of records management all live on tables whose only permissive policy is `FOR ALL USING (org_id IN (SELECT my_org_ids()))` with no WITH CHECK — documents (legal_hold, legal_hold_matter, retention_policy, retention_until, disposition_state, disposed_at), libraries (recert_policy, last_recertified_at, next_recertification_date, acl) and collections (retention_policy). The only DB write guard on documents is the RESTRICTIVE deny policy, which blocks nothing absent an explicit ACL deny; the legal-hold trigger fires on DELETE only, never on UPDATE. Role gating exists solely as the `canManage` prop on RetentionSection and the client-side buttons. Separately, `document_disposition_events` and `access_recertification_events` — the records-management audit trail and the attestation evidence — are FOR ALL for any active member, so the same member can UPDATE or DELETE the very rows that would show the tampering.

**Failure scenario.** A member under investigation issues one PostgREST PATCH: `PATCH /rest/v1/documents?id=eq.<id>` body `{"legal_hold":false,"legal_hold_matter":null,"retention_until":null,"disposition_state":null}`. The hold banner disappears, the delete triggers now pass, the register's legal-hold tile drops the record, and the retention clock is gone. A second DELETE against `document_disposition_events?document_id=eq.<id>` removes the hold_placed/hold_released trail. Nothing in the app or the database refused any of it, and no audit row survives that says a hold ever existed. The same PATCH shape against `libraries` lets any member push next_recertification_date years out or insert a fake `recertified` attestation row.

**Evidence.**

```
supabase/schema.sql:1068-1069 `CREATE POLICY "documents_org_access" ON documents FOR ALL USING (org_id IN (SELECT my_org_ids()));` (no WITH CHECK); 20260901:153-162 `CREATE POLICY documents_deny_write_guard ON documents AS RESTRICTIVE FOR UPDATE USING (auth.uid() IS NULL OR is_org_controller(org_id) OR NOT (acl_index_denies(...)))` — passes for every member without an explicit deny; 20260820:61-64 `CREATE POLICY "doc_disposition_events_member" ON document_disposition_events FOR ALL USING (EXISTS (SELECT 1 FROM org_members ... status = 'active')) WITH CHECK (same)`.
```

> **Verifier correction.** No correction needed — every cited policy, migration line and client-side gate was checked verbatim and no server-side re-check exists on any of these write paths.

**Done when.**

- [ ] a BEFORE UPDATE trigger on documents rejects any change to legal_hold/legal_hold_* , retention_until, disposition_state or disposed_at unless is_org_controller(org_id) or auth.uid() IS NULL
- [ ] libraries' recert_policy / last_recertified_at / next_recertification_date get the same controller-only guard
- [ ] document_disposition_events and access_recertification_events are split into FOR SELECT (member) + FOR INSERT (controller) with no UPDATE or DELETE policy for authenticated

**Partial (2026-09-23, Round F).** Reproduced against current code: done-when 1 and the disposition half of done-when 3 were already closed by `20261043` (roles-and-permissions `SURF-3`: `trg_document_retention_guard` BEFORE UPDATE — legal_hold/legal_hold_* controller-only, retention columns controller/owner/publisher; `document_disposition_events` append-only with a RESTRICTIVE INSERT authority) — verified live 2026-09-02. What was still open: the `libraries` attestation columns were writable by any member (`enforce_library_sensitive_columns`, 20261036, guards `recert_policy` but not `last_recertified_at` / `last_recertified_by` / `next_recertification_date`), and the disposition trail's DELETE was controller-permitted. Landed in `supabase/migrations/20261077_dc_roundF_records_rails.sql`: §2 extends the live 20261036 body (lineDiff-pinned: nothing removed) with an arm refusing a change to `last_recertified_at` / `last_recertified_by`, or to `next_recertification_date` when it moves ALONE (`NEW.recert_policy IS NOT DISTINCT FROM OLD.recert_policy`), unless `is_org_controller(OLD.org_id)` OR the caller is the library owner (roles `DEL-6`: owners recertify, and its resolution says the owner arm must be added the day `libraries` UPDATE is narrowed — the app path `recertifyAccess` is an owner-or-controller write). The arm is scoped to the ATTESTATION on purpose: `setRecertPolicy` writes `recert_policy` and `next_recertification_date` in one statement, and the live policy arm admits controller / owner / `can_manage_node` for that cadence write — a next date that moves together with a policy change stays under the policy arm, so an ACL-manage holder who could set the cadence before this migration still can, while a next date pushed on its own (the self-attestation shape) is refused. §5 tightens `doc_disposition_events_no_delete` to `USING (false)`. The scan's `recert_notified_at` watermark is deliberately left unguarded (not authority).
- Tests: `lib/__tests__/dcRoundFMigration.test.ts` — "§2 … removes nothing", "adds exactly the attestation-column arm: controller OR the library owner" (pins the `AND NEW.recert_policy IS NOT DISTINCT FROM OLD.recert_policy` scoping), "§5 the disposition trail's DELETE policy is USING (false)". The migration's own probe checks the same substring in `prosrc`.
- Pending migration: `supabase/migrations/20261077_dc_roundF_records_rails.sql` (§2, §5).

**Done-when.**
- ✓ BEFORE UPDATE trigger on documents guards legal_hold/legal_hold_*, retention_until, disposition_state, disposed_at — `20261043` (live).
- ✓ libraries' attestation columns get the controller-or-owner guard — `supabase/migrations/20261077_dc_roundF_records_rails.sql` §2 (pending apply): `last_recertified_at` / `last_recertified_by` always; `next_recertification_date` when it changes without a `recert_policy` change. `recert_policy` (and a next date set with it) stays under the 20261036 arm (controller / owner / `can_manage_node`) — the cadence is not narrowed by this migration; only the attestation is.
- ✓ / ✗ `document_disposition_events`: SELECT member + RESTRICTIVE INSERT authority (20261043), no UPDATE (20261043), no DELETE for any non-service role (20261077 §5). **`access_recertification_events` NOT done here**: the fleet plan assigns that table's policy split (INSERT bound to `performed_by = auth.uid()`, no UPDATE/DELETE, replacing `access_recert_events_member`) to admin-and-org P9 `ALOG-2`, which runs after this wave; a second migration on the same policies from this package would fork it.

**Scope / residual.** Stays OPEN until `ALOG-2` lands its migration; the record then closes by pointer. `libraries.acl` (also named in the mechanism) is under the 20261036 guard already.

**Resolution (2026-10-07, admin-and-org Round G).** Closed by pointer, as the integrator's orphan sweep assigned it (admin-and-org P9, `ALOG-2`). Re-verified on base `c537602` (DEC-29): done-when 1 holds (`20261043`, live), done-when 2 holds in `20261077` §2 (PASTE pending — the library attestation columns, controller or owner), and the disposition half of done-when 3 in `20261043` / `20261077` §5. The open part was the second table: `access_recertification_events` still had only the two member `FOR ALL` policies (`20260821:41-44`, `20260819:223-238`). `supabase/migrations/20261188_ao_roundG_access_recert_events.sql` (admin-and-org `ALOG-2`) drops both and leaves a member SELECT, an INSERT bound to `performed_by = auth.uid()` for a controller (by the role collection) or the library's owner — the same population `20261077` §2 admits for the attestation columns — repeated as a RESTRICTIVE INSERT, and RESTRICTIVE no-UPDATE / no-DELETE (`USING (false)`). The done-when wrote "INSERT (controller)"; the brief's ruling for `ALOG-2` (narrow to the owner, Admin and DocCtrl) keeps the library owner, whom roles `DEL-6` and `20261077` §2 already admit to record a recertification. Exercised on a throwaway PostgreSQL 16 (`ALOG-2`'s record); pinned by `lib/__tests__/aoRoundGP9RecertEvents.test.ts` (a replay of `schema.sql` and every numbered migration leaves exactly those five policies on the table).

**Done-when.**
- ✓ documents' legal-hold / retention columns guarded — `20261043` (live).
- ✓ libraries' attestation columns controller-or-owner — `20261077` §2 (PASTE pending).
- ✓ `document_disposition_events` and `access_recertification_events` are SELECT (member) + INSERT (authority-bound) with no UPDATE or DELETE for authenticated — `20261043` / `20261077` §5 (disposition) and `20261188` (recertification; PASTE pending).

**Scope / residual.** None. Paste order: `20261077` and `20261188` are independent of each other.

---

<a id="ret-5"></a>

## RET-5 · Every retention and legal-hold write ignores supabase-js's {error} and row count — a hold can be reported placed when nothing was written

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/retention.ts:120-132`, `lib/retention.ts:134-145`, `lib/retention.ts:151-159`, `lib/retention.ts:95-109`, `lib/retention.ts:68-91`, `lib/retention.ts:231-244`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. supabase-js resolves an RLS-filtered UPDATE with error null and no row information, so placeLegalHold returns the count of ids it *intended* to patch, and the UI/notification (`notifyHold`, :224-225 'A legal hold was placed on N records') reports that number as fact. Contrast app/api/admin/ticket-shed/commit/route.ts:157-167, which does `{ count: "exact" }` and refuses to proceed on `(count ?? 0) === 0` — the correct pattern already exists in the repo.

**Mechanism.** supabase-js resolves with `{error}` instead of throwing. Not one write in lib/retention.ts inspects it. `placeLegalHold` runs `await supabase.from("documents").update(patch).in("id", ids.slice(i, i+50))` and then returns `ids.length` — a count derived from the SELECT that built the id list, never from the UPDATE. It has no `.select()`, so it cannot even see how many rows changed. RLS silently returns zero rows rather than an error when a row is filtered out, and `documents_deny_write_guard` (20260901:152-162) is a RESTRICTIVE FOR UPDATE policy that filters non-controllers with an explicit ACL deny — again silently. The same blindness covers releaseLegalHold, disposeDocument (which reports `{ok:true}` unconditionally after its update), setRetentionPolicy, recomputeRetention, and the disposition-event insert in logEvent.

**Failure scenario.** A DocCtrl places a litigation hold on a folder of 400 drawings. Half sit in a library the actor cannot SELECT under the ACL restrictive policy, so `scopeDocumentIds` returns only the visible ids; of those, some rows are filtered by the deny guard on UPDATE. Every call resolves without error. placeLegalHold returns 400, a `hold_placed` disposition event is written, and every controller gets a notification reading 'A legal hold was placed on 400 records. Held records can't be deleted or disposed.' In reality an unknown subset still has legal_hold = false, is freely deletable and disposable, and the register's 'Legal holds' tile under-counts. The organisation believes it has preserved evidence it has not.

**Evidence.**

```
lib/retention.ts:126-131 `for (let i = 0; i < ids.length; i += 50) { await supabase.from("documents").update(patch).in("id", ids.slice(i, i + 50)); } ... await notifyHold(input.orgId, ids, "legal_hold_placed", ...); return ids.length;`; lib/retention.ts:156-158 `await supabase.from("documents").update({ disposition_state: "disposed", ... }).eq("id", input.documentId); await logEvent(...); return { ok: true };`; contrast the honest pattern already in the codebase, lib/serverRetention.ts:61-64 `for (const r of results) { if (r.error) { failed += 1; ... } else updated += 1; }`.
```

> **Verifier correction.** Narrow the trigger claim. documents_deny_write_guard passes for every member absent an explicit acl_index deny on 'write'/'editMetadata', so RLS-silent zero-row updates need that specific ACL state; the more routinely reachable failure is a swallowed constraint or transport error (e.g. the disposition_state CHECK from 20260820:26). The unconditional `return ids.length` / `return { ok: true }` is wrong regardless of whether RLS ever bites, which is why this still stands as CONFIRMED.

**Done when.**

- [ ] placeLegalHold/releaseLegalHold add `.select('id')` per chunk and return the count actually written plus a failed count, and the notification/audit text uses the real number
- [ ] disposeDocument checks the update's error and affected count and returns {ok:false, reason} when nothing was written
- [ ] setRetentionPolicy, recomputeRetention and logEvent surface errors to the caller instead of discarding them

**Resolution (2026-09-23, Round F).** Reproduced against current code: `placeLegalHold` / `releaseLegalHold` / `disposeDocument` / `setRetentionPolicy` were already checked (roles-and-permissions `SURF-3` / `OWN-14`, see `HLD-6`), but three writes still discarded `{error}`: `recomputeRetention` (`:83`, `:93`), the eligible-flag update inside `scanRetention` (`:256`) and `logEvent`'s disposition-event insert (`:306`) — a refused re-clock left a stale deadline reading as current, a refused flag write was still notified as "eligible", and a refused trail insert (the 20261043 RESTRICTIVE INSERT authority refuses a caller without hold/retention authority) read as a logged act. `lib/retention.ts` now: `recomputeRetention` throws `Retention clock was NOT updated/cleared: …` (and on the read error); `scanRetention` checks the scan read and each flag write, skips the notification for a refused row, processes the rest, and finally throws `Retention scan flagged N record(s) but M flag write(s) were refused — …` (the maintenance cron records it per org); `logEvent` throws `The <action> was applied but its records-management event could NOT be written (…). The trail is incomplete — report this.` — so a hold that was applied but not logged surfaces instead of vanishing.
- Tests: `lib/__tests__/dcRoundFRecords.test.ts` — "recomputeRetention throws when the clock write is refused", "…when clearing the clock is refused", "logEvent surfaces a refused disposition-event insert (the hold was applied; the trail was not)" (no notification fires), "scanRetention names the scheduled action, skips a refused flag write and reports it".
- Files: `lib/retention.ts`.

**Done-when.**
- ✓ `placeLegalHold`/`releaseLegalHold`: `.select('id')` per chunk, the count returned is what actually held; a short count throws before any event or notification (`SURF-3`/`OWN-14`, verified current); the notification fires only when held === ids.length, so its number is the real one.
- ✓ `disposeDocument` checks error and affected rows, returns `{ ok:false, reason:"refused" }` on zero rows (`SURF-3`, verified current).
- ✓ `setRetentionPolicy` (already), `recomputeRetention` and `logEvent` surface errors to the caller; `scanRetention` surfaces refused flag writes.

**Scope / residual.** `logAuditAction` inside `logEvent` stays best-effort (`.catch`) by design — `audit_logs` is the secondary mirror; the records-management row is the record.

---

<a id="ret-6"></a>

## RET-6 · R2 objects are deleted using keys read from member-writable columns and JSON, with no org-prefix check on the destructive path

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1068-1080`, `app/api/admin/shed/commit/route.ts:58-98`, `app/api/admin/ticket-shed/commit/route.ts:136-139`, `app/api/admin/ticket-shed/commit/route.ts:186-193`, `app/api/admin/ticket-shed/restore/route.ts:139-144`, `app/api/admin/shed/route.ts:150-168`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the contrast the finding draws is exact: app/api/admin/ticket-shed/restore/route.ts:139-144 already applies the missing rule on the WRITE path — `.filter((k) => k && k.startsWith(prefix))` with the comment 'The only keys we may write are the ones the LIVE stub records, under our prefix' — while the DELETE path applies no prefix or ownership check to the same attacker-writable field. app/api/admin/shed/route.ts:150-168 likewise GETs `r.file_url` verbatim into the archive.

**Mechanism.** `documents_org_access`, `document_versions_org_access` and `tickets_org_access` are all `FOR ALL USING (org_id IN (SELECT my_org_ids()))` with NO WITH CHECK — the recurring pattern. Per the composition rule, USING is reused as the INSERT/UPDATE check, so any active org member can UPDATE `document_versions.file_url` or `tickets.attachments[].url` to any string. The only RESTRICTIVE policies added later are FOR SELECT (20260813) and FOR DELETE (20260815) — neither constrains UPDATE. Both commit routes then feed those values straight into DeleteObjects: shed/commit maps `v.file_url`; ticket-shed/commit's `keysFor` maps `a?.url`. Neither checks that the key starts with `orgs/<orgId>/`. The restore route in the same directory DOES apply exactly that check and documents why ('no within/cross-org overwrite'), which makes the omission on the delete side an internal inconsistency, not an oversight of an unknown threat. The produce paths are worse: they GetObject each key and bundle the bytes into the zip the admin downloads.

**Failure scenario.** An active member (any role — Viewer suffices for RLS) PATCHes a long-closed ticket's attachments to `[{"url":"orgs/<sameOrg>/libraries/<lib>/P-101-RevD.pdf"}]`, or sets a decade-old superseded version's file_url to the current revision's key. The next routine space-saver bundles that key into the archive (exfiltrating a document the member may not be able to read, since document ACLs do not gate an R2 key) and, on commit, deletes it from R2. Nothing in either commit route can tell the substituted key from a legitimate one, the audit row records only counts, and the affected document's own version row still has archived_at = null so the archive-prompt UI never fires — the file just 404s.

**Evidence.**

```
supabase/schema.sql:1068-1070 `CREATE POLICY "documents_org_access" ON documents FOR ALL USING (org_id IN (SELECT my_org_ids()));` and :1079-1080 the identical `tickets_org_access`; app/api/admin/ticket-shed/commit/route.ts:136-139 `const keysFor = (t: TombstoneSource): string[] => (Array.isArray(t.attachments) ? t.attachments : []).map((a) => (a?.url || "").toString()).filter(Boolean);`; contrast restore/route.ts:141-144 `.map((a) => (a?.url || "").toString()).filter((k) => k && k.startsWith(prefix))`.
```

> **Verifier correction.** The missing prefix check is CONFIRMED as a code fact; the cross-tenant deletion outcome is a step short of observable — it needs a member to tamper with file_url/attachments via PostgREST AND an Admin/DocCtrl to then run shed commit (both commit routes are gated by authorizeOrgRole with SHED_ROLES = ['Admin','DocCtrl']). Treat the consequence as SUSPECTED, the gap as CONFIRMED.

**Done when.**

- [ ] both commit routes filter every key through `key.startsWith('orgs/' + orgId + '/')` (and assertSafeStorageKey) before DeleteObjects, counting and reporting rejects
- [ ] the produce routes apply the same prefix filter before GetObject so a substituted key cannot be exfiltrated into the archive
- [ ] document_versions.file_url and tickets.attachments get a write guard (trigger or column-scoped policy) so a non-controller cannot repoint an existing row's storage key

**Resolution (2026-09-23, Round F).** Reproduced: `shed/commit` mapped `v.file_url` verbatim into `DeleteObjects` (`:131-133`), `ticket-shed/commit`'s `keysFor` mapped `a?.url` verbatim (`:136-139`), and both produce routes `GetObject`ed the same values, while `ticket-shed/restore` already applied `startsWith("orgs/<orgId>/")` on its write path. New `lib/shedKeyGuard.ts`: `isOrgOwnedKey(key, orgId)` = `isSafeStorageKey` (lib/storageKey.ts — traversal, control bytes, leading slash) AND `orgs/<orgId>/` prefix; `partitionOrgKeys`. Applied at every destructive step: document produce (preview and claim — a rejected row is never claimed, `rejectedKeys` in the preview, the response headers and ARCHIVE.txt), document commit (rejected rows left linked, unstamped, undeleted; `rejectedKeys` in the response and the `DATA_ARCHIVE_RECLAIM` audit detail), ticket produce (a ticket carrying ANY non-owned attachment key is skipped and un-claimed BEFORE any `GetObject`, `skippedForeignKey` / `X-Archive-Rejected-Keys`), ticket commit (`keysFor` filters and counts). Done-when 3 at the database: `supabase/migrations/20261077_dc_roundF_records_rails.sql` §3 `enforce_document_version_key_guard` (BEFORE UPDATE ON document_versions) refuses any `file_url` change for every authenticated caller (no app path repoints an existing row; the service-role intake route passes).
- Tests: `lib/__tests__/dcRoundFShed.test.ts` — "isOrgOwnedKey: only a safe key under orgs/<orgId>/", "preview excludes a foreign-prefixed key…", "produce never claims a foreign or shared key…", "frees only org-owned, unshared keys…", "produce skips (and un-claims) a ticket carrying an attachment key outside the org prefix", "commit deletes only org-owned keys…"; `lib/__tests__/dcRoundFMigration.test.ts` "§3 document_versions.file_url is write-once…".
- Files: `lib/shedKeyGuard.ts` (new), `app/api/admin/shed/route.ts`, `app/api/admin/shed/commit/route.ts`, `app/api/admin/ticket-shed/route.ts`, `app/api/admin/ticket-shed/commit/route.ts`; migration §3.
- Pending migration: `supabase/migrations/20261077_dc_roundF_records_rails.sql` (§3).

**Done-when.**
- ✓ both commit routes filter every key through the org prefix AND `assertSafeStorageKey` before DeleteObjects, counting and reporting rejects.
- ✓ both produce routes apply the same filter before GetObject (document rows never claimed; ticket skipped whole).
- ✓ / ✗ `document_versions.file_url` write guard — `supabase/migrations/20261077_dc_roundF_records_rails.sql` §3 (pending apply). **`tickets.attachments` gets no column guard here**: `tickets` carries the drafting-flow workflow rails (20261038/20261039 deliberately leave `attachments` appendable by requesters); the delete/produce paths are closed by the prefix filter plus the RET-8 live-revision check (a substituted key naming a live controlled revision is never freed), which is the exploit the finding describes.

**Scope / residual.** Verifier framing stands: cross-tenant deletion needed a member's PostgREST tamper AND a controller's commit; both halves are now refused. A guard that keeps `tickets.attachments[].url` write-once per entry is drafting-flow territory (open there if wanted).

---

<a id="ret-7"></a>

## RET-7 · The orphan purge is bucket-wide, not org-scoped: one workspace's admin deletes every other tenant's orphaned objects

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/storageOrphans.ts:118-150`, `lib/storageOrphans.ts:152-177`, `app/api/admin/orphans/route.ts:22-33`, `app/api/admin/orphans/route.ts:35-58`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. lib/serverAuth.ts:49-58 authorizes against membership of whatever org the caller names, so any Admin of any workspace — including a self-signup personal org — can sweep every tenant's objects. The reference collector does read all orgs' rows (service-role client, no org filter), so genuinely-referenced files are safe; the sharp edge is that any table missing from the sources list at lib/storageOrphans.ts:43-88 turns into cross-tenant destruction of live files, which the file's own comment at :78-80 records as having already happened once for output_templates.

**Mechanism.** `scanOrphans(sb)` walks the entire R2 bucket with ListObjectsV2 and no prefix, and `collectReferencedKeys(sb)` gathers referenced keys across every org using the service-role client. Neither takes an orgId. The route resolves `orgId` purely for `authorizeOrgRole` and the audit row, then calls `deleteOrphans(actor.admin)` — the delete set is every unreferenced object in the shared bucket. The GET is the same: it returns bucket-wide totalObjects/totalBytes and the 500 largest orphan keys, whose paths embed other orgs' `orgs/<uuid>/…` prefixes.

**Failure scenario.** Org A's Admin clicks 'Delete orphans' to reclaim 4 GB. The sweep deletes unreferenced objects belonging to Orgs B, C and D as well — including any object whose owning table was not registered in the reference collector (the file's own comment records that output_templates was exactly such a miss, making 'every uploaded template an orphan seven days after upload'). Org B loses files it never authorised anyone to touch, its admin sees no audit row (the DATA_PURGE-style row is written under Org A's org_id), and the GET beforehand already disclosed Org B's storage volume and key names to Org A.

**Evidence.**

```
lib/storageOrphans.ts:127-129 `const res = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, ContinuationToken: token, MaxKeys: 1000 }));` (no Prefix); app/api/admin/orphans/route.ts:47 `const result = await deleteOrphans(actor.admin);` with orgId used only at :50-52 `resource_id: orgId, org_id: orgId`; lib/storageOrphans.ts:78-79 comment 'every uploaded .docx/.xlsx template and example was an "orphan" seven days after upload and eligible for permanent deletion.'
```

> **Verifier correction.** One real mitigation to record: collectReferencedKeys is bucket-wide TOO, so a key referenced by any tenant is protected, as are PROTECTED_PREFIXES and objects younger than MIN_AGE_DAYS. The residual harm is therefore (a) cross-tenant disclosure in GET — other orgs' `orgs/<uuid>/…` key paths, sizes and bucket totals returned to any Admin/DocCtrl — and (b) any gap in the reference collector (the output_templates comment at :76-79 documents exactly such a gap having existed) silently deleting another tenant's live files with no org confinement. HIGH stands on (a)+(b), but not on 'deletes referenced files'.

**Done when.**

- [ ] scanOrphans and deleteOrphans take an orgId and pass `Prefix: 'orgs/' + orgId + '/'` to ListObjectsV2, skipping any key outside that prefix
- [ ] the reference collector still runs org-wide (a cross-org reference must protect a key) but the delete set is intersected with the caller's prefix
- [ ] the GET response reports only the caller's org's totals and keys

**Resolution (2026-09-23, Round F).** Reproduced: `scanOrphans(sb)` listed with no `Prefix` (`:151`) and `deleteOrphans(sb)` deleted every unreferenced object in the shared bucket; the route resolved `orgId` only for `authorizeOrgRole` and the audit row. `lib/storageOrphans.ts`: `scanOrphans(sb, orgId, maxPages)` requires an orgId, lists with `Prefix: orgs/<orgId>/`, skips any key outside that prefix even if a listing hands one back, and reports `totalObjects` / `totalBytes` for that prefix only plus `scope`; `deleteOrphans(sb, orgId)` re-scans server-side and sends only in-prefix keys to `DeleteObjects`. `collectReferencedKeys` stays bucket-wide on purpose (a key any tenant references is protected). `app/api/admin/orphans/route.ts` passes the caller's org to both and records `scope` in the `STORAGE_ORPHANS_PURGED` audit detail.
- Tests: `lib/__tests__/dcRoundFShed.test.ts` — "scanOrphans lists with Prefix orgs/<orgId>/ and ignores anything outside it, totals included", "deleteOrphans never sends a key outside the prefix to DeleteObjects", "refuses to walk without an orgId".
- Files: `lib/storageOrphans.ts`, `app/api/admin/orphans/route.ts`.

**Done-when.**
- ✓ `scanOrphans` / `deleteOrphans` take an orgId and pass `Prefix: 'orgs/' + orgId + '/'`, skipping any key outside it.
- ✓ the reference collector still runs org-wide; the delete set is the caller's prefix only.
- ✓ the GET reports only the caller's org's totals and keys (`scope` says which prefix).

**Scope / residual.** Objects outside every `orgs/<uuid>/` prefix (legacy layout, if any exist) are now reachable by no tenant's sweep — an operator-level inventory (`ListObjectsV2` without prefix, counting keys not under `orgs/`) belongs to admin-and-org `BKP-2`/`BKP-9`, which own the collector side; the storage page's orphan section wording ("files in storage") is unchanged.

*Cross-area note (2026-09-30, intelligence Round G; corrected by its fix pass 3): intelligence `ILIFE-8` (the same bucket-wide sweep) cites this resolution for its listing half and its reference-query limb is declined by `DEC-57` (this finding's Done-when 2, made a decision), but ILIFE-8 stays OPEN on the `referencedKeys` residual below. Done-when 3 ("the GET response reports only the caller's org's totals") does not fully hold: the GET spreads the whole scan (`app/api/admin/orphans/route.ts:30`), including `referencedKeys: referenced.size` (`lib/storageOrphans.ts:187`), a count of the keys every tenant references. Recorded as an ILIFE-8 residual (owner admin-and-org P2, `BKP-2`); the status is left to document-control.*

---

<a id="ret-8"></a>

## RET-8 · revertToVersion reuses the old revision's storage key, so shedding the old revision deletes the CURRENT revision's bytes

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/revisions.ts:1165-1184`, `app/api/admin/shed/commit/route.ts:58-110`, `lib/shed.ts:74-116`, `app/api/storage/resolve/route.ts:31-38`, `app/api/storage/resolve/route.ts:74-90`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide search: no code path anywhere dedupes or reference-counts file_url before deletion (only supabase/migrations/20260827_file_url_index.sql indexes it, and no shed query joins on it). The old row is superseded and beyond keep-N so it is selected; deleting its key destroys the bytes the revert row — the CURRENT revision — points at. Worse, /api/storage/resolve/route.ts:32-38 orders by created_at DESC limit 1, so the lookup lands on the revert row (archived_at NULL, archive_id NULL) and line 87 returns `archived:true, missing:true, archiveId:null` — the user is told to provide an archive the UI cannot name.

**Mechanism.** A revert inserts a NEW document_versions row that points at the SAME R2 key as the revision it reverts to — the code says so explicitly: 'The new version row reuses the target version's file_url. We deliberately do NOT copy the file in storage.' Two rows now share one key. The old row is superseded and, once it falls beyond keep-N, is shed-eligible; the new revert row is current (superseded_at null) and is not. shed/commit builds its delete list purely from `versions.filter(...).map((v) => v.file_url)` for rows linked to the archive — it never asks whether any other non-archived version references the same key. Deleting the superseded row's key destroys the current revision's binary. `grep -rn 'file_url:'` across lib and app confirms revisions.ts:1175 is the only place a version row copies another's key.

**Failure scenario.** A drafter reverts P-101 from Rev C back to Rev A (say Rev C had a wrong line spec). The revert creates Rev 'A-revert-<ts>' as current, sharing Rev A's key. Months later Rev A is beyond keep-5 and superseded, so the shed bundles it; commit deletes the key. The CURRENT, issued revision of P-101 now has archived_at = null and a dangling file_url. /api/storage/resolve finds the newest row for that key (the revert, archived_at null), HeadObject fails, and it falls through to `{archived:true, missing:true, archiveId: v?.archive_id ?? null}` — archive_id is null on the revert row, so the fitter is told 'ask an admin which backup holds it' with no archive name. The controlled drawing a worker needs is simply gone from the live system, and the register still shows it as Issued.

**Evidence.**

```
lib/revisions.ts:1165-1168 comment + :1175 `file_url: targetVersion.fileUrl,`; app/api/admin/shed/commit/route.ts:96-98 `const keys = versions.filter((v) => v.archived_at || stampedKeys.has(v.file_url)).map((v) => v.file_url).filter(Boolean).map((Key) => ({ Key: Key as string }));`; app/api/storage/resolve/route.ts:87-89 `catch { const s = await settingsFor(); return NextResponse.json({ archived: true, missing: true, archiveId: v?.archive_id ?? null, ... }); }`.
```

> **Verifier correction.** Severity lowered to HIGH, not CRITICAL: the bytes are not destroyed, they are inside the produced archive zip, so this is loss of ONLINE availability of the current revision plus a broken recovery pointer. Also correct the resolve behaviour — app/api/storage/resolve/route.ts:31-38 orders `created_at` DESC limit 1, so it resolves the shared key to the NEWER revert row, whose archived_at is null and whose archive_id is null; HeadObject then fails and the catch at the end of the file returns `{archived:true, missing:true, archiveId: v?.archive_id ?? null}` — the user is told to fetch an archive the response cannot name.

**Done when.**

- [ ] shed/commit excludes any key that is still referenced by a document_versions row with archived_at IS NULL (a GROUP BY file_url check before the delete batch)
- [ ] either the same exclusion is applied at produce time so shared-key revisions are never claimed, or revertToVersion copies the object to a fresh key
- [ ] a test covers: revert to an old revision, run produce+commit with keep-N excluding the old row, assert the shared key survives

**Resolution (2026-09-23, Round F).** Reproduced: `revertToVersion` copies the target's `file_url` (`lib/revisions.ts:1203`, comment at `:1184`), and neither produce nor commit asked whether another non-archived row referenced a key before freeing it. Rule landed (`lib/shedKeyGuard.ts` `keysSharedOutside` / `sharedLiveKeys`): a key may be freed only when EVERY non-archived `document_versions` row that references it is part of the set being archived. Produce (`refineSelection`, GET preview and POST): after selection, one query per 200 keys for live rows sharing those keys; a selected row whose key is also referenced by a row OUTSIDE the selection is not claimed (`sharedSkipped` in the preview, headers, ARCHIVE.txt). Commit: the same read against the linked set; shared rows are left linked, unstamped and undeleted (`sharedSkipped` in the response and audit detail). Both reads fail CLOSED (503, nothing claimed / nothing freed). The ticket commit applies the same read so a substituted attachment key naming a live revision is never freed. Chosen over copying the object in `revertToVersion`: `lib/revisions.ts` is `P3 LIFECYCLE`'s file, and the exclusion also covers every existing shared pair (the inventory row in `supabase/migrations/20261077_dc_roundF_records_rails.sql` counts them).
- Tests: `lib/__tests__/dcRoundFShed.test.ts` — "keysSharedOutside…", "preview excludes … a key a current revision shares", "produce never claims a foreign or shared key…", "frees only org-owned, unshared keys…", "fails CLOSED … when the shared-key read errors" (produce and commit), "RET-8 end to end: revert to an old revision, shed it beyond keep-N — the shared key survives" (produce claims nothing; a pre-fix-linked row is neither stamped nor deleted at commit).
- Files: `lib/shedKeyGuard.ts`, `app/api/admin/shed/route.ts`, `app/api/admin/shed/commit/route.ts`, `app/api/admin/ticket-shed/commit/route.ts`.

**Done-when.**
- ✓ `shed/commit` excludes any key still referenced by a non-archived row outside the archive (a per-key live-row check before the stamp and the delete batch).
- ✓ the same exclusion at produce time — shared-key revisions are never claimed.
- ✓ the revert → produce+commit test asserts the shared key survives.

**Scope / residual.** A shared pair is shed together once BOTH rows qualify (the exclusion is "outside the set", not "shared at all"). The `/api/storage/resolve` "archived, archiveId null" pointer the verifier noted no longer arises for a shared key (it is never freed); the resolve route itself is untouched.

---

<a id="ret-9"></a>

## RET-9 · Both legal-hold guard functions are SECURITY DEFINER with no SET search_path

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260826_legal_hold_delete_guard.sql:17-27`, `supabase/migrations/20260826_legal_hold_delete_guard.sql:37-50`, `supabase/migrations/20260810_archive_invariants.sql:18-21`, `supabase/schema.sql:1031-1034`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The literal claim is true and the house convention is clearly the opposite (18 of 31 SECURITY DEFINER migration files set search_path). Two corrections pull the severity down: enforce_legal_hold_delete_guard (lines 17-27) references no relation at all — only OLD.legal_hold — so search_path shadowing cannot affect it, leaving one genuinely vulnerable function, not "both"; and the exploit needs CREATE on a schema ahead of public, a DDL privilege that already implies the ability to DROP the trigger outright. LOW (hardening/lint-class) fits better than MEDIUM.

**Mechanism.** `enforce_legal_hold_delete_guard()` and `enforce_legal_hold_version_delete_guard()` are declared `RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$` with no `SET search_path`. The second executes an unqualified `SELECT legal_hold INTO v_hold FROM documents WHERE id = OLD.record_id;` — resolved through the caller's search_path at execution time, as definer. `post_ticket_comment`, written 16 days earlier in the same archive work, does carry `SET search_path = public`, so the hardened form is established practice in this repo. `my_org_ids()` (schema.sql:1031-1034), which every retention-relevant RLS policy depends on, has the same omission.

**Failure scenario.** Any role that can create objects in a schema earlier in the effective search_path (a Postgres role with CREATE on a schema, or a future migration that adds one) shadows `documents` with its own relation. The version guard's unqualified SELECT then reads the shadow table, returns NULL, COALESCE makes it false, and document_versions rows belonging to a held record delete freely — while every UI still shows the hold. The guard is the last line of defence for spoliation prevention (the migration header says so explicitly), so a silent bypass here is not observable from the app.

**Evidence.**

```
20260826:17-18 `CREATE OR REPLACE FUNCTION enforce_legal_hold_delete_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$` and :37-42 `CREATE OR REPLACE FUNCTION enforce_legal_hold_version_delete_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ DECLARE v_hold boolean; BEGIN SELECT legal_hold INTO v_hold FROM documents WHERE id = OLD.record_id;`; contrast 20260810:18-21 `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public`.
```

> **Verifier correction.** No correction needed — both declarations, the unqualified cross-table SELECT, the in-repo hardened counterexample and the my_org_ids omission were each read verbatim.

**Done when.**

- [ ] both functions are recreated with `SET search_path = public` (or pg_catalog, public) and their table references schema-qualified
- [ ] my_org_ids(), node_visible(), doc_is_visible() and my_project_ids() get the same treatment
- [ ] a schema-health check enumerates SECURITY DEFINER routines lacking a search_path setting and fails the build

**Resolution (2026-09-23, Round F — record-only close).** Verified against current code and closed by pointer to roles-and-permissions `DB-6`: `supabase/migrations/20261020_pin_search_path.sql` pins `SET search_path = public` via `ALTER FUNCTION` on `enforce_legal_hold_delete_guard()`, `enforce_legal_hold_version_delete_guard()`, `my_org_ids()`, `node_visible(text, jsonb, uuid)`, `doc_is_visible(uuid)` and `my_project_ids()` (all named in this finding's done-when) — **applied & verified live 2026-08-24** (probe: zero `SECURITY DEFINER` functions in `public` without a pinned `search_path`). `lib/__tests__/searchPathPin.test.ts` replays the whole migration set and fails the suite on any definer function whose final definition is unpinned and not in the 20261020 list; `20261020`'s trailing SELECT probes `pg_proc` live. Nothing to write here.

**Done-when.**
- ✓ / ✗ both functions pin `search_path = public` (by ALTER, live). Their table references are **not** schema-qualified: `DB-6` chose ALTER over re-CREATE deliberately (DEC-30 — the deployed bodies are left untouched), and with `search_path` pinned to `public` an unqualified `documents` resolves only there, which is the property the finding wants.
- ✓ `my_org_ids()`, `node_visible()`, `doc_is_visible()`, `my_project_ids()` pinned the same way (same migration).
- ✓ a schema-health check fails the suite on any unpinned definer function (`searchPathPin.test.ts`; vitest is part of the ship loop).

**Scope / residual.** None. `DRLS-11` (the ten further functions) closes the same way.

*Cross-area note (2026-10-02, admin-and-org Round G, P0): this record's done-when 3 cites `lib/__tests__/searchPathPin.test.ts`. admin-and-org `ORG-6` found that the lint's exemption for 20261020's list ignored order. Both legal-hold guards are pinned by that ALTER alone. So re-creating either one after 20261020 without `SET search_path` would have passed the lint while the live pin was reset. The lint is now order-aware. On `f1ac550` neither guard had been re-created (final definitions `20260826`), so this record's claims held.*

---

<a id="ret-10"></a>

## RET-10 · Deleting a folder silently drops folder-inherited retention, and the 30-day trash restore never puts it back

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/collections/delete/route.ts:62-65`, `app/api/collections/delete/route.ts:99-120`, `app/api/collections/trash/route.ts:83-99`, `lib/serverRetention.ts:42-51`, `supabase/migrations/20260820_retention.sql:19-26`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified there is no compensating guard: nothing in the delete route checks retention_until, disposition_state or legal_hold before stepping documents up, and no restore path re-clocks documents. Docs carrying their OWN retention_policy are unaffected (resolveEffectiveRetentionPolicy prefers doc policy), so the finding's scoping to folder-INHERITED retention is precise. lib/retention.ts:174-179 then skips them permanently — scanRetention filters `.not("retention_until","is",null)`.

**Mechanism.** Folder delete steps documents up to the heir parent and re-clocks them against the heir's effective policy. `reclockRetentionForDocs` computes `const state = !policy ? null : ...` — when the heir folder and library have no policy, every stepped-up document gets `retention_until: null, disposition_state: null`. The folder shell is then only SOFT-deleted (30-day trash). The trash restore, however, updates only the collection row: `.update({ deleted_at: null, deleted_by: null, parent_id: parentId })`. It never moves the documents back into the restored folder and never re-clocks them, so the retention binding is gone permanently even though the operator believes they undid the delete. The audit row records only `retentionRecomputed`/`retentionFailed` counts — never that N records lost their retention deadline.

**Failure scenario.** A controller deletes the folder 'Unit 4 / Radiography Records', which carried a 30-year retention policy; its 800 documents step up to a library root with no policy and are re-clocked to retention_until = NULL, disposition_state = NULL. The register now shows them as having no retention policy, they never appear in scanRetention (which requires a non-null retention_until), and no disposition obligation will ever fire. The controller notices, opens 'Recently deleted' and restores the folder — the shell comes back empty and the 800 records keep their nulled clock. Nothing in the UI or the audit trail says the retention deadline was destroyed.

**Evidence.**

```
lib/serverRetention.ts:46-49 `const until = policy ? computeRetentionUntil(retentionBasisISO(policy, d), policy) : null; const state = !policy ? null : until && until <= today ? "eligible" : "active"; ... return { id: d.id, retention_until: until, disposition_state: state };`; app/api/collections/trash/route.ts:99 `.update({ deleted_at: null, deleted_by: null, parent_id: parentId })`; lib/retention.ts:173-176 the scan requires `.not("retention_until", "is", null)`.
```

> **Verifier correction.** No correction needed — the delete path, the reclock-to-null, the shell-only restore and the audit-detail gap were each read in full and no compensating re-clock exists on the restore side.

**Done when.**

- [ ] folder delete refuses, or requires an explicit extra confirmation naming the count, when re-clocking would null a non-null retention_until on any stepped-up document
- [ ] the FOLDER_DELETED audit detail records how many documents lost a retention deadline and what it was
- [ ] trash restore returns the stepped-up documents to the restored folder and re-clocks them, or the delete dialog states plainly that restoring will not

**Resolution (2026-09-23, Round F).** Reproduced: `reclockRetentionForDocs` writes `retention_until: null, disposition_state: null` when the heir has no policy (`lib/serverRetention.ts:46-49`), the delete route re-clocked after the move with no check, and the trash restore updated the collection row only (`trash/route.ts:99`). `app/api/collections/delete/route.ts` now previews the re-clock BEFORE anything moves (`previewRetentionLoss`: the folder's documents × the heir's effective policy through the pure `lib/retentionPolicy.ts` rules) and refuses with 409 `Deleting this folder would remove the retention deadline from N record(s) (e.g. until …) … Set a retention policy on the parent folder or library (or on the records) first, or delete with acknowledgeRetentionLoss: true …` plus `retentionLoss: { count, sample }` unless the body carries `acknowledgeRetentionLoss: true`; fails closed (500) when the preview read errors. The `FOLDER_DELETED` audit detail records `retentionDeadlinesLost`, `retentionDeadlinesLostSample` (id + the deadline that was lost), `retentionLossAcknowledged` and `steppedDocIds`. `app/api/collections/trash/route.ts` restore reads that detail (latest `FOLDER_DELETED` row for the folder), moves back ONLY the documents still sitting where the delete left them (`collection_id = contentsMovedTo`, same library), re-clocks them against the restored folder's own `retention_policy` + the library's, and reports `documentsReturned` / `retentionRecomputed` / `retentionFailed` (or a `note` saying why nothing came back) in the response and the `FOLDER_RESTORED` audit row. The PRODUCT path: `lib/libraryCollections.ts` `deleteFolder` (the only caller of the route) posts without the flag first; on a 409 carrying `retentionLoss` it opens `confirmRetentionLoss` — an `appConfirm` titled "N record(s) would lose their retention deadline", naming the sample deadlines and the workaround, button "Delete and accept the loss" — and only on a yes re-posts with `acknowledgeRetentionLoss: true`; a declined dialog THROWS ("Folder not deleted — N records keep their retention deadline") so the page never removes the folder from the screen; any other refusal surfaces the route's message unchanged. The acknowledgement is never sent pre-emptively. The confirmation is injectable (`opts.confirmRetentionLoss`) for a caller with its own dialog.
- Tests: `lib/__tests__/dcRoundFCollections.test.ts` — "refuses (409) with the count and sample deadlines when the heir has no policy; nothing moves", "proceeds when the heir carries a policy … records zero lost", "with acknowledgeRetentionLoss the delete proceeds and the audit detail names what was lost", "fails closed when the preview read errors", "moves back only the records still at the heir, re-clocked against the restored folder's policy", "restores the shell alone, and says so, when no delete record names the documents"; the client half — "first POST carries no acknowledgement; on 409 the dialog names the count and deadlines; confirming re-POSTs acknowledgeRetentionLoss: true", "declining is a refusal, not a silent success", "a clean delete never asks; any other refusal surfaces the route's message unchanged", "an injected confirmation replaces the dialog".
- Files: `app/api/collections/delete/route.ts`, `app/api/collections/trash/route.ts`, `lib/libraryCollections.ts` (`deleteFolder`, `confirmRetentionLoss`, `RetentionLoss`).

**Done-when.**
- ✓ folder delete refuses when re-clocking would null a non-null `retention_until`, naming the count and sample deadlines; the extra confirmation is the in-product dialog `deleteFolder` opens on the refusal, which sends `acknowledgeRetentionLoss: true` only on a yes.
- ✓ the `FOLDER_DELETED` detail records how many documents lost a deadline and what it was.
- ✓ trash restore returns the stepped-up documents to the restored folder and re-clocks them.

**Scope / residual.** The folder page (`P6`'s `app/(protected)/documents/[libraryId]/page.tsx`) is untouched: it calls `deleteFolder(id, orgId)` and gets the dialog through the lib default; its catch shows "Couldn't delete that folder." on a decline (wave 2 may word that as the thrown message). The restore's memory of what moved is the audit row (best-effort insert); when it is missing the restore says so and restores the shell alone, exactly as before.

---

<a id="ret-11"></a>

## RET-11 · RetentionPolicy.action ('review' | 'archive' | 'destroy') is edited, stored and inherited but never read by anything

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** document-control P14 RECORDS & REVIEW REMAINDERS (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `types/schema.ts:215-223`, `components/documents/RetentionSection.tsx:189-191`, `components/documents/RetentionPolicyModal.tsx:45`, `lib/retention.ts:183-197`, `lib/retention.ts:151-159`, `lib/retentionPolicy.ts:21-27`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Claim of absence confirmed by grep: no consumer in lib/, components/, app/ or any SQL branches on the field. lib/retention.ts:194 also hardcodes the notification body "eligible for disposition review" for every policy. A records schedule configured 'destroy' silently becomes 'archive' — over-retention, which is itself a legal exposure, so MEDIUM stands even though the behavior fails in the safe direction.

**Mechanism.** The policy editor offers a 'then review / archive / destroy' selector and persists it into the JSONB. Nothing consumes it: computeRetentionUntil reads only enabled/years/basis; resolveEffectiveRetentionPolicy passes the object through; scanRetention's notification body is fixed text ending 'and is eligible for disposition review'; disposeDocument's `action` parameter comes from the caller (always the literal "archive" at RetentionSection.tsx:94) and is written to the event detail but never branched on. Grepping `.action` across the retention modules finds only the editor's setState and the log line.

**Failure scenario.** A records manager configures the piping library as 'Retain 7 years from issued, then destroy' to satisfy a records schedule. Seven years later the record becomes eligible and the notification says 'eligible for disposition review' — the same wording as a 'review' policy. The Dispose button archives it and marks it disposed. Nobody is ever told the schedule called for destruction, and no report distinguishes the three dispositions. The organisation believes it has an enforced destruction schedule it does not have, which is a defensible-disposal failure in the opposite direction from finding 1.

**Evidence.**

```
lib/retention.ts:194 `body: \`This record has passed its retention date (${(d.retention_until as string).slice(0, 10)}) and is eligible for disposition review.\`` — no reference to policy.action; components/documents/RetentionSection.tsx:190 `<option value="review">review</option><option value="archive">archive</option><option value="destroy">destroy</option>`; components/documents/RetentionSection.tsx:94 `disposeDocument({ documentId: doc.id, orgId, action: "archive", ... })`; types/schema.ts:221-222 `/** What to do at end of life (a prompt to the controller, never automatic). */ action?: "review" | "archive" | "destroy";`.
```

> **Verifier correction.** Strengthen it slightly: the field is not even surfaced read-only. describeRetention at components/documents/RetentionSection.tsx:26 renders `Retain ${p.years} year(s) from ${p.basis ?? "created"}` — so a controller who selects 'then destroy' sees no trace of that choice outside the open editor, which undercuts the type's own 'a prompt to the controller' justification.

**Done when.**

- [ ] scanRetention resolves the effective policy per document and names the scheduled action in the notification title/body
- [ ] the register and the disposition UI surface the scheduled action, and disposeDocument defaults its action from the effective policy rather than a hardcoded "archive"
- [ ] or the selector is removed from both editors until the action is honoured

**Partial (2026-09-23, Round F).** Reproduced: nothing read `RetentionPolicy.action` (`scanRetention` body fixed text, `RetentionSection` `action: "archive"` hard-coded, `describe()` silent). Landed: `lib/retentionPolicy.ts` (pure) `scheduledActionFor` / `scheduledActionLabel` ("flag for review" | "archive" | "destroy") / `disposeActionFor` ('destroy' → destroy, else archive) / `describeRetentionPolicy` ("Retain 30 years from issued, then destroy"), re-exported from `lib/retention.ts`. `scanRetention` batch-loads the org's folder and library policies — CHECKED: a failed libraries or collections read throws `Retention scan could not read the policy chain: …` BEFORE any record is flagged (an empty map would have named "flag for review" for a "then destroy" schedule; the cron records the throw per org) — resolves each record's effective policy and notifies `Retention reached: <label> — scheduled to <action>` with the body naming the schedule. `disposeDocument` defaults its recorded action from the effective policy when the caller names none and returns `{ ok:true, action }`; its schedule read and `effectiveRetentionPolicyForDocument`'s folder/library reads are checked too — a read error throws with nothing disposed, never recording `archive` for a destroy schedule. `components/documents/RetentionSection.tsx` describes the policy with its action, and its Dispose dialog names the schedule and records the schedule's action (button "Dispose — destroy" for a destroy schedule).
- Tests: `lib/__tests__/dcRoundFRecords.test.ts` — "resolves the action, its label and the disposition default", "describes the policy WITH its end-of-life action", "scanRetention names the scheduled action…" (folder 'destroy' beats library 'archive'), "scanRetention aborts BEFORE flagging anything when the policy chain cannot be read", "records the SCHEDULE's action when the caller names none", "throws (nothing disposed) when the schedule cannot be read", "an explicit action still wins".
- Files: `lib/retentionPolicy.ts`, `lib/retention.ts`, `components/documents/RetentionSection.tsx`.

**Done-when.**
- ✓ `scanRetention` resolves the effective policy per document and names the scheduled action in the title and body.
- ✓ / ✗ the disposition UI surfaces the scheduled action and `disposeDocument` defaults from the effective policy. **The register does not**: `app/(protected)/register/page.tsx:175` renders `RetentionPill` (status only) from row fields that carry no policy chain; naming the schedule there needs the folder/library policies per row — not this package's file, left for the register's owner.
- ✗ (alternative) the selector is not removed — the action is now honoured.

**Scope / residual.** Stays OPEN for the register column. "destroy" still never deletes bytes here (the panel says so: disposition is an explicit logged action; the space-saver handles storage) — the recorded action is the schedule's intent, which is what a records audit asks for. `RetentionPolicyModal.tsx` is unchanged (its selector wording already reads "flag for review / archive / destroy").

**Resolution (2026-10-01, document-control Round F wave 3).** Package **P14 RECORDS & REVIEW REMAINDERS** — the register column, the one limb P9 left. Reproduced on `4dd0df7`: `app/(protected)/register/page.tsx`'s Records column rendered only `RetentionPill` (status), from rows `lib/docControlRegister.ts` built without any policy — the loader selected no `retention_policy` from documents, collections or libraries, so a "then destroy" schedule was invisible on the auditor's register and absent from its CSV.
- `lib/docControlRegister.ts` — `loadDocControlRegister` reads `retention_policy` with the documents, collections and libraries it already loads (no new query) and resolves each record's EFFECTIVE policy with P9's resolver (`resolveEffectiveRetentionPolicy`: document → its folder → library; a disabled level stops inheritance), labelling it with P9's functions (`scheduledActionFor`, `scheduledActionLabel`, `describeRetentionPolicy` — `lib/retentionPolicy.ts`, unchanged). New row fields: `scheduledAction` / `scheduledActionLabel` / `retentionSchedule` (null when no policy with a length is in force) and `retentionScheduleUnknown` — a failed folder or library read makes an INHERITED schedule unknown, never "no schedule" (the reads were unchecked; the error is now kept for this column; a record's own policy, or a defined folder policy, still answers). `registerToCsv` gains a column after "Disposition", "Scheduled end of life" (the schedule, or "unknown (the retention policy could not be read)"); the earlier columns are unchanged (GAP-9, in the same package, appends "Field verification" after it).
- `app/(protected)/register/page.tsx` — the Records column shows the pill as before (hold / eligible) and, beside it, "then destroy" / "then archive" / "then flag for review" titled with the full schedule (destroy in rose), or "schedule unknown"; "—" only when there is nothing to say.
- Tests: `lib/__tests__/dcRoundFRegisterSchedule.test.ts` (4 cases, each failed against the base): the library's action, a folder's over it, the document's own over both, a disabled folder stopping inheritance, an empty folder inheriting, no policy / no length → none; an unreadable library or folder makes only the INHERITED schedule unknown; the CSV's last column (and "unknown"); the page renders the schedule and the unknown state beside the unchanged pill. `docControlRegister.test.ts`'s row fixture gains the four fields; `sweepRoundA3` / `csvProducersCensus` (partial rows) pass unchanged.

**Done-when.**
- ✓ (P9) `scanRetention` resolves the effective policy per document and names the scheduled action.
- ✓ The register (this pass: the page and its CSV) and the disposition UI (P9) surface the scheduled action; `disposeDocument` defaults its action from the effective policy (P9).
- ✗ (alternative) the selector is not removed — the action is honoured.

**Scope / residual.** "destroy" still never deletes bytes by itself (P9's note: disposition is an explicit logged action; the space-saver handles storage) — the register names the schedule's intent. A controller destroys a disposed record's bytes, its current file included, through `/api/storage/delete` once its retention has run (`RET-2`: the current-revision refusal exempts a disposed record). No migration.

---

<a id="ret-12"></a>

## RET-12 · The document archive's integrity manifest records the DB's claimed hash, not a hash of the bytes actually captured, before commit destroys the only other copy

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/shed/route.ts:146-168`, `app/api/admin/shed/route.ts:169`, `app/api/admin/ticket-shed/route.ts:212`, `components/archive/BackupViewer.tsx:100-110`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the only sha256 in the document shed path is the copied DB value; the capture loop at :150-168 does zero verification before the irreversible commit. Partial mitigation worth recording — components/archive/BackupViewer.tsx:96-104 prefers the DB file_hash over the manifest, so a corrupted capture IS detectable at re-open time; what is permanently lost is detection at the one moment recovery was still possible, and the manifest cannot distinguish pre- from post-archive corruption.

**Mechanism.** The document shed writes `sha256: (r.file_hash as string | null) ?? null` — the value stored on the document_versions row at upload time — into files-manifest.json, while it holds the freshly-read `buf` in hand and never hashes it. The sibling ticket shed does hash the actual bytes. So the manifest is an unverified restatement of a DB claim, and when file_hash is null (older rows, imported rows, revert rows that carried a null hash forward) the manifest entry is `sha256: null`. BackupViewer's verification then finds no expected hash from the manifest and falls back to the DB hash — also null — so nothing is verified. Commit then deletes the R2 object, making the zip the only copy of bytes that were never checked at the moment of capture.

**Failure scenario.** A revision's R2 object was replaced or truncated at some earlier point (a repointed file_url per finding 3, a partial upload). Produce reads whatever is there, writes the stale DB file_hash beside it, and streams the zip. Commit deletes the live object. Years later, during an incident investigation, the admin drops the archive in: BackupViewer computes the actual hash, it disagrees with the manifest, and there is now no way to tell whether the archive is corrupt or the DB hash was always wrong — and no second copy to compare against. For rows with a null file_hash there is not even a mismatch to notice.

**Evidence.**

```
app/api/admin/shed/route.ts:155-163 `const buf = await obj.Body!.transformToByteArray(); filesFolder?.file(key, buf); manifest[key] = { sha256: (r.file_hash as string | null) ?? null, size: buf.byteLength, ... };`; contrast app/api/admin/ticket-shed/route.ts:212 `sha256: createHash("sha256").update(f.buf).digest("hex")`.
```

> **Verifier correction.** Correct the BackupViewer half — the finding has the order backwards. components/archive/BackupViewer.tsx:88-104 tries the DB `document_versions.file_hash` FIRST (its comment calls that 'the strong anchor: the DB can't be edited by whoever made the zip') and only falls back to the manifest when no DB hash exists. So for the common case (file_hash present) verification does work and the weak manifest is unused; the defect bites specifically when file_hash is null — both sources are then null, `if (!expected) { ... setVerify({ status: "none" }); return; }` fires, and nothing is verified. The underlying defect — a manifest that restates a DB claim instead of hashing the bytes captured — stands.

**Done when.**

- [ ] the document shed hashes `buf` and records both the computed hash and the DB's file_hash, flagging any disagreement in the produce response and the ARCHIVE.txt
- [ ] a version whose computed hash disagrees with a non-null file_hash is un-claimed rather than archived, so commit cannot free it
- [ ] the produce response reports how many captured files had no recorded hash

**Resolution (2026-09-23, Round F).** Reproduced: `shed/route.ts` wrote `sha256: r.file_hash` — the DB's upload-time claim — beside the freshly read `buf` it never hashed (`:183-189`). Produce now hashes every captured buffer (`createHash("sha256")`), records `{ sha256: <computed>, dbSha256: <file_hash> }` in `files-manifest.json`, and when the DB hash is non-null and disagrees, does NOT bundle the file and leaves the row un-claimed (the existing un-claim loop returns it to live storage, so commit cannot free it). Counts ride the response headers (`X-Archive-Unhashed`, `X-Archive-Hash-Mismatch`, plus `X-Archive-Rejected-Keys` / `X-Archive-Shared-Skipped`), ARCHIVE.txt ("N file(s) had no recorded hash; M file(s) whose live bytes disagreed with their recorded hash were NOT captured and stay in live storage") and the catalog note.
- Tests: `lib/__tests__/dcRoundFShed.test.ts` — "produce never claims a foreign or shared key; hashes what it captured; un-claims a hash mismatch" (manifest `sha256` = hash of the captured bytes, `dbSha256` = the DB claim, the drifted file absent from the zip and un-claimed, the headers and ARCHIVE.txt counts).
- Files: `app/api/admin/shed/route.ts`.

**Done-when.**
- ✓ the document shed hashes `buf` and records both the computed hash and the DB's hash, flagging disagreement in the produce response (headers) and ARCHIVE.txt.
- ✓ a version whose computed hash disagrees with a non-null `file_hash` is un-claimed rather than archived.
- ✓ the produce response reports how many captured files had no recorded hash.

**Scope / residual.** `components/archive/BackupViewer.tsx` (not this package's file) still verifies DB hash first, manifest `sha256` second — the manifest field it falls back to is now the hash of the captured bytes, so that fallback finally verifies the right thing; the new `dbSha256` field is not read by it yet. The ticket shed already hashed its bytes (the finding's contrast).

---

<a id="ret-13"></a>

## RET-13 · The documented recovery for a failed R2 delete is unreachable: the Reclaim button never renders for the archive that needs it, and the catalog would call the wrong endpoint

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/storage/page.tsx:500-509`, `app/(protected)/admin/storage/page.tsx:619-621`, `app/(protected)/admin/storage/page.tsx:1341-1345`, `app/(protected)/admin/storage/page.tsx:1296-1299`, `app/api/admin/shed/commit/route.ts:53-57`, `app/api/admin/archives/route.ts:74-82`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The advertised recovery is genuinely unreachable for the exact failure it addresses: no row stays pending after a successful stamp, so the catalog shows "reclaimed — the zip is the only copy" with no Reclaim button, and if it did render, docPending===0 would route a document archive to /api/admin/ticket-shed/commit. Minor citation drift only: the mis-routing line is page.tsx:621, not 1296-1299.

**Mechanism.** shed/commit stamps archived_at FIRST and deletes from R2 SECOND, so after a partial R2 failure every linked version has archived_at set. /api/admin/archives then computes `pending = docPending + ticketPending = 0` and `status = committed`. The catalog renders the Reclaim button only under `row.status === "pending"`, so a committed-with-orphans archive gets no button at all — while the panel copy and the post-commit warning both instruct the admin to 'Run Reclaim on it again from the catalog below'. Even if the button did render, `commitFromCatalog` derives the endpoint as `const which = row.docPending > 0 ? "doc" : "ticket"` — with docPending 0 that routes a document archive to /api/admin/ticket-shed/commit, which finds no linked tickets and returns `{ok:true, reclaimedTickets:0}`; the handler reads `body.reclaimed` (undefined → 0) and displays 'space reclaimed.'

**Failure scenario.** An admin commits archive MOS-2026Q3-A1B2; 40 of 900 keys fail to delete (R2 hiccup). The amber banner says 40 objects 'failed to delete and are still billed. Run Reclaim on it again from the catalog below — re-running retries the deletes safely.' `setPendingArchive(null)` has already cleared the inline panel, and the catalog row now shows the green 'reclaimed — the zip is the only copy' chip with no Reclaim button. There is no path in the UI to retry. The 40 objects stay in R2 forever, billed, while their version rows say archived_at — so the app tells users to go fetch the offline archive for files that are actually still sitting in the bucket. The commit route's own comment (lines 53-57) says re-running is the recovery path for exactly this.

**Evidence.**

```
page.tsx:1341-1345 `{row.status === "pending" && (<button onClick={() => void commitFromCatalog(row)} ...>I saved it — reclaim</button>)}`; page.tsx:621 `const which = row.docPending > 0 ? "doc" : "ticket";`; page.tsx:507 `...Run Reclaim on it again from the catalog below — re-running retries the deletes safely.`; archives/route.ts:80-82 `pending > 0 ? "pending" : committed > 0 ? "committed" : "empty"`.
```

> **Verifier correction.** Severity lowered to MEDIUM. The consequence is stranded, still-billed R2 objects plus a self-contradicting instruction — not data loss: the version rows are correctly stamped and correctly linked to the archive, and the orphan purge will not reap the objects because file_url still references them. The endpoint-misrouting half is latent only: the button renders solely when pending > 0, and for a document archive that implies docPending > 0, so the wrong branch is unreachable while the render gate stands.

**Done when.**

- [ ] /api/admin/archives reports an orphaned-keys or delete-shortfall signal (e.g. committed rows whose R2 objects still exist, or a persisted lastCommitErrors count) and the catalog renders Reclaim whenever that is non-zero
- [ ] commitFromCatalog picks the endpoint from which table holds ANY linked rows (docPending+docCommitted vs ticketPending+ticketCommitted), not from docPending alone
- [ ] the retry path is exercised by a test that leaves an archive committed-with-errors and asserts the UI offers, and correctly routes, a second Reclaim

**Resolution (2026-09-23, Round F).** Reproduced: after a partial R2 delete every linked row is stamped, `/api/admin/archives` computes `pending = 0` → `committed`, the Reclaim button rendered only under `row.status === "pending"` (`page.tsx:1342`), and `commitFromCatalog` chose the endpoint by `row.docPending > 0` (`:622`). Landed: both commit routes persist the delete shortfall on the catalog row (`archives.reclaim_shortfall`, `supabase/migrations/20261077_dc_roundF_records_rails.sql` §6) through `persistReclaimShortfall` in `lib/archiveCatalog.ts` — CHECKED, because supabase-js never throws: a refused update (RLS, transport, or a database that predates the column) is named in the response's `errors` (`shortfall persist: …`, or `archives.reclaim_shortfall is not applied yet (migration 20261077 §6)`) and reported as `shortfallPersisted: false` in the response and the audit detail, so the catalog is never claimed clean while the row says nothing; the document commit's "nothing deletable remains" early return (every remaining row foreign or shared) clears a stale shortfall to 0 the same checked way, so "Retry reclaim" is not offered forever for keys the route may never free. Both carry `keysFailed` in the response and the audit detail; `/api/admin/archives` selects `*` (so the catalog still lists on a database without the column) and returns `reclaimShortfall` + `needsReclaim`; new pure `lib/archiveCatalog.ts` — `catalogNeedsReclaim` (pending, OR committed with a shortfall), `catalogCommitTarget` (by which table holds ANY linked rows: pending + committed), `catalogReclaimLabel`; the storage page's catalog row renders the button from `catalogNeedsReclaim`, labels a committed-with-shortfall row amber ("…N cloud object(s) failed to delete and are still billed — run Reclaim again"), routes the retry with `catalogCommitTarget`, and words the confirm as "Retry reclaim".
- Tests: `lib/__tests__/dcRoundFArchiveCatalog.test.ts` — the pure decisions (incl. "the all-stamped document archive goes to the document endpoint"), "/api/admin/archives reports the delete shortfall" (committed AND needsReclaim; pre-migration row reads 0), the page source pin ("renders Reclaim from catalogNeedsReclaim and routes from catalogCommitTarget — the pending-only gate and the docPending rule are gone"); `lib/__tests__/dcRoundFShed.test.ts` "frees only org-owned, unshared keys… persists the shortfall" (an R2 per-key error → `reclaim_shortfall: 1`, `shortfallPersisted: true`), "a REFUSED shortfall write is named, never dropped" (transient error and the pre-migration PGRST204 shape → `shortfallPersisted: false` + a named error), "when nothing deletable remains … the stale shortfall is cleared, checked", "ticket commit: a refused shortfall write is named in errors".
- Files: `lib/archiveCatalog.ts` (new: the pure decisions + `persistReclaimShortfall`), `app/api/admin/archives/route.ts`, `app/(protected)/admin/storage/page.tsx` (Reclaim button region), `app/api/admin/shed/commit/route.ts`, `app/api/admin/ticket-shed/commit/route.ts`; migration §6.
- Pending migration: `supabase/migrations/20261077_dc_roundF_records_rails.sql` (§6).

**Done-when.**
- ✓ `/api/admin/archives` reports a persisted delete-shortfall signal and the catalog renders Reclaim whenever it is non-zero; the persistence is checked, and its failure is reported rather than dropped.
- ✓ `commitFromCatalog` picks the endpoint from which table holds ANY linked rows.
- ✓ the retry path is tested: a commit that leaves an archive committed-with-errors persists the shortfall, the catalog route offers it, and the routing decision sends it to the right endpoint.

**Scope / residual.** Until §6 is applied the column write is refused by PostgREST and every commit response says so by name (`shortfallPersisted: false`, the migration named in `errors`) while the catalog behaves as before (the commit response and audit row still carry `keysFailed`); the storage page already surfaces a non-empty `errors` as a warning. The legal-hold early return (every linked row under hold) leaves an earlier shortfall in place on purpose: those keys become deletable again when the hold is released.

---

<a id="ret-14"></a>

## RET-14 · Ticket restore writes bytes back into R2 without verifying the sha256 manifest the produce step wrote, and findInBackup's suffix match can pick the wrong entry

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/ticket-shed/restore/route.ts:147-162`, `app/api/admin/ticket-shed/restore/route.ts:93-98`, `app/api/admin/ticket-shed/route.ts:212`, `app/api/admin/ticket-shed/route.ts:231`, `lib/archive.ts:108-122`, `components/archive/BackupViewer.tsx:100-110`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed. Real guards exist and limit the blast radius — restore writes only keys the LIVE archived stub owns (:141-146 allowedKeys, prefix-checked) and never touches hot tickets (:136) — but the bytes themselves are trusted unverified against a manifest the producer already computed, and findInBackup falls back to a first-wins suffix match. The suffix branch only fires when no exact match exists, so it needs a re-laid-out or hand-edited zip; MEDIUM is right.

**Mechanism.** Produce writes `files-manifest.json` mapping every key to the sha256 of the exact bytes bundled. Restore parses `files-meta.json` (content types) and never reads `files-manifest.json` — grep for 'files-manifest' shows consumers in BackupViewer and clientBackup only. It picks the zip entry with `findInBackup(entryPaths, k)` and PutObjects the bytes unverified. findInBackup falls back to a suffix match: `if (suffixMatch === null && (norm.endsWith("/" + key) || key.endsWith("/" + norm))) suffixMatch = entry;` — the second disjunct matches any entry whose normalised path is merely a trailing segment of the requested key. So an entry named `P-101.pdf` matches the key `orgs/<org>/libraries/<lib>/P-101.pdf`. The read-only viewer that only displays bytes verifies them; the one path that writes bytes into authoritative storage does not.

**Failure scenario.** An admin restores a ticket archive that has been edited (or silently corrupted in transit, or is the wrong quarter's zip with colliding trailing filenames). Restore finds a suffix-matching entry for each key the live stub owns, uploads those bytes to the real R2 keys, clears archived_at, and reports 'Restored N ticket(s), M file(s) re-uploaded.' The attachment on a closed NDE/radiography ticket now contains different content from what was archived, with nothing recording the substitution: the archive's own sha256 for that key sat unread in the same zip.

**Evidence.**

```
app/api/admin/ticket-shed/restore/route.ts:148-156 `const entry = findInBackup(entryPaths, k); ... const bytes = await zip.files[entry].async("uint8array"); ... await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: k, Body: bytes, ContentType: fileMeta[k] || inferContentType(k) }));`; lib/archive.ts:117-119 `if (suffixMatch === null && (norm.endsWith("/" + key) || key.endsWith("/" + norm))) { suffixMatch = entry; }`; produce writes it at ticket-shed/route.ts:212 `fileManifest[f.key] = { sha256: createHash("sha256").update(f.buf).digest("hex"), size: f.buf.byteLength };`.
```

> **Verifier correction.** Blast radius is narrower than stated, so MEDIUM. restore/route.ts:140-143 confines writes to `allowedKeys` — the LIVE stub's own attachment urls filtered by `.startsWith("orgs/${orgId}/")` — so a crafted entry cannot redirect a write to an arbitrary key; the exposure is that the BYTES landing at a legitimate key are unverified, and the suffix fallback can source them from the wrong (or an attacker-chosen) entry in an admin-supplied zip. Also note the zip is admin-supplied to a route gated by authorizeOrgRole, so this is integrity-of-restore, not an unauthenticated write.

**Done when.**

- [ ] restore parses files-manifest.json and refuses to PutObject any file whose sha256/size does not match, counting mismatches into the response and leaving the stub intact
- [ ] restore requires an EXACT key match (or a manifest-confirmed one) rather than accepting findInBackup's suffix fallback for writes
- [ ] a test restores a zip with one tampered file and asserts nothing is written and the ticket stays a stub

**Resolution (2026-09-23, Round F).** Reproduced: restore never read `files-manifest.json`, picked entries with `findInBackup` (suffix fallback at `lib/archive.ts:117`) and `PutObject`ed the bytes unverified. New pure `lib/restoreVerify.ts`: `exactEntryFor` (tolerates only a leading slash and the `files/` wrapper — never a suffix) and `bytesMatchManifest` (well-formed sha256 that matches, and the recorded size). `app/api/admin/ticket-shed/restore/route.ts` now requires `files-manifest.json` (a zip without it, or with an unreadable one, is refused 400 — nothing restored), takes only the exact entry for each key the LIVE stub owns, verifies the bytes BEFORE the write, and on a mismatch writes nothing for that ticket, counts `filesMismatched`, records `verify <key>: bytes do not match files-manifest.json — not written` and leaves the stub intact (the recovery pointer). `lib/archive.ts` `findInBackup` is untouched — the read-only viewer may still guess.
- Tests: `lib/__tests__/dcRoundFShed.test.ts` — "exactEntryFor tolerates the files/ wrapper and a leading slash, never a suffix", "bytesMatchManifest requires a well-formed sha256 that matches, and the recorded size", "restores a verified archive: bytes written, stub cleared", "a tampered file: nothing written, the ticket stays a stub, the mismatch is counted", "a suffix-only entry no longer sources a write", "an archive without files-manifest.json is refused outright (fail closed)".
- Files: `lib/restoreVerify.ts` (new), `app/api/admin/ticket-shed/restore/route.ts`.

**Done-when.**
- ✓ restore parses `files-manifest.json` and refuses to PutObject any file whose sha256/size does not match, counting mismatches into the response and leaving the stub intact.
- ✓ restore requires an EXACT key match for writes.
- ✓ a test restores a zip with one tampered file and asserts nothing is written and the ticket stays a stub.

**Scope / residual.** Ticket archives produced before the manifest existed cannot be restored through this route (fail closed by design; the dropped-archive viewer still opens them read-only). Re-producing from a live ticket is the way back.

---
