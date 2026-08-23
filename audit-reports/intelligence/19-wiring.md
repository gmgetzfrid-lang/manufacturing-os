# 19 · The join graph — what is connected and what is not

**10 findings** — 1 CRITICAL · 2 HIGH · 7 MEDIUM.

De-facto links in untyped JSONB, one-directional links, and FK columns nothing writes.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| document_assets — a properly normalized doc↔asset join table with UNIQUE (document_id, asset_id), indexes on both directions plus org_id, a `source` discriminator separating trigger-managed rows from manual ones, and two triggers that keep it in sync from both sides (documents.asset_tags changes AND new asset inserts backfilling existing tagged documents) | `supabase/migrations/20260609_phase1_normalization.sql:51-145` | This is exactly the right shape for the equipment spine, it is already read by 12+ call sites (orgGraph, impact, revisionImpact, consolidation, linkProposerServer, search, transitionIn, the unit hub), and it needs only a `pages` column and one extra write from the Bridge to carry the whole Q6 story. Do not replace it — feed it. |
| entity_mentions — one row per (asset, document, page) carrying the sentence that proves it, plus mention_count, origin, confidence and an is_explicit flag that protects human pins from re-index sweeps | `supabase/migrations/20260929_mention_engine.sql:25-70; lib/mentionIndexer.ts:71-145` | This is the only table in the system that already links an asset to a specific PAGE of a specific document with evidence attached. It is the natural home for "E-22 is on sheet 4" and for the graph's explainable edge. Its unique-index/upsert mismatch is a one-line schema fix, not a redesign. |
| knowledge_page_entities — per-page extracted equipment and drawing-reference tags with x/y positions and normalized tags, service-role only, indexed (library_id, kind, tag) and (document_id, page) | `supabase/migrations/20260921_drawing_entities.sql:20-38` | The raw per-sheet equipment census already exists and is already computed at ingest. Adding an (org_id, kind, tag) index and resolving tag→assets.id would turn it into the org-wide sheet index the owner is asking for. |
| The Bridge's BridgeSuggestion already carries `pages: number[]` and a resolved `assetId` per tag, and its unit backfill fills a matched asset's blank unit_code from the drawing it was found on without ever overwriting a human's assignment | `lib/equipmentBridgeServer.ts:28-34, 114-122, 236-258` | The hardest part of Q6 — deriving unit + site code from the drawing number via the codebook and filling in the master list's blanks — is built, tested and idempotent. It just discards the page numbers and the assetId at apply time. |
| The grounding contract shared by every AI writer: /api/flows/read builds a server-verified roster and drops any handle outside it; the mention engine only matches assets already in the registry; document_equipment_suggestions keeps an `applied` diff base so re-index never duplicates | `app/api/flows/read/route.ts:66-73,146-150; supabase/migrations/20260929_mention_engine.sql:19-23; lib/equipmentBridgeServer.ts:141-154` | No AI path in this system can invent equipment or grow the plant. That is a genuinely hard property to retrofit and it is consistently held. Any expansion of the intelligence layer should keep this shape. |
| Site Codebook as a real codec — parseDrawingNumber / tagToCode / codeToTag / typeForTag are pure functions over an org-taught segment map, with unit tests, and every consumer degrades honestly when the codebook is empty | `lib/codebook.ts; lib/__tests__/codebook.test.ts; lib/equipmentBridgeServer.ts:95-100` | This is the one org-specific vocabulary layer that is properly factored. It is what makes 'the plant's ID decoder files things correctly' achievable — the decoder works; only the import path fails to call it. |
| work_package_documents pins the revision that was current when a document joined the package (pinned_version_id + pinned_rev_label) and computes freshness at read time with no trigger state | `supabase/migrations/20260825_work_packages_acks.sql:37-46` | This is the cleanest link in the codebase — a join table that records not just 'these are related' but 'related as of this revision', with staleness derived rather than stored. It is the model the doc↔asset link should copy for sheet/rev awareness. |
| orgGraph's honest truncation reporting — every capped list pushes a human-readable note, and unmapped mentions are counted and explained rather than silently dropped | `lib/orgGraph.ts:96-97,164-168,299-315` | The graph already has the discipline of telling the user what it could not show. Extending that to dropped flow endpoints and to a roster-truncation warning in the PFD reader is a small, consistent step. |
| knowledge chunk lockdown: chunks of source-linked documents are unreadable by org members directly, so the ask API (service role) is the only door and it filters retrieval per asker through the real ACL engine | `supabase/migrations/20260917_knowledge_sources.sql:70-85` | The AI layer inherits document-control ACLs rather than bypassing them. Any new cross-layer join (e.g. an org-wide tag→sheet index) must be built behind the same service-role + per-caller-filter door, not as a client-readable table. |


---


<a id="wire-1"></a>

