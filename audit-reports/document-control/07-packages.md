# 07 · Doc packs, work packages & the field bundle

**14 findings** — 5 CRITICAL · 5 HIGH · 4 MEDIUM.

Frozen snapshot or live reference — and what that means when a revision moves.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| /api/storage/download-url authorizes the KEY, not just the session — org-prefix membership check, then ACL discover via canDiscover, then an explicit acl_index download-deny check, then archive-aware 409 | `app/api/storage/download-url/route.ts:33-127` | This is the only place bytes are authorized, and it is genuinely careful (it even cites the earlier finding H7 it closed). Everything in doc control that fetches a file goes through it. Do not weaken it while fixing the unclamped expiresIn — clamp the lifetime and leave the four gates intact. |
| assertSafeStorageKey — one gate every storage route runs a caller-supplied R2 key through, rejecting traversal segments, control bytes, backslashes, empty segments and over-long keys, with a docblock explaining why R2's opaque-key semantics make it necessary anyway | `lib/storageKey.ts:40-52` | Correct and used by both upload-url and download-url. The key-overwrite finding is NOT a hole in this function; it is a missing semantic check layered on top of it. |
| Freshness computed at read time from (pinned_version_id vs current_version_id) with no trigger state to drift | `supabase/migrations/20260825_work_packages_acks.sql:42-46, lib/workPackages.ts:106` | The right design — the intelligence audit called it 'the cleanest link in the codebase'. The defects found here are all about who may move a pin and what the pin is compared against, not about the derivation model. Keep it derived. |
| refreshWorkPackage checks EVERY write and distinguishes a failed update from one that matched zero rows, naming the missing migration in the error | `lib/workPackages.ts:206-228` | This is the correct antidote to the repo-wide 'supabase-js resolves with {error}' pattern and it exists because a previous silent no-op let the UI announce 'Package refreshed' while every pin stayed stale. Preserve this shape when fixing the NULL-pin bug; the check just needs to also treat an unreadable document as a failure rather than as a NULL. |
| Per-sheet verify QRs encode the exact version printed — `/verify/<docId>?v=<versionId>` — and /api/verify refuses a version whose record_id does not match the doc | `lib/docPack.ts:104-106, lib/downloads.ts:95-102, app/api/verify/route.ts:53-65` | The individual-sheet QR is a true print-time snapshot; only the pack-level cover QR is not. The fix for the cover QR should copy this design rather than invent a new one. |
| publicOrigin() — every printed QR is built on NEXT_PUBLIC_SITE_URL rather than window.location.origin, so a print made from a preview deploy still verifies against production | `lib/publicOrigin.ts:17-22` | A subtle, correct decision with a docblock explaining the Vercel-gated-preview failure it prevents. All four physical artifacts route through it. |
| Content-aware stamp layout is pure, measured and unit-tested — the watermark provably fits, footers word-wrap to the measured width and reserve the QR plate, and the QR plate is clamped on-page | `lib/stampLayout.ts:38-190, lib/stamping.ts:184-236` | The geometry is sound within its coordinate space. The rotation finding is a coordinate-space mismatch at the boundary, not a defect in this math — fix the space, keep the functions. |
| viewerStatusBadge distinguishes the on-screen master (Controlled) from the copy-control state used for downloads, and handles Draft, Superseded, Void and Archived correctly | `lib/downloads.ts:49-69` | It is the one place in the codebase that reads DocumentStatus exhaustively and honestly. It is the model the two public verify endpoints should be rewritten against. |


---


<a id="pkg-1"></a>

## PKG-1 · Any active org member can overwrite the bytes of an ISSUED revision in place — the signed-PUT route authorizes the org prefix but never the key's meaning

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 1).** Confirmed: `POST /api/storage/upload-url` signed a PUT for any org-prefixed key with no check that the key was already a released version's bytes. The route now, after the org-membership gate, looks the requested key up against `document_versions.file_url` and `document_versions.source_file_key`; if it is already a version's stored bytes it refuses with **409** ("Publish a new revision instead"). Every legitimate upload the app mints targets a fresh, timestamped/uuid key (`lib/storage.ts` — `makeTicketAttachmentPath`, `uploadTemplateFile`, folder uploads, the version insert path in `lib/revisions.ts`), so nothing legitimate re-PUTs an existing version key — the check is a no-op for real uploads and a wall for an in-place overwrite. The ledger lookup **fails closed** (503) so a PUT is never signed against an unverifiable key. Two exact-equality lookups are used rather than a PostgREST `.or()` raw string, because `assertSafeStorageKey` permits commas and parentheses that would inject the filter.
- Done-when: (1) upload-url refuses to sign a PUT for any key already referenced by a version row (409) ✓; (2) a member who could not publish cannot obtain a signed PUT for that revision's key ✓ (the key is a version's `file_url`, so it is refused regardless of role); (3) a test uploads to an issued revision's key and is refused ✓.
- Files: `app/api/storage/upload-url/route.ts`
- Tests: `lib/__tests__/uploadUrlRoute.test.ts` — fresh key signs; a version's `file_url` → 409, never signed; ledger error → 503, never signed; non-member → 403.
- **What this brought to light:** this is the byte-level twin of roles-and-permissions `EGRESS-6` (no RESTRICTIVE UPDATE/INSERT guard on `document_versions`, letting a member *repoint* `file_url`). This closes *changing what the pointer points at*; `EGRESS-6` (repointing the pointer) remains its own finding. Also relevant to `PKG-2` (the verify QR trusts version identity, not bytes) — with overwrite closed, the file_hash recorded at publish is once again a meaningful integrity anchor.

- **Verification:** CONFIRMED
- **Locations:** `app/api/storage/upload-url/route.ts:20-55`, `lib/storage.ts:378-405`, `supabase/schema.sql:1071-1073`, `lib/docPack.ts:84-90`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed at CRITICAL. The route authorizes the org prefix and nothing else, so any active member — Viewer included — can overwrite the bytes behind an Issued, signed revision while every database fact (rev, file_hash, current_version_id, approvals) stays untouched.

**Mechanism.** `POST /api/storage/upload-url` takes a caller-supplied `path`, runs `assertSafeStorageKey` (traversal/control bytes only), then checks one thing: `const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//)` followed by an `org_members … status = 'active'` lookup, and signs `new PutObjectCommand({ Bucket: R2_BUCKET, Key: path })`. There is no check that the key is unused, no check that it is the `file_url` of a released `document_versions` row, no role check, no `HeadObject`/`IfNoneMatch` precondition (two searches — `HeadObjectCommand|IfNoneMatch|already exists` over lib/ and app/api/, and a read of both upload routes — found the guard only in lib/dataExport.ts and lib/exportRunner.ts, never on the upload path). The target key is not secret: `document_versions.file_url` is plainly SELECTable by any member the permissive `document_versions_org_access` policy admits (supabase/schema.sql:1071-1073, `FOR ALL USING (org_id IN (SELECT my_org_ids()))`). So the attack is: read `file_url`, POST it back to upload-url, PUT new bytes.

**Failure scenario.** A Viewer-role contractor reads the `file_url` of P-101 Rev 5 (Issued, approved, three signatures), asks upload-url for a PUT on that exact key, and uploads a modified P&ID. No database row changes: `rev` is still 5, `file_hash` still records the original SHA-256, `current_version_id` is unchanged, the approvals stand. Every doc pack, every download, every print from that moment serves the substituted drawing — stamped by lib/docPack.ts:95-107 with `"P-101 Rev 5 at time of issue"` and a verify-QR that resolves GREEN/CURRENT because /api/verify only compares version UUIDs. The evidence pack (lib/evidencePack.ts:63) prints the stale hash next to the swapped file. Nothing anywhere in the system can detect the substitution.

**Evidence.**

