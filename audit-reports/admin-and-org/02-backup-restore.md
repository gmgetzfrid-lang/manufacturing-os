# 02 · Export, backup, restore & portability

**14 findings** — 2 CRITICAL · 7 HIGH · 5 MEDIUM.

What is in the export set, what is silently absent, and what a restore does to live data.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| lib/__tests__/exportCoverage.test.ts — the backup-coverage tripwire that diffs ORG_SCOPED_TABLES / USER_SCOPED_FOR_ORG_TABLES / EXPORT_EXCLUDED_TABLES against every CREATE TABLE in supabase/ | `lib/__tests__/exportCoverage.test.ts:29-99` | It genuinely passes today: all 111 created tables are accounted for, there are no phantoms, and RESTORE_TABLE_ORDER covers every non-skipped exported table. This is the right shape of guard — the fixes above should extend it (org_id presence, conflict-target validity, storage-key columns) rather than replace it. |
| SSRF guard on every admin-supplied destination (webhook URL and custom S3 endpoint), with DNS resolution and IPv4/IPv6 private-range checks | `lib/exportRunner.ts:37-76` | assertSafeExternalUrl is called before s3Put, before the webhook POST, and in testDestinationConnection. Do not weaken it while changing destination handling. |
| Read-back verification of every pushed backup — HEAD the object and fail the run if the stored size differs from what was sent | `lib/exportRunner.ts:358-372` | "a backup that isn't checked after writing isn't a backup" is implemented correctly here and is the model the browser path should copy. |
| Webhook payload signing over `<timestamp>.<sha256(zip)>` with the content hash published in its own header | `lib/exportRunner.ts:284-305` | Replaces an earlier filename-only signature; kills body-swap and replay. Sound as written. |
| Compare-and-set claim of a due destination before running it, so overlapping cron sweeps cannot double-export | `app/api/data-export/run-scheduled/route.ts:78-94` | Correct optimistic-concurrency pattern; the cron is properly fail-closed on CRON_SECRET (:52-55) and vercel.json already carries exactly the two permitted entries. |
| remapRow's value-equality deep remap of uids (top-level columns and inside JSONB) instead of a column allowlist | `lib/dataRestore.ts:188-246` | The comment explains why the allowlist rotted (14 of 30+ columns). The value-match approach is the durable one; UID_COLUMNS is kept purely as documentation. |
| planRestore is pure and deterministic, and /api/admin/restore/preview never mutates | `lib/dataRestore.ts:98-186, app/api/admin/restore/preview/route.ts:1-50` | The plan-then-approve split is the right safety model for restore and is what makes the id-collision and continue-on-failure problems fixable in one place. |
| Bell notification to every OTHER Admin/DocCtrl when a manual full export completes | `app/api/data-export/run/route.ts:38-68, 141-144` | The detection control for compromised-credential exfiltration already exists and works for manual runs — the scheduled path just needs to call it. |
| /api/storage/upload-url authorizes the KEY (org membership on `orgs/<uuid>/`), not just the session | `app/api/storage/upload-url/route.ts:29-45` | Blocks cross-tenant overwrite for org-prefixed keys. The remaining hole is the untreated non-org-prefixed branch, which the restore's "put files back" step can reach with attacker-chosen ZIP entry names (e.g. `files/data/<archive>.zip`, the protected offline-archive prefix) — worth closing when that flow is touched. |
| lib/storageOrphans.ts fails closed — any query error in the reference collector aborts the whole scan rather than treating those keys as unreferenced | `lib/storageOrphans.ts:9-19, 95-97` | The safety model is right; it simply cannot detect a column that was never registered, which is why the registry must be shared with the export's collector. |


---


<a id="bkp-1"></a>

## BKP-1 · Exports embed live unauthenticated bearer tokens — share links, transmittal portal links, and WRITE-capable vendor intake links — in plaintext in a file designed to be mailed around

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/exportTables.ts:50-54`, `lib/dataExport.ts:300`, `app/api/share/resolve/route.ts:30-37`, `app/api/transmittal/route.ts:24-31`, `app/api/intake/upload/route.ts:32-40`, `supabase/migrations/20260623_document_shares.sql:14`, `supabase/migrations/20260902_project_intake.sql:22`, `supabase/migrations/20260910_transmittal_portal.sql:21`, `lib/exportTables.ts:171-181`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every leg: the columns exist in plaintext, `select("*")` carries them into both the JSON envelope and the ZIP's tables/*.json, and possession of the string is the entire credential on three unauthenticated routes, one of them write-capable. The only counter-argument is fidelity (a restore without tokens breaks live share links) — that's a design tension, not a refutation of the exposure.

**Mechanism.** `document_shares`, `project_intake_links` and `transmittals` are all in ORG_SCOPED_TABLES and dumped with `select("*")`, so their token columns land verbatim in tables/*.json and in the JSON envelope. Each token is a complete credential resolved server-side with the service role and no session: app/api/share/resolve/route.ts:5-8 "gated ONLY by possession of the unguessable token"; app/api/transmittal/route.ts:2 "Token possession is the whole credential". project_intake_links.token is worse than read-only — app/api/intake/upload/route.ts accepts an unauthenticated multipart POST keyed on it and inserts documents/cost_documents into the project.

**Failure scenario.** An admin runs the export (or a nightly scheduled push lands the ZIP in a customer S3 bucket, or the JSON is handed to a departing employee under the "no lock-in" promise). Anyone who reads that file can open every unexpired share link and transmittal portal — controlled drawings, at their as-sent revisions, without an account and without appearing as a user anywhere — and can PUSH new revisions into any project that has a live vendor intake link. Revoking access requires knowing the backup leaked; the tokens keep working until expires_at/revoked_at.

**Evidence.**

```
lib/exportTables.ts:50-54 lists `"project_intake_links"`, `"document_shares"`, `"transmittals"` among org-scoped tables. app/api/transmittal/route.ts:26-30 `.from("transmittals").select("*").eq("portal_token", token)`. app/api/intake/upload/route.ts:33 `if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return bad("invalid token");` then :38 `.eq("token", token)` — no auth header is read. The exclusion list already states the correct principle for a different table (lib/exportTables.ts:173-175: ai_connections — "holds live AI provider API keys — secrets never leave the database"); bearer tokens got no such treatment.
```

> **Verifier correction.** Accurate as written. Worth qualifying only that share and transmittal tokens honor revoked_at/expires_at checks at resolve time (share/resolve:38-42, and intake/upload:41-42), so an org that rotates links after an export limits the read exposure; the intake token's write capability is the part with no compensating control.

**Done when.**

- [ ] token columns are redacted (nulled) in the export dump, or those tables are exported through an explicit column list that omits `token`/`portal_token`
- [ ] the manifest notes that share/portal/intake links must be re-issued after a restore, and the restore path regenerates tokens instead of reinstating the old ones
- [ ] a test asserts no exported row contains a value matching the share/portal/intake token shape

*Cross-area note (2026-09-23, document-control Round F): the export half landed once under document-control `EGR-7` — `lib/exportTables.ts REDACT_COLUMNS` / `redactRow` applied by `dumpTable`, manifest + README naming the redacted columns, and `lib/dataRestore.ts scrubRestoredRow` (inside `remapRow`) so no restore path reinstates a token (`DEC-45`). BKP-1 closes by pointer to EGR-7 when admin-and-org P2 runs.*

**Partial (2026-10-01, admin-and-org Round G).** P1's restore half, verified and pinned — no new code was needed for it. Re-verified on HEAD `bcbf3e8`: document-control `EGR-7` / `DEC-45` put `scrubRestoredRow` inside `remapRow` (`lib/dataRestore.ts`), and since `ORG-1` / `BKP-3` both restore routes write ONLY through `applyRestoreChunk`, which calls `remapRow` on every row — so the single-shot `/apply` scrubs exactly as the chunked `/apply-table` does: a share or intake link lands with a `restored-<uuid>` placeholder token and `revoked_at` set, a transmittal with no `portal_token` and an issued one VOIDED. Test: `lib/__tests__/restoreApplyRoute.test.ts` "the single-shot route scrubs every bearer column like the chunked one" (`document_shares`, `project_intake_links`, `transmittals`) and "the same rows land identically through /apply-table and /apply"; the chunked route stays covered by `lib/__tests__/dcRoundFExportContract.test.ts`. Done-when 2's restore clause ("the restore path regenerates tokens instead of reinstating the old ones") holds on both routes; the export half (Done-when 1, 3 and the manifest note) is `EGR-7`'s, which admin-and-org P2 closes this finding by pointer to. Status stays OPEN for P2.

**Resolution (2026-10-01, admin-and-org Round G).** Package P2 — the export half by pointer, plus the value test Done-when 3 asks for. Re-verified on base `2290b94`: document-control `EGR-7` / `XEDGE-10` (`DEC-45`) holds — `lib/exportTables.ts REDACT_COLUMNS` (`document_shares.token`; `project_intake_links.token`, `token_hash`, `token_prefix`; `transmittals.portal_token`; the three `export_destinations` `*_encrypted` columns) and `redactRow`, applied by `dumpTable` to every dumped row (`lib/dataExport.ts`, `out.push(...rows.map((r) => redactRow(table, …)))`); the manifest's `redactedColumns` and notes say share and intake links must be re-issued, a restored transmittal has no portal link, and destination credentials must be re-entered; the restore half is P1's (Partial above). What was missing was Done-when 3: the only tests were source pins (`lib/__tests__/dcRoundFExportContract.test.ts`) and a unit test of `redactRow`; nothing ran the export over live token values. Landed: `lib/__tests__/exportContractRoundTrip.test.ts`, "BKP-1 — no exported row carries a live bearer credential". The real `runOrgExport` runs over a workspace holding a live share token, an intake token with its hash and prefix, an issued transmittal's portal token and an export destination's three credentials. Every redacted column is null in every exported row (each redacted table has rows, so the check is not vacuous), and none of the seeded values appears anywhere in the serialized envelope, in any entry of the server ZIP (`lib/exportRunner.ts buildAndDeliverExport`) or in any part of the browser Full ZIP (`lib/clientBackup.ts runFullBackup`). The test matches values, not a "token shape": the intake door's shape (`[A-Za-z0-9_-]{16,128}`) also matches every UUID in the envelope, so a shape scan cannot tell a leak from an id. The shape side is the existing redaction census (`lib/__tests__/exportCoverage.test.ts`: every credential-NAMED column of an exported table must be redacted).
- Files: none changed for this finding (tests only).
- Tests: `lib/__tests__/exportContractRoundTrip.test.ts` "the envelope: every redacted column is null and no token value appears anywhere", "the server ZIP and the browser Full ZIP: no token value in any entry".

**Done-when.**
- [x] token columns are redacted (nulled) in the export dump ✓ — `REDACT_COLUMNS` / `redactRow` in `dumpTable` (`EGR-7`).
- [x] the manifest notes that share/portal/intake links must be re-issued after a restore, and the restore path regenerates tokens instead of reinstating the old ones ✓ — the manifest notes (`lib/dataExport.ts`); `scrubRestoredRow` on both restore routes (P1, above).
- [x] a test asserts no exported row contains a value matching the share/portal/intake token ✓ — by value, across the envelope and both ZIP layouts.

**Scope / residual.** None for this finding. `export_destinations.webhook_url` is not a credential under `DEC-45` and is still exported; a member's direct read of it is narrowed by `BKP-11`'s migration `20261154`.

---

<a id="bkp-2"></a>

## BKP-2 · cost_documents binaries are referenced by nothing the system knows about — absent from every backup AND eligible for permanent orphan deletion after 7 days

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/dataExport.ts:316-363`, `lib/storageOrphans.ts:42-88`, `lib/storageOrphans.ts:152-177`, `app/api/admin/orphans/route.ts:47`, `app/api/intake/upload/route.ts:70-87`, `supabase/migrations/20260819_orphan_tables_backfill.sql:179-196`, `lib/exportTables.ts:93`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves verified by repo-wide search: no reference source anywhere registers cost_documents.file_url, so the binaries are simultaneously absent from every backup manifest and eligible for permanent, unrecoverable deletion 7 days after upload.

**Mechanism.** `cost_documents.file_url` holds a real R2 key (`orgs/<org>/project-costs/<project>/quote-<uuid>-<name>`, written by app/api/intake/upload/route.ts:71-84 straight after a PutObjectCommand). Two independent key collectors exist and neither lists the table: dataExport.collectFilePaths enumerates document_versions.file_url, tickets.attachments[].url, markup_requests.shared_markup_url, asset_photos.file_url, plot_plans.image_path, libraries/collections.cover_image_url and the branding logo — no cost_documents; storageOrphans.collectReferencedKeys enumerates 11 sources — also no cost_documents. `deleteOrphans` deletes any object older than MIN_AGE_DAYS=7 that is not in that reference set and not under `data/`/`exports/`.

**Failure scenario.** A vendor submits a quote through an intake link; the PDF lands in R2 and the row in cost_documents. Eight days later an admin clicks the orphan-reclaim button on /admin/storage: the file is not in the reference set, is older than 7 days, is not under a protected prefix — it is permanently deleted from R2 while the cost_documents row (with total_amount, vendor, bid-tab entry) still points at it. The backup cannot help: cost_documents rows are exported (lib/exportTables.ts:93) but the binary was never in any file manifest or ZIP, and the manifest still reports `missing: 0` because a key it never collected can't be counted missing.

**Evidence.**

```
lib/storageOrphans.ts:11-13 promises the opposite — "the reference collector queries a fixed list of known key columns; if ANY query errors … the whole scan ABORTS" — but a column that was never registered produces no error at all. lib/storageOrphans.ts:39-41 even names the contract: "Tables added later MUST be registered here — the exportTables tripwire's cousin for binaries." A grep of lib/dataExport.ts for `cost_documents|file_key|source_file_key|output_templates` returns nothing.
```

> **Verifier correction.** One qualifier for whoever acts on this: the purge is not automated. It requires POST /api/admin/orphans with `confirm: true` from an Admin/DocCtrl (app/api/admin/orphans/route.ts:35-47) — there is no cron entry for it. The backup gap, by contrast, is unconditional. Note the same omission covers asset_files (in ORG_SCOPED_TABLES and RESTORE_TABLE_ORDER, in neither collector), which strengthens rather than weakens the finding.

**Done when.**

- [ ] cost_documents.file_url is registered in BOTH lib/storageOrphans.ts sources and lib/dataExport.ts collectFilePaths
- [ ] a test enumerates every storage-key column in the schema and fails when either collector is missing one (the binary analogue of exportCoverage.test.ts)
- [ ] orphan deletion refuses to run when the reference collector's source list is smaller than the schema's storage-key column set

*Cross-area note (2026-09-30, intelligence Round G): intelligence `ILIFE-1` (the same `cost_documents` gap) closes by pointer when this lands, and also asks that the orphan purge's audit row record the deleted KEYS. Intelligence `ILIFE-6`'s open halves ride this package: the export contract (`dumpTable`, `lib/dataExport.ts:315`, pages with no `.order`, and the manifest has no per-table count reconciliation), and this finding's collector — `collectReferencedKeys` pages by OFFSET with a count taken after the loop, so a concurrent delete skips a live reference the count cannot see (ILIFE-6 criterion 3, reproduced; the fix is keyset paging, `.gt("id", lastId)`). Landing it forces two test edits outside this area's files: flip `lib/__tests__/intelRoundGRecords.test.ts` "ILIFE-6 criterion 3 …" from `it.fails` to `it` (a deliberate tripwire — it fails the suite until flipped), and update `lib/__tests__/destructiveDeletes.test.ts`'s collector fake, which answers only `.range`. Intelligence `ILIFE-8`'s residual is here too, and ILIFE-8 stays OPEN on it: the orphan scan returns `referencedKeys`, a platform-wide count, to one org (`app/api/admin/orphans/route.ts:30`, `lib/storageOrphans.ts:187`) — count only keys under the caller's prefix, or drop the field (`DEC-57`). Neither is in admin-and-org P2's plan yet; the integrator adds both. (Test edits and ILIFE-8 status added on intelligence I-01's fix pass 3.)*

**Resolution (2026-10-01, admin-and-org Round G).** Package P2. Reproduced on base `2290b94`: `lib/dataExport.ts collectFilePaths` (`:340-387`) and `lib/storageOrphans.ts collectReferencedKeys` (its sources, `:47-93`) each kept their own list, and neither named `cost_documents` (no match in either file). Fix: `lib/storageKeyRegistry.ts` is the one registry. `STORAGE_KEY_SOURCES` lists 12 sources: document revisions with their native source, knowledge PDFs, asset photos, ticket attachments, markup files, plot plans, library and folder covers, avatars, the branding logo, output templates with their examples, and `cost_documents.file_url`. BOTH collectors read it: `collectFilePaths` builds the backup's file manifest from it, and `collectReferencedKeys` builds the sweep's reference set from it. `STORAGE_KEY_COLUMNS` declares the schema's key columns. `collectReferencedKeys` first calls `registryGaps(sources)` and refuses to scan when its sources read fewer columns than that declaration ("reference scan refused: the schema's storage-key columns … are read by no collector source — aborting (fail-closed)"). `scanOrphans`, and so `deleteOrphans`, run it first. `asset_files`, which the verifier named, holds no key of its own: it links an asset to a DOCUMENT, whose revisions' keys are collected. `BINARY_LINK_TABLES` records this and the census asserts it.
- Files: `lib/storageKeyRegistry.ts` (new), `lib/storageOrphans.ts` (the collector), `lib/dataExport.ts` (`collectFilePaths`).
- Tests: `lib/__tests__/storageKeyRegistry.test.ts`:
  - the census: "every key-named column in supabase/ is registered or declared not-a-key, with a reason", "STORAGE_KEY_COLUMNS is exactly the key-named columns plus the JSON-embedded logo — no more, no less", "the sources read exactly the declared key columns (no gap either way)";
  - "cost_documents, native CAD sources, knowledge PDFs and output templates are in BOTH collectors";
  - "BKP-2 Done-when 3: the orphan sweep refuses to run when its source list is smaller than the schema's key columns" (no read happens);
  - "asset_files holds no key of its own".
  `lib/__tests__/exportContractRoundTrip.test.ts` carries a vendor quote through the server ZIP, the browser ZIP and a restore.

**Done-when.**
- [x] cost_documents.file_url is registered in BOTH lib/storageOrphans.ts sources and lib/dataExport.ts collectFilePaths ✓ — one registry, read by both.
- [x] a test enumerates every storage-key column in the schema and fails when either collector is missing one ✓ — since the review fix pass (below). *Corrected at the review fix pass:* the first claim (the name census plus the JSON-embedded logo) was not met. `libraries.page_config` and `collections.page_config` hold a live key (a page background), and neither the registry nor the name census saw them.
- [x] orphan deletion refuses to run when the reference collector's source list is smaller than the schema's storage-key column set ✓ — `registryGaps` in `collectReferencedKeys`.

**Review fix pass (2026-10-01, admin-and-org Round G, P2).** The registry missed a live key column, so the purge still deleted live files. Reproduced at `e2d4ddd`: an Admin who sets a library or folder page background (Customize, `components/documents/CustomizeNodeModal.tsx` `handleBgUpload`) uploads it to `orgs/<org>/branding/backgrounds/<uuid>.<ext>`, and the key is saved as `page_config.background.imagePath` (`app/(protected)/documents/page.tsx` `saveLibraryAppearance`; `lib/libraryCollections.ts updateCollectionAppearance` for a folder). Neither `STORAGE_KEY_SOURCES` nor `STORAGE_KEY_COLUMNS` named `page_config`. The name census could not see it, and its "exactly the key-named columns plus the logo" test would have failed had the column been registered. So `deleteOrphans` deleted every background older than 7 days, and every export of an org with backgrounds printed the value scan's warning about `libraries.page_config`. Fix, all in `lib/storageKeyRegistry.ts`:
- two sources, "libraries(page background)" and "collections(page background)", with `keyColumns: ["page_config"]`, extracting `page_config.background.imagePath`;
- `libraries.page_config` and `collections.page_config` in `STORAGE_KEY_COLUMNS`;
- `JSON_KEY_COLUMNS`, a declared map of every registered column whose key sits inside JSON under another name, each with where it sits: `tickets.attachments`, `org_configurations.data`, `output_templates.example_files` and the two `page_config` columns. The census reads it in place of the hard-coded logo, and `plainKeyColumns` reads it in place of its private list;
- every extractor now names the key column each key came from (`StorageKeyRef.column`), which the census checks and the manifest order uses (`BKP-9` fix pass).

Tests, all in `lib/__tests__/storageKeyRegistry.test.ts`:
- **The column census:** "STORAGE_KEY_COLUMNS is exactly the key-named columns plus the declared JSON key columns", and "every JSON key column is registered, says where the key sits, and a registered column the name census cannot see is one".
- **The writer census**, new, which works from the other end: `STORAGE_WRITERS` lists every file in `app/`, `lib/`, `components/` and `hooks/` that writes an object to storage, with its exact number of write sites. It matches `uploadToPath(`, its wrappers, `putWithXhr(`, `putObject(`, `new PutObjectCommand(` / `CreateMultipartUploadCommand(`, and the `/api/storage/upload-url` / `multipart` doors. Each entry names the column its key is persisted into, or the reason none is (the doors themselves; `lib/exportRunner.ts`, which writes to the customer's own bucket; the template generator's transient source spreadsheet). The suite fails when a write site is added, removed or moved, and when a writer persists into an unregistered column. The modal's background upload is pinned to `page_config.background.imagePath`.
- **Fixtures:** "a library's and a folder's page background are in BOTH collectors". The registry as it stood before this pass leaves exactly those two columns to the value scan and to `registryGaps`.
- Checked by mutation in this file and the round trip: dropping the folder background's source fails 10 tests, because the sweep refuses to scan. Unregistering the column entirely (source, declaration and JSON entry) fails 7 tests, among them the writer census.

**Scope / residual.** The column census reads column NAMES, so a key put inside a JSON column under another name is invisible to it. The writer census closes that from the writing side, for every write site that exists today. A key that reaches a row by any route other than a storage write in the app is still caught only at run time, by the export's value scan (`BKP-9` Done-when 3), for example a key copied from another row, or a hand edit. On the cross-notes above:
- Intelligence `ILIFE-1`'s third criterion (the purge's audit row records the deleted KEYS) belongs to `app/api/admin/orphans/route.ts`, which is outside this package's files; `ILIFE-1` stays OPEN on it.
- `ILIFE-6` criterion 3 landed here. `collectReferencedKeys` pages `.order("id").gt("id", last).limit(1000)` (keyset), so a row deleted behind the cursor can no longer move a window. The tripwire in `lib/__tests__/intelRoundGRecords.test.ts` is flipped to `it`. `lib/__tests__/destructiveDeletes.test.ts`'s stand-in answers the keyset chain and throws on `.range`. One case keyset paging alone cannot rule out: a row already read is deleted while a row is inserted behind the cursor, and the count balances. Closing it needs a re-check of each candidate just before `DeleteObjects`, in `deleteOrphans` (the purge side), which this package's brief does not cover; recorded on `ILIFE-6`. *Review fix pass:* `ILIFE-6`'s export half (criteria 1 and 2 for `dumpTable`) landed too; see the `ILIFE-6` record. *Second review fix pass:* the purge-side re-check is recorded with its exact hunk on `ILIFE-6` and in `audit-reports/document-control/99-fix-sequencing.md`. *Corrected at the final review fix pass:* this said document-control P14 owns it, but P14's brief does not list it. It is handed off; the integrator assigns the owner at the P2 merge (proposed: admin-and-org P3, after document-control P14 merges).
- `ILIFE-8`'s `referencedKeys` residual is not in this package's plan and is untouched.