## WIRE-1 · The Equipment Bridge writes to a column the doc↔asset join table cannot see — every reverse lookup misses AI-extracted equipment

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:260-276`, `supabase/migrations/20260609_phase1_normalization.sql:80-120`, `app/(protected)/assets/[tag]/page.tsx:52-57`, `lib/orgGraph.ts:118-119,262`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The wiring gap is real and I could find no path that closes it — no backfill, no second write, no metadata-aware reader. Severity lowered to HIGH: nothing is corrupted or lost (the tags persist in metadata and render as chips), and one reverse surface is unaffected — assets/[tag]/page.tsx:228 also mounts MentionsPanel, which reads entity_mentions rather than document_assets. CRITICAL overstates a broken reverse index.

**Mechanism.** The Bridge's `populate` step writes tags into the library-configured custom column inside `documents.metadata`: `await admin.from("documents").update({ metadata: { ...metadata, [targetKey]: next }, updated_at: … })` (equipmentBridgeServer.ts:272-274). The only machinery that turns a document's tags into `document_assets` rows is the SQL trigger `documents_resync_assets_trg`, declared `AFTER INSERT OR UPDATE OF asset_tags, org_id ON documents` and reading `NEW.asset_tags` (20260609_phase1_normalization.sql:93-115, 116-120). Updating `metadata` does not fire it, and even if it did the function only reads `asset_tags`. Nothing anywhere writes `documents.asset_tags` except the split/merge lifecycle (`lib/documentLifecycle/common.ts:179`, `lib/documentLifecycle/merge.ts:150`) — grep for `asset_tags` across all .ts/.tsx returns 7 hits, none of them a general write path. So the Bridge — the ONLY automated path from a P&ID to equipment tagging — produces zero `document_assets` rows and zero `documents.asset_tags` entries.

**Failure scenario.** An org configures the bridge on its P&ID library, sweeps 400 sheets, and 3,000 tags are applied. The tags render as chips on each document row (lib/documentTags.ts:collectTagGroups reads `metadata`). Then: (a) `/assets/E-22` — the "digital twin" hub — runs `.contains("asset_tags", [{ tag }])` and shows "0 documents"; the QR sticker on the vessel leads to an empty page. (b) The unit hub's file list (`getDocumentsForAssetsHydrated` → `document_assets`, app/(protected)/admin/assets/page.tsx:979) shows nothing. (c) The org graph's `tag` edges (orgGraph.ts:262) draw nothing, so every discovered asset floats at degree 0. (d) `lib/impact.ts:68-79` where-used and `lib/revisionImpact.ts:63-67` fanout report "no other drawings carry this equipment" before a revision — a PSM/MOC-relevant false negative. (e) `lib/linkProposerServer.ts:233-237` shared-equipment proposals never fire.

**Evidence.**

```
lib/equipmentBridgeServer.ts:272 `const { error: updErr } = await admin.from("documents").update({ metadata: { ...metadata, [targetKey]: next }, updated_at: new Date().toISOString() })`. 20260609_phase1_normalization.sql:116-120 `CREATE TRIGGER documents_resync_assets_trg AFTER INSERT OR UPDATE OF asset_tags, org_id ON documents`. app/(protected)/assets/[tag]/page.tsx:55 `.contains("asset_tags", [{ tag }])`. The bridge file is 327 lines and contains no `document_assets` reference at all.
```

**Chain reaction.** Because `document_assets` is empty for bridge-derived equipment, everything downstream of it is empty too: graph tag edges, where-used, revision impact fanout, consolidation clustering (lib/consolidation.ts:125), and the shared-equipment link proposer. The system therefore *looks* wired (chips everywhere) while every reverse query returns nothing.

> **Verifier correction.** Two small overstatements, neither load-bearing. (1) "the ONLY automated path from a P&ID to equipment tagging" — the mention indexer (lib/mentionIndexer.ts, wired into app/api/knowledge/ingest/route.ts:157-169) is a second automated doc↔asset path; it writes entity_mentions, which lib/orgGraph.ts:300-305 draws as its own edge type, so the graph is not blind, but it too bypasses document_assets. (2) The defect is actually broader than stated: because nothing outside split/merge writes documents.asset_tags, document_assets is fed org-wide only by manual inserts (components/graph/GraphShapeWizard.tsx:147, app/(protected)/graph/page.tsx:359, app/(protected)/admin/assets/page.tsx:1336, lib/transitionIn.ts:230) — the trigger at 20260609:116-120 is effectively dormant for every document that was not born from a split or merge.

**Done when.**

- [ ] applyForDocument upserts `document_assets` rows (org_id, document_id, asset_id, tag_text, source) for every tag it resolves to an asset, or it also writes `documents.asset_tags` so the existing trigger fires
- [ ] /assets/<tag> lists the drawings the bridge tagged, sourced from document_assets rather than asset_tags containment
- [ ] orgGraph `tag` edges appear for bridge-discovered assets

---

<a id="wire-2"></a>

## WIRE-2 · Two intelligence-layer upserts name an ON CONFLICT target that matches no plain unique index; both failures are swallowed

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/mentionIndexer.ts:136-142`, `supabase/migrations/20260929_mention_engine.sql:59-60`, `lib/linkProposerServer.ts:403-406`, `supabase/migrations/20260807_link_proposals.sql:111-113`, `app/api/knowledge/ingest/route.ts:157-169`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both ON CONFLICT targets raise 42P10 and both paths are non-fatal, so the mention graph and auto-applied links stay empty with a success response. One precision note: the link proposer is not fully silent — it does `notes.push(\`Auto-apply skipped: ${error.message}\`)` at :406 — but it still never throws and autoApplied stays 0. HIGH stands.

**Mechanism.** `entity_mentions`' only unique index is an EXPRESSION index: `CREATE UNIQUE INDEX entity_mentions_unique_idx ON entity_mentions (asset_id, COALESCE(knowledge_document_id, document_id), page)`. The writer passes a plain column list: `.upsert(batch, { onConflict: "asset_id,knowledge_document_id,page", ignoreDuplicates: false })`. PostgREST renders that as `ON CONFLICT (asset_id, knowledge_document_id, page)`; Postgres arbiter inference requires an index whose key matches those columns, and a `COALESCE(...)` expression key does not. The same shape appears for `document_related_resources`, whose arbiter index is PARTIAL (`… (document_id, target_document_id) WHERE target_document_id IS NOT NULL`) while the upsert supplies no index predicate — a partial index is only a valid arbiter when the statement's `WHERE` implies the index predicate. Every other `onConflict` in the codebase (13 of them: document_supersessions, project_documents, distribution_acks, document_acknowledgments, document_intents, work_package_documents, document_assets, codebook_entries, …) targets a plain UNIQUE constraint, so these two are the outliers.

