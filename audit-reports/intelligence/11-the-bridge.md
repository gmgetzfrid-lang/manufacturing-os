# 11 · The Bridge — drawings build the registry

**14 findings** — 3 HIGH · 11 MEDIUM.

**Your equipment question.** What happens today, step by step, and where it stops.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| knowledge_page_entities — per-page equipment tags with normalized 0..1 positions and a kind discriminator, written idempotently (page range cleared then rewritten) with layered schema fallbacks | `supabase/migrations/20260921_drawing_entities.sql:20-38; lib/knowledgeIngest.ts:396-428` | This is the raw material for every per-sheet question the owner asks. It already knows which tag is on which page and where on the page. The Bridge's per-sheet gap (finding 7) is a join that was never written, not missing data. |
| Title-block 'self' entities — ingestion already records each sheet's own declared drawing number and sheet number as `${drawingNumber}-SH${sheetNumber}` | `lib/knowledgeIngest.ts:281-293` | The plant's real sheet identity is already extracted and stored per page. Joining kind='self' to kind='equipment' on (document_id, page) yields exactly 'which equipment is on which sheet' — question 6's core — with no new extraction. |
| lib/codebook.ts pure codec — normalizeTag/splitTag/typeForTag/tagToCode/codeToTag/parseDrawingNumber, side-effect free, unit-tested, degrading to null on an empty codebook | `lib/codebook.ts:108-261` | The site-language layer is genuinely done and genuinely facility-agnostic. parseDrawingNumber already returns unitCode, drawingTypeCode, size, iterable AND sheet; the Bridge simply discards four of the five. |
| /api/knowledge/drawing — the ACL-aware deterministic census: equipment by category, ref audit, and equipmentRegisterCsv exporting one row per tag with the sheets it appears on | `app/api/knowledge/drawing/route.ts:1-34; lib/drawingText.ts:557-583` | The read-only twin of the Bridge already answers 'which equipment on which sheets' for a knowledge library, correctly ACL-filtered. It is the model the Bridge's authorization should copy (finding 6) and a shortcut to the per-sheet view. |
| lib/knowledgeAccess.ts loadPrincipal + chainReadable — the single ACL truth, merging role with the additive roles[] and evaluating the real library→folder→document chain | `lib/knowledgeAccess.ts:31-78` | The correct authorization bar already exists and is used by the ask and drawing routes. Fixing /api/equipment-bridge is adoption, not invention. |
| assets UNIQUE(org_id, tag_normalized) plus the assets_backfill_documents trigger that links a newly created asset to every document already naming it | `supabase/migrations/20260603_asset_registry.sql:46; supabase/migrations/20260609_phase1_normalization.sql:126-145` | The registry spine is right: the uniqueness constraint makes concurrent discovery genuinely safe (the loser resolves to the winner at equipmentBridgeServer.ts:226-230), and the backfill trigger means that once documents.asset_tags is fed, late-registered assets self-link retroactively. Finding 1 is one write away from working. |
| UnassignedAssignPanel — always-visible per-asset unit dropdown with drawing-derived pre-selection, evidence shown, never auto-committing | `app/(protected)/admin/assets/page.tsx:960-1085` | A well-designed human-in-the-loop filing surface with the right ethic ('Suggestions are a convenience, never a requirement'). It is the natural home for the operating-area 'extreme pivot' and for reviewing discovered assets — it just needs a data source. |
| document_equipment_suggestions with a preserved `applied` array, RLS on org membership, and a status enum that already includes 'dismissed' | `supabase/migrations/20260928_site_codebook.sql:93-119; lib/equipmentBridgeServer.ts:137-155` | The review-state table was designed for accept/reject and for a diff base across recomputes. Findings 3 and 14 are unimplemented halves of a schema that already anticipates them. |
| asset_aliases with getAssetByTag's alias fallback — a nickname, pre-renumber tag or vendor name resolves to the same asset | `lib/assets.ts:147-170` | Real-world tag drift is already handled on read. The Bridge's reconcile step (equipmentBridgeServer.ts:102-112) matches on tag_normalized only and would create a duplicate asset for a known alias — but the alias table it should consult already exists and is populated. |
| Bridge failures can never break ingestion — dynamic import, fire-and-forget, catch-to-undefined; and auto-apply failure leaves the suggestion pending rather than throwing | `lib/knowledgeIngest.ts:448-456; lib/equipmentBridgeServer.ts:128-133` | The blast-radius containment is correct and should not be traded away when fixing the findings above. The cost is silence (finding 2), which is fixable by recording the reason rather than by removing the containment. |


---


<a id="br-1"></a>

## BR-1 · /api/equipment-bridge authorizes on org role only — no library ACL check, and it ignores the additive roles[] column every other route honors

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/equipment-bridge/route.ts:26`, `app/api/equipment-bridge/route.ts:32-42`, `lib/knowledgeAccess.ts:31-46`, `app/(protected)/documents/[libraryId]/page.tsx:3769-3777`, `lib/permissions.ts:18-20`, `supabase/migrations/20260722_member_roles_collection.sql:13`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The security claim holds and is not merely a UI/server mismatch: the route writes through supabaseAdmin, so it bypasses the DB-level ACL guards that catch the equivalent client write (supabase/migrations/20260901_db_hard_enforcement.sql:152-162 `documents_deny_write_guard ... AS RESTRICTIVE FOR UPDATE ... auth.uid() IS NULL OR ...` — service role is exempt) and 20260708_acl_rls_enforcement.sql:85-87 `documents_acl_select`. One clause of the title is overstated: `roles[]` is NOT honored by 'every other route' — app/api/codebook/import/route.ts:192, app/api/graph/mentions/route.ts:43, lib/serverAuth.ts:51, lib/projects.ts:589, lib/reviewCycles.ts:234 and lib/accessRecert.ts:160 all select only `role`. That clause is inert anyway (ignoring roles[] under-grants, it does not leak).

**Mechanism.** authWriter selects only the headline role — `.from("org_members").select("role").eq("org_id", orgId).eq("uid", user.id).eq("status", "active")` — and tests `WRITER_ROLES.has(String(member.role))` where WRITER_ROLES = {Admin, DocCtrl, Manager, Supervisor} (route.ts:26, 37-40). Two divergences follow. (a) No ACL: the route never evaluates the target library's or documents' ACL chain, unlike every other knowledge-side route which goes through `loadPrincipal` + `readableControlledDocIds` (lib/knowledgeAccess.ts:31-46, used by app/api/knowledge/drawing/route.ts:29). It then writes `documents.metadata` and inserts `assets` rows with the service-role client, bypassing RLS entirely. (b) Additive roles: `org_members.roles TEXT[]` exists (20260722_member_roles_collection.sql:13) and is merged with the headline role by lib/knowledgeAccess.ts:38, app/api/ai/usage/route.ts:35, app/api/ai/connection/route.ts:48 and app/api/admin/schema-health/route.ts:39 — this route does not. lib/codebook.ts:382-387 and app/api/area/knowledge-status/route.ts:269 both carry written warnings about exactly this bug class.

**Failure scenario.** Leak direction: a Manager or Supervisor in the org is not shown the Equipment sweep button (the page gates it on `isController = isControllerRole(activeRole)`, i.e. Admin/DocCtrl only — documents/[libraryId]/page.tsx:3769 with lib/permissions.ts:18-20), but can POST action="apply" with any libraryId in the org and mutate the metadata of documents in an ACL-restricted library they cannot read, and create registry assets from tags extracted from those restricted drawings. Deny direction: a document controller whose DocCtrl authority lives in roles[] rather than the role column sees the sweep button (if the page's activeRole resolves) and gets a flat 403 from every Bridge action with no explanation.

**Evidence.**

```
app/api/equipment-bridge/route.ts:37-40 — `const { data: member } = await supabaseAdmin.from("org_members").select("role")... if (!member || !WRITER_ROLES.has(String(member.role))) return bad("Not permitted", 403);`. lib/knowledgeAccess.ts:38 — `const roles = new Set<string>([member.role as string, ...((member.roles as string[]) ?? [])]);`. app/api/knowledge/drawing/route.ts:23-24 — `// ACL: entities mirror controlled documents — results exclude every doc the // CALLER can't read, same engine as the ask route. Fails closed.`
```

> **Verifier correction.** Claim (b) is largely refuted and should be dropped from the writeup as stated. org_members.roles exists (20260722_member_roles_collection.sql:13) but the same migration documents the invariant that `role` is 'always the highest-ranked role in the collection', and the app maintains it on write: app/(protected)/admin/users/page.tsx:130-137 saves `{ roles: cleaned, role: primaryRole(cleaned) }`. So reading only the headline is a documented, supported pattern, not a leak. The residual bug is narrow and FAIL-CLOSED, not open: ROLE_RANK (lib/roleCapabilities.ts:74-93) puts DraftingSupervisor at 75, above DocCtrl at 70, so a member holding roles=[DraftingSupervisor, DocCtrl] gets headline DraftingSupervisor, which is not in WRITER_ROLES, and is wrongly 403'd. That is a denial, not an escalation. Keep the finding at HIGH on the strength of (a) alone.

**Done when.**

- [ ] authWriter merges `roles[]` with `role` like lib/knowledgeAccess.ts:38
- [ ] sweep and apply evaluate the target library's ACL chain per document via loadPrincipal/readableControlledDocIds and skip documents the caller cannot read
- [ ] the API's permitted role set and the UI's isController gate agree, or the divergence is deliberate and documented
- [ ] an API-authorization test covers a Manager applying to an ACL-restricted library

**Resolution (2026-10-02, intelligence Round G).** `app/api/equipment-bridge/route.ts` `authWriter` reads `role, roles` and admits the registry writer tier (Admin, DocCtrl, Manager, Supervisor) by the collection (`memberHoldsAny`, ADD-1), then loads the caller's ACL principal (`loadPrincipal`). Every action that reads or writes a document asks `readableControlledDocIds` first, failing closed (a failed ACL read is no readable document):
- GET lists only the readable documents' proposals and relations, and says how many it left out (`unreadable`).
- The sweep counts an unreadable document and never computes it.
- Apply skips and counts one.
- Dismiss and the vanished review refuse one (403).
- Settings refuses a library of another workspace (404).

Decision (DEC-44 (I-11) item 1): skip and report, never widen. The writes stay on the service role (registry rows and 'drawing' relation rows are service-role writes), and only for documents the caller may read.

**Fix pass (2026-10-02, review).** The first resolution overstated "every action evaluates the caller's ACL": `readableControlledDocIds` evaluates a document's chain, not its org — it returns every id it is handed for a controller, and default-allows a foreign document whose library is not in a writer's landscape — so a controller of their own org could send another workspace's document id to `dismiss` / `vanished` and the service role removed (or un-marked) that workspace's 'drawing' rows, with the audit row landing in the caller's org. Now:
- `inOrgDocIds` (route) confirms every caller-supplied document id is a document of `orgId` before anything else: `dismiss`, `vanished` and the new `adopt` return 404 for another workspace's id; `apply` skips it as `not_found` and counts it (`notFound`).
- `lib/equipmentBridgeServer.ts` names `org_id` on every `document_assets` read, update and delete (`syncDrawingRelations`, `markRevisionTruth`, `removeDrawingRelations`, `reviewVanished`, `adoptDrawingRelation`), so the library itself cannot touch another workspace's rows whatever its caller passes.
- `libraryGate` (route): GET and settings read the library by id AND `org_id` (404 otherwise) and require the caller to read it (`containerReadable` on the library ACL; controllers excepted; fails closed) — 403 otherwise. GET no longer returns another workspace's mapping or `autoApplyBy` / `reviewedBy` uids, and a Manager who cannot read a restricted library can no longer turn its auto-apply on.
- Tests: `lib/__tests__/equipmentBridgeRoutes.test.ts` "reproduction → fix: a controller of org A sending org B's document id gets a 404 on dismiss / vanished (remove and keep); org B's rows are untouched; no audit row is written", "apply skips another workspace's document as not found; adopt refuses it", "GET and settings refuse another workspace's library (404) …", "a Manager who cannot read a library can neither read its configuration nor turn its auto-apply on (403)"; `lib/__tests__/equipmentBridge.test.ts` "reproduction → fix: a review sent with another org's id never touches this org's rows (remove, keep, dismiss)" and "the library's every document_assets read, update and delete names org_id". Each fails on the pre-fix route / library.

**Done-when.**
1. ✓ `authWriter` merges `roles[]` with `role` (`memberHoldsAny` over the collection).
2. ✓ Sweep and apply evaluate the caller's ACL per document (`loadPrincipal` + `readableControlledDocIds`) and skip what the caller cannot read, counting it — after the workspace check (fix pass), which the ACL engine does not make.
3. ✓ The divergence is deliberate and documented (route header; DEC-44 (I-11) item 1). The library page offers the sweep to the controller tier (`isController` in `app/(protected)/documents/[libraryId]/page.tsx`, not this package's file, unchanged). The API admits the registry writer tier (DEC-53 item 1). The per-document ACL is what keeps a Manager off a library they cannot read.
4. ✓ `lib/__tests__/equipmentBridgeRoutes.test.ts` "reproduction → fix: a Manager applying to an ACL-restricted document writes nothing to it; the readable one is applied; the skip is counted". Also: a Viewer refused and a DocCtrl held additively admitted; GET lists only readable documents; dismiss / vanished on an unreadable document refused.

**Scope / residual.** The page's button gate belongs to the library page (edited next by IS-P1 / I-12); nothing here depends on it.

**Fix pass 2 (2026-10-02, review).** The sweep skipped `libraryGate`: a Manager who cannot read a restricted library could post `action "sweep"` with its id and learn its live document count (`counts.unreadable`). The sweep branch now calls `libraryGate(orgId, libraryId, auth.principal)` first, as GET and settings do: 404 for another workspace's library, 403 for one the caller cannot read, before any document is listed. The settings save also refuses (500) when the stored configuration cannot be read, instead of rebuilding it without the library's review mark (`loadBridgeConfig` now returns its read error). Test: `lib/__tests__/equipmentBridgeRoutes.test.ts` "sweep goes through the same library gate (fix pass 2): another workspace's library is 404, an unreadable one 403 — no counts of its documents leave it" (fails on the fix-pass-1 route).

---

<a id="br-2"></a>

## BR-2 · The Bridge writes a display column, not a link: applied tags never reach document_assets or the asset hub

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:261-276`, `supabase/migrations/20260609_phase1_normalization.sql:85-120`, `app/(protected)/assets/[tag]/page.tsx:51-57`, `components/assets/AreaKnowledgePanel.tsx:124-127`, `components/assets/AreaKnowledgePanel.tsx:346-349`, `lib/operationalGraph.ts:317-330`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide grep for `asset_tags` writers finds only lib/documentLifecycle/common.ts:179 and merge.ts:150 (split/merge) — nothing in the bridge path writes asset_tags, so neither the trigger nor the assets-INSERT backfill (migration :122-135) ever fires for bridge-applied tags. Confirmed.