```
app/api/storage/upload-url/route.ts:33-53 — `const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//); if (orgMatch) { … if (!member) { return … 403 } } const command = new PutObjectCommand({ Bucket: R2_BUCKET, Key: path }); const url = await getSignedUrl(r2, command, { expiresIn: 900 });` — the only authorization is org membership. Contrast app/api/storage/download-url/route.ts:57-115, which for the READ direction resolves the key back to its document and applies `canDiscover` plus the acl_index download-deny check. The write direction has no such resolution at all.
```

**Chain reaction.** This is the byte-level twin of roles-and-permissions EGRESS-6 (`document_versions` has no RESTRICTIVE UPDATE/INSERT guard). EGRESS-6 lets a member repoint `file_url`; this lets them change what the pointer points at. Fixing EGRESS-6 alone does not close this. Every downstream integrity claim rests here: the verify QR (lib/stamping.ts:245-254), the file_hash in the evidence pack, the 'controlled copy' pass-through in lib/downloads.ts:222-226, and every sheet in every field pack.

**Done when.**

- [ ] upload-url resolves the requested key against `document_versions.file_url` and refuses to sign a PUT for any key already referenced by a version row (or any key that already exists in the bucket), returning 409
- [ ] a member session that could not publish a revision cannot obtain a signed PUT for that revision's key by any route
- [ ] a test uploads to an issued revision's key and is refused

---

<a id="pkg-2"></a>

## PKG-2 · The cover-sheet QR verifies the LIVE database pin, not the paper — so 'Refresh pins', or simply re-adding a drawing, re-arms an already-printed stale pack to GREEN

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 2 — the field-verdict cluster).** Confirmed: the cover QR encoded only the package id, so `/api/verify-package` read the mutable `work_package_documents` pins, and "Refresh pins" or re-adding a drawing re-armed already-printed paper to green. Fixed with an immutable print snapshot:
- New table `work_package_prints` (migration `20261028`) records, at print time, the exact version of every sheet as printed. It is INSERT-once — RLS grants active members SELECT + INSERT and NO update/delete, so the snapshot cannot be mutated (a mutable snapshot would reintroduce this bug).
- `recordPackagePrint` writes the snapshot from the just-refreshed pins; `buildPackageCover` encodes `?print=<printId>` in the cover QR. Both are best-effort/deploy-safe — if the table is absent the print still runs with the legacy package-level QR.
- `/api/verify-package` compares each **recorded** version against the document's current version, so refreshing pins after printing can no longer flip the verdict for paper in the field. A print id that resolves to no snapshot reads "CAN'T VERIFY THIS PACK" (red), never green.
- `addDocumentToPackage` no longer silently re-pins an already-present document (the old `upsert`): it returns `"already"` and leaves the pin where it is — moving a pin is `refreshWorkPackage`'s explicit job. The Add button says "already in — pin unchanged".
- Done-when: (1) printing writes an immutable print record (print id + per-doc version id + printed_at) and the cover QR encodes the print id ✓; (2) verify compares the scanned print's recorded versions against current ✓; (3) re-adding a pinned document no-ops the pin ✓.
- Files: `supabase/migrations/20261028_work_package_prints.sql`, `lib/workPackages.ts`, `lib/physicalBridge.ts`, `app/api/verify-package/route.ts`, `app/verify-package/[packageId]/page.tsx`, `app/(protected)/packages/page.tsx`, `components/documents/AddToPackageButton.tsx`, plus export/restore coverage (`lib/exportTables.ts`, `lib/dataRestore.ts`, `lib/schemaExpectations.ts`).
- Tests: `lib/__tests__/verifyPackageSnapshot.test.ts` — a snapshot at v1 reads STALE even after the live pin is refreshed to v2; a snapshot at current reads CURRENT; an unknown print never reads green; the legacy no-print QR still uses live pins.
- **Applied & verified live 2026-08-24:** `20261028` — probe confirmed the table exists with no UPDATE/DELETE policy (immutable). The snapshot protection is active: every pack printed from now on carries a print-id QR.

- **Verification:** CONFIRMED
- **Locations:** `lib/physicalBridge.ts:275-281`, `app/api/verify-package/route.ts:54-64`, `app/verify-package/[packageId]/page.tsx:90-98`, `lib/workPackages.ts:194-229`, `lib/workPackages.ts:176-191`, `components/documents/AddToPackageButton.tsx:30-43`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. The verdict page states a fact the data cannot support — app/verify-package/[packageId]/page.tsx:95 renders `${staleCount} of ${sheetCount} sheets changed since this pack was printed` from a comparison that has no knowledge of any print. Any re-pin flips already-distributed paper back to 'PACK IS CURRENT'.

**Mechanism.** The QR encodes only `${origin()}/verify-package/${input.packageId}` — the package identity, with no snapshot of what was printed. The endpoint then reports `printedRev: r.pinned_rev_label` and `fresh: … r.pinned_version_id === (d?.current_version_id ?? null)` — both read live from `work_package_documents`, a mutable row. Nothing records a print event; there is no print_id, no printed_version_id, no printed_at. Two ordinary in-app actions move those pins with no relation to any piece of paper: `refreshWorkPackage` re-pins every member to `current_version_id` (a button on /packages that exists precisely to move pins without printing), and `addDocumentToPackage` upserts `onConflict: "package_id,document_id"`, so re-adding an already-pinned drawing from the inspector silently re-pins it — the docblock even calls this out as intended ('re-adding refreshes the pin') and the button gives no indication the document is already in the package.

**Failure scenario.** A pack for 'E-204 bundle swap' is printed Monday with P-101 at Rev 3; the paper folder goes to the job site. Tuesday P-101 is published to Rev 4 — the package correctly flags STALE and the owner is notified. Wednesday the owner clicks 'Refresh pins' from their desk (or anyone clicks 'Add to work package' on P-101 from the inspector), moving the pin to Rev 4. The paper in the field is untouched and still shows Rev 3. A crew member scans the cover QR before starting work and gets a full-screen emerald 'PACK IS CURRENT — Every sheet in this pack is still the current revision.' The tripwire has been disarmed by a desk action, and the field page states as fact something it has no way to know.

**Evidence.**

```
lib/physicalBridge.ts:275 — `const qr = await qrPng(doc, \`${origin()}/verify-package/${input.packageId}\`);` and :280 — `"Red = a sheet changed since printing — get the new one."`. app/api/verify-package/route.ts:59-61 — `printedRev: r.pinned_rev_label, currentRev: …, fresh: !retired && !!r.pinned_version_id && r.pinned_version_id === (d?.current_version_id ?? null)`. app/verify-package/[packageId]/page.tsx:96 — `"${result.staleCount} of ${result.sheetCount} sheet…changed since this pack was printed"`. lib/workPackages.ts:181-189 — `.upsert({ … pinned_version_id: input.doc.currentVersionId ?? null, … }, { onConflict: "package_id,document_id" })`. lib/workPackages.ts:212-218 — the refresh update.
```

**Chain reaction.** This is the same shape the earlier audits named 'a comment describing behaviour that was never implemented': the field text, the API field name `printedRev`, and the cover-sheet caption all describe a print-time snapshot the schema never stores. Every other verify surface in the product has the same property but lower stakes, because /verify at least carries the printed version UUID in the QR (`?v=${versionId}`, lib/docPack.ts:104-106) — the per-sheet QRs are honest and the pack-level QR is not.

**Done when.**

- [ ] printing a pack writes an immutable print record (print id + per-document version id + printed_at) and the cover QR encodes that print id
- [ ] /api/verify-package compares the scanned print's recorded versions against current, so refreshing pins or re-adding a document cannot change the verdict for paper already in the field
- [ ] re-adding a document already in a package either no-ops or asks before moving the pin

---

<a id="pkg-3"></a>

## PKG-3 · Two document-creation paths mint DETERMINISTIC R2 keys from the raw filename, so two different documents silently share one object and a pack serves the wrong drawing under the right title block

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/documents/[libraryId]/page.tsx:2409-2413`, `lib/revisions.ts:355-361`, `lib/storage.ts:205-216`, `app/(protected)/documents/[libraryId]/page.tsx:2390-2401`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the finding is precise about which two paths are affected — the contrast with the four salted callers is what makes it a defect rather than a design. Two same-named files in one folder collapse to one object while both document rows keep pointing at it, so the older document serves the newer drawing's bytes under its own title block.

**Mechanism.** `makeLibraryStoragePath` is pure: `joinPath("orgs", orgId, "libraries", libraryId, ...folder, sanitizeFilename(filename))` — no uuid, no timestamp, no rev. Every revision path defends against that by building a `versionedName` first (`${stem}__rev${safeRev}__${Date.now()}.${ext}` at lib/revisions.ts:485, :877, :1615 and lib/documentLifecycle/common.ts:197). Two callers do not: the bulk library upload passes `filename: file.name` verbatim (page.tsx:2413), and `createDocumentWithFile` passes `filename: \`Rev0_${input.file.name || "drawing.pdf"}\`` (revisions.ts:360). Both therefore produce a key that is a pure function of (org, library, folder, filename). A PUT to an existing S3/R2 key overwrites it, and upload-url signs that PUT unconditionally (finding above). Worse, the upload flow's own de-duplication makes the collision *invisible*: page.tsx:2390-2401 walks `usedNumbers` and renames the second `P-101` document to `P-101-2`, creating a SEPARATE document record — while leaving both records pointing at the identical storage key.