**Failure scenario.** A P&ID finishes indexing. `app/api/knowledge/ingest/route.ts:157-169` calls `indexDocumentMentions` inside `try { … } catch { /* mention edges are a bonus — never block ingestion */ }`. The upsert raises 42P10, `indexDocumentMentions` throws `mention index write: …`, the catch eats it, ingest reports success. The `entity_mentions` DELETE at :126-131 has already run, so the document's previous mentions are gone and no new ones land. Result: the asset backlinks panel (components/assets/MentionsPanel.tsx) is permanently empty, and the graph's `mention` edge type — described in 20260929_mention_engine.sql as "the entire reason the table exists" — never draws. Same pattern for provable-tier auto-applied links: `linkProposerServer.ts:405-406` pushes `Auto-apply skipped: <pg error>` into `notes` and reports zero applied links.

**Evidence.**

```
20260929_mention_engine.sql:59-60 `CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_unique_idx ON entity_mentions (asset_id, COALESCE(knowledge_document_id, document_id), page);` vs lib/mentionIndexer.ts:139 `.upsert(batch, { onConflict: "asset_id,knowledge_document_id,page", ignoreDuplicates: false })`. grep across all migrations for `entity_mentions` finds no other unique index. 20260807_link_proposals.sql:111-113 vs lib/linkProposerServer.ts:405. Marked SUSPECTED because I cannot execute against a live Postgres from this repo — the mismatch itself is CONFIRMED; only the runtime 42P10 is inferred from documented Postgres inference rules.
```

**Chain reaction.** Because both failures are caught and downgraded to silence (`catch {}` at ingest, a `notes` string in the proposer), the two features that make the graph explainable — the quote-carrying mention edge and the auto-applied provable link — can be dead in production with no error surface anywhere. Every audit that asks "why is the graph sparse?" would look at the extraction quality instead of the write.

> **Verifier correction.** Downgrade CRITICAL→HIGH and keep SUSPECTED, which the finding already self-labelled correctly. The mismatch is confirmed statically; the 42P10 is inferred from Postgres arbiter-inference rules with no database to run it against, and I could not execute one. If it does fire, the consequence is that the entire mention engine writes zero rows — which would silently empty lib/orgGraph.ts:300-305 mention edges and the /assets/[tag] MentionsPanel — but that is a degraded intelligence feature, not a safety or access-control failure, so HIGH rather than CRITICAL.

**Done when.**

- [ ] `CREATE UNIQUE INDEX entity_mentions_kdoc_page_idx ON entity_mentions (asset_id, knowledge_document_id, page)` (or the upsert switches to delete-then-insert) and a real ingest produces entity_mentions rows
- [ ] the document_related_resources upsert either targets a non-partial unique index or handles the partial predicate
- [ ] both call sites log the error rather than swallowing it

---

<a id="wire-3"></a>