---

<a id="bkp-3"></a>

## BKP-3 · /api/admin/restore/apply does not force the org boundary that /apply-table does — rows whose org_id isn't the backup's land in whatever org the file names

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/restore/apply/route.ts:79-111`, `app/api/admin/restore/apply-table/route.ts:52-58`, `lib/dataRestore.ts:200-218`, `app/api/admin/restore/apply/route.ts:75`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified by direct comparison of the two routes; the org-forcing line exists in apply-table and has no counterpart in apply. Admin of org A can write forged rows into org B, and into any table name the envelope invents.

**Mechanism.** apply-table (the chunked path the UI uses) remaps then overwrites: `const m = remapRow(r, idRemap); if ("org_id" in m) m.org_id = orgId;` — with the comment "FORCE the org boundary: whatever the backup (or a hostile client) claims, restored rows belong to the authorized workspace". The single-shot apply route omits that step entirely: it only calls `remapRow`, and remapRow rewrites org_id ONLY when the value is a key of idRemap.orgId, which contains exactly one entry — `{ [manifest.orgId]: targetOrgId }`. A row carrying any other org_id falls through `deepRemapValues` unchanged and is written by the service-role client, which bypasses RLS. apply also has no IMPORTABLE allowlist: `plan.counts.tables` is built from whatever keys the uploaded envelope has, minus SKIP_TABLES, so any table name the poster invents is attempted.

**Failure scenario.** An Admin of org A POSTs an envelope with `manifest.orgId = A` and rows whose org_id is org B (trivially hand-edited — the format is documented as "vanilla JSON"). Every such row is inserted into org B: forged audit_logs entries, notifications, document rows, e_signatures. The same route will also attempt writes to any table name present in the JSON, restricted only by SKIP_TABLES. Nothing in the response distinguishes rows that landed in the caller's org from rows that did not.

**Evidence.**

```
app/api/admin/restore/apply/route.ts:82 `let mapped = rows.map((r) => remapRow(r, idRemap));` — nothing follows it. lib/dataRestore.ts:211-215 `if (k === "org_id" && typeof v === "string" && idRemap.orgId[v]) { out[k] = idRemap.orgId[v]; } else { out[k] = deepRemapValues(v, uidMap, orgPairs); }`. app/api/admin/restore/apply-table/route.ts:56 `if ("org_id" in m) m.org_id = orgId;`.
```

> **Verifier correction.** Exploitation requires an org Admin (RESTORE_ROLES = ["Admin"]) posting directly to the endpoint — the restore UI uses begin + apply-table (restore/page.tsx:196), so nothing reaches /apply through the app. Cross-org rows must also satisfy FK constraints in the victim org, which limits it to loosely-keyed tables (audit_logs, notifications, notes). It remains a genuine boundary gap because the sibling route declares that boundary mandatory.

**Done when.**

- [ ] apply applies the same `m.org_id = orgId` overwrite and the same `IMPORTABLE.has(table)` allowlist as apply-table
- [ ] apply and apply-table share one function so the two paths cannot diverge again
- [ ] tables with no org_id column (project_members, curated_collection_items, access_requests) are validated against a parent row in the target org before insert, since forcing org_id cannot bound them

**Resolution (2026-10-01, admin-and-org Round G).** Package P1, one commit with `ORG-1` (same mechanism; see its resolution for the reproduction on HEAD `bcbf3e8`). Both restore routes now write through `lib/dataRestore.ts applyRestoreChunk`: the export-contract allowlist (`restoreTableRefusal`), the forced org boundary (`bindRestoredRow` after `remapRow`), the archived-ticket comment filter (now a checked read — an unreadable `tickets` read fails the chunk instead of resurrecting comments), and the conflict-target upsert are one code path, so the two routes cannot diverge again. Org-less rows (Done-when 3, plan default recorded as `DEC-75`): the census of `supabase/` finds exactly two restorable contract tables with no `org_id` column — `project_members` (parent `projects` via `project_id`) and `curated_collection_items` (parent `curated_collections` via `collection_id`); `access_requests` has carried `org_id` since `20261023` (`ALTER TABLE access_requests ADD COLUMN … org_id`) and needs no parent rule. `ORG_LESS_RESTORE_PARENTS` names them; before writing, the shared function reads the parents in THIS workspace (`.in("id", …).eq("org_id", orgId)`, a checked read — an unreadable parent table fails the chunk closed) and refuses every row whose parent is elsewhere or missing, reported per row as `parent_outside_workspace` in the response and in the `RESTORE_CHUNK` audit row; nothing is invented on the row (no `org_id` column is added).
- Files: `lib/dataRestore.ts`, `app/api/admin/restore/apply/route.ts`, `app/api/admin/restore/apply-table/route.ts`.
- Tests: `lib/__tests__/restoreApplyRoute.test.ts` — "names exactly the contract tables with no org_id column (census of supabase/)" (fails when a new org-less table is added without a parent rule; `lib/__tests__/helpers/schemaKeys.ts` is the census), "a project_members row lands only under a project of THIS workspace; one under a foreign project is refused, never written", "curated_collection_items are bounded by their collection the same way, on the single-shot route too", "an unreadable parent fails the chunk closed", "the same rows land identically through /apply-table and /apply", "applyRestoreChunk itself refuses a non-contract or append-only table before any read or write".

**Done-when.**
- [x] apply applies the same `m.org_id = orgId` overwrite and the same `IMPORTABLE.has(table)` allowlist as apply-table ✓ (one function).
- [x] apply and apply-table share one function so the two paths cannot diverge again ✓ (`applyRestoreChunk`).
- [x] tables with no org_id column are validated against a parent row in the target org before insert ✓ — `project_members`, `curated_collection_items` (`access_requests` carries `org_id`; the census test proves the list is exactly the org-less restorable tables).

*Review fix pass (2026-10-01):* the parent rule is now general. `lib/dataRestore.ts RESTORE_PARENT_RULES` binds every declared FOREIGN KEY of a restorable table whose parent is org-scoped, from a census of `supabase/`. The org-less tables' bounding parents are the REQUIRED case of that rule: a NULL `project_id` / `collection_id` is refused too. See `ORG-1`'s fix-pass paragraph for the mechanism and tests.

**Scope / residual.** Until admin-and-org P2 lands `BKP-4` (parent-keyed export of the org-less tables), the export dumps both tables by `org_id`, fails, and carries them empty. In practice no backup has rows for them yet; the rule is in place for when it does. Every declared foreign key is now checked in the target workspace; columns that carry an id without a declared foreign key are not (see `ORG-1`'s residual).

---

<a id="bkp-4"></a>

## BKP-4 · Four tables in ORG_SCOPED_TABLES have no org_id column — every export is stamped INCOMPLETE and permanently drops project rosters and curated-collection contents

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/exportTables.ts:57-58`, `lib/exportTables.ts:91`, `lib/exportTables.ts:109-110`, `lib/exportTables.ts:152`, `lib/dataExport.ts:95-107`, `lib/dataExport.ts:209-218`, `lib/dataExport.ts:248`, `supabase/schema.sql:19-30`, `supabase/migrations/20260527_projects_and_collaboration.sql:55-65`, `supabase/migrations/20260602_documents_library_super.sql:63-71`, `supabase/migrations/20260819_orphan_tables_backfill.sql:16-24`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed exactly, including the count of four. project_members (project rosters) and curated_collection_items (curated collection contents) are unrecoverable customer data that no export has ever contained.

**Mechanism.** runOrgExport dumps every ORG_SCOPED_TABLES entry with `dumpTable(sb, tbl, "org_id", params.orgId)` → `sb.from(table).select("*").eq("org_id", value)`. Four listed tables have no org_id column anywhere in supabase/ (verified by a CREATE-TABLE-body + ALTER-ADD-COLUMN scan across schema.sql + all migrations, then re-verified by grepping every `org_id` mention for those table names — the only hits are comments that say so: 20260819_orphan_tables_backfill.sql:15 "access_requests (public sign-up requests; no org_id)" and 20260615_fix_missing_rls_policies.sql:31 "project_members has no org_id column directly"). They are: `orgs` (PK is `id`), `project_members` (project_id/user_id only), `curated_collection_items` (PK collection_id,document_id), `access_requests`. PostgREST answers `.eq("org_id",…)` on those with 42703 "column … does not exist"; supabase-js returns `{error}`, dumpTable throws, and the catch at lib/dataExport.ts:100-106 records `{rowCount:0, error}` and sets `tables[tbl] = []`.

**Failure scenario.** Every export ever produced has `manifest.complete === false` and note #1 "⚠ INCOMPLETE BACKUP — 4 table(s) could not be exported". Two of the four are real customer data: `project_members` (who is on each project — the roster projects_visibility_select and project_visible_to_me use to grant read of PRIVATE projects) and `curated_collection_items` (which documents are in each curated collection). A workspace restored from backup comes back with every project roster empty and every curated collection empty, and nobody can tell those apart from projects that genuinely had no members. The tripwire test at lib/__tests__/exportCoverage.test.ts only diffs table NAMES against CREATE TABLE, so it passes green while the export fails at runtime for four of them — exactly the failure mode its header comment claims to have killed ("three phantom cost_* tables marked every backup INCOMPLETE. Never again").

**Evidence.**