**Failure scenario.** A drafter bulk-uploads `P-101.pdf` into the Piping library root; document `P-101` Rev 0 is created. Weeks later someone uploads a different drawing that also happens to be named `P-101.pdf` into the same folder. The UI reports the friendly auto-rename `P-101 → P-101-2` and both documents appear in the register with different numbers, titles and revs. But both `document_versions.file_url` values are `orgs/<org>/libraries/<lib>/P-101.pdf`, and R2 now holds only the second file. A field pack built for `P-101` (lib/docPack.ts:84-90 fetches by that file_url) merges the SECOND drawing's pages and stamps them `"P-101 Rev 0 at time of issue"` with P-101's verify-QR — which scans GREEN, because the QR encodes document + version UUIDs and both are unchanged. A worker executes against a drawing that is not the drawing named on the sheet.

**Evidence.**

```
lib/storage.ts:211-215 — `const safeName = sanitizeFilename(filename); const base = joinPath("orgs", orgId, "libraries", libraryId); … return joinPath(base, ...folder, safeName);`. app/(protected)/documents/[libraryId]/page.tsx:2409-2413 — `const storagePath = makeLibraryStoragePath({ orgId: activeOrgId, libraryId, folderPath: [...folderPath, ...subPath], filename: file.name });`. lib/revisions.ts:356-360 — `filename: \`Rev0_${input.file.name || "drawing.pdf"}\``. Compare lib/revisions.ts:485 — `const versionedName = \`${stem}__rev${safeRev}__${Date.now()}.${ext}\`;`. A grep for every `makeLibraryStoragePath` call site (7 total) confirms only these two omit the versioned name.
```

**Chain reaction.** Also breaks lib/staleCopies.ts-style recall and the archive path: app/api/storage/download-url/route.ts:118-127 looks up the archive record with `.eq("file_url", path).limit(1).maybeSingle()` — with a shared key that lookup is ambiguous and may report the wrong document archived. And the SHA-256 recorded per version (lib/revisions.ts:481) no longer matches the object under the key, silently.

> **Verifier correction.** Two distinct consequences are bundled. The one this finding uniquely establishes is the ACCIDENTAL case — the same filename uploaded twice into the same library folder silently overwrites the first document's bytes while both document rows survive. The deliberate-overwrite consequence depends entirely on finding 1 (the unconditional signed PUT); this finding is not independent evidence for it.

**Done when.**

- [ ] every storage key carries a per-upload unique component (uuid or timestamp), including the bulk-upload and createDocumentWithFile paths
- [ ] a test uploads two files with identical names into the same library folder and asserts the two document_versions rows have distinct file_url values and both objects are retrievable

---

<a id="pkg-4"></a>

## PKG-4 · buildAndDownloadDocPack applies NO status and NO hold filter — Draft, Superseded, Void and on-hold drawings are merged into the field bundle with nothing on the sheet saying so

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 7).** Confirmed exactly as written — the pack builder never fetched `status`, never queried holds, and the asset hub toasted "all current, all stamped" over a bundle that could contain a Void sheet and one under an open hold. Fixed by refusing, not annotating:
- `lib/docPack.ts` now fetches `status`, queries `document_holds … .is("released_at", null)` for the candidate ids, and routes everything through a new exported pure gate `filterPackDocs(allDocs, heldIds, holdReadFailed)`. Any sheet not Issued/Locked is refused with the status named in the reason ("superseded — not an in-force controlled revision"); any sheet under an active hold is refused with "under an active hold — work from this document should stop"; and an **errored hold read fails CLOSED** — every sheet is refused with "hold status could not be verified" rather than packing blind. A legacy row with no status at all still passes (pre-status data).
- Done-when 2 asked for a hold *banner* on held sheets; refusal is the deliberately stricter choice — the hold's own wording is "work from this document should stop", which cannot coexist with putting the sheet in a field pack. The skip reason tells the crew exactly what was left out and why.
- `app/(protected)/assets/[tag]/page.tsx` — the skip toast now lists each refused sheet with its reason (`P-101 (under an active hold …)`), and the "all current, all stamped" sentence only fires when `skipped.length === 0`, which after the gate means every included sheet **was** Issued/Locked and hold-free — the claim is now true by construction (done-when 3).
- The same gate protects the work-package print path — `app/(protected)/packages/page.tsx` builds through the identical `buildAndDownloadDocPack`.
- Done-when: (1) status fetched, non-Issued/Locked refused and recorded in `skipped` with the reason ✓; (2) active holds bind egress — held sheets refused (stricter than the banner asked for) ✓; (3) the success message cannot claim "all current" over a non-current or held sheet ✓.
- Files: `lib/docPack.ts`, `app/(protected)/assets/[tag]/page.tsx`.
- Tests: `lib/__tests__/docPackFilter.test.ts` — Issued/Locked pass; Draft/Superseded/Void/Archived each refused with the status in the reason; legacy empty-status passes; held sheet refused; hold-read failure refuses everything (fail closed); status refusal wins when both apply; label fallback order.

- **Verification:** CONFIRMED
- **Locations:** `lib/docPack.ts:51-54`, `lib/docPack.ts:95-107`, `app/(protected)/assets/[tag]/page.tsx:51-58`, `app/(protected)/assets/[tag]/page.tsx:129-141`, `lib/holds.ts:246`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed at CRITICAL. The page even asserts the opposite of what it built — on a clean run it toasts `Pack ready — ${result.included} drawings, all current, all stamped.` for a bundle that may contain a Void sheet and a sheet under an open hold. (The cited lib/holds.ts:246 is a miscitation — that line is notification body text — but the absence of any hold query in docPack.ts is the real evidence and it holds. Partial mitigation: each sheet's own /verify QR reports docStatus, which covers Superseded/Archived but not Void and not holds.)

**Mechanism.** The pack builder selects `id, org_id, document_number, title, name, rev, library_id, current_version_id, checked_out_by, checked_out_by_name, checkout_note` — `status` is not even fetched, and a grep for `status|hold|Superseded|Void|Draft` over lib/docPack.ts returns only unrelated `res.status` hits. Nothing filters or annotates. The only warning the stamp can carry is a checkout warning (`d.checked_out_by && …ACTIVE CHANGE IN PROGRESS`). The footer for every sheet is the same sentence regardless of state: `"<label> Rev <rev> at time of issue — verify current revision before use."`. The caller feeding it is no stricter: the asset hub queries `.neq("status", "Archived")` only — Draft, Superseded, Void and Locked all pass — and the button is labelled 'Print doc pack' with the success note `"Pack ready — N drawings, all current, all stamped."`. The same page computes `holdsByDoc` from `document_holds … .is("released_at", null)` and renders it on screen, but passes only `docs.map(d => d.id)` to the packer, so an active hold never reaches the paper.

**Failure scenario.** FE-201 has a P&ID marked Void (a cancelled tie-in detail) and an iso under an open 'Field Verification Needed' hold. A supervisor opens /assets/FE-201, clicks 'Print doc pack', and gets one merged PDF containing both, each stamped 'Rev 3 at time of issue — verify current revision before use' with a verify-QR. Scanning the Void sheet's QR returns GREEN/CURRENT (see the verify-status finding), and the hold — whose own notification text is 'Work from this document should stop until it's released' — appears nowhere on the paper, even though the app can print a red HOLD card for that same document (lib/physicalBridge.ts:141-175). The crew executes from a voided drawing and from one the org has flagged as not matching the field.

**Evidence.**

```
lib/docPack.ts:51-54 — `.select("id, org_id, document_number, title, name, rev, library_id, current_version_id, checked_out_by, checked_out_by_name, checkout_note").in("id", input.documentIds)` — no `status`, no `.neq`, no holds join. lib/docPack.ts:101-103 — the footer is unconditional. app/(protected)/assets/[tag]/page.tsx:54-57 — `.contains("asset_tags", [{ tag }]).neq("status", "Archived").limit(500)`. app/(protected)/assets/[tag]/page.tsx:140 — `"Pack ready — ${result.included} drawing…, all current, all stamped."`. types/schema.ts:613 — `export type DocumentStatus = "Draft" | "Issued" | "Superseded" | "Void" | "Archived" | "Locked";`. lib/holds.ts:246 — `"…placed a \"${input.reason}\" hold. Work from this document should stop until it's released."`
```

**Chain reaction.** lib/documentGuards.ts:138 makes an active hold block rev-up/revert/supersede, so holds are treated as authoritative for WRITES and ignored entirely for EGRESS. The pack is the highest-consequence egress surface in the product.

**Done when.**

- [ ] docPack fetches `status` and refuses (or loudly stamps DRAFT / SUPERSEDED / VOID across) any sheet not in Issued/Locked, recording it in `skipped` with the reason
- [ ] docPack joins active document_holds and stamps a hold banner on every held sheet
- [ ] the asset-hub success message stops claiming 'all current' unless every included document was Issued/Locked and hold-free

---

<a id="pkg-5"></a>

## PKG-5 · work_package_documents pins — the data the public field verdict is computed from — are writable and insertable by any active member, and the insert check never binds package_id to the caller's org

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 7).** Confirmed both halves: the INSERT policy constrained only `org_id` (cross-org `package_id` injection into another org's public verdict), and UPDATE/DELETE were any-active-member with unconstrained values. Fixed in migration `20261032` plus app/API halves:
- **INSERT** now additionally requires the referenced `work_packages` row AND the referenced `documents` row to be in the same org as the new row — a cross-org `package_id` can never be persisted (done-when 2).
- **UPDATE and DELETE** are restricted to the package's owner (`work_packages.owner_user_id = auth.uid()`) or a controller (`role IN ('Admin','DocCtrl') OR roles && ARRAY['Admin','DocCtrl']`). DELETE gets the same bar because removing the one stale sheet flips a pack's public verdict to green just as effectively as re-pinning it. A Viewer session can no longer move a pin (done-when 1, 4). Repo-wide check: no app path DELETEs `work_package_documents`, so the tightened DELETE breaks nothing shipped.
- **Trigger `trg_wpd_pin_guard`** (BEFORE UPDATE, service-role pass-through): row identity (`package_id`/`document_id`/`org_id`) is immutable, and a changed `pinned_version_id` must name a `document_versions` row of this row's own document in this org — an arbitrary pin value cannot fake freshness. This does the WITH CHECK column-freeze work the policy grammar can't.
- **`/api/verify-package`** now reads the package's `org_id` and filters the print-snapshot lookup, the live-members fallback, AND the documents lookup by it — an injected or cross-org row never reaches the public verdict (done-when 3). Also picked up the DIST-2 lesson while in the file: `Void` joined `Superseded`/`Archived` in the sheet-level `retired` set.
- Deliberate consequence, recorded in the migration and in `lib/workPackages.ts`: the `/packages` "Refresh pins" button remains visible to non-owners, but their refresh now fails with the lib's explicit zero-rows error ("the package owner or a document controller", not silence) instead of moving pins.
- Done-when: (1) UPDATE owner/controller-scoped, identity frozen by trigger ✓; (2) INSERT binds package + document to the row org ✓; (3) verify-package joins on the package org and ignores mismatched rows ✓; (4) a Viewer cannot move a pin ✓.
- Files: `supabase/migrations/20261032_dc_phase7_ack_and_pin_integrity.sql`, `app/api/verify-package/route.ts`, `lib/workPackages.ts`.
- Tests: `lib/__tests__/phase7AckPinMigration.test.ts` (org-binding on INSERT, owner/controller on UPDATE+DELETE, pin-must-name-own-document trigger, identity immutability, search_path pins, service-role pass-throughs); `lib/__tests__/verifyPackageSnapshot.test.ts` continues to pin the snapshot-vs-live verdict logic.
- ⚠ **Migration `20261032` awaiting hand-apply** — the DB half is not live until the user pastes it; the app halves are deploy-safe against the old policies (they only narrow expectations).

- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260828_integrity_hardening.sql:285-292`, `supabase/migrations/20260825_work_packages_acks.sql:86-95`, `supabase/migrations/20260825_work_packages_acks.sql:70-79`, `app/api/verify-package/route.ts:38-52`, `app/(protected)/packages/page.tsx:33`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. Both factual claims are true. Severity is one step too high: the app itself already grants every member exactly this power through an unguarded UI button — app/(protected)/packages/page.tsx:293-299 renders 'Refresh pins' for any viewer and lib/workPackages.ts:194-229 performs the same UPDATE — so the policy is consistent with the shipped design rather than a bypass of it. The genuinely un-mitigated part is the unbound `package_id` on INSERT (cross-org row injection into another org's pack) plus the ability to set an arbitrary pin value; HIGH.

**Mechanism.** `work_package_documents_org_update` (added by 20260828 so 'Refresh pack' would work from the browser) is `USING (active member of work_package_documents.org_id) WITH CHECK (same)`. Both halves test only org membership, so any member — Viewer included — may set `pinned_version_id` and `pinned_rev_label` on any row in the org to any value. The INSERT policy has the same shape and, critically, constrains only `org_id`: `package_id` and `document_id` are unconstrained, and `package_id` is FK'd to `work_packages(id)` with no org correlation. So a member of org A can insert a row with `org_id = A` and `package_id = <a package in org B>`; the WITH CHECK passes. /api/verify-package then reads members with the SERVICE ROLE filtered only by `.eq("package_id", pkgId)` — no org join — so the injected row appears on org B's public field verdict. DELETE is equally open, so sheets can be removed. There is no role gate in the app either: app/(protected)/packages/page.tsx:33 destructures `useRole()` for `activeOrgId, uid, userEmail` only — `activeRole` is never consulted for create, refresh, close or print.

**Failure scenario.** A contractor with Viewer access issues one PostgREST UPDATE: `work_package_documents set pinned_version_id = <the doc's current_version_id> where package_id = <the turnaround pack>`. Every sheet now reads fresh. The /packages page shows a green 'Fresh' badge, the owner is never notified (notifyPackagesOfRevUp only fires on publish), and the crew scanning the cover QR in the field gets 'PACK IS CURRENT'. The same member can instead DELETE the one member row for the drawing that actually changed — `sheetCount` drops by one and `allFresh` flips to true, with the missing sheet visible nowhere.

**Evidence.**

```
supabase/migrations/20260828_integrity_hardening.sql:286-292 — `CREATE POLICY work_package_documents_org_update ON work_package_documents FOR UPDATE USING (EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_package_documents.org_id AND org_members.uid = auth.uid() AND org_members.status = 'active')) WITH CHECK (<identical>);`. supabase/migrations/20260825_work_packages_acks.sql:87-90 — the INSERT policy, same predicate, `package_id`/`document_id` unmentioned. app/api/verify-package/route.ts:38-41 — `await sb.from("work_package_documents").select("document_id, pinned_version_id, pinned_rev_label").eq("package_id", pkgId)` on a service-role client, no org filter.
```