## WIRE-3 · plants/units/systems is a scaffold nothing is ever filed into — six FK columns are declared, indexed, read, and never written

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260606_operational_entity_graph.sql:105-119`, `lib/assets.ts:170-202,206-215`, `lib/documentLifecycle/common.ts:181-182`, `lib/orgGraph.ts:253-261,321-325`, `lib/search.ts:176-184,540-542`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed dead scaffold. The only write path copies from a field that is always null, so assets.unit_id and documents.unit_id are null in every real row — which makes /admin/scope decorative, the search scope filters silently empty, and every `unit:`/`plant:` node degree-0 and then deleted by orgGraph.ts:321-325. HIGH stands.

**Mechanism.** `assets.plant_id/unit_id/system_id` and `documents.plant_id/unit_id/system_id` are real FKs to `plants`/`units`/`systems`, with partial indexes. `createAsset` (lib/assets.ts:170-202) and `updateAsset` (:206-215) never mention them; the `updateAsset` patch type is literally `Partial<Pick<Asset, "tag"|"type_id"|"description"|"location"|"library_id"|"archived"|"cover_photo_id"|"unit_code"|"code">>` — scope columns are excluded by type. The only writer of any of the six is `lib/documentLifecycle/common.ts:181-182` (`unit_id: input.unitId ?? null, system_id: input.systemId ?? null`), which copies the source document's scope during split/merge — and the source's scope is always NULL because nothing else sets it. `/admin/scope` creates plants/units/systems but assigns nothing to them. Meanwhile the registry actually files equipment by `assets.unit_code` (Site Codebook TEXT code), a completely separate identity with no bridge to `units.code`.

**Failure scenario.** An admin builds out Plant → Crude Unit → Feed System in /admin/scope, then goes to the org graph expecting to pivot on Crude Unit. `orgGraph.ts:259 if (d.unit_id) addEdge(...)` never fires and `:256 if (a.unit_id) addEdge(...)` never fires, so every `unit:<uuid>` and `plant:<uuid>` node ends at degree 0 and is deleted by the prune at `orgGraph.ts:321-325`. The units they just created are invisible. Separately, `lib/search.ts:180-184` exposes plantId/unitId/systemId filters that can only ever return zero rows, and `lib/search.ts:540-542`'s "sibling documents in the same system" narrowing never activates.

**Evidence.**

```
Three differently-shaped searches: (1) `unit_id` across all .ts/.tsx — 30 hits, the only write is documentLifecycle/common.ts:181; (2) `unitId` in components/ and app/ — 3 hits, all in /admin/scope creating `systems` rows; (3) `unit_id|plant_id|system_id` across app/api/**.ts — zero hits. lib/orgGraph.ts:8-9 documents the intent ("asset → unit assets.unit_code / assets.unit_id", "document → unit documents.unit_id") that the data never satisfies.
```

**Chain reaction.** Two rival unit identities coexist: `units.id`/`units.code` (dead) and `codebook_entries(kind='unit').code` mirrored into `assets.unit_code` (live). The graph creates BOTH node kinds (`unit:<uuid>` at orgGraph.ts:191 and `cbunit:<code>` at :199) and never draws an edge between them even when the codes match. This is why the owner's "extreme pivot" (scope everything to the crude unit) has no spine to hang on: documents are scoped by the dead identity, equipment by the live one.

> **Verifier correction.** One nuance worth carrying: the scaffold is not entirely unwritten across the schema — lib/plotPlans.ts:77-79 does write plant_id/unit_id/system_id on plot_plans. The finding's claim is nonetheless correct as stated, because it names the six columns on assets and documents specifically. Also note orgGraph.ts:322-325 deletes degree-0 unit/plant nodes, so the dead hierarchy is invisible rather than visibly broken — which is why this has gone unnoticed.

**Done when.**

- [ ] Either the plants/units/systems tables are retired and `unit_code` becomes the single unit identity, or a UI writes documents.unit_id / assets.unit_id and the graph joins `units.code` to `cbunit:<code>`
- [ ] lib/search.ts's plant/unit/system filters return non-empty results for a scoped org, or are removed
- [ ] a `unit:` node survives the degree-0 prune in a real org

---

<a id="wire-4"></a>

## WIRE-4 · Nine entity classes are invisible to the graph, which is why the "Process" and "Equipment" lenses do not describe what they show

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:23-35,99-144`, `app/(protected)/graph/page.tsx:428-433`, `lib/graphSettings.ts`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The countable core is true — the graph has seven node types and no lifecycle entity is among them — but the narrative that convicts the lenses is misattributed: the Process lens does hide plot plans and its label is accurate. What remains is a scope gap (the graph was built as an entity/paper map, not a work-in-flight map) plus one minor label/content mismatch in the Equipment lens, which is LOW, not MEDIUM.

**Mechanism.** `GraphNodeType = "document" | "asset" | "unit" | "library" | "project" | "plant" | "plot"` — seven kinds. `buildOrgGraph` loads exactly units, plants, libraries, projects, documents, assets, plot_plans and codebook units. There is no node for ticket, hold, checkout_session, transmittal, work_package, milestone, knowledge_document, knowledge_library, or `systems`. knowledge documents are deliberately excluded (orgGraph.ts:138-140) and their mentions are dropped when they have no controlled counterpart (:307-315). Since the four lenses are pure `hiddenTypes` subtraction over that seven-kind vocabulary, "Process" resolves to {asset, unit, plant, plot} and "Equipment ↔ Docs" to {document, asset, plot} — no process *flow* semantics, no equipment *state*.

**Failure scenario.** An engineer picks the Process lens expecting the plant as flow and gets equipment dots plus plot plans; they pick Equipment ↔ Docs expecting to see which of this unit's equipment is under hold or checked out and get only paper. The single question the graph most obviously ought to answer for a PSM site — "what is happening right now around this vessel: holds, MOC tickets, checked-out drawings, scheduled work" — has no representable edge, because none of those entities is a node.

**Evidence.**

```
lib/orgGraph.ts:23 `export type GraphNodeType = "document" | "asset" | "unit" | "library" | "project" | "plant" | "plot";`. app/(protected)/graph/page.tsx:430 `{ key: "process", label: "Process", hidden: ["document", "library", "project", "plot"], … }` and :431 `{ key: "equipment", label: "Equipment ↔ Docs", hidden: ["unit", "plant", "project", "library"], … }`. orgGraph.ts:311-314 emits the honest note that library-only mentions "come from library-only documents with no controlled counterpart".
```

**Chain reaction.** Because a lens can only subtract node types, and because there is no scope predicate in GraphSettings, there is no mechanism by which "crude unit: all of this goes here" could be expressed even if the entities existed. A scope filter would need a spine — and per finding #2 the document-side spine (documents.unit_id) is never written.

> **Verifier correction.** Two errors in the finding's own derivation, and the headline is softer than claimed. (1) "Process resolves to {asset, unit, plant, plot}" is wrong — the lens hides `["document", "library", "project", "plot"]`, so plot is excluded; Process resolves to {asset, unit, plant}. (2) "no process *flow* semantics" is wrong: lib/orgGraph.ts:286-289 emits a real `flow` edge type from confirmed process_flows rows, and the lens's own title at page.tsx:430 says "Units and equipment only — the plant as flow. Draw flows with Connect; read them off a PFD in the unit hub." The labels are therefore more accurate than the finding allows. What survives is the true and useful part for the owner's Q2: the graph's node vocabulary is seven types and the lenses are pure hiddenTypes subtraction over it (there is no scope/subtree filter in lib/graphSettings.ts), so work-in-flight — tickets, holds, checkouts, packages, milestones — can never appear on the map at all.

**Done when.**

- [ ] hold / ticket / checkout appear as node kinds or as state decorations on document and asset nodes
- [ ] a lens is defined by a predicate (scope + types) rather than a hiddenTypes array
- [ ] GraphSettings gains a scope field and the graph can be restricted to one operating area

---

<a id="wire-5"></a>

## WIRE-5 · Per-sheet equipment (the owner's Q6) exists in three stores and is joined in none — no query can answer "which sheets carry E-22"

- **Severity:** MEDIUM
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260921_drawing_entities.sql:20-35`, `supabase/migrations/20260928_site_codebook.sql:88-101`, `lib/equipmentBridgeServer.ts:28-34,147-154`, `supabase/migrations/20260609_phase1_normalization.sql:51-63`, `app/api/knowledge/locate/route.ts:115-125`
- **Independently verified:** ⛔ **REFUTED** by a second independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). REFUTED: two surfaces outside the drawing viewer answer the owner's Q6 — the equipment hub's MentionsPanel (asset → document + page, via entity_mentions) and the knowledge ask route's sheet-citation path (tag → sheet + page, via knowledge_page_entities). The residual truth is that the three stores are not reconciled with each other and that the entity_mentions store is left empty by the separate 42P10 bug in WIRE-2 — but that is WIRE-2's finding, not an absence of any query or surface.

**Mechanism.** Three representations of "tag X is on sheet Y" exist and none is queryable org-wide from the equipment side. (1) `knowledge_page_entities(document_id, page, kind, tag)` is the real per-page fact, but `document_id` is a *knowledge_documents* id, the tag is a raw string never resolved to `assets.id`, and its indexes are `(library_id, kind, tag)` and `(document_id, page)` — there is no `(org_id, tag)` index, so cross-library lookup is per-library. (2) `document_equipment_suggestions.suggested` carries `pages:number[]` per tag (BridgeSuggestion, equipmentBridgeServer.ts:31) but lives in untyped JSONB under `PRIMARY KEY (org_id, document_id)` with no GIN index — you can ask "what's on this document", never "which documents have this tag". The companion `applied` column stores tags only, dropping pages entirely (:280-285). (3) `document_assets` — the one table indexed both ways — has columns `(document_id, asset_id, tag_text, source)` and **no page or sheet column**.

**Failure scenario.** The owner's exact scenario: a master equipment list is imported, P&IDs arrive later, and someone asks "show me every sheet E-22 appears on." The only surface that can answer is `/api/knowledge/locate`, which is reachable only from inside the drawing viewer while already looking at a sheet, and its cross-sheet lookup is scoped `.eq("library_id", doc.library_id)` (locate/route.ts:121) — so equipment split across a PFD library and a P&ID library is invisible to it. The asset hub, the unit hub, the graph and search offer nothing.

**Evidence.**

```
20260921_drawing_entities.sql:31-35 `CREATE INDEX knowledge_page_entities_lib_idx ON knowledge_page_entities (library_id, kind, tag); CREATE INDEX knowledge_page_entities_doc_idx ON (document_id, page);`. 20260928_site_codebook.sql:92 `-- [{tag, code, pages:[int], assetId, assetStatus:…}]` with `PRIMARY KEY (org_id, document_id)` at :101 and no GIN index anywhere (grep `USING GIN` across all migrations returns 14 hits, none on `suggested`, `asset_tags`, or `items`). 20260609_phase1_normalization.sql:51-60 — document_assets has no page column.
```

**Chain reaction.** Q6's "create/tag assets per sheet" is one column away from working: the Bridge already computes `pages:number[]` per tag and already resolves each tag to an `assetId`. It throws that away at apply time, writing only a flat tag list to a metadata column.

> **Verifier correction.** "No query can answer 'which sheets carry E-22'" is false, and "cross-library lookup is per-library" is false. Three counter-paths: (1) lib/drawingText.ts:559-583 `equipmentRegisterCsv` emits rows headed `["Tag", "Category", "Occurrences", "Sheets", "First page"]` — literally tag→sheets — and is served by app/api/knowledge/drawing/route.ts action=export, per knowledge library. (2) app/api/knowledge/locate/route.ts:115-125 answers "it isn't on this page, it's on 025-PID-0103" by querying knowledge_page_entities `.eq("library_id", …).in("tag", missingHere)`. (3) knowledge_page_entities has an org_id column and IS queried org-wide, not per-library: lib/orchestrator/tools.ts:323-325 does `.eq("org_id", ctx.orgId).in("tag", [a, b]).eq("kind", "equipment")` and lib/knowledgeTagResolve.ts:28-52 does the same. The surviving, narrower truth is worth keeping for Q6: none of these paths resolves the raw tag string to `assets.id`, and document_assets has no page column, so the answer exists only on the knowledge/drawing side and can never be rendered from the equipment registry or the asset hub. Severity drops to MEDIUM accordingly.

**Done when.**

- [ ] document_assets gains a `pages int[]` (or a document_asset_pages child table) written by applyForDocument from BridgeSuggestion.pages
- [ ] an org-wide index exists on knowledge_page_entities (org_id, kind, tag)
- [ ] /assets/<tag> lists "P&ID 2030 sheet 4" rather than just the document

---

<a id="wire-6"></a>

## WIRE-6 · The PFD reader can only ever connect the first 300 assets, chosen in unspecified order, with no warning

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/flows/read/route.ts:58-73,167-181`
- **Also surfaced independently as** [`AREA-5`](./12-operating-areas.md#area-5) — two lenses found this separately. Fix once.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every point: unordered fetch, hard slice at 300, no warning in the response, and the guard at :62 only fires when the registry is entirely empty. A 2,000-asset plant silently reads its PFD against an arbitrary 15% of its own registry. MEDIUM stands.

**Mechanism.** The grounding roster is built as `assets.slice(0, 300).forEach((a, i) => roster.push({ ref: \`A${i+1}\`, kind: "asset", id: a.id, label: a.tag }))` from a query with `.limit(4000)` and **no `.order(...)`** — Postgres returns rows in whatever physical order it likes. The model is instructed "Use ONLY the roster handles" and any tag it reads that is outside the roster is dropped by `if (!from || !to …) continue`. The response reports only `{ proposed, skippedSettled, pagesRead }` — nothing tells the caller that 1,700 of their 2,000 assets were not offered to the model.

**Failure scenario.** A 2,000-asset plant runs "Read flows from a PFD" on its crude-unit PFD. If the crude unit's exchangers happen to sit outside the arbitrary first 300 rows, the AI reads the drawing correctly, finds E-22 → V-101, cannot map either handle, and the route returns `proposed: 0` with the note "No new flows found — the drawing may not print flow arrows between known tags". The user concludes the reader cannot read their drawings. Re-running can produce different results as the physical row order shifts after updates.

**Evidence.**

```
app/api/flows/read/route.ts:59 `supabaseAdmin.from("assets").select("id, tag").eq("org_id", orgId).eq("archived", false).limit(4000)` — no order clause. :70 `assets.slice(0, 300).forEach(...)`. :176-180 the response's `note` attributes an empty result to the drawing, never to roster truncation.
```

> **Verifier correction.** Worth noting the blast radius is bounded: an org with ≤300 registry assets is unaffected, and Site Codebook units are always fully rostered, so unit-level flows still read correctly on a big site. The defect is the silence, not the cap.

**Done when.**

- [ ] the roster is scoped to the drawing's decoded unit (parseDrawingNumber on the source document number) rather than an arbitrary 300
- [ ] the response reports rosterSize / rosterTruncated and the modal shows it
- [ ] the assets query carries a deterministic ORDER BY

---

<a id="wire-7"></a>

## WIRE-7 · Ticket, hold, checkout, work package and milestone carry no reference to equipment or to an operating area at all

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `types/schema.ts:1106-1113`, `types/schema.ts:453-497`, `types/schema.ts:542-556`, `supabase/migrations/20260825_work_packages_acks.sql:21-46`, `app/(protected)/requests/new/page.tsx:136-153`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. SURVIVES_CORRECTED: the underlying observation — no FK from any in-flight work object to assets or units, so "everything in flight on the crude unit" needs a multi-hop join that mostly dead-ends — is fair, but the title's "no reference to equipment or to an operating area at all" is factually wrong for tickets (`unit`) and milestones (`location`, explicitly documented as area/unit/equipment tag). With that overstatement removed this is a schema-scope feature gap, not a defect: LOW.

**Mechanism.** `Ticket.unit: string` is free text: the request form fills it from the Site Codebook when configured (`cfg.units = { options: book.units.map(u => ({ label: \`${u.code} — ${u.label}\`, value: u.code })) }`, requests/new/page.tsx:142-148) but stores the bare code into a nullable `unit TEXT` column with no constraint, no index and no FK. There is no equipment-tag field on the request form at all (grep `tag|asset` over that file returns nothing). `DocumentHold` has only `documentId`. `CheckoutSession` has documentId/libraryId/projectId. `work_packages` joins only to documents (`work_package_documents`). `Milestone.location` is documented as "Where the work happens — area / unit / equipment tag" but is a plain string that lib/milestones.ts only round-trips (:106, :980) — nothing ever resolves it to a unit or an asset.

**Failure scenario.** "Everything currently in flight on the crude unit" is unanswerable. Open drafting requests are findable only by string-matching `tickets.unit = '20'` (no index, no UI). Open holds cannot be filtered by unit or by equipment at all — you would have to go hold → document → document_assets → asset → unit_code, and the first hop of that chain is empty for bridge-derived equipment (finding #1). Scheduled turnaround work tagged `location: "E-22 north side"` never appears on the equipment's page.

**Evidence.**

```
types/schema.ts:1112 `unit: string;` on Ticket; supabase/schema.sql:403 `unit TEXT,`. types/schema.ts:495 `/** Where the work happens — area / unit / equipment tag. */ location?: string | null;`. types/schema.ts:542-556 DocumentHold — documentId only. 20260825_work_packages_acks.sql:21-32 work_packages — no asset_id, no unit column. grep `asset` over lib/holds.ts and lib/workPackages.ts returns nothing.
```