**Mechanism.** applyForDocument's populate step writes a plain string array into `documents.metadata[targetKey]`: `.update({ metadata: { ...metadata, [targetKey]: next } })` (equipmentBridgeServer.ts:272-273). The normalized document↔asset join table `document_assets` is maintained by a Postgres trigger that fires only on a different column: `CREATE TRIGGER documents_resync_assets_trg AFTER INSERT OR UPDATE OF asset_tags, org_id ON documents` reading `NEW.asset_tags` (20260609_phase1_normalization.sql:117-120, 95-101). Two differently-shaped searches (`grep -rn "asset_tags" --include=*.ts --include=*.tsx` and a case-insensitive sweep across ts/tsx/sql) show `documents.asset_tags` is written by exactly two places, both split/merge lifecycle: lib/documentLifecycle/common.ts:179 and lib/documentLifecycle/merge.ts:150. The Bridge writes neither asset_tags nor document_assets. Downstream, the asset hub finds its drawings with `.contains("asset_tags", [{ tag }])` (assets/[tag]/page.tsx:55) and the Operating Areas checklist counts `document_assets` rows (AreaKnowledgePanel.tsx:124-127).

**Failure scenario.** A plant sweeps 400 P&IDs. Every sheet's Equipment column fills with correct chips in the document library. Then: /assets/E-22 says "No controlled documents are tagged to E-22 yet" and its "Controlled documents" stat reads 0; the crude unit's Area panel Step 4 ("Link equipment files to assets", state driven by docLinkCount>0 at AreaKnowledgePanel.tsx:347) stays "todo" forever, directly contradicting its own body text at line 348, "drawings that print the tag link themselves"; and UnassignedAssignPanel's drawing-derived unit hints (admin/assets/page.tsx:979-998, fed by getDocumentsForAssetsHydrated → document_assets) come back empty, so the operator still hand-picks a unit for every asset. The QR-scan-to-doc-pack story on the asset hub is dead for every bridge-populated drawing.

**Evidence.**

```
equipmentBridgeServer.ts:272-274 — `.update({ metadata: { ...metadata, [targetKey]: next }, updated_at: ... }).eq("id", documentId)`. 20260609_phase1_normalization.sql:117-120 — `CREATE TRIGGER documents_resync_assets_trg AFTER INSERT OR UPDATE OF asset_tags, org_id ON documents FOR EACH ROW EXECUTE FUNCTION documents_resync_assets();`. assets/[tag]/page.tsx:55 — `.contains("asset_tags", [{ tag }])`. AreaKnowledgePanel.tsx:348 — "Open any asset below → **+ Link document** attaches its data sheets and files; drawings that print the tag link themselves."
```

> **Verifier correction.** Downgraded CRITICAL→HIGH: the asset hub is not fully blind. app/(protected)/assets/[tag]/page.tsx:228 renders <MentionsPanel>, which reads entity_mentions (written at ingest by lib/mentionIndexer.ts:110-141 via app/api/knowledge/ingest/route.ts:158) and does list every indexed document that prints the tag, with page and snippet. So a user on the asset page DOES see the P&ID — in the Mentions panel, not in the drawings list (which uses `.contains("asset_tags", [{ tag }])`, page.tsx:55). Caveat that cuts the other way: mentions are matched against a dictionary loaded from the assets table at index time (mentionIndexer.ts:41-44), so an asset the Bridge DISCOVERS after indexing has no mentions until a re-index/backfill. The document_assets half of the finding is unmitigated and is the load-bearing part.

**Done when.**

- [ ] applyForDocument writes the applied tags into `documents.asset_tags` (or inserts document_assets rows directly with a distinct source, e.g. 'bridge') in the same transaction as the metadata write
- [ ] /assets/[tag] lists every drawing the Bridge applied that tag to
- [ ] AreaKnowledgePanel Step 4 flips to done after a sweep, without any manual + Link document
- [ ] a regression test asserts that after applyForDocument, a document_assets row exists for (documentId, assetId)

**Resolution (2026-10-02, intelligence Round G).** Reproduced first (DEC-29): with the base files (`e5de803`) swapped back in, seven of the new cases fail (no `document_assets` row after apply; AREA-4's throw "No equipment column mapped for this library…"; no sheets on a suggestion; BR-3's bare `null`; three asset-hub cases), while the regression pin (an unregistered tag still listed by its `asset_tags` containment on the hub) passes on both.

`applyForDocument` (`lib/equipmentBridgeServer.ts`, `syncDrawingRelations`) writes one `document_assets` row per applied tag that resolves to a registry asset. The row carries `source 'drawing'`, the sheet address (`sheet_label`) and `pages`; with 20261171 it also carries `asserted_by 'machine'`, the transcribing `model`, and `source_revision` / `source_version_id`. The metadata column write is kept, because the library's chips render from it. A pair a person already linked (`manual` or `jsonb_sync`) is left as it is: a human assertion stands. Nothing is routed through `documents.asset_tags` (GAP-302's do-not). Every recompute refreshes the relation of every applied tag still read on the current revision, which also backfills tags applied before the relation existed (GAP-304). The asset hub reads the relation (WIRE-1).

**Done-when.**
1. ✓ The second branch: `document_assets` rows are written directly with the distinct source `'drawing'`. They are not in one transaction with the metadata write, because PostgREST has none. Each write is checked. A refused relation is said ("The document↔equipment relation was not recorded: the database does not have migration 20261170 yet."), and the column write still lands (today's behaviour).
2. ✓ `/assets/[tag]` lists every drawing the relation links, with its sheet (`lib/__tests__/assetHubRelation.test.ts`).
3. ✓ By construction. Step 4 of `components/assets/AreaKnowledgePanel.tsx` is `docLinkCount > 0` over `document_assets` for the unit's assets (read, not edited), so it counts the rows a sweep's apply writes. Not rendered in a test here; the panel's own end-to-end step is AREA-4's residual.
4. ✓ `lib/__tests__/equipmentBridge.test.ts` "reproduction → fix: after apply a document_assets row exists for (document, asset), source 'drawing', with the sheet and provenance", and "re-running the sweep and the apply is idempotent".

**Scope / residual.** **Pending migrations:** `supabase/migrations/20261170_intel_roundG_document_assets_source.sql`, then `supabase/migrations/20261171_intel_roundG_provenance.sql` (hand-applied, in that order). The app deploys in either order: before 20261170 the Bridge says the relation was not recorded and keeps its column write; before 20261171 it writes the relation without the provenance columns and says so. The relation is written for tags that resolve to an asset. A discovered asset is created first, then related. A held tag (BR-13) is neither.

**Fix pass 3 (2026-10-02, review).** The residual's clause "before 20261171 it writes the relation without the provenance columns and says so" has been false since fix pass 2. Before 20261171 the Bridge writes NO 'drawing' row: `notRecorded` names 20261171, the column write still lands, and the first recompute after the paste relates the applied tags with their provenance (`GAP-304`'s fix pass 2).

The compute's relation refresh (the GAP-304 backfill of tags applied before the relation existed) used to discard its outcome. A refused or unrecorded refresh during a sweep went unsaid. `computeForDocument` now returns it as `ComputeResult.relations`, merged with its automatic apply's outcome. The sweep sums it into `outcomes` (`relationsWritten`, `relationsRefreshed`, `relationsKeptHuman`, `relationsNotRecorded` and the first `relationNote`), and the sweep modal's progress line shows the links recorded and the documents whose links were not recorded, with the reason. Tests:
- `lib/__tests__/equipmentBridge.test.ts` "GAP-304: the compute returns its relation refresh's outcome — …";
- `lib/__tests__/equipmentBridgeRoutes.test.ts` "a relation refresh that records nothing is counted with its reason";
- `lib/__tests__/equipmentSweepModalRender.test.ts` "column dismissals, recorded links, an unrecorded relation and refused audit rows are shown, summed over the pages".

Each fails on the fix-pass-2 files.