**Chain reaction.** Same family as the FOR-ALL-USING holes the earlier audits found on tickets, notifications, email_notifications and project_documents, and the sibling `distribution_acks_org_update` hole already reported (roles-and-permissions 09-non-document-surfaces, 20260825:135-139). This one is worse than those because its output is rendered to an unauthenticated field worker as a go/no-go safety verdict.

**Done when.**

- [ ] work_package_documents UPDATE is restricted to the package owner or a controller, and the WITH CHECK forbids changing package_id/document_id/org_id
- [ ] the INSERT WITH CHECK asserts the referenced work_packages row and the referenced documents row are both in the same org as the new row
- [ ] /api/verify-package joins members on the package's org_id and ignores any row whose org_id or document org does not match
- [ ] a Viewer session cannot move a pin

---

<a id="pkg-6"></a>

## PKG-6 · 'Print pack' refreshes every pin BEFORE building the PDF, so a failed or partial build leaves the database asserting a print that never left the browser

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/packages/page.tsx:153-190`, `lib/workPackages.ts:194-229`, `lib/docPack.ts:77-140`, `lib/docPack.ts:142-148`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. The comment above the handler states the intended invariant — 'the paper and the database agree by construction' — which is exactly what the ordering breaks: on a failed or partial build the pins assert a print that never left the browser, and the public cover QR (PKG-2) then reads GREEN for whatever paper is actually in the field.

**Mechanism.** `handlePrintPack` runs `await refreshWorkPackage(pkg.id)` first (line 157), then dynamically imports the builders, then calls `buildAndDownloadDocPack` (line 169). Everything after line 157 can fail: the dynamic import, `buildPackageCover`, any per-document fetch, or the `included === 0` throw at docPack.ts:142-148. On any of those the catch shows 'Couldn't print the pack' — and the pins have already moved to current. Even on the success path, docPack silently drops documents into `skipped` (no current file, HTTP failure, unparseable PDF) while `refreshWorkPackage` has already re-pinned all of them, so pins claim a print for sheets that are not in the PDF. There is no transaction and no compensating rollback.

**Failure scenario.** An owner clicks 'Print pack' on a pack that has gone stale. R2 is briefly unreachable, so every fetch fails and docPack throws 'No documents could be packed'. The toast says the print failed. The pins, however, are now all at the current revision: /packages shows the pack green and 'Fresh', the amber 'Refresh pins' button disappears, and the paper pack already in the field — printed last week at the older revisions — now scans GREEN on the cover QR. The failure message and the system state disagree, and the state is the one the field trusts.

**Evidence.**

```
app/(protected)/packages/page.tsx:156-176 — `try { await refreshWorkPackage(pkg.id); const { buildPackageCover } = await import("@/lib/physicalBridge"); const { buildAndDownloadDocPack } = await import("@/lib/docPack"); … const result = await buildAndDownloadDocPack({…}); }` with the catch at :185 only surfacing a toast. lib/docPack.ts:142-148 — `if (included === 0) { throw new Error(…) }` — thrown after the pins have moved. lib/docPack.ts:82 — `if (!rawUrl) { skipped.push({ label, reason: "no current file" }); continue; }`.
```

**Chain reaction.** Compounds the previous two findings: refreshing pins is precisely the operation that re-arms stale paper to green, and here it happens as a side effect of an action that failed.

> **Verifier correction.** The title overstates on its own terms: as finding 4 establishes, the schema records no print event at all — the pins record current-ness, not printing. The accurate statement is that pins move with no corresponding paper, and the verify endpoint then reports those pins as `printedRev`. Root cause is shared with finding 4; the distinct defect here is the partial-build case, where documents landing in `skipped` are still re-pinned as though they were in the PDF.

**Done when.**

- [ ] the PDF is assembled first and pins are re-pinned only for the documents actually included, only after the download is triggered
- [ ] a build failure leaves every pin untouched
- [ ] the toast reports which documents were skipped and states that their pins were not moved

---

<a id="pkg-7"></a>

## PKG-7 · A member document the requester cannot read is silently erased from every work-package computation — it reads as never-drifted, its pin is NULLed on refresh, and it vanishes from the pack while the cover sheet still lists it

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/workPackages.ts:83-107`, `lib/workPackages.ts:199-221`, `lib/workPackages.ts:155-170`, `lib/docPack.ts:51-55`, `lib/docPack.ts:77-83`, `app/(protected)/packages/page.tsx:161-176`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed at HIGH — a hidden member is silently a permanent 'fresh' sheet, its pin is destroyed by the very refresh the print flow performs, and the printed cover lists a sheet the PDF does not contain with no skip warning to the operator.