> **Verifier correction.** The title's "at all" is too absolute in two places. (a) Ticket.unit does carry the operating area — the codebook unit code — it is just stored as unconstrained free text, so it cannot be joined or trusted; the defect is the missing constraint, not a missing reference. (b) A ticket reaches equipment indirectly in two hops via metadata.source_document.id → documents → document_assets, and lib/impact.ts:111-118 actually uses that path to show open tickets on a document. The accurate framing: none of these five entities can be filtered, grouped or graphed by equipment or area, because every link is either free text or a two-hop JSONB traversal.

**Done when.**

- [ ] tickets gain a unit_code column (FK-checked against codebook_entries) plus an optional equipment tag list
- [ ] holds and work packages can be listed by operating area
- [ ] milestone.location resolves to an asset or unit when it matches, and the asset hub shows scheduled work

---

<a id="wire-8"></a>

## WIRE-8 · Transmittal↔document and ticket↔document are unindexed JSONB scans, and the ticket link is written in two incompatible shapes

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:394-406`, `supabase/migrations/20260717_transmittals.sql:40,53-54`, `lib/impact.ts:111-118`, `lib/transitionIn.ts:321-322`, `app/(protected)/requests/new/page.tsx:290-297`, `app/api/intake/resolve/route.ts:151-154`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. SURVIVES on facts, downgraded on impact. Both queries stay org-scoped, and the finding's own scale ("a few thousand transmittals") is a sub-millisecond scan in Postgres — the performance claim does not carry MEDIUM. The shape mismatch is currently unreachable: intake/resolve pre-filters on `metadata->intake_collision->>intakeLinkId`, which only transitionIn writes, so it only ever sees the `number` shape. Latent inconsistency worth fixing, LOW.

**Mechanism.** A transmittal's contents live in `items JSONB NOT NULL DEFAULT '[]'` with no join table and no GIN index (the only indexes are `(org_id, number)` and `(org_id, status, created_at DESC)`). The reverse question is answered by `.contains("items", JSON.stringify([{ documentId }]))` — a sequential scan over every transmittal, executed on every inspector open. The ticket↔document link is `tickets.metadata->source_document->>id`, likewise unindexed (`tickets` has GIN indexes on `watchers` and `search_tsv` only). Worse, three writers disagree on the shape: `lib/transitionIn.ts:322` writes `{ id, number, title }` while `app/(protected)/requests/new/page.tsx:291-296` and `components/documents/CheckInPanel.tsx:262` write `{ id, document_number, title, rev, path }`; `app/api/intake/resolve/route.ts:151-154` reads `meta.source_document?.number`, which only ever matches the first shape.

**Failure scenario.** On a site with a few thousand transmittals, opening the inspector's "Which transmittals carried this document?" panel (components/documents/InspectorPanel.tsx:1033-1041) full-scans the table; the same happens for the where-used open-tickets slice in lib/impact.ts. And any future consumer that reads `source_document.number` gets `undefined` for tickets raised from the request form or from check-in, because those wrote `document_number` instead.

**Evidence.**

```
lib/transmittals.ts:401 `.contains("items", JSON.stringify([{ documentId }]))`. lib/impact.ts:117 `.eq("metadata->source_document->>id", documentId)`. grep `USING GIN` across all migrations: 14 hits, none on `transmittals.items`, `tickets.metadata`, or `documents.asset_tags`. lib/transitionIn.ts:322 `source_document: { id: candidate.docId, number: candidate.number, title: candidate.title }` vs requests/new/page.tsx:292-296 `{ id: sourceDocId, document_number: sourceDocNum, title: …, rev: …, path: … }`.
```

> **Verifier correction.** The "worse" clause is refuted and should be dropped. app/api/intake/resolve/route.ts:149-153 reads `meta.source_document?.number`, but its query at :145 is `.eq("metadata->intake_collision->>intakeLinkId", link.id)` — and grep for `intake_collision` across *.ts/*.tsx returns exactly one writer, lib/transitionIn.ts:323, the same writer that uses the `{number}` shape. So that reader only ever sees tickets it can parse; the divergence is latent, not observable. The other reader, lib/impact.ts:117, keys on `source_document->>id`, which all three shapes carry. What survives is the unindexed-scan half only: a seq scan over transmittals on every inspector open and an unindexed JSONB path predicate on tickets. MEDIUM is right for that.

**Done when.**

- [ ] GIN indexes exist on transmittals.items (jsonb_path_ops) and tickets.metadata, or transmittal items move to a join table
- [ ] all three writers of tickets.metadata.source_document agree on one field name
- [ ] the asset hub's `.contains("asset_tags", …)` gets an index or moves to document_assets

---

<a id="wire-9"></a>

## WIRE-9 · document_versions.related_ticket_id is read in two places, written in none — and the review-gate escape hatch it feeds is unreachable twice over

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:334`, `lib/revisions.ts:958`, `app/(protected)/documents/[libraryId]/page.tsx:1893`, `lib/reviewControl.ts:55-61`, `components/documents/RevUpModal.tsx:210`, `lib/documentLifecycle/setRevUp.ts:83`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. SURVIVES on the facts — the escape hatch is dead twice over, so a ticket-derived rev never skips the gate as documented. Downgraded because the failure direction is safe: the consequence is an unnecessary trip through the reviewer queue, never a revision publishing without a review it should have had. Dead documented feature + extra friction is LOW, not MEDIUM.

