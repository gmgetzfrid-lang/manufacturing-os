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
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/exportTables.ts:50-54`, `lib/dataExport.ts:300`, `app/api/share/resolve/route.ts:30-37`, `app/api/transmittal/route.ts:24-31`, `app/api/intake/upload/route.ts:32-40`, `supabase/migrations/20260623_document_shares.sql:14`, `supabase/migrations/20260902_project_intake.sql:22`, `supabase/migrations/20260910_transmittal_portal.sql:21`, `lib/exportTables.ts:171-181`

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

---

<a id="bkp-2"></a>

## BKP-2 · cost_documents binaries are referenced by nothing the system knows about — absent from every backup AND eligible for permanent orphan deletion after 7 days

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataExport.ts:316-363`, `lib/storageOrphans.ts:42-88`, `lib/storageOrphans.ts:152-177`, `app/api/admin/orphans/route.ts:47`, `app/api/intake/upload/route.ts:70-87`, `supabase/migrations/20260819_orphan_tables_backfill.sql:179-196`, `lib/exportTables.ts:93`

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

---

<a id="bkp-3"></a>

## BKP-3 · /api/admin/restore/apply does not force the org boundary that /apply-table does — rows whose org_id isn't the backup's land in whatever org the file names

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/restore/apply/route.ts:79-111`, `app/api/admin/restore/apply-table/route.ts:52-58`, `lib/dataRestore.ts:200-218`, `app/api/admin/restore/apply/route.ts:75`

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

---

<a id="bkp-4"></a>

## BKP-4 · Four tables in ORG_SCOPED_TABLES have no org_id column — every export is stamped INCOMPLETE and permanently drops project rosters and curated-collection contents

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/exportTables.ts:57-58`, `lib/exportTables.ts:91`, `lib/exportTables.ts:109-110`, `lib/exportTables.ts:152`, `lib/dataExport.ts:95-107`, `lib/dataExport.ts:209-218`, `lib/dataExport.ts:248`, `supabase/schema.sql:19-30`, `supabase/migrations/20260527_projects_and_collaboration.sql:55-65`, `supabase/migrations/20260602_documents_library_super.sql:63-71`, `supabase/migrations/20260819_orphan_tables_backfill.sql:16-24`

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

---

<a id="bkp-5"></a>

## BKP-5 · Restore can only ADD, never repair: rows are upserted on the backup's own primary keys with ignoreDuplicates, so restoring over damaged data inserts nothing and reports success

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/restore/apply-table/route.ts:74-87`, `app/api/admin/restore/apply/route.ts:98-125`, `app/(protected)/admin/restore/page.tsx:190-216`, `app/(protected)/admin/restore/page.tsx:445-453`, `lib/dataRestore.ts:336-348`

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

---

<a id="bkp-6"></a>

## BKP-6 · Retention pruning deletes every object older than N days under the prefix — with no prefix set, that is the customer's entire bucket

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/exportRunner.ts:257-265`, `lib/exportRunner.ts:374-405`, `app/(protected)/admin/data-export/page.tsx:664-666`, `app/(protected)/admin/data-export/page.tsx:605`

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

---

<a id="bkp-7"></a>

## BKP-7 · The "Full ZIP with binaries" the export page produces cannot be read by the restore page — two admin pages emit two incompatible archive formats

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/clientBackup.ts:117-145`, `app/(protected)/admin/data-export/page.tsx:136-143`, `app/(protected)/admin/restore/page.tsx:111-125`, `lib/exportRunner.ts:132-162`, `app/(protected)/admin/storage/page.tsx:738-762`

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

---

<a id="bkp-8"></a>

## BKP-8 · The export endpoints run as service-role for Manager and DocCtrl, handing them every ACL-restricted document and every user's private scratchpad, plus unstamped presigned URLs with no download_audits

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/data-export/structured/route.ts:55-57`, `app/api/data-export/run/route.ts:17`, `lib/dataExport.ts:18-20`, `lib/dataExport.ts:143-179`, `supabase/migrations/20260708_acl_rls_enforcement.sql:56-62`, `supabase/migrations/20260708_acl_rls_enforcement.sql:85-91`, `supabase/migrations/20260630_scratchpad_private.sql:59-66`, `lib/downloads.ts:1-9`, `app/data-portability/page.tsx:71-72`

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

---

<a id="bkp-9"></a>

## BKP-9 · The file manifest misses native CAD source files, knowledge-library PDFs and output templates — the README still claims "every binary file, path-preserved"

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataExport.ts:316-363`, `lib/dataExport.ts:126-133`, `lib/exportRunner.ts:466-476`, `lib/storageOrphans.ts:43-47`, `lib/storageOrphans.ts:80-87`, `lib/revisions.ts:499-524`, `lib/knowledge.ts:357-365`, `app/data-portability/page.tsx:64`

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

---

<a id="bkp-10"></a>

## BKP-10 · A cancelled backup still downloads a final part whose report says "Every file verified by SHA-256" — with no cancellation flag and no file total

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/clientBackup.ts:126-145`, `lib/clientBackup.ts:149-150`, `lib/clientBackup.ts:183-188`, `app/(protected)/admin/data-export/page.tsx:259-263`, `components/archive/BackupViewer.tsx:88-110`

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

---

<a id="bkp-11"></a>

## BKP-11 · Any active org member can read the encrypted S3 credentials the API refuses to return, and a restore reinstates enabled destinations pointing at the backup owner's bucket

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260605_rls_policies_new_tables.sql:134-144`, `app/api/data-export/destinations/route.ts:55-66`, `lib/exportTables.ts:157`, `lib/dataRestore.ts:313`, `app/api/data-export/run-scheduled/route.ts:60-66`, `lib/exportTables.ts:173-175`

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

---

<a id="bkp-12"></a>

## BKP-12 · Four exported tables have no `id` column and no CONFLICT_TARGETS entry, so their restore upsert always errors and the advertised "re-run, it's additive and safe" breaks

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:336-348`, `lib/exportTables.ts:16-27`, `supabase/migrations/20260928_site_codebook.sql:37-38`, `supabase/migrations/20260928_site_codebook.sql:89-101`, `supabase/migrations/20260806_intelligence_layer.sql:101-106`, `supabase/migrations/20260806_intelligence_layer.sql:120-121`, `app/(protected)/admin/restore/page.tsx:450`

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

---

<a id="bkp-13"></a>

## BKP-13 · Scheduled exports write no audit_logs row and raise no admin alert — a webhook destination is an unlogged daily exfiltration channel that bypasses the plan gate

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/data-export/run-scheduled/route.ts:106-115`, `lib/dataExport.ts:182-200`, `supabase/schema.sql:771-783`, `app/api/data-export/run/route.ts:38-68`, `app/api/data-export/run/route.ts:141-144`, `app/api/data-export/destinations/route.ts:81-95`, `app/(protected)/admin/data-export/page.tsx:346-352`

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
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/schemaExpectations.ts:104`, `lib/schemaExpectations.ts:10-13`, `app/api/admin/schema-health/route.ts:45-51`, `app/api/admin/schema-health/route.ts:67-81`, `supabase/migrations/20260819_orphan_tables_backfill.sql:3`

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

---