**Mechanism.** `documents` carries a RESTRICTIVE ACL SELECT overlay (`documents_acl_select … USING (node_visible(visibility, acl_index, org_id))`, 20260708_acl_rls_enforcement.sql:86-87) while `work_package_documents` is org-scoped only. So a member row can exist for a document the reader cannot SELECT. Every consumer treats the resulting `undefined` as benign: (a) `listWorkPackages` computes `drifted: !!pinned && !!current && pinned !== current` where `current = (doc?.current_version_id …) ?? null` — undefined doc ⇒ current null ⇒ drifted FALSE, always; (b) `refreshWorkPackage` writes `pinned_version_id: (d?.current_version_id …) ?? null` — undefined doc ⇒ it WRITES NULL, destroying the pin, and the write succeeds so neither the `failed` nor the `unmatched` counter fires; (c) `createWorkPackage` builds rows from the documents it could read, silently dropping the rest; (d) `buildAndDownloadDocPack` iterates `docs` (the RLS-filtered result), so an invisible document produces no page AND no `skipped` entry, while `buildPackageCover` is fed `fresh.docs` — the unfiltered member list — and prints it under 'CONTENTS — revisions as printed'.

**Failure scenario.** A turnaround package contains a P&ID whose library ACL hides it from the contractor coordinator. The coordinator opens /packages: the pack shows green 'Fresh' even after that P&ID advances two revisions, because the hidden member can never be `drifted`. They click 'Print pack'. `refreshWorkPackage` writes NULL into that member's pinned_version_id — the pin is permanently gone. The merged PDF is missing the sheet, but the cover page lists it by name under 'revisions as printed' and the toast reports no skips. The crew takes a folder whose own cover says it contains a drawing that is not in it, and the public verify page now reports that sheet as 'Rev ? → Rev 5' STALE while the in-app view still shows the pack Fresh — the two surfaces contradict each other.

**Evidence.**

```
lib/workPackages.ts:99-106 — `const pinned = (m.pinned_version_id as string | null) ?? null; const current = (doc?.current_version_id as string | null) ?? null; … drifted: !!pinned && !!current && pinned !== current,`. lib/workPackages.ts:212-218 — `.update({ pinned_version_id: (d?.current_version_id as string | null) ?? null, pinned_rev_label: (d?.rev as string | null) ?? null })`. lib/docPack.ts:55 — `const docs = (docRows as Array<Record<string, unknown>>) ?? [];` then :77 `for (const d of docs)` — the loop never learns which requested ids are absent. app/(protected)/packages/page.tsx:167 — `docs: fresh.docs.map((d) => ({ label: d.docLabel, rev: d.currentRev ?? d.pinnedRevLabel }))`. supabase/migrations/20260708_acl_rls_enforcement.sql:86-87 — the RESTRICTIVE overlay.
```

**Chain reaction.** The invisible-document case also produces `docLabel: "Document"` (lib/workPackages.ts:101) — so the cover sheet prints a numbered contents line reading `3.  Document   Rev —`, which reads as a rendering bug rather than an access boundary.

> **Verifier correction.** Two narrowings. First, node_visible only bites for visibility 'private'/'hidden' (the function returns early otherwise), so the precondition is a restricted document inside a package, not any document. Second, the cover sheet does not print the drawing's real number for the missing sheet: lib/workPackages.ts:100 falls back to the literal string "Document" with rev "—", so the cover lists an unlabelled placeholder rather than the drawing's title block.

**Done when.**

- [ ] every consumer compares the requested id set against the returned rows and surfaces the difference: `drifted` is 'unknown' (not false) for an unreadable member, refresh refuses to write rather than NULLing a pin, createWorkPackage errors, and docPack records an explicit skipped entry
- [ ] the cover sheet is built from the documents actually merged, not from the member list
- [ ] a test with an ACL-hidden member proves no pin is destroyed and no sheet is silently omitted

---

<a id="pkg-8"></a>

