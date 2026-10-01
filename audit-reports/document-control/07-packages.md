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
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 7c).** Confirmed exactly as written: `makeLibraryStoragePath` is a pure function of (org, library, folder, filename), a PUT overwrites, and the two unsalted callers — the bulk library upload (`filename: file.name`) and `createDocumentWithFile` (`Rev0_${name}`) — collapsed same-named uploads onto one object while the doc-number auto-rename (`P-101` → `P-101-2`) hid the collision. Fixed by salting exactly like the four revision paths always have:
- New pure `uniqueUploadName(filename, revLabel)` in `lib/storage.ts` produces `stem__rev<label>__<millis>.ext` (rev sanitized, extension preserved, missing names defaulted) — one implementation instead of a fifth inline copy of the pattern.
- Both callers wired: `app/(protected)/documents/[libraryId]/page.tsx` (bulk upload, uses the staged item's rev) and `lib/revisions.ts` `createDocumentWithFile` (rev 0).
- Done-when: (1) every storage key carries a per-upload unique component, including both previously-unsalted paths ✓; (2) the distinctness rule is pinned by test — as a pure-function test on the shared helper plus the call-site wiring, rather than a live two-upload integration test (no storage emulator in this environment; the helper IS the key-distinctness mechanism) ✓/≈.
- Files: `lib/storage.ts`, `app/(protected)/documents/[libraryId]/page.tsx`, `lib/revisions.ts`.
- Tests: `lib/__tests__/uniqueUploadName.test.ts` — two same-named uploads get distinct names; stem/rev/extension preserved; hostile rev labels sanitized; missing name/extension defaults.
- **What this brought to light:** existing documents created through these paths before the fix still share keys pairwise if their names collided — the fix stops NEW collisions but does not de-duplicate history. A collision census (group `document_versions.file_url` by value, flag >1 distinct `record_id`) is a candidate maintenance task for the retention/storage area.

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
- `app/(protected)/assets/[tag]/page.tsx` — the skip toast now lists each refused sheet with its reason (`P-101 (under an active hold …)`), and the "all current, all stamped" sentence only fires when `skipped.length === 0`, which after the gate means every included sheet was Issued/Locked (or pre-status legacy data, which the gate deliberately tolerates) and hold-free (done-when 3).
- The same gate protects the work-package print path — `app/(protected)/packages/page.tsx` builds through the identical `buildAndDownloadDocPack`.
- Done-when: (1) status fetched, non-Issued/Locked refused and recorded in `skipped` with the reason ✓; (2) active holds bind egress — held sheets refused (stricter than the banner asked for) ✓; (3) the success message cannot claim "all current" over a non-current or held sheet ✓.
- Files: `lib/docPack.ts`, `app/(protected)/assets/[tag]/page.tsx`.
- Tests: `lib/__tests__/docPackFilter.test.ts` — Issued/Locked pass; Draft/Superseded/Void/Archived each refused with the status in the reason; legacy empty-status passes; held sheet refused; hold-read failure refuses everything (fail closed); status refusal wins when both apply; label fallback order.
- **Self-audit addendum (2026-08-24, Phase 7b).** A 29-agent adversarial audit of this fix found the work-package print path undermining the gate: `handlePrintPack` recorded the immutable print snapshot and built the cover **before** the gate ran, so a refused sheet was still listed on the cover and in the snapshot — the public QR verdict described paper the crew never received. Fixed: new `assessPackDocs()` (exported from `lib/docPack.ts`) runs the same gate BEFORE any side-effect; the snapshot, the cover, and the print set are the gated set; an all-refused pack aborts with the first reason and records nothing; the packages-page toast now lists refusal reasons like the asset hub's. Also fixed the asset-hub progress denominator (pre-seeded with the unfiltered count, it jumped mid-run once the gate dropped sheets — now the builder's first progress callback establishes the gated total).

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
- **Applied & verified live 2026-08-24:** `20261032` — 4-point probe all true (ack guard installed; ack INSERT forbids rows born acknowledged; pack-pin INSERT org-bound; pack-pin guard installed). A Viewer session can no longer move, inject, or delete a pin.
- **Self-audit addendum (2026-08-24, Phase 7b).** The adversarial audit of this fix confirmed three gaps, all closed:
  1. **The tightened UPDATE policy broke the shipped "Print pack" flow for every non-owner member** — `handlePrintPack` unconditionally ran `refreshWorkPackage` first, which now matched 0 rows and threw, so a non-owner's print died with "Couldn't print the pack" even on a fully fresh pack. Fixed in `app/(protected)/packages/page.tsx`: pins refresh only when the caller is the package owner or Admin/DocCtrl; anyone else's print proceeds from current revisions with pins untouched, the toast saying so. The print snapshot now records each sheet's **current** version — what docPack actually prints — so a non-owner's paper is still described truthfully (also more faithful to PKG-2's stated design).
  2. **`trg_wpd_pin_guard` fired only BEFORE UPDATE**, so "a pin must name a revision of this row's own document" was not enforced on INSERT — a member could INSERT a row whose pin points at another document's version. Migration `20261033` re-creates the trigger `BEFORE INSERT OR UPDATE` with a `TG_OP` branch. **Applied & verified live 2026-08-24** (4-point probe all true).
  3. **The migration-shape tests were mutation-defeated** — unbounded regexes were satisfied by the verification block at the bottom of the SQL file, so deleting the owner/controller block from the UPDATE policy left all tests green (proved by mutation). The suite now slices each assertion to its own statement and was re-proved: both audit mutations now fail it.

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
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 7d).** Confirmed — and the Phase-7b rework had narrowed but not closed it (the snapshot and refresh still preceded the build). The pipeline is now ordered so state can only ever assert paper that exists:
1. **Gate** (`assessPackDocs`, PKG-4) — an all-refused pack aborts having written nothing.
2. **Content assembly** — every fetch/stamp/merge, the entire failure zone, runs with NO state written.
3. **Snapshot + cover** — `buildAndDownloadDocPack` gained a `buildCoverAfter(includedSheets)` hook, called only once the content pack is fully assembled, with the list of sheets ACTUALLY in the PDF; `handlePrintPack` records the immutable print snapshot and builds the cover there, so both describe exactly the paper (a fetch-failed sheet can no longer appear in the snapshot or the cover's contents list). The cover is prepended to the finished pack.
4. **Download.**
5. **Pins last** — an `afterDownload(includedSheets)` hook runs after the download is triggered; the owner/controller refresh moves pins ONLY for the included documents (`refreshWorkPackage` gained `onlyDocumentIds`). A refresh failure here is reported as a warning, never as a failed print — the paper is already correct and correctly snapshotted, and an unmoved pin just keeps an honest STALE badge.
- Done-when: (1) PDF assembled first, pins re-pinned only for included documents, only after the download ✓; (2) a build failure leaves every pin untouched (and records no snapshot) ✓; (3) the toast lists skipped sheets and states their pins were not moved ✓.
- Files: `lib/docPack.ts`, `lib/workPackages.ts`, `app/(protected)/packages/page.tsx`.
- Tests: `lib/__tests__/docPackOrdering.test.ts` — the event order IS the assertion (cover → prepend → save → download → pins); a fetch-failed sheet is absent from both hooks' sheet lists; a total build failure calls neither hook.
- Residual, recorded: `recordPackagePrint` stays best-effort (snapshot write failure → legacy package-QR print, pins still only move after download), and a crash between snapshot and download can leave a print row for paper never produced — a snapshot row with no paper is harmless (the QR on nonexistent paper is never scanned), unlike the reverse, which this fix eliminates.

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
- **Status:** RESOLVED
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

**Resolution (2026-10-01, document-control Round F wave 2).** P8 FIELD. Reproduced at `55e281d`: `listWorkPackages` derived `drifted` from an undefined document (`current = null` → always false), `refreshWorkPackage` wrote `pinned_version_id: (d?.current_version_id …) ?? null` for a member whose document it could not read, `createWorkPackage` built member rows from the documents it could read and dropped the rest, and `buildAndDownloadDocPack` looped over the RLS-filtered rows with no entry for a requested id that did not come back. The new PKG-7 tests fail against that code (DEC-29).
- **Every consumer compares the requested ids with the rows returned.**
  - `lib/docPack.ts` `accountForRequested` (pure) returns the rows in the caller's order and one explicit skip per missing id: label "Restricted document", code `unreadable`, reason "you cannot open this document, so it could not be checked or printed — ask Document Control". `assessPackDocs` and `buildAndDownloadDocPack` both read through it (`readAndGatePackDocs`). A documents read that ERRORS throws ("nothing was printed") instead of reading as an empty pack.
  - `lib/workPackages.ts`: `memberFreshness` answers `fresh` / `drifted` / `unknown`. `WorkPackageDoc` gains `readable` and `freshness`, `WorkPackage` gains `unknownCount`. An unreadable member is labelled "Restricted document" (not the bare "Document"), is never `drifted` and never fresh; a failed documents read leaves every member `unknown`.
  - `refreshWorkPackage` checks its member and document reads, writes only the members whose document this person can read, and then throws naming how many pins were NOT moved. A pin is never NULLed.
  - `createWorkPackage` reads the chosen documents FIRST and refuses, with nothing created, when any of them cannot be read.
- **The cover is built from the merged sheets** (`buildCoverAfter(includedSheets, skipped)`, PKG-6's hook). The unreadable member appears in the toast's left-out list and on the print snapshot as left out (`VFY-19`).
- `/packages` shows a slate "Unknown · N" pill instead of "Fresh", and "status unknown to you" on the member's row.
- Tests: `lib/__tests__/dcRoundFField.test.ts` "PKG-7 — …" (six): the pack's explicit skip and the cover's sheet set; order, de-duplication and missing ids; a failed read throws; the `unknown` list state; refresh never writes the hidden member's pin; create refuses with nothing inserted.
- **Fix pass (review findings).** The first pass checked the documents read in `listWorkPackages` but not the MEMBER read, and it named every member of a failed documents read "Restricted document" (a permission it had not learned):
  - The member read is checked. A failed read sets `WorkPackage.membersUnread`; `/packages` shows "Unknown · not read" and "sheets not read just now" (never "0 docs, Fresh"), counts it in "need attention", and disables Print pack for it.
  - A failed documents read marks its members `unknownReason: "unread"`, labelled "Document (not read just now)" with "not read just now — reload to try again". "Restricted document" / "status unknown to you" are kept for a read that answered without the row (`unknownReason: "restricted"`).
  - Both `.in()` reads are chunked at 150 ids (members by package, so each package's members stay in one ordered read), so ~30 open packages of ~20 sheets is no longer one 600-id GET.
  - Tests: three more in "PKG-7 — …" (the failed member read, the failed documents read, the chunked reads).

**Done-when.**
1. ✓ Every consumer compares the requested ids against the returned rows: `drifted` is `unknown` (not false) for an unreadable member; refresh refuses to write rather than NULLing a pin; `createWorkPackage` errors; docPack records an explicit skipped entry.
2. ✓ The cover sheet is built from the documents actually merged.
3. ✓ A test with an ACL-hidden member proves no pin is destroyed and no sheet is silently omitted.

**Scope / residual.** A refresh still MOVES the readable members' pins and then reports the ones it could not move (left exactly as they were). That is a partial refresh, said in the error, not all-or-nothing. `components/documents/AddToPackageButton.tsx` (not this package's file) calls `listWorkPackages` and is unaffected by the new fields.

---

<a id="pkg-8"></a>

## PKG-8 · Both public verify surfaces treat only Superseded and Archived as retired — a VOID or never-issued DRAFT drawing scans full-screen GREEN 'CURRENT' / 'PACK IS CURRENT'

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-10-01, public-surfaces Round F).** Record-only for this area — `/api/verify`'s half is `DIST-2` (2026-08-24); the rest is public-surfaces PS-VERIFY (`VFY-1`, `VFY-9`, `VFY-11`), which owns both verify routes this round; verified at the branch:
- **One shared helper:** `lib/verifyVerdict.ts` `documentStanding(status)` — retirement from `NOT_CURRENT_STATUSES`, Draft, and an ALLOW-list (Issued / Locked) for in force; anything else `not_issued`. `/api/verify` and `/api/verify-package` both call it; neither spells a status list.
- **Distinct states on both pages:** `/verify` — "VOID — DO NOT USE", "DRAFT — NOT ISSUED", "NOT ISSUED — DO NOT USE" (DIST-2 + PS-VERIFY); `/verify-package` — each sheet labelled VOID / SUPERSEDED / ARCHIVED / DRAFT — NOT ISSUED / NOT ISSUED / STATUS NOT RECOGNISED (a status the vocabulary does not know, e.g. IFC — since public-surfaces PS-VERIFY's integration fix pass, `VFY-9`) and never fresh.
- **Effective dates in the pack:** `/api/verify-package` reads the current revisions' `effective_date` and a pending one makes the sheet and the pack `not_yet_effective` (amber) — decided by `effectiveStatusFor`, the facility's calendar (`REV-9`). Review fix pass (2026-10-01): the first pass swallowed any read error on that query (no date → `fresh` → a green pack before a sheet was in force); now only a missing column (`42703`, a database with no dates) reads as "no date" and any other error is `503` (`isUndefinedColumnError`, `lib/verifyVerdict.ts`; `verifyPackageSnapshot.test.ts` "an effective-date read that ERRORS is never green …"). `/api/verify` has the same rule.
- **Not-issued sheets are not "changed since printing"** (review fix pass): the pack page counts `draft` / `not_issued` sheets apart from changed / withdrawn ones (`notIssuedCount`; "N of M sheets are not an issued, controlled revision").
- **Empty pack:** its own verdict, "NO SHEETS IN THIS PACK" (slate), never red '0 of 0'.
- Tests: public-surfaces `lib/__tests__/verifyPackageSnapshot.test.ts` "VFY-1 / PKG-8 — the shared allow-list decides every sheet" (Void / Superseded / Archived / Draft / NULL / In Review → never fresh; Locked in force; a pending effective date → `not_yet_effective`; no status list in the route) and "VFY-8 / VFY-11 …"; `lib/__tests__/verifyRouteVerdict.test.ts`; `lib/__tests__/verifyPresent.test.ts`.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when.**
1. ✓ One shared helper decides retired / usable; both endpoints call it; Void and Draft are never current or fresh.
2. ✓ The field pages render distinct Void and Draft states.
3. ✓ `/api/verify-package` applies the not-yet-in-force qualification — and fails closed when the effective dates cannot be read (review fix pass).
4. ✓ An empty package renders a distinct state.

**Scope / residual.** None for this finding. The pack print gate (`filterPackDocs`, P8's file) still admits an empty-status legacy sheet that the shared allow-list reads `not_issued` — public-surfaces `VFY-17`, owned by P8 FIELD.

---

<a id="pkg-9"></a>

## PKG-9 · Doc packs bypass the hard read-&-understood acknowledgment gate that every single-document download and print enforces

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-10-01, document-control Round F wave 2).** P8 FIELD. Reproduced at `55e281d`: `lib/docPack.ts` never called `assertAckGate` (`lib/downloads.ts`, called only by `downloadDocumentPdf` and `printDocumentPdf`), and the book viewer's merged book (`components/viewers/MultiDocViewer.tsx` `assembleStampedBook`) did not either.
- **One shared helper.** `ackGatedDocumentIds(docs, userId)` (`lib/downloads.ts`) is the gate. It holds the effective-policy memo (moved in unchanged) and makes one `document_acknowledgments` read for the hard-gated subset. Its callers:
  - `assertAckGate` (the single download and print) is now a one-line caller of it.
  - `lib/docPack.ts` `readAndGatePackDocs` runs it per sheet after the status and hold gate, before any fetch.
  - The book viewer refuses a book containing a gated sheet, naming it, before anything is stamped.
- **Both pack buttons.** `assessPackDocs(ids, { userId })` (the `/packages` pre-print gate) and `buildAndDownloadDocPack` (the `/packages` build and the asset hub's "Print doc pack") both apply it. A gated sheet is skipped with "read-&-understood sign-off outstanding — sign it before taking a copy" (code `ack_required`) and never merged.
- Tests: `dcRoundFField.test.ts` "PKG-9 — …": a gated sheet is left out and never stamped; `assessPackDocs` applies the gate before any side-effect and passes the sheet once signed; the single download still refuses through the same helper, and the three callers are pinned; the gate fails open on a broken policy read.
- **Fix pass (review findings).** The helper resolved every candidate's effective policy first — up to two sequential collection / library reads per distinct key — and only then asked for pending acknowledgments, so a 150-sheet pack spread over many folders could make ~300 round trips before printing (twice: `assessPackDocs`, then the build). It now reads the person's PENDING acknowledgments for the candidates first (one read per 150 ids) and resolves a policy only for a document with one; a person with none pending makes no policy read at all. The fail-open rule is unchanged (an errored chunk gates nothing). Test: "reads the printer's PENDING acknowledgments first (chunked) …".

**Done-when.**
1. ✓ `buildAndDownloadDocPack` runs the same ack gate per document and reports gated documents in `skipped` with a clear reason.
2. ✓ The gate lives in one shared helper (`ackGatedDocumentIds`) that the single-document, pack and book paths call.
3. ✓ A hard-gated document with an outstanding signature cannot be obtained through any pack button: `/packages` "Print pack", the asset hub's "Print doc pack", and the viewer's merged book.

**Scope / residual.** The posture the verifier named is unchanged: the gate is client-side and fails OPEN on a policy or acknowledgment read error, because a broken read must not brick every copy. A server-side gate would need the bytes route (`/api/storage/download-url`, not this package's file) to know which copy it signs for.

---

<a id="pkg-10"></a>

## PKG-10 · Downloading a SUPERSEDED revision stamps the CURRENT revision number on it and names the file after the current revision

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-10-01, document-control Round F wave 2).** P8 FIELD. Reproduced at `55e281d`:
- Done-when 1 has held since `REV-1` (2026-08-24): `defaultFilename` and `buildFooterNotice` read `servedRev(ctx)` = `versionRev ?? doc.rev`, and `VersionHistoryPanel` passes `versionRev` / `versionIsCurrent` (verified).
- Done-when 2 was half-met: a non-current copy's footer said "SUPERSEDED REVISION — Rev N …", but its diagonal watermark still read "UNCONTROLLED — FOR REVIEW ONLY".
- Done-when 3 was open in the book viewer, as DEC-64 §5 records. `MultiDocViewer` `runDocAction` baked the redlines and handed them to `downloadDocumentPdf`, where `determineControlState` gave the checkout holder the raw, unstamped controlled pass-through.

What landed:
- **`copyControlState(ctx, hold)`** (`lib/downloads.ts`) is the copy rule both copy paths now apply. A copy with markups baked in (`DownloadContext.markedUp`) is uncontrolled. So is a copy of a held document (`HLD-1`). Anything else falls through to `determineControlState`, unchanged (a non-current version is uncontrolled since `REV-1`). `MultiDocViewer` sets `markedUp` whenever it bakes.
- **`copyWatermark`**: a non-current copy is watermarked "SUPERSEDED — NOT CURRENT", beside its existing SUPERSEDED footer line and `_Rev<served>` filename.
- Tests: `dcRoundFField.test.ts` "PKG-10: a copy with baked markups is never the controlled master; a non-current copy is watermarked SUPERSEDED": the holder's marked-up download is stamped; an old revision gets the SUPERSEDED watermark, its own Rev in the filename and the SUPERSEDED footer; the viewer passes the flag. The `REV-1` pins in `downloadsRevLabel.test.ts` are unchanged and green.

**Done-when.**
1. ✓ `buildFooterNotice` and `defaultFilename` take the delivered version's label, falling back to `doc.rev` only without one (since `REV-1`; verified).
2. ✓ A non-current copy additionally carries a SUPERSEDED / NOT CURRENT watermark.
3. ✓ A baked-markup download is never treated as a controlled copy: the book viewer now; `FullScreenViewer` since PS-STAMP (`PHYS-5`, DEC-64 §5).

**Scope / residual.**
- The book viewer's "This sheet" button still skips its confirmation dialog for the checkout holder when the sheet has markups. `activeControlled` is the synchronous rule, so the person is not shown the dialog explaining the stamp, although the copy is stamped regardless.
- `FullScreenViewer`'s confirmation text (not this package's file) still names the "UNCONTROLLED — FOR REVIEW ONLY" watermark, although an old-revision or held copy is now watermarked SUPERSEDED / ON HOLD.

---

<a id="pkg-11"></a>

## PKG-11 · /api/storage/download-url takes the presigned-URL lifetime from an unclamped query parameter, so any member can mint a 7-day unauthenticated link to a drawing's bytes

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Closed with `EGR-4` (same route, same mechanism) — DEC-44 §2. `lib/presignedLifetime.ts` `resolvePresignedLifetime` clamps the caller's `expiresIn` into `[60, 3600]` (3600 = the app's own default) and refuses a non-integer; `app/api/storage/download-url/route.ts` answers 400 on a refusal, signs with the resolved seconds, and returns the GRANTED `expiresIn` under `Cache-Control: no-store`. One divergence from the illustrative remediation, stated: non-numeric input is refused with 400 rather than silently falling back to the default — a caller sending garbage is told so. **Corrected in the fix pass:** the first write-up claimed 3600 was "the only value any caller has ever asked for" — false. Six sites ask for 3600 (`lib/docPack.ts:32`, `lib/storage.ts:129`, `SecureDocViewer.tsx:107`, `FullScreenViewer.tsx:184`, `FileReferenceModal.tsx:50`, `InspectorPanel.tsx:226`) and five asked for a week: `components/providers/OrgBrandingProvider.tsx:40` (admin-and-org `P8`'s file), `lib/userProfiles.ts:140`, `components/documents/PageBackground.tsx:23`, `components/documents/NodeCover.tsx:42`, `app/(protected)/admin/branding/page.tsx:70` — images, not document egress. What happens to them: they are clamped to the granted hour, `lib/storage.ts` now caches by path for the GRANTED window (it used to key by the requested value and expire at the requested week, so the clamp alone would have left every image cache holding a dead URL), and the four long-lived holders re-sign in place at the margin through `subscribeSignedUrl` (details and tests under `EGR-4`).
- Files: `lib/presignedLifetime.ts`, `app/api/storage/download-url/route.ts` (and `app/api/storage/resolve/route.ts` for the shared ceiling); fix pass: `lib/storage.ts` and the five callers listed above.
- Tests: `lib/__tests__/presignedLifetime.test.ts` (see `EGR-4`: resolver, route end to end, the `getSignedUrl` census under `app/api`; fix pass: the client cache honours the granted window, keyed by path; the client-side census finds no literal above the ceiling).
- Reproduced: at the base commit `?expiresIn=604800` was signed for 604800 and `?expiresIn=abc` for `NaN` (temporary route test, deleted after the fix; the new file asserts the inverse).
- Verified: green with the full suite, `tsc`, `eslint`.

**Done-when.**
1. ✓ `expiresIn` is clamped server-side to `60..3600`; non-numeric input is refused with 400 (louder than the suggested silent default — see the divergence above).
2. ✗ Not done as written, and why: `download_audits.expires_at` is written by `lib/downloads.ts` (`P8 FIELD`'s file, the `EGR-6` limb — not edited here) as the **copy-validity stamp** of an uncontrolled download (`now + 24h`, only when `state === "uncontrolled"`), not as the URL's lifetime; writing the granted URL window into it would change what that column means to the stale-copy recall that reads it. What this round does instead: the route returns the granted `expiresIn` so any writer can record it, and after the clamp the real URL exposure (≤ 1 h) is strictly inside the 24 h the record already states — the record now **bounds** the exposure instead of understating it seven-fold, which is the harm the criterion was written against. If P8 wants the exact grant on the row, `logDownloadAudit` can take it from the route's response.

**Scope / residual.** The presigned URL is still a bearer capability for its (now ≤ 1 h) window — that is the design, and DEC-44 §2 puts anything longer or forwardable on `document_shares`, which can be revoked. The "no download_audits row from this route" observation in the mechanism is unchanged and correct: the audit row is the downloader's (`lib/downloads.ts`), the route only signs. Behaviour change for the round README (with `EGR-4`): branding logos, avatars, folder covers and page backgrounds are signed for an hour and re-signed in place, not once a week.

---

<a id="pkg-12"></a>

## PKG-12 · A doc pack has no size or time limit anywhere, merges in browser memory, rasterizes every page of every document, and prints a cover sheet that lists only the first 24 of N sheets in an order that need not match the PDF

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Partial (2026-10-01, public-surfaces Round F).** PS-VERIFY — the cover limb (`lib/physicalBridge.ts` is PS-VERIFY's this round). `buildPackageCover` now lists EVERY sheet in pack order — 24 on the cover above the QR, then continuation pages of 40 ("CONTENTS (continued) … page n of N"), all prepended to the pack by the existing `buildCoverAfter` path — instead of 24 and "…and N more sheets". `coverContentsChunks(count)` (pure) decides the ranges.
- Files: `lib/physicalBridge.ts`. Tests: public-surfaces `lib/__tests__/verifyDoor.test.ts` "PKG-12 — the cover lists every sheet" (every index exactly once, in order, for 0–200 sheets; a 30-sheet pack builds a two-page cover; the "more sheets" summary is gone).
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (267 files / 5088 passed, 7 expected-fail).

**Done-when (this pass).**
1. ✗ Not done here — the cap (document count / page / byte budget, refuse with a split) belongs in `lib/docPack.ts`, which serves both callers; P8 FIELD's file. The asset page's `.limit(500)` is unchanged for the same reason.
2. ◐ The cover's list is the merged pack's actual order (PKG-6: it is built from `includedSheets`), but the `documents` and member queries (`lib/docPack.ts`, `lib/workPackages.ts`) are still unordered and the cover carries no page number per entry — `buildPackageCover` receives no page counts; P8 FIELD.
3. ✓ The cover lists every sheet, with continuation pages.

**Scope / residual.** Stays OPEN for done-when 1 and 2 → document-control P8 FIELD (`lib/docPack.ts`, `lib/workPackages.ts`, `app/(protected)/packages/page.tsx`); adding page numbers needs docPack to hand the cover each sheet's page count.

**Resolution (2026-10-01, document-control Round F wave 2).** P8 FIELD closes done-when 1 and 2, which PS-VERIFY's Partial left here. Reproduced at `55e281d`: `buildAndDownloadDocPack` took an unbounded `documentIds`. Its `documents` read had no order and the merge followed the read. The `listWorkPackages` member read had no `.order()`. `PackSheetRef` carried no page count, so the cover could not number its entries.
- **The budget** (stated default, provisional DEC-44 (P8 FIELD)): `PACK_MAX_SHEETS` 150, `PACK_MAX_PAGES` 1000, `PACK_MAX_BYTES` 150 MB (`lib/docPack.ts`).
  - The sheet count is refused before a single fetch (`packSheetBudgetRefusal`).
  - Pages and bytes are checked as each sheet is loaded, before it is stamped or merged. The first sheet that crosses either refuses the whole pack.
  - `PackTooLargeError` carries `parts` / `perPack`, and its message offers the split: "Split it into N packs of at most M sheets each". A sheet over the budget on its own is told to be downloaded alone. `splitPackIds` makes the parts.
  - A refusal comes before the cover hook, so nothing is recorded, downloaded or re-pinned.
- **Deterministic order.**
  - The merged order is the caller's id order (`accountForRequested`), no longer the unordered documents read.
  - `listWorkPackages` orders members by `added_at`, then `id`, so `/packages` lists, gates and prints in one order.
  - The cover lists `includedSheets`, the merged pack's actual page order (PKG-6).
- **A page number per entry.** `PackSheetRef.pageCount` and `coverEntryLabels(sheets, coverPages)` give entries like "P-101 · pp. 3–4". The cover's own pages are counted from `coverContentsChunks`, and a long label is shortened so the page reference stays visible. `/packages` passes these labels to `buildPackageCover`; `lib/physicalBridge.ts` (PS-VERIFY's file) is unchanged.
- Tests: `dcRoundFField.test.ts` "PKG-12 — …" (five):
  - over the sheet budget: no fetch, no record, the split offered;
  - over the page budget mid-assembly: no cover, snapshot, download, record or pins;
  - one sheet over the budget;
  - the caller's order kept, with page counts;
  - the cover's page labels and the ordered member read.

- **Fix pass (review findings).**
  - **The split is offered where it can be acted on.** The asset hub (`app/(protected)/assets/[tag]/page.tsx`, outside the plan, disclosed) turns a refused pack into "Print part i of N" buttons (`runPack`, `splitPackIds` — no longer unused); a part refused for pages or bytes re-splits at the smaller size. A single sheet over the budget alone is not split (it is downloaded on its own).
  - **`/packages` has no one-click split, by design (the lost capability, recorded).** A part-print of a work package would need its own snapshot semantics — the parts not on that paper would read "added since this pack was printed" on every scan. A package over 150 sheets can no longer be printed as ONE pack; the refusal names the remedy (split the work package, e.g. one per area).
  - **Who the budget removes is measured, not assumed.** No count was taken when the budget was set (this package has no database access). Migration `20261143` (DRLS-10's) carries two read-only MEASURE rows in its one result set: open / executing packages with more than 150 sheets, and asset tags carried by more than 150 non-archived documents. The count lands with the paste. The 150 MB source-byte cap also catches a few dozen high-resolution scans; that population has no measure (file sizes per pack are not stored).
  - **Behaviour change, stated.** A pack that printed yesterday may be refused today: a package or asset tag over 150 sheets, a pack over 1000 pages, or one whose source files exceed 150 MB.
  - **The failure scenario is the finding's, not an incident.** "A 180-sheet pack" in DEC-44 (P8 FIELD)'s rationale is now worded as this finding's scenario.
  - Test: "the asset hub turns a refused pack into the parts it names …".

**Done-when.**
1. ✓ docPack enforces an explicit cap — document count, cumulative pages and cumulative bytes — and refuses above it with a clear message offering a split. The asset hub offers the split as part buttons; `/packages` offers it as an instruction (split the work package — see the fix pass for why there is no part-print there).
2. ✓ Both reads give a deterministic order (the documents in the caller's order, the members by `added_at`, `id`), and the cover is generated from the merged pack's actual page order with a page reference per entry.
3. ✓ (PS-VERIFY, 2026-10-01) The cover lists every sheet, with continuation pages.

**Scope / residual.**
- The asset hub's `.limit(500)` read (`app/(protected)/assets/[tag]/page.tsx`, PS-VERIFY's file) is unchanged. docPack now refuses any pack over 150 sheets with the split, whichever page calls it; the asset hub prints the parts.
- The budget's reach is the `20261143` MEASURE rows, pending the paste.
- Ink analysis still caps at 40 pages per document (`lib/stamping.ts`, PS-STAMP's file), as the verifier noted.
- The budget values are a stated default (provisional DEC-44 (P8 FIELD) — the integrator renumbers).

---

<a id="pkg-13"></a>

## PKG-13 · Stamping ignores page /Rotate: the ink analysis measures the ROTATED page while the watermark, footer and QR are drawn in UNROTATED coordinates

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-01, public-surfaces Round F).** This is the same defect as public-surfaces `PHYS-12`, closed in package PS-STAMP, which owns `lib/stamping.ts`, `lib/stampLayout.ts` and `lib/markupExport.ts`. See the resolution on `PHYS-12` (03-physical-bridge.md) for the reproduction and the fixture.
- Placement: `applyStampToPdfDoc` reads `page.getRotation()` and lays every mark out in the page's display space (`DisplayFrame`, `normalizeRotation` / `displaySize` / `displayToUser`), the space the ink analysis measured. Each anchor maps into user space with the page's rotation.
- The markup limb: `lib/markupExport.ts` `bakeMarkupIntoDoc` sizes the raster to the displayed page and lays it back rotated. `bakeMarkupIntoPdf` and the single viewer's "Download w/ Markup" both use it.
- The encryption chain reaction: `applyStampToPdfDoc` refuses a document pdf-lib loaded with `ignoreEncryption` (`pdfDoc.isEncrypted` → "the PDF is encrypted, so it cannot be stamped — it was not issued as a copy"). `lib/docPack.ts`'s per-sheet `try/catch` (P8's file, unedited) therefore records the sheet under `skipped` with that reason instead of merging unreadable pages into the pack. `stampPdf` (no `ignoreEncryption`) already failed an individual download loudly, so the two now agree.
- Tests: `lib/__tests__/stampingRotation.test.ts` covers `/Rotate` 0/90/180/270 placement and the markup bake. Its SHR-8 block covers `/Rotate 90` and `/Rotate 270` title-blocked sheets with no mark over the title block. "PKG-13 dw3" covers a crafted encrypted PDF: its plain load throws, its `ignoreEncryption` load is refused by the stamper with nothing drawn, and docPack's catch turns the refusal into a skipped sheet.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (258 files / 4636 tests: 4629 passed, 7 expected-fail).

**Done-when.**
1. ✓ Placement reads `page.getRotation()` and maps the analyzer's corner/band results and the draw coordinates into the same space.
2. ✓ Fixture PDFs with `/Rotate 90` and `/Rotate 270` (and 180) are stamped in a test. The QR plate and footer land inside the visible page and clear of the title block.
3. ✓ docPack and stampPdf agree that an encrypted source is never issued: stampPdf fails loudly, and docPack skips the sheet with a reason rather than merging it.

**Scope / residual.** The MediaBox origin and CropBox offsets are not compensated. The stamp draws from the MediaBox's (0, 0) as before; that is a separate, pre-existing gap.

---

<a id="pkg-14"></a>

## PKG-14 · supabase/schema.sql — the documented bootstrap — creates work_packages, work_package_documents and distribution_acks with RLS never enabled and no policies

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-09-23, Round F).** Reproduced first: `supabase/schema.sql` created 46 tables and carried 22 `ENABLE ROW LEVEL SECURITY` lines — 24 tables (the three named here plus `document_holds`, `document_intents`, `revision_branches`, `projects`, `milestones`, the notification, subscription and export tables, …) were created with RLS off and no policy, and the header still read "Run this in the Supabase SQL editor to set up your database." Reconciled with DB-8 (the numbered migrations are the only source of truth; schema.sql must not become a second copy of the policies) by ANNOTATING and failing closed rather than regenerating: (1) the header now states in capitals that the file alone is NOT A COMPLETE INSTALL, that the migrations are MANDATORY and run after it in filename order, where the policies for the post-baseline tables live, and that the file must never be re-run on a live database; (2) a "BOOTSTRAP RLS" block at the end enables RLS on all 24 tables (idempotent; each line names the migration that carries its policies) — a database that has run only schema.sql now exposes NOTHING through PostgREST (deny-all until the migrations run) instead of every tenant's packages and acknowledgments; (3) the file ends with a "BOOTSTRAP CENSUS" `SELECT` — the last result set the SQL editor shows — listing every public table that is RLS-disabled or RLS-enabled with no policy ("locked — apply the migrations"), so the operator sees the gap instead of a silent success. CI assertion: `lib/__tests__/schemaBootstrapCensus.test.ts` fails the build when any `CREATE TABLE` in schema.sql lacks an ENABLE in schema.sql; when any table created anywhere under `supabase/` is never RLS-enabled in the sequence (it parses the `FOREACH … EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY')` loop `20260819` uses for the four cost tables, which a naive census reports as unprotected — verified: they are enabled there); when the header statement or the trailing census is missing; or when schema.sql GAINS a policy / function / trigger definition (the frozen baseline set is pinned: 4 functions, 27 policies, 0 triggers).
- Files: `supabase/schema.sql`, `lib/__tests__/schemaBootstrapCensus.test.ts` (new).
- Tests: the census file above (5 tests). No migration: the live database is base + migrations already (README phase history), and ENABLE RLS is idempotent state, not a body DB-8 tracks.

**Done-when.**
- [x] schema.sql enables RLS and defines the policies for every table it creates, or explicitly refuses to run without the migrations ✓ — it enables RLS on every table it creates (the policies stay in the migrations per DB-8), states that the migrations are mandatory, and surfaces what is still locked as its final result.
- [x] a startup/CI assertion fails when any table in the public schema has RLS disabled ✓ — a static, repo-side census over schema.sql + every numbered migration; the live-side equivalent is the trailing SELECT. No test here can query the production database (DEC-30).

**Scope / residual.** Chain reaction addressed: `document_intents` / `revision_branches` (the same deferral comment) are in the block. `HLD-12`'s schema.sql half closes on this.

---