**Mechanism.** `document_versions.related_ticket_id UUID` (schema.sql:334) is mapped into `DocumentVersion.relatedTicketId` by two readers and set by no writer — two search shapes (`related_ticket_id` and `relatedTicketId` across .ts/.tsx/.sql) return only those two reads plus the schema declaration and `lib/reviewControl.ts`. `reviewControl.ts:55-61` implements a documented business rule on it: `export function effectiveModeForRevUp(input: { control; changeType?; relatedTicketId?: string|null }) { … if (input.relatedTicketId) return "none"; … }`. Both call sites omit the field entirely: `effectiveModeForRevUp({ control: reviewControl ?? { mode: "none" }, changeType })` (RevUpModal.tsx:210) and `effectiveModeForRevUp({ control, changeType })` (setRevUp.ts:83).

**Failure scenario.** An org sets a library's ReviewControl mode to `require`. types/schema.ts:189-190 promises "a rev that came from a drafting ticket always skips the gate." A drafter completes a ticket, the deliverable is published as a new revision — and it is routed into the pre-publish reviewer queue anyway, because (a) nothing ever stamped `related_ticket_id` on the version and (b) neither caller would read it if something had. The ticket→revision provenance link is also absent from the graph and from any audit query: "which revisions came out of ticket DR-0142?" has no answer.