## PKG-8 · Both public verify surfaces treat only Superseded and Archived as retired — a VOID or never-issued DRAFT drawing scans full-screen GREEN 'CURRENT' / 'PACK IS CURRENT'

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-package/route.ts:54-64`, `app/api/verify/route.ts:89-90`, `app/verify-package/[packageId]/page.tsx:90-98`, `app/verify/[docId]/page.tsx:99-107`, `types/schema.ts:613`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: only Superseded and Archived retire a document on either public surface, so a Void (or Draft) doc whose printed/pinned version still equals current_version_id scans full-screen green. The rest of the codebase already knows better — lib/aiBoundary.ts:25 `NOT_CURRENT_STATUSES = new Set(["Superseded", "Void", "Archived"])` and lib/staleCopies.ts:76 both include Void. Only nuance: a pack sheet for a doc with NO version at all reads stale (fresh requires a non-null pinned_version_id), so the Void case, not the never-uploaded-Draft case, is the live one; pinned_version_id is set to current_version_id at pin/refresh time (lib/workPackages.ts:163,185,214), so a Void doc pins green.

**Mechanism.** `DocumentStatus` is `"Draft" | "Issued" | "Superseded" | "Void" | "Archived" | "Locked"`. The pack endpoint computes `const retired = d?.status === "Superseded" || d?.status === "Archived";` and `fresh: !retired && !!r.pinned_version_id && r.pinned_version_id === (d?.current_version_id ?? null)`. /api/verify computes the identical two-value test at :89 and derives `isCurrent = !docRetired && (!versionId || versionId === d.current_version_id)`. Void and Draft fall through both. Since a voided or draft document still has a `current_version_id`, a pin or a printed version matching it yields fresh/current = true. The client pages then render the unqualified success state; the field page's explanatory branch only names Superseded and Archived (`result.docStatus === "Superseded" || result.docStatus === "Archived"`), so a Void document has no message path at all. Note /api/verify does carry the `notYetEffective` amber state for a future effective_date — /api/verify-package has no equivalent, so a pack pinned to a published-but-not-yet-in-force revision also reads plain green.

**Failure scenario.** A detail drawing is VOIDED after a design change — the org's formal statement that the drawing must not be used. It is still in a work package (nothing removes it) and still tagged to the equipment. A crew member scans the cover QR before starting work and gets the emerald screen: 'PACK IS CURRENT — Every sheet in this pack is still the current revision.' Scanning that individual sheet's own QR gives the same verdict: a green 'CURRENT'. The one mechanism in the product designed to stop a bad drawing being used affirmatively endorses it.

**Evidence.**

```
app/api/verify-package/route.ts:56 — `const retired = d?.status === "Superseded" || d?.status === "Archived";`. app/api/verify/route.ts:89-90 — `const docRetired = d.status === "Superseded" || d.status === "Archived"; const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);`. app/verify/[docId]/page.tsx:106-107 — `: result.docStatus === "Superseded" || result.docStatus === "Archived" ? \`This document has been ${result.docStatus?.toLowerCase()}.\``. app/verify-package/[packageId]/page.tsx:94-96 — the green copy. types/schema.ts:613 — the six-value status union.
```

**Chain reaction.** lib/downloads.ts:49-68 (`viewerStatusBadge`) DOES handle Void and Draft correctly with danger/caution tones — so the in-app on-screen badge is honest while the two unauthenticated field surfaces, which are the ones a worker actually consults, are not. Also note verify-package sets `allFresh: sheets.length > 0 && staleCount === 0`, so an empty package renders the alarming red 'PACK IS STALE — 0 of 0 sheets changed'.

**Done when.**

- [ ] a single shared helper decides retired/usable from DocumentStatus and both verify endpoints call it; Void and Draft are never 'current' or 'fresh'
- [ ] the field pages render a distinct state for Void ('VOIDED — DO NOT USE') and Draft ('NOT ISSUED')
- [ ] /api/verify-package applies the same effective-date qualification /api/verify already has
- [ ] an empty package renders a distinct 'no sheets recorded' state, not red-stale

---

<a id="pkg-9"></a>

## PKG-9 · Doc packs bypass the hard read-&-understood acknowledgment gate that every single-document download and print enforces

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/downloads.ts:153-215`, `lib/downloads.ts:217-218`, `lib/downloads.ts:261-262`, `lib/docPack.ts:40-140`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed and reachable from both entry points: app/(protected)/assets/[tag]/page.tsx:129-130 and app/(protected)/packages/page.tsx:159-169 both dynamic-import buildAndDownloadDocPack directly. The pack even replicates the audit/intent side-effects of a single download (lib/docPack.ts:114-133), which shows it was written to mirror downloadDocumentPdf — it just skipped the one blocking check.

**Mechanism.** `assertAckGate` resolves the document's effective ack policy and, when `policy.hardGate` is set and the user has a pending acknowledgment for the current revision, throws `AcknowledgmentRequiredError`. Two searches (`assertAckGate|AcknowledgmentRequiredError` across the whole repo, and a targeted grep over lib/docPack.ts) show it is called from exactly two places: `downloadDocumentPdf:218` and `printDocumentPdf:262`. lib/docPack.ts never imports `@/lib/acknowledgments`, never queries `document_acknowledgments`, and fetches bytes directly via `resolveToHttpUrl` → `/api/storage/download-url` — a route that enforces ACL discover and acl_index download-denies but has no ack check.

**Failure scenario.** Document control sets a hard acknowledgment gate on a revised relief-valve P&ID: nobody may take a copy until they have signed that they read the change. A superintendent who has not signed clicks 'Print doc pack' on /assets/PSV-42 — or 'Print pack' on the work package containing it — and receives the full stamped PDF including that drawing. The gate the UI advertises as blocking is routable around by choosing the pack button instead of the download button.

**Evidence.**

```
lib/downloads.ts:198-210 — `if (!policy?.enabled || !policy.hardGate) return; … if (((data as unknown[]) ?? []).length > 0) { throw new AcknowledgmentRequiredError(…) }`. lib/downloads.ts:157 — the comment 'This is the enforcement the "blocked" pill has always promised.' lib/docPack.ts:14-19 — the import list: `PDFDocument`, `supabase`, `applyStampToPdfDoc`, `recordIntent`, `publicOrigin`, `DocumentRecord`. No acknowledgments import.
```

**Chain reaction.** The same asymmetry drops the archive-aware 409 handling and the acl_index download-deny check whenever `file_url` is already an absolute URL: lib/docPack.ts:27 returns `raw` unchanged for `http://`/`https://` keys, skipping /api/storage/download-url entirely. app/api/share/file/route.ts:87 shows the codebase does carry http-form file_urls.

> **Verifier correction.** Worth stating alongside: assertAckGate is client-side only (lib/downloads.ts is a browser module) and fails open on any lookup error (:211-213), so it was never an unbypassable gate. The finding is still real — the doc-pack path does not even attempt it — but it widens an already-soft control rather than defeating a hard one.

**Done when.**

- [ ] buildAndDownloadDocPack runs the same ack gate per document and reports gated documents in `skipped` with a clear reason
- [ ] the gate lives in one shared helper both the single-document and pack paths call
- [ ] a hard-gated document with an outstanding signature cannot be obtained through any pack button

---

<a id="pkg-10"></a>

## PKG-10 · Downloading a SUPERSEDED revision stamps the CURRENT revision number on it and names the file after the current revision

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/downloads.ts:80-88`, `lib/downloads.ts:71-76`, `components/documents/VersionHistoryPanel.tsx:151-159`, `lib/downloads.ts:228-240`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: no caller overrides ctx.filename for a historical revision, and the stamp options at lib/downloads.ts:228-240 pass `footerNotice: buildFooterNotice(ctx.doc, ctx.userId)` unchanged. The only thing that does honour the version is the QR (buildVerifyUrl uses `ctx.versionId ?? ctx.doc.currentVersionId`), so the scan verdict and the printed footer contradict each other on the same sheet.

**Mechanism.** `buildFooterNotice(doc, userId)` reads `doc.rev` — the DOCUMENT's current revision — and `defaultFilename(doc, suffix)` builds `${stem}_Rev${doc.rev}${suffix}.pdf` from the same field. Neither takes `ctx.versionId` into account, even though the caller supplies it and `buildVerifyUrl` correctly uses it (`const version = ctx.versionId ?? ctx.doc.currentVersionId`). VersionHistoryPanel downloads a historical revision by passing that revision's `fileUrl` and `versionId: v.id` while cloning the doc with `checkedOutBy` cleared to force the uncontrolled path — so the bytes are Rev 2's and every label on and around them says Rev 5.

**Failure scenario.** An engineer opens version history to pull the as-built Rev 2 of a line iso for an incident review. They receive `P-101_Rev5_UNCONTROLLED.pdf`; every page is footered 'Rev 5 at time of issue — verify current revision before use.' The pages are Rev 2. If that print is filed, emailed or carried to the field it is a superseded drawing wearing the current revision number — the precise failure ASME/PSM document control exists to prevent. Only scanning the QR (which does carry `?v=<the Rev 2 version id>`) would reveal it, and the footer actively discourages that by asserting the revision.

**Evidence.**

```
lib/downloads.ts:82 — `parts.push(\`Rev ${doc.rev ?? "?"} at time of issue — verify current revision before use.\`);`. lib/downloads.ts:73-75 — `const rev = doc.rev ? \`_Rev${doc.rev}\` : ""; return \`${stem}${rev}${suffix}.pdf\`;`. lib/downloads.ts:99 — `const version = ctx.versionId ?? ctx.doc.currentVersionId;` (the QR gets it right). components/documents/VersionHistoryPanel.tsx:152-159 — `const docForDownload: DocumentRecord = { ...doc, checkedOutBy: undefined } as DocumentRecord; await downloadDocumentPdf({ doc: docForDownload, versionId: v.id, fileUrl: httpUrl, … });` — `doc.rev` is never overridden with `v.revisionLabel`.
```

**Chain reaction.** The same stamping path serves marked-up copies: MultiDocViewer bakes fabric redlines into the PDF (components/viewers/MultiDocViewer.tsx:681-687, lib/markupExport.ts:20-51) and then hands them to `downloadDocumentPdf` — where the checkout holder takes the `controlled` branch (lib/downloads.ts:222-226) and gets a RAW pass-through with no watermark, no footer and no QR. A redlined drawing therefore leaves the system as an unmarked 'controlled copy'.

**Done when.**

- [ ] buildFooterNotice and defaultFilename take the revision label of the version actually being delivered, falling back to doc.rev only when no versionId was supplied
- [ ] downloading a non-current version additionally stamps a SUPERSEDED / NOT CURRENT banner
- [ ] a baked-markup download is never treated as a controlled copy

---

<a id="pkg-11"></a>

## PKG-11 · /api/storage/download-url takes the presigned-URL lifetime from an unclamped query parameter, so any member can mint a 7-day unauthenticated link to a drawing's bytes

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/storage/download-url/route.ts:144-151`, `lib/docPack.ts:31-34`, `lib/downloads.ts:220`, `lib/downloads.ts:139`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. Authorization is per-request (active membership + private/hidden ACL discover + explicit download-deny), but all of it is spent once: the minted URL carries no further authentication and survives membership revocation for its whole lifetime, up to SigV4's 7-day ceiling, and the bytes it serves are the raw unstamped original with no download_audits row. MEDIUM is a fair severity — it requires an authenticated member who already passes the ACL gate.