**Scope / residual (corrected).** Pending migrations: `20261170`, then `20261171`, in that order. The app deploys in either order. Before either is pasted, the Bridge writes no 'drawing' row, says the relation was not recorded (naming the file it needs), and keeps its column write. At ingest, the outcome is returned to a fire-and-forget caller (`lib/knowledgeIngest.ts` `onDocumentReady`, I-18's file) that reads nothing; the next sweep of the library reports it.

---

<a id="br-3"></a>

## BR-3 · source_document_id gate silently voids the Bridge for every upload-origin knowledge document, with no UI signal

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:55-59`, `lib/knowledge.ts:363-367`, `lib/knowledgeSourceSync.ts:235`, `app/api/equipment-bridge/route.ts:107-126`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is exactly as described and there is no compensating path. Severity lowered because the scenario's premise is wrong: the Area wizard does NOT train uploading — AreaKnowledgePanel.tsx:169/476 and UnitOpsPanels.tsx:342 all call `addKnowledgeSources(...)` (DC folder/document links), which go through knowledgeSourceSync and DO get source_document_id. The voided path is only a direct drag-drop into a knowledge library (app/(protected)/knowledge/[id]/page.tsx:1525 `addKnowledgeDocument`), and that screen never promises the registry (no 'registry'/'asset' string in the whole file). The column half of the bridge is also genuinely impossible there — only the registry-discovery half is lost.

**Mechanism.** `computeForKnowledgeDoc` returns null at line 59 — `if (!kdoc?.source_document_id) return null; // upload-origin docs have no column to feed`. `addKnowledgeDocument` (lib/knowledge.ts:363-367) inserts a knowledge_documents row with org_id/library_id/name/file_key/file_size/created_by and no source_document_id, so every PDF uploaded straight into a knowledge library is permanently outside the Bridge. Only knowledgeSourceSync.ts:235 sets `source_document_id: dcDocId`. The backlog sweep cannot rescue them either: /api/equipment-bridge action="sweep" enumerates doc-control `documents` for a library and then their twins via `.in("source_document_id", ids...)` (route.ts:112-120), so an upload-origin knowledge doc is never enumerated. The knowledge ingest path still extracts its equipment entities (knowledgeIngest.ts:247-253) and the census route still counts them — the data exists, it just never crosses.

**Failure scenario.** An engineer drags the crude-unit P&ID set into the Operating Area's knowledge shelf (which is what the Area wizard trains them to do) instead of into Document Control. Ingest succeeds, the equipment census shows 340 tags, the drawing register CSV exports fine — and the equipment registry gains nothing, no suggestion row is written, and the Equipment sweep modal for the doc-control library reports the documents as not linked. The failure is completely silent: computeForKnowledgeDoc returns null before writing even the empty 'checked, nothing' row it writes at line 81 for the no-entities case.

**Evidence.**

```
lib/equipmentBridgeServer.ts:59 — `if (!kdoc?.source_document_id) return null; // upload-origin docs have no column to feed`. lib/knowledge.ts:363-367 — insert with `{ org_id, library_id, name, file_key, file_size, created_by, created_by_name }`, no source_document_id. app/api/equipment-bridge/route.ts:118-120 — `.from("knowledge_documents").select("id").in("source_document_id", ids.slice(i, i + 100))`.
```

> **Verifier correction.** Sharpen the framing: for an upload-origin knowledge doc there is no controlled document at all, so 'populate the equipment column' is not merely skipped but undefined. The capability actually lost is asset DISCOVERY (and the unit/type filing that rides on it), not the column write. 'No UI signal' is accurate as far as the code shows — the sweep modal's only counter is `linkedCount`, derived from twins that have a source_document_id (route.ts:76-77) — but nobody ran the app, so treat the user-facing invisibility as inference from the render path rather than observation.

**Done when.**

- [ ] an upload-origin knowledge document with equipment entities either feeds the registry (discovery only, no column populate) or tells the user in the knowledge library UI why it cannot
- [ ] the sweep can enumerate upload-origin knowledge documents in a library and report them as 'entities extracted, no controlled document to feed'
- [ ] the null return at line 59 is distinguishable in the UI from 'swept, nothing found'

**Resolution (2026-10-02, intelligence Round G).** `computeForKnowledgeDoc` no longer returns a bare `null` for an upload-origin knowledge document. It answers `reason: "upload_origin"` with the knowledge document's id. That is distinct from `no_entities` ("swept, nothing found"), `no_twin`, `twin_not_ready`, `twin_stale` and `not_found`, and the sweep's counts carry each reason.

The sweep modal says how many indexed documents were uploaded straight into a knowledge library ("there is no controlled document for the Bridge to feed"), and points to the coverage report (GAP-308). Its "On a sheet, in no list" bucket lists their tags with door `knowledge`. There a writer picks tags, and Discover creates them as registry assets (`discoverFromKnowledge`, `POST action "discover"`):
- discovery only, with no column (there is no controlled document);
- unit-less, because there is no decodable number (reported);
- provenance `discovered_from: { knowledgeDocumentId, pages, door: "knowledge" }`;
- audited as `EQUIPMENT_BRIDGE_DISCOVERED`.

A copy of a controlled document is refused there. Its tags go through the sweep, which records the relation.

**Done-when.**
1. ✓ An upload-origin knowledge document with equipment entities feeds the registry through the knowledge door: discovery only, no column populate, on a person's pick. Never automatically (no confidence auto-accept).
2. ✓ The sweep reports them, and the coverage report lists them with their tags. The count is org-wide, because an upload belongs to a knowledge library, not to the doc-control library being swept.
3. ✓ `reason: "upload_origin"` is distinguishable from `no_entities`. Tests in `lib/__tests__/equipmentBridge.test.ts`: "BR-3: an upload-origin knowledge document is said, distinguishable from 'swept, nothing found'" and, under GAP-307, "named tags on the document become discovered assets with door 'knowledge' provenance".

**Scope / residual.** The knowledge library page (`app/(protected)/knowledge/**`, not this package's file) still says nothing about the registry; the signal lives in the sweep and the coverage report. Knowledge uploads are org-readable by design (DEC-83 item 1), so the coverage report lists them to any writer.

---

<a id="br-4"></a>

## BR-4 · A master equipment list can never be filed to an operating area by the codebook alone — CSV import cannot set unit_code or code, and unit filing keys off code

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/assets/AssetCsvImportModal.tsx:22-27`, `components/assets/AssetCsvImportModal.tsx:124-133`, `lib/assets.ts:172-204`, `lib/assetCategorize.ts:48-56`, `components/assets/UnitOpsPanels.tsx:46-56`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: a CSV-imported asset has code NULL, so `!a.unit_code && a.code` is false for every row and plan.unitAssignments is empty — applyCategorization's `filedToUnits` (assetCategorize.ts:117-123) counts 0 while `categorized` counts the type assignments. No other automatic code-setter exists: the only tagToCode callers are admin/assets/page.tsx:1018 (UnassignedAssignPanel, human-driven), :1313 (the edit drawer, human-driven) and equipmentBridgeServer.ts:117.

**Mechanism.** AssetCsvImportModal's CANONICAL_FIELDS are exactly tag/description/location/type (lines 22-27) and commit() calls `createAsset({ orgId, tag, description, location, typeId, createdBy: actorUserId })` (lines 130-133). `createAsset` accepts `unitCode` and `code` (lib/assets.ts:179-180) and the modal passes neither, so every imported row gets unit_code NULL and code NULL. The codebook's unit filing then cannot fire: planCategorization gates on `if (!a.unit_code && a.code) { const decoded = codeToTag(a.code, book); ... }` (assetCategorize.ts:51-56) — it derives the unit from the site CODE, and derives nothing from the tag. Type assignment via typeForTag works (line 58) because that reads the tag prefix. So the codebook categorizes the master list correctly and files none of it.

**Failure scenario.** A refinery imports 2,400 rows of master equipment list. CategorizeBanner (UnitOpsPanels.tsx:36) offers 'Auto-categorize from codebook', runs, and reports '2,180 categorized' with `filedToUnits: 0` because plan.unitAssignments is empty. Every unit hub shows zero equipment; the whole registry sits under Unassigned. The only path forward is UnassignedAssignPanel at 50 rows a screen (admin/assets/page.tsx:1027), whose drawing-derived pre-select is also empty (see finding 1). This is precisely the 'sophisticated version' the owner describes, and it stalls at step one.

**Evidence.**

```
AssetCsvImportModal.tsx:130-133 — `await createAsset({ orgId, tag, description, location, typeId, createdBy: actorUserId });`. lib/assetCategorize.ts:51 — `if (!a.unit_code && a.code) {`. lib/assets.ts:179-180 — createAsset's signature does accept `unitCode?: string; code?: string;`.
```

> **Verifier correction.** Downgraded HIGH→MEDIUM because there is a real, always-visible remedy the finding does not mention: `UnassignedAssignPanel` (app/(protected)/admin/assets/page.tsx:966-1090) renders for every unit-less asset with a per-asset unit dropdown and a bulk 'Assign all N selected' button, and its assign() at lines 1011-1019 writes `code: r.asset.code ?? tagToCode(r.asset.tag, r.unitCode, book)` — so filing the master list is a bulk UI action, not per-asset drudgery. Its pre-selection heuristic does read document_assets (lines 975-983), which finding 1 shows the Bridge never populates, so the pre-selection is dead for bridged drawings; the manual dropdown still works. The accurate statement is 'the codebook cannot file a CSV-imported list automatically', not 'the list cannot be filed'.

**Done when.**

- [ ] the CSV importer maps unit / unit_code / site code columns and passes them through to createAsset
- [ ] planCategorization can derive a unit from tag + an explicitly supplied unit column, and can derive `code` via tagToCode once a unit is known
- [ ] importing a master list with a Unit column results in filedToUnits > 0 on the first auto-categorize
- [ ] the importer preview shows which rows will land in which operating area before commit

**Resolution (2026-09-30, intelligence Round G).** The master-list door files what it imports. `components/assets/AssetCsvImportModal.tsx` maps an operating-unit column (a codebook unit by code or by name) and a site-code column; the pure planner `lib/assetCategorize.ts` `planAssetImport` resolves each row before anything is written — the unit from the unit column, or read from the site code when only the code is given (`codeToTag`), and the code derived once the unit is known (`tagToCode`) — and the preview shows, per row, the action, the operating area it lands in and the site code, with notes (unknown unit left unassigned, never guessed; a code naming a different unit than the unit column flagged). Rows are created with `unit_code` and `code` set. `planCategorization` also fills a blank code for an asset already filed to a unit (`codeAssignments`, fill-blank only). Spreadsheets come in through `POST /api/assets/parse-workbook` (the hardened `lib/xlsxData.ts` parseWorkbook, writer tier by collection). Tests: `lib/__tests__/assetCategorize.test.ts` ("BR-4 / AREA-7 / BR-6"), `lib/__tests__/assetWorkbookRoute.test.ts`.

**Done-when.**
1. ✓ The importer maps unit / site-code columns and passes them to createAsset.
2. ✓ A unit is derived from an explicit unit column (or the code), and `code` via tagToCode once the unit is known — in the importer and, for already-filed assets, in planCategorization. *Review fix:* the categorize banner (`components/assets/UnitOpsPanels.tsx`, I-09's file) hides when blank codes are the only thing left, and never reports `codesDerived`, so the fill never ran by itself. The Operating Areas page now runs it on its own: "N pieces of filed equipment without a site code → Fill site codes from codebook", with the result counted (filled, already carried, failed). The plan is computed against every identity, archived included (`planCategorization(assets, types, book, codeHolders)`), so a code an archived asset holds is never proposed. A code taken at apply counts as `codesTaken`, listed under the identity review, and never as a failure (tests: `lib/__tests__/intelRoundGRegistry.test.ts` "filling blank codes never proposes a taken code", `lib/__tests__/assetCategorize.test.ts`).
3. ✓ A master list with a Unit column lands filed on import, with no auto-categorize step: the planner test files 3,000 of 3,000. A list imported with site codes only is filed at import from the code. After the review fix, a row whose derived or given code another asset (or an earlier row) already carries still lands filed. The code is dropped with a note in the preview, the commit writes with the code optional in case a collision appears after the preview, and the result lists the rows that landed without a code (see `CB-10`).
4. ✓ The preview shows which operating area each row lands in. After the review fix, row numbers are the sheet's own. `lib/xlsxData.ts` `parseWorkbook` reports each data row's real sheet row, counting the title block and skipped blank rows, and `/api/assets/parse-workbook` returns it as `rowNumbers`. "Row 10" in the preview or the failure list is therefore row 10 of the spreadsheet (route test with a title block and blank rows).

**Scope / residual.** None beyond applying 20261128.

---

<a id="br-5"></a>

## BR-5 · Auto-apply resurrects tags a human deleted — the module's stated idempotency invariant is not implemented in apply

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:15-18`, `lib/equipmentBridgeServer.ts:126-134`, `lib/equipmentBridgeServer.ts:180-183`, `lib/equipmentBridgeServer.ts:261-276`, `lib/knowledgeIngest.ts:448-456`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The trigger is real and automatic: lib/knowledgeIngest.ts:452-454 `void import("@/lib/equipmentBridgeServer").then((m) => m.computeForKnowledgeDoc(supabaseAdmin, doc.id))` fires on every completed (re-)index, and computeForKnowledgeDoc:128-131 then calls `applyForDocument(admin, { orgId, documentId, userId: null })` with no `tags`, so `wanted` is the full suggestion set. upsertSuggestions:145-152 preserves `applied` but that only affects the status label, not what apply re-writes.

**Mechanism.** applyForDocument reads `alreadyApplied` at line 180 but never filters by it: `const wanted = suggested.filter((s) => (!input.tags || input.tags.includes(s.tag)));` (lines 181-182) — alreadyApplied is used only to compute the union written back at line 279. The column populate then re-adds any suggested tag not currently present in the column: `const additions = wanted.map((s) => s.tag).filter((t) => !existingNorms.has(assetNorm(t)))` (line 269). Combined with computeForKnowledgeDoc's auto-apply branch (`if (bridge?.autoApply && bridge.targetColumnKey) { await applyForDocument(...) }`, lines 128-133), which is fired on every ingest completion by knowledgeIngest.ts:453-455 including re-index and rebuild, a human's deletion of a wrong tag is undone on the next index.

**Failure scenario.** AI extraction mints CL-150 from a flange-class note on a P&ID. A document controller deletes the CL-150 chip from the sheet's Equipment column. The document is later re-indexed (rebuild, a vision-budget resume, or a source re-sync). computeForKnowledgeDoc recomputes, upsertSuggestions preserves `applied` (which still contains CL-150) and stamps status 'applied', then auto-apply runs with no tag filter and writes CL-150 straight back into the column. The controller has no way to make the deletion stick short of turning auto-apply off for the whole library. The module header at lines 15-18 asserts 'Idempotent — recompute diffs against what was already applied' and 'Additive only — the bridge never deletes a tag a human typed'; the first half is false for apply, and the second is technically true only because it re-adds rather than deletes.

**Evidence.**

```
lib/equipmentBridgeServer.ts:181-182 — `const wanted = suggested.filter((s) => (!input.tags || input.tags.includes(s.tag)));` — note the absence of any `!alreadyApplied.has(s.tag)` term. lib/equipmentBridgeServer.ts:16-17 — `//   * Idempotent — recompute diffs against what was already applied; re-index //     never duplicates chips or re-creates assets.`
```

> **Verifier correction.** Downgraded HIGH→MEDIUM because the resurrection path requires explicit opt-in. libraries.equipment_bridge starts NULL, the settings route stores `autoApply: body.autoApply === true` (route.ts:97), and the modal checkbox renders `checked={bridge.autoApply === true}` (EquipmentSweepModal.tsx:178) — off by default. The manual path cannot trigger it: the modal only offers Apply for rows where `fresh.length > 0` (line 227), and after a full apply `applied` covers every suggested tag, so the deleted-chip row is not pending and has no button. So the defect fires only on libraries that turned auto-apply on, and only on re-index.

**Done when.**

- [ ] applyForDocument skips tags already in `applied` unless the caller explicitly re-requests them
- [ ] a tag removed by a human from the target column is never re-added by a later auto-apply
- [ ] the `applied` list records removals (or a `rejected` list exists) so the diff base survives re-index
- [ ] a test re-runs applyForDocument after simulating a manual column deletion and asserts the tag stays gone

**Resolution (2026-10-02, intelligence Round G).** Reproduced by the test below: on the base file the re-index's auto-apply wrote the removed chip back. `applyForDocument` now skips every tag already in `applied` and every dismissed or held tag, unless the caller names it (`tags`). An automatic apply therefore never re-writes a tag a person has already seen. A tag a person removed from the mapped column stays removed. The diff base survives re-index: `applied` is preserved by every recompute, and a person's rejections are kept in their own list (`document_equipment_suggestions.dismissed`, 20261171; BR-9). A dismissal lapses only when a LATER revision brings the tag back, and it is then re-proposed, never re-applied silently (DEC-44 (I-11) item 4).

**Done-when.**
1. ✓ `applyForDocument` skips tags already in `applied` unless the caller explicitly re-requests them by name.
2. ✓ A tag removed by a person from the target column is never re-added by a later auto-apply — to the column, and (fix pass) to the relation: the first resolution held this for the display column only, while every recompute refreshed (and the GAP-304 backfill created) a 'drawing' row for the removed tag.
3. ✓ A `dismissed` list exists (who, when, the revision, absent-since) and `applied` is preserved across recomputes, so the diff base survives re-index. **Fix pass:** a person taking an applied tag out of the column the Bridge wrote it into is now recorded as a dismissal (`via: 'column'`, `by: null` — who removed the chip is not known; audited `EQUIPMENT_BRIDGE_DISMISSED` with `via: 'column'`), and its 'drawing' relation is removed (audited `EQUIPMENT_BRIDGE_RELATION_REMOVED`, `via: 'column'`). The re-map worry the first resolution named is answered by recording the column: `applyForDocument` stores `appliedColumn` on each applied suggestion and every recompute carries it (`planColumnRemovals`); a tag applied before that was recorded counts only against the library's mapped column and only when the document holds that column at all; a tag applied with no column mapped is never column-dismissed.
4. ✓ `lib/__tests__/equipmentBridge.test.ts` "reproduction → fix: apply, delete CL chip by hand, re-index with auto-apply on — the column keeps the deletion" — now also asserting no `document_assets` row for P-7 after the recompute, the column dismissal, both audit rows, and that a person naming it again restores column and relation; plus "GAP-304 backfill: a tag applied before the relation existed (no column recorded) and since removed from the column is never related", "a column the document never held is a re-mapping, not a removal; …" and "with no column mapped, a later mapping does not dismiss what was applied before it".

**Scope / residual.** Before 20261171 the ledger has no `dismissed` column. Dismiss still removes the relation and audits the decision, and says that the ledger cannot remember it across a recompute ("before 20261171 the ledger cannot remember it across a recompute — said, not silently dropped"); a column dismissal is likewise not remembered then, but the column check re-finds it on every recompute. A person putting a column-dismissed chip back by hand does not lift the dismissal; naming the tag in the sweep does.

**Fix pass 2 (2026-10-02, review).** Done-when 3's fix-pass claim ("without a re-map reading as mass removals") was overstated, and so was DEC-44 (I-11) item 4. Three shapes still turned a re-map or a missed reading into column dismissals (`by: null`, relation removed, never re-applied):
- (a) Tags applied before this deploy carry no recorded column. Once the library re-mapped onto a column the document holds (one apply, or a person typing a value), every historical tag counted against the new column.
- (b) The recorded column lived only on the suggestion, which every recompute rebuilds from the tags read now. A tag missing from one reading lost it and fell back to (a).
- (c) With the column recorded, a document whose metadata no longer held that key read every applied tag as removed (the fix-pass-1 table accepted this shape).

Now:
- The applied column is kept per tag in the ledger's own map, `document_equipment_suggestions.applied_columns` (added to `20261171`; `{}` default; probed; re-run on scratch PostgreSQL 16). Every apply writes it and every recompute carries it, whether or not the tag is read. The suggestion's `appliedColumn` stays as the fallback (before 20261171, and rows written before the map existed).
- `planColumnRemovals` returns `{ removed, columns }`. A tag counts as removed only when it is absent from EVERY tag column the document holds: the library's tag-type columns (`loadBridgeConfig` now also reads `custom_columns`: type tags / multi, or pill), the mapped column, the recorded columns, and any array-valued metadata key. It never counts when the recorded column's key is gone from the document.
- A historical tag (no record) is stamped with the column it is found in, the mapped one first. Found nowhere while the document holds a tag column, it was removed, so the GAP-304 backfill protection holds. On a document holding no tag column, it is left as it is.
- A tag a person moved into another tag column is not a removal; its record follows it.
- Tests in `lib/__tests__/equipmentBridge.test.ts`: "a tag is removed only when it is in NO tag column the document holds — never on a re-map, a dropped key, or a move to another column (fix pass 2)", "(a) tags applied before the column was recorded, the library re-mapped onto a column the document now holds: …", "(b) a tag missing from one reading keeps its recorded column — …", "(c) the recorded column's key gone from the document is not a removal". Each fails on the fix-pass-1 library. The regression guard "a person's real removal still is one: out of every tag column, with the key still there" passes on both.

Done-when 3 (restated): ✓ the dismissed list and the preserved `applied`; ✓ a column removal becomes a dismissal; ✓ (fix pass 2) a re-map onto a column the document holds, a dropped column key, a move to another tag column and a tag missing from one reading never read as removals. Residual: a historical tag on a document whose only tag column a person deleted outright (the key gone, not emptied) is not dismissed, because nothing says where it was. The backfill relates it, and a person removes it with Dismiss.

**Fix pass 3 (2026-10-02, review).** A column removal could fail half-way and leave its 'drawing' rows standing for good.
- **Order.** `computeForDocument` saved the 'column' dismissals (`upsertSuggestions`) BEFORE it removed the relations. A removal that threw left the tags dismissed, so the next compute's `planColumnRemovals` skipped them and never retried. Their 'drawing' rows stayed on the hub, the graph and the impact scan, against the recorded decision. The relations are now removed FIRST. A removal that fails throws before anything is saved, and the next compute plans the same removal again. The `EQUIPMENT_BRIDGE_DISMISSED` audit is written after the ledger lands.
- **Batches.** `removeDrawingRelations` read the pairs' assets (`.in("id", assetIds)`) and deleted the rows (`.delete().in("id", …)`) in one request each. A person clearing a column of more than about 200 tags overflowed the request line. Both now run in batches of 100.
- **Counted.** Column dismissals are counted in the sweep's results (`outcomes.columnDismissed`) and shown on its progress line ("N applied tags were no longer in any tag column — dismissed …"). DEC-44 (I-11)'s Risk said they were, and nothing had counted them.

Tests:
- `lib/__tests__/equipmentBridge.test.ts` "BR-5: a column removal whose relation delete fails saves nothing — the next compute plans it again and removes the link …";
- `lib/__tests__/equipmentBridge.test.ts` "a person clearing a large tag column (250 tags) removes every link, in batches under the URL limit";
- `lib/__tests__/equipmentBridgeRoutes.test.ts` "DEC-44 (I-11) Risk: a first sweep's column dismissals and the relation backfill are counted in the sweep's results".

Each fails on the fix-pass-2 files. The in-memory stand-in gained `maxInList` (an `.in()` past it fails as the gateway does) and `selectErrors`.

---

<a id="br-6"></a>

## BR-6 · CSV import cannot update existing assets — a re-import of a corrected master list produces one raw Postgres error per row and changes nothing

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/assets/AssetCsvImportModal.tsx:109-143`, `lib/assets.ts:196-203`, `supabase/migrations/20260603_asset_registry.sql:46`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed down to the '+N more' detail in the summary. Notably the codebase already has `translatePostgresError` (used at admin/assets/page.tsx:1391 and :1406) and this modal does not use it, so the raw constraint name reaches the user.

**Mechanism.** commit() calls `createAsset` per row inside a try/catch that pushes `{ row, reason: (e as Error).message }` on failure (AssetCsvImportModal.tsx:130-137). createAsset does a plain `.insert(...)` (lib/assets.ts:196-201) against a table with `UNIQUE (org_id, tag_normalized)` (20260603_asset_registry.sql:46), so an existing tag raises 23505 and the modal surfaces the raw driver message. There is no upsert, no 'update existing' option, no pre-flight duplicate count, and the mapping step (goPreview, lines 101-107) validates only that the required `tag` field is mapped.

**Failure scenario.** An operator imports 2,400 assets, notices the descriptions were mapped to the wrong column, fixes the CSV and re-imports. The result panel reports '0 created, 2400 failed', listing eight rows with 'duplicate key value violates unique constraint "assets_org_id_tag_normalized_key"' and '+2392 more'. Nothing was updated. The only recovery is deleting 2,400 assets one drawer at a time (see finding 4) or editing them by hand. Compare createAsset's own resilience design — it retries without codebook columns on a pre-migration DB (lines 199-201) — the duplicate case got no such care.

**Evidence.**

```
components/assets/AssetCsvImportModal.tsx:130-137 — `await createAsset({ orgId, tag, description, location, typeId, createdBy: actorUserId }); ok += 1; } catch (e) { failed.push({ row: rIdx + 2, reason: (e as Error).message }); }`. supabase/migrations/20260603_asset_registry.sql:46 — `UNIQUE (org_id, tag_normalized)`.
```

> **Verifier correction.** 'Changes nothing' is overstated: rows whose tags are new still insert successfully and are counted in `ok` (line 134) — only pre-existing tags fail. The accurate statement is that a re-import is insert-only, so corrections to existing rows are silently impossible and the user gets N raw 23505 messages capped at 8 displayed (line 242) plus '+N more'.

**Done when.**

- [ ] the preview step reports how many rows already exist and offers create-only / create-and-update
- [ ] matched rows update the mapped fields instead of erroring
- [ ] duplicate-key failures are translated to plain language (translatePostgresError already exists and is used at admin/assets/page.tsx:1391)

**Resolution (2026-09-30, intelligence Round G).** Before anything is written, the importer looks up every tag in the file by the one grammar (`lib/assets.ts` `findAssetsByTagKeys`, chunked, archived rows included) and the preview says how many rows already exist, offering "Skip them (create new only)" or "Update them from this file". Update writes only the cells the file supplies (and never overwrites an existing code with a derived one — that is the identity review's job, AREA-11 / CB-6); a tag repeated inside the file is refused with the row it duplicates; every failure is translated (`translatePostgresError`, plus the site-code collision message) — no raw constraint names. The result reports created / updated / skipped / filed. Tests: `lib/__tests__/assetCategorize.test.ts`, `lib/__tests__/intelRoundGRegistry.test.ts`.

**Done-when.**
1. ✓ The preview reports how many rows already exist and offers create-only / create-and-update.
2. ✓ Matched rows update the mapped fields.
3. ✓ Failures are translated to plain language.

**Scope / residual.** None.

---

<a id="br-7"></a>

## BR-7 · Code backfill is gated on unit_code being NULL, so an asset that has a unit but no site code never gets one

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:240-258`, `lib/assetCategorize.ts:48-56`, `app/(protected)/admin/assets/page.tsx:1016-1019`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The gate is exactly as described, but two of the finding's supporting claims are false. (1) The cited 'admin drawer that set only the unit' does NOT exist: app/(protected)/admin/assets/page.tsx:1311-1315 `useEffect(() => { if (asset?.code) return; const derived = unitCode ? tagToCode(tag, unitCode, book) : null; setSiteCode(derived ?? ""); }, ...)` auto-derives the code whenever a unit is set. (2) 'keeps code NULL forever' is refuted by that same drawer, which is a working per-asset remedy. lib/assetCategorize.ts:117-121 only sets unit_code, but its precondition (`!a.unit_code && a.code`) guarantees code is already present. The realistic residual path is narrow — a bridge-discovered asset whose tagToCode returned null because the codebook lacked the prefix at discovery time.

**Mechanism.** The backfill block builds `blank` from a query that already filters to unit-less rows — `.select("id, code").in("id", ids).is("unit_code", null)` (line 245) — then skips any asset not in that map (`if (!blank.has(id)) continue;`, line 250). The `code` patch is therefore reachable only for rows whose unit_code is also NULL: `if (!blank.get(id) && s.code) patch.code = s.code;` (line 252). An asset that a human filed to a unit but that has no site code is permanently excluded, even though the Bridge computed its code at line 117.

**Failure scenario.** A controller uses UnassignedAssignPanel to file E-22 into unit 20 (which sets code via tagToCode at admin/assets/page.tsx:1018 — so this path is fine), but an asset filed by an older route, by data restore, or by an admin drawer that set only the unit, keeps code NULL forever. Every downstream consumer that reads `code` — most importantly planCategorization's unit filing at assetCategorize.ts:51, and any code-first search — treats it as unfiled. The asset is half-identified and the one process that could complete it declines to.

**Evidence.**

```
lib/equipmentBridgeServer.ts:245-253 — `const { data: blankRows } = await admin.from("assets").select("id, code").in("id", ids).is("unit_code", null); ... if (!blank.has(id)) continue; const patch: Record<string, unknown> = { unit_code: s.unitCode }; if (!blank.get(id) && s.code) patch.code = s.code;`
```

> **Verifier correction.** Two mitigations bound the impact. (1) The asset drawer auto-derives the missing site code on open: app/(protected)/admin/assets/page.tsx:1309-1314 — `if (asset?.code) return; const derived = unitCode ? tagToCode(tag, unitCode, book) : null; setSiteCode(derived ?? "")` — so a per-asset edit fills it, and save persists at line 1384. (2) UnassignedAssignPanel's assign() writes `code: r.asset.code ?? tagToCode(...)` (line 1017) when filing. Neither is a bulk sweep for the already-filed-but-codeless population, so the gap is real but narrow; MEDIUM is the ceiling.

**Done when.**

- [ ] assets with a unit but a null code receive the derived code on apply
- [ ] the two backfills (unit_code and code) are independent conditions, each guarded by its own IS NULL
- [ ] a test covers the unit-set-code-null asset

**Resolution (2026-10-02, intelligence Round G).** The two backfills on apply are independent. For a matched asset with no unit, the unit is filed, with the code when the asset has none; that UPDATE is guarded by `unit_code IS NULL`. For a matched asset that has a unit but no code, the code alone is filled; that UPDATE is guarded by `code IS NULL`. The code is derived through the codebook (`tagToCode`) from the tag and the unit the asset ends up filed to: its own unit when it has one, otherwise the document's held unit. It is never read back from the stored proposal (CB-2). A person's filing is never changed.

**Done-when.**
1. ✓ An asset with a unit but a NULL code receives the code its own filing derives.
2. ✓ The unit and code backfills are independent conditions, each guarded by its own IS NULL.
3. ✓ `lib/__tests__/equipmentBridge.test.ts` "BR-7: an asset with a unit but no code gets the code its own filing derives; filing a unit-less asset fills both".

**Scope / residual.** None.

---

<a id="br-8"></a>

## BR-8 · Discovered assets are invisible as discovered: origin and discovered_from have no readers anywhere, and cleanup is one asset at a time

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** intelligence I-11 THE BRIDGE & THE MEMORY — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:200-233`, `lib/assets.ts:43-47`, `app/(protected)/admin/assets/page.tsx:1397-1411`, `app/(protected)/admin/assets/page.tsx:115`, `components/documents/EquipmentSweepModal.tsx:262-264`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by exhaustive search — the provenance is written and never surfaced or filtered on, and app/(protected)/admin/assets/page.tsx:115 loads with `listAssets({ orgId: activeOrgId, archived: false })` with no origin facet.

**Mechanism.** Discovery inserts `origin: "drawing"` and `discovered_from: { documentId, pages: s.pages }` (equipmentBridgeServer.ts:213-214), with `createAssets` defaulting ON (`if (bridge?.createAssets !== false)`, line 200). Three differently-shaped searches — bare `discovered_from` across ts/tsx, camelCase `discoveredFrom`, and `\.origin\b` across app/ and components/ — return only the declaration in lib/assets.ts:43-47 and the writes in equipmentBridgeServer.ts. No list, filter, badge, or drawer in the registry reads either column; `listAssets` (lib/assets.ts:117-135) has no origin parameter and the admin registry page calls it as `listAssets({ orgId, archived: false })` (admin/assets/page.tsx:115). The only removal affordance is the single-asset drawer delete at admin/assets/page.tsx:1397-1411. The auto-apply path also stamps `created_by: "00000000-0000-0000-0000-000000000000"` (line 215), so even the creator column is useless for triage.

**Failure scenario.** Auto-apply is switched on for a P&ID library. Overnight the drain indexes 200 sheets and mints 600 assets, of which 80 are junk (line specs, flange classes, note numbers). The next morning the registry shows 600 new rows indistinguishable from the hand-curated ones — the sweep modal's promise that provenance is 'recorded' (EquipmentSweepModal.tsx:263) is true in the database and invisible in the product. Cleaning up means opening 80 drawers and confirming 80 destructive dialogs, and there is no query to find them. In a PSM/OSHA registry that is a permanent data-integrity injury: nobody can later say which rows a human vouched for.

**Evidence.**

```
lib/equipmentBridgeServer.ts:213-215 — `origin: "drawing", discovered_from: { documentId, pages: s.pages }, created_by: input.userId ?? "00000000-0000-0000-0000-000000000000",`. Searches run: `grep -rn "discovered_from" --include=*.ts --include=*.tsx .` → 5 hits, all in lib/assets.ts and lib/equipmentBridgeServer.ts; `grep -rni "discoveredFrom"` → 0 hits; `grep -rn "\.origin\b" app components` → only codebook entries, document origin, alias origin, related-link origin.
```

> **Verifier correction.** Downgraded HIGH→MEDIUM: this is a provenance/triage gap, not a correctness or safety defect — the data IS written (assets.origin, assets.discovered_from, plus an EQUIPMENT_BRIDGE_APPLIED audit_logs row at lines 287-294), so the module's 'everything audited' invariant holds at the storage layer; only the surfacing is missing. It matters mainly in combination with finding 13 (no vocabulary gate) and createAssets defaulting ON.

**Done when.**

- [ ] the registry can filter to origin='drawing' and shows a visible 'discovered' badge with its source drawing and pages
- [ ] discovered assets can be confirmed (promoted to origin='manual') or rejected in bulk from one screen
- [ ] the auto-apply path records a real service identity rather than the nil UUID, or leaves created_by resolvable
- [ ] EquipmentSweepModal's 'provenance recorded' copy links to the surface that shows it

**Partial (2026-09-30, intelligence Round G).** The registry now reads the provenance it was already writing. On the Operating Areas page a "Discovered from drawings (N)" filter narrows to `origin = 'drawing'`; every discovered asset's card carries a "Discovered" badge; with the filter on, a review panel lists each discovered asset with its source drawing (resolved from `discovered_from.documentId`, linked to the document) and pages, and bulk-confirms the good rows (`origin` → 'manual'; `discovered_from` stays, so where it came from is still recorded) or archives the misreads (the writer tier's reversible removal — deleting is a controller act, 20261128), up to 100 at a time.

**Done-when.**
1. ✓ Filter to origin='drawing' and a visible badge with its source drawing and pages.
2. ✓ Bulk confirm (promote to origin='manual') or reject (archive) from one screen.
3. ✗ Not done here — the auto-apply identity (`created_by` nil UUID) is written by `lib/equipmentBridgeServer.ts`, I-11's file.
4. ✗ Not done here — EquipmentSweepModal's "provenance recorded" copy is `components/documents/EquipmentSweepModal.tsx`, I-11's file; the surface to link to is `/admin/assets` with the Discovered filter.

**Scope / residual.** Limbs 3 and 4 are handed to I-11.

**Resolution (2026-10-02, intelligence Round G).** The two limbs handed to I-11 by the 2026-09-30 partial:
- **An accountable creator.** A discovered asset's `created_by` is resolved in order, and the nil UUID is the last resort only when none is known (DEC-44 (I-11) item 8):
  1. the person who applied;
  2. on the automatic path, the person who turned auto-apply on (`libraries.equipment_bridge.autoApplyBy`, recorded by the settings action);
  3. otherwise the person who filed the drawing (`documents.created_by`).
  Every automatic apply also writes its `EQUIPMENT_BRIDGE_APPLIED` audit row.
- **The modal links to the surface.** EquipmentSweepModal's "provenance recorded" copy links to `/admin/assets?discovered=1`. The registry page reads `?discovered=1` and lands with its Discovered filter on.

**Done-when.**
1. ✓ (2026-09-30) Filter to origin='drawing' with a visible badge, its source drawing and pages.
2. ✓ (2026-09-30) Bulk confirm or reject from one screen.
3. ✓ The automatic path records a resolvable person. `lib/__tests__/equipmentBridge.test.ts` "BR-8: an automatic apply's discovered asset names the person who turned auto-apply on (else who filed the drawing) — never the nil UUID when known"; `lib/__tests__/equipmentBridgeRoutes.test.ts` "turning auto-apply on records the caller; the first review stays".
4. ✓ The modal's copy links to `/admin/assets?discovered=1` ("review discovered equipment"), which opens with the Discovered filter on.

**Scope / residual.** A library whose auto-apply was turned on before this deploy has no `autoApplyBy`. Its automatic discoveries name the drawing's filer until someone saves the library's settings again.

---

<a id="br-9"></a>

## BR-9 · Review is all-or-nothing per document: the server supports a tag subset and a 'dismissed' status, and the client sends neither

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/documents/EquipmentSweepModal.tsx:106-123`, `components/documents/EquipmentSweepModal.tsx:234-254`, `lib/equipmentBridgeServer.ts:170-172`, `lib/equipmentBridgeServer.ts:181-183`, `supabase/migrations/20260928_site_codebook.sql:103`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: no code anywhere writes status 'dismissed' to document_equipment_suggestions (grep for 'dismissed' hits only processFlows, linkProposals and unrelated UI state), and the chip renderer at :236-253 is a plain <span> with no click handler — there is no per-tag selection affordance at all.

**Mechanism.** applyForDocument accepts `tags?: string[]` documented as 'Restrict to a subset of suggested tags (review UI); omit = all' (equipmentBridgeServer.ts:170-172) and the API forwards `body.tags` (route.ts:131). The sweep modal never sends it: `body: JSON.stringify({ action: "apply", orgId, documentIds })` (EquipmentSweepModal.tsx:113). The chips it renders (lines 236-253) are non-interactive spans — no checkbox, no per-tag reject. Likewise `status TEXT ... CHECK (status IN ('pending','applied','dismissed'))` (20260928_site_codebook.sql:103) but a search for `"dismissed"` across ts/tsx returns hits only in lib/processFlows.ts and lib/linkProposals.ts — nothing ever writes it on document_equipment_suggestions. Compare processFlows.ts:78, which has a real accept/dismiss (`status: accept ? "confirmed" : "dismissed"`).

**Failure scenario.** A reviewer opens the sweep and sees a sheet with 38 good tags and 2 junk ones. The only choices are Apply 40 (creating two junk assets, then hand-deleting them from a registry that cannot filter for them) or apply none (losing 38 correct tags and the unit backfill they would have triggered). Because auto-apply is offered as a one-checkbox 'hand the whole loop to the machine' (EquipmentSweepModal.tsx:177-180), most sites will take the second, silent path — where nobody sees the junk at all. Every sibling proposal system in this codebase (process flows, link proposals) has accept/dismiss; the Bridge, which is the one that writes irreversibly into a PSM registry, does not.

**Evidence.**

```
components/documents/EquipmentSweepModal.tsx:113 — `body: JSON.stringify({ action: "apply", orgId, documentIds }),`. lib/equipmentBridgeServer.ts:171-172 — `/** Restrict to a subset of suggested tags (review UI); omit = all. */ tags?: string[];`. Searches run: `grep -rn '"dismissed"' --include=*.ts --include=*.tsx .` → processFlows.ts:12,40,78; linkProposals.ts:32,143; EquipmentSweepModal.tsx:27 (type only).
```

**Done when.**

- [ ] chips are selectable and Apply sends the selected tags
- [ ] a per-tag or per-document reject writes status='dismissed' and keeps the rejected tags out of future recomputes
- [ ] auto-apply can be scoped to high-confidence tags only, or is off by default until a library has been reviewed once

**Resolution (2026-10-02, intelligence Round G).** In the sweep modal, chips are selectable. Apply sends the selected tags (`tags`), and Dismiss sends a per-tag rejection (`POST action "dismiss"`, `dismissForDocument`). Selecting nothing and pressing Apply all applies every tag that is not applied, dismissed or held.

A dismissal is remembered on the ledger (`dismissed`: tag, who, when, the revision it was dismissed on; 20261171). It keeps the tag out of every later apply and recompute while the tag is still read. If the tag was applied, its 'drawing' relation is removed and the decision audited (`EQUIPMENT_BRIDGE_DISMISSED`, `EQUIPMENT_BRIDGE_RELATION_REMOVED`, with the sheet, pages and revision the machine reading carried). When every proposed tag is dismissed, the row's status is `'dismissed'`.

A dismissal lapses only when a LATER revision brings the tag back; the tag is then re-proposed. Read again on the revision it went missing on, it stays dismissed (an extraction miss is not a new revision), per DEC-44 (I-11) item 4.

Auto-apply stays off by default (opt-in, as before). A tag whose prefix the Site Codebook does not know is held and never auto-applied (BR-13). With no column mapped, an automatic apply waits until a person has applied or dismissed in that library once (`reviewedAt`). No confidence score gates anything.

**Done-when.**
1. ✓ Chips are selectable and Apply sends the selected tags (`lib/__tests__/equipmentBridgeRoutes.test.ts` "apply with tags applies only those; dismiss writes the dismissal").
2. ✓ A per-tag reject writes the dismissal (and status `'dismissed'` when every tag is dismissed) and keeps the rejected tags out of future recomputes. Tests in `lib/__tests__/equipmentBridge.test.ts`: "dismissing an applied tag removes its drawing relation, records the decision, and keeps it out of every later apply", "status 'dismissed' is written when every proposed tag is dismissed", and "a tag still read stays dismissed; …" / "brought back by a LATER revision → re-proposed; …".
3. ✓ Auto-apply is off by default. It never applies a held (unknown-prefix) tag. Without a mapped column it waits for the library's first review ("auto-apply with no column waits for a person's first review (reviewed once), then acts"). The scope is the codebook's vocabulary, not a confidence number (GAP-303's do-not).

**Scope / residual.** With a mapped column, an opted-in auto-apply acts before any review, as it always did; turning it on is the review decision. Before 20261171 a dismissal is not remembered across a recompute, and the route says so.

**Fix pass 2 (2026-10-02, review).** Done-when 1–2 did not hold on the documents where they matter most. On a fully-applied document (status 'applied', nothing fresh; every document after "Apply all"), the modal rendered only the green "applied" label, so a picked chip offered no button:
- a misread machine link could not be dismissed;
- a dismissed chip's "pick it and apply to take it back" had no Apply;
- the registry drawer's Unlink message (a drawing link "is removed by dismissing the tag in that library's Equipment sweep") pointed at an action that was not there.

The first resolution's evidence for done-when 1 was a route test, not a render of chip selection.

Now `components/documents/EquipmentSweepModal.tsx` renders "Apply N picked" and "Dismiss N" whenever chips are picked, whatever the document's status, with the "applied" label beside them. Failed documents, and an apply's or a correction's `auditError`, stay on screen after the re-read (the refresh cleared the error line first). Test: `lib/__tests__/equipmentSweepModalRender.test.ts` (jsdom) "picking an applied chip offers Dismiss beside the 'applied' label, and Dismiss posts action 'dismiss' with that tag", "picking a dismissed chip offers Apply ('pick it and apply to take it back'), which posts the tag", "an apply or a dismissal whose audit row was refused stays on screen after the re-read". All fail on the fix-pass-1 modal.

Done-when evidence (corrected): 1 ✓ the render cases above (chip selection; Apply sends the picked `tags`), with the route test as the server half. 2 ✓ the render case above (Dismiss posts the picked tags), with the lib tests as listed.

---

<a id="br-10"></a>

## BR-10 · Sheet numbers are never captured on the equipment side — BridgeSuggestion.pages is a PDF page index, and the parsed drawing sheet segment is never joined to a tag

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:28-34`, `lib/equipmentBridgeServer.ts:64-78`, `lib/equipmentBridgeServer.ts:214`, `supabase/migrations/20260921_drawing_entities.sql:25-30`, `lib/codebook.ts:251-257`, `lib/knowledgeIngest.ts:281-293`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The technical claim is true, but 'has no data to answer from' is false. knowledge_page_entities rows carry (document_id, page), and lib/drawingText.ts:559-582 `equipmentRegisterCsv` already emits a `["Tag", "Category", "Occurrences", "Sheets", "First page"]` register keyed by documentName — reachable in the product via lib/knowledge.ts:983 `action=export` and :769 `action=census`, and the ask route's show-me guarantee (app/api/knowledge/ask/route.ts:1665-1680) mints per-sheet citations from the same table. On a one-sheet-per-document library the document IS the sheet, so the owner's question is answered; the 'self' rows also make the sheet number recoverable per page by a join nobody has written yet. Real gap, but a missing enrichment rather than missing data.

**Mechanism.** `BridgeSuggestion.pages: number[] // sheets/pages the tag appears on` (line 30) is populated straight from `knowledge_page_entities.page`, which is the page index within the knowledge PDF (`page INTEGER NOT NULL`, 20260921_drawing_entities.sql:25; written as `page: p` at knowledgeIngest.ts:250). The plant's actual sheet number lives in two other places that are never joined to it: `parseDrawingNumber` extracts a `sheet` segment into `ParsedDrawingNumber.sheet` (lib/codebook.ts:251-257), and ingestion writes the title-block declaration as a kind='self' entity `${tb.drawingNumber}-SH${tb.sheetNumber}` (knowledgeIngest.ts:291-292). computeForKnowledgeDoc calls parseDrawingNumber only for `parsed?.unitCode` (line 98) and discards `parsed.sheet`; it filters entities to `.eq("kind", "equipment")` (line 68) so it never sees the 'self' rows.

**Failure scenario.** The owner's question 6 — 'when P&IDs arrive from anywhere, the system should show which equipment is on which sheet' — has no data to answer from. A single-sheet-per-document library stores pages:[1] for every tag, which carries zero information. A multi-sheet PDF stores the PDF page ordinal, which matches the sheet number only by luck. The value surfaces in exactly one place, a chip tooltip in the sweep modal (`page${s.pages.length===1?"":"s"} ${s.pages.join(", ")}`, EquipmentSweepModal.tsx:240), and is thrown away everywhere else: the asset row's `discovered_from.pages` (line 214) is never read by any UI (see finding 4), and the unit-backfill path for MATCHED assets records no sheet provenance at all.

**Evidence.**

```
lib/equipmentBridgeServer.ts:30 — `pages: number[];          // sheets/pages the tag appears on` — the comment conflates the two. lib/equipmentBridgeServer.ts:96-99 — `const parsed = parseDrawingNumber(cand, book); if (parsed?.unitCode) { unitCode = parsed.unitCode; break; }` — `parsed.sheet` and `parsed.drawingTypeCode` are dropped. lib/knowledgeIngest.ts:292 — `if (tb.sheetNumber) self(\`${tb.drawingNumber}-SH${tb.sheetNumber}\`);`
```

> **Verifier correction.** Downgraded HIGH→MEDIUM. This is a missing capability rather than wrong data: in the common one-drawing-per-PDF case the pair (source document, page) does identify the sheet, and the controlled document's own number carries the sheet segment. The gap bites on multi-sheet PDF sets, where the chip tooltip's `page${...} ${s.pages.join(", ")}` (EquipmentSweepModal.tsx:240) shows a PDF ordinal while calling it a sheet. It is the direct blocker for owner question 6, which is why it is worth keeping, not because it corrupts anything.

**Done when.**

- [ ] each suggestion carries the sheet identity (title-block sheet number, or the codebook-parsed sheet segment, falling back to the PDF page with that fact stated)
- [ ] an asset page can list 'appears on: 2002-D-10001 SHT.4, SHT.7' for every drawing it was found on, not just the one that discovered it
- [ ] matched (not only newly discovered) assets accumulate per-sheet provenance on each apply
- [ ] the tooltip and the stored field agree on whether a number is a sheet or a page

**Resolution (2026-10-02, intelligence Round G).** Every suggestion carries `sheets[]`, one per PDF page the tag was read on. Each sheet is the page's own title block, read from its kind `'self'` entities (`sheetAddressForPage`): the drawing number, the sheet, the revision it declares, and the label `"2002-D-10001 SHT 4"`. When a page declared none, it falls back to the page, with that fact stated ("page 7 (no title block read)"). A title block on a page an AI model transcribed is marked "(AI-read, unconfirmed)" (GOV-9). `pages` keeps its meaning (PDF page numbers), documented as not sheet numbers.

Every applied tag, matched or discovered, gets a relation row with `sheet_label` ("2002-D-10001 SHT 4, SHT 7") and `pages`, refreshed on each recompute. The asset hub lists them. `/api/equipment/sheets` also lists the sheets a tag was read on but not yet linked.

**Done-when.**
1. ✓ Each suggestion carries the sheet identity: the title-block sheet, falling back to the PDF page with that fact stated. `lib/__tests__/equipmentBridge.test.ts` "GAP-301 end to end: kind 'self' rows → each suggestion carries its sheets; an AI-transcribed page is marked".
2. ✓ The asset page lists "2002-D-10001 SHT 4" (and SHT 7, …) for every drawing the relation links, not just the one that discovered it (`lib/__tests__/assetHubRelation.test.ts`).
3. ✓ Matched assets get a relation row with the sheet on apply, refreshed on every recompute ("the stored sheet_label names every sheet once, in page order").
4. ✓ The tooltip and the stored field agree. The chip's title (`chipTitle`) names the sheet address, or "page N (no title block read)", never a page number called a sheet. The relation stores sheets in `sheet_label` and PDF pages in `pages`.

**Scope / residual.** **Pending migrations:** `supabase/migrations/20261170_intel_roundG_document_assets_source.sql`, then `supabase/migrations/20261171_intel_roundG_provenance.sql` (hand-applied, in that order). The app deploys in either order: before 20261170 the Bridge says the relation was not recorded and keeps its column write; before 20261171 it writes the relation without the provenance columns and says so.

**Fix pass 3 (2026-10-02, review).** The residual's clause "before 20261171 it writes the relation without the provenance columns and says so" has been false since fix pass 2. Before 20261171 the Bridge writes NO 'drawing' row: `notRecorded` names 20261171, the column write still lands, and the first recompute after the paste relates the applied tags with their provenance (`GAP-304`'s fix pass 2).

**Scope / residual (corrected).** Pending migrations: `20261170`, then `20261171`, in that order. The app deploys in either order. Before either is pasted, the suggestions still carry their sheets. No relation row (and so no `sheet_label` / `pages`) is written, and the Bridge says why.

---

<a id="br-11"></a>

## BR-11 · Sweep has no cursor and no budget: a sequential loop over up to 2000 documents' twins inside a 60-second function

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/equipment-bridge/route.ts:23-24`, `app/api/equipment-bridge/route.ts:107-126`, `lib/equipmentBridgeServer.ts:50-135`, `components/documents/EquipmentSweepModal.tsx:92-104`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: nothing persists a resume point, and `computed` is only returned on the success path, so a killed invocation reports nothing about how far it got. Re-sweep re-enters at document zero.

**Mechanism.** `export const maxDuration = 60;` (route.ts:24). action="sweep" selects up to 2000 documents (`.limit(2000)`, line 114) then awaits `computeForKnowledgeDoc` once per twin, strictly sequentially (lines 121-123). Each call does at minimum: one knowledge_documents read, one knowledge_page_entities read (limit 4000), a codebook load, a documents read, a libraries read, ceil(n/100) asset lookups, and an upsert — six-plus round trips, more when auto-apply fires and runs the whole apply path inline. There is no offset/cursor parameter, no deadline check, and no partial-progress return: the response shape is `{ ok: true, computed }` only. The client just awaits it (EquipmentSweepModal.tsx:96-101).

**Failure scenario.** A real P&ID library of several hundred sheets is swept. The function is killed at 60 seconds; the client's fetch fails and setError shows a bare timeout/HTTP status. Some documents were computed and some were not, with no record of where it stopped. Re-pressing 'Re-sweep' restarts from document zero and redoes all the completed work before reaching the tail, so libraries past a certain size can never complete a sweep — the exact backlog case the module header advertises ('runs on ingest completion + on demand for backlogs', equipmentBridgeServer.ts:5).

**Evidence.**

```
app/api/equipment-bridge/route.ts:121-123 — `for (const t of (twins ?? []) as Array<{ id: string }>) { try { await computeForKnowledgeDoc(supabaseAdmin, t.id); computed++; } catch { /* per-doc failures never sink the sweep */ } }`. lib/equipmentBridgeServer.ts:105-112 — the per-batch asset lookup loop inside each call.
```

> **Verifier correction.** Worth stating explicitly why the missing cursor is the real defect rather than the timeout: each computeForKnowledgeDoc persists its own row as it goes, so work already done IS durable — but because the sweep always restarts from the same unordered `.limit(2000)` prefix, re-running it recomputes the same head and never reaches the tail. A library big enough to blow 60s can therefore never be fully swept, which is a stronger statement than 'the request times out'.

**Done when.**

- [ ] sweep accepts a cursor/offset and returns progress plus a next cursor, or runs on the maintenance cron drain
- [ ] a wall-clock deadline check stops cleanly and reports how far it got
- [ ] the modal shows sweep progress and can resume
- [ ] a library of 500+ documents can be fully swept

**Resolution (2026-10-02, intelligence Round G).** `POST action "sweep"` takes an optional `cursor` and reads one page of the library's documents (`SWEEP_PAGE` = 150, keyset on `id`). It computes them one by one under a wall-clock budget (`SWEEP_BUDGET_MS` = 40 s, under the 60 s function limit) and stops cleanly at the budget. It returns `counts` by reason (computed, no_entities, upload_origin, no_twin, twin_not_ready, twin_stale, not_found, failed, unreadable), `nextCursor` (the last document done) and `done`. The modal loops the calls, shows progress ("N documents swept…") and resumes from the cursor it holds after an error or a stop. Every computed document's row is durable as it goes.

**Done-when.**
1. ✓ The sweep accepts a cursor and returns progress and a next cursor.
2. ✓ A wall-clock deadline stops cleanly and says how far it got (`lib/__tests__/equipmentBridgeRoutes.test.ts` "a call that reaches its wall-clock budget stops cleanly, says how far it got, and the next call resumes from there").
3. ✓ The modal shows sweep progress and can resume.
4. ✓ A library of 520 documents is fully swept, each document computed exactly once ("520 documents: each call takes one page and returns the next cursor; every document is computed exactly once").

**Fix pass (2026-10-02, review).** "Done" was decided from a short page (`page.ids.length < SWEEP_PAGE`), and GET stopped paging on a batch under 1000. PostgREST cuts a response at `db-max-rows` without an error, so on a project whose max-rows is below the page size a cut page read as the end and the rest of the library was never swept while the modal said "Swept." Now the sweep is done only on an EMPTY page (a short page hands back its last id and the next call finds out), and GET pages until an empty batch; the entity windows (`readWindows`) start each window where the rows read so far end, so a cut window skips nothing either. Test: `lib/__tests__/equipmentBridgeRoutes.test.ts` "a project whose PostgREST max-rows is below the page size: a cut page is not the end — the whole library is swept, and GET lists it whole" (fails on the pre-fix route); the 520-document and budget tests now count the closing empty page.

**Scope / residual.** The cursor lives in the modal. A closed modal starts again at the head; a re-run recomputes idempotently.

**Fix pass 2 (2026-10-02, review).** "GET lists it whole" held for the document list only. GET read each 100-document slice's 'drawing' relation rows in one request. That is GAP-309's only review source, and PostgREST's max-rows cut it without an error (100 applied P&IDs at about 30 tags each is about 3,000 rows). The same unpaged per-document read sat in `markRevisionTruth`, `removeDrawingRelations` and `reviewVanished`. Past 1,000 applied tags a Dismiss saved the dismissal but reported `relationsRemoved: 0` and left the link. Now:
- GET pages each slice's relation rows by keyset (`drawingRelations`: order by id, `gt` the last id, until an EMPTY page; org-scoped).
- `markRevisionTruth` pages the document's drawing rows the same way (`pageById`).
- `removeDrawingRelations` and `reviewVanished` no longer read every drawing row of the document. `readDrawingRowsForTags` resolves the tags to their registry assets (`tag_normalized`) and filters `.in("asset_id", …)` at the database, plus `.in("tag_text", …)` for a row whose asset was renamed since. Each read is bounded by the pairs it names.
- Tests: `lib/__tests__/equipmentBridgeRoutes.test.ts` "GET's relation rows (the GAP-309 review source) are paged too: a cut response is not the whole list (fix pass 2)" (150 rows under max-rows 100); `lib/__tests__/equipmentBridge.test.ts` "major 2 (fix pass 2) — the relation's per-document reads are never cut at PostgREST's max-rows" (Dismiss, "It left the sheet" and revision truth on a 12-row drawing under max-rows 5). Each fails on the fix-pass-1 files.

---

<a id="br-12"></a>

## BR-12 · Text-rich P&IDs are excluded from equipment extraction by a 2000-character page gate, so the Bridge sees nothing on them

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/drawingText.ts:19-25`, `lib/knowledgeIngest.ts:231-262`, `lib/equipmentBridgeServer.ts:64-83`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Vision does not rescue these pages: lib/drawingText.ts:609-635 `pageNeedsVision` returns false for any page over TEXTLESS_PAGE_MAX_CHARS (60) that is not 'thin' — `const thin = text.length <= THIN_PAGE_MAX_CHARS (1200); if (tagsFound >= (thin ? MIN_TAGS_THIN_PAGE : 1)) return false; if (!thin) return false;` — so a >2000-char sheet never gets the visionRead branch at knowledgeIngest.ts:214 either. The empty result is indistinguishable in the sweep modal from a genuinely tagless sheet ('0 tags'). Confirmed.

**Mechanism.** `SPARSE_PAGE_MAX_CHARS = 2000` and `isDrawingLikePage(pageText)` returns true only when `pageText.length <= SPARSE_PAGE_MAX_CHARS` (drawingText.ts:19-25). Ingestion runs positional equipment extraction only inside `else if (isDrawingLikePage(pageText))` (knowledgeIngest.ts:231); the vision branch above it applies only when the page had no usable text layer at all. A P&ID exported with a full TrueType text layer that includes a notes block, a legend, a valve schedule or a bill of materials will exceed 2,000 characters and produce zero kind='equipment' rows. computeForKnowledgeDoc then finds `byTag.size === 0`, writes an empty suggestion row (line 81), and the sweep modal shows the sheet with '0 tags'.

**Failure scenario.** A vendor delivers a P&ID package with rich text layers. Ingest reports the documents 'ready', the equipment census shows a handful of tags from the sparse sheets only, and the Bridge reports the dense sheets as swept-and-empty — indistinguishable in the sweep modal from a genuinely tagless sheet. Nothing tells the operator that the threshold, not the drawing, is why. The failure is worst on exactly the drawings that carry the most information.

**Evidence.**

```
lib/drawingText.ts:23-25 — `export function isDrawingLikePage(pageText: string): boolean { return pageText.trim().length > 0 && pageText.length <= SPARSE_PAGE_MAX_CHARS; }`. lib/knowledgeIngest.ts:231 — `} else if (isDrawingLikePage(pageText)) {`. lib/equipmentBridgeServer.ts:79-83 — `if (byTag.size === 0) { await upsertSuggestions(admin, orgId, documentId, [], null); return { documentId, suggestions: [], autoApplied: false }; }`
```

> **Verifier correction.** One mitigation exists and should be named: the library-level `forceAllPages` option (knowledgeIngest.ts:153, set from the library's ai_features per app/api/knowledge/ingest/route.ts:76-78) sends every page to vision, and the visionRead branch (lines 213-231) extracts from the transcript with no length gate. That requires opt-in, an AI key, and page budget, so it does not refute the default-path gap — but it means the fix may be configuration rather than code for some orgs.

**Done when.**

- [ ] a page classified as a drawing by any signal (title block found, doc_class='drawing', low text-to-area ratio) gets equipment extraction regardless of character count
- [ ] or the threshold is raised/made per-library and the sweep distinguishes 'no tags found' from 'page skipped as prose'
- [ ] a dense-but-drawing test fixture produces equipment entities

**Resolution (2026-10-01, intelligence Round G, I-07).** Same change as DWG-7. Reproduced first (DEC-29): through the real ingest, a real 2,683-character TrueType P&ID page wrote zero `kind = 'equipment'` rows, so `computeForKnowledgeDoc` had nothing to bridge. What landed:

- **Signals, not a ceiling.** `isDrawingLikePage` (`lib/drawingText.ts`) classifies a page over the 2,000-character fast path as a drawing by signals. The page must be lettered in capitals, and then either a tag list (4 or more tags or references per 1,000 characters) or a page whose own title block declares a drawing number.
- **No ingest change needed.** Ingest calls it before extraction, so a dense drawing sheet now gets positional equipment extraction and a title-block identity, which the Bridge reads, without a change to `lib/knowledgeIngest.ts`.
- **The lens tells skipped from tagless.** The drawing lens marks a text sheet with no tags as "Drawing, no tags" or "Prose" (`looksLike`).

Tests:
- `lib/__tests__/intelRoundGDrawing.test.ts` "yields equipment tags and a title-block identity past 2,000 characters — and no phantom pumps from line numbers" (real ingest, real PDF; fails at base);
- `lib/__tests__/drawingText.test.ts` "DWG-7 / BR-12" (signals; prose stays prose; a notes sheet with a title block is a drawing).

**Done-when.**
- ✓ A page classified as a drawing by any of its signals (a title block found, tag density, capital lettering) gets equipment extraction regardless of character count. `doc_class` is not a per-page signal the extractor can see. Text-to-area ratio needs the page geometry, which the decision does not use.
- ✓ The "or" alternative is not needed with the first criterion met. The drawing lens does tell a drawing with no tags apart from prose (DWG-7). The Bridge's sweep modal is I-11's (`lib/equipmentBridgeServer.ts`).
- ✓ A dense-but-drawing test fixture produces equipment entities, through the real ingest.

**Scope / residual.** Dense sheets indexed before this gain their equipment at their next re-index, and the Bridge sees them from then. Decision: `DEC-68` item 1.

---

<a id="br-13"></a>

## BR-13 · The Bridge's tag gate is looser than the extractor's — splitTag admits any LETTERS-DIGITS token, and the extractor's stop list is not re-applied at the registry boundary

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:71-78`, `lib/codebook.ts:124-128`, `lib/drawingText.ts:62-86`, `lib/equipmentBridgeServer.ts:200-233`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The consequence (CL-150 / SS-316 / CW-6 minting origin='drawing' assets with null type) is real, but the stated cause is largely inert: every row in knowledge_page_entities with kind='equipment' is written only by lib/knowledgeIngest.ts:217 and :246, both via `extractEquipmentTags`, so nothing reaches the bridge that failed the stop list — re-applying it at the registry boundary would filter out exactly zero tags, and splitTag being looser cannot admit anything the extractor rejected. What remains is a duplicate of the extractor's permissive prefix policy plus BR-8's inability to see or bulk-clean discovered assets, so LOW as a standalone finding.

**Mechanism.** The only quality gate between an extracted entity and a created registry asset is `if (!splitTag(norm)) continue; // only things shaped like real tags cross the bridge` (equipmentBridgeServer.ts:74), where splitTag matches `/^([A-Z]{1,4})-(\d{1,6})([A-Z]{0,2})$/` (codebook.ts:125) — pure shape, no vocabulary. The extraction side does carry a curated stop list, `EQUIPMENT_STOP_PREFIXES = {NO, DWG, REV, PID, DRW, SHT, SH, PG, ISO, API, ANSI, NPS}` plus the drawing-number-middle guard (drawingText.ts:65-67, 81), but the Bridge does not consult it or the codebook's known prefixes. Anything shaped like a tag that survives extraction — a flange class, a pipe spec, a line size, a vision-model transcription artifact — becomes a permanent asset row, because createAssets defaults ON (line 200) and there is no reject path (finding 14).

**Failure scenario.** Notes and legends on a P&ID contain tokens like CL-150, SS-316, CS-150, HP-2, or a vision transcript renders a line label as CW-6. None are in EQUIPMENT_STOP_PREFIXES, all pass splitTag, and all mint assets with origin='drawing'. Because typeForTag returns null for unknown prefixes, they file with type_id NULL and land in 'Uncategorized' (admin/assets/page.tsx:189) alongside genuinely unknown real equipment, so the signal that would flag them is lost in the same bucket as the legitimate teach-the-codebook backlog.

**Evidence.**

```
lib/equipmentBridgeServer.ts:74 — `if (!splitTag(norm)) continue; // only things shaped like real tags cross the bridge`. lib/codebook.ts:125 — `const m = normalizeTag(tag).match(/^([A-Z]{1,4})-(\d{1,6})([A-Z]{0,2})$/);`. lib/drawingText.ts:65-67 — the stop list the Bridge never reads.
```

> **Verifier correction.** The stated mechanism is half wrong and should be rewritten. The stop list IS applied before the row ever exists — both ingestion branches call extractEquipmentTags (knowledgeIngest.ts:214 for vision transcripts, :248 for the positional path), and that function drops stop-listed prefixes at drawingText.ts:74. Since knowledge_page_entities kind='equipment' is the Bridge's only input, 'the stop list is not re-applied at the registry boundary' is redundant, not a leak; likewise splitTag's wider 1-4 letters / 1-6 digits versus the extractor's 1-3 / 1-5 admits nothing that can actually arrive. The real defect is narrower and still worth fixing: NEITHER gate consults the Site Codebook's known tag prefixes before minting a permanent asset, so any non-stop-listed LETTERS-DIGITS token becomes registry equipment. Verification of that code path is CONFIRMED; the specific false-positive examples (flange classes, pipe specs, vision transcription artifacts) are SUSPECTED — no model was run and no fixture was read.

**Done when.**

- [ ] the Bridge applies EQUIPMENT_STOP_PREFIXES (or a shared vocabulary module) before creating assets
- [ ] optionally, discovery is restricted to prefixes the Site Codebook knows, with unknown-prefix tags held for review rather than created
- [ ] a tag whose prefix is neither known nor plausible surfaces as 'teach the codebook' instead of becoming a row

**Resolution (2026-10-02, intelligence Round G).** Two gates at the registry boundary:
- **The extractor's own vocabulary.** `passesExtractorGate` round-trips each tag through `lib/drawingText.ts` `extractEquipmentTags`, the shared module, so its stop list, drawing-number-middle guard and line-number grammar apply to everything that crosses. A tag it would not extract from its own text never crosses.
- **The codebook's prefixes.** Once any Site Codebook equipment type declares tag prefixes, a NEW tag that no type claims is held (`held: "unknown_prefix"`). Apply all and auto-apply skip it and nothing is minted. A person can still name it to create it.

The modal shows held chips in amber with "teach the codebook", and counts them ("N held — the Site Codebook knows no type for the prefix (teach it, or pick the tag to create it)"). An empty codebook has no opinion (today's behaviour: the tag is created untyped).

**Done-when.**
1. ✓ The Bridge applies the extractor's vocabulary, the stop list included, through the shared module before creating assets (`lib/__tests__/equipmentBridge.test.ts` "re-applies the extractor's stop list and drawing-number guard").
2. ✓ Discovery is restricted to prefixes the Site Codebook knows; unknown-prefix tags are held for review ("holds a NEW tag whose prefix no equipment type claims — once the codebook knows prefixes at all"; "held on the proposal; Apply all skips it; naming it creates it").
3. ✓ A tag whose prefix is not known surfaces as "teach the codebook", not as a row.

**Scope / residual.** An org whose codebook declares no prefixes keeps today's behaviour, which DEC-53 item 2 leaves to the site.

---

<a id="br-14"></a>

## BR-14 · Two knowledge twins of one controlled document overwrite each other's suggestions — last writer wins on a single-row-per-document table

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:137-155`, `supabase/migrations/20260928_site_codebook.sql:95-107`, `supabase/migrations/20260919_knowledge_mirror_unique.sql:11-13`, `app/api/equipment-bridge/route.ts:117-124`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed end to end: two twins of one document exist legitimately, the sweep iterates them in unordered query order, and each overwrites the single (org_id, document_id) suggestion row. upsertSuggestions preserves only `applied` (line 145), so the 3-tag twin computing last both replaces the 40-tag proposal and flips status to 'applied' when newTags is empty (line 152).

**Mechanism.** `document_equipment_suggestions` is keyed `PRIMARY KEY (org_id, document_id)` (20260928_site_codebook.sql:107) and upsertSuggestions replaces `suggested` wholesale with `onConflict: "org_id,document_id"` (equipmentBridgeServer.ts:147-154). But the mirror uniqueness index is per LIBRARY — `CREATE UNIQUE INDEX ... ON knowledge_documents (library_id, source_document_id)` (20260919:11-13) — so one controlled P&ID mirrored into two knowledge libraries (e.g. an org-wide shelf and a crude-unit area shelf, exactly the pattern AreaKnowledgePanel encourages) has two twins with the same source_document_id. The sweep loops over every twin (`for (const t of (twins ?? []))`, route.ts:121-123) and each computeForKnowledgeDoc call overwrites the same row.

**Failure scenario.** A P&ID is in both the org shelf (fully indexed, 40 equipment entities) and the crude-unit shelf (still indexing, 3 entities). The sweep computes both in arbitrary order. If the partially-indexed twin computes last, the suggestion row is replaced with 3 tags and — because `applied` is preserved and newTags is then empty — status flips to 'applied', so the sweep modal reports the sheet as done and the other 37 tags are never offered. Re-sweeping does not necessarily fix it; it re-runs the same race.

**Evidence.**

```
supabase/migrations/20260928_site_codebook.sql:107 — `PRIMARY KEY (org_id, document_id)`. lib/equipmentBridgeServer.ts:147-154 — `.upsert({ org_id, document_id, suggested: suggestions.map(...), applied, status: ..., computed_at: ... }, { onConflict: "org_id,document_id" })`. app/api/equipment-bridge/route.ts:121-122 — `for (const t of (twins ?? []) as Array<{ id: string }>) { try { await computeForKnowledgeDoc(supabaseAdmin, t.id); computed++; }`
```

> **Verifier correction.** Narrow the blast radius: upsertSuggestions (lines 142-154) explicitly re-reads and preserves `applied`, so the applied/idempotence history is NOT lost — only `suggested` is replaced wholesale. The concrete harm is therefore a second twin that is unindexed or partially indexed hitting the `byTag.size === 0` branch (line 79-83) and blanking a good twin's suggestions to `[]`, or two differently-indexed twins flapping. Order within the sweep is unspecified, so which twin wins is nondeterministic.

**Done when.**

- [ ] suggestions from multiple twins of one controlled document are merged (union of tags, union of pages) rather than overwritten
- [ ] the row records which knowledge_document(s) produced it
- [ ] a twin that is still indexing cannot downgrade a complete computation to 'applied'

**Resolution (2026-10-02, intelligence Round G).** `computeForDocument` gathers EVERY knowledge copy of the controlled document. It merges the tags and pages of each copy that is ready and at the document's current revision (union). A copy still indexing, or one left at an earlier revision (GAP-309), is recorded but not used. With no usable copy, the stored proposal is left exactly as it was: no recompute downgrades a complete computation. The row records which copies produced it (`document_equipment_suggestions.sources`: id, status, version, revision, used, and why not; 20261171). The sweep computes per controlled document, never per copy, so two copies no longer race on one row.

**Done-when.**
1. ✓ Suggestions from several copies are merged (union of tags, union of pages) (`lib/__tests__/equipmentBridge.test.ts` "reproduction → fix: the indexing copy's 1 tag never replaces the ready copy's 3; once ready, the tags are UNIONED").
2. ✓ The row records which knowledge documents produced it (`sources`).
3. ✓ A copy still indexing cannot downgrade a complete computation ("with only a copy still indexing, the stored proposal is left exactly as it was").

**Scope / residual.** Before 20261171 the ledger has no `sources` column. The merge still happens; which copies produced the row is not recorded (the write retries without it).

---