**Evidence.**

```
lib/reviewControl.ts:60 `if (input.relatedTicketId) return "none";`. RevUpModal.tsx:210 and setRevUp.ts:83 both call it without `relatedTicketId`. grep `related_ticket_id` across .ts/.tsx/.sql: supabase/schema.sql:334 (declaration), lib/revisions.ts:958 and app/(protected)/documents/[libraryId]/page.tsx:1893 (both reads). The unit test lib/__tests__/reviewControl.test.ts:42 asserts the skip behaviour on a hand-passed value, so the rule is tested but never exercised.
```

**Chain reaction.** Same shape as the previously-found checkout_sessions.linked_ticket_id: a ticket↔document-revision link is modelled in the schema, typed in TypeScript, depended on by a rule, and never populated. Note the contrast — projects.linked_ticket_id IS written (lib/projects.ts:112, :807) and milestones.linked_ticket_id IS written (lib/milestones.ts:171), so this is specifically the revision-level link that was dropped.

> **Verifier correction.** HIGH→MEDIUM. The failure direction is conservative, not permissive: with related_ticket_id never set, the escape hatch never fires and ticket-originated rev-ups keep going through the review gate. Nothing is waived that should not be; the cost is friction plus a loaded waiver waiting for the first code that writes the column. Note this is not a new discovery — the repo already catalogues it as LIFE-2 in audit-reports/roles-and-permissions/07-document-lifecycle.md:113 ("a review-gate waiver that no code path writes — a loaded gun"), with an explicit warning at 90-gap-register.md:411 not to set the column before the waiver is removed.