**Mechanism.** `const expiresIn = parseInt(req.nextUrl.searchParams.get("expiresIn") || "3600"); … await getSignedUrl(r2, command, { expiresIn });` — no upper bound, no lower bound, no NaN handling. The SigV4 presigner accepts up to 604800 seconds. Every other signing site in the codebase hardcodes its lifetime (resolve: 3600, multipart part: 3600, upload-url: 900, transmittal: 300); this is the only caller-controlled one. Once issued, the URL is bearer-only: it survives the member being deactivated, the document being voided, an ACL download-deny being added, and a legal hold.

**Failure scenario.** A contractor about to roll off the project requests `?path=<issued drawing key>&expiresIn=604800` and saves the URL. Their org membership is revoked the next day. For the following week the drawing's raw, unwatermarked bytes are retrievable by anyone holding that link, with no further authentication, no watermark, no verify QR and no additional download_audits row. The `expires_at` recorded on the download audit (lib/downloads.ts:139, defaulting to 24 hours) understates the real exposure by a factor of seven, so any stale-copy recall built on that column is wrong.

**Evidence.**

```
app/api/storage/download-url/route.ts:144 — `const expiresIn = parseInt(req.nextUrl.searchParams.get("expiresIn") || "3600");` and :151 — `const url = await getSignedUrl(r2, command, { expiresIn });`. lib/docPack.ts:32 — the app's own caller asks for `expiresIn=3600`. app/api/storage/upload-url/route.ts:53 — `{ expiresIn: 900 }` hardcoded, showing the intended pattern.
```

**Chain reaction.** The ACL and deny-download checks at :57-115 are enforced at issuance only — which is correct design, but only if the issued window is short. An unbounded window turns a point-in-time authorization into a week-long standing grant.

> **Verifier correction.** One sub-claim is asserted rather than read: the 7-day ceiling (604800s) is SigV4/S3 behaviour, not something visible in this repo, and R2's acceptance of it is not verifiable here. The confirmed part is that the lifetime is unvalidated and passed straight to the presigner; the exact maximum reachable is inferred.

**Done when.**

- [ ] expiresIn is clamped server-side (e.g. 60..3600) and non-numeric input falls back to the default
- [ ] the lifetime actually granted is what gets written to download_audits.expires_at

---

<a id="pkg-12"></a>

## PKG-12 · A doc pack has no size or time limit anywhere, merges in browser memory, rasterizes every page of every document, and prints a cover sheet that lists only the first 24 of N sheets in an order that need not match the PDF

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/docPack.ts:40-140`, `app/(protected)/assets/[tag]/page.tsx:57`, `lib/stamping.ts:68-70`, `lib/stamping.ts:256-257`, `lib/physicalBridge.ts:262-270`, `lib/workPackages.ts:75-79`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. The unbounded in-memory merge, the 24-item cover truncation and the order mismatch are all real. One sub-claim is overstated and should be corrected: stamping does NOT rasterize every page of every document — lib/stamping.ts:70 `const MAX_ANALYZED_PAGES = 40;` and :112 `const pageCount = Math.min(doc.numPages, MAX_ANALYZED_PAGES);` cap ink analysis at 40 pages per document (later pages reuse the last analysis, lib/stamping.ts:268). Also app/(protected)/assets/[tag]/page.tsx:57 `.limit(500)` puts an implicit 500-document ceiling on the asset-hub path (the work-package path has none). MEDIUM stands.

**Mechanism.** `buildAndDownloadDocPack` accepts an unbounded `documentIds`, loops sequentially, and for EACH document calls `applyStampToPdfDoc` with `sourceBytes`, which spins up a fresh pdf.js document and rasterizes up to `MAX_ANALYZED_PAGES = 40` pages to a canvas before merging every page into one in-memory `PDFDocument`. Nothing caps document count, total page count, or total bytes, and there is no abort. The asset hub feeds it up to 500 documents (`.limit(500)`). Separately, neither the `documents` query in docPack (`.in("id", input.documentIds)`) nor the member query in `listWorkPackages` (`.from("work_package_documents").select("*").in("package_id", …)`) carries an `.order()`, so the merged page order and the cover's numbered contents list come from two independently unordered result sets. `buildPackageCover` then prints only `input.docs.slice(0, 24)` under the heading 'CONTENTS — revisions as printed', summarising the rest as '…and N more sheets' with no labels and no revisions.

**Failure scenario.** A superintendent opens the asset hub for a major unit tag with 180 tagged drawings and clicks 'Print doc pack'. The tab rasterizes thousands of pages and accumulates every one in memory; on a field tablet it locks up or is killed by the browser, and because the pins for a work-package print were already refreshed (see the print-ordering finding) the system may already believe a pack was produced. In the survivable case the crew receives a 200-sheet PDF whose cover lists 24 drawings by number and revision, calls the remaining 176 '…and 176 more sheets', and numbers its contents in an order that does not correspond to the page order — so 'sheet 7' on the cover is not page 7 of the folder, and there is no way to check a printed folder for completeness.

**Evidence.**

```
lib/docPack.ts:40-50 — the signature takes `documentIds: string[]` with no cap; :77 `for (const d of docs)` with no batching or abort. lib/stamping.ts:69-70 — `const MAX_ANALYZED_PAGES = 40;` per document. lib/stamping.ts:257 — `const ink = opts.sourceBytes ? await analyzePageInk(opts.sourceBytes) : null;` — called once per document inside the loop. app/(protected)/assets/[tag]/page.tsx:57 — `.limit(500)`. lib/physicalBridge.ts:263 — `input.docs.slice(0, 24).forEach((d, i) => {` and :269 — `\`…and ${input.docs.length - 24} more sheets\``. lib/docPack.ts:51-54 and lib/workPackages.ts:76-78 — neither query orders its rows.
```

**Chain reaction.** Also affects the download-audit trail: each included document fires `void supabase.from("download_audits").insert({…}).then(() => {}, () => {})` (lib/docPack.ts:114-123), so a 180-document pack fires 180 unawaited inserts with both callbacks swallowing the result — the established 'supabase-js resolves with {error}, unchecked write reads as success' pattern, already reported for this table as drafting-flow EVID-5.

> **Verifier correction.** This bundles two unrelated defects with different reach. The unbounded-merge half applies to both entry points, but the cover-sheet half (24-sheet truncation, contents order vs. PDF order) applies only to the /packages path — the asset-hub caller at assets/[tag]/page.tsx:130-137 passes no `cover`, so its 500-document pack has no contents list at all.

**Done when.**

- [ ] docPack enforces an explicit cap (document count and cumulative page/byte budget), refuses above it with a clear message, and offers a split
- [ ] both the documents query and the member query order deterministically, and the cover's contents list is generated from the merged pack's actual page order with a page number per entry
- [ ] the cover lists every sheet (continuation page when needed) rather than truncating at 24

---

<a id="pkg-13"></a>

## PKG-13 · Stamping ignores page /Rotate: the ink analysis measures the ROTATED page while the watermark, footer and QR are drawn in UNROTATED coordinates

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/stamping.ts:100-141`, `lib/stamping.ts:259-291`, `lib/stampLayout.ts:120-190`, `lib/markupExport.ts:32-44`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: on a /Rotate 90 sheet the corner chosen from the displayed page maps to a different physical corner once the viewer applies the rotation, and pageW/pageH are swapped relative to what the reader sees, so the plate geometry is computed against the wrong axis. lib/markupExport.ts:32-44 has the same defect (`const { width, height } = page.getSize(); ... page.drawImage(img, { x: 0, y: 0, width, height })`), so baked markup on a rotated page is drawn to the unrotated box too.

