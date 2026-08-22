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


<a id="life-1"></a>

## LIFE-1 · Orphan sweeper does not know about cost_documents.file_url — every vendor quote and cost document is deletable 7 days after upload

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/storageOrphans.ts:44`, `lib/storageOrphans.ts:76`, `lib/costDocs.ts:105`, `lib/costDocs.ts:116`, `app/api/intake/upload/route.ts:70`, `app/api/intake/upload/route.ts:82`, `app/api/admin/orphans/route.ts:46`

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

---

<a id="life-2"></a>

## LIFE-2 · Restore FK order puts process_flows and entity_mentions BEFORE knowledge_documents — both foreign-key to it, so the intelligence layer fails to restore

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:292`, `lib/dataRestore.ts:294`, `lib/dataRestore.ts:298`, `lib/dataRestore.ts:327`, `supabase/migrations/20261017_process_flows.sql:27`, `supabase/migrations/20260929_mention_engine.sql:33`, `app/api/flows/read/route.ts:160`

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

---

<a id="life-3"></a>

## LIFE-3 · The only full backup an admin can download cannot be read by the restore page — two incompatible ZIP layouts

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/clientBackup.ts:124`, `app/(protected)/admin/restore/page.tsx:113`, `app/(protected)/admin/restore/page.tsx:117`, `lib/exportRunner.ts:134`, `lib/exportRunner.ts:159`, `app/(protected)/admin/data-export/page.tsx:140`

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

---

<a id="life-4"></a>

## LIFE-4 · The restore path the UI actually uses never aborts on a failed parent table — the abort logic lives in a dead route

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/restore/page.tsx:190`, `app/(protected)/admin/restore/page.tsx:202`, `app/(protected)/admin/restore/page.tsx:207`, `app/api/admin/restore/apply/route.ts:115`, `app/api/admin/restore/apply-table/route.ts:80`

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

---

<a id="life-5"></a>

## LIFE-5 · knowledge_documents.source_document_id has no foreign key — deleting a controlled document leaves its whole AI shadow alive

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260917_knowledge_sources.sql:54`, `supabase/migrations/20260911_knowledge_ai.sql:81`, `supabase/migrations/20260921_drawing_entities.sql:24`, `lib/knowledge.ts:467`, `app/(protected)/documents/[libraryId]/page.tsx:1011`, `lib/knowledgeSourceSync.ts:286`

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

---

<a id="life-6"></a>

## LIFE-6 · Every paginated dump uses .range() with no .order() — the backup and the orphan reference set can silently skip rows

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/dataExport.ts:299`, `lib/dataExport.ts:300`, `lib/storageOrphans.ts:97`, `lib/storageOrphans.ts:99`

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

---

<a id="life-7"></a>

## LIFE-7 · Manager and DocCtrl can export the entire organization database, contradicting dataExport's own admin-only contract and the Admin-only restore

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/data-export/structured/route.ts:55`, `lib/dataExport.ts:18`, `app/api/admin/restore/apply-table/route.ts:21`, `app/api/admin/restore/begin/route.ts:24`, `lib/exportTables.ts:15`

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

---

<a id="life-8"></a>

## LIFE-8 · Orphan scan and delete are bucket-global with no org scoping — one tenant's DocCtrl reclaims every tenant's storage

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/orphans/route.ts:23`, `app/api/admin/orphans/route.ts:42`, `lib/storageOrphans.ts:33`, `lib/storageOrphans.ts:99`, `lib/storageOrphans.ts:126`, `lib/storageOrphans.ts:156`

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

---

<a id="life-9"></a>

## LIFE-9 · Site Codebook config, library numbering and recently-viewed have no `id` column but restore upserts them ON CONFLICT (id)

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:336`, `lib/dataRestore.ts:346`, `app/api/admin/restore/apply-table/route.ts:77`, `supabase/migrations/20260928_site_codebook.sql:38`, `supabase/migrations/20260806_intelligence_layer.sql:106`, `supabase/migrations/20260806_intelligence_layer.sql:121`

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

---

<a id="life-10"></a>

## LIFE-10 · Tables with their own unique constraints are upserted ON CONFLICT (id), so a merge restore errors instead of deduping

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:346`, `supabase/migrations/20261017_process_flows.sql:36`, `supabase/migrations/20260929_mention_engine.sql:60`, `supabase/migrations/20260807_link_proposals.sql:70`, `app/api/admin/restore/apply-table/route.ts:77`

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

---

<a id="life-11"></a>

## LIFE-11 · The export inlines every 1024-dimension chunk embedding into one JSON response with no exclusion or streaming

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/dataExport.ts:300`, `lib/exportTables.ts:139`, `supabase/migrations/20260930_semantic_layer.sql:49`, `app/api/data-export/structured/route.ts:69`, `lib/exportRunner.ts:213`

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

---

<a id="life-12"></a>

## LIFE-12 · schemaExpectations does not cover the newest intelligence tables, contains a phantom, and has no tripwire test — schema-health reports on a list nobody validates

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/schemaExpectations.ts:1`, `lib/schemaExpectations.ts:29`, `lib/schemaExpectations.ts:104`, `app/api/admin/schema-health/route.ts:45`, `app/api/admin/schema-health/route.ts:78`, `lib/processFlows.ts:44`, `lib/linkRules.ts:48`

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

---

<a id="life-13"></a>

## LIFE-13 · syncAllKnowledgeSources takes an unordered slice of 25 libraries platform-wide — libraries past the cut never sync, ever

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/knowledgeSourceSync.ts:299`, `lib/knowledgeSourceSync.ts:303`, `lib/knowledgeSourceSync.ts:309`, `app/api/cron/maintenance/route.ts:245`

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

---