**Done when.**

- [ ] the publish path stamps document_versions.related_ticket_id when a rev originates from a ticket deliverable
- [ ] both effectiveModeForRevUp call sites pass relatedTicketId
- [ ] the inspector's history can show "Rev 3 — from DR-0142"

---

<a id="wire-10"></a>

## WIRE-10 · process_flows endpoints are untyped TEXT with no FK and no index — the plant's topology dangles the moment an asset is deleted

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261017_process_flows.sql:16-37`, `lib/assets.ts:216-219`, `lib/orgGraph.ts:284-289`, `app/api/flows/read/route.ts:152-165`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The dangling-row and silent-drop halves are correct — nothing anywhere deletes process_flows rows when an asset dies (repo-wide grep: process_flows is touched only by lib/processFlows.ts, app/api/flows/read, lib/orgGraph.ts, exportTables/dataRestore). But the 'no index' half is wrong: `UNIQUE (org_id, from_kind, from_ref, to_kind, to_ref)` (line 36) creates a btree whose leading columns cover from-side lookups, and no query in the repo filters by ref at all (every read is `.eq("org_id", …)`). Impact is also narrower than stated: once the asset is gone the hop is genuinely unrepresentable, so the residue is stale rows in exports/proposal lists rather than a wrong topology — LOW.

**Mechanism.** `from_kind/from_ref` and `to_kind/to_ref` store an `assets.id` uuid as TEXT (kind='asset') or a Site Codebook unit code (kind='unit'), deliberately without FKs ("Endpoints are (kind, ref) pairs rather than hard FKs"). The only index is `process_flows_org_idx ON (org_id, status)` — nothing indexes `from_ref`/`to_ref`. `deleteAsset` is a hard delete: `await supabase.from("assets").delete().eq("id", id)` (lib/assets.ts:217). Nothing cleans up flows.

**Failure scenario.** An asset created by mistaken bridge discovery is deleted from the registry. Its flow edges survive as rows pointing at a nonexistent uuid. `orgGraph.ts:173-174 addEdge` guards with `!nodes.has(a)` and silently drops them, so the graph quietly loses a hop in the flow chain with no truncation note. Worse, the `UNIQUE (org_id, from_kind, from_ref, to_kind, to_ref)` constraint still holds the orphan pair, and `/api/flows/read` builds its `settled` set from ALL prior rows regardless of status (route.ts:84-90, no `.eq("status", …)` filter) — so re-reading the PFD after re-creating the asset under a new uuid works, but a stale *proposed* row permanently blocks a re-proposal of the same pair even though nobody ever decided it.

**Evidence.**

```
20261017_process_flows.sql:18-21 `from_kind TEXT NOT NULL CHECK (from_kind IN ('asset','unit')), from_ref TEXT NOT NULL,` and :38 `CREATE INDEX process_flows_org_idx ON process_flows (org_id, status);`. lib/orgGraph.ts:284-285 `const flowNodeId = (kind, ref) => kind === "asset" ? \`asset:${ref}\` : \`cbunit:${ref}\`;`. app/api/flows/read/route.ts:85-90 selects prior flows with no status predicate while the file header claims "pairs already decided (confirmed OR dismissed) are never re-proposed".
```

> **Verifier correction.** Two corrections. (1) The sub-claim that app/api/flows/read/route.ts:85-90 contradicts the file header is wrong: the header (:10) says "pairs already decided (confirmed OR dismissed) are never re-proposed", and selecting prior flows with NO status predicate is a strict superset of that — it also skips still-pending proposals, which is correct anyway since the UNIQUE(org_id, from_kind, from_ref, …) constraint at :36 would reject a duplicate. Not a defect. (2) The consequence is softer than "the topology dangles": lib/orgGraph.ts:174 `if (a === b || !nodes.has(a) || !nodes.has(b)) return;` silently drops any edge whose endpoint node is gone, so a dangling flow row is invisible rather than broken. The real cost is orphan rows that resurrect if a tag is ever re-created with the same uuid-shaped ref, plus unindexed scans on from_ref/to_ref. MEDIUM stands.

**Done when.**

- [ ] orphan process_flows rows are detectable (a nightly integrity check, or a real FK on an asset-endpoint column)
- [ ] the settled-pair query filters to status IN ('confirmed','dismissed')
- [ ] orgGraph reports dropped flow endpoints in `truncations` instead of silently skipping them

---