**Mechanism.** `analyzePageInk` measures with pdf.js: `const base = page.getViewport({ scale: 1 }); const viewport = page.getViewport({ scale: RASTER_WIDTH / base.width });` — pdf.js viewports APPLY the page's `/Rotate` entry, so for a 90°-rotated sheet the canvas width/height are transposed relative to the raw MediaBox, and the corner boxes labelled tl/tr/bl/br are the corners of the DISPLAYED page. The placement code then uses pdf-lib: `const { width, height } = page.getSize();` — MediaBox dimensions, rotation not applied — and hands those to `placeQr` and `drawFooter`, and `page.drawText`/`drawImage` place content in unrotated user space. A grep for `getRotation|setRotation|Rotate` across lib/ returns only `fitRotatedTextSize`/`centerRotatedText` (the watermark's own -30° angle) — page rotation is handled nowhere. `bakeMarkupIntoPdf` has the same mismatch: it sizes the fabric canvas from `page.getSize()` and draws the raster at `{ x: 0, y: 0, width, height }`.

**Failure scenario.** A CAD-exported D-size iso is stored with `/Rotate 90` (common for landscape drawings exported from portrait templates). The analyzer reports the emptiest corner as, say, 'br' of the displayed sheet; `placeQr` then puts the QR plate in the bottom-right of the UNROTATED page — which is a different physical corner, quite possibly on top of the title block or the revision table. The footer picks its band the same way. Because the watermark and footer are drawn in unrotated space, they appear rotated 90° to the reader. The verify QR — the mechanism that lets a paper print check itself — may be obscured or unscannable, and the 'UNCONTROLLED' watermark may not read as a watermark at all. Baked markups on the same sheet land 90° off from where the user drew them.

**Evidence.**

```
lib/stamping.ts:118-119 — `const base = page.getViewport({ scale: 1 }); const viewport = page.getViewport({ scale: RASTER_WIDTH / base.width });`. lib/stamping.ts:262 — `const { width, height } = page.getSize();` and :274 — `const q = placeQr({ pageW: width, pageH: height, corner: qrCorner });`. lib/stampLayout.ts:172-178 — plate placement derived purely from pageW/pageH. lib/markupExport.ts:37-44 — `sc.setDimensions({ width, height }); … page.drawImage(img, { x: 0, y: 0, width, height });` where width/height come from `page.getSize()`. Marked SUSPECTED because the visual consequence cannot be observed without rendering a rotated sheet; the coordinate-space mismatch itself is confirmed from the two APIs' documented behaviour and the absence of any rotation handling.
```

**Chain reaction.** `stampPdf` loads with `PDFDocument.load(source)` (lib/stamping.ts:299) while docPack loads with `PDFDocument.load(bytes, { ignoreEncryption: true })` (lib/docPack.ts:90) — the same encrypted PDF therefore fails loudly on an individual download and is merged into a pack with its content streams still encrypted, i.e. as unreadable pages, counted in `included` and reported as a successful sheet.

> **Verifier correction.** SUSPECTED is the right label and the finding says so. The mismatch between pdf.js viewport (rotation applied) and pdf-lib getSize (MediaBox) is read directly from the code; the visual outcome on a rotated sheet — QR landing over linework, footer running off an edge — is inferred from the two APIs' semantics and cannot be observed from the repo. No rotated fixture exists to check against (fixtures/ was not shown to contain one).

**Done when.**

- [ ] placement reads page.getRotation() and either normalizes the page or transforms the analyzer's corner/band results and the draw coordinates into the same space
- [ ] a fixture PDF with /Rotate 90 and /Rotate 270 is stamped in a test and the QR plate and footer are asserted to land inside the visible page and clear of the title block
- [ ] docPack and stampPdf agree on encryption handling, and an encrypted source is skipped with a reason rather than merged

---

<a id="pkg-14"></a>

## PKG-14 · supabase/schema.sql — the documented bootstrap — creates work_packages, work_package_documents and distribution_acks with RLS never enabled and no policies

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1262-1309`, `supabase/schema.sql:1011-1028`, `supabase/migrations/20260825_work_packages_acks.sql:57-58`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and schema.sql really is the from-scratch path: docs/ARCHITECTURE.md:947 `schema.sql ← cumulative create-from-scratch reference`. Because the migration uses CREATE TABLE IF NOT EXISTS, replaying migrations after schema.sql WOULD still run the ALTER … ENABLE RLS lines, so the gap only bites a deployment bootstrapped from schema.sql alone — which is exactly the documented path. MEDIUM is right.

**Mechanism.** schema.sql opens with 'Run this in the Supabase SQL editor to set up your database.' It contains exactly 22 `ENABLE ROW LEVEL SECURITY` statements (lines 391-1028), none of which name the three work-package/distribution tables it creates at 1266-1309. The block's own comment defers: 'Cumulative snapshot; RLS policies live in the migration file.' The migration does enable RLS (20260825:57-58) and add policies — but an operator who bootstraps from schema.sql, as the file instructs, gets these tables with RLS OFF. With RLS disabled, PostgREST's `authenticated` grant means any signed-in user of ANY tenant can select, insert, update and delete every row: read every org's package names and document ids, and move any org's pins.

**Failure scenario.** A new deployment (or a restored/rebuilt environment) is created by running schema.sql end to end. Work packages function normally, so nothing surfaces the gap. Any authenticated user — including a self-signup personal-org account — can enumerate `work_packages` across every tenant, read `distribution_acks` (who was told about which safety-critical revision and whether they confirmed), and set `acknowledged_at` on anyone's row. Nothing in the app or in schema.sql would reveal the difference between this deployment and a correctly migrated one.

**Evidence.**

```
supabase/schema.sql:1-2 — `-- Manufacturing OS — PostgreSQL schema for Supabase / -- Run this in the Supabase SQL editor to set up your database.` supabase/schema.sql:1263-1264 — `-- WORK PACKAGES + DISTRIBUTION ACKS (migration 20260825) / -- Cumulative snapshot; RLS policies live in the migration file.` A grep for `ENABLE ROW LEVEL SECURITY` over schema.sql returns 22 lines, the highest being 1028 (`watermark_policies`) — none for work_packages, work_package_documents or distribution_acks, both of which are created later in the same file. supabase/migrations/20260825_work_packages_acks.sql:57-58 — `ALTER TABLE work_packages ENABLE ROW LEVEL SECURITY; ALTER TABLE work_package_documents ENABLE ROW LEVEL SECURITY;`
```

**Chain reaction.** Every table created in schema.sql after line 1028 should be audited the same way — document_intents (1240-1258) carries the same 'RLS for both new tables mirrors the migrations' deferral comment at :1259.

> **Verifier correction.** Severity is overstated at HIGH because the finding presents this as specific to the work-package tables when it is a repo-wide convention the file states openly: schema.sql:1260 does the same for the document_intents/checkout tables ('RLS for both new tables mirrors the migrations (20260823 / 20260824)'), and the trailing sections (20260826/20260827/20260828) likewise only summarise and point at the migration files. The exposure is also conditional on a deployment that runs schema.sql and skips supabase/migrations/ entirely, and on Supabase's default public-schema grants — schema.sql itself contains only two GRANT statements (lines 487, 560), both on functions, so the 'authenticated grant' step is inferred from Supabase defaults, not read from this repo. Real, but a bootstrap-documentation defect rather than a live tenant-isolation hole.

**Done when.**

- [ ] schema.sql enables RLS and defines the policies for every table it creates, or explicitly refuses to run without the migrations
- [ ] a startup/CI assertion fails when any table in the public schema has RLS disabled

---