```
lib/dataExport.ts:97 `const rows = await dumpTable(sb, tbl, "org_id", params.orgId);` and :300 `let q = sb.from(table).select("*").range(...)` / :304 `q = q.eq(column, value as string);` / :307 `if (error) throw new Error(error.message);`. supabase/schema.sql:19-20 `CREATE TABLE IF NOT EXISTS orgs ( id UUID PRIMARY KEY …` — no org_id. supabase/migrations/20260527_projects_and_collaboration.sql:55-58 `CREATE TABLE IF NOT EXISTS project_members ( id …, project_id UUID NOT NULL REFERENCES projects(id) …, user_id UUID NOT NULL,` — no org_id.
```

**Chain reaction.** planRestore (lib/dataRestore.ts:155-157) turns `complete === false` into a permanent restore warning on every backup, training admins to click past it; and lib/clientBackup.ts never reads `manifest.complete` at all, so the UI still says "Backup complete".

> **Verifier correction.** Real and unconditional, but not silent, which is what pulls it below CRITICAL: manifest.complete goes false (lib/dataExport.ts:248), the failing table names are listed in the INCOMPLETE note (:213-214), and lib/dataRestore.ts:155-157 turns that into an explicit restore-time warning. The lost content is membership/curation metadata — documents, document_versions and their binaries are unaffected. The compounding harm is that `complete:false` fires on 100% of exports, so the flag carries no signal.

**Done when.**

- [ ] `project_members` and `curated_collection_items` are exported through their parent key (project_id → projects.org_id, collection_id → curated_collections.org_id) instead of org_id
- [ ] `orgs` is exported with `.eq("id", orgId)` and `access_requests` is moved to EXPORT_EXCLUDED_TABLES with the reason already written in its migration comment
- [ ] the coverage tripwire additionally asserts that every ORG_SCOPED_TABLES entry actually has an org_id column in the schema, so a table added to the wrong list fails the build

**Resolution (2026-10-01, admin-and-org Round G).** Package P2. Reproduced on base `2290b94`: `runOrgExport` dumped every `ORG_SCOPED_TABLES` entry with `dumpTable(sb, tbl, "org_id", …)` (`lib/dataExport.ts:103`), and three entries have no `org_id` column: `orgs` (`lib/exportTables.ts:156`), `project_members` (`:112`) and `curated_collection_items` (`:58`). The fourth the finding named, `access_requests` (`:92`), has carried `org_id` since `20261023`, as P1 recorded under `BKP-3` / `DEC-75`. The failure itself is reproduced in `lib/__tests__/exportContractRoundTrip.test.ts`, whose database stand-in answers 42703 for a filter on a column the table lacks, as PostgREST does ("the stand-in answers 42703 for a filter on a column the table lacks").

Fix: `lib/exportTables.ts EXPORT_KEYED_BY` names each such table's own key: `orgs` by `id`, `project_members` through `projects` (`project_id`), `curated_collection_items` through `curated_collections` (`collection_id`). `lib/dataExport.ts dumpOrgTable` reads a parent-keyed child with `.in(<column>, <this workspace's parent ids>)`, in chunks of 150, after its parent; `ORG_SCOPED_TABLES` lists the parent first, so it is dumped first. A parent that failed, or was not dumped, fails the child with "its parent table … was not exported, so its rows cannot be scoped to this workspace": the table is recorded as an error and never read unscoped. The restore already binds the same two children to a parent in the target workspace (P1, `ORG_LESS_RESTORE_PARENTS`), and a test pins that export and restore name the same parents.
- **access_requests (the plan's decision): kept exported, not excluded.** It has `org_id`, so the criterion's premise ("no org_id") no longer holds, and it is this workspace's data: who asked to join. This is the plan default.
- Files: `lib/exportTables.ts`, `lib/dataExport.ts`.
- Tests:
  - `lib/__tests__/exportCoverage.test.ts`, "export scope tripwire (BKP-4)": every `ORG_SCOPED_TABLES` entry has `org_id` or an `EXPORT_KEYED_BY` entry; an entry has no `org_id`, reads a real column, and its parent is org-keyed and dumped first; export and restore bound by the same parent.
  - `lib/__tests__/exportContractRoundTrip.test.ts`, "BKP-4 — …": the backup is COMPLETE; `orgs` carries only this workspace's row, and the roster and the curated contents only this workspace's rows; a failing parent fails its child; 320 parents are read in chunks with every row once. The round trip restores both tables into a fresh workspace.
  - Mutation-checked: with `EXPORT_KEYED_BY` emptied, eight of these fail.

**Done-when.**
- [x] `project_members` and `curated_collection_items` are exported through their parent key ✓.
- [x] `orgs` is exported with `.eq("id", orgId)` ✓. `access_requests` is NOT moved to `EXPORT_EXCLUDED_TABLES`: the reason the criterion gives ("no org_id") stopped being true at `20261023`, so it is exported by `org_id` like every org table (plan default; `DEC-75` records the column).
- [x] the coverage tripwire asserts every ORG_SCOPED_TABLES entry has an org_id column — or names its own key ✓.

**Scope / residual.** `manifest.complete` now carries a signal; on base it was false on every export. The chain reaction (the browser backup never read `manifest.complete`) was closed by P1 (`BKP-10`: the browser backup's report carries `complete` and the manifest notes).

*Second review fix pass (2026-10-01):* a parent whose read came up short (intelligence `ILIFE-6`: rows changed while it was read, on both reads) no longer fails its child. Before this, the review found, a short `projects` read was thrown away whole and `project_members` failed with it. Now the parent keeps the rows it read, and the child is read through those rows. The child is marked `short` too, with a reason: rows under the parent rows the reads missed are not included. Only a parent that FAILED, or was not dumped, still fails its child. Test: `lib/__tests__/exportContractRoundTrip.test.ts`, "a short PARENT still scopes its child: …".

---

<a id="bkp-5"></a>

## BKP-5 · Restore can only ADD, never repair: rows are upserted on the backup's own primary keys with ignoreDuplicates, so restoring over damaged data inserts nothing and reports success

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/restore/apply-table/route.ts:74-87`, `app/api/admin/restore/apply/route.ts:98-125`, `app/(protected)/admin/restore/page.tsx:190-216`, `app/(protected)/admin/restore/page.tsx:445-453`, `lib/dataRestore.ts:336-348`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Right as stated — restore is insert-only by construction, so corrupted rows that still hold their original ids are never touched and the run reports success. Note the failure can also read WORSE than described: `inserted += up.count ?? chunk.length` (line 81) falls back to the full chunk size if PostgREST returns no count, reporting thousands of 'imported' records that were all discarded.

**Mechanism.** Every table is written with `upsert(chunk, { onConflict: conflictTargetFor(table), ignoreDuplicates: true })` — ON CONFLICT DO NOTHING against ids taken verbatim from the backup. Ids are never regenerated and never remapped (only org_id and uids are). So any row whose id already exists is skipped, whatever its current contents. The UI sums `body.inserted` but shows a green "Records restored" panel regardless, and — unlike apply/route.ts:115-125, which explicitly STOPS after a table fails because "continuing after a parent failure inserts children referencing rows that never landed" — the chunked client path does `tableFailed = true; break;` on the chunk loop and then continues to the next table in FK order.

**Failure scenario.** A bad bulk edit or a bad AI run corrupts document metadata across a library. The admin drops last night's backup on /admin/restore, sees "5,412 records to import", clicks Restore, and gets a green "Records restored" panel — having imported 0 rows, because every id already exists. The corruption is untouched and the admin believes it was repaired. In the other direction, when `documents` fails mid-restore (e.g. the partial unique index documents_library_uniqueness_uniq trips, which ON CONFLICT (id) does not cover, and the fallback plain `insert` of the same chunk fails identically), the client keeps going and writes document_versions, project_documents, acknowledgments and audit rows for parents that never landed.

**Evidence.**

```
app/api/admin/restore/apply-table/route.ts:77 `const up = await sb.from(table).upsert(chunk, { onConflict: conflictTargetFor(table), ignoreDuplicates: true, count: "exact" });`. app/(protected)/admin/restore/page.tsx:202 `if (!res.ok) { tableFailed = true; break; }` followed by :207-208 `if (tableFailed) failedTables.push(table); tablesDone++;` — the outer `for (const table of order)` continues. app/(protected)/admin/restore/page.tsx:447 `<CheckCircle2 className="w-4 h-4" /> Records restored` renders whenever applyResult is set. supabase/migrations/20260619_document_uniqueness_configurable.sql:40-42 creates the partial unique index that ON CONFLICT (id) cannot absorb.
```

> **Verifier correction.** Trim the UI half. restore/page.tsx:445-453 does render the green "Records restored" panel whenever applyResult is set, but the same block prints `applyResult.failedTables` when non-empty ("Some tables reported issues: … re-run the restore (it's additive and safe)") — so failures are surfaced, just wrapped in success styling. The sharper statement of the harm is that a repair restore reports "Imported 0 record(s)" inside a green panel and the admin has no signal that the damaged rows were skipped rather than fixed.

**Done when.**

- [ ] the plan distinguishes rows that will INSERT from rows whose id already exists, and the UI shows both counts before and after applying
- [ ] the client aborts the remaining FK-ordered tables when a table fails, matching apply/route.ts's stated rule
- [ ] an explicit "overwrite existing rows" mode exists (or the UI states plainly that restore cannot repair modified rows), so a corruption-recovery restore is not silently a no-op

*Cross-area note (2026-09-30, intelligence Round G): intelligence `ILIFE-4` closes with this finding's criterion 2 plus `ORG-1` / `BKP-3`'s disposition of the uncalled `/api/admin/restore/apply`, and asks the result panel to state the consequence ("stopped at <table>; N tables not attempted").*

**Resolution (2026-10-01, admin-and-org Round G).** Package P1, after `BKP-12`. Plan default taken (`decisionsNeeded`): **additive-only restore with honest counts — no overwrite mode** (`DEC-75` §5). Reproduced on HEAD `bcbf3e8`: `apply-table/route.ts:89` upserted with `ignoreDuplicates: true` and reported `inserted += up.count ?? chunk.length`; the page broke only its chunk loop on a failure (`restore/page.tsx:203` `tableFailed = true; break;`) and went on to the next table; the result panel was green whenever a result existed (`:447-448`). Fix:
1. **Counts.** The shared write (`lib/dataRestore.ts applyRestoreChunk`) reports `inserted` (what `count: "exact"` says was written), `existing` (rows skipped because their key already exists — kept as they are), `uncounted` (a write the server returned no count for — unknown, never assumed written), `filtered` (comments of a ticket archived since the backup, left out by the restore's own rule — now counted, and an unreadable ticket list fails the chunk instead of resurrecting them) and `refused`; both routes return them and write them into `RESTORE_CHUNK` / `DATA_RESTORE`. A chunk that fails part-way now also leaves its `RESTORE_CHUNK` row (`failed: <error>`, with what it wrote).
2. **Before applying.** `previewChunkedRestore` (via `/apply-table` with `preview: true`, read-only, key columns only) counts, per table, the backup rows whose key already exists here — compared as they would be written (uids remapped, `org_id` bound) — against the new ones. The page runs it when the admin clicks "Check & restore", fills each table row with "N new · M already here", and the confirm dialog states both totals and that the existing ones are "KEPT EXACTLY AS THEY ARE — not overwritten, not repaired".
3. **Stop on failure.** The page's flow moved into `lib/dataRestore.ts runChunkedRestore` (the page passes `fetch`; the tests pass the real route handlers): it STOPS at the first table that fails — tables are FK-ordered, so continuing would write children of parents that never landed — and returns `stoppedAt` and `notAttempted`.
4. **Said plainly.** The result panel is red "Restore stopped at <table> — N table(s) not attempted" with the reason, amber when rows were refused, green only otherwise; it always shows "N new · M already here, kept exactly as they were"; `RESTORE_ADDITIVE_NOTE` ("A restore only ADDS records … cannot overwrite, repair or roll back a record that was changed or damaged after the backup") is on the pre-apply panel, in the confirm, and on the result when anything was kept. The old advice "re-run the restore (it's additive and safe)" is gone.
- Files: `lib/dataRestore.ts` (`applyRestoreChunk` counts, `previewRestoreChunk`, `previewChunkedRestore`, `runChunkedRestore`, `RESTORE_ADDITIVE_NOTE`), `app/api/admin/restore/apply-table/route.ts` (`preview`, counts, audit on partial failure), `app/api/admin/restore/apply/route.ts` (counts, note), `app/(protected)/admin/restore/page.tsx` (check → confirm → run; `RestoreResultPanel`).
- Tests: `lib/__tests__/restoreApplyRoute.test.ts` "BKP-5 — a restore says what it added and what it kept, before and after" — the read-only check counts existing vs new and writes nothing; after applying, a damaged row with the backup's id is reported as existing and left untouched; no count is "uncounted"; "the run STOPS at the first failed table and names the tables it did not attempt" (a `documents` 23505 leaves `document_versions` and `notes` unwritten); a part-failed chunk reports and audits what it wrote; "comments of a ticket archived since the backup are left out AND counted"; page order (check, then confirm, then run) and wording. `lib/__tests__/holds.test.ts`'s fake engine now returns the write count PostgREST reports (its assertions unchanged).

**Done-when.**
- [x] the plan distinguishes rows that will INSERT from rows whose id already exists, and the UI shows both counts before and after applying ✓ (the check before the confirm; the result after).
- [x] the client aborts the remaining FK-ordered tables when a table fails, matching apply/route.ts's stated rule ✓ (`runChunkedRestore`; the result names them).
- [x] an explicit "overwrite existing rows" mode exists (or the UI states plainly that restore cannot repair modified rows) ✓ — the second branch, by decision: the UI states it before, during the confirm, and after.

**Review fix pass (2026-10-01).** The first landing's stop rule met three things that made it stop or mislead.

1. **Restore order.** `RESTORE_TABLE_ORDER` still placed eight children before their parents:
   - `checkout_sessions.episode_id` → `checkout_episodes`
   - `libraries.owner_team_id` → `teams`
   - `documents.set_id` → `document_sets`
   - `projects.sow_document_id` → `documents`
   - `process_flows.source_document_id` and `entity_mentions.knowledge_document_id` → `knowledge_documents`
   - `milestones.linked_ticket_id` and `document_holds.origin_ticket_id` → `tickets`

   An atomic chunk with one such row fails 23503, and the base code lost only that table. With the stop rule, a fresh-workspace restore of almost any org (checkout alone is enough) stopped there and never wrote tickets, notes, companies, costs, the quality program or the knowledge library. Fixed by reordering: teams before libraries; sets before documents; projects after documents; tickets before holds and milestones; episodes before sessions; and the knowledge libraries, links, sources and documents right after the controlled documents. The knowledge move is intelligence `ILIFE-2` / I-01 phase B. A self-referencing table's rows go parents-first (`restoreRowsInOrder`). The tripwire is in `lib/__tests__/dataRestore.test.ts`: "for EVERY foreign key between two tables RESTORE_TABLE_ORDER places, the parent comes first". It runs a census of every FOREIGN KEY in `supabase/` (`lib/__tests__/helpers/schemaKeys.ts`) and lists exactly these eight against the previous order. `lib/__tests__/helpers/restoreMemoryDb.ts` now raises 23503 for declared foreign keys. `lib/__tests__/restoreArchiveRoundTrip.test.ts` restores an org that carries every relationship above, plus a sub-folder listed before its folder, into a fresh workspace with every census foreign key enforced. It runs on both routes and through the browser parts, the server ZIP and the older `data.json`, and expects no stop, no refusal and every row landed. With checkout_sessions moved back before checkout_episodes, four of its tests fail. *Corrected at the second review:* that engine enforced only the foreign keys BETWEEN restorable tables and did not model computed columns, and the seed carried no indexed knowledge, so "no stop, no refusal" held only there — see fix pass 2.
2. **One duplicate stopped the run.** `applyRestoreChunk` now bisects any statement refused for ONE row's sake (`ROW_LEVEL_SQLSTATES`, class 23: 23502 / 23503 / 23505 / 23514 / 23P01) down to the refused rows. It reports each one in `refused`, with the database's code and message (naming the constraint), and lands the rest. The table and the run go on. This replaces the `document_holds`-only HLD-9 path. A refused parent's children are refused too (23503 or `parent_outside_workspace`), never orphaned. Any other failure (a missing column, a permission, a lost connection) still stops the run. Example: a same-workspace repair restore over mentions re-indexed under new ids since the backup (`lib/mentionIndexer.ts`) now refuses the old mention rows (23505 on `(asset_id, knowledge_document_id, page)`) and carries on to tickets and notes. Tests in `lib/__tests__/restoreApplyRoute.test.ts`:
   - "a mention colliding on its second unique key is refused (23505) while the rest of its chunk lands";
   - "a same-workspace repair restore no longer stops at a re-indexed mention";
   - "the child of a refused row is refused too (23503)".
3. **"Already here" counted the whole deployment.** The preview probed id-keyed tables with no org filter, and the write counted every skipped row as kept, so an Admin restoring org A's backup into org B, while A still existed, saw "5,412 already here, kept exactly as they were" under a green "Records restored", with B empty. Now `locateRestoreKeys` reads `org_id` with the key (for an org-less table, the bounding parent's workspace) and splits skipped keys into `existing` (kept, in this workspace) and `heldElsewhere` (NOT restored: the id is in use by another workspace on this deployment). Both the preview and the write report the split, as do the `RESTORE_CHUNK` / `DATA_RESTORE` audit rows and the `/apply` note. The write reads only after a statement skipped rows; an unreadable split is "uncounted", never "kept". On the page:
   - The confirm, the stat tile and the per-table line say how many records "will NOT be restored" (`RESTORE_HELD_ELSEWHERE_NOTE`).
   - The result panel is red when the run stopped or any id is held elsewhere, and amber when rows were refused or nothing new was written ("Nothing new was restored").
   - "Records restored" is the title only for a run that wrote something, met no held id and stopped nowhere.
   - Refusal codes are shown as reasons (`restoreRefusalLabel`).

   The composite-key check now filters on EVERY key column and pages until an empty page. Before, it probed one column with no paging, so a server row cap undercounted. A request that never gets an answer (a dropped connection) stops the run with what was written, the stop, the tables not attempted and the org map "Put the files back" needs. Before, it threw everything away. Tests in `lib/__tests__/restoreApplyRoute.test.ts`:
   - "before and after: the preview, the chunk, the run totals and the audit row separate held-elsewhere from kept-here";
   - "a backup restored beside its still-live source org: every id is held elsewhere — 0 inserted";
   - "an org-less row belongs to the workspace of its bounding parent";
   - "the page never says 'already here' for them and never paints such a run green";
   - "10,000 matching favorites under a 1,000-row cap … existing is exact";
   - "a request that never gets an answer stops the run, keeping what was written".

**Review fix pass 2 (2026-10-01).** The second review found that the restore still stopped for most real orgs, and that the round trip above passed only because its engine modelled neither cause.

1. **Computed columns stopped the run (blocker; a regression of this package).** The export dumps every table with `select("*")` (`lib/dataExport.ts:315`), so every `knowledge_chunks` row carries `tsv` and every `knowledge_questions` row `search_tsv`, both `GENERATED ALWAYS … STORED` (`20261007_rag_hardening.sql:33-37`; `20260806_intelligence_layer.sql:72-74`, `20261123_intel_roundG_knowledge_questions_order.sql:27-29`). Postgres refuses any value for such a column with 428C9. That is not a class-23 code, so the stop rule halted the run at `knowledge_chunks` for any org with an indexed knowledge document, and `knowledge_page_entities`, `knowledge_questions`, `output_templates` and `output_generations` were never attempted; the base restored three of those four. Fix: `lib/dataRestore.ts RESTORE_GENERATED_COLUMNS` (`knowledge_chunks: ["tsv"]`, `knowledge_questions: ["search_tsv"]`); `landRestoredRow` leaves them out of every restored row, so the database recomputes them. The census (`lib/__tests__/helpers/schemaKeys.ts`) now collects `GENERATED ALWAYS` columns (a stored expression or an identity), and `lib/__tests__/dataRestore.test.ts` "every GENERATED ALWAYS column of a restorable table is in RESTORE_GENERATED_COLUMNS, and every entry is one" fails on a new one. `lib/__tests__/helpers/restoreMemoryDb.ts` now refuses a value for a declared computed column with 428C9, as Postgres does.
2. **A restored placeholder has no profile (major; not a regression — the base lost these rows too, but this record claimed otherwise).** `users.id` references `auth.users` (`supabase/schema.sql:35`), so the profile `/begin` and `/apply` upsert for a placeholder uid is always refused (23503), and it was swallowed (a `try … catch` around a call that returns `{ error }`). `teams.created_by`, `team_members.uid` and `team_members.added_by` reference `users` (`20260707_teams.sql:14, 21, 24`). So a team created by anyone not linked by email was refused 23503, and the parent rule then refused every library it owned, their documents and versions, and every project whose SOW was one of those documents. Fix:
   - `RESTORE_USER_REFERENCES` names those three columns (`required` exactly when the column is NOT NULL; a census test derives every foreign key onto `users` / `auth.users` from `supabase/` and fails on a new one).
   - Before the write, `applyRestoreChunk` reads `users` for every uid they name. A uid with no profile is CLEARED from a nullable column: the row lands and the column is reported in a new per-row `cleared` list. A team membership naming one is refused (`person_not_restored`: "re-invite the person, then add them again"). An unreadable `users` read fails the chunk closed.
   - `/begin` and `/apply` now count refused profiles (`placeholderProfile`): `placeholdersWithoutProfile` is in the response, the `/begin` warnings, the `RESTORE_BEGIN` / `DATA_RESTORE` audit rows, the `/apply` note and the result panel. (`app/api/admin/restore/begin/route.ts` is document-control P10's file, merged in the base; the edit is these lines only.)
   - Two nullable `ON DELETE SET NULL` pointers that confer no access are CLEARED instead of refusing their row when their parent is not a row of the workspace (`RestoreParentRule.clearWhenMissing`): `libraries.owner_team_id` (without it the library's ownership falls to the controllers, `lib/ownership.ts` — narrower) and `projects.sow_document_id`. One refused team or document no longer refuses everything under it. Every other pointer still refuses: `documents.collection_id` is SET NULL too, but a document's folder carries its ACL, so clearing it would land the document at the library root, wider than the backup. A test pins the set and requires each to be a nullable SET NULL key in the census.
   - The engine models `users.id REFERENCES auth.users` (`authUsers`), and the round trip enforces the foreign keys onto `users` too.
3. **Counts the admin sees.**
   - A row the parent, person or storage-key rule would refuse or clear, whose key is already held (here or by another workspace), is never written either way. `applyRestoreChunk` now locates those rows' keys and counts them `existing` / `heldElsewhere`, not refused or cleared (one read, only when a row is flagged; on a read failure the refusals stand, each true of the row as sent). A same-workspace repair restore no longer reports present assets as "pointing outside the workspace".
   - The result panel: "Nothing new was restored" needs zero inserted AND zero uncounted. Uncounted writes get their own amber title ("Restored — N record(s) the server did not count"). Cleared pointers are listed per table and turn the panel amber.
4. **The round trip now carries both causes.** `lib/__tests__/restoreArchiveRoundTrip.test.ts` seeds indexed knowledge (chunks with `tsv`, page entities, questions with `search_tsv`), output templates and generations after them, and a team CREATED BY a placeholder that owns the library everything else hangs off. The engine enforces every census foreign key between restorable tables and onto `users`, and refuses computed columns. All four paths (browser parts, server ZIP, single-shot `/apply`, older `data.json`) land every row. The only outcomes are the placeholder's own: its team membership is refused (`person_not_restored`), and the team's creator and one adder are cleared. Checked by mutation: with `knowledge_chunks` taken out of `RESTORE_GENERATED_COLUMNS`, 4 of its tests fail (the run stops at `knowledge_chunks`); with the users read removed, 4 fail (`teams` refused 23503). Route tests in `lib/__tests__/restoreApplyRoute.test.ts`:
   - "the review's run: chunks and questions carrying tsv / search_tsv land, and the tables after them are attempted (both routes)";
   - "a team created by a placeholder lands with its creator cleared — and its library, document and version land after it";
   - "the users read failing fails the chunk closed";
   - "/begin no longer swallows the refused profile";
   - "an owner team or SOW document that is not here is CLEARED (reported), never cascaded; a folder is not — it carries an ACL";
   - "a same-workspace repair restore: assets naming a type re-created under a new id are present here — counted existing, not refused";
   - "the result panel never says 'nothing new' over writes the server did not count".
5. **Intelligence `ILIFE-5`'s restore handoff is met** ("The key and a restore", `audit-reports/intelligence/18-lifecycle.md`; the RESTORE note in `20261122_intel_roundG_ingest_integrity.sql`'s header; `DEC-58`'s Risk line). A `knowledge_documents` mirror whose `source_document_id` names no restored document is refused per row by the parent rule (`knowledge_documents.source_document_id>documents`) with `parent_outside_workspace`. Its chunks, page entities and mentions are refused after it, and the rest of the knowledge layer and the output tables restore; the run does not stop. Test: "intelligence ILIFE-5: a knowledge mirror whose controlled document is not restored is refused per row; its chunks follow it; the run goes on". The intelligence integrator can close that item by pointer here.
6. **Handoff to admin-and-org P2 / projects J11 (the export files are not P1's).** The export could leave computed columns out too. Suggested hunk: an `EXPORT_COMPUTED_COLUMNS` map in `lib/exportTables.ts` beside `REDACT_COLUMNS` (`knowledge_chunks: ["tsv"]`, `knowledge_questions: ["search_tsv"]`), dropped in `redactRow` (`lib/dataExport.ts dumpTable`). The restore strips them regardless, so backups already written keep restoring.

**Review fix pass 3 (2026-10-01).** The third review found that the re-run this package tells the Admin to make duplicated rows, and that a cleared pointer could be reported for a row that was never written.

1. **A re-run minted a second set of placeholders (major).** The stop panel says "Fix the cause and run the restore again — rows already restored are skipped, not duplicated" (`app/(protected)/admin/restore/page.tsx:552`), and the bisection budget's refusal says "run the restore again to retry them" (`lib/dataRestore.ts:1300`). A re-run calls `/begin` again. `/begin`, `/apply` and the page's own plan linked backup people by email to ACTIVE members only (`begin/route.ts:48`, `apply/route.ts:54`, `page.tsx:146` before this pass). The placeholders a first run creates are `inactive`, and `org_members_org_email_active_unique_ci` (`20261018_identity_email_unique.sql:83-85`) covers active rows only. So every re-run inserted another inactive placeholder for each person not linked by email, and remapped that person's old uid to a NEW uid. Every row keyed by a uid then had a new key and landed a second time: `document_favorites (user_id, document_id)` and `recently_viewed_docs` (a `BKP-12` table). One person's rows were split across two placeholder uids. `BKP-12`'s re-run test froze the uid map and never called `/begin` twice, so it could not see this. Fix:
   - `lib/dataRestore.ts RESTORE_LINK_MEMBER_STATUSES` lists `active`, `invited`, `suspended` and `inactive`: every status `org_members.status` can hold (`supabase/schema.sql:67`, `types/schema.ts MemberStatus`).
   - `/begin`, `/apply` and the page read members of those statuses (`.select("uid, email, status") … .in("status", [...RESTORE_LINK_MEMBER_STATUSES])`).
   - `planRestore` links an address to its member of any status. When one address holds several rows, the active one wins, then invited, suspended and inactive, then the first row read.
   - Linking creates nothing and changes nothing about the member row: a placeholder stays inactive, and a suspended member stays suspended. `UserReconcileItem.linkedStatus` carries the member's status, and the page's reconciliation list shows "re-link (inactive)" for a placeholder.
   - A re-run now answers the first run's uid map and creates no member. No uid-keyed row lands twice, so the stop panel's sentence holds. *Qualified at the fourth review:* this held only while the member read and every placeholder insert succeeded, and neither was checked until fix pass 4.
2. **A clear was reported for a row never written (minor).** `applyRestoreChunk` pushed each clear note while it built the rows to write. A row the database then refused (23505 on a second unique key) was reported in `refused` AND in `cleared`, counted in `totalCleared`, and listed by the panel as "restored with a pointer cleared". A chunk that failed outright returned its clears too, and the route audited a `RESTORE_CHUNK` row for them. Now each note stays with its row and is emitted only when the database accepts the statement carrying that row. A refused row is in `refused` only. A statement that fails the chunk reports no clear for its rows; clears from statements already accepted stay. *Qualified at the fifth review:* an accepted statement can still skip a row (ON CONFLICT DO NOTHING), and a statement with no count says nothing about its rows; both still reported the clear until fix pass 5.
3. **Tests** (`lib/__tests__/restoreApplyRoute.test.ts`):
   - "/begin twice: one placeholder per person, and the second answers the SAME uid map with nothing created";
   - "the page's driver run twice (the stop panel's advice): favorites and recents are not duplicated, and the person is one member" (the real `/begin` + `/apply-table`, with the plan built the way the page now builds it);
   - "the single-shot /apply run twice: the same";
   - "one address with several rows links the active one first; a row given no status counts as active";
   - "every status a membership can hold links (types/schema.ts MemberStatus), and both routes and the page read them";
   - "a cleared row the database then refuses (23505) is in refused only; its neighbour lands and is the one clear reported" (chunked, driver totals and single-shot);
   - "a cleared row refused alone (one-row chunk) reports no clear, and leaves no 'pointer cleared' audit";
   - "a statement that fails the chunk outright reports no clear for rows it never wrote — and leaves nothing to audit".

   Checked by mutation. With the two routes reading active members only, the four re-run tests fail. With clears emitted before the write, the three clear tests fail.

**Review fix pass 4 (2026-10-01).** The fourth review found that the reads and writes fix pass 3's re-run safety rests on were unchecked.

1. **The member read (major).** `/begin` and `/apply` read the workspace's members with `const { data: memberRows } = …` and ignored `error`; the page and `/preview` did the same. On a failed read, `current` was empty, so every backup person was planned `new`. `/begin` then inserted an inactive placeholder for every address, active members' included (`org_members_org_email_active_unique_ci` covers active rows only, so nothing refused them), and remapped every backup uid to a dead placeholder uid. Owner and checkout columns then landed naming placeholders, real people's team memberships were refused (`person_not_restored`), and favorites and recents landed under the dead uids. The additive restore can never repair those rows, and a later run with a working read lands the uid-keyed rows a second time under the real uid. Fix: `/begin` (`app/api/admin/restore/begin/route.ts`) and `/apply` destructure the read's `error`, and the org-name read's too, and answer **500** "Could not read this workspace's members (…) — nothing was written." before the rename and any placeholder or audit row. The page throws the same message into its error banner and shows no plan. `/preview` (`app/api/admin/restore/preview/route.ts`) answers 500 and no plan.
2. **A failed placeholder insert was swallowed (minor).** `if (!error) { … }` had no else branch, so the person's backup uid stayed out of the uid map and every row naming them landed naming that raw uid. That uid may belong to a live person of another workspace on the deployment, in owner, checkout and notification columns and in a `team_members.uid` (which passes the person check, because that uid has a profile). Since fix pass 3, a re-run links the placeholders a run made, so failing closed is safe. `/begin` and `/apply` now stop at the first failed insert, before any table is written. They answer **500** naming the address and how many placeholders were made before it ("a re-run links them, never duplicates them"), and record the stop in `RESTORE_BEGIN` / `DATA_RESTORE` (`failed`). `/begin` answers no uid map, so the page's driver throws and never reaches `/apply-table`.
3. **The rename is checked (minor).** A refused org-name update answers 500 "Could not apply the backup's workspace name (…) — nothing was written." before any placeholder. Both audit rows record `orgNameApplied`, where they recorded only the choice.
4. **`/preview` reconciled against active members only (minor).** Nothing calls it, but it now reads members of every `RESTORE_LINK_MEMBER_STATUSES` status, as `/begin`, `/apply` and the page do. The fix-pass-3 pin test now covers all four files and requires each to check the read.
5. **A chunk that failed after a count-less accepted statement left no trail (minor; `ALOG-8`).** `/apply-table` skipped its `RESTORE_CHUNK` row whenever `inserted`, `refused` and `cleared` were all zero, but a statement accepted without a count may have written its rows (`uncounted`). The condition now also requires `uncounted` to be zero.
6. **Tests** (`lib/__tests__/restoreApplyRoute.test.ts`, "BKP-5 / BKP-12 (fix pass 4)" and "ALOG-8 (fix pass 4)"):
   - "/begin: the member read failing answers 500 before the rename, any placeholder or any audit row";
   - "/apply: the same — no placeholder, no table, no audit; and the page's driver stops at /begin with that message";
   - "the workspace-name read failing is refused the same way";
   - "/preview reads members of every status … and refuses an unread list";
   - "/begin: a placeholder that cannot be made answers 500 naming the address — the run never reaches a table; a re-run links what was made";
   - "through the page's driver: the run stops at /begin — no table is attempted, nothing lands naming the raw backup uid";
   - "/apply: a placeholder that cannot be made stops before any table, and the DATA_RESTORE row records what was made and why it stopped";
   - "a refused rename answers 500 before any placeholder (both routes); an applied one is recorded as applied";
   - "statement 1 accepted without a count, statement 2 refused: 500 with uncounted, and a RESTORE_CHUNK row records both", and "a chunk whose only statement failed still leaves nothing to record".

   Checked by mutation, each against the two test files. With the read check removed, 4 tests fail on `/begin` and 2 on `/apply`. With a placeholder failure swallowed again, 2 fail on `/begin` and 1 on `/apply`. `/preview` reading active members only fails 2, and dropping `!uncounted` fails 1.

**Review fix pass 5 (2026-10-01).** The fifth review found that the uid map still left backup uids out, and four smaller gaps in the honest counts.

1. **Two kinds of backup member were never mapped (major).** `planRestore` kept the first backup `org_members` row per address and skipped rows with no address, so their uids never entered the map. The export carries members of every status, and `20261018` allows an inactive historical row beside a re-added one under a new uid, so one person commonly has two backup uids. Rows naming the second uid landed naming it raw: a wrong owner or assignee shown to users, a team membership refused on a fresh deployment though the person was linked, and on the same deployment a uid that is no member of this workspace. Fix (`ORG-1` fix pass 5 has the detail): every other row of an address is an alias mapped to the same person, on both routes and the page's driver; a member with no address links by uid to this workspace's member under it, or is listed as unmapped (plan warning, `unmappedMembers`), and every row naming them is refused (`person_not_mapped`).
2. **The single-shot `DATA_RESTORE` row dropped `uncounted` and `filtered` (minor; `ALOG-8`).** Its per-table entries carried only inserted, existing, heldElsewhere, error, refused and cleared, so under a server that returns no count a table whose 500 rows were accepted was recorded as `inserted: 0`. The entries now carry `uncounted` and `filtered`, the details `totalUncounted` and `totalFiltered`, and the response both totals and a note sentence for each. This is the `/apply` twin of fix pass 4's `/apply-table` fix.
3. **A numbering counter kept as it was handed out restored numbers again (minor).** `ticket_number_counters (org_id, year)` restores additively, so a counter this workspace already held was kept. Restored tickets keep their `{ORG}-DDRT-YY-NNNN` numbers and `tickets.ticket_id` is not unique, so after five requests filed here and 150 restored, `next_ticket_number` handed out 0006 to 0150 a second time. `library_numbering` (`next_number`, read by `issue_document_number`) has the same shape for document numbers. Fix: `lib/dataRestore.ts RESTORE_COUNTER_COLUMNS` names both counters. After its rows are written, `applyRestoreChunk` reads this workspace's counters for the restored keys and raises each to the backup's value when that is higher, with a guarded update (`.lt(counter, value)`) that can never lower it or change any other column. A counter that cannot be read or raised fails the chunk, so the run stops before the records numbered from it. The raise is counted (`advanced`) in the chunk response, `RESTORE_CHUNK`, the `/apply` table entries and totals, the driver's `totalAdvanced` and the result panel. The backup's own counter is the bound: it is the last number the backup's workspace issued, which covers every restored record of a consistent backup.
4. **The page asked with a stale plan after a stopped `/begin` (minor).** After fix pass 4's stop, the page kept the plan made at drop time and offered "Check & restore" again. The confirm then said "2 restored placeholder user(s) will be created" while `/begin` linked the one already made and created one. `applyRestore` now plans again from the same checked reads (`readAndPlan`) before the check, the confirm and the run, and uses that plan for all three.
5. **A clear was reported for a row the database skipped (minor).** Fix pass 3 emitted a row's clear when its statement was accepted. A statement that skipped some rows (ON CONFLICT DO NOTHING, a copy of a row sent earlier in the request) or reported no count still reported the clear for every row in it. Now a clear is reported for every row of a statement that wrote them all. In a statement that skipped some, it is reported for a row whose key no earlier row of the request carried; a cleared row's key was held by no row when the keys were read before the write, so that row was written. A statement with no count reports none, and its rows are `uncounted`.
6. **Tests** (`lib/__tests__/restoreApplyRoute.test.ts`, 17 new, under "(fix pass 5)"; `lib/__tests__/dataRestore.test.ts`, 2 new):
   - "the plan maps both rows of one address to the same person; the active row speaks for them";
   - "the review's run (page driver): a document owned by the second uid lands owned by live-bob, and Bob's team membership lands";
   - "a new person with two rows: ONE placeholder, both uids map to it (/begin and /apply), and a re-run links it";
   - "a backup member with no email address and no member here is unmapped: the plan says so and every row naming them is refused (both routes)";
   - "restored into the workspace that still holds them, a member with no address is linked by uid — nothing is refused";
   - "every route and the page pass members with no address to the planner (they link by uid)";
   - "a count-less server: the per-table entry and the totals say uncounted, never 'inserted 0' alone" and "comments of an archived ticket left out by the filter are counted in the trail too" (single-shot);
   - "the review's run: five requests filed here, then 150 restored — the next number is 151, not 6 (all three paths)", "a library's document counter the same way; nothing but the counter changes", "a counter that cannot be advanced stops the run before the records numbered from it", and a pin of the two counters to the functions that write them;
   - "a /begin stopped after one placeholder: the fresh plan counts one new person, and /begin then creates exactly one" and "the page's apply re-plans from a checked read before the check, the confirm and the run";
   - "the same row twice in a chunk: one lands, DO NOTHING skips the copy — one clear, and the copy counted existing", "a server that gives no count: the rows are uncounted, and no clear is claimed for them", and "a clear for a row in a statement that wrote every row is still reported";
   - in `dataRestore.test.ts`: "every backup uid is mapped once — aliases of a linked person, a uid under two addresses given to the first, junk rows ignored" and "a member with no address and no member here under that uid is unmapped".

   Checked by mutation against the two test files: without the alias map 3 tests fail; without `created[alias]` 2 fail on `/begin` and 2 on `/apply`; without the `person_not_mapped` refusal 1 fails; without the uid link 1 fails; without the counter raise 3 fail; with both counter guards removed (so a counter can be lowered) 2 fail; with clears emitted for every row of an accepted statement 2 fail; without `uncounted` / `filtered` in the `/apply` entries 2 fail; with the page using the drop-time plan 1 fails. With only the in-app guard removed, the guarded update still refuses to lower the counter, and no test fails.

**Review fix pass 6 (2026-10-01).** The sixth review found four minor gaps in what fix pass 5 claimed and told the Admin.

1. **"A counter that cannot be read or raised stops the run before the records numbered from it" held only for ticket numbers.** `ticket_number_counters` sat before `tickets` in `RESTORE_TABLE_ORDER`, but `library_numbering` sat after `documents`. The review reproduced it through the real `/begin` and `/apply-table`: with `lib-1` at `next_number` 3 here and a backup carrying document `P-0041` and `next_number` 42, a raise refused with 42501 stopped the run at `library_numbering` with `P-0041` already written and the counter still at 3, so `issue_document_number` would hand out `P-0003` onward toward `P-0041` again. Fix: `library_numbering` now restores right after the libraries and collections, before `documents` (its only org-scoped foreign key is `library_id > libraries`, so the FK-order census stays green). A new `lib/dataRestore.ts RESTORE_COUNTER_NUMBERS` names the table each counter numbers, and a test holds each counter before it.
2. **The confirm and `RESTORE_ADDITIVE_NOTE` still promised "kept exactly as it is" for every existing record.** Since fix pass 5 an existing counter row is raised, and only the result panel said so. `RESTORE_ADDITIVE_NOTE`, which the confirm, the pre-run panel and the result panel all show, now names the one exception: a ticket or document numbering counter is raised (never lowered) to the backup's value so no number is issued twice. The confirm's "KEPT EXACTLY AS THEY ARE" sentence points at it, and the `/apply` note says the same.
3. **The trade-off behind the raise was not recorded.** Item 3 of fix pass 5 said the counter "handed out 0006 to 0150 a second time". That holds only when the backup's ticket prefix matches this workspace's. The raise is unconditional, but `orgs.ticket_prefix` is never restored (and an existing `library_numbering` row keeps its `prefix`). Restoring an `ACME-DDRT-26-0001..0150` backup into a workspace that has issued `KE-DDRT-26-0001..0005` raises its counter to 150, so its next ticket is `KE-DDRT-26-0151`: a gap of 145, where no duplicate was possible. A gap is preferred to a number issued twice. This is now recorded here, in `DEC-75` §5, in the `RESTORE_COUNTER_COLUMNS` comment, in `RESTORE_ADDITIVE_NOTE` and in the result panel's "numbering counter(s) advanced" line. No code change was needed.
4. **A team membership naming an unmapped member was refused with the wrong remedy.** See `ORG-1` fix pass 6: `person_not_mapped` is now reported ahead of `person_not_restored`.
5. **Tests** (`lib/__tests__/restoreApplyRoute.test.ts`, 3 new and 1 extended):
   - "fix pass 6 — the twin for a library's document counter: the run stops before the documents numbered from it" (the review's run, on the page's driver and on `/apply`);
   - "fix pass 6 — every counter table is restored before the table it numbers (RESTORE_TABLE_ORDER)";
   - "fix pass 6 — what the Admin consents to names the counter exception, and the gap trade-off";
   - the unmapped-member test now carries a team membership and asserts `person_not_mapped` on both routes.

   Checked by mutation: with `library_numbering` back after `documents`, 2 tests fail; with the old refusal order, 1 fails.

**Scope / residual.** No repair mode: recovering a corrupted row means editing it, or restoring into an empty workspace (`DEC-75` §5 reversal). *Corrected at the second review:* the first fix pass said the empty-workspace route "works again". It did not for any org with indexed knowledge (428C9 stopped the run), and it lost every team a placeholder created and all that team owned. Both are fixed in fix pass 2. A fresh-workspace restore still does not bring back a placeholder's team memberships (re-add them after the person accepts), nor the team creator / adder fields that named a placeholder (cleared). A row naming a refused parent through any pointer other than the two cleared ones is refused after it (reported). A row that collides on a SECOND unique key is refused and reported (23505) while the rest lands; it is not merged with the live row it duplicates. Intelligence `ILIFE-10`'s business keys and its `is_explicit` pre-filter are not built (see `BKP-12`). "Put the files back" is still offered after a stopped run: the records that landed may need their files. Intelligence `ILIFE-4` can close by pointer: criteria 1 and 3 here, criterion 2 by `ORG-1` (`/apply` is kept as the small-backup path and shares the write and the stop rule). *Corrected at the third review:* the re-run safety this record and the stop panel claimed ("rows already restored are skipped, not duplicated") held only with a frozen uid map. A re-run through the page minted new placeholder uids and landed every uid-keyed row again. It holds since fix pass 3, because a re-run links the placeholders the first run created. *Corrected at the fourth review:* that held only while the member read and every placeholder insert succeeded, and the residual named here understated the failed insert. An unmapped person's rows did not just wait for a later run. They landed naming the raw backup uid, which may be a live person of another workspace on the deployment, in owner, checkout and notification columns and in a team membership. Both are closed in fix pass 4: a failed read, rename or placeholder insert stops `/begin` and `/apply` before any table is written, and a re-run links the placeholders already made. What the stop leaves behind is the placeholders made before the failure and, if chosen, the backup's workspace name. Both are recorded in the audit row and kept by the re-run. *Corrected at the fifth review:* fix pass 4's records said every person in the backup is mapped before any row is written. A second membership row of one address and a member with no address were never mapped, and rows naming them landed with the raw backup uid; fix pass 5 maps the first and refuses the rows of the second. One restore now changes an existing row: a numbering counter this workspace holds is raised to the backup's value when that is higher, never lowered (`DEC-75` §5). Still open: a uid in no row of the backup's membership list (someone removed before the backup) lands as it is (`ORG-1` residual). A new numbering counter needs a `RESTORE_COUNTER_COLUMNS` entry, and no census finds one. A concurrent write of the same key during a restore can make a reported clear wrong. A `/begin` that stops leaves the drop-time plan's warnings on screen until the Admin applies again. *Corrected at the sixth review:* fix pass 5 said a counter that cannot be raised stops the run before the records numbered from it; that held for tickets only until fix pass 6 placed `library_numbering` before `documents`. Also still open: a restore into a workspace whose ticket or library prefix differs from the backup's skips the numbers the backup issued (a gap, never a duplicate).

---

<a id="bkp-6"></a>

## BKP-6 · Retention pruning deletes every object older than N days under the prefix — with no prefix set, that is the customer's entire bucket

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/exportRunner.ts:257-265`, `lib/exportRunner.ts:374-405`, `app/(protected)/admin/data-export/page.tsx:664-666`, `app/(protected)/admin/data-export/page.tsx:605`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: nothing constrains the purge to keys this app wrote — not the filename pattern, not a prefix requirement, not a marker object. With Prefix blank, retention deletes unrelated objects in the customer's bucket.

**Mechanism.** After a successful push, s3PurgeOlderThan lists the destination bucket and deletes everything older than retention_days. `Prefix: params.prefix ? params.prefix.replace(...) + "/" : undefined` — an unset prefix means `undefined`, i.e. list the WHOLE bucket. Nothing filters on the export filename pattern (`manufacturing-os-export-…zip`) or on object metadata, so any object living in that bucket is a deletion candidate. The prefix field is optional in the UI ("Prefix — Optional folder inside the bucket").

**Failure scenario.** An admin points a destination at an existing company bucket without filling in Prefix and sets retention to 30 days — the UI hint says "Delete older exports in your bucket". On the first scheduled push, every object in that bucket older than 30 days is deleted in 1000-key batches: unrelated backups, archives, anything. The error is swallowed by `.catch((e) => step("s3:retention:err", …))` so the run still reports succeeded, and the deletions are attributed to a system the customer trusted with write access to their own storage.

**Evidence.**

```
lib/exportRunner.ts:386 `Prefix: params.prefix ? params.prefix.replace(/^\/+|\/+$/g, "") + "/" : undefined,` and :389-393 `for (const obj of out.Contents ?? []) { if (obj.Key && obj.LastModified && obj.LastModified < cutoff) { toDelete.push({ Key: obj.Key }); } }` — no name test. app/(protected)/admin/data-export/page.tsx:664 `<Field label="Retention (days)" hint="Delete older exports in your bucket">`.
```

> **Verifier correction.** None. Note for the fix: the failure is swallowed too — the call is `.catch((e) => step("s3:retention:err", …))` at :264, so a partially-failed purge still records the run as succeeded.

**Done when.**

- [ ] retention only deletes keys matching the export filename pattern this system wrote (`manufacturing-os-export-*.zip`), or objects it tagged at PutObject time
- [ ] a non-empty prefix is required before retention_days can be set, and the UI states plainly that objects under that prefix will be deleted
- [ ] retention failures and deletion counts are surfaced on the run row instead of only in diagnostics

**Verification on `f1ac550` (2026-10-02, admin-and-org Round G, P0; superseded by P3's resolution).** A dated record of what base `f1ac550` showed (DEC-29), not a status. admin-and-org P3 owns this finding's residual ("BKP-6 residual") and ran in parallel, so its branch may already have changed the page and the run row. Where P3's resolution of this finding is present, it is the finding's status; this block only records the base it started from.

- **Done-when 1, on `f1ac550`: met, by document-control `XEDGE-4`** (Phase 6, commit `d82254a`). `s3PurgeOlderThan` refuses an empty or slashes-only prefix before any bucket call (`lib/exportRunner.ts:501-507`) and lists only under `prefix + "/"` (`:516`). A key becomes a deletion candidate only when it is older than the cutoff AND matches `EXPORT_ARCHIVE_RE = /(^|\/)manufacturing-os-export-[\w.\-]+\.zip$/` (`:489`, `:521-522`). A customer's `vendor-drawings-2019.zip` is never a candidate, whatever its age. Pinned by `lib/__tests__/destructiveDeletes.test.ts` "s3PurgeOlderThan (XEDGE-4)": zero bucket calls on `""` and on `"///"`, and the pattern matches only this app's archives.
- **Done-when 2, on `f1ac550`: the server half was in place.** Both destination routes refused `retention_days > 0` with an empty prefix: create at `app/api/data-export/destinations/route.ts:101-109`, and PATCH, checked against the resulting row, at `[id]/route.ts:66-82`.
  - The page at that commit: `app/(protected)/admin/data-export/page.tsx:606` labelled Prefix "Optional folder inside the bucket", and `:665` hinted Retention as "Delete older exports in your bucket". The page did not require the prefix before retention could be set, and did not say that this app's export archives under that prefix would be deleted; an admin learned it from a 400.
  - admin-and-org P3's file list names "app/(protected)/admin/data-export/page.tsx (prefix required before retention_days)".
- **Done-when 3, on `f1ac550`: counts and failures were in diagnostics.** The runner wrote `step("s3:retention:done", "scanned N, deleted M app archive(s)")`, or `step("s3:retention:err", …)` on a refusal or failure, into diagnostics only (`lib/exportRunner.ts:364-375`). The run recorded success either way, and `export_runs` had no retention column. admin-and-org P3's file list names "lib/exportRunner.ts (retention deleted/failed counts on export_runs)".

No code changed in this package. What remained on `f1ac550` (the page's prefix requirement and copy, and the counts on the run row) is P3's, and P3's resolution records what landed.

---

<a id="bkp-7"></a>

## BKP-7 · The "Full ZIP with binaries" the export page produces cannot be read by the restore page — two admin pages emit two incompatible archive formats

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/clientBackup.ts:117-145`, `app/(protected)/admin/data-export/page.tsx:136-143`, `app/(protected)/admin/restore/page.tsx:111-125`, `lib/exportRunner.ts:132-162`, `app/(protected)/admin/storage/page.tsx:738-762`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Two admin pages emit two archive layouts and only the storage page's is loadable by /admin/restore. Confirmed by reading both writers and the reader.

**Mechanism.** Two producers, one consumer. The browser backup (lib/clientBackup.ts, wired to the "Download Full ZIP" button on /admin/data-export) writes `data.json` (the whole envelope), `files-manifest.json`, `backup-report.json` and `files/<key>` — it never writes `manifest.json` or `tables/*.json`. The server ZIP (lib/exportRunner.ts, reachable only from /admin/storage's separate ZIP button) writes `manifest.json` + `tables/<table>.json` + `files/<key>`. /admin/restore accepts ONLY the second: it searches entries for `/(^|\/)manifest\.json$/i` and aborts otherwise. "files-manifest.json" does not match that regex (no `/` before `manifest.json`).

**Failure scenario.** An admin follows the Data Export page — the page the public /data-portability commitment links to — runs "Download Full ZIP", archives the parts offsite, and months later drops part1 on /admin/restore. It is rejected with "No manifest.json — this doesn't look like a manufacturing-os backup ZIP." Extracting data.json by hand and dropping that restores records, but `zipRef.current` stays null so the "Put the files back" step never appears — the binaries in the ZIP can never be re-uploaded through the UI. The one format that IS restorable is built entirely in one serverless function's RAM (lib/exportRunner.ts:173 `MAX_EMBED_BYTES … 1_500_000_000`, route maxDuration 300s) — the exact limitation lib/clientBackup.ts:1-15 says made the server path "hang forever and deliver nothing" for real document sets.

**Evidence.**

```
lib/clientBackup.ts:124 `zip.file("data.json", JSON.stringify(envelope, null, 2));` and :128 `zip.file("files-manifest.json", …)`. app/(protected)/admin/restore/page.tsx:113-114 `const manifestPath = entryNames.find((p) => /(^|\/)manifest\.json$/i.test(p)); if (!manifestPath) throw new Error("No manifest.json — this doesn't look like a manufacturing-os backup ZIP.");` and :117 `entryNames.filter((p) => /(^|\/)tables\/[^/]+\.json$/i.test(p) …)`. A repo-wide grep for `manifest.json|data.json|backup-report` shows exportRunner.ts:134 as the only writer of `manifest.json`.
```

**Chain reaction.** Because the restorable format is only produced by a 300s/1.5GB serverless path, an org large enough to need a backup is exactly the org that cannot produce a restorable one.

> **Verifier correction.** Overstated only in reach. The restore page also accepts a plain .json envelope (page.tsx:100-101,126-129), and the browser ZIP's data.json IS exactly that envelope — an admin who unzips part1 and drops data.json restores every record. What is genuinely unreachable through the UI is the binaries: the put-files-back step (page.tsx:224-259) runs off zipRef, which is only set on the ZIP branch that already threw.

**Done when.**

- [ ] /admin/restore accepts `data.json` (envelope form) inside a ZIP as well as `manifest.json` + `tables/`, and keeps zipRef so "Put the files back" works for browser-built parts
- [ ] the restore page accepts a multi-part backup (part1..partN) rather than a single file
- [ ] one archive layout is documented and both producers emit it

*Cross-area note (2026-09-30, intelligence Round G): intelligence `ILIFE-3` closes by pointer when this lands; it adds a round-trip test (the entry names `clientBackup` writes satisfy the restore page's manifest / tables patterns) and a documented multi-part procedure.*

**Resolution (2026-10-01, admin-and-org Round G).** Package P1, with `BKP-10`. Reproduced on HEAD `bcbf3e8`: `lib/clientBackup.ts:124` wrote the envelope as `data.json` and no `manifest.json` / `tables/`; `/admin/restore` threw "No manifest.json — this doesn't look like a manufacturing-os backup ZIP." for anything else (`restore/page.tsx:114-115`), took one file (`:270`, `:314`) and read binaries only from that one ZIP (`:229`). The new round-trip test fails 6 of 9 against HEAD's `clientBackup`. Fix — ONE archive layout, documented at the head of `lib/clientBackup.ts` (`BACKUP_ARCHIVE_ENTRIES`) and in `DEC-75` §6: part 1 carries `manifest.json` + `tables/<table>.json` (the layout `lib/exportRunner.ts` already writes for the server ZIP and `/about` advertises); every part carries `files/<storage-key>`, `files-manifest.json` and `backup-part.json` (which backup, which part); the last part carries `backup-report.json`. The browser backup now writes that layout (the envelope's 24-hour presigned URLs are no longer copied into the archive). The reader is ONE function, `lib/dataRestore.ts readBackupArchive`, used by the page: it takes every dropped part of one backup in any order, finds the records part (`manifest.json` + `tables/`, or `data.json` in a browser backup written before this change — still restored), never takes an entry inside `files/` for the records, refuses with a message — before anything is planned or written — a set with no records part, two records parts, a part whose `backup-part.json` names another backup, or a table file that does not parse, and returns every part's `files/` entries for "Put the files back" (which now uploads from every part, remapping each key with the org map `/begin` answered — `runChunkedRestore` returns it as `idRemap`). It warns when the dropped parts carry fewer files than the manifest lists, and when `backup-report.json` says the run was cancelled. `/admin/restore` accepts several files at once (drop or picker).
- Files: `lib/clientBackup.ts`, `lib/dataRestore.ts` (`readBackupArchive`, `BackupZipLike`, `BackupArchiveRead`), `app/(protected)/admin/restore/page.tsx` (`handleFiles`, `zipsRef`, `archiveFilesRef`, `putFilesBack`).
- Tests: `lib/__tests__/restoreArchiveRoundTrip.test.ts` — the REAL producers end to end: `runOrgExport` → `runFullBackup` (two parts) → `readBackupArchive` → `/begin` + `/apply-table` into another workspace ("both parts dropped together: records restore into another workspace and every file is found"), the server ZIP through `buildAndDeliverExport` the same way, the single-shot `/apply` with the same envelope, an older browser backup (`data.json`) restoring records and files, and the refusals; the entry names satisfy the page's former manifest / tables patterns (intelligence `ILIFE-3`'s round-trip check); page pins. `lib/__tests__/helpers/restoreMemoryDb.ts` is the shared in-memory engine.

**Done-when.**
- [x] /admin/restore accepts `data.json` (envelope form) inside a ZIP as well as `manifest.json` + `tables/`, and keeps the ZIP so "Put the files back" works for browser-built parts ✓.
- [x] the restore page accepts a multi-part backup (part1..partN) rather than a single file ✓ — dropped together, any order; missing parts are named by the shortfall warning.
- [x] one archive layout is documented and both producers emit it ✓ — `manifest.json` + `tables/` + `files/` + `files-manifest.json` from both; the browser adds `backup-part.json` / `backup-report.json`, the server ZIP its `README.md` / `schema/` / `files-omitted.json` (`lib/exportRunner.ts` unchanged — admin-and-org P3's file).

**Scope / residual.** "Put the files back" does not yet verify each file's bytes against `files-manifest.json` before uploading (document-control `RET-14` did that for the ticket-archive restore, `lib/restoreVerify.ts`); the hashes are now in every part, so it is a page-local follow-up. A restore of a large multi-part backup still holds every dropped part in browser memory at once. Intelligence `ILIFE-3` can close by pointer (its four criteria hold here; the multi-part procedure is the clientBackup header and the drop-zone copy: drop every part together, part 1 carries the records).

---

<a id="bkp-8"></a>

## BKP-8 · The export endpoints run as service-role for Manager and DocCtrl, handing them every ACL-restricted document and every user's private scratchpad, plus unstamped presigned URLs with no download_audits

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/data-export/structured/route.ts:55-57`, `app/api/data-export/run/route.ts:17`, `lib/dataExport.ts:18-20`, `lib/dataExport.ts:143-179`, `supabase/migrations/20260708_acl_rls_enforcement.sql:56-62`, `supabase/migrations/20260708_acl_rls_enforcement.sql:85-91`, `supabase/migrations/20260630_scratchpad_private.sql:59-66`, `lib/downloads.ts:1-9`, `app/data-portability/page.tsx:71-72`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified end to end: role gate admits Manager, the export runs as service role, and neither the ACL restrictive policy nor the private-notes policy nor the stamping/download_audits path applies.

**Mechanism.** Both export routes gate on a hardcoded `["Admin", "Manager", "DocCtrl"]` list and then run runOrgExport with the service-role key, which the file header itself says "bypass[es] RLS". Two RLS decisions are thereby erased for a Manager: the RESTRICTIVE `documents_acl_select` policy, whose node_visible() short-circuits to true only for `v_role IN ('Admin','DocCtrl')` — a Manager without an explicit grant cannot read private/hidden documents in the app; and `notes_standalone_own`, which makes note rows with no document/project/asset visible ONLY to created_by. Separately, collectFilePaths presigns a 24h GET for every document_versions.file_url with no watermarking and no download_audits row, while the normal path (lib/downloads.ts) stamps every copy "UNCONTROLLED" unless the requester holds the checkout and logs every download.

**Failure scenario.** A Manager deliberately excluded from a restricted library clicks "Download JSON" and receives every row of every restricted document plus 24-hour direct-download URLs for the raw PDFs — unstamped, at any revision including Superseded and Draft — with not one download_audits row. In a PSM/OSHA shop that is a bulk uncontrolled-copy channel with no distribution record: the trail shows a single DATA_EXPORT row, not "who took which drawing". Meanwhile /data-portability tells prospects "Postgres RLS enforces that your queries can only see rows belonging to your organization" and "The only code path that crosses RLS boundaries is the data-export endpoint itself".

**Evidence.**

```
app/api/data-export/structured/route.ts:55 `if (!["Admin", "Manager", "DocCtrl"].includes(role || "")) {`. lib/dataExport.ts:18-20 "The endpoint uses the Supabase service-role key to bypass RLS, so this function MUST be called from a server context that has already verified the caller is an org admin." — the caller verifies Manager/DocCtrl, not admin. supabase/migrations/20260708_acl_rls_enforcement.sql:60 `IF v_role IN ('Admin', 'DocCtrl') THEN RETURN true;`. lib/downloads.ts:4-9 "User holds an active checkout … CONTROLLED copy (raw PDF) - Otherwise → UNCONTROLLED copy (stamped). Every download is logged to `download_audits`."
```

> **Verifier correction.** Sharpen one half: DocCtrl is already a controller inside node_visible (:60 returns true), so the ACL erasure is specific to Manager. The scratchpad exposure and the unstamped/unaudited presigned URLs apply to all three roles. The hardcoded role array is another instance of the facility-vocabulary pattern the roles-and-permissions audit already logged.

**Done when.**

- [ ] full-org export is Admin-only, matching /admin/restore's `activeRole === "Admin"` gate for the mirror-image operation
- [ ] private standalone notes are excluded or author-redacted in the export, and ACL-restricted documents are either excluded for non-controllers or the export is refused for a role that cannot read them all
- [ ] every export writes one download_audits row per file (or an equivalent bulk-distribution record) so the chain of custody names the drawings, not just the event
- [ ] the role list stops being hardcoded in three route files and comes from the shared capability policy

*Cross-area note (2026-09-30, intelligence Round G): intelligence `ILIFE-7`, `DACL-7` and `IEDGE-10` (the same Manager / DocCtrl export) close by pointer when this lands. Together they add: destination create / edit Admin-only; the `DATA_EXPORT` row recording the exporter's role and whether presigned URLs were minted or the dump was ACL-filtered; the manifest naming withheld rows; and a test that the export role list and the ACL controller tier cannot drift.*

*Cross-note (2026-10-01, admin-and-org Round G, P2 second review fix pass): two handoffs for P3, which owns the export routes and `lib/exportRunner.ts`. Both are recorded with the hunk under `BKP-9`'s "Second review fix pass". (1) In `buildAndDeliverExport`'s embed loop, a file listed unchecked (it has a URL but size `null`) must be capped by the size storage reports before it is buffered. Today it skips the per-file embed-cap test. (2) The three export routes can pass `deadlineAt` (route start + 240 s) into `runOrgExport`. A third item stands as before: `buildReadme` does not print `manifest.files.unchecked`.*

---

<a id="bkp-9"></a>

## BKP-9 · The file manifest misses native CAD source files, knowledge-library PDFs and output templates — the README still claims "every binary file, path-preserved"

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/dataExport.ts:316-363`, `lib/dataExport.ts:126-133`, `lib/exportRunner.ts:466-476`, `lib/storageOrphans.ts:43-47`, `lib/storageOrphans.ts:80-87`, `lib/revisions.ts:499-524`, `lib/knowledge.ts:357-365`, `app/data-portability/page.tsx:64`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The sibling collector in storageOrphans.ts is the settling evidence: the same repo enumerates these keys for deletion-safety but not for backup, so the ZIP's 'every binary file' claim is false for CAD sources, knowledge PDFs and output templates.

**Mechanism.** collectFilePaths covers 8 key sources. storageOrphans.collectReferencedKeys — the same repo's authoritative list of "every storage key the database references" — covers 11. The delta that carries real content: `document_versions.source_file_key` (the uploaded native source, e.g. the DWG behind the issued PDF — written at lib/revisions.ts:506 `sourceFileKey = srcUpload.url`), `knowledge_documents.file_key` (every knowledge-library source PDF — lib/knowledge.ts:358), `output_templates.template_file_key` + `example_files[].key` (the org's authored document-production templates). All three tables' ROWS are exported, so the backup contains rows pointing at binaries it does not contain.

**Failure scenario.** An org restores from a full ZIP after losing its tenant. Every issued PDF comes back; not one native CAD source does, so no drawing can be revised again — the thing a piping/PSM shop most needs. Knowledge libraries restore as rows with zero source documents. Output templates restore as metadata with no .docx. The manifest reports `files.missing: 0` (a key that was never collected is never head-checked), README.md says "files/<storage-path> — every binary file, path-preserved", and /data-portability promises "your backed-up export contains every byte you've ever uploaded".

**Evidence.**

```
lib/dataExport.ts:330-360 is the complete list of `add(...)` calls — document_versions.file_url, tickets.attachments, markup_requests.shared_markup_url, asset_photos.file_url, plot_plans.image_path, libraries.cover_image_url, collections.cover_image_url, org_configurations branding logoPath. lib/storageOrphans.ts:43-44 `["document_versions", "document_versions", "file_url, source_file_key", (rows) => { for (const r of rows) { add(r.file_url as string); add(r.source_file_key as string); } }]`. lib/exportRunner.ts:476 `- files/<storage-path>      — every binary file, path-preserved`.
```

> **Verifier correction.** Also add asset_files to the list of exported tables whose binaries are in neither collector — same shape, same consequence.

**Done when.**

- [ ] collectFilePaths and collectReferencedKeys are driven by one shared registry of (table, column, extractor) so they cannot diverge
- [ ] a test asserts the two lists are identical
- [ ] the manifest's `files.missing` counter reflects keys that exist in the DB but were not collected, instead of only keys that failed HeadObject

**Resolution (2026-10-01, admin-and-org Round G).** Package P2, in one commit with `BKP-2` (the same registry). Reproduced on base `2290b94`: `collectFilePaths` (`lib/dataExport.ts:340-387`) had eight `add` sources. It had no `document_versions.source_file_key`, no `knowledge_documents.file_key` and no `output_templates` keys, while the sweep's collector had all three. P1's own round trip seeded an output template whose `.docx` no backup carried.

Fix: `collectFilePaths` reads `lib/storageKeyRegistry.ts STORAGE_KEY_SOURCES`, the list the sweep reads. The export now carries native CAD sources, knowledge-library PDFs, output templates and their examples, and vendor quotes (`BKP-2`), as well as everything it carried before. A source whose table the export does not carry contributes nothing; the only one is `users` (avatars), which is excluded whole with its reason (`EXPORT_EXCLUDED_TABLES`). A byte size is read only when it is a number: an intake redline's "2.00 MB" is now head-checked instead of being summed as NaN.

Done-when 3: after the registry has collected, `findUnregisteredOrgKeys` scans every string (JSON included) of every exported row for a key under this workspace's prefix that no registered column named. It skips the tables that RECORD a key as history (`KEY_MENTION_TABLES`: `audit_logs`, `export_runs`, `export_destinations`). Each key it finds is CARRIED: added to the file list and head-checked like the rest, so `files.missing` counts it when storage lacks it. It is also counted in the new `manifest.files.unregistered`, with a ⚠ note naming each `table.column` and saying the orphan sweep does not protect it until it is registered. So `files.missing` no longer reports 0 over a key nobody looked at: every key the exported rows hold under the workspace's prefix is looked at.

`app/data-portability/page.tsx` no longer promises "every byte you've ever uploaded". It now promises "every file your records reference", naming CAD sources, knowledge PDFs, templates and quotes, and says files archived offline stay in the space-archive zips the backup names. Its "every column verbatim" line now names the credential columns that are exported empty (`BKP-1`).
- Files: `lib/storageKeyRegistry.ts`, `lib/dataExport.ts`, `app/data-portability/page.tsx`.
- Tests:
  - `lib/__tests__/storageKeyRegistry.test.ts`: "the two lists are identical, less the sources whose table the export does not carry (each excluded with a reason)" and "BKP-9 Done-when 3 — the export's value scan for keys no registered column names".
  - `lib/__tests__/exportContractRoundTrip.test.ts`, "BKP-2 / BKP-9 — every binary the database references is in the backup, and restores":
    - the manifest lists every registered key and the unregistered one (`unregistered: 1`) and skips the audit row's mention;
    - a gone object is counted missing, whichever collector found it;
    - the server ZIP and the browser Full ZIP pack every binary, and a fresh workspace restores them with every key column moved to the new prefix.
  - The same file's "/data-portability promises what the export carries".
  - `lib/__tests__/restoreArchiveRoundTrip.test.ts` (P1's) now counts the template binary the export carries: three files, packed and put back.

**Done-when.**
- [x] collectFilePaths and collectReferencedKeys are driven by one shared registry ✓.
- [x] a test asserts the two lists are identical ✓ — less `users`, which the export never carries, by name and reason.
- [x] the manifest's `files.missing` counter reflects keys that exist in the DB but were not collected ✓. Such a key is now found, head-checked and counted in `missing` when its object is gone. It is named under `files.unregistered`, and no key under the workspace's prefix escapes the count.

**Review fix pass (2026-10-01, admin-and-org Round G, P2).** Four corrections.

1. **Export runtime.** The first pass made the export slower, and nothing pinned how long it takes. `byteSize` rightly stopped reading a text size ("2.00 MB") as a byte count. But every ticket attachment records its size as text (`formatBytes(file.size)` on the request page, `CheckInPanel`'s "x.xx MB"), so every attachment, plus every native source, quote, template and unregistered key, was HEAD-checked one at a time. Those routes are capped at `maxDuration = 300` (`/api/data-export/structured`, the browser Full ZIP's first step; `run`; `run-scheduled`). On base the text size skipped the check, and summed as NaN into `totalBytes`.
   Fix in `lib/dataExport.ts runOrgExport`: the checks run `FILE_CHECK_CONCURRENCY` (24) at a time (`forEachBounded`). Each result lands at its index, so the manifest keeps its order. The checks stop at a wall-clock budget, `FILE_CHECK_BUDGET_MS` (90 s). A file not reached by then keeps its download URL, carries no size, and is counted in the new `manifest.files.unchecked`, with a note. It is not counted missing.
   Tests in `lib/__tests__/exportContractRoundTrip.test.ts`, "the storage checks run side by side, in manifest order, under a time budget":
   - with 60 text-sized attachments, every size-less key is checked exactly once;
   - more than one check is in flight at once, and never more than the cap;
   - the manifest order is `collectFilePaths`' whatever order the checks finish in;
   - with a budget of 0, nothing is checked and every file keeps its URL and counts as unchecked.
2. **Embed order.** With the registry's first order, knowledge PDFs came second, ahead of photos and attachments, so near the server ZIP's 1.5 GB embed cap (`lib/exportRunner.ts`) a scheduled ZIP could leave out files it embedded on base. `collectFilePaths` now orders by `STORAGE_KEY_COLUMNS`, and a key that two columns name takes the earlier column's place. That list puts the eight columns base carried first, in base's order. Then come the registry's additions: native source, vendor quote, template and examples, knowledge PDF, page backgrounds. Test: "the manifest order is STORAGE_KEY_COLUMNS'" (`storageKeyRegistry.test.ts`).
3. **The unregistered-key note** said such files "ARE included" even when the object was gone, and pointed the customer at a source file. It now says how many are included and how many were not found in storage, names the `table.column`, gives no repository path, and tells the Admin not to run the orphaned-file clean-up until the field is tracked. Tests: the existing manifest and missing-object cases now check the wording.
4. **Page backgrounds.** Every backup now carries `libraries.page_config` and `collections.page_config` backgrounds (`BKP-2` fix pass). The round trip seeds both and restores them.

**Scope / residual.** `lib/exportRunner.ts`'s README line "every binary file, path-preserved" (admin-and-org P3's file) is now true for every file the records reference, and was not edited. Avatars are personal and are not in an org backup, by design. A workspace with more size-less files than 24 checks can clear in 90 s (on the order of 50,000 at 40 ms each) lists the rest unchecked rather than timing the route out. The README that `buildReadme` writes (P3's file) does not yet print `files.unchecked`. The manifest and its notes do.

**Second review fix pass (2026-10-01, admin-and-org Round G, P2).** Two corrections.

1. **The check budget is now tied to the export's start, not only to the file phase.** The 90 s budget counted from the start of the file phase. That phase now begins after a table dump that does more work than base did: an exact count per table, an ORDER BY on every page, and possibly a full re-read (`ILIFE-6`). So a dump of about 230 s could still be followed by 90 s of checks, past the routes' `maxDuration = 300`. Fix in `lib/dataExport.ts runOrgExport`: no check starts after the earliest of three times. Those are the file phase's start plus `FILE_CHECK_BUDGET_MS` (90 s), the export's own start plus `FILE_CHECK_CEILING_MS` (150 s), and the caller's optional `deadlineAt`. A slow dump therefore shortens the checks, never the route. Test: "a slow table dump shrinks the checks' budget: …" in `exportContractRoundTrip.test.ts`:
   - a dump that "takes" 200 s (the clock is advanced while the first table is read) starts no check, and every size-less file is listed unchecked;
   - a 30 s dump still checks every file;
   - a caller's `deadlineAt` that has already passed stops every check.
   Mutation-checked: without the ceiling, the slow case fails.
2. **Handoff to admin-and-org P3, which owns `lib/exportRunner.ts`.** An unchecked file (a URL, size `null`) passes the server ZIP's per-file embed-cap test, `f.size != null && fileBytes + size > cap`. On base no size-less file ever had a URL, so this could not happen. The ZIP builder then buffers it whatever its size, so a large unchecked DWG near the 1.5 GB cap pushes the in-memory ZIP past the ceiling the cap exists to protect. The hunk, for P3, goes in the `buildAndDeliverExport` embed loop, after `res.ok` and before `arrayBuffer()`:
   ```diff
   +        // BKP-9: an unchecked file (size null) is capped by the size storage reports, before it is buffered.
   +        const header = res.headers.get("content-length");
   +        const reported = header == null ? NaN : Number(header);
   +        if (f.size == null && (!Number.isFinite(reported) || fileBytes + reported > MAX_EMBED_BYTES)) {
   +          await res.body?.cancel();
   +          omitted.push({ path: f.path, size: Number.isFinite(reported) ? reported : null, reason: "not size-checked; over the embed cap or of unknown size" });
   +          continue;
   +        }
   ```
   P3's three routes (`/api/data-export/structured`, `run`, `run-scheduled`) can also pass `deadlineAt: routeStart + 240_000` into `runOrgExport`, so the deadline is the route's own rather than the export's. Until P3 lands the hunk, the ceiling above makes unchecked files rarer, and each one is still named in `files.unchecked` and in a note.

**Final review fix pass (2026-10-01, admin-and-org Round G, P2).** Three corrections. The second and third land the handoff above here, because P2 created both hazards and P3 has not started.

1. **Only a real not-found counts a file missing.** `runOrgExport`'s HeadObject `catch` treated every error as "missing": it cleared the file's URL and counted it in `files.missing`. Both ZIP producers skip a file with no URL (`lib/exportRunner.ts` and `lib/clientBackup.ts`), and the checks run 24 at a time, so one storage throttle or timeout silently dropped a live binary from both ZIPs. Now only a 404 (`NotFound` / `NoSuchKey`, the intake upload's test) clears the URL and counts the file missing. Any other error keeps the URL, leaves the size `null`, and counts the file in `files.unchecked`; the note then says how many were unchecked for time and how many because the check failed. Test (`exportContractRoundTrip.test.ts`): "a check that fails with anything but not-found …": a throttled and a timed-out check keep their URLs, count as unchecked, not missing, and both ZIPs pack them, while a real not-found is still missing. The missing-object case now throws the S3 client's `NotFound` shape.
2. **A size-unknown file is capped before it is buffered** (the hunk above, landed). In `buildAndDeliverExport`'s embed loop, a file with a URL and no size takes its length from the GET's `Content-Length` before the body is read. Over the cap, the body is cancelled and the file is listed in `files-omitted.json` with its size, as an over-cap file is. With no length, it is not embedded, and is listed with the reason "storage did not report its size". Test: "a file the export could not size-check is held to the cap …": the body of a 5,000-byte file over a 100-byte cap, and of a file with no length, is never read.
3. **The embed loop stops at the route's deadline.** This package added native DWGs, knowledge PDFs, quotes and templates to the embed set, and the sequential loop had no time limit. So a run that finished near the routes' `maxDuration = 300` before P2 could now be killed with no archive, its run row left `running`. Now `run` and `run-scheduled` take their start time first and pass `deadlineAt: exportEmbedDeadline(routeStart, maxDuration)`: 300 s less `EMBED_HEADROOM_MS` (90 s) for the compression, the delivery and the run row. `buildAndDeliverExport` passes it to `runOrgExport`'s checks too, which matters for a scheduled sweep's later destinations. Past it, no file is fetched. Each remaining file is listed in `files-omitted.json` with the reason "the export reached its time limit", the file's top-level reason and the README's "Omitted binaries" note say so, and the archive is built and delivered. A download still running at the deadline is aborted there. Tests: "past the route's deadline no file is fetched: …": three files are embedded, thirteen are listed with the reason, and the archive reads back as a backup. Also "both ZIP routes pass their own deadline …".

Every case before this pass is built as before. A small export (every size known, under the cap, before the deadline) has the same entries, texts and diagnostics, and the over-cap path keeps its texts byte for byte. The test "a small export … is built exactly as before" pins this. Negative controls: with `lib/exportRunner.ts` and the two routes as at `45f0c1b`, the size-unknown, deadline and route tests fail (3), and the pin passes. With `lib/dataExport.ts` as at `45f0c1b`, the throttled-check test fails.

**`lib/exportRunner.ts` was touched by P2.** Two guards in `buildAndDeliverExport`'s embed loop, its `deadlineAt` parameter, `exportEmbedDeadline` / `EMBED_HEADROOM_MS`, and `buildReadme`'s omitted note; the routes `app/api/data-export/run` and `run-scheduled` gained one line each to pass their start. Admin-and-org P3 starts from this version.

**Scope / residual.** The deadline bounds the embedding, not the compression: `generateAsync` over a ZIP near the 1.5 GB cap can itself outlast the 90 s headroom, as it could before. `files-omitted.json` carries no presigned URLs, like the over-cap entries before it: the archive keeps none (a retained archive would carry dead 24 h links), and the omitted files download through the JSON export. `/api/data-export/structured` (JSON, no ZIP) still passes no `deadlineAt`; `runOrgExport`'s own 150 s ceiling bounds its checks.

---

<a id="bkp-10"></a>

## BKP-10 · A cancelled backup still downloads a final part whose report says "Every file verified by SHA-256" — with no cancellation flag and no file total

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/clientBackup.ts:126-145`, `lib/clientBackup.ts:149-150`, `lib/clientBackup.ts:183-188`, `app/(protected)/admin/data-export/page.tsx:259-263`, `components/archive/BackupViewer.tsx:88-110`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The misleading report note and the missing cancellation flag are real and correctly cited. But the claim's core sting — 'nothing in the ZIP records that 8,800 files are missing' — is false: part 1's data.json holds the full file list and count. Discoverable-but-unflagged omission, so LOW rather than MEDIUM.

**Mechanism.** The file loop breaks on cancel (`if (opts.isCancelled?.()) break;`), then control falls through to `await finalizePart(true)` unconditionally, which writes files-manifest.json and backup-report.json and saves the part. backup-report.json carries `filesPacked` and `errors` but no `filesTotal`, no `cancelled` flag, and — because a cancelled run has an empty `errors` array — takes the else branch of the note ternary: "Every file verified by SHA-256 in files-manifest.json." Files never attempted appear in neither `fileManifest` nor `errors`; they simply do not exist anywhere in the archive.

**Failure scenario.** An admin starts a full backup, cancels after 200 of 9,000 drawings, and keeps the downloaded part. The archive is internally consistent, its report claims full SHA-256 verification, and nothing in the ZIP records that 8,800 files are missing. Years later, in a PSM records request or a tenant-loss recovery, that archive is treated as the backup of record. The same report is what components/archive/BackupViewer.tsx falls back to as its integrity anchor when the DB is unreachable.

**Evidence.**

```
lib/clientBackup.ts:135-137 `note: progress.errors.length > 0 ? "Files listed under errors are NOT in this backup …" : "Every file verified by SHA-256 in files-manifest.json."`; :149 `for (const f of files) { if (opts.isCancelled?.()) break;` ; :186-187 `await finalizePart(true); progress.phase = opts.isCancelled?.() ? "cancelled" : "done";` — the phase is set AFTER the file is already saved to disk.
```

**Chain reaction.** app/(protected)/admin/data-export/page.tsx:261 independently prints "Backup complete — {n} zip part(s), every file SHA-256 verified in files-manifest.json" and never reads `envelope.manifest.complete`, so an INCOMPLETE dump (which, per the org_id finding, is every dump today) is announced as complete.

> **Verifier correction.** Real but milder than framed. The note is literally true of what the archive contains — it claims per-file integrity, not completeness — so the defect is the two missing fields (cancelled, filesTotal), not a false statement. The in-app claim is also guarded: app/(protected)/admin/data-export/page.tsx:259 renders the green "Backup complete — … every file SHA-256 verified" line only under `backupProgress?.phase === "done"`, and phase is "cancelled" on this path, so the user who cancels does not see a success banner. The gap bites later, when someone opens the orphaned part file cold.

**Done when.**

- [ ] backup-report.json records `cancelled`, `filesTotal`, and the files never attempted, and finalizePart names the part `…-INCOMPLETE.zip` when the run was cancelled
- [ ] the "Every file verified" note only appears when filesPacked === filesTotal and errors is empty
- [ ] the report also carries `manifest.complete` and `manifest.notes` from the envelope so an INCOMPLETE dump is visible in the archive itself
- [ ] files-manifest.json is written into EVERY part, not only the last one — today parts 1..N-1 carry no hashes at all

**Resolution (2026-10-01, admin-and-org Round G).** Package P1, with `BKP-7`. Reproduced on HEAD `bcbf3e8`: the file loop broke on cancel (`lib/clientBackup.ts:150`) and fell through to `finalizePart(true)` (`:186`), whose `backup-report.json` carried no `cancelled`, no `filesTotal` and no list of unattempted files, and whose note read "Every file verified by SHA-256 in files-manifest.json." whenever `errors` was empty (`:135-137`); `files-manifest.json` was written only into the last part (`:127-128`). Fix in `runFullBackup`: the run counts the files it attempted; the last part's `backup-report.json` records `cancelled`, `filesTotal`, `filesPacked`, `notAttempted` (every path never tried — in no part), `errors`, and the export's own `complete` and `manifestNotes`; the part is named `…-partN-INCOMPLETE.zip` when the run was cancelled; the note says "Every file verified by SHA-256 in files-manifest.json." ONLY when nothing was cancelled, nothing failed and every file was packed — otherwise it says what is missing ("INCOMPLETE — the backup was cancelled after N of M file(s) …" / "Files listed under errors are NOT in this backup …"). `files-manifest.json` (every file packed so far, with its part) and `backup-part.json` go into EVERY part. The run's result carries `cancelled`, `filesTotal`, `notAttempted`; the phase is `cancelled` exactly when files were left unattempted. `/admin/restore` (via `readBackupArchive`) warns from the report when a backup was cancelled.
- Files: `lib/clientBackup.ts`.
- Tests: `lib/__tests__/restoreArchiveRoundTrip.test.ts` "cancelled: the last part is …-INCOMPLETE.zip and its report records cancelled, filesTotal and the files never attempted — never 'Every file verified'", "a failed file: the note names the gap; a clean run alone says every file is verified, and the report carries manifest.complete / notes", and the multi-part test (hashes in part 1 already, cumulative in part 2).

**Done-when.**
- [x] backup-report.json records `cancelled`, `filesTotal`, and the files never attempted, and finalizePart names the part `…-INCOMPLETE.zip` when the run was cancelled ✓.
- [x] the "Every file verified" note only appears when filesPacked === filesTotal and errors is empty ✓ (and the run was not cancelled).
- [x] the report also carries `manifest.complete` and `manifest.notes` from the envelope ✓ (`complete`, `manifestNotes`).
- [x] files-manifest.json is written into EVERY part ✓ (cumulative, each entry naming its part).

**Scope / residual.** The chain reaction lives in files this package does not own and is handed over unedited: `app/(protected)/admin/data-export/page.tsx:259-263` prints "Backup complete — … every file SHA-256 verified" on `phase === "done"` without reading `errors` or `manifest.complete` (admin-and-org P3); `components/providers/BackupIndicator.tsx:76-80` prints "Every file SHA-256 verified — manifest in the last part." for a `cancelled` run with no errors (notifications N7). Both can now read `BackupResult.cancelled` / `notAttempted` or the progress phase.

---

<a id="bkp-11"></a>

## BKP-11 · Any active org member can read the encrypted S3 credentials the API refuses to return, and a restore reinstates enabled destinations pointing at the backup owner's bucket

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** admin-and-org P3 (done-when 3's remaining limb: `PATCH /api/data-export/destinations/[id]` refuses `enabled: true` on a row with no credentials or no webhook secret) and the user (paste `20261154`, done-when 1) — by the integrator, 2026-10-01 (admin-and-org P2 merge; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260605_rls_policies_new_tables.sql:134-144`, `app/api/data-export/destinations/route.ts:55-66`, `lib/exportTables.ts:157`, `lib/dataRestore.ts:313`, `app/api/data-export/run-scheduled/route.ts:60-66`, `lib/exportTables.ts:173-175`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves check out. The credential leak is ciphertext only (AES-256-GCM, key server-side), which is why MEDIUM is the right level; the substantive risk is the reinstated destination auto-pushing the new org's full dataset to the backup owner's bucket/webhook on the next sweep.

**Mechanism.** Three layers disagree about how secret export_destinations is. (a) RLS grants SELECT on the whole row — encrypted credential columns included — to every active org member, while the API deliberately strips them ("Sensitive fields are NEVER returned to the client after creation"); a Viewer can read them straight from supabase-js. (b) The full-org export dumps the table with `select("*")`, so the ciphertext leaves the database in a file explicitly designed to be portable — contradicting the reason ai_connections is excluded ("secrets never leave the database"). (c) export_destinations is in RESTORE_TABLE_ORDER, so restoring that backup into a different workspace re-creates the rows — bucket, encrypted keys, `enabled`, and a `next_run_at` already in the past — with org_id forced to the NEW org.

**Failure scenario.** Org A's backup is restored into org B (a migration, a demo, a partner tenant). The next daily cron sweep selects the reinstated destination (`enabled = true` and `next_run_at <= now`) and pushes org B's complete dataset — documents, tokens, audit trail — into org A's S3 bucket or webhook, decrypting org A's credentials to do it. Nobody configured that destination in org B; it simply appears on B's page as an existing backup target.

**Evidence.**

```
supabase/migrations/20260605_rls_policies_new_tables.sql:142-144 `CREATE POLICY "export_dest_member_select" ON export_destinations FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = export_destinations.org_id AND uid = auth.uid() AND status = 'active'));` — the header above it at :136-138 even says "Client never directly touches them. RLS off is fine here". app/api/data-export/destinations/route.ts:58-60 nulls the three encrypted fields. lib/dataRestore.ts:313 `"export_destinations", "export_runs", "ai_usage_events",`. app/api/data-export/run-scheduled/route.ts:63-65 `.eq("enabled", true).not("next_run_at", "is", null).lte("next_run_at", nowIso)`.
```

> **Verifier correction.** Keep the MEDIUM framing for the right reason: what RLS and the export expose is AES-256-GCM ciphertext (lib/serverCrypto.ts:33-40), decryptable only with EXPORT_ENCRYPTION_KEY, which never leaves the server. The credential leak is therefore theoretical unless the deployment key also leaks; the restore-reinstatement leg (c) is the part that causes real harm without any decryption by an attacker, since the same deployment holds the key.

**Done when.**

- [ ] the RLS SELECT policy is dropped or narrowed to non-credential columns (a view), since the table is service-role-only by design
- [ ] export_destinations is either excluded from the export or exported with credential columns nulled
- [ ] restored destinations land disabled with next_run_at NULL and require the admin to re-enter credentials before they can fire

**Partial (2026-10-01, admin-and-org Round G).** P1's restore half — Done-when 3. Reproduced on HEAD `bcbf3e8`: the restore's only rule for this table was document-control `XEDGE-10`'s `scrubRestoredRow` (inside `remapRow`), which nulls the three `*_encrypted` columns and sets `enabled = false` only when the row CARRIES one of those keys (`lib/dataRestore.ts:314-320` — `if (hit.length === 0) return row;`), and never touched `next_run_at`; a backup row (or a hand-made one without the credential keys) came back with its past-due `next_run_at`, and a row without the keys came back `enabled`. Fix: `lib/dataRestore.ts landRestoredRow`, applied by the shared restore write (`applyRestoreChunk`) after the org is bound, lands every restored `export_destinations` row INERT whatever it carries — `enabled = false`, `next_run_at = NULL` (the scheduler selects only `enabled` rows with a due `next_run_at`, `app/api/data-export/run-scheduled/route.ts:67-72`), and every column in `REDACT_COLUMNS.export_destinations` set to NULL even when absent. Both routes inherit it. Test: `lib/__tests__/restoreApplyRoute.test.ts` "an export destination lands disabled, with no next run and no credentials — even when the row omits the credential keys" (chunked and single-shot; fails against HEAD). Done-when 3 holds for the restore: a restored destination cannot fire until an Admin re-saves its schedule (which recomputes `next_run_at`) and enables it; that ENABLING a destination requires credentials to be present (`app/api/data-export/destinations/[id]/route.ts`, PATCH) is admin-and-org P3's file — handed over: refuse `enabled: true` on an s3 / r2 row with no `access_key_id_encrypted` / `secret_access_key_encrypted`. *Corrected at the review fix pass:* the handover also covers WEBHOOK destinations. A restored webhook row keeps its `webhook_url` (not a credential, so neither the export nor the restore nulls it) and lands with `webhook_secret_encrypted` NULL. Once an Admin re-enables it, `lib/exportRunner.ts:328-330` signs with `""`, and `:350` then sends the org's full export UNSIGNED to that URL. If the backup came from another org, the URL is that org's endpoint. So P3's PATCH must also refuse `enabled: true` on a webhook row whose `webhook_secret_encrypted` is NULL, which forces the Admin to re-enter the secret and so look at the URL. Alternatively it can require the Admin to re-confirm `webhook_url` on a restored row. Until P3 lands that, Done-when 3's "re-enter credentials before they can fire" holds for the restore only: the row arrives disabled with no next run, but enabling it does not yet demand the secret. Done-when 2 (export nulls the credentials) already holds by document-control `XEDGE-10` (`REDACT_COLUMNS`, `lib/exportTables.ts:218-221`). Done-when 1 (the member SELECT policy, `20260605:142-144`) is admin-and-org P2's migration. Status stays OPEN for P2.

*Review fix pass 3 (2026-10-01):* the restore half's claim, "nothing restored can fire" (`DEC-45`), held for destinations only. `email_notifications` was a restorable contract table (in `RESTORE_TABLE_ORDER`, in neither `SKIP_TABLES` nor `IMMUTABLE_TABLES`), and `landRestoredRow` made only `export_destinations` inert. The client INSERT rail allows mail only to a member of the same org, and never with `metadata.external` (`20261047_rp_phase6_sweep_integrity_rails.sql:208-217`, SURF-17). The restore writes with the service role, so neither check applied to a restored row. The drain (`app/api/notifications/send-queued/route.ts:127-131`) sends every `queued` / `failed` row under five attempts, unscoped when the cron calls it. The Admin of a self-signup trial workspace could POST rows with any external `to_email`, `subject` and `body_html` as `queued` to `/apply-table`, and the cron sent them from the platform's notifications address. An honest restore re-sent a stale queued backlog, for example from a deployment with no `RESEND_API_KEY`, to every recipient, offboarded people included. Fix: `email_notifications` is in `SKIP_TABLES` ("the outbound mail queue — a restored message would be sent again, to whatever address the backup names; delivery state is never restored"). `/apply-table` refuses it with 400 naming that reason, `planRestore` plans it out, and neither route nor the page's driver ever writes a row of it. The review's other option was rejected: landing every row terminal (`failed`, attempt 5). The Admin's dead-letter re-queue (`app/(protected)/admin/settings/page.tsx` `requeueFailed`, allowed by `email_notif_update_admin_requeue`, whose column guard keeps the address and body unchanged) makes any such row sendable again. Tests in `lib/__tests__/restoreApplyRoute.test.ts`, "BKP-11 (restore half) / DEC-45 (fix pass 3) — no restored row of the mail queue can be sent":
- the drain's candidate filter and the re-queue are pinned as this test assumes them;
- the chunked route answers 400 and attempts no write;
- the single-shot route plans the table out, lands the rest, and leaves a live queue row untouched;
- the page's driver never posts the table.

In every case the drain's candidate filter matches 0 rows. Each test fails with the `SKIP_TABLES` entry removed. The queue stays in the export, as audit_logs does: the backup still carries it for review, and only the restore leaves it out. Status stays OPEN for P2 (Done-when 1).

**Partial (2026-10-01, admin-and-org Round G, P2).** Done-when 1 is `supabase/migrations/20261154_ao_roundG_export_destinations_select.sql`, under decision `DEC-78` (minted as a provisional number; renumbered at merge). Reproduced on base `2290b94`: `export_dest_member_select` (`20260605_rls_policies_new_tables.sql:141-144`) is the only definition in the sequence, and no migration narrows the privilege, so every active member could select the three `*_encrypted` columns.

The plan's fail-safe default was taken, the reversible option:
- The policy is KEPT.
- The table-level SELECT is revoked from PUBLIC, anon and authenticated.
- SELECT is granted back to authenticated on the card columns only: id, org, name, type, enabled, schedule, the last run's time, status and size, created and updated.
- Not granted: the credentials, and the destination's coordinates (`endpoint`, `region`, `bucket`, `prefix`, `webhook_url`). A webhook URL can carry its own secret; Admins, Managers and DocCtrls read the coordinates through the role-gated API.
- *Corrected at the review fix pass:* `last_run_error` is not granted either. The first version granted it, but it holds the runner's raw message (`msg.slice(0, 500)` in `app/api/data-export/run-scheduled/route.ts`), which can name the endpoint's host (a DNS failure: `getaddrinfo ENOTFOUND <host>`) or carry the remote's response body (`Webhook <status>: <body>`, `lib/exportRunner.ts`). A ninth probe checks it; the shape test pins the grant to the table's columns less the credentials, the coordinates and `last_run_error` ("last_run_error is withheld because the runner stores raw messages that can name the destination").

- *Corrected at the second review fix pass:* the decision, its Acceptance line and the table COMMENT said a member never reads a destination's coordinates or the last run's raw error. That did not hold. `export_runs_member_select` (`20260605:147-150`, the only definition) let every active member, a Viewer included, read every column of `export_runs`:
  - `destination_path` holds the webhook URL for a webhook run and `<bucket>/<key>` for an S3 / R2 run (`lib/exportRunner.ts`);
  - `diagnostics` records `webhook:push <url>` and `s3:push <bucket>/<key>`;
  - `error_message` holds the raw runner message (`msg.slice(0, 1000)` in `run` and `run-scheduled`).

  The same file now narrows `export_runs` in the same way. Its policy is kept. The table-level SELECT is revoked from PUBLIC, anon and authenticated, and SELECT is granted back on the run's card columns: `id`, `org_id`, `destination_id`, `trigger_type`, `triggered_by`, `status`, `table_count`, `total_rows`, `file_count`, `total_bytes`, `destination_type`, `started_at`, `completed_at` and `duration_ms`. Withheld: `destination_path`, `diagnostics`, `error_message`, `download_url`, `download_url_expires_at` and `triggered_by_email`. The only readers are `app/api/data-export/runs` and the `run` / `run-scheduled` writers, all the service role behind a role-gated route, so no screen breaks; a test pins that census.

Nothing in the app reads either table with a member session, and a test pins that. The file is one paste:
- a count-only inventory before the transaction: rows, rows holding a credential, active members who could read them, and whether `authenticated` held SELECT; and, for `export_runs`, its rows, the rows naming where a run went or why it failed, and whether `authenticated` held SELECT;
- one final `(check, ok, n)` SELECT carrying seventeen probes, nine for `export_destinations` and eight for `export_runs`;
- the rollback in the header, one line per table: `GRANT SELECT ON export_destinations TO anon, authenticated;` and `GRANT SELECT ON export_runs TO anon, authenticated;`.

Test: `lib/__tests__/aoRoundGExportDestinationsMigration.test.ts`. The second fix pass adds the `export_runs` block, which checks:
- the policy is defined once and never narrowed before this file;
- the REVOKE;
- the grant list is the census of the table's columns less the six withheld;
- the withheld columns are the ones the runner writes the destination and the raw error into;
- every probe and the inventory row;
- every reader is a server route.
- **Pending migration:** `supabase/migrations/20261154_ao_roundG_export_destinations_select.sql` — **not applied** (DEC-30).

Done-when 2 (the export nulls the credentials) holds by document-control `XEDGE-10` (`REDACT_COLUMNS.export_destinations`), and is now pinned by value as well (`lib/__tests__/exportContractRoundTrip.test.ts`, the `BKP-1` block).

**Done-when.**
1. ✓ (pending migration `20261154`). Narrowed to the card columns by a column privilege, with the policy kept: no credential, coordinate or raw run error on `export_destinations`, and, since the second review fix pass, no destination path, step trace, raw error, archive link or email on `export_runs`. The first ✓ was overstated, because `export_runs` still exposed the coordinates.
2. ✓ — the export nulls the credential columns (`XEDGE-10`; pinned by value).
3. ◐ — the restore half ✓ (P1). The remaining limb is that enabling a destination must require its credentials (the s3 / r2 keys, the webhook secret). It belongs to `app/api/data-export/destinations/[id]/route.ts` PATCH, admin-and-org P3's file, as P1 recorded.

**Scope / residual.** OPEN until P3 lands Done-when 3's PATCH refusal and `20261154` is pasted.

---

<a id="bkp-12"></a>

## BKP-12 · Four exported tables have no `id` column and no CONFLICT_TARGETS entry, so their restore upsert always errors and the advertised "re-run, it's additive and safe" breaks

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:336-348`, `lib/exportTables.ts:16-27`, `supabase/migrations/20260928_site_codebook.sql:37-38`, `supabase/migrations/20260928_site_codebook.sql:89-101`, `supabase/migrations/20260806_intelligence_layer.sql:101-106`, `supabase/migrations/20260806_intelligence_layer.sql:120-121`, `app/(protected)/admin/restore/page.tsx:450`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed exactly, including the count of four; codebook_config is one-per-org so the collision is guaranteed on any restore into a configured workspace.

**Mechanism.** `conflictTargetFor` returns CONFLICT_TARGETS[table] ?? "id". Scanning every CREATE TABLE body plus ALTER…ADD COLUMN across supabase/, four exported tables have no `id` column and no CONFLICT_TARGETS entry: `codebook_config` (PK org_id), `document_equipment_suggestions` (PK org_id,document_id), `recently_viewed_docs` (PK user_id,document_id), `library_numbering` (PK library_id). Their upsert requests ON CONFLICT (id) on a table with no such column, which Postgres rejects; the code falls back to a plain `insert` of the same chunk. That succeeds on a virgin target and fails with a primary-key violation on any re-run or into a workspace that already has those rows.

**Failure scenario.** The restore UI tells the admin "Some tables reported issues … re-run the restore (it's additive and safe)". Re-running fails those four tables outright with a PK violation, and a restore into a workspace that already has a codebook_config row (one per org — always present once the codebook is set up) fails that table on the FIRST attempt. The site codebook config, the drawing→equipment bridge review state, and per-library numbering rules never restore. The coverage tripwire's "conflict targets reference real tables" test only checks that the six listed names exist; it never checks that id-less tables are listed.

**Evidence.**

```
lib/dataRestore.ts:346-348 `export function conflictTargetFor(table: string): string { return CONFLICT_TARGETS[table] ?? "id"; }` with CONFLICT_TARGETS covering only document_favorites, curated_collection_items, team_members, ticket_number_counters, archive_settings, org_configurations. supabase/migrations/20260928_site_codebook.sql:38 `org_id UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,`. supabase/migrations/20260806_intelligence_layer.sql:121 `library_id UUID PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,`.
```

> **Verifier correction.** None; severity MEDIUM is right — the tables are small and re-derivable, and the practical symptom is a failed-table name in the restore panel on the second run.

**Done when.**

- [ ] CONFLICT_TARGETS gains entries for codebook_config (org_id), document_equipment_suggestions (org_id,document_id), recently_viewed_docs (user_id,document_id) and library_numbering (library_id)
- [ ] the coverage tripwire asserts every exported table's conflict target names columns that carry a unique or primary-key constraint in the schema
- [ ] the insert fallback stops re-sending a chunk the upsert already rejected for a data reason, and reports the underlying error instead

*Cross-area note (2026-09-30, intelligence Round G): intelligence `ILIFE-9` closes by pointer here. `ILIFE-10` hands this package the business keys — `process_flows (org_id, from_kind, from_ref, to_kind, to_ref)`, `proposed_links (document_id, target_document_id, proposer)`, and `entity_mentions`' EXPRESSION key `(asset_id, COALESCE(knowledge_document_id, document_id), page)`, which needs a pre-filter rather than an `onConflict` list and must keep every `is_explicit` row. Intelligence `ILIFE-2` (I-01 phase B) moves `knowledge_libraries` / `knowledge_sources` / `knowledge_documents` ahead of `process_flows` / `entity_mentions` in `RESTORE_TABLE_ORDER` after this package merges.*

**Resolution (2026-10-01, admin-and-org Round G).** Package P1, after `ORG-1` / `BKP-3`. Reproduced on HEAD `bcbf3e8`: `CONFLICT_TARGETS` (`lib/dataRestore.ts:461-468`) had the six entries the finding quotes, `conflictTargetFor` defaulted to `"id"`, and both routes retried a rejected upsert as a plain `insert` of the same chunk (`apply-table/route.ts:90-91`, `apply/route.ts:103-104`); the new tripwire listed exactly the four tables (`codebook_config`, `document_equipment_suggestions`, `library_numbering`, `recently_viewed_docs` — "target id; keys …") against that code. Fix: (1) `CONFLICT_TARGETS` gains `codebook_config: "org_id"`, `document_equipment_suggestions: "org_id,document_id"`, `recently_viewed_docs: "user_id,document_id"`, `library_numbering: "library_id"`. (2) A census of `supabase/` (`lib/__tests__/helpers/schemaKeys.ts`: every PRIMARY KEY, UNIQUE constraint — inline, table-level or `ALTER … ADD` — and non-partial plain-column UNIQUE INDEX still standing after later `DROP INDEX`; partial and expression indexes are not ON CONFLICT arbiters and are not counted) drives a tripwire: for EVERY restorable contract table, `conflictTargetFor` must name one of that table's keys. (3) The plain-insert retry is gone from the shared write (`applyRestoreChunk`): a chunk the upsert rejects is reported with the database's own message and SQLSTATE (`error`, `code` on the response) and is never re-sent; the HLD-9 row-by-row retry for `document_holds` (23514 / 23503) keys on the upsert's own code now.
- Files: `lib/dataRestore.ts` (`CONFLICT_TARGETS`, `applyRestoreChunk`), `app/api/admin/restore/apply-table/route.ts` (returns `code`).
- Tests: `lib/__tests__/dataRestore.test.ts` "BKP-12 — every restorable table's conflict target is a real key" (census sanity; the four tables; "for EVERY restorable contract table, conflictTargetFor names a PRIMARY KEY or UNIQUE key of that table"; no stale entries); `lib/__tests__/restoreApplyRoute.test.ts` "restoring the same backup twice: the second run skips what exists — zero failed tables, on both routes" and "an upsert the database rejects is reported with ITS error — no plain-insert retry of the same chunk" (both fail against HEAD's code; the engine refuses an ON CONFLICT target that is not a declared key, 42P10, as Postgres does).

**Done-when.**
- [x] CONFLICT_TARGETS gains entries for codebook_config (org_id), document_equipment_suggestions (org_id,document_id), recently_viewed_docs (user_id,document_id) and library_numbering (library_id) ✓.
- [x] the coverage tripwire asserts every exported table's conflict target names columns that carry a unique or primary-key constraint in the schema ✓ — in `lib/__tests__/dataRestore.test.ts` (P1's file) rather than `lib/__tests__/exportCoverage.test.ts`, which admin-and-org P2 owns this round; same census idea, keyed on the restorable set.
- [x] the insert fallback stops re-sending a chunk the upsert already rejected for a data reason, and reports the underlying error instead ✓.

**Scope / residual.** Intelligence `ILIFE-9` (same three tables) can close by pointer. *Corrected at the review fix pass:* `ILIFE-10` criterion 3 ("a duplicate row is skipped, not fatal to its 500-row batch") was first recorded here as not taken. Combined with the stop rule, it made one duplicate abandon every later table. It is done now: a statement refused for one row's sake (class 23, `lib/dataRestore.ts ROW_LEVEL_SQLSTATES`) is bisected down to the refused rows, which are reported with the database's code and message while the rest of the chunk lands and the run goes on (`BKP-5` fix pass; HLD-9's `document_holds` path is the same mechanism now). `ILIFE-10`'s business keys are still NOT taken. `process_flows`, `proposed_links` and `entity_mentions` keep `id` as their target, which is a correct key, so the tripwire passes. A row that collides on their SECOND unique key (a merge into a workspace that re-indexed) is refused with 23505 instead of being recognised as the live row's duplicate. `entity_mentions`' pre-filter that keeps every `is_explicit` row is still to build. Those stay with `ILIFE-10` (handed to this package by cross-note, not in its brief; `DEC-31`). *Second review fix pass:* the bisection had no bound. A chunk where every row is refused (every `team_members` row of a placeholder; a NOT NULL column the backup lacks, 23502) cost 2n-1 = 999 statements in one serverless request and could time out into a non-JSON 504, leaving the admin with no idea what landed. It is now bounded by `lib/dataRestore.ts RESTORE_BISECT_MAX_STATEMENTS` (100 per request). Past that, the rows of a refused statement are reported refused together, with the database's code and message and "this request stopped isolating rows after 100 statements; run the restore again to retry them". Isolating k refused rows of n costs about 2·k·log2(n/k) statements. The commonest systematic case, a placeholder's team memberships, no longer reaches the bisection at all: it is refused before the write (`BKP-5` fix pass 2). Worst case per `/apply-table` request (1,000 rows): 2 + 100 write statements. Tests in `lib/__tests__/restoreApplyRoute.test.ts`: "a chunk where every row is refused (a NOT NULL the backup lacks) costs at most the budget, and every row is reported" and "one refused row among many is still isolated exactly". *Third review fix pass:* the failure scenario's promise ("re-run, it's additive and safe") and this record's re-run test held only with a frozen uid map. That test sends the same `idRemap` twice and never calls `/begin`. A re-run through the page calls `/begin` again, which linked active members only, so it minted a second placeholder per unlinked person under a new uid. `recently_viewed_docs` (one of this finding's four tables) and `document_favorites` then landed a second time under that uid. `/begin` and `/apply` now link the placeholders an earlier run created, so a re-run maps every uid as the first run did (`BKP-5` fix pass 3). Tests: "/begin twice: one placeholder per person …" and "the page's driver run twice (the stop panel's advice): favorites and recents are not duplicated …" in `lib/__tests__/restoreApplyRoute.test.ts`. *Fourth review fix pass:* that holds only while `/begin`'s member read and every placeholder insert succeed. Both were unchecked, so a failed read planned every person new and remapped every uid. Both are now checked, and `/begin` and `/apply` stop before any table when either fails (`BKP-5` fix pass 4). *Fifth review fix pass:* the re-run also maps every backup uid of one address to the same person. A person with two backup membership rows (an inactive historical one beside a re-added one) had one uid left out of the map, so their rows under it landed naming that raw uid on every run. Both uids now map to the linked member or to the one placeholder, so a re-run answers the same map (`BKP-5` fix pass 5; test "a new person with two rows: ONE placeholder, both uids map to it (/begin and /apply), and a re-run links it").

---

<a id="bkp-13"></a>

## BKP-13 · Scheduled exports write no audit_logs row and raise no admin alert — a webhook destination is an unlogged daily exfiltration channel that bypasses the plan gate

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/data-export/run-scheduled/route.ts:106-115`, `lib/dataExport.ts:182-200`, `supabase/schema.sql:771-783`, `app/api/data-export/run/route.ts:38-68`, `app/api/data-export/run/route.ts:141-144`, `app/api/data-export/destinations/route.ts:81-95`, `app/(protected)/admin/data-export/page.tsx:346-352`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every leg confirmed, including the subtle one: even the generic DATA_EXPORT audit insert cannot succeed for a cron run because "cron" is not a UUID.

**Mechanism.** Three gaps compose. (1) The cron path calls buildAndDeliverExport with `exporterUserId: "cron"`; runOrgExport then inserts `user_id: "cron"` into audit_logs, whose user_id column is UUID — Postgres rejects it with 22P02. supabase-js resolves with `{error}` rather than throwing, the insert's return value is never destructured, and the surrounding try/catch never fires, so the failure is invisible. (2) alertAdminsOfExport — the bell notification added specifically for "compromised-admin exfiltration" — lives only in the manual /run route, not in run-scheduled. (3) Destination creation is open to Manager and DocCtrl, and the Growth-plan gate is `if (body.bucket)`, so a webhook destination is creatable on any plan.

**Failure scenario.** A phished DocCtrl account creates a webhook destination pointed at an external host (assertSafeExternalUrl only blocks private/loopback ranges), sets schedule=daily, and logs out. Every night the cron POSTs the org's entire dataset — documents, versions, audit trail, share tokens — to that URL. No DATA_EXPORT row appears in audit_logs, no bell fires, and the only trace is an export_runs row with `triggered_by: null` on a page most admins never open. The export page's own trust footer says "Every export is recorded in audit_logs" and /data-portability says "exports are logged to your audit trail".

**Evidence.**

```
app/api/data-export/run-scheduled/route.ts:111 `exporterUserId: "cron",`. lib/dataExport.ts:183-189 `await sb.from("audit_logs").insert({ action: "DATA_EXPORT", … user_id: params.exporterUserId,` inside a try whose catch (`:198 console.warn`) cannot be reached by a supabase-js query error. supabase/schema.sql:777 `user_id UUID,`. app/api/data-export/destinations/route.ts:83 `if (body.bucket) {` — the plan check is skipped entirely for webhook destinations.
```

> **Verifier correction.** "Unlogged exfiltration channel" is the overstatement. Creating the destination writes an audit row — destinations/route.ts:141-150 inserts action "EXPORT_DESTINATION_CREATED" with user_id/user_email/user_role — and every scheduled firing inserts and updates an export_runs row carrying status, destination_type, destination_path, total_bytes and diagnostics (run-scheduled:97-104, :118-133, :148-155). What is actually missing is the DATA_EXPORT audit row for cron runs and the bell alert; the run history itself survives.

**Done when.**

- [ ] runOrgExport passes a null user_id (or a real service UUID) for cron runs and CHECKS the insert's `{error}`, failing the run when the audit row cannot be written
- [ ] alertAdminsOfExport is called from run-scheduled as well as run
- [ ] creating or enabling ANY destination (webhook included) notifies every other Admin/DocCtrl, and destination create/edit is Admin-only rather than Manager/DocCtrl

---

<a id="bkp-14"></a>

## BKP-14 · lib/schemaExpectations.ts has a phantom table scraped from a prose comment and omits 24 real tables — the schema-health panel is permanently red and blind to the newest migrations

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/schemaExpectations.ts:104`, `lib/schemaExpectations.ts:10-13`, `app/api/admin/schema-health/route.ts:45-51`, `app/api/admin/schema-health/route.ts:67-81`, `supabase/migrations/20260819_orphan_tables_backfill.sql:3`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed precisely, phantom and count: my own naive CREATE-TABLE scan reproduced the 'statements' artifact from that comment line, which is exactly how the file says it was generated ('Generated from supabase/migrations (CREATE TABLE scan)', lines 10-13). The panel is permanently red on a table that does not exist and silent on 20261017_process_flows.sql.

**Mechanism.** EXPECTED_TABLES lists `{ table: "statements", migration: "20260819_orphan_tables_backfill.sql" }`. No CREATE TABLE for `statements` exists anywhere in supabase/ — the name came from that migration's header sentence "Reproducibility backfill: CREATE TABLE statements for 11 tables that exist", i.e. the generator's regex matched English prose. schema-health probes each expectation with a head select; a missing table returns 42P01, so `healthy` is false and `migrationsToRun` always names 20260819_orphan_tables_backfill.sql, which does not create it. In the other direction, diffing EXPECTED_TABLES (93 entries) against the 111 CREATE TABLEs shows 24 real tables never probed, including the three newest feature tables — process_flows (20261017), answer_skills (20261016), link_rules (20261015) — plus document_versions, tickets, audit_logs, org_members, collections, and the whole quality-program set. Unlike lib/exportTables.ts, nothing tests this file.

**Failure scenario.** Migrations are applied by hand in the Supabase SQL editor (the file's own premise). The panel that exists to make a skipped migration visible shows a permanent false failure for `statements`, so operators learn to ignore it; and when 20261017_process_flows.sql is genuinely never pasted in, the panel reports nothing, because process_flows is not on the list. The flows feature renders empty in production with a health page that is red for the wrong reason.

**Evidence.**

```
lib/schemaExpectations.ts:104 `{ table: "statements", migration: "20260819_orphan_tables_backfill.sql" },`; grepping that migration for "statements" returns only the two comment lines. lib/schemaExpectations.ts:12-13 states the contract that was not kept: "When a new migration creates a table, add it here — the health panel is only as honest as this list." app/api/admin/schema-health/route.ts:78 `healthy: missingTables.length === 0 && missingColumns.length === 0,`.
```

> **Verifier correction.** Fix the arithmetic before anyone quotes it: EXPECTED_TABLES holds 85 entries (not 93 — the higher count comes from counting EXPECTED_COLUMNS' `{ table:` lines too), 111 tables are created across supabase/, and 27 real tables are never probed (not 24). The list includes every table the finding names — process_flows, answer_skills, link_rules, document_versions, tickets, audit_logs, org_members, collections, project_checklists/checklist_items/turnover_items/punch_items — plus documents, libraries, orgs, users, checkout_sessions, download_audits and others. The "nothing tests this file" claim also holds: the only references anywhere outside the file are the two import/comment lines in app/api/admin/schema-health/route.ts.

**Done when.**

- [ ] the `statements` entry is deleted
- [ ] EXPECTED_TABLES is regenerated from the CREATE TABLE scan (parsing SQL, not comments) and covers all 111 tables
- [ ] a vitest tripwire diffs EXPECTED_TABLES against supabase/ on every run, the way lib/__tests__/exportCoverage.test.ts guards the export contract

*Cross-area note (2026-09-30, intelligence Round G): intelligence `ILIFE-12` and `IRLS-12` close by pointer here. Since projects J9 `REL-7` a tripwire exists (`lib/__tests__/schemaExpectations.test.ts`), but it grandfathers `answer_skills` / `link_rules` / `process_flows` / `knowledge_line_traces` / `document_markups` (`:71`) and does not assert the reverse, so `statements` survives; ILIFE-12 also asks for `EXPECTED_COLUMNS` rows for the 20261015 / 16 / 17 ALTERs.*

**Resolution (2026-10-01, admin-and-org Round G).** Package P2. Reproduced on base `2290b94`:
- `lib/schemaExpectations.ts:120` lists `{ table: "statements", … }`, and there is no CREATE TABLE statements anywhere in supabase/.
- `lib/__tests__/schemaExpectations.test.ts` (projects J9 `REL-7`) scanned the migrations only, never schema.sql; it grandfathered five names (`:71`) and never checked a row against its file. So `statements` survived and 19 created tables were never probed:
  - fifteen base-schema tables: `documents`, `document_versions`, `tickets`, `audit_logs`, `org_members`, `orgs`, `users`, `collections`, `libraries`, `checkout_sessions`, `download_audits`, `document_sets`, `metadata_templates`, `table_views`, `watermark_policies`;
  - `answer_skills`, `link_rules`, `process_flows` and `document_markups`.

Fix:
- The phantom row is deleted.
- The 19 rows are added; the base tables name `schema.sql (base schema)`, the existing convention.
- `knowledge_line_traces` (created by `20261007_line_traces.sql`, dropped by `20261007_retire_line_traces.sql`) goes in the new `RETIRED_TABLES` and is never probed (intelligence `IRLS-12`'s verifier correction). The list now covers all 119 tables supabase/ creates: 118 expected, 1 retired.
- The tripwire's grandfather set is empty and stays empty. The scan reads schema.sql and the numbered migrations, and it fails both ways: a created table with no row, and a row whose named file does not create that table (the phantom's shape). A retired table must be created and dropped where its row says, and never listed.
- The route now reads PGRST205 (current PostgREST's answer for an absent table) as missing. It matched 42P01 only, so a missing table could read as present (`ILIFE-12`'s verifier).

- Files: `lib/schemaExpectations.ts`; `app/api/admin/schema-health/route.ts` (outside the plan's file list, but the list's only consumer — see `SHR-12`); `lib/__tests__/schemaExpectations.test.ts`.
- Tests: `lib/__tests__/schemaExpectations.test.ts`:
  - "REL-7 tripwire — every table a migration creates is on the health check": "the grandfather set is empty (BKP-14 regenerated the list)", "BKP-14: every row names a file that really creates that table — no phantom (the scraped `statements` row is gone)", "BKP-14: the list covers every table supabase/ creates, schema.sql's included, less the retired", and the retired-table check;
  - "a table answered with PGRST205 is missing, not present".

**Done-when.**
- [x] the `statements` entry is deleted ✓.
- [x] EXPECTED_TABLES is regenerated from the CREATE TABLE scan (SQL, comments stripped) and covers every table ✓ — 119 are created now (111 when the finding was written): 118 rows and 1 retired.
- [x] a vitest tripwire diffs EXPECTED_TABLES against supabase/ on every run ✓ — in both directions.

**Scope / residual.** None. Intelligence `ILIFE-12` and `IRLS-12` close by pointer here (cross-notes on both). Their criterion on the 20261015/16/17 ALTERs is vacuous: those migrations add no column to an older table, they create the three tables, which are now probed.

---

## BKP-15 · A restore refuses a process flow whose endpoint is gone — the dangling flows a backup carries are reported as failed rows, not restored as what they were

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** admin-and-org P3 (the restore engine's handling of one table; no migration expected) — by the integrator, 2026-10-01 (intelligence I-09 merge; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED (verified by intelligence I-09's second review on a throwaway PostgreSQL 16, recorded in intelligence `FLOW-6`'s record, "Open handoff to admin-and-org (BKP restore fidelity)")
- **Locations:** `supabase/migrations/20261155_intel_roundG_process_flows_authority.sql` (`process_flows_guard()` — the endpoint check binds every writer, the service role included), `lib/dataRestore.ts` (the org restore writes `process_flows` as the service role)
- **Independently verified:** — opened 2026-10-01 by the integrator at the intelligence Round G I-09 merge (DEC-31: the restore-side remainder of `FLOW-6` / `WIRE-10`, which I-09 recorded as an open handoff); not yet challenged by a second party.

**Mechanism.** Since `20261155`, a `process_flows` row whose `asset` end names no asset of the org (or whose `unit` end names no Site Codebook unit) is refused with `23503 process_flows_endpoint`, for every writer. Rows that were already dangling when the migration was pasted are kept (DEC-80 item 3), so a backup taken afterwards still carries them. On restore each is refused, and the engine's row-by-row retry reports it as "references a row that is not there". A flow whose asset the restore skipped, because that asset exists in another workspace, is refused the same way.

**Failure scenario.** An org restores a backup holding three flows to an asset deleted before the paste. The restore completes, but its report lists three failed `process_flows` rows with a generic reason; the operator cannot tell they were already dangling in the source, and the restored workspace silently differs from the backup by those rows.

**Done when.**

- [ ] The restore reports a refused dangling flow as what it is ("a process flow whose equipment no longer exists — not restored"), counted on its own line, distinct from a real failure; or the guard honours a restore-session marker on INSERT so the row is restored exactly as it was. The choice and its reason are recorded.
- [ ] A restore round-trip test with a dangling flow pins the chosen behaviour, and every other `process_flows` row restores as today.

**Closer:** admin-and-org P3 (assigned at the I-09 merge, 2026-10-01).

---
