# 18 · Lifecycle — export, restore, delete, orphans

**13 findings** — 5 HIGH · 8 MEDIUM.

What survives a backup, and what a delete leaves behind.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| lib/__tests__/exportCoverage.test.ts — a real, build-failing backup-completeness tripwire. It discovers every CREATE TABLE across supabase/schema.sql + migrations (111 tables today) and asserts each is exported, user-scoped, or excluded with a written reason; it also asserts every exported table has a restore position in RESTORE_TABLE_ORDER or a SKIP_TABLES reason, that CONFLICT_TARGETS names real tables, and that no exported table is a phantom. This is why no intelligence table is silently missing from the export set — verified by diffing ORG_SCOPED_TABLES against the migration scan: the only unexported table is knowledge_line_traces, deliberately excluded. | `lib/__tests__/exportCoverage.test.ts:29-103, lib/exportTables.ts:1-12` | It is the model every other list in this codebase needs (schemaExpectations, storageOrphans' reference sources). Do not weaken it; clone it. |
| remapRow's value-based deep remap. It rewrites uids by VALUE across top-level columns and arbitrarily nested JSONB, plus rewrites `orgs/<oldOrg>/` storage-path prefixes, rather than maintaining a column allowlist. The header documents why: the schema has 30+ user-reference columns plus uid arrays inside policy JSONB, and the previous allowlist had 14 of 30+. | `lib/dataRestore.ts:188-246, lib/dataRestore.ts:256-266` | Restoring into a different workspace correctly follows uids into ack rosters, reviewer lists and audit details, and follows storage keys into the new org prefix. This is sound and should not be reverted to a column list. |
| storageOrphans' fail-closed safety model — the reference collector throws on ANY query error rather than treating those keys as unreferenced (`throw new Error(\`reference scan failed at ${label}: ${error.message} — aborting (fail-closed)\`)`), a 7-day MIN_AGE_DAYS floor for in-flight uploads, PROTECTED_PREFIXES for archive/export artifacts, and deleteOrphans re-running the full scan server-side so the client's list is display and never authority. | `lib/storageOrphans.ts:11-19, :26, :100, :152-156` | The architecture is right; only the source list (missing cost_documents) and the tenancy scoping are wrong. Fix those without touching the fail-closed structure. |
| lib/orgGraph.ts's endpoint guard — every edge is dropped unless both node ids exist in the assembled node set. | `lib/orgGraph.ts:174` | Directly answers the lead's question: a restore can never produce a graph that RENDERS references to rows that no longer exist. The residual problem is invisibility, not corruption — so the fix is a dropped-edge diagnostic, not removing the guard. |
| knowledgePageRender writes nothing to storage — it fetches the PDF from R2 and returns base64 PNGs in memory, bounded by MAX_DEEP_READ_PAGES=6 at a fixed 1400px width. | `lib/knowledgePageRender.ts:19-56` | The hypothesis that knowledge page renders strand R2 objects is false — there is no render-cache prefix to sweep. Same for document thumbnails, which are client-rendered (components/documents/DocThumb.tsx, no PutObject anywhere outside intake/upload-url/ticket-shed-restore/exportRunner). |
| knowledgeSourceSync's three-way reconcile (add / refresh-on-rev / remove-mirror-when-source-leaves), including the rev-up path that deletes the old chunks, sets status='stale' and keeps the knowledge document id stable so past citations keep resolving. | `lib/knowledgeSourceSync.ts:239-262, :286-292` | This is the only mechanism that garbage-collects knowledge mirrors of deleted or de-scoped controlled documents. It is correct in itself — it is starved by the unordered 25-library slice and by having no counterpart for upload-origin documents. |
| lib/exportRunner.ts bundles the schema DDL inline — supabase/schema.sql plus every file in supabase/migrations, in order — into schema/ inside the ZIP, with a README that spells out the restore order ("import tables/*.json (parents before children), then upload files/*"). | `lib/exportRunner.ts:136-155, :469-480` | A destination-pushed backup is genuinely self-describing and rebuildable without this codebase. It is also the layout the restore page already parses — which is why aligning clientBackup to it (rather than the reverse) is the cheaper fix for the ZIP-incompatibility finding. |
| Restore's org-boundary forcing on the chunked path: after remapping, `if ("org_id" in m) m.org_id = orgId;`, plus an IMPORTABLE allowlist built from the export contract and a refusal of SKIP_TABLES entries. | `app/api/admin/restore/apply-table/route.ts:52-58, :24, :38-43` | A hostile or stale envelope cannot write rows into another workspace or into identity/billing tables. The tenancy boundary on the restore side is sound — which makes the unscoped orphan sweeper stand out as the outlier. |


---


<a id="ilife-1"></a>

## ILIFE-1 · Orphan sweeper does not know about cost_documents.file_url — every vendor quote and cost document is deletable 7 days after upload

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/storageOrphans.ts:44`, `lib/storageOrphans.ts:76`, `lib/costDocs.ts:105`, `lib/costDocs.ts:116`, `app/api/intake/upload/route.ts:70`, `app/api/intake/upload/route.ts:82`, `app/api/admin/orphans/route.ts:46`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed with no mitigating guard. PROTECTED_PREFIXES is only ["data/", "exports/"] (:26), so orgs/<org>/project-costs/… is a candidate; MIN_AGE_DAYS = 7 (:25); deleteOrphans re-scans and issues DeleteObjectsCommand (:157-165). The module's own comment at :39-40 states the contract this violates — 'Tables added later MUST be registered here' — and :77-79 records that exactly this bug already shipped once for output_templates.

**Mechanism.** collectReferencedKeys() enumerates exactly eleven sources (document_versions, knowledge_documents, asset_photos, tickets.attachments, markup_requests, plot_plans, libraries.cover, collections.cover, users.avatar, org_configurations branding, output_templates). cost_documents is absent — two differently-shaped greps (`cost_documents|cost_docs` and case-insensitive `cost_?documents`) over lib/storageOrphans.ts return nothing. But cost_documents.file_url holds a real R2 key: lib/costDocs.ts:105 `const key = \`orgs/${input.orgId}/project-costs/${input.projectId}/${crypto.randomUUID()}-${safeName}\`` then :116 `file_url: key, …`, and the contractor-facing intake portal does the same at app/api/intake/upload/route.ts:70 `const key = \`orgs/${orgIdQ}/project-costs/${projectIdQ}/quote-${crypto.randomUUID()}-${safeName}\`` → :82-86 `supabaseAdmin.from("cost_documents").insert({ … file_url: key, … })`. The column is real: supabase/migrations/20260819_orphan_tables_backfill.sql:185 `file_url text,`. Nothing under orgs/…/project-costs/ is in PROTECTED_PREFIXES (only "data/" and "exports/", storageOrphans.ts:26).

**Failure scenario.** A vendor submits a quote PDF through the intake portal in January. In February an admin opens the storage page and clicks reclaim orphans. deleteOrphans() re-scans (storageOrphans.ts:156), finds orgs/<org>/project-costs/<project>/quote-….pdf unreferenced and older than MIN_AGE_DAYS=7, and issues DeleteObjectsCommand. The cost_documents row survives with a file_url pointing at nothing; the bid tabulation shows the quote in the register and 404s on open. There is no undo — the route's own header calls it "reclaim", and the audit row (orphans/route.ts:49-55) records only counts, not keys.

**Evidence.**

```
lib/storageOrphans.ts:41-44 `// Each source: [label, query, extractor]. Tables added later MUST be registered here — the exportTables tripwire's cousin for binaries.` followed by a hardcoded eleven-entry array with no cost_documents. The file already documents this exact failure once, at :76-79: `// Registered late — output templates shipped after this collector was written, so every uploaded .docx/.xlsx template and example was an "orphan" seven days after upload and eligible for permanent deletion.`
```

**Chain reaction.** There is no automated tripwire for this list the way exportCoverage.test.ts guards exportTables.ts — so the next storage-key column added (an evidence attachment on checklist_items, a punch-list photo) repeats it silently.

**Done when.**

- [ ] cost_documents.file_url is registered in collectReferencedKeys' sources array
- [ ] A test enumerates every table/column in supabase/ that stores an R2 key and asserts each appears in collectReferencedKeys — the binaries analogue of exportCoverage.test.ts, which storageOrphans.ts:43 already calls for by name
- [ ] Deleting orphans records the deleted KEYS (not just counts) in the audit row so a mistaken purge is at least diagnosable

**Partial (2026-09-30, intelligence Round G).** Pointer — re-verified at HEAD `1b71ca1`: no criterion holds. `collectReferencedKeys` still has no `cost_documents` source (`lib/storageOrphans.ts:47-93` — document_versions, knowledge_documents, asset_photos, tickets, markup_requests, plot_plans, libraries, collections, users, org_configurations, output_templates), no key-column tripwire exists, and the purge's audit row records counts and scope, not keys (`app/api/admin/orphans/route.ts:50-55`). What changed around it: the sweep's walk and delete set are confined to the caller's org prefix (document-control `RET-7`; `ILIFE-8`'s listing half — ILIFE-8 itself stays OPEN on its `referencedKeys` residual), so the gap's blast radius is now the caller's own org; and the collector pages in id order (document-control `XEDGE-13`), but its post-loop count does not catch a concurrent delete (`ILIFE-6` criterion 3, ✗). Owner: admin-and-org **P2** (`BKP-2` — the storage-key registry including `cost_documents.file_url`, and its tripwire); criterion 3 (keys in the audit row) is this finding's addition, carried to `BKP-2` by a cross-note.

*Cross-note (2026-10-01, admin-and-org Round G, P2): criteria 1 and 2 hold. `cost_documents.file_url` is in `lib/storageKeyRegistry.ts STORAGE_KEY_SOURCES`, which `collectReferencedKeys` reads, and `lib/__tests__/storageKeyRegistry.test.ts` is the key-column census (see `BKP-2`, RESOLVED). Criterion 3 (the purge's audit row records the deleted keys) belongs to `app/api/admin/orphans/route.ts`, which is outside A&O P2's files; this finding stays OPEN on it.*

---

<a id="ilife-2"></a>

## ILIFE-2 · Restore FK order puts process_flows and entity_mentions BEFORE knowledge_documents — both foreign-key to it, so the intelligence layer fails to restore

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:292`, `lib/dataRestore.ts:294`, `lib/dataRestore.ts:298`, `lib/dataRestore.ts:327`, `supabase/migrations/20261017_process_flows.sql:27`, `supabase/migrations/20260929_mention_engine.sql:33`, `app/api/flows/read/route.ts:160`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the code comment above process_flows is itself wrong: 'Flows may reference knowledge documents (source PFD), restored earlier' — knowledge_documents is restored ~30 entries LATER. remapRow (:200-218) only rewrites org_id and uid values; it never nulls a dangling FK and it preserves row ids, so restoring into a fresh org raises 23503 on both tables. Only an additive re-restore into an org that already holds the knowledge documents would succeed.

**Mechanism.** RESTORE_TABLE_ORDER places process_flows at index 36 and entity_mentions at 37, while knowledge_libraries/knowledge_documents sit at indexes 92/95 (computed from the array). Both earlier tables carry hard FKs into knowledge_documents: `source_document_id UUID REFERENCES knowledge_documents(id) ON DELETE SET NULL` (20261017_process_flows.sql:27) and `knowledge_document_id UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE` (20260929_mention_engine.sql:33). The in-file comments assert the opposite of the code: ":293-294 // Flows may reference knowledge documents (source PFD), restored earlier." and ":296-298 // Mentions reference BOTH an asset and a document (controlled or knowledge), so they can only land once both sides exist." Neither is true — knowledge_documents is restored 58 positions later. AI-read flows always carry the FK: /api/flows/read/route.ts:159-161 inserts `origin: "ai", source_document_id: doc.id, source_page: …` where doc.id is a knowledge_documents id.

**Failure scenario.** An org that has run the mention indexer (Pillar B backlinks — every /assets/[tag] hub depends on it) or accepted any AI-read PFD flow restores a backup. orderTablesForRestore hands process_flows/entity_mentions to the server before knowledge_documents exists in the target. Postgres raises 23503 foreign_key_violation on the upsert; the code falls back to a plain insert (apply-table/route.ts:79) which raises the same error; the route returns 500 with that message. In the live chunked path the client marks the table failed and keeps going (see the separate finding), so the workspace ends up with equipment, documents and assets restored but zero mentions and zero flows — the graph's Process lens is empty and every asset backlinks hub is blank, with only a "failedTables" chip to explain it.

**Evidence.**

```
lib/dataRestore.ts:292-298 `"asset_aliases", "proposed_links", "link_rules", "answer_skills",` / `// Flows may reference knowledge documents (source PFD), restored earlier.` / `"process_flows",` / `"entity_mentions", "drawing_audit_logs",` — and :327-329 `"knowledge_libraries", "knowledge_library_links", "knowledge_sources", "knowledge_documents", "knowledge_chunks", "knowledge_page_entities", "knowledge_questions",`. Migration proof: supabase/migrations/20261017_process_flows.sql:27 `source_document_id UUID REFERENCES knowledge_documents(id) ON DELETE SET NULL,`; supabase/migrations/20260929_mention_engine.sql:33 `knowledge_document_id UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,`.
```

**Chain reaction.** Combined with the single-shot /apply route's abort-on-failure semantics (dead, see next finding), the abort would ALSO have wiped out everything ordered after position 36 — knowledge_libraries, knowledge_sources, knowledge_documents, knowledge_chunks, knowledge_page_entities, knowledge_questions, output_templates, output_generations — i.e. the entire AI corpus. Whichever path runs, the knowledge layer is the casualty.

> **Verifier correction.** Severity HIGH rather than CRITICAL for two reasons visible in code: (a) only AI-origin flows carry source_document_id — createManualFlow (lib/processFlows.ts:60-73) inserts none, so hand-drawn topology restores fine; (b) the restore is additive and re-runnable and the page tells the admin so (page.tsx:450 "re-run the restore (it's additive and safe)"), and a second pass succeeds for these tables because knowledge_documents landed in the first pass. Data loss is recoverable-by-rerun, not permanent.

**Done when.**

- [ ] knowledge_libraries, knowledge_sources and knowledge_documents appear in RESTORE_TABLE_ORDER before process_flows and entity_mentions
- [ ] A test derives FK dependencies from supabase/migrations and asserts every referenced table's index in RESTORE_TABLE_ORDER is strictly less than its referrer's (this class of bug is not caught by the existing exportCoverage test, which only checks membership)
- [ ] A restore of a backup containing an AI-read flow (source_document_id non-null) and mentions with knowledge_document_id set lands both tables with zero errors

**Partial (2026-09-30, intelligence Round G).** Pointer — re-verified at HEAD `1b71ca1`: unchanged. `RESTORE_TABLE_ORDER` still places `process_flows` (`lib/dataRestore.ts:417`) and `entity_mentions` (`:421`) before `knowledge_libraries` / `knowledge_sources` / `knowledge_documents` (`:452-453`), and no test derives FK order from the migrations. This residual is intelligence **I-01 phase B**: move the three knowledge tables ahead of the two referrers and add the FK-order test (every referenced table's index below its referrer's, derived from `supabase/migrations`), as a narrow edit on the version of `lib/dataRestore.ts` that admin-and-org **P1** (`ORG-1` / `BKP-3` / `BKP-5` / `BKP-12`) rewrites — after P1 merges, never before; P1 owns `planRestore` and `CONFLICT_TARGETS`, phase B touches only the order array. Cross-note on `BKP-12`.

---

<a id="ilife-3"></a>

## ILIFE-3 · The only full backup an admin can download cannot be read by the restore page — two incompatible ZIP layouts

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/clientBackup.ts:124`, `app/(protected)/admin/restore/page.tsx:113`, `app/(protected)/admin/restore/page.tsx:117`, `lib/exportRunner.ts:134`, `lib/exportRunner.ts:159`, `app/(protected)/admin/data-export/page.tsx:140`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. 'files-manifest.json' does not satisfy /(^|\/)manifest\.json$/ (the char before is '-'), so the Full ZIP is rejected outright. The manifest.json + tables/*.json layout is produced only by lib/exportRunner.ts:134/:159, whose zip is built for delivery destinations (buildAndDeliverExport, called only from /api/data-export/run and /run-scheduled) and is never offered as a browser download — the page's own button at :140 calls startGlobalBackup → clientBackup. Restore's UI copy ('Drop the Full ZIP (records + files)', :316/:339) therefore advertises a path that cannot work.

**Mechanism.** Two ZIP producers exist with different internal layouts. lib/exportRunner.ts (server, destination/scheduled pushes only) writes `zip.file("manifest.json", ...)` at :134 and one file per table under `tables/` at :159-161. lib/clientBackup.ts (the browser-built "Full ZIP with binaries") writes the whole envelope as ONE entry: `zip.file("data.json", JSON.stringify(envelope, null, 2))` at :124 — no manifest.json, no tables/ folder. The restore page reads only the exportRunner layout: `const manifestPath = entryNames.find((p) => /(^|\/)manifest\.json$/i.test(p)); if (!manifestPath) throw new Error("No manifest.json — this doesn't look like a manufacturing-os backup ZIP.")` (page.tsx:113-114), then `entryNames.filter((p) => /(^|\/)tables\/[^/]+\.json$/i.test(p))` (:117). `files-manifest.json` does not satisfy the regex (a hyphen precedes "manifest.json", not `^` or `/`). The data-export page's "Download Full ZIP" button calls `startGlobalBackup(activeOrgId)` (page.tsx:140) → clientBackup; `/api/data-export/run` is only invoked with a `destinationId` (page.tsx:152-156), never for an inline download. So the restore-compatible ZIP is produced ONLY when pushed to a customer's own S3/R2/webhook.

**Failure scenario.** An admin loses the workspace. They open /admin/data-export, click "Download Full ZIP with binaries" (the one advertised as JSON + every PDF/DWG, SHA-256 verified), get backup-<org>-<date>-part1.zip … partN.zip. They open /admin/restore — whose own header says "Drop a backup — the Full ZIP (records + binaries) or the JSON export" (restore/page.tsx:5) — drop part1.zip, and get "No manifest.json — this doesn't look like a manufacturing-os backup ZIP." Parts 2..N contain no data.json at all (clientBackup.ts:124 writes it only into the part-1 zip object before the loop), so the file payload in those parts is unreachable by the restore flow even after a manual workaround. The workaround — unzip part1, drop the extracted data.json into the JSON branch — is nowhere documented, and it restores records only from part 1's envelope while the ZIP's `files/` payload (the whole point of the Full ZIP) is never re-uploaded because putFilesBack() reads `zipRef.current`, which is only set on the successful ZIP branch (page.tsx:124).

**Evidence.**

```
lib/clientBackup.ts:124 `zip.file("data.json", JSON.stringify(envelope, null, 2));` vs app/(protected)/admin/restore/page.tsx:113-117 `const manifestPath = entryNames.find((p) => /(^|\/)manifest\.json$/i.test(p)); if (!manifestPath) throw new Error("No manifest.json …"); … const tablePaths = entryNames.filter((p) => /(^|\/)tables\/[^/]+\.json$/i.test(p) …)`. lib/exportRunner.ts:134 `zip.file("manifest.json", JSON.stringify(envelope.manifest, null, 2));` and :158-161 `const tableFolder = zip.folder("tables"); for (const [name, rows] of Object.entries(envelope.tables)) { tableFolder?.file(`${name}.json`, …) }`.
```

**Chain reaction.** Every intelligence table rides in that envelope — knowledge_libraries/documents/chunks/page_entities/questions, codebook_entries+config, proposed_links, entity_mentions, process_flows, link_rules, answer_skills, drawing_audit_logs. A backup that cannot be dropped into the restore page means the entire AI/graph layer is unrecoverable through the product's own path, which is exactly the PSM/OSHA records-retention promise the feature exists to make.

> **Verifier correction.** The headline is false. A restore-compatible ZIP IS downloadable from the UI: app/(protected)/admin/storage/page.tsx:738-756 `downloadZip` POSTs `/api/data-export/run` with `{ orgId, includeFiles: true }` and NO destinationId, which app/api/data-export/run/route.ts:129 routes to `{ kind: "inline" }` and :206-215 streams back as `manufacturing-os-backup-<archiveId>.zip` — i.e. the exportRunner manifest.json+tables/ layout. So the claim "produced ONLY when pushed to a customer's own S3/R2/webhook" is refuted. Two further mitigations: the restore page also accepts a plain .json envelope (page.tsx:126-128), and clientBackup's `data.json` IS that envelope, so an admin can unzip part1 and drop data.json. What survives is narrower: the /admin/data-export "Full ZIP with binaries" (the only path that packs multi-GB binaries — clientBackup.ts:1-20 documents that the server-built ZIP "hung forever and delivered nothing" at real scale) produces parts the restore page's ZIP branch rejects outright, and only that path can put files back (page.tsx:224-260 reads `files/…` from the ZIP). HIGH, not CRITICAL.

**Done when.**

- [ ] Dropping the part-1 ZIP produced by "Download Full ZIP with binaries" into /admin/restore parses and produces a plan, without manual unzipping
- [ ] Either clientBackup emits manifest.json + tables/<name>.json (matching exportRunner), or the restore page's ZIP branch also accepts a single data.json entry containing {manifest, tables}
- [ ] A test asserts round-trip: the ZIP entry names clientBackup writes satisfy the restore page's manifest and tables regexes
- [ ] Multi-part backups have a documented restore procedure (which part carries records, how files/ from parts 2..N get re-uploaded)

**Partial (2026-09-30, intelligence Round G).** Pointer — re-verified at HEAD `1b71ca1`: unchanged. `lib/clientBackup.ts:124` writes the envelope as `data.json`; the restore page's ZIP branch still requires `manifest.json` (`app/(protected)/admin/restore/page.tsx:115`). Owner: admin-and-org **P1** (`BKP-7` — one archive layout, both producers; `BKP-10` — per-part manifests). This finding's round-trip test (clientBackup's entry names satisfy the restore page's regexes) and the documented multi-part procedure ride `BKP-7`; cross-note there.

**Resolution (2026-10-01, intelligence Round G — closed by pointer by the integrator at the admin-and-org P1 merge).** Every done-when holds on the integration branch, landed by admin-and-org P1 (`BKP-7`, `BKP-10`; `DEC-75` §6): (1) the part-1 ZIP the browser's Full ZIP writes is read by the restore page and planned without unzipping — the page passes every dropped part to `readBackupArchive` (`lib/dataRestore.ts`), which reads the parts of one backup in any order; (2) `lib/clientBackup.ts` now writes `manifest.json` + `tables/<table>.json` (the server ZIP's layout, `lib/clientBackup.ts:166`), and an older `data.json` archive is still read; (3) `lib/__tests__/restoreArchiveRoundTrip.test.ts` ("BKP-7 — the browser-built Full ZIP is written in the one layout and restores end to end", :243-340) drives the real producers through `readBackupArchive`, `/begin` and `/apply-table` into another workspace; (4) the multi-part layout and procedure — which part carries the records, how `files/` of every part is put back — is documented in `lib/clientBackup.ts`'s header (:20-30) and `DEC-75` §6, and the page puts files back from every part.

---

<a id="ilife-4"></a>

## ILIFE-4 · The restore path the UI actually uses never aborts on a failed parent table — the abort logic lives in a dead route

- **Severity:** HIGH
- **Status:** OPEN
- **Assigned:** admin-and-org P3 (done-when 2: delete `/api/admin/restore/apply` or wire it as the page's small-backup path) — by the integrator, 2026-10-01 (at the admin-and-org P1 merge: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/restore/page.tsx:190`, `app/(protected)/admin/restore/page.tsx:202`, `app/(protected)/admin/restore/page.tsx:207`, `app/api/admin/restore/apply/route.ts:115`, `app/api/admin/restore/apply-table/route.ts:80`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the dead-route claim: a repo-wide grep for '/api/admin/restore/apply' finds only apply-table call sites (page.tsx:196) and the route's own file — nothing ever POSTs to apply/route.ts. Partial credit to the UI: failedTables IS surfaced at :450, but the advice there ('re-run the restore, it's additive and safe') does not fix an FK-ordering failure, and children of a failed parent are still inserted wherever the column is nullable.

**Mechanism.** /api/admin/restore/apply contains the careful stop-on-failure logic, with the reasoning spelled out at :116-119: "STOP. Tables are FK-ordered parents-before-children: continuing after a parent failure inserts children referencing rows that never landed (orphans) while the response says ok." Two differently-shaped greps (`restore/apply\b|restore/apply"|restore/apply?` and `admin/restore/apply[^-]`) across all .ts/.tsx find NO caller: the only hits are the route file's own header comment and Next's generated .next/types. The live path is the chunked one: restore/page.tsx:190 loops tables, :202 `if (!res.ok) { tableFailed = true; break; }` breaks only the inner chunk loop, then :207-208 `if (tableFailed) failedTables.push(table); tablesDone++;` and the OUTER table loop continues to the next table. apply-table/route.ts:80-82 returns 500 per chunk with no knowledge of ordering.

**Failure scenario.** process_flows fails on its FK (previous finding). The client records it in failedTables and proceeds to entity_mentions (fails too), then to every remaining table. Restore "completes" with a done phase and a totalInserted count. Children whose parents never landed are inserted wherever the FK is nullable or absent — e.g. knowledge_documents.source_document_id has no FK at all (see the dangling-mirror finding), so mirrors restore pointing at documents that may have failed earlier; document_equipment_suggestions and asset_files restore under documents that a mid-run documents failure left absent. The admin sees a green "done" with a list of table names and no statement of what that implies.

**Evidence.**

```
app/(protected)/admin/restore/page.tsx:200-209 `const body = await res.json().catch(() => null); if (!res.ok) { tableFailed = true; break; } … } if (tableFailed) failedTables.push(table); tablesDone++; }` — the enclosing `for (const table of order)` at :190 is never broken. Contrast app/api/admin/restore/apply/route.ts:115-125 `if (error) { // STOP. Tables are FK-ordered parents-before-children … for (const remaining of order.slice(idx + 1)) { results.push({ name: remaining, inserted: 0, error: \`skipped: aborted after ${name} failed\` }); } break; }`.
```

**Chain reaction.** Every FK-ordering defect in RESTORE_TABLE_ORDER converts from "loud, safe abort" into "silent partial restore". Because the graph drops edges whose endpoints are missing (lib/orgGraph.ts:174), the resulting workspace looks structurally clean and is quietly missing links nobody can enumerate.

> **Verifier correction.** Two overstatements. (1) "looks healthy" is too strong: failedTables IS rendered to the admin at page.tsx:450 (`Some tables reported issues: …`), albeit inside a green "Records restored" panel. (2) Real orphaning is narrower than claimed: any child with an enforced FK to a row that never landed fails its own insert (23503) rather than becoming an orphan, so silent orphans are limited to FK-less soft references (knowledge_documents.source_document_id, process_flows from_ref/to_ref, entity_mentions.asset_id is FK'd). HIGH, not CRITICAL.

**Done when.**

- [ ] The chunked restore in restore/page.tsx stops at the first table failure and reports the remaining tables as skipped, matching the /apply route's documented contract
- [ ] /api/admin/restore/apply is either deleted or wired as the small-backup path, so its abort logic is not dead code
- [ ] The restore result UI states the consequence of a failed table ("stopped at <table>; N tables not attempted"), not just a list of names

**Partial (2026-09-30, intelligence Round G).** Pointer — re-verified at HEAD `1b71ca1`: unchanged. The chunked loop records a failed table and moves on (`app/(protected)/admin/restore/page.tsx:190-208` — `if (!res.ok) { tableFailed = true; break; }` breaks the chunk loop only); `/api/admin/restore/apply` still exists with no caller; the result panel lists failed tables without the consequence (`:451`). Owner: admin-and-org **P1** — `BKP-5` criterion 2 is this finding's criterion 1, and `ORG-1` / `BKP-3` decide the fate of `/apply` (criterion 2). Cross-note on `BKP-5`.

**Partial (2026-10-01, intelligence Round G — recorded by the integrator at the admin-and-org P1 merge).** (1) ✓ The page's chunked restore stops at the first table that fails and names the tables it did not attempt (`lib/dataRestore.ts` `runChunkedRestore`, landed by P1 `BKP-5`). (3) ✓ The result panel says "Restore stopped at <table> — N table(s) not attempted" and lists them (`app/(protected)/admin/restore/page.tsx:551`, :583). (2) **Not met:** `/api/admin/restore/apply` is kept — it shares the write path and the stop rule (`applyRestoreChunk`), so its logic is no longer a separate copy — but nothing in the app calls it: neither deleted nor wired as the small-backup path. Remainder → admin-and-org P3.

---

<a id="ilife-5"></a>

## ILIFE-5 · knowledge_documents.source_document_id has no foreign key — deleting a controlled document leaves its whole AI shadow alive

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** admin-and-org P2 (the storage-key registry extended to the document shed) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260917_knowledge_sources.sql:54`, `supabase/migrations/20260911_knowledge_ai.sql:81`, `supabase/migrations/20260921_drawing_entities.sql:24`, `lib/knowledge.ts:467`, `app/(protected)/documents/[libraryId]/page.tsx:1011`, `lib/knowledgeSourceSync.ts:286`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The claim is right about the schema and wrong about permanence. A deleted controlled document drops out of `wanted`, so the next sweep deletes the mirror and knowledge_chunks/knowledge_page_entities/entity_mentions cascade on their real FKs to knowledge_documents(id). Ask is also already guarded for ordinary users — app/api/knowledge/ask/route.ts:176-183 excludes any mirror whose source_document_id is not in readableControlledDocIds, and a deleted doc can never be in it. Residual risk that keeps this alive at MEDIUM: up to ~24h of exposure; controllers bypass the ask filter entirely (lib/knowledgeAccess.ts:196 `if (principal.isController) return new Set(docIds);` returns ids of rows it never looked up); and syncAllKnowledgeSources caps at `maxLibraries = 25` taken unordered and deployment-wide, so past 25 source-linked libraries some are never swept.

**Mechanism.** The mirror link is a bare column: `ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS source_document_id UUID;` (20260917:54) — no REFERENCES clause, confirmed by grepping every `source_document_id` in supabase/ for a FK (only process_flows→knowledge_documents, cost_control→cost_documents and 20261013→documents have one). Deleting a controlled document (`await supabase.from("documents").delete().eq("id", id)` at documents/[libraryId]/page.tsx:1011) cascades everything that DOES have an FK — proposed_links (both endpoints), entity_mentions.document_id, document_equipment_suggestions, document_related_resources, document_assets, asset_files, recently_viewed_docs — but the knowledge mirror is untouched, and with it knowledge_chunks (FK→knowledge_documents, 20260911:81), its pgvector embeddings, knowledge_page_entities (20260921:24), knowledge_line_traces, and entity_mentions rows keyed on knowledge_document_id. The only cleanup is the sync's REMOVE pass at knowledgeSourceSync.ts:286-292, which requires the library to have a knowledge_source AND to be inside the first-25 slice (previous finding).

**Failure scenario.** A superseded P&ID is deleted from doc control for a PSM reason. Its knowledge mirror, chunks, embeddings and extracted page entities survive. The library keeps answering questions from it with citations; entity_mentions rows keep the asset↔document backlink alive on /assets/[tag] pointing at a knowledge document whose controlled source no longer exists; the Bridge's gate `if (!kdoc?.source_document_id) return null` passes because the column is non-null — it just points at a row that is gone. For libraries fed by direct upload rather than sources, no sweeper exists at all and the shadow is permanent.

**Evidence.**

```
supabase/migrations/20260917_knowledge_sources.sql:51-56 `ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES knowledge_sources(id) ON DELETE CASCADE; ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS source_document_id UUID; ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS source_version_id UUID;` — source_id gets a FK on the line above; source_document_id and source_version_id deliberately do not. lib/knowledge.ts:467-470 `export async function deleteKnowledgeDocument(id: string): Promise<void> { const { error } = await supabase.from("knowledge_documents").delete().eq("id", id); …}` — the reverse direction also drops the R2 object's only in-app owner, relying on the 7-day orphan sweeper.
```

**Chain reaction.** A second-order hazard rides the same shared key: the mirror stores `file_key: version.file_url` (knowledgeSourceSync.ts:229), the SAME R2 object as the controlled version. The space-saver deletes those objects for superseded revisions (app/api/admin/shed/commit/route.ts:103 DeleteObjectsCommand over document_versions.file_url) and knows nothing about knowledge_documents — so a shed run between a rev-up and the next cron sync deletes the bytes a still-'ready' mirror points at, after which deep read (renderKnowledgePages returns [] on any error, lib/knowledgePageRender.ts:53-55) and line tracing fail silently while chunks keep citing the page.

**Done when.**

- [ ] source_document_id either gets `REFERENCES documents(id) ON DELETE SET NULL` (keeping the mirror but marking it unsourced) or an explicit delete-time sweep that removes the mirror and its chunks/entities/mentions
- [ ] Deleting a controlled document is traced end-to-end in a test: chunks, page entities, embeddings, mentions and line traces for its mirror are all gone or explicitly marked orphaned
- [ ] The shed's candidate query excludes any file_url still referenced by a knowledge_documents.file_key

**Partial (2026-09-30, intelligence Round G).** Confirmed first by reading: `20260917:54` has no REFERENCES clause, and grep finds no FK on the column. Per the decision's default (`DEC-58`), migration `20261122_intel_roundG_ingest_integrity.sql` §6 does two things in the same paste:

1. It deletes every mirror whose `source_document_id` names no document. Their chunks, page entities, mentions and traces go with them through the existing cascades, and the pre-apply inventory counts them first (DEC-30).
2. It then adds `knowledge_documents_source_document_fk FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE CASCADE`.

From then on, deleting a controlled document removes its AI shadow in the same statement. That covers the controller path as well: `lib/knowledgeAccess.ts:196` returns ids without looking them up, but no mirror survives to be returned.

Tests: `lib/__tests__/intelRoundGIngestMigration.test.ts`:
- "dangling mirrors are purged BEFORE the key, inside the transaction, then the key is ON DELETE CASCADE";
- "every table derived from a knowledge document cascades from it — traced across the numbered sequence". It derives from the numbered migrations that chunks (and the `embedding` column they carry), page entities, entity mentions and line traces all cascade from `knowledge_documents`, and that the only other referrer, `process_flows.source_document_id`, is `SET NULL` by design;
- "the verification SELECT checks the key and the whole cascade chain". The paste's own probes check the live chain.

**Done-when.**
- ✓ `source_document_id` REFERENCES `documents(id)`. The decision chose `ON DELETE CASCADE`, so no AI shadow outlives its controlled document.
- ✓ Deleting a controlled document is traced end to end: chunks, embeddings, page entities, mentions and line traces all cascade. The trace is a static test over the sequence plus the migration's live probes; there is no database in this environment to delete against.
- ✗ Not done here. The shed's candidate query (`app/api/admin/shed/commit/route.ts`) belongs to document-control (P9 RET-6/RET-7). It still does not exclude a `file_url` referenced by a `knowledge_documents.file_key`, so the chain reaction (a shed between a rev-up and the next sync) is open.

**Scope / residual.** Pending migration: `20261122_intel_roundG_ingest_integrity.sql`. OPEN until the shed guard lands.

**The key and a restore** (corrected in intelligence Round G review fix pass 3). The first record said "the key does not break a restore" and "will now refuse that one row". Both are wrong. `lib/dataRestore.ts` does restore `documents` before `knowledge_documents` (`RESTORE_TABLE_ORDER`), so a consistent backup restores. But the dangling-mirror population this finding describes exists between a controlled document's delete and the next sync's REMOVE pass. A backup taken in that window, or any backup taken before `20261122`, can hold such a mirror, and once the key exists that row fails with 23503:
- **The single-shot restore** (`app/api/admin/restore/apply/route.ts`, lines 102-122) stops at the `knowledge_documents` chunk. It then skips every later table: `knowledge_chunks`, `knowledge_page_entities`, `knowledge_questions`, `output_templates` and `output_generations`.
- **The chunked restore** (`app/api/admin/restore/apply-table/route.ts`, lines 85-94) allows a per-row refusal only for `document_holds`. It answers 500 for the whole 500-row slice.

So the whole knowledge restore aborts, not one row. **Handoff to I-01, which owns restore:** the restore must drop mirrors whose `source_document_id` is absent from the restored documents. Alternatively, it can add `knowledge_documents` to the per-row refusal set (23503) and teach the single-shot path the same per-row refusal. The migration's header and `DEC-58`'s Risk line now say this.

**Partial (2026-10-01, admin-and-org Round G, P2).** The predicate landed; its call site is not this package's.

`lib/storageKeyRegistry.ts keysReferencedOutside(sb, keys, except)` returns the keys among `keys` that any registered plain key column still names. The case that matters is `knowledge_documents.file_key`, which names the SAME object as the controlled revision it mirrors (`lib/knowledgeSourceSync.ts` writes `file_key: version.file_url`). The read is:
- bucket-wide, like the sweep's reference set (`DEC-57`);
- fail-closed on any read error;
- skips the `table.column` entries the caller has already judged.

Reproduced on HEAD: the document shed's two guards are `partitionOrgKeys` (RET-6) and `sharedLiveKeys` (RET-8). `sharedLiveKeys` reads `document_versions` only (`lib/shedKeyGuard.ts:64-86`) and is called at `app/api/admin/shed/route.ts:98` (produce and preview, `refineSelection`) and `app/api/admin/shed/commit/route.ts:118` (commit). Neither consults `knowledge_documents`, so a shed between a rev-up and the next sync still deletes bytes a 'ready' mirror points at.

Tests: `lib/__tests__/storageKeyRegistry.test.ts`, "ILIFE-5 — keysReferencedOutside: the predicate a step freeing a revision's bytes must consult":
- a key a knowledge mirror still names is kept, and a key nothing else names is not;
- every plain key column is checked except the excluded ones;
- an unreadable column refuses.

**Handoff — the exact call-site hunks.** The shed routes are document-control's (P9 merged), and no running package lists them:
```diff
--- app/api/admin/shed/route.ts   (refineSelection, :93-101)
+import { keysReferencedOutside } from "@/lib/storageKeyRegistry";
 …
   const shared = await sharedLiveKeys(sb, orgId, owned.map((r) => r.file_url as string), insideIds);
-  const rows = shared.size === 0 ? owned : owned.filter((r) => !shared.has(r.file_url as string));
+  // ILIFE-5: a key a knowledge mirror (or any other registered column) still names is never claimed.
+  const elsewhere = await keysReferencedOutside(sb, owned.map((r) => r.file_url as string), ["document_versions.file_url"]);
+  const rows = owned.filter((r) => !shared.has(r.file_url as string) && !elsewhere.has(r.file_url as string));
--- app/api/admin/shed/commit/route.ts   (the RET-8 block, :116-126)
+import { keysReferencedOutside } from "@/lib/storageKeyRegistry";
 …
     const shared = await sharedLiveKeys(sb, orgId, versions.map((v) => v.file_url as string), linkedIds);
+    // ILIFE-5: never free bytes a knowledge mirror still names.
+    for (const k of await keysReferencedOutside(sb, versions.map((v) => v.file_url as string), ["document_versions.file_url"])) shared.add(k);
     if (shared.size > 0) {
```
Both sit inside the existing `try` that answers 503 (produce: the GET / POST catch; commit: "… Nothing was freed.") on a read error. With them, a revision whose key a mirror names is never claimed and never freed, and is counted in `sharedSkipped`. Test shape: `lib/__tests__/dcRoundFShed.test.ts`'s RET-8 cases, with a `knowledge_documents` row naming the key.

*Added at the review fix pass:* **the second call site, the direct storage delete.** The brief named `lib/retention.ts` and `app/api/storage/delete/route.ts` as document-control P14's. (*Corrected at the final review fix pass:* P14's brief does not list this change; the hunk is handed off, see the Resolution's Scope / residual below.) `lib/retention.ts` frees no bytes: no `DeleteObject`, `deleteFile` or storage-delete call; it marks records. The route does free bytes. It refuses a key a held or retained revision names (`file_url` / `source_file_key`), but it never asks whether a knowledge mirror still names it. So a Controller's delete of a superseded revision's file kills a 'ready' mirror's source in the same way. The hunk, for the route's owner (document-control), goes after the hold / retention `try` and before the custody row:
```diff
--- app/api/storage/delete/route.ts   (after the hold / retention refusal, before the STORAGE_OBJECT_DELETE custody row)
+import { keysReferencedOutside } from "@/lib/storageKeyRegistry";
 …
+  // ILIFE-5: never delete a revision's bytes that a knowledge mirror (or any other
+  // registered column outside document_versions) still names. Fail closed.
+  try {
+    const elsewhere = await keysReferencedOutside(supabaseAdmin, [path], ["document_versions.file_url", "document_versions.source_file_key"]);
+    if (elsewhere.size > 0) {
+      return NextResponse.json({ error: "Another record still uses this file (a knowledge-library copy or similar); it cannot be deleted." }, { status: 409 });
+    }
+  } catch {
+    return NextResponse.json({ error: "Could not verify what still uses this file; deletion refused." }, { status: 503 });
+  }
```
The route's one caller in the app, `lib/costDocs.ts` (`deleteFile(key)` after the `cost_documents` row is gone), is unaffected: its row no longer names the key. Test shape: the route's existing hold / retention cases, with a `knowledge_documents` row naming the key.

**Done-when.**
1. ✓ (intelligence Round G, above).
2. ✓ (above).
3. ◐ — the predicate exists and is tested, but neither the shed's candidate query nor the direct storage delete calls it yet. OPEN on the two handoffs above.

**Resolution (2026-10-01, admin-and-org Round G).** Package P2, second review fix pass. The review found that the shed hunks above had no owner: the shed routes are on no running package's list, since document-control P9, which wrote them, has merged. P2 had already edited another file on no package's list for the same reason (`app/api/admin/schema-health/route.ts`). So the two hunks are landed here, as recorded above:
- **Preview and produce.** In `app/api/admin/shed/route.ts refineSelection`, after RET-8's `sharedLiveKeys`, the route calls `keysReferencedOutside(sb, keys, ["document_versions.file_url"])`. A superseded revision whose key a knowledge mirror still names is never claimed. The same holds for a key any other registered plain key column names. Such a revision is counted in `sharedSkipped`.
- **Commit.** In `app/api/admin/shed/commit/route.ts`, the RET-8 block adds the same keys to `shared`, so they are never stamped and never freed.
- **Fail closed.** Both calls sit inside the existing `try`. A read error answers 503: preview and produce refuse, and commit says "… Nothing was freed."
- **Wording.** The commit notes and the archive's `ARCHIVE.txt` now say "a current revision or a knowledge-library copy".

Tests are in `lib/__tests__/dcRoundFShed.test.ts`, "document shed — intelligence ILIFE-5: a key a knowledge-library mirror still names is never claimed, never freed":
- preview and produce leave the mirrored revision out, and count it;
- a commit of an archive that a pre-fix produce linked stamps and deletes only the other key;
- a failing mirror read answers 503 on preview, produce and commit, with nothing claimed, stamped or deleted.

Mutation-checked: with the two route hunks removed, all three fail.

**Done-when.**
1. ✓ — intelligence Round G (`20261122`, pending paste).
2. ✓ — the same.
3. ✓ — the shed's candidate selection (preview and produce) excludes any `file_url` a `knowledge_documents.file_key` still names, and so does its commit. **RESOLVED on this criterion's wording only.** A second door still frees a key that a knowledge mirror names. `app/api/storage/delete/route.ts` (`DELETE`) checks holds and retention, writes the custody row and deletes the object, and never calls `keysReferencedOutside`. So a Controller's delete of a superseded revision's file still destroys the bytes that a 'ready' mirror points at. That door is OPEN, below.

**Scope / residual.** The direct storage delete (`app/api/storage/delete/route.ts`, the second call site found at the first review fix pass) frees bytes too. It is outside this finding's criteria and outside this package's brief, and it is still open. *Corrected at the final review fix pass:* this said the route is in document-control P14's brief and handed its hunk to P14 by name, but P14's brief does not list it. The hunk recorded above ("the second call site") is handed off; the integrator assigns the owner at the P2 merge (proposed: admin-and-org P3, after document-control P14 merges). The handoff is recorded in `audit-reports/document-control/99-fix-sequencing.md`. Migration `20261122` (criteria 1 and 2) is still to be pasted.

**Final review fix pass (2026-10-01, admin-and-org Round G, P2).** The guard could fail open on a capped read. `keysReferencedOutside` read `.select(column).in(column, <200 keys>)` and trusted whatever came back. A PostgREST max-rows cut (1,000 rows by default) is silent, and a hit it cuts off is a referenced object that the shed then frees. The read now asks for `count: "exact"` and throws "… refusing to proceed" in two cases: when the count is above the rows returned, or, with no count in the answer, when a page is as large as the default cap. Both shed callers already turn the throw into a 503 that frees nothing (`refineSelection` for preview and produce; the RET-8 block, "… Nothing was freed.", for commit).

Tests:
- `lib/__tests__/storageKeyRegistry.test.ts`, "a read a server row cap cut short refuses …": a stand-in capped at 5 rows over 12 hits refuses, a countless full page of 1,000 refuses, and under the cap every hit returns.
- `lib/__tests__/dcRoundFShed.test.ts`, "fails CLOSED when a server row cap cuts the mirror read short …": preview, produce and commit answer 503, with nothing claimed, stamped or deleted.

Negative control: with `lib/storageKeyRegistry.ts` as at `45f0c1b`, both fail. `lib/shedKeyGuard.ts sharedLiveKeys` (RET-8, document-control's file, not this package's) has the same unpaged `.in()` shape over `document_versions` and is unchanged. It is noted for its owner.

---

<a id="ilife-6"></a>

## ILIFE-6 · Every paginated dump uses .range() with no .order() — the backup and the orphan reference set can silently skip rows

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** admin-and-org P3 (criterion 3, the purge-side re-check in `lib/storageOrphans.ts` `deleteOrphans`; after document-control P14 merges) — by the integrator, 2026-10-01 (admin-and-org P2 merge: P2 landed the keyset paging of criteria 1–2 and handed the re-check off; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** SUSPECTED
- **Locations:** `lib/dataExport.ts:299`, `lib/dataExport.ts:300`, `lib/storageOrphans.ts:97`, `lib/storageOrphans.ts:99`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. PostgREST emits no ORDER BY, so LIMIT/OFFSET paging has no stable ordering; a concurrent UPDATE that rewrites a tuple (the embed drain writing knowledge_chunks.embedding) moves it in heap order and can shift rows across the page boundary, dropping or duplicating them. Nothing detects it: the loop's only termination check is `rows.length < pageSize`, and `complete` is derived solely from failedTables, so a short-changed dump still reports complete: true. Same defect makes the orphan reference set incomplete — with fail-closed behaviour only for query ERRORS (:95-97), not for silently missed rows.

**Mechanism.** dumpTable pages with `let q = sb.from(table).select("*").range(from, from + pageSize - 1);` and loops `while (true) { … if (rows.length < pageSize) break; from += pageSize; }` — no ORDER BY. Postgres gives no ordering guarantee across separate LIMIT/OFFSET queries; row order can shift between pages under concurrent writes, autovacuum, or a parallel/bitmap plan, so a row can be returned twice or skipped entirely. collectReferencedKeys has the identical shape at :97-104. Both operate on the largest tables in the system: knowledge_chunks (one row per chunk per page per document) and document_versions.

**Failure scenario.** An export runs while the embed drain is writing knowledge_chunks.embedding (both ride the same maintenance cron — cron/maintenance/route.ts:293 drainEmbedBacklog with a 100s budget). The concurrent UPDATEs move rows; page 3 of the dump skips 40 chunks. The manifest still reports `complete: true` because complete is computed from `failedTables.length === 0` (dataExport.ts:248) — a skipped row is not an error. The customer's "complete export of every record this organization owns" (the literal note at :217) is silently short. In the sweeper the same skip is worse: a document_versions row missed on a page boundary means its file_url is absent from `referenced`, so a LIVE current-revision PDF is classified as an orphan and permanently deleted — defeating the module's stated fail-closed design.

**Evidence.**

```
lib/dataExport.ts:299-311 `while (true) { let q = sb.from(table).select("*").range(from, from + pageSize - 1); … const { data, error } = await q; if (error) throw new Error(error.message); const rows = data ?? []; out.push(...rows); if (rows.length < pageSize) break; from += pageSize; }`. lib/storageOrphans.ts:96-104 `let from = 0; for (;;) { const { data, error } = await sb.from(table).select(select).range(from, from + 999); … if (rows.length < 1000) break; from += 1000; }`. Neither call chain contains `.order(` — grep for `order(` across both files returns nothing.
```

**Chain reaction.** This is the one defect whose damage is invisible on both ends: an export that silently omits rows produces a restore that silently omits them too, and the manifest asserts completeness. Nothing downstream can detect it because there is no row-count reconciliation between manifest.tables[].rowCount and a source-of-truth count.

> **Verifier correction.** Verification downgraded to SUSPECTED: no run of the app or database was possible, so a duplicated/skipped row is a mechanism, not an observation — it needs concurrent writes or a plan change during the export to materialize, and small tables (a single short page) are unaffected entirely. Citation drift in the second location: the storageOrphans loop is at :92-102, not :97-104 (`let from = 0;` is :92, the select is :94).

**Done when.**

- [ ] Every paginated dump adds a stable, unique sort key (e.g. `.order("id", { ascending: true })`, or keyset pagination on id) before .range()
- [ ] dataExport records a COUNT(*) per table taken in the same read and flags a mismatch against rows.length as a manifest error, so a short page cannot report complete:true
- [ ] collectReferencedKeys pages deterministically — a missed reference must be impossible, not merely unlikely, given deleteOrphans is irreversible

**Partial (2026-09-30, intelligence Round G).** Neither half is closed. Re-verified at HEAD `1b71ca1`.
- *Orphan sweep.* Document-control [`XEDGE-13`](../document-control/11-edges-and-invariants.md) (Phase 6) made `collectReferencedKeys` page every source `.order("id", { ascending: true }).range(from, from + 999)` (`lib/storageOrphans.ts:104-120`) and compare the rows paged with an exact per-table `count` taken after the loop, aborting on a mismatch (`:121-131`) — criterion 1 ✓ for the sweeper. Criterion 3 ✗: those are still OFFSET windows, and a count taken after the scan cannot rule out a skip. When a row the scan has already read is deleted before the next window, every later row moves up one place, the first row of the next window is never read, and the count equals the paged total, so nothing aborts; a delete plus an insert balances the count the same way. Reproduced against the real collector: `lib/__tests__/intelRoundGRecords.test.ts` "ILIFE-6 criterion 3 …" — 1,500 `document_versions` rows, `v00010` deleted after the first window, and `collectReferencedKeys` returns without error and without `v01001`'s key (an `it.fails`: it asserts what this criterion requires, and fails the suite once the fix makes it hold, so the fixer flips it). In production the collector is bucket-wide, so a delete by ANY tenant in any of the 11 source tables during a purge can hide a live reference, and `deleteOrphans` (`:195-210`) then permanently deletes that object if it sits under the caller's prefix and is older than 7 days. The fix is keyset pagination — `.gt("id", lastId).order("id", { ascending: true }).limit(1000)` — so a delete never moves a window. Keyset alone still lets one case balance the count (a row already read is deleted while a row is inserted behind the cursor, since ids are random UUIDs), so "impossible" also needs the owner to re-check each candidate key against the source columns just before `DeleteObjects`, or to read the reference set in one snapshot. Cross-note on `XEDGE-13`, whose status is document-control's.
- *Export.* `dumpTable` still pages `select("*").range(…)` with no `.order` (`lib/dataExport.ts:315`), and the manifest's `complete` is still `failedTables.length === 0` (`:262`) with no per-table count reconciliation — criterion 1 (for the export) and criterion 2 open.

Owner of both halves: admin-and-org **P2** — `BKP-2` owns the reference collector, and the export contract is `lib/dataExport.ts`; cross-note on `BKP-2`. A&O P2's plan does not carry criterion 3 today (it lists "BKP-2 pagination half ← DC XEDGE-13" as already resolved), so the integrator adds the keyset fix to it together with the two test edits the fix forces: flip `intelRoundGRecords.test.ts` "ILIFE-6 criterion 3 …" from `it.fails` to `it` (it fails the suite until flipped — the tripwire is deliberate), and update `destructiveDeletes.test.ts`'s fake, which answers only `.range`. The `BKP-2` cross-note names both edits, so the package that lands the fix reads them in the record it is assigned.

*Cross-note (2026-10-01, admin-and-org Round G, P2): criterion 3's collector half landed. `lib/storageOrphans.ts collectReferencedKeys` pages by keyset (`.order("id").gt("id", last).limit(1000)`), and the tripwire in `lib/__tests__/intelRoundGRecords.test.ts` is flipped to `it` (see `BKP-2`). The balanced case still needs a re-check of each candidate before `DeleteObjects` in `deleteOrphans`: a row already read is deleted while one is inserted behind the cursor. That is the purge side, outside A&O P2's brief. The export half is untouched: `dumpTable`'s stable order and the per-table count reconciliation (criteria 1-2 for the export). A&O P2's plan lists it as resolved elsewhere (`XEDGE-13`), which covers the sweeper only; the integrator assigns an owner.*

**Partial (2026-10-01, admin-and-org Round G, P2 review fix pass).** The export half has landed, and it supersedes the cross-note's "the export half is untouched". This record names A&O P2 as owner of both halves, and the review held P2 to that.

Reproduced at `e2d4ddd`: `lib/dataExport.ts dumpTable` paged `select("*").range(from, from + 999)` with no ORDER BY, and it stopped at the first page shorter than 1,000 rows. `manifest.complete` came only from read errors. A parent-keyed child read added in the same package (`project_members` through 150 project ids at a time) used the same loop. The skip is reproduced in `lib/__tests__/exportContractRoundTrip.test.ts`: on that loop, a row deleted behind the cursor makes the next window skip `d-1000`.

Fix in `lib/dataExport.ts` (`dumpTable` / `readScoped`):
1. **Stable, unique order.** Every page is ordered by the table's key. That is `id`, or, for the ten exported tables with no `id` column, the PRIMARY KEY / UNIQUE key declared in `lib/exportTables.ts EXPORT_ORDER_KEYS` (`exportOrderKey`).
2. **Keyset paging.** A one-column key pages `key > last` with `limit(1000)`, so a delete behind the cursor never moves a page. A composite key (six small link and counter tables) pages by offset in key order, deduplicated by key.
3. **No early stop.** An exact count (`count: "exact", head: true`) is taken first in the same scope. A short page ends the read only once that many rows are in hand, so a PostgREST max-rows setting below 1,000 no longer cuts every table at its first page.
4. **Reconciliation (criterion 2).** If a read ends with fewer rows than the table held both before AND after it, the table is read once more. A delete alone or an insert alone can never cause that under keyset. If the second read is still short, the table is recorded as an error, and the backup is INCOMPLETE with the counts in the message. So a short read can no longer report `complete: true`.

Tests:
- `lib/__tests__/exportContractRoundTrip.test.ts`, "ILIFE-6 (export half) …":
  - a row cap of 7 no longer cuts a table, including a composite-keyed one;
  - a row deleted behind the cursor moves no window;
  - one transient race (unread rows deleted while rows land behind the cursor) heals on the re-read;
  - the same race on both reads makes the table an error and the backup INCOMPLETE.
- `lib/__tests__/exportCoverage.test.ts`, "export paging order tripwire (ILIFE-6)": every exported table has an `id` or an `EXPORT_ORDER_KEYS` entry, and each entry is one of that table's keys in the census.
- The in-memory stand-in (`lib/__tests__/helpers/restoreMemoryDb.ts`) now honours `order`, `limit` and `gt`.
- Checked by mutation: offset paging fails the delete case, and the old short-page stop fails the row-cap case.

**Done-when.**
1. ✓ — the sweeper (`XEDGE-13`, then keyset in A&O P2) and now the export: every paginated dump has a stable, unique sort key and pages by keyset where the key is one column.
2. ✓ — `dataExport` takes an exact count per table (per parent chunk) in the same scope, and a short read becomes a table error, never `complete: true`. The count is taken around the read, not in the same statement. Rows that change while the export runs cannot be told apart from a skip without a snapshot. So a read is flagged only when it is short of both counts, and only after a second read.
3. ◐ — the collector pages by keyset (A&O P2). The balanced case (a read row deleted while a row lands behind the cursor) still needs a re-check of each candidate before `DeleteObjects` in `deleteOrphans`, the purge side. That belongs to document-control (P9 RET-7 owns the purge), and no running package lists it.

**Scope / residual.** OPEN on criterion 3's purge-side re-check. The six composite-keyed tables still page by offset: `curated_collection_items`, `document_equipment_suggestions`, `document_favorites`, `recently_viewed_docs`, `team_members` and `ticket_number_counters`. On those, a balanced write (one read row deleted while a row lands behind the cursor) can hide a skip from the counts. The other 103 exported tables page by keyset.

**Partial (2026-10-01, admin-and-org Round G, P2 second review fix pass).** Four corrections to the export half, and an owner for the purge half.

1. **The composite keys page by keyset too. The residual above understated the gap.** Under offset paging, a single delete of a row already read hid a skip on the six composite-keyed tables, with no balanced insert needed. Take `document_equipment_suggestions` with 1,500 rows for one org. Page 1 reads rows 0 to 999, then row 5 is deleted. Page 2 at offset 1000 starts at the old row 1001, so live row 1000 is never read. The read holds 1,499 rows, the count before was 1,500 and the count after 1,499. The read was not below the count after, so it was not flagged. Now every key pages by keyset: `readScoped` asks for the rows after the last one read, `(a, b) > (x, y)`. That is written as PostgREST's `or(a.gt.x,and(a.eq.x,b.gt.y))` (`lib/dataExport.ts keysetAfter`, which quotes a value only when it holds a reserved character; keys are UUIDs and integers). The in-memory stand-in (`lib/__tests__/helpers/restoreMemoryDb.ts`) now honours `or(...)`. Tests in `lib/__tests__/exportContractRoundTrip.test.ts`:
   - "a composite-keyed table pages by keyset too: …": the 1,500-row case above, with `doc-1000` read and nothing doubled;
   - "a two-column key whose leading column varies pages past a row cap …";
   - "keysetAfter: …".

   Mutation-checked: offset paging for composite keys fails the first.
2. **A twice-short read keeps its rows.** The first fix pass threw a twice-short table away whole: the export carried it empty, and its parent-keyed children failed with it. That is worse than base for a table with steady churn, such as `knowledge_chunks` during a knowledge re-sync or `notifications`. Now:
   - the table keeps every row either read found, once per key (`exportOrderKey`), with the later read's copy winning;
   - it is marked with the new `manifest.tables[].short`, which gives the counts;
   - the backup is INCOMPLETE (`complete: false`), and its note names each short table with its counts and says the rows read ARE included;
   - a short parent still scopes its child through the rows it read, and the child is marked `short` too (`BKP-4`).

   Tests: "still short on the second read: …". The kept rows are asserted exactly: the second read's 2,490 rows, plus the ten that only the first read found. Also "a short PARENT still scopes its child: …".
3. **The user-scoped table records its failures.** `notification_preferences` (`USER_SCOPED_FOR_ORG_TABLES`) is read in a `catch` that recorded no error, so a failed read exported it empty while `complete` stayed true. It now records the error as an org-scoped table does, and a short read marks it `short`. Test: "the user-scoped table (notification_preferences) records a failed read as an error …". Mutation-checked: the old `catch` fails it.
4. **Criterion 2's first ✓ was overstated** for that one table. It holds for every exported table now.

**Done-when.**
1. ✓ — every exported table (109) pages by keyset on a unique key. The collector does too (`BKP-2`).
2. ✓ — an exact count is taken before and after each read. A read short of both is read again, and a second short read makes the backup INCOMPLETE and names the counts, for every exported table, the user-scoped one included. The limit of counts taken around a read is unchanged. A row already read is deleted while a row lands behind the cursor, so both counts equal the rows read and nothing is flagged. Only a single-snapshot read could tell that apart from a skip.
3. ◐ — the collector pages by keyset. The purge-side re-check is handed off; the integrator assigns the owner at the P2 merge (proposed: admin-and-org P3, after document-control P14 merges). *Corrected at the final review fix pass:* this said document-control P14 owns it, as the owner of the other byte-freeing door (`app/api/storage/delete/route.ts`); P14's brief lists neither. The handoff is recorded in `audit-reports/document-control/99-fix-sequencing.md`. The hunk goes in `lib/storageOrphans.ts deleteOrphans`, before each `DeleteObjects` batch:
   ```diff
   +    // ILIFE-6 criterion 3: re-check every candidate just before it is deleted. The scan read the reference set page by
   +    // page, so a reference that moved behind its cursor can be missing; one statement per column sees one snapshot.
   +    const stillNamed = await keysReferencedOutside(sb, batch.map((o) => o.key));   // every plain key column (lib/storageKeyRegistry.ts)
   +    // and every JSON-embedded key column (JSON_KEY_COLUMNS), one containment read per key, e.g.
   +    //   sb.from("tickets").select("id").contains("attachments", JSON.stringify([{ url: key }])).limit(1)
   +    const doomed = batch.filter((o) => !stillNamed.has(o.key));
   ```
   A read error there stops the purge before that batch, with nothing deleted. The test shape is `lib/__tests__/dcRoundFShed.test.ts`'s orphan block: a key the scan missed but a row names at re-check time is kept.

**Scope / residual.** OPEN on criterion 3's purge-side re-check, which is handed off; the integrator assigns the owner at the P2 merge (proposed: admin-and-org P3, after document-control P14 merges). The export half has no open criterion. The restore preview says the same thing for a short table as for a failed one ("some tables were not exported", `lib/dataRestore.ts planRestore`, which this package does not own). The manifest's `tables[]` says which kind each table is.

**Final review fix pass (2026-10-01, admin-and-org Round G, P2).** The user-scoped table's read was one request. `notification_preferences` was read with a single `.in("user_id", <every member id>)`. A workspace of about 400 members makes that a ~15 KB URL, which the server refuses (414, or a header-size refusal). Since the second review fix pass records that failure as a table error, every such workspace's backup would have been stamped INCOMPLETE. The table is now read through `org_members` exactly as a parent-keyed child is read (`lib/dataExport.ts dumpThroughParent`, the loop `dumpOrgTable` already used, factored out):
- `PARENT_ID_CHUNK` (150) member ids per read, with the rows of every slice kept;
- a slice whose read comes up short twice makes the table `short`, with that slice's counts;
- a short `org_members` read makes the table `short` too;
- a failed `org_members` read, or a failed slice, makes the table an error. Before this, a failed `org_members` read left the table clean and empty.

Tests in `lib/__tests__/exportContractRoundTrip.test.ts`, "notification_preferences is read through the members …". The stand-in refuses an id list over 8 KB, as the server refuses the URL.
- With 400 members, the table is read as three slices of at most 150 ids, every member's row arrives, and the backup is COMPLETE.
- A short slice marks the table short, names the slice's 9-of-10 counts, and keeps the other slices' rows.
- A short `org_members` read marks the table short.
- A failed slice, and a failed `org_members` read, fail the table.

Negative control: with `lib/dataExport.ts` as at `45f0c1b`, four of the five fail. The failed-slice case holds both ways and pins the behaviour. Criterion 2's ✓ is unchanged.

---

<a id="ilife-7"></a>

## ILIFE-7 · Manager and DocCtrl can export the entire organization database, contradicting dataExport's own admin-only contract and the Admin-only restore

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/data-export/structured/route.ts:55`, `lib/dataExport.ts:18`, `app/api/admin/restore/apply-table/route.ts:21`, `app/api/admin/restore/begin/route.ts:24`, `lib/exportTables.ts:15`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the route contradicts even itself: its own header comment at :4 says 'Caller must be an Admin or Manager', while the code also admits DocCtrl. The payload is as described — lib/exportTables.ts registers audit_logs (:130), download_audits (:63), e_signatures (:53), document_acknowledgments (:67), access_recertification_events (:71), ai_usage_events/ai_key_agreements (:160-161) — plus presigned URLs defaulting to 24h (lib/dataExport.ts:85 `const expiresIn = params.presignedUrlSeconds ?? 24 * 60 * 60;`). The one softening fact is that the UI states the policy openly (page.tsx:74/:197), so this is a deliberate widening rather than an oversight — but it still leaves read-out strictly more permissive than write-back.

**Mechanism.** runOrgExport uses the service-role key to bypass RLS and dumps all 104 org-scoped tables verbatim. Its header states the precondition: "The endpoint uses the Supabase service-role key to bypass RLS, so this function MUST be called from a server context that has already verified the caller is an org admin." The endpoint verifies something weaker: `if (!['Admin', 'Manager', 'DocCtrl'].includes(role || '')) return … 403`. The write side is stricter — both restore routes use `const RESTORE_ROLES = ["Admin"]`.

**Failure scenario.** A Manager (or any DocCtrl, including a contractor-facing coordinator) clicks Download JSON on /admin/data-export and receives, in one file, every row of audit_logs, download_audits, e_signatures, document_acknowledgments, access_recertification_events, ai_key_agreements and ai_usage_events, plus 24h presigned R2 URLs for every binary in the workspace — bypassing every per-document ACL, library scope and ai_excluded carve-out that governs their day-to-day access. The export is audited (dataExport.ts:183-197 writes a DATA_EXPORT row), but the audit is after the fact and the presigned URLs outlive the session by 24 hours.

**Evidence.**

```
app/api/data-export/structured/route.ts:55-57 `if (!['Admin', 'Manager', 'DocCtrl'].includes(role || '')) { return NextResponse.json({ error: 'Only Admin / Manager / DocCtrl can export org data' }, { status: 403 }); }` versus lib/dataExport.ts:18-20 `// The endpoint uses the Supabase service-role key to bypass RLS, so this // function MUST be called from a server context that has already // verified the caller is an org admin.` and app/api/admin/restore/apply-table/route.ts:21 `const RESTORE_ROLES = ["Admin"];`
```

**Chain reaction.** The same three roles gate the destination configuration UI, so a Manager can also point a scheduled full-org export at an S3 bucket they control (app/api/data-export/destinations) — turning a one-off read into a standing exfiltration channel. Meanwhile the audit_logs table that would record it is itself inside the export.

> **Verifier correction.** Two calibrations. The evidence quote uses single quotes; the file uses double quotes (`if (!["Admin", "Manager", "DocCtrl"].includes(role || ""))`) — same code, but the string is not literal. And this is a deliberate product decision, not an oversight: the UI states it at app/(protected)/admin/data-export/page.tsx:71 `const isAuthorized = ["Admin", "Manager", "DocCtrl"].includes(activeRole)` and the banner at :190-193 tells the user so; app/api/data-export/run/route.ts uses the same ADMIN_ROLES list and fires an out-of-band bell alert to every other Admin/DocCtrl on completion (:37-68, :131-139). The sharp edge worth reporting is therefore not the stale comment but that the dump bypasses per-library ACL — runOrgExport returns 24h presigned R2 URLs for every document_versions.file_url (dataExport.ts collectFilePaths + presign), so a Manager walled off from a library by lib/acl.ts still gets its binaries.

**Done when.**

- [ ] Either /api/data-export/structured is narrowed to Admin (matching dataExport.ts's stated precondition and the Admin-only restore), or the contract comment and the role list are reconciled with a written rationale for why Manager/DocCtrl may read RLS-bypassing dumps
- [ ] Destination creation/editing is Admin-only regardless of who may trigger a one-off export
- [ ] The DATA_EXPORT audit row records the exporter's role and whether presigned URLs were minted, so an after-the-fact review can see the scope

**Partial (2026-09-30, intelligence Round G).** Pointer — re-verified at HEAD `1b71ca1`: unchanged. `/api/data-export/structured` still admits Admin / Manager / DocCtrl (`app/api/data-export/structured/route.ts:56`, by the role collection since `ADD-1`), `/api/data-export/run` and `/api/data-export/destinations` the same (`run/route.ts:18`, `destinations/route.ts:14`), and the `DATA_EXPORT` row (`lib/dataExport.ts:189-196`) records counts only — no role, no presigned-URL flag. Owner: admin-and-org **P3** (`BKP-8`, Admin-only full export per `DEC-43`); criteria 2 (destinations Admin-only) and 3 (the audit row's role and presign fields) are this finding's additions, carried by a cross-note on `BKP-8`. The same fix closes `DACL-7` and `IEDGE-10`.

---

<a id="ilife-8"></a>

## ILIFE-8 · Orphan scan and delete are bucket-global with no org scoping — one tenant's DocCtrl reclaims every tenant's storage

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/orphans/route.ts:23`, `app/api/admin/orphans/route.ts:42`, `lib/storageOrphans.ts:33`, `lib/storageOrphans.ts:99`, `lib/storageOrphans.ts:126`, `lib/storageOrphans.ts:156`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — scan and delete are both bucket-global and the authorized orgId is used only for the permission check and the audit_logs row (:50-51). Because the reference set is also global, another tenant's LIVE files are still protected; the cross-tenant blast radius is other orgs' unreferenced objects — which, given ILIFE-1, includes their vendor quotes and cost documents. The GET also leaks other tenants' storage keys (orgs/<other-org-uuid>/…) into org A's UI, which arguably makes MEDIUM if anything conservative.

**Mechanism.** The route authorizes the caller against a specific org — `const actor = await authorizeOrgRole(req, orgId, ROLES)` with `ROLES = ["Admin", "DocCtrl"]` — then calls `scanOrphans(actor.admin)` / `deleteOrphans(actor.admin)` passing only the service-role client. orgId is never forwarded. collectReferencedKeys queries each table with `sb.from(table).select(select).range(from, from + 999)` and no `.eq("org_id", …)` anywhere; scanOrphans walks the whole bucket via `ListObjectsV2Command({ Bucket: R2_BUCKET, ContinuationToken: token, MaxKeys: 1000 })` with no Prefix. deleteOrphans batches DeleteObjectsCommand over that global list.

**Failure scenario.** Org A's DocCtrl clicks reclaim orphans. Every unreferenced object in the shared R2 bucket is deleted, including org B's and org C's — under keys `orgs/<other-org-uuid>/…`. Coupled with the cost_documents gap above, org A's DocCtrl permanently deletes every other tenant's vendor quotes and cost-document PDFs. The audit row is written to org A's audit_logs only (orphans/route.ts:50-54 `org_id: orgId`), so org B has no record that anything happened in its own space.

**Evidence.**

```
app/api/admin/orphans/route.ts:42-46 `const actor = await authorizeOrgRole(req, orgId, ROLES); … const result = await deleteOrphans(actor.admin);` — orgId is used for authorization and the audit row only. lib/storageOrphans.ts:99 `const { data, error } = await sb.from(table).select(select).range(from, from + 999);` (no org filter) and :126 `const res = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, ContinuationToken: token, MaxKeys: 1000 }));` (no Prefix).
```

**Chain reaction.** The blast radius scales with the number of tenants on the deployment and with every future gap in collectReferencedKeys. The route's header comment ("Admin/DocCtrl only. The scan fails CLOSED") describes the reference-collection failure mode accurately but says nothing about tenancy, so nobody reading it would notice.

> **Verifier correction.** Line numbers drift (the select is :94 not :99; ListObjectsV2 is :127 not :126) and the impact is overstated. collectReferencedKeys is global too, so a file referenced by ANY tenant's rows is not a candidate — a tenant's DocCtrl can only delete objects that are unreferenced platform-wide. The residual harm is (a) cross-tenant disclosure: the GET returns up to 500 orphan keys including other orgs' `orgs/<other-org-id>/…/<filename>` paths and bucket-wide totals, and (b) cross-tenant destruction of anything the collector fails to register — which is exactly the cost_documents gap in finding 4. MEDIUM.

**Done when.**

- [ ] scanOrphans/deleteOrphans take an orgId and both the R2 listing (Prefix: `orgs/<orgId>/`) and the reference queries are scoped to it
- [ ] A caller's reclaim can be shown, in a two-org fixture, to leave the other org's unreferenced objects untouched
- [ ] Keys outside `orgs/<orgId>/` are refused as delete candidates even if they somehow reach the delete batch

**Partial (2026-09-30, intelligence Round G).** Pointer, held OPEN on the package's fix pass 3 (the first recording marked it RESOLVED). The listing half is fixed as document-control [`RET-7`](../document-control/08-retention.md) (Round F package P9, merged on this base; no migration), but criterion 1's reference-query limb is declined by `DEC-57`, not met, and the harm this finding's verifier correction names first — (a), cross-tenant disclosure including "bucket-wide totals" — survives as `referencedKeys`, which no queued plan scopes (Scope / residual). `DEC-29` needs every criterion; a decision that declines a limb does not stand in for the residual. Re-verified against HEAD `1b71ca1`: `scanOrphans(sb, orgId)` refuses to walk without an org (`lib/storageOrphans.ts:152-153`), lists R2 with `Prefix: orgs/<orgId>/` (`:154`, `:163-165`), skips any key outside the prefix even if a listing returns one (`:171`), counts `totalObjects` / `totalBytes` for the prefix only (`:172-173`) and reports the prefix as `scope` (`referencedKeys` is still a bucket-wide count — Scope / residual); `deleteOrphans(sb, orgId)` re-scans and sends only in-prefix keys to `DeleteObjects` (`:195-201`); `/api/admin/orphans` passes the caller's authorized org to both (`app/api/admin/orphans/route.ts:28`, `:49`) and records the `scope` in its audit row (`:54`). Tests: `lib/__tests__/dcRoundFShed.test.ts` "orphan sweep — RET-7 confined to the caller's org prefix" (three cases). No code in this package.

**Done-when.**
1. ◐ listing scoped — both functions take the org, and the R2 listing is scoped to `orgs/<orgId>/` (`:152-154`, `:163-165`). **Reference-query scoping declined by `DEC-57`** (as `WIRE-9`'s declined limb cites `DEC-23`) — this limb is not met as written and is not ticked. `collectReferencedKeys` stays bucket-wide (`lib/storageOrphans.ts:20-23`, `:38`) so a key ANY tenant's row references is protected: with the walk confined to the caller's prefix, scoping the reference queries could only add deletions (an object under this org's prefix that another org's row points at), never keep another org's key out of view. Document-control [`RET-7`](../document-control/08-retention.md) Done-when 2 asks for the same thing ("the reference collector still runs org-wide (a cross-org reference must protect a key)"); `DEC-57` makes it a decision.
2. ✓ Two-org fixture: `dcRoundFShed.test.ts` lists `orgs/<ORG>/orphan.pdf` and `orgs/<OTHER>/their-orphan.pdf`; `deleteOrphans(…, ORG)` deletes only the first, and the scan reports none of the other org's keys or bytes (it does report one platform-wide aggregate, `referencedKeys` — Scope / residual).
3. ✓ A key outside the prefix is refused as a candidate even if it reaches the batch (`:171`, `:201`).

**Remaining / owner.** Scope `referencedKeys` to the caller's prefix (count only referenced keys under `orgs/<orgId>/`), or drop it from the scan's result. Owner: admin-and-org **P2** (`BKP-2`, which owns the collector; cross-note there). A&O P2's plan lists `BKP-2` for the storage-key registry, not this field, so the integrator adds it. This then closes by pointer, criterion 1's reference-query limb recorded as declined by `DEC-57`.

**Scope / residual.** The cost-documents gap the failure scenario couples to is `ILIFE-1` (OPEN, admin-and-org P2 `BKP-2`), as is recording the deleted keys in the audit row. Objects outside every `orgs/<uuid>/` prefix are reachable by no tenant's sweep (`RET-7`'s own residual, admin-and-org `BKP-2` / `BKP-9`). The GET still returns `referencedKeys: referenced.size` (`lib/storageOrphans.ts:187`, spread whole into the response by `app/api/admin/orphans/route.ts:30`): the number of storage keys every tenant on the deployment references, handed to one org's Admin / DocCtrl — part of the "bucket-wide totals" disclosure this finding's verifier correction named as harm (a). None of this finding's criteria names it, but it is what survives of that harm, so this finding stays OPEN on it (Remaining / owner). Cross-notes on `BKP-2` and on document-control `RET-7`, whose Done-when 3 ("the GET response reports only the caller's org's totals") it contradicts. The collector's completeness under a concurrent delete is `ILIFE-6` criterion 3 (✗), not this finding: the prefix confinement holds whatever the collector misses.

---

<a id="ilife-9"></a>

## ILIFE-9 · Site Codebook config, library numbering and recently-viewed have no `id` column but restore upserts them ON CONFLICT (id)

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:336`, `lib/dataRestore.ts:346`, `app/api/admin/restore/apply-table/route.ts:77`, `supabase/migrations/20260928_site_codebook.sql:38`, `supabase/migrations/20260806_intelligence_layer.sql:106`, `supabase/migrations/20260806_intelligence_layer.sql:121`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the three tables have no `id` column, are on the export contract, and get conflictTargetFor()==='id'. The upsert fails (42703), the fallback `insert` at route.ts:79 then hits the real PK on any re-run/merge (23505) and returns 500. Blast radius is bounded — restore/page.tsx:203 does `tableFailed = true; break;` and records the table in `failedTables` rather than aborting the restore — but the table's rows are silently not restored. No test covers conflictTargetFor (lib/__tests__/dataRestore.test.ts has no CONFLICT reference).

**Mechanism.** conflictTargetFor() returns `CONFLICT_TARGETS[table] ?? "id"`. CONFLICT_TARGETS covers six tables (document_favorites, curated_collection_items, team_members, ticket_number_counters, archive_settings, org_configurations) — the author clearly knew this class exists. Three exported tables that also lack an `id` column are missing from it: codebook_config (`org_id UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE`, 20260928:38), recently_viewed_docs (`PRIMARY KEY (user_id, document_id)`, 20260806:106), library_numbering (`library_id UUID PRIMARY KEY REFERENCES libraries(id)`, 20260806:121). apply-table/route.ts:77 issues `sb.from(table).upsert(chunk, { onConflict: conflictTargetFor(table), ignoreDuplicates: true, count: "exact" })`, which becomes ON CONFLICT (id) → Postgres 42703 undefined_column; the code falls back to a plain `insert` at :79.

**Failure scenario.** An admin restores into a workspace that already has a Site Codebook (the common case: re-running a restore, or merging a backup into a live workspace). The upsert errors on the missing `id` column, the plain-insert fallback hits the existing codebook_config row's org_id primary key (23505), and apply-table returns 500. codebook_entries — the vocabulary — restores fine, but codebook_config — the drawing-number segment map (`drawing_number` JSONB), the iterable rule, and legend_doc_ids — does not. The plant's ID decoder is the input to the Bridge's locate step (decode the unit from the drawing number) and to lib/codebook.ts parseDrawingNumber, so a workspace comes back able to list unit codes but unable to decode a single drawing number.

**Evidence.**

```
lib/dataRestore.ts:336-348 `export const CONFLICT_TARGETS: Record<string, string> = { document_favorites: "user_id,document_id", curated_collection_items: "collection_id,document_id", team_members: "team_id,uid", ticket_number_counters: "org_id,year", archive_settings: "org_id", org_configurations: "org_id,key", }; … export function conflictTargetFor(table: string): string { return CONFLICT_TARGETS[table] ?? "id"; }` — with the comment at :336-338 `// Most tables have a plain \`id\` primary key; the ones listed here use composite (or differently-named) keys — upserting them on "id" errors and breaks re-runnability.` Migration proof: supabase/migrations/20260928_site_codebook.sql:38 `org_id      UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,` (no id column in the CREATE).
```

**Chain reaction.** Because the live chunked path does not abort (see the abort finding), this failure is a single line in failedTables. The admin has no way to know that the one row that decodes the entire plant's numbering did not come back — every other codebook surface looks populated.

> **Verifier correction.** The finding already notes the plain-insert fallback at apply-table/route.ts:78-83, which means a first-time restore into an empty workspace still lands these rows — the breakage is confined to re-runnability and merge-into-populated-org (the exact property the CONFLICT_TARGETS comment at :336-338 exists to protect), where the fallback insert then hits a PK violation and fails the table. MEDIUM, not HIGH.

**Done when.**

- [ ] CONFLICT_TARGETS gains codebook_config: "org_id", library_numbering: "library_id", recently_viewed_docs: "user_id,document_id"
- [ ] A test asserts that for every exported table, conflictTargetFor(table) names columns that actually exist in that table's CREATE TABLE (parsing supabase/ the way exportCoverage.test.ts already does) — the current test only checks the table name is real
- [ ] Re-running a restore twice into the same workspace produces zero failed tables

**Partial (2026-09-30, intelligence Round G).** Pointer — re-verified at HEAD `1b71ca1`: `CONFLICT_TARGETS` (`lib/dataRestore.ts:461-468`) still has its six entries and none for `codebook_config`, `library_numbering` or `recently_viewed_docs`; `conflictTargetFor` still defaults to `"id"` (`:471-473`). Owner: admin-and-org **P1** (`BKP-12`, whose criteria name the same tables plus `document_equipment_suggestions`, and the "conflict target names real key columns" tripwire). Cross-note on `BKP-12`.

**Resolution (2026-10-01, intelligence Round G — closed by pointer by the integrator at the admin-and-org P1 merge).** Every done-when holds on the integration branch, landed by admin-and-org P1 (`BKP-12`): (1) `CONFLICT_TARGETS` (`lib/dataRestore.ts:934-937`) names `codebook_config: "org_id"`, `library_numbering: "library_id"`, `recently_viewed_docs: "user_id,document_id"` (and `document_equipment_suggestions`); (2) `lib/__tests__/dataRestore.test.ts` ("BKP-12 — every restorable table's conflict target is a real key", :215-250) parses `supabase/` for each table's primary key, UNIQUE constraints and non-partial unique indexes and fails on any target that is not one; (3) `lib/__tests__/restoreApplyRoute.test.ts` ("restoring the same backup twice: the second run skips what exists — zero failed tables, on both routes", :302) runs the same backup twice with zero failed tables.

---

<a id="ilife-10"></a>

## ILIFE-10 · Tables with their own unique constraints are upserted ON CONFLICT (id), so a merge restore errors instead of deduping

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:346`, `supabase/migrations/20261017_process_flows.sql:36`, `supabase/migrations/20260929_mention_engine.sql:60`, `supabase/migrations/20260807_link_proposals.sql:70`, `app/api/admin/restore/apply-table/route.ts:77`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. True, and broader than stated — assets (org_id,tag_normalized), asset_types (org_id,name), codebook_entries (org_id,kind,code), document_assets, work_package_documents and others carry the same shape. `ON CONFLICT (id) DO NOTHING` does not absorb a secondary-unique collision, and the fallback plain insert cannot either, so the whole 500-row chunk 23505s and the client's `break` drops the rest of that table. Only mitigation found: the failure is surfaced in `failedTables`, not silently swallowed.

**Mechanism.** conflictTargetFor falls back to "id" for every table not in CONFLICT_TARGETS. Several intelligence tables have a business-key unique constraint that is NOT the primary key: process_flows `UNIQUE (org_id, from_kind, from_ref, to_kind, to_ref)` (20261017:36), entity_mentions `CREATE UNIQUE INDEX … entity_mentions_unique_idx ON entity_mentions (asset_id, COALESCE(knowledge_document_id, document_id), page)` (20260929:60-61), proposed_links `CREATE UNIQUE INDEX … proposed_links_pair_idx ON proposed_links (document_id, target_document_id, proposer)` (20260807:70-71). `ON CONFLICT (id) DO NOTHING` only suppresses id collisions; a violation of any OTHER unique index still raises 23505, and the plain-insert fallback raises it again.

**Failure scenario.** An admin restores a backup into a workspace that is not empty — the documented use case ("Existing data is kept — this is additive", restore/page.tsx:162). The target has since re-run the mention indexer, so entity_mentions already holds a row for (asset, knowledge_doc, page) with a different id. The restore's row collides on entity_mentions_unique_idx, apply-table returns 500, and the mentions table is marked failed wholesale — one duplicate kills the whole 500-row chunk and, given the `break` at page.tsx:202, every remaining chunk of that table. The same happens for a flow the operator re-drew by hand and for any proposal the proposer regenerated.

**Evidence.**

```
lib/dataRestore.ts:345-348 `/** The ON CONFLICT target to use when additively restoring \`table\`. */ export function conflictTargetFor(table: string): string { return CONFLICT_TARGETS[table] ?? "id"; }`. supabase/migrations/20261017_process_flows.sql:36 `UNIQUE (org_id, from_kind, from_ref, to_kind, to_ref)`. supabase/migrations/20260929_mention_engine.sql:59-61 `-- Re-indexing a page must replace its mentions, never duplicate them. CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_unique_idx ON entity_mentions (asset_id, COALESCE(knowledge_document_id, document_id), page);`
```

**Chain reaction.** entity_mentions is one of only two tables the export contract calls out as containing irreplaceable human decisions (exportTables.ts:36-39: "is_explicit rows are human decisions, and a restore that silently dropped them would lose links nobody can reconstruct") — and it is precisely the table whose conflict handling drops the whole chunk on the first duplicate.

**Done when.**

- [ ] CONFLICT_TARGETS names the real business key for process_flows, entity_mentions (or the restore pre-filters duplicates) and proposed_links
- [ ] A restore into a workspace that has already re-indexed mentions completes with zero failed tables and preserves every is_explicit row
- [ ] Chunk-level failures do not abandon the rest of the table — a duplicate row is skipped, not fatal to its 500-row batch

**Partial (2026-09-30, intelligence Round G).** Pointer, with the business keys handed to admin-and-org **P1** (`BKP-12`; `CONFLICT_TARGETS` is P1's). Re-verified at HEAD `1b71ca1`: the three tables still restore `ON CONFLICT (id)` (`lib/dataRestore.ts:471-473`). Their real unique keys, from the migrations: `process_flows (org_id, from_kind, from_ref, to_kind, to_ref)` (`20261017_process_flows.sql:36`); `proposed_links (document_id, target_document_id, proposer)` (`proposed_links_pair_idx`, `20260807_link_proposals.sql:68-69`); and `entity_mentions (asset_id, COALESCE(knowledge_document_id, document_id), page)` (`entity_mentions_unique_idx`, `20260929_mention_engine.sql:59-60`) — an EXPRESSION index, which cannot be named as an `onConflict` column list, so that table needs the restore to pre-filter duplicates on the key and must keep every `is_explicit` row. Default carried with the handover: no new unique indexes from this package; P1 decides the entries and the pre-filter (intelligence I-08 is adding conflict targets for `WIRE-2` in parallel — build on whatever is live). Criterion 3 (a duplicate skipped, not fatal to its 500-row chunk) sits next to `BKP-12` criterion 3. Cross-note on `BKP-12`.

---

<a id="ilife-11"></a>

## ILIFE-11 · The export inlines every 1024-dimension chunk embedding into one JSON response with no exclusion or streaming

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/dataExport.ts:300`, `lib/exportTables.ts:139`, `supabase/migrations/20260930_semantic_layer.sql:49`, `app/api/data-export/structured/route.ts:69`, `lib/exportRunner.ts:213`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — repo-wide grep for `embedding` in dataExport.ts / exportTables.ts / exportRunner.ts / clientBackup.ts returns nothing, so no exclusion, projection or streaming exists anywhere on the export path. Every 1024-dim vector is serialized as text into one in-memory envelope, then re-stringified twice more.

**Mechanism.** knowledge_chunks is in ORG_SCOPED_TABLES (exportTables.ts:139) and dumpTable selects `"*"` (dataExport.ts:300). The semantic layer added `ADD COLUMN IF NOT EXISTS embedding vector(1024)` (20260930:49), so every chunk row carries 1024 floats, which PostgREST serializes as a text vector literal — on the order of 15-20 KB per chunk row in JSON. The structured route then materializes the ENTIRE envelope as one string: `const body = JSON.stringify(envelope, null, 2);` (structured/route.ts:69) and returns it in a single NextResponse. exportRunner does the same via JSZip in RAM. Nothing excludes the embedding column, and EXPORT_EXCLUDED_TABLES' only vector-adjacent exclusion is knowledge_line_traces ("cached AI line traces … regenerated on demand"), which reasons about regenerability but was not applied to embeddings, which are equally regenerable (drainEmbedBacklog rebuilds them).

**Failure scenario.** An org indexes a few standards and a P&ID set — tens of thousands of chunks. The export accumulates hundreds of megabytes of vector text in the function's heap, then JSON.stringify doubles it, then the browser holds the parsed envelope AND re-stringifies it into the zip (clientBackup.ts:124). The backup either OOMs the serverless function (maxDuration is raised to 300 at structured/route.ts:9 but memory is not addressed) or produces a multi-hundred-MB data.json the restore page must JSON.parse in a tab. I cannot observe the actual failure without running it, so the consequence is SUSPECTED; the inclusion and the single-string materialization are CONFIRMED by the code above.

**Evidence.**

```
lib/dataExport.ts:300 `let q = sb.from(table).select("*").range(from, from + pageSize - 1);` — no column list, no omission of `embedding`. supabase/migrations/20260930_semantic_layer.sql:49 `ADD COLUMN IF NOT EXISTS embedding vector(1024);`. app/api/data-export/structured/route.ts:69 `const body = JSON.stringify(envelope, null, 2);`. Contrast the reasoning that DID exclude a derived cache, lib/exportTables.ts:177-179: `knowledge_line_traces: "cached AI line traces over drawing sheets — regenerated on demand from the drawings themselves; no authored data lives here"`.
```

**Chain reaction.** If the export is the thing that fails on the largest, most intelligence-heavy workspaces, then the customers with the most to lose are the ones whose backup silently stops working — and the failure surfaces as a browser hang, not as a manifest warning.

> **Verifier correction.** Keep SUSPECTED as filed — the per-row byte estimate and any OOM/timeout consequence were not measured, and a workspace that never configured an embedding provider carries all-NULL embeddings and pays nothing. Minor citation drift: knowledge_chunks is exportTables.ts:138 and the knowledge_line_traces exclusion is :176-178.

**Done when.**

- [ ] knowledge_chunks is dumped with an explicit column list omitting `embedding` (with a manifest note that the meaning index rebuilds via the embed drain), or embeddings are written as a separate side file rather than inline JSON
- [ ] The export path streams rows rather than building one JSON string, or the envelope size is measured and reported so an oversized backup is a visible warning not a hang
- [ ] A restore of an export taken without embeddings leaves knowledge_libraries in a state the embed drain will rebuild, verified end to end

**Partial (2026-09-30, intelligence Round G).** Pointer — re-verified at HEAD `1b71ca1`: unchanged. `knowledge_chunks` is exported (`lib/exportTables.ts:143`) through `dumpTable`'s `select("*")` (`lib/dataExport.ts:315`), so `embedding` rides every dump, and nothing measures the envelope. This residual is intelligence **I-01 phase B** — an explicit column list for `knowledge_chunks` omitting `embedding`, a manifest note that the meaning index rebuilds through the embed drain, and the exception declared (not silent) in `lib/__tests__/exportCoverage.test.ts` — landing on the version of `lib/dataExport.ts` / `lib/exportTables.ts` that admin-and-org **P2** rewrites, after P2 merges. Criterion 2 (streaming, or a measured size warning) is P2's export contract; criterion 3 is verified with phase B.

---

<a id="ilife-12"></a>

## ILIFE-12 · schemaExpectations does not cover the newest intelligence tables, contains a phantom, and has no tripwire test — schema-health reports on a list nobody validates

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/schemaExpectations.ts:1`, `lib/schemaExpectations.ts:29`, `lib/schemaExpectations.ts:104`, `app/api/admin/schema-health/route.ts:45`, `app/api/admin/schema-health/route.ts:78`, `lib/processFlows.ts:44`, `lib/linkRules.ts:48`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All three sub-claims verified. One nuance on the stated consequence: schema-health's `missingTable` (route.ts:24) matches only code 42P01 or /does not exist/i, and PostgREST returns PGRST205 ("Could not find the table … in the schema cache") for an absent table — a code this repo handles explicitly elsewhere (lib/branches.ts:65, lib/workPackages.ts:48). So depending on PostgREST version the phantom is either reported missing forever (as the finding says) or reported PRESENT — a false clean bill. Either way the list is unvalidated and the finding stands.

**Mechanism.** Scanning every CREATE TABLE in supabase/schema.sql + supabase/migrations yields 111 tables; EXPECTED_TABLES lists 88. Twenty-four real tables are never probed, including the four newest intelligence ones: process_flows (20261017), link_rules (20261015), answer_skills (20261016), knowledge_line_traces (20261007) — plus answer-adjacent ones (document_sets, document_versions, org_configurations, tickets, audit_logs) and the whole 20261013 project-controls set (companies, company_events, change_orders, project_checklists, checklist_items, turnover_items, punch_items). One listed table is a phantom: `{ table: "statements", migration: "20260819_orphan_tables_backfill.sql" }` at :104 — three greps (`create table[^(]*statements` over supabase/, `"statements"` over the codebase, `\bstatements\b` over schema.sql) find no such table; the only match is the migration's prose header "CREATE TABLE statements for 11 tables that exist". There is NO test for this file: greps for `schemaExpectations`, `EXPECTED_TABLES` (case-insensitive) and `schema-health` across *.test.ts hit only apiRouteAuth.test.ts, which tests the route's authorization, not its content. Meanwhile the consumers degrade exactly as the file's header warns: lib/processFlows.ts:44 `if (missing(error)) return null;` and lib/linkRules.ts:48 `if (missing(error)) return null;` / :61 `if (error) return; // pre-migration — the caller surfaces that separately`.

**Failure scenario.** Migrations are applied by hand in the Supabase SQL editor (the file's own header says so). An operator pastes through 20261013 and stops. /admin/schema-health probes 88 tables, all present except the phantom `statements`, so `healthy` is false and migrationsToRun always contains 20260819_orphan_tables_backfill.sql — a permanent false alarm that trains the admin to ignore the panel. Meanwhile process_flows, link_rules and answer_skills do not exist; the Process lens on the graph is empty, the Skills library is empty, and the PFD reader can't persist anything — each surface silently returning null instead of naming the migration. The panel that exists precisely to turn "the feature looks empty" into "run 20261017_process_flows.sql" cannot say it, because that migration is not in the list.

**Evidence.**

```
lib/schemaExpectations.ts:10-13 `// Generated from supabase/migrations (CREATE TABLE scan) + curated column probes for feature-critical ALTERs. When a new migration creates a table, add it here — the health panel is only as honest as this list.` — and the list stops at 20261012 (its newest EXPECTED_COLUMNS entries) while migrations run to 20261017. app/api/admin/schema-health/route.ts:78 `healthy: missingTables.length === 0 && missingColumns.length === 0,` computed only over EXPECTED_TABLES/EXPECTED_COLUMNS.
```

**Chain reaction.** The export side has a real tripwire (lib/__tests__/exportCoverage.test.ts diffs exportTables.ts against every CREATE TABLE and fails the build); the schema-health side has the same shape of list with none. So a new intelligence table gets a backup decision enforced at build time but a deploy-health decision only if someone remembers.

> **Verifier correction.** HIGH is too strong: this is a completeness gap in an admin diagnostic panel, not a runtime defect — nothing user-facing breaks because a table is unlisted. Also, the phantom's effect is not determinable from the repo: schema-health/route.ts:24-25 classifies a missing table only on `42P01` or /does not exist/i, and modern PostgREST answers an unknown table with PGRST205 ("Could not find the table 'public.statements' in the schema cache"), which matches neither — so "statements" may silently pass as present rather than permanently false-alarm. Either way the list is wrong; which way it fails is unverifiable here.

**Done when.**

- [ ] A test discovers CREATE TABLE names from supabase/ (reuse discoverCreatedTables from exportCoverage.test.ts) and asserts every one appears in EXPECTED_TABLES, and that every EXPECTED_TABLES entry exists — the phantom `statements` fails today
- [ ] process_flows, link_rules, answer_skills and knowledge_line_traces are probed with their correct migration filenames
- [ ] EXPECTED_COLUMNS gains the feature-critical ALTERs from 20261015/16/17 so a half-applied intelligence migration is visible

**Partial (2026-09-30, intelligence Round G).** Re-verified at HEAD `1b71ca1`. Half of criterion 1 landed under projects Round G **J9** (`REL-7`): `lib/__tests__/schemaExpectations.test.ts` scans every `CREATE TABLE` in `supabase/migrations` and fails when one is missing from `EXPECTED_TABLES` (`:155-159`) — but it grandfathers `answer_skills`, `link_rules`, `process_flows`, `knowledge_line_traces` and `document_markups` (`:71`) and does not assert the reverse, so the phantom `{ table: "statements" }` is still listed (`lib/schemaExpectations.ts:118`). Criterion 2 (the intelligence tables probed with their migration files) and criterion 3 (`EXPECTED_COLUMNS` for the 20261015/16/17 ALTERs) are open. Owner: admin-and-org **P2** (`BKP-14` — delete `statements`, regenerate the list, empty the grandfather set); cross-note there. `knowledge_line_traces` is retired (`20261007_retire_line_traces.sql`), so its row should record the retirement rather than probe for a table that must not exist (the `IRLS-12` verifier correction).

*Cross-note (2026-10-01, admin-and-org Round G, P2): closes by pointer to admin-and-org `BKP-14` (RESOLVED).*
- *Criterion 1 ✓: the tripwire runs both ways, schema.sql included; `statements` fails it and is gone.*
- *Criterion 2 ✓: `process_flows`, `link_rules` and `answer_skills` are probed with their files, and `knowledge_line_traces` is recorded as retired.*
- *Criterion 3 ✓, vacuously: 20261015/16/17 add no column to an older table.*
- *The route reads PGRST205 as missing, which settles the verifier's "phantom may pass as present".*

**Resolution (2026-10-01, admin-and-org Round G).** Closed by pointer to admin-and-org `BKP-14` (RESOLVED, package P2), the owner this record names. The cross-note above said "closes by pointer" but left the status OPEN; the second review of P2 found that, and P2 makes the change. Verified on the branch:
- `lib/__tests__/schemaExpectations.test.ts` discovers every `CREATE TABLE` in `supabase/schema.sql` and the numbered migrations and checks both directions. Every created table is listed (less the retired), and every listed row names a file that really creates its table. The grandfather set is empty, and the phantom `statements` row is gone.
- `lib/schemaExpectations.ts` lists `answer_skills` (`20261016_reasoning_skills.sql`), `link_rules` (`20261015_connection_skills.sql`) and `process_flows` (`20261017_process_flows.sql`). `knowledge_line_traces` is in `RETIRED_TABLES` and is never probed.
- `app/api/admin/schema-health/route.ts` reads PGRST205 as a missing table.

**Done-when.**
1. ✓ — the two-way tripwire (`BKP-14`).
2. ✓ — the three intelligence tables are probed with their files; `knowledge_line_traces` is recorded as retired.
3. ✓, vacuously — `20261015`, `20261016` and `20261017` add no column to an older table; they create the three tables now probed.

**Scope / residual.** None here. The sibling `IRLS-12` stays OPEN on its own criterion 3 (42P01 against an empty result in the libraries), which belongs to intelligence I-08 and I-09.

---

<a id="ilife-13"></a>

## ILIFE-13 · syncAllKnowledgeSources takes an unordered slice of 25 libraries platform-wide — libraries past the cut never sync, ever

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** intelligence I-06b INGEST ROUTE FOLLOW-UPS — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeSourceSync.ts:299`, `lib/knowledgeSourceSync.ts:303`, `lib/knowledgeSourceSync.ts:309`, `app/api/cron/maintenance/route.ts:245`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanism is real — an unordered slice(0,25) with no rotation means libraries past the cut get no cron attention. But 'never sync, ever' is false: any file landing in or moving within the watched doc-control library pushes a full reconcile (ADD + rev-up refresh + REMOVE) for that library regardless of the cut, and a controller can force one. The residual gap is narrow (a rev-up in a >25th library with no other filing activity, since publish does not call nudgeKnowledgeSources), so LOW.

**Mechanism.** The cron entry queries `supabaseAdmin.from("knowledge_sources").select("library_id")` with no org filter and no ORDER BY, then `const libraryIds = [...new Set((data ?? []).map((r) => r.library_id as string))].slice(0, maxLibraries);` with maxLibraries defaulting to 25. There is no rotation, no last-synced-at cursor, and no randomization — the same prefix of whatever order PostgREST returns is processed on every invocation. The query is global, so the 25 slots are shared across all tenants.

**Failure scenario.** A deployment reaches 30 knowledge libraries with sources. Libraries in positions 26+ are never reconciled: newly filed controlled documents never appear in them, rev-ups never flip their mirrors to 'stale' so answers keep citing a superseded revision, and — the lifecycle half — the REMOVE pass at knowledgeSourceSync.ts:286-292 (`for (const [dcDocId, row] of existingByDcDoc) { if (wanted.has(dcDocId)) continue; … delete().eq("id", row.id) … }`), which is the ONLY sweeper that removes knowledge mirrors of deleted controlled documents, never runs for them. A document deleted from doc control keeps answering questions from that library indefinitely.

**Evidence.**

```
lib/knowledgeSourceSync.ts:303-310 `const { data, error } = await supabaseAdmin.from("knowledge_sources").select("library_id"); if (error) { return out; } const libraryIds = [...new Set((data ?? []).map((r) => r.library_id as string))].slice(0, maxLibraries); for (const libraryId of libraryIds) { const res = await syncKnowledgeLibrarySources(libraryId); … }`. Called with no argument at app/api/cron/maintenance/route.ts:245 `const sync = await syncAllKnowledgeSources();`.
```

**Chain reaction.** Because the same pass is the mirror-deletion sweeper, this is simultaneously a freshness bug and a retention bug: a PSM-controlled drawing that was deleted or superseded stays quotable, with citations, in an unsynced library. Nothing in the UI distinguishes a library that synced 5 minutes ago from one that has never synced.

> **Verifier correction.** "Libraries past the cut never sync, ever" is refuted by a second sync path: app/api/knowledge/sources/route.ts calls syncKnowledgeLibrarySources on demand at :162 (loop), :180, :225 and :264 — adding, removing or manually resyncing a source reconciles that library immediately, regardless of the cron slice. What survives is that the AUTOMATIC heartbeat covers only the first 25 library ids platform-wide, so an org past the cut sees new/revised controlled documents reach the AI shelf only when a human touches the Sources UI. MEDIUM.

**Done when.**

- [ ] Library selection rotates — order by a last_synced_at (or oldest-first) cursor persisted per library, so every library is reached within a bounded number of cron runs
- [ ] The result reports how many libraries were left unsynced this run, and the knowledge library UI shows a per-library last-synced timestamp
- [ ] Selection is scoped or fairly interleaved across orgs so one tenant's library count cannot starve another's

**Partial (2026-09-30, intelligence Round G).** Reproduced first (DEC-29) against the pre-fix `syncAllKnowledgeSources`: two runs over 60 source-linked libraries reconciled the same 25 libraries both times. `lib/knowledgeSourceSync.ts` now works like this:

- **Every source row is read.** The read is paged past PostgREST's 1,000-row cap and ordered.
- **Oldest first.** Each library is ordered by its oldest `knowledge_sources.last_synced_at`, a new column in `20261122`. A never-synced library comes first.
- **Orgs are interleaved.** Libraries are taken round-robin across orgs, each org's oldest first.
- **Time-bounded.** The pass runs until its budget instead of `.slice(0, 25)`. The default budget is 15 s (`KNOWLEDGE_SYNC_BUDGET_MS`; `maxLibraries` 500). It was 45 s until review fix pass 3, which pushed the cron's ingest drain (40 s, run right after) past the 60 s kill window. A drain killed mid-batch loses the batch and leaves its claim standing for five minutes (ING-2).
- **Every reconcile stamps the cursor.** `syncKnowledgeLibrarySources` stamps `last_synced_at`, from the cron or on demand, so the heartbeat reaches the others next. The exception is a library where a rev-up did not land, because it failed before the row moved or another sync re-pointed the row first. That library is set to NULL (never synced), so the next run reaches it FIRST. A rev-up that finds a batch writing the old revision no longer waits: it supersedes the batch (ING-1).
- **Pre-migration fallback.** With no cursor column, the start rotates by the day, so the same prefix is not the only one ever reached.
- **The result says what waits.** It reports `unsynced` (libraries left for the next run) and `deferred` (rev-ups another sync landed first).

Tests: `lib/__tests__/sourceSync.test.ts` ILIFE-13 block:
- "reads past 1,000 source rows, never-synced libraries first, then the oldest";
- "orgs are interleaved so one tenant's shelf count cannot starve another";
- "stops at its time budget and says how many wait";
- "by default it leaves the cron's ingest drain its room: a 15 s budget, not 45";
- "without the cursor column it still rotates by the day rather than repeating one prefix";
- and, in the ING-3 block, "a purge that fails before the row moves leaves the old version, and the library comes round FIRST next run".

**Done-when.**
- ✓ Library selection rotates by a `last_synced_at` cursor persisted per library, so every library is reached within ceil(libraries / per-run) runs.
- Half done. The result reports how many libraries were left unsynced (`unsynced`). The maintenance route (`app/api/cron/maintenance/route.ts`, which intelligence does not edit) forwards only libraries/added/refreshed/removed and the errors, so that number is not yet in the cron's JSON. The per-library last-synced timestamp on the knowledge library UI is `app/(protected)/knowledge/[id]/page.tsx`, I-02's file; the column it needs now exists.
- ✓ Selection is fairly interleaved across orgs.

**Scope / residual.** Pending migration: `20261122_intel_roundG_ingest_integrity.sql` (`last_synced_at`). OPEN until the UI shows the timestamp and the cron forwards `unsynced`.

**Resolution (2026-10-02, intelligence Round G).** Package I-06b, the remainder the integrator re-owned (orphan sweep). Reproduced first (DEC-29) on HEAD `3bf3b75`: the maintenance route built `knowledgeSync` from `libraries`, `added`, `refreshed` and `removed` only, so the sync's `unsynced` never reached the cron's JSON; `GET /api/knowledge/sources` selected no `last_synced_at`, so nothing in the app could show when a library last synced.

- **The cron says what it left.** `app/api/cron/maintenance/route.ts` (one hunk in the existing knowledge-sources step): `knowledgeSync` carries `unsynced` (libraries this run left for the next — the rotation reaches them oldest first) and `deferred` (rev-ups another sync landed first) beside its counts.
- **The library says when it last synced.** `GET /api/knowledge/sources` answers each source's `lastSyncedAt` and the library's `lastSyncedAt`: its OLDEST source stamp, null when any source never synced or a rev-up left it due first — exactly how the cron orders it. On a database without `20261122` it lists the sources and answers `syncTracked: false`, never an invented time. `lib/knowledge.ts` types them (`KnowledgeSource.lastSyncedAt`, the list's `lastSyncedAt` / `syncTracked`) and adds `lastSyncedLabel`. The library's Sources strip (`components/knowledge/SourcesPanel.tsx`, rendered at the top of the knowledge library page) shows "Last synced with Document Control 5 minutes ago." (the exact time on hover), or "Not synced with Document Control yet — the nightly run reaches it first, or Sync now reconciles it at once."; where the time is not tracked, or the route predates the field, it shows nothing.

Tests: `lib/__tests__/knowledgeSourcesSynced.test.ts` (the route's per-source and per-library stamps, a never-synced source, a database without the column, the label, the cron's forwarded fields) and `lib/__tests__/sourcesPanelSynced.test.ts` (rendered: how long ago with the time on hover, never synced, nothing when untracked or from an older route, nothing with no sources). Each failed against the base.

**Done-when.**
- ✓ Library selection rotates by a `last_synced_at` cursor persisted per library (I-06, unchanged).
- ✓ The result reports how many libraries were left unsynced, and the cron's JSON now carries it (`knowledgeSync.unsynced`); the knowledge library UI shows a per-library last-synced timestamp — on the library's Sources strip, not in `app/(protected)/knowledge/[id]/page.tsx` itself (I-20's file this round), which renders that strip.
- ✓ Selection is fairly interleaved across orgs (I-06, unchanged).

**Scope / residual.** Pending migration: `20261122_intel_roundG_ingest_integrity.sql` (`last_synced_at`). Until it is pasted the cron's rotation falls back to the daily offset and the strip shows no time (the route says `syncTracked: false`). A library with no sources shows no sync line: nothing syncs it. The cron's JSON is read by whoever reads the run's output; no alert is raised on a large `unsynced` (not asked for).

---

## ILIFE-14 · The direct storage delete frees a key that a knowledge-library mirror still names — the shed's mirror check (ILIFE-5) has a second door

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** admin-and-org P3 (after document-control P14 merges: P14 edits the same route for `RET-2`) — by the integrator, 2026-10-01 (admin-and-org P2 merge; fleet plan `audit-reports/fleet-plans/admin-and-org.json`).
- **Verification:** CONFIRMED (read at the admin-and-org P2 merge: `app/api/storage/delete/route.ts` `DELETE` refuses a key a held or retained revision names, then frees it without asking `lib/storageKeyRegistry.ts` whether any other registered key column — a `knowledge_documents.file_key` mirror among them — still names it)
- **Locations:** `app/api/storage/delete/route.ts` (`DELETE`, between the hold / retention refusal and the `STORAGE_OBJECT_DELETE` custody row), `lib/storageKeyRegistry.ts` (`keysReferencedOutside`), `lib/knowledgeSourceSync.ts` (a mirror's `file_key` is the controlled revision's own key)
- **Independently verified:** — opened 2026-10-01 by the integrator at the admin-and-org Round G P2 merge (DEC-31: `ILIFE-5` is RESOLVED on its criteria — the document shed — and its record names this second byte-freeing door as outside them); not yet challenged by a second party.

**Mechanism.** A knowledge-library mirror of a controlled document stores the controlled revision's own storage key (`knowledge_documents.file_key`). P2 taught the document shed to keep a key any mirror still names (`ILIFE-5` done-when 3). The direct storage delete is the other code path that frees bytes: it checks holds and retention on the revisions that name the key, and then deletes the object. It never asks whether a mirror, or any other registered key column, still names it.

**Failure scenario.** A Controller (the route's tier) calls `DELETE /api/storage/delete` for the key of a superseded revision whose knowledge mirror is still indexed. The route deletes the object. The mirror's file is now gone, so a re-index or a page render of that mirror fails, and the library's citations point at a document whose bytes no longer exist. The app's only caller sends project-cost keys (`lib/costDocs.ts`), so this needs a hand-built request; hence LOW.

**Done when.**

- [ ] The route refuses with 409, in plain words, a key that any registered key column other than the revision's own (`document_versions.file_url` / `source_file_key`) still names, using `keysReferencedOutside` (fail closed: a read error answers 503 and frees nothing).
- [ ] A route test covers it: a `knowledge_documents` row naming the key is refused; an unreferenced key and today's project-cost deletes still succeed.

**Closer:** admin-and-org P3 (assigned at the P2 merge, 2026-10-01). The exact hunk is in `ILIFE-5`'s record (the "second call site" block).
